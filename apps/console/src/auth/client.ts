/**
 * 控制台调用控制 API 的客户端（LWB-012 步骤 2）。
 *
 * ## 每个请求都做三件事，缺一不可
 *
 * 1. `credentials: 'same-origin'` —— 带上会话 cookie。
 * 2. `Content-Type: application/json` —— 服务端强制要求；它同时让
 *    跨站伪造的请求无法作为「简单请求」发出（见 `apps/daemon/src/control/origin.ts`）。
 * 3. `x-lwb-csrf` 头 —— 服务端持有的那个 CSRF 令牌，只在这里出现。
 *
 * ## `redirect: 'error'` 不是保守，是必需的
 *
 * `fetch` 默认跟随重定向（`redirect: 'follow'`）。一旦跟随，
 * **请求头会被带到重定向的目标去**。设想服务端（或中间任何一层）
 * 返回 `302 Location: http://evil.com/`：浏览器会把带着 `x-lwb-csrf`
 * 头的请求重新发往 `evil.com`。那个头里装的是 CSRF 令牌，
 * 而它与会话 cookie 配合就能完成一次变更操作。
 *
 * 控制 API 本来就不该重定向（所有响应都是明确的 JSON），因此
 * `redirect: 'error'` 在功能上没有任何损失，却关掉了这整类泄露。
 *
 * ## CSRF 令牌只放在内存里
 *
 * 不进 `localStorage`、不进 `sessionStorage`。理由：那两个地方
 * 会被任何一次 XSS 读到，也会在磁盘上留下副本；而这个模块把它
 * 关在自己的闭包里，页面刷新即消失 —— 刷新后本来就要重新建立会话。
 */

import { CONTROL_CSRF_HEADER } from './constants.ts';
import type { ConsoleSession } from './bootstrap.ts';

export interface ControlApiError {
  readonly status: number;
  readonly code: string;
  readonly message: string;
  /** 会话过期（401）。上层据此提示「重新运行本地启动命令」。 */
  readonly session_expired: boolean;
}

export class ControlApiFailure extends Error {
  readonly detail: ControlApiError;
  constructor(detail: ControlApiError) {
    super(detail.message);
    this.name = 'ControlApiFailure';
    this.detail = detail;
  }
}

export interface ControlClientOptions {
  readonly origin: string;
  readonly fetchImpl: typeof fetch;
}

/**
 * 控制台 API 客户端。
 *
 * **只接受回环 origin**（构造时检查）：一个被配置成指向别处的客户端
 * 会把 CSRF 令牌与请求体发到那个别处去，而这件事在功能上完全正常
 * —— 直到有人拿它去钓鱼。
 */
export class ControlClient {
  readonly #origin: string;
  readonly #fetch: typeof fetch;
  #session: ConsoleSession | null = null;

  constructor(options: ControlClientOptions) {
    if (!/^http:\/\/(127\.0\.0\.1|\[::1\]):\d+$/.test(options.origin)) {
      throw new Error(`控制台客户端只接受回环 origin，收到 ${options.origin}。`);
    }
    this.#origin = options.origin;
    this.#fetch = options.fetchImpl;
  }

  get session(): ConsoleSession | null {
    return this.#session;
  }

  setSession(session: ConsoleSession | null): void {
    this.#session = session;
  }

  setSessionFrom(bootstrapped: ConsoleSession | null): void {
    if (bootstrapped !== null) this.#session = bootstrapped;
  }

