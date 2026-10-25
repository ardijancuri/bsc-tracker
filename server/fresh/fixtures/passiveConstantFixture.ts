import {readFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {getCreate2Address,keccak256,toBeHex,zeroPadValue,Interface} from 'ethers';

import {flapInterface,fourInterface,FLAP_PORTAL,FOUR_MANAGERS} from '../../launchpad.js';
import {transferTopic} from '../../swap.js';
import {encodeFreshEvidence,type FreshCapturedReceipt} from '../capture.js';
import {FRESH_CONSTANT_PRECISION_AUDITS,authenticateFreshConstantCloneCreation,freshConstantCloneInitcode,recoverFreshConstantClonePrecision,validFreshConstantPrecisionCode,
 type FreshConstantPrecisionProtocol,type FreshConstantPrecisionRecoveryInput,type FreshMetadataCreationContext} from '../constantMetadataRecovery.js';
const fixtureCode=JSON.parse(readFileSync(new URL('./constant-precision-code.json',import.meta.url),'utf8'));
const code=(p:FreshConstantPrecisionProtocol)=>gunzipSync(Buffer.from(fixtureCode[p],'base64')).toString();
const h=(n:number|bigint)=>zeroPadValue(toBeHex(n),32),a=(n:number)=>zeroPadValue(toBeHex(n),20),zero=h(0),creator=a(77);
const header=(n:number)=>({number:n,hash:h(n),timestamp:new Date(Date.UTC(2026,0,1)+n*1000).toISOString()});
function creation(p:FreshConstantPrecisionProtocol,n:number,salt=h(n)):FreshMetadataCreationContext{
 const audit=FRESH_CONSTANT_PRECISION_AUDITS[p],token=getCreate2Address(audit.deployer,salt,keccak256(freshConstantCloneInitcode(p))).toLowerCase(),b=header(n);
 const isFlap=audit.protocol==='flap',launch=isFlap?flapInterface.encodeEventLog(flapInterface.getEvent('TokenCreated')!,[BigInt(Date.parse(b.timestamp)/1000),creator,n,token,'Token','T','']):fourInterface.encodeEventLog(fourInterface.getEvent('TokenCreate')!,[creator,token,n,'Token','T',1000,0,0]);
 const controller=isFlap?FLAP_PORTAL:FOUR_MANAGERS[1];
 const logs=[{address:token,topics:[transferTopic,zero,h(1)],data:h(1000)},
  ...(isFlap?[{address:controller,topics:['0xd1e8818b2d9da34c6537d2aa8e66a200caa79c8f3126365e8fd5b29ee28a766d'],data:'0x'+[h(BigInt(creator)),salt,h(BigInt(token)),h(6),h(0)].map(x=>x.slice(2)).join('')}]:[]),
  {address:controller,...launch}].map((log,index)=>({...log,logIndex:toBeHex(index),transactionHash:h(10000+n),transactionIndex:'0x0',blockHash:b.hash,blockNumber:toBeHex(n)}));
 const input=isFlap?'0x12345678':`0x519ebb10${'0'.repeat(160*2)}${salt.slice(2)}`;
 const transaction={hash:h(10000+n),from:creator,to:controller,value:'0x0',input,nonce:toBeHex(n),gasPrice:'0x0',blockHash:b.hash,blockNumber:toBeHex(n),transactionIndex:'0x0'};
 return{transaction,receipt:{transactionHash:transaction.hash,blockHash:b.hash,blockNumber:transaction.blockNumber,transactionIndex:'0x0',status:'0x1',gasUsed:'0x1',logs},
  block:{number:toBeHex(n),hash:b.hash,parentHash:h(n-1),timestamp:toBeHex(Date.parse(b.timestamp)/1000),transactions:[transaction]}};
}
function fixture(p:FreshConstantPrecisionProtocol):FreshConstantPrecisionRecoveryInput{
 const targetCreation=creation(p,120),sourceCreation=creation(p,100),token=getCreate2Address(FRESH_CONSTANT_PRECISION_AUDITS[p].deployer,h(120),keccak256(freshConstantCloneInitcode(p))).toLowerCase(),sourceToken=getCreate2Address(FRESH_CONSTANT_PRECISION_AUDITS[p].deployer,h(100),keccak256(freshConstantCloneInitcode(p))).toLowerCase(),sourceBlock=header(110);
 const sourceEntry:FreshCapturedReceipt={transaction:{hash:h(9000),from:creator,to:sourceToken,value:'0x0',blockHash:sourceBlock.hash,blockNumber:toBeHex(110),transactionIndex:'0x0'},receipt:{transactionHash:h(9000),blockHash:sourceBlock.hash,blockNumber:toBeHex(110),transactionIndex:'0x0',status:'0x1',gasUsed:'0x1',logs:[]},wallets:[creator],observedAt:sourceBlock.timestamp,
  stateEvidence:{version:1,blockNumber:110,blockHash:sourceBlock.hash,calls:[{to:sourceToken,data:'0x313ce567',result:h(18)}]}};
 return{chainId:56,protocol:p,tokenAddress:token,target:header(130),creation:targetCreation,source:{tokenAddress:sourceToken,creation:sourceCreation,payload:encodeFreshEvidence(sourceEntry),block:sourceBlock},
 implementation:{address:FRESH_CONSTANT_PRECISION_AUDITS[p].implementation,code:code(p),block:header(140)}};
}

export{fixture};
