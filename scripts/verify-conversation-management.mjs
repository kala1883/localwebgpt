#!/usr/bin/env node
/** Static checks are separate from the post-restart tests. Never opens the production DB or stops a service. */
import {spawnSync} from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {parseArgs} from 'node:util';
const {values}=parseArgs({strict:true,options:{static:{type:'boolean'},'after-user-restart':{type:'boolean'}}});
if(Boolean(values.static)===Boolean(values['after-user-restart']))throw new Error('Choose --static OR --after-user-restart. No default test or migration execution.');
const root=process.cwd();if(JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8')).name!=='local-workspace-bridge')throw new Error('Run from the LocalWebGPT repository root.');
const dir=path.join(root,'.lwb-local','session-management-validation',new Date().toISOString().replaceAll(':','-'));
fs.mkdirSync(dir,{recursive:true});
const steps=values.static?[
  ['root-types',root,['node_modules/typescript/bin/tsc','--noEmit']],
  ['console-types',root,['node_modules/vue-tsc/bin/vue-tsc.js','--noEmit','-p','apps/console/tsconfig.json']],
  ['isolated-console-build',path.join(root,'apps/console'),['../../node_modules/vite/bin/vite.js','build','--config','vite.config.ts','--outDir',path.join(dir,'console-dist')]],
]:[
  ['import-boundaries',root,['scripts/check-fsguard-imports.mjs']],
  ['fixture-build',root,['--import','tsx','tests/fixtures/build-fixtures.ts']],
  ['persistence',root,['--import','tsx','--test','--test-reporter=tap','tests/unit/persistence.test.ts']],
  ['archive-and-management',root,['--import','tsx','--test','--test-reporter=tap','tests/unit/conversation-archive.test.ts','tests/unit/conversation-management.test.ts','tests/unit/conversation-management-routes.test.ts']],
  ['command-regression',root,['--import','tsx','--test','--test-reporter=tap','tests/unit/command-jobs.test.ts','tests/unit/command-concurrency-pools.test.ts','tests/unit/command-recovery.test.ts']],
  ['windows-integration',root,['--import','tsx','--test','--test-reporter=tap','tests/windows/conversation-archive-integration.test.ts','tests/windows/command-jobs-integration.test.ts']],
  ['console-management',path.join(root,'apps/console'),['../../node_modules/vitest/vitest.mjs','run','--config','vitest.config.ts','tests/conversations-view.spec.ts','tests/command-recovery-panel.spec.ts']],
];
const report={mode:values.static?'static-only':'post-restart-isolated-tests',node:process.version,platform:process.platform,
  started_at:new Date().toISOString(),state:'running',production_database_opened:false,production_assets_modified:false,service_stopped:false,
  real_chatgpt_metadata_verified:false,tests_run:!values.static,results:[]};
const write=()=>fs.writeFileSync(path.join(dir,'report.json'),JSON.stringify(report,null,2)+'\n');write();
for(const [name,cwd,args] of steps){
  const a=fs.openSync(path.join(dir,name+'.stdout.log'),'wx'),b=fs.openSync(path.join(dir,name+'.stderr.log'),'wx');let r;
  try{r=spawnSync(process.execPath,args,{cwd,stdio:['ignore',a,b],windowsHide:true});}finally{fs.closeSync(a);fs.closeSync(b);}
  report.results.push({name,exit_code:r.status,signal:r.signal,error_code:r.error?.code??null});write();
  // Continue isolated stages even if an existing import-baseline violation remains; never report it as passed.
  if((r.status!==0||r.signal||r.error)&&name!=='import-boundaries')break;
}
report.state='completed';report.finished_at=new Date().toISOString();report.passed=report.results.length===steps.length&&report.results.every(r=>r.exit_code===0&&!r.signal&&!r.error_code);write();
console.log(JSON.stringify({marker:'SESSION_MANAGEMENT_VALIDATION',report:path.relative(root,path.join(dir,'report.json')).replaceAll('\\','/'),passed:report.passed,mode:report.mode,results:report.results}));
if(!report.passed)process.exitCode=1;
