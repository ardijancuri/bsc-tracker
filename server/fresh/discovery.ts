import {createHash,randomUUID} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import type {Rpc} from '../rpc.js';
import {transferTopic} from '../swap.js';
import {freshAddress,freshHash,freshInteger,validateFreshReceipt,decodeFreshEvidence,type FreshBlock,type FreshCapturedReceipt,type FreshLaunchFact} from './capture.js';
import {readFreshTokenAdmission} from './tracking.js';
import {validateFreshTrace} from './trace.js';
import {validFreshCompleteCallTrace} from './passiveIncoming.js';
import {classifyFreshCreationToken} from './tokenAuthenticity.js';

export type FreshTokenDiscovery='eligible'|'excluded'|'pending';
const stable=(v:unknown):string=>JSON.stringify(v,(_k,x:unknown)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.entries(x).sort(([a],[b])=>a.localeCompare(b))):x);
const sha=(v:unknown)=>createHash('sha256').update(typeof v==='string'?v:stable(v)).digest('hex');
const codeSha=(v:string)=>createHash('sha256').update(Buffer.from(v.slice(2),'hex')).digest('hex');
const number=(v:unknown)=>{const n=Number(freshInteger(v));if(!Number.isSafeInteger(n))throw Error('token_discovery_number');return n;};
const rawCode=(v:unknown):v is string=>typeof v==='string'&&/^0x(?:[a-f0-9]{2})*$/i.test(v)&&v.length<=2+128*1024;
export interface FreshDiscoveryHeader{number:number;hash:string;parentHash:string;timestamp:string}
const header=(b:FreshBlock):FreshDiscoveryHeader=>({number:number(b.number),hash:b.hash,parentHash:b.parentHash,timestamp:new Date(number(b.timestamp)*1000).toISOString()});
export interface FreshTokenCreationProof{
 version:1;kind:'canonical_token_birth_v1';chainId:56;tokenAddress:string;start:{number:number;hash:string};
 block:FreshBlock;parent:FreshBlock;entry:FreshCapturedReceipt;parentCode:string;code:string;
 mode:'top_level_creation'|'internal_creation'|'exact_state_birth';source:'node'|'explicit_archive';
}
export interface FreshPreBoundaryCodeProof{version:1;kind:'canonical_pre_boundary_code_v1';chainId:56;tokenAddress:string;start:{number:number;hash:string};block:FreshBlock;code:string;source:'node'|'explicit_archive'}
export type FreshTokenDiscoveryProof=FreshTokenCreationProof|FreshPreBoundaryCodeProof;
export async function validateFreshPreBoundaryCodeProof(p:FreshPreBoundaryCodeProof,start:{number:number;hash:string},canonicalHeader:(number:number)=>Promise<FreshDiscoveryHeader|null>,canonicalCode:(token:string,block:FreshDiscoveryHeader)=>Promise<string|null>){
 try{const b=header(p.block);return p.version===1&&p.kind==='canonical_pre_boundary_code_v1'&&p.chainId===56&&freshAddress(p.tokenAddress)===p.tokenAddress&&stable(p.start)===stable(start)
  &&['node','explicit_archive'].includes(p.source)&&b.number===start.number&&b.hash===start.hash&&rawCode(p.code)&&p.code!=='0x'&&stable(await canonicalHeader(b.number))===stable(b)&&await canonicalCode(p.tokenAddress,b)===p.code;}catch{return false;}
}
/** Code birth and a creation transaction are different claims. A same-block
 * mint is only a canonical witness for the state-birth variant. Neither a pool
 * initialization nor token precision/supply can establish this proof. */
