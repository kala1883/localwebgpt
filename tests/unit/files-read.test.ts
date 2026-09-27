/**
 * 一致读取与读取票据（LWB-013）。
 *
 * ## 这个文件用**真实夹具字节**当输入，用 manifest 当判据
 *
 * 「中文、emoji、BOM、CRLF、无末尾换行读取正确」这句话里的每一项，都只有拿
 * 那份真实字节去读才算验证过。因此夹具不是"测试数据"，而是被测输入；
 * 期望值一律取自 `tests/fixtures/generated/manifest.json`（生成器算的），
 * 而不是在本文件里手抄一份「我以为那是什么字节」。
 *
 * 磁盘访问用桩：本文件要验的是**读取流水线**，不是护栏。真实护栏下的同一批
 * 断言在 `tests/windows/files-read.test.ts` 里再跑一次。
 *
 * ## 断言方式
 *
 * 涉及正文的断言优先用**精确相等**而不是「包含 / 不含」：
 * 「输出里没有 X」在输出整个错位、或压根没输出时也可能为真。
 * 只能靠「没发生过」来证明的事（硬拒绝路径不得读取字节），用调用计数证明。
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile as readDiskFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

import { BridgeError, LIMITS } from '@lwb/contracts';
import type { PolicyAction, PolicyDecision } from '@lwb/policy';
import { decide } from '@lwb/policy';
import { EgressBudget } from '@lwb/egress';
import {
  DEFAULT_READ_LIMITS,
  assertReadTokenMatches,
  coversEditRange,
  createReadTicketAuthority,
  fileVersionOf,
  readFile,
  statFile,
  type ReadDeps,
  type ReadScope,
} from '@lwb/files';
import type { WinfsError, WinfsOps, WinfsPathRef, WinfsReadResult } from '@lwb/winfs';

import { loadManifest, repoPath } from '../fixtures/index.ts';

// ---------------------------------------------------------------------------
// 装置
// ---------------------------------------------------------------------------

const NOW = Date.UTC(2026, 0, 1, 12, 0, 0);
const VOLUME = 'c6e22015';
const CONNECTION = 'conn-1';
const KEY = 'lwb-test-key-0123456789abcdef0123456789abcdef';

interface StubFile {
  readonly bytes: Buffer;
  /** 省略时等于请求路径；显式给 `null` 表示护栏取不到规范路径。 */
  readonly canonical?: string | null;
  readonly file_id?: string;
  readonly link_count?: number;
  readonly attrs?: readonly string[];
}

function fileOf(content: string | Buffer, extra: Omit<StubFile, 'bytes'> = {}): StubFile {
  return { bytes: Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8'), ...extra };
}

/** 单个文件的桩仓库（路径固定为 `a.txt`）。 */
function storeOf(content: string | Buffer, extra: Omit<StubFile, 'bytes'> = {}): Map<string, StubFile> {
  return new Map([['a.txt', fileOf(content, extra)]]);
}

function sha256Of(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * 桩护栏。**它只回答事实**，不做任何判定 —— 判定属于被测模块；
 * 桩里加一点"顺手帮它判一下"的逻辑，测出来的就只是桩自己。
 *
 * `calls` 用来证明「某一步没有被执行」：例如硬拒绝路径必须在**读字节之前**
 * 就被拦下，而「没读到」这件事只能由调用计数证明。
 */
function makeOps(store: Map<string, StubFile>): { ops: WinfsOps; calls: { resolve: number; read: number } } {
  const calls = { resolve: 0, read: 0 };

  const notFound = (path: string): WinfsError => ({
    ok: false,
    code: 'NOT_FOUND',
    message: `文件不存在：${path}`,
    win32_error: 2,
  });

  const result = (path: string, file: StubFile): WinfsReadResult => ({
    ok: true,
    relative_path: path,
    canonical_relative_path: file.canonical === undefined ? path : file.canonical,
    identity: {
      volume_id: VOLUME,
      file_id: file.file_id ?? 'file-0001',
      link_count: file.link_count ?? 1,
    },
    size: file.bytes.length,
    sha256: sha256Of(file.bytes),
    bytes_base64: file.bytes.toString('base64'),
    attributes: { is_reparse: false, is_directory: false, names: file.attrs ?? ['archive'] },
  });

  const ops: WinfsOps = {
    capability: () => {
      throw new Error('桩：本测试不使用 capability');
    },
    statVolume: () => {
      throw new Error('桩：本测试不使用 statVolume');
    },
    validatePath: (req: { relative_path: string }) =>
      Promise.resolve({
        ok: true as const,
        segments: req.relative_path.split('/').filter((s) => s.length > 0),
        normalized: req.relative_path,
      }),
    resolvePath: (req: WinfsPathRef & { expect: 'file' | 'directory' | 'any' }) => {
      calls.resolve += 1;
      const file = store.get(req.relative_path);
      return Promise.resolve(file === undefined ? notFound(req.relative_path) : result(req.relative_path, file));
    },
    readFileGuarded: (req: WinfsPathRef) => {
      calls.read += 1;
      const file = store.get(req.relative_path);
      return Promise.resolve(file === undefined ? notFound(req.relative_path) : result(req.relative_path, file));
    },
    writeFileGuarded: () => {
      throw new Error('桩：写操作不在本测试范围');
    },
    createFileGuarded: () => {
      throw new Error('桩：写操作不在本测试范围');
    },
    listDirectory: () => {
      throw new Error('桩：目录列举不在本测试范围');
    },
  };

  return { ops, calls };
}

function scopeOf(overrides: Partial<ReadScope> = {}): ReadScope {
  return {
    workspace_id: 'ws-1',
    kind: 'directory',
    mode: 'read_propose_apply_with_local_approval',
    generation: 1,
    root_path: 'C:\\work\\proj',
    root_volume_id: VOLUME,
    root_file_id: 'root-0001',
    ...overrides,
  };
}

/**
 * 铸造一份**允许**的判定结果。
 *
 * 注意 `path` 默认是空串：本文件里多数用例要验的恰恰是「上层给了允许，
 * 出站闸门仍然自己拦下」—— 用真实路径去 decide() 会先在策略层被拒，
 * 那样测到的就不是闸门了。这与 `tests/unit/egress.test.ts` 的做法一致。
 */
function allowedDecision(action: PolicyAction = 'read', path = ''): PolicyDecision {
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
      root_file_id: 'root-0001',
      paused: false,
    },
    presented: { generation: null, policy_version: null },
    action: { action, path, approval: null },
    now: NOW,
  });
  assert.equal(decision.allow, true, `装置前提：${action} 应被允许，实际 ${decision.primary?.reason ?? '(none)'}`);
  return decision;
}

