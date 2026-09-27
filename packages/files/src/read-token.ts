/**
 * 读取票据与分页游标（LWB-013 步骤 3、验收标准 3）。
 *
 * ## 为什么是签名载荷，不是「发个随机串记在内存里」
 *
 * 两者都能挡住伪造，差别在**失效方式**：
 *
 *  - 内存表：daemon 重启即全丢。方向上是 fail-closed（旧票据一律作废），
 *    但它同时把「内存表有多大」变成一条新的攻击面 —— 一张无上限的表，
 *    模型读一万个文件就能让 daemon 吃满内存。这恰好是 LWB-013 要防的那类事。
 *  - 签名载荷：无状态，不随读取次数增长，重启后旧票据**依然有效** ——
 *    因此有效期是唯一的失效机制，它必须显式存在（`READ_TOKEN_TTL_MS`）。
 *
 * 方案 §6 的原话是「可用签名载荷实现，避免将每次读取都建成业务对象」，
 * 这里选的正是它。
 *
 * ## 签名覆盖的是**传输中的那串字节**，不是重新序列化的结果
 *
 * `mac = HMAC(key, payloadB64)`，验证时对**收到的** `payloadB64` 原文重算，
 * 通过之后才解析。若改成「解析 → 重新规范化 JSON → 算 MAC」，签名的对象就变成了
 * 规范化函数的像，而那个函数是有损的（`canonicalJson` 会做 NFC 规范化）：
 * 一份 NFD 形式的路径可以被改写成 NFC 形式而签名不变。路径正是本票据的绑定项，
 * 让它在签名之后仍有等价改写空间，等于把 `I03 按身份而非字符串` 反过来用。
 *
 * ## 票据里**没有**的东西，同样是设计
 *
 * 它不包含任何文件正文，也不包含任何能换来批准的东西。它证明的是
 * 「基于哪个版本的哪些行读到了什么」，`change_prepare` 还需要连接自己的凭据
 * 与本地操作者的批准 —— 票据不是授权，只是一份可核对的历史。
 *
 * ## 这里为什么住着**四种**载荷（读取票据 / 读取游标 / 列举游标 / 搜索游标）
 *
 * 判断依据是「谁拿着密钥」，不是「谁在用」。四种载荷共用一把 HMAC 密钥、
 * 一套签名与验证实现、一套有效期规则。把它们拆到各自的包里，意味着
 * daemon 要注入**四把**密钥（或者让某个包拿到另一把密钥的副本）——
 * 前者是一个纯粹多余的配置面，后者是把「密钥只有一处」这条性质毁掉。
 *
 * 换来的是本文件必须为每一种载荷给出：一个前缀、一个 `kind`、一个
 * 字段读取器、一个 `assertXMatches`。四者缺一，那种载荷的校验就会
 * 静默地退化（`requireKind` 会拦住跨种类误用，但拦不住"少了某个绑定项"）。
 * 新增载荷时照着现有的四种抄全，不要只加 mint/verify 两个函数。
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { BridgeError } from '@lwb/contracts';
import { equalPathCaseInsensitive } from '@lwb/contracts';
import type { FileVersion } from '@lwb/contracts';

/** 前缀只为审计可读性，**不是**鉴权依据（与 `packages/contracts/src/ids.ts` 同规矩）。 */
const READ_TOKEN_PREFIX = 'lwbrt_';
const CURSOR_PREFIX = 'lwbc_';
/**
 * 列举游标的前缀与读取游标**刻意不同**。
 *
 * 两者的载荷字段名高度重合（都有 connection/workspace/generation/canonical
 * 路径与身份），只是含义不同：读取游标的 `canonical_path` 是「哪个文件」，
 * 列举游标的是「哪个目录」。前缀相同的话，一次把读取游标交给 `file_list`
 * 的调用会被 `requireKind` 拦下（kind 不同），但拦下之前它已经在
 * 「这是同一个服务的游标」这句话上骗过一次人 —— 而前缀是明文，
 * 它本来就只该用来让审计日志能一眼看出这是哪种值。
 */
const LIST_CURSOR_PREFIX = 'lwblc_';
/** 搜索游标（LWB-015）。第三种载荷，前缀同样自成一种。 */
const SEARCH_CURSOR_PREFIX = 'lwbsq_';
const PAYLOAD_VERSION = 1;
/** 加载时不接受短于这个长度的密钥：16 字节以下对 HMAC-SHA256 没有意义。 */
const MIN_KEY_BYTES = 32;

