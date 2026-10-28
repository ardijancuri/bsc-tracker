import{describe,it,expect,vi}from'vitest';
import type{Pool}from'pg';
import{freshStoredKolRollingMetrics,rankFreshStoredLeaderboard}from'./leaderboard.js';
import{createFreshReads}from'./reads.js';
import{createFreshApp}from'./app.js';
import type{FreshServices}from'./services.js';
import{nodeLeaderboardEstimatedValue,nodeLeaderboardStatus,type NodeLeaderboardSnapshot}from'../../shared/nodeLeaderboard.js';

const at=Date.parse('2026-10-28T17:00:00Z'),asOf='2026-10-28T16:59:00.000Z',from='2026-10-27T17:00:00.000Z',to=new Date(at).toISOString(),wallet='0x'+'1'.repeat(40);
const row={wallet_address:wallet,address:wallet,display_name:'KOL',accounting_policy_ready:true,realized_estimate_policy_ready:true,estimate_capture_canonical:true,
 rolling_as_of:asOf,rolling_next_expiry_at:'2026-10-28T17:30:00Z',rolling_metrics_updated_at:asOf,
 rolling_realized_q:null,rolling_estimated_realized_q:'-51/2',rolling_known_realized_q:'999999',rolling_unknown_count:1,
 rolling_trade_count:3,rolling_buy_count:2,rolling_sell_count:1,rolling_valued_sell_count:0,rolling_unknown_sell_count:1,rolling_unknown_fee_count:0,rolling_fee_only_q:'0'};
const snapshot=(value='-25.5'):NodeLeaderboardSnapshot=>({version:1,policy:'kollens_fifo_v1',realizedPolicy:'sales_fifo_fees_v2',walletAddress:wallet,period:'24h',
 windowStart:from,windowEnd:to,asOf,snapshotId:'a'.repeat(64),source:'node',coveredThroughBlock:'100',coveredThroughHash:'0x'+'a'.repeat(64),
 complete:false,reasons:['unknown_costs'],realizedProfitUsd:null,estimatedRealizedProfitUsd:value,knownRealizedProfitUsd:'999999',valuedSellCount:0,excludedSellCount:1,
 valuedTransferOutCount:0,excludedTransferOutCount:0,estimate:{version:1,policy:'omit_unknown_costs_v1',basis:'recorded_facts',asOf,windowStart:from,windowEnd:to,reasons:['unknown_costs','unknown_inputs_omitted'],
 affectedSellCount:1,missingCostCount:null,missingProceedsCount:null,missingFeeCount:null,unvaluedFeeOnlyCount:0}});
const estimated=(address:string,value:string)=>({address,tradeCount24h:3,realizedProfitUsd:null,estimatedRealizedProfitUsd:value,pnlQuality:'estimated' as const,accounting:snapshot(value)});
const exact=(address:string,value:string)=>({address,tradeCount24h:2,realizedProfitUsd:value,pnlQuality:'exact' as const,accounting:{...snapshot(),complete:true,realizedProfitUsd:value,estimatedRealizedProfitUsd:null,estimate:null,reasons:[]}});

