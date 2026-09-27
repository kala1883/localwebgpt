/**
 * LWB-033 · 真·进程退出：**执行者这个进程**写到一半被 `SIGKILL`。
 *
 * ## 这一格为什么必须另起一个进程
 *
 * 「服务退出」这件事在本仓库里此前只有两种近似，而两种都不是它：
 *
 * | 已有的做法 | 它其实是什么 | 差在哪 |
 * | --- | --- | --- |
 * | `tests/windows/recovery-converge.test.ts` 的「重启」 | 写完之后**关掉库连接**，再开一次 | 进程还活着。`finally`、句柄、内存里的东西全都规规矩矩地收好了 |
 * | `scripts/evidence/lwb-026.ts` 的 `SIGKILL` | 真杀，但被杀的那些写手用的是**假写盘人** | 盘上没有任何半个现场可收拾 |
 *
 * 两份合起来仍然缺一格：**一个真的进程，在真的写到一半的地方，真的没了**。
 * 本文件补的就是它 —— 用的还是那套公共装置（真 NTFS、真护栏、真修改集、
 * 真批准、真协调器），被换掉的只有「谁来跑这次执行」。
 *
 * ## 停机点选在哪，为什么是这两个
 *
 * 执行路径上真的会留下残局的位置只有两个，而两者留下的**完全不是同一种残局**：
 *
 * | 停在哪 | 盘上 | 账上 | 恢复该怎么收场 |
 * | --- | --- | --- | --- |
 * | 护栏调用**之前** | 基线原封不动 | `item_intent` | 观测到「仍是原件」⇒ 已回滚，零字节 |
 * | 护栏调用**之后** | 已经是目标内容 | 还是 `item_intent` | 观测到「目标已达成」⇒ 已应用，**但仍然零字节** |
 *
 * 第二行值得盯着看：账上最后一句关于这个条目的话是「我打算动它」，而盘上
 * 它已经动完了。这正是 `apply.ts` 阶段 B 那句注释说的形状 —— `APPLYING`
 * 是「字节可能已经在盘上」的唯一记录，而它只说了「可能」。把「可能」变成
 * 确定的，是恢复那一步**重新观测**出来的事实，不是任何一条补记。
 * 本文件因此同时钉住两件事：结论对了，**而且没有靠再写一遍来让它对**。
 *
 * ## 真正落在 `WriteFile` 里的那一次，本文件**没有**构造
 *
 * 护栏是**一次 `WriteFile` 写完整个 payload** 的（`WinfsGuard.ps1` 的
 * `Invoke-GuardedWrite`，不切块），因此「写到一半被杀死」在真盘上的窗口是
 * **一个系统调用之内**。它构造不出来，也正因为构造不出来，上面那两个停机点
 * 才是它的**确定等价物**：一次停机把执行放在动笔之前，另一次把它放在
 * 动笔之后，两者之间就是那个窗口。这一点在 `docs/evidence/g4-write.md`
 * 的 NOT_RUN 里如实记着，不因为本文件存在就改口。
 *
 * ## 杀法是 `SIGKILL`，不是一次体面的退出
 *
 * 体面退出会走 `finally`、会关库、会把「我还在」的记录抹掉 —— 而那恰好是
 * 我们要它**没机会做**的事。`SIGKILL` 在 Windows 上是 `TerminateProcess`：
 * 没有清理、没有补记、也没有最后一行日志。这与断电、被任务管理器结束、
 * 或者一条崩溃的守护进程留下的现场是同一种。
 *
 * 两个停机点都刻意选在**事务之外**（记账那一笔已经提交，下一笔还没开），
 * 因此状态库不会留下一个半截事务 —— 这一格要验的不是 SQLite 的原子性
 * （那是 LWB-029 的事），而是**盘上的字节与账上的记录对不上时**，
 * 下一次启动会不会说实话。
 *
 * ## 注入没落地就要吵
 *
 * 执行者跑到了预定的位置会先报一句 `lwb-worker:parked …`，父进程等到那一句
 * 才动手；如果它竟然自己跑完了（`lwb-worker:finished`），或者死在别的地方，
 * 本文件立刻抛。理由与 `fault-rig.ts` 同一条：一次「故障没发生，于是执行
 * 正常成功」的运行，会让这里所有「没报 APPLIED」的断言一起变绿。
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { BlobStore } from '@lwb/blob-store';
import {
  createNativeApplier,
  ExecutionCoordinator,
  ITEM_STAGE,
  JOURNAL_STAGE,
  readItemEvents,
} from '@lwb/executor';
import type { ExecutionPlan } from '@lwb/executor';
import { closeDatabase, openDatabase, Repositories } from '@lwb/persistence';
import { RecoveryService, RECOVERY_STAGE } from '@lwb/recovery';
import { PowerShellWinfsBackend } from '@lwb/winfs';
import type { WinfsOps } from '@lwb/winfs';

import {
  deadProbe,
  describeWindows,
  expectSameFingerprint,
  fingerprint,
  openRig,
  sha256,
  type CanarySnapshot,
  type ConcurrencyRig,
  type Fingerprint,
} from '../windows/concurrency/rig.ts';
import { ps } from './fault-rig.ts';

const FILE = fileURLToPath(import.meta.url);

/**
 * 子进程与父进程之间唯一的信道。
 *
 * 只走 `stdout` 的整行文本，且**只印 ASCII 的结论**（`kind` / `state` /
 * 停机点）。中文在子进程的输出编码上会经过一次代码页（本机 936），
 * 而这一格要断言的是状态名，没有必要去趟那次编码。
 */
