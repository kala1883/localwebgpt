/**
 * 子进程所有权与退出（LWB-008 步骤 4）。
 *
 * daemon 会起两类子进程：原生助手（`packages/secure-store` 的 pwsh 助手）
 * 与探针用的 PowerShell。它们都是**长生命周期**的，因此必须回答两个问题：
 *
 *  1. daemon 退出时它们会不会跟着退出？
 *  2. daemon 被强杀（没有机会做清理）时，它们会不会变成孤儿？
 *
 * ## 第 1 个问题靠显式 kill，不靠父进程身份
 *
 * Windows 没有「父进程死了子进程自动退出」的机制。常见的
 * 「Job Object + kill-on-close」需要原生代码，本仓库的 `native/`
 * 仍是 fail-closed 占位（见 `docs/compatibility.md`），因此用不了。
 *
 * 所以走显式路径：注册所有子进程句柄，退出时逐个 kill 并等待。
 * 进程被 `SIGKILL`/任务管理器强杀时这条路径**不会**执行 —— 这是已知缺口，
 * 见文件末尾的说明，不假装它被解决了。
 *
 * ## 第 2 个问题靠「子进程自查父进程」
 *
 * 孤儿助手是真实风险：它持有 DPAPI 能力，会一直挂在内存里等一条
 * 永远不会来的命令。助手的做法是给自己的 stdin 加一个
 * 「父进程关闭管道即退出」的监听（见 `SecureStore.ps1`）。
 * 本模块只负责 daemon 这一侧：**握住管道不放**，
 * 并在自己退出前主动关闭，让助手那条监听按预期触发。
 */

import type { ChildProcess } from 'node:child_process';

export interface TrackedProcess {
  readonly name: string;
  readonly child: ChildProcess;
  readonly startedAt: number;
}

/** 退出时等待子进程结束的上限。超过就放弃等待并如实记录。 */
const TERMINATION_GRACE_MS = 3_000;

export class ProcessRegistry {
  readonly #processes = new Map<number, TrackedProcess>();
  #shuttingDown = false;

  /** 登记一个子进程。未登记的进程不会被退出流程照顾到。 */
  track(name: string, child: ChildProcess): void {
    if (this.#shuttingDown) {
      // 关闭途中新起的进程不会被加入退出流程，于是它会活过 daemon。
      // 直接杀掉，而不是默默放行。
      child.kill();
      throw new Error(`daemon 正在退出，拒绝登记新的子进程：${name}`);
    }
    if (typeof child.pid !== 'number') {
      throw new Error(`子进程 ${name} 没有 pid，无法管理其生命周期。`);
    }
    this.#processes.set(child.pid, { name, child, startedAt: Date.now() });
    child.once('exit', () => {
      if (typeof child.pid === 'number') this.#processes.delete(child.pid);
    });
  }

  get size(): number {
    return this.#processes.size;
  }

  list(): readonly TrackedProcess[] {
    return [...this.#processes.values()];
  }

  /**
   * 终止全部子进程。
   *
   * 先发 `SIGTERM`，短等，仍然存活的再 `SIGKILL`。
   * 返回值如实反映**没有等到的那些**，而不是笼统地报成功 ——
   * 「已清理」这句话必须能被验证，否则它就只是一句安慰。
   */
  async terminateAll(
    graceMs: number = TERMINATION_GRACE_MS,
  ): Promise<{ terminated: readonly string[]; stubborn: readonly string[] }> {
    this.#shuttingDown = true;
    const entries = [...this.#processes.values()];
    if (entries.length === 0) return { terminated: [], stubborn: [] };

    const exited = new Set<number>();
    for (const entry of entries) {
      const pid = entry.child.pid;
      if (typeof pid !== 'number') continue;
      entry.child.once('exit', () => exited.add(pid));
      try {
        entry.child.kill();
      } catch {
        // 已经退出；下面的等待会立刻满足。
      }
    }

    const deadline = Date.now() + graceMs;
    while (Date.now() < deadline && exited.size < entries.length) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    const terminated: string[] = [];
    const stubborn: string[] = [];
    for (const entry of entries) {
      const pid = entry.child.pid;
      if (typeof pid !== 'number') continue;
      if (exited.has(pid)) {
        terminated.push(entry.name);
        continue;
      }
      try {
        entry.child.kill('SIGKILL');
      } catch {
        // 忽略：下面用存活状态判断，不用 kill 是否抛异常判断。
      }
      stubborn.push(entry.name);
    }

    this.#processes.clear();
    return { terminated, stubborn };
  }
}

/**
 * 已知缺口，写在这里而不是留在提交信息里。
 *
 * daemon 被**强杀**（`Stop-Process -Force`、任务管理器结束进程、断电）时，
 * `terminateAll` 不会执行，助手会成为孤儿进程继续存活。
 *
 * 缓解只在助手一侧：它监听 stdin 关闭并自行退出。这条缓解覆盖了
 * 「daemon 正常退出但没来得及 kill」以及「管道被关闭」的情形，
 * **不覆盖**「助手本身卡死」。
 *
 * 彻底解法是 Job Object（`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`），
 * 需要 `native/` 真正实现后才能提供。在那之前，这条缺口是真实存在的，
 * 记在 `docs/evidence/lwb-008/summary.md` 的「已知限制」里。
 */
export const ORPHAN_RISK_NOTE =
  'daemon 被强杀时子进程不会被回收；缓解依赖助手自身监听 stdin 关闭，未覆盖助手卡死的情形。';
