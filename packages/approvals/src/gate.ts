/**
 * 执行前的批准门禁（LWB-021 步骤 3 的后半句、方案 §9.3）。
 *
 * ## 它**不消费**批准，这是刻意的
 *
 * 「判断能不能执行」与「占用这次执行权」是两件事，而它们被合并写在一起
 * 是一个很容易犯的错：门禁通常在真正开始写之前很久就要跑一次（排队时、
 * 执行前复核时、返还结果前），而消费是**一次性的**。把两者写成一个函数，
 * 第一个调用点就会把批准烧掉 —— 之后真正的执行拿到的是「已被使用」，
 * 而人看到的是一个再也执行不了的已批准修改集。
 *
 * 因此本模块只读。消费在 `claimForExecution`，它属于执行协调器（LWB-026），
 * 且必须与「认领操作」在同一个短事务里（方案 §7.2）。
 *
 * ## 与 `@lwb/policy` 的 `approvalFailures` 必须给出同一个答案
 *
 * 同一个事实在两处被判定：策略引擎（对模型工具调用整体裁定）与本模块
 * （对写入前的最后一道）。两处若给出不同的结论，就会产生一个
 * 「策略说可以、门禁说不行」的组合 —— 而此时排障的人会去查哪一个？
 *
 * 结论：**映射表逐条对齐**，包括错误码的选择。`APPROVAL_CONSUMED` 映到
 * `CHANGE_STATE_INVALID` 而不是 `APPROVAL_EXPIRED`（「用过了」不是「过期了」，
 * 前者意味着**再去拿一次批准也不会通过**，因为修改集已经不是待批准状态）。
 * 对齐关系写在 `gateReasonToErrorCode` 一处，便于将来被检查。
 *
 * ## 为什么不信任「排队时校验过」
 *
 * LWB-024 的步骤 2 说得很直白：*执行前重新验证批准期限和所有代次，
 * 不信任排队时校验*。本模块因此每次都用 `now` 重新判定 `expires_at`，
 * 而**不是**读一个「排队时是否有效」的标志位 —— 标志位是排队那一刻的
 * 事实，而「离线前批准、重连后过期」正是要拦的那件事。
 *
 * 同一句话的另一半（**所有代次**）在 LWB-024 里补齐：工作区代次、策略版本、
 * 契约版本、归属连接与修改集自身的有效期，由
 * `@lwb/changes` 的 `revalidateExecutionBindings` 一次算清，本模块在批准
 * 之后调用它。分在另一个模块是因为那一半要读 `workspaces` 与 `connections`，
 * 而本模块只依赖 `approvals` 与 `changesets` —— 让批准门禁去读工作区，
 * 会让「这个函数为什么需要工作区」变成一个要解释的问题。
 *
 * 两处调用的**结论**必须一致：绑定原因的错误码映射只有一份，在本模块里
 * 由 `gateReasonToErrorCode` 转发到 `executionBindingErrorCode`，而不是重写。
 */

import { BridgeError } from '@lwb/contracts';
import type { BridgeErrorCode, ChangeSetState } from '@lwb/contracts';
import {
  EXECUTION_CHANGE_STATES,
  executionBindingErrorCode,
  executionBindingMessage,
  revalidateExecutionBindings,
} from '@lwb/changes';
import type { ExecutionBindingReason } from '@lwb/changes';
import type { ApprovalRecord, ChangeSetRecord, Repositories } from '@lwb/persistence';

import { reloadChangeSet } from './reload.ts';

/**
 * 门禁拒绝的原因。比错误码细：错误码面向调用方，原因面向排障。
 *
 * 后八条直接**复用** `@lwb/changes` 的 `ExecutionBindingReason`，而不是另
 * 起一套近义词。它们是同一件事（这次执行依据的世界变了）在两个模块里的
 * 名字，而两个名字意味着两处映射表 —— 那正是本文件开头说的那个问题。
 */
