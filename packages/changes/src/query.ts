/**
 * 修改集的**读取面**（LWB-025）：`change_get` 与 `change_list`。
 *
 * 三个文件回答三个不同的问题，本文件回答的是第三个：
 *
 *  - `prepare.ts`  —— 「把一组编辑变成一条不可变记录」。写状态库，不写用户文件。
 *  - `invalidation.ts` —— 「什么时候一条记录不再能用」。失效、过期、回收。
 *  - `query.ts`    —— 「这条记录**现在**是什么」。只读，不改任何东西。
 *
 * ## 一、归属即存在：不是自己的修改集，回答与「不存在」逐字相同
 *
 * 修改集按连接归属（`owner_connection_id`）。别的连接的 id 不该让调用方
 * 学到任何东西 —— 连「本机存在这个 id」都不该。因此这里**不**区分
 * 「不存在」与「不是你的」，两者都由 `notFound()` 造出**同一个**
 * `BridgeError`，连 `details` 都不带。
 *
 * 这一条与 `access.ts` 里「先查授权行、后查工作区行」是同一个理由：
 * 两个不同的回答就是一个预言机，而预言机不需要被利用就已经是泄露。
 * 推论是 `notFound()` 里**不许**加 `reason` 之类的明细：只要两处回答的
 * 明细不同，「区分」就回来了。
 *
 * ## 二、`next_action` 必须随状态而变，不能借用 `prepare` 的那一句
 *
 * `changeSetViewOf()` 把 `next_action` 固定成「已建立，按工作区 grant 调用 change_apply」。那对
 * `change_prepare` 是**唯一正确**的一句话 —— 那个函数只在「刚刚建立」时
 * 被调用，状态必然是 `PENDING_APPROVAL`。但 `change_get` 会在几小时之后
 * 被调用，那时状态可能是 `APPLIED`、`CONFLICT` 或 `RECOVERY_REQUIRED`。
 * 把「调用 change_apply」原样返回，等于让模型读到一句**与事实相反**的指示：
 * 它可能据此告诉用户「还没保存」，也可能据此重新发起一次提案。
 *
 * 因此这里用 `nextActionFor()` —— 一张**类型上穷尽**的表
 * （`Record<ChangeSetState, string>`，少一个状态就编译失败）。穷尽不是
 * 为了好看：这个映射将来新增状态时，编译失败是唯一一种「不会安静地
 * 给出过时建议」的失败方式。
 *
 * ## 三、差异必须过出站闸门，而且这个面的处置是**整块阻断**
 *
 * `change_get` 的差异由两份快照字节算出来（旧字节来自用户文件，新字节
 * 来自模型自己的提案），它同样是一段**内容出站**，因此走
 * `emitContent()` —— 与读取、搜索、Git 差异同一个闸门。闸门会重判路径、
 * 重筛秘密，并且因为 `snapshot_read` 面的处置是 `block`（不是 `redact`），
 * 一段高置信度凭证会让**整份差异**被拒，而不是被打码后放行。
 *
 * 「快照面不查秘密」是最容易写出来的旁路：那句注释会写成「这些字节
 * 之前读的时候已经查过了」。它错在时间上 —— 字节是之前读的，规则和
 * 判定是现在做的。
 *
 * ## 本文件不碰磁盘、不碰句柄
 *
 * 它读快照库（`BlobStore`，字节）与状态库（`Repositories`，记录），
 * 两者都是**已经落地的副本**。用户工作区一个字节都不会被读或写 ——
 * 这也是 `change_get` 可以说自己是 `readOnlyHint` 的原因。
 */

import { BridgeError, equalPathCaseInsensitive, LIMITS } from '@lwb/contracts';
import type {
  ApprovalState,
  ChangeDiffPage,
  ChangeFileState,
  ChangeGetData,
  ChangeGetInput,
  ChangeListData,
  ChangeListEntry,
  ChangeListInput,
  ChangeSetState,
  ChangeSetView,
  OperationFileResult,
  OperationReceipt,
} from '@lwb/contracts';
import type { BlobStore } from '@lwb/blob-store';
import { emitContent, mintClearance, type EgressBudget } from '@lwb/egress';
import {
  DIFF_MAX_DP_CELLS,
  diffLines,
  inspectBytes,
  type ByteInspection,
  type DecodedText,
} from '@lwb/files';
import type { PolicyDecision } from '@lwb/policy';
import { classifyFile } from '@lwb/policy';
import type { ChangeItemRecord, ChangeSetRecord, Repositories } from '@lwb/persistence';

import { shortCodeOf } from './digest.ts';
import {
  EXECUTION_JOURNAL_STAGES as STAGE,
  lastEventOf,
  type ExecutionJournalRow,
} from './execution-journal.ts';
import { changeSetViewOf } from './prepare.ts';
import { TERMINAL_BY_TRANSITION_TABLE } from './state-machine.ts';

/**
 * 回执行的一行。**从仓储方法的返回类型里取**，不在这里再抄一遍字段：
 * 抄一遍就多了一个「表结构改了、这里没改」的地方，而那一处会在
 * `row.state` 读出 `undefined` 时**安静地**变成 `UNKNOWN`。
 */
type OperationItemResultRow = ReturnType<Repositories['operations']['itemResults']>[number];

// ---------------------------------------------------------------------------
// 依赖与限额
// ---------------------------------------------------------------------------

/**
 * 读取面的限额。
 *
 * 三项差异相关的是**产品限额**，取自 `LIMITS`（与 `git_diff` 用同一批数：
 * 同一个「差异多大算太大」的判据不该在两个工具上是两个数）。`max_list_items`
 * 不是产品限额，它是**分页**的技术边界，与 `change_list` 的输入 schema 同源
 * —— schema 已经封在 100，这一层再封一次是纵深，不是重复：
 * 这一层不 assume 调用方一定经过了 schema。
 */
