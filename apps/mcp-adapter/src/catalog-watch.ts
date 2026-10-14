/** Detect catalog drift, including cached clients reconnecting after an upgrade. */
export interface CatalogWatchOptions {
  read: () => Promise<unknown>;
  notify: () => Promise<void>;
  interval_ms?: number;
}
export function createCatalogWatch(options: CatalogWatchOptions) {
  const interval = options.interval_ms ?? 5_000;
  if (!Number.isSafeInteger(interval) || interval < 10) throw new RangeError('Invalid catalog watch interval.');
  let timer: ReturnType<typeof setInterval> | undefined;
  let stopped = true;
  let busy = false;
  let last: string | undefined;
  let invalidated = false;
  let generation = 0;
  const tick = async (): Promise<void> => {
    if (stopped || busy) return;
    busy = true;
    const current = generation;
    try {
      const next = JSON.stringify(await options.read());
      if (stopped || current !== generation) return;
      if (next !== last || invalidated) {
        // Do not advance the baseline if notification delivery fails.
        await options.notify();
        if (!stopped && current === generation) { last = next; invalidated = false; }
      }
    } catch {
      // A failed read is not an empty catalog and never widens authorization.
      invalidated = true;
    } finally { busy = false; }
  };
  return {
    start(): void {
      if (!stopped) return;
      stopped = false; generation += 1; last = undefined;
      timer = setInterval(() => { void tick(); }, interval);
      timer.unref?.();
      void tick(); // Ask a reconnected client to refresh its possibly stale inventory once.
    },
    stop(): void {
      stopped = true; generation += 1;
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
    },
    tick,
  };
}
