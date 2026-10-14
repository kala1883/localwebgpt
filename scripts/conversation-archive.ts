/** Local-only archive reader/maintenance CLI. Not registered as an MCP or control-plane operation. */
import Database from 'better-sqlite3';
import {parseArgs} from 'node:util';
import {resolve} from 'node:path';
import {ConversationArchiveRepo} from '../packages/persistence/src/conversation-archive.ts';

const HELP = `LocalWebGPT conversation execution archive
Usage: node --import tsx scripts/conversation-archive.ts COMMAND --database PATH [options]
Commands: status | owners | sessions | calls | jobs | events | export | prune
Options:
  --principal ID --connection ID   Required for sessions/calls/jobs/events/export
  --conversation ID               Required for calls/jobs/events/export
  --after ID_OR_SEQUENCE --limit N Page cursor and page size (1..200, default 100)
  --before ISO_DATE --confirm-prune Required for prune; deletes only inactive archives

Export writes newline-delimited JSON to stdout under one SQLite read snapshot.
No command execution, permission changes, raw chat collection, or original task deletion.
The database path is explicitly supplied by the LOCAL operator; this CLI does not scan for it.
`;
function main(): void {
  const args = parseArgs({allowPositionals:true,strict:true,options:{
    database:{type:'string'},principal:{type:'string'},connection:{type:'string'},conversation:{type:'string'},
    after:{type:'string'},limit:{type:'string'},before:{type:'string'},'confirm-prune':{type:'boolean'},help:{type:'boolean'},
  }});
  if (args.values.help) {process.stdout.write(HELP);return;}
  const command = args.positionals[0];
  if (args.positionals.length !== 1 || !command || !['status','owners','sessions','calls','jobs','events','export','prune'].includes(command)) throw new Error(HELP);
  if (!args.values.database) throw new Error('--database is required.');
  const mutating = false; // This CLI is now read/export-only; cleanup uses the local console.
  if (command === 'prune') throw new Error('Use the local console retention preview; CLI whole-archive deletion is disabled.');
  if (mutating && (!args.values['confirm-prune'] || !args.values.before)) throw new Error('Prune requires --before and --confirm-prune.');
  const max = Number(args.values.limit ?? '100');
  if (!Number.isSafeInteger(max) || max < 1 || max > 200) throw new Error('--limit must be 1..200.');
  const db = new Database(resolve(args.values.database),{readonly:!mutating,fileMustExist:true});
  db.pragma('foreign_keys=ON');db.pragma('busy_timeout=5000');
  const print = (v: unknown) => process.stdout.write(JSON.stringify(v)+'\n');
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='lwb_archive_calls'").get()) {
      throw new Error('Conversation archive migration is absent. Start the upgraded daemon normally; this reader never creates/migrates the state database.');
    }
    const repo = new ConversationArchiveRepo({
      get inTransaction() { return db.inTransaction; },
      exec: (sql) => db.exec(sql),
      prepare: (sql) => db.prepare<unknown[]>(sql),
    });
    if (command === 'status') {print(repo.status());return;}
    if (command === 'owners') {print({owners:repo.localOwners()});return;}
    if (command === 'prune') throw new Error('Whole-group pruning is disabled in the management edition. Use the authenticated local console retention preview to clear payloads while preserving session and job identity.');
    if (!args.values.principal || !args.values.connection) throw new Error('--principal and --connection are required.');
    const owner = {principal_id:args.values.principal,connection_id:args.values.connection};
    if (command === 'sessions') {
      const items=repo.conversations(owner,args.values.after ?? '',max) as {id:string}[];
      print({items,next_after:items.length===max ? items.at(-1)?.id : null});return;
    }
    const conversation = args.values.conversation;
    if (!conversation) throw new Error('--conversation is required.');
    if (command === 'calls' || command === 'jobs') {
      const items=(command==='calls' ? repo.calls(owner,conversation,args.values.after ?? '',max) : repo.jobs(owner,conversation,args.values.after ?? '',max)) as {id:string}[];
      print({items,next_after:items.length===max ? items.at(-1)?.id : null});return;
    }
    if (command === 'events') {
      const items=repo.events(owner,conversation,Number(args.values.after ?? '0'),max) as {seq:number}[];
      print({items,next_after:items.length===max ? items.at(-1)?.seq : null});return;
    }
    // A stable read transaction, not just a moving per-page high-water mark.
    db.exec('BEGIN');
    try {
      const high = repo.highWater();
      // Validate owner BEFORE printing anything from this conversation.
      repo.calls(owner,conversation,'',1);
      print({kind:'manifest',format:'localwebgpt.execution-archive.v1',conversation_id:conversation,
        high_water_seq:high,capture_policy:'redacted-v1',raw_stream_archived:false,chat_transcript_archived:false,client_delivery:'not_confirmed'});
      for (const kind of ['calls','jobs'] as const) {
        let after='';
        while (true) {
          const page=(kind==='calls' ? repo.calls(owner,conversation,after,200) : repo.jobs(owner,conversation,after,200)) as {id:string}[];
          for(const item of page) print({kind:kind==='calls' ? 'call' : 'job',...item});
          if (page.length<200) break;after=page.at(-1)!.id;
        }
      }
      let after=0;
      while(true) {
        const page=repo.events(owner,conversation,after,200,high) as {seq:number}[];
        for(const item of page) print({kind:'event',event:item});
        if(page.length<200) break;after=page.at(-1)!.seq;
      }
      db.exec('COMMIT');
    } catch(error) {db.exec('ROLLBACK');throw error;}
  } finally {db.close();}
}
try {main();} catch(error) {
  // Error text is for this local CLI only, never automatically sent to a model.
  process.stderr.write(`Archive command failed: ${error instanceof Error ? error.message : 'unknown error'}\n`);
  process.exitCode=1;
}
