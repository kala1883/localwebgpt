/**
 * 精确文本编辑契约（LWB-019 步骤 1、3、4；方案 §6.3）。
 *
 * ## 这个文件只回答一个问题：**这份提案本身自洽吗**
 *
 * 它不看磁盘、不写任何东西、也不产生最终字节。它做的是那些
 * **只有契约层能做得对**的判定：
 *
 *  - 每条 `edit_text` / `replace_text` 携带的读取票据是不是本服务签发的、
 *    是不是**这条连接**在**这个工作区代次**下、对**这个路径**读到的那个版本；
 *  - 行区间是不是落在那张票据**真的返回过**的行范围内（而不是落在
 *    「模型以为它读过」的地方）；
 *  - 同一份提案里有没有对**同一个文件**的第二次操作（无论换路径拼写、
 *    换大小写，还是换一条指向同一物理文件的别名）；
 *  - 结构上不可能匹配的输入（空路径、带换行符的行元素、重叠区间、
 *    插入却带 `old_lines`）在**碰到任何字节之前**就被拒绝。
 *
 * 真正的字节落地在 `text-engine.ts`。分成两个文件的理由是判据不同：
 * 这里全部是「提案 vs 票据」的关系，那里全部是「提案 vs 基线字节」的关系。
 * 混在一起，会让「票据校验」这类安全判定和「第几行对不上」这类业务判定
 * 共享一条错误路径 —— 而它们的处置完全不同（前者是重读，后者是冲突）。
 *
 * ## 为什么票据必须由调用方当场给出「当前事实」
 *
 * `connection_id` 来自**已认证的 IPC 通道身份**（ADR-003 §4），
 * `workspace_id` / `generation` 来自工作区记录 —— 三者**都不是**请求体里的字段。
 * 工具参数里的 `user_id` / `session_id` / `conversation_label` 在这里一个字
 * 都不参与判定：它们最多进审计的 `metadata`。`approved: true` 同理：
 * 本文件里没有、也不会有任何接受它的入口 —— 唯一的批准来源是 `approvals`
 * 表里那条与修改集摘要绑定的记录（LWB-021）。
 */

import { BridgeError } from '@lwb/contracts';
import { LIMITS, validateRelativePath } from '@lwb/contracts';
import type { ChangeOp, LineEdit, WritableNewlineStyle } from '@lwb/contracts';
import { assertReadTokenMatches, coversEditRange } from '@lwb/files';
import type { ReadTicketAuthority, ReadTicketPayload } from '@lwb/files';

/** 与 `tools.ts` 的 `base_sha256` 同一条正则：64 位小写十六进制。 */
const SHA256_HEX = /^[0-9a-f]{64}$/;

/** 结构化文案里回显路径与行号的辅助（**绝不回显文件内容**）。 */
function invalid(reason: string, message: string, extra: Readonly<Record<string, string | number | boolean | null>> = {}): BridgeError {
  return new BridgeError('INVALID_ARGUMENT', message, { reason, ...extra });
}

function stale(reason: string, message: string, extra: Readonly<Record<string, string | number | boolean | null>> = {}): BridgeError {
  return new BridgeError('READ_TOKEN_STALE', message, { reason, ...extra });
}

// ---------------------------------------------------------------------------
// 入参事实
// ---------------------------------------------------------------------------

/**
 * 校验一份提案时，daemon 必须**当场**给出的当前事实。
 *
 * 前三项是身份：它们只能来自已认证的通道与工作区记录。把这三项放在一个
 * 由调用方填的对象里，而不是从 `items` 里读，是刻意的 —— 后者会让
 * 「调用方传错」与「模型伪造」变成同一件事。
 */
export interface ChangeValidationContext {
  readonly connection_id: string;
  readonly workspace_id: string;
  readonly generation: number;
  /** 本地时钟（epoch ms）。本模块不读时钟。 */
  readonly now: number;
  /** 票据权威。生产上由 daemon 从 `@lwb/secure-store` 取密钥后构造。 */
  readonly authority: ReadTicketAuthority;
  /** 覆盖可编辑文件字节上限（默认 `LIMITS.MAX_EDITABLE_FILE_BYTES`）。 */
  readonly max_editable_file_bytes?: number;
}

// ---------------------------------------------------------------------------
// 校验结果
// ---------------------------------------------------------------------------

