import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { ok } from '@lwb/contracts';
import type { IpcOutcome } from '@lwb/ipc';
import { TOOL_NAMES, withCommandJobCatalog } from '../../packages/contracts/src/tool-surface-v2.ts';
import { COMMAND_JOB_CONTROL_NAMES } from '../../packages/contracts/src/command-job.ts';
import { createAdapterServer } from '../../apps/mcp-adapter/src/server.ts';
import { resolveSurface } from '../../apps/mcp-adapter/src/surface.ts';
import { createCatalogWatch } from '../../apps/mcp-adapter/src/catalog-watch.ts';

const base = TOOL_NAMES.filter(name => !(COMMAND_JOB_CONTROL_NAMES as readonly string[]).includes(name))
  .map(name => ({ name, available: true, reason: null }));
const catalog = withCommandJobCatalog(base);
async function until(check: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!check()) { if (Date.now() > deadline) throw new Error('test did not settle'); await new Promise(r => setTimeout(r,5)); }
}
const job = {
  job_id: 'job_00000000-0000-0000-0000-000000000001', workspace_id: 'w-test', shell: 'powershell',
  state: 'EXITED', started: true, created_at: '2026-10-14T00:00:00.000Z', updated_at: '2026-10-14T00:00:01.000Z',
  duration_ms: 1, exit_code: 0, timed_out: false, output_truncated: false,
  termination_confirmed: true, recovered: false, cancellation_reason: null, durable: true, failure_reason: null,
  in_progress: false, completion_unknown: false, slot_held: false, side_effects_possible: true,
  output_available: false, output_withheld: false, stdout: '', stderr: '',
};

test('MCP SDK discovers full command tool surface and dispatches status, list and cancel', {timeout:10000}, async () => {
  const calls: string[] = [];
  const server = createAdapterServer({ server_version:'test', log:()=>{}, caller:{
    async call(operation): Promise<IpcOutcome> {
      calls.push(operation);
      const data = operation === 'tools.catalog' ? catalog : operation === 'command_list'
        ? {jobs:[job],next_after_job_id:null,scope:'current_connection',history_bounded:true} : job;
      return {ok:true,result:ok(data,'req_test')} as IpcOutcome;
    },
  } });
  const client = new Client({name:'command-surface-test',version:'1.0.0'});
  let notices = 0;
  client.setNotificationHandler(ToolListChangedNotificationSchema, async () => { notices++; });
  const [clientTransport,serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport); await client.connect(clientTransport);
    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map(tool => tool.name).sort(), [...TOOL_NAMES].sort());
    for (const name of COMMAND_JOB_CONTROL_NAMES) {
      const result = await client.callTool({name,arguments:name === 'command_list' ? {} : {job_id:job.job_id}});
      assert.notEqual(result.isError,true); assert.ok(calls.includes(name));
    }
    const exec = listed.tools.find(tool => tool.name === 'command_exec')!;
    assert.ok(exec.inputSchema.properties && 'wait_ms' in exec.inputSchema.properties);
    await until(() => notices > 0);
    assert.equal(client.getServerCapabilities()?.tools?.listChanged,true);
  } finally { await client.close(); await server.close(); }
});

test('execution without all management tools fails discovery rather than silently publishing a partial surface', () => {
  assert.throws(() => resolveSurface({tools:base}), /任务管理工具缺失/);
  assert.equal(resolveSurface(catalog).tools.length, TOOL_NAMES.length);
  assert.throws(() => resolveSurface({tools:[...catalog.tools,catalog.tools[0]!]}), /重复/);
});

test('shared catalog composition is idempotent and does not invent execution authorization', () => {
  assert.deepEqual(withCommandJobCatalog(catalog.tools),catalog);
  const denied = withCommandJobCatalog(base.map(entry => entry.name === 'command_exec' ? {...entry,available:false,reason:'WORKSPACE_TOOL_NOT_GRANTED'} : entry));
  assert.ok(denied.tools.filter(entry => (COMMAND_JOB_CONTROL_NAMES as readonly string[]).includes(entry.name)).every(entry => !entry.available));
});

test('watcher notifies once on start and changes, and recovers from read failures without advertising an empty catalog', async () => {
  let version = 1; let fail = false; let notices = 0; let reads = 0;
  const watcher = createCatalogWatch({interval_ms:60000,read:async()=>{reads++;if(fail)throw new Error('offline');return {version};},notify:async()=>{notices++;}});
  try {
    watcher.start(); await until(()=>notices===1); await watcher.tick(); assert.equal(notices,1);
    version=2; await watcher.tick(); assert.equal(notices,2);
    fail=true; await watcher.tick(); assert.equal(notices,2);
    fail=false; await watcher.tick(); assert.equal(notices,3);
    watcher.stop(); const before=reads; await watcher.tick(); assert.equal(reads,before);
  } finally { watcher.stop(); }
});

test('stopping a watcher discards an in-flight result and leaves no delayed notification', async () => {
  let finish!: (value: unknown) => void; let started = false; let notices = 0;
  const watcher=createCatalogWatch({interval_ms:60000,read:()=>{started=true;return new Promise(resolve=>{finish=resolve;});},notify:async()=>{notices++;}});
  watcher.start(); await until(()=>started); watcher.stop(); finish(['new-tool']);
  await new Promise(resolve=>setTimeout(resolve,20)); assert.equal(notices,0);
});
