/**
 * 全局 / 每连接两级并发许可（LWB-018 步骤 2）。
 *
 * ## 为什么是两级，而不是一个全局计数
 *
 * 全局计数保护的是**本机**：内存、磁盘、唯一的护栏后端。这一点
 * 一个数字就够了。第二个数字（每连接）保护的是**连接的公平性**：
 * 没有它，一条连接可以同时占满全部额度，而另一条连接看到的
 * 全是 `CONCURRENCY_LIMIT_EXCEEDED`。单用户本机上这不会发生，
 * 但「不会发生」是靠使用习惯，而不是靠结构 —— 而结构是唯一
 * 在将来（控制台自己也发起读取）仍然成立的东西。
 *
 * ## 等待，但不是队列
 *
 * 满额时**等一小会儿**再拒绝，而不是立刻拒绝：模型侧经常一次发多条
 * 并行调用，立刻拒绝会把一个正常的并行请求变成一条看起来像故障的错误。
 *
 * 但等待**有上界**，而且这个上界是刻意的：无限等待会把并发上限
 * 悄悄变成一个队列，调用方再也观察不到「本机忙」；而超时的语义是
 * **未执行**（不是部分执行），这一点必须能说清楚。
 *
 * 不用「唤醒队列」而是**轮询**，理由是可控性：唤醒队列要处理
 * 唤醒丢失、超时与唤醒同时到达、以及被唤醒后又被别人抢走这三件事，
 * 而它们各自的失败都是静默的（一个永久悬挂的调用）。轮询多花的是
 * 一次睡眠的延迟（≤ `poll_ms`），换来的是「满了就是等、到点就是拒绝」
 * 这条不需要证明的性质。`sleep` 可注入，因此测试里没有真实等待。
 *
 * ## 公平性的**准确**说法
 *
 * 不保证先进先出。保证的是：一条连接最多同时占用 `max_per_connection`
 * 个位置，因此它**不能**让另一条连接永远拿不到位置（除非全局上限
 * 本身就 ≤ 每连接上限）。这是有界的不公平，不是公平。
 */

import { LIMITS } from '@lwb/contracts';
import type { LimitTable } from './overrides.ts';

export type ConcurrencyDenialReason = 'GLOBAL_LIMIT_EXCEEDED' | 'CONNECTION_LIMIT_EXCEEDED';

export interface ConcurrencyLease {
  readonly connection_id: string;
  /** 取得位置所花的时间（毫秒）。0 表示没有等待。 */
  readonly waited_ms: number;
  /** 释放位置。**重复调用会抛**：那是一次记账错误，不该被静默吞掉。 */
  release(): void;
}

export type AcquireOutcome =
  | { readonly ok: true; readonly lease: ConcurrencyLease }
  | {
      readonly ok: false;
      readonly reason: ConcurrencyDenialReason;
      readonly waited_ms: number;
      readonly in_flight: number;
      readonly limit: number;
    };

export interface ConcurrencyGateOptions {
  /** 全局同时进行的调用数上限。 */
  readonly max_concurrent?: number;
  /** 单连接同时进行的调用数上限。 */
  readonly max_per_connection?: number;
  /** 满额时最多等多久。0 表示立即拒绝（测试用它构造确定边界）。 */
  readonly wait_ms?: number;
  /** 轮询间隔。轮询粒度即「额外延迟的上界」。 */
  readonly poll_ms?: number;
  /** 单调毫秒时钟。用于 `waited_ms`，不参与任何授权判断。 */
  readonly now?: () => number;
  /** 睡眠。注入它是为了让测试不真的等待。 */
  readonly sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_POLL_MS = 25;

export class ConcurrencyGate {
  readonly #maxConcurrent: number;
  readonly #maxPerConnection: number;
  readonly #waitMs: number;
  readonly #pollMs: number;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;

  #inFlight = 0;
  readonly #perConnection = new Map<string, number>();
  #denials = 0;

