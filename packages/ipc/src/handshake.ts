/**
 * 挑战—应答握手（LWB-008 步骤 1、验收标准 2）。
 *
 * ## 为什么不做「先发凭证，服务端比对」
 *
 * 因为命名管道在**同一台机器**上。凭证一旦写进管道，同账户的任何进程
 * 只要能看到那次通信（抓包、注入、转储），就拿到了可重放的凭证。
 * 而本设计明确**不**防护同账户恶意进程（威胁模型 §3）——
 * 这意味着任何依赖「管道本身保密」的方案，前提就是错的。
 *
 * 因此凭证**从不过线**：双方各自持有它，只交换随机数，凭证只用来计算 HMAC。
 * 抓到的报文在另一次连接里没有用，因为服务端随机数每次都是新的。
 *
 * ## 单调计数器在证明里
 *
 * 证明里包含 `audience` 与用途标签（`lwb-ipc-v1`）。
 * 没有用途标签的 HMAC 可以在不同上下文间被搬用 —— 这是密码协议里
 * 最常见的真实缺陷之一，因此把它写进被签名的载荷，而不是靠调用方自觉。
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import type { Audience } from './audience.ts';

/** 领域分隔标签。改变它等于让所有旧证明失效，属于破坏性变更。 */
const PROOF_CONTEXT = 'lwb-ipc-v1';

/**
 * 本地 IPC 的协议版本，供 `bridge_status` 与启动日志回报。
 *
 * 它就是上面那个领域分隔标签，**不是**另抄一份字面量：两处各写一份的话，
 * 改了 `PROOF_CONTEXT` 而忘了另一处，表现是「状态页说 v1、实际握手要求 v2」
 * —— 一个只在跨版本排查时才会被读到的字段，说错不如不说。
 */
export const IPC_PROTOCOL_VERSION = PROOF_CONTEXT;

export const NONCE_BYTES = 32;

export function newNonce(): string {
  return randomBytes(NONCE_BYTES).toString('base64url');
}

/**
 * 由**该 audience 自己的**凭证派生连接的 HMAC 密钥。
 *
 * ## 参数是 audience 专属凭证，不是主凭证
 *
 * 这一点必须说清楚，因为它曾经写错过：如果参数是「一把共用的主凭证」，
 * 那么任何持有它的人都能对**任意** audience 算出示证 —— 分离就只是文档上的一句话，
 * 不是密码学性质。曾经本函数的实现正是那样，见
 * `docs/evidence/lwb-008/summary.md` 的「设计缺陷与修正」。
 *
 * 现在的约定：`audienceSecret` 是**只有该 audience 才拿到**的凭证
 * （对应 `secure-store` 的 `ipc` / `console` 两类凭证）。
 * 适配器进程只被投递 `mcp-adapter` 的凭证，因此它**算不出**控制台的证明 ——
 * 这不是一条 `if` 判断，而是它手上没有那个输入。
 *
 * 保留这一层 KDF（而不是直接拿凭证当 HMAC 密钥）是为了**领域分隔**：
 * 同一个凭证在别处被复用为其它用途的密钥时，这里的证明不会跟着失效。
 */
export function deriveAudienceKey(audienceSecret: string, audience: Audience): Buffer {
  return createHmac('sha256', Buffer.from(audienceSecret, 'utf8'))
    .update(`${PROOF_CONTEXT}\u0000audience\u0000${audience}`, 'utf8')
    .digest();
}

/**
 * 被签名的载荷。
 *
 * `server_nonce` 由服务端生成且**一次性**使用，因此：
 *  - 重放的证明在新连接上无效；
 *  - 攻击者无法预先计算（他看不到这次的 server_nonce）。
 *
 * `client_nonce` 由客户端生成，作用是让服务端也无法预计算 —— 双方都贡献随机性。
 */
function proofPayload(input: {
  readonly serverNonce: string;
  readonly clientNonce: string;
  readonly audience: Audience;
  readonly connectionId: string;
  readonly pid: number;
}): Buffer {
  return Buffer.from(
    [
      PROOF_CONTEXT,
      input.audience,
      input.connectionId,
      String(input.pid),
      input.serverNonce,
      input.clientNonce,
    ].join('\u0000'),
    'utf8',
  );
}

export function computeProof(
  key: Buffer,
  input: {
    readonly serverNonce: string;
    readonly clientNonce: string;
    readonly audience: Audience;
    readonly connectionId: string;
    readonly pid: number;
  },
): string {
  return createHmac('sha256', key).update(proofPayload(input)).digest('base64url');
}

export interface HandshakeRequest {
  readonly audience: Audience;
  readonly connection_id: string;
  readonly pid: number;
  readonly client_nonce: string;
  readonly proof: string;
}

export type HandshakeVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string; readonly code: HandshakeFailure };

export type HandshakeFailure =
  | 'UNKNOWN_AUDIENCE'
  | 'CONNECTION_ID_MISMATCH'
  | 'NONCE_REUSED'
  | 'BAD_PROOF'
  | 'MALFORMED';

/**
 * 校验一次握手。
 *
 * 顺序是刻意的：先做**便宜的、结构性的**检查，最后才做 HMAC 比较，
 * 且比较用 `timingSafeEqual`。不过这里要诚实说明：时序攻击对本地管道
 * 不是现实威胁（攻击者可以直接读进程内存），用 `timingSafeEqual`
 * 的成本为零，所以用它，但**不**把它当成一条安全论据。
 */
export function verifyHandshake(
  request: HandshakeRequest,
  expected: {
    readonly key: Buffer;
    readonly serverNonce: string;
    /** 本次连接之前已经用过的 client_nonce；用于挡住同连接内重放。 */
    readonly seenClientNonces: ReadonlySet<string>;
    /** 该 connection_id 是否已在本机注册。 */
    readonly isRegistered: (connectionId: string) => boolean;
  },
): HandshakeVerdict {
  if (
    typeof request.connection_id !== 'string' ||
    typeof request.client_nonce !== 'string' ||
    typeof request.proof !== 'string' ||
    typeof request.pid !== 'number'
  ) {
    return { ok: false, code: 'MALFORMED', reason: '握手请求字段缺失或类型不正确。' };
  }

  // 先查注册表：未注册的 connection_id 即使证明正确也不接受 ——
  // 「算得对」不等于「被允许」。反过来则会让任何持有凭证者自造一个身份。
  if (!expected.isRegistered(request.connection_id)) {
    return {
      ok: false,
      code: 'CONNECTION_ID_MISMATCH',
      reason: '该连接标识未在本机注册，拒绝。',
    };
  }

  if (expected.seenClientNonces.has(request.client_nonce)) {
    return { ok: false, code: 'NONCE_REUSED', reason: '本次握手的随机数已被使用过。' };
  }

  const computed = computeProof(expected.key, {
    serverNonce: expected.serverNonce,
    clientNonce: request.client_nonce,
    audience: request.audience,
    connectionId: request.connection_id,
    pid: request.pid,
  });

  if (!safeEqual(computed, request.proof)) {
    return { ok: false, code: 'BAD_PROOF', reason: '连接凭证无法通过校验。' };
  }

  return { ok: true };
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  // 长度不同时 timingSafeEqual 会抛错，因此先比长度。
  // 长度本身不是秘密（都是 base64url 的 HMAC-SHA256，固定 43 字符）。
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
