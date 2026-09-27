/**
 * LWB-033 · 真 SQLite 文件库：数据库忙（`SQLITE_BUSY`）这个持久化边界。
 *
 * ## 为什么必须是**文件**库
 *
 * `:memory:` 的两个连接是两个**不同的库**，因此「忙」在内存库上没有对应的
 * 真实机制 —— 只能靠一个假的 `throw` 去模拟，而模拟出来的忙验的是测试自己
 * 写的那句话。真文件库上它是内核的字节范围锁，与生产里「另一个进程正在
 * 提交」完全同源：抢锁失败的报错来自 SQLite 自己。
 *
 * ## 这一格真正要回答的问题
 *
 * 「状态库写不进去」时，这次执行会留下什么。
 *
 * 这套记账有一条硬规矩（`apply.ts` 的阶段 B 注释）：
 * **`APPLYING` 那一格是「字节可能已经在盘上」的唯一记录**。于是「记不上账」
 * 与「不写」必须是同一件事 —— 记不上就不许写。本文件要钉的就是这一条：
 * 锁落在第一个字节之前时，盘上必须一个字节都没变。
 *
 * 两个位置各验一次，因为它们走的是**两条不同的代码路径**：
 *
 * | 锁落在哪 | 谁先撞上 | 表现 |
 * | --- | --- | --- |
 * | 认领**之前** | `claimForExecution` 的事务 | `runChange` 直接抛，操作仍是 `QUEUED` |
 * | 阶段 A 之后、阶段 B 之前 | `recordIntent` 的事务 | 抛 `INTENT_RECORD_FAILED`，操作仍是 `VALIDATING` |
 *
 * 后一格里 `#execute` 会把它映射成一次待恢复、再去写收尾那一行 —— 而那一行
 * 也要写库，于是**它也失败**。因此这一格的终局是 `runChange` **抛出去**，
 * 而不是交回一个 `RECOVERY_REQUIRED`：一次「连收尾都记不下来」的执行，
 * 状态库里不会有它的结论，谁都不许替它编一个。
 *
 * ## 与崩溃那一格的关系
 *
 * 这两者在状态库里留下的痕迹**故意**是同一种：一个停在 `VALIDATING` 的操作
 * 加零条条目日志 —— 而 `listUnfinished()` 正是为这个形状准备的（LWB-030 的
 * 启动恢复找的就是它）。所以这里的断言不写「文件没变」就完事，还要写
 * 「它被留在哪个状态里、恢复流程找不找得到」。
 */

import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { ITEM_STAGE } from '@lwb/executor';
import { closeDatabase, openDatabase } from '@lwb/persistence';
import { ResidentHelper, PowerShellWinfsBackend } from '@lwb/winfs';

import {
  describeWindows,
  openRig,
  sha256,
  withRace,
  type CanarySnapshot,
  type ConcurrencyRig,
  type RaceRule,
} from '../windows/concurrency/rig.ts';
import { openLocker, type Locker } from './fault-rig.ts';

/** 正文指纹：**不含 mtime**。跨轮比较的是「字节一样」，不是「同一时刻写的」。 */
const contentOf = async (abs: string): Promise<{ readonly sha256: string; readonly size: number }> => {
  const bytes = await readFile(abs);
  return { sha256: sha256(bytes), size: bytes.length };
};

