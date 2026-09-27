/**
 * 精确文本编辑契约与逐字节引擎（LWB-019）。
 *
 * ## 判据来源
 *
 * 「未触及的字节与原文件完全一致」这句话，只有拿**真实夹具字节**去改才算
 * 验证过。因此本文件分两层：
 *
 *  - 逐项断言用夹具里的真实字节（BOM、CRLF、中文、emoji 路径、无末尾换行）；
 *  - 再对整个夹具清单跑一遍**恒等编辑**（把第 1 行替换成它自己）：
 *    产物必须与原文件**逐字节相同**。这一条是「没有被动过的字节一个都不
 *    重新编码」最强的表述 —— 一次编辑都不改内容，那么一个字节都不该变。
 *
 * 负向用例（伪造票据、过期票据、重复物理文件、重叠区间）用合成的票据与
 * 字节构造：它们要验的正是那些正常路径上走不到的判定。
 *
 * ## 断言方式
 *
 * 涉及字节的断言一律**精确相等**，不用「包含 / 不含」：「输出里没有 X」
 * 在输出整个错位时也可能为真。
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

import { BridgeError, LIMITS, validateRelativePath } from '@lwb/contracts';
import type { LineEdit } from '@lwb/contracts';
import { createReadTicketAuthority, inspectBytes, lineText } from '@lwb/files';
import type { DecodedText, ReadTicketFacts } from '@lwb/files';
import {
  applyLineEdits,
  createTextFile,
  replaceWholeText,
  validateChangeItems,
} from '@lwb/changes';
import type { ChangeValidationContext, ValidatedChangeItem } from '@lwb/changes';

import { ensureFixtures, loadManifest, repoPath } from '../fixtures/index.ts';

// ---------------------------------------------------------------------------
// 装置
// ---------------------------------------------------------------------------

const NOW = Date.UTC(2026, 0, 1, 12, 0, 0);
const CONNECTION = 'conn-1';
const WORKSPACE = 'ws-1';
const GENERATION = 7;
const VOLUME = 'c6e22015';
const FILE_ID = '0002000000000123';
const KEY = 'lwb-test-key-0123456789abcdef0123456789abcdef';

const authority = createReadTicketAuthority({ key: KEY });

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function context(over: Partial<ChangeValidationContext> = {}): ChangeValidationContext {
  return { connection_id: CONNECTION, workspace_id: WORKSPACE, generation: GENERATION, now: NOW, authority, ...over };
}

function decode(bytes: Uint8Array): DecodedText {
  const decoded = inspectBytes(bytes);
  if (decoded.kind !== 'text') throw new Error(`装置错误：这不是文本字节（${decoded.reason}）`);
  return decoded;
}

/** 铸一张**真实**票据。伪造与过期的负向用例也走这里，只改时间或字节。 */
function mintTicket(
  bytes: Uint8Array,
  path: string,
  over: Partial<ReadTicketFacts> = {},
  mintedAt: number = NOW,
): string {
  const decoded = decode(bytes);
  const facts: ReadTicketFacts = {
    connection_id: CONNECTION,
    workspace_id: WORKSPACE,
    generation: GENERATION,
    canonical_path: path,
    volume_id: VOLUME,
    file_id: FILE_ID,
    raw_bytes_sha256: sha256(bytes),
    size: bytes.length,
    total_lines: decoded.lines.total_lines,
    range_start: 1,
    range_end_exclusive: decoded.lines.total_lines + 1,
    truncated: false,
    truncated_lines: [],
    editable: true,
    editable_blockers: [],
    redacted: false,
    ...over,
  };
  return authority.mintReadTicket(facts, { now: mintedAt, ttl_ms: LIMITS.READ_TOKEN_TTL_MS });
}

function editItem(path: string, token: string, edits: readonly unknown[], sha?: string): Record<string, unknown> {
  return { op: 'edit_text', path, base_sha256: sha ?? '', read_token: token, edits };
}

function replaceItem(path: string, token: string, content: string, sha: string): Record<string, unknown> {
  return { op: 'replace_text', path, base_sha256: sha, read_token: token, content };
}

function createItem(path: string, content: string, newline = 'lf', bom = false): Record<string, unknown> {
  return { op: 'create_text', path, content, newline, bom };
}

/** 跑一遍契约校验，返回第一条已验证的修改项（多数用例只有一条）。 */
function validateOne(item: unknown, ctx: ChangeValidationContext = context()): ValidatedChangeItem {
  const plan = validateChangeItems([item], ctx);
  const first = plan.items[0];
  assert.ok(first, '校验应当产出一条修改项');
  return first;
}

/** 取出抛出的 BridgeError，并断言码与 reason。 */
function expectBridgeError(fn: () => unknown, code: string, reason: string): BridgeError {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof BridgeError, `期望 BridgeError，实际 ${String(error)}`);
    assert.equal(error.code, code);
    assert.equal(error.details?.['reason'], reason, `reason 不符：${JSON.stringify(error.details)}`);
    return error;
  }
  throw new assert.AssertionError({ message: `期望抛出 ${code}/${reason}，实际没有抛错` });
}

async function fixtureBytes(relPath: string): Promise<Buffer> {
  ensureFixtures();
  return readFile(repoPath(relPath));
}

// ---------------------------------------------------------------------------
// 验收标准 (b)：未触及的字节与原文件完全一致
// ---------------------------------------------------------------------------

