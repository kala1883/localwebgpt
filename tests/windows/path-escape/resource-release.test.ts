/**
 * 错误路径上的资源释放（LWB-010 步骤 4 的「资源释放异常」）。
 *
 * 为什么这件事值得单独一组用例：
 *
 * 护栏持有句柄时**不给 `FILE_SHARE_DELETE`**（这正是并发交换挡得住的原因，
 * 见 parent-swap.test.ts）。于是同一件事有两面：
 * 持有期间别人改不了名是**保护**，操作结束还持有就是**伤害** ——
 * 用户自己的工作区会变成一个改不了名、删不掉的目录，直到 daemon 重启。
 *
 * 而且这类缺陷特别容易漏：正常路径人人都测，错误路径只在抛异常时才走到，
 * 一旦某条 catch 忘了 `Dispose`，功能测试全绿而用户的工作区已经废了。
 *
 * 断言的选取：直接断言「操作结束后这个对象还能不能改名」。
 *   - 它就是泄漏**对用户可见的那个后果**，不是某个代理指标；
 *   - 它比查句柄计数更准 —— 句柄计数在并发跑的测试套件里会被别的
 *     测试文件的 pwsh 进程污染，而"能不能改名"只取决于我们自己持有的句柄；
 *   - 它同时覆盖链条上的每一级：改名一个目录需要它自己的 DELETE 权限，
 *     所以只要有一级被泄漏就会失败。
 */

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { PowerShellWinfsBackend, isWinfsError } from '@lwb/winfs';

import { describeWindows, expectRejected, ps, readOk, refFor, type RootRef } from './helpers.ts';

/**
 * 断言 `target` **没有被任何人钉住**：改一下名再改回来。
 *
 * 若护栏在错误路径上漏了句柄，这里会拿到共享冲突 —— 而且消息要能让人
 * 一眼看出这是「泄漏」而不是「测试环境有问题」。
 */
async function expectReleased(target: string, hint: string): Promise<void> {
  const probe = `${target}.release-probe`;
  try {
    await rename(target, probe);
  } catch (error) {
    assert.fail(
      `${hint}：操作被拒绝之后，${path.basename(target)} 仍然改不了名` +
        `（${String((error as NodeJS.ErrnoException).code)}）。` +
        '这说明护栏在错误路径上没有释放句柄 —— 保护性的「持有」变成了对用户工作区的伤害。',
    );
  }
  await rename(probe, target);
}

