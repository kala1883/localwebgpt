/**
 * 写执行器租约与栅栏令牌（LWB-008 步骤 3、验收标准 3）。
 *
 * > 验收标准：**超时或租约到期不会直接允许另一个执行器与仍存活的旧执行器同时写。**
 *
 * ## 为什么「到期即释放」是错的
 *
 * 租约到期的唯一含义是「**没有收到续约**」。没有收到续约的原因至少有三类：
 *
 *  1. 持有者真的死了；
 *  2. 持有者活着，但被挂起（笔记本休眠、调试器断点、虚拟机暂停、CPU 饥饿）；
 *  3. 网络/管道短暂不通，续约请求没送到。
 *
 * 只有第 1 类允许接管。第 2、3 类接管就得到两个同时写文件的进程，
 * 而它们的写入都通过了护栏的**句柄级**检查（各自看到的是自己打开时的基线），
 * 于是最后一个写入者静默覆盖前一个 —— 这正是本方案要防的那类损坏。
 *
 * 所以接管需要**两个**条件同时成立：租约已过期 **且** 能证明旧持有者已不在。
 *
 * ## 栅栏令牌
 *
 * 即便接管判定出错（例如进程在「判定死亡」与「新持有者开工」之间又活了过来），
 * 也必须保证旧持有者的写入被拒绝。做法是让 daemon 持有**单调递增**的令牌，
 * 每次写入都要带上它；daemon 只接受**等于当前令牌**的写入。
 *
 * 令牌不是在租约里发一次就完事：**每次写入都校验**。
 * 「连接建立时校验一次」会让一个已经失去租约的执行器在整个连接生命周期内保持写权限。
 */

import { randomBytes } from 'node:crypto';

export interface ProcessIdentity {
  readonly pid: number;
  /**
   * 进程启动时刻（ISO 字符串或 `null`）。
   *
   * 存在的唯一理由：**PID 会被复用**。只比较 PID 会把一个刚启动的无关进程
   * 误判成「旧持有者还活着」而永远拒绝接管，或者反过来把旧持有者误判成别人。
   */
  readonly started_at: string | null;
}

/**
 * 持有者进程的状态。三个值里的 `unknown` 是**重点**：它不等于 `gone`。
 *
 * 这个类型与判定它的 `classifyProcessHolder` 一起放在这里，而不是各用各的：
 * 写执行器（本文件）与执行协调器（`@lwb/executor`）问的是同一个问题 ——
 * 「上一个写的人还在不在」—— 而这个问题只能有一个答案。
 * 两处各写一份，表现为「一处说还能接管、另一处说不能」，而排障的人
 * 会先去怀疑租约，不会怀疑有两份实现。
 */
export type HolderStatus = 'alive' | 'gone' | 'unknown';

/**
 * 问系统：这个持有者还在不在。
 *
 * 判定顺序（每一步的方向都是**保守**）：
 *
 *  1. 探针抛异常 → `unknown`。这不是「它死了」，而是「我不知道」——
 *     这条分支如果被写成 `gone`，接管会在探针不可用时被放行。
 *  2. 进程不存在 → `gone`。
 *  3. 进程存在、且两边的启动时刻都拿得到 → 相同才是 `alive`，
 *     不同说明 PID 被**另一个**进程复用了，即 `gone`。
 *  4. 启动时刻拿不到 → 无法排除 PID 复用，保守判为 `alive`，
 *     代价是「PID 被复用 + 旧持有者已死」这种罕见情形需要人工介入。
 */
export function classifyProcessHolder(probe: ProcessProbe, process: ProcessIdentity): HolderStatus {
  let observed: ProcessIdentity | null;
  try {
    observed = probe.identify(process.pid);
  } catch {
    // 探针不可用 ≠ 持有者已死。这条分支如果被写成 'gone'，
    // 验收标准 3 就形同虚设。
    return 'unknown';
  }
  if (observed === null) return 'gone';

  // PID 存在。但如果启动时刻不同，说明这是**另一个**进程复用了这个 PID。
  if (process.started_at !== null && observed.started_at !== null) {
    return observed.started_at === process.started_at ? 'alive' : 'gone';
  }
  // 启动时刻取不到时无法排除 PID 复用，保守当作还活着。
  return 'alive';
}

export interface LeaseRecord {
  readonly executor_id: string;
  readonly process: ProcessIdentity;
  /** 单调递增，跨接管只增不减。 */
  readonly fencing_token: number;
  readonly acquired_at: string;
  readonly expires_at: string;
  readonly renewed_at: string;
}

export type AcquireOutcome =
  | { readonly kind: 'acquired'; readonly lease: LeaseRecord }
  | { readonly kind: 'renewed'; readonly lease: LeaseRecord }
  | { readonly kind: 'refused'; readonly reason: string; readonly code: AcquireRefusal };

export type AcquireRefusal =
  | 'HELD_BY_LIVE_EXECUTOR'
  | 'LEASE_NOT_EXPIRED'
  | 'CANNOT_PROVE_HOLDER_GONE'
  | 'PROCESS_PROBE_UNAVAILABLE';

export class LeaseError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'LeaseError';
    this.code = code;
  }
}

/** 查询进程是否存活及其启动时刻。 */
export interface ProcessProbe {
  /**
   * @returns 进程不存在时返回 `null`；**无法判断**时抛出（不得返回 `null`）。
   *
   * 「查不出来」与「不存在」必须分开：把前者当成后者会让接管判定
   * 在不该放行的时候放行。这正是 `PROCESS_PROBE_UNAVAILABLE` 存在的原因。
   */
  identify(pid: number): ProcessIdentity | null;
}

