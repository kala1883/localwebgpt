/**
 * 写执行协调器（LWB-026）。
 *
 * ## 它管的是一件被三句话描述过的事
 *
 * 1. 把已批准的操作**持久化入队**，用单工作区执行器和确定的文件加锁顺序；
 * 2. 消费批准与认领操作走**短事务**，外部写入**不**包在长事务里；
 * 3. 取消、断线、超时**不重新启动**同一个写操作；原生进程状态不明时先阻断工作区。
 *
 * ## 三件本模块**刻意不做**的事
 *
 * | 不做 | 因为 |
 * | --- | --- |
 * | 不写文件 | 那是 LWB-027 的事。这里只交出「许可 + 次序」，写盘的人不需要数据库事务 |
 * | 不判定能不能占 | 判定在 `slot-rules.ts`（纯函数）。本模块只执行它的结论 |
 * | 不重试 | 见下 |
 *
 * ## 为什么「不重试」不是偷懒
 *
 * 步骤 3 的三件事（取消、断线、超时）**没有一个**会导致「再来一次会更好」。它们
 * 共同的含义是「我们不知道写进行到哪一步了」—— 而一次结果未知的写入，
 * 重放它意味着**第二条**写入路径叠在第一条可能的半成品上。
 *
 * 因此本模块里**没有**回 `QUEUED` 的边。执行中出任何意外，唯一的去向是
 * `RECOVERY_REQUIRED`；而 `RECOVERY_REQUIRED` 在两张转移表里都**没有**
 * 回到 `QUEUED` 的边（`packages/changes/src/state-machine.ts`）。
 * 「不重启」因此不是一段需要被遵守的纪律，而是一条编译期与数据库层
 * 都走不通的路。
 *
 * 超时的处置与别的失败**完全相同**，这一点是刻意的：超时看起来像
 * 「什么也没发生」，而它实际上只证明「我们没等到回执」。
 *
 * ## 槽在成功之后**不释放**
 *
 * 直觉上「写完了就该把锁放掉」，但槽不是锁。它是一条**带单调令牌的登记行**：
 * 占用时令牌加一。释放（删行）会让下一个执行者从令牌 1 重新开始，
 * 于是「令牌只增不减」这条性质在第一次成功之后就没了 —— 而它正是
 * 「一个已经失去资格的执行器写不进去」的全部依据。
 *
 * 代价是每个物理工作区常驻一行（指向最后那个已终结的操作）。这是**有界**的，
 * 而换来的是令牌在进程的整个生命周期乃至跨重启（行是持久的）里单调。
 * 下一任占用者走的是 `slot-rules.ts` 里「上一操作已终结 ⇒ 接管、令牌加一」
 * 那条路 —— 那条分支就是为这里写的。
 *
 * ## 阻断只有一个入口
 *
 * 本模块**不**调用 `write_slots.block`。阻断全部发生在 `claimForExecution`
 * 里，依据是 `decideSlot` 的返回值。因此「什么情况下工作区会被切断」
 * 这个问题只有一个答案，而且是一个可以被穷尽读一遍的纯函数。
 *
 * 解除阻断也只有一个入口：`clearBlockade`，而它要求导致阻断的那个操作
 * **已经终结**（见该方法）。
 */

import { transitionChange, transitionOperation } from '@lwb/changes';
import { BridgeError, TERMINAL_CHANGE_STATES, newOperationId } from '@lwb/contracts';
import type { ChangeSetState } from '@lwb/contracts';
import { asChangeId, queueOperation } from '@lwb/idempotency';
import { currentProcessIdentity, newExecutorId } from '@lwb/ipc';
import type { ProcessIdentity, ProcessProbe } from '@lwb/ipc';
import type { OperationRecord, Repositories } from '@lwb/persistence';

import { claimForExecution } from './claim.ts';
import type { ClaimDeps, ClaimOutcome, ExecutionPlan } from './claim.ts';

/**
 * 写的人交回来的报告。**不是**「成功/失败」，而是「它确定地达到了什么状态」。
 *
 * 三种**终局**：`APPLIED` / `FAILED_NO_CHANGE` / `CONFLICT` —— 就是 §8.1 里
 * `VALIDATING` 之后的三条前进边。第四种取值 `refused` 不是第四条边，
 * 它落在 `FAILED_NO_CHANGE` 上（见下）。第五种 `rolled_back`（LWB-029）
 * 也不是新边 —— 它是 `APPLYING → ROLLED_BACK`，那条边一直在图里，
 * 只是到写执行器能收回自己写下的字节之前，没有人报得出来。
 *
 * 其它一切（抛异常、超时、被取消）都不在这里 —— 因为那些**不是报告**，
 * 是「没有报告」，而它们一律走 `RECOVERY_REQUIRED`。
 */
