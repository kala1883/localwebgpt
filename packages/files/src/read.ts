/**
 * 一致的文件读取（LWB-013）。
 *
 * ## 这个模块在整条链路里的位置
 *
 * ```
 *   daemon: registry.authorizeAccess() → decide()/requireAllowed()
 *              │
 *              ├─ 探针:  ops.resolvePath()      只取身份与尺寸，不读内容
 *              ├─ 预检:  emitContent(空载荷)     在付出读取代价**之前**先问一次闸门
 *              ├─ 读取:  ops.readFileGuarded()   受控句柄，共享模式不含 FILE_SHARE_WRITE
 *              ├─ 比对:  两次打开的身份/尺寸必须一致
 *              └─ 出站:  emitContent(真内容)     ← 内容离开本机的唯一通道
 *              ↓
 *         签名读取票据 + 分页游标 → FileReadData
 * ```
 *
 * ## 五个顺序上的「不能调换」
 *
 *  1. **先问尺寸，再读字节。** 受控句柄只提供整文件读取，所以「先读进来再判断
 *     是不是太大」等于没有上限 —— 判断必须发生在会付出代价的那一步之前。
 *  2. **先过闸门，再读字节。** 一次空载荷预检让命中硬拒绝规则的路径在
 *     **一个字节都没读**的时候就失败。读一个本不该读的文件本身就是代价：
 *     内容会经过 daemon 的内存、可能进入内存转储、也可能被下一处新加的日志
 *     顺手打出来。晚拦一道，不如早拦一道。
 *  3. **读完再比身份。** 两次打开之间文件可能被换掉。比对的是句柄上的
 *     `volume_id`/`file_id`/`size`，不是路径字符串（I03）。
 *  4. **内容先过闸门，票据后签发。** 票据里的 `editable` 取自出站层的裁定结果，
 *     因此「脱敏过的读取不能拿去编辑」这条不靠本文件记得去查 ——
 *     它没有别的值可填。
 *  5. **最终那次闸门用读取结果里的规范路径。** 预检与最终出站是两次判定，
 *     两次都判。中间若发生了改名（file_id 不变，因此身份比对通过），
 *     最终那次看到的是**新名字**，判定也就落在新名字上。
 *
 * 另有一条不在上面（它不是"顺序"，是"在哪一步之前"）：**参数形态在读任何字节
 * 之前判**。`max_lines` / `start_line` 不合法时一次磁盘访问都不该发生 ——
 * 否则一次调用方错误会变成两次真实的文件打开。游标是**例外**：它必须对着
 * 本次读到的文件身份才成立，因此只能等到读取之后。
 *
 * ## 出站闸门用的是**磁盘规范路径**，不是调用方给的字符串
 *
 * 这不是洁癖：`.env` 的 8.3 短名形如 `ENV~1`，而硬拒绝规则是按**名字**匹配的。
 * 拿请求里的字符串去匹配，一份以短名请求的 `.env` 会顺利通过，而磁盘上的
 * 对象确实是 `.env`。规范路径取自句柄，短名在那里已经被解析成真名。
 *
 * 单文件工作区（`kind: 'file'`）是这条规则的一个特例：它的规范相对路径就是
 * 空串，而 `classifyFile('')` 因为切不出任何路径段而返回 allow —— 于是
 * 「把 `.env` 登记成单文件工作区」会变成一条绕过路径。因此这一层把它换成
 * 根对象自己的文件名再判（见 `gatePathFor`）。
 *
 * ## 这一层**做不到**的事，写在这里而不是留给读者去发现
 *
 * 两次打开之间的比对能抓到「对象被换掉」（`file_id` 变了）与「尺寸变了」，
 * **抓不到**「某个在此之前就已持有写句柄的进程，在这两次打开之间做了同样
 * 大小的原地改写」。后者留下的痕迹只有一个：读到的字节可能被撕裂，而
 * `sha256` 是**对读到的那个缓冲区**算的，因此它仍然如实地描述 `content` ——
 * 不确定的只是「磁盘此刻是否还等于 content」。这条不确定性不会变成一次
 * 静默的错误写入：写入路径会在独占句柄内重新核对 `base_sha256`（I07）。
 */

