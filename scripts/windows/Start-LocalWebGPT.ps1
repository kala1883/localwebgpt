[CmdletBinding()]
param(
  [switch]$ValidateOnly
)

$ErrorActionPreference = 'Stop'

if (-not $IsWindows) {
  throw 'LocalWebGPT Secure MCP Tunnel startup is supported on Windows only.'
}
$null = Get-Command node -ErrorAction Stop

# Check before loading credentials or invoking the console's build tools.
$nodeVersionText = (& node --version 2>&1 | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or $nodeVersionText -notmatch '^v(?<version>\d+\.\d+\.\d+)$') {
  throw 'Node.js did not return a valid version. Install Node.js 22.12.0 or newer and reopen your terminal.'
}
if ([version]$Matches['version'] -lt [version]'22.12.0') {
  throw "Node.js 22.12.0 or newer is required; found $nodeVersionText. Switch to a supported version (nvm users: nvm use 22.20.0), then run the launcher again."
}

$runtimeRoot = $null
if (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'package.json') -PathType Leaf) {
  # Installed runtime: the launcher is copied to the runtime root.
  $runtimeRoot = (Resolve-Path -LiteralPath $PSScriptRoot).Path
} else {
  # Source checkout: the script lives under scripts/windows.
  $sourceRoot = Join-Path $PSScriptRoot '..\..'
  if (Test-Path -LiteralPath (Join-Path $sourceRoot 'package.json') -PathType Leaf) {
    $runtimeRoot = (Resolve-Path -LiteralPath $sourceRoot).Path
  }
}
if ($null -eq $runtimeRoot) {
  throw 'Cannot locate a LocalWebGPT package.json next to this launcher.'
}
$runtimeMarker = Join-Path $runtimeRoot '.lwb-runtime-package'
$isPackagedRuntime = Test-Path -LiteralPath $runtimeMarker -PathType Leaf
$buildId = 'source-checkout'
if ($isPackagedRuntime) {
  $consoleIndex = Join-Path $runtimeRoot 'apps\console\dist\index.html'
  if (-not (Test-Path -LiteralPath $consoleIndex -PathType Leaf)) {
    throw 'The packaged Console build is missing; rebuild the runtime before starting it.'
  }
  $buildInfoPath = Join-Path $runtimeRoot '.lwb-build-info.json'
  if (-not (Test-Path -LiteralPath $buildInfoPath -PathType Leaf)) {
    throw 'The packaged build identity is missing; rebuild the runtime before starting it.'
  }
  try {
    $buildInfo = Get-Content -LiteralPath $buildInfoPath -Raw -Encoding UTF8 | ConvertFrom-Json -ErrorAction Stop
  } catch {
    throw 'The packaged build identity is invalid; rebuild the runtime before starting it.'
  }
  $manifestFingerprint = [string]$buildInfo.source_manifest_sha256
  if ($buildInfo.schema_version -ne 1 -or
      $manifestFingerprint -notmatch '^[0-9a-f]{64}$' -or
      [string]$buildInfo.build_id -cne "sha256:$manifestFingerprint") {
    throw 'The packaged build identity failed validation; rebuild the runtime before starting it.'
  }
  $buildId = [string]$buildInfo.build_id
} else {
  # Source checkouts rebuild the UI on each start; packaged runtimes already
  # contain the validated production bundle and intentionally omit Vite.
  $null = Get-Command npm -ErrorAction Stop
}

