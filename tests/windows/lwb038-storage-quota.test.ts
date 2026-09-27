/** LWB-038: snapshot quota refusal on a real temporary Windows workspace. */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import type { FileReadData } from '@lwb/contracts';
import { PowerShellWinfsBackend } from '@lwb/winfs';
import type { WorkspaceEnvironment } from '@lwb/workspaces';

import { GATES_ON, callTool, dataOf, errorOf, makeToolHarness, type ToolHarness } from '../tools/harness.ts';

const windowsDescribe = process.platform === 'win32' ? describe : describe.skip;
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

windowsDescribe('LWB-038 storage quota (real Windows guard)', () => {
  let workspaceRoot = '';
  let privateRoot = '';
  let otherRoot = '';
  let backend: PowerShellWinfsBackend;
  let harness: ToolHarness;
  const baseline = 'alpha\nbeta\n';

  before(async () => {
    workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'lwb038-quota-workspace-'));
    privateRoot = await mkdtemp(path.join(os.tmpdir(), 'lwb038-quota-private-'));
    otherRoot = await mkdtemp(path.join(os.tmpdir(), 'lwb038-quota-other-'));
    await writeFile(path.join(workspaceRoot, 'note.txt'), baseline, 'utf8');

    backend = new PowerShellWinfsBackend();
    const capability = await backend.capability();
    assert.equal(capability.available, true, `real path guard unavailable: ${capability.resolved_backend_reason}`);
    const environment: WorkspaceEnvironment = {
      store_root: path.join(privateRoot, 'store'),
      home_directory: path.join(privateRoot, 'home'),
      extra_broad_probes: [],
      protected_refs: [],
      policy_version: 7,
    };
    await mkdir(environment.store_root, { recursive: true });
    await mkdir(environment.home_directory, { recursive: true });
    harness = await makeToolHarness({
      root: workspaceRoot,
      other_root: otherRoot,
      ops: backend,
      probe: backend,
      environment,
      gates: GATES_ON,
      blob_store_max_bytes: 1,
    });
  });

  after(async () => {
    if (harness) harness.close();
    await backend?.dispose();
    for (const target of [workspaceRoot, privateRoot, otherRoot]) {
      if (target) await rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it('rejects an over-quota text edit before snapshot registration or workspace write', async () => {
    const workspaceId = harness.workspace.id;
    const read = dataOf<FileReadData>(
      await callTool(harness, 'file_read', { workspace_id: workspaceId, path: 'note.txt' }),
      'file_read',
    );
    const targetPath = path.join(workspaceRoot, 'note.txt');
    assert.equal(read.sha256, sha256(Buffer.from(baseline, 'utf8')));

    const refused = errorOf(
      await callTool(harness, 'file_edit', {
        workspace_id: workspaceId,
        idempotency_key: 'lwb038-real-quota-edit',
        summary: 'The cap must reject before touching the workspace',
        path: 'note.txt',
        base_sha256: read.sha256,
        read_token: read.read_token,
        edits: [{ start_line: 2, end_line_exclusive: 3, old_lines: ['beta'], new_lines: ['BETA'] }],
      }),
      'file_edit over snapshot quota',
    );
    assert.equal(refused.error.code, 'STORAGE_UNAVAILABLE');
    assert.equal(refused.error.details?.['reason'], 'SNAPSHOT_QUOTA_EXCEEDED');
    assert.equal(sha256(await readFile(targetPath)), read.sha256, 'workspace bytes must be unchanged');
    assert.deepEqual(await readdir(harness.blobs.objectsRoot), [], 'batch preflight must leave the object store empty');
    assert.equal(harness.repos.blobs.findByContent(read.sha256, Buffer.byteLength(baseline)), null);

    const createPath = 'new-doc.md';
    const createRefused = errorOf(
      await callTool(harness, 'file_create', {
        workspace_id: workspaceId,
        idempotency_key: 'lwb038-real-quota-create',
        summary: 'The cap also covers created-file snapshots',
        path: createPath,
        content: '# New document\n',
        newline: 'lf',
        bom: false,
      }),
      'file_create over snapshot quota',
    );
    assert.equal(createRefused.error.code, 'STORAGE_UNAVAILABLE');
    await assert.rejects(access(path.join(workspaceRoot, createPath)));
    assert.deepEqual(await readdir(harness.blobs.objectsRoot), []);
  });
});
