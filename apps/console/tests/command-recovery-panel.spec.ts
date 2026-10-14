import { describe, it, assert, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import type { ControlClient } from '../src/auth/client.ts';
import CommandRecoveryPanel from '../views/CommandRecoveryPanel.vue';
const id = 'job_00000000-0000-0000-0000-000000000001';
function harness(fail = false) {
  let restored = false;
  const get = vi.fn(async () => ({jobs:[{
    job_id:id,state:restored?'RECOVERED_UNKNOWN':'TERMINATION_UNKNOWN',
    updated_at:'2026-10-14T00:00:00.000Z',created_at:'2026-10-13T00:00:00.000Z',
    workspace_name:'test-workspace',connection_alias:'test-connection',slot_held:!restored,
  }],truncated:false}));
  const authorizeMutation = vi.fn(async (_path:string,subject:string,body:Record<string,unknown>) => ({...body,subject,nonce:'test-single-use'}));
  const call = vi.fn(async () => {if(fail)throw new Error('injected');restored=true;return {};});
  return {client:{get,call,authorizeMutation} as unknown as ControlClient,get,call,authorizeMutation};
}
describe('CommandRecoveryPanel', () => {
  it('requires both actual operator attestation and an exact typed job id before submitting', async () => {
    const h=harness(); const wrapper=mount(CommandRecoveryPanel,{props:{client:h.client,sessionActive:true}});
    try {
      await flushPromises();
      const submit=wrapper.find('fieldset button');
      assert.equal(submit.attributes('disabled'),'');
      await wrapper.find('input[type="checkbox"]').setValue(true);
      await wrapper.find('input:not([type="checkbox"])').setValue('wrong');
      assert.equal(submit.attributes('disabled'),''); assert.equal(h.call.mock.calls.length,0);
      await wrapper.find('input:not([type="checkbox"])').setValue(id);
      assert.equal(submit.attributes('disabled'),undefined);
      await submit.trigger('click'); await flushPromises();
      assert.equal(h.call.mock.calls.length,1); assert.equal(h.authorizeMutation.mock.calls.length,1);
      assert.deepEqual(h.authorizeMutation.mock.calls[0],[
        '/api/commands/recover',id,{
          job_id:id,expected_updated_at:'2026-10-14T00:00:00.000Z',confirmation_job_id:id,
          verified_all_processes_stopped:true,basis:'process_tree_checked',
        },
      ]);
      assert.match(wrapper.find('[role="status"]').text(),/业务结果仍未知/);
      assert.equal(wrapper.find('fieldset').exists(),false);
      assert.equal(h.get.mock.calls.length,2);
    } finally {wrapper.unmount();}
  });
  it('does not display success or retry when recovery delivery fails', async () => {
    const h=harness(true);const wrapper=mount(CommandRecoveryPanel,{props:{client:h.client,sessionActive:true}});
    try {
      await flushPromises();await wrapper.find('input[type="checkbox"]').setValue(true);
      await wrapper.find('input:not([type="checkbox"])').setValue(id);
      await wrapper.find('fieldset button').trigger('click');await flushPromises();
      assert.match(wrapper.find('[role="alert"]').text(),/刷新核对/);
      assert.equal(wrapper.find('[role="status"]').exists(),false);
      assert.equal(h.call.mock.calls.length,1);
      assert.equal(wrapper.find('fieldset button').attributes('disabled'),'');
      assert.equal((wrapper.find('input[type="checkbox"]').element as HTMLInputElement).checked,false);
    } finally {wrapper.unmount();}
  });
  it('logout removes selectable tasks and prevents any mutation', async () => {
    const h=harness();const wrapper=mount(CommandRecoveryPanel,{props:{client:h.client,sessionActive:true}});
    try {
      await flushPromises();await wrapper.setProps({sessionActive:false});await flushPromises();
      assert.equal(wrapper.find('fieldset').exists(),false);assert.equal(h.call.mock.calls.length,0);
      assert.match(wrapper.text(),/先建立本地控制台会话/);
    } finally {wrapper.unmount();}
  });
  it('failed list fetch is an error, not a claim that no quarantines exist', async () => {
    const h=harness();h.get.mockRejectedValueOnce(new Error('offline'));
    const wrapper=mount(CommandRecoveryPanel,{props:{client:h.client,sessionActive:true}});
    try {
      await flushPromises();assert.match(wrapper.find('[role="alert"]').text(),/读取失败/);
      assert.notMatch(wrapper.text(),/没有查到待处理/);assert.equal(h.call.mock.calls.length,0);
    } finally {wrapper.unmount();}
  });
});
