import {createHash} from 'node:crypto';
import {getCreate2Address,keccak256} from 'ethers';
import {FLAP_PORTAL,FOUR_MANAGERS,flapInterface,fourInterface,fourV1Interface} from '../launchpad.js';
import {transferTopic} from '../swap.js';
import {decodeFreshEvidence,validateFreshBlock,validateFreshReceipt,freshInteger,type FreshBlock,type FreshReceipt,type FreshTransaction} from './capture.js';
import {createFreshStateEvidenceRpc} from './stateEvidence.js';
import type {FreshMetadataRecoveryBlock} from './metadataRecovery.js';

export const FRESH_CONSTANT_PRECISION_AUDITS=Object.freeze({
 flap:Object.freeze({protocol:'flap',id:'flap_024f_fixed_clone_constant_precision_v1',implementation:'0x024f18294970b5c76c0691b87f138a0317156422',
  codeHash:'0xb530a7e0ff0d6ab435a5ec71f2b04092937735e23a0fb3a0746724ce9b875b4a',codeBytes:19331,entryPc:0x3ed,
  getterBytes:'5b6040516012815260200161030256',deployer:FLAP_PORTAL}),
 fourmeme:Object.freeze({protocol:'fourmeme',id:'fourmeme_4686_fixed_clone_constant_precision_v1',implementation:'0x46862924e2a229170ebd065e24a0da72af58a986',
  codeHash:'0xa5529c201b5fdf90cdcddd546521c4e75374e47fdb1aa356859307a4532da97f',codeBytes:5025,entryPc:0x1e2,
  getterBytes:'5b6040516012815260200161016956',deployer:'0xe8ce4e9175de23f97f853e19c522ef29cebf13e3'}),
 fourmemeffff:Object.freeze({protocol:'fourmeme',id:'fourmeme_7330_fixed_clone_constant_precision_v1',implementation:'0x7330d8865f4b6800b72bdd73e2007833a5d45c94',
  codeHash:'0x49052d1fff3ba35008538f6694480d71469a0a76c82ce47d0500cab6e8775f6d',codeBytes:18002,entryPc:0x6bb,
  getterBytes:'5b3480156106c6575f80fd5b5060125b60405160ff90911681526020016104a556',deployer:'0x6e0c4ba9ce0c901f1bba6af55cd66da3b0443ef1'}),
});
export type FreshConstantPrecisionProtocol=keyof typeof FRESH_CONSTANT_PRECISION_AUDITS;
export interface FreshMetadataCreationContext {transaction:FreshTransaction;receipt:FreshReceipt;block:FreshBlock}
const address=(v:unknown):v is string=>typeof v==='string'&&/^0x[\da-f]{40}$/i.test(v);
const hash=(v:unknown):v is string=>typeof v==='string'&&/^0x[\da-f]{64}$/i.test(v);
const equal=(a:string,b:string)=>a.toLowerCase()===b.toLowerCase();
const zero='0x'+'0'.repeat(64),saltTopic='0xd1e8818b2d9da34c6537d2aa8e66a200caa79c8f3126365e8fd5b29ee28a766d';
const sha=(v:Buffer|string)=>createHash('sha256').update(v).digest('hex');
const blockOf=(b:FreshBlock):FreshMetadataRecoveryBlock=>({number:Number(freshInteger(b.number)),hash:b.hash.toLowerCase(),timestamp:new Date(Number(freshInteger(b.timestamp))*1000).toISOString()});
const validBlock=(b:FreshMetadataRecoveryBlock)=>Number.isSafeInteger(b?.number)&&b.number>=0&&hash(b.hash)&&Number.isSafeInteger(Date.parse(b.timestamp)/1000)&&Date.parse(b.timestamp)/1000>=1718863500;
export function freshConstantCloneRuntime(protocol:FreshConstantPrecisionProtocol){return `0x363d3d373d3d3d363d73${FRESH_CONSTANT_PRECISION_AUDITS[protocol].implementation.slice(2)}5af43d82803e903d91602b57fd5bf3`;}
export function freshConstantCloneInitcode(protocol:FreshConstantPrecisionProtocol){return `0x3d602d80600a3d3981f3${freshConstantCloneRuntime(protocol).slice(2)}`;}