import { BridgeError } from '@lwb/contracts';
import type {
  Cursor,
  FileEncoding,
  FileReadData,
  FileReadInput,
  FileStatData,
  NewlineStyle,
  ReadToken,
} from '@lwb/contracts';
import { LIMITS } from '@lwb/contracts';
import type { Clearance, EgressBudget, Emission } from '@lwb/egress';
import { editableBlockerFor, emitContent, mintClearance, mintEditTicket } from '@lwb/egress';
import type { PolicyDecision } from '@lwb/policy';
import type { WinfsOps } from '@lwb/winfs';
import { isWinfsError } from '@lwb/winfs';

import type { DecodedText, LineIndex } from './decode.ts';
import { inspectBytes, lineTerminator, lineText, truncateToBytes, utf8Bytes } from './decode.ts';
import type { GuardTarget, ReadScope } from './guard-bridge.ts';
import { gatePathFor, refOf, resolveTarget, toBridgeError } from './guard-bridge.ts';
import type { ReadTicketAuthority, ReadTicketFacts } from './read-token.ts';

// 作用域类型与 `refOf` / `gatePathFor` / `toBridgeError` 现在住在 `guard-bridge.ts`：
// 读取与列举必须对同一条路径、同一个护栏失败给出同一个答案，因此它们只能有一份。
export type { AuthorizedRootLike, ReadScope } from './guard-bridge.ts';
export { readScopeOf } from './guard-bridge.ts';

// ---------------------------------------------------------------------------
// 依赖与限额
// ---------------------------------------------------------------------------

export interface ReadLimits {
  readonly max_read_lines: number;
  readonly max_response_body_bytes: number;
  readonly max_line_bytes: number;
  readonly max_editable_file_bytes: number;
  readonly max_readable_file_bytes: number;
  readonly read_token_ttl_ms: number;
}

/** 默认取自冻结契约的 `LIMITS`。**调用方不能从请求参数改这些值。** */
export const DEFAULT_READ_LIMITS: ReadLimits = {
  max_read_lines: LIMITS.MAX_READ_LINES,
  max_response_body_bytes: LIMITS.MAX_RESPONSE_BODY_BYTES,
  max_line_bytes: LIMITS.MAX_LINE_BYTES,
  max_editable_file_bytes: LIMITS.MAX_EDITABLE_FILE_BYTES,
  max_readable_file_bytes: LIMITS.MAX_READABLE_FILE_BYTES,
  read_token_ttl_ms: LIMITS.READ_TOKEN_TTL_MS,
};

export interface ReadDeps {
  readonly ops: WinfsOps;
  readonly authority: ReadTicketAuthority;
  readonly budget: EgressBudget;
  /** 本地操作者收紧后的限额；省略即用默认值。 */
  readonly limits?: Partial<ReadLimits>;
}

export interface ReadFileArgs {
  readonly scope: ReadScope;
  /** 本次调用所属的连接，来自凭据。票据绑定它，跨连接重放因此不可行。 */
  readonly connection_id: string;
  /** daemon 对本次读取的判定结果。必须由 `@lwb/policy` 的 `decide()` 产出。 */
  readonly decision: PolicyDecision;
  readonly input: FileReadInput;
  /** 本地时钟（epoch ms）。本模块不读时钟。 */
  readonly now: number;
}

export interface StatFileArgs {
  readonly scope: ReadScope;
  readonly connection_id: string;
  readonly decision: PolicyDecision;
  /** 工作区相对路径。单文件工作区用空串。 */
  readonly path: string;
  readonly now: number;
}

function limitsOf(deps: ReadDeps): ReadLimits {
  return { ...DEFAULT_READ_LIMITS, ...(deps.limits ?? {}) };
}

// ---------------------------------------------------------------------------
// 受控载入：探针 → 读取 → 比对
// ---------------------------------------------------------------------------

interface LoadedBytes {
  readonly bytes: Buffer;
  readonly sha256: string;
  readonly canonical_path: string | null;
  readonly identity: GuardTarget['identity'];
  readonly size: number;
  readonly attribute_names: readonly string[];
}

