import { describe, expect, it, vi } from 'vitest';
import { Interface } from 'ethers';
import { FLAP_PORTAL, WBNB, flapInterface } from '../launchpad.js';
import { transferTopic } from '../swap.js';
import { FRESH_BTCB_QUOTE } from './currentBtcQuote.js';
import { freshDirectFlapPurchase } from './directFlapPurchase.js';
import { normalizeFreshReceipt, type FreshDecodeServices } from './decode.js';
import type { FreshCapturedReceipt, FreshLog } from './capture.js';
const wallet='0x'+'1'.repeat(40),token='0x'+'7'.repeat(40),other='0x'+'2'.repeat(40),hash='0x'+'a'.repeat(64),txHash='0x'+'b'.repeat(64);
const block={number:10000,hash,timestamp:'2026-10-23T02:54:21.000Z'},ts=BigInt(Date.parse(block.timestamp)/1000),raw=76669249123509847918408403n,quoteRaw=4506150453856881n;
const events=new Interface(['event TokenQuoteSet(address token,address quoteToken)','event TokenBought(uint256 ts,address token,address buyer,uint256 amount,uint256 eth,uint256 fee,uint256 postPrice)']);
const word=(value:string|bigint)=>typeof value==='string'?value.slice(2).padStart(64,'0'):value.toString(16).padStart(64,'0');
function fixture():FreshCapturedReceipt{
 const log=(address:string,topics:string[],data:string,index:number):FreshLog=>({address,topics,data,logIndex:'0x'+index.toString(16),transactionHash:txHash,transactionIndex:'0x1',blockHash:hash,blockNumber:'0x2710'});
 const portal=(schema:Interface,name:string,args:unknown[],index:number)=>{const value=schema.encodeEventLog(name,args);return log(FLAP_PORTAL,value.topics,value.data,index);};
 const transfer=(address:string,from:string,to:string,value:bigint,index:number)=>log(address,[transferTopic,'0x'+word(from),'0x'+word(to)],'0x'+word(value),index);
 return{transaction:{hash:txHash,blockNumber:'0x2710',blockHash:hash,transactionIndex:'0x1',from:wallet,to:FLAP_PORTAL,value:'0x0',type:'0x0',gasPrice:'0x3b9aca00'},
 receipt:{transactionHash:txHash,blockNumber:'0x2710',blockHash:hash,transactionIndex:'0x1',from:wallet,to:FLAP_PORTAL,status:'0x1',gasUsed:'0x186a0',effectiveGasPrice:'0x3b9aca00',logs:[
  portal(flapInterface,'TokenCreated',[ts,wallet,1n,token,'Sats','sats','https://example.invalid'],1),
  portal(events,'TokenQuoteSet',[token,FRESH_BTCB_QUOTE],2),transfer(FRESH_BTCB_QUOTE,wallet,FLAP_PORTAL,quoteRaw,3),transfer(token,FLAP_PORTAL,wallet,raw,4),
  portal(events,'TokenBought',[ts,token,wallet,raw,quoteRaw,45061504538568n,62515766n],5),]},wallets:[wallet],observedAt:'2026-10-23T02:54:24.699Z'};
}
const proof=(entry:FreshCapturedReceipt)=>freshDirectFlapPurchase(entry,block,token,wallet,raw);
describe('direct ordinary-EOA Flap gross ERC20 purchase settlement',()=>{
 it('binds creation, quote identity, delivery, gross payment and known EOA gas without double-charging the embedded fee',()=>{
  expect(proof(fixture())).toMatchObject({kind:'direct_flap_gross_quote_purchase',tokenRaw:String(raw),quoteRaw:String(quoteRaw),embeddedQuoteFeeRaw:'45061504538568',gasFeeWei:'100000000000000',purchaseLogIndex:5});
 });
 it('rejects 7702 self-calls, AA/bundler routes, native value and authorization lists',()=>{
  for(const patch of[{to:wallet,type:'0x4'},{to:other},{value:'0x1'},{authorizationList:[]},{type:'0x3'}]){const entry=fixture();Object.assign(entry.transaction,patch);expect(proof(entry)).toBeNull();}
 });
 it('rejects another source block, receipt position and wallet identity',()=>{
  const e=fixture();expect(freshDirectFlapPurchase(e,{...block,hash:'0x'+'f'.repeat(64)},token,wallet,raw)).toBeNull();
  const f=fixture();f.receipt.transactionIndex='0x2';expect(proof(f)).toBeNull();const g=fixture();g.transaction.from=other;expect(proof(g)).toBeNull();
 });
 it('requires a supported quote, exactly matching quantity and receipt timestamp',()=>{
  const e=fixture();e.receipt.logs[1]={...e.receipt.logs[1],...events.encodeEventLog('TokenQuoteSet',[token,other])};expect(proof(e)).toBeNull();
  expect(freshDirectFlapPurchase(fixture(),block,token,wallet,raw+1n)).toBeNull();expect(freshDirectFlapPurchase(fixture(),{...block,timestamp:'2026-10-23T02:54:22.000Z'},token,wallet,raw)).toBeNull();
 });
 it('binds a controller-authenticated custom quote to the actual gross wallet payment without assuming its decimals or price',()=>{
  const e=fixture();e.receipt.logs[1]={...e.receipt.logs[1],...events.encodeEventLog('TokenQuoteSet',[token,other])};e.receipt.logs[2].address=other;
  expect(proof(e)).toMatchObject({quoteAddress:other,quoteRaw:String(quoteRaw),gasFeeWei:'100000000000000'});
  for(const address of[token,wallet,FLAP_PORTAL,WBNB,'0x'+'0'.repeat(40)]){
   const invalid=structuredClone(e);invalid.receipt.logs[1]={...invalid.receipt.logs[1],...events.encodeEventLog('TokenQuoteSet',[token,address])};invalid.receipt.logs[2].address=address;
   expect(proof(invalid)).toBeNull();
  }
 });
 it('rejects forged portal events and mismatching outgoing settlement or target delivery',()=>{
  for(const index of[0,1,4]){const e=fixture();e.receipt.logs[index].address=other;expect(proof(e)).toBeNull();}
  for(const index of[2,3]){const e=fixture();e.receipt.logs[index].data='0x'+word(1n);expect(proof(e)).toBeNull();}
 });
 it('does not net change, extra assets, self transfers or repeated operations away',()=>{
  for(const index of[2,3,4]){const e=fixture(),extra={...e.receipt.logs[index],logIndex:'0x6'};e.receipt.logs.push(extra);expect(proof(e)).toBeNull();}
  const e=fixture(),l={...e.receipt.logs[2],logIndex:'0x6',topics:[transferTopic,'0x'+word(other),'0x'+word(wallet)],data:'0x'+word(1n)};e.receipt.logs.push(l);expect(proof(e)).toBeNull();
 });
 it('rejects removed, out-of-order, foreign and malformed logs',()=>{
  for(const patch of[{removed:true},{blockHash:'0x'+'f'.repeat(64)},{transactionHash:'0x'+'f'.repeat(64)},{transactionIndex:'0x2'},{logIndex:'0x0'},{data:'0x01'}]){
   const e=fixture();Object.assign(e.receipt.logs[4],patch);expect(proof(e)).toBeNull();
  }
  const e=fixture();e.receipt.logs.push({...e.receipt.logs[4],logIndex:'0x6',data:'0x01'});expect(proof(e)).toBeNull();
 });
 it('keeps gas attribution distinct from the quote payment and requires a successful ordinary transaction',()=>{
  for(const field of['gasUsed','effectiveGasPrice','status']){const e=fixture();e.receipt[field]='0x0';expect(proof(e)).toBeNull();}
 });
 it('normalizes a verified gross-quote purchase with its existing event and gas-fee identities',async()=>{
  const direct=vi.fn(async(address:string,account:string,quantity:bigint,native:string|null)=>{
   expect([address,account,quantity,native]).toEqual([token,wallet,raw,'600']);return'299.88';
  });
  const services:FreshDecodeServices={metadata:async address=>({address,name:'Sats',symbol:'sats',decimals:18,supplyRaw:null,block}),eligible:async m=>m.address===token,knownLaunch:async address=>address===token,
   priceUsd:async address=>address===WBNB?'600':null,directFlapPurchaseUsd:direct};
  const decoded=await normalizeFreshReceipt(fixture(),{number:'0x2710',hash,timestamp:'0x'+ts.toString(16)},services);
  expect(decoded.reasons).toEqual([]);expect(decoded.events).toHaveLength(1);expect(decoded.events[0]).toMatchObject({kind:'buy',quantity:'76669249.123509847918408403',amountUsd:'299.88',feeUsd:'0.06',logIndex:5});
  expect(decoded.events[0].feeKey).toContain(':transaction:0:fee');expect(direct).toHaveBeenCalledOnce();
  const failed=await normalizeFreshReceipt(fixture(),{number:'0x2710',hash,timestamp:'0x'+ts.toString(16)},{...services,directFlapPurchaseUsd:async()=>null});
  expect(failed.events[0].amountUsd).toBeNull();expect(failed.reasons).toEqual(['trade_value_unavailable']);expect(failed.events[0].id).toBe(decoded.events[0].id);expect(failed.events[0].feeKey).toBe(decoded.events[0].feeKey);
 });
});
