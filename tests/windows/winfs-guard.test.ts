/**
 * Windows 文件系统护栏的集成测试（LWB-010、LWB-003）。
 *
 * 与 native/winfs-spike 的区别：
 * spike 负责**取得证据**（把观察值写进 docs/evidence）；
 * 本文件负责**回归**——它断言的是实际交付的 `native/winfs` 后端，
 * 因此后端被改坏时这里会失败，而 evidence 目录不会。
 *
 * 这些用例只在 Windows 上运行；其它平台整体跳过，而不是伪装通过。
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { PowerShellWinfsBackend, isWinfsError, type WinfsError } from '@lwb/winfs';

import { TESTREPO_DIR, loadManifest, repoPath } from '../fixtures/index.ts';

const isWindows = process.platform === 'win32';
const describeWindows = isWindows ? describe : describe.skip;

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

function ps(command: string): string {
  const res = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', command], {
    encoding: 'utf8',
    timeout: 60_000,
  });
  return `${res.stdout ?? ''}${res.stderr ?? ''}`.trim();
}

/**
 * 取某个目录的 `WinfsRootRef`：路径 **加上**它在磁盘上的物理身份。
 *
 * 测试里要用它，因为护栏现在要求调用方每次都声明「我说的是哪一个对象」。
 * 身份由护栏自己的 `statVolume` 给出 —— 测试不自己算一份，
 * 否则就不是在验证交付物，而是在验证测试自己写的第二个实现。
 */
async function refFor(be: PowerShellWinfsBackend, dir: string): Promise<{
  root_path: string;
  root_volume_id: string;
  root_file_id: string;
}> {
  const info = await be.statVolume({ path: dir });
  if (isWinfsError(info)) throw new Error(`statVolume 失败：${info.code} ${info.message}`);
  return { root_path: dir, root_volume_id: info.volume_id, root_file_id: info.file_id };
}

