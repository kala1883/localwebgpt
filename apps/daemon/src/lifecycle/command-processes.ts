/**
 * Bounded command execution for the explicitly granted MCP `command_exec` tool.
 *
 * This sets a working directory; it is not an OS sandbox. Children run as the
 * daemon's user and may access other locations allowed to that user.
 */
import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

import type { CommandShell } from '@lwb/contracts';

export const COMMAND_TIMEOUT_MS = 25_000;
export const COMMAND_OUTPUT_LIMIT_BYTES = 24 * 1024;
const TERMINATE_WAIT_MS = 3_000;

export interface CommandProcessResult {
  readonly started: boolean;
  readonly exit_code: number | null;
  readonly duration_ms: number;
  readonly timed_out: boolean;
  readonly output_truncated: boolean;
  readonly cancelled: boolean;
  readonly stdout: string;
  readonly stderr: string;
}

export interface CommandProcessOptions {
  readonly shell: CommandShell;
  readonly command: string;
  readonly cwd: string;
  readonly signal?: AbortSignal;
}

export interface CommandProcessManagerOptions {
  /** Test seam; production uses the fixed constants and never accepts model overrides. */
  readonly timeout_ms?: number;
  readonly output_limit_bytes?: number;
}

interface ActiveProcess {
  readonly child: ChildProcess;
  readonly done: Promise<void>;
  terminate(reason: 'timeout' | 'output_limit' | 'cancelled' | 'shutdown'): void;
}

/** Owns command children so an orderly daemon shutdown can stop them. */
export class CommandProcessManager {
  readonly #active = new Set<ActiveProcess>();
  readonly #timeoutMs: number;
  readonly #outputLimitBytes: number;
  #shuttingDown = false;

