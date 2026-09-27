/**
 * 出站内容预算（方案 §9.3 `EGRESS_BYTES_PER_HOUR`）。
 *
 * ## 为什么是滑动窗口，不是「每小时一个桶」
 *
 * 最省事的实现是记 `{hourStart, bytesThisHour}`，跨小时清零。它有一个**两倍**
 * 的漏洞：在 12:59 用满一整小时的额度，13:00 立刻又有一整小时。也就是说
 * 「每小时 32 MiB」实际允许在两分钟内送走 64 MiB。
 *
 * 这里用 **60 个月份桶**：`Map<分钟序号, 字节数>`，每次访问清掉 60 分钟以外的桶，
 * 用量取全部存活桶之和。内存是 O(60)，与窗口无关。
 *
 * ## 这个窗口的**真实**精度（不夸大）
 *
 * 桶的粒度是 1 分钟，因此有效窗口长度在 **[59, 60] 分钟**之间浮动：
 * 最坏情况下会提前一分钟忘掉最早的用量。于是超出部分的上界是
 * **一分钟内能送出的量**（约 `limit / 60`，默认 32 MiB 时约 546 KiB），
 * 而不是固定小时桶的整整一倍。方向是固定的、有界的，且比替代方案小两个数量级。
 *
 * ## 记账的两条铁律
 *
 *  1. **先检查、后记账、再出站。** 被拒绝的出站**不记账**：否则一个反复被拒的
 *     请求会把额度耗光，而它什么都没送出去 —— 那既是错误的计量，也成了一个
 *     廉价拒绝服务入口。
 *  2. **超额一次，就是整体拒绝，不做部分记账。** 「先送一半、剩下的下次」
 *     会让调用方以为拿到的是完整结果（违反 I14：只有终态回执才能支持"已保存"）。
 */

export type BudgetDenialReason =
  | 'WINDOW_LIMIT_EXCEEDED'
  | 'SINGLE_REQUEST_EXCEEDS_LIMIT';

export type BudgetVerdict =
  | {
      readonly ok: true;
      readonly used_bytes: number;
      readonly limit_bytes: number;
      readonly remaining_bytes: number;
    }
  | {
      readonly ok: false;
      readonly reason: BudgetDenialReason;
      readonly used_bytes: number;
      readonly limit_bytes: number;
      readonly requested_bytes: number;
    };

const MINUTE_MS = 60_000;
const WINDOW_MINUTES = 60;

function minuteOf(ms: number): number {
  return Math.floor(ms / MINUTE_MS);
}

export interface EgressBudgetOptions {
  /** 每连接每小时的出站字节上限。必须为正整数。 */
  readonly limit_bytes_per_hour: number;
  /**
   * 时钟。由调用方注入：出站预算的判断必须与真正的记账用同一个时钟，
   * 而不是各自 `Date.now()`。测试也据此构造边界。
   */
  readonly now: () => number;
}

export class EgressBudget {
  readonly #limit: number;
  readonly #now: () => number;
  readonly #buckets = new Map<number, number>();
  #charged_total = 0;
  #denials = 0;