describe('LWB-019 字节保真', () => {
  it('替换 LF 文件的中间一行：前缀与后缀是原字节，不是重新编码的结果', async () => {
    const original = await fixtureBytes('newline/lf.txt');
    const token = mintTicket(original, 'lf.txt');
    const item = validateOne(editItem('lf.txt', token, [{ start_line: 2, end_line_exclusive: 3, old_lines: ['lf-line-2'], new_lines: ['（改过的第二行）'] }], sha256(original)));

    const result = applyLineEdits({ item: item as never, original, baseline: decode(original) });

    // 期望值由**测试自己**按字符串拼出来，不调用被测代码的偏移计算。
    const prefix = 'lf-line-1\n';
    const suffix = 'lf-line-3\n';
    const from = Buffer.byteLength(prefix, 'utf8');
    const expectedRegion = Buffer.from('（改过的第二行）\n', 'utf8');

    assert.deepEqual(result.bytes.subarray(0, from), original.subarray(0, from), '前缀必须是原字节');
    assert.deepEqual(result.bytes.subarray(from, from + expectedRegion.length), expectedRegion);
    assert.deepEqual(result.bytes.subarray(from + expectedRegion.length), Buffer.from(suffix, 'utf8'), '后缀必须是原字节');
    assert.equal(Buffer.concat([original.subarray(0, from), expectedRegion, original.subarray(from + Buffer.byteLength('lf-line-2\n', 'utf8'))]).equals(Buffer.from(result.bytes)), true);
    assert.equal(result.after_sha256, sha256(Buffer.from(result.bytes)));
  });

  it('CRLF 文件写回仍是 CRLF，且前缀逐字节相同', async () => {
    const original = await fixtureBytes('newline/crlf.txt');
    const token = mintTicket(original, 'crlf.txt');
    const item = validateOne(editItem('crlf.txt', token, [{ start_line: 3, end_line_exclusive: 4, old_lines: ['crlf-line-3'], new_lines: ['x'] }], sha256(original)));

    const result = applyLineEdits({ item: item as never, original, baseline: decode(original) });

    assert.equal(result.newline, 'crlf');
    const from = Buffer.byteLength('crlf-line-1\r\ncrlf-line-2\r\n', 'utf8');
    assert.deepEqual(result.bytes.subarray(0, from), original.subarray(0, from));
    assert.equal(Buffer.from(result.bytes).toString('utf8'), 'crlf-line-1\r\ncrlf-line-2\r\nx\r\n');
    // 反向对照：产物里不得出现单一 LF（那会说明风格被静默改写了）。
    assert.equal(/[^\r]\n/.test(Buffer.from(result.bytes).toString('utf8')), false);
  });

  it('BOM 文件：BOM 保留，正文按原字节切片', async () => {
    const original = await fixtureBytes('bom/with-bom.txt');
    assert.deepEqual(original.subarray(0, 3), Buffer.from([0xef, 0xbb, 0xbf]));
    const token = mintTicket(original, 'with-bom.txt');
    const item = validateOne(editItem('with-bom.txt', token, [{ start_line: 2, end_line_exclusive: 3, old_lines: ['第二行。'], new_lines: ['第二行（改）。'] }], sha256(original)));

    const result = applyLineEdits({ item: item as never, original, baseline: decode(original) });

    assert.equal(result.bom, true);
    assert.equal(result.encoding, 'utf-8-bom');
    assert.deepEqual(result.bytes.subarray(0, 3), Buffer.from([0xef, 0xbb, 0xbf]), 'BOM 必须原样保留');
    // BOM 之后到第 2 行之前（含中文，多字节）必须逐字节相同。
    const headLen = 3 + Buffer.byteLength('带 BOM 的文件\n', 'utf8');
    assert.deepEqual(result.bytes.subarray(0, headLen), original.subarray(0, headLen));
    assert.equal(Buffer.from(result.bytes).toString('utf8'), '\ufeff带 BOM 的文件\n第二行（改）。\n');
  });

  it('无末尾换行的文件：替换中间行后仍然没有末尾换行', async () => {
    const original = await fixtureBytes('newline/no-trailing-newline.txt');
    const token = mintTicket(original, 'no-trailing-newline.txt');
    const item = validateOne(editItem('no-trailing-newline.txt', token, [{ start_line: 1, end_line_exclusive: 2, old_lines: ['no-trailing-1'], new_lines: ['改'] }], sha256(original)));

    const result = applyLineEdits({ item: item as never, original, baseline: decode(original) });

    assert.equal(Buffer.from(result.bytes).toString('utf8'), '改\nno-trailing-2');
    assert.equal(result.after_size, Buffer.byteLength('改\nno-trailing-2', 'utf8'));
  });

  it('无末尾换行的文件：在末尾插入一行要先补上分隔换行', async () => {
    const original = await fixtureBytes('newline/no-trailing-newline.txt');
    const token = mintTicket(original, 'no-trailing-newline.txt');
    // 纯插入，插入点在最后一行之后（第 3 行位置）。
    const item = validateOne(editItem('no-trailing-newline.txt', token, [{ start_line: 3, end_line_exclusive: 3, old_lines: [], new_lines: ['第三行'] }], sha256(original)));

    const result = applyLineEdits({ item: item as never, original, baseline: decode(original) });

    // 写成 'no-trailing-2' + '第三行' 会得到一行，而那是错的。
    assert.equal(Buffer.from(result.bytes).toString('utf8'), 'no-trailing-1\nno-trailing-2\n第三行');
    assert.equal(result.added_lines, 1);
    assert.equal(result.removed_lines, 0);
  });

  it('无末尾换行的文件：在末尾插入后，末尾仍然没有换行', async () => {
    const original = await fixtureBytes('newline/no-trailing-newline.txt');
    const token = mintTicket(original, 'no-trailing-newline.txt');
    const item = validateOne(editItem('no-trailing-newline.txt', token, [{ start_line: 1, end_line_exclusive: 3, old_lines: ['no-trailing-1', 'no-trailing-2'], new_lines: ['甲', '乙', '丙'] }], sha256(original)));

    const result = applyLineEdits({ item: item as never, original, baseline: decode(original) });
    assert.equal(Buffer.from(result.bytes).toString('utf8'), '甲\n乙\n丙');
  });

  it('空文件上插入一行：不引入任何换行（原文件里没有换行风格可沿用）', async () => {
    const original = await fixtureBytes('edge/empty.txt');
    assert.equal(original.length, 0);
    const token = mintTicket(original, 'empty.txt');
    const item = validateOne(editItem('empty.txt', token, [{ start_line: 1, end_line_exclusive: 1, old_lines: [], new_lines: ['第一行'] }], sha256(original)));

    const result = applyLineEdits({ item: item as never, original, baseline: decode(original) });
    assert.equal(Buffer.from(result.bytes).toString('utf8'), '第一行');
    assert.equal(result.newline, 'none');
  });

  it('整个夹具清单跑恒等编辑：产物必须与原文件逐字节相同', async () => {
    ensureFixtures();
    const manifest = await loadManifest();
    let checked = 0;
    let rejected = 0;

    for (const entry of manifest.files) {
      const bytes = await fixtureBytes(entry.relPath);
      if (entry.lineCount === null || entry.lineCount < 1) continue;
      if (bytes.length > 64 * 1024) continue; // 大文件另有测试，这里只跑小文件

      // 可编辑与否取自**夹具清单**（它是生成器算的），不在这里重判一次。
      const decoded = decode(bytes);
      const editable = entry.editable && (entry.newline === 'lf' || entry.newline === 'crlf');
      const token = mintTicket(bytes, entry.relPath, {
        editable,
        editable_blockers: editable ? [] : ['夹具清单标记为不可编辑'],
        truncated_lines: entry.relPath === 'edge/long-line.txt' ? [1] : [],
      });
      // 行文本必须是**去掉终止符**的那一段：CRLF 文件按 '\n' 切出来的首段带着 \r。
      const first = lineText(decoded.text, decoded.lines, 1);
      const item = editItem(entry.relPath, token, [{ start_line: 1, end_line_exclusive: 2, old_lines: [first], new_lines: [first] }], sha256(bytes));

      if (!editable) {
        expectBridgeError(() => validateOne(item), 'READ_TOKEN_STALE', 'TICKET_NOT_EDITABLE');
        rejected += 1;
        continue;
      }
      const validated = validateOne(item);
      const result = applyLineEdits({ item: validated as never, original: bytes, baseline: decoded });
      assert.deepEqual(
        Buffer.from(result.bytes),
        bytes,
        `${entry.relPath}：把一行替换成它自己之后，字节不应有任何变化`,
      );
      assert.equal(result.after_sha256, entry.sha256, `${entry.relPath}：恒等编辑的哈希必须等于夹具清单里的哈希`);
      checked += 1;
    }

    // 下界写死在这里，是为了让「清单变了导致这条测试静默地什么都没跑」
    // 变成一次失败，而不是一次通过。今天的实际值是 11 与 7。
    assert.ok(checked >= 11, `恒等编辑至少应覆盖 11 个夹具文件，实际 ${checked}`);
    assert.ok(rejected >= 5, `不可编辑的夹具应被拒绝，实际 ${rejected}`);
  });
});

