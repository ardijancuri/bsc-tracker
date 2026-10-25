import{describe,it,expect,vi}from'vitest';
import{readFileSync}from'node:fs';import{gunzipSync}from'node:zlib';
import{FOUR_MANAGERS,WBNB}from'../launchpad.js';
import{fourMarketAbi}from'../nodeMarketProtocols.js';
import{transferTopic}from'../swap.js';
import{beforeExecutionTopic}from'../smartAccountTrades.js';
import{FRESH_BNCB_QUOTE}from'./currentBncbQuote.js';
import{freshNativeQuoteChange,valueFreshNativeQuoteChange}from'./nativeQuoteChange.js';
import{normalizeFreshReceipt,type FreshDecodeServices}from'./decode.js';
import{validateFreshTrace}from'./trace.js';
import type{FreshCapturedReceipt,FreshLog}from'./capture.js';
import type{FreshHistoricalPoolNativeQuote}from'./historicalPoolQuote.js';
const addr=(digit:string)=>'0x'+digit.repeat(40),hash=(digit:string)=>'0x'+digit.repeat(64),word=(value:string|bigint)=>typeof value==='bigint'?value.toString(16).padStart(64,'0'):value.slice(2).padStart(64,'0');
const wallet=addr('1'),token=addr('2'),pool=addr('3'),other=addr('4'),controller=FOUR_MANAGERS[1],router='0x1de460f363af910f51726def188f9004276bf4bc';
const block={number:10000,hash:hash('a'),timestamp:'2026-10-23T20:00:00.000Z'};
const transfer=(asset:string,from:string,to:string,raw:bigint,index:number):FreshLog=>({address:asset,topics:[transferTopic,'0x'+word(from),'0x'+word(to)],data:'0x'+word(raw),
 blockNumber:'0x2710',blockHash:block.hash,transactionHash:hash('b'),transactionIndex:'0x1',logIndex:'0x'+index.toString(16)});
