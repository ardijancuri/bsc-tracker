import{readFileSync}from'node:fs';import{gunzipSync}from'node:zlib';import{Interface,keccak256}from'ethers';import{describe,it,expect,vi}from'vitest';
import{classifyFreshSyntheticBatchCreation,decodeFreshSyntheticTransferBatch,readFreshSyntheticBatchAnchor,FRESH_ADDITIONAL_SYNTHETIC_BATCH_AUDITS as audits}from'./syntheticTransferBatch.js';import{executeSyntheticAudit}from'./syntheticBatchEvm.fixture.js';import{normalizeFreshReceipt,type FreshDecodeServices}from'./decode.js';import type{FreshCapturedReceipt,FreshBlock}from'./capture.js';
type Fixture={creation:{transaction:FreshCapturedReceipt['transaction'];receipt:FreshCapturedReceipt['receipt'];block:FreshBlock};runtime:string;receipt:{entry:FreshCapturedReceipt;block:FreshBlock}};
const fixture=()=>JSON.parse(gunzipSync(readFileSync(new URL('./fixtures/dual-synthetic-transfer-batch.json.gz',import.meta.url))).toString())as Fixture[];
describe('two separately pinned synthetic batch deployments',()=>{
 it('checks signed-greater-than execution used by the independent complete constructor interpreter',()=>{
  const exec=(a:bigint,b:bigint)=>executeSyntheticAudit('0x7f'+b.toString(16).padStart(64,'0')+'7f'+a.toString(16).padStart(64,'0')+'135f5260205ff3',{address:audits[0].token,caller:audits[0].creator});
  expect(BigInt('0x'+exec(1n,(1n<<256n)-1n).runtime.toString('hex'))).toBe(1n);expect(BigInt('0x'+exec((1n<<256n)-1n,1n).runtime.toString('hex'))).toBe(0n);expect(BigInt('0x'+exec(1n,1n).runtime.toString('hex'))).toBe(0n);
 });
 it.each([0,1])('reproduces exact complete constructor/runtime for deployment %i',i=>{
  const f=fixture()[i],audit=audits[i],x=executeSyntheticAudit(f.creation.transaction.input as string,{address:audit.token,caller:audit.creator,timestamp:BigInt(f.creation.block.timestamp)}),copy=x.copies.find(c=>c.source===3114)!;
  expect(x.status).toBe('return');expect(x.runtime.toString('hex')).toBe(f.runtime.slice(2));expect(keccak256(x.runtime)).toBe(audit.runtimeHash);expect(x.calls).toEqual([]);expect(x.returnPc).toBe(3112);expect(copy.length).toBe(9597);expect(x.stores.filter(s=>s.step>copy.step).map(s=>s.offset)).toEqual([6112,6067,5903,5863,5698,5740,5782]);expect(classifyFreshSyntheticBatchCreation(f.creation,f.runtime)?.tokenAddress).toBe(audit.token);
 });
 it.each([0,1])('reproduces all 3000 original logs without ledger writes/calls for deployment %i',async i=>{
  const f=fixture()[i],audit=audits[i],anchor=classifyFreshSyntheticBatchCreation(f.creation,f.runtime)!,birth=executeSyntheticAudit(f.creation.transaction.input as string,{address:audit.token,caller:audit.creator}),{entry,block}=f.receipt;
  const x=executeSyntheticAudit(f.runtime,{address:audit.token,caller:entry.transaction.from,storage:birth.storage,calldata:entry.transaction.input as string});expect(x.logs).toHaveLength(3000);expect(x.writes).toEqual([]);expect(x.calls).toEqual([]);expect(x.storage).toEqual(birth.storage);expect(x.logs.map(l=>({topics:l.topics,data:l.data}))).toEqual(entry.receipt.logs.map(l=>({topics:l.topics,data:l.data})));
  expect(decodeFreshSyntheticTransferBatch(entry,block,anchor)?.recipients).toBe(3000);
  const services:FreshDecodeServices={metadata:vi.fn(async()=>{throw Error('must_not_lookup');}),priceUsd:async()=>null,eligible:async()=>true,syntheticBatchAnchor:async token=>token===audit.token?anchor:null};const before=JSON.stringify(entry),out=await normalizeFreshReceipt(entry,block,services);expect(out.events).toEqual([]);expect(out.reasons).toEqual([]);expect(JSON.stringify(entry)).toBe(before);expect(services.metadata).not.toHaveBeenCalled();
 },15000);
 it.each([0,1])('retains real approval storage changes on the same deployment %i',i=>{
  const f=fixture()[i],a=audits[i],birth=executeSyntheticAudit(f.creation.transaction.input as string,{address:a.token,caller:a.creator}),abi=new Interface(['function approve(address,uint256)returns(bool)']);const x=executeSyntheticAudit(f.runtime,{address:a.token,caller:a.creator,storage:birth.storage,calldata:abi.encodeFunctionData('approve',['0x'+'1'.repeat(40),7n])});expect(x.status).toBe('return');expect(x.writes.length).toBeGreaterThan(0);expect(x.logs).toHaveLength(1);
 });
 it('keeps the two exact creation anchors distinct and rejects incomplete/extra/changed evidence',async()=>{
  const fs=fixture(),anchors=fs.map(f=>classifyFreshSyntheticBatchCreation(f.creation,f.runtime)!);
  for(let i=0;i<fs.length;i++){const f=fs[i],a=audits[i];expect(()=>decodeFreshSyntheticTransferBatch(f.receipt.entry,f.receipt.block,anchors[1-i])).toThrow('synthetic_transfer_batch_unverified');
   for(const change of[(e:FreshCapturedReceipt)=>e.receipt.logs.pop(),(e:FreshCapturedReceipt)=>e.receipt.logs.reverse(),(e:FreshCapturedReceipt)=>{e.transaction.input=String(e.transaction.input)+'00';},(e:FreshCapturedReceipt)=>{e.receipt.logs[0].address=audits[1-i].token;}]){const e=structuredClone(f.receipt.entry);change(e);expect(()=>decodeFreshSyntheticTransferBatch(e,f.receipt.block,anchors[i])).toThrow('synthetic_transfer_batch_unverified');}
   const row={token_address:a.token,protocol:'evm_creation',status:'eligible',log_index:null,block_number:a.creationBlock,block_hash:a.creationHash,tx_hash:a.creationTx,launched_at:a.creationTime,proof:{creator:a.creator,creation:'top_level',syntheticTransferBatch:anchors[i]},canonical_hash:a.creationHash,earliest_header:'129180844'};
   const db=(r:unknown)=>({query:async()=>({rows:[r]})})as any;expect(await readFreshSyntheticBatchAnchor(db(row),a.token)).toEqual(anchors[i]);expect(await readFreshSyntheticBatchAnchor(db({...row,canonical_hash:'0x'+'1'.repeat(64)}),a.token)).toBeNull();expect(await readFreshSyntheticBatchAnchor(db({...row,proof:{...row.proof,syntheticTransferBatch:anchors[1-i]}}),a.token)).toBeNull();
  }
 });
});