export interface ChangeQueryLimits {
  readonly max_diff_output_bytes: number;
  readonly diff_context_lines: number;
  readonly max_dp_cells: number;
  readonly max_list_items: number;
}

export const DEFAULT_CHANGE_QUERY_LIMITS: ChangeQueryLimits = {
  max_diff_output_bytes: LIMITS.MAX_GIT_DIFF_OUTPUT_BYTES,
  diff_context_lines: LIMITS.GIT_DIFF_CONTEXT_LINES,
  // 取自 `@lwb/files` 的 `text-diff.ts` —— 它描述的是**那个 LCS 实现**的
  // 内存边界，因此 `git_diff` 与 `change_get` 拿到的是同一个数。
  max_dp_cells: DIFF_MAX_DP_CELLS,
  max_list_items: 100,
};

export interface ChangeQueryDeps {
  readonly repos: Repositories;
  readonly blobs: BlobStore;
  /** 只给本地操作者与测试。工具参数里没有任何字段通向这里。 */
  readonly limits?: Partial<ChangeQueryLimits>;
}

function limitsOf(deps: ChangeQueryDeps): ChangeQueryLimits {
  return { ...DEFAULT_CHANGE_QUERY_LIMITS, ...(deps.limits ?? {}) };
}

/**
 * 一次读取所需的**出站与授权事实**。
 *
 * `decision` 是 `resolveWorkspaceAccess()` 交出来的那一份**已登记**的判定
 * （`mintClearance` 只接受登记过的对象），`budget` 是连接级出站预算。
 * 两者都必须来自授权链，不由本模块自造。
 */
export interface ChangeReadContext {
  readonly connection_id: string;
  /**
   * 出站凭证要绑定的工作区代次。
   *
   * ## 它为什么只收一个数字（LWB-036）
   *
   * 原先是完整的 `ReadScope`（七个字段，含 `root_path` / `root_volume_id` /
   * `root_file_id`）。那样一个对象的**唯一合法来源**是
   * `WorkspaceRegistry.authorizeAccess()` —— 它每次都会去**真的打开**那个根。
   * 而本模块一个用户文件字节都不碰：两侧内容都来自快照库。于是
   * 「必须先真的打开用户工作区的根，才读得了一份快照」这件事，
   * 不是本模块的性质，只是它的调用方（工具面）恰好也打开了根。
   *
   * 控制台复核修改集（`apps/daemon/src/control/changes.ts`）就是那个
   * 「不打开根、但要读快照」的调用方。它如果为了满足类型而**拼**一个
   * `ReadScope`，那个对象里的 `root_path` / `root_volume_id` 就成了
   * 从状态库里抄来的、从未被核对过的声明 —— 一份看起来像「我们打开过
   * 这个根」的凭据。收窄成一个数字之后，那件事在类型上做不到。
   *
   * 收窄不放松任何一条检查：`mintClearance` 只用它来记录代次，
   * 而逐路径的硬拒绝与秘密筛查照旧在 `emitContent` 里跑。
   */
  readonly scope: { readonly generation: number };
  readonly decision: PolicyDecision;
  readonly budget: EgressBudget;
}

// ---------------------------------------------------------------------------
// 归属
// ---------------------------------------------------------------------------

/**
 * 唯一的「没有找到」。
 *
 * **不带任何明细**，理由见文件头第一节：两条不同的路径（不存在 / 不是你的）
 * 从这里出去，回答必须逐字相同，否则它就是一个「本机是否存在这个 id」的
 * 预言机。加一个 `reason` 明细就足以把两者区分开。
 */
function notFound(): BridgeError {
  return new BridgeError('NOT_FOUND', '没有找到该修改集。');
}

/**
 * 按 id 取一条**属于本连接**的修改集，否则抛出 `notFound()`。
 *
 * 归属检查与查找是**同一步**，不留给调用方补 —— 分开写就有第三个调用点
 * 只做了查找而忘了归属，「不是你的」于是变成「是你的」。
 */
function requireOwned(changeId: string, connectionId: string, repos: Repositories): ChangeSetRecord {
  const record = repos.changes.findById(changeId);
  if (record === null || record.owner_connection_id !== connectionId) throw notFound();
  return record;
}

/** 一次查询指名的修改集。`change_id` 与 `operation_id` 二者至少其一。 */
function resolveChange(input: ChangeGetInput, connectionId: string, repos: Repositories): ChangeSetRecord {
  const byChange = input.change_id === undefined ? null : requireOwned(input.change_id, connectionId, repos);

  let byOperation: ChangeSetRecord | null = null;
  if (input.operation_id !== undefined) {
    const operation = repos.operations.findById(input.operation_id);
    // 操作不存在，或它指向的修改集不是本连接的 —— 两种都走同一个回答。
    byOperation = operation === null ? null : requireOwned(operation.change_id, connectionId, repos);
    if (byOperation === null) throw notFound();
  }

  if (byChange !== null && byOperation !== null && byChange.id !== byOperation.id) {
    // 走到这里说明**两条 id 都已确认属于本连接**，因此「它们不一致」这句
    // 话里没有任何不属于调用方的事实。反过来把这一步排在前面的写法会造出
    // 一个预言机：拿别人猜到的 operation_id 配自己的 change_id，回答
    // `IDENTIFIERS_DISAGREE` 与 `NOT_FOUND` 的差别就泄露了那个 id 存在。
    throw new BridgeError('INVALID_ARGUMENT', 'change_id 与 operation_id 指向不同的修改集；请只给其中一个。', {
      reason: 'IDENTIFIERS_DISAGREE',
    });
  }

  const record = byChange ?? byOperation;
  if (record === null) {
    throw new BridgeError('INVALID_ARGUMENT', '必须给出 change_id 或 operation_id 之一。', {
      reason: 'NO_IDENTIFIER',
    });
  }
  return record;
}

