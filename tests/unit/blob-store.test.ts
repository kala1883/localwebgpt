/**
 * 内容寻址快照存储测试（LWB-007 步骤 3）。
 *
 * 三条必须被证明的性质：
 *
 *  1. **先落盘后引用**：登记发生时，字节必须已经在磁盘上。这条不靠注释保证，
 *     由替身仓储在 `ensure` 里实地检查文件是否存在来证明。
 *  2. **完整性校验会拒绝**：缺失、长度不符、内容哈希不符三种情况都必须抛出，
 *     且抛出**之后**不得留下任何「也许能用」的返回值 —— 用错误的旧字节回滚
 *     会静默损坏用户文件。
 *  3. **回收只碰无引用对象**：有引用的、引用计数刚变的、引用形状不合法的
 *     都必须跳过或拒绝。
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import {
  BlobQuotaExceededError,
  BlobIntegrityError,
  BlobMissingError,
  BlobStore,
  corruptObjectForTest,
  objectPath,
  resolveStorageRef,
  sha256Of,
  shardOf,
  storageRefOf,
  tempRootOf,
  type BlobRegistry,
  type RegistryBlob,
} from '@lwb/blob-store';

/** 内存替身仓储。只实现 blob-store 用到的那部分。 */
class FakeRegistry implements BlobRegistry {
  readonly blobs = new Map<string, RegistryBlob>();
  /** 记录 `ensure` 被调用时，磁盘上是否已存在该对象。 */
  readonly observedAtEnsure: { sha256: string; file_existed: boolean }[] = [];
  readonly verified: string[] = [];

  #objectsRoot: string;

  constructor(objectsRoot: string) {
    this.#objectsRoot = objectsRoot;
  }

  ensure(input: { id: string; sha256: string; size: number; storage_ref: string }) {
    this.observedAtEnsure.push({
      sha256: input.sha256,
      file_existed: existsSync(objectPath(this.#objectsRoot, input.sha256)),
    });
    const existing = this.findByContent(input.sha256, input.size);
    if (existing) {
      const bumped = { ...existing, refcount: existing.refcount + 1 };
      this.blobs.set(bumped.id, bumped);
      return { kind: 'existing' as const, blob: bumped };
    }
    const blob: RegistryBlob = {
      id: input.id,
      sha256: input.sha256,
      size: input.size,
      storage_ref: input.storage_ref,
      refcount: 1,
      retention_state: 'active',
    };
    this.blobs.set(blob.id, blob);
    return { kind: 'created' as const, blob };
  }

  findByContent(sha256: string, size: number): RegistryBlob | null {
    for (const blob of this.blobs.values()) {
      if (blob.sha256 === sha256 && blob.size === size) return blob;
    }
    return null;
  }

  releaseRef(id: string): void {
    const blob = this.blobs.get(id);
    assert.ok(blob);
    assert.ok(blob.refcount > 0);
    const refcount = blob.refcount - 1;
    this.blobs.set(id, {
      ...blob,
      refcount,
      retention_state: refcount === 0 ? 'pending_gc' : 'active',
    });
  }

  listPendingGc(): readonly RegistryBlob[] {
    return [...this.blobs.values()].filter((b) => b.retention_state === 'pending_gc' && b.refcount === 0);
  }

  markDeleted(id: string): void {
    const blob = this.blobs.get(id);
    assert.ok(blob, `markDeleted 收到了不存在的 id：${id}`);
    assert.equal(blob.refcount, 0, '只能删除引用已归零的对象');
    this.blobs.set(id, { ...blob, retention_state: 'deleted' });
  }

  markVerified(id: string): void {
    this.verified.push(id);
  }

  /** 测试辅助：直接把某个 blob 置为可回收。 */
  releaseTo(id: string): void {
    const blob = this.blobs.get(id);
    assert.ok(blob);
    this.blobs.set(id, { ...blob, refcount: 0, retention_state: 'pending_gc' });
  }
}

describe('LWB-007 快照存储', () => {
  let root: string;
  let objectsRoot: string;
  let store: BlobStore;
  let registry: FakeRegistry;

  before(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'lwb-blob-'));
    objectsRoot = path.join(root, 'objects');
    registry = new FakeRegistry(objectsRoot);
    store = new BlobStore({ objectsRoot, registry, newId: () => `blb_test_${registry.blobs.size + 1}` });
  });

  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('按内容寻址：路径由 sha256 决定，含两级分片', async () => {
    const bytes = Buffer.from('hello snapshot\n', 'utf8');
    const result = await store.put(bytes);
    const digest = sha256Of(bytes);

    assert.equal(result.sha256, digest);
    assert.equal(result.size, bytes.length);
    assert.equal(result.storage_ref, `objects/${digest.slice(0, 2)}/${digest}`);
    assert.equal(result.deduplicated, false);
    assert.equal(existsSync(path.join(objectsRoot, digest.slice(0, 2), digest)), true);
    assert.equal(await readFile(objectPath(objectsRoot, digest), 'utf8'), 'hello snapshot\n');
  });

