import { describe, expect, it, vi } from 'vitest';
import { AbiCoder, keccak256 } from 'ethers';
import { aggregateNodeMarketBars, nodeMarketCoverageComplete, readNodeMarketChart, readNodeMarketQuote } from './nodeMarket.js';
import { MarketDecimal, ratioPrice, sqrtPrice } from './nodeMarketMath.js';
import { authenticatedPoolKey, binPrice, decodeNodeMarketLog,
  flapMarketAbi, fourMarketAbi,indexNodeControllerLogs, INFINITY_BIN, INFINITY_CL, infinityMarketAbi, poolMarketAbi, v3MarketAbi,TRUSTED_QUOTE_FEEDS, type NodeMarketIdentity } from './nodeMarketProtocols.js';
import { FLAP_PORTAL, FOUR_MANAGERS, PCS_V2_FACTORY, PCS_V3_FACTORY, WBNB } from './launchpad.js';
import type { NodeMarketBar } from '../shared/nodeMarket.js';
const token='0x1111111111111111111111111111111111111111',pool='0x2222222222222222222222222222222222222222',trader='0x3333333333333333333333333333333333333333';
const market:NodeMarketIdentity={id:`${pool}:${token}`,token,quote:WBNB,protocol:'pcs_v2',contract:pool,poolId:null,token0:token,token1:WBNB,decimals0:18,decimals1:18,authentication:{factory:PCS_V2_FACTORY}};
const event=(abi:typeof poolMarketAbi,name:string,args:unknown[],contract=pool)=>({address:contract,...abi.encodeEventLog(abi.getEvent(name)!,args)});
const bar=(timestamp:string,close:string,source:'node'|'imported'='node'):NodeMarketBar=>({timestamp,open:close,high:close,low:close,close,volumeUsd:'10',source,intervalSeconds:60,supply:'1000000',supplyEstimated:false});

describe('exact node market arithmetic',()=>{
  it('preserves very small prices and high precision quantities',()=>{
    expect(ratioPrice(1n,10n**36n,6,18)).toBe('0.000000000000000000000001');
    expect(MarketDecimal.parse('0.000000000000000000000001').mul(MarketDecimal.parse('1000000000000000000000000')).text()).toBe('1');
    expect(MarketDecimal.parse('-0.001').text()).toBe('-0.001');
  });
  it('scales V3 prices by verified precision and inverts token orientation',()=>{
    expect(sqrtPrice(1n<<96n,true,18,6)).toBe('1000000000000');
    expect(sqrtPrice(1n<<96n,false,18,6)).toBe('0.000000000001');
    expect(sqrtPrice(0n,true,18,18)).toBeNull();
  });
  it('derives Infinity Bin price from authentic parameter bits without floats',()=>{
    const parameters=`0x${(10n<<16n).toString(16).padStart(64,'0')}`;
    expect(binPrice(8_388_608,parameters,true,18,18)).toBe('1');
    expect(binPrice(8_388_609,parameters,true,18,18)?.slice(0,5)).toBe('1.001');
    expect(binPrice(1,'0x00',true,18,18)).toBeNull();
    expect(INFINITY_BIN).toMatch(/^0x[0-9a-f]{40}$/);
  });
});

