/**
 * 工具清单：**此刻有哪些工具真的可用**（LWB-017）。
 *
 * ## 为什么清单要由 daemon 决定，而不是适配器写死
 *
 * 适配器手上有全部 12 个工具的定义（`@lwb/contracts` 的 `TOOLS`），
 * 它完全可以自己挂出去。但「这个工具此刻可用吗」是**本机状态**：
 * 它取决于门禁、取决于这条连接被授权了什么。适配器不知道这些，
 * 猜一个就等于在工具面上宣称一个未经验证的能力。
 *
 * 于是 `tools.catalog` 是一条 IPC 操作：适配器问 daemon「现在能挂哪些」，
 * 得到的名字集合与本地 `TOOLS` 取交集之后才出现在 `tools/list` 里。
 *
 * ## 「可用」的判据
 *
 * 三类，各自问的是能不能**真的做成那件事**：
 *
 *  - `bridge_status` / `workspace_list`：**连接级**，不读任何工作区内容。
 *    只要连接在册且启用就可用 —— 尤其是 `bridge_status`：它是回答
 *    「为什么我什么都做不了」的那一个，把它自己也关掉会得到一个
 *    说不上话的诊断工具。
 *  - 读取三件（`file_list` / `file_read` / `text_search`）：需要
 *    `read_enabled`，**并且**至少有一个可用工作区开着它。空集不算可用：
 *    没有任何工作区可读时挂出一个读取工具，模型只会拿到一串
 *    `WORKSPACE_NOT_GRANTED`。
 *  - Git 两件：同上，换 `git_enabled`。
 *  - 提议两件（`change_prepare` / `change_get`）：`proposal_enabled` 与
 *    `read_enabled`，规则来源是它们在 `ACTION_SPECS` 里那一行的 `flag`。
 *    `change_list` 是连接级（它只读本连接自己的状态库行）。
 *
 * 判据里**没有**「连接被授予了 read 能力」这一项：那是另一层
 * （`grants` 逐工作区），`decide()` 每次调用都会检查。清单说的是
 * 「本机现在允许这个动作吗」，而授权不足的工作区会被逐条拒绝 ——
 * 两件事分开之后，清单不会因为某个工作区的授权变化而抖动。
 *
 * **清单与判定不能给出两个答案**：`AVAILABILITY` 里每一行的 `flag`
 * 必须与 `ACTION_SPECS` 里同一个动作的 `flag` 相同。不同的话，工具会
 * 出现在 `tools/list` 里，而每一次调用都被判定拒绝在 `CAPABILITY_DISABLED`
 * 上 —— 一个「挂出来但不能用」的工具比一个不挂出来的工具更难排查。
 *
 * 生产装配下门禁全关（`gates.ts`），因此这个清单**恰好是三条**：
 * `bridge_status`、`workspace_list`、`change_list`。这不是降级，是事实：
 * 平台未验证之前，任何会读用户工作区的工具都不该出现在模型面前；
 * 而这三条分别回答「本机现在什么状态」「我能看到哪些工作区」
 * 「我提过的提案怎么样了」—— 都只读状态库，一个用户字节都不碰。
 */

import { TOOL_NAMES, isControlPlaneName, isImplementedToolName, isToolName } from '@lwb/contracts';
import type { CapabilityFlags, ImplementedToolName, ToolName } from '@lwb/contracts';

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
 * 却忘了给它一条规则，是编译错误。规则只有两种，因为它们问的正是
 * 「要不要看工作区」这一个问题。
 */
type AvailabilityRule =
  | { readonly kind: 'connection' }
  | { readonly kind: 'workspace_flag'; readonly flag: keyof CapabilityFlags };

