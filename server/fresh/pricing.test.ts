import { describe, expect, it, vi } from 'vitest';
import { Interface, ZeroAddress, encodeBytes32String } from 'ethers';
import {RpcRequestError,type Rpc} from '../rpc.js';
import { WBNB, PCS_V2_FACTORY, PCS_V3_FACTORY, FLAP_PORTAL, FOUR_HELPER, FOUR_MANAGERS, flapInterface, fourInterface } from '../launchpad.js';
import { oracleMarketAbi, poolMarketAbi, TRUSTED_QUOTE_FEEDS } from '../nodeMarketProtocols.js';
import { freshCall,freshCurrentQuote, freshQuoteUsd, freshTokenMetadata,freshMetadataDiagnostic,FreshMetadataReadError,FreshNoLiquidityError } from './pricing.js';
import { FRESH_BTCB_QUOTE,FRESH_BTCB_NATIVE_PAIR } from './currentBtcQuote.js';
import { FRESH_BNCB_QUOTE,FRESH_BNCB_NATIVE_PAIR } from './currentBncbQuote.js';
import { FRESH_SPCXB_QUOTE,FRESH_SPCXB_NATIVE_PAIR } from './currentSpcxbQuote.js';
import { factoryCode,pairCode } from './currentQuote.fixture.js';
import {FRESH_CURRENT_STABLE_BRIDGE,freshPoolNativePair,freshPoolQuotePair} from './currentPoolQuote.js';
import{FRESH_PCS_V3_DEPLOYER,freshPoolStableV3}from'./currentV3Quote.js';

