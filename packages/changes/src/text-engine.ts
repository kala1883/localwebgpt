/**
 * 逐字节文本引擎（LWB-019 步骤 2、3）。
 *
 * ## 它的全部工作只有一句话：**没有被动过的字节，一个都不重新编码**
 *
 * 这里最容易走错的一步，是先 `decode` 成串、改一改、再 `encode` 回去 ——
 * 逻辑上「一样」，字节上却依赖一个**没人验证过**的前提：严格 UTF-8 的
 * 解码-编码往返是恒等的。这个前提今天成立，但它成立的理由（分页、BOM、
 * 代理项、将来的规范化开关）全在本文件之外，任何一个变化都会让它静默失效，
 * 而失效的表现是「用户的行末、BOM、某些码位在保存后被悄悄改写」。
 *
 * 所以本文件的输出**按原文件的字节切片拼出来**（`body.subarray`）：
 * 未触及的区域是同一批字节本身，不是「重新编码后应该相等」的两份。
 * 新增的行才走编码，用哪个风格由目标文件决定。
 *
 * 拼完之后**重新识别一次**产物（`inspectBytes`），并核对 BOM、行数、换行
 * 风格与预期一致。这一步把上面那句话从设计意图变成**每次执行都会验的断言**：
 * 切片算错一个字节，行数或换行风格当场对不上。
 *
 * ## 这里不做的事
 *
 * 不格式化、不转码、不补末尾换行、不删多余空行、不改 BOM。
 * 一份 `crlf` 文件写回来还是 `crlf`；带 BOM 的写回来还带 BOM；
 * 末尾没有换行的写回来仍然没有（除整文件替换 —— 见 `replaceWholeText`）。
 */

import { createHash } from 'node:crypto';
import { BridgeError, LIMITS } from '@lwb/contracts';
import type { ChangeOp, FileEncoding, NewlineStyle } from '@lwb/contracts';
import { inspectBytes, lineText } from '@lwb/files';
import type { DecodedText } from '@lwb/files';

import type { ValidatedCreateText, ValidatedEditText, ValidatedReplaceText } from './edit-contract.ts';

/** UTF-8 BOM 的三个字节。`inspectBytes` 只在这三个字节**原样**开头时才置 `bom`。 */
const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

type Style = '\n' | '\r\n';

/**
 * 一次编辑算出来的**最终字节**与前后事实。
 *
 * 字段与 `ChangeFilePreview` 对齐（`encoding` / `newline` / `bom` 描述的是
 * **写入后**的文件），另加一组 `before_*`：修改集要落盘旧内容快照、
 * 恢复时要能回答「原来是什么」，这些事实在引擎里是现成的，不必让上层
 * 再识别一遍（再识别一遍就意味着两处可能给出不同答案）。
 */
export interface AppliedTextChange {
  readonly path: string;
  readonly op: ChangeOp;
  readonly bytes: Uint8Array;
  readonly before_sha256: string | null;
  readonly before_size: number;
  readonly before_encoding: FileEncoding;
  readonly before_newline: NewlineStyle;
  readonly before_bom: boolean;
  readonly after_sha256: string;
  readonly after_size: number;
  readonly encoding: FileEncoding;
  readonly newline: NewlineStyle;
  readonly bom: boolean;
  readonly added_lines: number;
  readonly removed_lines: number;
}

function internal(reason: string, message: string, extra: Readonly<Record<string, string | number | boolean | null>> = {}): BridgeError {
  return new BridgeError('INTERNAL_ERROR', message, { reason, ...extra });
}

function invalid(reason: string, message: string, extra: Readonly<Record<string, string | number | boolean | null>> = {}): BridgeError {
  return new BridgeError('INVALID_ARGUMENT', message, { reason, ...extra });
}

function conflict(reason: string, message: string, extra: Readonly<Record<string, string | number | boolean | null>> = {}): BridgeError {
  return new BridgeError('FILE_VERSION_CONFLICT', message, { reason, ...extra });
}

// ---------------------------------------------------------------------------
// 基线自检
// ---------------------------------------------------------------------------

