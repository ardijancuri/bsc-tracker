import {createHash,randomUUID} from 'node:crypto';
import{Interface,getCreateAddress}from'ethers';
import type {Pool,PoolClient} from 'pg';
import {RpcRequestError,type Rpc} from '../rpc.js';
import {transferTopic} from '../swap.js';
import {freshAddress,freshHash,freshInteger,validateFreshReceipt,decodeFreshEvidence,type FreshBlock,type FreshCapturedReceipt,type FreshLaunchFact} from './capture.js';
import {readFreshTokenAdmission} from './tracking.js';
import {validateFreshTrace} from './trace.js';
import {validFreshCompleteCallTrace} from './passiveIncoming.js';
import {classifyFreshCreationToken} from './tokenAuthenticity.js';
import{queueFreshAdmissionRecheck,freshAdmissionTransferWallets}from'./admissionRecheck.js';

export type FreshTokenDiscovery='eligible'|'excluded'|'pending';
const stable=(v:unknown):string=>JSON.stringify(v,(_k,x:unknown)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.entries(x).sort(([a],[b])=>a.localeCompare(b))):x);
const sha=(v:unknown)=>createHash('sha256').update(typeof v==='string'?v:stable(v)).digest('hex');
const codeSha=(v:string)=>createHash('sha256').update(Buffer.from(v.slice(2),'hex')).digest('hex');
const number=(v:unknown)=>{const n=Number(freshInteger(v));if(!Number.isSafeInteger(n))throw Error('token_discovery_number');return n;};
const rawCode=(v:unknown):v is string=>typeof v==='string'&&/^0x(?:[a-f0-9]{2})*$/i.test(v)&&v.length<=2+128*1024;
export interface FreshDiscoveryHeader{number:number;hash:string;parentHash:string;timestamp:string}
export interface FreshDiscoveryBoundary{number:number;hash:string;timestamp:string}
const header=(b:FreshBlock):FreshDiscoveryHeader=>({number:number(b.number),hash:b.hash,parentHash:b.parentHash,timestamp:new Date(number(b.timestamp)*1000).toISOString()});
function trustedDiscoveryBoundary(value:unknown,start:{number:number;hash:string}):FreshDiscoveryBoundary|undefined{
 const b=value as FreshDiscoveryBoundary;return b&&b.number===start.number&&b.hash===start.hash&&Number.isSafeInteger(b.number)&&b.number>=0&&freshHash(b.hash)===b.hash
  &&typeof b.timestamp==='string'&&Number.isFinite(Date.parse(b.timestamp))&&new Date(b.timestamp).toISOString()===b.timestamp?b:undefined;
}
const isTrustedDiscoveryBoundary=(b:FreshDiscoveryHeader,trusted:FreshDiscoveryBoundary|undefined)=>!!trusted&&b.number===trusted.number&&b.hash===trusted.hash&&b.timestamp===trusted.timestamp;
async function discoveryNodeHeader(node:Rpc,n:number,expected?:FreshDiscoveryHeader,trustedBoundary?:FreshDiscoveryBoundary):Promise<FreshBlock|null>{
 try{return await node<FreshBlock|null>('eth_getBlockByNumber',['0x'+n.toString(16),false]);}
 catch(error){if(error instanceof RpcRequestError&&error.nullResult===true&&expected&&expected.number===n&&isTrustedDiscoveryBoundary(expected,trustedBoundary))return null;throw error;}
}
function hashSelectorNumericFallback(error:unknown){return error instanceof RpcRequestError&&(error.message==='discovery_archive_hash_selector_unsupported'&&['rpc_error','state_unavailable'].includes(error.category)||error.message==='discovery_archive_hash_state_unavailable'&&error.category==='state_unavailable'&&error.code===-32000);}
/** Prefer genuine hash-pinned code. Only a diagnosed selector incompatibility
 * or hash-state backend gap permits the dated numeric request with complete
 * archive header bookends and the owned-node canonical check. A quota,
 * transport failure, invalid response or noncanonical hash cannot fall back. */
async function discoveryArchiveCode(archive:Rpc,node:Rpc,token:string,expected:FreshDiscoveryHeader,trustedBoundary?:FreshDiscoveryBoundary){
 const tag='0x'+expected.number.toString(16);let code:unknown,boundaryPruned=false;
 // Only the initialized immutable start checkpoint can outlive owned-node
 // headers. Its exact stored hash AND timestamp authorize archive bookends;
 // an owned-node disagreement can never use this exception.
 if(isTrustedDiscoveryBoundary(expected,trustedBoundary)){
  const own=await discoveryNodeHeader(node,expected.number,expected,trustedBoundary);if(own){if(stable(header(own))!==stable(expected))throw Error('token_discovery_archive_reorg');}
  else{boundaryPruned=true;const before=await archive<FreshBlock>('eth_getBlockByNumber',[tag,false]);if(!before||stable(header(before))!==stable(expected))throw Error('token_discovery_archive_header_mismatch');}
 }
 try{code=await archive('eth_getCode',[token,{blockHash:expected.hash,requireCanonical:true}]);}
 catch(error){if(!hashSelectorNumericFallback(error))throw error;
  const before=await archive<FreshBlock>('eth_getBlockByNumber',[tag,false]);if(!before||stable(header(before))!==stable(expected))throw Error('token_discovery_archive_header_mismatch');
  code=await archive('eth_getCode',[token,tag]);const after=await archive<FreshBlock>('eth_getBlockByNumber',[tag,false]);if(!after||stable(header(after))!==stable(expected))throw Error('token_discovery_archive_reorg');
 }
 if(!rawCode(code))throw new RpcRequestError('discovery_archive_code_invalid','invalid_response');
 if(boundaryPruned){const after=await archive<FreshBlock>('eth_getBlockByNumber',[tag,false]);if(!after||stable(header(after))!==stable(expected))throw Error('token_discovery_archive_reorg');}
 const after=await discoveryNodeHeader(node,expected.number,expected,trustedBoundary);if(after?stable(header(after))!==stable(expected):!boundaryPruned)throw Error('token_discovery_archive_reorg');return code;
}
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
/** Only the queue's two advancing observation fields may race a search. All
 * proof/search/core fields remain exact; the new reference is independently
 * checked against its original retained body and current watched membership. */
