import type { KolTokenBalanceProof } from './kolTokenTrades.js';

export type NodeAccountingSource = 'node' | 'mixed' | 'imported';
/** Account and membership are part of private cache identity, never public identity. */
export type NodeAccountingScope = { kind: 'public' } | {
  kind: 'portfolio'; accountId: string; membershipRevision: string; fromAt: string; fromBlock: string;
};
export interface NodeAccountingSnapshotIdentity {
  version: 2; snapshotId: string; source: NodeAccountingSource; scope: 'public' | 'portfolio';
  asOf: string; historyFingerprint: string; historyFrom: string | null;
  coveredThroughBlock: string | null; valuationBlock: string | null; valuationHash: string | null;
  complete: boolean; reasons: string[]; lastValid?: { snapshotId: string; asOf: string };
  /** Original dated values remain visible while independent refresh work waits. */
  refreshStatus?: 'pending'; refreshReason?: string;
  historyBoundary?: 'token_creation' | 'wallet_discovery' | 'imported_baseline' | 'membership_added';
}
export interface NodeAccountingSummary {
  tokenAddress: string; snapshot: NodeAccountingSnapshotIdentity | null;
  status: 'ready' | 'pending' | 'unavailable'; position: 'open' | 'closed' | 'unknown';
  realizedProfitUsd: string | null; estimatedProfitUsd: string | null; roi: string | null;
  remainingTokenAmount: string | null; valueUsd: string | null; reason?: string; retryAfterMs?: number;
}
export interface NodeAccountingBaselineLedger {
  investedUsd: string | null; soldUsd: string | null;
  incomingTransferCostUsd: string | null; transferOutIncomeUsd: string | null;
  realizedProfitUsd: string | null; feesUsd: string | null; feeInclusiveCapitalUsd: string | null;
  lots: { tokenAmount: string; costBasisUsd: string | null }[];
}
export interface NodeAccountingBaselineInput {
  wallet: string; token: string; checkpoint: KolTokenBalanceProof; historyFingerprint: string;
  ledger: NodeAccountingBaselineLedger;
  /** Verification must be performed by the importer against independent node evidence. */
  overlapVerified: true; quantityVerified: true;
}
