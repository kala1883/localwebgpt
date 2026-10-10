import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import type { CommandJobView as CommandExecData } from '../../packages/contracts/src/command-job.ts';
import { ADAPTER_CONNECTION, GATES_ON, callTool, dataOf, errorOf, makeToolHarness } from '../tools/harness.ts';
import { TESTREPO_DIR } from '../fixtures/index.ts';
import { fileIdOf, makeFixtureOps } from '../tools/fixture-ops.ts';

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function makeFixtureToolHarness(options: { readonly paused?: () => boolean; readonly root?: string } = {}) {
  const root = options.root ?? TESTREPO_DIR;
  return await makeToolHarness({
    root,
    root_file_id: fileIdOf(root),
    ops: makeFixtureOps(),
    gates: GATES_ON,
    ...(options.paused === undefined ? {} : { paused: options.paused }),
  });
}

async function closeFixture(harness: Awaited<ReturnType<typeof makeFixtureToolHarness>>): Promise<void> {
  try { await harness.deps.command_processes?.terminateAll(); }
  finally { await pause(0); harness.close(); }
}

(process.platform === 'win32' ? describe : describe.skip)('command_exec MCP tool', () => {
  it('runs PowerShell from the granted directory using only command_exec grant', async () => {
    const harness = await makeFixtureToolHarness();
    try {
      harness.grant(ADAPTER_CONNECTION, harness.workspace.id, ['command_exec']);
      const catalog = dataOf<{ readonly tools: readonly { readonly name: string; readonly available: boolean }[] }>(
        await callTool(harness, 'tools.catalog', {}),
      );
      const available = catalog.tools.filter((tool) => tool.available).map((tool) => tool.name);
      assert.ok(available.includes('command_exec'));
      assert.ok(!available.includes('file_read'));

      const result = dataOf<CommandExecData>(await callTool(harness, 'command_exec', {
        workspace_id: harness.workspace.id,
        idempotency_key: 'idem-command-run-test-0001',
        wait_ms: 5_000,
        shell: 'powershell',
        command: "if (Test-Path 'README.md') { Write-Output 'LWB_COMMAND_TOOL_OK' } else { exit 8 }",
      }));
      assert.equal(result.exit_code, 0);
      assert.match(result.stdout, /LWB_COMMAND_TOOL_OK/);
      assert.equal(result.output_withheld, false);
      assert.doesNotMatch(JSON.stringify(result), /[A-Za-z]:\\/);
      const audit = harness.repos.audit.findByRequestId('req_1').at(-1);
      assert.deepEqual(audit?.file_access, [
        { path: '', start_line: null, end_line: null, delivered: true },
      ], 'audit records the workspace root as the command execution scope, not an invented file list');
    } finally {
      await closeFixture(harness);
    }
  });

  it('withholds output containing an absolute local path', async () => {
    const harness = await makeFixtureToolHarness();
    try {
      const result = dataOf<CommandExecData>(await callTool(harness, 'command_exec', {
        workspace_id: harness.workspace.id,
        idempotency_key: 'idem-command-filter-test-0001',
        wait_ms: 5_000,
        shell: 'powershell',
        command: "Write-Output 'C:\\private\\outside.txt'; Write-Output '/home/mj/private.txt'; Write-Output 'file:///home/mj/private.txt'",
      }));
      assert.equal(result.exit_code, 0);
      assert.equal(result.output_withheld, true);
      assert.doesNotMatch(JSON.stringify(result), /C:\\private/);
      assert.doesNotMatch(JSON.stringify(result), /\/home\/mj/);
      assert.doesNotMatch(JSON.stringify(result), /file:\/\/\/home\/mj/);
    } finally {
      await closeFixture(harness);
    }
  });

  it('stops the in-flight command when its workspace grant is revoked', async () => {
    const harness = await makeFixtureToolHarness();
    try {
      const running = callTool(harness, 'command_exec', {
        workspace_id: harness.workspace.id,
        idempotency_key: 'idem-command-revoked-test-0001',
        wait_ms: 5_000,
        shell: 'powershell',
        command: 'Start-Sleep -Seconds 30',
      });
      await pause(250);
      harness.grant(ADAPTER_CONNECTION, harness.workspace.id, []);
      const error = errorOf(await running, '撤销命令授权时应停止进程').error;
      assert.equal(error.code, 'WORKSPACE_NOT_GRANTED');
      assert.match(error.message, /可能已经执行了一部分/);
      const audit = harness.repos.audit.findByRequestId('req_1').at(-1);
      assert.deepEqual(audit?.file_access, [
        { path: '', start_line: null, end_line: null, delivered: false },
      ]);
    } finally {
      await closeFixture(harness);
    }
  });

  it('紧急暂停会终止正在运行的命令并隐藏其结果', async () => {
    let paused = false;
    const harness = await makeFixtureToolHarness({ paused: () => paused });
    try {
      const running = callTool(harness, 'command_exec', {
        workspace_id: harness.workspace.id,
        idempotency_key: 'idem-command-paused-test-0001',
        wait_ms: 5_000,
        shell: 'powershell',
        command: 'Start-Sleep -Seconds 30',
      });
      await pause(250);
      paused = true;
      const error = errorOf(await running, '紧急暂停时应终止命令').error;
      assert.equal(error.code, 'PAUSED');
      assert.match(error.message, /可能已经执行了一部分/);
    } finally {
      await closeFixture(harness);
    }
  });

  it('同一幂等键重放或换命令都不会启动第二个进程', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'lwb-command-idempotency-'));
    const harness = await makeFixtureToolHarness({ root });
    const idempotencyKey = 'idem-command-exactly-once-2026-09-28';
    const markerPath = path.join(root, 'run-count.txt');
    const command = "Add-Content -LiteralPath 'run-count.txt' -Value 'run'; Write-Output 'LWB_RUN_ONCE'";
    try {
      harness.grant(ADAPTER_CONNECTION, harness.workspace.id, ['command_exec']);
      const input = {
        workspace_id: harness.workspace.id,
        idempotency_key: idempotencyKey,
        wait_ms: 5_000,
        shell: 'powershell' as const,
        command,
      };
      const concurrent = await Promise.all([
        callTool(harness, 'command_exec', input),
        callTool(harness, 'command_exec', input),
      ]);
      assert.ok(concurrent.every((envelope) => envelope.ok), 'both requests must resolve to the original job');
      const first = dataOf(concurrent[0]!) as CommandExecData;
      const second = dataOf(concurrent[1]!) as CommandExecData;
      assert.equal(first.job_id, second.job_id);
      assert.equal(first.exit_code, 0);
      assert.equal(first.stdout.trim(), 'LWB_RUN_ONCE');

      const replay = dataOf<CommandExecData>(await callTool(harness, 'command_exec', input));
      assert.equal(replay.job_id, first.job_id);
      assert.equal(replay.state, 'EXITED');

      const conflict = errorOf(
        await callTool(harness, 'command_exec', { ...input, command: "Add-Content -LiteralPath 'run-count.txt' -Value 'conflict'" }),
        '同键不同命令必须冲突',
      ).error;
      assert.equal(conflict.code, 'IDEMPOTENCY_CONFLICT');

      const executions = (await readFile(markerPath, 'utf8')).split(/\r?\n/u).filter(Boolean);
      assert.deepEqual(executions, ['run'], 'the shell process must start exactly once for a stable idempotency key');
    } finally {
      await closeFixture(harness);
      await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });
});
