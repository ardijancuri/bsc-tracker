import {readFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {getCreate2Address,keccak256,toBeHex,zeroPadValue,Interface} from 'ethers';
import {describe,expect,it} from 'vitest';
import {flapInterface,fourInterface,FLAP_PORTAL,FOUR_MANAGERS} from '../launchpad.js';
import {transferTopic} from '../swap.js';
import {encodeFreshEvidence,type FreshCapturedReceipt} from './capture.js';
import {FRESH_CONSTANT_PRECISION_AUDITS,authenticateFreshConstantCloneCreation,freshConstantCloneInitcode,recoverFreshConstantClonePrecision,validFreshConstantPrecisionCode,
 type FreshConstantPrecisionProtocol,type FreshConstantPrecisionRecoveryInput,type FreshMetadataCreationContext} from './constantMetadataRecovery.js';
const fixtureCode=JSON.parse(readFileSync(new URL('./fixtures/constant-precision-code.json',import.meta.url),'utf8'));
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
describe('authenticated pure precision across fixed clone instances',()=>{
 for(const p of ['flap','fourmeme','fourmemeffff'] as const){
  it(`${p}: pins direct implementation code and recovers only18 with separate source/target constructor proofs`,()=>{
   const x=fixture(p),result=recoverFreshConstantClonePrecision(x);expect(validFreshConstantPrecisionCode(p,code(p))).toBe(true);expect(result?.decimals).toBe(18);
   expect(result?.proof.source.tokenAddress).not.toBe(result?.proof.tokenAddress);expect(result?.proof.creation.runtimeHash).toBeDefined();expect(result?.proof.implementation.codeHash).toBe(FRESH_CONSTANT_PRECISION_AUDITS[p].codeHash);
   expect(result).not.toHaveProperty('supplyRaw');expect(result).not.toHaveProperty('price');expect(result?.proof).not.toHaveProperty('wallets');
  });
  it(`${p}: rejects changed current code/additional proxy hop, wrong chain/implementation and forged constructor salt`,()=>{
   const x=fixture(p);x.implementation.code='0x363d3d373d3d3d363d73'+'1'.repeat(40)+'5af43d82803e903d91602b57fd5bf3';expect(recoverFreshConstantClonePrecision(x)).toBeNull();
   for(const mutate of [(x:any)=>x.chainId=1,(x:any)=>x.implementation.address=a(1),(x:any)=>x.tokenAddress=a(2),(x:any)=>x.creation.receipt.status='0x0']){const z=fixture(p);mutate(z);expect(recoverFreshConstantClonePrecision(z)).toBeNull();}
  });
  it(`${p}: rejects future/same-creation-block anchors, orphan/foreign source envelopes and missing original raw calls`,()=>{
   for(const mutate of [(x:any)=>x.source.block=header(120),(x:any)=>x.source.block.hash=h(999),(x:any)=>x.source.payload=Buffer.from('current_token_row_18'),(x:any)=>x.implementation.block=header(129)]){const x=fixture(p);mutate(x);expect(recoverFreshConstantClonePrecision(x)).toBeNull();}
  });
 }
 it('accepts a nested Flap calldata literal only when its exact CREATE2 preimage matches and a canonical mint/launch exists',()=>{
  const x=fixture('flap');x.creation.receipt.logs=x.creation.receipt.logs.filter(l=>l.topics[0]!== '0xd1e8818b2d9da34c6537d2aa8e66a200caa79c8f3126365e8fd5b29ee28a766d');
  x.creation.transaction.input='0x12345678abcdef'+h(120).slice(2);x.creation.block.transactions[0]=x.creation.transaction;
  expect(authenticateFreshConstantCloneCreation('flap',x.tokenAddress,x.creation)?.saltLocation).toEqual({kind:'creation_calldata',offset:7});
  x.creation.receipt.logs=x.creation.receipt.logs.filter(l=>l.topics[0]!==transferTopic);expect(authenticateFreshConstantCloneCreation('flap',x.tokenAddress,x.creation)).toBeNull();
 });
 it('rejects a forged raw decimals response despite its valid envelope and checksum',()=>{
  const x=fixture('flap'),raw:FreshCapturedReceipt={transaction:{hash:h(9000),from:creator,to:x.source.tokenAddress,value:'0x0',blockHash:h(110),blockNumber:toBeHex(110),transactionIndex:'0x0'},receipt:{transactionHash:h(9000),blockHash:h(110),blockNumber:toBeHex(110),transactionIndex:'0x0',status:'0x1',gasUsed:'0x1',logs:[]},wallets:[creator],observedAt:header(110).timestamp,stateEvidence:{version:1,blockNumber:110,blockHash:h(110),calls:[{to:x.source.tokenAddress,data:'0x313ce567',result:h(9)}]}};
  x.source.payload=encodeFreshEvidence(raw);expect(recoverFreshConstantClonePrecision(x)).toBeNull();
 });
});
