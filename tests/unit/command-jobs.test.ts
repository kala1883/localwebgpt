import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CommandProcessManager } from '../../apps/daemon/src/lifecycle/command-processes.ts';
import type { CommandProcessOptions, CommandProcessResult } from '../../apps/daemon/src/lifecycle/command-processes.ts';
import { CommandJobManager } from '../../apps/daemon/src/lifecycle/command-jobs.ts';
import type { CommandJobAccess } from '../../apps/daemon/src/lifecycle/command-jobs.ts';
import type { CommandJobStore, ExecutionReference } from '../../apps/daemon/src/lifecycle/command-job-store.ts';
import { RepositoryCommandJobStore } from '../../apps/daemon/src/lifecycle/command-job-store.ts';
import type { CommandJobOwner, CommandJobRecord, CommandJobStartInput } from '../../packages/contracts/src/command-job.ts';
import { ConcurrencyGate } from '@lwb/limits';
import type { Repositories } from '@lwb/persistence';

const owner = { principal_id: 'principal_test', connection_id: 'connection_test' };
const copy = <T>(value: T): T => structuredClone(value);
class MemoryStore implements CommandJobStore {
  readonly refs = new Map<string, ExecutionReference>();
  readonly records = new Map<string, CommandJobRecord>();
  failClaim = false;
  failSave = false;
  findExecution(o: CommandJobOwner, key: string) { return this.refs.get(JSON.stringify([o.principal_id, key])) ?? null; }
  claim(o: CommandJobOwner, key: string, hash: string, record: CommandJobRecord) {
    if (this.failClaim) throw new Error('injected journal failure');
    const previous = this.findExecution(o, key);
    if (previous !== null) return previous;
    this.refs.set(JSON.stringify([o.principal_id, key]), { request_hash: hash, job_id: record.job_id });
    this.records.set(record.job_id, copy(record));
    return null;
  }
  get(o: CommandJobOwner, id: string) {
    const r = this.records.get(id);
    return r !== undefined && r.owner.principal_id === o.principal_id && r.owner.connection_id === o.connection_id ? copy(r) : null;
  }
  save(r: CommandJobRecord) { if (this.failSave) throw new Error('injected save failure'); this.records.set(r.job_id, copy(r)); }
  list(o: CommandJobOwner) { return [...this.records.values()].filter((r) => r.owner.principal_id === o.principal_id && r.owner.connection_id === o.connection_id).map(copy); }
  all() { return [...this.records.values()].map(copy); }
}
const access = (o = owner, check = () => true): CommandJobAccess => ({
  owner: o, cwd: process.cwd(), workspace_generation: 1, connection_generation: 1, still_authorized: check,
});
const sanitize = (stdout: string, stderr: string) => ({ stdout, stderr, withheld: false });
const input = (key: string, command = 'test'): CommandJobStartInput => ({
  workspace_id: 'workspace_test', idempotency_key: key, shell: process.platform === 'win32' ? 'powershell' : 'bash', command, wait_ms: 0,
});
const result = (patch: Partial<CommandProcessResult> = {}): CommandProcessResult => ({
  started: true, exit_code: 0, duration_ms: 1, timed_out: false,
  output_truncated: false, cancelled: false, stdout: 'marker', stderr: '', ...patch,
});
function controlled() {
  const calls: Array<{ options: CommandProcessOptions; finish: (r?: Partial<CommandProcessResult>) => void }> = [];
  return {
    calls,
    processes: { run(options: CommandProcessOptions): Promise<CommandProcessResult> {
      options.on_started?.();
      return new Promise((resolve) => calls.push({ options, finish: (r = {}) => resolve(result(r)) }));
    } },
  };
}
async function until(predicate: () => boolean, ms = 5_000): Promise<void> {
  const deadline = performance.now() + ms;
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error('test condition did not settle');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
function nodeCommand(code: string): string {
  const quote = (s: string) => process.platform === 'win32' ? `'${s.replaceAll("'", "''")}'` : `'${s.replaceAll("'", "'\\''")}'`;
  return `${process.platform === 'win32' ? '& ' : 'exec '}${quote(process.execPath)} -e ${quote(code)}`;
}

test('100000 leases and exception paths return to zero; diagnostics are connection scoped', async () => {
  const gate = new ConcurrencyGate({ wait_ms: 0 });
  for (let i = 0; i < 100_000; i++) {
    const taken = await gate.acquire('a'); assert.ok(taken.ok);
    try { if (i % 100 === 0) throw new Error('expected'); } catch { /* exercise finally */ }
    finally { taken.lease.release(); }
  }
  assert.equal(gate.snapshot().in_flight, 0);
  const b = await gate.acquire('other'); assert.ok(b.ok);
  assert.equal(gate.inspect('a').active.length, 0);
  assert.equal(gate.inspect('a').global_in_flight, 1);
  b.lease.release(); assert.throws(() => b.lease.release());
});

test('two running jobs do not block files; replay works while full; third new job is rejected', async () => {
  const driver = controlled();
  const jobs = new CommandJobManager({ store: new MemoryStore(), processes: driver.processes, sanitize, max_per_connection: 2 });
  const a = await jobs.start(input('capacity-a'), access());
  const b = await jobs.start(input('capacity-b'), access());
  await assert.rejects(jobs.start(input('capacity-c'), access()), { code: 'CONCURRENCY_LIMIT_EXCEEDED' });
  const files = new ConcurrencyGate({ wait_ms: 0 });
  const lease = await files.acquire(owner.connection_id); assert.ok(lease.ok); lease.lease.release();
  assert.equal((await jobs.start(input('capacity-a'), access())).job_id, a.job_id);
  assert.equal(driver.calls.length, 2);
  driver.calls.forEach((call) => call.finish());
  await until(() => jobs.diagnostics(owner.connection_id).in_flight === 0);
  assert.equal(jobs.view(owner, b.job_id).state, 'EXITED');
});

test('default command capacity allows eight jobs, preserves replay, and reuses released slots', async () => {
  const driver = controlled();
  const jobs = new CommandJobManager({ store: new MemoryStore(), processes: driver.processes, sanitize });
  assert.equal(jobs.diagnostics(owner.connection_id).max_per_connection, 8);
  assert.equal(jobs.diagnostics(owner.connection_id).max_concurrent, 32);
  try {
    const running = await Promise.all(Array.from({ length: 8 }, (_, index) => jobs.start(input(`default-${index}`), access())));
    assert.equal(driver.calls.length, 8);
    assert.equal(jobs.diagnostics(owner.connection_id).in_flight, 8);
    await assert.rejects(jobs.start(input('default-overflow'), access()), { code: 'CONCURRENCY_LIMIT_EXCEEDED' });
    assert.equal((await jobs.start(input('default-0'), access())).job_id, running[0]!.job_id);
    assert.equal(driver.calls.length, 8);
    driver.calls[0]!.finish();
    await until(() => jobs.diagnostics(owner.connection_id).in_flight === 7);
    assert.equal((await jobs.start(input('default-replacement'), access())).state, 'RUNNING');
    assert.equal(jobs.diagnostics(owner.connection_id).in_flight, 8);
    assert.equal(driver.calls.length, 9);
  } finally {
    driver.calls.forEach((call) => call.finish());
    await until(() => jobs.diagnostics(owner.connection_id).in_flight === 0);
  }
});

test('expanded defaults retain two recovered slots while admitting six new jobs', async () => {
  const store = new MemoryStore();
  const driver = controlled();
  const original = new CommandJobManager({ store, processes: driver.processes, sanitize });
  const previous = await Promise.all(Array.from({ length: 2 }, (_, index) => original.start(input(`expanded-old-${index}`), access())));
  const recovered = new CommandJobManager({ store, processes: driver.processes, sanitize });
  try {
    assert.equal(recovered.diagnostics(owner.connection_id).quarantined, 2);
    assert.equal(recovered.diagnostics(owner.connection_id).in_flight, 2);
    for (let index = 0; index < 6; index++) {
      await recovered.start(input(`expanded-new-${index}`), access());
    }
    assert.equal(recovered.diagnostics(owner.connection_id).in_flight, 8);
    await assert.rejects(recovered.start(input('expanded-overflow'), access()), { code: 'CONCURRENCY_LIMIT_EXCEEDED' });
    const replay = await recovered.start(input('expanded-old-0'), access());
    assert.equal(replay.job_id, previous[0]!.job_id);
    assert.equal(replay.state, 'TERMINATION_UNKNOWN');
    assert.equal(replay.slot_held, true);
    assert.equal(recovered.diagnostics(owner.connection_id).quarantined, 2);
    assert.equal(driver.calls.length, 8);
  } finally {
    driver.calls.forEach((call) => call.finish());
    await until(() => original.diagnostics(owner.connection_id).in_flight === 0 &&
      recovered.diagnostics(owner.connection_id).in_flight === 2);
  }
});

test('concurrent same-key calls launch once, including a single-slot pool', async () => {
  const driver = controlled();
  const jobs = new CommandJobManager({ store: new MemoryStore(), processes: driver.processes, sanitize, max_per_connection: 1 });
  const views = await Promise.all(Array.from({ length: 16 }, () => jobs.start(input('same-key'), access())));
  assert.equal(new Set(views.map((v) => v.job_id)).size, 1); assert.equal(driver.calls.length, 1);
  await assert.rejects(jobs.start(input('same-key', 'different'), access()), { code: 'IDEMPOTENCY_CONFLICT' });
  driver.calls[0]!.finish(); await until(() => jobs.diagnostics(owner.connection_id).in_flight === 0);
});

test('same principal on another connection cannot read, cancel or replay a job', async () => {
  const driver = controlled(); const jobs = new CommandJobManager({ store: new MemoryStore(), processes: driver.processes, sanitize });
  const a = await jobs.start(input('owner-test'), access());
  const other = { ...owner, connection_id: 'other' };
  assert.throws(() => jobs.view(other, a.job_id), { code: 'NOT_AUTHORIZED' });
  assert.throws(() => jobs.cancel(other, a.job_id), { code: 'NOT_AUTHORIZED' });
  await assert.rejects(jobs.start(input('owner-test'), access(other)), { code: 'NOT_AUTHORIZED' });
  assert.deepEqual(jobs.list(other), []);
  assert.equal(jobs.diagnostics(other.connection_id).active.length, 0);
  driver.calls[0]!.finish(); await until(() => jobs.diagnostics(owner.connection_id).in_flight === 0);
});

test('global and per-connection limits both hold', async () => {
  const driver = controlled(); const jobs = new CommandJobManager({ store: new MemoryStore(), processes: driver.processes, sanitize, max_concurrent: 3, max_per_connection: 2 });
  await jobs.start(input('global-a'), access()); await jobs.start(input('global-b'), access());
  const other = { principal_id: 'p2', connection_id: 'c2' };
  await jobs.start(input('global-c'), access(other));
  await assert.rejects(jobs.start(input('global-d'), access(other)), { code: 'CONCURRENCY_LIMIT_EXCEEDED' });
  driver.calls.forEach((call) => call.finish()); await until(() => jobs.diagnostics(owner.connection_id).global_in_flight === 0);
});

test('bounded request wait returns RUNNING and does not cancel process', async () => {
  const driver = controlled(); const jobs = new CommandJobManager({ store: new MemoryStore(), processes: driver.processes, sanitize });
  const start = performance.now();
  const v = await jobs.start({ ...input('wait-budget'), wait_ms: 30 }, access());
  assert.equal(v.state, 'RUNNING'); assert.ok(performance.now() - start < 1_000);
  assert.equal(driver.calls[0]!.options.signal?.aborted, false);
  assert.equal(jobs.view({ ...owner }, v.job_id).state, 'RUNNING');
  driver.calls[0]!.finish(); await until(() => jobs.diagnostics(owner.connection_id).in_flight === 0);
});

test('repeated cancellation and natural exit release only one slot', async () => {
  const driver = controlled(); const jobs = new CommandJobManager({ store: new MemoryStore(), processes: driver.processes, sanitize });
  for (let i = 0; i < 30; i++) {
    const v = await jobs.start(input(`cancel-${i}`), access());
    jobs.cancel(owner, v.job_id); jobs.cancel(owner, v.job_id);
    assert.equal(driver.calls[i]!.options.signal?.aborted, true);
    driver.calls[i]!.finish({ cancelled: true, exit_code: null });
    await until(() => jobs.view(owner, v.job_id).state === 'CANCELLED');
    assert.equal(jobs.diagnostics(owner.connection_id).in_flight, 0);
  }
});

test('authorization revocation cancels and discards output', async () => {
  let allowed = true; const driver = controlled();
  const jobs = new CommandJobManager({ store: new MemoryStore(), processes: driver.processes, sanitize });
  const v = await jobs.start(input('revoked'), access(owner, () => allowed)); allowed = false;
  await until(() => driver.calls[0]!.options.signal?.aborted === true);
  driver.calls[0]!.finish({ cancelled: true, stdout: 'must not return' });
  await until(() => jobs.view(owner, v.job_id).state === 'CANCELLED');
  const ended = jobs.view(owner, v.job_id, true);
  assert.equal(ended.stdout, ''); assert.equal(ended.output_withheld, true);
});

test('recovery quarantines unknown jobs; no relaunch or false slot release', async () => {
  const store = new MemoryStore(); const driver = controlled();
  const jobs = new CommandJobManager({ store, processes: driver.processes, sanitize });
  const v = await jobs.start(input('recovery'), access());
  const recovered = new CommandJobManager({ store, processes: driver.processes, sanitize, max_per_connection: 1 });
  const replay = await recovered.start(input('recovery'), access());
  assert.equal(replay.job_id, v.job_id); assert.equal(replay.state, 'TERMINATION_UNKNOWN');
  assert.equal(replay.recovered, true); assert.equal(replay.output_available, false);
  assert.equal(recovered.cancel(owner, v.job_id).slot_held, true);
  await assert.rejects(recovered.start(input('recovery-new'), access()), { code: 'CONCURRENCY_LIMIT_EXCEEDED' });
  assert.equal(driver.calls.length, 1);
  driver.calls[0]!.finish(); await until(() => jobs.diagnostics(owner.connection_id).in_flight === 0);
});

test('legacy idempotency rows never start a second process', async () => {
  const store = new MemoryStore(); const driver = controlled();
  const jobs = new CommandJobManager({ store, processes: driver.processes, sanitize });
  const v = await jobs.start(input('old-row'), access());
  const ref = store.findExecution(owner, 'old-row')!;
  store.refs.set(JSON.stringify([owner.principal_id, 'old-row']), { ...ref, job_id: null });
  await assert.rejects(jobs.start(input('old-row'), access()), { code: 'COMMAND_REPLAY_SUPPRESSED' });
  assert.equal(driver.calls.length, 1); driver.calls[0]!.finish();
  await until(() => jobs.view(owner, v.job_id).state === 'EXITED');
});

test('retention caps memory output, but same-key metadata remains stable', async () => {
  let now = Date.now(); const store = new MemoryStore(); let starts = 0;
  const jobs = new CommandJobManager({ store, sanitize, now: () => now, output_retention_ms: 20, max_retained_jobs: 1,
    processes: { async run(o) { starts++; o.on_started?.(); return result(); } } });
  const first = await jobs.start({ ...input('retain-a'), wait_ms: 50 }, access());
  assert.equal(first.stdout, 'marker'); now += 30;
  assert.equal(jobs.view(owner, first.job_id, true).output_available, false);
  await jobs.start({ ...input('retain-b'), wait_ms: 50 }, access());
  const replay = await jobs.start(input('retain-a'), access());
  assert.equal(replay.job_id, first.job_id); assert.equal(replay.output_available, false); assert.equal(starts, 2);
});

test('claim failure happens before spawn and releases lease', async () => {
  const store = new MemoryStore(); store.failClaim = true; const driver = controlled();
  const jobs = new CommandJobManager({ store, processes: driver.processes, sanitize });
  await assert.rejects(jobs.start(input('claim-fail'), access()), { code: 'STORAGE_UNAVAILABLE' });
  assert.equal(driver.calls.length, 0); assert.equal(jobs.diagnostics(owner.connection_id).in_flight, 0);
});

test('post-spawn journal failure requests abort, exposes fault and rejects new starts', async () => {
  const store = new MemoryStore(); const driver = controlled(); const jobs = new CommandJobManager({ store, processes: driver.processes, sanitize });
  const v = await jobs.start(input('journal-fail'), access()); store.failSave = true;
  jobs.cancel(owner, v.job_id); driver.calls[0]!.finish({ cancelled: true });
  await until(() => !jobs.view(owner, v.job_id).in_progress);
  assert.equal(jobs.view(owner, v.job_id).durable, false);
  assert.equal(jobs.diagnostics(owner.connection_id).storage_fault, true);
  await assert.rejects(jobs.start(input('journal-next'), access()), { code: 'STORAGE_UNAVAILABLE' });
});

test('unknown driver result quarantines instead of zeroing occupied slot', async () => {
  const jobs = new CommandJobManager({ store: new MemoryStore(), sanitize,
    processes: { async run() { throw new Error('driver result lost'); } }, max_per_connection: 1 });
  const v = await jobs.start({ ...input('unknown'), wait_ms: 20 }, access());
  assert.equal(v.state, 'TERMINATION_UNKNOWN'); assert.equal(v.slot_held, true);
  assert.equal(jobs.diagnostics(owner.connection_id).quarantined, 1);
  await assert.rejects(jobs.start(input('unknown-next'), access()), { code: 'CONCURRENCY_LIMIT_EXCEEDED' });
});

test('100 actual short commands finish without cumulative occupancy', { timeout: 120_000 }, async () => {
  const processes = new CommandProcessManager(); const jobs = new CommandJobManager({ store: new MemoryStore(), processes, sanitize });
  try {
    for (let i = 0; i < 100; i++) {
      const v = await jobs.start({ ...input(`real-${i}`, nodeCommand("process.stdout.write('OK')")), wait_ms: 5_000 }, access());
      await until(() => !jobs.view(owner, v.job_id).in_progress);
      const end = jobs.view(owner, v.job_id, true);
      assert.equal(end.state, 'EXITED'); assert.equal(end.stdout, 'OK');
      assert.equal(jobs.diagnostics(owner.connection_id).in_flight, 0);
    }
  } finally { await processes.terminateAll(); }
});

test('actual long process cancellation finishes and frees its command slot', { timeout: 15_000 }, async () => {
  const processes = new CommandProcessManager(); const jobs = new CommandJobManager({ store: new MemoryStore(), processes, sanitize });
  try {
    const v = await jobs.start(input('real-cancel', nodeCommand('setInterval(()=>{},1000)')), access());
    await until(() => jobs.view(owner, v.job_id).started === true);
    jobs.cancel(owner, v.job_id);
    await until(() => !jobs.view(owner, v.job_id).in_progress, 8_000);
    assert.equal(jobs.view(owner, v.job_id).state, 'CANCELLED');
    assert.equal(jobs.diagnostics(owner.connection_id).in_flight, 0);
  } finally { await processes.terminateAll(); }
});

test('pre-aborted process never spawns; unavailable shell does not leak slots', async () => {
  const manager = new CommandProcessManager(); const abort = new AbortController(); abort.abort();
  const v = await manager.run({ shell: input('x').shell, command: nodeCommand('process.exit(99)'), cwd: process.cwd(), signal: abort.signal });
  assert.equal(v.started, false); assert.equal(v.cancelled, true);
  const invalid = await manager.run({ shell: input('x').shell, command: 'echo ignored', cwd: 'lwb-does-not-exist-test-root' });
  assert.equal(invalid.started, false); await manager.terminateAll();
});

test('output cap terminates actual process and returns bounded output', { timeout: 15_000 }, async () => {
  const processes = new CommandProcessManager({ output_limit_bytes: 128 });
  try {
    const r = await processes.run({ shell: input('x').shell, cwd: process.cwd(), command: nodeCommand("process.stdout.write('x'.repeat(100000));setInterval(()=>{},1000)") });
    assert.equal(r.output_truncated, true); assert.ok(Buffer.byteLength(r.stdout) <= 128);
    assert.equal(r.termination_unknown, false);
  } finally { await processes.terminateAll(); }
});

test('unconfirmed termination has a bounded return, not a fictitious success', { skip: process.platform === 'win32', timeout: 5_000 }, async () => {
  let pid: number | undefined;
  const manager = new CommandProcessManager({ termination_wait_ms: 50, terminate_tree: async (child) => { pid = child.pid; return await new Promise<boolean>(() => {}); } });
  const abort = new AbortController();
  try {
    const pending = manager.run({ shell: input('x').shell, cwd: process.cwd(), command: nodeCommand('setInterval(()=>{},1000)'), signal: abort.signal, on_started: () => abort.abort() });
    const r = await pending; assert.equal(r.termination_unknown, true); assert.equal(r.cancelled, true);
    await assert.rejects(manager.terminateAll());
  } finally {
    // Only the exact child created by this test is stopped. No global process matching.
    if (pid !== undefined) { try { process.kill(process.platform === 'win32' ? pid : -pid, 'SIGKILL'); } catch { /* already exited */ } }
  }
});

test('inherited output pipes after parent exit are bounded and diagnosed', { skip: process.platform === 'win32', timeout: 8_000 }, async () => {
  const processes = new CommandProcessManager({ drain_wait_ms: 50, termination_wait_ms: 100 });
  let descendant: number | undefined;
  try {
    const r = await processes.run({ shell: 'bash', cwd: process.cwd(), command: 'sleep 10 & echo $!; exit 0' });
    descendant = Number(r.stdout.trim());
    assert.equal(r.orphaned_output, true); assert.equal(r.termination_unknown, true); assert.ok(r.duration_ms < 5_000);
    await assert.rejects(processes.terminateAll());
  } finally { if (descendant !== undefined && Number.isInteger(descendant) && descendant > 0) { try { process.kill(descendant, 'SIGKILL'); } catch {} } }
});

// Exercise the real journal adapter, including rollback and legacy records. This
// fake implements the inspected repository contract; it is not a SQLite test.
function fakeRepositories() {
  type Row = { id: string; principal_id: string; tool: string; key: string; request_hash: string; result_ref: string | null; created_at: string; updated_at: string };
  let rows = new Map<string, Row>(); let failComplete = false;
  const keyOf = (p: string, t: string, k: string) => JSON.stringify([p,t,k]);
  const api = {
    connections: { list: () => [{ id: owner.connection_id, principal_id: owner.principal_id }] },
    idempotency: {
      find(p: string, t: string, k: string) { return rows.get(keyOf(p,t,k)) ?? null; },
      begin(r: Omit<Row, 'result_ref' | 'created_at' | 'updated_at'>) {
        const key = keyOf(r.principal_id,r.tool,r.key); const prior = rows.get(key);
        if (prior) return { kind: prior.request_hash === r.request_hash ? 'replay' : 'conflict', record: prior };
        const row = { ...r, result_ref: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
        rows.set(key,row); return { kind: 'new', record: row };
      },
      complete(p: string,t: string,k: string,value: string) {
        if (failComplete) throw new Error('injected transaction failure');
        const row = rows.get(keyOf(p,t,k)); if (!row) throw new Error('missing row'); row.result_ref = value; return row;
      },
    },
    transaction<T>(fn: () => T): T { const previous = copy(rows); try { return fn(); } catch (e) { rows = previous; throw e; } },
  };
  return { repos: api as unknown as Repositories, rows: () => rows, fail: () => { failComplete = true; } };
}

test('real store adapter persists projected metadata, not command or output', async () => {
  const db = fakeRepositories(); const store = new RepositoryCommandJobStore(db.repos); const driver = controlled();
  const jobs = new CommandJobManager({ store, processes: driver.processes, sanitize });
  const v = await jobs.start(input('storage-projection', 'COMMAND_MUST_NOT_BE_PERSISTED'), access());
  const record = jobs.record(owner,v.job_id);
  store.save(Object.assign(record, { stdout: 'RAW_OUTPUT_MUST_NOT_BE_PERSISTED', command: 'COMMAND_MUST_NOT_BE_PERSISTED' }));
  const serialized = JSON.stringify([...db.rows().values()]);
  assert.doesNotMatch(serialized,/RAW_OUTPUT_MUST_NOT_BE_PERSISTED|COMMAND_MUST_NOT_BE_PERSISTED/);
  assert.equal(store.list(owner).length,1); assert.equal(store.all().length,1);
  assert.equal(store.get({ ...owner, connection_id: 'other' },v.job_id),null);
  driver.calls[0]!.finish(); await until(() => jobs.view(owner,v.job_id).state === 'EXITED');
});

test('journal creation rolls back atomically before any process starts', async () => {
  const db = fakeRepositories(); const store = new RepositoryCommandJobStore(db.repos); const driver = controlled();
  const jobs = new CommandJobManager({ store, processes: driver.processes, sanitize }); db.fail();
  await assert.rejects(jobs.start(input('atomic-failure'),access()),{ code: 'STORAGE_UNAVAILABLE' });
  assert.equal(db.rows().size,0); assert.equal(driver.calls.length,0); assert.equal(jobs.diagnostics(owner.connection_id).in_flight,0);
});

test('corrupt startup journal blocks only command starts, not diagnostics construction', async () => {
  const store = new MemoryStore(); store.all = () => { throw new Error('corrupt journal'); };
  const driver = controlled(); const jobs = new CommandJobManager({ store, processes: driver.processes, sanitize });
  assert.equal(jobs.diagnostics(owner.connection_id).storage_fault, true);
  await assert.rejects(jobs.start(input('bad-journal'), access()), { code: 'STORAGE_UNAVAILABLE' });
  assert.equal(driver.calls.length, 0);
});
