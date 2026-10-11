/** One KOL's indexed activity for one exact token contract, without a 24h cutoff. */
export interface KolTokenActivity {
  kol: { address: string; name: string | null; avatarUrl: string | null; twitter: string | null; source: string; lastSeenAt: string | null };
  token: {
    address: string; symbol: string | null; name: string | null; logoUrl: string | null;
    priceUsd: string | null; marketCapUsd: string | null; marketCapSupply: string | null;
  };
  trades: KolTokenTrade[];
  summary: KolTokenTradeSummary;
  coverage: {
    source: 'indexed'; indexedTradeCount: number; returnedTradeCount: number;
    /** Complete indexed history, not a claim that every on-chain movement is indexed. */
    complete: boolean; historyLimit: number; costsIncluded: false;
  };
  generatedAt: string;
}

export interface KolTokenTrade {
  id: string; txHash: string; walletAddress: string; tokenAddress: string;
  kolName: string | null; kolAvatarUrl: string | null; kolTwitter: string | null;
  tokenSymbol: string | null; tokenName: string | null; tokenLogoUrl: string | null;
  side: 'buy' | 'sell' | 'swap' | 'unknown'; tokenAmount: string | null;
  quoteSymbol: string | null; quoteAmount: string | null; amountUsd: string | null;
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
  /** These are recorded trade lots, not a verified current wallet balance. */
  remainingTokenAmount: string | null; remainingCostBasisUsd: string | null;
  buyCount: number; sellCount: number; valuedBuyCount: number; valuedSellCount: number;
  excludedSellCount: number; unpricedTradeCount: number;
  firstTradeAt: string | null; lastTradeAt: string | null;
  status: 'open' | 'closed' | 'unknown'; profitBasis: 'observed_fifo';
}
