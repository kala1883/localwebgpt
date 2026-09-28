/**
 * 批准与拒绝（LWB-021 步骤 2、3）。
 *
 * ## 授权只能从这里产生
 *
 * 本模块是**唯一**能让 `approvals` 表多出一行的路径，而它只接受一个形状的
 * 输入：`{change_id, digest, actor}`。里面**没有**位置给
 * `approved` / `force` / `user_id` / `session_id` / `conversation_label`。
 * 这不是「我们记得不读它们」，而是它们在这个函数的类型里不存在
 * （ADR-003 §4：身份与授权来自通道，不来自参数）。
 *
 * 三条拒绝复用授权的规则，全部由**数据库条件写**保证，不靠调用方自觉：
 *
 *  1. **拒绝、到期后不得复用**：批准是一次性的，`state='ACTIVE'` 是它
 *     还能被消费的唯一形态；部分唯一索引 `approvals_active_uq` 保证一个
 *     修改集同时只有一条 ACTIVE，`approvals_no_reactivate` 保证它退不回来。
 *  2. **修改后的摘要不得复用**：`ApprovalsRepo.create` 把
 *     `digest = ?` 写进 `INSERT … SELECT … WHERE`，而
 *     `approvals_binding_matches_change` 触发器在写入那一刻再核一次。
 *  3. **重复决定不得产生第二次授权**：见 `approveChange` 里对来源状态的
 *     要求（只有 `PENDING_APPROVAL` 能决定），它由 `ChangesRepo.transition`
 *     的 `WHERE state IN (…)` 表达成一个原子条件写。
 *
 * ## 「批准」「拒绝」「批准并应用」是三个动作，不是一个带开关的动作
 *
 * 它们的**后果不同**：批准只是记下一个事实（修改集变成 `APPROVED`，
 * 没有任何排队）；拒绝是终态（`REJECTED`，`TERMINAL_CHANGE_STATES` 里）；
 * 「批准并应用」额外创建一个唯一操作。把后两者塞进一个布尔参数，
 * 会让「这次调用到底动了什么」依赖于一个容易传错的位。
 */

import { transitionChange } from '@lwb/changes';
import { BridgeError, LIMITS, newApprovalId, newOperationId } from '@lwb/contracts';
import { asChangeId, queueOperation } from '@lwb/idempotency';
import type { Repositories } from '@lwb/persistence';
import type { ApprovalRecord, ChangeSetRecord, OperationRecord } from '@lwb/persistence';

import { isAwaitingDecision, reloadChangeSet } from './reload.ts';

/** 本地操作者标识：作出决定的控制台会话（`console:<session_id>`）。 */
export type DecisionActor = string;

export interface DecisionInput {
  readonly repos: Repositories;
  readonly change_id: string;
  /** 控制台展示给操作者、并由操作者提交的**完整摘要**。 */
  readonly digest: string;
  readonly actor: DecisionActor;
  /** 判定时刻（ISO 8601）。省略时取当前时间。 */
  readonly now?: string;
  /** 批准有效期（毫秒）。省略时取 `LIMITS.APPROVAL_TTL_MS`。 */
  readonly ttl_ms?: number;
  /** 测试注入用；生产走 `newApprovalId`。 */
  readonly new_id?: () => string;
}

/**
 * 决定之前的**共同前置**：重载、重算、比对提交摘要、确认处在待决定状态。
 *
 * 抽出来是因为「批准」与「拒绝」必须做完全相同的检查。两份拷贝的失效方式
 * 是单向的：将来有人给批准那条加一项检查而忘了拒绝那条（或反过来），
 * 两条路径的严格程度就分叉了，而分叉方向取决于谁先被改 —— 不是一种保证。
 */
function requireDecidable(input: DecisionInput): { readonly digest: string } {
  const loaded = reloadChangeSet(input.repos, input.change_id);

  if (!isAwaitingDecision(loaded.change.state)) {
    // 用状态本身而不是「不在终态里」判断：一个已经 APPROVED 的修改集
    // 不是终态，但它也已经不需要（也不允许）第二次决定。
    throw new BridgeError('CHANGE_STATE_INVALID', '该修改集当前状态不接受新的决定。', {
      reason: 'NOT_AWAITING_DECISION',
      current_state: loaded.change.state,
    });
  }

  if (input.digest !== loaded.digest) {
    // 操作者看到的与落库事实不是同一份。这里**不**回报两个摘要中的任何一个：
    // 提交值来自请求体，回显它等于让一个错误的输入看起来被接受了；
    // 而落库值是一份「正确」的答案，没有理由送给一个比对失败的人。
    throw new BridgeError('CHANGE_STATE_INVALID', '提交的摘要与重新加载并重算的摘要不一致；已拒绝。', {
      reason: 'DIGEST_MISMATCH',
    });
  }

  return { digest: loaded.digest };
}

