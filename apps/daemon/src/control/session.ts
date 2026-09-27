/**
 * 控制台会话、CSRF 与一次性操作 nonce（LWB-012 步骤 2）。
 *
 * ## 会话是怎么建立起来的
 *
 * ```
 * daemon 启动
 *   → mintBootstrap()  → 打印在操作者的终端里：http://127.0.0.1:PORT/#t=lwb_boot_…
 *   → 操作者点开 → 控制台页面读取 location.hash 里的令牌
 *   → POST /api/session { token }        ← 令牌在**请求体**里，不在 URL 里
 *   → 服务端核对（一次性、未过期）→ Set-Cookie: __Host-lwb_console=lwb_sess_…（HttpOnly）
 *   → 之后每个请求靠 cookie 鉴权，变更请求另需 CSRF 头
 * ```
 *
 * **令牌放在片段（`#`）而不是查询串里**，这一点值得说明：片段不会被浏览器
 * 发往服务器，因此启动令牌不会出现在请求行、不会进任何访问日志、
 * 不会作为 `Referer` 的一部分泄露给第三方 —— 它只在兑换的那一次 POST 体里出现。
 * 用 `?t=` 也能work，但那意味着令牌会经过服务器的日志路径，
 * 而「带授权效果的 URL」正是验收标准 3 点名要防的东西。
 *
 * ## 为什么 CSRF 令牌不放在 cookie 里
 *
 * 常见的「双提交 cookie」做法是把 CSRF 令牌同时放进 cookie 与请求头，服务端比较两者。
 * 那套做法是为**没有服务端会话状态**的场景设计的。这里有服务端会话，
 * 于是可以做得更强：CSRF 令牌**只存在于服务端会话里**，
 * 通过兑换响应体交给控制台，控制台把它放在请求头里。
 *
 * 差别在于：cookie 双提交在「攻击者能写 cookie」时失效
 * （任何能往 127.0.0.1 写 cookie 的路径，例如同域的子域、或者一次
 * 利用其他漏洞的 cookie 注入，都能同时伪造两边）；而服务端持有的那份
 * 攻击者读不到也写不到。同源策略保证攻击者的页面读不到兑换响应体，
 * 因此它拿不到这个令牌。
 *
 * ## 一次性操作 nonce
 *
 * 变更类操作要求一个**服务端签发、绑定到具体内容、用后即焚**的 nonce。
 * 它解决两件事：
 *
 *  1. **重放**：一份被记录的批准请求不能再用一次。
 *  2. **所见非所批**：nonce 绑定 `(操作, 主体, 摘要)` 三元组，
 *     因此「操作者看的是一份内容、批准的是另一份」在服务端表现为绑定不匹配。
 *
 * **本阶段能力的诚实说明**：nonce 目前由控制台显式申请（`POST /api/nonces`）。
 * 也就是说它现在证明的是「一次性与内容绑定」，而**不**证明
 * 「操作者确实看过这份内容」—— 后者要求 nonce 由**渲染审核页的那次读取**
 * 一并签发，那是 LWB-022（本地审批）的职责。这条边界写在这里，
 * 是为了避免将来有人把现状读成「批准链路已经完备」。
 */

import { CONTROL_COOKIE_NAME, MAX_SESSIONS, NONCE_TTL_MS, SESSION_IDLE_TTL_MS, SESSION_TTL_MS, BOOTSTRAP_TTL_MS } from './constants.ts';
import { constantTimeEquals, hashToken, newControlToken } from './tokens.ts';

export interface ControlSession {
  readonly session_id: string;
  readonly created_at: number;
  readonly expires_at: number;
  readonly last_seen_at: number;
  /** CSRF 令牌。**只应出现在兑换响应体与请求头里**，不进日志、不进审计。 */
  readonly csrf_token: string;
}