/**
 * 一次查询指名的修改集**属于哪条连接、哪个工作区**。
 *
 * ## 它为什么必须存在，以及为什么只回两个 id
 *
 * `change_get` 的入参里**没有** `workspace_id`（它按 change_id / operation_id
 * 指名），而工具处理器那条链是「先按工作区解析授权，再执行」——
 * 授权解析需要 workspace_id，于是它只能从这条记录上读出来。
 *
 * 回的是两个 id，**不是整条记录**：处理器拿到记录就能在没经过授权解析的
 * 情况下自己拼出一个视图，而那种写法在代码上是合法的、在语义上是越权。
 * 只给 id，处理器除了「拿它去解析授权」之外做不了别的。
 *
 * ## 它**不**代替 `changeGetDataOf` 里的那一次归属检查
 *
 * 两次查的是同一条不可变记录（`workspace_id` 一经建立不再变化），
 * 因此结果必然一致。这里的重复是刻意的：把归属检查挂在「必须经过的一步」
 * 上，比挂在「调用方记得先调一下」上可靠。
 */
export function ownedChangeOf(
  input: ChangeGetInput,
  connectionId: string,
  repos: Repositories,
): { readonly change_id: string; readonly workspace_id: string } {
  const record = resolveChange(input, connectionId, repos);
  return { change_id: record.id, workspace_id: record.workspace_id };
}

// ---------------------------------------------------------------------------
// 面向模型的状态文案
// ---------------------------------------------------------------------------

/**
 * 每个状态下**下一步该做什么**。类型上穷尽：少一个状态就编译失败。
 *
 * 文案里反复出现的两句话是刻意的，它们对应两件最容易被说反的事：
 *  - 只有 `APPLIED` 才能说「已保存」；
 *  - 模型不能越过逐工作区 grant；也无法解除冲突或恢复状态。
 */
const NEXT_ACTION: Readonly<Record<ChangeSetState, string>> = {
  PENDING_APPROVAL:
    '修改集已建立，**尚未写入任何文件**。若该工作区已授予文件修改权限，请调用 change_apply 执行；' +
    '若未授权，需由本地操作者在工作区设置中授予。',
  REJECTED: '本地操作者已拒绝本修改集。它不可再应用；如仍需修改，请重新读取目标文件后另行提案。',
  EXPIRED: '本修改集已超过有效期（24 小时）而失效。如需继续，请重新读取目标文件后另行提案。',
  INVALIDATED:
    '本修改集已失效（工作区代次变化、授权变更或连接停用）。旧执行授权不再有效，请重新读取后另行提案。',
  APPROVED: '修改集已取得执行授权，等待进入执行队列。请勿重复提案；用 change_get 查询后续状态即可。',
  QUEUED: '已排队，尚未开始写入。请用 change_get 查询，**不要**重新发起同一个写操作。',
  VALIDATING: '正在执行前校验（重新核对文件身份与内容）。尚不能确认任何文件已写入。',
  CONFLICT: '执行前核对发现目标文件已与提案时的内容不符，**没有写入**。请重新读取该文件后再提案。',
  FAILED_NO_CHANGE: '本次执行**没有产生任何修改**（或已回退）。请用 change_get 查看逐文件回执中的原因。',
  APPLYING: '正在写入。此时不要重复调用任何写工具；用 change_get 查询进度。',
  APPLIED: '已写入并逐文件核验通过。请以逐文件回执为准向用户说明；V1 不运行项目测试（tests_run 恒为 false）。',
  ROLLED_BACK: '本次执行已回退到原始内容，**用户文件未被改动**。请查看回执中的原因。',
  RECOVERY_REQUIRED:
    '本次执行未能确定某个文件的最终状态，**需要本地操作者在控制台处理**。' +
    '不要重试、不要再次写入；请如实告知用户需要本地人工确认。',
};

export function nextActionFor(state: ChangeSetState): string {
  return NEXT_ACTION[state];
}

/**
 * 操作回执上的一句话。与 `NEXT_ACTION` 分开：那一张说的是「接下来做什么」，
 * 这一张说的是「刚才发生了什么」，两者在同一个状态下**不是**同一句话。
 */
const RECEIPT_MESSAGE: Readonly<Record<ChangeSetState, string>> = {
  PENDING_APPROVAL: '尚无执行记录：本修改集还没有进入执行阶段。',
  REJECTED: '尚无执行记录：本修改集已被本地操作者拒绝。',
  EXPIRED: '尚无执行记录：本修改集在批准前已过期。',
  INVALIDATED: '尚无执行记录：本修改集在批准前已失效。',
  APPROVED: '尚无执行记录：批准已给出，执行尚未开始。',
  QUEUED: '已排队，尚未开始写入。',
  VALIDATING: '正在执行前校验，尚未写入。',
  CONFLICT: '执行前核对发现目标文件与提案时不一致；**没有写入任何文件**。',
  FAILED_NO_CHANGE: '执行结束，**用户文件未被改动**。逐文件回执里给出了原因。',
  APPLYING: '正在写入，尚未结束。此时的结果都不完整。',
  APPLIED: '全部文件已写入并逐文件核验通过。V1 不运行项目测试，tests_run 恒为 false。',
  ROLLED_BACK: '已回退到原始内容；**用户文件未被改动**。',
  RECOVERY_REQUIRED: '某个文件的最终状态未能确定，**需要本地操作者处理**；不要重试。',
};

function receiptMessageOf(state: ChangeSetState): string {
  return RECEIPT_MESSAGE[state];
}

// ---------------------------------------------------------------------------
// 子视图
// ---------------------------------------------------------------------------

