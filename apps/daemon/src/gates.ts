/**
 * Platform verification is reported for diagnostics, not used as a hidden
 * global feature switch. The authenticated connection and each workspace's
 * locally configured grant determine which operations may reach a root.
 */

import type { CapabilityFlags } from '@lwb/contracts';
import type { PauseStatus } from '@lwb/executor';
import type { WorkspaceRecord } from '@lwb/persistence';

export interface PlatformGates {
  readonly g0_platform_verified: boolean;
  readonly native_guard_verified: boolean;
  readonly compatibility_section3_passed: boolean;
  readonly g4_concurrency_fault_passed: boolean;
}

/** Current external sign-off observations; false is informational, not blocking. */
export const BRIDGE_GATES: PlatformGates = {
  g0_platform_verified: false,
  native_guard_verified: false,
  compatibility_section3_passed: false,
  g4_concurrency_fault_passed: false,
};

/** Global operation support; workspace grants still authorize every root/tool pair. */
export function capabilityFlagsFrom(_verification?: PlatformGates): CapabilityFlags {
  return {
    read_enabled: true,
    git_enabled: true,
    proposal_enabled: true,
    direct_write_enabled: true,
    recovery_required: false,
  };
}

export const BRIDGE_CAPABILITY_FLAGS: CapabilityFlags = capabilityFlagsFrom();

/** Add the per-workspace recovery stop to the supported global operations. */
export function capabilityFlagsWith(
  recoveryRequired: (workspace: WorkspaceRecord) => boolean,
): (workspace: WorkspaceRecord) => CapabilityFlags;
/** Backward-compatible signature for historical evidence scripts; verification is ignored. */
export function capabilityFlagsWith(
  _verification: PlatformGates,
  recoveryRequired: (workspace: WorkspaceRecord) => boolean,
): (workspace: WorkspaceRecord) => CapabilityFlags;
export function capabilityFlagsWith(
  first: PlatformGates | ((workspace: WorkspaceRecord) => boolean),
  second?: (workspace: WorkspaceRecord) => boolean,
): (workspace: WorkspaceRecord) => CapabilityFlags {
  const recoveryRequired = typeof first === 'function' ? first : (second ?? (() => false));
  const base = capabilityFlagsFrom();
  return (workspace) => ({ ...base, recovery_required: recoveryRequired(workspace) });
}

/** User-visible status, derived from current capability and pause facts. */
export function limitationsOf(
  flags: CapabilityFlags,
  verification: PlatformGates,
  pause: PauseStatus | null = null,
): readonly string[] {
  const out: string[] = [];
  if (pause?.paused === true) {
    out.push('本地服务已暂停：新的读取与应用会被阻断，直到本地操作者恢复服务。');
    if (pause.stopping.length > 0) out.push(`仍有 ${String(pause.stopping.length)} 个写入正在安全停止。`);
    if (pause.unrevoked_change_sets.length > 0) out.push(`仍有 ${String(pause.unrevoked_change_sets.length)} 个待处理修改集未作废。`);
  }
  if (pause !== null && pause.recovery_operations.length > 0) {
    out.push(`有 ${String(pause.recovery_operations.length)} 个写入操作待本地恢复核验。`);
  }
  if (!flags.read_enabled) out.push('读取工具当前不可用。');
  if (!flags.git_enabled) out.push('Git 只读工具当前不可用。');
  if (!flags.proposal_enabled) out.push('修改准备工具当前不可用。');
  if (!flags.direct_write_enabled) out.push('文件写入工具当前不可用。');
  if (!verification.g0_platform_verified || !verification.native_guard_verified ||
      !verification.compatibility_section3_passed || !verification.g4_concurrency_fault_passed) {
    out.push('部分外部验收签署尚未完成；只作状态提示，不会关闭本地已授权工作区的工具。');
  }
  out.push('仅访问本地操作者在控制台显式授权的工作区；不会扫描其它目录。');
  out.push('模型可见路径均为工作区内相对路径，不返回本机绝对路径。');
  return out;
}
