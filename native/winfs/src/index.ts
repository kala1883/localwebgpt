/**
 * @lwb/winfs —— Windows 文件系统护栏。
 *
 * 业务包**只能**通过这里的接口访问磁盘（由 scripts/check-fsguard-imports.mjs 强制）。
 * 实现是 fail-closed 的：护栏不可用时不写入，而不是退化成普通 fs。
 */

export * from './error-codes.ts';
export * from './ops.ts';
export * from './helper-client.ts';
export * from './powershell-backend.ts';

import { PowerShellWinfsBackend } from './powershell-backend.ts';

let singleton: PowerShellWinfsBackend | null = null;

/**
 * 取得进程内的护栏后端单例。
 *
 * 必须是单例：常驻 PowerShell 助手每次启动实测约 1.1 秒，
 * 每次调用新起进程无法满足 P95 ≤ 500ms（见 docs/evidence/lwb-003）。
 */
export function getWinfsBackend(): PowerShellWinfsBackend {
  if (!singleton) singleton = new PowerShellWinfsBackend();
  return singleton;
}

export async function disposeWinfsBackend(): Promise<void> {
  if (singleton) {
    await singleton.dispose();
    singleton = null;
  }
}
