import { describe, expect, it } from 'vitest';
import type { NodeLeaderboardSnapshot } from '../shared/nodeLeaderboard';
import { leaderboardPresentation } from './leaderboardPresentation';

const snapshot: NodeLeaderboardSnapshot = {
  version: 1, policy: 'kollens_fifo_v1', walletAddress: `0x${'1'.repeat(40)}`, snapshotId: 'a'.repeat(64),
  windowStart: '2026-10-18T12:00:00.000Z', windowEnd: '2026-10-19T12:00:00.000Z', asOf: '2026-10-19T12:00:00.000Z',
  source: 'node', coveredThroughBlock: '100', coveredThroughHash: `0x${'b'.repeat(64)}`, complete: true, reasons: [],
  realizedProfitUsd: '25', knownRealizedProfitUsd: '25', valuedSellCount: 2, excludedSellCount: 0, valuedTransferOutCount: 0, excludedTransferOutCount: 0,
};
describe('period leaderboard presentation', () => {
  it('ranks a complete period result and retains its original observation time', () => {
    expect(leaderboardPresentation({ accounting: snapshot, tradeCount24h: 3 })).toMatchObject({ status: 'ready', value: '25', canRank: true, asOf: snapshot.asOf });
  });
  it('restores the displayed rank for known partial profit while retaining its partial status', () => {
    expect(leaderboardPresentation({ accounting: { ...snapshot, complete: false, realizedProfitUsd: null, excludedSellCount: 1 }, tradeCount24h: 3 }))
      .toMatchObject({ status: 'partial', value: '25', canRank: true, unavailableCount: 1 });
  });
  it('does not turn an entirely unresolved position into a zero-profit result', () => {
    expect(leaderboardPresentation({ accounting: { ...snapshot, complete: false, realizedProfitUsd: null, knownRealizedProfitUsd: '0', valuedSellCount: 0, excludedSellCount: 1 } }))
      .toMatchObject({ status: 'pending', value: null, canRank: false });
  });
  it('numbers an exactly break-even known partial result without treating it as unknown', () => {
    expect(leaderboardPresentation({ accounting: { ...snapshot, complete: false, realizedProfitUsd: null, knownRealizedProfitUsd: '0', excludedSellCount: 1 } }))
      .toMatchObject({ status: 'partial', value: '0', canRank: true });
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
