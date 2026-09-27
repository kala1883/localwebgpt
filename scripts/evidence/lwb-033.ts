/**
 * LWB-033 可复现证据采集：**竞争、崩溃与故障专项**。
 *
 * 装置与 LWB-025~032 同一套（真 NTFS + 真护栏 + 真状态库 + 真协调器），
 * 但这一份注入的不是「一次更难的调用」，而是**这台机器上的坏事**：
 *
 * ```text
 *   真 NTFS 文件 + 真 PowerShellWinfsBackend + 真 WinfsGuard.ps1
 *     → 真第三方动作（Node 的 rename/rm/writeFile/chmod，或护栏自己的 holdHandle）
 *     → 真协调器 + 真 createNativeApplier
 *     → 判据：盘上的字节、文件身份、条目日志、状态库的行
 * ```
 *
 * ## 逐条对应任务书
 *
 *  步骤 1「覆盖并行保存、同内容换文件身份、目录交换、目标创建竞争、文件占用
 *  和权限变化」—— §1 ~ §6。
 *  步骤 2「覆盖断网、服务退出、原生辅助进程退出、磁盘满、短写、刷盘错误和
 *  数据库忙」—— §7（原生辅助进程退出 + 短写）、§8（数据库忙）、
 *  §9（结构性地证明断网没有故障面）、§10.3（服务退出：真 SIGKILL 一个执行者）、
 *  §11（磁盘满、刷盘错误与一条更窄的死亡形态如实记 NOT_RUN 及理由）。
 *  步骤 3「每个持久化边界反复执行故障注入并核对授权外文件、实际字节和恢复日志」
 *  —— §8.5（三轮）、§10（每一格的看门文件与逐条目日志）。
 *
 *  验收 1「未授权文件保持不变；无并发覆盖、重复追加和错误的 APPLIED」
 *  —— §0.4（看门文件是固定构件）+ 每一格的 `state !== APPLIED` 与「第三方字节原样」。
 *  验收 2「第三种状态不会自动覆盖」—— §3。
 *  验收 3「G4 未通过时 direct_write 永远不对真实目录启用」—— §11。
 *
 * ## 本文件里哪些断言是「真的」
 *
 *  - 「没写」用**盘上的字节**证，并用**文件身份**补一刀（同内容换身份那一格
 *    如果只比哈希，它验的就是哈希比对，而不是身份比对）；
 *  - 「第三方的那一份还在」用**逐字节相等**证，而不是「没报 APPLIED」——
 *    报告与状态库都可能说错，字节不会；
 *  - 「故障真的落地了」用**注入点自带的自查**证（`crashInWrite` 里
 *    「助手还活着」的那次抛、`killGuardHelpers` 里「进程表里还看得见」的那次抛）。
 *    一次「注入没生效、于是执行正常成功」的运行，会因为「没报 APPLIED」的
 *    断言而变绿 —— 那是本仓库最不能接受的一种绿。
 *
 * 用法：node --import tsx scripts/evidence/lwb-033.ts
 * 退出码：全部通过 0；任一项失败 1。
 *
 * 本文件**证明不了**的事逐条列在 §11 并标 `NOT_RUN`。
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { chmod, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { guardFailureFacts, guardVerdict, ITEM_STAGE } from '@lwb/executor';
import { closeDatabase, openDatabase } from '@lwb/persistence';
import { isWinfsError, PowerShellWinfsBackend, ResidentHelper } from '@lwb/winfs';
import type { WinfsError } from '@lwb/winfs';

import {
  crashInWrite,
  guardHelperPids,
  killGuardHelpers,
  openLocker,
} from '../../tests/fault-injection/fault-rig.ts';
import type { GuardedWriteRequest } from '../../tests/fault-injection/fault-rig.ts';
import {
  openRig,
  sha256,
  thirdPartyReplacesWithSameBytes,
  thirdPartySwapsDirectory,
  withRace,
} from '../../tests/windows/concurrency/rig.ts';
import type { CanarySnapshot, ConcurrencyRig } from '../../tests/windows/concurrency/rig.ts';

// ---------------------------------------------------------------------------
// 脚手架
// ---------------------------------------------------------------------------

let failures = 0;
let passes = 0;
let skips = 0;

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    passes += 1;
    console.log(`PASS ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    failures += 1;
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function note(name: string, detail: string): void {
  console.log(`NOTE ${name} — ${detail}`);
}

function section(title: string): void {
  console.log(`\n== ${title} ==`);
}

function skip(name: string, why: string): void {
  skips += 1;
  console.log(`NOT_RUN ${name} — ${why}`);
}

async function guarded(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (cause) {
    const error = cause as { code?: string; message?: string; details?: unknown; stack?: string };
    check(`${name} 段跑完`, false, `${error.code ?? '(无错误码)'}：${error.message ?? String(cause)}`);
    if (error.details !== undefined) console.log(`      details=${JSON.stringify(error.details)}`);
    if (error.stack) console.log(`      ${error.stack.split('\n').slice(1, 4).join('\n      ')}`);
  }
}

/** 脱敏判据：证据里不得出现本机绝对路径。 */
const leaksLocalPaths = (text: string): boolean => /[A-Za-z]:\\|\/tmp\/|\/home\/|\/Users\//.test(text);

