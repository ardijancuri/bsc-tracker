import{readFileSync}from'node:fs';import{gunzipSync}from'node:zlib';import{AbiCoder,Interface,keccak256}from'ethers';import{describe,it,expect,vi}from'vitest';
import{classifyFreshSyntheticBatchCreation,decodeFreshSyntheticTransferBatch,readFreshSyntheticBatchAnchor,isFreshSyntheticBatchCandidate,FRESH_POP_SYNTHETIC_BATCH_ANCHOR as anchor,FRESH_POP_SYNTHETIC_BATCH_AUDIT as audit,FRESH_SYNTHETIC_BATCH_ANCHOR as otherAnchor}from'./syntheticTransferBatch.js';
import{executeSyntheticAudit}from'./syntheticBatchEvm.fixture.js';import{normalizeFreshReceipt,type FreshDecodeServices}from'./decode.js';import type{FreshCapturedReceipt,FreshBlock}from'./capture.js';import{WBNB}from'../launchpad.js';
const fixture=()=>JSON.parse(gunzipSync(readFileSync(new URL('./fixtures/pop-synthetic-transfer-batch.json.gz',import.meta.url))).toString())as{creation:{transaction:FreshCapturedReceipt['transaction'];receipt:FreshCapturedReceipt['receipt'];block:FreshBlock};runtime:string;receipts:{entry:FreshCapturedReceipt;block:FreshBlock}[]};
const abi=new Interface(['function transfer(address,uint256)returns(bool)','function balanceOf(address)view returns(uint256)']),coder=AbiCoder.defaultAbiCoder(),other='0x'+'1'.repeat(40),word=(a:string)=>'0x'+'0'.repeat(24)+a.slice(2);
const services=(extra:Partial<FreshDecodeServices>={}):FreshDecodeServices=>({metadata:vi.fn(async()=>null),eligible:vi.fn(async()=>true),knownLaunch:async()=>true,priceUsd:async token=>token===WBNB?'700':null,syntheticBatchAnchor:async token=>token===audit.token?anchor:null,...extra});
const fact=()=>({token_address:audit.token,protocol:'evm_creation',status:'eligible',log_index:null,block_number:String(audit.creationBlock),block_hash:audit.creationHash,tx_hash:audit.creationTx,launched_at:audit.creationTime,proof:{creator:audit.creator,creation:'top_level',syntheticTransferBatch:anchor},canonical_hash:audit.creationHash,earliest_header:'129180844'});

