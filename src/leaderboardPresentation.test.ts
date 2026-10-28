import { describe, expect, it } from 'vitest';
import type { NodeLeaderboardSnapshot } from '../shared/nodeLeaderboard';
import { leaderboardPresentation } from './leaderboardPresentation';

const snapshot: NodeLeaderboardSnapshot = {
  version: 1, policy: 'kollens_fifo_v1', period: '24h', walletAddress: `0x${'1'.repeat(40)}`, snapshotId: 'a'.repeat(64),
  windowStart: '2026-10-18T12:00:00.000Z', windowEnd: '2026-10-19T12:00:00.000Z', asOf: '2026-10-19T12:00:00.000Z',
  source: 'node', coveredThroughBlock: '100', coveredThroughHash: `0x${'b'.repeat(64)}`, complete: true, reasons: [],
  realizedProfitUsd: '25', knownRealizedProfitUsd: '25', valuedSellCount: 2, excludedSellCount: 0, valuedTransferOutCount: 0, excludedTransferOutCount: 0,
};
describe('period leaderboard presentation', () => {
  it('ranks a complete period result and retains its original observation time', () => {
    expect(leaderboardPresentation({ accounting: snapshot, tradeCount24h: 3 })).toMatchObject({ status: 'ready', value: '25', canRank: true,
      asOf: snapshot.asOf, windowStart: snapshot.windowStart, windowEnd: snapshot.windowEnd });
  });
  it('keeps the previous-day part of a rolling window after UTC midnight', () => {
    const overnight = { ...snapshot, windowStart: '2026-10-23T01:55:00.000Z', windowEnd: '2026-10-24T01:55:00.000Z', asOf: '2026-10-24T01:55:00.000Z', realizedProfitUsd: '-12.125' };
    expect(leaderboardPresentation({ accounting: overnight, tradeCount24h: 2 })).toMatchObject({ status: 'ready', canRank: true,
      value: '-12.125', windowStart: overnight.windowStart, windowEnd: overnight.windowEnd, asOf: overnight.asOf });
  });
  it('uses the same complete stored result on the profile and leaderboard without a top-level subtotal fallback', () => {
    const row = { accounting: snapshot, tradeCount24h: 3, realizedProfitUsd: '999999', knownRealizedProfitUsd: '999999' };
    expect(leaderboardPresentation(row)).toEqual(leaderboardPresentation({ accounting: snapshot, tradeCount24h: 3 }));
    expect(leaderboardPresentation({ ...row, accounting: { ...snapshot, complete: false, realizedProfitUsd: null } }))
      .toMatchObject({ value: null, canRank: false });
  });
  it('keeps known partial profit out of the displayed value and ranks', () => {
    expect(leaderboardPresentation({ accounting: { ...snapshot, complete: false, realizedProfitUsd: null, excludedSellCount: 1 }, tradeCount24h: 3 }))
      .toMatchObject({ status: 'partial', value: null, canRank: false, unavailableCount: 1 });
  });
  it('does not turn an entirely unresolved position into a zero-profit result', () => {
    expect(leaderboardPresentation({ accounting: { ...snapshot, complete: false, realizedProfitUsd: null, knownRealizedProfitUsd: '0', valuedSellCount: 0, excludedSellCount: 1 } }))
      .toMatchObject({ status: 'pending', value: null, canRank: false });
  });
  it('does not rank a break-even known subtotal as a complete result', () => {
    expect(leaderboardPresentation({ accounting: { ...snapshot, complete: false, realizedProfitUsd: null, knownRealizedProfitUsd: '0', excludedSellCount: 1 } }))
      .toMatchObject({ status: 'partial', value: null, canRank: false });
  });
  it('supports marked transfer realizations when there are no buy/sell rows', () => {
    expect(leaderboardPresentation({ accounting: { ...snapshot, valuedSellCount: 0, valuedTransferOutCount: 1 }, tradeCount24h: 0 }))
      .toMatchObject({ status: 'ready', value: '25', canRank: true, realizedCount: 1 });
  });
  it('includes authenticated fee-only realizations without inventing a trade', () => {
    expect(leaderboardPresentation({ accounting: { ...snapshot, realizedProfitUsd: '-0.1', knownRealizedProfitUsd: '-0.1', valuedSellCount: 0, valuedFeeCount: 1, feeOnlyFeesUsd: '0.1' }, tradeCount24h: 0 }))
      .toMatchObject({ status: 'ready', value: '-0.1', canRank: true, realizedCount: 1 });
  });
  it('does not treat inventory transfers as trading realizations under the approved sales policy',()=>{
    expect(leaderboardPresentation({accounting:{...snapshot,realizedPolicy:'sales_fifo_fees_v2',realizedProfitUsd:'0',knownRealizedProfitUsd:'0',valuedSellCount:0,valuedTransferOutCount:2,excludedTransferOutCount:3},tradeCount24h:0}))
      .toMatchObject({status:'ready',value:'0',canRank:false,realizedCount:0,unavailableCount:0});
  });
  it('does not display legacy window-only totals as the new policy', () => {
    expect(leaderboardPresentation({ accounting: { ...snapshot, version: 0 } as unknown as NodeLeaderboardSnapshot }))
      .toMatchObject({ status: 'pending', value: null, canRank: false });
    expect(leaderboardPresentation(null)).toMatchObject({ status: 'pending', value: null });
  });
});