/** 第一步：只取身份与尺寸，**不读内容**（后端在 resolvePath 上不返回字节）。 */
async function probeGuarded(
  ops: WinfsOps,
  scope: ReadScope,
  path: string,
  limits: ReadLimits,
): Promise<GuardTarget> {
  const target = await resolveTarget(ops, scope, path, 'file');

  const size = target.size;
  if (size > limits.max_readable_file_bytes) {
    // 尺寸预检的全部意义就在这里：受控句柄只提供整文件读取，所以「先读进来
    // 再判断是不是太大」等于没有上限。
    throw new BridgeError(
      'SIZE_LIMIT_EXCEEDED',
      `文件大小 ${size} 字节超过单次读取上限 ${limits.max_readable_file_bytes} 字节；` +
        '本版本不提供超大文件的分页读取。',
      { size, limit_bytes: limits.max_readable_file_bytes, limit: 'MAX_READABLE_FILE_BYTES' },
    );
  }

  return target;
}

/**
 * 第三步：读取字节，并与探针比对。
 *
 * 比对的是**句柄上的身份**，不是路径字符串（I03）。路径字符串在这里帮不上忙：
 * 一个大小写不同的拼写、一个 8.3 短名都会解析到同一个对象，而我们要抓的
 * 恰好是「同一串字符现在指向了另一个对象」。
 */
async function readGuarded(ops: WinfsOps, scope: ReadScope, path: string, probe: GuardTarget): Promise<LoadedBytes> {
  const result = await ops.readFileGuarded(refOf(scope, path));
  if (isWinfsError(result)) throw toBridgeError(result);

  if (
    result.identity.volume_id !== probe.identity.volume_id ||
    result.identity.file_id !== probe.identity.file_id ||
    result.size !== probe.size
  ) {
    throw new BridgeError(
      'FILE_VERSION_CONFLICT',
      '文件在本次读取的两次打开之间被替换或改动，已放弃本次读取；请重新读取。',
      {
        reason: 'identity_changed_between_opens',
        size_before: probe.size,
        size_after: result.size,
      },
    );
  }

  return {
    bytes: Buffer.from(result.bytes_base64, 'base64'),
    sha256: result.sha256,
    canonical_path: result.canonical_relative_path,
    identity: result.identity,
    size: result.size,
    attribute_names: result.attributes.names,
  };
}

// ---------------------------------------------------------------------------
// 分页
// ---------------------------------------------------------------------------

interface PagePlan {
  readonly start_line: number;
  readonly end_line_exclusive: number;
  readonly content: string;
  readonly truncated_lines: readonly number[];
  readonly truncated: boolean;
  readonly has_more: boolean;
}

/**
 * 规划一页。
 *
 * 三条硬约束，每一条都对应一个具体的坏结果：
 *
 *  - **一页至少装一行。** 否则当第一行就超过正文上限时，读取会永远返回空，
 *    而模型没有任何办法推进 —— 一个「看起来在工作、实际读不到东西」的死锁。
 *  - **单行超过 `max_line_bytes` 就按上限截断，且该行结束本页。**
 *    截断之后行号仍然真实（第 n 行还是第 n 行），但它的内容不再是原文，
 *    因此它之后的内容不能与它混在同一段「逐字来自磁盘」的正文里。
 *    这也让 `truncated_lines` 天然最多一个元素 —— 契约要求它升序去重，
 *    而这里按构造就满足，不靠事后去重。
 *  - **被截断的行不带行终止符。** 补一个换行会凭空造出一行磁盘上不存在的
 *    内容边界，而调用方唯一能据以判断「这一行到哪为止」的依据就是那个换行。
 *
 * 超出正文字节上限时同样结束本页（除非本页还空着，见第一条）。因此实际返回
 * 的字节数可能比 `max_response_body_bytes` 多**一行，至多 `max_line_bytes`** ——
 * 这是有界的，且只在操作者把两个上限配成互相矛盾的值时才可能发生。
 */
