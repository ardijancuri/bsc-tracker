import{describe,it,expect,vi}from'vitest';
import type{Rpc}from'../rpc.js';
import{PCS_V2_FACTORY,WBNB}from'../launchpad.js';
import{poolMarketAbi}from'../nodeMarketProtocols.js';
import{factoryCode,pairCode}from'./currentQuote.fixture.js';
import{freshPoolNativePair}from'./currentPoolQuote.js';
import{recoverFreshRetainedPoolNativeQuote}from'./retainedPoolQuote.js';
const quote='0x'+'8'.repeat(40),hash='0x'+'a'.repeat(64),other='0x'+'b'.repeat(64);
function fixture(){
 const target={number:10000,hash,timestamp:new Date().toISOString()},pair=freshPoolNativePair(quote),assets=[quote,WBNB].sort();
 const rpc=vi.fn(async(method:string,params:any[])=>{
  if(method==='eth_chainId'){expect(params).toEqual([]);return'0x38';}
  expect(params[1]).toEqual({blockHash:hash,requireCanonical:true});
  if(method==='eth_getCode')return params[0]===PCS_V2_FACTORY?factoryCode:pairCode;
  expect(method).toBe('eth_call');const call=params[0],parsed=poolMarketAbi.parseTransaction(call)!;
  const values:Record<string,unknown[]>={getPair:[pair],factory:[PCS_V2_FACTORY],token0:[assets[0]],token1:[assets[1]],getReserves:[10n**6n,2n*10n**18n,1]};
  expect(call.to).toBe(parsed.name==='getPair'?PCS_V2_FACTORY:pair);return poolMarketAbi.encodeFunctionResult(parsed.name,values[parsed.name]);
 })as unknown as Rpc;
 return{target,pair,rpc,options:{rpc,quoteAddress:quote,target,canonicalHash:async()=>hash}};
}
describe('retained original-block raw native conversion',()=>{
 it('authenticates the exact original factory/pair code and five raw identity/state reads without quote precision or Sync substitution',async()=>{
  const f=fixture(),proof=await recoverFreshRetainedPoolNativeQuote(f.options);
  expect(proof).toMatchObject({kind:'retained_target_pool_native_v2',observation:'block_end',nativeRaw:String(2n*10n**18n),quoteRaw:'1000000',code:{block:f.target}});
  expect(proof.source.calls).toHaveLength(5);expect((f.rpc as any).mock.calls).toHaveLength(8);
  expect(JSON.stringify(proof)).not.toMatch(/decimals|lastSync|before_execution/);
  const none=vi.fn(async()=>{throw Error('all_historical_state_and_logs_pruned');})as unknown as Rpc;
  expect(await recoverFreshRetainedPoolNativeQuote({...f.options,rpc:none,prior:proof,source:proof.source})).toEqual(proof);expect(none).not.toHaveBeenCalled();
 });
 it('rejects malformed code, wrong chain, noncanonical identity, empty reserves and unregistered pair',async()=>{
  for(const mode of['factory','pair','chain','registry','empty']as const){
   const f=fixture(),base=f.rpc,rpc=(async(method:string,p:any[])=>{
    if(mode==='chain'&&method==='eth_chainId')return'0x1';
    if(method==='eth_getCode'&&(mode==='factory'&&p[0]===PCS_V2_FACTORY||mode==='pair'&&p[0]===f.pair))return'0x00';
    if(method==='eth_call'&&mode==='registry'&&p[0].data.startsWith(poolMarketAbi.getFunction('getPair')!.selector))return poolMarketAbi.encodeFunctionResult('getPair',[quote]);
    if(method==='eth_call'&&mode==='empty'&&p[0].data===poolMarketAbi.encodeFunctionData('getReserves'))return poolMarketAbi.encodeFunctionResult('getReserves',[0,1,1]);
    return base(method,p);
   })as Rpc;
   await expect(recoverFreshRetainedPoolNativeQuote({...f.options,rpc})).rejects.toThrow();
  }
  const f=fixture();await expect(recoverFreshRetainedPoolNativeQuote({...f.options,canonicalHash:async()=>other})).rejects.toThrow('retained_pool_quote_noncanonical');
 });
 it('never accepts another target, altered source, extra calls, mixed proof kind or invented observation',async()=>{
  const f=fixture(),prior=await recoverFreshRetainedPoolNativeQuote(f.options),none=(async()=>{throw Error('no_rpc');})as Rpc;
  for(const patch of[{observation:'before_execution'},{nativeRaw:'1'},{target:{...prior.target,hash:other}},{code:{...prior.code,pairRuntimeHash:other}},
   {source:{...prior.source,calls:[...prior.source.calls,prior.source.calls[0]]}},{kind:'historical_raw_pool_native_v2'}]){
   await expect(recoverFreshRetainedPoolNativeQuote({...f.options,rpc:none,prior:{...prior,...patch}as typeof prior})).rejects.toThrow();
  }
  const source=structuredClone(prior.source);source.calls[0].result=poolMarketAbi.encodeFunctionResult('getPair',[quote]);
  await expect(recoverFreshRetainedPoolNativeQuote({...f.options,rpc:none,prior,source})).rejects.toThrow('retained_pool_quote_source_conflict');
 });
});
