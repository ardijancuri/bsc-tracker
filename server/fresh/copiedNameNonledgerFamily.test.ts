import{readFileSync}from'node:fs';import{gunzipSync}from'node:zlib';import{getCreateAddress,keccak256}from'ethers';import{describe,it,expect}from'vitest';
import{classifyFreshCreationToken}from'./tokenAuthenticity.js';import{FRESH_COPIED_NAME_NONLEDGER_FAMILY as family,freshCopiedNameNonledgerFamily}from'./copiedNameNonledgerFamily.js';
import type{FreshTransaction,FreshReceipt,FreshBlock}from'./capture.js';
type Fixture={token:string;transaction:FreshTransaction;receipt:FreshReceipt;block:FreshBlock};
// Complete original successful canonical BSC top-level creation vectors.
const fixtures=JSON.parse(gunzipSync(readFileSync(new URL('./fixtures/copied-name-nonledger-creations.json.gz',import.meta.url))).toString())as Fixture[];
const fixture=(i=0)=>structuredClone(fixtures[i]),bytes=(f:Fixture)=>Buffer.from(String(f.transaction.input).slice(2),'hex');
function update(f:Fixture,value:Buffer){f.transaction.input='0x'+value.toString('hex');f.block.transactions[Number(BigInt(f.transaction.transactionIndex))]=structuredClone(f.transaction);}
function mutate(f:Fixture,fn:(runtime:Buffer)=>void){const value=bytes(f);fn(value.subarray(family.runtimeOffset));update(f,value);}

