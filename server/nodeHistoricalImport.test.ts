import { describe, expect, it } from 'vitest';
import fixture from './fixtures/node-import-127-movements.json' with { type: 'json' };
import roundingFixture from './fixtures/node-import-quantity-rounding.json' with { type: 'json' };
import { historicalImportRetry, importedCanonicalQuantity, importedQuantityMatches, importedQuantitySumMatches, normalizeImportedChart, normalizeImportedMovements,normalizeImportedWalletDiscovery, validateImportedAggregate } from './nodeHistoricalImport.js';
import { MarketProviderDeferred } from './geckoApi.js';
import { GmgnHttpError } from './gmgnApi.js';
import type { JournalLedgerEvent } from './nodeAccountingLedger.js';
import type { KolTokenBalanceProof } from '../shared/kolTokenTrades.js';
const wallet='0x1111111111111111111111111111111111111111',token='0x2222222222222222222222222222222222222222',hash=`0x${'a'.repeat(64)}`;
const time=Date.parse('2026-10-18T10:00:00Z'),row={wallet,chain:'bsc',token:{address:token},tx_hash:hash,event_type:'buy',token_amount:'10',cost_usd:'100',gas_usd:'1',dex_usd:'0',priority_fee:'0',tip_fee:'0',timestamp:time/1000};
const movement=(kind:JournalLedgerEvent['kind'],tokenAmount:string,amountUsd:string,index:number):JournalLedgerEvent=>({id:`movement-${index}`,walletAddress:wallet,tokenAddress:token,txHash:`0x${String(index).repeat(64)}`,kind,tokenAmount,amountUsd,feeUsd:'0',timestamp:new Date(time+index*1000).toISOString()});
const events=[movement('buy','10','100',1),movement('sell','5','80',2),movement('transfer_in','2','20',3),movement('transfer_out','1','16',4)];
const proof:KolTokenBalanceProof={walletAddress:wallet,tokenAddress:token,chain:'bsc',blockNumber:'200',blockHash:hash,balance:'6',blockTimestamp:new Date(time+5000).toISOString(),checkedAt:new Date(time+5000).toISOString()};
const aggregate={address:wallet,balance:'6',total_cost:'122',profit:'34',profit_change:String(34/122),history_bought_cost:'100',history_bought_fee:'1',history_sold_income:'80',history_sold_fee:'1',history_transfer_in_cost:'20',history_transfer_out_income:'16',history_transfer_out_fee:'0',cost_cur:'72',usd_value:'60',realized_profit:'46',unrealized_profit:'-12',buy_amount_cur:'10',sell_amount_cur:'5',history_transfer_in_amount:'2',history_transfer_out_amount:'1',buy_tx_count_cur:1,sell_tx_count_cur:1,transfer_in_count:1,transfer_out_count:1,last_block:150,last_active_timestamp:(time+4000)/1000};

describe('historical import provider retry scheduling',()=>{
  it('retains the shared queue busy delay instead of turning it into exponential failure',()=>{
    expect(historicalImportRetry(new MarketProviderDeferred('busy',1500),8)).toEqual({reason:'import_provider_busy',retryAfterMs:1500});
  });
  it('honors provider cooldown and authentication retry durations',()=>{
    expect(historicalImportRetry(new MarketProviderDeferred('rate_limited',123456),1)).toEqual({reason:'import_provider_cooldown',retryAfterMs:123456});
    expect(historicalImportRetry(new GmgnHttpError(403,300000),1)).toEqual({reason:'import_provider_auth_blocked',retryAfterMs:300000});
  });
  it('does not count completed stages and metadata waits as repeated upstream timeouts',()=>{
    expect(historicalImportRetry(new DOMException('Request timed out','TimeoutError'),100)).toEqual({reason:'import_provider_timeout',retryAfterMs:15000});
  });
  it('keeps explicit evidence errors and bounds unclassified failures without exposing their messages',()=>{
    expect(historicalImportRetry(new Error('import_decimals_unavailable'),2)).toEqual({reason:'import_decimals_unavailable',retryAfterMs:20000});
    expect(historicalImportRetry(new Error('private upstream response'),100)).toEqual({reason:'import_unavailable',retryAfterMs:320000});
  });
});

