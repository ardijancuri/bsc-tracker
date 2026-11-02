import{afterEach,describe,expect,it,vi}from'vitest';import{Interface,ZeroAddress}from'ethers';import type{Rpc}from'../rpc.js';
import{PCS_V2_FACTORY,PCS_V3_FACTORY,WBNB}from'../launchpad.js';import{poolMarketAbi,oracleMarketAbi,TRUSTED_QUOTE_FEEDS,INFINITY_CL}from'../nodeMarketProtocols.js';
import{freshCurrentQuote,persistFreshQuote}from'./pricing.js';import{freshInfinityClInterface as infinity,freshInfinityClPoolId,validFreshInfinityClMarketIdentity,validFreshCurrentInfinityClMarketIdentity,historicalFreshInfinityClPrice,type FreshInfinityClMarketIdentity}from'./infinityClMarket.js';
import{createFreshHistoricalValuationOptions}from'./valuationContext.js';
const token='0x'+'7'.repeat(40),h=(n:number)=>'0x'+n.toString(16).padStart(64,'0'),erc20=new Interface(['function decimals()view returns(uint8)','function totalSupply()view returns(uint256)','function name()view returns(string)','function symbol()view returns(string)']);
function fixture(hooked=false){const block={number:120,hash:h(120),timestamp:new Date().toISOString()},poolKey={currency0:ZeroAddress,currency1:token,hooks:hooked?'0x'+'8'.repeat(40):ZeroAddress,poolManager:INFINITY_CL,fee:100,parameters:'0x'+((1n<<16n)|(hooked?3265n:0n)).toString(16).padStart(64,'0')},identity:FreshInfinityClMarketIdentity={version:1,protocol:'infinity_cl',manager:INFINITY_CL,poolId:freshInfinityClPoolId(poolKey,{allowHooks:hooked}),poolKey,tokenAddress:token,quoteAddress:WBNB,initial:{sqrtPriceX96:String(1n<<96n),tick:0,blockNumber:100,blockHash:h(100),transactionHash:h(900),logIndex:1}};let liquidity=100n*10n**18n;
 const rpc=vi.fn(async(method:string,params:any[])=>{expect(method).toBe('eth_call');expect(params[1]).toEqual({blockHash:block.hash,requireCanonical:true});const call=params[0];
  if([PCS_V2_FACTORY,PCS_V3_FACTORY].includes(call.to)){const name=poolMarketAbi.parseTransaction(call)!.name;return poolMarketAbi.encodeFunctionResult(name,[ZeroAddress]);}
  if(call.to===INFINITY_CL){const name=infinity.parseTransaction(call)!.name;return infinity.encodeFunctionResult(name,name==='poolIdToPoolKey'?Object.values(poolKey):name==='getSlot0'?[1n<<96n,0,0,100]:[liquidity]);}
  if(call.to===TRUSTED_QUOTE_FEEDS[WBNB].feed){const name=oracleMarketAbi.parseTransaction(call)!.name;return oracleMarketAbi.encodeFunctionResult(name,name==='decimals'?[8]:name==='description'?['BNB / USD']:[1n,600n*10n**8n,1n,BigInt(Math.floor(Date.parse(block.timestamp)/1000)),1n]);}
  if([token,...Object.keys(TRUSTED_QUOTE_FEEDS)].includes(call.to)){const name=erc20.parseTransaction(call)!.name;return erc20.encodeFunctionResult(name,name==='decimals'?[18]:name==='totalSupply'?[1000000n*10n**18n]:[name==='symbol'?'MEME':'Meme']);}
  throw Error('unsupported_fixture_call');})as unknown as Rpc;return{block,identity,rpc,canonicalHash:async(n:number)=>n===100?h(100):null,setLiquidity:(v:bigint)=>{liquidity=v;}};}
