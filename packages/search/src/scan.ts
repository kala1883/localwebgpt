/**
 * 单个文件的扫描（LWB-015 步骤 2）。
 *
 * > 搜索文件均通过 FsGuard 与出站策略；读取对象变化时丢弃该结果并报告覆盖范围。
 *
 * ## 这个模块要交付的那条验收标准
 *
 * > **秘密标记不会出现在命中片段中。**
 *
 * 落实它的方式不是「记得过滤」，而是让**片段根本没有别的出口**：
 * 片段只能经 `emitContent()` 离开，而闸门自己会重新判定路径、重新筛查内容。
 * 本模块在这之前多一道**预筛**，理由与闸门不同，值得写清楚：
 *
 *  - 闸门在 `secret_mode: 'block'` 面对高置信度凭证是**抛错**的。一次搜索里
 *    有一个文件命中私钥，整次搜索就失败了 —— 而那违反本任务的另一条验收标准
 *    （「超时返回部分结果」同一条精神：一次局部的问题不该毁掉整次操作）。
 *  - 因此本模块先在**文件级别**判一次：文件里出现高置信度凭证 ⇒ 整个文件的
 *    命中全部丢弃，一个字节都不送进闸门。
 *
 * 两道不是冗余：预筛决定「要不要返回这个文件的结果」，闸门决定「能不能出站」。
 * 前者可以错（它是本模块的判断），后者不能错（它是唯一的出口）。**顺序**也是
 * 有意的：先扫完整个文件、把所有片段都算出来、全部预筛通过，最后才逐片出站。
 * 若边扫边出站，一个在第 40 个命中处才发现的凭证会让前 39 个片段已经离开
 * 本进程 —— 那时「整文件丢弃」已经做不到了，只能做到「丢弃还没出站的」。
 *
 * ## 预筛判的是**整个文件**，不是每一片
 *
 * 判据取自 `inspection.text`（整份文本），而不是「拼出来的片段里有没有」。
 * 这不是保守，是**逐片筛查做不到**：
 *
 *  - 跨行形状的凭证在被切成一行的片段里认不出来。`private-key-block` 要求
 *    看到 `-----BEGIN … PRIVATE KEY-----`，而命中落在私钥正文中间时，片段
 *    窗口（命中前 64 码元起）里只有一段孤立的 base64 —— 没有任何规则匹配它。
 *    逐片筛查会把**私钥正文本身**原样送出去。
 *    实测：`screenText(整段).has_certain === true`，而正文那一行的片段是 `false`。
 *  - 与 `file_read` 的判定必须一致。那条路径把整个文件内容交给 `emitContent`，
 *    面对 certain 档是**抛错**：同一个文件不可能「整体读不出来、但能搜出一部分」。
 *    两边的判据合成一条：**含高置信度凭证的文件不出站内容**。
 *
 * 逐片那一遍**仍然保留**，因为它管的不是同一件事：片段的起点是任意的，
 * 而 `\b` 在**输入起点**处成立。`XAKIA…` 整段不匹配（前面是词字符，没有边界），
 * 而从 `AKIA` 起切的片段匹配。也就是说整份文本的判定**推不出**片段的判定。
 *
 * ## 读取对象变化
 *
 * 搜索是长时间操作，而工作区不属于本程序。因此每个文件都走与 `file_read`
 * 相同的三步（探针 → 读取 → 比身份），差别只在**失败的处理**：
 * `file_read` 抛出 `FILE_VERSION_CONFLICT`，而搜索**丢弃这一个文件的结果
 * 并继续**，把这件事记进覆盖范围。一个文件被改不该让整次搜索作废 ——
 * 在大仓库里那样的搜索永远不会成功。
 *
 * 同一条道理适用于「打不开」：被删掉、被独占、权限不够的文件都只作废
 * 它自己（`unreadable`）。但**不是所有失败都可以这样处理** —— 见
 * `PER_FILE_WINFS_CODES` 上面的那段：判据是护栏自己的码，不是契约码。
 *
 * ## 六种结局，六种事实
 *
 * 返回值刻意分成判别式，而不是「命中数组 + 一堆布尔」：每一种结局在覆盖
 * 范围里的归宿不同，而归宿写错会让「没找到」这句话变得不可靠。尤其注意
 * `no_text` 与 `found` 的分工 —— 前者**读到了字节**（因此计入 `scanned_files`
 * 与 `scanned_bytes`），只是那些字节里没有可检索的文本；`too_large` 与
 * `unreadable` 则**一个字节都没读**，属于「跳过」。
 */

