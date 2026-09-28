/**
 * 安全撤销提议（LWB-031 步骤 1–3；方案 §8.5、I12、验收项 A16）。
 *
 * ## 一句话：撤销是**新修改集**，不是把旧记录抹掉
 *
 * 方案 §8.5 原文：「撤销是新修改集，不是把旧记录删除。」
 * 本文件因此只做一件事 —— 把一条**已经应用**的修改集翻成一份**新的提案**，
 * 那份提案与任何别的提案走同一条路：`prepareChange` → `change_apply` → 执行器。
 * 它自己**不写盘**、**不签发批准**、**不碰旧记录的任何一个字节**。
 * 三条验收标准的后两条因此是结构性的，不是承诺：
 *
 *  - 「旧修改回执不可被篡改成『未发生』」：本文件里没有任何修改
 *    `changesets` / `operations` / `operation_item_results` 的调用。
 *    撤销的结果是一条**新增的行**，旧那一行原样留在那里。
 *  - 「撤销不改变 Git 暂存区，也不执行 reset --hard」：本文件对 `WinfsOps`
 *    只调用 `resolvePath` 与 `readFileGuarded` 两种；`child_process` 与
 *    `node:module` 由 `scripts/check-fsguard-imports.mjs` 静态挡住。
 *    「用 git 回滚」这条路上一个函数都不存在，所以它不可能被误用。
 *
 * 第一条验收标准（「后续人工修改不会被回滚覆盖」）落在逐条目的判定上，
 * 见下面「三种结局」。
 *
 * ## 三种结局，逐条决定
 *
 * | 盘上现在是什么 | 结局 | 凭什么 |
 * | --- | --- | --- |
 * | 正是我们写下的那一份 | `REVERTIBLE` | 身份 = 基线身份，内容 = 回执里**观测到**的那一份 |
 * | 删除后路径仍为空，且文本快照可逐字节重建 | `REVERTIBLE` | 生成新的 `create_text` 提案恢复基线 |
 * | 已经等于基线 | `ALREADY_ORIGINAL` | 没什么可撤的，也不生成条目 |
 * | 新建的文件还在 | `LOCAL_DELETE_REQUIRED` | 由操作者明确决定是否另调 `file_delete` |
 * | 其余（含身份对不上） | `CONFLICT` | 不覆盖，交给本地操作者 |
 *
 * 「正是我们写下的那一份」用的是 `operation_item_results.after_sha256`，
 * 而**不是** `change_items.target_sha256`。两者的差别是本工程反复强调的
 * 那一条：前者是**观察到的**，后者是**打算写的**。拿意图当观测，
 * 会把一次没有落盘（或落到别处）的执行显示成「盘上就是目标那一份」，
 * 于是一次撤销会去覆盖一个我们从没写过的内容。
 *
 * ## 删除与恢复
 *
 * 撤销一个新建文件在语义上就是删除它。虽然工具面现在有直接 `file_delete`，
 * 本撤销流程仍将这一步呈现为一条**给操作者的方案**（`LocalRecoveryAction`）：
 * 新建没有删除前基线，操作者可以选择保留它；本流程不替操作者推断删除意图。
 *
 * 而且这条方案**不声称归属**：新建没有基线身份可锚，方案里写的是
 * 「内容与创建时回读到的哈希一致」这个**事实**，不是「这个文件是我们的」。
 * 方案 §8.3：「不能猜测所有同名内容都属于插件。」
 *
 * 反方向（撤销一条已应用的 `delete_file`）则从已验证基线快照生成一个新的
 * `create_text` 提案。只有 UTF-8、可由 V1 换行/BOM 规则逐字节重建、且不超过
 * 文本恢复上限时才会生成；二进制、混合换行或过大的快照明确拒绝近似恢复。
 *
 * ## 「上次应用之后是什么」从哪里来 —— 执行日志，不是别的地方
 *
 * 这是本文件最要紧的一个数据来源问题，而它有一个**会被静默弄错**的答案。
 *
 * `operation_item_results` 看起来正合适（它有 `before_sha256` / `after_sha256`
 * 两列），但那张表**只有恢复流程会写**：一次干净地跑完的 `change_apply`
 * 从来不往它里面插行。拿它当回执，结果不是「偶尔读不到」而是**每一次都读不到**
 * —— 撤销会在所有正常情况下报「没有回执」，而那句报错听上去像是数据缺了，
 * 不像是有人找错了表。
 *
 * 真正记录「我们到底写下去、并回读到了什么」的是**执行日志**
 * （`journal_entries`，LWB-029）：每个条目在 `item_verified` 这个阶段上带着
 * 护栏回读得到的 `observed_file_id` 与 `observed_sha256`。那就是**观察**，
 * 与 `change_items.target_sha256` 那种**打算**是两回事 —— 本工程反复强调的
 * 正是这个区别，而这里是它第一次被用作一个写入决策的前提。
 *
 * 折叠规则与 `@lwb/executor` 的 `itemOutcomes` 一致：**取最后一条事件**，
 * 而不是「出现过某个阶段就算某件事」。一个条目可以先 `item_verified`
 * 再 `item_restore_failed`，按「出现过」折叠会把它报成「写成功了」。
 *
 * 阶段名在这里是**字面量**（`'item_verified'` 等）：`@lwb/executor` 依赖
 * `@lwb/changes` 的反方向会成环，因此那些常量够不着。这是一处刻意的
 * **跨包字面量耦合**，代价是「别人改了阶段名，这里会全部落进
 * `unaccounted`」—— 方向是 fail-closed（撤销停摆并说明原因，不会误判成
 * 「我们没写过」）。`tests/windows/changes-revert.test.ts` 里有一条断言把
 * 这些字面量与 `ITEM_STAGE` 逐个对齐，所以那次改名会在测试里当场变红。
 *
 * ## 为什么这里另有一套判定词，而不复用 `@lwb/recovery` 的 `classifyItem`
 *
 * 两个原因，第二个是决定性的：
 *
 *  1. **问的不是同一个问题。** `recovery/verdict.ts` 问的是「崩溃之后盘上
 *     现在是什么」，它的四格相对于**一条未终结的操作**，目的是把那条操作
 *     定案。本文件问的是「这条**已经定案为 APPLIED** 的修改，盘上还剩多少」，
 *     目的是生成一份新的提案。前者的输出是一个状态，后者的输出是一份提案。
 *  2. **依赖方向不允许。** `@lwb/recovery` 依赖 `@lwb/changes`（它要用
 *     `transitionChange`）。反向依赖会成环。这一条与本包 `single-flight.ts`
 *     把实现留在自己这里的理由完全相同 —— 在「一个实现 + 清晰的依赖方向」
 *     与「按题材归档」之间选前者。
 *
 * ## 撤销**不**沿用原计划的有效期（这一条是有结构的，不是口味）
 *
 * `revalidateExecutionBindings` 会因 `CHANGE_EXPIRED` 拒绝一条超过 24 小时的
 * 修改集。本文件把这一条**摘掉**，而摘掉它**不是**一次放宽 —— 原因是
 * `APPLIED` 这个状态在转移表上根本到不了 `EXPIRED`：
 *
 * ```
 * APPLIED: []          // 墓碑态，没有出边
 * EXPIRABLE_STATES     // = 能让出 EXPIRED 的格子 = PENDING_APPROVAL / APPROVED / QUEUED
 * ```
 *
 * 也就是说，对一条 `APPLIED` 的修改集来说 `expires_at` **在系统里没有任何
 * 作用点**：`sweepExpired` 扫不到它（它按 `EXPIRABLE_STATES` 取行），没有任何
 * 转移会因它发生。那一列保护的是**执行**（「一份躺在批准窗口外面的旧计划
 * 不该被拿去写盘」），而本文件既不执行那条旧计划，也不复用它的批准。
 *
 * 撤销问的是另一个问题：**盘上还是不是我们留下的那一份**。三个月前应用的
 * 一次修改，只要文件一个字节都没被碰过，撤销它就是安全的；反过来，十分钟前
 * 应用的一次修改只要被人改过，撤销就必须停下 —— 而这件事由**每一条自己的
 * 观测**回答，不由时钟回答。撤销**不复用旧的批准**：新的修改集是
 * `PENDING_APPROVAL`，拿的是从 `now` 起算的**新的** 24 小时。
 *
 * `#assertExpiryInapplicable` 把上面那段推理钉成一条会失败的断言：将来若有人
 * 给 `APPLIED` 加一条 `EXPIRED` 出边（也就是让这一列重新有意义），本模块会
 * **当场拒绝撤销**，而不是继续忽略一条已经生效的期限。
 */

