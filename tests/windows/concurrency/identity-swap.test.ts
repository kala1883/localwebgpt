/**
 * LWB-033 · 真 NTFS：同内容换文件身份、目录交换、目标消失。
 *
 * ## 这三格的共同点：路径字符串与内容哈希**都没变**
 *
 * 它们是同一种失败的两个变体，而那种失败在 LWB 里有一个专门的名字
 * （I05 / I03）：**路径不是对象**。一个「按字符串找文件、按哈希判基线」的
 * 实现，在这三格上会一路放行 —— 因为它看到的每一个字节都是对的。
 *
 * | 格 | 变的是什么 | 只有谁能证明它变了 |
 * | --- | --- | --- |
 * | 同内容换身份 | 文件索引（删除重建） | 卷序列号 + 文件索引 |
 * | 目录交换 | 目标**之上**那一级的身份 | 逐级固定之后的目标身份 |
 * | 目标消失 | 什么都不剩 | 打开句柄这一步本身 |
 *
 * 第一格是本文件的核心，因此它带了一条**自查**：注入之后立刻断言
 * 「磁盘上的字节与基线逐字节相同」。没有这一句，用例可能只是因为
 * 内容变了而被挡下来 —— 那么它验的就是哈希比对（`executor-write-path.test.ts`
 * 已经在阶段 A 上验过），而不是身份比对。
 *
 * ## 为什么全部打在阶段 A **之后**
 *
 * 「换掉目标」这件事在阶段 A **之前**发生，会被阶段 A 的核对报成 `conflict`
 * —— 那条路已经有用例了（`executor-write-path.test.ts` 验收 1 前半）。本文件
 * 的窗口是阶段 A 刚刚证明过、字节还没落下去的那一瞬间，那时**唯一**还在
 * 起作用的是护栏在句柄里的步骤 0 与步骤 1（`WinfsGuard.ps1` 的
 * `Op-WriteFileGuarded`）。两个窗口的结论必须一致，而它们的**成本**不同：
 * 这一条要开一个写句柄，而那一条一个句柄都不用开。
 */

import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { ITEM_STAGE } from '@lwb/executor';
import { PowerShellWinfsBackend, isWinfsError } from '@lwb/winfs';

import {
  describeWindows,
  openRig,
  sha256,
  theirsOf,
  thirdPartyReplacesWithSameBytes,
  thirdPartySwapsDirectory,
  withRace,
  type ConcurrencyRig,
} from './rig.ts';

