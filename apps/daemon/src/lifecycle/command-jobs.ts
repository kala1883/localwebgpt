/** Bounded command jobs. Request lifetime is independent of process lifetime. */
import { createHash, randomUUID } from 'node:crypto';
import { ConcurrencyGate } from '@lwb/limits';
import type { ConcurrencyLease } from '@lwb/limits';
import { COMMAND_JOB_LIMITS, holdsCommandSlot } from '../../../../packages/contracts/src/command-job.ts';
import type { CancellationReason, CommandJobOwner, CommandJobRecord, CommandJobStartInput, CommandJobView } from '../../../../packages/contracts/src/command-job.ts';
import type { CommandProcessOptions, CommandProcessResult } from './command-processes.ts';
import { CommandJobFailure, sameJobOwner } from './command-job-store.ts';
import type { CommandJobStore, ExecutionReference } from './command-job-store.ts';

export interface CommandJobAccess {
  readonly owner: CommandJobOwner;
  readonly workspace_generation: number;
  readonly connection_generation: number;
  readonly cwd: string;
  readonly still_authorized: () => boolean;
}
export interface CommandJobManagerOptions {
  readonly store: CommandJobStore;
  readonly processes: { run(options: CommandProcessOptions): Promise<CommandProcessResult> };
  readonly sanitize: (stdout: string, stderr: string) => { stdout: string; stderr: string; withheld: boolean };
  readonly concurrency?: ConcurrencyGate;
  readonly max_concurrent?: number;
  readonly max_per_connection?: number;
  readonly output_retention_ms?: number;
  readonly max_retained_jobs?: number;
  readonly now?: () => number;
}
interface LiveJob {
  record: CommandJobRecord;
  readonly controller: AbortController;
  readonly done: Promise<void>;
  readonly lease: ConcurrencyLease;
  readonly startedAt: number;
  releaseDone: () => void;
  settled: boolean;
  released: boolean;
  lateTerminationConfirmed?: boolean;
  output: { stdout: string; stderr: string; withheld: boolean; expires: number } | null;
}
export class CommandJobManager {
  readonly #options: CommandJobManagerOptions;
  readonly #gate: ConcurrencyGate;
  readonly #instanceId = randomUUID();
  readonly #live = new Map<string, LiveJob>();
  readonly #recovered = new Map<string, CommandJobRecord>();
  readonly #pending = new Map<string, { hash: string; promise: Promise<CommandJobRecord> }>();
  readonly #now: () => number;
  readonly #retentionMs: number;
  readonly #maxRetained: number;
  #storageFault = false;
  constructor(options: CommandJobManagerOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
    this.#retentionMs = options.output_retention_ms ?? COMMAND_JOB_LIMITS.output_retention_ms;
    this.#maxRetained = options.max_retained_jobs ?? COMMAND_JOB_LIMITS.max_retained_jobs;
    if (!Number.isSafeInteger(this.#retentionMs) || this.#retentionMs < 0 ||
        !Number.isSafeInteger(this.#maxRetained) || this.#maxRetained < 1 || this.#maxRetained > COMMAND_JOB_LIMITS.max_retained_jobs) {
      throw new RangeError('Invalid command output retention limits.');
    }
    this.#gate = options.concurrency ?? new ConcurrencyGate({
      max_concurrent: options.max_concurrent ?? COMMAND_JOB_LIMITS.max_concurrent,
      max_per_connection: options.max_per_connection ?? COMMAND_JOB_LIMITS.max_per_connection,
      wait_ms: 0,
    });
    // Never reuse a PID, relaunch a command, or silently zero unknown occupancy.
    let previousJobs: readonly CommandJobRecord[];
    try { previousJobs = options.store.all(); }
    catch { this.#storageFault = true; previousJobs = []; }
    for (const previous of previousJobs) {
      if (!holdsCommandSlot(previous.state)) continue;
      const record: CommandJobRecord = {
        ...previous, state: 'TERMINATION_UNKNOWN', recovered: true,
        termination_confirmed: false, updated_at: this.#isoNow(),
        failure_reason: 'RECOVERED_AFTER_RESTART',
      };
      this.#recovered.set(record.job_id, record);
      try { options.store.save(record); } catch { this.#storageFault = true; }
    }
  }
  async start(input: CommandJobStartInput, access: CommandJobAccess): Promise<CommandJobView> {
    const wait = input.wait_ms ?? COMMAND_JOB_LIMITS.wait_ms;
    if (!Number.isSafeInteger(wait) || wait < 0 || wait > COMMAND_JOB_LIMITS.max_wait_ms) {
      throw new CommandJobFailure('INVALID_ARGUMENT', '命令等待窗口超出允许范围；没有启动进程。');
    }
    this.#prune();
    // Keep the historical request digest for old idempotency records.
    const hash = createHash('sha256').update(JSON.stringify([input.workspace_id, input.shell, input.command]), 'utf8').digest('hex');
    const pendingKey = JSON.stringify([access.owner.principal_id, access.owner.connection_id, input.idempotency_key]);
    let pending = this.#pending.get(pendingKey);
    if (pending !== undefined && pending.hash !== hash) throw conflict();
    if (pending === undefined) {
      const promise = this.#begin(input, access, hash);
      pending = { hash, promise };
      this.#pending.set(pendingKey, pending);
      // Both fulfillment and rejection remove the deduplication entry.
      void promise.then(() => this.#pending.delete(pendingKey), () => this.#pending.delete(pendingKey));
    }
    const record = await pending.promise;
    const live = this.#live.get(record.job_id);
    if (live !== undefined && !live.settled && wait > 0) await waitFor(live.done, wait);
    return this.view(access.owner, record.job_id, true);
  }
  record(owner: CommandJobOwner, jobId: string): CommandJobRecord {
    const record = this.#live.get(jobId)?.record ?? this.#recovered.get(jobId) ?? this.#options.store.get(owner, jobId);
    if (record === null || record === undefined || !sameJobOwner(record.owner, owner)) {
      throw new CommandJobFailure('NOT_AUTHORIZED', '任务不存在或不属于当前连接。');
    }
    return { ...record, owner: { ...record.owner } };
  }
  view(owner: CommandJobOwner, jobId: string, includeOutput = false): CommandJobView {
    this.#prune();
    const record = this.record(owner, jobId);
    const live = this.#live.get(jobId);
    const output = live?.output;
    const available = includeOutput && output != null && output.expires > this.#now();
    const { owner: _owner, instance_id: _instance, workspace_generation: _wg, connection_generation: _cg, ...metadata } = record;
    return {
      ...metadata,
      duration_ms: live !== undefined && !live.settled ? Math.max(0, Math.round(performance.now() - live.startedAt)) : record.duration_ms,
      in_progress: record.state === 'STARTING' || record.state === 'RUNNING' || record.state === 'CANCELLING',
      completion_unknown: record.state === 'TERMINATION_UNKNOWN' || record.state === 'RECOVERED_UNKNOWN',
      slot_held: holdsCommandSlot(record.state),
      side_effects_possible: record.started !== false,
      output_available: available,
      output_withheld: available ? output.withheld : false,
      stdout: available ? output.stdout : '', stderr: available ? output.stderr : '',
    };
  }
  list(owner: CommandJobOwner): readonly CommandJobRecord[] {
    this.#prune();
    return this.#options.store.list(owner).map((record) => this.record(owner, record.job_id))
      .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.job_id.localeCompare(b.job_id));
  }
  cancel(owner: CommandJobOwner, jobId: string, reason: CancellationReason = 'USER_CANCELLED'): CommandJobView {
    const record = this.record(owner, jobId);
    const live = this.#live.get(record.job_id);
    if (live !== undefined && !live.settled && !live.controller.signal.aborted) {
      this.#update(live, { state: 'CANCELLING', cancellation_reason: reason });
      live.controller.abort();
    }
    return this.view(owner, jobId);
  }
  /** Local control-plane view; never exposed as an unscoped MCP operation. */
  localRecords(): readonly CommandJobRecord[] {
    return this.#options.store.all().map((record) => this.record(record.owner, record.job_id));
  }
  /** Only a trusted driver observation or an authenticated local operator may call this. */
  resolveUnknown(owner: CommandJobOwner, jobId: string, expectedUpdatedAt: string,
    evidence: { source: 'local_operator' | 'process_observation'; basis: 'process_tree_checked' | 'os_reboot_verified' | 'late_termination'; actor: string }): CommandJobView {
    const current = this.record(owner, jobId);
    if (current.state === 'RECOVERED_UNKNOWN') return this.view(owner, jobId);
    const live = this.#live.get(jobId);
    if (current.state !== 'TERMINATION_UNKNOWN' || current.updated_at !== expectedUpdatedAt ||
        (live !== undefined && !live.settled)) {
      throw new CommandJobFailure('IDEMPOTENCY_CONFLICT', '任务状态已变化或仍在运行；没有释放名额。');
    }
    const validSource = evidence.source === 'local_operator'
      ? ['process_tree_checked', 'os_reboot_verified'].includes(evidence.basis) && evidence.actor.startsWith('console:')
      : evidence.source === 'process_observation' && evidence.basis === 'late_termination' && evidence.actor === 'daemon';
    if (!validSource) throw new CommandJobFailure('INVALID_ARGUMENT', '恢复证据来源不合法。');
    if (this.#options.store.resolve === undefined) throw new CommandJobFailure('STORAGE_UNAVAILABLE', '任务仓储不支持原子恢复；没有释放名额。');
    const next: CommandJobRecord = {
      ...current, state: 'RECOVERED_UNKNOWN', recovered: true, updated_at: this.#isoNow(), durable: true,
      // A local attestation is not misrepresented as an OS observation.
      termination_confirmed: evidence.source === 'process_observation', failure_reason: 'RECOVERED_TERMINATION',
      resolution: { resolution_id: 'recovery_' + randomUUID(), source: evidence.source, basis: evidence.basis, resolved_at: this.#isoNow() },
    };
    try { this.#options.store.resolve(next, expectedUpdatedAt, evidence.actor); }
    catch (error) {
      if (error instanceof CommandJobFailure) throw error;
      this.#storageFault = true;
      throw new CommandJobFailure('STORAGE_UNAVAILABLE', '恢复记录未能原子保存；没有释放名额。');
    }
    // Persist FIRST; a crash before releasing is repaired from the durable record on restart.
    if (live !== undefined) {
      live.record = next;
      if (!live.released) { live.released = true; live.lease.release(); }
    }
    this.#recovered.delete(jobId);
    return this.view(owner, jobId);
  }
  #tryLateRecovery(job: LiveJob): void {
    if (!job.settled || !job.lateTerminationConfirmed || job.record.state !== 'TERMINATION_UNKNOWN') return;
    try {
      this.resolveUnknown(job.record.owner, job.record.job_id, job.record.updated_at,
        { source: 'process_observation', basis: 'late_termination', actor: 'daemon' });
    } catch { /* Keep the occupied slot on conflict or persistence failure. Diagnostics remain truthful. */ }
  }
  diagnostics(connectionId: string) {
    const pool = this.#gate.inspect(connectionId);
    const recovered = [...this.#recovered.values()];
    const ownRecovered = recovered.filter((record) => record.owner.connection_id === connectionId);
    const active = [...this.#live.values()].filter((job) => !job.released && job.record.owner.connection_id === connectionId)
      .map((job) => ({ job_id: job.record.job_id, state: job.record.state, age_ms: Math.max(0, Math.round(performance.now() - job.startedAt)) }));
    active.push(...ownRecovered.map((job) => ({ job_id: job.job_id, state: job.state, age_ms: Math.max(0, this.#now() - Date.parse(job.created_at)) })));
    return {
      in_flight: pool.in_flight + ownRecovered.length,
      global_in_flight: pool.global_in_flight + recovered.length,
      max_concurrent: pool.max_concurrent,
      max_per_connection: pool.max_per_connection,
      quarantined: active.filter((job) => job.state === 'TERMINATION_UNKNOWN').length,
      oldest_age_ms: Math.max(0, ...active.map((job) => job.age_ms)),
      storage_fault: this.#storageFault,
      active,
    };
  }
  async #begin(input: CommandJobStartInput, access: CommandJobAccess, hash: string): Promise<CommandJobRecord> {
    const prior = this.#options.store.findExecution(access.owner, input.idempotency_key);
    // Replays are answered BEFORE capacity checks, even when all command slots are full.
    if (prior !== null) return this.#replay(access.owner, prior, hash);
    if (this.#storageFault) throw new CommandJobFailure('STORAGE_UNAVAILABLE', '命令日志需要恢复；本次没有启动进程。');
    const snapshot = this.diagnostics(access.owner.connection_id);
    if (snapshot.global_in_flight >= snapshot.max_concurrent || snapshot.in_flight >= snapshot.max_per_connection) throw full();
    const outcome = await this.#gate.acquire(access.owner.connection_id);
    if (!outcome.ok) throw full();
    const lease = outcome.lease;
    const created = this.#isoNow();
    const record: CommandJobRecord = {
      job_id: `job_${randomUUID()}`, owner: { ...access.owner }, workspace_id: input.workspace_id,
      workspace_generation: access.workspace_generation, connection_generation: access.connection_generation,
      instance_id: this.#instanceId, shell: input.shell, state: 'STARTING', started: null,
      created_at: created, updated_at: created, duration_ms: 0, exit_code: null, timed_out: false,
      output_truncated: false, termination_confirmed: false, recovered: false,
      cancellation_reason: null, durable: true, failure_reason: null,
    };
    let raced: ExecutionReference | null;
    try {
      raced = this.#options.store.claim(access.owner, input.idempotency_key, hash, record);
    } catch (error) {
      // The repository claim is atomic and precedes spawn.
      lease.release();
      if (error instanceof CommandJobFailure) throw error;
      throw new CommandJobFailure('STORAGE_UNAVAILABLE', '无法持久化命令任务；本次没有启动进程。');
    }
    if (raced !== null) { lease.release(); return this.#replay(access.owner, raced, hash); }
    let releaseDone!: () => void;
    const done = new Promise<void>((resolve) => { releaseDone = resolve; });
    const job: LiveJob = {
      record, controller: new AbortController(), done, lease, releaseDone,
      startedAt: performance.now(), settled: false, released: false, output: null,
    };
    this.#live.set(record.job_id, job);
    // The daemon owns this promise; all exceptions are turned into job state.
    void this.#execute(job, input, access);
    return job.record;
  }
  #replay(owner: CommandJobOwner, prior: ExecutionReference, hash: string): CommandJobRecord {
    if (prior.request_hash !== hash) throw conflict();
    if (prior.job_id === null) throw new CommandJobFailure('COMMAND_REPLAY_SUPPRESSED', '这是旧版或结果未知的命令记录；没有启动第二个进程。请检查原执行，不得换键盲目重跑。');
    return this.record(owner, prior.job_id);
  }
  async #execute(job: LiveJob, input: CommandJobStartInput, access: CommandJobAccess): Promise<void> {
    const check = (): boolean => {
      let allowed = false;
      try { allowed = access.still_authorized(); } catch { /* fail closed */ }
      if (!allowed && !job.controller.signal.aborted) {
        this.#update(job, { state: 'CANCELLING', cancellation_reason: 'AUTHORIZATION_REVOKED' });
        job.controller.abort();
      }
      return allowed;
    };
    const watch = setInterval(check, COMMAND_JOB_LIMITS.authorization_poll_ms);
    watch.unref?.();
    check();
    let release = false;
    try {
      const result = await this.#options.processes.run({
        shell: input.shell, command: input.command, cwd: access.cwd, signal: job.controller.signal,
        on_started: () => { this.#update(job, { started: true, state: job.controller.signal.aborted ? 'CANCELLING' : 'RUNNING' }); },
        on_termination_confirmed: () => { job.lateTerminationConfirmed = true; this.#tryLateRecovery(job); },
      });
      release = result.termination_unknown !== true;
      const state = !release ? 'TERMINATION_UNKNOWN' : result.cancelled ? 'CANCELLED'
        : result.timed_out ? 'TIMED_OUT' : result.orphaned_output ? 'FAILED'
          : result.output_truncated ? 'OUTPUT_LIMIT' : !result.started || result.exit_code !== 0 ? 'FAILED' : 'EXITED';
      const allowed = check();
      let safe: { stdout: string; stderr: string; withheld: boolean };
      try { safe = allowed ? this.#options.sanitize(result.stdout, result.stderr) : { stdout: '', stderr: '', withheld: true }; }
      catch { safe = { stdout: '', stderr: '', withheld: true }; }
      job.output = { ...safe, expires: this.#now() + this.#retentionMs };
      try { this.#options.store.recordOutput?.(job.record, { ...safe, source_truncated: result.output_truncated }); }
      catch { process.emitWarning('Conversation output archive incomplete; execution result unchanged.', { code: 'LWB_ARCHIVE_INCOMPLETE' }); }
      this.#update(job, {
        state, started: result.started, exit_code: result.exit_code, duration_ms: result.duration_ms,
        timed_out: result.timed_out, output_truncated: result.output_truncated,
        termination_confirmed: release, failure_reason: !release ? 'TERMINATION_UNCONFIRMED'
          : result.orphaned_output ? 'ORPHANED_OUTPUT' : !result.started && !result.cancelled ? 'SPAWN_FAILED'
            : result.exit_code !== 0 && !result.cancelled && !result.timed_out && !result.output_truncated ? 'NONZERO_EXIT' : null,
      });
    } catch {
      // An unexpected driver rejection is not evidence that its process never ran.
      this.#update(job, { state: 'TERMINATION_UNKNOWN', termination_confirmed: false, failure_reason: 'PROCESS_RESULT_UNKNOWN' });
    } finally {
      clearInterval(watch);
      job.settled = true;
      this.#tryLateRecovery(job);
      if (release && !job.released) { job.released = true; job.lease.release(); }
      job.releaseDone();
      this.#prune();
    }
  }
  #update(job: LiveJob, patch: Partial<CommandJobRecord>): void {
    job.record = { ...job.record, ...patch, updated_at: this.#isoNow() };
    try { this.#options.store.save(job.record); }
    catch {
      this.#storageFault = true;
      job.record = { ...job.record, durable: false };
      if (!job.controller.signal.aborted && !job.settled) job.controller.abort();
    }
  }
  #prune(): void {
    const terminal: LiveJob[] = [];
    for (const job of this.#live.values()) {
      if (job.output !== null && job.output.expires <= this.#now()) job.output = null;
      if (job.released) terminal.push(job);
    }
    terminal.sort((a, b) => a.record.updated_at.localeCompare(b.record.updated_at));
    for (const job of terminal.slice(0, Math.max(0, terminal.length - this.#maxRetained))) this.#live.delete(job.record.job_id);
  }
  #isoNow(): string { return new Date(this.#now()).toISOString(); }
}
function conflict(): CommandJobFailure { return new CommandJobFailure('IDEMPOTENCY_CONFLICT', '该幂等键已用于另一条命令或工作区；本次没有启动进程。'); }
function full(): CommandJobFailure { return new CommandJobFailure('CONCURRENCY_LIMIT_EXCEEDED', '命令作业额度已满；本次没有启动进程。原任务仍可查询、取消，文件工具不受命令池占满影响。'); }
async function waitFor(done: Promise<void>, milliseconds: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try { await Promise.race([done, new Promise<void>((resolve) => { timer = setTimeout(resolve, milliseconds); })]); }
  finally { if (timer !== undefined) clearTimeout(timer); }
}