export async function validateFreshTokenCreationProof(proof:FreshTokenCreationProof,start:{number:number;hash:string},canonicalHeader:(number:number)=>Promise<FreshDiscoveryHeader|null>,canonicalCode:(token:string,block:FreshDiscoveryHeader)=>Promise<string|null>):Promise<FreshLaunchFact|null>{
 try{
  if(proof.version!==1||proof.kind!=='canonical_token_birth_v1'||proof.chainId!==56||!freshAddress(proof.tokenAddress)||proof.tokenAddress!==proof.tokenAddress.toLowerCase()
   ||!['node','explicit_archive'].includes(proof.source)||stable(proof.start)!==stable(start)||!Number.isSafeInteger(start.number)||!freshHash(start.hash)
   ||proof.parentCode!=='0x'||!rawCode(proof.code)||proof.code==='0x')return null;
  const b=header(proof.block),p=header(proof.parent);if(b.number<=start.number||p.number!==b.number-1||b.parentHash!==p.hash||Date.parse(p.timestamp)>Date.parse(b.timestamp))return null;
  for(const expected of[b,p])if(stable(await canonicalHeader(expected.number))!==stable(expected))return null;
  // The callback is a trusted exact-block collector/readback, never a current
  // token row or a caller's unverified `code` boolean. Offline operators bind
  // it to complete checksum-verified raw RPC observations and header brackets.
  if(await canonicalCode(proof.tokenAddress,p)!=='0x'||await canonicalCode(proof.tokenAddress,b)!==proof.code)return null;
  const{entry}=proof,tx=entry.transaction;if(entry.receipt.status!=='0x1'||tx.chainId!==undefined&&freshInteger(tx.chainId)!==56n)return null;
  validateFreshReceipt(entry.receipt,tx,proof.block);const member=proof.block.transactions[number(tx.transactionIndex)];if((typeof member==='string'?member:(member as any)?.hash)!==tx.hash)return null;
  let creator:string|null=null,creationFrame:Record<string,unknown>|undefined;
  if(proof.mode==='top_level_creation'){
   if(tx.to!==null||entry.receipt.contractAddress?.toLowerCase()!==proof.tokenAddress)return null;creator=tx.from;
  }else if(proof.mode==='internal_creation'){
   const trace=validateFreshTrace(entry.trace);if(!validFreshCompleteCallTrace(entry,trace))return null;const frames:Record<string,unknown>[]=[];
   const walk=(call:typeof trace,path:number[],failed=false)=>{failed=failed||!!call.error;if(!failed&&['CREATE','CREATE2'].includes(call.type)&&call.to===proof.tokenAddress&&call.output===proof.code&&typeof call.input==='string')frames.push({type:call.type,creator:call.from,inputSha256:codeSha(call.input),runtimeSha256:codeSha(call.output),path});call.calls?.forEach((child,i)=>walk(child,[...path,i],failed));};walk(trace,[]);
   if(frames.length!==1)return null;creationFrame=frames[0];creator=String(creationFrame.creator);
  }else if(proof.mode==='exact_state_birth'){
   const mint=entry.receipt.logs.some(l=>l.address.toLowerCase()===proof.tokenAddress&&l.topics[0]===transferTopic&&l.topics.length===3&&l.topics[1]==='0x'+'0'.repeat(64)
    &&/^0x0{24}[a-f0-9]{40}$/.test(l.topics[2])&&/^0x[a-f0-9]{64}$/.test(l.data)&&BigInt(l.data)>0n);
   if(!mint)return null;
  }else return null;
  const authenticity=proof.mode==='top_level_creation'?classifyFreshCreationToken({transaction:tx,receipt:entry.receipt,block:proof.block}):null;
  return{tokenAddress:proof.tokenAddress,protocol:'evm_creation',blockNumber:b.number,blockHash:b.hash,txHash:tx.hash,logIndex:null,launchedAt:b.timestamp,
   status:authenticity?'excluded_non_token':'eligible',proof:{version:1,kind:'canonical_token_birth_v1',creation:proof.mode,source:proof.source,start,
    parent:p,birth:b,codeBefore:'0x',runtimeSha256:codeSha(proof.code),runtimeBytes:(proof.code.length-2)/2,creator,
    creationTransactionKnown:proof.mode!=='exact_state_birth',witnessTransactionHash:tx.hash,originalContextSha256:sha([tx,entry.receipt]),...(creationFrame?{creationFrame}:{}),...(authenticity?{authenticity}:{})}};
 }catch{return null;}
}

/** A missing launch fact is a repair state. Only authenticated old/non-token
 * facts are exclusions; a failed node read never proves token age. */
