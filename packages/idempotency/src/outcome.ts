/**
 * 「这次写入到底成了没有」——七种答案，**未知单独占两种**（LWB-022 步骤 4）。
 *
 * ## 这一段在防什么
 *
 * 一个写入流程能给出的答案不是两个（成功 / 失败），是三个：成功、失败、
 * **不知道**。把第三种并进前两种是本工程里代价最高的一类错误：
 *
 *  - 并进「成功」→ 用户以为文件已经改了，而实际上可能一个字节都没动。
 *    方案 §8.1 因此写着「APPLIED 必须具有核验后的回执」。
 *  - 并进「失败」→ 调用方会**重发同一次写任务**。而「不知道」的常见来源
 *    正是「写了一半然后进程死了」—— 此时重发会把一个已经改过的文件
 *    再改一次，或者在 `create_text` 上撞上「文件已存在」。
 *
 * 因此本模块的存在理由只有一句：**未知必须能被说出来**，
 * 而且说出来之后，下一步动作是「用 `operation_id` 查询」而不是「再发一次」。
 * 这与迁移 v1 把 `UNKNOWN` 放进逐文件结果状态的枚举里是同一件事，
 * 只是那一步落在数据库约束上，这一步落在「怎么对外说」上。
 *
 * ## 为什么由**逐文件结果**来升级结论
 *
 * 操作自己的状态是**它自己**的结论；逐文件结果是**每个文件**的结论。
 * 两者可以不一致，而不一致时必须是更保守的那个赢：一个状态为 `APPLIED`
 * 但某个文件是 `UNKNOWN` 的操作，对外只能说「需要恢复」——
 * 因为「操作说成功了」只是一句话，而「这个文件现在是什么」是一个事实。
 *
 * ## 它**不做**什么
 *
 *  - 不改任何状态。恢复（把 `RECOVERY_REQUIRED` 协调成 `APPLIED` 或
 *    `ROLLED_BACK`）是本地人工与 LWB-026 的执行器的事，且必须经过核验。
 *  - 不重试。本模块没有重试路径 —— 这正是它存在的意义。
 */

import type { OperationRecord } from '@lwb/persistence';

export type OperationOutcomeKind =
  /** 还没有结论（排队中 / 校验中 / 写入中）。 */
  | 'IN_PROGRESS'
  /** 已应用**并通过核验**。唯一可以说「已保存」的一种。 */
  | 'APPLIED'
  /** 失败，且确认没有改动任何文件。 */
  | 'FAILED_NO_CHANGE'
  /** 写入前发现冲突并退出，没有改动任何文件。 */
  | 'CONFLICT'
  /** 已回滚。 */
  | 'ROLLED_BACK'
  /** 实际状态需要协调：可能是「写了一半」，也可能是逐文件里有点「不知道」。 */
  | 'NEEDS_RECOVERY'
  /** 连操作记录都不足以判定。 */
  | 'UNKNOWN';

/**
 * 这次写入相对**操作之前**对用户文件做了什么。
 *
 * 三值而不是布尔：`false` 会被读成「没改」，而「不知道改没改」必须能被
 * 单独表达 —— 它要求完全不同的下一步动作。
 */
export type FileEffect = 'unchanged' | 'changed' | 'unknown';

export interface OperationOutcomePolicy {
  /** 可以对外宣称「已经保存」吗。只有 `APPLIED` 为真（方案 §8.1）。 */
  readonly saved: boolean;
  readonly file_effect: FileEffect;
  /** 只能靠 `operation_id` 查询来推进，**不得**重发同一写任务。 */
  readonly must_query_by_operation_id: boolean;
  readonly message: string;
}

/**
 * 每种答案的对外语义。
 *
 * `Record` 的键是七种答案的全集：少写一种即为编译错误，
 * 因此「有没有哪种答案忘了定策略」不需要靠人眼过。
 */
export const OUTCOME_POLICY: Readonly<Record<OperationOutcomeKind, OperationOutcomePolicy>> = {
  IN_PROGRESS: {
    saved: false,
    file_effect: 'unknown',
    must_query_by_operation_id: true,
    message: '本次写入尚无结论；请用 operation_id 查询，不要重发同一写任务。',
  },
  APPLIED: {
    saved: true,
    file_effect: 'changed',
    must_query_by_operation_id: false,
    message: '已写入并通过逐文件核验。',
  },
  FAILED_NO_CHANGE: {
    saved: false,
    file_effect: 'unchanged',
    must_query_by_operation_id: false,
    message: '写入失败；已确认本次没有改动任何用户文件。',
  },
  CONFLICT: {
    saved: false,
    file_effect: 'unchanged',
    must_query_by_operation_id: false,
    message: '写入前发现冲突并已退出；没有改动任何用户文件。',
  },
  ROLLED_BACK: {
    saved: false,
    file_effect: 'unchanged',
    must_query_by_operation_id: false,
    message: '已回滚到本次写入之前的状态。',
  },
  NEEDS_RECOVERY: {
    saved: false,
    file_effect: 'unknown',
    must_query_by_operation_id: true,
    message: '实际状态不明（可能写了一半）；禁止重发同一写任务，请用 operation_id 查询并等待本地恢复。',
  },
  UNKNOWN: {
    saved: false,
    file_effect: 'unknown',
    must_query_by_operation_id: true,
    message: '现有记录不足以判定本次写入的结果；请用 operation_id 查询。',
  },
};