import {
  BridgeError,
  LIMITS,
  type ChangeItem,
  type ChangeOp,
  type ChangeRevertLocalAction,
  type ChangeRevertPrepareData,
  type ChangeRevertPrepareInput,
  type ChangeSetState,
} from '@lwb/contracts';
import {
  inspectBytes,
  lineText,
  refOf,
  requireCanonicalPath,
  resolveTarget,
  type DecodedText,
  type ReadScope,
} from '@lwb/files';
import type { ChangeItemRecord, ChangeSetRecord } from '@lwb/persistence';
import { isWinfsError, type WinfsOps } from '@lwb/winfs';

import { shortCodeOf } from './digest.ts';
import { validateChangeItems, type ValidatedChangeItem, type ValidatedCreateText } from './edit-contract.ts';
import {
  EXECUTION_JOURNAL_STAGES,
  EXECUTION_JOURNAL_STAGES as STAGE,
  lastEventOf,
  type ExecutionJournalRow as JournalRow,
} from './execution-journal.ts';
import {
  EXPIRABLE_STATES,
  executionBindingErrorCode,
  executionBindingMessage,
  revalidateExecutionBindings,
  type ExecutionBindingReason,
} from './invalidation.ts';
import { prepareChange, type PrepareChangeArgs, type PrepareChangeDeps } from './prepare.ts';
import { ownedChangeOf } from './query.ts';
import { createTextFile, replaceWholeText } from './text-engine.ts';

/**
 * 幂等与审计里记录的**工具名**。
 *
 * 与 `CHANGE_PREPARE_TOOL` 分开是必须的，不是为了好看：幂等键的身份是
 * `(principal_id, tool, key)` 三段。共用同一个工具名，会让一次
 * `change_revert_prepare` 与一次 `change_prepare` 在同一个键上互相看见 ——
 * 而它们是两件不同的事。
 */
export const CHANGE_REVERT_PREPARE_TOOL = 'change_revert_prepare';

/**
 * 可以生成撤销提议的来源状态。**只有 `APPLIED`**。
 *
 * `RECOVERY_REQUIRED` 与 `CONFLICT` 都是「还没定案」：前者要等恢复流程
 * （`@lwb/recovery`）把现场判成 `APPLIED` 或 `ROLLED_BACK`，后者要等人处理。
 * 在定案之前生成一份撤销提议，会得到一份**基于一个还在变的现场**的提案，
 * 而它要拿本地批准 —— 一次建立在不确定现场上的批准，比一次拒绝糟糕得多。
 */
export const REVERTIBLE_CHANGE_STATES: readonly ChangeSetState[] = ['APPLIED'];

/**
 * 派生幂等键的前缀。
 *
 * `prepareChange` 内部用的是 `CHANGE_PREPARE_TOOL`，因此撤销最终写下的那条
 * 幂等记录与 `change_prepare` 同处一个命名空间。加前缀把两者在**肉眼上**
 * 就分开，并让派生键可复现（同一个 `change_id` + 同一个键 → 同一个派生键 →
 * 重复调用走重放而不是再建一份）。
 *
 * 万一有人手工用一个恰好长成这个形状的键调用 `change_prepare`，后果是
 * `IDEMPOTENCY_CONFLICT`（指纹不同）而不是一次错误的返回 —— 方向是 fail-closed。
 */
const REVERT_KEY_PREFIX = 'revert:';

// ---------------------------------------------------------------------------
// 词表
// ---------------------------------------------------------------------------

/**
 * 一条不能被自动撤销的原因。**每一个都要能说出口**，因为它们对应操作者
 * 下一步要做的不同的事。
 */
export type RevertConflictReason =
  /** 内容既不是我们写下的那一份，也不是基线 —— 有人改过它。 */
  | 'THIRD_CONTENT'
  /** 我们写下的那个对象不在了。这不是「回到了原状」，是现场少了一个东西。 */
  | 'OBJECT_MISSING'
  /** 内容对得上，但**对象换了**（删除重建、改名后另建）。 */
  | 'REPLACED_OBJECT'
  /** 两次打开之间目标被替换或改动。与 `prepare.ts` 用同一个理由名。 */
  | 'IDENTITY_CHANGED_BETWEEN_OPENS'
  /** 护栏自报不可用。**什么都没证明** —— 不是「没动过」，也不是「动过」。 */
  | 'GUARD_UNAVAILABLE'
  /** 别的读失败：权限、占用、路径不可达。 */
  | 'READ_FAILED'
  /** 基线字节不在快照库里。没有它就算不出逆操作 —— 快照不完整，停。 */
  | 'BASELINE_BLOB_MISSING'
  /** 基线字节不是可识别的文本（它本来是可编辑的，因此这是内部不一致）。 */
  | 'BASELINE_NOT_TEXT'
  /**
   * 目标文件当前**不能**按本工程的可编辑规则改写：混用换行、超过可编辑
   * 上限、有多个硬链接、或带只读属性。与 `file_read` 的 `editable_blockers`
   * 是同四条，见 `#requireStillEditable`。
   */
  | 'NOT_EDITABLE'
  /**
   * 引擎按当前文件重算出的逆内容，与基线**不是同一份字节**。
   *
   * 这一条是兜底的那一条：上面的判据全部通过，引擎却没能逐字节还原。
   * 它一旦出现，说明「按目标文件的换行风格重建基线文本」这件事在那个文件
   * 上不成立（例如基线与当前的换行风格不同），而那样的撤销会**静默地**
   * 改写用户文件里没被本次修改碰过的行。
   */
  | 'INVERSE_NOT_REPRODUCIBLE'
  /** 执行回执不完整或自相矛盾：没有这一条的回执、没观测到哈希、或哈希与目标不符。 */
  | 'RECEIPT_INCOMPLETE'
  /**
   * 执行时这个文件**已经是**目标内容，因此本次执行没有写过它。
   *
   * 这一条要单独说，因为它容易被当成 `ALREADY_ORIGINAL` 混过去：「盘上
   * 就是批准的那一份」听起来像是「我们成功了」。但撤销要问的是另一件事 ——
   * 盘上这一份是**谁的**效果。执行没写过它，撤销就没有资格去还原它。
   */
  | 'EXECUTION_SKIPPED';

/** 一条的下场。四个值，逐条给出。 */
export type RevertVerdict =
  /** 盘上正是我们写下的那一份，可以生成逆操作。 */
  | 'REVERTIBLE'
  /** 盘上已经等于基线，没什么可撤的（也不生成条目）。 */
  | 'ALREADY_ORIGINAL'
  /** 新建的文件还在：V1 不删，交给本地操作者。 */
  | 'LOCAL_DELETE_REQUIRED'
  /** 其余情形。**不覆盖**。 */
  | 'CONFLICT';

/** 逐条目的处置。**它是这一层的输出，也是证据能逐个断言的东西。** */
export interface RevertItemPlan {
  readonly item_id: string;
  readonly seq: number;
  readonly op: ChangeOp;
  /** 修改集里记的路径：**建立那份修改集时**的磁盘拼写。 */
  readonly path: string;
  /** 这一次观测到的磁盘拼写。中间改过名时与 `path` 不同。 */
  readonly observed_path: string | null;
  readonly verdict: RevertVerdict;
  /** 只有 `CONFLICT` 才有。 */
  readonly reason: RevertConflictReason | null;
  /** 回执里**观测到**的、我们留下的那一份。撤销的比对标的就是它。 */
  readonly expected_sha256: string | null;
  readonly observed_sha256: string | null;
  /** 可以呈现给操作者的一句说明。**不含**任何本机绝对路径与正文。 */
  readonly detail: string;
}

/**
 * 一份给**本地操作者**的恢复方案（步骤 3）。
 *
 * 它的每一条都是一个 V1 做不了、但必须说清楚的动作。`instruction` 是
 * **固定文案**：它描述的是一条不可协商的流程（文件由人来删），因此不能
 * 由不受信的一方措辞 —— 与 `NEXT_ACTION_PENDING_APPROVAL` 同规矩。
 *
 * ## 它是契约里那个接口的**别名**，不是一份平行定义
 *
 * 本类型的每一条都会**原样**出现在 `change_revert_prepare` 的工具结果里
 * （`ChangeRevertPrepareData.local_actions`）。两边各写一份结构相同的接口，
 * 就多出一处「改了这边忘了那边」的地方 —— 而这里的忘记方式恰好是最糟的
 * 那一种：契约侧多要求一个字段，本模块不产它，输出 schema 是 `strictObject`，
 * 于是每一次成功的撤销都变成一句「工具结果不符合输出契约」。
 * 本包已经有过一次同形状的事故（`ChangeRevertPrepareData.change` 的类型
 * 偏差，见 `@lwb/contracts` 里那段说明），因此这次直接让它**只有一个定义**。
 */
export type LocalRecoveryAction = ChangeRevertLocalAction;

