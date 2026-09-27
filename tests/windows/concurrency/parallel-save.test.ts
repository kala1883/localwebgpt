/**
 * LWB-033 · 真 NTFS：并行保存、文件占用与权限变化。
 *
 * ## 这三格问的是同一件事的三个变体
 *
 * 「另一个人正在动同一个文件」在本机上有三条完全不同的实现路径，
 * 而它们**必须得到同一个结论**（不改、不报成 APPLIED、去看门文件）：
 *
 * | 格 | 第三方做了什么 | 内核据此给出的拒绝 | 靠哪一条机制 |
 * | --- | --- | --- | --- |
 * | 并行保存 | 用普通文件 API 就地覆盖 | 基线哈希不符 | 句柄内比较（步骤 1） |
 * | 文件占用 | 以不共享写的句柄占住 | 共享冲突 | `CreateFileW` 的共享模式 |
 * | 权限变化 | 把文件设成只读 | 访问被拒 | ACL / 只读属性 |
 *
 * 它们的**共同点**是「拒绝发生在护栏打开句柄的那一刻或之后」，而
 * **不同点**是由谁给出的 —— 第一条是我们自己比出来的，后两条是内核挡下来的。
 * 分开验的理由就在这里：一个「凡事先比哈希」的实现能过第一条，
 * 却在后两条上完全依赖内核，而内核的拒绝理由是要被翻译成正确结论的
 * （`FILE_BUSY` 可重试，`PERMISSION_DENIED` 不可重试，两者都不是「没写过」）。
 *
 * ## 反向探针是**必须**的，不是礼貌
 *
 * §1/§3/§4 断言的都是「这次没写成」。而一个「这个夹具本来就写不成」的
 * 世界会让这三条**一起变绿** —— 那种绿是本仓库最不能接受的一种，因为它
 * 把「护栏挡住了」和「什么都没发生」画上了等号。因此每一格都配一次
 * **同一个夹具、去掉竞争**的运行，它必须报 `applied`。§2 是 §1 的那一次，
 * §3b、§4b 各自跟在自己的注入后面。
 */

import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { ITEM_STAGE } from '@lwb/executor';
import { ResidentHelper, PowerShellWinfsBackend, isWinfsError } from '@lwb/winfs';
import type { WinfsOps } from '@lwb/winfs';

import {
  bodyOf,
  describeWindows,
  openRig,
  sha256,
  theirsOf,
  thirdPartySaves,
  withRace,
  type ConcurrencyRig,
} from './rig.ts';

