/**
 * IPC 客户端（LWB-008）。
 *
 * 控制台与适配器都用它。它刻意**不**知道任何业务操作：
 * 调用方给出操作名与输入，客户端只负责握手、分帧、超时与错误归类。
 *
 * ## 客户端也要做超时，且语义与服务端一致
 *
 * 服务端超时会回一条 `TIMEOUT` 且带 `outcome_unknown: true`。
 * 客户端自己超时（服务端没回）时，得到的信息更少，
 * 因此**更要**标成结果未知 —— 这类「我不知道发生了什么」的请求
 * 绝不能在下游被升级成「失败」或「成功」。
 */

import { connect, type Socket } from 'node:net';

import type { Audience, Capability } from './audience.ts';
import { computeProof, deriveAudienceKey, newNonce } from './handshake.ts';
import { encodeFrame, FrameDecoder, FrameParseError, FrameTooLargeError } from './framing.ts';

export class IpcUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IpcUnavailableError';
  }
}

export class IpcHandshakeError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'IpcHandshakeError';
    this.code = code;
  }
}

export type IpcOutcome =
  | { readonly ok: true; readonly result: unknown }
  /**
   * `outcome_unknown` 为真时，**不得**把这次调用当作失败处理，也不得自动重试。
   * 只有终态回执（I14）才能支持「已保存 / 未保存」的判断。
   */
  | {
      readonly ok: false;
      readonly code: string;
      readonly reason: string;
      readonly outcome_unknown: boolean;
    };

export interface IpcClientOptions {
  readonly pipeName: string;
  /**
   * **本 audience 自己的**连接凭证。客户端只持有自己那一把；
   * 它没有、也不该有另一条 audience 的凭证。
   */
  readonly secret: string;
  readonly audience: Audience;
  readonly connectionId: string;
  readonly connectTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
}

export const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;
export const DEFAULT_CLIENT_REQUEST_TIMEOUT_MS = 60_000;

interface Pending {
  readonly resolve: (outcome: IpcOutcome) => void;
  readonly timer: NodeJS.Timeout;
}

export class IpcClient {
  readonly #options: IpcClientOptions;
  #socket: Socket | null = null;
  #capabilities: readonly Capability[] = [];
  #pending = new Map<string, Pending>();
  #nextRequestId = 0;
  #closedReason: string | null = null;

  constructor(options: IpcClientOptions) {
    this.#options = options;
  }

  get capabilities(): readonly Capability[] {
    return this.#capabilities;
  }

