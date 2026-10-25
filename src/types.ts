export type TradeSide = 'buy' | 'sell' | 'swap' | 'unknown';

export interface Kol {
  creator?: { claimed: boolean; walletControlVerified: boolean; bio: string | null; websiteUrl: string | null; xUrl: string | null; telegramUrl: string | null; updatedAt: string | null };
  address: string;
  name: string | null;
  avatarUrl: string | null;
  twitter: string | null;
  source: string;
  lastSeenAt: string | null;
}

export interface Trade {
  id: string;
  txHash: string;
  walletAddress: string;
  kolName: string | null;
  kolAvatarUrl: string | null;
  kolTwitter: string | null;
  tokenAddress: string;
  tokenSymbol: string | null;
  tokenName: string | null;
  tokenLogoUrl: string | null;
  side: TradeSide;
  tokenAmount: string | null;
  accountingStatus?: 'ready' | 'pending_precision' | 'pending_settlement';
  accountingReason?: string;
  quoteSymbol: string | null;
  quoteTokenAddress?: string | null;
  quoteAmount: string | null;
  bnbEquivalentAmount?: string | null;
  amountUsd: string | null;
  priceUsd: string | null;
  timestamp: string;
  source: string;
  blockNumber: string | null;
}

export interface Token {
  accountingSummary?: import('../shared/nodeAccounting').NodeAccountingSummary;
  address: string;
  symbol: string | null;
  name: string | null;
  logoUrl: string | null;
  priceUsd: string | null;
  marketCapUsd: string | null;
  /** Current node valuation state, independent of position accounting. */
  valuationStatus?: string;
  change24h: string | null;
  kolCount24h: number;
  buys24h: number;
  sells24h: number;
  volume24hUsd: string | null;
  lastTradeAt: string | null;
}

export interface LeaderboardRow extends Kol {
  /** Complete rolling-24-hour realized P&L only. Incomplete/inactive rows are unranked. */
  rank?: number | null;
  period?: '24h';
  windowStart?: string | null;
  windowEnd?: string | null;
  accounting?: import('../shared/nodeLeaderboard').NodeLeaderboardSnapshot | null;
  knownRealizedProfitUsd?: string | null;
  realizedProfitUsd: string | null;
  unrealizedProfitUsd: string | null;
  updatedAt: string | null;
  tradeCount24h: number;
  buyCount24h: number;
  sellCount24h: number;
  unpricedSellCount24h: number;
  valuedSellCount: number | null;
  excludedSellCount: number | null;
}

export interface LeaderboardResponse {
  items: LeaderboardRow[];
  period?: '24h';
  windowStart?: string | null;
  windowEnd?: string | null;
}

export interface Overview {
  trackingBoundary?: { block_number: string; block_hash: string; value: { startTime: string } } | null;
  utcDay?: string;
  trackedKols: number;
  trades24h: number;
  tokens24h: number;
  latestTradeAt: string | null;
  lastTokenPriceAt: string | null;
  lastNodeBlock: string | null;
  nodeLagBlocks: number | null;
  lastNodeAt: string | null;
  bnbPriceUsd: number | null;
  bnbPriceAt: string | null;
  lastLeaderboardAt: string | null;
  leaderboardSource: 'node_fifo';
}