const token = `0x${'7'.repeat(40)}`, pool = `0x${'2'.repeat(40)}`, block = { number: 101, hash: `0x${'a'.repeat(64)}`, timestamp: '2026-10-21T18:00:00.000Z' };
const tokenAbi = new Interface(['function decimals() view returns(uint8)', 'function totalSupply() view returns(uint256)', 'function name() view returns(string)', 'function symbol() view returns(string)']);
function rpcFixture(options: { stale?: boolean; badFactory?: boolean; unknownDecimals?: boolean; tokenDecimals?: number; feedDescription?: string; stablePrice?: bigint } = {}): Rpc {
  return vi.fn(async (method: string, params: any[]) => {
    expect(method).toBe('eth_call'); expect(params[1]).toEqual({ blockHash: block.hash, requireCanonical: true });
    const call = params[0], to = call.to.toLowerCase();
    if (to === PCS_V2_FACTORY || to === PCS_V3_FACTORY) {
      const parsed = poolMarketAbi.parseTransaction(call)!;
      return poolMarketAbi.encodeFunctionResult(parsed.name, [parsed.name === 'getPair' && String(parsed.args[1]).toLowerCase() === WBNB ? pool : ZeroAddress]);
    }
    if (to === pool) {
      const parsed = poolMarketAbi.parseTransaction(call)!;
      if (parsed.name === 'factory') return poolMarketAbi.encodeFunctionResult('factory', [options.badFactory ? token : PCS_V2_FACTORY]);
      if (parsed.name === 'token0') return poolMarketAbi.encodeFunctionResult('token0', [token]);
      if (parsed.name === 'token1') return poolMarketAbi.encodeFunctionResult('token1', [WBNB]);
      if (parsed.name === 'getReserves') return poolMarketAbi.encodeFunctionResult('getReserves', [1_000n * 10n ** 18n, 10n * 10n ** 18n, 123]);
    }
    const trusted = Object.values(TRUSTED_QUOTE_FEEDS).find(feed => feed.feed === to);
    if (trusted) {
      const parsed = oracleMarketAbi.parseTransaction(call)!;
      if (parsed.name === 'decimals') return oracleMarketAbi.encodeFunctionResult('decimals', [8]);
      if (parsed.name === 'description') return oracleMarketAbi.encodeFunctionResult('description', [options.feedDescription ?? trusted.description]);
      if (parsed.name === 'latestRoundData') return oracleMarketAbi.encodeFunctionResult('latestRoundData', [100n, trusted.description === 'BNB / USD' ? 600n * 10n ** 8n : options.stablePrice ?? 99_000_000n, 1n, BigInt(Date.parse(block.timestamp) / 1_000 - (options.stale ? 100_000 : 5)), 100n]);
    }
    if ([token, WBNB, ...Object.keys(TRUSTED_QUOTE_FEEDS)].includes(to)) {
      const parsed = tokenAbi.parseTransaction(call)!;
      if (parsed.name === 'decimals') { if (options.unknownDecimals && to === token) throw new Error('missing_decimals'); return tokenAbi.encodeFunctionResult('decimals', [to === token ? options.tokenDecimals ?? 18 : 18]); }
      if (parsed.name === 'totalSupply') return tokenAbi.encodeFunctionResult('totalSupply', [1_000_000n * 10n ** 18n]);
      if (parsed.name === 'name') return tokenAbi.encodeFunctionResult('name', ['Fresh Token']);
      if (parsed.name === 'symbol') return tokenAbi.encodeFunctionResult('symbol', ['NEW']);
    }
    throw new Error('unsupported_state');
  }) as Rpc;
}
describe('node-only current valuation', () => {
  it('uses verified decimals, pool factory, canonical state and trusted USD conversion', async () => {
    const rpc = rpcFixture(), quote = await freshCurrentQuote(token, { rpc, block });
    expect(quote).toMatchObject({ priceUsd: '6', marketCapUsd: '6000000', blockHash: block.hash, observedAt: block.timestamp, market: { protocol: 'pcs_v2', address: pool, quoteAddress: WBNB } });
    expect((rpc as any).mock.calls.every(([, params]: any[]) => params[1].requireCanonical)).toBe(true);
  });
  it('does not assume a dollar peg from a stablecoin symbol or contract', async () => {
    const usd = await freshQuoteUsd('0x55d398326f99059ff775485246999027b3197955', { rpc: rpcFixture(), block }); expect(usd).toBe('0.99');
  });
  it('rejects stale/wrong feeds and fake factories', async () => {
    await expect(freshQuoteUsd(WBNB, { rpc: rpcFixture({ stale: true }), block })).rejects.toThrow('quote_feed_unverified_or_stale');
    await expect(freshQuoteUsd(WBNB, { rpc: rpcFixture({ feedDescription: 'FAKE / USD' }), block })).rejects.toThrow('quote_feed_unverified_or_stale');
    await expect(freshCurrentQuote(token, { rpc: rpcFixture({ badFactory: true }), block })).rejects.toThrow('authenticated_market_quote_unavailable');
  });
  it('does not guess token decimals when state is unavailable', async () => {
    await expect(freshTokenMetadata(token, { rpc: rpcFixture({ unknownDecimals: true }), block })).rejects.toThrow('missing_decimals');
  });
  it('keeps verified financial precision when supply alone is unavailable, without inventing zero supply',async()=>{
    const base=rpcFixture({tokenDecimals:77}),rpc:Rpc=async<T>(method:string,params:unknown[])=>{
      if((params[0] as any).data===tokenAbi.encodeFunctionData('totalSupply'))throw new RpcRequestError('RPC eth_call unavailable','state_unavailable',{code:-32000});
      return base<T>(method,params);
    };
    expect(await freshTokenMetadata(token,{rpc,block,requireSupply:false})).toEqual({address:token,name:'Fresh Token',symbol:'NEW',decimals:77,supplyRaw:null,block});
    await expect(freshTokenMetadata(token,{rpc,block})).rejects.toMatchObject({field:'total_supply',category:'state_unavailable',code:-32000});
    await expect(freshTokenMetadata(token,{rpc,block,requireSupply:true})).rejects.toMatchObject({field:'total_supply',category:'state_unavailable',code:-32000});
    await expect(freshCurrentQuote(token,{rpc,block})).rejects.toMatchObject({field:'total_supply',category:'state_unavailable',code:-32000});
    const financialOptions={rpc,block,requireSupply:false};
    await expect(freshCurrentQuote(token,financialOptions)).rejects.toMatchObject({field:'total_supply',category:'state_unavailable',code:-32000});
  });
  it('still requires canonical verified decimals when financial supply is optional',async()=>{
    await expect(freshTokenMetadata(token,{rpc:rpcFixture({unknownDecimals:true}),block,requireSupply:false})).rejects.toMatchObject({field:'decimals',message:'missing_decimals'});
    const base=rpcFixture(),rpc:Rpc=async<T>(method:string,params:unknown[])=>{
      if((params[0] as any).data===tokenAbi.encodeFunctionData('decimals'))return '0x' as T;
      return base<T>(method,params);
    };
    await expect(freshTokenMetadata(token,{rpc,block,requireSupply:false})).rejects.toMatchObject({field:'decimals',category:'invalid_response'});
  });
  it('preserves a genuinely verified zero precision and available supply in financial metadata',async()=>{
    expect(await freshTokenMetadata(token,{rpc:rpcFixture({tokenDecimals:0}),block,requireSupply:false})).toMatchObject({decimals:0,supplyRaw:'1000000000000000000000000'});
  });
  it('accepts an authenticated 77-decimal token without narrowing its on-chain precision', async () => {
    expect((await freshTokenMetadata(token, { rpc: rpcFixture({ tokenDecimals: 77 }), block })).decimals).toBe(77);
  });
  it('retries one known transport failure using the identical canonical hash request',async()=>{
    const rpc=vi.fn().mockRejectedValueOnce(new RpcRequestError('RPC eth_call returned 503','transport',{httpStatus:503})).mockResolvedValue(tokenAbi.encodeFunctionResult('decimals',[18])) as unknown as Rpc;
    expect((await freshCall({rpc,block},token,tokenAbi,'decimals'))[0]).toBe(18n);
    const calls=(rpc as any).mock.calls;expect(calls).toHaveLength(2);expect(calls[0]).toEqual(calls[1]);expect(calls[1][1][1]).toEqual({blockHash:block.hash,requireCanonical:true});
  });
  it('bounds transport retry at one attempt even when both calls fail',async()=>{
    const rpc=vi.fn().mockRejectedValue(new RpcRequestError('RPC eth_call unavailable','transport')) as unknown as Rpc;
    await expect(freshCall({rpc,block},token,tokenAbi,'decimals')).rejects.toMatchObject({category:'transport'});expect(rpc).toHaveBeenCalledTimes(2);
  });
  it.each(['state_unavailable','revert','rate_limit','invalid_response','rpc_error'] as const)('does not retry %s or substitute latest state',async category=>{
    const rpc=vi.fn().mockRejectedValue(new RpcRequestError('RPC eth_call unavailable',category,{code:-32000})) as unknown as Rpc;
    await expect(freshCall({rpc,block},token,tokenAbi,'decimals')).rejects.toMatchObject({category});expect(rpc).toHaveBeenCalledTimes(1);
    expect((rpc as any).mock.calls[0][1][1]).toEqual({blockHash:block.hash,requireCanonical:true});
  });
  it('distinguishes supply failure from decimals and retains only safe diagnostic fields',async()=>{
    const base=rpcFixture(),rpc:Rpc=async<T>(method:string,params:unknown[])=>{
      if((params[0] as any).data===tokenAbi.encodeFunctionData('totalSupply'))throw new RpcRequestError('RPC eth_call unavailable','state_unavailable',{code:-32000});
      return base<T>(method,params);
    };
    let error:unknown;try{await freshTokenMetadata(token,{rpc,block});}catch(value){error=value;}
    expect(error).toBeInstanceOf(FreshMetadataReadError);expect(error).toMatchObject({message:'RPC eth_call unavailable',field:'total_supply',category:'state_unavailable',code:-32000});
    expect(freshMetadataDiagnostic(error)).toBe('token_metadata_total_supply_state_unavailable_code_-32000');
    const unsafe=new FreshMetadataReadError('decimals',new Error('secret response https://user:password@example.invalid/KEY?private=1'));
    expect(unsafe.message).toBe('token_metadata_unavailable');expect(JSON.stringify(unsafe)).not.toMatch(/secret|password|https|private/);expect(freshMetadataDiagnostic(unsafe)).toBe('token_metadata_decimals_rpc_error');
  });
  it('decodes legacy bytes32 identity from the same raw response without duplicate calls',async()=>{
    const bytesAbi=new Interface(['function name() view returns(bytes32)','function symbol() view returns(bytes32)']),base=rpcFixture();
    const rpc=vi.fn(async<T>(method:string,params:unknown[])=>{const data=(params[0] as any).data;
      for(const field of ['name','symbol'] as const)if(data===tokenAbi.encodeFunctionData(field))return bytesAbi.encodeFunctionResult(field,[encodeBytes32String(field==='name'?'Legacy token':'OLD')]) as T;
      return base<T>(method,params);
    }) as Rpc;
    expect(await freshTokenMetadata(token,{rpc,block})).toMatchObject({name:'Legacy token',symbol:'OLD',decimals:18});
    for(const field of ['name','symbol'] as const)expect((rpc as any).mock.calls.filter(([,params]:any[])=>params[0].data===tokenAbi.encodeFunctionData(field))).toHaveLength(1);
  });
  it('keeps failed optional identity optional without a duplicate ABI request',async()=>{
    const base=rpcFixture(),rpc=vi.fn(async<T>(method:string,params:unknown[])=>{
      if((params[0] as any).data===tokenAbi.encodeFunctionData('name'))throw new RpcRequestError('RPC eth_call unavailable','revert',{code:3});return base<T>(method,params);
    }) as Rpc;
    expect(await freshTokenMetadata(token,{rpc,block})).toMatchObject({name:null,symbol:'NEW',decimals:18});
    expect((rpc as any).mock.calls.filter(([,params]:any[])=>params[0].data===tokenAbi.encodeFunctionData('name'))).toHaveLength(1);
  });
});

