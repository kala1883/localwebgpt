/**
 * 排队与查询：**唯一操作**的两个入口（LWB-022 步骤 3、验收标准 1 与 3）。
 *
 * ## 一个修改集最多一个操作 —— 由两条不同的机制保证，缺一不可
 *
 * | 机制 | 它挡的是什么 | 它在哪 |
 * | --- | --- | --- |
 * | 来源状态检查（表驱动） | 第二次调用**根本走不到写入** | `queueOperation` 里的 `transitionChange` |
 * | `UNIQUE(change_id)` | 状态检查被绕过时仍然只有一行 | 迁移 v1 的 `operations_change_uq` |
 *
 * 只有唯一索引时，第二次调用会走完一整套流程再在最后一步撞墙 ——
 * 中途产生的日志、快照与审计都已经是**第二次**的了。
 * 只有状态检查时，任何绕过它（直接发 SQL、将来某个新的调用点）都会
 * 造出第二个操作。两条都留着，是因为它们挡的是不同的东西。
 *
 * 幂等键解决的是**另一个**问题：同一次调用重试。方案 §7 把这句写在明处 ——
 * 「相同 change_id 无论几个 apply 键，只关联一个 operation」。
 * 因此 `queueOperation` 收下 `idempotency_key` 只是为了**记账**
 * （它是排障时「这次排队是哪一次调用带来的」的线索），它**不参与**
 * 「要不要新建一个操作」的判定。
 *
 * ## 查询只认 operation_id（验收标准 3）
 *
 * 「所有未知结果都可以用 operation_id 查询，**不要求重新发同一写任务**」。
 * 这句话在实现上的意思是：`queryOperation` 的入参里**只有** `operation_id` ——
 * 不要幂等键、不要 `request_id`、不要 change_id。因为它们可能已经不在
 * 调用方手上了：模型那次调用的 `request_id` 是服务端发的一次性值，
 * 幂等键在客户端，而**唯一**在断线重连、进程重启之后仍然确定的东西
 * 就是 daemon 自己发出去的那个 `operation_id`。
 *
 * 若把幂等键也做成查询的必填项，这条验收就退化成「重发同一写任务」——
 * 而重发正是「不知道」时最不该做的事。
 */

import { BridgeError } from '@lwb/contracts';
import type { ChangeSetState } from '@lwb/contracts';
import type { ChangeSetRecord, OperationRecord, Repositories } from '@lwb/persistence';
import { transitionChange } from '@lwb/changes';

import type { ChangeId, OperationId } from './ids.ts';
import { classifyOperation, type ItemResultLike, type OperationOutcome } from './outcome.ts';

/** 追加日志的一行。字段与 `JournalRepo.list` 的返回一致。 */
export interface JournalEntry {
  readonly seq: number;
  readonly item_id: string | null;
  readonly stage: string;
  readonly observed_file_id: string | null;
  readonly observed_sha256: string | null;
  readonly target_sha256: string | null;
  readonly error_code: string | null;
  readonly detail: string | null;
  readonly created_at: string;
}

export interface QueueOperationInput {
  /**
   * 品牌类型 `ChangeId`，**不是**普通 `string`。这是有意的摩擦。
   *
   * 品牌是**类型层面**的区分，不是运行时校验（`asChangeId` 只检查非空、
   * 长度与控制字符），它挡的是这一类错误：调用方手上正好有一个
   * `OperationId`（比如刚从 `queryOperation` 拿回来），于是顺手把它当成
   * `change_id` 传进来「重新排一次队」。这两个值在实现里都是字符串，
   * 编译器本来是哑的 —— 有了品牌，这一行就编译不过。
   *
   * 代价是：手上只有普通 `string` 的调用方必须在**自己那层**显式写一次
   * `asChangeId(...)`。这是有意的 —— 让「我这里拿到的其实是个没校验过的
   * 字符串」在代码评审时看得见，而不是被签名悄悄吸收掉。
   */
  readonly change_id: ChangeId;
  /**
   * 本次排队**允许的来源状态**。必填，没有默认值。
   *
   * 与 `ChangesRepo.transition` 要求显式声明 `from` 是同一条理由：
   * 它把「我认为这个修改集现在处于什么状态」写在调用点上，于是
   * 「它其实已经不在那个状态了」是一次**条件写失败**，而不是一次
   * 读到旧值之后的心算。给一个默认值等于把这件事藏起来。
   *
   * 两条调用路径（控制台的「批准并应用」与执行器）目前都传
   * `['APPROVED']` —— 前者的 `PENDING_APPROVAL → APPROVED` 由调用方
   * 在同一个事务里先走完（见 `approveAndQueue`）。仍然要求显式写出，
   * 是为了让将来某个真从别处出发的调用点**必须**说出它从哪来，
   * 而不是继承一个碰巧对的默认值。
   */
  readonly from: readonly ChangeSetState[];
  /** 调用方生成的业务幂等键。**仅供记账**，不参与「要不要新建操作」的判定。 */
  readonly idempotency_key?: string | null;
  readonly worker_instance?: string | null;
  /** 新操作的 id 工厂。生产走 `newOperationId`；测试注入确定性 id。 */
  readonly new_operation_id: () => string;
}