export type ApplyReport =
  /**
   * 全部目标已按计划写入并核验。
   *
   * 可选的 `detail`（LWB-029）是**逐条目**终局的折叠结果（几个文件写成功、
   * 几个本来就在目标上）。它是**补充**而不是必需：`kind` 本身已经是一句
   * 完整的话（aggregate 状态），而逐文件的完整账在 `journal_entries` 里
   * （每条目若干行，按 `operation_id` 取）。要求每个实现都填一句话，
   * 得到的多半是「全部完成」这种把已有的信息重说一遍的填充语。
   */
  | { readonly kind: 'applied'; readonly detail?: string }
  /** 一个字节都没有需要改（例如磁盘上已经是目标内容）。**不是错误。** */
  | { readonly kind: 'no_change'; readonly detail: string }
  /**
   * 写入前的复核发现**磁盘那一侧**与计划不符：内容被改过、对象换了、
   * 目标没了、被占用、没权限、路径被改名到一个不允许的拼写。
   * **在写入之前**退出，磁盘上没有一个字节是这次执行改的。
   */
  | { readonly kind: 'conflict'; readonly detail: string }
  /**
   * 写到一半失败，且**已经把自己写下去的字节全部收回**（LWB-029）。
   *
   * 这是 §8.1 里 `APPLYING → ROLLED_BACK` 那条边，而它和上面三种的区别是
   * 报告人**进过 `APPLYING`**：字节确实落过盘，然后被收回去了。
   *
   * 因此它不能报成 `no_change`（那要求来源是 `VALIDATING`，而这次执行的
   * 记账已经不在那里了），也不能报成 `conflict`（冲突是写之前的事）。
   * 磁盘的终态与 `no_change` **一样**是「没有本次执行的字节」，区别在
   * 于它是**怎么**到那里的 —— 而那正是操作者要读的那句话，它在 `detail` 里。
   *
   * 收不干净的情形**不在这里**：那是「不知道写到了哪」，走抛异常 ⇒ 待恢复。
   */
  | { readonly kind: 'rolled_back'; readonly detail: string }
  /**
   * **计划这一侧**的拒绝：本条目根本不该被这次执行处理。
   *
   * 与 `conflict` 的分界线是「看一眼目标有没有用」：
   *
   * | | 原因是 | 操作者该做的 |
   * | --- | --- | --- |
   * | `conflict` | 磁盘/环境 | 重新查看目标，多半要重新提案 |
   * | `refused` | 计划本身 | 看目标没用（重看一遍还是同一份计划） |
   *
   * 收在这一类的有：本条目是当前构建不支持的写入形态（如 `create_text`
   * 属于 LWB-028）、条目自身缺了基线字段、目标字节与条目自己声明的编码/
   * BOM/换行不符、blob 内容与 `target_sha256` 对不上、护栏不可用。
   *
   * **为什么要有它，而不是一律报 `conflict`：** 上面这些没有一条是
   * 「磁盘变了」，把它们报成 `CONFLICT` 是在说一句假话；而且
   * `CONFLICT` 是终局，操作者只能看到「跟磁盘不符，重新提案吧」，
   * 真正的病因（比如说「这个目标是不支持创建的形态」）就此消失。
   */
  | { readonly kind: 'refused'; readonly detail: string };

/**
 * 真正写盘的人（LWB-027 及以后）。**在数据库事务之外**被调用。
 *
 * `signal` 被 abort 的含义不是「你可以不管了」，而是「**尽快停在一个安全的
 * 边界上**」—— 停不下来时**必须抛**，绝不能返回一个看起来正常的报告：
 * 返回报告等于宣称自己知道磁盘的状态，而 abort 恰恰意味着有人（心跳失效、
 * 操作者暂停）已经认定这次写入不该继续。
 */
export type ExecutionApplier = (plan: ExecutionPlan, signal: AbortSignal) => Promise<ApplyReport>;

export interface ExecutionCoordinatorOptions {
  readonly repos: Repositories;
  /** 问「上一个写手还在不在」。生产走 `createProcessProbe`。 */
  readonly probe: ProcessProbe;
  /** 写盘的人。 */
  readonly apply: ExecutionApplier;
  /** 本执行器标识。省略时新生成一个。 */
  readonly executor_id?: string;
  /** 本进程身份。省略时取当前进程。 */
  readonly holder?: ProcessIdentity;
  /** 写执行槽的租约时长（毫秒）。 */
  readonly lease_ms?: number;
  /** 认领之后到放弃之前的**硬**上界（毫秒）。超时一律判为待恢复。 */
  readonly apply_timeout_ms?: number;
  /** 心跳间隔（毫秒）。默认取租约时长的三分之一。 */
  readonly heartbeat_ms?: number;
  /** 当前时刻（毫秒纪元）。注入以便测试。 */
  readonly now?: () => number;
  /** 记录不可抛的异常（心跳失败等）。省略时静默 —— 但**不吞**，
   *  因为每一次都会转成一次 abort 或一条 `RECOVERY_REQUIRED`。 */
  readonly on_notice?: (notice: CoordinatorNotice) => void;
  /**
   * 外部停止源（LWB-034 的紧急停用）。省略时本协调器只会因超时与心跳停手。
   *
   * ## 为什么是一个**取信号的函数**，而不是一个信号
   *
   * 紧急停用被解除之后，下一次停用必须落在**新**的 `AbortController` 上
   * （一个已经 abort 过的信号不可能再变回未 abort，见
   * `PauseService#stop`）。如果这里收的是一个固定信号，那么
   * 「停用 → 恢复 → 再停用」的第二轮会挂在一个早已中止的信号上 ——
   * 于是每一次执行都在第一步就自判中止，而界面上写着「未暂停」。
   *
   * 每次执行开始时取一次，拿到的就是当前这一轮的那一个。
   */
  readonly stop?: () => AbortSignal;
}

