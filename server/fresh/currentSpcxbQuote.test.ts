import {Interface,ZeroAddress} from 'ethers';
import {describe,expect,it,vi} from 'vitest';
import type {Rpc} from '../rpc.js';
import {FLAP_PORTAL,FOUR_HELPER,PCS_V2_FACTORY,PCS_V3_FACTORY,WBNB,flapInterface} from '../launchpad.js';
import {oracleMarketAbi,poolMarketAbi,TRUSTED_QUOTE_FEEDS} from '../nodeMarketProtocols.js';
import {freshCurrentQuote} from './pricing.js';
import {freshCurrentNativePair,readFreshCurrentNativeConversion} from './currentNativeQuote.js';
import {FRESH_SPCXB_QUOTE,FRESH_SPCXB_NATIVE_PAIR,readFreshSpcxbNativeConversion} from './currentSpcxbQuote.js';
import {factoryCode,pairCode} from './currentQuote.fixture.js';
const token='0x'+'7'.repeat(40),hash='0x'+'a'.repeat(64);
const abi=new Interface(['function decimals() view returns(uint8)','function totalSupply() view returns(uint256)',
  'function name() view returns(string)','function symbol() view returns(string)','function factory() view returns(address)',
  'function token0() view returns(address)','function token1() view returns(address)',
  'function getReserves() view returns(uint112 reserve0,uint112 reserve1,uint32 timestamp)']);