  it('内容相同即去重，且不去读第二遍写入', async () => {
    const bytes = Buffer.from('duplicate me\n', 'utf8');
    const first = await store.put(bytes);
    const second = await store.put(bytes);
    assert.equal(first.deduplicated, false);
    assert.equal(second.deduplicated, true);
    assert.equal(second.sha256, first.sha256);
  });

  it('整批快照在超额时预拒绝，不落任何对象或引用', async () => {
    const quotaObjects = path.join(root, 'quota-objects');
    const quotaRegistry = new FakeRegistry(quotaObjects);
    const quotaStore = new BlobStore({
      objectsRoot: quotaObjects,
      registry: quotaRegistry,
      maxBytes: 10,
    });
    const first = Buffer.from('123456', 'utf8');
    const second = Buffer.from('abcdef', 'utf8');

    await assert.rejects(
      () => quotaStore.putAndRegisterBatch([{ bytes: first }, { bytes: second }]),
      (cause: unknown) => {
        assert.ok(cause instanceof BlobQuotaExceededError);
        assert.equal(cause.used_bytes, 0);
        assert.equal(cause.limit_bytes, 10);
        assert.equal(cause.incoming_bytes, 12);
        return true;
      },
    );
    assert.equal(existsSync(quotaObjects), false, '配额拒绝必须发生在创建对象目录和临时文件之前');
    assert.equal(quotaRegistry.blobs.size, 0, '配额拒绝不得登记部分快照引用');
  });

  it('按物理内容去重核算；GC 删除对象后容量可再次使用', async () => {
    const quotaObjects = path.join(root, 'quota-gc-objects');
    const quotaRegistry = new FakeRegistry(quotaObjects);
    const quotaStore = new BlobStore({
      objectsRoot: quotaObjects,
      registry: quotaRegistry,
      maxBytes: 6,
    });
    const original = Buffer.from('abcde', 'utf8');
    const first = await quotaStore.putAndRegister(original);
    const duplicate = await quotaStore.putAndRegister(original);
    assert.equal(first.id, duplicate.id);
    assert.equal(duplicate.put.deduplicated, true);

    await assert.rejects(
      () => quotaStore.putAndRegister(Buffer.from('xy', 'utf8')),
      BlobQuotaExceededError,
    );
    quotaRegistry.releaseRef(first.id);
    quotaRegistry.releaseRef(first.id);
    const report = await quotaStore.collectGarbage({ isSafeToCollect: () => true });
    assert.deepEqual(report.collected.map((item) => item.id), [first.id]);

    const afterGc = await quotaStore.putAndRegister(Buffer.from('xy', 'utf8'));
    assert.equal(afterGc.put.size, 2);
  });