/** 一条提案指向的目标。`create_text` 还没有物理身份，因此两项为 null。 */
export interface ChangeTarget {
  readonly path: string;
  readonly op: ChangeOp;
  readonly volume_id: string | null;
  readonly file_id: string | null;
}

export interface ValidatedEditText {
  readonly op: 'edit_text';
  readonly path: string;
  readonly base_sha256: string;
  readonly ticket: ReadTicketPayload;
  /** 已按 `start_line` 升序、且已证明两两不冲突。 */
  readonly edits: readonly LineEdit[];
}

export interface ValidatedCreateText {
  readonly op: 'create_text';
  readonly path: string;
  readonly content: string;
  readonly newline: WritableNewlineStyle;
  readonly bom: boolean;
}

export interface ValidatedReplaceText {
  readonly op: 'replace_text';
  readonly path: string;
  readonly base_sha256: string;
  readonly ticket: ReadTicketPayload;
  readonly content: string;
}

export type ValidatedChangeItem = ValidatedEditText | ValidatedCreateText | ValidatedReplaceText;

export interface ChangePlan {
  readonly items: readonly ValidatedChangeItem[];
  readonly targets: readonly ChangeTarget[];
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

/**
 * 校验整个修改项列表。任一条不成立即抛错，**不返回部分结果**：
 * 一份「三份文件里两份合法」的提案交给人去批准，是没有意义的。
 */
export function validateChangeItems(items: unknown, context: ChangeValidationContext): ChangePlan {
  if (!Array.isArray(items) || items.length === 0) {
    throw invalid('CHANGE_ITEMS_EMPTY', '修改项列表不能为空。');
  }
  if (items.length > LIMITS.MAX_CHANGE_FILES) {
    throw invalid('TOO_MANY_CHANGE_FILES', `一个修改集最多包含 ${LIMITS.MAX_CHANGE_FILES} 个文件，本次 ${items.length} 个。`, {
      limit: LIMITS.MAX_CHANGE_FILES,
      actual: items.length,
    });
  }

  const validated: ValidatedChangeItem[] = [];
  for (const raw of items) {
    validated.push(validateItem(raw, context));
  }
  const targets = validated.map(targetOf);
  assertDistinctTargets(targets);

  return Object.freeze({ items: Object.freeze(validated), targets: Object.freeze(targets) });
}

/**
 * 同一份提案里不得出现对**同一个文件**的两次操作（验收标准 3）。
 *
 * ## 两道判据，缺一不可
 *
 *  - **路径层**：`A.ts` 与 `a.ts` 在 NTFS 上是同一个文件，按字节比会放过
 *    一对「看起来是两份文件」的重复操作。这里按大小写不敏感比对，
 *    方向是保守的（宁可把两个真实不同的名字判成重复，也不要漏过一次重复写入）。
 *  - **身份层**：硬链接、8.3 短名、目录联接 —— 两个**拼写完全不同**的路径
 *    指向同一份字节。路径层对这一类无能为力，只能靠票据里的
 *    `volume_id` / `file_id`。`create_text` 没有这两个字段（文件还不存在），
 *    因此它只受路径层约束，这是它唯一可能的一处盲区，写在 `docs/PROGRESS.md`
 *    的偏离项里。
 *
 * 单独导出是为了 LWB-020：prepare 会**重新**探测每个目标的身份，
 * 那时拿到的是当场事实，值得用同一个函数再判一次。
 */
export function assertDistinctTargets(targets: readonly ChangeTarget[]): void {
  const byPath = new Map<string, ChangeTarget>();
  for (const target of targets) {
    const key = target.path.toLowerCase();
    const seen = byPath.get(key);
    if (seen !== undefined) {
      throw invalid(
        'DUPLICATE_TARGET_PATH',
        `同一个文件在一次修改集里出现了两次（${seen.path} 与 ${target.path}）；请合并成一个修改项。`,
        { path: target.path },
      );
    }
    byPath.set(key, target);
  }

  const byIdentity = new Map<string, ChangeTarget>();
  for (const target of targets) {
    if (target.volume_id === null || target.file_id === null) continue;
    const key = `${target.volume_id}:${target.file_id}`;
    const seen = byIdentity.get(key);
    if (seen !== undefined) {
      throw invalid(
        'DUPLICATE_TARGET_FILE',
        `两个不同的路径指向同一个文件（${seen.path} 与 ${target.path}）；一次修改集里只能操作它一次。`,
        { path: target.path },
      );
    }
    byIdentity.set(key, target);
  }
}

function targetOf(item: ValidatedChangeItem): ChangeTarget {
  if (item.op === 'create_text') {
    return Object.freeze({ path: item.path, op: item.op, volume_id: null, file_id: null });
  }
  return Object.freeze({
    path: item.path,
    op: item.op,
    volume_id: item.ticket.volume_id,
    file_id: item.ticket.file_id,
  });
}

// ---------------------------------------------------------------------------
// 逐项校验
// ---------------------------------------------------------------------------

function validateItem(raw: unknown, context: ChangeValidationContext): ValidatedChangeItem {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw invalid('CHANGE_ITEM_NOT_OBJECT', '修改项必须是对象。');
  }
  const item = raw as Record<string, unknown>;