describeWindows('LWB-033 真 SQLite：数据库忙', () => {
  let sandbox = '';
  let backend: PowerShellWinfsBackend;
  const rigs: ConcurrencyRig[] = [];
  const lockers: Locker[] = [];
  const helpers: ResidentHelper[] = [];

  before(async () => {
    sandbox = await mkdtemp(path.join(os.tmpdir(), 'lwb-fault-db-'));
    backend = new PowerShellWinfsBackend();
    const capability = await backend.capability();
    assert.equal(capability.available, true, `护栏后端不可用：${capability.resolved_backend_reason}`);
  });

  after(async () => {
    for (const locker of lockers.splice(0)) locker.close();
    for (const rig of rigs.splice(0)) rig.close();
    for (const helper of helpers.splice(0)) await helper.stop().catch(() => undefined);
    await backend?.dispose();
    await rm(sandbox, { recursive: true, force: true });
  });

  /**
   * 一套**文件库**夹具，外加一个占锁用的第二连接。
   *
   * `busy_timeout_ms` 取一个小值：这一格要的是「锁着的时候写入被拒」，
   * 不是「等 5 秒之后被拒」—— 后者只是让用例变慢，而结论一模一样。
   */
  const rigWithLocker = async (
    seed: string,
  ): Promise<{ readonly rig: ConcurrencyRig; readonly locker: Locker; readonly db_file: string }> => {
    const db_file = path.join(sandbox, `${seed}.sqlite`);
    const rig = await openRig(sandbox, backend, seed, {
      db_file,
      busy_timeout_ms: 250,
      content_seed: 'busy-seed',
    });
    rigs.push(rig);
    const locker = openLocker(db_file, 250);
    lockers.push(locker);
    return { rig, locker, db_file };
  };

  /** 执行完之后把结论与盘面一起取回来，避免断言散落在两个作用域里。 */
  const snapshotOf = async (r: ConcurrencyRig, canaries: CanarySnapshot) => ({
    onDisk: await contentOf(r.abs()),
    baseline: { sha256: sha256(r.baseline), size: r.baseline.length },
    inside: await contentOf(canaries.inside_path),
    outside: await contentOf(canaries.outside_path),
  });

  it('装置自查：`openLocker` 占住的锁是真的 —— 另一个连接这时写不进去', async () => {
    // 一条「占住了」的自述不算证据。判据是**另一个连接的一次真实写入**
    // 在这一刻失败。没有这一条，本文件所有「因为忙所以没写」的断言都可能
    // 建立在一个根本没占住锁的装置上。
    const db_file = path.join(sandbox, 'locker-selfcheck.sqlite');
    const opened = openDatabase({ path: db_file, busyTimeoutMs: 250 });
    // 这个装置自己关自己（不进 `lockers`）：`close()` 是幂等的，但这里
    // 只需要一次，而且要与它上面那个 `openDatabase` 成对。
    const locker = openLocker(db_file, 250);
    /** 一次什么都不改的写事务：只要 `BEGIN IMMEDIATE` 拿得到锁就成功。 */
    const write = (): void => {
      opened.db.transaction(() => undefined).immediate();
    };

    try {
      assert.equal(locker.held, false, '刚打开时不该拿着锁');
      locker.hold();
      assert.equal(locker.held, true);
      locker.hold(); // 幂等：已经在手上时是空操作
      assert.equal(locker.held, true);

      // 另一个连接此刻写一下：必须被拒。**判据是这一次写入失败**，
      // 而不是 `locker.held` 说了什么 —— 后者是这个装置的自述。
      assert.throws(
        write,
        /database is locked|SQLITE_BUSY/i,
        '锁着的时候另一个连接竟然写成功了 —— 这个装置没有占住任何东西',
      );

      locker.release();
      assert.equal(locker.held, false);
      locker.release(); // 幂等：没拿住时不该抛
      assert.equal(locker.held, false);

      // 松开之后同一个写入必须成功 —— 与上面那条合起来才说明「拒」是锁
      // 造成的，而不是这个库本来就写不进去。
      write();
    } finally {
      locker.close();
      closeDatabase(opened.db);
    }
  });

  it('验收（锁在阶段 A 之后落下）：记不上账就不许写 —— 一个字节都没动，操作留在 VALIDATING', async () => {
    const { rig: r, locker } = await rigWithLocker('busy-intent');
    const canaries = await r.canaries();
    const before_ = await snapshotOf(r, canaries);

    const rules: readonly RaceRule[] = [
      {
        before: 'readFileGuarded',
        // 阶段 A 的核对**读**发生在这里，而它之后紧接着就是阶段 B 的记账。
        // 因此把锁落在这一刻，撞上的正好是 `recordIntent` 那一个事务。
        act: () => {
          locker.hold();
          return Promise.resolve();
        },
      },
    ];

    // 收尾那一行也要写库，而锁还在手上 —— 于是它同样失败，`runChange`
    // 直接抛。这不是缺陷：一次「连结论都记不下来」的执行，状态库里不该有
    // 一条它没写成的结论。
    await assert.rejects(
      () => r.runWith(withRace(rules, backend, r.ctx)),
      /无法把执行意图写入状态库|database is locked/,
      '状态库写不进去时，这次执行必须抛出去，而不是交回一个结论',
    );

    // ① 盘：一个字节都没动。这一条是阶段 B 那句注释的判据 ——
    //    「`APPLYING` 是字节可能已经在盘上的唯一记录」，因此记不上就不许写。
    assert.deepEqual(await contentOf(r.abs()), before_.baseline, '记不上账却动了盘上的字节');
    assert.equal(sha256(await r.onDisk()), sha256(r.baseline));
    assert.equal(r.stateOf(), 'VALIDATING', `修改集应当停在认领之后、记账之前：${r.stateOf()}`);
    assert.deepEqual(r.ledger().events, [], '一次都没写到盘上，不该有逐条目日志');
    // 一条日志都没有的那个条目：折叠函数把它算作「说不清」，
    // 而不是「没改动」—— 后者只在**每个**条目都有日志时才敢说。
    assert.equal(r.ledger().aggregate, 'unfinished');

    // ② 账：状态库里留下的形状与「进程在写入之前死掉」**一样** ——
    //    这正是启动恢复要接手的那个形状。
    assert.equal(
      r.repos.operations.listUnfinished().length,
      1,
      '停在 VALIDATING 的操作必须被 listUnfinished 找到，否则启动恢复会漏掉它',
    );
    assert.equal(
      r.repos.operations.listByStates(['RECOVERY_REQUIRED']).length,
      0,
      '这一次没有留下任何「待恢复」的结论 —— 收尾那行根本没写进去',
    );

    // ③ 授权外文件：装置自带的纪律。
    assert.deepEqual(await contentOf(canaries.inside_path), before_.inside);
    assert.deepEqual(await contentOf(canaries.outside_path), before_.outside);

    // ④ 松开锁之后，库里仍然是那个形状（没有谁事后去补一笔）。
    locker.release();
    assert.equal(r.repos.operations.listUnfinished().length, 1);
    assert.deepEqual(await contentOf(r.abs()), before_.baseline);
  });

  it('验收（锁在认领之前）：认领那一步就被拒 —— 操作仍是 QUEUED，什么都没发生', async () => {
    const { rig: r, locker } = await rigWithLocker('busy-claim');
    const canaries = await r.canaries();
    const before_ = await snapshotOf(r, canaries);
    // 锁在 `runWith` 之前就握着：认领的事务（`claimForExecution`）是第一个
    // 撞上它的写入。
    locker.hold();

    await assert.rejects(
      () => r.runWith(backend),
      /database is locked|SQLITE_BUSY/i,
      '认领时状态库被占着，这次执行必须抛出去',
    );

    // 认领的事务整个失败了 ⇒ 它的状态转移一个都没有提交。
    assert.equal(
      r.repos.operations.findByChangeId(r.change_id)?.state,
      'QUEUED',
      '认领失败之后操作必须还是 QUEUED（认领是一次事务，要么全成要么全不成）',
    );
    assert.equal(r.stateOf(), 'QUEUED', `修改集也不该离开 QUEUED：${r.stateOf()}`);
    assert.deepEqual(await contentOf(r.abs()), before_.baseline, '认领都没成功，盘上不该有变化');
    assert.deepEqual(await contentOf(canaries.inside_path), before_.inside);
    assert.deepEqual(await contentOf(canaries.outside_path), before_.outside);
    // 认领失败时 applier 一次都没跑过 ⇒ 连 operation_id 都没有。
    assert.equal(r.operationId(), null, '认领都没成功，不该有执行计划');
    assert.deepEqual(r.ledger().events, []);
  });

  it('反向探针：同样的**文件库**、同样的注入位置、只是没有锁 ⇒ 必须写成', async () => {
    // 本文件的每一格都用文件库（而不是内存库）。一个「文件库这套装置本来就
    // 写不成」的世界会让上面几条「没写成」的断言一起变绿 —— 因此这一条
    // 走的是**同一个** `rigWithLocker` 与**同一个**注入位置，只是不 `hold()`。
    const { rig: r } = await rigWithLocker('busy-control');
    const canaries = await r.canaries();

    const outcome = await r.runWith(
      withRace([{ before: 'readFileGuarded', act: () => Promise.resolve() }], backend, r.ctx),
    );

    assert.equal(outcome.kind, 'finished');
    if (outcome.kind !== 'finished') throw new Error('上面一行已经断言过');
    assert.equal(outcome.state, 'APPLIED', `没有锁时必须写成：${outcome.detail}`);
    assert.equal(sha256(await r.onDisk()), sha256(r.target));
    assert.deepEqual(
      r.stagesOf(),
      [ITEM_STAGE.intent, ITEM_STAGE.written, ITEM_STAGE.flushed, ITEM_STAGE.verified],
      `写得成的那一次该走的四个阶段：${r.stagesOf().join(' → ')}`,
    );
    await r.expectCanariesIntact(canaries);
  });

  it('反复执行：同一个故障跑三轮 ⇒ 每一轮的盘、账与工作区都一样（无累积、无重复追加）', async () => {
    // 任务要求「每个持久化边界**反复**执行故障注入」。反复的理由不是覆盖率，
    // 而是**累积**：一个每次失败都往状态库或工作区里多留一点什么的实现，
    // 单轮看不出来，三轮就看得出来。因此判据是「第一轮长什么样，后面每一轮
    // 就必须还是那个样」—— 逐项比，而不是各轮各判一次「没报 APPLIED」。
    interface Round {
      readonly onDisk: { sha256: string; size: number };
      readonly inside: { sha256: string; size: number };
      readonly outside: { sha256: string; size: number };
      readonly listing: readonly string[];
      readonly stages: readonly string[];
      readonly unfinished: number;
      readonly state: string;
    }
    const rounds: Round[] = [];

    for (let round = 0; round < 3; round += 1) {
      const { rig: r, locker } = await rigWithLocker(`busy-repeat-${round}`);
      const canaries = await r.canaries();
      // 三轮用**同一个落点**（认领之前就把锁握着）。刻意不换落点：
      // 换落点就变成了三个各自为政的用例，而这一格要的是**同一个**故障
      // 重复三次，好让「多留了什么」在两两对比里露出来。
      locker.hold();
      await assert.rejects(() => r.runWith(backend), /database is locked|SQLITE_BUSY/i);

      rounds.push({
        onDisk: await contentOf(r.abs()),
        inside: await contentOf(canaries.inside_path),
        outside: await contentOf(canaries.outside_path),
        listing: (await readdir(r.dir)).sort(),
        stages: r.stagesOf(),
        unfinished: r.repos.operations.listUnfinished().length,
        state: r.stateOf(),
      });
    }

    const first = rounds[0];
    assert.ok(first !== undefined, '三轮都该跑过');
    for (const [index, round] of rounds.entries()) {
      assert.deepEqual(round.onDisk, first.onDisk, `第 ${index + 1} 轮的目标文件与第一轮不同`);
      assert.deepEqual(round.inside, first.inside, `第 ${index + 1} 轮的工作区内看门文件与第一轮不同`);
      assert.deepEqual(round.outside, first.outside, `第 ${index + 1} 轮的工作区外看门文件与第一轮不同`);
      assert.deepEqual(
        round.listing,
        first.listing,
        `第 ${index + 1} 轮的工作区目录与第一轮不同（多出来的东西就是累积）`,
      );
      assert.deepEqual(round.stages, first.stages, `第 ${index + 1} 轮的条目日志与第一轮不同`);
      assert.equal(round.unfinished, first.unfinished, `第 ${index + 1} 轮的未完成操作数与第一轮不同`);
      assert.equal(round.state, first.state, `第 ${index + 1} 轮的终局状态与第一轮不同`);
    }

    // 三轮都必须停在**什么都没写**的那一格上，而不只是「三轮彼此相同」——
    // 三条一样错的记录也能互相通过。判据因此还要钉住那一格的内容。
    assert.deepEqual(first.stages, [], '锁着的时候一个字节都写不出去，条目日志必须是空的');
    assert.equal(first.state, 'QUEUED', `三轮都该停在认领之前：${first.state}`);
    assert.equal(first.unfinished, 1, '每一轮都留下恰好一条「上一个进程没走完」的操作');
    assert.deepEqual(
      first.listing,
      ['src', 'unrelated.txt'],
      `工作区里应当只有基线的两个东西：${first.listing.join('、')}`,
    );
  });
});
