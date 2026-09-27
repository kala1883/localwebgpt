import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { after, describe, it } from 'node:test';

import type { FileReadData } from '@lwb/contracts';
import type { WinfsOps } from '@lwb/winfs';

import {
  GATES_ON,
  callTool,
  dataOf,
  errorOf,
  makeToolHarness,
  type ToolHarness,
} from '../tools/harness.ts';
import { fileOf, makeOps, treeOf } from '../search/harness.ts';

const open = async (): Promise<{ harness: ToolHarness; bytes: string; getWrites: () => number }> => {
  const bytes = 'alpha\nbeta\n';
  const fixture = makeOps(treeOf({ 'note.txt': fileOf(bytes) }));
  let writes = 0;
  const ops: WinfsOps = {
    capability: () => fixture.ops.capability(),
    statVolume: (request) => fixture.ops.statVolume(request),
    validatePath: (request) => fixture.ops.validatePath(request),
    resolvePath: (request) => fixture.ops.resolvePath(request),
    readFileGuarded: async (request) => {
      const result = await fixture.ops.readFileGuarded(request);
      if (!result.ok) return result;
      const body = Buffer.from(result.bytes_base64, 'base64');
      return { ...result, sha256: createHash('sha256').update(body).digest('hex') };
    },
    writeFileGuarded: (request) => {
      writes += 1;
      return fixture.ops.writeFileGuarded(request);
    },
    createFileGuarded: (request) => {
      writes += 1;
      return fixture.ops.createFileGuarded(request);
    },
    listDirectory: (request) => fixture.ops.listDirectory(request),
  };
  const harness = await makeToolHarness({ gates: GATES_ON, ops, blob_store_max_bytes: 1 });
  return { harness, bytes, getWrites: () => writes };
};

describe('LWB-038 snapshot storage quota at tool prepare boundary', () => {
  const harnesses: ToolHarness[] = [];
  after(() => {
    for (const harness of harnesses.splice(0)) harness.close();
  });

  it('returns STORAGE_UNAVAILABLE before snapshot creation or workspace writes when a prepared change cannot fit', async () => {
    const opened = await open();
    const { harness, bytes } = opened;
    harnesses.push(harness);
    const baseline = dataOf<FileReadData>(
      await callTool(harness, 'file_read', { workspace_id: harness.workspace.id, path: 'note.txt' }),
      'file_read(baseline)',
    );

    const refused = errorOf(
      await callTool(harness, 'file_edit', {
        workspace_id: harness.workspace.id,
        idempotency_key: 'lwb038-over-quota-edit',
        summary: 'The snapshot quota must reject before workspace changes',
        path: 'note.txt',
        base_sha256: baseline.sha256,
        read_token: baseline.read_token,
        edits: [{ start_line: 2, end_line_exclusive: 3, old_lines: ['beta'], new_lines: ['BETA'] }],
      }),
      'file_edit over quota',
    );
    assert.equal(refused.error.code, 'STORAGE_UNAVAILABLE');
    assert.equal(refused.error.details?.['reason'], 'SNAPSHOT_QUOTA_EXCEEDED');
    assert.equal(opened.getWrites(), 0);
    assert.deepEqual(await readdir(harness.blobs.objectsRoot), [], 'batch preflight must write no object files');
    assert.equal(harness.repos.blobs.findByContent(baseline.sha256, Buffer.byteLength(bytes)), null);

    const after = dataOf<FileReadData>(
      await callTool(harness, 'file_read', { workspace_id: harness.workspace.id, path: 'note.txt' }),
      'file_read(after refusal)',
    );
    assert.equal(after.sha256, baseline.sha256);
    assert.equal(after.content, bytes);
  });
});