import { BridgeError, type SearchMatch } from '@lwb/contracts';
import type { Clearance, EgressBudget } from '@lwb/egress';
import { emitContent, screenText } from '@lwb/egress';
import type { LineIndex, ReadScope } from '@lwb/files';
import {
  gatePathFor,
  inspectBytes,
  lineText,
  refOf,
  requireCanonicalPath,
  resolveTarget,
  toBridgeError,
  truncateToBytes,
  utf8Bytes,
} from '@lwb/files';
import type { WinfsOps } from '@lwb/winfs';
import { isWinfsError } from '@lwb/winfs';

import type { SearchQuery } from './query.ts';
import { findInLine } from './query.ts';

/**
 * 片段里留给命中词**前面**的上下文量（码元）。
 *
 * 取 64 是因为它足够看清「命中在什么结构里」（`const x = `、`<div class="`），
 * 又不至于把片段的上限吃光。真正决定片段形状的是 `MAX_SNIPPET_BYTES`：
 * 这个值只在**超长行**上才起作用 —— 短行的片段本来就是整行。
 */
const SNIPPET_LEAD_CHARS = 64;

export type ScanOutcome =
  /**
   * 超出单次可读上限，**一个字节都没读**。
   *
   * 它是「本次没搜它」而不是「它里面没有」—— 一个 30 MiB 的日志文件完全
   * 可能含目标文本，只是本版本不提供超大文件的分页检索。
   */
  | { readonly kind: 'too_large' }
  /**
   * 打不开或读不动：文件被删了、被别的进程独占了、或权限不够。
   *
   * **这不是整次搜索的失败。** 搜索是长操作，而工作区不属于本程序 ——
   * 一次仓库级搜索里碰上几个打不开的文件是常态，让其中任何一个把整次搜索
   * 变成一条错误，等于让搜索在大仓库里永远不可用。它与 `unstable` 的区别是
   * 一个字节都没读到（因此计入「跳过」而不是「已扫描」）。
   *
   * 判据用护栏自己的码（`winfs_code`），不用映射后的契约码：契约里
   * `PERMISSION_DENIED`/`IO_ERROR` 都落到 `INTERNAL_ERROR`，按契约码分，
   * 「可跳过的环境问题」与「真出了 bug」就分不开了。
   */
  | { readonly kind: 'unreadable'; readonly winfs_code: string }
  /** 读到了字节，但里面没有可检索的 UTF-8 文本。 */
  | { readonly kind: 'no_text'; readonly reason: 'NOT_TEXT' | 'UNDECODABLE'; readonly bytes: number }
  /** 读到了字节，但两次打开之间对象被替换或改动过；这份内容不可信。 */
  | { readonly kind: 'unstable'; readonly bytes: number }
  /** 文件里出现高置信度凭证 ⇒ 整文件丢弃（方案 §4.3）。**不返回文件名。** */
  | { readonly kind: 'secret'; readonly bytes: number }
  /**
   * 正常结果。`hits_in_file` 是本文件里**命中总数**（含本次因分页而未返回的），
   * 调用方据此决定续读是落在本文件内部还是下一个文件。
   */
  | {
      readonly kind: 'found';
      readonly matches: readonly SearchMatch[];
      readonly bytes: number;
      readonly hits_in_file: number;
    };

/**
 * 可以**只作废这一个文件**的护栏码。
 *
 * 逐个说清楚为什么在此列：
 *  - `NOT_FOUND`：探针与读取之间文件被删了。搜索期间最常发生的一件事。
 *  - `FILE_BUSY`：别的进程以不共享的方式打开了它。用户现在正在编辑它。
 *  - `PERMISSION_DENIED`：ACL 拒绝。工作区里往往有一两个这样的文件。
 *  - `IO_ERROR`：坏扇区之类。同样只影响这一个文件。
 *
 * **不在**此列的（因此会把整次搜索变成失败）都是「再往下走已经不诚实」的：
 * `ROOT_IDENTITY_MISMATCH`（工作区根换了对象 ⇒ 代次、游标、票据全失效）、
 * `NATIVE_GUARD_UNAVAILABLE`（没有护栏 ⇒ fail-closed）、`PATH_UNSAFE`
 * （路径证明失败 ⇒ 有东西不对）。它们不是「这一个文件读不动」，
 * 而是「本次操作的前提不成立了」。
 */
