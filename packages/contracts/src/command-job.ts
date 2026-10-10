/** Command job protocol v1. Pure data; no processes, filesystem, or credentials. */
export const COMMAND_JOB_PROTOCOL_VERSION = '1.0.0';
export const COMMAND_JOB_LIMITS = Object.freeze({
  max_concurrent: 4,
  max_per_connection: 2,
  wait_ms: 1_000,
  max_wait_ms: 5_000,
  output_retention_ms: 10 * 60_000,
  max_retained_jobs: 256,
  max_list_items: 50,
  authorization_poll_ms: 100,
});
export const COMMAND_JOB_STATES = [
  'STARTING', 'RUNNING', 'CANCELLING', 'EXITED', 'FAILED',
  'CANCELLED', 'TIMED_OUT', 'OUTPUT_LIMIT', 'TERMINATION_UNKNOWN',
] as const;
export type CommandJobState = typeof COMMAND_JOB_STATES[number];
export type JobShell = 'cmd' | 'powershell' | 'bash';
export type CancellationReason = 'USER_CANCELLED' | 'AUTHORIZATION_REVOKED' | 'SHUTDOWN' | null;
export interface CommandJobOwner {
  readonly principal_id: string;
  readonly connection_id: string;
}
/** Persisted metadata. Deliberately excludes cwd, command text, PID and output. */
export interface CommandJobRecord {
  readonly job_id: string;
  readonly owner: CommandJobOwner;
  readonly workspace_id: string;
  readonly workspace_generation: number;
  readonly connection_generation: number;
  readonly instance_id: string;
  readonly shell: JobShell;
  readonly state: CommandJobState;
  readonly started: boolean | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly duration_ms: number;
  readonly exit_code: number | null;
  readonly timed_out: boolean;
  readonly output_truncated: boolean;
  readonly termination_confirmed: boolean;
  readonly recovered: boolean;
  readonly cancellation_reason: CancellationReason;
  readonly durable: boolean;
  readonly failure_reason: string | null;
}
export interface CommandJobView extends Omit<CommandJobRecord, 'owner' | 'instance_id' | 'workspace_generation' | 'connection_generation'> {
  readonly in_progress: boolean;
  readonly completion_unknown: boolean;
  readonly slot_held: boolean;
  readonly side_effects_possible: boolean;
  readonly output_available: boolean;
  readonly output_withheld: boolean;
  readonly stdout: string;
  readonly stderr: string;
}
export interface CommandJobStartInput {
  readonly workspace_id: string;
  readonly idempotency_key: string;
  readonly shell: JobShell;
  readonly command: string;
  readonly wait_ms?: number | undefined;
}
export const COMMAND_JOB_CONTROL_NAMES = ['command_status', 'command_list', 'command_cancel'] as const;
export type CommandJobControlName = typeof COMMAND_JOB_CONTROL_NAMES[number];
export type CommandJobToolName = 'command_exec' | CommandJobControlName;
export function holdsCommandSlot(state: CommandJobState): boolean {
  return state === 'STARTING' || state === 'RUNNING' || state === 'CANCELLING' || state === 'TERMINATION_UNKNOWN';
}
