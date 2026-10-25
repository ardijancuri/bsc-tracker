/** Explicit operator only. Importing the normal app never runs this program. */
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import pg from 'pg';
import {chainRpc} from './rpc.js';
import {freshCutoverBindings,planFreshCutover,readFreshCutoverManifest,selectFreshCutoverBoundary,applyFreshCutover,sealFreshCutover,activateFreshCutover} from './fresh/cutover.js';

const args=process.argv.slice(2),command=args[0]??'plan';
const flags=new Map<string,string|true>();
for(let i=1;i<args.length;i++){const key=args[i];if(!key.startsWith('--')||flags.has(key))throw Error('cutover_argument_invalid');const value=args[i+1];if(value&&!value.startsWith('--')){flags.set(key,value);i++;}else flags.set(key,true);}
const allowed=new Set(['--folder','--manifest','--sha256','--phase','--choose-boundary','--apply','--confirm-database','--ack-source-writers-paused','--ack-legacy-sender-stopped','--ack-legacy-collector-stopped']);
for(const key of flags.keys())if(!allowed.has(key))throw Error('cutover_argument_invalid');
const sourceUrl=process.env.FRESH_CUTOVER_SOURCE_DATABASE_URL??'',destinationUrl=process.env.FRESH_CUTOVER_DEST_DATABASE_URL??'',mode=process.env.FRESH_CUTOVER_MODE??'production';
let source:pg.Pool|undefined,destination:pg.Pool|undefined;
try{
  const bindings=freshCutoverBindings(sourceUrl,destinationUrl,mode),root=path.resolve(process.env.FRESH_CUTOVER_DIR??'.cutover'),operatorSha256=createHash('sha256').update(await readFile(fileURLToPath(import.meta.url))).digest('hex');
  const within=(input:string)=>{const resolved=path.resolve(input);if(resolved!==root&&!resolved.startsWith(root+path.sep))throw Error('cutover_artifact_root_required');return resolved;};
  destination=new pg.Pool({connectionString:destinationUrl,max:2,options:'-c timezone=UTC -c statement_timeout=120000 -c lock_timeout=10000'});
  const apply=flags.get('--apply')===true;
  if(apply&&flags.get('--confirm-database')!==bindings.destination.database)throw Error('cutover_destination_confirmation_required');
  if(command==='plan'){
    if(apply)throw Error('cutover_plan_is_read_only');const folderValue=flags.get('--folder');if(typeof folderValue!=='string')throw Error('cutover_new_private_folder_required');
    const phase=flags.get('--phase')??'initial';if(phase!=='initial'&&phase!=='seal')throw Error('cutover_phase_invalid');
    source=new pg.Pool({connectionString:sourceUrl,max:1,options:'-c default_transaction_read_only=on -c timezone=UTC -c statement_timeout=120000'});
    const boundary=flags.get('--choose-boundary')===true?await selectFreshCutoverBoundary(chainRpc):null;
    if(phase==='seal'&&boundary)throw Error('cutover_seal_cannot_change_boundary');
    const result=await planFreshCutover({source,destination,bindings,folder:within(folderValue),operatorSha256,phase,boundary});
    console.log(JSON.stringify({command,dryRun:true,manifest:path.join(result.folder,'manifest.json'),manifestSha256:result.sha256,phase,boundarySelected:!!result.manifest.boundary,
      source:bindings.source.database,destination:bindings.destination.database,featureTables:Object.keys(result.manifest.tables).length,kols:result.manifest.kols.rows,
      counts:Object.fromEntries(Object.entries(result.manifest.tables).map(([k,v])=>[k,v.rows])),legacyPendingCount:result.manifest.legacyPendingCount,legacyLeasedCount:result.manifest.legacyLeasedCount,legacyBotSendingCount:result.manifest.legacyBotSendingCount,legacyUnprocessedCount:result.manifest.legacyUnprocessedCount,legacyHandoff:result.manifest.legacyHandoff,financialRowsExported:0,applyReady:result.applyReady}));
  }else if(command==='apply'||command==='seal'){
    const filename=flags.get('--manifest'),sha=flags.get('--sha256');if(typeof filename!=='string'||typeof sha!=='string')throw Error('cutover_manifest_and_sha_required');
    const {manifest,folder}=await readFreshCutoverManifest(within(filename),sha,operatorSha256);
    if(JSON.stringify(manifest.source)!==JSON.stringify(bindings.source)||JSON.stringify(manifest.destination)!==JSON.stringify(bindings.destination))throw Error('cutover_manifest_database_binding_changed');
    const result=command==='apply'?await applyFreshCutover({destination,manifest,folder,manifestSha256:sha,rpc:chainRpc,apply,sourceWritersPaused:flags.get('--ack-source-writers-paused')===true}):
      await sealFreshCutover({destination,manifest,folder,manifestSha256:sha,apply,legacySenderStopped:flags.get('--ack-legacy-sender-stopped')===true,legacyCollectorStopped:flags.get('--ack-legacy-collector-stopped')===true,sourceWritersPaused:flags.get('--ack-source-writers-paused')===true});
    console.log(JSON.stringify({command,...result}));
  }else if(command==='activate'){
    const sha=flags.get('--sha256');if(typeof sha!=='string'||! /^[a-f0-9]{64}$/.test(sha))throw Error('cutover_final_manifest_sha_required');
    const result=await activateFreshCutover({destination,destinationBinding:bindings.destination,rpc:chainRpc,manifestSha256:sha,apply,sourceWritersPaused:flags.get('--ack-source-writers-paused')===true,legacySenderStopped:flags.get('--ack-legacy-sender-stopped')===true,legacyCollectorStopped:flags.get('--ack-legacy-collector-stopped')===true});
    console.log(JSON.stringify({command,...result}));
  }else throw Error('cutover_command_invalid');
}catch(error){const message=error instanceof Error?error.message:'';console.error(JSON.stringify({ok:false,error:/^cutover_[a-z0-9_:]+$/.test(message)?message:'cutover_operator_failed',credentialsLogged:false}));process.exitCode=1;
}finally{await source?.end();await destination?.end();}
