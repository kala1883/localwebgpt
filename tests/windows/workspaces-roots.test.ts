/**
 * 工作区根的**真实身份**集成测试（LWB-009 验收标准 1 与 2）。
 *
 * 为什么这两条只能在 Windows 上跑：
 *  - 「单文件授权不会顺带暴露其整个父目录」靠的是「文件没有子项」这个
 *    磁盘事实，而 `D:\a\f.txt\b` 打不开是内核行为，桩里造不出来。
 *  - 「同名路径被替换为另一目录后原授权失效」靠的是 NTFS 在新目录上给出
 *    一个**不同的 file_id**；换一种语言的模拟只会验证模拟本身。
 *
 * 因此本文件用真实护栏（PowerShell + .NET P/Invoke）与真实临时目录，
 * 并把「桩里断言过一遍」的结论在这里用真实对象再确认一次。
 */

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { BridgeError } from '@lwb/contracts';
import { closeDatabase, openDatabase, Repositories, type OpenDatabaseResult } from '@lwb/persistence';
import { PowerShellWinfsBackend } from '@lwb/winfs';
import { RootRejectedError, WorkspaceRegistry } from '@lwb/workspaces';

const isWindows = process.platform === 'win32';
const describeWindows = isWindows ? describe : describe.skip;

const WRITE_MODE = 'read_propose_apply_with_local_approval' as const;

async function expectBridgeError(
  code: string,
  fn: () => Promise<unknown>,
  hint: string,
): Promise<BridgeError> {
  try {
    await fn();
  } catch (cause) {
    assert.ok(cause instanceof BridgeError, `${hint} 应抛 BridgeError，实际：${String(cause)}`);
    assert.equal(cause.code, code, `${hint} 的错误码`);
    return cause;
  }
  assert.fail(`${hint} 应当抛出 ${code}，但没有抛错`);
}

