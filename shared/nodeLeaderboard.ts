import type { NodeAccountingSource } from './nodeAccounting.js';

/** The rolling window selects realizations, not the age of their FIFO lots. */
export interface NodeLeaderboardSnapshot {
  version: 1;
  policy: 'kollens_fifo_v1';
  walletAddress: string;
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
  /** A clearly labeled subtotal; never substituted for a complete ranking. */
  knownRealizedProfitUsd: string;
  valuedSellCount: number;
  excludedSellCount: number;
  valuedTransferOutCount: number;
  excludedTransferOutCount: number;
  /** Failed executions may pay an authenticated fee without a token movement. */
  feeOnlyFeesUsd?: string | null;
  valuedFeeCount?: number;
  excludedFeeCount?: number;
}

export type NodeLeaderboardStatus = 'ready' | 'partial' | 'pending';

export function nodeLeaderboardStatus(snapshot: NodeLeaderboardSnapshot | null | undefined): NodeLeaderboardStatus {
  if (!snapshot) return 'pending';
  if (snapshot.complete && snapshot.realizedProfitUsd !== null) return 'ready';
  return snapshot.valuedSellCount + snapshot.valuedTransferOutCount + (snapshot.valuedFeeCount ?? 0) > 0 ? 'partial' : 'pending';
}