describe('historical movement import',()=>{
  it('reconciles pending legacy quantities from authenticated exact raw executions',()=>{
    expect(importedCanonicalQuantity([{token_amount:null}], [{id:'operation-a',delta_raw:'2184343666229086349540724'}],18)).toBe('2184343.666229086349540724');
    expect(importedCanonicalQuantity([{token_amount:null,execution_id:'a'},{token_amount:null,execution_id:'b'}],
      [{id:'a',delta_raw:'-1234567'},{id:'b',delta_raw:'-10'},{id:'a',delta_raw:'-1234567'}],6)).toBe('1.234577');
    expect(importedCanonicalQuantity([{token_amount:'12.345'}],[],18)).toBe('12.345');
  });
  it('keeps absent, conflicting or mixed-side raw overlap evidence unavailable',()=>{
    expect(()=>importedCanonicalQuantity([{token_amount:null}],[],18)).toThrow('import_overlap_quantity_unavailable');
    expect(()=>importedCanonicalQuantity([{token_amount:null,execution_id:'missing'}],[{id:'a',delta_raw:'2'}],18)).toThrow('import_overlap_quantity_unavailable');
    expect(()=>importedCanonicalQuantity([{token_amount:null}],[{id:'a',delta_raw:'2'},{id:'a',delta_raw:'3'}],18)).toThrow('import_overlap_quantity_unavailable');
    expect(()=>importedCanonicalQuantity([{token_amount:null}],[{id:'a',delta_raw:'2'},{id:'b',delta_raw:'-1'}],18)).toThrow('import_overlap_quantity_unavailable');
  });
  it('keeps every historical movement provider-only without inventing block positions',()=>{
    const imported=normalizeImportedMovements([row],wallet,token,time+1000)[0].event;
    expect(imported).toMatchObject({kind:'buy',amountUsd:'100',feeUsd:'1',blockNumber:null,transactionIndex:null,logIndex:null});
  });
  it('never adds an unproven embedded dex fee to swap cash flow twice',()=>{
    expect(normalizeImportedMovements([{...row,dex_usd:'2'}],wallet,token,time+1000)[0].event.feeUsd).toBeNull();
    expect(normalizeImportedMovements([{...row,dex_usd:undefined}],wallet,token,time+1000)[0].event.feeUsd).toBeNull();
  });
  it('deduplicates a shared transaction fee identity and never assigns sender gas to an incoming recipient',()=>{
    const imported=normalizeImportedMovements([row,{...row,event_type:'sell'}],wallet,token,time+1000);
    expect(imported[0].event.feeId).toBe(imported[1].event.feeId);
    expect(normalizeImportedMovements([{...row,event_type:'transferIn'}],wallet,token,time+1000)[0].event.feeUsd).toBeNull();
    expect(normalizeImportedMovements([{...row,priority_fee:'0.01'}],wallet,token,time+1000)[0].event.feeUsd).toBeNull();
  });
  it('rejects identity switching, malformed rows, future rows and ambiguous same-kind executions',()=>{
    expect(()=>normalizeImportedMovements([{...row,wallet:token}],wallet,token,time+1000)).toThrow('import_movement_invalid');
    expect(()=>normalizeImportedMovements([{...row,token:{address:wallet}}],wallet,token,time+1000)).toThrow('import_movement_invalid');
    expect(()=>normalizeImportedMovements([null],wallet,token,time+1000)).toThrow('import_movement_invalid');
    expect(()=>normalizeImportedMovements([{...row,timestamp:time/1000+2}],wallet,token,time+1000)).toThrow('import_movement_invalid');
    expect(()=>normalizeImportedMovements([row,row],wallet,token,time+1000)).toThrow('import_execution_identity_ambiguous');
  });
  it('preserves all 127 sanitized April–October events, transfers and atomic same-second group',()=>{
    const rows=fixture.rows,imported=[];
    for(let index=0;index<rows.length;index+=50)imported.push(...normalizeImportedMovements(rows.slice(index,index+50),fixture.wallet,fixture.token,Date.parse('2026-10-18T12:00:00Z')));
    expect(imported).toHaveLength(127);expect(new Set(imported.map(row=>row.event.kind))).toEqual(new Set(['buy','sell','transfer_in','transfer_out']));
    expect(imported.every(row=>row.event.blockNumber===null&&row.event.transactionIndex===null&&row.event.logIndex===null)).toBe(true);
    const ordered=imported.map(row=>row.event.timestamp).sort();expect(ordered[0].startsWith('2026-04-15')).toBe(true);expect(ordered.at(-1)!.startsWith('2026-10-16')).toBe(true);
    expect(new Set(ordered).size).toBeLessThan(ordered.length);
    expect(imported.every((row,index)=>row.event.tokenAmount===String(rows[index].token_amount))).toBe(true);
  });
});

