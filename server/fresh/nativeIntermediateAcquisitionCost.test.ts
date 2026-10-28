import{readFileSync}from'node:fs';import{gunzipSync}from'node:zlib';import{describe,it,expect,vi}from'vitest';
import{WBNB}from'../launchpad.js';import{RpcRequestError}from'../rpc.js';
import{fourMarketAbi}from'../nodeMarketProtocols.js';
import{FreshRational,validateFreshFinancialEvent}from'./accounting.js';import{compactFreshAcquisitionCost}from'./acquisitionCost.js';
import{normalizeFreshReceipt}from'./decode.js';import{freshNativeIntermediateAcquisitionCost}from'./nativeIntermediateAcquisitionCost.js';
import{certifyFreshCompleteCallTrace}from'./passiveIncoming.js';import{freshQuoteUsd,freshTokenMetadata,type FreshPriceBlock}from'./pricing.js';
import{createFreshReceiptRecovery}from'./recovery.js';import{createFreshStateEvidenceRpc}from'./stateEvidence.js';
import type{FreshCapturedReceipt}from'./capture.js';import type{FreshCallTrace}from'./trace.js';
type Fixture={entry:FreshCapturedReceipt;block:FreshPriceBlock;token:string;wallet:string;targetRaw:string;nativePriceUsd:string;originalFinancialEvent:{id:string;fee_usd:string}};
const v3Fixtures=JSON.parse(gunzipSync(readFileSync(new URL('./fixtures/native-v3-intermediate-quote-change.json.gz',import.meta.url))).toString())as Fixture[];
const fixtures=[...JSON.parse(gunzipSync(readFileSync(new URL('./fixtures/native-intermediate-quote-change.json.gz',import.meta.url))).toString())as Fixture[],...v3Fixtures];
const fixture=(i=0)=>structuredClone(fixtures[i]),proof=(f:Fixture)=>freshNativeIntermediateAcquisitionCost(f.entry,f.block,f.token,f.wallet,BigInt(f.targetRaw),f.nativePriceUsd);
const nodes=(c:FreshCallTrace):FreshCallTrace[]=>[c,...(c.calls??[]).flatMap(nodes)],at=(e:FreshCapturedReceipt,p:number[])=>p.reduce((c,i)=>c.calls![i],e.trace!);
const certify=(e:FreshCapturedReceipt)=>{e.completeTraceProof=certifyFreshCompleteCallTrace(e,e.trace,{method:'debug_traceTransaction',params:[e.transaction.hash,{tracer:'callTracer',tracerConfig:{onlyTopCall:false,withLog:false}}]},'operator_archive');};
function local(f:Fixture){const missing=vi.fn(async()=>{throw new RpcRequestError('offline_no_rpc','state_unavailable');}),db={query:vi.fn(async()=>{throw Error('offline_no_database');})},state=createFreshStateEvidenceRpc(missing,f.block,f.entry.stateEvidence),recovery=createFreshReceiptRecovery(db as any,missing,f.entry,f.block,{state:()=>state.snapshot()});return{missing,db,state,recovery};}
async function decode(f:Fixture){const s=local(f),result=await normalizeFreshReceipt(f.entry,{number:f.entry.transaction.blockNumber,hash:f.block.hash,timestamp:'0x'+Math.floor(Date.parse(f.block.timestamp)/1000).toString(16)},
 {metadata:address=>freshTokenMetadata(address,{rpc:s.state.rpc,block:f.block,requireSupply:false}),tokenDiscovery:async address=>address===f.token?'eligible':'pending',eligible:async t=>t.address===f.token,priceUsd:address=>address===WBNB?freshQuoteUsd(address,{rpc:s.state.rpc,block:f.block}):Promise.resolve(null),additionalNativeFeeWei:s.recovery.additionalNativeFeeWei,directFlapPurchaseUsd:s.recovery.directFlapPurchaseUsd,quotePaymentUsd:s.recovery.quotePaymentUsd,nativeQuoteChangeUsd:s.recovery.nativeQuoteChangeUsd,acquisitionCost:s.recovery.acquisitionCost,retainedQuoteMetadata:s.recovery.importedMetadata});return{...s,result};}

