export type TradeSide = 'buy' | 'sell' | 'swap' | 'unknown';

export interface Kol {
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
  quoteSymbol: string | null;
  quoteAmount: string | null;
  amountUsd: string | null;
  priceUsd: string | null;
  timestamp: string;
  source: string;
  blockNumber: string | null;
}

export interface Token {
  address: string;
  symbol: string | null;
  name: string | null;
  logoUrl: string | null;
  priceUsd: string | null;
  marketCapUsd: string | null;
  change24h: string | null;
  kolCount24h: number;
  buys24h: number;
  sells24h: number;
  volume24hUsd: string | null;
  lastTradeAt: string | null;
}

export interface LeaderboardRow extends Kol {
  realizedProfitUsd: string | null;
  unrealizedProfitUsd: string | null;
  updatedAt: string | null;
}

export interface Overview {
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
  leaderboardSource: 'gmgn' | 'onchain_estimate';
}