describeWindows('LWB-009 工作区根的真实身份', () => {
  let backend: PowerShellWinfsBackend;
  let sandbox: string;
  let opened: OpenDatabaseResult;
  let repos: Repositories;
  let registry: WorkspaceRegistry;

  before(async () => {
    sandbox = await mkdtemp(path.join(os.tmpdir(), 'lwb-ws-roots-'));
    backend = new PowerShellWinfsBackend();
    const capability = await backend.capability();
    assert.equal(
      capability.available,
      true,
      `护栏后端不可用：${capability.resolved_backend_reason}`,
    );

    opened = openDatabase({ path: ':memory:' });
    repos = new Repositories(opened.db);
    let counter = 0;
    registry = new WorkspaceRegistry({
      repos,
      probe: backend,
      environment: {
        // 受保护存储放在临时目录的**兄弟位置**：既不会成为候选根的祖先，
        // 也不会让候选根成为它的祖先，从而不干扰本文件要验证的判定。
        store_root: path.join(os.tmpdir(), 'lwb-store-not-a-workspace'),
        home_directory: os.homedir(),
        extra_broad_probes: [],
        protected_refs: [],
        policy_version: 1,
      },
      newId: () => `ws_${String(++counter).padStart(4, '0')}`,
    });
  });

  after(async () => {
    if (opened) closeDatabase(opened.db);
    await backend?.dispose();
    await rm(sandbox, { recursive: true, force: true });
  });

  it('登记真实目录：根身份取自该目录的句柄', async () => {
    const dir = path.join(sandbox, 'plain');
    await mkdir(dir, { recursive: true });

    const record = await registry.register({
      alias: 'plain',
      kind: 'directory',
      path: dir,
      mode: WRITE_MODE,
      origin: 'local_console',
    });

    const probed = await backend.statVolume({ path: dir });
    assert.equal(probed.ok, true, JSON.stringify(probed));
    if (probed.ok !== true) return;

    assert.equal(record.canonical_root, dir);
    assert.equal(record.volume_id, probed.volume_id);
    assert.equal(record.root_file_id, probed.file_id, '登记的必须是句柄上读到的真实身份');
    assert.equal(record.generation, 1);

    const authorized = await registry.authorizeAccess(record.id);
    assert.equal(authorized.root_path, dir);
    assert.equal(authorized.file_id, probed.file_id);
  });

  it('本地操作者可登记 NTFS 整卷根，且护栏仍只在被授权卷根内直接创建测试文件', async () => {
    const volumeRoot = path.parse(sandbox).root;
    const record = await registry.register({
      alias: 'whole-test-volume',
      kind: 'directory',
      path: volumeRoot,
      mode: WRITE_MODE,
      origin: 'local_console',
    });
    try {
      const authorized = await registry.authorizeAccess(record.id);
      assert.equal(authorized.root_path, volumeRoot);
      assert.equal(authorized.kind, 'directory');

      const relativeDirectory = path.relative(volumeRoot, sandbox).split(path.sep).join('/');
      const relativeFile = `${relativeDirectory}/volume-root-guard-test.txt`;
      const bytes = Buffer.from('volume-root-grant-test\n', 'utf8');
      const created = await backend.createFileGuarded({
        root_path: authorized.root_path,
        root_volume_id: authorized.volume_id,
        root_file_id: authorized.file_id,
        relative_path: relativeFile,
        content_base64: bytes.toString('base64'),
      });
      assert.equal(created.ok, true, `整卷授权应能触达临时夹具内的目标：${JSON.stringify(created)}`);

      const readback = await backend.readFileGuarded({
        root_path: authorized.root_path,
        root_volume_id: authorized.volume_id,
        root_file_id: authorized.file_id,
        relative_path: relativeFile,
      });
      assert.equal(readback.ok, true, `通过整卷根应能回读刚创建的临时测试文件：${JSON.stringify(readback)}`);
      if (readback.ok) assert.deepEqual(Buffer.from(readback.bytes_base64, 'base64'), bytes);
    } finally {
      registry.remove(record.id, 'local_console');
    }
  });

  // -------------------------------------------------------------------------
  // 验收标准 1
  // -------------------------------------------------------------------------

  it('验收 1：单文件授权不会顺带暴露其整个父目录', async () => {
    const dir = path.join(sandbox, 'single');
    await mkdir(dir, { recursive: true });
    const onlyPath = path.join(dir, 'only.txt');
    const siblingPath = path.join(dir, 'sibling.txt');
    await writeFile(onlyPath, 'only 的内容\n', 'utf8');
    await writeFile(siblingPath, 'sibling 的内容\n', 'utf8');

    const only = await registry.register({
      alias: 'only',
      kind: 'file',
      path: onlyPath,
      mode: WRITE_MODE,
      origin: 'local_console',
    });

    // 根身份是**文件自己**的，不是它所在目录的。
    const fileProbe = await backend.statVolume({ path: onlyPath });
    const dirProbe = await backend.statVolume({ path: dir });
    assert.equal(fileProbe.ok, true, JSON.stringify(fileProbe));
    assert.equal(dirProbe.ok, true, JSON.stringify(dirProbe));
    if (fileProbe.ok !== true || dirProbe.ok !== true) return;

    assert.equal(only.kind, 'file');
    assert.equal(only.canonical_root, onlyPath);
    assert.equal(only.root_file_id, fileProbe.file_id, '必须是该文件自己的身份');
    assert.notEqual(only.root_file_id, dirProbe.file_id, '不得是父目录的身份');

    const authorized = await registry.authorizeAccess(only.id);
    assert.equal(authorized.root_path, onlyPath);
    assert.equal(authorized.kind, 'file');

    // 对照实验：同一个目标文件，两种根。
    // 通过**目录根**可读 —— 说明这个文件确实存在、内容也读得到。
    const viaDirectory = await backend.readFileGuarded({
      root_path: dir,
      root_volume_id: dirProbe.volume_id,
      root_file_id: dirProbe.file_id,
      relative_path: 'sibling.txt',
    });
    assert.equal(
      viaDirectory.ok,
      true,
      `同一目标经目录根应可读（对照失败即说明本用例没有在测它想测的东西）：${JSON.stringify(viaDirectory)}`,
    );

    // 通过**文件根**读同一目标：打不开。文件没有子项，因此
    // 「文件根 + 相对路径」在结构上无法指到父目录里的任何东西。
    // 引用直接取自登记的授权结果：这同时验证了「登记表里存的身份」与
    // 「护栏要求的身份」确实是同一个东西，而不是两套各自算的十六进制串。
    const viaFile = await backend.readFileGuarded({
      root_path: authorized.root_path,
      root_volume_id: authorized.volume_id,
      root_file_id: authorized.file_id,
      relative_path: 'sibling.txt',
    });
    assert.equal(
      viaFile.ok,
      false,
      `文件根不得能读到同目录的另一个文件：${JSON.stringify(viaFile)}`,
    );

    // 登记父目录是**另一次**授权：它与在册的可写文件工作区重叠，会被拒绝。
    const overlap = await registry
      .register({
        alias: 'single-dir',
        kind: 'directory',
        path: dir,
        mode: WRITE_MODE,
        origin: 'local_console',
      })
      .then(
        () => assert.fail('父目录与在册可写文件工作区重叠，必须被拒绝'),
        (cause: unknown) => cause,
      );
    assert.ok(overlap instanceof RootRejectedError, `实际：${String(overlap)}`);
    assert.ok(
      overlap.rejections.some((r) => r.reason === 'WRITABLE_ROOT_OVERLAP'),
      `拒绝理由应为重叠：${overlap.rejections.map((r) => r.reason).join(',')}`,
    );

    // 同目录下另一个文件是**独立的物理对象**：它是另一次可以成立的授权。
    const sibling = await registry.register({
      alias: 'sibling',
      kind: 'file',
      path: siblingPath,
      mode: WRITE_MODE,
      origin: 'local_console',
    });
    assert.notEqual(sibling.id, only.id);
    assert.notEqual(sibling.root_file_id, only.root_file_id);

    // 两条授权互不涵盖：移除其中一条，另一条照常可用。
    registry.remove(only.id, 'local_console');
    const stillSibling = await registry.authorizeAccess(sibling.id);
    assert.equal(stillSibling.root_path, siblingPath);
  });

  // -------------------------------------------------------------------------
  // 验收标准 2
  // -------------------------------------------------------------------------

  it('验收 2：同名路径被替换为另一目录后原授权失效', async () => {
    const dir = path.join(sandbox, 'swap');
    const moved = path.join(sandbox, 'swap-moved-away');
    await mkdir(dir, { recursive: true });

    const record = await registry.register({
      alias: 'swap',
      kind: 'directory',
      path: dir,
      mode: WRITE_MODE,
      origin: 'local_console',
    });

    const before = await registry.verifyRootIdentity(record.id);
    assert.equal(before.kind, 'unchanged', `登记后身份应未变，实际：${before.kind}`);

    // 把原目录改名让开，并在**同一个路径**上新建一个目录。
    // 路径字符串完全没变，只有物理对象换了。
    await rename(dir, moved);
    await mkdir(dir, { recursive: true });
    const newProbe = await backend.statVolume({ path: dir });
    assert.equal(newProbe.ok, true, JSON.stringify(newProbe));
    if (newProbe.ok !== true) return;
    assert.notEqual(
      newProbe.file_id,
      record.root_file_id,
      'NTFS 必须在新目录上给出不同的文件身份，否则本用例无法区分两者',
    );

    const after_ = await registry.verifyRootIdentity(record.id);
    assert.equal(after_.kind, 'identity_changed', `实际：${after_.kind}`);

    // 访问被拒绝，且错误里说明是「根被替换」而不是「票据过期」。
    const denied = await expectBridgeError(
      'WORKSPACE_GENERATION_CHANGED',
      () => registry.authorizeAccess(record.id),
      '根被替换后的访问',
    );
    assert.equal(denied.details?.['cause'], 'root_replaced');

    // 关键：拒绝时**没有**顺手把登记改写成新对象。
    // 自动改写等于「谁在同名路径放一个目录，谁就拿到授权」。
    const stillOld = repos.workspaces.requireById(record.id);
    assert.equal(stillOld.root_file_id, record.root_file_id, '拒绝访问不得改写登记');
    assert.equal(stillOld.generation, record.generation, '拒绝访问不得递增代次');

    // 重新验证是本地操作者显式的**重新授权**：登记指向新对象、代次递增。
    const outcome = await registry.reverify(record.id, 'local_console');
    assert.equal(outcome.kind, 'relocated', `实际：${outcome.kind}`);
    assert.equal(outcome.workspace.generation, record.generation + 1);
    assert.equal(outcome.workspace.root_file_id, newProbe.file_id);

    // 重新授权之后当前代次可用，而**旧代次**仍然不可用。
    const authorized = await registry.authorizeAccess(record.id);
    assert.equal(authorized.file_id, newProbe.file_id);
    assert.equal(authorized.generation, record.generation + 1);
    await expectBridgeError(
      'WORKSPACE_GENERATION_CHANGED',
      () => registry.authorizeAccess(record.id, { generation: record.generation }),
      '重新授权前签发的旧代次',
    );
  });

  it('验收 2 补充：根消失时拒绝访问，但**不**作废在途授权', async () => {
    const dir = path.join(sandbox, 'vanishing');
    await mkdir(dir, { recursive: true });
    const record = await registry.register({
      alias: 'vanishing',
      kind: 'directory',
      path: dir,
      mode: WRITE_MODE,
      origin: 'local_console',
    });

    await rm(dir, { recursive: true, force: true });

    const outcome = await registry.verifyRootIdentity(record.id);
    assert.equal(outcome.kind, 'missing', `实际：${outcome.kind}`);

    const denied = await expectBridgeError(
      'WORKSPACE_GENERATION_CHANGED',
      () => registry.authorizeAccess(record.id),
      '根消失后的访问',
    );
    assert.equal(denied.details?.['cause'], 'root_missing');

    // 脱机不是「换了对象」：代次不动，把目录恢复回去即可继续用。
    assert.equal(
      repos.workspaces.requireById(record.id).generation,
      record.generation,
      '根消失不得递增代次，否则一次临时脱机会作废全部在途修改集',
    );

    // 重新建一个同名目录：**路径回来了，对象不是原来那个**。
    // 重新验证必须报告「已重定位」并按新对象重新授权，而不是认为一切照旧。
    await mkdir(dir, { recursive: true });
    const recovered = await registry.reverify(record.id, 'local_console');
    assert.equal(
      recovered.kind,
      'relocated',
      `新建的同名目录是另一个对象，重新验证必须报告重定位，实际：${recovered.kind}`,
    );
    if (recovered.kind !== 'relocated') return;
    assert.notEqual(recovered.to.file_id, record.root_file_id, '新目录必须是另一个物理对象');
    assert.equal(recovered.workspace.root_file_id, recovered.to.file_id);
    assert.equal(
      recovered.workspace.generation,
      record.generation + 1,
      '重新授权必须递增代次',
    );
  });
});