export type ApplyGateReason =
  | 'CHANGE_NOT_FOUND'
  /** 缺少与摘要绑定的一次性执行授权记录；正常 MCP 路径会先核验 workspace grant 再生成它。 */
  | 'APPROVAL_MISSING'
  | 'APPROVAL_EXPIRED'
  | 'APPROVAL_REVOKED'
  | 'APPROVAL_CONSUMED'
  /** 执行授权记录绑定的摘要与重新加载并重算出的摘要不是同一串。 */
  | 'APPROVAL_DIGEST_MISMATCH'
  /** 落库事实自身不一致：记录不完整、被改动过，或快照读不到。 */
  | 'CHANGE_INTEGRITY'
  | ExecutionBindingReason;

/**
 * 原因 → 错误码。
 *
 * 与 `packages/policy/src/decide.ts` 的 `approvalFailures` 逐条对齐；
 * 改动这里时那里要一起改。写成一个具名函数而不是散在几个 `throw` 里，
 * 是为了让「两处是否一致」成为一个可以被读、被检查的问题。
 *
 * `APPROVAL_REQUIRED` 覆盖三种情形（没有批准、摘要不符、修改集自身不一致）。
 * 这是**刻意的粗粒度**：对调用方而言这三者的下一步动作完全相同 ——
 * 拿到一份与当前内容一致的、新的批准；而区分它们只会告诉调用方
 * 「你差在哪一点上」，那不是它需要知道的。
 */
function gateReasonToErrorCode(reason: ApplyGateReason): BridgeErrorCode {
  switch (reason) {
    case 'APPROVAL_MISSING':
    case 'APPROVAL_DIGEST_MISMATCH':
    case 'CHANGE_INTEGRITY':
      return 'APPROVAL_REQUIRED';
    case 'APPROVAL_EXPIRED':
    case 'APPROVAL_REVOKED':
      return 'APPROVAL_EXPIRED';
    case 'APPROVAL_CONSUMED':
      return 'CHANGE_STATE_INVALID';
    case 'CHANGE_NOT_FOUND':
      return 'CHANGE_NOT_FOUND';
    default:
      // 剩下的全部是执行绑定原因。映射表在 `@lwb/changes` 里只有一份 ——
      // 这里若是再写一遍，两处就会对「代次变了该报什么码」有两个答案。
      return executionBindingErrorCode(reason);
  }
}

/** 面向上层（工具面 / 控制台）的一句拒绝说明。**不含路径与内容。** */
function gateMessage(reason: ApplyGateReason): string {
  switch (reason) {
    case 'CHANGE_NOT_FOUND':
      return '修改集不存在。';
    case 'APPROVAL_MISSING':
      return '缺少与当前摘要匹配的一次性执行授权记录；MCP 写入权限由当前工作区的文件修改 grant 决定。';
    case 'APPROVAL_EXPIRED':
      return '一次性执行授权记录已过期（执行开始前须重新校验有效期）。';
    case 'APPROVAL_REVOKED':
      return '一次性执行授权记录已被撤销。';
    case 'APPROVAL_CONSUMED':
      return '该一次性执行授权记录已被使用；一个修改集只能对应一次写入操作。';
    case 'APPROVAL_DIGEST_MISMATCH':
      return '本次要应用的内容与执行授权记录绑定的摘要不符；已拒绝写入。';
    case 'CHANGE_INTEGRITY':
      return '修改集记录自身不一致，无法确认待写内容；已拒绝执行。';
    default:
      return executionBindingMessage(reason);
  }
}

export type ApplyGateVerdict =
  | {
      readonly kind: 'ready';
      readonly change: ChangeSetRecord;
      /** 即将被消费的那一条批准。调用方**不得**在未认领操作的情况下消费它。 */
      readonly approval: ApprovalRecord;
      /** 由落库事实重算的摘要；与 `approval.digest` 相等。 */
      readonly digest: string;
    }
  | {
      readonly kind: 'refused';
      readonly code: BridgeErrorCode;
      readonly reason: ApplyGateReason;
      readonly message: string;
    };