function planPage(text: string, lines: LineIndex, startLine: number, maxLines: number, limits: ReadLimits): PagePlan {
  const total = lines.total_lines;
  const start = Math.max(1, Math.trunc(startLine));
  const chunks: string[] = [];
  const truncatedLines: number[] = [];
  let end = start;
  let bytes = 0;
  let hasMore = false;

  while (end <= total) {
    const raw = lineText(text, lines, end);

    if (utf8Bytes(raw) > limits.max_line_bytes) {
      if (chunks.length > 0) {
        hasMore = true;
        break;
      }
      const cut = truncateToBytes(raw, limits.max_line_bytes);
      chunks.push(cut);
      truncatedLines.push(end);
      bytes += utf8Bytes(cut);
      end += 1;
      hasMore = end <= total;
      break;
    }

    const piece = raw + lineTerminator(lines, end);
    const pieceBytes = utf8Bytes(piece);
    if (chunks.length > 0 && bytes + pieceBytes > limits.max_response_body_bytes) {
      hasMore = true;
      break;
    }
    chunks.push(piece);
    bytes += pieceBytes;
    end += 1;

    if (chunks.length >= maxLines) {
      hasMore = end <= total;
      break;
    }
  }

  return {
    start_line: start,
    end_line_exclusive: end,
    content: chunks.join(''),
    truncated_lines: truncatedLines,
    // 「content 不等于整个文件」的三种情形，缺一不可。注意空文件：
    // total = 0、start = 1、end = 1，三项都不成立 → truncated = false，
    // 因为一次空读取**确实**就是整个文件。
    truncated: start > 1 || end - 1 < total || truncatedLines.length > 0,
    has_more: hasMore,
  };
}

// ---------------------------------------------------------------------------
// 读取
// ---------------------------------------------------------------------------

export async function readFile(args: ReadFileArgs, deps: ReadDeps): Promise<FileReadData> {
  const limits = limitsOf(deps);
  const { scope, connection_id, decision, input, now } = args;

  if (decision.context.workspace_id !== scope.workspace_id) {
    throw new BridgeError('INVALID_ARGUMENT', '判定结果与本次读取的工作区不一致；拒绝执行。', {
      reason: 'DECISION_SCOPE_MISMATCH',
    });
  }

  // 参数形态先判（见文件头最后一条）。这两个检查不依赖磁盘，因此没有理由
  // 让它们排在一次文件打开之后。
  const maxLines = clampMaxLines(input.max_lines, limits.max_read_lines);
  const explicitStart = parseStartLine(input.start_line);

  const probe = await probeGuarded(deps.ops, scope, input.path, limits);
  const clearance = mintClearance(decision, { connection_id, generation: scope.generation });

  // 预检：一个字节都还没读，先问闸门「这个路径有没有资格往外走内容」。
  // 载荷为空，因此这次调用不消耗任何出站预算（记账按实际出站字节数）。
  emitContent(clearance, { path: gatePathFor(scope, probe.canonical_path), content: '' }, deps.budget);

  const loaded = await readGuarded(deps.ops, scope, input.path, probe);

  const inspection = inspectBytes(loaded.bytes);
  if (inspection.kind !== 'text') {
    throw new BridgeError(
      inspection.kind === 'binary' ? 'BINARY_UNSUPPORTED' : 'ENCODING_UNSUPPORTED',
      inspection.detail,
      { reason: inspection.reason, size: loaded.size },
    );
  }

  const startLine = resolveStartLine(loaded, scope, connection_id, input.cursor, explicitStart, deps, now);
  const page = planPage(inspection.text, inspection.lines, startLine, maxLines, limits);

  // 最终出站。用的是**这次读取结果里的**规范路径：预检之后万一发生了改名
  // （file_id 不变，因此身份比对通过），判定必须落在新名字上。
  const emission = emitContent(
    clearance,
    { path: gatePathFor(scope, loaded.canonical_path), content: page.content },
    deps.budget,
  );

  const blockers = editableBlockers(loaded, inspection, page, emission, clearance, now, limits);
  const editable = blockers.length === 0;
  const canonicalPath = loaded.canonical_path ?? '';

  const facts: ReadTicketFacts = {
    connection_id,
    workspace_id: scope.workspace_id,
    generation: scope.generation,
    canonical_path: canonicalPath,
    volume_id: loaded.identity.volume_id,
    file_id: loaded.identity.file_id,
    raw_bytes_sha256: loaded.sha256,
    size: loaded.size,
    total_lines: inspection.lines.total_lines,
    range_start: page.start_line,
    range_end_exclusive: page.end_line_exclusive,
    truncated: page.truncated,
    truncated_lines: page.truncated_lines,
    editable,
    editable_blockers: blockers,
    redacted: emission.redacted,
  };

  const readToken = deps.authority.mintReadTicket(facts, { now, ttl_ms: limits.read_token_ttl_ms });
  const nextCursor = page.has_more
    ? deps.authority.mintCursor(
        {
          connection_id,
          workspace_id: scope.workspace_id,
          generation: scope.generation,
          canonical_path: canonicalPath,
          volume_id: loaded.identity.volume_id,
          file_id: loaded.identity.file_id,
          raw_bytes_sha256: loaded.sha256,
          next_start_line: page.end_line_exclusive,
        },
        { now, ttl_ms: limits.read_token_ttl_ms },
      )
    : null;

  return {
    // 回执里的路径用**磁盘规范拼写**，不回显请求字符串。理由是 I14：
    // 一份对不上文件系统的回执没有意义 —— 模型拿着它发起下一次调用时，
    // 用的是磁盘真正认识的那个名字。单文件工作区因此回的是空串，
    // 而空串正是它下一次调用该给的值。
    path: canonicalPath,
    source: 'disk',
    sha256: loaded.sha256,
    encoding: inspection.encoding,
    bom: inspection.bom,
    newline: inspection.newline,
    start_line: page.start_line,
    end_line_exclusive: page.end_line_exclusive,
    total_lines: inspection.lines.total_lines,
    truncated: page.truncated,
    truncated_lines: page.truncated_lines,
    consistency: 'per_file',
    read_token: readToken as ReadToken,
    next_cursor: nextCursor as Cursor | null,
    content: emission.content,
    bytes_returned: emission.bytes,
    redacted: emission.redacted,
    editable,
    editable_blockers: blockers,
  };
}