  // 路径先判：后面每一条诊断都会带上它，而一个非法路径让其余判定都没有意义。
  const path = requirePath(item['path']);

  switch (item['op']) {
    case 'edit_text':
      return validateEditText(item, path, context);
    case 'create_text':
      return validateCreateText(item, path);
    case 'replace_text':
      return validateReplaceText(item, path, context);
    default:
      throw invalid('UNKNOWN_CHANGE_OP', `不支持的修改类型 ${JSON.stringify(item['op'])}；只支持 edit_text / create_text / replace_text。`);
  }
}

/**
 * 空路径**在这里被明确拒绝**（LWB-019 步骤 4）。
 *
 * 代价是**单文件工作区提不出任何修改**：那种工作区里唯一的位置就是空串
 * （`file_read` 对它回的就是空串）。这不是遗漏，是取舍：
 * `create_text` 的空路径意味着「把工作区根创建成一个文件」，而根是那个文件
 * 本身；`edit_text` 的空路径与「相对路径语法错误」在字符串上不可区分。
 * 两害相权，V1 选择「单文件工作区暂时不能改」，并把这条记进偏离项 56 ——
 * 缺口的方向是保守的，且它会以一条明确的 `EMPTY` 出现，不是静默失效。
 */
function requirePath(input: unknown): string {
  const result = validateRelativePath(input);
  if (!result.ok) {
    throw invalid('CHANGE_PATH_INVALID', `修改项的 path 不合法：${result.detail}`, {
      path_reason: result.reason,
    });
  }
  return result.normalized;
}

function requireSha256(input: unknown): string {
  if (typeof input !== 'string' || !SHA256_HEX.test(input)) {
    throw invalid('BASE_SHA256_INVALID', 'base_sha256 必须是 file_read 返回的 64 位小写十六进制整文件哈希。');
  }
  return input;
}

/**
 * 验证票据本身，并把它与**当场事实**对上。
 *
 * 顺序说明：`verifyReadTicket` 先做签名与有效期（它可能抛 `READ_TOKEN_STALE`），
 * 随后 `assertReadTokenMatches` 才比身份与基线。反过来会让一张**伪造的**
 * 票据先得到一句「路径不对」—— 那句话暗示票据本身是可信的。
 */
function requireReadToken(
  raw: unknown,
  context: ChangeValidationContext,
  path: string,
  baseSha256: string,
  requireEditable: boolean,
): ReadTicketPayload {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw invalid('READ_TOKEN_MISSING', '缺少 file_read 签发的读取票据。');
  }
  const ticket = context.authority.verifyReadTicket(raw, { now: context.now });
  assertReadTokenMatches(ticket, {
    connection_id: context.connection_id,
    workspace_id: context.workspace_id,
    generation: context.generation,
    path,
    base_sha256: baseSha256,
    ...(requireEditable ? { require_editable: true } : {}),
  });

  // 尺寸这一条**故意**在这里再查一遍，而且查的是票据上的 `size` 而不是
  // 磁盘：`file_read` 已经把「超过可编辑尺寸」写进了 `editable_blockers`，
  // 按道理 `require_editable` 就挡住了。再查一遍是因为上限本身是**可调**的
  // （daemon 可以配一个比 `MAX_EDITABLE_FILE_BYTES` 更小的值），
  // 而票据里记的是签发那一刻的裁定 —— 上限调小之后，一张昨天签发的
  // 票据不该继续按昨天的限额生效。
  const maxBytes = context.max_editable_file_bytes ?? LIMITS.MAX_EDITABLE_FILE_BYTES;
  if (ticket.size > maxBytes) {
    throw new BridgeError(
      'SIZE_LIMIT_EXCEEDED',
      `该文件有 ${ticket.size} 字节，超过可编辑上限 ${maxBytes} 字节；本文件不能在原地修改。`,
      { reason: 'FILE_TOO_LARGE_FOR_EDIT', path, size: ticket.size, limit: maxBytes },
    );
  }
  return ticket;
}

