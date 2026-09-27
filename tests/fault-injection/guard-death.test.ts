/**
 * LWB-033 · 真 NTFS + 真护栏：原生辅助进程退出与短写。
 *
 * ## 这一格要回答的问题
 *
 * 「护栏进程在写入中途死掉」之后，这套记账还说不说实话。
 *
 * 它有一个非常诱人的错误答案：**说「没动过」**。因为助手死掉时客户端拿到的
 * 是一条**客户端合成**的失败（`ResidentHelper.#onGone`：《助手已退出》），
 * 这条失败与「护栏干净地拒绝了」在调用方看起来一模一样 —— 于是
 * `apply.ts` 完全可以选择相信它、把文件报成 `untouched`、把整次执行报成
 * `rolled_back`。那条路上有两次真实的截断与半写躺在盘上，而报告说
 * 「工作区回到执行之前的样子」。
 *
 * 本工程的答案是 `restoreBlocker` 里的第一条：
 *
 * > `NATIVE_GUARD_UNAVAILABLE`：`touched` 缺席，但**不能**当作「没动过」——
 * > 这个码有可能是客户端合成的，那时响应根本没从护栏回来，而
 * > 「进程被杀」与「干净地拒绝了」在调用方看起来是一样的。
 *
 * 于是它进恢复、交给人。本文件把这个「于是」钉在磁盘、账本与进程表上。
 *
 * ## 两个方向都要验
 *
 * 只验「半截的文件被判成待恢复」是不够的：一个**永远报待恢复**的实现同样
 * 能过。因此 §2 是同一个夹具去掉注入（必须写成），而 §3 反过来 ——
 * 盘上**确实**还是基线，账上**仍然**必须是「不知道」。两条合起来才说明
 * 那句判断的依据是「这条失败证明了什么」，而不是「盘上看起来怎么样」。
 *
 * ## 故障怎么进来的：注入之后全是生产路径
 *
 * 三次故障注入都发生在 `withRace` 的那一格里 —— 也就是阶段 A 已经核对过、
 * 护栏**即将**打开句柄写入的那一瞬间：
 *
 *  1. `crashInWrite(…, 'half_write_then_crash')`：护栏自己截断、自己写半份、
 *     自己 `Exit(43)`。盘上留下**真的**半截。
 *  2. `crashInWrite(…, 'truncate_then_crash')`：同上，但一个字节都不写。
 *  3. `killGuardHelpers()`：真 `Stop-Process`，盘上一个字节不动。
 *
 * **此后调用方走的每一个字节都是生产路径**（`PowerShellWinfsBackend` →
 * `ResidentHelper` → `#onGone`）。本文件里没有第二个 `WinfsOps` 实现，
 * 也没有一句手写的失败值 —— 这一点由 §5 的装置自查与 §2 的反向探针各自钉住。
 *
 * ## 与 `tests/windows/recovery-converge.test.ts` 的分工
 *
 * 那里验的是**恢复**：重启之后怎么收敛、怎么不覆盖用户后来的编辑、
 * 快照被删掉时怎么停下。本文件验的是**写入这一段**：故障发生的那一瞬间，
 * 账上写下了什么。两者的交界是「这条操作被交出去了」—— 本文件只断言
 * 它被判成待恢复、且恢复流程的入口找得到它（`listByStates`），
 * 不重复那边的收敛用例。
 */

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { ITEM_STAGE } from '@lwb/executor';
import type { RunOutcome } from '@lwb/executor';
import { ResidentHelper, PowerShellWinfsBackend } from '@lwb/winfs';
import type { WinfsError } from '@lwb/winfs';

import {
  describeWindows,
  openRig,
  sha256,
  withRace,
  type ConcurrencyRig,
  type RaceRule,
} from '../windows/concurrency/rig.ts';
import {
  assertGoneByCrash,
  assertGuardGone,
  crashInWrite,
  guardHelperPids,
  killGuardHelpers,
  type GuardedWriteRequest,
} from './fault-rig.ts';