describe('authenticated genuine market decoding',()=>{
  it('indexes a shared controller once while retaining unknown token events',()=>{
    const tokens=Array.from({length:700},(_,index)=>`0x${(100000+index).toString(16).padStart(40,'0')}`);
    const logs=Array.from({length:2354},(_,index)=>index%7===0?{address:FLAP_PORTAL,topics:[`0x${'f'.repeat(64)}`],
      data:`0x${tokens[index%700].slice(2).padStart(64,'0')}${tokens[index%700].slice(2).padStart(64,'0')}`}
      :event(flapMarketAbi,'TokenBought',[1,tokens[index%700],trader,10n**18n,10n**12n,0,10n**12n],FLAP_PORTAL));
    const indexed=indexNodeControllerLogs(tokens,logs);
    expect([...indexed.values()].reduce((total,rows)=>total+rows.length,0)).toBe(2354);
    expect(indexed.get(tokens[0])?.[0]).toBe(logs[0]);
    expect(indexNodeControllerLogs(tokens,[{topics:[`0x${'f'.repeat(64)}`,`0x${tokens[0].slice(2).padStart(64,'0')}`],data:'0x'}]).get(tokens[0])).toHaveLength(1);
  });
  it('decodes any participant swap without a watched wallet or tracked fill',()=>{
    const log=event(poolMarketAbi,'Swap',[trader,0,2n*10n**18n,1000n*10n**18n,0,trader]);
    expect(decodeNodeMarketLog(market,log)).toEqual({priceQuote:'0.002',tokenAmountRaw:String(1000n*10n**18n),quoteAmountRaw:String(2n*10n**18n),swap:true});
  });
  it('does not accept a spoofed factory, address, removed log or ambiguous flash legs',()=>{
    const log=event(poolMarketAbi,'Swap',[trader,0,2n,1000n,0,trader]);
    expect(decodeNodeMarketLog({...market,authentication:{factory:trader}},log)).toBeNull();
    expect(decodeNodeMarketLog(market,{...log,address:trader})).toBeNull();
    expect(decodeNodeMarketLog(market,{...log,removed:true})).toBeNull();
    expect(decodeNodeMarketLog(market,event(poolMarketAbi,'Swap',[trader,1,2,3,4,trader]))).toBeNull();
  });
  it('recognizes genuine reserve observations without inventing volume',()=>{
    expect(decodeNodeMarketLog(market,event(poolMarketAbi,'Sync',[1000n*10n**18n,2n*10n**18n]))).toEqual({priceQuote:'0.002',tokenAmountRaw:'0',quoteAmountRaw:'0',swap:false});
  });
  it('decodes V3 sqrt price and actual raw swap amounts',()=>{
    const log=event(v3MarketAbi,'Swap',[trader,trader,-10n,10n,1n<<96n,100n,0,1n,2n]);
    expect(log.topics[0]).toBe('0x19b47279256b2a23a1665c810c8d55a1758940ee09377d4f8d26497a3577dc83');
    expect(decodeNodeMarketLog({...market,protocol:'pcs_v3',authentication:{factory:PCS_V3_FACTORY}},log)).toMatchObject({priceQuote:'1',swap:true});
    expect(decodeNodeMarketLog({...market,protocol:'pcs_v3',authentication:{factory:PCS_V3_FACTORY}},event(v3MarketAbi,'Swap',[trader,trader,10n,10n,1n<<96n,100n,0,0,0]))).toBeNull();
  });
  it.each(FOUR_MANAGERS)('accepts Four.meme events only from authenticated controller %s',controller=>{
    const log=event(fourMarketAbi,'TokenPurchase',[token,trader,1000000000000n,10n**18n,1000000000000n,1n,1n,1n],controller);
    const identity={...market,protocol:'fourmeme' as const,contract:controller,authentication:{controller,version:'2'}};
    expect(decodeNodeMarketLog(identity,log)).toMatchObject({priceQuote:'0.000001',swap:true});
    expect(decodeNodeMarketLog({...identity,decimals0:9},log)).toBeNull();
    expect(decodeNodeMarketLog(identity,{...log,address:trader})).toBeNull();
  });
  it('accepts documented Flap versions and rejects another token in shared Portal',()=>{
    const identity={...market,protocol:'flap' as const,contract:FLAP_PORTAL,authentication:{controller:FLAP_PORTAL,method:'getTokenV8Safe'}};
    const log=event(flapMarketAbi,'TokenSold',[1700000000,token,trader,10n**18n,10n**12n,0,10n**12n],FLAP_PORTAL);
    expect(decodeNodeMarketLog(identity,log)).toMatchObject({priceQuote:'0.000001',swap:true});
    expect(decodeNodeMarketLog({...identity,token:trader},log)).toBeNull();
  });
  it('authenticates Infinity by the complete PoolKey hash, never the vault address',()=>{
    const key=[token,WBNB,'0x0000000000000000000000000000000000000000',INFINITY_CL,2500,`0x${'0'.repeat(64)}`];
    const id=keccak256(AbiCoder.defaultAbiCoder().encode(['address','address','address','address','uint24','bytes32'],key));
    expect(authenticatedPoolKey(id,INFINITY_CL,key)).toBe(true);
    expect(authenticatedPoolKey(id,pool,key)).toBe(false);
    expect(authenticatedPoolKey(`0x${'f'.repeat(64)}`,INFINITY_CL,key)).toBe(false);
    const log=event(infinityMarketAbi,'Swap',[id,trader,-10n,10n,1n<<96n,100n,0,2500,0],INFINITY_CL);
    const identity={...market,protocol:'infinity_cl' as const,contract:INFINITY_CL,poolId:id,authentication:{poolKeyHash:id}};
    expect(decodeNodeMarketLog(identity,log)).toMatchObject({priceQuote:'1',swap:true});
    expect(decodeNodeMarketLog({...identity,poolId:`0x${'f'.repeat(64)}`},log)).toBeNull();
  });
});

