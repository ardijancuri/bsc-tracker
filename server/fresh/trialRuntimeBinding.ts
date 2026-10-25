import{createHash}from'node:crypto';
import{readFile,readdir,stat}from'node:fs/promises';
import path from'node:path';

/** The financial API and worker keep their already-reviewed build while only
 * the independent validation monitor adopts the explicitly approved scope. */
export const FRESH_TRIAL_FINANCIAL_RUNTIME_SOURCE='60338659f516dafe492b0402d55e094c7d683975c7f6f91b4c9caee71ae80447';
export const FRESH_TRIAL_FINANCIAL_BASELINE_SHA256='4779a322991d38b953b20a1e1e37ab448b768e6900cd4e4877322679a5c2bdba';
export interface FreshTrialFinancialRuntimeBinding{version:1;baselinePath:string;sha256:string;runtimeSourceDigest:string}
export interface FreshTrialSourceHash{path:string;sha256:string}
interface SourceBaseline{sourceDigest:string;files:FreshTrialSourceHash[]}
const sha=(value:Uint8Array|string)=>createHash('sha256').update(value).digest('hex');
const hash=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const sourcePath=(value:unknown):value is string=>typeof value==='string'&&/^(?:server|shared|src)\/[A-Za-z0-9_./-]+$/.test(value)&&!value.split('/').some(part=>part==='.'||part==='..'||!part);
export const freshTrialMonitorSource=(value:string)=>/^server\/fresh\/trial[^/]*\.ts$/.test(value)||['server/freshTrial.ts','server/freshTrialReview.ts'].includes(value);
const fixedPaths=['server/index.ts','server/worker.ts','server/db.ts','server/rpc.ts','server/gmgnTransport.ts','server/telegramNotifications.ts','server/freshInit.ts','server/freshTrial.ts','server/freshTrialReview.ts','server/swap.ts','server/launchpad.ts','server/nodeMarketProtocols.ts','server/nodeMarketMath.ts',
 'shared/freshAccounting.ts','shared/kolTokenTrades.ts','shared/nodeAccounting.ts','shared/replayPreparation.ts','src/replayPreparationRequest.ts','src/nodeReplay.ts','src/tradeReplayData.ts','src/tradeReplayCanvas.js','src/tradeReplayExport.ts',
 'shared/intelligence.ts','src/App.tsx','src/TokenMarketPanel.tsx','src/trackedTokenGroups.ts','src/types.ts','src/zh-CN.ts','src/styles.css','server/tokenLogo.ts','server/tokenImage.ts'];

/** Mirrors the production runtime's source inventory. In particular a newly
 * added financial module is checked, rather than silently absent from proof. */
export async function freshTrialRuntimeSourcePaths(root=process.cwd()){
 const names=(await readdir(path.resolve(root,'server/fresh'))).filter(name=>name.endsWith('.ts')&&!name.endsWith('.test.ts')&&!name.endsWith('.integration.ts')&&!name.endsWith('.fixture.ts')).map(name=>`server/fresh/${name}`);
 return[...names,...fixedPaths].sort();
}

/** Pure verification is separate so tests can exercise added/changed sources
 * and corrupt artifacts without mutating a running worker's source files. */
export function verifyFreshTrialRuntimeSourceProof(binding:FreshTrialFinancialRuntimeBinding,baselineBytes:Uint8Array,current:readonly FreshTrialSourceHash[]){
 if(!binding||binding.version!==1||typeof binding.baselinePath!=='string'||!binding.baselinePath||binding.baselinePath.length>2048
  ||!hash(binding.sha256)||binding.runtimeSourceDigest!==FRESH_TRIAL_FINANCIAL_RUNTIME_SOURCE||baselineBytes.length>1048576||sha(baselineBytes)!==binding.sha256)throw Error('trial_financial_baseline_invalid');
 let baseline:SourceBaseline;try{baseline=JSON.parse(Buffer.from(baselineBytes).toString('utf8'));}catch{throw Error('trial_financial_baseline_invalid');}
 if(!baseline||baseline.sourceDigest!==binding.runtimeSourceDigest||!Array.isArray(baseline.files)||baseline.files.length!==102
  ||baseline.files.some(row=>!row||!sourcePath(row.path)||!hash(row.sha256))||new Set(baseline.files.map(row=>row.path)).size!==baseline.files.length)throw Error('trial_financial_baseline_invalid');
 if(!Array.isArray(current)||current.length>256||current.some(row=>!row||!sourcePath(row.path)||!hash(row.sha256))||new Set(current.map(row=>row.path)).size!==current.length)throw Error('trial_financial_source_inventory_invalid');
 const before=new Map(baseline.files.map(row=>[row.path,row.sha256])),after=new Map(current.map(row=>[row.path,row.sha256])),monitorChanges:string[]=[],monitorAdditions:string[]=[];
 for(const[name,digest]of before){const actual=after.get(name);if(actual===undefined)throw Error('trial_financial_source_missing');
  if(actual!==digest){if(!freshTrialMonitorSource(name))throw Error('trial_financial_source_changed');monitorChanges.push(name);}}
 for(const name of after.keys())if(!before.has(name)){if(!freshTrialMonitorSource(name))throw Error('trial_financial_source_added');monitorAdditions.push(name);}
 return{runtimeSourceDigest:binding.runtimeSourceDigest,baselineSha256:binding.sha256,baselineFiles:before.size,currentFiles:after.size,monitorChanges:monitorChanges.sort(),monitorAdditions:monitorAdditions.sort()};
}

/** No configuration or checkpoints are changed. The exact pinned baseline is
 * verified on every review/startup; the returned digest authorizes the two
 * unchanged financial runtime watermarks only, never a changed financial file. */
export async function verifyFreshTrialFinancialRuntimeBinding(binding:FreshTrialFinancialRuntimeBinding,options:{root?:string}={}){
 if(binding?.sha256!==FRESH_TRIAL_FINANCIAL_BASELINE_SHA256)throw Error('trial_financial_baseline_unapproved');
 const root=path.resolve(options.root??process.cwd()),baselinePath=path.resolve(root,binding?.baselinePath??''),relative=path.relative(root,baselinePath);
 if(!relative||relative.startsWith('..')||path.isAbsolute(relative))throw Error('trial_financial_baseline_path_invalid');
 const metadata=await stat(baselinePath);if(!metadata.isFile()||metadata.size>1048576)throw Error('trial_financial_baseline_invalid');
 const bytes=await readFile(baselinePath),names=await freshTrialRuntimeSourcePaths(root),current:FreshTrialSourceHash[]=[];
 if(names.length>256)throw Error('trial_financial_source_inventory_invalid');
 for(const name of names)current.push({path:name,sha256:sha(await readFile(path.resolve(root,name)))});
 return verifyFreshTrialRuntimeSourceProof(binding,bytes,current);
}