export async function reconcileFreshDiscoveryProgress(db:Pick<Pool,'query'>,token:string,expected:any,current:any,lock=false){
 const unchanged=stable(expected)===stable(current);if(unchanged&&!lock)return current;
 const core=(p:any)=>{if(!p||typeof p!=='object'||Array.isArray(p))throw Error('token_discovery_context_changed');const{lastSeen:_last,wallets:_wallets,...rest}=p;return rest;};
 if(stable(core(expected))!==stable(core(current)))throw Error('token_discovery_context_changed');
 const ref=(r:any)=>r&&Object.keys(r).sort().join(',')==='blockHash,blockNumber,txHash'&&freshHash(r.txHash)===r.txHash&&freshHash(r.blockHash)===r.blockHash&&Number.isSafeInteger(r.blockNumber);
 const old=expected.lastSeen,next=current.lastSeen,wallets=current.wallets;
 if(!ref(old)||!ref(next)||!unchanged&&next.blockNumber<=old.blockNumber||next.blockNumber<=current.startBlock||!Array.isArray(wallets)||!wallets.length||wallets.length>256
  ||new Set(wallets).size!==wallets.length||wallets.some((w:unknown)=>freshAddress(w)!==w))throw Error('token_discovery_context_changed');
 const row=(await db.query(`SELECT e.payload,e.wallet_addresses,e.block_number::text,e.transaction_index,b.block_hash,b.parent_hash,b.occurred_at
  FROM fresh.recent_evidence e JOIN fresh.recent_blocks b USING(block_number,block_hash)
  WHERE e.tx_hash=$1 AND e.block_hash=$2 AND e.block_number=$3 AND e.expires_at>clock_timestamp()${lock?' FOR SHARE OF e,b':''}`,[next.txHash,next.blockHash,next.blockNumber])).rows[0];
 if(!row||!Buffer.isBuffer(row.payload)||row.payload.length>2*1024*1024)throw Error('token_discovery_context_changed');
 const saved=decodeFreshEvidence(row.payload);
 if(saved.transaction.hash!==next.txHash||saved.transaction.blockHash!==next.blockHash||number(saved.transaction.blockNumber)!==next.blockNumber
  ||Number(row.block_number)!==next.blockNumber||row.block_hash!==next.blockHash||number(saved.transaction.transactionIndex)!==Number(row.transaction_index)
  ||stable([...saved.wallets].sort())!==stable([...row.wallet_addresses].sort())||new Set(saved.wallets).size!==saved.wallets.length||saved.wallets.length>256
  ||saved.transaction.to!==token&&!saved.receipt.logs.some(log=>log.address===token))throw Error('token_discovery_context_changed');
 validateFreshReceipt(saved.receipt,saved.transaction,{number:'0x'+next.blockNumber.toString(16),hash:next.blockHash,parentHash:row.parent_hash,timestamp:'0x'+Math.floor(new Date(row.occurred_at).getTime()/1000).toString(16),transactions:[saved.transaction]});
 const monitored=(await db.query(`SELECT address FROM fresh.wallets WHERE address=ANY($1::text[]) AND active AND monitoring_from_block<=$2
  AND(monitoring_to_block IS NULL OR monitoring_to_block>=$2) ORDER BY address${lock?' FOR SHARE':''}`,[saved.wallets,next.blockNumber])).rows.map(r=>r.address);
 if(stable([...wallets].sort())!==stable(monitored))throw Error('token_discovery_context_changed');
 return current;
}
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

/** Bounded code/header observations, not financial responses. A resumed search
 * rechecks each reused header against the owned node; publication still reads
 * the final adjacent code observations through the exact-block validator. */
export interface FreshDiscoverySearch {
 version:1;kind:'canonical_code_search_v1';chainId:56;tokenAddress:string;start:{number:number;hash:string};observed:FreshDiscoveryHeader;
 codes:{sha256:string;code:string}[];observations:{block:FreshDiscoveryHeader;codeSha256:string;source:'node'|'explicit_archive'}[];
}
/** Bounded owned-node log scans provide a candidate, never launch proof.
 * Actual adjacent code/header observations and the original receipt still
 * pass the ordinary creation validator before any admission can be written. */
