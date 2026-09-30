/**
 * 控制平面 HTTP 服务（LWB-012 步骤 1–3）。
 *
 * ## 请求经过的每一道门，顺序是有意的
 *
 * ```
 *  0. 方法/请求目标形态      ← 先排除代理式请求，本服务不转发任何东西
 *  1. Host                   ← DNS rebinding 的主要防线，必须最早
 *  2. Sec-Fetch-Site / Origin ← 跨站来源
 *  3. 路由查表                ← 固定字面量，无通配
 *  4. 会话                    ← 控制台 cookie
 *  5. CSRF 头                 ← 变更类
 *  6. 一次性 nonce            ← 变更类
 *  7. handler
 * ```
 *
 * `Host` 排在路由与身份**之前**，这是一个刻意的选择：如果先查路由，
 * 那么一个来自 `evil.com` 的请求在路径不存在时会收到 404、
 * 路径存在时会收到 401 —— 两条不同的响应就足以让攻击者**枚举出**
 * 这个端口上有哪些控制接口。先验 Host，则所有非本站来源的请求
 * 得到同一个响应，枚举不出任何东西。
 *
 * ## 永不发出的响应头
 *
 * **任何响应都不带 `Access-Control-Allow-Origin`。** 没有例外、没有配置项。
 * 控制台与 API 同源（都由本服务提供），因此不需要 CORS；
 * 而一旦有一条路径发出了它，跨站页面就能读到控制 API 的响应体 ——
 * 那等于把 CSRF 令牌与工作区清单交给攻击者。
 *
 * `OPTIONS` 也**不**被实现：不属于「无 CORS」。浏览器对非简单请求会先发预检，
 * 收不到 `Access-Control-Allow-*` 就不会发出真正的请求。
 * 换句话说，**不实现预检本身就是一道防线** ——
 * 它与 `origin.ts` 里「强制 Content-Type: application/json」那一条配合，
 * 让跨站变更请求在浏览器侧就发不出去。
 *
 * ## 本层**不**负责什么
 *
 * 进程内的这些检查保证「控制 API 只被持有控制台会话的人使用」。
 * 它们**不**保证「调用者是操作者本人」—— 后者依赖
 * 「启动令牌只打印在操作者的终端里」这个事实。
 * 一个已经被攻陷的本地账户可以直接读进程内存，这不在防护范围内
 * （方案 §4.2 明说「不宣称抵抗已控制当前 Windows 账户的任意恶意进程」）。
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';
import { BridgeError, type BridgeErrorCode } from '@lwb/contracts';
import {
  CONTROL_BIND_HOST,
  CONTROL_CSRF_HEADER,
  MAX_BODY_BYTES,
} from './constants.ts';
import {
  checkHost,
  checkJsonContentType,
  checkOrigin,
  checkRequestTarget,
  checkSecFetchSite,
  consoleOrigin,
  contentTypeOf,
  type Reject,
} from './origin.ts';
import type { ControlRoute, ControlRouteTable } from './routes.ts';
import {
  clearCookieHeader,
  readSessionCookie,
  setCookieHeader,
  type ControlSession,
  type ControlSessionStore,
} from './session.ts';

export type ControlEvent =
  | { readonly type: 'listening'; readonly origin: string }
  | { readonly type: 'bootstrap_minted'; readonly expires_at: number }
  | { readonly type: 'browser_invitation_minted'; readonly session_id: string; readonly expires_at: number }
  | { readonly type: 'session_settings_changed'; readonly session_id: string; readonly idle_timeout_ms: number; readonly absolute_timeout_ms: number | null }
  | { readonly type: 'session_established'; readonly session_id: string }
  | { readonly type: 'session_rejected'; readonly reason: 'NO_COOKIE' | 'UNKNOWN_OR_EXPIRED' }
  | { readonly type: 'session_revoked'; readonly session_id: string }
  | { readonly type: 'request_rejected'; readonly reason: string; readonly detail: string; readonly path: string }
  | { readonly type: 'csrf_rejected'; readonly session_id: string; readonly path: string }
  | { readonly type: 'nonce_rejected'; readonly session_id: string; readonly path: string; readonly reason: string }
  | { readonly type: 'operation_failed'; readonly path: string; readonly code: string }
  | { readonly type: 'closed' };

export interface ControlServerOptions {
  readonly routes: ControlRouteTable;
  readonly sessions: ControlSessionStore;
  /** 构建期生成、启动时从固定 console/dist 目录装入的同源静态资产。 */
  readonly static_assets?: ReadonlyMap<string, StaticControlAsset>;
  readonly onEvent?: (event: ControlEvent) => void;
  /** 端口。0 表示由系统分配（测试用）。 */
  readonly port?: number;
  /**
   * 便捷钩子：签发启动令牌。**不是**自动的 —— 调用方决定何时打印 URL。
   */
  readonly now?: () => number;
}

