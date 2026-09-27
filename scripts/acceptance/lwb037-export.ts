/**
 * Disposable browser acceptance fixture for LWB-037 snapshot export.
 *
 * This starts a daemon with a throwaway protected home, creates one temporary
 * NTFS workspace, and seeds one RECOVERY_REQUIRED edit whose current bytes are
 * deliberately a third version. It keeps the daemon alive until Ctrl+C so the
 * user can open the printed one-time URL and exercise the real control API and
 * browser save picker. No repository workspace or default LWB home is touched.
 */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { BlobStore } from '@lwb/blob-store';
import { canonicalChangeDigest } from '@lwb/changes';
import { CONTRACT_VERSION, newLocalId } from '@lwb/contracts';
import type { ChangeDigestFile } from '@lwb/changes';
import type { ChangeItemInput } from '@lwb/persistence';
import { getWinfsBackend, isWinfsError } from '@lwb/winfs';
import { ADAPTER_CONNECTION_ID, startDaemon } from '../../apps/daemon/src/runtime/index.ts';
import { loadConsoleAssets } from '../../apps/daemon/src/lifecycle/console-assets.ts';

const POLICY_VERSION = 1;

function waitForExitSignal(): Promise<'SIGINT' | 'SIGTERM'> {
  return new Promise((resolve) => {
    process.once('SIGINT', () => resolve('SIGINT'));
    process.once('SIGTERM', () => resolve('SIGTERM'));
  });
}

async function main(): Promise<void> {
  if (process.platform !== 'win32') {
    throw new Error('LWB-037 恢复快照浏览器验收需要 Windows + NTFS 护栏。');
  }

  const signalPromise = waitForExitSignal();
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'lwb037-export-'));
  const workspaceRoot = path.join(temporaryRoot, 'workspace');
  const storeRoot = path.join(temporaryRoot, 'protected-home');
  await Promise.all([mkdir(workspaceRoot), mkdir(storeRoot)]);

  let runtime: Awaited<ReturnType<typeof startDaemon>> | null = null;
  try {
    runtime = await startDaemon({
      argv: [`--home=${storeRoot}`],
      env: process.env,
      static_assets: await loadConsoleAssets(),
    });

    const relativePath = 'recovery-note.txt';
    const absolutePath = path.join(workspaceRoot, relativePath);
    const original = Buffer.from('Acceptance fixture: original bytes\n', 'utf8');
    const proposed = Buffer.from('Acceptance fixture: proposed bytes\n', 'utf8');
    const current = Buffer.from('Acceptance fixture: third-party edit\n', 'utf8');
    await writeFile(absolutePath, original, { flag: 'wx' });

    const guard = getWinfsBackend();
    const volume = await guard.statVolume({ path: workspaceRoot });
    if (!volume.ok) throw new Error('无法读取临时 NTFS 工作区身份，停止验收夹具创建。');
    const scope = {
      root_path: workspaceRoot,
      root_volume_id: volume.volume_id,
      root_file_id: volume.file_id,
    };
    const observed = await guard.readFileGuarded({ ...scope, relative_path: relativePath });
    if (!observed.ok) throw new Error('无法从护栏读取临时基线文件，停止验收夹具创建。');
    if (isWinfsError(observed)) throw new Error('临时基线读取失败。');

    const blobs = new BlobStore({
      objectsRoot: path.join(runtime.facts.store_root, 'objects'),
      registry: runtime.repos.blobs,
    });
    const oldBlob = await blobs.putAndRegister(original);
    const newBlob = await blobs.putAndRegister(proposed);
    const workspace = runtime.repos.workspaces.create({
      id: newLocalId('ws'),
      alias: 'lwb037-export-acceptance',
      kind: 'directory',
      canonical_root: workspaceRoot,
      volume_id: volume.volume_id,
      root_file_id: volume.file_id,
      policy_version: POLICY_VERSION,
      mode: 'read_only',
    });

    // Keep the same NTFS file identity while changing its content to a third
    // version. This makes the UI show a conflict and prevents repair approval.
    await writeFile(absolutePath, current);

    const itemId = newLocalId('ci');
    const files: ChangeDigestFile[] = [{
      path: relativePath,
      op: 'edit_text',
      before_sha256: oldBlob.put.sha256,
      before_size: oldBlob.put.size,
      after_sha256: newBlob.put.sha256,
      after_size: newBlob.put.size,
      encoding: 'utf-8',
      newline: 'lf',
      bom: false,
    }];
    const digest = canonicalChangeDigest({
      contract_version: CONTRACT_VERSION,
      policy_version: POLICY_VERSION,
      root_generation: workspace.generation,
      workspace_id: workspace.id,
      files,
    });
    const item: ChangeItemInput = {
      id: itemId,
      path: relativePath,
      op: 'edit_text',
      base_file_id: observed.identity.file_id,
      base_sha256: oldBlob.put.sha256,
      target_sha256: newBlob.put.sha256,
      old_blob_id: oldBlob.id,
      new_blob_id: newBlob.id,
      encoding: 'utf-8',
      bom: false,
      newline: 'lf',
      added_lines: 1,
      removed_lines: 1,
    };
    const change = runtime.repos.changes.create({
      id: newLocalId('chg'),
      owner_connection_id: ADAPTER_CONNECTION_ID,
      workspace_id: workspace.id,
      root_generation: workspace.generation,
      policy_version: POLICY_VERSION,
      contract_version: CONTRACT_VERSION,
      digest,
      summary: 'Disposable LWB-037 export acceptance fixture',
      expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      items: [item],
    });
    runtime.repos.changes.transition(change.id, ['PENDING_APPROVAL'], 'RECOVERY_REQUIRED');
    const created = runtime.repos.operations.create({ id: newLocalId('op'), change_id: change.id });
    runtime.repos.operations.transition(created.operation.id, ['QUEUED'], 'RECOVERY_REQUIRED');

    const inspection = await runtime.recovery.inspect(created.operation.id);
    if (inspection?.items[0]?.verdict.kind !== 'THIRD_CONTENT') {
      throw new Error('临时夹具未被恢复服务判定为第三方修改；拒绝提供不可靠的验收数据。');
    }

    process.stdout.write('\nLWB-037 一次性快照导出验收环境已就绪。\n');
    process.stdout.write(`临时操作：${created.operation.id}\n`);
    process.stdout.write(`临时工作区：${workspaceRoot}\n`);
    process.stdout.write('请打开上方 daemon 启动摘要中的完整控制台地址；令牌只在本机终端出现，勿复制到聊天或截图。\n');
    process.stdout.write('页面打开后进入“恢复与冲突”，应看到 THIRD_CONTENT；导出后按 UI 显示的 SHA-256 核对文件。按 Ctrl+C 会关闭 daemon 并删除整个临时验收目录。\n\n');
    await signalPromise;
  } finally {
    try {
      await runtime?.shutdown();
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`LWB-037 浏览器验收夹具失败：${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
