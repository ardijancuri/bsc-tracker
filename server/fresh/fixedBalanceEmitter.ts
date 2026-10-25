import {AbiCoder,getCreateAddress,keccak256} from 'ethers';
import {validateFreshBlock,validateFreshReceipt,freshInteger,type FreshTransaction,type FreshReceipt,type FreshBlock} from './capture.js';
import type {FreshTokenAuthenticityProof} from './tokenAuthenticity.js';

/** Individually pinned complete creations sharing one audited dispatcher.
 * Different metadata/supply/range arguments are NOT normalized into this list.
 * No symbol, deployer, failed balance call or generic no-SSTORE rule is used. */
export const FRESH_FIXED_BALANCE_EMITTER_AUDIT=Object.freeze({
 id:'fixed_balance_batch_log_emitter_v1' as const,initcodeBytes:3109,constructorBytes:769,
 constructorHash:'0xc06f3e7dc80e568308fc85567f2ed4711c402364caf3dd56a23265a7ccd6af8a',
 runtimeBytes:2052,runtimeHash:'0xf75dd1221b0e9efb075e91f9acfcafcf41e7d49542dde14e7f923fe2ea74abeb',
 metadataStart:0x7cf,argumentsOffset:2821,argumentsBytes:288,copyPc:0x2fd,returnPc:0x2ff,
 returnStart:0x2f4,returnTail:'0x5b610804806103015f395ff3fe',
 // Only owner-only native/ERC20 withdrawals use these exact call PCs. Own
 // balanceOf is local timestamp/address hashing; transfer*/approve emit logs.
 withdrawalCalls:Object.freeze([{pc:0x3a8,opcode:0xf1},{pc:0x40d,opcode:0xfa},{pc:0x42b,opcode:0xf1}].map(item=>Object.freeze(item))),
 creations:Object.freeze([
  {
    "initcodeHash": "0x346850b79acf1d9baae4a7f70bf225d712e7ce3eab7c2e2e5697eccb787db051",
    "argumentsHash": "0x50f59342eb457d4278d6db7f96ce7d7645302e4be01a0c6abba11cf2137d00bd"
  },
  {
    "initcodeHash": "0x7414b961786591505080ab25ea9d084cddf4490c088917ae14877ce62730ddc1",
    "argumentsHash": "0x0312cc52a519c9e61524ad03fb48d8974b350f2fb0ed948ad8f94adebe43ac47"
  },
  {
    "initcodeHash": "0xaff9bf08817aad935d853b6cf998d0440154d154191e39f572c4efa7d8afa9f7",
    "argumentsHash": "0x5a41af292fd8371cd4d8df91a2b73175ae383c70862d86dd50342d1c57a05e16"
  },
  {
    "initcodeHash": "0x492df6354a2742234d2c54f49fdfd434b932a44705dd11384daae5baab8d989d",
    "argumentsHash": "0x18cde8a8aacfb877d1ae068b33b6af382de6d88c8c1b8178520b0a49d92297b7"
  },
  {
    "initcodeHash": "0xb37f7f5c25c968dfef6dcff275dea71e8e7ef0b712f3a6208dc36e1e0ff0fb84",
    "argumentsHash": "0x809339750d11265f8c502c641fccaca18dc6fc6d174721d299058a6f27c9cf7c"
  },
  {
    "initcodeHash": "0x2ee3ef1672c5de0b9c500fc63217279f7a7aff491943b85d31e6c7f9e08e20b3",
    "argumentsHash": "0x5deced172a8e118ec5a059a4d19b2be33f4633baadff6c9cc0d4bee5611c8031"
  }
].map(item=>Object.freeze(item))),
});
const abi=AbiCoder.defaultAbiCoder(),types=['string','string','uint8','uint256','uint256'],same=(a:string,b:string)=>a.toLowerCase()===b.toLowerCase();
/** Independent exact family branch. The general classifier's no-CALL audit
 * remains intact. BSC callers supply already canonical capture context; this
 * pure verifier additionally binds complete indexed CREATE, original input,
 * successful receipt, return path, full runtime and each argument hash. */
