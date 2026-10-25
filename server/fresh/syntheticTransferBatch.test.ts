import{readFileSync}from'node:fs';import{gunzipSync}from'node:zlib';import{AbiCoder,Interface,keccak256}from'ethers';import{describe,it,expect,vi}from'vitest';
import{classifyFreshSyntheticBatchCreation,decodeFreshSyntheticTransferBatch,readFreshSyntheticBatchAnchor,isFreshSyntheticBatchCandidate,FRESH_SYNTHETIC_BATCH_ANCHOR as anchor,FRESH_SYNTHETIC_BATCH_AUDIT as audit}from'./syntheticTransferBatch.js';
import{executeSyntheticAudit}from'./syntheticBatchEvm.fixture.js';import{normalizeFreshReceipt,type FreshDecodeServices}from'./decode.js';import{FreshRational}from'./accounting.js';
import type{FreshCapturedReceipt,FreshBlock}from'./capture.js';import{WBNB}from'../launchpad.js';
const fixture=()=>JSON.parse(gunzipSync(readFileSync(new URL('./fixtures/synthetic-transfer-batch.json.gz',import.meta.url))).toString())as{creation:{transaction:FreshCapturedReceipt['transaction'];receipt:FreshCapturedReceipt['receipt'];block:FreshBlock};runtime:string;receipts:{entry:FreshCapturedReceipt;block:FreshBlock}[]};
const word=(a:string)=>'0x'+'0'.repeat(24)+a.slice(2),other='0x'+'1'.repeat(40),abi=new Interface(['function transfer(address,uint256)','function balanceOf(address)view returns(uint256)']);
function fact(){return{token_address:audit.token,protocol:'evm_creation',status:'eligible',log_index:null,block_number:String(audit.creationBlock),block_hash:audit.creationHash,tx_hash:audit.creationTx,launched_at:audit.creationTime,
 proof:{creator:audit.creator,creation:'top_level',syntheticTransferBatch:anchor},canonical_hash:audit.creationHash,earliest_header:'129180844'};}