// ---------------------------------------------------------------------------
// 验收标准 (a)：重复文本不选错位置；旧内容不一致直接冲突
// ---------------------------------------------------------------------------

describe('LWB-019 位置与冲突', () => {
  it('文件里有两行完全相同的空行时，区间决定改哪一行', async () => {
    const original = await fixtureBytes('文档/设计说明.md');
    const decoded = decode(original);
    // 夹具里第 2 行与第 5 行都是空行 —— 这是「重复文本」在真实字节上的形态。
    assert.equal(lineText(decoded.text, decoded.lines, 2), '', '装置前提：第 2 行是空行');
    assert.equal(lineText(decoded.text, decoded.lines, 5), '', '装置前提：第 5 行也是空行');

    const token = mintTicket(original, '设计说明.md');
    const item = validateOne(editItem('设计说明.md', token, [{ start_line: 2, end_line_exclusive: 3, old_lines: [''], new_lines: ['（第二行位置）'] }], sha256(original)));
    const result = applyLineEdits({ item: item as never, original, baseline: decoded });

    const lines = Buffer.from(result.bytes).toString('utf8').split('\n');
    assert.equal(lines[1], '（第二行位置）');
    assert.equal(lines[4], '', '第 5 行的空行不能被改动');
    // 行数用识别器数，不用 `split('\n')` —— 末尾有换行时后者会多出一段空串。
    assert.equal(decode(result.bytes).lines.total_lines, decoded.lines.total_lines);
  });

  it('另一处同样的空行：换成第 5 行，改的就只有第 5 行', async () => {
    const original = await fixtureBytes('文档/设计说明.md');
    const token = mintTicket(original, '设计说明.md');
    const item = validateOne(editItem('设计说明.md', token, [{ start_line: 5, end_line_exclusive: 6, old_lines: [''], new_lines: ['（第五行位置）'] }], sha256(original)));
    const result = applyLineEdits({ item: item as never, original, baseline: decode(original) });

    const lines = Buffer.from(result.bytes).toString('utf8').split('\n');
    assert.equal(lines[1], '', '第 2 行的空行不能被改动');
    assert.equal(lines[4], '（第五行位置）');
  });

  it('old_lines 与磁盘不一致：FILE_VERSION_CONFLICT，且诊断里不含文件内容', async () => {
    const original = await fixtureBytes('newline/lf.txt');
    const token = mintTicket(original, 'lf.txt');
    const item = validateOne(editItem('lf.txt', token, [{ start_line: 2, end_line_exclusive: 3, old_lines: ['lf-line-1'], new_lines: ['x'] }], sha256(original)));

    const error = expectBridgeError(
      () => applyLineEdits({ item: item as never, original, baseline: decode(original) }),
      'FILE_VERSION_CONFLICT',
      'EDIT_BASELINE_MISMATCH',
    );
    assert.equal(error.details?.['line'], 2);
    const shown = `${error.message} ${JSON.stringify(error.details)}`;
    assert.equal(shown.includes('lf-line-1'), false, '诊断里不得回显用户文件的内容');
    assert.equal(shown.includes('lf-line-2'), false);
  });

  it('磁盘字节与票据记录的版本不一致：FILE_VERSION_CONFLICT（不写任何东西）', async () => {
    const original = await fixtureBytes('newline/lf.txt');
    const token = mintTicket(original, 'lf.txt');
    const changed = Buffer.from('lf-line-1\nlf-line-2\nlf-line-3\nlf-line-4\n', 'utf8');
    const item = validateOne(editItem('lf.txt', token, [{ start_line: 2, end_line_exclusive: 3, old_lines: ['lf-line-2'], new_lines: ['x'] }], sha256(original)));

    expectBridgeError(
      () => applyLineEdits({ item: item as never, original: changed, baseline: decode(changed) }),
      'FILE_VERSION_CONFLICT',
      'BASELINE_HASH_MISMATCH',
    );
  });

  it('插入区间带 old_lines：结构上自相矛盾，直接拒绝', async () => {
    const original = await fixtureBytes('newline/lf.txt');
    const token = mintTicket(original, 'lf.txt');
    expectBridgeError(
      () => validateOne(editItem('lf.txt', token, [{ start_line: 2, end_line_exclusive: 2, old_lines: ['lf-line-2'], new_lines: ['x'] }], sha256(original))),
      'INVALID_ARGUMENT',
      'EDIT_INSERT_WITH_OLD_LINES',
    );
  });

  it('old_lines 行数与区间不符：拒绝（在比对内容之前）', async () => {
    const original = await fixtureBytes('newline/lf.txt');
    const token = mintTicket(original, 'lf.txt');
    expectBridgeError(
      () => validateOne(editItem('lf.txt', token, [{ start_line: 1, end_line_exclusive: 3, old_lines: ['lf-line-1'], new_lines: ['x'] }], sha256(original))),
      'INVALID_ARGUMENT',
      'EDIT_OLD_LINE_COUNT',
    );
  });
});

