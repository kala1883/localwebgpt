/**
 * 修改集的**复核读取**控制操作（LWB-036 步骤 1、2 的落地）。
 *
 * ## 为什么控制台需要一条自己的读取路径
 *
 * 在此之前，`change_get` / `change_list` 只挂在**工具面**上，而工具面的
 * 读取有两条与「复核」不相容的性质：
 *
 * | 那条路径的性质 | 为什么它挡住了复核 |
 * | --- | --- |
 * | 归属按 `owner_connection_id` 收窄（`query.ts` 的 `requireOwned`） | 控制台不是提出这个修改集的那条连接，它拿到的永远是「没有找到该修改集」 |
 * | 身份按 `principal_kind` 校验（`tools/access.ts` 的 `resolveConnection`） | 控制台的会话没有连接行，走工具面会被判成接线错误 |
 *
 * 这两条都是**对的**，一条都不该放宽：模型只看得到自己提议的东西、
 * 工具面只认已注册的连接。因此复核需要的不是把它们改松，而是**另开一条
 * 范围与判据都不同的读取路径**——并把这个不同写下来。
 *
 * ## 范围：控制台读的是「这台机器上的」修改集
 *
 * | | 模型（`change_get`） | 本模块（`changes.get`） |
 * | --- | --- | --- |
 * | 归属判据 | `owner_connection_id === 本连接` | **本机**（不加 owner 条件） |
 * | 它是谁 | 提议方 | 批准方 |
 *
 * 「批准方看得到提议方的东西」不是一次放宽，它就是审批这件事的定义：
 * 一个只能看到自己提出的修改集的批准方，无法批准任何东西。而**放宽只发生在
 * 这一侧**：工具面那一条一个字都没改（`requireOwned` 仍在原处，
 * 且 `changeDiffPageOf` 的导出说明里写明了它不代替归属检查）。
 *
 * 因此这条路径的每一次调用都是一次**本机操作者身份**的读取：
 * `requireLocalConsole` 与能力表 `changes.read` 两道都在（见下）。
 *
 * ## 内容仍然过同一道出站闸门
 *
 * 这是本模块最要紧的一条约束。控制台要看的差异**不是**由本模块渲染的，
 * 而是 `@lwb/changes` 的 `changeDiffPageOf` —— 与 `change_get` 是**同一个
 * 函数**：同一次 `blobBytes`（每次比哈希）、同一个 `diffLines`、
 * 同一个 `mintClearance` + `emitContent`（重判路径、筛秘密、扣预算）。
 *
 * 让控制台另写一份渲染，就会有「模型看到的」与「操作者看到的」不是同一份
 * 东西的那一天 —— 而批准绑定的摘要覆盖的是模型提议的那些字节，
 * 两份渲染之间的差异正是「操作者批准了 A、实际落地的是 B」的那条缝。
 *
 * ## 视图不过闸门，内容过 —— 与工具面同一口径
 *
 * `changes.get` 不带 `path` 时回的是**事实**：路径、大小、哈希、风险、
 * 回执。它不过出站闸门，因为模型侧的 `changeGetDataOf` 也不过 ——
 * 两边都如实：这些字段在修改集建立时就已经交给了模型（`change_prepare`
 * 的返回值就是这一份视图），因此它不构成新的出站。真正会带出**文件正文**的
 * 是 `path` 那一次，那一次必过闸门。
 *
 * 硬拒绝（`.env` 之类）在两条路径上的落点也一致：`changeDiffPageOf`
 * 在碰快照**之前**就按规范拼写判一次（`hard_deny` 直接抛），闸门再判一次。
 *
 * 「判定本身拒绝」则是本模块**自己的**一步：`changes.get` 在要内容之前
 * 先看 `decision.allow`，不允许就抛 `PolicyDeniedError`。不能把这一步
 * 留给 `changeDiffPageOf` —— 它要到 `mintClearance` 才会发现，而那时
 * 字节已经读过一遍了（见 `changes.get` 里那段说明）。
 *
 * ## 只读分类
 *
 * 两个操作都**不写库**，因此在 `control-plane.ts` 里归 `READ_ONLY_OPERATIONS`
 * （不带一次性 nonce）。这与 `approvals.list` 是同一条理由：一个刷新页面的
 * 读取不该要求操作者每几秒签一次 nonce —— 而 `service.pause_status` 的注释
 * 已经写明了那样做的后果（有人为了不被烦到而把它挪进只读，顺手带走一条接口）。
 *
 * ## 能力：为什么不是 `tools.read`
 *
 * `ControlRouteTable.register` 会拒绝任何「要求一个模型侧也具备的能力」的
 * 控制路由 —— 那等于把这条接口开放给模型。`tools.read` 正是授予模型的，
 * 因此复核读取需要一条**只属于控制台**的能力：`changes.read`
 * （`@lwb/ipc` 的 `CAPABILITIES` / `CAPABILITIES_BY_AUDIENCE.console` /
 * `NEVER_GRANTED_TO_MODEL` 三处齐改，`tests/unit/ipc.test.ts` 逐条钉住）。
 * 它不是「给控制台多开了一项」，而是让注册期那条断言能继续成立。
 */