describeWindows('LWB-010 Windows 文件系统护栏', () => {
  let backend: PowerShellWinfsBackend;
  let root: string;

  before(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'lwb-winfs-test-'));
    backend = new PowerShellWinfsBackend();
    const capability = await backend.capability();
    assert.equal(
      capability.available,
      true,
      `护栏后端不可用：${capability.resolved_backend_reason}`,
    );
  });

  after(async () => {
    await backend?.dispose();
    await rm(root, { recursive: true, force: true });
  });

  /** 夹具仓库根的引用。身份不变，探测一次即可（仍是护栏自己的答案）。 */
  let testRepoRefCache: { root_path: string; root_volume_id: string; root_file_id: string } | null = null;
  async function testRepoRef(): Promise<{ root_path: string; root_volume_id: string; root_file_id: string }> {
    testRepoRefCache ??= await refFor(backend, TESTREPO_DIR);
    return testRepoRefCache;
  }

  it('能力自检如实声明不提供崩溃原子性与跨文件事务', async () => {
    const capability = await backend.capability();
    assert.equal(capability.crash_atomic_replace, false);
    assert.equal(capability.cross_file_transaction, false);
    assert.equal(capability.supports_file_identity, true);
    assert.equal(capability.supports_reparse_detection, true);
  });

  it('读取正常文件并返回可核对的哈希与身份', async () => {
    await mkdir(path.join(root, 'sub'), { recursive: true });
    const content = Buffer.from('hello 世界\n', 'utf8');
    await writeFile(path.join(root, 'sub', 'a.txt'), content);

    const result = await backend.readFileGuarded({ ...(await refFor(backend, root)), relative_path: 'sub/a.txt' });
    assert.equal(result.ok, true, JSON.stringify(result));
    if (isWinfsError(result)) return;

    assert.equal(result.sha256, sha256(content));
    assert.equal(result.size, content.length);
    assert.equal(Buffer.from(result.bytes_base64, 'base64').equals(content), true);
    assert.equal(result.identity.link_count, 1);
    assert.match(result.identity.file_id, /^[0-9a-f]{16}$/);
    assert.match(result.identity.volume_id, /^[0-9a-f]{8}$/);
  });

  it('拒绝穿越、根相对、ADS 与点段路径', async () => {
    const cases = ['../outside.txt', 'a/../../b', 'x.txt:stream', 'a/./b.txt', '\\a\\b.txt'];
    for (const bad of cases) {
      const result = await backend.resolvePath({ ...(await refFor(backend, root)), relative_path: bad, expect: 'file' });
      assert.equal(result.ok, false, `${bad} 应被拒绝，实际被接受`);
      assert.equal(
        (result as WinfsError).code,
        'PATH_UNSAFE',
        `${bad} 的拒绝码应为 PATH_UNSAFE，实际 ${(result as WinfsError).code}`,
      );
    }
  });

  it('拒绝经 Junction 访问的路径', async (t) => {
    await mkdir(path.join(root, 'jtarget'), { recursive: true });
    await writeFile(path.join(root, 'jtarget', 'real.txt'), 'real\n');
    const junction = path.join(root, 'jlink');

    const created = ps(
      `try { New-Item -ItemType Junction -Path '${junction}' -Target '${path.join(root, 'jtarget')}' -ErrorAction Stop | Out-Null; 'CREATED' } catch { 'FAILED: ' + $_.Exception.Message }`,
    );
    if (!created.includes('CREATED')) {
      t.diagnostic(`无法创建 Junction，跳过：${created}`);
      return;
    }

    const result = await backend.readFileGuarded({ ...(await refFor(backend, root)), relative_path: 'jlink/real.txt' });
    assert.equal(result.ok, false, '经 Junction 的路径必须被拒绝');
    assert.equal((result as WinfsError).code, 'LINK_UNSUPPORTED');
  });

  it('拒绝写入存在硬链接的文件（会影响工作区外的另一个名字）', async (t) => {
    const original = path.join(root, 'hardlink-original.txt');
    const content = Buffer.from('hardlink target\n', 'utf8');
    await writeFile(original, content);
    const link = path.join(root, 'hardlink-copy.txt');

    const created = ps(
      `try { New-Item -ItemType HardLink -Path '${link}' -Target '${original}' -ErrorAction Stop | Out-Null; 'CREATED' } catch { 'FAILED: ' + $_.Exception.Message }`,
    );
    if (!created.includes('CREATED')) {
      t.diagnostic(`无法创建硬链接，跳过：${created}`);
      return;
    }

    const result = await backend.writeFileGuarded({
      ...(await refFor(backend, root)),
      relative_path: 'hardlink-copy.txt',
      expected_sha256: sha256(content),
      content_base64: Buffer.from('overwritten\n').toString('base64'),
    });
    assert.equal(result.ok, false, '存在硬链接的文件必须拒绝写入');
    assert.equal((result as WinfsError).code, 'LINK_UNSUPPORTED');
    assert.equal((await readFile(original)).equals(content), true, '原文件不得被改动');
  });

  it('基线哈希不符时拒绝写入且不改变文件', async () => {
    const target = path.join(root, 'baseline.txt');
    const original = Buffer.from('baseline content\n', 'utf8');
    await writeFile(target, original);

    const wrong = sha256(Buffer.from('完全不同的内容\n', 'utf8'));
    const result = await backend.writeFileGuarded({
      ...(await refFor(backend, root)),
      relative_path: 'baseline.txt',
      expected_sha256: wrong,
      content_base64: Buffer.from('must not be written\n').toString('base64'),
    });

    assert.equal(result.ok, false);
    assert.equal((result as WinfsError).code, 'FILE_VERSION_CONFLICT');
    assert.equal((await readFile(target)).equals(original), true);
  });

  it('正常写入：回读一致、截断无残留、身份不变、BOM 与 CRLF 保真', async () => {
    const target = path.join(root, 'write.txt');
    const original = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('line one\r\nline two\r\nline three\r\n', 'utf8'),
    ]);
    await writeFile(target, original);

    const next = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('short\r\n', 'utf8'),
    ]);

    const result = await backend.writeFileGuarded({
      ...(await refFor(backend, root)),
      relative_path: 'write.txt',
      expected_sha256: sha256(original),
      content_base64: next.toString('base64'),
    });

    assert.equal(result.ok, true, JSON.stringify(result));
    if (isWinfsError(result)) return;

    assert.equal(result.readback_ok, true);
    assert.equal(result.after_sha256, sha256(next));
    assert.equal(result.identity_before.file_id, result.identity_after.file_id);

    const onDisk = await readFile(target);
    assert.equal(sha256(onDisk), sha256(next), '磁盘字节必须与目标完全一致（含 BOM 与 CRLF）');
    assert.equal(onDisk.length, next.length, '缩短写入必须真正截断');
  });

  it('CREATE_NEW 不覆盖已存在文件，且不隐式创建父目录', async () => {
    const first = await backend.createFileGuarded({
      ...(await refFor(backend, root)),
      relative_path: 'created.txt',
      content_base64: Buffer.from('first\n').toString('base64'),
    });
    assert.equal(first.ok, true, JSON.stringify(first));

    const second = await backend.createFileGuarded({
      ...(await refFor(backend, root)),
      relative_path: 'created.txt',
      content_base64: Buffer.from('SHOULD NOT WIN\n').toString('base64'),
    });
    assert.equal(second.ok, false, 'CREATE_NEW 对已存在文件必须失败');
    assert.equal((second as WinfsError).code, 'FILE_VERSION_CONFLICT');
    assert.equal((await readFile(path.join(root, 'created.txt'), 'utf8')), 'first\n');

    const missingParent = await backend.createFileGuarded({
      ...(await refFor(backend, root)),
      relative_path: 'no-such-dir/deep/file.txt',
      content_base64: Buffer.from('x\n').toString('base64'),
    });
    assert.equal(missingParent.ok, false);
    assert.equal((missingParent as WinfsError).code, 'NOT_FOUND');
    assert.equal(existsSync(path.join(root, 'no-such-dir')), false, '不得隐式创建父目录');
  });

  it('列目录并对重解析点子目录做标记', async () => {
    await mkdir(path.join(root, 'listdir', 'inner'), { recursive: true });
    await writeFile(path.join(root, 'listdir', 'x.txt'), 'x\n');

    const result = await backend.listDirectory({ ...(await refFor(backend, root)), relative_path: 'listdir' });
    assert.equal(result.ok, true, JSON.stringify(result));
    if (isWinfsError(result)) return;

    const names = result.entries.map((e) => e.name).sort();
    assert.deepEqual(names, ['inner', 'x.txt']);
    const inner = result.entries.find((e) => e.name === 'inner');
    assert.equal(inner?.type, 'directory');
    assert.equal(inner?.is_reparse, false);
  });

  it('读取夹具中的中文路径、BOM 与 CRLF 文件，并与清单哈希一致', async () => {
    const manifest = await loadManifest();

    for (const rel of ['文档/设计说明.md', 'bom/with-bom.txt', 'newline/crlf.txt', 'newline/mixed.txt']) {
      const entry = manifest.files.find((f) => f.relPath === rel);
      assert.ok(entry, `清单中应存在 ${rel}`);

      const result = await backend.readFileGuarded({ ...(await testRepoRef()), relative_path: rel });
      assert.equal(result.ok, true, `${rel}: ${JSON.stringify(result)}`);
      if (isWinfsError(result)) continue;

      assert.equal(result.sha256, entry.sha256, `${rel} 的哈希应与清单一致`);
      assert.equal(result.size, entry.bytes, `${rel} 的字节数应与清单一致`);
    }

    // BOM 必须被原样读出，不能被"解码后再编码"抹掉。
    const bom = await backend.readFileGuarded({ ...(await testRepoRef()), relative_path: 'bom/with-bom.txt' });
    if (bom.ok && !isWinfsError(bom)) {
      const bytes = Buffer.from(bom.bytes_base64, 'base64');
      assert.equal(bytes.subarray(0, 3).toString('hex'), 'efbbbf');
    }
  });

  it('夹具目录的只读访问不改变授权范围外的金丝雀文件', async () => {
    const manifest = await loadManifest();
    const canaryPath = path.join(TESTREPO_DIR, '..', 'outside-canary', 'canary.txt');
    const before = sha256(await readFile(canaryPath));

    // 尝试用穿越路径访问工作区外文件：必须失败。
    const escape = await backend.readFileGuarded({
      ...(await testRepoRef()),
      relative_path: '../outside-canary/canary.txt',
    });
    assert.equal(escape.ok, false, '穿越到工作区外必须被拒绝');
    assert.equal((escape as WinfsError).code, 'PATH_UNSAFE');

    const after = sha256(await readFile(canaryPath));
    assert.equal(after, before, '越权尝试不得改动范围外文件');
    assert.equal(after, manifest.canary_sha256, '金丝雀哈希应与清单一致');
  });

  it('repoPath 辅助函数与清单路径一致（防止测试自己造路径）', async () => {
    const manifest = await loadManifest();
    assert.ok(manifest.files.length > 0);
    const resolved = repoPath('src/main.ts');
    assert.equal(existsSync(resolved), true);
  });
});
