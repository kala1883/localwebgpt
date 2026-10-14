/** Authenticated, local-console-only API; never published in tools/list or the archived dispatcher. */
import { z } from 'zod';
import { BridgeError } from '@lwb/contracts';
import type { OperationRegistry } from '@lwb/ipc';
import type { Repositories } from '@lwb/persistence';
import type { CommandJobManager } from '../lifecycle/command-jobs.ts';
import { CommandJobFailure } from '../lifecycle/command-job-store.ts';
import { ConversationManagementError } from '../../../../packages/persistence/src/conversation-management.ts';
import {
  conversationId,sessionListInput,sessionItemsInput,sessionUpdateInput,settingsUpdateInput,
  CONVERSATION_MANAGEMENT_VERSION,
} from '../../../../packages/contracts/src/conversation-management.ts';
import type { ControlRouteTable,ControlRouteContext } from './routes.ts';

const bindings=new WeakMap<OperationRegistry,{repos:Repositories;jobs:CommandJobManager}>();
export function bindConversationManagement(registry:OperationRegistry,repos:Repositories,jobs:CommandJobManager):void {
  if(bindings.has(registry))throw new Error('Conversation management already bound.');
  bindings.set(registry,{repos,jobs});
}
const idInput=z.strictObject({conversation_id:conversationId});
const exportInput=z.strictObject({cursor:z.string().min(1).max(4096)});
const clearInput=z.strictObject({conversation_id:conversationId,expected_digest:z.string().regex(/^[a-f0-9]{64}$/),confirmation_id:conversationId,confirmed:z.literal(true)});
const pruneInput=z.strictObject({expected_digest:z.string().regex(/^[a-f0-9]{64}$/),confirmed:z.literal(true)});
const cancelInput=z.strictObject({conversation_id:conversationId,job_id:z.string().regex(/^job_[a-f0-9-]{36}$/),confirmed:z.literal(true)});
function mutationBody(body:Record<string,unknown>,subject:string):Record<string,unknown> {
  const {subject:bound,nonce:nonce,...rest}=body;
  if(bound!==subject||typeof nonce!=='string'||!nonce)throw new BridgeError('INVALID_ARGUMENT','变更必须携带与目标一致的本地一次性授权。');
  return rest;
}
function parse<T>(schema:z.ZodType<T>,value:unknown):T {
  const result=schema.safeParse(value);if(!result.success)throw new BridgeError('INVALID_ARGUMENT','会话管理请求格式无效。');return result.data;
}
function errorBoundary(handler:(ctx:ControlRouteContext)=>unknown):(ctx:ControlRouteContext)=>unknown {
  return ctx=>{
    try{return handler(ctx);}catch(error){
      if(error instanceof BridgeError)throw error;
      if(error instanceof CommandJobFailure)throw new BridgeError(error.code,error.message);
      if(error instanceof ConversationManagementError){
        const codes={INVALID:'INVALID_ARGUMENT',NOT_FOUND:'NOT_FOUND',CONFLICT:'IDEMPOTENCY_CONFLICT',BUSY:'POLICY_DENIED',UNAVAILABLE:'STORAGE_UNAVAILABLE'} as const;
        throw new BridgeError(codes[error.code],error.message);
      }
      // Driver exception text can contain database paths. It does not belong in the API response.
      throw new BridgeError('STORAGE_UNAVAILABLE','会话归档暂时不可用；请检查数据库迁移和本地日志，不要重跑业务命令。');
    }
  };
}
export function registerConversationManagementRoutes(table:ControlRouteTable,registry:OperationRegistry):void {
  const binding=bindings.get(registry);if(!binding)return;
  const {repos,jobs}=binding,manager=repos.conversation_management;
  const add=(path:string,mutating:boolean,handler:(ctx:ControlRouteContext)=>unknown,method:'GET'|'POST'='POST')=>table.register({
    method,path:'/api/conversations/'+path,capability:mutating?'approvals.decide':'changes.read',mutating,handler:errorBoundary(handler),
  });
  add('status',false,()=>({
    feature_version:CONVERSATION_MANAGEMENT_VERSION,schema_version:11,settings:manager.settings(),statistics:manager.statistics(),
    archive_health:{...repos.conversation_archive.status(),health_scope:'live_daemon_repository'},
    connections:repos.connections.list().map(c=>({id:c.id,label:c.alias})),
    workspaces:repos.workspaces.list().map(w=>({id:w.id,label:w.alias})),
  }),'GET');
  add('list',false,({body})=>manager.list(parse(sessionListInput,body)));
  add('get',false,({body})=>manager.get(parse(idInput,body).conversation_id));
  add('items',false,({body})=>manager.items(parse(sessionItemsInput,body)));
  add('update',true,({body,session})=>{
    const id=parse(conversationId,body.conversation_id);
    return manager.update(parse(sessionUpdateInput,mutationBody(body,id)),'console:'+session.session_id);
  });
  add('settings',true,({body,session})=>manager.configure(parse(settingsUpdateInput,mutationBody(body,'archive-settings')),'console:'+session.session_id));
  add('clear-preview',false,({body})=>manager.clearPreview(parse(idInput,body).conversation_id));
  add('clear',true,({body,session})=>{
    const id=parse(conversationId,body.conversation_id),input=parse(clearInput,mutationBody(body,id));
    return manager.clear(id,input.expected_digest,input.confirmation_id,'console:'+session.session_id);
  });
  add('retention-preview',false,({body})=>{parse(z.strictObject({}),body);return manager.retentionPreview();});
  add('retention-apply',true,({body,session})=>{
    const input=parse(pruneInput,mutationBody(body,'archive-retention'));
    return manager.prune(input.expected_digest,'console:'+session.session_id);
  });
  add('export-start',false,({body})=>manager.exportStart(parse(idInput,body).conversation_id));
  add('export-page',false,({body})=>manager.exportPage(parse(exportInput,body).cursor));
  add('cancel-job',true,({body,session})=>{
    const jobId=parse(z.string().regex(/^job_[a-f0-9-]{36}$/),body.job_id);
    const input=parse(cancelInput,mutationBody(body,jobId));
    if(!manager.jobBelongs(input.conversation_id,input.job_id))throw new BridgeError('NOT_FOUND','任务不属于所选会话。');
    const record=jobs.localRecords().find(j=>j.job_id===input.job_id);
    if(!record)throw new BridgeError('NOT_FOUND','当前执行管理器中没有找到此任务。');
    // Local operator cancellation is independent of the model's command capacity.
    // CANCELLING and TERMINATION_UNKNOWN are returned honestly, never reported as stopped.
    const job=jobs.cancel(record.owner,record.job_id);
    manager.recordCancellation(input.conversation_id,input.job_id,job.state,'console:'+session.session_id);
    return {job,requested_by:'local_console'};
  });
}
