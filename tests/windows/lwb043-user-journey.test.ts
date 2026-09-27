/**
 * LWB-043 real-tool journey on a disposable copy of a clean TransportAndAI tree.
 *
 * Run on Windows with:
 *   $env:LWB043_SOURCE_ROOT='D:\MyProjects\MyApps\transportandai-ma026-vue'
 *   node --import tsx --test tests/windows/lwb043-user-journey.test.ts
 *
 * Only four tracked sample files are copied into a fresh temp NTFS Git repo.
 * The source repo is asserted clean before and after; all edits and generated
 * documentation live in the disposable copy, and no commit or push is run.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { access, appendFile, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import type { ChangeApplyData, FileReadData, TextSearchData } from '@lwb/contracts';
import { PowerShellWinfsBackend } from '@lwb/winfs';
import type { WorkspaceEnvironment } from '@lwb/workspaces';

import { GATES_ON, callTool, dataOf, makeToolHarness, type ToolHarness } from '../tools/harness.ts';

const sourceRoot = process.env.LWB043_SOURCE_ROOT?.trim() ?? '';
const runJourney = process.platform === 'win32' && sourceRoot !== '';
const describeJourney = runJourney ? describe : describe.skip;
const SELECTED_FILES = [
  'apps/myagent/tools/security.py',
  'frontend-aigroup/src/config/groups.ts',
  'frontend/src/components/HelloWorld.vue',
  'docs/myagent-server-reads.md',
] as const;

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function git(root: string, args: readonly string[]): string {
  const result = spawnSync('git', [...args], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'LWB-043 acceptance',
      GIT_AUTHOR_EMAIL: 'lwb043@invalid.example',
      GIT_COMMITTER_NAME: 'LWB-043 acceptance',
      GIT_COMMITTER_EMAIL: 'lwb043@invalid.example',
    },
  });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
  // Preserve porcelain's leading status column; trim() would erase its blank
  // column and make a byte-accurate path assertion drop the first filename char.
  return result.stdout.trimEnd();
}

describeJourney('LWB-043 TransportAndAI controlled user journey', () => {
  let workspaceRoot = '';
  let environmentRoot = '';
  let otherRoot = '';
  let outsideRoot = '';
  let backend: PowerShellWinfsBackend;
  let harness: ToolHarness;
  let sourceHead = '';
  let sourceStatus = '';
  let workspaceHead = '';
  let stagedBaseline = '';
  let outsideCanaryPath = '';
  let outsideCanaryHash = '';

  before(async () => {
    assert.ok(sourceRoot, 'set LWB043_SOURCE_ROOT to the clean, controlled TransportAndAI copy');
    sourceHead = git(sourceRoot, ['rev-parse', 'HEAD']);
    sourceStatus = git(sourceRoot, ['status', '--porcelain=v1']);
    assert.equal(sourceStatus, '', 'source must be a clean controlled copy; never test against a dirty source');

    workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'lwb043-workspace-'));
    environmentRoot = await mkdtemp(path.join(os.tmpdir(), 'lwb043-private-'));
    otherRoot = await mkdtemp(path.join(os.tmpdir(), 'lwb043-other-'));
    outsideRoot = await mkdtemp(path.join(os.tmpdir(), 'lwb043-outside-'));

    for (const relative of SELECTED_FILES) {
      const destination = path.join(workspaceRoot, ...relative.split('/'));
      await mkdir(path.dirname(destination), { recursive: true });
      await copyFile(path.join(sourceRoot, ...relative.split('/')), destination);
    }

    outsideCanaryPath = path.join(outsideRoot, 'do-not-touch.txt');
    await writeFile(outsideCanaryPath, `outside-workspace-canary:${randomUUID()}\n`, 'utf8');
    outsideCanaryHash = sha256(await readFile(outsideCanaryPath));

    git(workspaceRoot, ['init', '--quiet']);
    git(workspaceRoot, ['add', '--all']);
    git(workspaceRoot, ['commit', '--quiet', '-m', 'LWB-043 disposable baseline']);
    workspaceHead = git(workspaceRoot, ['rev-parse', 'HEAD']);
    stagedBaseline = git(workspaceRoot, ['diff', '--cached', '--binary']);

    // Add a saved, unstaged change after the baseline commit. This is a real
    // disk change, unlike an unsaved editor buffer, which V1 cannot observe.
    const marker = `<!-- LWB043-SAVED-UNCOMMITTED:${randomUUID()} -->`;
    const vuePath = path.join(workspaceRoot, 'frontend', 'src', 'components', 'HelloWorld.vue');
    const vueBytes = await readFile(vuePath);
    const eol = vueBytes.includes(Buffer.from('\r\n')) ? '\r\n' : '\n';
    await appendFile(vuePath, `${eol}${marker}${eol}`, 'utf8');

    backend = new PowerShellWinfsBackend();
    const capability = await backend.capability();
    assert.equal(capability.available, true, `real path guard unavailable: ${capability.resolved_backend_reason}`);

    const environment: WorkspaceEnvironment = {
      store_root: path.join(environmentRoot, 'store'),
      home_directory: path.join(environmentRoot, 'home'),
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
    });
  });

  after(async () => {
    if (harness) harness.close();
    await backend?.dispose();
    for (const target of [workspaceRoot, environmentRoot, otherRoot, outsideRoot]) {
      if (target) await rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it('reads MyAgent/AiGroup and saved Vue state, then directly edits/creates under the workspace grant and verifies MCP readback', async () => {
    const workspaceId = harness.workspace.id;
    const readFileTool = async (relative: string): Promise<FileReadData> =>
      dataOf<FileReadData>(
        await callTool(harness, 'file_read', { workspace_id: workspaceId, path: relative }),
        `file_read(${relative})`,
      );

    const myAgent = await readFileTool('apps/myagent/tools/security.py');
    assert.equal(myAgent.source, 'disk');
    assert.ok(myAgent.content.includes('Security primitives'));

    const aiGroup = await readFileTool('frontend-aigroup/src/config/groups.ts');
    assert.ok(aiGroup.content.includes('硅碳生命体交流群'));
    const search = dataOf<TextSearchData>(
      await callTool(harness, 'text_search', {
        workspace_id: workspaceId,
        query: '硅碳生命体交流群',
        path: 'frontend-aigroup/src/config',
      }),
      'text_search(AiGroup)',
    );
    assert.equal(search.scope.complete, true);
    assert.ok(search.matches.some((match) => match.path === 'frontend-aigroup/src/config/groups.ts'));

    const docRead = await readFileTool('docs/myagent-server-reads.md');
    assert.ok(docRead.content.includes('Optional host data reads'));

    const vueRelative = 'frontend/src/components/HelloWorld.vue';
    const vueRead = await readFileTool(vueRelative);
    assert.equal(vueRead.source, 'disk');
    assert.equal(vueRead.truncated, false);
    assert.equal(vueRead.editable, true, `Vue sample must be editable: ${vueRead.editable_blockers.join(', ')}`);
    const savedMarkerLine = vueRead.content.split(/\r?\n/).findIndex((line) => line.includes('LWB043-SAVED-UNCOMMITTED:'));
    assert.ok(savedMarkerLine >= 0, 'file_read must see the saved but unstaged disk change');
    const vuePath = path.join(workspaceRoot, ...vueRelative.split('/'));
    const vueBeforeBytes = await readFile(vuePath);
    assert.equal(vueRead.sha256, sha256(vueBeforeBytes));

    const edited = dataOf<ChangeApplyData>(
      await callTool(harness, 'file_edit', {
        workspace_id: workspaceId,
        idempotency_key: 'lwb043-vue-edit-direct',
        summary: 'Controlled-copy Vue direct edit journey',
        path: vueRelative,
        base_sha256: vueRead.sha256,
        read_token: vueRead.read_token,
        edits: [{
          start_line: savedMarkerLine + 1,
          end_line_exclusive: savedMarkerLine + 2,
          old_lines: [vueRead.content.split(/\r?\n/)[savedMarkerLine]!],
          new_lines: [vueRead.content.split(/\r?\n/)[savedMarkerLine]!.replace('SAVED-UNCOMMITTED', 'WORKSPACE-GRANT-EDIT')],
        }],
      }),
      'file_edit(direct write)',
    );
    assert.equal(edited.state, 'APPLIED');
    const vueAfterBytes = await readFile(vuePath);
    assert.ok(vueAfterBytes.toString('utf8').includes('LWB043-WORKSPACE-GRANT-EDIT:'));
    assert.equal(edited.files[0]?.after_sha256, sha256(vueAfterBytes));
    const vueReadback = await readFileTool(vueRelative);
    assert.equal(vueReadback.sha256, sha256(vueAfterBytes), 'MCP readback must match independently read disk bytes');
    assert.ok(vueReadback.content.includes('LWB043-WORKSPACE-GRANT-EDIT:'));

    const createdPath = 'docs/lwb043-workspace-grant-acceptance.md';
    const created = dataOf<ChangeApplyData>(
      await callTool(harness, 'file_create', {
        workspace_id: workspaceId,
        idempotency_key: 'lwb043-doc-create-direct',
        summary: 'Create test-only journey note in disposable copy',
        path: createdPath,
        content: '# LWB-043 test-only artifact\n\nCreated directly under a local workspace grant.\n',
        newline: 'lf',
        bom: false,
      }),
      'file_create(direct write)',
    );
    assert.equal(created.state, 'APPLIED');
    const newDocPath = path.join(workspaceRoot, ...createdPath.split('/'));
    const docBytes = await readFile(newDocPath);
    assert.equal(created.files[0]?.after_sha256, sha256(docBytes));
    const docReadback = await readFileTool(createdPath);
    assert.equal(docReadback.sha256, sha256(docBytes), 'created file MCP readback must match independently read disk bytes');
    assert.ok(docReadback.content.includes('Created directly under a local workspace grant.'));

    const stagedAfter = git(workspaceRoot, ['diff', '--cached', '--binary']);
    assert.equal(stagedAfter, stagedBaseline, 'the Git index must not change');
    const headAfter = git(workspaceRoot, ['rev-parse', 'HEAD']);
    assert.equal(headAfter, workspaceHead, 'acceptance must not create a commit');
    const changedPaths = git(workspaceRoot, ['status', '--porcelain=v1'])
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => line.slice(3).replaceAll('\\', '/'))
      .sort();
    assert.deepEqual(changedPaths, [createdPath, vueRelative].sort());
    assert.equal(git(sourceRoot, ['rev-parse', 'HEAD']), sourceHead);
    assert.equal(git(sourceRoot, ['status', '--porcelain=v1']), sourceStatus, 'source copy must remain untouched');
    const outsideAfterHash = sha256(await readFile(outsideCanaryPath));
    assert.equal(outsideAfterHash, outsideCanaryHash, 'outside-workspace canary must remain byte-identical');

    process.stdout.write(`\nLWB043_RESULT=${JSON.stringify({
      source_commit: sourceHead,
      copied_source_files: SELECTED_FILES.length,
      myagent_read_sha256: myAgent.sha256,
      aigroup_read_sha256: aiGroup.sha256,
      aigroup_search_matches: search.matches.length,
      vue_before_sha256: vueRead.sha256,
      vue_after_sha256: sha256(vueAfterBytes),
      vue_change_id: edited.change_id,
      vue_operation_id: edited.operation_id,
      vue_mcp_readback_sha256: vueReadback.sha256,
      created_doc_path: createdPath,
      created_doc_sha256: sha256(docBytes),
      create_change_id: created.change_id,
      create_operation_id: created.operation_id,
      create_mcp_readback_sha256: docReadback.sha256,
      git_head_unchanged: headAfter === workspaceHead,
      staged_diff_unchanged: stagedAfter === stagedBaseline,
      changed_paths: changedPaths,
      outside_canary_unchanged: outsideAfterHash === outsideCanaryHash,
      unsaved_editor_buffer: 'NOT_ACCESSIBLE_BY_V1_DISK_TOOL',
      source_copy_unchanged: true,
    })}\n`);
  });
});