const migratedQuotes=[
  {quote:FRESH_BTCB_QUOTE,nativePair:FRESH_BTCB_NATIVE_PAIR},
  {quote:FRESH_BNCB_QUOTE,nativePair:FRESH_BNCB_NATIVE_PAIR},
  {quote:FRESH_SPCXB_QUOTE,nativePair:FRESH_SPCXB_NATIVE_PAIR},
];
function graduatedFlapFixture(route= migratedQuotes[0], options:{status?:number;quoteDecimals?:number;staleFeed?:boolean;badMarketFactory?:boolean;badNativeCode?:boolean;emptyMarket?:boolean;failedDiscovery?:boolean;bonding?:boolean;fourmeme?:boolean}={}){
  const currentBlock={...block,timestamp:new Date().toISOString()},precision=options.quoteDecimals??18;
  const assets=[token,route.quote].sort(),nativeAssets=[route.quote,WBNB].sort();
  const contractAbi=new Interface([...tokenAbi.fragments,'function factory() view returns(address)','function token0() view returns(address)',
    'function token1() view returns(address)','function getReserves() view returns(uint112,uint112,uint32)']);
  const rpc=vi.fn(async(method:string,params:any[])=>{
    if(method==='eth_chainId')return '0x38';
    expect(params[1]).toEqual({blockHash:currentBlock.hash,requireCanonical:true});
    const to=typeof params[0]==='string'?params[0].toLowerCase():params[0].to.toLowerCase();
    if(method==='eth_getCode'){
      if(to===PCS_V2_FACTORY)return factoryCode;
      if(to===route.nativePair)return options.badNativeCode?'0x00':pairCode;
      if(to===route.quote)return '0x6000';
      throw Error('unexpected_code_read');
    }
    expect(method).toBe('eth_call');const call=params[0];
    if(to===FOUR_HELPER){
      if(!options.fourmeme)throw Error('not_fourmeme');
      return fourInterface.encodeFunctionResult('getTokenInfo',[2,FOUR_MANAGERS[0],route.quote,10n**BigInt(precision)/10000n,0,0,0,0,0,10n*10n**BigInt(precision),0,false]);
    }
    if(to===FLAP_PORTAL){
      const name=flapInterface.parseTransaction(call)!.name;
      const common=[options.status??(options.bonding?1:4),options.bonding?10n*10n**BigInt(precision):0n,5n*10n**25n,options.bonding?10n**14n:0n,6,0n,0n,0n,0n,route.quote,true,currentBlock.hash];
      return flapInterface.encodeFunctionResult(name,[[...common,...(name==='getTokenV7'?[0,pool,100,0,0]:[0,0,pool,100,0,0])]]);
    }
    if(to===PCS_V2_FACTORY||to===PCS_V3_FACTORY){
      const parsed=poolMarketAbi.parseTransaction(call)!;
      if(parsed.name==='getPool'){
        if(options.failedDiscovery&&String(parsed.args[1]).toLowerCase()===route.quote)throw Error('discovery_unavailable');
        return poolMarketAbi.encodeFunctionResult(parsed.name,[ZeroAddress]);
      }
      const [a,b]=[String(parsed.args[0]).toLowerCase(),String(parsed.args[1]).toLowerCase()];
      return poolMarketAbi.encodeFunctionResult(parsed.name,[a===route.quote&&b===WBNB?route.nativePair:a===token&&b===route.quote?pool:ZeroAddress]);
    }
    if(to===TRUSTED_QUOTE_FEEDS[WBNB].feed){
      const name=oracleMarketAbi.parseTransaction(call)!.name;
      if(name==='decimals')return oracleMarketAbi.encodeFunctionResult(name,[8]);
      if(name==='description')return oracleMarketAbi.encodeFunctionResult(name,[TRUSTED_QUOTE_FEEDS[WBNB].description]);
      return oracleMarketAbi.encodeFunctionResult(name,[1n,600n*10n**8n,1n,BigInt(Math.floor(Date.parse(currentBlock.timestamp)/1000)-(options.staleFeed?100000:0)),1n]);
    }
    const parsed=contractAbi.parseTransaction(call)!,name=parsed.name;
    if(to===pool||to===route.nativePair){
      const marketAssets=to===pool?assets:nativeAssets;
      if(name==='factory')return contractAbi.encodeFunctionResult(name,[to===pool&&options.badMarketFactory?token:PCS_V2_FACTORY]);
      if(name==='token0'||name==='token1')return contractAbi.encodeFunctionResult(name,[marketAssets[name==='token0'?0:1]]);
      if(name==='getReserves'){
        const quantities:Record<string,bigint>=to===pool
          ?{[token]:options.emptyMarket?0n:1000n*10n**18n,[route.quote]:options.emptyMarket?0n:10n*10n**BigInt(precision)}
          :{[WBNB]:500n*10n**18n,[route.quote]:5n*10n**BigInt(precision)};
        return contractAbi.encodeFunctionResult(name,[quantities[marketAssets[0]],quantities[marketAssets[1]],1]);
      }
    }
    if(name==='decimals')return contractAbi.encodeFunctionResult(name,[to===route.quote?precision:18]);
    if(to===token&&name==='totalSupply')return contractAbi.encodeFunctionResult(name,[1_000_000n*10n**18n]);
    if(to===token&&name==='name')return contractAbi.encodeFunctionResult(name,['Graduated token']);
    if(to===token&&name==='symbol')return contractAbi.encodeFunctionResult(name,['GRAD']);
    throw Error('unexpected_canonical_read');
  }) as Rpc&ReturnType<typeof vi.fn>;
  return{rpc,block:currentBlock};
}

