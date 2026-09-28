import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';

import {
  registerHistoryOperations,
  registerRecoveryOperations,
} from '../../apps/daemon/src/control/index.ts';
import { OperationRegistry, type RequestContext } from '@lwb/ipc';
import type { RecoveryService } from '@lwb/recovery';
import type { Repositories } from '@lwb/persistence';

const CONSOLE: RequestContext = {
  audience: 'console',
  connection_id: 'console:s1',
  pid: 7,
  request_id: 'req-1',
};

const MODEL: RequestContext = { ...CONSOLE, audience: 'mcp-adapter', connection_id: 'model:c1' };

const RECORD = {
  operation_id: 'op_1',
  change_id: 'chg_1',
  workspace_id: 'ws_1',
  operation_state: 'RECOVERY_REQUIRED',
  change_state: 'RECOVERY_REQUIRED',
  recovered: false,
  items: [{
    item_id: 'item_1',
    canonical_path: 'src/app.ts',
    op: 'edit_text',
    before_sha256: 'a'.repeat(64),
    after_sha256: 'b'.repeat(64),
    error_code: null,
    updated_at: '2026-09-27T00:00:00.000Z',
  }],
  authorizations: [],
  journal: [],
} as const;

function harness(): {
  readonly registry: OperationRegistry;
  readonly audit: Record<string, unknown>[];
  readonly blobReads: string[];
  readonly calls: { readonly method: string; readonly input: unknown }[];
} {
  const registry = new OperationRegistry();
  const audit: Record<string, unknown>[] = [];
  const blobReads: string[] = [];
  const calls: { method: string; input: unknown }[] = [];
  const originalBytes = Buffer.from('baseline snapshot\n', 'utf8');
  const proposedBytes = Buffer.from('proposed snapshot\n', 'utf8');
  const blobRows = new Map([
    ['blob_original', {
      id: 'blob_original', sha256: createHash('sha256').update(originalBytes).digest('hex'), size: originalBytes.length,
      storage_ref: '00/original', refcount: 1, retention_state: 'active', created_at: '2026-09-27T00:00:00.000Z', last_verified_at: null,
    }],
    ['blob_proposed', {
      id: 'blob_proposed', sha256: createHash('sha256').update(proposedBytes).digest('hex'), size: proposedBytes.length,
      storage_ref: '00/proposed', refcount: 1, retention_state: 'active', created_at: '2026-09-27T00:00:00.000Z', last_verified_at: null,
    }],
  ]);
  const bytesByBlobId = new Map([
    ['blob_original', originalBytes],
    ['blob_proposed', proposedBytes],
  ]);
  const repos = {
    operations: {
      listByStates: () => [{ id: 'op_1' }],
      listRecent: () => [{
        id: 'op_1', change_id: 'chg_1', state: 'RECOVERY_REQUIRED', idempotency_key: null,
        worker_instance: null, recovered: false, started_at: null, finished_at: null,
        created_at: '2026-09-27T00:00:00.000Z',
      }],
    },
    changes: {
      findById: () => ({ workspace_id: 'ws_1', state: 'RECOVERY_REQUIRED' }),
      items: () => [{
        id: 'item_1', canonical_path: 'src/app.ts', old_blob_id: 'blob_original', new_blob_id: 'blob_proposed',
      }],
    },
    blobs: { requireById: (id: string) => {
      const blob = blobRows.get(id);
      if (!blob) throw new Error(`unexpected blob id: ${id}`);
      return blob;
    } },
    audit: { append: (input: Record<string, unknown>) => { audit.push(input); return 1; }, list: () => [] },
  } as unknown as Repositories;
  const recovery = {
    records: (id: string) => id === 'op_1' ? RECORD : null,
    inspect: async () => null,
    authorize: async () => ({ authorization_id: 'auth_1', digest: 'd'.repeat(64), expires_at: 'later' }),
    repair: async () => ({ after: 'ROLLED_BACK', repaired: 1, failed: null, items: [] }),
  } as unknown as RecoveryService;
  const blobs = {
    getVerified: async (blob: { readonly id: string }) => {
      blobReads.push(blob.id);
      const bytes = bytesByBlobId.get(blob.id);
      if (!bytes) throw new Error(`unexpected blob bytes: ${blob.id}`);
      return Buffer.from(bytes);
    },
  } as unknown as import('@lwb/blob-store').BlobStore;
  registerRecoveryOperations(registry, {
    repos,
    recovery,
    blobs,
    now: () => '2026-09-27T00:00:00.000Z',
  });
  registerHistoryOperations(registry, { repos });
  for (const name of registry.names()) {
    const original = registry.lookup(name);
    if (!original) continue;
    calls.push({ method: name, input: original });
  }
  return { registry, audit, blobReads, calls };
}

