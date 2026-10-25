import{createHash}from'node:crypto';
import{keccak256}from'ethers';
import type{Pool}from'pg';
import{decodeFreshEvidence,freshInteger,validateFreshReceipt,type FreshBlock,type FreshCapturedReceipt}from'./capture.js';
import{createFreshStateEvidenceRpc,type FreshStateReadEvidence}from'./stateEvidence.js';
import{GANG_TOKEN_ADDRESS}from'./tracking.js';
import type{FreshPriceBlock,FreshTokenMetadata}from'./pricing.js';
import{freshImportedMetadataMatchesState}from'./importedMetadata.js';

/** Full, exact deployed GANG runtime, not a symbol or generic ERC20 template.
 * The decimals dispatcher at0xaa leads to0x18a, which returns literal18.
 * All runtime entry points are pinned. The only _update callers are guarded
 * _transfer (nonzero from/to,0x4aa) and _burn (nonzero from,0x507). Thus its
 * internal mint branch0x6d1 is unreachable from a public runtime entry point.
 * Supply slot2 can only decrease at0x773; other writes are locked flag,
 * allowance/balance mappings. No CALL/DELEGATECALL/code-changing opcode exists.
 * A successful prior committed raw call anchors this ordinary persistent code
 * under BSC BEP344. A later runtime alone never authorizes an earlier target.
 */
export const FRESH_GANG_RUNTIME_AUDIT=Object.freeze({id:'gang_exact_runtime_constant_precision_burn_only_v1',
 codeHash:'0x14efef69f6d88d506c0b07168d6aaeaa6b536dffa6e0545a0fc83bf8ad9fd6b7',bytes:2447,metadataStart:2394,
 getterPc:0x18a,getterBytes:'5b6040516012815260200161012456',storageWrites:Object.freeze([0x3e1,0x5b8,0x6e4,0x75b,0x773,0x795]),
 precision:18 as const,supplySlot:2,unreachableMintPc:0x6d1,burnWritePc:0x773});
const hash=(v:unknown):v is string=>typeof v==='string'&&/^0x[0-9a-f]{64}$/.test(v),sha=(v:Buffer|string)=>createHash('sha256').update(v).digest('hex');
const validBlock=(b:FreshPriceBlock)=>b&&Number.isSafeInteger(b.number)&&b.number>=0&&hash(b.hash)&&Number.isSafeInteger(Date.parse(b.timestamp)/1000)
 &&new Date(b.timestamp).toISOString()===b.timestamp&&Date.parse(b.timestamp)>=1718863500000;
const ordered=(a:FreshPriceBlock,b:FreshPriceBlock)=>a.number<=b.number&&Date.parse(a.timestamp)<=Date.parse(b.timestamp)
 &&(a.number!==b.number||a.hash===b.hash&&a.timestamp===b.timestamp);
const equalBlock=(a:FreshPriceBlock|null,b:FreshPriceBlock)=>a!==null&&a.number===b.number&&a.hash===b.hash&&a.timestamp===b.timestamp;
export interface FreshGangStateWitness {block:FreshPriceBlock;payload:Buffer}
export interface FreshGangAfterObservation {block:FreshPriceBlock;stateEvidence:FreshStateReadEvidence}
export interface FreshGangMetadataInput {
 chainId:number;tokenAddress:string;target:FreshPriceBlock;source:FreshGangStateWitness;
 runtime:{block:FreshPriceBlock;code:string};after?:FreshGangAfterObservation;
 /** Reload actual canonical retained headers on every use; no RPC is run here. */
 canonicalHeader:(number:number)=>Promise<FreshPriceBlock|null>;
}
export const FRESH_GANG_METADATA_ANCHOR_KEY='metadata_anchor:'+GANG_TOKEN_ADDRESS;
export interface FreshGangImportedMetadata {
 metadata:FreshTokenMetadata;
 proof:{version:1;kind:'gmgn_reconciled_gang_precision';chainId:56;tokenAddress:string;datasetSha256:string;target:FreshPriceBlock;originalEvidenceHash:string;[key:string]:unknown};
}
/** Explicit server-side import only. An ordinary worker never configures this
 * callback; no supply, cash-flow value or target RPC response is injected. */