function services(extra:Partial<FreshDecodeServices>={}):FreshDecodeServices{return{metadata:vi.fn(async()=>null),eligible:vi.fn(async()=>true),knownLaunch:async()=>true,priceUsd:async token=>token===WBNB?'700':null,syntheticBatchAnchor:async()=>anchor,...extra};}
describe('execution-only authenticated synthetic transfer batches',()=>{
 it('reconstructs the exact canonical constructor runtime and its seven immutable data patches without calls',()=>{
  const f=fixture(),out=executeSyntheticAudit(f.creation.transaction.input as string,{address:audit.token,caller:audit.creator,timestamp:BigInt(f.creation.block.timestamp)});
  expect(out.status).toBe('return');expect(out.runtime.toString('hex')).toBe(f.runtime.slice(2));expect(out.calls).toHaveLength(0);expect(out.returnPc).toBe(0x1878);
  const copy=out.copies.find(c=>c.source===audit.constructorBytes)!;expect(copy.length).toBe(audit.runtimeBytes);expect(out.stores.filter(s=>s.step>copy.step).map(s=>s.offset)).toEqual([0x2797,0x275c,0x2ebb,0x2e9a,0x2514,0x256a,0x2593]);
  expect(out.storage.get(15n)).toBe(3000000000000000000n);expect(keccak256(out.runtime)).toBe(audit.runtimeHash);expect(classifyFreshSyntheticBatchCreation(f.creation,f.runtime)).toEqual(anchor);
 });
 it('rejects changed creation, parent, constructor, runtime, sender, nonzero value or delegated identity',()=>{
  const mutations:((f:ReturnType<typeof fixture>)=>unknown)[]=[f=>f.creation.block.hash='0x'+'1'.repeat(64),f=>f.creation.block.parentHash='0x'+'1'.repeat(64),
   f=>f.creation.transaction.input=String(f.creation.transaction.input).slice(0,-2)+'ff',f=>f.runtime=f.runtime.slice(0,-2)+'ff',f=>f.creation.transaction.from=other,f=>f.creation.transaction.value='0x1',f=>f.creation.transaction.chainId='0x1',f=>f.creation.transaction.authorizationList=[]];
  for(const mutate of mutations){
   const f=fixture();mutate(f);expect(classifyFreshSyntheticBatchCreation(f.creation,f.runtime)).toBeNull();
  }
 });
 it('independently reproduces all15000 actual logs with zero state writes and no calls, including duplicate recipients',async()=>{
  const f=fixture();let logs=0;for(const{entry,block}of f.receipts){const saved=JSON.stringify(entry),out=executeSyntheticAudit(f.runtime,{address:audit.token,caller:entry.transaction.from,calldata:entry.transaction.input as string,storage:new Map([[15n,BigInt(entry.receipt.logs[0].data)]])});
   expect(out.writes).toHaveLength(0);expect(out.calls).toHaveLength(0);expect(out.logs.map(l=>({topics:l.topics,data:l.data}))).toEqual(entry.receipt.logs.map(l=>({topics:l.topics,data:l.data})));
   const proof=decodeFreshSyntheticTransferBatch(entry,block,anchor)!;expect(proof.logIndices).toHaveLength(3000);expect(proof.recipients).toBe(3000);logs+=proof.recipients;
   const s=services(),decoded=await normalizeFreshReceipt(entry,block,s);expect(decoded.events).toEqual([]);expect(decoded.reasons).toEqual([]);expect(s.metadata).not.toHaveBeenCalled();expect(JSON.stringify(entry)).toBe(saved);
  }expect(logs).toBe(15000);
 // This independently interprets five complete 3,000-log EVM executions.
 // Allow CPU contention with local capture without changing any assertions.
 },15_000);
 it('requires the exact audited canonical birth marker, surviving only genuine header expiry',async()=>{
  const db=(row:unknown)=>({query:vi.fn(async()=>({rows:row?[row]:[]}))})as any;
  expect(await readFreshSyntheticBatchAnchor(db(fact()))).toEqual(anchor);
  expect(await readFreshSyntheticBatchAnchor(db({...fact(),canonical_hash:null,earliest_header:String(audit.creationBlock+1)}))).toEqual(anchor);
  for(const row of[undefined,{...fact(),canonical_hash:'0x'+'1'.repeat(64)},{...fact(),canonical_hash:null},{...fact(),status:'excluded_non_token'},
   {...fact(),proof:{...fact().proof,syntheticTransferBatch:{...anchor,runtimeHash:'wrong'}}},{...fact(),tx_hash:'wrong'}])expect(await readFreshSyntheticBatchAnchor(db(row))).toBeNull();
 });
 it('leaves a matching selector with absent/altered proof or incomplete/extra evidence in explicit repair',async()=>{
  const f=fixture(),original=f.receipts[0];
  const mutations:((e:FreshCapturedReceipt)=>unknown)[]=[e=>e.receipt.logs.pop(),e=>e.receipt.logs.reverse(),e=>e.receipt.logs[0].data='0x'+'0'.repeat(63)+'1',
   e=>e.receipt.logs[0].address=other,e=>e.receipt.logs[0].topics[1]=word(other),e=>e.transaction.input=String(e.transaction.input)+'00',e=>e.transaction.authorizationList=[],e=>e.transaction.value='0x1'];
  for(const mutate of mutations){
   const entry=structuredClone(original.entry);mutate(entry);expect(()=>decodeFreshSyntheticTransferBatch(entry,original.block,anchor)).toThrow('synthetic_transfer_batch_unverified');
  }
  await expect(normalizeFreshReceipt(original.entry,original.block,services({syntheticBatchAnchor:async()=>null}))).rejects.toThrow('synthetic_transfer_batch_unverified');
 });
 it('retains the actual monitored caller gas as one eligible fee-only fact without synthetic inventory',async()=>{
  const{entry,block}=fixture().receipts[0];entry.wallets=[entry.transaction.from];const out=await normalizeFreshReceipt(entry,block,services());expect(out.events).toHaveLength(1);const event=out.events[0];
  expect(event).toMatchObject({kind:'fee',tokenAddress:null,quantity:'0',amountUsd:'0',walletAddress:entry.transaction.from,feeAttribution:{status:'eligible',tokenAddress:audit.token,selector:audit.selector}});
  expect(event.feeUsd).toBe(new FreshRational(BigInt(entry.receipt.gasUsed)*BigInt(entry.receipt.effectiveGasPrice??String(entry.transaction.gasPrice)),10n**18n).mul(new FreshRational(700n)).decimal());expect(out.reasons).toEqual([]);
 });
 it('keeps failed batch fee attempts and genuine standard transfers on the same token outside the exclusion',async()=>{
  const f=fixture().receipts[0],failed=structuredClone(f.entry);failed.wallets=[failed.transaction.from];failed.receipt.status='0x0';failed.receipt.logs=[];
  expect(isFreshSyntheticBatchCandidate(failed)).toBe(false);expect((await normalizeFreshReceipt(failed,f.block,services())).events).toEqual([expect.objectContaining({kind:'fee',walletAddress:failed.transaction.from,tokenAddress:null})]);
  const e=structuredClone(f.entry),wallet=e.wallets[0];e.transaction.from=wallet;e.transaction.input=abi.encodeFunctionData('transfer',[other,3000000000000000000n]);e.receipt.logs=[{...e.receipt.logs[0],topics:[e.receipt.logs[0].topics[0],word(wallet),word(other)]}];
  const s=services({metadata:async address=>({address,decimals:18,name:'Real token path',symbol:'REAL',supplyRaw:'1000000000000000000000000',block:{number:Number(BigInt(f.block.number)),hash:f.block.hash,timestamp:new Date(Number(BigInt(f.block.timestamp))*1000).toISOString()}}),priceUsd:async address=>address===WBNB?'700':'1',syntheticBatchAnchor:vi.fn(async()=>{throw Error('must_not_lookup');})});
  const out=await normalizeFreshReceipt(e,f.block,s);expect(out.events.some(v=>v.kind==='transfer_out'&&v.tokenAddress===audit.token&&v.quantity==='3')).toBe(true);expect(s.syntheticBatchAnchor).not.toHaveBeenCalled();
 });
});
