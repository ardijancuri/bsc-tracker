import type { MarketCandle, TokenChart } from '../shared/intelligence';

// All OHLC values use current on-chain token supply; USD volume stays unchanged.
export function marketCapCandles(candles: MarketCandle[], supply: string | null | undefined): MarketCandle[] {
  const units = Number(supply);
  if (!Number.isFinite(units) || units <= 0) return [];
  // Lightweight Charts requires unique, strictly ascending timestamps and valid
  // OHLC bars. Keep the latest update for a bucket if a provider repeats it.
  const byTime = new Map<number, MarketCandle>();
  for (const candle of candles) {
    const c = { ...candle, open: candle.open * units, high: candle.high * units, low: candle.low * units, close: candle.close * units };
    if (!Number.isSafeInteger(c.time) || c.time <= 0 || ![c.open, c.high, c.low, c.close].every(value => Number.isFinite(value) && value > 0)) continue;
    if (c.high < Math.max(c.open, c.close) || c.low > Math.min(c.open, c.close)) continue;
    byTime.set(c.time, c);
  }
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

export function marketChartChanges(chart: TokenChart | null | undefined, now = Date.now()) {
  if (!chart || !['geckoterminal', 'gmgn', 'coinmarketcap'].includes(chart.source) || !chart.candles.length) return null;
  const candles = chart.candles, last = candles.at(-1)!;
  const baseline = [...candles].reverse().find(c => c.time <= now / 1000 - 3600);
  const change = (before: number) => String((last.close / before - 1) * 100);
  return { periodChange: change(candles[0].open), change1h: baseline ? change(baseline.close) : null };
}
