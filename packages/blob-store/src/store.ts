/**
 * 内容寻址快照存储（LWB-007 步骤 3，方案 §7「blob 持久化后才能引用进入可执行计划」）。
 *
 * ## 顺序是安全属性，不是实现细节
 *
 * 唯一允许的写入序列是：**先落盘并 fsync，后写数据库引用**。
 * 反过来会造出「数据库里有一条指向不存在字节的快照」——
 * 而回滚恰恰要在最坏的时刻读取它。因此 `putAndRegister` 是推荐的入口，
 * 它把顺序固定在函数体内，调用方无从颠倒。
 *
 * ## 完整性校验是不可省的
 *
 * 数据库里的哈希是**声明**，磁盘上的字节是**事实**。两者不符意味着
 * 快照被替换、被截断或写了一半 —— 此时唯一安全的反应是拒绝，
 * 因为用错误的旧字节回滚会静默损坏用户文件。
 *
 * ## 本模块不做安全判定
 *
 * `objectsRoot` 是否位于受保护根之内、ACL 是否合格，由 `@lwb/secure-store` 判定。
 * 这里只负责「字节写对了没有」。
 */

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, open, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

import {
  BlobLayoutError,
  isSha256Hex,
  objectPath,
  resolveStorageRef,
  storageRefOf,
  tempRootOf,
} from './layout.ts';