describe('actual native input allocation through a non-registered intermediate quote',()=>{
 it('proves both direct V3 variants including a token-owned reserve distribution without allocating that reserve as wallet input',()=>{
  for(const f of v3Fixtures){const p=proof(f)!;expect(p?.route).toBe('direct_wrapped_intermediate_v3');expect(BigInt(p.payment.spentQuoteRaw)+BigInt(p.payment.changeRaw)).toBe(BigInt(p.payment.acquiredQuoteRaw));expect(p.calls.beforeAcquisitionBalance).toBeUndefined();}
  expect(v3Fixtures.map(f=>f.entry.receipt.logs.length)).toEqual([24,24,24,27]);
 });
 it('replays every V3 retained proof after JSONB key reordering and preserves original payloads and known gas',async()=>{
  const sort=(v:unknown):unknown=>Array.isArray(v)?v.map(sort):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).sort(([a],[b])=>b.localeCompare(a)).map(([k,v])=>[k,sort(v)])):v;
  for(const f0 of v3Fixtures){const f=structuredClone(f0),original=JSON.stringify(f.entry),first=await decode(f);expect(JSON.stringify(f.entry)).toBe(original);f.entry.recoveryEvidence=sort(first.recovery.snapshot())as any;const second=await decode(f);expect(second.result.events).toEqual(first.result.events);expect(second.result.reasons).toEqual([]);expect(second.missing).not.toHaveBeenCalled();expect(second.db.query).not.toHaveBeenCalled();}
 });
 it('never creates a new V3 proof or makes RPC requests in retained-only mode',async()=>{
  const f=structuredClone(v3Fixtures[0]),s=local(f);expect(await s.recovery.nativeQuoteChangeUsd(f.token,f.wallet,BigInt(f.targetRaw),f.nativePriceUsd,true)).toBeNull();expect(s.recovery.acquisitionCost(f.token,f.wallet)).toBeNull();expect(s.missing).not.toHaveBeenCalled();expect(s.db.query).not.toHaveBeenCalled();
 });
 it('accepts exact one-raw protocol/creator redistribution while preserving total payment and purchase cost',()=>{
  const f=structuredClone(v3Fixtures[0]),before=proof(f)!,all=nodes(f.entry.trace!),w=(v:bigint|string)=>typeof v==='bigint'?v.toString(16).padStart(64,'0'):v.slice(2).padStart(64,'0'),quote=before.payment.quoteAddress,controller=before.payment.controller;
  const ls=f.entry.receipt.logs.filter(l=>l.address===quote&&l.topics[0].startsWith('0xddf252ad')&&l.topics[1]==='0x'+w(controller)),donated=ls.find(l=>l.topics[2]==='0x'+w(f.token))!,protocol=ls.find(l=>l!==donated)!,creatorRaw=BigInt(donated.data),protocolRaw=BigInt(protocol.data);
  for(const[l,next]of[[protocol,protocolRaw+1n],[donated,creatorRaw-1n]]as const){const old=BigInt(l.data),to='0x'+l.topics[2].slice(-40),oldInput='0xa9059cbb'+w(to)+w(old),newInput='0xa9059cbb'+w(to)+w(next);for(const c of all)if(c.input===oldInput)c.input=newInput;for(const x of f.entry.receipt.logs)if(x.address===quote&&x.topics[1]===l.topics[1]&&x.topics[2]===l.topics[2]&&x.data==='0x'+w(old))x.data='0x'+w(next);}
  for(const c of all)if(c.input==='0xc0a9581d'+w(creatorRaw))c.input='0xc0a9581d'+w(creatorRaw-1n);
  const action=f.entry.receipt.logs.find(l=>l.topics[0]===fourMarketAbi.getEvent('TokenPurchase')!.topicHash)!,parsed=fourMarketAbi.parseLog(action)!,args=[...parsed.args];args[5]=creatorRaw-1n;const encoded=fourMarketAbi.encodeEventLog(parsed.fragment,args);action.data=encoded.data;action.topics=encoded.topics;certify(f.entry);
  const after=proof(f)!;expect(after).not.toBeNull();expect(after.payment).toEqual(before.payment);expect(after.amountQ).toBe(before.amountQ);expect(after.grossCostQ).toBe(before.grossCostQ);
  const changed=structuredClone(f),move=changed.entry.receipt.logs.find(l=>l.address===quote&&l.topics[0].startsWith('0xddf252ad')&&l.topics[2]===protocol.topics[2])!;move.data='0x'+w(BigInt(move.data)+1n);const oldInput='0xa9059cbb'+w('0x'+move.topics[2].slice(-40))+w(protocolRaw+1n),nextInput=oldInput.slice(0,-64)+w(protocolRaw+2n);for(const c of nodes(changed.entry.trace!))if(c.input===oldInput)c.input=nextInput;certify(changed.entry);expect(proof(changed)).toBeNull();
  const missing=structuredClone(f);missing.entry.receipt.logs=missing.entry.receipt.logs.filter(l=>!(l.address===quote&&l.topics[0].startsWith('0xddf252ad')&&l.topics[2]===protocol.topics[2]));certify(missing.entry);expect(proof(missing)).toBeNull();
  const extra=structuredClone(f);extra.entry.receipt.logs.push({...structuredClone(protocol),logIndex:'0xffff'});certify(extra.entry);expect(proof(extra)).toBeNull();
 });
 it('rejects recertified V3 changes to native cash, acquisition, callback, factory, balances, purchase and donation',()=>{
  const mutations:((f:Fixture)=>void)[]=[
   f=>{delete f.entry.completeTraceProof;},f=>{f.entry.wallets=[];},f=>{f.entry.transaction.authorizationList=[];},
   f=>{at(f.entry,proof(f)!.calls.quoteFactory!).output='0x'+'0'.repeat(64);},
   f=>{at(f.entry,proof(f)!.calls.quoteCallback!).calls![0].to='0x'+'1'.repeat(40);},
   f=>{at(f.entry,proof(f)!.calls.quoteSwap!).output='0x'+'0'.repeat(128);},
   f=>{at(f.entry,proof(f)!.calls.beforePaymentBalance).output='0x'+'0'.repeat(64);},
   f=>{at(f.entry,proof(f)!.calls.afterPaymentBalance).output='0x'+'0'.repeat(64);},
   f=>{at(f.entry,proof(f)!.calls.payment).input='0x23b872dd'+'0'.repeat(192);},
   f=>{at(f.entry,proof(f)!.calls.change).output='0x';},
   f=>{const n=nodes(f.entry.trace!).find(c=>c.type==='CALL'&&c.input?.startsWith('0xc0a9581d'))!;n.input=n.input!.slice(0,-1)+'0';},
   f=>{const n=nodes(f.entry.trace!).find(c=>c.type==='CALL'&&c.input==='0xd72dd3b4'+'0'.repeat(63)+'2')!;n.input='0xd72dd3b4'+'0'.repeat(63)+'1';},
   f=>{const n=nodes(f.entry.trace!).find(c=>c.type==='CALL'&&c.input?.startsWith('0x7f79f6df'))!;n.input=n.input!.slice(0,-1)+'1';},
   f=>{at(f.entry,proof(f)!.calls.deduction).value='0x1';},
   f=>{const n=nodes(f.entry.trace!).find(c=>c.type==='CALL'&&c.to===f.token&&c.input?.startsWith('0xa9059cbb'))!;n.calls![0].input='0xa9059cbb'+'0'.repeat(128);},
  ];for(const alter of mutations){const f=structuredClone(v3Fixtures[0]);alter(f);if(f.entry.completeTraceProof)certify(f.entry);expect(proof(f)).toBeNull();}
 });
 it('closes every nonstatic V3 asset or foreign payment call, including unknown selectors and additional quote reserves',()=>{
  for(const asset of['0x'+'1'.repeat(40),WBNB,v3Fixtures[0].token,'0x4902c5ebc598265ed2212b559b042de8a5eeec3f'])for(const selector of['0xa9059cbb','0x12345678']){
   const f=structuredClone(v3Fixtures[0]);f.entry.trace!.calls![0].calls!.push({type:'CALL',from:String(f.entry.transaction.to),to:asset,value:'0x0',input:selector+'0'.repeat(128),output:'0x'});certify(f.entry);expect(proof(f)).toBeNull();
  }
  for(const asset of[WBNB,v3Fixtures[0].token,'0x4902c5ebc598265ed2212b559b042de8a5eeec3f']){const f=structuredClone(v3Fixtures[0]),buy=nodes(f.entry.trace!).find(c=>c.type==='CALL'&&c.input?.startsWith('0x7f79f6df'))!;buy.calls!.push({type:'DELEGATECALL',from:buy.to!,to:asset,value:'0x0',input:'0x12345678'});certify(f.entry);expect(proof(f)).toBeNull();}
  for(const alter of[(f:Fixture)=>{const n=nodes(f.entry.trace!).find(c=>c.type==='CALL'&&c.input?.startsWith('0x2fdcfbd2'))!;n.input=n.input!.slice(0,-1)+'0';},(f:Fixture)=>{const n=nodes(f.entry.trace!).find(c=>c.type==='CALL'&&c.from===f.token&&c.input?.startsWith('0xa9059cbb'))!;n.to='0x'+'1'.repeat(40);},(f:Fixture)=>{const l=f.entry.receipt.logs.find(l=>l.topics[0].startsWith('0xddf252ad')&&l.topics[1]?.endsWith(f.token.slice(2)))!;l.data='0x'+'0'.repeat(63)+'1';}]){const f=structuredClone(v3Fixtures[3]);alter(f);certify(f.entry);expect(proof(f)).toBeNull();}
 });
 it.each(fixtures.map((_,i)=>i))('proves real acquired=used+returned quote units for original execution %s',i=>{
  const f=fixture(i),p=proof(f)!;expect(p).not.toBeNull();expect(BigInt(p.payment.spentQuoteRaw)+BigInt(p.payment.changeRaw)).toBe(BigInt(p.payment.acquiredQuoteRaw));
  expect(FreshRational.parse(p.amountQ).add(FreshRational.parse(p.retainedQuoteCostQ)).exact()).toBe(p.grossCostQ);
  expect(FreshRational.parse(p.retainedQuoteCostUsd).n).toBeGreaterThan(0n);expect(FreshRational.parse(p.amountUsd).compare(FreshRational.parse(p.grossCostUsd))).toBeLessThan(0);
  expect(BigInt(p.wrappedNativeWei)+BigInt(p.nativeRouterDeductionWei)).toBe(BigInt(f.entry.transaction.value));
 });
 it.each(fixtures.map((_,i)=>i))('repairs original execution %s using retained target precision/feed and no quote metadata or external reads',async i=>{
  const f=fixture(i),s=await decode(f),p=proof(f)!;expect(s.result.reasons).toEqual([]);expect(s.result.events).toHaveLength(1);
  const e=s.result.events[0];expect(e).toMatchObject({id:f.originalFinancialEvent.id,kind:'buy',tokenAddress:f.token,amountUsd:p.amountUsd,feeUsd:f.originalFinancialEvent.fee_usd,quoteAddress:WBNB,quoteSymbol:'BNB',quoteAmount:new FreshRational(BigInt(f.entry.transaction.value),10n**18n).decimal(),acquisitionCost:compactFreshAcquisitionCost(p)});
  expect(()=>validateFreshFinancialEvent(e)).not.toThrow();expect(s.missing).not.toHaveBeenCalled();expect(s.db.query).not.toHaveBeenCalled();expect(s.state.writes).toBe(0);
 });
 it('retains exact split attribution and refuses a changed historical conversion',async()=>{
  const f=fixture(),first=await decode(f);f.entry.recoveryEvidence=first.recovery.snapshot();const second=await decode(f);
  expect(second.result.events).toEqual(first.result.events);expect(second.missing).not.toHaveBeenCalled();expect(second.db.query).not.toHaveBeenCalled();
  const s=local(f);expect(await s.recovery.nativeQuoteChangeUsd(f.token,f.wallet,BigInt(f.targetRaw),f.nativePriceUsd,true)).toBe(proof(f)!.amountUsd);
  expect(await s.recovery.nativeQuoteChangeUsd(f.token,f.wallet,BigInt(f.targetRaw),'1000',true)).toBeNull();expect(s.missing).not.toHaveBeenCalled();
 });
 it('does not need or substitute quote precision, a quote peg, a market price or a zero basis',()=>{
  const f=fixture(),p=proof(f)!;f.entry.stateEvidence!.calls=f.entry.stateEvidence!.calls.filter(c=>c.to!==p.payment.quoteAddress);
  expect(proof(f)).toEqual(p);expect(p.amountUsd).toBe('300.259759047999996984562112119104397825');expect(p.retainedQuoteCostUsd).toBe('0.000000000000003015437887880895602175');
 });
 it('requires complete original execution identity, wallet, target amount and direction',()=>{
  for(const alter of[(f:Fixture)=>{delete f.entry.completeTraceProof;},(f:Fixture)=>{f.entry.completeTraceProof!.onlyTopCall=true as false;},(f:Fixture)=>{f.entry.wallets=[];},(f:Fixture)=>{f.entry.receipt.logs[0].transactionHash='0x'+'1'.repeat(64);},(f:Fixture)=>{f.targetRaw=String(BigInt(f.targetRaw)+1n);},(f:Fixture)=>{f.targetRaw=String(-BigInt(f.targetRaw));}]){const f=fixture();alter(f);expect(proof(f)).toBeNull();}
 });
 it('rejects existing router quote units, wrong acquisition/payment/change, failed transfer and unclosed cash',()=>{
  for(const mutate of[
   (f:Fixture)=>{at(f.entry,proof(f)!.calls.beforeAcquisitionBalance!).output='0x'+'0'.repeat(63)+'1';},
   (f:Fixture)=>{at(f.entry,proof(f)!.calls.payment).input='0x23b872dd'+'0'.repeat(192);},
   (f:Fixture)=>{at(f.entry,proof(f)!.calls.afterPaymentBalance).output='0x'+'0'.repeat(64);},
   (f:Fixture)=>{at(f.entry,proof(f)!.calls.change).output='0x';},
   (f:Fixture)=>{at(f.entry,proof(f)!.calls.wrappedPayment).error='reverted';},
   (f:Fixture)=>{f.entry.trace!.calls![0].calls!.push({type:'CALL',from:String(f.entry.transaction.to),to:'0x'+'1'.repeat(40),value:'0x1',input:'0x'});},
   (f:Fixture)=>{at(f.entry,proof(f)!.calls.deduction).to='0x'+'1'.repeat(40);},
   (f:Fixture)=>{const q=proof(f)!.payment.quoteAddress,l=f.entry.receipt.logs.find(l=>l.address===q&&l.topics[2]?.endsWith(f.wallet.slice(2)))!;l.data='0x'+'0'.repeat(63)+'1';}
  ]){const f=fixture();mutate(f);certify(f.entry);expect(proof(f)).toBeNull();}
 });
 it('rejects an unrelated purchase, another wallet asset or unauthenticated pair',()=>{
  for(const mutate of[
   (f:Fixture)=>{const l=f.entry.receipt.logs.find(l=>l.address===f.token&&l.topics[0].startsWith('0xddf252ad'))!;f.entry.receipt.logs.push({...l,address:'0x'+'1'.repeat(40),logIndex:'0xffff'});},
   (f:Fixture)=>{const p=proof(f)!,pair=p.poolAddress;f.entry=JSON.parse(JSON.stringify(f.entry).replaceAll(pair.slice(2),'1'.repeat(40)));},
   (f:Fixture)=>{const c=nodes(f.entry.trace!).find(c=>c.input==='0xc45a0155')!;c.output='0x'+'0'.repeat(64);},
   (f:Fixture)=>{f.entry.transaction.input=String(f.entry.transaction.input).replace(/^0x4d819a2a/,'0x12345678');f.entry.trace!.input=String(f.entry.transaction.input);}
  ]){const f=fixture();mutate(f);certify(f.entry);expect(proof(f)).toBeNull();}
 });
 it('binds a non-registered compact proof to this exact event and checks every cost equation',async()=>{
  const{result}=await decode(fixture()),original=result.events[0];
  for(const mutate of[
   (e:typeof original)=>{delete e.acquisitionCost!.intermediateQuoteProof;},
   (e:typeof original)=>{e.acquisitionCost!.intermediateQuoteProof!.walletAddress='0x'+'1'.repeat(40);},
   (e:typeof original)=>{e.acquisitionCost!.intermediateQuoteProof!.blockHash='0x'+'1'.repeat(64);},
   (e:typeof original)=>{e.acquisitionCost!.intermediateQuoteProof!.proofSha256='';},
   (e:typeof original)=>{e.acquisitionCost!.quoteSpentRaw=String(BigInt(e.acquisitionCost!.quoteSpentRaw)+1n);},
   (e:typeof original)=>{e.acquisitionCost!.remainingQuoteCostUsd='0';},
   (e:typeof original)=>{e.feeUsd='0';},
   (e:typeof original)=>{e.amountUsd=e.acquisitionCost!.grossCostUsd;}
  ]){const e=structuredClone(original);mutate(e);expect(()=>validateFreshFinancialEvent(e)).toThrow('invalid_acquisition_cost_basis');}
 });
});
