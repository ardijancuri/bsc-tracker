import{readFileSync}from'node:fs';import{gunzipSync}from'node:zlib';
import{describe,it,expect,vi}from'vitest';
import{normalizeFreshReceipt}from'./decode.js';
import{freshSignedBatchNativeBuyPayment}from'./signedBatchPayment.js';
import{FreshRational,applyFreshEvent,validateFreshFinancialEvent}from'./accounting.js';
import{WBNB}from'../launchpad.js';
import type{FreshCapturedReceipt}from'./capture.js';import type{FreshPriceBlock}from'./pricing.js';
const fixtures:{entry:FreshCapturedReceipt;block:FreshPriceBlock;token:string;targetRaw:string}[]=JSON.parse(gunzipSync(readFileSync(new URL('./fixtures/signed-batch-native-buy.json.gz',import.meta.url))).toString());
describe('signed batch expense policy in normal accounting',()=>{
 it.each(fixtures.map((_,index)=>index))('values one buy and charges actual expense plus gas exactly once: fixture %s',async index=>{
  const f=structuredClone(fixtures[index]),wallet=f.entry.transaction.from,raw=BigInt(f.targetRaw),payment=freshSignedBatchNativeBuyPayment(f.entry,f.block,f.token,wallet,raw)!;
  const purchase=vi.fn(async()=> '600'),decoded=await normalizeFreshReceipt(f.entry,{number:'0x'+f.block.number.toString(16),hash:f.block.hash,timestamp:'0x'+(Date.parse(f.block.timestamp)/1000).toString(16)},
   {metadata:async address=>({address,name:null,symbol:null,decimals:18,supplyRaw:null,block:f.block}),eligible:async token=>token.address===f.token,knownLaunch:async address=>address===f.token,
    priceUsd:async address=>address===WBNB?'1000':null,additionalNativeFeeWei:async()=>0n,signedBatchPurchaseUsd:purchase});
  expect(decoded.reasons).toEqual([]);expect(decoded.events).toHaveLength(1);expect(purchase).toHaveBeenCalledTimes(1);
  const e=decoded.events[0],fee=new FreshRational(BigInt(payment.gasFeeWei)+BigInt(payment.extraNativeWei),10n**18n).mul(FreshRational.parse('1000'));
  expect(e).toMatchObject({kind:'buy',amountUsd:'600',feeUsd:fee.decimal(),feeAttribution:{expensePolicy:'signed_batch_trade_expenses_v1',batchExpenseNativeWei:payment.extraNativeWei,gasNativeWei:payment.gasFeeWei}});
  expect(e.feeAttribution?.nativeFeeWei).toBe(String(BigInt(payment.gasFeeWei)+BigInt(payment.extraNativeWei)));
  const scope={id:'batch:test',kind:'kol' as const,walletAddresses:[wallet],accountId:null,startsAt:'2026-10-21T00:00:00Z',startsBlock:'1',revision:'1'},applied=applyFreshEvent(scope,e,{position:null,lots:[]});
  expect(applied.lots).toHaveLength(1);expect(FreshRational.fromStored(applied.lots[0].costQ!).decimal()).toBe(FreshRational.parse('600').add(fee).decimal());
  const sold={...e,id:e.id+'sale',executionKey:e.executionKey+'sale',kind:'sell' as const,amountUsd:'700',feeUsd:'0',feeKey:e.feeKey+'sale',feeAttribution:undefined},closed=applyFreshEvent(scope,sold,{position:applied.position,lots:applied.lots});
  expect(FreshRational.fromStored(closed.result.realizedQ!).decimal()).toBe(FreshRational.parse('100').sub(fee).decimal());
 });
 it('retains unknown purchase value if genuine historical change is unavailable',async()=>{
  const f=structuredClone(fixtures[0]),decoded=await normalizeFreshReceipt(f.entry,{number:'0x'+f.block.number.toString(16),hash:f.block.hash,timestamp:'0x'+(Date.parse(f.block.timestamp)/1000).toString(16)},
   {metadata:async address=>({address,name:null,symbol:null,decimals:18,supplyRaw:null,block:f.block}),eligible:async token=>token.address===f.token,priceUsd:async address=>address===WBNB?'1000':null,signedBatchPurchaseUsd:async()=>null});
  expect(decoded.events).toHaveLength(1);expect(decoded.events[0].amountUsd).toBeNull();expect(decoded.reasons).toContain('trade_value_unavailable');
  expect(decoded.events[0].feeAttribution?.expensePolicy).toBe('signed_batch_trade_expenses_v1');
 });
 it('does not turn a malformed signed self-batch into a full native-value purchase',async()=>{
  const f=structuredClone(fixtures[0]),payment=freshSignedBatchNativeBuyPayment(f.entry,f.block,f.token,f.entry.transaction.from,BigInt(f.targetRaw))!;
  f.entry.receipt.logs=f.entry.receipt.logs.filter(l=>l.address!==payment.quoteAddress);
  const purchase=vi.fn(async()=> '600'),decoded=await normalizeFreshReceipt(f.entry,{number:'0x'+f.block.number.toString(16),hash:f.block.hash,timestamp:'0x'+(Date.parse(f.block.timestamp)/1000).toString(16)},
   {metadata:async address=>({address,name:null,symbol:null,decimals:18,supplyRaw:null,block:f.block}),eligible:async token=>token.address===f.token,priceUsd:async address=>address===WBNB?'1000':null,signedBatchPurchaseUsd:purchase});
  expect(purchase).not.toHaveBeenCalled();expect(decoded.events[0]?.amountUsd).toBeNull();expect(decoded.events[0]?.quoteAmount).toBeUndefined();expect(decoded.reasons).toContain('trade_value_unavailable');
 });
 it('rejects false policy attribution or native expense/gas sums',async()=>{
  const f=structuredClone(fixtures[0]),decoded=await normalizeFreshReceipt(f.entry,{number:'0x'+f.block.number.toString(16),hash:f.block.hash,timestamp:'0x'+(Date.parse(f.block.timestamp)/1000).toString(16)},
   {metadata:async address=>({address,name:null,symbol:null,decimals:18,supplyRaw:null,block:f.block}),eligible:async token=>token.address===f.token,priceUsd:async()=> '1000',signedBatchPurchaseUsd:async()=> '600'});
  const e=decoded.events[0];for(const patch of[{nativeFeeWei:'1'},{batchExpenseNativeWei:'0'},{gasNativeWei:'0'},{expensePolicy:'protocol_fee'},{expensePolicy:undefined}]){
   expect(()=>validateFreshFinancialEvent({...e,feeAttribution:{...e.feeAttribution!,...patch} as any})).toThrow('invalid_batch_expense_attribution');
  }
 });
});