/** `max_lines` 只能**收紧**，不能扩大：契约的 `MAX_READ_LINES` 是上限，不是默认值。 */
function clampMaxLines(requested: number | undefined, hardLimit: number): number {
  if (requested === undefined) return hardLimit;
  if (!Number.isInteger(requested) || requested < 1) {
    throw new BridgeError('INVALID_ARGUMENT', 'max_lines 必须是 >= 1 的整数。', { reason: 'INVALID_MAX_LINES' });
  }
  return Math.min(requested, hardLimit);
}

/** 只判形态，不判是否越界 —— 「第 9999 行」在只有 3 行的文件上是一次合法的空读。 */
function parseStartLine(requested: number | undefined): number | null {
  if (requested === undefined) return null;
  if (!Number.isInteger(requested) || requested < 1) {
    throw new BridgeError('INVALID_ARGUMENT', 'start_line 必须是 >= 1 的整数。', {
      reason: 'INVALID_START_LINE',
    });
  }
  return requested;
}

/**
 * 起始行来自游标或参数，**游标优先**（契约如此）。
 *
 * 游标里带着两次读取之间必须一致的全部绑定项，其中 `raw_bytes_sha256`
 * 与 `file_id` 是关键：文件变了，从第几行接着读都是**错的**（行号已经错位），
 * 因此这里选择拒绝游标、要求重读，而不是「尽力接着读」。一份行号错位的
 * 正文比一句「请重新读取」危险得多。
 *
 * 它必须在读取**之后**判：`file_id` / `raw_bytes_sha256` 这两项要拿本次
 * 读到的结果去比，先判就只能拿调用方自己的说法比 —— 那等于没判。
 *
 * 游标只承载**起点**，不承载页大小：续读要拿到与上一页同样大的页，必须带上
 * 同样的 `max_lines`。这里不把页大小写进游标，是因为契约把 `max_lines` 定义为
 * 每次调用的参数（`cursor` 只声明「提供时忽略 start_line」）；把页大小偷偷
 * 塞进游标，会让同一个参数在不同调用上含义不同。不过默认值确实是
 * `MAX_READ_LINES`，因此只带游标续读会得到一页**更大**的结果。
 */
