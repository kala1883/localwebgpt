import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ADAPTER_CONNECTION, OTHER_CONNECTION, GATES_ON, callTool, dataOf, errorOf, makeToolHarness } from '../tools/harness.ts';
import type { ToolHarness } from '../tools/harness.ts';
import { TESTREPO_DIR } from '../fixtures/index.ts';
import { fileIdOf, makeFixtureOps } from '../tools/fixture-ops.ts';
import { TOOL_OUTPUT_SCHEMAS, TOOL_NAMES } from '../../packages/contracts/src/tool-surface-v2.ts';
import type { CommandJobView } from '../../packages/contracts/src/command-job.ts';
import { resolveSurface } from '../../apps/mcp-adapter/src/surface.ts';
import type { ToolCatalogResult } from '../../packages/contracts/src/tool-surface-v2.ts';

const describeWindows = process.platform === 'win32' ? describe : describe.skip;
async function fixture(paused?: () => boolean) {
  return await makeToolHarness({ root: TESTREPO_DIR, root_file_id: fileIdOf(TESTREPO_DIR), ops: makeFixtureOps(), gates: GATES_ON,
    ...(paused === undefined ? {} : { paused }) });
}
async function command(h: ToolHarness, key: string, text = 'Start-Sleep -Seconds 30') {
  const raw = await callTool<CommandJobView>(h, 'command_exec', {
    workspace_id: h.workspace.id, idempotency_key: key, shell: 'powershell', command: text, wait_ms: 0,
  });
  assert.ok(TOOL_OUTPUT_SCHEMAS.command_exec.safeParse(raw).success);
  return dataOf(raw);
}
async function terminal(h: ToolHarness, id: string): Promise<CommandJobView> {
  const end = performance.now() + 10_000;
  while (performance.now() < end) {
    const result = dataOf(await callTool<CommandJobView>(h, 'command_status', { job_id: id }));
    if (!result.in_progress) return result;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Job did not reach a terminal state');
}
async function close(h: ToolHarness) {
  // Only this fixture's owned commands are terminated, before closing its state DB.
  try { await h.deps.command_processes?.terminateAll(); }
  finally { await new Promise((resolve) => setImmediate(resolve)); h.close(); }
}

describeWindows('command jobs: production registration, SQLite, grants and Windows processes', () => {
  it('two long commands leave file reads, status, same-key replay and cancel available', async () => {
    const h = await fixture();
    try {
      const a = await command(h, 'windows-pool-a'); const b = await command(h, 'windows-pool-b');
      const third = await callTool(h, 'command_exec', { workspace_id: h.workspace.id, idempotency_key: 'windows-pool-c', shell: 'powershell', command: 'echo should-not-run', wait_ms: 0 });
      assert.equal(errorOf(third).error.code, 'CONCURRENCY_LIMIT_EXCEEDED');
      const read = await callTool(h, 'file_read', { workspace_id: h.workspace.id, path: 'README.md' }); assert.equal(read.ok, true);
      assert.equal((await command(h, 'windows-pool-a')).job_id, a.job_id);
      const status = await callTool(h, 'bridge_status', {}); assert.ok(TOOL_OUTPUT_SCHEMAS.bridge_status.safeParse(status).success);
      const pool = dataOf(status) as { concurrency: { commands: { in_flight: number }; files: { in_flight: number } } };
      assert.equal(pool.concurrency.commands.in_flight, 2); assert.equal(pool.concurrency.files.in_flight, 0);
      for (const id of [a.job_id,b.job_id]) {
        dataOf(await callTool(h, 'command_cancel', { job_id: id }));
        const end = await terminal(h,id); assert.equal(end.state,'CANCELLED'); assert.equal(end.slot_held,false);
      }
    } finally { await close(h); }
  });
  it('MCP surface has 19 known tools and preserves strict output validation', async () => {
    const h = await fixture();
    try {
      const catalog = dataOf(await callTool<ToolCatalogResult>(h,'tools.catalog',{}));
      const surface = resolveSurface(catalog);
      assert.equal(TOOL_NAMES.length, 19);
      for (const name of ['command_exec', 'command_status', 'command_list', 'command_cancel'] as const) assert.ok(surface.available.includes(name));
      assert.ok(surface.available.every((name) => TOOL_NAMES.includes(name)));
      for (const tool of surface.tools) assert.ok(tool.inputSchema && tool.outputSchema);
      const workspaces = await callTool(h,'workspace_list',{}); assert.ok(TOOL_OUTPUT_SCHEMAS.workspace_list.safeParse(workspaces).success);
      h.grant(ADAPTER_CONNECTION,h.workspace.id,['read']);
      const noCommands = resolveSurface(dataOf(await callTool<ToolCatalogResult>(h,'tools.catalog',{})));
      assert.ok(!noCommands.available.some((name) => name.startsWith('command_')));
    } finally { await close(h); }
  });
  it('metadata is connection-scoped, strict arguments reject PID cancellation', async () => {
    const h = await fixture();
    try {
      const v = await command(h,'windows-owner');
      const other = await callTool(h,'command_status',{job_id:v.job_id},h.contextFor(OTHER_CONNECTION));
      assert.equal(errorOf(other).error.code,'NOT_AUTHORIZED');
      const pid = await callTool(h,'command_cancel',{job_id:v.job_id,pid:1234});
      assert.equal(errorOf(pid).error.code,'INVALID_ARGUMENT');
      const list = await callTool(h,'command_list',{workspace_id:h.workspace.id,max_items:1});
      assert.ok(TOOL_OUTPUT_SCHEMAS.command_list.safeParse(list).success);
      assert.doesNotMatch(JSON.stringify(dataOf(list)),/canonical_root|principal_id|connection_id|stdout.*Start-Sleep/);
    } finally { await close(h); }
  });
  it('pause blocks starts but retains cancellation and metadata paths', async () => {
    let paused = false; const h = await fixture(() => paused);
    try {
      const v = await command(h,'windows-pause'); paused = true;
      const newStart = await callTool(h,'command_exec',{workspace_id:h.workspace.id,idempotency_key:'windows-paused-new',shell:'powershell',command:'echo not-run'});
      assert.equal(errorOf(newStart).error.code,'PAUSED');
      dataOf(await callTool(h,'command_cancel',{job_id:v.job_id}));
      const ended = await terminal(h,v.job_id); assert.equal(ended.state,'CANCELLED');
      const status = await callTool(h,'bridge_status',{}); assert.equal(status.ok,true);
    } finally { await close(h); }
  });
  it('revocation stops the process and prevents cached output access', async () => {
    const h = await fixture();
    try {
      const v = await command(h,'windows-revoke');
      h.grant(ADAPTER_CONNECTION,h.workspace.id,['read']);
      await new Promise((resolve) => setTimeout(resolve, 500));
      const denied = await callTool(h,'command_status',{job_id:v.job_id,include_output:true});
      assert.equal(errorOf(denied).error.code,'WORKSPACE_NOT_GRANTED');
      const read = await callTool(h,'file_read',{workspace_id:h.workspace.id,path:'README.md'}); assert.equal(read.ok,true);
    } finally { await close(h); }
  });
  it('short command output is filtered, charged and auditable', async () => {
    const h = await fixture();
    try {
      const v = await command(h,'windows-output',"Write-Output 'LWB_JOB_OK'"); await terminal(h,v.job_id);
      const raw = await callTool<CommandJobView>(h,'command_status',{job_id:v.job_id,include_output:true},h.adapterContext('req_job_output'));
      assert.ok(TOOL_OUTPUT_SCHEMAS.command_status.safeParse(raw).success);
      assert.match(dataOf(raw).stdout,/LWB_JOB_OK/);
      const audit = h.repos.audit.findByRequestId('req_job_output').at(-1);
      assert.equal(audit?.tool,'command_status'); assert.ok((audit?.bytes_out ?? 0)>0);
      const hidden = await command(h,'windows-secret-output',"Write-Output 'C:\\private\\outside.txt'"); await terminal(h,hidden.job_id);
      const safe = dataOf(await callTool<CommandJobView>(h,'command_status',{job_id:hidden.job_id,include_output:true}));
      assert.equal(safe.output_withheld,true); assert.doesNotMatch(safe.stdout,/C:\\private/);
    } finally { await close(h); }
  });
});
