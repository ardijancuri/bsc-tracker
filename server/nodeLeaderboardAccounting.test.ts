import { describe, expect, it } from 'vitest';
import { publicLeaderboardPeriodInput } from './nodeLeaderboardAccounting.js';
import { calculateJournalLedgerPeriod, type JournalLedgerEvent } from './nodeAccountingLedger.js';
import type { NodeAccountingEvidence } from './nodeAccounting.js';

const wallet=`0x${'a'.repeat(40)}`,token=`0x${'b'.repeat(40)}`,blockHash=`0x${'c'.repeat(64)}`;
const start='2026-10-18T18:00:00.000Z',end='2026-10-19T18:00:00.000Z';
const event=(id:string,kind:JournalLedgerEvent['kind'],at:string,amount:string,quantity:string,fee='0'):JournalLedgerEvent=>({
  id,walletAddress:wallet,tokenAddress:token,kind,timestamp:at,amountUsd:amount,tokenAmount:quantity,feeUsd:fee,txHash:id,
});
function pair(overrides:Partial<Parameters<typeof publicLeaderboardPeriodInput>[0]>={}){
  const payload:NodeAccountingEvidence={events:[event('old-buy','buy','2026-10-10T12:00:00.000Z','100','10','2'),
    event('sale','sell','2026-10-19T12:00:00.000Z','70','4','1')],historicalEvents:[],baselines:[],openingBalances:[],
    proof:{chain:'bsc',walletAddress:wallet,tokenAddress:token,blockNumber:'300',blockHash,blockTimestamp:end,balance:'6',checkedAt:end},
    coverage:{walletAddress:wallet,tokenAddress:token,complete:false,quantitiesComplete:true,reason:'quote_unavailable'},
    quote:null,source:'node',historyFingerprint:'fixture',fromBlock:'1',throughBlock:'300',monitoringGeneration:'2'};
  if(overrides.baseline_at)payload.historyBoundary='imported_baseline';
  return{wallet_address:wallet,token_address:token,latest_block:'250',latest_at:end,payload,history_revision:'fixture',canonical:true,
    baseline_at:null,baseline_ledger:null,generation:'2',registered_at:'2026-10-01T00:00:00Z',collected:'300',decoded:'300',repair:null,
    unresolved:false,...overrides};
}
function calculate(row:ReturnType<typeof pair>){
  const value=publicLeaderboardPeriodInput(row,start,end);
  return calculateJournalLedgerPeriod({wallets:[wallet],events:value.events,baselines:value.baselines,openingBalances:value.openingBalances,
    valuations:value.valuation?[value.valuation]:[],coverage:[{walletAddress:wallet,tokenAddress:token,complete:value.complete,reason:value.reasons[0]}],
    period:{from:start,to:end},asOf:end});
}
describe('public leaderboard full-history evidence adapter',()=>{
  it('uses full purchase history and allocated fees without requiring a current quote or lifetime completion',()=>{
    const value=calculate(pair());expect(value.complete).toBe(true);expect(value.totals.realizedProfitUsd).toBe('28.2');
  });
  it('checks confirmed holdings even though current market prices are irrelevant',()=>{
    const row=pair();row.payload!.proof!.balance='7';const value=calculate(row);
    expect(value.complete).toBe(false);expect(value.reasons).toContain('balance_unreconciled');
  });
  it('rejects a balance proof for another wallet, token, chain or checkpoint',()=>{
    for(const change of [{walletAddress:`0x${'d'.repeat(40)}`},{tokenAddress:`0x${'d'.repeat(40)}`},{chain:'eth'},{blockNumber:'299'},
      {blockTimestamp:'2026-10-19T19:00:00Z'}]){
      const row=pair();Object.assign(row.payload!.proof!,change);
      expect(publicLeaderboardPeriodInput(row,start,end).reasons).toContain('balance_unavailable');
    }
  });
  it('requires canonical complete quantities through the latest movement and matching monitoring generation',()=>{
    for(const row of [pair({canonical:false}),pair({latest_block:'301'}),pair({generation:'3'}),pair({unresolved:true})]){
      expect(publicLeaderboardPeriodInput(row,start,end).complete).toBe(false);
    }
  });
  it('retains a before-window baseline lot while excluding its lifetime realized gains',()=>{
    const row=pair({baseline_at:'2026-10-17T12:00:00Z'});row.payload!.events=row.payload!.events.slice(1);
    row.payload!.baselines=[{walletAddress:wallet,tokenAddress:token,investedUsd:'100',soldUsd:'900',realizedProfitUsd:'800',feesUsd:'2',
      incomingTransferCostUsd:'0',transferOutIncomeUsd:'0',feeInclusiveCapitalUsd:'102',lots:[{tokenAmount:'10',costBasisUsd:'102'}]}];
    expect(calculate(row).totals.realizedProfitUsd).toBe('28.2');
  });
  it('reconstructs an inside-window baseline from genuine historical movements, without distributing aggregate fee differences',()=>{
    const row=pair({baseline_at:'2026-10-19T14:00:00Z',baseline_ledger:{feesUsd:'3'}});
    row.payload!.historicalEvents=row.payload!.events;row.payload!.events=[];
    expect(calculate(row).totals.realizedProfitUsd).toBe('28.2');
    row.baseline_ledger.feesUsd='30';const invalid=publicLeaderboardPeriodInput(row,start,end);
    expect(invalid.complete).toBe(false);expect(invalid.reasons).toContain('historical_fee_allocation_unknown');
    expect(calculate(row).totals.knownRealizedProfitUsd).toBe('0');
  });
  it('does not silently omit inside-window historical movements or assume missing costs and fees are zero',()=>{
    const row=pair({baseline_at:'2026-10-19T14:00:00Z',baseline_ledger:{feesUsd:'3'}});
    expect(publicLeaderboardPeriodInput(row,start,end).reasons).toContain('historical_period_unavailable');
    row.payload!.historicalEvents=row.payload!.events;row.payload!.events=[];row.payload!.historicalEvents[0].feeUsd=null;
    expect(publicLeaderboardPeriodInput(row,start,end).reasons).toContain('historical_fee_allocation_unknown');
  });
  it('does not attach opaque fees from a proved closed old cycle to a later independent node cycle',()=>{
    const row=pair({baseline_at:'2026-10-19T10:00:00Z',baseline_ledger:{feesUsd:'500',lots:[]}});
    row.payload!.historicalEvents=[event('old-buy','buy','2026-10-10T12:00:00Z','100','10','2'),
      event('old-close','sell','2026-10-17T12:00:00Z','150','10','3')];
    row.payload!.events=[event('new-buy','buy','2026-10-19T11:00:00Z','100','10','2'),event('new-sale','sell','2026-10-19T12:00:00Z','70','4','1')];
    expect(calculate(row).totals.realizedProfitUsd).toBe('28.2');
    row.payload!.historicalEvents[1].timestamp='2026-10-18T19:00:00Z';
    expect(publicLeaderboardPeriodInput(row,start,end).reasons).toContain('historical_fee_allocation_unknown');
  });
  it('never includes movements after the frozen confirmed checkpoint',()=>{
    const row=pair({approved_block:'249',approved_at:'2026-10-19T11:59:59Z'});
    const value=publicLeaderboardPeriodInput(row,start,end);
    expect(value.events.map(event=>event.id)).toEqual(['old-buy']);expect(value.complete).toBe(false);
    expect(value.reasons).toContain('accounting_pending');expect(value.reasons).toContain('balance_unavailable');
  });
  it('does not let an unused retained provider baseline override complete native evidence',()=>{
    const row=pair({baseline_at:'2026-10-19T14:00:00Z',baseline_ledger:{feesUsd:'500'}});
    row.payload!.historyBoundary='token_creation';expect(calculate(row).totals.realizedProfitUsd).toBe('28.2');
  });
  it('uses captured zero-opening FIFO only within its explicit proven boundary',()=>{
    const row=pair();
    row.payload!.historyBoundary='verified_zero_position';row.payload!.historyFrom='2026-10-10T00:00:00Z';
    row.payload!.openingBalances=[{walletAddress:wallet,tokenAddress:token,tokenAmount:'0'}];
    row.payload!.events.forEach((event,index)=>event.blockNumber=index?'250':'100');
    expect(calculate(row).totals.realizedProfitUsd).toBe('28.2');
    for(const corrupt of ['missing_boundary','nonzero_opening','earlier_block','earlier_time','retained_provider_events']){
      const changed=structuredClone(row);
      if(corrupt==='missing_boundary')delete changed.payload!.historyFrom;
      if(corrupt==='nonzero_opening')changed.payload!.openingBalances[0].tokenAmount='1';
      if(corrupt==='earlier_block')changed.payload!.events[0].blockNumber='1';
      if(corrupt==='earlier_time')changed.payload!.events[0].timestamp='2026-10-09T00:00:00Z';
      if(corrupt==='retained_provider_events')changed.payload!.historicalEvents=[changed.payload!.events[0]];
      expect(publicLeaderboardPeriodInput(changed,start,end).reasons).toEqual(['accounting_evidence_invalid']);
    }
  });
  it('returns a repair state for missing or corrupt stored evidence rather than blocking every other KOL',()=>{
    expect(publicLeaderboardPeriodInput(pair({payload:null}),start,end).reasons).toEqual(['accounting_pending']);
    const row=pair();row.payload!.events[0].walletAddress=`0x${'d'.repeat(40)}`;
    expect(publicLeaderboardPeriodInput(row,start,end).reasons).toEqual(['accounting_evidence_invalid']);
    row.payload!.events=undefined as any;
    expect(publicLeaderboardPeriodInput(row,start,end).reasons).toEqual(['accounting_evidence_invalid']);
  });
});