export async function readFreshTokenDiscovery(db:Pick<Pool,'query'>,token:string,options:{blockNumber:number;lock?:boolean}):Promise<FreshTokenDiscovery>{
 if(!freshAddress(token)||token!==token.toLowerCase())return'pending';
 if(await readFreshTokenAdmission(db,token,{blockNumber:options.blockNumber,lock:options.lock}))return'eligible';
 const suffix=options.lock?' FOR SHARE':'',fact=(await db.query('SELECT status,block_number::text FROM fresh.launch_facts WHERE token_address=$1'+suffix,[token])).rows[0];
 if(fact?.status==='before_boundary'||fact?.status==='excluded_non_token')return'excluded';
 const verified=(await db.query(`SELECT j.progress,s.block_number::text,s.block_hash FROM fresh.jobs j JOIN fresh.checkpoints s ON s.key='start' WHERE j.kind='token_discovery' AND j.reference=$1 AND j.state='done'${options.lock?' FOR SHARE OF j,s':''}`,[token])).rows[0],p=verified?.progress?.boundaryCode;
 return p?.kind==='canonical_pre_boundary_code_v1'&&p.version===1&&p.chainId===56&&p.tokenAddress===token&&p.blockNumber===Number(verified.block_number)&&p.blockHash===verified.block_hash
  &&typeof p.runtimeSha256==='string'&&/^[a-f0-9]{64}$/.test(p.runtimeSha256)&&Number.isSafeInteger(p.runtimeBytes)&&p.runtimeBytes>0&&['node','explicit_archive'].includes(p.source)?'excluded':'pending';
}
export interface FreshDiscoveryReference{tokenAddress:string;entry:FreshCapturedReceipt;block:FreshDiscoveryHeader}
/** Called only after the normal decoder's canonical/body/admission locks.
 * Jobs retain bounded evidence references and progress, never trade histories. */
export async function queueFreshTokenDiscovery(client:PoolClient,input:FreshDiscoveryReference,now=new Date()){
 const token=freshAddress(input.tokenAddress);if(!token||token!==input.tokenAddress)throw Error('token_discovery_address');
 if(await readFreshTokenDiscovery(client,token,{blockNumber:input.block.number,lock:true})!=='pending')return;
 const current=(await client.query('SELECT e.payload,e.wallet_addresses,b.block_hash FROM fresh.recent_evidence e JOIN fresh.recent_blocks b USING(block_number,block_hash) WHERE e.tx_hash=$1 AND e.block_hash=$2 FOR UPDATE OF e FOR SHARE OF b',[input.entry.transaction.hash,input.block.hash])).rows[0];
 if(!current||current.block_hash!==input.block.hash)throw Error('token_discovery_receipt_invalidated');const saved=decodeFreshEvidence(current.payload);
 if(sha([saved.transaction,saved.receipt])!==sha([input.entry.transaction,input.entry.receipt]))throw Error('token_discovery_original_changed');
 if(saved.transaction.to?.toLowerCase()!==token&&!saved.receipt.logs.some(l=>l.address.toLowerCase()===token))throw Error('token_discovery_token_context');
 const start=(await client.query("SELECT block_number::text,block_hash FROM fresh.checkpoints WHERE key='start' FOR SHARE")).rows[0];
 if(!start||input.block.number<=Number(start.block_number))throw Error('token_discovery_before_boundary');
 if(stable([...current.wallet_addresses].sort())!==stable([...saved.wallets].sort()))throw Error('token_discovery_wallet_context');
 const wallets=(await client.query(`SELECT address FROM fresh.wallets WHERE address=ANY($1::text[]) AND monitoring_from_block<=$2 AND(monitoring_to_block IS NULL OR monitoring_to_block>=$2) ORDER BY address FOR SHARE`,[saved.wallets,input.block.number])).rows.map(r=>r.address);
 if(!wallets.length)throw Error('token_discovery_wallet_changed');
 const reference={txHash:saved.transaction.hash,blockNumber:input.block.number,blockHash:input.block.hash},progress={version:1,kind:'token_discovery_v1',tokenAddress:token,startBlock:Number(start.block_number),startHash:start.block_hash,firstSeen:reference,lastSeen:reference,wallets,stage:'creation_proof_pending'};
 const old=(await client.query("SELECT progress FROM fresh.jobs WHERE kind='token_discovery' AND reference=$1 FOR UPDATE",[token])).rows[0];
 if(old&&(old.progress?.startBlock!==progress.startBlock||old.progress?.startHash!==progress.startHash))throw Error('token_discovery_boundary_changed');
 await client.query(`INSERT INTO fresh.jobs(id,kind,reference,priority,progress,due_at,last_error)VALUES('token_discovery:'||$1,'token_discovery',$1,80,$2::jsonb,$3,'token_creation_unverified')
  ON CONFLICT(kind,reference)DO UPDATE SET progress=fresh.jobs.progress||jsonb_build_object('lastSeen',EXCLUDED.progress->'lastSeen','wallets',EXCLUDED.progress->'wallets'),state='pending',updated_at=clock_timestamp()
  WHERE COALESCE((fresh.jobs.progress#>>'{lastSeen,blockNumber}')::bigint,0)<($2::jsonb#>>'{lastSeen,blockNumber}')::bigint
   OR fresh.jobs.progress#>>'{lastSeen,blockHash}' IS DISTINCT FROM $2::jsonb#>>'{lastSeen,blockHash}' OR fresh.jobs.state<>'pending'`,[token,JSON.stringify(progress),now]);
}

