/**
 * 「这块地现在能不能占」—— 判定表（LWB-026 步骤 1 与 3、验收标准 1 与 3）。
 *
 * 本文件是**纯函数**：给同样的输入必给同样的输出，不读时钟、不碰数据库、
 * 不问进程。三件有副作用的事都由调用方按返回值去做。这样安排不是为了好看，
 * 而是因为验收标准 3 是一条关于**何时不许动**的规则，它必须能被穷尽地摆开看。
 *
 * ## 三条判定，各自防的是一件不同的事
 *
 * | 情形 | 判定 | 它防的是什么 |
 * | --- | --- | --- |
 * | 租约仍有效 | 拒绝，不动 | 两个执行器同时写同一块地 |
 * | 租约过期、持有者**还活着** | 拒绝，不动 | 把「没收到续约」读成「它死了」（休眠/断点/CPU 饥饿） |
 * | 租约过期、持有者**查不清** | 拒绝 + **阻断** | 在无法证明时放行 —— 上面那条的最坏变体 |
 * | 租约过期、持有者**确定已退出** | 拒绝 + **阻断** + 上一操作转待恢复 | 把「上位执行器死了」读成「这次写入没发生」 |
 *
 * 最后一行的方向值得单独说：持有者死了**不等于**字节没写。它可能刚好死在
 * 写完一半的位置，而那时文件已经是第三态（既不是旧内容也不是新内容）。
 * 因此这里**不接管**，而是把地阻断、把上一操作标成待恢复 ——
 * 由恢复流程（LWB-030）在能证明的地点继续，而不是由一个新的写入者猜。
 *
 * ## 为什么「租约有效」时**不**去问进程
 *
 * 问一次进程是有代价的：真正的探针要起 PowerShell 查启动时刻
 * （`apps/daemon/src/lifecycle/process-start-time.ts`），而它的答案在租约
 * 有效时**不影响**判定 —— 租约有效就已经拒绝了。
 *
 * 更要紧的是第二种坏处：探针自己会失败。一个「无论如何都先探一次」的实现，
 * 会在探针不可用时把一块**正常被持有**的地判成「查不清」进而阻断它 ——
 * 于是本机装不装 PowerShell 决定了工作区会不会自己锁死。
 * 因此这里把探针做成**惰性 thunk**，只在租约过期时调用；
 * 「租约有效 ⇒ 一次探针都不发生」是一条可以被断言的性质
 * （`tests/unit/executor-coordinator.test.ts` 里的 C 组）。
 *
 * ## 阻断行不会被接管
 *
 * `blocked_at` 非空的行一律走 `already_blocked` 分支，**无论**租约是否过期、
 * 持有者是否还活着。解除阻断只有一个入口：恢复流程显式调用
 * `clearBlockade`。这条规则的用途是让「等一会儿再试一次」这条路彻底不存在 ——
 * 一个会被重试解开的阻断，等于一个带超时的锁，而带超时的锁正是本模块
 * 要防的那个东西。
 */

import type { ChangeSetState } from '@lwb/contracts';
import type { HolderStatus } from '@lwb/ipc';
import type { OperationRecord, WorkspaceWriteSlotRecord } from '@lwb/persistence';

/**
 * 持有者进程的状态。**定义在 `@lwb/ipc`**，这里只做转出。
 *
 * 三个值里的 `unknown` 是**重点**：它不等于 `gone`。把「查不出来」写成
 * 「不存在」会让接管判定在不该放行时放行，因此本类型刻意不提供布尔形态。
 *
 * 之所以不在本文件里再定义一遍：判定它的规则只有一份
 * （`classifyProcessHolder`），而租约和执行协调器问的是同一个问题。
 * 类型与规则分居两处，就有人能只改一处。
 */
export type { HolderStatus };

/** 判定所依据的输入。全部是**已经读到的**事实，没有一处现查。 */
export interface SlotDecisionInput {
  /** 该物理身份上的槽；没有则为 `null`。 */
  readonly slot: WorkspaceWriteSlotRecord | null;
  /**
   * 槽指向的那个操作。槽指向一个不存在的操作是**模式层不该发生**的事
   * （外键 `ON DELETE RESTRICT`），因此这里收 `null` 只为把它表达成
   * 「阻断」而不是让调用方去 `throw` —— 一个自己不认识的状态应当让工作区停下来，
   * 而不是让整个进程炸掉。
   */
  readonly previous_operation: OperationRecord | null;
  /** 判定时刻（毫秒纪元）。 */
  readonly now_ms: number;
  /**
   * 探针。**只在租约过期时被调用**，见文件头。
   *
   * 抛异常表示「查不清」，与返回 `'unknown'` 等价 —— 刻意收下两种写法：
   * 探针的失败模式（超时、权限、平台不支持）常常表现为抛，而要求调用方
   * 特意 `try/catch` 之后再返回 `'unknown'`，多出来的那一步总有人忘记。
   */
  readonly probe_holder: () => HolderStatus;
}

