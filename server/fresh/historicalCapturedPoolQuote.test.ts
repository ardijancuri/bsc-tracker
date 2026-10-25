import{getCreate2Address,Interface,solidityPackedKeccak256}from'ethers';import{describe,it,expect}from'vitest';import type{Rpc}from'../rpc.js';
import{WBNB,PCS_V2_FACTORY}from'../launchpad.js';import{poolMarketAbi,erc20MarketAbi}from'../nodeMarketProtocols.js';
import{factoryCode,pairCode}from'./currentQuote.fixture.js';import{freshPoolNativePair}from'./currentPoolQuote.js';
import{FRESH_PCS_V2_PAIR_INITCODE_HASH}from'./flapQuoteRecovery.js';import type{FreshStateReadEvidence}from'./stateEvidence.js';
import type{FreshTokenMetadata}from'./pricing.js';import type{FreshLog}from'./capture.js';
import{readFreshCapturedV2Pools,recoverFreshHistoricalCapturedPoolQuote}from'./historicalCapturedPoolQuote.js';
const token='0x'+'1'.repeat(40),quote='0x'+'9'.repeat(40),h=(n:number)=>'0x'+n.toString(16).padStart(64,'0'),hex=(n:number)=>'0x'+n.toString(16);
const syncAbi=new Interface(['event Sync(uint112 reserve0,uint112 reserve1)']);
function fixture(quoteAddress=quote){
 const target={number:10000,hash:h(10000),timestamp:new Date(Date.now()-600000).toISOString()},anchor={number:10020,hash:h(10020),timestamp:new Date().toISOString()};
 const assets=[token,quoteAddress].sort(),pool=getCreate2Address(PCS_V2_FACTORY,solidityPackedKeccak256(['address','address'],assets),FRESH_PCS_V2_PAIR_INITCODE_HASH).toLowerCase();
 const metadata:FreshTokenMetadata={address:token,decimals:6,name:null,symbol:null,supplyRaw:null,block:target};
 const source:FreshStateReadEvidence={version:1,blockNumber:target.number,blockHash:target.hash,calls:[]};
 const set=(to:string,method:string,args:unknown[],values:unknown[])=>{source.calls.push({to,data:poolMarketAbi.encodeFunctionData(method,args),result:poolMarketAbi.encodeFunctionResult(method,values)});};
 source.calls.push({to:token,data:erc20MarketAbi.encodeFunctionData('decimals'),result:erc20MarketAbi.encodeFunctionResult('decimals',[6])});
 set(PCS_V2_FACTORY,'getPair',[token,quoteAddress],[pool]);set(pool,'factory',[],[PCS_V2_FACTORY]);set(pool,'token0',[],[assets[0]]);set(pool,'token1',[],[assets[1]]);
 const tokenRaw=5n*10n**6n,quoteRaw=quoteAddress===WBNB?10n**18n:10n**6n;
 set(pool,'getReserves',[],assets[0]===token?[tokenRaw,quoteRaw,1]:[quoteRaw,tokenRaw,1]);
 const conversionPool=freshPoolNativePair(quoteAddress),log:FreshLog={address:conversionPool,...syncAbi.encodeEventLog('Sync',[10n**6n,2n*10n**18n]),blockNumber:hex(target.number),blockHash:target.hash,transactionHash:h(1),transactionIndex:'0x5',logIndex:'0x1'};
 const methods:string[]=[],codes=new Map([[PCS_V2_FACTORY,factoryCode],[pool,pairCode],[conversionPool,pairCode]]);
 const rpc=(async(method:string,params:any[])=>{methods.push(method);if(method==='eth_chainId')return'0x38';if(method==='eth_getCode')return codes.get(params[0]);if(method==='eth_getLogs')return[log];throw Error('no_historical_or_current_state');})as Rpc;
 return{source,metadata,pool,methods,codes,log,options:{tokenAddress:token,target,source,anchor,rpc,canonicalHash:async(n:number)=>h(n)}};
}
describe('original target-block captured PCS V2 transfer valuation',()=>{
 it('requires original target getPair/assets/factory/reserves and composes exact block-end quote/native conversion without historical quote precision',async()=>{
  const f=fixture(),proof=await recoverFreshHistoricalCapturedPoolQuote(f.options);
  expect(proof).toMatchObject({priceNative:'0.4',quoteLiquidityNative:'2',pool:{pool:f.pool,tokenDecimals:6},conversion:{observation:'block_end',pool:{lastSync:{transactionIndex:'0x5'}}}});
  expect(f.methods).not.toContain('eth_call');expect(JSON.stringify(proof)).not.toContain('quoteDecimals');
 });
 it('marks captured native-quote reserves directly and authenticates their immutable code',async()=>{
  const f=fixture(WBNB),proof=await recoverFreshHistoricalCapturedPoolQuote(f.options);
  expect(proof).toMatchObject({priceNative:'0.2',quoteLiquidityNative:'1',conversion:null});expect(f.methods).not.toContain('eth_getLogs');
  const g=fixture(WBNB);g.codes.set(g.pool,'0x00');await expect(recoverFreshHistoricalCapturedPoolQuote(g.options)).rejects.toThrow('captured_pool_quote_unavailable');
 });
 it('revalidates retained source, exact selected pool, price and canonical identity without network and rejects tampering',async()=>{
  const f=fixture(),prior=await recoverFreshHistoricalCapturedPoolQuote(f.options),rpc=(async()=>{throw Error('no_rpc');})as Rpc;
  expect(await recoverFreshHistoricalCapturedPoolQuote({...f.options,prior,rpc})).toEqual(prior);
  for(const patch of[{priceNative:'0'},{pool:{...prior.pool,tokenRaw:'1'}},{rawNativeRatio:{numerator:'1',denominator:'1'}},{conversion:{...prior.conversion!,observation:'before_execution'}},{code:{...prior.code,pairRuntimeHash:h(9)}}])
   await expect(recoverFreshHistoricalCapturedPoolQuote({...f.options,prior:{...prior,...patch}as typeof prior,rpc})).rejects.toThrow();
 });
 it('requires retained token precision or independently revalidated metadata for the exact same token and target',()=>{
  const f=fixture();f.source.calls=f.source.calls.filter(c=>c.to!==token);
  expect(()=>readFreshCapturedV2Pools(f.options)).toThrow('captured_pool_precision_unverified');
  expect(readFreshCapturedV2Pools({...f.options,verifiedMetadata:f.metadata})).toHaveLength(1);
  expect(()=>readFreshCapturedV2Pools({...f.options,verifiedMetadata:{...f.metadata,block:{...f.metadata.block,hash:h(8)}}})).toThrow('captured_pool_precision_unverified');
 });
 it('never fills missing captured pool reads through current lookups and rejects empty/contradictory reserves and false pool identity',()=>{
  for(const method of['getPair','factory','token0','token1','getReserves']){const f=fixture();f.source.calls=f.source.calls.filter(c=>!c.data.startsWith(poolMarketAbi.getFunction(method)!.selector));expect(readFreshCapturedV2Pools(f.options)).toEqual([]);expect(f.methods).toEqual([]);}
  for(const mutate of[(f:ReturnType<typeof fixture>)=>{f.source.calls.find(c=>c.data===poolMarketAbi.encodeFunctionData('token0'))!.result=poolMarketAbi.encodeFunctionResult('token0',[quote]);},
    (f:ReturnType<typeof fixture>)=>{f.source.calls.find(c=>c.data===poolMarketAbi.encodeFunctionData('getReserves'))!.result=poolMarketAbi.encodeFunctionResult('getReserves',[0,1,1]);},
    (f:ReturnType<typeof fixture>)=>{f.source.calls.find(c=>c.data.startsWith(poolMarketAbi.getFunction('getPair')!.selector))!.result=poolMarketAbi.encodeFunctionResult('getPair',[quote]);}]){const f=fixture();mutate(f);expect(readFreshCapturedV2Pools(f.options)).toEqual([]);}
 });
 it('rejects source corruption, canonical reorgs, stale/invalid anchors, false chain and factory templates',async()=>{
  const f=fixture();f.source.calls.push(f.source.calls[0]);expect(()=>readFreshCapturedV2Pools(f.options)).toThrow('captured_pool_source_invalid');
  const g=fixture();g.source.blockHash=h(9);expect(()=>readFreshCapturedV2Pools(g.options)).toThrow('captured_pool_source_invalid');
  for(const n of[10000,10020]){const j=fixture();await expect(recoverFreshHistoricalCapturedPoolQuote({...j.options,canonicalHash:async v=>h(v===n?9:v)})).rejects.toThrow('captured_pool_noncanonical');}
  const k=fixture();k.options.anchor.timestamp='invalid';await expect(recoverFreshHistoricalCapturedPoolQuote(k.options)).rejects.toThrow('captured_pool_noncanonical');
  const l=fixture();l.options.anchor.timestamp=new Date(Date.now()-31000).toISOString();await expect(recoverFreshHistoricalCapturedPoolQuote(l.options)).rejects.toThrow('captured_pool_anchor_stale');
  const m=fixture();m.codes.set(PCS_V2_FACTORY,'0x00');await expect(recoverFreshHistoricalCapturedPoolQuote(m.options)).rejects.toThrow('flap_quote_factory_code_invalid');
  const p=fixture();await expect(recoverFreshHistoricalCapturedPoolQuote({...p.options,rpc:(async()=> '0x1')as Rpc})).rejects.toThrow('captured_pool_chain_invalid');
 });
});