function viewFor(record: ChangeSetRecord, items: readonly ChangeItemRecord[], deps: ChangeQueryDeps): ChangeSetView {
  const base = changeSetViewOf(record, items, (blobId) => deps.repos.blobs.requireById(blobId).size);
  // 只覆盖 `next_action`：其余字段都是记录的**事实**，本文件没有资格改。
  // 目录级文件修改 grant 是人工设置的持久授权；不再要求每份修改集逐次批准。
  return { ...base, next_action: nextActionFor(record.state) };
}

/** 逐文件状态的合法取值。**认不出的一律 UNKNOWN**，绝不落到 VERIFIED。 */
const FILE_STATES: ReadonlySet<string> = new Set<string>([
  'PENDING',
  'VERIFIED',
  'CONFLICT',
  'FAILED',
  'RECOVERED_TARGET',
  'RECOVERED_ORIGINAL',
  'UNKNOWN',
]);

/**
 * 一行回执 → 契约里的逐文件状态。
 *
 * 三档，每一档的必要性不同：
 *
 *  - **有行**：只认上面那七个字面量。从 SQLite 读回来的是 `string`，
 *    直接断言成 `ChangeFileState` 会让一个将来新增（或写坏）的值
 *    无声地变成一个合法状态 —— 而它多半会被读成「成功」。
 *  - **没有行、操作未终结**：`PENDING`（还没轮到它）。
 *  - **没有行、操作已终结**：`UNKNOWN`。一个已结束的操作缺一行逐文件结果，
 *    是我们自己丢了事实，不是「这个文件没被碰过」。把丢失报成 `PENDING`
 *    与把未知报成成功是同一类错误。
 */
function fileStateOf(raw: string | undefined, operationState: ChangeSetState): ChangeFileState {
  if (raw !== undefined) return FILE_STATES.has(raw) ? (raw as ChangeFileState) : 'UNKNOWN';
  return TERMINAL_BY_TRANSITION_TABLE.includes(operationState) ? 'UNKNOWN' : 'PENDING';
}

/**
 * 一个条目在**执行日志**里的终局 → 回执上的状态与错误码。
 *
 * ## 为什么回执必须折日志（LWB-032 的一处真实缺陷）
 *
 * `operation_item_results` 那张表**只有 `@lwb/recovery` 会写**：一次干净跑完的
 * `change_apply` 从来不往它里面插行。只读它的话，一次**成功**的应用会给出
 * 逐文件 `UNKNOWN` + 两个哈希都是 `null` —— 而 LWB-032 的验收标准要的正是
 * 「回执包括逐文件哈希」。更糟的是它**看起来**像事实：`UNKNOWN` 是一个合法
 * 取值，读的人只会以为「这次没记下来」，不会想到「回执找错了表」。
 *
 * 真正记着「我们写下去、并回读到了什么」的是执行日志（`journal_entries`）：
 * 每个条目在 `item_verified` 上带着护栏回读得到的 `observed_sha256`。
 * `revert.ts`（LWB-031）已经为**同一个**问题选过这个来源，理由逐字相同 ——
 * 那次是「拿它当撤销的前提」，这次是「拿它当回执」；折叠规则因此也共用
 * （`lastEventOf`，见 `execution-journal.ts`）。
 *
 * ## 优先取哪一边：回执行优先
 *
 * `operation_item_results` 里出现一行，意味着**恢复流程**在那条操作上跑过：
 * 那是崩溃之后重新观测、并且可能已经动过盘之后写下的判定
 * （`RECOVERED_TARGET` / `RECOVERED_ORIGINAL`）。它比执行当时的日志**更晚**，
 * 而且回答的是「现在盘上是什么」，因此有它时以它为准。没有行时才折日志
 * —— 那正是「干净跑完、没人动过」的那一格。
 *
 * ## 三个哈希的分工（与 `@lwb/recovery` 的 `#writeReceipts` 同一套）
 *
 * `before_sha256` 取**条目里记着的基线**（`item.base_sha256`），`after_sha256`
 * 取**这一次观测到的那个哈希**（日志那一行的 `observed_sha256`）。两者都是
 * 被观察到的事实；**绝不**拿 `target_sha256`（打算写什么）去兜底 —— 那会把
 * 一次没落盘（或落到别处）的执行显示成「盘上就是目标那一份」。
 *
 * ## 认不出的阶段名一律 `UNKNOWN`
 *
 * 日志里可能出现本包不认识的阶段名（恢复流程写的是另一套词）。把「我不认识」
 * 读成「什么都没发生」，会让一条待恢复的操作在回执里显示成写成功了 ——
 * 方向必须是 fail-closed。
 */
function journalVerdictOf(last: ExecutionJournalRow, itemTargetSha256: string | null): {
  readonly state: ChangeFileState;
  readonly error_code: string | null;
} {
  switch (last.stage) {
    case STAGE.verified:
    case STAGE.skipped: {
      // 这两条都声称「盘上就是批准的那一份」，因此要三个哈希互相印证：
      // 日志里的目标、修改集记录的目标、以及回读到的那个。任何一处对不上
      // 都是账目矛盾，不猜哪一边对。
      const observed = last.observed_sha256;
      if (observed === null) return incomplete();
      if (last.target_sha256 === null || last.target_sha256 !== observed) return incomplete();
      return { state: 'VERIFIED', error_code: null };
    }
    case STAGE.deleted:
      return last.observed_file_id === null &&
        last.target_sha256 !== null &&
        last.target_sha256 === itemTargetSha256 &&
        last.observed_sha256 === itemTargetSha256
        ? { state: 'VERIFIED', error_code: null }
        : incomplete();
    case STAGE.restored:
      return last.observed_sha256 === null ? incomplete() : { state: 'RECOVERED_ORIGINAL', error_code: null };
    case STAGE.untouched:
      // 失败，但可**证明**没有留下本次执行的字节 —— 因此不是 `UNKNOWN`
      // （「不知道」在这里是假的，我们知道）。错误码缺席时给一个明确的
      // 「没被写过」，而不是留空让读的人以为这一格没有原因。
      return { state: 'FAILED', error_code: last.error_code ?? 'NOT_TOUCHED' };
    case STAGE.failed:
    case STAGE.restore_failed:
    case STAGE.restore_skipped:
      // 磁盘上**可能**留着本次执行的字节：这正是「状态不明」，而它在回执里
      // 必须与「没写过」分得开。
      return { state: 'UNKNOWN', error_code: last.error_code ?? 'WRITE_OUTCOME_UNKNOWN' };
    case STAGE.written:
    case STAGE.flushed:
      // 只写了、没有核验：护栏今天把三条写在同一个事务里，因此这不该出现；
      // 一旦出现就说明账目被改过或来自别的版本，不声称刷过盘。
      return incomplete();
    case STAGE.intent:
      return incomplete();
    default:
      // 跨版本的阶段名（例如恢复流程写下的那些）。不假设任何事。
      return incomplete();
  }
}

