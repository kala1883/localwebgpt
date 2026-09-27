/**
 * LWB-033 · 真 NTFS：目标创建竞争。
 *
 * ## 这一格与「改写」那一格为什么不能合并
 *
 * 改写的每一格都有一道护栏**总是**存在的防线：基线比对（`expected_sha256`）。
 * 创建没有基线 —— 目标是**还不存在**的东西，因此没有任何「它应该是什么样」的
 * 事实可以拿来比。剩下的**只有一条**：
 *
 * > 判定「存不存在」与创建这个对象必须是**同一次系统调用**（`CREATE_NEW`）。
 *
 * 一次「先 stat 看看在不在，再 create」的实现，在这台机器上有一个真实的窗口：
 * 另一个人（编辑器、构建脚本、另一个模型会话）正好在那两步之间建了同名文件。
 * 那时它会——按它自己的话说——「创建成功」，而实际发生的是**覆盖**。
 *
 * `tests/windows/executor-create-path.test.ts` 已经验过「护栏用的是
 * `CREATE_NEW`、父目录不会被隐式创建、ACL 从父目录继承」。本文件验的是
 * 那条语义在**竞争**下还成不成立，以及失败之后**别人那个文件怎么了**。
 *
 * ## 倒数第二格是本文件最想钉的
 *
 * 「第三方建出来的正好是我们要的内容」——盘上的终态与一次成功的应用**一模一样**。
 * 一个按**状态**判断的实现会在这里报 APPLIED。按**操作**判断的实现会报
 * 「我没写」。后者才是对的：这条工具面的回答是「我做过什么」，
 * 不是「现在是什么样」。而「一次成功的应用」与「别人恰好做对了」的区别，
 * 只有操作日志知道。
 */

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
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
  withRace,
  type ConcurrencyRig,
} from './rig.ts';