/**
 * 核对「交到手上的字节」就是票据记住的那一份。
 *
 * 这一步**必须**在引擎里而不是只在上层：`base_sha256` 是模型写进提案的、
 * 可与票据不符的字段（契约层已经把两者比过一次），而这里比的是**实际字节**
 * 与票据里的 `raw_bytes_sha256`。两者之间隔着一个「上层读文件」的动作 ——
 * 读到的可能是另一份内容（读取与提案之间被改动、或读错了文件）。
 * 让引擎自己持有这条断言，上层就算忘了比对也不会写出错误的结果。
 */
function assertBaselineBytes(original: Uint8Array, expectedSha256: string): void {
  const actual = createHash('sha256').update(original).digest('hex');
  if (actual !== expectedSha256) {
    throw conflict(
      'BASELINE_HASH_MISMATCH',
      '磁盘上的字节与读取票据记录的版本不一致（文件在读取之后被改动过）；本次修改未应用，请重新读取。',
      { expected_sha256: expectedSha256, actual_sha256: actual },
    );
  }
}

/**
 * 按行算出**字节偏移**表：`offsets[i]` 是第 `i+1` 行的起始字节偏移，
 * 最后一项是正文末尾。长度 `total_lines + 1`。
 *
 * 这里逐行 `Buffer.byteLength` 而不是「用另一个解码器再解一遍」：
 * 它与 `decode.ts` 的行索引同源（同一份 `starts` / `ends` / `terminators`），
 * 因此不会出现「两个解码器对同一份字节给出不同行边界」这种最难查的分歧。
 * 代价是 O(文件字节) 的编码计算，一次编辑付得起。
 */
function lineByteOffsets(decoded: DecodedText): readonly number[] {
  const { text, lines } = decoded;
  const offsets: number[] = [0];
  let at = 0;
  for (let n = 1; n <= lines.total_lines; n += 1) {
    const start = lines.starts[n - 1];
    const end = lines.ends[n - 1];
    const terminator = lines.terminators[n - 1];
    if (start === undefined || end === undefined || terminator === undefined) {
      throw internal('LINE_INDEX_INCONSISTENT', `行索引在第 ${n} 行不完整；拒绝写入。`, { line: n });
    }
    at += Buffer.byteLength(text.slice(start, end), 'utf8') + Buffer.byteLength(terminator, 'utf8');
    offsets.push(at);
  }
  return offsets;
}

/**
 * 断言行偏移表加起来正好是正文长度。
 *
 * 它验的是「按行重新编码」与「原字节」逐字节一致 —— 也就是那件本文件
 * 拒绝拿来做前提的事。前提变成断言之后，一处不合就是一条明确的
 * `BYTE_LAYOUT_MISMATCH`，而不是一份被悄悄改写的文件。
 */
function assertByteLayout(offsets: readonly number[], bodyLength: number, path: string): void {
  const total = offsets[offsets.length - 1];
  if (total !== bodyLength) {
    throw internal(
      'BYTE_LAYOUT_MISMATCH',
      `按行重算的字节数（${total}）与原文件正文（${bodyLength}）不一致；为避免写出被改写的字节，本次修改被拒绝。`,
      { path, recomputed: total ?? -1, actual: bodyLength },
    );
  }
}

function bodyOf(original: Uint8Array, bom: boolean): Uint8Array {
  return bom ? original.subarray(3) : original;
}

// ---------------------------------------------------------------------------
// 换行风格
// ---------------------------------------------------------------------------

/**
 * 目标文件可写的换行风格。
 *
 * `mixed` 一律拒绝（步骤 4 的「混合换行写入」）：这种文件里两种换行混在一起，
 * 「保留风格」这句话没有唯一答案，写回必然**静默**改写一部分行的字节。
 *
 * `none` 返回 `null`，它表示「这份文件里没有任何换行符」，不是一个风格。
 * 调用方在 `null` 时的义务是：产出的字节里也不得有换行符。
 */