export async function readFreshTokenMintBirthHint(rpc:Rpc,context:{tokenAddress:string;start:{number:number;hash:string};observed:FreshDiscoveryHeader},maxBlocks=600000){
 const span=context.observed.number-context.start.number;
 if(freshAddress(context.tokenAddress)!==context.tokenAddress||!Number.isSafeInteger(context.start.number)||context.start.number<0||!Number.isSafeInteger(context.observed.number)
  ||freshHash(context.start.hash)!==context.start.hash||freshHash(context.observed.hash)!==context.observed.hash||!Number.isSafeInteger(span)||span<1)return null;
 const blocks=Number.isSafeInteger(maxBlocks)?Math.min(600000,Math.max(16,maxBlocks)):600000,
  starts=[...new Set([4096,65536,600000].map(size=>Math.max(context.start.number+1,context.observed.number-Math.min(size,blocks)+1)))];
 for(const from of starts){
 let logs:any;try{logs=await rpc('eth_getLogs',[{address:context.tokenAddress,fromBlock:'0x'+from.toString(16),toBlock:'0x'+context.observed.number.toString(16),topics:[transferTopic,'0x'+'0'.repeat(64)]}]);}catch{continue;}
 if(!Array.isArray(logs)||logs.length>32||Buffer.byteLength(stable(logs))>128*1024)return null;
 if(!logs.length)continue;
 const candidates:{number:number;hash:string;transactionHash:string;transactionIndex:number;logIndex:number;log:any}[]=[],seen=new Set<string>();
 try{for(const log of logs){const n=number(log.blockNumber),index=number(log.transactionIndex),at=number(log.logIndex),identity=n+':'+index+':'+at;
  if(log.removed||log.address!==context.tokenAddress||!Array.isArray(log.topics)||log.topics.length!==3||log.topics[0]!==transferTopic||log.topics[1]!=='0x'+'0'.repeat(64)
   ||!/^0x0{24}[0-9a-f]{40}$/.test(log.topics[2])||log.topics[2]==='0x'+'0'.repeat(64)||!/^0x[0-9a-f]{64}$/.test(log.data)||BigInt(log.data)<=0n
   ||freshHash(log.blockHash)!==log.blockHash||freshHash(log.transactionHash)!==log.transactionHash||n<from||n>context.observed.number||seen.has(identity))return null;
  seen.add(identity);candidates.push({number:n,hash:log.blockHash,transactionHash:log.transactionHash,transactionIndex:index,logIndex:at,log});}
 }catch{return null;}
 return candidates.sort((a,b)=>a.number-b.number||a.transactionIndex-b.transactionIndex||a.logIndex-b.logIndex)[0];
 }
 return null;
}
export type FreshTokenDiscoveryResolver=(context:{tokenAddress:string;start:{number:number;hash:string};observed:FreshDiscoveryHeader;signal?:AbortSignal;
 search?:unknown;saveSearch?:(search:FreshDiscoverySearch)=>Promise<void>})=>Promise<FreshTokenDiscoveryProof|null>;
function readDiscoverySearch(value:unknown,context:{tokenAddress:string;start:{number:number;hash:string};observed:FreshDiscoveryHeader}):FreshDiscoverySearch|null{
 try{const p=value as FreshDiscoverySearch;if(!p||p.version!==1||p.kind!=='canonical_code_search_v1'||p.chainId!==56||p.tokenAddress!==context.tokenAddress
   ||stable(p.start)!==stable(context.start)||stable(p.observed)!==stable(context.observed)||!Array.isArray(p.codes)||p.codes.length>4
   ||!Array.isArray(p.observations)||p.observations.length>64||Buffer.byteLength(stable(p))>384*1024)return null;
  const codes=new Set<string>();for(const c of p.codes){if(!rawCode(c.code)||c.sha256!==codeSha(c.code)||codes.has(c.sha256))return null;codes.add(c.sha256);}
  const seen=new Set<number>();for(const o of p.observations){const b=o.block;if(!Number.isSafeInteger(b.number)||b.number<context.start.number||b.number>context.observed.number||seen.has(b.number)
   ||freshHash(b.hash)!==b.hash||freshHash(b.parentHash)!==b.parentHash||!Number.isFinite(Date.parse(b.timestamp))||new Date(b.timestamp).toISOString()!==b.timestamp
   ||!codes.has(o.codeSha256)||!['node','explicit_archive'].includes(o.source))return null;seen.add(b.number);}return p;
 }catch{return null;}
}
const discoveryApprovalAbi=new Interface(['function approve(address spender,uint256 amount)','event Approval(address indexed owner,address indexed spender,uint256 value)']);
/** A successful public wallet's direct, exact approval can require token-age
 * evidence to classify its real gas expense. It authorizes only a contract
 * birth lookup; it establishes no trade, token eligibility, price or P&L. */
export function freshDiscoveryApprovalWallets(entry:FreshCapturedReceipt,token:string,block:FreshDiscoveryHeader):string[]{
 try{
  const tx=entry.transaction,input=tx.input;
  if(freshAddress(token)!==token||tx.to!==token||freshAddress(tx.from)!==tx.from||!Array.isArray(entry.wallets)||!entry.wallets.length||entry.wallets.length>256
   ||new Set(entry.wallets).size!==entry.wallets.length||entry.wallets.some(w=>freshAddress(w)!==w)||!entry.wallets.includes(tx.from)||entry.receipt.status!=='0x1'
   ||freshInteger(tx.value)!==0n||tx.chainId!==undefined&&freshInteger(tx.chainId)!==56n||typeof input!=='string'||!/^0x[0-9a-f]{136}$/i.test(input))return[];
  validateFreshReceipt(entry.receipt,tx,{number:'0x'+block.number.toString(16),hash:block.hash,parentHash:block.parentHash,timestamp:'0x'+Math.floor(Date.parse(block.timestamp)/1000).toString(16),transactions:[tx]});
  const parsed=discoveryApprovalAbi.parseTransaction({data:input});if(!parsed||parsed.name!=='approve'||discoveryApprovalAbi.encodeFunctionData(parsed.fragment,parsed.args).toLowerCase()!==input.toLowerCase())return[];
  const expected=discoveryApprovalAbi.encodeEventLog(discoveryApprovalAbi.getEvent('Approval')!,[tx.from,parsed.args.spender,parsed.args.amount]);
  return entry.receipt.logs.some(log=>log.address===token&&log.data===expected.data&&log.topics.length===expected.topics.length&&log.topics.every((topic,i)=>topic===expected.topics[i]))?[tx.from]:[];
 }catch{return[];}
}
/** External birth evidence is optional and public-only. At most two saved
 * originals establish a positive Transfer or the public origin's direct exact
 * approval with its matching Approval log. Router addresses, unrelated events,
 * private memberships and an unverified job wallet list cannot authorize it. */
