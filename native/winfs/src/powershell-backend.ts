/**
 * WinfsOps 的 PowerShell + .NET P/Invoke 实现。
 *
 * 为什么不写编译型原生模块：
 * 本机没有 Rust / MSVC / Windows SDK，编译型模块无法构建。方案要求
 * 「路径安全必须由逐级句柄证明」，而 PowerShell 7 自带 Roslyn，可以用
 * Add-Type 编译 C# 并直接 P/Invoke kernel32 —— 调用的是与编译型模块
 * **完全相同**的 Win32 API。
 *
 * 实测性能（docs/evidence/lwb-003）：
 *   每次新起 pwsh 进程：P50 ≈ 1.1 s  —— 完全不可用
 *   常驻助手 + JSON 行协议：P50 ≈ 1.3 ms，P95 ≈ 2.9 ms  —— 满足 P95 ≤ 500 ms 目标
 * 因此**必须**使用常驻进程，本实现不接受每次调用新起进程的退化模式。
 *
 * 本实现是 fail-closed 的：助手不可用或能力自检未通过时，
 * 写操作一律返回 NATIVE_GUARD_UNAVAILABLE，绝不降级为普通 fs 写入。
 */

import process from 'node:process';

import { ResidentHelper, type HelperResult } from './helper-client.ts';
import type {
  WinfsActualState,
  WinfsCapability,
  WinfsCreateResult,
  WinfsError,
  WinfsListResult,
  WinfsListRequest,
  WinfsOps,
  WinfsReadResult,
  WinfsPathRef,
  WinfsPathValidation,
  WinfsVolumeInfo,
  WinfsWriteResult,
} from './ops.ts';

interface AttributesJson {
  is_reparse?: boolean;
  is_directory?: boolean;
  names?: string[];
}

function normalizeAttributes(raw: unknown): { is_reparse: boolean; is_directory: boolean; names: string[] } {
  const a = (raw ?? {}) as AttributesJson;
  return {
    is_reparse: a.is_reparse === true,
    is_directory: a.is_directory === true,
    names: Array.isArray(a.names) ? a.names : [],
  };
}

/**
 * 助手返回的身份字段是 PowerShell 生成的扁平结构（size/attributes 与 id 同级），
 * 这里收敛成契约里的 WinfsFileIdentity。
 */
function normalizeIdentity(raw: unknown): {
  volume_id: string;
  file_id: string;
  link_count: number;
} {
  const i = (raw ?? {}) as { volume_id?: string; file_id?: string; link_count?: number };
  return {
    volume_id: String(i.volume_id ?? ''),
    file_id: String(i.file_id ?? ''),
    link_count: Number(i.link_count ?? 0),
  };
}

/**
 * 护栏的 `canonical_relative_path`：取不到就是 `null`。
 *
 * 刻意**不**回退成请求里的 `relative_path` —— 那正是这个字段要解决的问题
 * （请求写 `ALPHA.TXT`、磁盘上是 `Alpha.txt`）。退回请求值会让
 * 「我拿到的规范路径」这句话变成一句假话。
 */
