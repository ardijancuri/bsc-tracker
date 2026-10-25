import {afterEach,describe,it,expect,vi}from'vitest';import{Interface,ZeroAddress}from'ethers';import type{Rpc}from'../rpc.js';
import{PCS_V2_FACTORY,PCS_V3_FACTORY,WBNB,FLAP_PORTAL,flapInterface}from'../launchpad.js';import{poolMarketAbi,oracleMarketAbi,TRUSTED_QUOTE_FEEDS}from'../nodeMarketProtocols.js';
import{freshCurrentQuote,persistFreshQuote}from'./pricing.js';import*as market from'./stockwaveMarket.js';import*as conversion from'./currentPoolQuote.js';
const token='0x'+'7'.repeat(40),quote='0x'+'9'.repeat(40),hash=(n:number)=>'0x'+n.toString(16).padStart(64,'0');
const abi=new Interface(['function decimals()view returns(uint8)','function totalSupply()view returns(uint256)','function name()view returns(string)','function symbol()view returns(string)']);
function fixture(){
 const block={number:120,hash:hash(120),timestamp:new Date().toISOString()},initial={sqrtPriceX96:String(1n<<96n),tick:0,blockNumber:100,blockHash:hash(100),transactionHash:hash(900),logIndex:1};
 const poolKey={currency0:token,currency1:quote,fee:500,tickSpacing:10,hooks:ZeroAddress};
 const identity:market.FreshStockwaveMarketIdentity={version:1,manager:market.FRESH_UNISWAP_V4_BSC_MANAGER,poolId:market.freshStockwavePoolId(poolKey),poolKey,tokenAddress:token,quoteAddress:quote,initial};
 const rpc=vi.fn(async(method:string,params:any[])=>{
  expect(method).toBe('eth_call');expect(params[1]).toEqual({blockHash:block.hash,requireCanonical:true});const call=params[0];
  if([PCS_V2_FACTORY,PCS_V3_FACTORY].includes(call.to)){const name=poolMarketAbi.parseTransaction(call)!.name;return poolMarketAbi.encodeFunctionResult(name,[ZeroAddress]);}
  if(call.to===TRUSTED_QUOTE_FEEDS[WBNB].feed){const name=oracleMarketAbi.parseTransaction(call)!.name;return oracleMarketAbi.encodeFunctionResult(name,name==='decimals'?[8]:name==='description'?['BNB / USD']:[1n,600n*10n**8n,1n,BigInt(Math.floor(Date.parse(block.timestamp)/1000)),1n]);}
  if([token,...Object.keys(TRUSTED_QUOTE_FEEDS)].includes(call.to)){
   const name=abi.parseTransaction(call)!.name;return abi.encodeFunctionResult(name,name==='decimals'?[18]:name==='totalSupply'?[1000000n*10n**18n]:[name==='symbol'?'MEME':'Meme']);
  }
  throw Error('unsupported_current_route');
 })as unknown as Rpc;
 const read=vi.spyOn(market,'readFreshStockwaveMarket').mockResolvedValue({sqrtPriceX96:'123',liquidityRaw:'456',rawQuoteRatio:{numerator:'1',denominator:String(10n**14n)},virtualQuoteLiquidityRaw:{numerator:'100000000',denominator:'1'}}as any);
 const native=vi.spyOn(conversion,'readFreshPoolNativeConversion').mockResolvedValue({quoteDecimals:6,quoteRaw:5n*10n**6n,nativeRaw:500n*10n**18n,observedAt:block.timestamp,
  identity:{kind:'authenticated_current_pcs_v2_native',quoteToken:quote,nativeToken:WBNB},state:{quoteReserveRaw:'5000000',nativeReserveRaw:String(500n*10n**18n)}}as any);
 return{rpc,block,identity,read,native,canonicalHash:async(n:number)=>n===100?hash(100):null};
}
afterEach(()=>vi.restoreAllMocks());
describe('previously authenticated Uniswap V4 current market candidates',()=>{
 it('prices a non-Stockwave token from its registered canonical pool and exact current quote conversion without history scans',async()=>{
  const f=fixture(),q=await freshCurrentQuote(token,{...f,marketIdentities:[f.identity]});
  expect(q).toMatchObject({priceUsd:'600',marketCapUsd:'600000000',market:{protocol:'uniswap_v4',address:market.FRESH_UNISWAP_V4_BSC_MANAGER,quoteAddress:quote,identity:{market:f.identity}}});
  expect(f.read).toHaveBeenCalledWith({rpc:f.rpc,identity:f.identity,tokenDecimals:18,block:f.block});
  expect((f.rpc as any).mock.calls.every(([method]:any[])=>method==='eth_call')).toBe(true);
  const db={query:vi.fn(async(_sql:string,_values?:unknown[])=>({rows:[]}))};await persistFreshQuote(db as any,q);
  expect(db.query.mock.calls[1][1]?.[2]).toBeNull();
 });
 it.each(['pool_id','canonical','token','future']as const)('rejects a changed %s identity before reading current V4 state',async change=>{
  const f=fixture(),identity=structuredClone(f.identity);if(change==='pool_id')identity.poolId=hash(9);if(change==='token')identity.tokenAddress=quote;if(change==='future')identity.initial.blockNumber=999;
  await expect(freshCurrentQuote(token,{...f,marketIdentities:[identity],canonicalHash:change==='canonical'?async()=>hash(9):f.canonicalHash})).rejects.toThrow('authenticated_market_quote_unavailable');
  expect(f.read).not.toHaveBeenCalled();
 });
 it('bounds registered candidates and rejects unavailable state or conversion rather than using a prior price',async()=>{
  const f=fixture();f.native.mockRejectedValue(Error('pool_quote_no_liquidity'));
  await expect(freshCurrentQuote(token,{...f,marketIdentities:Array(100).fill(f.identity)})).rejects.toThrow('authenticated_market_quote_unavailable');expect(f.read).toHaveBeenCalledTimes(8);
 });
 it('does not declare no liquidity when a supplied V4 route is unavailable or unverified even if the bonding curve and PCS markets are empty',async()=>{
  const f=fixture(),base=f.rpc;
  const rpc:Rpc=async<T>(method:string,params:unknown[]):Promise<T>=>{
   const call=params[0]as{to:string;data:string};if(call?.to===FLAP_PORTAL){const name=flapInterface.parseTransaction(call)!.name;
    const common=[1,0,0,0,6,0,0,0,0,ZeroAddress,false,hash(0)];return flapInterface.encodeFunctionResult(name,[[...common,...(name==='getTokenV7'?[0,ZeroAddress,0,0,0]:[0,0,ZeroAddress,0,0,0])]])as T;
   }return base<T>(method,params);
  };
  await expect(freshCurrentQuote(token,{...f,rpc})).rejects.toThrow('authenticated_markets_no_liquidity');
  f.read.mockRejectedValue(Error('temporary_v4_state_unavailable'));
  for(const identity of[f.identity,{...f.identity,poolId:hash(9)}])await expect(freshCurrentQuote(token,{...f,rpc,marketIdentities:[identity]})).rejects.toThrow('authenticated_market_quote_unavailable');
 });
});