export const estimatedRow = () => ({
  tradeCount24h: 3, pnlQuality: 'estimated' as const, estimatedRealizedProfitUsd: '51.75', rankingProfitUsd: '51.75',
  accounting: { ...snapshot, realizedPolicy: 'sales_fifo_fees_v2' as const, complete: false, realizedProfitUsd: null,
    knownRealizedProfitUsd: '-999', estimatedRealizedProfitUsd: '51.75', excludedSellCount: 1,
    estimate: { version: 1 as const, policy: 'omit_unknown_costs_v1' as const, basis: 'recorded_facts' as const, asOf: snapshot.asOf, windowStart: snapshot.windowStart,
      windowEnd: snapshot.windowEnd, reasons: ['unknown_costs'], affectedSellCount: 1, missingCostCount: null,
      missingProceedsCount: null, missingFeeCount: null, unvaluedFeeOnlyCount: 0 } },
});

describe('explicit missing-cost estimate presentation', () => {
  it('shows and ranks the separately approved estimate without changing exact accounting', () => {
    const row = estimatedRow(), before = JSON.stringify(row), profit = leaderboardPresentation(row);
    expect(profit).toMatchObject({ status: 'estimated', value: '51.75', canRank: true, estimated: true,
      asOf: snapshot.asOf, windowStart: snapshot.windowStart, windowEnd: snapshot.windowEnd });
    expect(profit.estimate?.missingCostCount).toBeNull();
    expect(row.accounting.realizedProfitUsd).toBeNull();
    expect(row.accounting.complete).toBe(false);
    expect(JSON.stringify(row)).toBe(before);
  });
  it('uses identical values and timestamps for board and profile even when exact and diagnostic subtotals differ', () => {
    const row = estimatedRow(), profile = { ...row, realizedProfitUsd: null, knownRealizedProfitUsd: '88888' };
    expect(leaderboardPresentation(profile)).toEqual(leaderboardPresentation(row));
    expect(leaderboardPresentation(profile).value).not.toBe(profile.knownRealizedProfitUsd);
  });
  it.each(['0', '-12.5'])('retains an explicitly estimated %s instead of dropping it as falsy', value => {
    const row = estimatedRow(); row.estimatedRealizedProfitUsd = value; row.rankingProfitUsd = value; row.accounting.estimatedRealizedProfitUsd = value;
    expect(leaderboardPresentation(row)).toMatchObject({ status: 'estimated', estimated: true, value, canRank: true });
  });
  it.each([
    ['top-level quality missing', (r: ReturnType<typeof estimatedRow>) => { delete (r as Partial<typeof r>).pnlQuality; }],
    ['top-level value missing', (r: ReturnType<typeof estimatedRow>) => { delete (r as Partial<typeof r>).estimatedRealizedProfitUsd; }],
    ['ranking value differs', (r: ReturnType<typeof estimatedRow>) => { r.rankingProfitUsd = '52'; }],
    ['top-level value differs', (r: ReturnType<typeof estimatedRow>) => { r.estimatedRealizedProfitUsd = '52'; }],
    ['wrong policy', (r: ReturnType<typeof estimatedRow>) => { (r.accounting.estimate as { policy: string }).policy = 'other'; }],
    ['missing recorded-facts basis', (r: ReturnType<typeof estimatedRow>) => { delete (r.accounting.estimate as Partial<typeof r.accounting.estimate>).basis; }],
    ['wrong recorded-facts basis', (r: ReturnType<typeof estimatedRow>) => { (r.accounting.estimate as { basis: string }).basis = 'known_subtotal'; }],
    ['wrong version', (r: ReturnType<typeof estimatedRow>) => { (r.accounting.estimate as { version: number }).version = 2; }],
    ['different observation time', (r: ReturnType<typeof estimatedRow>) => { r.accounting.estimate.asOf = '2026-10-19T11:00:00.000Z'; }],
    ['different window', (r: ReturnType<typeof estimatedRow>) => { r.accounting.estimate.windowStart = '2026-10-17T12:00:00.000Z'; }],
    ['malformed value', (r: ReturnType<typeof estimatedRow>) => { r.accounting.estimatedRealizedProfitUsd = 'NaN'; }],
    ['invalid omission count', (r: ReturnType<typeof estimatedRow>) => { r.accounting.estimate.affectedSellCount = -1; }],
    ['legacy source', (r: ReturnType<typeof estimatedRow>) => { r.accounting.source = 'imported'; }],
  ] as const)('does not promote a %s envelope to an estimate', (_name, mutate) => {
    const row = estimatedRow(); mutate(row);
    expect(leaderboardPresentation(row)).toMatchObject({ value: null, estimated: false, estimate: null, canRank: false });
  });
  it('rejects a mismatched enclosing period and permits approved mixed node provenance', () => {
    const row = estimatedRow(); row.accounting.source = 'mixed';
    expect(leaderboardPresentation(row).estimated).toBe(true);
    expect(leaderboardPresentation({ ...row, windowEnd: '2026-10-20T12:00:00.000Z' })).toMatchObject({ value: null, estimated: false });
  });
  it('displays an explicit estimate when the server correctly leaves an inactive wallet unranked', () => {
    const row = estimatedRow();
    expect(leaderboardPresentation({ ...row, tradeCount24h: 0, rankingProfitUsd: null,
      accounting: { ...row.accounting, valuedSellCount: 0, excludedSellCount: 0 } }))
      .toMatchObject({ status: 'estimated', value: '51.75', estimated: true, canRank: false });
    expect(leaderboardPresentation({ ...row, rankingProfitUsd: null }))
      .toMatchObject({ status: 'estimated', value: '51.75', estimated: true, canRank: false });
    expect(leaderboardPresentation({ ...row, tradeCount24h: 0 }))
      .toMatchObject({ status: 'estimated', value: '51.75', estimated: true, canRank: true });
  });
  it('keeps a complete exact value ahead of any inconsistent estimate fields', () => {
    const row = estimatedRow();
    expect(leaderboardPresentation({ ...row, accounting: { ...row.accounting, complete: true, realizedProfitUsd: '25' } }))
      .toMatchObject({ status: 'ready', value: '25', estimated: false, estimate: null });
  });
});