function resolveStartLine(
  loaded: LoadedBytes,
  scope: ReadScope,
  connectionId: string,
  inputCursor: string | undefined,
  explicitStart: number | null,
  deps: ReadDeps,
  now: number,
): number {
  if (inputCursor !== undefined && inputCursor !== null && inputCursor !== '') {
    const cursor = deps.authority.verifyCursor(inputCursor, { now });
    const mismatch = (reason: string, message: string): never => {
      throw new BridgeError('READ_TOKEN_STALE', message, { reason });
    };
    if (cursor.connection_id !== connectionId) {
      mismatch('CURSOR_CROSS_CONNECTION', '该分页游标属于另一条连接；请重新读取该文件。');
    }
    if (cursor.workspace_id !== scope.workspace_id) {
      mismatch('CURSOR_CROSS_WORKSPACE', '该分页游标属于另一个工作区；请重新读取该文件。');
    }
    if (cursor.generation !== scope.generation) {
      mismatch('CURSOR_GENERATION_MISMATCH', '工作区代次已变化，该分页游标失效；请重新读取。');
    }
    if (
      cursor.canonical_path !== (loaded.canonical_path ?? '') ||
      cursor.file_id !== loaded.identity.file_id ||
      cursor.volume_id !== loaded.identity.volume_id
    ) {
      mismatch('CURSOR_TARGET_CHANGED', '该分页游标对应的不是当前这个文件对象；请重新读取。');
    }
    if (cursor.raw_bytes_sha256 !== loaded.sha256) {
      mismatch('CURSOR_VERSION_MISMATCH', '文件自上一页之后已变化，行号可能已错位；请从头重新读取。');
    }
    return cursor.next_start_line;
  }

  return explicitStart ?? 1;
}

/**
 * 可编辑裁定。
 *
 * ## 为什么「分页读取」**不**使结果不可编辑
 *
 * 契约里 `editable` 的说明是「该文件是否可被编辑」，而方案 §6.3 的规则是
 * 「编辑区间必须在读取票据的**已见范围**内」。两者合起来只有一种自洽的实现：
 * 票据绑定实际返回的行范围，编辑必须落在这个范围里（`coversEditRange`）。
 * 若把「本次没返回整个文件」直接判成不可编辑，那么任何超过 400 行的文件都
 * 永远无法编辑 —— `edit_text` 在真实项目上完全不可用，而 §6.3 那句
 * 「必须在已见范围内」也就失去了对象。
 *
 * 换句话说：**不可编辑性的来源是「这段正文不能作为基线」，不是「这段正文只是
 * 一部分」**。行号错位、被截断、被脱敏、混用换行都属于前者；分页不属于。
 * 这条解释记在 `docs/evidence/lwb-013/summary.md` 里，供后续任务复核。
 */
function editableBlockers(
  loaded: LoadedBytes,
  inspection: DecodedText,
  page: PagePlan,
  emission: Emission,
  clearance: Clearance,
  now: number,
  limits: ReadLimits,
): readonly string[] {
  const blockers: string[] = [];

  if (inspection.newline === 'mixed') {
    blockers.push('文件混用多种换行风格（或含单独 CR）；写回会静默改变其它行的字节，因此不提供编辑。');
  }
  if (loaded.size > limits.max_editable_file_bytes) {
    blockers.push(
      `文件 ${loaded.size} 字节超过可编辑上限 ${limits.max_editable_file_bytes} 字节；仍可读取，但不能提出修改。`,
    );
  }
  if (page.truncated_lines.length > 0) {
    blockers.push(
      `第 ${page.truncated_lines.join('、')} 行超过单行上限 ${limits.max_line_bytes} 字节，已按上限截断；` +
        '截断后的正文不是磁盘原文，不能作为编辑基线。',
    );
  }
  if (loaded.identity.link_count > 1) {
    blockers.push(`该文件有 ${loaded.identity.link_count} 个硬链接；写入会同时改变工作区外的另一个名字，V1 保守拒绝。`);
  }
  if (loaded.attribute_names.includes('readonly')) {
    blockers.push('文件带只读属性；写入会因权限被拒，因此不提供编辑提议。');
  }

  // 出站层是「脱敏过的读取不能换成可编辑」这条的**唯一**裁定者：
  // 票据拿不到时，本模块不做第二套判断，只把原因如实转述。
  const ticket = mintEditTicket(clearance, emission, { now });
  if (ticket === null) {
    blockers.push(editableBlockerFor(ticket, emission) ?? '本次读取未获得可编辑票据。');
  }
  if (emission.redacted) {
    // 脱敏是把命中片段整段换成 `[REDACTED:…]`，命中可能跨行（私钥块就是），
    // 于是返回正文的行号不再与磁盘一一对应。这一条必须在，否则模型会拿一份
    // 「行号已经错位」的正文去向用户解释第几行是什么。
    blockers.push('脱敏替换会改写命中片段（可能跨行），返回正文的行号不再与磁盘一一对应。');
  }

  return blockers;
}

