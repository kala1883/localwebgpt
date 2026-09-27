import { describe, it, assert, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import type { ControlClient } from '../src/auth/client.ts';
import ConnectionView from '../views/ConnectionView.vue';

const CONNECTION_ID = 'conn-chatgpt-web';

function harness(initiallyEnabled = false) {
  let enabled = initiallyEnabled;
  const call = vi.fn(async (path: string) => {
    if (path === '/api/connections/list') {
      return {
        connections: [{
          connection_id: CONNECTION_ID,
          alias: 'ChatGPT 网页（MCP 隧道）',
          principal_kind: 'model_surface',
          enabled,
          generation: 1,
        }],
      };
    }
    if (path === '/api/connections/resume') enabled = true;
    if (path === '/api/connections/pause') enabled = false;
    return {};
  });
  const authorizeMutation = vi.fn(async (_path: string, _subject: string, body: Record<string, unknown>) => ({
    ...body,
    subject: _subject,
    nonce: 'nonce_once',
  }));
  const client = {
    session: { session_id: 'session_1' },
    call,
    authorizeMutation,
  } as unknown as ControlClient;
  return { client, call, authorizeMutation };
}

describe('ConnectionView', () => {
  it('requires an explicit local confirmation before resuming the model connection', async () => {
    const setup = harness(false);
    const wrapper = mount(ConnectionView, { props: { client: setup.client, sessionActive: true } });
    await flushPromises();

    const enable = wrapper.find(`[data-testid="enable-${CONNECTION_ID}"]`);
    assert.equal(enable.attributes('disabled'), '');
    assert.match(wrapper.find('[data-testid="connection-safety-note"]').text(), /工作区.*登记要访问的目录.*文件修改工具/);
    assert.equal(setup.authorizeMutation.mock.calls.length, 0);

    await wrapper.find('[data-testid="connection-confirm"] input').setValue(true);
    await enable.trigger('click');
    await flushPromises();

    assert.deepEqual(setup.authorizeMutation.mock.calls[0], [
      '/api/connections/resume',
      CONNECTION_ID,
      { connection_id: CONNECTION_ID },
    ]);
    assert.equal(setup.call.mock.calls.some(([path]) => path === '/api/connections/resume'), true);
    assert.equal(wrapper.find(`[data-testid="pause-${CONNECTION_ID}"]`).exists(), true);
    assert.match(wrapper.find('[role="status"]').text(), /本机启用/);
  });

  it('can locally pause an enabled model connection', async () => {
    const setup = harness(true);
    const wrapper = mount(ConnectionView, { props: { client: setup.client, sessionActive: true } });
    await flushPromises();
    await wrapper.find(`[data-testid="pause-${CONNECTION_ID}"]`).trigger('click');
    await flushPromises();

    assert.equal(setup.call.mock.calls.some(([path]) => path === '/api/connections/pause'), true);
    assert.equal(wrapper.find(`[data-testid="enable-${CONNECTION_ID}"]`).exists(), true);
  });
});
