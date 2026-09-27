/**
 * 已保存字节的**事实识别**：编码、BOM、换行风格、二进制（LWB-013 步骤 1）。
 *
 * ## 这个文件只做「报告事实」，不做「尽力解释」
 *
 * 三类字节在这里有明确的不同归宿：
 *
 *  - UTF-8（含带 BOM）→ 文本，交给上层分行与分页；
 *  - NUL 字节 → 二进制，`BINARY_UNSUPPORTED`；
 *  - 解不成 UTF-8 又不含 NUL → `ENCODING_UNSUPPORTED`（可能是 GBK / Latin-1…）。
 *
 * 后两类**一律拒绝**，不做替代字符解码。理由是方向：用 `U+FFFD` 顶掉识别不了的
 * 字节，会得到一份「看起来读到了、实际上不是那些字节」的正文 —— 模型据此提出
 * 的修改会落在一个它从未见过的内容上。拒绝的代价是用户看到一条明确的
 * 「这个文件本版本读不了」，而这条代价是**看得见**的。
 *
 * ## 与 `tests/fixtures/build-fixtures.ts` 的关系
 *
 * 夹具生成器里有一份独立的换行/行数计算（它是测试装置，不是产品实现）。
 * 两侧对**同一批夹具**给出同样的结论，这件事由
 * `tests/unit/files-read.test.ts` 逐夹具比对 manifest 守住 ——
 * 而不是靠「两边都这么写所以应该一样」。
 */

import { TextDecoder } from 'node:util';
import type { FileEncoding, NewlineStyle } from '@lwb/contracts';

/** 逐行的偏移索引。行号一律 **1 起始**，区间一律**左闭右开**。 */
export interface LineIndex {
  readonly total_lines: number;
  /** 第 n 行的起始偏移（UTF-16 码元），长度 = total_lines。 */
  readonly starts: readonly number[];
  /** 第 n 行的结束偏移（**不含**行终止符），长度 = total_lines。 */
  readonly ends: readonly number[];
  /**
   * 第 n 行之后的行终止符：`'\n'` / `'\r\n'` / `''`。
   * 只有最后一行可能是 `''`（文件没有末尾换行，或文件为空）。
   */
  readonly terminators: readonly string[];
}

export interface DecodedText {
  readonly kind: 'text';
  /** 已剥离 UTF-8 BOM 的正文。**没有做任何其它改写。** */
  readonly text: string;
  readonly encoding: FileEncoding;
  readonly bom: boolean;
  readonly newline: NewlineStyle;
  readonly lines: LineIndex;
}

/** 拒绝的两种原因。分开是因为它们对用户意味着完全不同的事。 */
export type ByteRejectionReason =
  /** 含 NUL 字节，或 BOM 直接指明是非 UTF-8 编码的文本。 */
  | 'NUL_BYTE'
  | 'UTF16_BOM'
  | 'UTF32_BOM'
  /** 不含 NUL，但字节序列不是合法 UTF-8（可能是 GBK / Latin-1 / 被截断的文本）。 */
  | 'INVALID_UTF8';

export interface ByteRejection {
  readonly kind: 'binary' | 'undecodable';
  readonly reason: ByteRejectionReason;
  /** 可以呈现给用户的说明。**不含**任何文件正文。 */
  readonly detail: string;
}

export type ByteInspection = DecodedText | ByteRejection;

const UTF8_BOM = [0xef, 0xbb, 0xbf] as const;

/**
 * 解码并索引一份字节。
 *
 * 顺序不能调换，每一步都在为下一步去除一类误判：
 *  1. BOM 判定（UTF-32 → UTF-16 → UTF-8）—— 必须在 NUL 检查之前，
 *     因为 UTF-16/32 的 BOM 里就含 NUL，先查 NUL 会把它们报成「二进制」；
 *  2. NUL 检查 —— 二进制的最可靠标志（`git`、`file` 等工具同样以它为准）；
 *  3. 严格 UTF-8 解码 —— 失败即拒绝，不用替代字符兜底。
 */
export function inspectBytes(bytes: Uint8Array): ByteInspection {
  const head = (n: number): string =>
    Array.from(bytes.subarray(0, n), (b) => b.toString(16).padStart(2, '0')).join(' ');

  if (startsWith(bytes, [0xff, 0xfe, 0x00, 0x00]) || startsWith(bytes, [0x00, 0x00, 0xfe, 0xff])) {
    return {
      kind: 'undecodable',
      reason: 'UTF32_BOM',
      detail: `文件以 UTF-32 BOM 开头（${head(4)}）；V1 只读取 UTF-8 文本，不做转码。`,
    };
  }
  if (startsWith(bytes, [0xff, 0xfe]) || startsWith(bytes, [0xfe, 0xff])) {
    return {
      kind: 'undecodable',
      reason: 'UTF16_BOM',
      detail: `文件以 UTF-16 BOM 开头（${head(2)}）；V1 只读取 UTF-8 文本，不做转码。`,
    };
  }

  const bom = startsWith(bytes, UTF8_BOM);
  const body = bom ? bytes.subarray(3) : bytes;

  const nul = body.indexOf(0);
  if (nul >= 0) {
    return {
      kind: 'binary',
      reason: 'NUL_BYTE',
      detail: `文件第 ${nul + (bom ? 3 : 0) + 1} 个字节是 NUL（0x00），判定为二进制；不在 V1 可读范围内。`,
    };
  }

  // `ignoreBOM: true` 是必须的：UTF-8 BOM 已经由本函数按 `bom` 字段剥掉了，
  // 若再让解码器剥一次，一份**正文自身**以 U+FEFF 开头（而 BOM 已单独处理）的
  // 文件就会被静默吃掉一个字符，而 sha256 仍然对得上 —— 一个不会报错的错。
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  let text: string;
  try {
    text = decoder.decode(body);
  } catch {
    return {
      kind: 'undecodable',
      reason: 'INVALID_UTF8',
      detail: '字节序列不是合法 UTF-8，且不含 NUL；V1 不猜测编码，也不做有损解码。',
    };
  }

  const lines = indexLines(text);
  return {
    kind: 'text',
    text,
    encoding: bom ? 'utf-8-bom' : 'utf-8',
    bom,
    newline: detectNewline(text, lines),
    lines,
  };
}

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  if (bytes.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i += 1) {
    if (bytes[i] !== prefix[i]) return false;
  }
  return true;
}