function validateEditText(
  item: Record<string, unknown>,
  path: string,
  context: ChangeValidationContext,
): ValidatedEditText {
  const baseSha256 = requireSha256(item['base_sha256']);
  // `require_editable` 在这里一次挡住四类基线：脱敏结果、被 `MAX_LINE_BYTES`
  // 截断的行、超过可编辑尺寸、混用换行（含单独 CR）、硬链接与只读属性。
  // 它们全部由 `file_read` 在**签发票据时**裁定并写进 `editable_blockers`，
  // 本模块只转述，不另立一套判据 —— 两套判据迟早会分叉。
  const ticket = requireReadToken(item['read_token'], context, path, baseSha256, true);
  const edits = requireEdits(item['edits'], ticket);
  return Object.freeze({ op: 'edit_text', path, base_sha256: baseSha256, ticket, edits });
}

function validateCreateText(item: Record<string, unknown>, path: string): ValidatedCreateText {
  const content = requireWritableContent(item['content'], 'create_text');
  const newline = item['newline'];
  if (newline !== 'lf' && newline !== 'crlf') {
    throw invalid('NEWLINE_STYLE_INVALID', 'create_text 的 newline 只能是 lf 或 crlf（mixed / none 不是可指定的写入风格）。');
  }
  const bom = item['bom'];
  if (typeof bom !== 'boolean') {
    throw invalid('BOM_NOT_BOOLEAN', 'create_text 的 bom 必须是布尔值。');
  }
  return Object.freeze({ op: 'create_text', path, content, newline, bom });
}

function validateReplaceText(
  item: Record<string, unknown>,
  path: string,
  context: ChangeValidationContext,
): ValidatedReplaceText {
  const baseSha256 = requireSha256(item['base_sha256']);
  const ticket = requireReadToken(item['read_token'], context, path, baseSha256, true);

  // 整文件替换的三个前提（步骤 3）。脱敏与不可编辑已经由 `editable` 挡住
  // （`editable_blockers` 里就是「内容因敏感信息策略被脱敏」那句），
  // 这里补的是**「读全了没有」**这一条 —— 它不会被 `editable` 反映：
  // 一个两百行文件读到第 40 行时，`truncated` 为 true 而 `editable` 仍为 true。
  if (ticket.truncated) {
    throw stale('REPLACE_RESULT_TRUNCATED', '整文件替换需要一次读完整个文件；本次读取是分页或有截断，请重新完整读取。');
  }
  if (ticket.range_start !== 1 || ticket.range_end_exclusive !== ticket.total_lines + 1) {
    throw stale(
      'REPLACE_REQUIRES_FULL_READ',
      `整文件替换需要票据覆盖整个文件（共 ${ticket.total_lines} 行），该票据只覆盖第 ${ticket.range_start}–${ticket.range_end_exclusive - 1} 行；请重新完整读取。`,
      { total_lines: ticket.total_lines, range_start: ticket.range_start, range_end_exclusive: ticket.range_end_exclusive },
    );
  }

  const content = requireWritableContent(item['content'], 'replace_text');
  return Object.freeze({ op: 'replace_text', path, base_sha256: baseSha256, ticket, content });
}

// ---------------------------------------------------------------------------
// 行区间
// ---------------------------------------------------------------------------

