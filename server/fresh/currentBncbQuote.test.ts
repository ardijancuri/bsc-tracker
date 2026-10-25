import {Interface,ZeroAddress} from 'ethers';
import {describe,expect,it,vi} from 'vitest';
import type {Rpc} from '../rpc.js';
import {FLAP_PORTAL,FOUR_HELPER,PCS_V2_FACTORY,PCS_V3_FACTORY,WBNB,flapInterface} from '../launchpad.js';
import {oracleMarketAbi,poolMarketAbi,TRUSTED_QUOTE_FEEDS} from '../nodeMarketProtocols.js';
import {freshCurrentQuote,FreshNoLiquidityError,freshQuoteFailureStatus} from './pricing.js';
import {FRESH_BTCB_QUOTE} from './currentBtcQuote.js';
import {FRESH_BNCB_NATIVE_PAIR,FRESH_BNCB_QUOTE,readFreshBncbNativeConversion} from './currentBncbQuote.js';
import {FRESH_FLAP_RECOVERY_POOLS} from './flapQuoteRecovery.js';
import {factoryCode,pairCode} from './currentQuote.fixture.js';

const token='0x'+'7'.repeat(40),hash='0x'+'a'.repeat(64),market='0x'+'2'.repeat(40);
const abi=new Interface(['function decimals() view returns(uint8)','function totalSupply() view returns(uint256)',
  'function name() view returns(string)','function symbol() view returns(string)','function factory() view returns(address)',
  'function token0() view returns(address)','function token1() view returns(address)',
  'function getReserves() view returns(uint112 reserve0,uint112 reserve1,uint32 timestamp)','function getPair(address,address) view returns(address)']);
