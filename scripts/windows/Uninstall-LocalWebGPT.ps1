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

$identitySource = @"
using System;
using System.IO;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

public static class LwbUninstallIdentity {
  private const uint FILE_READ_ATTRIBUTES = 0x00000080;
  private const uint FILE_SHARE_READ = 0x00000001;
  private const uint FILE_SHARE_WRITE = 0x00000002;
  private const uint FILE_SHARE_DELETE = 0x00000004;
  private const uint OPEN_EXISTING = 3;
  private const uint FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
  private const uint FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000;
  private const int FileAttributeTagInfo = 9;
  private const int FileIdInfo = 18;

  [StructLayout(LayoutKind.Sequential)]
  private struct AttributeTagInfo {
    public uint FileAttributes;
    public uint ReparseTag;
  }

  [StructLayout(LayoutKind.Sequential)]
  private struct FileId128 {
    public ulong LowPart;
    public ulong HighPart;
  }

  [StructLayout(LayoutKind.Sequential)]
  private struct FileIdInfoData {
    public ulong VolumeSerialNumber;
    public FileId128 FileId;
  }

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "CreateFileW")]
  private static extern SafeFileHandle CreateFile(
    string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);

  [DllImport("kernel32.dll", SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool GetFileInformationByHandleEx(
    SafeFileHandle handle, int infoClass, out AttributeTagInfo info, uint size);

  [DllImport("kernel32.dll", SetLastError = true, EntryPoint = "GetFileInformationByHandleEx")]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool GetFileIdInformationByHandleEx(
    SafeFileHandle handle, int infoClass, out FileIdInfoData info, uint size);

  public static SafeFileHandle Open(string path) {
    SafeFileHandle handle = CreateFile(
      path, FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
      IntPtr.Zero, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, IntPtr.Zero);
    if (handle.IsInvalid) {
      int error = Marshal.GetLastWin32Error();
      handle.Dispose();
      throw new IOException("Could not inspect the selected runtime root (Win32 " + error + ").");
    }
    return handle;
  }

  public static uint Attributes(SafeFileHandle handle) {
    AttributeTagInfo info;
    if (!GetFileInformationByHandleEx(handle, FileAttributeTagInfo, out info,
          (uint)Marshal.SizeOf<AttributeTagInfo>())) {
      throw new IOException("Could not inspect the selected runtime root attributes.");
    }
    return info.FileAttributes;
  }

  public static string Identity(SafeFileHandle handle) {
    FileIdInfoData info;
    if (!GetFileIdInformationByHandleEx(handle, FileIdInfo, out info, (uint)Marshal.SizeOf<FileIdInfoData>())) {
      throw new IOException("Could not read the selected runtime root identity.");
    }
    return info.VolumeSerialNumber.ToString("x16") + ":" +
      info.FileId.HighPart.ToString("x16") + info.FileId.LowPart.ToString("x16");
  }
}
"@
Add-Type -TypeDefinition $identitySource -ErrorAction Stop

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

$runtimePath = ConvertTo-NormalizedPath (Resolve-Path -LiteralPath $RuntimeDirectory -ErrorAction Stop).Path
$runtimeRoot = [System.IO.Path]::GetPathRoot($runtimePath)
if ($runtimePath.Equals($runtimeRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw 'Refusing to remove a filesystem root.'
}
$identityHandle = [LwbUninstallIdentity]::Open($runtimePath)
try {
  $identityAttributes = [LwbUninstallIdentity]::Attributes($identityHandle)
  if (($identityAttributes -band 0x10) -eq 0 -or ($identityAttributes -band 0x400) -ne 0) {
    throw 'Refusing to remove a runtime root that is not an ordinary directory.'
  }
  $runtimeRootIdentity = [LwbUninstallIdentity]::Identity($identityHandle)
} finally {
  $identityHandle.Dispose()
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
  # Keep the handoff marker outside the tree being removed. Creating it under
  # the runtime by pathname could write through a junction swapped in after
  # the earlier root check.
  $markerPath = Join-Path $temporaryPath $markerName
  $markerToken = [Guid]::NewGuid().ToString('N')
  $markerStream = [System.IO.FileStream]::new(
    $markerPath,
    [System.IO.FileMode]::CreateNew,
    [System.IO.FileAccess]::Write,
    [System.IO.FileShare]::Read
  )
  try {
    $markerBytes = [System.Text.Encoding]::ASCII.GetBytes($markerToken)
    $markerStream.Write($markerBytes, 0, $markerBytes.Length)
    $markerStream.Flush($true)
  } finally {
    $markerStream.Dispose()
  }

  $currentProcess = [System.Diagnostics.Process]::GetCurrentProcess()
  $parentProcessId = $currentProcess.Id
  $parentStartTicks = $currentProcess.StartTime.ToUniversalTime().Ticks
$cleanupProgram = @'
$ErrorActionPreference = 'Stop'
$markerPath = [string]$env:LWB_UNINSTALL_MARKER
try {
  $target = [System.IO.Path]::GetFullPath($env:LWB_UNINSTALL_TARGET).TrimEnd([char[]]@('\', '/'))
  $marker = [System.IO.Path]::GetFullPath($markerPath)

  $nativeDeleteSource = @"
using System;
using System.IO;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

public static class LwbHandleDelete {
  private const uint DELETE = 0x00010000;
  private const uint FILE_LIST_DIRECTORY = 0x00000001;
  private const uint FILE_READ_DATA = 0x00000001;
  private const uint FILE_READ_ATTRIBUTES = 0x00000080;
  private const uint FILE_SHARE_READ = 0x00000001;
  private const uint FILE_SHARE_WRITE = 0x00000002;
  private const uint OPEN_EXISTING = 3;
  private const uint FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
  private const uint FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000;
  private const int FileAttributeTagInfo = 9;
  private const int FileDispositionInfoEx = 21;
  private const uint FILE_DISPOSITION_FLAG_DELETE = 0x00000001;
  private const uint FILE_DISPOSITION_FLAG_IGNORE_READONLY_ATTRIBUTE = 0x00000010;
  private const int FileIdInfo = 18;

  [StructLayout(LayoutKind.Sequential)]
  private struct AttributeTagInfo {
    public uint FileAttributes;
    public uint ReparseTag;
  }

  [StructLayout(LayoutKind.Sequential)]
  private struct DispositionInfoEx {
    public uint Flags;
  }

  [StructLayout(LayoutKind.Sequential)]
  private struct FileId128 {
    public ulong LowPart;
    public ulong HighPart;
  }

  [StructLayout(LayoutKind.Sequential)]
  private struct FileIdInfoData {
    public ulong VolumeSerialNumber;
    public FileId128 FileId;
  }

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "CreateFileW")]
  private static extern SafeFileHandle CreateFile(
    string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);

  [DllImport("kernel32.dll", SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool GetFileInformationByHandleEx(
    SafeFileHandle handle, int infoClass, out AttributeTagInfo info, uint size);

  [DllImport("kernel32.dll", SetLastError = true, EntryPoint = "GetFileInformationByHandleEx")]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool GetFileIdInformationByHandleEx(
    SafeFileHandle handle, int infoClass, out FileIdInfoData info, uint size);

  [DllImport("kernel32.dll", SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool SetFileInformationByHandle(
    SafeFileHandle handle, int infoClass, ref DispositionInfoEx info, uint size);

  private static SafeFileHandle Open(string path, uint access, uint share) {
    SafeFileHandle handle = CreateFile(
      path, access, share, IntPtr.Zero, OPEN_EXISTING,
      FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, IntPtr.Zero);
    if (handle.IsInvalid) {
      int error = Marshal.GetLastWin32Error();
      handle.Dispose();
      throw new IOException("Could not pin an uninstall path component (Win32 " + error + ").");
    }
    return handle;
  }

  // Ancestor handles allow readers/writers, but omit FILE_SHARE_DELETE so the
  // path chain cannot be renamed or replaced while recursive cleanup runs.
  public static SafeFileHandle OpenAncestor(string path) {
    return Open(path, FILE_READ_ATTRIBUTES | FILE_LIST_DIRECTORY, FILE_SHARE_READ | FILE_SHARE_WRITE);
  }

  // For each tree entry, omit both FILE_SHARE_WRITE and FILE_SHARE_DELETE.
  // The open object cannot be replaced or changed while inspected/deleted.
  public static SafeFileHandle OpenEntry(string path) {
    return Open(path, DELETE | FILE_READ_ATTRIBUTES | FILE_LIST_DIRECTORY, FILE_SHARE_READ);
  }

  public static SafeFileHandle OpenReadNoFollow(string path) {
    return Open(path, FILE_READ_DATA | FILE_READ_ATTRIBUTES, FILE_SHARE_READ);
  }

  public static uint Attributes(SafeFileHandle handle) {
    AttributeTagInfo info;
    if (!GetFileInformationByHandleEx(handle, FileAttributeTagInfo, out info,
          (uint)Marshal.SizeOf<AttributeTagInfo>())) {
      throw new IOException("Could not inspect a pinned uninstall handle (Win32 " + Marshal.GetLastWin32Error() + ").");
    }
    return info.FileAttributes;
  }

  public static string Identity(SafeFileHandle handle) {
    FileIdInfoData info;
    if (!GetFileIdInformationByHandleEx(handle, FileIdInfo, out info, (uint)Marshal.SizeOf<FileIdInfoData>())) {
      throw new IOException("Could not read the pinned runtime root identity.");
    }
    return info.VolumeSerialNumber.ToString("x16") + ":" +
      info.FileId.HighPart.ToString("x16") + info.FileId.LowPart.ToString("x16");
  }

  public static void DeleteByHandle(SafeFileHandle handle) {
    DispositionInfoEx info = new DispositionInfoEx {
      Flags = FILE_DISPOSITION_FLAG_DELETE | FILE_DISPOSITION_FLAG_IGNORE_READONLY_ATTRIBUTE
    };
    if (!SetFileInformationByHandle(handle, FileDispositionInfoEx, ref info,
          (uint)Marshal.SizeOf<DispositionInfoEx>())) {
      throw new IOException("Could not delete the pinned runtime object (Win32 " + Marshal.GetLastWin32Error() + ").");
    }
  }
}
"@
  Add-Type -TypeDefinition $nativeDeleteSource -ErrorAction Stop

  $volumeRoot = [System.IO.Path]::GetPathRoot($target)
  if ($volumeRoot -notmatch '^[A-Za-z]:\\$') {
    throw 'Race-resistant uninstall currently requires a local drive path.'
  }
  $ancestorHandles = [System.Collections.Generic.List[Microsoft.Win32.SafeHandles.SafeFileHandle]]::new()
  $rootHandle = $null
  $markerHandle = $null
  try {
    $current = $volumeRoot
    $ancestorPaths = [System.Collections.Generic.List[string]]::new()
    $ancestorPaths.Add($current)
    $relative = $target.Substring($volumeRoot.Length).Trim([char[]]@(92, 47))
    $parts = @($relative.Split([char]92, [System.StringSplitOptions]::RemoveEmptyEntries))
    for ($i = 0; $i -lt ($parts.Length - 1); $i++) {
      $current = [System.IO.Path]::Combine($current, $parts[$i])
      $ancestorPaths.Add($current)
    }
    foreach ($ancestorPath in $ancestorPaths) {
      $ancestorHandle = [LwbHandleDelete]::OpenAncestor($ancestorPath)
      $ancestorAttributes = [LwbHandleDelete]::Attributes($ancestorHandle)
      if (($ancestorAttributes -band 0x10) -eq 0 -or ($ancestorAttributes -band 0x400) -ne 0) {
        $ancestorHandle.Dispose()
        throw 'A runtime ancestor is not a stable ordinary directory.'
      }
      $ancestorHandles.Add($ancestorHandle)
    }

    $rootHandle = [LwbHandleDelete]::OpenEntry($target)
    $rootAttributes = [LwbHandleDelete]::Attributes($rootHandle)
    if (($rootAttributes -band 0x10) -eq 0 -or ($rootAttributes -band 0x400) -ne 0) {
      throw 'The runtime root changed or became a reparse point; no recursive deletion was attempted.'
    }
    if ([LwbHandleDelete]::Identity($rootHandle) -cne $env:LWB_UNINSTALL_ROOT_IDENTITY) {
      throw 'The runtime root identity changed after it was checked; no deletion was attempted.'
    }

    $markerHandle = [LwbHandleDelete]::OpenReadNoFollow($marker)
    if (([LwbHandleDelete]::Attributes($markerHandle) -band 0x400) -ne 0) {
      throw 'The handoff marker is a reparse point; runtime was not removed.'
    }
    $markerStream = [System.IO.FileStream]::new($markerHandle, [System.IO.FileAccess]::Read, 4096, $false)
    $markerHandle = $null
    $markerReader = [System.IO.StreamReader]::new($markerStream, [System.Text.Encoding]::ASCII, $false, 1024, $false)
    try {
      if ($markerReader.ReadToEnd() -cne $env:LWB_UNINSTALL_MARKER_TOKEN) {
        throw 'The handoff marker did not match; runtime was not removed.'
      }
    } finally {
      $markerReader.Dispose()
    }

    foreach ($requiredFile in @('package.json', 'Start-LocalWebGPT.ps1', 'Stop-LocalWebGPT.ps1')) {
      if (-not [System.IO.File]::Exists([System.IO.Path]::Combine($target, $requiredFile))) {
        throw 'The locked target is not a LocalWebGPT runtime.'
      }
    }
    if ([System.IO.Directory]::Exists([System.IO.Path]::Combine($target, '.git'))) {
      throw 'Refusing to remove a Git repository.'
    }

    function Remove-LwbEntryByHandle([string]$Path, $PinnedHandle = $null) {
      $ownsHandle = $null -eq $PinnedHandle
      $entryHandle = $PinnedHandle
      if ($ownsHandle) { $entryHandle = [LwbHandleDelete]::OpenEntry($Path) }
      try {
        $attributes = [LwbHandleDelete]::Attributes($entryHandle)
        if (($attributes -band 0x400) -eq 0 -and ($attributes -band 0x10) -ne 0) {
          foreach ($childPath in [System.IO.Directory]::EnumerateFileSystemEntries($Path)) {
            Remove-LwbEntryByHandle $childPath
          }
        }
        # OPEN_REPARSE_POINT plus a pinned handle makes this unlink the link
        # itself; it never follows the link target. Ordinary directories are
        # enumerated only while their no-write/no-rename handle remains open.
        [LwbHandleDelete]::DeleteByHandle($entryHandle)
      } finally {
        if ($ownsHandle -and $null -ne $entryHandle) { $entryHandle.Dispose() }
      }
    }

    # Pin the exact tree before waiting for the original process to exit. That
    # closes the handoff window in which the runtime path could be replaced.
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

    Remove-LwbEntryByHandle $target $rootHandle
  } finally {
    if ($null -ne $markerHandle) { $markerHandle.Dispose() }
    if ($null -ne $rootHandle) { $rootHandle.Dispose() }
    for ($i = $ancestorHandles.Count - 1; $i -ge 0; $i--) {
      $ancestorHandles[$i].Dispose()
    }
  }
} catch {
  exit 26
} finally {
  try { [System.IO.File]::Delete($marker) } catch { }
}
'@
  $encodedProgram = [Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes($cleanupProgram))
  $environmentNames = @(
    'LWB_UNINSTALL_TARGET',
    'LWB_UNINSTALL_MARKER',
    'LWB_UNINSTALL_MARKER_TOKEN',
    'LWB_UNINSTALL_PARENT_PID',
    'LWB_UNINSTALL_PARENT_START_TICKS',
    'LWB_UNINSTALL_ROOT_IDENTITY'
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
    [Environment]::SetEnvironmentVariable('LWB_UNINSTALL_ROOT_IDENTITY', $runtimeRootIdentity, [EnvironmentVariableTarget]::Process)
    Start-Process -FilePath (Join-Path $PSHOME 'pwsh.exe') `
      -ArgumentList @('-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', $encodedProgram) `
      -WorkingDirectory $temporaryPath -WindowStyle Hidden | Out-Null
  } finally {
    foreach ($name in $environmentNames) {
      [Environment]::SetEnvironmentVariable($name, $priorEnvironment[$name], [EnvironmentVariableTarget]::Process)
    }
  }
} catch {
  if (Test-Path -LiteralPath $markerPath) { [System.IO.File]::Delete($markerPath) }
  throw 'Could not start the isolated runtime cleanup process; nothing was removed.'
}

Write-Host 'Runtime cleanup was handed to a hidden helper that waits for this PowerShell process to exit. Verify that the exact runtime directory disappears; protected state and registered workspaces are not targeted.'