// ---------------------------------------------------------------------------
// 载荷
// ---------------------------------------------------------------------------

/** 一次读取的**事实**，也是票据绑定的全部内容。 */
export interface ReadTicketFacts {
  readonly connection_id: string;
  readonly workspace_id: string;
  readonly generation: number;
  /** 磁盘规范拼写的工作区相对路径（来自句柄，不是调用方给的字符串）。 */
  readonly canonical_path: string;
  readonly volume_id: string;
  readonly file_id: string;
  /** **整个文件**原始字节的 SHA-256，不是返回片段的哈希。 */
  readonly raw_bytes_sha256: string;
  readonly size: number;
  readonly total_lines: number;
  /** 实际返回的行范围，1 起始、左闭右开。 */
  readonly range_start: number;
  readonly range_end_exclusive: number;
  readonly truncated: boolean;
  readonly truncated_lines: readonly number[];
  /** 本次读取的内容是否可用于编辑。**由出站层裁定**，不是本模块猜的。 */
  readonly editable: boolean;
  readonly editable_blockers: readonly string[];
  readonly redacted: boolean;
}

export interface ReadTicketPayload extends ReadTicketFacts {
  readonly kind: 'read';
  readonly v: number;
  readonly issued_at: number;
  readonly expires_at: number;
}

/** 游标只记录「下一页从哪里开始」，加上足以判断它是否还有效的绑定项。 */
export interface CursorFacts {
  readonly connection_id: string;
  readonly workspace_id: string;
  readonly generation: number;
  readonly canonical_path: string;
  readonly volume_id: string;
  readonly file_id: string;
  readonly raw_bytes_sha256: string;
  readonly next_start_line: number;
}

export interface CursorPayload extends CursorFacts {
  readonly kind: 'cursor';
  readonly v: number;
  readonly issued_at: number;
  readonly expires_at: number;
}

/**
 * 列举游标（LWB-014）。绑定的是「从哪个目录的什么位置继续」。
 *
 * ## 为什么锚点是**路径**而不是「第 N 条」这样的序号
 *
 * 序号（offset 分页）在目录变化时会静默地重复或跳过：翻页途中在靠前的位置
 * 新增一个文件，第 2 页的第一条就是第 1 页已经返回过的那条；删除一个则中间
 * 少一条，而调用方看到的是一个「完整」的列表。路径锚点不会：它表达的是
 * 「已经返回到这个名字为止」，续读只取严格大于它的条目。
 *
 * 代价是一致性更弱（目录里在锚点**之前**发生的增删不会被这次续读看到），
 * 但那正是 `consistency: per_file` 已经声明的事 —— 它不是快照。
 *
 * ## 锚点为什么还要带上「它是不是目录」
 *
 * 遍历是深度优先的**先序**：一个目录条目刚被返回，紧接着的就是它内部的内容。
 * 如果一页正好停在某个目录条目上，续读必须从**它内部**开始，而不是从它的
 * 下一个兄弟开始 —— 否则那个子树的全部内容会被静默跳过，而结果看起来是完整的。
 * 因此续读时要用 `resolvePath` 当场问一次锚点是什么（见 `list.ts` 的 resume）。
 */
export interface ListCursorFacts {
  readonly connection_id: string;
  readonly workspace_id: string;
  readonly generation: number;
  /** 被列举**起点目录**的规范相对路径（磁盘拼写）；空串表示工作区根。 */
  readonly base_path: string;
  /** 起点目录对象的身份。目录被换成另一个同名目录后，游标不该继续用。 */
  readonly base_volume_id: string;
  readonly base_file_id: string;
  /** 本页**最后一条已返回**条目的规范相对路径（工作区相对，`/` 分隔）。 */
  readonly anchor_path: string;
  /** 本次遍历的深度上限。它是查询的一部分：不绑定的话，续读能在更深的地方停下。 */
  readonly depth: number;
}

export interface ListCursorPayload extends ListCursorFacts {
  readonly kind: 'list';
  readonly v: number;
  readonly issued_at: number;
  readonly expires_at: number;
}

