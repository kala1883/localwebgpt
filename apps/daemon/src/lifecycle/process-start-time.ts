/**
 * 进程启动时刻查询（LWB-008 步骤 3，daemon 生命周期层）。
 *
 * 放在 `apps/daemon/src/lifecycle/` 而不是 `packages/ipc/`：
 * `packages/ipc` 是纯机制（租约与握手的规则），「怎么问 Windows 要进程信息」
 * 是平台相关的实现细节，分开放更好审计。
 *
 * ## 为什么必须起 PowerShell，而不是 `process.kill`
 *
 * `process.kill(pid, 0)` 只能回答「存在 / 不存在」，无法区分
 * **「还是原来那个进程」与「PID 被一个新进程复用了」**。
 * 租约接管恰好需要这个区分：把复用的 PID 当成旧持有者还活着，
 * 会永久拒绝接管；反过来把旧持有者当成已死，会让两个执行器同时写。
 *
 * ## 同步探针 + 异步填充的缓存
 *
 * `ProcessProbe.identify` 是**同步**签名，而查 PowerShell 天然是异步的。
 * 不用 `execFileSync` 把事件循环堵住 —— daemon 的事件循环被阻塞时，
 * 正在进行的写入会停在中途，而 I09/I11 明确不希望出现这种情况。
 *
 * 做法是 `StartTimeCache`：缓存里的值可以直接同步读；
 * 填充发生在**本来就有 await 的地方**（获取/续约租约时预取下一个可能的候选）。
 * 缓存里没有的 PID 返回 `null`，也就是「不知道」——
 * 于是租约按「无法排除 PID 复用」处理，保守判为还活着。
 *
 * 这条缝是刻意暴露的，不是疏漏：**取不到启动时刻时，接管会被拒绝**。
 */

import { execFile } from 'node:child_process';

/** 单次查询上限。启动 PowerShell 通常 200–600 ms。 */
const QUERY_TIMEOUT_MS = 5_000;

export class ProcessQueryUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProcessQueryUnavailableError';
  }
}

export interface StartTimeQueryOptions {
  readonly powershellPath?: string;
  readonly timeoutMs?: number;
  /** 注入点，测试用；默认走 `execFile`。 */
  readonly exec?: (
    file: string,
    args: readonly string[],
    env: NodeJS.ProcessEnv,
  ) => Promise<{ stdout: string; failed: boolean }>;
}

/**
 * pid 通过**环境变量**传入，不走 `-Command` 的尾随参数。
 *
 * 这不是风格选择，是一个实测过的坑：`pwsh -Command '<脚本>' 1234`
 * 会把 `1234` **拼接到脚本文本后面**，而不是放进 `$args`。实测报错为
 * `ParserError ... . [0] -ErrorAction Stop` —— 脚本被拼成了语法错误。
 * 也就是说原来的写法看起来成功执行了，实际上什么都没查。
 *
 * 环境变量既避开了这个行为，也免去了在脚本里插值数字（数字虽然安全，
 * 但「往命令行脚本里插值」这个习惯一旦养成就迟早会用到不安全的输入上）。
 */
const SCRIPT =
  '$ErrorActionPreference = "Stop"; ' +
  '$p = Get-Process -Id ([int]$env:LWB_PROBE_PID) -ErrorAction Stop; ' +
  '$p.StartTime.ToUniversalTime().ToString("o")';

/**
 * 查询一个**确实存在**的进程的启动时刻。
 *
 * @throws ProcessQueryUnavailableError 查询失败或结果无法解析。
 *   注意本函数不区分「进程不存在」—— 调用方应先用 `process.kill(pid, 0)`
 *   确认存在，再用本函数取时刻。把两种失败混在一个异常里，
 *   会让上游依赖 `Get-Process` 的报错文本，而那是个随时会变的实现细节。
 */