describe('LWB-037 恢复与历史控制操作', () => {
  it('恢复记录来自状态库，模型侧不能调用，且 keep_current 不清除状态', async () => {
    const h = harness();
    const list = h.registry.lookup('recovery.list');
    assert.ok(list);
    assert.deepEqual((list.handler({}, CONSOLE) as { records: unknown[] }).records.length, 1);
    assert.throws(() => list.handler({}, MODEL), /只有本地控制台/);

    const keep = h.registry.lookup('recovery.keep_current');
    assert.ok(keep);
    const result = keep.handler({ operation_id: 'op_1', item_id: 'item_1' }, CONSOLE);
    assert.deepEqual(result, { operation_id: 'op_1', item_id: 'item_1', state_unchanged: true });
    assert.equal(h.audit.length, 1);
    assert.equal(h.audit[0]?.action, 'recovery.keep_current');
    assert.equal(h.audit[0]?.outcome, 'allow');
  });

  it('恢复写入必须有显式确认，且身份只取自控制面上下文', async () => {
    const h = harness();
    const authorize = h.registry.lookup('recovery.authorize');
    assert.ok(authorize);
    await assert.rejects(
      Promise.resolve().then(() => authorize.handler({ operation_id: 'op_1' }, CONSOLE)),
      /confirmed: true/,
    );
    const issued = await authorize.handler({ operation_id: 'op_1', confirmed: true, user_id: 'forged' }, CONSOLE) as Record<string, unknown>;
    assert.equal(issued['authorization_id'], 'auth_1');
    // 伪造字段没有被读作 actor；审计身份来自 console:s1 的上下文。
    assert.equal(h.audit.length, 1);
  });

  it('只向本地控制台导出绑定到 operation/item/version 的受保护原始快照', async () => {
    const h = harness();
    const exportSnapshot = h.registry.lookup('recovery.export_snapshot');
    assert.ok(exportSnapshot);
    const request = (snapshot: 'original' | 'proposed') => ({
      operation_id: 'op_1',
      item_id: 'item_1',
      snapshot,
      confirmed: true,
      subject: `recovery-export:op_1:item_1:${snapshot}`,
      nonce: 'nonce_once',
    });

    const original = await exportSnapshot.handler(request('original'), CONSOLE) as Record<string, unknown>;
    const proposed = await exportSnapshot.handler(request('proposed'), CONSOLE) as Record<string, unknown>;
    assert.equal(original['file_name'], 'recovery-app.ts-original.snapshot');
    assert.equal(proposed['file_name'], 'recovery-app.ts-proposed.snapshot');
    assert.equal(original['content_type'], 'application/octet-stream');
    assert.deepEqual(Buffer.from(String(original['content_base64']), 'base64'), Buffer.from('baseline snapshot\n'));
    assert.deepEqual(Buffer.from(String(proposed['content_base64']), 'base64'), Buffer.from('proposed snapshot\n'));
    assert.deepEqual(h.blobReads, ['blob_original', 'blob_proposed']);

    const exportAudits = h.audit.filter((entry) => entry['action'] === 'recovery.export_snapshot');
    assert.deepEqual(exportAudits.map((entry) => entry['outcome']), ['allow', 'allow']);
    assert.equal(JSON.stringify(exportAudits).includes('src/app.ts'), false);
    assert.equal(JSON.stringify(exportAudits).includes('baseline snapshot'), false);
  });

  it('拒绝模型调用、版本错绑和向 daemon 指定本机目标路径', async () => {
    const h = harness();
    const exportSnapshot = h.registry.lookup('recovery.export_snapshot');
    assert.ok(exportSnapshot);
    const validRequest = {
      operation_id: 'op_1', item_id: 'item_1', snapshot: 'original', confirmed: true,
      subject: 'recovery-export:op_1:item_1:original', nonce: 'nonce_once',
    };

    await assert.rejects(
      Promise.resolve().then(() => exportSnapshot.handler(validRequest, MODEL)),
      /只有本地控制台/,
    );
    await assert.rejects(
      Promise.resolve().then(() => exportSnapshot.handler(
        { ...validRequest, subject: 'recovery-export:op_1:item_1:proposed' }, CONSOLE,
      )),
      /授权对象与请求目标不一致/,
    );
    await assert.rejects(
      Promise.resolve().then(() => exportSnapshot.handler(
        { ...validRequest, destination_path: 'D:\\private\\snapshot.bin' }, CONSOLE,
      )),
      /包含不支持的字段/,
    );
    assert.deepEqual(h.blobReads, []);
  });

  it('历史页同时返回真实操作终态与审计列表', () => {
    const h = harness();
    const history = h.registry.lookup('history.list');
    assert.ok(history);
    const result = history.handler({ limit: 10 }, CONSOLE) as {
      operations: readonly { operation_state: string; change_state: string }[];
      audit: readonly unknown[];
    };
    assert.equal(result.operations[0]?.operation_state, 'RECOVERY_REQUIRED');
    assert.equal(result.operations[0]?.change_state, 'RECOVERY_REQUIRED');
    assert.deepEqual(result.audit, []);
  });
});
