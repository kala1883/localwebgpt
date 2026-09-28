/**
 * LWB 错误契约（方案 §6.6）。
 *
 * 两件事必须分开：
 *  - category：协议层无效请求（protocol）与业务错误（business）不同对待。
 *  - autoRetry：哪些错误允许自动重试，哪些绝不允许“换个路径绕过”。
 *
 * 错误码集合是冻结契约的一部分：模型侧据此决定下一步，daemon 侧据此决定是否
 * 停写、是否允许重试。新增错误码必须同时更新本表与测试。
 */

export type ErrorCategory = 'protocol' | 'business';

/**
 * 自动重试策略。`never` 是最重要的默认值：绝大多数错误都不能靠重试或换路径解决。
 *
 * - never        不重试，也不允许用替代路径/弱校验绕过
 * - bounded      有界重试（例如文件被占用），仍然受批准有效期约束
 * - refetch      必须重新读取/重新授权后再创建新提议
 * - await_human  等待本地操作者动作，模型不能自行推进
 * - reduce_scope 缩小范围或使用游标，属于有界部分结果
 * - stop_write   停止写入并保留现场
 */
export type AutoRetryPolicy =
  | 'never'
  | 'bounded'
  | 'refetch'
  | 'await_human'
  | 'reduce_scope'
  | 'stop_write';

export interface BridgeErrorSpec {
  readonly code: string;
  readonly category: ErrorCategory;
  readonly autoRetry: AutoRetryPolicy;
  /** 是否可以直接呈现给模型的稳定中文说明（不含本机路径/秘密）。 */
  readonly summary: string;
}

