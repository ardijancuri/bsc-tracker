import type { NodeAccountingSource } from './nodeAccounting.js';
import type { FreshFeeExclusions } from './freshAccounting.js';

/** An explicitly approximate value from the separately versioned stored
 * projection. Unknown inputs remain unknown in the financial ledger. */
export interface NodeLeaderboardEstimate {
  version: 1;
  policy: 'omit_unknown_costs_v1';
  basis: 'recorded_facts';
  asOf: string;
  windowStart: string;
  windowEnd: string;
  reasons: string[];
  affectedSellCount: number;
  /** Existing compact totals do not distinguish these missing-input counts. */
  missingCostCount: number | null;
  missingProceedsCount: number | null;
  missingFeeCount: number | null;
  unvaluedFeeOnlyCount: number;
}

/** The rolling window selects realizations, not the age of their FIFO lots. */
export interface NodeLeaderboardSnapshot {
  version: 1;
  policy: 'kollens_fifo_v1';
  realizedPolicy?: 'sales_fifo_fees_v2';
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
  /** Older unresolved coverage may be proven irrelevant to this rolling period;
   * it still prevents blanket lifetime or inventory approval. */
  historicalGap?: { fromBlock: string; status: 'unresolved'; currentPeriodIsolated: boolean };
  realizedProfitUsd: string | null;
  /** Separate approximate projection; never substitutes for exact accounting. */
  estimatedRealizedProfitUsd?: string | null;
  estimate?: NodeLeaderboardEstimate | null;
  /** Diagnostic subtotal only; not the approximation and never a ranking fallback. */
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

export type NodeLeaderboardStatus = 'ready' | 'estimated' | 'partial' | 'pending';

type EstimatedSnapshot = Pick<NodeLeaderboardSnapshot,'complete'|'realizedProfitUsd'>
  & Partial<Pick<NodeLeaderboardSnapshot,'version'|'policy'|'realizedPolicy'|'source'|'period'|'asOf'|'windowStart'|'windowEnd'|'estimatedRealizedProfitUsd'|'estimate'>>;
export function nodeLeaderboardEstimatedValue(snapshot: EstimatedSnapshot | null | undefined): string | null {
  if (!snapshot || snapshot.complete || snapshot.realizedProfitUsd !== null || snapshot.version !== 1
    || snapshot.policy !== 'kollens_fifo_v1' || snapshot.realizedPolicy !== 'sales_fifo_fees_v2' || snapshot.period!=='24h'
    || !['node','mixed'].includes(snapshot.source??'')) return null;
  const value=snapshot.estimatedRealizedProfitUsd, e=snapshot.estimate;
  const count=(v:unknown)=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0;
  if(typeof value!=='string'||value.length>1024||value.replace(/\D/g,'').length>512||! /^-?\d+(?:\.\d+)?$/.test(value)||!e||e.version!==1||e.policy!=='omit_unknown_costs_v1'||e.basis!=='recorded_facts'
    ||e.asOf!==snapshot.asOf||e.windowStart!==snapshot.windowStart||e.windowEnd!==snapshot.windowEnd
    ||!Number.isFinite(Date.parse(e.asOf))||!Number.isFinite(Date.parse(e.windowStart))||!Number.isFinite(Date.parse(e.windowEnd))
    ||Date.parse(e.asOf)>Date.parse(e.windowEnd)||Date.parse(e.windowEnd)-Date.parse(e.windowStart)!==86_400_000
    ||!Array.isArray(e.reasons)||!e.reasons.length||e.reasons.some(r=>typeof r!=='string'||r.length>100)
    ||!count(e.affectedSellCount)||!count(e.unvaluedFeeOnlyCount)
    ||[e.missingCostCount,e.missingProceedsCount,e.missingFeeCount].some(v=>v!==null&&!count(v))) return null;
  return value;
}

export function nodeLeaderboardStatus(snapshot: NodeLeaderboardSnapshot | null | undefined): NodeLeaderboardStatus {
  if (!snapshot) return 'pending';
  if (snapshot.complete && snapshot.realizedProfitUsd !== null) return 'ready';
  if (nodeLeaderboardEstimatedValue(snapshot)!==null) return 'estimated';
  return snapshot.valuedSellCount + (snapshot.realizedPolicy==='sales_fifo_fees_v2'?0:snapshot.valuedTransferOutCount) + (snapshot.valuedFeeCount ?? 0) > 0 ? 'partial' : 'pending';
}