function fixture(options:{quoteDecimals?:number;nativeDecimals?:number;chain?:string;badCode?:'factory'|'pair'|'quote';badIdentity?:'factory'|'token0'|'token1'|'getPair';
  empty?:boolean;malformed?:boolean;emptyCurve?:boolean;launchQuote?:string;failedDiscovery?:boolean;alternateLiquidity?:boolean;staleFeed?:boolean}={}){
  const block={number:1000,hash,timestamp:new Date().toISOString()},quoteDecimals=options.quoteDecimals??18;
  const quoteRaw=5n*10n**BigInt(quoteDecimals>36?18:quoteDecimals),nativeRaw=500n*10n**18n;
  const rpc=vi.fn(async(method:string,params:unknown[])=>{
    if(method==='eth_chainId')return options.chain??'0x38';
    expect(params[1]).toEqual({blockHash:hash,requireCanonical:true});
    if(method==='eth_getCode'){
      if(params[0]===PCS_V2_FACTORY)return options.badCode==='factory'?'0x00':factoryCode;
      if(params[0]===FRESH_BNCB_QUOTE)return options.badCode==='quote'?'0x':'0x6000';
      expect(params[0]).toBe(FRESH_BNCB_NATIVE_PAIR);return options.badCode==='pair'?'0x00':pairCode;
    }
    expect(method).toBe('eth_call');const call=params[0] as {to:string;data:string},to=call.to.toLowerCase();
    if(to===FOUR_HELPER)throw Error('not_fourmeme');
    if(to===FLAP_PORTAL){
      const name=flapInterface.parseTransaction(call)!.name;
      return flapInterface.encodeFunctionResult(name,[[1,options.emptyCurve?0n:10n**BigInt(quoteDecimals),5n*10n**25n,60_000_000n,6,
        60_000_000_000_000_000n,107036751n*10n**18n,66370312712296875000000000n,8n*10n**26n,
        options.launchQuote??FRESH_BNCB_QUOTE,true,hash,100,100,ZeroAddress,1n,0,0]]);
    }
    if(to===PCS_V2_FACTORY||to===PCS_V3_FACTORY){
      const p=poolMarketAbi.parseTransaction(call)!;
      if(p.name==='getPool'){
        if(options.failedDiscovery&&Number(p.args[2])===500)throw Error('transport_failure');
        return poolMarketAbi.encodeFunctionResult(p.name,[ZeroAddress]);
      }
      if(String(p.args[0]).toLowerCase()===FRESH_BNCB_QUOTE&&String(p.args[1]).toLowerCase()===WBNB)
        return poolMarketAbi.encodeFunctionResult(p.name,[options.badIdentity==='getPair'?market:FRESH_BNCB_NATIVE_PAIR]);
      return poolMarketAbi.encodeFunctionResult(p.name,[String(p.args[1]).toLowerCase()===(options.alternateLiquidity?WBNB:options.launchQuote??FRESH_BNCB_QUOTE)?market:ZeroAddress]);
    }
    if(to===market){
      const p=poolMarketAbi.parseTransaction(call)!;
      if(p.name==='factory')return poolMarketAbi.encodeFunctionResult(p.name,[PCS_V2_FACTORY]);
      if(p.name==='token0')return poolMarketAbi.encodeFunctionResult(p.name,[token]);
      if(p.name==='token1')return poolMarketAbi.encodeFunctionResult(p.name,[options.alternateLiquidity?WBNB:options.launchQuote??FRESH_BNCB_QUOTE]);
      if(p.name==='getReserves')return poolMarketAbi.encodeFunctionResult(p.name,[options.alternateLiquidity?1000n*10n**18n:0n,options.alternateLiquidity?10n*10n**18n:0n,1]);
    }
    if(to===TRUSTED_QUOTE_FEEDS[WBNB].feed){
      const p=oracleMarketAbi.parseTransaction(call)!;
      if(p.name==='decimals')return oracleMarketAbi.encodeFunctionResult(p.name,[8]);
      if(p.name==='description')return oracleMarketAbi.encodeFunctionResult(p.name,[TRUSTED_QUOTE_FEEDS[WBNB].description]);
      return oracleMarketAbi.encodeFunctionResult(p.name,[1n,600n*10n**8n,1n,BigInt(Math.floor(Date.parse(block.timestamp)/1000)-(options.staleFeed?100000:0)),1n]);
    }
    const p=abi.parseTransaction(call)!;
    if(to===FRESH_BNCB_NATIVE_PAIR){
      if(options.malformed&&p.name==='getReserves')return '0x00';
      if(p.name==='factory')return abi.encodeFunctionResult(p.name,[options.badIdentity==='factory'?token:PCS_V2_FACTORY]);
      if(p.name==='token0')return abi.encodeFunctionResult(p.name,[options.badIdentity==='token0'?token:FRESH_BNCB_QUOTE]);
      if(p.name==='token1')return abi.encodeFunctionResult(p.name,[options.badIdentity==='token1'?token:WBNB]);
      if(p.name==='getReserves')return abi.encodeFunctionResult(p.name,[options.empty?0n:quoteRaw,nativeRaw,1]);
    }
    if(p.name==='decimals')return abi.encodeFunctionResult(p.name,[to===FRESH_BNCB_QUOTE?quoteDecimals:to===WBNB?options.nativeDecimals??18:18]);
    if(to===token&&p.name==='totalSupply')return abi.encodeFunctionResult(p.name,[10n**27n]);
    if(to===token&&p.name==='name')return abi.encodeFunctionResult(p.name,['BNCB token']);
    if(to===token&&p.name==='symbol')return abi.encodeFunctionResult(p.name,['NEW']);
    throw Error('unexpected_current_read');
  }) as Rpc&ReturnType<typeof vi.fn>;
  return{rpc,block,quoteRaw,nativeRaw};
}