/**
 * 搜索游标（LWB-015）。绑定的是「用哪次查询、从哪个文件、从它的第几个命中继续」。
 *
 * ## 为什么进度记到「文件 + 文件内的第几个命中」这一粒度
 *
 * 一次搜索的进度有两层：走到了哪个文件，以及那个文件里的哪些命中已经返回过。
 * 只记文件层不行 —— 一页正好在一个文件中间被填满时，续读会**重发**那个文件
 * 已经返回过的命中（重复），或者跳过它还没返回的（遗漏）。两种结果看起来都
 * 是完整的，而后者比前者危险得多。
 *
 * 记「第几个命中」而不是「从第几行开始」：命中是本次查询的函数，行不是。
 * 若按行续读，一个在上次扫描之后插入到某行上方的匹配会把后续所有命中的
 * 相对位置推移一格，于是续读静默地漏掉一个 —— 而行号仍然对得上，
 * 因为它是从当前磁盘内容重新算的。
 *
 * ## 为什么绑定查询的**摘要**而不是查询原文
 *
 * 游标是签名过的**明文**载荷，会出现在模型的消息里。查询串再出现一次没有
 * 害处（模型本来就知道它），但压成定长摘要能让「游标里都有什么」一眼看完。
 * 它只用于比对，不参与任何授权判定 —— 真正的授权始终是连接凭据与工作区授权。
 */
export interface SearchCursorFacts {
  readonly connection_id: string;
  readonly workspace_id: string;
  readonly generation: number;
  /** 搜索**起点目录**的规范相对路径（磁盘拼写）；空串表示工作区根。 */
  readonly base_path: string;
  readonly base_volume_id: string;
  readonly base_file_id: string;
  /** 查询指纹：查询串 + 大小写开关 + path_glob 的摘要。 */
  readonly query_digest: string;
  /**
   * 下一个要扫的文件：**工作区相对路径**（`/` 分隔，`base_path` 是它的前缀）；
   * 空串表示起点本身是文件工作区。
   *
   * 存工作区相对路径而不是「相对 `base_path` 的那一段」，是因为续读要在
   * **每一层**目录上重新定位这个锚点（见 `walk.ts` 的 `resumeWalk`），
   * 而它定位用的 `cursorAnchorSegments(base_path, anchor)` 要求锚点带着
   * `base_path` 前缀。列举游标的 `anchor_path` 也是同一种拼写 ——
   * 两者共用同一个判定函数，拼写不一致会让其中一个永远判不过。
   */
  readonly resume_path: string;
  /** 在 `resume_path` 里已经返回过的命中数。 */
  readonly skip_matches: number;
}

export interface SearchCursorPayload extends SearchCursorFacts {
  readonly kind: 'search';
  readonly v: number;
  readonly issued_at: number;
  readonly expires_at: number;
}

export interface MintContext {
  /** 本地时钟（epoch ms），由 daemon 传入。本模块不读时钟。 */
  readonly now: number;
  readonly ttl_ms: number;
}

export interface VerifyOptions {
  readonly now: number;
}

// ---------------------------------------------------------------------------
// 权威
// ---------------------------------------------------------------------------

export interface ReadTicketAuthority {
  /**
   * 密钥指纹：足以让人比对「是不是同一把」，不足以反推密钥。
   * 可以安全地写进日志与诊断。
   */
  readonly key_fingerprint: string;
  mintReadTicket(facts: ReadTicketFacts, context: MintContext): string;
  mintCursor(facts: CursorFacts, context: MintContext): string;
  mintListCursor(facts: ListCursorFacts, context: MintContext): string;
  mintSearchCursor(facts: SearchCursorFacts, context: MintContext): string;
  /** 验证并返回载荷。任何一步不成立都抛 `READ_TOKEN_STALE`。 */
  verifyReadTicket(token: unknown, options: VerifyOptions): ReadTicketPayload;
  verifyCursor(token: unknown, options: VerifyOptions): CursorPayload;
  verifyListCursor(token: unknown, options: VerifyOptions): ListCursorPayload;
  verifySearchCursor(token: unknown, options: VerifyOptions): SearchCursorPayload;
}

export interface ReadTicketAuthorityOptions {
  /**
   * HMAC 密钥。生产上由 daemon 从 `@lwb/secure-store` 的 `runtime` 类凭证取出
   * （`CredentialStore.reveal('runtime')`），本模块不负责它的持久化。
   */
  readonly key: Uint8Array | string;
}