function depsFor(ops: WinfsOps, overrides: Partial<ReadDeps> = {}): ReadDeps {
  return {
    ops,
    authority: createReadTicketAuthority({ key: KEY }),
    budget: new EgressBudget({ limit_bytes_per_hour: 64 * 1024 * 1024, now: () => NOW }),
    ...overrides,
  };
}

interface ReadOptions {
  readonly scope?: Partial<ReadScope>;
  readonly decision?: PolicyDecision;
  readonly start_line?: number;
  readonly max_lines?: number;
  readonly cursor?: string;
}

function readArgs(path: string, options: ReadOptions = {}) {
  return {
    scope: scopeOf(options.scope),
    connection_id: CONNECTION,
    decision: options.decision ?? allowedDecision('read'),
    input: {
      workspace_id: 'ws-1',
      path,
      ...(options.start_line === undefined ? {} : { start_line: options.start_line }),
      ...(options.max_lines === undefined ? {} : { max_lines: options.max_lines }),
      ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
    },
    now: NOW,
  };
}

async function expectReadError(code: string, fn: () => Promise<unknown>, hint: string): Promise<BridgeError> {
  try {
    await fn();
  } catch (cause) {
    assert.ok(cause instanceof BridgeError, `${hint}：期望 BridgeError，实际 ${String(cause)}`);
    assert.equal(cause.code, code, `${hint} 的错误码（消息：${cause.message}）`);
    return cause;
  }
  assert.fail(`${hint}：应当抛出 ${code}`);
}

// ---------------------------------------------------------------------------
// 1. 真实夹具字节的识别（验收标准 1）
// ---------------------------------------------------------------------------