export function validFreshGangImportedMetadata(value:FreshGangImportedMetadata,entry:FreshCapturedReceipt,block:FreshPriceBlock,state?:unknown){
 try{const m=value.metadata,p=value.proof;return m.address===GANG_TOKEN_ADDRESS&&m.decimals===18&&m.supplyRaw===null&&equalBlock(m.block,block)
  &&entry.transaction.blockHash===block.hash&&Number(freshInteger(entry.transaction.blockNumber))===block.number&&entry.receipt.blockHash===block.hash
  &&p.version===1&&p.kind==='gmgn_reconciled_gang_precision'&&p.chainId===56&&p.tokenAddress===GANG_TOKEN_ADDRESS
  &&/^[0-9a-f]{64}$/.test(p.datasetSha256)&&equalBlock(p.target,block)&&p.originalEvidenceHash===sha(JSON.stringify([entry.transaction,entry.receipt]))
  &&Buffer.byteLength(JSON.stringify(p))<=16*1024&&(state===undefined||freshImportedMetadataMatchesState(m,state));}catch{return false;}
}
/** Operator-approved raw identity reference only, never an approved financial
 * response. Source receipt bodies stay in their existing72h repair buffer. */
export async function readFreshGangMetadataInput(db:Pick<Pool,'query'>,target:FreshPriceBlock,options:{lock?:boolean}={}){
 try{
  const lock=options.lock?' FOR SHARE':'',row=(await db.query(`SELECT value FROM fresh.checkpoints WHERE key=$1${lock}`,[FRESH_GANG_METADATA_ANCHOR_KEY])).rows[0],v=row?.value;
  if(!v||v.version!==1||v.kind!=='gang_immutable_metadata_anchor'||v.chainId!==56||v.tokenAddress!==GANG_TOKEN_ADDRESS||Buffer.byteLength(JSON.stringify(v))>128*1024
   ||!hash(v.source?.transactionHash)||!hash(v.source?.blockHash)||!Number.isSafeInteger(v.source?.blockNumber)||!/^[0-9a-f]{64}$/.test(v.source?.payloadSha256??''))return null;
  const source=(await db.query(`SELECT e.payload,b.block_number,b.block_hash,b.occurred_at FROM fresh.recent_evidence e JOIN fresh.recent_blocks b USING(block_number,block_hash)
    WHERE e.tx_hash=$1 AND e.block_hash=$2 AND e.block_number=$3 AND e.expires_at>clock_timestamp()${options.lock?' FOR SHARE OF e,b':''}`,[v.source.transactionHash,v.source.blockHash,v.source.blockNumber])).rows[0];
  if(!source||!Buffer.isBuffer(source.payload)||sha(source.payload)!==v.source.payloadSha256)return null;
  const canonicalHeader=async(number:number)=>{const b=(await db.query(`SELECT block_number,block_hash,occurred_at FROM fresh.recent_blocks WHERE block_number=$1${lock}`,[number])).rows[0];
   return b?{number:Number(b.block_number),hash:b.block_hash,timestamp:new Date(b.occurred_at).toISOString()}:null;};
  const input:FreshGangMetadataInput={chainId:56,tokenAddress:GANG_TOKEN_ADDRESS,target,source:{block:{number:Number(source.block_number),hash:source.block_hash,timestamp:new Date(source.occurred_at).toISOString()},payload:source.payload},
   runtime:v.runtime,...(v.after?{after:v.after}:{}),canonicalHeader};
  return{input,anchorSha256:sha(JSON.stringify(v))};
 }catch{return null;}
}
function runtimeMatches(code:string){
 const a=FRESH_GANG_RUNTIME_AUDIT;
 if(typeof code!=='string'||code.length!==2+a.bytes*2||!/^0x[0-9a-f]+$/.test(code)||keccak256(code)!==a.codeHash)return false;
 const b=Buffer.from(code.slice(2),'hex'),end=b.length-b.readUInt16BE(b.length-2)-2,stores:number[]=[];
 if(end!==a.metadataStart||b[end-1]!==0xfe||b.subarray(a.getterPc,a.getterPc+a.getterBytes.length/2).toString('hex')!==a.getterBytes)return false;
 for(let pc=0;pc<end;pc++){const op=b[pc];if([0xf0,0xf1,0xf2,0xf4,0xf5,0xfa,0xff].includes(op))return false;if(op===0x55)stores.push(pc);
  if(op>=0x60&&op<=0x7f){pc+=op-0x5f;if(pc>=end)return false;}}
 return JSON.stringify(stores)===JSON.stringify(a.storageWrites);
}
function rawState(block:FreshPriceBlock,evidence:unknown){
 const state=createFreshStateEvidenceRpc(async()=>{throw Error('gang_metadata_network_forbidden');},block,evidence);
 if(state.rejectedPrior)return null;const snapshot=state.snapshot();if(!snapshot)return null;
 const precision=snapshot.calls.find(c=>c.to===GANG_TOKEN_ADDRESS&&c.data==='0x313ce567');
 if(!precision||!/^0x[0-9a-f]{64}$/.test(precision.result)||BigInt(precision.result)!==18n)return null;
 const supply=snapshot.calls.find(c=>c.to===GANG_TOKEN_ADDRESS&&c.data==='0x18160ddd');
 return{precision,supply:supply&&/^0x[0-9a-f]{64}$/.test(supply.result)&&BigInt(supply.result)>0n?supply:null,stateHash:sha(JSON.stringify(snapshot))};
}
/** Derive immutable precision; derive historical supply only inside equal
 * bracketing observations of this audited burn-only runtime. Equal generic
 * token supplies, current metadata rows and future-only proof are rejected. */