/**
 * 排队前的入口允许的来源状态。
 *
 * 只有 `APPROVED`：`PENDING_APPROVAL` 意味着尚未记录有效执行授权，而
 * `QUEUED` 及以上意味着**已经**排过一次队了 —— 放它进来会让第二次调用
 * 产生第二个操作，而 `UNIQUE(change_id)` 只会在更晚的一步把它撞掉。
 */
export const APPLY_ENTRY_STATES: readonly ChangeSetState[] = ['APPROVED'];

/**
 * 执行中的复核允许的来源状态（LWB-026 用）。
 *
 * 执行协调器在真正写盘之前再跑一次本门禁，此时修改集已经在 `QUEUED`
 * 或更后面 —— 门禁要复核的是**批准**是否仍然有效，而不是「它有没有排过队」。
 *
 * 这个常量指向 `@lwb/changes` 的 `EXECUTION_CHANGE_STATES`，不另抄一份：
 * 「执行中有哪几个状态」必须只有一个答案，而 LWB-022 的转移表是那个答案
 * 的家 —— 它同时还要证明「终态到不了这几个状态」。
 */
export const EXECUTION_STATES: readonly ChangeSetState[] = EXECUTION_CHANGE_STATES;

export interface ApplyGateInput {
  readonly repos: Repositories;
  readonly change_id: string;
  /**
   * 本次调用允许的来源状态。**必填**，没有默认值：这与
   * `ChangesRepo.transition` 要求显式声明 `from` 是同一条理由 ——
   * 一个默许的来源集合会把「这是哪一次调用」这件事藏起来，
   * 而两处调用的合法来源集合**不同**（见上面两个常量）。
   */
  readonly allowed_from: readonly ChangeSetState[];
  /** 判定时刻（ISO 8601）。省略时取当前时间。 */
  readonly now?: string;
}

/**
 * 本次判定针对**哪一条**批准。
 *
 * 优先取仍然 `ACTIVE` 的那一条；没有 `ACTIVE` 时取最近的一条 —— 因为
 * 「有一份批准但它是 REVOKED / CONSUMED / EXPIRED」与「从来没有批准过」
 * 对操作者是**两句不同的话**：前者要去查谁撤销的、被哪次执行用掉了，
 * 后者要去点批准。把它们都读成 `APPROVAL_MISSING` 会让前一种情形
 * 指向一个错误的下一步动作。
 *
 * 这也是与 `@lwb/policy` 对齐所必需的：策略层的 `approvalFailures` 拿到的
 * 是一个**带状态**的批准视图，它逐状态给出不同的原因，而状态来自调用方。
 * 若本模块只认 `ACTIVE`，两处就会对同一个事实给出不同的原因。
 */
function approvalUnderJudgement(repos: Repositories, changeId: string): ApprovalRecord | null {
  return repos.approvals.findActive(changeId) ?? repos.approvals.listForChange(changeId)[0] ?? null;
}

/**
 * 判定一个修改集此刻能不能被写入。**只读，不消费任何东西。**
 *
 * 顺序即优先级：先确认「有这么一个修改集且它自身自洽」，再看批准，
 * 最后看修改集状态。这个顺序让「没有批准」这个最常见的答案排在
 * 「状态不对」前面 —— 后者通常是更有信息量但更容易误导人的一个。
 *
 * 批准内部的三步顺序（状态 → 摘要 → 有效期）与 `approvalFailures`
 * 的书写顺序一致，因此两处报出的**主因**也一致。
 */
