/**
 * V1 初始限额（方案 §9.3）。
 *
 * 这些是**产品设计初值**，不是平台限制，也不是已测得的性能结论。
 * 关键约束：
 *  - 模型不能通过参数扩大任何限额；只有本地操作者可以调整。
 *  - 限额检查必须在产生副作用之前与返回给模型之前各执行一次。
 */

const KIB = 1024;
const MIB = 1024 * 1024;
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const LIMITS = {
  /** 可编辑文本文件原始大小上限。超过则只读或拒绝编辑。 */
  MAX_EDITABLE_FILE_BYTES: 2 * MIB,
  /** 单次工具返回正文的字节上限。 */
  MAX_RESPONSE_BODY_BYTES: 64 * KIB,
  /** 单次读取最多返回的行数（同时受字节上限约束）。 */
  MAX_READ_LINES: 400,
  /**
   * 单次读取允许载入内存的最大文件字节数（LWB-013）。
   *
   * 这个上限保护的是 **daemon 的可用内存**，不是「模型能看到多少」：
   * 受控句柄当前只提供整文件读取（没有区间读），因此分页读取也必须先把
   * 整个文件读进来。没有这一条，一次 `file_read` 就能让 daemon 因 OOM 退出，
   * 而 daemon 退出期间用户的所有工作区操作都不可用。
   *
   * 取值高于 `MAX_EDITABLE_FILE_BYTES`（可编辑上限）与 `MAX_CHANGE_TOTAL_BYTES`，
   * 因为「读一个两兆以上的日志文件的前 400 行」是一个合理请求。
   */
  MAX_READABLE_FILE_BYTES: 16 * MIB,
  /**
   * 读取票据与分页游标的有效期（LWB-013）。
   *
   * 为什么可以短：票据只证明「读到的是什么」，而真正落地写入还要过
   * `base_sha256` 基线与本地批准两道。有效期短的代价只是「再读一次」
   * （一次读取的成本）；有效期长的代价是「一份更早的观察被当成本次操作的依据」。
   */
  READ_TOKEN_TTL_MS: 1 * HOUR,
  /** 目录分页最多返回条目数。 */
  MAX_DIRECTORY_ENTRIES: 200,
  /** 搜索分页最多返回匹配数。 */
  MAX_SEARCH_MATCHES: 100,
  /**
   * 字面量查询串的字符上限（LWB-015）。
   *
   * 上限的**唯一**理由不是安全，是「这一段文本会被复述回模型」：查询串出现在
   * 结果里、出现在游标的摘要里、可能出现在日志里。没有上限的话，一个
   * 一兆字节的查询串会让一次搜索在还没碰磁盘之前就产生一兆字节的往返。
   *
   * 放在这里而不是在 `packages/search` 里另立一个常量：工具 schema
   * （`packages/contracts/src/tools.ts`）与本层必须给出**同一个**上限，
   * 两处各写一个数字迟早在某一处被改动。
   */
  MAX_SEARCH_QUERY_CHARS: 1024,
  /**
   * 幂等键的长度范围（LWB-022）。
   *
   * 与 `MAX_SEARCH_QUERY_CHARS` 同一条理由：工具 schema
   * （`packages/contracts/src/tools.ts` 的 `idempotencyKey`）与
   * `@lwb/idempotency` 的解析必须给出**同一组**数字。
   *
   * 下限 8 不是安全措施，是**排版上的一道提示**：一个 `"1"` 这样的键
   * 几乎一定来自「顺手填一个」，而它一旦被复用，冲突会出现在下一次
   * 内容不同的请求上 —— 那时调用方看到的是 IDEMPOTENCY_CONFLICT，
   * 而根因在很久以前。上限 200 是因为这个值会被存进状态库、
   * 并出现在审计与错误详情里：没有上限的话，一个兆字节的键会让每次
   * 冲突回报都带上兆字节。
   */
  MIN_IDEMPOTENCY_KEY_CHARS: 8,
  MAX_IDEMPOTENCY_KEY_CHARS: 200,
  /** 单次搜索时间预算。 */
  SEARCH_TIME_BUDGET_MS: 3 * SECOND,
  /** 单次搜索最多扫描的字节数（防止超大仓库无界扫描）。 */
  MAX_SEARCH_SCANNED_BYTES: 64 * MIB,
  /** MCP 单请求 JSON 字节上限（含编码膨胀）。 */
  MAX_REQUEST_JSON_BYTES: 1 * MIB,
  /** 单个修改集最多包含的文件数。 */
  MAX_CHANGE_FILES: 20,
  /**
   * 单个文件在一个修改项里最多包含的编辑区间数（LWB-019）。
   *
   * 与 `MAX_CHANGE_FILES` 同规矩：**工具 schema 与本层必须给出同一个数字**，
   * 因此它只在这里写一次，`tools.ts` 的 `lineEdit` 数组上限与
   * `@lwb/changes` 的契约校验都从这里取。
   */
  MAX_EDITS_PER_FILE: 500,
  /** 单个修改集最终文件字节总量上限。 */
  MAX_CHANGE_TOTAL_BYTES: 8 * MIB,
  /** 修改集有效期。 */
  CHANGE_TTL_MS: 24 * HOUR,
  /** 本地批准有效期；执行开始时必须再次校验。 */
  APPROVAL_TTL_MS: 10 * MINUTE,
  /** 全局并发读取数。 */
  MAX_CONCURRENT_READS: 4,
  /**
   * 单连接并发读取数（LWB-018）。
   *
   * 比全局值更小是刻意的：全局值保护**本机**（内存、磁盘、护栏助手只有一个），
   * 这个值保护**一条连接不要占满全局额度**。单用户本机上它不会是瓶颈，
   * 但它是「一条连接不能饿死其他连接」这条性质在限额层的表述 ——
   * 而这条性质在将来多连接（例如控制台自己也读）时才会真正生效。
   */
  MAX_CONCURRENT_READS_PER_CONNECTION: 2,
  /**
   * 并发已满时，一次调用最多等待多久才被拒绝（LWB-018）。
   *
   * 为什么不是「立即拒绝」：模型侧经常一次发多条并行调用（读几个文件、
   * 列一个目录），而限额是 4 —— 立即拒绝会把一个正常的并行请求
   * 变成一条看起来像故障的错误。为什么不是「无限等待」：等待会把
   * 并发上限悄悄变成一个队列，调用方再也观察不到「本机忙」这件事，
   * 而超时里的结果就是**未执行**（不是部分执行），这一点必须能说清楚。
   *
   * 0 是合法的：它表示立即拒绝，测试用它构造确定性的边界。
   */
  CONCURRENCY_WAIT_MS: 5 * SECOND,
  /** 单工作区并发写入数（必须为 1）。 */
  MAX_CONCURRENT_WRITES_PER_WORKSPACE: 1,
  /** 每连接每小时出站内容预算。 */
  EGRESS_BYTES_PER_HOUR: 32 * MIB,
  /** 已终结操作的快照保留期。未终结/待恢复引用不清理。 */
  SNAPSHOT_RETENTION_MS: 7 * DAY,
  /** 目录遍历最大深度。 */
  MAX_LIST_DEPTH: 32,
  /** 单条搜索结果片段的最大字节数。 */
  MAX_SNIPPET_BYTES: 512,
  /** 单行最大字节数（超长行按此截断并标注）。 */
  MAX_LINE_BYTES: 8 * KIB,
  /**
   * 单个 `.git` 内部文件的大小上限（LWB-016）。
   *
   * 触发它的现实是 packfile：一个用了几年的仓库可能有几百 MiB 的
   * `.git/objects/pack/*.pack`。受控句柄**只提供整文件读取**，因此「读一半」
   * 不是一种降级，而是一种错误结果 —— 半份 pack 解析出来的是错的对象，
   * 而错的对象会变成一条看起来正常的差异。所以超限即明确拒绝该仓库，
   * 普通文件读取不受影响。
   */
  MAX_GIT_INTERNAL_FILE_BYTES: 64 * MIB,
  /**
   * 一次 `git_status` 累计允许读取的**工作区**字节数（LWB-016）。
   *
   * 为什么状态查询要读工作区内容：护栏不提供时间戳，因此下游库拿不到可用的
   * stat 缓存判据，只能对每个被跟踪文件读真实内容算摘要 —— 详见
   * `packages/git-reader/src/meta-fs.ts` 的说明。这个数字就是那件事的预算。
   *
   * 超限时**明确失败**并建议用 `path` 限定范围，而不是返回一份「部分文件
   * 已比对」的结果 —— 后者会让调用方把没比对的文件读成「没有改动」。
   */
  MAX_GIT_STATUS_WORKTREE_BYTES: 64 * MIB,
  /** 一次 `git_status` 最多返回的条目数；超出即 `truncated`。 */
  MAX_GIT_STATUS_ENTRIES: 2000,
  /**
   * 一次 `git_diff` 允许的**单侧**字节上限。
   *
   * 差异需要两侧内容同时在内存里，因此它比单文件读取上限更严：
   * 两侧各 16 MiB 就是 32 MiB 的峰值，而差异本来的用途是给人看的。
   */
  MAX_GIT_DIFF_BYTES: 8 * MIB,
  /** 一次 `git_diff` 输出的 hunk 行总字节上限。 */
  MAX_GIT_DIFF_OUTPUT_BYTES: 128 * KIB,
  /** `git_diff` 每个 hunk 前后各带几行上下文。 */
  GIT_DIFF_CONTEXT_LINES: 3,
} as const;

