import{createHash}from'node:crypto';import{keccak256}from'ethers';
import{createFreshStateEvidenceRpc,type FreshStateReadEvidence}from'./stateEvidence.js';
import type{FreshMetadataRecoveryBlock}from'./metadataRecovery.js';

/** Complete audited ERC20 runtime. Its six writes target owner slot0 or the
 * standard balance(slot1)/allowance(slot2) mapping hashes. No direct/computed
 * slot6 setter, external/delegate call, creation or destruction path exists.
 * The getter reads slot6&255. Hashing pins every branch and store operand;
 * this is not an opcode-only admission rule for arbitrary ERC20 bytecode. */
export const FRESH_IMMUTABLE_STORAGE_PRECISION_AUDIT=Object.freeze({
 id:'audited_erc20_immutable_storage_precision_v1',runtimeBytes:2863,codeEnd:2810,
 runtimeSha256:'d6fd7c56933429a40e5f2a9ae26b517f85a1ae049a5d78e245526ace2cfe7959',
 runtimeHash:'0xe68603427d8f8edecb2b810122d620f259cdcd014d04391886bddfb6b134aa05',
 getterPc:0x052a,getterBytes:'5b34610188575f36600319011261018857602060ff60065416604051908152f3',
 storePcs:Object.freeze([0x104,0x426,0x6a8,0x970,0x9e0,0x9f8]),slot:6,
});
const sha=(v:Buffer|string)=>createHash('sha256').update(v).digest('hex'),hash=(v:unknown):v is string=>typeof v==='string'&&/^0x[a-f0-9]{64}$/.test(v),address=(v:unknown):v is string=>typeof v==='string'&&/^0x[a-f0-9]{40}$/.test(v),stable=(v:unknown)=>JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.entries(x).sort(([a],[b])=>a.localeCompare(b))):x);
const validBlock=(b:FreshMetadataRecoveryBlock)=>Number.isSafeInteger(b?.number)&&b.number>=0&&hash(b.hash)&&typeof b.timestamp==='string'&&Number.isFinite(Date.parse(b.timestamp))&&new Date(b.timestamp).toISOString()===b.timestamp&&Date.parse(b.timestamp)>=1718863500000;
/** A runtime hash from current code is insufficient: the independent canonical
 * birth observation must already commit this exact full runtime BEFORE target. */
export function freshImmutableStoragePrecisionBirth(fact:any):{block:FreshMetadataRecoveryBlock;runtimeSha256:string;proofSha256:string}|null{
 try{const p=fact?.proof,a=FRESH_IMMUTABLE_STORAGE_PRECISION_AUDIT,b=p?.birth;
  if(fact?.status!=='eligible'||fact.protocol!=='evm_creation'||!address(fact.token_address)||!hash(fact.block_hash)||!hash(fact.tx_hash)||p?.kind!=='canonical_token_birth_v1'||p.version!==1||p.creation!=='exact_state_birth'||!['node','explicit_archive'].includes(p.source)||p.codeBefore!=='0x'||p.runtimeBytes!==a.runtimeBytes||p.runtimeSha256!==a.runtimeSha256||p.witnessTransactionHash!==fact.tx_hash||!validBlock(b)||b.number!==Number(fact.block_number)||b.hash!==fact.block_hash||new Date(fact.launched_at).toISOString()!==b.timestamp)return null;
  return{block:{number:b.number,hash:b.hash,timestamp:b.timestamp},runtimeSha256:p.runtimeSha256,proofSha256:sha(stable(p))};
 }catch{return null;}
}
export interface FreshImmutableStoragePrecisionSource{anchor:FreshMetadataRecoveryBlock;code:{method:'eth_getCode';params:[string,{blockHash:string;requireCanonical:true}];result:string};call:{method:'eth_call';params:[{to:string;data:string},{blockHash:string;requireCanonical:true}];result:string};state:FreshStateReadEvidence}
export interface FreshImmutableStoragePrecisionProof{version:1;kind:'authenticated_immutable_storage_precision';auditId:string;chainId:56;tokenAddress:string;target:FreshMetadataRecoveryBlock;decimals:number;birth:{block:FreshMetadataRecoveryBlock;runtimeSha256:string;proofSha256:string};source:FreshImmutableStoragePrecisionSource}
export function validFreshImmutableStoragePrecisionCode(code:unknown):code is string{
 try{const a=FRESH_IMMUTABLE_STORAGE_PRECISION_AUDIT;if(typeof code!=='string'||!/^0x(?:[a-f0-9]{2})+$/.test(code)||code.length!==2+a.runtimeBytes*2)return false;const bytes=Buffer.from(code.slice(2),'hex');
  if(sha(bytes)!==a.runtimeSha256||keccak256(bytes)!==a.runtimeHash||bytes.length-bytes.readUInt16BE(bytes.length-2)-2!==a.codeEnd||bytes[a.codeEnd-1]!==0xfe||bytes.subarray(a.codeEnd).includes(0x5b)||bytes.subarray(a.getterPc,a.getterPc+a.getterBytes.length/2).toString('hex')!==a.getterBytes)return false;
  const stores:number[]=[];let last=-1;for(let pc=0;pc<a.codeEnd;pc++){last=pc;const op=bytes[pc];if([0xf0,0xf1,0xf2,0xf4,0xf5,0xfa,0xff].includes(op))return false;if(op===0x55)stores.push(pc);if(op>=0x60&&op<=0x7f){pc+=op-0x5f;if(pc>=a.codeEnd)return false;}}
  return last===a.codeEnd-1&&stable(stores)===stable(a.storePcs);
 }catch{return false;}
}
/** The original birth commits immutable runtime before target. A genuine raw
 * getter response at a later canonical anchor therefore measures the same
 * storage value at target. No constructor inference or current token-row
 * precision is used; every retained source is checked again on each use.
 * Same-block targets remain unsupported: this birth packet has no proven
 * creation transaction index. Exact target-state metadata handles that case. */