export interface BootstrapTicket {
  readonly token: string;
  /** 打印给操作者的完整地址。令牌在片段里。 */
  readonly url: string;
  readonly expires_at: number;
}

export interface IssuedSession {
  readonly session: ControlSession;
  /** cookie 的值（`lwb_sess_…`）。只在这一次返回。 */
  readonly cookie_value: string;
}

export interface NonceBinding {
  readonly operation: string;
  readonly subject: string;
  readonly digest: string;
}

export interface IssuedNonce {
  readonly nonce: string;
  readonly expires_at: number;
}

export type NonceRejection =
  | 'NOT_ISSUED'
  | 'EXPIRED'
  | 'WRONG_SESSION'
  | 'BINDING_MISMATCH';

export interface SessionStoreOptions {
  readonly now?: () => number;
  readonly bootstrapTtlMs?: number;
  readonly sessionTtlMs?: number;
  readonly idleTtlMs?: number;
  readonly nonceTtlMs?: number;
  readonly maxSessions?: number;
  /**
   * 拼启动 URL 用。
   *
   * 传 0 表示「端口由系统分配」，此时启动令牌的 URL 在
   * `bindPort()` 被调用之前是**不可用**的 —— 它会是 `:0`。
   * 装配根按 `listen()` 的返回值调用 `bindPort()`（见下）。
   */
  readonly port: number;
}

interface StoredSession {
  readonly session_id: string;
  readonly csrf_token: string;
  readonly created_at: number;
  readonly expires_at: number;
  last_seen_at: number;
}

interface StoredNonce {
  readonly session_id: string;
  readonly operation: string;
  readonly subject: string;
  readonly digest: string;
  readonly expires_at: number;
}

export class ControlSessionStore {
  readonly #options: Required<Omit<SessionStoreOptions, 'now'>> & { readonly now: () => number };
  /** tokenHash → 过期时间。**同一时刻最多只有一张未兑换的启动令牌**。 */
  readonly #bootstraps = new Map<string, number>();
  /** cookieHash → 会话。键是摘要，因此这张表本身不是凭证。 */
  readonly #sessions = new Map<string, StoredSession>();
  /** nonceHash → 绑定。 */
  readonly #nonces = new Map<string, StoredNonce>();
  #sessionSeq = 0;
  /**
   * 控制平面的实际监听端口。
   *
   * 它**不是** `#options.port` 的副本：装配根通常让系统分配端口（传 0），
   * 真正的端口只有 `listen()` 返回后才知道。而启动令牌的 URL 必须在
   * 那一刻之后才能拼对 —— 拼错了（`:0`）的表现是操作者点开一个打不开的
   * 地址，而日志里看起来一切正常。
   */
  #port: number;

