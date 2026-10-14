import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CommandJobManager } from '../../apps/daemon/src/lifecycle/command-jobs.ts';
import { RepositoryCommandJobStore } from '../../apps/daemon/src/lifecycle/command-job-store.ts';
import type { CommandProcessOptions, CommandProcessResult } from '../../apps/daemon/src/lifecycle/command-processes.ts';
import { bindCommandRecovery, registerCommandRecoveryRoutes } from '../../apps/daemon/src/control/command-recovery.ts';
import { ControlRouteTable } from '../../apps/daemon/src/control/routes.ts';
import type { ControlRouteContext } from '../../apps/daemon/src/control/routes.ts';
import { OperationRegistry, hasCapability } from '@lwb/ipc';
import type { Repositories } from '@lwb/persistence';

const owner = { principal_id: 'p_test', connection_id: 'c_test' };
const access = { owner, cwd: process.cwd(), workspace_generation: 1, connection_generation: 1, still_authorized: () => true };
const input = (key: string) => ({ workspace_id: 'w_test', shell: 'powershell' as const, command: 'test-only', idempotency_key: key, wait_ms: 0 });
const evidence = { source: 'local_operator' as const, basis: 'process_tree_checked' as const, actor: 'console:test-operator' };
async function until(fn: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!fn()) { if (Date.now() > deadline) throw new Error('test did not settle'); await new Promise(r => setTimeout(r, 5)); }
}
// In-memory implementation of the inspected repository contract, with atomic rollback.
// This exercises the production journal adapter, not a real SQLite database.
function database() {
  type Row = { id: string; principal_id: string; tool: string; key: string; request_hash: string; result_ref: string | null; created_at: string; updated_at: string };
  let rows = new Map<string, Row>(); let fail = false;
  const keyOf = (p: string, t: string, k: string) => JSON.stringify([p, t, k]);
  const api = {
    connections: { list: () => [{ id: owner.connection_id, principal_id: owner.principal_id }], findById: () => ({ alias: 'test-connection' }) },
    workspaces: { findById: () => ({ display_name: 'test-workspace' }) },
    idempotency: {
      find(p: string, t: string, k: string) { return rows.get(keyOf(p,t,k)) ?? null; },
      begin(r: Omit<Row, 'result_ref' | 'created_at' | 'updated_at'>) {
        const key = keyOf(r.principal_id,r.tool,r.key); const prior = rows.get(key);
        if (prior) return { kind: prior.request_hash === r.request_hash ? 'replay' : 'conflict', record: prior };
        const row = { ...r, result_ref: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
        rows.set(key,row); return { kind: 'new', record: row };
      },
      complete(p: string,t: string,k: string,value: string) {
        if (fail) throw new Error('injected write failure');
        const row = rows.get(keyOf(p,t,k)); if (!row) throw new Error('missing row'); row.result_ref = value; return row;
      },
    },
    transaction<T>(fn: () => T): T { const previous = structuredClone(rows); try { return fn(); } catch (e) { rows = previous; throw e; } },
  };
  return { repos: api as unknown as Repositories, fail: () => { fail = true; }, rows: () => [...rows.values()] };
}
function harness() {
  const db = database(); const store = new RepositoryCommandJobStore(db.repos);
  const calls: Array<{ options: CommandProcessOptions; finish: (patch?: Partial<CommandProcessResult>) => void }> = [];
  const processes = { run(options: CommandProcessOptions): Promise<CommandProcessResult> {
    options.on_started?.();
    return new Promise(resolve => calls.push({ options, finish: (patch = {}) => resolve({
      started: true, exit_code: null, duration_ms: 2, timed_out: false, output_truncated: false,
      cancelled: false, stdout: 'partial', stderr: '', termination_unknown: true, ...patch,
    }) }));
  } };
  const jobs = new CommandJobManager({ store, processes, sanitize: (stdout,stderr) => ({ stdout,stderr,withheld:false }) });
  return { db, store, calls, jobs, processes };
}
async function unknown(h: ReturnType<typeof harness>, key = 'recovery-test') {
  const job = await h.jobs.start(input(key), access);
  h.calls.at(-1)!.finish();
  await until(() => h.jobs.view(owner, job.job_id).state === 'TERMINATION_UNKNOWN');
  return h.jobs.record(owner, job.job_id);
}

test('local recovery persists evidence, releases once, keeps result unknown and preserves original replay', async () => {
  const h = harness(); const job = await unknown(h);
  const original = h.store.findExecution(owner, 'recovery-test');
  const restored = h.jobs.resolveUnknown(owner, job.job_id, job.updated_at, evidence);
  assert.equal(restored.state, 'RECOVERED_UNKNOWN'); assert.equal(restored.completion_unknown, true);
  assert.equal(restored.slot_held, false); assert.equal(restored.termination_confirmed, false);
  assert.equal(restored.resolution?.source, 'local_operator'); assert.equal(h.jobs.diagnostics(owner.connection_id).in_flight, 0);
  const twice = h.jobs.resolveUnknown(owner, job.job_id, job.updated_at, evidence);
  assert.deepEqual(twice.resolution, restored.resolution);
  assert.equal(h.db.rows().filter(row => row.tool === 'lwb.command_job_recovery.v1').length, 1);
  assert.deepEqual(h.store.findExecution(owner, 'recovery-test'), original);
  assert.equal((await h.jobs.start(input('recovery-test'), access)).state, 'RECOVERED_UNKNOWN');
  assert.equal(h.calls.length, 1);
  const restarted = new CommandJobManager({ store: h.store, processes: h.processes, sanitize: (stdout,stderr) => ({stdout,stderr,withheld:false}) });
  assert.equal(restarted.diagnostics(owner.connection_id).in_flight, 0);
  assert.equal(restarted.view(owner, job.job_id).completion_unknown, true);
});

test('recovered-after-restart slots can be reconciled without rerunning the original job', async () => {
  const h = harness(); const old = await unknown(h);
  const restarted = new CommandJobManager({ store: h.store, processes: h.processes, sanitize: (stdout,stderr) => ({stdout,stderr,withheld:false}) });
  const current = restarted.record(owner, old.job_id);
  assert.equal(restarted.diagnostics(owner.connection_id).quarantined, 1);
  restarted.resolveUnknown(owner, current.job_id, current.updated_at, evidence);
  assert.equal(restarted.diagnostics(owner.connection_id).quarantined, 0);
  assert.equal((await restarted.start(input('recovery-test'), access)).slot_held, false);
  assert.equal(h.calls.length, 1);
});

test('recovery rejects running jobs, stale records, cross-connection owners and forged evidence', async () => {
  const h = harness(); const live = await h.jobs.start(input('live'), access);
  assert.throws(() => h.jobs.resolveUnknown(owner, live.job_id, live.updated_at, evidence), {code:'IDEMPOTENCY_CONFLICT'});
  h.calls[0]!.finish(); await until(() => h.jobs.view(owner,live.job_id).completion_unknown);
  const job = h.jobs.record(owner, live.job_id);
  assert.throws(() => h.jobs.resolveUnknown(owner, job.job_id, 'stale', evidence), {code:'IDEMPOTENCY_CONFLICT'});
  assert.throws(() => h.jobs.resolveUnknown({...owner,connection_id:'other'}, job.job_id, job.updated_at, evidence), {code:'NOT_AUTHORIZED'});
  assert.throws(() => h.jobs.resolveUnknown(owner, job.job_id, job.updated_at, {...evidence,actor:'model'}), {code:'INVALID_ARGUMENT'});
  assert.equal(h.jobs.diagnostics(owner.connection_id).in_flight, 1);
});

test('journal failure atomically rolls back evidence and keeps the occupied slot', async () => {
  const h = harness(); const job = await unknown(h); h.db.fail();
  assert.throws(() => h.jobs.resolveUnknown(owner, job.job_id, job.updated_at, evidence), {code:'STORAGE_UNAVAILABLE'});
  assert.equal(h.jobs.view(owner,job.job_id).state, 'TERMINATION_UNKNOWN');
  assert.equal(h.jobs.diagnostics(owner.connection_id).in_flight, 1);
  assert.equal(h.store.get(owner,job.job_id)?.resolution, undefined);
  assert.equal(h.db.rows().filter(row => row.tool === 'lwb.command_job_recovery.v1').length, 0);
});

test('late driver confirmation recovers an unknown task once and does not fabricate business success', async () => {
  const h = harness(); const job = await unknown(h);
  h.calls[0]!.options.on_termination_confirmed?.();
  const resolved = h.jobs.view(owner, job.job_id);
  assert.equal(resolved.state, 'RECOVERED_UNKNOWN'); assert.equal(resolved.completion_unknown, true);
  assert.equal(resolved.termination_confirmed, true); assert.equal(resolved.resolution?.source, 'process_observation');
  h.calls[0]!.options.on_termination_confirmed?.();
  assert.equal(h.jobs.diagnostics(owner.connection_id).in_flight, 0);
  assert.equal(h.db.rows().filter(row => row.tool === 'lwb.command_job_recovery.v1').length, 1);
});

test('confirmation racing driver settlement is not lost', async () => {
  const h = harness(); const job = await h.jobs.start(input('race'), access);
  h.calls[0]!.options.on_termination_confirmed?.(); h.calls[0]!.finish();
  await until(() => h.jobs.view(owner,job.job_id).state === 'RECOVERED_UNKNOWN');
  assert.equal(h.jobs.diagnostics(owner.connection_id).in_flight, 0);
});

test('late callback after operator recovery neither overwrites evidence nor double releases', async () => {
  const h = harness(); const job = await unknown(h);
  const resolved = h.jobs.resolveUnknown(owner,job.job_id,job.updated_at,evidence);
  h.calls[0]!.options.on_termination_confirmed?.();
  assert.deepEqual(h.jobs.view(owner,job.job_id).resolution, resolved.resolution);
  assert.equal(h.jobs.diagnostics(owner.connection_id).in_flight, 0);
});

test('local recovery routes use privileged capabilities and require exact operator confirmation', async () => {
  const h = harness(); const job = await unknown(h);
  const registry = new OperationRegistry(); bindCommandRecovery(registry,h.jobs,h.db.repos);
  const table = new ControlRouteTable(); registerCommandRecoveryRoutes(table,registry);
  const route = table.lookup('POST','/api/commands/recover')!;
  assert.equal(route.mutating,true); assert.equal(hasCapability('mcp-adapter',route.capability!),false);
  const body = {job_id:job.job_id,expected_updated_at:job.updated_at,confirmation_job_id:job.job_id,verified_all_processes_stopped:true,basis:'process_tree_checked'};
  const context = (value: unknown) => ({session:{session_id:'verified-session'},operation:'/api/commands/recover',body:value,request_id:'req-test'}) as ControlRouteContext;
  for (const invalid of [{...body,verified_all_processes_stopped:false},{...body,confirmation_job_id:'job_00000000-0000-0000-0000-000000000000'},{...body,force:true},{...body,actor:'console:forged'}]) {
    assert.throws(() => route.handler(context(invalid)), {code:'INVALID_ARGUMENT'});
  }
  assert.equal(h.jobs.diagnostics(owner.connection_id).in_flight,1);
  await route.handler(context(body));
  assert.equal(h.jobs.diagnostics(owner.connection_id).in_flight,0);
  const ledger = h.db.rows().find(row => row.tool === 'lwb.command_job_recovery.v1')!;
  assert.equal(JSON.parse(ledger.result_ref!).actor,'console:verified-session');
  assert.deepEqual(registry.names(),[]); // No model-callable or IPC control operation was registered.
});

test('local recovery registry bindings do not leak across daemon instances', () => {
  const h = harness(); const first = new OperationRegistry(); const other = new OperationRegistry();
  bindCommandRecovery(first,h.jobs,h.db.repos);
  const table = new ControlRouteTable(); registerCommandRecoveryRoutes(table,other);
  assert.equal(table.keys().length,0);
  assert.throws(() => bindCommandRecovery(first,h.jobs,h.db.repos));
});