export async function createFreshPublicDiscoveryArchiveRpc(db:Pick<Pool,'query'>,job:{reference:string;progress:any},archive:Rpc,now=new Date()):Promise<Rpc|undefined>{
 if(freshAddress(job.reference)!==job.reference||!Number.isSafeInteger(job.progress?.startBlock)||job.progress.startBlock<0||freshHash(job.progress?.startHash)!==job.progress?.startHash)return undefined;
 const deadline=Date.now()+20_000;
 const refs=[job.progress?.firstSeen,job.progress?.lastSeen].filter((r,i,a)=>r&&a.findIndex(x=>x?.txHash===r.txHash&&x?.blockHash===r.blockHash)===i);
 if(!refs.length||refs.length>2)return undefined;
 const contexts:{txHash:string;blockHash:string;blockNumber:number;transactionIndex:number;wallets:string[]}[]=[];let bytes=0;
 const roleSql=`SELECT w.address FROM fresh.wallets w JOIN fresh.kols k ON k.wallet_address=w.address AND k.is_tracked
  JOIN fresh.accounting_scopes s ON s.id='kol:'||w.address AND s.active AND s.kind='kol' AND s.account_id IS NULL AND w.address=ANY(s.wallet_addresses)
  WHERE w.address=ANY($1::text[]) AND w.active AND w.monitoring_from_block<=$2 AND(w.monitoring_to_block IS NULL OR w.monitoring_to_block>=$2)
  AND s.starts_block<=$2 AND s.starts_at<=$3 ORDER BY w.address`;
 for(const ref of refs){
  if(freshHash(ref.txHash)!==ref.txHash||freshHash(ref.blockHash)!==ref.blockHash||!Number.isSafeInteger(ref.blockNumber)||ref.blockNumber<=job.progress?.startBlock)continue;
  const row=(await db.query(`SELECT e.tx_hash,e.block_hash,e.block_number::text,e.transaction_index,e.payload,e.wallet_addresses,e.expires_at,b.occurred_at
   FROM fresh.recent_evidence e JOIN fresh.recent_blocks b USING(block_number,block_hash)
   WHERE e.tx_hash=$1 AND e.block_hash=$2 AND e.block_number=$3 AND e.expires_at>$4`,[ref.txHash,ref.blockHash,ref.blockNumber,now])).rows[0];
  if(!row||!Buffer.isBuffer(row.payload)||(bytes+=row.payload.length)>2*1024*1024)continue;
  try{
   const entry=decodeFreshEvidence(row.payload),index=number(entry.transaction.transactionIndex);
   if(entry.transaction.hash!==row.tx_hash||entry.transaction.blockHash!==row.block_hash||number(entry.transaction.blockNumber)!==Number(row.block_number)
    ||index!==Number(row.transaction_index)||stable([...entry.wallets].sort())!==stable([...row.wallet_addresses].sort()))continue;
   const referenceBlock={number:Number(row.block_number),hash:row.block_hash,parentHash:row.block_hash,timestamp:new Date(row.occurred_at).toISOString()},
    touched=[...new Set([...freshAdmissionTransferWallets(entry,job.reference,referenceBlock),...freshDiscoveryApprovalWallets(entry,job.reference,referenceBlock)])];
   if(!touched.length)continue;const wallets=(await db.query(roleSql,[touched,row.block_number,row.occurred_at])).rows.map(r=>r.address);
   if(wallets.length)contexts.push({txHash:row.tx_hash,blockHash:row.block_hash,blockNumber:Number(row.block_number),transactionIndex:index,wallets});
  }catch{/* A corrupt or noncanonical original never authorizes an external read. */}
 }
 if(!contexts.length)return undefined;
 // Recheck canonical retention and CURRENT public membership before each wire
 // request. No full payload/history is fetched again and no lock spans RPC.
 const current=async()=>{for(const ctx of contexts){const row=(await db.query(`SELECT e.wallet_addresses,b.occurred_at FROM fresh.recent_evidence e
   JOIN fresh.recent_blocks b USING(block_number,block_hash) WHERE e.tx_hash=$1 AND e.block_hash=$2 AND e.block_number=$3 AND e.transaction_index=$4 AND e.expires_at>clock_timestamp()`,[ctx.txHash,ctx.blockHash,ctx.blockNumber,ctx.transactionIndex])).rows[0];
   if(row&&(await db.query(roleSql,[ctx.wallets.filter(w=>row.wallet_addresses.includes(w)),ctx.blockNumber,row.occurred_at])).rows.length)return true;}return false;};
 return async<T>(method:string,params:unknown[])=>{if(!await current())throw Error('discovery_archive_public_context_changed');if(Date.now()>deadline)throw Error('token_discovery_budget');return archive<T>(method,params);};
}
export async function readFreshTokenDiscoveryHealth(db:Pick<Pool,'query'>){const r=(await db.query(`SELECT count(*)FILTER(WHERE state='pending')::int AS pending,
 count(*)FILTER(WHERE state='pending' AND lease_until>clock_timestamp())::int AS leased,count(*)FILTER(WHERE state='done')::int AS completed
 FROM fresh.jobs WHERE kind='token_discovery'`)).rows[0];return{pending:Number(r?.pending??0),leased:Number(r?.leased??0),completed:Number(r?.completed??0)};}
/** Recent state is attempted on the owned node first. Historical archive
 * access exists only when the caller explicitly supplies an RPC. Every state
 * read is bracketed by its exact canonical header; no current code is relabeled
 * historical. The bounded search never runs from an ordinary page request. */