/**
 * 仅批准：记录一条一次性批准，并把修改集推进到 `APPROVED`。
 *
 * **这是「仅批准内部接口」**：它不排队、不创建操作。控制面的「批准并应用」
 * 走 `approveAndQueue`。存在的理由是执行协调器（LWB-026）与撤销流程
 * （LWB-024）需要一个「只记批准、不做别的」的动作。
 *
 * ## 为什么批准与状态流转必须在同一个事务里
 *
 * 分开写会留下两种半成品：有批准而状态还是 `PENDING_APPROVAL`
 * （门禁说「可以」而状态说「还没批准」），或有状态而没有批准
 * （`APPROVED` 却永远无法执行 —— 而它看起来完全正常）。
 * 方案 §7.2 要求「批准消费、操作认领和状态条件更新放入短事务」，
 * 这里是它的前半句。
 *
 * 事务是**立即事务**（`Repositories.transaction`）：两个进程同时批准时，
 * 后到的那个会看到第一条已经写进去的批准，撞上部分唯一索引而失败，
 * 而不是在延迟写里各写一份。
 */
export function approveChange(input: DecisionInput): ApprovalRecord {
  const now = input.now ?? new Date().toISOString();
  const decided = requireDecidable(input);
  const newId = input.new_id ?? newApprovalId;
  const ttl = input.ttl_ms ?? LIMITS.APPROVAL_TTL_MS;
  const approvalId = newId();

  return input.repos.transaction(() => {
    const approval = input.repos.approvals.create({
      id: approvalId,
      change_id: input.change_id,
      digest: decided.digest,
      actor: input.actor,
      expires_at: new Date(Date.parse(now) + ttl).toISOString(),
    });
    input.repos.changes.transition(input.change_id, ['PENDING_APPROVAL'], 'APPROVED');
    return approval;
  });
}

/**
 * 拒绝：把修改集推进到终态 `REJECTED`。**不写入任何批准记录。**
 *
 * 拒绝只流转状态，不留下批准行 —— 一条「拒绝记录」若也写进 `approvals`，
 * 那么「approvals 表里有这个 change_id 的行」就不再等价于「有人批准过它」，
 * 而门禁读的正是这张表。拒绝这个事实由 `changesets.state` 与审计表达。
 */
export function rejectChange(input: DecisionInput): ChangeSetRecord {
  requireDecidable(input);
  return input.repos.changes.transition(input.change_id, ['PENDING_APPROVAL'], 'REJECTED');
}

export interface ApproveAndQueueInput extends DecisionInput {
  /**
   * 幂等键。**与 `operations.create` 的语义一致**：同键重复调用会命中
   * 既有的那一个操作，而不是报错。
   *
   * 它**不**参与授权判定。方案 §7：即使调用方换了幂等键，
   * `UNIQUE(change_id)` 也保证同一个修改集不会有第二个操作 ——
   * 幂等键解决的是「同一次调用重试」，唯一索引解决的是「同一个修改集
   * 被执行两次」，两者不是同一件事，缺一不可。
   */
  readonly idempotency_key?: string | null;
}

export interface ApproveAndQueueResult {
  readonly approval: ApprovalRecord;
  readonly change: ChangeSetRecord;
  readonly operation: OperationRecord;
  /** `true` = 这个修改集此前已经排过队，本次没有创建新操作。 */
  readonly operation_existed: boolean;
}

