import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { BridgeError } from '@lwb/contracts';
import { OperationRegistry, type RequestContext } from '@lwb/ipc';
import { closeDatabase, openDatabase, Repositories, type OpenDatabaseResult } from '@lwb/persistence';
import {
  MODEL_WORKSPACE_CAPABILITIES,
  registerWorkspaceAccessOperations,
} from '../../apps/daemon/src/control/workspace-access.ts';

const CONNECTION_ID = 'conn-chatgpt-web';
const WORKSPACE_ID = 'ws_access_test';
const openedDatabases: OpenDatabaseResult[] = [];

after(() => {
  for (const opened of openedDatabases) closeDatabase(opened.db);
});

function setup(
  mode: 'read_only' | 'read_propose_apply_with_local_approval' = 'read_only',
  kind: 'directory' | 'file' = 'directory',
) {
  const opened = openDatabase({ path: ':memory:' });
  openedDatabases.push(opened);
  const repos = new Repositories(opened.db);
  repos.connections.create({
    id: CONNECTION_ID,
    principal_kind: 'model_surface',
    principal_id: 'chatgpt-web',
    alias: 'ChatGPT 网页（MCP 隧道）',
    enabled: true,
  });
  repos.workspaces.create({
    id: WORKSPACE_ID,
    alias: '仅测试目录',
    kind,
    canonical_root: 'D:\\test\\project',
    volume_id: 'volume-test',
    root_file_id: 'file-test',
    policy_version: 1,
    mode,
  });
  const operations = new OperationRegistry();
  registerWorkspaceAccessOperations(operations, { repos, model_connection_id: CONNECTION_ID });
  return { repos, operations };
}

function context(audience: 'console' | 'mcp-adapter'): RequestContext {
  return { audience, connection_id: 'console:test', pid: process.pid, request_id: 'req:test' };
}

function operation(operations: OperationRegistry, name: string) {
  const found = operations.lookup(name);
  assert.ok(found, `${name} operation should be registered`);
  return found;
}

async function expectBridgeCode(fn: () => unknown, code: string): Promise<void> {
  try {
    await fn();
  } catch (cause) {
    assert.ok(cause instanceof BridgeError);
    assert.equal(cause.code, code);
    return;
  }
  assert.fail(`expected BridgeError ${code}`);
}

describe('逐工作区 ChatGPT 工具授权', () => {
  it('本地控制台能读取与替换授权；空授权会从 ChatGPT 的工作区列表撤下', async () => {
    const { repos, operations } = setup('read_propose_apply_with_local_approval');
    const list = operation(operations, 'workspaces.access.list');
    const set = operation(operations, 'workspaces.access.set');
    assert.deepEqual(await list.handler({}, context('console')), []);

    const saved = await set.handler(
      { workspace_id: WORKSPACE_ID, capabilities: ['search', 'read', 'list'] },
      context('console'),
    ) as { readonly workspace_id: string; readonly enabled: boolean; readonly capabilities: readonly string[] };
    assert.equal(saved.workspace_id, WORKSPACE_ID);
    assert.equal(saved.enabled, true);
    assert.deepEqual(saved.capabilities, ['read', 'list', 'search']);
    assert.equal(repos.grants.hasCapability(CONNECTION_ID, WORKSPACE_ID, 'read'), true);
    assert.equal(repos.grants.hasCapability(CONNECTION_ID, WORKSPACE_ID, 'git_read'), false);
    assert.equal(repos.audit.list().at(-1)?.action, 'workspace.access.set');

    const revoked = await set.handler(
      { workspace_id: WORKSPACE_ID, capabilities: [] },
      context('console'),
    ) as { readonly enabled: boolean; readonly capabilities: readonly string[] };
    assert.equal(revoked.enabled, false);
    assert.deepEqual(revoked.capabilities, []);
    assert.equal(repos.grants.hasCapability(CONNECTION_ID, WORKSPACE_ID, 'read'), false);
    assert.deepEqual(await list.handler({}, context('console')), [revoked]);
  });

  it('能力闭集只允许模型 MCP 权限，拒绝重复项和控制/应用能力', async () => {
    const { operations } = setup('read_propose_apply_with_local_approval');
    const set = operation(operations, 'workspaces.access.set');
    assert.deepEqual(MODEL_WORKSPACE_CAPABILITIES, ['read', 'list', 'search', 'git_read', 'propose', 'command_exec']);
    for (const capabilities of [
      ['apply'],
      ['control'],
      ['mystery'],
      ['read', 'read'],
      'read',
    ]) {
      await expectBridgeCode(
        () => set.handler({ workspace_id: WORKSPACE_ID, capabilities }, context('console')),
        'INVALID_ARGUMENT',
      );
    }
  });

  it('只读或单文件工作区不能获授命令执行，已移除工作区也不能重新授权', async () => {
    const { repos, operations } = setup();
    const set = operation(operations, 'workspaces.access.set');
    await expectBridgeCode(
      () => set.handler({ workspace_id: WORKSPACE_ID, capabilities: ['propose'] }, context('console')),
      'INVALID_ARGUMENT',
    );
    await expectBridgeCode(
      () => set.handler({ workspace_id: WORKSPACE_ID, capabilities: ['command_exec'] }, context('console')),
      'INVALID_ARGUMENT',
    );
    repos.workspaces.markRemoved(WORKSPACE_ID);
    await expectBridgeCode(
      () => set.handler({ workspace_id: WORKSPACE_ID, capabilities: ['read'] }, context('console')),
      'WORKSPACE_NOT_GRANTED',
    );

    const singleFile = setup('read_propose_apply_with_local_approval', 'file');
    await expectBridgeCode(
      () => operation(singleFile.operations, 'workspaces.access.set').handler(
        { workspace_id: WORKSPACE_ID, capabilities: ['command_exec'] },
        context('console'),
      ),
      'INVALID_ARGUMENT',
    );
  });

  it('可写目录可单独授予 command_exec 而不授予文件读取', async () => {
    const { repos, operations } = setup('read_propose_apply_with_local_approval');
    const result = await operation(operations, 'workspaces.access.set').handler(
      { workspace_id: WORKSPACE_ID, capabilities: ['command_exec'] },
      context('console'),
    ) as { readonly capabilities: readonly string[] };
    assert.deepEqual(result.capabilities, ['command_exec']);
    assert.equal(repos.grants.hasCapability(CONNECTION_ID, WORKSPACE_ID, 'read'), false);
    assert.equal(repos.grants.hasCapability(CONNECTION_ID, WORKSPACE_ID, 'command_exec'), true);
  });

  it('MCP 适配器即使直接调用控制 handler 也无权读取或修改授权', async () => {
    const { operations } = setup();
    for (const name of ['workspaces.access.list', 'workspaces.access.set']) {
      const op = operation(operations, name);
      await expectBridgeCode(
        () => op.handler({ workspace_id: WORKSPACE_ID, capabilities: ['read'] }, context('mcp-adapter')),
        'NOT_AUTHORIZED',
      );
    }
  });
});