describe('source-appropriate import rounding',()=>{
  it('retains explicit source representation in the persisted sanitized rounding fixture',()=>{
    expect(roundingFixture.quantityRepresentation).toBe('gmgn_float_display');
    for(const row of roundingFixture.cases)expect(importedQuantityMatches(row.rawQuantity,row.canonicalQuantity,roundingFixture.decimals,'gmgn_float_display')).toBe(row.matches);
  });
  it('includes the binary serialization bound only for genuine JSON numeric quantities',()=>{
    expect(importedQuantityMatches(72324262.84865604,'72324262.848656050073215941',18)).toBe(true);
    expect(importedQuantityMatches('72324262.84865604','72324262.848656050073215941',18)).toBe(false);
    expect(importedQuantityMatches('72324262.84865604','72324262.848656050073215941',18,'gmgn_float_display')).toBe(true);
    expect(importedQuantityMatches('842131.9065757474','842131.906575747474492866',18,'gmgn_float_display')).toBe(true);
    expect(importedQuantityMatches('72324262.848656050073215940','72324262.848656050073215941',18,'gmgn_float_display')).toBe(false);
    expect(importedQuantityMatches(72324262.84865604,'72324262.8486561',18)).toBe(false);
  });
  it('propagates only unmatched provider movement precision into a reconciled ending quantity',()=>{
    const provider='2419116.767001469009433855',canonical='2419116.767001468956132006';
    expect(importedQuantitySumMatches(provider,canonical,18,[1000000.123456789])).toBe(true);
    expect(importedQuantitySumMatches(provider,canonical,18,[])).toBe(false);
    expect(importedQuantitySumMatches(provider,'2419116.8',18,[1000000.123456789])).toBe(false);
    expect(importedQuantitySumMatches('0','0.000000000000000001',18,[1000000.123456789])).toBe(false);
  });
  it('uses token precision and a bounded relative cap, not half a whole token',()=>{
    expect(importedQuantityMatches('100','100.4',18)).toBe(false);
    expect(importedQuantityMatches('100.123456789012','100.1234567890123',18)).toBe(true);
    expect(importedQuantityMatches('100.123456789012','100.12345678902',18)).toBe(false);
  });
  it('understands scientific precision and never turns a nonzero quantity into zero',()=>{
    expect(importedQuantityMatches('1e-18','0.000000000000000001',18)).toBe(true);
    expect(importedQuantityMatches('0','0.000000000000000001',18)).toBe(false);
    expect(importedQuantityMatches('1','1',37)).toBe(false);
  });
});

describe('public wallet onboarding discovery',()=>{
  it('discovers unknown eligible tokens while keeping current quote, LP and reward exclusions',()=>{
    const reward='0x7130d2a12b9bcbfae4f2634d864a1ee1ce3ead9c';
    expect(normalizeImportedWalletDiscovery([row,{...row,token:{address:reward}},{...row,token:{address:hash.slice(0,42),symbol:'USDT'}}],wallet,time+1000)).toEqual([{address:token,symbol:null,name:null}]);
  });
  it('rejects a different wallet, chain or future activity before queuing token work',()=>{
    expect(()=>normalizeImportedWalletDiscovery([{...row,wallet:token}],wallet,time+1000)).toThrow('import_discovery_movement_invalid');
    expect(()=>normalizeImportedWalletDiscovery([{...row,chain:'sol'}],wallet,time+1000)).toThrow('import_discovery_movement_invalid');
    expect(()=>normalizeImportedWalletDiscovery([{...row,timestamp:time/1000+2}],wallet,time+1000)).toThrow('import_discovery_movement_invalid');
  });
});

