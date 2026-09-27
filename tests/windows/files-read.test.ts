/**
 * 一致读取在**真实护栏 + 真实 NTFS** 上的集成测试（LWB-013）。
 *
 * `tests/unit/files-read.test.ts` 验的是流水线，用的是桩；
 * 本文件验的是「这条流水线接上真实句柄护栏之后仍然成立」。
 *
 * 只在 Windows 上运行；其它平台整体跳过，而不是伪装通过。
 *
 * ## 为什么沙箱在 `mkdtemp` 里，而不是直接用夹具仓库
 *
 * 夹具仓库是**只读的验收对象**：它的每一个字节都被 manifest 记录在案，
 * 别的用例靠那些哈希断言「没人改过它」。本文件要在磁盘上造出
 * 「对象被换掉」「只读属性」「硬链接」这些形态，因此必须有一个自己的根。
 * 唯一对夹具做的操作是读取（最后一例），且读它正是为了证明**读**不改动它。
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
// 被测的 `readFile` 是 `@lwb/files` 的那个；本文件只把 fs 的一个改名为
// `readFileBytes`，好让两边各自保留原本的名字。
import { mkdir, mkdtemp, readFile as readFileBytes, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { LIMITS } from '@lwb/contracts';
import type { PolicyAction, PolicyDecision } from '@lwb/policy';
import { decide } from '@lwb/policy';
import { EgressBudget } from '@lwb/egress';
import { createReadTicketAuthority, readFile, statFile, type ReadDeps, type ReadScope } from '@lwb/files';
import type { WinfsOps, WinfsPathRef } from '@lwb/winfs';
import { PowerShellWinfsBackend, isWinfsError } from '@lwb/winfs';

import { TESTREPO_DIR, loadManifest } from '../fixtures/index.ts';

const isWindows = process.platform === 'win32';
const describeWindows = isWindows ? describe : describe.skip;

const NOW = Date.UTC(2026, 0, 1, 12, 0, 0);
const CONNECTION = 'conn-1';
const KEY = 'lwb-test-key-0123456789abcdef0123456789abcdef';
const VOLUME = '00000000';

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * 按需覆盖若干方法的装饰器。
 *
 * **不能用 `{...backend, readFileGuarded}`**：类的方法是原型上的属性，
 * 展开一个类实例只会拿到它自己的实例字段，于是除被覆盖那个之外的方法
 * 全部消失。那种对象会在第一次调用时才炸，而它看起来"只改了一个方法"。
 */
function decorate(ops: WinfsOps, overrides: Partial<WinfsOps>): WinfsOps {
  return {
    capability: () => ops.capability(),
    statVolume: (req) => ops.statVolume(req),
    validatePath: (req) => ops.validatePath(req),
    resolvePath: (req) => ops.resolvePath(req),
    readFileGuarded: (req) => ops.readFileGuarded(req),
    writeFileGuarded: (req) => ops.writeFileGuarded(req),
    createFileGuarded: (req) => ops.createFileGuarded(req),
    listDirectory: (req) => ops.listDirectory(req),
    ...overrides,
  };
}

function allowedDecision(action: PolicyAction = 'read'): PolicyDecision {
  const decision = decide({
    connection: {
      connection_id: CONNECTION,
      enabled: true,
      granted_capabilities: ['read', 'search', 'list', 'git_read', 'propose'],
      audience: 'mcp_adapter',
      granted_workspace_ids: ['ws-1'],
    },
    workspace: {
      workspace_id: 'ws-1',
      kind: 'directory',
      mode: 'read_propose_apply_with_local_approval',
      capabilities: {
        read_enabled: true,
        git_enabled: true,
        proposal_enabled: true,
        direct_write_enabled: true,
        recovery_required: false,
      },
      current_generation: 1,
      current_policy_version: 1,
      root_volume_id: VOLUME,
      root_file_id: '0000000000000000',
      paused: false,
    },
    presented: { generation: null, policy_version: null },
    // path 留空：真实路径会在策略层被拒，而本文件要验的是它**后面**那几层。
    action: { action, path: '', approval: null },
    now: NOW,
  });
  assert.equal(decision.allow, true, `装置前提：${action} 应被允许`);
  return decision;
}