export interface CoordinatorNotice {
  readonly kind: 'HEARTBEAT_FAILED' | 'HEARTBEAT_LOST';
  readonly operation_id: string;
  readonly detail: string;
}

export type FinishedState = 'APPLIED' | 'CONFLICT' | 'FAILED_NO_CHANGE' | 'ROLLED_BACK' | 'RECOVERY_REQUIRED';

export type RunOutcome =
  /** 队列里没有可执行的。 */
  | { readonly kind: 'idle' }
  /** 认领被拒绝，**什么都没变**。 */
  | Extract<ClaimOutcome, { kind: 'refused' }>
  /** 工作区被阻断（本次或之前）。 */
  | Extract<ClaimOutcome, { kind: 'blocked' | 'already_blocked' }>
  | {
      readonly kind: 'finished';
      readonly operation_id: string;
      readonly change_id: string;
      readonly state: FinishedState;
      readonly detail: string;
    };

/**
 * 本包写入日志的阶段名。
 *
 * 与 `@lwb/changes` 的 `JOURNAL_STAGE_INVALIDATED` 同一种风格（小写、读得懂），
 * 而**不**复用状态机的枚举名：日志回答的是「发生过什么」，
 * 把它写成状态的第二份副本，会让「状态是 APPLIED 但日志说 write_conflict」
 * 这种真正的矛盾再也读不出来。
 *
 * 键与 `FinishedState` 逐字对应，因此 `JOURNAL_STAGE[state]` 是全函数 ——
 * `FinishedState` 多一个值时这一行会编译失败。
 */
export const JOURNAL_STAGE: Readonly<Record<FinishedState, string>> = {
  APPLIED: 'write_applied',
  CONFLICT: 'write_conflict',
  FAILED_NO_CHANGE: 'write_no_change',
  ROLLED_BACK: 'write_rolled_back',
  RECOVERY_REQUIRED: 'write_recovery_required',
};

const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_APPLY_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * 外部停止源说的那个原因。**原样取它的 `reason`**，本模块不另写一句话。
 *
 * 「为什么停的」这件事只有停止源知道 —— 它可能是紧急停用，将来也可能是
 * 别的什么。在这里另写一句「已暂停」会把本模块变成第二份措辞的来源，
 * 而两份措辞迟早会在某一格上分叉（紧急停用被解除之后，这句话还印在
 * 那次执行的中止理由里）。取不到时给一句**明确说取不到**的话，
 * 而不是猜一句最像的。
 */
function externalStopReason(signal: AbortSignal): string {
  const reason: unknown = signal.reason;
  if (reason instanceof Error && reason.message.length > 0) return reason.message;
  if (typeof reason === 'string' && reason.length > 0) return reason;
  return '外部停止源已停止本次执行，但那个信号没有带上原因。';
}

export class ExecutionCoordinator {
  readonly #deps: ClaimDeps;
  readonly #repos: Repositories;
  readonly #apply: ExecutionApplier;
  readonly #applyTimeoutMs: number;
  readonly #heartbeatMs: number;
  readonly #onNotice: (notice: CoordinatorNotice) => void;
  readonly #now: () => number;
  /** 外部停止源。`null` 表示没有装 —— 与「装了但此刻没停」是两件事。 */
  readonly #stop: (() => AbortSignal) | null;