export function createReadTicketAuthority(options: ReadTicketAuthorityOptions): ReadTicketAuthority {
  const key = typeof options.key === 'string' ? Buffer.from(options.key, 'utf8') : Buffer.from(options.key);
  if (key.length < MIN_KEY_BYTES) {
    // 抛错而不是「就用这个短密钥吧」：一个能被穷举的 HMAC 密钥会让
    // 「伪造票据被拒绝」这条验收标准在生产环境里悄悄失效。
    throw new Error(`读取票据密钥至少需要 ${MIN_KEY_BYTES} 字节，当前 ${key.length} 字节。`);
  }
  const fingerprint = createHmac('sha256', key).update('lwb-read-ticket-key-id').digest('hex').slice(0, 16);

  function mac(payloadB64: string): string {
    return createHmac('sha256', key).update(payloadB64, 'ascii').digest('base64url');
  }

  function sign(prefix: string, payload: object): string {
    const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    return `${prefix}${payloadB64}.${mac(payloadB64)}`;
  }

  function open(prefix: string, value: unknown): Record<string, unknown> {
    if (typeof value !== 'string') {
      throw stale('TICKET_NOT_A_STRING', '读取票据必须是字符串；请重新读取该文件。');
    }
    if (!value.startsWith(prefix)) {
      throw stale('TICKET_WRONG_PREFIX', '这不是本服务签发的读取票据；请重新读取该文件。');
    }
    const body = value.slice(prefix.length);
    const dot = body.indexOf('.');
    if (dot <= 0) {
      throw stale('TICKET_MALFORMED', '读取票据结构不完整；请重新读取该文件。');
    }
    const payloadB64 = body.slice(0, dot);
    const presented = body.slice(dot + 1);

    // 长度不等时 `timingSafeEqual` 会抛错，因此先比长度。长度本身不是秘密
    // （它是摘要长度的函数），提前返回不泄露任何信息。
    const expectedBuf = Buffer.from(mac(payloadB64), 'base64url');
    const presentedBuf = Buffer.from(presented, 'base64url');
    if (presentedBuf.length !== expectedBuf.length || !timingSafeEqual(presentedBuf, expectedBuf)) {
      throw stale('TICKET_BAD_SIGNATURE', '读取票据的签名不匹配（内容被改动或不是本服务签发）；请重新读取。');
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    } catch {
      throw stale('TICKET_MALFORMED', '读取票据载荷无法解析；请重新读取该文件。');
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw stale('TICKET_MALFORMED', '读取票据载荷结构不正确；请重新读取该文件。');
    }
    return parsed as Record<string, unknown>;
  }

  function checkExpiry(payload: Record<string, unknown>, now: number): void {
    const expires = payload['expires_at'];
    if (typeof expires !== 'number' || !Number.isFinite(expires)) {
      throw stale('TICKET_MALFORMED', '读取票据缺少有效期；请重新读取该文件。');
    }
    if (expires <= now) {
      throw stale('TICKET_EXPIRED', '读取票据已过期；请重新读取该文件。');
    }
  }

  return {
    key_fingerprint: fingerprint,

    mintReadTicket(facts, context) {
      return sign(READ_TOKEN_PREFIX, {
        kind: 'read',
        v: PAYLOAD_VERSION,
        ...facts,
        issued_at: context.now,
        expires_at: context.now + context.ttl_ms,
      } satisfies ReadTicketPayload);
    },

    mintCursor(facts, context) {
      return sign(CURSOR_PREFIX, {
        kind: 'cursor',
        v: PAYLOAD_VERSION,
        ...facts,
        issued_at: context.now,
        expires_at: context.now + context.ttl_ms,
      } satisfies CursorPayload);
    },

    mintListCursor(facts, context) {
      return sign(LIST_CURSOR_PREFIX, {
        kind: 'list',
        v: PAYLOAD_VERSION,
        ...facts,
        issued_at: context.now,
        expires_at: context.now + context.ttl_ms,
      } satisfies ListCursorPayload);
    },

    mintSearchCursor(facts, context) {
      return sign(SEARCH_CURSOR_PREFIX, {
        kind: 'search',
        v: PAYLOAD_VERSION,
        ...facts,
        issued_at: context.now,
        expires_at: context.now + context.ttl_ms,
      } satisfies SearchCursorPayload);
    },

    verifyReadTicket(token, options) {
      const payload = open(READ_TOKEN_PREFIX, token);
      requireKind(payload, 'read');
      checkExpiry(payload, options.now);
      return readTicketOf(payload);
    },

    verifyCursor(token, options) {
      const payload = open(CURSOR_PREFIX, token);
      requireKind(payload, 'cursor');
      checkExpiry(payload, options.now);
      return cursorOf(payload);
    },

    verifyListCursor(token, options) {
      const payload = open(LIST_CURSOR_PREFIX, token);
      requireKind(payload, 'list');
      checkExpiry(payload, options.now);
      return listCursorOf(payload);
    },

    verifySearchCursor(token, options) {
      const payload = open(SEARCH_CURSOR_PREFIX, token);
      requireKind(payload, 'search');
      checkExpiry(payload, options.now);
      return searchCursorOf(payload);
    },
  };
}