function fixture():FreshCapturedReceipt{
 const event=fourMarketAbi.encodeEventLog(fourMarketAbi.getEvent('TokenPurchase')!,[token,wallet,1n,500n,93n,1n,1n,1n]);
 return{transaction:{hash:hash('b'),from:wallet,to:router,value:'0xde0b6b3a7640000',input:'0x1234',type:'0x2',gasPrice:'0x3b9aca00',blockHash:block.hash,blockNumber:'0x2710',transactionIndex:'0x1'},
  receipt:{transactionHash:hash('b'),status:'0x1',gasUsed:'0x5208',effectiveGasPrice:'0x3b9aca00',blockHash:block.hash,blockNumber:'0x2710',transactionIndex:'0x1',logs:[
   transfer(FRESH_BNCB_QUOTE,pool,router,100n,1),transfer(FRESH_BNCB_QUOTE,router,controller,93n,2),transfer(token,controller,wallet,500n,3),
   {...transfer(token,controller,wallet,0n,4),address:controller,topics:event.topics,data:event.data},transfer(FRESH_BNCB_QUOTE,router,wallet,7n,5)]},
  wallets:[wallet],observedAt:block.timestamp,trace:{type:'CALL',from:wallet,to:router,value:'0xde0b6b3a7640000',input:'0x1234',calls:[
   {type:'CALL',from:pool,to:FRESH_BNCB_QUOTE,input:'0xa9059cbb'+word(router)+word(100n),output:'0x'+word(1n)},
   {type:'STATICCALL',from:router,to:FRESH_BNCB_QUOTE,input:'0x70a08231'+word(router),output:'0x'+word(100n)},
   {type:'CALL',from:controller,to:FRESH_BNCB_QUOTE,input:'0x23b872dd'+word(router)+word(controller)+word(93n),output:'0x'+word(1n)},
   {type:'STATICCALL',from:router,to:FRESH_BNCB_QUOTE,input:'0x70a08231'+word(router),output:'0x'+word(7n)},
   {type:'CALL',from:router,to:FRESH_BNCB_QUOTE,input:'0xa9059cbb'+word(wallet)+word(7n),output:'0x'+word(1n)}]}};
}
const payment=(entry=fixture())=>freshNativeQuoteChange(entry,block,token,wallet,500n);
const conversion=()=>({version:1,kind:'historical_raw_pool_native_v2',quoteAddress:FRESH_BNCB_QUOTE,target:block,transactionIndex:1,observation:'before_execution',nativeRaw:'1000000000000000000',quoteRaw:'1000'})as FreshHistoricalPoolNativeQuote;
function services(entry:FreshCapturedReceipt):FreshDecodeServices{
 return{metadata:async address=>({address,name:'Fixture',symbol:'F',decimals:18,supplyRaw:'1000000000000000000000000',block}),knownLaunch:async address=>address===token,eligible:async()=>true,
  priceUsd:async address=>address===WBNB?'700':null,nativeQuoteChangeUsd:async(t,w,raw,price)=>{const p=freshNativeQuoteChange(entry,block,t,w,raw);return p&&price?valueFreshNativeQuoteChange(p,conversion(),price)?.amountUsd??null:null;}};
}
describe('native purchase with genuine BNCB change',()=>{
 it('authenticates four retained 9689-router purchases through their complete original calldata, receipts and traces',()=>{
  const samples=JSON.parse(gunzipSync(readFileSync(new URL('./fixtures/native-bncb-change-9689.json.gz',import.meta.url))).toString())as{block:typeof block;entry:FreshCapturedReceipt;token:string;wallet:string;targetRaw:string;acquiredRaw:string;spentRaw:string;changeRaw:string}[];
  expect(samples).toHaveLength(4);
  for(const s of samples){
   expect(s.entry.transaction.to).toBe('0x9689992f5b5c09447f15906d8d11214944488341');
   const prove=(e:FreshCapturedReceipt)=>freshNativeQuoteChange(e,s.block,s.token,s.wallet,BigInt(s.targetRaw)),p=prove(s.entry);
   expect(p).toMatchObject({transactionHash:s.entry.transaction.hash,blockHash:s.block.hash,walletAddress:s.wallet,tokenAddress:s.token,tokenRaw:s.targetRaw,acquiredQuoteRaw:s.acquiredRaw,spentQuoteRaw:s.spentRaw,changeRaw:s.changeRaw});
   expect(BigInt(p!.acquiredQuoteRaw)).toBe(BigInt(p!.spentQuoteRaw)+BigInt(p!.changeRaw));
   const at=(e:FreshCapturedReceipt,path:number[])=>path.reduce((c,index)=>c.calls![index],e.trace!);
   const altered=structuredClone(s.entry);at(altered,p!.calls.payment).input='0x23b872dd'+word(s.entry.transaction.to!)+word(p!.controller)+word(BigInt(s.spentRaw)-1n);expect(prove(altered)).toBeNull();
   const wrongBalance=structuredClone(s.entry);at(wrongBalance,p!.calls.afterPaymentBalance).output='0x'+word(BigInt(s.changeRaw)+1n);expect(prove(wrongBalance)).toBeNull();
   const ambiguous=structuredClone(s.entry);ambiguous.trace!.calls!.push(structuredClone(at(ambiguous,p!.calls.beforePaymentBalance)));expect(prove(ambiguous)).toBeNull();
   const authorized=structuredClone(s.entry);authorized.transaction.authorizationList=[];expect(prove(authorized)).toBeNull();
   const missingTrace=structuredClone(s.entry);delete missingTrace.trace;expect(prove(missingTrace)).toBeNull();
  }
 });
 it('proves acquisition, controller payment, balances and exact change before valuing the native purchase',()=>{
  const p=payment();expect(p).toMatchObject({nativeSpentWei:'1000000000000000000',gasFeeWei:'21000000000000',acquiredQuoteRaw:'100',spentQuoteRaw:'93',changeRaw:'7',tokenRaw:'500',quoteTransferLogIndices:[1,2,5]});
  expect(valueFreshNativeQuoteChange(p!,conversion(),'700')).toMatchObject({grossNativeUsd:'700',changeUsd:'4.9',amountUsd:'695.1',amountQ:'6951/10'});
 });
 it('retains every raw change unit and subtracts it before decimal formatting',()=>{
  const p=payment()!,c=conversion();c.quoteRaw='1000000000000000000000000';
  const value=valueFreshNativeQuoteChange(p,c,'700')!;expect(value.changeUsd).toBe('0.0000000000000000000049');expect(value.amountUsd).toBe('699.9999999999999999999951');expect(value.changeQ).not.toBe('0');
 });
 it('rejects incomplete calldata-free older projections until their authentic trace is rehydrated',()=>{
  const e=fixture();delete e.trace!.input;e.trace!.calls!.forEach(call=>{delete call.input;delete call.output;});expect(payment(e)).toBeNull();
 });
 it('rejects self calls, authorization, AA, unsupported routers and unmonitored origins',()=>{
  for(const patch of[{to:wallet},{type:'0x4'},{authorizationList:[]},{to:other},{from:other}]){const e=fixture();Object.assign(e.transaction,patch);expect(payment(e)).toBeNull();}
  const e=fixture();e.receipt.logs.push({...transfer(token,controller,wallet,0n,6),topics:[beforeExecutionTopic],data:'0x'});expect(payment(e)).toBeNull();
 });
 it('does not confuse another incoming asset, quote sender or target quantity with change',()=>{
  const e=fixture();e.receipt.logs[4]=transfer(FRESH_BNCB_QUOTE,other,wallet,7n,5);expect(payment(e)).toBeNull();
  const f=fixture();f.receipt.logs.push(transfer(other,pool,wallet,1n,6));expect(payment(f)).toBeNull();
  expect(freshNativeQuoteChange(fixture(),block,token,wallet,501n)).toBeNull();
 });
 it('requires the quote ledger to reconcile and the full transfer calldata/output to agree',()=>{
  for(const mutation of[(e:FreshCapturedReceipt)=>{e.receipt.logs[0].data='0x'+word(99n);},(e:FreshCapturedReceipt)=>{e.trace!.calls![2].input='0x23b872dd'+word(router)+word(controller)+word(92n);},
   (e:FreshCapturedReceipt)=>{e.trace!.calls![4].output='0x'+word(0n);},(e:FreshCapturedReceipt)=>{e.trace!.calls![3].output='0x'+word(8n);}]){const e=fixture();mutation(e);expect(payment(e)).toBeNull();}
 });
 it('rejects duplicated or reverted change calls and wallet-executed child operations',()=>{
  const e=fixture();e.trace!.calls!.push(structuredClone(e.trace!.calls![4]));expect(payment(e)).toBeNull();
  const f=fixture();f.trace!.calls![4].error='execution reverted';expect(payment(f)).toBeNull();
  const g=fixture();g.trace!.calls!.push({type:'CALL',from:wallet,to:other,value:'0x1'});expect(payment(g)).toBeNull();
 });
 it('rejects extra controller trades even when their other recipient is outside this wallet',()=>{
  const e=fixture(),action=fourMarketAbi.encodeEventLog(fourMarketAbi.getEvent('TokenPurchase')!,[other,pool,1n,10n,1n,0n,1n,1n]);
  for(const emitter of FOUR_MANAGERS){const f=structuredClone(e);f.receipt.logs.push({...transfer(other,controller,pool,0n,6),address:emitter,topics:action.topics,data:action.data});expect(payment(f)).toBeNull();}
  e.receipt.logs.push({...transfer(other,controller,pool,0n,6),address:FOUR_MANAGERS[0],topics:action.topics,data:'0x'});expect(payment(e)).toBeNull();
 });
 it('requires the fixed BNCB contract true return instead of accepting missing transfer returndata',()=>{
  for(const output of[undefined,'0x','0x'+word(0n)]){const e=fixture();e.trace!.calls![4].output=output;expect(payment(e)).toBeNull();}
 });
 it('rejects incomplete successful frames and unknown trace opcodes',()=>{
  const e=fixture();e.trace!.calls!.push({type:'CALL',from:router,value:'0x1'});expect(payment(e)).toBeNull();
  const f=fixture();f.trace!.calls!.push({type:'UNSUPPORTED',from:router,to:wallet,value:'0x1'});expect(payment(f)).toBeNull();
 });
 it('rejects noncanonical/malformed receipt identities and failed transactions',()=>{
  for(const patch of[{status:'0x0'},{blockHash:hash('c')},{transactionIndex:'0x2'}]){const e=fixture();Object.assign(e.receipt,patch);expect(payment(e)).toBeNull();}
  const e=fixture();e.receipt.logs[2].removed=true;expect(payment(e)).toBeNull();
 });
 it('does not substitute block-end or another quote conversion, unknown price or excessive marked change',()=>{
  const p=payment()!;
  for(const patch of[{observation:'block_end'},{quoteAddress:other},{transactionIndex:2},{target:{...block,hash:hash('c')}},{nativeRaw:'1000000000000000000000'}])expect(valueFreshNativeQuoteChange(p,{...conversion(),...patch}as FreshHistoricalPoolNativeQuote,'700')).toBeNull();
  for(const price of['0','-1','unknown'])expect(valueFreshNativeQuoteChange(p,conversion(),price)).toBeNull();
 });
 it('uses the new value on the original buy fact and charges wallet gas exactly once',async()=>{
  const e=fixture(),decoded=await normalizeFreshReceipt(e,{number:'0x2710',hash:block.hash,timestamp:'0x'+Math.floor(Date.parse(block.timestamp)/1000).toString(16)},services(e));
  expect(decoded.reasons).toEqual([]);expect(decoded.events).toHaveLength(1);expect(decoded.events[0]).toMatchObject({kind:'buy',amountUsd:'695.1',feeUsd:'0.0147'});
 });
 it('keeps unknown additional fees explicit instead of approving P&L because the purchase value is known',async()=>{
  const e=fixture(),s=services(e);s.additionalNativeFeeWei=async()=>null;
  const decoded=await normalizeFreshReceipt(e,{number:'0x2710',hash:block.hash,timestamp:'0x'+Math.floor(Date.parse(block.timestamp)/1000).toString(16)},s);
  expect(decoded.events[0]).toMatchObject({amountUsd:'695.1',feeUsd:null});expect(decoded.reasons).toContain('native_message_fee_unverified');
 });
 it('does not call the adapter to allocate shared native input across multiple eligible targets',async()=>{
  const e=fixture(),s=services(e),fn=vi.fn(s.nativeQuoteChangeUsd);e.receipt.logs.push(transfer(other,controller,wallet,1n,6));s.knownLaunch=async address=>[token,other].includes(address);s.nativeQuoteChangeUsd=fn;
  const decoded=await normalizeFreshReceipt(e,{number:'0x2710',hash:block.hash,timestamp:'0x'+Math.floor(Date.parse(block.timestamp)/1000).toString(16)},s);
  expect(fn).not.toHaveBeenCalled();expect(decoded.reasons).toContain('shared_quote_allocation_unknown');
 });
});

describe('bounded optional calldata in future trace capture',()=>{
 it('keeps old projections compatible and retains new input/output without changing native deltas',()=>{
  expect(validateFreshTrace({type:'CALL',from:wallet,to:router,value:'0x1'})).toEqual({type:'CALL',from:wallet,to:router,value:'0x1'});
  expect(validateFreshTrace(fixture().trace)).toEqual(fixture().trace);
 });
 it('rejects malformed, excessive and aggregate-over-budget trace data',()=>{
  for(const value of[null,true,'0x1','not bytes','0x'+'00'.repeat(128*1024+1)])expect(()=>validateFreshTrace({type:'CALL',from:wallet,input:value})).toThrow('trace_data_bounds_invalid');
  expect(()=>validateFreshTrace({type:'CALL',from:wallet,error:true})).toThrow('trace_bounds_invalid');
  expect(()=>validateFreshTrace({type:'CALL',from:wallet,calls:Array.from({length:17},()=>({type:'CALL',from:wallet,input:'0x'+'00'.repeat(128*1024)}))})).toThrow('trace_data_bounds_invalid');
 });
});
