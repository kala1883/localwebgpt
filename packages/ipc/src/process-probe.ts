/**
 * 进程存活探针（LWB-008 步骤 3）。
 *
 * `lease.ts` 需要回答的是「上一个写执行器还在不在」。这里给出可用的实现。
 *
 * ## 只用 `process.kill(pid, 0)`，不 spawn 任何东西
 *
 * `process.kill` 的语义在 Windows 上实测如下（本机 Node v22.20.0）：
 *
 * | pid | 结果 |
 * | --- | --- |
 * | 自身 | 不抛 |
 * | 不存在的 pid | `ESRCH` |
 *
 * 这样就不必为了探活去起一个 PowerShell —— 探活会在接管判定里被调用，
 * 而起进程既慢又会给「探针自己失败」增加新的失败模式。
 *
 * ## `started_at` 默认取不到，而这是**故意的保守**
 *
 * 没有启动时刻就无法排除 PID 复用，于是 `ExecutorLease.#holderStatus`
 * 会把「PID 存在」一律判为 `alive`。后果是：**只有旧持有者的进程真的消失了，
 * 接管才会成功**。方向是 fail-closed（该拒绝时拒绝），不是 fail-open。
 *
 * 代价是「PID 被复用 + 旧持有者已死」这种罕见情形下接管会被永久拒绝，
 * 需要人工介入。相较之下，反向的错误（把复用 PID 当成旧持有者已死而放行接管）
 * 会让两个执行器同时写，是更坏的失效。
 *
 * 需要更强的判定时，由上层注入 `startTimeOf`（见 `apps/daemon/src/lifecycle/`）。
 */

import type { ProcessIdentity, ProcessProbe } from './lease.ts';

/** 进程存在。 */
const EXISTS = 'exists';
/** 进程不存在。 */
const GONE = 'gone';

function livenessOf(pid: number): typeof EXISTS | typeof GONE {
  try {
    process.kill(pid, 0);
    return EXISTS;
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code === 'ESRCH') return GONE;
    // EPERM 表示进程存在但拿不到权限 —— 按**存在**处理。
    // 把 EPERM 当作「不存在」会在权限不足时放行接管，这是危险的误判方向。
    return EXISTS;
  }
}

export interface ProcessProbeOptions {
  /**
   * 查询启动时刻。返回 `null` 表示查不到。
   *
   * **必须抛异常来表示「查询失败」**，不要用 `null`：
   * `null` 与「查不到」在下游会被当作同一件事，而它们不一样 ——
   * 前者若被当成「进程不存在」，接管判定就会在不该放行时放行。
   */
  readonly startTimeOf?: (pid: number) => string | null;
}

export function createProcessProbe(options: ProcessProbeOptions = {}): ProcessProbe {
  return {
    identify(pid: number): ProcessIdentity | null {
      if (livenessOf(pid) === GONE) return null;
      const startedAt = options.startTimeOf ? options.startTimeOf(pid) : null;
      return { pid, started_at: startedAt };
    },
  };
}

/** 不查询启动时刻的默认探针。 */
export const nodeProcessProbe: ProcessProbe = createProcessProbe();

export const currentProcessIdentity = (): ProcessIdentity => ({
  pid: process.pid,
  started_at: null,
});
