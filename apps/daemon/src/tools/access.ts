/**
 * 工具面的授权解析（LWB-017 步骤 2）。
 *
 * 本文件回答一个问题：**一次工具调用，凭什么能碰它想碰的那个工作区。**
 * 答案链条是固定的四段，缺一段就拒绝：
 *
 * ```
 * IPC 凭据（audience 派生密钥，握手时验过）
 *   → 连接记录（本机注册、已启用、principal_kind 与通道相符）
 *     → 授权行 grants（连接 × 工作区，逐工作区一条）
 *       → 策略判定 decide()（能力 / 代次 / 文件规则 / 批准，五层全跑）
 *         → 工作区登记表 authorizeAccess()（根身份每次重新探测）
 * ```
 *
 * ## 身份来自通道，不来自参数（ADR-003 §4）
 *
 * `connection_id` 只从 `RequestContext` 取，而它是**握手时**由服务端
 * 记下的（`packages/ipc/src/server.ts` 的 `#handleRequest` 用
 * `this.#connectionId`，那个值在 `#handleHandshake` 里赋值）。
 * 工具入参里没有 `connection_id` / `user_id` / `session_id` / `principal_id`
 * 这些字段，而且各工具的输入 schema 是 `z.strictObject`
 * （`packages/contracts/src/tools.ts`），**多给一个字段就会被拒绝**。
 * 因此「模型不能声称自己是另一个连接」不是一条检查的结果，是**无从传入**。
 *
 * ## 为什么先查授权行、后查工作区行
 *
 * 顺序是刻意的，且理由是**信息泄露**而不是性能：如果先查工作区表，
 * 那么对同一个不存在的 workspace_id，有授权的连接会拿到 `NOT_FOUND`、
 * 没授权的连接会拿到 `WORKSPACE_NOT_GRANTED` —— 两个不同的回答就是一个
 * 「本机是否存在这个 id」的预言机。先查授权行，未授权的连接在读到工作区表
 * **之前**就被拒，两种情形回答完全一样。
 *
 * ## 为什么授权视图按 (连接 × 工作区) 收窄
 *
 * `ConnectionView.granted_capabilities` 取的是**这一条授权行**的能力，
 * 而不是该连接所有授权行的并集。这不是"藏信息"，是取事实：本次动作绑定在
 * 一个工作区上，关于**那个工作区**的事实就是那一条授权行。
 *
 * 反过来的写法会制造一个真实的越权：连接 C 在 ws-A 上有 `read`、在 ws-B 上有
 * `git_read`，并集是 `['read','git_read']`，于是 C 用 ws-A 就能跑 `git_status`。
 * 逐工作区收窄让这件事在结构上不成立 —— 判定拿到的能力集合里根本
 * 不存在另一条授权行的内容。
 *
 * 同理，`granted_workspace_ids` 只放**本次要访问的这一个** id。
 * 「列工作区」（`workspace_list`）是另一种动作：它枚举的是授权行本身，
 * 因此那里用的是 `grantedWorkspaceIds()`（一个 id 列表），
 * 而**不是**一个 `ConnectionView` —— 并集形态的 `ConnectionView`
 * 在本进程里根本不存在，也就没有机会被误传给 `decide()`。
 *
 * ## 能力开关是**注入**的
 *
 * `capability_flags` 由装配根给出，本层不自造、也不从请求参数或工作区行推导。
 * 理由见 `apps/daemon/src/gates.ts`：在 G0 与 §3 通过之前，
 * 四个开关一律为关，而这是**门禁**决定，不是某个工作区的属性。
 */

import { BridgeError, CAPABILITY_NAMES } from '@lwb/contracts';
import type { CapabilityFlags, CapabilityName } from '@lwb/contracts';
import { decide, PolicyDeniedError } from '@lwb/policy';
import type {
  ApprovalView,
  ConnectionAudience,
  ConnectionView,
  PolicyAction,
  PolicyDecision,
  WorkspaceView,
} from '@lwb/policy';
import type { FileRule } from '@lwb/policy';
import { readScopeOf } from '@lwb/files';
import type { ReadScope } from '@lwb/files';
import type { ConnectionRecord, GrantRecord, Repositories, WorkspaceRecord } from '@lwb/persistence';
import type { Audience, RequestContext } from '@lwb/ipc';
import type { AuthorizedRoot, WorkspaceRegistry } from '@lwb/workspaces';
import type { EgressBudget, EgressBudgetStore } from '@lwb/egress';

// ---------------------------------------------------------------------------
// 依赖
// ---------------------------------------------------------------------------