import { BridgeError } from '@lwb/contracts';
import type { CapabilityFlags, ChangeDiffPage, ChangeSetView } from '@lwb/contracts';
import type { EgressBudgetStore } from '@lwb/egress';
import type { OperationDefinition, OperationRegistry, RequestContext } from '@lwb/ipc';
import {
  DEFAULT_CHANGE_QUERY_LIMITS,
  changeDiffPageOf,
  changeSetViewOf,
  nextActionFor,
  operationReceiptFor,
  shortCodeOf,
} from '@lwb/changes';
import type { ChangeQueryLimits } from '@lwb/changes';
import { decide, PolicyDeniedError } from '@lwb/policy';
import type { ConnectionView, FileRule, PolicyDecision } from '@lwb/policy';
import type { BlobStore } from '@lwb/blob-store';
import type { ChangeSetRecord, Repositories, WorkspaceRecord } from '@lwb/persistence';

import { workspaceViewOf } from '../tools/access.ts';
import { originOf } from './workspaces.ts';

/** 复核读取统一要求的能力。**不授予模型侧**（`NEVER_GRANTED_TO_MODEL` 里逐条钉住）。 */
export const CHANGES_READ_CAPABILITY = 'changes.read' as const;

/** 供装配与测试核对：本模块注册的操作名。 */
export const CHANGE_OPERATION_NAMES: readonly string[] = ['changes.list', 'changes.get'];

// ---------------------------------------------------------------------------
// 入参解析
// ---------------------------------------------------------------------------

function asRecord(input: unknown): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new BridgeError('INVALID_ARGUMENT', '修改集读取需要一个对象参数。');
  }
  return input as Record<string, unknown>;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new BridgeError('INVALID_ARGUMENT', `字段 ${field} 必须是非空字符串。`);
  }
  return value;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  return requireString(value, field);
}

/**
 * 只有本地控制台可以复核修改集。
 *
 * 与 `approvals.ts` 的 `requireLocalConsole` **故意不共用**：那一个拒绝的是
 * 「不是本机的人」，这一个拒绝的是「不是本机的复核者」—— 两句话恰好由同一个
 * 判据表达，但属于两个不同的理由集合，合并会让将来只改一处的人以为另一处
 * 也被改了（`approvals.ts` 的文件头对这条取舍有完整说明）。
 *
 * 返回的是**复核身份**：`context.connection_id`，由控制平面路由在调用处理器
 * 之前设成 `console:<session_id>`（见 `routes.ts`）。本模块的入参里**没有**
 * 位置可以放下 `user_id` / `session_id` / `conversation_label`。
 */
function requireLocalConsole(context: RequestContext): string {
  if (originOf(context) !== 'local_console') {
    throw new BridgeError('NOT_AUTHORIZED', '只有本地控制台可以读取修改集。', {
      reason: 'ORIGIN_NOT_LOCAL',
    });
  }
  return context.connection_id;
}

// ---------------------------------------------------------------------------
// 判定
// ---------------------------------------------------------------------------

