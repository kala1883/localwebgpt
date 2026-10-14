import assert from 'node:assert/strict';
import {test} from 'node:test';
import {ControlRouteTable,type ControlRouteContext} from '../../apps/daemon/src/control/routes.ts';
import {bindConversationManagement,registerConversationManagementRoutes} from '../../apps/daemon/src/control/conversation-management.ts';
import {OperationRegistry,hasCapability} from '@lwb/ipc';
import type {Repositories} from '@lwb/persistence';
import type {CommandJobManager} from '../../apps/daemon/src/lifecycle/command-jobs.ts';
const id='conversation_00000000-0000-4000-8000-000000000001';
function fixture(){
  let updates=0;
  const manager={update:()=>{updates++;return{};},list:()=>({items:[]}),get:()=>({id}),settings:()=>({revision:0}),statistics:()=>({}),items:()=>({items:[]})};
  const repos={conversation_management:manager,conversation_archive:{status:()=>({})},connections:{list:()=>[]},workspaces:{list:()=>[]}} as unknown as Repositories;
  const registry=new OperationRegistry(),table=new ControlRouteTable();
  bindConversationManagement(registry,repos,{} as CommandJobManager);registerConversationManagementRoutes(table,registry);
  return {registry,table,updates:()=>updates};
}
const context=(body:Record<string,unknown>):ControlRouteContext=>({body,operation:'/api/conversations/update',request_id:'req_unit',session:{session_id:'local'} as ControlRouteContext['session']});
test('management exposes fixed local routes, not MCP operations',()=>{const h=fixture();assert.equal(h.table.routes().length,13);assert.deepEqual(h.registry.names(),[]);for(const r of h.table.routes()){assert.ok(r.capability);assert.equal(hasCapability('mcp-adapter',r.capability!),false);}});
test('all state-changing session routes require mutating nonce protection',()=>{const h=fixture();for(const name of ['update','settings','clear','retention-apply','cancel-job'])assert.equal(h.table.lookup('POST','/api/conversations/'+name)?.mutating,true);});
test('an update cannot inject owner identity or a mismatched subject',()=>{const h=fixture(),handler=h.table.lookup('POST','/api/conversations/update')!.handler;const body={conversation_id:id,expected_revision:0,local_title:'name',tags:[],notes:'',pinned:false,archived:false,nonce:'bound',subject:id};assert.throws(()=>handler(context({...body,principal_id:'forged'})),{code:'INVALID_ARGUMENT'});assert.throws(()=>handler(context({...body,subject:'another'})),{code:'INVALID_ARGUMENT'});assert.throws(()=>handler(context({...body,nonce:undefined})),{code:'INVALID_ARGUMENT'});assert.equal(h.updates(),0);});
test('validated updates retain a bound local target',()=>{const h=fixture();h.table.lookup('POST','/api/conversations/update')!.handler(context({conversation_id:id,expected_revision:0,local_title:'name',tags:[],notes:'',pinned:false,archived:false,subject:id,nonce:'consumed-by-control-server'}));assert.equal(h.updates(),1);});
test('unbound embedded control planes get no accidental session management endpoints',()=>{const table=new ControlRouteTable();registerConversationManagementRoutes(table,new OperationRegistry());assert.equal(table.routes().length,0);});