export interface RevertPlan {
  readonly source_change_id: string;
  readonly source_operation_id: string;
  readonly source_digest: string;
  readonly source_short_code: string;
  readonly workspace_id: string;
  /** 与 `source.items` 同序、逐条给出。**含冲突**：一份计划要说全。 */
  readonly items: readonly RevertItemPlan[];
  /**
   * 可以据此建立的**逆向提案**。只含 `REVERTIBLE` 的条目，且自带
   * **当场签发**的读取票据 —— 票据绑定的基线是「此刻盘上的字节」，
   * 也就是撤销之后应当被还原掉的那一份。
   */
  readonly proposal: readonly ChangeItem[];
  readonly local_actions: readonly LocalRecoveryAction[];
}

export interface RevertPrepareArgs {
  /** 来自 IPC 通道的**认证身份**，不是工具参数（ADR-003 §4）。 */
  readonly principal_id: string;
  /** 建立本次撤销提议的连接。撤销集归属于它，与来源修改集是谁建的无关。 */
  readonly connection_id: string;
  readonly workspace_id: string;
  /** 授权时的代次。落库为撤销集的 `root_generation`。 */
  readonly generation: number;
  /** 本次授权所依据的策略版本。落库为撤销集的 `policy_version`。 */
  readonly policy_version: number;
  readonly scope: ReadScope;
  readonly now: number;
  readonly input: ChangeRevertPrepareInput;
}

/**
 * 与 `PrepareChangeDeps` 同一批依赖，一个都不多。
 *
 * 单独立一个别名而不是直接用 `PrepareChangeDeps`，是为了让「撤销要什么」
 * 成为一个可以被读到的接口：它要护栏（读）、票据权威（签票）、快照库
 * （取基线字节）、状态库（读回执、写新修改集）—— **没有写用户文件那一样**，
 * 因此上面那句「本文件不写盘」在类型上也是看得见的。
 */
export type RevertPrepareDeps = PrepareChangeDeps;

// ---------------------------------------------------------------------------
// 错误
// ---------------------------------------------------------------------------