describeWindows('LWB-033 真 NTFS：目标创建竞争', () => {
  let sandbox = '';
  let backend: PowerShellWinfsBackend;
  const rigs: ConcurrencyRig[] = [];

  before(async () => {
    sandbox = await mkdtemp(path.join(os.tmpdir(), 'lwb-concurrency-create-'));
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
    const rig = await openRig(sandbox, backend, seed, { create: true });
    rigs.push(rig);
    return rig;
  };

  /** 用**护栏自己**的眼睛看目标的对象身份与哈希。测试不另算一份。 */
  const identityOf = async (r: ConcurrencyRig) => {
    const volume = await backend.statVolume({ path: r.dir });
    if (isWinfsError(volume)) throw new Error(`statVolume 失败：${volume.message}`);
    const read = await backend.readFileGuarded({
      root_path: r.dir,
      root_volume_id: volume.volume_id,
      root_file_id: volume.file_id,
      relative_path: r.rel,
    });
    if (isWinfsError(read)) throw new Error(`readFileGuarded 失败：${read.code} ${read.message}`);
    return { file_id: read.identity.file_id, sha256: read.sha256 };
  };

  it('目标创建竞争：第三方先建了同名文件 ⇒ 我们不覆盖它，一个字节都不碰', async () => {
    const r = await rigOf('create-race');
    const canaries = await r.canaries();
    const theirs = theirsOf(r.seed, 'create-race');

    const outcome = await r.runWith(
      withRace([{ before: 'createFileGuarded', act: () => writeFile(r.abs(), theirs) }], backend, r.ctx),
    );

    assert.equal(outcome.kind, 'finished', `协调器应当交回结论：${JSON.stringify(outcome)}`);
    if (outcome.kind !== 'finished') throw new Error('上面一行已经断言过');
    assert.notEqual(outcome.state, 'APPLIED', '目标已被别人建出来，这次执行却报成了 APPLIED');
    assert.match(outcome.detail, /FILE_VERSION_CONFLICT/, `必须指名「目标已存在」：${outcome.detail}`);

    // **对方那个文件逐字节没被碰。** 这一条是本用例存在的全部理由：
    // 一次「先看在不在、再创建」的实现会在这里把 `theirs` 换成我们的目标内容。
    assert.equal(sha256(await r.onDisk()), sha256(theirs), '别人建出来的文件必须原样留着');
    assert.notEqual(sha256(await r.onDisk()), sha256(r.target), '不得覆盖成我们的目标内容');
    assert.equal(
      r.stagesOf().includes(ITEM_STAGE.untouched),
      true,
      `账上必须留下「没动过」：${r.stagesOf().join(' → ')}`,
    );
    assert.equal(
      r.stagesOf().includes(ITEM_STAGE.written),
      false,
      `账上不该有「写了」：${r.stagesOf().join(' → ')}`,
    );
    assert.equal(r.ledger().aggregate, 'rolled_back');
    await r.expectCanariesIntact(canaries);
  });

  it('反向探针：无人竞争 ⇒ 建成，且字节逐字保真（BOM 与 CRLF 都在）', async () => {
    // 没有这一条，上面那条可能只是「这个夹具根本建不成」。
    const r = await rigOf('create-control');
    const canaries = await r.canaries();

    const outcome = await r.runWith(backend);

    assert.equal(outcome.kind, 'finished');
    if (outcome.kind !== 'finished') throw new Error('上面一行已经断言过');
    assert.equal(outcome.state, 'APPLIED', `没有竞争时必须建成：${outcome.detail}`);
    const onDisk = await readFile(r.abs());
    assert.equal(sha256(onDisk), sha256(r.target));
    // 「逐字节保真」不是「解码后一样」：BOM 与 CRLF 各查一次。
    assert.deepEqual([...onDisk.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'BOM 必须原样写入');
    assert.equal(onDisk.toString('utf8').includes('\r\n'), true, 'CRLF 必须保留');
    await r.expectCanariesIntact(canaries);
  });

  it('竞争失败**不删**对象：别人那个文件连身份都没变，目录里也没留下临时落点', async () => {
    // 这一条防的是「失败时的清理」：一次「创建失败就把目标删掉重来」的实现
    // 会在这里把**别人的**文件删掉（`apply.ts` 的规则 2：建出来的对象不删）。
    // 而一次「先写 `draft.txt.tmp` 再改名」的实现会在这里留下垃圾 ——
    // 本护栏的创建没有临时落点，这一条把这个事实钉在磁盘上。
    const r = await rigOf('create-no-delete');
    const theirs = theirsOf(r.seed, 'create-no-delete');
    let created: { file_id: string; sha256: string } | null = null;

    await r.runWith(
      withRace(
        [
          {
            before: 'createFileGuarded',
            act: async () => {
              await writeFile(r.abs(), theirs);
              created = await identityOf(r);
            },
          },
        ],
        backend,
        r.ctx,
      ),
    );

    const mine = created as { file_id: string; sha256: string } | null;
    assert.notEqual(mine, null, '注入没有落下去，本用例验的是空气');
    if (mine === null) throw new Error('上面一行已经断言过');

    // ① 对象还在，而且**还是同一个对象** —— 「删掉重来」会换掉身份，
    //    「失败后清理」会让它直接消失。两种都会在这两条上露出来。
    const after = await identityOf(r);
    assert.equal(after.file_id, mine.file_id, '别人那个文件被换成了另一个对象');
    assert.equal(after.sha256, sha256(theirs));
    assert.equal((await stat(r.abs())).isFile(), true);

    // ② 目录里没有多出来的东西。
    const entries = await readdir(path.join(r.dir, 'src'));
    assert.deepEqual(
      [...entries].sort(),
      ['draft.txt'],
      `目标目录里多出了东西（临时文件 / 备份）：${entries.join(', ')}`,
    );
  });

  it('第三方建出来的**正好是目标内容** ⇒ 仍然报「我没写」，不报 APPLIED', async () => {
    // 盘上的终态与一次成功的应用**一模一样**，而这次执行一个字节都没写过。
    // 按状态判断会报 APPLIED；按操作判断必须报「我没写」。这是本工程
    // 「回执说的是我做过什么」的落点（`packages/executor/src/apply.ts` 的文件头）。
    const r = await rigOf('create-correct-by-other');
    const canaries = await r.canaries();

    const outcome = await r.runWith(
      withRace(
        [
          {
            before: 'createFileGuarded',
            // 别人写下的字节**就是**我们的目标字节 —— 逐字节相同。
            act: () => writeFile(r.abs(), r.target),
          },
        ],
        backend,
        r.ctx,
      ),
    );

    assert.equal(outcome.kind, 'finished');
    if (outcome.kind !== 'finished') throw new Error('上面一行已经断言过');
    assert.notEqual(
      outcome.state,
      'APPLIED',
      '这些字节不是我们写的 —— 报 APPLIED 就是在替别人的操作背书',
    );
    // 而磁盘上确实已经是目标内容。两条并存才是这个用例要说的话：
    // **终态对**与**这次执行做成了**是两件事。
    assert.equal(sha256(await r.onDisk()), sha256(r.target), '盘上确实是目标内容');
    assert.equal(
      r.stagesOf().includes(ITEM_STAGE.written),
      false,
      `账上不该有「写了」：${r.stagesOf().join(' → ')}`,
    );
    assert.equal(r.ledger().aggregate, 'rolled_back');
    await r.expectCanariesIntact(canaries);
  });

  it('父目录在窗口里被换掉 ⇒ 目标被创建在**当前的**那个目录里，而不是一个悬空句柄上', async () => {
    // 「拿住一个目录句柄、然后按它写进去」在目录被换掉之后会写到**别处**：
    // 旧目录已经不叫那个名字了（这里被挪到 `src-parked`），于是文件会
    // 出现在一个**修改集从未批准过**的位置上。护栏的每一次调用都重新逐级
    // 固定路径，因此它落在当前的那个 `src/` 里 —— 那是本次批准所指的位置
    //（批准的是「相对于工作区根的 `src/draft.txt`」，不是一个 inode）。
    //
    // 两条一起断言才不留歧义：文件出现在新目录里，而旧目录（挪到旁边的那个）
    // **一个条目都没多**。
    const r = await rigOf('create-dir-swap');
    const canaries = await r.canaries();
    const parked = path.join(r.dir, 'src-parked');

    const outcome = await r.runWith(
      withRace(
        [
          {
            before: 'createFileGuarded',
            act: async () => {
              await rename(path.join(r.dir, 'src'), parked);
              await mkdir(path.join(r.dir, 'src'), { recursive: true });
            },
          },
        ],
        backend,
        r.ctx,
      ),
    );

    assert.equal(outcome.kind, 'finished');
    if (outcome.kind !== 'finished') throw new Error('上面一行已经断言过');
    assert.equal(outcome.state, 'APPLIED', `当前目录还在，创建必须成功：${outcome.detail}`);
    assert.equal(sha256(await readFile(path.join(r.dir, 'src', 'draft.txt'))), sha256(r.target));
    // 被挪走的那个目录里**不该**多出目标文件 —— 那是一个修改集从未批准过的位置。
    assert.deepEqual(
      await readdir(parked),
      [],
      '文件被创建在了旧的（已挪走的）目录里',
    );
    await r.expectCanariesIntact(canaries);
  });
});
