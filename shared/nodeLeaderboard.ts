import type { NodeAccountingSource } from './nodeAccounting.js';
import type { FreshFeeExclusions } from './freshAccounting.js';

/** The rolling window selects realizations, not the age of their FIFO lots. */
export interface NodeLeaderboardSnapshot {
  version: 1;
  policy: 'kollens_fifo_v1';
  walletAddress: string;
  /** Realizations in this rolling window may consume FIFO lots acquired earlier. */
  period?: '24h';
  windowStart: string;
  windowEnd: string;
  snapshotId: string;
  asOf: string;
  source: NodeAccountingSource;
  coveredThroughBlock: string | null;
  coveredThroughHash: string | null;
  complete: boolean;
  reasons: string[];
  realizedProfitUsd: string | null;
  /** Diagnostic subtotal only; incomplete totals never receive a leaderboard rank. */
  knownRealizedProfitUsd: string;
  valuedSellCount: number;
  excludedSellCount: number;
  valuedTransferOutCount: number;
  excludedTransferOutCount: number;
  /** Failed executions may pay an authenticated fee without a token movement. */
  feeOnlyFeesUsd?: string | null;
  valuedFeeCount?: number;
  excludedFeeCount?: number;
  exclusions?: { feeOnly: FreshFeeExclusions };
}

export type NodeLeaderboardStatus = 'ready' | 'partial' | 'pending';

export function nodeLeaderboardStatus(snapshot: NodeLeaderboardSnapshot | null | undefined): NodeLeaderboardStatus {
  if (!snapshot) return 'pending';
  if (snapshot.complete && snapshot.realizedProfitUsd !== null) return 'ready';
  return snapshot.valuedSellCount + snapshot.valuedTransferOutCount + (snapshot.valuedFeeCount ?? 0) > 0 ? 'partial' : 'pending';
}