/**
 * 「日志不足以判断」的统一回答。
 *
 * 错误码固定为 `RECEIPT_INCOMPLETE`，与 `revert.ts` 的同一个格子用同一个词：
 * 两处说的是同一件事（这本账不足以支撑任何结论），而两个词意味着读的人要
 * 学两遍。
 */
function incomplete(): { readonly state: ChangeFileState; readonly error_code: string } {
  return { state: 'UNKNOWN', error_code: 'RECEIPT_INCOMPLETE' };
}

/** 逐条目回执里的一行。构造它的两条路（回执行 / 日志折叠）都收口到这里。 */
interface FileResult {
  readonly state: ChangeFileState;
  readonly before_sha256: string | null;
  readonly after_sha256: string | null;
  readonly error_code: string | null;
}

/**
 * 一个条目的回执行：**两个来源，取更晚的那个**（见 `journalVerdictOf`）。
 *
 * 日志那一行的 `observed_sha256` 是「本次执行观测到的那个哈希」，因此它直接
 * 进 `after_sha256`；`before_sha256` 恒取条目里记着的基线。两者都可能为
 * `null`（新建的条目没有基线、只记了意图的条目没有观测），而 `null` 在这里
 * 的含义是**「这一侧没有事实」**，不是「零」也不是「空内容」。
 */
function fileResultOf(
  item: ChangeItemRecord,
  row: OperationItemResultRow | undefined,
  last: ExecutionJournalRow | null,
  operationState: ChangeSetState,
): FileResult {
  if (row !== undefined) {
    return {
      state: fileStateOf(row.state, operationState),
      before_sha256: row.before_sha256,
      after_sha256: row.after_sha256,
      error_code: row.error_code,
    };
  }
  if (last !== null) {
    const verdict = journalVerdictOf(last, item.target_sha256);
    return {
      state: verdict.state,
      before_sha256: item.base_sha256,
      after_sha256: last.observed_sha256,
      error_code: verdict.error_code,
    };
  }
  // 两个来源都没有这一行。未终结时是「还没轮到它」，终结之后是**我们自己
  // 丢了事实** —— 把丢失报成 `PENDING` 与把未知报成成功是同一类错误。
  return {
    state: fileStateOf(undefined, operationState),
    before_sha256: null,
    after_sha256: null,
    error_code: null,
  };
}

/**
 * 一条修改集**唯一那个操作**的回执。没有操作行时是 `null`。
 *
 * 第三参数是 `Repositories` 而不是 `ChangeQueryDeps`（LWB-032）：回执不读
 * 任何快照字节，而写入侧（`@lwb/executor` 的应用服务）需要拿到**逐字同一份**
 * 回执，却没有任何理由为此持有一个 `BlobStore`。把依赖收窄到「真的用到的
 * 那个」，`change_apply` 与 `change_get` 才有可能共用本函数 —— 而共用正是
 * 要点：两份回执实现意味着同一个操作在两个工具里可以有不同的 `files`。
 */
function operationReceiptOf(
  record: ChangeSetRecord,
  items: readonly ChangeItemRecord[],
  repos: Repositories,
): OperationReceipt | null {
  const operation = repos.operations.findByChangeId(record.id);
  if (operation === null) return null;

  const results = new Map(repos.operations.itemResults(operation.id).map((row) => [row.item_id, row]));
  // 执行日志**读一次**，逐条目在内存里折叠：每个条目一条 SQL 会让一次
  // 多文件回执变成 N+1 次查询，而它们之间的账目还可能来自两个时刻。
  const events = repos.journal.list(operation.id);
  const files: OperationFileResult[] = items.map((item) => ({
    path: item.canonical_path,
    ...fileResultOf(item, results.get(item.id), lastEventOf(events, item.id), operation.state),
  }));

  return {
    operation_id: operation.id,
    change_id: operation.change_id,
    state: operation.state,
    recovered: operation.recovered,
    files,
    // 类型上是字面量 false：V1 不运行项目测试，因此这个字段没有别的可能，
    // 不存在「哪条路径忘了把它设成 false」的问题。
    tests_run: false,
    message: receiptMessageOf(operation.state),
    started_at: operation.started_at,
    finished_at: operation.finished_at,
  };
}

