import {Interface} from 'ethers';
import {describe,it,expect,vi} from 'vitest';
import type {Rpc} from '../rpc.js';
import {PCS_V2_FACTORY,WBNB} from '../launchpad.js';
import {factoryCode,pairCode} from './currentQuote.fixture.js';
import {FRESH_CURRENT_STABLE_BRIDGE,freshPoolNativePair,freshPoolQuotePair,readFreshPoolNativeConversion,readFreshPoolQuoteConversion} from './currentPoolQuote.js';
const quote='0x'+'9'.repeat(40),pair=freshPoolNativePair(quote),assets=[quote,WBNB].sort();
const abi=new Interface(['function decimals()view returns(uint8)','function getPair(address,address)view returns(address)',
 'function factory()view returns(address)','function token0()view returns(address)','function token1()view returns(address)',
 'function getReserves()view returns(uint112,uint112,uint32)']);
function fixture(options:{chain?:string;badCode?:boolean;badRegistry?:boolean;badAssets?:boolean;empty?:boolean;precision?:number;nativePrecision?:number;malformed?:boolean}={}){
 const block={number:100,hash:'0x'+'a'.repeat(64),timestamp:new Date().toISOString()};
 const rpc=vi.fn(async(method:string,params:any[])=>{
  if(method==='eth_chainId')return options.chain??'0x38';
  expect(params[1]).toEqual({blockHash:block.hash,requireCanonical:true});
  if(method==='eth_getCode')return params[0]===PCS_V2_FACTORY?factoryCode:params[0]===pair?options.badCode?'0x00':pairCode:'0x6000';
  const to=params[0].to,call=abi.parseTransaction(params[0])!;
  if(options.malformed&&call.name==='getReserves')return '0x';
  if(call.name==='getPair')return abi.encodeFunctionResult(call.name,[options.badRegistry?quote:pair]);
  if(call.name==='factory')return abi.encodeFunctionResult(call.name,[PCS_V2_FACTORY]);
  if(call.name==='token0'||call.name==='token1')return abi.encodeFunctionResult(call.name,[options.badAssets?quote:assets[call.name==='token0'?0:1]]);
  if(call.name==='decimals')return abi.encodeFunctionResult(call.name,[to===WBNB?options.nativePrecision??18:options.precision??6]);
  if(call.name==='getReserves'){
   const raw:{[address:string]:bigint}={[quote]:options.empty?0n:10n**BigInt(options.precision??6)*5n,[WBNB]:500n*10n**18n};
   return abi.encodeFunctionResult(call.name,[raw[assets[0]],raw[assets[1]],1]);
  }
  throw Error('unapproved_call');
 }) as unknown as Rpc&ReturnType<typeof vi.fn>;
 return{rpc,block};
}
describe('authenticated current controller-quote native conversion',()=>{
 it('preserves the exact same-block reserve ratio and verified precision without a stock or dollar peg',async()=>{
  const options=fixture(),result=await readFreshPoolNativeConversion(quote,options);
  expect(result).toMatchObject({quoteDecimals:6,quoteRaw:5000000n,nativeRaw:500n*10n**18n,observedAt:options.block.timestamp,
   identity:{pair,factory:PCS_V2_FACTORY,quoteToken:quote,nativeToken:WBNB}});
  expect(options.rpc.mock.calls).toHaveLength(11);
 });
 it.each([{chain:'0x1'},{badCode:true},{badRegistry:true},{badAssets:true},{empty:true},{precision:37},{nativePrecision:6},{malformed:true}])('rejects unverified conversion %j',async options=>{
  await expect(readFreshPoolNativeConversion(quote,fixture(options))).rejects.toThrow();
 });
 it('rejects stale/future blocks and invalid/self quote identities before node access',async()=>{
  for(const offset of[-31000,6000]){const options=fixture();options.block.timestamp=new Date(Date.now()+offset).toISOString();await expect(readFreshPoolNativeConversion(quote,options)).rejects.toThrow('pool_quote_current_identity_invalid');expect(options.rpc).not.toHaveBeenCalled();}
  const options=fixture();await expect(readFreshPoolNativeConversion(WBNB,options)).rejects.toThrow('pool_quote_current_identity_invalid');expect(options.rpc).not.toHaveBeenCalled();
 });
});