export const BRIDGE_ERRORS = {
  // ---- 授权与策略 ----
  WORKSPACE_NOT_GRANTED: {
    code: 'WORKSPACE_NOT_GRANTED',
    category: 'business',
    autoRetry: 'never',
    summary: '当前连接未获准访问该工作区。',
  },
  POLICY_DENIED: {
    code: 'POLICY_DENIED',
    category: 'business',
    autoRetry: 'never',
    summary: '本地策略拒绝该操作；不能用其他路径绕过。',
  },
  SECRET_DETECTED: {
    code: 'SECRET_DETECTED',
    category: 'business',
    autoRetry: 'never',
    summary:
      '内容被判定为高置信度凭证，已整块阻断；不接受「换个路径/换个范围再试一次」，' +
      '也不表示该内容不存在于其他位置。',
  },
  WORKSPACE_GENERATION_CHANGED: {
    code: 'WORKSPACE_GENERATION_CHANGED',
    category: 'business',
    autoRetry: 'refetch',
    summary: '工作区根或策略已改变，旧票据与批准失效，需重新读取。',
  },
  CONNECTION_DISABLED: {
    code: 'CONNECTION_DISABLED',
    category: 'business',
    autoRetry: 'never',
    summary: '连接已被本地操作者停用。',
  },
  PAUSED: {
    code: 'PAUSED',
    category: 'business',
    autoRetry: 'never',
    summary: '本地服务处于暂停状态，已阻断新读取与新应用。',
  },

  // ---- 路径与文件形态 ----
  PATH_UNSAFE: {
    code: 'PATH_UNSAFE',
    category: 'business',
    autoRetry: 'never',
    summary: '路径语法或实际文件身份不安全，已拒绝；不会降级为弱校验。',
  },
  LINK_UNSUPPORTED: {
    code: 'LINK_UNSUPPORTED',
    category: 'business',
    autoRetry: 'never',
    summary: '目标涉及符号链接、Junction 或硬链接，V1 保守拒绝。',
  },
  ENCODING_UNSUPPORTED: {
    code: 'ENCODING_UNSUPPORTED',
    category: 'business',
    autoRetry: 'never',
    summary: '文件编码不是 V1 可编辑范围；不会自动转码覆盖。',
  },
  BINARY_UNSUPPORTED: {
    code: 'BINARY_UNSUPPORTED',
    category: 'business',
    autoRetry: 'never',
    summary: '文件被识别为二进制，不在 V1 可编辑范围。',
  },
  GIT_LAYOUT_UNSUPPORTED: {
    code: 'GIT_LAYOUT_UNSUPPORTED',
    category: 'business',
    autoRetry: 'never',
    summary: '该 Git 布局（外置 gitdir/alternates/未支持格式）不受支持；普通文件能力仍可用。',
  },

  // ---- 版本与一致性 ----
  FILE_VERSION_CONFLICT: {
    code: 'FILE_VERSION_CONFLICT',
    category: 'business',
    autoRetry: 'refetch',
    summary: '文件在读取后发生变化，本次修改未应用；需重新读取并创建新提议。',
  },
  READ_TOKEN_STALE: {
    code: 'READ_TOKEN_STALE',
    category: 'business',
    autoRetry: 'refetch',
    summary: '读取票据已失效（过期、跨工作区或版本不符）。',
  },
  FILE_BUSY: {
    code: 'FILE_BUSY',
    category: 'business',
    autoRetry: 'bounded',
    summary: '无法取得所需句柄（被占用或共享冲突）。',
  },
  WORKSPACE_BUSY: {
    code: 'WORKSPACE_BUSY',
    category: 'business',
    autoRetry: 'bounded',
    summary: '该工作区已有写操作在队列或执行中。',
  },
  CONCURRENCY_LIMIT_EXCEEDED: {
    code: 'CONCURRENCY_LIMIT_EXCEEDED',
    category: 'business',
    autoRetry: 'bounded',
    summary:
      '并发额度已满，等待到时限后仍无法取得位置；**本次调用未执行**，' +
      '没有读取任何文件、也没有产生任何副作用，稍后重试即可。',
  },

  // ---- 审批与执行 ----
  APPROVAL_REQUIRED: {
    code: 'APPROVAL_REQUIRED',
    category: 'business',
    autoRetry: 'await_human',
    summary: '缺少与当前内容绑定的有效执行授权记录。',
  },
  APPROVAL_EXPIRED: {
    code: 'APPROVAL_EXPIRED',
    category: 'business',
    autoRetry: 'await_human',
    summary: '执行授权记录已过期或被撤销。',
  },
  CHANGE_NOT_FOUND: {
    code: 'CHANGE_NOT_FOUND',
    category: 'business',
    autoRetry: 'never',
    summary: '修改集不存在，或不属于当前连接/工作区。',
  },
  CHANGE_STATE_INVALID: {
    code: 'CHANGE_STATE_INVALID',
    category: 'business',
    autoRetry: 'never',
    summary: '修改集当前状态不允许该操作。',
  },
  IDEMPOTENCY_CONFLICT: {
    code: 'IDEMPOTENCY_CONFLICT',
    category: 'business',
    autoRetry: 'never',
    summary: '同一幂等键携带了不同请求内容；不能覆盖旧记录。',
  },
  RECOVERY_REQUIRED: {
    code: 'RECOVERY_REQUIRED',
    category: 'business',
    autoRetry: 'stop_write',
    summary: '实际状态需要协调；禁止再次应用，须先查询与本地恢复。',
  },

  // ---- 限额与部分结果 ----
  RESULT_TRUNCATED: {
    code: 'RESULT_TRUNCATED',
    category: 'business',
    autoRetry: 'reduce_scope',
    summary: '结果被有界截断；请使用游标或缩小范围。',
  },
  SEARCH_BUDGET_EXCEEDED: {
    code: 'SEARCH_BUDGET_EXCEEDED',
    category: 'business',
    autoRetry: 'reduce_scope',
    summary: '搜索超出时间/字节预算，返回的是有界部分结果。',
  },
  EGRESS_BUDGET_EXCEEDED: {
    code: 'EGRESS_BUDGET_EXCEEDED',
    category: 'business',
    autoRetry: 'never',
    summary: '该连接的出站内容预算已用尽，需本地操作者调整。',
  },
  SIZE_LIMIT_EXCEEDED: {
    code: 'SIZE_LIMIT_EXCEEDED',
    category: 'business',
    autoRetry: 'never',
    summary: '对象超出 V1 限额。',
  },

  // ---- 存储与原生层 ----
  STORAGE_UNAVAILABLE: {
    code: 'STORAGE_UNAVAILABLE',
    category: 'business',
    autoRetry: 'stop_write',
    summary: '状态库、快照或磁盘空间故障；已停止写入并保留现场。',
  },
  NATIVE_GUARD_UNAVAILABLE: {
    code: 'NATIVE_GUARD_UNAVAILABLE',
    category: 'business',
    autoRetry: 'never',
    summary: '原生句柄保护不可用或验证未通过；已关闭直写，只保留读取与提议。',
  },
  EXECUTOR_BUSY: {
    code: 'EXECUTOR_BUSY',
    category: 'business',
    autoRetry: 'bounded',
    summary: '写执行器仍在执行上一个操作。',
  },

  // ---- 本地服务可达性（LWB-017 新增） ----
  //
  // 这一条是适配器**不能**从 daemon 拿到回答时自己合成的：管道不存在、
  // 握手失败、或请求超时。没有它时只能借用 `INTERNAL_ERROR`，
  // 而那条的说明是「本地服务内部错误」—— 会把「服务没在跑」说成「服务有 bug」，
  // 排查方向完全相反。
  //
  // `autoRetry: 'never'` 是刻意的，尽管读取类操作重试是安全的：
  // `never` 在契约里的含义包含「不允许用替代路径/弱校验绕过」，
  // 而服务不可达时**最该避免的**正是「换个办法拿数据」。
  // 模型可以自己重试（结果里的 outcome_unknown 会如实说明这一点），
  // 但系统不会替它自动推进。
  SERVICE_UNAVAILABLE: {
    code: 'SERVICE_UNAVAILABLE',
    category: 'business',
    autoRetry: 'never',
    summary:
      '本地桥接服务不可达或未在时限内回应；**本次调用是否已执行未知**，' +
      '不得据此判断成功或失败。请确认本地 daemon 正在运行后重新调用。',
  },

  // ---- 协议层 ----
  INVALID_ARGUMENT: {
    code: 'INVALID_ARGUMENT',
    category: 'protocol',
    autoRetry: 'never',
    summary: '请求参数不合法（未知字段、无效枚举、越界数值等）。',
  },
  NOT_AUTHORIZED: {
    code: 'NOT_AUTHORIZED',
    category: 'protocol',
    autoRetry: 'never',
    summary: '本地 IPC 凭据无效或 audience 不匹配。',
  },
  UNSUPPORTED_OPERATION: {
    code: 'UNSUPPORTED_OPERATION',
    category: 'protocol',
    autoRetry: 'never',
    summary: '该操作不在 V1 范围内（例如目录创建、重命名、删除、任意 Shell）。',
  },
  NOT_FOUND: {
    code: 'NOT_FOUND',
    category: 'business',
    autoRetry: 'never',
    summary: '目标不存在。',
  },
  INTERNAL_ERROR: {
    code: 'INTERNAL_ERROR',
    category: 'business',
    autoRetry: 'never',
    summary: '本地服务内部错误；未执行任何未报告的工作区写入。',
  },
} as const satisfies Record<string, BridgeErrorSpec>;