  constructor(options: ExecutionCoordinatorOptions) {
    const leaseMs = options.lease_ms ?? DEFAULT_LEASE_MS;
    this.#now = options.now ?? (() => Date.now());
    this.#repos = options.repos;
    this.#apply = options.apply;
    this.#applyTimeoutMs = options.apply_timeout_ms ?? DEFAULT_APPLY_TIMEOUT_MS;
    this.#heartbeatMs = options.heartbeat_ms ?? Math.max(1_000, Math.floor(leaseMs / 3));
    this.#onNotice = options.on_notice ?? ((): void => {});
    this.#stop = options.stop ?? null;
    this.#deps = {
      repos: options.repos,
      executor_id: options.executor_id ?? newExecutorId(),
      holder: options.holder ?? currentProcessIdentity(),
      probe: options.probe,
      lease_ms: leaseMs,
      now: this.#now,
    };
  }

  get executorId(): string {
    return this.#deps.executor_id;
  }

  /**
   * 补排队：把「已取得执行授权、但还没有操作行」的修改集交给**同一个**排队服务。
   *
   * 这条路是步骤 1 的前半句「将已授权操作持久化入队」。它**不是**第二条
   * 排队路径：授权入口在自己的事务里同时写下授权记录与排队
   * （`@lwb/approvals` 的 `approveAndQueue`），本方法只是把那个事务
   * **没有提交完**的那一次补上。
   *
   * 因此它在正常运行时永远补 0 条 —— 它存在的意义是让「授权与排队是
   * 原子的」这句话在崩溃之后仍然成立。两个条件一起保证它不会变成
   * 「模型凭空把东西排进队列」：
   *
   *  - 只扫 `APPROVED`。这个状态只能由受控入口产生：本地控制操作，或先核验
   *    当前 workspace grant 的 MCP handler（ADR-003 §4：`approved:true` 之类的
   *    参数不构成授权）。因此本方法只补排队，不产生授权；
   *  - 走 `queueOperation`，因此 `UNIQUE(change_id)` 与状态前置条件
   *    两条机制都还在。
   *
   * 与并发调用者相撞（控制台同时提交了）不是错误：那正是「谁先都一样」的
   * 情形，`queueOperation` 的幂等性保证只有一个操作存在。撞上时跳过。
   */
  enqueueApproved(limit = 16): number {
    let queued = 0;
    const candidates = this.#repos.changes
      .listByStates(['APPROVED'])
      .filter((change) => this.#repos.operations.findByChangeId(change.id) === null);

    for (const change of candidates.slice(0, limit)) {
      if (this.#enqueueOne(change.id)) queued += 1;
    }
    return queued;
  }

  /**
   * 点名执行**某一条**修改集。
   *
   * ## 它为什么必须存在
   *
   * `runOnce()` / `drain()` 取的是**队首**，那是后台推进的形状：谁先排队
   * 谁先写，调用方不关心是哪一条。而 `change_apply` 是一个**点名**的请求 ——
   * 「把这条应用掉」。用队首实现它会在有两个排队操作时写错那一个，
   * 而那种错误在只有一个操作的单用户场景里**永远不会被发现**。
   *
   * ## 它不绕过任何执行保护
   *
   * 认领（`claimForExecution`）与执行（`#execute`）逐字复用下面那两条，
   * 因此执行授权记录、槽判定、阻断、心跳、超时、收尾**一个都不少**：
   * 点名的是「哪一条」，不是「哪几条规则」。
   *
   * ## 唯一的补写：`APPROVED` 且没有操作行
   *
   * 这一步与 `enqueueApproved` 是**同一个** `#enqueueOne`。它不产生授权
   * （只有 `APPROVED` 会被排队，而该状态只能由已校验的授权入口产生），
   * 只把一次「授权与排队本应原子、但没能一起提交完」的提交补上。
   */
  async runChange(changeId: string): Promise<RunOutcome> {
    this.#enqueueOne(changeId);
    return await this.#claimAndExecute(changeId);
  }

  /** 给一条 `APPROVED` 且没有操作行的修改集补排队。返回是否真的排了一条。 */
  #enqueueOne(changeId: string): boolean {
    const change = this.#repos.changes.findById(changeId);
    if (change === null || change.state !== 'APPROVED') return false;
    if (this.#repos.operations.findByChangeId(changeId) !== null) return false;

    try {
      const result = queueOperation(this.#repos, {
        change_id: asChangeId(changeId),
        from: ['APPROVED'],
        worker_instance: this.#deps.executor_id,
        new_operation_id: newOperationId,
      });
      return !result.existed;
    } catch (error) {
      // 另一条路径先到了（状态已经不是 APPROVED），或者这本就不是一个
      // 能排队的修改集。**不吞**：排除「状态不对」之外的错误一律上抛 ——
      // 一个被静默丢弃的 APPROVED 修改集，是人以为点了批准却什么也没发生。
      if (error instanceof BridgeError && error.code === 'CHANGE_STATE_INVALID') return false;
      throw error;
    }
  }

  /**
   * 取队首一个操作，认领并执行它。
   *
   * 认领在自己的短事务里完成；写盘在**事务之外**；收尾又是另一个短事务。
   * 三段的边界与方案 §8.2 的「数据库事务不能跨越等待批准或全部文件写入过程」
   * 是同一条要求。
   */
  async runOnce(): Promise<RunOutcome> {
    const next = this.#oldestQueued(new Set());
    if (next === null) return { kind: 'idle' };
    return this.#runOne(next);
  }

  /**
   * 反复取队首执行，直到队列空、达到上限，或所有候选都被拒绝。
   *
   * `skipped` 是必需的，不是优化：一次**拒绝**不改变任何状态，因此队首
   * 还是它 —— 不记下来就会在同一个 tick 里对同一行空转。记下来之后，
   * 「一个工作区被占住」不会挡住其它工作区，而循环仍然必然终止
   * （候选集在每一轮至少少一个）。
   */
  async drain(limit = 8): Promise<readonly RunOutcome[]> {
    const outcomes: RunOutcome[] = [];
    const skipped = new Set<string>();
    while (outcomes.length < limit) {
      const next = this.#oldestQueued(skipped);
      if (next === null) break;
      skipped.add(next.id);
      outcomes.push(await this.#runOne(next));
    }
    return outcomes;
  }

  /**
   * 解除一条阻断。**这是唯一一条能让被阻断的工作区重新可写之路。**
   *
   * 前置条件只有一条，而它是硬的：**导致阻断的那个操作必须已经终结**
   * （`APPLIED` / `ROLLED_BACK` / `FAILED_NO_CHANGE` / `CONFLICT`）。
   *
   * 为什么必须是终结而不是「不是执行中」：`RECOVERY_REQUIRED` 也不在执行中，
   * 但它恰恰意味着**字节的下落不明**。在那种状态下解除阻断，等于把一块
   * 内容处于第三态的地交给下一个写手 —— 而那正是阻断要防的事。
   * 「核验到目标状态」这一步是恢复流程（LWB-030）的职责，它会把操作
   * 送到 `APPLIED` 或 `ROLLED_BACK`；到了那时，本方法就会放行。
   */
  clearBlockade(volumeId: string, rootFileId: string): { readonly cleared: boolean; readonly previous_operation_id: string } {
    const repos = this.#repos;

    return repos.transaction(() => {
      const slot = repos.write_slots.find(volumeId, rootFileId);
      if (slot === null) {
        throw new BridgeError('WORKSPACE_BUSY', '该物理工作区没有写执行槽，无需解除阻断。', {
          reason: 'SLOT_MISSING',
        });
      }
      if (slot.blocked_at === null) {
        throw new BridgeError('WORKSPACE_BUSY', '该物理工作区当前未被阻断。', { reason: 'NOT_BLOCKED' });
      }
      const previous = repos.operations.findById(slot.operation_id);
      if (previous === null) {
        throw new BridgeError('WORKSPACE_BUSY', '写执行槽指向的操作不存在，需人工核验。', {
          reason: 'SLOT_OPERATION_MISSING',
        });
      }
      if (!TERMINAL_CHANGE_STATES.includes(previous.state)) {
        throw new BridgeError(
          'RECOVERY_REQUIRED',
          '导致阻断的操作尚未终结（字节下落未定案），不能解除阻断；请先走恢复流程。',
          { reason: 'PREVIOUS_NOT_TERMINAL', operation_id: previous.id, state: previous.state },
        );
      }

      repos.write_slots.unblock({ volume_id: volumeId, root_file_id: rootFileId });
      return { cleared: true, previous_operation_id: previous.id };
    });
  }

  // -------------------------------------------------------------------------
  // 内部
  // -------------------------------------------------------------------------

  #oldestQueued(skipped: ReadonlySet<string>): OperationRecord | null {
    const queued = this.#repos.operations.listByStates(['QUEUED']);
    return queued.find((operation) => !skipped.has(operation.id)) ?? null;
  }

  async #runOne(operation: OperationRecord): Promise<RunOutcome> {
    return await this.#claimAndExecute(operation.change_id);
  }

  /**
   * 认领并执行**指名的那条修改集**。
   *
   * 参数是 `change_id` 而不是操作行：认领本来就是按修改集走的
   * （`claimForExecution(deps, changeId)` 会自己把操作行读出来），
   * 而 `runChange` 那条路的入口处操作行可能**还不存在**（`APPROVED` 待补排队）。
   * 收窄成 `OperationRecord` 会让那个入口只能先自己读一次 —— 读到的却是
   * 一个立刻就要被认领流程重读的行。
   */
  async #claimAndExecute(changeId: string): Promise<RunOutcome> {
    // 认领：同步、自己的短事务。**不 await** —— 它内部是 `BEGIN IMMEDIATE`，
    // 而把异步放进那个事务里就等于把事务交给了事件循环。
    const decision = claimForExecution(this.#deps, changeId);

    switch (decision.kind) {
      case 'refused':
        // 把拒绝原样交给调用方，但**不抛**：一次「别人正在写」不是异常，
        // 是这台机器上的正常时序。上抛会让人以为出了问题，而下一个人
        // 要做的动作（再试一次）恰恰不需要任何排障。
        return decision;
      case 'blocked':
      case 'already_blocked':
        return decision;
      case 'claimed':
        return this.#execute(decision.plan);
      default: {
        const never: never = decision;
        throw new Error(`未处理的认领结果：${JSON.stringify(never)}`);
      }
    }
  }

  async #execute(plan: ExecutionPlan): Promise<RunOutcome> {
    const abort = new AbortController();
    let abortReason = '未知原因';

    const timer = setTimeout(() => {
      abortReason = `写入超过上界 ${this.#applyTimeoutMs} ms 仍未交回执。`;
      abort.abort(new Error(abortReason));
    }, this.#applyTimeoutMs);

    // 心跳：既续租，也是**接管探测器**。心跳失败返回 `null` 意味着
    // 「我已经不是这块地的持有者了」—— 那只有一种成因：被接管或被阻断。
    // 此时必须停手，而不是继续写：另一个执行器可能已经在同一批文件上。
    const beat = setInterval(() => {
      try {
        const renewed = this.#repos.write_slots.heartbeat({
          operation_id: plan.operation_id,
          executor_id: plan.executor_id,
          fencing_token: plan.fencing_token,
          expires_at: new Date(this.#now() + this.#deps.lease_ms).toISOString(),
        });
        if (renewed === null) {
          abortReason = '写执行槽已被他人接管或阻断，本执行器失去资格。';
          this.#onNotice({ kind: 'HEARTBEAT_LOST', operation_id: plan.operation_id, detail: abortReason });
          abort.abort(new Error(abortReason));
        }
      } catch (error) {
        abortReason = `续约失败：${error instanceof Error ? error.message : String(error)}`;
        this.#onNotice({ kind: 'HEARTBEAT_FAILED', operation_id: plan.operation_id, detail: abortReason });
        abort.abort(new Error(abortReason));
      }
    }, this.#heartbeatMs);

    // 外部停止源（紧急停用）。**取一次**：它必须与下面这次执行配成一对，
    // 因为 `finally` 里要拿同一个对象把监听器摘掉。
    //
    // 摘监听器不是为了好看：本进程是一个长命的服务，而 `#stop` 取到的
    // 信号在两次停用之间是**同一个活对象**。不摘的话，跑过 N 次执行之后
    // 它身上挂着 N 个监听器，中止那一刻 N 个一起触发（Node 从 11 个
    // 开始告警），而且每一个都会去写同一个 `abortReason` —— 最后那句
    // 「为什么停的」取决于谁最后跑，而那是不该由事件循环顺序决定的事。
    const stopSignal = this.#stop?.() ?? null;
    let detachStop: (() => void) | null = null;
    if (stopSignal !== null) {
      if (stopSignal.aborted) {
        // 已经停了。这不是异常路径：控制台刚按下停用、而这次执行
        // 是在那之后才被认领的。写盘人会在第一个安全边界看到
        // 一个已经 aborted 的信号并停下（它一个字节都还没碰）。
        abortReason = externalStopReason(stopSignal);
        abort.abort(new Error(abortReason));
      } else {
        const onStop = (): void => {
          abortReason = externalStopReason(stopSignal);
          abort.abort(new Error(abortReason));
        };
        stopSignal.addEventListener('abort', onStop);
        detachStop = (): void => stopSignal.removeEventListener('abort', onStop);
      }
    }

    let state: FinishedState;
    let detail: string;
    try {
      const report = await this.#apply(plan, abort.signal);
      if (abort.signal.aborted) {
        // 写盘的人没有遵守约定（`signal` 被 abort 之后**必须抛**），
        // 交回了一份报告。而这份报告是坏的：它描述的是一次我们已经
        // 决定不再信任的写入 —— 说「成功」的那个版本最危险，因为
        // 它会把一次可能只写了一半的操作标成 APPLIED。
        //
        // 因此这里丢掉报告，按「没有报告」处理。代价是可能把一次
        // 真的写完的写入判成待恢复 —— 那是一次人工核验，
        // 而反过来是**静默地**把半成品当成成品。
        state = 'RECOVERY_REQUIRED';
        detail = `${abortReason}（写入方在此之后仍交回了「${report.kind}」报告，已按待恢复处理）`;
      } else {
        ({ state, detail } = interpretReport(report));
      }
    } catch (error) {
      // **一切**没有报告的情形都到这里：取消、断线、超时、写盘抛错。
      // 它们合并成同一个去向，因为它们的共同点正是「不知道写到了哪」——
      // 而「不知道」在 §8.1 里只有一个状态。
      state = 'RECOVERY_REQUIRED';
      detail = abort.signal.aborted
        ? abortReason
        : `写入过程抛出：${error instanceof Error ? error.message : String(error)}`;
    } finally {
      clearTimeout(timer);
      clearInterval(beat);
      detachStop?.();
    }

    this.#finalize(plan, state, detail);
    return {
      kind: 'finished',
      operation_id: plan.operation_id,
      change_id: plan.change.id,
      state,
      detail,
    };
  }

  /**
   * 收尾：把结果落成状态。**自己一个短事务。**
   *
   * `from` 由**报告**反推，而不是「把三格都写上」。`refuseTransition` 要求
   * 声明的来源里**每一个**都能走到目标，因此那句看似保守的
   * `from: EXECUTION_STATES` 在 `to: 'APPLIED'` 上是**非法**的 ——
   * 转移表里没有 `VALIDATING → APPLIED` 这条边（见 `finalizeSources`）。
   *
   * `VALIDATING → APPLYING` 这一步属于**写盘的人**（§8.2 步骤 5
   * 「数据库记录执行意图」），因为它才是那个知道「复核通过了」的人。
   *
   * `finished` 只在真正终结时才为真：`RECOVERY_REQUIRED` 不是终局，
   * 它的记账还要继续被人读（`OperationsRepo.listUnfinished` 刻意不含它，
   * 而 `listByStates` 会找到它）。
   */
  #finalize(plan: ExecutionPlan, state: FinishedState, detail: string): void {
    const repos = this.#repos;

    repos.transaction(() => {
      // 报告说「写完了」而记账还停在 `VALIDATING` 时，先补上那一步。
      // 理由见 `stepIntoApplying`。
      if (state === 'APPLIED') stepIntoApplying(repos, plan);

      const from = finalizeSources(state);
      transitionChange(repos, { change_id: plan.change.id, from, to: state });
      transitionOperation(repos, {
        operation_id: plan.operation_id,
        from,
        to: state,
        finished: state !== 'RECOVERY_REQUIRED',
      });
      repos.journal.append({
        operation_id: plan.operation_id,
        stage: JOURNAL_STAGE[state],
        // 成功那一格没有错误码。`RECOVERY_REQUIRED` 有：它是一条**要求动作**
        // 的记录，而读到它的人（恢复流程、操作者）首先要知道该看哪个码。
        error_code: state === 'RECOVERY_REQUIRED' ? 'RECOVERY_REQUIRED' : null,
        detail,
      });
    });
  }
}