describe('independently validated aggregate ending',()=>{
  it('checks cash flow, all movement counts/quantities, balance and last block',()=>{
    expect(validateImportedAggregate(aggregate,events,proof,18,'150')).toMatchObject({totalFees:'2',capital:'121',basis:'72',realized:'46'});
    expect(()=>validateImportedAggregate({...aggregate,balance:'7'},events,proof,18)).toThrow('import_aggregate_quantity_mismatch');
    expect(()=>validateImportedAggregate({...aggregate,buy_tx_count_cur:2},events,proof,18)).toThrow('import_aggregate_history_mismatch');
    expect(()=>validateImportedAggregate({...aggregate,last_block:201},events,proof,18)).toThrow('import_aggregate_inconsistent');
    expect(()=>validateImportedAggregate({...aggregate,total_cost:'100'},events,proof,18)).toThrow('import_aggregate_inconsistent');
  });
  it('never mutates historical unknown fees or allocates aggregate residuals to rows',()=>{
    const unknown=events.map(row=>({...row,feeUsd:null})),before=JSON.stringify(unknown);
    expect(validateImportedAggregate(aggregate,unknown,proof,18).totalFees).toBe('2');expect(JSON.stringify(unknown)).toBe(before);
  });
  it('rejects internally inconsistent profits, ROI, purchase values and transfer amounts',()=>{
    for(const patch of [{profit:'99'},{profit_change:'2'},{realized_profit:'99'}])expect(()=>validateImportedAggregate({...aggregate,...patch},events,proof,18)).toThrow('import_aggregate_inconsistent');
    expect(()=>validateImportedAggregate({...aggregate,history_bought_cost:'99'},events,proof,18)).toThrow('import_aggregate_cost_mismatch');
    expect(()=>validateImportedAggregate({...aggregate,history_transfer_out_amount:'2'},events,proof,18)).toThrow('import_aggregate_history_mismatch');
  });
});

describe('genuine historical candle import',()=>{
  const first=Date.parse('2026-04-15T00:00:00Z'),last=first+60000;
  const candle=(time:number)=>({time,open:'1',high:'3',low:'0.5',close:'2',volume:'10'});
  it('supports GMGN data arrays, named lists and raw array candles',()=>{
    for(const response of [{data:[candle(first),candle(last)]},{data:{list:[candle(first),candle(last)]}},{data:{candles:[[first,1,3,0.5,2,10],[last,1,3,0.5,2,10]]}}]){
      const result=normalizeImportedChart(response,first,last,60,last+60000);expect(result.complete).toBe(true);expect(result.observations).toHaveLength(2);
    }
  });
  it('keeps sparse real timestamps and reports missing early coverage',()=>{
    const result=normalizeImportedChart({data:[candle(last)]},first,last,60,last+60000);expect(result.complete).toBe(false);expect(result.coverageFrom).toBe(last);
    const empty=normalizeImportedChart({data:[]},first,last,60,last+60000);expect(empty.complete).toBe(false);expect(empty.coverageFrom).toBeNull();
  });
  it('separates an explicitly exhausted sparse query from observed price coverage',()=>{
    const response={data:[candle(last)]};
    const legacy=normalizeImportedChart(response,first,last,60,last+60000);
    const exhausted=normalizeImportedChart(response,first,last,60,last+60000,{requestLimit:1000});
    expect(legacy.retrievalComplete).toBe(false);expect(exhausted.retrievalComplete).toBe(true);
    expect(exhausted.complete).toBe(false);expect(exhausted.coverageFrom).toBe(last);
    expect(exhausted.observations).toHaveLength(1);
    const empty=normalizeImportedChart({data:[]},first,last,60,last+60000,{requestLimit:1000});
    expect(empty.retrievalComplete).toBe(true);expect(empty.coverageFrom).toBeNull();expect(empty.observations).toEqual([]);
  });
  it('does not infer exhausted retrieval from a full page or an unfinished boundary',()=>{
    const full=Array.from({length:1000},(_,index)=>candle(first+index*60000));
    expect(normalizeImportedChart({data:full},first,first+999*60000,60,first+1000*60000,{requestLimit:1000}).retrievalComplete).toBe(false);
    expect(normalizeImportedChart({data:[candle(first)]},first,last,60,last+30000,{requestLimit:1000}).retrievalComplete).toBe(false);
  });
  it('drops a forming close rather than inventing a quote timestamp',()=>{
    const result=normalizeImportedChart({data:[candle(first),candle(last)]},first,last,60,last+30000);expect(result.observations).toHaveLength(1);
  });
  it('rejects malformed OHLC, out-of-window timestamps and conflicting duplicate bars',()=>{
    expect(()=>normalizeImportedChart({data:[{...candle(first),high:'1'}]},first,last,60,last+60000)).toThrow('import_chart_candle_invalid');
    expect(()=>normalizeImportedChart({data:[candle(first-60000)]},first,last,60,last+60000)).toThrow('import_chart_timestamp_invalid');
    expect(()=>normalizeImportedChart({data:[candle(first),{...candle(first),close:'1'}]},first,last,60,last+60000)).toThrow('import_chart_conflict');
  });
});