export function createFreshTokenDiscoveryResolver(rpc:Rpc,options:{archiveRpc?:Rpc;boundaryFirst?:boolean;recentNodeFirst?:boolean;mintHints?:boolean;mintHintBlocks?:number;trustedBoundary?:FreshDiscoveryBoundary;maxCalls?:number;maxMs?:number}={}):FreshTokenDiscoveryResolver{
 return async context=>{
  // A provider cooldown must not consume the node's tiny historical window.
  // The recent attempt is independent of optional archive/search progress.
  if(options.recentNodeFirst&&options.archiveRpc){try{const recent=await createFreshTokenDiscoveryResolver(rpc,{mintHints:options.mintHints,mintHintBlocks:4096,maxCalls:48,maxMs:2500})({...context,search:undefined,saveSearch:undefined});if(recent)return recent;}catch(error){if(context.signal?.aborted)throw error;}}
  const finite=(value:number|undefined,fallback:number)=>typeof value==='number'&&Number.isFinite(value)?Math.floor(value):fallback;
  const deadline=Date.now()+Math.min(20_000,Math.max(1000,finite(options.maxMs,10_000))),maxCalls=Math.min(160,Math.max(8,finite(options.maxCalls,96)));let calls=0,archiveChecked=false;
  const invoke=async<T>(source:Rpc,method:string,params:unknown[])=>{if(context.signal?.aborted||Date.now()>deadline||++calls>maxCalls)throw Error('token_discovery_budget');return source<T>(method,params);};
  if(await invoke<string>(rpc,'eth_chainId',[])!=='0x38')throw Error('token_discovery_chain');
  const trustedBoundary=trustedDiscoveryBoundary(options.trustedBoundary,context.start),observations=new Map<number,{block:FreshBlock;code:string;source:'node'|'explicit_archive'}>();
  const retained=readDiscoverySearch(context.search,context),verified=new Set<number>();
  const search:FreshDiscoverySearch=retained?structuredClone(retained):{version:1,kind:'canonical_code_search_v1',chainId:56,tokenAddress:context.tokenAddress,start:context.start,observed:context.observed,codes:[],observations:[]};
  if(retained)for(const o of retained.observations){const b=o.block;observations.set(b.number,{block:{number:'0x'+b.number.toString(16),hash:b.hash,parentHash:b.parentHash,timestamp:'0x'+Math.floor(Date.parse(b.timestamp)/1000).toString(16),transactions:[]},code:retained.codes.find(c=>c.sha256===o.codeSha256)!.code,source:o.source});}
  const remember=async(item:{block:FreshBlock;code:string;source:'node'|'explicit_archive'})=>{
   const b=header(item.block),digest=codeSha(item.code);if(!search.codes.some(c=>c.sha256===digest))search.codes.push({sha256:digest,code:item.code});
   search.observations.push({block:b,codeSha256:digest,source:item.source});
   if(!readDiscoverySearch(search,context))throw Error('token_discovery_search_bounds');
   await context.saveSearch?.(structuredClone(search));
  };
  const observe=async(n:number)=>{const old=observations.get(n);if(old){if(!verified.has(n)){const canonical=await discoveryNodeHeader(<T>(m:string,p:unknown[])=>invoke<T>(rpc,m,p),n,header(old.block),trustedBoundary);if(canonical?stable(header(canonical))!==stable(header(old.block)):!isTrustedDiscoveryBoundary(header(old.block),trustedBoundary))throw Error('token_discovery_search_reorg');verified.add(n);}return old;}const tag='0x'+n.toString(16);let b:FreshBlock|null=null;
   try{b=await invoke<FreshBlock>(rpc,'eth_getBlockByNumber',[tag,false]);}catch{b=null;}
   let code:string|undefined,source:'node'|'explicit_archive'='node';
   if(b)try{code=await invoke<string>(rpc,'eth_getCode',[context.tokenAddress,{blockHash:b.hash,requireCanonical:true}]);}catch{code=undefined;}
   if(code===undefined){const archive=options.archiveRpc;if(!archive)return null;if(!archiveChecked){if(await invoke<string>(archive,'eth_chainId',[])!=='0x38')throw Error('token_discovery_archive_chain');archiveChecked=true;}
    // If the owned node could not provide even the historical header, retain
    // the original bounded numeric/header path rather than invent a hash.
    if(!b)b=await invoke<FreshBlock>(archive,'eth_getBlockByNumber',[tag,false]);if(!b||number(b.number)!==n)throw Error('token_discovery_archive_header_mismatch');
    code=await discoveryArchiveCode(<T>(m:string,p:unknown[])=>invoke<T>(archive,m,p),<T>(m:string,p:unknown[])=>invoke<T>(rpc,m,p),context.tokenAddress,header(b),trustedBoundary);source='explicit_archive';
   }
   if(!b||number(b.number)!==n||!freshHash(b.hash)||!freshHash(b.parentHash)||!rawCode(code))throw Error('token_discovery_code_invalid');
   const item={block:b,code,source};await remember(item);observations.set(n,item);verified.add(n);return item;
  };
  const canonicalObservedHeader=async(n:number)=>{const saved=observations.get(n),retainedHeader=saved?header(saved.block):undefined,b=await discoveryNodeHeader(<T>(m:string,p:unknown[])=>invoke<T>(rpc,m,p),n,retainedHeader,trustedBoundary);if(b)return header(b);return retainedHeader&&isTrustedDiscoveryBoundary(retainedHeader,trustedBoundary)?retainedHeader:null;};
  // The public-only configured worker may identify an older token with one
  // immutable boundary observation, shared durably by every tracked KOL.
  if(options.archiveRpc&&options.boundaryFirst){let boundary:Awaited<ReturnType<typeof observe>>=null;
   try{boundary=await observe(context.start.number);}catch(error){const category=String((error as {category?:unknown})?.category);
    // The independent recent-node pass already had its complete opportunity.
    // An archive quota cannot be repaired by issuing more archive requests in
    // this pass, which would hide the original provider failure as cooldown.
    if(options.recentNodeFirst&&['rate_limit','transport'].includes(category)||!['rate_limit','state_unavailable','transport'].includes(category))throw error;}
   if(boundary&&boundary.block.hash!==context.start.hash)return null;
   if(boundary&&boundary.code!=='0x')return{version:1,kind:'canonical_pre_boundary_code_v1',chainId:56,tokenAddress:context.tokenAddress,start:context.start,block:boundary.block,code:boundary.code,source:boundary.source};}
  if(options.mintHints!==false&&maxCalls>=16){const hint=await readFreshTokenMintBirthHint(<T>(m:string,p:unknown[])=>invoke<T>(rpc,m,p),context,options.mintHintBlocks);
   if(hint)try{
    // Two candidate blocks only. A delayed mint has nonempty parent code and
    // simply falls through to the unchanged resumable search below.
    const parent=await observe(hint.number-1),birth=await observe(hint.number);
    if(parent?.code==='0x'&&birth?.code&&birth.code!=='0x'&&birth.block.hash===hint.hash){
     const full=await invoke<FreshBlock>(rpc,'eth_getBlockByNumber',['0x'+hint.number.toString(16),true]);
     if(full&&full.hash===hint.hash&&full.parentHash===parent.block.hash){
      const tx=full.transactions[hint.transactionIndex];if(tx&&typeof tx==='object'&&tx.hash===hint.transactionHash){
       const receipt=await invoke<any>(rpc,'eth_getTransactionReceipt',[hint.transactionHash]);validateFreshReceipt(receipt,tx,full);
       const exact=receipt.logs.find((l:any)=>number(l.logIndex)===hint.logIndex),fields=['address','topics','data','logIndex','transactionHash','transactionIndex','blockNumber','blockHash']as const;
       if(receipt.status==='0x1'&&exact&&fields.every(k=>stable(exact[k])===stable(hint.log[k]))){
        const proof:FreshTokenCreationProof={version:1,kind:'canonical_token_birth_v1',chainId:56,tokenAddress:context.tokenAddress,start:context.start,block:full,parent:parent.block,
         entry:{transaction:tx,receipt,wallets:[],observedAt:new Date().toISOString()},parentCode:'0x',code:birth.code,mode:tx.to===null&&receipt.contractAddress===context.tokenAddress?'top_level_creation':'exact_state_birth',source:birth.source==='explicit_archive'||parent.source==='explicit_archive'?'explicit_archive':'node'};
        const checked=await validateFreshTokenCreationProof(proof,context.start,canonicalObservedHeader,async(token,b)=>{const saved=observations.get(b.number);return token===context.tokenAddress&&saved?.block.hash===b.hash?saved.code:null;});if(checked)return proof;
       }
      }
     }
    }
   }catch(error){if(context.signal?.aborted||error instanceof RpcRequestError&&error.category!=='state_unavailable'||['token_discovery_budget','token_discovery_context_changed','token_discovery_search_reorg','token_discovery_archive_reorg','token_discovery_archive_header_mismatch'].includes((error as Error)?.message))throw error;}
  }
  const upper=await observe(context.observed.number);if(!upper||upper.code==='0x'||upper.block.hash!==context.observed.hash)return null;
  let low=Math.max(context.start.number,context.observed.number-16),lower=await observe(low);
  if(!lower)return null;if(lower.code!=='0x'){if(low!==context.start.number){if(!options.archiveRpc)return null;low=context.start.number;lower=await observe(low);if(!lower)return null;}
   if(lower.code!=='0x')return{version:1,kind:'canonical_pre_boundary_code_v1',chainId:56,tokenAddress:context.tokenAddress,start:context.start,block:lower.block,code:lower.code,source:lower.source};}
  let high=context.observed.number;while(high-low>1){const mid=low+Math.floor((high-low)/2),value=await observe(mid);if(!value)return null;if(value.code==='0x')low=mid;else{if(value.code!==upper.code)throw Error('token_discovery_runtime_changed');high=mid;}}
  const parent=await observe(low),birth=await observe(high);if(!parent||!birth||parent.code!=='0x'||birth.code!==upper.code||high<=context.start.number)return null;
  const source=birth.source==='explicit_archive'||parent.source==='explicit_archive'?'explicit_archive':'node',read=source==='node'?rpc:options.archiveRpc!;
  const full=await invoke<FreshBlock>(read,'eth_getBlockByNumber',['0x'+high.toString(16),true]);if(!full||full.hash!==birth.block.hash||full.parentHash!==parent.block.hash)return null;
  const logs=await invoke<any[]>(read,'eth_getLogs',[{address:context.tokenAddress,fromBlock:full.number,toBlock:full.number,topics:[transferTopic,'0x'+'0'.repeat(64)]}]);if(!Array.isArray(logs)||logs.length>32)return null;
  const direct=full.transactions.filter(tx=>{try{return typeof tx==='object'&&tx.to===null&&getCreateAddress({from:tx.from,nonce:freshInteger(tx.nonce)}).toLowerCase()===context.tokenAddress;}catch{return false;}}).map(tx=>tx.hash);
  const candidates=[...new Set([...direct,...logs.filter(l=>!l.removed&&l.blockHash===full.hash&&l.address===context.tokenAddress).map(l=>l.transactionHash)])].slice(0,4);
  for(const hash of candidates){const tx=full.transactions.find(t=>typeof t==='object'&&t.hash===hash);if(!tx)continue;const receipt=await invoke<any>(read,'eth_getTransactionReceipt',[hash]);validateFreshReceipt(receipt,tx,full);if(receipt.status!=='0x1')continue;
   const entry:FreshCapturedReceipt={transaction:tx,receipt,wallets:[],observedAt:new Date().toISOString()};const proof:FreshTokenCreationProof={version:1,kind:'canonical_token_birth_v1',chainId:56,tokenAddress:context.tokenAddress,start:context.start,block:full,parent:parent.block,entry,parentCode:'0x',code:birth.code,mode:tx.to===null&&receipt.contractAddress===context.tokenAddress?'top_level_creation':'exact_state_birth',source};
   const checked=await validateFreshTokenCreationProof(proof,context.start,async n=>{const b=await invoke<FreshBlock>(read,'eth_getBlockByNumber',['0x'+n.toString(16),false]);return b?header(b):null;},async(token,b)=>{const saved=observations.get(b.number);return token===context.tokenAddress&&saved?.block.hash===b.hash?saved.code:null;});if(checked)return proof;
  }
  return null;
 };
}
/** One optional proof task per pass. The resolver is node-first and external
 * history is opt-in; unconfigured/unavailable sources stay visibly pending. */