function writableStyleOf(newline: NewlineStyle, op: string): Style | null {
  if (newline === 'mixed') {
    throw invalid(
      'NEWLINE_STYLE_NOT_WRITABLE',
      `${op} 的目标文件混用多种换行风格（或含单独 CR）；写回会静默改变其它行的字节，因此拒绝写入。`,
    );
  }
  if (newline === 'crlf') return '\r\n';
  if (newline === 'lf') return '\n';
  return null;
}

// ---------------------------------------------------------------------------
// edit_text
// ---------------------------------------------------------------------------

export interface ApplyLineEditsInput {
  readonly item: ValidatedEditText;
  /** 磁盘上的整份原始字节（含 BOM）。 */
  readonly original: Uint8Array;
  /** 同一份字节的识别结果（`inspectBytes(original)`）。 */
  readonly baseline: DecodedText;
  readonly max_editable_file_bytes?: number;
}

/**
 * 应用行区间补丁，返回**完整的新字节**。
 *
 * 换行规则的完整表述（三种情形，都在下面的 `regionFor` 里）：
 *
 *  1. 替换段**后面还有行**，或文件本身以换行结尾 → 每一行新内容都带一个换行；
 *  2. 替换段**一直延伸到文件末尾**且原文件末尾没有换行 → 新内容的**最后一行
 *     不带换行**（保持「末尾无换行」这个属性）；
 *  3. 在「末尾无换行」的文件**末尾插入** → 先给上一行补一个换行，插入的行里
 *     最后一行不带换行。
 *
 * 第 3 条是最容易被漏掉的一条：`a` 之后插入一行，写成 `a` + `b`
 * 会得到 `ab`（一行，内容错了），正确的字节是 `a\nb`。
 */
export function applyLineEdits(input: ApplyLineEditsInput): AppliedTextChange {
  const { item, original, baseline } = input;
  const maxBytes = input.max_editable_file_bytes ?? LIMITS.MAX_EDITABLE_FILE_BYTES;

  assertBaselineBytes(original, item.ticket.raw_bytes_sha256);

  const body = bodyOf(original, baseline.bom);
  const offsets = lineByteOffsets(baseline);
  assertByteLayout(offsets, body.length, item.path);

  const style = writableStyleOf(baseline.newline, 'edit_text');
  const totalLines = baseline.lines.total_lines;
  const hasTrailingNewline = totalLines > 0 && baseline.lines.terminators[totalLines - 1] !== '';

  const pieces: Buffer[] = [];
  let cursor = 0;
  let added = 0;
  let removed = 0;

  for (const edit of item.edits) {
    const from = offsets[edit.start_line - 1];
    const to = offsets[edit.end_line_exclusive - 1];
    if (from === undefined || to === undefined || from < cursor || to < from) {
      throw internal('EDIT_OFFSET_OUT_OF_RANGE', `编辑区间 [${edit.start_line}, ${edit.end_line_exclusive}) 的字节偏移不可用；拒绝写入。`, {
        start_line: edit.start_line,
        end_line_exclusive: edit.end_line_exclusive,
      });
    }

    // 逐行核对旧内容必须是**精确**匹配（方案 §6.3：不做模糊匹配）。
    // 诊断里只给行号，不回显任何一方的内容 —— 那段内容属于用户文件。
    for (let i = 0; i < edit.old_lines.length; i += 1) {
      const line = edit.start_line + i;
      if (lineText(baseline.text, baseline.lines, line) !== edit.old_lines[i]) {
        throw conflict(
          'EDIT_BASELINE_MISMATCH',
          `第 ${line} 行的内容与提案声明的不一致；本次修改未应用，请重新读取该文件。`,
          { path: item.path, line },
        );
      }
    }

    pieces.push(Buffer.from(body.subarray(cursor, from)));
    pieces.push(regionFor(edit, { style, totalLines, hasTrailingNewline, followingExists: edit.end_line_exclusive <= totalLines, path: item.path }));
    cursor = to;
    added += edit.new_lines.length;
    removed += edit.end_line_exclusive - edit.start_line;
  }
  pieces.push(Buffer.from(body.subarray(cursor)));

  const afterBody = Buffer.concat(pieces);
  const bytes = baseline.bom ? Buffer.concat([UTF8_BOM, afterBody]) : afterBody;

  const after = inspectBytes(bytes);
  if (after.kind !== 'text') {
    // 走到这里说明我们**写出了一个自己都不认为是文本的东西** —— 只有可能是
    // 编码环节出了错（行元素已由契约层挡住 NUL 与单独代理项）。
    throw internal('PRODUCED_NOT_TEXT', `生成的字节被判为${after.kind === 'binary' ? '二进制' : '不可解码文本'}；本次修改被拒绝。`, {
      path: item.path,
      reason: after.reason,
    });
  }
  const expectedLines = totalLines - removed + added;
  if (after.lines.total_lines !== expectedLines) {
    throw internal('PRODUCED_LINE_COUNT_MISMATCH', `生成的字节有 ${after.lines.total_lines} 行，按补丁应为 ${expectedLines} 行；本次修改被拒绝。`, {
      path: item.path,
      expected: expectedLines,
      actual: after.lines.total_lines,
    });
  }
  if (after.bom !== baseline.bom) {
    throw internal('PRODUCED_BOM_MISMATCH', '生成的字节的 BOM 与原文件不一致；本次修改被拒绝。', { path: item.path });
  }
  assertNewlinePreserved(after.newline, style, after.lines.total_lines, 'edit_text', item.path);

  return finish(item.op, item.path, bytes, after, added, removed, maxBytes, factsOf(original, baseline));
}