function fixture(options:{decimals?:number;nativeDecimals?:number;chain?:string;badCode?:boolean;badPair?:boolean;badOrder?:boolean;empty?:boolean;malformed?:boolean;staleFeed?:boolean;badFeed?:boolean}={}){
  const block={number:1000,hash,timestamp:new Date().toISOString()},decimals=options.decimals??18;
  const quoteRaw=5n*10n**BigInt(decimals>36?18:decimals),nativeRaw=500n*10n**18n;
  const rpc=vi.fn(async(method:string,params:unknown[])=>{
    if(method==='eth_chainId')return options.chain??'0x38';
    expect(params[1]).toEqual({blockHash:hash,requireCanonical:true});
    if(method==='eth_getCode'){
      if(params[0]===PCS_V2_FACTORY)return factoryCode;
      if(params[0]===FRESH_SPCXB_QUOTE)return '0x6000';
      expect(params[0]).toBe(FRESH_SPCXB_NATIVE_PAIR);return options.badCode?'0x00':pairCode;
    }
    expect(method).toBe('eth_call');const call=params[0] as{to:string;data:string},to=call.to.toLowerCase();
    if(to===FOUR_HELPER)throw Error('not_fourmeme');
    if(to===FLAP_PORTAL){const name=flapInterface.parseTransaction(call)!.name;return flapInterface.encodeFunctionResult(name,[[1,10n**18n,5n*10n**25n,60_000_000n,6,
      60_000_000_000_000_000n,107036751n*10n**18n,66370312712296875000000000n,8n*10n**26n,FRESH_SPCXB_QUOTE,true,hash,100,100,ZeroAddress,1n,0,0]]);}
    if(to===PCS_V2_FACTORY||to===PCS_V3_FACTORY){const p=poolMarketAbi.parseTransaction(call)!;return poolMarketAbi.encodeFunctionResult(p.name,[p.name==='getPair'&&String(p.args[0]).toLowerCase()===FRESH_SPCXB_QUOTE?(options.badPair?token:FRESH_SPCXB_NATIVE_PAIR):ZeroAddress]);}
    if(to===TRUSTED_QUOTE_FEEDS[WBNB].feed){const p=oracleMarketAbi.parseTransaction(call)!;
      if(p.name==='decimals')return oracleMarketAbi.encodeFunctionResult(p.name,[8]);
      if(p.name==='description')return oracleMarketAbi.encodeFunctionResult(p.name,[options.badFeed?'FAKE / USD':TRUSTED_QUOTE_FEEDS[WBNB].description]);
      return oracleMarketAbi.encodeFunctionResult(p.name,[1n,600n*10n**8n,1n,BigInt(Math.floor(Date.parse(block.timestamp)/1000)-(options.staleFeed?100000:0)),1n]);}
    const p=abi.parseTransaction(call)!;
    if(to===FRESH_SPCXB_NATIVE_PAIR){
      if(p.name==='factory')return abi.encodeFunctionResult(p.name,[PCS_V2_FACTORY]);
      if(p.name==='token0')return abi.encodeFunctionResult(p.name,[options.badOrder?FRESH_SPCXB_QUOTE:WBNB]);
      if(p.name==='token1')return abi.encodeFunctionResult(p.name,[options.badOrder?WBNB:FRESH_SPCXB_QUOTE]);
      if(p.name==='getReserves')return options.malformed?'0x00':abi.encodeFunctionResult(p.name,[nativeRaw,options.empty?0n:quoteRaw,1]);
    }
    if(p.name==='decimals')return abi.encodeFunctionResult(p.name,[to===FRESH_SPCXB_QUOTE?decimals:to===WBNB?options.nativeDecimals??18:18]);
    if(to===token&&p.name==='totalSupply')return abi.encodeFunctionResult(p.name,[10n**27n]);
    if(to===token&&p.name==='name')return abi.encodeFunctionResult(p.name,['ELON']);
    if(to===token&&p.name==='symbol')return abi.encodeFunctionResult(p.name,['ELON']);
    throw Error('unexpected_current_read');
  }) as Rpc&ReturnType<typeof vi.fn>;
  return{block,rpc,quoteRaw,nativeRaw};
}
describe('bounded current SPCXB native conversion',()=>{
  it('derives the observed PCS V2 SPCXB/WBNB pool and handles its reversed currency ordering',async()=>{
    const f=fixture(),value=await readFreshSpcxbNativeConversion(f);
    expect(FRESH_SPCXB_NATIVE_PAIR).toBe('0x7b07ef0c9fc2198de1d20b2828845862179ccf6f');
    expect(value).toMatchObject({quoteRaw:f.quoteRaw,nativeRaw:f.nativeRaw,quoteDecimals:18,observedAt:f.block.timestamp,
      identity:{quoteToken:FRESH_SPCXB_QUOTE,token0:WBNB,token1:FRESH_SPCXB_QUOTE,pair:FRESH_SPCXB_NATIVE_PAIR}});
    expect(f.rpc.mock.calls).toHaveLength(11);
  });
  it.each([6,18])('converts Flap price using verified %i-decimal SPCXB and current reserve ratios plus real BNB/USD',async decimals=>{
    expect(await freshCurrentQuote(token,fixture({decimals}))).toMatchObject({priceUsd:'0.0000036',marketCapUsd:'3600',
      market:{quoteAddress:FRESH_SPCXB_QUOTE,identity:{quoteConversion:{pair:FRESH_SPCXB_NATIVE_PAIR,quoteDecimals:decimals}}}});
  });
  it.each([['badCode','spcxb_quote_code_invalid'],['badPair','spcxb_quote_pair_identity_invalid'],['badOrder','spcxb_quote_pair_identity_invalid'],
    ['empty','spcxb_quote_pool_empty'],['malformed','spcxb_quote_state_invalid']] as const)('fails closed for %s',async(field,reason)=>{
    await expect(readFreshSpcxbNativeConversion(fixture({[field]:true}))).rejects.toThrow(reason);
  });
  it('requires the correct chain and verified quote/native precision',async()=>{
    await expect(readFreshSpcxbNativeConversion(fixture({chain:'0x1'}))).rejects.toThrow('spcxb_quote_chain_invalid');
    await expect(readFreshSpcxbNativeConversion(fixture({decimals:37}))).rejects.toThrow('spcxb_quote_precision_invalid');
    await expect(readFreshSpcxbNativeConversion(fixture({nativeDecimals:17}))).rejects.toThrow('spcxb_quote_precision_invalid');
  });
  it.each([-31000,6000])('rejects historical/future observations %i without RPC',async offset=>{
    const f=fixture();f.block.timestamp=new Date(Date.now()+offset).toISOString();await expect(readFreshSpcxbNativeConversion(f)).rejects.toThrow('spcxb_quote_current_block_required');expect(f.rpc).not.toHaveBeenCalled();
  });
  it.each(['staleFeed','badFeed'] as const)('cannot approve price with %s',async field=>{
    await expect(freshCurrentQuote(token,fixture({[field]:true}))).rejects.toThrow('authenticated_market_quote_unavailable');
  });
  it('never falls back from unavailable canonical state to current or historical substitutes',async()=>{
    const f=fixture(),rpc:Rpc=async(method,params)=>{if(method==='eth_call')throw Error('canonical_state_unavailable');return f.rpc(method,params);};
    await expect(readFreshSpcxbNativeConversion({...f,rpc})).rejects.toThrow('canonical_state_unavailable');
  });
  it('does not extend conversion to arbitrary assets or inherited registry keys',async()=>{
    const f=fixture();await expect(readFreshCurrentNativeConversion('USDT' as never,f)).rejects.toThrow('current_native_quote_unsupported');
    await expect(readFreshCurrentNativeConversion('toString' as never,f)).rejects.toThrow('current_native_quote_unsupported');
    expect(()=>freshCurrentNativePair('USDT' as never)).toThrow('current_native_quote_unsupported');expect(f.rpc).not.toHaveBeenCalled();
  });
});