export interface ToolAccessDeps {
  readonly repos: Repositories;
  readonly registry: WorkspaceRegistry;
  /** 每连接一份出站预算。**不按工作区记**，见 `packages/egress/src/budget.ts`。 */
  readonly budgets: EgressBudgetStore;
  /**
   * 工作区能力开关的来源。
   *
   * 是函数而不是常量，因为 `recovery_required` 是**逐工作区**的事实；
   * 其余四项由门禁决定，与工作区无关，实现里叠加即可。
   */
  readonly capability_flags: (workspace: WorkspaceRecord) => CapabilityFlags;
  /** 本地时钟（epoch ms）。判定需要它比较批准有效期；本层不读时钟。 */
  readonly now: () => number;
  /**
   * 本次判定使用的文件规则表。
   *
   * 省略即用 `@lwb/policy` 的默认表（无操作者豁免，**更严**方向）。
   * 操作者覆盖规则目前还没有状态存储（见 `docs/PROGRESS.md` 的偏差记录），
   * 因此生产装配根不传它。
   */
  readonly rules?: readonly FileRule[];
}

const KNOWN_CAPABILITIES: ReadonlySet<string> = new Set<string>(CAPABILITY_NAMES);

/**
 * 授权行里的能力字符串 → 契约能力名。
 *
 * 认不出的名字被**丢掉**，而丢掉的方向是拒绝：本次动作需要的能力不在
 * 结果里，`decide()` 就会报 `CAPABILITY_NOT_GRANTED`。
 * 反过来（认不出就当万能）会让一个拼错的名字变成一张通行证。
 */
export function narrowCapabilities(raw: readonly string[]): readonly CapabilityName[] {
  return raw.filter((name): name is CapabilityName => KNOWN_CAPABILITIES.has(name));
}

/**
 * 通道 → 策略层的出站面。
 *
 * 判据是**本次请求走的是哪条通道**（握手时验过的 audience），
 * 不是连接记录里写着什么。`CONTROL_CAPABILITY_ON_MODEL_SURFACE`
 * 要拦的是「模型够得着这份凭据」，而那取决于通道。
 */
export function audienceOf(channel: Audience): ConnectionAudience {
  return channel === 'mcp-adapter' ? 'mcp_adapter' : 'local_console';
}

/**
 * 通道与连接记录的类型必须相符。
 *
 * 为什么值得单独一条：`audience` 决定「控制面专属能力」是否算越界，
 * 而 `principal_kind` 是本机配置。两者不符说明有一条配置路径
 * 把控制台身份挂到了模型通道上（或反过来）。这种配置错误在功能上
 * 完全看不出来 —— 一切照常工作，只是「哪些能力绝不能给模型」这条
 * 清单不再适用于那份凭据。因此宁可拒绝。
 */
const REQUIRED_PRINCIPAL: Readonly<Record<Audience, string>> = {
  'mcp-adapter': 'model_surface',
  console: 'console',
};

// ---------------------------------------------------------------------------
// 连接级解析
// ---------------------------------------------------------------------------

/**
 * 解析连接身份并确认它可用。
 *
 * 停用在这里就拒绝（`CONNECTION_DISABLED`），而不是留给策略层：
 * 一个被停用的连接不该有任何工具可用，`bridge_status` 也不例外 ——
 * 「我为什么什么都做不了」的答案由本地控制台给出，不由被停用的凭据给出。
 */
export function resolveConnection(context: RequestContext, deps: ToolAccessDeps): ConnectionRecord {
  const record = deps.repos.connections.findById(context.connection_id);
  if (record === null) {
    // 握手已经查过 `isRegisteredConnection`，走到这里说明连接在两次调用之间
    // 被删除。回答与「不存在」相同，不额外说明。
    throw new BridgeError('NOT_AUTHORIZED', '该连接标识未在本机注册。');
  }

  if (record.principal_kind !== REQUIRED_PRINCIPAL[context.audience]) {
    throw new BridgeError('NOT_AUTHORIZED', '该连接的登记类型与本次调用所在的通道不相符；已拒绝。', {
      reason: 'PRINCIPAL_KIND_MISMATCH',
    });
  }

  if (!record.enabled) {
    throw new BridgeError('CONNECTION_DISABLED', '该连接已被本地操作者停用。');
  }

  return record;
}

/** 本连接被授权的工作区 id（**由授权行得出，不由工作区表得出结论**）。 */
export function grantedWorkspaceIds(repos: Repositories, connectionId: string): readonly string[] {
  return repos.grants
    .listByConnection(connectionId)
    .filter((grant) => grant.enabled)
    .map((grant) => grant.workspace_id);
}

/**
 * 本连接现在**可用**的工作区行：有授权、行存在、未被移除。
 *
 * 「可用」在这里只到**授权**为止，不含任何磁盘事实 —— 根还在不在、
 * 盘符还在不在，由真正去读的那一次报出来（`workspaceList` 的注释里
 * 写了为什么不在清单里预先声明可达性）。
 *
 * 两处调用（连接级能力开关、工具清单）问的是同一个问题，因此由这**一处**
 * 回答：同一批事实算两遍，就有两次机会算出不同结果，而这两处
 * 恰好一个是「有什么工具」、一个是「工具说自己能做什么」。
 */