export async function runFreshTokenDiscovery(db:Pool,rpc:Rpc,options:{reference?:string;resolve?:FreshTokenDiscoveryResolver;archiveRpc?:Rpc;canonicalCode?:(token:string,block:FreshDiscoveryHeader)=>Promise<string|null>;signal?:AbortSignal;now?:Date}={}){
 const now=options.now??new Date(),empty={resolved:0,pending:0,yielded:false};if(options.signal?.aborted)return{...empty,yielded:true};
 if(options.reference!==undefined&&(!freshAddress(options.reference)||options.reference!==options.reference.toLowerCase()))throw Error('token_discovery_reference_invalid');
 const capture=(await db.query(`SELECT c.block_number::text,c.block_hash,c.revision::text,b.parent_hash,b.occurred_at FROM fresh.checkpoints c JOIN fresh.recent_blocks b ON b.block_number=c.block_number AND b.block_hash=c.block_hash WHERE c.key='capture'`)).rows[0];
 if(!capture||now.getTime()-new Date(capture.occurred_at).getTime()>20_000)return{...empty,...await readFreshTokenDiscoveryHealth(db),yielded:true};
 // A first attempt must reach the node before its short state window expires;
 // retries overdue by two minutes take priority so fresh arrivals cannot
 // indefinitely starve retained historical searches.
 const lease=randomUUID(),job=(await db.query(`UPDATE fresh.jobs SET lease_id=$2,lease_until=$1::timestamptz+interval '30 seconds' WHERE id=(SELECT id FROM fresh.jobs WHERE kind='token_discovery' AND state='pending' AND due_at<=$1 AND(lease_until IS NULL OR lease_until<=$1)${options.reference!==undefined?' AND reference=$3':''} ORDER BY CASE WHEN attempts>0 AND due_at<$1::timestamptz-interval '2 minutes' THEN 0 WHEN attempts=0 THEN 1 ELSE 2 END,due_at,id LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING *`,options.reference!==undefined?[now,lease,options.reference]:[now,lease])).rows[0];
 if(!job)return{...empty,...await readFreshTokenDiscoveryHealth(db)};
 try{
  const start=(await db.query("SELECT block_number::text,block_hash,value FROM fresh.checkpoints WHERE key='start'")).rows[0];if(!start||job.progress?.startBlock!==Number(start.block_number)||job.progress?.startHash!==start.block_hash)throw Error('token_discovery_boundary_changed');
  const startContext={number:Number(start.block_number),hash:start.block_hash},trustedBoundary=start.value?.startBlock===startContext.number&&start.value?.startHash===startContext.hash?trustedDiscoveryBoundary({...startContext,timestamp:start.value?.startTime},startContext):undefined;
  // A later trade must not restart an earlier token's binary search. Prefer
  // the stable first observation while retained; a genuinely expired/orphaned
  // context falls back to the last observation and cannot reuse its checkpoint.
  let last=job.progress.firstSeen??job.progress.lastSeen,observedRow=(await db.query('SELECT block_number::text,block_hash,parent_hash,occurred_at FROM fresh.recent_blocks WHERE block_number=$1 AND block_hash=$2',[last?.blockNumber,last?.blockHash])).rows[0];
  if(!observedRow&&stable(last)!==stable(job.progress.lastSeen)){last=job.progress.lastSeen;observedRow=(await db.query('SELECT block_number::text,block_hash,parent_hash,occurred_at FROM fresh.recent_blocks WHERE block_number=$1 AND block_hash=$2',[last?.blockNumber,last?.blockHash])).rows[0];}
  if(!observedRow)throw Error('token_discovery_observation_orphaned');
  const observed={number:Number(observedRow.block_number),hash:observedRow.block_hash,parentHash:observedRow.parent_hash,timestamp:new Date(observedRow.occurred_at).toISOString()};
  const archive=options.archiveRpc?await createFreshPublicDiscoveryArchiveRpc(db,job,options.archiveRpc,now):undefined;
  const saveSearch=async(search:FreshDiscoverySearch)=>{if(!readDiscoverySearch(search,{tokenAddress:job.reference,start:startContext,observed}))throw Error('token_discovery_search_bounds');
   for(let attempt=0;attempt<3;attempt++){
    const held=(await db.query("SELECT progress FROM fresh.jobs WHERE id=$1 AND lease_id=$2 AND lease_until>clock_timestamp() AND kind='token_discovery' AND reference=$3 AND state='pending'",[job.id,lease,job.reference])).rows[0];
    if(!held)throw Error('token_discovery_context_changed');
    const current=await reconcileFreshDiscoveryProgress(db,job.reference,job.progress,held.progress),next={...current,discoverySearch:search};
    const changed=await db.query(`UPDATE fresh.jobs SET progress=$3::jsonb,updated_at=clock_timestamp() WHERE id=$1 AND lease_id=$2 AND lease_until>clock_timestamp() AND state='pending' AND progress=$4::jsonb RETURNING id`,[job.id,lease,JSON.stringify(next),JSON.stringify(current)]);
    if(changed.rowCount===1){job.progress=next;return;}
   }
   throw Error('token_discovery_context_changed');};
  const resolver=options.resolve??createFreshTokenDiscoveryResolver(rpc,{archiveRpc:archive,boundaryFirst:!!archive,recentNodeFirst:true,trustedBoundary,maxMs:archive?20_000:10_000,maxCalls:archive?144:96}),proof=await resolver({tokenAddress:job.reference,start:startContext,observed,signal:options.signal,search:job.progress.discoverySearch,saveSearch});
  if(!proof)throw Error('token_creation_proof_unavailable');
  if(proof.tokenAddress!==job.reference||number(proof.block.number)>observed.number)throw Error('token_discovery_proof_context');
  const proofBoundary=proof.kind==='canonical_pre_boundary_code_v1'?header(proof.block):header(proof.parent),canonicalHeader=async(n:number)=>{const b=await discoveryNodeHeader(rpc,n,proofBoundary,trustedBoundary);return b?header(b):n===startContext.number&&isTrustedDiscoveryBoundary(proofBoundary,trustedBoundary)?proofBoundary:null;};
  const canonicalCode=options.canonicalCode??(async(token,b)=>{try{return await rpc<string>('eth_getCode',[token,{blockHash:b.hash,requireCanonical:true}]);}catch{if(!archive)return null;return discoveryArchiveCode(archive,rpc,token,b,trustedBoundary);}});
  let validationError:unknown;const validating=<T>(read:()=>Promise<T>)=>read().catch(error=>{validationError??=error;throw error;}),checkedHeader=(n:number)=>validating(()=>canonicalHeader(n)),checkedCode=(token:string,b:FreshDiscoveryHeader)=>validating(()=>canonicalCode(token,b));
  const oldProof=proof.kind==='canonical_pre_boundary_code_v1',fact=oldProof?null:await validateFreshTokenCreationProof(proof,startContext,checkedHeader,checkedCode);
  if(oldProof?!await validateFreshPreBoundaryCodeProof(proof,startContext,checkedHeader,checkedCode):!fact){if(validationError instanceof Error)throw validationError;throw Error('token_creation_proof_invalid');}
  const proofHeaders=oldProof?[header(proof.block)]:[header(proof.block),header(proof.parent)];
  // Network bookends precede locks. Reorg revision and retained headers are
  // then checked atomically, keeping slow archive calls out of financial work.
  for(const h of proofHeaders)if(stable(await canonicalHeader(h.number))!==stable(h))throw Error('token_discovery_birth_invalidated');
  const client=await db.connect();try{await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock(73621941)');
   const held=(await client.query("SELECT * FROM fresh.jobs WHERE id=$1 AND lease_id=$2 AND lease_until>$3 AND kind='token_discovery' AND state='pending' AND reference=$4 FOR UPDATE",[job.id,lease,new Date(),job.reference])).rows[0];if(!held)throw Error('token_discovery_lease_changed');
   job.progress=await reconcileFreshDiscoveryProgress(client,job.reference,job.progress,held.progress,true);
   const lockedStart=(await client.query("SELECT block_number::text,block_hash,value FROM fresh.checkpoints WHERE key='start' FOR SHARE")).rows[0];if(stable(lockedStart)!==stable(start))throw Error('token_discovery_boundary_changed');
   const lockedCapture=(await client.query("SELECT revision::text FROM fresh.checkpoints WHERE key='capture' FOR SHARE")).rows[0];if(lockedCapture?.revision!==capture.revision)throw Error('token_discovery_capture_changed');
   const latest=(await client.query(`SELECT b.block_hash FROM fresh.recent_blocks b JOIN fresh.recent_evidence e USING(block_number,block_hash)
    WHERE b.block_number=$1 AND e.tx_hash=$2 AND e.block_hash=$3 AND e.expires_at>clock_timestamp() FOR SHARE OF b,e`,[last.blockNumber,last.txHash,last.blockHash])).rows[0];if(latest?.block_hash!==last.blockHash)throw Error('token_discovery_observation_orphaned');
   for(const expected of proofHeaders){
    const canonical=(await client.query('SELECT block_hash FROM fresh.recent_blocks WHERE block_number=$1 FOR SHARE',[expected.number])).rows[0];
    if(canonical&&canonical.block_hash!==expected.hash)throw Error('token_discovery_birth_invalidated');
   }
   if(fact){const old=(await client.query('SELECT * FROM fresh.launch_facts WHERE token_address=$1 FOR UPDATE',[job.reference])).rows[0];if(old&&(old.block_hash!==fact.blockHash||old.tx_hash!==fact.txHash||old.status!==fact.status))throw Error('token_discovery_launch_conflict');
    await client.query(`INSERT INTO fresh.launch_facts(token_address,protocol,block_number,block_hash,tx_hash,log_index,launched_at,proof,status)VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)ON CONFLICT(token_address)DO NOTHING`,[fact.tokenAddress,fact.protocol,fact.blockNumber,fact.blockHash,fact.txHash,fact.logIndex,fact.launchedAt,JSON.stringify(fact.proof),fact.status]);}
   const progress=oldProof?{stage:'before_boundary_verified',boundaryCode:{version:1,kind:proof.kind,chainId:56,tokenAddress:proof.tokenAddress,blockNumber:number(proof.block.number),blockHash:proof.block.hash,runtimeSha256:codeSha(proof.code),runtimeBytes:(proof.code.length-2)/2,source:proof.source}}:{stage:'creation_verified',factHash:sha(fact)};
   const published=await client.query("UPDATE fresh.jobs SET state='done',lease_id=NULL,lease_until=NULL,last_error=NULL,progress=(progress-'discoverySearch'-'lastArchiveFailure')||$3::jsonb,updated_at=clock_timestamp() WHERE id=$1 AND lease_id=$2 AND lease_until>clock_timestamp() RETURNING id",[job.id,lease,JSON.stringify(progress)]);
   if(published.rowCount!==1)throw Error('token_discovery_lease_changed');
   if(fact?.status==='eligible')await queueFreshAdmissionRecheck(client,job.reference,new Date());
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
 }catch(error){const reason=error instanceof Error?error.message.replace(/https?:\/\/\S+/g,'[endpoint]').slice(0,120):'token_creation_proof_unavailable';
  // One bounded diagnostic preserves the real provider failure while local
  // cooldown retries continue; no URL, raw provider text or request history.
  const archiveFailure=error instanceof RpcRequestError&&/^discovery_archive_/.test(reason)&&!['discovery_archive_cooldown','discovery_archive_busy'].includes(reason)?{lastArchiveFailure:{reason,category:error.category,code:error.code,at:now.toISOString()}}:{};
  await db.query("UPDATE fresh.jobs SET lease_id=NULL,lease_until=NULL,attempts=attempts+1,last_error=$3,due_at=$4::timestamptz+interval '60 seconds',progress=(CASE WHEN $3='token_discovery_search_reorg' THEN progress-'discoverySearch' ELSE progress END)||$5::jsonb,updated_at=clock_timestamp() WHERE id=$1 AND lease_id=$2",[job.id,lease,reason,now,JSON.stringify(archiveFailure)]);return{resolved:0,...await readFreshTokenDiscoveryHealth(db),yielded:false,reason};}
}
