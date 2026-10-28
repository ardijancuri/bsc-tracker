import {readFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {describe,it,expect} from 'vitest';
import {WBNB} from '../launchpad.js';
import {RpcRequestError} from '../rpc.js';
import type {FreshCapturedReceipt} from './capture.js';
import {normalizeFreshReceipt} from './decode.js';
import {FreshRational} from './accounting.js';
import {freshNativeSellSettlement} from './nativeSellSettlement.js';
import {certifyFreshCompleteCallTrace} from './passiveIncoming.js';
import {freshQuoteUsd,freshTokenMetadata,type FreshPriceBlock} from './pricing.js';
import {createFreshStateEvidenceRpc} from './stateEvidence.js';
import type {FreshCallTrace} from './trace.js';

// Four original confirmed BSC sales: three fixed-expense PCS wrapper sales
// and one bot-router sale with a separately paid native route expense.
const fixtures=JSON.parse(gunzipSync(readFileSync(new URL('./fixtures/closed-router-native-sales.json.gz',import.meta.url))).toString()) as {entry:FreshCapturedReceipt;block:FreshPriceBlock;token:string;raw:string;expectedNativeDelta:string}[];
const clone=(i:number)=>structuredClone(fixtures[i]),proof=(x:typeof fixtures[number])=>freshNativeSellSettlement(x.entry,x.block,x.token,x.entry.transaction.from,BigInt(x.raw),x.entry.trace!);
const nodes=(c:FreshCallTrace):FreshCallTrace[]=>[c,...(c.calls??[]).flatMap(nodes)];
const certify=(e:FreshCapturedReceipt)=>{e.completeTraceProof=certifyFreshCompleteCallTrace(e,e.trace,{method:'debug_traceTransaction',params:[e.transaction.hash,{tracer:'callTracer',tracerConfig:{onlyTopCall:false,withLog:false}}]},'operator_archive');};

describe('closed native sale settlement',()=>{
 it.each([0,1,2,3])('proves actual native net cash for original sale %s with each expense counted once',i=>{
  const x=clone(i),p=proof(x)!;expect(p).not.toBeNull();expect(p.netNativeWei).toBe(x.expectedNativeDelta);
  expect(BigInt(p.walletReceivedWei)+BigInt(p.routeExpenseWei)).toBe(BigInt(p.grossWithdrawnWei));
  expect(BigInt(p.walletReceivedWei)-BigInt(p.signedUpfrontExpenseWei)).toBe(BigInt(x.expectedNativeDelta));
  expect(p.signedUpfrontExpenseWei).toBe(i===3?'0':'300000000000000');
 });
 it.each([0,1,2,3])('normalizes original sale %s from retained historical state with separate real gas',async i=>{
  const x=clone(i),e=x.entry,misses:string[]=[];
  const state=createFreshStateEvidenceRpc(async method=>{misses.push(method);throw new RpcRequestError('offline_no_rpc','state_unavailable');},x.block,e.stateEvidence);
  const price=await freshQuoteUsd(WBNB,{rpc:state.rpc,block:x.block});
  const result=await normalizeFreshReceipt(e,{number:e.transaction.blockNumber,hash:x.block.hash,timestamp:'0x'+Math.floor(Date.parse(x.block.timestamp)/1000).toString(16)},
   {metadata:address=>freshTokenMetadata(address,{rpc:state.rpc,block:x.block,requireSupply:false}),knownLaunch:async address=>address===x.token,eligible:async t=>t.address===x.token,priceUsd:async address=>address===WBNB?price:null});
  expect(result.reasons).toEqual([]);expect(result.events).toHaveLength(1);
  const quote=new FreshRational(BigInt(x.expectedNativeDelta),10n**18n),gas=BigInt(e.receipt.gasUsed)*BigInt(e.receipt.effectiveGasPrice??String(e.transaction.gasPrice));
  expect(result.events[0]).toMatchObject({kind:'sell',tokenAddress:x.token,quoteAddress:WBNB,quoteSymbol:'BNB',quoteAmount:quote.decimal(),amountUsd:quote.mul(FreshRational.parse(price)).decimal(),feeUsd:new FreshRational(gas,10n**18n).mul(FreshRational.parse(price)).decimal()});
  expect(misses).toEqual([]);expect(state.writes).toBe(0);
 });
 it.each([0,3])('keeps historical USD unavailable for sale %s while preserving actual native quote',async i=>{
  const x=clone(i),e=x.entry;
  const result=await normalizeFreshReceipt(e,{number:e.transaction.blockNumber,hash:x.block.hash,timestamp:'0x'+Math.floor(Date.parse(x.block.timestamp)/1000).toString(16)},
   {metadata:async address=>({address,name:'Token',symbol:'TOKEN',decimals:18,supplyRaw:null,block:x.block}),knownLaunch:async address=>address===x.token,eligible:async t=>t.address===x.token,priceUsd:async()=>null});
  expect(result.events[0].amountUsd).toBeNull();expect(result.events[0].quoteAmount).toBe(new FreshRational(BigInt(x.expectedNativeDelta),10n**18n).decimal());expect(result.reasons).toContain('trade_value_unavailable');expect(result.reasons).not.toContain('native_payout_mismatch');
 });
 it.each([0,3])('rejects missing/stale complete traces and wrong original identity %s',i=>{
  for(const alter of [
   (e:FreshCapturedReceipt)=>{delete e.completeTraceProof;},
   (e:FreshCapturedReceipt)=>{e.completeTraceProof!.onlyTopCall=true as false;},
   (e:FreshCapturedReceipt)=>{e.wallets=[];},
   (e:FreshCapturedReceipt)=>{e.receipt.logs[0].blockHash='0x'+'1'.repeat(64);},
   (e:FreshCapturedReceipt)=>{nodes(e.trace!).find(c=>c.to===e.transaction.from&&c.value&&BigInt(c.value)>0n)!.value='0x1';}
  ]){const x=clone(i);alter(x.entry);expect(proof(x)).toBeNull();}
 });
 it.each([0,3])('rejects extra native cash, wallet reentrancy, incomplete payouts and fee conservation changes %s',i=>{
  for(const alter of [
   (e:FreshCapturedReceipt)=>{nodes(e.trace!)[1].calls!.push({type:'CALL',from:String(e.transaction.to),to:'0x'+'1'.repeat(40),value:'0x1',input:'0x'});},
   (e:FreshCapturedReceipt)=>{nodes(e.trace!).find(c=>c.to===e.transaction.from&&c.value&&BigInt(c.value)>0n)!.calls=[{type:'CALL',from:e.transaction.from,to:'0x'+'1'.repeat(40),value:'0x1',input:'0x'}];},
   (e:FreshCapturedReceipt)=>{nodes(e.trace!).find(c=>c.to===e.transaction.from&&c.value&&BigInt(c.value)>0n)!.error='reverted';},
   (e:FreshCapturedReceipt)=>{nodes(e.trace!).find(c=>c.from===e.transaction.to&&c.to!==e.transaction.from&&c.value&&BigInt(c.value)>0n&&c.type==='CALL')!.value='0x1';}
  ]){const x=clone(i);alter(x.entry);certify(x.entry);expect(proof(x)).toBeNull();}
 });
 it.each([0,3])('requires exact wallet token quantity and direction %s',i=>{
  const x=clone(i);expect(freshNativeSellSettlement(x.entry,x.block,x.token,x.entry.transaction.from,BigInt(x.raw)-1n,x.entry.trace!)).toBeNull();expect(freshNativeSellSettlement(x.entry,x.block,x.token,x.entry.transaction.from,-BigInt(x.raw),x.entry.trace!)).toBeNull();
  const log=x.entry.receipt.logs.find(l=>l.address===x.token&&l.topics[1]?.endsWith(x.entry.transaction.from.slice(2)))!;log.address=WBNB;certify(x.entry);expect(proof(x)).toBeNull();
 });
});
