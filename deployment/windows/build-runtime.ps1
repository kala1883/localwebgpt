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
$pinnedTunnelArchiveHash = '3b53133a1e24d43f63088d843860cb1701a4c3ed6390de2e19f69089e43bddc1'
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
$sidecarHash = $checksumMatches[0].Matches[0].Groups['hash'].Value.ToLowerInvariant()
if ($sidecarHash -ne $pinnedTunnelArchiveHash) {
  throw 'The local SHA256SUMS.txt does not match the version-pinned tunnel-client archive hash.'
}
$actualHash = (Get-FileHash -LiteralPath $tunnelArchive -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actualHash -ne $pinnedTunnelArchiveHash) {
  throw 'The local tunnel-client archive does not match the version-pinned SHA-256 hash.'
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
Copy-Item -LiteralPath (Join-Path $repoRoot 'scripts\windows\Start-LocalWebGPT.ps1') -Destination $outputRoot
Copy-Item -LiteralPath (Join-Path $repoRoot 'scripts\windows\Stop-LocalWebGPT.ps1') -Destination $outputRoot
Copy-Item -LiteralPath (Join-Path $repoRoot 'scripts\windows\Uninstall-LocalWebGPT.ps1') -Destination $outputRoot

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

  # Tests and their generated canary fixtures are needed for typechecking but
  # have no place in the end-user runtime. Resolve the exact copied tree and
  # reject reparse points before removing this build-owned output subtree.
  $testsRoot = Join-Path $outputRoot 'tests'
  if (Test-Path -LiteralPath $testsRoot) {
    $testsItem = Get-Item -LiteralPath $testsRoot -Force
    if (-not $testsItem.PSIsContainer -or
        ($testsItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw 'The copied tests path is not an ordinary directory; refusing package cleanup.'
    }
    $resolvedOutputRoot = (Resolve-Path -LiteralPath $outputRoot).Path.TrimEnd('\')
    $resolvedTestsRoot = (Resolve-Path -LiteralPath $testsRoot).Path.TrimEnd('\')
    $expectedTestsRoot = [System.IO.Path]::GetFullPath((Join-Path $resolvedOutputRoot 'tests')).TrimEnd('\')
    if (-not $resolvedTestsRoot.Equals($expectedTestsRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
      throw 'The copied tests tree resolved outside its expected runtime path; refusing package cleanup.'
    }
    Remove-Item -LiteralPath $resolvedTestsRoot -Recurse -Force
  }

  # Retain production dependencies only. `tsx` is a runtime dependency because
  # daemon and adapter entrypoints load the reviewed TypeScript source directly.
  npm prune --omit=dev --ignore-scripts --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw 'Could not remove development-only dependencies from the runtime package.' }

  foreach ($developmentModule in @('@vue/test-utils', 'vitest', 'vite', 'vue-tsc')) {
    if (Test-Path -LiteralPath (Join-Path $outputRoot (Join-Path 'node_modules' $developmentModule))) {
      throw "Development-only module remains in runtime package: $developmentModule"
    }
  }

  node --import tsx --input-type=module -e "await import('./packages/contracts/src/index.ts'); await import('./apps/daemon/src/tools/catalog.ts'); console.log('Runtime TypeScript module smoke: PASS');"
  if ($LASTEXITCODE -ne 0) { throw 'Runtime TypeScript module smoke failed after pruning dev dependencies.' }

  node -e "const Database=require('better-sqlite3'); const db=new Database(':memory:'); const row=db.prepare('select sqlite_version() as version').get(); if(!row.version) process.exit(2); console.log('better-sqlite3 native smoke: PASS'); db.close();"
  if ($LASTEXITCODE -ne 0) { throw 'better-sqlite3 native module smoke test failed after pruning dev dependencies.' }

  # Mark this folder as a packaged runtime so its launcher can use the
  # prebuilt Console bundle instead of npm's dev-only prechatgpt lifecycle.
  Set-Content -LiteralPath (Join-Path $outputRoot '.lwb-runtime-package') -Value 'format=1' -Encoding ascii

  npm run check:secrets
  if ($LASTEXITCODE -ne 0) { throw 'Packaged runtime secret scan failed.' }

  $tunnelClientHash = (Get-FileHash -LiteralPath (Join-Path $vendorBin 'tunnel-client.exe') -Algorithm SHA256).Hash.ToLowerInvariant()
  $cloudflaredHash = (Get-FileHash -LiteralPath (Join-Path $vendorBin 'cloudflared.exe') -Algorithm SHA256).Hash.ToLowerInvariant()
  $releaseEvidence = Join-Path $outputRoot 'docs\release'
  npm run release:evidence -- `
    "--source-root=$repoRoot" `
    "--runtime-root=$outputRoot" `
    "--output-dir=$releaseEvidence" `
    "--tunnel-client-version=$tunnelVersion" `
    "--tunnel-archive-sha256=$pinnedTunnelArchiveHash" `
    "--tunnel-client-sha256=$tunnelClientHash" `
    "--cloudflared-sha256=$cloudflaredHash" `
    "--sqlite-prebuild-sha256=$sourceSqliteHash"
  if ($LASTEXITCODE -ne 0) { throw 'SBOM/build-record generation failed in the runtime output directory.' }

  $buildInfoPath = Join-Path $outputRoot '.lwb-build-info.json'
  if (-not (Test-Path -LiteralPath $buildInfoPath -PathType Leaf)) {
    throw 'Packaged build identity was not generated.'
  }
  $buildInfo = Get-Content -LiteralPath $buildInfoPath -Raw -Encoding UTF8 | ConvertFrom-Json -ErrorAction Stop
  if ($buildInfo.schema_version -ne 1 -or
      [string]$buildInfo.source_manifest_sha256 -notmatch '^[0-9a-f]{64}$' -or
      [string]$buildInfo.build_id -cne "sha256:$($buildInfo.source_manifest_sha256)") {
    throw 'Packaged build identity failed validation.'
  }
} finally {
  Pop-Location
}

Write-Host "Windows runtime package created: $outputRoot"
Write-Host "Node.js: $nodeVersionText; tunnel-client: $reportedTunnelVersion"
Write-Host 'The runtime folder is tied to this absolute path by npm workspace links; do not move it after building.'
