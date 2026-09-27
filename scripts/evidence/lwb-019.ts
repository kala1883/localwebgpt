/**
 * LWB-019 可复现证据采集：精确文本编辑契约与逐字节文本引擎。
 *
 * 三条验收标准在这里各有一段，**全部跑在真实夹具字节上**
 * （`tests/fixtures/generated/testrepo/`，由夹具生成器写出，不是内存里拼的）：
 *
 *  1. 「重复文本不会导致选错位置；旧内容不一致直接冲突」—— 用一份**真的有两行
 *     完全相同空行**的夹具（`文档/设计说明.md` 的第 2 行与第 5 行）：改第 5 行
 *     时第 2 行必须一个字节都不动；拿第 5 行的文本去改第 2 行必须冲突，
 *     而不是「就近选一个看起来一样的」。
 *  2. 「未触及的字节与原文件完全一致」—— 先对整个可编辑语料跑一遍**恒等编辑**
 *     （把第 1 行替换成它自己）：产物必须与原文件逐字节相同、SHA-256 相同。
 *     再一次编辑都不改，就没有任何一个字节该被重新编码 —— 这是这句话最强的
 *     表述。然后再对 CRLF / BOM / 无末尾换行这三类边界真改一次，用**脚本自己
 *     扫出来的**行字节区间（不是引擎的累计偏移算法）去核对区间外的字节。
 *  3. 「无法偷偷在同一文件添加第二次隐含操作」—— 路径层（原样、换大小写）与
 *     物理层（**真硬链接**，身份取自护栏的 `statVolume`）各验一遍。
 *
 * 另外两件本任务交付物必须自己回答的事：
 *
 *  - **步骤 4 的四类明确拒绝**（未知编码、混合换行写入、空路径、冲突区间、
 *    重复物理文件）逐条跑出来，并打印真实的错误码与理由标签。
 *  - **票据是唯一的版本来源**：伪造、过期、跨连接、跨代次、跨路径、跨基线，
 *    六种「不是这个版本」都在**碰字节之前**被拒绝。
 *
 * 用法：node --import tsx scripts/evidence/lwb-019.ts
 * 退出码：全部通过 0；任一项失败 1。
 *
 * 本文件证明不了的事（见末尾「未执行项」）：**没有任何一次写入发生在真实
 * 工作区上**。全部证据采自夹具测试根与一个临时沙箱，因为 G2 未通过
 * （LWB-002 BLOCKED），而 P3 的门禁是「可以在契约冻结的前提下继续实现，
 * 但不得在真实仓库上联调」（见 `docs/evidence/g2-read.md`）。
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { BridgeError, LIMITS, TOOL_INPUT_SCHEMAS } from '@lwb/contracts';
import { createReadTicketAuthority, inspectBytes, lineText } from '@lwb/files';
import { classifyFile } from '@lwb/policy';
import type { DecodedText, ReadTicketFacts } from '@lwb/files';
import { applyLineEdits, createTextFile, replaceWholeText, validateChangeItems } from '@lwb/changes';
import type { ChangeValidationContext, ValidatedChangeItem, ValidatedEditText } from '@lwb/changes';
import { PowerShellWinfsBackend, isWinfsError } from '@lwb/winfs';

import { TESTREPO_DIR, ensureFixtures, loadManifest, repoPath } from '../../tests/fixtures/index.ts';
import type { FixtureFileEntry, FixtureManifest } from '../../tests/fixtures/index.ts';

// ---------------------------------------------------------------------------
// 脚手架
// ---------------------------------------------------------------------------

let failures = 0;
let passes = 0;

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    passes += 1;
    console.log(`PASS ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    failures += 1;
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function note(name: string, detail: string): void {
  console.log(`NOTE ${name} — ${detail}`);
}

function section(title: string): void {
  console.log(`\n== ${title} ==`);
}

function skip(name: string, why: string): void {
  console.log(`NOT_RUN ${name} — ${why}`);
}

/** 跑一段；炸了就把真实原因报成 FAIL，而不是让整个脚本消失。 */
async function guarded(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (cause) {
    const error = cause as { code?: string; message?: string; details?: unknown; stack?: string };
    check(`${name} 段跑完`, false, `${error.code ?? '(无错误码)'}：${error.message ?? String(cause)}`);
    if (error.details !== undefined) console.log(`      details=${JSON.stringify(error.details)}`);
    if (error.stack) console.log(`      ${error.stack.split('\n').slice(1, 4).join('\n      ')}`);
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

/** 把抛出的错误压成一行：码 + 理由标签 +（脱敏后的）详情。 */
function errLine(cause: unknown): string {
  if (cause instanceof BridgeError) {
    return `${cause.code}/${String(cause.details?.['reason'] ?? '(无 reason)')}`;
  }
  return `(不是 BridgeError) ${String(cause)}`;
}

/** 断言某次调用抛出的正是 `码/理由`，返回详情供打印。 */
function expectReason(fn: () => unknown, code: string, reason: string, label: string): boolean {
  try {
    fn();
  } catch (cause) {
    const ok = cause instanceof BridgeError && cause.code === code && cause.details?.['reason'] === reason;
    check(label, ok, ok ? `${code}/${reason}` : `期望 ${code}/${reason}，实际 ${errLine(cause)}`);
    return ok;
  }
  check(label, false, `期望 ${code}/${reason}，实际没有抛错`);
  return false;
}

// ---------------------------------------------------------------------------
// 装置：真实夹具 + 真实票据权威
// ---------------------------------------------------------------------------

const NOW = Date.UTC(2026, 8, 25, 12, 0, 0);
const CONNECTION = 'conn-evidence-019';
const WORKSPACE = 'ws-evidence-019';
const GENERATION = 4;
const KEY = 'lwb-evidence-019-key-0123456789abcdef0123456789';

const authority = createReadTicketAuthority({ key: KEY });

/** 磁盘上的真身份。**取自护栏**，不自己算一份。 */
interface DiskIdentity {
  volume_id: string;
  file_id: string;
  link_count: number;
}

async function diskIdentity(backend: PowerShellWinfsBackend, absPath: string): Promise<DiskIdentity> {
  const info = await backend.statVolume({ path: absPath });
  if (isWinfsError(info)) throw new Error(`statVolume 失败：${info.code} ${info.message}`);
  return { volume_id: info.volume_id, file_id: info.file_id, link_count: info.link_count };
}

function decode(bytes: Uint8Array): DecodedText {
  const decoded = inspectBytes(bytes);
  if (decoded.kind !== 'text') throw new Error(`装置错误：这不是文本字节（${decoded.reason}）`);
  return decoded;
}

/**
 * 铸一张**真实**票据。负向用例也走这里，只改身份或时间 ——
 * 「伪造票据」是拿真票据改一个字符，不是自己拼一个字符串。
 */
function mint(
  bytes: Uint8Array,
  relPath: string,
  identity: DiskIdentity,
  over: Partial<ReadTicketFacts> = {},
  mintedAt: number = NOW,
): string {
  const decoded = decode(bytes);
  const facts: ReadTicketFacts = {
    connection_id: CONNECTION,
    workspace_id: WORKSPACE,
    generation: GENERATION,
    canonical_path: relPath,
    volume_id: identity.volume_id,
    file_id: identity.file_id,
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

function context(over: Partial<ChangeValidationContext> = {}): ChangeValidationContext {
  return {
    connection_id: CONNECTION,
    workspace_id: WORKSPACE,
    generation: GENERATION,
    now: NOW,
    authority,
    ...over,
  };
}

function editItem(relPath: string, token: string, edits: readonly unknown[], sha: string): Record<string, unknown> {
  return { op: 'edit_text', path: relPath, base_sha256: sha, read_token: token, edits };
}

function replaceItem(relPath: string, token: string, content: string, sha: string): Record<string, unknown> {
  return { op: 'replace_text', path: relPath, base_sha256: sha, read_token: token, content };
}

function createItem(relPath: string, content: string, newline = 'lf', bom = false): Record<string, unknown> {
  return { op: 'create_text', path: relPath, content, newline, bom };
}

/** 一条 edit 的简写：整行替换。 */
function lineEdit(n: number, oldLine: string, newLines: readonly string[]): Record<string, unknown> {
  return { start_line: n, end_line_exclusive: n + 1, old_lines: [oldLine], new_lines: newLines };
}

function plan(items: readonly unknown[], ctx: ChangeValidationContext = context()): readonly ValidatedChangeItem[] {
  return validateChangeItems(items, ctx).items;
}

function firstEdited(items: readonly unknown[], ctx: ChangeValidationContext = context()): ValidatedEditText {
  const item = plan(items, ctx)[0];
  if (item === undefined || item.op !== 'edit_text') throw new Error('装置错误：期望一条 edit_text');
  return item;
}

/**
 * **独立**算出第 `n` 行（1 起始）在原始字节里的区间：`indexOf` 逐行扫描。
 *
 * 区间**含该行的行终止符**（末行没有终止符时到文件末尾为止）。含终止符是
 * 刻意的：空行在「只算内容」的口径下区间是零长度，于是「这个区间没被动过」
 * 就成了一句空话 —— 而空行正是本任务反复要验的那种行。
 *
 * 刻意不复用引擎的「累计 `Buffer.byteLength`」算法 —— 那正是被测对象，
 * 用它来算期望值等于用同一个错误同时污染两边。这里连换行风格都由调用方
 * 从夹具清单传入，不从字节里探测。
 */
function regionOf(bytes: Uint8Array, nl: '\n' | '\r\n', n: number): { start: number; end: number } {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let start = 0;
  for (let line = 1; line < n; line += 1) {
    const at = buf.indexOf(nl, start, 'utf8');
    if (at < 0) throw new Error(`装置错误：原始字节里找不到第 ${line} 行的换行`);
    start = at + nl.length;
  }
  const at = buf.indexOf(nl, start, 'utf8');
  return at < 0 ? { start, end: buf.length } : { start, end: at + nl.length };
}

/** 区间之外的字节必须逐字节相同：左边比到 `start`，右边从 `end` 之后比起。 */
function outsideRegionIdentical(
  before: Uint8Array,
  after: Uint8Array,
  region: { start: number; end: number },
  delta: number,
): { ok: boolean; detail: string } {
  const left = bytesEqual(before.subarray(0, region.start), after.subarray(0, region.start));
  const beforeTail = before.subarray(region.end);
  const afterTailStart = region.end + delta;
  const right =
    after.length >= afterTailStart && bytesEqual(beforeTail, after.subarray(afterTailStart, afterTailStart + beforeTail.length));
  return {
    ok: left && right && after.length === before.length + delta,
    detail:
      `左前缀 ${region.start} 字节${left ? '相同' : '不同'}；` +
      `右后缀 ${before.length - region.end} 字节${right ? '相同' : '不同'}；` +
      `长度 ${before.length}→${after.length}（差 ${delta}）`,
  };
}

// ---------------------------------------------------------------------------
// 语料
// ---------------------------------------------------------------------------

interface Corpus {
  manifest: FixtureManifest;
  /** 可编辑且换行风格可写的夹具（恒等编辑的适用范围）。 */
  editable: readonly FixtureFileEntry[];
  /** 换行风格不可写（mixed / none）的可编辑夹具：能读，但写不进去。 */
  unwritable: readonly FixtureFileEntry[];
  /** 策略硬拒绝的夹具：连读都不该读到，谈不上编辑。 */
  denied: readonly string[];
  bytes: Map<string, Buffer>;
  identity: Map<string, DiskIdentity>;
}

/**
 * 把「哪些文件可以拿来跑恒等编辑」这件事交给**策略层**裁定。
 *
 * 这里有一个真实的坑，值得写下来：夹具清单里的 `editable` 是**夹具生成器的
 * 意图标记**，不是策略判定。`config/.env.example` 在清单里是 `editable: true`，
 * 而 `HD-ENV` 规则连读都硬拒绝它（`.env` / `.env.*` / `*.env`，方案 §4.3
 * 明令不做 `.env.example` 豁免）。拿清单字段当策略结论，就会把一个根本读不到
 * 的文件算进「可编辑语料」—— 于是那一条证据是假的。
 */
async function loadCorpus(backend: PowerShellWinfsBackend): Promise<Corpus> {
  ensureFixtures();
  const manifest = await loadManifest();
  const bytes = new Map<string, Buffer>();
  const identity = new Map<string, DiskIdentity>();
  for (const entry of manifest.files) {
    const abs = repoPath(entry.relPath);
    bytes.set(entry.relPath, await readFile(abs));
    identity.set(entry.relPath, await diskIdentity(backend, abs));
  }
  const denied = manifest.files.filter((e) => classifyFile(e.relPath).kind === 'hard_deny').map((e) => e.relPath);
  const allowed = manifest.files.filter((entry) => entry.editable && classifyFile(entry.relPath).kind !== 'hard_deny');
  const writable = allowed.filter((entry) => entry.newline === 'lf' || entry.newline === 'crlf');
  const unwritable = allowed.filter((entry) => entry.newline === 'mixed' || entry.newline === 'none');
  return { manifest, editable: writable, unwritable, denied, bytes, identity };
}

const WINDOWS_ONLY = process.platform === 'win32';

// ===========================================================================
// 验收 (b)：未触及的字节与原文件完全一致
// ===========================================================================

async function byteFidelity(corpus: Corpus): Promise<void> {
  section('验收 (b)：未触及的字节与原文件完全一致');

  // --- b1：整个可编辑语料的恒等编辑 ---
  //
  // 把第 1 行替换成它自己。一次编辑都没有改变内容，所以产物里**任何一个
  // 字节**都不该变 —— 这是「没有偷偷重新编码 / 重新格式化 / 转码」这句话
  // 最强的形式，而且不依赖任何关于「哪些字节算未触及」的判断。
  {
    let checked = 0;
    const mismatched: string[] = [];
    for (const entry of corpus.editable) {
      const original = corpus.bytes.get(entry.relPath);
      const id = corpus.identity.get(entry.relPath);
      if (original === undefined || id === undefined) throw new Error('装置错误：语料缺字节或身份');
      const baseline = decode(original);
      const token = mint(original, entry.relPath, id);
      const line = lineText(baseline.text, baseline.lines, 1);
      const item = firstEdited([editItem(entry.relPath, token, [lineEdit(1, line, [line])], entry.sha256)]);
      const result = applyLineEdits({ item, original, baseline });
      if (!bytesEqual(original, result.bytes) || result.after_sha256 !== entry.sha256) {
        mismatched.push(entry.relPath);
      }
      checked += 1;
      note(
        `b1 ${entry.relPath}`,
        `${entry.newline}${entry.hasBom ? '+BOM' : ''} ${original.length}B → ` +
          `${result.bytes.length}B ${result.after_sha256 === entry.sha256 ? 'sha 不变' : '**sha 变了**'}`,
      );
    }
    // 下界写死成 10 而不是 `corpus.editable.length`：语料是自己筛出来的，
    // 拿它当上界的话「筛空了」也会通过。10 = 21 个夹具里，去掉 9 个不可编辑 +
    // 1 个换行不可写（`edge/bom-only.txt`）+ 1 个策略硬拒绝（`config/.env.example`）。
    check(
      'b1 全部可编辑夹具上「把一行替换成它自己」产物与原文件逐字节相同',
      mismatched.length === 0 && checked === corpus.editable.length && checked >= 10,
      `检查了 ${checked} 个文件（期望 ${corpus.editable.length}，下界 10），不一致 ${mismatched.length} 个` +
        (mismatched.length > 0 ? `：${mismatched.join('、')}` : ''),
    );
  }

  // --- b2：CRLF 文件真改一行 ---
  {
    const rel = 'newline/crlf.txt';
    const original = corpus.bytes.get(rel) as Buffer;
    const id = corpus.identity.get(rel) as DiskIdentity;
    const baseline = decode(original);
    const token = mint(original, rel, id);
    const item = firstEdited([
      editItem(rel, token, [lineEdit(2, 'crlf-line-2', ['CRLF 第二行改过'])], sha256(original)),
    ]);
    const result = applyLineEdits({ item, original, baseline });
    const region = regionOf(original, '\r\n', 2);
    const outside = outsideRegionIdentical(original, result.bytes, region, Buffer.byteLength('CRLF 第二行改过', 'utf8') - Buffer.byteLength('crlf-line-2', 'utf8'));
    const after = decode(result.bytes);
    note('b2 改的是第 2 行', `原第 2 行字节区间 [${region.start}, ${region.end})；${outside.detail}`);
    check('b2 CRLF 文件：区间外的字节逐字节相同', outside.ok, outside.detail);
    check('b2 CRLF 文件：写回仍是 CRLF，行数不变', after.newline === 'crlf' && after.lines.total_lines === baseline.lines.total_lines, `newline=${after.newline} lines=${baseline.lines.total_lines}→${after.lines.total_lines}`);
  }

  // --- b3：BOM 文件 ---
  {
    const rel = 'bom/with-bom.txt';
    const original = corpus.bytes.get(rel) as Buffer;
    const id = corpus.identity.get(rel) as DiskIdentity;
    const baseline = decode(original);
    const token = mint(original, rel, id);
    const second = lineText(baseline.text, baseline.lines, 2);
    const item = firstEdited([editItem(rel, token, [lineEdit(2, second, ['第二行改过。'])], sha256(original))]);
    const result = applyLineEdits({ item, original, baseline });
    const head = Buffer.from(result.bytes.subarray(0, 3));
    note('b3 BOM 文件', `头部三字节 ${JSON.stringify([...head])}，编码 ${result.before_encoding}→${result.encoding}`);
    check('b3 BOM 保留（EF BB BF 三个字节原样在头部）', head.equals(Buffer.from([0xef, 0xbb, 0xbf])), JSON.stringify([...head]));
    check('b3 BOM 之外的字节：第 1 行（含其换行）逐字节相同', bytesEqual(original.subarray(3, regionOf(original, '\n', 2).start), result.bytes.subarray(3, regionOf(original, '\n', 2).start)), '');
  }

  // --- b4：无末尾换行的文件 ---
  {
    const rel = 'newline/no-trailing-newline.txt';
    const original = corpus.bytes.get(rel) as Buffer;
    const id = corpus.identity.get(rel) as DiskIdentity;
    const baseline = decode(original);
    const token = mint(original, rel, id);
    const item = firstEdited([
      editItem(rel, token, [lineEdit(2, 'no-trailing-2', ['末尾行也改过'])], sha256(original)),
    ]);
    const result = applyLineEdits({ item, original, baseline });
    const tail = result.bytes.subarray(result.bytes.length - 2);
    note('b4 无末尾换行', `产物末两字节 ${JSON.stringify([...tail])}（0x0a 表示多出了一个换行）`);
    check('b4 替换最后一行后，文件末尾仍然没有换行', !tail.includes(0x0a), `末两字节 ${JSON.stringify([...tail])}`);
  }

  // --- b5：在「末尾无换行」的文件末尾插入 ---
  //
  // 最容易漏的一条：`a` 之后插入 `b`，写成 `a`+`b` 会得到 `ab` —— 一行，
  // 内容错了。正确字节是 `a\nb`。
  {
    const rel = 'newline/no-trailing-newline.txt';
    const original = corpus.bytes.get(rel) as Buffer;
    const id = corpus.identity.get(rel) as DiskIdentity;
    const baseline = decode(original);
    const token = mint(original, rel, id);
    const at = baseline.lines.total_lines + 1;
    const item = firstEdited([
      editItem(rel, token, [{ start_line: at, end_line_exclusive: at, old_lines: [], new_lines: ['追加的一行'] }], sha256(original)),
    ]);
    const result = applyLineEdits({ item, original, baseline });
    const expected = Buffer.concat([original, Buffer.from('\n追加的一行', 'utf8')]);
    note('b5 末尾插入', `第 ${at} 行插入后 ${original.length}B → ${result.bytes.length}B`);
    check('b5 末尾插入：字节等于「原文件 + 一个换行 + 新行」，且末尾仍无换行', bytesEqual(result.bytes, expected), `期望 ${expected.length}B，实际 ${result.bytes.length}B`);
    check('b5 末尾插入：行数恰好 +1', decode(result.bytes).lines.total_lines === baseline.lines.total_lines + 1, `${baseline.lines.total_lines}→${decode(result.bytes).lines.total_lines}`);
  }
}

// ===========================================================================
// 验收 (a)：重复文本不会导致选错位置；旧内容不一致直接冲突
// ===========================================================================

async function positionalCorrectness(corpus: Corpus): Promise<void> {
  section('验收 (a)：重复文本不会导致选错位置；旧内容不一致直接冲突');

  const rel = '文档/设计说明.md';
  const original = corpus.bytes.get(rel) as Buffer;
  const id = corpus.identity.get(rel) as DiskIdentity;
  const baseline = decode(original);

  // 装置前提：第 2 行与第 5 行都是空行。这条不成立的话，下面证明的就不是
  // 「重复文本」这件事了 —— 所以先把它打印出来，而不是假定。
  const line2 = lineText(baseline.text, baseline.lines, 2);
  const line5 = lineText(baseline.text, baseline.lines, 5);
  note('a 装置前提', `${rel} 第 2 行=${JSON.stringify(line2)}，第 5 行=${JSON.stringify(line5)}（两行文本完全相同）`);
  check('a 装置前提：目标文件里确实有两行完全相同的空行', line2 === '' && line5 === '', `第2行=${JSON.stringify(line2)} 第5行=${JSON.stringify(line5)}`);

  // --- a1：改第 5 行，第 2 行一个字节都不能动 ---
  {
    const token = mint(original, rel, id);
    const item = firstEdited([editItem(rel, token, [lineEdit(5, line5, ['改过的第 5 行'])], sha256(original))]);
    const result = applyLineEdits({ item, original, baseline });
    const r2 = regionOf(original, '\n', 2);
    const r5 = regionOf(original, '\n', 5);
    const after = decode(result.bytes);
    const delta = Buffer.byteLength('改过的第 5 行', 'utf8');
    note('a1 区间', `第 2 行字节 [${r2.start},${r2.end})，第 5 行字节 [${r5.start},${r5.end})（含行终止符）`);
    check(
      'a1 改第 5 行：第 2 行所在的字节区间与原文逐字节相同',
      bytesEqual(original.subarray(r2.start, r2.end), result.bytes.subarray(r2.start, r2.end)),
      `第 2 行区间 ${r2.start}..${r2.end}（空行 + 换行，1 字节）`,
    );
    // 比「第 2 行没变」更强：**整份文件里变的只有第 5 行那一段**。
    const outside = outsideRegionIdentical(original, result.bytes, r5, delta);
    check('a1 改第 5 行：除第 5 行外，整份文件逐字节相同', outside.ok, outside.detail);
    check(
      'a1 改第 5 行：第 5 行确实变成了新内容，第 2 行仍是空行',
      lineText(after.text, after.lines, 5) === '改过的第 5 行' && lineText(after.text, after.lines, 2) === '',
      `第2行=${JSON.stringify(lineText(after.text, after.lines, 2))} 第5行=${JSON.stringify(lineText(after.text, after.lines, 5))}`,
    );
    // 位置不是「第一个看起来一样的」：改完之后第 5 行还在**第 5 行**，
    // 行数不变，而且第 5 行的起点与原文中第 5 行的起点是同一个偏移。
    check(
      'a1 插入点定位：新内容落在第 5 行而不是第 2 行（行数不变，第 5 行起点偏移不变）',
      after.lines.total_lines === baseline.lines.total_lines && regionOf(result.bytes, '\n', 5).start === r5.start,
      `行数 ${baseline.lines.total_lines}→${after.lines.total_lines}；第 5 行起点 ${r5.start}→${regionOf(result.bytes, '\n', 5).start}`,
    );
  }

  // --- a2：拿第 5 行的文本去改第 2 行 → 冲突而不是「就近匹配」 ---
  //
  // 这一条和 a1 是**不同**的失败模式。a1 防的是「按内容查找」这种实现：
  // 它会在第 2 行命中并改错地方。这里防的是「内容对不上就算了」这种实现：
  // 它会把一次本该拒绝的修改当成没看见。
  {
    const token = mint(original, rel, id);
    const item = firstEdited([editItem(rel, token, [lineEdit(2, '这一行不是空行', ['不该被写进去'])], sha256(original))]);
    expectReason(
      () => applyLineEdits({ item, original, baseline }),
      'FILE_VERSION_CONFLICT',
      'EDIT_BASELINE_MISMATCH',
      'a2 旧内容与第 2 行不符：FILE_VERSION_CONFLICT，且不改任何字节',
    );
  }

  // --- a3：诊断里不出现被编辑文件的内容 ---
  {
    const token = mint(original, rel, id);
    const secretish = '这是第 2 行的真实内容，诊断里不该回显';
    const item = firstEdited([editItem(rel, token, [lineEdit(1, secretish, ['x'])], sha256(original))]);
    try {
      applyLineEdits({ item, original, baseline });
      check('a3 冲突诊断里不含文件内容', false, '竟然没有抛错');
    } catch (cause) {
      const rendered = `${(cause as Error).message} ${JSON.stringify((cause as BridgeError).details ?? {})}`;
      const leaks = [secretish, lineText(baseline.text, baseline.lines, 1), '这是初始提交的内容。'].filter((s) =>
        rendered.includes(s),
      );
      note('a3 冲突诊断原文', rendered);
      check('a3 冲突诊断里不含文件内容（只给行号）', leaks.length === 0, leaks.length === 0 ? '无内容回显' : `泄漏：${leaks.join(' | ')}`);
    }
  }

  // --- a4：磁盘字节与票据记录的版本不一致 ---
  {
    const token = mint(original, rel, id);
    const item = firstEdited([editItem(rel, token, [lineEdit(5, line5, ['改过'])], sha256(original))]);
    const tampered = Buffer.concat([original, Buffer.from('\n有人在我们读完之后追加了一行\n', 'utf8')]);
    expectReason(
      () => applyLineEdits({ item, original: tampered, baseline: decode(tampered) }),
      'FILE_VERSION_CONFLICT',
      'BASELINE_HASH_MISMATCH',
      'a4 读到之后磁盘变了：FILE_VERSION_CONFLICT（不是「按现在的字节硬改」）',
    );
  }
}

// ===========================================================================
// 验收 (c)：无法偷偷在同一文件添加第二次隐含操作
// ===========================================================================

async function noSecondOperation(backend: PowerShellWinfsBackend, corpus: Corpus): Promise<void> {
  section('验收 (c)：无法偷偷在同一文件添加第二次隐含操作');

  const rel = 'newline/lf.txt';
  const original = corpus.bytes.get(rel) as Buffer;
  const id = corpus.identity.get(rel) as DiskIdentity;
  const sha = sha256(original);
  const one: readonly unknown[] = [lineEdit(1, 'lf-line-1', ['甲'])];
  const two: readonly unknown[] = [lineEdit(3, 'lf-line-3', ['乙'])];

  // --- c1：同一条路径两次 ---
  {
    const token = mint(original, rel, id);
    expectReason(
      () => plan([editItem(rel, token, one, sha), editItem(rel, token, two, sha)]),
      'INVALID_ARGUMENT',
      'DUPLICATE_TARGET_PATH',
      'c1 同一路径出现两次：拒绝',
    );
  }

  // --- c2：同一路径换大小写拼写 ---
  {
    const token = mint(original, rel, id);
    const upper = rel.toUpperCase();
    expectReason(
      () => plan([editItem(rel, token, one, sha), editItem(upper, token, two, sha)]),
      'INVALID_ARGUMENT',
      'DUPLICATE_TARGET_PATH',
      `c2 同一路径换大小写拼写（${rel} / ${upper}）：拒绝（NTFS 大小写不敏感）`,
    );
  }

  // --- c3：同一物理文件的两个名字（真硬链接，身份取自护栏）---
  {
    const sandbox = await mkdtemp(path.join(os.tmpdir(), 'lwb-evidence-019-'));
    try {
      const originalPath = path.join(sandbox, 'target.txt');
      const aliasPath = path.join(sandbox, 'alias.txt');
      // 三行，与 `newline/lf.txt` 同形：本用例用的两个区间是第 1 行与第 3 行。
      // 区间越界会先报 `EDIT_RANGE_NOT_READ`（逐项校验在**跨项判重之前**），
      // 那样测到的就不是「重复物理文件」这条判定了。
      const body = '硬链接目标\n第二行\n第三行\n';
      await writeFile(originalPath, body, 'utf8');
      const created = spawnSync(
        'pwsh',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `try { New-Item -ItemType HardLink -Path '${aliasPath}' -Target '${originalPath}' -ErrorAction Stop | Out-Null; 'CREATED' } catch { 'FAILED: ' + $_.Exception.Message }`,
        ],
        { encoding: 'utf8', timeout: 60_000 },
      );
      if (!`${created.stdout ?? ''}${created.stderr ?? ''}`.includes('CREATED')) {
        skip('c3 同一物理文件的两个名字被拒绝', `本会话无法创建硬链接：${`${created.stdout ?? ''}${created.stderr ?? ''}`.trim()}`);
      } else {
        // 用的是**同一个**护栏后端：这里再 new 一个就会多出一个 pwsh 助手子进程，
        // 而它没人 dispose —— 脚本会打印完所有结论之后**永远不退出**。
        // （这不是假想：第一版就是这么写的，日志写满了但进程挂着。）
        const idTarget = await diskIdentity(backend, originalPath);
        const idAlias = await diskIdentity(backend, aliasPath);
        note(
          'c3 真硬链接',
          `${path.basename(originalPath)} 与 ${path.basename(aliasPath)}：` +
            `volume:file = ${idTarget.volume_id}:${idTarget.file_id} / ${idAlias.volume_id}:${idAlias.file_id}，` +
            `link_count=${String(idTarget.link_count)}`,
        );
        check(
          'c3 装置前提：两个名字确实是同一个物理文件（身份相同且 link_count≥2）',
          idTarget.volume_id === idAlias.volume_id && idTarget.file_id === idAlias.file_id && idTarget.link_count >= 2,
          `link_count=${String(idTarget.link_count)}`,
        );
        const bytes = await readFile(originalPath);
        const tokenA = mint(bytes, 'target.txt', idTarget);
        const tokenB = mint(bytes, 'alias.txt', idAlias);
        const editFirst = [lineEdit(1, '硬链接目标', ['甲'])];
        const editThird = [lineEdit(3, '第三行', ['乙'])];
        // 装置前提：两条单独看都合法 —— 否则下面测到的是「某一条本身不合法」。
        note('c3 逐项合法', `两条各自校验：${String(plan([editItem('target.txt', tokenA, editFirst, sha256(bytes))]).length)} / ${String(plan([editItem('alias.txt', tokenB, editThird, sha256(bytes))]).length)} 条通过`);
        expectReason(
          () => plan([editItem('target.txt', tokenA, editFirst, sha256(bytes)), editItem('alias.txt', tokenB, editThird, sha256(bytes))]),
          'INVALID_ARGUMENT',
          'DUPLICATE_TARGET_FILE',
          'c3 同一物理文件的两个名字：靠 volume:file_id 拒绝（路径层看不出来）',
        );
      }
    } finally {
      await rm(sandbox, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  // --- c4：同一文件既 edit_text 又 replace_text ---
  {
    const token = mint(original, rel, id);
    expectReason(
      () => plan([editItem(rel, token, one, sha), replaceItem(rel, token, '整份换掉\n', sha)]),
      'INVALID_ARGUMENT',
      'DUPLICATE_TARGET_PATH',
      'c4 同一文件既 edit_text 又 replace_text：拒绝（换一种 op 不算换一个目标）',
    );
  }

  // --- c5：一张票用在另一个路径上 ---
  //
  // 「同一张票悄悄改第二个文件」是同一种偷袭的另一条路：票据里带着物理身份
  // 与基线哈希，用到别处就该对不上。
  {
    const other = 'newline/crlf.txt';
    const otherBytes = corpus.bytes.get(other) as Buffer;
    const otherId = corpus.identity.get(other) as DiskIdentity;
    const token = mint(original, rel, id);
    expectReason(
      () => plan([editItem(other, token, one, sha256(otherBytes))]),
      'READ_TOKEN_STALE',
      'TICKET_PATH_MISMATCH',
      'c5 拿 A 文件的票去改 B 文件：拒绝',
    );
    const otherToken = mint(otherBytes, other, otherId);
    expectReason(
      () => plan([editItem(other, otherToken, one, sha)]),
      'READ_TOKEN_STALE',
      'TICKET_BASE_MISMATCH',
      'c5 拿 B 文件的票配 A 文件的基线哈希：拒绝',
    );
  }
}

// ===========================================================================
// 步骤 4：四类明确拒绝
// ===========================================================================

async function explicitRejections(corpus: Corpus): Promise<void> {
  section('步骤 4：明确拒绝（未知编码 / 混合换行写入 / 空路径 / 冲突区间 / 重复物理文件）');

  // --- d1：未知编码 ---
  //
  // 「未知编码」在**上游**就被挡住：票据是从一次成功的 `file_read` 来的，
  // 而那次读取不会对无法解码的字节签发票据。因此这里证明的是整条链：
  // 字节过不了识别这一关 → 就没有票据 → 修改项根本构造不出来。
  {
    const undecodable = Buffer.from([0x80, 0x81, 0xfe, 0xff, 0x00, 0x41]);
    const verdict = inspectBytes(undecodable);
    note('d1 无法解码的字节', `识别结果 kind=${verdict.kind}${verdict.kind === 'text' ? '' : ` reason=${verdict.reason}`}`);
    check('d1 无法解码的字节不产生可编辑的读取结果（识别阶段即判定）', verdict.kind !== 'text', `kind=${verdict.kind}`);
    let mintThrew = false;
    try {
      mint(undecodable, 'x.bin', { volume_id: '0'.repeat(8), file_id: '0'.repeat(16), link_count: 1 });
    } catch {
      mintThrew = true;
    }
    check('d1 无法解码的字节造不出读取票据（装置层与出站层同一条判据）', mintThrew, '');
    // 契约层还剩一道：内容里带单独代理项（写出去会被静默换成 U+FFFD）。
    expectReason(
      () => plan([createItem('新文件.txt', '前面\uD800后面')]),
      'INVALID_ARGUMENT',
      'CONTENT_NOT_ENCODABLE',
      'd1 内容含单独代理项：拒绝（否则写出去的字节与提案声明的文本不同）',
    );
  }

  // --- d2：混合换行的写入 ---
  {
    const rel = 'newline/mixed.txt';
    const marked = corpus.manifest.files.find((f) => f.relPath === rel);
    const bytes = corpus.bytes.get(rel) as Buffer;
    const id = corpus.identity.get(rel) as DiskIdentity;
    note('d2 混合换行夹具', `${rel} 在夹具清单里 editable=${String(marked?.editable)} newline=${String(marked?.newline)}`);
    check('d2 装置前提：混合换行文件在夹具清单里本就标记为不可编辑', marked?.editable === false, `editable=${String(marked?.editable)}`);

    // 出站层：票据自己就带 editable:false。
    const honestToken = mint(bytes, rel, id, {
      editable: false,
      editable_blockers: ['文件混用换行风格（CRLF 与 LF 并存），无法在保持原字节的前提下编辑'],
    });
    expectReason(
      () => plan([editItem(rel, honestToken, [lineEdit(1, 'mixed-lf', ['x'])], sha256(bytes))]),
      'READ_TOKEN_STALE',
      'TICKET_NOT_EDITABLE',
      'd2 不可编辑的票据：转述出站层的理由，拒绝',
    );

    // 引擎层：即使有人**谎称**可编辑，写入侧也自己判一次。
    const lyingToken = mint(bytes, rel, id);
    const item = firstEdited([editItem(rel, lyingToken, [lineEdit(1, 'mixed-lf', ['x'])], sha256(bytes))]);
    expectReason(
      () => applyLineEdits({ item, original: bytes, baseline: decode(bytes) }),
      'INVALID_ARGUMENT',
      'NEWLINE_STYLE_NOT_WRITABLE',
      'd2 票据谎称可编辑：引擎层独立判一次，仍然拒绝写混合换行',
    );

    // 不能「顺手把它统一成 LF」：这正是自动格式化，本任务明令禁止。
    expectReason(
      () => plan([createItem('新文件.txt', '第一行\r\n第二行')]),
      'INVALID_ARGUMENT',
      'CONTENT_HAS_CR',
      'd2 新内容里带 CR：拒绝（否则就是自己造出一个混合换行文件）',
    );
  }

  // --- d3：空路径 ---
  {
    const original = corpus.bytes.get('newline/lf.txt') as Buffer;
    const token = mint(original, '', corpus.identity.get('newline/lf.txt') as DiskIdentity);
    const err = (() => {
      try {
        plan([editItem('', token, [lineEdit(1, 'lf-line-1', ['x'])], sha256(original))]);
        return null;
      } catch (cause) {
        return cause as BridgeError;
      }
    })();
    note('d3 空路径', err === null ? '(没有抛错)' : `${err.code}/${String(err.details?.['reason'])} path_reason=${String(err.details?.['path_reason'])}`);
    check(
      'd3 空路径：拒绝，且原因是路径语法本身',
      err?.code === 'INVALID_ARGUMENT' && err.details?.['reason'] === 'CHANGE_PATH_INVALID',
      err === null ? '没有抛错' : `${err.code}/${String(err.details?.['reason'])}`,
    );
    // 副作用（写进偏离项）：单文件工作区因此无法被修改。
    note('d3 副作用', '空路径被拒 ⇒ 单文件工作区（根即文件，相对路径为空）无法提议修改；记入偏离项，不在本任务里另开一套规则');
  }

  // --- d4：冲突区间 ---
  {
    const original = corpus.bytes.get('newline/lf.txt') as Buffer;
    const token = mint(original, 'newline/lf.txt', corpus.identity.get('newline/lf.txt') as DiskIdentity);
    const sha = sha256(original);
    const path = 'newline/lf.txt';
    expectReason(
      () =>
        plan([
          editItem(
            path,
            token,
            [
              { start_line: 1, end_line_exclusive: 3, old_lines: ['lf-line-1', 'lf-line-2'], new_lines: ['合并'] },
              { start_line: 2, end_line_exclusive: 4, old_lines: ['lf-line-2', 'lf-line-3'], new_lines: ['重叠'] },
            ],
            sha,
          ),
        ]),
      'INVALID_ARGUMENT',
      'OVERLAPPING_EDITS',
      'd4 两个区间重叠：拒绝',
    );
    expectReason(
      () =>
        plan([
          editItem(
            path,
            token,
            [
              { start_line: 2, end_line_exclusive: 2, old_lines: [], new_lines: ['甲'] },
              { start_line: 2, end_line_exclusive: 2, old_lines: [], new_lines: ['乙'] },
            ],
            sha,
          ),
        ]),
      'INVALID_ARGUMENT',
      'OVERLAPPING_EDITS',
      'd4 同一插入点写两条插入：拒绝（先后顺序读不出来）',
    );
    // 对照：**首尾相接**（[1,2) 与 [2,3)）不算重叠 —— 两段字节区间不交，
    // 且每段各自带上自己的行终止符，没有「谁负责第 1 行那个换行」的二义。
    // 这条写在这里是因为我一开始以为它该被拒：证据的作用正是把这种
    // 「凭印象的规则」换成实跑出来的规则。
    {
      const item = firstEdited([
        editItem(
          path,
          token,
          [
            { start_line: 1, end_line_exclusive: 2, old_lines: ['lf-line-1'], new_lines: ['甲'] },
            { start_line: 2, end_line_exclusive: 3, old_lines: ['lf-line-2'], new_lines: ['乙'] },
          ],
          sha,
        ),
      ]);
      const result = applyLineEdits({ item, original, baseline: decode(original) });
      check(
        '对照：首尾相接的两个区间（[1,2) 与 [2,3)）允许，结果是两行各自换掉',
        bytesEqual(result.bytes, Buffer.from('甲\n乙\nlf-line-3\n', 'utf8')),
        `${JSON.stringify(Buffer.from(result.bytes).toString('utf8'))}`,
      );
    }
    // 对照：中间隔着一行的两个区间必须被允许，否则上面三条就成了「一律拒绝」。
    {
      const item = firstEdited([
        editItem(
          path,
          token,
          [
            { start_line: 3, end_line_exclusive: 4, old_lines: ['lf-line-3'], new_lines: ['丙'] },
            { start_line: 1, end_line_exclusive: 2, old_lines: ['lf-line-1'], new_lines: ['甲'] },
          ],
          sha,
        ),
      ]);
      const result = applyLineEdits({ item, original, baseline: decode(original) });
      const after = decode(result.bytes);
      check(
        'd4 对照：不相交的两行可以同时改，且按行号升序生效',
        lineText(after.text, after.lines, 1) === '甲' && lineText(after.text, after.lines, 2) === 'lf-line-2' && lineText(after.text, after.lines, 3) === '丙',
        `${after.text.split('\n').slice(0, 3).map((s) => JSON.stringify(s)).join(' ')}`,
      );
    }
  }

  // --- d5：重复物理文件已在验收 (c) 里用真硬链接验过 ---
  note('d5 重复物理文件', '见验收 (c) 的 c3（真硬链接 + 护栏给出的 file_id）');
}

// ===========================================================================
// 票据与身份：唯一的版本来源
// ===========================================================================

async function ticketIsTheOnlyVersionSource(corpus: Corpus): Promise<void> {
  section('票据与身份：伪造 / 过期 / 跨连接 / 跨代次 / 越界区间');

  const rel = 'newline/lf.txt';
  const original = corpus.bytes.get(rel) as Buffer;
  const id = corpus.identity.get(rel) as DiskIdentity;
  const sha = sha256(original);
  const edits = [lineEdit(1, 'lf-line-1', ['甲'])];

  note('票据权威', `key_fingerprint=${authority.key_fingerprint}（只有指纹，没有密钥）`);
  check('票据格式：lwbrt_ 前缀 + 载荷 + HMAC', mint(original, rel, id).startsWith('lwbrt_'), 'lwbrt_…');

  // 伪造：把真票据改一个字符。
  {
    const token = mint(original, rel, id);
    const at = token.length - 3;
    const flipped = `${token.slice(0, at)}${token[at] === 'A' ? 'B' : 'A'}${token.slice(at + 1)}`;
    expectReason(() => plan([editItem(rel, flipped, edits, sha)]), 'READ_TOKEN_STALE', 'TICKET_BAD_SIGNATURE', '伪造票据（改一个字符）：签名不匹配');
    expectReason(() => plan([editItem(rel, 'lwbrt_not-a-real-ticket', edits, sha)]), 'READ_TOKEN_STALE', 'TICKET_MALFORMED', '乱写的票据：结构不完整');
    expectReason(() => plan([editItem(rel, '', edits, sha)]), 'INVALID_ARGUMENT', 'READ_TOKEN_MISSING', '没有票据：拒绝（不会退回「按路径重新读一次」）');
    // 换一把密钥签出来的票据：这张票是**别的部署**签的。
    const foreign = createReadTicketAuthority({ key: '另一把完全不同的密钥-0123456789abcdef' });
    const foreignToken = foreign.mintReadTicket(
      { ...(authority.verifyReadTicket(token, { now: NOW }) as ReadTicketFacts) },
      { now: NOW, ttl_ms: LIMITS.READ_TOKEN_TTL_MS },
    );
    expectReason(() => plan([editItem(rel, foreignToken, edits, sha)]), 'READ_TOKEN_STALE', 'TICKET_BAD_SIGNATURE', '别的部署的密钥签的票据：拒绝');
  }

  // 过期。
  {
    const token = mint(original, rel, id, {}, NOW - LIMITS.READ_TOKEN_TTL_MS - 1000);
    expectReason(() => plan([editItem(rel, token, edits, sha)]), 'READ_TOKEN_STALE', 'TICKET_EXPIRED', `过期票据（TTL=${LIMITS.READ_TOKEN_TTL_MS}ms）：拒绝`);
  }

  // 跨连接 / 跨工作区 / 跨代次。
  {
    const token = mint(original, rel, id, { connection_id: 'another-connection' });
    expectReason(() => plan([editItem(rel, token, edits, sha)]), 'READ_TOKEN_STALE', 'TICKET_CROSS_CONNECTION', '别的连接读来的票据：拒绝（身份来自已认证通道，不来自参数）');
    const wsToken = mint(original, rel, id, { workspace_id: 'another-workspace' });
    expectReason(() => plan([editItem(rel, wsToken, edits, sha)]), 'READ_TOKEN_STALE', 'TICKET_CROSS_WORKSPACE', '别的工作区读来的票据：拒绝');
    const genToken = mint(original, rel, id, { generation: GENERATION + 1 });
    expectReason(() => plan([editItem(rel, genToken, edits, sha)]), 'READ_TOKEN_STALE', 'TICKET_GENERATION_MISMATCH', '工作区代次变了：拒绝');
  }

  // 路径改成另一个文件（票据里的路径是磁盘规范拼写，比较按大小写不敏感）。
  {
    const token = mint(original, rel, id, { canonical_path: 'newline/other.txt' });
    expectReason(() => plan([editItem(rel, token, edits, sha)]), 'READ_TOKEN_STALE', 'TICKET_PATH_MISMATCH', '票据指向别的路径：拒绝');
    // 反向对照：只是**拼写大小写**不同，必须放行 —— 否则 NTFS 上同一次读取
    // 会因为模型的书写习惯被判成「跨文件重放」。
    const upperToken = mint(original, 'Newline/LF.txt', id);
    const ok = (() => {
      try {
        plan([editItem(rel, upperToken, edits, sha)]);
        return true;
      } catch {
        return false;
      }
    })();
    check('对照：只是大小写拼写不同，票据仍然有效（路径不是身份判据）', ok, ok ? '放行' : '竟然被拒绝');
  }

  // 区间越界：票据只返回过一部分行。
  {
    const pageToken = mint(original, rel, id, { range_start: 2, range_end_exclusive: 3 });
    expectReason(
      () => plan([editItem(rel, pageToken, [lineEdit(1, 'lf-line-1', ['甲'])], sha)]),
      'READ_TOKEN_STALE',
      'EDIT_RANGE_NOT_READ',
      '改第 1 行，但票据只返回过第 2 行：拒绝（落在「模型以为读过」的地方）',
    );
    const ok = (() => {
      try {
        plan([editItem(rel, pageToken, [lineEdit(2, 'lf-line-2', ['乙'])], sha)]);
        return true;
      } catch {
        return false;
      }
    })();
    check('对照：票据返回过的第 2 行可以改', ok, ok ? '放行' : '竟然被拒绝');
  }
}

// ===========================================================================
// 边界与上限
// ===========================================================================

async function bounds(corpus: Corpus): Promise<void> {
  section('边界与上限：契约层与工具 schema 用同一个数');

  const rel = 'newline/lf.txt';
  const original = corpus.bytes.get(rel) as Buffer;
  const id = corpus.identity.get(rel) as DiskIdentity;
  const sha = sha256(original);
  const token = mint(original, rel, id);

  note(
    'LIMITS',
    `MAX_EDITABLE_FILE_BYTES=${LIMITS.MAX_EDITABLE_FILE_BYTES} MAX_EDITS_PER_FILE=${LIMITS.MAX_EDITS_PER_FILE} ` +
      `MAX_CHANGE_FILES=${LIMITS.MAX_CHANGE_FILES} MAX_CHANGE_TOTAL_BYTES=${LIMITS.MAX_CHANGE_TOTAL_BYTES} ` +
      `READ_TOKEN_TTL_MS=${LIMITS.READ_TOKEN_TTL_MS}`,
  );

  // 编辑条数上限：超一条就拒。
  {
    const many = Array.from({ length: LIMITS.MAX_EDITS_PER_FILE + 1 }, () => ({ start_line: 1, end_line_exclusive: 1, old_lines: [], new_lines: ['x'] }));
    expectReason(
      () => plan([editItem(rel, token, many, sha)]),
      'INVALID_ARGUMENT',
      'TOO_MANY_EDITS',
      `编辑条数 ${LIMITS.MAX_EDITS_PER_FILE + 1} > MAX_EDITS_PER_FILE：拒绝`,
    );
  }

  // 同一个数在 zod schema 里也生效：契约层与工具面对外的声明不能分叉。
  //
  // 用的是**已注册**的那个 schema（`TOOL_INPUT_SCHEMAS.change_prepare`），
  // 也就是 MCP 工具面真正发布出去的那份 —— 而不是再构造一份等价的来测。
  {
    const schema = TOOL_INPUT_SCHEMAS.change_prepare;
    const prepare = (edits: readonly unknown[], items?: readonly unknown[]): unknown => ({
      workspace_id: WORKSPACE,
      idempotency_key: 'evidence-019',
      summary: '证据',
      items: items ?? [{ op: 'edit_text', path: rel, base_sha256: sha, read_token: token, edits }],
    });
    const many = Array.from({ length: LIMITS.MAX_EDITS_PER_FILE + 1 }, () => ({ start_line: 1, end_line_exclusive: 1, old_lines: [], new_lines: ['x'] }));
    const parsed = schema.safeParse(prepare(many));
    check(
      '工具 schema 的 edits 上限与 LIMITS.MAX_EDITS_PER_FILE 是同一个数',
      parsed.success === false,
      parsed.success ? `${LIMITS.MAX_EDITS_PER_FILE + 1} 条竟然通过了 schema` : 'schema 也拒绝',
    );
    const okParsed = schema.safeParse(
      prepare([{ start_line: 1, end_line_exclusive: 2, old_lines: ['lf-line-1'], new_lines: ['甲'] }]),
    );
    check(
      '对照：合法的单条编辑能通过 schema',
      okParsed.success,
      okParsed.success ? '通过' : JSON.stringify(okParsed.error?.issues?.[0] ?? {}),
    );
    // 上限边界本身：恰好 `MAX_EDITS_PER_FILE` 条要通过 —— 否则上面那条
    // 证明的是「schema 拒绝一切多条编辑」，而不是「上限就是那个数」。
    const exact = schema.safeParse(
      prepare(Array.from({ length: LIMITS.MAX_EDITS_PER_FILE }, () => ({ start_line: 1, end_line_exclusive: 1, old_lines: [], new_lines: ['x'] }))),
    );
    check(
      `对照：恰好 ${LIMITS.MAX_EDITS_PER_FILE} 条能通过 schema（边界不是「一律拒绝多条」）`,
      exact.success,
      exact.success ? '通过' : JSON.stringify(exact.error?.issues?.[0] ?? {}),
    );
    // 修改集条目数上限也在这份 schema 里。
    const tooManyItems = Array.from({ length: LIMITS.MAX_CHANGE_FILES + 1 }, () => ({
      op: 'edit_text',
      path: rel,
      base_sha256: sha,
      read_token: token,
      edits: [{ start_line: 1, end_line_exclusive: 2, old_lines: ['lf-line-1'], new_lines: ['甲'] }],
    }));
    const itemsParsed = schema.safeParse(prepare([], tooManyItems));
    check(
      `工具 schema 的 items 上限与 LIMITS.MAX_CHANGE_FILES 是同一个数`,
      itemsParsed.success === false,
      itemsParsed.success ? `${LIMITS.MAX_CHANGE_FILES + 1} 项竟然通过了 schema` : 'schema 也拒绝',
    );
  }

  // 修改集条目数上限。
  {
    const item = editItem(rel, token, [lineEdit(1, 'lf-line-1', ['甲'])], sha);
    const many = Array.from({ length: LIMITS.MAX_CHANGE_FILES + 1 }, () => item);
    expectReason(
      () => plan(many),
      'INVALID_ARGUMENT',
      'TOO_MANY_CHANGE_FILES',
      `修改项 ${LIMITS.MAX_CHANGE_FILES + 1} > MAX_CHANGE_FILES：拒绝`,
    );
  }

  // 结果尺寸上限：调用方可以配一个更紧的上限。
  {
    const tight = Math.floor(original.length / 2);
    const item = firstEdited([editItem(rel, token, [lineEdit(1, 'lf-line-1', ['甲'.repeat(50)])], sha)]);
    expectReason(
      () => applyLineEdits({ item, original, baseline: decode(original), max_editable_file_bytes: tight }),
      'SIZE_LIMIT_EXCEEDED',
      'RESULT_TOO_LARGE',
      `产物超过调用方给的上限 ${tight}B：拒绝（上限可调，边界跟着动）`,
    );
  }

  // 契约层的尺寸闸门：票据记的是签发那一刻的裁定，上限调小后旧票不再放行。
  {
    const item = editItem(rel, token, [lineEdit(1, 'lf-line-1', ['甲'])], sha);
    expectReason(
      () => plan([item], context({ max_editable_file_bytes: original.length - 1 })),
      'SIZE_LIMIT_EXCEEDED',
      'FILE_TOO_LARGE_FOR_EDIT',
      '上限调到比文件还小：旧票不再放行',
    );
  }

  // 超限文件在夹具清单里本就不可编辑（这道闸门在下游，不替代上游）。
  {
    const big = corpus.manifest.files.find((f) => f.relPath === 'large/big.txt');
    note('超限夹具', `large/big.txt ${String(big?.bytes)}B，清单 editable=${String(big?.editable)}（上限 ${LIMITS.MAX_EDITABLE_FILE_BYTES}B）`);
    check('超限文件在夹具清单里标记为不可编辑', big?.editable === false && (big?.bytes ?? 0) > LIMITS.MAX_EDITABLE_FILE_BYTES, `${String(big?.bytes)}B > ${LIMITS.MAX_EDITABLE_FILE_BYTES}B`);
  }

  // create_text / replace_text 的正常路径也走一遍（交付物有这三个入口）。
  {
    const created = createTextFile({ item: plan([createItem('新文件.txt', '第一行\n第二行\n', 'lf', true)])[0] as never });
    const createdDecoded = decode(created.bytes);
    note('create_text', `${created.bytes.length}B newline=${created.newline} bom=${String(created.bom)} lines=${createdDecoded.lines.total_lines}`);
    // `inspectBytes` 把 BOM 单独报成 `bom: true`，`text` 里**不含** U+FEFF ——
    // 字节层面的核对因此分成两半：头三个字节是什么，以及 BOM 之后的正文。
    check(
      'create_text：按声明写出 LF，BOM 是三字节 EF BB BF 而不是正文里的 U+FEFF',
      createdDecoded.bom &&
        createdDecoded.newline === 'lf' &&
        createdDecoded.text === '第一行\n第二行\n' &&
        bytesEqual(created.bytes.subarray(0, 3), Buffer.from([0xef, 0xbb, 0xbf])),
      `头部 ${JSON.stringify([...created.bytes.subarray(0, 3)])} bom=${String(createdDecoded.bom)} newline=${createdDecoded.newline}`,
    );
    const crlfCreated = createTextFile({ item: plan([createItem('新文件.txt', '甲\n乙\n', 'crlf', false)])[0] as never });
    check('create_text：newline=crlf 时每一行都带 CRLF', bytesEqual(crlfCreated.bytes, Buffer.from('甲\r\n乙\r\n', 'utf8')), `${crlfCreated.bytes.length}B`);

    const wholeRel = '文档/设计说明.md';
    const whole = corpus.bytes.get(wholeRel) as Buffer;
    const wholeToken = mint(whole, wholeRel, corpus.identity.get(wholeRel) as DiskIdentity);
    const replaced = replaceWholeText({
      item: plan([replaceItem(wholeRel, wholeToken, '整份替换\n只有两行\n', sha256(whole))])[0] as never,
      original: whole,
      baseline: decode(whole),
    });
    check(
      'replace_text：整文件替换按字面落地，且换行风格跟随原文件',
      bytesEqual(replaced.bytes, Buffer.from('整份替换\n只有两行\n', 'utf8')) && replaced.newline === 'lf',
      `${replaced.before_size}B → ${replaced.after_size}B newline=${replaced.newline}`,
    );
  }
}

// ===========================================================================
// 主流程
// ===========================================================================

async function main(): Promise<void> {
  if (!WINDOWS_ONLY) {
    skip('全部验收项', '当前平台不是 Windows；夹具身份与硬链接语义都无法在此成立');
    console.log(`\n0 PASSED`);
    process.exitCode = 0;
    return;
  }

  const backend = new PowerShellWinfsBackend();
  let corpus: Corpus | null = null;

  try {
    const capability = await backend.capability();
    note(
      '护栏能力',
      `available=${String(capability.available)} backend=${capability.backend} ` +
        `supports_file_identity=${String(capability.supports_file_identity)} ` +
        `supports_hardlink_count=${String(capability.supports_hardlink_count)} ` +
        `crash_atomic_replace=${String(capability.crash_atomic_replace)}`,
    );
    if (!capability.available || !capability.supports_file_identity) {
      check('护栏可用且能取到文件身份', false, '没有身份就无法证明「同一个文件的第二次操作」');
      return;
    }

    corpus = await loadCorpus(backend);
    note('语料', `测试根 ${TESTREPO_DIR}`);
    note(
      '语料',
      `共 ${corpus.manifest.files.length} 个文件；可编辑且换行风格可写 ${corpus.editable.length} 个；` +
        `可编辑但换行风格不可写 ${corpus.unwritable.length} 个（${corpus.unwritable.map((f) => f.relPath).join('、')}）`,
    );
    note('语料', `身份取自护栏 statVolume（真实 NTFS 卷序列号 + 文件索引），不是自己算的`);
    {
      const sneaky = corpus.denied.filter(
        (p) => corpus?.manifest.files.find((f) => f.relPath === p)?.editable === true,
      );
      note(
        '语料',
        `策略硬拒绝 ${corpus.denied.length} 个（${corpus.denied.join('、')}）` +
          (sneaky.length > 0
            ? `；其中 ${sneaky.join('、')} 在夹具清单里写着 editable=true —— 清单字段是夹具意图，不是策略判定，本脚本按策略层裁定取语料`
            : ''),
      );
    }

    await guarded('验收 (b)', () => byteFidelity(corpus as Corpus));
    await guarded('验收 (a)', () => positionalCorrectness(corpus as Corpus));
    await guarded('验收 (c)', () => noSecondOperation(backend, corpus as Corpus));
    await guarded('步骤 4', () => explicitRejections(corpus as Corpus));
    await guarded('票据与身份', () => ticketIsTheOnlyVersionSource(corpus as Corpus));
    await guarded('边界与上限', () => bounds(corpus as Corpus));
  } finally {
    await backend.dispose().catch(() => undefined);
  }

  section('未执行项（不得记为通过）');
  skip(
    '在真实工作区（非夹具）上执行任何一次写入',
    'G2 未通过（LWB-002 BLOCKED）；P3 的门禁是「可在契约冻结前提下继续实现，但不得在真实仓库上联调」',
  );
  skip(
    '经由 daemon → 执行器 → 护栏的真实落盘',
    'LWB-020/021/022 未实现：本任务的交付物是**纯函数**（不碰文件系统），真实落盘属于后续任务',
  );
  skip(
    '五条 change_* 工具端到端可用',
    '未实现：它们当前按 LWB-018 步骤 4 返回 NOT_IMPLEMENTED，本任务没有改动工具面',
  );
  skip(
    '审批后才应用、一次性、带过期',
    'LWB-021 未实现：本任务不做任何批准判定，`approved:true` 在本任务的代码里没有入口',
  );
  skip(
    'MAX_CHANGE_TOTAL_BYTES 的强制执行',
    `未实现：整份修改集的总字节上限属于 LWB-020（修改集准备与摘要）；本任务只逐文件设限。当前值 ${LIMITS.MAX_CHANGE_TOTAL_BYTES}B`,
  );
  skip(
    '崩溃原子替换 / 跨文件事务',
    '护栏自检报告 crash_atomic_replace=false、cross_file_transaction=false（I11）：本任务的字节引擎只产生新字节，不负责落盘',
  );
  skip(
    '在真实 ChatGPT 网页端提出一次编辑',
    'LWB-002 BLOCKED（真实账号与 Secure MCP Tunnel 凭证）；MCP Inspector 的成功不能替代它',
  );

  console.log(`\n${failures === 0 ? 'ALL PASS' : `${String(failures)} FAILED`} — ${passes} PASSED / ${failures} FAILED`);
  process.exitCode = failures === 0 ? 0 : 1;
}

await main();