const PER_FILE_WINFS_CODES: readonly string[] = ['NOT_FOUND', 'FILE_BUSY', 'PERMISSION_DENIED', 'IO_ERROR'];

export interface ScanContext {
  readonly ops: WinfsOps;
  readonly scope: ReadScope;
  readonly query: SearchQuery;
  readonly clearance: Clearance;
  readonly budget: EgressBudget;
  /** 本文件最多还能产出多少条匹配（整次调用的剩余额度）。 */
  readonly remaining_matches: number;
  /** 调用方要求在本文件里**跳过**的匹配数（分页续读用）。恒 >= 0。 */
  readonly skip_matches: number;
  readonly max_readable_file_bytes: number;
  readonly max_snippet_bytes: number;
  readonly max_line_bytes: number;
}

/**
 * 扫描一个文件。
 *
 * 返回的每一条 `SearchMatch` 都**已经**通过了出站闸门，`redacted` 是闸门的
 * 裁定而不是本模块的猜测。
 *
 * **调用方必须先做过排除判定**（硬拒绝与搜索排除）。本函数不做那件事：
 * 「这条路径该不该被遍历到」需要条目级的事实（是不是重解析点、命中了哪条
 * 规则），那些事实属于遍历层。在这里再判一次会得到第二份规则实现 ——
 * 而两份实现迟早在某个分支上分叉。
 */
export async function scanFile(relativePath: string, ctx: ScanContext): Promise<ScanOutcome> {
  try {
    return await scanUncached(relativePath, ctx);
  } catch (error) {
    // 「这一个文件读不动」与「本次操作的前提不成立」必须分开：前者作废这一个
    // 文件，后者把整次搜索变成失败。判据是护栏自己的码，见 PER_FILE_WINFS_CODES。
    const winfsCode = winfsCodeOf(error);
    if (winfsCode !== null && PER_FILE_WINFS_CODES.includes(winfsCode)) {
      return { kind: 'unreadable', winfs_code: winfsCode };
    }
    throw error;
  }
}

/**
 * 从一个 `BridgeError` 里取出护栏码。
 *
 * `toBridgeError()` 一定会在 details 里带上 `winfs_code`，因此这条通道本身
 * 是完整的；取不到就返回 null —— 那意味着这个错误不是护栏给的（而是本层
 * 或闸门抛的），**不适用**「只作废这一个文件」这条处置。
 */
function winfsCodeOf(error: unknown): string | null {
  if (!(error instanceof BridgeError)) return null;
  const code = error.details?.winfs_code;
  return typeof code === 'string' ? code : null;
}