/**
 * 建立行索引。
 *
 * ## 「末尾换行不产生额外一行」是这里唯一的约定
 *
 * `'a\n'` 是 1 行而不是 2 行，`''` 是 0 行。这与夹具生成器、与
 * `git diff` 的直觉、与编辑器的行号一致；反过来（末尾换行多算一行空行）
 * 会让「第 2 行」在一份两行文件里指向一个磁盘上不存在的位置。
 *
 * ## 单独 CR **不作为**行分隔符
 *
 * 只按 `\n`（及其前面的 `\r`）断行。单独 CR 留在行**内容**里，
 * 并被 `detectNewline` 判成 `mixed`，于是文件不可编辑 —— 而不是被当成
 * 行分隔符，让「行号」与编辑器看到的东西悄悄分叉。
 */
export function indexLines(text: string): LineIndex {
  const starts: number[] = [];
  const ends: number[] = [];
  const terminators: string[] = [];

  if (text.length === 0) {
    return { total_lines: 0, starts, ends, terminators };
  }

  let pos = 0;
  for (;;) {
    const nl = text.indexOf('\n', pos);
    if (nl === -1) {
      starts.push(pos);
      ends.push(text.length);
      terminators.push('');
      break;
    }
    const hasCr = nl > pos && text.charCodeAt(nl - 1) === 0x0d;
    const end = hasCr ? nl - 1 : nl;
    starts.push(pos);
    ends.push(end);
    terminators.push(hasCr ? '\r\n' : '\n');
    pos = nl + 1;
    // 末尾换行不产生额外一行（见上文）。少了这一句，`'a\n'` 会被数成
    // 两行：第二行是 `[len, len)` 那个空区间，磁盘上并不存在 ——
    // 而它是**可编辑**的，于是一段编辑区间可以延伸到文件末尾之外。
    // 夹具的 manifest 用的是与这里独立的一份行数计算，这个差异当初
    // 就是被它抓出来的（`tests/unit/files-read.test.ts`）。
    if (pos === text.length) break;
  }

  return { total_lines: starts.length, starts, ends, terminators };
}

/**
 * 换行风格。
 *
 * 单独 CR 归入 `mixed` 而不是 `lf`：把它读成 `lf`，写回时就会**静默**把
 * 那些 CR 换成 LF —— 一份被判为「可编辑」的文件在保存后多出一堆字节差异，
 * 而模型以为自己做的是行级小改。归入 `mixed` 的后果是文件不可编辑，
 * 代价可见、方向保守。
 */
export function detectNewline(text: string, lines: LineIndex): NewlineStyle {
  if (lines.total_lines === 0) return 'none';

  let crlf = 0;
  let lf = 0;
  for (const terminator of lines.terminators) {
    if (terminator === '\r\n') crlf += 1;
    else if (terminator === '\n') lf += 1;
  }
  const crTotal = countChar(text, 0x0d);
  const loneCr = crTotal - crlf;

  if (loneCr > 0) return 'mixed';
  if (crlf > 0 && lf > 0) return 'mixed';
  if (crlf > 0) return 'crlf';
  if (lf > 0) return 'lf';
  return 'none';
}

function countChar(text: string, code: number): number {
  let n = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === code) n += 1;
  }
  return n;
}

/** 取第 n 行（1 起始）的正文，不含行终止符。越界返回 `''`。 */
export function lineText(text: string, lines: LineIndex, n: number): string {
  const start = lines.starts[n - 1];
  const end = lines.ends[n - 1];
  if (start === undefined || end === undefined) return '';
  return text.slice(start, end);
}

/** 取第 n 行（1 起始）的终止符。越界或末行无换行时返回 `''`。 */
export function lineTerminator(lines: LineIndex, n: number): string {
  return lines.terminators[n - 1] ?? '';
}

export function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/**
 * 把 `text` 截到不超过 `maxBytes` 个 UTF-8 字节，**不切开任何码位**。
 *
 * 用 `Uint8Array` 的实际编码长度推进，而不是按码元估算：一个汉字是
 * 3 字节、一个 emoji（代理对）是 4 字节，按 `length` 估算会得到一个
 * 比上限大得多的结果 —— 而那个结果看起来「差不多对」。
 */
export function truncateToBytes(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  if (utf8Bytes(text) <= maxBytes) return text;

  let used = 0;
  let cut = 0;
  for (let i = 0; i < text.length; ) {
    const cp = text.codePointAt(i);
    if (cp === undefined) break;
    const width = cp > 0xffff ? 2 : 1;
    const size = utf8Bytes(text.slice(i, i + width));
    if (used + size > maxBytes) break;
    used += size;
    i += width;
    cut = i;
  }
  return text.slice(0, cut);
}