export type SlotRefusal =
  /** 租约仍有效。持有者没有犯任何错，只是还在写。 */
  | 'LEASE_VALID'
  /** 租约过期，但持有者进程**仍然存在**。见下：这一条**不**阻断工作区。 */
  | 'HELD_BY_LIVE_EXECUTOR'
  /** 该身份已被阻断（上一次判定留下的），阻断不会被重试解开。 */
  | 'WORKSPACE_BLOCKED';

export type BlockReason =
  /** 查不清持有者是否已退出。LWB-026 步骤 3 的「原生进程状态不明时先阻断工作区」。 */
  | 'HOLDER_STATUS_UNKNOWN'
  /** 持有者确定已退出，但它是在**执行中**退出的 —— 字节写没写、写到哪，都不知道。 */
  | 'PREVIOUS_WRITE_OUTCOME_UNKNOWN';

export type SlotDecision =
  /**
   * 可以占用。`fencing_token` 是要写进槽里的新令牌：
   * 没有旧行时是 1，接管旧行时是旧令牌 + 1。**只增不减**。
   *
   * `took_over_from` 非空表示「这里本来有一行，它指向的操作已经终结」——
   * 那一行是一次**没被清理的残留**。这个字段是**记账用**的，不是指令：
   *
   * > 不要先把它 `release` 掉再占。
   *
   * 因为「令牌只增不减」这条性质在仓储层是由条件 UPSERT 的
   * `WHERE fencing_token < excluded.fencing_token` 兜住的，
   * 而 `release` 之后那一次写入走的是 INSERT 分支 —— 没有旧行可比，
   * 于是守卫就没了。残留行被覆盖本身就是清理，
   * 而覆盖**保留**了那一道 SQL 层的守卫。
   */
  | {
      readonly kind: 'claim';
      readonly fencing_token: number;
      readonly took_over_from: string | null;
    }
  /** 不能占，且**不改变任何状态**。调用方只需把这个操作留在队列里。 */
  | { readonly kind: 'refuse'; readonly reason: SlotRefusal; readonly by: string | null }
  /**
   * 不能占，且**必须把这块地阻断**。
   *
   * `previous_operation_id` 非空表示「上一个操作还挂在那里」，
   * 而 `recover_previous` 决定要不要顺手把它标成待恢复 —— 只有
   * **确定持有者已退出**时才为真。持有者可能还活着的时候去改它的操作状态，
   * 会把一次正在进行的写入的记账弄坏：它随后想从 `APPLYING` 走到 `APPLIED`，
   * 而那一行已经不在 `APPLYING` 了。
   */
  | {
      readonly kind: 'block';
      readonly reason: BlockReason;
      readonly previous_operation_id: string | null;
      readonly recover_previous: boolean;
    }
  /** 已经被阻断过。原因取**第一次**那一条，不覆盖。 */
  | { readonly kind: 'already_blocked'; readonly reason: string | null; readonly by: string | null };

/**
 * 按上一个操作的状态分流。**switch 覆盖状态全集**：
 * `ChangeSetState` 将来多一个值时，这里会因为 `never` 检查而编译失败 ——
 * 而不是让新状态悄悄落进某条「默认拒绝」的分支里。
 *
 * 返回值里 `null` 表示「执行中，请继续往下走租约判定」。
 */
function decisionByPreviousState(
  state: ChangeSetState,
  slot: WorkspaceWriteSlotRecord,
  operationId: string,
): SlotDecision | null {
  switch (state) {
    // 已经终结：这一行是**没被清理的残留**，不是「有人在写」。
    // 这时租约是无关的 —— 租约保护的是「飞行中的字节」，而那些字节已经落地了。
    // 因此不等待租约到期，直接接管（令牌加一，仍然单调）。
    case 'APPLIED':
    case 'ROLLED_BACK':
    case 'FAILED_NO_CHANGE':
    case 'CONFLICT':
      return {
        kind: 'claim',
        fencing_token: slot.fencing_token + 1,
        took_over_from: slot.operation_id,
      };

    // 已经等待恢复：它既没有终结，也不该由新的执行器接手。
    // 不设 `recover_previous`（它已经是那个状态了），只把地阻断 ——
    // 这正是「一块地被一个待恢复的操作占着，谁也别想绕过它」。
    case 'RECOVERY_REQUIRED':
      return {
        kind: 'block',
        reason: 'PREVIOUS_WRITE_OUTCOME_UNKNOWN',
        previous_operation_id: operationId,
        recover_previous: false,
      };

    // 执行中：交给调用方继续做租约判定。
    case 'QUEUED':
    case 'VALIDATING':
    case 'APPLYING':
      return null;

    // 剩下的五个是**修改集**独有的状态，不可能是操作的状态
    // （`operations.state` 的 CHECK 里没有它们）。真出现就说明行被改过，
    // 按「状态库不完整」阻断，而不是猜它想表达什么。
    case 'PENDING_APPROVAL':
    case 'APPROVED':
    case 'REJECTED':
    case 'EXPIRED':
    case 'INVALIDATED':
      return {
        kind: 'block',
        reason: 'PREVIOUS_WRITE_OUTCOME_UNKNOWN',
        previous_operation_id: operationId,
        recover_previous: false,
      };

    default: {
      const never: never = state;
      throw new Error(`未处理的操作状态：${String(never)}`);
    }
  }
}