/**
 * 一个操作只有在**每一个文件都有核验回执**时才算 `APPLIED`。
 *
 * `RECOVERED_TARGET` 也算回执：那是在恢复流程里核验到「目标状态已经在盘上，
 * 只是当初没来得及记账」，与 `VERIFIED` 是同一个事实的两种到达方式。
 * `RECOVERED_ORIGINAL` **不算** —— 它说的是「文件是写入前的样子」，
 * 与「已应用」直接矛盾。
 */
const APPLIED_RECEIPT_STATES: readonly string[] = ['VERIFIED', 'RECOVERED_TARGET'];

/** 逐文件结果里**最少**需要的字段。仓储层的 `itemResults` 满足它。 */
export interface ItemResultLike {
  readonly item_id: string;
  readonly state: string;
}

export interface OperationOutcome {
  readonly kind: OperationOutcomeKind;
  readonly saved: boolean;
  readonly file_effect: FileEffect;
  readonly must_query_by_operation_id: boolean;
  readonly message: string;
  /** 逐文件里状态为 `UNKNOWN` 的那些。它们是把结论升级为「需要恢复」的原因。 */
  readonly unknown_items: readonly string[];
  readonly verified_items: number;
  readonly operation_id: string | null;
  readonly change_id: string | null;
}

/**
 * 判定一次写入的结论。
 *
 * 顺序即优先级：**逐文件的「不知道」压过操作自己的说法**，
 * 然后才是操作状态。这与 `evaluateApplyGate` 的写法一致
 * （先事实、后结论），理由也一致：事实比结论更值得信。
 */
export function classifyOperation(input: {
  readonly operation: OperationRecord | null;
  readonly items: readonly ItemResultLike[];
}): OperationOutcome {
  const { operation, items } = input;
  const unknownItems = items.filter((item) => item.state === 'UNKNOWN').map((item) => item.item_id);
  const verifiedItems = items.filter((item) => APPLIED_RECEIPT_STATES.includes(item.state)).length;

  const build = (kind: OperationOutcomeKind): OperationOutcome => {
    const policy = OUTCOME_POLICY[kind];
    return {
      kind,
      saved: policy.saved,
      file_effect: policy.file_effect,
      must_query_by_operation_id: policy.must_query_by_operation_id,
      message: policy.message,
      unknown_items: unknownItems,
      verified_items: verifiedItems,
      operation_id: operation?.id ?? null,
      change_id: operation?.change_id ?? null,
    };
  };

  if (operation === null) return build('UNKNOWN');

  // 逐文件里有一个「不知道」就足以推翻操作自己的结论 —— 包括 `APPLIED`。
  if (unknownItems.length > 0) return build('NEEDS_RECOVERY');

  switch (operation.state) {
    case 'QUEUED':
    case 'VALIDATING':
    case 'APPLYING':
      return build('IN_PROGRESS');
    case 'RECOVERY_REQUIRED':
      return build('NEEDS_RECOVERY');
    case 'FAILED_NO_CHANGE':
      return build('FAILED_NO_CHANGE');
    case 'CONFLICT':
      return build('CONFLICT');
    case 'ROLLED_BACK':
      return build('ROLLED_BACK');
    case 'APPLIED': {
      // 「操作说成功」不等于「每个文件都核验过」。没有回执的 APPLIED
      // 是**没有证据的成功**，而方案 §8.1 要求 APPLIED 必须带核验回执 ——
      // 因此这里把它降级为需要恢复，而不是照单全收。
      if (items.length === 0) return build('UNKNOWN');
      if (verifiedItems !== items.length) return build('NEEDS_RECOVERY');
      return build('APPLIED');
    }
    default: {
      // 修改集状态里那些本次写入到不了的状态（PENDING_APPROVAL 等）。
      // 走到这里说明有一行数据不属于操作状态集合，那是记录损坏。
      return build('UNKNOWN');
    }
  }
}
