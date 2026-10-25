import {createHash,randomUUID} from 'node:crypto';
import {copyFile,mkdir,readFile,realpath,stat} from 'node:fs/promises';
import path from 'node:path';
import {freshRuntimeDigest} from './fresh/runtime.js';
import {readReviewedFreshTrialHistory} from './fresh/trialHistory.js';
import {prepareFreshTrialReview,type FreshTrialReviewManifest} from './fresh/trialReview.js';
import {verifyFreshTrialFinancialRuntimeBinding} from './fresh/trialRuntimeBinding.js';
import {FRESH_FORWARD_TRIAL_POLICY} from './fresh/trialValidation.js';
import {readFreshTrialJson,writeFreshTrialJson,withFreshTrialControlLock,assertFreshTrialMonitorStopped} from './fresh/trialProgressFiles.js';

const workspace=await realpath(process.cwd());
const expected='C:/Users/PC/.codex/worktrees/fresh-kollens/kolscan-bnb';
if(workspace.replaceAll('\\','/').toLowerCase()!==expected.toLowerCase())throw Error('Fresh local workspace only');
const database=new URL(process.env.DATABASE_URL??'');
if(!['127.0.0.1','localhost'].includes(database.hostname)||database.port!=='5436'||database.pathname!=='/kollens_fresh_20261022_24h'
  ||process.env.FRESH_LOCAL_ONLY!=='true')throw Error('Fresh local database only');
