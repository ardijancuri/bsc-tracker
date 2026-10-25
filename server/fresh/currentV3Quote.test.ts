import{Interface}from'ethers';import{describe,it,expect,vi}from'vitest';import type{Rpc}from'../rpc.js';
import{PCS_V3_FACTORY}from'../launchpad.js';import{FRESH_CURRENT_STABLE_BRIDGE}from'./currentPoolQuote.js';
import{FRESH_PCS_V3_DEPLOYER,FRESH_PCS_V3_INITCODE_HASH,freshPoolStableV3,readFreshPoolStableV3Conversion}from'./currentV3Quote.js';
import{pairCode}from'./currentQuote.fixture.js';
const abi=new Interface(['function decimals()view returns(uint8)','function getPool(address,address,uint24)view returns(address)','function poolDeployer()view returns(address)',
 'function factory()view returns(address)','function token0()view returns(address)','function token1()view returns(address)','function fee()view returns(uint24)',
 'function liquidity()view returns(uint128)','function slot0()view returns(uint160,int24,uint16,uint16,uint16,uint32,bool)']);
function fixture(options:{quote?:string;chain?:string;badCode?:boolean;badRegistry?:boolean;badDeployer?:boolean;badFactory?:boolean;badAssets?:boolean;fee?:number;
 quotePrecision?:number;settlementPrecision?:number;sqrt?:bigint;tick?:number;liquidity?:bigint;locked?:boolean;badObservation?:boolean;malformed?:boolean}={}){
 const quote=options.quote??'0x'+'9'.repeat(40),pair=freshPoolStableV3(quote),assets=[quote,FRESH_CURRENT_STABLE_BRIDGE].sort(),block={number:100,hash:'0x'+'a'.repeat(64),timestamp:new Date().toISOString()};
 const rpc=vi.fn(async(method:string,params:any[])=>{
  if(method==='eth_chainId')return options.chain??'0x38';expect(params[1]).toEqual({blockHash:block.hash,requireCanonical:true});
  if(method==='eth_getCode')return params[0]===pair?(options.badCode?'0x6000':pairCode):'0x6000';
  const to=params[0].to,call=abi.parseTransaction(params[0])!,name=call.name;
  if(name==='getPool'){expect([...call.args].map(String)).toEqual([expect.any(String),expect.any(String),'2500']);return abi.encodeFunctionResult(name,[options.badRegistry?quote:pair]);}
  if(name==='poolDeployer')return abi.encodeFunctionResult(name,[options.badDeployer?quote:FRESH_PCS_V3_DEPLOYER]);
  if(name==='factory')return abi.encodeFunctionResult(name,[options.badFactory?quote:PCS_V3_FACTORY]);
  if(name==='token0'||name==='token1')return abi.encodeFunctionResult(name,[options.badAssets?quote:assets[name==='token0'?0:1]]);
  if(name==='fee')return abi.encodeFunctionResult(name,[options.fee??2500]);
  if(name==='decimals')return abi.encodeFunctionResult(name,[to===quote?options.quotePrecision??6:options.settlementPrecision??18]);
  if(name==='liquidity')return abi.encodeFunctionResult(name,[options.liquidity??100n]);
  if(name==='slot0')return options.malformed?'0x':abi.encodeFunctionResult(name,[options.sqrt??2n*(1n<<96n),options.tick??13863,options.badObservation?2:0,1,1,0,!options.locked]);
  throw Error('unexpected_bridge_read');
 })as unknown as Rpc&ReturnType<typeof vi.fn>;
 return{rpc,block,quote,pair};
}
describe('fixed authenticated current PCS V3 USDT bridge',()=>{
 it('derives the genuine EWYB fee-2500 pool from official deployer/initcode',()=>{
  expect(freshPoolStableV3('0xbe82f76637dba2c114c41df856c2c51e522e2cb8')).toBe('0xc60ed5b770e8a3abd60ee9ed10faa0aee577a66b');
 });
 it.each(['0x'+'9'.repeat(40),'0x'+'1'.repeat(40)])('keeps the exact raw sqrt ratio in either asset order %s',async quote=>{
  const f=fixture({quote}),result=await readFreshPoolStableV3Conversion(quote,f),is0=quote<FRESH_CURRENT_STABLE_BRIDGE;
  expect(result.rawRatio.numerator* (is0?1n:4n)).toBe(result.rawRatio.denominator*(is0?4n:1n));
  expect(result).toMatchObject({quoteDecimals:6,settlementDecimals:18,settlementToken:FRESH_CURRENT_STABLE_BRIDGE,
   identity:{kind:'authenticated_current_pcs_v3_trusted',pair:f.pair,poolInitcodeHash:FRESH_PCS_V3_INITCODE_HASH,fee:2500},state:{conversionLiquidityRaw:'100'}});
  expect(result.state).not.toHaveProperty('nativeReserveRaw');expect(result.state).not.toHaveProperty('settlementReserveRaw');expect(result).not.toHaveProperty('priceUsd');expect(f.rpc.mock.calls).toHaveLength(16);
 });
 it.each([{chain:'0x1'},{badCode:true},{badRegistry:true},{badDeployer:true},{badFactory:true},{badAssets:true},{fee:500},
  {quotePrecision:37},{settlementPrecision:37},{sqrt:0n},{sqrt:1461446703485210103287273052203988822378723970342n},{tick:887273},{liquidity:0n},{locked:true},{badObservation:true},{malformed:true}])('rejects incomplete/mismatched evidence',async options=>{
  const f=fixture(options);await expect(readFreshPoolStableV3Conversion(f.quote,f)).rejects.toThrow();
 });
 it('rejects stale blocks and self quote before node access',async()=>{
  const f=fixture();f.block.timestamp=new Date(Date.now()-31000).toISOString();await expect(readFreshPoolStableV3Conversion(f.quote,f)).rejects.toThrow('v3_quote_current_identity_invalid');
  f.block.timestamp=new Date().toISOString();await expect(readFreshPoolStableV3Conversion(FRESH_CURRENT_STABLE_BRIDGE,f)).rejects.toThrow('v3_quote_current_identity_invalid');expect(f.rpc).not.toHaveBeenCalled();
 });
});
