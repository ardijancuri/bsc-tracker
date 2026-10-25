import { Interface } from 'ethers';
import { describe, expect, it } from 'vitest';
import { PCS_V2_FACTORY } from '../launchpad.js';
import type { Rpc } from '../rpc.js';
import type { FreshLog } from './capture.js';
import { factoryCode, pairCode } from './currentQuote.fixture.js';
import { FRESH_HISTORICAL_BTCB_PAIR, recoverFreshHistoricalNativeQuote } from './historicalNativeQuote.js';
const h=(n:number)=>'0x'+n.toString(16).padStart(64,'0'),hex=(n:number)=>'0x'+n.toString(16),abi=new Interface(['event Sync(uint112 reserve0,uint112 reserve1)']);
function fixture(){
 const target={number:10000,hash:h(10000),timestamp:new Date(Date.now()-20000).toISOString()},anchor={number:10020,hash:h(10020),timestamp:new Date().toISOString()};
 const sync=(n:number,index:number,reserve0=10n**18n,reserve1=100n*10n**18n):FreshLog=>({address:FRESH_HISTORICAL_BTCB_PAIR,...abi.encodeEventLog('Sync',[reserve0,reserve1]),
  blockNumber:hex(n),blockHash:h(n),transactionIndex:hex(index),transactionHash:h(n+index+100000),logIndex:'0x1'});
 const logs=[sync(9990,1),sync(10000,2,10n**18n,101n*10n**18n),sync(10000,5,10n**18n,999n*10n**18n)];
 const codes=new Map([[PCS_V2_FACTORY,factoryCode],[FRESH_HISTORICAL_BTCB_PAIR,pairCode]]),calls:string[]=[];let chain='0x38';
 const rpc=(async(method:string,params:any[])=>{calls.push(method);if(method==='eth_chainId')return chain;if(method==='eth_getCode'){expect(params[1]).toEqual({blockHash:anchor.hash,requireCanonical:true});return codes.get(params[0]);}
  if(method==='eth_getLogs'){expect(params[0]).toEqual({address:FRESH_HISTORICAL_BTCB_PAIR,fromBlock:hex(5905),toBlock:hex(10000),topics:[abi.getEvent('Sync')!.topicHash]});return logs;}throw Error('unexpected_rpc');})as Rpc;
 return{logs,codes,calls,sync,setChain:(value:string)=>{chain=value;},options:{rpc,target,anchor,transactionIndex:3,canonicalHash:async(n:number)=>h(n)}};
}
describe('historical BTCB raw native conversion for a direct Flap purchase',()=>{
 it('uses genuine pre-transaction Sync state and no mutable ERC20 precision or current reserves',async()=>{
  const f=fixture(),proof=await recoverFreshHistoricalNativeQuote(f.options);
  expect(proof.nativeRaw).toBe(String(101n*10n**18n));expect(proof.quoteRaw).toBe(String(10n**18n));expect(proof.pool.lastSync.transactionIndex).toBe('0x2');
  expect(proof.pool.address).toBe('0x61eb789d75a95caa3ff50ed7e47b96c132fec082');expect(f.calls).not.toContain('eth_call');expect(JSON.stringify(proof)).not.toContain('decimals');
 });
 it('replays the small canonical proof without RPC or requiring the original anchor to remain current',async()=>{
  const f=fixture(),prior=await recoverFreshHistoricalNativeQuote(f.options);f.options.anchor.timestamp=new Date(Date.now()-120000).toISOString();
  // An actual later anchor is allowed; the saved earlier code block remains pinned.
  const anchor={number:10030,hash:h(10030),timestamp:new Date(Date.now()+1000).toISOString()};
  const p=await recoverFreshHistoricalNativeQuote({...f.options,anchor,prior,rpc:(async()=>{throw Error('no_rpc');})as Rpc});expect(p).toEqual(prior);
 });
 it('does not use same-transaction or later-transaction swaps to value an earlier purchase',async()=>{
  const f=fixture();f.logs.splice(0,2);await expect(recoverFreshHistoricalNativeQuote(f.options)).rejects.toThrow('flap_quote_sync_unavailable');
  const g=fixture();g.logs.splice(0,3,g.sync(10000,3));await expect(recoverFreshHistoricalNativeQuote(g.options)).rejects.toThrow('flap_quote_sync_unavailable');
 });
 it('rejects absent history rather than substituting default or current balances',async()=>{const f=fixture();f.logs.splice(0);await expect(recoverFreshHistoricalNativeQuote(f.options)).rejects.toThrow('flap_quote_sync_unavailable');});
 it('rejects target, observation and code-anchor reorgs',async()=>{
  const f=fixture(),prior=await recoverFreshHistoricalNativeQuote(f.options);
  for(const n of[10000,10020])await expect(recoverFreshHistoricalNativeQuote({...f.options,prior,canonicalHash:async number=>h(number===n?9:number)})).rejects.toThrow('historical_native_quote_noncanonical');
  const g=fixture();g.logs[0].blockHash=h(9);await expect(recoverFreshHistoricalNativeQuote(g.options)).rejects.toThrow('historical_native_quote_noncanonical');
 });
 it('rejects arbitrary factory, proxy, altered runtime and unsupported chain',async()=>{
  const f=fixture();f.codes.set(PCS_V2_FACTORY,'0x00');await expect(recoverFreshHistoricalNativeQuote(f.options)).rejects.toThrow('flap_quote_factory_code_invalid');
  const g=fixture();g.codes.set(FRESH_HISTORICAL_BTCB_PAIR,'0x00');await expect(recoverFreshHistoricalNativeQuote(g.options)).rejects.toThrow('historical_native_quote_pair_code_invalid');
  const j=fixture();j.setChain('0x1');await expect(recoverFreshHistoricalNativeQuote(j.options)).rejects.toThrow('historical_native_quote_chain_invalid');
 });
 it('requires a recent code anchor on first recovery and rejects impossible target positions',async()=>{
  const f=fixture();f.options.target.timestamp=new Date(Date.now()-120000).toISOString();f.options.anchor.timestamp=new Date(Date.now()-60000).toISOString();await expect(recoverFreshHistoricalNativeQuote(f.options)).rejects.toThrow('historical_native_quote_anchor_stale');
  for(const transactionIndex of[-1,1.5,2**32])await expect(recoverFreshHistoricalNativeQuote({...fixture().options,transactionIndex})).rejects.toThrow('historical_native_quote_identity_invalid');
 });
 it('rejects corrupted retained ratios, observation positions and pool identities',async()=>{
  const f=fixture(),prior=await recoverFreshHistoricalNativeQuote(f.options);
  for(const patch of[{nativeRaw:'1'},{quoteRaw:'1'},{transactionIndex:2},{quoteAddress:PCS_V2_FACTORY},{pool:{...prior.pool,address:PCS_V2_FACTORY}},{code:{...prior.code,pairRuntimeHash:h(9)}}]){
   await expect(recoverFreshHistoricalNativeQuote({...f.options,prior:{...prior,...patch}as typeof prior})).rejects.toThrow('historical_native_quote_prior_invalid');
  }
 });
 it('bounds and validates complete event coverage before choosing the prior Sync',async()=>{
  const f=fixture();f.logs.splice(0,3,...Array(513).fill(f.sync(9999,0)));await expect(recoverFreshHistoricalNativeQuote(f.options)).rejects.toThrow('flap_quote_work_bounds');
  for(const patch of[{removed:true},{address:PCS_V2_FACTORY},{blockNumber:hex(10001)},{data:'0x00'},{topics:[]}]){const g=fixture();Object.assign(g.logs[2],patch);await expect(recoverFreshHistoricalNativeQuote(g.options)).rejects.toThrow();}
  const j=fixture();j.logs.reverse();await expect(recoverFreshHistoricalNativeQuote(j.options)).rejects.toThrow('flap_quote_sync_order_invalid');
 });
});