export type BridgeErrorCode = keyof typeof BRIDGE_ERRORS;

export const BRIDGE_ERROR_CODES = Object.keys(BRIDGE_ERRORS) as BridgeErrorCode[];

export function isBridgeErrorCode(value: unknown): value is BridgeErrorCode {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(BRIDGE_ERRORS, value);
}

/**
 * 模型可见的错误载荷。
 *
 * 约束：`message` 绝不能再装回本机绝对路径、凭证或源码正文。
 * 详细诊断只写本地审计，不进入工具结果。
 */
export interface BridgeErrorPayload {
  readonly code: BridgeErrorCode;
  readonly message: string;
  readonly category: ErrorCategory;
  readonly auto_retry: AutoRetryPolicy;
  /** 可选的安全补充字段（例如冲突时的期望/实际哈希）。 */
  readonly details?: Readonly<Record<string, string | number | boolean | null>>;
}

export class BridgeError extends Error {
  readonly code: BridgeErrorCode;
  readonly details: Readonly<Record<string, string | number | boolean | null>> | undefined;

  constructor(
    code: BridgeErrorCode,
    message?: string,
    details?: Readonly<Record<string, string | number | boolean | null>>,
  ) {
    const spec = BRIDGE_ERRORS[code];
    super(message ?? spec.summary);
    this.name = 'BridgeError';
    this.code = code;
    this.details = details;
  }

  get spec(): BridgeErrorSpec {
    return BRIDGE_ERRORS[this.code];
  }

  toPayload(): BridgeErrorPayload {
    const spec = this.spec;
    const payload: BridgeErrorPayload = {
      code: this.code,
      message: this.message || spec.summary,
      category: spec.category,
      auto_retry: spec.autoRetry,
      ...(this.details ? { details: this.details } : {}),
    };
    return payload;
  }
}

export function isBridgeError(value: unknown): value is BridgeError {
  return value instanceof BridgeError;
}
