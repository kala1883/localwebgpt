/**
 * LWB-033 · 故障注入的**装置**（真故障，不是模拟的失败值）。
 *
 * ## 这一组与前一组的分工
 *
 * `tests/windows/concurrency/` 注入的是**另一个写手**：第三方在窗口里动同一个
 * 文件。注入的动作是「别人做了一件正常的事」，而被验的是护栏挡不挡得住。
 *
 * 本组注入的是**机器本身**：助手进程死了、盘写了一半、状态库被锁住。
 * 被注入的是**故障**，而被验的是这套记账在故障之后还能不能说实话 ——
 * 尤其是它**不知道**的时候敢不敢说不知道。
 *
 * 两者的装置相同（`../windows/concurrency/rig.ts` 的 `openRig`），因为
 * 「一次真实的执行」这件事只有一种搭法：真 NTFS 目录、真护栏、真修改集、
 * 真批准、真协调器。
 *
 * ## 三条纪律
 *
 * 1. **故障必须真的发生。** 短写这一格调用的是护栏自己的
 *    `crashExperiment half_write_then_crash`：真 `SetEndOfFile`、真
 *    `WriteFile` 半份、真 `[Environment]::Exit(43)`。装置不构造
 *    「看起来像失败的返回值」—— 那种注入验的是调用方与测试自己写的假护栏
 *    对不对得上，与这台机器无关。
 *
 * 2. **注入没落地就要吵。** 每一次注入都带一句自查（`crashInWrite` 里
 *    「助手还活着」的那次抛、`killGuardPid` 里「进程表里还看得见」的那次抛）。
 *    一次「注入没生效、于是执行正常成功」的用例，会因为「没报 APPLIED」的
 *    断言而**变绿** —— 那是本仓库最不能接受的一种绿。
 *
 * 3. **断言打在磁盘、账本与进程表上，不打在措辞上。** 报告里说了什么只是
 *    线索；`readFile` 读回来的字节、`journal_entries` 里的阶段、以及
 *    `Win32_Process` 里还在不在，才是这组用例的判据。
 *
 * ## 装置**不转发**写入：故障之后的每一步都走生产代码
 *
 * 本文件曾经有一个 `withInjectedWrite`：在 `WinfsOps` 外面包一层，把写入
 * 转发给一个「已经被弄死」的助手。它被删掉了，理由是它在验自己 ——
 * 转发层与 `PowerShellWinfsBackend.#call` 不是同一份代码，而两者对
 * 「助手已经不在」的处理**确实不一样**（见下面 `assertGuardGone` 的注释）。
 *
 * 现在故障注入只做两件真事（在竞争装置的 `withRace` 那一格里）：让助手以
 * 崩溃实验退出、把护栏助手从进程表里杀掉。**此后调用方走的每一个字节都是
 * 生产路径** —— `PowerShellWinfsBackend.#call` → `ResidentHelper.call` →
 * `#onGone` 合成的那条失败 → `toError` 透传 → `apply.ts` 分类。这条链上
 * 没有一行是为了测试写的。
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';

import { closeDatabase, openDatabase } from '@lwb/persistence';
import { isWinfsError, ResidentHelper, type PowerShellWinfsBackend } from '@lwb/winfs';
import type { WinfsError } from '@lwb/winfs';

import { sha256 } from '../windows/concurrency/rig.ts';

export { sha256 };

/** 跑一段 PowerShell（装置用，与 `tests/windows/path-escape/helpers.ts` 同法）。 */
export function ps(command: string): string {
  const res = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', command], {
    encoding: 'utf8',
    timeout: 60_000,
  });
  return `${res.stdout ?? ''}${res.stderr ?? ''}`.trim();
}

// ---------------------------------------------------------------------------
// 真·短写：护栏自己的崩溃实验
// ---------------------------------------------------------------------------

/** `WinfsGuard.ps1` 的 `Op-CrashExperiment` 支持的两种模式。 */
export type CrashMode = 'truncate_then_crash' | 'half_write_then_crash';

/** 一次护栏写入调用需要的全部字段（与 `Op-WriteFileGuarded` 的入参同形）。 */
export interface GuardedWriteRequest {
  readonly root_path: string;
  readonly root_volume_id: string;
  readonly root_file_id: string;
  readonly relative_path: string;
  readonly expected_sha256: string;
  readonly expected_file_id?: string;
  readonly content_base64: string;
}

