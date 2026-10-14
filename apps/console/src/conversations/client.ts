/** Typed HTTP facade; the existing ControlClient retains cookie, CSRF and nonce ownership. */
import { z } from 'zod';
import type { ControlClient } from '../auth/client.ts';
import {
  statusSchema,sessionListSchema,sessionSummarySchema,pageSchema,settingsSchema,clearPreviewSchema,exportPageSchema,
  type SessionListInput,type SessionItemsInput,type SessionUpdateInput,
} from '../../../../packages/contracts/src/conversation-management.ts';
const prefix='/api/conversations/';
export const retentionPreviewSchema=z.object({items:z.array(clearPreviewSchema),has_more:z.boolean(),cutoff:z.string(),digest:z.string()});
export type RetentionPreview=z.infer<typeof retentionPreviewSchema>;
export class ConversationClient {
  constructor(private readonly client:Pick<ControlClient,'call'|'get'|'authorizeMutation'>) {}
  private async mutation(action:string,subject:string,body:Record<string,unknown>):Promise<unknown> {
    const path=prefix+action;return this.client.call(path,await this.client.authorizeMutation(path,subject,body));
  }
  async status(){return statusSchema.parse(await this.client.get(prefix+'status'));}
  async list(input:Partial<SessionListInput>={}){return sessionListSchema.parse(await this.client.call(prefix+'list',input));}
  async get(id:string){return sessionSummarySchema.parse(await this.client.call(prefix+'get',{conversation_id:id}));}
  async items(input:Partial<SessionItemsInput>&{conversation_id:string;kind:SessionItemsInput['kind']}){return pageSchema.parse(await this.client.call(prefix+'items',input));}
  async update(input:SessionUpdateInput){return sessionSummarySchema.parse(await this.mutation('update',input.conversation_id,input));}
  async settings(input:{expected_revision:number;retention_days:number;automatic_retention:boolean}){return settingsSchema.parse(await this.mutation('settings','archive-settings',input));}
  async clearPreview(id:string){return clearPreviewSchema.parse(await this.client.call(prefix+'clear-preview',{conversation_id:id}));}
  async clear(id:string,digest:string,confirmation:string){return z.object({events:z.number(),bytes:z.number()}).parse(await this.mutation('clear',id,{conversation_id:id,expected_digest:digest,confirmation_id:confirmation,confirmed:true}));}
  async retentionPreview(){return retentionPreviewSchema.parse(await this.client.call(prefix+'retention-preview',{}));}
  async prune(digest:string){return z.object({sessions:z.number(),events:z.number(),bytes:z.number(),has_more:z.boolean()}).parse(await this.mutation('retention-apply','archive-retention',{expected_digest:digest,confirmed:true}));}
  async exportStart(id:string){return exportPageSchema.parse(await this.client.call(prefix+'export-start',{conversation_id:id}));}
  async exportPage(cursor:string){return exportPageSchema.parse(await this.client.call(prefix+'export-page',{cursor}));}
  async cancelJob(conversation:string,job:string){return z.object({job:z.object({state:z.string(),slot_held:z.boolean()})}).parse(await this.mutation('cancel-job',job,{conversation_id:conversation,job_id:job,confirmed:true}));}
}
export const attributionLabel=(value:string):string=>({client_meta:'客户端会话标识',unassigned_missing:'未提供会话标识',unassigned_invalid:'会话标识无效',unassigned_legacy:'历史任务未归属'}[value]??value);
export const stateLabel=(value:string):string=>({STARTING:'准备启动',RUNNING:'运行中',CANCELLING:'正在请求取消',EXITED:'正常退出',FAILED:'失败',CANCELLED:'已取消',TIMED_OUT:'超时结束',OUTPUT_LIMIT:'输出超限',TERMINATION_UNKNOWN:'终止情况未知',RECOVERED_UNKNOWN:'已恢复名额，结果未知',received:'已接收，未返回',returned:'处理器已返回',threw:'处理器异常',interrupted:'调用被中断'}[value]??value);
export const eventLabel=(value:string):string=>({tool_request_received:'收到工具请求',tool_result_prepared:'工具结果已生成',handler_exception:'处理器异常',job_first_observed:'首次记录命令任务',job_state_changed:'任务状态变化',command_output_observed:'采集到命令输出',call_interrupted_by_restart:'重启后调用结果未知'}[value]??value);
