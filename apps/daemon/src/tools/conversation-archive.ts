/** Archive wrapper around the ORIGINAL guarded handlers. Correlation never changes authorization. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { BridgeError } from '@lwb/contracts';
import type { OperationRegistry, RequestContext } from '@lwb/ipc';
import { hasCapability } from '@lwb/ipc';
import { TOOL_NAMES } from '../../../../packages/contracts/src/tool-surface-v2.ts';
import { ARCHIVED_CALL_OPERATION, parseArchivedInvocation } from '../../../../packages/contracts/src/conversation-archive.ts';
import type { ConversationHint } from '../../../../packages/contracts/src/conversation-archive.ts';
import type { ArchiveCall } from '../../../../packages/persistence/src/conversation-archive.ts';
import { asEnvelope } from './handlers.ts';
import type { ToolHandlerDeps } from './handlers.ts';
import { resolveConnection } from './access.ts';

type Handler = (input: unknown, context: RequestContext) => Promise<unknown> | unknown;
const SAFETY_TOOLS = new Set(['bridge_status','workspace_list','file_list','file_read','text_search',
  'git_status','git_diff','change_get','change_list','command_status','command_list','command_cancel']);
export function createConversationArchiving(operations: OperationRegistry,deps: ToolHandlerDeps) {
  const archive = deps.repos.conversation_archive;
  if (!archive) throw new Error('Conversation archive repository is not wired.');
  // One instance-local context per async request, not a connection-wide mutable variable.
  const hints = new AsyncLocalStorage<ConversationHint>();
  // Normal runtime owns a single database through the existing daemon singleton lock.
  // An archival fault must not prevent service diagnostics/cancellation from starting.
  try { archive.recoverInterruptedCalls(); deps.repos.conversation_management?.autoPrune(); }
  catch { archive.noteFault('call'); }
  const wrap = (tool: string,handler: Handler): Handler => async (input,context) => {
    try { deps.repos.conversation_management?.autoPrune(); } catch { archive.noteFault('call'); }
    let call: ArchiveCall;
    try {
      const connection = resolveConnection(context,deps);
      call = archive.begin({principal_id:connection.principal_id,connection_id:connection.id},
        hints.getStore() ?? {status:'missing'},context.request_id,tool,input);
    } catch (error) {
      // Resolve/auth failures must keep their original denial, not become archive errors.
      if (error instanceof BridgeError) return await asEnvelope(context,() => {throw error;});
      archive.noteFault('call');
      if (SAFETY_TOOLS.has(tool)) return await handler(input,context);
      return await asEnvelope(context,() => {throw new BridgeError('STORAGE_UNAVAILABLE',
        '无法建立执行归档；本次没有进入该操作处理器。请在本机检查归档存储与容量。');});
    }
    let result: unknown;
    let threw = false;
    try { result = await archive.run(call,() => handler(input,context)); }
    catch (error) { threw = true; result = await asEnvelope(context,() => {throw error;}); }
    try { archive.complete(call,result,threw); }
    catch {
      archive.noteFault('call');
      if (SAFETY_TOOLS.has(tool)) return result;
      // The original handler already ran. DO NOT describe this as 'never started'.
      const value = result && typeof result === 'object' ? result as {data?:{job_id?:unknown}} : {};
      const jobId = typeof value.data?.job_id === 'string' ? value.data.job_id : undefined;
      return await asEnvelope(context,() => {throw new BridgeError('STORAGE_UNAVAILABLE',
        '操作已进入处理器，但结果未能完整归档；可能已有副作用。请查询原任务或修改集，不得换键重跑。',
        {outcome_unknown:true,archive_call_id:call.id,...(jobId === undefined ? {} : {job_id:jobId})});});
    }
    return result;
  };
  const register = (): void => {
    operations.register({
      name:ARCHIVED_CALL_OPERATION,required:'tools.read',
      handler:async (raw,context) => {
        let input;
        try { input = parseArchivedInvocation(raw); }
        catch { return await asEnvelope(context,() => {throw new BridgeError('INVALID_ARGUMENT','归档调用封套格式不正确。');}); }
        // Fixed allowlist: never proxy control-plane methods, tools.catalog, or this dispatcher itself.
        if (!(TOOL_NAMES as readonly string[]).includes(input.name)) {
          return await asEnvelope(context,() => {throw new BridgeError('INVALID_ARGUMENT','归档封套只接受已登记的工作区工具。');});
        }
        const definition = operations.lookup(input.name);
        if (!definition || definition.required !== 'tools.read' || !hasCapability(context.audience,definition.required)) {
          return await asEnvelope(context,() => {throw new BridgeError('NOT_AUTHORIZED','原工具不可调用。');});
        }
        // Invoke the registered guarded handler, with identity from the authenticated IPC context.
        return await hints.run(input.conversation,() => operations.invoke(definition,input.input,context));
      },
    });
  };
  return {wrap,register};
}