export function sha256Of(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export class BlobMissingError extends Error {
  readonly storage_ref: string;
  constructor(message: string, storageRef: string) {
    super(message);
    this.name = 'BlobMissingError';
    this.storage_ref = storageRef;
  }
}

export class BlobIntegrityError extends Error {
  readonly storage_ref: string;
  readonly expected_sha256: string;
  readonly actual_sha256: string | null;
  constructor(
    message: string,
    details: { storage_ref: string; expected_sha256: string; actual_sha256: string | null },
  ) {
    super(message);
    this.name = 'BlobIntegrityError';
    this.storage_ref = details.storage_ref;
    this.expected_sha256 = details.expected_sha256;
    this.actual_sha256 = details.actual_sha256;
  }
}

export class BlobGcRefusedError extends Error {
  readonly reason: string;
  constructor(message: string, reason: string) {
    super(message);
    this.name = 'BlobGcRefusedError';
    this.reason = reason;
  }
}

/** 写入结果。`deduplicated` 表示内容已存在、本次没有产生新字节。 */
export interface PutResult {
  readonly sha256: string;
  readonly size: number;
  readonly storage_ref: string;
  readonly deduplicated: boolean;
  /** 文件内容是否已 fsync（Windows 上目录 fsync 不可用，见 `directory_synced`）。 */
  readonly file_synced: boolean;
  readonly directory_synced: boolean;
}

export interface BlobRef {
  readonly sha256: string;
  readonly size: number;
  readonly storage_ref: string;
}

export interface VerifyResult {
  readonly ok: true;
  readonly sha256: string;
  readonly size: number;
}

/**
 * `@lwb/persistence` 的 `BlobsRepo` 的结构子集。
 *
 * 结构性声明而不是 import：blob-store 应当对 SQL 一无所知，
 * 而传入真实仓储时 TypeScript 会照常做结构兼容检查。
 */
export interface BlobRegistry {
  ensure(input: {
    readonly id: string;
    readonly sha256: string;
    readonly size: number;
    readonly storage_ref: string;
  }): { readonly kind: 'created' | 'existing'; readonly blob: RegistryBlob };
  findByContent(sha256: string, size: number): RegistryBlob | null;
  listPendingGc(): readonly RegistryBlob[];
  markDeleted(id: string): void;
  markVerified(id: string): void;
}

export interface RegistryBlob {
  readonly id: string;
  readonly sha256: string;
  readonly size: number;
  readonly storage_ref: string;
  readonly refcount: number;
  readonly retention_state: string;
}

export interface BlobStoreOptions {
  /** `objects` 目录的绝对路径，必须位于受保护根之内。 */
  readonly objectsRoot: string;
  /** 临时目录，默认与 `objects` 同卷（改名才是原子的）。 */
  readonly tempRoot?: string;
  /** 提供后才可执行回收：没有仓储就无法知道引用计数。 */
  readonly registry?: BlobRegistry;
  /** 注入 id 生成器，便于测试固定值。 */
  readonly newId?: () => string;
}

export interface GcReport {
  readonly collected: readonly { readonly id: string; readonly sha256: string }[];
  readonly skipped: readonly { readonly id: string; readonly sha256: string; readonly reason: string }[];
  readonly refused: boolean;
  readonly refusal_reason: string | null;
}

export class BlobStore {
  readonly #objectsRoot: string;
  readonly #tempRoot: string;
  readonly #registry: BlobRegistry | undefined;
  readonly #newId: () => string;

  constructor(options: BlobStoreOptions) {
    this.#objectsRoot = path.resolve(options.objectsRoot);
    this.#tempRoot = options.tempRoot ?? tempRootOf(this.#objectsRoot);
    this.#registry = options.registry;
    this.#newId = options.newId ?? (() => `blb_${randomBytes(12).toString('hex')}`);
  }

  get objectsRoot(): string {
    return this.#objectsRoot;
  }

  async #ensureDirectories(sha256: string): Promise<void> {
    await mkdir(path.join(this.#objectsRoot, sha256.slice(0, 2)), { recursive: true });
    await mkdir(this.#tempRoot, { recursive: true });
  }

  /**
   * 写入字节并返回其内容引用。**不**触碰数据库。
   *
   * @param expectedSha256 调用方已知的哈希（例如 `base_hash`）。
   *   提供时会在写盘**之前**校验：不符说明调用方拿错了字节，
   *   此时写进去只会把错误的字节永久固化。
   */
  async put(bytes: Buffer, options: { readonly expectedSha256?: string } = {}): Promise<PutResult> {
    const digest = sha256Of(bytes);

    if (options.expectedSha256 !== undefined) {
      const expected = options.expectedSha256.toLowerCase();
      if (!isSha256Hex(expected)) {
        throw new BlobLayoutError(`调用方给出的期望哈希不合法：${options.expectedSha256}`);
      }
      if (expected !== digest) {
        throw new BlobIntegrityError('待写入字节与调用方声明的哈希不符，拒绝落盘。', {
          storage_ref: storageRefOf(digest),
          expected_sha256: expected,
          actual_sha256: digest,
        });
      }
    }

    const storageRef = storageRefOf(digest);
    const target = objectPath(this.#objectsRoot, digest);
    await this.#ensureDirectories(digest);

    if (existsSync(target)) {
      // 相同内容已在盘上：先验证它**确实是**这个内容再复用。
      // 直接复用会把一次既有的损坏传播成「所有引用都指向坏字节」。
      await verifyBytesAt(target, { sha256: digest, size: bytes.length, storage_ref: storageRef });
      return {
        sha256: digest,
        size: bytes.length,
        storage_ref: storageRef,
        deduplicated: true,
        file_synced: true,
        directory_synced: true,
      };
    }

    const tempName = path.join(this.#tempRoot, `${digest}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
    let fileSynced = false;
    // 'wx'：临时名冲突时报错而不是覆盖另一个进程正在写的文件。
    const handle = await open(tempName, 'wx');
    try {
      await handle.writeFile(bytes);
      await handle.sync();
      fileSynced = true;
    } finally {
      await handle.close();
    }

    try {
      await rename(tempName, target);
    } catch (error) {
      // 改名失败不能留下垃圾：临时文件会一直占着空间且不在任何引用里。
      await rm(tempName, { force: true });
      throw error;
    }

    const directorySynced = await this.#syncDirectory(path.dirname(target));

    return {
      sha256: digest,
      size: bytes.length,
      storage_ref: storageRef,
      deduplicated: false,
      file_synced: fileSynced,
      directory_synced: directorySynced,
    };
  }

  /**
   * 尽力同步目录项。
   *
   * Windows 上 `FlushFileBuffers` 对目录句柄不可用，Node 也拒绝以读取方式
   * 打开目录（EISDIR/EPERM）。因此这里**如实返回 false**，而不是假装成功：
   * 「改名已持久」这句话在 Windows 上依赖 NTFS 的元数据日志，本模块不为此背书。
   */
  async #syncDirectory(directory: string): Promise<boolean> {
    try {
      const handle = await open(directory, 'r');
      try {
        await handle.sync();
        return true;
      } finally {
        await handle.close();
      }
    } catch {
      return false;
    }
  }

  /** 读取字节，**不**校验。除排障外不应直接使用；执行路径一律走 `getVerified`。 */
  async readRaw(sha256: string): Promise<Buffer> {
    return readFile(objectPath(this.#objectsRoot, sha256));
  }

  /**
   * 按引用读取并校验。快照缺失或哈希不符时**抛出**（LWB-007 验收标准 2）。
   *
   * 长度先于哈希比较：长度不符时不必读完整个文件即可判定失败。
   */
  async getVerified(ref: BlobRef): Promise<Buffer> {
    return verifyBytesAt(resolveStorageRef(this.#objectsRoot, ref.storage_ref), ref);
  }

  /**
   * 只校验不返回字节，用于操作前的预检；顺带刷新 `last_verified_at`。
   *
   * 刷新时刻只在**校验通过之后**：把一个未通过校验的对象标记为「已核实」
   * 会让下一次预检直接跳过它。
   */
  async verify(ref: BlobRef): Promise<VerifyResult> {
    await this.getVerified(ref);
    const blob = this.#registry?.findByContent(ref.sha256, ref.size);
    if (this.#registry && !blob) {
      throw new BlobMissingError(
        `状态库中没有该快照的登记记录：${ref.storage_ref}`,
        ref.storage_ref,
      );
    }
    if (blob) this.#registry?.markVerified(blob.id);
    return { ok: true, sha256: ref.sha256, size: ref.size };
  }

  #requireRegistry(): BlobRegistry {
    if (!this.#registry) {
      throw new BlobGcRefusedError('本实例未接入状态库，无法读写引用计数。', 'NO_REGISTRY');
    }
    return this.#registry;
  }

  /**
   * 先落盘、后登记。**这是唯一推荐的写入入口。**
   *
   * 返回的 `id` 是登记 id，`storage_ref` 可直接写入 `change_items.old_blob/new_blob`。
   */
  async putAndRegister(
    bytes: Buffer,
    options: { readonly expectedSha256?: string; readonly id?: string } = {},
  ): Promise<{ readonly id: string; readonly put: PutResult }> {
    const registry = this.#requireRegistry();

    // 1) 落盘并 fsync —— 在这一步返回之前，数据库里不会有任何指向它的记录。
    const put = await this.put(bytes, { expectedSha256: options.expectedSha256 });

    // 2) 登记并占用一个引用。
    const outcome = registry.ensure({
      id: options.id ?? this.#newId(),
      sha256: put.sha256,
      size: put.size,
      storage_ref: put.storage_ref,
    });

    // 3) 登记后立刻回读校验：把「登记了却取不到字节」这类不一致
    //    挡在修改集进入可执行状态之前，而不是等到应用时才发现。
    await this.getVerified({
      sha256: outcome.blob.sha256,
      size: outcome.blob.size,
      storage_ref: outcome.blob.storage_ref,
    });

    return { id: outcome.blob.id, put };
  }

  /**
   * 回收无引用快照。
   *
   * 四个必须同时成立的条件，缺一不可：
   *  1. 状态库标记为 `pending_gc` 且 `refcount = 0`（由 `listPendingGc` 保证）；
   *  2. 调用方断言当前**没有在途操作或未决恢复**（`isSafeToCollect`）；
   *  3. **每一个对象**都没有被保留策略要求留下（`protect`，LWB-024）；
   *  4. 有仓储。没有引用计数就没有回收，宁可让磁盘涨。
   *
   * 第 2 条由调用方提供，而不是在这里猜：daemon 才知道自己有没有在恢复中，
   * 猜错的代价是删掉回滚唯一需要的原始字节。
   *
   * ## 为什么第 3 条不能由第 2 条代替
   *
   * 第 2 条是**全局**的：它为假时整轮回收被拒，为真时**所有** `pending_gc`
   * 都被删。而保留策略要表达的是「这一批里，运行中的那些留下、撤销窗口
   * 已满的那些删掉」—— 一个全局布尔值说不出这句话。用全局为真去代替它，
   * 会删掉仍在窗口内的字节；用全局为假，则让「清理不会删除正在使用的
   * 快照」空洞地成立（什么都不删，自然什么都没删错）。
   *
   * `protect` 与另外三条一样是**调用方提供**的判据，本模块仍然不做安全判定：
   * 它只问「这一个能不能删」，然后照做。判据本身在
   * `@lwb/changes` 的 `snapshotGuard`，那里从权威表重建「谁还需要这些字节」。
   */
  async collectGarbage(options: {
    readonly isSafeToCollect: () => boolean | Promise<boolean>;
    readonly unsafeReason?: string;
    /**
     * 逐对象的额外保留判据。返回一个**原因**表示保留，返回 `null` 表示
     * 本判据不保护它（其余三个条件仍然适用）。
     */
    readonly protect?: (blob: RegistryBlob) => string | null;
  }): Promise<GcReport> {
    const registry = this.#registry;
    if (!registry) {
      return {
        collected: [],
        skipped: [],
        refused: true,
        refusal_reason: '未接入状态库：无法得知引用计数，拒绝回收。',
      };
    }

    if (!(await options.isSafeToCollect())) {
      return {
        collected: [],
        skipped: [],
        refused: true,
        refusal_reason: options.unsafeReason ?? '存在在途操作或未决恢复，拒绝回收。',
      };
    }

    const collected: { id: string; sha256: string }[] = [];
    const skipped: { id: string; sha256: string; reason: string }[] = [];

    for (const blob of registry.listPendingGc()) {
      // 保留策略先问：它比引用计数更保守，而且它的答案不依赖一次
      // 可能缺席的 `releaseRef` 调用。
      const protection = options.protect?.(blob) ?? null;
      if (protection !== null) {
        skipped.push({ id: blob.id, sha256: blob.sha256, reason: protection });
        continue;
      }

      // 再核实一次：`listPendingGc` 与本次删除之间可能有并发引用。
      if (blob.refcount !== 0) {
        skipped.push({ id: blob.id, sha256: blob.sha256, reason: `引用计数变为 ${blob.refcount}` });
        continue;
      }
      let target: string;
      try {
        target = resolveStorageRef(this.#objectsRoot, blob.storage_ref);
      } catch (error) {
        skipped.push({
          id: blob.id,
          sha256: blob.sha256,
          reason: `引用形状不合法，拒绝据此删除：${error instanceof Error ? error.message : String(error)}`,
        });
        continue;
      }

      // 先删字节，后改状态：顺序反了会留下「标记已删除但字节还在」的孤儿，
      // 而孤儿不会被任何后续 GC 认领。
      await rm(target, { force: true });
      registry.markDeleted(blob.id);
      collected.push({ id: blob.id, sha256: blob.sha256 });
    }

    return { collected, skipped, refused: false, refusal_reason: null };
  }

  /** 清理崩溃遗留的临时文件。它们不在任何引用里，可以无条件删除。 */
  async sweepTempFiles(): Promise<string[]> {
    let entries: string[];
    try {
      entries = await readdir(this.#tempRoot);
    } catch {
      return [];
    }
    const removed: string[] = [];
    for (const entry of entries) {
      if (!entry.endsWith('.tmp')) continue;
      await rm(path.join(this.#tempRoot, entry), { force: true });
      removed.push(entry);
    }
    return removed;
  }
}

/**
 * 读取并校验一个已定位的对象。长度先于哈希比较：
 * 长度不符时不必读完整个文件即可判定失败。
 *
 * 独立函数而非方法，是为了让 `put` 的去重分支也能用它 ——
 * 那条路径上对象可能**尚未登记**，走 `verify()` 会因为查不到记录而误报。
 */
async function verifyBytesAt(target: string, ref: BlobRef): Promise<Buffer> {
  if (!existsSync(target)) {
    throw new BlobMissingError(
      `快照对象缺失，拒绝继续（极可能是状态库与磁盘不一致）：${ref.storage_ref}`,
      ref.storage_ref,
    );
  }
  const bytes = await readFile(target);
  if (bytes.length !== ref.size) {
    throw new BlobIntegrityError('快照长度与登记值不符，拒绝继续。', {
      storage_ref: ref.storage_ref,
      expected_sha256: ref.sha256,
      actual_sha256: null,
    });
  }
  const digest = sha256Of(bytes);
  if (digest !== ref.sha256) {
    throw new BlobIntegrityError('快照内容哈希与登记值不符，拒绝继续。', {
      storage_ref: ref.storage_ref,
      expected_sha256: ref.sha256,
      actual_sha256: digest,
    });
  }
  return bytes;
}

/** 供测试使用：直接落一个文件，用于构造「哈希不符」的场景。 */
export async function corruptObjectForTest(objectsRoot: string, sha256: string, bytes: Buffer): Promise<void> {
  const target = objectPath(objectsRoot, sha256);
  await writeFile(target, bytes);
}
