/** Local-console session management. Never controls processes or touches execution/idempotency rows. */
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { ArchiveDatabase, ConversationArchiveRepo } from './conversation-archive.ts';
import { captureValue } from './archive-redaction.ts';
import {
  sessionListInput, sessionItemsInput, sessionUpdateInput, settingsUpdateInput,
  sessionSummarySchema, settingsSchema,
  type SessionListInput, type SessionItemsInput, type SessionUpdateInput,
  type SessionSummary, type ArchiveSettings, type ArchivePage, type ClearPreview, type ExportPage,
} from '../../contracts/src/conversation-management.ts';

type Row = Record<string, unknown>;
type Value = string | number | null;
const asRow = (value: unknown): Row => value as Row;
const CLOSED = "'EXITED','FAILED','CANCELLED','TIMED_OUT','OUTPUT_LIMIT','RECOVERED_UNKNOWN'";
const SUMMARY = `SELECT s.id,s.connection_id,s.local_title,s.title_source,s.attribution,s.created_at,s.last_activity_at,
 COALESCE(m.revision,0) AS revision,COALESCE(m.tags_json,'[]') AS tags_json,COALESCE(m.notes,'') AS notes,
 COALESCE(m.pinned,0) AS pinned,COALESCE(m.archived,0) AS archived,
 COALESCE(m.payload_generation,0) AS payload_generation,m.payloads_cleared_at,
 (SELECT count(*) FROM lwb_archive_calls c WHERE c.conversation_id=s.id) AS call_count,
 (SELECT count(*) FROM lwb_archive_calls c WHERE c.conversation_id=s.id AND c.phase NOT IN('returned','threw')) AS pending_calls,
 (SELECT count(*) FROM lwb_archive_calls c WHERE c.conversation_id=s.id AND (c.result_kind='tool_error' OR c.phase='threw')) AS failed_calls,
 (SELECT count(*) FROM lwb_archive_jobs j WHERE j.conversation_id=s.id) AS job_count,
 (SELECT count(*) FROM lwb_archive_jobs j WHERE j.conversation_id=s.id AND j.state IN('STARTING','RUNNING','CANCELLING')) AS running_jobs,
 (SELECT count(*) FROM lwb_archive_jobs j WHERE j.conversation_id=s.id AND j.state NOT IN(${CLOSED},'STARTING','RUNNING','CANCELLING')) AS unknown_jobs,
 (SELECT count(*) FROM lwb_archive_events e WHERE e.conversation_id=s.id) AS event_count,
 (SELECT COALESCE(sum(e.retained_bytes),0) FROM lwb_archive_events e WHERE e.conversation_id=s.id) AS event_bytes
 FROM lwb_archive_conversations s LEFT JOIN lwb_archive_conversation_meta m ON m.conversation_id=s.id`;