/**
 * 把记账从 `VALIDATING` 推进到 `APPLYING`。已经在 `APPLYING` 就什么都不做。
 *
 * ## 为什么这是一个**兜底**，而不是「替写盘的人做」
 *
 * 正常路径上这一步由写盘的人自己做（§8.2 步骤 5「数据库记录执行意图」），
 * 而且**必须**由它做：只有它知道「全部既有文件身份与原始哈希都核对过了」。
 * 本模块不能在调用 `#apply` 之前先把这一格写上 —— 那样一次在校验阶段就
 * 退出的执行（报告 `conflict`）会留下 `APPLYING`，而
 * `APPLYING → CONFLICT` **不是**转移表里的边。
 *
 * ## 那为什么还要兜底
 *
 * 因为不兜底的失效方式恰好是最坏的那一种。转移表里
 * `VALIDATING → APPLIED` 不存在，于是「写盘的人交回了 `applied`、
 * 却没有先记执行意图」会让 `#finalize` **在字节已经落盘之后抛异常**：
 *
 *  - 文件是新的；
 *  - 记账停在 `VALIDATING`，既不是「写完了」也不是「没写」；
 *  - 槽指向一个非终局的操作，于是 `clearBlockade` 也会拒绝。
 *
 * 而这一切发生在写完之后 —— 也就是说，一次**成功**的写入被记成了一次
 * 需要人工解释的悬案。
 *
 * 兜底的方向性因此是清楚的：写下 `APPLYING` 再写 `APPLIED`，
 * 与「报告说写完了」这个已知事实一致；而抛异常与事实不一致。
 * 这一跳只补偿**记账**，不改变「谁有权决定写入」——
 * 写盘的人依然可以在核对失败时给出 `conflict`，而那时本函数根本不会被调用。
 */
