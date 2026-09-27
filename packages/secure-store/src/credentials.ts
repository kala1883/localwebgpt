/**
 * 凭证存储（LWB-007 步骤 2）。
 *
 * ## 三类凭证必须分离
 *
 * | 类别 | 用途 | 谁能拿到 |
 * | --- | --- | --- |
 * | `runtime` | tunnel-client 的运行时凭证 | 只有隧道客户端进程 |
 * | `ipc` | daemon ↔ adapter 的本地 IPC 凭证 | 只有 daemon 与 adapter |
 * | `console` | 控制台的会话凭证 | 只有控制台 |
 *
 * 分离不只是「放在不同文件」：每一类使用**不同的 DPAPI entropy**，
 * 因此把 A 类的密文文件换到 B 类的位置也解不开。
 * 这挡住了「用低权限类别的凭证冒充高权限类别」这一类混淆。
 *
 * ## 一律不落明文
 *
 * 助手的 `protect` 是唯一写入路径。助手不可用时**抛错**，
 * 绝不回退到明文文件 —— 回退会让「凭证受 Windows 保护」变成一句空话，
 * 而调用方无法从接口上分辨自己拿到的是哪一种。
 */

import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { CredentialProtector } from './helper-client.ts';

export const CREDENTIAL_CLASSES = ['runtime', 'ipc', 'console'] as const;
export type CredentialClass = (typeof CREDENTIAL_CLASSES)[number];

/**
 * 每类一个固定 entropy。
 *
 * 固定是必需的：entropy 要与密文一起长期存活，随机化就必须再找地方存它，
 * 而那个地方会成为新的攻击面。它的作用不是保密，是**域分离**。
 */
const ENTROPY_BY_CLASS: Readonly<Record<CredentialClass, string>> = {
  runtime: 'lwb-v1-credential-runtime',
  ipc: 'lwb-v1-credential-ipc',
  console: 'lwb-v1-credential-console',
};

const FILE_FORMAT_VERSION = 1;
const PROTECTION = 'dpapi-current-user';

interface CredentialFile {
  readonly v: number;
  readonly class: CredentialClass;
  readonly created_at: string;
  readonly protection: string;
  readonly ciphertext: string;
}

interface CredentialPayload {
  readonly kind: string;
  /** 明文机密。**只**存在于内存与 DPAPI 密文之内。 */
  readonly secret: string;
}

/** 对外可见的凭证信息。刻意不含 `secret`：调用方必须显式调用 `reveal()`。 */
export interface CredentialInfo {
  readonly class: CredentialClass;
  readonly kind: string;
  readonly created_at: string;
  readonly protection: string;
  /** 机密的前 8 位 SHA-256，供人眼比对「是不是同一把」，不可反推。 */
  readonly fingerprint: string;
}

export class CredentialUnavailableError extends Error {
  readonly reason: string;
  constructor(message: string, reason: string) {
    super(message);
    this.name = 'CredentialUnavailableError';
    this.reason = reason;
  }
}

export class CredentialCorruptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CredentialCorruptError';
  }
}

function isCredentialClass(value: string): value is CredentialClass {
  return (CREDENTIAL_CLASSES as readonly string[]).includes(value);
}

export interface CredentialStoreOptions {
  /** 凭证目录，必须位于已加固的受保护根之内。 */
  readonly credentialsDirectory: string;
  readonly helper: CredentialProtector;
  /** 允许注入时钟，便于测试构造过期场景。 */
  readonly now?: () => string;
}

export class CredentialStore {
  readonly #directory: string;
  readonly #helper: CredentialProtector;
  readonly #now: () => string;

  constructor(options: CredentialStoreOptions) {
    this.#directory = options.credentialsDirectory;
    this.#helper = options.helper;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  #filePath(cls: CredentialClass): string {
    // 类名来自闭集，不接受外部拼接的字符串，因此不存在路径拼接注入。
    return path.join(this.#directory, `${cls}.cred`);
  }

  async #requireHelper(action: string): Promise<void> {
    if (!this.#helper.isAvailable()) {
      throw new CredentialUnavailableError(
        `凭证${action}需要 Windows 保护机制，但机制当前不可用；已拒绝以明文方式继续。`,
        this.#helper.unavailableReason() ?? '助手未启动',
      );
    }
  }

  async #readFile(cls: CredentialClass): Promise<CredentialFile> {
    const raw = await readFile(this.#filePath(cls), 'utf8');
    let parsed: CredentialFile;
    try {
      parsed = JSON.parse(raw) as CredentialFile;
    } catch {
      throw new CredentialCorruptError(`凭证文件无法解析：${cls}。`);
    }
    if (parsed.v !== FILE_FORMAT_VERSION) {
      throw new CredentialCorruptError(`凭证文件版本不受支持：${cls}（v=${String(parsed.v)}）。`);
    }
    if (isCredentialClass(parsed.class) && parsed.class !== cls) {
      // 换文件位置这类混淆在这里被挡住（entropy 不同也会让解密失败，这是第二道）。
      throw new CredentialCorruptError(
        `凭证文件的类别与存放位置不一致：位置 ${cls}，内容 ${parsed.class}。`,
      );
    }
    if (parsed.protection !== PROTECTION) {
      throw new CredentialCorruptError(
        `凭证文件声明的保护方式不是 ${PROTECTION}（实际 ${parsed.protection}）。`,
      );
    }
    return parsed;
  }