/**
 * 按 `change_id` 取那条回执。**写入侧唯一的回执入口**（LWB-032）。
 *
 * ## 它为什么是导出的
 *
 * `change_apply` 要回答「刚才那次应用的结果是什么」，而同一个问题
 * `change_get` 已经在回答了。让写入侧自己拼一份，就等于同一个操作有两个
 * 回执来源 —— 而它们迟早会在某一格上给出不同的答案（一个按日志折叠、
 * 一个按回执行、一个忘了过滤 `item_id` 为 `NULL` 的收场行），
 * 而那时**两个都说得通**，读的人没有任何办法分辨哪个是真的。
 *
 * ## 它**不做**归属检查，这是刻意的
 *
 * 归属（「这条修改集是不是本连接的」）由调用方在**更早**的一步完成
 * （工具面走 `ownedChangeOf`，控制台走认证过的本机会话）。把一次
 * 「不存在 vs 不是你的」的判定塞进一个回执构造函数里，只会让那条
 * 判定的两个调用点各自以为对方做了。
 */
export function operationReceiptFor(changeId: string, repos: Repositories): OperationReceipt | null {
  const record = repos.changes.findById(changeId);
  if (record === null) return null;
  return operationReceiptOf(record, repos.changes.items(record.id), repos);
}

/**
 * 批准摘要。**只给状态与有效期，不给批准人**。
 *
 * 优先取当前有效的那一条；没有有效的就取最近的一条（这样「批准过但又失效了」
 * 与「从来没批准过」是不同的两种事实）。返回里没有批准人字段：控制台会话
 * 标识是本机事实，模型没有理由知道它。
 */
function approvalSummaryOf(
  changeId: string,
  repos: Repositories,
): { readonly state: ApprovalState; readonly expires_at: string | null } | null {
  const record = repos.approvals.findActive(changeId) ?? repos.approvals.listForChange(changeId)[0] ?? null;
  if (record === null) return null;
  return { state: record.state, expires_at: record.expires_at };
}

// ---------------------------------------------------------------------------
// 差异
// ---------------------------------------------------------------------------

/**
 * 把快照字节读回来。**每次都比对哈希**（`getVerified`），不信数据库里的声明。
 *
 * 缺失或哈希不符一律抛出（LWB-007 验收标准 2）。这里**不**退化成
 * 「读不到就当作空内容」：那会把一份损坏的快照显示成「整文件被删除」，
 * 而调用方没有任何办法分辨。
 */
async function blobBytes(blobId: string, deps: ChangeQueryDeps): Promise<Buffer> {
  const record = deps.repos.blobs.requireById(blobId);
  return await deps.blobs.getVerified({
    sha256: record.sha256,
    size: record.size,
    storage_ref: record.storage_ref,
  });
}

/**
 * 两侧的**可比文本**。
 *
 * BOM 拼回行首，与 `@lwb/git-reader` 的 `comparableText` 同规矩：只有拼回去，
 * 「一边有 BOM 一边没有」才显示成一处改动。不拼的话两份字节的差异里
 * 恰好少了这一处，而那是一处**真实存在**的差异。
 *
 * 换行不做归一化（`splitLines` 只按 `\n` 切、`\r` 留在行尾），因此 CRLF 与 LF
 * 的差别会显示成整片改动。这不是缺陷，是本工程对「差异」的定义：
 * 它比较的是磁盘上的**字节**，不是 Git 在 `core.autocrlf=true` 下的语义。
 */
function comparableText(inspection: DecodedText): string {
  return inspection.bom ? `﻿${inspection.text}` : inspection.text;
}

/**
 * 拒绝不能当文本比的字节。
 *
 * 走到这里说明一条不变量被破坏了：能建立修改集的文件必须是可识别的文本
 * （`edit-contract.ts` 与 `text-engine.ts` 都核过）。因此这不是「用户遇到了
 * 一个二进制文件」，而是**我们自己的记录与快照对不上**。
 *
 * 此时不猜、不「尽力解释」，直接拒绝 —— 一份用「二进制不可比」掩盖了损坏的
 * 差异，会让调用方以为差异**只有**这些。
 */
function requireText(inspection: ByteInspection): DecodedText {
  if (inspection.kind === 'text') return inspection;
  throw new BridgeError('INTERNAL_ERROR', '快照字节不是可比较的文本，无法生成差异；已拒绝返回。', {
    reason: 'SNAPSHOT_NOT_TEXT',
  });
}

/**
 * 渲染成 unified diff。
 *
 * 严格按统一格式：`--- / +++` 头 + 若干 `@@ -a,b +c,d @@` 段，段内的每一行
 * 已经由 `diffLines` 带好了 ` `/`-`/`+` 前缀。**不添加任何自家格式的行**，
 * 包括「这里被截断了」那一句 —— 一段夹带了非格式行的 unified diff 会让
 * 任何解析它的工具静默地读错行号。截断这件事由 `truncated` 字段回答。
 *
 * `create_text` 的旧侧是 `/dev/null`：那里**没有**旧文件，这不是一个
 * 空文件。两者的区别在回滚与冲突判定里是实质性的，因此不接受把
 * `/dev/null` 写成 `a/<path>` 的「看起来更整齐」的版本。
 */
function renderUnified(path: string, hasOld: boolean, hasNew: boolean, hunks: readonly { readonly lines: readonly string[]; readonly old_start: number; readonly old_lines: number; readonly new_start: number; readonly new_lines: number }[]): string {
  const head = [`--- ${hasOld ? `a/${path}` : '/dev/null'}`, `+++ ${hasNew ? `b/${path}` : '/dev/null'}`];
  const body: string[] = [];
  for (const hunk of hunks) {
    body.push(`@@ -${hunk.old_start},${hunk.old_lines} +${hunk.new_start},${hunk.new_lines} @@`);
    body.push(...hunk.lines);
  }
  return [...head, ...body].join('\n');
}

