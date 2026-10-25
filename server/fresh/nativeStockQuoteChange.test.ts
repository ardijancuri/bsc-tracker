import{describe,it,expect,vi}from'vitest';import{readFileSync}from'node:fs';import{gunzipSync}from'node:zlib';import type{Pool}from'pg';
import{freshNativeQuoteChange,freshNativeStockQuoteChange,valueFreshNativeStockQuoteChange}from'./nativeQuoteChange.js';
import{recoverFreshStockRawQuote,FRESH_STOCK_QUOTE_TOKEN,type FreshStockRawQuoteEvidence}from'./stockQuote.js';
import{createFreshReceiptRecovery}from'./recovery.js';import{FreshRational}from'./accounting.js';import type{FreshCapturedReceipt}from'./capture.js';import type{FreshPriceBlock}from'./pricing.js';import type{Rpc}from'../rpc.js';
const fixture=()=>JSON.parse(gunzipSync(readFileSync(new URL('./fixtures/native-nvdab-change.json.gz',import.meta.url))).toString())as{sample:{block:FreshPriceBlock;entry:FreshCapturedReceipt;token:string;wallet:string;targetRaw:string};conversion:FreshStockRawQuoteEvidence;staleControls:{target:FreshPriceBlock;calls:{method:string;params:unknown[];result:any}[]}[]};
describe('native purchase with genuine NVDAB change',()=>{
 it('uses the complete actual payment and a canonical earlier WOO settlement without any NVDAB precision or assumed peg',async()=>{
  const f=fixture(),s=f.sample,p=freshNativeStockQuoteChange(s.entry,s.block,s.token,s.wallet,BigInt(s.targetRaw));
  expect(p).toMatchObject({kind:'wallet_native_purchase_with_nvdab_change',quoteAddress:FRESH_STOCK_QUOTE_TOKEN,changeRaw:'34'});
  expect(freshNativeQuoteChange(s.entry,s.block,s.token,s.wallet,BigInt(s.targetRaw))).toBeNull();
  const noRpc=vi.fn(async()=>{throw Error('unexpected_network');})as unknown as Rpc;
  const c=await recoverFreshStockRawQuote({rpc:noRpc,target:s.block,canonicalHash:async n=>n===s.block.number?s.block.hash:n===f.conversion.source.number?f.conversion.source.hash:null,prior:f.conversion});
  expect(noRpc).not.toHaveBeenCalled();expect(c.source.number).toBeLessThan(s.block.number);expect(Date.parse(s.block.timestamp)-Date.parse(c.source.timestamp)).toBe(26000);
  const v=valueFreshNativeStockQuoteChange(p!,c,'700')!,gross=new FreshRational(BigInt(p!.nativeSpentWei),10n**18n).mul(FreshRational.parse('700'));
  const change=new FreshRational(34n*BigInt(c.nativeRaw),BigInt(c.quoteRaw)*10n**18n).mul(FreshRational.parse('700'));
  expect(v.kind).toBe('historical_native_purchase_with_nvdab_change');expect(v.amountQ).toBe(gross.sub(change).exact());expect(v.changeQ).toBe(change.exact());expect(v.changeQ).not.toBe('0');
 });
 it('reproduces both actual stale-control failures rather than pricing with their older reference',async()=>{
  const f=fixture();expect(f.staleControls).toHaveLength(2);
  for(const control of f.staleControls){let index=0;const rpc=vi.fn(async(method:string,params:unknown[])=>{const next=control.calls[index++];expect({method,params}).toEqual({method:next.method,params:next.params});return next.result;})as unknown as Rpc;
   const header=control.calls.find(c=>c.method==='eth_getBlockByNumber')!.result;
   await expect(recoverFreshStockRawQuote({rpc,target:control.target,canonicalHash:async n=>n===control.target.number?control.target.hash:n===Number(BigInt(header.number))?header.hash:null})).rejects.toThrow('stock_quote_stale');expect(index).toBe(4);
  }
 });
 it('keeps full flow, fee, calldata, freshness and source identity guards for the second explicitly supported quote',()=>{
  const f=fixture(),s=f.sample,prove=(e:FreshCapturedReceipt)=>freshNativeStockQuoteChange(e,s.block,s.token,s.wallet,BigInt(s.targetRaw)),p=prove(s.entry)!;
  const at=(e:FreshCapturedReceipt,path:number[])=>path.reduce((c,index)=>c.calls![index],e.trace!);
  for(const mutation of[(e:FreshCapturedReceipt)=>{at(e,p.calls.change).output='0x';},(e:FreshCapturedReceipt)=>{at(e,p.calls.beforePaymentBalance).output='0x'+'0'.repeat(64);},(e:FreshCapturedReceipt)=>{e.transaction.authorizationList=[];},(e:FreshCapturedReceipt)=>{delete e.trace!.input;},(e:FreshCapturedReceipt)=>{e.receipt.logs.push({...e.receipt.logs[0],address:'0x'+'1'.repeat(40),logIndex:'0xffff',topics:[e.receipt.logs.find(l=>l.address===FRESH_STOCK_QUOTE_TOKEN&&l.topics.length===3)!.topics[0],'0x'+'0'.repeat(24)+'2'.repeat(40),'0x'+'0'.repeat(24)+s.wallet.slice(2)],data:'0x'+'0'.repeat(63)+'1'});}]){const e=structuredClone(s.entry);mutation(e);expect(prove(e)).toBeNull();}
  for(const patch of[{source:{...f.conversion.source,number:s.block.number}},{source:{...f.conversion.source,timestamp:new Date(Date.parse(s.block.timestamp)-120001).toISOString()}},{target:{...s.block,hash:'0x'+'a'.repeat(64)}},{quoteToken:'0x'+'b'.repeat(40)}])expect(valueFreshNativeStockQuoteChange(p,{...f.conversion,...patch}as FreshStockRawQuoteEvidence,'700')).toBeNull();
 });
 it('revalidates the distinct retained route with zero network and never reprices an already saved financial result',async()=>{
  const f=fixture(),s=f.sample,p=freshNativeStockQuoteChange(s.entry,s.block,s.token,s.wallet,BigInt(s.targetRaw))!,v=valueFreshNativeStockQuoteChange(p,f.conversion,'700')!;
  const noRpc=vi.fn(async()=>{throw Error('unexpected_network');})as unknown as Rpc,db={query:vi.fn(async(_sql:string,[number]:number[])=>({rows:[{block_hash:number===s.block.number?s.block.hash:number===f.conversion.source.number?f.conversion.source.hash:null}]}))}as unknown as Pool;
  const e=structuredClone(s.entry);e.recoveryEvidence={version:1,target:s.block,metadata:{},quotes:[],pools:[],nativeStockQuoteChanges:[v]};
  const r=createFreshReceiptRecovery(db,noRpc,e,s.block);expect(await r.nativeQuoteChangeUsd(s.token,s.wallet,BigInt(s.targetRaw),'700',true)).toBe(v.amountUsd);expect(noRpc).not.toHaveBeenCalled();expect(r.snapshot()?.nativeStockQuoteChanges).toEqual([v]);
  const changed=createFreshReceiptRecovery(db,noRpc,e,s.block);expect(await changed.nativeQuoteChangeUsd(s.token,s.wallet,BigInt(s.targetRaw),'701',true)).toBeNull();expect(noRpc).not.toHaveBeenCalled();
 });
});