/** The pinned implementations directly contain the constant getter: there is
 * no mutable intermediary. Their full code hashes pin dispatch and return
 * helpers as well as this getter. No delegate/code replacement path exists. */
export function validFreshConstantPrecisionCode(protocol:FreshConstantPrecisionProtocol,code:unknown):code is string{
 const a=FRESH_CONSTANT_PRECISION_AUDITS[protocol];
 if(typeof code!=='string'||!/^0x[\da-f]+$/i.test(code)||code.length!==2+a.codeBytes*2||keccak256(code)!==a.codeHash)return false;
 const bytes=Buffer.from(code.slice(2),'hex');if(bytes.subarray(a.entryPc,a.entryPc+a.getterBytes.length/2).toString('hex')!==a.getterBytes)return false;
 const metadata=bytes.length-bytes.readUInt16BE(bytes.length-2)-2;
 // CBOR follows INVALID and contains no JUMPDEST, so it cannot supply an
 // alternative delegation/replacement path through an out-of-range jump.
 if(metadata<1||bytes[metadata-1]!==0xfe||bytes.subarray(metadata).includes(0x5b))return false;
 for(let pc=0;pc<metadata;pc++){const op=bytes[pc];if([0xf0,0xf2,0xf4,0xf5,0xff].includes(op))return false;if(op>=0x60&&op<=0x7f){pc+=op-0x5f;if(pc>=metadata)return false;}}
 return true;
}

export interface FreshConstantCloneCreationProof {
 protocol:FreshConstantPrecisionProtocol;tokenAddress:string;block:FreshMetadataRecoveryBlock;transactionHash:string;transactionIndex:string;
 controller:string;creationLogIndex:string;deployer:string;salt:string;saltLocation:{kind:'portal_salt_log'|'creation_calldata';offset:number;logIndex?:string};
 initcodeHash:string;runtimeHash:string;implementationAddress:string;
}
/** CREATE2 pins the complete fixed constructor, not merely today's proxy
 * target. A canonical authenticated creation and token mint are required.
 * Finding a matching literal salt is a preimage check, never a guess about
 * unknown factory storage/semantics. Unsupported inputs fail closed. */
