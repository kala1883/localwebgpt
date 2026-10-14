import {CONVERSATION_MANAGEMENT_MIGRATION} from '../../packages/persistence/src/conversation-management-schema.ts';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createRequire} from 'node:module';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ConversationArchiveRepo, type ArchiveDatabase,type ArchiveJob,type ArchiveLimits} from '../../packages/persistence/src/conversation-archive.ts';
import {CONVERSATION_ARCHIVE_MIGRATION} from '../../packages/persistence/src/conversation-archive-schema.ts';
import {captureValue} from '../../packages/persistence/src/archive-redaction.ts';
import {conversationHint,parseArchivedInvocation} from '../../packages/contracts/src/conversation-archive.ts';
const require = createRequire(import.meta.url);
// Production project defaults to its real better-sqlite3 dependency. The isolated runner explicitly
// selects node:sqlite. Both execute real SQLite SQL; the alternate driver is not production evidence.
const builtin = process.env['LWB_ARCHIVE_TEST_DRIVER'] === 'builtin';
function database(path = ':memory:') {
  const raw = builtin ? new (require('node:sqlite').DatabaseSync)(path) : new (require('better-sqlite3'))(path);
  raw.exec('PRAGMA foreign_keys=ON;');
  const db: ArchiveDatabase = {get inTransaction(){return builtin ? raw.isTransaction : raw.inTransaction;},
    exec(sql){return raw.exec(sql);},prepare(sql){return raw.prepare(sql);}};
  return {db,raw};
}
function setup(options:Partial<ArchiveLimits> = {}) {
  const d = database();for(const m of [CONVERSATION_ARCHIVE_MIGRATION,CONVERSATION_MANAGEMENT_MIGRATION])for(const s of m.statements)d.db.exec(s);
  let now = '2026-01-01T00:00:00.000Z';
  return {...d,repo:new ConversationArchiveRepo(d.db,()=>now,options),time(s:string){now=s;},close(){d.raw.close();}};
}
const owner = {principal_id:'p1',connection_id:'conn-one'};
const owner2 = {principal_id:'p2',connection_id:'conn-two'};
const hint = {status:'present' as const,session:'v1/session-alpha'};
const job = (id:string):ArchiveJob => ({job_id:id,owner,workspace_id:'ws_test',state:'STARTING',updated_at:'2026-01-01T00:00:00.000Z',started:null});
const rows = (h:ReturnType<typeof setup>,sql:string) => h.raw.prepare(sql).all() as Record<string,unknown>[];
function start(h:ReturnType<typeof setup>,session = hint.session,tool = 'command_exec') {
  return h.repo.begin(owner,{status:'present',session},'req_1',tool,{command:'echo one',idempotency_key:'k'});
}
function observe(h:ReturnType<typeof setup>,j:ArchiveJob,c = start(h)) {h.repo.run(c,()=>h.repo.observeJob(j));return c;}