export type LimitKey = keyof typeof LIMITS;

/**
 * 与限额无关的**安全不变量**：任何配置都不能覆盖它。
 *
 * 它在 `OPERATOR_TUNABLE_LIMITS` 之外，因此 `validateLimitOverride` 会拒绝
 * 任何试图设置它的配置。把它写成一个具名清单而不是只留在注释里，
 * 是因为「不在那张表里」与「谁都没想过这件事」在阅读时长得一样。
 */
export const FIXED_LIMITS: readonly LimitKey[] = ['MAX_CONCURRENT_WRITES_PER_WORKSPACE'];

/**
 * 可以由操作者**收紧、不可以放宽**的限额（安全下限）。
 *
 * 并发上限保护的是本机资源（内存、磁盘、唯一的护栏助手进程）。
 * 把它调大不会让任何功能变得可用，只会让「本机被一个连接占满」这件事
 * 重新变成可能 —— 因此配置只能往严的方向调。
 *
 * ## 这个清单曾经是空的（LWB-018 修正）
 *
 * 原来的名字是 `NON_RELAXABLE_LIMITS`，里面只有
 * `MAX_CONCURRENT_WRITES_PER_WORKSPACE` —— 而那一项**不在**可调集合内，
 * 于是「可以收紧、不能放宽」这条语义对**任何**一个键都不成立：
 * 两条清单互不相交，「只能收紧」永远不会被触发。
 * 名字留在这里是为了让读到旧文档的人能找到改动的方向，
 * 但语义只有一条：**在可调集合内、且只能往严的方向调**。
 */
