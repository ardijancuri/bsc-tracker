import type { TradeReplayAccounting } from './tradeReplayAccounting.js';

/** One KOL's indexed activity for one exact token contract, without a 24h cutoff. */
export interface KolTokenActivity {
  kol: { address: string; name: string | null; avatarUrl: string | null; twitter: string | null; source: string; lastSeenAt: string | null };
  token: {
    address: string; symbol: string | null; name: string | null; logoUrl: string | null;
    priceUsd: string | null; marketCapUsd: string | null; marketCapSupply: string | null;
  };
  trades: KolTokenTrade[];
  summary: KolTokenTradeSummary;
  inventory?: { version: 1; events: InventoryEvent[]; coverage: InventoryCoverage };
  /** Requested only for share/export preparation, with provider coverage explicit. */
  replayAccounting?: TradeReplayAccounting;
  /** Requested by profile P&L, with GMGN transfer/fee policy kept separate from FIFO. */
  realizedAccounting?: KolTokenRealizedAccounting;
  coverage: {
    source: 'indexed'; indexedTradeCount: number; returnedTradeCount: number;
    /** Complete indexed history, not a claim that every on-chain movement is indexed. */
    complete: boolean; historyLimit: number; costsIncluded: false;
  };
  generatedAt: string;
}

export interface KolTokenRealizedAccounting {
  version: 1;
  source: 'gmgn';
  policy: 'gmgn_realized_profit_v1';
  walletAddress: string;
  tokenAddress: string;
  status: 'ready' | 'pending' | 'unavailable';
  checkedAt: string;
  realizedProfitUsd: string | null;
  coverage: { transactionsComplete: boolean; balanceMatched: boolean; reason?: string };
  retryAfterMs?: number;
}

/** Accounting snapshots include transfers without representing them as swaps. */
export interface InventoryEvent {
  id: string;
  kind: 'buy' | 'sell' | 'transfer_in' | 'transfer_out';
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
  priceUsd: string | null; marketCapUsd: string | null; timestamp: string;
  source: string; blockNumber: string | null; transactionIndex: number | null;
  valuationStatus: 'valued' | 'unpriced' | 'shared_quote' | 'invalid_quantity';
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
