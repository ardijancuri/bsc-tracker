import{describe,it,expect,vi}from'vitest';
import{Interface,keccak256}from'ethers';
import{RpcRequestError,type Rpc}from'../rpc.js';
import{FLAP_PORTAL,flapInterface,WBNB,PCS_V2_FACTORY}from'../launchpad.js';
import{poolMarketAbi,oracleMarketAbi,TRUSTED_QUOTE_FEEDS}from'../nodeMarketProtocols.js';
import{FreshNoLiquidityError}from'./pricing.js';
import{observeFreshQuoteRefresh,freshQuoteRefreshCanRetain,readFreshQuoteRefreshAnchor,commitFreshQuoteRefreshFailure,type FreshQuoteRefreshState}from'./quoteRefreshFailure.js';
import{GANG_TOKEN_ADDRESS}from'./tracking.js';

const at=Date.parse('2026-10-24T00:00:00.000Z'),token='0x'+'1'.repeat(40),pair='0x'+'2'.repeat(40),quote='0x'+'3'.repeat(40),hash='0x'+'a'.repeat(64);
const block={number:101,hash,timestamp:new Date(at).toISOString()},transient=new RpcRequestError('rpc_unavailable','transport');
const tokenAbi=new Interface(['function decimals()view returns(uint8)','function totalSupply()view returns(uint256)']);
function state():FreshQuoteRefreshState{return{token:{address:token,launch_status:'eligible',valuation_status:'ready',price_source:'node',price_usd:'2',market_cap_usd:'2000',decimals:18,total_supply_raw:'1000000000000000000000',observed_block:100,observed_hash:hash,observed_at:new Date(at-88000).toISOString()},
 markets:[{id:'flap:'+token,protocol:'flap',quote_address:quote,address:FLAP_PORTAL,status:'ready',identity:{method:'getTokenV8Safe',quoteConversion:{protocol:'pcs_v2',factory:PCS_V2_FACTORY,pair,token0:quote,token1:WBNB,quoteToken:quote,nativeToken:WBNB,quoteDecimals:18,pairRuntimeHash:keccak256('0x6000')}}}]};}
async function evidence(results:Map<string,string>=new Map()){
 const rpc=vi.fn(async(_method:string,params:any[])=>{const value=results.get(params[0]?.data??_method);if(value!==undefined)return value;throw transient;})as Rpc;
 const result=observeFreshQuoteRefresh(rpc,block);await result.rpc('eth_call',[{to:token,data:tokenAbi.encodeFunctionData('decimals')},{blockHash:hash,requireCanonical:true}]).catch(()=>{});
 return{result,rpc};
}
const rawKey=(to:string,data:string)=>`${to}:${data}`;
const valid=(s:FreshQuoteRefreshState,e:ReturnType<typeof observeFreshQuoteRefresh>,error:unknown=transient,now=at)=>freshQuoteRefreshCanRetain(s,e,error,now);

