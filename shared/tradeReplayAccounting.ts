import type { KolTokenBalanceProof } from './kolTokenTrades.js';

/** Server-approved ledger values shared by details and exported replay frames. */
export interface ReplayAccountingSnapshot {
  remainingTokenAmount: string | null;
  remainingCostBasisUsd: string | null;
  /** Includes marked transfer-out gains and all known disposal fees. */
  cumulativeRealizedProfitUsd: string | null;
  /** GMGN's reported purchase amounts, before fees. */
  investedUsd: string | null;
  soldUsd: string | null;
  transferOutIncomeUsd: string | null;
  feesUsd: string | null;
  /** Fee-inclusive denominator used for total return, including incoming basis. */
  feeInclusiveCostUsd: string | null;
}

export interface ReplayAccountingEvent extends ReplayAccountingSnapshot {
  id: string;
  kind: 'buy' | 'sell' | 'transfer_in' | 'transfer_out' | 'fee';
  tradeId?: string;
  txHash: string;
  timestamp: string;
  blockNumber: string;
  transactionIndex: number | null;
  logIndex: number | null;
}

/** A separately verified ending snapshot; never allocated into earlier frames. */
export interface ReplayAccountingFinal extends ReplayAccountingSnapshot {
  reportedProfitUsd: string | null;
  /** Ratio, not percentage points (1 means 100%). */
  reportedRoi: string | null;
  /** USD price observed with this position snapshot; null for a closed position. */
  priceUsd: string | null;
  timestamp: string;
}

/** Complete provider movements reconciled to current chain state, not an
 * archived RPC scan. Provider-only transfers have no asserted block/ordinal. */
export interface GmgnReplayHistory {
  fingerprint: string;
  checkedAt: string;
  balanceProof: KolTokenBalanceProof;
  events: (Omit<ReplayAccountingEvent, 'blockNumber'> & { blockNumber: string | null; tokenAmount: string })[];
}

export interface TradeReplayAccounting {
  version: 1 | 2;
  source: 'gmgn' | 'node' | 'mixed' | 'imported';
  policy: 'gmgn_total_profit_v1' | 'kollens_fifo_v1';
  walletAddress: string;
  tokenAddress: string;
  status: 'ready' | 'estimated' | 'pending' | 'unavailable';
  checkedAt: string;
  inventoryBlockNumber: string | null;
  inventoryBlockHash: string | null;
  events: ReplayAccountingEvent[];
  final: ReplayAccountingFinal | null;
  history?: GmgnReplayHistory;
  coverage: {
    transactionsComplete: boolean;
    balanceMatched: boolean;
    exactFinal: boolean;
    /** Signed display-only ending. It does not certify unknown purchase basis. */
    estimatedFinal?: boolean;
    verification?: 'gmgn_history' | 'node_history' | 'mixed_history' | 'imported_history';
    reason?: string;
  };
  retryAfterMs?: number;
}