export function classifyFreshFixedBalanceEmitter(input:{chainId:number;transaction:FreshTransaction;receipt:FreshReceipt;block:FreshBlock}):FreshTokenAuthenticityProof|null{
 try{
  const a=FRESH_FIXED_BALANCE_EMITTER_AUDIT,{transaction:tx,receipt,block}=input;
  if(input.chainId!==56||!tx||tx.to!==null||freshInteger(tx.value)!==0n||freshInteger(tx.nonce)>0xffffffffffffffffn||typeof tx.input!=='string'
   ||!/^0x[\da-f]+$/i.test(tx.input)||tx.input.length!==2+a.initcodeBytes*2)return null;
  const initcode=tx.input.toLowerCase(),initcodeHash=keccak256(initcode),pinned=a.creations.find(x=>x.initcodeHash===initcodeHash);if(!pinned)return null;
  const number=Number(freshInteger(block.number));validateFreshBlock(block,number);validateFreshReceipt(receipt,tx,block);
  const index=Number(freshInteger(tx.transactionIndex)),included=block.transactions[index],contract=getCreateAddress({from:tx.from,nonce:freshInteger(tx.nonce)}).toLowerCase();
  if(!Number.isSafeInteger(number)||Number(freshInteger(block.timestamp))<1718863500||receipt.status!=='0x1'||!receipt.contractAddress||!same(receipt.contractAddress,contract)
   ||JSON.stringify(included)!==JSON.stringify(tx))return null;
  const bytes=Buffer.from(initcode.slice(2),'hex'),constructor=bytes.subarray(0,a.constructorBytes),runtime=bytes.subarray(a.constructorBytes,a.argumentsOffset),args=bytes.subarray(a.argumentsOffset);
  if(keccak256(constructor)!==a.constructorHash||runtime.length!==a.runtimeBytes||keccak256(runtime)!==a.runtimeHash||args.length!==a.argumentsBytes||keccak256(args)!==pinned.argumentsHash
   ||'0x'+constructor.subarray(a.returnStart).toString('hex')!==a.returnTail)return null;
  const values=abi.decode(types,'0x'+args.toString('hex'));
  if(abi.encode(types,values).toLowerCase()!=='0x'+args.toString('hex')||values[2]!==18n||values[3]<=0n||values[4]!==0n)return null;
  if(runtime.length-runtime.readUInt16BE(runtime.length-2)-2!==a.metadataStart||runtime[a.metadataStart-1]!==0xfe)return null;
  // A 0x5b byte inside PUSH data is not an EVM jump destination. Walk the
  // complete stream so CBOR after INVALID has no executable entry point.
  const calls=[];for(let pc=0;pc<runtime.length;pc++){const op=runtime[pc];
   if(pc>=a.metadataStart){if(op===0x5b)return null;}
   else{if([0x55,0x5d,0xf0,0xf2,0xf4,0xf5,0xff].includes(op))return null;if(op===0xf1||op===0xfa)calls.push({pc,opcode:op});}
   if(op>=0x60&&op<=0x7f){const from=pc;pc+=op-0x5f;if(from<a.metadataStart&&pc>=a.metadataStart)return null;}}
  if(JSON.stringify(calls)!==JSON.stringify(a.withdrawalCalls))return null;
  return{version:1,classification:'proven_nonledger_event_emitter',templateId:a.id,ledgerAbsent:true,
   creationEvidence:{transaction:{hash:tx.hash.toLowerCase(),from:tx.from.toLowerCase(),to:null,nonce:tx.nonce as string,value:tx.value,input:initcode,
    blockHash:block.hash.toLowerCase(),blockNumber:tx.blockNumber,transactionIndex:tx.transactionIndex},receipt:{transactionHash:tx.hash.toLowerCase(),blockHash:block.hash.toLowerCase(),blockNumber:receipt.blockNumber,transactionIndex:receipt.transactionIndex,status:'0x1',contractAddress:contract},
    block:{hash:block.hash.toLowerCase(),parentHash:block.parentHash.toLowerCase(),number:block.number,timestamp:block.timestamp}},
   bytecode:{initcodeHash,constructorHash:a.constructorHash,runtimeHash:a.runtimeHash,runtimeOffset:a.constructorBytes,runtimeBytes:a.runtimeBytes,returnOffset:a.returnStart,
    constructorArguments:{offset:a.argumentsOffset,bytes:a.argumentsBytes,hash:pinned.argumentsHash,returnPc:a.returnPc,immutablePatches:[]}}};
 }catch{return null;}
}