describe('graduated Flap current-market discovery',()=>{
  it.each(migratedQuotes)('retains authenticated $quote launch quote after graduation and prices the genuine migrated pair',async route=>{
    const fixture=graduatedFlapFixture(route),quote=await freshCurrentQuote(token,fixture);
    expect(quote).toMatchObject({priceUsd:'600',marketCapUsd:'600000000',observedAt:fixture.block.timestamp,
      market:{protocol:'pcs_v2',address:pool,quoteAddress:route.quote,identity:{factory:PCS_V2_FACTORY,launch:{platform:'flap',stage:'graduated'},
        quoteConversion:{pair:route.nativePair,observedBlock:fixture.block.number,observedHash:fixture.block.hash,observedAt:fixture.block.timestamp}},
        state:{quoteReserveRaw:String(5n*10n**18n),nativeReserveRaw:String(500n*10n**18n)}}});
    expect(fixture.rpc.mock.calls.some(([method,params])=>method==='eth_getCode'&&params[0]===route.nativePair)).toBe(true);
  });
  it('uses verified current quote precision rather than assuming eighteen decimals',async()=>{
    expect(await freshCurrentQuote(token,graduatedFlapFixture(migratedQuotes[1],{quoteDecimals:6}))).toMatchObject({priceUsd:'600'});
  });
  it.each(migratedQuotes)('does not approve $quote with stale oracle evidence, false market identity or false conversion code',async route=>{
    for(const options of [{staleFeed:true},{badMarketFactory:true},{badNativeCode:true}]){
      await expect(freshCurrentQuote(token,graduatedFlapFixture(route,options))).rejects.toThrow('authenticated_market_quote_unavailable');
    }
  });
  it('does not trust an unknown portal status or an unauthenticated conversion pool even when it claims liquidity',async()=>{
    await expect(freshCurrentQuote(token,graduatedFlapFixture(migratedQuotes[1],{status:2}))).rejects.toThrow('authenticated_market_quote_unavailable');
    const unsupported={quote:'0x'+'9'.repeat(40),nativePair:pool};
    const fixture=graduatedFlapFixture(unsupported);
    await expect(freshCurrentQuote(token,fixture)).rejects.toThrow('authenticated_market_quote_unavailable');
    expect(fixture.rpc.mock.calls.some(([method])=>method==='eth_getCode')).toBe(true);
  });
  it('authenticates a newly encountered controller quote instead of requiring its symbol/address in a peg whitelist',async()=>{
    const quoteAddress='0x'+'9'.repeat(40),route={quote:quoteAddress,nativePair:freshPoolNativePair(quoteAddress)};
    const fixture=graduatedFlapFixture(route),quote=await freshCurrentQuote(token,fixture);
    expect(quote).toMatchObject({priceUsd:'600',market:{quoteAddress,protocol:'pcs_v2',identity:{quoteConversion:{kind:'authenticated_current_pcs_v2_native',pair:route.nativePair}}}});
  });
  it.each([6,18])('uses exact %i-decimal custom-quote conversion for both bonding launchpads',async precision=>{
    const quoteAddress='0x'+'9'.repeat(40),route={quote:quoteAddress,nativePair:freshPoolNativePair(quoteAddress)};
    for(const options of[{bonding:true},{fourmeme:true}]){
      const quote=await freshCurrentQuote(token,graduatedFlapFixture(route,{...options,quoteDecimals:precision}));
      expect(quote).toMatchObject({priceUsd:'6',market:{quoteAddress,protocol:options.fourmeme?'fourmeme':'flap'}});
    }
  });
  it('supports FourMeme BNCB conversion through the same authenticated current reserve route',async()=>{
    expect(await freshCurrentQuote(token,graduatedFlapFixture(migratedQuotes[1],{fourmeme:true}))).toMatchObject({priceUsd:'6',market:{quoteAddress:FRESH_BNCB_QUOTE,protocol:'fourmeme'}});
  });
  it('does not turn a graduated empty curve into no-liquidity proof when the market is empty or unavailable',async()=>{
    for(const options of [{emptyMarket:true},{emptyMarket:true,failedDiscovery:true}]){
      await expect(freshCurrentQuote(token,graduatedFlapFixture(migratedQuotes[0],options))).rejects.toThrow('authenticated_market_quote_unavailable');
    }
  });
});