function stale(reason: string, message: string): BridgeError {
  return new BridgeError('READ_TOKEN_STALE', message, { reason });
}

const KIND_LABEL: Record<'read' | 'cursor' | 'list' | 'search', string> = {
  read: '读取票据',
  cursor: '分页游标',
  list: '目录列举游标',
  search: '搜索游标',
};

function requireKind(payload: Record<string, unknown>, kind: 'read' | 'cursor' | 'list' | 'search'): void {
  if (payload['kind'] !== kind) {
    // 前缀不同已经挡过一次；这里挡的是另一种形态：把游标当票据用。
    // 两者的载荷字段高度重合，只靠前缀挡是不够的 —— 前缀是一串明文。
    throw stale('TICKET_WRONG_KIND', `该值不是${KIND_LABEL[kind]}；请重新读取。`);
  }
  if (payload['v'] !== PAYLOAD_VERSION) {
    throw stale('TICKET_VERSION_UNSUPPORTED', '读取票据的版本不受支持；请重新读取该文件。');
  }
}

// ---------------------------------------------------------------------------
// 字段读取（防御性，不是鉴权）
// ---------------------------------------------------------------------------

/**
 * 下面这几个取值函数**不是**安全检查：能走到这里说明签名已经通过，
 * 而签名只可能来自本服务。它们的作用是让「载荷形状」这件事有一个
 * 唯一的位置可写、可测 —— 将来给载荷加字段时忘了同步这里，
 * 会得到一条明确的 `TICKET_MALFORMED` 而不是 `undefined` 悄悄流进比较。
 */
function str(payload: Record<string, unknown>, field: string): string {
  const v = payload[field];
  if (typeof v !== 'string') throw stale('TICKET_MALFORMED', `读取票据缺少字段 ${field}；请重新读取。`);
  return v;
}

function num(payload: Record<string, unknown>, field: string): number {
  const v = payload[field];
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw stale('TICKET_MALFORMED', `读取票据字段 ${field} 不是有限数值；请重新读取。`);
  }
  return v;
}

function bool(payload: Record<string, unknown>, field: string): boolean {
  const v = payload[field];
  if (typeof v !== 'boolean') throw stale('TICKET_MALFORMED', `读取票据字段 ${field} 不是布尔值；请重新读取。`);
  return v;
}

function numArray(payload: Record<string, unknown>, field: string): readonly number[] {
  const v = payload[field];
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'number' || !Number.isFinite(x))) {
    throw stale('TICKET_MALFORMED', `读取票据字段 ${field} 不是数值数组；请重新读取。`);
  }
  return v as readonly number[];
}

function strArray(payload: Record<string, unknown>, field: string): readonly string[] {
  const v = payload[field];
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
    throw stale('TICKET_MALFORMED', `读取票据字段 ${field} 不是字符串数组；请重新读取。`);
  }
  return v as readonly string[];
}

function readTicketOf(p: Record<string, unknown>): ReadTicketPayload {
  return Object.freeze({
    kind: 'read',
    v: num(p, 'v'),
    connection_id: str(p, 'connection_id'),
    workspace_id: str(p, 'workspace_id'),
    generation: num(p, 'generation'),
    canonical_path: str(p, 'canonical_path'),
    volume_id: str(p, 'volume_id'),
    file_id: str(p, 'file_id'),
    raw_bytes_sha256: str(p, 'raw_bytes_sha256'),
    size: num(p, 'size'),
    total_lines: num(p, 'total_lines'),
    range_start: num(p, 'range_start'),
    range_end_exclusive: num(p, 'range_end_exclusive'),
    truncated: bool(p, 'truncated'),
    truncated_lines: numArray(p, 'truncated_lines'),
    editable: bool(p, 'editable'),
    editable_blockers: strArray(p, 'editable_blockers'),
    redacted: bool(p, 'redacted'),
    issued_at: num(p, 'issued_at'),
    expires_at: num(p, 'expires_at'),
  });
}