describe('LWB-013 已保存字节的识别：用真实夹具字节逐项验证', () => {
  /** 夹具里**不**被硬拒绝规则命中、因此应当能读到的文本文件。 */
  const READABLE = [
    '文档/设计说明.md',
    '资料/2026年方案/📄笔记.txt',
    'bom/with-bom.txt',
    'edge/bom-only.txt',
    'newline/lf.txt',
    'newline/crlf.txt',
    'newline/no-trailing-newline.txt',
    'edge/empty.txt',
    'edge/long-line.txt',
    'large/big.txt',
    'README.md',
    'src/main.ts',
  ] as const;

  it('每个可读夹具的哈希、BOM、换行、行数与 manifest 逐项一致', async () => {
    const manifest = await loadManifest();

    for (const relPath of READABLE) {
      const entry = manifest.files.find((f) => f.relPath === relPath);
      assert.ok(entry, `manifest 里应有 ${relPath}`);

      const raw = await readDiskFile(repoPath(relPath));
      assert.equal(raw.length, entry.bytes, `${relPath} 装置前提：磁盘字节数与 manifest 一致`);

      const { ops } = makeOps(new Map([[relPath, fileOf(raw)]]));
      const data = await readFile(readArgs(relPath), depsFor(ops));

      // 哈希是对**整份原始字节**算的，与是否分页、是否截断、是否脱敏都无关。
      assert.equal(data.sha256, entry.sha256, `${relPath} 整文件哈希`);
      assert.equal(data.bom, entry.hasBom, `${relPath} BOM 标记`);
      assert.equal(data.newline, entry.newline, `${relPath} 换行风格`);
      assert.equal(data.total_lines, entry.lineCount, `${relPath} 总行数`);
      assert.equal(data.encoding, entry.hasBom ? 'utf-8-bom' : 'utf-8', `${relPath} 编码`);
      assert.equal(data.source, 'disk', `${relPath} 数据源`);
      assert.equal(data.path, relPath, `${relPath} 回执路径应为请求的规范拼写`);

      // 只有真的把整个文件返回了，才能断言正文逐字相等。
      const body = entry.hasBom ? raw.subarray(3) : raw;
      const expected = body.toString('utf8');
      const hasLongLine = expected
        .split('\n')
        .some((line) => Buffer.byteLength(line, 'utf8') > LIMITS.MAX_LINE_BYTES);
      if (
        hasLongLine ||
        entry.bytes > LIMITS.MAX_RESPONSE_BODY_BYTES ||
        (entry.lineCount ?? 0) > LIMITS.MAX_READ_LINES
      ) {
        continue; // 这些夹具的预期是「截断 / 分页」，各自有专门的用例
      }

      assert.equal(data.content, expected, `${relPath} 正文`);
      assert.equal(data.truncated, false, `${relPath} 整文件读取不应标记截断`);
      assert.deepEqual(data.truncated_lines, [], `${relPath} 无截断行`);
      assert.equal(data.next_cursor, null, `${relPath} 整文件读取不应给出游标`);
      // 出站字节数是**记账**依据，必须描述真正出站的那段文本。
      assert.equal(data.bytes_returned, Buffer.byteLength(data.content, 'utf8'), `${relPath} 出站字节数`);
    }
  });

  it('中文 + emoji 路径读得到，且回执里的路径逐字保留 emoji', async () => {
    const relPath = '资料/2026年方案/📄笔记.txt';
    const raw = await readDiskFile(repoPath(relPath));
    const { ops } = makeOps(new Map([[relPath, fileOf(raw)]]));
    const data = await readFile(readArgs(relPath), depsFor(ops));

    assert.equal(data.path, relPath, 'emoji 必须原样出现在回执路径里，不能被转义或替换');
    assert.ok(data.path.includes('📄'), '装置前提：这个夹具的 emoji 在**路径**里');
    assert.equal(data.content, raw.toString('utf8'));
    assert.ok(data.content.includes('数字与中文混合：2026 年方案'), '正文里的中文应逐字可读');
    assert.ok(!data.content.includes('\uFFFD'), '不得出现替换字符 U+FFFD');
  });

  it('读到的是磁盘上已保存的字节，不是某次提交的版本', async () => {
    // 该夹具在基线提交之后被生成器追加过（含未提交修改），因此「读磁盘」
    // 与「读提交内容」在这一份文件上会给出不同的字节 —— 这正是它存在的意义。
    const relPath = '文档/设计说明.md';
    const raw = await readDiskFile(repoPath(relPath));
    const { ops } = makeOps(new Map([[relPath, fileOf(raw)]]));
    const data = await readFile(readArgs(relPath), depsFor(ops));

    assert.ok(data.content.includes('LWB_ANCHOR_UNCOMMITTED'), '应读到未提交的追加段落（I14：只描述已保存字节）');
    assert.equal(data.content, raw.toString('utf8'));
    assert.equal(data.total_lines, 11);
  });

  it('BOM 被报告，且不算进正文（正文里不得残留 U+FEFF）', async () => {
    const relPath = 'bom/with-bom.txt';
    const raw = await readDiskFile(repoPath(relPath));
    assert.deepEqual([...raw.subarray(0, 3)], [0xef, 0xbb, 0xbf], '装置前提：该夹具以 UTF-8 BOM 开头');

    const { ops } = makeOps(new Map([[relPath, fileOf(raw)]]));
    const data = await readFile(readArgs(relPath), depsFor(ops));

    assert.equal(data.bom, true);
    assert.equal(data.encoding, 'utf-8-bom');
    assert.equal(data.content, raw.subarray(3).toString('utf8'), 'BOM 不在正文里');
    assert.ok(!data.content.includes('\uFEFF'), '正文里不得出现 U+FEFF');
    // 出站字节比磁盘字节少 3：少的那 3 个字节正是 BOM，而哈希仍描述整份字节。
    assert.equal(data.bytes_returned, raw.length - 3);
  });

  it('仅含 BOM 的文件读成 0 行、空正文，且不算截断', async () => {
    const relPath = 'edge/bom-only.txt';
    const raw = await readDiskFile(repoPath(relPath));
    const { ops } = makeOps(new Map([[relPath, fileOf(raw)]]));
    const data = await readFile(readArgs(relPath), depsFor(ops));

    assert.equal(data.content, '');
    assert.equal(data.total_lines, 0);
    assert.equal(data.newline, 'none');
    assert.equal(data.truncated, false, '读取一个只有 BOM 的文件确实读完了整个文件');
    assert.equal(data.bytes_returned, 0);
  });

  it('CRLF 原样保留：正文里的换行与磁盘逐字节相同', async () => {
    const relPath = 'newline/crlf.txt';
    const raw = await readDiskFile(repoPath(relPath));
    const { ops } = makeOps(new Map([[relPath, fileOf(raw)]]));
    const data = await readFile(readArgs(relPath), depsFor(ops));

    assert.equal(data.newline, 'crlf');
    assert.equal(data.content, raw.toString('utf8'));
    assert.ok(data.content.includes('\r\n'));
    assert.ok(!/(?<!\r)\n/.test(data.content), '不应出现单独的 LF');
  });

  it('无末尾换行：最后一行不带终止符，也不替它补一个', async () => {
    const relPath = 'newline/no-trailing-newline.txt';
    const raw = await readDiskFile(repoPath(relPath));
    assert.ok(!raw.toString('utf8').endsWith('\n'), '装置前提：该夹具没有末尾换行');

    const { ops } = makeOps(new Map([[relPath, fileOf(raw)]]));
    const data = await readFile(readArgs(relPath), depsFor(ops));

    assert.equal(data.content, raw.toString('utf8'));
    assert.ok(!data.content.endsWith('\n'));
    assert.equal(data.total_lines, 2);
    assert.equal(data.truncated, false);
  });

  it('混合换行被如实报告，且不给可编辑票据', async () => {
    const relPath = 'newline/mixed.txt';
    const raw = await readDiskFile(repoPath(relPath));
    const { ops } = makeOps(new Map([[relPath, fileOf(raw)]]));
    const data = await readFile(readArgs(relPath), depsFor(ops));

    assert.equal(data.newline, 'mixed');
    assert.equal(data.editable, false);
    assert.ok(
      data.editable_blockers.some((b) => b.includes('换行')),
      `拒绝理由应提到换行：${data.editable_blockers.join('；')}`,
    );
  });

  it('0 字节文件：0 行、空正文、不标记截断', async () => {
    const relPath = 'edge/empty.txt';
    const { ops } = makeOps(new Map([[relPath, fileOf(Buffer.alloc(0))]]));
    const data = await readFile(readArgs(relPath), depsFor(ops));

    assert.equal(data.content, '');
    assert.equal(data.total_lines, 0);
    assert.equal(data.bytes_returned, 0);
    assert.equal(data.truncated, false);
  });
});

// ---------------------------------------------------------------------------
// 2. 截断与分页（验收标准 2）
// ---------------------------------------------------------------------------