describeWindows('LWB-033 真 NTFS：原生辅助进程退出与短写', () => {
  let sandbox = '';
  let backend: PowerShellWinfsBackend;
  const rigs: ConcurrencyRig[] = [];
  const helpers: ResidentHelper[] = [];

  before(async () => {
    sandbox = await mkdtemp(path.join(os.tmpdir(), 'lwb-fault-guard-'));
    backend = new PowerShellWinfsBackend();
    const capability = await backend.capability();
    assert.equal(capability.available, true, `护栏后端不可用：${capability.resolved_backend_reason}`);
  });

  after(async () => {
    for (const rig of rigs.splice(0)) rig.close();
    for (const helper of helpers.splice(0)) await helper.stop().catch(() => undefined);
    await backend?.dispose();
    await rm(sandbox, { recursive: true, force: true });
  });

  const rigOf = async (seed: string): Promise<ConcurrencyRig> => {
    const rig = await openRig(sandbox, backend, seed);
    rigs.push(rig);
    return rig;
  };

  const injectorOf = async (): Promise<ResidentHelper> => {
    const helper = new ResidentHelper();
    await helper.start();
    helpers.push(helper);
    return helper;
  };

  /**
   * 跑一次执行，然后**把护栏救回来**。
   *
   * 这几格的注入都会让生产护栏彻底不可用（那正是它们要造的局面），而
   * 助手退出后当前操作必须 fail-closed，且绝不能自动重放；后续独立调用
   * 可以安全地启动并自检一个新助手。`dispose()` 仍在这里显式清理装置，
   * 避免一次故障注入让后续用例继承进程状态。
   *
   * 因此这里用 `finally`：断言失败也必须把护栏救回来，否则一次红灯会
   * 连带把后面几条用例变成另一种红灯。
   */
  const runThenRestore = async (r: ConcurrencyRig, rules: readonly RaceRule[]): Promise<RunOutcome> => {
    try {
      return await r.runWith(withRace(rules, backend, r.ctx));
    } finally {
      await backend.dispose();
    }
  };

  it('验收（短写）：护栏在写入中途真的死掉 ⇒ 盘上半截，账上是「不知道」，绝不报 APPLIED', async () => {
    const r = await rigOf('crash-half');
    const canaries = await r.canaries();
    const injector = await injectorOf();
    const guardsBefore = guardHelperPids().length;

    const outcome = await runThenRestore(r, [
      {
        before: 'writeFileGuarded',
        act: async (_ctx, req) => {
          // ① 真截断 + 真半写 + 真 Exit(43)：助手在写入**中途**死掉。
          await crashInWrite(injector, req as unknown as GuardedWriteRequest, 'half_write_then_crash');
          // ② 再把**生产护栏**也杀掉。于是调用方这次写入拿到的失败完全由
          //    生产代码合成（`#onGone`）—— 与真实世界一致：一次崩溃之后，
          //    护栏就是不可用了。
          await killGuardHelpers();
        },
      },
    ]);

    // ---- ① 故障真的发生了 -------------------------------------------------
    // 三个真实事件都要看到。任何一条不成立，下面所有的断言都可能是在验空气。
    const onDisk = await readFile(r.abs());
    const half = Math.floor(r.target.length / 2);
    assert.equal(onDisk.length, half, `盘上应当是半截（${half} 字节），实际 ${onDisk.length} 字节`);
    // 前半段**逐字节**等于目标的前半段：这是 `SetEndOfFile` 之后
    // `WriteFile` 写下去的那一半，而不是随便什么半截。
    assert.deepEqual(
      [...onDisk],
      [...r.target.subarray(0, half)],
      '盘上的半截必须正好是目标的前半段（截断 + 半写）',
    );
    assert.notEqual(sha256(onDisk), sha256(r.target), '半截不得等于目标');
    assert.notEqual(sha256(onDisk), sha256(r.baseline), '半截也不得等于基线');
    // 进程表：护栏助手真的少了一个。这一条独立于消息里的退出码。
    assert.ok(
      guardHelperPids().length < guardsBefore,
      `助手进程没有被真的终止：注入前 ${guardsBefore} 个，现在 ${guardHelperPids().length} 个`,
    );

    // ---- ② 终局：不是 APPLIED，而且是「不知道写到了哪」 --------------------
    assert.equal(outcome.kind, 'finished', `协调器应当交回结论：${JSON.stringify(outcome)}`);
    if (outcome.kind !== 'finished') throw new Error('上面一行已经断言过');
    assert.equal(outcome.state, 'RECOVERY_REQUIRED', `必须是待恢复：${outcome.state} / ${outcome.detail}`);
    // 盘上就是半截，因此「工作区回到执行之前的样子」是假的，不许出现。
    assert.doesNotMatch(
      outcome.detail,
      /回到执行之前的样子/,
      `盘上留着半截，报告不得声称工作区回到了执行之前：${outcome.detail}`,
    );
    // 两次截断与半写确实发生过，而 `touched` 根本没有回来。因此两个方向
    // 的**断言**都不许出现 —— 报告只能承认「没有人报告过这件事」。
    assert.match(
      outcome.detail,
      /没有被报告过/,
      `这条失败没有报告过任何事，报告必须这么说：${outcome.detail}`,
    );
    assert.doesNotMatch(
      outcome.detail,
      /(未|没有)进入破坏性区域|已进入破坏性区域/,
      `不许把「不知道」印成「已进入」或「没进入」：${outcome.detail}`,
    );

    // ---- ③ 账：这条失败证明了什么，账上就得写什么 --------------------------
    const stages = r.stagesOf();
    const names: readonly string[] = stages;
    assert.deepEqual(
      stages,
      [ITEM_STAGE.intent, ITEM_STAGE.failed, ITEM_STAGE.restore_skipped],
      `账上应当是「记了意图 → 写了失败 → 放弃自动收回」：${stages.join(' → ')}`,
    );
    const skipped = r
      .ledger()
      .events.filter((e) => e.stage === ITEM_STAGE.restore_skipped)
      .at(0);
    assert.equal(
      skipped?.error_code,
      'GUARD_UNAVAILABLE_PROVES_NOTHING',
      `放弃收回的理由必须是「这条失败证明不了任何事」：${JSON.stringify(skipped)}`,
    );
    // **绝不出现 `restored`**：去「恢复」一个我们不知道写成什么样的文件，
    // 等于用基线覆盖掉可能存在的第三方的字节。
    assert.equal(names.includes(ITEM_STAGE.restored), false, '不得自动收回半截的现场');
    assert.equal(r.ledger().aggregate, 'unfinished', '总账只能是「说不清」，不能是三种好结局之一');

    // ---- ④ 这一步没有被自动补齐，也没有被别人重放 --------------------------
    assert.equal(
      sha256(await readFile(r.abs())),
      sha256(onDisk),
      '执行结束之后盘上仍是那半截 —— 恢复流程不该在这里偷偷跑',
    );
    // 「留在未完成里」这句话要说准确，因为状态库里有**两个**入口，而它们
    // 回答的是两个不同的问题：
    //  - `listUnfinished()`：上一个进程**中途**留下了什么（只认
    //    `QUEUED`/`VALIDATING`/`APPLYING`）。这一次执行已经收过尾了，
    //    因此它必须**不在**这里 —— 在的话说明协调器把行留在了执行中。
    //  - `listByStates(['RECOVERY_REQUIRED'])`：还有谁在等一个判定。
    //    待恢复的操作必须在**这里**。
    const operationId = r.operationId();
    assert.ok(operationId !== null, '这次执行必须留下一条操作记录');
    assert.deepEqual(
      r.repos.operations.listUnfinished().map((op) => op.id),
      [],
      '执行已经收过尾，状态库里不该还留着「执行中」的行',
    );
    assert.ok(
      r.repos.operations.listByStates(['RECOVERY_REQUIRED']).some((op) => op.id === operationId),
      '这次操作必须停在待恢复，好让恢复流程找得到它',
    );
    await r.expectCanariesIntact(canaries);
  });

  it('反向探针：同一个装置、注入不做事 ⇒ 必须写得成（否则上一条验的是空气）', async () => {
    const r = await rigOf('crash-control');
    const canaries = await r.canaries();

    // 同一套 `withRace`、同一个规则位置（`writeFileGuarded` 之前），
    // 只是 `act` 什么都不做。这一次执行必须**写得成** —— 否则上面那条
    // 「没报 APPLIED」可能只是因为这套装置本来就写不成。
    const outcome = await r.runWith(
      withRace([{ before: 'writeFileGuarded', act: () => Promise.resolve() }], backend, r.ctx),
    );

    assert.equal(outcome.kind, 'finished');
    if (outcome.kind !== 'finished') throw new Error('上面一行已经断言过');
    assert.equal(outcome.state, 'APPLIED', `没有故障时必须写成：${outcome.detail}`);
    assert.equal(sha256(await readFile(r.abs())), sha256(r.target));
    await r.expectCanariesIntact(canaries);
  });

  it('助手在写入**之前**就已经不在了 ⇒ 盘上仍是基线，账上仍然必须说「不知道」', async () => {
    // 这一条是 §1 的**镜像**，也是本文件最想说的一句话：
    // 「盘上看起来没变」**不是**得出「没动过」的依据。
    // 客户端合成的失败什么都没证明 —— 它可能来自「进程在写之前就被杀了」，
    // 也可能来自「写了一半之后被杀」，而在调用方看来两者一模一样。
    // 于是账上只能记「不知道」，交给人看。
    //
    // 一个「看盘上没变就报 untouched」的实现在这一格上会报成
    // `rolled_back` + 「工作区回到执行之前的样子」，而它**恰好蒙对了**这一次
    // —— 那就更糟：它会在下一次（写了一半的那次）上继续蒙。
    const r = await rigOf('crash-before');
    const canaries = await r.canaries();
    const guardsBefore = guardHelperPids().length;

    const outcome = await runThenRestore(r, [
      {
        before: 'writeFileGuarded',
        act: async () => {
          // 真进程退出（`Stop-Process -Force`），盘上一个字节没动。
          // 杀的是**真护栏自己**的进程，因此「助手不在」这件事与生产里
          // 被任务管理器杀掉时完全同源。
          const killed = await killGuardHelpers();
          assert.ok(killed.length > 0, '没有杀到任何助手 —— 故障没有落地');
        },
      },
    ]);

    assert.ok(
      guardHelperPids().length < guardsBefore,
      `助手进程没有真的退出：之前 ${guardsBefore} 个，现在 ${guardHelperPids().length} 个`,
    );
    // 盘上确实还是基线 —— 也就是说「报没动过」在这一次是**对的**。
    assert.equal(sha256(await readFile(r.abs())), sha256(r.baseline), '这一次盘上应当一个字节都没动');

    // 而账上仍然必须是「不知道」。
    assert.equal(outcome.kind, 'finished');
    if (outcome.kind !== 'finished') throw new Error('上面一行已经断言过');
    assert.equal(outcome.state, 'RECOVERY_REQUIRED', `必须是待恢复：${outcome.state} / ${outcome.detail}`);
    assert.match(outcome.detail, /没有被报告过/, `报告必须说明这条失败证明不了什么：${outcome.detail}`);
    assert.doesNotMatch(
      outcome.detail,
      /(未|没有)进入破坏性区域/,
      `盘上确实没变，而这**不是**护栏说的 —— 不许把未知印成这个否定：${outcome.detail}`,
    );
    const stages = r.stagesOf();
    const names: readonly string[] = stages;
    assert.equal(
      names.includes(ITEM_STAGE.untouched),
      false,
      `盘上没变**不是**「没动过」的依据，账上不得出现 untouched：${stages.join(' → ')}`,
    );
    assert.deepEqual(
      stages,
      [ITEM_STAGE.intent, ITEM_STAGE.failed, ITEM_STAGE.restore_skipped],
      `账上应当是「记了意图 → 写了失败 → 放弃自动收回」：${stages.join(' → ')}`,
    );
    const operationId = r.operationId();
    assert.ok(operationId !== null, '这次执行必须留下一条操作记录');
    assert.equal(
      r.repos.operations.requireById(operationId).state,
      'RECOVERY_REQUIRED',
      '状态库里这条操作必须停在待恢复',
    );
    await r.expectCanariesIntact(canaries);
  });

  it('无关：一次「助手不可用」的失败**不是**一个可以重放的理由 —— 第二次运行不写第二个字节', async () => {
    // 「无重复追加」这一条在故障之后尤其要紧：一次待恢复的执行，如果
    // 换一个人（或换一次调度）再跑一遍，就可能把同一个条目写两次。
    // 认领那一层必须挡住它 —— 而这里断言的判据是**磁盘与账本**，
    // 不是「认领返回了什么」。
    const r = await rigOf('crash-replay');
    const injector = await injectorOf();

    await runThenRestore(r, [
      {
        before: 'writeFileGuarded',
        act: async (_ctx, req) => {
          await crashInWrite(injector, req as unknown as GuardedWriteRequest, 'truncate_then_crash');
          await killGuardHelpers();
        },
      },
    ]);

    const afterCrash = await readFile(r.abs());
    const eventsAfterCrash = r.ledger().events.length;
    // 自查：`truncate_then_crash` 之后盘上应当是 0 字节 —— 这一格是
    // 「截断发生了，而写入一个字节都没发生」，与 §1 的半写互补。
    assert.equal(afterCrash.length, 0, `截断之后应当是 0 字节，实际 ${afterCrash.length}`);

    // 第二次运行：同一个修改集、同一套装置，**护栏已经重新起来了**
    // （`runThenRestore` 的 `finally` 里重新自检过）。因此这一次的拒绝不是
    // 「护栏不在」，而是「盘上不是被批准的那一份」—— 那正是应当发生的事。
    const again = await r.runWith(backend);

    assert.notEqual(
      again.kind === 'finished' ? again.state : again.kind,
      'APPLIED',
      `第二次运行不得报成 APPLIED：${JSON.stringify(again)}`,
    );
    assert.deepEqual([...(await readFile(r.abs()))], [...afterCrash], '第二次运行一个字节都不许写');
    assert.equal(
      r.ledger().events.length,
      eventsAfterCrash,
      '第二次运行不得往账上追加任何条目日志',
    );
  });

  it('装置自查：`assertGoneByCrash` / `assertGuardGone` 认得出真退出，也拒绝别的东西', () => {
    // 装置本身也要能被证伪。一条「任何失败都算通过」的断言会让上面几条
    // 一起失去意义，因此这里正面验一次它认什么、不认什么。
    // 纯函数，不需要夹具。
    const unavailable = (message: string): WinfsError => ({
      ok: false,
      code: 'NATIVE_GUARD_UNAVAILABLE',
      message,
      win32_error: 0,
    });

    // 真退出码 43（`ResidentHelper.#onGone` 拼出来的那一句）：认。
    assertGoneByCrash(unavailable('助手已退出（退出码 43，信号 null）'), 43);
    // 手写的、没有退出码的失败：不认。
    assert.throws(() => assertGoneByCrash(unavailable('助手不可用'), 43), /必须来自真实的进程退出/);
    // 别的错误码：不认 —— 否则一次普通的共享冲突也会被当成「进程死了」。
    assert.throws(
      () => assertGoneByCrash({ ...unavailable('退出码 43'), code: 'FILE_BUSY' }, 43),
      /期望「护栏不可用」/,
    );

    // `assertGuardGone` 认「助手已退出」那一句，不认别的「不可用」——
    // 三条路都叫 NATIVE_GUARD_UNAVAILABLE，而只有一条说明进程真的死过。
    assertGuardGone(unavailable('助手已退出（退出码 1，信号 null）'));
    assert.throws(
      () => assertGuardGone(unavailable('常驻助手未启动')),
      /必须来自 exit 事件/,
      '「未启动」不是「死过」—— 它是 `call()` 在 `#child` 为空时抛的普通 Error',
    );
    assert.throws(
      () => assertGuardGone(unavailable('护栏助手通信失败：写 EPIPE')),
      /必须来自 exit 事件/,
      '「通信失败」同样不是「退出事件」',
    );
  });
});
