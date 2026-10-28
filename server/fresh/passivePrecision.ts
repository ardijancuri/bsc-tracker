import {createHash} from 'node:crypto';
import {recoverFreshConstantClonePrecision,type FreshConstantPrecisionRecoveryInput} from './constantMetadataRecovery.js';
import {createFreshImportedMetadataRecovery,freshImportedMetadataMatchesState,type FreshImportedMetadataOptions} from './importedMetadata.js';
import {createFreshStateEvidenceRpc} from './stateEvidence.js';
import type {FreshCapturedReceipt} from './capture.js';
import type {FreshTokenMetadata} from './pricing.js';
import{recoverFreshPinnedClonePrecision}from'./pinnedCloneMetadataRecovery.js';
const stable=(v:unknown):string=>JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.entries(x).sort(([a],[b])=>a.localeCompare(b))):x);
const sha=(v:unknown)=>createHash('sha256').update(stable(v)).digest('hex');
const certificates=new WeakMap<FreshTokenMetadata,{token:string;target:FreshTokenMetadata['block'];decimals:number;proofSha256:string}>();
/** Called by the existing template loader after its canonical source checks.
 * Re-run the exact pure verifier: no current token row, generic proof boolean
 * or caller-supplied decimals can create this in-memory certificate. */
export function certifyFreshPassiveConstantPrecision(value:FreshTokenMetadata,input:FreshConstantPrecisionRecoveryInput,proof:unknown):boolean{
 const recovered=recoverFreshConstantClonePrecision(input);
 if(!recovered||stable(recovered.proof)!==stable(proof)||value.address!==input.tokenAddress||value.decimals!==recovered.decimals
  ||stable(value.block)!==stable(input.target))return false;
 certificates.set(value,{token:value.address,target:{...value.block},decimals:value.decimals,proofSha256:sha(proof)});return true;
}
/** The separately pinned direct-clone verifier has the same ephemeral
 * certificate boundary; a serialized proof or caller decimal is insufficient. */
export function certifyFreshPassivePinnedClonePrecision(value:FreshTokenMetadata,input:Parameters<typeof recoverFreshPinnedClonePrecision>[0],proof:unknown):boolean{
 const recovered=recoverFreshPinnedClonePrecision(input);if(!recovered||stable(recovered.proof)!==stable(proof)||value.address!==input.tokenAddress||value.decimals!==recovered.decimals||stable(value.block)!==stable(input.target))return false;
 certificates.set(value,{token:value.address,target:{...value.block},decimals:value.decimals,proofSha256:sha(proof)});return true;
}
/** Imported observations still load the existing pinned artifact, verify its
 * actual row hash/export binding and canonical target, and reject any retained
 * precision/supply contradiction. They never become synthetic RPC responses. */
export async function certifyFreshPassiveImportedPrecision(value:FreshTokenMetadata,entry:FreshCapturedReceipt,options:FreshImportedMetadataOptions):Promise<boolean>{
 const proof=entry.recoveryEvidence?.metadata?.[value.address] as {kind?:unknown}|undefined;
 if(proof?.kind!=='imported_pinned_token_metadata')return false;
 const recovered=await createFreshImportedMetadataRecovery(options).metadata(value.address,value.block,proof);
 if(!recovered||value.decimals!==recovered.value.decimals||stable(value.block)!==stable(recovered.value.block)
  ||!freshImportedMetadataMatchesState(recovered.value,entry.stateEvidence))return false;
 certificates.set(value,{token:value.address,target:{...value.block},decimals:value.decimals,proofSha256:sha(proof)});return true;
}
/** Exact saved RPC evidence, or an ephemeral result from one of the same
 * historical verifiers normalization already trusts. Nothing is inferred from
 * a symbol, a current metadata row or a serialized certificate flag. */
export function hasFreshPassivePrecision(value:FreshTokenMetadata,entry:FreshCapturedReceipt):boolean{
 try{const block={number:Number(BigInt(entry.receipt.blockNumber)),hash:entry.receipt.blockHash};
  if(value.block.number!==block.number||value.block.hash!==block.hash||!Number.isInteger(value.decimals)||value.decimals<0||value.decimals>255)return false;
  const saved=createFreshStateEvidenceRpc(async()=>{throw Error('passive_precision_no_rpc');},block,entry.stateEvidence);
  if(saved.rejectedPrior)return false;const call=saved.snapshot()?.calls.find(c=>c.to===value.address&&c.data==='0x313ce567');
  if(call)return /^0x[\da-f]{64}$/.test(call.result)&&BigInt(call.result)===BigInt(value.decimals);
  const certificate=certificates.get(value),proof=entry.recoveryEvidence?.metadata?.[value.address];
  return !!certificate&&certificate.token===value.address&&certificate.decimals===value.decimals&&stable(certificate.target)===stable(value.block)
    &&proof!==undefined&&certificate.proofSha256===sha(proof);
 }catch{return false;}
}
