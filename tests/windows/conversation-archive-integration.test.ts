/** Must run on the user's Windows checkout; not included in isolated-success claims. */
import assert from 'node:assert/strict';
import {describe,it} from 'node:test';
import {GATES_ON,callTool,dataOf,errorOf,makeToolHarness} from '../tools/harness.ts';
import type {ToolHarness} from '../tools/harness.ts';
import {TESTREPO_DIR} from '../fixtures/index.ts';
import {fileIdOf,makeFixtureOps} from '../tools/fixture-ops.ts';
import {ARCHIVED_CALL_OPERATION} from '../../packages/contracts/src/conversation-archive.ts';
import type {CommandJobView} from '../../packages/contracts/src/command-job.ts';
import {TOOL_OUTPUT_SCHEMAS} from '../../packages/contracts/src/tool-surface-v2.ts';
const windows = process.platform === 'win32' ? describe : describe.skip;
async function fixture(){return await makeToolHarness({root:TESTREPO_DIR,root_file_id:fileIdOf(TESTREPO_DIR),ops:makeFixtureOps(),gates:GATES_ON});}
async function close(h:ToolHarness){try{await h.deps.command_processes?.terminateAll();}finally{await new Promise(r=>setImmediate(r));h.close();}}
const archived = (h:ToolHarness,session:string,name:string,input:unknown) => callTool(h,ARCHIVED_CALL_OPERATION,
  {name,input,conversation:{status:'present',session}});
const ownerOf=(h:ToolHarness)=>{
  const owner=h.repos.conversation_archive.localOwners().find(o=>o.connection_id===h.adapterContext().connection_id);
  assert.ok(owner);return owner;
};
windows('conversation archive through production registration, original guards and real SQLite',()=>{
  it('interleaved conversation metadata separates original file-tool requests without changing their schema',async()=>{
    const h=await fixture();try{
      for(const session of ['alpha','beta','alpha']){
        const response=await archived(h,session,'file_read',{workspace_id:h.workspace.id,path:'README.md'});
        assert.ok(TOOL_OUTPUT_SCHEMAS.file_read.safeParse(response).success);
      }
      const repo=h.repos.conversation_archive,owner=ownerOf(h);
      const sessions=repo.conversations(owner) as {id:string;attribution:string}[];
      const identified=sessions.filter(s=>s.attribution==='client_meta');assert.equal(identified.length,2);
      assert.deepEqual(identified.map(s=>repo.calls(owner,s.id).length).sort(),[1,2]);
    }finally{await close(h);}
  });
  it('a direct legacy tool call is archived as unattributed instead of being silently assigned to the last chat',async()=>{
    const h=await fixture();try{
      await archived(h,'known','file_read',{workspace_id:h.workspace.id,path:'README.md'});
      await callTool(h,'file_read',{workspace_id:h.workspace.id,path:'README.md'});
      const repo=h.repos.conversation_archive,owner=ownerOf(h);
      assert.deepEqual(new Set((repo.conversations(owner) as {attribution:string}[]).map(s=>s.attribution)),new Set(['client_meta','unassigned_missing']));
    }finally{await close(h);}
  });
  it('internal envelope rejects control-plane names, recursion and identity overrides',async()=>{
    const h=await fixture();try{
      for(const name of ['service.pause','workspaces.register',ARCHIVED_CALL_OPERATION,'tools.catalog']){
        assert.equal(errorOf(await archived(h,'x',name,{})).error.code,'INVALID_ARGUMENT');
      }
      const result=await callTool(h,ARCHIVED_CALL_OPERATION,{name:'file_read',input:{},conversation:{status:'missing'},connection_id:'forged'});
      assert.equal(errorOf(result).error.code,'INVALID_ARGUMENT');
    }finally{await close(h);}
  });
  it('short command command-text, bounded output, final state and same-key replay are correlated without a second job',async()=>{
    const h=await fixture();try{
      const input={workspace_id:h.workspace.id,shell:'powershell',command:"Write-Output 'LWB_ARCHIVE_PROBE_OK'",idempotency_key:'archive-integration-one',wait_ms:5000};
      const first=await archived(h,'origin','command_exec',input);assert.ok(TOOL_OUTPUT_SCHEMAS.command_exec.safeParse(first).success);
      const firstJob=dataOf(first) as CommandJobView;
      const until=performance.now()+10_000;
      let state=firstJob;
      while(state.in_progress && performance.now()<until){
        await new Promise(r=>setTimeout(r,25));
        state=dataOf(await callTool<CommandJobView>(h,'command_status',{job_id:firstJob.job_id}));
      }
      assert.equal(state.state,'EXITED');
      const replay=dataOf(await archived(h,'another-chat','command_exec',input)) as CommandJobView;
      assert.equal(replay.job_id,firstJob.job_id);
      const repo=h.repos.conversation_archive,owner=ownerOf(h);
      const sessions=repo.conversations(owner) as {id:string;attribution:string}[];
      const allJobs=sessions.flatMap(s=>repo.jobs(owner,s.id)) as {id:string;state:string;conversation_id?:string;output_capture:string}[];
      assert.equal(allJobs.length,1);assert.equal(allJobs[0]?.output_capture,'captured');assert.equal(allJobs[0]?.state,'EXITED');
      const origin=sessions.find(s=>repo.jobs(owner,s.id).length===1);assert.ok(origin);
      const events=repo.events(owner,origin.id,0,200) as {kind:string;payload:unknown}[];
      assert.ok(events.some(e=>e.kind==='tool_request_received'&&JSON.stringify(e.payload).includes('LWB_ARCHIVE_PROBE_OK')));
      assert.ok(events.some(e=>e.kind==='command_output_observed'&&JSON.stringify(e.payload).includes('LWB_ARCHIVE_PROBE_OK')));
      assert.ok(events.some(e=>e.kind==='job_state_changed'&&JSON.stringify(e.payload).includes('EXITED')));
    }finally{await close(h);}
  });
});