const args=process.argv.slice(2),reviewIndex=args.indexOf('--review'),dryRun=args.includes('--dry-run');
if(reviewIndex<0||!args[reviewIndex+1]||args.some((arg,index)=>arg!=='--review'&&arg!=='--dry-run'&&index!==reviewIndex+1))throw Error('Usage: freshTrialReview --review <local manifest> [--dry-run]');
async function localFile(reference:string){
  const filename=await realpath(path.resolve(workspace,reference));
  if(!filename.toLowerCase().startsWith((workspace+path.sep).toLowerCase())||!(await stat(filename)).isFile())throw Error('Review evidence must be a workspace file');
  return filename;
}
async function verifyForwardState(state:any,prior:any){
  if(state.validationScopePolicy!==FRESH_FORWARD_TRIAL_POLICY)return null;
  const source=await verifyFreshTrialFinancialRuntimeBinding(state.financialRuntimeBinding);
  const {Pool}=await import('pg'),db=new Pool({connectionString:database.href,max:1,options:'-c default_transaction_read_only=on -c statement_timeout=7000'});
  try{
    await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const scope=state.forwardScope;
    const row=(await db.query(`SELECT b.block_hash,b.occurred_at,c.block_number::text,c.revision::text
      FROM fresh.recent_blocks b CROSS JOIN fresh.checkpoints c WHERE b.block_number=$1 AND c.key='capture'`,[scope.blockNumber])).rows[0];
    if(!row||row.block_hash!==scope.blockHash||new Date(row.occurred_at).getTime()!==Date.parse(scope.occurredAt)
      ||Number(row.block_number)<scope.blockNumber||prior.validationScopePolicy!==FRESH_FORWARD_TRIAL_POLICY&&row.revision!==scope.captureRevision)
      throw Error('Forward checkpoint is not canonical captured evidence');
    const runtimes=(await db.query("SELECT key,value FROM fresh.checkpoints WHERE key IN('runtime:api','runtime:worker') ORDER BY key")).rows;
    if(runtimes.length!==2||runtimes.some(row=>row.value?.sourceDigest!==source.runtimeSourceDigest))throw Error('Forward financial runtime does not match the frozen build');
    const start=(await db.query("SELECT block_number::text,block_hash FROM fresh.checkpoints WHERE key='start'")).rows[0];
    if(start?.block_number!=='129180844'||start.block_hash!=='0x32588e1f98d9d2c5bf163a8700ac3740b4aaf86237e57d9f0f86406600c90103')throw Error('Financial boundary changed');
    await db.query('COMMIT');
    return{source,boundary:scope,trackingBoundary:start,runtimes};
  }finally{await db.query('ROLLBACK').catch(()=>{});await db.end();}
}
async function review(){
const manifestPath=await localFile(args[reviewIndex+1]);
const manifest=await readFreshTrialJson<FreshTrialReviewManifest>(manifestPath);
if(!/^[a-z\d][a-z\d-]{0,100}$/i.test(manifest.id))throw Error('Review requires a unique bounded identifier');
const directory=path.join(workspace,'.cache/fresh/trial'),stateFile=path.join(directory,'state.json');
const prior=await readFreshTrialJson(stateFile),sourceDigest=await freshRuntimeDigest(),now=Date.now();
const evidence=new Set([...manifest.evidence,...manifest.checks.flatMap(check=>check.evidence),...(manifest.historyAudit?[manifest.historyAudit]:[])]);
const evidenceHashes=[];
for(const reference of evidence){const filename=await localFile(reference);evidenceHashes.push({path:path.relative(workspace,filename),sha256:createHash('sha256').update(await readFile(filename)).digest('hex')});}
const history=manifest.historyAudit?await readReviewedFreshTrialHistory(manifest.historyAudit,now):undefined;
const prepared=prepareFreshTrialReview({prior,manifest,sourceDigest,now,history});
const forwardVerification=await verifyForwardState(prepared.state,prior);
const receiptFile=path.join(directory,'reviews',manifest.id+'.json');
try{await stat(receiptFile);throw Error('Review identifier already applied; use a new explicit review');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
if(!dryRun){
  const pidFile=path.join(workspace,'.cache/fresh/trial.pid');
  let monitorPid:number|null=null;try{monitorPid=Number((await readFile(pidFile,'utf8')).trim());}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  for(const candidate of new Set([monitorPid,prior.monitorPid].filter((value):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>0))){
    assertFreshTrialMonitorStopped(candidate);
  }
  // Recheck source/state immediately before publishing. Capture remains running.
  if(await freshRuntimeDigest()!==sourceDigest||JSON.stringify(await readFreshTrialJson(stateFile))!==JSON.stringify(prior))throw Error('Trial/source changed during review; retry without losing old state');
  const historyDirectory=path.join(directory,'history','segmented-review-'+new Date(now).toISOString().replaceAll(':','-')+'-'+randomUUID().slice(0,8));
  await mkdir(historyDirectory,{recursive:true});
  for(const [source,target] of [[stateFile,'state.json'],[path.join(directory,'observations.jsonl'),'observations.jsonl'],
    [path.join(workspace,'.cache/fresh/reviewed-restart.json'),'reviewed-restart.json']] as const){
    try{await copyFile(source,path.join(historyDirectory,target));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  }
  // Preserve the complete reviewed intent before replacing the mutable report.
  await writeFreshTrialJson(receiptFile,{version:1,at:new Date(now).toISOString(),manifest,evidenceHashes,historyDirectory,
    forwardVerification,
    beforeVerifiedSeconds:prepared.beforeVerifiedSeconds,afterVerifiedSeconds:prepared.afterVerifiedSeconds,sourceDigest,segmentId:prepared.segmentId,
    state:prepared.state});
  await writeFreshTrialJson(stateFile,prepared.state);
  console.log(JSON.stringify({beforeVerifiedSeconds:prepared.beforeVerifiedSeconds,afterVerifiedSeconds:prepared.afterVerifiedSeconds,
    sourceDigest,segmentId:prepared.segmentId,historyDirectory,dryRun:false}));
}else console.log(JSON.stringify({beforeVerifiedSeconds:prepared.beforeVerifiedSeconds,afterVerifiedSeconds:prepared.afterVerifiedSeconds,
  sourceDigest,segmentId:prepared.segmentId,historyDirectory:null,dryRun:true}));
}
if(dryRun)await review();else await withFreshTrialControlLock(path.join(workspace,'.cache/fresh/trial'),review);