export async function queryProcessStartTime(
  pid: number,
  options: StartTimeQueryOptions = {},
): Promise<string> {
  const timeoutMs = options.timeoutMs ?? QUERY_TIMEOUT_MS;
  const run = options.exec ?? defaultExec;

  let result: { stdout: string; failed: boolean };
  try {
    result = await run(
      options.powershellPath ?? 'pwsh',
      ['-NoProfile', '-NonInteractive', '-Command', SCRIPT],
      { ...process.env, LWB_PROBE_PID: String(pid) },
    );
  } catch (error) {
    throw new ProcessQueryUnavailableError(
      `查询进程 ${pid} 启动时刻失败：${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const text = result.stdout.trim();
  if (result.failed || text.length === 0) {
    throw new ProcessQueryUnavailableError(`查询进程 ${pid} 启动时刻未得到有效结果。`);
  }

  const parsed = Date.parse(text);
  if (Number.isNaN(parsed)) {
    throw new ProcessQueryUnavailableError(`进程 ${pid} 的启动时刻无法解析：${text.slice(0, 64)}`);
  }
  return new Date(parsed).toISOString();

  function defaultExec(
    file: string,
    args: readonly string[],
    env: NodeJS.ProcessEnv,
  ): Promise<{ stdout: string; failed: boolean }> {
    return new Promise((resolve) => {
      execFile(
        file,
        [...args],
        { timeout: timeoutMs, windowsHide: true, maxBuffer: 64 * 1024, env },
        (error, stdout) => {
          resolve({ stdout: String(stdout), failed: error !== null });
        },
      );
    });
  }
}

/** 进程存在性判定，不需要起进程。 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM 表示进程存在但拿不到权限 —— 按**存在**处理。
    // 把 EPERM 当作「不存在」会在权限不足时放行接管，是危险的误判方向。
    return (error as { code?: unknown }).code !== 'ESRCH';
  }
}

/**
 * 启动时刻缓存：同步读、异步填充。
 *
 * 缓存**不设过期**。启动时刻一经确定就不会变，唯一需要担心的是
 * PID 复用 —— 而复用意味着同一个 PID 对应了另一个时刻，
 * 那正是我们**想**要发现的事：`ExecutorLease` 会比较缓存值与租约里记录的值，
 * 不同即判为旧持有者已不在。若给缓存设过期，反而会在过期后
 * 退化成「不知道」，把一个本可判定的情形变成必须拒绝的情形。
 */
export class StartTimeCache {
  readonly #entries = new Map<number, string>();
  readonly #options: StartTimeQueryOptions;

  constructor(options: StartTimeQueryOptions = {}) {
    this.#options = options;
  }

  /** 同步读。没有记录时返回 `null`（= 不知道，不是「不存在」）。 */
  get(pid: number): string | null {
    return this.#entries.get(pid) ?? null;
  }

  /**
   * 异步填充一条记录。
   *
   * 失败时**不抛**：调用点在获取租约的路径上，那里不该因为
   * 「查不到启动时刻」而整体失败 —— 租约仍然可以拿到，
   * 只是接管判定会更保守。把失败吞掉并把原因回传，让调用方决定是否记审计。
   */
  async refresh(pid: number): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (!isProcessAlive(pid)) {
      // 进程不存在时**清掉**旧记录：留着会让后来的同号新进程
      // 被误判成旧持有者。
      this.#entries.delete(pid);
      return { ok: false, reason: `进程 ${pid} 不存在。` };
    }
    try {
      const startedAt = await queryProcessStartTime(pid, this.#options);
      this.#entries.set(pid, startedAt);
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  /** 把缓存包装成同步 `ProcessProbe`。 */
  toProbe(): {
    identify(pid: number): { pid: number; started_at: string | null } | null;
  } {
    return {
      identify: (pid: number) => {
        if (!isProcessAlive(pid)) return null;
        return { pid, started_at: this.get(pid) };
      },
    };
  }
}