/**
 * 单文件差异页：从快照库取两侧字节 → 渲染 unified diff → **经出站闸门**。
 *
 * ## 它为什么被导出（LWB-036）
 *
 * 控制台复核一个待批准的修改集时，看的必须是**同一份**差异 —— 同一套
 * 渲染、同一套截断口径、**同一道出站闸门**。让控制台另写一份渲染，
 * 就会有「模型看到的」与「操作者看到的」不是同一份东西的那一天，
 * 而批准绑定的摘要覆盖的是模型提议的那些字节：两份渲染之间的差异
 * 正是「操作者批准了 A、实际落地的是 B」的那条缝。
 *
 * ## 导出它**不**等于放宽归属检查
 *
 * 归属（`owner_connection_id`）不在这里，而在 `resolveChange` /
 * `requireOwned` —— 它们**没有**被导出。本函数接受一条已经解析出来的
 * `record`，因此调用方必须先自己回答「谁可以看这条修改集」：
 * 模型侧的回答是「必须是本连接的」（`changeGetDataOf`），
 * 控制台侧的回答是「必须是本机上的」（`apps/daemon/src/control/changes.ts`）。
 * 两个回答不同，而这个不同正是它们必须各自写在自己的入口上的理由。
 *
 * ## 它不是「读文件的另一条路」
 *
 * 两侧字节都来自快照库（`blobBytes`，每次比哈希），用户工作区一个字节
 * 都不碰 —— 与 `change_get` 走的是同一条路径，因此 LWB-032 的
 * 「提议与复核都不改用户工作区」在这里自动成立。
 */
