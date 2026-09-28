import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { CommandExecData } from '@lwb/contracts';
import { ADAPTER_CONNECTION, GATES_ON, callTool, dataOf, errorOf, makeToolHarness } from '../tools/harness.ts';
import { TESTREPO_DIR } from '../fixtures/index.ts';
import { fileIdOf, makeFixtureOps } from '../tools/fixture-ops.ts';

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function makeFixtureToolHarness(options: { readonly paused?: () => boolean } = {}) {
  return await makeToolHarness({
    root: TESTREPO_DIR,
    root_file_id: fileIdOf(TESTREPO_DIR),
    ops: makeFixtureOps(),
    gates: GATES_ON,
    ...(options.paused === undefined ? {} : { paused: options.paused }),
  });
}

describe('command_exec MCP tool', () => {
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
      harness.close();
    }
  });

  it('withholds output containing an absolute local path', async () => {
    const harness = await makeFixtureToolHarness();
    try {
      const result = dataOf<CommandExecData>(await callTool(harness, 'command_exec', {
        workspace_id: harness.workspace.id,
        shell: 'powershell',
        command: "Write-Output 'C:\\private\\outside.txt'; Write-Output '/home/mj/private.txt'",
      }));
      assert.equal(result.exit_code, 0);
      assert.equal(result.output_withheld, true);
      assert.doesNotMatch(JSON.stringify(result), /C:\\private/);
      assert.doesNotMatch(JSON.stringify(result), /\/home\/mj/);
    } finally {
      harness.close();
    }
  });

  it('stops the in-flight command when its workspace grant is revoked', async () => {
    const harness = await makeFixtureToolHarness();
    try {
      const running = callTool(harness, 'command_exec', {
        workspace_id: harness.workspace.id,
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
      harness.close();
    }
  });

  it('紧急暂停会终止正在运行的命令并隐藏其结果', async () => {
    let paused = false;
    const harness = await makeFixtureToolHarness({ paused: () => paused });
    try {
      const running = callTool(harness, 'command_exec', {
        workspace_id: harness.workspace.id,
        shell: 'powershell',
        command: 'Start-Sleep -Seconds 30',
      });
      await pause(250);
      paused = true;
      const error = errorOf(await running, '紧急暂停时应终止命令').error;
      assert.equal(error.code, 'PAUSED');
      assert.match(error.message, /可能已经执行了一部分/);
    } finally {
      harness.close();
    }
  });
});