/**
 * 算出一次替换要写进文件的那段字节。
 *
 * `style === null`（原文件里没有任何换行符）时，只有**不产生换行符**的编辑
 * 才被允许，否则我们就会替用户选择一种它从未有过的换行风格 —— 那是一次
 * 静默的风格变更，而且它会让一份 `none` 文件变成 `lf`（或 `crlf`）。
 */
function regionFor(
  edit: { readonly start_line: number; readonly end_line_exclusive: number; readonly new_lines: readonly string[] },
  facts: { readonly style: Style | null; readonly totalLines: number; readonly hasTrailingNewline: boolean; readonly followingExists: boolean; readonly path: string },
): Buffer {
  const { style, totalLines, hasTrailingNewline, followingExists, path } = facts;
  const isEmpty = edit.start_line === edit.end_line_exclusive;
  // 在「末尾无换行」的文件末尾插入：上一行的换行要由这次插入补上。
  const appendsAfterLastLine = isEmpty && !followingExists && totalLines > 0;

  if (style === null) {
    const needsTerminator =
      edit.new_lines.length > 1 ||
      (edit.new_lines.length > 0 && (followingExists || (appendsAfterLastLine && !hasTrailingNewline)));
    if (needsTerminator) {
      throw invalid(
        'NEWLINE_STYLE_NOT_WRITABLE',
        '目标文件里没有任何换行符（无法从它推断写入风格），而本次编辑会产生换行；请改用 create_text 或先由本地决定风格。',
        { path, start_line: edit.start_line },
      );
    }
    return Buffer.from(edit.new_lines.join(''), 'utf8');
  }

  if (appendsAfterLastLine && !hasTrailingNewline && edit.new_lines.length > 0) {
    return Buffer.from(style + edit.new_lines.join(style), 'utf8');
  }
  if (followingExists || hasTrailingNewline) {
    return Buffer.from(
      edit.new_lines.map((line) => line + style).join(''),
      'utf8',
    );
  }
  return Buffer.from(edit.new_lines.join(style), 'utf8');
}

// ---------------------------------------------------------------------------
// replace_text
// ---------------------------------------------------------------------------

export interface ReplaceWholeTextInput {
  readonly item: ValidatedReplaceText;
  readonly original: Uint8Array;
  readonly baseline: DecodedText;
  readonly max_editable_file_bytes?: number;
}

