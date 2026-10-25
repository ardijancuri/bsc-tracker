import{describe,it,expect,vi}from'vitest';import{Interface}from'ethers';
import{TRUSTED_QUOTE_FEEDS}from'../nodeMarketProtocols.js';import{WBNB}from'../launchpad.js';import{transferTopic}from'../swap.js';
import{FRESH_NATIVE_SETTLEMENT_SYMBOLS,isFreshSettlementQuote,freshSettlementQuoteSymbol}from'./settlementQuote.js';
import{freshQuotePayment}from'./quotePayment.js';import{normalizeFreshReceipt,type FreshDecodeServices}from'./decode.js';import type{FreshCapturedReceipt,FreshLog}from'./capture.js';
import{beforeExecutionTopic,userOperationTopic}from'../smartAccountTrades.js';
const wallet='0x'+'1'.repeat(40),token='0x'+'2'.repeat(40),router='0x'+'3'.repeat(40),other='0x'+'4'.repeat(40),hash='0x'+'a'.repeat(64),txHash='0x'+'b'.repeat(64),quote='0xbe9d156892e55e7154bcd3cb0fea677f9d3103e1';
const block={number:10000,hash,timestamp:'2026-10-25T02:42:17.000Z'},word=(v:string|bigint)=>typeof v==='bigint'?v.toString(16).padStart(64,'0'):v.slice(2).padStart(64,'0');
const transfer=(asset:string,from:string,to:string,amount:bigint,index:number):FreshLog=>({address:asset,topics:[transferTopic,'0x'+word(from),'0x'+word(to)],data:'0x'+word(amount),blockNumber:'0x2710',blockHash:hash,transactionHash:txHash,transactionIndex:'0x1',logIndex:'0x'+index.toString(16)});
function fixture(asset=quote):FreshCapturedReceipt{const swap=new Interface(['event Swap(address indexed sender,uint256 amount0In,uint256 amount1In,uint256 amount0Out,uint256 amount1Out,address indexed to)']),s=swap.encodeEventLog('Swap',[router,100n,0n,0n,500n,wallet]);return{
 transaction:{hash:txHash,from:wallet,to:router,value:'0x0',type:'0x2',gasPrice:'0x3b9aca00',blockNumber:'0x2710',blockHash:hash,transactionIndex:'0x1'},
 receipt:{transactionHash:txHash,blockNumber:'0x2710',blockHash:hash,transactionIndex:'0x1',status:'0x1',gasUsed:'0x186a0',effectiveGasPrice:'0x3b9aca00',logs:[transfer(asset,wallet,router,100n*10n**18n,1),transfer(token,router,wallet,500n*10n**18n,2),{...transfer(token,router,wallet,0n,3),address:router,topics:s.topics,data:s.data}]},wallets:[wallet],observedAt:block.timestamp,
 stateEvidence:{version:1,blockNumber:block.number,blockHash:hash,calls:[{to:asset,data:'0x313ce567',result:'0x'+word(18n)}]}};}
const targetRaw=500n*10n**18n,payment=(e:FreshCapturedReceipt)=>freshQuotePayment(e,block,token,wallet,targetRaw);
describe('explicit non-feed settlement quote assets',()=>{
 it.each(Object.entries(FRESH_NATIVE_SETTLEMENT_SYMBOLS))('recognizes %s without inventing a trusted dollar feed',(address,symbol)=>{expect(isFreshSettlementQuote(address)).toBe(true);expect(freshSettlementQuoteSymbol(address)).toBe(symbol);expect(TRUSTED_QUOTE_FEEDS[address]).toBeUndefined();expect(payment(fixture(address))?.quoteRaw).toBe('100000000000000000000');});
 it('does not accept arbitrary symbols, inherited properties or addresses as quote evidence',()=>{for(const asset of[other,'toString','__proto__','SPCXB']){expect(isFreshSettlementQuote(asset)).toBe(false);expect(freshSettlementQuoteSymbol(asset)).toBeNull();}expect(payment(fixture(other))).toBeNull();});
 it('preserves same-route refunds and gas exactly once',()=>{const e=fixture();e.receipt.logs.push(transfer(quote,router,wallet,7n*10n**18n,4));expect(payment(e)).toMatchObject({quoteRaw:'93000000000000000000',gasFeeWei:'100000000000000'});});
 it.each(['native','wrong_quote','wrong_block','unrelated_refund'])('rejects %s settlement conflicts',kind=>{const e=fixture();if(kind==='native')e.transaction.value='0x1';if(kind==='wrong_quote')e.receipt.logs[0].address=other;if(kind==='wrong_block')e.receipt.blockHash='0x'+'f'.repeat(64);if(kind==='unrelated_refund')e.receipt.logs.push(transfer(quote,other,wallet,1n,4));expect(payment(e)).toBeNull();});
 it('rejects signed authorization/AA routes and additional wallet assets',()=>{for(const patch of[{type:'0x4'},{authorizationList:[]},{to:wallet}]){const e=fixture();Object.assign(e.transaction,patch);expect(payment(e)).toBeNull();}for(const topic of[beforeExecutionTopic,userOperationTopic]){const e=fixture();e.receipt.logs.push({...transfer(token,router,wallet,0n,4),topics:[topic],data:'0x'});expect(payment(e)).toBeNull();}const e=fixture();e.receipt.logs.push(transfer(other,router,wallet,1n,4));expect(payment(e)).toBeNull();});
 it.each([null,'52.125'])('keeps unknown or authenticated historical conversion %s distinct from current prices',async value=>{
  const e=fixture(),readQuotePrice=vi.fn(async()=>{throw Error('current_quote_price_forbidden');}),readQuoteMetadata=vi.fn(async()=>{throw Error('fresh_quote_metadata_unneeded');}),route=vi.fn(async(_token:string,_wallet:string,_raw:bigint,_native:string|null,retainedOnly=false)=>retainedOnly?null:value);
  const services:FreshDecodeServices={metadata:async address=>address===token?{address,name:'Token',symbol:'MEME',decimals:18,supplyRaw:null,block}:value===null?{address,decimals:18,name:null,symbol:null,supplyRaw:null,block}:readQuoteMetadata(),knownLaunch:async address=>address===token,eligible:async m=>m.address===token,
   priceUsd:async address=>address===WBNB?'600':readQuotePrice(),quotePaymentUsd:route,trace:async()=>null};
  const result=await normalizeFreshReceipt(e,{number:'0x2710',hash,timestamp:'0x'+(Date.parse(block.timestamp)/1000).toString(16)},services);
  expect(result.events).toHaveLength(1);expect(result.events[0]).toMatchObject({amountUsd:value,quoteAddress:quote,quoteSymbol:'SPCXB',quoteAmount:'100',quantity:'500',feeUsd:'0.06'});
  expect(readQuotePrice).not.toHaveBeenCalled();expect(readQuoteMetadata).not.toHaveBeenCalled();expect(route.mock.calls.filter(c=>!c[4])).toHaveLength(1);
  expect(result.reasons.includes('trade_value_unavailable')).toBe(value===null);
 });
});