  constructor(options: ConcurrencyGateOptions = {}) {
    this.#maxConcurrent = options.max_concurrent ?? LIMITS.MAX_CONCURRENT_READS;
    this.#maxPerConnection =
      options.max_per_connection ?? LIMITS.MAX_CONCURRENT_READS_PER_CONNECTION;
    this.#waitMs = options.wait_ms ?? LIMITS.CONCURRENCY_WAIT_MS;
    this.#pollMs = options.poll_ms ?? DEFAULT_POLL_MS;
    this.#now = options.now ?? (() => Date.now());
    this.#sleep =
      options.sleep ??
      ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

    for (const [name, value] of [
      ['max_concurrent', this.#maxConcurrent],
      ['max_per_connection', this.#maxPerConnection],
      ['wait_ms', this.#waitMs],
      ['poll_ms', this.#pollMs],
    ] as const) {
      // 配错就拒绝构造，不退化成某个默认值 —— 与出站预算同一条理由：
      // 一个悄悄生效的默认值会让「我明明配了更小的额度」变成一句空话。
      if (!Number.isInteger(value) || value < 0) {
        throw new Error(`并发闸门的 ${name} 必须是非负整数，收到 ${String(value)}。`);
      }
    }
    if (this.#maxConcurrent < 1 || this.#maxPerConnection < 1) {
      throw new Error('并发上限至少为 1：0 会让每一次调用都失败。');
    }
  }

  /** 生效上限，供诊断。 */
  get limits(): { readonly max_concurrent: number; readonly max_per_connection: number; readonly wait_ms: number } {
    return {
      max_concurrent: this.#maxConcurrent,
      max_per_connection: this.#maxPerConnection,
      wait_ms: this.#waitMs,
    };
  }

  /**
   * 取一个位置。**这是唯一的取得路径**，返回的凭证必须被释放。
   *
   * 检查与自增之间没有 `await`：JS 的单线程执行模型保证了
   * 「判断能不能进」与「进去」是同一个不可分割的步骤。若中间插入
   * 一个 await（例如为了记日志去查库），两个调用就会同时通过检查 ——
   * 这类竞态在本地单用户下几乎不会出现，因此**几乎不会被测出来**。
   */
  async acquire(connection_id: string): Promise<AcquireOutcome> {
    const start = this.#now();
    for (;;) {
      const taken = this.#tryTake(connection_id, start);
      if (taken !== null) return taken;
      if (this.#now() - start >= this.#waitMs) {
        // 到点仍然没有位置。**未执行**：这里没有产生任何副作用，
        // 也没有读任何文件，调用方可以安全地当作「什么都没发生」。
        //
        // 拒绝原因必须**分得清是哪一级满了**：两者对操作者的含义不同
        // （一条连接太贪 / 本机整体太忙），而它们的处置也不同。
        // 两级可以同时满；此时报「这条连接」更有用，因为它更具体，
        // 且是操作者能直接处置的那一个。
        this.#denials += 1;
        const used = this.#perConnection.get(connection_id) ?? 0;
        const perConnectionFull = used >= this.#maxPerConnection;
        return {
          ok: false,
          reason: perConnectionFull ? 'CONNECTION_LIMIT_EXCEEDED' : 'GLOBAL_LIMIT_EXCEEDED',
          waited_ms: this.#now() - start,
          in_flight: this.#inFlight,
          limit: perConnectionFull ? this.#maxPerConnection : this.#maxConcurrent,
        };
      }
      // 睡眠长度不超过剩余等待时间：否则一次睡眠就可能超出上界，
      // 而「最多等 wait_ms」这句话就不再成立。
      const remaining = this.#waitMs - (this.#now() - start);
      await this.#sleep(Math.max(1, Math.min(this.#pollMs, remaining)));
    }
  }

  /** 试取一次；成功返回结果，失败返回 null（由调用方决定等还是拒）。 */
  #tryTake(connection_id: string, start: number): AcquireOutcome | null {
    const usedByConnection = this.#perConnection.get(connection_id) ?? 0;
    if (usedByConnection >= this.#maxPerConnection) return null;
    if (this.#inFlight >= this.#maxConcurrent) return null;

    this.#inFlight += 1;
    this.#perConnection.set(connection_id, usedByConnection + 1);
    return {
      ok: true,
      lease: this.#makeLease(connection_id, this.#now() - start),
    };
  }

  #makeLease(connection_id: string, waitedMs: number): ConcurrencyLease {
    let released = false;
    return {
      connection_id,
      waited_ms: waitedMs,
      release: (): void => {
        if (released) {
          throw new Error('并发许可被重复释放：这是一次记账错误，调用方必须只释放一次。');
        }
        released = true;
        this.#inFlight -= 1;
        const used = (this.#perConnection.get(connection_id) ?? 1) - 1;
        if (used <= 0) this.#perConnection.delete(connection_id);
        else this.#perConnection.set(connection_id, used);
      },
    };
  }

  /** 诊断快照。只有计数，没有任何内容。 */
  snapshot(): {
    readonly in_flight: number;
    readonly max_concurrent: number;
    readonly connections: Readonly<Record<string, number>>;
    readonly denials: number;
    readonly wait_ms: number;
    readonly max_per_connection: number;
  } {
    return {
      in_flight: this.#inFlight,
      max_concurrent: this.#maxConcurrent,
      max_per_connection: this.#maxPerConnection,
      wait_ms: this.#waitMs,
      denials: this.#denials,
      connections: Object.fromEntries([...this.#perConnection.entries()].sort()),
    };
  }
}

/** 从一张生效限额表建闸门。装配根用这个，而不是自己拼参数。 */
export function concurrencyGateFor(limits: LimitTable): ConcurrencyGate {
  return new ConcurrencyGate({
    max_concurrent: limits.MAX_CONCURRENT_READS,
    max_per_connection: limits.MAX_CONCURRENT_READS_PER_CONNECTION,
    wait_ms: limits.CONCURRENCY_WAIT_MS,
  });
}
