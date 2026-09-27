import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DEFAULT_SNAPSHOT_MAINTENANCE_INTERVAL_MS,
  startSnapshotMaintenanceLoop,
} from '../../apps/daemon/src/runtime/snapshot-maintenance.ts';

describe('LWB-038 periodic snapshot maintenance scheduler', () => {
  it('runs single-flight and shutdown cancels future ticks and awaits current work', async () => {
    let callback: () => void = () => assert.fail('scheduler callback was not installed');
    let cancelled = false;
    let observedInterval = 0;
    let runs = 0;
    let finishRun!: () => void;
    const work = new Promise<void>((resolve) => { finishRun = resolve; });
    const loop = startSnapshotMaintenanceLoop({
      run: async () => { runs += 1; await work; },
      onError: () => assert.fail('the maintenance work should not fail'),
      schedule: (tick, intervalMs) => {
        callback = tick;
        observedInterval = intervalMs;
        return () => { cancelled = true; };
      },
    });

    assert.equal(observedInterval, DEFAULT_SNAPSHOT_MAINTENANCE_INTERVAL_MS);
    const first = loop.tick();
    await Promise.resolve();
    const overlapping = loop.tick();
    assert.strictEqual(overlapping, first);
    assert.equal(runs, 1);

    let stopFinished = false;
    const stopping = loop.stop().then(() => { stopFinished = true; });
    assert.equal(cancelled, true);
    await Promise.resolve();
    assert.equal(stopFinished, false, 'shutdown must wait until an in-flight maintenance pass ends');
    finishRun();
    await Promise.all([first, overlapping, stopping]);
    assert.equal(stopFinished, true);
    callback();
    assert.equal(runs, 1, 'cancelled timer callback must not restart maintenance');
  });

  it('reports a failed pass and allows the next scheduled pass to run', async () => {
    let callback: () => void = () => assert.fail('scheduler callback was not installed');
    let runs = 0;
    let failures = 0;
    const loop = startSnapshotMaintenanceLoop({
      run: async () => {
        runs += 1;
        if (runs === 1) throw new Error('private path must not be logged');
      },
      onError: () => { failures += 1; },
      schedule: (tick) => {
        callback = tick;
        return () => {};
      },
    });

    callback();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(runs, 1);
    assert.equal(failures, 1);
    callback();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(runs, 2);
    assert.equal(failures, 1);
    await loop.stop();
  });
});