export async function recoverFreshGangHistoricalMetadata(input:FreshGangMetadataInput){
 try{
  const{source,runtime,target}=input;
  if(input.chainId!==56||input.tokenAddress!==GANG_TOKEN_ADDRESS||!validBlock(target)||!validBlock(source.block)||!validBlock(runtime.block)
   ||source.block.number>=target.number||!ordered(source.block,target)||!ordered(target,runtime.block)||!runtimeMatches(runtime.code)
   ||!Buffer.isBuffer(source.payload)||source.payload.length>2*1024*1024)return null;
  const blocks=[source.block,target,runtime.block,...(input.after?[input.after.block]:[])];
  const loaded=new Map<number,FreshPriceBlock|null>();for(const block of blocks){if(!validBlock(block))return null;if(!loaded.has(block.number))loaded.set(block.number,await input.canonicalHeader(block.number));
   if(!equalBlock(loaded.get(block.number)??null,block))return null;}
  const entry=decodeFreshEvidence(source.payload);
  if(entry.receipt.status!=='0x1'||entry.transaction.blockHash!==source.block.hash||Number(freshInteger(entry.transaction.blockNumber))!==source.block.number)return null;
  validateFreshReceipt(entry.receipt,entry.transaction,{number:'0x'+source.block.number.toString(16),hash:source.block.hash,parentHash:source.block.hash,
   timestamp:'0x'+Math.floor(Date.parse(source.block.timestamp)/1000).toString(16),transactions:[entry.transaction]}as FreshBlock);
  const before=rawState(source.block,entry.stateEvidence);if(!before)return null;
  let supplyRaw:string|null=null,supplyProof:Record<string,unknown>|null=null;
  if(input.after){if(!ordered(target,input.after.block)||!ordered(input.after.block,runtime.block))return null;const after=rawState(input.after.block,input.after.stateEvidence);
   if(!after||!before.supply||!after.supply||before.supply.result!==after.supply.result)return null;
   supplyRaw=BigInt(before.supply.result).toString();supplyProof={kind:'equal_bracketing_burn_only_supply',before:{block:source.block,call:before.supply},after:{block:input.after.block,call:after.supply,stateHash:after.stateHash}};}
  const proof={version:1,kind:'gang_exact_immutable_metadata',auditId:FRESH_GANG_RUNTIME_AUDIT.id,chainId:56,tokenAddress:GANG_TOKEN_ADDRESS,target,
   decimals:18,source:{block:source.block,transactionHash:entry.transaction.hash,payloadSha256:sha(source.payload),stateHash:before.stateHash,call:before.precision},
   runtime:{block:runtime.block,hash:FRESH_GANG_RUNTIME_AUDIT.codeHash,bytes:FRESH_GANG_RUNTIME_AUDIT.bytes,historicalCodeBasis:'prior_committed_response_and_bsc_bep344'},supply:supplyProof};
  const metadata:FreshTokenMetadata={address:GANG_TOKEN_ADDRESS,decimals:18,supplyRaw,name:null,symbol:null,block:{...target}};
  return{metadata,proof};
 }catch{return null;}
}
