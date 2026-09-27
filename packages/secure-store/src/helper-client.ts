/**
 * `SecureStore.ps1` 的常驻客户端（LWB-007）。
 *
 * 与 `native/winfs/src/helper-client.ts` 结构相同但**刻意不共用**：
 * 写护栏与凭证存储是两个安全域，合并成一个助手进程会让其中一个的失陷
 * 直接获得另一个的能力。重复的代价小于合并的风险。
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HELPER_PATH = path.resolve(HERE, '..', 'SecureStore.ps1');

export type HelperErrorCode =
  | 'INVALID_ARGUMENT'
  | 'MECHANISM_FAILED'
  | 'HELPER_UNAVAILABLE'
  | 'HELPER_TIMEOUT';

export interface HelperError {
  readonly ok: false;
  readonly code: HelperErrorCode;
  readonly message: string;
}

export interface HelperSuccess<T> {
  readonly ok: true;
  readonly data: T;
}

export type HelperResult<T> = HelperSuccess<T> | HelperError;

export interface AclRule {
  readonly sid: string;
  readonly name: string;
  readonly type: 'Allow' | 'Deny';
  readonly rights: string;
  readonly inherited: boolean;
  readonly inheritance: string;
}

export interface AclSnapshot {
  readonly path: string;
  /** 属主的**名字**，只用于把话说清楚；判定用的是 `owner_sid`。 */
  readonly owner: string;
  /**
   * 属主的 SID。解析不出时助手会原样回显 —— 那样的一串过不了
   * `assessAcl` 的 SID 形状检查，结果是保守拒绝，而不是当成通过。
   */
  readonly owner_sid: string;
  readonly access_rules_protected: boolean;
  readonly rules: readonly AclRule[];
}

export interface HardenResult {
  readonly targets: readonly string[];
  readonly observed: readonly AclSnapshot[];
  readonly current_user_sid: string;
  readonly system_sid: string;
  readonly administrators_sid: string;
}

/**
 * 凭证保护能力的最小接口。
 *
 * 单独声明而不是直接用 `SecureStoreHelper`：`SecureStoreHelper` 带 `#私有字段`，
 * 因而是名义类型，测试无法用替身替换它。把依赖收敛到能力上，
 * 凭证逻辑的**失败路径**（助手不可用、解密失败、类别混淆）才可能被测到 ——
 * 而那些路径恰恰是这套机制存在的理由。
 */
export interface CredentialProtector {
  isAvailable(): boolean;
  unavailableReason(): string | null;
  protect(plaintext: Buffer, entropy: string): Promise<HelperResult<{ ciphertext_b64: string }>>;
  unprotect(ciphertext: Buffer, entropy: string): Promise<HelperResult<{ plaintext_b64: string }>>;
}

/** ACL 加固与读取能力的最小接口。 */
export interface AclInspector {
  whoami(): Promise<HelperResult<{ user_sid: string; user: string }>>;
  inspect(root: string): Promise<HelperResult<AclSnapshot>>;
  harden(root: string, subdirectories: readonly string[]): Promise<HelperResult<HardenResult>>;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
}

const REQUEST_TIMEOUT_MS = 30_000;

export class SecureStoreHelper {
  #child: ChildProcessWithoutNullStreams | null = null;
  #buffer = '';
  #nextId = 1;
  #pending = new Map<number, Pending>();
  #queue: Promise<unknown> = Promise.resolve();
  #startupError: string | null = null;

  /** 启动助手。失败**不抛**：由调用方通过 `isAvailable()` 决定如何降级（本包一律拒绝启用）。 */
  async start(): Promise<void> {
    if (this.#child || this.#startupError) return;
    const child = spawn(
      'pwsh',
      ['-NoProfile', '-NonInteractive', '-NoLogo', '-File', HELPER_PATH],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
    );
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.#onData(chunk));
    child.stderr.on('data', (chunk: string) => {
      // stderr 只用于诊断，且**不得**回显到模型可见的任何输出。
      void chunk;
    });

    child.on('error', (error) => {
      this.#failAll(`助手进程启动失败：${error.message}`);
    });
    child.on('exit', (code) => {
      this.#child = null;
      this.#failAll(`助手进程已退出（code=${code}）。`);
    });

    this.#child = child;

    // 用一次最小调用确认脚本已经完成 Add-Type（首次编译约 1 秒），
    // 而不是让第一个真实请求去承担这段延迟并被误判为超时。
    const probe = await this.#send<{ user_sid: string }>({ op: 'whoami' });
    if (!probe.ok) {
      this.#startupError = probe.message;
      this.stop();
    }
  }

  isAvailable(): boolean {
    return this.#child !== null && this.#startupError === null;
  }

  unavailableReason(): string | null {
    return this.#startupError;
  }

  #onData(chunk: string): void {
    this.#buffer += chunk;
    let index = this.#buffer.indexOf('\n');
    while (index >= 0) {
      const line = this.#buffer.slice(0, index).trim();
      this.#buffer = this.#buffer.slice(index + 1);
      if (line.length > 0) this.#handleLine(line);
      index = this.#buffer.indexOf('\n');
    }
  }

