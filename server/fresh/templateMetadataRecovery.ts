import {getCreateAddress} from 'ethers';
import{certifyFreshPassiveConstantPrecision}from'./passivePrecision.js';
import type {Pool} from 'pg';
import type {Rpc} from '../rpc.js';
import {blockHex} from '../rpc.js';
import {validateFreshBlock,validateFreshReceipt,freshInteger,freshAddress,freshHash,type FreshCapturedReceipt,type FreshBlock,type FreshReceipt} from './capture.js';
import {createFreshStateEvidenceRpc} from './stateEvidence.js';
import type {FreshRecoveryBatch,FreshRecoverySource,FreshRecoverySourceHint} from './recoveryBatch.js';
import {FRESH_INITIALIZED_DECIMALS_AUDIT,recoverFreshImmutableDecimals,recoverFreshInitializedDecimalsFromCall,type FreshMetadataRecoveryBlock} from './metadataRecovery.js';
import {FRESH_CONSTANT_PRECISION_AUDITS,authenticateFreshConstantCloneCreation,recoverFreshConstantClonePrecision,type FreshConstantPrecisionProtocol,type FreshMetadataCreationContext} from './constantMetadataRecovery.js';
import type {FreshTokenMetadata} from './pricing.js';
import {FRESH_LITERAL_METADATA_AUDIT,recoverFreshLiteralCreationPrecision} from './literalMetadataRecovery.js';
import{freshImmutableStoragePrecisionBirth,recoverFreshImmutableStoragePrecision,revalidateFreshImmutableStoragePrecision,type FreshImmutableStoragePrecisionSource}from'./immutableStoragePrecision.js';

const ownershipTopic='0x8be0079c531659141344cd1fd0a4f28419497f9722a3daafe3b4186f6b6457e0';
type Protocol=FreshConstantPrecisionProtocol|'evm_creation';
type AnchoredSource=FreshRecoverySource&{tokenAddress:string;creation:FreshMetadataCreationContext;hint?:FreshRecoverySourceHint};
/** Ingestion-only bounded proof acquisition. Candidate token rows only select
 * which ORIGINAL receipts to inspect; their metadata never supplies a value.
 * Sources/constructors and the raw earlier response are revalidated by the
 * pure verifiers for every target. No financial/provider requests occur. */