describe('LWB-013 截断结果不冒充完整文件', () => {
  it('超长行按上限截断、行号被标注、结果不可编辑', async () => {
    const relPath = 'edge/long-line.txt';
    const raw = await readDiskFile(repoPath(relPath));
    assert.equal(raw.length, 9001, '装置前提：单行 9000 字节 + 换行');

    const { ops } = makeOps(new Map([[relPath, fileOf(raw)]]));
    const data = await readFile(readArgs(relPath), depsFor(ops));

    assert.equal(data.total_lines, 1);
    assert.deepEqual(data.truncated_lines, [1], '被截断的行号必须被标出');
    assert.equal(data.truncated, true, '截断结果不得冒充完整文件');
    assert.equal(data.content, 'x'.repeat(LIMITS.MAX_LINE_BYTES), '正文应恰好被截到单行上限');
    assert.equal(data.bytes_returned, LIMITS.MAX_LINE_BYTES);
    assert.ok(!data.content.includes('\n'), '被截断的行不补换行 —— 那会凭空造出一个内容边界');
    assert.equal(data.next_cursor, null, '单行文件截断后没有下一页');
    assert.equal(data.editable, false);
    assert.ok(
      data.editable_blockers.some((b) => b.includes('截断')),
      `拒绝理由应提到截断：${data.editable_blockers.join('；')}`,
    );
  });

  it('大文件按 MAX_READ_LINES 分页，两页拼接与磁盘字节逐字相同', async () => {
    const relPath = 'large/big.txt';
    const raw = await readDiskFile(repoPath(relPath));
    const manifest = await loadManifest();
    const entry = manifest.files.find((f) => f.relPath === relPath);
    assert.equal(entry?.lineCount, 48000, '装置前提：48000 行');

    const { ops } = makeOps(new Map([[relPath, fileOf(raw)]]));
    const deps = depsFor(ops);

    const first = await readFile(readArgs(relPath), deps);
    assert.equal(first.start_line, 1);
    assert.equal(first.end_line_exclusive, LIMITS.MAX_READ_LINES + 1);
    assert.equal(first.truncated, true);
    assert.equal(first.total_lines, 48000);
    assert.notEqual(first.next_cursor, null);
    assert.equal(first.sha256, entry?.sha256, '分页不影响整文件哈希');

    const second = await readFile(readArgs(relPath, { cursor: first.next_cursor ?? '' }), deps);
    assert.equal(second.start_line, first.end_line_exclusive, '下一页必须从上一页结束处开始');
    assert.equal(second.truncated, true, '第二页同样不是整个文件');
    assert.notEqual(second.next_cursor, null);

    const joined = first.content + second.content;
    assert.ok(
      Buffer.from(joined, 'utf8').equals(raw.subarray(0, Buffer.byteLength(joined, 'utf8'))),
      '两页拼接必须与磁盘字节逐字相同（不漏、不重、不改）',
    );
  });

  it('越过末尾的页返回空正文，且不越界报错', async () => {
    const relPath = 'README.md';
    const raw = await readDiskFile(repoPath(relPath));
    const { ops } = makeOps(new Map([[relPath, fileOf(raw)]]));
    const data = await readFile(readArgs(relPath, { start_line: 9999 }), depsFor(ops));

    assert.equal(data.content, '');
    assert.equal(data.start_line, 9999);
    assert.equal(data.end_line_exclusive, 9999);
    assert.equal(data.truncated, true, '从第 9999 行开始读显然不是整个文件');
    assert.equal(data.next_cursor, null);
  });

  it('max_lines 只能收紧，不能扩大', async () => {
    const relPath = 'large/big.txt';
    const raw = await readDiskFile(repoPath(relPath));
    const { ops, calls } = makeOps(new Map([[relPath, fileOf(raw)]]));
    const deps = depsFor(ops);

    const tight = await readFile(readArgs(relPath, { max_lines: 3 }), deps);
    assert.equal(tight.end_line_exclusive, 4);

    const greedy = await readFile(readArgs(relPath, { max_lines: 1_000_000 }), deps);
    assert.equal(greedy.end_line_exclusive, LIMITS.MAX_READ_LINES + 1, '模型不能靠参数扩大行数上限');

    const before = calls.read;
    await expectReadError('INVALID_ARGUMENT', () => readFile(readArgs(relPath, { max_lines: 0 }), deps), 'max_lines = 0');
    await expectReadError('INVALID_ARGUMENT', () => readFile(readArgs(relPath, { start_line: -1 }), deps), 'start_line = -1');
    assert.equal(calls.read, before, '参数不合法时一次磁盘读取都不该发生');
  });
});

// ---------------------------------------------------------------------------
// 3. 出站闸门（硬拒绝 + 规范路径）
// ---------------------------------------------------------------------------

