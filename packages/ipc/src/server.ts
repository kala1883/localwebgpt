/**
 * IPC 服务端会话（LWB-008 步骤 1–2、验收标准 2）。
 *
 * ## 一次连接的生命周期
 *
 * ```
 * 服务端 → hello   { server_nonce }
 * 客户端 → handshake { audience, connection_id, pid, client_nonce, proof }
 * 服务端 → welcome { capabilities }        ← 只有证明通过才发
 * 客户端 → request { request_id, operation, input, fencing_token? }
 * 服务端 → response { request_id, ok, ... }
 * ```
 *
 * 握手之前，**除 handshake 之外的任何报文都被拒绝并断开连接**。
 * 这一点值得写下来：如果实现成「不认识的报文就先放着、等握手完成后处理」，
 * 那么在握手完成前就到达的请求会被静默排队并在之后执行 ——
 * 攻击者只要在连接刚建立时抢先发一条 request 即可。
 *
 * ## 能力每次请求都重新查表
 *
 * 不在连接建立时把能力快照下发后就信任它。收紧策略必须对
 * **已有连接**立即生效，否则一次正在进行的会话会把旧权限用到它自己结束。
 */

import {
  capabilitiesOf,
  hasCapability,
  isAudience,
  type Audience,
  type AudienceSecrets,
  type Capability,
} from './audience.ts';
import {
  deriveAudienceKey,
  newNonce,
  verifyHandshake,
  type HandshakeFailure,
} from './handshake.ts';
import { encodeFrame, FrameDecoder, FrameParseError, FrameTooLargeError } from './framing.ts';
import type { OperationRegistry, RequestContext } from './operations.ts';

/** 单次请求的处理上限。超过后**返回超时**，而不是当作失败。 */
export const REQUEST_TIMEOUT_MS = 30_000;

export type SessionEvent =
  | { readonly type: 'handshake_ok'; readonly audience: Audience; readonly connection_id: string }
  | {
      readonly type: 'handshake_failed';
      readonly code: HandshakeFailure;
      readonly reason: string;
      readonly remote_pid: number | null;
    }
  | { readonly type: 'capability_denied'; readonly audience: Audience; readonly operation: string }
  | { readonly type: 'unknown_operation'; readonly operation: string }
  | { readonly type: 'timeout'; readonly request_id: string; readonly operation: string }
  | { readonly type: 'protocol_error'; readonly reason: string }
  | { readonly type: 'closed'; readonly pending_bytes: number };

export interface SessionOptions {
  /**
   * 各 audience 的**专属**连接凭证（不是共用主凭证）。
   * 见 `deriveAudienceKey` 的注释：共用凭证会让 audience 分离失效。
   */
  readonly secrets: AudienceSecrets;
  readonly operations: OperationRegistry;
  readonly isRegisteredConnection: (connectionId: string) => boolean;
  readonly onEvent?: (event: SessionEvent) => void;
  readonly requestTimeoutMs?: number;
  readonly now?: () => number;
}

/** 会话输出的最小接口。`net.Socket` 满足它，测试用内存链路也满足它。 */
export interface MessageSink {
  send(value: unknown): void;
  close(): void;
}

export class ConnectionSession {
  readonly #options: SessionOptions;
  readonly #sink: MessageSink;
  readonly #serverNonce = newNonce();
  readonly #seenClientNonces = new Set<string>();
  #audience: Audience | null = null;
  #peerPid: number | null = null;
  #connectionId: string | null = null;
  #closed = false;

  constructor(sink: MessageSink, options: SessionOptions) {
    this.#sink = sink;
    this.#options = options;
  }

  get authenticated(): boolean {
    return this.#audience !== null;
  }

  /** 连接建立后先发挑战。 */
  start(): void {
    this.#sink.send({ type: 'hello', context: 'lwb-ipc-v1', server_nonce: this.#serverNonce });
  }

