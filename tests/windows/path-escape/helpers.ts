/**
 * path-escape 测试的公共工具。
 *
 * 这些用例的共同点：它们断言的东西**在桩里造不出来**。
 *   - 「同一个对象的两个名字」需要真实的 NTFS 别名（大小写、8.3、硬链接）；
 *   - 「换掉之后路径字符串一模一样」需要真实的 file_id 变化；
 *   - 「持有句柄期间改不了名」是内核的共享模式语义。
 *
 * 所以它们全部走真实磁盘 + 真实护栏（PowerShell + .NET P/Invoke），
 * 并且在非 Windows 上整体跳过，而不是伪装通过。
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe } from 'node:test';

import { PowerShellWinfsBackend, isWinfsError, type WinfsError } from '@lwb/winfs';

export const isWindows = process.platform === 'win32';

/** 非 Windows 上整体跳过。跳过 ≠ 通过：报告里会显示 skipped。 */
export const describeWindows = isWindows ? describe : describe.skip;

export interface RootRef {
  readonly root_path: string;
  readonly root_volume_id: string;
  readonly root_file_id: string;
}

/**
 * 取一个目录/文件的根引用（路径 + 物理身份）。
 *
 * 身份取自护栏自己的 `statVolume`，测试不另算一份 —— 否则验证的是
 * 测试自己写的第二个实现，而不是交付物。
 */
export async function refFor(be: PowerShellWinfsBackend, dir: string): Promise<RootRef> {
  const info = await be.statVolume({ path: dir });
  if (isWinfsError(info)) throw new Error(`statVolume 失败：${info.code} ${info.message}`);
  return { root_path: dir, root_volume_id: info.volume_id, root_file_id: info.file_id };
}

/** 跑一段 PowerShell，返回合并后的输出（用于造别名、查短名等测试装置）。 */
export function ps(command: string): string {
  const res = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', command], {
    encoding: 'utf8',
    timeout: 60_000,
  });
  return `${res.stdout ?? ''}${res.stderr ?? ''}`.trim();
}

/** 断言一次调用**以指定错误码被拒绝**，并返回该错误以便进一步检查。 */
export async function expectRejected(
  code: string,
  fn: () => Promise<{ ok: boolean }>,
  hint: string,
): Promise<WinfsError> {
  const result = await fn();
  assert.equal(
    result.ok,
    false,
    `${hint}：期望被拒绝（${code}），实际成功了 —— ${JSON.stringify(result)}`,
  );
  if (result.ok !== false) throw new Error('unreachable');
  const err = result as unknown as WinfsError;
  assert.equal(err.code, code, `${hint}：期望拒绝码 ${code}，实际 ${err.code}（${err.message}）`);
  return err;
}

/**
 * 读取一个文件并断言成功。
 *
 * `assert.equal(result.ok, true)` 之后 TS 仍然不知道具体类型（返回的是联合类型），
 * 所以这里把收窄集中在一处，而不是在每个用例里重复写。
 */
export async function readOk(
  be: PowerShellWinfsBackend,
  ref: RootRef & { relative_path: string },
): Promise<{ sha256: string; size: number; canonical_relative_path: string | null; link_count: number; file_id: string }> {
  const result = await be.readFileGuarded(ref);
  assert.equal(result.ok, true, `读取应成功：${JSON.stringify(result)}`);
  if (isWinfsError(result) || result.ok !== true) throw new Error('unreachable');
  return {
    sha256: result.sha256,
    size: result.size,
    canonical_relative_path: result.canonical_relative_path,
    link_count: result.identity.link_count,
    file_id: result.identity.file_id,
  };
}