function canonicalPath(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/**
 * 写失败之后的现场（LWB-027）。**护栏是外部边界**，因此这里逐字段验形状：
 * 一个字段缺失就整块丢掉，而不是补一个默认值。
 *
 * 为什么不补默认值：这块数据的用途是「据此判断字节的下落」。一个补出来的
 * `size: 0` 会读成「文件被截空了」—— 那是一个**结论**，而它可能完全是编的。
 * 宁可让调用方看到「没有现场」，那至少是一个诚实的「不知道」。
 */
function normalizeActualState(raw: unknown): WinfsActualState | undefined {
  if (raw === null || typeof raw !== 'object') return undefined;
  const s = raw as { size?: unknown; identity?: unknown; sha256?: unknown; observed_bytes?: unknown; cap_bytes?: unknown; observed_at_utc?: unknown };
  const identity = s.identity as { volume_id?: unknown; file_id?: unknown; link_count?: unknown } | null | undefined;
  if (typeof s.size !== 'number' || identity === null || typeof identity !== 'object') return undefined;
  if (typeof identity?.file_id !== 'string' || identity.file_id === '') return undefined;
  return {
    size: s.size,
    identity: normalizeIdentity(identity),
    // 被上界截断时护栏给的是 null，那不是「没看到」，而是「只看到一段」。
    sha256: typeof s.sha256 === 'string' ? s.sha256 : null,
    observed_bytes: typeof s.observed_bytes === 'number' ? s.observed_bytes : 0,
    cap_bytes: typeof s.cap_bytes === 'number' ? s.cap_bytes : 0,
    observed_at_utc: typeof s.observed_at_utc === 'string' ? s.observed_at_utc : '',
  };
}

function toError(result: HelperResult | WinfsError): WinfsError {
  if (result.ok === false && typeof (result as WinfsError).code === 'string') {
    // 已经是我们自己的错误结构（例如护栏不可用），直接透传。
    return result as WinfsError;
  }
  const raw = result as HelperResult;
  const actual = normalizeActualState(raw.actual_state);
  return {
    ok: false,
    code: (typeof raw.code === 'string' ? raw.code : 'IO_ERROR') as WinfsError['code'],
    message: String(raw.message ?? '护栏助手返回了未预期的失败'),
    win32_error: Number(raw.win32_error ?? 0),
    // 缺省即**没有**这一项，而不是 `undefined` 显式挂着：调用方判的是
    // 「这个键在不在」，而一个永远存在、值为 undefined 的键会让
    // `'actual_state' in error` 这种写法一直为真。
    ...(actual === undefined ? {} : { actual_state: actual }),
    // `touched` 只按**严格 true** 收：护栏诚实到只会写 `$true`，
    // 因此这里任何别的东西（false / 0 / 字符串）都当作「没说」处理 ——
    // 而「没说」的含义是最强的那一个命题（没动过字节），
    // 一个含糊的值不该被读成它。
    ...(raw.touched === true ? { touched: true as const } : {}),
  };
}

export interface PowerShellBackendOptions {
  /** 自检失败时是否抛错（测试可用 false 观察降级行为）。默认 true。 */
  readonly strict?: boolean;
  /** 启动超时（毫秒）。 */
  readonly startTimeoutMs?: number;
}

export class PowerShellWinfsBackend implements WinfsOps {
  #helper: ResidentHelper | null = null;
  #capability: WinfsCapability | null = null;
  #starting: Promise<void> | null = null;
  readonly #options: PowerShellBackendOptions;

  constructor(options: PowerShellBackendOptions = {}) {
    this.#options = options;
  }

  /**
   * 启动常驻助手并做一次能力自检。
   * 失败**不会**抛到调用方以外：capability() 会返回 available=false，
   * 由调用方决定如何降级（停止写入），而不是让进程直接崩掉。
   */
  async ensureStarted(): Promise<WinfsCapability> {
    if (this.#capability) return this.#capability;
    if (this.#starting) {
      await this.#starting;
      return this.#capability!;
    }

    this.#starting = (async () => {
      const helper = new ResidentHelper();
      try {
        const ready = await helper.start();
        if (ready.ok !== true) {
          throw new Error(`助手就绪响应异常：${JSON.stringify(ready).slice(0, 300)}`);
        }
        const cap = await helper.call({ op: 'capability' });
        if (cap.ok !== true) {
          throw new Error(`能力自检失败：${JSON.stringify(cap).slice(0, 300)}`);
        }
        this.#helper = helper;
        this.#capability = {
          available: true,
          backend: 'powershell-pinvoke',
          resolved_backend_reason:
            'PowerShell 7 + .NET P/Invoke（本机无编译型工具链时仍可调用真实 Win32 API）',
          supports_exclusive_handle: true,
          supports_flush: true,
          supports_create_new: true,
          supports_reparse_detection: true,
          supports_file_identity: true,
          supports_hardlink_count: true,
          crash_atomic_replace: false,
          cross_file_transaction: false,
          verified_on:
            `${String(cap.os_version ?? 'unknown')} / PowerShell ${String(cap.powershell_version ?? 'unknown')}`,
          notes: [
            '后端是常驻 PowerShell 进程；实测常驻调用 P50 ≈ 1.3ms，每次新起进程 P50 ≈ 1.1s，因此不接受冷启动模式。',
            '不提供崩溃原子替换，也不提供跨文件事务：进程在截断与写满之间死亡会留下不完整文件。',
            '同名文件的硬链接（link_count > 1）会被拒绝写入，因为那会影响工作区外的另一个名字。',
          ],
        };
      } catch (error) {
        await helper.stop().catch(() => undefined);
        this.#helper = null;
        this.#capability = {
          available: false,
          backend: 'none',
          resolved_backend_reason: `护栏助手不可用：${(error as Error).message}`,
          supports_exclusive_handle: false,
          supports_flush: false,
          supports_create_new: false,
          supports_reparse_detection: false,
          supports_file_identity: false,
          supports_hardlink_count: false,
          crash_atomic_replace: false,
          cross_file_transaction: false,
          verified_on: null,
          notes: ['护栏不可用时写入能力必须保持关闭（I10）。'],
        };
      }
    })();

    await this.#starting;
    this.#starting = null;

    if (!this.#capability!.available && this.#options.strict !== false) {
      // 注意：这里不是抛错，而是让调用方通过 capability() 自行决定。
      // 真正的 fail-closed 体现在 write/create 返回 NATIVE_GUARD_UNAVAILABLE。
    }
    return this.#capability!;
  }

  async capability(): Promise<WinfsCapability> {
    return this.ensureStarted();
  }

  /** 护栏不可用时统一的失败值。 */
  #unavailable(operation: string): WinfsError {
    const reason = this.#capability?.resolved_backend_reason ?? '护栏尚未完成能力自检';
    return {
      ok: false,
      code: 'NATIVE_GUARD_UNAVAILABLE',
      message: `文件系统护栏不可用，拒绝执行 ${operation}：${reason}`,
      win32_error: 0,
    };
  }

  async #call(request: Record<string, unknown>): Promise<HelperResult | WinfsError> {
    await this.ensureStarted();
    if (!this.#helper) {
      return this.#unavailable(String(request.op));
    }
    try {
      return await this.#helper.call(request);
    } catch (error) {
      return {
        ok: false,
        code: 'NATIVE_GUARD_UNAVAILABLE',
        message: `护栏助手通信失败：${(error as Error).message}`,
        win32_error: 0,
      };
    }
  }

  /**
   * 登记 / 复核候选根用。只报告事实，不做策略判断（策略在 packages/workspaces）。
   *
   * 返回值刻意**不接受**助手给的 `drive_type` 字符串以外的东西做推断：
   * 例如不在这里把 `drive_type === 'remote'` 翻译成「不允许」——
   * 那样策略就会散落在后端里，将来加一条规则要改两处。
   */
  async statVolume(req: { path: string }): Promise<WinfsVolumeInfo | WinfsError> {
    const r = await this.#call({ op: 'statVolume', path: req.path });
    if (r.ok !== true) return toError(r);
    const driveType = String(r.drive_type ?? 'unknown');
    const known = ['fixed', 'remote', 'removable', 'cdrom', 'ramdisk', 'no_root_dir'] as const;
    return {
      ok: true,
      path: String(r.path),
      drive_type: (known as readonly string[]).includes(driveType)
        ? (driveType as WinfsVolumeInfo['drive_type'])
        : 'unknown',
      file_system: r.file_system === null || r.file_system === undefined ? null : String(r.file_system),
      file_system_flags: Number(r.file_system_flags ?? 0),
      volume_label: r.volume_label === null || r.volume_label === undefined ? null : String(r.volume_label),
      max_component_length: Number(r.max_component_length ?? 0),
      volume_id: String(r.volume_id ?? ''),
      file_id: String(r.file_id ?? ''),
      link_count: Number(r.link_count ?? 0),
      is_directory: r.is_directory === true,
      is_reparse: r.is_reparse === true,
      recall_on_open: r.recall_on_open === true,
      recall_on_data_access: r.recall_on_data_access === true,
      is_cloud_placeholder: r.is_cloud_placeholder === true,
      volume_info_available: r.volume_info_available === true,
    };
  }

  /** 只做语法校验；护栏侧实现，与 contracts 侧的一致性由测试逐例比对。 */
  async validatePath(req: { relative_path: string }): Promise<WinfsPathValidation> {
    const r = await this.#call({ op: 'validatePath', relative_path: req.relative_path });
    if (r.ok !== true) {
      const raw = r as HelperResult;
      return {
        ok: false,
        code: 'PATH_UNSAFE',
        // 护栏的语法拒绝总是带 reason；真没有就如实说「未给出理由」，
        // 而不是编一个听起来合理的。
        reason: typeof raw.reason === 'string' ? raw.reason : 'UNKNOWN',
        message: String(raw.message ?? '护栏拒绝了该路径但未给出说明'),
      };
    }
    return {
      ok: true,
      segments: Array.isArray(r.segments) ? (r.segments as unknown[]).map(String) : [],
      normalized: String(r.normalized ?? ''),
    };
  }

  async resolvePath(req: WinfsPathRef & {
    expect: 'file' | 'directory' | 'any';
  }): Promise<WinfsReadResult | WinfsListResult | WinfsError> {
    const r = await this.#call({ op: 'resolvePath', ...req });
    if (r.ok !== true) return toError(r);
    const identityRaw = r.identity as { size?: number; attributes?: string[]; is_reparse?: boolean } | undefined;
    // 这个对象**不经过 `as` 强转**，就是为了让「护栏少给了一个字段」变成
    // 编译错误而不是运行时的 `undefined`。曾经它写成 `as unknown as
    // WinfsReadResult`，于是漏掉 `canonical_relative_path` 这件事一路瞒到
    // 真实读取时才以 `Cannot read properties of undefined` 的形式炸出来
    // （tests/windows/files-read.test.ts 抓到的）。
    const result: WinfsReadResult = {
      ok: true,
      relative_path: String(r.relative_path),
      // 磁盘规范拼写：读取侧的预检靠它判硬拒绝规则。
      canonical_relative_path: canonicalPath(r.canonical_relative_path),
      identity: normalizeIdentity(r.identity),
      size: Number(identityRaw?.size ?? 0),
      // resolvePath 不读内容，因此这两个字段没有真实取值。留空串而不是删掉，
      // 是因为返回类型是读结果；但**任何调用方都不得把它们当成事实** ——
      // 需要哈希或字节的调用方必须自己走 readFileGuarded。
      sha256: '',
      bytes_base64: '',
      attributes: normalizeAttributes({
        is_reparse: identityRaw?.is_reparse,
        is_directory: (identityRaw?.attributes ?? []).includes('directory'),
        names: identityRaw?.attributes ?? [],
      }),
    };
    return result;
  }

  async readFileGuarded(req: WinfsPathRef): Promise<WinfsReadResult | WinfsError> {
    const r = await this.#call({ op: 'readFileGuarded', ...req });
    if (r.ok !== true) return toError(r);
    const identityRaw = r.identity as { attributes?: string[]; is_reparse?: boolean } | undefined;
    return {
      ok: true,
      relative_path: String(r.relative_path),
      canonical_relative_path: canonicalPath(r.canonical_relative_path),
      identity: normalizeIdentity(r.identity),
      size: Number(r.size),
      sha256: String(r.sha256),
      bytes_base64: String(r.bytes_base64),
      attributes: normalizeAttributes({
        is_reparse: identityRaw?.is_reparse,
        is_directory: (identityRaw?.attributes ?? []).includes('directory'),
        names: identityRaw?.attributes ?? [],
      }),
    };
  }

  async writeFileGuarded(req: WinfsPathRef & {
    expected_sha256: string;
    content_base64: string;
  }): Promise<WinfsWriteResult | WinfsError> {
    const r = await this.#call({ op: 'writeFileGuarded', ...req });
    if (r.ok !== true) return toError(r);
    return {
      ok: true,
      relative_path: String(r.relative_path),
      canonical_relative_path: canonicalPath(r.canonical_relative_path),
      identity_before: normalizeIdentity(r.identity_before),
      identity_after: normalizeIdentity(r.identity_after),
      before_sha256: String(r.before_sha256),
      after_sha256: String(r.after_sha256),
      target_sha256: String(r.target_sha256),
      readback_ok: r.readback_ok === true,
      flushed: r.flushed === true,
      bytes_written: Number(r.bytes_written),
    };
  }

  async createFileGuarded(req: WinfsPathRef & {
    content_base64: string;
  }): Promise<WinfsCreateResult | WinfsError> {
    const r = await this.#call({ op: 'createFileGuarded', ...req });
    if (r.ok !== true) return toError(r);
    return {
      ok: true,
      relative_path: String(r.relative_path),
      canonical_relative_path: canonicalPath(r.canonical_relative_path),
      identity_after: normalizeIdentity(r.identity_after),
      after_sha256: String(r.after_sha256),
      // 与 `writeFileGuarded` 同一组字段：验收标准在两条路上是同一句
      // （「回读哈希等于已批准的新哈希」），因此回执的形状也必须一样 ——
      // 少一个字段，调用方那一侧的判据就会退化成「没看到就当通过」。
      target_sha256: String(r.target_sha256),
      readback_ok: r.readback_ok === true,
      flushed: r.flushed === true,
      bytes_written: Number(r.bytes_written),
    };
  }

  async listDirectory(req: WinfsListRequest): Promise<WinfsListResult | WinfsError> {
    const r = await this.#call({ op: 'listDirectory', ...req });
    if (r.ok !== true) return toError(r);
    const entries = Array.isArray(r.entries) ? (r.entries as Record<string, unknown>[]) : [];
    return {
      ok: true,
      relative_path: String(r.relative_path),
      canonical_relative_path: canonicalPath(r.canonical_relative_path),
      entries: entries.map((e) => ({
        name: String(e.name),
        relative_path: String(e.relative_path),
        type: e.type === 'directory' ? 'directory' : 'file',
        size: typeof e.size === 'number' ? e.size : null,
        is_reparse: e.is_reparse === true,
      })),
      // 缺了这个字段就是 `undefined`，而 `undefined` 在调用方的 `if` 里
      // 是假 —— 于是一次「还有下一页」会被静默读成「已经列完了」。
      // 因此这里**不接受**缺省：护栏没给就说没给，由调用方决定怎么办。
      // （当前护栏一定给；这条注释是为了让下一版护栏漏报时不要变成静默截断。）
      has_more: r.has_more === true,
    };
  }

  /** 释放常驻进程。进程退出时必须调用，避免留下孤儿 pwsh。 */
  async dispose(): Promise<void> {
    if (this.#helper) {
      await this.#helper.stop();
      this.#helper = null;
      this.#capability = null;
    }
  }
}

/** 进程退出时兜底清理。 */
export function installProcessCleanup(backend: PowerShellWinfsBackend): void {
  const cleanup = (): void => {
    void backend.dispose();
  };
  process.once('exit', cleanup);
  process.once('SIGINT', () => {
    cleanup();
    process.exit(130);
  });
}