function checkRedacted(name: string, text: string): void {
  const leaked = leaksLocalPaths(text);
  const sample = /[A-Za-z]:\\[^\s"'）)，。]*/.exec(text)?.[0]?.slice(0, 60) ?? '(没找到路径片段)';
  check(name, !leaked, leaked ? `泄漏片段：${sample}` : '');
}

/** 哈希只留前 12 位：够核对，不足以还原内容。 */
const shortHash = (value: string | null | undefined): string =>
  typeof value === 'string' ? `${value.slice(0, 12)}…(${value.length})` : '?';

const same = (a: Uint8Array | Buffer, b: Uint8Array | Buffer): boolean => sha256(a) === sha256(b);

/** 逐条目日志里记下的错误码（`null` 的不算）。判据用它而不是用报告里的措辞。 */
const readEventCodes = (r: ConcurrencyRig): string[] =>
  r
    .ledger()
    .events.map((event) => event.error_code)
    .filter((code): code is string => typeof code === 'string' && code !== '');

// ---------------------------------------------------------------------------
// 装置
// ---------------------------------------------------------------------------

let sandbox = '';
let backend!: PowerShellWinfsBackend;
const rigs: ConcurrencyRig[] = [];

const rigOf = async (
  seed: string,
  options: Parameters<typeof openRig>[3] = {},
): Promise<ConcurrencyRig> => {
  const rig = await openRig(sandbox, backend, seed, options);
  rigs.push(rig);
  return rig;
};

/** 一次执行的终局，压成一行字，供断言失败时看真实原因。 */
function why(outcome: Awaited<ReturnType<ConcurrencyRig['runWith']>>): string {
  return outcome.kind === 'finished'
    ? `state=${outcome.state} detail=${outcome.detail.slice(0, 200)}`
    : outcome.kind === 'idle'
      ? 'idle（队列里没有可执行的）'
      : `refused：${JSON.stringify(outcome).slice(0, 200)}`;
}

/** 一条「这次没写成」的完整判据：结论 + 盘上字节 + 逐条目日志 + 看门文件。 */
async function expectRefusedWrite(
  label: string,
  r: ConcurrencyRig,
  canaries: CanarySnapshot,
  outcome: Awaited<ReturnType<ConcurrencyRig['runWith']>>,
  expected: {
    readonly state?: string;
    readonly detail?: RegExp;
    readonly onDisk?: Buffer;
    /**
     * 逐条目日志应当长什么样。
     *
     * `'untouched'`（默认）＝ 执行**进过 `APPLYING`**：记过执行意图，护栏在
     * 动笔那一步拒绝，于是留下「意图 → 没动过」。
     *
     * `'none'` ＝ 执行在**阶段 A**（核对）就退出了：那时 `recordIntent` 还没
     * 跑，逐条目日志一条都不该有。这一格不能沿用默认判据 —— 它会要求一条
     * 按设计不该存在的记录，于是把一次**更安全**的退出判成失败。
     */
    readonly journal?: 'untouched' | 'none';
  },
): Promise<void> {
  check(`${label}：协调器交回了结论`, outcome.kind === 'finished', why(outcome));
  if (outcome.kind !== 'finished') return;
  check(`${label}：**没有错误的 APPLIED**`, outcome.state !== 'APPLIED', `state=${outcome.state}`);
  if (expected.state !== undefined) {
    check(`${label}：终局是 ${expected.state}`, outcome.state === expected.state, `state=${outcome.state}`);
  }
  if (expected.detail !== undefined) {
    check(
      `${label}：失败原因指名了 ${String(expected.detail)}`,
      expected.detail.test(outcome.detail),
      `detail=${outcome.detail.slice(0, 200)}`,
    );
  }
  const onDisk = await r.onDisk();
  check(
    `${label}：盘上是我们期望的那一份字节`,
    same(onDisk, expected.onDisk ?? r.baseline),
    `sha256=${shortHash(sha256(onDisk))} 期望=${shortHash(sha256(expected.onDisk ?? r.baseline))}`,
  );
  check(
    `${label}：目标字节一个都没落下去`,
    !same(onDisk, r.target),
    `盘上=${shortHash(sha256(onDisk))} 我们的目标=${shortHash(sha256(r.target))}`,
  );
  const stages = r.stagesOf();
  // 看门文件这一条**两条路都要跑**：它是「授权外文件保持不变」的判据，
  // 而一个「因为退出得早所以没验」的窟窿，正好落在最该验的那一格上。
  await r.expectCanariesIntact(canaries);
  if (expected.journal === 'none') {
    check(`${label}：一个条目日志都没有`, stages.length === 0, `阶段=${stages.join(' → ') || '(空)'}`);
    // 「没有日志」单独看是一句含糊的话（也可能是「什么都没记」）。它在这里
    // 成立，靠的是**终局状态只可能是写之前的那一步**：`finalizeSources` 里
    // `APPLYING → CONFLICT` 不是一条边，因此 CONFLICT 这个终局本身就证明了
    // 这次执行从未进入 `APPLYING` —— 而没有进入过 `APPLYING` 的执行，
    // 按 `apply.ts` 阶段 B 的注释，就是「字节不可能已经落盘」的执行。
    check(
      `${label}：终局只可能来自写之前（CONFLICT 不是 APPLYING 的后继）`,
      outcome.state === 'CONFLICT',
      `state=${outcome.state}`,
    );
    return;
  }
  check(
    `${label}：账上留下「没动过」且没有「写了」`,
    stages.includes(ITEM_STAGE.untouched) && !stages.includes(ITEM_STAGE.written),
    `阶段=${stages.join(' → ') || '(空)'}`,
  );
}

/** 用**护栏自己**的眼睛看一个文件的身份与哈希。脚本不另算一份。 */
async function identityOf(
  r: ConcurrencyRig,
  relative: string = r.rel,
): Promise<{ readonly file_id: string; readonly sha256: string; readonly size: number }> {
  const volume = await backend.statVolume({ path: r.dir });
  if (isWinfsError(volume)) throw new Error(`statVolume 失败：${volume.message}`);
  const read = await backend.readFileGuarded({
    root_path: r.dir,
    root_volume_id: volume.volume_id,
    root_file_id: volume.file_id,
    relative_path: relative,
  });
  if (isWinfsError(read)) throw new Error(`readFileGuarded 失败：${read.code} ${read.message}`);
  return { file_id: read.identity.file_id, sha256: read.sha256, size: read.size };
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

const RESULTS: { readonly label: string; readonly detail: string }[] = [];
const record = (label: string, detail: string): void => {
  RESULTS.push({ label, detail });
};

async function main(): Promise<void> {
  sandbox = mkdtempSync(path.join(os.tmpdir(), 'lwb-033-ev-'));
  backend = new PowerShellWinfsBackend();

  // -------------------------------------------------------------------------
  section('§0 装置自检：这一轮的证据是在什么上面采的');
  // -------------------------------------------------------------------------

  await guarded('§0', async () => {
    const capability = await backend.capability();
    check(
      '§0.1 原生护栏后端可用（真 CreateFileW / WriteFile / 真共享模式）',
      capability.available === true,
      `backend=${capability.backend} exclusive_handle=${String(capability.supports_exclusive_handle)} flush=${String(capability.supports_flush)}${capability.available ? '' : ` reason=${capability.resolved_backend_reason}`}`,
    );
    check(
      '§0.2 跨文件事务为假（I11：一次执行的原子性不覆盖用户文件）',
      capability.cross_file_transaction === false,
      `crash_atomic_replace=${String(capability.crash_atomic_replace)}`,
    );
    note('§0.3 平台', `${process.platform} ${process.arch} / Node ${process.version}`);

    const r = await rigOf('selfcheck');
    const volume = await backend.statVolume({ path: r.dir });
    check(
      '§0.4 工作区根是一个真 NTFS 目录，身份由**当场探测**得到',
      isWinfsError(volume) === false && volume.is_directory === true,
      isWinfsError(volume) ? volume.message : `volume_id=${shortHash(volume.volume_id)} file_id=${shortHash(volume.file_id)}`,
    );

    // 看门文件：每一格都带的固定构件。这里先证明它们**真的存在**且可指纹 ——
    // 一个「看门文件根本不存在」的装置会让所有 `expectCanariesIntact` 空转。
    const canaries = await r.canaries();
    check(
      '§0.5 两个授权外看门文件真的在盘上（工作区内一个、工作区外一个）',
      statSync(canaries.inside_path).isFile() && statSync(canaries.outside_path).isFile(),
      `inside=${statSync(canaries.inside_path).size} 字节 outside=${statSync(canaries.outside_path).size} 字节`,
    );

    // 状态库的忙等窗口用真文件库验一次：这一格是所有「数据库忙」断言的前提。
    const dbFile = path.join(sandbox, 'selfcheck-lock.sqlite');
    const opened = openDatabase({ path: dbFile, busyTimeoutMs: 250 });
    const locker = openLocker(dbFile, 250);
    try {
      locker.hold();
      let refused = false;
      try {
        opened.db.transaction(() => undefined).immediate();
      } catch {
        refused = true;
      }
      check('§0.6 `openLocker` 占住的写锁是真的（另一个连接此刻写不进去）', refused);
      locker.release();
    } finally {
      locker.close();
      closeDatabase(opened.db);
    }
  });

  // -------------------------------------------------------------------------
  section('§1 并行保存：第三方在阶段 A 之后覆盖了目标（步骤 1，验收 1）');
  // -------------------------------------------------------------------------

  await guarded('§1', async () => {
    const r = await rigOf('save');
    const canaries = await r.canaries();
    const theirs = Buffer.concat([Buffer.from('theirs-zhengju\r\n第二行\r\n', 'utf8')]);

    const outcome = await r.runWith(
      withRace(
        [{ before: 'writeFileGuarded', act: async () => { await writeFile(r.abs(), theirs); } }],
        backend,
        r.ctx,
      ),
    );

    await expectRefusedWrite('§1.1', r, canaries, outcome, {
      state: 'ROLLED_BACK',
      detail: /FILE_VERSION_CONFLICT/,
      onDisk: theirs,
    });
    check('§1.2 盘上就是第三方保存的那一份（逐字节）', same(await r.onDisk(), theirs));
    check(
      '§1.3 报告如实说明盘上已不是基线（不自相矛盾）',
      outcome.kind === 'finished' &&
        /与基线不同/.test(outcome.detail) &&
        !/工作区回到执行之前的样子/.test(outcome.detail),
      outcome.kind === 'finished' ? outcome.detail.slice(0, 160) : '',
    );
    if (outcome.kind === 'finished') checkRedacted('§1.4 报告里不含本机绝对路径', outcome.detail);

    // 对照：同一个夹具、去掉注入 ⇒ 必须写成。没有这一条，上面那句「被挡住」
    // 与一个「这个夹具本来就写不成」的世界无法区分。
    const control = await rigOf('save-control');
    const controlOutcome = await control.runWith(backend);
    check(
      '§1.5 对照：无人竞争时必须写成（否则 §1.1 验的是空气）',
      controlOutcome.kind === 'finished' && controlOutcome.state === 'APPLIED',
      why(controlOutcome),
    );
    check('§1.6 对照：盘上就是我们的目标字节', same(await control.onDisk(), control.target));
  });

  // -------------------------------------------------------------------------
  section('§2 同内容换文件身份：字节一样、对象换了（步骤 1，I05）');
  // -------------------------------------------------------------------------

  await guarded('§2', async () => {
    const r = await rigOf('same-bytes');
    const canaries = await r.canaries();
    const before = await identityOf(r);
    // 装在一个盒子里而不是一个 `let`：写入是在**回调里**发生的，而 TS 的
    // 控制流分析看不见回调里的赋值 —— 它会认定这里永远是 `null`，
    // 于是下面那句自查被收窄成 `never`。
    const after: { value: { file_id: string; sha256: string } | null } = { value: null };

    const outcome = await r.runWith(
      withRace(
        [
          {
            before: 'writeFileGuarded',
            act: async () => {
              await thirdPartyReplacesWithSameBytes(r.abs());
              // 注入自查：真的做到了「字节不变、身份变了」吗。
              // 少了这两句，下面的断言可能只是因为内容变了而通过 ——
              // 那样验的就是哈希比对，而不是身份比对。
              after.value = await identityOf(r);
            },
          },
        ],
        backend,
        r.ctx,
      ),
    );

    const swapped = after.value;
    check(
      '§2.0 装置自查：注入真的换掉了对象，而字节**一模一样**',
      swapped !== null && swapped.file_id !== before.file_id && swapped.sha256 === before.sha256,
      swapped === null
        ? '注入根本没跑'
        : `file_id ${shortHash(before.file_id)} → ${shortHash(swapped.file_id)}，sha256 相同=${String(swapped.sha256 === before.sha256)}`,
    );
    await expectRefusedWrite('§2.1', r, canaries, outcome, {
      detail: /FILE_VERSION_CONFLICT/,
      onDisk: r.baseline,
    });

    const control = await rigOf('same-bytes-control', { content_seed: 'same-bytes' });
    check(
      '§2.2 对照夹具的基线与本格**逐字节相同**',
      same(control.baseline, r.baseline),
      '唯一的差别是那一个注入',
    );
    const controlOutcome = await control.runWith(backend);
    check(
      '§2.3 对照：同样的字节、没有换对象 ⇒ 写得成',
      controlOutcome.kind === 'finished' && controlOutcome.state === 'APPLIED',
      why(controlOutcome),
    );
  });

  // -------------------------------------------------------------------------
  section('§3 第三种状态：第三方在窗口里写下第三个版本（验收 2）');
  // -------------------------------------------------------------------------

  await guarded('§3', async () => {
    const r = await rigOf('third-state');
    const canaries = await r.canaries();
    const theirs = Buffer.concat([Buffer.from('third-version-zhengju\r\n', 'utf8')]);

    const outcome = await r.runWith(
      withRace(
        [{ before: 'writeFileGuarded', act: async () => { await writeFile(r.abs(), theirs); } }],
        backend,
        r.ctx,
      ),
    );

    check('§3.1 没有报成 APPLIED', outcome.kind === 'finished' && outcome.state !== 'APPLIED', why(outcome));
    const onDisk = await r.onDisk();
    check('§3.2 第三态**原样留着**（既不是我们的目标，也不是基线）', same(onDisk, theirs));
    check('§3.3 不得被覆盖成我们的目标内容', !same(onDisk, r.target));
    check('§3.4 也不得被「恢复」成基线', !same(onDisk, r.baseline));
    check(
      '§3.5 账上没有「已回到基线」（我们一个字节都没写过，没有东西可收）',
      !r.stagesOf().includes(ITEM_STAGE.restored),
      `阶段=${r.stagesOf().join(' → ') || '(空)'}`,
    );
    await r.expectCanariesIntact(canaries);
    record('§3 第三种状态', outcome.kind === 'finished' ? outcome.state : '?');
  });

  // -------------------------------------------------------------------------
  section('§4 目录交换：目标**之上**那一级被换成同名新目录（步骤 1）');
  // -------------------------------------------------------------------------

  await guarded('§4', async () => {
    const r = await rigOf('dir-swap');
    const canaries = await r.canaries();
    const parked = 'src-parked';
    const theirs = Buffer.concat([Buffer.from('new-dir-zhengju\r\n', 'utf8')]);
    const newDirFile = path.join(r.dir, 'src', 'draft.txt');
    const parkedFile = path.join(r.dir, parked, 'draft.txt');

    const outcome = await r.runWith(
      withRace(
        [
          {
            before: 'writeFileGuarded',
            act: async () => {
              await thirdPartySwapsDirectory(r.dir, 'src', parked);
              await writeFile(newDirFile, theirs);
            },
          },
        ],
        backend,
        r.ctx,
      ),
    );

    check('§4.1 没有报成 APPLIED', outcome.kind === 'finished' && outcome.state !== 'APPLIED', why(outcome));
    if (outcome.kind === 'finished') {
      check('§4.2 失败原因指名对象不符', /FILE_VERSION_CONFLICT/.test(outcome.detail), outcome.detail.slice(0, 160));
    }
    check(
      '§4.3 **新目录里的同名文件**一个字节都没被碰',
      same(await readFile(newDirFile), theirs),
      `sha256=${shortHash(sha256(await readFile(newDirFile)))}`,
    );
    check(
      '§4.4 被批准的那一个（已挪到旁边）仍然是基线',
      same(await readFile(parkedFile), r.baseline),
      `sha256=${shortHash(sha256(await readFile(parkedFile)))}`,
    );
    await r.expectCanariesIntact(canaries);
  });

  // -------------------------------------------------------------------------
  section('§5 目标创建竞争：CREATE_NEW 之下不覆盖别人的同名文件（步骤 1）');
  // -------------------------------------------------------------------------

  await guarded('§5', async () => {
    const r = await rigOf('create-race', { create: true });
    const canaries = await r.canaries();
    const theirs = Buffer.concat([Buffer.from('they-created-it-first\r\n', 'utf8')]);

    const outcome = await r.runWith(
      withRace(
        [{ before: 'createFileGuarded', act: async () => { await writeFile(r.abs(), theirs); } }],
        backend,
        r.ctx,
      ),
    );

    check('§5.1 没有报成 APPLIED', outcome.kind === 'finished' && outcome.state !== 'APPLIED', why(outcome));
    const onDisk = await r.onDisk();
    check('§5.2 别人建的那一个**原样留着**（逐字节）', same(onDisk, theirs), `sha256=${shortHash(sha256(onDisk))}`);
    check('§5.3 不得覆盖成我们的目标内容', !same(onDisk, r.target));
    check(
      '§5.4 账上留下「没动过」',
      r.stagesOf().includes(ITEM_STAGE.untouched),
      `阶段=${r.stagesOf().join(' → ') || '(空)'}`,
    );
    await r.expectCanariesIntact(canaries);

    // 对照：无人竞争 ⇒ 建成，且字节逐字保真（BOM 与 CRLF 都在）。
    const control = await rigOf('create-control', { create: true });
    const built = await control.runWith(backend);
    check(
      '§5.5 对照：无人竞争时必须建成',
      built.kind === 'finished' && built.state === 'APPLIED',
      why(built),
    );
    check(
      '§5.6 对照：建出来的字节与目标**逐字节相同**（BOM 与 CRLF 都在）',
      same(await control.onDisk(), control.target),
      `盘上=${shortHash(sha256(await control.onDisk()))} 目标=${shortHash(sha256(control.target))}`,
    );
  });

  // -------------------------------------------------------------------------
  section('§6 文件占用与权限变化：内核挡下来的两种拒绝（步骤 1）');
  // -------------------------------------------------------------------------

  await guarded('§6', async () => {
    // --- 占用：用护栏自己的 `holdHandle`（同一个 Open-Guarded、同一组 Win32 标志）。
    const busyControl = await rigOf('busy-control', { content_seed: 'busy' });
    const busy = await rigOf('busy');
    check(
      '§6.1 受控对照：两个夹具的基线**逐字节相同**',
      same(busyControl.baseline, busy.baseline),
    );
    const busyCanaries = await busy.canaries();
    const helper = new ResidentHelper();
    await helper.start();
    try {
      const volume = await backend.statVolume({ path: busy.dir });
      if (isWinfsError(volume)) throw new Error(`statVolume 失败：${volume.message}`);
      const held = await helper.call({
        op: 'holdHandle',
        root_path: busy.dir,
        root_volume_id: volume.volume_id,
        root_file_id: volume.file_id,
        relative_path: busy.rel,
        access: 'write',
        share_mode: 'read',
      });
      check('§6.2 第三方真的以「不共享写」的句柄占住了目标', held['ok'] === true, JSON.stringify(held).slice(0, 200));

      // 占用挡住的是**哪一次**调用？阶段 A 会先后问两个问题 ——「这是哪一个
      // 对象、什么形态」（`resolvePath`，只取身份）与「它的字节是什么」
      // （`readFileGuarded`，读内容）。两者回答的问题不同，因此「哪一次被挡」
      // 决定了这次拒绝发生在阶段 A 的哪一步，而那正是下面那条「日志为空」
      // 的断言所依赖的事实。分开问，然后如实报出来。
      const probeWhileHeld = await backend.resolvePath({
        root_path: busy.dir,
        root_volume_id: volume.volume_id,
        root_file_id: volume.file_id,
        relative_path: busy.rel,
        expect: 'file',
      });
      const readWhileHeld = await backend.readFileGuarded({
        root_path: busy.dir,
        root_volume_id: volume.volume_id,
        root_file_id: volume.file_id,
        relative_path: busy.rel,
      });
      const blocked = (result: typeof probeWhileHeld): string =>
        isWinfsError(result) ? `${result.code} / Win32 ${result.win32_error}` : '过得去（竟然成功了）';
      check(
        '§6.2b 两次调用都被挡住了，而且挡它们的是同一个内核错误（Win32 32 共享冲突）',
        isWinfsError(probeWhileHeld) &&
          isWinfsError(readWhileHeld) &&
          probeWhileHeld.code === 'FILE_BUSY' &&
          probeWhileHeld.win32_error === 32 &&
          readWhileHeld.code === 'FILE_BUSY' &&
          readWhileHeld.win32_error === 32,
        `探针=${blocked(probeWhileHeld)} 取内容=${blocked(readWhileHeld)}`,
      );
      note(
        '§6.2c 阶段 A 先问的是哪一个',
        '先探针（只取身份与形态）、后取内容。两者都被挡，因此这次执行停在**探针**那一步' +
          '—— 那是阶段 A 的第一问。下面那条「一个条目日志都没有」正是从这里来的',
      );

      const outcome = await busy.runWith(
        withRace(
          [
            {
              before: 'writeFileGuarded',
              act: async () => {
                const again = await helper.call({
                  op: 'holdHandle',
                  root_path: busy.dir,
                  root_volume_id: volume.volume_id,
                  root_file_id: volume.file_id,
                  relative_path: busy.rel,
                  access: 'write',
                  share_mode: 'read',
                });
                if (again['ok'] !== true) throw new Error(`第二次 holdHandle 失败：${JSON.stringify(again)}`);
              },
            },
          ],
          backend,
          busy.ctx,
        ),
      );
      // 这一格与 §6.7 的**形状不同**，而形状本身就是结论：读不成 ⇒ 阶段 A
      // 就退出（`journal: 'none'`），改不成 ⇒ 阶段 C 的护栏拒绝（默认那一支，
      // 留下「意图 → 没动过」）。两者都不许是 APPLIED。
      await expectRefusedWrite('§6.3', busy, busyCanaries, outcome, {
        detail: /FILE_BUSY/,
        onDisk: busy.baseline,
        journal: 'none',
      });
      if (outcome.kind === 'finished') {
        check('§6.4 拒绝理由是共享冲突，且带上内核的错误码 Win32 32', /Win32 32/.test(outcome.detail), outcome.detail.slice(0, 160));
      }
    } finally {
      await helper.stop();
    }
    const afterBusy = await busyControl.runWith(backend);
    check(
      '§6.5 对照：同样的字节、无人占用 ⇒ 写得成',
      afterBusy.kind === 'finished' && afterBusy.state === 'APPLIED',
      why(afterBusy),
    );

    // --- 权限：`chmod 0o444` 在 Windows 上设的是**只读属性**，那正是
    //     `CreateFileW` 拒绝 `GENERIC_WRITE` 的那条路（ERROR_ACCESS_DENIED）。
    const roControl = await rigOf('readonly-control', { content_seed: 'readonly' });
    const ro = await rigOf('readonly');
    check('§6.6 受控对照：两个夹具的基线**逐字节相同**', same(roControl.baseline, ro.baseline));
    const roCanaries = await ro.canaries();
    const denied = await ro.runWith(
      withRace(
        [{ before: 'writeFileGuarded', act: async () => { await chmod(ro.abs(), 0o444); } }],
        backend,
        ro.ctx,
      ),
    );
    await expectRefusedWrite('§6.7', ro, roCanaries, denied, {
      detail: /PERMISSION_DENIED/,
      onDisk: ro.baseline,
    });
    if (denied.kind === 'finished') {
      check('§6.8 拒绝理由是访问被拒，且带上内核的错误码 Win32 5', /Win32 5/.test(denied.detail), denied.detail.slice(0, 160));
    }
    const afterRo = await roControl.runWith(backend);
    check(
      '§6.9 对照：权限没被动过 ⇒ 写得成',
      afterRo.kind === 'finished' && afterRo.state === 'APPLIED',
      why(afterRo),
    );
  });

  // -------------------------------------------------------------------------
  section('§7 原生辅助进程退出 + 短写：账上必须说「不知道」（步骤 2，验收 1）');
  // -------------------------------------------------------------------------

  await guarded('§7', async () => {
    const r = await rigOf('guard-death');
    const canaries = await r.canaries();
    // 先把一个助手叫起来：`guardHelperPids()` 报的是**本进程名下**的助手，
    // 而一个还没被任何调用拉起来的后端在进程表上是空的。
    const warmed = await backend.statVolume({ path: r.dir });
    check(
      '§7.1 护栏助手进程真的起来了（进程表里看得见它）',
      isWinfsError(warmed) === false && guardHelperPids().length === 1,
      `pid=${guardHelperPids().join(',')}`,
    );

    const half = Math.floor(r.target.length / 2);
    const injector = new ResidentHelper();
    await injector.start();
    try {
      const outcome = await r.runWith(
        withRace(
          [
            {
              before: 'writeFileGuarded',
              act: async (_ctx, req) => {
                // 护栏自己在写入中途真的死掉：真 SetEndOfFile、真写一半、
                // 真 `[Environment]::Exit(43)`。注入点自带自查（助手还活着就抛）。
                await crashInWrite(injector, req as unknown as GuardedWriteRequest, 'half_write_then_crash');
                // 再把**调用方那个**助手也从进程表里杀掉，让执行器拿到的失败
                // 只能来自一次真实的进程退出。
                await killGuardHelpers();
              },
            },
          ],
          backend,
          r.ctx,
        ),
      );

      check('§7.2 协调器交回了结论', outcome.kind === 'finished', why(outcome));
      if (outcome.kind === 'finished') {
        check('§7.3 终局是 RECOVERY_REQUIRED（不是 APPLIED，也不是干净的失败）', outcome.state === 'RECOVERY_REQUIRED', `state=${outcome.state}`);
        check(
          '§7.4 报告说的是「没有被报告过」，而不是「未进入破坏性区域」',
          /没有被报告过/.test(outcome.detail),
          outcome.detail.slice(0, 220),
        );
        check(
          '§7.5 报告**没有**把一个未知印成已知（两句都不许出现）',
          !/(未|没有)进入破坏性区域/.test(outcome.detail) && !/已进入破坏性区域/.test(outcome.detail),
          outcome.detail.slice(0, 220),
        );
      }

      // 盘上：真的半截。这一条是「故障真的落地了」的地面证据。
      const onDisk = await r.onDisk();
      check(
        '§7.6 盘上是**真的半截**（长度 = 目标的一半，字节逐位等于目标前半段）',
        onDisk.length === half && same(onDisk, r.target.subarray(0, half)),
        `盘上 ${onDisk.length} 字节 / 目标半截 ${half} 字节（目标全长 ${r.target.length}）`,
      );
      check('§7.7 半截 ≠ 基线（基线一个字节都不剩了）', !same(onDisk, r.baseline));
      check('§7.8 半截 ≠ 我们的目标', !same(onDisk, r.target));

      // 账：三条日志，其中「恢复被跳过」，而不是「已恢复」。
      const stages = r.stagesOf();
      check(
        '§7.9 账上是 意图 → 失败 → 恢复被跳过',
        stages.join(' → ') === [ITEM_STAGE.intent, ITEM_STAGE.failed, ITEM_STAGE.restore_skipped].join(' → '),
        `阶段=${stages.join(' → ') || '(空)'}`,
      );
      check(
        '§7.10 账上没有「已恢复」（护栏不可用时不假装收场了）',
        !stages.includes(ITEM_STAGE.restored),
      );
      check('§7.11 折叠结论是「说不清」', r.ledger().aggregate === 'unfinished', `aggregate=${r.ledger().aggregate}`);

      const operationId = r.operationId();
      check('§7.12 这次执行有计划（operation_id 拿得到）', operationId !== null);
      if (operationId !== null) {
        const events = r.repos.operations.listByStates(['RECOVERY_REQUIRED']);
        check(
          '§7.13 操作被留在 RECOVERY_REQUIRED 里，恢复流程从**那个入口**找得到它',
          events.some((op) => op.id === operationId),
          `共 ${events.length} 条待恢复`,
        );
        check(
          '§7.14 它**不在** `listUnfinished()` 里（那个入口问的是另一个问题）',
          !r.repos.operations.listUnfinished().some((op) => op.id === operationId),
        );
      }

      // 三值判据的地面证据。取的不是装置手写的对象，而是**生产客户端**在
      // 助手真的死掉之后交回的那一条失败（`ResidentHelper.#onGone` 合成的），
      // 因此这里算出来的 verdict 就是执行器当时算出来的那一个。
      const probeVolume = await backend.statVolume({ path: r.dir });
      let probe: WinfsError;
      if (isWinfsError(probeVolume)) {
        probe = probeVolume;
      } else {
        const read = await backend.readFileGuarded({
          root_path: r.dir,
          root_volume_id: probeVolume.volume_id,
          root_file_id: probeVolume.file_id,
          relative_path: r.rel,
        });
        // 助手真的死了 ⇒ 这一次读**不可能**成功。成功了说明上面那次杀进程
        // 没有落地，而「故障没落地」的运行正是本文件最不能接受的那种绿。
        if (!isWinfsError(read)) throw new Error('助手已经死了，这一次读居然成功了 —— 故障没有落地');
        probe = read;
      }
      const facts = guardFailureFacts(probe);
      check(
        '§7.15 这条失败是「护栏不可用」那一类（客户端合成，根本没到过护栏）',
        facts.winfs_code === 'NATIVE_GUARD_UNAVAILABLE',
        `code=${facts.winfs_code} touched=${String(facts.touched)} observed=${String(facts.observed)}`,
      );
      check(
        '§7.16 它被读成三值里的**不知道**（不是 TOUCHED，也不是 NOT_TOUCHED）',
        guardVerdict(facts) === 'UNKNOWN',
        `verdict=${guardVerdict(facts)}`,
      );
      check(
        '§7.17 账上那一条失败记的是**同一个**错误码（判决与记录同源）',
        readEventCodes(r).includes(facts.winfs_code),
        `条目日志里的错误码=${readEventCodes(r).join('、') || '(空)'}`,
      );
      await r.expectCanariesIntact(canaries);
      record('§7 助手退出+短写', outcome.kind === 'finished' ? outcome.state : '?');
    } finally {
      await injector.stop().catch(() => undefined);
      // §7 把护栏**故意**弄死了（那是这一节的题目），但那个状态不能留给后面：
      // §8 问的是「状态库忙的时候会留下什么」，若护栏还死着，它那里的每一句
      // 「没写成」都会变成「护栏根本不在」的同义反复 —— 一次断言自己前提的
      // 论证。`dispose()` 丢掉常驻助手，下一次调用重新拉起一个：这是**恢复**，
      // 不是清理。第一次运行时缺了这一句，§8 就整段倒在了
      // `NATIVE_GUARD_UNAVAILABLE` 上，而那条失败信息里没有一个字提到锁。
      await backend.dispose();
    }
  });

  // -------------------------------------------------------------------------
  section('§8 数据库忙：两个落点，一个字节都不许动（步骤 2/3）');
  // -------------------------------------------------------------------------

  await guarded('§8', async () => {
    // 前提自查：这一节的每一句「没写成」都建立在「护栏是活的」之上。
    // 缺了它，一次「护栏不在」的运行会在这一节里留下**一模一样**的干净盘面，
    // 让所有断言一起变绿。`dispose()` 之后 `capability()` 不会走缓存，
    // 因此这一条问的是真的重新拉起一个助手能不能成。
    const warmed = await backend.capability();
    check(
      '§8.0 §7 之后护栏真的恢复了（否则这一节每一句「没写成」都是空话）',
      warmed.available === true,
      `available=${String(warmed.available)} ${warmed.resolved_backend_reason ?? ''}`,
    );

    const rigWithLocker = async (
      seed: string,
    ): Promise<{ readonly rig: ConcurrencyRig; readonly locker: ReturnType<typeof openLocker> }> => {
      const dbFile = path.join(sandbox, `${seed}.sqlite`);
      const rig = await rigOf(seed, { db_file: dbFile, busy_timeout_ms: 250, content_seed: 'busy-seed' });
      return { rig, locker: openLocker(dbFile, 250) };
    };

    // 落点 ①：锁落在阶段 A **之后**（认领之后、记账之前）。
    const intent = await rigWithLocker('busy-intent');
    try {
      const canaries = await intent.rig.canaries();
      const baseline = await intent.rig.onDisk();
      const rejected = await intent.rig
        .runWith(
          withRace(
            [{ before: 'readFileGuarded', act: async () => { intent.locker.hold(); } }],
            backend,
            intent.rig.ctx,
          ),
        )
        .then(() => null)
        .catch((cause: unknown) => cause as Error);
      check(
        '§8.1 状态库写不进去时，这次执行**抛出去**（不交回一个它记不下来的结论）',
        rejected !== null && /无法把执行意图写入状态库|database is locked/i.test(rejected.message),
        rejected?.message.slice(0, 160) ?? '居然正常返回了',
      );
      check(
        '§8.2 记不上账就不许写：盘上仍是基线',
        same(await intent.rig.onDisk(), baseline),
        `sha256=${shortHash(sha256(await intent.rig.onDisk()))}`,
      );
      check('§8.3 修改集停在 VALIDATING', intent.rig.stateOf() === 'VALIDATING', `state=${intent.rig.stateOf()}`);
      check('§8.4 一个条目日志都没有', intent.rig.ledger().events.length === 0);
      check(
        '§8.5 停在 VALIDATING 的操作被 `listUnfinished()` 找到（启动恢复找的就是它）',
        intent.rig.repos.operations.listUnfinished().length === 1,
      );
      check(
        '§8.6 这一次没有留下任何「待恢复」的结论（收尾那行根本没写进去）',
        intent.rig.repos.operations.listByStates(['RECOVERY_REQUIRED']).length === 0,
      );
      await intent.rig.expectCanariesIntact(canaries);
      intent.locker.release();
      check('§8.7 松开锁之后库里仍是那个形状（没有谁事后去补一笔）', intent.rig.stateOf() === 'VALIDATING');
    } finally {
      intent.locker.close();
    }

    // 落点 ②：锁在**认领之前**。
    const claim = await rigWithLocker('busy-claim');
    try {
      const canaries = await claim.rig.canaries();
      const baseline = await claim.rig.onDisk();
      claim.locker.hold();
      const rejected = await claim.rig
        .runWith(backend)
        .then(() => null)
        .catch((cause: unknown) => cause as Error);
      check(
        '§8.8 认领时被拒同样抛出去',
        rejected !== null && /database is locked|SQLITE_BUSY/i.test(rejected.message),
        rejected?.message.slice(0, 160) ?? '居然正常返回了',
      );
      check(
        '§8.9 认领的事务整个失败 ⇒ 操作仍是 QUEUED、连 operation_id 都没有',
        claim.rig.stateOf() === 'QUEUED' && claim.rig.operationId() === null,
        `state=${claim.rig.stateOf()} operation_id=${String(claim.rig.operationId())}`,
      );
      check('§8.10 盘上仍是基线', same(await claim.rig.onDisk(), baseline));
      await claim.rig.expectCanariesIntact(canaries);
    } finally {
      claim.locker.close();
    }

    // 反向探针：同样的**文件库**、同样的注入位置、只是没有锁 ⇒ 必须写成。
    const control = await rigWithLocker('busy-control');
    try {
      const built = await control.rig.runWith(
        withRace([{ before: 'readFileGuarded', act: async () => undefined }], backend, control.rig.ctx),
      );
      check(
        '§8.11 对照：文件库 + 同样的注入位置、没有锁 ⇒ 写成（否则上面几条验的是空气）',
        built.kind === 'finished' && built.state === 'APPLIED',
        why(built),
      );
      check(
        '§8.12 对照：成功的四个阶段齐全',
        control.rig.stagesOf().join(' → ') ===
          [ITEM_STAGE.intent, ITEM_STAGE.written, ITEM_STAGE.flushed, ITEM_STAGE.verified].join(' → '),
        `阶段=${control.rig.stagesOf().join(' → ')}`,
      );
    } finally {
      control.locker.close();
    }

    // 反复执行：同一格跑三轮，逐项比 —— 找的是**累积**，不是覆盖率。
    const rounds: { onDisk: string; listing: string[]; stages: string[]; unfinished: number }[] = [];
    for (let round = 0; round < 3; round += 1) {
      const rig = await rigWithLocker(`busy-repeat-${String(round)}`);
      try {
        rig.locker.hold();
        await rig.rig.runWith(backend).catch(() => undefined);
        rounds.push({
          onDisk: sha256(await rig.rig.onDisk()),
          listing: (await readdir(rig.rig.dir)).sort(),
          stages: rig.rig.stagesOf(),
          unfinished: rig.rig.repos.operations.listUnfinished().length,
        });
      } finally {
        rig.locker.close();
      }
    }
    const first = rounds[0];
    if (first === undefined) {
      check('§8.13 三轮都跑过', false, '一轮都没跑');
    } else {
      const drift = rounds.filter(
        (round) =>
          round.onDisk !== first.onDisk ||
          round.unfinished !== first.unfinished ||
          round.stages.join(',') !== first.stages.join(',') ||
          round.listing.join(',') !== first.listing.join(','),
      );
      check(
        '§8.13 三轮的盘、账与工作区目录**逐项相同**（无累积、无重复追加）',
        drift.length === 0,
        drift.length === 0 ? `三轮都是：${first.stages.join(' → ') || '(无日志)'}` : `${String(drift.length)} 轮与第一轮不同`,
      );
      check(
        '§8.14 三轮都停在「什么都没写」的那一格（三条一样错的记录也能互相通过）',
        first.stages.length === 0 && first.unfinished === 1,
        `阶段=${String(first.stages.length)} 条 未完成=${String(first.unfinished)}`,
      );
      check('§8.15 工作区里只有基线的两个东西', first.listing.join(',') === 'src,unrelated.txt', first.listing.join(','));
    }
  });

  // -------------------------------------------------------------------------
  section('§9 结构性事实：断网在执行段里**没有故障面**（步骤 2）');
  // -------------------------------------------------------------------------

  await guarded('§9', async () => {
    // 这一节不注入任何东西。它证明的是一件**关于代码**的事：一次写入的字节
    // 从批准记录走到磁盘，沿途没有任何一个网络调用点。因此「拔网线」不是
    // 这个执行段的输入 —— 这不是一条经验结论，是一条可查的边。
    //
    // 详细判据（七棵源码树、检测器自查、五个真源码反向探针、传递闭包与它的
    // 唯一豁免、护栏助手脚本）在 `tests/fault-injection/no-network.test.ts`
    // 里逐条钉住。这里只把结论与它的**证伪方式**印出来。
    const ROOTS = [
      'packages/executor/src',
      'packages/persistence/src',
      'packages/blob-store/src',
      'packages/approvals/src',
      'packages/changes/src',
      'native/winfs/src',
    ];
    const NET = /^node:(net|http|https|tls|dgram|http2)$|^(undici|node-fetch|ws|axios|got)$/;
    const SPEC = /(?:^|[^\w$.])(?:import|require|from)\s*\(?\s*['"]([^'"]+)['"]/gm;
    const CALLS = /\bfetch\s*\(|\bnew\s+(?:WebSocket|EventSource|XMLHttpRequest)\s*\(|\bsendBeacon\s*\(/;

    let scanned = 0;
    const hits: string[] = [];
    for (const root of ROOTS) {
      for (const file of walk(path.join(process.cwd(), ...root.split('/')))) {
        scanned += 1;
        const text = readFileSync(file, 'utf8');
        for (const match of text.matchAll(SPEC)) {
          if (NET.test(match[1] ?? '')) hits.push(`${path.relative(process.cwd(), file)} → ${match[1] ?? ''}`);
        }
        if (CALLS.test(text)) hits.push(`${path.relative(process.cwd(), file)} → 一个不需要导入的网络调用`);
      }
    }
    check('§9.1 执行段的源码真的被扫到了（不是空目录）', scanned >= 30, `共 ${String(scanned)} 个 .ts 文件`);
    check('§9.1 执行段里没有一个网络导入、也没有一个不需要导入的网络调用', hits.length === 0, hits.join('、'));

    // 反向探针：同一条判据用在**真的**建了端点的文件上必须报出来。
    const client = readFileSync(path.join(process.cwd(), 'packages/ipc/src/client.ts'), 'utf8');
    const found = [...client.matchAll(SPEC)].map((m) => m[1] ?? '').filter((s) => NET.test(s));
    check(
      '§9.2 反向探针：同一条判据在 `packages/ipc/src/client.ts` 上命中 `node:net`',
      found.includes('node:net'),
      `命中=${found.join('、') || '（无）'}`,
    );

    const closure = ['approvals', 'blob-store', 'changes', 'contracts', 'egress', 'files', 'idempotency', 'ipc', 'persistence', 'policy'];
    const nativeWinfs = readFileSync(path.join(process.cwd(), 'native/winfs/src/helper-client.ts'), 'utf8');
    check(
      '§9.3 执行段拉起的**子进程**只有本地 pwsh 助手（stdio 管道，`-NoProfile`）',
      /spawn\(PWSH, \['-NoProfile', '-NonInteractive', '-File'/.test(nativeWinfs),
    );
    const guard = readFileSync(path.join(process.cwd(), 'native/winfs/WinfsGuard.ps1'), 'utf8');
    check(
      '§9.4 护栏助手脚本里没有任何网络 cmdlet',
      !/(Invoke-WebRequest|Invoke-RestMethod|Start-BitsTransfer|\[?\s*System\s*\.\s*Net\s*\.|WebClient|HttpClient|TcpClient|DownloadString|DownloadFile)/i.test(guard),
      `脚本 ${String(guard.length)} 字符`,
    );
    note(
      '§9.5 传递闭包里的那一处豁免',
      `执行段的工作区闭包（${String(closure.length)} 个包 + @lwb/winfs）里只有 @lwb/ipc 碰网络，` +
        '那是它的 client/server/single-instance 三个**连接**文件里的 node:net；' +
        '执行段从它取的是租约与进程身份，与那三个文件的导出不相交（no-network.test.ts C2 钉住）。',
    );
    note(
      '§9.6 这一节的限度',
      '它是**结构性**的：证明这条路上没有网络调用点，因此拔网线不改变它的行为。' +
        '它不证明依赖树里没有网络实现，也不证明本机这一侧不会因为别的服务不在而失败。',
    );
  });

  // -------------------------------------------------------------------------
  section('§10 交付物与计数');
  // -------------------------------------------------------------------------

  await guarded('§10', async () => {
    const deliverables: readonly (readonly [string, string])[] = [
      ['tests/windows/concurrency/rig.ts', '真 NTFS 竞争装置（含两个授权外看门文件）'],
      ['tests/windows/concurrency/parallel-save.test.ts', '并行保存、占用、权限'],
      ['tests/windows/concurrency/identity-swap.test.ts', '同内容换身份、目录交换、目标消失'],
      ['tests/windows/concurrency/creation-race.test.ts', '目标创建竞争'],
      ['tests/fault-injection/fault-rig.ts', '故障注入装置（真崩溃、真进程退出、真锁）'],
      ['tests/fault-injection/guard-death.test.ts', '原生辅助进程退出 + 短写'],
      ['tests/fault-injection/persistence-boundaries.test.ts', '数据库忙'],
      ['tests/fault-injection/no-network.test.ts', '断网：结构性不存在'],
      ['tests/fault-injection/daemon-death.test.ts', '服务退出：执行者被 SIGKILL + 启动恢复'],
      ['docs/evidence/g4-write.md', 'G4 判定与依据'],
    ];
    for (const [file, what] of deliverables) {
      check(`§10.1 交付物存在：${file}`, existsSync(path.join(process.cwd(), ...file.split('/'))), what);
    }
    note('§10.2 本脚本的结论一览', RESULTS.map((r) => `${r.label}=${r.detail}`).join(' | '));

    // -----------------------------------------------------------------------
    // §10.3 服务退出：把那一组用例**再跑一遍**，并核对它自己的计数。
    //
    // 本文件的其它小节都在同一个进程里采证据，而「服务退出」这一格的证据
    // 恰恰是**进程死掉**这件事 —— 它在同一个进程里造不出来。因此这里不
    // 重复实现那套装置，而是跑那一组真用例（`tests/fault-injection/
    // daemon-death.test.ts`：真 SIGKILL 一个真执行者，再跑真启动恢复），
    // 把它的计数如实印出来。
    //
    // 与 §10.1 的分工：那一条只问「文件在不在」，这一条问「它还过不过」——
    // 一个存在但红着的用例文件，在交付物清单里与非交付物没有区别。
    // -----------------------------------------------------------------------
    const exitRun = spawnSync(
      process.execPath,
      [path.join('scripts', 'run-tests.mjs'), 'tests/fault-injection', '--grep', 'daemon-death'],
      { cwd: process.cwd(), encoding: 'utf8', timeout: 300_000 },
    );
    const exitOut = `${exitRun.stdout ?? ''}${exitRun.stderr ?? ''}`;
    for (const line of exitOut.split('\n')) {
      if (/^# (tests|suites|pass|fail|skipped) /.test(line)) console.log(`  ${line}`);
    }
    const countOf = (key: string): number =>
      Number(new RegExp(`^# ${key} (\\d+)`, 'm').exec(exitOut)?.[1] ?? '-1');
    check(
      '§10.3.1 服务退出那一组三条全过（真执行者、真 SIGKILL、真启动恢复）',
      exitRun.status === 0 && countOf('pass') === 3 && countOf('fail') === 0,
      `退出码 ${String(exitRun.status)}，tests=${String(countOf('tests'))} pass=${String(countOf('pass'))} fail=${String(countOf('fail'))}`,
    );
    note(
      '§10.3.2 那一组**没有**构造的形态',
      '真正落在一次 `WriteFile` 之内的死亡（护栏一次写完整个 payload，窗口在一个系统调用之内）；' +
        '它用两个停机点做确定等价物，见 §11 的最后一条',
    );
  });

  // -------------------------------------------------------------------------
  section('§11 未执行项：逐条写下理由，不写成 PASS');
  // -------------------------------------------------------------------------

  note('§11 口径', '下面每一条都不是「没来得及」，而是本机**造不出这个故障面**或它**不在本任务的范围**里。');
  skip(
    '磁盘满（写到一半没空间）',
    '本机造不出：需要一块可控的满卷（或无管理员权限下不可用的 VHD/配额）。护栏自己的代码给出了替代判据：' +
      '`WinfsGuard.ps1` 把 `$touched = $true` 放在 `SetEndOfFile` **之前**，因此磁盘满产生的 IO_ERROR 一定带 ' +
      '`touched: true`，走的是 `GUARD_STATE_UNOBSERVED`（「动过、现场未知」）而不是「没动过」—— 这条路与 §7 同源，' +
      '已在 LWB-028/LWB-030 的取证里验过分类',
  );
  skip(
    '刷盘错误（FlushFileBuffers 失败）',
    '本机造不出：需要可注入失败的存储栈（管理员 + 过滤器驱动）。而这条路**不经过异常**：' +
      '`WinfsGuard.ps1` 把 `FlushFileBuffers` 的结果如实交回 `flushed=false`，上层已经在回执核对里把它判成' +
      '「不得报告为完成」（`packages/executor/src/native-adapter.ts` 的两处回执抱怨），代价是「可能把一次实际成功的写入判成待恢复」',
  );
  skip(
    '断网（运行时拔网线）',
    '不需要：§9 证明执行段里没有网络调用点，因此这一格没有运行时故障面。要验的是那条边（`tests/fault-injection/no-network.test.ts`），' +
      '而不是「断网时还能写」—— 后者换一台有网的机器同样为真，说明不了任何事',
  );
  skip(
    '一次**落在 `WriteFile` 系统调用之内**的进程死亡',
    '本机造不出确定的那一格：护栏是一次 `WriteFile` 写完整个 payload（`WinfsGuard.ps1` 的 `Invoke-GuardedWrite`，不切块），' +
      '因此「写到一半被杀死」的窗口在一个系统调用之内，只能靠概率去撞 —— 而撞出来的东西没法复现，也就没法当证据。' +
      '`tests/fault-injection/daemon-death.test.ts`（§10.3）用的是它的**确定等价物**：一次停在动笔之前、一次停在动笔之后，' +
      '两者之间就是那个窗口。' +
      '这条 NOT_RUN 因此比它读起来窄得多：「执行者被杀死」这件事本身已经被真跑过了 —— ' +
      '此前本仓库只有它的两个**近似**（LWB-030 的「重启」其实是关库再开，那个进程一直活着；' +
      'LWB-026 的 SIGKILL 杀的是假写盘人，盘上没有半个现场可收拾），' +
      '真正被杀死的执行者、真盘上的残局、以及真启动恢复给出的定案，正是 §10.3 现在补上的那一格',
  );
  skip(
    '页面层（真实的 ChatGPT 网页）触发一次并发写入',
    'G0 未通过：LWB-002 BLOCKED（真实账号与隧道不可用）。本任务的注入全部发生在**本机护栏这一层**，' +
      '与网络无关，因此网页层缺席不影响这些结论，但**验收 3 的通过条件是另一回事**：' +
      'G0/G4 未通过时 `direct_write_enabled` 保持关闭，不允许对真实目录启用',
  );
  skip(
    'G4 门禁在真实目录上放行 direct_write',
    'G4 未通过（判定与依据见 `docs/evidence/g4-write.md`：本仓库从未指定验收负责人，' +
      '且门禁点名的 026–034 里 LWB-034 尚未交付 —— 那一格会引入一整套新的故障面）。' +
      '因此本任务的全部取证都在**临时目录**上进行，真实工作区一个字节都没被碰过',
  );
}

/** 递归收集一个目录下的 `.ts` 文件。 */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile() && entry.name.endsWith('.ts')) out.push(path.join(entry.parentPath, entry.name));
  }
  return out.sort();
}

// ---------------------------------------------------------------------------
// 收尾
// ---------------------------------------------------------------------------

await main();

for (const rig of rigs) rig.close();
await backend.dispose().catch(() => undefined);
rmSync(sandbox, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });

console.log('\n== 计数 ==');
console.log(`PASS ${passes} / FAIL ${failures} / NOT_RUN ${skips}`);
process.exitCode = failures === 0 ? 0 : 1;
