import assert from 'node:assert/strict';
import {describe,it,vi} from 'vitest';
import {mount,flushPromises} from '@vue/test-utils';
import type {ControlClient} from '../src/auth/client.ts';
import ConversationsView from '../views/ConversationsView.vue';
const id='conversation_00000000-0000-4000-8000-000000000001';
const base={id,connection_id:'conn',local_title:'交通会话',title_source:'generated_local',attribution:'client_meta',created_at:'2026-10-14T00:00:00Z',last_activity_at:'2026-10-14T00:00:01Z',revision:0,tags:[],notes:'',pinned:false,archived:false,payload_generation:0,payloads_cleared_at:null,call_count:1,job_count:0,event_count:2,event_bytes:100,pending_calls:0,running_jobs:0,unknown_jobs:0,failed_calls:0};
function harness(){
  let summary={...base};
  const call=vi.fn(async(path:string,body:Record<string,unknown>={}):Promise<unknown>=>{
    if(path.endsWith('/list'))return {items:[summary],has_more:false,next_cursor:null};
    if(path.endsWith('/get'))return summary;
    if(path.endsWith('/update')){summary={...summary,local_title:String(body.local_title),revision:summary.revision+1};return summary;}
    if(path.endsWith('/items'))return {items:[{seq:1,kind:'tool_request_received',observed_at:base.created_at,payload:{message:'<img src=x onerror="alert(1)">',command:'echo test'},redacted:1,truncated:0}],has_more:false,next_cursor:null};
    if(path.endsWith('/clear-preview'))return {conversation_id:id,allowed:true,blockers:[],events:2,bytes:100,revision:0,digest:'a'.repeat(64)};
    return {};
  });
  const get=vi.fn(async()=>({feature_version:'1.0.0',schema_version:11,settings:{revision:0,retention_days:30,automatic_retention:false,updated_at:base.created_at},statistics:{conversations:1,calls:1,jobs:0,events:2,bytes:100,unassigned:0},archive_health:{runtime_fault:false,limits:{event_bytes:134217728}},connections:[{id:'conn',label:'网页连接'}],workspaces:[]}));
  const authorizeMutation=vi.fn(async(_path:string,subject:string,body:Record<string,unknown>)=>({...body,subject,nonce:'one-time'}));
  const client={session:{session_id:'test-session'},call,get,authorizeMutation} as unknown as ControlClient;
  return {client,call,get,authorizeMutation};
}
describe('ConversationsView',()=>{
  it('loads real API data, supports selecting a session and renders payloads as text',async()=>{const h=harness(),w=mount(ConversationsView,{props:{client:h.client,sessionActive:true}});try{await flushPromises();assert.match(w.text(),/交通会话/);await w.find('.cv-session').trigger('click');await flushPromises();assert.match(w.find('pre').text(),/echo test/);assert.equal(w.find('pre img').exists(),false);assert.match(w.text(),/已脱敏/);}finally{w.unmount();}});
  it('saving a title goes through the existing nonce authorization helper',async()=>{const h=harness(),w=mount(ConversationsView,{props:{client:h.client,sessionActive:true}});try{await flushPromises();await w.find('.cv-session').trigger('click');await flushPromises();await w.findAll('button').find(b=>b.text()==='编辑会话')!.trigger('click');await w.find('[data-testid="session-title-input"]').setValue('新标题');await w.find('.cv-edit').trigger('submit');await flushPromises();assert.equal(h.authorizeMutation.mock.calls[0]?.[0],'/api/conversations/update');assert.equal(h.authorizeMutation.mock.calls[0]?.[1],id);assert.match(w.text(),/新标题/);}finally{w.unmount();}});
  it('unconfirmed cleanup cannot be submitted',async()=>{const h=harness(),w=mount(ConversationsView,{props:{client:h.client,sessionActive:true}});try{await flushPromises();await w.find('.cv-session').trigger('click');await flushPromises();await w.findAll('button').find(b=>b.text()==='清理内容')!.trigger('click');await flushPromises();const button=w.findAll('button').find(b=>b.text()==='确认清理')!;assert.equal(button.attributes('disabled'),'');assert.equal(h.authorizeMutation.mock.calls.length,0);}finally{w.unmount();}});
  it('logout clears selected records and prevents further mutations',async()=>{const h=harness(),w=mount(ConversationsView,{props:{client:h.client,sessionActive:true}});try{await flushPromises();await w.find('.cv-session').trigger('click');await flushPromises();await w.setProps({sessionActive:false});assert.equal(w.find('pre').exists(),false);assert.equal(w.find('.cv-session').exists(),false);assert.equal(h.authorizeMutation.mock.calls.length,0);}finally{w.unmount();}});
  it('a late list response after logout cannot repopulate the page',async()=>{const h=harness();let finish!:(v:unknown)=>void;h.call.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve as (v:unknown)=>void;}));const w=mount(ConversationsView,{props:{client:h.client,sessionActive:true}});try{await flushPromises();await w.setProps({sessionActive:false});finish({items:[base],has_more:false,next_cursor:null});await flushPromises();assert.equal(w.find('.cv-session').exists(),false);}finally{w.unmount();}});
  it('a failed list request shows an error rather than implying successful empty retrieval',async()=>{const h=harness();h.call.mockRejectedValueOnce(new Error('列表读取失败'));const w=mount(ConversationsView,{props:{client:h.client,sessionActive:true}});try{await flushPromises();assert.match(w.find('[role="alert"]').text(),/列表读取失败/);}finally{w.unmount();}});
});