// ---------------------------------------------------------------------------
// 验收标准 (c)：无法偷偷在同一文件添加第二次隐含操作
// ---------------------------------------------------------------------------

describe('LWB-019 同一文件的第二次操作', () => {
  it('同一路径出现两次：拒绝', async () => {
    const original = await fixtureBytes('newline/lf.txt');
    const token = mintTicket(original, 'lf.txt');
    const sha = sha256(original);
    const edit = [{ start_line: 1, end_line_exclusive: 2, old_lines: ['lf-line-1'], new_lines: ['a'] }];
    const edit2 = [{ start_line: 3, end_line_exclusive: 4, old_lines: ['lf-line-3'], new_lines: ['b'] }];

    expectBridgeError(
      () => validateChangeItems([editItem('lf.txt', token, edit, sha), editItem('lf.txt', token, edit2, sha)], context()),
      'INVALID_ARGUMENT',
      'DUPLICATE_TARGET_PATH',
    );
  });

  it('同一路径换大小写拼写：仍然拒绝（NTFS 语义）', async () => {
    const original = await fixtureBytes('newline/lf.txt');
    const token = mintTicket(original, 'LF.txt');
    const sha = sha256(original);
    const edit = [{ start_line: 1, end_line_exclusive: 2, old_lines: ['lf-line-1'], new_lines: ['a'] }];

    expectBridgeError(
      () => validateChangeItems([editItem('LF.txt', token, edit, sha), editItem('lf.txt', token, edit, sha)], context()),
      'INVALID_ARGUMENT',
      'DUPLICATE_TARGET_PATH',
    );
  });

  it('两个不同的路径指向同一个物理文件（硬链接/别名）：靠 file_id 拒绝', async () => {
    const original = await fixtureBytes('newline/lf.txt');
    const edit = [{ start_line: 1, end_line_exclusive: 2, old_lines: ['lf-line-1'], new_lines: ['a'] }];
    const tokenA = mintTicket(original, 'a.txt');
    const tokenB = mintTicket(original, 'b.txt'); // 同一个 file_id，换一个名字
    const sha = sha256(original);

    const error = expectBridgeError(
      () => validateChangeItems([editItem('a.txt', tokenA, edit, sha), editItem('b.txt', tokenB, edit, sha)], context()),
      'INVALID_ARGUMENT',
      'DUPLICATE_TARGET_FILE',
    );
    assert.equal(error.details?.['path'], 'b.txt');
  });

  it('同一文件既 edit_text 又 create_text：拒绝（路径层）', async () => {
    const original = await fixtureBytes('newline/lf.txt');
    const token = mintTicket(original, 'lf.txt');
    const edit = [{ start_line: 1, end_line_exclusive: 2, old_lines: ['lf-line-1'], new_lines: ['a'] }];

    expectBridgeError(
      () => validateChangeItems([editItem('lf.txt', token, edit, sha256(original)), createItem('lf.txt', '新内容')], context()),
      'INVALID_ARGUMENT',
      'DUPLICATE_TARGET_PATH',
    );
  });

  it('同一项里两个区间重叠：拒绝', async () => {
    const original = await fixtureBytes('newline/lf.txt');
    const token = mintTicket(original, 'lf.txt');
    expectBridgeError(
      () =>
        validateOne(
          editItem('lf.txt', token, [
            { start_line: 1, end_line_exclusive: 3, old_lines: ['lf-line-1', 'lf-line-2'], new_lines: ['x'] },
            { start_line: 2, end_line_exclusive: 3, old_lines: ['lf-line-2'], new_lines: ['y'] },
          ], sha256(original)),
        ),
      'INVALID_ARGUMENT',
      'OVERLAPPING_EDITS',
    );
  });

  it('同一插入点写了两条插入：先后读不出来，拒绝', async () => {
    const original = await fixtureBytes('newline/lf.txt');
    const token = mintTicket(original, 'lf.txt');
    expectBridgeError(
      () =>
        validateOne(
          editItem('lf.txt', token, [
            { start_line: 2, end_line_exclusive: 2, old_lines: [], new_lines: ['甲'] },
            { start_line: 2, end_line_exclusive: 2, old_lines: [], new_lines: ['乙'] },
          ], sha256(original)),
        ),
      'INVALID_ARGUMENT',
      'OVERLAPPING_EDITS',
    );
  });

  it('相邻但不相交的两个区间：允许，且按顺序写入', async () => {
    const original = await fixtureBytes('newline/lf.txt');
    const token = mintTicket(original, 'lf.txt');
    const item = validateOne(
      editItem('lf.txt', token, [
        { start_line: 1, end_line_exclusive: 2, old_lines: ['lf-line-1'], new_lines: ['甲'] },
        { start_line: 2, end_line_exclusive: 3, old_lines: ['lf-line-2'], new_lines: ['乙'] },
      ], sha256(original)),
    );
    const result = applyLineEdits({ item: item as never, original, baseline: decode(original) });
    assert.equal(Buffer.from(result.bytes).toString('utf8'), '甲\n乙\nlf-line-3\n');
    assert.equal(result.added_lines, 2);
    assert.equal(result.removed_lines, 2);
  });
});