/**
 * 整文件替换（步骤 3）。
 *
 * 与行区间编辑的三处刻意不同：
 *
 *  - **内容按字面落地**：`content` 里的 `\n` 按目标文件的风格写出，
 *    **不补也不删末尾换行**。行区间编辑会保留「末尾有没有换行」这个属性，
 *    是因为它只动几行；而整文件替换里，末尾有没有换行就是 `content`
 *    自己表达的事 —— 替用户补一个换行，等于改写它明确给出的内容。
 *  - **BOM 仍按原文件保留**：BOM 不是内容，是编码标记。
 *  - **可写性判据与编辑同源**（`writableStyleOf`）：`mixed` 拒绝，
 *    `none` 只允许不含 `\n` 的内容。
 */
export function replaceWholeText(input: ReplaceWholeTextInput): AppliedTextChange {
  const { item, original, baseline } = input;
  const maxBytes = input.max_editable_file_bytes ?? LIMITS.MAX_EDITABLE_FILE_BYTES;

  assertBaselineBytes(original, item.ticket.raw_bytes_sha256);

  const style = writableStyleOf(baseline.newline, 'replace_text');
  if (style === null && item.content.includes('\n')) {
    throw invalid(
      'NEWLINE_STYLE_NOT_WRITABLE',
      '目标文件里没有任何换行符（无法从它推断写入风格），而替换内容含换行；请改用 create_text 或先由本地决定风格。',
      { path: item.path },
    );
  }

  const text = style === null ? item.content : item.content.split('\n').join(style);
  const body = Buffer.from(text, 'utf8');
  const bytes = baseline.bom ? Buffer.concat([UTF8_BOM, body]) : body;

  const after = inspectBytes(bytes);
  if (after.kind !== 'text') {
    throw internal('PRODUCED_NOT_TEXT', '生成的字节不是可解码文本；本次替换被拒绝。', { path: item.path, reason: after.reason });
  }
  if (after.bom !== baseline.bom) {
    throw internal('PRODUCED_BOM_MISMATCH', '生成的字节的 BOM 与原文件不一致；本次替换被拒绝。', { path: item.path });
  }
  assertNewlinePreserved(after.newline, style, after.lines.total_lines, 'replace_text', item.path);

  const beforeLines = baseline.lines.total_lines;
  return finish(item.op, item.path, bytes, after, after.lines.total_lines, beforeLines, maxBytes, factsOf(original, baseline));
}

// ---------------------------------------------------------------------------
// create_text
// ---------------------------------------------------------------------------

export interface CreateTextFileInput {
  readonly item: ValidatedCreateText;
  readonly max_editable_file_bytes?: number;
}

/**
 * 生成一个新文件的字节。**这里不检查文件是否存在** —— 那要靠
 * 执行期的 `CREATE_NEW`（LWB-022 起的执行器），本函数是纯函数、不碰磁盘。
 *
 * `content` 的行按 `newline` 拼接，`bom` 决定是否写入 UTF-8 BOM。
 * 写完**重新识别一次**，核对 BOM、换行与内容长度都对得上：
 * 同时它顺带挡住一处很隐蔽的输入 —— `bom: false` 但 `content` 本身以
 * U+FEFF 开头，那样的字节在磁盘上**就是**带 BOM 的，与用户看到的不符。
 */