function stepIntoApplying(repos: Repositories, plan: ExecutionPlan): void {
  // 两行必须**同时**停在 `VALIDATING` 才补跳：它们在生产路径上从来没有
  // 分开走过，因此「一个到了 APPLYING、另一个还停在 VALIDATING」意味着
  // 记账已经坏了。那种情形下让下面那句流转响，比在这里把它抹平诚实。
  const operation = repos.operations.findById(plan.operation_id);
  const change = repos.changes.findById(plan.change.id);
  if (operation?.state !== 'VALIDATING' || change?.state !== 'VALIDATING') return;

  transitionChange(repos, { change_id: plan.change.id, from: ['VALIDATING'], to: 'APPLYING' });
  transitionOperation(repos, {
    operation_id: plan.operation_id,
    from: ['VALIDATING'],
    to: 'APPLYING',
  });
}

/**
 * 执行阶段的三格 —— `ChangeSetState` 与 `OperationState` 的**交集**。
 *
 * 手写而不是 `Extract<ChangeSetState, OperationState>`：后者给出的交集
 * 包含 `APPLIED`、`CONFLICT` 这些终局，不是这里要的那个集合。
 * 手写的好处是这一份列表**同时**被两张转移表检查 ——
 * `transitionChange` 收 `readonly ChangeSetState[]`，`transitionOperation`
 * 收 `readonly OperationState[]`，而这里同一个数组要能喂给两者。
 * 于是任何一张表删掉这三格里的一个，编译器都会在这里报错。
 */