/**
 * **记录执行授权并排队入口**（供本地复核与已核验的 workspace-grant 路径共用）。
 *
 * 三件事必须一起发生或一起不发生：记录一次性执行授权、把修改集推进到 `QUEUED`、
 * 创建唯一操作。晚一步的状态（有批准、没操作）是**静默损坏**：
 * 界面/调用方显示「已授权」，而队列里什么都没有，没有人会去查。
 *
 * 状态是**两步**走的（`PENDING_APPROVAL → APPROVED → QUEUED`），
 * 理由写在下面那一处：图里没有直连的边，而那条边上没有的东西正是
 * 「没有执行授权记录的修改集排不进队」。两步在同一个事务里，外界看不到中间态。
 *
 * ## 重复点击收敛到哪里（LWB-021 验收标准 3）
 *
 * **第一次**：写入授权记录 → `PENDING_APPROVAL → APPROVED → QUEUED` → 操作创建。
 * **第二次**：`requireDecidable` 在读到状态 `QUEUED` 时就拒绝
 * （`CHANGE_STATE_INVALID` / `NOT_AWAITING_DECISION`），三件事一件都没做。
 *
 * 也就是说收敛由**来源状态检查**完成，而不是由唯一索引兜底 ——
 * 后者虽然也在（`approvals_active_uq` 与 `operations_change_uq`），
 * 但它只在「状态检查被绕过」时才被用到，那时问题已经更严重了。
 * 靠状态检查意味着第二次调用的失败发生在**任何写入之前**。
 *
 * `operation_existed` 因此是一条**残余**分支：只有当修改集回到
 * `PENDING_APPROVAL` 而操作仍然存在时才为真，而 V1 没有任何一条路径
 * 会把它退回去。留着它是因为 `operations.create` 的契约就是「重试拿到
 * 同一个操作」，而把那个契约的返回分支丢掉会让将来的一个合法重试
 * 变成一次静默的新建。
 */
export function approveAndQueue(input: ApproveAndQueueInput): ApproveAndQueueResult {
  const now = input.now ?? new Date().toISOString();
  const decided = requireDecidable(input);
  const newId = input.new_id ?? newApprovalId;
  const ttl = input.ttl_ms ?? LIMITS.APPROVAL_TTL_MS;
  const approvalId = newId();
  // `queueOperation` 收的是品牌类型 `ChangeId`（理由写在那个文件里）。
  // 转换写在这里、写在事务**之前**：`DecisionInput.change_id` 是未受信的
  // 请求字段，形状不对时不应该有任何写入发生 —— 放进去会让一次畸形输入
  // 以「事务已开启再回滚」的形式收场，白开一次立即事务。
  const changeId = asChangeId(input.change_id);

  return input.repos.transaction(() => {
    const approval = input.repos.approvals.create({
      id: approvalId,
      change_id: input.change_id,
      digest: decided.digest,
      actor: input.actor,
      expires_at: new Date(Date.parse(now) + ttl).toISOString(),
    });

    // 先走到 `APPROVED`，再由 `queueOperation` 走到 `QUEUED` —— **两步，
    // 不是一步**。方案 §8.1 的图里没有 `PENDING_APPROVAL → QUEUED` 这条边，
    // 而这不是可以变通的形式问题：「QUEUED 的唯一前驱是 APPROVED」正是
    // 「没有批准的修改集排不进队」这条保证在状态机里的写法。为了少一次
    // UPDATE 而把这条边补进图里，等于把「绕过批准直接排队」变成一条
    // **合法**转移，从此任何调用点都能这么写。
    //
    // 两步都在**同一个立即事务**里，因此外界看不到中间的 `APPROVED`：
    // 「批准、状态、操作三者同生同死」（本文件 LWB-021 的验收标准 1）不受影响。
    transitionChange(input.repos, {
      change_id: changeId,
      from: ['PENDING_APPROVAL'],
      to: 'APPROVED',
    });

    // 排队走 `@lwb/idempotency` 的 `queueOperation`，而不是在这里再写一遍
    // 「流转 + 建操作」：那两步必须在同一个短事务里（方案 §7.2），而
    // **只有一处**能把操作写进 `operations` 表，`UNIQUE(change_id)` 的语义
    // 才只有一个解释者。执行器（LWB-026）取一个已批准的修改集时走的是
    // 同一个函数、同一个 `from` —— 两条路径的收敛方式因此不会分叉。
    //
    // 它内部会再开一次 `repos.transaction`：better-sqlite3 的嵌套事务是
    // SAVEPOINT 语义（内层失败只回滚内层），因此这里的外层依然是这一整段
    // 的原子单元。
    const queued = queueOperation(input.repos, {
      change_id: changeId,
      from: ['APPROVED'],
      idempotency_key: input.idempotency_key ?? null,
      new_operation_id: newOperationId,
    });

    return {
      approval,
      change: queued.change,
      operation: queued.operation,
      // 见上面「重复点击收敛到哪里」一段。
      operation_existed: queued.existed,
    };
  });
}