const AVAILABILITY: Readonly<Record<ImplementedToolName, AvailabilityRule>> = {
  // 不读工作区内容：连接在册且启用即可用。
  bridge_status: { kind: 'connection' },
  workspace_list: { kind: 'connection' },
  file_list: { kind: 'workspace_flag', flag: 'read_enabled' },
  file_read: { kind: 'workspace_flag', flag: 'read_enabled' },
  text_search: { kind: 'workspace_flag', flag: 'read_enabled' },
  git_status: { kind: 'workspace_flag', flag: 'git_enabled' },
  git_diff: { kind: 'workspace_flag', flag: 'git_enabled' },
  // 提议：会经受控句柄重读目标文件的基线，因此与读取同类，只是换一个开关。
  change_prepare: { kind: 'workspace_flag', flag: 'proposal_enabled' },
  // 它读的是快照库（受保护根之内，不是用户工作区），但判定的动作是
  // `snapshot_read`，而那一行的 `flag` 就是 `read_enabled`。
  // 清单与判定**必须是同一个答案**：清单说可用、判定说开关关着，
  // 每一条调用都会拿到 `CAPABILITY_DISABLED`，而模型会以为是自己的用法有问题。
  change_get: { kind: 'workspace_flag', flag: 'read_enabled' },
  // 不读任何工作区内容，只读本连接自己的状态库行 —— 与 `bridge_status`
  // 同类，因此是连接级。尤其：它必须在读取面关闭时**仍然可用**，
  // 否则「我刚提交的提案怎么样了」这条追问在门禁未过时问不出来，
  // 而那正是最需要它的时刻。
  change_list: { kind: 'connection' },
  // 写入（LWB-032）。开关是 `direct_write_enabled`，与
  // `ACTION_SPECS.change_apply.flag` 是同一个 —— 这两处**必须**一致：
  // 不一致时工具会挂出来而每次调用都被判成 `CAPABILITY_DISABLED`，
  // 而模型读到的是一句「你的用法有问题」。
  //
  // 生产装配下它是 `false`（`gates.ts` 全关），因此今天的答案是
  // `DIRECT_WRITE_ENABLED_OFF`：模型看不到应用工具。这是事实，不是降级。
  change_apply: { kind: 'workspace_flag', flag: 'direct_write_enabled' },
  // 撤销**提议**：与 `change_prepare` 同一档（`proposal_enabled`），
  // 理由写在 `handlers.ts` 的 `TOOL_POLICY_ACTIONS` 那一行。
  change_revert_prepare: { kind: 'workspace_flag', flag: 'proposal_enabled' },
};

export function catalogFor(context: RequestContext, deps: ToolHandlerDeps): readonly CatalogEntry[] {
  const connection = resolveConnection(context, deps);
  const flags = deps.capability_flags;

  // 「至少有一个可用工作区开着它」只算一次，而不是每个工具各遍历一遍：
  // 同一批事实算两遍就有两次机会算出不同结果。
  const usable = usableWorkspaces(deps.repos, connection.id);

  const anyWorkspaceHas = (flag: keyof CapabilityFlags): boolean =>
    usable.some((workspace) => flags(workspace)[flag]);

  return TOOL_NAMES.map<CatalogEntry>((name) => {
    if (!isImplementedToolName(name)) {
      // LWB-032 之后 `TOOL_NAMES` 的 12 个工具**全部**有实现，因此这条
      // 分支今天到不了。留着它是因为它守的是一件会再发生的事：`TOOL_NAMES`
      // 是契约里那份「工具全集」，将来加第十三个名字时，它会先以
      // `NOT_IMPLEMENTED` 出现在清单里 —— 如实列成不可用比让它凭空消失
      // 更好排查，而且「不可用」不会让模型以为自己能用。
      return { name, available: false, reason: 'NOT_IMPLEMENTED' };
    }

    const rule = AVAILABILITY[name];
    if (rule.kind === 'connection') return { name, available: true, reason: null };
    if (!anyWorkspaceHas(rule.flag)) {
      return { name, available: false, reason: `${rule.flag.toUpperCase()}_OFF` };
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