export function authenticateFreshConstantCloneCreation(protocol:FreshConstantPrecisionProtocol,token:string,c:FreshMetadataCreationContext):FreshConstantCloneCreationProof|null{
 try{
  if(!address(token))return null;validateFreshBlock(c.block,Number(freshInteger(c.block.number)));validateFreshReceipt(c.receipt,c.transaction,c.block);
  const b=blockOf(c.block);if(!validBlock(b)||c.receipt.status!=='0x1')return null;
  const at=Number(freshInteger(c.transaction.transactionIndex)),included=c.block.transactions[at];
  if(!included||!equal(included.hash,c.transaction.hash)||JSON.stringify(included)!==JSON.stringify(c.transaction))return null;
  const audit=FRESH_CONSTANT_PRECISION_AUDITS[protocol],baseProtocol=audit.protocol,initcodeHash=keccak256(freshConstantCloneInitcode(protocol)),creations=[];
  for(const log of c.receipt.logs){
   const controller=log.address.toLowerCase();if(baseProtocol==='flap'?controller!==FLAP_PORTAL:!FOUR_MANAGERS.includes(controller))continue;
   for(const abi of baseProtocol==='flap'?[flapInterface]:[fourInterface,fourV1Interface])try{
    const parsed=abi.parseLog(log);if(parsed&&['TokenCreated','TokenCreate'].includes(parsed.name)&&equal(String(parsed.args.token),token))creations.push({log,parsed,controller});
   }catch{}
  }
  // The v1/v2 ABI decoders are distinct; no duplicate or ambiguous launch.
  if(creations.length!==1)return null;const launch=creations[0];
  if(!c.receipt.logs.some(log=>equal(log.address,token)&&log.topics.length===3&&log.topics[0]===transferTopic&&log.topics[1]===zero&&/^0x[\da-f]{64}$/i.test(log.data)&&BigInt(log.data)>0n))return null;
  const matches=new Map<string,FreshConstantCloneCreationProof['saltLocation']>();
  const consider=(salt:string,location:FreshConstantCloneCreationProof['saltLocation'])=>{if(hash(salt)&&equal(getCreate2Address(audit.deployer,salt,initcodeHash),token)&&!matches.has(salt.toLowerCase()))matches.set(salt.toLowerCase(),location);};
  if(baseProtocol==='flap'){
   for(const log of c.receipt.logs)if(log.address.toLowerCase()===FLAP_PORTAL&&log.topics.length===1&&log.topics[0]===saltTopic&&/^0x[\da-f]{320}$/i.test(log.data)){
    const words=log.data.slice(2).match(/.{64}/g)!;
    if(equal('0x'+words[0].slice(-40),String(launch.parsed.args.creator))&&/^0{24}/.test(words[0])&&/^0{24}/.test(words[2])&&equal('0x'+words[2].slice(-40),token))consider('0x'+words[1],{kind:'portal_salt_log',offset:32,logIndex:log.logIndex});
   }
   const input=c.transaction.input;
   if(!matches.size&&typeof input==='string'&&/^0x(?:[\da-f]{2})*$/i.test(input)&&input.length<=2+4096*2){
    const seen=new Set<string>();for(let offset=0;offset+64<=input.length-2;offset+=2){const salt='0x'+input.slice(2+offset,2+offset+64);if(!seen.has(salt)){seen.add(salt);consider(salt,{kind:'creation_calldata',offset:offset/2});}}
   }
  }else if(c.transaction.to&&FOUR_MANAGERS.includes(c.transaction.to.toLowerCase())&&typeof c.transaction.input==='string'
   &&/^0x519ebb10[\da-f]+$/i.test(c.transaction.input)&&c.transaction.input.length>=2+(164+32)*2&&c.transaction.input.length<=2+16384*2){
   consider('0x'+c.transaction.input.slice(2+164*2,2+(164+32)*2),{kind:'creation_calldata',offset:164});
  }
  if(matches.size!==1)return null;const[salt,saltLocation]=[...matches][0];
  return{protocol,tokenAddress:token.toLowerCase(),block:b,transactionHash:c.transaction.hash.toLowerCase(),transactionIndex:c.transaction.transactionIndex,
   controller:launch.controller,creationLogIndex:launch.log.logIndex,deployer:audit.deployer,salt,saltLocation,initcodeHash,runtimeHash:keccak256(freshConstantCloneRuntime(protocol)),implementationAddress:audit.implementation};
 }catch{return null;}
}

