/**
 * Versioned MCP surface composition. Existing file contracts stay unchanged;
 * both daemon registration and the MCP adapter import this single extension.
 */
import { z } from 'zod';
import { TOOL_NAMES as BASE_NAMES, TOOLS_BY_NAME as BASE_TOOLS, TOOL_INPUT_SCHEMAS as BASE_INPUTS } from './tools.ts';
import type { ToolName as BaseToolName, ToolAnnotations } from './tools.ts';
import { TOOL_OUTPUT_SCHEMAS as BASE_OUTPUTS, BRIDGE_STATUS_OUTPUT, WORKSPACE_LIST_OUTPUT, okEnvelopeOf } from './tool-outputs.ts';
import { COMMAND_JOB_CONTROL_NAMES, COMMAND_JOB_LIMITS, COMMAND_JOB_STATES } from './command-job.ts';
import type { CommandJobView, CommandJobStartInput } from './command-job.ts';

export const CONTRACT_VERSION = '0.3.0';
export const TOOL_NAMES = [...BASE_NAMES, ...COMMAND_JOB_CONTROL_NAMES] as const;
export type ToolName = typeof TOOL_NAMES[number];
export const IMPLEMENTED_TOOL_NAMES = TOOL_NAMES;
export type ImplementedToolName = ToolName;
export function isToolName(value: string): value is ToolName { return (TOOL_NAMES as readonly string[]).includes(value); }
export function isImplementedToolName(value: ToolName): value is ImplementedToolName { return isToolName(value); }
export interface ToolCatalogResult {
  readonly tools: readonly { readonly name: ToolName; readonly available: boolean; readonly reason: string | null }[];
}
/** Single catalog composition used by registration, diagnostics and local views. */
export function withCommandJobCatalog(base: ToolCatalogResult['tools']): ToolCatalogResult {
  const available = base.some((entry) => entry.name === 'command_exec' && entry.available);
  const core = base.filter((entry) => !(COMMAND_JOB_CONTROL_NAMES as readonly string[]).includes(entry.name));
  return { tools: [...core, ...COMMAND_JOB_CONTROL_NAMES.map((name) => ({ name, available,
    reason: available ? null : 'WORKSPACE_TOOL_NOT_GRANTED' }))] };
}
const jobId = z.string().regex(/^job_[0-9a-f-]{36}$/).describe('command_exec 返回的原始 job_id；只可查询或取消本连接自己的任务。');
const workspaceId = z.string().min(1).max(128);
export const COMMAND_JOB_INPUT_SCHEMAS = {
  command_exec: BASE_INPUTS.command_exec.extend({
    wait_ms: z.number().int().min(0).max(COMMAND_JOB_LIMITS.max_wait_ms).optional()
      .describe('只控制本次等待，不是命令运行时限；默认 1000ms。未结束时返回 job_id 和真实状态。'),
  }),
  command_status: z.strictObject({
    job_id: jobId,
    include_output: z.boolean().optional().describe('默认只查元数据；设为 true 才取终态输出并扣出站预算。输出仅短期保留在内存。'),
  }),
  command_cancel: z.strictObject({ job_id: jobId }),
  command_list: z.strictObject({
    workspace_id: workspaceId.optional(),
    max_items: z.number().int().min(1).max(COMMAND_JOB_LIMITS.max_list_items).optional(),
    after_job_id: jobId.optional().describe('上一页的 next_after_job_id；它只是分页位置，不是授权凭证。'),
  }),
};
export const COMMAND_JOB_VIEW_SCHEMA = z.strictObject({
  job_id: jobId, workspace_id: workspaceId, shell: z.enum(['cmd', 'powershell', 'bash']),
  state: z.enum(COMMAND_JOB_STATES), started: z.boolean().nullable(),
  created_at: z.string(), updated_at: z.string(), duration_ms: z.number().int().nonnegative(),
  exit_code: z.number().int().nullable(), timed_out: z.boolean(), output_truncated: z.boolean(),
  termination_confirmed: z.boolean(), recovered: z.boolean(),
  cancellation_reason: z.enum(['USER_CANCELLED', 'AUTHORIZATION_REVOKED', 'SHUTDOWN']).nullable(),
  durable: z.boolean(), failure_reason: z.string().nullable(),
  resolution: z.strictObject({
    resolution_id: z.string().regex(/^recovery_[0-9a-f-]{36}$/),
    source: z.enum(['local_operator', 'process_observation']),
    basis: z.enum(['process_tree_checked', 'os_reboot_verified', 'late_termination']),
    resolved_at: z.string(),
  }).optional(),
  in_progress: z.boolean(), completion_unknown: z.boolean(), slot_held: z.boolean(),
  side_effects_possible: z.boolean(), output_available: z.boolean(), output_withheld: z.boolean(),
  stdout: z.string(), stderr: z.string(),
});
type Equal<A, B> = [A] extends [B] ? [B] extends [A] ? true : never : never;
export const COMMAND_JOB_VIEW_WITNESS: Equal<CommandJobView, z.infer<typeof COMMAND_JOB_VIEW_SCHEMA>> = true;
export const COMMAND_JOB_INPUT_WITNESS: Equal<CommandJobStartInput, z.infer<typeof COMMAND_JOB_INPUT_SCHEMAS.command_exec>> = true;
const nonnegative = z.number().int().nonnegative();
const filePool = z.strictObject({
  in_flight: nonnegative, global_in_flight: nonnegative, max_concurrent: nonnegative,
  max_per_connection: nonnegative, waiting: nonnegative, oldest_age_ms: nonnegative,
  active: z.array(z.strictObject({ lease_id: z.string(), age_ms: nonnegative })),
});
const commandPool = z.strictObject({
  in_flight: nonnegative, global_in_flight: nonnegative, max_concurrent: nonnegative,
  max_per_connection: nonnegative, quarantined: nonnegative, oldest_age_ms: nonnegative,
  storage_fault: z.boolean(),
  active: z.array(z.strictObject({ job_id: jobId, state: z.enum(COMMAND_JOB_STATES), age_ms: nonnegative })),
});
const bridgeOutput = okEnvelopeOf(BRIDGE_STATUS_OUTPUT.shape.data.extend({
  conversation_archive: z.strictObject({feature_version:z.literal('1.0.0'),schema_version:z.literal(11),capture_policy:z.literal('redacted-v1'),chat_transcript_archived:z.literal(false)}).optional(),
  command_job_protocol: z.literal('1.0.0'),
  tool_surface: z.strictObject({
    catalog_version: z.string(), available_tools: z.array(z.enum(TOOL_NAMES)),
    client_inventory: z.literal('not_observed'),
  }).optional(),
  concurrency: z.strictObject({ files: filePool, commands: commandPool }),
}));
const workspaceOutput = okEnvelopeOf(WORKSPACE_LIST_OUTPUT.shape.data.extend({
  workspaces: z.array(WORKSPACE_LIST_OUTPUT.shape.data.shape.workspaces.element.extend({
    granted_tools: z.array(z.enum(TOOL_NAMES)),
  })),
}));
export const TOOL_OUTPUT_SCHEMAS: Readonly<Record<ToolName, z.ZodObject<z.ZodRawShape>>> = {
  ...BASE_OUTPUTS,
  bridge_status: bridgeOutput,
  workspace_list: workspaceOutput,
  command_exec: okEnvelopeOf(COMMAND_JOB_VIEW_SCHEMA),
  command_status: okEnvelopeOf(COMMAND_JOB_VIEW_SCHEMA),
  command_cancel: okEnvelopeOf(COMMAND_JOB_VIEW_SCHEMA),
  command_list: okEnvelopeOf(z.strictObject({
    jobs: z.array(COMMAND_JOB_VIEW_SCHEMA), next_after_job_id: jobId.nullable(),
    scope: z.literal('current_connection'), history_bounded: z.literal(true),
  })),
};
interface Definition {
  readonly name: ToolName;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: z.ZodObject<z.ZodRawShape>;
  readonly annotations: ToolAnnotations;
}
const definitions: Definition[] = [
  {
    name: 'command_exec', title: '运行受管理的工作区命令',
    description: '在明确授权的可写目录启动命令；cwd 不是沙箱，进程具有本机用户权限。命令没有默认硬时限，但工具只等待有限窗口，未完成会返回 job_id。相同幂等键始终指向原任务；不得换键重跑未知结果。命令池与文件池独立；满额时仍可查询和取消。输出超限、撤权或 daemon 关闭会请求终止；可能有部分副作用，不自动回滚。',
    inputSchema: COMMAND_JOB_INPUT_SCHEMAS.command_exec,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  },
  {
    name: 'command_status', title: '查询命令任务',
    description: '查询当前连接在仍获授权工作区内的原任务，不占命令执行槽。默认仅返回元数据；include_output=true 可读取短期保留的终态输出。TERMINATION_UNKNOWN 表示不能确认进程已停止，绝不能当作成功取消。重启后不自动重跑任务。',
    inputSchema: COMMAND_JOB_INPUT_SCHEMAS.command_status,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'command_list', title: '列出命令任务',
    description: '分页列出本连接在仍获授权工作区中的任务元数据，不返回其它连接、命令文本、进程路径或 stdout。执行池满额时可用；终态历史索引有保留上限，列表不是完整永久历史。',
    inputSchema: COMMAND_JOB_INPUT_SCHEMAS.command_list,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'command_cancel', title: '取消指定命令任务',
    description: '只请求停止本连接拥有且仍获授权的指定任务；独立于文件、命令执行和查询额度。CANCELLING 仅表示已请求取消，须查 command_status 确认；TERMINATION_UNKNOWN 保留异常占位；恢复后的 RECOVERED_UNKNOWN 仍表示业务结果未知。旧隔离作业须在本地控制台的命令任务恢复面板核验，不可通过重复取消清零。不会按用户提供的 PID 杀进程，也不会回滚已发生的副作用。',
    inputSchema: COMMAND_JOB_INPUT_SCHEMAS.command_cancel,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
];
export const TOOLS_BY_NAME: ReadonlyMap<ToolName, Definition> = new Map<ToolName, Definition>([
  ...[...BASE_TOOLS.entries()].map(([name, definition]): [BaseToolName, Definition] => [name, definition]),
  ...definitions.map((definition): [ToolName, Definition] => [definition.name, definition]),
]);
export function outputSchemaOf(name: ToolName): z.ZodObject<z.ZodRawShape> | undefined { return TOOL_OUTPUT_SCHEMAS[name]; }