describe('LWB-013 闸门在看什么路径、在什么时候拦', () => {
  it('硬拒绝的文件在**读字节之前**被拦下（I04）', async () => {
    const store = new Map([['secrets/.env', fileOf(await readDiskFile(repoPath('secrets/.env')))]]);
    const { ops, calls } = makeOps(store);

    const error = await expectReadError(
      'POLICY_DENIED',
      () => readFile(readArgs('secrets/.env'), depsFor(ops)),
      '读取 .env',
    );

    assert.equal(error.details?.['hard_deny_rule'], 'HD-ENV');
    assert.equal(error.details?.['blocked_at'], 'egress');
    assert.equal(calls.read, 0, '预检必须在读字节之前失败——否则内容已经进过 daemon 的内存');
    assert.equal(calls.resolve, 1, '尺寸探针是允许的：它不读内容');
  });

  it('.env.example 不被自动豁免（方案 §4.3）', async () => {
    const store = new Map([['config/.env.example', fileOf(await readDiskFile(repoPath('config/.env.example')))]]);
    const { ops, calls } = makeOps(store);

    const error = await expectReadError(
      'POLICY_DENIED',
      () => readFile(readArgs('config/.env.example'), depsFor(ops)),
      '读取 .env.example',
    );
    assert.equal(error.details?.['hard_deny_rule'], 'HD-ENV');
    assert.equal(calls.read, 0);
  });

  it('闸门用的是**磁盘规范路径**，不是请求里的字符串', async () => {
    // 请求一个无害的名字，磁盘上的对象却是 .env —— 只有拿规范路径去判才能拦住。
    const store = new Map([['notes.txt', fileOf('TOKEN=not-a-real-token\n', { canonical: 'secrets/.env' })]]);
    const { ops, calls } = makeOps(store);

    const error = await expectReadError(
      'POLICY_DENIED',
      () => readFile(readArgs('notes.txt'), depsFor(ops)),
      '请求 notes.txt 而磁盘对象是 .env',
    );

    assert.equal(error.details?.['hard_deny_rule'], 'HD-ENV');
    assert.equal(calls.read, 0);
  });

  it('护栏取不到规范路径时拒绝，而不是退回请求字符串', async () => {
    const store = new Map([['notes.txt', fileOf('hello\n', { canonical: null })]]);
    const { ops } = makeOps(store);

    const error = await expectReadError(
      'PATH_UNSAFE',
      () => readFile(readArgs('notes.txt'), depsFor(ops)),
      'canonical = null',
    );
    assert.equal(error.details?.['reason'], 'NO_CANONICAL_PATH');
  });

  it('单文件工作区：以 .env 为根时被拦下', async () => {
    const store = new Map([['', fileOf('TOKEN=not-a-real-token\n', { canonical: '' })]]);
    const { ops } = makeOps(store);

    const error = await expectReadError(
      'POLICY_DENIED',
      () => readFile(readArgs('', { scope: { kind: 'file', root_path: 'C:\\work\\proj\\.env' } }), depsFor(ops)),
      '单文件工作区根为 .env',
    );
    assert.equal(error.details?.['hard_deny_rule'], 'HD-ENV');
  });

  it('单文件工作区：普通文件可读，回执路径是空串（正是下一次调用该给的值）', async () => {
    const store = new Map([['', fileOf('hello\n', { canonical: '' })]]);
    const { ops } = makeOps(store);

    const data = await readFile(
      readArgs('', { scope: { kind: 'file', root_path: 'C:\\work\\proj\\notes.txt' } }),
      depsFor(ops),
    );
    assert.equal(data.content, 'hello\n');
    assert.equal(data.path, '');
  });

  it('目录工作区却给出空相对路径时拒绝', async () => {
    const store = new Map([['', fileOf('x\n', { canonical: '' })]]);
    const { ops } = makeOps(store);
    const error = await expectReadError('PATH_UNSAFE', () => readFile(readArgs(''), depsFor(ops)), '目录工作区的空路径');
    assert.equal(error.details?.['reason'], 'EMPTY_PATH_FOR_DIRECTORY_WORKSPACE');
  });
});

// ---------------------------------------------------------------------------
// 4. 形态拒绝与写冲突
// ---------------------------------------------------------------------------

describe('LWB-013 形态拒绝与写冲突', () => {
  it('二进制（含 NUL）被拒绝', async () => {
    const bytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x41]);
    const { ops } = makeOps(storeOf(bytes));

    const error = await expectReadError(
      'BINARY_UNSUPPORTED',
      () => readFile(readArgs('a.txt'), depsFor(ops)),
      '含 NUL 的字节',
    );
    assert.equal(error.details?.['reason'], 'NUL_BYTE');
  });

  it('不是合法 UTF-8 又不含 NUL（例如 GBK）被拒绝，且不做有损解码', async () => {
    const bytes = Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0x0a]); // GBK「中文」
    const { ops } = makeOps(storeOf(bytes));

    const error = await expectReadError(
      'ENCODING_UNSUPPORTED',
      () => readFile(readArgs('a.txt'), depsFor(ops)),
      'GBK 字节',
    );
    assert.equal(error.details?.['reason'], 'INVALID_UTF8');
  });

  it('UTF-16 BOM 被识别为编码不支持（而不是二进制）', async () => {
    const bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('hi\n', 'utf16le')]);
    const { ops } = makeOps(storeOf(bytes));

    const error = await expectReadError(
      'ENCODING_UNSUPPORTED',
      () => readFile(readArgs('a.txt'), depsFor(ops)),
      'UTF-16 文件',
    );
    assert.equal(error.details?.['reason'], 'UTF16_BOM');
  });

  it('超过可读上限的文件在读取之前被拒绝', async () => {
    const { ops, calls } = makeOps(storeOf(Buffer.alloc(LIMITS.MAX_READABLE_FILE_BYTES + 1, 0x61)));

    const error = await expectReadError(
      'SIZE_LIMIT_EXCEEDED',
      () => readFile(readArgs('a.txt'), depsFor(ops)),
      '超大文件',
    );
    assert.equal(error.details?.['limit'], 'MAX_READABLE_FILE_BYTES');
    assert.equal(calls.read, 0, '尺寸判断必须发生在读字节之前');
  });

  it('两次打开之间对象被换掉时失败（I07 的读侧）', async () => {
    const store = new Map([['a.txt', fileOf('first\n', { file_id: 'file-A' })]]);
    const base = makeOps(store);

    // 在 readFileGuarded 之前把对象换成一个**同尺寸**但不同的文件对象：
    // 尺寸检查抓不到它，能抓住它的只有文件身份。
    const swapped: WinfsOps = {
      ...base.ops,
      readFileGuarded: (req: WinfsPathRef) => {
        store.set('a.txt', fileOf('first\n', { file_id: 'file-B' }));
        return base.ops.readFileGuarded(req);
      },
    };

    const error = await expectReadError(
      'FILE_VERSION_CONFLICT',
      () => readFile(readArgs('a.txt'), depsFor(swapped)),
      '读取中被换对象',
    );
    assert.equal(error.details?.['reason'], 'identity_changed_between_opens');
    assert.equal(error.details?.['size_before'], error.details?.['size_after'], '这一例刻意是同尺寸');
  });

  it('护栏错误码按契约映射；没有等价码的落到 INTERNAL_ERROR 并保留原码', async () => {
    const opsOf = (code: WinfsError['code']): WinfsOps => ({
      ...makeOps(new Map()).ops,
      resolvePath: () => Promise.resolve({ ok: false, code, message: `${code} 由护栏给出`, win32_error: 5 }),
    });

    const notFound = await expectReadError(
      'NOT_FOUND',
      () => readFile(readArgs('a.txt'), depsFor(opsOf('NOT_FOUND'))),
      '护栏 NOT_FOUND',
    );
    assert.equal(notFound.details?.['winfs_code'], 'NOT_FOUND');

    // 契约里没有 ACL 拒绝的等价码。编一个听起来合理的（PATH_UNSAFE 或
    // POLICY_DENIED）会把调用方引向错误的方向 —— 前者说"路径不安全"，
    // 后者说"去改本地策略"，两句话在这里都是假的。
    const denied = await expectReadError(
      'INTERNAL_ERROR',
      () => readFile(readArgs('a.txt'), depsFor(opsOf('PERMISSION_DENIED'))),
      '护栏 PERMISSION_DENIED',
    );
    assert.equal(denied.details?.['winfs_code'], 'PERMISSION_DENIED');
    assert.equal(denied.details?.['win32_error'], 5);
  });
});