type ExecutionStage = 'QUEUED' | 'VALIDATING' | 'APPLYING';

const EXECUTION_STAGES: readonly ExecutionStage[] = ['QUEUED', 'VALIDATING', 'APPLYING'];

/**
 * 收尾时声明的**来源状态**。
 *
 * 由报告反推：报告本身就说明了这次执行走到了哪一格，而转移表是按
 * 「走到哪一格」写的。把三格都声明上不是保守，是**非法** ——
 * `refuseTransition`（`packages/changes/src/state-machine.ts`）要求
 * 来源里每一个都能走到目标，因此 `from: [QUEUED, VALIDATING, APPLYING]`
 * 配 `to: APPLIED` 会当场被拒：`VALIDATING → APPLIED` 不是一条边。
 *
 * 这条规则与 §8.1 的图是同一件事的两种写法：
 *
 * | 报告 | 蕴含的阶段 | 为什么 |
 * | --- | --- | --- |
 * | `applied` | 至少 `APPLYING` | 字节落了盘，那就必然先记过执行意图 |
 * | `rolled_back` | 至少 `APPLYING` | 同上 —— 它收回的正是**落过盘**的字节 |
 * | `conflict` / `no_change` / `refused` | 只到 `VALIDATING` | 三者都在**写之前**退出 |
 * | 无报告 | 三格里的任何一格 | 「不知道写到哪了」不排除任何一格 |
 *
 * 第二行不是形式上的讲究：一个已经记下执行意图的执行**不该**再报
 * `no_change`（「什么也不用改」是在核对阶段就该知道的事），
 * 而转移表里也确实没有 `APPLYING → FAILED_NO_CHANGE`。
 */
