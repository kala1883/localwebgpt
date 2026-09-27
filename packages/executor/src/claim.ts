/**
 * 认领一次执行（LWB-026 步骤 2、方案 §7.2）。
 *
 * > 步骤 2 原文：**消费批准与认领操作采用短事务，外部写入不包裹在长
 * > SQLite 事务中。**
 *
 * 本文件是那句话的**前半句**。后半句（外部写入在事务之外）是
 * `coordinator.ts` 的事，而它之所以能被分开写，是因为这里交付的产物是
 * 一份**已经付清代价的许可**：批准已消费、操作已从队列里取走、
 * 物理工作区已占住。拿到它之后，写盘的人不再需要任何数据库事务。
 *
 * ## 一个事务里做完五件事，顺序不是随意的
 *
 * ```text
 *   ① 门禁（只读）          批准还在吗、世界还是那个世界吗
 *   ② 读工作区 / 操作        拿物理身份，确认这一行确实是 QUEUED
 *   ③ 判定槽                能不能占这块地（可能要问系统：上个写手还在不在）
 *   ④ 消费批准              一次性，从这里起它不能再被用第二次
 *   ⑤ 流转 + 占槽           QUEUED → VALIDATING，并写下栅栏令牌
 * ```
 *
 * ①②在前是因为它们**只读**：一次「没有批准」的拒绝不该在库里留下任何痕迹，
 * 更不该把一块好地阻断掉 —— 那块地跟这个修改集没关系。
 *
 * ④⑤放在③之后是因为③可能抛（`WORKSPACE_BUSY`）。整个事务是全或无，
 * 所以顺序本身不改变原子性；它改变的是**失败时哪一步的异常最贴近事实**——
 * 一个「槽没占上」的调用不该先烧掉一份批准再回滚，那会让下一次排障
 * 从「批准为什么被消费了」开始。
 *
 * ## 为什么必须是 `BEGIN IMMEDIATE`
 *
 * 「读槽 → 判定 → 写槽」这三步之间如果有另一个进程插进来，两个执行器
 * 都会读到「没人在写」。`Repositories.transaction` 用的是
 * `BEGIN IMMEDIATE`，它在**读之前**就取得写锁，因此这里读到的槽不会被
 * 别人改过。这一点是整个互斥的**全部**依据，不是优化。
 *
 * ## 这里**不**探进程
 *
 * 判定表里那一次「问系统持有者还在不在」由 `decideSlot` 在租约过期时
 * 才发起，而它在这里是惰性的（见 `slot-rules.ts` 文件头）。
 * 一个「无论如何先探一次」的实现在这个事务里还有第二重坏处：
 * 探针要起子进程（`apps/daemon/src/lifecycle/process-start-time.ts`），
 * 而那是**在写锁里等一个子进程**。
 */

import { BridgeError } from '@lwb/contracts';
import type { BridgeErrorCode } from '@lwb/contracts';
import { EXECUTION_STATES, evaluateApplyGate } from '@lwb/approvals';
import { EXECUTION_OPERATION_STATES, transitionChange, transitionOperation } from '@lwb/changes';
import { classifyProcessHolder } from '@lwb/ipc';
import type { ProcessIdentity, ProcessProbe } from '@lwb/ipc';
import type {
  ChangeItemRecord,
  ChangeSetRecord,
  OperationRecord,
  Repositories,
  WorkspaceRecord,
} from '@lwb/persistence';

import { orderedForLocking } from './ordering.ts';
import { decideSlot, describeBlockReason, describeSlotRefusal } from './slot-rules.ts';
import type { BlockReason } from './slot-rules.ts';

/**
 * 一次执行的完整依据。**只在认领成功之后存在。**
 *
 * 它是「可以开始写了」的凭证，因此它出现的每一个地方都意味着：
 * 批准已被消费、操作已认领、这块地已被本执行器占住且带着一个栅栏令牌。
 *
 * `items` 已经按加锁次序排好（`orderedForLocking`）—— 排在这里而不是
 * 让写的人自己排，是因为「次序」只有一处定义；两处各排一次，
 * 迟早会在某个只改了一处的提交里变成死锁。
 */
