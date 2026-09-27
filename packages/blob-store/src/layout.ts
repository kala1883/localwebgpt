/**
 * 内容寻址快照的磁盘布局（LWB-007 步骤 3）。
 *
 * ```text
 * <storeRoot>\objects\
 *   ab\
 *     abcdef0123...（完整 64 位十六进制 sha256）
 *   cd\
 *     cdef01...
 *   tmp\
 *     （写入中的临时文件；同卷改名才是原子的）
 * ```
 *
 * 两级分片只为避免单目录下文件过多：第一级取 sha256 前两位。
 * 分片**不是**安全机制，也不参与校验 —— 路径由内容决定，内容由路径校验。
 */

import path from 'node:path';

/** sha256 十六进制长度。此值被反复用于长度断言，集中一处。 */
export const SHA256_HEX_LENGTH = 64;

const SHA256_RE = /^[0-9a-f]{64}$/;

export function isSha256Hex(value: string): boolean {
  return SHA256_RE.test(value);
}

export class BlobLayoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BlobLayoutError';
  }
}

/** 分片名：sha256 前两位。 */
export function shardOf(sha256: string): string {
  if (!isSha256Hex(sha256)) {
    throw new BlobLayoutError(`不是合法的 sha256 十六进制串，拒绝据此定位快照：${sha256.slice(0, 80)}`);
  }
  return sha256.slice(0, 2);
}

/** 绝对路径。`sha256` 会被校验，因此不存在拼接注入。 */
export function objectPath(objectsRoot: string, sha256: string): string {
  return path.join(objectsRoot, shardOf(sha256), sha256);
}

/**
 * 相对受保护根的引用名，写入 `blobs.storage_ref`。
 *
 * 存相对路径而不是绝对路径：受保护根可以被 `LWB_HOME` 改到别处，
 * 绝对路径届时会指向一个不存在的对象，而相对引用不会。
 */
export function storageRefOf(sha256: string): string {
  return `objects/${shardOf(sha256)}/${sha256}`;
}

/**
 * 由 `storage_ref` 还原绝对路径。
 *
 * 只接受本模块生成的形状：任何带 `..`、绝对路径、盘符或反斜杠的引用一律拒绝。
 * 这是**输入校验**（引用来自数据库，数据库可能被替换），不是路径边界。
 */
export function resolveStorageRef(objectsRoot: string, storageRef: string): string {
  const normalized = storageRef.replace(/\\/g, '/');
  const segments = normalized.split('/');
  if (segments.length !== 3 || segments[0] !== 'objects') {
    throw new BlobLayoutError(`快照引用形状不合法：${storageRef}`);
  }
  const [, shard, sha256] = segments as [string, string, string];
  if (!isSha256Hex(sha256)) {
    throw new BlobLayoutError(`快照引用中的哈希不合法：${storageRef}`);
  }
  if (shard !== shardOf(sha256)) {
    throw new BlobLayoutError(`快照引用的分片与哈希不一致：${storageRef}`);
  }
  return path.join(objectsRoot, shard, sha256);
}

/** 临时文件目录，与 objects 同卷，保证改名是原子的。 */
export function tempRootOf(objectsRoot: string): string {
  return path.join(path.dirname(objectsRoot), 'tmp');
}