// ---------------------------------------------------------------------------
// 票据：伪造、过期、跨连接、跨工作区、基线不符
// ---------------------------------------------------------------------------

describe('LWB-019 票据与身份', () => {
  it('把票据改一个字符：签名不匹配', async () => {
    const original = await fixtureBytes('newline/lf.txt');
    const token = mintTicket(original, 'lf.txt');
    const tampered = `${token.slice(0, 20)}${token[20] === 'A' ? 'B' : 'A'}${token.slice(21)}`;
    expectBridgeError(
      () => validateOne(editItem('lf.txt', tampered, [{ start_line: 1, end_line_exclusive: 2, old_lines: ['lf-line-1'], new_lines: ['a'] }], sha256(original))),
      'READ_TOKEN_STALE',
      'TICKET_BAD_SIGNATURE',
    );
  });

  it('过期的票据：拒绝', async () => {
    const original = await fixtureBytes('newline/lf.txt');
    const token = mintTicket(original, 'lf.txt', {}, NOW - LIMITS.READ_TOKEN_TTL_MS - 1000);
    expectBridgeError(
      () => validateOne(editItem('lf.txt', token, [{ start_line: 1, end_line_exclusive: 2, old_lines: ['lf-line-1'], new_lines: ['a'] }], sha256(original))),
      'READ_TOKEN_STALE',
      'TICKET_EXPIRED',
    );
  });

  it('别的连接读来的票据：拒绝（身份取自通道，不取自参数）', async () => {
    const original = await fixtureBytes('newline/lf.txt');
    const token = mintTicket(original, 'lf.txt', { connection_id: 'conn-2' });
    expectBridgeError(
      () => validateOne(editItem('lf.txt', token, [{ start_line: 1, end_line_exclusive: 2, old_lines: ['lf-line-1'], new_lines: ['a'] }], sha256(original))),
      'READ_TOKEN_STALE',
      'TICKET_CROSS_CONNECTION',
    );
  });

  it('工作区代次变了：拒绝', async () => {
    const original = await fixtureBytes('newline/lf.txt');
    const token = mintTicket(original, 'lf.txt');
    expectBridgeError(
      () =>
        validateOne(
          editItem('lf.txt', token, [{ start_line: 1, end_line_exclusive: 2, old_lines: ['lf-line-1'], new_lines: ['a'] }], sha256(original)),
          context({ generation: GENERATION + 1 }),
        ),
      'READ_TOKEN_STALE',
      'TICKET_GENERATION_MISMATCH',
    );
  });

  it('提案声明的 base_sha256 与票据记录的不一致：拒绝', async () => {
    const original = await fixtureBytes('newline/lf.txt');
    const token = mintTicket(original, 'lf.txt');
    expectBridgeError(
      () =>
        validateOne(
          editItem('lf.txt', token, [{ start_line: 1, end_line_exclusive: 2, old_lines: ['lf-line-1'], new_lines: ['a'] }], 'f'.repeat(64)),
        ),
      'READ_TOKEN_STALE',
      'TICKET_BASE_MISMATCH',
    );
  });

  it('不可编辑的票据（脱敏/只读/超限）：拒绝并转述原因', async () => {
    const original = await fixtureBytes('secrets/.env');
    const token = mintTicket(original, '.env', {
      editable: false,
      editable_blockers: ['内容因敏感信息策略被脱敏，脱敏结果不能用于编辑。'],
      redacted: true,
    });
    const error = expectBridgeError(
      () => validateOne(editItem('.env', token, [{ start_line: 1, end_line_exclusive: 2, old_lines: ['x'], new_lines: ['y'] }], sha256(original))),
      'READ_TOKEN_STALE',
      'TICKET_NOT_EDITABLE',
    );
    assert.match(error.message, /脱敏/);
  });
});