async function scanUncached(relativePath: string, ctx: ScanContext): Promise<ScanOutcome> {
  const probe = await resolveTarget(ctx.ops, ctx.scope, relativePath, 'file');

  if (probe.size > ctx.max_readable_file_bytes) {
    // 尺寸预检在读字节之前：受控句柄只提供整文件读取，「先读进来再看多大」
    // 等于没有上限。这里与 file_read 的区别是**不抛错** —— 一个 30 MiB 的
    // 日志文件不该让一次仓库搜索失败，它是「本次没搜它」。
    return { kind: 'too_large' };
  }

  // 预检：一个字节都没读，先问闸门「这个路径有没有资格往外走内容」。
  // 与 file_read 同一条理由 —— 读一个本不该读的文件本身就是代价。
  emitContent(ctx.clearance, { path: gatePathFor(ctx.scope, probe.canonical_path), content: '' }, ctx.budget);

  const result = await ctx.ops.readFileGuarded(refOf(ctx.scope, relativePath));
  if (isWinfsError(result)) throw toBridgeError(result);

  // 两次打开之间的身份比对（I03：比句柄上的身份，不比路径字符串）。
  // 不符即**丢弃**而不是抛错：见文件头「读取对象变化」。
  if (
    result.identity.volume_id !== probe.identity.volume_id ||
    result.identity.file_id !== probe.identity.file_id ||
    result.size !== probe.size
  ) {
    return { kind: 'unstable', bytes: result.size };
  }

  const bytes = Buffer.from(result.bytes_base64, 'base64');
  const inspection = inspectBytes(bytes);
  if (inspection.kind !== 'text') {
    return {
      kind: 'no_text',
      reason: inspection.kind === 'binary' ? 'NOT_TEXT' : 'UNDECODABLE',
      bytes: bytes.length,
    };
  }

  // 文件级预筛：判**整份文本**，并且排在算命中之前。理由见文件头
  // 「预筛判的是整个文件」——跨行形状的凭证只有在这里才认得出来。
  //
  // 代价是每个被扫描的文件都要跑一遍全量筛查（实测 16 MiB 约 73–264 ms，
  // 视内容而定）。这与 `file_read` 的代价同阶：那条路径本来就把整个文件
  // 交给 `emitContent` 筛一遍，而搜索的单次扫描字节上限（64 MiB）也是同一个
  // 量级。真正的兜底是 deadline —— 它在每个文件之前判一次，因此这一层
  // 再慢也只会让本次搜索提前收尾，不会让它失控。
  if (screenText(inspection.text).has_certain) {
    return { kind: 'secret', bytes: bytes.length };
  }

  const hits = collectHits(inspection.text, inspection.lines, ctx.query);
  const hitsInFile = hits.length;

  // 续读：被跳过的命中仍然要**算出来**（只有算出来才知道跳到第几个），
  // 只是不返回。它们的片段也不出站 —— 那正是「跳过」的意思。
  const fresh = hits.slice(ctx.skip_matches);
  const keep = fresh.slice(0, Math.max(0, ctx.remaining_matches));
  if (keep.length === 0) return { kind: 'found', matches: [], bytes: bytes.length, hits_in_file: hitsInFile };

  // 先把这一批的片段全部拼出来并预筛，再逐片出站。顺序见文件头。
  const canonical = requireCanonicalPath(result.canonical_relative_path);
  const gatePath = gatePathFor(ctx.scope, canonical);
  const planned: { hit: Hit; snippet: string; snippetOffset: number; lineTruncated: boolean }[] = [];

  for (const hit of keep) {
    const line = lineText(inspection.text, inspection.lines, hit.line_number);
    const snippet = buildSnippet(line, hit.column, ctx.max_snippet_bytes);
    planned.push({
      hit,
      snippet: snippet.text,
      snippetOffset: snippet.offset,
      lineTruncated: utf8Bytes(line) > ctx.max_line_bytes,
    });
  }

  // 逐片再筛一遍。它与上面那次**不是同一件事**：片段的起点是任意的，而 `\b`
  // 在输入起点处成立 —— `XAKIA…` 整段不匹配，从 `AKIA` 起切的片段匹配。
  // 因此整份文本的判定推不出片段的判定，这一遍是真的在兜另一类形状。
  //
  // 判完这一批才逐片出站（顺序见文件头）：若边拼边出站，一个在第 40 个命中处
  // 才发现的凭证会让前 39 个片段已经离开本进程，那时「整文件丢弃」已经做不到。
  if (planned.some((p) => screenText(p.snippet).has_certain)) {
    // 整文件丢弃，一个片段都不出站。**不返回名字**：文件名可能本身就是提示
    // （`deploy-prod.key`），而模型不需要知道是哪一个，只需要知道有几个。
    return { kind: 'secret', bytes: bytes.length };
  }

  const matches: SearchMatch[] = [];
  for (const p of planned) {
    // 唯一的出口。闸门会**再判一次**路径、**再筛一次**内容 —— 预筛漏掉的东西
    // 在这里被拦住，而那时抛错是对的：闸门发现了预筛没发现的东西。
    //
    // 出站预算耗尽同样**抛错**，不做「返回一部分」：预算耗尽是一次可诊断的
    // 连接级状态（本地操作者据此调整），而悄悄少返回几条会让调用方以为
    // 这就是全部命中 —— I14 的同一条道理。
    const emission = emitContent(ctx.clearance, { path: gatePath, content: p.snippet }, ctx.budget);
    matches.push({
      path: canonical,
      line_number: p.hit.line_number,
      snippet: emission.content,
      line_truncated: p.lineTruncated,
      column: p.hit.column,
      snippet_offset: p.snippetOffset,
      redacted: emission.redacted,
    });
  }

  return { kind: 'found', matches, bytes: bytes.length, hits_in_file: hitsInFile };
}