export async function changeDiffPageOf(args: {
  readonly record: ChangeSetRecord;
  readonly items: readonly ChangeItemRecord[];
  readonly path: string;
  readonly context: ChangeReadContext;
  readonly limits: ChangeQueryLimits;
  readonly deps: ChangeQueryDeps;
}): Promise<ChangeDiffPage> {
  // 匹配用**规范拼写**：调用方给的可能是 `SRC/A.TXT`，磁盘上的对象是
  // `src/a.txt`。两者是同一个文件，因此这里按大小写不敏感比较，
  // 而后面出站用的是规范拼写（闸门判的、记录里存的都是它）。
  const item = args.items.find((candidate) => equalPathCaseInsensitive(candidate.canonical_path, args.path));
  if (item === undefined) {
    // 调用方自己发的路径，与它在本修改集里的存在性：`change.files` 已经
    // 把全部路径告诉它了，因此这条回答不含任何它还不知道的事实。
    throw new BridgeError('NOT_FOUND', '本修改集不包含该路径。', { reason: 'PATH_NOT_IN_CHANGE' });
  }

  // 规范拼写再判一次硬拒绝。**在碰快照之前**：闸门稍后还会再判一次
  // （它是权威的），但等到那时字节已经进了本进程的内存。
  const verdict = classifyFile(item.canonical_path, args.context.decision.rules);
  if (verdict.kind === 'hard_deny') {
    throw new BridgeError(
      'POLICY_DENIED',
      `该路径命中硬拒绝规则 ${verdict.rule_id}，不会经任何出站面返回内容。`,
      { hard_deny_rule: verdict.rule_id, blocked_at: 'query' },
    );
  }

  const oldBytes = item.old_blob_id === null ? null : await blobBytes(item.old_blob_id, args.deps);
  const newBytes = await blobBytes(item.new_blob_id, args.deps);
  const oldInspection = oldBytes === null ? null : inspectBytes(oldBytes);
  const newInspection = inspectBytes(newBytes);
  let unified: string;
  let truncated = false;
  if (item.op === 'delete_file' && oldInspection === null) {
    throw new BridgeError('INTERNAL_ERROR', '删除修改集缺少基线快照；已拒绝生成差异。', {
      reason: 'DELETE_BASELINE_MISSING',
    });
  }
  if (item.op === 'delete_file' && oldInspection !== null && oldInspection.kind !== 'text') {
    // Deletion supports arbitrary bytes. Show only standard metadata for binary or
    // undecodable files; never place their contents in a model-visible diff.
    unified = `diff --git a/${item.canonical_path} b/${item.canonical_path}\ndeleted file mode 100644\nBinary files a/${item.canonical_path} and /dev/null differ`;
  } else {
    const oldText = oldInspection === null ? null : requireText(oldInspection);
    const newText = requireText(newInspection);
    const result = diffLines(oldText === null ? '' : comparableText(oldText), comparableText(newText), {
      max_output_bytes: args.limits.max_diff_output_bytes,
      context_lines: args.limits.diff_context_lines,
      max_dp_cells: args.limits.max_dp_cells,
    });
    unified = renderUnified(item.canonical_path, oldBytes !== null, item.op !== 'delete_file', result.hunks);
    truncated = result.truncated;
  }

  // 内容出站的**唯一**入口。闸门会重判路径、重筛秘密、扣出站预算，
  // 并且因为本面是 `block`，命中高置信度凭证会让整份差异被拒。
  const clearance = mintClearance(args.context.decision, {
    connection_id: args.context.connection_id,
    generation: args.context.scope.generation,
  });
  const emission = emitContent(clearance, { path: item.canonical_path, content: unified }, args.context.budget);

  // 脱敏只替换命中的片段。真出现跨行替换，按行拼回去的差异就会**行号对不上**
  // —— 而行号是差异的全部意义。这一句不是保险，是让那个前提一旦不成立
  // 就当场失败（`git_diff` 对每个 hunk 做同一件事）。
  if (emission.content.split('\n').length !== unified.split('\n').length) {
    throw new BridgeError('INTERNAL_ERROR', '脱敏后的差异行数与原文不一致；已拒绝返回。', {
      reason: 'REDACTION_LINE_COUNT_CHANGED',
    });
  }

  return {
    path: item.canonical_path,
    unified: emission.content,
    truncated,
    // V1 单页：一份差异按字节上限整体裁剪，装不下的 hunk 整条丢弃
    // （`truncated` 置真）。既然永远没有下一页，就永远不发出游标 ——
    // 发一个换不来更多内容的游标，只会让调用方去循环。
    next_cursor: null,
  };
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

/**
 * `change_get`：一条修改集的当前状态、回执与（可选）逐文件差异。
 *
 * 分页游标**不接受**：本工具的单页就是全部（见 `diffPageOf` 的说明），
 * 因此任何传进来的游标都只可能来自臆造或客户端缓存。静默忽略它会让
 * 「我明明带了游标却没拿到下一页」变成一个查不出来的循环，所以拒绝。
 */
export async function changeGetDataOf(
  args: { readonly context: ChangeReadContext; readonly input: ChangeGetInput },
  deps: ChangeQueryDeps,
): Promise<ChangeGetData> {
  if (args.input.cursor !== undefined) {
    throw new BridgeError('INVALID_ARGUMENT', '本工具的差异是单页返回，不接受分页游标。', {
      reason: 'CURSOR_NOT_SUPPORTED',
    });
  }

  const limits = limitsOf(deps);
  const record = resolveChange(args.input, args.context.connection_id, deps.repos);
  const items = deps.repos.changes.items(record.id);

  const diff =
    args.input.path === undefined
      ? null
      : await changeDiffPageOf({ record, items, path: args.input.path, context: args.context, limits, deps });

  return {
    change: viewFor(record, items, deps),
    operation: operationReceiptOf(record, items, deps.repos),
    approval: approvalSummaryOf(record.id, deps.repos),
    diff,
  };
}

// ---------------------------------------------------------------------------
// 列表
// ---------------------------------------------------------------------------

/**
 * 列表游标：`v1|<created_at>|<id>`。
 *
 * ## 它**不是**凭证，也不该被当成凭证
 *
 * 读取侧的三个游标（分页、目录、搜索）都由 `ReadTicketAuthority` 签名，
 * 因为那些游标一旦被伪造就能指向**没读过**的范围。这一个不同：它只决定
 * 「从哪一行开始」，而返回哪些行完全由 SQL 里的
 * `owner_connection_id = ?`（外加可选的 `workspace_id`）决定。
 *
 * 于是伪造它的全部后果是**少看几条自己的记录**：跳过、或者从中间开始。
 * 越权在这条路径上不存在 —— 不是「被检查拦住了」，是查询里根本没有
 * 一个能让别的连接的行出现的分支。
 *
 * 签名的代价是引入第五种游标前缀与一次密钥依赖，换来的安全性为零。
 * 因此这里不签；而**不签**这件事必须是显式的：下面 `decodeCursor` 只校验
 * 形状，任何形状不对的游标都拒绝而不是「从头开始」。
 */
function encodeCursor(record: ChangeSetRecord): string {
  return Buffer.from(`v1|${record.created_at}|${record.id}`, 'utf8').toString('base64url');
}

interface Cursor {
  readonly created_at: string;
  readonly id: string;
}

function decodeCursor(raw: string): Cursor {
  const text = Buffer.from(raw, 'base64url').toString('utf8');
  const parts = text.split('|');
  const version = parts[0];
  const createdAt = parts[1];
  const id = parts[2];
  if (version !== 'v1' || parts.length !== 3 || !createdAt || !id) {
    // 拒绝而不是「从头开始」：静默重来会让调用方在两页之间无限循环，
    // 而它看到的每一页都是合法的。
    throw new BridgeError('INVALID_ARGUMENT', '游标无法识别；请省略游标以从第一页开始。', {
      reason: 'CURSOR_MALFORMED',
    });
  }
  return { created_at: createdAt, id };
}

/**
 * `change_list`：本连接自己的修改集，最新在前。
 *
 * `workspace_id` 是**收窄条件**而不是权限来源：它与 `owner_connection_id`
 * 一起进 SQL。给一个不属于自己的工作区 id 得到的是**空列表**而不是拒绝
 * —— 拒绝会把这个 id 是否存在变成一个可以被穷举的答案。
 *
 * 逐条取 `items().length` 是 N+1 次查询，上限 100 次、每次都是主键/外键
 * 上的小查询。这里选它而不是加一个 `COUNT(*)` 方法，是因为**文件的条数**
 * 与返回的条目是同一批事实：分两次查，中间就可能有一条修改集的状态变了，
 * 于是列表里的 `file_count` 与 `state` 来自两个时刻。
 */
export function changeListDataOf(
  args: { readonly connection_id: string; readonly input: ChangeListInput },
  deps: ChangeQueryDeps,
): ChangeListData {
  const limits = limitsOf(deps);
  const requested = args.input.max_items;
  const limit = Math.max(
    1,
    Math.min(requested === undefined ? limits.max_list_items : requested, limits.max_list_items),
  );

  const before = args.input.cursor === undefined ? null : decodeCursor(args.input.cursor);

  // 多取一条：它的存在与否就是「还有没有下一页」，不需要第二次查询
  // （两次查询之间多出来的一条会让 `truncated` 说谎）。
  const rows = deps.repos.changes.list({
    owner_connection_id: args.connection_id,
    ...(args.input.workspace_id === undefined ? {} : { workspace_id: args.input.workspace_id }),
    limit: limit + 1,
    ...(before === null ? {} : { before: before.created_at, before_id: before.id }),
  });

  const truncated = rows.length > limit;
  const page = rows.slice(0, limit);

  const changes: ChangeListEntry[] = page.map((record) => ({
    change_id: record.id,
    workspace_id: record.workspace_id,
    state: record.state,
    digest: record.digest,
    short_code: shortCodeOf(record.digest),
    summary: record.summary,
    created_at: record.created_at,
    file_count: deps.repos.changes.items(record.id).length,
  }));

  const last = page.at(-1);
  return {
    changes,
    next_cursor: truncated && last !== undefined ? encodeCursor(last) : null,
    truncated,
  };
}
