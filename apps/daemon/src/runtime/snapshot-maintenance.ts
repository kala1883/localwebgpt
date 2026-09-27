/** Bounded single-flight scheduler for periodic snapshot maintenance. */

export const DEFAULT_SNAPSHOT_MAINTENANCE_INTERVAL_MS = 60 * 60 * 1000;

export interface SnapshotMaintenanceLoopOptions {
  readonly interval_ms?: number;
  readonly run: () => Promise<void>;
  /** Must log only a fixed, path-free message. */
  readonly onError: () => void;
  /** Timer injection keeps scheduling/overlap/shutdown behavior deterministic in tests. */
  readonly schedule?: (callback: () => void, interval_ms: number) => () => void;
}

export interface SnapshotMaintenanceLoop {
  tick(): Promise<void>;
  stop(): Promise<void>;
}

function scheduleInterval(callback: () => void, intervalMs: number): () => void {
  const timer = setInterval(callback, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

export function startSnapshotMaintenanceLoop(
  options: SnapshotMaintenanceLoopOptions,
): SnapshotMaintenanceLoop {
  const intervalMs = options.interval_ms ?? DEFAULT_SNAPSHOT_MAINTENANCE_INTERVAL_MS;
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1) {
    throw new RangeError('快照维护周期必须是正的安全整数毫秒。');
  }

  let stopped = false;
  let running: Promise<void> | null = null;
  const tick = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (running !== null) return running;

    const task = Promise.resolve()
      .then(options.run)
      .catch(() => {
        try {
          options.onError();
        } catch {
          // Maintenance logging must not turn a background failure into an
          // unhandled rejection or interfere with the daemon shutdown path.
        }
      })
      .finally(() => {
        if (running === task) running = null;
      });
    running = task;
    return task;
  };

  const cancel = (options.schedule ?? scheduleInterval)(() => { void tick(); }, intervalMs);
  return {
    tick,
    async stop() {
      if (stopped) {
        await running;
        return;
      }
      stopped = true;
      cancel();
      await running;
    },
  };
}
