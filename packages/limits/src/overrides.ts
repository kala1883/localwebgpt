/**
 * 把本地配置叠加到限额初值上（LWB-018）。
 *
 * ## 这一步为什么必须存在
 *
 * `packages/contracts/src/limits.ts` 里一直有 `validateLimitOverride` 与
 * 「只能收紧」的说法，但在 LWB-018 之前**没有任何调用方**：那些常量是
 * 一份写下来就没被读过的规则。一份没被读过的规则与一条注释没有区别 ——
 * 而它更糟，因为它看起来像已经生效的东西。
 *
 * 本文件是那两件事的**唯一**接线点：校验（键是否可覆盖、值是否合法）
 * 与方向（是否比当前值更松）。两件事分开，因为它们的失败含义不同：
 * 「键不认识」是配置写错了，「值放宽了」是想扩大权限。
 *
 * ## 为什么方向要拿**当前值**比，而不是拿初值
 *
 * 覆盖是分层的（进程参数 → 用户配置 → 本次会话）。若每一层都拿
 * `LIMITS` 的初值比，那么「第一层放宽、第二层声明没放宽」就是一条
 * 可行路径：第二层看到的是一个已经放宽后的基准，于是它「没有放宽」。
 * 因此 `base` 是**入参**，调用方必须传上一层的结果。
 *
 * ## 被拒绝的项不静默
 *
 * `resolveLimits` 返回 `rejected` 而不是抛错：一个写错的配置项不应该让
 * daemon 起不来（那样本地操作者会为了让它起来而把整份配置删掉，
 * 连合法的收紧一起丢掉）。但它必须有**去处** —— 装配根要把它写进
 * 启动日志与审计。返回值里带着理由字符串就是为了让那个去处存在。
 */

import { LIMITS, validateLimitDirection, validateLimitOverride } from '@lwb/contracts';
import type { LimitKey } from '@lwb/contracts';

/** 生效限额表。形状与 `LIMITS` 相同（冻结的初值表）。 */
export type LimitTable = { readonly [K in LimitKey]: number };

export interface RejectedLimitOverride {
  readonly key: string;
  readonly value: unknown;
  readonly reason: string;
}

export interface ResolveLimitsResult {
  /** 叠加之后**生效**的限额。冻结：调用方不得就地改。 */
  readonly limits: LimitTable;
  /** 实际生效的覆盖项。 */
  readonly accepted: readonly LimitKey[];
  /** 被拒绝的覆盖项与理由。调用方必须把它们写进日志/审计。 */
  readonly rejected: readonly RejectedLimitOverride[];
}

/**
 * 叠加一层覆盖。
 *
 * `base` 省略即用冻结初值 —— 省略是**启动时**的语义（没有任何一层配置），
 * 而不是「这一层不用比」。
 */
export function resolveLimits(
  override: Readonly<Record<string, unknown>>,
  base: LimitTable = LIMITS,
): ResolveLimitsResult {
  const limits: Record<string, number> = { ...base };
  const accepted: LimitKey[] = [];
  const rejected: RejectedLimitOverride[] = [];

  for (const key of Object.keys(override).sort()) {
    const value = override[key];
    const syntax = validateLimitOverride(key, value);
    if (syntax !== null) {
      rejected.push({ key, value: summarizable(value), reason: syntax });
      continue;
    }
    const typed = key as LimitKey;
    // 走到这里 value 已由 validateLimitOverride 保证是正整数，
    // 但那条保证读起来依赖另一个函数 —— 这里重新取一次窄，不依赖读者去翻。
    if (typeof value !== 'number') {
      rejected.push({ key, value: summarizable(value), reason: `限额 ${key} 必须是数字。` });
      continue;
    }
    const direction = validateLimitDirection(typed, value, limits[typed] as number);
    if (direction !== null) {
      rejected.push({ key, value, reason: direction });
      continue;
    }
    limits[typed] = value;
    accepted.push(typed);
  }

  return { limits: Object.freeze(limits) as LimitTable, accepted, rejected };
}

/**
 * 被拒绝的值在日志里长什么样。
 *
 * 只报**类型**或长度，不把值原样带出去：配置可以来自任何地方，
 * 而这条路径上我们已经在拒绝它了 —— 没有理由顺手把它扩写进日志。
 */
function summarizable(value: unknown): string {
  if (typeof value === 'string') return `<string:${value.length}>`;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value === null) return 'null';
  if (Array.isArray(value)) return `<array:${value.length}>`;
  return `<${typeof value}>`;
}

/** 生效限额里的一次采样，供诊断与证据脚本使用。**不含任何内容。** */
export function describeLimits(
  limits: LimitTable,
  keys: readonly LimitKey[],
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key of keys) out[key] = limits[key];
  return out;
}
