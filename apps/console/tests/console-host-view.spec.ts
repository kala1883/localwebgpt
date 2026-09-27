import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import type { ControlClient } from '../src/auth/client.ts';
import ConsoleHostView from '../views/ConsoleHostView.vue';

describe('ConsoleHost 工作区授权接线', () => {
  it('从 12747 控制台主页读取工作区/授权，并以绑定 nonce 的变更保存权限', async () => {
    const calls: { readonly path: string; readonly body: Record<string, unknown> }[] = [];
    const authorized: { readonly path: string; readonly subject: string; readonly body: Record<string, unknown> }[] = [];
    let accessRows: readonly Record<string, unknown>[] = [];
    const client = {
      session: { session_id: 'sess_test', csrf_token: 'csrf_test' },
      async call(path: string, body: Record<string, unknown> = {}) {
        calls.push({ path, body });
        if (path === '/api/recovery/list') return { records: [], observed_at: '2026-09-27T00:00:00.000Z' };
        if (path === '/api/workspaces/list') {
          return [{
            workspace_id: 'ws_local', alias: '测试仓库', kind: 'directory', mode: 'read_only',
            root: 'D:\\Projects\\test-repo', generation: 1, policy_version: 1, enabled: true, removed: false,
          }];
        }
        if (path === '/api/workspaces/access/list') return accessRows;
        if (path === '/api/connections/list') {
          return { connections: [{ connection_id: 'conn-chatgpt-web', alias: 'ChatGPT 网页', principal_kind: 'model_surface', enabled: true, generation: 1 }] };
        }
        if (path === '/api/workspaces/access/set') {
          const capabilities = Array.isArray(body['capabilities']) ? body['capabilities'] : [];
          accessRows = capabilities.length === 0
            ? []
            : [{ workspace_id: body['workspace_id'], enabled: true, capabilities }];
          return accessRows[0] ?? { workspace_id: body['workspace_id'], enabled: false, capabilities: [] };
        }
        return { ok: true };
      },
      async get(path: string) {
        calls.push({ path, body: {} });
        assert.equal(path, '/api/status');
        return {
          version: '0.1.0', protocol_version: '1',
          gates: {
            g0_platform_verified: false, native_guard_verified: false,
            compatibility_section3_passed: false, g4_concurrency_fault_passed: false,
          },
          capability_flags: {
            read_enabled: false, git_enabled: false, proposal_enabled: false,
            direct_write_enabled: false, recovery_required: false,
          },
          limitations: [], machine: { hostname: 'LOCAL', os: 'Windows', arch: 'x64' },
          workspaces: 1, connections: 1, routes: [],
        };
      },
      async authorizeMutation(path: string, subject: string, body: Record<string, unknown>) {
        authorized.push({ path, subject, body });
        return { ...body, subject, nonce: 'nonce_test' };
      },
      async logout() {},
    } as unknown as ControlClient;

    const wrapper = mount(ConsoleHostView, { props: { client, startupMessage: null } });
    await flushPromises();
    const workspaceNav = wrapper.findAll('button').find((button) => button.text() === '工作区与工具授权');
    assert.ok(workspaceNav);
    await workspaceNav.trigger('click');
    await flushPromises();

    assert.equal(wrapper.find('[data-testid="ws-root"]').text(), 'D:\\Projects\\test-repo');
    assert.match(wrapper.find('[data-testid="exposure-headline"]').text(), /没有根同时满足/);
    await wrapper.find('[data-testid="configure-access-ws_local"]').trigger('click');
    await wrapper.find('[data-testid="access-ws_local-list"]').setValue(true);
    await wrapper.find('[data-testid="save-access-ws_local"]').trigger('click');
    await flushPromises();

    assert.deepEqual(authorized.at(-1), {
      path: '/api/workspaces/access/set',
      subject: 'ws_local',
      body: { workspace_id: 'ws_local', capabilities: ['list'] },
    });
    assert.ok(calls.some((entry) => entry.path === '/api/workspaces/access/set' && entry.body['nonce'] === 'nonce_test'));
    assert.ok(calls.some((entry) => entry.path === '/api/status'));
    assert.match(wrapper.find('[data-testid="access-summary"]').text(), /已保存授权.*列出目录\/文件名/);
  });
});