export interface StaticControlAsset {
  readonly body: Buffer;
  readonly content_type: string;
}

interface ResolvedRequest {
  readonly operation: string;
  readonly body: Record<string, unknown>;
}

export class ControlServer {
  readonly #options: ControlServerOptions;
  #server: Server | null = null;
  #port = 0;
  #origin = '';

  constructor(options: ControlServerOptions) {
    this.#options = options;
  }

  get origin(): string {
    return this.#origin;
  }

  get port(): number {
    return this.#port;
  }

  /**
   * 启动监听。
   *
   * `host` 与 `port` 都写死：`CONTROL_BIND_HOST` 是常量而不是配置项
   * （理由见 constants.ts），端口由调用方给（0 = 系统分配）。
   *
   * **不加 `ipv6Only` 之类的选项、也不监听 `::`**：只绑 IPv4 回环字面量，
   * 因此不存在「双栈监听顺带接受了来自局域网的连接」这种情形。
   */
  async listen(): Promise<{ host: string; port: number; origin: string }> {
    if (this.#server !== null) throw new Error('控制平面服务已经启动。');
    const server = createServer((request, response) => {
      void this.#handle(request, response);
    });

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => reject(error);
      server.once('error', onError);
      server.listen({ host: CONTROL_BIND_HOST, port: this.#options.port ?? 0, exclusive: true }, () => {
        server.removeListener('error', onError);
        resolve();
      });
    });

    const address = server.address() as AddressInfo | null;
    if (address === null) throw new Error('控制平面服务启动后没有地址。');
    // 自检：绑到的必须确实是回环 IPv4。真出现偏差时宁可启动失败，
    // 也不要「能连上但验收标准 1 已经不成立」。
    if (address.address !== CONTROL_BIND_HOST) {
      server.close();
      throw new Error(
        `控制平面绑定到了 ${address.address}，而不是 ${CONTROL_BIND_HOST}；拒绝启动。` +
          '控制 API 只能监听回环地址，否则本机以外的请求也能到达它。',
      );
    }

    this.#server = server;
    this.#port = address.port;
    this.#origin = consoleOrigin(address.port);
    // 把**实际**端口回填给会话存储：启动令牌的 URL 由它拼，
    // 而 `port: 0` 的装配（系统分配）在这一次调用之前拼出来的地址是
    // `http://127.0.0.1:0/...` —— 一个打不开但看起来正常的地址。
    this.#options.sessions.bindPort(address.port);
    this.#emit({ type: 'listening', origin: this.#origin });
    return { host: address.address, port: address.port, origin: this.#origin };
  }

  async close(): Promise<void> {
    const server = this.#server;
    if (server === null) return;
    this.#server = null;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    this.#emit({ type: 'closed' });
  }

  /** 签发启动令牌并**把 URL 交给调用方去打印**。服务器自己不打日志。 */
  mintBootstrap(): { readonly token: string; readonly url: string; readonly expires_at: number } {
    const ticket = this.#options.sessions.mintBootstrap();
    this.#emit({ type: 'bootstrap_minted', expires_at: ticket.expires_at });
    return ticket;
  }

  // -------------------------------------------------------------------------

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    // 所有响应共有的头。`no-store` 是因为其中任何一条响应都可能带着
    // 「当前工作区/待批准项」这类本机事实，不该被任何缓存留存。
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');