describe('authenticated empty Flap curves with new quote assets',()=>{
  const quoteAddress='0x'+'9'.repeat(40);
  function fixture(options:{failedDiscovery?:boolean;alternative?:boolean;badQuotePrecision?:boolean;status?:number;reserve?:bigint}={}){
    const base=rpcFixture();
    const rpc=vi.fn(async<T>(method:string,params:unknown[])=>{
      const call=params[0] as {to:string;data:string},to=call.to.toLowerCase();
      if(to===FLAP_PORTAL){
        const name=flapInterface.parseTransaction(call)!.name;
        const common=[options.status??1,options.reserve??0n,0n,2236135221n,6,2475483870000000000n,107036751000000000000000000n,
          2740451620597706370000000000n,800000000000000000000000000n,quoteAddress,true,block.hash];
        return flapInterface.encodeFunctionResult(name,[[...common,...(name==='getTokenV7'?[0,pool,100,0,0]:[0,0,pool,100,0,0])]]) as T;
      }
      if(to===quoteAddress)return tokenAbi.encodeFunctionResult('decimals',[options.badQuotePrecision?255:18]) as T;
      if(to===PCS_V2_FACTORY||to===PCS_V3_FACTORY){
        const parsed=poolMarketAbi.parseTransaction(call)!;
        if(options.failedDiscovery&&parsed.name==='getPool'&&String(parsed.args[1]).toLowerCase()===quoteAddress)throw Error('discovery_unavailable');
        if(options.alternative&&parsed.name==='getPair'&&String(parsed.args[1]).toLowerCase()===WBNB)return base<T>(method,params);
        return poolMarketAbi.encodeFunctionResult(parsed.name,[ZeroAddress]) as T;
      }
      return base<T>(method,params);
    }) as Rpc&ReturnType<typeof vi.fn>;
    return{rpc,block};
  }
  it('classifies a proven empty new-quote curve and completed empty factories without requiring a quote conversion',async()=>{
    const f=fixture();await expect(freshCurrentQuote(token,f)).rejects.toBeInstanceOf(FreshNoLiquidityError);
    // All work is canonical node state; no invented price, conversion or
    // market-volume record is needed to establish an empty supported market.
    expect(f.rpc.mock.calls.every(([method,params])=>method==='eth_call'&&(params as any[])[1].blockHash===block.hash)).toBe(true);
    expect(f.rpc.mock.calls.some(([,params])=>(params as any[])[0].to===PCS_V2_FACTORY&&poolMarketAbi.parseTransaction((params as any[])[0])?.args[1].toLowerCase()===quoteAddress)).toBe(true);
  });
  it.each([{failedDiscovery:true},{badQuotePrecision:true},{status:4},{reserve:1n}])('keeps incomplete/unsupported market evidence unavailable %s',async options=>{
    const f=fixture(options);let error:unknown;try{await freshCurrentQuote(token,f);}catch(value){error=value;}
    expect(error).toBeInstanceOf(Error);expect(error).not.toBeInstanceOf(FreshNoLiquidityError);
    expect((error as Error).message).toBe('authenticated_market_quote_unavailable');
  });
  it('uses a genuine funded alternative instead of suppressing the token for an empty curve',async()=>{
    expect(await freshCurrentQuote(token,fixture({alternative:true}))).toMatchObject({priceUsd:'6',marketCapUsd:'6000000',market:{protocol:'pcs_v2',quoteAddress:WBNB}});
  });
  it('does not claim every market is empty while a registered market identity still needs validation',async()=>{
    const f=fixture();await expect(freshCurrentQuote(token,{...f,marketIdentities:[{}]})).rejects.toThrow('authenticated_market_quote_unavailable');
  });
});

