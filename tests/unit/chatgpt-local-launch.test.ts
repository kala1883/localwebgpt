import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
  it('forwards CMD validation from another directory and rejects unsupported Node before loading credentials', async (context) => {
    if (process.platform !== 'win32') {
      context.skip('CMD launcher validation is Windows-only.');
      return;
    }

    const root = await mkdtemp(path.join(tmpdir(), 'lwb cmd launch '));
    const secretSentinel = 'not-a-real-runtime-key-node-version-test';
    try {
      const scripts = path.join(root, 'scripts', 'windows');
      const fakeBin = path.join(root, 'fake-bin');
      await mkdir(scripts, { recursive: true });
      await mkdir(fakeBin);
      await copyFile(new URL('../../Start-LocalWebGPT.cmd', import.meta.url), path.join(root, 'Start-LocalWebGPT.cmd'));
      await copyFile(new URL('../../scripts/windows/Start-LocalWebGPT.ps1', import.meta.url), path.join(scripts, 'Start-LocalWebGPT.ps1'));
      await writeFile(path.join(root, 'package.json'), '{"name":"lwb-cmd-fixture"}\n', 'utf8');
      await writeFile(path.join(root, '.env'), `tunnel_id=tunnel_0123456789abcdef\nruntime_API_key=${secretSentinel}\n`, 'utf8');

      for (const [version, accepted] of [
        ['v16.20.1', false],
        ['v22.11.0', false],
        ['invalid-version', false],
        ['v22.12.0', true],
        ['v24.9.0', true],
      ] as const) {
        await writeFile(path.join(fakeBin, 'node.cmd'), `@echo off\r\necho ${version}\r\nexit /b 0\r\n`, 'ascii');
        const wrapper = path.join(root, 'Start-LocalWebGPT.cmd').replaceAll("'", "''");
        const run = spawnSync('pwsh.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `& '${wrapper}' -ValidateOnly; exit $LASTEXITCODE`], {
          cwd: tmpdir(),
          encoding: 'utf8',
          windowsHide: true,
          timeout: 10_000,
          env: { ...process.env, PATH: `${fakeBin};${process.env['PATH'] ?? ''}` },
        });
        const output = `${run.stdout}${run.stderr}`;
        assert.equal(run.status === 0, accepted, `${version}: ${output}`);
        assert.equal(output.includes(secretSentinel), false);
        assert.ok(output.includes(accepted ? 'Project-root .env is valid' : 'Node.js'), output);
        if (!accepted) assert.equal(output.includes('Project-root .env is valid'), false);
      }
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it('loads tunnel credentials from the root .env without prompting or echoing values', () => {
    const launcher = readFileSync(
      new URL('../../scripts/windows/Start-LocalWebGPT.ps1', import.meta.url),
      'utf8',
    );

    assert.ok(launcher.includes("Join-Path $runtimeRoot '.env'"));
    assert.match(launcher, /'tunnel_id'/);
    assert.match(launcher, /'runtime_api_key'/);
    assert.match(launcher, /CONTROL_PLANE_TUNNEL_ID/);
    assert.match(launcher, /CONTROL_PLANE_API_KEY/);
    assert.match(launcher, /snapshot_store_max_bytes/);
    assert.match(launcher, /LWB_SNAPSHOT_STORE_MAX_BYTES/);
    assert.match(launcher, /\.lwb-runtime-package/);
    assert.match(launcher, /\.lwb-build-info\.json/);
    assert.match(launcher, /LWB_BUILD_ID/);
    assert.match(launcher, /if \(\$isPackagedRuntime\)[\s\S]*?node --import tsx apps\/daemon\/src\/lifecycle\/chatgpt-local\.ts/);
    assert.match(launcher, /else \{\s*npm run chatgpt:local\s*\}/);
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
        new URL('../../scripts/windows/Start-LocalWebGPT.ps1', import.meta.url),
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

  it('validates packaged build identity without requiring npm or launching the daemon', async (context) => {
    if (process.platform !== 'win32') {
      context.skip('Packaged PowerShell launcher validation is Windows-only.');
      return;
    }

    const root = await mkdtemp(path.join(tmpdir(), 'lwb-build-id-launch-'));
    const secretSentinel = 'not-a-real-runtime-key-build-id-test';
    try {
      const launcher = path.join(root, 'Start-LocalWebGPT.ps1');
      const sourceLauncher = fileURLToPath(
        new URL('../../scripts/windows/Start-LocalWebGPT.ps1', import.meta.url),
      );
      await copyFile(sourceLauncher, launcher);
      await writeFile(path.join(root, 'package.json'), '{"name":"lwb-runtime-fixture"}\n', 'utf8');
      await writeFile(path.join(root, '.lwb-runtime-package'), 'format=1\n', 'ascii');
      await mkdir(path.join(root, 'apps', 'console', 'dist'), { recursive: true });
      await writeFile(path.join(root, 'apps', 'console', 'dist', 'index.html'), '<!doctype html>\n', 'utf8');
      const fingerprint = 'a'.repeat(64);
      const buildInfoPath = path.join(root, '.lwb-build-info.json');
      await writeFile(buildInfoPath, JSON.stringify({
        schema_version: 1,
        build_id: `sha256:${fingerprint}`,
        source_manifest_sha256: fingerprint,
        source_commit: 'fixture-commit',
      }), 'utf8');
      const safeTunnelId = 'tunnel_0123456789abcdef0123456789abcdef';
      const envPath = path.join(root, '.env');
      await writeFile(envPath, `tunnel_id=${safeTunnelId}\nruntime_API_key=${secretSentinel}\n`, 'utf8');

      const runValidateOnly = () => spawnSync(
        'pwsh.exe',
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', launcher, '-ValidateOnly'],
        {
          cwd: root,
          encoding: 'utf8',
          windowsHide: true,
          timeout: 10_000,
          env: { ...process.env, PATHEXT: '.EXE;.COM' },
        },
      );

      const valid = runValidateOnly();
      assert.equal(valid.status, 0, valid.stderr);
      assert.ok(valid.stdout.includes('valid'));
      assert.equal(`${valid.stdout}${valid.stderr}`.includes(secretSentinel), false);

      await writeFile(buildInfoPath, JSON.stringify({
        schema_version: 1,
        build_id: `sha256:${'b'.repeat(64)}`,
        source_manifest_sha256: fingerprint,
        source_commit: 'fixture-commit',
      }), 'utf8');
      const invalid = runValidateOnly();
      assert.notEqual(invalid.status, 0, 'mismatched source fingerprint must refuse startup');
      assert.ok(`${invalid.stdout}${invalid.stderr}`.includes('build identity failed validation'));
      assert.equal(`${invalid.stdout}${invalid.stderr}`.includes(secretSentinel), false);

      await writeFile(buildInfoPath, JSON.stringify({
        schema_version: 1,
        build_id: `sha256:${fingerprint}`,
        source_manifest_sha256: fingerprint,
        source_commit: 'fixture-commit',
      }), 'utf8');
      const fakeBin = path.join(root, 'fake-bin');
      await mkdir(fakeBin);
      await writeFile(
        path.join(fakeBin, 'node.cmd'),
        '@echo off\r\nif "%~1"=="--version" (\r\n  echo v22.20.0\r\n  exit /b 0\r\n)\r\necho LWB_BUILD_ID=%LWB_BUILD_ID%\r\nexit /b 0\r\n',
        'ascii',
      );
      const launched = spawnSync('pwsh.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', launcher], {
        cwd: root,
        encoding: 'utf8',
        windowsHide: true,
        timeout: 10_000,
        env: {
          ...process.env,
          PATH: `${fakeBin};${process.env['PATH'] ?? ''}`,
          PATHEXT: '.CMD;.EXE;.COM',
        },
      });
      assert.equal(launched.status, 0, launched.stderr);
      assert.ok(launched.stdout.includes(`LWB_BUILD_ID=sha256:${fingerprint}`), launched.stdout);
      assert.equal(`${launched.stdout}${launched.stderr}`.includes(secretSentinel), false);
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it('ships a scoped stop command that uses the named pipe, not process-name or PID killing', () => {
    const stopScript = readFileSync(
      new URL('../../scripts/windows/Stop-LocalWebGPT.ps1', import.meta.url),
      'utf8',
    );
    const runtimeBuilder = readFileSync(
      new URL('../../deployment/windows/build-runtime.ps1', import.meta.url),
      'utf8',
    );

    assert.match(stopScript, /NamedPipeClientStream/);
    assert.match(stopScript, /LWB_STOP/);
    assert.match(stopScript, /ReadAsync/);
    assert.match(stopScript, /Wait\(\$remainingMilliseconds\)/);
    assert.match(stopScript, /原启动终端按 Ctrl[+]C/);
    assert.doesNotMatch(stopScript, /ReadTimeout/);
    assert.doesNotMatch(stopScript, /Stop-Process|taskkill|Get-Process/);
    assert.match(runtimeBuilder, /Stop-LocalWebGPT\.ps1/);
  });

  it('ships an explicit guarded runtime uninstaller with the Windows package', () => {
    const uninstallScript = readFileSync(
      new URL('../../scripts/windows/Uninstall-LocalWebGPT.ps1', import.meta.url),
      'utf8',
    );
    const runtimeBuilder = readFileSync(
      new URL('../../deployment/windows/build-runtime.ps1', import.meta.url),
      'utf8',
    );

    assert.match(uninstallScript, /ConfirmTargetRuntimeStopped/);
    assert.match(uninstallScript, /canonical_root/);
    assert.match(uninstallScript, /Test-PathsOverlap/);
    assert.match(uninstallScript, /FILE_FLAG_OPEN_REPARSE_POINT/);
    assert.match(uninstallScript, /SetFileInformationByHandle/);
    assert.match(uninstallScript, /OpenEntry\(\$Path\)/);
    assert.doesNotMatch(uninstallScript, /Remove-TreeWithoutFollowingLinks/);
    assert.match(uninstallScript, /SupportsShouldProcess/);
    assert.match(runtimeBuilder, /Uninstall-LocalWebGPT\.ps1/);
  });

  it('records an SPDX SBOM and hashes the packaged Windows binaries', () => {
    const runtimeBuilder = readFileSync(
      new URL('../../deployment/windows/build-runtime.ps1', import.meta.url),
      'utf8',
    );
    const sbomGenerator = readFileSync(
      new URL('../../scripts/release/generate-evidence.mjs', import.meta.url),
      'utf8',
    );
    const runtimePackage = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { dependencies: Record<string, string>; devDependencies: Record<string, string> };

    assert.match(runtimeBuilder, /npm run release:evidence/);
    assert.match(runtimeBuilder, /npm prune --omit=dev/);
    assert.match(runtimeBuilder, /Runtime TypeScript module smoke/);
    assert.match(runtimeBuilder, /Remove-Item -LiteralPath \$resolvedTestsRoot -Recurse -Force/);
    assert.match(sbomGenerator, /'--omit=dev'/);
    assert.match(sbomGenerator, /writePackagedBuildInfo/);
    assert.match(sbomGenerator, /\.lwb-build-info\.json/);
    assert.equal(runtimePackage.dependencies.tsx, '4.23.15');
    assert.equal(runtimePackage.devDependencies.tsx, undefined);
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