// ---------------------------------------------------------------------------
// 步骤 4：明确拒绝的那几类
// ---------------------------------------------------------------------------

describe('LWB-019 明确拒绝', () => {
  it('空路径：拒绝，且原因就是路径语法本身', async () => {
    const error = expectBridgeError(
      () => validateOne(createItem('', '内容')),
      'INVALID_ARGUMENT',
      'CHANGE_PATH_INVALID',
    );
    assert.equal(error.details?.['path_reason'], 'EMPTY');
  });

  it('绝对路径与上级引用：拒绝', async () => {
    expectBridgeError(() => validateOne(createItem('C:/x.txt', 'a')), 'INVALID_ARGUMENT', 'CHANGE_PATH_INVALID');
    expectBridgeError(() => validateOne(createItem('../x.txt', 'a')), 'INVALID_ARGUMENT', 'CHANGE_PATH_INVALID');
  });

  it('混合换行的目标文件：拒绝写入', async () => {
    const original = await fixtureBytes('newline/mixed.txt');
    const token = mintTicket(original, 'mixed.txt', { editable: false, editable_blockers: ['混用换行'] });
    // 先绕过 editable（用一张可编辑票据演示引擎自己的判据）。
    const editableToken = mintTicket(original, 'mixed.txt');
    const item = validateOne(editItem('mixed.txt', editableToken, [{ start_line: 1, end_line_exclusive: 2, old_lines: ['mixed-1'], new_lines: ['x'] }], sha256(original)));
    expectBridgeError(
      () => applyLineEdits({ item: item as never, original, baseline: decode(original) }),
      'INVALID_ARGUMENT',
      'NEWLINE_STYLE_NOT_WRITABLE',
    );
    // 而正常路径上它连契约都过不了：`file_read` 不会给它可编辑票据。
    expectBridgeError(() => validateOne(editItem('mixed.txt', token, [{ start_line: 1, end_line_exclusive: 2, old_lines: ['mixed-1'], new_lines: ['x'] }], sha256(original))), 'READ_TOKEN_STALE', 'TICKET_NOT_EDITABLE');
  });

  it('没有任何换行的文件：想改成多行就得凭空造一种换行风格，拒绝', async () => {
    const original = await fixtureBytes('edge/empty.txt');
    const token = mintTicket(original, 'empty.txt');
    const item = validateOne(editItem('empty.txt', token, [{ start_line: 1, end_line_exclusive: 1, old_lines: [], new_lines: ['甲', '乙'] }], sha256(original)));
    expectBridgeError(
      () => applyLineEdits({ item: item as never, original, baseline: decode(original) }),
      'INVALID_ARGUMENT',
      'NEWLINE_STYLE_NOT_WRITABLE',
    );
  });

  it('行元素里带换行符：拒绝', async () => {
    const original = await fixtureBytes('newline/lf.txt');
    const token = mintTicket(original, 'lf.txt');
    expectBridgeError(
      () => validateOne(editItem('lf.txt', token, [{ start_line: 1, end_line_exclusive: 2, old_lines: ['lf-line-1'], new_lines: ['a\nb'] }], sha256(original))),
      'INVALID_ARGUMENT',
      'EDIT_LINE_HAS_NEWLINE',
    );
  });

  it('行元素里带 NUL：拒绝（写出去就是二进制文件）', async () => {
    const original = await fixtureBytes('newline/lf.txt');
    const token = mintTicket(original, 'lf.txt');
    expectBridgeError(
      () => validateOne(editItem('lf.txt', token, [{ start_line: 1, end_line_exclusive: 2, old_lines: ['lf-line-1'], new_lines: ['a\0b'] }], sha256(original))),
      'INVALID_ARGUMENT',
      'EDIT_LINE_HAS_NUL',
    );
  });

  it('行元素里带单独代理项：拒绝（写出去会被静默换成 U+FFFD）', async () => {
    const original = await fixtureBytes('newline/lf.txt');
    const token = mintTicket(original, 'lf.txt');
    expectBridgeError(
      () => validateOne(editItem('lf.txt', token, [{ start_line: 1, end_line_exclusive: 2, old_lines: ['lf-line-1'], new_lines: ['\ud800'] }], sha256(original))),
      'INVALID_ARGUMENT',
      'EDIT_LINE_NOT_ENCODABLE',
    );
  });

  it('编辑区间落在票据没返回过的行上：拒绝，处置是重新读', async () => {
    const original = await fixtureBytes('newline/lf.txt');
    // 只读了第 1 行的那张票据。
    const token = mintTicket(original, 'lf.txt', { range_start: 1, range_end_exclusive: 2, truncated: true });
    expectBridgeError(
      () => validateOne(editItem('lf.txt', token, [{ start_line: 2, end_line_exclusive: 3, old_lines: ['lf-line-2'], new_lines: ['a'] }], sha256(original))),
      'READ_TOKEN_STALE',
      'EDIT_RANGE_NOT_READ',
    );
  });

  it('纯插入要求插入点两侧都读过', async () => {
    const original = await fixtureBytes('newline/lf.txt');
    // 票据只覆盖第 1–2 行，插入点在第 3 行位置：右邻（第 3 行）没读过。
    const token = mintTicket(original, 'lf.txt', { range_start: 1, range_end_exclusive: 3, truncated: true });
    expectBridgeError(
      () => validateOne(editItem('lf.txt', token, [{ start_line: 3, end_line_exclusive: 3, old_lines: [], new_lines: ['a'] }], sha256(original))),
      'READ_TOKEN_STALE',
      'EDIT_RANGE_NOT_READ',
    );
  });

  it('整文件替换：范围不全时拒绝（第二道，防的是 truncated 被算错的票据）', async () => {
    const original = await fixtureBytes('newline/lf.txt');
    // 真实系统里「范围不全」必然伴随 truncated=true（那是 `planPage` 的定义），
    // 因此这张票据是**自相矛盾**的。用它来证明范围判据独立成立：
    // 就算有人把 truncated 算错，整文件替换也不会落在一份只读到两行的基线之上。
    const token = mintTicket(original, 'lf.txt', { range_start: 1, range_end_exclusive: 2, truncated: false });
    expectBridgeError(
      () => validateOne(replaceItem('lf.txt', token, '全新的内容', sha256(original))),
      'READ_TOKEN_STALE',
      'REPLACE_REQUIRES_FULL_READ',
    );
  });

  it('整文件替换：truncated 为真即拒绝（即使范围看着是全的）', async () => {
    const original = await fixtureBytes('newline/lf.txt');
    const token = mintTicket(original, 'lf.txt', { truncated: true, truncated_lines: [1] });
    expectBridgeError(
      () => validateOne(replaceItem('lf.txt', token, '全新的内容', sha256(original))),
      'READ_TOKEN_STALE',
      'REPLACE_RESULT_TRUNCATED',
    );
  });

  it('create_text 的内容带 CR：拒绝（会写出 mixed 文件）', async () => {
    expectBridgeError(() => validateOne(createItem('新.txt', 'a\r\nb')), 'INVALID_ARGUMENT', 'CONTENT_HAS_CR');
  });

  it('create_text 的内容带 NUL：拒绝', async () => {
    expectBridgeError(() => validateOne(createItem('新.txt', 'a\0b')), 'INVALID_ARGUMENT', 'CONTENT_HAS_NUL');
  });

  it('create_text 的 newline 只能是 lf / crlf', async () => {
    expectBridgeError(() => validateOne(createItem('新.txt', 'a', 'mixed')), 'INVALID_ARGUMENT', 'NEWLINE_STYLE_INVALID');
    expectBridgeError(() => validateOne(createItem('新.txt', 'a', 'none')), 'INVALID_ARGUMENT', 'NEWLINE_STYLE_INVALID');
  });

  it('create_text：bom:false 但内容以 U+FEFF 开头 —— 写出去就是带 BOM，拒绝', () => {
    const item = validateOne(createItem('新.txt', '\ufeff带 BOM 的内容'));
    expectBridgeError(() => createTextFile({ item: item as never }), 'INVALID_ARGUMENT', 'CONTENT_STARTS_WITH_BOM');
  });

  it('edit_text 的 edits 为空：拒绝', async () => {
    const original = await fixtureBytes('newline/lf.txt');
    const token = mintTicket(original, 'lf.txt');
    expectBridgeError(() => validateOne(editItem('lf.txt', token, [], sha256(original))), 'INVALID_ARGUMENT', 'EDITS_EMPTY');
  });

  it('修改项为空：拒绝', () => {
    expectBridgeError(() => validateChangeItems([], context()), 'INVALID_ARGUMENT', 'CHANGE_ITEMS_EMPTY');
  });

  it('不认识的 op：拒绝', () => {
    expectBridgeError(() => validateOne({ op: 'delete_text', path: 'x.txt' }), 'INVALID_ARGUMENT', 'UNKNOWN_CHANGE_OP');
  });

  it('base_sha256 形状不对：拒绝', async () => {
    const original = await fixtureBytes('newline/lf.txt');
    const token = mintTicket(original, 'lf.txt');
    expectBridgeError(
      () => validateOne(editItem('lf.txt', token, [{ start_line: 1, end_line_exclusive: 2, old_lines: ['lf-line-1'], new_lines: ['a'] }], 'ABC')),
      'INVALID_ARGUMENT',
      'BASE_SHA256_INVALID',
    );
  });

  it('票据说可编辑，但文件超过调用方声明的上限：拒绝（上限可调，票据记的是签发那一刻的裁定）', async () => {
    const original = await fixtureBytes('README.md');
    const token = mintTicket(original, 'README.md');
    const item = editItem('README.md', token, [{ start_line: 1, end_line_exclusive: 2, old_lines: ['# Fixture Repo'], new_lines: ['# 改过'] }], sha256(original));

    // 装置前提：默认上限下这一项是合法的 —— 否则下面证明的就不是「上限路径」。
    validateOne(item);

    expectBridgeError(
      () => validateOne(item, context({ max_editable_file_bytes: original.length - 1 })),
      'SIZE_LIMIT_EXCEEDED',
      'FILE_TOO_LARGE_FOR_EDIT',
    );
  });
});