afterEach(()=>vi.restoreAllMocks());
describe('registered native Pancake Infinity CL current price',()=>{
 it('prices authenticated hooked manager state without calling the hook, while historical valuation remains excluded',async()=>{
  const f=fixture(true);expect(validFreshCurrentInfinityClMarketIdentity(f.identity)).toBe(true);expect(validFreshInfinityClMarketIdentity(f.identity)).toBe(false);
  const q=await freshCurrentQuote(token,{...f,marketIdentities:[f.identity]});expect(q.priceUsd).toBe('600');expect(q.market.identity.market).toEqual(f.identity);
  expect((f.rpc as any).mock.calls.every(([method,params]:any[])=>method==='eth_call'&&params[0].to!==f.identity.poolKey.hooks)).toBe(true);
  await expect(historicalFreshInfinityClPrice({rpc:f.rpc,identity:f.identity,tokenDecimals:18,target:f.block,canonicalHash:f.canonicalHash})).rejects.toThrow('infinity_cl_market_identity_invalid');
  const rpc:Rpc=async<T>(method:string,params:unknown[]):Promise<T>=>method==='eth_chainId'?'0x38'as T:method==='eth_getBlockByNumber'?{number:'0x78',hash:f.block.hash,timestamp:'0x'+Math.floor(Date.parse(f.block.timestamp)/1000).toString(16)}as T:f.rpc<T>(method,params);
  const block={...f.block,timestamp:new Date(Math.floor(Date.parse(f.block.timestamp)/1000)*1000).toISOString()},historical=await createFreshHistoricalValuationOptions(rpc,block);
  await expect(freshCurrentQuote(token,{...historical,marketIdentities:[f.identity],canonicalHash:f.canonicalHash})).rejects.toThrow('authenticated_market_quote_unavailable');
 });
 it('binds the live Pearl pool including its hook bitmap, fee, spacing and complete six-word key',()=>{
  const key={currency0:ZeroAddress,currency1:'0x7e2da878217eb995f9e5d36ed32c9cea52442681',hooks:'0xe555d6c4b3683efee2cecd9d3d04aa42db07bc65',poolManager:INFINITY_CL,fee:2500,parameters:'0x'+'3c0cc1'.padStart(64,'0')};
  expect(freshInfinityClPoolId(key,{allowHooks:true})).toBe('0x050420e479e3b703cfa1e0c3d328d0c38db22f9a443a885ee68463e94f3464a1');
  expect(()=>freshInfinityClPoolId(key)).toThrow('infinity_cl_pool_key_unsupported');
  expect(()=>freshInfinityClPoolId({...key,hooks:ZeroAddress},{allowHooks:true})).toThrow('infinity_cl_pool_key_unsupported');
 });
 it('uses the registered canonical key/current slot and real active liquidity without log scans or another financial provider',async()=>{const f=fixture(),q=await freshCurrentQuote(token,{...f,marketIdentities:[f.identity]});expect(q).toMatchObject({priceUsd:'600',marketCapUsd:'600000000',market:{protocol:'infinity_cl',address:INFINITY_CL,quoteAddress:WBNB,identity:{market:f.identity}}});expect((f.rpc as any).mock.calls.every(([m]:any[])=>m==='eth_call')).toBe(true);const db:any={query:vi.fn(async()=>({rows:[]}))};await persistFreshQuote(db,q);expect(db.query.mock.calls[1][1][2]).toBeNull();});
 it.each(['pool','hooks','future','canonical','non_native'])('rejects unsupported or changed %s identity',async change=>{const f=fixture(),identity=structuredClone(f.identity);if(change==='pool')identity.poolId=h(9);if(change==='hooks')identity.poolKey.hooks=token;if(change==='future')identity.initial.blockNumber=121;if(change==='non_native')identity.poolKey.currency0=WBNB;await expect(freshCurrentQuote(token,{...f,marketIdentities:[identity],canonicalHash:change==='canonical'?async()=>h(9):f.canonicalHash})).rejects.toThrow('authenticated_market_quote_unavailable');});
 it('requires current positive liquidity instead of retaining the initialization or last quote',async()=>{const f=fixture();f.setLiquidity(0n);await expect(freshCurrentQuote(token,{...f,marketIdentities:[f.identity]})).rejects.toThrow('authenticated_market_quote_unavailable');});
});