function finalizeSources(state: FinishedState): readonly ExecutionStage[] {
  switch (state) {
    case 'APPLIED':
    case 'ROLLED_BACK':
      return ['APPLYING'];
    case 'CONFLICT':
    case 'FAILED_NO_CHANGE':
      return ['VALIDATING'];
    case 'RECOVERY_REQUIRED':
      return EXECUTION_STAGES;
    default: {
      const never: never = state;
      throw new Error(`未处理的终局：${String(never)}`);
    }
  }
}

/**
 * 报告 → 终局。
 *
 * `no_change` 映到 `FAILED_NO_CHANGE`：它在字面上像是「失败了」，而
 * §8.1 把它与 `CONFLICT` 并列成 `VALIDATING` 的两条前进边，含义是
 * 「这次执行结束了，且**没有**改动任何字节」。既不重试、也不标成成功。
 *
 * `refused` 映到**同一个终局**。这不是偷懒：拒绝与「不用改」在这张图里
 * 是同一种事实 —— **写之前就结束了，零字节**。给拒绝单独造一个状态会
 * 需要一条新的边（`VALIDATING → ?`），而那条边要能成立就必须先回答
 * 「这个状态在恢复与阻断逻辑里算什么」，可它与 `FAILED_NO_CHANGE` 的
 * 答案完全一样。分开的唯一后果是多一个任何代码都不该区别对待的状态。
 * 两者的**区别落在 `detail` 上**，而 `detail` 会进执行日志 —— 那正是
 * 操作者读病因的地方。
 *
 * `rolled_back` 按名字映到同一个名字的状态（LWB-029）：报告说的是
 * 「写下去过，然后收回来了」，而状态机里那件事就叫 `ROLLED_BACK`。
 * 它与 `failed_no_change` 在磁盘上的终态相同，在**过程**上不同 ——
 * 而过程正是恢复流程与操作者要读的那一半，所以它们不必合并。
 */
function interpretReport(report: ApplyReport): { state: FinishedState; detail: string } {
  switch (report.kind) {
    case 'applied':
      return { state: 'APPLIED', detail: `写入完成并已核验。${report.detail ?? ''}` };
    case 'no_change':
    case 'refused':
      return { state: 'FAILED_NO_CHANGE', detail: report.detail };
    case 'conflict':
      return { state: 'CONFLICT', detail: report.detail };
    case 'rolled_back':
      return { state: 'ROLLED_BACK', detail: report.detail };
    default: {
      const never: never = report;
      throw new Error(`未处理的写入报告：${JSON.stringify(never)}`);
    }
  }
}

/** 导出给测试与上层：这五种报告就是「写盘的人」能给出的**全部**。 */
export const APPLY_REPORT_KINDS = ['applied', 'no_change', 'conflict', 'refused', 'rolled_back'] as const;