export function createFreshTemplateMetadataRecovery(db:Pool,rpc:Rpc,batch:FreshRecoveryBatch,options:{
 target:FreshMetadataRecoveryBlock;entry:FreshCapturedReceipt;anchor:()=>Promise<FreshMetadataRecoveryBlock>;canonicalHash:(number:number)=>Promise<string|null>;
}){
 const {target,entry,anchor,canonicalHash}=options;
 async function context(txHash:string,number:number,hash:string):Promise<FreshMetadataCreationContext>{
  if(await canonicalHash(number)!==hash)throw Error('template_creation_noncanonical');
  const block=await batch.memo(`template-block:${number}:${hash}`,()=>rpc<FreshBlock>('eth_getBlockByNumber',[blockHex(number),true]));
  validateFreshBlock(block,number);if(block.hash.toLowerCase()!==hash)throw Error('template_creation_block_invalid');
  const transaction=block.transactions.find(tx=>tx.hash.toLowerCase()===txHash);if(!transaction)throw Error('template_creation_tx_missing');
  const receipt=await batch.memo(`template-receipt:${txHash}:${hash}`,()=>rpc<FreshReceipt>('eth_getTransactionReceipt',[txHash]));validateFreshReceipt(receipt,transaction,block);
  return{transaction,receipt,block};
 }
 async function implementation(protocol:Protocol){
  const at=await anchor();if(await canonicalHash(at.number)!==at.hash)throw Error('template_code_anchor_noncanonical');
  const address=protocol==='evm_creation'?FRESH_INITIALIZED_DECIMALS_AUDIT.implementationAddress:FRESH_CONSTANT_PRECISION_AUDITS[protocol].implementation;
  const code=await batch.memo(`template-implementation:${address}:${at.hash}`,()=>rpc<string>('eth_getCode',[address,{blockHash:at.hash,requireCanonical:true}]));
  return{address,code,block:at};
 }
 async function source(protocol:Protocol):Promise<AnchoredSource|null>{
  return batch.memo(`template-earliest-raw-source:${protocol}:v1`,async()=>{
   // A fixed upper bound avoids rescanning every token/receipt for every gap.
   // Real source payloads, not current decimals, establish precision/code.
   const candidates=(await db.query(`SELECT l.token_address,l.block_number,l.block_hash,l.tx_hash FROM fresh.launch_facts l
    JOIN fresh.tokens t ON t.address=l.token_address WHERE l.status='eligible' AND l.protocol=$1
    ORDER BY l.block_number,l.token_address LIMIT 64`,[protocol==='evm_creation'?protocol:FRESH_CONSTANT_PRECISION_AUDITS[protocol].protocol])).rows;
   const at=await anchor(),code=await implementation(protocol),chainId=Number(BigInt(await batch.memo('chain-id',()=>rpc<string>('eth_chainId',[]))));
   let best:AnchoredSource|null=null;
   for(const candidate of candidates){
    if(best&&Number(candidate.block_number)>best.block.number)break;
    const earlier=await batch.sources(candidate.token_address,at);if(!earlier.length)continue;
    let created:FreshMetadataCreationContext;try{created=await context(candidate.tx_hash,Number(candidate.block_number),candidate.block_hash);}catch{continue;}
    if(protocol!=='evm_creation'&&!authenticateFreshConstantCloneCreation(protocol,candidate.token_address,created))continue;
    for(const old of earlier){
     if(best&&old.block.number>=best.block.number)continue;
     let valid=false;
     if(protocol==='evm_creation')valid=Boolean(recoverFreshImmutableDecimals({chainId,tokenAddress:candidate.token_address,target:at,creation:created,
      source:{payload:old.payload,block:old.block},implementation:code}));
     else{
      const raw=createFreshStateEvidenceRpc(async()=>{throw Error('source_network_forbidden');},old.block,old.entry.stateEvidence),call=raw.snapshot()?.calls.find(call=>call.to===candidate.token_address&&call.data==='0x313ce567');
      valid=!raw.rejectedPrior&&old.block.number>=Number(candidate.block_number)&&!!call&&/^0x[\da-f]{64}$/i.test(call.result)&&BigInt(call.result)===18n;
     }
     if(valid)best={...old,tokenAddress:candidate.token_address,creation:created};
    }
   }
   return best;
  });
 }
 /** A retained proof avoids rediscovering its source in a cold locator index.
  * It supplies no precision, constructor, code or raw-call authority. Load the
  * actual source fact/context and preserve the original payload hash for this
  * fast path; changed envelopes use ordinary discovery and verification. */
 async function retainedSource(protocol:Protocol,token:string):Promise<AnchoredSource|null>{
  try{
   if(protocol==='evm_creation')return null;
   const prior=entry.recoveryEvidence;
   if(!prior||prior.version!==1||Buffer.byteLength(JSON.stringify(prior))>256*1024||JSON.stringify(prior.target)!==JSON.stringify(target))return null;
   const proof=prior.metadata[token]as any,audit=FRESH_CONSTANT_PRECISION_AUDITS[protocol];
   if(!proof||proof.version!==1||proof.kind!=='authenticated_constant_clone_precision'||proof.auditId!==audit.id||proof.chainId!==56
    ||proof.tokenAddress!==token||JSON.stringify(proof.target)!==JSON.stringify(target))return null;
   const selected=proof.source,at=selected?.block,sourceToken=freshAddress(selected?.tokenAddress);
   if(!sourceToken||!freshHash(selected?.transactionHash)||!at||!Number.isSafeInteger(at.number)||at.number<0||at.number>=target.number||!freshHash(at.hash)
    ||typeof at.timestamp!=='string'||!Number.isFinite(Date.parse(at.timestamp))||new Date(at.timestamp).toISOString()!==at.timestamp
    ||typeof selected.payloadSha256!=='string'||!/^[\da-f]{64}$/.test(selected.payloadSha256))return null;
   const hint:FreshRecoverySourceHint={transactionHash:selected.transactionHash.toLowerCase(),blockNumber:at.number,blockHash:at.hash.toLowerCase(),payloadSha256:selected.payloadSha256};
   const old=(await batch.sources(sourceToken,target,hint)).find(row=>row.entry.transaction.hash.toLowerCase()===hint.transactionHash&&row.block.hash===hint.blockHash&&row.block.number===hint.blockNumber);
   if(!old||old.block.timestamp!==at.timestamp)return null;
   const fact=(await db.query('SELECT token_address,protocol,status,block_number,block_hash,tx_hash FROM fresh.launch_facts WHERE token_address=$1',[sourceToken])).rows[0];
   if(!fact||fact.status!=='eligible'||fact.protocol!==audit.protocol||Number(fact.block_number)>old.block.number)return null;
   const created=await context(fact.tx_hash,Number(fact.block_number),fact.block_hash);
   if(!authenticateFreshConstantCloneCreation(protocol,sourceToken,created))return null;
   return{...old,tokenAddress:sourceToken,creation:created,hint};
  }catch{return null;}
 }
 async function initialization(token:string,fact:any):Promise<FreshMetadataCreationContext|null>{
  return batch.memo(`template-initialization:${token}:${fact.block_hash}`,async()=>{
   const first=Number(fact.block_number),last=Math.min(target.number,first+4096);
   const logs=await rpc<any[]>('eth_getLogs',[{address:token,fromBlock:blockHex(first),toBlock:blockHex(last),topics:[ownershipTopic,'0x'+'0'.repeat(64)]}]);
   if(!Array.isArray(logs)||logs.length>16)return null;
   const seen=new Set<string>();
   for(const log of logs){
    if(log.removed||log.address?.toLowerCase()!==token||!Array.isArray(log.topics)||log.topics.length!==3||log.topics[0]!==ownershipTopic||log.topics[1]!=='0x'+'0'.repeat(64)
     ||!/^0x[\da-f]{64}$/i.test(log.blockHash)||!/^0x[\da-f]{64}$/i.test(log.transactionHash)||!/^0x[\da-f]+$/i.test(log.logIndex)||log.data!=='0x')return null;
    const n=Number(freshInteger(log.blockNumber)),id=log.transactionHash+':'+log.logIndex;if(n<first||n>last||seen.has(id))return null;seen.add(id);
   }
   const ordered=logs.sort((a,b)=>Number(freshInteger(a.blockNumber))-Number(freshInteger(b.blockNumber))||Number(freshInteger(a.transactionIndex))-Number(freshInteger(b.transactionIndex))||Number(freshInteger(a.logIndex))-Number(freshInteger(b.logIndex)));
   for(const log of ordered){
    const c=await context(log.transactionHash.toLowerCase(),Number(freshInteger(log.blockNumber)),log.blockHash.toLowerCase());
    const matched=c.receipt.logs.find(value=>value.logIndex===log.logIndex);
    if(!matched||JSON.stringify([matched.address,matched.topics,matched.data])!==JSON.stringify([log.address,log.topics,log.data]))return null;
    if(c.transaction.to?.toLowerCase()===token&&String(c.transaction.input).toLowerCase().startsWith(FRESH_INITIALIZED_DECIMALS_AUDIT.initializerSelector))return c;
   }
   return null;
  });
 }
 return{async metadata(token:string,fact:any):Promise<{value:FreshTokenMetadata;proof:unknown}|null>{
  if(!['flap','fourmeme','evm_creation'].includes(fact?.protocol)||fact.status!=='eligible'||Number(fact.block_number)>target.number)return null;
  if(await canonicalHash(target.number)!==target.hash)return null;
  const immutableBirth=freshImmutableStoragePrecisionBirth(fact);
  if(immutableBirth){
   if(await canonicalHash(immutableBirth.block.number)!==immutableBirth.block.hash)return null;
   const prior=entry.recoveryEvidence?.metadata[token]as any;
   if(prior?.kind==='authenticated_immutable_storage_precision'&&await canonicalHash(prior.source?.anchor?.number)===prior.source?.anchor?.hash){
    const saved=revalidateFreshImmutableStoragePrecision({chainId:56,tokenAddress:token,target,fact,proof:prior});
    if(saved)return{value:{address:token,name:null,symbol:null,decimals:saved.decimals,supplyRaw:null,block:target},proof:saved.proof};
   }
   const at=await anchor();if(await canonicalHash(at.number)!==at.hash)return null;
   const source=await batch.memo<FreshImmutableStoragePrecisionSource>(`immutable-storage-precision:${token}:${at.hash}`,async()=>{
    const state=createFreshStateEvidenceRpc(rpc,at),params:[string,{blockHash:string;requireCanonical:true}]=[token,{blockHash:at.hash,requireCanonical:true}];
    const callParams:[{to:string;data:string},{blockHash:string;requireCanonical:true}]=[{to:token,data:'0x313ce567'},params[1]];
    const[code,result]=await Promise.all([rpc<string>('eth_getCode',params),state.rpc<string>('eth_call',callParams)]);
    return{anchor:at,code:{method:'eth_getCode',params,result:code},call:{method:'eth_call',params:callParams,result},state:state.snapshot()!};
   });
   const chainId=Number(BigInt(await batch.memo('chain-id',()=>rpc<string>('eth_chainId',[]))));
   const result=recoverFreshImmutableStoragePrecision({chainId,tokenAddress:token,target,fact,source});
   return result?{value:{address:token,name:null,symbol:null,decimals:result.decimals,supplyRaw:null,block:target},proof:result.proof}:null;
  }
  let protocol=fact.protocol as Protocol;const created=await context(fact.tx_hash,Number(fact.block_number),fact.block_hash);
  if(protocol==='evm_creation'&&token===FRESH_LITERAL_METADATA_AUDIT.tokenAddress){
   if(await canonicalHash(target.number)!==target.hash)return null;
   const chainId=Number(BigInt(await batch.memo('chain-id',()=>rpc<string>('eth_chainId',[]))));
   const recovered=recoverFreshLiteralCreationPrecision({chainId,tokenAddress:token,target,targetTransactionIndex:Number(freshInteger(entry.transaction.transactionIndex)),creation:created});
   return recovered?{value:{address:token,name:null,symbol:null,decimals:recovered.decimals,supplyRaw:null,block:target},proof:recovered.proof}:null;
  }
  if(protocol==='evm_creation'){
   const tx=created.transaction,expected=`0x3d602d80600a3d3981f3363d3d373d3d3d363d73${FRESH_INITIALIZED_DECIMALS_AUDIT.implementationAddress.slice(2)}5af43d82803e903d91602b57fd5bf3`;
   if(tx.to!==null||String(tx.input).toLowerCase()!==expected||created.receipt.contractAddress?.toLowerCase()!==token||getCreateAddress({from:tx.from.toLowerCase(),nonce:freshInteger(tx.nonce)}).toLowerCase()!==token)return null;
  }else{
   const matches=(Object.keys(FRESH_CONSTANT_PRECISION_AUDITS) as FreshConstantPrecisionProtocol[]).filter(key=>FRESH_CONSTANT_PRECISION_AUDITS[key].protocol===fact.protocol&&authenticateFreshConstantCloneCreation(key,token,created));
   if(matches.length!==1)return null;protocol=matches[0];
  }
  const verify=async(chosen:AnchoredSource|null):Promise<{value:FreshTokenMetadata;proof:unknown}|null>=>{
  if(!chosen||await canonicalHash(chosen.block.number)!==chosen.block.hash||await canonicalHash(Number(freshInteger(chosen.creation.block.number)))!==chosen.creation.block.hash.toLowerCase())return null;
  // Cached discovery is not source authority. Reload the checksum-protected
  // raw envelope/expiry/headers on every target, including within memo TTL.
  const code=await implementation(protocol),current=(await batch.sources(chosen.tokenAddress,code.block,chosen.hint)).find(row=>row.entry.transaction.hash.toLowerCase()===chosen.entry.transaction.hash.toLowerCase()&&row.block.hash===chosen.block.hash);
  if(!current)return null;
  const old={...chosen,...current},chainId=Number(BigInt(await batch.memo('chain-id',()=>rpc<string>('eth_chainId',[]))));
  const recovered=protocol==='evm_creation'?await(async()=>{const init=await initialization(token,fact);return init?recoverFreshInitializedDecimalsFromCall({chainId,tokenAddress:token,target,
   targetTransactionIndex:Number(freshInteger(entry.transaction.transactionIndex)),creation:created,initialization:init,source:{tokenAddress:old.tokenAddress,creation:old.creation,payload:old.payload,block:old.block},implementation:code}):null;})():
   recoverFreshConstantClonePrecision({chainId,protocol,tokenAddress:token,target,creation:created,source:{tokenAddress:old.tokenAddress,creation:old.creation,payload:old.payload,block:old.block},implementation:code});
  if(!recovered)return null;
  const value:FreshTokenMetadata={address:token,name:null,symbol:null,decimals:recovered.decimals,supplyRaw:null,block:target};
  if(protocol!=='evm_creation'&&!certifyFreshPassiveConstantPrecision(value,{chainId,protocol,tokenAddress:token,target,creation:created,source:{tokenAddress:old.tokenAddress,creation:old.creation,payload:old.payload,block:old.block},implementation:code},recovered.proof))return null;
  return{value,proof:recovered.proof};
  };
  const hinted=await retainedSource(protocol,token);
  if(hinted){const result=await verify(hinted).catch(()=>null);if(result)return result;}
  return verify(await source(protocol));
 }};
}