describe('current launch-quote stable bridge',()=>{
 function fixture(options:{bonding?:boolean;fourmeme?:boolean;quoteDecimals?:number;settlementDecimals?:number;stale?:boolean;wrongDescription?:boolean;badCode?:boolean;empty?:boolean;v3?:boolean;badV3Registry?:boolean;emptyV3?:boolean}={}){
  const quote='0x'+'9'.repeat(40),nativePair=freshPoolNativePair(quote),stablePair=freshPoolQuotePair(quote,FRESH_CURRENT_STABLE_BRIDGE);
  const v3Pair=freshPoolStableV3(quote),v3Abi=new Interface([...poolMarketAbi.fragments,'function poolDeployer()view returns(address)']);
  const base=graduatedFlapFixture({quote,nativePair},options),assets=[quote,FRESH_CURRENT_STABLE_BRIDGE].sort();
  const rpc=vi.fn(async<T>(method:string,params:any[])=>{
   if(method==='eth_getCode'){
    if(params[0]===nativePair)return '0x' as T;
    if(params[0]===stablePair)return(options.badCode?'0x6000':pairCode) as T;
    if(params[0]===FRESH_CURRENT_STABLE_BRIDGE)return '0x6000' as T;
    if(options.v3&&[PCS_V3_FACTORY,FRESH_PCS_V3_DEPLOYER].includes(params[0]))return '0x6000' as T;
    if(options.v3&&params[0]===v3Pair)return pairCode as T;
   }
   if(method==='eth_call'){
    const to=params[0].to.toLowerCase();
    if(options.v3&&to===PCS_V3_FACTORY){const call=v3Abi.parseTransaction(params[0])!;
     if(call.name==='poolDeployer')return v3Abi.encodeFunctionResult(call.name,[FRESH_PCS_V3_DEPLOYER]) as T;
     if(call.name==='getPool'&&String(call.args[0]).toLowerCase()===quote&&String(call.args[1]).toLowerCase()===FRESH_CURRENT_STABLE_BRIDGE)
      return v3Abi.encodeFunctionResult(call.name,[options.badV3Registry?pool:v3Pair]) as T;
    }
    if(options.v3&&to===v3Pair){const call=v3Abi.parseTransaction(params[0])!,name=call.name;
     if(name==='factory')return v3Abi.encodeFunctionResult(name,[PCS_V3_FACTORY]) as T;
     if(name==='token0'||name==='token1')return v3Abi.encodeFunctionResult(name,[assets[name==='token0'?0:1]]) as T;
     if(name==='fee')return v3Abi.encodeFunctionResult(name,[2500]) as T;
     if(name==='slot0')return v3Abi.encodeFunctionResult(name,[2n*1000000n*(1n<<96n),290187,0,1,1,0,true]) as T;
     if(name==='liquidity')return v3Abi.encodeFunctionResult(name,[options.emptyV3?0n:1000000n]) as T;
    }
    if(to===TRUSTED_QUOTE_FEEDS[FRESH_CURRENT_STABLE_BRIDGE].feed){
     const name=oracleMarketAbi.parseTransaction(params[0])!.name;
     if(name==='decimals')return oracleMarketAbi.encodeFunctionResult(name,[8]) as T;
     if(name==='description')return oracleMarketAbi.encodeFunctionResult(name,[options.wrongDescription?'Fake / USD':'USDT / USD']) as T;
     return oracleMarketAbi.encodeFunctionResult(name,[3n,97000000n,1n,BigInt(Math.floor(Date.parse(base.block.timestamp)/1000)-(options.stale?100000:5)),3n]) as T;
    }
    if(to===FRESH_CURRENT_STABLE_BRIDGE&&params[0].data===tokenAbi.encodeFunctionData('decimals'))return tokenAbi.encodeFunctionResult('decimals',[options.settlementDecimals??6]) as T;
    if(to===PCS_V2_FACTORY){const call=poolMarketAbi.parseTransaction(params[0])!;
     if(String(call.args[0]).toLowerCase()===quote&&String(call.args[1]).toLowerCase()===FRESH_CURRENT_STABLE_BRIDGE)return poolMarketAbi.encodeFunctionResult('getPair',[stablePair]) as T;
    }
    if(to===stablePair){const call=poolMarketAbi.parseTransaction(params[0])!,name=call.name;
     if(name==='factory')return poolMarketAbi.encodeFunctionResult(name,[PCS_V2_FACTORY]) as T;
     if(name==='token0'||name==='token1')return poolMarketAbi.encodeFunctionResult(name,[assets[name==='token0'?0:1]]) as T;
     if(name==='getReserves'){
      const raw:Record<string,bigint>={[quote]:5n*10n**BigInt(options.quoteDecimals??18),[FRESH_CURRENT_STABLE_BRIDGE]:options.empty?0n:10n*10n**BigInt(options.settlementDecimals??6)};
      return poolMarketAbi.encodeFunctionResult(name,[raw[assets[0]],raw[assets[1]],1]) as T;
     }
    }
   }
   return base.rpc<T>(method,params);
  }) as Rpc&ReturnType<typeof vi.fn>;
  return{rpc,block:base.block,quote,stablePair};
 }
 it.each([{bonding:true,quoteDecimals:18,settlementDecimals:6},{fourmeme:true,quoteDecimals:6,settlementDecimals:18},{}])('uses exact reserve precision and actual 0.97 USDT/USD feed %j',async options=>{
  const f=fixture(options),quote=await freshCurrentQuote(token,f);
  expect(quote).toMatchObject({priceUsd:options.bonding||options.fourmeme?'0.000194':'0.0194',observedAt:f.block.timestamp,
   market:{quoteAddress:f.quote,identity:{quoteConversion:{kind:'authenticated_current_pcs_v2_trusted',pair:f.stablePair,settlementToken:FRESH_CURRENT_STABLE_BRIDGE}},
    state:{settlementReserveRaw:String(10n*10n**BigInt(options.settlementDecimals??6))}}});
  expect(f.rpc.mock.calls.some(([,params])=>params[0]?.to===TRUSTED_QUOTE_FEEDS[FRESH_CURRENT_STABLE_BRIDGE].feed)).toBe(true);
 });
 it.each([{stale:true},{wrongDescription:true},{badCode:true},{empty:true}])('keeps missing or unverified stable bridge explicit %j',async options=>{
  await expect(freshCurrentQuote(token,fixture({...options,bonding:true}))).rejects.toThrow('authenticated_market_quote_unavailable');
 });
 it.each([true,false])('uses the authenticated active V3 route when V2 is empty, bonding=%s',async bonding=>{
  const f=fixture({v3:true,empty:true,bonding}),quote=await freshCurrentQuote(token,f);
  expect(quote).toMatchObject({priceUsd:bonding?'0.00002425':'0.002425',market:{quoteAddress:f.quote,
   identity:{quoteConversion:{kind:'authenticated_current_pcs_v3_trusted',pair:freshPoolStableV3(f.quote),fee:2500}},state:{conversionLiquidityRaw:'1000000'}}});
  expect(quote.market.state).not.toHaveProperty('settlementReserveRaw');expect(quote.market.state).not.toHaveProperty('nativeReserveRaw');
 });
 it.each([{stale:true},{wrongDescription:true},{badV3Registry:true},{emptyV3:true}])('rejects V3 routes without genuine identity/liquidity/dated feed %j',async options=>{
  await expect(freshCurrentQuote(token,fixture({...options,v3:true,empty:true,bonding:true}))).rejects.toThrow('authenticated_market_quote_unavailable');
 });
});