  handle(value: unknown): void {
    if (this.#closed) return;
    if (typeof value !== 'object' || value === null) {
      this.#fail('protocol_error', '报文不是对象。');
      return;
    }
    const message = value as Record<string, unknown>;

    if (!this.authenticated) {
      if (message['type'] !== 'handshake') {
        // 见文件头注释：握手前到达的任何其它报文都必须断开，不能排队。
        this.#fail(
          'protocol_error',
          `握手完成前的报文类型 ${String(message['type'])} 不被接受，已断开连接。`,
        );
        return;
      }
      this.#handleHandshake(message);
      return;
    }

    if (message['type'] !== 'request') {
      this.#fail('protocol_error', `已认证连接收到非 request 报文：${String(message['type'])}。`);
      return;
    }
    void this.#handleRequest(message);
  }

  onClose(pendingBytes: number): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#emit({ type: 'closed', pending_bytes: pendingBytes });
  }

  #handleHandshake(message: Record<string, unknown>): void {
    const audience = message['audience'];
    if (typeof audience !== 'string' || !isAudience(audience)) {
      // 未知 audience 在派生密钥之前就被挡住，因此不会有「用主凭证兜底」的路径。
      this.#handshakeFailed('UNKNOWN_AUDIENCE', '请求声明的连接身份不在允许集合内。', null);
      return;
    }

    const request = {
      audience,
      connection_id: String(message['connection_id'] ?? ''),
      pid: typeof message['pid'] === 'number' ? message['pid'] : Number.NaN,
      client_nonce: String(message['client_nonce'] ?? ''),
      proof: String(message['proof'] ?? ''),
    };

    // 用**该 audience 自己的**凭证派生。持有适配器凭证的一方
    // 算不出控制台那条 audience 的密钥，因此冒充在数学上不可行。
    const key = deriveAudienceKey(this.#options.secrets[audience], audience);

    const verdict = verifyHandshake(request, {
      key,
      serverNonce: this.#serverNonce,
      seenClientNonces: this.#seenClientNonces,
      isRegistered: this.#options.isRegisteredConnection,
    });

    if (!verdict.ok) {
      this.#handshakeFailed(verdict.code, verdict.reason, Number.isNaN(request.pid) ? null : request.pid);
      return;
    }

    this.#seenClientNonces.add(request.client_nonce);
    this.#audience = audience;
    this.#peerPid = request.pid;
    this.#connectionId = request.connection_id;

    this.#emit({
      type: 'handshake_ok',
      audience,
      connection_id: request.connection_id,
    });
    this.#sink.send({ type: 'welcome', capabilities: capabilitiesOf(audience) });
  }

  async #handleRequest(message: Record<string, unknown>): Promise<void> {
    const audience = this.#audience;
    const connectionId = this.#connectionId;
    if (audience === null || connectionId === null) return;

    const requestId = String(message['request_id'] ?? '');
    const operationName = String(message['operation'] ?? '');

    if (requestId.length === 0 || operationName.length === 0) {
      this.#fail('protocol_error', '请求缺少 request_id 或 operation。');
      return;
    }

    const definition = this.#options.operations.lookup(operationName);
    if (!definition) {
      // 不告诉调用者「有哪些操作」—— 操作清单本身就是攻击面地图。
      this.#emit({ type: 'unknown_operation', operation: operationName });
      this.#respond(requestId, {
        ok: false,
        code: 'UNKNOWN_OPERATION',
        reason: '未知操作。',
      });
      return;
    }

    // 每次请求重新查表，见文件头注释。
    if (!hasCapability(audience, definition.required)) {
      this.#emit({ type: 'capability_denied', audience, operation: operationName });
      this.#respond(requestId, {
        ok: false,
        code: 'CAPABILITY_DENIED',
        reason: `该连接身份无权执行操作，所需能力：${definition.required}。`,
      });
      return;
    }

    const context: RequestContext = {
      audience,
      connection_id: connectionId,
      pid: this.#peerPid ?? -1,
      request_id: requestId,
    };

    try {
      const result = await this.#withTimeout(
        this.#options.operations.invoke(definition, message['input'], context),
        requestId,
        operationName,
      );
      if (result.timedOut) {
        // I09：超时**不是**失败证据 —— 操作可能已经成功。
        // 因此回执里必须同时给出「结果未知」这个事实，让上层去查询终态，
        // 而不是让调用者据此重试（重试可能造成第二次写入）。
        this.#respond(requestId, {
          ok: false,
          code: 'TIMEOUT',
          outcome_unknown: true,
          reason:
            '操作在时限内没有返回，**结果未知**。不得据此重试；请通过状态查询确认是否已生效。',
        });
        return;
      }
      this.#respond(requestId, { ok: true, result: result.value });
    } catch (error) {
      this.#respond(requestId, {
        ok: false,
        code: 'OPERATION_FAILED',
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async #withTimeout(
    promise: Promise<unknown>,
    requestId: string,
    operationName: string,
  ): Promise<{ timedOut: true } | { timedOut: false; value: unknown }> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<{ timedOut: true }>((resolve) => {
      timer = setTimeout(() => {
        this.#emit({ type: 'timeout', request_id: requestId, operation: operationName });
        resolve({ timedOut: true });
      }, this.#options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS);
      // 定时器不应让进程活着：否则一个卡住的请求会让 daemon 无法退出。
      timer.unref?.();
    });

    try {
      const outcome = await Promise.race([
        promise.then((value) => ({ timedOut: false as const, value })),
        timeout,
      ]);
      return outcome;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  #respond(requestId: string, body: Record<string, unknown>): void {
    this.#sink.send({ type: 'response', request_id: requestId, ...body });
  }

  #handshakeFailed(code: HandshakeFailure, reason: string, remotePid: number | null): void {
    this.#emit({ type: 'handshake_failed', code, reason, remote_pid: remotePid });
    this.#sink.send({ type: 'rejected', code, reason });
    this.#sink.close();
    this.#closed = true;
  }

  #fail(kind: 'protocol_error', reason: string): void {
    this.#emit({ type: kind, reason });
    this.#sink.send({ type: 'rejected', code: 'PROTOCOL_ERROR', reason });
    this.#sink.close();
    this.#closed = true;
  }

  #emit(event: SessionEvent): void {
    this.#options.onEvent?.(event);
  }
}