const MARKER = 'lwb-worker:';

type ParkAt = 'before-write' | 'after-write' | 'none';

/**
 * 执行者这一侧需要知道的全部东西。
 *
 * 刻意**不包括**「工作区长什么样」：它拿到的是一份**已经批准、已经排队**的
 * 修改集，剩下的一切（基线、目标、快照、批准）都在状态库与快照库里，
 * 与真守护进程重启之后的情形一样。
 */
interface WorkerSpec {
  readonly db_file: string;
  readonly objects_root: string;
  readonly change_id: string;
  /**
   * 认领时写进 `write_slots` 的执行者名。与装置里那个（`exe_conc`）**刻意
   * 不同**：这一格里执行的是**另一个进程**，而账上就该记着是它做的。
   */
  readonly executor_id: string;
  readonly dir: string;
  readonly outside_dir: string;
  readonly park_at: ParkAt;
}

/**
 * 报一句「我停在哪了」，然后**永远停住**。
 *
 * `stdout.write` 带回调再 `await`：这一句必须真的到了父进程手上，父进程
 * 才会动手，因此它不能躺在 Node 的写缓冲里。此后没有任何定时器、没有任何
 * 待办 —— 这个进程接下来唯一会发生的事就是被杀掉。
 */
const announceAndPark = (stage: string): Promise<never> => {
  const parked = new Promise<never>(() => undefined);
  return new Promise<void>((resolve) => {
    process.stdout.write(`${MARKER}parked ${stage}\n`, () => {
      resolve();
    });
  }).then(() => parked);
};

/**
 * 执行者这一侧的全部代码。**父进程与它是同一份文件**（`--worker` 分支）。
 *
 * 除了那两处「停住」，走的每一行都是生产代码：真 `PowerShellWinfsBackend`、
 * 真 `createNativeApplier`、真 `ExecutionCoordinator`、真状态库、真快照库。
 */
