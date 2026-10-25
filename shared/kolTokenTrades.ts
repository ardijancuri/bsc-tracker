import type{FreshAcquisitionCost}from'./freshAccounting.js';
import type { TradeReplayAccounting } from './tradeReplayAccounting.js';
import type { NodeAccountingSnapshotIdentity } from './nodeAccounting.js';

/** One KOL's indexed activity for one exact token contract, without a 24h cutoff. */
export interface KolTokenActivity {
  /** Fresh ledger service decides accounting eligibility; clients validate identity and freshness. */
  tracking?: { version: 1; source: 'fresh'; fromBlock: string; utcDay: string; realizedComplete?: boolean };
  kol: { address: string; name: string | null; avatarUrl: string | null; twitter: string | null; source: string; lastSeenAt: string | null };
  token: {
    address: string; symbol: string | null; name: string | null; logoUrl: string | null;
    priceUsd: string | null; marketCapUsd: string | null; marketCapSupply: string | null; valuationStatus?: string;
  };
  trades: KolTokenTrade[];
  summary: KolTokenTradeSummary;
  inventory?: { version: 1; events: InventoryEvent[]; coverage: InventoryCoverage };
  /** Requested only for share/export preparation, with provider coverage explicit. */
  replayAccounting?: TradeReplayAccounting;
  /** Requested by profile P&L, with GMGN transfer/fee policy kept separate from FIFO. */
  realizedAccounting?: KolTokenRealizedAccounting;
  accountingSnapshot?: NodeAccountingSnapshotIdentity;
  coverage: {
    source: 'indexed'; indexedTradeCount: number; returnedTradeCount: number;
    /** Complete indexed history, not a claim that every on-chain movement is indexed. */
    complete: boolean; historyLimit: number; costsIncluded: false;
  };
  generatedAt: string;
}

export interface KolTokenRealizedAccounting {
  version: 1 | 2;
  source: 'gmgn' | 'onchain' | 'node' | 'mixed' | 'imported';
  policy: 'gmgn_realized_profit_v1' | 'onchain_net_trade_profit_v1' | 'kollens_fifo_v1';
  walletAddress: string;
  tokenAddress: string;
  status: 'ready' | 'pending' | 'unavailable';
  checkedAt: string;
  /** May be unknown while the open position's complete net cash-flow total is known. */
  realizedProfitUsd: string | null;
  /** Mark a verified GMGN position independently of its historical realized cache. */
  position?: KolTokenProfitPosition;
  coverage: {
    /** Completeness of the history source identified by verification. */
    transactionsComplete: boolean; balanceMatched: boolean; reason?: string;
    /** Omitted for the original canonical receipt-backed accounting. */
    verification?: 'gmgn_history' | 'tracked_history' | 'node_history' | 'mixed_history' | 'imported_history';
    historyFingerprint?: string;
    historyCheckedAt?: string;
    /** Latest movement in the complete provider history, independent of its read time. */
    lastMovementAt?: string;
    balanceProof?: KolTokenBalanceProof;
  };
  retryAfterMs?: number;
}

/** Current chain state only; this does not certify historical token movements. */
export interface KolTokenBalanceProof {
  walletAddress: string;
  tokenAddress: string;
  chain: 'bsc';
  blockNumber: string;
  blockHash: string;
  blockTimestamp: string;
  balance: string;
  checkedAt: string;
}

/** A profile quote may be the boundary of the latest completed one-minute bar. */
export const kolTokenPositionQuoteMaxAgeMs = 180_000;

/** Provider history is independent evidence when historical RPC reads cannot
 * run. It must still match every indexed swap and a fresh current-chain balance.
 * Contradictory canonical evidence and unfinished scans never qualify. */
export function canUseGmgnHistoryFallback(reason: string | undefined): boolean {
  return reason === 'inventory_history_unavailable' || reason === 'inventory_rpc_unavailable';
}

