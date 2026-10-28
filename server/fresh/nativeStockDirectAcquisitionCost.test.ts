import {describe,it,expect,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {AbiCoder,Interface} from 'ethers';
import {freshNativeStockAcquisitionCost} from './nativeStockAcquisitionCost.js';
import {freshNativeStockQuoteChange} from './nativeQuoteChange.js';
import {compactFreshAcquisitionCost} from './acquisitionCost.js';
import {FreshRational,validateFreshFinancialEvent} from './accounting.js';
import {certifyFreshCompleteCallTrace} from './passiveIncoming.js';
import {normalizeFreshReceipt} from './decode.js';
import {createFreshReceiptRecovery} from './recovery.js';
import {freshQuoteUsd,freshTokenMetadata} from './pricing.js';
import {createFreshStateEvidenceRpc} from './stateEvidence.js';
import {RpcRequestError} from '../rpc.js';
import {WBNB} from '../launchpad.js';
import {v3MarketAbi} from '../nodeMarketProtocols.js';
import type {FreshCapturedReceipt} from './capture.js';
import type {FreshPriceBlock} from './pricing.js';
import type {FreshCallTrace} from './trace.js';

type Fixture={sample:{entry:FreshCapturedReceipt;block:FreshPriceBlock;wallet:string;token:string;targetRaw:string};nativePriceUsd:string;originalFinancialEvent:{id:string;fee_usd:string;quantity:string}};
const fixtures=()=>JSON.parse(gunzipSync(readFileSync(new URL('./fixtures/native-bncb-direct-v3-changes.json.gz',import.meta.url))).toString()).samples as Fixture[];
const at=(e:FreshCapturedReceipt,path:number[])=>path.reduce((c,n)=>c.calls![n],e.trace!);
const recertify=(e:FreshCapturedReceipt)=>{e.completeTraceProof=certifyFreshCompleteCallTrace(e,e.trace,{method:'debug_traceTransaction',params:[e.transaction.hash,{tracer:'callTracer',tracerConfig:{onlyTopCall:false,withLog:false}}]},'operator_archive');};
const api=new Interface(['function swap(address,bool,int256,uint160,bytes) returns(int256,int256)','function pancakeV3SwapCallback(int256,int256,bytes)']);
const quote='0x4902c5ebc598265ed2212b559b042de8a5eeec3f',pool='0x320e8096e5e7a46e43446141a5b15d801fc596f5';
function actual(f:Fixture,e=f.sample.entry){const s=f.sample;return freshNativeStockAcquisitionCost(e,s.block,s.token,s.wallet,BigInt(s.targetRaw),f.nativePriceUsd);}
function rewriteRoute(e:FreshCapturedReceipt,change:(path:string,payer:string)=>[string,string]){
 const swap=at(e,[0,3,0]),s=api.decodeFunctionData('swap',swap.input!),route=AbiCoder.defaultAbiCoder().decode(['tuple(bytes path,address payer)'],s[4])[0],updated=change(route.path,route.payer),data=AbiCoder.defaultAbiCoder().encode(['tuple(bytes path,address payer)'],[updated]);
 swap.input=api.encodeFunctionData('swap',[s[0],s[1],s[2],s[3],data]);
 const cb=at(e,[0,3,0,2]),c=api.decodeFunctionData('pancakeV3SwapCallback',cb.input!);cb.input=api.encodeFunctionData('pancakeV3SwapCallback',[c[0],c[1],data]);cb.calls![0].input=cb.input;
}

describe('actual direct BNCB acquisitions with returned raw change',()=>{
 const expected=[
  ['147.136329999999997035049751542294689347','552','0.2'],
  ['100.052704399999997448539008185297837051','475','0.136'],
  ['183.942184247499996534403039567864641128','643','0.25'],
  ['183.942184247499997202702229587338261755','519','0.25'],
 ];
 it.each([0,1,2,3])('allocates real input cost for original execution %i without a fabricated USDT bridge',i=>{
  const f=fixtures()[i],p=actual(f)!;expect(p).not.toBeNull();expect(p.route).toBe('direct_wrapped_stock_v3');if(p.route!=='direct_wrapped_stock_v3')throw Error('expected_direct_route');
  expect(p).not.toHaveProperty('stableBridgeRaw');expect(p).not.toHaveProperty('stableLogIndices');expect(p.calls).not.toHaveProperty('stableAcquisition');
  expect(p.payment).toMatchObject({quoteAddress:quote,changeRaw:expected[i][1]});expect(p.amountUsd).toBe(expected[i][0]);
  expect(p.nativePriceUsd).toBe(f.nativePriceUsd);expect(p.pool).toMatchObject({address:pool,fee:2500,token0:quote,token1:WBNB});
  expect(FreshRational.parse(p.amountQ).add(FreshRational.parse(p.retainedQuoteCostQ)).exact()).toBe(p.grossCostQ);
  expect(FreshRational.parse(p.grossCostQ).div(FreshRational.parse(p.nativePriceUsd)).decimal()).toBe(expected[i][2]);
  expect(BigInt(p.payment.acquiredQuoteRaw)).toBe(BigInt(p.payment.spentQuoteRaw)+BigInt(p.payment.changeRaw));
 });
 it.each([0,1,2,3])('normalizes original execution %i with exact unchanged ID/quantity/gas using saved state only',async i=>{
  const f=fixtures()[i],s=f.sample,noRpc=vi.fn(async()=>{throw new RpcRequestError('retained_state_not_present','state_unavailable')}),db={query:vi.fn(async()=>{throw Error('unneeded_database')})},state=createFreshStateEvidenceRpc(noRpc,s.block,s.entry.stateEvidence),recovery=createFreshReceiptRecovery(db as any,noRpc,s.entry,s.block,{state:()=>state.snapshot()});
  const before=JSON.stringify(s.entry),decoded=await normalizeFreshReceipt(s.entry,{number:'0x'+s.block.number.toString(16),hash:s.block.hash,timestamp:'0x'+Math.floor(Date.parse(s.block.timestamp)/1000).toString(16)},{metadata:token=>freshTokenMetadata(token,{rpc:state.rpc,block:s.block,requireSupply:false}),knownLaunch:async token=>token===s.token,eligible:async token=>token.address===s.token,priceUsd:token=>token===WBNB?freshQuoteUsd(token,{rpc:state.rpc,block:s.block}):Promise.resolve(null),additionalNativeFeeWei:recovery.additionalNativeFeeWei,directFlapPurchaseUsd:recovery.directFlapPurchaseUsd,quotePaymentUsd:recovery.quotePaymentUsd,nativeQuoteChangeUsd:recovery.nativeQuoteChangeUsd,acquisitionCost:recovery.acquisitionCost,retainedQuoteMetadata:recovery.importedMetadata,trace:async()=>null});
  expect(decoded.reasons).toEqual([]);const e=decoded.events.find(e=>e.id===f.originalFinancialEvent.id)!;expect(e.amountUsd).toBe(expected[i][0]);expect(e.feeUsd).toBe(f.originalFinancialEvent.fee_usd);expect(e.quantity).toBe(f.originalFinancialEvent.quantity);expect(e.quoteAmount).toBe(expected[i][2]);
  expect(e.acquisitionCost).toEqual(compactFreshAcquisitionCost(recovery.snapshot()!.nativeStockAcquisitionCosts![0]));expect(()=>validateFreshFinancialEvent(e)).not.toThrow();expect(db.query).not.toHaveBeenCalled();expect(noRpc).not.toHaveBeenCalled();expect(JSON.stringify(s.entry)).toBe(before);
 });
 it('requires a complete original trace certificate and exact canonical execution context',()=>{
  for(const mutate of [(e:FreshCapturedReceipt)=>{delete e.completeTraceProof},(e:FreshCapturedReceipt)=>{e.observedAt=new Date(Date.parse(e.observedAt)+1).toISOString()},(e:FreshCapturedReceipt)=>{e.completeTraceProof!.onlyTopCall=true as false}]){const f=fixtures()[0],e=structuredClone(f.sample.entry);mutate(e);expect(actual(f,e)).toBeNull();}
 });
 const negatives:[string,(e:FreshCapturedReceipt)=>void][]=[
  ['unregistered pool',e=>{const x=JSON.parse(JSON.stringify(e).replaceAll(pool.slice(2),'a'.repeat(40)));Object.assign(e,x)}],
  ['different fee without its immutable CREATE2 identity',e=>rewriteRoute(e,(path,payer)=>[path.slice(0,42)+'0001f4'+path.slice(48),payer])],
  ['callback paid by an unrelated account',e=>rewriteRoute(e,(path)=>[path,'0x'+'a'.repeat(40)])],
  ['noncanonical route data suffix',e=>{const swap=at(e,[0,3,0]),s=api.decodeFunctionData('swap',swap.input!);swap.input=api.encodeFunctionData('swap',[s[0],s[1],s[2],s[3],s[4]+'00'])}],
  ['wrong exact wrapped input',e=>{const swap=at(e,[0,3,0]),s=api.decodeFunctionData('swap',swap.input!);swap.input=api.encodeFunctionData('swap',[s[0],s[1],BigInt(s[2])+1n,s[3],s[4]])}],
  ['wrong swap direction',e=>{const swap=at(e,[0,3,0]),s=api.decodeFunctionData('swap',swap.input!);swap.input=api.encodeFunctionData('swap',[s[0],!s[1],s[2],s[3],s[4]])}],
  ['wrong signed swap output',e=>{const swap=at(e,[0,3,0]),s=api.decodeFunctionResult('swap',swap.output!);swap.output=api.encodeFunctionResult('swap',[BigInt(s[0])-1n,s[1]])}],
  ['forged callback sender',e=>{at(e,[0,3,0,2]).from='0x'+'a'.repeat(40)}],
  ['unrecognized callback delegation',e=>{at(e,[0,3,0,2,0]).to='0x'+'a'.repeat(40)}],
  ['wrong callback factory',e=>{at(e,[0,3,0,2,0,0]).output='0x'+'0'.repeat(64)}],
  ['wrapped balance mismatch',e=>{at(e,[0,3,0,3]).output='0x'+'0'.repeat(64)}],
  ['wrapped payment outside its callback',e=>{const c=at(e,[0,3,0,2,0]).calls!.pop()!;at(e,[0,3,0]).calls!.push(c)}],
  ['duplicate successful wrapped payment',e=>{const c=at(e,[0,3,0,2,0,1]);at(e,[0,3,0,2,0]).calls!.push(structuredClone(c))}],
  ['native refund not represented by gross acquisition',e=>{const root=e.trace!;root.calls![0].calls!.push({type:'CALL',from:root.to!,to:root.from!,value:'0x1',input:'0x',output:'0x'} as FreshCallTrace)}],
  ['extra wrapped refund',e=>{const log=structuredClone(e.receipt.logs.find(l=>l.address===WBNB&&l.topics.length===3)!);[log.topics[1],log.topics[2]]=[log.topics[2],log.topics[1]];log.logIndex='0xffff';e.receipt.logs.push(log)}],
  ['contradictory genuine Swap event',e=>{const log=e.receipt.logs.find(l=>l.address===pool&&l.topics[0]===v3MarketAbi.getEvent('Swap')!.topicHash)!,parsed=v3MarketAbi.parseLog(log)!,args=[...parsed.args];args[2]=BigInt(args[2])-1n;log.data=v3MarketAbi.encodeEventLog(parsed.fragment,args).data}],
  ['duplicate swap event',e=>{const log=structuredClone(e.receipt.logs.find(l=>l.address===pool&&l.topics[0]===v3MarketAbi.getEvent('Swap')!.topicHash)!);log.logIndex='0xffff';e.receipt.logs.push(log)}],
 ];
 it.each(negatives)('rejects %s with a freshly certified complete adversarial tree',(_name,mutate)=>{const f=fixtures()[0],e=structuredClone(f.sample.entry);mutate(e);recertify(e);expect(actual(f,e)).toBeNull();});
 it('does not accept merely changing the stock payment proof into a USD mark',()=>{const f=fixtures()[0],s=f.sample;expect(freshNativeStockQuoteChange(s.entry,s.block,s.token,s.wallet,BigInt(s.targetRaw))).not.toBeNull();expect(actual({...f,nativePriceUsd:'0'})).toBeNull();expect(actual({...f,nativePriceUsd:'-1'})).toBeNull();});
});
