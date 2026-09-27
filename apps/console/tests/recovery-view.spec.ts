import { describe, it, assert } from 'vitest';
import { mount } from '@vue/test-utils';
import RecoveryView from '../views/RecoveryView.vue';
import type { RecoveryRecord } from '../src/recovery/index.ts';

const SESSION = { authenticated: true } as const;

function recordOf(overrides: Partial<RecoveryRecord> = {}): RecoveryRecord {
  return {
    operation_id: 'op_1',
    change_id: 'chg_1',
    workspace_id: 'ws_1',
    operation_state: 'RECOVERY_REQUIRED',
    change_state: 'RECOVERY_REQUIRED',
    recovered: false,
    observed_at: '2026-09-27T00:00:00.000Z',
    plan_digest: 'd'.repeat(64),
    plan: {
      kind: 'ok',
      action: 'ROLLBACK_TO_BASELINE',
      digest: 'd'.repeat(64),
      targets: ['src/app.ts'],
    },
    items: [
      {
        item_id: 'item_1',
        path: 'src/app.ts',
        op: 'edit_text',
        original_sha256: 'a'.repeat(64),
        proposed_sha256: 'b'.repeat(64),
        current_sha256: 'c'.repeat(64),
        current_state: 'THIRD_CONTENT',
        reason: 'REPLACED_OBJECT',
        error_code: null,
        updated_at: '2026-09-27T00:00:00.000Z',
      },
      {
        item_id: 'item_2',
        path: 'README.md',
        op: 'edit_text',
        original_sha256: 'e'.repeat(64),
        proposed_sha256: 'f'.repeat(64),
        current_sha256: 'f'.repeat(64),
        current_state: 'TARGET_REACHED',
        reason: null,
        error_code: null,
        updated_at: '2026-09-27T00:00:00.000Z',
      },
    ],
    authorizations: [],
    journal: [{ seq: 1, item_id: 'item_1', stage: 'write_recovery_required', error_code: null, detail: 'kept' }],
    ...overrides,
  };
}

describe('LWB-037 RecoveryView', () => {
  it('空记录时不显示任何恢复动作', () => {
    const wrapper = mount(RecoveryView, { props: { record: null, session: SESSION } });
    assert.equal(wrapper.find('[data-testid="recovery-empty"]').exists(), true);
    assert.equal(wrapper.find('[data-testid="authorize-recovery"]').exists(), false);
  });

  it('同时显示原版本、提议版本和当前第三方版本', () => {
    const wrapper = mount(RecoveryView, { props: { record: recordOf(), session: SESSION } });
    assert.equal(wrapper.findAll('[data-testid="recovery-item"]').length, 2);
    assert.equal(wrapper.find('[data-testid="original-version"]').text(), 'a'.repeat(64));
    assert.equal(wrapper.find('[data-testid="proposed-version"]').text(), 'b'.repeat(64));
    assert.match(wrapper.find('[data-testid="current-version"]').text(), /第三方后续修改/);
    assert.equal(wrapper.find('[data-testid="current-version"]').attributes('data-current-state'), 'THIRD_CONTENT');
  });

  it('保留当前文件只发意图，不从页面上清除恢复记录', async () => {
    const wrapper = mount(RecoveryView, { props: { record: recordOf(), session: SESSION } });
    await wrapper.find('[data-testid="item-actions"] button').trigger('click');
    assert.deepEqual(wrapper.emitted('keep-current')?.[0]?.[0], { operation_id: 'op_1', item_id: 'item_1' });
    assert.equal(wrapper.find('[data-testid="recovery-summary"]').exists(), true);
  });

  it('导出按钮默认关闭，显式确认后才发出受保护快照意图', async () => {
    const wrapper = mount(RecoveryView, { props: { record: recordOf(), session: SESSION } });
    const exportButton = wrapper.find('[data-testid="export-original"]');
    assert.equal(exportButton.attributes('disabled'), '');
    await wrapper.find('[data-testid="export-confirm"] input').setValue(true);
    assert.equal(exportButton.attributes('disabled'), undefined);
    await exportButton.trigger('click');
    assert.deepEqual(wrapper.emitted('export-snapshot')?.[0]?.[0], {
      operation_id: 'op_1',
      item_id: 'item_1',
      snapshot: 'original',
      confirmed: true,
    });
  });

  it('恢复授权默认关闭，确认后才可以签发一次性授权', async () => {
    const wrapper = mount(RecoveryView, { props: { record: recordOf(), session: SESSION } });
    const button = wrapper.find('[data-testid="authorize-recovery"]');
    assert.equal(button.attributes('disabled'), '');
    await wrapper.find('[data-testid="repair-confirm"] input').setValue(true);
    assert.equal(button.attributes('disabled'), undefined);
    await button.trigger('click');
    assert.deepEqual(wrapper.emitted('authorize-recovery')?.[0]?.[0], {
      operation_id: 'op_1',
      plan_digest: 'd'.repeat(64),
      confirmed: true,
    });
  });

  it('已有有效授权时显示执行按钮，并绑定服务端给出的授权 id', async () => {
    const wrapper = mount(RecoveryView, {
      props: {
        record: recordOf({
          authorizations: [{
            id: 'auth_1', decision: 'ROLLBACK_TO_BASELINE', state: 'ACTIVE', actor: 'console:s1',
            digest: 'd'.repeat(64), expires_at: '2026-09-27T00:10:00.000Z', consumed_at: null,
            created_at: '2026-09-27T00:00:00.000Z',
          }],
        }),
        session: SESSION,
      },
    });
    assert.equal(wrapper.find('[data-testid="repair-recovery"]').exists(), true);
    await wrapper.find('[data-testid="repair-confirm"] input').setValue(true);
    await wrapper.find('[data-testid="repair-recovery"]').trigger('click');
    assert.deepEqual(wrapper.emitted('repair-recovery')?.[0]?.[0], {
      operation_id: 'op_1',
      authorization_id: 'auth_1',
      plan_digest: 'd'.repeat(64),
      confirmed: true,
    });
  });

  it('服务端拒绝恢复计划时不出现批准入口，但保留当前和重新提议仍可用', () => {
    const wrapper = mount(RecoveryView, {
      props: {
        record: recordOf({ plan: { kind: 'refused', reason: 'HAS_UNRESOLVED_ITEMS', detail: '有第三方内容。' } }),
        session: SESSION,
      },
    });
    assert.equal(wrapper.find('[data-testid="repair-refused"]').exists(), true);
    assert.equal(wrapper.find('[data-testid="authorize-recovery"]').exists(), false);
    assert.equal(wrapper.find('[data-testid="item-actions"] button').attributes('disabled'), undefined);
  });

  it('没有控制台会话时不发出任何本地动作', async () => {
    const wrapper = mount(RecoveryView, { props: { record: recordOf(), session: null } });
    assert.equal(wrapper.find('[data-testid="authorize-recovery"]').attributes('disabled'), '');
    await wrapper.find('[data-testid="refresh-recovery"]').trigger('click');
    assert.equal(wrapper.emitted('refresh')?.length, 1);
    assert.equal(wrapper.emitted('keep-current'), undefined);
  });

  it('数据库账本仍在页面上展示', () => {
    const wrapper = mount(RecoveryView, { props: { record: recordOf(), session: SESSION } });
    assert.equal(wrapper.findAll('[data-testid="journal-row"]').length, 1);
    assert.match(wrapper.find('[data-testid="recovery-ledger"]').text(), /不会因为按钮点击而自行清除/);
  });
});