export type FreshTokenDiscoveryResolver=(context:{tokenAddress:string;start:{number:number;hash:string};observed:FreshDiscoveryHeader;signal?:AbortSignal})=>Promise<FreshTokenDiscoveryProof|null>;
export async function readFreshTokenDiscoveryHealth(db:Pick<Pool,'query'>){const r=(await db.query(`SELECT count(*)FILTER(WHERE state='pending')::int AS pending,
 count(*)FILTER(WHERE state='pending' AND lease_until>clock_timestamp())::int AS leased,count(*)FILTER(WHERE state='done')::int AS completed
 FROM fresh.jobs WHERE kind='token_discovery'`)).rows[0];return{pending:Number(r?.pending??0),leased:Number(r?.leased??0),completed:Number(r?.completed??0)};}
/** Recent state is attempted on the owned node first. Historical archive
 * access exists only when the caller explicitly supplies an RPC. Every state
 * read is bracketed by its exact canonical header; no current code is relabeled
 * historical. The bounded search never runs from an ordinary page request. */
export function createFreshTokenDiscoveryResolver(rpc:Rpc,options:{archiveRpc?:Rpc;maxCalls?:number;maxMs?:number}={}):FreshTokenDiscoveryResolver{
 return async context=>{
  const finite=(value:number|undefined,fallback:number)=>typeof value==='number'&&Number.isFinite(value)?Math.floor(value):fallback;
  const deadline=Date.now()+Math.min(20_000,Math.max(1000,finite(options.maxMs,10_000))),maxCalls=Math.min(160,Math.max(8,finite(options.maxCalls,96)));let calls=0,archiveChecked=false;
  const invoke=async<T>(source:Rpc,method:string,params:unknown[])=>{if(context.signal?.aborted||Date.now()>deadline||++calls>maxCalls)throw Error('token_discovery_budget');return source<T>(method,params);};
  if(await invoke<string>(rpc,'eth_chainId',[])!=='0x38')throw Error('token_discovery_chain');
  const observations=new Map<number,{block:FreshBlock;code:string;source:'node'|'explicit_archive'}>();
  const observe=async(n:number)=>{const old=observations.get(n);if(old)return old;const tag='0x'+n.toString(16);let b:FreshBlock|null=null;
   try{b=await invoke<FreshBlock>(rpc,'eth_getBlockByNumber',[tag,false]);}catch{b=null;}
   let code:string|undefined,source:'node'|'explicit_archive'='node';
   if(b)try{code=await invoke<string>(rpc,'eth_getCode',[context.tokenAddress,{blockHash:b.hash,requireCanonical:true}]);}catch{code=undefined;}
   if(code===undefined){const archive=options.archiveRpc;if(!archive)return null;if(!archiveChecked){if(await invoke<string>(archive,'eth_chainId',[])!=='0x38')throw Error('token_discovery_archive_chain');archiveChecked=true;}
    const prior=b,before=await invoke<FreshBlock>(archive,'eth_getBlockByNumber',[tag,false]);if(prior&&(prior.hash!==before?.hash||prior.parentHash!==before.parentHash||prior.number!==before.number))throw Error('token_discovery_archive_header_mismatch');
    b=before;code=await invoke<string>(archive,'eth_getCode',[context.tokenAddress,tag]);const after=await invoke<FreshBlock>(archive,'eth_getBlockByNumber',[tag,false]);if(!b||b.hash!==after?.hash||b.parentHash!==after.parentHash||b.timestamp!==after.timestamp)throw Error('token_discovery_archive_reorg');source='explicit_archive';
   }
   if(!b||number(b.number)!==n||!freshHash(b.hash)||!freshHash(b.parentHash)||!rawCode(code))throw Error('token_discovery_code_invalid');
   const item={block:b,code,source};observations.set(n,item);return item;
  };
  const upper=await observe(context.observed.number);if(!upper||upper.code==='0x'||upper.block.hash!==context.observed.hash)return null;
  let low=Math.max(context.start.number,context.observed.number-16),lower=await observe(low);
  if(!lower)return null;if(lower.code!=='0x'){if(low!==context.start.number){if(!options.archiveRpc)return null;low=context.start.number;lower=await observe(low);if(!lower)return null;}
   if(lower.code!=='0x')return{version:1,kind:'canonical_pre_boundary_code_v1',chainId:56,tokenAddress:context.tokenAddress,start:context.start,block:lower.block,code:lower.code,source:lower.source};}
  let high=context.observed.number;while(high-low>1){const mid=low+Math.floor((high-low)/2),value=await observe(mid);if(!value)return null;if(value.code==='0x')low=mid;else{if(value.code!==upper.code)throw Error('token_discovery_runtime_changed');high=mid;}}
  const parent=await observe(low),birth=await observe(high);if(!parent||!birth||parent.code!=='0x'||birth.code!==upper.code||high<=context.start.number)return null;
  const source=birth.source==='explicit_archive'||parent.source==='explicit_archive'?'explicit_archive':'node',read=source==='node'?rpc:options.archiveRpc!;
  const full=await invoke<FreshBlock>(read,'eth_getBlockByNumber',['0x'+high.toString(16),true]);if(!full||full.hash!==birth.block.hash||full.parentHash!==parent.block.hash)return null;
  const logs=await invoke<any[]>(read,'eth_getLogs',[{address:context.tokenAddress,fromBlock:full.number,toBlock:full.number,topics:[transferTopic,'0x'+'0'.repeat(64)]}]);if(!Array.isArray(logs)||logs.length>32)return null;
  const candidates=[...new Set(logs.filter(l=>!l.removed&&l.blockHash===full.hash&&l.address===context.tokenAddress).map(l=>l.transactionHash))].slice(0,4);
  for(const hash of candidates){const tx=full.transactions.find(t=>typeof t==='object'&&t.hash===hash);if(!tx)continue;const receipt=await invoke<any>(read,'eth_getTransactionReceipt',[hash]);validateFreshReceipt(receipt,tx,full);if(receipt.status!=='0x1')continue;
   const entry:FreshCapturedReceipt={transaction:tx,receipt,wallets:[],observedAt:new Date().toISOString()};const proof:FreshTokenCreationProof={version:1,kind:'canonical_token_birth_v1',chainId:56,tokenAddress:context.tokenAddress,start:context.start,block:full,parent:parent.block,entry,parentCode:'0x',code:birth.code,mode:tx.to===null&&receipt.contractAddress===context.tokenAddress?'top_level_creation':'exact_state_birth',source};
   const checked=await validateFreshTokenCreationProof(proof,context.start,async n=>{const b=await invoke<FreshBlock>(read,'eth_getBlockByNumber',['0x'+n.toString(16),false]);return b?header(b):null;},async(token,b)=>{const saved=observations.get(b.number);return token===context.tokenAddress&&saved?.block.hash===b.hash?saved.code:null;});if(checked)return proof;
  }
  return null;
 };
}
/** One optional proof task per pass. The resolver is node-first and external
 * history is opt-in; unconfigured/unavailable sources stay visibly pending. */