export function createTextFile(input: CreateTextFileInput): AppliedTextChange {
  const { item } = input;
  const maxBytes = input.max_editable_file_bytes ?? LIMITS.MAX_EDITABLE_FILE_BYTES;

  const style: Style = item.newline === 'crlf' ? '\r\n' : '\n';
  const text = item.content.split('\n').join(style);
  const body = Buffer.from(text, 'utf8');
  const bytes = item.bom ? Buffer.concat([UTF8_BOM, body]) : body;

  const after = inspectBytes(bytes);
  if (after.kind !== 'text') {
    throw internal('PRODUCED_NOT_TEXT', '生成的新文件内容不是可解码文本；本次创建被拒绝。', { path: item.path, reason: after.reason });
  }
  if (after.bom !== item.bom) {
    throw invalid(
      'CONTENT_STARTS_WITH_BOM',
      item.bom
        ? '声明了 bom: true，但生成的内容前三个字节不是 UTF-8 BOM。'
        : '内容本身以 U+FEFF 开头，写到磁盘上**就是**带 BOM 的文件；请显式声明 bom: true，或去掉该字符。',
      { path: item.path },
    );
  }
  assertNewlinePreserved(after.newline, style, after.lines.total_lines, 'create_text', item.path);
  if (after.text !== text) {
    // 今天这条不可能失败（严格 UTF-8 解码是本文件的输入前提）。它写在这里
    // 是为了把「产物的正文必须逐字符等于我打算写的那些字符」记成一个不变量：
    // 将来谁给 `inspectBytes` 加上规范化、BOM 处理或别的改写，它会当场失败，
    // 而不是让新文件的内容悄悄变掉。
    throw internal('PRODUCED_TEXT_MISMATCH', '生成的新文件正文与待写入的文本不一致；本次创建被拒绝。', { path: item.path });
  }

  const before: BaselineFacts = {
    sha256: null,
    size: 0,
    encoding: 'unknown',
    newline: 'none',
    bom: false,
  };
  return finish(item.op, item.path, bytes, after, after.lines.total_lines, 0, maxBytes, before);
}

// ---------------------------------------------------------------------------
// 共同收尾
// ---------------------------------------------------------------------------

interface BaselineFacts {
  readonly sha256: string | null;
  readonly size: number;
  readonly encoding: FileEncoding;
  readonly newline: NewlineStyle;
  readonly bom: boolean;
}

/** 修改前的事实。哈希从**实际字节**算，不从票据的字段抄 —— 两者已由断言等同。 */
function factsOf(original: Uint8Array, baseline: DecodedText): BaselineFacts {
  return {
    sha256: createHash('sha256').update(original).digest('hex'),
    size: original.length,
    encoding: baseline.encoding,
    newline: baseline.newline,
    bom: baseline.bom,
  };
}

/**
 * 换行风格必须与「按规则应该写出的风格」一致。
 *
 * 允许 `none`：一份只剩一行且末尾没有换行的文件，本来就观察不到换行风格。
 * 允许的情形是严格受限的 —— 只有 `total_lines <= 1` 时才可能观察不到换行，
 * 因此这条断言仍然能抓住「本该是 crlf 却写成了 lf」这类错误。
 */
function assertNewlinePreserved(actual: NewlineStyle, style: Style | null, totalLines: number, op: string, path: string): void {
  if (style === null) {
    if (actual !== 'none') {
      throw internal('PRODUCED_NEWLINE_MISMATCH', `${op} 目标文件没有换行风格，产物却报告 ${actual}；本次修改被拒绝。`, { path });
    }
    return;
  }
  if (actual === 'none' && totalLines <= 1) return;
  const expected: NewlineStyle = style === '\r\n' ? 'crlf' : 'lf';
  if (actual !== expected) {
    throw internal('PRODUCED_NEWLINE_MISMATCH', `${op} 产物的换行风格是 ${actual}，按规则应为 ${expected}；本次修改被拒绝。`, {
      path,
      expected,
      actual,
    });
  }
}

function finish(
  op: ChangeOp,
  path: string,
  bytes: Uint8Array,
  after: DecodedText,
  addedLines: number,
  removedLines: number,
  maxBytes: number,
  before: BaselineFacts,
): AppliedTextChange {
  if (bytes.length > maxBytes) {
    throw new BridgeError('SIZE_LIMIT_EXCEEDED', `结果有 ${bytes.length} 字节，超过可编辑上限 ${maxBytes} 字节。`, {
      reason: 'RESULT_TOO_LARGE',
      path,
      size: bytes.length,
      limit: maxBytes,
    });
  }

  return Object.freeze({
    path,
    op,
    bytes,
    before_sha256: before.sha256,
    before_size: before.size,
    before_encoding: before.encoding,
    before_newline: before.newline,
    before_bom: before.bom,
    after_sha256: createHash('sha256').update(bytes).digest('hex'),
    after_size: bytes.length,
    encoding: after.encoding,
    newline: after.newline,
    bom: after.bom,
    added_lines: addedLines,
    removed_lines: removedLines,
  });
}