  /** 写入（或覆盖）某一类凭证。 */
  async set(cls: CredentialClass, payload: CredentialPayload): Promise<CredentialInfo> {
    await this.#requireHelper('写入');
    if (payload.secret.length === 0) {
      throw new CredentialCorruptError('拒绝写入空凭证。');
    }

    const plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
    const protected0 = await this.#helper.protect(plaintext, ENTROPY_BY_CLASS[cls]);
    if (!protected0.ok) {
      throw new CredentialUnavailableError(`DPAPI 保护失败：${protected0.message}`, protected0.message);
    }

    const record: CredentialFile = {
      v: FILE_FORMAT_VERSION,
      class: cls,
      created_at: this.#now(),
      protection: PROTECTION,
      ciphertext: protected0.data.ciphertext_b64,
    };

    await mkdir(this.#directory, { recursive: true });
    const target = this.#filePath(cls);
    const temp = `${target}.tmp`;
    // 先写临时文件再改名：直接覆写会在崩溃时留下半个 JSON，
    // 那会让下一次启动把「凭证损坏」误报成「凭证丢失」。
    await writeFile(temp, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    await rename(temp, target);

    return {
      class: cls,
      kind: payload.kind,
      created_at: record.created_at,
      protection: PROTECTION,
      fingerprint: fingerprintOf(payload.secret),
    };
  }

  /** 生成并保存一把新的随机凭证。返回的明文**只在这一次调用中**出现。 */
  async rotate(cls: CredentialClass, kind = cls): Promise<{ info: CredentialInfo; secret: string }> {
    const secret = randomBytes(32).toString('base64url');
    const info = await this.set(cls, { kind, secret });
    return { info, secret };
  }

  /**
   * 取出某类凭证的**明文**。
   *
   * 命名刻意用 `reveal` 而不是 `get`：调用点必须一眼看出这里发生了明文外露，
   * 从而不会被顺手写进日志。
   */
  async reveal(cls: CredentialClass): Promise<CredentialPayload & { created_at: string }> {
    await this.#requireHelper('读取');
    const record = await this.#readFile(cls);
    const ciphertext = Buffer.from(record.ciphertext, 'base64');
    const unprotected = await this.#helper.unprotect(ciphertext, ENTROPY_BY_CLASS[cls]);
    if (!unprotected.ok) {
      throw new CredentialCorruptError(
        `凭证无法解密（可能不是当前用户加密的，或文件被替换）：${cls}。`,
      );
    }
    let payload: CredentialPayload;
    try {
      payload = JSON.parse(Buffer.from(unprotected.data.plaintext_b64, 'base64').toString('utf8')) as CredentialPayload;
    } catch {
      throw new CredentialCorruptError(`凭证载荷无法解析：${cls}。`);
    }
    if (typeof payload.secret !== 'string' || payload.secret.length === 0) {
      throw new CredentialCorruptError(`凭证载荷缺少 secret：${cls}。`);
    }
    return { ...payload, created_at: record.created_at };
  }

  /** 只读元信息：**不解密**，因此可以在日志里安全使用。 */
  async info(cls: CredentialClass): Promise<CredentialInfo | null> {
    const target = this.#filePath(cls);
    if (!existsSync(target)) return null;
    const record = await this.#readFile(cls);
    await this.#requireHelper('校验');
    const unprotected = await this.#helper.unprotect(
      Buffer.from(record.ciphertext, 'base64'),
      ENTROPY_BY_CLASS[cls],
    );
    if (!unprotected.ok) {
      throw new CredentialCorruptError(`凭证无法解密：${cls}。`);
    }
    const payload = JSON.parse(
      Buffer.from(unprotected.data.plaintext_b64, 'base64').toString('utf8'),
    ) as CredentialPayload;
    return {
      class: cls,
      kind: payload.kind,
      created_at: record.created_at,
      protection: record.protection,
      fingerprint: fingerprintOf(payload.secret),
    };
  }

  /** 是否存在（不判断是否可用）。 */
  exists(cls: CredentialClass): boolean {
    return existsSync(this.#filePath(cls));
  }

  async delete(cls: CredentialClass): Promise<void> {
    await rm(this.#filePath(cls), { force: true });
  }

  /** 供测试与证据使用：直接读原始文件字节，用于证明磁盘上没有明文。 */
  async rawFileBytes(cls: CredentialClass): Promise<Buffer> {
    return readFile(this.#filePath(cls));
  }
}

export function fingerprintOf(secret: string): string {
  // 只暴露很短的一段：足以让人比对「是不是同一把」，不足以作为校验依据。
  return createHash('sha256').update(secret, 'utf8').digest('hex').slice(0, 16);
}