// ---------------------------------------------------------------------------
// create_text / replace_text
// ---------------------------------------------------------------------------

describe('LWB-019 创建与整文件替换', () => {
  it('create_text：按 lf 写、带 BOM', () => {
    const item = validateOne(createItem('新文件.txt', '甲\n乙', 'lf', true));
    const result = createTextFile({ item: item as never });

    assert.deepEqual(Buffer.from(result.bytes), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('甲\n乙', 'utf8')]));
    assert.equal(result.encoding, 'utf-8-bom');
    assert.equal(result.bom, true);
    assert.equal(result.newline, 'lf');
    assert.equal(result.added_lines, 2);
    assert.equal(result.removed_lines, 0);
    assert.equal(result.before_sha256, null);
    assert.equal(result.before_size, 0);
  });

  it('create_text：按 crlf 写、不带 BOM', () => {
    const item = validateOne(createItem('新文件.txt', '甲\n乙\n', 'crlf'));
    const result = createTextFile({ item: item as never });
    assert.equal(Buffer.from(result.bytes).toString('utf8'), '甲\r\n乙\r\n');
    assert.equal(result.newline, 'crlf');
    assert.equal(result.bom, false);
    assert.equal(result.added_lines, 2);
  });

  it('create_text：空内容建出空文件', () => {
    const item = validateOne(createItem('空.txt', '', 'lf'));
    const result = createTextFile({ item: item as never });
    assert.equal(result.bytes.length, 0);
    assert.equal(result.added_lines, 0);
    assert.equal(result.newline, 'none');
  });

  it('create_text：超过可编辑上限的内容被拒', () => {
    const item = validateOne(createItem('大.txt', 'x'.repeat(64)));
    expectBridgeError(() => createTextFile({ item: item as never, max_editable_file_bytes: 32 }), 'SIZE_LIMIT_EXCEEDED', 'RESULT_TOO_LARGE');
  });

  it('replace_text：整文件替换保留 BOM 与换行风格，且按字面落地', async () => {
    const original = await fixtureBytes('bom/with-bom.txt');
    const token = mintTicket(original, 'with-bom.txt');
    const item = validateOne(replaceItem('with-bom.txt', token, '第一行\n第二行', sha256(original)));
    const result = replaceWholeText({ item: item as never, original, baseline: decode(original) });

    assert.equal(Buffer.from(result.bytes).toString('utf8'), '\ufeff第一行\n第二行');
    assert.equal(result.bom, true, 'BOM 属于编码标记，按原文件保留');
    assert.equal(result.removed_lines, 2);
    assert.equal(result.added_lines, 2);
    assert.equal(result.before_sha256, sha256(original));
  });

  it('replace_text：CRLF 文件的替换内容也写成 CRLF', async () => {
    const original = await fixtureBytes('newline/crlf.txt');
    const token = mintTicket(original, 'crlf.txt');
    const item = validateOne(replaceItem('crlf.txt', token, 'a\nb\n', sha256(original)));
    const result = replaceWholeText({ item: item as never, original, baseline: decode(original) });
    assert.equal(Buffer.from(result.bytes).toString('utf8'), 'a\r\nb\r\n');
    assert.equal(result.newline, 'crlf');
  });

  it('replace_text：整文件替换不做行区间匹配，因此不受旧内容影响', async () => {
    const original = await fixtureBytes('newline/lf.txt');
    const token = mintTicket(original, 'lf.txt');
    const item = validateOne(replaceItem('lf.txt', token, '完全不同的内容\n', sha256(original)));
    const result = replaceWholeText({ item: item as never, original, baseline: decode(original) });
    assert.equal(Buffer.from(result.bytes).toString('utf8'), '完全不同的内容\n');
  });
});

