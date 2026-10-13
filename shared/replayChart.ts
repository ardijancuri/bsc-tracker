import type { TokenChart } from './intelligence.js';

/** Historical market samples for one replay; normal candle-chart intervals are unchanged. */
export type ReplayMarketChart = Omit<TokenChart, 'source' | 'period'> & {
  source: 'gmgn' | 'geckoterminal' | 'unavailable';
  period: 'replay';
  /** Real observed bars bracket the replay, with unobserved intervals between them. */
  sparseHistory?: boolean;
};
