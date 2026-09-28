/**
 * 从受保护快照库读取并校验单个恢复快照，供本地保存界面使用。
 *
 * 目标目录和生成的随机文件名只留在浏览器：HTTP 请求只绑定
 * operation/item/version/confirmed 四项。响应在交给文件写入 API 前再
 * 核对长度与 SHA-256。
 */

import { LIMITS } from '@lwb/contracts/limits';

export const RECOVERY_EXPORT_ENDPOINT = '/api/recovery/export_snapshot' as const;
export const RECOVERY_EXPORT_OPERATION = RECOVERY_EXPORT_ENDPOINT;

export function suggestedRecoverySnapshotName(
  relativePath: string,
  snapshot: 'original' | 'proposed',
): string {
  const pathLeaf = relativePath.split('/').at(-1) ?? 'snapshot';
  const normalizedLeaf = pathLeaf.replace(/[^\p{L}\p{N}._-]/gu, '_').replace(/[. ]+$/g, '') || 'snapshot';
  const safeLeaf = Array.from(normalizedLeaf).slice(0, 96).join('');
  return `recovery-${safeLeaf}-${snapshot}.snapshot`;
}

export interface RecoveryExportClient {
  authorizeMutation(
    operation: string,
    subject: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
  call(path: string, body: Record<string, unknown>): Promise<unknown>;
}

export interface RecoverySnapshotBytes {
  readonly operation_id: string;
  readonly item_id: string;
  readonly snapshot: 'original' | 'proposed';
  readonly file_name: string;
  readonly content_type: 'application/octet-stream';
  readonly sha256: string;
  readonly size: number;
  readonly bytes: Uint8Array;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function decodeBase64(value: string): Uint8Array {
  if (value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error('快照响应不是合法的 Base64 数据。');
  }
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  const bytes = new Uint8Array((value.length / 4) * 3 - padding);
  let output = 0;
  for (let index = 0; index < value.length; index += 4) {
    const a = alphabet.indexOf(value[index] ?? '');
    const b = alphabet.indexOf(value[index + 1] ?? '');
    const cChar = value[index + 2] ?? '';
    const dChar = value[index + 3] ?? '';
    const c = cChar === '=' ? 0 : alphabet.indexOf(cChar);
    const d = dChar === '=' ? 0 : alphabet.indexOf(dChar);
    if (a < 0 || b < 0 || c < 0 || d < 0) throw new Error('快照响应包含非法 Base64 字符。');
    const packed = (a << 18) | (b << 12) | (c << 6) | d;
    if (output < bytes.length) bytes[output++] = (packed >>> 16) & 0xff;
    if (output < bytes.length) bytes[output++] = (packed >>> 8) & 0xff;
    if (output < bytes.length) bytes[output++] = packed & 0xff;
  }
  return bytes;
}

async function sha256Of(bytes: Uint8Array): Promise<string> {
  if (globalThis.crypto?.subtle === undefined) throw new Error('当前浏览器无法校验快照完整性。');
  // 新建 ArrayBuffer，避免把 Uint8Array 的视图偏移或 SharedArrayBuffer 交给 WebCrypto。
  const stable = new Uint8Array(bytes.byteLength);
  stable.set(bytes);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', stable);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function validateFileName(value: unknown): value is string {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 180 &&
    !/[\\/:*?"<>|\u0000-\u001f]/.test(value) &&
    value !== '.' &&
    value !== '..' &&
    !/[. ]$/.test(value);
}

export async function fetchRecoverySnapshot(input: {
  readonly client: RecoveryExportClient;
  readonly operation_id: string;
  readonly item_id: string;
  readonly snapshot: 'original' | 'proposed';
}): Promise<RecoverySnapshotBytes> {
  const subject = `recovery-export:${input.operation_id}:${input.item_id}:${input.snapshot}`;
  const body = await input.client.authorizeMutation(RECOVERY_EXPORT_OPERATION, subject, {
    operation_id: input.operation_id,
    item_id: input.item_id,
    snapshot: input.snapshot,
    confirmed: true,
  });
  const raw = await input.client.call(RECOVERY_EXPORT_ENDPOINT, body);
  if (!isRecord(raw)) throw new Error('本地服务返回的快照导出响应无法识别。');

  const operationId = raw['operation_id'];
  const itemId = raw['item_id'];
  const snapshot = raw['snapshot'];
  const fileName = raw['file_name'];
  const contentType = raw['content_type'];
  const sha256 = raw['sha256'];
  const size = raw['size'];
  const content = raw['content_base64'];
  if (
    operationId !== input.operation_id || itemId !== input.item_id ||
    (snapshot !== 'original' && snapshot !== 'proposed') || snapshot !== input.snapshot ||
    !validateFileName(fileName) || contentType !== 'application/octet-stream' ||
    typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256) ||
    typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0 ||
    size > LIMITS.MAX_EDITABLE_FILE_BYTES || typeof content !== 'string'
  ) {
    throw new Error('本地服务返回的快照元数据不完整或超出上限。');
  }
  const bytes = decodeBase64(content);
  if (bytes.byteLength !== size) throw new Error('快照长度与服务端声明不符，已取消保存。');
  if (await sha256Of(bytes) !== sha256) throw new Error('快照 SHA-256 校验失败，已取消保存。');
  return Object.freeze({
    operation_id: operationId,
    item_id: itemId,
    snapshot,
    file_name: fileName,
    content_type: contentType,
    sha256,
    size,
    bytes,
  });
}