export interface FreshConstantPrecisionRecoveryInput {
 chainId:number;protocol:FreshConstantPrecisionProtocol;tokenAddress:string;target:FreshMetadataRecoveryBlock;creation:FreshMetadataCreationContext;
 source:{tokenAddress:string;creation:FreshMetadataCreationContext;payload:Buffer;block:FreshMetadataRecoveryBlock};
 implementation:{address:string;code:string;block:FreshMetadataRecoveryBlock};
}
export interface FreshConstantPrecisionProof {
 version:1;kind:'authenticated_constant_clone_precision';auditId:string;chainId:56;decimals:18;tokenAddress:string;target:FreshMetadataRecoveryBlock;
 creation:FreshConstantCloneCreationProof;source:{tokenAddress:string;block:FreshMetadataRecoveryBlock;transactionHash:string;payloadSha256:string;stateEvidenceSha256:string;creation:FreshConstantCloneCreationProof;call:{to:string;data:string;result:string}};
 implementation:{address:string;codeHash:string;codeBytes:number;observedBlock:FreshMetadataRecoveryBlock;historicalCodeAnchor:'fixed_proxy_committed_response_and_bsc_bep344'};
}
/** A committed earlier call through an independently CREATE2-authenticated
 * fixed proxy anchors this SAME direct implementation at block end. BSC
 * BEP-344 then prevents replacing that committed ordinary runtime. The target
 * clone is created AFTER that anchor, so the audited implementation cannot
 * destroy/change it in its creation transaction. Only the pure constant
 * precision is recovered; supply, balances, names and prices remain unknown. */
export function recoverFreshConstantClonePrecision(input:FreshConstantPrecisionRecoveryInput):{decimals:18;proof:FreshConstantPrecisionProof}|null{
 try{
  const{protocol,target,source,implementation}=input,a=FRESH_CONSTANT_PRECISION_AUDITS[protocol];
  if(input.chainId!==56||!a||!validBlock(target)||!validBlock(source.block)||!validBlock(implementation.block)
   ||source.block.number>=target.number||implementation.block.number<target.number||!equal(implementation.address,a.implementation)
   ||!validFreshConstantPrecisionCode(protocol,implementation.code)||!Buffer.isBuffer(source.payload)||source.payload.length>2*1024*1024)return null;
  const creation=authenticateFreshConstantCloneCreation(protocol,input.tokenAddress,input.creation),sourceCreation=authenticateFreshConstantCloneCreation(protocol,source.tokenAddress,source.creation);
  if(!creation||!sourceCreation||creation.block.number>target.number||sourceCreation.block.number>source.block.number
   ||source.block.number>=creation.block.number||Date.parse(source.block.timestamp)>Date.parse(creation.block.timestamp)
   ||Date.parse(sourceCreation.block.timestamp)>Date.parse(source.block.timestamp)
   ||Date.parse(creation.block.timestamp)>Date.parse(target.timestamp)||Date.parse(implementation.block.timestamp)<Date.parse(target.timestamp))return null;
  const entry=decodeFreshEvidence(source.payload);
  if(!equal(entry.transaction.hash,entry.receipt.transactionHash)||!equal(entry.transaction.blockHash,source.block.hash)||!equal(entry.receipt.blockHash,source.block.hash)
   ||Number(freshInteger(entry.transaction.blockNumber))!==source.block.number||Number(freshInteger(entry.receipt.blockNumber))!==source.block.number)return null;
  const state=createFreshStateEvidenceRpc(async()=>{throw Error('constant_precision_network_forbidden');},source.block,entry.stateEvidence);
  if(state.rejectedPrior)return null;const call=state.snapshot()?.calls.find(call=>call.to===source.tokenAddress.toLowerCase()&&call.data==='0x313ce567');
  if(!call||!/^0x[\da-f]{64}$/i.test(call.result)||BigInt(call.result)!==18n)return null;
  return{decimals:18,proof:{version:1,kind:'authenticated_constant_clone_precision',auditId:a.id,chainId:56,decimals:18,tokenAddress:input.tokenAddress.toLowerCase(),target:{...target},creation,
   source:{tokenAddress:source.tokenAddress.toLowerCase(),block:{...source.block},transactionHash:entry.transaction.hash.toLowerCase(),payloadSha256:sha(source.payload),stateEvidenceSha256:sha(JSON.stringify(entry.stateEvidence)),creation:sourceCreation,call},
   implementation:{address:a.implementation,codeHash:a.codeHash,codeBytes:a.codeBytes,observedBlock:{...implementation.block},historicalCodeAnchor:'fixed_proxy_committed_response_and_bsc_bep344'}}};
 }catch{return null;}
}
