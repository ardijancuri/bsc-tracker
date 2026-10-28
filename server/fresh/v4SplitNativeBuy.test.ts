import{readFileSync}from'node:fs';import{gunzipSync}from'node:zlib';import{describe,it,expect,vi}from'vitest';
import{freshV4SplitNativeBuy}from'./v4SplitNativeBuy.js';import{normalizeFreshReceipt}from'./decode.js';
import{validateFreshTrace,type FreshCallTrace}from'./trace.js';import{certifyFreshCompleteCallTrace}from'./passiveIncoming.js';
import{createFreshStateEvidenceRpc}from'./stateEvidence.js';import{freshTokenMetadata,freshQuoteUsd}from'./pricing.js';
import{FreshRational}from'./accounting.js';import{WBNB}from'../launchpad.js';
const fixture=JSON.parse(gunzipSync(readFileSync(new URL('./fixtures/v4-split-native-buys.json.gz',import.meta.url))).toString());
const wallet='0xaa8a849257f0993e32198f193229f6f540707777',token='0x89dfbd9bdd2617141fe159ab042069814f9b8f6e',manager='0x28e2ea090877bf75740558f6bfb36a5ffee9e9df',quantities=[203433564838062933572339n,200068628409721642609358n];
const seal=(e:any)=>{e.completeTraceProof=certifyFreshCompleteCallTrace(e,validateFreshTrace(e.trace),{method:'debug_traceTransaction',params:[e.transaction.hash,{tracer:'callTracer',tracerConfig:{onlyTopCall:false,withLog:false}}]},'private_ipc');};
const calls=(root:FreshCallTrace)=>{const out:FreshCallTrace[]=[];const walk=(x:FreshCallTrace)=>{out.push(x);x.calls?.forEach(walk)};walk(root);return out;};
describe('authenticated split official v4 native acquisitions',()=>{
 it.each([0,1])('binds genuine multi-pool case %s without changing original evidence',i=>{const e=structuredClone(fixture.rows[i].entry),before=structuredClone(e);expect(freshV4SplitNativeBuy(e,wallet,token,quantities[i])).toBe(true);expect(e).toEqual(before);});
 it.each([0,1])('normalizes exact delivered quantity, actual native expense and gas from saved state only, case%s',async i=>{
  const row=structuredClone(fixture.rows[i]),e=row.entry,b=row.header,block={number:Number(BigInt(b.number)),hash:b.hash,timestamp:new Date(Number(BigInt(b.timestamp))*1000).toISOString()},rpc=vi.fn(async()=>{throw Error('offline_missing_original_state')});
  const saved=createFreshStateEvidenceRpc(rpc as any,block,e.stateEvidence),metadata=await freshTokenMetadata(token,{rpc:saved.rpc,block}),native=await freshQuoteUsd(WBNB,{rpc:saved.rpc,block});
  const result=await normalizeFreshReceipt(e,b,{metadata:async asset=>asset===token?metadata:null,eligible:async()=>true,tokenDiscovery:async asset=>asset===token?'eligible':'excluded',priceUsd:async asset=>asset===WBNB?native:null});
  expect(result.reasons).toEqual([]);expect(result.events).toHaveLength(1);const event=result.events[0];
  expect(event).toMatchObject({kind:'buy',tokenAddress:token,walletAddress:wallet,quantity:new FreshRational(quantities[i],10n**BigInt(metadata.decimals)).decimal(255),quoteAddress:WBNB,quoteSymbol:'BNB',quoteAmount:'0.01'});
  expect(event.amountUsd).toBe(FreshRational.parse(native).mul(new FreshRational(1n,100n)).decimal());
  expect(event.feeUsd).toBe(FreshRational.parse(native).mul(new FreshRational(BigInt(e.receipt.gasUsed)*BigInt(e.receipt.effectiveGasPrice),10n**18n)).decimal());
  expect(rpc).not.toHaveBeenCalled();
 });
 it.each(['missing_trace','missing_certificate','wrong_wallet','wrong_token','wrong_quantity','authorization','failed','padded_calldata','pool_hash','delta','swap_sender','liquidity','recipient','extra_asset','wallet_reentry','reverted_parent']as const)('does not approve %s',kind=>{
  const e=structuredClone(fixture.rows[0].entry),swap=calls(e.trace).find(c=>c.to===manager&&c.input?.startsWith('0xf3cd914c'))!;let w=wallet,t=token,n=quantities[0];
  if(kind==='missing_trace')delete e.trace;if(kind==='missing_certificate')delete e.completeTraceProof;if(kind==='wrong_wallet')w='0x'+'1'.repeat(40);if(kind==='wrong_token')t='0x'+'2'.repeat(40);if(kind==='wrong_quantity')n++;
  if(kind==='authorization')e.transaction.authorizationList=[];if(kind==='failed')e.receipt.status='0x0';
  if(kind==='padded_calldata')swap.input+='00'.repeat(32);
  if(kind==='pool_hash')swap.input=swap.input!.slice(0,10+2*64)+'0'.repeat(64)+swap.input!.slice(10+3*64);
  if(kind==='delta')swap.output='0x'+(BigInt(swap.output!)+1n).toString(16).padStart(64,'0');
  if(kind==='swap_sender')swap.from='0x'+'3'.repeat(40);
  if(kind==='liquidity'){const l=e.receipt.logs.find((l:any)=>l.address===manager&&l.topics.length===3)!;l.data=l.data.slice(0,2+3*64)+'0'.repeat(64)+l.data.slice(2+4*64);}
  if(kind==='recipient'){const l=e.receipt.logs.find((l:any)=>l.address===token)!;l.topics[2]='0x'+'0'.repeat(24)+'4'.repeat(40);}
  if(kind==='extra_asset')e.receipt.logs.find((l:any)=>l.address===token).address='0x'+'5'.repeat(40);
  if(kind==='wallet_reentry')e.trace.calls.push({type:'CALL',from:manager,to:wallet,value:'0x0',input:'0x',output:'0x'});
  if(kind==='reverted_parent')e.trace.calls[0].error='execution reverted';
  if(e.trace&&kind!=='missing_certificate'&&kind!=='authorization'&&kind!=='failed')seal(e);
  expect(freshV4SplitNativeBuy(e,w,t,n)).toBe(false);
 });
});
