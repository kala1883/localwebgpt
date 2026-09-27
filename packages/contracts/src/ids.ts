/**
 * LWB 标识符。
 *
 * 全部标识符都是不透明字符串，只由本地 daemon 生成，模型不能构造其语义。
 * 前缀存在只是为了审计可读性，不能作为鉴权依据。
 */

declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

/**
 * 品牌字符串的**共同形状**，供跨模块的类型机器识别品牌。
 *
 * 存在的理由很具体：品牌在 JSON 上不存在（`ReadToken` 线上就是一个普通字符串），
 * 因此任何「TS 接口 ↔ JSON schema」的核对都必须先把品牌还原成 `string`。
 * 识别品牌需要一个可以写的类型，而 `brand` 是模块私有的 —— 于是这里把它
 * 导出成一个别名。外部拿不到那个符号，只能问「你是不是品牌字符串」。
 */
export type BrandedString = string & { readonly [brand]: string };


export type WorkspaceId = Brand<string, 'WorkspaceId'>;
export type ConnectionId = Brand<string, 'ConnectionId'>;
export type ChangeId = Brand<string, 'ChangeId'>;
export type OperationId = Brand<string, 'OperationId'>;
export type ApprovalId = Brand<string, 'ApprovalId'>;
export type BlobId = Brand<string, 'BlobId'>;
export type GrantId = Brand<string, 'GrantId'>;
export type JournalId = Brand<string, 'JournalId'>;

export type RequestId = Brand<string, 'RequestId'>;
export type ReadToken = Brand<string, 'ReadToken'>;
export type Cursor = Brand<string, 'Cursor'>;
export type IdempotencyKey = Brand<string, 'IdempotencyKey'>;

const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/**
 * 生成不可猜测的本地标识符。
 * 使用 CSPRNG（randomUUID）而非计数器，避免 model 侧猜测或重放相邻 ID。
 */
export function newLocalId(prefix: string): string {
  const uuid = globalThis.crypto.randomUUID().replace(/-/g, '');
  return `${prefix}_${uuid}`;
}

export function newWorkspaceId(): WorkspaceId {
  return newLocalId('ws') as WorkspaceId;
}

export function newConnectionId(): ConnectionId {
  return newLocalId('conn') as ConnectionId;
}

export function newChangeId(): ChangeId {
  return newLocalId('chg') as ChangeId;
}

export function newOperationId(): OperationId {
  return newLocalId('op') as OperationId;
}

export function newApprovalId(): ApprovalId {
  return newLocalId('apr') as ApprovalId;
}

export function newGrantId(): GrantId {
  return newLocalId('grant') as GrantId;
}

export function newRequestId(): RequestId {
  return newLocalId('req') as RequestId;
}

/**
 * 生成随机不透明游标载荷（base64url）。
 * 游标内容仍由 daemon 签名，调用方不能自行构造。
 */
export function newRandomToken(bytes = 32): string {
  const buf = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(buf);
  let out = '';
  for (const byte of buf) {
    out += ID_ALPHABET.charAt(byte % ID_ALPHABET.length);
  }
  return out;
}