function cursorOf(p: Record<string, unknown>): CursorPayload {
  return Object.freeze({
    kind: 'cursor',
    v: num(p, 'v'),
    connection_id: str(p, 'connection_id'),
    workspace_id: str(p, 'workspace_id'),
    generation: num(p, 'generation'),
    canonical_path: str(p, 'canonical_path'),
    volume_id: str(p, 'volume_id'),
    file_id: str(p, 'file_id'),
    raw_bytes_sha256: str(p, 'raw_bytes_sha256'),
    next_start_line: num(p, 'next_start_line'),
    issued_at: num(p, 'issued_at'),
    expires_at: num(p, 'expires_at'),
  });
}

function listCursorOf(p: Record<string, unknown>): ListCursorPayload {
  return Object.freeze({
    kind: 'list',
    v: num(p, 'v'),
    connection_id: str(p, 'connection_id'),
    workspace_id: str(p, 'workspace_id'),
    generation: num(p, 'generation'),
    base_path: str(p, 'base_path'),
    base_volume_id: str(p, 'base_volume_id'),
    base_file_id: str(p, 'base_file_id'),
    anchor_path: str(p, 'anchor_path'),
    depth: num(p, 'depth'),
    issued_at: num(p, 'issued_at'),
    expires_at: num(p, 'expires_at'),
  });
}

function searchCursorOf(p: Record<string, unknown>): SearchCursorPayload {
  return Object.freeze({
    kind: 'search',
    v: num(p, 'v'),
    connection_id: str(p, 'connection_id'),
    workspace_id: str(p, 'workspace_id'),
    generation: num(p, 'generation'),
    base_path: str(p, 'base_path'),
    base_volume_id: str(p, 'base_volume_id'),
    base_file_id: str(p, 'base_file_id'),
    query_digest: str(p, 'query_digest'),
    resume_path: str(p, 'resume_path'),
    skip_matches: num(p, 'skip_matches'),
    issued_at: num(p, 'issued_at'),
    expires_at: num(p, 'expires_at'),
  });
}

// ---------------------------------------------------------------------------
// 取用校验
// ---------------------------------------------------------------------------

/**
 * 使用读取票据时，调用方必须**当场**给出的当前事实。
 *
 * 每一项都来自 daemon 现在读到的状态，而不是请求体：
 * `connection_id` 来自凭据，`generation` 来自工作区记录，
 * `path` 与 `base_sha256` 来自本次提案声明的意图。
 */
export interface ReadTokenExpectation {
  readonly connection_id: string;
  readonly workspace_id: string;
  readonly generation: number;
  readonly path: string;
  /** 提案声明的整文件基线；省略表示这次使用不涉及写入。 */
  readonly base_sha256?: string;
  /** true 表示这次使用必须要求票据是**可用于编辑**的。 */
  readonly require_editable?: boolean;
}

/**
 * 校验票据与当前事实一致。
 *
 * ## 路径为什么按大小写不敏感比较
 *
 * 票据里存的是**磁盘规范拼写**（取自句柄），提案里是模型按用户话术写下的拼写。
 * NTFS 大小写不敏感，`README.md` 与 `Readme.md` 是同一个对象 ——
 * 按字节比较会把一次合法提案判成「跨文件重放」。
 *
 * 这不是放松：真正的身份判定是 `volume_id` / `file_id` / `raw_bytes_sha256`
 * 三项，它们逐字节比较。路径这一项只用来抓「明显不是同一个文件」，
 * 而把「同一个文件的不同拼写」当成不同文件，会让上面那三项永远轮不到被检查。
 *
 * **8.3 短名与大小写别名不靠这里挡** —— 它们在护栏里就已经归一成了同一个
 * 规范路径（LWB-010 的逐级句柄判定），到这一层时两者给出的 `canonical_path`
 * 本来就是一串相同的字符。
 */
export function assertReadTokenMatches(token: ReadTicketPayload, expect: ReadTokenExpectation): void {
  const mismatch = (
    reason: string,
    message: string,
    extra: Readonly<Record<string, string | number | boolean | null>> = {},
  ): never => {
    throw new BridgeError('READ_TOKEN_STALE', message, { reason, ...extra });
  };

  if (token.connection_id !== expect.connection_id) {
    mismatch('TICKET_CROSS_CONNECTION', '该读取票据属于另一条连接；请在本连接内重新读取该文件。');
  }
  if (token.workspace_id !== expect.workspace_id) {
    mismatch('TICKET_CROSS_WORKSPACE', '该读取票据属于另一个工作区；请在本工作区内重新读取该文件。');
  }
  if (token.generation !== expect.generation) {
    mismatch('TICKET_GENERATION_MISMATCH', '工作区代次已变化，该读取票据失效；请重新读取。', {
      ticket_generation: token.generation,
      current_generation: expect.generation,
    });
  }
  if (!equalPathCaseInsensitive(token.canonical_path, expect.path)) {
    mismatch('TICKET_PATH_MISMATCH', '该读取票据对应的不是这个路径；请重新读取该文件。');
  }
  if (expect.base_sha256 !== undefined && token.raw_bytes_sha256 !== expect.base_sha256) {
    mismatch('TICKET_BASE_MISMATCH', '提案声明的基线哈希与该读取票据记录的版本不一致；请重新读取。', {
      ticket_sha256: token.raw_bytes_sha256,
      presented_sha256: expect.base_sha256,
    });
  }
  if (expect.require_editable === true && !token.editable) {
    mismatch(
      'TICKET_NOT_EDITABLE',
      `该读取票据不可用于编辑：${token.editable_blockers.join('；') || '原因未记录'}。请重新完整读取该文件。`,
    );
  }
}