export interface ExecutionPlan {
  readonly operation_id: string;
  readonly change: ChangeSetRecord;
  readonly workspace: WorkspaceRecord;
  readonly executor_id: string;
  /** 单调递增，跨接管只增不减。每次写入都要带上它。 */
  readonly fencing_token: number;
  readonly slot_expires_at: string;
  /** 按加锁次序排好的条目。写入方**必须**按这个次序动文件。 */
  readonly items: readonly ChangeItemRecord[];
  /** 被消费掉的那一条批准。写进审计的「谁批准的」来自这里。 */
  readonly approval_id: string;
  /** 批准绑定的摘要，**由落库事实重算**（不是 `changesets.digest` 那一份）。 */
  readonly digest: string;
}

/** 认领被拒绝的原因。与「阻断」分开：拒绝**不改变任何状态**。 */
export type ClaimRefusalReason =
  /** 门禁拒绝：批准、期限、代次、工作区状态里有一项不成立。 */
  | 'GATE_REFUSED'
  /** 这块地现在不能占，但**没有**被阻断（别人正在写，或持有者还活着）。 */
  | 'SLOT_REFUSED'
  /** 修改集指向的工作区记录不存在。 */
  | 'WORKSPACE_MISSING'
  /** 修改集还没有对应的操作行。 */
  | 'OPERATION_MISSING'
  /** 操作存在但不在 `QUEUED`：它已经被别人认领过，或已终结。 */
  | 'OPERATION_NOT_QUEUED';

export type ClaimOutcome =
  | { readonly kind: 'claimed'; readonly plan: ExecutionPlan }
  /**
   * 不能执行，且**什么都没变**。操作留在队列里，下次可以再试。
   *
   * `code` 与 `message` 足以构造一个原样上抛的 `BridgeError`；
   * `details` 只带排障需要的、**不含路径与内容**的事实。
   */
  | {
      readonly kind: 'refused';
      readonly reason: ClaimRefusalReason;
      readonly code: BridgeErrorCode;
      readonly message: string;
      readonly details: Readonly<Record<string, unknown>>;
    }
  /**
   * 不能执行，且**已经把这块地阻断**。
   *
   * 阻断只能由恢复流程解除（`clearBlockade`），因此它与 `refused` 是
   * 两种不同的产品行为：一个是「等一会儿」，一个是「需要人来」。
   */
  | {
      readonly kind: 'blocked';
      readonly reason: BlockReason;
      readonly message: string;
      readonly previous_operation_id: string | null;
      /** 是否顺带把上一个操作（连同它的修改集）标成了待恢复。 */
      readonly recovered_previous: boolean;
    }
  /** 这块地**本来**就被阻断着。原因取第一次那一条，不覆盖。 */
  | {
      readonly kind: 'already_blocked';
      readonly message: string;
      readonly blocked_reason: string | null;
      readonly by_operation_id: string | null;
    };

export interface ClaimDeps {
  readonly repos: Repositories;
  /** 本执行器的标识（`newExecutorId()`）。同一个执行器续约时不变。 */
  readonly executor_id: string;
  /** 本执行器的进程身份，写进槽里供下一次接管判定使用。 */
  readonly holder: ProcessIdentity;
  /** 问「持有者还在不在」。**只在租约过期时被调用**，见文件头。 */
  readonly probe: ProcessProbe;
  /** 写执行槽的租约时长（毫秒）。 */
  readonly lease_ms: number;
  /** 当前时刻（毫秒纪元）。注入以便测试构造过期场景。 */
  readonly now: () => number;
}

/**
 * 认领：把一次已批准的执行从「队列里的一行」变成「一份可以开工的许可」。
 *
 * **整个函数体是一个 `BEGIN IMMEDIATE` 事务。**因此它里面绝不能有
 * `await`、绝不能碰文件、绝不能起子进程 —— 那不是风格要求，
 * 是 `better-sqlite3` 的同步语义决定的（异步回调会跑到事务外面去）。
 */