export interface LeaseOptions {
  readonly probe: ProcessProbe;
  /** 租约时长（毫秒）。 */
  readonly leaseMs?: number;
  /** 允许注入时钟，便于测试构造过期场景。 */
  readonly now?: () => number;
}

const DEFAULT_LEASE_MS = 30_000;

/**
 * 写执行器租约。
 *
 * **刻意不做持久化。** 令牌只需要在「同一个 daemon 实例的生命周期内」单调；
 * daemon 重启意味着旧执行器也已随之失去意义（旧执行器的写入会被新 daemon 拒绝，
 * 因为令牌从 0 重新开始——见下方 `#tokenFloor` 的说明）。
 *
 * 持久化令牌需要一张新的表或一个状态文件，而两者都会引入
 * 「状态文件比进程活得久」的新失效模式，收益却只有一个跨重启的单调性 ——
 * 而跨重启的旧执行器本来就无法与 daemon 通信（管道的另一端已经没了）。
 */
export class ExecutorLease {
  #current: LeaseRecord | null = null;
  /** 令牌地板：即使租约被释放，令牌也不回退。 */
  #tokenFloor = 0;
  readonly #probe: ProcessProbe;
  readonly #leaseMs: number;
  readonly #now: () => number;

  constructor(options: LeaseOptions) {
    this.#probe = options.probe;
    this.#leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
    this.#now = options.now ?? (() => Date.now());
  }

  get current(): LeaseRecord | null {
    return this.#current;
  }

  get fencingToken(): number {
    return this.#current?.fencing_token ?? this.#tokenFloor;
  }

  /**
   * 申请或续约。
   *
   * 同一个 `executor_id` 再次申请视为续约：令牌**不变**。
   * 换令牌会让执行器正在进行的写入突然被自己拒绝。
   */
  acquire(executorId: string, process: ProcessIdentity): AcquireOutcome {
    const now = this.#now();

    if (this.#current && this.#current.executor_id === executorId) {
      const renewed: LeaseRecord = {
        ...this.#current,
        renewed_at: new Date(now).toISOString(),
        expires_at: new Date(now + this.#leaseMs).toISOString(),
      };
      this.#current = renewed;
      return { kind: 'renewed', lease: renewed };
    }

    if (this.#current) {
      const expiresAt = Date.parse(this.#current.expires_at);
      if (now < expiresAt) {
        return {
          kind: 'refused',
          code: 'LEASE_NOT_EXPIRED',
          reason:
            `写执行器租约仍有效（持有 ${this.#current.executor_id}，` +
            `${new Date(expiresAt).toISOString()} 到期），拒绝第二个执行器。`,
        };
      }

      // 租约已过期。**但这还不足以接管。**
      const verdict = classifyProcessHolder(this.#probe, this.#current.process);
      if (verdict === 'alive') {
        return {
          kind: 'refused',
          code: 'HELD_BY_LIVE_EXECUTOR',
          reason:
            `租约已过期，但旧执行器（pid=${this.#current.process.pid}）**仍然存活**。` +
            '过期只说明没有收到续约，不说明持有者已退出；拒绝接管以避免两个执行器同时写。',
        };
      }
      if (verdict === 'unknown') {
        return {
          kind: 'refused',
          code: 'CANNOT_PROVE_HOLDER_GONE',
          reason:
            `无法确认旧执行器（pid=${this.#current.process.pid}）是否已退出，` +
            '拒绝在无法证明时接管。',
        };
      }
      // verdict === 'gone'：可以接管。
    }

    const next = Math.max(this.#tokenFloor, this.#current?.fencing_token ?? 0) + 1;
    const token = Number.isSafeInteger(next) ? next : this.#tokenFloor + 1;
    this.#tokenFloor = token;

    const lease: LeaseRecord = {
      executor_id: executorId,
      process,
      fencing_token: token,
      acquired_at: new Date(now).toISOString(),
      renewed_at: new Date(now).toISOString(),
      expires_at: new Date(now + this.#leaseMs).toISOString(),
    };
    this.#current = lease;
    return { kind: 'acquired', lease };
  }

  /**
   * 校验一次写入请求。
   *
   * 令牌**必须等于**当前令牌。小于 → 这是被取代的旧执行器；
   * 大于 → 不可能（令牌从不由外部产生），一律拒绝。
   */
  authorizeWrite(executorId: string, fencingToken: number): { ok: true } | { ok: false; reason: string } {
    const current = this.#current;
    if (!current) {
      return { ok: false, reason: '当前没有生效的写执行器租约，拒绝写入。' };
    }
    if (current.executor_id !== executorId) {
      return {
        ok: false,
        reason: `写执行器标识不匹配（当前 ${current.executor_id}），拒绝写入。`,
      };
    }
    if (current.fencing_token !== fencingToken) {
      return {
        ok: false,
        reason:
          `栅栏令牌已失效（当前 ${current.fencing_token}，请求 ${fencingToken}），拒绝写入。` +
          '这通常意味着本执行器已被接管。',
      };
    }
    if (this.#now() >= Date.parse(current.expires_at)) {
      // 到期后**不**自动续期：执行器必须显式续约，否则我们无法区分
      // 「它还在正常工作」与「它卡住了但连接未断」。
      return { ok: false, reason: '写执行器租约已到期且未续约，拒绝写入。' };
    }
    return { ok: true };
  }

  /** 主动释放。令牌地板保留，因此下一次接管仍会得到更大的令牌。 */
  release(executorId: string): void {
    if (this.#current && this.#current.executor_id === executorId) {
      this.#tokenFloor = this.#current.fencing_token;
      this.#current = null;
    }
  }
}

export function newExecutorId(): string {
  return `exe_${randomBytes(8).toString('hex')}`;
}
