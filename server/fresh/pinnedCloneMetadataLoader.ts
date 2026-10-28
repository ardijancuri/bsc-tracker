import{createHash}from'node:crypto';import type{Pool}from'pg';import type{Rpc}from'../rpc.js';import{blockHex}from'../rpc.js';
import{freshHash,validateFreshBlock,validateFreshReceipt,type FreshBlock,type FreshReceipt,type FreshCapturedReceipt}from'./capture.js';
import type{FreshMetadataRecoveryBlock}from'./metadataRecovery.js';import type{FreshMetadataCreationContext}from'./constantMetadataRecovery.js';import type{FreshRecoveryBatch,FreshRecoverySourceHint}from'./recoveryBatch.js';import type{FreshTokenMetadata}from'./pricing.js';
import{createFreshStateEvidenceRpc}from'./stateEvidence.js';
import{FRESH_PINNED_CLONE_PRECISION_AUDITS,authenticateFreshPinnedCloneCreation,recoverFreshPinnedClonePrecision}from'./pinnedCloneMetadataRecovery.js';import{certifyFreshPassivePinnedClonePrecision}from'./passivePrecision.js';
const runtimeSha=(implementation:string)=>createHash('sha256').update(Buffer.from(`363d3d373d3d3d363d73${implementation.slice(2)}5af43d82803e903d91602b57fd5bf3`,'hex')).digest('hex');
type RecoveryInput=Parameters<typeof recoverFreshPinnedClonePrecision>[0];
/** Ingestion only. An exact immutable constructor and actual earlier raw read
 * or pinned historical code anchor establish precision. Current metadata rows
 * and later observations never supply old precision. Every source is reloaded
 * through the existing canonical, checksum and 72-hour retention gates. */
export function createFreshPinnedCloneMetadataRecovery(_db:Pool,rpc:Rpc,batch:FreshRecoveryBatch,options:{target:FreshMetadataRecoveryBlock;entry:FreshCapturedReceipt;anchor:()=>Promise<FreshMetadataRecoveryBlock>;canonicalHash:(n:number)=>Promise<string|null>}){
 const{target,entry,anchor,canonicalHash}=options;
 return{async metadata(token:string,fact:any):Promise<{value:FreshTokenMetadata;proof:unknown}|null>{
  if(fact?.protocol!=='evm_creation'||fact.status!=='eligible'||fact.token_address!==token||!Number.isSafeInteger(Number(fact.block_number))||Number(fact.block_number)>target.number||!freshHash(fact.block_hash)||!freshHash(fact.tx_hash)||!/^[a-f0-9]{64}$/.test(fact.proof?.runtimeSha256??''))return null;
  const audits=Object.values(FRESH_PINNED_CLONE_PRECISION_AUDITS),candidate=audits.find(a=>runtimeSha(a.implementation)===fact.proof.runtimeSha256);if(!candidate)return null;
  const captured=createFreshStateEvidenceRpc(async()=>{throw Error('pinned_clone_target_no_network');},target,entry.stateEvidence);if(captured.rejectedPrior)return null;const rawPrecision=captured.snapshot()?.calls.find(c=>c.to===token&&c.data==='0x313ce567');if(rawPrecision&&rawPrecision.result!=='0x'+(18).toString(16).padStart(64,'0'))return null;
  if(await canonicalHash(target.number)!==target.hash||await canonicalHash(Number(fact.block_number))!==fact.block_hash)return null;
  const creation=await batch.memo(`pinned-clone-creation:${token}:${fact.block_hash}`,async():Promise<FreshMetadataCreationContext>=>{const block=await rpc<FreshBlock>('eth_getBlockByNumber',[blockHex(fact.block_number),true]);validateFreshBlock(block,Number(fact.block_number));if(block.hash!==fact.block_hash)throw Error('pinned_clone_creation_noncanonical');const transaction=block.transactions.find(tx=>tx.hash===fact.tx_hash);if(!transaction)throw Error('pinned_clone_creation_transaction_missing');const receipt=await rpc<FreshReceipt>('eth_getTransactionReceipt',[fact.tx_hash]);validateFreshReceipt(receipt,transaction,block);return{transaction,receipt,block};});
  const authenticated=authenticateFreshPinnedCloneCreation(token,creation);if(!authenticated||authenticated.implementationAddress!==candidate.implementation||authenticated.runtimeSha256!==fact.proof.runtimeSha256)return null;
  const at=await anchor();if(await canonicalHash(at.number)!==at.hash||at.number<target.number)return null;
  const code=await batch.memo(`pinned-clone-code:${candidate.implementation}:${at.hash}`,()=>rpc<string>('eth_getCode',[candidate.implementation,{blockHash:at.hash,requireCanonical:true}])),chainId=Number(BigInt(await batch.memo('chain-id',()=>rpc<string>('eth_chainId',[]))));
  const base={chainId,tokenAddress:token,target,creation,implementation:{address:candidate.implementation,code,block:at}};
  const finish=(input:RecoveryInput)=>{const recovered=recoverFreshPinnedClonePrecision(input);if(!recovered)return null;const value:FreshTokenMetadata={address:token,name:null,symbol:null,decimals:recovered.decimals,supplyRaw:null,block:target};if(!certifyFreshPassivePinnedClonePrecision(value,input,recovered.proof))return null;return{value,proof:recovered.proof};};
  const prior=entry.recoveryEvidence?.metadata?.[token]as any,selected=prior?.source,block=selected?.block;let hint:FreshRecoverySourceHint|undefined;
  if(selected&&freshHash(selected.transactionHash)&&block&&Number.isSafeInteger(block.number)&&block.number<target.number&&freshHash(block.hash)&&/^[a-f0-9]{64}$/.test(selected.payloadSha256??''))hint={transactionHash:selected.transactionHash,blockNumber:block.number,blockHash:block.hash,payloadSha256:selected.payloadSha256};
  for(const source of await batch.sources(token,target,hint)){if(source.block.number>=target.number||source.block.number<Number(fact.block_number)||await canonicalHash(source.block.number)!==source.block.hash)continue;const recovered=finish({...base,source:{payload:source.payload,block:source.block}});if(recovered)return recovered;}
  const historical=candidate.historicalAnchor?.block;if(!historical||!Number.isSafeInteger(historical.number)||historical.number>=target.number||!freshHash(historical.hash)||await canonicalHash(historical.number)!==historical.hash)return null;
  return finish(base);
 }};
}