  it('串行化并发批次，不允许合计越过配置硬上限', async () => {
    const quotaObjects = path.join(root, 'quota-race-objects');
    const quotaRegistry = new FakeRegistry(quotaObjects);
    const quotaStore = new BlobStore({
      objectsRoot: quotaObjects,
      registry: quotaRegistry,
      maxBytes: 6,
    });
    const results = await Promise.allSettled([
      quotaStore.putAndRegisterBatch([{ bytes: Buffer.from('first', 'utf8') }]),
      quotaStore.putAndRegisterBatch([{ bytes: Buffer.from('other', 'utf8') }]),
    ]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    const rejected = results.find((result) => result.status === 'rejected');
    assert.ok(rejected && rejected.status === 'rejected' && rejected.reason instanceof BlobQuotaExceededError);
    const firstDigest = sha256Of(Buffer.from('first', 'utf8'));
    const secondDigest = sha256Of(Buffer.from('other', 'utf8'));
    assert.equal(existsSync(objectPath(quotaObjects, firstDigest)), true);
    assert.equal(existsSync(objectPath(quotaObjects, secondDigest)), false);
    assert.equal([...quotaRegistry.blobs.values()].filter((blob) => blob.retention_state !== 'deleted').length, 1);
  });

  it('去重时若盘上已有的字节已被损坏，拒绝复用（不把损坏传播出去）', async () => {
    const bytes = Buffer.from('will-be-corrupted\n', 'utf8');
    const result = await store.put(bytes);
    // 用**等长**的其它内容覆盖：长度检查看不出来，只有哈希能发现。
    await corruptObjectForTest(objectsRoot, result.sha256, Buffer.from('WILL-BE-CORRUPTED!\n'.padEnd(bytes.length, 'x'), 'utf8'));
    await assert.rejects(() => store.put(bytes), BlobIntegrityError);
  });

  it('getVerified 正常往返', async () => {
    const bytes = Buffer.from('round trip\n', 'utf8');
    const { put } = await store.putAndRegister(bytes);
    const out = await store.getVerified({ sha256: put.sha256, size: put.size, storage_ref: put.storage_ref });
    assert.equal(out.toString('utf8'), 'round trip\n');
  });

  it('快照缺失时抛出 BlobMissingError（验收标准 2 的一半）', async () => {
    const bytes = Buffer.from('to-be-deleted\n', 'utf8');
    const { put } = await store.putAndRegister(bytes);
    await rm(objectPath(objectsRoot, put.sha256), { force: true });
    await assert.rejects(
      () => store.getVerified({ sha256: put.sha256, size: put.size, storage_ref: put.storage_ref }),
      (error: unknown) => {
        assert.ok(error instanceof BlobMissingError);
        assert.equal(error.storage_ref, put.storage_ref);
        return true;
      },
    );
  });

  it('哈希不符时抛出 BlobIntegrityError，并带上实际哈希（验收标准 2 的另一半）', async () => {
    const bytes = Buffer.from('original-content\n', 'utf8');
    const { put } = await store.putAndRegister(bytes);
    const tampered = Buffer.from('tampered-content\n', 'utf8');
    assert.equal(tampered.length, bytes.length, '本用例要求等长替换，否则测的是长度分支');
    await corruptObjectForTest(objectsRoot, put.sha256, tampered);

    await assert.rejects(
      () => store.getVerified({ sha256: put.sha256, size: put.size, storage_ref: put.storage_ref }),
      (error: unknown) => {
        assert.ok(error instanceof BlobIntegrityError);
        assert.equal(error.expected_sha256, put.sha256);
        assert.equal(error.actual_sha256, sha256Of(tampered));
        assert.notEqual(error.actual_sha256, error.expected_sha256);
        return true;
      },
    );
  });

  it('被截断的快照在长度这一步就被拒，不报出实际哈希', async () => {
    const bytes = Buffer.from('0123456789abcdef\n', 'utf8');
    const { put } = await store.putAndRegister(bytes);
    await corruptObjectForTest(objectsRoot, put.sha256, bytes.subarray(0, 4));

    await assert.rejects(
      () => store.getVerified({ sha256: put.sha256, size: put.size, storage_ref: put.storage_ref }),
      (error: unknown) => {
        assert.ok(error instanceof BlobIntegrityError);
        assert.equal(error.actual_sha256, null, '长度不符时没有读完整个文件，因此没有实际哈希');
        return true;
      },
    );
  });

  it('调用方声明的哈希与字节不符时，在落盘前就拒绝', async () => {
    const bytes = Buffer.from('the-real-bytes\n', 'utf8');
    const wrong = sha256Of(Buffer.from('something-else\n', 'utf8'));
    await assert.rejects(() => store.put(bytes, { expectedSha256: wrong }), BlobIntegrityError);
    // 关键：不得留下任何字节 —— 写进去就会把错误的字节永久固化。
    assert.equal(existsSync(objectPath(objectsRoot, sha256Of(bytes))), false);
    assert.equal(existsSync(objectPath(objectsRoot, wrong)), false);
  });

  it('先落盘后引用：登记发生时字节已经在磁盘上', async () => {
    registry.observedAtEnsure.length = 0;
    const bytes = Buffer.from('ordering-proof\n', 'utf8');
    await store.putAndRegister(bytes);

    assert.equal(registry.observedAtEnsure.length, 1);
    assert.equal(
      registry.observedAtEnsure[0]?.file_existed,
      true,
      '登记时字节还不在磁盘上 —— 顺序被颠倒了，会产生指向不存在字节的引用',
    );
  });

  it('登记后立刻回读校验：损坏会在这里被发现，而不是等到应用时', async () => {
    // 用替换整个 objects 根的实例模拟「登记与字节不一致」。
    const isolated = await mkdtemp(path.join(os.tmpdir(), 'lwb-blob-order-'));
    try {
      const isolatedObjects = path.join(isolated, 'objects');
      const isolatedRegistry = new FakeRegistry(isolatedObjects);
      const strict = new BlobStore({ objectsRoot: isolatedObjects, registry: isolatedRegistry });
      const bytes = Buffer.from('sanity\n', 'utf8');
      const { put } = await strict.putAndRegister(bytes);
      await strict.getVerified({ sha256: put.sha256, size: put.size, storage_ref: put.storage_ref });

      // 篡改之后，同一个引用必须被拒。
      await corruptObjectForTest(isolatedObjects, put.sha256, Buffer.from('EVILBYTES\n', 'utf8'));
      await assert.rejects(
        () => strict.getVerified({ sha256: put.sha256, size: put.size, storage_ref: put.storage_ref }),
        BlobIntegrityError,
      );
    } finally {
      await rm(isolated, { recursive: true, force: true });
    }
  });

  it('未接入状态库时拒绝登记与回收，但纯落盘仍可用', async () => {
    const standalone = new BlobStore({ objectsRoot: path.join(root, 'standalone-objects') });
    const bytes = Buffer.from('no registry\n', 'utf8');
    const put = await standalone.put(bytes);
    assert.equal(put.deduplicated, false);

    await assert.rejects(() => standalone.putAndRegister(bytes), /未接入状态库/);
    const report = await standalone.collectGarbage({ isSafeToCollect: () => true });
    assert.equal(report.refused, true);
    assert.match(report.refusal_reason ?? '', /未接入状态库/);
  });

  it('verify() 只在校验通过后刷新 last_verified_at', async () => {
    const isolated = await mkdtemp(path.join(os.tmpdir(), 'lwb-blob-verify-'));
    try {
      const isolatedObjects = path.join(isolated, 'objects');
      const isolatedRegistry = new FakeRegistry(isolatedObjects);
      const strict = new BlobStore({
        objectsRoot: isolatedObjects,
        registry: isolatedRegistry,
        newId: () => 'blb_verify',
      });
      const bytes = Buffer.from('verify-me\n', 'utf8');
      const { put } = await strict.putAndRegister(bytes);
      const ref = { sha256: put.sha256, size: put.size, storage_ref: put.storage_ref };

      isolatedRegistry.verified.length = 0;
      await strict.verify(ref);
      assert.deepEqual(isolatedRegistry.verified, ['blb_verify']);

      await corruptObjectForTest(isolatedObjects, put.sha256, Buffer.from('CORRUPTED!\n', 'utf8'));
      isolatedRegistry.verified.length = 0;
      await assert.rejects(() => strict.verify(ref), BlobIntegrityError);
      assert.deepEqual(isolatedRegistry.verified, [], '校验失败的对象不得被标记为已核实');
    } finally {
      await rm(isolated, { recursive: true, force: true });
    }
  });

  it('状态库里没有登记记录时 verify() 报缺失', async () => {
    const isolated = await mkdtemp(path.join(os.tmpdir(), 'lwb-blob-unreg-'));
    try {
      const isolatedObjects = path.join(isolated, 'objects');
      const isolatedRegistry = new FakeRegistry(isolatedObjects);
      const strict = new BlobStore({ objectsRoot: isolatedObjects, registry: isolatedRegistry });
      const bytes = Buffer.from('unregistered\n', 'utf8');
      const put = await strict.put(bytes);
      await assert.rejects(
        () => strict.verify({ sha256: put.sha256, size: put.size, storage_ref: put.storage_ref }),
        BlobMissingError,
      );
    } finally {
      await rm(isolated, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 回收
// ---------------------------------------------------------------------------

describe('LWB-007 快照回收', () => {
  let root: string;
  let objectsRoot: string;
  let registry: FakeRegistry;
  let store: BlobStore;
  let counter: number;

  before(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'lwb-blob-gc-'));
    objectsRoot = path.join(root, 'objects');
    registry = new FakeRegistry(objectsRoot);
    counter = 0;
    store = new BlobStore({ objectsRoot, registry, newId: () => `blb_gc_${(counter += 1)}` });
  });

  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('存在在途操作或未决恢复时拒绝回收', async () => {
    const { put } = await store.putAndRegister(Buffer.from('in-flight\n', 'utf8'));
    const report = await store.collectGarbage({
      isSafeToCollect: () => false,
      unsafeReason: '有操作处于 APPLYING',
    });
    assert.equal(report.refused, true);
    assert.match(report.refusal_reason ?? '', /APPLYING/);
    assert.equal(existsSync(objectPath(objectsRoot, put.sha256)), true, '拒绝回收时不得删除任何字节');
  });

  it('有引用的对象不会被回收，即使被错误标成 pending_gc', async () => {
    const { id, put } = await store.putAndRegister(Buffer.from('still-referenced\n', 'utf8'));
    const blob = registry.blobs.get(id);
    assert.ok(blob);
    // 制造一个自相矛盾的状态：状态是 pending_gc，但引用计数不是 0。
    registry.blobs.set(id, { ...blob, refcount: 1, retention_state: 'pending_gc' });

    const report = await store.collectGarbage({ isSafeToCollect: () => true });
    assert.equal(report.refused, false);
    assert.equal(report.collected.length, 0);
    assert.equal(existsSync(objectPath(objectsRoot, put.sha256)), true);
  });

  it('引用归零的对象被回收：先删字节，后改状态', async () => {
    const { id, put } = await store.putAndRegister(Buffer.from('collect-me\n', 'utf8'));
    const target = objectPath(objectsRoot, put.sha256);
    assert.equal(existsSync(target), true);

    registry.releaseTo(id);
    const report = await store.collectGarbage({ isSafeToCollect: () => true });

    assert.equal(report.refused, false);
    assert.deepEqual(
      report.collected.map((c) => c.id),
      [id],
    );
    assert.equal(existsSync(target), false, '字节必须已被删除');
    assert.equal(registry.blobs.get(id)?.retention_state, 'deleted');
  });

  it('storage_ref 形状不合法时跳过而不是照着删', async () => {
    const { id } = await store.putAndRegister(Buffer.from('evil-ref\n', 'utf8'));
    const blob = registry.blobs.get(id);
    assert.ok(blob);
    registry.blobs.set(id, {
      ...blob,
      refcount: 0,
      retention_state: 'pending_gc',
      storage_ref: 'objects/aa/../../../../etc/passwd',
    });
    await writeFile(path.join(root, 'canary.txt'), 'must-survive', 'utf8');

    const report = await store.collectGarbage({ isSafeToCollect: () => true });
    assert.equal(report.collected.length, 0);
    assert.equal(report.skipped.length, 1);
    assert.match(report.skipped[0]?.reason ?? '', /形状不合法/);
    assert.equal(await readFile(path.join(root, 'canary.txt'), 'utf8'), 'must-survive');
  });

  it('崩溃遗留的临时文件可以被清理', async () => {
    const tempRoot = tempRootOf(objectsRoot);
    const { mkdir } = await import('node:fs/promises');
    await mkdir(tempRoot, { recursive: true });
    await writeFile(path.join(tempRoot, 'leftover.tmp'), 'partial', 'utf8');
    await writeFile(path.join(tempRoot, 'keep.txt'), 'not a temp file', 'utf8');

    const removed = await store.sweepTempFiles();
    assert.equal(removed.includes('leftover.tmp'), true);
    const remaining = await readdir(tempRoot);
    assert.deepEqual(remaining, ['keep.txt']);
  });
});

// ---------------------------------------------------------------------------
// 引用形状
// ---------------------------------------------------------------------------

describe('LWB-007 快照引用形状', () => {
  const digest = sha256Of(Buffer.from('shape', 'utf8'));

  it('storageRefOf 与 resolveStorageRef 互相可逆', () => {
    const ref = storageRefOf(digest);
    assert.equal(ref, `objects/${shardOf(digest)}/${digest}`);
    assert.equal(resolveStorageRef(path.resolve('D:\\store\\objects'), ref), path.join(path.resolve('D:\\store\\objects'), shardOf(digest), digest));
  });

  it('形状不合法的引用一律拒绝', () => {
    for (const bad of [
      'objects/aa/../../../../etc/passwd',
      `objects/zz/${digest}`,
      `objects/${digest.slice(0, 2)}/${digest.slice(0, 63)}`,
      `../objects/${digest.slice(0, 2)}/${digest}`,
      `D:\\store\\objects\\${digest.slice(0, 2)}\\${digest}`,
      `objects/${digest.slice(0, 2)}/${digest.toUpperCase()}`,
      'objects',
      '',
    ]) {
      assert.throws(
        () => resolveStorageRef(path.resolve('D:\\store\\objects'), bad),
        /不合法|不一致/,
        `本应拒绝：${bad}`,
      );
    }
  });

  it('分片与哈希不一致时拒绝，避免一次引用指向两个位置', () => {
    const other = sha256Of(Buffer.from('other', 'utf8'));
    assert.throws(
      () => resolveStorageRef(path.resolve('D:\\store\\objects'), `objects/${other.slice(0, 2)}/${digest}`),
      /分片与哈希不一致/,
    );
  });

  it('临时目录与 objects 同级 —— 同卷才谈得上原子改名', () => {
    const objects = path.resolve('D:\\store\\objects');
    assert.equal(path.dirname(tempRootOf(objects)), path.dirname(objects));
  });
});