export function claimForExecution(deps: ClaimDeps, changeId: string): ClaimOutcome {
  const nowMs = deps.now();
  const now = new Date(nowMs).toISOString();
  const { repos } = deps;

  return repos.transaction((): ClaimOutcome => {
    // ① 门禁。用**执行中**的来源集合：此刻修改集应当已经是 QUEUED，
    //    问「它是不是 APPROVED」在这里是错的（那是排队前的入口，
    //    见 `APPLY_ENTRY_STATES`）。
    const verdict = evaluateApplyGate({ repos, change_id: changeId, allowed_from: EXECUTION_STATES, now });
    if (verdict.kind === 'refused') {
      return refuse('GATE_REFUSED', verdict.code, verdict.message, { gate_reason: verdict.reason });
    }
    const change = verdict.change;

    // ② 工作区与操作。
    const workspace = repos.workspaces.findById(change.workspace_id);
    if (workspace === null) {
      // 门禁里的 `revalidateExecutionBindings` 会先报 `WORKSPACE_MISSING`，
      // 因此这条分支今天到不了。留着是因为下面需要这一行的
      // `volume_id` / `root_file_id` —— 而「需要它」与「它一定在」
      // 是两件事，让后者成为一个显式的 if 比一个 `!` 断言诚实。
      return refuse('WORKSPACE_MISSING', 'WORKSPACE_NOT_GRANTED', '该修改集指向的工作区不存在。', {
        workspace_id: change.workspace_id,
      });
    }

    const operation = repos.operations.findByChangeId(change.id);
    if (operation === null) {
      return refuse('OPERATION_MISSING', 'CHANGE_STATE_INVALID', '该修改集尚未排队，没有可认领的操作。', {
        change_id: change.id,
      });
    }
    if (operation.state !== 'QUEUED') {
      // 不抛：抛会把一次正常的竞争变成一次排障事件，而这台机器上
      // 唯一会走到这里的另一个写手就是我们自己。
      return refuse('OPERATION_NOT_QUEUED', 'CHANGE_STATE_INVALID', '该操作已被认领或已终结，不能重复认领。', {
        operation_id: operation.id,
        state: operation.state,
      });
    }

    // ③ 判定。
    const slot = repos.write_slots.find(workspace.volume_id, workspace.root_file_id);
    const decision = decideSlot({
      slot,
      previous_operation: slot === null ? null : repos.operations.findById(slot.operation_id),
      now_ms: nowMs,
      probe_holder: () => {
        if (slot === null) {
          // 不可达：`decideSlot` 只在**有行**时才调用本 thunk。
          // 真到了这里，抛出去会被 `decideSlot` 接住并当成「查不清」，
          // 而那是保守的那一侧 —— 于是这条不可能的分支也不会让谁写下去。
          throw new Error('决定占用时却没有槽行，无法判定持有者状态。');
        }
        return classifyProcessHolder(deps.probe, {
          pid: slot.holder_pid,
          started_at: slot.holder_started_at,
        });
      },
    });

    switch (decision.kind) {
      case 'claim':
        return claimSlot(deps, {
          change,
          workspace,
          operation,
          approval_id: verdict.approval.id,
          digest: verdict.digest,
          now,
          fencing_token: decision.fencing_token,
        });

      case 'refuse':
        return refuse('SLOT_REFUSED', 'WORKSPACE_BUSY', describeSlotRefusal(decision.reason), {
          slot_reason: decision.reason,
          held_by_operation: decision.by,
          volume_id: workspace.volume_id,
          root_file_id: workspace.root_file_id,
        });

      case 'block': {
        // 先标上一个操作，**再**阻断这块地。
        //
        // 反过来的话，一次中途失败（比如状态流转撞上并发）会留下
        // 「操作已标待恢复、地却没被阻断」—— 而那是唯一一种
        // 「待恢复的操作占着的地可以被别人占掉」的组合。
        // 这个顺序下失败的结果是「什么都没变 + 一个异常」：不静默，
        // 也不留下一半的状态。
        const recovered = decision.recover_previous
          ? markPreviousForRecovery(repos, decision.previous_operation_id)
          : false;
        repos.write_slots.block({
          volume_id: workspace.volume_id,
          root_file_id: workspace.root_file_id,
          reason: decision.reason,
        });
        return {
          kind: 'blocked',
          reason: decision.reason,
          message: describeBlockReason(decision.reason),
          previous_operation_id: decision.previous_operation_id,
          recovered_previous: recovered,
        };
      }

      case 'already_blocked':
        return {
          kind: 'already_blocked',
          message: describeSlotRefusal('WORKSPACE_BLOCKED'),
          blocked_reason: decision.reason,
          by_operation_id: decision.by,
        };

      default: {
        const never: never = decision;
        throw new Error(`未处理的槽判定：${JSON.stringify(never)}`);
      }
    }
  });
}

/**
 * 真正把许可发出去：消费批准、流转状态、占槽。
 *
 * 抽出来只为让上面那个 switch 读得完 —— 它没有自己的判定，
 * 因此**不得**在任何别处调用。
 */
