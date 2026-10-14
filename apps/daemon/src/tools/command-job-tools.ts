/** Command-only surface. File tools retain their existing guard and pool. */
import { BridgeError, err, ok } from '@lwb/contracts';
import type { BridgeStatusData, Envelope, WorkspaceListData } from '@lwb/contracts';
import { ConcurrencyGate } from '@lwb/limits';
import { recordToolCall } from '@lwb/audit';
import { emitContent, mintClearance } from '@lwb/egress';
import type { RequestContext } from '@lwb/ipc';
import { COMMAND_JOB_CONTROL_NAMES, COMMAND_JOB_PROTOCOL_VERSION } from '../../../../packages/contracts/src/command-job.ts';
import type { CommandJobOwner, CommandJobRecord, CommandJobToolName, CommandJobView } from '../../../../packages/contracts/src/command-job.ts';
import { COMMAND_JOB_INPUT_SCHEMAS, CONTRACT_VERSION, withCommandJobCatalog } from '../../../../packages/contracts/src/tool-surface-v2.ts';
import type { ToolCatalogResult } from '../../../../packages/contracts/src/tool-surface-v2.ts';
import { CommandJobManager } from '../lifecycle/command-jobs.ts';
import { RepositoryCommandJobStore, CommandJobFailure } from '../lifecycle/command-job-store.ts';
import { asEnvelope, requestIdOf } from './handlers.ts';
import type { ToolHandler, ToolHandlerDeps } from './handlers.ts';
import type { GuardDeps } from './guard.ts';
import { commandPoolFor } from './concurrency-pools.ts';
import { catalogFor } from './catalog.ts';
import { resolveConnection, resolveWorkspaceAccess } from './access.ts';
import { isSafeForModel, toModelPayload } from './errors.ts';