export const TIGHTEN_ONLY_LIMITS: readonly LimitKey[] = [
  'MAX_CONCURRENT_READS',
  'MAX_CONCURRENT_READS_PER_CONNECTION',
];

/**
 * 可以在本地配置中收紧或（由操作者明确）放宽的限额。
 * `FIXED_LIMITS` 里的项与限额无关，是安全不变量，不在可调集合内。
 */
export const OPERATOR_TUNABLE_LIMITS: readonly LimitKey[] = [
  'MAX_EDITABLE_FILE_BYTES',
  'MAX_RESPONSE_BODY_BYTES',
  'MAX_READ_LINES',
  'MAX_READABLE_FILE_BYTES',
  'READ_TOKEN_TTL_MS',
  'MAX_DIRECTORY_ENTRIES',
  'MAX_SEARCH_MATCHES',
  'MAX_SEARCH_QUERY_CHARS',
  'SEARCH_TIME_BUDGET_MS',
  'MAX_SEARCH_SCANNED_BYTES',
  'MAX_REQUEST_JSON_BYTES',
  'MAX_CHANGE_FILES',
  'MAX_EDITS_PER_FILE',
  'MAX_CHANGE_TOTAL_BYTES',
  'CHANGE_TTL_MS',
  'APPROVAL_TTL_MS',
  'EGRESS_BYTES_PER_HOUR',
  'MAX_CONCURRENT_READS',
  'MAX_CONCURRENT_READS_PER_CONNECTION',
  'CONCURRENCY_WAIT_MS',
  'SNAPSHOT_RETENTION_MS',
  'MAX_LIST_DEPTH',
  'MAX_GIT_INTERNAL_FILE_BYTES',
  'MAX_GIT_STATUS_WORKTREE_BYTES',
  'MAX_GIT_STATUS_ENTRIES',
  'MAX_GIT_DIFF_BYTES',
  'MAX_GIT_DIFF_OUTPUT_BYTES',
  'GIT_DIFF_CONTEXT_LINES',
];

/**
 * 校验一个本地配置的限额覆盖值的**语法与可调性**。
 * 返回 null 表示接受；否则返回拒绝原因。
 *
 * 这里**不**做方向校验：方向要拿当前值比，而当前值不是这个纯函数的输入。
 * 方向由 `validateLimitDirection` 单独负责 —— 分成两步的理由是
 * 「这个键能不能被配置覆盖」与「这个值比现在松还是紧」是两个独立的失败，
 * 合成一个函数会让「键不认识」和「值放宽了」在错误信息里失去区别。
 */
export function validateLimitOverride(key: string, value: unknown): string | null {
  if (!Object.prototype.hasOwnProperty.call(LIMITS, key)) {
    return `未知限额键：${key}`;
  }
  if (!OPERATOR_TUNABLE_LIMITS.includes(key as LimitKey)) {
    return `限额 ${key} 不允许由配置覆盖`;
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || !Number.isInteger(value)) {
    return `限额 ${key} 必须是正整数字节/毫秒值`;
  }
  return null;
}

/**
 * 校验一个覆盖值是否**没有放宽**某条只能收紧的限额（LWB-018）。
 *
 * `current` 必须由调用方给出**当前生效值**，而不是 `LIMITS` 里的初值：
 * 覆盖是分层叠加的（进程启动参数 → 用户配置 → 本次会话），
 * 拿初值来比会让「先放宽、再声称没放宽」变成一条可行的路径。
 */
export function validateLimitDirection(
  key: LimitKey,
  value: number,
  current: number,
): string | null {
  if (!TIGHTEN_ONLY_LIMITS.includes(key)) return null;
  if (value > current) {
    return `限额 ${key} 只能收紧：当前 ${current}，配置要求 ${value}`;
  }
  return null;
}
