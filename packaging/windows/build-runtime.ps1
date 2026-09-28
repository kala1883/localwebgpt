[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$OutputDirectory
)

$ErrorActionPreference = 'Stop'

if (-not $IsWindows) {
  throw 'Windows runtime package must be built on Windows.'
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path.TrimEnd('\')
$outputRoot = [System.IO.Path]::GetFullPath($OutputDirectory).TrimEnd('\')
$repoPrefix = $repoRoot + '\'
if ($outputRoot.Equals($repoRoot, [System.StringComparison]::OrdinalIgnoreCase) -or
    $outputRoot.StartsWith($repoPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw 'OutputDirectory must be outside the source repository; the build never writes into the checkout.'
}
if ($outputRoot.Equals([System.IO.Path]::GetPathRoot($outputRoot).TrimEnd('\'), [System.StringComparison]::OrdinalIgnoreCase)) {
  throw 'OutputDirectory cannot be a drive root.'
}
if (Test-Path -LiteralPath $outputRoot) {
  throw 'OutputDirectory already exists; choose a new empty path so an existing install cannot be overwritten.'
}

$nodeVersionText = (& node --version 2>&1 | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or $nodeVersionText -notmatch '^v(?<version>\d+\.\d+\.\d+)') {
  throw 'Node.js was not found or did not return a valid version.'
}
$nodeVersion = [version]$Matches['version']
if ($nodeVersion -lt [version]'22.12.0') {
  throw "Node.js 22.12.0 or newer is required; found $nodeVersionText."
}
$null = Get-Command npm -ErrorAction Stop
$sqliteBinary = Join-Path $repoRoot 'node_modules\better-sqlite3\prebuilds\win32-x64.node'
if (-not (Test-Path -LiteralPath $sqliteBinary -PathType Leaf)) {
  throw 'A locally installed and validated better-sqlite3 native binary is required; install the locked dependencies in the checkout first.'
}

$tunnelVersion = 'v0.0.15'
$tunnelArchiveName = "tunnel-client-$tunnelVersion-windows-amd64.zip"
$tunnelVersionRoot = Join-Path $repoRoot ".lwb-local\tunnel-client\$tunnelVersion"
$tunnelArchive = Join-Path $tunnelVersionRoot $tunnelArchiveName
$checksumsFile = Join-Path $tunnelVersionRoot 'SHA256SUMS.txt'
if (-not (Test-Path -LiteralPath $tunnelArchive -PathType Leaf) -or
    -not (Test-Path -LiteralPath $checksumsFile -PathType Leaf)) {
  throw "Verified tunnel-client archive or SHA256SUMS.txt is missing for $tunnelVersion."
}
$checksumMatches = @(Select-String -LiteralPath $checksumsFile -Pattern "^(?<hash>[0-9a-fA-F]{64})\s+$([regex]::Escape($tunnelArchiveName))$" )
if ($checksumMatches.Count -ne 1) {
  throw 'SHA256SUMS.txt must contain exactly one official checksum for the Windows amd64 archive.'
}
$expectedHash = $checksumMatches[0].Matches[0].Groups['hash'].Value.ToLowerInvariant()
$actualHash = (Get-FileHash -LiteralPath $tunnelArchive -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actualHash -ne $expectedHash) {
  throw 'The local tunnel-client archive does not match the official SHA-256 checksum.'
}

New-Item -ItemType Directory -Path $outputRoot | Out-Null

# Copy only the project/runtime trees and root manifests. In particular, never
# copy the checkout's .git, node_modules, local tunnel profile, or credentials.
foreach ($directory in @('apps', 'packages', 'native', 'scripts', 'tests')) {
  $source = Join-Path $repoRoot $directory
  if (-not (Test-Path -LiteralPath $source -PathType Container)) {
    throw "Required runtime tree is missing: $directory"
  }
  Copy-Item -LiteralPath $source -Destination $outputRoot -Recurse
}
foreach ($file in @('package.json', 'package-lock.json', 'tsconfig.json')) {
  Copy-Item -LiteralPath (Join-Path $repoRoot $file) -Destination $outputRoot
}

$docsRoot = Join-Path $outputRoot 'docs'
New-Item -ItemType Directory -Path $docsRoot -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $repoRoot 'docs\chatgpt-tunnel-acceptance.md') -Destination $docsRoot
Copy-Item -LiteralPath (Join-Path $repoRoot 'docs\install-and-upgrade.md') -Destination $docsRoot
Copy-Item -LiteralPath (Join-Path $repoRoot 'docs\operator-runbook.md') -Destination $docsRoot
New-Item -ItemType Directory -Path (Join-Path $docsRoot 'release') -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $repoRoot 'docs\release\V1-acceptance.md') -Destination (Join-Path $docsRoot 'release')
Copy-Item -LiteralPath (Join-Path $repoRoot 'packaging\windows\Start-LocalWebGPT.ps1') -Destination $outputRoot
Copy-Item -LiteralPath (Join-Path $repoRoot 'packaging\windows\Stop-LocalWebGPT.ps1') -Destination $outputRoot
Copy-Item -LiteralPath (Join-Path $repoRoot 'packaging\windows\Uninstall-LocalWebGPT.ps1') -Destination $outputRoot

$vendorVersionRoot = Join-Path $outputRoot ".lwb-local\tunnel-client\$tunnelVersion"
$vendorBin = Join-Path $vendorVersionRoot 'bin'
New-Item -ItemType Directory -Path $vendorBin -Force | Out-Null
Expand-Archive -LiteralPath $tunnelArchive -DestinationPath $vendorBin
Copy-Item -LiteralPath $checksumsFile -Destination $vendorVersionRoot

$requiredVendorFiles = @(
  'tunnel-client.exe',
  'cloudflared.exe',
  'LICENSE',
  'NOTICE',
  'tunnel-client-v0.0.15-windows-amd64-licenses.txt',
  'tunnel-client-v0.0.15-windows-amd64.spdx.json'
)
foreach ($file in $requiredVendorFiles) {
  if (-not (Test-Path -LiteralPath (Join-Path $vendorBin $file) -PathType Leaf)) {
    throw "Verified tunnel-client archive is missing required file: $file"
  }
}
$reportedTunnelVersion = (& (Join-Path $vendorBin 'tunnel-client.exe') --version 2>&1 | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or $reportedTunnelVersion -notmatch [regex]::Escape($tunnelVersion.TrimStart('v'))) {
  throw 'The tunnel-client executable did not report the expected pinned version.'
}

Push-Location $outputRoot
try {
  npm ci --ignore-scripts --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw 'npm ci failed in the output directory.' }

  # This host has no Visual Studio C++ workload. Reuse only the package's
  # already installed Windows x64 prebuild and require an exact hash match.
  $targetSqliteBinary = Join-Path $outputRoot 'node_modules\better-sqlite3\prebuilds\win32-x64.node'
  if (-not (Test-Path -LiteralPath $targetSqliteBinary -PathType Leaf)) {
    Copy-Item -LiteralPath $sqliteBinary -Destination $targetSqliteBinary
  }
  $sourceSqliteHash = (Get-FileHash -LiteralPath $sqliteBinary -Algorithm SHA256).Hash
  $targetSqliteHash = (Get-FileHash -LiteralPath $targetSqliteBinary -Algorithm SHA256).Hash
  if ($sourceSqliteHash -ne $targetSqliteHash) {
    throw 'The package Windows x64 SQLite prebuild does not match the validated checkout binary.'
  }

  npm run typecheck
  if ($LASTEXITCODE -ne 0) { throw 'Root TypeScript check failed in the output directory.' }

  npm run typecheck:console
  if ($LASTEXITCODE -ne 0) { throw 'Console TypeScript check failed in the output directory.' }

  npm run check:imports
  if ($LASTEXITCODE -ne 0) { throw 'FsGuard import-boundary check failed in the output directory.' }

  npm run prechatgpt:local
  if ($LASTEXITCODE -ne 0) { throw 'Production console build failed in the output directory.' }

  node -e "const Database=require('better-sqlite3'); const db=new Database(':memory:'); const row=db.prepare('select sqlite_version() as version').get(); if(!row.version) process.exit(2); console.log('better-sqlite3 native smoke: PASS'); db.close();"
  if ($LASTEXITCODE -ne 0) { throw 'better-sqlite3 native module smoke test failed in the output directory.' }

  $tunnelClientHash = (Get-FileHash -LiteralPath (Join-Path $vendorBin 'tunnel-client.exe') -Algorithm SHA256).Hash.ToLowerInvariant()
  $cloudflaredHash = (Get-FileHash -LiteralPath (Join-Path $vendorBin 'cloudflared.exe') -Algorithm SHA256).Hash.ToLowerInvariant()
  $releaseEvidence = Join-Path $outputRoot 'docs\release'
  npm run release:evidence -- `
    "--source-root=$repoRoot" `
    "--runtime-root=$outputRoot" `
    "--output-dir=$releaseEvidence" `
    "--tunnel-client-version=$tunnelVersion" `
    "--tunnel-archive-sha256=$expectedHash" `
    "--tunnel-client-sha256=$tunnelClientHash" `
    "--cloudflared-sha256=$cloudflaredHash" `
    "--sqlite-prebuild-sha256=$sourceSqliteHash"
  if ($LASTEXITCODE -ne 0) { throw 'SBOM/build-record generation failed in the runtime output directory.' }
} finally {
  Pop-Location
}

Write-Host "Windows runtime package created: $outputRoot"
Write-Host "Node.js: $nodeVersionText; tunnel-client: $reportedTunnelVersion"
Write-Host 'The runtime folder is tied to this absolute path by npm workspace links; do not move it after building.'
