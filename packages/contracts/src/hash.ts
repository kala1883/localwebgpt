/**
 * 哈希与规范化摘要工具。
 *
 * 所有 SHA-256 输出统一为**小写十六进制**，避免大小写混用导致摘要比较失效。
 */

import { createHash, timingSafeEqual } from 'node:crypto';

export function sha256Hex(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}

export function sha256Bytes(data: Uint8Array | string): Buffer {
  return createHash('sha256').update(data).digest();
}

/** 恒定时间比较两个十六进制摘要，避免比较过程泄露信息。 */
export function sha256Equal(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch {
    return false;
  }
}

/**
 * 规范化 JSON 序列化，用于构造确定性摘要。
 *
 * 约束（方案 §7.1）：字段顺序与 Unicode 规范化必须固定，否则同一逻辑内容
 * 会得到不同摘要，批准绑定即失效。
 *
 * - 对象键按 UTF-16 码元升序排序；
 * - 数组保持顺序（顺序是有语义的：操作有序列表）；
 * - undefined 的属性被省略，null 保留；
 * - 字符串统一 NFC 规范化；
 * - 数字必须是有限值，`:  -0` 归一为 `0`。
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (value === null) return null;
  switch (typeof value) {
    case 'undefined':
      return undefined;
    case 'number': {
      if (!Number.isFinite(value)) {
        throw new TypeError('canonicalJson: 数字必须是有限值');
      }
      return Object.is(value, -0) ? 0 : value;
    }
    case 'boolean':
      return value;
    case 'string':
      return value.normalize('NFC');
    case 'bigint':
      return value.toString();
    case 'object': {
      if (Array.isArray(value)) {
        return value.map((item) => {
          const c = canonicalize(item);
          return c === undefined ? null : c;
        });
      }
      if (value instanceof Uint8Array) {
        return Buffer.from(value).toString('base64');
      }
      const source = value as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(source).sort()) {
        const c = canonicalize(source[key]);
        if (c !== undefined) {
          out[key] = c;
        }
      }
      return out;
    }
    default:
      throw new TypeError(`canonicalJson: 不支持的类型 ${typeof value}`);
  }
}

/** 对规范化 JSON 取 SHA-256，用于修改集摘要与幂等 request_hash。 */
export function canonicalDigest(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}