/**
 * 使用列举游标时，调用方必须**当场**给出的当前事实。
 *
 * 与 `ReadTokenExpectation` 的差别：这里没有 `base_sha256` 那种「内容版本」，
 * 因为目录内容没有哈希 —— 目录本来就可能在任何两次调用之间变化，
 * 而这一点已经由 `consistency: per_file` 声明。能证明的只有
 * 「还是同一个目录对象」（身份）与「还是同一次查询」（路径 + 深度）。
 */
export interface ListCursorExpectation {
  readonly connection_id: string;
  readonly workspace_id: string;
  readonly generation: number;
  /** 起点目录的规范相对路径（磁盘拼写）。 */
  readonly base_path: string;
  readonly base_volume_id: string;
  readonly base_file_id: string;
  readonly depth: number;
}

/**
 * 校验游标与当前事实一致。
 *
 * `base_path` 与读取侧同理按大小写不敏感比较（NTFS 语义），而
 * `base_volume_id` / `base_file_id` 逐字节比较 —— 真正的身份判定是后两项，
 * 路径这一项只用来抓「明显不是同一个目录」。
 *
 * **`depth` 不符即拒绝**，不做「取较小值继续」这种修补：深度是这次查询的一部分，
 * 一次带 `depth: 8` 的续读与一次带 `depth: 1` 的首读不是同一次遍历，
 * 拼起来的结果既不是前者的也不是后者的。取较小值看起来「更安全」，
 * 实际是让调用方拿到一份自己没要求过的、也没有被告知的遍历结果。
 */
export function assertListCursorMatches(cursor: ListCursorPayload, expect: ListCursorExpectation): void {
  const mismatch = (
    reason: string,
    message: string,
    extra: Readonly<Record<string, string | number | boolean | null>> = {},
  ): never => {
    throw new BridgeError('READ_TOKEN_STALE', message, { reason, ...extra });
  };

  if (cursor.connection_id !== expect.connection_id) {
    mismatch('CURSOR_CROSS_CONNECTION', '该目录列举游标属于另一条连接；请重新列举该目录。');
  }
  if (cursor.workspace_id !== expect.workspace_id) {
    mismatch('CURSOR_CROSS_WORKSPACE', '该目录列举游标属于另一个工作区；请在本工作区内重新列举。');
  }
  if (cursor.generation !== expect.generation) {
    mismatch('CURSOR_GENERATION_MISMATCH', '工作区代次已变化，该目录列举游标失效；请重新列举。', {
      cursor_generation: cursor.generation,
      current_generation: expect.generation,
    });
  }
  if (cursor.depth !== expect.depth) {
    mismatch('CURSOR_DEPTH_MISMATCH', `该目录列举游标是按 depth=${cursor.depth} 生成的，与本次请求的深度不符；请重新列举。`, {
      cursor_depth: cursor.depth,
      request_depth: expect.depth,
    });
  }
  if (!equalPathCaseInsensitive(cursor.base_path, expect.base_path)) {
    mismatch('CURSOR_BASE_MISMATCH', '该目录列举游标对应的不是这个目录路径；请重新列举。');
  }
  if (
    cursor.base_volume_id !== expect.base_volume_id ||
    cursor.base_file_id !== expect.base_file_id
  ) {
    mismatch('CURSOR_BASE_CHANGED', '该目录列举游标的起点目录已经不是同一个目录对象；请重新列举。');
  }
}

