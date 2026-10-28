import{Interface,ZeroAddress}from'ethers';import{describe,it,expect}from'vitest';import type{Rpc}from'../rpc.js';
import{FLAP_PORTAL,WBNB,PCS_V2_FACTORY,PCS_V3_FACTORY,flapInterface}from'../launchpad.js';import{factoryCode,pairCode}from'./currentQuote.fixture.js';
import{freshPoolNativePair}from'./currentPoolQuote.js';import{readFreshCapturedFlapCurve,recoverFreshHistoricalFlapCurveQuote}from'./historicalFlapCurveQuote.js';
import{freshHistoricalV3Pool}from'./historicalV3Quote.js';import{FRESH_PCS_V3_DEPLOYER}from'./currentV3Quote.js';import{v3MarketAbi}from'../nodeMarketProtocols.js';
import{oracleMarketAbi,TRUSTED_QUOTE_FEEDS}from'../nodeMarketProtocols.js';import{createFreshReceiptRecovery}from'./recovery.js';import type{Pool}from'pg';import type{FreshCapturedReceipt}from'./capture.js';
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

function v3Fixture(options:{badRegistry?:boolean;badFactory?:boolean;badAsset?:boolean;badCode?:boolean;removed?:boolean;age?:number;missingSwaps?:boolean;reorg?:boolean}={}){
 const f=fixture(),pool=freshHistoricalV3Pool(quote,WBNB,100),assets=[quote,WBNB].sort(),source={number:options.age?9999:10000,hash:h(options.age?9999:10000),timestamp:new Date(Math.floor((Date.parse(f.options.target.timestamp)-(options.age??0))/1000)*1000).toISOString()};f.logs.length=0;
 const identity=new Interface(['function getPool(address,address,uint24)view returns(address)','function poolDeployer()view returns(address)','function factory()view returns(address)','function token0()view returns(address)','function token1()view returns(address)','function fee()view returns(uint24)']);
 const event=v3MarketAbi.encodeEventLog(v3MarketAbi.getEvent('Swap')!,[token,token,1n,-1n,2n*(1n<<96n),100n,13863,0n,0n]),swap:FreshLog={address:pool,...event,blockNumber:hex(source.number),blockHash:source.hash,transactionHash:h(7000),transactionIndex:'0x9',logIndex:'0x1',...(options.removed?{removed:true}:{})},calls:{method:string;params:any[]}[]=[];
 const rpc=(async(method:string,params:any[])=>{calls.push({method,params});if(method==='eth_getCode'&&[PCS_V3_FACTORY,FRESH_PCS_V3_DEPLOYER,pool].includes(params[0]))return params[0]===pool?(options.badCode?'0x60':'0x'+'60'.repeat(1025)):'0x6000';
  if(method==='eth_getLogs'&&params[0].address===pool)return options.missingSwaps?[]:[swap];if(method==='eth_getBlockByNumber')return{number:hex(source.number),hash:source.hash,timestamp:hex(Date.parse(source.timestamp)/1000)};
  if(method==='eth_call'){const parsed=identity.parseTransaction(params[0]);if(!parsed)throw Error('unexpected_call');const name=parsed.name;
   if(name==='getPool')return identity.encodeFunctionResult(name,[options.badRegistry?quote:pool]);if(name==='poolDeployer')return identity.encodeFunctionResult(name,[FRESH_PCS_V3_DEPLOYER]);if(name==='factory')return identity.encodeFunctionResult(name,[options.badFactory?quote:PCS_V3_FACTORY]);
   if(name==='token0'||name==='token1')return identity.encodeFunctionResult(name,[options.badAsset?token:assets[name==='token0'?0:1]]);if(name==='fee')return identity.encodeFunctionResult(name,[100]);throw Error('unexpected_historical_state_call');}
  return f.options.rpc(method,params);
 })as Rpc;
 return{...f,pool,swap,calls,options:{...f.options,rpc,canonicalHash:async(n:number)=>options.reorg&&n===source.number?h(9):h(n)}};
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
 it('derives the actual direct B9/WBNB fee100 pool without a symbol or precision assumption',()=>{expect(freshHistoricalV3Pool('0xb9e1fd5a02d3a33b25a14d661414e6ed6954a721',WBNB,100)).toBe('0x0b2eb4332a15e5165477aad2c79721925920a383');});
 it('uses an authenticated block-end direct V3 raw ratio when the genuine V2 market has no historical Sync',async()=>{
  const f=v3Fixture(),proof=await recoverFreshHistoricalFlapCurveQuote(f.options);
  expect(proof).toMatchObject({conversion:null,v3Conversion:{quoteAddress:quote,settlementAddress:WBNB,fee:100,observation:'block_end',target:f.options.target,lastSwap:{transactionIndex:'0x9'}},priceNative:'0.004'});
  expect(proof.v3Conversion?.identity.pool).toBe(f.pool);expect(f.calls.filter(c=>c.method==='eth_call').every(c=>!['0x313ce567','0x3850c7bd','0x1a686502'].includes(c.params[0].data))).toBe(true);
  let network=0;const none=(async()=>{network++;throw Error('no_rpc');})as Rpc;expect(await recoverFreshHistoricalFlapCurveQuote({...f.options,prior:proof,rpc:none})).toEqual(proof);expect(network).toBe(0);
  await expect(recoverFreshHistoricalFlapCurveQuote({...f.options,prior:{...proof,v3Conversion:{...proof.v3Conversion!,ratio:{numerator:'1',denominator:'1'}}},rpc:none})).rejects.toThrow('historical_v3_prior_invalid');
 });
 it.each([{badRegistry:true},{badFactory:true},{badAsset:true},{badCode:true},{removed:true},{age:120001},{missingSwaps:true},{reorg:true}])('keeps absent, stale, noncanonical or counterfeit V3 conversion explicit: %s',async options=>{await expect(recoverFreshHistoricalFlapCurveQuote(v3Fixture(options).options)).rejects.toThrow();});
 it('does not hide malformed V2 evidence by trying a different conversion route',async()=>{const f=v3Fixture();f.logs.push({...f.swap,address:freshPoolNativePair(quote)});await expect(recoverFreshHistoricalFlapCurveQuote(f.options)).rejects.toThrow();expect(f.calls.some(c=>c.method==='eth_call')).toBe(false);});
 it('never switches a retained valid V2 proof to V3 and rejects mixed conversion proofs',async()=>{const old=fixture(),proof=await recoverFreshHistoricalFlapCurveQuote(old.options),f=v3Fixture();expect(await recoverFreshHistoricalFlapCurveQuote({...old.options,prior:proof,rpc:(async()=>{throw Error('no_rpc');})as Rpc})).toEqual(proof);const v3=await recoverFreshHistoricalFlapCurveQuote(f.options);await expect(recoverFreshHistoricalFlapCurveQuote({...f.options,prior:{...v3,conversion:proof.conversion}})).rejects.toThrow('captured_flap_prior_invalid');});
 it('reuses the retained V3 anchor and dated native feed through receipt recovery without a current-anchor lookup or any RPC',async()=>{
  const f=v3Fixture(),target=f.options.target,stamp=Math.floor(Date.parse(target.timestamp)/1000),feed=TRUSTED_QUOTE_FEEDS[WBNB];
  for(const[method,values]of[['decimals',[8]],['description',[feed.description]],['latestRoundData',[1,600n*10n**8n,stamp-1,stamp-1,1]]]as[string,unknown[]][])f.source.calls.push({to:feed.feed,data:oracleMarketAbi.encodeFunctionData(method),result:oracleMarketAbi.encodeFunctionResult(method,values)});
  const proof=await recoverFreshHistoricalFlapCurveQuote(f.options),entry:FreshCapturedReceipt={transaction:{hash:h(7000),from:token,to:FLAP_PORTAL,blockHash:target.hash,blockNumber:hex(target.number),transactionIndex:'0x0',value:'0x0'},receipt:{transactionHash:h(7000),blockHash:target.hash,blockNumber:hex(target.number),transactionIndex:'0x0',status:'0x1',gasUsed:'0x1',logs:[]},wallets:[token],observedAt:target.timestamp,stateEvidence:f.source,recoveryEvidence:{version:1,target,metadata:{},quotes:[],pools:[],flapCurveQuotes:[proof]}};
  let currentAnchors=0,rpcCalls=0;const db={query:async(sql:string,params:unknown[])=>{if(sql.startsWith('SELECT block_hash FROM fresh.recent_blocks'))return{rows:[{block_hash:h(Number(params[0]))}]};if(sql.startsWith('SELECT * FROM fresh.launch_facts'))return{rows:[{protocol:'flap',status:'eligible',block_number:'100'}]};if(sql.includes("c.key='capture'")){currentAnchors++;throw Error('current_anchor_unavailable');}throw Error('unexpected_database_query');}}as unknown as Pool,none=(async()=>{rpcCalls++;throw Error('no_rpc');})as Rpc;
  const recovered=createFreshReceiptRecovery(db,none,entry,target);expect(await recovered.priceUsd(token)).toBe('2.4');expect(recovered.snapshot()!.flapCurveQuotes).toEqual([proof]);expect(currentAnchors).toBe(0);expect(rpcCalls).toBe(0);
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
