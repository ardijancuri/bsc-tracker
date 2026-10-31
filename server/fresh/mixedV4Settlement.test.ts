import {readFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {AbiCoder,Interface} from 'ethers';
import {describe,it,expect,vi} from 'vitest';
import {freshMixedV4Settlement} from './mixedV4Settlement.js';
import {normalizeFreshReceipt} from './decode.js';
import {certifyFreshCompleteCallTrace} from './passiveIncoming.js';
import {validateFreshTrace,freshNativeDelta,type FreshCallTrace} from './trace.js';
import {createFreshStateEvidenceRpc} from './stateEvidence.js';
import {freshTokenMetadata,freshQuoteUsd} from './pricing.js';
import {FreshRational} from './accounting.js';
import {WBNB} from '../launchpad.js';
import {stockwavePoolManagerInterface} from './stockwaveMarket.js';
import {transferTopic} from '../swap.js';
const f=JSON.parse(gunzipSync(readFileSync(new URL('./fixtures/mixed-v4-gang.json.gz',import.meta.url))).toString());
const wallet='0xcc291dcd83bd9f2600cca4d65ae3b724eaf4f5a9',token='0x0c6302401aa5325c2e36f170f52c00b1d220b405',manager='0x28e2ea090877bf75740558f6bfb36a5ffee9e9df',pair='0x0bd5ded695d61c2db15c703c345d57e039fd0b6d',v3pool='0x9417dd70a63475820ba059434ffa0ea737df9f03';
const quantity=1394663199490073142675730n,coder=AbiCoder.defaultAbiCoder();
const seal=(e:any)=>{e.completeTraceProof=certifyFreshCompleteCallTrace(e,validateFreshTrace(e.trace),{method:'debug_traceTransaction',params:[e.transaction.hash,{tracer:'callTracer',tracerConfig:{onlyTopCall:false,withLog:false}}]},'private_ipc');};
const calls=(root:FreshCallTrace)=>{const out:FreshCallTrace[]=[];const visit=(c:FreshCallTrace)=>{if(c.error)return;out.push(c);c.calls?.forEach(visit);};visit(root);return out;};
const uni=new Interface(['function swap((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) key,(bool zeroForOne,int256 amountSpecified,uint160 sqrtPriceLimitX96) params,bytes hookData)returns(int256)']);
const erc20=new Interface(['function transfer(address to,uint256 amount)returns(bool)','function transferFrom(address from,address to,uint256 amount)returns(bool)']);
function ordinarySell(){
 const e=structuredClone(f.entry),original=calls(e.trace).find(c=>c.to===manager&&c.input?.startsWith(uni.getFunction('swap')!.selector))!,p=uni.parseTransaction({data:original.input!})!,key=[...p.args.key];
 const target0=String(key[0]).toLowerCase()===token,quote=String(key[target0?1:0]).toLowerCase(),n=100n,q=200n,a0=target0?-n:q,a1=target0?q:-n;
 const swap={...original,input:uni.encodeFunctionData('swap',[key,[target0,-n,p.args.params.sqrtPriceLimitX96],'0x']),output:coder.encode(['uint256'],[((a0&((1n<<128n)-1n))<<128n)|(a1&((1n<<128n)-1n))]),calls:[]};
 const base=e.receipt.logs[0],log=(address:string,topics:string[],data:string,index:number)=>({...base,address,topics,data,logIndex:'0x'+index.toString(16)}),topic=(address:string)=>'0x'+address.slice(2).padStart(64,'0');
 const event=stockwavePoolManagerInterface.encodeEventLog('Swap',[e.receipt.logs.find((l:any)=>l.address===manager&&l.topics[0]===stockwavePoolManagerInterface.getEvent('Swap')!.topicHash).topics[1],swap.from,a0,a1,1n<<96n,1000,0,100]);
 e.transaction.value='0x0';e.trace.value='0x0';e.trace.calls=[
  {type:'CALL',from:e.transaction.to,to:token,value:'0x0',input:erc20.encodeFunctionData('transferFrom',[wallet,manager,n]),output:coder.encode(['bool'],[true])},
  swap,{type:'CALL',from:manager,to:quote,value:'0x0',input:erc20.encodeFunctionData('transfer',[wallet,q]),output:coder.encode(['bool'],[true])}];
 e.receipt.logs=[log(token,[transferTopic,topic(wallet),topic(manager)],coder.encode(['uint256'],[n]),1),log(manager,event.topics,event.data,2),log(quote,[transferTopic,topic(manager),topic(wallet)],coder.encode(['uint256'],[q]),3)];seal(e);return e;
}

describe('mixed authenticated V2/V3/V4 settlement',()=>{
 it('links the genuine GANG purchase across all five target deliveries without modifying evidence',()=>{
  const e=structuredClone(f.entry),before=structuredClone(e);
  expect(freshMixedV4Settlement(e,wallet,token,quantity)).toBe(true);expect(e).toEqual(before);
  expect(freshNativeDelta(e.trace,wallet)).toBe(-5n*10n**18n);
 });
 it('normalizes quantity, historical payment and gas using original saved evidence only',async()=>{
  const e=structuredClone(f.entry),b=f.header,block={number:Number(BigInt(b.number)),hash:b.hash,timestamp:new Date(Number(BigInt(b.timestamp))*1000).toISOString()};
  const rpc=vi.fn(async()=>{throw Error('must_not_fetch_current_or_historical_replacements');}),saved=createFreshStateEvidenceRpc(rpc as any,block,e.stateEvidence);
  const metadata=await freshTokenMetadata(token,{rpc:saved.rpc,block}),native=await freshQuoteUsd(WBNB,{rpc:saved.rpc,block});
  const result=await normalizeFreshReceipt(e,b,{metadata:async asset=>asset===token?metadata:null,eligible:async()=>true,tokenDiscovery:async asset=>asset===token?'eligible':'excluded',priceUsd:async asset=>asset===WBNB?native:null});
  expect(result.reasons).toEqual([]);expect(result.events).toHaveLength(1);const event=result.events[0];
  expect(event).toMatchObject({kind:'buy',tokenAddress:token,walletAddress:wallet,quantity:'1394663.19949007314267573',quoteAddress:WBNB,quoteSymbol:'BNB',quoteAmount:'5',amountUsd:'3519.53115'});
  expect(event.feeUsd).toBe(FreshRational.parse(native).mul(new FreshRational(BigInt(e.receipt.gasUsed)*BigInt(e.receipt.effectiveGasPrice),10n**18n)).decimal());
  expect(rpc).not.toHaveBeenCalled();
  const again=await normalizeFreshReceipt(e,b,{metadata:async asset=>asset===token?metadata:null,eligible:async()=>true,tokenDiscovery:async asset=>asset===token?'eligible':'excluded',priceUsd:async asset=>asset===WBNB?native:null});
  expect(again.events).toEqual(result.events);
 });
 it('allows a proven plain native refund without authorizing wallet reentry',()=>{
  const e=structuredClone(f.entry);e.trace.calls.push({type:'CALL',from:e.transaction.to,to:wallet,value:'0x16345785d8a0000',input:'0x',output:'0x'});seal(e);
  expect(freshMixedV4Settlement(e,wallet,token,quantity)).toBe(true);expect(freshNativeDelta(e.trace,wallet)).toBe(-4900000000000000000n);
 });
 it('supports an ordinary token sale settled in the actual quote token',()=>{
  const e=ordinarySell();expect(freshMixedV4Settlement(e,wallet,token,-100n)).toBe(true);
  e.trace.calls[1].output=coder.encode(['uint256'],[1]);seal(e);expect(freshMixedV4Settlement(e,wallet,token,-100n)).toBe(false);
 });
 it.each(['missing_trace','missing_certificate','wrong_wallet','wrong_token','wrong_quantity','authorization','failed','wrong_pool_key','hook','delta','missing_v4_call','missing_v3_call','v3_return','v2_output','recipient','token_call_quantity','token_call_false','extra_asset','wallet_reentry','reverted_parent','extra_transfer','removed_log'] as const)('rejects %s even with a re-sealed test trace',kind=>{
  const e=structuredClone(f.entry),all=calls(e.trace),swap=all.find(c=>c.to===manager&&c.input?.startsWith(uni.getFunction('swap')!.selector))!;let w=wallet,t=token,n=quantity;
  if(kind==='missing_trace')delete e.trace;if(kind==='missing_certificate')delete e.completeTraceProof;if(kind==='wrong_wallet')w='0x'+'1'.repeat(40);if(kind==='wrong_token')t='0x'+'2'.repeat(40);if(kind==='wrong_quantity')n++;
  if(kind==='authorization')e.transaction.authorizationList=[];if(kind==='failed')e.receipt.status='0x0';
  if(kind==='wrong_pool_key'||kind==='hook'){const p=uni.parseTransaction({data:swap.input!})!,k=[...p.args.key];k[kind==='hook'?4:2]=kind==='hook'?'0x'+'1'.repeat(40):1234;swap.input=uni.encodeFunctionData('swap',[k,[...p.args.params],p.args.hookData]);}
  if(kind==='delta')swap.output='0x'+(BigInt(swap.output!)+1n).toString(16).padStart(64,'0');
  if(kind==='missing_v4_call')swap.input='0x';if(kind==='missing_v3_call')all.find(c=>c.to===v3pool&&c.input?.startsWith('0x128acb08'))!.input='0x';
  if(kind==='v3_return')all.find(c=>c.to===v3pool&&c.input?.startsWith('0x128acb08'))!.output=coder.encode(['int256','int256'],[1,-1]);
  if(kind==='v2_output'){const c=all.find(c=>c.to===pair&&c.input?.startsWith('0x022c0d9f'))!;c.input=c.input!.slice(0,10)+'0'.repeat(64)+c.input!.slice(74);}
  if(kind==='recipient')e.receipt.logs.find((l:any)=>l.address===token).topics[2]='0x'+'0'.repeat(24)+'4'.repeat(40);
  const delivery=all.find(c=>c.to===token&&c.input?.startsWith('0xa9059cbb')&&c.input.slice(10,74)==='0'.repeat(24)+wallet.slice(2))!;
  if(kind==='token_call_quantity')delivery.input=delivery.input!.slice(0,74)+'0'.repeat(63)+'1';if(kind==='token_call_false')delivery.output=coder.encode(['bool'],[false]);
  if(kind==='extra_asset')e.receipt.logs.find((l:any)=>l.address===token).address='0x'+'5'.repeat(40);
  if(kind==='wallet_reentry')e.trace.calls.push({type:'CALL',from:manager,to:wallet,value:'0x0',input:'0x',output:'0x'});
  if(kind==='reverted_parent')e.trace.calls[0].error='execution reverted';
  if(kind==='extra_transfer'){const l=structuredClone(e.receipt.logs.find((l:any)=>l.address===token));l.logIndex='0xfff';e.receipt.logs.push(l);n+=BigInt(l.data);}
  if(kind==='removed_log')e.receipt.logs.find((l:any)=>l.address===token).removed=true;
  if(e.trace&&kind!=='missing_certificate')seal(e);
  expect(freshMixedV4Settlement(e,w,t,n)).toBe(false);
 });
});