describe('dated valid quotes during transient refresh failure',()=>{
 it('does not mutate or approve any old quote after a separate capture commit guard loses its race',async()=>{
  const db={connect:vi.fn(()=>{throw Error('must_not_open_a_write_transaction');})},clean=observeFreshQuoteRefresh((async()=> '0x')as Rpc,block);
  for(const status of['ready','quote_unavailable','no_liquidity']){const prior=state();prior.token.valuation_status=status;const before=JSON.stringify(prior);
   expect(await commitFreshQuoteRefreshFailure(db as any,token,new Error('current_quote_capture_changed'),{captureRevision:7,block,prior,evidence:clean,now:()=>at})).toEqual({retained:false,updated:false,reason:'capture_changed'});
   expect(JSON.stringify(prior)).toBe(before);
  }expect(db.connect).not.toHaveBeenCalled();
 });
 it('retains a previously ready88second observation without issuing additional RPC',async()=>{const{result,rpc}=await evidence(),before=JSON.stringify(state());expect(valid(state(),result)).toBe(true);expect(rpc).toHaveBeenCalledTimes(1);expect(JSON.stringify(state())).toBe(before);});
 it('considers only exact preexisting GANG for locked permission checking and keeps its original expiry',async()=>{
  const{result}=await evidence(),s=state();s.token.address=GANG_TOKEN_ADDRESS;s.token.launch_status='preexisting';
  expect(valid(s,result)).toBe(true);expect(valid(s,result,transient,at+32001)).toBe(false);
  s.markets[0].protocol='uniswap_v4';expect(valid(s,result)).toBe(false);s.markets[0].protocol='flap';
  s.token.address=token;expect(valid(s,result)).toBe(false);
  s.token.address=GANG_TOKEN_ADDRESS;s.token.launch_status='unverified';expect(valid(s,result)).toBe(false);
 });
 it('keeps the original strict120second expiry and never promotes unavailable/no-liquidity/reorg',async()=>{const{result}=await evidence();expect(valid(state(),result,transient,at+32000)).toBe(true);expect(valid(state(),result,transient,at+32001)).toBe(false);
  for(const status of['quote_unavailable','no_liquidity','reorg']){const s=state();s.token.valuation_status=status;expect(valid(s,result)).toBe(false);}for(const source of[null,'gmgn']){const s=state();s.token.price_source=source;expect(valid(s,result)).toBe(false);}expect(valid(state(),result,new FreshNoLiquidityError())).toBe(false);expect(valid(state(),result,new Error('pool_identity_mismatch'))).toBe(false);});
 it('allows the swallowed market aggregate only with an observed temporary RPC failure',async()=>{const{result}=await evidence();expect(valid(state(),result,new Error('authenticated_market_quote_unavailable'))).toBe(true);
  const clean=observeFreshQuoteRefresh((async()=> '0x')as Rpc,block);expect(valid(state(),clean,new Error('authenticated_market_quote_unavailable'))).toBe(false);});
 it('rejects changed supply/precision and malformed successful raw metadata, including partial observations',async()=>{for(const[method,value]of[['decimals',17n],['totalSupply',1n]]as const){const{result}=await evidence();result.calls.set(rawKey(token,tokenAbi.encodeFunctionData(method)),tokenAbi.encodeFunctionResult(method,[value]));expect(valid(state(),result)).toBe(false);}
  const{result}=await evidence();result.calls.set(rawKey(token,tokenAbi.encodeFunctionData('totalSupply')),'0x');expect(valid(state(),result)).toBe(false);});
 it('rejects a newly empty bridge, changed bridge assets, or changed bridge runtime',async()=>{for(const[method,value]of[['getReserves',[0,1,0]],['token1',[token]]]as const){const{result}=await evidence();result.calls.set(rawKey(pair,poolMarketAbi.encodeFunctionData(method)),poolMarketAbi.encodeFunctionResult(method,value));expect(valid(state(),result)).toBe(false);}
  const{result}=await evidence();result.codes.set(pair,'0x6001');expect(valid(state(),result)).toBe(false);});
 it('rejects a successful factory registration contradiction even when the former pool was never read',async()=>{const{result}=await evidence();
  result.calls.set(rawKey(PCS_V2_FACTORY,poolMarketAbi.encodeFunctionData('getPair',[quote,WBNB])),poolMarketAbi.encodeFunctionResult('getPair',[token]));expect(valid(state(),result)).toBe(false);});
 it('rejects a failed required getter despite an unrelated transient, while unrelated alternate helper reverts do not invalidate',async()=>{const{result}=await evidence();
  result.failedCalls.set(rawKey(pair,poolMarketAbi.encodeFunctionData('getReserves')),'revert');expect(valid(state(),result,new Error('authenticated_market_quote_unavailable'))).toBe(false);
  result.failedCalls.clear();result.failedCalls.set(rawKey(token,'0x12345678'),'revert');expect(valid(state(),result,new Error('authenticated_market_quote_unavailable'))).toBe(true);});
 it('rejects a newly empty or graduated original bonding market',async()=>{for(const status of[1,4]){const{result}=await evidence();const values=[status,0,100,1,1,1,1,1,1,quote,false,hash,0,0,pair,0,0,0];result.calls.set(rawKey(FLAP_PORTAL,flapInterface.encodeFunctionData('getTokenV8Safe',[token])),flapInterface.encodeFunctionResult('getTokenV8Safe',[values]));expect(valid(state(),result)).toBe(false);}});
 it('rejects negative/stale/mislabeled actual feed observations',async()=>{const feed=TRUSTED_QUOTE_FEEDS[WBNB];for(const answer of[0n,-1n]){const{result}=await evidence();result.calls.set(rawKey(feed.feed,oracleMarketAbi.encodeFunctionData('latestRoundData')),oracleMarketAbi.encodeFunctionResult('latestRoundData',[1,answer,1,Math.floor(at/1000),1]));expect(valid(state(),result)).toBe(false);}
  const{result}=await evidence();result.calls.set(rawKey(feed.feed,oracleMarketAbi.encodeFunctionData('description')),oracleMarketAbi.encodeFunctionResult('description',['OTHER / USD']));expect(valid(state(),result)).toBe(false);});
 it('bounds observed work and fails closed on wrong block/non-deterministic/malformed evidence',async()=>{const rpc=vi.fn(async()=> '0x00')as Rpc,observed=observeFreshQuoteRefresh(rpc,block);
  await observed.rpc('eth_call',[{to:token,data:'0x313ce567'},{blockHash:'0x'+'b'.repeat(64),requireCanonical:true}]);expect(observed.invalid).toBe(true);
  const bounded=observeFreshQuoteRefresh(rpc,block);for(let n=0;n<257;n++)await bounded.rpc('eth_call',[{to:token,data:'0x'+n.toString(16).padStart(8,'0')},{blockHash:hash,requireCanonical:true}]);expect(bounded.invalid).toBe(true);expect(bounded.calls.size).toBe(256);});
 it('reloads the captured header/revision for each group instead of caching an entire batch',async()=>{let n=100;const db={query:vi.fn(async()=>({rows:[{block_number:++n,block_hash:hash,revision:7,occurred_at:new Date(at)}]}))};
  const first=await readFreshQuoteRefreshAnchor(db as any,at),second=await readFreshQuoteRefreshAnchor(db as any,at);expect([first.block.number,second.block.number]).toEqual([101,102]);expect(first.captureRevision).toBe(7);expect(db.query).toHaveBeenCalledTimes(2);
  await expect(readFreshQuoteRefreshAnchor(db as any,at+20001)).rejects.toThrow('current_quote_capture_unavailable');});
});