describe('individually authenticated POP synthetic batch execution',()=>{
 it('executes the full original constructor and reproduces the exact 3662-byte runtime and seven immutable patches',()=>{
  const f=fixture(),x=executeSyntheticAudit(f.creation.transaction.input as string,{address:audit.token,caller:audit.creator,timestamp:BigInt(f.creation.block.timestamp)}),copy=x.copies.find(c=>c.source===audit.constructorBytes)!;
  expect(x.status).toBe('return');expect(x.runtime.toString('hex')).toBe(f.runtime.slice(2));expect(x.returnPc).toBe(1860);expect(copy.length).toBe(audit.runtimeBytes);expect(x.calls).toEqual([]);
  expect(x.stores.filter(s=>s.step>copy.step).map(s=>s.offset)).toEqual([1373,1547,2621,835,1120,1187,1641]);expect(keccak256(x.runtime)).toBe(audit.runtimeHash);expect(classifyFreshSyntheticBatchCreation(f.creation,f.runtime)).toEqual(anchor);
 });
 it('reproduces all five actual batches and every 9188 original log with no ledger write or external call',async()=>{
  const f=fixture(),birth=executeSyntheticAudit(f.creation.transaction.input as string,{address:audit.token,caller:audit.creator});let n=0;
  for(const{entry,block}of f.receipts){const before=JSON.stringify(entry),x=executeSyntheticAudit(f.runtime,{address:audit.token,caller:entry.transaction.from,storage:birth.storage,calldata:entry.transaction.input as string,timestamp:BigInt(block.timestamp)});
   expect(x.status).toBe('stop');expect(x.writes).toEqual([]);expect(x.calls).toEqual([]);expect(x.storage).toEqual(birth.storage);expect(x.logs.map(l=>({topics:l.topics,data:l.data}))).toEqual(entry.receipt.logs.map(l=>({topics:l.topics,data:l.data})));
   const p=decodeFreshSyntheticTransferBatch(entry,block,anchor)!;expect(p.creation).toEqual(anchor);expect(p.recipients).toBe(entry.receipt.logs.length);expect(p.amountRaw).toBe('5000000000000000000');
   const s=services(),out=await normalizeFreshReceipt(entry,block,s);expect(out.events).toEqual([]);expect(out.reasons).toEqual([]);expect(s.metadata).not.toHaveBeenCalled();expect(JSON.stringify(entry)).toBe(before);n+=p.recipients;
  }expect(n).toBe(9188);
 },15000);
 it('rejects altered birth, full initcode/runtime, parent, sender or delegation context',()=>{
  const mutations:((f:ReturnType<typeof fixture>)=>void)[]=[f=>{f.creation.transaction.input=String(f.creation.transaction.input).slice(0,-2)+'ff';},f=>{f.runtime=f.runtime.slice(0,-2)+'ff';},f=>{f.creation.block.parentHash='0x'+'1'.repeat(64);},f=>{f.creation.transaction.from=other;},f=>{f.creation.transaction.authorizationList=[];}];
  for(const mutate of mutations){const f=fixture();mutate(f);expect(classifyFreshSyntheticBatchCreation(f.creation,f.runtime)).toBeNull();}
 });
 it('does not approve the old audited contract marker, an absent birth, or noncanonical POP birth',async()=>{
  const f=fixture().receipts[0];expect(()=>decodeFreshSyntheticTransferBatch(f.entry,f.block,otherAnchor)).toThrow('synthetic_transfer_batch_unverified');
  await expect(normalizeFreshReceipt(f.entry,f.block,services({syntheticBatchAnchor:async()=>null}))).rejects.toThrow('synthetic_transfer_batch_unverified');
  const db=(row:unknown)=>({query:vi.fn(async()=>({rows:row?[row]:[]}))})as any;
  expect(await readFreshSyntheticBatchAnchor(db(fact()),audit.token)).toEqual(anchor);
  for(const row of[undefined,{...fact(),canonical_hash:'0x'+'1'.repeat(64)},{...fact(),proof:{...fact().proof,syntheticTransferBatch:otherAnchor}},{...fact(),status:'excluded_non_token'}])expect(await readFreshSyntheticBatchAnchor(db(row),audit.token)).toBeNull();
  expect(await readFreshSyntheticBatchAnchor(db({...fact(),canonical_hash:null,earliest_header:String(audit.creationBlock+1)}),audit.token)).toEqual(anchor);
 });
 it('binds complete canonical calldata and every log, rejecting extra/missing/reordered logs and mixed activity',()=>{
  const f=fixture().receipts[0],mutations:((e:FreshCapturedReceipt)=>void)[]=[e=>{e.receipt.logs.pop();},e=>{e.receipt.logs.reverse();},e=>{e.receipt.logs[0].data='0x'+'0'.repeat(63)+'1';},e=>{e.receipt.logs[0].topics[1]=word(other);},e=>{e.transaction.input=String(e.transaction.input)+'00';},e=>{e.transaction.value='0x1';},e=>{e.transaction.authorizationList=[];},e=>{const args=coder.decode(['address','address[]','uint256','uint256'],'0x'+String(e.transaction.input).slice(10));e.transaction.input=audit.selector+coder.encode(['address','address[]','uint256','uint256'],[other,args[1],args[2],args[3]]).slice(2);}];
  for(const mutate of mutations){const e=structuredClone(f.entry);mutate(e);expect(()=>decodeFreshSyntheticTransferBatch(e,f.block,anchor)).toThrow('synthetic_transfer_batch_unverified');}
  for(const[third,fourth]of[[0n,50n],[109000000000000000000n,0n]]){const e=structuredClone(f.entry),args=coder.decode(['address','address[]','uint256','uint256'],'0x'+String(e.transaction.input).slice(10));e.transaction.input=audit.selector+coder.encode(['address','address[]','uint256','uint256'],[audit.token,args[1],third,fourth]).slice(2);expect(()=>decodeFreshSyntheticTransferBatch(e,f.block,anchor)).toThrow('synthetic_transfer_batch_unverified');}
 });
 it('retains the same contract’s real ERC20 storage-changing transfer path and normal economic interpretation',async()=>{
  const f=fixture(),birth=executeSyntheticAudit(f.creation.transaction.input as string,{address:audit.token,caller:audit.creator}),recipient=other,amount=3000000000000000000n;
  const x=executeSyntheticAudit(f.runtime,{address:audit.token,caller:audit.creator,storage:birth.storage,calldata:abi.encodeFunctionData('transfer',[recipient,amount])});expect(x.status).toBe('return');expect(x.writes).toHaveLength(2);expect(x.logs).toHaveLength(1);expect(x.calls).toEqual([]);
  const{entry,block}=structuredClone(f.receipts[0]);entry.wallets=[audit.creator];entry.transaction.from=audit.creator;entry.transaction.input=abi.encodeFunctionData('transfer',[recipient,amount]);entry.receipt.logs=[{...entry.receipt.logs[0],topics:[entry.receipt.logs[0].topics[0],word(audit.creator),word(recipient)],data:'0x'+amount.toString(16).padStart(64,'0')}];
  expect(isFreshSyntheticBatchCandidate(entry)).toBe(false);const s=services({metadata:async address=>({address,decimals:18,name:'PopcatFrog',symbol:'POP',supplyRaw:'1000000000000000000000000000',block:{number:Number(BigInt(block.number)),hash:block.hash,timestamp:new Date(Number(BigInt(block.timestamp))*1000).toISOString()}}),priceUsd:async address=>address===WBNB?'700':'1',syntheticBatchAnchor:vi.fn(async()=>{throw Error('must_not_lookup');})});
  const out=await normalizeFreshReceipt(entry,block,s);expect(out.events.some(e=>e.kind==='transfer_out'&&e.tokenAddress===audit.token&&e.quantity==='3')).toBe(true);expect(s.syntheticBatchAnchor).not.toHaveBeenCalled();
 });
 it('attributes only the actual monitored batch caller gas to the correct POP contract',async()=>{
  const{entry,block}=fixture().receipts[0];entry.wallets=[entry.transaction.from];const out=await normalizeFreshReceipt(entry,block,services());expect(out.events).toHaveLength(1);expect(out.events[0]).toMatchObject({kind:'fee',tokenAddress:null,walletAddress:audit.creator,feeAttribution:{status:'eligible',tokenAddress:audit.token,contract:audit.token,selector:audit.selector}});expect(out.reasons).toEqual([]);
 });
});
