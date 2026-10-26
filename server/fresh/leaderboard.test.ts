import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { freshStoredKolDailyMetrics, freshStoredKolRollingMetrics, rankFreshStoredLeaderboard } from './leaderboard.js';
import { createFreshReads } from './reads.js';

const day = '2026-10-24';
const row = { utc_date: day, today_realized_q: '61/2', today_known_realized_q: '61/2', today_trade_count: 3,
  today_valued_sell_count: 1, today_fee_only_q: '0', today_unknown_count: 0, decode_gap_from_block: null, decoding_pending: false,
  metrics_updated_at: '2026-10-24T00:10:00Z' };
const rollingRow={...row,rolling_as_of:'2026-10-24T00:10:00Z',rolling_next_expiry_at:'2026-10-24T01:10:00Z',
  rolling_realized_q:'61/2',rolling_known_realized_q:'61/2',rolling_trade_count:3,rolling_buy_count:2,rolling_sell_count:1,
  rolling_valued_sell_count:1,rolling_fee_only_q:'0',rolling_unknown_count:0,rolling_metrics_updated_at:'2026-10-24T00:10:00Z'};
const ranked = (address: string, value: string | null, complete = true, trades = 2) => ({ address,
  realizedProfitUsd: value, knownRealizedProfitUsd: value ?? '9000000', tradeCount24h: trades,
  accounting: { complete, valuedSellCount: 1, valuedTransferOutCount: 0, valuedFeeCount: 0 } });

describe('stored UTC-day leaderboard', () => {
  it('uses the current exact stored total and its actual write time', () => {
    expect(freshStoredKolDailyMetrics(row, day)).toMatchObject({ complete: true, realizedProfitUsd: '30.5',
      knownRealizedProfitUsd: '30.5', tradeCount: 3, updatedAt: '2026-10-24T00:10:00.000Z' });
  });
  it.each([
    [{ today_unknown_count: 1 }, 'unknown_costs'],
    [{ today_realized_q: null }, 'stored_total_unavailable'],
    [{ decode_gap_from_block: '100' }, 'wallet_decode_gap'],
    [{ decoding_pending: true }, 'decoding_pending'],
  ] as const)('never promotes a subtotal when required accounting is incomplete: %j', (patch, reason) => {
    expect(freshStoredKolDailyMetrics({ ...row, ...patch }, day)).toMatchObject({ complete: false,
      realizedProfitUsd: null, knownRealizedProfitUsd: '30.5', reasons: [reason] });
  });
  it('does not turn a missing stored timestamp into the response time', () => {
    expect(freshStoredKolDailyMetrics({ ...row, metrics_updated_at: null }, day).updatedAt).toBeNull();
  });
  it('does not show yesterday totals as today before the worker rollover', () => {
    expect(freshStoredKolDailyMetrics({ ...row, utc_date: '2026-10-23' }, day)).toMatchObject({
      complete: true, realizedProfitUsd: '0', knownRealizedProfitUsd: '0', tradeCount: 0, valuedSellCount: 0 });
  });
  it('ranks complete profit, break-even and losses before every incomplete subtotal', () => {
    const items = rankFreshStoredLeaderboard([ranked('partial', null, false), ranked('loss', '-20'),
      ranked('profit', '30.5'), ranked('zero', '0'), { ...ranked('inactive', '0', true, 0), accounting: { complete: true, valuedSellCount: 0, valuedTransferOutCount: 0 } }]);
    expect(items.map(item => [item.address, item.rank])).toEqual([['profit', 1], ['zero', 2], ['loss', 3], ['partial', null], ['inactive', null]]);
  });
  it('retains exact decimal ordering beyond JavaScript float precision', () => {
    expect(rankFreshStoredLeaderboard([ranked('a', '9007199254740992.0000000000000000001'),
      ranked('b', '9007199254740992.0000000000000000002')]).map(item => item.address)).toEqual(['b', 'a']);
  });
  it('uses a stable trade-count/address tie break without inventing partial ranks', () => {
    expect(rankFreshStoredLeaderboard([ranked('z', '3', true, 2), ranked('b', '3', true, 3),
      ranked('a', '3', true, 3)]).map(item => item.address)).toEqual(['a', 'b', 'z']);
  });
  it('ordinary leaderboard requests read stored totals and bounded dependency identities without recalculating financial history', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.startsWith('SELECT key,')) return { rows: [
        { key: 'start', block_number: '100', updated_at: '2026-10-23T23:50:00Z' },
        { key: 'decode', block_number: '200', updated_at: '2026-10-24T00:20:00Z' },
      ] };
      if (sql.includes('FROM fresh.kols')) return { rows: [{ ...rollingRow, wallet_address: 'wallet', address: 'wallet' }] };
      throw new Error(`Unexpected query: ${sql}`);
    });
    const reads = createFreshReads({ query } as unknown as Pool, () => Date.parse('2026-10-24T00:30:00Z'), true);
    const first = await reads.leaderboard(), second = await reads.leaderboard();
    expect(first.items[0]).toMatchObject({ rank: 1, realizedProfitUsd: '30.5', updatedAt: '2026-10-24T00:10:00.000Z' });
    expect(first).toMatchObject({period:'24h',windowStart:'2026-10-23T00:30:00.000Z',windowEnd:'2026-10-24T00:30:00.000Z'});
    expect(second.items[0]).toEqual(first.items[0]);
    expect(query.mock.calls).toHaveLength(4);
    expect(query.mock.calls.every(([sql]) => !/fresh\.(positions|open_lots)|\b(UPDATE|INSERT|DELETE|SUM)\b/i.test(sql))).toBe(true);
    expect(query.mock.calls.find(([sql])=>sql.includes('FROM fresh.kols'))?.[0]).toContain('promoted.id=pending.id OR promoted.execution_key=pending.execution_key');
  });
});

