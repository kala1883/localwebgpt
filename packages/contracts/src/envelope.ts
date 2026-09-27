/**
 * 工具结果信封。
 *
 * 所有 12 个 MCP 工具共用同一信封，便于：
 *  - 每个响应都携带 request_id，可回溯到本地审计记录；
 *  - 业务错误与协议错误使用同一结构，但 category 不同；
 *  - 模型无法通过响应形状推断本机绝对路径（结果里永远只有工作区内相对路径）。
 */

import type { BridgeErrorPayload } from './errors.ts';
import { newRequestId } from './ids.ts';

export interface OkEnvelope<T> {
  readonly ok: true;
  readonly data: T;
  readonly request_id: string;
}

export interface ErrEnvelope {
  readonly ok: false;
  readonly error: BridgeErrorPayload;
  readonly request_id: string;
}

export type Envelope<T> = OkEnvelope<T> | ErrEnvelope;

export function ok<T>(data: T, requestId?: string): OkEnvelope<T> {
  return { ok: true, data, request_id: requestId ?? newRequestId() };
}

export function err(error: BridgeErrorPayload, requestId?: string): ErrEnvelope {
  return { ok: false, error, request_id: requestId ?? newRequestId() };
}

export function isOk<T>(env: Envelope<T>): env is OkEnvelope<T> {
  return env.ok === true;
}

export function isErr<T>(env: Envelope<T>): env is ErrEnvelope {
  return env.ok === false;
}

/**
 * 一致性说明。逐文件快照不代表整个仓库同一时刻的全局快照。
 * 所有涉及多文件的读取类结果都必须带此字段。
 */
export type Consistency = 'per_file';

export const CONSISTENCY_PER_FILE: Consistency = 'per_file';