describe('bounded trusted-asset current reserve conversion',()=>{
 function stableFixture(options:{badFactory?:boolean;badCode?:boolean;badAssets?:boolean;badRegistry?:boolean;empty?:boolean;precision?:number;malformed?:boolean}={}){
  const base=fixture(),settlement=FRESH_CURRENT_STABLE_BRIDGE,pair=freshPoolQuotePair(quote,settlement),assets=[quote,settlement].sort();
  const rpc=vi.fn(async(method:string,params:any[])=>{
   if(method==='eth_chainId')return '0x38';
   expect(params[1]).toEqual({blockHash:base.block.hash,requireCanonical:true});
   if(method==='eth_getCode')return params[0]===PCS_V2_FACTORY?factoryCode:params[0]===pair?options.badCode?'0x6000':pairCode:'0x6000';
   const to=params[0].to,parsed=abi.parseTransaction(params[0])!,name=parsed.name;
   if(name==='getPair')return abi.encodeFunctionResult(name,[options.badRegistry?quote:pair]);
   if(name==='factory')return abi.encodeFunctionResult(name,[options.badFactory?quote:PCS_V2_FACTORY]);
   if(name==='token0'||name==='token1')return abi.encodeFunctionResult(name,[options.badAssets?quote:assets[name==='token0'?0:1]]);
   if(name==='decimals')return abi.encodeFunctionResult(name,[to===quote?18:options.precision??6]);
   if(name==='getReserves'){
    if(options.malformed)return '0x';
    const raw:{[address:string]:bigint}={[quote]:5n*10n**18n,[settlement]:options.empty?0n:10n*10n**BigInt(options.precision??6)};
    return abi.encodeFunctionResult(name,[raw[assets[0]],raw[assets[1]],1]);
   }
   throw Error('unexpected_stable_read');
  }) as unknown as Rpc&ReturnType<typeof vi.fn>;
  return{rpc,block:base.block};
 }
 it('retains raw USDT reserve units and observed precision instead of inventing USD or native reserves',async()=>{
  const options=stableFixture(),result=await readFreshPoolQuoteConversion(quote,FRESH_CURRENT_STABLE_BRIDGE,options);
  expect(result).toMatchObject({quoteDecimals:18,quoteRaw:5n*10n**18n,settlementToken:FRESH_CURRENT_STABLE_BRIDGE,settlementDecimals:6,settlementRaw:10000000n,
   identity:{kind:'authenticated_current_pcs_v2_trusted',pair:freshPoolQuotePair(quote,FRESH_CURRENT_STABLE_BRIDGE),settlementToken:FRESH_CURRENT_STABLE_BRIDGE}});
  expect(result).not.toHaveProperty('nativeRaw');expect(result).not.toHaveProperty('priceUsd');expect(options.rpc.mock.calls).toHaveLength(12);
 });
 it.each([{badFactory:true},{badCode:true},{badAssets:true},{badRegistry:true},{empty:true},{precision:37},{malformed:true}])('rejects unauthenticated or unusable stable conversion %j',async options=>{
  await expect(readFreshPoolQuoteConversion(quote,FRESH_CURRENT_STABLE_BRIDGE,stableFixture(options))).rejects.toThrow();
 });
 it('only accepts trusted feed assets and a fresh canonical block',async()=>{
  const options=stableFixture();await expect(readFreshPoolQuoteConversion(quote,'0x'+'8'.repeat(40),options)).rejects.toThrow('pool_quote_current_identity_invalid');expect(options.rpc).not.toHaveBeenCalled();
  options.block.timestamp=new Date(Date.now()-31000).toISOString();await expect(readFreshPoolQuoteConversion(quote,FRESH_CURRENT_STABLE_BRIDGE,options)).rejects.toThrow('pool_quote_current_identity_invalid');expect(options.rpc).not.toHaveBeenCalled();
 });
});