  async connect(): Promise<void> {
    const socket = await this.#open();
    const decoder = new FrameDecoder();

    try {
      const hello = await this.#awaitHello(socket, decoder);
      const clientNonce = newNonce();

      const key = deriveAudienceKey(this.#options.secret, this.#options.audience);
      const proof = computeProof(key, {
        serverNonce: hello,
        clientNonce,
        audience: this.#options.audience,
        connectionId: this.#options.connectionId,
        pid: process.pid,
      });

      socket.write(
        encodeFrame({
          type: 'handshake',
          audience: this.#options.audience,
          connection_id: this.#options.connectionId,
          pid: process.pid,
          client_nonce: clientNonce,
          proof,
        }),
      );

      await this.#awaitWelcome(socket, decoder);

      // 从 `#awaitFirst` 的清理到这一行之间**全是同步代码**，
      // 因此不会有 data 事件落在这段空隙里被丢掉。
      // 一旦有人在中间插入 `await`，这个保证就没了 —— 那时必须改成
      // 「先装 pump、握手报文也交给 pump 分流」。
      socket.on('data', (chunk: string) => this.#pump(decoder, chunk));
      socket.on('error', (error) => this.#failAll(new IpcUnavailableError(error.message)));
      socket.on('close', () => this.#failAll(new IpcUnavailableError('本地连接已断开。')));
      this.#socket = socket;
    } catch (error) {
      // 握手失败必须销毁套接字。否则调用方以为连接没建立，
      // 而管道里却留着一条已连上的空闲连接，服务端会一直为它保留会话。
      socket.destroy();
      throw error;
    }
  }

  /**
   * 发起一次调用。
   *
   * 连接不可用时**立即**返回失败，而不是排队等待重连：
   * 排队会在 daemon 重启时把一批请求灌进去，而那些请求的批准绑定（I06）
   * 可能已经随之前的会话失效。
   */
  async call(operation: string, input: unknown): Promise<IpcOutcome> {
    const socket = this.#socket;
    if (!socket || socket.destroyed) {
      return {
        ok: false,
        code: 'IPC_UNAVAILABLE',
        reason: this.#closedReason ?? '本地连接不可用。',
        outcome_unknown: false,
      };
    }

    const requestId = `req_${++this.#nextRequestId}`;
    const timeoutMs = this.#options.requestTimeoutMs ?? DEFAULT_CLIENT_REQUEST_TIMEOUT_MS;

    return await new Promise<IpcOutcome>((resolve) => {
      const timer = setTimeout(() => {
        this.#pending.delete(requestId);
        resolve({
          ok: false,
          code: 'TIMEOUT',
          reason: '本地调用在时限内没有返回，**结果未知**；不得据此重试。',
          outcome_unknown: true,
        });
      }, timeoutMs);
      timer.unref?.();

      this.#pending.set(requestId, { resolve, timer });
      socket.write(encodeFrame({ type: 'request', request_id: requestId, operation, input }));
    });
  }

  async close(): Promise<void> {
    const socket = this.#socket;
    this.#socket = null;
    this.#failAll(new IpcUnavailableError('本地连接已关闭。'));
    if (!socket || socket.destroyed) return;
    await new Promise<void>((resolve) => {
      socket.end(() => resolve());
    });
  }

  async #open(): Promise<Socket> {
    const timeoutMs = this.#options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    return await new Promise<Socket>((resolve, reject) => {
      const socket = connect(this.#options.pipeName);
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new IpcUnavailableError('连接本地 daemon 超时，daemon 可能未运行。'));
      }, timeoutMs);
      timer.unref?.();

      socket.once('connect', () => {
        clearTimeout(timer);
        socket.setEncoding('utf8');
        resolve(socket);
      });
      socket.once('error', (error) => {
        clearTimeout(timer);
        reject(new IpcUnavailableError(`无法连接本地 daemon：${error.message}`));
      });
    });
  }

  async #awaitHello(socket: Socket, decoder: FrameDecoder): Promise<string> {
    return await this.#awaitFirst(socket, decoder, (message) => {
      if (message['type'] !== 'hello' || typeof message['server_nonce'] !== 'string') {
        throw new IpcHandshakeError('本地服务端的挑战报文格式不正确。', 'MALFORMED');
      }
      return message['server_nonce'];
    });
  }

  async #awaitWelcome(socket: Socket, decoder: FrameDecoder): Promise<void> {
    await this.#awaitFirst(socket, decoder, (message) => {
      if (message['type'] === 'rejected') {
        throw new IpcHandshakeError(
          `本地服务端拒绝连接：${String(message['reason'] ?? '未说明原因')}`,
          String(message['code'] ?? 'REJECTED'),
        );
      }
      if (message['type'] !== 'welcome') {
        throw new IpcHandshakeError('本地服务端的应答报文格式不正确。', 'MALFORMED');
      }
      const caps = message['capabilities'];
      this.#capabilities = Array.isArray(caps) ? (caps as Capability[]) : [];
      return undefined;
    });
  }

  /** 在切换到 `#pump` 之前，同步读一条报文。 */
  async #awaitFirst<T>(
    socket: Socket,
    decoder: FrameDecoder,
    extract: (message: Record<string, unknown>) => T,
  ): Promise<T> {
    return await new Promise<T>((resolve, reject) => {
      const onData = (chunk: string): void => {
        let messages: unknown[];
        try {
          messages = decoder.push(chunk);
        } catch (error) {
          cleanup();
          reject(error instanceof FrameTooLargeError || error instanceof FrameParseError
            ? new IpcHandshakeError(error.message, 'MALFORMED')
            : error);
          return;
        }
        if (messages.length === 0) return;
        const first = messages[0];
        cleanup();
        try {
          if (typeof first !== 'object' || first === null) {
            throw new IpcHandshakeError('本地服务端发来的不是对象报文。', 'MALFORMED');
          }
          resolve(extract(first as Record<string, unknown>));
        } catch (error) {
          reject(error);
        }
      };
      const onError = (error: Error): void => {
        cleanup();
        reject(new IpcUnavailableError(error.message));
      };
      // 对端在读到我方握手之前就断开时，只有 `close` 会到达。
      // 少了这条监听，`connect()` 会永远挂起 —— 调用方看到的是「卡住」，
      // 而真实原因（服务端拒绝了连接）永远不会浮现。
      const onClose = (): void => {
        cleanup();
        reject(new IpcUnavailableError('本地服务端在完成握手前就关闭了连接。'));
      };
      const cleanup = (): void => {
        socket.removeListener('data', onData);
        socket.removeListener('error', onError);
        socket.removeListener('close', onClose);
      };
      socket.on('data', onData);
      socket.on('error', onError);
      socket.on('close', onClose);
    });
  }

  #pump(decoder: FrameDecoder, chunk: string): void {
    let messages: unknown[];
    try {
      messages = decoder.push(chunk);
    } catch {
      // 解析失败意味着双方的协议理解已经不一致，继续用这条连接
      // 会让后续回执对应到错误的请求上。
      this.#failAll(new IpcUnavailableError('本地连接报文无法解析，已放弃该连接。'));
      this.#socket?.destroy();
      return;
    }

    for (const value of messages) {
      if (typeof value !== 'object' || value === null) continue;
      const message = value as Record<string, unknown>;
      if (message['type'] !== 'response') continue;

      const requestId = String(message['request_id'] ?? '');
      const pending = this.#pending.get(requestId);
      if (!pending) continue;
      this.#pending.delete(requestId);
      clearTimeout(pending.timer);

      if (message['ok'] === true) {
        pending.resolve({ ok: true, result: message['result'] });
      } else {
        pending.resolve({
          ok: false,
          code: String(message['code'] ?? 'UNKNOWN'),
          reason: String(message['reason'] ?? ''),
          outcome_unknown: message['outcome_unknown'] === true,
        });
      }
    }
  }

  #failAll(error: Error): void {
    const pending = [...this.#pending.values()];
    this.#pending.clear();
    for (const entry of pending) {
      clearTimeout(entry.timer);
      entry.resolve({
        ok: false,
        code: 'IPC_INTERRUPTED',
        reason: `${error.message} 该请求的结果**未知**。`,
        outcome_unknown: true,
      });
    }
  }
}