/**
 * 使用搜索游标时，调用方必须**当场**给出的当前事实。
 *
 * 与列举游标的差别在 `query_digest`：一次搜索的"范围"不只是目录，还包括
 * **问的是什么**。拿一次针对 `alpha` 的续读去问 `beta`，得到的会是一份
 * 「从 alpha 的进度继续、但按 beta 匹配」的结果 —— 它看起来完整、行号也对，
 * 只是它回答的不是调用方问的问题。
 */
export interface SearchCursorExpectation {
  readonly connection_id: string;
  readonly workspace_id: string;
  readonly generation: number;
  readonly base_path: string;
  readonly base_volume_id: string;
  readonly base_file_id: string;
  readonly query_digest: string;
}

/**
 * 校验搜索游标与当前事实一致。四项绑定的理由与列举游标逐条对应，
 * 外加查询摘要那一条（见上）。
 */
export function assertSearchCursorMatches(cursor: SearchCursorPayload, expect: SearchCursorExpectation): void {
  const mismatch = (
    reason: string,
    message: string,
    extra: Readonly<Record<string, string | number | boolean | null>> = {},
  ): never => {
    throw new BridgeError('READ_TOKEN_STALE', message, { reason, ...extra });
  };

  if (cursor.connection_id !== expect.connection_id) {
    mismatch('CURSOR_CROSS_CONNECTION', '该搜索游标属于另一条连接；请重新搜索。');
  }
  if (cursor.workspace_id !== expect.workspace_id) {
    mismatch('CURSOR_CROSS_WORKSPACE', '该搜索游标属于另一个工作区；请在本工作区内重新搜索。');
  }
  if (cursor.generation !== expect.generation) {
    mismatch('CURSOR_GENERATION_MISMATCH', '工作区代次已变化，该搜索游标失效；请重新搜索。', {
      cursor_generation: cursor.generation,
      current_generation: expect.generation,
    });
  }
  if (cursor.query_digest !== expect.query_digest) {
    mismatch('CURSOR_QUERY_MISMATCH', '该搜索游标属于另一次查询（查询串、大小写或 path_glob 不同）；请重新搜索。');
  }
  if (!equalPathCaseInsensitive(cursor.base_path, expect.base_path)) {
    mismatch('CURSOR_BASE_MISMATCH', '该搜索游标对应的不是这个起点目录；请重新搜索。');
  }
  if (cursor.base_volume_id !== expect.base_volume_id || cursor.base_file_id !== expect.base_file_id) {
    mismatch('CURSOR_BASE_CHANGED', '该搜索游标的起点目录已经不是同一个目录对象；请重新搜索。');
  }
}

/**
 * 提案的编辑区间是否落在票据记录的实际返回范围内（方案 §6.3）。
 *
 * 规则不是「大致覆盖」，而是两条具体的：
 *
 *  1. 区间必须**完全**落在已返回的行范围内 —— `[start_line, end_line_exclusive)`
 *     的每一行都真的被返回过；
 *  2. **纯插入**（空区间）额外要求邻接上下文已读：插入点左侧那一行、
 *     以及右侧那一行（若存在）都必须在已读范围内。理由是一段空区间没有
 *     任何内容锚点，它的位置完全来自「我在哪两行之间」这句话；
 *     只读到左邻就允许插入，等于允许在一个从未见过的右边界的旁边落笔。
 *
 * 越界与不满足都返回 `false`；由调用方（LWB-020）决定抛什么错。
 */
export function coversEditRange(
  token: ReadTicketPayload,
  startLine: number,
  endLineExclusive: number,
): boolean {
  if (!Number.isInteger(startLine) || !Number.isInteger(endLineExclusive)) return false;
  if (startLine < 1 || endLineExclusive < startLine) return false;
  if (startLine < token.range_start) return false;
  if (endLineExclusive > token.range_end_exclusive) return false;

  if (startLine === endLineExclusive) {
    // 左邻：插入点前一行若存在，必须已读。
    if (startLine - 1 >= 1 && startLine - 1 < token.range_start) return false;
    // 右邻：插入点那一行若存在（不是文件末尾之外），必须已读。
    if (startLine <= token.total_lines && startLine > token.range_end_exclusive - 1) return false;
  }
  return true;
}

/** 供诊断与审计使用：票据覆盖的版本。**不含正文。** */
export function fileVersionOf(token: ReadTicketPayload): Pick<
  FileVersion,
  'volume_id' | 'file_id' | 'raw_bytes_sha256' | 'size'
> {
  return {
    volume_id: token.volume_id,
    file_id: token.file_id,
    raw_bytes_sha256: token.raw_bytes_sha256,
    size: token.size,
  };
}