test('metadata: valid value is extracted only from the named client field',()=>{
  assert.deepEqual(conversationHint({'openai/session':'v1/opaque','openai/userLocation':{city:'ignored'}}),{status:'present',session:'v1/opaque'});
  assert.deepEqual(conversationHint({arguments:{'_meta':{'openai/session':'fake'}}}),{status:'missing'});
});
test('metadata: absence and invalid values are distinct, never replaced by a guessed session',()=>{
  assert.deepEqual(conversationHint(undefined),{status:'missing'});
  for(const value of [null,1,{},'', 'a b','x'.repeat(513),'abc\n']) assert.equal(conversationHint({'openai/session':value}).status,'invalid');
});
test('metadata: inherited and unrecognized fields are not accepted',()=>{
  assert.deepEqual(conversationHint(Object.create({'openai/session':'inherited'})),{status:'missing'});
  assert.throws(()=>parseArchivedInvocation({name:'file_read',input:{},conversation:hint,connection_id:'fake'}));
  assert.throws(()=>parseArchivedInvocation({name:'file_read',input:{},conversation:{status:'missing',session:'fake'}}));
});
test('metadata: malformed correlation fails validation before dispatch',()=>{
  assert.throws(()=>parseArchivedInvocation({name:'command_exec',conversation:{status:'present',session:''}}));
  assert.equal(parseArchivedInvocation({name:'file_read',input:{path:'x'},conversation:{status:'missing'}}).name,'file_read');
});
test('same external session and authenticated owner reuse one local conversation',()=>{
  const h=setup();try{const a=start(h),b=start(h);assert.equal(a.conversation_id,b.conversation_id);assert.notEqual(a.id,b.id);}finally{h.close();}
});
test('different external sessions never share a conversation',()=>{
  const h=setup();try{assert.notEqual(start(h,'a').conversation_id,start(h,'b').conversation_id);}finally{h.close();}
});
test('external session is scoped by authenticated principal AND connection',()=>{
  const h=setup();try{const a=start(h);for(const o of [owner2,{...owner,connection_id:'another'}]){
    const b=h.repo.begin(o,hint,'req_1','file_read',{});assert.notEqual(a.conversation_id,b.conversation_id);
  }}finally{h.close();}
});
test('missing and invalid metadata create explicitly unassigned per-call groups, not one fake chat',()=>{
  const h=setup();try{const a=h.repo.begin(owner,{status:'missing'},'req_1','file_read',{});
    const b=h.repo.begin(owner,{status:'missing'},'req_1','file_read',{});assert.notEqual(a.conversation_id,b.conversation_id);
    h.repo.begin(owner,{status:'invalid'},'req_2','file_read',{});
    assert.deepEqual(new Set(rows(h,'SELECT attribution FROM lwb_archive_conversations').map(x=>x['attribution'])),new Set(['unassigned_missing','unassigned_invalid']));
  }finally{h.close();}
});
test('raw session metadata is not written into any retained event or conversation row',()=>{
  const h=setup();try{start(h,'v1/PRIVATE_SESSION_SHOULD_NOT_APPEAR');const dump=JSON.stringify([
    ...rows(h,'SELECT * FROM lwb_archive_conversations'),...rows(h,'SELECT * FROM lwb_archive_events')]);
    assert.doesNotMatch(dump,/PRIVATE_SESSION_SHOULD_NOT_APPEAR/);assert.match(String(rows(h,'SELECT session_digest FROM lwb_archive_conversations')[0]?.['session_digest']),/^[0-9a-f]{64}$/);
  }finally{h.close();}
});
test('request id reuse does not overwrite earlier calls',()=>{
  const h=setup();try{start(h);start(h);assert.equal(rows(h,'SELECT * FROM lwb_archive_calls').length,2);}finally{h.close();}
});
test('a denied tool call retains its error response but creates no command job',()=>{
  const h=setup();try{const c=start(h);h.repo.complete(c,{ok:false,error:{code:'NOT_AUTHORIZED'}});
    assert.equal(rows(h,'SELECT * FROM lwb_archive_jobs').length,0);
    assert.equal(rows(h,'SELECT result_kind FROM lwb_archive_calls')[0]?.['result_kind'],'tool_error');
  }finally{h.close();}
});
test('RUNNING response is not confused with command completion or confirmed client delivery',()=>{
  const h=setup();try{const j={...job('job-running'),state:'RUNNING'};const c=observe(h,j);
    h.repo.complete(c,{ok:true,data:{job_id:j.job_id,state:'RUNNING'}});
    assert.equal(rows(h,'SELECT state FROM lwb_archive_jobs')[0]?.['state'],'RUNNING');
    assert.equal(rows(h,'SELECT delivery FROM lwb_archive_calls')[0]?.['delivery'],'not_confirmed');
  }finally{h.close();}
});
test('asynchronous overlapping calls keep their own origins',async()=>{
  const h=setup();try{const a=start(h,'alpha'),b=start(h,'beta');await Promise.all([
    h.repo.run(a,async()=>{await new Promise(r=>setTimeout(r,15));h.repo.observeJob(job('ja'));}),
    h.repo.run(b,async()=>{await new Promise(r=>setTimeout(r,1));h.repo.observeJob(job('jb'));})]);
    const j=rows(h,'SELECT id,conversation_id FROM lwb_archive_jobs');
    assert.equal(j.find(x=>x['id']==='ja')?.['conversation_id'],a.conversation_id);
    assert.equal(j.find(x=>x['id']==='jb')?.['conversation_id'],b.conversation_id);
  }finally{h.close();}
});
test('job state changes and recovery evidence are append-only and deduplicated',()=>{
  const h=setup();try{const j=job('jstates');const c=observe(h,j);h.repo.observeJob(j);
    h.repo.observeJob({...j,state:'RUNNING',started:true});h.repo.observeJob({...j,state:'TERMINATION_UNKNOWN'});
    h.repo.observeJob({...j,state:'RECOVERED_UNKNOWN',resolution:{source:'local_operator',basis:'process_tree_checked'}});
    const events=h.repo.events(owner,c.conversation_id) as {kind:string;payload:Record<string,unknown>}[];
    assert.equal(events.filter(x=>x.kind.startsWith('job_')).length,4);
    assert.equal(events.at(-1)?.payload['state'],'RECOVERED_UNKNOWN');
    assert.throws(()=>h.db.exec("UPDATE lwb_archive_events SET kind='forged'"),/append-only/);
  }finally{h.close();}
});
test('a replay or later query in another conversation references but does not move the original job',()=>{
  const h=setup();try{const j=job('jorigin');const a=observe(h,j,start(h,'origin'));h.repo.complete(a,{ok:true,data:{job_id:j.job_id}});
    const b=start(h,'later');h.repo.complete(b,{ok:true,data:{job_id:j.job_id}});
    assert.equal(rows(h,'SELECT conversation_id FROM lwb_archive_jobs')[0]?.['conversation_id'],a.conversation_id);
    assert.equal(rows(h,`SELECT target_job_id FROM lwb_archive_calls WHERE id='${b.id}'`)[0]?.['target_job_id'],j.job_id);
    assert.equal(rows(h,'SELECT * FROM lwb_archive_jobs').length,1);
  }finally{h.close();}
});
test('legacy jobs without a captured invocation remain explicitly unattributed',()=>{
  const h=setup();try{start(h,'current');h.repo.observeJob({...job('legacy'),state:'TERMINATION_UNKNOWN'});
    assert.equal(rows(h,"SELECT attribution FROM lwb_archive_conversations s JOIN lwb_archive_jobs j ON s.id=j.conversation_id")[0]?.['attribution'],'unassigned_legacy');
  }finally{h.close();}
});
test('parent claim rollback also rolls back job origin and initial archive event',()=>{
  const h=setup();try{const c=start(h);h.db.exec('BEGIN IMMEDIATE');h.repo.run(c,()=>h.repo.observeJob(job('rollback')));h.db.exec('ROLLBACK');
    assert.equal(rows(h,'SELECT * FROM lwb_archive_jobs').length,0);
    assert.equal(rows(h,'SELECT * FROM lwb_archive_events').length,1);
  }finally{h.close();}
});
test('archive reads and completions enforce their owner scope',()=>{
  const h=setup();try{const c=start(h);
    assert.throws(()=>h.repo.events(owner2,c.conversation_id));assert.throws(()=>h.repo.jobs(owner2,c.conversation_id));
    assert.throws(()=>h.repo.complete({...c,owner:owner2},{ok:true}));
  }finally{h.close();}
});
test('output capture is distinct from the returned tool result and preserves truncation/withholding facts',()=>{
  const h=setup();try{const j=job('output');const c=observe(h,j);
    h.repo.output(j,{stdout:'hello',stderr:'warning',withheld:false,source_truncated:true});
    h.repo.output(j,{stdout:'duplicate',stderr:'',withheld:false,source_truncated:false});
    const ev=(h.repo.events(owner,c.conversation_id) as {kind:string;payload:Record<string,unknown>}[]).filter(e=>e.kind==='command_output_observed');
    assert.equal(ev.length,1);assert.equal(ev[0]?.payload['stdout'],'hello');assert.equal(ev[0]?.payload['source_truncated'],true);
    assert.equal(ev[0]?.payload['raw_stream_archived'],false);
  }finally{h.close();}
});
test('withheld output is never archived as if it were visible raw content',()=>{
  const h=setup();try{const j=job('withheld');const c=observe(h,j);
    h.repo.output(j,{stdout:'PRIVATE',stderr:'PRIVATE',withheld:true,source_truncated:false});
    assert.doesNotMatch(JSON.stringify(h.repo.events(owner,c.conversation_id)),/PRIVATE/);
  }finally{h.close();}
});
test('redaction handles secret fields, command options, bearer credentials and private keys',()=>{
  const c=captureValue({password:'hide-field',read_token:'hide-ticket',command:'curl --token hide-option -H "Bearer abcdefghijklmnop"',
    text:'-----BEGIN PRIVATE KEY-----\nMATERIAL\n-----END PRIVATE KEY-----'});
  assert.equal(c.redacted,true);assert.doesNotMatch(c.json,/hide-field|hide-ticket|hide-option|abcdefghijklmnop|MATERIAL/);
});
test('redaction happens before UTF-8 payload truncation and retained JSON remains parseable',()=>{
  const c=captureValue({command:'x'.repeat(1010)+' --password "should-not-leak" '+ '你好'.repeat(3000)},1024);
  assert.equal(c.truncated,true);assert.equal(c.redacted,true);assert.ok(c.retained_bytes<=1024);
  assert.doesNotMatch(c.json,/should-not-leak/);assert.doesNotThrow(()=>JSON.parse(c.json));
});
test('capture bounds deep, cyclic and very wide input structures',()=>{
  const cyclic:{self?:unknown}={};cyclic.self=cyclic;assert.equal(captureValue(cyclic).truncated,true);
  assert.equal(captureValue(Array.from({length:1100},()=>1)).truncated,true);
});
test('capacity refusal is atomic and does not manufacture a second accepted call',()=>{
  const h=setup({calls:1});try{const a=start(h);h.repo.complete(a,{ok:true});assert.throws(()=>start(h,'second'),/limit/);
    assert.equal(rows(h,'SELECT * FROM lwb_archive_calls').length,1);assert.equal(rows(h,'SELECT * FROM lwb_archive_conversations').length,1);
  }finally{h.close();}
});
test('final result space remains available after admission closes',()=>{
  const h=setup({events:10});try{const calls=Array.from({length:8},(_,i)=>start(h,'s'+i));assert.throws(()=>start(h,'overflow'),/capacity/);
    h.repo.complete(calls[0]!,{ok:true});h.repo.complete(calls[1]!,{ok:true});assert.equal(h.repo.status()['event_count'],10);
  }finally{h.close();}
});
test('failed result capture leaves the original received call, never a false completed response',()=>{
  const h=setup();try{const c=start(h);h.db.exec("CREATE TRIGGER reject_result BEFORE INSERT ON lwb_archive_events WHEN NEW.kind='tool_result_prepared' BEGIN SELECT RAISE(ABORT,'fault'); END");
    assert.throws(()=>h.repo.complete(c,{ok:true}),/fault/);assert.equal(rows(h,'SELECT phase FROM lwb_archive_calls')[0]?.['phase'],'received');
  }finally{h.close();}
});
test('retention protects active and unknown jobs and only prunes closed archive groups',()=>{
  const h=setup();try{const done=observe(h,{...job('done'),state:'EXITED'},start(h,'done'));h.repo.complete(done,{ok:true});
    const unknown=observe(h,{...job('unknown'),state:'TERMINATION_UNKNOWN'},start(h,'unknown'));h.repo.complete(unknown,{ok:true});
    start(h,'pending');h.time('2026-03-01T00:00:00.000Z');assert.equal(h.repo.prune(),1);
    assert.equal(rows(h,'SELECT * FROM lwb_archive_conversations').length,2);assert.equal(rows(h,'SELECT state FROM lwb_archive_jobs')[0]?.['state'],'TERMINATION_UNKNOWN');
  }finally{h.close();}
});
test('retention accounting equals the actual retained event bytes after cascaded deletions',()=>{
  const h=setup();try{const c=start(h);h.repo.complete(c,{ok:true});h.time('2026-03-01T00:00:00.000Z');h.repo.prune();
    assert.equal(h.repo.status()['event_bytes'],0);assert.equal(h.repo.status()['event_count'],0);
  }finally{h.close();}
});
test('event pagination is ordered, bounded and supports a fixed export high-water mark',()=>{
  const h=setup();try{const c=start(h);const high=h.repo.highWater();h.repo.complete(c,{ok:true});
    const p=h.repo.events(owner,c.conversation_id,0,1) as {seq:number}[];assert.equal(p.length,1);
    assert.equal(h.repo.events(owner,c.conversation_id,p[0]!.seq,1).length,1);
    assert.equal(h.repo.events(owner,c.conversation_id,0,100,high).length,1);
    assert.throws(()=>h.repo.events(owner,c.conversation_id,0,201));
  }finally{h.close();}
});
test('database reopen preserves correlation and marks unanswered calls interrupted, without replaying jobs',()=>{
  const dir=mkdtempSync(join(tmpdir(),'lwb-archive-test-'));const file=join(dir,'test.sqlite');
  let d=database(file);try{
    for(const m of [CONVERSATION_ARCHIVE_MIGRATION,CONVERSATION_MANAGEMENT_MIGRATION])for(const s of m.statements)d.db.exec(s);
    let repo=new ConversationArchiveRepo(d.db);const a=repo.begin(owner,hint,'req_same','command_exec',{});
    repo.run(a,()=>repo.observeJob(job('persisted')));d.raw.close();d=database(file);repo=new ConversationArchiveRepo(d.db);
    assert.equal(repo.recoverInterruptedCalls(),1);assert.equal(repo.recoverInterruptedCalls(),0);
    const b=repo.begin(owner,hint,'req_same','file_read',{});assert.equal(a.conversation_id,b.conversation_id);
    assert.equal((repo.jobs(owner,a.conversation_id) as {state:string}[])[0]?.state,'STARTING');
    assert.equal((repo.calls(owner,a.conversation_id) as {phase:string}[]).filter(x=>x.phase==='interrupted').length,1);
  }finally{d.raw.close();rmSync(dir,{recursive:true,force:true});}
});

test('retention fails closed for any future unrecognized task state',()=>{
  const h=setup();try{const c=observe(h,{...job('future-state'),state:'FUTURE_EXECUTING'},start(h,'future'));
    h.repo.complete(c,{ok:true});h.time('2026-03-01T00:00:00.000Z');assert.equal(h.repo.prune(),0);
  }finally{h.close();}
});