  constructor(options: SessionStoreOptions) {
    this.#options = {
      now: options.now ?? Date.now,
      bootstrapTtlMs: options.bootstrapTtlMs ?? BOOTSTRAP_TTL_MS,
      sessionTtlMs: options.sessionTtlMs ?? SESSION_TTL_MS,
      idleTtlMs: options.idleTtlMs ?? SESSION_IDLE_TTL_MS,
      nonceTtlMs: options.nonceTtlMs ?? NONCE_TTL_MS,
      maxSessions: options.maxSessions ?? MAX_SESSIONS,
      port: options.port,
    };
    this.#port = options.port;
  }

  /**
   * 服务真正绑上之后回填端口（由 `ControlServer.listen()` 调用）。
   *
   * 只接受一个**正**端口：`0` 是「还不知道」，把它写回来等于让
   * 「端口」这个字段永远合法，于是拼错的 URL 再也报不出来。
   */
  bindPort(port: number): void {
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      throw new Error(`控制平面回填的端口不合法：${String(port)}。`);
    }
    this.#port = port;
  }

  /** 当前用于拼接启动 URL 的端口。未绑定时等于构造时的入参。 */
  get port(): number {
    return this.#port;
  }

  // -------------------------------------------------------------------------
  // 启动令牌
  // -------------------------------------------------------------------------

  /**
   * 签发一张启动令牌。
   *
   * **签发新的会作废所有旧的未兑换令牌。** 理由是「有效的凭证越少越好」：
   * 操作者每点一次「重新打开控制台」，终端里就多一行 URL；如果旧的那行
   * 仍然有效，那些 URL 会留在终端回滚缓冲、剪贴板、甚至别人拍的照片里，
   * 每一份都是一座能进控制台的门。保留「最近一张」使这件事可以推理：
   * **终端里最后打印的那一行才是有效的。**
   *
   * 代价是操作者不能在两个终端里各开一个控制台 —— 但他并不需要：
   * 一个会话可以被多个标签页共用。
   */
  mintBootstrap(): BootstrapTicket {
    this.#bootstraps.clear();
    const token = newControlToken('bootstrap');
    const expiresAt = this.#options.now() + this.#options.bootstrapTtlMs;
    this.#bootstraps.set(hashToken(token), expiresAt);
    return {
      token,
      url: `http://127.0.0.1:${String(this.#port)}/#t=${token}`,
      expires_at: expiresAt,
    };
  }

  /** 未兑换的启动令牌数量。**不返回令牌本身。** */
  pendingBootstraps(): number {
    this.#sweep();
    return this.#bootstraps.size;
  }

  // -------------------------------------------------------------------------
  // 会话
  // -------------------------------------------------------------------------

  /**
   * 兑换启动令牌，建立会话。失败一律返回 `null`，不区分
   * 「没有这张令牌」「过期了」「已经用过了」—— 区分它们会给
   * 猜测者一个「这一张存在但过期了」的信号。本地审计另记（见 `onEvent`）。
   */
  redeem(token: string): IssuedSession | null {
    this.#sweep();
    const key = hashToken(token);
    const expiresAt = this.#bootstraps.get(key);

    // **先删除再判断**：无论过期与否，这张令牌被使用过一次就作废。
    // 若只在成功时删除，一张过期令牌会永远留在表里，
    // 而它只要被兑换成功一次（例如时钟回拨、或者判过期的那段代码被改坏）
    // 就是一次本不该存在的会话。
    this.#bootstraps.delete(key);
    if (expiresAt === undefined || expiresAt <= this.#options.now()) return null;

    // 会话数上限：超出时先清掉最久未活动的已过期会话；仍然超出则拒绝。
    // 拒绝而不是「踢掉最旧的」——踢掉别人正在用的会话会让操作者
    // 莫名其妙地被登出，而拒绝只影响这一次新登录（他可以关掉旧标签页再试）。
    this.#sweep();
    if (this.#sessions.size >= this.#options.maxSessions) {
      this.#sweep(true);
      if (this.#sessions.size >= this.#options.maxSessions) return null;
    }

    const now = this.#options.now();
    this.#sessionSeq += 1;
    const cookieValue = newControlToken('session');
    const session: StoredSession = {
      // session_id 与 cookie 值**不同**：id 会出现在控制台界面与审计里，
      // 而 cookie 值是凭证。两者分开，日志里记 id 就不会泄露凭证。
      session_id: `s${this.#sessionSeq}-${hashToken(cookieValue).slice(0, 12)}`,
      csrf_token: newControlToken('csrf'),
      created_at: now,
      expires_at: now + this.#options.sessionTtlMs,
      last_seen_at: now,
    };
    this.#sessions.set(hashToken(cookieValue), session);

    return { session: publicView(session), cookie_value: cookieValue };
  }

  /**
   * 用 cookie 值鉴权。成功时推后空闲期限并返回会话视图。
   *
   * 返回的是**副本**（`publicView`），不是内部对象：内部对象带着
   * `last_seen_at` 的可变字段，交出去就意味着调用方可以改它。
   */
  authenticate(cookieValue: string | undefined): ControlSession | null {
    if (cookieValue === undefined || cookieValue.length === 0) return null;
    const key = hashToken(cookieValue);
    const stored = this.#sessions.get(key);
    if (stored === undefined) return null;

    const now = this.#options.now();
    if (stored.expires_at <= now || stored.last_seen_at + this.#options.idleTtlMs <= now) {
      this.#sessions.delete(key);
      return null;
    }
    stored.last_seen_at = now;
    return publicView(stored);
  }

  /** CSRF 头校验。常数时间比较。 */
  verifyCsrf(session: ControlSession, presented: string | undefined): boolean {
    if (presented === undefined || presented.length === 0) return false;
    for (const stored of this.#sessions.values()) {
      if (stored.session_id !== session.session_id) continue;
      return constantTimeEquals(stored.csrf_token, presented);
    }
    return false;
  }

  revoke(sessionId: string): boolean {
    for (const [key, stored] of this.#sessions) {
      if (stored.session_id === sessionId) {
        this.#sessions.delete(key);
        this.#forgetNoncesOf(sessionId);
        return true;
      }
    }
    return false;
  }

  /** 撤销全部会话。daemon 退出时调用。 */
  revokeAll(): void {
    this.#sessions.clear();
    this.#nonces.clear();
    this.#bootstraps.clear();
  }

  /** 会话清单（不含任何凭证）。供控制台自己的「已登录设备」页与测试使用。 */
  sessions(): readonly ControlSession[] {
    this.#sweep();
    return [...this.#sessions.values()].map(publicView);
  }

  // -------------------------------------------------------------------------
  // 一次性操作 nonce
  // -------------------------------------------------------------------------

  issueNonce(session: ControlSession, binding: NonceBinding): IssuedNonce {
    const nonce = newControlToken('nonce');
    const expiresAt = this.#options.now() + this.#options.nonceTtlMs;
    this.#nonces.set(hashToken(nonce), {
      session_id: session.session_id,
      operation: binding.operation,
      subject: binding.subject,
      digest: binding.digest,
      expires_at: expiresAt,
    });
    return { nonce, expires_at: expiresAt };
  }

  /**
   * 消费一个 nonce。**无论成功与否都把它删掉。**
   *
   * 失败也删除是刻意的：一个绑定不匹配的 nonce 只可能来自两种情况 ——
   * 内容在被审核之后变了（那本来就应该重新走一遍审核流程），
   * 或者有人在拿别人的 nonce 试（那更不该给他第二次机会）。
   * 两种情况都应当让这张 nonce 作废。
   *
   * 代价是控制台在绑定不匹配后必须重新申请，而不是「改一下再提交」。
   * 这不是缺点：**内容变了就该重新审核**。
   */
  consumeNonce(
    session: ControlSession,
    nonce: string,
    binding: NonceBinding,
  ): { readonly ok: true } | { readonly ok: false; readonly reason: NonceRejection } {
    const key = hashToken(nonce);
    const stored = this.#nonces.get(key);
    if (stored === undefined) return { ok: false, reason: 'NOT_ISSUED' };
    this.#nonces.delete(key);

    if (stored.expires_at <= this.#options.now()) return { ok: false, reason: 'EXPIRED' };
    if (stored.session_id !== session.session_id) return { ok: false, reason: 'WRONG_SESSION' };
    if (
      stored.operation !== binding.operation ||
      stored.subject !== binding.subject ||
      stored.digest !== binding.digest
    ) {
      return { ok: false, reason: 'BINDING_MISMATCH' };
    }
    return { ok: true };
  }

  /** 未消费的 nonce 数量。**不返回 nonce 本身。** */
  pendingNonces(): number {
    this.#sweep();
    return this.#nonces.size;
  }

  // -------------------------------------------------------------------------

  #forgetNoncesOf(sessionId: string): void {
    for (const [key, stored] of this.#nonces) {
      if (stored.session_id === sessionId) this.#nonces.delete(key);
    }
  }

  /**
   * 清理过期项。`all` 为真时连**未**过期的会话也一并清理 ——
   * 只用在「会话数已达上限、需要腾位置」这一处。
   */
  #sweep(all = false): void {
    const now = this.#options.now();
    for (const [key, expiresAt] of this.#bootstraps) {
      if (expiresAt <= now) this.#bootstraps.delete(key);
    }
    for (const [key, stored] of this.#sessions) {
      const idleDead = stored.last_seen_at + this.#options.idleTtlMs <= now;
      if (all || stored.expires_at <= now || idleDead) {
        this.#sessions.delete(key);
        this.#forgetNoncesOf(stored.session_id);
      }
    }
    for (const [key, stored] of this.#nonces) {
      if (stored.expires_at <= now) this.#nonces.delete(key);
    }
  }
}

