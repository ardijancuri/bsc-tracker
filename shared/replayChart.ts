import type { TokenChart } from './intelligence.js';

/** Historical market samples for one replay; normal candle-chart intervals are unchanged. */
export type ReplayMarketChart = Omit<TokenChart, 'source' | 'period'> & {
  source: 'gmgn' | 'geckoterminal' | 'unavailable';
  period: 'replay';
  /** Real observed bars bracket the replay, with unobserved intervals between them. */
  sparseHistory?: boolean;
  /** Separate fresh observed quote; it is not a completed historical candle. */
  currentQuote?: { timestamp: string; priceUsd: string };
};
