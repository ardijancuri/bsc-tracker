import {AbiCoder,getCreateAddress,keccak256,toUtf8Bytes,zeroPadValue,toBeHex} from 'ethers';
import {validateFreshBlock,validateFreshReceipt,freshInteger} from './capture.js';
import type {FreshMetadataCreationContext} from './constantMetadataRecovery.js';
import type {FreshMetadataRecoveryBlock} from './metadataRecovery.js';

/** One complete, independently audited creation. This is not an ERC20 class
 * matcher: different bytecode, arguments, address or creation tx fail closed. */
export const FRESH_LITERAL_METADATA_AUDIT=Object.freeze({
 id:'shit_cash_exact_creation_constant_precision_v1',tokenAddress:'0x97736ba46da1a14c50eb29805b4984c500842069',
 transactionHash:'0x779948f3be9c2de5133e61f14dbed7706533f461492c3a3c6aaf3cdca6302b75',
 initcodeBytes:6336,initcodeHash:'0x4d5dbd16e73380c111f734ee043ef0b4d95f2b612983196e8324b2e8641304f0',
 constructorBytes:2108,constructorHash:'0xb41bcb368ddb6d022eebf34811176c7c1e39dd5fd99cf0982b86ba32c0514374',
 runtimeBytes:3972,runtimeTemplateHash:'0x33fcc282c226fd6eec4542c6b736a9bb33b2f462028aeeb03a204b38fb35b93e',
 runtimeHash:'0xcaffaabd6c85e6b980c813d3097c1d3abb57f1a6e192a28a2508c600bcef1a91',
 argumentsOffset:6080,argumentsBytes:256,argumentsHash:'0x04be1d74aa66c77d82c6503095519108c3a3908af68d20a849001162ff7bda8d',
 copyPc:0x266,returnPc:0x2a0,returnStart:0x25a,
 returnBytes:'5191610f8493846200083c853960805184610a6f015260a05184610b3b015260c05184610a40015260e05184610abe01525183610ae4015251826103dd015251816104070152f3',
 getterPc:0x590,getterBytes:'5b82346100f8575f6003193601126100f8576020905160128152f3',
 metadataStart:3919,
});
const abi=AbiCoder.defaultAbiCoder(),types=['string','string','uint256','address'],hash=(x:unknown):x is string=>typeof x==='string'&&/^0x[\da-f]{64}$/i.test(x),equal=(a:string,b:string)=>a.toLowerCase()===b.toLowerCase();
const validBlock=(x:FreshMetadataRecoveryBlock)=>Number.isSafeInteger(x?.number)&&x.number>=0&&hash(x.hash)&&Number.isSafeInteger(Date.parse(x.timestamp)/1000)&&Date.parse(x.timestamp)>=1718863500000;
const word=(x:bigint|string)=>typeof x==='string'?zeroPadValue(x,32):zeroPadValue(toBeHex(x),32);
const shortString=(x:string)=>{const b=Buffer.from(x,'utf8');if(b.length>=32)throw Error('literal_short_string_unsupported');const out=Buffer.alloc(32);b.copy(out);out[31]=b.length;return'0x'+out.toString('hex');};
export interface FreshLiteralMetadataInput {chainId:number;tokenAddress:string;target:FreshMetadataRecoveryBlock;targetTransactionIndex:number;creation:FreshMetadataCreationContext}
export interface FreshLiteralMetadataProof {version:1;kind:'authenticated_literal_creation_precision';auditId:string;chainId:56;decimals:18;tokenAddress:string;target:FreshMetadataRecoveryBlock;
 creation:{block:FreshMetadataRecoveryBlock;transactionHash:string;transactionIndex:string;sender:string;nonce:string;initcodeHash:string;constructorHash:string;argumentsHash:string};
 runtime:{templateHash:string;hash:string;bytes:number;copyPc:number;returnPc:number;getterPc:number;getterBytes:string;immutablePatches:{offset:number;value:string}[]};}
/** The exact constructor has one successful RETURN after a literal CODECOPY
 * and seven audited EIP712 patches. All patch words are reconstructed from
 * canonical creation inputs/chain/address; none overlaps the literal precision
 * getter. No current code, raw eth_call, token row or supply value is used. */