  constructor(options: EgressBudgetOptions) {
    const limit = options.limit_bytes_per_hour;
    // 限额配错时**拒绝构造**，而不是退化成某个默认值 —— 一个悄悄生效的默认值
    // 会让「我明明配了更小的额度」变成一句空话。
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit <= 0) {
      throw new Error(`出站预算上限必须是正整数，收到 ${String(limit)}`);
    }
    this.#limit = limit;
    this.#now = options.now;
  }

  get limitBytes(): number {
    return this.#limit;
  }

  get chargedTotal(): number {
    return this.#charged_total;
  }

  get denials(): number {
    return this.#denials;
  }

  /** 清掉窗口之外的桶。每次访问都调用，因此内存不会随时间增长。 */
  #purge(nowMs: number): void {
    const oldest = minuteOf(nowMs) - (WINDOW_MINUTES - 1);
    for (const key of this.#buckets.keys()) {
      if (key < oldest) this.#buckets.delete(key);
    }
  }

  /** 当前窗口内的用量。只读，不改状态。 */
  usedBytes(): number {
    const nowMs = this.#now();
    this.#purge(nowMs);
    let sum = 0;
    for (const bytes of this.#buckets.values()) sum += bytes;
    return sum;
  }

  /** 试算：只判断，不记账。用于「先问一句行不行」的场景。 */
  check(requested_bytes: number): BudgetVerdict {
    if (!Number.isInteger(requested_bytes) || requested_bytes < 0) {
      throw new Error(`出站字节数必须是非负整数，收到 ${String(requested_bytes)}`);
    }
    const used = this.usedBytes();

    if (requested_bytes > this.#limit) {
      return {
        ok: false,
        reason: 'SINGLE_REQUEST_EXCEEDS_LIMIT',
        used_bytes: used,
        limit_bytes: this.#limit,
        requested_bytes,
      };
    }
    if (used + requested_bytes > this.#limit) {
      return {
        ok: false,
        reason: 'WINDOW_LIMIT_EXCEEDED',
        used_bytes: used,
        limit_bytes: this.#limit,
        requested_bytes,
      };
    }
    return {
      ok: true,
      used_bytes: used,
      limit_bytes: this.#limit,
      remaining_bytes: this.#limit - used - requested_bytes,
    };
  }

  /**
   * 检查并记账。**只有真正要出站时调用它。**
   *
   * 拒绝时**不产生任何记账**：调用方拿到 `ok: false` 之后应当整个请求失败，
   * 而不是"少送一点"。
   */
  charge(requested_bytes: number): BudgetVerdict {
    const verdict = this.check(requested_bytes);
    if (!verdict.ok) {
      this.#denials += 1;
      return verdict;
    }
    const nowMs = this.#now();
    this.#purge(nowMs);
    const key = minuteOf(nowMs);
    this.#buckets.set(key, (this.#buckets.get(key) ?? 0) + requested_bytes);
    this.#charged_total += requested_bytes;
    return {
      ok: true,
      used_bytes: verdict.used_bytes + requested_bytes,
      limit_bytes: this.#limit,
      remaining_bytes: verdict.remaining_bytes,
    };
  }

  /** 诊断快照。**不含任何内容**，只有计数。 */
  snapshot(): { readonly limit_bytes: number; readonly used_bytes: number; readonly buckets: number; readonly charged_total: number; readonly denials: number } {
    return {
      limit_bytes: this.#limit,
      used_bytes: this.usedBytes(),
      buckets: this.#buckets.size,
      charged_total: this.#charged_total,
      denials: this.#denials,
    };
  }
}

/**
 * 按连接维度保管预算。
 *
 * 预算是**每连接**的而不是每工作区的：一个连接可以访问多个工作区，
 * 若按工作区记，多授权一个工作区就顺带多拿一份额度 —— 扩大授权范围不该
 * 顺带扩大出站额度（那正是「扩大资源根」的一种隐蔽形式）。
 */
export class EgressBudgetStore {
  readonly #limit: number;
  readonly #now: () => number;
  readonly #byConnection = new Map<string, { readonly budget: EgressBudget; seen_at: number }>();

  constructor(options: EgressBudgetOptions) {
    this.#limit = options.limit_bytes_per_hour;
    this.#now = options.now;
  }

  forConnection(connection_id: string): EgressBudget {
    const existing = this.#byConnection.get(connection_id);
    if (existing !== undefined) {
      this.#byConnection.set(connection_id, { budget: existing.budget, seen_at: this.#now() });
      return existing.budget;
    }
    const budget = new EgressBudget({ limit_bytes_per_hour: this.#limit, now: this.#now });
    this.#byConnection.set(connection_id, { budget, seen_at: this.#now() });
    return budget;
  }

  /**
   * 清掉长时间没有活动的连接预算。
   *
   * 注意这**不会**让额度变宽松到有意义：被清掉的是一个窗口内用量为零或
   * 已经滑出窗口的预算 —— 若某个连接在窗口内还有用量，它不该被清掉。
   * 因此这里只清「窗口内用量为 0」的条目。
   */
  prune(): number {
    const nowMs = this.#now();
    let removed = 0;
    for (const [id, entry] of this.#byConnection) {
      if (entry.budget.usedBytes() === 0 && nowMs - entry.seen_at > WINDOW_MINUTES * MINUTE_MS) {
        this.#byConnection.delete(id);
        removed += 1;
      }
    }
    return removed;
  }

  get size(): number {
    return this.#byConnection.size;
  }
}