describeWindows('LWB-033 真 NTFS：同内容换身份、目录交换、目标消失', () => {
  let sandbox = '';
  let backend: PowerShellWinfsBackend;
  const rigs: ConcurrencyRig[] = [];

  before(async () => {
    sandbox = await mkdtemp(path.join(os.tmpdir(), 'lwb-concurrency-identity-'));
    backend = new PowerShellWinfsBackend();
    const capability = await backend.capability();
    assert.equal(capability.available, true, `护栏后端不可用：${capability.backend === 'none' ? capability.resolved_backend_reason : ''}`);
  });

  after(async () => {
    for (const rig of rigs.splice(0)) rig.close();
    await backend?.dispose();
    await rm(sandbox, { recursive: true, force: true });
  });

  const rigOf = async (seed: string, options: Parameters<typeof openRig>[3] = {}): Promise<ConcurrencyRig> => {
    const rig = await openRig(sandbox, backend, seed, options);
    rigs.push(rig);
    return rig;
  };

  /** 用**护栏自己**的眼睛看这个文件的身份与哈希。测试不另算一份。 */
  const identityOf = async (r: ConcurrencyRig, relative: string = r.rel) => {
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
  };

  it('同内容换文件身份：删掉重建（字节一模一样）⇒ 只有身份能挡住它', async () => {
    const r = await rigOf('same-bytes');
    const canaries = await r.canaries();
    const before = await identityOf(r);

    let after: { file_id: string; sha256: string } | null = null;
    const outcome = await r.runWith(
      withRace(
        [
          {
            before: 'writeFileGuarded',
            act: async () => {
              await thirdPartyReplacesWithSameBytes(r.abs());
              // **自查**：这次注入真的做到了「字节不变、身份变了」吗。
              // 少了这两句，下面的断言可能只是因为内容变了而通过 ——
              // 那样验的就是哈希比对，不是身份比对。
              after = await identityOf(r);
              assert.notEqual(after.file_id, before.file_id, '注入没有换掉对象，这一格就没在验身份');
              assert.equal(after.sha256, before.sha256, '注入把字节也改了，这一格就没在验「同内容」');
            },
          },
        ],
        backend,
        r.ctx,
      ),
    );

    assert.equal(outcome.kind, 'finished', `协调器应当交回结论：${JSON.stringify(outcome)}`);
    if (outcome.kind !== 'finished') throw new Error('上面一行已经断言过');
    assert.notEqual(outcome.state, 'APPLIED', '对象已经换人，这次执行却报成了 APPLIED');
    assert.match(
      outcome.detail,
      /FILE_VERSION_CONFLICT/,
      `必须指名对象与批准的那一个不符：${outcome.detail}`,
    );

    // 磁盘：第三方那一份（= 与基线同字节的那一份）原样留着。
    const onDisk = await readFile(r.abs());
    assert.equal(sha256(onDisk), sha256(r.baseline), '盘上应当还是那一份字节');
    assert.notEqual(sha256(onDisk), sha256(r.target), '我们的目标字节一个都不该落下去');
    assert.equal(
      r.stagesOf().includes(ITEM_STAGE.untouched),
      true,
      `账上必须留下「没动过」：${r.stagesOf().join(' → ')}`,
    );
    await r.expectCanariesIntact(canaries);
  });

  it('同内容换身份（对照）：没有注入时同样字节的文件写得成', async () => {
    // 受控对照。与上一条**逐字节相同**的基线、同样的代码路径，唯一的差别
    // 是没有人换掉那个对象。没有这一条，上一条可能只是「这个夹具写不成」。
    const control = await rigOf('same-bytes-control', { content_seed: 'same-bytes' });
    const outcome = await control.runWith(backend);
    assert.equal(outcome.kind, 'finished');
    if (outcome.kind !== 'finished') throw new Error('上面一行已经断言过');
    assert.equal(outcome.state, 'APPLIED', `没有注入时必须写得成：${outcome.detail}`);
    assert.equal(sha256(await control.onDisk()), sha256(control.target));
  });

  it('**第三种状态**：第三方在窗口里写下第三个版本 ⇒ 它不被我们覆盖，也不被我们收回', async () => {
    // 这是本工程最在意的一格。「第三次态」的定义是：盘上既不是批准时的基线，
    // 也不是我们的目标内容。它可能来自一个被打断的编辑器保存、一次外部脚本、
    // 或者另一个写手。两条都要成立：
    //
    //   ① **不覆盖它** —— 一次自动写入没有资格抹掉别人的内容（I07 的方向）；
    //   ② **不收回它** —— 收回的前提是「盘上是我们写下去的那一份」，
    //      而这次我们一个字节都没写，那个「我们写下去的那一份」不存在。
    //      去「恢复」一个我们从未写过的对象，等于用基线覆盖一个人的改动。
    const r = await rigOf('third-state');
    const canaries = await r.canaries();
    const theirs = theirsOf(r.seed, 'third-state');

    const outcome = await r.runWith(
      withRace([{ before: 'writeFileGuarded', act: () => writeFile(r.abs(), theirs) }], backend, r.ctx),
    );

    assert.equal(outcome.kind, 'finished');
    if (outcome.kind !== 'finished') throw new Error('上面一行已经断言过');
    assert.notEqual(outcome.state, 'APPLIED');

    // ①② 磁盘：第三方的字节**逐字节**留着 —— 既不是我们的目标，也不是基线。
    const onDisk = await readFile(r.abs());
    assert.equal(sha256(onDisk), sha256(theirs), '第三态必须原样留着');
    assert.notEqual(sha256(onDisk), sha256(r.target), '不得覆盖成我们的目标内容');
    assert.notEqual(sha256(onDisk), sha256(r.baseline), '也不得被「恢复」成基线');
    // 账：这个条目一次 `restored` 都不该有 —— 想收回一个没写过的东西，
    // 会在这条断言上露出来。
    assert.equal(
      r.stagesOf().includes(ITEM_STAGE.restored),
      false,
      `不该出现「已回到基线」：${r.stagesOf().join(' → ')}`,
    );
    assert.equal(r.ledger().aggregate, 'rolled_back');
    await r.expectCanariesIntact(canaries);
  });

  it('目录交换：目标**之上**那一级被换成同名新目录 ⇒ 新目录里的同名文件一个字节都不动', async () => {
    // 这一格防的是一次**范围**上的错误：`src` 被换掉之后，`src/draft.txt`
    // 仍然存在 —— 只是变成了另一个对象。一个只按「路径 + 基线哈希」判定的
    // 实现会认为「目标还在、内容也没变」，然后把字节写进一个从未被批准的目录里。
    //
    // 两条断言合起来才是完整的：新目录里的同名文件**没被碰**，
    // 而真正被批准的那一个（连同它的目录被挪到一边）**还在基线**。
    const r = await rigOf('dir-swap');
    const canaries = await r.canaries();
    const parked = 'src-parked';
    const theirs = theirsOf(r.seed, 'dir-swap');
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

    assert.equal(outcome.kind, 'finished');
    if (outcome.kind !== 'finished') throw new Error('上面一行已经断言过');
    assert.notEqual(outcome.state, 'APPLIED', '目标已经被换到另一个目录，却报成了 APPLIED');
    assert.match(
      outcome.detail,
      /FILE_VERSION_CONFLICT/,
      `必须指名对象与批准的那一个不符：${outcome.detail}`,
    );

    assert.equal(sha256(await readFile(newDirFile)), sha256(theirs), '新目录里的同名文件被碰了');
    assert.equal(
      sha256(await readFile(parkedFile)),
      sha256(r.baseline),
      '被批准的那一个（已挪到旁边）必须还是基线',
    );
    await r.expectCanariesIntact(canaries);
  });

  it('目标消失：窗口里被移走 ⇒ NOT_FOUND，移走的那个文件仍是基线', async () => {
    const r = await rigOf('vanished');
    const canaries = await r.canaries();
    const moved = path.join(r.dir, 'src', 'draft.moved.txt');

    const outcome = await r.runWith(
      withRace([{ before: 'writeFileGuarded', act: () => rename(r.abs(), moved) }], backend, r.ctx),
    );

    assert.equal(outcome.kind, 'finished');
    if (outcome.kind !== 'finished') throw new Error('上面一行已经断言过');
    assert.notEqual(outcome.state, 'APPLIED');
    assert.match(outcome.detail, /NOT_FOUND/, `必须指名目标不存在：${outcome.detail}`);
    // 被移走的那个文件仍是基线：我们没有顺着「同一个名字的新对象」或者
    // 「目录里唯一那个文件」去把它找回来写掉。
    assert.equal(sha256(await readFile(moved)), sha256(r.baseline));
    await assert.rejects(
      async () => await access(r.abs()),
      '目标位置应当确实空着 —— 否则上一条断言可能只是「它还在原地」',
    );
    await r.expectCanariesIntact(canaries);
  });

  it('授权外文件本身被换掉**不算**冲突：看门文件不参与任何判定', async () => {
    // 反向的一条：**不许**把「工作区里有个我们没管过的文件变了」当成冲突。
    // 一个「扫描整个工作区、发现不一致就拒绝」的实现会在这里拒绝 ——
    // 那是一种越界：本工具面只管修改集里列出的那些路径。
    const r = await rigOf('canary-noise');
    const canaries = await r.canaries();

    const outcome = await r.runWith(
      withRace(
        [
          {
            before: 'writeFileGuarded',
            act: () => writeFile(path.join(r.dir, r.inside_canary), theirsOf(r.seed, 'canary-noise')),
          },
        ],
        backend,
        r.ctx,
      ),
    );

    assert.equal(outcome.kind, 'finished');
    if (outcome.kind !== 'finished') throw new Error('上面一行已经断言过');
    assert.equal(
      outcome.state,
      'APPLIED',
      `授权外的文件不属于这次判定：${outcome.detail}`,
    );
    assert.equal(sha256(await r.onDisk()), sha256(r.target));

    // 这里**不能**用 `expectCanariesIntact` —— 工作区内的那个看门文件正是
    // 这次注入改掉的东西。要断言的是另外两件：
    //   ① 注入**确实落到了盘上**（否则本用例可能只是「注入没生效」）；
    //   ② 工作区**外面**的那一个照样原封不动（越界的路没有被走通）。
    const after = await r.canaries();
    assert.notEqual(
      after.inside.sha256,
      canaries.inside.sha256,
      '注入没有落到盘上，本用例验的是空气',
    );
    assert.equal(after.inside.sha256, sha256(theirsOf(r.seed, 'canary-noise')), '看门文件必须是第三方那一份');
    assert.deepEqual(after.outside, canaries.outside, '工作区外的文件不得被任何路径碰到');
  });
});