// ---------------------------------------------------------------------------
// 命中与片段
// ---------------------------------------------------------------------------

interface Hit {
  readonly line_number: number;
  /** 相对**整行**的起始列（UTF-16 码元）。 */
  readonly column: number;
}

/**
 * 逐行找字面量。
 *
 * 同一行里的**每一个**命中都算一条（不是一行一条）：一行里出现的第二次命中
 * 是一个不同的位置，`column` 不同，模型据此去读的位置也不同。
 *
 * 步进长度取查询串的长度而不是 1：在 `aaaa` 里搜 `aa` 有两个**不重叠**的
 * 出现，不是三个。这与 `indexOf` 的常规遍历语义一致，也避免了同一批偏移
 * 被报成多次。
 */
function collectHits(text: string, lines: LineIndex, query: SearchQuery): Hit[] {
  const hits: Hit[] = [];
  for (let n = 1; n <= lines.total_lines; n += 1) {
    const line = lineText(text, lines, n);
    if (line.length === 0) continue;
    let from = 0;
    for (;;) {
      const at = findInLine(query, line, from);
      if (at === -1) break;
      hits.push({ line_number: n, column: at });
      from = at + Math.max(1, query.needle.length);
    }
  }
  return hits;
}

/**
 * 从一行里取出包含命中位置的片段。
 *
 * ## 三条规则，每条对应一个具体的坏结果
 *
 *  1. **片段必须包含命中。** 一条不含命中词的片段会让模型以为命中在别处 ——
 *     而片段唯一的用途就是定位。因此窗口从命中前 `SNIPPET_LEAD_CHARS` 个
 *     码元处开始，而不是从行首开始。
 *  2. **不超过字节上限，且不切开码位。** 用 `truncateToBytes`，它按 UTF-8
 *     实际编码长度推进（一个汉字 3 字节、一个 emoji 4 字节），而不是按
 *     `length` 估算 —— 后者会得到一个比上限大得多的结果，且看起来"差不多对"。
 *  3. **控制字符转义成 `\xNN`。** 契约要求片段「转义为单行」。行的正文里
 *     可能含制表符与单独的 CR（`decode.ts` 刻意不把单独 CR 当行分隔符，
 *     于是它会留在行内容里）。一个带 CR 的片段在模型的界面上是一行，
 *     而那会让「第 3 行」指向两个不同的位置。制表符保留为 `\t`：它常见、
 *     是正文的一部分，且不改变行的边界。
 *
 * 转义与「正文里真的写了 `\x0D`」无法区分 —— 这个歧义是已知的、也是可接受的：
 * 它不制造歧义**位置**，只制造歧义**字形**，而要确认原文本来就该去 `file_read`。
 */
function buildSnippet(line: string, column: number, maxSnippetBytes: number): { text: string; offset: number } {
  const offset = Math.max(0, column - SNIPPET_LEAD_CHARS);
  const window = line.slice(offset);
  const cut = truncateToBytes(window, maxSnippetBytes);
  return { text: escapeControlChars(cut), offset };
}

const CONTROL_ESCAPES: Readonly<Record<number, string>> = {
  0x07: '\\a',
  0x08: '\\b',
  0x09: '\\t',
  0x0a: '\\n',
  0x0b: '\\v',
  0x0c: '\\f',
  0x0d: '\\r',
};

function escapeControlChars(text: string): string {
  let out = '';
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20) {
      // NUL 不走这张表：它已经在 inspectBytes 里被判成二进制，到不了这里。
      out += CONTROL_ESCAPES[code] ?? `\\x${code.toString(16).padStart(2, '0').toUpperCase()}`;
    } else if (code === 0x7f) {
      out += '\\x7F';
    } else {
      out += ch;
    }
  }
  return out;
}
