/**
 * 部署相关的路径事实（LWB-009）。
 *
 * 这是**唯一**读环境变量的地方。筛查逻辑本身（`screen.ts`）是纯函数，
 * 因此它不会随测试机器的 `USERPROFILE`、`TEMP` 变化而变化 ——
 * 那种「在我机器上通过」的测试等于没有测试。
 */

import os from 'node:os';
import path from 'node:path';

import { resolveStoreRoot, type ProtectedIdentityRef } from '@lwb/secure-store';

import type { RootProbe, WorkspaceEnvironment } from './registry.ts';

export interface ResolveWorkspaceEnvironmentOptions {
  /** 受保护存储根。默认由 `@lwb/secure-store` 的布局解析决定。 */
  readonly store_root?: string;
  /** 受保护对象的**真实身份**；由 `collectProtectedRefs` 探测得到。 */
  readonly protected_refs?: readonly ProtectedIdentityRef[];
  readonly policy_version?: number;
  /** 额外视为「过宽」的目录（例如挂载了别的数据盘的目录）。 */
  readonly extra_broad_probes?: readonly string[];
}

export function resolveWorkspaceEnvironment(
  options: ResolveWorkspaceEnvironmentOptions = {},
): WorkspaceEnvironment {
  return {
    store_root: options.store_root ?? resolveStoreRoot(),
    home_directory: os.homedir(),
    // `assessBroadDirectory` 内部已经会读 USERPROFILE / LOCALAPPDATA /
    // APPDATA / ProgramData / SystemRoot / ProgramFiles / TEMP 以及当前盘根
    // （`broadDirectoryProbes()`）。这里只放**额外**的探测点 ——
    // 把环境默认值再搬一遍只会让人以为移走这一行就会放宽判定。
    extra_broad_probes: options.extra_broad_probes ?? [],
    protected_refs: options.protected_refs ?? [],
    policy_version: options.policy_version ?? 1,
  };
}

/**
 * 探测受保护对象的身份，供 `findProtectedIdentityMatch` 使用。
 *
 * 为什么必须探测而不是写死路径：受保护根本身也可能被 Junction 或
 * 8.3 短名指向，只有身份能唯一确定它（I05）。探测失败时**不**返回空数组
 * —— 那会让身份判定静默失效。调用方应停止启动。
 */
export async function collectProtectedRefs(input: {
  readonly probe: RootProbe;
  readonly paths: readonly { readonly path: string; readonly label: string }[];
}): Promise<ProtectedIdentityRef[]> {
  const refs: ProtectedIdentityRef[] = [];
  for (const target of input.paths) {
    const probed = await input.probe.statVolume({ path: target.path });
    if (probed.ok === false) {
      throw new Error(
        `无法探测受保护路径「${target.label}」的身份（${probed.code}）：${probed.message}。` +
          '身份判定不可用时必须停止启动，而不是当作没有受保护对象。',
      );
    }
    refs.push({ volume_id: probed.volume_id, file_id: probed.file_id, label: target.label });
  }
  return refs;
}

/** 受保护存储的各个目录，作为身份探测的默认目标集。 */
export function protectedStorePaths(layout: {
  readonly root: string;
  readonly credentials: string;
  readonly db: string;
  readonly objects: string;
  readonly logs: string;
  readonly diagnostics: string;
  readonly config: string;
}): { path: string; label: string }[] {
  return [
    { path: layout.root, label: '受保护存储根' },
    { path: layout.credentials, label: '凭证目录' },
    { path: layout.db, label: '状态库目录' },
    { path: layout.objects, label: '快照对象目录' },
    { path: layout.logs, label: '日志目录' },
    { path: layout.diagnostics, label: '诊断目录' },
    { path: layout.config, label: '配置目录' },
  ];
}

/** 规范化一个用于比较的绝对路径。仅用于展示与日志。 */
export function displayRoot(absolutePath: string): string {
  return path.resolve(absolutePath);
}