describe('audited copied-name stateless Transfer emitter family',()=>{
 it.each([0,1])('authenticates complete original constructor and returned runtime %s',i=>{
  const f=fixture(i),raw=bytes(f),runtime=raw.subarray(28),p=classifyFreshCreationToken(f)!;expect(p).not.toBeNull();
  expect(p).toMatchObject({classification:'proven_nonledger_event_emitter',ledgerAbsent:true,templateId:family.templateId,creationEvidence:{transaction:{hash:f.transaction.hash,input:f.transaction.input},receipt:{contractAddress:f.token}},bytecode:{initcodeHash:keccak256(raw),constructorHash:keccak256(raw.subarray(0,28)),runtimeHash:keccak256(runtime),runtimeBytes:runtime.length,runtimeOffset:28,returnOffset:16}});
  const structural=freshCopiedNameNonledgerFamily(raw)!;expect(structural.codeEnd).toBe(1585);expect(structural.metadataStart-family.codeEnd).toBe(i===0?52:68);
 });
 it('has no executable state access, calls, delegation, creation or destruction in either entire runtime prefix',()=>{
  const forbidden=new Set([0x54,0x55,0x5c,0x5d,0xf0,0xf1,0xf2,0xf4,0xf5,0xfa,0xff]);
  for(const f of fixtures){const runtime=bytes(f).subarray(28);let last=-1;for(let pc=0;pc<family.codeEnd;pc++){last=pc;const op=runtime[pc];expect(forbidden.has(op)).toBe(false);if(op>=0x60&&op<=0x7f)pc+=op-0x5f;}
   expect(last).toBe(family.codeEnd-1);expect(runtime[last]).toBe(0xfe);
  }
 });
 it('generalizes only metadata literals, with arbitrary jump-looking data kept unreachable',()=>{
  const f=fixture();mutate(f,r=>{const n=r[family.nameLengthOffsets[0]];r.fill(0x5b,family.codeEnd,family.codeEnd+n);r[family.symbolLengthOffset]=3;r.fill(0,family.symbolWordOffset,family.symbolWordOffset+32);r.set(Buffer.from('ABC'),family.symbolWordOffset);r.fill(0x5b,family.codeEnd+n+10,family.codeEnd+n+42);});
  f.transaction.from='0x'+'1'.repeat(40);f.transaction.nonce='0x123';f.receipt.contractAddress=getCreateAddress({from:f.transaction.from,nonce:BigInt(String(f.transaction.nonce))}).toLowerCase();f.token=f.receipt.contractAddress;f.block.transactions[Number(BigInt(f.transaction.transactionIndex))]=structuredClone(f.transaction);
  expect(classifyFreshCreationToken(f)?.templateId).toBe(family.templateId);
 });
 it.each([0x54,0x55,0x5c,0x5d,0xf0,0xf1,0xf2,0xf4,0xf5,0xfa,0xff])('rejects executable state/call opcode0x%s',op=>{
  const f=fixture();mutate(f,r=>{r[4]=op;});expect(classifyFreshCreationToken(f)).toBeNull();
 });
 it('rejects altered Transfer logs, dispatch, executable jumps and data reachability',()=>{
  for(const fn of[
   (r:Buffer)=>{r[316]^=1;},
   (r:Buffer)=>{r[32]^=1;},
   (r:Buffer)=>{r[39]=family.codeEnd>>8;r[40]=family.codeEnd&255;r[family.codeEnd]=0x5b;},
   (r:Buffer)=>{r[family.codeEnd-1]=0x5b;r[family.codeEnd]=0x55;},
   (r:Buffer)=>{r[258]=r[258]-1;},
   (r:Buffer)=>{r[256]=0;r[257]=0;}
  ]){const f=fixture();mutate(f,fn);expect(classifyFreshCreationToken(f)).toBeNull();}
 });
 it('rejects name/symbol overflow, noncanonical allocation, nonzero padding and changed metadata envelope',()=>{
  for(const fn of[
   (r:Buffer)=>{r[248]=32;r[258]=32;},
   (r:Buffer)=>{r[248]=97;r[258]=97;},
   (r:Buffer)=>{r[241]=64;},
   (r:Buffer)=>{r[629]=0;},
   (r:Buffer)=>{r[629]=33;},
   (r:Buffer)=>{r[family.symbolWordOffset+r[family.symbolLengthOffset]]=1;},
   (r:Buffer)=>{r[r.length-1]=0x32;},
   (r:Buffer)=>{r[r.length-4]^=1;},
   (r:Buffer)=>{r[family.codeEnd+r[248]]=0xa3;}
  ]){const f=fixture();mutate(f,fn);expect(classifyFreshCreationToken(f)).toBeNull();}
 });
 it('rejects constructor state/call/copy/return changes, appended arguments and truncated data',()=>{
  for(const fn of[
   (b:Buffer)=>{b[4]=0x55;return b;},
   (b:Buffer)=>{b[4]=0xf4;return b;},
   (b:Buffer)=>{b[22]=0x1d;return b;},
   (b:Buffer)=>{b[24]=0x55;return b;},
   (b:Buffer)=>{b[26]=0xf1;return b;},
   (b:Buffer)=>Buffer.concat([b,Buffer.from([0])]),
   (b:Buffer)=>b.subarray(0,b.length-1)
  ]){const f=fixture();update(f,fn(bytes(f)));expect(classifyFreshCreationToken(f)).toBeNull();}
 });
 it('requires original successful receipt, exact block membership, creation address and zero-value constructor',()=>{
  for(const fn of[
   (f:Fixture)=>{f.receipt.status='0x0';},
   (f:Fixture)=>{f.receipt.contractAddress='0x'+'1'.repeat(40);},
   (f:Fixture)=>{f.receipt.transactionHash='0x'+'1'.repeat(64);},
   (f:Fixture)=>{f.block.transactions[Number(BigInt(f.transaction.transactionIndex))].input='0x';},
   (f:Fixture)=>{f.transaction.value='0x1';f.block.transactions[Number(BigInt(f.transaction.transactionIndex))]=structuredClone(f.transaction);},
   (f:Fixture)=>{f.transaction.chainId='0x1';f.block.transactions[Number(BigInt(f.transaction.transactionIndex))]=structuredClone(f.transaction);}
  ]){const f=fixture();fn(f);expect(classifyFreshCreationToken(f)).toBeNull();}
 });
});