/**
 * 让**这个助手进程**在写入中途真的死掉，并在盘上留下真的半截。
 *
 * 它的效果是三个真实事件，不是一个返回值：
 *
 * | 事件 | 怎么发生的 | 怎么看得出来 |
 * | --- | --- | --- |
 * | 文件被截断 | `SetEndOfFile` | 长度变成 `floor(len/2)` 或 `0` |
 * | 只写了一半 | `WriteFile(half)` | 字节逐位等于目标的前半段 |
 * | 助手进程没了 | `[Environment]::Exit(42\|43)` | `Win32_Process` 里查不到它 |
 *
 * 返回值是**助手死掉时在途请求拿到的那条失败**（`#onGone` 合成的），
 * 本函数顺带断言它真的带着这次崩溃的退出码 —— 于是「故障落地了没有」
 * 这件事在注入点就被钉住，而不是等调用方那边看结果猜。
 */
export async function crashInWrite(
  injector: ResidentHelper,
  req: GuardedWriteRequest,
  mode: CrashMode = 'half_write_then_crash',
): Promise<WinfsError> {
  const result = await injector.call({ op: 'crashExperiment', mode, ...req });
  if (result.ok === true) {
    // 注入没落地。这一句必须吵：一次「故障没发生、于是正常写成」的运行
    // 会让本文件里所有「没报 APPLIED」的断言一起变绿。
    throw new Error('崩溃实验竟然正常返回了：助手还活着，故障没有落地');
  }
  // 助手已经死了，因此这就是 `#onGone` 合成的那一条 —— 形状由
  // `helper-client.ts` 的 `#onGone` 保证，这里如实读它。
  const error = result as unknown as WinfsError;
  assertGoneByCrash(error, mode === 'truncate_then_crash' ? 42 : 43);
  return error;
}

/**
 * 断言一条失败是**助手真的死了**造成的，而不是装置手写的。
 *
 * 判据是退出码：`ResidentHelper.#onGone` 把 `exit` 事件里的码拼进消息，
 * 而 42/43 只有崩溃实验会产生。
 */
export function assertGoneByCrash(error: WinfsError, exitCode: 42 | 43): void {
  assert.equal(error.code, 'NATIVE_GUARD_UNAVAILABLE', `期望「护栏不可用」，实际：${JSON.stringify(error)}`);
  assert.match(
    error.message,
    new RegExp(`退出码 ${exitCode}`),
    `这条失败必须来自真实的进程退出（退出码 ${exitCode}），而不是装置写的一句话：${error.message}`,
  );
}

/**
 * 断言调用方拿到的失败**是护栏不可用**，并且来自一次真实的进程退出。
 *
 * 与 `assertGoneByCrash` 的分工：那一条用在**注入点**（退出码是我们挑的
 * 那个），这一条用在**调用方**（退出码取决于谁杀的、怎么杀的，因此只断言
 * 「它确实是 `#onGone` 合成的」）。
 *
 * 判据是「助手已退出（退出码 …）」这半句 —— 它只可能由 `exit` 事件拼出来。
 * 与之相对的两条路一个都不带它：`ResidentHelper.call` 在 `#child` 为空时抛
 * 的那句 `常驻助手未启动`（一个普通 `Error`，被 `#call` 包成
 * 「护栏助手通信失败：…」），以及 `#unavailable` 拼的「能力自检没过」。
 * 三条路都叫 `NATIVE_GUARD_UNAVAILABLE`，而只有一条说明**进程真的死过**。
 */
export function assertGuardGone(error: WinfsError): void {
  assert.equal(
    error.code,
    'NATIVE_GUARD_UNAVAILABLE',
    `期望「护栏不可用」，实际：${JSON.stringify(error)}`,
  );
  assert.match(
    error.message,
    /助手已退出（退出码 \d+/,
    `这条失败必须来自 exit 事件（「助手已退出（退出码 …）」），而不是别的「不可用」：${error.message}`,
  );
}

// ---------------------------------------------------------------------------
// 真·进程退出：把护栏助手杀掉
// ---------------------------------------------------------------------------

/**
 * 本进程名下的护栏助手 PID。
 *
 * 助手是 `ResidentHelper` 用 `spawn` 直接起的子进程，因此父进程就是运行
 * 这些用例的那个 node 进程 —— 按 `ParentProcessId` 过滤既精确又不需要
 * 任何权限。`-Force` 杀一个已经死掉的 PID 不会报错（`Stop-Process` 会，
 * 因此过滤交给 `Get-Process`）。
 *
 * ## `$PID` 那一句不是修辞
 *
 * 查询本身也是**这个 node 进程的一个 pwsh 子进程**，而它的命令行里就写着
 * 这段过滤器 —— 于是它同时满足两个条件（父进程是本进程、命令行里出现
 * `WinfsGuard.ps1`），**每一次调用都会把自己数进去**。
 *
 * 这个缺陷是 LWB-033 的证据脚本撞出来的：`scripts/evidence/lwb-033.ts` §7.1
 * 断言「进程表里恰好一个助手」时拿到了两个 PID。杀伤面不止于多一个数：
 * 「助手还在不在」正是这组用例里唯一用来证明**故障真的落地了**的观察，
 * 而一个每次都比实际多一个的探测器会让「还看得见」与「已经不在」这两句话
 * 同时变得不可信。判据因此必须是自己数自己数不进去。
 */