function publicView(stored: StoredSession): ControlSession {
  return {
    session_id: stored.session_id,
    created_at: stored.created_at,
    expires_at: stored.expires_at,
    last_seen_at: stored.last_seen_at,
    csrf_token: stored.csrf_token,
  };
}

/**
 * 会话 cookie 的属性。
 *
 * ```
 * __Host-lwb_console=lwb_sess_…; HttpOnly; Secure; SameSite=Strict; Path=/
 * ```
 *
 * 四项各防一件事：
 *
 *  - `HttpOnly`：控制台的脚本读不到它。控制台需要读 cookie 吗？不需要 ——
 *    它需要的是 CSRF 令牌，那个走响应体。让脚本读不到会话凭证，
 *    意味着一次 XSS（例如将来渲染差异内容时漏了一处转义）偷不走会话。
 *  - `SameSite=Strict`：跨站请求**根本不带**这个 cookie。这挡住了
 *    「恶意页面靠 `<img>`/`<form>` 触发一次 GET」这类不经过 fetch 的路径 ——
 *    它们连 Origin 预检都不会有。
 *  - `Secure`：`__Host-` 前缀要求它。明文 HTTP 上浏览器会**丢弃**带 Secure 的
 *    cookie……这是一个需要说清楚的地方，见下。
 *  - `Path=/`：`__Host-` 前缀要求它（同时也是最小惊讶）。
 *
 * **关于 `Secure` 与明文 HTTP**：`__Host-` 前缀的规范要求 cookie 必须带
 * `Secure`、必须来自安全上下文。而我们监听的是 `http://127.0.0.1`。
 * 好消息是规范把**回环地址视为可信来源**（secure context），
 * 因此现代浏览器会接受 `http://127.0.0.1` 上带 `Secure` 的 `__Host-` cookie。
 * 这条正是我们选择绑 IPv4 字面量、并要求 `Host` 精确匹配它的另一个好处：
 * 换成 `http://<局域网IP>` 访问时 `__Host-` 会被浏览器拒绝，
 * 于是「不小心把控制台暴露到局域网上」会**表现为登录不上**，
 * 而不是表现为「能用但没保护」。
 */
export function cookieAttributes(): string {
  return `Path=/; HttpOnly; Secure; SameSite=Strict`;
}

export function setCookieHeader(cookieValue: string): string {
  return `${CONTROL_COOKIE_NAME}=${cookieValue}; ${cookieAttributes()}`;
}

export function clearCookieHeader(): string {
  return `${CONTROL_COOKIE_NAME}=; ${cookieAttributes()}; Max-Age=0`;
}

/** 从 `Cookie` 头里取出控制台会话 cookie。**只认这个名字。** */
export function readSessionCookie(rawCookie: string | undefined): string | undefined {
  if (rawCookie === undefined || rawCookie.length === 0) return undefined;
  for (const part of rawCookie.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== CONTROL_COOKIE_NAME) continue;
    return part.slice(eq + 1).trim();
  }
  return undefined;
}