/**
 * 复核读取所用的判定动作。
 *
 * **`snapshot_read` 而不是 `read`。** 两侧字节都来自快照库，用户工作区
 * 一个字节都不碰；`read` 描述的是「读工作区里的文件」，那是另一件事。
 * 与 `change_revert_prepare` 选的是同一个面，理由也相同。
 *
 * 本地复核依赖已认证的控制台会话与该工作区的状态；平台/daemon 实现 flags
 * 不参与这条判定。
 *  - 本地会话没有读取能力时，不向复核页交出差异；
 *  - 工作区被暂停、或处于待人工恢复时，操作者看得到「为什么看不到」，
 *    而不是看到一份内容，这恰好是两个状态各自要防的事。
 * 于是「看不到内容」必须有**一个可以说出口的理由**，而那正是
 * `content_gate` 这一格存在的意义 —— 界面据此把拒绝说出来，
 * 而不是把一个空文件显示成「这份差异是空的」。
 */
const REVIEW_ACTION = 'snapshot_read' as const;

/**
 * 控制台在这次复核里持有的**策略能力**。
 *
 * 只给 `read` 一项，且是刻意的：复核读取所需要的**恰好**是它
 * （`snapshot_read` 的 `ACTION_SPECS.capability`）。给多了会让
 * 「控制台凭什么能读」这件事在代码里读不出来 —— 而这一层是纯函数，
 * 它拿到什么就判什么，多给一项就是多放开一个动作。
 */
const REVIEW_POLICY_CAPABILITIES = ['read'] as const;

/**
 * 本次复核的连接视图。
 *
 * ## 它**不是**一条连接记录，这件事必须说清楚
 *
 * 其余每一处 `ConnectionView` 都来自 `connections` 表（一条已注册的、
 * 有凭证的连接）。控制台没有那一行 —— 它是**本机操作者本人**，
 * 会话由控制平面签发，因此没有「被授予」这回事：授权它的不是一条记录，
 * 而是一次已鉴权的本机会话（`requireLocalConsole` 与能力表已经判过）。
 *
 * 三个字段的取值分别有据：
 *  - `enabled: true` —— 会话此时是活的（处理器拿到它才走到这里）；
 *  - `granted_capabilities` —— 上面那张只有一项的表；
 *  - `granted_workspace_ids: [workspace.id]` —— **按本次复核的那一个工作区收窄**，
 *    不是「本机全部工作区」。一次复核只关于一份修改集，而它属于一个工作区；
 *    给一个更宽的列表会让 `decide()` 的 `WORKSPACE_NOT_GRANTED` 在这一层
 *    永远不会触发，那条检查就此变成死代码。
 */
function reviewConnectionView(connectionId: string, workspaceId: string): ConnectionView {
  return {
    connection_id: connectionId,
    enabled: true,
    granted_capabilities: REVIEW_POLICY_CAPABILITIES,
    audience: 'local_console',
    granted_workspace_ids: [workspaceId],
  };
}

export interface ChangeOperationDeps {
  readonly repos: Repositories;
  readonly blobs: BlobStore;
  /** 出站预算。控制台会话按 `console:<session_id>` 各记一份。 */
  readonly budgets: EgressBudgetStore;
  /** 恢复状态读数；全局实现能力 flags 不参与授权。 */
  readonly capability_flags: (workspace: WorkspaceRecord) => CapabilityFlags;
  /** 判定时刻（epoch ms）。省略取当前时间；测试与证据注入固定时刻。 */
  readonly now?: () => number;
  /** 操作者豁免规则。省略即用默认规则（更严的那一侧）。 */
  readonly rules?: readonly FileRule[];
  readonly limits?: Partial<ChangeQueryLimits>;
}

/**
 * 一次复核判定。
 *
 * 判定是**纯函数**，输入是这一层装配出来的快照：工作区行（从状态库读）、
 * 恢复状态，以及一份**按本次复核收窄过**的连接视图。
 * 入参里没有任何字段能影响它 —— 模型参数、请求体、隧道身份都不参与。
 */