/**
 * 判定。返回的是**要做什么**，而不是「能不能」——
 * 因为「不能」有两种截然不同的后续：什么也别做，或者必须阻断。
 */
export function decideSlot(input: SlotDecisionInput): SlotDecision {
  const { slot, previous_operation, now_ms } = input;

  // 1. 没有行：直接占，令牌从 1 开始。
  if (slot === null) {
    return { kind: 'claim', fencing_token: 1, took_over_from: null };
  }

  // 2. 已被阻断。放在最前面：阻断是一条**不因任何其他条件而改变**的结论，
  //    先判它可以让下面的分支都不必再考虑这一种状态。
  if (slot.blocked_at !== null) {
    return { kind: 'already_blocked', reason: slot.blocked_reason, by: slot.operation_id };
  }

  // 3. 槽指向的操作不存在：模式层不该发生（外键 RESTRICT），能走到这里说明
  //    状态库自身不完整。不猜，阻断。
  if (previous_operation === null) {
    return {
      kind: 'block',
      reason: 'PREVIOUS_WRITE_OUTCOME_UNKNOWN',
      previous_operation_id: null,
      recover_previous: false,
    };
  }

  // 4. 按上一个操作的状态分流。`null` = 执行中，继续往下做租约判定。
  const byState = decisionByPreviousState(
    previous_operation.state,
    slot,
    previous_operation.id,
  );
  if (byState !== null) return byState;

  // 5. 上一次写入仍在进行。租约有效 ⇒ 拒绝，且**不探进程**。
  if (now_ms < Date.parse(slot.expires_at)) {
    return { kind: 'refuse', reason: 'LEASE_VALID', by: slot.operation_id };
  }

  // 6. 租约过期。过期只说明「没收到续约」，见 `packages/ipc/src/lease.ts`。
  //    这时才有必要去问系统，而且**必须**问。
  let status: HolderStatus;
  try {
    status = input.probe_holder();
  } catch {
    status = 'unknown';
  }

  if (status === 'alive') {
    // 还活着 ⇒ 不阻断。它可能正在正常工作，只是没能续上约；
    // 阻断一块活人正在写的地，会在它收尾之前给它加一个需要人工解释的状态。
    return { kind: 'refuse', reason: 'HELD_BY_LIVE_EXECUTOR', by: slot.operation_id };
  }

  if (status === 'unknown') {
    // 查不清 ⇒ 阻断工作区（步骤 3 原文）。**不动**那个操作的状态：
    // 它可能还活着，改它的状态会弄坏一次进行中的写入的记账。
    return {
      kind: 'block',
      reason: 'HOLDER_STATUS_UNKNOWN',
      previous_operation_id: previous_operation.id,
      recover_previous: false,
    };
  }

  // status === 'gone'：持有者确定已退出，但它是在**执行中**退出的。
  // 「进程没了」与「字节没写」是两件事 —— 它可能刚好死在写到一半的地方，
  // 于是文件处在第三态。这里不接管、不重放，交给恢复流程。
  return {
    kind: 'block',
    reason: 'PREVIOUS_WRITE_OUTCOME_UNKNOWN',
    previous_operation_id: previous_operation.id,
    recover_previous: true,
  };
}

/**
 * 把判定结果压成一句**给人看的话**。
 *
 * 存在的理由与 `packages/ipc/src/lease.ts` 里那段 reason 相同：
 * 排障时读到的应当是「为什么不能占」，而不是一个枚举名。
 */
export function describeSlotRefusal(reason: SlotRefusal): string {
  switch (reason) {
    case 'LEASE_VALID':
      return '该物理工作区已有写入在执行，且租约仍然有效，拒绝第二个执行器。';
    case 'HELD_BY_LIVE_EXECUTOR':
      return (
        '该物理工作区的写执行器租约已到期，但持有者进程**仍然存活**。' +
        '到期只说明没有收到续约，不代表持有者已退出（休眠、断点、CPU 饥饿都会这样）；' +
        '拒绝接管以避免两个执行器同时写。'
      );
    case 'WORKSPACE_BLOCKED':
      return '该物理工作区已被阻断，阻断只能由恢复流程解除，不会被重试解开。';
    default: {
      const never: never = reason;
      throw new Error(`未处理的拒绝原因：${String(never)}`);
    }
  }
}

export function describeBlockReason(reason: BlockReason): string {
  switch (reason) {
    case 'HOLDER_STATUS_UNKNOWN':
      return '无法确认上一个写执行器是否已退出，按「原生进程状态不明时先阻断工作区」阻断。';
    case 'PREVIOUS_WRITE_OUTCOME_UNKNOWN':
      return (
        '上一个写执行器已不在，但它是在执行中退出的：字节写没写、写到哪一步都无从证明，' +
        '因此不重放、不接管，阻断该工作区并交由恢复流程处理。'
      );
    default: {
      const never: never = reason;
      throw new Error(`未处理的阻断原因：${String(never)}`);
    }
  }
}