// ---------------------------------------------------------------------------
// 5. 读取票据与游标（验收标准 3）
// ---------------------------------------------------------------------------

describe('LWB-013 伪造与重放的读取票据被拒绝', () => {
  async function readOnce(content = 'alpha\nbeta\ngamma\n') {
    const { ops } = makeOps(storeOf(content));
    const deps = depsFor(ops);
    const data = await readFile(readArgs('a.txt'), deps);
    return { data, deps };
  }

  it('票据绑定整文件哈希、身份与实际返回范围，且不含正文', async () => {
    const { data, deps } = await readOnce();
    const token = deps.authority.verifyReadTicket(data.read_token, { now: NOW });

    assert.equal(token.kind, 'read');
    assert.equal(token.connection_id, CONNECTION);
    assert.equal(token.workspace_id, 'ws-1');
    assert.equal(token.generation, 1);
    assert.equal(token.canonical_path, 'a.txt');
    assert.equal(token.raw_bytes_sha256, data.sha256);
    assert.equal(token.total_lines, 3);
    assert.equal(token.range_start, 1);
    assert.equal(token.range_end_exclusive, 4);
    assert.equal(token.truncated, false);
    assert.equal(token.expires_at, NOW + LIMITS.READ_TOKEN_TTL_MS);

    const version = fileVersionOf(token);
    assert.equal(version.raw_bytes_sha256, data.sha256);
    assert.equal(version.volume_id, VOLUME);

    assert.ok(!data.read_token.includes('alpha'), '票据里绝不能出现正文');
  });

  it('改动一个字符即签名不匹配', async () => {
    const { data, deps } = await readOnce();
    const token = data.read_token;
    const at = Math.floor(token.length / 2);
    const flipped = `${token.slice(0, at)}${token[at] === 'A' ? 'B' : 'A'}${token.slice(at + 1)}`;

    const error = await expectReadError(
      'READ_TOKEN_STALE',
      () => Promise.resolve(deps.authority.verifyReadTicket(flipped, { now: NOW })),
      '被改动的票据',
    );
    assert.equal(error.details?.['reason'], 'TICKET_BAD_SIGNATURE');
  });

  it('用别的密钥签发的票据不被接受', async () => {
    const { data } = await readOnce();
    const other = createReadTicketAuthority({ key: 'another-key-0123456789abcdef0123456789abcdef' });

    const error = await expectReadError(
      'READ_TOKEN_STALE',
      () => Promise.resolve(other.verifyReadTicket(data.read_token, { now: NOW })),
      '换密钥验签',
    );
    assert.equal(error.details?.['reason'], 'TICKET_BAD_SIGNATURE');
  });

  it('过期即失效（票据无状态，有效期是唯一的失效机制，因此必须真的生效）', async () => {
    const { data, deps } = await readOnce();
    const error = await expectReadError(
      'READ_TOKEN_STALE',
      () =>
        Promise.resolve(deps.authority.verifyReadTicket(data.read_token, { now: NOW + LIMITS.READ_TOKEN_TTL_MS })),
      '过期的票据',
    );
    assert.equal(error.details?.['reason'], 'TICKET_EXPIRED');
  });

  it('跨连接、跨工作区、跨代次的使用被拒绝', async () => {
    const { data, deps } = await readOnce();
    const token = deps.authority.verifyReadTicket(data.read_token, { now: NOW });

    const crossConnection = await expectReadError(
      'READ_TOKEN_STALE',
      () =>
        Promise.resolve(
          assertReadTokenMatches(token, {
            connection_id: 'conn-2',
            workspace_id: 'ws-1',
            generation: 1,
            path: 'a.txt',
          }),
        ),
      '跨连接重放',
    );
    assert.equal(crossConnection.details?.['reason'], 'TICKET_CROSS_CONNECTION');

    const crossWorkspace = await expectReadError(
      'READ_TOKEN_STALE',
      () =>
        Promise.resolve(
          assertReadTokenMatches(token, {
            connection_id: CONNECTION,
            workspace_id: 'ws-2',
            generation: 1,
            path: 'a.txt',
          }),
        ),
      '跨工作区重放',
    );
    assert.equal(crossWorkspace.details?.['reason'], 'TICKET_CROSS_WORKSPACE');

    const crossGeneration = await expectReadError(
      'READ_TOKEN_STALE',
      () =>
        Promise.resolve(
          assertReadTokenMatches(token, {
            connection_id: CONNECTION,
            workspace_id: 'ws-1',
            generation: 2,
            path: 'a.txt',
          }),
        ),
      '跨代次重放',
    );
    assert.equal(crossGeneration.details?.['reason'], 'TICKET_GENERATION_MISMATCH');
  });

  it('路径大小写不同不算跨文件（NTFS 不区分大小写），但换了文件算', async () => {
    const { data, deps } = await readOnce();
    const token = deps.authority.verifyReadTicket(data.read_token, { now: NOW });

    // 不抛错即通过：同一个对象的不同拼写不该被判成重放。
    assertReadTokenMatches(token, { connection_id: CONNECTION, workspace_id: 'ws-1', generation: 1, path: 'A.TXT' });

    const error = await expectReadError(
      'READ_TOKEN_STALE',
      () =>
        Promise.resolve(
          assertReadTokenMatches(token, {
            connection_id: CONNECTION,
            workspace_id: 'ws-1',
            generation: 1,
            path: 'b.txt',
          }),
        ),
      '换了文件',
    );
    assert.equal(error.details?.['reason'], 'TICKET_PATH_MISMATCH');
  });

  it('基线哈希不符时拒绝（票据不能用于另一份内容）', async () => {
    const { data, deps } = await readOnce();
    const token = deps.authority.verifyReadTicket(data.read_token, { now: NOW });

    const error = await expectReadError(
      'READ_TOKEN_STALE',
      () =>
        Promise.resolve(
          assertReadTokenMatches(token, {
            connection_id: CONNECTION,
            workspace_id: 'ws-1',
            generation: 1,
            path: 'a.txt',
            base_sha256: 'f'.repeat(64),
          }),
        ),
      '基线不符',
    );
    assert.equal(error.details?.['reason'], 'TICKET_BASE_MISMATCH');
  });

  it('游标改前缀也不能当票据用', async () => {
    const { ops } = makeOps(storeOf('x\n'.repeat(1000)));
    const deps = depsFor(ops);

    const first = await readFile(readArgs('a.txt', { max_lines: 2 }), deps);
    assert.notEqual(first.next_cursor, null);
    const cursor = first.next_cursor ?? '';

    // 前缀是明文，改一下就能贴上「读取票据」的外形 —— 载荷里的 kind 才是判据。
    const disguised = `lwbrt_${cursor.slice('lwbc_'.length)}`;
    const error = await expectReadError(
      'READ_TOKEN_STALE',
      () => Promise.resolve(deps.authority.verifyReadTicket(disguised, { now: NOW })),
      '把游标当票据',
    );
    assert.equal(error.details?.['reason'], 'TICKET_WRONG_KIND');

    // 反过来也一样：拿真票据当游标，在验签最前面就被前缀栏拦住。
    const other = await expectReadError(
      'READ_TOKEN_STALE',
      () => Promise.resolve(deps.authority.verifyCursor(first.read_token, { now: NOW })),
      '把票据当游标',
    );
    assert.equal(other.details?.['reason'], 'TICKET_WRONG_PREFIX');
  });

  it('文件在两次读取之间变化后，旧游标被拒绝而不是"接着读"', async () => {
    const store = new Map([['a.txt', fileOf('x\n'.repeat(1000))]]);
    const { ops } = makeOps(store);
    const deps = depsFor(ops);

    const first = await readFile(readArgs('a.txt', { max_lines: 2 }), deps);
    const cursor = first.next_cursor ?? '';

    // 文件变了：行号可能已错位，继续分页会给出正文与行号对不上的结果。
    store.set('a.txt', fileOf('y\n'.repeat(1000)));
    const error = await expectReadError(
      'READ_TOKEN_STALE',
      () => readFile(readArgs('a.txt', { cursor }), deps),
      '文件变化后继续分页',
    );
    assert.equal(error.details?.['reason'], 'CURSOR_VERSION_MISMATCH');
  });

  it('内容相同但已不是同一个文件对象时，游标同样被拒绝', async () => {
    const store = new Map([['a.txt', fileOf('x\n'.repeat(1000), { file_id: 'file-A' })]]);
    const { ops } = makeOps(store);
    const deps = depsFor(ops);

    const first = await readFile(readArgs('a.txt', { max_lines: 2 }), deps);
    const cursor = first.next_cursor ?? '';

    // 删除后重建（或换了一个硬链接目标）：字节完全一样，哈希也一样，
    // 但那是另一个文件对象。只比哈希的实现会放它过去。
    store.set('a.txt', fileOf('x\n'.repeat(1000), { file_id: 'file-B' }));
    const error = await expectReadError(
      'READ_TOKEN_STALE',
      () => readFile(readArgs('a.txt', { cursor }), deps),
      '同内容不同对象',
    );
    assert.equal(error.details?.['reason'], 'CURSOR_TARGET_CHANGED');
  });

  it('coversEditRange：只有已返回过的行区间才可编辑', async () => {
    const { data, deps } = await readOnce('1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n');
    const token = deps.authority.verifyReadTicket(data.read_token, { now: NOW });
    assert.equal(token.range_start, 1);
    assert.equal(token.range_end_exclusive, 11);

    assert.equal(coversEditRange(token, 3, 6), true);
    assert.equal(coversEditRange(token, 1, 11), true);
    assert.equal(coversEditRange(token, 0, 5), false, '起点越界');
    assert.equal(coversEditRange(token, 5, 12), false, '终点越界');
    assert.equal(coversEditRange(token, 7, 3), false, '区间反向');

    // 只读了前 3 行时，没读到的区间不能落笔。
    const { ops } = makeOps(storeOf('1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n'));
    const partialDeps = depsFor(ops);
    const partial = await readFile(readArgs('a.txt', { max_lines: 3 }), partialDeps);
    assert.equal(partial.editable, true, '分页不等于不可编辑：行号仍然真实（见 read.ts 的裁定说明）');
    const partialToken = partialDeps.authority.verifyReadTicket(partial.read_token, { now: NOW });
    assert.equal(partialToken.range_end_exclusive, 4);
    assert.equal(coversEditRange(partialToken, 1, 4), true);
    assert.equal(coversEditRange(partialToken, 2, 8), false, '没过读到的行不能编辑');
  });
});

