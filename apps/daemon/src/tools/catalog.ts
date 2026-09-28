/**
 * 工具清单：**此刻有哪些工具真的可用**（LWB-017）。
 *
 * ## 为什么清单要由 daemon 决定，而不是适配器写死
 *
 * 适配器手上有全部 14 个工具的定义（`@lwb/contracts` 的 `TOOLS`），
 * 它完全可以自己挂出去。但「这个工具此刻可用吗」是**本机状态**：
 * 它取决于连接启停、工作区 grant 与恢复状态。适配器不知道这些，
 * 猜一个就等于在工具面上宣称一个未经授权的能力。
 *
 * 于是 `tools.catalog` 是一条 IPC 操作：适配器问 daemon「现在能挂哪些」，
 * 得到的名字集合与本地 `TOOLS` 取交集之后才出现在 `tools/list` 里。
 *
 * 工具清单仅包含本连接至少有一个已启用 workspace 满足该工具全部 grant 前置条件的工具；
 * 多个 grant 必须落在同一 workspace。每次调用时策略层再针对指定工作区重新检查写入授权。
 * 平台验收和实现 flags 不参与授权。
 */

import { TOOL_NAMES, isControlPlaneName, isImplementedToolName, isToolName } from '@lwb/contracts';
import type { CapabilityName, ImplementedToolName, ToolName } from '@lwb/contracts';

import type { ToolHandlerDeps } from './handlers.ts';
import { resolveConnection, usableWorkspaces } from './access.ts';
import type { RequestContext } from '@lwb/ipc';

/** 一个工具的可用性。`reason` 只在不可用时给出，供本地排障。 */
export interface CatalogEntry {
  readonly name: ToolName;
  readonly available: boolean;
  readonly reason: string | null;
}

/**
 * 每个**已实现**的工具的可用性规则。
 *
 * 写成 `Record<ImplementedToolName, …>` 而不是一张稀疏表：实现一个工具
 * 却忘了给它一条规则，是编译错误。
 */
type AvailabilityRule =
  | { readonly kind: 'connection' }
  | { readonly kind: 'workspace_grant'; readonly capabilities: readonly CapabilityName[] };

const AVAILABILITY: Readonly<Record<ImplementedToolName, AvailabilityRule>> = {
  // 不读工作区内容：连接在册且启用即可用。
  bridge_status: { kind: 'connection' },
  workspace_list: { kind: 'connection' },
  file_list: { kind: 'workspace_grant', capabilities: ['list'] },
  file_read: { kind: 'workspace_grant', capabilities: ['read'] },
  text_search: { kind: 'workspace_grant', capabilities: ['search'] },
  git_status: { kind: 'workspace_grant', capabilities: ['git_read'] },
  git_diff: { kind: 'workspace_grant', capabilities: ['git_read'] },
  change_prepare: { kind: 'workspace_grant', capabilities: ['propose'] },
  file_create: { kind: 'workspace_grant', capabilities: ['propose'] },
  // Editing needs both permission to change this root and permission to read the
  // baseline that supplies its signed file hash/read ticket.
  file_edit: { kind: 'workspace_grant', capabilities: ['read', 'propose'] },
  file_delete: { kind: 'workspace_grant', capabilities: ['propose'] },
  // 它读的是快照库（受保护根之内，不是用户工作区），但仍需要该工作区的 read grant。
  change_get: { kind: 'workspace_grant', capabilities: ['read'] },
  // 不读任何工作区内容，只读本连接自己的状态库行 —— 与 `bridge_status`
  // 同类，因此是连接级。
  change_list: { kind: 'connection' },
  change_apply: { kind: 'workspace_grant', capabilities: ['propose'] },
  change_revert_prepare: { kind: 'workspace_grant', capabilities: ['propose'] },
};

export function catalogFor(context: RequestContext, deps: ToolHandlerDeps): readonly CatalogEntry[] {
  const connection = resolveConnection(context, deps);
  const usable = usableWorkspaces(deps.repos, connection.id);

  const anyWorkspaceHas = (capabilities: readonly CapabilityName[]): boolean =>
    usable.some((workspace) => {
      if (!workspace.enabled) return false;
      if (capabilities.includes('propose') && workspace.mode !== 'read_propose_apply_with_local_approval') return false;
      const grant = deps.repos.grants.find(connection.id, workspace.id);
      return grant?.enabled === true && capabilities.every((capability) => grant.capabilities.includes(capability));
    });

  return TOOL_NAMES.map<CatalogEntry>((name) => {
    if (!isImplementedToolName(name)) {
      // LWB-032 之后 `TOOL_NAMES` 的 14 个工具**全部**有实现，因此这条
      // 分支今天到不了。留着它是因为它守的是一件会再发生的事：`TOOL_NAMES`
      // 是契约里那份「工具全集」，将来加第十三个名字时，它会先以
      // `NOT_IMPLEMENTED` 出现在清单里 —— 如实列成不可用比让它凭空消失
      // 更好排查，而且「不可用」不会让模型以为自己能用。
      return { name, available: false, reason: 'NOT_IMPLEMENTED' };
    }

    const rule = AVAILABILITY[name];
    if (rule.kind === 'connection') return { name, available: true, reason: null };
    if (!anyWorkspaceHas(rule.capabilities)) {
      return { name, available: false, reason: 'WORKSPACE_TOOL_NOT_GRANTED' };
    }
    return { name, available: true, reason: null };
  });
}

/**
 * 装配期的自检：清单里**永远**不能出现控制面方法名。
 *
 * 这条检查看起来多余（`catalogFor` 遍历的是 `TOOL_NAMES`，而控制面方法
 * 不在其中），但它的价值不在今天：把清单的来源从 `TOOL_NAMES` 换成
 * 别的什么（一张更"灵活"的表、一次 IPC 往返的返回值）时，
 * 这条检查会立刻失败。控制面方法出现在 `tools/list` 里是本任务的第一条
 * 验收标准，因此它值得有一条**不依赖来源**的断言。
 */
export function assertNoControlPlane(entries: readonly CatalogEntry[]): void {
  for (const entry of entries) {
    if (isControlPlaneName(entry.name)) {
      throw new Error(`工具清单里出现了控制面方法 ${entry.name}；拒绝装配。`);
    }
    if (!isToolName(entry.name)) {
      throw new Error(`工具清单里出现了未知名字 ${entry.name}；拒绝装配。`);
    }
  }
}