    const method = (request.method ?? 'GET').toUpperCase();
    const rawUrl = request.url ?? '/';

    // 0. 方法/请求目标形态
    const targetReject = checkRequestTarget(method, rawUrl);
    if (targetReject !== null) return this.#reject(response, targetReject, 400, rawUrl);
    if (method !== 'GET' && method !== 'POST' && method !== 'DELETE') {
      // 不实现 OPTIONS：见文件头注释（不实现预检是防线的一部分）。
      return this.#reject(
        response,
        {
          ok: false,
          reason: 'METHOD_NOT_ALLOWED',
          detail: `方法 ${method} 不被接受。本服务不实现 CORS 预检。`,
        },
        405,
        rawUrl,
      );
    }

    // 1. Host —— DNS rebinding 的主要防线
    const hostReject = checkHost(headerOf(request, 'host'), this.#port);
    if (hostReject !== null) return this.#reject(response, hostReject, 403, rawUrl);

    // 路径解析：**不做百分号解码**，并要求完全字面量匹配。
    // 拒绝含 `%` 的路径是刻意的：解码是「解析器分歧」的经典来源
    // （`%2F` 算不算分隔符？`%2e%2e` 算不算上一级？），
    // 而控制 API 的路径全是固定字面量，没有任何正当理由需要转义。
    const pathEnd = rawUrl.search(/[?#]/);
    const path = pathEnd >= 0 ? rawUrl.slice(0, pathEnd) : rawUrl;
    if (path.includes('%')) {
      return this.#reject(
        response,
        { ok: false, reason: 'PROXY_REQUEST_TARGET', detail: '路径含百分号转义；本服务只接受字面量路径。' },
        400,
        path,
      );
    }
    if (pathEnd >= 0 && rawUrl[pathEnd] === '?') {
      // 不实现查询串：控制 API 的参数一律走 JSON 请求体。
      // 这条同时挡住「把凭证放进 URL」这一类用法 —— 它正是验收标准 3
      // 点名的「带授权效果的 URL」。
      return this.#reject(
        response,
        { ok: false, reason: 'PROXY_REQUEST_TARGET', detail: '本服务不接受查询串；参数一律放在 JSON 请求体里。' },
        400,
        path,
      );
    }

    const mutating = method === 'POST' || method === 'DELETE';

    // 2. 跨站来源
    const siteReject = checkSecFetchSite(headerOf(request, 'sec-fetch-site'));
    if (siteReject !== null) return this.#reject(response, siteReject, 403, path);

    if (mutating) {
      const originReject = checkOrigin(headerOf(request, 'origin'), this.#origin);
      if (originReject !== null) return this.#reject(response, originReject, 403, path);

      const typeReject = checkJsonContentType(headerOf(request, 'content-type'));
      if (typeReject !== null) return this.#reject(response, typeReject, 415, path);
    } else {
      // 安全方法：`Origin` 若存在就必须匹配。缺省不拒绝 ——
      // 地址栏直接访问、书签、以及一部分客户端都不发它，
      // 而读取类请求由 cookie 的 `SameSite=Strict` 兜住（跨站根本不带 cookie）。
      const rawOrigin = headerOf(request, 'origin');
      if (rawOrigin !== undefined && rawOrigin.length > 0) {
        const originReject = checkOrigin(rawOrigin, this.#origin);
        if (originReject !== null) return this.#reject(response, originReject, 403, path);
      }
    }

    // 本地控制台静态文件和 API 同源，由 daemon 从构建产物白名单提供。
    // 只响应 loader 预先枚举的固定文件名；未知路径仍落到下面的 404，
    // 不存在「按 URL 拼文件系统路径」的通用静态目录。
    if (method === 'GET') {
      const assetPath = path === '/' ? '/index.html' : path;
      const asset = this.#options.static_assets?.get(assetPath);
      if (asset !== undefined) return this.#static(response, asset);
    }

    // 3. 路由
    const route = this.#options.routes.lookup(method, path);
    if (route === undefined) {
      // 不回报「有哪些路由」—— 路由清单本身就是一张攻击面地图。
      return this.#json(response, 404, { ok: false, error: { code: 'NOT_FOUND', message: '无此接口。' } });
    }

    // 4. 会话
    const requiresSession = route.capability !== undefined;
    const cookieValue = readSessionCookie(headerOf(request, 'cookie'));
    let session: ControlSession | null = null;
    if (requiresSession) {
      session = this.#options.sessions.authenticate(cookieValue);
      if (session === null) {
        this.#emit({
          type: 'session_rejected',
          reason: cookieValue === undefined ? 'NO_COOKIE' : 'UNKNOWN_OR_EXPIRED',
        });
        response.setHeader('Set-Cookie', clearCookieHeader());
        return this.#json(response, 401, {
          ok: false,
          error: { code: 'NOT_AUTHORIZED', message: '本地会话无效或已过期；请从其它在线控制台获取新链接，或重新运行本地启动脚本。' },
        });
      }
    }

    const requestId = `ctl-${createHash('sha256')
      .update(`${Date.now()}:${this.#port}:${Math.random()}`)
      .digest('hex')
      .slice(0, 16)}`;

    let resolved: ResolvedRequest;
    try {
      const body = mutating ? await readJsonBody(request) : {};
      if (mutating && session !== null) {
        // 5. CSRF
        if (!this.#options.sessions.verifyCsrf(session, headerOf(request, CONTROL_CSRF_HEADER))) {
          this.#emit({ type: 'csrf_rejected', session_id: session.session_id, path });
          return this.#json(response, 403, {
            ok: false,
            error: { code: 'NOT_AUTHORIZED', message: '缺少或错误的 CSRF 令牌。' },
          });
        }
        // 6. 一次性 nonce
        if (route.mutating) {
          const verdict = this.#options.sessions.consumeNonce(session, String(body['nonce'] ?? ''), {
            operation: route.path,
            subject: String(body['subject'] ?? ''),
            digest: bodyDigest(body),
          });
          if (!verdict.ok) {
            this.#emit({ type: 'nonce_rejected', session_id: session.session_id, path, reason: verdict.reason });
            return this.#json(response, 403, {
              ok: false,
              error: {
                code: 'NOT_AUTHORIZED',
                message:
                  '一次性操作 nonce 无效：未签发、已过期、已使用、或与本次请求的内容不匹配。' +
                  '内容变更后必须重新走一遍审核流程。',
              },
            });
          }
        }
      }
      resolved = { operation: path, body };
    } catch (error) {
      if (error instanceof BodyError) {
        return this.#json(response, error.status, {
          ok: false,
          error: { code: 'INVALID_ARGUMENT', message: error.message },
        });
      }
      throw error;
    }

    // 7. handler
    try {
      const result = await route.handler({
        session: session ?? unauthenticatedSession(),
        operation: resolved.operation,
        body: resolved.body,
        request_id: requestId,
      });
      if (route.path === '/api/session' && method === 'POST') {
        // 会话建立：cookie 与 CSRF 令牌在这里一次性交给控制台。
        const issued = result as { readonly cookie_value: string };
        response.setHeader('Set-Cookie', setCookieHeader(issued.cookie_value));
      }
      if (route.path === '/api/session' && method === 'DELETE') {
        response.setHeader('Set-Cookie', clearCookieHeader());
      }
      return this.#json(response, 200, { ok: true, result });
    } catch (error) {
      if (error instanceof BridgeError) {
        this.#emit({ type: 'operation_failed', path, code: error.code });
        return this.#json(response, statusForBridgeError(error.code), {
          ok: false,
          error: { code: error.code, message: error.message },
        });
      }
      // 非 BridgeError 一律折成 INTERNAL_ERROR，**不回传原始 message**：
      // 里面可能带着本机路径或内部细节。原始错误留给本地审计。
      this.#emit({ type: 'operation_failed', path, code: 'INTERNAL_ERROR' });
      return this.#json(response, 500, {
        ok: false,
        error: { code: 'INTERNAL_ERROR', message: '本地服务内部错误。' },
      });
    }
  }

  #reject(response: ServerResponse, reject: Reject, status: number, path: string): void {
    this.#emit({ type: 'request_rejected', reason: reject.reason, detail: reject.detail, path });
    this.#json(response, status, {
      ok: false,
      // 回给请求方的信息是**固定的**，不含期望值：详见文件头注释。
      error: { code: 'NOT_AUTHORIZED', message: '请求来源或形态不被接受。' },
    });
  }

  #static(response: ServerResponse, asset: StaticControlAsset): void {
    response.statusCode = 200;
    response.setHeader('Content-Type', asset.content_type);
    response.setHeader('Content-Length', asset.body.byteLength);
    response.setHeader('Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
      "connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'",
    );
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    response.end(asset.body);
  }

  #json(response: ServerResponse, status: number, payload: unknown): void {
    const text = JSON.stringify(payload);
    response.statusCode = status;
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.end(text);
  }

  #emit(event: ControlEvent): void {
    this.#options.onEvent?.(event);
  }
}

class BodyError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

function headerOf(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  if (Array.isArray(value)) return value[0];
  return value;
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const declared = headerOf(request, 'content-length');
  if (declared !== undefined) {
    const length = Number(declared);
    if (Number.isFinite(length) && length > MAX_BODY_BYTES) {
      throw new BodyError(`请求体超过 ${MAX_BODY_BYTES} 字节上限。`, 413);
    }
  }

  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    total += buffer.length;
    // 逐块累计而不是只信 Content-Length：分块传输可以不带它，
    // 而一个没有上限的读循环是一个内存耗尽入口。
    if (total > MAX_BODY_BYTES) throw new BodyError(`请求体超过 ${MAX_BODY_BYTES} 字节上限。`, 413);
    chunks.push(buffer);
  }

  const text = Buffer.concat(chunks).toString('utf8');
  if (text.trim().length === 0) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new BodyError('请求体不是合法 JSON。', 400);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new BodyError('请求体必须是一个 JSON 对象。', 400);
  }
  return parsed as Record<string, unknown>;
}

/**
 * 请求体的内容摘要。nonce 绑定用的就是它。
 *
 * **排除 `nonce` 本身**：否则一个 nonce 无法绑定「不含它自己的那份内容」——
 * 摘要会随 nonce 变化，绑定永远不匹配。除此之外**键序也必须稳定**，
 * 因此按键名排序后再序列化：两份内容相同的 JSON 若键序不同却得到不同摘要，
 * 绑定会在一次无关紧要的序列化差异上失败。
 */
export function bodyDigest(body: Record<string, unknown>): string {
  const entries = Object.entries(body)
    .filter(([key]) => key !== 'nonce')
    // 排序用码元比较，**不用 `localeCompare`**：后者依赖区域设置，
    // 而控制台一侧（浏览器里）算的是同一份摘要。两个实现用不同的
    // 比较规则时，摘要会在某些键名组合上不一致 —— 表现为
    // 「所有变更类操作都因 nonce 绑定不匹配而失败」，且只在特定环境下出现。
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return createHash('sha256').update(JSON.stringify(entries), 'utf8').digest('hex');
}

function statusForBridgeError(code: BridgeErrorCode): number {
  switch (code) {
    case 'INVALID_ARGUMENT':
      return 400;
    case 'NOT_FOUND':
    case 'CHANGE_NOT_FOUND':
      return 404;
    case 'NOT_AUTHORIZED':
      return 403;
    default:
      return 400;
  }
}

/**
 * 免鉴权路由拿到的占位会话。
 *
 * 它**没有** `session_id` 之外的意义，且 `csrf_token` 是空串 ——
 * 任何试图拿它去签发 nonce 或校验 CSRF 的代码都会立刻失败，
 * 而不是「用一个不存在的会话通过了检查」。
 */
function unauthenticatedSession(): ControlSession {
  return {
    session_id: 'unauthenticated',
    created_at: 0,
    expires_at: 0,
    csrf_token: '',
  };
}

export { contentTypeOf, type ControlRoute };