// ---------------------------------------------------------------------------
// 6. 脱敏（I10 方向：拒绝而不是降级）
// ---------------------------------------------------------------------------

describe('LWB-013 脱敏结果不得获得可编辑票据', () => {
  /**
   * 这一例用**真实夹具** `secrets/token.txt` —— 同目录的 `.env` / `aws.env` /
   * `id_rsa` 已经被硬拒绝拦在更前面，够不到脱敏这一步，所以能用上脱敏的
   * 恰好是这一份。它含两个 certain 级命中：`ghp_…`（GitHub 令牌）与
   * `xoxb-…`（Slack 令牌）。
   *
   * 期望正文是**逐字**写出来的，因为这里要验的不只是"命中了"，还有
   * 「同一段文本被两条规则命中时，标记用的是更严重的那条规则 id」。
   */
  it('certain 级命中被就地脱敏：正文可读，但被命中的值一个字符都不留', async () => {
    const relPath = 'secrets/token.txt';
    const raw = await readDiskFile(repoPath(relPath));
    const original = raw.toString('utf8');
    assert.ok(original.includes('ghp_0123456789abcdefghijklmnopqrstuvwxyz'), '装置前提：夹具含 GitHub 令牌形状');
    assert.ok(original.includes('xoxb-'), '装置前提：夹具含 Slack 令牌形状');

    const { ops } = makeOps(new Map([[relPath, fileOf(raw)]]));
    const data = await readFile(readArgs(relPath), depsFor(ops));

    assert.equal(
      data.content,
      '# LWB 测试诱饵：公开示例格式的假 token。\n' +
        'GITHUB_TOKEN=[REDACTED:github-token]\n' +
        'SLACK_TOKEN=[REDACTED:slack-token]\n',
      '脱敏后的正文（规则或夹具变了，这里就该跟着变）',
    );
    assert.equal(data.redacted, true);
    assert.equal(data.bytes_returned, Buffer.byteLength(data.content, 'utf8'));

    // 哈希仍然描述**磁盘上那份原始字节** —— 脱敏不改变「读的是哪个版本」。
    const manifest = await loadManifest();
    assert.equal(data.sha256, manifest.files.find((f) => f.relPath === relPath)?.sha256);
  });

  it('脱敏的读取不可编辑，并说明行号不再与磁盘一一对应', async () => {
    const relPath = 'secrets/token.txt';
    const raw = await readDiskFile(repoPath(relPath));
    const { ops } = makeOps(new Map([[relPath, fileOf(raw)]]));
    const data = await readFile(readArgs(relPath), depsFor(ops));

    assert.equal(data.editable, false);
    assert.ok(
      data.editable_blockers.some((b) => b.includes('脱敏')),
      `拒绝理由应提到脱敏：${data.editable_blockers.join('；')}`,
    );
  });

  it('只有命中的那一段被替换，其余正文逐字保留', async () => {
    const content = 'line one\naws_key = AKIAIOSFODNN7EXAMPLE\nline three\n';
    const { ops } = makeOps(storeOf(content));
    const data = await readFile(readArgs('a.txt'), depsFor(ops));

    assert.equal(
      data.content,
      'line one\naws_key = [REDACTED:aws-access-key-id]\nline three\n',
      '未命中的部分逐字保留，命中的值整段换成标记',
    );
    assert.ok(!data.content.includes('AKIAIOSFODNN7EXAMPLE'));
  });
});

