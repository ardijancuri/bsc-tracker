import {readFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {Interface} from 'ethers';
import {describe,it,expect} from 'vitest';
import {WBNB} from '../launchpad.js';
import {RpcRequestError} from '../rpc.js';
import {decodeFreshExecutions,normalizeFreshReceipt} from './decode.js';
import type {FreshCapturedReceipt} from './capture.js';
import {certifyFreshCompleteCallTrace} from './passiveIncoming.js';
import {FreshRational} from './accounting.js';
import {freshQuoteUsd,freshTokenMetadata,type FreshPriceBlock} from './pricing.js';
import {createFreshStateEvidenceRpc} from './stateEvidence.js';
import type {FreshCallTrace} from './trace.js';
import {freshSmartAccountNativeSell} from './smartAccountNativeSettlement.js';

// Original BSC v0.7 operation, full call tree and retained complete-trace
// certificate. No app credentials, financial snapshots or live RPC.
const fixture=JSON.parse(gunzipSync(readFileSync(new URL('./fixtures/smart-account-native-sell.json.gz',import.meta.url))).toString()) as {entry:FreshCapturedReceipt;block:FreshPriceBlock};
const token='0x4b1f0b4ac6d634f223cea6379ce855f372ffac65',wallet='0xcc291dcd83bd9f2600cca4d65ae3b724eaf4f5a9',raw=-8120070101672236191280372n,native=172185790264528270n;
const clone=()=>structuredClone(fixture.entry),proof=(e:FreshCapturedReceipt)=>freshSmartAccountNativeSell(e,decodeFreshExecutions(e)[0],fixture.block,token,raw,e.trace!);
const nodes=(c:FreshCallTrace):FreshCallTrace[]=>[c,...(c.calls??[]).flatMap(nodes)];
const certify=(e:FreshCapturedReceipt)=>{e.completeTraceProof=certifyFreshCompleteCallTrace(e,e.trace,{method:'debug_traceTransaction',params:[e.transaction.hash,{tracer:'callTracer',tracerConfig:{onlyTopCall:false,withLog:false}}]},'operator_archive');};
const aa=new Interface(['function handleOps((address sender,uint256 nonce,bytes initCode,bytes callData,bytes32 accountGasLimits,uint256 preVerificationGas,bytes32 gasFees,bytes paymasterAndData,bytes signature)[] ops,address beneficiary)']);
function changeOperation(e:FreshCapturedReceipt,alter:(args:any[])=>void){const p=aa.parseTransaction({data:String(e.transaction.input)})!,args=p.args.toArray(true) as any[];alter(args);e.transaction.input=aa.encodeFunctionData(p.fragment,args).toLowerCase();e.trace!.input=String(e.transaction.input);certify(e);}

describe('signed smart-account native sale proceeds',()=>{
 it('proves the actual TURF to GANG to BNB wallet payout without assigning gross pool output or bundler gas',()=>{
  expect(proof(clone())).toMatchObject({kind:'signed_smart_account_native_sell',walletAddress:wallet,tokenAddress:token,nativeReceivedWei:String(native),operationFeeWei:'0'});
 });
 it('normalizes the original sale using only its retained exact historical native feed',async()=>{
  const e=clone(),block={number:e.transaction.blockNumber,hash:fixture.block.hash,timestamp:'0x'+Math.floor(Date.parse(fixture.block.timestamp)/1000).toString(16)};
  let missingReads=0;const state=createFreshStateEvidenceRpc(async()=>{missingReads++;throw new RpcRequestError('offline_no_rpc','state_unavailable');},fixture.block,e.stateEvidence);
  const price=await freshQuoteUsd(WBNB,{rpc:state.rpc,block:fixture.block});expect(price).not.toBeNull();
  const result=await normalizeFreshReceipt(e,block,{metadata:address=>freshTokenMetadata(address,{rpc:state.rpc,block:fixture.block,requireSupply:false}),eligible:async t=>t.address===token,priceUsd:async address=>address===WBNB?price:null});
  expect(result.reasons).toEqual([]);expect(result.events).toHaveLength(1);
  expect(result.events[0]).toMatchObject({kind:'sell',tokenAddress:token,quantity:'8120070.101672236191280372',feeUsd:'0',quoteAddress:WBNB,quoteSymbol:'BNB',quoteAmount:'0.17218579026452827',amountUsd:new FreshRational(native,10n**18n).mul(FreshRational.parse(price!)).decimal()});expect(state.writes).toBe(0);expect(missingReads).toBe(0);
 });
 it('keeps USD unknown without an exact historical conversion while preserving proven quote units',async()=>{
  const e=clone(),result=await normalizeFreshReceipt(e,{number:e.transaction.blockNumber,hash:fixture.block.hash,timestamp:'0x'+Math.floor(Date.parse(fixture.block.timestamp)/1000).toString(16)},{metadata:async address=>({address,name:'TURF',symbol:'TURF',decimals:18,supplyRaw:null,block:fixture.block}),eligible:async t=>t.address===token,priceUsd:async()=>null});
  expect(result.reasons).toEqual(['trade_value_unavailable']);expect(result.events[0]).toMatchObject({amountUsd:null,quoteAmount:'0.17218579026452827',feeUsd:'0'});
 });
 it('rejects absent, top-only, stale and foreign complete-trace context',()=>{
  for(const alter of [
   (e:FreshCapturedReceipt)=>{delete e.completeTraceProof;},
   (e:FreshCapturedReceipt)=>{e.completeTraceProof!.onlyTopCall=true as false;},
   (e:FreshCapturedReceipt)=>{nodes(e.trace!).find(c=>c.to===wallet&&c.value==='0x263ba1060164d8e')!.value='0x1';},
   (e:FreshCapturedReceipt)=>{e.receipt.logs[1].transactionHash='0x'+'1'.repeat(64);},
   (e:FreshCapturedReceipt)=>{e.wallets=[];}
  ]){const e=clone();alter(e);expect(proof(e)).toBeNull();}
 });
 it('rejects repeated operations, paymasters, init code and unsigned direct-call changes',()=>{
  for(const alter of [
   (args:any[])=>{args[0].push(args[0][0]);},
   (args:any[])=>{args[0][0][7]='0x'+'1'.repeat(40);},
   (args:any[])=>{args[0][0][2]='0x12';}
  ]){const e=clone();changeOperation(e,alter);expect(proof(e)).toBeNull();}
  const e=clone();nodes(e.trace!).find(c=>c.from===wallet&&c.input?.startsWith('0x2213bc0b'))!.input='0x12345678';certify(e);expect(proof(e)).toBeNull();
 });
 it('rejects native cash outside the signed sale, wallet outflows, a failed sale and extra wallet token assets',()=>{
  for(const alter of [
   (e:FreshCapturedReceipt)=>{e.trace!.calls!.push({type:'CALL',from:String(e.transaction.to),to:wallet,value:'0x1',input:'0x'});},
   (e:FreshCapturedReceipt)=>{nodes(e.trace!).find(c=>c.from===wallet&&c.input?.startsWith('0x2213bc0b'))!.calls!.push({type:'CALL',from:wallet,to:token,value:'0x1',input:'0x'});},
   (e:FreshCapturedReceipt)=>{nodes(e.trace!).find(c=>c.from===wallet&&c.input?.startsWith('0x2213bc0b'))!.error='execution reverted';},
   (e:FreshCapturedReceipt)=>{e.receipt.logs.find(l=>l.address===token&&l.topics[0].startsWith('0xddf252ad'))!.address=WBNB;}
  ]){const e=clone();alter(e);certify(e);expect(proof(e)).toBeNull();}
 });
 it('requires exact token quantity, successful operation identity and its real operation fee',()=>{
  const e=clone(),ex=decodeFreshExecutions(e)[0];
  for(const wrong of [{...ex,feeWei:1n},{...ex,index:2},{...ex,status:'failed' as const},{...ex,operationHash:'0x'+'1'.repeat(64)},{...ex,logs:[]}])expect(freshSmartAccountNativeSell(e,wrong,fixture.block,token,raw,e.trace!)).toBeNull();
  expect(freshSmartAccountNativeSell(e,ex,fixture.block,token,raw-1n,e.trace!)).toBeNull();expect(freshSmartAccountNativeSell(e,ex,fixture.block,token,-raw,e.trace!)).toBeNull();
 });
});