function reviewDecision(
  connectionId: string,
  workspace: WorkspaceRecord,
  deps: ChangeOperationDeps,
): PolicyDecision {
  return decide({
    connection: reviewConnectionView(connectionId, workspace.id),
    workspace: workspaceViewOf(workspace, deps),
    // 读取类动作不需要票据：`ACTION_SPECS.snapshot_read.requires_ticket` 是 false，
    // 因此 `null` 是「本次动作不声称绑定任何代次」的诚实说法。
    presented: { generation: null, policy_version: null },
    // 路径给空串：本次判的是**工作区与连接这一层**。逐文件的硬拒绝在
    // `changeDiffPageOf` 里按规范拼写判（碰快照之前），闸门再判一次（权威那次）。
    action: { action: REVIEW_ACTION, path: '', approval: null },
    now: deps.now?.() ?? Date.now(),
    ...(deps.rules === undefined ? {} : { rules: deps.rules }),
  });
}

/**
 * 判定结果里**可以交给界面**的那一部分。
 *
 * 只给三样：能不能读、一个稳定的原因 slug、以及那句给操作者看的话。
 * 不给 `failures` 数组（那是本机审计用的完整失败清单，逐条都带本机事实），
 * 也不给规则表。
 *
 * `reason` 取的是 `primary.reason`（稳定 slug，测试与界面按它比对），
 * 不是 `primary.detail`——detail 会随文案调整，而界面要能对「读不到内容」
 * 分档处理。
 */
export interface ContentGateView {
  readonly allows_read: boolean;
  readonly reason: string | null;
  readonly message: string | null;
}

function contentGateViewOf(decision: PolicyDecision): ContentGateView {
  if (decision.allow) {
    return { allows_read: true, reason: null, message: null };
  }
  const primary = decision.primary;
  return {
    allows_read: false,
    reason: primary?.reason ?? 'UNKNOWN',
    message: primary?.detail ?? '本地策略拒绝读取该修改集的内容。',
  };
}

// ---------------------------------------------------------------------------
// 回报字段
// ---------------------------------------------------------------------------

/**
 * 列表里的一行。
 *
 * 带上 `owner_connection_id`，与模型侧那份**刻意不带**的身份字段相反 ——
 * 这是复核方的必要信息：「这份修改集是谁提议的」正是操作者要核对的东西之一
 * （`ChangesView.vue` 的 `ownerLabel` 那一格就是它）。模型侧看不到它，
 * 因为那对模型没有任何用处，而它确实是一个本机事实。
 */
function describeListEntry(record: ChangeSetRecord, deps: ChangeOperationDeps): Record<string, unknown> {
  return {
    change_id: record.id,
    workspace_id: record.workspace_id,
    owner_connection_id: record.owner_connection_id,
    state: record.state,
    digest: record.digest,
    short_code: shortCodeOf(record.digest),
    summary: record.summary,
    created_at: record.created_at,
    expires_at: record.expires_at,
    // 逐条取 items 的长度，与 `changeListDataOf` 同一条理由：分两次查，
    // 中间就可能有一条修改集的状态变了 —— 条数与状态会来自两个时刻。
    file_count: deps.repos.changes.items(record.id).length,
  };
}

/** 工作区的那一格。**不复用 `WorkspaceRecord`**：清单里有本机绝对路径。 */
function describeWorkspace(workspace: WorkspaceRecord | null): Record<string, unknown> | null {
  if (workspace === null) return null;
  return {
    workspace_id: workspace.id,
    alias: workspace.alias,
    kind: workspace.kind,
    mode: workspace.mode,
    generation: workspace.generation,
    policy_version: workspace.policy_version,
    /** 已移除（软删除）的工作区：历史修改集仍指向它，复核时必须说清。 */
    removed_at: workspace.removed_at,
    enabled: workspace.enabled,
    // **没有 `canonical_root`。** 复核界面不需要本机绝对路径，
    // 而控制平面的响应会被日志与诊断包经过 —— 一条不需要的路径
    // 是一份白送的本机事实。工具面的 `workspaces.list` 给路径是因为
    // 「我登记的到底是哪个目录」是那个界面要回答的问题。
  };
}