describeWindows('LWB-010 错误路径的资源释放', () => {
  let backend: PowerShellWinfsBackend;
  let sandbox: string;
  let ws: string;
  let sub: string;
  let wsRef: RootRef;

  before(async () => {
    sandbox = await mkdtemp(path.join(os.tmpdir(), 'lwb-release-'));
    ws = path.join(sandbox, 'ws');
    sub = path.join(ws, 'sub');
    await mkdir(sub, { recursive: true });
    await writeFile(path.join(sub, 'target.txt'), '目标内容\n', 'utf8');
    backend = new PowerShellWinfsBackend();
    const capability = await backend.capability();
    assert.equal(capability.available, true, `护栏不可用：${capability.resolved_backend_reason}`);
    wsRef = await refFor(backend, ws);
  });

  after(async () => {
    await backend?.dispose();
    await rm(sandbox, { recursive: true, force: true });
  });

  it('成功路径同样释放：读完一个文件后它仍然改得了名', async () => {
    // 先立这条：若只有失败路径释放，下面那些断言会显得像是
    // 「这个环境本来就改不了名」。成功路径是基线。
    const file = path.join(ws, 'success.txt');
    await writeFile(file, '成功路径内容\n', 'utf8');

    const read = await readOk(backend, { ...wsRef, relative_path: 'success.txt' });
    assert.equal(read.size, Buffer.byteLength('成功路径内容\n', 'utf8'));

    await expectReleased(file, '成功读取之后');
    await expectReleased(sub, '成功读取之后（中间目录）');
    await expectReleased(ws, '成功读取之后（工作区根）');
  });

  it('语法拒绝根本不打开句柄：工作区依然可以改名', async () => {
    await expectRejected(
      'PATH_UNSAFE',
      () => backend.readFileGuarded({ ...wsRef, relative_path: '../escape.txt' }),
      '上跳路径',
    );
    await expectRejected(
      'PATH_UNSAFE',
      () => backend.readFileGuarded({ ...wsRef, relative_path: 'C:\\Windows\\win.ini' }),
      '绝对路径',
    );

    await expectReleased(ws, '语法拒绝之后');
    await expectReleased(sub, '语法拒绝之后');
  });

  it('中间目录不存在（链条自己抛错）：已打开的祖先必须被释放', async () => {
    // 这一条专测 Open-GuardedChain 自己的 catch。
    // 链条在打开第 2 级时失败，而第 1 级（工作区根）已经打开并加入了列表 ——
    // 若那里没有 dispose，工作区根就永久钉住了。
    await expectRejected(
      'NOT_FOUND',
      () => backend.readFileGuarded({ ...wsRef, relative_path: 'missing-dir/inner.txt' }),
      '中间目录不存在的路径',
    );

    await expectReleased(ws, '链条中途失败之后');
    await expectReleased(sub, '链条中途失败之后');
  });

  it('目标不存在：根与祖先都必须被释放', async () => {
    await expectRejected(
      'NOT_FOUND',
      () => backend.readFileGuarded({ ...wsRef, relative_path: 'sub/nope.txt' }),
      '读取不存在的文件',
    );

    await expectReleased(sub, '目标不存在之后');
    await expectReleased(ws, '目标不存在之后');
  });

  it('根身份不符：验完身份就抛，句柄不能留在根上', async () => {
    const wrong: RootRef = { ...wsRef, root_file_id: '0000000000000000' };
    const err = await expectRejected(
      'ROOT_IDENTITY_MISMATCH',
      () => backend.readFileGuarded({ ...wrong, relative_path: 'sub/target.txt' }),
      '根身份不符',
    );
    assert.match(err.message, /不是被授权的那一个对象/);

    await expectReleased(ws, '根身份不符之后');
  });

  it('经 Junction 被拒：那个 Junction 自己必须被释放', async () => {
    const outside = path.join(sandbox, 'release-outside');
    await mkdir(outside, { recursive: true });
    const link = path.join(ws, 'release-link');
    const made = ps(
      `New-Item -ItemType Junction -Path '${link.replace(/'/g, "''")}' ` +
        `-Target '${outside.replace(/'/g, "''")}' | Out-Null; 'OK'`,
    );
    assert.ok(made.includes('OK'), `创建 Junction 失败，本用例无法继续：${made}`);

    await expectRejected(
      'LINK_UNSUPPORTED',
      () => backend.listDirectory({ ...wsRef, relative_path: 'release-link' }),
      '把 Junction 当目录列举',
    );

    // Junction 是在「已加入句柄列表之后」才判定失败的，
    // 因此它的释放完全取决于 catch 里的那个循环。
    await expectReleased(link, '重解析点被拒之后');
    await expectReleased(ws, '重解析点被拒之后');
  });

  it('基线冲突：文件与中间目录都必须被释放', async () => {
    const file = path.join(sub, 'conflict.txt');
    await writeFile(file, '基线内容\n', 'utf8');
    const stale = await readOk(backend, { ...wsRef, relative_path: 'sub/conflict.txt' });

    // 先改掉内容，让基线过期。
    await writeFile(file, '被别人改过的内容\n', 'utf8');

    await expectRejected(
      'FILE_VERSION_CONFLICT',
      () =>
        backend.writeFileGuarded({
          ...wsRef,
          relative_path: 'sub/conflict.txt',
          expected_sha256: stale.sha256,
          content_base64: Buffer.from('不该落盘\n', 'utf8').toString('base64'),
        }),
      '基线过期时写入',
    );

    // 文件仍然改得了名 —— 说明写操作的目标句柄（那种不含 FILE_SHARE_WRITE
    // 的独占读句柄）确实在 finally 里释放了。
    await expectReleased(file, '基线冲突之后');
    await expectReleased(sub, '基线冲突之后');
  });

  it('CREATE_NEW 撞上已存在的文件：不得覆盖，且句柄被释放', async () => {
    const file = path.join(sub, 'existing.txt');
    await writeFile(file, '原有内容\n', 'utf8');

    await expectRejected(
      'FILE_VERSION_CONFLICT',
      () =>
        backend.createFileGuarded({
          ...wsRef,
          relative_path: 'sub/existing.txt',
          content_base64: Buffer.from('覆盖它\n', 'utf8').toString('base64'),
        }),
      '对已存在文件做 CREATE_NEW',
    );

    await expectReleased(file, 'CREATE_NEW 失败之后');
    await expectReleased(sub, 'CREATE_NEW 失败之后');
  });

  it('反复失败不累积：几十次失败之后一切照旧', async () => {
    // 单次泄漏的后果可能小到看不出来（多一个句柄而已），
    // 但常驻助手是**长期运行**的：daemon 一天里会被拒绝很多次。
    // 因此这里按量跑一遍，再验证那些对象仍然全部可以改名。
    const before = await readOk(backend, { ...wsRef, relative_path: 'sub/target.txt' });

    const failures: Array<() => Promise<{ ok: boolean }>> = [
      () => backend.readFileGuarded({ ...wsRef, relative_path: 'missing-dir/x.txt' }),
      () => backend.readFileGuarded({ ...wsRef, relative_path: 'sub/nope.txt' }),
      () => backend.readFileGuarded({ ...wsRef, relative_path: '../outside.txt' }),
      () => backend.readFileGuarded({ ...wsRef, root_file_id: '0000000000000000', relative_path: 'sub/target.txt' }),
      () => backend.listDirectory({ ...wsRef, relative_path: 'release-link' }),
      () =>
        backend.writeFileGuarded({
          ...wsRef,
          relative_path: 'sub/target.txt',
          expected_sha256: 'f'.repeat(64),
          content_base64: Buffer.from('x', 'utf8').toString('base64'),
        }),
    ];

    let rejected = 0;
    for (let i = 0; i < 12; i += 1) {
      const run = failures[i % failures.length]!;
      const result = await run();
      // 这一条必须每次都成立：**不允许有任何一次侥幸成功**。
      // 反复失败之后偶尔放行一次，正是"状态被前一次失败污染"的典型形态。
      assert.equal(result.ok, false, `第 ${i + 1} 次失败注入竟然成功了：${JSON.stringify(result)}`);
      rejected += 1;
    }
    assert.equal(rejected, 12);

    // 全链路复查：一个都不能被钉住。
    await expectReleased(sub, '反复失败之后');
    await expectReleased(ws, '反复失败之后');
    await expectReleased(path.join(ws, 'release-link'), '反复失败之后');

    // 而且助手**还能正常工作**，不是"锁着但还活着"。
    const after = await readOk(backend, { ...wsRef, relative_path: 'sub/target.txt' });
    assert.equal(after.sha256, before.sha256, '反复失败不得改变任何内容');
    assert.equal(after.file_id, before.file_id, '反复失败不得换掉对象');

    const capability = await backend.capability();
    assert.equal(capability.available, true, '反复失败之后护栏仍应可用');
  });

  it('一次成功的写入之后，目标与祖先都被释放', async () => {
    const file = path.join(sub, 'written.txt');
    await writeFile(file, '写入前\n', 'utf8');
    const baseline = await readOk(backend, { ...wsRef, relative_path: 'sub/written.txt' });

    const written = await backend.writeFileGuarded({
      ...wsRef,
      relative_path: 'sub/written.txt',
      expected_sha256: baseline.sha256,
      content_base64: Buffer.from('写入后\n', 'utf8').toString('base64'),
    });
    assert.equal(written.ok, true, `写入应成功：${JSON.stringify(written)}`);
    if (written.ok !== true || isWinfsError(written)) return;

    await expectReleased(file, '成功写入之后');
    await expectReleased(sub, '成功写入之后');
  });
});
