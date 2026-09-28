import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { describe, it, type TestContext } from 'node:test';

import type { CommandShell } from '@lwb/contracts';
import { CommandProcessManager } from '../../apps/daemon/src/lifecycle/command-processes.ts';

const shell: CommandShell = process.platform === 'win32' ? 'powershell' : 'bash';
const writeMarker = process.platform === 'win32'
  ? "Write-Output 'LWB_COMMAND_PROCESS_OK'"
  : 'echo LWB_COMMAND_PROCESS_OK';
const sleepLong = process.platform === 'win32' ? 'Start-Sleep -Seconds 30' : 'sleep 30';
const emitLarge = process.platform === 'win32'
  ? "[Console]::Out.Write('x' * 8192)"
  : "head -c 8192 /dev/zero | tr '\\000' x";

describe('workspace command process manager', () => {
  it('starts the selected shell in the supplied working directory and returns bounded output', async () => {
    const manager = new CommandProcessManager({ timeout_ms: 10_000 });
    const result = await manager.run({ shell, command: writeMarker, cwd: process.cwd() });

    assert.equal(result.started, true);
    assert.equal(result.exit_code, 0);
    assert.match(result.stdout, /LWB_COMMAND_PROCESS_OK/);
    assert.equal(result.timed_out, false);
    await manager.terminateAll();
  });

  it('uses no default execution deadline', async () => {
    const manager = new CommandProcessManager();
    const command = process.platform === 'win32'
      ? 'Start-Sleep -Milliseconds 300; Write-Output LWB_NO_DEFAULT_DEADLINE'
      : 'sleep 0.3; echo LWB_NO_DEFAULT_DEADLINE';
    const result = await manager.run({ shell, command, cwd: process.cwd() });

    assert.equal(result.started, true);
    assert.equal(result.exit_code, 0);
    assert.equal(result.timed_out, false);
    assert.match(result.stdout, /LWB_NO_DEFAULT_DEADLINE/);
    await manager.terminateAll();
  });

  it('supports cmd on Windows', async () => {
    if (process.platform !== 'win32') return;
    const manager = new CommandProcessManager({ timeout_ms: 5_000 });
    const cmd = await manager.run({ shell: 'cmd', command: 'echo LWB_CMD_OK', cwd: process.cwd() });
    assert.equal(cmd.started, true);
    assert.equal(cmd.exit_code, 0);
    assert.match(cmd.stdout, /LWB_CMD_OK/);
    await manager.terminateAll();
  });

  it('runs Bash when a native Bash executable is available', async (context: TestContext) => {
    if (process.platform === 'win32') {
      let resolved: string | undefined;
      try {
        resolved = execFileSync('where.exe', ['bash.exe'], { encoding: 'utf8', windowsHide: true })
          .split(/\r?\n/)[0]?.trim().toLowerCase();
      } catch {
        context.skip('Bash is not installed or is not available on PATH.');
        return;
      }
      const system32Bash = `${process.env['SystemRoot'] ?? 'C:\\Windows'}\\System32\\bash.exe`.toLowerCase();
      if (resolved === system32Bash) {
        context.skip('This host resolves bash.exe to the WSL launcher; WSL startup timing is environment-specific.');
        return;
      }
    }
    const manager = new CommandProcessManager({ timeout_ms: 10_000 });
    const bash = await manager.run({ shell: 'bash', command: 'echo LWB_BASH_OK', cwd: process.cwd() });
    if (!bash.started) {
      context.skip('Bash is not installed or is not available on PATH.');
      return;
    }
    assert.equal(bash.exit_code, 0, JSON.stringify(bash));
    assert.match(bash.stdout, /LWB_BASH_OK/);
    await manager.terminateAll();
  });

  it('does not pass arbitrary daemon environment secrets to the child', async () => {
    const key = 'LWB_COMMAND_EXEC_TEST_SECRET';
    const previous = process.env[key];
    process.env[key] = 'secret-that-must-not-be-inherited';
    try {
      const manager = new CommandProcessManager({ timeout_ms: 5_000 });
      const command = process.platform === 'win32'
        ? `Write-Output $env:${key}`
        : `printf '%s' "$${key}"`;
      const result = await manager.run({ shell, command, cwd: process.cwd() });
      assert.equal(result.started, true);
      assert.equal(result.exit_code, 0);
      assert.equal(result.stdout.trim(), '');
      await manager.terminateAll();
    } finally {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
  });

  it('kills a timed-out command and truncates output at the manager limit', async () => {
    const timeoutManager = new CommandProcessManager({ timeout_ms: 150 });
    const timeout = await timeoutManager.run({ shell, command: sleepLong, cwd: process.cwd() });
    assert.equal(timeout.started, true);
    assert.equal(timeout.timed_out, true);
    assert.ok(timeout.duration_ms < 5_000);
    await timeoutManager.terminateAll();

    const outputManager = new CommandProcessManager({ timeout_ms: 5_000, output_limit_bytes: 256 });
    const output = await outputManager.run({ shell, command: emitLarge, cwd: process.cwd() });
    assert.equal(output.started, true);
    assert.equal(output.output_truncated, true);
    assert.ok(Buffer.byteLength(output.stdout + output.stderr, 'utf8') <= 256);
    await outputManager.terminateAll();
  });

  it('stops active children when the daemon-owned manager shuts down', async () => {
    const manager = new CommandProcessManager({ timeout_ms: 5_000 });
    const running = manager.run({ shell, command: sleepLong, cwd: process.cwd() });
    await new Promise((resolve) => setTimeout(resolve, 100));
    await manager.terminateAll();
    const result = await running;
    assert.equal(result.cancelled, true);
    assert.ok(result.duration_ms < 5_000);
  });
});
