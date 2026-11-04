import{createHash}from'node:crypto';
import type{Pool}from'pg';import type{Rpc}from'../rpc.js';
import{decodeFreshEvidence,type FreshCapturedReceipt}from'./capture.js';
import{FRESH_CONSTANT_PRECISION_AUDITS,freshConstantCloneRuntime,validFreshConstantPrecisionCode}from'./constantMetadataRecovery.js';
import{createFreshStateEvidenceRpc}from'./stateEvidence.js';
import{freshImportedMetadataMatchesState}from'./importedMetadata.js';
import{readFreshTokenAdmission,validFreshExistingTokenPermission}from'./tracking.js';
import type{FreshPriceBlock,FreshTokenMetadata}from'./pricing.js';import type{FreshRecoveryBatch}from'./recoveryBatch.js';
const sha=(v:Buffer|string)=>createHash('sha256').update(v).digest('hex');
type Input={token:string;target:FreshPriceBlock;boundary:{number:number;hash:string};boundaryCode:any;source:{payload:Buffer;block:FreshPriceBlock};implementation:{code:string;block:FreshPriceBlock}};
/** A committed pre-boundary fixed proxy and an earlier successful call through
 * that SAME proxy anchor the existing audited constant getter. BEP-344 prevents
 * replacing either committed runtime. This is derived precision, never a
 * synthetic historical RPC response; supply and mutable state remain unknown. */
export function recoverFreshPreexistingClonePrecision(i:Input){try{
 const a=FRESH_CONSTANT_PRECISION_AUDITS.flap,b=i.boundaryCode,runtime=freshConstantCloneRuntime('flap');
 const valid=(x:FreshPriceBlock)=>Number.isSafeInteger(x.number)&&/^0x[a-f0-9]{64}$/.test(x.hash)&&Number.isFinite(Date.parse(x.timestamp))&&Date.parse(x.timestamp)>=1718863500000;
 if(!/^0x[a-f0-9]{40}$/.test(i.token)||!valid(i.target)||!valid(i.source.block)||!valid(i.implementation.block)
  ||i.boundary.number>=i.source.block.number||i.source.block.number>=i.target.number||i.implementation.block.number<i.target.number
  ||Date.parse(i.source.block.timestamp)>Date.parse(i.target.timestamp)||Date.parse(i.implementation.block.timestamp)<Date.parse(i.target.timestamp)
  ||b?.version!==1||b.kind!=='canonical_pre_boundary_code_v1'||b.source!=='explicit_archive'||b.chainId!==56||b.tokenAddress!==i.token
  ||b.blockNumber!==i.boundary.number||b.blockHash!==i.boundary.hash||b.runtimeBytes!==45||b.runtimeSha256!==sha(Buffer.from(runtime.slice(2),'hex'))
  ||!validFreshConstantPrecisionCode('flap',i.implementation.code)||!Buffer.isBuffer(i.source.payload)||i.source.payload.length>2*1024*1024)return null;
 const e=decodeFreshEvidence(i.source.payload),s=i.source.block;
 if(e.transaction.hash!==e.receipt.transactionHash||e.transaction.blockHash!==s.hash||e.receipt.blockHash!==s.hash||Number(BigInt(e.transaction.blockNumber))!==s.number||Number(BigInt(e.receipt.blockNumber))!==s.number)return null;
 const saved=createFreshStateEvidenceRpc(async()=>{throw Error('preexisting_precision_no_rpc');},s,e.stateEvidence),call=saved.snapshot()?.calls.find(c=>c.to===i.token&&c.data==='0x313ce567');
 if(saved.rejectedPrior||!call||!/^0x[a-f0-9]{64}$/.test(call.result)||BigInt(call.result)!==18n)return null;
 const value:FreshTokenMetadata={address:i.token,name:null,symbol:null,decimals:18,supplyRaw:null,block:i.target};
 return{value,proof:{version:1,kind:'authenticated_preexisting_constant_clone_precision',auditId:a.id,chainId:56,tokenAddress:i.token,target:i.target,decimals:18,
  boundaryCode:b,source:{block:s,transactionHash:e.transaction.hash,payloadSha256:sha(i.source.payload),stateEvidenceSha256:sha(JSON.stringify(e.stateEvidence)),call},
  implementation:{address:a.implementation,codeHash:a.codeHash,codeBytes:a.codeBytes,observedBlock:i.implementation.block,historicalCodeAnchor:'committed_boundary_proxy_and_prior_call_bsc_bep344'}}};
 }catch{return null;}}
/** Ingestion only: exact admission, immutable boundary, canonical source/target,
 * original checksummed payload and full audited code are checked on every use. */
export async function loadFreshPreexistingClonePrecision(db:Pool,rpc:Rpc,batch:FreshRecoveryBatch,token:string,entry:FreshCapturedReceipt,target:FreshPriceBlock,anchor:()=>Promise<FreshPriceBlock>,canonicalHash:(n:number)=>Promise<string|null>){
 if((await readFreshTokenAdmission(db,token,{blockNumber:target.number}))?.kind!=='preexisting')return null;
 const start=(await db.query("SELECT block_number,block_hash,value FROM fresh.checkpoints WHERE key='start'")).rows[0];
 const permission=(await db.query('SELECT value FROM fresh.checkpoints WHERE key=$1',['token_admission:'+token])).rows[0]?.value;
 if(!start||!validFreshExistingTokenPermission(permission,start)||permission.tokenAddress!==token)return null;
 const discovery=(await db.query("SELECT progress FROM fresh.jobs WHERE kind='token_discovery' AND reference=$1",[token])).rows[0]?.progress;
 if(discovery?.kind!=='token_discovery_v1'||discovery.tokenAddress!==token||discovery.startBlock!==Number(start.block_number)||discovery.startHash!==start.block_hash)return null;
 if(await canonicalHash(target.number)!==target.hash)return null;
 const at=await anchor();if(await canonicalHash(at.number)!==at.hash)return null;
 const code=await batch.memo(`preexisting-constant-implementation:${at.hash}`,()=>rpc<string>('eth_getCode',[FRESH_CONSTANT_PRECISION_AUDITS.flap.implementation,{blockHash:at.hash,requireCanonical:true}]));
 const prior=entry.recoveryEvidence?.metadata[token]as any;
 const hint=prior?.kind==='authenticated_preexisting_constant_clone_precision'&&prior.tokenAddress===token&&prior.source?.block
  ?{transactionHash:prior.source.transactionHash,blockNumber:prior.source.block.number,blockHash:prior.source.block.hash,payloadSha256:prior.source.payloadSha256}:undefined;
 for(const source of await batch.sources(token,target,hint)){
  if(await canonicalHash(source.block.number)!==source.block.hash)continue;
  const result=recoverFreshPreexistingClonePrecision({token,target,boundary:{number:Number(start.block_number),hash:start.block_hash},boundaryCode:discovery.boundaryCode,source,implementation:{code,block:at}});
  if(result&&freshImportedMetadataMatchesState(result.value,entry.stateEvidence))return result;
 }
 return null;
}
