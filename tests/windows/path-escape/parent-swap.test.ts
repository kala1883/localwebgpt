/**
 * 并发交换父目录（LWB-010 验收标准 2、步骤 2 与 4）。
 *
 * 要挡的攻击很朴素：
 *   1. 护栏按 `root_path + relative_path` 逐级打开，验证一路平安；
 *   2. 验证完之后、真正读写之前，有人把中间某一级目录改名，
 *      再把另一个目录（或指向工作区外的 Junction）放到同一个名字上；
 *   3. 护栏随后按**字符串路径**打开它以为已经验证过的那个位置。
 *
 * 只靠「先检查再使用」挡不住第 3 步 —— 检查和使用的中间永远有一个窗口。
 * 本用例验证的是方案 §5.3 的做法：**把每一级目录的句柄一直持有到操作结束**，
 * 且共享模式里**不给 `FILE_SHARE_DELETE`**。
 *
 * 这不是"把窗口缩小到很小"，而是**结构上不可能**：
 * 重命名/删除一个对象需要对它持有 DELETE 权限，而共享模式是双方的约定 ——
 * 只要有一个持有者没给 `FILE_SHARE_DELETE`，后来者的 rename/delete
 * 就会以共享冲突失败。我们的句柄恰好不给自己留这个口子。
 *
 * 因此本文件的结构是「正题 + 反题 + 对照」：
 *   - 正题：护栏持有某条链时，外部改名**必须失败**；
 *   - 反题：释放之后改名**必须成功** —— 否则上一条的失败可能来自别的原因；
 *   - 对照：一个完全没被持有的目录改名必须成功 —— 否则这个环境本就改不了名。
 *
 * 后半部分测「已经换掉了」这一情形的**兜底**：句柄钉不住改名（比如操作早已
 * 结束、模型隔了一次调用再来），此时还能不能挡住？答案是根身份与重解析点检查。
 */

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { PowerShellWinfsBackend, ResidentHelper, isWinfsError } from '@lwb/winfs';

import { describeWindows, expectRejected, ps, readOk, refFor, type RootRef } from './helpers.ts';

/**
 * 在一个**新的**常驻助手进程里持有整条链，跑完 body 后释放。
 *
 * 为什么必须新起一个进程：`holdHandle` 的语义就是「故意不释放句柄」
 * （见 WinfsGuard.ps1），而句柄只随进程退出被内核回收。所以「释放」这件事
 * 只能由进程退出完成 —— 这恰好也让本用例能验证「释放之后就能改名了」。
 *
 * 代价是每次多付一次 Add-Type 编译（实测 ≈1.1s）。这个代价换来的是
 * 被测对象与生产后端**同一份脚本、同一套句柄语义**，而不是测试里另写一套。
 */
async function withHeldChain<T>(
  request: Record<string, unknown>,
  body: () => Promise<T>,
): Promise<T> {
  const helper = new ResidentHelper();
  try {
    const ready = await helper.start();
    assert.equal(ready.ok, true, `持有句柄用的助手启动失败：${JSON.stringify(ready)}`);
    const held = await helper.call({ op: 'holdHandle', ...request });
    assert.equal(
      held.ok,
      true,
      `holdHandle 失败，本用例无法继续：${JSON.stringify(held).slice(0, 400)}`,
    );
    return await body();
  } finally {
    await helper.stop();
  }
}

/**
 * 断言一次改名**被挡住**。
 *
 * 不写死具体 errno：拿不到 DELETE 权限时内核报 `ERROR_SHARING_VIOLATION`，
 * 而 Node 把它映射成什么码属于 libuv 的实现细节（本机实测是 `EBUSY`）。
 * 写死一个码会让用例在 libuv 版本变化时变成「环境不对」而不是「护栏坏了」。
 * 但也不接受任意异常 —— 把实际码限制在共享冲突/权限不足这一族里，
 * 一个 `ENOENT`（比如路径写错了）就会失败，用例不会因为别的原因误绿。
 */
async function expectRenameBlocked(from: string, to: string, hint: string): Promise<string> {
  try {
    await rename(from, to);
  } catch (error) {
    const code = String((error as NodeJS.ErrnoException).code ?? 'UNKNOWN');
    assert.ok(
      ['EBUSY', 'EPERM', 'EACCES'].includes(code),
      `${hint}：期望共享冲突类错误，实际 ${code}（${(error as Error).message}）`,
    );
    return code;
  }
  assert.fail(
    `${hint}：改名竟然成功了。护栏没有真正钉住这条链 —— ` +
      '按路径验证过的东西随后被别人换掉了。',
  );
}