describe('current BNCB conversion',()=>{
  it('reuses the authenticated historical route identity but reads fresh canonical code, precision and reserves',async()=>{
    const f=fixture(),value=await readFreshBncbNativeConversion(f);
    expect(FRESH_BNCB_NATIVE_PAIR).toBe(FRESH_FLAP_RECOVERY_POOLS[1].pool);
    expect(value).toMatchObject({quoteDecimals:18,quoteRaw:f.quoteRaw,nativeRaw:f.nativeRaw,observedAt:f.block.timestamp,
      identity:{pair:FRESH_BNCB_NATIVE_PAIR,factory:PCS_V2_FACTORY,quoteToken:FRESH_BNCB_QUOTE,nativeToken:WBNB}});
    expect(f.rpc.mock.calls).toHaveLength(11);
  });
  it.each([6,18])('uses verified %i-decimal precision and reserve ratios without a stock peg',async quoteDecimals=>{
    expect(await freshCurrentQuote(token,fixture({quoteDecimals}))).toMatchObject({priceUsd:'0.0000036',marketCapUsd:'3600',
      market:{quoteAddress:FRESH_BNCB_QUOTE,identity:{quoteConversion:{pair:FRESH_BNCB_NATIVE_PAIR,quoteDecimals}}}});
  });
  it.each(['factory','pair','quote'] as const)('rejects missing/unauthenticated %s code',async badCode=>{
    await expect(readFreshBncbNativeConversion(fixture({badCode}))).rejects.toThrow('bncb_quote_code_invalid');
  });
  it.each(['factory','token0','token1','getPair'] as const)('rejects contradictory %s identity',async badIdentity=>{
    await expect(readFreshBncbNativeConversion(fixture({badIdentity}))).rejects.toThrow('bncb_quote_pair_identity_invalid');
  });
  it('fails closed for wrong chain, empty reserve, unsupported precision and malformed returns',async()=>{
    await expect(readFreshBncbNativeConversion(fixture({chain:'0x1'}))).rejects.toThrow('bncb_quote_chain_invalid');
    await expect(readFreshBncbNativeConversion(fixture({empty:true}))).rejects.toThrow('bncb_quote_pool_empty');
    await expect(readFreshBncbNativeConversion(fixture({quoteDecimals:37}))).rejects.toThrow('bncb_quote_precision_invalid');
    await expect(readFreshBncbNativeConversion(fixture({nativeDecimals:17}))).rejects.toThrow('bncb_quote_precision_invalid');
    await expect(readFreshBncbNativeConversion(fixture({malformed:true}))).rejects.toThrow('bncb_quote_state_invalid');
  });
  it.each([-31000,6000])('rejects historical/future block time %i without any RPC',async offset=>{
    const f=fixture();f.block.timestamp=new Date(Date.now()+offset).toISOString();
    await expect(readFreshBncbNativeConversion(f)).rejects.toThrow('bncb_quote_current_block_required');expect(f.rpc).not.toHaveBeenCalled();
  });
  it('never substitutes another block when canonical reads fail',async()=>{
    const f=fixture(),rpc:Rpc=async(method,params)=>{if(method==='eth_call')throw Error('canonical_state_unavailable');return f.rpc(method,params);};
    await expect(readFreshBncbNativeConversion({...f,rpc})).rejects.toThrow('canonical_state_unavailable');
  });
  it('requires genuine fresh BNB/USD evidence',async()=>{
    await expect(freshCurrentQuote(token,fixture({staleFeed:true}))).rejects.toThrow('authenticated_market_quote_unavailable');
  });
});

describe('explicit current no-liquidity state',()=>{
  it('distinguishes verified empty Flap and fully checked alternate markets without valuing a token at zero',async()=>{
    let error:unknown;try{await freshCurrentQuote(token,fixture({emptyCurve:true,launchQuote:FRESH_BTCB_QUOTE}));}catch(value){error=value;}
    expect(error).toBeInstanceOf(FreshNoLiquidityError);expect(freshQuoteFailureStatus(error)).toBe('no_liquidity');
    expect(freshQuoteFailureStatus(new Error('authenticated_markets_no_liquidity'))).toBe('quote_unavailable');
  });
  it('does not call failed discovery empty, while an authenticated new quote with complete empty discovery is definitive',async()=>{
    await expect(freshCurrentQuote(token,fixture({emptyCurve:true,failedDiscovery:true,launchQuote:FRESH_BTCB_QUOTE}))).rejects.toThrow('authenticated_market_quote_unavailable');
    await expect(freshCurrentQuote(token,fixture({emptyCurve:true,launchQuote:'0x'+'9'.repeat(40)}))).rejects.toBeInstanceOf(FreshNoLiquidityError);
  });
  it('uses an authenticated liquid alternate market even when the launch reserve is empty',async()=>{
    expect(await freshCurrentQuote(token,fixture({emptyCurve:true,launchQuote:FRESH_BTCB_QUOTE,alternateLiquidity:true}))).toMatchObject({priceUsd:'6',marketCapUsd:'6000000000',market:{protocol:'pcs_v2',address:market}});
  });
  it('returns a positive current quote as soon as launch liquidity is restored',async()=>{
    await expect(freshCurrentQuote(token,fixture({emptyCurve:true}))).rejects.toBeInstanceOf(FreshNoLiquidityError);
    expect(await freshCurrentQuote(token,fixture())).toMatchObject({priceUsd:'0.0000036'});
  });
});
