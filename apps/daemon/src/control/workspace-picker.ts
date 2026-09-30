/**
 * 从本机 Windows 桌面选择工作区路径。
 *
 * 浏览器不能把 File System Access API 的目录句柄转换成 daemon 可用的
 * 绝对路径，因此由已认证的本地控制平面启动 Windows 原生选择窗口；
 * 选择结果只返回给当前控制台，不记录、不登记，也不授予访问权限。
 */

import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { BridgeError } from '@lwb/contracts';

export type WorkspacePickKind = 'directory' | 'file';

interface ActivePicker {
  readonly kind: WorkspacePickKind;
  readonly promise: Promise<string | null>;
}

let activePicker: ActivePicker | null = null;

/**
 * 打开系统目录或文件选择窗口。
 * 同一时间只允许一个选择窗口，避免多个控制台标签页叠出模态窗口。
 */
export function pickWorkspacePath(kind: WorkspacePickKind): Promise<string | null> {
  if (process.platform !== 'win32') {
    return Promise.reject(
      new BridgeError('UNSUPPORTED_OPERATION', '本机选择窗口目前仅支持 Windows；请粘贴完整本机路径。'),
    );
  }

  if (activePicker !== null) {
    if (activePicker.kind === kind) return activePicker.promise;
    return Promise.reject(
      new BridgeError('UNSUPPORTED_OPERATION', '本机已有选择窗口打开；完成或取消后再试。'),
    );
  }

  const promise = openWindowsPicker(kind).finally(() => {
    if (activePicker?.promise === promise) activePicker = null;
  });
  activePicker = { kind, promise };
  return promise;
}

function openWindowsPicker(kind: WorkspacePickKind): Promise<string | null> {
  const systemRoot = process.env['SystemRoot'];
  const powershell = systemRoot === undefined
    ? 'powershell.exe'
    : join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script = kind === 'directory' ? DIRECTORY_PICKER_SCRIPT : FILE_PICKER_SCRIPT;

  return new Promise((resolve, reject) => {
    execFile(
      powershell,
      [
        '-NoLogo',
        '-NoProfile',
        '-STA',
        '-WindowStyle',
        'Hidden',
        '-Command',
        script,
      ],
      { encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 },
      (error, stdout) => {
        if (error !== null) {
          reject(new BridgeError('INTERNAL_ERROR', '无法打开 Windows 系统选择窗口，请手动粘贴完整路径。'));
          return;
        }

        // Base64 只包含 ASCII，避免 PowerShell 控制台代码页损坏中文目录名。
        const encodedPath = stdout.replace(/[\r\n]+$/u, '');
        if (encodedPath.length === 0) {
          resolve(null);
          return;
        }
        if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encodedPath)) {
          reject(new BridgeError('INTERNAL_ERROR', 'Windows 选择窗口返回了无法识别的路径，请手动粘贴完整路径。'));
          return;
        }

        const selectedPath = Buffer.from(encodedPath, 'base64').toString('utf8');
        if (
          selectedPath.length === 0 ||
          selectedPath.includes('\0') ||
          Buffer.from(selectedPath, 'utf8').toString('base64') !== encodedPath
        ) {
          reject(new BridgeError('INTERNAL_ERROR', 'Windows 选择窗口返回了无法识别的路径，请手动粘贴完整路径。'));
          return;
        }
        resolve(selectedPath);
      },
    );
  });
}

const DIRECTORY_PICKER_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = '选择要登记的本地目录'
$dialog.ShowNewFolderButton = $false
$selectedPath = $null
try {
  if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
    $selectedPath = $dialog.SelectedPath
  }
} finally {
  $dialog.Dispose()
}
if (-not [string]::IsNullOrEmpty($selectedPath)) {
  [Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($selectedPath)))
}
`;

const FILE_PICKER_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.OpenFileDialog
$dialog.Title = '选择要登记的本地文件'
$dialog.Filter = '所有文件 (*.*)|*.*'
$dialog.CheckFileExists = $true
$dialog.Multiselect = $false
$selectedPath = $null
try {
  if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
    $selectedPath = $dialog.FileName
  }
} finally {
  $dialog.Dispose()
}
if (-not [string]::IsNullOrEmpty($selectedPath)) {
  [Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($selectedPath)))
}
`;