  #handleLine(line: string): void {
    let payload: { id?: number; ok?: boolean; data?: unknown; error?: { code: string; message: string } };
    try {
      payload = JSON.parse(line) as typeof payload;
    } catch {
      return; // 非 JSON 行（例如 PowerShell 的杂项输出）忽略，不当作响应。
    }
    if (typeof payload.id !== 'number') return;
    const pending = this.#pending.get(payload.id);
    if (!pending) return;
    this.#pending.delete(payload.id);
    clearTimeout(pending.timer);

    if (payload.ok) {
      pending.resolve(payload.data);
    } else {
      pending.reject(
        Object.assign(new Error(payload.error?.message ?? '助手返回失败。'), {
          code: payload.error?.code ?? 'MECHANISM_FAILED',
        }),
      );
    }
  }

  #failAll(reason: string): void {
    for (const [, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.reject(
        Object.assign(new Error(reason), { code: 'HELPER_UNAVAILABLE' as HelperErrorCode }),
      );
    }
    this.#pending.clear();
  }

  /** 串行化：助手是单线程循环，并发写入会互相穿插。 */
  #send<T>(request: Record<string, unknown>): Promise<HelperResult<T>> {
    const run = async (): Promise<HelperResult<T>> => {
      const child = this.#child;
      if (!child || this.#startupError) {
        return {
          ok: false,
          code: 'HELPER_UNAVAILABLE',
          message: this.#startupError ?? '助手未启动。',
        };
      }

      const id = this.#nextId++;
      const result = await new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.#pending.delete(id);
          reject(
            Object.assign(new Error('助手请求超时。'), { code: 'HELPER_TIMEOUT' as HelperErrorCode }),
          );
        }, REQUEST_TIMEOUT_MS);
        timer.unref?.();
        this.#pending.set(id, { resolve, reject, timer });
        try {
          child.stdin.write(`${JSON.stringify({ id, ...request })}\n`);
        } catch (error) {
          this.#pending.delete(id);
          clearTimeout(timer);
          reject(
            Object.assign(new Error(`写入助手失败：${String(error)}`), {
              code: 'HELPER_UNAVAILABLE' as HelperErrorCode,
            }),
          );
        }
      }).then(
        (data) => ({ ok: true as const, data: data as T }),
        (error: unknown) => ({
          ok: false as const,
          code: ((error as { code?: string }).code ?? 'MECHANISM_FAILED') as HelperErrorCode,
          message: error instanceof Error ? error.message : String(error),
        }),
      );

      return result;
    };

    const chained = this.#queue.then(run, run);
    this.#queue = chained.then(
      () => undefined,
      () => undefined,
    );
    return chained;
  }

  // -------------------------------------------------------------------------
  // 对外操作
  // -------------------------------------------------------------------------

  inspect(root: string): Promise<HelperResult<AclSnapshot>> {
    return this.#send<AclSnapshot>({ op: 'inspect', root });
  }

  harden(root: string, subdirectories: readonly string[]): Promise<HelperResult<HardenResult>> {
    return this.#send<HardenResult>({
      op: 'harden',
      root,
      subdirectories: [...subdirectories],
    });
  }

  protect(plaintext: Buffer, entropy: string): Promise<HelperResult<{ ciphertext_b64: string }>> {
    return this.#send<{ ciphertext_b64: string }>({
      op: 'protect',
      plaintext_b64: plaintext.toString('base64'),
      entropy,
    });
  }

  unprotect(ciphertext: Buffer, entropy: string): Promise<HelperResult<{ plaintext_b64: string }>> {
    return this.#send<{ plaintext_b64: string }>({
      op: 'unprotect',
      ciphertext_b64: ciphertext.toString('base64'),
      entropy,
    });
  }

  whoami(): Promise<HelperResult<{ user_sid: string; user: string }>> {
    return this.#send<{ user_sid: string; user: string }>({ op: 'whoami' });
  }

  stop(): void {
    const child = this.#child;
    this.#child = null;
    if (!child) return;
    try {
      child.stdin.write(`${JSON.stringify({ op: '__exit__' })}\n`);
    } catch {
      // 忽略：下面还会 kill。
    }
    try {
      child.kill();
    } catch {
      // 进程可能已经退出。
    }
  }
}