// ---------------------------------------------------------------------------
// 元数据预检
// ---------------------------------------------------------------------------

/**
 * 只返回元数据，不返回正文。
 *
 * 三个刻意的性质：
 *
 *  - **它读得到字节，但一个字节都不出站。** 因此它照样要经过出站闸门 ——
 *    用一份空载荷过闸门，问的是「这个路径有没有资格往外走内容」，
 *    答案与载荷大小无关。少了这一步，`file_stat` 就会成为 `.env` 的
 *    存在性/大小/哈希探针（I04 的那种形态）。
 *  - **它不签发读取票据。** 契约里 `FileStatData` 根本没有这个字段，
 *    于是「拿 stat 的结果去编辑」在类型上就不可能 —— 不需要靠约定。
 *  - 它同样做两次打开的身份比对，理由与 `readFile` 相同。
 *
 * `sha256` 要求读完整份字节，因此尺寸上限同样适用于它。
 */
export async function statFile(args: StatFileArgs, deps: ReadDeps): Promise<FileStatData> {
  const limits = limitsOf(deps);
  const { scope, connection_id, decision, path } = args;

  if (decision.context.workspace_id !== scope.workspace_id) {
    throw new BridgeError('INVALID_ARGUMENT', '判定结果与本次读取的工作区不一致；拒绝执行。', {
      reason: 'DECISION_SCOPE_MISMATCH',
    });
  }

  const probe = await probeGuarded(deps.ops, scope, path, limits);
  const clearance = mintClearance(decision, { connection_id, generation: scope.generation });
  emitContent(clearance, { path: gatePathFor(scope, probe.canonical_path), content: '' }, deps.budget);

  const loaded = await readGuarded(deps.ops, scope, path, probe);
  const inspection = inspectBytes(loaded.bytes);

  const encoding: FileEncoding = inspection.kind === 'text' ? inspection.encoding : 'unknown';
  const newline: NewlineStyle = inspection.kind === 'text' ? inspection.newline : 'none';
  const blockers: string[] = [];

  if (inspection.kind !== 'text') {
    blockers.push(inspection.detail);
  } else {
    if (inspection.newline === 'mixed') blockers.push('文件混用多种换行风格（或含单独 CR）。');
    if (loaded.size > limits.max_editable_file_bytes) {
      blockers.push(`文件 ${loaded.size} 字节超过可编辑上限 ${limits.max_editable_file_bytes} 字节。`);
    }
  }
  if (loaded.identity.link_count > 1) {
    blockers.push(`该文件有 ${loaded.identity.link_count} 个硬链接；V1 保守拒绝写入。`);
  }
  if (loaded.attribute_names.includes('readonly')) blockers.push('文件带只读属性。');
  // 即使其余一切正常，stat 也不构成可编辑授权：它没有票据。这不是缺陷，
  // 而是这个操作的定位 —— 它回答「值不值得读」，不回答「能不能改」。
  blockers.push('元数据预检不签发读取票据；编辑前必须先 file_read。');

  return {
    path: loaded.canonical_path ?? '',
    source: 'disk',
    sha256: loaded.sha256,
    size: loaded.size,
    encoding,
    bom: inspection.kind === 'text' ? inspection.bom : false,
    newline,
    editable: false,
    editable_blockers: blockers,
    consistency: 'per_file',
  };
}
