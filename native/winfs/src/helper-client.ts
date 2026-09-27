/**
 * PowerShell 护栏助手的 Node 侧客户端。
 *
 * 支持两种模式，两者都要用真实测量比较：
 *   - 冷启动：每次调用新起一个 pwsh 进程（-Once）
 *   - 常驻：一个 pwsh 进程 + 逐行 JSON 协议（-Server）
 *
 * 本文件位于 native/ 下，是允许直接使用 child_process 的路径之一。
 */

import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
/** 护栏脚本。spike 与生产后端共用**同一份**脚本，否则证据对应的就不是交付物。 */
export const HELPER_PATH = path.resolve(here, '..', 'WinfsGuard.ps1');

const PWSH = 'pwsh';

export interface HelperError {
  ok: false;
  code:
    | 'PATH_UNSAFE'
    | 'ROOT_IDENTITY_MISMATCH'
    | 'LINK_UNSUPPORTED'
    | 'FILE_BUSY'
    | 'NOT_FOUND'
    | 'FILE_VERSION_CONFLICT'
    | 'PERMISSION_DENIED'
    | 'VOLUME_UNSUPPORTED'
    | 'NATIVE_GUARD_UNAVAILABLE'
    | 'IO_ERROR'
    | 'INVALID_ARGUMENT'
    | 'INTERNAL_ERROR';
  message: string;
  win32_error: number;
}

export interface FileIdentity {
  volume_id: string;
  file_id: string;
  link_count: number;
  size: number;
  attributes: string[];
  is_reparse: boolean;
}

export type HelperResult = Record<string, unknown> & { ok: boolean };

/** 冷启动调用：新起一个 PowerShell 进程。用于测量冷启动开销。 */
export function callOnce(request: Record<string, unknown>, timeoutMs = 60_000): HelperResult {
  const json = JSON.stringify(request);
  const started = process.hrtime.bigint();
  const res = spawnSync(PWSH, ['-NoProfile', '-NonInteractive', '-File', HELPER_PATH, '-Once', json], {
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 256 * 1024 * 1024,
  });
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

  // 崩溃实验会以非 0 退出码结束，这是预期行为，不是错误。
  const stdout = (res.stdout ?? '').trim();
  if (!stdout) {
    return {
      ok: false,
      code: 'INTERNAL_ERROR',
      message: `助手无输出（退出码 ${res.status}）：${(res.stderr ?? '').trim().slice(0, 500)}`,
      win32_error: 0,
      elapsed_ms: elapsedMs,
      exit_code: res.status,
    };
  }
  const parsed = JSON.parse(stdout.split(/\r?\n/).filter(Boolean).pop()!) as HelperResult;
  return { ...parsed, elapsed_ms: elapsedMs, exit_code: res.status };
}

/**
 * 常驻助手：一次 Add-Type 编译，之后按行收发 JSON。
 * 所有请求串行化，保证不会有两次调用交错写同一个句柄。
 *
 * ## 助手死掉时必须**只让这一次调用失败**
 *
 * 实测（LWB-016 证据）：助手在执行一串真实操作时退出，随后那次 `stdin.write`
 * 在已结束的管道上抛错。三处后果都不是「一次调用失败」而是更糟的东西：
 *
 *  - `stdin` 的 `'error'` 是 **Socket 的 error 事件**，没有监听器就是
 *    `uncaughtException` —— **整个进程被一次助手故障带走**，而这正是护栏
 *    存在的意义所在（不能让「读一个文件」失败变成「守护进程消失」）；
 *  - `#pending` 里排队的请求只会在收到数据时被兑现，助手死了就**永远挂着**
 *    （没有超时）—— 那是比报错更坏的状态：调用方分不清「慢」与「死」；
 *  - `stderr` 被管道接住却**没有人读**，写满管道缓冲区就会把助手**卡死**，
 *    而它留下的最后几句话正是唯一能解释死因的线索。
 *
 * 所以：接管两个 error 事件、在 exit 时兑现所有在途请求、顺手把 stderr
 * 收进一个有界缓冲（只留尾部，并且**只作为诊断信息**，绝不当结果）。
 */
export class ResidentHelper {
  #child: ChildProcessWithoutNullStreams | null = null;
  #buffer = '';
  #pending: Array<(value: HelperResult) => void> = [];
  #queue: Promise<unknown> = Promise.resolve();
  /** 助手留下的最后几句 stderr（有界）。仅用于说明**为什么**它不在了。 */
  #stderr = '';
  /** 助手已不在时的原因；非 null 即拒绝继续调用。 */
  #gone: string | null = null;

  /** 助手退出或通信通道失效后为 false；供后端安全地在下一次请求前重启。 */
  get isAlive(): boolean {
    return this.#child !== null &&
      this.#gone === null &&
      this.#child.exitCode === null &&
      this.#child.signalCode === null;
  }