describe('stored rolling 24-hour metrics',()=>{
  const at=Date.parse('2026-10-24T00:30:00Z');
  it('keeps valid stored totals through midnight without borrowing daily counters',()=>{
    expect(freshStoredKolRollingMetrics({...rollingRow,today_realized_q:'999',utc_date:'2026-10-23'},at))
      .toMatchObject({complete:true,realizedProfitUsd:'30.5',tradeCount:3});
  });
  it.each([
    [{rolling_as_of:null},'rolling_totals_pending'],
    [{rolling_as_of:'2026-10-24T01:00:00Z'},'rolling_totals_pending'],
    [{rolling_next_expiry_at:'2026-10-24T00:30:00Z'},'rolling_totals_pending'],
    [{rolling_unknown_count:1},'unknown_costs'],
    [{rolling_realized_q:null},'stored_total_unavailable'],
    [{decoding_pending:true},'decoding_pending'],
    [{token_discovery_pending:true},'token_discovery_pending'],
  ])('never ranks stale, uninitialized or incomplete totals: %j',(patch,reason)=>{
    expect(freshStoredKolRollingMetrics({...rollingRow,...patch},at)).toMatchObject({complete:false,realizedProfitUsd:null,reasons:expect.arrayContaining([reason])});
  });
  it('does not refresh the write timestamp on read',()=>{
    expect(freshStoredKolRollingMetrics(rollingRow,at).updatedAt).toBe('2026-10-24T00:10:00.000Z');
  });
  it('uses an exact rolling trade window and preserves explicit UTC-day browsing',async()=>{
    const query=vi.fn(async(_sql:string,_values?:unknown[])=>({rows:[]}));
    const reads=createFreshReads({query} as unknown as Pool,()=>at,true);
    await reads.trades({window:'24h'});
    expect(query.mock.calls[0][0]).toContain('e.occurred_at>$1::timestamptz');
    expect(query.mock.calls[0][1]).toEqual(['2026-10-23T00:30:00.000Z','2026-10-24T00:30:00.000Z',51]);
    await reads.trades({today:true});
    expect(query.mock.calls[1][1]).toEqual(['2026-10-24T00:00:00.000Z',51]);
  });
});