  constructor(options: CommandProcessManagerOptions = {}) {
    this.#timeoutMs = options.timeout_ms ?? COMMAND_TIMEOUT_MS;
    this.#outputLimitBytes = options.output_limit_bytes ?? COMMAND_OUTPUT_LIMIT_BYTES;
    if (!Number.isInteger(this.#timeoutMs) || this.#timeoutMs <= 0 || this.#timeoutMs > COMMAND_TIMEOUT_MS) {
      throw new RangeError(`Command timeout must be between 1 and ${COMMAND_TIMEOUT_MS} ms.`);
    }
    if (
      !Number.isInteger(this.#outputLimitBytes) ||
      this.#outputLimitBytes <= 0 ||
      this.#outputLimitBytes > COMMAND_OUTPUT_LIMIT_BYTES
    ) {
      throw new RangeError(`Command output limit must be between 1 and ${COMMAND_OUTPUT_LIMIT_BYTES} bytes.`);
    }
  }

  async run(options: CommandProcessOptions): Promise<CommandProcessResult> {
    if (this.#shuttingDown) throw new Error('Command process manager is shutting down.');
    if (options.signal?.aborted) {
      return {
        started: false,
        exit_code: null,
        duration_ms: 0,
        timed_out: false,
        output_truncated: false,
        cancelled: true,
        stdout: '',
        stderr: '',
      };
    }

    const { executable, args } = shellCommand(options.shell, options.command);
    const startedAt = performance.now();
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: safeCommandEnvironment(),
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let collectedBytes = 0;
    let outputTruncated = false;
    let timedOut = false;
    let cancelled = false;
    let spawnFailed = false;
    let terminationStarted = false;
    let finished = false;
    let timer: NodeJS.Timeout | undefined;
    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });

    const terminate = (reason: 'timeout' | 'output_limit' | 'cancelled' | 'shutdown'): void => {
      if (terminationStarted || finished) return;
      terminationStarted = true;
      timedOut = reason === 'timeout';
      outputTruncated = outputTruncated || reason === 'output_limit';
      cancelled = reason === 'cancelled' || reason === 'shutdown';
      terminateProcessTree(child);
    };

    const active: ActiveProcess = { child, done, terminate };
    if (typeof child.pid === 'number') this.#active.add(active);

    const collect = (target: Buffer[], chunk: Buffer): void => {
      if (finished || terminationStarted) return;
      const remaining = this.#outputLimitBytes - collectedBytes;
      const accepted = Math.max(0, Math.min(chunk.length, remaining));
      if (accepted > 0) {
        target.push(chunk.subarray(0, accepted));
        collectedBytes += accepted;
      }
      if (accepted < chunk.length) terminate('output_limit');
    };

    child.stdout?.on('data', (chunk: Buffer) => collect(stdout, chunk));
    child.stderr?.on('data', (chunk: Buffer) => collect(stderr, chunk));

    const onAbort = (): void => terminate('cancelled');
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
    timer = setTimeout(() => terminate('timeout'), this.#timeoutMs);

    return await new Promise<CommandProcessResult>((resolve) => {
      const finish = (exitCode: number | null): void => {
        if (finished) return;
        finished = true;
        if (timer !== undefined) clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
        this.#active.delete(active);
        resolveDone();
        resolve({
          started: !spawnFailed,
          exit_code: exitCode,
          duration_ms: Math.max(0, Math.round(performance.now() - startedAt)),
          timed_out: timedOut,
          output_truncated: outputTruncated,
          cancelled,
          stdout: normalizeCommandOutput(Buffer.concat(stdout).toString('utf8')),
          stderr: normalizeCommandOutput(Buffer.concat(stderr).toString('utf8')),
        });
      };

      child.once('error', () => {
        spawnFailed = true;
        finish(null);
      });
      child.once('close', (code) => finish(code));
    });
  }

  async terminateAll(): Promise<void> {
    this.#shuttingDown = true;
    const active = [...this.#active];
    for (const item of active) item.terminate('shutdown');
    if (active.length === 0) return;
    await Promise.race([
      Promise.all(active.map((item) => item.done)),
      new Promise<void>((resolve) => setTimeout(resolve, TERMINATE_WAIT_MS)),
    ]);
    if (this.#active.size > 0) throw new Error('One or more workspace command processes did not exit after termination.');
  }
}

function shellCommand(shell: CommandShell, command: string): { executable: string; args: string[] } {
  switch (shell) {
    case 'cmd':
      return { executable: process.env['ComSpec'] ?? 'cmd.exe', args: ['/d', '/s', '/c', command] };
    case 'powershell':
      return {
        executable: 'powershell.exe',
        args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')],
      };
    case 'bash':
      return { executable: 'bash', args: ['--noprofile', '--norc', '-c', command] };
  }
}

function safeCommandEnvironment(): NodeJS.ProcessEnv {
  const allowed = [
    'PATH', 'PATHEXT', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE',
    'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'ProgramData',
    'SYSTEMDRIVE', 'ComSpec', 'PSModulePath', 'HOME', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR',
  ];
  const env: NodeJS.ProcessEnv = { NO_COLOR: '1' };
  for (const name of allowed) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

function normalizeCommandOutput(value: string): string {
  return value
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ');
}

function terminateProcessTree(child: ChildProcess): void {
  const pid = child.pid;
  if (typeof pid !== 'number') return;

  if (process.platform === 'win32') {
    const systemRoot = process.env['SystemRoot'] ?? process.env['WINDIR'];
    const taskkill = systemRoot === undefined ? 'taskkill.exe' : path.join(systemRoot, 'System32', 'taskkill.exe');
    spawnSync(taskkill, ['/PID', String(pid), '/T', '/F'], {
      env: safeCommandEnvironment(),
      stdio: 'ignore',
      windowsHide: true,
      timeout: TERMINATE_WAIT_MS,
    });
  } else {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // The process group may have exited between the timer and the kill.
    }
  }

  try {
    child.kill('SIGKILL');
  } catch {
    // Already exited.
  }
}
