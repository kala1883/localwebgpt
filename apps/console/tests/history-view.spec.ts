import { describe, it, assert } from 'vitest';
import { mount } from '@vue/test-utils';
import HistoryView from '../views/HistoryView.vue';
import type { HistoryData } from '../src/history/index.ts';

const DATA: HistoryData = {
  observed_at: '2026-09-27T00:00:00.000Z',
  operations: [
    {
      operation_id: 'op_recovery',
      change_id: 'chg_1',
      workspace_id: 'ws_1',
      operation_state: 'RECOVERY_REQUIRED',
      change_state: 'RECOVERY_REQUIRED',
      recovered: false,
      created_at: '2026-09-27T00:00:00.000Z',
      started_at: '2026-09-27T00:00:00.000Z',
      finished_at: null,
    },
    {
      operation_id: 'op_done',
      change_id: 'chg_2',
      workspace_id: 'ws_1',
      operation_state: 'ROLLED_BACK',
      change_state: 'ROLLED_BACK',
      recovered: true,
      created_at: '2026-09-26T00:00:00.000Z',
      started_at: '2026-09-26T00:00:00.000Z',
      finished_at: '2026-09-26T00:01:00.000Z',
    },
  ],
  audit: [{ id: 7, subject: 'op_recovery', action: 'recovery.keep_current', outcome: 'allow', error_code: null, timestamp: '2026-09-27T00:00:01.000Z' }],
};

describe('LWB-037 HistoryView', () => {
  it('显示数据库回报的进行中/终态，并标出终态行', () => {
    const wrapper = mount(HistoryView, { props: { data: DATA } });
    const rows = wrapper.findAll('[data-testid="operation-row"]');
    assert.equal(rows.length, 2);
    assert.equal(rows[0]?.attributes('data-terminal'), 'false');
    assert.equal(rows[1]?.attributes('data-terminal'), 'true');
    assert.match(rows[1]?.text() ?? '', /已回滚/);
  });

  it('待恢复操作提供打开恢复入口，并传递真实 operation_id', async () => {
    const wrapper = mount(HistoryView, { props: { data: DATA } });
    await wrapper.find('[data-testid="open-recovery"]').trigger('click');
    assert.deepEqual(wrapper.emitted('open-recovery')?.[0]?.[0], { operation_id: 'op_recovery' });
  });

  it('审计表显示结果和错误码，不以按钮点击冒充终态', () => {
    const wrapper = mount(HistoryView, { props: { data: DATA } });
    assert.equal(wrapper.findAll('[data-testid="audit-row"]').length, 1);
    assert.match(wrapper.find('[data-testid="audit-row"]').text(), /允许/);
    assert.equal(wrapper.find('[data-testid="operation-row"]').text().includes('已完成'), false);
  });

  it('读取中禁用刷新，错误仍以警告呈现', () => {
    const wrapper = mount(HistoryView, { props: { data: null, loading: true, error: '本地服务不可用。' } });
    assert.equal(wrapper.find('[data-testid="refresh-history"]').attributes('disabled'), '');
    assert.equal(wrapper.find('[data-testid="history-error"]').text(), '本地服务不可用。');
  });

  it('空历史也明确说明是空，而不是把读取失败伪装成空', () => {
    const wrapper = mount(HistoryView, {
      props: {
        data: { observed_at: 'now', operations: [], audit: [] },
      },
    });
    assert.equal(wrapper.find('[data-testid="no-operations"]').exists(), true);
    assert.equal(wrapper.find('[data-testid="no-audit"]').exists(), true);
    assert.equal(wrapper.find('[data-testid="history-empty"]').exists(), false);
  });
});

