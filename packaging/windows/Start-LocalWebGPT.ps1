[CmdletBinding()]
param(
  [switch]$ValidateOnly
)

$ErrorActionPreference = 'Stop'

if (-not $IsWindows) {
  throw 'LocalWebGPT Secure MCP Tunnel startup is supported on Windows only.'
}
$null = Get-Command node -ErrorAction Stop
$null = Get-Command npm -ErrorAction Stop

$runtimeRoot = $null
if (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'package.json') -PathType Leaf) {
  # Installed runtime: the launcher is copied to the runtime root.
  $runtimeRoot = (Resolve-Path -LiteralPath $PSScriptRoot).Path
} else {
  # Source checkout: the script lives under packaging/windows.
  $sourceRoot = Join-Path $PSScriptRoot '..\..'
  if (Test-Path -LiteralPath (Join-Path $sourceRoot 'package.json') -PathType Leaf) {
    $runtimeRoot = (Resolve-Path -LiteralPath $sourceRoot).Path
  }
}
if ($null -eq $runtimeRoot) {
  throw 'Cannot locate a LocalWebGPT package.json next to this launcher.'
}

$dotenvPath = Join-Path $runtimeRoot '.env'
$dotenvValues = @{}
$tunnelId = ''
$apiKey = ''
$previousTunnelId = $env:CONTROL_PLANE_TUNNEL_ID
$previousApiKey = $env:CONTROL_PLANE_API_KEY
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

  if ($ValidateOnly) {
    Write-Host 'Project-root .env is valid; credential values were not displayed.'
    return
  }

  Push-Location $runtimeRoot
  $locationPushed = $true
  $env:CONTROL_PLANE_TUNNEL_ID = $tunnelId
  $env:CONTROL_PLANE_API_KEY = $apiKey

  # The Node launcher starts the daemon, prints a one-time local console URL,
  # and waits for the operator's audited connection-enable action before it
  # runs doctor or starts tunnel-client.
  npm run chatgpt:local
  $exitCode = $LASTEXITCODE
} finally {
  $env:CONTROL_PLANE_TUNNEL_ID = $previousTunnelId
  $env:CONTROL_PLANE_API_KEY = $previousApiKey
  $tunnelId = ''
  $apiKey = ''
  $rawLine = ''
  $line = ''
  $assignment = $null
  $rawValue = ''
  $value = ''
  $dotenvValues.Clear()
  if ($locationPushed) { Pop-Location }
}

exit $exitCode
