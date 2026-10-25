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
  it('does not display legacy window-only totals as the new policy', () => {
    expect(leaderboardPresentation({ accounting: { ...snapshot, version: 0 } as unknown as NodeLeaderboardSnapshot }))
      .toMatchObject({ status: 'pending', value: null, canRank: false });
    expect(leaderboardPresentation(null)).toMatchObject({ status: 'pending', value: null });
  });
});