describe('durable market chart boundaries',()=>{
  it('aggregates four-hour and daily observations while preserving genuine gaps',()=>{
    const rows=[bar('2026-04-15T00:00:00Z','1'),bar('2026-04-15T01:00:00Z','4'),bar('2026-10-16T00:00:00Z','2','imported')];
    const result=aggregateNodeMarketBars(rows,14400);
    expect(result).toHaveLength(2);expect(result[0]).toMatchObject({open:'1',high:'4',low:'1',close:'4',volumeUsd:'20',intervalSeconds:14400});
    expect(aggregateNodeMarketBars(rows,86400)).toHaveLength(2);
    expect(()=>aggregateNodeMarketBars(rows,10)).toThrow('invalid_chart_interval');
  });
  it('requires contiguous recorded coverage rather than first/last price alone',()=>{
    const from='2026-04-15T00:00:00Z',to='2026-10-16T00:00:00Z';
    expect(nodeMarketCoverageComplete(from,to,[{from,to}])).toBe(true);
    expect(nodeMarketCoverageComplete(from,to,[{from,to:'2026-04-16T00:00:00Z'},{from:'2026-10-15T00:00:00Z',to}])).toBe(false);
  });
  it('retains original fine imported endpoints inside a sparse coarse bucket',()=>{
    const result=aggregateNodeMarketBars([bar('2026-10-19T12:28:00Z','2','imported')],300);
    expect(result[0]).toMatchObject({timestamp:'2026-10-19T12:25:00.000Z',firstObservationAt:'2026-10-19T12:28:00Z',
      lastObservationAt:'2026-10-19T12:29:00.000Z',intervalSeconds:300});
  });
  it('keeps original quote observation timestamp and stale state, with zero RPC',async()=>{
    const query=vi.fn().mockResolvedValue({rows:[{price_usd:'2',timestamp:'2026-10-18T10:00:00Z',block_number:'100',block_hash:`0x${'a'.repeat(64)}`,source:'node',market_id:market.id,supply:'1000',supply_estimated:false,status:'active'}]});
    const quote=await readNodeMarketQuote({query} as never,token,{now:Date.parse('2026-10-18T11:00:00Z')});
    expect(quote).toMatchObject({priceUsd:'2',marketCapUsd:'2000',timestamp:'2026-10-18T10:00:00.000Z',stale:true,reason:'stale_quote'});
    expect(query).toHaveBeenCalledTimes(1);
  });
  it('values trusted quote assets from their block-bound feed before restored chart observations',async()=>{
    const timestamp='2026-10-20T07:19:32Z',query=vi.fn().mockResolvedValue({rows:[{price_usd:'729.54765955',timestamp,
      block_number:'128705010',block_hash:`0x${'a'.repeat(64)}`}]}),config=TRUSTED_QUOTE_FEEDS[WBNB];
    const quote=await readNodeMarketQuote({query} as never,WBNB,{timestamp,blockNumber:'128705010'});
    expect(quote).toMatchObject({priceUsd:'729.54765955',timestamp:'2026-10-20T07:19:32.000Z',blockNumber:'128705010',source:'node',stale:false});
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).toContain('node_market_feed_evidence');
    expect(query.mock.calls[0][1]).toEqual([WBNB,'2026-10-20T07:19:32.000Z','128705010',config.feed,config.description]);
  });
  it('cannot report full charts while raw valuation is pending',async()=>{
    const query=vi.fn().mockImplementation((sql:string)=>Promise.resolve({rows:sql.includes('WITH chosen')?[{minute:'2026-10-18T10:00:00Z',open:'1',high:'2',low:'1',close:'2',volume_usd:'20'}]
      :sql.includes("'node' AS source")?[{from_at:'2026-10-18T10:00:00Z',to_at:'2026-10-18T11:00:00Z',source:'node'}]
      :sql.includes('m.status,EXISTS')?[{status:'active',pending:true,uncovered_pending:true}]:[]}));
    const chart=await readNodeMarketChart({query} as never,token,{from:'2026-10-18T10:00:00Z',to:'2026-10-18T11:00:00Z'});
    expect(chart.complete).toBe(false);expect(chart.reason).toBe('incomplete_chart_coverage');expect(chart.bars).toHaveLength(1);
  });
});