async function runWorker(spec: WorkerSpec): Promise<void> {
  const opened = openDatabase({ path: spec.db_file });
  const repos = new Repositories(opened.db);
  const blobs = new BlobStore({
    objectsRoot: spec.objects_root,
    registry: repos.blobs,
    // 执行者这一侧不产生快照（目标快照是批准的时候就存好的）。真被调到
    // 这里说明有东西在不该建对象的路径上建对象，因此宁可直接炸。
    newId: () => {
      throw new Error('执行者这一侧不该新建快照对象');
    },
  });
  const backend = new PowerShellWinfsBackend();

  /**
   * 只多两处停顿的护栏。
   *
   * 其余七个方法逐字转发：这一格注入的**不是**第三方动作（那是竞争那一组
   * 的事），而是**这个进程自己的死**，因此护栏这一层不该有任何别的改动。
   */
  const ops: WinfsOps = {
    capability: () => backend.capability(),
    statVolume: (req) => backend.statVolume(req),
    validatePath: (req) => backend.validatePath(req),
    resolvePath: (req) => backend.resolvePath(req),
    listDirectory: (req) => backend.listDirectory(req),
    readFileGuarded: (req) => backend.readFileGuarded(req),
    createFileGuarded: (req) => backend.createFileGuarded(req),
    writeFileGuarded: async (req) => {
      if (spec.park_at === 'before-write') await announceAndPark('before-write');
      const result = await backend.writeFileGuarded(req);
      // 字节已经在盘上了，而这件事还没有记进账里 —— 第二个停机点。
      if (spec.park_at === 'after-write') await announceAndPark('after-write');
      return result;
    },
  };

  const applier = createNativeApplier({ repos, ops, blobs });
  const coordinator = new ExecutionCoordinator({
    repos,
    probe: deadProbe,
    apply: (plan: ExecutionPlan, signal: AbortSignal) => applier(plan, signal),
    executor_id: spec.executor_id,
    holder: { pid: process.pid, started_at: new Date(Date.now() - 60_000).toISOString() },
  });

  const outcome = await coordinator.runChange(spec.change_id);
  // 走到这里说明**没有**停在预定的位置上（`park_at: 'none'` 的那一格例外）。
  // 父进程认得出这一行，并据此判定「故障没有落地」。
  const state = outcome.kind === 'finished' ? outcome.state : null;
  await new Promise<void>((resolve) => {
    process.stdout.write(`${MARKER}finished ${JSON.stringify({ kind: outcome.kind, state })}\n`, () => {
      resolve();
    });
  });
}

const isWorker = process.argv.includes('--worker');

if (isWorker) {
  // 必须在这里就分流：下面那些 `describe` 一旦注册上，`node:test` 会在这个
  // 进程退出前把它们**跑一遍** —— 于是「执行者」会顺便当一次测试运行器。
  const raw = process.argv[process.argv.indexOf('--worker') + 1];
  if (raw === undefined) throw new Error('--worker 后面应当跟一个 JSON 规格');
  await runWorker(JSON.parse(raw) as WorkerSpec);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// 父进程这一侧：起一个真的执行者，等它停住，然后杀掉
// ---------------------------------------------------------------------------

interface WorkerHandle {
  readonly child: ChildProcess;
  /** 已经收到的整行 stdout。 */
  readonly lines: readonly string[];
  readonly stderr: () => string;
  /** 等到某一行出现；进程先退出则抛。 */
  readonly waitFor: (needle: string, timeoutMs?: number) => Promise<string>;
  readonly exited: Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>;
}

function spawnWorker(spec: WorkerSpec): WorkerHandle {
  const child = spawn(process.execPath, ['--import', 'tsx', FILE, '--worker', JSON.stringify(spec)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  const lines: string[] = [];
  let errors = '';
  let pending = '';
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    pending += chunk;
    for (;;) {
      const cut = pending.indexOf('\n');
      if (cut === -1) break;
      lines.push(pending.slice(0, cut).trim());
      pending = pending.slice(cut + 1);
    }
  });
  child.stderr?.on('data', (chunk: string) => {
    errors += chunk;
  });

  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on('exit', (code, signal) => resolve({ code, signal }));
  });

  return {
    child,
    lines,
    stderr: () => errors,
    exited,
    waitFor: async (needle: string, timeoutMs = 120_000): Promise<string> => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const hit = lines.find((line) => line.includes(needle));
        if (hit !== undefined) return hit;
        if (child.exitCode !== null || child.signalCode !== null) {
          throw new Error(
            `执行者在我们等到「${needle}」之前就退出了（code=${String(child.exitCode)}，` +
              `signal=${String(child.signalCode)}）。stdout：${lines.join(' | ') || '(空)'}\n` +
              `stderr：${errors.slice(-2000) || '(空)'}`,
          );
        }
        if (Date.now() > deadline) {
          throw new Error(
            `等「${needle}」超时（${String(timeoutMs)} ms）。stdout：${lines.join(' | ') || '(空)'}\n` +
              `stderr：${errors.slice(-2000) || '(空)'}`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    },
  };
}

