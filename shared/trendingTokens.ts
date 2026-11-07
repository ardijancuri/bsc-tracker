export const trendingWindows = { '5m': 5, '15m': 15, '30m': 30, '1h': 60, '6h': 360, '24h': 1440 } as const;
export type TrendingWindow = keyof typeof trendingWindows;
export const defaultTrendingWindow: TrendingWindow = '6h';
export const isTrendingWindow = (value: unknown): value is TrendingWindow =>
  typeof value === 'string' && Object.hasOwn(trendingWindows, value);

export interface TrendingToken {
  address: string;
  name: string | null;
  symbol: string | null;
  logoUrl: string | null;
  marketCapUsd: string | null;
  // USD subtotal of the valued public KOL buys and sells in the selected window.
  volumeUsd: string | null;
  volumeIncomplete: boolean;
  kolCount: number;
  buyCount: number;
  sellCount: number;
  recentKols: string[];
}

export interface TrendingTokens {
  window: TrendingWindow;
  asOf: string;
  items: TrendingToken[];
}