  /**
   * 发起一次 API 调用。
   *
   * `nonce` 只在变更类调用上出现。它由服务端的 `POST /api/nonces` 签发，
   * 绑定 `(operation, subject, digest)` —— 因此**内容变了就必须重新申请**，
   * 而这里的 `body` 一旦被改动，服务端算出来的摘要就对不上，
   * 于是那次调用会被拒绝。这是有意的：见 `session.ts` 的 nonce 说明。
   */
  async call(
    path: string,
    body: Record<string, unknown> = {},
    options: { readonly nonce?: string; readonly subject?: string } = {},
  ): Promise<unknown> {
    const session = this.#session;
    if (session === null) {
      throw new ControlApiFailure({
        status: 401,
        code: 'NOT_AUTHORIZED',
        message: '尚未建立控制台会话。',
        session_expired: true,
      });
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      [CONTROL_CSRF_HEADER]: session.csrf_token,
      // 显式带上 Origin，**不是**可有可无的礼节。
      //
      // 服务端对变更类请求要求 Origin（缺了就是 403，见 daemon 的 origin.ts）。
      // 在浏览器里这个头由浏览器自动加，代码不写也能跑 —— 于是它成了一条
      // 「靠运行环境补上」的隐含依赖：任何一层把 Origin 吃掉
      // （polyfill、Service Worker、把页面放进某种代理壳里），
      // 控制台就整个不能用了，而报错只会说「请求来源不被接受」。
      //
      // 在浏览器里显式设它不会出问题：`Origin` 属于 fetch 的**禁止头**，
      // 设置会被忽略，浏览器仍然写入它自己的值 —— 也就是说这一行
      // 在浏览器里是空操作、在非浏览器环境里是那个必需的补全。
      // 两边都正确，且这条依赖从此写在代码里而不是写在环境里。
      Origin: this.#origin,
    };

    const payload: Record<string, unknown> = { ...body };
    if (options.nonce !== undefined) payload['nonce'] = options.nonce;
    if (options.subject !== undefined) payload['subject'] = options.subject;

    const response = await this.#fetch(`${this.#origin}${path}`, {
      method: 'POST',
      credentials: 'same-origin',
      headers,
      body: JSON.stringify(payload),
      redirect: 'error',
    });

    const parsed = (await response.json()) as {
      readonly ok?: boolean;
      readonly result?: unknown;
      readonly error?: { readonly code?: unknown; readonly message?: unknown };
    };

    if (response.ok && parsed.ok === true) return parsed.result;

    const code = typeof parsed.error?.code === 'string' ? parsed.error.code : 'INTERNAL_ERROR';
    const message = typeof parsed.error?.message === 'string' ? parsed.error.message : '请求失败。';
    const failure: ControlApiError = {
      status: response.status,
      code,
      message,
      session_expired: response.status === 401,
    };
    if (failure.session_expired) this.#session = null;
    throw new ControlApiFailure(failure);
  }

  /** 读取 GET 控制路由（如 `/api/status`），沿用同源 Cookie 与 CSRF 会话。 */
  async get(path: string): Promise<unknown> {
    const session = this.#session;
    if (session === null) {
      throw new ControlApiFailure({
        status: 401,
        code: 'NOT_AUTHORIZED',
        message: '尚未建立控制台会话。',
        session_expired: true,
      });
    }
    const response = await this.#fetch(`${this.#origin}${path}`, {
      method: 'GET',
      credentials: 'same-origin',
      headers: {
        [CONTROL_CSRF_HEADER]: session.csrf_token,
        Origin: this.#origin,
      },
      redirect: 'error',
    });
    const parsed = (await response.json()) as {
      readonly ok?: boolean;
      readonly result?: unknown;
      readonly error?: { readonly code?: unknown; readonly message?: unknown };
    };
    if (response.ok && parsed.ok === true) return parsed.result;
    const failure: ControlApiError = {
      status: response.status,
      code: typeof parsed.error?.code === 'string' ? parsed.error.code : 'INTERNAL_ERROR',
      message: typeof parsed.error?.message === 'string' ? parsed.error.message : '请求失败。',
      session_expired: response.status === 401,
    };
    if (failure.session_expired) this.#session = null;
    throw new ControlApiFailure(failure);
  }

  /**
   * 发起一次变更调用：**摘要与 nonce 由本方法负责**。
   *
   * 调用方交出的是它**即将发送的那份内容**，仅此而已。这一点是有意设计的 ——
   * 见 `requestNonce` 的说明：把「摘要该覆盖哪些字段」交给调用方，
   * 是这条链路上最容易搞错、且搞错后最难诊断的一处。
   *
   * 返回的就是最终应当发送的请求体（已含 `subject` 与 `nonce`）。
   */
  async authorizeMutation(
    operation: string,
    subject: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    // `subject` 必须在摘要**之内**：服务端绑定的是
    // `(operation, subject, bodyDigest(请求体去 nonce))`，
    // 而请求体里带着 subject。少算它，摘要就永远对不上。
    const full: Record<string, unknown> = { ...body, subject };
    const digest = await digestOfBody(full);
    const nonce = await this.requestNonce({ operation, subject, digest });
    return { ...full, nonce };
  }

  /**
   * 申请一张一次性 nonce，绑定 `(operation, subject, digest)`。
   *
   * **这是底层接口，用错了不会报错，只会永远被拒。** 摘要必须覆盖
   * 「即将发送的那份请求体，去掉 `nonce` 字段」—— 注意请求体里**包含
   * `subject`**（服务端从请求体里读它，并把它一并算进摘要）。因此
   * 一个「先算 body 的摘要、再把 subject 加进请求体」的写法，
   * 得到的是一张永远不会匹配的 nonce，而失败信息只会说
   * 「与本次请求的内容不匹配」，看不出是哪里多算少算了。
   *
   * 除非确实需要手工控制摘要，否则用 `authorizeMutation`。
   */
  async requestNonce(binding: {
    readonly operation: string;
    readonly subject: string;
    readonly digest: string;
  }): Promise<string> {
    const result = (await this.call('/api/nonces', {
      operation: binding.operation,
      subject: binding.subject,
      digest: binding.digest,
    })) as { readonly nonce?: unknown };
    if (typeof result?.nonce !== 'string') {
      throw new ControlApiFailure({
        status: 500,
        code: 'INTERNAL_ERROR',
        message: 'nonce 响应格式不正确。',
        session_expired: false,
      });
    }
    return result.nonce;
  }

  /** 登出。失败不抛错：登出是幂等的，用户不该被卡在「登不出去」的状态里。 */
  async logout(): Promise<void> {
    const session = this.#session;
    try {
      await this.#fetch(`${this.#origin}/api/session`, {
        method: 'DELETE',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          Origin: this.#origin,
          ...(session === null ? {} : { [CONTROL_CSRF_HEADER]: session.csrf_token }),
        },
        body: JSON.stringify(session === null ? {} : { session_id: session.session_id }),
        redirect: 'error',
      });
    } catch {
      // 忽略：本地状态已经清掉了，服务端的会话会自己过期。
    }
    this.#session = null;
  }
}

/**
 * 计算请求体的摘要，用于 nonce 绑定。
 *
 * 与服务端 `bodyDigest` **必须**一致：排除 `nonce` 字段、按键名排序后再序列化。
 * 两处实现漂移的后果是「所有变更类操作都因绑定不匹配而失败」——
 * 一个会立刻被发现的失效，但发现它的人不一定知道该往哪儿看，
 * 所以两边都写了指向对方的注释。
 */
export async function digestOfBody(body: Record<string, unknown>): Promise<string> {
  const entries = Object.entries(body)
    .filter(([key]) => key !== 'nonce')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const text = JSON.stringify(entries);
  const bytes = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