/**
 * 把死掉的那个执行者留下的护栏助手收掉。
 *
 * `WinfsGuard.ps1` 的常驻循环在 `stdin` 读到 EOF（`$null`）时自己 `exit 0`，
 * 而它父进程一死，那根管道的写端就没了 —— 因此它**本来就会**自己退出。
 * 这里只是不让一次用例去赌那个时机（一个还挂在进程表里的 pwsh 会拖慢
 * 后面的每一格），**不做任何断言**：它退没退与本次执行留下的现场无关。
 *
 * 过滤条件里那句 `ProcessId -ne $PID` 与 `fault-rig.ts` 的 `guardHelperPids`
 * 是同一条理由：查询自己也是这一族 pwsh 子进程（见那里的注释）。
 */
function reapOrphanGuards(parentPid: number): void {
  ps(
    `Get-CimInstance Win32_Process -Filter "ParentProcessId=${String(parentPid)}" |` +
      ` Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -like '*WinfsGuard.ps1*' } |` +
      ` ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
  );
}

describeWindows('LWB-033 真进程退出：执行者带着写了一半的执行被杀死', () => {
  let sandbox = '';
  let backend: PowerShellWinfsBackend;
  const rigs: ConcurrencyRig[] = [];

  before(async () => {
    sandbox = await mkdtemp(path.join(os.tmpdir(), 'lwb-device-death-'));
    backend = new PowerShellWinfsBackend();
    const capability = await backend.capability();
    assert.equal(capability.available, true, `护栏后端不可用：${capability.resolved_backend_reason}`);
  });

  after(async () => {
    for (const rig of rigs.splice(0)) rig.close();
    await backend?.dispose();
    await rm(sandbox, { recursive: true, force: true });
  });

  /** 一条被批准、被排队、**还没有谁跑过**的修改集，落在真文件库上。 */
  async function openDeathRig(seed: string): Promise<{ rig: ConcurrencyRig; spec: WorkerSpec }> {
    const db_file = path.join(sandbox, `${seed}.sqlite`);
    const rig = await openRig(sandbox, backend, seed, {
      db_file,
      // 两个变体装着**逐字节相同**的文件：唯一的差别只能是那一个停机点。
      content_seed: 'death-seed',
    });
    rigs.push(rig);
    return {
      rig,
      spec: {
        db_file,
        objects_root: path.join(sandbox, `${seed}-objects`),
        change_id: rig.change_id,
        executor_id: 'exe_death',
        dir: rig.dir,
        outside_dir: rig.outside_dir,
        park_at: 'none',
      },
    };
  }

  const operationIdOf = (rig: ConcurrencyRig): string => {
    const operation = rig.repos.operations.findByChangeId(rig.change_id);
    assert.ok(operation !== null, '执行者应当已经认领过，操作行必须存在');
    return operation.id;
  };

  const itemIdOf = (rig: ConcurrencyRig): string => {
    const items = rig.repos.changes.items(rig.change_id);
    assert.equal(items.length, 1, '本装置只有一个条目');
    const item = items[0];
    if (item === undefined) throw new Error('上面一行已经断言过');
    return item.id;
  };

  /** 这个条目的逐条目日志（阶段名序列）。 */
  const itemStagesOf = (rig: ConcurrencyRig): string[] =>
    readItemEvents(rig.repos, operationIdOf(rig))
      .filter((event) => event.item_id === itemIdOf(rig))
      .map((event) => event.stage);

  /** 这个操作的**改动级**日志（`item_id` 为空那些行）。 */
  const changeStagesOf = (rig: ConcurrencyRig): string[] =>
    rig.repos.journal
      .list(operationIdOf(rig))
      .filter((row) => row.item_id === null)
      .map((row) => row.stage);

  /** 一套**文件库**夹具：与死掉的那个执行者用的是同一个库文件、同一批快照。 */
  function openService(rig: ConcurrencyRig) {
    const opened = openDatabase({ path: path.join(sandbox, `${rig.seed}.sqlite`) });
    const repos = new Repositories(opened.db);
    const blobs = new BlobStore({
      objectsRoot: path.join(sandbox, `${rig.seed}-objects`),
      registry: repos.blobs,
    });
    let minted = 0;
    const recovery = new RecoveryService({
      repos,
      ops: backend,
      blobs,
      now: Date.now,
      newId: () => `rec_${rig.change_id}_${String((minted += 1))}`,
    });
    return { opened, repos, recovery };
  }

  /** 起一个真执行者、等它停到指定位置、**杀掉**它，然后交回现场。 */
  async function killAt(seed: string, park_at: Exclude<ParkAt, 'none'>): Promise<{
    readonly rig: ConcurrencyRig;
    readonly canaries: CanarySnapshot;
    readonly onDisk: Buffer;
    readonly signal: NodeJS.Signals | null;
    readonly code: number | null;
  }> {
    const { rig, spec } = await openDeathRig(seed);
    const canaries = await rig.canaries();
    const worker = spawnWorker({ ...spec, park_at });

    const parked = await worker.waitFor(`${MARKER}parked ${park_at}`);
    assert.match(parked, new RegExp(`parked ${park_at}$`), `停机点不对：${parked}`);
    // 走到这里为止，这个进程**活着**，并且停在我们要它停的地方。
    assert.equal(worker.child.exitCode, null, '执行者应当还活着停在停机点上');

    worker.child.kill('SIGKILL');
    const exit = await worker.exited;
    reapOrphanGuards(worker.child.pid ?? -1);

    // 注入落地的判据一：它真的是被信号打死的，不是自己退出的。
    // 一次「执行者自己跑完了」的运行会让下面所有「没报 APPLIED」的断言
    // 一起变绿 —— 那种绿是本仓库最不能接受的一种。
    assert.equal(
      exit.signal,
      'SIGKILL',
      `执行者不是被 SIGKILL 打死的：code=${String(exit.code)} signal=${String(exit.signal)}`,
    );
    assert.equal(
      worker.lines.some((line) => line.includes('finished')),
      false,
      `执行者在被杀之前竟然跑完了：${worker.lines.join(' | ')}`,
    );

    return {
      rig,
      canaries,
      onDisk: await readFile(rig.abs()),
      signal: exit.signal,
      code: exit.code,
    };
  }

  it('验收（死在动笔之前）：盘上仍是基线；启动恢复把它定成「已回滚」，而它自己一个字节都没写', async () => {
    const death = await killAt('death-before', 'before-write');
    const { rig } = death;

    // ① 停机点这一侧的盘面：护栏那一步**从来没有被调用过**。
    assert.equal(
      sha256(death.onDisk),
      sha256(rig.baseline),
      '停在动笔之前，盘上却已经不是基线了 —— 那个停机点不在写入之前',
    );
    const killedAt = await fingerprint(rig.abs());

    // ② 账：认领过了、意图记过了，因此停在 `APPLYING`。这正是「字节可能
    //    已经在盘上」的那一格 —— 而这一次它**没有**在盘上。
    assert.equal(rig.stateOf(), 'APPLYING', `修改集应当停在执行中：${rig.stateOf()}`);
    assert.equal(rig.repos.operations.findByChangeId(rig.change_id)?.state, 'APPLYING');
    assert.deepEqual(
      itemStagesOf(rig),
      [ITEM_STAGE.intent],
      `被杀死时这个条目只该留下一条意图：${itemStagesOf(rig).join(' → ')}`,
    );
    assert.equal(
      operationIdOf(rig),
      rig.repos.operations.listUnfinished()[0]?.id,
      '这个操作必须能被 listUnfinished 找到，否则启动恢复会漏掉它',
    );

    // ③ 授权外文件：装置自带的纪律。
    await rig.expectCanariesIntact(death.canaries);

    // ④ 重启：**同一个库文件、同一批快照、同一块盘**，另起一套机器。
    const { opened, repos, recovery } = openService(rig);
    try {
      const report = await recovery.sweepStartup();

      assert.equal(report.leftovers, 1, `启动恢复应当找到那一个遗留操作`);
      assert.equal(report.undecidable.length, 0, `不该有查不清的：${JSON.stringify(report.undecidable)}`);
      assert.equal(report.awaiting_manual.length, 0, '盘上仍是基线，没有理由要人工处理');
      assert.equal(report.reconciled.length, 1, '应当在启动时自动定案');

      const [only] = report.reconciled;
      assert.ok(only !== undefined, '上面一行已经断言过');
      assert.deepEqual(only.before, 'RECOVERY_REQUIRED');
      assert.deepEqual(
        only.reconciliation,
        { kind: 'ROLLED_BACK', reason: 'ALL_ORIGINAL' },
        `盘上仍是基线，应当协调为已回滚：${JSON.stringify(only.reconciliation)}`,
      );
      assert.equal(only.after, 'ROLLED_BACK');
      assert.equal(only.items.length, 1);
      // 回执说的是**观测到的**那件事，而不是「我们写回去了」。
      assert.equal(only.items[0]?.verdict, 'ORIGINAL');

      // ⑤ 账：没有谁往这个条目上补一笔「写过」。
      assert.deepEqual(
        itemStagesOf(rig),
        [ITEM_STAGE.intent],
        `恢复不该替执行者补记阶段：${itemStagesOf(rig).join(' → ')}`,
      );
      assert.deepEqual(
        changeStagesOf(rig),
        [RECOVERY_STAGE.swept, RECOVERY_STAGE.reconciled],
        `改动级日志应当只有「扫描到」与「定案」两条：${changeStagesOf(rig).join(' → ')}`,
      );
      const finished = repos.operations.findById(operationIdOf(rig));
      assert.equal(finished?.state, 'ROLLED_BACK');
      assert.equal(finished?.recovered, false, '一次没有动过字节的执行，不该被记成「已恢复」');
      assert.equal(rig.stateOf(), 'ROLLED_BACK');

      // ⑥ 判据在磁盘上：定案**一个字节都没写** —— 连 mtime 都没动。
      expectSameFingerprint(killedAt, await fingerprint(rig.abs()), '协调之后的目标文件');
      assert.equal(sha256(await rig.onDisk()), sha256(rig.baseline));
      await rig.expectCanariesIntact(death.canaries);
    } finally {
      closeDatabase(opened.db);
    }
  });

  it('验收（死在动笔之后）：盘上已是目标，账上只说「打算写」—— 恢复据实定成「已应用」，仍然零字节', async () => {
    const death = await killAt('death-after', 'after-write');
    const { rig } = death;

    // ① 停机点这一侧的盘面：**字节已经落下去了**。这是与上一格唯一、
    //    也是全部的差别 —— 两个装置的代码逐字相同。
    assert.equal(
      sha256(death.onDisk),
      sha256(rig.target),
      '停在动笔之后，盘上却还不是目标内容 —— 那个停机点不在写入之后',
    );
    const killedAt = await fingerprint(rig.abs());

    // ② 账：还是那一条意图，一个字都没有补。**盘与账在这一刻对不上**，
    //    而恢复要做的正是把这件事说清楚，不是把它抹平。
    assert.equal(rig.stateOf(), 'APPLYING');
    assert.deepEqual(
      itemStagesOf(rig),
      [ITEM_STAGE.intent],
      `写到一半被杀死时，账上就该停在意图：${itemStagesOf(rig).join(' → ')}`,
    );
    await rig.expectCanariesIntact(death.canaries);

    // ③ 重启。
    const { opened, repos, recovery } = openService(rig);
    try {
      const report = await recovery.sweepStartup();
      assert.equal(report.leftovers, 1);
      assert.equal(report.undecidable.length, 0, `不该有查不清的：${JSON.stringify(report.undecidable)}`);
      assert.equal(report.awaiting_manual.length, 0, '盘上已是目标内容，没有第三种内容');
      assert.equal(report.reconciled.length, 1);

      const [only] = report.reconciled;
      assert.ok(only !== undefined, '上面一行已经断言过');
      assert.deepEqual(
        only.reconciliation,
        { kind: 'APPLIED', reason: 'ALL_TARGET' },
        `盘上已是目标，应当协调为已应用：${JSON.stringify(only.reconciliation)}`,
      );
      assert.equal(only.after, 'APPLIED');
      assert.equal(only.items[0]?.verdict, 'TARGET_REACHED');
      const finished = repos.operations.findById(operationIdOf(rig));
      assert.equal(finished?.state, 'APPLIED');
      assert.equal(
        finished?.recovered,
        true,
        '这一次的字节是**执行者**写下去的，恢复只是据实定案 —— 因此它是一次恢复',
      );
      assert.equal(rig.stateOf(), 'APPLIED');

      // ④ 账：恢复**没有**替它补记 `item_written`。补一笔会让这次执行
      //    看起来像走完了四个阶段，而事实是它在第二步之后就没有下文了 ——
      //    「后来发生了什么」由**回执**回答，逐条目日志回答的是
      //    「执行者自己做完了什么」。两者混起来，那四个阶段就再也
      //    读不出「有没有跑完」了。
      assert.deepEqual(
        itemStagesOf(rig),
        [ITEM_STAGE.intent],
        `恢复不该把没记上的阶段补上：${itemStagesOf(rig).join(' → ')}`,
      );
      assert.deepEqual(changeStagesOf(rig), [RECOVERY_STAGE.swept, RECOVERY_STAGE.reconciled]);

      // ⑤ 判据在磁盘上：定案**没有重放那次写入**。这一条是这一格的核心 ——
      //    磁盘上的字节是对的，因此最省事的做法是「照原样再写一遍」，
      //    而那样做会在恢复期间制造第二个写窗口。指纹三项全同说明它没写。
      expectSameFingerprint(killedAt, await fingerprint(rig.abs()), '协调之后的目标文件');
      assert.equal(sha256(await rig.onDisk()), sha256(rig.target));
      await rig.expectCanariesIntact(death.canaries);
    } finally {
      closeDatabase(opened.db);
    }
  });

  it('反向探针：同样的装置、同样的执行者、**不杀** ⇒ 一路写成 APPLIED 并走完四个阶段', async () => {
    // 上面两格的每一句「没报 APPLIED」都要靠这一条才有意义：一个「这个
    // 装置本来就写不成」的世界会让它们一起变绿。这里跑的是**同一个**
    // `openDeathRig`、同一个执行者文件、同一份正文，唯一的差别是不停机。
    const { rig, spec } = await openDeathRig('death-control');
    const canaries = await rig.canaries();
    const worker = spawnWorker({ ...spec, park_at: 'none' });

    const finished = await worker.waitFor(`${MARKER}finished`);
    const exit = await worker.exited;
    assert.equal(exit.code, 0, `执行者应当正常退出：${worker.stderr().slice(-2000)}`);

    const payload = JSON.parse(finished.slice(finished.indexOf('{'))) as {
      readonly kind: string;
      readonly state: string | null;
    };
    assert.equal(payload.kind, 'finished', `执行者应当收尾：${finished}`);
    assert.equal(payload.state, 'APPLIED', `一次没有故障的执行必须写成：${finished}`);

    assert.equal(rig.stateOf(), 'APPLIED');
    assert.equal(sha256(await rig.onDisk()), sha256(rig.target));
    assert.deepEqual(
      itemStagesOf(rig),
      [ITEM_STAGE.intent, ITEM_STAGE.written, ITEM_STAGE.flushed, ITEM_STAGE.verified],
      `写得成的那一次该走的四个阶段：${itemStagesOf(rig).join(' → ')}`,
    );
    // 与「被杀死」的两格对照：这一次**没有**任何东西留给启动恢复 ——
    // 改动级日志上只有协调器自己收尾的那一行，一条 `recovery_*` 都没有。
    assert.equal(rig.repos.operations.listUnfinished().length, 0);
    assert.deepEqual(changeStagesOf(rig), [JOURNAL_STAGE.APPLIED]);
    assert.equal(
      rig.repos.journal.list(operationIdOf(rig)).some((row) => row.stage.startsWith('recovery_')),
      false,
      '一次自己跑完的执行不该留下任何恢复阶段的行',
    );
    await rig.expectCanariesIntact(canaries);
  });
});