/** 把 `net.Socket` 适配成 `MessageSink` + 喂入解帧器。 */
export function attachSocket(
  socket: import('node:net').Socket,
  options: SessionOptions,
): ConnectionSession {
  const decoder = new FrameDecoder();

  const sink: MessageSink = {
    send(value: unknown) {
      if (socket.destroyed) return;
      try {
        socket.write(encodeFrame(value));
      } catch (error) {
        if (error instanceof FrameTooLargeError) {
          options.onEvent?.({ type: 'protocol_error', reason: error.message });
          socket.destroy();
          return;
        }
        throw error;
      }
    },
    close() {
      socket.end();
    },
  };

  // `sink` 只会在会话方法内部被调用，而那些调用都发生在这行之后，
  // 因此这里不需要 `let` + 延后赋值。
  const session = new ConnectionSession(sink, options);

  socket.setEncoding('utf8');
  socket.on('data', (chunk: string) => {
    let messages: unknown[];
    try {
      messages = decoder.push(chunk);
    } catch (error) {
      if (error instanceof FrameTooLargeError) {
        // 超限一律断开：继续读会让攻击者用超大报文拖垮 daemon。
        options.onEvent?.({ type: 'protocol_error', reason: error.message });
        socket.destroy();
        return;
      }
      if (error instanceof FrameParseError || error instanceof SyntaxError) {
        options.onEvent?.({ type: 'protocol_error', reason: '收到无法解析的报文。' });
        socket.destroy();
        return;
      }
      throw error;
    }
    for (const message of messages) session.handle(message);
  });

  socket.on('error', () => {
    // 对端消失是常态（控制台被关掉），不记为协议错误。
    session.onClose(decoder.pendingBytes);
  });

  socket.on('close', () => {
    session.onClose(decoder.pendingBytes);
  });

  session.start();
  return session;
}
