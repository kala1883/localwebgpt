/** SQLite-backed execution evidence. No filesystem access, no process control, no authorization. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { ConversationHint } from '../../contracts/src/conversation-archive.ts';
import { captureValue } from './archive-redaction.ts';

type SqlValue = string | number | bigint | null | Uint8Array;
interface Statement {
  run(...values: SqlValue[]): { changes: number | bigint };
  get(...values: SqlValue[]): unknown;
  all(...values: SqlValue[]): unknown[];
}
/** The small subset of better-sqlite3 used here; tests can use the same SQL with another driver. */
export interface ArchiveDatabase {
  readonly inTransaction: boolean;
  exec(sql: string): unknown;
  prepare(sql: string): Statement;
}
export interface ArchiveOwner { readonly principal_id: string; readonly connection_id: string }
export interface ArchiveCall {
  readonly id: string; readonly conversation_id: string; readonly owner: ArchiveOwner;
}
export interface ArchiveJob {
  readonly job_id: string; readonly owner: ArchiveOwner; readonly workspace_id: string;
  readonly state: string; readonly updated_at: string;
  readonly started?: boolean | null; readonly exit_code?: number | null;
  readonly timed_out?: boolean; readonly output_truncated?: boolean;
  readonly termination_confirmed?: boolean; readonly recovered?: boolean;
  readonly cancellation_reason?: string | null; readonly failure_reason?: string | null;
  readonly durable?: boolean; readonly resolution?: unknown;
}
export interface ArchiveLimits {
  readonly payload_bytes: number; readonly event_bytes: number; readonly events: number;
  readonly calls: number; readonly conversations: number; readonly retention_ms: number;
}
export const ARCHIVE_LIMITS: ArchiveLimits = Object.freeze({
  payload_bytes: 65_536, event_bytes: 128 * 1024 * 1024, events: 200_000,
  calls: 100_000, conversations: 20_000, retention_ms: 30 * 24 * 60 * 60_000,
});
// Unknown future states are protected too: retention only recognizes explicit closed states.
const CLOSED = ['EXITED','FAILED','CANCELLED','TIMED_OUT','OUTPUT_LIMIT','RECOVERED_UNKNOWN'];
const trace = new AsyncLocalStorage<{ repo: ConversationArchiveRepo; call: ArchiveCall }>();
const row = (v: unknown): Record<string, unknown> => v as Record<string, unknown>;
const sameOwner = (a: ArchiveOwner,b: ArchiveOwner) => a.principal_id === b.principal_id && a.connection_id === b.connection_id;
export class ArchiveUnavailable extends Error {
  constructor(readonly code: 'CAPACITY' | 'STORAGE' | 'INVALID' | 'OWNER', message: string) { super(message); }
}
function ownerOk(o: ArchiveOwner): void {
  if (![o.principal_id,o.connection_id].every(s => typeof s === 'string' && s.length > 0 && s.length <= 128)) {
    throw new ArchiveUnavailable('OWNER','Invalid authenticated archive owner.');
  }
}
function limit(n: number): number {
  if (!Number.isSafeInteger(n) || n < 1 || n > 200) throw new RangeError('Page size must be 1..200.');
  return n;
}
export class ConversationArchiveRepo {
  readonly instance_id = `archive_instance_${randomUUID()}`;
  readonly #limits: ArchiveLimits;
  readonly #now: () => string;
  #runtimeFault = false;
  constructor(private readonly db: ArchiveDatabase, now: () => string = () => new Date().toISOString(), limits: Partial<ArchiveLimits> = {}) {
    this.#now = now;
    this.#limits = { ...ARCHIVE_LIMITS, ...limits };
    for (const v of Object.values(this.#limits)) if (!Number.isSafeInteger(v) || v < 1) throw new RangeError('Invalid archive limit.');
    if (this.#limits.payload_bytes < 1024 || this.#limits.payload_bytes > 1_048_576) throw new RangeError('Invalid payload limit.');
  }
  /** Metadata is held per asynchronous invocation, not in a mutable connection-wide currentSession. */
  run<T>(call: ArchiveCall, fn: () => T): T { return trace.run({repo: this, call}, fn); }
  #tx<T>(fn: () => T): T {
    const outer = !this.db.inTransaction;
    const savepoint = `archive_${randomUUID().replaceAll('-','')}`;
    this.db.exec(outer ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${savepoint}`);
    try {
      const result = fn();
      this.db.exec(outer ? 'COMMIT' : `RELEASE ${savepoint}`);
      return result;
    } catch (error) {
      try { this.db.exec(outer ? 'ROLLBACK' : `ROLLBACK TO ${savepoint}`); }
      finally { if (!outer) this.db.exec(`RELEASE ${savepoint}`); }
      throw error;
    }
  }
  #key(): string {
    this.db.prepare('INSERT OR IGNORE INTO lwb_archive_config(singleton,correlation_key) VALUES(1,?)').run(randomBytes(32).toString('hex'));
    return String(row(this.db.prepare('SELECT correlation_key FROM lwb_archive_config WHERE singleton=1').get())['correlation_key']);
  }
  #room(forNewCall: boolean, bytes = 0): void {
    const usage = row(this.db.prepare('SELECT event_bytes,event_count FROM lwb_archive_config WHERE singleton=1').get());
    const factor = forNewCall ? 0.8 : 1; // Reserve space for already accepted work and final status evidence.
    if (Number(usage['event_bytes']) + bytes > this.#limits.event_bytes * factor ||
        Number(usage['event_count']) + 1 > this.#limits.events * factor) {
      throw new ArchiveUnavailable('CAPACITY','Archive capacity reached. Export/prune closed archives locally.');
    }
    if (forNewCall) {
      for (const [table,max] of [['lwb_archive_calls',this.#limits.calls],['lwb_archive_conversations',this.#limits.conversations]] as const) {
        const count = Number(row(this.db.prepare(`SELECT count(*) AS n FROM ${table}`).get())['n']);
        if (count >= max) throw new ArchiveUnavailable('CAPACITY','Archive row limit reached.');
      }
    }
  }
  #conversation(owner: ArchiveOwner,hint: ConversationHint,legacy = false): string {
    const key = this.#key();
    const digest = hint.status === 'present'
      ? createHmac('sha256',key).update(JSON.stringify([owner.principal_id,owner.connection_id,hint.session])).digest('hex') : null;
    if (digest !== null) {
      const prior = this.db.prepare('SELECT id FROM lwb_archive_conversations WHERE principal_id=? AND connection_id=? AND session_digest=?')
        .get(owner.principal_id,owner.connection_id,digest);
      if (prior) return String(row(prior)['id']);
    }
    const id = `conversation_${randomUUID()}`;
    const attribution = legacy ? 'unassigned_legacy' : hint.status === 'present' ? 'client_meta' : `unassigned_${hint.status}`;
    const title = hint.status === 'present' ? `本地会话 ${this.#now().slice(0,10)} ${id.slice(-8)}`
      : legacy ? `历史任务：会话未归属 ${id.slice(-8)}` : `未取得网页会话标识 ${id.slice(-8)}`;
    this.db.prepare(`INSERT INTO lwb_archive_conversations
      (id,principal_id,connection_id,session_digest,attribution,local_title,created_at,last_activity_at) VALUES(?,?,?,?,?,?,?,?)`)
      .run(id,owner.principal_id,owner.connection_id,digest,attribution,title,this.#now(),this.#now());
    return id;
  }
  #event(conversation: string,call: string | null,job: string | null,kind: string,value: unknown): void {
    const captured = captureValue(value,this.#limits.payload_bytes);
    this.#room(false,captured.retained_bytes);
    this.db.prepare(`INSERT INTO lwb_archive_events
      (conversation_id,call_id,job_id,kind,observed_at,payload_json,original_bytes,retained_bytes,redacted,truncated)
      VALUES(?,?,?,?,?,?,?,?,?,?)`).run(conversation,call,job,kind,this.#now(),captured.json,
        captured.original_bytes,captured.retained_bytes,Number(captured.redacted),Number(captured.truncated));
    this.db.prepare('UPDATE lwb_archive_conversations SET last_activity_at=? WHERE id=?').run(this.#now(),conversation);
  }
  begin(owner: ArchiveOwner,hint: ConversationHint,requestId: string,tool: string,input: unknown): ArchiveCall {
    ownerOk(owner);
    if (typeof requestId !== 'string' || requestId.length > 256 || !/^[a-z][a-z0-9_]{0,127}$/.test(tool)) {
      throw new ArchiveUnavailable('INVALID','Invalid invocation metadata.');
    }
    if (hint.status === 'present' && (typeof hint.session !== 'string' || !hint.session || hint.session.length > 512)) {
      throw new ArchiveUnavailable('INVALID','Invalid session hint.');
    }
    return this.#tx(() => {
      this.#key(); this.#room(true);
      const conversation = this.#conversation(owner,hint);
      const id = `call_${randomUUID()}`;
      const rawWorkspace = input !== null && typeof input === 'object' && !Array.isArray(input)
        ? (input as Record<string, unknown>)['workspace_id'] : undefined;
      const workspace = typeof rawWorkspace === 'string' && rawWorkspace.length <= 128 ? rawWorkspace : null;
      // This is provenance supplied with the tool call, not a grant or an authorization claim.
      this.db.prepare(`INSERT INTO lwb_archive_calls(id,conversation_id,instance_id,request_id,tool,received_at,phase,workspace_id)
        VALUES(?,?,?,?,?,?,'received',?)`).run(id,conversation,this.instance_id,requestId,tool,this.#now(),workspace);
      this.#event(conversation,id,null,'tool_request_received',{tool,input,session_attribution:hint.status});
      return { id, conversation_id: conversation, owner: {...owner} };
    });
  }
  #call(call: ArchiveCall): Record<string, unknown> {
    const found = this.db.prepare(`SELECT c.* FROM lwb_archive_calls c JOIN lwb_archive_conversations s ON s.id=c.conversation_id
      WHERE c.id=? AND s.principal_id=? AND s.connection_id=?`).get(call.id,call.owner.principal_id,call.owner.connection_id);
    if (!found || row(found)['conversation_id'] !== call.conversation_id) throw new ArchiveUnavailable('OWNER','Archive call is outside its owner scope.');
    return row(found);
  }
  complete(call: ArchiveCall,result: unknown,threw = false): void {
    this.#tx(() => {
      const current = this.#call(call);
      if (current['phase'] !== 'received') throw new ArchiveUnavailable('INVALID','Call response already recorded.');
      const value = result !== null && typeof result === 'object' ? row(result) : {};
      const data = value['data'] !== null && typeof value['data'] === 'object' ? row(value['data']) : {};
      let target: string | null = null;
      if (typeof data['job_id'] === 'string') {
        const job = this.db.prepare('SELECT principal_id,connection_id FROM lwb_archive_jobs WHERE id=?').get(data['job_id']);
        if (job && sameOwner(row(job) as unknown as ArchiveOwner,call.owner)) target = data['job_id'];
      }
      this.#event(call.conversation_id,call.id,null,threw ? 'handler_exception' : 'tool_result_prepared',result);
      this.db.prepare(`UPDATE lwb_archive_calls SET phase=?,completed_at=?,target_job_id=?,result_kind=? WHERE id=?`)
        .run(threw ? 'threw' : 'returned',this.#now(),target,value['ok'] === false ? 'tool_error' : 'handler_result',call.id);
    });
  }
  /** Called inside the existing pre-spawn claim transaction. Replays never re-parent a job. */
  observeJob(record: ArchiveJob): void {
    ownerOk(record.owner);
    this.#tx(() => {
      this.#key();
      const current = this.db.prepare('SELECT * FROM lwb_archive_jobs WHERE id=?').get(record.job_id);
      let conversation: string, origin: string | null;
      if (current) {
        const r = row(current);
        if (!sameOwner(r as unknown as ArchiveOwner,record.owner)) throw new ArchiveUnavailable('OWNER','Job owner mismatch.');
        conversation = String(r['conversation_id']); origin = r['origin_call_id'] as string | null;
      } else {
        const ctx = trace.getStore();
        const scoped = ctx?.repo === this && sameOwner(ctx.call.owner,record.owner) ? ctx.call : undefined;
        if (scoped) {
          const c = this.#call(scoped);
          if (c['tool'] !== 'command_exec') throw new ArchiveUnavailable('INVALID','Only command_exec can create a job origin.');
          conversation = scoped.conversation_id; origin = scoped.id;
        } else { conversation = this.#conversation(record.owner,{status:'missing'},true); origin = null; }
        this.db.prepare(`INSERT INTO lwb_archive_jobs(id,conversation_id,origin_call_id,principal_id,connection_id,workspace_id,state,updated_at,snapshot_signature)
          VALUES(?,?,?,?,?,?,?,?,?)`).run(record.job_id,conversation,origin,record.owner.principal_id,record.owner.connection_id,
            record.workspace_id,record.state,record.updated_at,'');
      }
      const snapshot = {
        state:record.state,started:record.started,exit_code:record.exit_code,timed_out:record.timed_out,
        output_truncated:record.output_truncated,termination_confirmed:record.termination_confirmed,
        recovered:record.recovered,cancellation_reason:record.cancellation_reason,failure_reason:record.failure_reason,
        durable:record.durable,resolution:record.resolution,
      };
      const signature = createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
      if (current && row(current)['snapshot_signature'] === signature) return;
      this.#event(conversation,origin,record.job_id,current ? 'job_state_changed' : 'job_first_observed',
        {...snapshot,record_updated_at:record.updated_at,previous_state:current ? row(current)['state'] : null});
      this.db.prepare('UPDATE lwb_archive_jobs SET state=?,updated_at=?,snapshot_signature=? WHERE id=?')
        .run(record.state,record.updated_at,signature,record.job_id);
    });
  }
  /** Evidence logging must not falsify execution state or prevent a confirmed slot release. */
  observeJobBestEffort(record: ArchiveJob): void { try { this.observeJob(record); } catch { this.noteFault('state'); } }
  output(record: ArchiveJob,output: {stdout:string;stderr:string;withheld:boolean;source_truncated:boolean}): void {
    this.#tx(() => {
      const found = this.db.prepare('SELECT * FROM lwb_archive_jobs WHERE id=?').get(record.job_id);
      if (!found || !sameOwner(row(found) as unknown as ArchiveOwner,record.owner)) throw new ArchiveUnavailable('OWNER','Unknown job output owner.');
      const job = row(found);
      if (job['output_capture'] === 'captured') return;
      this.#event(String(job['conversation_id']),job['origin_call_id'] as string | null,record.job_id,'command_output_observed',{
        stdout:output.withheld ? '' : output.stdout,stderr:output.withheld ? '' : output.stderr,
        withheld:output.withheld,source_truncated:output.source_truncated,source:'executor_sanitized_bounded_output',
        raw_stream_archived:false,
      });
      this.db.prepare("UPDATE lwb_archive_jobs SET output_capture='captured' WHERE id=?").run(record.job_id);
    });
  }
  noteFault(stage: 'state' | 'output' | 'call'): void {
    this.#runtimeFault = true;
    // No command text, metadata values, paths or driver exception messages in the warning.
    process.emitWarning(`Conversation archive incomplete at ${stage}; execution state is unchanged.`,{code:'LWB_ARCHIVE_INCOMPLETE'});
  }
  /** Only the singleton daemon's startup calls this. An interrupted call is NEVER replayed here. */
  recoverInterruptedCalls(): number {
    return this.#tx(() => {
      this.#key();
      const previous = this.db.prepare("SELECT id,conversation_id FROM lwb_archive_calls WHERE phase='received' AND instance_id<>?").all(this.instance_id);
      for (const item of previous) {
        const c = row(item);
        this.#event(String(c['conversation_id']),String(c['id']),null,'call_interrupted_by_restart',{outcome:'unknown',replayed:false});
        this.db.prepare("UPDATE lwb_archive_calls SET phase='interrupted',completed_at=? WHERE id=?").run(this.#now(),String(c['id']));
      }
      return previous.length;
    });
  }
  status(): Record<string, unknown> {
    const usage = this.db.prepare('SELECT event_bytes,event_count FROM lwb_archive_config WHERE singleton=1').get();
    return {initialized:Boolean(usage),...(usage ? row(usage) : {event_bytes:0,event_count:0}),limits:this.#limits,
      runtime_fault:this.#runtimeFault,health_scope:'this_repository_instance_not_a_live_daemon_probe',capture_policy:'redacted-v1',raw_stream_archived:false,
      client_delivery:'not_confirmed',chat_transcript_archived:false,
      interrupted_calls:Number(row(this.db.prepare("SELECT count(*) AS n FROM lwb_archive_calls WHERE phase='interrupted'").get())['n']),
      outputs_not_captured:Number(row(this.db.prepare("SELECT count(*) AS n FROM lwb_archive_jobs WHERE output_capture='not_captured'").get())['n'])};
  }
  localOwners(): ArchiveOwner[] {
    return this.db.prepare('SELECT DISTINCT principal_id,connection_id FROM lwb_archive_conversations ORDER BY principal_id,connection_id').all() as ArchiveOwner[];
  }
  conversations(owner: ArchiveOwner,after = '',max = 100): unknown[] {
    ownerOk(owner);
    return this.db.prepare(`SELECT id,attribution,local_title,title_source,created_at,last_activity_at FROM lwb_archive_conversations
      WHERE principal_id=? AND connection_id=? AND id>? ORDER BY id LIMIT ?`).all(owner.principal_id,owner.connection_id,after,limit(max));
  }
  #ownedConversation(owner: ArchiveOwner,id: string): void {
    ownerOk(owner);
    if (!this.db.prepare('SELECT id FROM lwb_archive_conversations WHERE id=? AND principal_id=? AND connection_id=?')
      .get(id,owner.principal_id,owner.connection_id)) throw new ArchiveUnavailable('OWNER','Conversation not found in owner scope.');
  }
  events(owner: ArchiveOwner,conversation: string,after = 0,max = 100,highWater = Number.MAX_SAFE_INTEGER): unknown[] {
    this.#ownedConversation(owner,conversation);
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(highWater) || highWater < after) throw new RangeError('Invalid event cursor.');
    return this.db.prepare(`SELECT seq,call_id,job_id,kind,observed_at,payload_json,original_bytes,retained_bytes,redacted,truncated,capture_policy
      FROM lwb_archive_events WHERE conversation_id=? AND seq>? AND seq<=? ORDER BY seq LIMIT ?`)
      .all(conversation,after,highWater,limit(max)).map(item => {const v = row(item); const {payload_json,...other} = v;return {...other,payload:JSON.parse(String(payload_json))};});
  }
  calls(owner: ArchiveOwner,conversation: string,after = '',max = 100): unknown[] {
    this.#ownedConversation(owner,conversation);
    return this.db.prepare(`SELECT id,request_id,tool,workspace_id,received_at,completed_at,phase,target_job_id,result_kind,delivery
      FROM lwb_archive_calls WHERE conversation_id=? AND id>? ORDER BY id LIMIT ?`).all(conversation,after,limit(max));
  }
  jobs(owner: ArchiveOwner,conversation: string,after = '',max = 100): unknown[] {
    this.#ownedConversation(owner,conversation);
    return this.db.prepare(`SELECT id,origin_call_id,workspace_id,state,updated_at,output_capture
      FROM lwb_archive_jobs WHERE conversation_id=? AND id>? ORDER BY id LIMIT ?`).all(conversation,after,limit(max));
  }
  highWater(): number { return Number(row(this.db.prepare('SELECT COALESCE(MAX(seq),0) AS n FROM lwb_archive_events').get())['n']); }
  /** Deletes ONLY complete, inactive archive groups, never execution/idempotency records. */
  prune(before = new Date(Date.parse(this.#now()) - this.#limits.retention_ms).toISOString(),max = 100): number {
    if (!Number.isFinite(Date.parse(before))) throw new RangeError('Invalid retention cutoff.');
    const cutoff = new Date(before).toISOString(); limit(max);
    return this.#tx(() => {
      const ids = this.db.prepare(`SELECT s.id FROM lwb_archive_conversations s WHERE s.last_activity_at<?
        AND NOT EXISTS(SELECT 1 FROM lwb_archive_calls c WHERE c.conversation_id=s.id AND c.phase='received')
        AND NOT EXISTS(SELECT 1 FROM lwb_archive_jobs j WHERE j.conversation_id=s.id AND j.state NOT IN (?,?,?,?,?,?))
        ORDER BY s.last_activity_at,s.id LIMIT ?`).all(cutoff,...CLOSED,max);
      for (const item of ids) this.db.prepare('DELETE FROM lwb_archive_conversations WHERE id=?').run(String(row(item)['id']));
      return ids.length;
    });
  }
}