  async start(): Promise<HelperResult> {
    this.#gone = null;
    this.#stderr = '';
    this.#child = spawn(PWSH, ['-NoProfile', '-NonInteractive', '-File', HELPER_PATH, '-Server'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.#child.stdout.setEncoding('utf8');
    this.#child.stdout.on('data', (chunk: string) => this.#onData(chunk));
    this.#child.stderr.setEncoding('utf8');
    this.#child.stderr.on('data', (chunk: string) => {
      // 有界：只留尾部。stderr 从来不是结果的一部分，它只是遗言。
      this.#stderr = `${this.#stderr}${chunk}`.slice(-4_000);
    });
    // 写失败的原因永远是「助手已经不在」，由下面的 exit 统一兑现给在途请求；
    // 这里接管事件只为阻止它变成 uncaughtException。
    this.#child.stdin.on('error', () => undefined);
    this.#child.on('error', (error) => this.#onGone(`无法启动助手：${error.message}`));
    this.#child.on('exit', (code, signal) => this.#onGone(`助手已退出（退出码 ${code ?? 'null'}，信号 ${signal ?? 'null'}）`));

    const ready = await new Promise<HelperResult>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('常驻助手启动超时（30s）')), 30_000);
      this.#pending.push((value) => {
        clearTimeout(timer);
        resolve(value);
      });
    });
    return ready;
  }

  /**
   * 助手不在了：兑现所有在途请求，并让之后每一次调用都立刻失败。
   *
   * 兑现的是一条**失败的**结果（`ok:false`），不是抛错 —— 调用方本来就按
   * 「结果可能是失败」来写，因此这一次的失败与「助手说它失败了」走同一条路。
   */
  #onGone(reason: string): void {
    if (this.#gone === null) {
      this.#gone = `${reason}${this.#stderr ? `；stderr：${this.#stderr.trim().slice(-500)}` : ''}`;
    }
    const waiting = this.#pending;
    this.#pending = [];
    for (const resolve of waiting) {
      resolve({ ok: false, code: 'NATIVE_GUARD_UNAVAILABLE', message: this.#gone, win32_error: 0 });
    }
  }

  #onData(chunk: string): void {
    this.#buffer += chunk;
    let idx = this.#buffer.indexOf('\n');
    while (idx >= 0) {
      const line = this.#buffer.slice(0, idx).trim();
      this.#buffer = this.#buffer.slice(idx + 1);
      if (line) {
        const resolve = this.#pending.shift();
        if (resolve) {
          try {
            resolve(JSON.parse(line) as HelperResult);
          } catch (error) {
            resolve({
              ok: false,
              code: 'INTERNAL_ERROR',
              message: `无法解析助手响应：${line.slice(0, 300)}`,
              win32_error: 0,
            });
          }
        }
      }
      idx = this.#buffer.indexOf('\n');
    }
  }

  /** 串行发送一个请求，返回助手响应（含本地测量耗时）。 */
  call(request: Record<string, unknown>): Promise<HelperResult & { elapsed_ms: number }> {
    const run = async (): Promise<HelperResult & { elapsed_ms: number }> => {
      if (!this.#child) throw new Error('常驻助手未启动');
      // 已经知道它不在了就别写：写在已结束的管道上抛的是管道错误，
      // 而真正的原因是助手为什么不在 —— 那条信息在这里更准确。
      if (this.#gone !== null) {
        return { ok: false, code: 'NATIVE_GUARD_UNAVAILABLE', message: this.#gone, win32_error: 0, elapsed_ms: 0 };
      }
      const started = process.hrtime.bigint();
      const response = await new Promise<HelperResult>((resolve) => {
        this.#pending.push(resolve);
        this.#child!.stdin.write(`${JSON.stringify(request)}\n`);
      });
      return { ...response, elapsed_ms: Number(process.hrtime.bigint() - started) / 1e6 };
    };
    const chained = this.#queue.then(run, run);
    this.#queue = chained.catch(() => undefined);
    return chained;
  }

  /** 助手最后一次留下的 stderr（有界）。诊断用，不是结果。 */
  diagnostics(): string {
    return this.#gone ?? (this.#stderr.trim() === '' ? '' : this.#stderr.trim().slice(-500));
  }

  async stop(): Promise<void> {
    if (!this.#child) return;
    if (!this.isAlive) {
      this.#child = null;
      return;
    }
    try {
      this.#child.stdin.write('__exit__\n');
      this.#child.stdin.end();
    } catch {
      /* 进程可能已经退出 */
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.#child?.kill();
        resolve();
      }, 3_000);
      this.#child!.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    this.#child = null;
  }
}

export function isHelperError(result: HelperResult): result is HelperResult & HelperError {
  return result.ok === false;
}

/** 统计工具：P50 / P95。样本不足时如实返回 null，不编造。 */
export function percentile(samples: number[], p: number): number | null {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(Math.max(rank - 1, 0), sorted.length - 1)]!;
}

export function round(value: number | null, digits = 2): number | null {
  if (value === null) return null;
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}
