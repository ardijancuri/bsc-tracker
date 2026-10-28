import {Interface} from 'ethers';import{describe,it,expect}from'vitest';import type{Rpc}from'../rpc.js';
import{PCS_V2_FACTORY}from'../launchpad.js';import{factoryCode,pairCode}from'./currentQuote.fixture.js';
import{freshPoolNativePair}from'./currentPoolQuote.js';import{recoverFreshHistoricalPoolNativeQuote}from'./historicalPoolQuote.js';
import type{FreshLog}from'./capture.js';
const quote='0x'+'9'.repeat(40),pair=freshPoolNativePair(quote),h=(n:number)=>'0x'+n.toString(16).padStart(64,'0'),hex=(n:number)=>'0x'+n.toString(16);
const abi=new Interface(['event Sync(uint112 reserve0,uint112 reserve1)']);
function fixture(){
 const target={number:10000,hash:h(10000),timestamp:new Date(Date.now()-20000).toISOString()},anchor={number:10020,hash:h(10020),timestamp:new Date().toISOString()};
 const sync=(n:number,index:number,reserve1=100n*10n**18n):FreshLog=>({address:pair,...abi.encodeEventLog('Sync',[5n*10n**6n,reserve1]),blockNumber:hex(n),blockHash:h(n),transactionIndex:hex(index),transactionHash:h(100000+n+index),logIndex:'0x1'});
 const logs=[sync(9990,1),sync(10000,2),sync(10000,5,999n*10n**18n)],calls:string[]=[],ranges:number[]=[],codes=new Map([[PCS_V2_FACTORY,factoryCode],[pair,pairCode]]);
 const rpc=(async(method:string,params:any[])=>{calls.push(method);if(method==='eth_chainId')return'0x38';if(method==='eth_getCode'){expect(params[1]).toEqual({blockHash:anchor.hash,requireCanonical:true});return codes.get(params[0]);}
  if(method==='eth_getLogs'){const from=Number(BigInt(params[0].fromBlock));ranges.push(from);expect([9937,9745,8977,5905,0]).toContain(from);expect(params[0]).toEqual({address:pair,fromBlock:hex(from),toBlock:hex(10000),topics:[abi.getEvent('Sync')!.topicHash]});return logs.filter(log=>Number(BigInt(log.blockNumber))>=from);}throw Error('unapproved_rpc');})as Rpc;
 return{logs,calls,ranges,codes,sync,options:{rpc,quoteAddress:quote,target,anchor,transactionIndex:3,canonicalHash:async(n:number)=>h(n)}};
}
describe('historical authenticated raw quote/native conversion',()=>{
 it('uses only canonical pre-execution Sync and never calls mutable decimals or current reserve state',async()=>{
  const f=fixture(),proof=await recoverFreshHistoricalPoolNativeQuote(f.options);
  expect(proof).toMatchObject({quoteAddress:quote,quoteRaw:'5000000',nativeRaw:String(100n*10n**18n),pool:{address:pair,lastSync:{transactionIndex:'0x2'}}});
  expect(f.calls).not.toContain('eth_call');expect(JSON.stringify(proof)).not.toContain('decimals');
 });
 it('revalidates a retained proof without fresh RPC and rejects changed ratio, quote and pair identity',async()=>{
  const f=fixture(),prior=await recoverFreshHistoricalPoolNativeQuote(f.options),rpc=(async()=>{throw Error('no_rpc');})as Rpc;
  expect(await recoverFreshHistoricalPoolNativeQuote({...f.options,prior,rpc})).toEqual(prior);
  for(const patch of[{nativeRaw:'1'},{quoteRaw:'1'},{quoteAddress:PCS_V2_FACTORY},{pool:{...prior.pool,address:PCS_V2_FACTORY}},{transactionIndex:2}])
   await expect(recoverFreshHistoricalPoolNativeQuote({...f.options,prior:{...prior,...patch},rpc})).rejects.toThrow('historical_pool_quote_prior_invalid');
 });
 it('rejects absent, same-execution, future and orphaned reserve observations',async()=>{
  for(const index of[3,4]){const f=fixture();f.logs.splice(0,3,f.sync(10000,index));await expect(recoverFreshHistoricalPoolNativeQuote(f.options)).rejects.toThrow('flap_quote_sync_unavailable');}
  const f=fixture();f.logs.splice(0);await expect(recoverFreshHistoricalPoolNativeQuote(f.options)).rejects.toThrow('flap_quote_sync_unavailable');
  const g=fixture();g.logs[0].blockHash=h(9);await expect(recoverFreshHistoricalPoolNativeQuote(g.options)).rejects.toThrow('historical_pool_quote_noncanonical');
 });
 it('allows a later empty-pool Sync while requiring positive reserves for the selected preceding state',async()=>{
  const f=fixture();f.logs[2].data=abi.encodeEventLog('Sync',[0n,0n]).data;
  expect(await recoverFreshHistoricalPoolNativeQuote(f.options)).toMatchObject({quoteRaw:'5000000',nativeRaw:String(100n*10n**18n)});
  const g=fixture();g.logs[1].data=abi.encodeEventLog('Sync',[0n,0n]).data;
  await expect(recoverFreshHistoricalPoolNativeQuote(g.options)).rejects.toThrow('flap_quote_pool_empty');
 });
 it('makes block-end transfer observations explicit and prevents reusing their later state for trade settlement',async()=>{
  const f=fixture(),end=await recoverFreshHistoricalPoolNativeQuote({...f.options,observation:'block_end'});
  expect(end).toMatchObject({observation:'block_end',nativeRaw:String(999n*10n**18n),pool:{lastSync:{transactionIndex:'0x5'}}});
  await expect(recoverFreshHistoricalPoolNativeQuote({...f.options,prior:end})).rejects.toThrow('historical_pool_quote_prior_invalid');
 });
 it('rejects target/code-anchor reorgs, false immutable templates and expired first-use anchors',async()=>{
  const f=fixture();for(const number of[10000,10020])await expect(recoverFreshHistoricalPoolNativeQuote({...f.options,canonicalHash:async n=>h(n===number?9:n)})).rejects.toThrow('historical_pool_quote_noncanonical');
  const g=fixture();g.codes.set(pair,'0x00');await expect(recoverFreshHistoricalPoolNativeQuote(g.options)).rejects.toThrow('historical_pool_quote_code_invalid');
  const j=fixture();j.codes.set(PCS_V2_FACTORY,'0x00');await expect(recoverFreshHistoricalPoolNativeQuote(j.options)).rejects.toThrow('flap_quote_factory_code_invalid');
  const k=fixture();k.options.anchor.timestamp=new Date(Date.now()-31000).toISOString();k.options.target.timestamp=new Date(Date.now()-60000).toISOString();await expect(recoverFreshHistoricalPoolNativeQuote(k.options)).rejects.toThrow('historical_pool_quote_anchor_stale');
 });
 it('validates complete bounded logs, including later rows, before selecting earlier state',async()=>{
  const f=fixture();f.logs[2].data='0x';await expect(recoverFreshHistoricalPoolNativeQuote(f.options)).rejects.toThrow('flap_quote_sync_invalid');
  const g=fixture();g.logs.splice(0,3,...Array(513).fill(g.sync(9999,0)));await expect(recoverFreshHistoricalPoolNativeQuote(g.options)).rejects.toThrow('flap_quote_work_bounds');
  const j=fixture();j.logs.reverse();await expect(recoverFreshHistoricalPoolNativeQuote(j.options)).rejects.toThrow('flap_quote_sync_order_invalid');
 });
 it('uses a complete small window in busy pools and expands only for genuinely absent earlier state',async()=>{
  const f=fixture(),proof=await recoverFreshHistoricalPoolNativeQuote(f.options);expect(f.ranges).toEqual([9937]);expect(proof.fromBlock).toBe(9937);
  const g=fixture();g.logs.splice(0,3,g.sync(9800,1));const older=await recoverFreshHistoricalPoolNativeQuote(g.options);
  expect(g.ranges).toEqual([9937,9745]);expect(older.fromBlock).toBe(9745);
  expect(await recoverFreshHistoricalPoolNativeQuote({...g.options,prior:older,rpc:(async()=>{throw Error('no_rpc');})as Rpc})).toEqual(older);
  await expect(recoverFreshHistoricalPoolNativeQuote({...g.options,prior:{...older,fromBlock:9744}})).rejects.toThrow('historical_pool_quote_prior_invalid');
  const missing=fixture();missing.logs.length=0;await expect(recoverFreshHistoricalPoolNativeQuote(missing.options)).rejects.toThrow('flap_quote_sync_unavailable');expect(missing.ranges).toEqual([9937,9745,8977,5905,0]);
 });
 it('recovers an old quiet-pool Sync through one final bounded window and retains its canonical proof',async()=>{
  const f=fixture(),target={...f.options.target,number:300000,hash:h(300000)},anchor={...f.options.anchor,number:300020,hash:h(300020)},logs=[f.sync(110000,1)],ranges:number[]=[];
  const rpc=(async(method:string,params:any[])=>{if(method==='eth_chainId')return'0x38';if(method==='eth_getCode'){expect(params[1]).toEqual({blockHash:anchor.hash,requireCanonical:true});return f.codes.get(params[0]);}
   if(method==='eth_getLogs'){const from=Number(BigInt(params[0].fromBlock));ranges.push(from);expect(params[0]).toEqual({address:pair,fromBlock:hex(from),toBlock:hex(target.number),topics:[abi.getEvent('Sync')!.topicHash]});return logs.filter(l=>Number(BigInt(l.blockNumber))>=from);}throw Error('unapproved_rpc');})as Rpc;
  const options={...f.options,rpc,target,anchor},proof=await recoverFreshHistoricalPoolNativeQuote(options);
  expect(ranges).toEqual([299937,299745,298977,295905,37857]);expect(proof).toMatchObject({fromBlock:37857,quoteRaw:'5000000',nativeRaw:String(100n*10n**18n),pool:{lastSync:{blockNumber:hex(110000)}}});
  expect(await recoverFreshHistoricalPoolNativeQuote({...options,prior:proof,rpc:(async()=>{throw Error('no_rpc');})as Rpc})).toEqual(proof);
  await expect(recoverFreshHistoricalPoolNativeQuote({...options,prior:proof,canonicalHash:async n=>h(n===110000?9:n)})).rejects.toThrow('historical_pool_quote_noncanonical');
  logs.splice(0,1,...Array(513).fill(f.sync(110000,1)));await expect(recoverFreshHistoricalPoolNativeQuote(options)).rejects.toThrow('flap_quote_work_bounds');
 });
});
