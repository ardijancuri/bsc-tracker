import {describe,it,expect,vi} from 'vitest';
import {Interface} from 'ethers';
import type {Rpc} from '../rpc.js';
import {PCS_V3_FACTORY} from '../launchpad.js';
import {v3MarketAbi} from '../nodeMarketProtocols.js';
import {FRESH_PCS_V3_DEPLOYER} from './currentV3Quote.js';
import {freshHistoricalV3Pool,recoverFreshHistoricalV3Quote,valueFreshHistoricalV3QuoteRaw} from './historicalV3Quote.js';
import {recoverFreshHistoricalQuote} from './historicalQuote.js';
const h=(n:number)=>'0x'+n.toString(16).padStart(64,'0'),quote='0x'+'9'.repeat(40),settlement='0x55d398326f99059ff775485246999027b3197955';
const abi=new Interface(['function getPool(address,address,uint24)view returns(address)','function poolDeployer()view returns(address)',
  'function factory()view returns(address)','function token0()view returns(address)','function token1()view returns(address)','function fee()view returns(uint24)']);
const feedAbi=new Interface(['function decimals()view returns(uint8)','function description()view returns(string)',
  'function latestRoundData()view returns(uint80,int256,uint256,uint256,uint80)']);
function fixture(options:{quote?:string;fee?:number;chain?:string;badRegistry?:boolean;badDeployer?:boolean;badFactory?:boolean;badAsset?:boolean;badCode?:boolean;age?:number;targetTx?:number;swapTx?:number;badCanonical?:number;sqrt?:bigint;liquidity?:bigint;reversed?:boolean;removed?:boolean;dirty?:boolean;scrambled?:boolean}={}){
  const asset=options.quote??quote,fee=options.fee??2500,pool=freshHistoricalV3Pool(asset,settlement,fee),assets=[asset,settlement].sort();
  const anchor={number:1000,hash:h(1000),timestamp:new Date(Math.floor(Date.now()/1000)*1000).toISOString()},target={number:500,hash:h(500),timestamp:new Date(Date.parse(anchor.timestamp)-3600_000).toISOString()},age=options.age??1000;
  const source={number:age===0?500:499,hash:age===0?h(500):h(499),timestamp:new Date(Date.parse(target.timestamp)-age).toISOString()};
  const encoded=v3MarketAbi.encodeEventLog(v3MarketAbi.getEvent('Swap')!,['0x'+'1'.repeat(40),'0x'+'2'.repeat(40),1n,-1n,options.sqrt??2n*(1n<<96n),options.liquidity??100n,13863,0n,0n]);
  const log={address:pool,topics:encoded.topics,data:options.dirty?encoded.data+'00':encoded.data,blockNumber:'0x'+source.number.toString(16),blockHash:source.hash,
    transactionHash:h(1),transactionIndex:'0x'+(options.swapTx??1).toString(16),logIndex:'0x1',...(options.removed?{removed:true}:{})};
  const rpc=vi.fn(async(method:string,args:any[])=>{
    if(method==='eth_chainId')return options.chain??'0x38';
    if(method==='eth_getCode'){expect(args[1]).toEqual({blockHash:anchor.hash,requireCanonical:true});return args[0]===pool?(options.badCode?'0x60':'0x'+'60'.repeat(1025)):'0x6000';}
    if(method==='eth_getLogs'){expect(args[0].address).toBe(pool);return options.reversed?[log,{...log,logIndex:'0x0'}]:[log];}
    if(method==='eth_getBlockByNumber')return{number:'0x'+source.number.toString(16),hash:source.hash,timestamp:'0x'+(Date.parse(source.timestamp)/1000).toString(16)};
    expect(method).toBe('eth_call');expect(args[1]).toEqual({blockHash:anchor.hash,requireCanonical:true});
    const call=abi.parseTransaction(args[0])!,name=call.name;
    if(options.scrambled)await new Promise(resolve=>setTimeout(resolve,name==='getPool'?6:name==='factory'?3:0));
    if(name==='getPool')return abi.encodeFunctionResult(name,[options.badRegistry?asset:pool]);
    if(name==='poolDeployer')return abi.encodeFunctionResult(name,[options.badDeployer?asset:FRESH_PCS_V3_DEPLOYER]);
    if(name==='factory')return abi.encodeFunctionResult(name,[options.badFactory?asset:PCS_V3_FACTORY]);
    if(name==='token0'||name==='token1')return abi.encodeFunctionResult(name,[options.badAsset?asset:assets[name==='token0'?0:1]]);
    if(name==='fee')return abi.encodeFunctionResult(name,[fee]);throw Error('unexpected_current_price_or_precision_read');
  }) as unknown as Rpc&ReturnType<typeof vi.fn>;
  return{rpc,quoteAddress:asset,settlementAddress:settlement,fee,target,anchor,transactionIndex:options.targetTx??2,canonicalHash:async(n:number)=>n===options.badCanonical?h(999):h(n),source,pool};
}
describe('canonical pre-execution PCS V3 quote evidence',()=>{
  it('derives the two real customquote pools from the pinned official CREATE2 initcode',()=>{
    expect(freshHistoricalV3Pool('0x9b8e987e6fec8cf1380c4dca7071e2c7853aeea1',settlement,2500)).toBe('0x8768c8969e177575e37435b8295afa2dfb231c86');
    expect(freshHistoricalV3Pool('0x4902c5ebc598265ed2212b559b042de8a5eeec3f',settlement,500)).toBe('0xb754f10cebf50b8862444cf4d6c1cc31a3b71c18');
  });
  it.each([quote,'0x'+'1'.repeat(40)])('retains exact historical raw ratios in either direction %s',async asset=>{
    const f=fixture({quote:asset}),p=await recoverFreshHistoricalV3Quote(f),is0=asset<settlement;
    expect(BigInt(p.ratio.numerator)*(is0?1n:4n)).toBe(BigInt(p.ratio.denominator)*(is0?4n:1n));
    expect(p).toMatchObject({observation:'before_execution',source:f.source,target:f.target,identity:{pool:f.pool,factory:PCS_V3_FACTORY},calls:expect.any(Array)});
    expect(p.calls).toHaveLength(6);expect(f.rpc.mock.calls.filter(([method])=>method==='eth_call').every(([,args])=>!['0x3850c7bd','0x313ce567'].includes((args as any[])[0].data))).toBe(true);
  });
  it('revalidates complete retained proof offline and rejects missing/tampered reads',async()=>{
    const f=fixture({scrambled:true}),prior=await recoverFreshHistoricalV3Quote(f),none=vi.fn(async()=>{throw Error('must_not_read');}) as unknown as Rpc;
    expect(await recoverFreshHistoricalV3Quote({...f,rpc:none,prior})).toEqual(prior);
    expect(none).not.toHaveBeenCalled();
    for(const patch of [{ratio:{numerator:'1',denominator:'1'}},{calls:prior.calls.slice(1)},{codes:prior.codes.slice(1)},{target:{...prior.target,hash:h(7)}},{identity:{...prior.identity,pool:quote}}]){
      await expect(recoverFreshHistoricalV3Quote({...f,rpc:none,prior:{...prior,...patch} as any})).rejects.toThrow();
    }
    expect(none).not.toHaveBeenCalled();
  });
  it.each([{chain:'0x1'},{badRegistry:true},{badDeployer:true},{badFactory:true},{badAsset:true},{badCode:true},{age:120001},{sqrt:0n},{liquidity:0n},{reversed:true},{removed:true},{dirty:true},{badCanonical:499},{badCanonical:500},{badCanonical:1000}])('rejects incomplete, stale, orphaned or counterfeit proof',async options=>{
    await expect(recoverFreshHistoricalV3Quote(fixture(options))).rejects.toThrow();
  });
  it('accepts genuinely earlier same-block execution, never the target or a later execution',async()=>{
    await expect(recoverFreshHistoricalV3Quote(fixture({age:0,swapTx:1,targetTx:2}))).resolves.toMatchObject({source:{number:500}});
    await expect(recoverFreshHistoricalV3Quote(fixture({age:0,swapTx:2,targetTx:2}))).rejects.toThrow('historical_v3_preceding_swap_unavailable');
    await expect(recoverFreshHistoricalV3Quote(fixture({age:0,swapTx:3,targetTx:2}))).rejects.toThrow('historical_v3_preceding_swap_unavailable');
  });
  it('requires genuine historical settlement precision and its dated non-peg oracle',async()=>{
    const f=fixture({quote:'0x'+'1'.repeat(40)}),conversion=await recoverFreshHistoricalV3Quote(f),stamp=Date.parse(f.target.timestamp)/1000,id=(1n<<64n)|1n;
    const rpc=(async(_method:string,args:any[])=>{const name=feedAbi.parseTransaction(args[0])!.name;
      return feedAbi.encodeFunctionResult(name,name==='decimals'?[8]:name==='description'?['USDT / USD']:[id,99_900_000,stamp-1,stamp-1,id]);}) as Rpc;
    const feed=await recoverFreshHistoricalQuote({rpc,tokenAddress:settlement,target:f.target,anchor:f.anchor});
    const precision={version:1 as const,blockNumber:f.target.number,blockHash:f.target.hash,calls:[{to:settlement,data:'0x313ce567',result:'0x'+(6).toString(16).padStart(64,'0')}]};
    expect(await valueFreshHistoricalV3QuoteRaw('10000',conversion,precision,feed)).toMatchObject({amountUsd:'0.03996',settlementDecimals:6,settlementPriceUsd:'0.999'});
    await expect(valueFreshHistoricalV3QuoteRaw('10000',conversion,{...precision,blockHash:h(777)},feed)).rejects.toThrow();
    await expect(valueFreshHistoricalV3QuoteRaw('10000',conversion,{...precision,calls:[]},feed)).rejects.toThrow('historical_v3_retained_precision_missing');
    await expect(valueFreshHistoricalV3QuoteRaw('10000',conversion,precision,{...feed,priceUsd:'1'})).rejects.toThrow('historical_oracle_prior_invalid');
  });
});