const escapedLike = (value: string): string => `%${value.replace(/[\\%_]/g,'\\$&')}%`;
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export class ConversationManagementError extends Error {
  constructor(readonly code: 'INVALID' | 'NOT_FOUND' | 'CONFLICT' | 'BUSY' | 'UNAVAILABLE',message:string) { super(message); }
}
function fail(code: ConversationManagementError['code'],message:string): never {throw new ConversationManagementError(code,message);}
function localActor(actor:string):void { if(!/^console:[^\s]{1,200}$/.test(actor))fail('INVALID','操作来源必须是已认证的本地控制台。'); }
export class ConversationManagementRepo {
  readonly #cursorKey = randomBytes(32);
  #nextMaintenance = 0;
  constructor(private readonly db:ArchiveDatabase,private readonly archive:ConversationArchiveRepo,
    private readonly now:()=>string=()=>new Date().toISOString()) {}
  #tx<T>(action:()=>T):T {
    const outer=!this.db.inTransaction,name=`session_${randomUUID().replaceAll('-','')}`;
    this.db.exec(outer?'BEGIN IMMEDIATE':`SAVEPOINT ${name}`);
    try {const out=action();this.db.exec(outer?'COMMIT':`RELEASE ${name}`);return out;}
    catch(error){try{this.db.exec(outer?'ROLLBACK':`ROLLBACK TO ${name}`);}finally{if(!outer)this.db.exec(`RELEASE ${name}`);}throw error;}
  }
  #token(value:Row):string {
    const body=Buffer.from(JSON.stringify({...value,expires:Date.parse(this.now())+30*60_000})).toString('base64url');
    return body+'.'+createHmac('sha256',this.#cursorKey).update(body).digest('base64url');
  }
  #untoken(token:string,scope:string):Row {
    try {
      if(token.length>4096)throw 0;
      const parts=token.split('.');if(parts.length!==2)throw 0;
      const body=parts[0]!,sig=Buffer.from(parts[1]!,'base64url');
      const expected=createHmac('sha256',this.#cursorKey).update(body).digest();
      if(sig.length!==expected.length||!timingSafeEqual(sig,expected))throw 0;
      const value=JSON.parse(Buffer.from(body,'base64url').toString('utf8')) as Row;
      if(value.scope!==scope||typeof value.expires!=='number'||value.expires<Date.parse(this.now()))throw 0;
      return value;
    }catch{ return fail('INVALID','分页或导出凭据已失效；请从第一页刷新。'); }
  }
  #summary(value:unknown):SessionSummary {
    const r=asRow(value);
    return sessionSummarySchema.parse({...r,tags:JSON.parse(String(r.tags_json)),pinned:r.pinned===1,archived:r.archived===1});
  }
  get(id:string):SessionSummary {
    const value=this.db.prepare(SUMMARY+' WHERE s.id=?').get(id);
    if(!value)fail('NOT_FOUND','没有找到此会话档案。');
    return this.#summary(value);
  }
  #meta(id:string):void {
    this.get(id);
    this.db.prepare('INSERT OR IGNORE INTO lwb_archive_conversation_meta(conversation_id,updated_at) VALUES(?,?)').run(id,this.now());
  }
  #audit(id:string|null,action:string,actor:string,detail:unknown):void {
    const captured=captureValue(detail,4096);
    this.db.prepare('INSERT INTO lwb_archive_management_events(conversation_id,action,actor,observed_at,detail_json) VALUES(?,?,?,?,?)')
      .run(id,action,actor,this.now(),captured.json);
  }
  list(raw:SessionListInput):{items:SessionSummary[];next_cursor:string|null;has_more:boolean} {
    const input=sessionListInput.parse(raw),where:string[]=[],values:Value[]=[];
    const bind=(sql:string,...args:Value[])=>{where.push(sql);values.push(...args);};
    if(input.query){const q=escapedLike(input.query);bind(`(s.local_title LIKE ? ESCAPE '\\' OR s.id LIKE ? ESCAPE '\\' OR COALESCE(m.notes,'') LIKE ? ESCAPE '\\'
      OR EXISTS(SELECT 1 FROM lwb_archive_calls c WHERE c.conversation_id=s.id AND c.tool LIKE ? ESCAPE '\\'))`,q,q,q,q);}
    if(input.tag)bind('EXISTS(SELECT 1 FROM json_each(COALESCE(m.tags_json,\'[]\')) WHERE value=?)',input.tag);
    if(input.connection_id)bind('s.connection_id=?',input.connection_id);
    if(input.workspace_id)bind('(EXISTS(SELECT 1 FROM lwb_archive_jobs j WHERE j.conversation_id=s.id AND j.workspace_id=?) OR EXISTS(SELECT 1 FROM lwb_archive_calls c WHERE c.conversation_id=s.id AND c.workspace_id=?))',input.workspace_id,input.workspace_id);
    if(input.attribution)bind('s.attribution=?',input.attribution);
    if(input.archived!=='all')bind('COALESCE(m.archived,0)=?',Number(input.archived==='archived'));
    if(input.pinned!==undefined)bind('COALESCE(m.pinned,0)=?',Number(input.pinned));
    if(input.state==='running')bind(`EXISTS(SELECT 1 FROM lwb_archive_jobs j WHERE j.conversation_id=s.id AND j.state IN('STARTING','RUNNING','CANCELLING'))`);
    if(input.state==='unknown')bind(`(EXISTS(SELECT 1 FROM lwb_archive_jobs j WHERE j.conversation_id=s.id AND j.state NOT IN(${CLOSED},'STARTING','RUNNING','CANCELLING'))
      OR EXISTS(SELECT 1 FROM lwb_archive_calls c WHERE c.conversation_id=s.id AND c.phase='interrupted'))`);
    if(input.state==='closed')bind(`NOT EXISTS(SELECT 1 FROM lwb_archive_jobs j WHERE j.conversation_id=s.id AND j.state NOT IN(${CLOSED}))
      AND NOT EXISTS(SELECT 1 FROM lwb_archive_calls c WHERE c.conversation_id=s.id AND c.phase NOT IN('returned','threw'))`);
    const {after:_after,max_items:_max,...filters}=input;const scope='list:'+digest(filters);
    if(input.after){const cur=this.#untoken(input.after,scope);bind(`(COALESCE(m.pinned,0),s.last_activity_at,s.id)<(?,?,?)`,Number(cur.pinned),String(cur.time),String(cur.id));}
    const found=this.db.prepare(SUMMARY+(where.length?' WHERE '+where.join(' AND '):'')+' ORDER BY COALESCE(m.pinned,0) DESC,s.last_activity_at DESC,s.id DESC LIMIT ?')
      .all(...values,input.max_items+1).map(v=>this.#summary(v));
    const more=found.length>input.max_items,items=found.slice(0,input.max_items),last=items.at(-1);
    return {items,has_more:more,next_cursor:more&&last?this.#token({scope,pinned:Number(last.pinned),time:last.last_activity_at,id:last.id}):null};
  }
  items(raw:SessionItemsInput):ArchivePage {
    const input=sessionItemsInput.parse(raw);this.get(input.conversation_id);
    const {after:_after,max_items:_max,...filters}=input,scope='items:'+digest(filters);
    const position=input.after?this.#untoken(input.after,scope):null;
    const values:Value[]=[input.conversation_id],where=['conversation_id=?'];
    let sql:string,order:string;
    if(input.kind==='events') {
      if(input.call_id){where.push('call_id=?');values.push(input.call_id);}
      if(input.job_id){where.push('job_id=?');values.push(input.job_id);}
      if(input.query){where.push("payload_json LIKE ? ESCAPE '\\'");values.push(escapedLike(input.query));}
      if(position){where.push('seq<?');values.push(Number(position.seq));}
      sql='SELECT seq,call_id,job_id,kind,observed_at,payload_json,original_bytes,retained_bytes,redacted,truncated,capture_policy FROM lwb_archive_events';order='seq DESC';
    }else if(input.kind==='management') {
      if(position){where.push('seq<?');values.push(Number(position.seq));}
      sql="SELECT seq,action,'local_console' AS actor,observed_at,detail_json AS payload_json FROM lwb_archive_management_events";order='seq DESC';
    }else if(input.kind==='calls') {
      if(position){where.push('(received_at,id)<(?,?)');values.push(String(position.time),String(position.id));}
      if(input.query){where.push("tool LIKE ? ESCAPE '\\'");values.push(escapedLike(input.query));}
      sql='SELECT id,request_id,tool,workspace_id,received_at,completed_at,phase,target_job_id,result_kind,delivery FROM lwb_archive_calls';order='received_at DESC,id DESC';
    }else {
      if(position){where.push('(updated_at,id)<(?,?)');values.push(String(position.time),String(position.id));}
      sql='SELECT id,origin_call_id,workspace_id,state,updated_at,output_capture FROM lwb_archive_jobs';order='updated_at DESC,id DESC';
    }
    const found=this.db.prepare(sql+' WHERE '+where.join(' AND ')+' ORDER BY '+order+' LIMIT ?').all(...values,input.max_items+1);
    const out:Row[]=[];let bytes=0;
    for(const item of found.slice(0,input.max_items)) {
      const r=asRow(item);const size=Buffer.byteLength(JSON.stringify(r));
      if(out.length&&bytes+size>196_608)break;
      bytes+=size;const {payload_json,...rest}=r;
      out.push(payload_json===undefined?rest:{...rest,payload:JSON.parse(String(payload_json))});
    }
    const last=out.at(-1),more=found.length>out.length;
    return {items:out,has_more:more,next_cursor:more&&last?this.#token({scope,seq:last.seq,id:last.id,time:last.received_at??last.updated_at}):null};
  }
  update(raw:SessionUpdateInput,actor:string):SessionSummary {
    localActor(actor);const input=sessionUpdateInput.parse(raw);
    return this.#tx(()=>{
      const previous=this.get(input.conversation_id);if(previous.revision!==input.expected_revision)fail('CONFLICT','会话已被另一操作修改；请刷新后重试。');
      this.#meta(input.conversation_id);
      const clean=JSON.parse(captureValue({title:input.local_title,tags:[...new Set(input.tags)],notes:input.notes},16_384).json) as {title:string;tags:string[];notes:string};
      this.db.prepare('UPDATE lwb_archive_conversations SET local_title=?,title_source=\'local_operator\' WHERE id=?').run(clean.title,input.conversation_id);
      this.db.prepare('UPDATE lwb_archive_conversation_meta SET revision=revision+1,tags_json=?,notes=?,pinned=?,archived=?,updated_at=? WHERE conversation_id=?')
        .run(JSON.stringify(clean.tags),clean.notes,Number(input.pinned),Number(input.archived),this.now(),input.conversation_id);
      this.#audit(input.conversation_id,'session_metadata_updated',actor,{previous_revision:previous.revision,revision:previous.revision+1,
        pinned:input.pinned,archived:input.archived,title_source:'local_operator'});
      return this.get(input.conversation_id);
    });
  }
  settings():ArchiveSettings {
    const v=asRow(this.db.prepare('SELECT revision,retention_days,automatic_retention,updated_at FROM lwb_archive_settings WHERE singleton=1').get());
    return settingsSchema.parse({...v,automatic_retention:v.automatic_retention===1});
  }
  configure(raw:unknown,actor:string):ArchiveSettings {
    localActor(actor);const input=settingsUpdateInput.parse(raw);
    return this.#tx(()=>{const current=this.settings();if(current.revision!==input.expected_revision)fail('CONFLICT','保留设置已变化；请刷新。');
      this.db.prepare('UPDATE lwb_archive_settings SET revision=revision+1,retention_days=?,automatic_retention=?,updated_at=? WHERE singleton=1')
        .run(input.retention_days,Number(input.automatic_retention),this.now());
      this.#audit(null,'retention_settings_updated',actor,{...input});this.#nextMaintenance=0;return this.settings();});
  }
  statistics():Record<string,number> {
    const n=(sql:string)=>Number(asRow(this.db.prepare(sql).get()).n);
    return {conversations:n('SELECT count(*) n FROM lwb_archive_conversations'),calls:n('SELECT count(*) n FROM lwb_archive_calls'),
      jobs:n('SELECT count(*) n FROM lwb_archive_jobs'),events:n('SELECT count(*) n FROM lwb_archive_events'),
      bytes:n('SELECT COALESCE(sum(retained_bytes),0) n FROM lwb_archive_events'),
      unassigned:n("SELECT count(*) n FROM lwb_archive_conversations WHERE attribution<>'client_meta'")};
  }
  clearPreview(id:string):ClearPreview {
    const s=this.get(id),blockers:string[]=[];
    if(s.pinned)blockers.push('会话已置顶保留，请先取消置顶。');
    if(s.pending_calls)blockers.push('仍有未结束的工具调用。');
    if(s.running_jobs||s.unknown_jobs)blockers.push('仍有运行中、终止未知或未识别状态的任务。');
    const high=Number(asRow(this.db.prepare('SELECT COALESCE(max(seq),0) n FROM lwb_archive_events WHERE conversation_id=?').get(id)).n);
    return {conversation_id:id,allowed:blockers.length===0,blockers,events:s.event_count,bytes:s.event_bytes,revision:s.revision,
      digest:digest([id,s.revision,s.payload_generation,s.event_count,s.event_bytes,high,s.pending_calls,s.running_jobs,s.unknown_jobs])};
  }
  #clear(id:string,actor:string):{events:number;bytes:number} {
    const preview=this.clearPreview(id);if(!preview.allowed)fail('BUSY',preview.blockers.join(' '));
    this.#meta(id);
    this.db.prepare('DELETE FROM lwb_archive_events WHERE conversation_id=?').run(id);
    this.db.prepare('UPDATE lwb_archive_conversation_meta SET revision=revision+1,payload_generation=payload_generation+1,payloads_cleared_at=?,updated_at=? WHERE conversation_id=?')
      .run(this.now(),this.now(),id);
    this.#audit(id,'session_payloads_cleared',actor,{events:preview.events,bytes:preview.bytes,execution_ledger_untouched:true,identity_and_job_links_retained:true});
    return {events:preview.events,bytes:preview.bytes};
  }
  clear(id:string,expected:string,confirmation:string,actor:string):{events:number;bytes:number} {
    localActor(actor);if(confirmation!==id)fail('INVALID','确认编号与会话不一致。');
    return this.#tx(()=>{const current=this.clearPreview(id);if(current.digest!==expected)fail('CONFLICT','预览后会话发生了变化，请重新预览。');return this.#clear(id,actor);});
  }
  retentionPreview():{items:ClearPreview[];has_more:boolean;cutoff:string;digest:string} {
    const settings=this.settings(),cutoff=new Date(Date.parse(this.now())-settings.retention_days*86_400_000).toISOString();
    const found=this.db.prepare(`SELECT s.id FROM lwb_archive_conversations s
      LEFT JOIN lwb_archive_conversation_meta m ON m.conversation_id=s.id WHERE s.last_activity_at<? AND COALESCE(m.pinned,0)=0
      AND EXISTS(SELECT 1 FROM lwb_archive_events e WHERE e.conversation_id=s.id)
      AND NOT EXISTS(SELECT 1 FROM lwb_archive_calls c WHERE c.conversation_id=s.id AND c.phase NOT IN('returned','threw'))
      AND NOT EXISTS(SELECT 1 FROM lwb_archive_jobs j WHERE j.conversation_id=s.id AND j.state NOT IN(${CLOSED}))
      ORDER BY s.last_activity_at,s.id LIMIT 51`).all(cutoff);
    const items=found.slice(0,50).map(v=>this.clearPreview(String(asRow(v).id)));
    return {items,has_more:found.length>50,cutoff,digest:digest([settings.revision,items.map(i=>i.digest)])};
  }
  prune(expected:string,actor:string):{sessions:number;events:number;bytes:number;has_more:boolean} {
    if(actor!=='daemon:retention')localActor(actor);
    return this.#tx(()=>{const preview=this.retentionPreview();if(preview.digest!==expected)fail('CONFLICT','清理预览已变化，请重新预览。');
      let events=0,bytes=0;for(const item of preview.items){const out=this.#clear(item.conversation_id,actor);events+=out.events;bytes+=out.bytes;}
      return {sessions:preview.items.length,events,bytes,has_more:preview.has_more};});
  }
  /** Bounded maintenance on startup and subsequent tool traffic, never a new command job. */
  autoPrune():void {
    const now=Date.parse(this.now());if(now<this.#nextMaintenance)return;this.#nextMaintenance=now+60*60_000;
    if(this.settings().automatic_retention){const p=this.retentionPreview();this.prune(p.digest,'daemon:retention');}
  }
  exportStart(id:string):ExportPage {
    return this.#tx(()=>{const header=this.get(id),high=this.archive.highWater();
      const token=this.#token({scope:'export',id,high,after:0,generation:header.payload_generation});
      const page=this.exportPage(token);
      return {...page,lines:[JSON.stringify({type:'session_archive',format_version:1,exported_at:this.now(),session:header,
        high_water:high,capture:'redacted_bounded',chat_transcript:false,client_delivery:'not_confirmed',
        consistency:page.consistency}),...page.lines]};});
  }
  exportPage(token:string):ExportPage {
    const c=this.#untoken(token,'export'),id=String(c.id),s=this.get(id);
    if(s.payload_generation!==c.generation)fail('CONFLICT','导出期间内容被清理，已停止导出；请重新开始。');
    const found=this.db.prepare('SELECT seq,call_id,job_id,kind,observed_at,payload_json,redacted,truncated,original_bytes,retained_bytes,capture_policy FROM lwb_archive_events WHERE conversation_id=? AND seq>? AND seq<=? ORDER BY seq LIMIT 101')
      .all(id,Number(c.after),Number(c.high));
    const lines:string[]=[];let bytes=0,last=Number(c.after);
    for(const value of found.slice(0,100)){
      const {payload_json,...event}=asRow(value),line=JSON.stringify({type:'event',...event,payload:JSON.parse(String(payload_json))});
      const size=Buffer.byteLength(line);if(lines.length&&bytes+size>196_608)break;
      lines.push(line);bytes+=size;last=Number(event.seq);
    }
    const more=found.length>lines.length;
    return {filename:`${id}.jsonl`,format:'jsonl',lines,has_more:more,
      next_cursor:more?this.#token({scope:'export',id,high:c.high,after:last,generation:c.generation}):null,
      high_water:Number(c.high),consistency:'header_at_start_and_immutable_events_through_high_water'};
  }
  recordCancellation(conversation:string,job:string,state:string,actor:string):void {
    localActor(actor);
    if(!this.jobBelongs(conversation,job))fail('NOT_FOUND','任务不属于会话。');
    this.#audit(conversation,'local_cancellation_requested',actor,{job_id:job,observed_state:state,termination_assumed:false});
  }
  jobBelongs(conversation:string,job:string):boolean {
    this.get(conversation);return Boolean(this.db.prepare('SELECT id FROM lwb_archive_jobs WHERE conversation_id=? AND id=?').get(conversation,job));
  }
}