describeWindows('LWB-010 并发交换父目录', () => {
  let backend: PowerShellWinfsBackend;
  let sandbox: string;

  before(async () => {
    sandbox = await mkdtemp(path.join(os.tmpdir(), 'lwb-swap-'));
    backend = new PowerShellWinfsBackend();
    const capability = await backend.capability();
    assert.equal(capability.available, true, `护栏不可用：${capability.resolved_backend_reason}`);
  });

  after(async () => {
    await backend?.dispose();
    await rm(sandbox, { recursive: true, force: true });
  });

  // -----------------------------------------------------------------------
  // 对照
  // -----------------------------------------------------------------------
  it('对照：未被持有的目录可以改名（失败不是因为环境不允许改名）', async () => {
    const a = path.join(sandbox, 'control-a');
    const b = path.join(sandbox, 'control-b');
    await mkdir(a, { recursive: true });
    await writeFile(path.join(a, 'f.txt'), '对照内容\n', 'utf8');

    // 这一条不抛异常才说明后面那些「改名失败」是句柄造成的。
    await rename(a, b);
    assert.equal(await readFile(path.join(b, 'f.txt'), 'utf8'), '对照内容\n');
  });

  // -----------------------------------------------------------------------
  // 正题：句柄钉住期间改不了名
  // -----------------------------------------------------------------------
  describe('持有句柄期间改名被挡住', () => {
    it('持有工作区根本身时，根无法被改名换掉', async () => {
      const ws = path.join(sandbox, 'ws-root');
      const moved = path.join(sandbox, 'ws-root-moved');
      await mkdir(ws, { recursive: true });
      await writeFile(path.join(ws, 'keep.txt'), '根持有的内容\n', 'utf8');
      const wsRef = await refFor(backend, ws);

      let sawCode = '';
      await withHeldChain({ ...wsRef, relative_path: '', access: 'read', share_mode: 'read' }, async () => {
        sawCode = await expectRenameBlocked(ws, moved, '持有根期间改名工作区根');
      });

      // 反题：释放之后同样的改名必须成功。
      // 没有这一步，上一条的失败可能来自「这个目录本来就改不了名」这类原因，
      // 用例会在护栏完全不起作用时依然变绿。
      await rename(ws, moved);
      assert.equal(
        await readFile(path.join(moved, 'keep.txt'), 'utf8'),
        '根持有的内容\n',
        '释放后应能改名，且内容原样',
      );
      assert.ok(sawCode.length > 0);
    });

    it('持有中间目录时，中间目录无法被改名换掉', async () => {
      const ws = path.join(sandbox, 'ws-mid');
      const sub = path.join(ws, 'sub');
      const subMoved = path.join(ws, 'sub-moved');
      await mkdir(sub, { recursive: true });
      await writeFile(path.join(sub, 'inner.txt'), '中间层内容\n', 'utf8');
      const wsRef = await refFor(backend, ws);

      await withHeldChain({ ...wsRef, relative_path: 'sub', access: 'read', share_mode: 'read' }, async () => {
        await expectRenameBlocked(sub, subMoved, '持有 sub 期间改名 sub');
      });

      await rename(sub, subMoved);
      assert.equal(await readFile(path.join(subMoved, 'inner.txt'), 'utf8'), '中间层内容\n');
    });

    it('持有深层文件时，它上面的每一级祖先都被钉住', async () => {
      // 这一条与上一条的差别在于「谁是目标」：请求 `sub/inner.txt` 时
      // `sub` 不是目标而是**祖先**，走的是 Open-PinnedDirectory 那条路。
      // 两条路都必须钉住，否则攻击者挑没被钉住的那一级就绕过去了。
      const ws = path.join(sandbox, 'ws-deep');
      const sub = path.join(ws, 'sub');
      const subMoved = path.join(ws, 'sub-moved');
      await mkdir(sub, { recursive: true });
      await writeFile(path.join(sub, 'inner.txt'), '深层内容\n', 'utf8');
      const wsRef = await refFor(backend, ws);

      await withHeldChain(
        { ...wsRef, relative_path: 'sub/inner.txt', access: 'read', share_mode: 'read' },
        async () => {
          await expectRenameBlocked(sub, subMoved, '持有 sub/inner.txt 期间改名祖先 sub');
        },
      );

      await rename(sub, subMoved);
      assert.equal(await readFile(path.join(subMoved, 'inner.txt'), 'utf8'), '深层内容\n');
    });
  });

  // -----------------------------------------------------------------------
  // 兜底：已经被换掉了
  // -----------------------------------------------------------------------
  describe('句柄没钉住时（操作早已结束）的兜底判定', () => {
    it('工作区根被换成同名目录：按旧身份访问被拒绝，且不碰新对象', async () => {
      // 这一条覆盖的是：句柄钉住只在使用期间有效。模型完全可能
      // 先 listDirectory 拿到路径，过一会儿再 readFileGuarded ——
      // 中间隔着两次调用，没有任何句柄还在。
      // 此时唯一还能说话的，是 daemon 给的**根身份**。
      const ws = path.join(sandbox, 'ws-swap');
      const original = path.join(sandbox, 'ws-swap-original');
      await mkdir(ws, { recursive: true });
      await writeFile(path.join(ws, 'x.txt'), '原本的内容\n', 'utf8');
      const wsRef = await refFor(backend, ws);

      // 换掉：路径字符串一模一样，只有对象不是原来那个。
      await rename(ws, original);
      await mkdir(ws, { recursive: true });
      await writeFile(path.join(ws, 'x.txt'), '替换者的内容\n', 'utf8');

      const err = await expectRejected(
        'ROOT_IDENTITY_MISMATCH',
        () => backend.readFileGuarded({ ...wsRef, relative_path: 'x.txt' }),
        '根被换成同名目录后按旧身份读取',
      );
      assert.match(
        err.message,
        /不是被授权的那一个对象/,
        `理由应说明对象身份不符，而不是含糊地说路径不对：${err.message}`,
      );

      // 拒绝是有效的：替换者没有被读、也没有被改。
      assert.equal(await readFile(path.join(ws, 'x.txt'), 'utf8'), '替换者的内容\n');
      assert.equal(await readFile(path.join(original, 'x.txt'), 'utf8'), '原本的内容\n');
    });

    it('父目录被换成指向工作区外的 Junction：经它访问被拒绝，读不到外面', async () => {
      // 这是验收标准 2 最直接的那一种：换进来的不是一个普通目录，
      // 而是**指向工作区外**的链接。若逐级句柄检查缺失，读到的就是外面那个文件。
      //
      // 因此这里**故意**在工作区外的目录里放一个同名文件：
      // 「走错路」这件事必须是**可达的**，拒绝才有意义。
      // 若外面根本没有同名文件，一次 NOT_FOUND 也能让用例变绿。
      const ws = path.join(sandbox, 'ws-junction');
      const sub = path.join(ws, 'sub');
      const outside = path.join(sandbox, 'outside-swap');
      const subMoved = path.join(ws, 'sub-moved');
      await mkdir(sub, { recursive: true });
      await mkdir(outside, { recursive: true });
      await writeFile(path.join(sub, 'target.txt'), '工作区内的内容\n', 'utf8');
      await writeFile(path.join(outside, 'target.txt'), '工作区外的机密\n', 'utf8');
      const wsRef = await refFor(backend, ws);

      await rename(sub, subMoved);
      const made = ps(
        `New-Item -ItemType Junction -Path '${sub.replace(/'/g, "''")}' ` +
          `-Target '${outside.replace(/'/g, "''")}' | Out-Null; 'OK'`,
      );
      assert.ok(made.includes('OK'), `创建 Junction 失败，本用例无法继续：${made}`);

      const err = await expectRejected(
        'LINK_UNSUPPORTED',
        () => backend.readFileGuarded({ ...wsRef, relative_path: 'sub/target.txt' }),
        '经被换成的 Junction 读取',
      );
      assert.match(err.message, /重解析点|Junction/, `理由应指出重解析点：${err.message}`);

      // 外面那个同名文件仍然只属于外面。
      assert.equal(await readFile(path.join(outside, 'target.txt'), 'utf8'), '工作区外的机密\n');
      // 工作区内原本的内容也还在（改名后的那个目录里）。
      assert.equal(await readFile(path.join(subMoved, 'target.txt'), 'utf8'), '工作区内的内容\n');
    });
  });

  // -----------------------------------------------------------------------
  // 已知边界：把父目录换成工作区内的普通目录
  // -----------------------------------------------------------------------
  describe('已知边界：父目录被换成工作区内的普通目录', () => {
    // 这一节记录的是**真实的边界**，不是通过项，也不打算粉饰：
    //
    // `writeFileGuarded` 绑定的是**内容基线**（expected_sha256），
    // 而不是跨调用的文件身份。因此若父目录被换成工作区**内**的另一个目录，
    // 而那里恰好有一个内容完全相同的文件，写入会照常进行 ——
    // 它写的是一个与批准时不同的物理对象。
    //
    // 为什么这是可接受的（而不是"没做"）：
    //   本系统的授权范围是「工作区根身份 × 相对路径 × 内容基线」，
    //   不是「某个 file_id」。上面前提下这三样全部成立，
    //   而且写入的**可观察结果与批准时的预期完全一致**：
    //   同一个工作区、同一个相对路径、同样的原内容、同样的新内容。
    //
    // 但有一条不能含糊：回执必须**如实报告写的是哪个对象**。
    // 因此下面第一条断言 `identity_before` 确实变了 ——
    // 若护栏把批准时那次的身份抄进回执，那才是真正的缺陷（I14）。
    //
    // 内容不同时由基线挡住，这是下面第二条。
    it('换成工作区内、内容相同的文件：写入继续，但回执如实报告换过的对象', async () => {
      const ws = path.join(sandbox, 'ws-inside');
      const sub = path.join(ws, 'sub');
      const subMoved = path.join(ws, 'sub-moved');
      const content = '内容一致时的原字节\n';
      await mkdir(sub, { recursive: true });
      await mkdir(subMoved, { recursive: true });
      await writeFile(path.join(sub, 'target.txt'), content, 'utf8');
      await writeFile(path.join(subMoved, 'target.txt'), content, 'utf8');
      const wsRef = await refFor(backend, ws);

      const before = await readOk(backend, { ...wsRef, relative_path: 'sub/target.txt' });

      // 父目录换掉：同名、内容相同，只有 file_id 不同。
      await rm(sub, { recursive: true, force: true });
      await rename(subMoved, sub);

      const after = await readOk(backend, { ...wsRef, relative_path: 'sub/target.txt' });
      assert.notEqual(
        after.file_id,
        before.file_id,
        '这一步的前提就是对象换了；若 file_id 相同则本用例没有测到它想测的东西',
      );

      const written = await backend.writeFileGuarded({
        ...wsRef,
        relative_path: 'sub/target.txt',
        expected_sha256: before.sha256,
        content_base64: Buffer.from('替换后的内容\n', 'utf8').toString('base64'),
      });
      assert.equal(written.ok, true, `内容基线一致时写入应继续：${JSON.stringify(written)}`);
      if (written.ok !== true || isWinfsError(written)) return;

      assert.equal(
        written.identity_before.file_id,
        after.file_id,
        '回执里的 identity_before 必须是**实际打开的那个**对象，不能是批准时那一个',
      );
      assert.notEqual(
        written.identity_before.file_id,
        before.file_id,
        '回执不得把批准时的身份抄进来冒充实际写入对象',
      );
    });

    it('换成工作区内、内容不同的文件：被内容基线挡住，替换者原样保留', async () => {
      const ws = path.join(sandbox, 'ws-inside-diff');
      const sub = path.join(ws, 'sub');
      const subMoved = path.join(ws, 'sub-moved');
      await mkdir(sub, { recursive: true });
      await mkdir(subMoved, { recursive: true });
      await writeFile(path.join(sub, 'target.txt'), '批准时的内容\n', 'utf8');
      await writeFile(path.join(subMoved, 'target.txt'), '别人的内容\n', 'utf8');
      const wsRef = await refFor(backend, ws);

      const approved = await readOk(backend, { ...wsRef, relative_path: 'sub/target.txt' });

      await rm(sub, { recursive: true, force: true });
      await rename(subMoved, sub);

      await expectRejected(
        'FILE_VERSION_CONFLICT',
        () =>
          backend.writeFileGuarded({
            ...wsRef,
            relative_path: 'sub/target.txt',
            expected_sha256: approved.sha256,
            content_base64: Buffer.from('不该落盘的内容\n', 'utf8').toString('base64'),
          }),
        '父目录被换成内容不同的文件后写入',
      );

      assert.equal(
        await readFile(path.join(sub, 'target.txt'), 'utf8'),
        '别人的内容\n',
        '被拒绝的写入不得改动替换者',
      );
    });
  });
});