export interface KolTokenProfitPosition {
  status: 'open' | 'closed';
  estimatedProfitUsd: string | null;
  /** Ratio, not percentage points (1 means 100%). */
  estimatedRoi: string | null;
  unrealizedProfitUsd: string | null;
  remainingTokenAmount: string;
  remainingCostBasisUsd: string | null;
  feeInclusiveCostUsd: string;
  /** Total profit can be known even when the realized/unrealized split is not. */
  cashFlow?: { investedUsd: string; soldUsd: string; transferOutIncomeUsd: string; feesUsd: string };
  priceUsd: string | null;
  pricedAt: string | null;
  valuationSource: 'gmgn' | 'market' | 'node' | 'mixed' | 'imported' | null;
  reason?: string;
  retryAfterMs?: number;
}

/** Accounting snapshots include transfers without representing them as swaps. */
export interface InventoryEvent {
  id: string;
  kind: 'buy' | 'sell' | 'transfer_in' | 'transfer_out' | 'fee';
  tradeId?: string;
  txHash: string;
  timestamp: string;
  blockNumber: string;
  transactionIndex: number | null;
  logIndex: number | null;
  tokenAmount: string | null;
  remainingTokenAmount: string | null;
  remainingCostBasisUsd: string | null;
  cumulativeRealizedProfitUsd: string | null;
  investedUsd: string | null;
  soldUsd: string | null;
}

/** Movement coverage and the ending balance must describe the same canonical block. */
export interface InventoryCoverage {
  complete: boolean;
  reconciled: boolean;
  fromBlock: string | null;
  toBlock: string | null;
  blockHash: string | null;
  checkedAt: string | null;
  balance: string | null;
  reason?: string;
  status?: 'pending' | 'verified' | 'unavailable';
  initialBalanceSource?: 'historical_call' | 'derived_complete_movements' | null;
  scannedThroughBlock?: string | null;
}

/** Internal evidence from canonical receipts; quantity is signed ERC-20 raw units. */
export interface KolTokenInventoryTransfer {
  id: string;
  txHash: string;
  walletAddress: string;
  tokenAddress: string;
  deltaRaw: string;
  timestamp: string;
  blockNumber: string;
  transactionIndex: number | null;
  logIndex: number | null;
}

export interface KolTokenInventoryEvidence {
  decimals: number;
  initialBalanceRaw: string | null;
  endingBalanceRaw: string | null;
  transfers: KolTokenInventoryTransfer[];
  coverage: InventoryCoverage;
}

export interface KolTokenTrade {
  id: string; txHash: string; walletAddress: string; tokenAddress: string;
  kolName: string | null; kolAvatarUrl: string | null; kolTwitter: string | null;
  tokenSymbol: string | null; tokenName: string | null; tokenLogoUrl: string | null;
  side: 'buy' | 'sell' | 'swap' | 'unknown'; tokenAmount: string | null;
  quoteSymbol: string | null; quoteTokenAddress?: string | null; quoteAmount: string | null; amountUsd: string | null;
  /** BNB equivalent from the stored historical node rate; original quote stays intact. */
  bnbEquivalentAmount?: string | null;
  acquisitionCost?:FreshAcquisitionCost;
  priceUsd: string | null; marketCapUsd: string | null; timestamp: string;
  source: string; blockNumber: string | null; transactionIndex: number | null;
  valuationStatus: 'valued' | 'unpriced' | 'shared_quote' | 'invalid_quantity';
  /** Confirmed swaps remain visible before historical accounting evidence is complete. */
  accountingStatus?: 'ready' | 'pending_precision' | 'pending_settlement';
  accountingReason?: string;
  /** FIFO results exclude gas and are null when the observed cost basis cannot be matched. */
  realizedProfitUsd: string | null; cumulativeRealizedProfitUsd: string | null;
}

export interface KolTokenTradeSummary {
  investedUsd: string | null; soldUsd: string | null; realizedProfitUsd: string | null;
  avgBoughtPriceUsd: string | null; avgSoldPriceUsd: string | null;
  avgBoughtMcapUsd: string | null; avgSoldMcapUsd: string | null;
  /** Transfer-adjusted lots when verified inventory is supplied; otherwise observed swaps only. */
  remainingTokenAmount: string | null; remainingCostBasisUsd: string | null;
  buyCount: number; sellCount: number; valuedBuyCount: number; valuedSellCount: number;
  excludedSellCount: number; unpricedTradeCount: number;
  firstTradeAt: string | null; lastTradeAt: string | null;
  status: 'open' | 'closed' | 'unknown'; profitBasis: 'observed_fifo';
}