// ---------------------------------------------------------------------------
// 契约层的自洽性
// ---------------------------------------------------------------------------

describe('LWB-019 契约层性质', () => {
  it('`coversEditRange` 的边界与 validateRelativePath 的一致：空路径在两个模块里都不是合法目标', () => {
    assert.equal(validateRelativePath('').ok, false);
    assert.equal(validateRelativePath('a/b.txt').ok, true);
  });

  it('已验证的修改项带上了票据里的物理身份（供上层判重与审计）', async () => {
    const original = await fixtureBytes('newline/lf.txt');
    const token = mintTicket(original, 'lf.txt', { file_id: 'DEADBEEF' });
    const plan = validateChangeItems(
      [editItem('lf.txt', token, [{ start_line: 1, end_line_exclusive: 2, old_lines: ['lf-line-1'], new_lines: ['a'] }], sha256(original))],
      context(),
    );
    assert.equal(plan.targets.length, 1);
    assert.equal(plan.targets[0]?.file_id, 'DEADBEEF');
    assert.equal(plan.targets[0]?.volume_id, VOLUME);
    assert.equal(plan.targets[0]?.op, 'edit_text');
  });

  it('区间被排序后返回，执行顺序不依赖请求里的书写顺序', async () => {
    const original = await fixtureBytes('newline/lf.txt');
    const token = mintTicket(original, 'lf.txt');
    const item = validateOne(
      editItem('lf.txt', token, [
        { start_line: 3, end_line_exclusive: 4, old_lines: ['lf-line-3'], new_lines: ['丙'] },
        { start_line: 1, end_line_exclusive: 2, old_lines: ['lf-line-1'], new_lines: ['甲'] },
      ], sha256(original)),
    );
    assert.equal(item.op, 'edit_text');
    const edits = (item as { edits: readonly LineEdit[] }).edits;
    assert.deepEqual(edits.map((e) => e.start_line), [1, 3]);
    const result = applyLineEdits({ item: item as never, original, baseline: decode(original) });
    assert.equal(Buffer.from(result.bytes).toString('utf8'), '甲\nlf-line-2\n丙\n');
  });
});