export function guardHelperPids(): number[] {
  const out = ps(
    `@(Get-CimInstance Win32_Process -Filter "ParentProcessId=${String(process.pid)}" |` +
      ` Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -like '*WinfsGuard.ps1*' } |` +
      ` ForEach-Object { $_.ProcessId }) -join ','`,
  );
  return out === '' ? [] : out.split(',').map((s) => Number(s.trim()));
}

/**
 * 真的把护栏助手从进程表里去掉，并**等到它真的不在**。
 *
 * 「杀掉」与「已经不在」是两件事：`Stop-Process` 返回时进程可能还在退出路上，
 * 而 Node 侧的 `exit` 事件是**之后**才排到事件循环里的。因此这里等到
 * `Win32_Process` 里查不到它为止 —— 那一步之后 `#onGone` 必然已经（或即将）
 * 跑过，调用方接下来拿到的失败就一定带着「助手已退出（退出码 …）」这半句。
 *
 * 等不到就抛：一次「其实没杀掉」的注入会让本文件所有「没报 APPLIED」的断言
 * 一起变绿，而那正是这组用例存在的理由。
 */
export async function killGuardHelpers(timeoutMs = 20_000): Promise<number[]> {
  const pids = guardHelperPids();
  if (pids.length === 0) return [];
  ps(`Get-Process -Id ${pids.join(',')} -ErrorAction SilentlyContinue | Stop-Process -Force`);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const alive = guardHelperPids().filter((pid) => pids.includes(pid));
    if (alive.length === 0) return pids;
    if (Date.now() > deadline) {
      throw new Error(`护栏助手没有真的退出（还剩 ${alive.join(',')}）—— 故障没有落地`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

// ---------------------------------------------------------------------------
// 真·数据库忙：第二个连接占住写锁
// ---------------------------------------------------------------------------

export interface Locker {
  /** 拿住写锁（`BEGIN IMMEDIATE`）。已经在手上时是空操作。 */
  hold(): void;
  /** 松开。没拿住时是空操作 —— 清理路径不该因为「本来就没锁」而抛。 */
  release(): void;
  readonly held: boolean;
  readonly close: () => void;
}

/**
 * 用**第二个连接**占住状态库的写锁。
 *
 * 这一格在内存库上造不出来：`:memory:` 的两个连接是两个**不同的库**，
 * 因此「忙」在内存库上没有对应的真实机制，只能模拟 —— 而模拟出来的忙
 * 验的是测试自己写的那句话。真文件库上它是内核的字节范围锁，
 * 与生产里「另一个进程正在提交」完全同源。
 *
 * 忙等上界取一个小值（默认 250 ms）：本装置要的是「锁着的时候写入被拒」，
 * 而不是「等 5 秒之后被拒」—— 后者只是让用例变慢。
 */
export function openLocker(dbPath: string, busyTimeoutMs = 250): Locker {
  // 打开它自己会跑迁移（rig 已经迁移过，是空操作），随后才可能拿锁。
  const opened = openDatabase({ path: dbPath, busyTimeoutMs });
  let held = false;
  return {
    get held() {
      return held;
    },
    hold() {
      if (held) return;
      opened.db.exec('BEGIN IMMEDIATE');
      held = true;
    },
    release() {
      if (!held) return;
      opened.db.exec('COMMIT');
      held = false;
    },
    close: () => {
      if (held) {
        opened.db.exec('COMMIT');
        held = false;
      }
      closeDatabase(opened.db);
    },
  };
}

// ---------------------------------------------------------------------------
// 磁盘上的字节
// ---------------------------------------------------------------------------

/**
 * 一个文件的字节。
 *
 * 判据用它而不是用报告里的措辞：报告与状态库都可能说错，字节不会。
 */
export function bytesAt(abs: string): Promise<Buffer> {
  return readFile(abs);
}

/** 断言一个护栏读结果成功并给出字节。失败时把错误印出来，而不是抛一句「undefined」。 */
export function readBytes(result: Awaited<ReturnType<PowerShellWinfsBackend['readFileGuarded']>>): Buffer {
  if (isWinfsError(result)) throw new Error(`readFileGuarded 失败：${result.code} ${result.message}`);
  return Buffer.from(result.bytes_base64, 'base64');
}

export type { WinfsError };