describeWindows('LWB-033 真 NTFS：并行保存、文件占用与权限变化', () => {
  let sandbox = '';
  let backend: PowerShellWinfsBackend;
  const rigs: ConcurrencyRig[] = [];

  before(async () => {
    sandbox = await mkdtemp(path.join(os.tmpdir(), 'lwb-concurrency-parallel-'));
    backend = new PowerShellWinfsBackend();
    const capability = await backend.capability();
    assert.equal(capability.available, true, `护栏后端不可用：${capability.resolved_backend_reason}`);
  });

  after(async () => {
    for (const rig of rigs.splice(0)) rig.close();
    await backend?.dispose();
    await rm(sandbox, { recursive: true, force: true });
  });

  const rigOf = async (seed: string): Promise<ConcurrencyRig> => {
    const rig = await openRig(sandbox, backend, seed);
    rigs.push(rig);
    return rig;
  };

  it('验收 1（并行保存）：第三方在阶段 A 之后覆盖了目标 ⇒ 零字节落下，且绝不报成 APPLIED', async () => {
    const r = await rigOf('save');
    const abs = r.abs();
    const canaries = await r.canaries();
    // 第三方的保存发生在**阶段 A 已经核对过之后**、写入之前的那一瞬间。
    const theirs = theirsOf(r.seed, 'save');

    const outcome = await r.runWith(
      withRace([{ before: 'writeFileGuarded', act: () => thirdPartySaves(abs, theirs) }], backend, r.ctx),
    );

    // ① 终局：**没有错误的 APPLIED**。这一条是整个任务的第一句验收标准。
    assert.equal(outcome.kind, 'finished', `协调器应当交回结论：${JSON.stringify(outcome)}`);
    if (outcome.kind !== 'finished') throw new Error('上面一行已经断言过');
    assert.notEqual(outcome.state, 'APPLIED', '别人覆盖了目标，这次执行却报成了 APPLIED');
    assert.equal(outcome.state, 'ROLLED_BACK');
    assert.match(outcome.detail, /FILE_VERSION_CONFLICT/, `失败原因必须指名基线不符：${outcome.detail}`);

    // ② 磁盘：留下的是**第三方的字节**。这一条比①更强 —— 报告与状态库
    //    都可能说错，而这三个哈希不会。
    assert.equal(sha256(await r.onDisk()), sha256(theirs), '盘上应当是第三方保存的那一份');
    assert.notEqual(sha256(await r.onDisk()), sha256(r.target), '我们的目标字节一个都不该落下去');
    assert.notEqual(sha256(await r.onDisk()), sha256(r.baseline), '基线也不该在（第三方覆盖过）');

    // ③ 账：这个条目走过的路必须能读出「护栏在进入破坏性区域之前就拒绝了」。
    const stages = r.stagesOf();
    assert.equal(
      stages.includes(ITEM_STAGE.untouched),
      true,
      `账上必须留下「没动过」：${stages.join(' → ')}`,
    );
    assert.equal(
      stages.includes(ITEM_STAGE.written),
      false,
      `账上不该有「写了」：${stages.join(' → ')}`,
    );
    assert.equal(r.ledger().aggregate, 'rolled_back');

    // ④ 授权外文件：整套装置的固定构件。
    await r.expectCanariesIntact(canaries);

    // ⑤ 报告里**不能同时**出现这两句话。
    //    「独立回读…与基线不同」是这次执行看到的事实（第三方改过盘），
    //    而「工作区回到执行之前的样子」在那句话成立的前提下是**假的** ——
    //    一次并发保存之后的盘上，已经不是执行之前的样子了。
    //    这两句话来自同一份报告的同一段文字，因此这一条断言的是
    //    「报告不自相矛盾」，而不是某一句话的措辞偏好。
    assert.match(outcome.detail, /与基线不同/, '报告必须如实说明盘上已经不是基线');
    assert.doesNotMatch(
      outcome.detail,
      /工作区回到执行之前的样子/,
      `盘上是第三方的字节，报告却声称工作区回到了执行之前的样子：${outcome.detail}`,
    );
  });

  it('反向探针：同一个夹具去掉注入 ⇒ 必须写得成（否则上一条验的是空气）', async () => {
    const r = await rigOf('save-control');
    const canaries = await r.canaries();

    const outcome = await r.runWith(backend);

    assert.equal(outcome.kind, 'finished');
    if (outcome.kind !== 'finished') throw new Error('上面一行已经断言过');
    assert.equal(outcome.state, 'APPLIED', `没有竞争时必须写成：${outcome.detail}`);
    assert.equal(sha256(await r.onDisk()), sha256(r.target));
    await r.expectCanariesIntact(canaries);
  });

  it('验收 1（文件占用）：第三方以不共享写的句柄占住目标 ⇒ 共享冲突，我们一个字节都不写', async () => {
    // 受控对照：另一个 rig，**逐字节相同**的目标文件，唯一的差别是没有人占着它。
    // 两个 rig 在动手之前一起建好，因此「对照那一个能写成」这件事不依赖
    // 任何发生在本次执行之后的状态变化。
    const control = await openRig(sandbox, backend, 'busy-control', { content_seed: 'busy' });
    rigs.push(control);
    const r = await rigOf('busy');
    assert.equal(
      sha256(control.baseline),
      sha256(r.baseline),
      '对照夹具与注入夹具的基线必须逐字节相同，否则「唯一的差别是那一个注入」不成立',
    );

    const canaries = await r.canaries();
    const helper = new ResidentHelper();
    await helper.start();

    try {
      const volume = await backend.statVolume({ path: r.dir });
      assert.equal(volume.ok, true, `statVolume 失败：${JSON.stringify(volume)}`);
      if (isWinfsError(volume)) throw new Error('上面一行已经断言过');

      const outcome = await r.runWith(
        withRace(
          [
            {
              before: 'writeFileGuarded',
              // 持有用的是**护栏自己的** `holdHandle`：同一个 `Open-Guarded`、
              // 同一组 Win32 标志。用别的语言/别的 API 去「模拟占用」，验的
              // 就是那个模拟器，而不是这台机器上的共享语义。
              act: async () => {
                const held = await helper.call({
                  op: 'holdHandle',
                  root_path: r.dir,
                  root_volume_id: volume.volume_id,
                  root_file_id: volume.file_id,
                  relative_path: r.rel,
                  access: 'write',
                  share_mode: 'read',
                });
                assert.equal(held['ok'], true, `holdHandle 失败：${JSON.stringify(held)}`);
              },
            },
          ],
          backend,
          r.ctx,
        ),
      );

      assert.equal(outcome.kind, 'finished');
      if (outcome.kind !== 'finished') throw new Error('上面一行已经断言过');
      assert.notEqual(outcome.state, 'APPLIED', '被占用时却报成了 APPLIED');
      assert.match(outcome.detail, /FILE_BUSY/, `必须指名共享冲突：${outcome.detail}`);
      assert.match(outcome.detail, /Win32 32/, '共享冲突的 Win32 码是 32');
      // 被挡住的那一次**没有**越过破坏性区域，因此盘上是原封不动的基线。
      assert.equal(sha256(await r.onDisk()), sha256(r.baseline), '被占用时不得留下半个字节');
      assert.equal(
        r.stagesOf().includes(ITEM_STAGE.untouched),
        true,
        `账上必须留下「没动过」：${r.stagesOf().join(' → ')}`,
      );
      await r.expectCanariesIntact(canaries);

    } finally {
      await helper.stop();
    }

    // ④ 对照：同样的字节、同样的代码路径、同样一个真护栏，**只是没有人占着它**，
    //    必须写成。这一条与上面那条合起来才叫「是共享模式挡的」——
    //    单独看上面，一个「这个文件根本不能写」的世界同样能让它变绿。
    const after = await control.runWith(backend);
    assert.equal(after.kind, 'finished');
    if (after.kind !== 'finished') throw new Error('上面一行已经断言过');
    assert.equal(after.state, 'APPLIED', `无人占用时必须写得成：${after.detail}`);
    assert.equal(sha256(await control.onDisk()), sha256(control.target));
  });

  it('验收 1（权限变化）：第三方把目标设成只读 ⇒ 访问被拒，磁盘一个字节没变', async () => {
    const control = await openRig(sandbox, backend, 'readonly-control', { content_seed: 'readonly' });
    rigs.push(control);
    const r = await rigOf('readonly');
    assert.equal(sha256(control.baseline), sha256(r.baseline), '两个夹具的基线必须逐字节相同');
    const abs = r.abs();
    const canaries = await r.canaries();

    const outcome = await r.runWith(
      withRace(
        [
          {
            before: 'writeFileGuarded',
            // `chmod 0o444` 在 Windows 上设的是**只读属性**，而只读属性
            // 正是 `CreateFileW` 拒绝 `GENERIC_WRITE` 的那条路
            // （ERROR_ACCESS_DENIED）。它不是 ACL —— ACL 那一格在
            // `executor-create-path.test.ts` 验收 3 里单独验过。
            act: async () => {
              await chmod(abs, 0o444);
            },
          },
        ],
        backend,
        r.ctx,
      ),
    );

    assert.equal(outcome.kind, 'finished');
    if (outcome.kind !== 'finished') throw new Error('上面一行已经断言过');
    assert.notEqual(outcome.state, 'APPLIED', '只读的目标却被报成了 APPLIED');
    assert.match(outcome.detail, /PERMISSION_DENIED/, `必须指名访问被拒：${outcome.detail}`);
    assert.match(outcome.detail, /Win32 5/, '访问被拒的 Win32 码是 5');
    assert.equal(sha256(await r.onDisk()), sha256(r.baseline), '被拒的写入不得留下半个字节');
    assert.equal(
      r.stagesOf().includes(ITEM_STAGE.untouched),
      true,
      `账上必须留下「没动过」：${r.stagesOf().join(' → ')}`,
    );
    await r.expectCanariesIntact(canaries);

    // 对照：同样的字节、同样的代码路径，**只是没有被动过权限**，必须写成 ——
    // 否则上面那条只是「这个文件写不了」。
    const after = await control.runWith(backend);
    assert.equal(after.kind, 'finished');
    if (after.kind !== 'finished') throw new Error('上面一行已经断言过');
    assert.equal(after.state, 'APPLIED', `权限未被改动时必须写得成：${after.detail}`);
    assert.equal(sha256(await control.onDisk()), sha256(control.target));
  });

  it('占用期间**别人**也写不进去：被拒的那一次没有绕过共享模式', async () => {
    // 这一条钉的是本工程的一条硬规矩：护栏不可用或被挡住时，
    // **绝不**降级成普通的托管文件 API 去把写入完成
    // （`packages/winfs/src/ops.ts` 的 fail-closed 要求）。
    // 一次「想尽办法写进去」的实现会在这一格上把字节落下。
    const r = await rigOf('no-bypass');
    const canaries = await r.canaries();
    const helper = new ResidentHelper();
    await helper.start();

    try {
      const volume = await backend.statVolume({ path: r.dir });
      assert.equal(volume.ok, true);
      if (isWinfsError(volume)) throw new Error('上面一行已经断言过');
      const held = await helper.call({
        op: 'holdHandle',
        root_path: r.dir,
        root_volume_id: volume.volume_id,
        root_file_id: volume.file_id,
        relative_path: r.rel,
        access: 'write',
        share_mode: 'read',
      });
      assert.equal(held['ok'], true, `holdHandle 失败：${JSON.stringify(held)}`);

      // 占用之下直接问护栏（不经过协调器、不经过 applier）。
      const guarded = await (backend as WinfsOps).writeFileGuarded({
        root_path: r.dir,
        root_volume_id: volume.volume_id,
        root_file_id: volume.file_id,
        relative_path: r.rel,
        // 传**当前**哈希：传一个过期的基线，那次失败就可能来自基线核对，
        // 于是「被共享模式挡住」这条结论便没有了证据。
        expected_sha256: sha256(await readFile(r.abs())),
        content_base64: r.target.toString('base64'),
      });
      assert.equal(guarded.ok, false, '被占用时护栏必须拒绝');
      if (isWinfsError(guarded)) {
        assert.equal(guarded.code, 'FILE_BUSY');
        assert.equal(guarded.win32_error, 32);
      }
      assert.equal(sha256(await readFile(r.abs())), sha256(r.baseline), '被拒的那一次不得留下字节');
      await r.expectCanariesIntact(canaries);
    } finally {
      await helper.stop();
    }
  });

  it('第三方在**阶段 A 之前**就动过手 ⇒ 冲突在更早、更便宜的那一步定案（不是靠护栏兜底）', async () => {
    // 与 §1 成对：§1 验的是**后一道防线**（护栏在句柄里发现），这一条验的是
    // **前一道**（阶段 A 核对时就发现）。两道防线的结论必须一致地
    // 「不改、不报成 APPLIED」，但**成本**不同 —— 阶段 A 那次一个句柄都没开过写。
    //
    // 注入点因此打在**读**上：阶段 A 的 `readFileGuarded` 之前动手。
    const r = await rigOf('pre-phase-a');
    const canaries = await r.canaries();
    const theirs = theirsOf(r.seed, 'pre-phase-a');

    const ops: WinfsOps = {
      capability: () => backend.capability(),
      statVolume: (req) => backend.statVolume(req),
      validatePath: (req) => backend.validatePath(req),
      resolvePath: (req) => backend.resolvePath(req),
      listDirectory: (req) => backend.listDirectory(req),
      createFileGuarded: (req) => backend.createFileGuarded(req),
      writeFileGuarded: (req) => backend.writeFileGuarded(req),
      readFileGuarded: async (req) => {
        await thirdPartySaves(r.abs(req.relative_path), theirs);
        return backend.readFileGuarded(req);
      },
    };

    const outcome = await r.runWith(ops);

    assert.equal(outcome.kind, 'finished');
    if (outcome.kind !== 'finished') throw new Error('上面一行已经断言过');
    assert.notEqual(outcome.state, 'APPLIED');
    assert.equal(outcome.state, 'CONFLICT', `阶段 A 就该报成冲突：${outcome.state} / ${outcome.detail}`);
    assert.equal(sha256(await r.onDisk()), sha256(theirs), '盘上应当是第三方那一份');
    // 阶段 A 定案 ⇒ 一个逐条目日志都没有（那次执行没进过 `APPLYING`）。
    assert.deepEqual(r.ledger().events, []);
    await r.expectCanariesIntact(canaries);
  });
});