export function recoverFreshLiteralCreationPrecision(input:FreshLiteralMetadataInput):{decimals:18;proof:FreshLiteralMetadataProof}|null{
 try{
  const a=FRESH_LITERAL_METADATA_AUDIT,{creation:c,target}=input,tx=c.transaction;
  if(input.chainId!==56||!equal(input.tokenAddress,a.tokenAddress)||!validBlock(target)||!Number.isSafeInteger(input.targetTransactionIndex)||input.targetTransactionIndex<0)return null;
  validateFreshBlock(c.block,Number(freshInteger(c.block.number)));validateFreshReceipt(c.receipt,tx,c.block);
  const creationBlock={number:Number(freshInteger(c.block.number)),hash:c.block.hash.toLowerCase(),timestamp:new Date(Number(freshInteger(c.block.timestamp))*1000).toISOString()},index=Number(freshInteger(tx.transactionIndex));
  if(!validBlock(creationBlock)||tx.to!==null||freshInteger(tx.value)!==0n||c.receipt.status!=='0x1'||!equal(tx.hash,a.transactionHash)
   ||!c.receipt.contractAddress||!equal(c.receipt.contractAddress,input.tokenAddress)||getCreateAddress({from:tx.from,nonce:freshInteger(tx.nonce)}).toLowerCase()!==input.tokenAddress.toLowerCase()
   ||creationBlock.number>target.number||Date.parse(creationBlock.timestamp)>Date.parse(target.timestamp)
   ||creationBlock.number===target.number&&(!equal(creationBlock.hash,target.hash)||creationBlock.timestamp!==target.timestamp||index>input.targetTransactionIndex)
   ||JSON.stringify(c.block.transactions[index])!==JSON.stringify(tx))return null;
  if(typeof tx.input!=='string'||!/^0x[\da-f]+$/i.test(tx.input)||tx.input.length!==2+a.initcodeBytes*2||keccak256(tx.input)!==a.initcodeHash)return null;
  const bytes=Buffer.from(tx.input.slice(2),'hex'),constructor=bytes.subarray(0,a.constructorBytes),args=bytes.subarray(a.argumentsOffset),template=bytes.subarray(a.constructorBytes,a.argumentsOffset);
  if(keccak256(constructor)!==a.constructorHash||keccak256(template)!==a.runtimeTemplateHash||template.length!==a.runtimeBytes||args.length!==a.argumentsBytes||keccak256(args)!==a.argumentsHash
   ||constructor.subarray(a.returnStart,a.returnPc+1).toString('hex')!==a.returnBytes||template.subarray(a.getterPc,a.getterPc+a.getterBytes.length/2).toString('hex')!==a.getterBytes)return null;
  const values=abi.decode(types,'0x'+args.toString('hex'));if(abi.encode(types,values).toLowerCase()!=='0x'+args.toString('hex'))return null;
  const name=String(values[0]),version='1',nameHash=keccak256(toUtf8Bytes(name)),versionHash=keccak256(toUtf8Bytes(version));
  const domain=keccak256(abi.encode(['bytes32','bytes32','bytes32','uint256','address'],[keccak256(toUtf8Bytes('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)')),nameHash,versionHash,56,input.tokenAddress]));
  const patches=[{offset:0xa6f,value:domain},{offset:0xb3b,value:word(56n)},{offset:0xa40,value:word(input.tokenAddress)},
   {offset:0xabe,value:nameHash},{offset:0xae4,value:versionHash},{offset:0x3dd,value:shortString(name)},{offset:0x407,value:shortString(version)}];
  const runtime=Buffer.from(template),occupied=new Set<number>();for(const patch of patches){
   if(patch.offset<1||patch.offset+32>a.metadataStart||template[patch.offset-1]!==0x7f||!template.subarray(patch.offset,patch.offset+32).equals(Buffer.alloc(32))
    ||patch.offset<a.getterPc+a.getterBytes.length/2&&patch.offset+32>a.getterPc)return null;
   for(let n=patch.offset;n<patch.offset+32;n++){if(occupied.has(n))return null;occupied.add(n);}Buffer.from(patch.value.slice(2),'hex').copy(runtime,patch.offset);
  }
  if(keccak256(runtime)!==a.runtimeHash||runtime.length-runtime.readUInt16BE(runtime.length-2)-2!==a.metadataStart||runtime[a.metadataStart-1]!==0xfe||runtime.subarray(a.metadataStart).includes(0x5b))return null;
  for(let pc=0;pc<a.metadataStart;pc++){const op=runtime[pc];if([0xf0,0xf2,0xf4,0xf5,0xff].includes(op))return null;if(op>=0x60&&op<=0x7f){pc+=op-0x5f;if(pc>=a.metadataStart)return null;}}
  return{decimals:18,proof:{version:1,kind:'authenticated_literal_creation_precision',auditId:a.id,chainId:56,decimals:18,tokenAddress:input.tokenAddress.toLowerCase(),target:{...target},
   creation:{block:creationBlock,transactionHash:tx.hash.toLowerCase(),transactionIndex:tx.transactionIndex,sender:tx.from.toLowerCase(),nonce:tx.nonce as string,initcodeHash:a.initcodeHash,constructorHash:a.constructorHash,argumentsHash:a.argumentsHash},
   runtime:{templateHash:a.runtimeTemplateHash,hash:a.runtimeHash,bytes:a.runtimeBytes,copyPc:a.copyPc,returnPc:a.returnPc,getterPc:a.getterPc,getterBytes:a.getterBytes,immutablePatches:patches}}};
 }catch{return null;}
}
