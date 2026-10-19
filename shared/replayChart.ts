import type { TokenChart } from './intelligence.js';

/** Historical market samples for one replay; normal candle-chart intervals are unchanged. */
export type ReplayMarketChart = Omit<TokenChart, 'source' | 'period'> & {
  source: 'gmgn' | 'geckoterminal' | 'coinmarketcap' | 'unavailable' | 'node' | 'mixed' | 'imported';
  period: 'replay';
  snapshotId?: string;
  windowId?: string;
  /** Real observed bars bracket the replay, with unobserved intervals between them. */
  sparseHistory?: boolean;
  /** Fine observations at the ending of a longer historical series. */
  recentResolution?: '1m';
  recentSource?: 'gmgn' | 'geckoterminal' | 'coinmarketcap' | 'node' | 'mixed' | 'imported';
  /** Separate fresh observed quote; it is not a completed historical candle. */
  currentQuote?: { timestamp: string; priceUsd: string };
};