function conflictError(
  reason: RevertConflictReason,
  message: string,
  extra: Readonly<Record<string, string | number | boolean | null>> = {},
): BridgeError {
  // 用 `FILE_VERSION_CONFLICT` 而**不是** `INTERNAL_ERROR`：它的
  // `autoRetry` 是 `refetch`，也就是「重新读一次再来」—— 对「有人动过这个
  // 文件」这一类事实，那正是唯一正确的下一步。
  return new BridgeError('FILE_VERSION_CONFLICT', message, { reason, ...extra });
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

/**
 * 规划一次撤销。**不做任何写入、不建立任何修改集。**
 *
 * 它回答的是「这条修改集现在还能被撤销到什么程度」，因此冲突**不抛错**，
 * 而是作为逐条目的判定交出去。要不要因为一条冲突就整体拒绝，是
 * `prepareRevert` 的政策（本工程的政策是：拒绝，见那里的说明）。
 *
 * 规划会**签发新的读取票据**（每条可撤销的条目一张）。票据绑定的基线是
 * 此刻盘上的字节，因此「读到这里」与「据此写下去」之间没有窗口：
 * 期间有人改过文件，`prepareChange` 的重读会当场拒掉。
 */
export async function planRevert(
  args: RevertPrepareArgs,
  deps: RevertPrepareDeps,
): Promise<RevertPlan> {
  const source = requireRevertibleSource(args, deps);

  // 操作必须存在，且它自己也得定案成 `APPLIED`。只查修改集的状态是不够的：
  // 两者理论上总是一致（状态流转在同一处进行），但**「理论上一致」不是
  // 一条可以在写盘路径上依赖的性质** —— 一旦不一致，按哪一边走都是猜。
  const operation = deps.repos.operations.findByChangeId(source.id);
  if (operation === null || operation.state !== 'APPLIED') {
    throw new BridgeError(
      'CHANGE_STATE_INVALID',
      `不能对这条修改集生成撤销提议：它的执行记录${operation === null ? '不存在' : `状态是 ${operation.state}`}，没有一份可以拿来比对的「上次应用之后」的回执。`,
      { reason: 'RECEIPT_INCOMPLETE', operation_state: operation?.state ?? null },
    );
  }

  // 一次取回这本账，然后逐条目折叠。`journal.list` 已按 seq 升序，
  // 因此每个条目最后一次出现的那个阶段就是它的终局。
  const events = deps.repos.journal.list(operation.id);
  const items = deps.repos.changes.items(source.id);

  const plans: RevertItemPlan[] = [];
  const proposal: ChangeItem[] = [];
  const localActions: LocalRecoveryAction[] = [];

  for (const item of items) {
    const disposition = dispositionOf(events, item.id, item.target_sha256, item.op);
    const planned =
      item.op === 'create_text'
        ? await planCreatedItem(item, args, deps, disposition)
        : item.op === 'delete_file'
          ? await planDeletedItem(item, args, deps, disposition)
        : await planRewriteItem(item, args, deps, disposition);

    plans.push(planned.plan);
    if (planned.proposal !== null) proposal.push(planned.proposal);
    if (planned.local_action !== null) localActions.push(planned.local_action);
  }

  return Object.freeze({
    source_change_id: source.id,
    source_operation_id: operation.id,
    source_digest: source.digest,
    source_short_code: shortCodeOf(source.digest),
    workspace_id: source.workspace_id,
    items: Object.freeze(plans),
    proposal: Object.freeze(proposal),
    local_actions: Object.freeze(localActions),
  });
}

/**
 * 生成一份**新的**逆向修改集（契约里 `change_revert_prepare` 的那个形状）。
 *
 * ## 一条冲突就让整件事停下
 *
 * 方案 §8.4 对「第三种内容」的要求是保留现场、不自动覆盖。若允许部分撤销，
 * 结果是一份**既不是撤销前、也不是撤销后**的混合现场 —— 而方案反复要求的
 * 是任何部分/未知结果都必须显式暴露（I11）。这里选的暴露方式是**拒绝**：
 * 一条都不建，并把挡路的那几条指名。
 *
 * 代价是如实的：四个文件里有一个被人改过时，另外三个也不能通过这条路撤销，
 * 操作者要自己编辑。这是刻意的取舍 —— 一份「撤了一半」的工作区需要人去
 * 判断剩下的那一半算不算撤销完成，而那个判断本工程做不了。
 *
 * ## 新建文件不阻断编辑的撤销
 *
 * 新建那一条不属于「未知」，属于「已知但本版本没有能力执行」（删除）。
 * 因此它**不**让整件事失败：能撤的条目照常变成一份修改集，新建文件另附
 * 一条给操作者的方案。已知但做不到 ≠ 不确定。
 */
export async function prepareRevert(
  args: RevertPrepareArgs,
  deps: RevertPrepareDeps,
): Promise<ChangeRevertPrepareData> {
  const plan = await planRevert(args, deps);

  const blocked = plan.items.filter((entry) => entry.verdict === 'CONFLICT');
  if (blocked.length > 0) {
    const first = blocked[0];
    throw conflictError(
      first?.reason ?? 'THIRD_CONTENT',
      `不能撤销：${blocked.length} 个文件已经不是本次修改留下的那一份，撤销会覆盖它们；` +
        `本次没有建立任何修改集。挡路的是：${blocked.map((entry) => entry.path).join('、')}。`,
      { blocked_files: blocked.length, total_files: plan.items.length, blocking_path: first?.path ?? null },
    );
  }

  const localActionRequired = plan.local_actions.length > 0;

  if (plan.proposal.length === 0) {
    // 两种走到这里的方式，含义完全不同，因此由 `local_actions` 区分：
    //  - 全是新建文件：有一份要人做的方案，本条只是「没有可自动撤销的条目」；
    //  - 全是「已经等于基线」：真的无事可做。
    if (localActionRequired) {
      return Object.freeze({
        change: null,
        local_action_required: true,
        local_action_reason: localReasonOf(plan),
        local_actions: plan.local_actions,
      });
    }
    throw new BridgeError(
      'CHANGE_STATE_INVALID',
      '这条修改集在磁盘上的效果已经不存在：每个文件都等于它们在这份修改集里的基线内容，没有可撤销的内容，也没有建立修改集。',
      { reason: 'NOTHING_TO_REVERT', files: plan.items.length },
    );
  }

  const source = deps.repos.changes.requireById(plan.source_change_id);
  const input = {
    workspace_id: args.workspace_id,
    idempotency_key: `${REVERT_KEY_PREFIX}${source.id}:${args.input.idempotency_key}`,
    summary: revertSummaryOf(source, plan.proposal.length),
    items: plan.proposal,
  };

  const prepareArgs: PrepareChangeArgs = {
    principal_id: args.principal_id,
    connection_id: args.connection_id,
    workspace_id: args.workspace_id,
    generation: args.generation,
    policy_version: args.policy_version,
    scope: args.scope,
    now: args.now,
    input,
  };

  const created = await prepareChange(prepareArgs, deps);

  return Object.freeze({
    change: created,
    local_action_required: localActionRequired,
    local_action_reason: localActionRequired ? localReasonOf(plan) : null,
    local_actions: plan.local_actions,
  });
}

// ---------------------------------------------------------------------------
// 来源修改集的准入
// ---------------------------------------------------------------------------

/**
 * 取出源修改集，并判它现在还能不能被撤销。
 *
 * 归属用 `ownedChangeOf` —— **不重写一遍**。「不是你的」与「不存在」必须
 * 给出**逐字相同**的回答，而这条规则只在 `query.ts` 里有一份实现（它连
 * `details` 都不带，就是为了不让两者被区分开）。在这里重写一遍，就多了一处
 * 可以忘记带上 `details: undefined` 的地方。
 */
function requireRevertibleSource(args: RevertPrepareArgs, deps: RevertPrepareDeps): ChangeSetRecord {
  const owned = ownedChangeOf({ change_id: args.input.change_id }, args.connection_id, deps.repos);
  if (owned.workspace_id !== args.workspace_id) {
    // 到了这一步归属已经确认过了，因此这句话里没有不属于调用方的事实。
    throw new BridgeError('INVALID_ARGUMENT', '这条修改集属于另一个工作区，不能在本工作区撤销。', {
      reason: 'CHANGE_WORKSPACE_MISMATCH',
    });
  }
  const source = deps.repos.changes.requireById(owned.change_id);

  const binding = revalidateExecutionBindings({
    change: source,
    workspace: deps.repos.workspaces.findById(source.workspace_id),
    connection: deps.repos.connections.findById(source.owner_connection_id),
    now: new Date(args.now).toISOString(),
    allowed_from: REVERTIBLE_CHANGE_STATES,
  });

  // `CHANGE_EXPIRED` 被摘掉，理由见文件头那一节：`APPLIED` 到不了 `EXPIRED`，
  // 那一列对这条修改集没有作用点。**只摘这一条**：其余每一条（代次、策略版本、
  // 契约版本、工作区与连接状态）都照旧生效 —— 它们说的是「这次撤销所依据的
  // 授权事实还在不在」，与时间无关。
  assertExpiryInapplicable();
  const reasons = binding.reasons.filter((reason) => reason !== 'CHANGE_EXPIRED');
  const primary = reasons[0];
  if (primary !== undefined) {
    throw bindingFailure(primary, source);
  }

  return source;
}

/**
 * 上面那句「摘掉 `CHANGE_EXPIRED` 不是放宽」的**证明义务**。
 *
 * 摘掉它的全部依据是「`APPLIED` 在转移表上到不了 `EXPIRED`」。那是一条关于
 * **另一张表**的事实，因此它会被别人改。这里把它变成一次现算：一旦
 * `APPLIED` 进了 `EXPIRABLE_STATES`（也就是这一列重新有了作用点），
 * 撤销立刻停止工作并说明原因 —— 而不是继续安静地忽略一条已经生效的期限。
 *
 * 代价是每次调用一次两次 `includes`。收益是：这条推理不会在某个下午
 * 被一次「顺手加一条边」变成一句假话。
 */
function assertExpiryInapplicable(): void {
  if (EXPIRABLE_STATES.includes('APPLIED')) {
    throw new BridgeError(
      'INTERNAL_ERROR',
      '撤销的前提被破坏了：`APPLIED` 现在能转移到 `EXPIRED`，因此这条修改集的批准期限是有效的，' +
        '而本流程按「期限已无作用点」摘掉了那次判定。请先修复撤销的期限语义，不要绕过它。',
      { reason: 'EXPIRY_NOW_APPLICABLE' },
    );
  }
}

function bindingFailure(reason: ExecutionBindingReason, source: ChangeSetRecord): BridgeError {
  return new BridgeError(
    executionBindingErrorCode(reason),
    `不能对这条修改集生成撤销提议（当前状态 ${source.state}）：${executionBindingMessage(reason)}`,
    {
      reason,
      current_state: source.state,
      revert_allowed_from: REVERTIBLE_CHANGE_STATES.join(','),
    },
  );
}

// ---------------------------------------------------------------------------
// 执行日志的折叠
// ---------------------------------------------------------------------------

/**
 * 执行日志里属于本模块的那几个阶段名。
 *
 * 表本身搬到了 `execution-journal.ts`（LWB-032）：`query.ts` 的回执要读
 * **同一张表**，而本文件与 `query.ts` 互相 import（`revert.ts` 用
 * `query.ts` 的 `ownedChangeOf`），因此两个都从第三个模块取。
 * 抄写必须有一条测试兜着的那件事没有变 —— `tests/windows/changes-revert.test.ts`
 * 的 A5 仍然**逐键**对齐这张表与 `ITEM_STAGE`，这里只是把名字再导出一遍，
 * 好让那条测试（与包外的读者）不必知道表搬过家。
 */
export const REVERT_JOURNAL_STAGES = EXECUTION_JOURNAL_STAGES;

/**
 * 一个条目在**执行日志**里的终局 —— 也就是「上次应用之后，我们在这个文件上
 * 到底留下了什么」这个问题的答案。
 *
 * 四格，而每一格都对应一个**不同的动作**：
 *
 * | 取值 | 日志说的 | 撤销该怎么办 |
 * | --- | --- | --- |
 * | `written` | 写下去了，回读核验过 | 可以还原（还要再当场观测一次） |
 * | `back_at_baseline` | 写下去过，随后被本次执行收了回去 | 无需还原 |
 * | `skipped` | 执行时它**已经是**目标内容，没动 | 不是我们的效果，停 |
 * | `unaccounted` | 失败 / 只写了没核验 / 日志缺行 | 不知道，停 |
 *
 * `unaccounted` 把 `left_changed` 与 `unknown` 合成一格，因为它们的**动作**
 * 相同：不撤销。把它们分开只对排障有意义，而原因已经写在 `detail` 里。
 */
type ItemDisposition =
  | { readonly kind: 'written'; readonly file_id: string; readonly sha256: string }
  | { readonly kind: 'deleted' }
  | { readonly kind: 'back_at_baseline' }
  | { readonly kind: 'skipped' }
  | { readonly kind: 'unaccounted'; readonly reason: RevertConflictReason; readonly detail: string };

/**
 * 折叠一个条目的执行日志。
 *
 * **取最后一条**（`lastEventOf`，与 `@lwb/executor` 的 `itemOutcomes` 同一条
 * 规则、同一个理由：一个条目可以先成功再被回滚，按「出现过某个阶段」折叠
 * 会把「写下去了，然后收了回来」读成「写成功了」—— 那是把部分完成当全成功）。
 * 「怎么取最后一条」这件事在 `execution-journal.ts` 里只有一份实现，
 * 因为 `query.ts` 的回执折叠要用**逐字同一个**规则。
 *
 * 与 `itemOutcomes` 的差别只有一处：本函数把 `verified` 那条上的
 * `observed_file_id` / `observed_sha256` **取出来**，因为撤销要拿它们当
 * 比对标；`itemOutcomes` 只给一个终局类别，丢掉了观测值。
 *
 * 目标哈希交叉核对也在这一层做：`verified` 说「回读与已批准的新内容逐字节
 * 相同」，那条日志自己记着 `target_sha256`。三者（回读哈希、日志里的目标、
 * 修改集记录的目标）必须一致 —— 一方对不上就是账目矛盾，不猜哪一边对。
 */
function dispositionOf(
  events: readonly JournalRow[],
  itemId: string,
  targetSha256: string,
  op: ChangeOp,
): ItemDisposition {
  const last = lastEventOf(events, itemId);

  if (last === null) {
    return {
      kind: 'unaccounted',
      reason: 'RECEIPT_INCOMPLETE',
      detail: '这次执行的日志里没有这个条目的任何一行；它有没有被写过无从得知。',
    };
  }

  switch (last.stage) {
    case STAGE.verified: {
      const fileId = last.observed_file_id;
      const observed = last.observed_sha256;
      if (fileId === null || observed === null) {
        return {
          kind: 'unaccounted',
          reason: 'RECEIPT_INCOMPLETE',
          detail: '日志说这个条目已核验，却没有记下回读到的对象身份或哈希。',
        };
      }
      if (last.target_sha256 !== null && last.target_sha256 !== targetSha256) {
        return {
          kind: 'unaccounted',
          reason: 'RECEIPT_INCOMPLETE',
          detail: '日志里的目标哈希与修改集记录的目标哈希不一致；这是内部记录矛盾，不据此撤销。',
        };
      }
      if (observed !== targetSha256) {
        return {
          kind: 'unaccounted',
          reason: 'RECEIPT_INCOMPLETE',
          detail: `日志说已核验，但回读到的哈希（${observed}）并不是批准写入的那一份（${targetSha256}）。`,
        };
      }
      return { kind: 'written', file_id: fileId, sha256: observed };
    }
    case STAGE.deleted:
      if (
        op !== 'delete_file' ||
        last.observed_file_id !== null ||
        last.target_sha256 !== targetSha256 ||
        last.observed_sha256 !== targetSha256
      ) {
        return {
          kind: 'unaccounted',
          reason: 'RECEIPT_INCOMPLETE',
          detail: '删除日志与修改项不匹配，或缺少“路径不存在”的目标哈希核验。',
        };
      }
      return { kind: 'deleted' };
    case STAGE.restored:
    case STAGE.untouched:
      // 两种都**可证明**磁盘上没有本次执行的字节：前者收回了，后者没写过。
      return { kind: 'back_at_baseline' };
    case STAGE.skipped:
      return { kind: 'skipped' };
    case STAGE.failed:
    case STAGE.restore_failed:
    case STAGE.restore_skipped:
      return {
        kind: 'unaccounted',
        reason: 'RECEIPT_INCOMPLETE',
        detail: '这次执行在这个条目上失败或放弃收回，磁盘上可能留着本次执行的字节。',
      };
    case STAGE.written:
    case STAGE.flushed:
      // `written` / `flushed` 单独收尾（后面没有 `verified`）意味着**没有
      // 回读核验**。护栏今天把三条写在同一个事务里，因此这不该出现；
      // 一旦出现就说明账目被改过或来自别的版本 —— 不声称刷过盘。
      return {
        kind: 'unaccounted',
        reason: 'RECEIPT_INCOMPLETE',
        detail: '日志停在了「已写出」而没有后续的核验；不能声称那个内容真的落到了盘上。',
      };
    case STAGE.intent:
      return {
        kind: 'unaccounted',
        reason: 'RECEIPT_INCOMPLETE',
        detail: '日志只记下了「这就开始动这个文件」，没有下文。',
      };
    default:
      // 认不出的阶段名：**不**当成「没写过」。未知就是未知。
      return {
        kind: 'unaccounted',
        reason: 'RECEIPT_INCOMPLETE',
        detail: `日志里出现了一个本版本不认识的阶段名（${last.stage}）；不据此推断它写了什么。`,
      };
  }
}

// ---------------------------------------------------------------------------
// 改写条目（edit_text / replace_text）
// ---------------------------------------------------------------------------

interface PlannedEntry {
  readonly plan: RevertItemPlan;
  readonly proposal: ChangeItem | null;
  readonly local_action: LocalRecoveryAction | null;
}

/**
 * 一条改写的处置。
 *
 * 顺序是刻意的，每一步都在**缩小**接下来要相信的东西：
 *
 *  1. 先看**回执**：这一条当时到底写成了没有，观测到的哈希是什么。
 *  2. 再**当场观测**盘上：对象还是不是那一个，内容还是不是那一份。
 *  3. 只有前两步都指向「正是我们写下的那一份」，才去取基线字节、算逆内容，
 *     并**用它跑一遍引擎**，确认产物与基线逐字节相同。
 *
 * 第 3 步是这一步存在的理由：把「逆操作」这个概念落到字节上，靠的不是
 * 「旧字节就是基线字节」这句推理（真的），而是「引擎按**当前文件**重建出来
 * 的东西等于基线」这件**可以被验**的事实。中间隔着目标文件的换行风格与 BOM，
 * 而这两样东西在两次写入之间可能变过。算不对就拒绝，绝不写一份「差不多」
 * 的还原回去。
 */
async function planRewriteItem(
  item: ChangeItemRecord,
  args: RevertPrepareArgs,
  deps: RevertPrepareDeps,
  disposition: ItemDisposition,
): Promise<PlannedEntry> {
  const base = {
    item_id: item.id,
    seq: item.seq,
    op: item.op,
    path: item.canonical_path,
  } as const;

  const conflicted = (reason: RevertConflictReason, detail: string, observed: string | null = null): PlannedEntry => ({
    plan: {
      ...base,
      observed_path: null,
      verdict: 'CONFLICT',
      reason,
      expected_sha256: null,
      observed_sha256: observed,
      detail,
    },
    proposal: null,
    local_action: null,
  });

  if (item.base_file_id === null || item.base_sha256 === null || item.old_blob_id === null) {
    return conflicted(
      'RECEIPT_INCOMPLETE',
      `${item.canonical_path} 是一条改写，却没有基线身份、基线哈希或基线快照；这一条无法被撤销，保留现场。`,
    );
  }

  if (disposition.kind === 'unaccounted' || disposition.kind === 'skipped' || disposition.kind === 'deleted') {
    return conflicted(
      disposition.kind === 'skipped' ? 'EXECUTION_SKIPPED' : 'RECEIPT_INCOMPLETE',
      disposition.kind === 'skipped'
        ? `${item.canonical_path} 在本次执行时**已经是**批准的那一份内容，执行器跳过了它 —— 它现在这个样子不是本次修改造成的，因此本流程没有资格去还原它。`
        : disposition.kind === 'deleted'
          ? `${item.canonical_path} 的日志记录了删除，但修改项不是 delete_file；拒绝按改写撤销。`
          : `${item.canonical_path}：${disposition.detail}`,
    );
  }
  if (disposition.kind === 'back_at_baseline') {
    return {
      plan: {
        ...base,
        observed_path: null,
        verdict: 'ALREADY_ORIGINAL',
        reason: null,
        expected_sha256: null,
        observed_sha256: null,
        detail: `${item.canonical_path} 在本次执行结束时就已经回到了基线（执行日志可证明没留下本次执行的字节），这一条不需要撤销。`,
      },
      proposal: null,
      local_action: null,
    };
  }

  const expected = disposition.sha256;
  if (disposition.file_id !== item.base_file_id) {
    // 批准绑定的是那个对象，回读到的却是另一个 —— 不变量被破坏了。
    return conflicted(
      'RECEIPT_INCOMPLETE',
      `${item.canonical_path} 的执行日志记下的对象身份与修改集记录的基线身份不一致；这是内部记录矛盾，不据此撤销。`,
      expected,
    );
  }

  const observation = await observePath(deps.ops, args.scope, item.canonical_path);

  if (observation.kind === 'unavailable') {
    return conflicted(observation.reason, observation.detail);
  }
  if (observation.kind === 'absent') {
    return conflicted(
      'OBJECT_MISSING',
      `${item.canonical_path} 在当前工作区里不存在。被批准的那个对象不在了 —— 这不是「回到了原状」，是现场少了一个东西。`,
    );
  }
  if (observation.file_id !== item.base_file_id) {
    return conflicted(
      'REPLACED_OBJECT',
      `${item.canonical_path} 的位置上现在是另一个对象（${observation.file_id}），不是被批准的那一个（${item.base_file_id}）；写回去会写到批准范围之外的对象上。`,
      observation.sha256,
    );
  }

  if (observation.sha256 === item.base_sha256) {
    return {
      plan: {
        ...base,
        observed_path: observation.canonical_path,
        verdict: 'ALREADY_ORIGINAL',
        reason: null,
        expected_sha256: expected,
        observed_sha256: observation.sha256,
        detail: `${item.canonical_path} 已经是基线内容（对象身份也对得上），这一条不需要撤销。`,
      },
      proposal: null,
      local_action: null,
    };
  }

  if (observation.sha256 !== expected) {
    return conflicted(
      'THIRD_CONTENT',
      `${item.canonical_path} 的当前内容既不是我们写下的那一份（${expected}）也不是基线；它是一个第三种内容，本流程不覆盖它。`,
      observation.sha256,
    );
  }

  const blocking = requireStillEditable(observation.bytes, observation.size, observation.link_count, observation.attributes);
  if (blocking !== null) {
    return conflicted('NOT_EDITABLE', `${item.canonical_path} 当前不能按本工程的可编辑规则改写：${blocking}`, observation.sha256);
  }

  const currentInspection = inspectBytes(observation.bytes);
  if (currentInspection.kind !== 'text') {
    return conflicted(
      'THIRD_CONTENT',
      `${item.canonical_path} 的当前字节不是可识别的 UTF-8 文本（${currentInspection.reason}），无法在其上重建基线。`,
      observation.sha256,
    );
  }

  const baselineBytes = await readBaselineBlob(item.old_blob_id, item.base_sha256, deps);
  if (baselineBytes === null) {
    return conflicted(
      'BASELINE_BLOB_MISSING',
      `${item.canonical_path} 的基线快照不在快照库里（或校验不过）。没有基线就算不出逆操作 —— 快照不完整，停。`,
      observation.sha256,
    );
  }
  const baselineInspection = inspectBytes(baselineBytes);
  if (baselineInspection.kind !== 'text') {
    return conflicted(
      'BASELINE_NOT_TEXT',
      `${item.canonical_path} 的基线快照不是可识别的文本（${baselineInspection.reason}）；一份本应可编辑的基线解不开，是内部不一致，不据此撤销。`,
      observation.sha256,
    );
  }

  const content = contentOfDecoded(baselineInspection);
  const ticket = deps.authority.mintReadTicket(
    {
      connection_id: args.connection_id,
      workspace_id: args.workspace_id,
      generation: args.generation,
      canonical_path: observation.canonical_path,
      volume_id: observation.volume_id,
      file_id: observation.file_id,
      raw_bytes_sha256: observation.sha256,
      size: observation.size,
      total_lines: currentInspection.lines.total_lines,
      // 一次整读：撤销用的是**整个文件**，不是一页。
      range_start: 1,
      range_end_exclusive: currentInspection.lines.total_lines + 1,
      truncated: false,
      truncated_lines: [],
      editable: true,
      editable_blockers: [],
      redacted: false,
    },
    { now: args.now, ttl_ms: LIMITS.READ_TOKEN_TTL_MS },
  );

  const candidate: ChangeItem = {
    op: 'replace_text',
    // 用**这一次观测到的磁盘拼写**，不是修改集里记的那个：中间改过名时，
    // 只有磁盘拼写能被护栏的句柄核对通过（与 `recovery` 的处置同一个理由）。
    path: observation.canonical_path,
    base_sha256: observation.sha256,
    read_token: ticket,
    content,
  };

  const reproduced = reproduceInverse(candidate, observation.bytes, args, deps);
  if (!reproduced.ok) {
    return conflicted('INVERSE_NOT_REPRODUCIBLE', `${item.canonical_path}：${reproduced.detail}`, observation.sha256);
  }
  if (reproduced.sha256 !== item.base_sha256) {
    return conflicted(
      'INVERSE_NOT_REPRODUCIBLE',
      `${item.canonical_path} 的逆内容按当前文件重算之后与基线不是同一份字节` +
        `（期望 ${item.base_sha256}，算得 ${reproduced.sha256}）；` +
        '按这样的逆操作写下去会静默改写本次修改没有碰过的行，因此不生成撤销。',
      observation.sha256,
    );
  }

  return {
    plan: {
      ...base,
      observed_path: observation.canonical_path,
      verdict: 'REVERTIBLE',
      reason: null,
      expected_sha256: expected,
      observed_sha256: observation.sha256,
      detail: `${item.canonical_path} 的对象身份与内容都还是本次修改留下的那一份，可以生成逆操作（还原为基线 ${item.base_sha256}）。`,
    },
    proposal: candidate,
    local_action: null,
  };
}

// ---------------------------------------------------------------------------
// 删除条目（delete_file）：从快照生成受保护的新建提案
// ---------------------------------------------------------------------------

async function planDeletedItem(
  item: ChangeItemRecord,
  args: RevertPrepareArgs,
  deps: RevertPrepareDeps,
  disposition: ItemDisposition,
): Promise<PlannedEntry> {
  const base = {
    item_id: item.id,
    seq: item.seq,
    op: item.op,
    path: item.canonical_path,
  } as const;
  const conflicted = (reason: RevertConflictReason, detail: string, observed: string | null = null): PlannedEntry => ({
    plan: {
      ...base,
      observed_path: null,
      verdict: 'CONFLICT',
      reason,
      expected_sha256: item.target_sha256,
      observed_sha256: observed,
      detail,
    },
    proposal: null,
    local_action: null,
  });

  if (item.base_sha256 === null || item.old_blob_id === null) {
    return conflicted('RECEIPT_INCOMPLETE', `${item.canonical_path} 缺少删除前的完整快照，无法生成恢复提案。`);
  }
  if (disposition.kind === 'back_at_baseline') {
    return {
      plan: {
        ...base,
        observed_path: null,
        verdict: 'ALREADY_ORIGINAL',
        reason: null,
        expected_sha256: item.base_sha256,
        observed_sha256: item.base_sha256,
        detail: `${item.canonical_path} 已有与删除前基线完全相同的内容，无需恢复。`,
      },
      proposal: null,
      local_action: null,
    };
  }
  if (disposition.kind !== 'deleted') {
    if (disposition.kind === 'skipped') {
      return conflicted(
        'EXECUTION_SKIPPED',
        `${item.canonical_path} 的删除在执行时被跳过；该状态不是本次删除造成的，不生成恢复提案。`,
      );
    }
    return conflicted(
      disposition.kind === 'unaccounted' ? disposition.reason : 'RECEIPT_INCOMPLETE',
      disposition.kind === 'unaccounted'
        ? `${item.canonical_path}：${disposition.detail}`
        : `${item.canonical_path} 的执行日志不是已核验删除回执，拒绝猜测。`,
    );
  }

  const observation = await observePath(deps.ops, args.scope, item.canonical_path);
  if (observation.kind === 'unavailable') {
    return conflicted(observation.reason, observation.detail);
  }
  if (observation.kind === 'present') {
    if (observation.sha256 === item.base_sha256) {
      return {
        plan: {
          ...base,
          observed_path: observation.canonical_path,
          verdict: 'ALREADY_ORIGINAL',
          reason: null,
          expected_sha256: item.base_sha256,
          observed_sha256: observation.sha256,
          detail: `${item.canonical_path} 已有与删除前基线相同的完整字节，无需再创建。`,
        },
        proposal: null,
        local_action: null,
      };
    }
    return conflicted(
      observation.file_id === item.base_file_id ? 'THIRD_CONTENT' : 'REPLACED_OBJECT',
      `${item.canonical_path} 的路径现在已被占用（${observation.sha256}），而删除前基线为 ${item.base_sha256}；为避免覆盖新内容，不生成恢复提案。`,
      observation.sha256,
    );
  }

  const baseline = await readBaselineBlob(item.old_blob_id, item.base_sha256, deps);
  if (baseline === null) {
    return conflicted('RECEIPT_INCOMPLETE', `${item.canonical_path} 的删除前快照无法读取或哈希校验失败。`);
  }
  if (baseline.length > LIMITS.MAX_EDITABLE_FILE_BYTES) {
    return conflicted(
      'INVERSE_NOT_REPRODUCIBLE',
      `${item.canonical_path} 的基线有 ${baseline.length} 字节，超过文本恢复上限 ${LIMITS.MAX_EDITABLE_FILE_BYTES}；快照保留，但此工具不生成近似恢复。`,
    );
  }
  const inspection = inspectBytes(baseline);
  if (inspection.kind !== 'text') {
    return conflicted(
      'BASELINE_NOT_TEXT',
      `${item.canonical_path} 的删除前快照不是可解码 UTF-8 文本（${inspection.reason}）；快照仍保留，但本工具不伪造二进制恢复。`,
    );
  }
  if (inspection.newline === 'mixed') {
    return conflicted(
      'INVERSE_NOT_REPRODUCIBLE',
      `${item.canonical_path} 的删除前文本混用换行风格；create_text 无法逐字节还原，已拒绝生成近似提案。`,
    );
  }

  const candidate: ChangeItem = {
    op: 'create_text',
    path: item.canonical_path,
    content: contentOfDecoded(inspection),
    newline: inspection.newline === 'crlf' ? 'crlf' : 'lf',
    bom: inspection.bom,
  };
  const validated = validateChangeItems([candidate], {
    connection_id: args.connection_id,
    workspace_id: args.workspace_id,
    generation: args.generation,
    now: args.now,
    authority: deps.authority,
    max_editable_file_bytes: LIMITS.MAX_EDITABLE_FILE_BYTES,
  }).items[0];
  if (validated === undefined || validated.op !== 'create_text') {
    return conflicted('INVERSE_NOT_REPRODUCIBLE', `${item.canonical_path} 的恢复内容未通过 create_text 契约校验。`);
  }

  let restoredSha256: string;
  try {
    const restored = createTextFile({ item: validated as ValidatedCreateText, max_editable_file_bytes: LIMITS.MAX_EDITABLE_FILE_BYTES });
    restoredSha256 = restored.after_sha256;
  } catch {
    return conflicted('INVERSE_NOT_REPRODUCIBLE', `${item.canonical_path} 的快照无法由 create_text 逐字节重建。`);
  }
  if (restoredSha256 !== item.base_sha256) {
    return conflicted(
      'INVERSE_NOT_REPRODUCIBLE',
      `${item.canonical_path} 的恢复产物哈希 ${restoredSha256} 与删除前基线 ${item.base_sha256} 不同；拒绝生成近似提案。`,
    );
  }

  return {
    plan: {
      ...base,
      observed_path: null,
      verdict: 'REVERTIBLE',
      reason: null,
      expected_sha256: item.target_sha256,
      observed_sha256: null,
      detail: `${item.canonical_path} 的删除回执与空路径状态已核验，且快照可以逐字节重建；生成 CREATE_NEW 恢复提案。`,
    },
    proposal: candidate,
    local_action: null,
  };
}

// ---------------------------------------------------------------------------
// 新建条目（create_text）
// ---------------------------------------------------------------------------

async function planCreatedItem(
  item: ChangeItemRecord,
  args: RevertPrepareArgs,
  deps: RevertPrepareDeps,
  disposition: ItemDisposition,
): Promise<PlannedEntry> {
  const base = {
    item_id: item.id,
    seq: item.seq,
    op: item.op,
    path: item.canonical_path,
  } as const;

  const conflicted = (reason: RevertConflictReason, detail: string, observed: string | null = null): PlannedEntry => ({
    plan: { ...base, observed_path: null, verdict: 'CONFLICT', reason, expected_sha256: null, observed_sha256: observed, detail },
    proposal: null,
    local_action: null,
  });

  if (disposition.kind === 'deleted') {
    return conflicted('RECEIPT_INCOMPLETE', `${item.canonical_path} 的删除终态与新建项不匹配；拒绝推断删除归属。`);
  }

  // 先看**日志**：这个新建到底发生了没有。没有发生的话，盘上无论有什么
  // 都不是我们建的 —— 哪怕它就在那个路径上。
  if (disposition.kind !== 'written') {
    const observation = await observePath(deps.ops, args.scope, item.canonical_path);
    if (observation.kind === 'unavailable') {
      return conflicted(observation.reason, observation.detail);
    }
    if (observation.kind === 'absent') {
      // 路径空着，日志又没记下我们写过它：两个方向都指向「没有留下东西」。
      return {
        plan: {
          ...base,
          observed_path: null,
          verdict: 'ALREADY_ORIGINAL',
          reason: null,
          expected_sha256: null,
          observed_sha256: null,
          detail:
            disposition.kind === 'back_at_baseline'
              ? `${item.canonical_path} 现在不存在，且日志可证明本次执行没有在这个路径上留下字节。`
              : `${item.canonical_path} 这个新建目标现在不存在，本次创建没有留下任何东西。`,
        },
        proposal: null,
        local_action: null,
      };
    }
    if (disposition.kind === 'back_at_baseline') {
      // 日志说它被收了回去（或从未落地），盘上却有东西 —— 那不是我们的。
      return conflicted(
        'THIRD_CONTENT',
        `${item.canonical_path} 的位置上有文件（${observation.sha256}），但日志证明本次执行没有在那里留下东西；它是别处来的，本流程不碰它。`,
        observation.sha256,
      );
    }
    return conflicted(
      disposition.kind === 'skipped' ? 'EXECUTION_SKIPPED' : disposition.reason,
      `${item.canonical_path} 这个位置上有文件，但**没有一份日志能证明它是本次创建的那一个**` +
        `（${disposition.kind === 'skipped' ? '执行器报告这个路径上已经是目标内容，因此它跳过了创建' : disposition.detail}）。` +
        '本服务因此**不声称**它是插件建的，也就不能建议删除它；请你在本地自行判断并处理。',
      observation.sha256,
    );
  }

  // 日志说建成了：`create_text` 是一个新对象，回读到的身份就是唯一的锚。
  const created = disposition.sha256;

  // 再看盘上现在是什么。
  const observation = await observePath(deps.ops, args.scope, item.canonical_path);
  if (observation.kind === 'unavailable') {
    return conflicted(observation.reason, observation.detail);
  }
  if (observation.kind === 'absent') {
    return {
      plan: {
        ...base,
        observed_path: null,
        verdict: 'ALREADY_ORIGINAL',
        reason: null,
        expected_sha256: created,
        observed_sha256: null,
        detail: `${item.canonical_path} 现在不存在：本次创建的文件已经被人删掉了，没有可撤销的东西。`,
      },
      proposal: null,
      local_action: null,
    };
  }

  // 身份也要对得上：`create_text` 是一个新对象，回读到的那个身份就是唯一的锚。
  if (observation.file_id !== disposition.file_id) {
    return conflicted(
      'REPLACED_OBJECT',
      `${item.canonical_path} 的位置上现在是另一个对象（${observation.file_id}），不是本次创建的那一个（${disposition.file_id}）；`,
      observation.sha256,
    );
  }

  const matches = observation.sha256 === created;
  if (!matches) {
    return conflicted(
      'THIRD_CONTENT',
      `${item.canonical_path} 的内容已经不是本次创建回读到的那个哈希（期望 ${created}，实际 ${observation.sha256}）；` +
        '这个名字现在装着别的内容，删掉它会把别人的改动一起删掉。',
      observation.sha256,
    );
  }

  const action: LocalRecoveryAction = Object.freeze({
    action: 'DELETE_CREATED_FILE',
    path: item.canonical_path,
    created_sha256: created,
    observed_sha256: observation.sha256,
    matches_creation: true,
    instruction:
      `${item.canonical_path} 的内容仍等于本次创建时回读到的哈希（${created}）。` +
      '但新建没有基线身份可锚，本服务因此**不声称**它一定由本次修改创建 —— 方案 §8.3：不能猜测所有同名内容都属于插件。' +
      '本撤销接口不会自动删除新建文件：请先核对现场；如确需删除，可另行调用受目录 grant 控制的 file_delete。' +
      '本服务不会替你删除，也不会先删后问。',
  });

  return {
    plan: {
      ...base,
      observed_path: observation.canonical_path,
      verdict: 'LOCAL_DELETE_REQUIRED',
      reason: null,
      expected_sha256: created,
      observed_sha256: observation.sha256,
      detail: `${item.canonical_path} 是本次修改创建的文件，内容未再被改动；V1 不自动删除，交本地操作者处理。`,
    },
    proposal: null,
    local_action: action,
  };
}

// ---------------------------------------------------------------------------
// 观测
// ---------------------------------------------------------------------------

interface RevertObservation {
  readonly kind: 'present';
  readonly file_id: string;
  readonly volume_id: string;
  readonly sha256: string;
  readonly size: number;
  readonly link_count: number;
  readonly attributes: readonly string[];
  readonly canonical_path: string;
  readonly bytes: Buffer;
}

type ObservationResult =
  | RevertObservation
  | { readonly kind: 'absent' }
  | { readonly kind: 'unavailable'; readonly reason: RevertConflictReason; readonly detail: string };

/**
 * 在**受控句柄**下重读一次目标。探针 → 读取 → 句柄身份比对，三步同序，
 * 与 `prepare.ts` 的 `readBaseline` 是同一条纪律。
 *
 * 差别只有一处：这里**不存在**不算错误。撤销要处理的恰恰是「那个东西
 * 还在不在」，因此 `NOT_FOUND` 是一个**结果**，不是一个异常。
 *
 * 所有 `detail` 都是本函数自己拼的：护栏的 `WinfsError.message` 里带着
 * 目标的**绝对路径**，而这句话会进工具结果与审计（LWB-029 在别处正是
 * 在这条缝上漏过一次）。因此这里只把**错误码**带出去，不带走消息。
 */
async function observePath(ops: WinfsOps, scope: ReadScope, path: string): Promise<ObservationResult> {
  let target: Awaited<ReturnType<typeof resolveTarget>>;
  try {
    target = await resolveTarget(ops, scope, path, 'file');
  } catch (error) {
    if (error instanceof BridgeError && error.code === 'NOT_FOUND') return { kind: 'absent' };
    return unavailableFrom(error, path);
  }

  const result = await ops.readFileGuarded(refOf(scope, path));
  if (isWinfsError(result)) {
    if (result.code === 'NOT_FOUND') return { kind: 'absent' };
    return {
      kind: 'unavailable',
      reason: 'READ_FAILED',
      detail: `${path} 在这次重读中读不到（护栏码 ${result.code}）；本次没有撤销任何东西。`,
    };
  }

  if (
    result.identity.volume_id !== target.identity.volume_id ||
    result.identity.file_id !== target.identity.file_id ||
    result.size !== target.size
  ) {
    return {
      kind: 'unavailable',
      reason: 'IDENTITY_CHANGED_BETWEEN_OPENS',
      detail: `${path} 在本次重读的两次打开之间被替换或改动；已放弃，请重新发起撤销。`,
    };
  }

  return {
    kind: 'present',
    file_id: result.identity.file_id,
    volume_id: result.identity.volume_id,
    sha256: result.sha256,
    size: result.size,
    link_count: result.identity.link_count,
    attributes: result.attributes.names ?? [],
    canonical_path: requireCanonicalPath(result.canonical_relative_path),
    bytes: Buffer.from(result.bytes_base64, 'base64'),
  };
}

function unavailableFrom(error: unknown, path: string): ObservationResult {
  if (error instanceof BridgeError) {
    return {
      kind: 'unavailable',
      reason: error.code === 'NATIVE_GUARD_UNAVAILABLE' ? 'GUARD_UNAVAILABLE' : 'READ_FAILED',
      detail: `${path} 这次没能被观测（桥接码 ${error.code}）；**什么都没证明** —— 不是「没动过」，也不是「动过」。`,
    };
  }
  return {
    kind: 'unavailable',
    reason: 'READ_FAILED',
    detail: `${path} 这次没能被观测（非桥接错误）；本次没有撤销任何东西。`,
  };
}

/**
 * 目标文件当前是否可以按本工程的规则改写。
 *
 * 这四条与 `file_read` 的 `editable_blockers` 里那四条**逐条对应**
 * （混用换行 / 超过可编辑上限 / 多个硬链接 / 只读属性），理由是同一句话：
 * 两套判据迟早会分叉，而分叉的那一天，某一条路径会比另一条宽。
 *
 * `file_read` 另外还有两条，这里**刻意没有**：
 *
 *  - 「某一行超过单行上限、已被截断」—— 那是关于**返回给模型的那一页**的
 *    事实。本文件读的是整份字节，没有任何一行被截断。
 *  - 「本次读取未获得可编辑票据 / 内容已被脱敏」—— 那是**出站闸门**的裁定。
 *    本文件的字节一个都不出站（不返给模型、不进工具结果），因此那条
 *    裁定没有对应物；而它真正保护的东西（「敏感内容不能变成一次写入的
 *    基线」）在这里由另一条更强的性质覆盖：可撤销的条目，其基线与当前内容
 *    都来自**同一条已经被批准并执行过**的修改集，而那次执行本身就是
 *    经过策略与本地批准的。策略版本变化由 `revalidateExecutionBindings`
 *    的 `POLICY_VERSION_CHANGED` 拦住。
 *
 * 返回 `null` 表示可以改写。
 */
function requireStillEditable(
  bytes: Buffer,
  size: number,
  linkCount: number,
  attributes: readonly string[],
): string | null {
  const inspection = inspectBytes(bytes);
  if (inspection.kind === 'text' && inspection.newline === 'mixed') {
    return '文件混用多种换行风格（或含单独 CR）；写回会静默改变其它行的字节。';
  }
  if (size > LIMITS.MAX_EDITABLE_FILE_BYTES) {
    return `文件 ${size} 字节超过可编辑上限 ${LIMITS.MAX_EDITABLE_FILE_BYTES} 字节。`;
  }
  if (linkCount > 1) {
    return `该文件有 ${linkCount} 个硬链接；写入会同时改变工作区外的另一个名字，V1 保守拒绝。`;
  }
  if (attributes.includes('readonly')) {
    return '文件带只读属性；写入会因权限被拒。';
  }
  return null;
}

// ---------------------------------------------------------------------------
// 基线字节与逆内容
// ---------------------------------------------------------------------------

/**
 * 从快照库取回基线字节，**并逐字节校验**。
 *
 * 取不到就是取不到：不退回「用目标文件反推」、也不退回「跳过这一条」。
 * 一份不完整的快照意味着「原来是什么」已经不可知，而撤销的全部内容就是
 * 把「原来」写回去 —— 少一个字节都不行。
 *
 * 返回 `null` 而不是抛错：调用方把它翻译成一条**逐条目的冲突**，
 * 于是「哪一个文件的快照丢了」会被指名，而不是变成一次笼统的失败。
 */
async function readBaselineBlob(blobId: string, expectedSha256: string, deps: RevertPrepareDeps): Promise<Buffer | null> {
  const record = deps.repos.blobs.findById(blobId);
  if (record === null) return null;
  try {
    const bytes = await deps.blobs.getVerified({
      sha256: record.sha256,
      size: record.size,
      storage_ref: record.storage_ref,
    });
    if (record.sha256 !== expectedSha256) return null;
    return bytes;
  } catch {
    // 快照缺失或哈希不符（LWB-007 验收标准 2）。这里**不**把异常消息带出去：
    // 它可能含快照目录的绝对路径。冲突的 `reason` 已经说清了是什么事。
    return null;
  }
}

/**
 * 把一份已解码的文本折回 `replace_text` 的 `content` 形状。
 *
 * 两边的规则都是既有事实，本函数只是把它们接起来：
 *  - `decode.ts` 的行索引说「第 n 行是哪一段、用什么终止符」；
 *  - `edit-contract.ts` 的 `requireWritableContent` 说「`content` 里不能有 `CR`，
 *    换行一律用 `\n` 表达，风格由目标文件决定」。
 *
 * 末尾终止符单独处理：`'a\n'` 是**一行**，折回 content 时要补回那个 `\n`，
 * 否则撤销会把一个带末尾换行的文件写成不带。`'a\n'` 与 `'a'` 在这里的差别
 * 就是两个不同的字节序列，而撤销必须逐字节还原。
 */
function contentOfDecoded(decoded: DecodedText): string {
  const total = decoded.lines.total_lines;
  if (total === 0) return '';
  const parts: string[] = [];
  for (let n = 1; n <= total; n += 1) parts.push(lineText(decoded.text, decoded.lines, n));
  const last = decoded.lines.terminators[total - 1] ?? '';
  return parts.join('\n') + (last === '' ? '' : '\n');
}

/**
 * 用**真的引擎**跑一遍逆操作，看它算出什么。
 *
 * 不做这一步也能写出代码 —— 只要相信「旧字节就是基线字节」。但撤销的产物
 * 是**字节**，而字节是由「当前文件的换行风格 + BOM + 基线文本」三者共同
 * 决定的。相信一条推理，与验一次事实，代价差一个哈希计算，收益是
 * 「一次静默改写用户其它行」从可能变成不可能。
 *
 * 引擎抛出的错误在这里被**转译**，不原样上抛：它是 `INVALID_ARGUMENT` /
 * `INTERNAL_ERROR` 那一类，对调用方说的是「你的参数不对」或「我们坏了」，
 * 而真正发生的事是「这个文件的现状让逆操作没法逐字节还原」—— 那是
 * `FILE_VERSION_CONFLICT` 那一类。
 */
function reproduceInverse(
  candidate: ChangeItem,
  currentBytes: Buffer,
  args: RevertPrepareArgs,
  deps: RevertPrepareDeps,
): { readonly ok: true; readonly sha256: string } | { readonly ok: false; readonly detail: string } {
  const validation = validateChangeItems([candidate], {
    connection_id: args.connection_id,
    workspace_id: args.workspace_id,
    generation: args.generation,
    now: args.now,
    authority: deps.authority,
    max_editable_file_bytes: LIMITS.MAX_EDITABLE_FILE_BYTES,
  });
  const validated: ValidatedChangeItem | undefined = validation.items[0];
  if (validated === undefined || validated.op !== 'replace_text') {
    return { ok: false, detail: '逆提案没有通过契约校验（这是内部不一致）；已放弃。' };
  }

  const inspection = inspectBytes(currentBytes);
  if (inspection.kind !== 'text') {
    return { ok: false, detail: '当前字节不是可识别的文本；已放弃。' };
  }

  try {
    const applied = replaceWholeText({
      item: validated,
      original: currentBytes,
      baseline: inspection,
      max_editable_file_bytes: LIMITS.MAX_EDITABLE_FILE_BYTES,
    });
    return { ok: true, sha256: applied.after_sha256 };
  } catch (error) {
    if (error instanceof BridgeError) {
      return { ok: false, detail: `引擎拒绝了这次逆操作（桥接码 ${error.code} / ${String(error.details?.['reason'] ?? '未记录')}）。` };
    }
    return { ok: false, detail: '引擎拒绝这次逆操作（非桥接错误）。' };
  }
}

// ---------------------------------------------------------------------------
// 文案
// ---------------------------------------------------------------------------

/**
 * 新修改集的 `summary`。
 *
 * 这段文字**由本模块生成**，不是模型写的 —— 但字段的信任级别一个字都不变。
 * `summary` 是「模型撰写的不受信文案」那一栏，它只用于展示：任何判定都不
 * 读它（批准的绑定对象是 `digest`，而 `ChangeDigestInput` 里没有 `summary`）。
 * 因此这里写事实是安全的：它骗不了任何人，因为**没有任何东西在听它**。
 */
function revertSummaryOf(source: ChangeSetRecord, fileCount: number): string {
  return (
    `撤销修改集 ${source.id}（核对码 ${shortCodeOf(source.digest)}）对 ${fileCount} 个文件的修改：` +
    '把这些文件恢复为该修改集建立时的内容。这是一份**新的**修改集，仍需本地操作者独立批准后才能写入。'
  );
}

/**
 * 需要人工处理的**总述**。
 *
 * ## 它**不含**路径，这是刻意的
 *
 * 逐条说明（含路径与哈希）在 `local_actions` 里。这一句只回答「有几条、
 * 为什么」。把路径写进这里会让审计的文件访问表取不到它 ——
 * 那张表按**结构化字段**提取（`@lwb/audit` 的 `FILE_ACCESS_EXTRACTORS`），
 * 而从散文里认路径是猜。结果是「模型拿到了文件名，审计里却写着这次调用
 * 什么也没读」。这个缺陷在 LWB-032 接线时被发现并在此修掉。
 */
function localReasonOf(plan: RevertPlan): string {
  const count = plan.local_actions.length;
  return (
    `本次撤销有 ${count} 个文件需要本地处理（这些是新建文件，撤销接口不会自动删除）；` +
    '逐条说明与路径见 local_actions。核实后可另行调用 file_delete。'
  );
}