describe('explicit stored estimates for rolling leaderboard',()=>{
 it('keeps exact profit unknown while reading the distinct authorized stored estimate',()=>{
  expect(freshStoredKolRollingMetrics(row,at)).toMatchObject({complete:false,realizedProfitUsd:null,estimatedRealizedProfitUsd:'-25.5',knownRealizedProfitUsd:'999999',reasons:['unknown_costs','stored_total_unavailable']});
 });
 it.each([{realized_estimate_policy_ready:false},{realized_estimate_policy_ready:undefined},{accounting_policy_ready:false},{accounting_policy_ready:undefined},
  {estimate_capture_canonical:false},{estimate_capture_canonical:undefined},{rolling_as_of:null},{rolling_as_of:'2026-10-28T18:00:00Z'},
  {rolling_next_expiry_at:to},{rolling_estimated_realized_q:null},{rolling_estimated_realized_q:undefined},{rolling_estimated_realized_q:'NaN'},
  {rolling_metrics_updated_at:null},{rolling_metrics_updated_at:'2026-10-28T18:00:00Z'}])('fails closed on uninitialized stale invalid or wrong-policy estimates: %j',patch=>{
   expect(freshStoredKolRollingMetrics({...row,...patch},at).estimatedRealizedProfitUsd).toBeNull();
 });
 it('allows a fresh recorded estimate with explicit old-gap and decoding reasons',()=>{
  expect(freshStoredKolRollingMetrics({...row,decode_gap_from_block:'90',decoding_pending:true,token_discovery_pending:true},at)).toMatchObject({complete:false,realizedProfitUsd:null,estimatedRealizedProfitUsd:'-25.5',
   reasons:expect.arrayContaining(['wallet_decode_gap','decoding_pending','token_discovery_pending'])});
 });
 it('prefers exact completed values and never copies them to the estimated field',()=>{
  expect(freshStoredKolRollingMetrics({...row,rolling_unknown_count:0,rolling_realized_q:'0'},at)).toMatchObject({complete:true,realizedProfitUsd:'0',estimatedRealizedProfitUsd:null});
 });
 it('uses a complete recorded-fact total as estimated during decoding without copying or borrowing a subtotal',()=>{
  const r={...row,rolling_unknown_count:0,rolling_realized_q:'-7/2',rolling_estimated_realized_q:null,decoding_pending:true};
  expect(freshStoredKolRollingMetrics(r,at)).toMatchObject({complete:false,realizedProfitUsd:null,estimatedRealizedProfitUsd:'-3.5',reasons:['decoding_pending']});
  expect(freshStoredKolRollingMetrics({...r,rolling_realized_q:null},at).estimatedRealizedProfitUsd).toBeNull();
  expect(freshStoredKolRollingMetrics({...r,rolling_unknown_count:1},at).estimatedRealizedProfitUsd).toBeNull();
  expect(freshStoredKolRollingMetrics({...r,realized_estimate_policy_ready:false},at).estimatedRealizedProfitUsd).toBeNull();
 });
 it('ranks estimated profit break-even and losses alongside exact values using exact decimals',()=>{
  const legacy={address:'legacy',tradeCount24h:100,realizedProfitUsd:null,knownRealizedProfitUsd:'99999999',accounting:{complete:false,valuedSellCount:4,valuedTransferOutCount:0}};
  expect(rankFreshStoredLeaderboard([legacy,exact('loss','-30'),estimated('estimatedLoss','-25.5'),estimated('zero','0'),exact('profit','2'),estimated('estimatedProfit','3')])
   .map(x=>[x.address,x.rank])).toEqual([['estimatedProfit',1],['profit',2],['zero',3],['estimatedLoss',4],['loss',5],['legacy',null]]);
  expect(rankFreshStoredLeaderboard([estimated('a','9007199254740992.0000000000000000001'),estimated('b','9007199254740992.0000000000000000002')]).map(x=>x.address)).toEqual(['b','a']);
 });
 it('rejects a top-level amount inconsistent with its estimate contract',()=>{
  expect(rankFreshStoredLeaderboard([{...estimated('bad','3'),estimatedRealizedProfitUsd:'999'}])[0].rank).toBeNull();
  const bad=estimated('bad','3');bad.accounting.realizedProfitUsd='1';expect(rankFreshStoredLeaderboard([bad])[0].rank).toBeNull();
 });
 it('recognizes only valid dated explicit estimate snapshots',()=>{
  expect(nodeLeaderboardEstimatedValue(snapshot())).toBe('-25.5');expect(nodeLeaderboardStatus(snapshot())).toBe('estimated');
  for(const patch of[{version:2},{realizedPolicy:undefined},{period:undefined},{source:'imported'},{estimatedRealizedProfitUsd:'NaN'},{estimatedRealizedProfitUsd:'9'.repeat(513)},
   {complete:true},{realizedProfitUsd:'1'},{estimate:null},{estimate:{...snapshot().estimate!,policy:'wrong'}},{estimate:{...snapshot().estimate!,basis:undefined}},{estimate:{...snapshot().estimate!,asOf:to}},
   {estimate:{...snapshot().estimate!,affectedSellCount:-1}},{estimate:{...snapshot().estimate!,missingCostCount:undefined}}])expect(nodeLeaderboardEstimatedValue({...snapshot(),...patch}as any)).toBeNull();
 });
 it('returns identical estimated values and rank in profile and leaderboard with no history calculations or providers',async()=>{
  let currentRow={...row};
  const query=vi.fn(async(sql:string)=>{
   if(sql.startsWith('SELECT key,'))return{rows:[{key:'start',block_number:'1'},{key:'decode',block_number:'100',block_hash:'0x'+'a'.repeat(64)}]};
   if(sql.includes('FROM fresh.kols k JOIN fresh.wallets'))return{rows:[currentRow]};
   if(sql.startsWith('WITH wallet_traded_tokens AS MATERIALIZED')||sql.includes('FROM fresh.visible_trades e'))return{rows:[]};
   throw Error('Unexpected estimated leaderboard query');
  });
  const reads={...createFreshReads({query}as unknown as Pool,()=>at,true),summaries:vi.fn(async()=>({}))};
  const{app}=await createFreshApp({query}as unknown as Pool,{services:{reads,charts:{},replay:{},cache:{}}as unknown as FreshServices});
  try{
   const board=await app.inject('/api/leaderboard'),profile=await app.inject('/api/kols/'+wallet);
   expect(board.statusCode).toBe(200);expect(profile.statusCode).toBe(200);
   const item=board.json().items[0];expect(profile.json().stats).toEqual(item);
   expect(item).toMatchObject({rank:1,realizedProfitUsd:null,estimatedRealizedProfitUsd:'-25.5',rankingProfitUsd:'-25.5',pnlQuality:'estimated',
    accounting:{complete:false,realizedProfitUsd:null,estimatedRealizedProfitUsd:'-25.5',estimate:{policy:'omit_unknown_costs_v1',affectedSellCount:1,missingCostCount:null,missingFeeCount:null,missingProceedsCount:null}}});
   currentRow={...row,realized_estimate_policy_ready:false};const unpublished=(await reads.leaderboard()).items[0];
   expect(unpublished.estimatedRealizedProfitUsd).toBeNull();expect(unpublished.accounting.snapshotId).not.toBe(item.accounting.snapshotId);
   currentRow={...row,rolling_estimated_realized_q:'-53/2'};const changed=(await reads.leaderboard()).items[0];
   expect(changed.estimatedRealizedProfitUsd).toBe('-26.5');expect(changed.accounting.snapshotId).not.toBe(item.accounting.snapshotId);
   expect(query.mock.calls.every(([sql])=>!/\b(UPDATE|INSERT|DELETE|SUM)\b/i.test(sql))).toBe(true);
   expect(query.mock.calls.find(([sql])=>sql.includes('FROM fresh.kols k JOIN fresh.wallets'))?.[0]).toContain("key='accounting:realized_estimate_policy'");
  }finally{await app.close();}
 });
});