function depsFor(ops: WinfsOps): ReadDeps {
  return {
    ops,
    authority: createReadTicketAuthority({ key: KEY }),
    budget: new EgressBudget({ limit_bytes_per_hour: 64 * 1024 * 1024, now: () => NOW }),
  };
}

async function expectReadError(code: string, fn: () => Promise<unknown>, hint: string): Promise<{ details?: Record<string, unknown> }> {
  try {
    await fn();
  } catch (cause) {
    const err = cause as { code?: string; message?: string; details?: Record<string, unknown> };
    assert.equal(err.code, code, `${hint} 的错误码（消息：${err.message}）`);
    return err;
  }
  assert.fail(`${hint}：应当抛出 ${code}`);
}

describeWindows('LWB-013 一致读取（真实护栏 / 真实 NTFS）', () => {
  let backend: PowerShellWinfsBackend;
  let root: string;
  let scope: ReadScope;

  before(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'lwb-files-read-'));
    backend = new PowerShellWinfsBackend();
    const capability = await backend.capability();
    assert.equal(capability.available, true, `护栏后端不可用：${capability.resolved_backend_reason}`);

    // 工作区根的**物理身份**由护栏自己给出 —— 测试不自算一份，
    // 否则验的就是测试自己写的第二个实现。
    const info = await backend.statVolume({ path: root });
    if (isWinfsError(info)) throw new Error(`statVolume 失败：${info.code} ${info.message}`);
    scope = {
      workspace_id: 'ws-1',
      kind: 'directory',
      mode: 'read_propose_apply_with_local_approval',
      generation: 1,
      root_path: root,
      root_volume_id: info.volume_id,
      root_file_id: info.file_id,
    };
  });

  after(async () => {
    await backend?.dispose();
    await rm(root, { recursive: true, force: true });
  });

  function args(relativePath: string, options: { max_lines?: number; cursor?: string; start_line?: number } = {}) {
    return {
      scope,
      connection_id: CONNECTION,
      decision: allowedDecision('read'),
      input: {
        workspace_id: 'ws-1',
        path: relativePath,
        ...(options.max_lines === undefined ? {} : { max_lines: options.max_lines }),
        ...(options.start_line === undefined ? {} : { start_line: options.start_line }),
        ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
      },
      now: NOW,
    };
  }

  it('读真实文件：正文、哈希、行数、换行与磁盘逐字节一致', async () => {
    const content = '第一行\nemoji 😀 line\n第三行\n';
    await writeFile(path.join(root, 'three-lines.txt'), content, 'utf8');

    const data = await readFile(args('three-lines.txt'), depsFor(backend));

    assert.equal(data.content, content);
    assert.equal(data.sha256, sha256(Buffer.from(content, 'utf8')));
    assert.equal(data.total_lines, 3);
    assert.equal(data.newline, 'lf');
    assert.equal(data.bom, false);
    assert.equal(data.encoding, 'utf-8');
    assert.equal(data.truncated, false);
    assert.equal(data.editable, true, `可编辑判定：${data.editable_blockers.join('；')}`);
    assert.ok(!data.content.includes('�'), '不得出现替换字符');
  });

  it('真实 CRLF 与 BOM 保真，且行数与磁盘一致', async () => {
    const raw = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('crlf-1\r\ncrlf-2\r\n', 'utf8'),
    ]);
    await writeFile(path.join(root, 'bom-crlf.txt'), raw);

    const data = await readFile(args('bom-crlf.txt'), depsFor(backend));

    assert.equal(data.bom, true);
    assert.equal(data.encoding, 'utf-8-bom');
    assert.equal(data.content, 'crlf-1\r\ncrlf-2\r\n');
    assert.equal(data.total_lines, 2);
    assert.equal(data.newline, 'crlf');
    assert.equal(data.sha256, sha256(raw), '哈希描述磁盘上的整份字节（含 BOM）');
  });

  it('闸门用**磁盘规范拼写**判路径：换个大小写请求，回执里是磁盘上那个名字', async () => {
    // NTFS 不区分大小写，所以这次打开会成功 —— 关键在回执与判定用的是哪个拼写。
    await writeFile(path.join(root, 'data.txt'), 'case probe\n', 'utf8');

    const data = await readFile(args('DATA.TXT'), depsFor(backend));

    assert.equal(data.path, 'data.txt', '回执路径必须是磁盘规范拼写（来自句柄），不是请求字符串');
    assert.equal(data.content, 'case probe\n');
  });

  it('真实硬拒绝文件在**读字节之前**被拦下：护栏一次都没被要求读取', async () => {
    await writeFile(path.join(root, '.env'), 'APP_SECRET=not-a-real-secret\n', 'utf8');

    let reads = 0;
    const counted = decorate(backend, {
      readFileGuarded: (req: WinfsPathRef) => {
        reads += 1;
        return backend.readFileGuarded(req);
      },
    });

    const error = await expectReadError(
      'POLICY_DENIED',
      () => readFile(args('.env'), depsFor(counted)),
      '真实 .env',
    );
    assert.equal(error.details?.['hard_deny_rule'], 'HD-ENV');
    assert.equal(reads, 0, '内容不得经过 daemon 的内存：预检必须发生在读字节之前');
  });

  it('对象在两次打开之间被换掉时失败（真实 file_id 变化）', async () => {
    const target = path.join(root, 'swap.txt');
    const content = 'same bytes\n';
    await writeFile(target, content, 'utf8');

    const beforeRead = await backend.readFileGuarded({ ...rootRef(), relative_path: 'swap.txt' });
    if (isWinfsError(beforeRead)) throw new Error(`装置前提失败：${beforeRead.code}`);

    // 删除后重建：字节完全一样、尺寸也一样，只有文件身份变了。
    // 尺寸检查抓不到它 —— 真实 NTFS 上能抓住它的只有 file_id 比对。
    const swapping = decorate(backend, {
      readFileGuarded: async (req: WinfsPathRef) => {
        await rm(target, { force: true });
        await writeFile(target, content, 'utf8');
        return backend.readFileGuarded(req);
      },
    });

    const error = await expectReadError(
      'FILE_VERSION_CONFLICT',
      () => readFile(args('swap.txt'), depsFor(swapping)),
      '读取中被换对象',
    );
    assert.equal(error.details?.['reason'], 'identity_changed_between_opens');
    assert.equal(error.details?.['size_before'], error.details?.['size_after'], '同尺寸：只有身份能分辨');

    const afterRead = await backend.readFileGuarded({ ...rootRef(), relative_path: 'swap.txt' });
    if (isWinfsError(afterRead)) throw new Error(`装置前提失败：${afterRead.code}`);
    assert.notEqual(afterRead.identity.file_id, beforeRead.identity.file_id, '装置前提：重建确实换了 file_id');
  });

  it('真实分页：游标跨进程边界仍然落在正确的行上', async () => {
    const lines = Array.from({ length: 1000 }, (_, i) => `line-${String(i).padStart(4, '0')}`);
    const content = `${lines.join('\n')}\n`;
    await writeFile(path.join(root, 'paged.txt'), content, 'utf8');

    const deps = depsFor(backend);
    const first = await readFile(args('paged.txt', { max_lines: 10 }), deps);
    assert.equal(first.total_lines, 1000);
    assert.equal(first.start_line, 1);
    assert.equal(first.end_line_exclusive, 11);
    assert.equal(first.content, `${lines.slice(0, 10).join('\n')}\n`);
    assert.equal(first.truncated, true);
    assert.equal(first.editable, true, `可编辑判定：${first.editable_blockers.join('；')}`);

    const second = await readFile(args('paged.txt', { cursor: first.next_cursor ?? '', max_lines: 10 }), deps);
    assert.equal(second.start_line, 11);
    assert.equal(second.end_line_exclusive, 21);
    assert.equal(second.content, `${lines.slice(10, 20).join('\n')}\n`);

    // 游标只承载**起点**：页大小仍由本次调用的 `max_lines` 决定，省略它就回到
    // 硬上限。这条断言是拿来钉住这个语义的 —— 它看起来像"忘了传参数"，
    // 但它是契约（`cursor` 只声明「提供时忽略 start_line」）的直接后果。
    const continued = await readFile(args('paged.txt', { cursor: first.next_cursor ?? '' }), deps);
    assert.equal(continued.start_line, 11);
    assert.equal(continued.end_line_exclusive, 11 + LIMITS.MAX_READ_LINES);

    // 游标跨越真实文件系统调用之后仍然有效，且内容与磁盘逐字相同。
    const offset = Buffer.byteLength(first.content + second.content, 'utf8');
    const raw = await readFileBytes(path.join(root, 'paged.txt'));
    assert.equal(Buffer.from(first.content + second.content, 'utf8').equals(raw.subarray(0, offset)), true);
  });

  it('只读属性的文件可读，但不给可编辑票据', async () => {
    const target = path.join(root, 'readonly.txt');
    await writeFile(target, 'locked by attribute\n', 'utf8');
    const flagged = spawnSync('attrib', ['+R', target], { encoding: 'utf8' });
    if (flagged.status !== 0) {
      // 属性没设上时不能静默通过：那会让这条断言变成一句空话。
      assert.fail(`无法设置只读属性，用例前提不成立：${flagged.stdout ?? ''}${flagged.stderr ?? ''}`);
    }

    const data = await readFile(args('readonly.txt'), depsFor(backend));

    assert.equal(data.content, 'locked by attribute\n', '只读是**写入**的限制，不是读取的限制');
    assert.equal(data.editable, false);
    assert.ok(
      data.editable_blockers.some((b) => b.includes('只读')),
      `拒绝理由应提到只读属性：${data.editable_blockers.join('；')}`,
    );

    spawnSync('attrib', ['-R', target]);
  });

  it('存在硬链接的文件可读，但不给可编辑票据（写入会改到工作区外的另一个名字）', async (t) => {
    const original = path.join(root, 'linked-original.txt');
    const content = 'linked content\n';
    await writeFile(original, content, 'utf8');
    const link = path.join(root, 'linked-copy.txt');

    const created = spawnSync(
      'pwsh',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `try { New-Item -ItemType HardLink -Path '${link}' -Target '${original}' -ErrorAction Stop | Out-Null; 'CREATED' } catch { 'FAILED: ' + $_.Exception.Message }`,
      ],
      { encoding: 'utf8', timeout: 60_000 },
    );
    const out = `${created.stdout ?? ''}${created.stderr ?? ''}`;
    if (!out.includes('CREATED')) {
      t.diagnostic(`无法创建硬链接，跳过：${out.trim()}`);
      return;
    }

    const data = await readFile(args('linked-copy.txt'), depsFor(backend));

    assert.equal(data.content, content);
    assert.equal(data.editable, false);
    assert.ok(
      data.editable_blockers.some((b) => b.includes('硬链接')),
      `拒绝理由应提到硬链接：${data.editable_blockers.join('；')}`,
    );
  });

  it('真实二进制与 UTF-16 文件：各自的拒绝码与理由', async () => {
    await writeFile(path.join(root, 'blob.bin'), Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x41]));
    const binary = await expectReadError(
      'BINARY_UNSUPPORTED',
      () => readFile(args('blob.bin'), depsFor(backend)),
      '含 NUL 的真实文件',
    );
    assert.equal(binary.details?.['reason'], 'NUL_BYTE');

    await writeFile(
      path.join(root, 'utf16.txt'),
      Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('hi\n', 'utf16le')]),
    );
    const utf16 = await expectReadError(
      'ENCODING_UNSUPPORTED',
      () => readFile(args('utf16.txt'), depsFor(backend)),
      '真实 UTF-16 文件',
    );
    assert.equal(utf16.details?.['reason'], 'UTF16_BOM');
  });

  it('超长行按上限截断并标注行号（真实 9000 字节单行）', async () => {
    await writeFile(path.join(root, 'long-line.txt'), `${'x'.repeat(9000)}\n`, 'utf8');

    const data = await readFile(args('long-line.txt'), depsFor(backend));

    assert.equal(data.total_lines, 1);
    assert.deepEqual(data.truncated_lines, [1]);
    assert.equal(data.truncated, true);
    assert.equal(data.content, 'x'.repeat(LIMITS.MAX_LINE_BYTES));
    assert.equal(data.editable, false);
  });

  it('尺寸上限在读取之前生效（真实超大文件）', async () => {
    const big = path.join(root, 'too-big.txt');
    // 真的写出超过上限的字节：本用例要证的是「上限在**读**之前生效」，
    // 而如果文件其实不够大，那条断言就成了空话。
    await writeFile(big, 'a'.repeat(LIMITS.MAX_READABLE_FILE_BYTES + 1), 'utf8');

    let reads = 0;
    const counted = decorate(backend, {
      readFileGuarded: (req: WinfsPathRef) => {
        reads += 1;
        return backend.readFileGuarded(req);
      },
    });

    const error = await expectReadError(
      'SIZE_LIMIT_EXCEEDED',
      () => readFile(args('too-big.txt'), depsFor(counted)),
      '超过可读上限的真实文件',
    );
    assert.equal(error.details?.['limit'], 'MAX_READABLE_FILE_BYTES');
    assert.equal(reads, 0, '一个 16 MiB 以上的文件不该被读进内存再判断');

    await rm(big, { force: true });
  });

  it('元数据预检：真实文件给出哈希与尺寸，但一个字节正文都不出站', async () => {
    const raw = Buffer.from('stat me\nsecond line\n', 'utf8');
    await writeFile(path.join(root, 'stat.txt'), raw);

    const stat = await statFile(
      { scope, connection_id: CONNECTION, decision: allowedDecision('stat'), path: 'stat.txt', now: NOW },
      depsFor(backend),
    );

    assert.equal(stat.sha256, sha256(raw));
    assert.equal(stat.size, raw.length);
    assert.equal(stat.newline, 'lf');
    assert.equal(stat.editable, false);
    assert.equal('read_token' in stat, false);
  });

  it('读真实密钥夹具：certain 级命中被脱敏，且原文件一个字节都没变', async () => {
    const manifest = await loadManifest();
    const entry = manifest.files.find((f) => f.relPath === 'secrets/token.txt');
    assert.ok(entry, '夹具清单里应有 secrets/token.txt');

    const info = await backend.statVolume({ path: TESTREPO_DIR });
    if (isWinfsError(info)) throw new Error(`statVolume 失败：${info.code}`);
    const repoScope: ReadScope = { ...scope, root_path: TESTREPO_DIR, root_volume_id: info.volume_id, root_file_id: info.file_id };

    const data = await readFile({ ...args('secrets/token.txt'), scope: repoScope }, depsFor(backend));

    assert.equal(data.redacted, true);
    assert.ok(!data.content.includes('ghp_'), '被命中的令牌不得出现在出站正文里');
    assert.ok(!data.content.includes('xoxb-'), '被命中的令牌不得出现在出站正文里');
    assert.ok(data.content.includes('[REDACTED:github-token]'));
    assert.equal(data.editable, false);
    assert.equal(data.sha256, entry.sha256, '脱敏不改变「读的是哪个版本」：哈希仍描述磁盘原始字节');

    // 读操作不得改动被读的对象 —— 夹具是对外只读的验收对象。
    const afterBytes = await readFileBytes(path.join(TESTREPO_DIR, 'secrets', 'token.txt'));
    assert.equal(sha256(afterBytes), entry.sha256, '读取不得改动夹具文件');
  });

  it('穿越路径在探针阶段就被拒绝（真实护栏，先于任何字节）', async () => {
    await mkdir(path.join(root, 'sub'), { recursive: true });
    await writeFile(path.join(root, 'sub', 'inside.txt'), 'inside\n', 'utf8');

    let reads = 0;
    const counted = decorate(backend, {
      readFileGuarded: (req: WinfsPathRef) => {
        reads += 1;
        return backend.readFileGuarded(req);
      },
    });

    const error = await expectReadError(
      'PATH_UNSAFE',
      () => readFile(args('../outside.txt'), depsFor(counted)),
      '穿越路径',
    );
    assert.equal(error.details?.['winfs_code'], 'PATH_UNSAFE');
    assert.equal(reads, 0);
  });

  /** 每次都用当前的身份重新取根引用（重建对象之后根不会变，但引用要保持同源）。 */
  function rootRef(): { root_path: string; root_volume_id: string; root_file_id: string } {
    return { root_path: scope.root_path, root_volume_id: scope.root_volume_id, root_file_id: scope.root_file_id };
  }
});