/** 修改集的视图。`changeSetViewOf` + `next_action`，与工具面同一份。 */
function viewOf(record: ChangeSetRecord, deps: ChangeOperationDeps): ChangeSetView {
  const items = deps.repos.changes.items(record.id);
  return {
    ...changeSetViewOf(record, items, (blobId) => deps.repos.blobs.requireById(blobId).size),
    next_action: nextActionFor(record.state),
  };
}

// ---------------------------------------------------------------------------
// 操作
// ---------------------------------------------------------------------------

export function registerChangeOperations(
  registry: OperationRegistry,
  deps: ChangeOperationDeps,
): void {
  const limits: ChangeQueryLimits = { ...DEFAULT_CHANGE_QUERY_LIMITS, ...(deps.limits ?? {}) };

  const definitions: OperationDefinition[] = [
    {
      name: 'changes.list',
      required: CHANGES_READ_CAPABILITY,
      handler: (input, context) => {
        requireLocalConsole(context);
        const body = input === undefined || input === null ? {} : asRecord(input);
        const limit = body['limit'];
        if (limit !== undefined && (typeof limit !== 'number' || !Number.isInteger(limit))) {
          throw new BridgeError('INVALID_ARGUMENT', '字段 limit 必须是整数。');
        }
        const workspaceId = optionalString(body['workspace_id'], 'workspace_id');

        // **没有 `owner_connection_id` 条件** —— 见文件头「范围」一节。
        // `repos.changes.list()` 的上限是 200，因此这里不需要再截一次；
        // 界面上要的是「最近这些」，而更早的由游标（本模块不发）与状态过滤回答。
        const rows = deps.repos.changes.list({
          limit: typeof limit === 'number' ? limit : 50,
          ...(workspaceId === undefined ? {} : { workspace_id: workspaceId }),
        });

        return {
          changes: rows.map((record) => describeListEntry(record, deps)),
          // 本机上的修改集总数不是这个列表的长度：列表可能被 limit 截断。
          // 两个数字混在一起会让界面把「只看了一页」读成「一共就这些」。
          truncated: rows.length >= (typeof limit === 'number' ? limit : 50),
          observed_at: new Date(deps.now?.() ?? Date.now()).toISOString(),
        };
      },
    },

    {
      name: 'changes.get',
      required: CHANGES_READ_CAPABILITY,
      handler: async (input, context) => {
        const reviewer = requireLocalConsole(context);
        const body = asRecord(input);
        const changeId = requireString(body['change_id'], 'change_id');
        const path = optionalString(body['path'], 'path');

        const record = deps.repos.changes.findById(changeId);
        if (record === null) {
          // 与模型侧同一个回答形状，但**理由不同**：那边是「不是你的」，
          // 这边是「本机上没有这一条」。本模块不加 owner 条件，
          // 因此这里没有「存在但不是你的」这一格可以泄露。
          throw new BridgeError('NOT_FOUND', '没有找到该修改集。');
        }

        const workspace = deps.repos.workspaces.findById(record.workspace_id);
        // 工作区行不见了（理论上不可能：`changesets.workspace_id` 是
        // `ON DELETE RESTRICT`，移除是软删除）。真发生了就不猜：
          // 没有工作区行就无法核验工作区状态与恢复保护，「能不能读」无从判定，
        // 而按「能读」处理是唯一错得离谱的那个方向。
        if (workspace === null) {
          throw new BridgeError('INTERNAL_ERROR', '该修改集指向的工作区不存在；已拒绝复核读取。', {
            reason: 'WORKSPACE_MISSING',
          });
        }

        const decision = reviewDecision(reviewer, workspace, deps);

        /**
         * 要内容之前先看闸门。**这一句是 LWB-036 的一处真实缺陷的修复。**
         *
         * ## 修之前会发生什么
         *
         * 缺了这一句，闸门关闭时 `changeDiffPageOf` 会先把两侧快照**读进内存**
         * （`blobBytes`，每次比哈希），然后才在 `mintClearance` 那里发现
         * 「不允许的动作不能获得出站凭证」，并抛出**一个裸 `Error`**
         * （`packages/egress/src/clearance.ts` 抛的是 `new Error(...)`，
         * 不是 `BridgeError`）。
         *
         * 两处都不对，而且都不小：
         *  - **字节已经进过内存**。文件头里「硬拒绝在碰快照之前就判一次」那句
         *    话对 `hard_deny` 成立，但对「判定本身拒绝了」不成立 —— 而后者
         *    才是闸门关闭时的实际情形。一次被拒绝的读取不该读任何东西。
         *  - **错误形状不对**。裸 `Error` 到不了调用方手里那套 `code` /
         *    `details` 的契约上，控制平面只能把它兜成一个内部错误 ——
         *    于是「工作区被暂停」在界面上显示成「服务器出错了」。
         *
         * ## 工具面为什么没这个问题
         *
         * 工具面在更早的一步就拒绝了：`resolveWorkspaceAccess()` 用的
         * `requireAllowed` 会在 `changeGetDataOf` **被调用之前**抛出
         * `PolicyDeniedError`。控制台这条路径的判定就发生在同一个处理器
         * 内部，因此那句「更早」在这里没有对应的位置 —— 得显式写出来。
         *
         * 用 `PolicyDeniedError` 而不是就地拼一个 `BridgeError`：它带的是
         * **策略自己的**错误码与稳定理由（`details.policy_reason`），因此
         * 这一条拒绝与工具面那条逐字段同形。界面据 `content_gate.reason`
         * 分档处理时，拿到的是同一个 slug。
         *
         * 副作用（刻意保留）：路径根本不在本修改集里、而闸门又关闭时，
         * 现在回答的是策略拒绝而不是 `PATH_NOT_IN_CHANGE`。这是更 fail-closed
         * 的那一侧 —— 而路径清单本来就已经在同一个响应的 `change.files` 里，
         * 所以那条回答并不会多告诉调用方任何东西。
         */
        if (path !== undefined && !decision.allow) throw new PolicyDeniedError(decision);

        const diff: ChangeDiffPage | null =
          path === undefined
            ? null
            : await changeDiffPageOf({
                record,
                items: deps.repos.changes.items(record.id),
                path,
                context: {
                  connection_id: reviewer,
                  scope: { generation: workspace.generation },
                  decision,
                  budget: deps.budgets.forConnection(reviewer),
                },
                limits,
                deps: { repos: deps.repos, blobs: deps.blobs, limits },
              });

        return {
          change: viewOf(record, deps),
          workspace: describeWorkspace(workspace),
          owner_connection_id: record.owner_connection_id,
          operation: operationReceiptFor(record.id, deps.repos),
          approval: approvalSummaryOf(record.id, deps.repos),
          /**
           * 「服务端愿意给内容吗」——**在要内容之前**就能问到的那个答案。
           *
           * 它与 `path` 那一次取内容用的是**同一次判定**（`decision`），
           * 因此两者不可能不一致。界面据此把「看不到内容」在翻页之前就说出来，
           * 而不是让操作者一页一页点、每页收到一个错误。
           */
          content_gate: contentGateViewOf(decision),
          diff,
          observed_at: new Date(deps.now?.() ?? Date.now()).toISOString(),
        };
      },
    },
  ];

  for (const definition of definitions) registry.register(definition);
}

/**
 * 批准摘要。与 `@lwb/changes` 的同类函数同一条取舍：**只给状态与有效期**。
 *
 * 这里连批准人都没有 —— 而控制台**确实**有权知道是谁批准了（它就是批准方）。
 * 不给的理由是那个信息已经有一条权威的来路：`approvals.list` 的每一行都带着
 * `actor`，而复核页面要显示「谁批准了这一份」时应当去问它。两个来源就有两种
 * 不一致，而这里的那个是顺手带出来的、没有任何界面契约保证的副本。
 */
function approvalSummaryOf(
  changeId: string,
  repos: Repositories,
): { readonly state: string; readonly expires_at: string | null } | null {
  const record = repos.approvals.findActive(changeId) ?? repos.approvals.listForChange(changeId)[0] ?? null;
  if (record === null) return null;
  return { state: record.state, expires_at: record.expires_at };
}
