import{Interface,ZeroAddress}from'ethers';import{describe,it,expect}from'vitest';import type{Rpc}from'../rpc.js';
import{FLAP_PORTAL,WBNB,PCS_V2_FACTORY,flapInterface}from'../launchpad.js';import{factoryCode,pairCode}from'./currentQuote.fixture.js';
import{freshPoolNativePair}from'./currentPoolQuote.js';import{readFreshCapturedFlapCurve,recoverFreshHistoricalFlapCurveQuote}from'./historicalFlapCurveQuote.js';
import type{FreshStateReadEvidence}from'./stateEvidence.js';import type{FreshTokenMetadata}from'./pricing.js';import type{FreshLog}from'./capture.js';
const token='0x'+'1'.repeat(40),quote='0x'+'9'.repeat(40),h=(n:number)=>'0x'+n.toString(16).padStart(64,'0'),hex=(n:number)=>'0x'+n.toString(16);
const abi=new Interface(['function decimals()view returns(uint8)','function totalSupply()view returns(uint256)','event Sync(uint112 reserve0,uint112 reserve1)']);
function fixture(factor=1n,quoteAddress=quote){
 const target={number:10000,hash:h(10000),timestamp:new Date(Date.now()-600000).toISOString()},anchor={number:10020,hash:h(10020),timestamp:new Date().toISOString()};
 const metadata:FreshTokenMetadata={address:token,decimals:18,name:null,symbol:null,supplyRaw:String(10n**27n),block:target};
 const values:any[]=[1,5n*10n**23n/factor,5n*10n**26n,10n**15n,6,10n**23n,10n**26n,36n*10n**31n,8n*10n**26n,quoteAddress,false,h(9),0,0,ZeroAddress,0,0,0];
 const source:FreshStateReadEvidence={version:1,blockNumber:target.number,blockHash:target.hash,calls:[
  {to:token,data:abi.encodeFunctionData('decimals'),result:abi.encodeFunctionResult('decimals',[18])},
  {to:token,data:abi.encodeFunctionData('totalSupply'),result:abi.encodeFunctionResult('totalSupply',[10n**27n])},
  {to:FLAP_PORTAL,data:flapInterface.encodeFunctionData('getTokenV8Safe',[token]),result:flapInterface.encodeFunctionResult('getTokenV8Safe',[values])},
 ]};
 const pair=freshPoolNativePair(quote),makeSync=(index:number,native:bigint):FreshLog=>({address:pair,...abi.encodeEventLog('Sync',[10n**6n,native]),blockNumber:hex(10000),blockHash:h(10000),transactionIndex:hex(index),transactionHash:h(7000+index),logIndex:hex(index+1)});
 const logs=[makeSync(1,10n**18n),makeSync(5,2n*10n**18n)],methods:string[]=[];
 const rpc=(async(method:string,params:any[])=>{methods.push(method);if(method==='eth_chainId')return'0x38';if(method==='eth_getCode')return params[0]===PCS_V2_FACTORY?factoryCode:pairCode;if(method==='eth_getLogs')return logs;throw Error('no_historical_state');})as Rpc;
 const mutate=(index:number,value:unknown)=>{values[index]=value;source.calls.find(c=>c.to===FLAP_PORTAL)!.result=flapInterface.encodeFunctionResult('getTokenV8Safe',[values]);};
 return{source,metadata,methods,logs,mutate,options:{tokenAddress:token,target,source,anchor,rpc,canonicalHash:async(n:number)=>h(n)}};
}
describe('captured generic Flap curve mark and historical raw quote conversion',()=>{
 it.each([1n,10n**12n])('proves the unique model factor %s without claiming quote decimals',factor=>{
  const f=fixture(factor),curve=readFreshCapturedFlapCurve(f.options);
  expect(curve).toMatchObject({quoteAddress:quote,reserveModelFactor:String(factor),rawQuotePerToken:{numerator:String(10n**15n),denominator:String(10n**18n*factor)}});
 });
 it('combines actual block-end curve/quote evidence, replays retained proof and never requests historical metadata/current reserves',async()=>{
  const f=fixture(10n**12n),proof=await recoverFreshHistoricalFlapCurveQuote(f.options);
  expect(proof).toMatchObject({priceNative:'0.002',conversion:{observation:'block_end',pool:{lastSync:{transactionIndex:'0x5'}}}});
  expect(f.methods).not.toContain('eth_call');
  expect(await recoverFreshHistoricalFlapCurveQuote({...f.options,prior:proof,rpc:(async()=>{throw Error('no_rpc');})as Rpc})).toEqual(proof);
  await expect(recoverFreshHistoricalFlapCurveQuote({...f.options,prior:{...proof,priceNative:'0'}})).rejects.toThrow('captured_flap_prior_invalid');
 });
 it('supports native BNB only from captured curve evidence without a pool lookup',async()=>{
  const f=fixture(1n,ZeroAddress),proof=await recoverFreshHistoricalFlapCurveQuote(f.options);
  expect(proof).toMatchObject({priceNative:'0.001',curve:{quoteAddress:WBNB},conversion:null});expect(f.methods).toEqual([]);
 });
 it('requires actual target supply and raw precision, or separately revalidated target precision',()=>{
  const f=fixture();f.source.calls=f.source.calls.filter(c=>c.data!==abi.encodeFunctionData('decimals'));
  expect(()=>readFreshCapturedFlapCurve(f.options)).toThrow('captured_flap_precision_unverified');
  expect(readFreshCapturedFlapCurve({...f.options,verifiedMetadata:f.metadata})).toMatchObject({precisionBasis:'independently_verified_target_metadata'});
  expect(()=>readFreshCapturedFlapCurve({...f.options,verifiedMetadata:{...f.metadata,block:{...f.metadata.block,hash:h(9)}}})).toThrow('captured_flap_precision_unverified');
  f.source.calls=f.source.calls.filter(c=>c.data!==abi.encodeFunctionData('totalSupply'));
  expect(()=>readFreshCapturedFlapCurve({...f.options,verifiedMetadata:f.metadata})).toThrow('captured_flap_source_incomplete');
 });
 it('rejects wrong controller state/version/supply/price invariants and zero or ambiguous normalization',()=>{
  for(const[index,value]of[[0,4],[1,0],[2,10n**28n],[3,1],[4,5],[5,0],[6,0],[7,0]]as const){const f=fixture();f.mutate(index,value);expect(()=>readFreshCapturedFlapCurve(f.options)).toThrow();}
  const f=fixture();f.source.calls[1].result=abi.encodeFunctionResult('totalSupply',[10n**27n-1n]);expect(()=>readFreshCapturedFlapCurve(f.options)).toThrow('captured_flap_supply_unsupported');
 });
 it('rejects foreign source blocks, duplicate/malformed calls, changed proof and canonical reorgs',async()=>{
  const f=fixture();f.source.blockHash=h(9);expect(()=>readFreshCapturedFlapCurve(f.options)).toThrow('captured_flap_source_invalid');
  const g=fixture();g.source.calls.push(g.source.calls[0]);expect(()=>readFreshCapturedFlapCurve(g.options)).toThrow('captured_flap_source_invalid');
  const j=fixture();await expect(recoverFreshHistoricalFlapCurveQuote({...j.options,canonicalHash:async()=>h(9)})).rejects.toThrow('captured_flap_noncanonical');
 });
});