/**
 * 校验编辑区间并给出**唯一的执行顺序**。
 *
 * ## 排序是按 `start_line` 升序，且这个顺序就是执行顺序
 *
 * 引擎按这个顺序切字节。因此「两条编辑的先后能不能从请求里读出来」
 * 必须在这里就有答案，不能留给引擎去猜。
 *
 * ## 什么算冲突
 *
 *  1. `next.start < prev.end` —— 真重叠，同一行被两个补丁动过；
 *  2. `next.start === prev.end` 且**任一**是零长度区间 —— 共享同一个边界，
 *     而插入的落点与「替换段的末尾」在请求里是同一个数字。两条都写得出来，
 *     但**先后无法从请求里读出来**：先插后替与先替后插给出的字节不同。
 *
 * 相邻的两个非空区间（`[3,5)` 与 `[5,7)`）是允许的：它们不共享任何一行，
 * 顺序也不影响结果。把这一条也拒掉会让「改第 3-4 行和第 5-6 行」这种
 * 完全正常的提案被迫写成一条大区间。
 *
 * 零长度区间（纯插入）的额外要求由 `coversEditRange` 负责：插入点两侧
 * 必须都读过，否则一段没有内容锚点的补丁可以落在一个从没见过的位置。
 */
function requireEdits(raw: unknown, ticket: ReadTicketPayload): readonly LineEdit[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw invalid('EDITS_EMPTY', 'edit_text 至少需要一个编辑区间。');
  }
  if (raw.length > LIMITS.MAX_EDITS_PER_FILE) {
    throw invalid('TOO_MANY_EDITS', `单个文件最多 ${LIMITS.MAX_EDITS_PER_FILE} 个编辑区间，本次 ${raw.length} 个。`, {
      limit: LIMITS.MAX_EDITS_PER_FILE,
      actual: raw.length,
    });
  }

  const edits: LineEdit[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw invalid('EDIT_NOT_OBJECT', '每个编辑区间必须是对象。');
    }
    const e = entry as Record<string, unknown>;
    const start = e['start_line'];
    const end = e['end_line_exclusive'];
    if (!Number.isInteger(start) || !Number.isInteger(end)) {
      throw invalid('EDIT_RANGE_INVALID', '编辑区间的行号必须是整数。');
    }
    const startLine = start as number;
    const endLine = end as number;
    if (startLine < 1 || endLine < startLine) {
      throw invalid(
        'EDIT_RANGE_INVALID',
        `编辑区间 [${startLine}, ${endLine}) 不合法：行号从 1 起始，且结束行不得小于起始行。`,
        { start_line: startLine, end_line_exclusive: endLine },
      );
    }

    const oldLines = requireLineTexts(e['old_lines'], 'old_lines');
    const newLines = requireLineTexts(e['new_lines'], 'new_lines');

    if (startLine === endLine && oldLines.length > 0) {
      // 纯插入在定义上没有「旧内容」。带着 old_lines 的零长度区间是一个
      // 自相矛盾的请求：它要么本该是个替换，要么模型把行号写错了。
      throw invalid(
        'EDIT_INSERT_WITH_OLD_LINES',
        `第 ${startLine} 行的插入区间是零长度的，old_lines 必须为空（收到 ${oldLines.length} 行）。`,
        { start_line: startLine, old_lines: oldLines.length },
      );
    }
    if (oldLines.length !== endLine - startLine) {
      // 结构性数量不符，不是内容比对 —— 内容比对发生在引擎里（要基线字节）。
      throw invalid(
        'EDIT_OLD_LINE_COUNT',
        `第 ${startLine}–${endLine - 1} 行共 ${endLine - startLine} 行，old_lines 给了 ${oldLines.length} 行。`,
        { start_line: startLine, end_line_exclusive: endLine, expected: endLine - startLine, actual: oldLines.length },
      );
    }
    if (!coversEditRange(ticket, startLine, endLine)) {
      // 落在票据没返回过的行上 —— 无论是因为分页没读到、超出了文件末尾，
      // 还是插入点两侧缺一侧。处置都是「重新读」。
      throw stale(
        'EDIT_RANGE_NOT_READ',
        `编辑区间 [${startLine}, ${endLine}) 不在该读取票据返回过的行范围内（第 ${ticket.range_start}–${ticket.range_end_exclusive - 1} 行，共 ${ticket.total_lines} 行）；请重新读取再提出修改。`,
        { start_line: startLine, end_line_exclusive: endLine, range_start: ticket.range_start, range_end_exclusive: ticket.range_end_exclusive },
      );
    }

    edits.push(Object.freeze({ start_line: startLine, end_line_exclusive: endLine, old_lines: oldLines, new_lines: newLines }));
  }

  edits.sort((a, b) => a.start_line - b.start_line || a.end_line_exclusive - b.end_line_exclusive);
  for (let i = 1; i < edits.length; i += 1) {
    const prev = edits[i - 1] as LineEdit;
    const next = edits[i] as LineEdit;
    const prevEmpty = prev.start_line === prev.end_line_exclusive;
    const nextEmpty = next.start_line === next.end_line_exclusive;
    const overlaps = next.start_line < prev.end_line_exclusive;
    const sharesBoundary = next.start_line === prev.end_line_exclusive && (prevEmpty || nextEmpty);
    if (overlaps || sharesBoundary) {
      throw invalid(
        'OVERLAPPING_EDITS',
        `第 ${prev.start_line}–${prev.end_line_exclusive - 1} 行与第 ${next.start_line}–${next.end_line_exclusive - 1} 行的编辑区间冲突或无法确定先后；请合并成一条补丁。`,
        { prev_start: prev.start_line, prev_end: prev.end_line_exclusive, next_start: next.start_line, next_end: next.end_line_exclusive },
      );
    }
  }
  return Object.freeze(edits);
}

