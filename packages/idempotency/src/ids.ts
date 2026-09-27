/**
 * 四个标识符，四种互不通用的用途（LWB-022 步骤 2）。
 *
 * ## 为什么要分成四个类型，而不是「都是 string」
 *
 * 这四个值在实现里长得一模一样（都是字符串），因此任何一个都能被传进
 * 另一个的位置而不被编译器发现。而它们答的是四个不同的问题：
 *
 * | 标识符 | 由谁产生 | 活着多久 | 它**不是** |
 * | --- | --- | --- | --- |
 * | `request_id` | 已鉴权的 IPC 通道，每次调用一个 | 一次调用 | 不是幂等键。重试会换一个，而幂等键**必须**相同 |
 * | `IdempotencyKey` | 调用方（模型） | 同一逻辑请求的整个重试期 | 不是凭证，不参与任何授权判定 |
 * | `ChangeId` | daemon | 到墓碑为止（永久） | 不是「一个写任务的编号」——它是**内容**的编号 |
 * | `OperationId` | daemon | 到墓碑为止（永久） | 不是幂等键。一个 change_id 只有一个，与键无关 |
 *
 * 把它们混起来的具体后果是真实存在的，而不是风格问题：
 *
 *  - 拿 `request_id` 当幂等键 → 每次重试都换 id，于是「重试」变成
 *    「又来了一次新请求」，同一份内容被建立两次。而 `request_id`
 *    是**服务端**发的，调用方根本无法在重试时复现它。
 *  - 拿 `OperationId` 当幂等键 → 操作是在批准之后才诞生的，
 *    用它当键等于把「幂等」推迟到批准之后 —— 而 prepare 阶段的
 *    幂等（同一请求得同一修改集）正是要在此之前生效的。
 *  - 拿 `IdempotencyKey` 当 `ChangeId` → 一个键对应了 `change_*` 的两条路径
 *    （prepare 与 apply），两条路径的键空间不同域，撞键会把
 *    「同一个修改集的第二次应用」误读成「同一份内容的第二次提议」。
 *
 * 类型系统能挡住这些，只要这四个类型**不互相赋值**。品牌（brand）做的就是
 * 这件事：`Branded<string, 'ChangeId'>` 在运行期就是一个字符串，
 * 在编译期与 `string` 及另外三个品牌都不兼容。
 *
 * ## 边界在解析函数上
 *
 * 未受信的输入（工具参数、HTTP 请求体）进来说明它只是一个 `string`。
 * 把 `string` 变成品牌类型的唯一入口是本文件的四个 `as*` 函数，
 * 它们同时做长度与字符检查。因此「模型能给 daemon 一个多长的键」
 * 这类问题只有一处答案。
 */

import { BridgeError, LIMITS } from '@lwb/contracts';

/** 品牌的载体。运行期不存在（`declare`），只在类型上起作用。 */
export declare const IDENTIFIER_BRAND: unique symbol;

type Branded<B extends string> = string & { readonly [IDENTIFIER_BRAND]: B };

/**
 * **一次调用**的编号。由已鉴权的通道给出（`RequestContext.request_id`），
 * 服务端生成，因此调用方在重试时**不可能**复现它 —— 这正是它不能当幂等键的原因。
 */
export type RequestId = Branded<'RequestId'>;

/**
 * 调用方生成的**业务幂等键**。
 *
 * 它不是凭证：`packages/contracts/src/tools.ts` 的 schema 里它只是一个
 * `min(8).max(200)` 的字符串，任何判定都不读它（ADR-003 §4）。
 * 它唯一的作用是让「同一次调用重试」与「又一次新调用」在状态库里可区分。
 */
export type IdempotencyKey = Branded<'IdempotencyKey'>;

/**
 * 修改集的编号。它标识的是一**份内容**，不是一次执行 ——
 * 因此同一份内容永远只有一个 `ChangeId`，而它最多被执行一次。
 */
export type ChangeId = Branded<'ChangeId'>;

/**
 * 写入操作的编号。一个 `ChangeId` 最多对应一个，与用了几个幂等键无关
 * （方案 §7，`UNIQUE(change_id)`）。**结果查询只认它**（验收标准 3）。
 */
export type OperationId = Branded<'OperationId'>;

