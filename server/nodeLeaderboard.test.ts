import { describe, expect, it } from 'vitest';
import type { NodeLeaderboardSnapshot } from '../shared/nodeLeaderboard.js';
import { validateNodeLeaderboardSnapshot } from './nodeLeaderboard.js';

const snapshot: NodeLeaderboardSnapshot = {
  version: 1, policy: 'kollens_fifo_v1', walletAddress: `0x${'1'.repeat(40)}`, snapshotId: 'a'.repeat(64),
  windowStart: '2026-10-18T12:00:00.000Z', windowEnd: '2026-10-19T12:00:00.000Z', asOf: '2026-10-19T11:59:58.000Z',
  source: 'mixed', coveredThroughBlock: '100', coveredThroughHash: `0x${'b'.repeat(64)}`, complete: true, reasons: [],
  realizedProfitUsd: '25.123456789012345678901234567890123456', knownRealizedProfitUsd: '25.123456789012345678901234567890123456',
  valuedSellCount: 2, excludedSellCount: 0, valuedTransferOutCount: 0, excludedTransferOutCount: 0,
};
const request = { wallets: [snapshot.walletAddress], windowStart: snapshot.windowStart, windowEnd: snapshot.windowEnd };
describe('period leaderboard publication contract', () => {
  it('retains exact decimals and the original earlier confirmed as-of time', () => {
    expect(validateNodeLeaderboardSnapshot(snapshot, request)).toBe(snapshot);
  });
  it.each([
    { walletAddress: `0x${'9'.repeat(40)}` },
    { windowStart: '2026-10-17T12:00:00.000Z' },
    { windowEnd: '2026-10-19T12:00:01.000Z' },
    { asOf: '2026-10-19T12:00:01.000Z' },
    { realizedProfitUsd: '1e30' },
    { knownRealizedProfitUsd: 'NaN' },
    { complete: false },
    { coveredThroughHash: null },
    { excludedSellCount: -1 },
    { excludedSellCount: 1 },
    { reasons: ['history_incomplete'] },
    { valuedFeeCount: -1 },
  ])('rejects mismatched public identities, windows and incomplete financial contracts: %j', change => {
    expect(() => validateNodeLeaderboardSnapshot({ ...snapshot, ...change } as NodeLeaderboardSnapshot, request)).toThrow('node_leaderboard_snapshot_invalid');
  });
  it('accepts an explicitly incomplete known subtotal without promoting it to a total', () => {
    const partial = { ...snapshot, complete: false, realizedProfitUsd: null, reasons: ['purchase_cost_unknown'], excludedSellCount: 1 };
    expect(validateNodeLeaderboardSnapshot(partial, request)).toBe(partial);
  });
});