/**
 * 行元素：字符串、且不含换行符。
 *
 * 换行由引擎按文件自己的风格统一写回，因此元素里出现 `\r` / `\n` 一定是
 * 把「一行」写成了「两行」—— 那样写回来的字节数与模型看到的行数就对不上了。
 * `\0` 单独一类：它会让写出来的文件当场变成二进制（`inspectBytes` 的判据），
 * 而模型以为自己改的是文本。
 *
 * 单独代理（lone surrogate）也在拒绝之列：`Buffer.from` 会把它**静默**换成
 * `U+FFFD`，于是写进磁盘的字节与提案里的字符不是同一个东西 —— 一个不会报错的错。
 */
function requireLineTexts(raw: unknown, field: string): readonly string[] {
  if (!Array.isArray(raw)) {
    throw invalid('EDIT_LINES_NOT_ARRAY', `${field} 必须是字符串数组。`);
  }
  const out: string[] = [];
  for (const value of raw) {
    if (typeof value !== 'string') {
      throw invalid('EDIT_LINE_NOT_STRING', `${field} 的每个元素都必须是字符串。`);
    }
    if (/[\r\n]/.test(value)) {
      throw invalid('EDIT_LINE_HAS_NEWLINE', `${field} 的元素不能包含换行符；换行风格由目标文件决定，不由提案指定。`);
    }
    if (value.includes('\0')) {
      throw invalid('EDIT_LINE_HAS_NUL', `${field} 的元素包含 NUL 字符；写入后该文件会被判为二进制。`);
    }
    if (!isEncodable(value)) {
      throw invalid('EDIT_LINE_NOT_ENCODABLE', `${field} 的元素包含无法编码的字符（单独代理项）；写入会静默替换成 U+FFFD。`);
    }
    out.push(value);
  }
  return Object.freeze(out);
}

/**
 * 整段内容（`create_text` / `replace_text`）。
 *
 * 只检查「能不能原样写出去」，不检查它的行数或换行风格 ——
 * 那是引擎按目标文件（或 `create_text.newline`）决定的事。
 */
function requireWritableContent(raw: unknown, op: string): string {
  if (typeof raw !== 'string') {
    throw invalid('CONTENT_NOT_STRING', `${op} 的 content 必须是字符串。`);
  }
  if (raw.includes('\0')) {
    throw invalid('CONTENT_HAS_NUL', `${op} 的 content 包含 NUL 字符；写入后该文件会被判为二进制。`);
  }
  if (raw.includes('\r')) {
    // 内容用 `\n` 表达行，换行风格由 newline / 目标文件决定。
    // 放行一个 `\r` 会写出一份 `mixed` 文件，而它从此**不可编辑**。
    throw invalid('CONTENT_HAS_CR', `${op} 的 content 不能包含 CR；请用 \\n 表达换行，写入风格由 newline 或目标文件决定。`);
  }
  if (!isEncodable(raw)) {
    throw invalid('CONTENT_NOT_ENCODABLE', `${op} 的 content 包含无法编码的字符（单独代理项）；写入会静默替换成 U+FFFD。`);
  }
  return raw;
}

/** UTF-16 串能否原样编码成 UTF-8（不受损）。单独代理项一律不行。 */
export function isEncodable(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      i += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

/** 供上层记录审计与风险用：这条提案声明的目标（**不含正文**）。 */
export function describeTargets(plan: ChangePlan): readonly string[] {
  return plan.targets.map((t) => `${t.op}:${t.path}`);
}
