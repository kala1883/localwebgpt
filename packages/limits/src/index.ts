/**
 * `@lwb/limits` —— 限额解析与并发闸门（LWB-018）。
 *
 * 两件事放在一个包里，因为它们回答的是同一个问题的两半：
 * **「这个上限现在是多少」**（`overrides.ts`）与
 * **「现在还有位置吗」**（`concurrency.ts`）。
 * 分开会让装配根必须自己把两者接起来，而接错的方式（用了初值而不是
 * 生效值）在功能上完全看不出来 —— 恰恰是本工程在别处一律避免的那种失效。
 *
 * 本包**不持有**状态库、不写审计、不碰文件系统。它只做算术与计数，
 * 因此可以放心地在任何层调用。
 */

export { describeLimits, resolveLimits } from './overrides.ts';
export type {
  LimitTable,
  RejectedLimitOverride,
  ResolveLimitsResult,
} from './overrides.ts';

export { ConcurrencyGate, concurrencyGateFor } from './concurrency.ts';
export type {
  AcquireOutcome,
  ConcurrencyDenialReason,
  ConcurrencyGateOptions,
  ConcurrencyLease,
} from './concurrency.ts';