$dotenvPath = Join-Path $runtimeRoot '.env'
$dotenvValues = @{}
$tunnelId = ''
$apiKey = ''
$snapshotQuota = ''
$previousTunnelId = $env:CONTROL_PLANE_TUNNEL_ID
$previousApiKey = $env:CONTROL_PLANE_API_KEY
$previousSnapshotQuota = $env:LWB_SNAPSHOT_STORE_MAX_BYTES
$previousBuildId = $env:LWB_BUILD_ID
$exitCode = 1
$locationPushed = $false
try {
  if (-not (Test-Path -LiteralPath $dotenvPath -PathType Leaf)) {
    throw 'Project-root .env is missing. Define tunnel_id and runtime_API_key there; do not commit the file.'
  }

  $lineNumber = 0
  foreach ($rawLine in [System.IO.File]::ReadAllLines($dotenvPath, [System.Text.Encoding]::UTF8)) {
    $lineNumber += 1
    $line = $rawLine.Trim()
    if ($line.Length -eq 0 -or $line.StartsWith('#')) { continue }

    $assignment = [regex]::Match($line, '^(?<name>[A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?<value>.*)$')
    if (-not $assignment.Success) {
      throw "Invalid .env assignment at line $lineNumber; the value was not displayed."
    }

    $name = $assignment.Groups['name'].Value.ToLowerInvariant()
    $targetName = switch ($name) {
      'tunnel_id' { 'CONTROL_PLANE_TUNNEL_ID'; break }
      'control_plane_tunnel_id' { 'CONTROL_PLANE_TUNNEL_ID'; break }
      'runtime_api_key' { 'CONTROL_PLANE_API_KEY'; break }
      'control_plane_api_key' { 'CONTROL_PLANE_API_KEY'; break }
      'snapshot_store_max_bytes' { 'LWB_SNAPSHOT_STORE_MAX_BYTES'; break }
      'lwb_snapshot_store_max_bytes' { 'LWB_SNAPSHOT_STORE_MAX_BYTES'; break }
      default { $null }
    }
    if ($null -eq $targetName) { continue }
    if ($dotenvValues.ContainsKey($targetName)) {
      throw "Duplicate .env setting for $targetName; the values were not displayed."
    }

    $rawValue = $assignment.Groups['value'].Value.Trim()
    if ($rawValue.StartsWith('"') -or $rawValue.StartsWith("'")) {
      $quote = $rawValue.Substring(0, 1)
      $closingQuote = $rawValue.LastIndexOf($quote)
      if ($closingQuote -le 0) {
        throw "Unclosed quoted .env value at line $lineNumber; the value was not displayed."
      }
      $trailing = $rawValue.Substring($closingQuote + 1).Trim()
      if ($trailing.Length -gt 0 -and -not $trailing.StartsWith('#')) {
        throw "Unexpected text after quoted .env value at line $lineNumber; the value was not displayed."
      }
      $value = $rawValue.Substring(1, $closingQuote - 1)
    } else {
      $value = [regex]::Replace($rawValue, '[ \t]+#.*$', '').Trim()
    }

    $dotenvValues[$targetName] = $value
  }

  foreach ($requiredName in @('CONTROL_PLANE_TUNNEL_ID', 'CONTROL_PLANE_API_KEY')) {
    if (-not $dotenvValues.ContainsKey($requiredName) -or
        [string]::IsNullOrWhiteSpace([string]$dotenvValues[$requiredName])) {
      throw ".env must define tunnel_id and runtime_API_key (or their CONTROL_PLANE_* names); values are never printed."
    }
  }

  $tunnelId = ([string]$dotenvValues['CONTROL_PLANE_TUNNEL_ID']).Trim()
  $apiKey = ([string]$dotenvValues['CONTROL_PLANE_API_KEY']).Trim()
  if ($tunnelId -notmatch '^tunnel_[A-Za-z0-9_-]{8,}$') {
    throw '.env tunnel_id format is invalid; copy the tunnel_id from OpenAI Platform.'
  }
  if ($dotenvValues.ContainsKey('LWB_SNAPSHOT_STORE_MAX_BYTES')) {
    $snapshotQuota = ([string]$dotenvValues['LWB_SNAPSHOT_STORE_MAX_BYTES']).Trim()
    if ($snapshotQuota -notmatch '^[1-9][0-9]{0,9}$' -or [long]$snapshotQuota -gt 2147483648) {
      throw 'snapshot_store_max_bytes must be a positive decimal byte count no greater than the 2 GiB hard ceiling; the value was not displayed.'
    }
  }

  if ($ValidateOnly) {
    Write-Host 'Project-root .env is valid; credential values were not displayed.'
    return
  }

  Push-Location $runtimeRoot
  $locationPushed = $true
  $env:CONTROL_PLANE_TUNNEL_ID = $tunnelId
  $env:CONTROL_PLANE_API_KEY = $apiKey
  $env:LWB_BUILD_ID = $buildId
  if ($snapshotQuota.Length -gt 0) { $env:LWB_SNAPSHOT_STORE_MAX_BYTES = $snapshotQuota }

  # The Node launcher starts the daemon, prints a one-time local console URL,
  # and waits for the operator's audited connection-enable action before it
  # runs doctor or starts tunnel-client. Avoid npm lifecycle scripts in the
  # packaged runtime: its UI was built during packaging and devDependencies
  # (including Vite) were pruned afterwards.
  if ($isPackagedRuntime) {
    & node --import tsx apps/daemon/src/lifecycle/chatgpt-local.ts
  } else {
    npm run chatgpt:local
  }
  $exitCode = $LASTEXITCODE
} finally {
  $env:CONTROL_PLANE_TUNNEL_ID = $previousTunnelId
  $env:CONTROL_PLANE_API_KEY = $previousApiKey
  $env:LWB_SNAPSHOT_STORE_MAX_BYTES = $previousSnapshotQuota
  $env:LWB_BUILD_ID = $previousBuildId
  $tunnelId = ''
  $apiKey = ''
  $snapshotQuota = ''
  $buildId = ''
  $rawLine = ''
  $line = ''
  $assignment = $null
  $rawValue = ''
  $value = ''
  $dotenvValues.Clear()
  if ($locationPushed) { Pop-Location }
}

exit $exitCode
