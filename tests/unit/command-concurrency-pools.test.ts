import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ConcurrencyGate } from '@lwb/limits';
import { COMMAND_JOB_LIMITS } from '../../packages/contracts/src/command-job.ts';
import { commandPoolFor, concurrencyForOperation, poolDiagnostics } from '../../apps/daemon/src/tools/concurrency-pools.ts';

const makeGate = () => new ConcurrencyGate({ max_concurrent: 4, max_per_connection: 2, wait_ms: 0 });

describe('independent command and workspace concurrency', () => {
  it('keeps file operations available when eight commands occupy the connection', async () => {
    const files = makeGate();
    const commands = commandPoolFor(files);
    const held = await Promise.all(Array.from({ length: 8 }, () => commands.acquire('a')));
    try {
      assert.ok(held.every((item) => item.ok));
      assert.equal((await commands.acquire('a')).ok, false);
      const read = await concurrencyForOperation('file_read', files).acquire('a');
      assert.ok(read.ok);
      read.lease.release();
      assert.equal(files.snapshot().in_flight, 0);
      assert.equal(commands.snapshot().in_flight, 8);
    } finally {
      for (const item of held) if (item.ok) item.lease.release();
    }
  });

  it('shares one pool per resource class and separates daemon instances', () => {
    const files = makeGate();
    assert.equal(commandPoolFor(files), commandPoolFor(files));
    assert.equal(concurrencyForOperation('command_exec', files), commandPoolFor(files));
    for (const name of ['file_read', 'file_list', 'text_search', 'git_status', 'git_diff', 'change_apply']) {
      assert.equal(concurrencyForOperation(name, files), files);
    }
    assert.notEqual(commandPoolFor(files), commandPoolFor(makeGate()));
  });

  it('admits 32 commands across four connections and rejects the next connection', async () => {
    const pool = commandPoolFor(makeGate());
    const held = await Promise.all(Array.from({ length: 32 }, (_, index) => pool.acquire(`connection-${Math.floor(index / 8)}`)));
    try {
      assert.ok(held.every((item) => item.ok));
      const denied = await pool.acquire('fifth-connection');
      assert.ok(!denied.ok);
      assert.equal(denied.reason, 'GLOBAL_LIMIT_EXCEEDED');
    } finally {
      for (const item of held) if (item.ok) item.lease.release();
    }
  });

  it('uses command limits without widening or inheriting custom file limits', () => {
    const files = new ConcurrencyGate({ max_concurrent: 3, max_per_connection: 1, wait_ms: 17 });
    assert.deepEqual(commandPoolFor(files).limits, {
      max_concurrent: COMMAND_JOB_LIMITS.max_concurrent,
      max_per_connection: COMMAND_JOB_LIMITS.max_per_connection,
      wait_ms: 0,
    });
    assert.deepEqual(commandPoolFor(files).limits, { max_concurrent: 32, max_per_connection: 8, wait_ms: 0 });
    assert.deepEqual(files.limits, { max_concurrent: 3, max_per_connection: 1, wait_ms: 17 });
    const view = poolDiagnostics(files, 'current');
    assert.equal(view.commands.max_per_connection, 8);
    assert.equal(view.commands.max_concurrent, 32);
    assert.equal(view.files.max_per_connection, 1);
    assert.equal(view.files.max_concurrent, 3);
  });

  it('redacts other connection identifiers from diagnostics', async () => {
    const files = makeGate();
    const held = await commandPoolFor(files).acquire('private-connection');
    assert.ok(held.ok);
    try {
      const view = poolDiagnostics(files, 'current');
      assert.equal(view.commands.in_flight, 1);
      assert.equal(view.commands.connection_in_flight, 0);
      assert.ok(!JSON.stringify(view).includes('private-connection'));
    } finally {
      held.lease.release();
    }
  });

  it('returns both pools to zero after repeated releases and exceptions', async () => {
    const files = makeGate();
    for (let index = 0; index < 10000; index += 1) {
      const pool = index % 2 === 0 ? files : commandPoolFor(files);
      const acquired = await pool.acquire('a');
      assert.ok(acquired.ok);
      try { if (index % 3 === 0) throw new Error('test'); } catch {} finally { acquired.lease.release(); }
    }
    assert.equal(files.snapshot().in_flight, 0);
    assert.equal(commandPoolFor(files).snapshot().in_flight, 0);
  });
});