export function evaluateApplyGate(input: ApplyGateInput): ApplyGateVerdict {
  const now = input.now ?? new Date().toISOString();

  let loaded;
  try {
    loaded = reloadChangeSet(input.repos, input.change_id);
  } catch (error) {
    if (error instanceof BridgeError && error.code === 'CHANGE_NOT_FOUND') {
      return refuse('CHANGE_NOT_FOUND');
    }
    // 记录不完整 / 被改动过 / 快照读不到：都无法确认「待写的是什么」。
    // 一律按 CHANGE_INTEGRITY 拒绝，而**不**把底层异常的文本带出去
    // —— 那句话里可能有本机路径（IPC 兜底路径会把它原样送给模型）。
    return refuse('CHANGE_INTEGRITY');
  }

  const approval = approvalUnderJudgement(input.repos, input.change_id);
  if (approval === null) return refuse('APPROVAL_MISSING');

  // 状态在前：`CONSUMED` 与「过期了」的下一步动作不同 —— 前者意味着
  // 再去拿一次批准也不会通过，因为修改集已经不是待批准状态了。
  const state = effectiveApprovalState(approval, now);
  if (state === 'CONSUMED') return refuse('APPROVAL_CONSUMED');
  if (state === 'REVOKED') return refuse('APPROVAL_REVOKED');
  if (state === 'EXPIRED') return refuse('APPROVAL_EXPIRED');

  // 批准绑定的是**重算出来的**摘要，不是 `changesets.digest`。
  // 两者在 reload 里已经比对过相等，因此这里比任意一个都得到同一个结论；
  // 用重算值是为了让「批准绑定的是事实而不是记录」这句话在代码里也成立。
  if (approval.digest !== loaded.digest) return refuse('APPROVAL_DIGEST_MISMATCH');

  // 最后核对「这份批准依据的世界还在不在」（LWB-024 步骤 2）。
  //
  // 工作区与连接在这里**现读**，不由调用方传进来：传进来的话，这个检查就
  // 变成了「调用方说自己没问题就没问题」—— 而它要拦的恰恰是调用方
  // 拿着一次陈旧的读取结果来做决定。多两次主键查换来的是判据不依赖调用方。
  //
  // 顺序上放在批准之后：「没有批准」是这条路径上最常见的答案，
  // 让它排在「世界变了」前面，模型与操作者都会先看到更近的那一步。
  const binding = revalidateExecutionBindings({
    change: loaded.change,
    workspace: input.repos.workspaces.findById(loaded.change.workspace_id),
    connection: input.repos.connections.findById(loaded.change.owner_connection_id),
    now,
    allowed_from: input.allowed_from,
  });
  if (!binding.ok) return refuse(binding.primary ?? 'CHANGE_STATE_INVALID');

  return { kind: 'ready', change: loaded.change, approval, digest: loaded.digest };
}

/**
 * 批准记录的**有效状态**：把「状态是 ACTIVE 但已到期」投影成 `EXPIRED`。
 *
 * 为什么不在读取时顺手把过期的写成 `EXPIRED`（`ApprovalsRepo.expireDue`）：
 * 那是一次写。把它放在只读路径上，就等于让一个只读接口产生状态变更 ——
 * 而「只读接口为什么要一次性 nonce」这个问题从此没有答案。
 * 写入方（执行协调器、清理任务）仍然调用 `expireDue`，两条路径的
 * **结论**由本函数保证一致。
 */
export function effectiveApprovalState(
  approval: ApprovalRecord,
  now: string,
): ApprovalRecord['state'] {
  if (approval.state === 'ACTIVE' && approval.expires_at <= now) return 'EXPIRED';
  return approval.state;
}

function refuse(reason: ApplyGateReason): Extract<ApplyGateVerdict, { kind: 'refused' }> {
  return { kind: 'refused', code: gateReasonToErrorCode(reason), reason, message: gateMessage(reason) };
}

/** 把一次拒绝变成 `BridgeError`，供控制层与工具层原样上抛。 */
export function gateRefusalToError(verdict: Extract<ApplyGateVerdict, { kind: 'refused' }>): BridgeError {
  return new BridgeError(verdict.code, verdict.message, { reason: verdict.reason });
}