type Access = Awaited<ReturnType<typeof resolveWorkspaceAccess>>;
export function createCommandJobSurface(deps: ToolHandlerDeps, guard: GuardDeps) {
  const jobs = new CommandJobManager({
    store: new RepositoryCommandJobStore(deps.repos),
    processes: { run: async (options) => {
      if (deps.command_processes === undefined) throw new Error('Command manager is unavailable.');
      return await deps.command_processes.run(options);
    } },
    concurrency: commandPoolFor(guard.concurrency),
    sanitize: (stdout, stderr) => isSafeForModel(`${stdout}\n${stderr}`)
      ? { stdout, stderr, withheld: false }
      : { stdout: '[命令输出含本机路径或凭证，已整段隐藏。]', stderr: '', withheld: true },
  });
  // Bounded RPC waits cannot exhaust process slots. Cancel has a reserved lane.
  const requests = new ConcurrencyGate({ max_concurrent: 32, max_per_connection: 8, wait_ms: 0 });
  const cancellations = new ConcurrencyGate({ max_concurrent: 8, max_per_connection: 2, wait_ms: 0 });
  const diagnostics = new ConcurrencyGate({ max_concurrent: 8, max_per_connection: 2, wait_ms: 0 });

  const scope = (context: RequestContext, workspaceId: string) => {
    const connection = resolveConnection(context, deps);
    const workspace = deps.repos.workspaces.findById(workspaceId);
    const grant = deps.configuration === undefined ? deps.repos.grants.find(connection.id, workspaceId)
      : deps.configuration.findGrant(connection.id, workspaceId);
    if (workspace === null || !workspace.enabled || workspace.removed_at !== null ||
        grant === null || !grant.enabled || !grant.capabilities.includes('command_exec')) {
      throw new BridgeError('WORKSPACE_NOT_GRANTED', '任务所在工作区当前未授予命令访问。');
    }
    if (workspace.kind !== 'directory' || workspace.mode !== 'read_propose_apply_with_local_approval') {
      throw new BridgeError('POLICY_DENIED', '任务所在工作区当前不允许命令访问。');
    }
    return { connection, workspace };
  };
  const ownerOf = (context: RequestContext): CommandJobOwner => {
    const connection = resolveConnection(context, deps);
    return { principal_id: connection.principal_id, connection_id: connection.id };
  };
  const output = (view: CommandJobView, access: Access, record: CommandJobRecord): CommandJobView => {
    if (!view.output_available) return view;
    if (record.workspace_generation !== access.workspace.generation || record.connection_generation !== access.connection.generation) {
      return { ...view, stdout: '', stderr: '', output_available: false, output_withheld: true };
    }
    const clearance = mintClearance(access.decision, { connection_id: access.connection.id, generation: access.scope.generation });
    let separator = '\n<LWB_STDERR>\n';
    while (view.stdout.includes(separator) || view.stderr.includes(separator)) separator += '<x>';
    const emitted = emitContent(clearance, { path: '', content: `${view.stdout}${separator}${view.stderr}` }, access.budget);
    const at = emitted.content.indexOf(separator);
    if (at < 0) throw new BridgeError('INTERNAL_ERROR', '任务已运行，但输出无法拆分；不要重跑原命令。');
    return { ...view, stdout: emitted.content.slice(0, at), stderr: emitted.content.slice(at + separator.length),
      output_withheld: view.output_withheld || emitted.redacted };
  };
  const handle = (name: CommandJobToolName) => async (raw: unknown, originalContext: RequestContext): Promise<Envelope<unknown>> => {
    const context: RequestContext = { ...originalContext, request_id: requestIdOf(originalContext) };
    let workspaceId: string | null = null;
    let jobId: string | null = null;
    let jobState: string | null = null;
    let entered = false;
    let delivered = false;
    let bytesOut = 0;
    let owner: CommandJobOwner | undefined;
    const admission = await (name === 'command_cancel' ? cancellations : requests).acquire(context.connection_id);
    try {
      const result = await asEnvelope(context, async () => {
        if (!admission.ok) throw new BridgeError('CONCURRENCY_LIMIT_EXCEEDED', '命令控制请求暂时繁忙；本次没有启动新进程。');
        owner = ownerOf(context);
        const connectionGeneration = deps.repos.connections.findById(owner.connection_id)?.generation;
        const revision = deps.configuration?.authorizationRevision;
        const recheck = (): void => {
          const current = resolveConnection(context, deps);
          if (current.generation !== connectionGeneration || deps.configuration?.authorizationRevision !== revision) {
            throw new BridgeError('CONNECTION_DISABLED', '授权在请求期间发生变化，结果未返回；原任务不会被重复启动。');
          }
          if (workspaceId !== null) scope(context, workspaceId);
        };
        let view: CommandJobView;
        try {
          if (name === 'command_exec') {
            const parsed = COMMAND_JOB_INPUT_SCHEMAS.command_exec.safeParse(raw);
            if (!parsed.success) throw invalid();
            workspaceId = parsed.data.workspace_id;
            if (deps.status().paused()) throw new BridgeError('PAUSED', '本地服务已暂停；本次没有启动进程。');
            if (deps.command_processes === undefined) throw new BridgeError('INTERNAL_ERROR', '本地命令执行器未启用。');
            const access = await resolveWorkspaceAccess({ workspace_id: workspaceId, action: 'command_exec', path: '' }, context, deps);
            if (access.workspace.kind !== 'directory') throw new BridgeError('POLICY_DENIED', '命令只支持已授权的目录工作区。');
            recheck();
            entered = true;
            const stillAuthorized = (): boolean => {
              try {
                const current = scope(context, access.workspace.id);
                return !deps.status().paused() && !deps.capability_flags(current.workspace).recovery_required &&
                  current.workspace.generation === access.workspace.generation &&
                  current.connection.generation === access.connection.generation &&
                  deps.configuration?.authorizationRevision === revision;
              } catch { return false; }
            };
            view = await jobs.start(parsed.data, {
              owner, workspace_generation: access.workspace.generation,
              connection_generation: access.connection.generation, cwd: access.workspace.canonical_root,
              still_authorized: stillAuthorized,
            });
            jobId = view.job_id;
            recheck();
            if (!stillAuthorized()) {
              jobs.cancel(owner, view.job_id, 'AUTHORIZATION_REVOKED');
              throw new BridgeError('PAUSED', '命令启动后授权或暂停状态发生变化；已请求停止，可能已产生部分副作用。');
            }
            const before = access.budget.chargedTotal;
            try { view = output(view, access, jobs.record(owner, view.job_id)); }
            finally { bytesOut += access.budget.chargedTotal - before; }
          } else if (name === 'command_list') {
            const parsed = COMMAND_JOB_INPUT_SCHEMAS.command_list.safeParse(raw);
            if (!parsed.success) throw invalid();
            if (parsed.data.workspace_id !== undefined) { workspaceId = parsed.data.workspace_id; scope(context, workspaceId); }
            const visible = jobs.list(owner).filter((job) => {
              if (workspaceId !== null && job.workspace_id !== workspaceId) return false;
              try { scope(context, job.workspace_id); return true; } catch (error) {
                if (error instanceof BridgeError && (error.code === 'WORKSPACE_NOT_GRANTED' || error.code === 'POLICY_DENIED')) return false;
                throw error;
              }
            });
            const after = parsed.data.after_job_id;
            const start = after === undefined ? 0 : visible.findIndex((job) => job.job_id === after) + 1;
            if (after !== undefined && start === 0) throw new BridgeError('INVALID_ARGUMENT', '分页任务已不在当前可见历史中；请从第一页重新查询。');
            const page = visible.slice(start, start + (parsed.data.max_items ?? 20));
            recheck();
            return { jobs: page.map((job) => jobs.view(owner!, job.job_id)),
              next_after_job_id: start + page.length < visible.length ? page.at(-1)!.job_id : null,
              scope: 'current_connection' as const, history_bounded: true as const };
          } else {
            const parsed = name === 'command_status' ? COMMAND_JOB_INPUT_SCHEMAS.command_status.safeParse(raw)
              : COMMAND_JOB_INPUT_SCHEMAS.command_cancel.safeParse(raw);
            if (!parsed.success) throw invalid();
            jobId = parsed.data.job_id;
            const record = jobs.record(owner, jobId);
            workspaceId = record.workspace_id;
            const current = scope(context, workspaceId);
            view = name === 'command_cancel' ? jobs.cancel(owner, jobId) : jobs.view(owner, jobId, 'include_output' in parsed.data && parsed.data.include_output === true);
            if (name === 'command_status' && view.output_available && (deps.status().paused() || deps.capability_flags(current.workspace).recovery_required)) {
              view = { ...view, stdout: '', stderr: '', output_available: false, output_withheld: true };
            }
            if (name === 'command_status' && view.output_available) {
              const access = await resolveWorkspaceAccess({ workspace_id: workspaceId, action: 'command_exec', path: '' }, context, deps);
              const before = access.budget.chargedTotal;
              try { view = output(view, access, record); } finally { bytesOut += access.budget.chargedTotal - before; }
            }
            recheck();
            if (scope(context, workspaceId).workspace.generation !== current.workspace.generation) {
              throw new BridgeError('WORKSPACE_GENERATION_CHANGED', '工作区授权已变化；任务结果未返回。');
            }
          }
        } catch (error) {
          if (error instanceof CommandJobFailure) throw new BridgeError(error.code, error.message);
          if (error instanceof BridgeError && name === 'command_exec' && jobId !== null) {
            throw new BridgeError(error.code, `${error.message} 命令可能已经执行了一部分并产生副作用；请查询原任务，不得换键重跑。`, { job_id: jobId });
          }
          throw error;
        }
        recheck();
        jobState = view.state;
        delivered = view.output_available;
        return view;
      });
      try {
        recordToolCall(deps.repos, {
          tool: name, request_id: context.request_id, connection_id: context.connection_id,
          workspace_id: workspaceId, outcome: result.ok ? 'allow' : 'deny',
          error_code: result.ok ? null : result.error.code, bytes_out: bytesOut,
          file_access: name === 'command_exec' ? (entered ? [{ path: '', start_line: null, end_line: null, delivered: result.ok && delivered }] : null)
            : delivered ? [{ path: '', start_line: null, end_line: null, delivered: result.ok }] : [],
          metadata: { reason: 'COMMAND_JOB_CALL', ...(jobId === null ? {} : { job_id: jobId }), ...(jobState === null ? {} : { job_state: jobState }) },
        });
      } catch {
        if (jobId !== null && owner !== undefined && name === 'command_exec') {
          try { jobs.cancel(owner, jobId); } catch { /* Preserve the audit failure, not a cleanup exception. */ }
        }
        return err(toModelPayload(new BridgeError('STORAGE_UNAVAILABLE', '命令请求的审计未能保存；任务可能已经启动，结果未返回。请查询原任务，不要换键重跑。')), context.request_id);
      }
      return result;
    } finally { if (admission.ok) admission.lease.release(); }
  };
  const decorate = (name: string, handler: ToolHandler): ToolHandler => {
    if (name !== 'bridge_status' && name !== 'workspace_list') return handler;
    return async (input, context, handlerDeps) => {
      const admission = await diagnostics.acquire(context.connection_id);
      if (!admission.ok) return await asEnvelope(context, () => { throw new BridgeError('CONCURRENCY_LIMIT_EXCEEDED', '诊断请求暂时繁忙；文件和命令执行状态没有改变。'); });
      try {
        const result = await handler(input, context, handlerDeps);
        if (!result.ok) return result;
        if (name === 'bridge_status') {
          return ok({ ...(result.data as BridgeStatusData), contract_version: CONTRACT_VERSION,
            command_job_protocol: COMMAND_JOB_PROTOCOL_VERSION,
            conversation_archive: {feature_version:'1.0.0',schema_version:11,capture_policy:'redacted-v1',chat_transcript_archived:false},
            tool_surface: { catalog_version: CONTRACT_VERSION,
              available_tools: withCommandJobCatalog(catalogFor(context, deps)).tools.filter((entry) => entry.available).map((entry) => entry.name),
              client_inventory: 'not_observed' },
            concurrency: { files: guard.concurrency.inspect(context.connection_id), commands: jobs.diagnostics(context.connection_id) } }, result.request_id);
        }
        const data = result.data as WorkspaceListData;
        return ok({ ...data, workspaces: data.workspaces.map((workspace) => ({ ...workspace,
          granted_tools: workspace.granted_tools.includes('command_exec')
            ? [...workspace.granted_tools, ...COMMAND_JOB_CONTROL_NAMES] : workspace.granted_tools,
        })) }, result.request_id);
      } finally { admission.lease.release(); }
    };
  };
  const extendCatalog = (base: ToolCatalogResult['tools']): ToolCatalogResult => {
    return withCommandJobCatalog(base);
  };
  return { handle, decorate, extendCatalog, jobs };
}
function invalid(): BridgeError { return new BridgeError('INVALID_ARGUMENT', '参数不符合命令任务工具的输入契约。', { reason: 'INPUT_SCHEMA_VIOLATION' }); }
