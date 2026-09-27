/**
 * Foreground local ChatGPT/Tunnel launcher (LWB-039 groundwork).
 *
 * Startup order is deliberate: validate account-side inputs, start the local
 * daemon, run tunnel-client doctor against the real MCP stdio child, then keep
 * tunnel-client attached to this terminal. The daemon adds only the
 * mcp-adapter audience IPC credential (not the console audience credential)
 * to that child environment; no credential is written to a profile, command
 * line, or log.
 */

import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';

import { loadConsoleAssets } from './console-assets.ts';
import { TUNNEL_API_KEY_ENV, TUNNEL_ID_ENV, tunnelClientArguments } from './tunnel-client.ts';
import { superviseTunnel, waitForConnectionEnable } from './tunnel-supervisor.ts';
import { ADAPTER_CONNECTION_ID, StartupFailed, startDaemon } from '../runtime/index.ts';

const REPO_ROOT = path.resolve(import.meta.dirname, '../../../..');
const DEFAULT_TUNNEL_CLIENT = path.join(
  REPO_ROOT,
  '.lwb-local',
  'tunnel-client',
  'v0.0.15',
  'bin',
  'tunnel-client.exe',
);
interface ProcessResult {
  readonly code: number;
  readonly signal: NodeJS.Signals | null;
}

function runAttached(
  executable: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...args], {
      cwd: REPO_ROOT,
      env,
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code: code ?? 1, signal }));
  });
}

function reportFailure(message: string): void {
  process.stderr.write(`${message}\n`);
}

async function main(): Promise<number> {
  if (process.platform !== 'win32') {
    reportFailure('ChatGPT 本地隧道启动器只支持 Windows。');
    return 2;
  }

  const missing = [TUNNEL_ID_ENV, TUNNEL_API_KEY_ENV].filter(
    (name) => (process.env[name] ?? '').trim().length === 0,
  );
  if (missing.length > 0) {
    reportFailure(
      `尚未连接 ChatGPT：当前 PowerShell 会话缺少 ${missing.join('、')}。` +
        '请先在 Platform 创建 tunnel 与 runtime key，并只在本机终端设置这两个变量；不要贴到聊天或写入配置文件。',
    );
    return 2;
  }

  const tunnelId = process.env[TUNNEL_ID_ENV]?.trim() ?? '';
  if (!/^tunnel_[A-Za-z0-9_-]{8,}$/.test(tunnelId)) {
    reportFailure(`${TUNNEL_ID_ENV} 格式不正确；请从 Platform 复制 tunnel_id。`);
    return 2;
  }

  const tunnelClient = path.resolve(process.env['LWB_TUNNEL_CLIENT_EXE'] ?? DEFAULT_TUNNEL_CLIENT);
  try {
    await access(tunnelClient);
  } catch {
    reportFailure(
      `找不到 tunnel-client：${tunnelClient}。` +
        '请按 docs/evidence/platform-capability.md 的已校验步骤安装，或设置 LWB_TUNNEL_CLIENT_EXE。',
    );
    return 2;
  }

  let runtime: Awaited<ReturnType<typeof startDaemon>> | null = null;
  let signalSeen: NodeJS.Signals | null = null;
  const shutdown = new AbortController();
  const onInterrupt = (signal: NodeJS.Signals): void => {
    // Ctrl+C is broadcast to attached console processes on Windows. Keep this
    // process alive long enough for tunnel-client to stop its stdio child and
    // for the daemon's finally block below to close the local IPC/control APIs.
    signalSeen = signal;
    shutdown.abort();
  };
  process.on('SIGINT', onInterrupt);
  process.on('SIGTERM', onInterrupt);

  try {
    runtime = await startDaemon({
      argv: [],
      env: process.env,
      static_assets: await loadConsoleAssets(),
    });
    if (signalSeen !== null) return signalSeen === 'SIGINT' ? 130 : 143;

    const activeRuntime = runtime;
    if (activeRuntime === null) throw new Error('daemon 启动后没有返回运行时句柄。');
    const waitWithShutdown = async (milliseconds: number): Promise<void> => {
      try {
        await delay(milliseconds, undefined, { signal: shutdown.signal });
      } catch (error) {
        if (!shutdown.signal.aborted) throw error;
      }
    };
    const connectionEnabled = await waitForConnectionEnable({
      isEnabled: () => {
        const connection = activeRuntime.repos.connections.findById(ADAPTER_CONNECTION_ID);
        if (connection === null) throw new Error('本机模型连接未登记，拒绝启动 tunnel。');
        return connection.enabled;
      },
      wait: waitWithShutdown,
      shouldStop: () => signalSeen !== null,
      log: (message) => process.stdout.write(`${message}\n`),
    });
    if (!connectionEnabled) return signalSeen === 'SIGINT' ? 130 : 143;

    const childEnv: NodeJS.ProcessEnv = { ...process.env };
    delete childEnv['LWB_IPC_SECRET_CONSOLE'];
    Object.assign(childEnv, runtime.mcpAdapterEnvironment());
    const doctor = await runAttached(
      tunnelClient,
      tunnelClientArguments('doctor', tunnelId),
      childEnv,
    );
    if (doctor.code !== 0 || doctor.signal !== null) {
      reportFailure('tunnel-client doctor 未通过；隧道未启动。请按上面的诊断处理后重试。');
      return doctor.code || 1;
    }

    process.stdout.write('本地 daemon 与 MCP 适配器已就绪；正在以前台方式启动 Secure MCP Tunnel。\n');
    return await superviseTunnel({
      run: () => runAttached(tunnelClient, tunnelClientArguments('run', tunnelId), childEnv),
      doctor: () => runAttached(tunnelClient, tunnelClientArguments('doctor', tunnelId), childEnv),
      wait: waitWithShutdown,
      shouldStop: () => signalSeen !== null,
      stopExitCode: () => (signalSeen === 'SIGINT' ? 130 : 143),
      log: (message) => process.stdout.write(`${message}\n`),
    });
  } catch (error) {
    reportFailure(
      error instanceof StartupFailed
        ? error.message
        : `本地 ChatGPT 启动失败：${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  } finally {
    process.off('SIGINT', onInterrupt);
    process.off('SIGTERM', onInterrupt);
    await runtime?.shutdown();
  }
}

void main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    reportFailure(`本地 ChatGPT 启动器异常：${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  },
);