// ---------------------------------------------------------------------------
// 7. 元数据预检
// ---------------------------------------------------------------------------

describe('LWB-013 元数据预检', () => {
  it('返回哈希与形态，但不含正文、不签发票据', async () => {
    const bytes = Buffer.from('alpha\nbeta\n', 'utf8');
    const { ops } = makeOps(storeOf(bytes));

    const stat = await statFile(
      { scope: scopeOf(), connection_id: CONNECTION, decision: allowedDecision('stat'), path: 'a.txt', now: NOW },
      depsFor(ops),
    );

    assert.equal(stat.sha256, sha256Of(bytes));
    assert.equal(stat.size, 11);
    assert.equal(stat.encoding, 'utf-8');
    assert.equal(stat.editable, false, 'stat 永远不构成可编辑授权');
    assert.equal('read_token' in stat, false, '契约里没有这个字段：拿 stat 去编辑在类型上就不可能');
    assert.equal('content' in stat, false);
    assert.equal(stat.path, 'a.txt');
  });

  it('硬拒绝路径连元数据都不给（否则就成了存在性/大小/哈希探针）', async () => {
    const store = new Map([['.npmrc', fileOf('//registry/:_authToken=xxx\n')]]);
    const { ops, calls } = makeOps(store);

    const error = await expectReadError(
      'POLICY_DENIED',
      () =>
        statFile(
          { scope: scopeOf(), connection_id: CONNECTION, decision: allowedDecision('stat'), path: '.npmrc', now: NOW },
          depsFor(ops),
        ),
      'stat 硬拒绝路径',
    );
    assert.equal(error.details?.['hard_deny_rule'], 'HD-CREDENTIAL-STORE');
    assert.equal(calls.read, 0, '元数据预检同样在读字节之前就被拦下');
  });

  it('判定结果与工作区不一致时拒绝', async () => {
    const { ops } = makeOps(storeOf('x\n'));
    await expectReadError(
      'INVALID_ARGUMENT',
      () =>
        readFile(
          { ...readArgs('a.txt'), scope: scopeOf({ workspace_id: 'ws-other' }), decision: allowedDecision('read') },
          depsFor(ops),
        ),
      '判定与作用域不符',
    );
  });
});

// ---------------------------------------------------------------------------
// 8. 限额表本身
// ---------------------------------------------------------------------------

describe('LWB-013 限额', () => {
  it('默认限额来自冻结契约', () => {
    assert.equal(DEFAULT_READ_LIMITS.max_readable_file_bytes, LIMITS.MAX_READABLE_FILE_BYTES);
    assert.equal(DEFAULT_READ_LIMITS.read_token_ttl_ms, LIMITS.READ_TOKEN_TTL_MS);
    assert.ok(
      LIMITS.MAX_READABLE_FILE_BYTES > LIMITS.MAX_EDITABLE_FILE_BYTES,
      '可读上限必须高于可编辑上限：读一份两兆以上的日志是合理请求，改它才是不合理的',
    );
  });

  it('操作者收紧限额后生效（模型参数改不了它）', async () => {
    const { ops } = makeOps(storeOf('1\n2\n3\n4\n5\n'));
    const data = await readFile(readArgs('a.txt'), depsFor(ops, { limits: { max_read_lines: 2 } }));
    assert.equal(data.end_line_exclusive, 3);
    assert.equal(data.truncated, true);
  });
});