export interface QueuedOperation {
  readonly operation: OperationRecord;
  readonly change: ChangeSetRecord;
  /** `true` = 这个修改集此前已经排过队，本次没有创建新操作。 */
  readonly existed: boolean;
}

/**
 * 排队：把修改集推进到 `QUEUED` 并取得它**唯一**的那个操作。
 *
 * 三件事在一个短事务里：状态流转、创建操作、读回修改集。
 * 少了这个事务，「状态已经 QUEUED 而操作不存在」是一个静默的组合 ——
 * 界面显示已排队，而队列里什么都没有。
 *
 * 返回的 `existed` 是**正常返回值**而不是异常：调用方换了幂等键重试时
 * 必须拿到同一个操作，而不是报错，也不是新建第二个。
 */
export function queueOperation(repos: Repositories, input: QueueOperationInput): QueuedOperation {
  return repos.transaction(() => {
    const change = transitionChange(repos, {
      change_id: input.change_id,
      from: input.from,
      to: 'QUEUED',
    });

    const outcome = repos.operations.create({
      id: input.new_operation_id(),
      change_id: input.change_id,
      idempotency_key: input.idempotency_key ?? null,
      ...(input.worker_instance === undefined ? {} : { worker_instance: input.worker_instance }),
    });

    return {
      operation: outcome.operation,
      change: repos.changes.requireById(change.id),
      // `operations.create` 撞唯一索引时返回既有的那一个（而不是抛）。
      // 见文件头：这一分支只在状态检查被绕过时才是可达的。
      existed: outcome.kind === 'exists',
    };
  });
}

export interface OperationQueryResult {
  readonly operation_id: OperationId;
  /** 操作记录是否存在。`false` 时其余字段为 null / 空。 */
  readonly found: boolean;
  readonly operation: OperationRecord | null;
  readonly change: ChangeSetRecord | null;
  readonly items: readonly ItemResultLike[];
  readonly journal: readonly JournalEntry[];
  readonly outcome: OperationOutcome;
}

/**
 * 用 `operation_id` 查询一次写入的**全部**已知事实。
 *
 * 入参只有 `operation_id` —— 见文件头。它**不**要求调用方记得任何
 * 与本次调用相关的东西，因此在断线、超时、进程重启之后仍然可用。
 *
 * 读不到操作记录时**不抛**：那本身就是一个必须能表达的答案
 * （`kind: 'UNKNOWN'`）。抛错会让「这个 id 是什么」与「这个 id 查不到」
 * 在调用方看来是同一件事 —— 而前者是排障，后者是「你抄错了 id」。
 */
export function queryOperation(repos: Repositories, operationId: OperationId): OperationQueryResult {
  const operation = repos.operations.findById(operationId);
  const items = operation === null ? [] : repos.operations.itemResults(operation.id);
  const journal = operation === null ? [] : repos.journal.list(operation.id);

  return {
    operation_id: operationId,
    found: operation !== null,
    operation,
    change: operation === null ? null : repos.changes.findById(operation.change_id),
    items,
    journal: journal as readonly JournalEntry[],
    outcome: classifyOperation({ operation, items }),
  };
}

/**
 * 查询前的形状门：`operation_id` 必须是一个看起来像 id 的东西。
 *
 * 单独抽出来是因为它挡的是**一类**错误而不是一次：一个空串或一段
 * 很长的文本被当成 id 传进来时，`findById` 只会安静地返回 null，
 * 于是「你抄错了」与「它真的不存在」在回报里长得一样。
 */
export function requireOperationId(value: unknown): OperationId {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new BridgeError('INVALID_ARGUMENT', '字段 operation_id 必须是非空字符串。', {
      reason: 'OPERATION_ID_REQUIRED',
    });
  }
  return value as OperationId;
}