export async function runFreshTokenDiscovery(db:Pool,rpc:Rpc,options:{resolve?:FreshTokenDiscoveryResolver;archiveRpc?:Rpc;canonicalCode?:(token:string,block:FreshDiscoveryHeader)=>Promise<string|null>;signal?:AbortSignal;now?:Date}={}){
 const now=options.now??new Date(),empty={resolved:0,pending:0,yielded:false};if(options.signal?.aborted)return{...empty,yielded:true};
 const capture=(await db.query(`SELECT c.block_number::text,c.block_hash,c.revision::text,b.parent_hash,b.occurred_at FROM fresh.checkpoints c JOIN fresh.recent_blocks b ON b.block_number=c.block_number AND b.block_hash=c.block_hash WHERE c.key='capture'`)).rows[0];
 if(!capture||now.getTime()-new Date(capture.occurred_at).getTime()>20_000)return{...empty,...await readFreshTokenDiscoveryHealth(db),yielded:true};
 const lease=randomUUID(),job=(await db.query(`UPDATE fresh.jobs SET lease_id=$2,lease_until=$1::timestamptz+interval '30 seconds' WHERE id=(SELECT id FROM fresh.jobs WHERE kind='token_discovery' AND state='pending' AND due_at<=$1 AND(lease_until IS NULL OR lease_until<=$1) ORDER BY due_at,id LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING *`,[now,lease])).rows[0];
 if(!job)return{...empty,...await readFreshTokenDiscoveryHealth(db)};
 try{
  const start=(await db.query("SELECT block_number::text,block_hash FROM fresh.checkpoints WHERE key='start'")).rows[0];if(!start||job.progress?.startBlock!==Number(start.block_number)||job.progress?.startHash!==start.block_hash)throw Error('token_discovery_boundary_changed');
  const last=job.progress.lastSeen,observedRow=(await db.query('SELECT block_number::text,block_hash,parent_hash,occurred_at FROM fresh.recent_blocks WHERE block_number=$1 AND block_hash=$2',[last?.blockNumber,last?.blockHash])).rows[0];
  if(!observedRow)throw Error('token_discovery_observation_orphaned');
  const observed={number:Number(observedRow.block_number),hash:observedRow.block_hash,parentHash:observedRow.parent_hash,timestamp:new Date(observedRow.occurred_at).toISOString()};
  const resolver=options.resolve??createFreshTokenDiscoveryResolver(rpc,{archiveRpc:options.archiveRpc,maxMs:options.archiveRpc?20_000:10_000,maxCalls:options.archiveRpc?144:96}),proof=await resolver({tokenAddress:job.reference,start:{number:Number(start.block_number),hash:start.block_hash},observed,signal:options.signal});
  if(!proof)throw Error('token_creation_proof_unavailable');
  if(proof.tokenAddress!==job.reference||number(proof.block.number)>observed.number)throw Error('token_discovery_proof_context');
  const canonicalHeader=async(n:number)=>{const b=await rpc<FreshBlock>('eth_getBlockByNumber',['0x'+n.toString(16),false]);return b?header(b):null;};
  const canonicalCode=options.canonicalCode??(async(token,b)=>{try{return await rpc<string>('eth_getCode',[token,{blockHash:b.hash,requireCanonical:true}]);}catch{if(!options.archiveRpc)return null;
   const archive=options.archiveRpc,before=await archive<FreshBlock>('eth_getBlockByNumber',['0x'+b.number.toString(16),false]);if(stable(header(before))!==stable(b))throw Error('token_discovery_archive_header_mismatch');
   const result=await archive<string>('eth_getCode',[token,'0x'+b.number.toString(16)]),after=await archive<FreshBlock>('eth_getBlockByNumber',['0x'+b.number.toString(16),false]);if(stable(header(after))!==stable(b))throw Error('token_discovery_archive_reorg');return result;}});
  const startContext={number:Number(start.block_number),hash:start.block_hash},oldProof=proof.kind==='canonical_pre_boundary_code_v1',fact=oldProof?null:await validateFreshTokenCreationProof(proof,startContext,canonicalHeader,canonicalCode);
  if(oldProof?!await validateFreshPreBoundaryCodeProof(proof,startContext,canonicalHeader,canonicalCode):!fact)throw Error('token_creation_proof_invalid');
  const proofHeaders=oldProof?[header(proof.block)]:[header(proof.block),header(proof.parent)];
  // Network bookends precede locks. Reorg revision and retained headers are
  // then checked atomically, keeping slow archive calls out of financial work.
  for(const h of proofHeaders)if(stable(await canonicalHeader(h.number))!==stable(h))throw Error('token_discovery_birth_invalidated');
  const client=await db.connect();try{await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock(73621941)');
   const held=(await client.query('SELECT * FROM fresh.jobs WHERE id=$1 AND lease_id=$2 AND lease_until>$3 FOR UPDATE',[job.id,lease,new Date()])).rows[0];if(!held)throw Error('token_discovery_lease_changed');
   if(stable(held.progress)!==stable(job.progress))throw Error('token_discovery_context_changed');
   const lockedStart=(await client.query("SELECT block_number::text,block_hash FROM fresh.checkpoints WHERE key='start' FOR SHARE")).rows[0];if(stable(lockedStart)!==stable(start))throw Error('token_discovery_boundary_changed');
   const lockedCapture=(await client.query("SELECT revision::text FROM fresh.checkpoints WHERE key='capture' FOR SHARE")).rows[0];if(lockedCapture?.revision!==capture.revision)throw Error('token_discovery_capture_changed');
   const latest=(await client.query('SELECT block_hash FROM fresh.recent_blocks WHERE block_number=$1 FOR SHARE',[last.blockNumber])).rows[0];if(latest?.block_hash!==last.blockHash)throw Error('token_discovery_observation_orphaned');
   for(const expected of proofHeaders){
    const canonical=(await client.query('SELECT block_hash FROM fresh.recent_blocks WHERE block_number=$1 FOR SHARE',[expected.number])).rows[0];
    if(canonical&&canonical.block_hash!==expected.hash)throw Error('token_discovery_birth_invalidated');
   }
   if(fact){const old=(await client.query('SELECT * FROM fresh.launch_facts WHERE token_address=$1 FOR UPDATE',[job.reference])).rows[0];if(old&&(old.block_hash!==fact.blockHash||old.tx_hash!==fact.txHash||old.status!==fact.status))throw Error('token_discovery_launch_conflict');
    await client.query(`INSERT INTO fresh.launch_facts(token_address,protocol,block_number,block_hash,tx_hash,log_index,launched_at,proof,status)VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)ON CONFLICT(token_address)DO NOTHING`,[fact.tokenAddress,fact.protocol,fact.blockNumber,fact.blockHash,fact.txHash,fact.logIndex,fact.launchedAt,JSON.stringify(fact.proof),fact.status]);}
   const progress=oldProof?{stage:'before_boundary_verified',boundaryCode:{version:1,kind:proof.kind,chainId:56,tokenAddress:proof.tokenAddress,blockNumber:number(proof.block.number),blockHash:proof.block.hash,runtimeSha256:codeSha(proof.code),runtimeBytes:(proof.code.length-2)/2,source:proof.source}}:{stage:'creation_verified',factHash:sha(fact)};
   const published=await client.query("UPDATE fresh.jobs SET state='done',lease_id=NULL,lease_until=NULL,last_error=NULL,progress=progress||$3::jsonb,updated_at=clock_timestamp() WHERE id=$1 AND lease_id=$2 AND lease_until>clock_timestamp() RETURNING id",[job.id,lease,JSON.stringify(progress)]);
   if(published.rowCount!==1)throw Error('token_discovery_lease_changed');
   // Release a bounded set of already canonical repair references promptly;
   // authentic financial values and decoder diagnostics remain untouched.
   const refs=[job.progress.firstSeen,job.progress.lastSeen].filter(Boolean).map(r=>r.txHash+':'+r.blockHash);
   await client.query(`UPDATE fresh.jobs SET due_at=$3,updated_at=clock_timestamp() WHERE id IN(
    SELECT j.id FROM fresh.jobs j JOIN fresh.recent_evidence e ON j.reference=e.tx_hash||':'||e.block_hash
    JOIN fresh.recent_blocks b ON b.block_number=e.block_number AND b.block_hash=e.block_hash
    WHERE j.kind='decode_receipt' AND j.state='pending' AND e.decoder_status='repair' AND e.expires_at>$3
    AND(j.lease_until IS NULL OR j.lease_until<=$3) AND(j.reference=ANY($1::text[]) OR $2=ANY(e.position_dependency_addresses))
    ORDER BY e.block_number,e.transaction_index,j.id LIMIT 64 FOR UPDATE OF j SKIP LOCKED)`,[refs,job.reference,new Date()]);
   const health=await readFreshTokenDiscoveryHealth(client);await client.query('COMMIT');return{resolved:1,...health,yielded:false};
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
 }catch(error){const reason=error instanceof Error?error.message.replace(/https?:\/\/\S+/g,'[endpoint]').slice(0,120):'token_creation_proof_unavailable';await db.query("UPDATE fresh.jobs SET lease_id=NULL,lease_until=NULL,attempts=attempts+1,last_error=$3,due_at=$4::timestamptz+interval '60 seconds',updated_at=clock_timestamp() WHERE id=$1 AND lease_id=$2",[job.id,lease,reason,now]);return{resolved:0,...await readFreshTokenDiscoveryHealth(db),yielded:false,reason};}
}