function claimSlot(
  deps: ClaimDeps,
  input: {
    readonly change: ChangeSetRecord;
    readonly workspace: WorkspaceRecord;
    readonly operation: OperationRecord;
    readonly approval_id: string;
    readonly digest: string;
    readonly now: string;
    readonly fencing_token: number;
  },
): ClaimOutcome {
  const { repos } = deps;
  const { change, workspace, operation } = input;

  // ④ 消费批准。**必须**是 `consume` 而不是「读一下再改状态」：
  //    那一条 SQL 的 WHERE 里同时带着 state / digest / expires_at，
  //    因此「批准过期之后仍被执行」与「摘要不符的批准被执行」
  //    这两个竞态在数据库层就没有了，不依赖这里的心算。
  repos.approvals.consume({
    approval_id: input.approval_id,
    digest: input.digest,
    operation_id: operation.id,
    now: input.now,
  });

  // ⑤ 流转。修改集与操作一起走 —— 它们在生产路径上从来没有分开过，
  //    而分开的那一天正是控制台显示「操作在跑」而修改集还写着「已排队」的那天。
  transitionChange(repos, { change_id: change.id, from: ['QUEUED'], to: 'VALIDATING' });
  transitionOperation(repos, { operation_id: operation.id, from: ['QUEUED'], to: 'VALIDATING' });

  const expiresAt = new Date(Date.parse(input.now) + deps.lease_ms).toISOString();
  repos.write_slots.claim({
    volume_id: workspace.volume_id,
    root_file_id: workspace.root_file_id,
    workspace_id: workspace.id,
    operation_id: operation.id,
    executor_id: deps.executor_id,
    fencing_token: input.fencing_token,
    holder_pid: deps.holder.pid,
    holder_started_at: deps.holder.started_at,
    expires_at: expiresAt,
  });

  return {
    kind: 'claimed',
    plan: {
      operation_id: operation.id,
      change: repos.changes.requireById(change.id),
      workspace,
      executor_id: deps.executor_id,
      fencing_token: input.fencing_token,
      slot_expires_at: expiresAt,
      items: orderedForLocking(repos.changes.items(change.id)),
      approval_id: input.approval_id,
      digest: input.digest,
    },
  };
}

/**
 * 把上一个操作（连同它的修改集）标成待恢复。
 *
 * **只有**确定它已经不在跑了才被调用（`recover_previous`），
 * 见 `slot-rules.ts`：持有者可能还活着的时候去改它的操作状态，
 * 会把一次正在进行的写入的记账弄坏。
 *
 * 两行**必须一起**标：只标其中一个，会让控制台与工具面给出两个不同的
 * 答案，而它们读的是同一件事。
 *
 * 这里不做「状态在不在允许集合里」的判断，而是直接交给转移表去断言 ——
 * `EXECUTION_STATES` 正好是两张表允许前往 `RECOVERY_REQUIRED` 的**全部**
 * 来源。状态对不上是一个模式层不完整的信号，应当响，不该被这里吞成 `false`。
 *
 * @returns 上一个操作是否真的被标了。指向的操作不存在时为 `false`。
 */
function markPreviousForRecovery(repos: Repositories, previousOperationId: string | null): boolean {
  if (previousOperationId === null) return false;
  const previous = repos.operations.findById(previousOperationId);
  if (previous === null) return false;

  transitionOperation(repos, {
    operation_id: previous.id,
    // 用 `EXECUTION_OPERATION_STATES` 而不是 `EXECUTION_STATES`：两个字面量
    // 相同，类型不同，混用编译器会拦。见那个常量的说明。
    from: EXECUTION_OPERATION_STATES,
    to: 'RECOVERY_REQUIRED',
  });
  const previousChange = repos.changes.findById(previous.change_id);
  if (previousChange !== null) {
    transitionChange(repos, {
      change_id: previousChange.id,
      from: EXECUTION_STATES,
      to: 'RECOVERY_REQUIRED',
    });
  }
  return true;
}

/**
 * 把一次拒绝变成 `BridgeError`，供控制层与工具层原样上抛。
 *
 * 与 `@lwb/approvals` 的 `gateRefusalToError` 同形：两处都是「判定完了，
 * 上层要有一种统一的抛法」。
 */
export function claimRefusalToError(outcome: Extract<ClaimOutcome, { kind: 'refused' }>): BridgeError {
  return new BridgeError(outcome.code, outcome.message, {
    reason: outcome.reason,
    ...outcome.details,
  });
}

function refuse(
  reason: ClaimRefusalReason,
  code: BridgeErrorCode,
  message: string,
  details: Readonly<Record<string, unknown>>,
): Extract<ClaimOutcome, { kind: 'refused' }> {
  return { kind: 'refused', reason, code, message, details };
}
