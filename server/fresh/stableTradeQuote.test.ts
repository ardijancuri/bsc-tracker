import{describe,it,expect}from'vitest';
import{Interface}from'ethers';
import{normalizeFreshReceipt,recoverFreshRetainedStableTradeQuote}from'./decode.js';
import{transferTopic}from'../swap.js';
import{WBNB}from'../launchpad.js';
import type{FreshCapturedReceipt,FreshLog}from'./capture.js';
const wallet='0x'+'1'.repeat(40),router='0x'+'2'.repeat(40),token='0x'+'7'.repeat(40),hash='0x'+'a'.repeat(64),tx='0x'+'b'.repeat(64);
const block={number:101,hash,timestamp:'2026-10-24T00:00:00.000Z'},word=(s:string)=>s.slice(2).padStart(64,'0');
const swap=new Interface(['event Swap(address indexed sender,uint256 amount0In,uint256 amount1In,uint256 amount0Out,uint256 amount1Out,address indexed to)']);
async function fixture(asset:string,side:'buy'|'sell',decimals:number){
 const log=(address:string,topics:string[],data:string,index:number):FreshLog=>({address,topics,data,logIndex:'0x'+index.toString(16),transactionHash:tx,transactionIndex:'0x0',blockNumber:'0x65',blockHash:hash});
 const move=(address:string,from:string,to:string,raw:bigint,index:number)=>log(address,[transferTopic,'0x'+word(from),'0x'+word(to)],'0x'+raw.toString(16).padStart(64,'0'),index);
 const quote=25n*10n**BigInt(decimals),target=10n**18n,s=swap.encodeEventLog('Swap',[router,quote,0,0,target,wallet]);
 const logs=side==='buy'?[move(asset,wallet,router,quote,0),move(token,router,wallet,target,1)]:[move(token,wallet,router,target,0),move(asset,router,wallet,quote,1)];logs.push(log(router,s.topics,s.data,2));
 const entry:FreshCapturedReceipt={transaction:{hash:tx,from:wallet,to:router,value:'0x0',blockHash:hash,blockNumber:'0x65',transactionIndex:'0x0',type:'0x2',input:'0x12345678',gasPrice:'0x1'},receipt:{transactionHash:tx,transactionIndex:'0x0',blockHash:hash,blockNumber:'0x65',status:'0x1',gasUsed:'0x100',effectiveGasPrice:'0x1',logs},wallets:[wallet],observedAt:block.timestamp};
 const services={metadata:async(address:string)=>({address,decimals:address===asset?decimals:18,name:'Fixture',symbol:'Fixture',supplyRaw:null,block}),eligible:async(v:{address:string})=>v.address===token,priceUsd:async(address:string)=>address===WBNB?'500':'0.9995'};
 const decoded=await normalizeFreshReceipt(entry,{number:'0x65',hash,timestamp:'0x'+Math.floor(Date.parse(block.timestamp)/1000).toString(16)},services);
 const {quoteAddress,quoteSymbol,quoteAmount,...event}=decoded.events[0];
 return{entry,event,decoded,services,precision:{address:asset,decimals,blockNumber:block.number,blockHash:hash}};
}
describe('all stable-quote trade display enrichment',()=>{
 it.each([['USDC','0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d'],['USDT','0x55d398326f99059ff775485246999027b3197955']])('handles %s buys and sells with dated BNB rates and original settlement units',async(symbol,asset)=>{
  for(const side of['buy','sell']as const)for(const decimals of[6,18]){
   const f=await fixture(asset,side,decimals),recovered=recoverFreshRetainedStableTradeQuote(f.entry,block,f.event,f.precision)!;
   expect(recovered).toMatchObject({...f.event,quoteAddress:asset,quoteSymbol:symbol,quoteAmount:'25'});
   expect(f.decoded.tradeBnbPrices).toEqual({[f.event.id]:'500'});
   const {quoteAddress,quoteSymbol,quoteAmount,...original}=recovered;expect(original).toEqual(f.event);
  }
 });
 it('rejects wrong block, asset, quantity, execution and duplicate or conflicting settlement evidence',async()=>{
  const f=await fixture('0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d','buy',18);
  for(const p of[{...f.precision,blockNumber:102},{...f.precision,blockHash:tx},{...f.precision,address:token},{...f.precision,decimals:-1}])expect(recoverFreshRetainedStableTradeQuote(f.entry,block,f.event,p)).toBeNull();
  for(const e of[{...f.event,quantity:'3'},{...f.event,executionIndex:1},{...f.event,canonical:false},{...f.event,id:'other'},{...f.event,quoteAddress:f.precision.address,quoteSymbol:'USDC',quoteAmount:'26'}])expect(recoverFreshRetainedStableTradeQuote(f.entry,block,e,f.precision)).toBeNull();
  const altered=structuredClone(f.entry);altered.receipt.logs[0].transactionHash=hash;expect(recoverFreshRetainedStableTradeQuote(altered,block,f.event,f.precision)).toBeNull();
 });
 it('retains financial valuation when an optional BNB display price is unavailable',async()=>{
  const f=await fixture('0x55d398326f99059ff775485246999027b3197955','sell',18);
  const result=await normalizeFreshReceipt(f.entry,{number:'0x65',hash,timestamp:'0x'+Math.floor(Date.parse(block.timestamp)/1000).toString(16)},{...f.services,priceUsd:async a=>a===WBNB?null:'0.9995'});
  expect(result.events[0].amountUsd).toBe('24.9875');expect(result.tradeBnbPrices).toBeUndefined();
 });
 it.each(['0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d','0x55d398326f99059ff775485246999027b3197955'])('retains optional exact-block imported quote precision for future %s trades without new metadata requests',async asset=>{
  const f=await fixture(asset,'buy',18);let quoteMetadataCalls=0,retainedCalls=0;
  const result=await normalizeFreshReceipt(f.entry,{number:'0x65',hash,timestamp:'0x'+Math.floor(Date.parse(block.timestamp)/1000).toString(16)},{...f.services,
   metadata:async address=>{if(address===asset){quoteMetadataCalls++;throw Error('must_not_start_new_historical_read');}return f.services.metadata(address);},
   quotePaymentUsd:async()=> '24.9875',retainedQuoteMetadata:async address=>{retainedCalls++;expect(address).toBe(asset);return{decimals:18};}});
  expect(result.events[0].quoteAmount).toBe('25');expect(result.events[0].amountUsd).toBe('24.9875');expect(result.tradeBnbPrices).toEqual({[result.events[0].id]:'500'});
  expect(quoteMetadataCalls).toBe(0);expect(retainedCalls).toBe(1);
 });
});