/**
 * 标识符的通用形状检查。
 *
 * 三条都是**形状**检查，不是安全措施：
 *
 *  - 非空：空串在所有 `WHERE x = ?` 里都能匹配到一个「没填」的行。
 *  - 无控制字符：换行与 NUL 会让一个标识符在日志、审计与
 *    `\u0000` 拼接的锁键里变成两个字段（`prepare` 的锁键就是三段拼接）。
 *  - 长度上限：见 `LIMITS.MAX_IDEMPOTENCY_KEY_CHARS` 的理由 —— 它会被存进
 *    状态库，并出现在审计与冲突回报里。
 */
function requireIdentifier(value: unknown, field: string, maxChars: number): string {
  // 「不是字符串」与「是空串」分成两句，各自带 `reason`：这两件事的排障方向
  // 完全不同（一个是调用方传错了类型，一个是传了一个空值），而合成一句
  // 会让回报里只剩「参数不对」。本工程的要求是每条拒绝都说清是哪一种。
  if (typeof value !== 'string') {
    throw new BridgeError('INVALID_ARGUMENT', `字段 ${field} 必须是字符串。`, {
      reason: 'IDENTIFIER_NOT_A_STRING',
    });
  }
  if (value.length === 0) {
    throw new BridgeError('INVALID_ARGUMENT', `字段 ${field} 必须是非空字符串。`, {
      reason: 'IDENTIFIER_EMPTY',
    });
  }
  if (value.length > maxChars) {
    throw new BridgeError('INVALID_ARGUMENT', `字段 ${field} 超过 ${maxChars} 字符上限。`, {
      reason: 'IDENTIFIER_TOO_LONG',
      limit: maxChars,
    });
  }
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new BridgeError('INVALID_ARGUMENT', `字段 ${field} 含控制字符或换行。`, {
      reason: 'IDENTIFIER_CONTROL_CHARS',
    });
  }
  return value;
}

/** 幂等键的**专用**解析：长度范围取自 `LIMITS`，与工具 schema 同源。 */
export function asIdempotencyKey(value: unknown, field = 'idempotency_key'): IdempotencyKey {
  const text = requireIdentifier(value, field, LIMITS.MAX_IDEMPOTENCY_KEY_CHARS);
  if (text.length < LIMITS.MIN_IDEMPOTENCY_KEY_CHARS) {
    // 下限是一道排版提示，不是安全措施（见 LIMITS 的注释）。它在这里
    // 也要检查，因为工具 schema 只挡得住走工具面的调用 —— 控制台与
    // 将来的执行器都直接调本层。
    throw new BridgeError(
      'INVALID_ARGUMENT',
      `字段 ${field} 至少 ${LIMITS.MIN_IDEMPOTENCY_KEY_CHARS} 个字符。`,
      { reason: 'IDEMPOTENCY_KEY_TOO_SHORT', limit: LIMITS.MIN_IDEMPOTENCY_KEY_CHARS },
    );
  }
  return text as IdempotencyKey;
}

export function asChangeId(value: unknown, field = 'change_id'): ChangeId {
  return requireIdentifier(value, field, 200) as ChangeId;
}

export function asOperationId(value: unknown, field = 'operation_id'): OperationId {
  return requireIdentifier(value, field, 200) as OperationId;
}

/**
 * `request_id` 的解析。
 *
 * 它**只**用于把审计行与产生它的那次调用对上（LWB-021 的 `recordDecision`）。
 * 本文件把它也做成品牌类型，不是为了在边界上检查它（它的来源是已鉴权的
 * 通道，不是入参），而是为了让它与另外三个一样**传不错地方**。
 */
export function asRequestId(value: unknown, field = 'request_id'): RequestId {
  return requireIdentifier(value, field, 200) as RequestId;
}

/** 供审计与排障：把一个标识符按「它答的是哪个问题」说出来。 */
export const IDENTIFIER_ROLES: Readonly<Record<string, string>> = Object.freeze({
  request_id: '一次调用的编号（服务端产生，重试不复现）',
  idempotency_key: '调用方生成的业务幂等键（重试必须相同）',
  change_id: '一份内容的编号（同一内容只有一个）',
  operation_id: '一次写入的编号（一个修改集最多一个）',
});
