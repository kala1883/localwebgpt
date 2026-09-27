import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  TUNNEL_API_KEY_ENV,
  TUNNEL_ID_ENV,
  stripTunnelCredentials,
  tunnelClientArguments,
} from '../../apps/daemon/src/lifecycle/tunnel-client.ts';
import {
  superviseTunnel,
  tunnelRetryDelay,
  waitForConnectionEnable,
} from '../../apps/daemon/src/lifecycle/tunnel-supervisor.ts';

describe('local Secure MCP Tunnel launch contract', () => {
  it('loads tunnel credentials from the root .env without prompting or echoing values', () => {
    const launcher = readFileSync(
      new URL('../../packaging/windows/Start-LocalWebGPT.ps1', import.meta.url),
      'utf8',
    );

    assert.ok(launcher.includes("Join-Path $runtimeRoot '.env'"));
    assert.match(launcher, /'tunnel_id'/);
    assert.match(launcher, /'runtime_api_key'/);
    assert.match(launcher, /CONTROL_PLANE_TUNNEL_ID/);
    assert.match(launcher, /CONTROL_PLANE_API_KEY/);
    assert.match(launcher, /snapshot_store_max_bytes/);
    assert.match(launcher, /LWB_SNAPSHOT_STORE_MAX_BYTES/);
    assert.match(launcher, /\[switch\]\$ValidateOnly/);
    assert.doesNotMatch(launcher, /Read-Host/);
    assert.match(launcher, /values were not displayed/i);
  });

  it('validates the optional snapshot quota from a disposable root .env without echoing its value', async (context) => {
    if (process.platform !== 'win32') {
      context.skip('Start-LocalWebGPT.ps1 environment parsing is Windows-only.');
      return;
    }

    const root = await mkdtemp(path.join(tmpdir(), 'lwb-quota-env-'));
    try {
      const script = path.join(root, 'Start-LocalWebGPT.ps1');
      const sourceScript = fileURLToPath(
        new URL('../../packaging/windows/Start-LocalWebGPT.ps1', import.meta.url),
      );
      await copyFile(sourceScript, script);
      await writeFile(path.join(root, 'package.json'), '{"name":"lwb-validate-only"}\n', 'utf8');
      const safeTunnelId = 'tunnel_0123456789abcdef0123456789abcdef';
      const safeKey = 'not-a-real-runtime-key';
      const prefix = `tunnel_id=${safeTunnelId}\nruntime_API_key=${safeKey}\n`;
      await writeFile(path.join(root, '.env'), `${prefix}snapshot_store_max_bytes=536870912\n`, 'utf8');

      const valid = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-File', script, '-ValidateOnly'], {
        cwd: root,
        encoding: 'utf8',
        windowsHide: true,
        timeout: 10_000,
      });
      assert.equal(valid.status, 0, valid.stderr);
      assert.ok(valid.stdout.includes('valid'));
      assert.equal(`${valid.stdout}${valid.stderr}`.includes(safeKey), false);

      await writeFile(path.join(root, '.env'), `${prefix}snapshot_store_max_bytes=2147483649\n`, 'utf8');
      const aboveHardLimit = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-File', script, '-ValidateOnly'], {
        cwd: root,
        encoding: 'utf8',
        windowsHide: true,
        timeout: 10_000,
      });
      assert.notEqual(aboveHardLimit.status, 0, 'launcher must reject a value above the 2 GiB ceiling');
      assert.equal(`${aboveHardLimit.stdout}${aboveHardLimit.stderr}`.includes('2147483649'), false);
      assert.equal(`${aboveHardLimit.stdout}${aboveHardLimit.stderr}`.includes(safeKey), false);
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it('ships a scoped stop command that uses the named pipe, not process-name or PID killing', () => {
    const stopScript = readFileSync(
      new URL('../../packaging/windows/Stop-LocalWebGPT.ps1', import.meta.url),
      'utf8',
    );
    const runtimeBuilder = readFileSync(
      new URL('../../packaging/windows/build-runtime.ps1', import.meta.url),
      'utf8',
    );

    assert.match(stopScript, /NamedPipeClientStream/);
    assert.match(stopScript, /LWB_STOP/);
    assert.doesNotMatch(stopScript, /Stop-Process|taskkill|Get-Process/);
    assert.match(runtimeBuilder, /Stop-LocalWebGPT\.ps1/);
  });

  it('records an SPDX SBOM and hashes the packaged Windows binaries', () => {
    const runtimeBuilder = readFileSync(
      new URL('../../packaging/windows/build-runtime.ps1', import.meta.url),
      'utf8',
    );

    assert.match(runtimeBuilder, /npm run release:evidence/);
    assert.match(runtimeBuilder, /--tunnel-archive-sha256=/);
    assert.match(runtimeBuilder, /--tunnel-client-sha256=/);
    assert.match(runtimeBuilder, /--cloudflared-sha256=/);
    assert.match(runtimeBuilder, /--sqlite-prebuild-sha256=/);
  });

  it('uses an environment reference for the runtime key and never places secrets in argv', () => {
    const runtimeKey = 'runtime-key-must-not-enter-argv';
    const args = tunnelClientArguments('run', 'tunnel_0123456789abcdef0123456789abcdef');

    assert.equal(args.includes(runtimeKey), false);
    assert.deepEqual(args, [
      'run',
      '--control-plane.api-key',
      `env:${TUNNEL_API_KEY_ENV}`,
      '--control-plane.tunnel-id',
      'tunnel_0123456789abcdef0123456789abcdef',
      '--mcp.command',
      'command=node --import tsx apps/daemon/src/lifecycle/run-mcp-adapter.ts,channel=main',
    ]);
  });

  it('runs doctor with the same MCP child and explicit diagnostics before tunnel startup', () => {
    const args = tunnelClientArguments('doctor', 'tunnel_0123456789abcdef0123456789abcdef');
    assert.equal(args[0], 'doctor');
    assert.equal(args.at(-1), '--explain');
    assert.ok(args.includes('--mcp.command'));

    const launcher = readFileSync(
      new URL('../../apps/daemon/src/lifecycle/chatgpt-local.ts', import.meta.url),
      'utf8',
    );
    assert.match(launcher, /beforeRestart:\s*waitForConnection/);
  });

  it('strips tunnel-only credentials before importing the MCP adapter', () => {
    const env: NodeJS.ProcessEnv = {
      [TUNNEL_API_KEY_ENV]: 'runtime-key',
      OPENAI_API_KEY: 'fallback-runtime-key',
      [TUNNEL_ID_ENV]: 'tunnel_id',
      LWB_SNAPSHOT_STORE_MAX_BYTES: '536870912',
      LWB_IPC_SECRET_MCP_ADAPTER: 'adapter-audience-secret',
      LWB_IPC_SECRET_CONSOLE: 'console-audience-secret',
      LWB_CONNECTION_ID: 'conn-chatgpt-web',
    };
    stripTunnelCredentials(env);

    assert.equal(env[TUNNEL_API_KEY_ENV], undefined);
    assert.equal(env['OPENAI_API_KEY'], undefined);
    assert.equal(env[TUNNEL_ID_ENV], undefined);
    assert.equal(env['LWB_SNAPSHOT_STORE_MAX_BYTES'], undefined);
    assert.equal(env['LWB_IPC_SECRET_CONSOLE'], undefined);
    assert.equal(env['LWB_IPC_SECRET_MCP_ADAPTER'] === 'adapter-audience-secret', true);
    assert.equal(env['LWB_CONNECTION_ID'] === 'conn-chatgpt-web', true);
  });

  it('retries a stopped tunnel child in the same daemon with capped backoff and a fresh doctor check', async () => {
    let runCount = 0;
    let doctorCount = 0;
    let stopping = false;
    const waits: number[] = [];
    const messages: string[] = [];

    const exitCode = await superviseTunnel({
      run: async () => {
        runCount += 1;
        if (runCount === 2) stopping = true;
        return { code: runCount === 1 ? 1 : 130, signal: null };
      },
      doctor: async () => {
        doctorCount += 1;
        return { code: 0, signal: null };
      },
      wait: async (milliseconds) => { waits.push(milliseconds); },
      shouldStop: () => stopping,
      stopExitCode: () => 130,
      log: (message) => { messages.push(message); },
    });

    assert.equal(exitCode, 130);
    assert.equal(runCount, 2);
    assert.equal(doctorCount, 1);
    assert.deepEqual(waits, [1_000]);
    assert.match(messages[0] ?? '', /进程已退出/);
    assert.match(messages[1] ?? '', /doctor 通过/);
  });

  it('rechecks local connection enable after backoff before doctor and tunnel restart', async () => {
    let runCount = 0;
    let doctorCount = 0;
    let stopping = false;
    let connectionEnabled = true;
    const backoffWaits: number[] = [];
    const enableWaits: number[] = [];
    const exitCode = await superviseTunnel({
      run: async () => {
        runCount += 1;
        if (runCount === 1) connectionEnabled = false;
        else stopping = true;
        return { code: runCount === 1 ? 1 : 130, signal: null };
      },
      doctor: async () => {
        doctorCount += 1;
        return { code: 0, signal: null };
      },
      beforeRestart: () => waitForConnectionEnable({
        isEnabled: () => connectionEnabled,
        wait: async (milliseconds) => {
          enableWaits.push(milliseconds);
          if (enableWaits.length === 2) connectionEnabled = true;
        },
        shouldStop: () => stopping,
        log: () => {},
      }),
      wait: async (milliseconds) => { backoffWaits.push(milliseconds); },
      shouldStop: () => stopping,
      stopExitCode: () => 130,
      log: () => {},
    });

    assert.equal(exitCode, 130);
    assert.equal(runCount, 2);
    assert.equal(doctorCount, 1);
    assert.deepEqual(backoffWaits, [1_000]);
    assert.deepEqual(enableWaits, [1_000, 1_000]);
  });

  it('does not run doctor or restart the tunnel when the local connection stays disabled', async () => {
    let runCount = 0;
    let doctorCount = 0;
    let stopping = false;
    const exitCode = await superviseTunnel({
      run: async () => {
        runCount += 1;
        return { code: 1, signal: null };
      },
      doctor: async () => {
        doctorCount += 1;
        return { code: 0, signal: null };
      },
      beforeRestart: () => waitForConnectionEnable({
        isEnabled: () => false,
        wait: async () => { stopping = true; },
        shouldStop: () => stopping,
        log: () => {},
      }),
      wait: async () => {},
      shouldStop: () => stopping,
      stopExitCode: () => 130,
      log: () => {},
    });

    assert.equal(exitCode, 130);
    assert.equal(runCount, 1);
    assert.equal(doctorCount, 0);
  });

  it('rechecks connection enable immediately before run if it is disabled during doctor', async () => {
    let runCount = 0;
    let doctorCount = 0;
    let stopping = false;
    let connectionEnabled = true;
    const exitCode = await superviseTunnel({
      run: async () => {
        runCount += 1;
        return { code: 1, signal: null };
      },
      doctor: async () => {
        doctorCount += 1;
        connectionEnabled = false;
        return { code: 0, signal: null };
      },
      beforeRun: () => waitForConnectionEnable({
        isEnabled: () => connectionEnabled,
        wait: async () => { stopping = true; },
        shouldStop: () => stopping,
        log: () => {},
      }),
      beforeRestart: async () => true,
      wait: async () => {},
      shouldStop: () => stopping,
      stopExitCode: () => 130,
      log: () => {},
    });

    assert.equal(exitCode, 130);
    assert.equal(runCount, 1);
    assert.equal(doctorCount, 1);
  });

  it('stops instead of retrying forever when doctor reports invalid configuration or credentials', async () => {
    let runCount = 0;
    let doctorCount = 0;
    const exitCode = await superviseTunnel({
      run: async () => {
        runCount += 1;
        return { code: 1, signal: null };
      },
      doctor: async () => {
        doctorCount += 1;
        return { code: 7, signal: null };
      },
      wait: async () => {},
      shouldStop: () => false,
      stopExitCode: () => 130,
      log: () => {},
    });

    assert.equal(exitCode, 7);
    assert.equal(runCount, 1);
    assert.equal(doctorCount, 1);
  });

  it('honors shutdown during backoff without launching doctor or another tunnel child', async () => {
    let stopping = false;
    let runCount = 0;
    let doctorCount = 0;
    const exitCode = await superviseTunnel({
      run: async () => {
        runCount += 1;
        return { code: 1, signal: null };
      },
      doctor: async () => {
        doctorCount += 1;
        return { code: 0, signal: null };
      },
      wait: async () => { stopping = true; },
      shouldStop: () => stopping,
      stopExitCode: () => 130,
      log: () => {},
    });

    assert.equal(exitCode, 130);
    assert.equal(runCount, 1);
    assert.equal(doctorCount, 0);
  });

  it('uses a bounded reconnect delay schedule', () => {
    assert.throws(() => tunnelRetryDelay(0), RangeError);
    assert.deepEqual(
      [1, 2, 3, 4, 5, 6, 20].map(tunnelRetryDelay),
      [1_000, 2_000, 5_000, 10_000, 30_000, 60_000, 60_000],
    );
  });

  it('waits for the local connection confirmation before allowing tunnel startup', async () => {
    let enabled = false;
    const waits: number[] = [];
    const messages: string[] = [];
    const ready = await waitForConnectionEnable({
      isEnabled: () => enabled,
      wait: async (milliseconds) => {
        waits.push(milliseconds);
        if (waits.length === 2) enabled = true;
      },
      shouldStop: () => false,
      log: (message) => { messages.push(message); },
    });

    assert.equal(ready, true);
    assert.deepEqual(waits, [1_000, 1_000]);
    assert.match(messages[0] ?? '', /本机 ChatGPT 连接当前已停用/);
    assert.match(messages[1] ?? '', /继续检查并启动 Secure MCP Tunnel/);
  });

  it('Ctrl+C while waiting does not enable the connection or start the tunnel', async () => {
    let stopping = false;
    let enabled = false;
    let polls = 0;
    const ready = await waitForConnectionEnable({
      isEnabled: () => { polls += 1; return enabled; },
      wait: async () => { stopping = true; },
      shouldStop: () => stopping,
      log: () => {},
    });

    assert.equal(ready, false);
    assert.equal(enabled, false);
    assert.equal(polls, 1);
  });
});