export function recoverFreshImmutableStoragePrecision(input:{chainId:number;tokenAddress:string;target:FreshMetadataRecoveryBlock;fact:unknown;source:FreshImmutableStoragePrecisionSource}):{decimals:number;proof:FreshImmutableStoragePrecisionProof}|null{
 try{const{target,source}=input,birth=freshImmutableStoragePrecisionBirth(input.fact);if(input.chainId!==56||!address(input.tokenAddress)||(input.fact as any)?.token_address!==input.tokenAddress||!birth||!validBlock(target)||!validBlock(source?.anchor)||birth.block.number>=target.number||Date.parse(birth.block.timestamp)>Date.parse(target.timestamp)||source.anchor.number<target.number||Date.parse(source.anchor.timestamp)<Date.parse(target.timestamp)||source.anchor.number===target.number&&source.anchor.hash!==target.hash||source.code?.method!=='eth_getCode'||stable(source.code.params)!==stable([input.tokenAddress,{blockHash:source.anchor.hash,requireCanonical:true}])||!validFreshImmutableStoragePrecisionCode(source.code.result))return null;
  const saved=createFreshStateEvidenceRpc(async()=>{throw Error('immutable_precision_raw_source_missing');},source.anchor,source.state),state=saved.snapshot();if(saved.rejectedPrior||state?.calls.length!==1)return null;const call=state.calls[0];if(call.to!==input.tokenAddress||call.data!=='0x313ce567'||!/^0x[a-f0-9]{64}$/.test(call.result)||source.call?.method!=='eth_call'||stable(source.call.params)!==stable([{to:input.tokenAddress,data:'0x313ce567'},{blockHash:source.anchor.hash,requireCanonical:true}])||source.call.result!==call.result)return null;const n=BigInt(call.result);if(n>255n)return null;
  const decimals=Number(n),proof:FreshImmutableStoragePrecisionProof={version:1,kind:'authenticated_immutable_storage_precision',auditId:FRESH_IMMUTABLE_STORAGE_PRECISION_AUDIT.id,chainId:56,tokenAddress:input.tokenAddress,target:{...target},decimals,birth,source:{anchor:{...source.anchor},code:structuredClone(source.code),call:structuredClone(source.call),state}};return{decimals,proof};
 }catch{return null;}
}
export function revalidateFreshImmutableStoragePrecision(input:{chainId:number;tokenAddress:string;target:FreshMetadataRecoveryBlock;fact:unknown;proof:unknown}):{decimals:number;proof:FreshImmutableStoragePrecisionProof}|null{
 try{const prior=input.proof as FreshImmutableStoragePrecisionProof;if(prior?.kind!=='authenticated_immutable_storage_precision'||Buffer.byteLength(JSON.stringify(prior))>16*1024)return null;const result=recoverFreshImmutableStoragePrecision({...input,source:prior.source});return result&&stable(result.proof)===stable(prior)?result:null;}catch{return null;}
}
