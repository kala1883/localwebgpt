/**
 * 工具面的装配入口（LWB-017）。
 *
 * ## 为什么需要一个 `createToolSurface`，而不是让装配根自己拼
 *
 * 装配根要做三件事：注册操作、把能力开关的来源接对、把结果交给启动日志。
 * 前两件里各有一个**容易接错且看不出来**的地方：
 *
 *  - 能力开关的来源（`capability_flags`）如果被接成一个「恒为全开」的
 *    常量，一切照常工作 —— 只是门禁被绕过了。因此这里**没有默认值**：
 *    它是一个必需的注入项，装配根必须显式给出来源。
 *  - 工具清单与工具处理器的名字集合必须相等。这里断言这一点。
 *
 * ## 这一层不持有全局状态
 *
 * `deps` 是**显式入参**，不是模块级单例：单元测试因此可以给每个用例一份
 * 独立的 deps（独立的仓库、独立的能力开关、独立的时钟），
 * 而「生产装配」只是众多 deps 中的一种。
 */

import type { ToolName } from '@lwb/contracts';
import { IMPLEMENTED_TOOL_NAMES, LIMITS, isImplementedToolName } from '@lwb/contracts';
import { concurrencyGateFor } from '@lwb/limits';
import type { OperationRegistry } from '@lwb/ipc';

import { catalogFor } from './catalog.ts';
import type { CatalogEntry } from './catalog.ts';
import { TOOL_HANDLERS } from './handlers.ts';
import type { ToolHandlerDeps } from './handlers.ts';
import type { GuardDeps } from './guard.ts';
import { registerToolOperations } from './operations.ts';

export interface ToolSurfaceDeps extends ToolHandlerDeps {
  readonly operations: OperationRegistry;
}

export interface ToolSurface {
  /** 已注册的操作名（工具名 + 清单操作名）。供启动日志核对，**不含凭证**。 */
  readonly operations: readonly string[];
}

export function createToolSurface(deps: ToolSurfaceDeps): ToolSurface {
  // 名称集合相等：少一个处理器或多一个已实现的名字都拒绝装配。
  // 类型层面这件事已经由 `TOOL_HANDLERS` 的
  // `satisfies Record<ImplementedToolName, ToolHandler>` 钉住，
  // 但那条约束的失效方式是「有人把 satisfies 换成 as」——
  // 而这里问的是运行时同一个问题，代价是几次字符串比较。
  const handled: readonly ToolName[] = Object.keys(TOOL_HANDLERS) as readonly ToolName[];
  const missing = IMPLEMENTED_TOOL_NAMES.filter((name) => !handled.includes(name));
  // 用 `isImplementedToolName` 而不是 `IMPLEMENTED_TOOL_NAMES.includes`：
  // 后者在元组上会要求参数**已经**是那个联合，于是这条检查只能检查
  // 「已经正确的值仍然正确」—— 一个永远为假的判断。
  const extra = handled.filter((name) => !isImplementedToolName(name));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `工具处理器与已实现工具名不一致（缺 ${missing.join('、') || '无'}；多 ${extra.join('、') || '无'}）；拒绝装配。`,
    );
  }

  // 并发闸门**只建一个**，在这一层，然后传给全部工具。
  //
  // 让每个工具各自持有闸门是这里最容易犯的错，而且它不报错：
  // 每个工具都"有限额"，只是每一条限额各自独立 —— 于是全局上限
  // 变成了「上限 × 工具数」，而「本机同时只处理 4 次读取」这句话
  // 不再成立。这条注释存在的理由就是这个失效方式**在功能上无声**。
  const guard: GuardDeps = {
    repos: deps.repos,
    ...(deps.configuration === undefined ? {} : { configuration: deps.configuration }),
    concurrency: deps.concurrency ?? concurrencyGateFor(deps.effective_limits ?? LIMITS),
  };

  const result = registerToolOperations(deps.operations, deps, guard);
  return { operations: result.registered };
}

/**
 * 工具清单的只读视图，供控制台状态页与测试使用。
 *
 * 它要求一个 **channel** 参数而不是自己造一个：清单是按连接的
 * （见 `catalog.ts`），一个「不属于任何连接」的清单在物理上不存在。
 */
export function catalogView(
  context: Parameters<typeof catalogFor>[0],
  deps: ToolHandlerDeps,
): readonly CatalogEntry[] {
  return catalogFor(context, deps);
}

export { TOOL_HANDLERS, TOOL_POLICY_ACTIONS } from './handlers.ts';
export type { ToolHandler, ToolHandlerDeps, ToolLimits, ToolSurfaceFacts } from './handlers.ts';
export {
  NON_WORKSPACE_TOOL_NAMES,
  WORKSPACE_TOOL_NAMES,
  needsConcurrencyLease,
  withToolGuard,
} from './guard.ts';
export type { GuardDeps } from './guard.ts';
export { catalogFor, assertNoControlPlane } from './catalog.ts';
export type { CatalogEntry } from './catalog.ts';
export { registerToolOperations } from './operations.ts';
export { toModelPayload, describeForLocalAudit, isSafeForModel } from './errors.ts';
export {
  audienceOf,
  grantedWorkspaceIds,
  narrowCapabilities,
  resolveConnection,
  resolveWorkspaceAccess,
  usableWorkspaces,
} from './access.ts';
export type { ToolAccessDeps, WorkspaceAccess, WorkspaceAccessRequest } from './access.ts';

// 门禁与由它推出的开关：装配根需要它们，而它们与工具面是同一件事的两头。
export { BRIDGE_CAPABILITY_FLAGS, BRIDGE_GATES, capabilityFlagsFrom, capabilityFlagsWith, limitationsOf } from '../gates.ts';
export type { PlatformGates } from '../gates.ts';

export type { ImplementedToolName } from '@lwb/contracts';
