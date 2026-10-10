/**
 * Owns shell children. cwd is NOT an OS sandbox.
 * Cancellation must confirm both termination and pipe closure. An unconfirmed
 * result is reported explicitly; callers must quarantine its command slot.
 */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { terminateCommandTree } from './terminate-command-tree.ts';
import process from 'node:process';
import type { CommandShell } from '@lwb/contracts';

export const COMMAND_OUTPUT_LIMIT_BYTES = 24 * 1024;
const TERMINATE_WAIT_MS = 3_000;
const DRAIN_WAIT_MS = 1_000;
type StopReason = 'timeout' | 'output_limit' | 'cancelled' | 'shutdown' | 'orphaned_output';
export interface CommandProcessResult {
  readonly started: boolean;
  readonly exit_code: number | null;
  readonly duration_ms: number;
  readonly timed_out: boolean;
  readonly output_truncated: boolean;
  readonly cancelled: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly termination_unknown?: boolean;
  readonly orphaned_output?: boolean;
}
export interface CommandProcessOptions {
  readonly shell: CommandShell;
  readonly command: string;
  readonly cwd: string;
  readonly signal?: AbortSignal;
  readonly on_started?: () => void;
  readonly on_cleanup_failure?: () => void;
}
export interface CommandProcessManagerOptions {
  /** No default execution deadline. RPC waiting has a separate, bounded budget. */
  readonly timeout_ms?: number;
  readonly output_limit_bytes?: number;
  readonly termination_wait_ms?: number;
  readonly drain_wait_ms?: number;
  /** Test seam. Production uses the bounded, platform-specific implementation. */
  readonly terminate_tree?: (child: ChildProcess) => Promise<boolean>;
}
interface ActiveProcess {
  readonly child: ChildProcess;
  readonly done: Promise<void>;
  terminate(reason: StopReason): void;
}
export class CommandProcessManager {
  readonly #active = new Set<ActiveProcess>();
  readonly #options: CommandProcessManagerOptions;
  readonly #outputLimit: number;
  readonly #terminateWait: number;
  readonly #drainWait: number;
  #unknownTerminations = 0;
  #shuttingDown = false;
  constructor(options: CommandProcessManagerOptions = {}) {
    this.#options = options;
    this.#outputLimit = options.output_limit_bytes ?? COMMAND_OUTPUT_LIMIT_BYTES;
    this.#terminateWait = options.termination_wait_ms ?? TERMINATE_WAIT_MS;
    this.#drainWait = options.drain_wait_ms ?? DRAIN_WAIT_MS;
    for (const value of [this.#outputLimit, this.#terminateWait, this.#drainWait, options.timeout_ms ?? 1]) {
      if (!Number.isSafeInteger(value) || value < 1) throw new RangeError('Process limits must be positive safe integers.');
    }
    if (this.#outputLimit > COMMAND_OUTPUT_LIMIT_BYTES) throw new RangeError('Command output limit is too large.');
  }
  async run(options: CommandProcessOptions): Promise<CommandProcessResult> {
    if (this.#shuttingDown) throw new Error('Command process manager is shutting down.');
    const empty = (cancelled: boolean): CommandProcessResult => ({
      started: false, exit_code: null, duration_ms: 0, timed_out: false,
      output_truncated: false, cancelled, stdout: '', stderr: '', termination_unknown: false,
    });
    if (options.signal?.aborted) return empty(true);
    const { executable, args } = shellCommand(options.shell, options.command);
    const startedAt = performance.now();
    let child: ChildProcess;
    try {
      child = spawn(executable, args, {
        cwd: options.cwd, env: safeCommandEnvironment(), windowsHide: true,
        detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      return empty(false);
    }
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let started = false;
    let finished = false;
    let closed = false;
    let exited = false;
    let exitCode: number | null = null;
    let stopReason: StopReason | undefined;
    let treeResult: boolean | undefined;
    let outputTruncated = false;
    let deadline: NodeJS.Timeout | undefined;
    let drainTimer: NodeJS.Timeout | undefined;
    let terminationTimer: NodeJS.Timeout | undefined;
    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => { resolveDone = resolve; });
    let resolveResult!: (result: CommandProcessResult) => void;
    const result = new Promise<CommandProcessResult>((resolve) => { resolveResult = resolve; });

    const finish = (unknown: boolean): void => {
      if (finished) return;
      finished = true;
      if (unknown) {
        this.#unknownTerminations += 1;
        try { options.on_cleanup_failure?.(); } catch { /* Cleanup status remains unknown. */ }
      }
      for (const timer of [deadline, drainTimer, terminationTimer]) if (timer !== undefined) clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      child.stdout?.removeListener('data', onStdout);
      child.stderr?.removeListener('data', onStderr);
      this.#active.delete(active);
      if (unknown) {
        // Free local pipe handles only, NOT an assertion that the process is dead.
        child.stdout?.destroy();
        child.stderr?.destroy();
        child.unref();
      }
      resolveDone();
      resolveResult({
        started, exit_code: exitCode,
        duration_ms: Math.max(0, Math.round(performance.now() - startedAt)),
        timed_out: stopReason === 'timeout',
        output_truncated: outputTruncated || unknown,
        cancelled: stopReason === 'cancelled' || stopReason === 'shutdown',
        stdout: normalizeCommandOutput(Buffer.concat(stdout).toString('utf8')),
        stderr: normalizeCommandOutput(Buffer.concat(stderr).toString('utf8')),
        termination_unknown: unknown,
        orphaned_output: stopReason === 'orphaned_output',
      });
    };
    const maybeFinish = (): void => {
      if (!closed || finished) return;
      if (stopReason === undefined) finish(false);
      else if (treeResult !== undefined) finish(!treeResult);
    };
    const terminate = (reason: StopReason): void => {
      if (finished || stopReason !== undefined) return;
      stopReason = reason;
      outputTruncated ||= reason === 'output_limit';
      if (drainTimer !== undefined) clearTimeout(drainTimer);
      // Always install a completion bound, even when the kill helper never returns.
      terminationTimer = setTimeout(() => finish(true), this.#terminateWait + 100);
      const kill = this.#options.terminate_tree ?? ((owned: ChildProcess) =>
        terminateCommandTree(owned, exited, safeCommandEnvironment(), this.#terminateWait));
      void Promise.resolve().then(() => kill(child)).then(
        (confirmed) => { treeResult = confirmed; maybeFinish(); },
        () => { treeResult = false; maybeFinish(); },
      );
    };
    const active: ActiveProcess = { child, done, terminate };
    this.#active.add(active);
    const collect = (target: Buffer[], chunk: Buffer): void => {
      if (finished) return;
      const accepted = Math.max(0, Math.min(chunk.length, this.#outputLimit - bytes));
      if (accepted > 0) { target.push(Buffer.from(chunk.subarray(0, accepted))); bytes += accepted; }
      if (accepted < chunk.length) { outputTruncated = true; terminate('output_limit'); }
    };
    const onStdout = (chunk: Buffer): void => collect(stdout, chunk);
    const onStderr = (chunk: Buffer): void => collect(stderr, chunk);
    const onAbort = (): void => terminate('cancelled');
    child.stdout?.on('data', onStdout);
    child.stderr?.on('data', onStderr);
    child.once('spawn', () => {
      started = true;
      try { options.on_started?.(); } catch { terminate('cancelled'); }
    });
    child.once('error', () => {
      // A spawn error proves no process started; a later error does not.
      if (!started) finish(false);
      else terminate('cancelled');
    });
    child.once('exit', (code) => {
      exited = true;
      exitCode = code;
      if (!finished && stopReason === undefined) {
        drainTimer = setTimeout(() => { if (!closed) terminate('orphaned_output'); }, this.#drainWait);
      }
    });
    child.once('close', (code) => {
      closed = true;
      exitCode = code;
      if (drainTimer !== undefined) clearTimeout(drainTimer);
      maybeFinish();
    });
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
    if (this.#options.timeout_ms !== undefined && !finished) {
      deadline = setTimeout(() => { if (!exited || !closed) terminate('timeout'); }, this.#options.timeout_ms);
    }
    return await result;
  }
  async terminateAll(): Promise<void> {
    this.#shuttingDown = true;
    const active = [...this.#active];
    for (const item of active) item.terminate('shutdown');
    // Every run has its own bounded confirmation timer; no lingering race timer.
    await Promise.all(active.map((item) => item.done));
    if (this.#unknownTerminations > 0) throw new Error('Command termination could not be confirmed; inspect quarantined jobs.');
  }
}
function shellCommand(shell: CommandShell, command: string): { executable: string; args: string[] } {
  switch (shell) {
    case 'cmd': return { executable: process.env['ComSpec'] ?? 'cmd.exe', args: ['/d', '/s', '/c', command] };
    case 'powershell': return { executable: 'powershell.exe', args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')] };
    case 'bash': return { executable: 'bash', args: ['--noprofile', '--norc', '-c', command] };
  }
}
function safeCommandEnvironment(): NodeJS.ProcessEnv {
  const allowed = ['PATH', 'PATHEXT', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE',
    'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'ProgramData', 'SYSTEMDRIVE',
    'ComSpec', 'PSModulePath', 'HOME', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR'];
  const env: NodeJS.ProcessEnv = { NO_COLOR: '1' };
  for (const name of allowed) { const value = process.env[name]; if (value !== undefined) env[name] = value; }
  return env;
}
function normalizeCommandOutput(value: string): string {
  return value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ');
}
