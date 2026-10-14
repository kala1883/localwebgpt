/**
 * Execution journal adapter over existing transactional idempotency storage.
 * Original job rows still exclude command text, cwd, PID and output. The separate
 * redacted conversation archive records calls, bounded outputs and state events.
 * Old command_exec records remain authoritative: an unknown old request is
 * never converted into a new process start.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { Repositories } from '@lwb/persistence';
import { COMMAND_JOB_LIMITS, COMMAND_JOB_STATES, holdsCommandSlot } from '../../../../packages/contracts/src/command-job.ts';
import type { CommandJobOwner, CommandJobRecord } from '../../../../packages/contracts/src/command-job.ts';
const JOB_TOOL = 'lwb.command_job.v1';
const INDEX_TOOL = 'lwb.command_job_index.v1';
const PREFIX = 'jobv1:';
export class CommandJobFailure extends Error {
  constructor(readonly code: 'IDEMPOTENCY_CONFLICT' | 'COMMAND_REPLAY_SUPPRESSED' | 'NOT_AUTHORIZED' |
    'INVALID_ARGUMENT' | 'CONCURRENCY_LIMIT_EXCEEDED' | 'STORAGE_UNAVAILABLE', message: string) {
    super(message);
    this.name = 'CommandJobFailure';
  }
}
export interface ExecutionReference { readonly request_hash: string; readonly job_id: string | null }
export interface CommandJobStore {
  findExecution(owner: CommandJobOwner, key: string): ExecutionReference | null;
  claim(owner: CommandJobOwner, key: string, hash: string, record: CommandJobRecord): ExecutionReference | null;
  get(owner: CommandJobOwner, jobId: string): CommandJobRecord | null;
  save(record: CommandJobRecord): void;
  recordOutput?(record: CommandJobRecord, output: { stdout: string; stderr: string; withheld: boolean; source_truncated: boolean }): void;
  resolve?(record: CommandJobRecord, expectedUpdatedAt: string, actor: string): void;
  list(owner: CommandJobOwner): readonly CommandJobRecord[];
  all(): readonly CommandJobRecord[];
}
export function sameJobOwner(a: CommandJobOwner, b: CommandJobOwner): boolean {
  return a.principal_id === b.principal_id && a.connection_id === b.connection_id;
}
export class RepositoryCommandJobStore implements CommandJobStore {
  constructor(private readonly repos: Repositories) {}
  findExecution(owner: CommandJobOwner, key: string): ExecutionReference | null {
    const value = this.repos.idempotency.find(owner.principal_id, 'command_exec', key);
    return value === null ? null : {
      request_hash: value.request_hash,
      job_id: value.result_ref?.startsWith(PREFIX) ? value.result_ref.slice(PREFIX.length) : null,
    };
  }
  claim(owner: CommandJobOwner, key: string, hash: string, record: CommandJobRecord): ExecutionReference | null {
    return this.repos.transaction(() => {
      const outcome = this.repos.idempotency.begin({
        id: `idem_${randomUUID()}`, principal_id: owner.principal_id,
        tool: 'command_exec', key, request_hash: hash,
      });
      if (outcome.kind !== 'new') return this.findExecution(owner, key);
      this.repos.idempotency.begin({
        id: `idem_${randomUUID()}`, principal_id: owner.principal_id,
        tool: JOB_TOOL, key: record.job_id, request_hash: createHash('sha256').update(record.job_id).digest('hex'),
      });
      // Archive origin joins the pre-spawn transaction; failure rolls back without executing.
      this.repos.conversation_archive?.observeJob(record);
      this.save(record);
      const records = [...this.list(owner), record];
      // Active and quarantined jobs are never evicted. Only the terminal index is bounded.
      const active = records.filter((job) => holdsCommandSlot(job.state));
      const terminal = records.filter((job) => !holdsCommandSlot(job.state))
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
        .slice(0, COMMAND_JOB_LIMITS.max_retained_jobs);
      const ids = [...new Set([...active, ...terminal].map((job) => job.job_id))];
      const indexKey = owner.connection_id;
      this.repos.idempotency.begin({
        id: `idem_${randomUUID()}`, principal_id: owner.principal_id,
        tool: INDEX_TOOL, key: indexKey, request_hash: createHash('sha256').update(indexKey).digest('hex'),
      });
      this.repos.idempotency.complete(owner.principal_id, INDEX_TOOL, indexKey, JSON.stringify(ids));
      this.repos.idempotency.complete(owner.principal_id, 'command_exec', key, `${PREFIX}${record.job_id}`);
      return null;
    });
  }
  get(owner: CommandJobOwner, jobId: string): CommandJobRecord | null {
    const ref = this.repos.idempotency.find(owner.principal_id, JOB_TOOL, jobId)?.result_ref;
    if (ref == null) return null;
    const value = readRecord(ref);
    return sameJobOwner(value.owner, owner) ? value : null;
  }
  save(record: CommandJobRecord): void {
    // Explicit projection prevents runtime callers from accidentally persisting output.
    const metadata: CommandJobRecord = {
      job_id: record.job_id, owner: { principal_id: record.owner.principal_id, connection_id: record.owner.connection_id }, workspace_id: record.workspace_id,
      workspace_generation: record.workspace_generation, connection_generation: record.connection_generation,
      instance_id: record.instance_id, shell: record.shell, state: record.state, started: record.started,
      created_at: record.created_at, updated_at: record.updated_at, duration_ms: record.duration_ms,
      exit_code: record.exit_code, timed_out: record.timed_out, output_truncated: record.output_truncated,
      termination_confirmed: record.termination_confirmed, recovered: record.recovered,
      cancellation_reason: record.cancellation_reason, durable: record.durable, failure_reason: record.failure_reason,
      ...(record.resolution === undefined ? {} : { resolution: {
        resolution_id: record.resolution.resolution_id, source: record.resolution.source,
        basis: record.resolution.basis, resolved_at: record.resolution.resolved_at,
      } }),
    };
    this.repos.idempotency.complete(record.owner.principal_id, JOB_TOOL, record.job_id, JSON.stringify(metadata));
    this.repos.conversation_archive?.observeJobBestEffort(metadata);
  }
  recordOutput(record: CommandJobRecord, output: { stdout: string; stderr: string; withheld: boolean; source_truncated: boolean }): void {
    try { this.repos.conversation_archive?.output(record, output); }
    catch { this.repos.conversation_archive?.noteFault('output'); }
  }
  /** CAS, durable recovery evidence and state update are one transaction. */
  resolve(record: CommandJobRecord, expectedUpdatedAt: string, actor: string): void {
    this.repos.transaction(() => {
      const current = this.get(record.owner, record.job_id);
      if (current === null || current.state !== 'TERMINATION_UNKNOWN' || current.updated_at !== expectedUpdatedAt) {
        throw new CommandJobFailure('IDEMPOTENCY_CONFLICT', '任务状态已变化；请刷新后核验，未释放名额。');
      }
      if (record.state !== 'RECOVERED_UNKNOWN' || record.resolution === undefined) throw new Error('Invalid recovery record.');
      const evidence = JSON.stringify({
        job_id: record.job_id, actor, expected_updated_at: expectedUpdatedAt,
        previous_failure_reason: current.failure_reason, resolution: record.resolution,
        business_result: 'UNKNOWN',
      });
      const event = this.repos.idempotency.begin({
        id: 'idem_' + randomUUID(), principal_id: record.owner.principal_id,
        tool: 'lwb.command_job_recovery.v1', key: record.job_id,
        request_hash: createHash('sha256').update(evidence).digest('hex'),
      });
      if (event.kind !== 'new') throw new CommandJobFailure('IDEMPOTENCY_CONFLICT', '该任务已有恢复证据；没有重复恢复。');
      this.repos.idempotency.complete(record.owner.principal_id, 'lwb.command_job_recovery.v1', record.job_id, evidence);
      this.save(record);
    });
  }
  list(owner: CommandJobOwner): readonly CommandJobRecord[] {
    const ref = this.repos.idempotency.find(owner.principal_id, INDEX_TOOL, owner.connection_id)?.result_ref;
    if (ref == null) return [];
    const ids: unknown = JSON.parse(ref);
    if (!Array.isArray(ids) || ids.length > 4_096 || ids.some((id) => typeof id !== 'string' || !/^job_[a-f0-9-]{36}$/.test(id))) {
      throw new Error('Command job index is invalid.');
    }
    return [...new Set(ids as string[])].map((id) => this.get(owner, id)).filter((job): job is CommandJobRecord => job !== null);
  }
  all(): readonly CommandJobRecord[] {
    return this.repos.connections.list().flatMap((connection) => this.list({
      principal_id: connection.principal_id, connection_id: connection.id,
    }));
  }
}
function readRecord(text: string): CommandJobRecord {
  const value: unknown = JSON.parse(text);
  if (typeof value !== 'object' || value === null) throw new Error('Command job record is invalid.');
  const record = value as CommandJobRecord;
  if (!/^job_[a-f0-9-]{36}$/.test(record.job_id) || !record.owner ||
      typeof record.owner.principal_id !== 'string' || typeof record.owner.connection_id !== 'string' ||
      typeof record.workspace_id !== 'string' || typeof record.instance_id !== 'string' ||
      !COMMAND_JOB_STATES.includes(record.state) || !['cmd', 'powershell', 'bash'].includes(record.shell) ||
      !Number.isSafeInteger(record.workspace_generation) || !Number.isSafeInteger(record.connection_generation) ||
      !Number.isFinite(Date.parse(record.created_at)) || !Number.isFinite(Date.parse(record.updated_at)) ||
      !Number.isSafeInteger(record.duration_ms) || record.duration_ms < 0 ||
      (record.started !== null && typeof record.started !== 'boolean') ||
      (record.exit_code !== null && !Number.isSafeInteger(record.exit_code)) ||
      typeof record.termination_confirmed !== 'boolean' || typeof record.durable !== 'boolean' ||
      typeof record.timed_out !== 'boolean' || typeof record.output_truncated !== 'boolean' || typeof record.recovered !== 'boolean' ||
      ![null, 'USER_CANCELLED', 'AUTHORIZATION_REVOKED', 'SHUTDOWN'].includes(record.cancellation_reason) ||
      ![null, 'RECOVERED_AFTER_RESTART', 'TERMINATION_UNCONFIRMED', 'ORPHANED_OUTPUT', 'SPAWN_FAILED', 'NONZERO_EXIT', 'PROCESS_RESULT_UNKNOWN', 'RECOVERED_TERMINATION'].includes(record.failure_reason)) {
    throw new Error('Command job record is invalid.');
  }
  if (record.resolution !== undefined) {
    const r = record.resolution;
    if (!r || !/^recovery_[a-f0-9-]{36}$/.test(r.resolution_id) ||
        !['local_operator', 'process_observation'].includes(r.source) ||
        !['process_tree_checked', 'os_reboot_verified', 'late_termination'].includes(r.basis) ||
        !Number.isFinite(Date.parse(r.resolved_at))) throw new Error('Invalid recovery evidence.');
  }
  if ((record.state === 'RECOVERED_UNKNOWN') !== (record.resolution !== undefined)) throw new Error('Inconsistent recovery state.');
  return record;
}