export function usableWorkspaces(repos: Repositories, connectionId: string): readonly WorkspaceRecord[] {
  const out: WorkspaceRecord[] = [];
  for (const id of grantedWorkspaceIds(repos, connectionId)) {
    const workspace = repos.workspaces.findById(id);
    // 授权行已被过滤过一次（`grantedWorkspaceIds` 只返回 enabled 的），
    // 这里再排掉「已移除」：软删除的行仍在表里，而对调用方来说
    // 它与不存在没有区别。
    if (workspace === null || workspace.removed_at !== null) continue;
    out.push(workspace);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 工作区级解析
// ---------------------------------------------------------------------------

export interface WorkspaceAccessRequest {
  readonly workspace_id: string;
  readonly action: PolicyAction;
  /** 工作区**相对**路径；`''` 表示根。绝对路径在本层不存在。 */
  readonly path: string;
  /**
   * 本次动作所依据的**票据代次**（LWB-025）。
   *
   * 只有提议/写入类动作需要它：`ACTION_SPECS` 里那些
   * `requires_ticket: true` 的动作在没有它时会被 `decide()` 判成
   * `TICKET_GENERATION_MISSING`（错误码 `WORKSPACE_GENERATION_CHANGED`）。
   *
   * ## 它**只能**来自已验签的读取票据
   *
   * 类型上它是一个普通的 `{generation, policy_version}`，因此这里能给的
   * 保证只有一条，而它写在类型之外：**调用方不许从请求参数里取它**。
   * 唯一合法的来源是 `ReadTicketAuthority.verifyReadTicket(...)` 的返回值
   * （签名已验、有效期已过、绑定项已经比对过）。ADR-003 §4 点名的反模式
   * 正是「把调用方能填的字段当成授权依据」，而一个代次字段恰好能那样用：
   * 伪造一个等于当前代次的数字就能让 `decide()` 的代次检查形同虚设。
   *
   * 省略即 `{generation: null, policy_version: null}` —— 那是**读取类**
   * 动作的诚实说法，对需要票据的动作则是一次拒绝（fail-closed）。
   */
  readonly presented?: { readonly generation: number; readonly policy_version: number | null };
  /**
   * 本次动作所依据的**本地批准**（LWB-032）。
   *
   * `ACTION_SPECS` 里 `requires_approval: true` 的动作（今天只有
   * `change_apply`）在拿到 `null` 时会被 `decide()` 判成
   * `APPROVAL_REQUIRED` —— 那对「模型自己调应用工具」是**唯一正确**的答案。
   *
   * ## 它只能来自 `evaluateApplyGate`
   *
   * 与 `presented` 同一条规矩，而且更要紧：这里的三个字段（批准状态、
   * 被批准的摘要、本次要应用的摘要）如果由调用方自己从请求参数拼出来，
   * 那么「批准」这件事就变成了一段可以伪造的输入 —— 而 `approved: true`
   * 之类的参数永远不能作为授权证据，是本工程的第一条规矩（ADR-003 §4）。
   *
   * 唯一的合法来源是 `@lwb/approvals` 的 `evaluateApplyGate`：它**重新加载**
   * 修改集、**重算**摘要、现读工作区与连接、当场判批准的有效期，然后把那份
   * 判定作为 `ApprovalView` 交出来。工具处理器做的只是把它递过来。
   *
   * 省略即 `null`：那是「本次动作不声称有任何批准」的诚实说法，
   * 而它导致的是拒绝（fail-closed），不是放行。
   */
  readonly approval?: ApprovalView | null;
}

export interface WorkspaceAccess {
  readonly connection: ConnectionRecord;
  readonly workspace: WorkspaceRecord;
  readonly grant: GrantRecord;
  readonly authorized: AuthorizedRoot;
  readonly scope: ReadScope;
  readonly decision: PolicyDecision;
  readonly budget: EgressBudget;
}

/**
 * 把「一次工具调用」解析成一份可用的授权快照，或抛出拒绝。
 *
 * 抛出的 `BridgeError` / `PolicyDeniedError` 由调用方（工具处理器）
 * 统一翻译成模型可见载荷 —— 见 `errors.ts` 与 `operations.ts`。
 */
export async function resolveWorkspaceAccess(
  request: WorkspaceAccessRequest,
  context: RequestContext,
  deps: ToolAccessDeps,
): Promise<WorkspaceAccess> {
  const connection = resolveConnection(context, deps);

  // 第一步：授权行。刻意排在读工作区行**之前**，理由见文件头。
  const grant = deps.repos.grants.find(connection.id, request.workspace_id);
  if (grant === null || !grant.enabled) {
    throw new BridgeError('WORKSPACE_NOT_GRANTED', '当前连接未获准访问该工作区。');
  }

  // 第二步：工作区行。
  const workspace = deps.repos.workspaces.findById(request.workspace_id);
  if (workspace === null) {
    throw new BridgeError('NOT_FOUND', '该工作区不存在。');
  }
  if (workspace.removed_at !== null) {
    // 已移除的工作区与「未授权」回答相同：移除是软删除，历史记录仍指向它，
    // 但对调用方来说它和不存在没有区别，而 `PAUSED`（策略层对 paused 的回答）
    // 会把它说成「暂停」—— 那是不准确的。
    throw new BridgeError('WORKSPACE_NOT_GRANTED', '该工作区已被本地操作者移除。');
  }

  // 第三步：策略判定。纯函数，不碰磁盘。
  const decision = decide({
    connection: connectionViewFor(connection, grant, context.audience),
    workspace: workspaceViewOf(workspace, deps),
    // 读取类工具不携带票据：`ACTION_SPECS` 里它们的 `requires_ticket` 全为
    // false，因此 `null` 是「本次动作不需要票据」的诚实说法。
    // 提议类动作（`change_prepare`）由调用方给出 `presented`，来源见
    // `WorkspaceAccessRequest.presented` 的说明：只许来自已验签的票据。
    presented: request.presented ?? { generation: null, policy_version: null },
    action: { action: request.action, path: request.path, approval: request.approval ?? null },
    now: deps.now(),
    ...(deps.rules === undefined ? {} : { rules: deps.rules }),
  });
  if (!decision.allow) throw new PolicyDeniedError(decision);

  // 第四步：取根。这是唯一通道，且它每次都重新探测根的真实身份；
  // 带上判定所依据的代次，中途变化即拒绝（WORKSPACE_GENERATION_CHANGED）。
  const authorized = await deps.registry.authorizeAccess(workspace.id, {
    generation: workspace.generation,
  });

  return {
    connection,
    workspace,
    grant,
    authorized,
    scope: readScopeOf(authorized),
    decision,
    budget: deps.budgets.forConnection(connection.id),
  };
}

/**
 * 本次动作的连接视图。**按 (连接 × 工作区) 收窄**，见文件头。
 */
function connectionViewFor(
  connection: ConnectionRecord,
  grant: GrantRecord,
  channel: Audience,
): ConnectionView {
  return {
    connection_id: connection.id,
    // 这里恒为 true：`resolveConnection` 已经拒绝过停用的连接。
    // 保留这个字段并如实填，是为了让 `decide()` 的输入是**完整**的事实，
    // 而不是一个「反正前面查过了」的省略 —— 省略会让这一层在将来
    // 被人单独调用时悄悄失去一条检查。
    enabled: connection.enabled,
    granted_capabilities: narrowCapabilities(grant.capabilities),
    audience: audienceOf(channel),
    granted_workspace_ids: [grant.workspace_id],
  };
}

/**
 * 一条工作区记录 → 判定层的工作区视图。
 *
 * ## 为什么它被导出，以及为什么依赖被收窄成一个字段
 *
 * 控制台复核修改集（`../control/changes.ts`）要用**同一份**视图去判定，
 * 而「同一份」在这里不是风格问题：两份各自演化的投影会在某一天对同一个
 * 记录给出不同的 `paused` 或不同的能力开关，于是「模型看到这个工作区是
 * 暂停的、控制台看到它是运行的」变成可能 —— 而那正是 LWB-034 花力气
 * 消除的那类分裂。
 *
 * 依赖从整个 `ToolAccessDeps` 收窄成 `capability_flags` 一个函数：
 * 本函数**只**用它。原来的签名让「这个投影需要 registry、budgets、now」
 * 读起来像真的，而那是错觉 —— 一个看不到用处的依赖，迟早会有人
 * 顺手在里面用上，然后这个投影就不再是纯的了。
 */
export function workspaceViewOf(
  workspace: WorkspaceRecord,
  deps: { readonly capability_flags: (workspace: WorkspaceRecord) => CapabilityFlags },
): WorkspaceView {
  return {
    workspace_id: workspace.id,
    kind: workspace.kind,
    mode: workspace.mode,
    capabilities: deps.capability_flags(workspace),
    current_generation: workspace.generation,
    current_policy_version: workspace.policy_version,
    root_volume_id: workspace.volume_id,
    root_file_id: workspace.root_file_id,
    // `removed_at` 在前面已经拒绝，因此这里只剩「操作者暂停」一种。
    paused: !workspace.enabled,
  };
}
