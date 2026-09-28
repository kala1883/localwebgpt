[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param(
  [Parameter(Mandatory = $true)]
  [switch]$ConfirmTargetRuntimeStopped,
  [string]$RuntimeDirectory = $PSScriptRoot,
  [string]$StateRoot = ''
)

$ErrorActionPreference = 'Stop'

if (-not $IsWindows) {
  throw 'LocalWebGPT runtime removal is supported on Windows only.'
}

function ConvertTo-NormalizedPath([string]$Value) {
  if ([string]::IsNullOrWhiteSpace($Value)) { throw 'A required path is empty.' }
  $candidate = $Value.Trim()
  if ($candidate.StartsWith('\\?\UNC\', [System.StringComparison]::OrdinalIgnoreCase)) {
    $candidate = '\\' + $candidate.Substring(8)
  } elseif ($candidate.StartsWith('\\?\', [System.StringComparison]::OrdinalIgnoreCase)) {
    $candidate = $candidate.Substring(4)
  }
  $full = [System.IO.Path]::GetFullPath($candidate)
  $volumeRoot = [System.IO.Path]::GetPathRoot($full)
  if ($full.Length -gt $volumeRoot.Length) {
    $full = $full.TrimEnd([char[]]@('\', '/'))
  }
  return $full
}

function Test-PathAtOrBelow([string]$Candidate, [string]$Parent) {
  $candidatePath = ConvertTo-NormalizedPath $Candidate
  $parentPath = ConvertTo-NormalizedPath $Parent
  if ($candidatePath.Equals($parentPath, [System.StringComparison]::OrdinalIgnoreCase)) { return $true }
  $prefix = if ($parentPath.EndsWith('\') -or $parentPath.EndsWith('/')) { $parentPath } else { $parentPath + '\' }
  return $candidatePath.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)
}

function Test-PathsOverlap([string]$First, [string]$Second) {
  return (Test-PathAtOrBelow $First $Second) -or (Test-PathAtOrBelow $Second $First)
}

function Get-RegisteredWorkspaceRoots([string]$DatabasePath, [string]$RuntimeRoot) {
  if (-not (Test-Path -LiteralPath $DatabasePath -PathType Leaf)) { return @() }

  $node = Get-Command node -ErrorAction Stop
  $query = @'
const Database = require('better-sqlite3');
const db = new Database(process.argv[1], { readonly: true, fileMustExist: true });
try {
  const columns = db.pragma('table_info(workspaces)').map((column) => column.name);
  if (!columns.includes('canonical_root')) throw new Error('workspace roots unavailable');
  const rows = db.prepare('SELECT canonical_root FROM workspaces').all();
  if (rows.some((row) => typeof row.canonical_root !== 'string' || row.canonical_root.length === 0)) {
    throw new Error('workspace root is malformed');
  }
  process.stdout.write(JSON.stringify(rows));
} finally {
  db.close();
}
'@
  $json = ''
  $nodeExitCode = 1
  Push-Location -LiteralPath $RuntimeRoot
  try {
    $nodeOutput = & $node.Source -e $query $DatabasePath 2>$null
    $nodeExitCode = $LASTEXITCODE
    $json = ($nodeOutput -join '').Trim()
  } finally {
    Pop-Location
  }
  if ($nodeExitCode -ne 0 -or $json.Length -eq 0) {
    throw 'Could not verify registered workspace roots from the protected state database; runtime was not removed.'
  }

  try {
    $rows = ConvertFrom-Json -InputObject $json -ErrorAction Stop
  } catch {
    throw 'Workspace-root data in the protected state database could not be verified; runtime was not removed.'
  }
  return @($rows | ForEach-Object { [string]$_.canonical_root })
}

function Remove-TreeWithoutFollowingLinks([string]$Directory) {
  $directoryItem = Get-Item -LiteralPath $Directory -Force -ErrorAction Stop
  if (($directoryItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw 'Refusing to recurse through a reparse-point directory.'
  }

  foreach ($entryPath in [System.IO.Directory]::EnumerateFileSystemEntries($Directory)) {
    $attributes = [System.IO.File]::GetAttributes($entryPath)
    $isDirectory = ($attributes -band [System.IO.FileAttributes]::Directory) -ne 0
    $isReparsePoint = ($attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0
    if ($isReparsePoint) {
      # Delete the link/junction itself. Never recurse through its target.
      if ($isDirectory) {
        [System.IO.Directory]::Delete($entryPath, $false)
      } else {
        [System.IO.File]::Delete($entryPath)
      }
    } elseif ($isDirectory) {
      Remove-TreeWithoutFollowingLinks $entryPath
    } else {
      if (($attributes -band [System.IO.FileAttributes]::ReadOnly) -ne 0) {
        [System.IO.File]::SetAttributes(
          $entryPath,
          $attributes -band (-bnot [System.IO.FileAttributes]::ReadOnly)
        )
      }
      [System.IO.File]::Delete($entryPath)
    }
  }
  [System.IO.Directory]::Delete($Directory, $false)
}

$runtimePath = ConvertTo-NormalizedPath (Resolve-Path -LiteralPath $RuntimeDirectory -ErrorAction Stop).Path
$runtimeRoot = [System.IO.Path]::GetPathRoot($runtimePath)
if ($runtimePath.Equals($runtimeRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw 'Refusing to remove a filesystem root.'
}
$runtimeItem = Get-Item -LiteralPath $runtimePath -Force -ErrorAction Stop
if (($runtimeItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
  throw 'Refusing to remove a runtime root that is a reparse point.'
}
foreach ($requiredFile in @('package.json', 'Start-LocalWebGPT.ps1', 'Stop-LocalWebGPT.ps1')) {
  if (-not (Test-Path -LiteralPath (Join-Path $runtimePath $requiredFile) -PathType Leaf)) {
    throw 'The target does not look like a LocalWebGPT runtime; nothing was removed.'
  }
}
if (Test-Path -LiteralPath (Join-Path $runtimePath '.git')) {
  throw 'Refusing to remove a source checkout or Git repository.'
}

if (-not $PSBoundParameters.ContainsKey('StateRoot') -or [string]::IsNullOrWhiteSpace($StateRoot)) {
  if (-not [string]::IsNullOrWhiteSpace($env:LWB_HOME)) {
    $StateRoot = $env:LWB_HOME
  } elseif (-not [string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
    $StateRoot = Join-Path $env:LOCALAPPDATA 'LocalWorkspaceBridge'
  } else {
    throw 'StateRoot is unknown; pass the protected state directory explicitly.'
  }
}
$statePath = ConvertTo-NormalizedPath $StateRoot
if (Test-PathsOverlap $statePath $runtimePath) {
  throw 'The protected state directory overlaps the runtime path; nothing was removed.'
}
$databasePath = Join-Path $statePath 'db\bridge.sqlite'
$workspaceRoots = Get-RegisteredWorkspaceRoots $databasePath $runtimePath
foreach ($workspaceRoot in $workspaceRoots) {
  if (Test-PathsOverlap $workspaceRoot $runtimePath) {
    throw 'The runtime path overlaps a registered workspace; disable or remove that workspace grant before uninstalling.'
  }
}

if (-not $ConfirmTargetRuntimeStopped) {
  throw 'First run Stop-LocalWebGPT.ps1 and wait for the startup terminal to exit, then rerun with -ConfirmTargetRuntimeStopped.'
}

# Removing the directory which contains the currently executing script can fail
# on Windows even after changing the working directory. Require a standalone
# -File process so a short-lived helper can wait for this process to release it.
try {
  $invokingProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$PID" -ErrorAction Stop
} catch {
  throw 'Could not verify the uninstaller process; runtime was not removed.'
}
$commandLine = [string]$invokingProcess.CommandLine
if ($commandLine -notmatch '(?i)(?:^|\s)-File\s+' -or
    $commandLine.IndexOf($PSCommandPath, [System.StringComparison]::OrdinalIgnoreCase) -lt 0) {
  throw 'Run the uninstaller in a standalone process: pwsh.exe -NoProfile -File <full path to Uninstall-LocalWebGPT.ps1> -ConfirmTargetRuntimeStopped.'
}

# Do not remove an installation whose tunnel child is still running from inside
# the selected runtime. This is a path-scoped check; it never stops another install.
try {
  $tunnelProcesses = @(Get-CimInstance Win32_Process -Filter "Name='tunnel-client.exe'" -ErrorAction Stop)
} catch {
  throw 'Could not verify whether this runtime still has a tunnel process; nothing was removed.'
}
foreach ($process in $tunnelProcesses) {
  if ([string]::IsNullOrWhiteSpace([string]$process.ExecutablePath)) {
    throw 'A tunnel process path could not be verified; nothing was removed.'
  }
  if (Test-PathAtOrBelow ([string]$process.ExecutablePath) $runtimePath) {
    throw 'A tunnel-client process is still running from this runtime; stop it before uninstalling.'
  }
}

if (-not $PSCmdlet.ShouldProcess($runtimePath, 'Remove only this LocalWebGPT runtime directory')) { return }

$temporaryPath = ConvertTo-NormalizedPath ([System.IO.Path]::GetTempPath())
if (Test-PathAtOrBelow $temporaryPath $runtimePath) {
  throw 'The temporary directory is inside the runtime; cannot safely change away before removal.'
}
$currentPath = (Get-Location).ProviderPath
if (Test-PathAtOrBelow $currentPath $runtimePath) {
  Set-Location -LiteralPath $temporaryPath
}

try {
  $markerName = '.lwb-uninstall-' + [Guid]::NewGuid().ToString('N') + '.pending'
  $markerPath = Join-Path $runtimePath $markerName
  $markerToken = [Guid]::NewGuid().ToString('N')
  [System.IO.File]::WriteAllText($markerPath, $markerToken, [System.Text.Encoding]::ASCII)

  $currentProcess = [System.Diagnostics.Process]::GetCurrentProcess()
  $parentProcessId = $currentProcess.Id
  $parentStartTicks = $currentProcess.StartTime.ToUniversalTime().Ticks
  $cleanupProgram = @'
$ErrorActionPreference = 'Stop'
try {
  $target = [System.IO.Path]::GetFullPath($env:LWB_UNINSTALL_TARGET).TrimEnd([char[]]@('\', '/'))
  $marker = [System.IO.Path]::GetFullPath($env:LWB_UNINSTALL_MARKER)
  if (-not [System.IO.Path]::GetDirectoryName($marker).Equals($target, [System.StringComparison]::OrdinalIgnoreCase)) { exit 21 }

  try {
    $parent = [System.Diagnostics.Process]::GetProcessById([int]$env:LWB_UNINSTALL_PARENT_PID)
    try {
      if ($parent.StartTime.ToUniversalTime().Ticks -eq [long]$env:LWB_UNINSTALL_PARENT_START_TICKS) {
        if (-not $parent.WaitForExit(30000)) { exit 22 }
      }
    } finally {
      $parent.Dispose()
    }
  } catch [System.ArgumentException] {
    # The parent has already exited.
  }

  if (-not [System.IO.Directory]::Exists($target) -or -not [System.IO.File]::Exists($marker)) { exit 23 }
  if ([System.IO.File]::ReadAllText($marker) -cne $env:LWB_UNINSTALL_MARKER_TOKEN) { exit 24 }
  $root = Get-Item -LiteralPath $target -Force
  if (($root.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { exit 25 }

  function Remove-TreeWithoutFollowingLinks([string]$Directory) {
    foreach ($entryPath in [System.IO.Directory]::EnumerateFileSystemEntries($Directory)) {
      $attributes = [System.IO.File]::GetAttributes($entryPath)
      $isDirectory = ($attributes -band [System.IO.FileAttributes]::Directory) -ne 0
      $isReparsePoint = ($attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0
      if ($isReparsePoint) {
        if ($isDirectory) { [System.IO.Directory]::Delete($entryPath, $false) }
        else { [System.IO.File]::Delete($entryPath) }
      } elseif ($isDirectory) {
        Remove-TreeWithoutFollowingLinks $entryPath
      } else {
        if (($attributes -band [System.IO.FileAttributes]::ReadOnly) -ne 0) {
          [System.IO.File]::SetAttributes($entryPath, $attributes -band (-bnot [System.IO.FileAttributes]::ReadOnly))
        }
        [System.IO.File]::Delete($entryPath)
      }
    }
    [System.IO.Directory]::Delete($Directory, $false)
  }

  Remove-TreeWithoutFollowingLinks $target
} catch {
  exit 26
}
'@
  $encodedProgram = [Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes($cleanupProgram))
  $environmentNames = @(
    'LWB_UNINSTALL_TARGET',
    'LWB_UNINSTALL_MARKER',
    'LWB_UNINSTALL_MARKER_TOKEN',
    'LWB_UNINSTALL_PARENT_PID',
    'LWB_UNINSTALL_PARENT_START_TICKS'
  )
  $priorEnvironment = @{}
  foreach ($name in $environmentNames) {
    $priorEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, [EnvironmentVariableTarget]::Process)
  }
  try {
    [Environment]::SetEnvironmentVariable('LWB_UNINSTALL_TARGET', $runtimePath, [EnvironmentVariableTarget]::Process)
    [Environment]::SetEnvironmentVariable('LWB_UNINSTALL_MARKER', $markerPath, [EnvironmentVariableTarget]::Process)
    [Environment]::SetEnvironmentVariable('LWB_UNINSTALL_MARKER_TOKEN', $markerToken, [EnvironmentVariableTarget]::Process)
    [Environment]::SetEnvironmentVariable('LWB_UNINSTALL_PARENT_PID', [string]$parentProcessId, [EnvironmentVariableTarget]::Process)
    [Environment]::SetEnvironmentVariable('LWB_UNINSTALL_PARENT_START_TICKS', [string]$parentStartTicks, [EnvironmentVariableTarget]::Process)
    Start-Process -FilePath (Join-Path $PSHOME 'pwsh.exe') `
      -ArgumentList @('-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', $encodedProgram) `
      -WorkingDirectory $temporaryPath -WindowStyle Hidden | Out-Null
  } finally {
    foreach ($name in $environmentNames) {
      [Environment]::SetEnvironmentVariable($name, $priorEnvironment[$name], [EnvironmentVariableTarget]::Process)
    }
  }
} catch {
  if (Test-Path -LiteralPath $markerPath) { Remove-Item -LiteralPath $markerPath -Force -ErrorAction SilentlyContinue }
  throw 'Could not start the isolated runtime cleanup process; nothing was removed.'
}

Write-Host 'Runtime cleanup was handed to a hidden helper that waits for this PowerShell process to exit. Verify that the exact runtime directory disappears; protected state and registered workspaces are not targeted.'
