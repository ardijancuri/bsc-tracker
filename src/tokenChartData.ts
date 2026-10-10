import type { MarketCandle, TokenChart } from '../shared/intelligence';

// All OHLC values use current on-chain token supply; USD volume stays unchanged.
export function marketCapCandles(candles: MarketCandle[], supply: string | null | undefined): MarketCandle[] {
  const units = Number(supply);
  if (!Number.isFinite(units) || units <= 0) return [];
  return candles.map(c => ({ ...c, open: c.open * units, high: c.high * units, low: c.low * units, close: c.close * units }))
    .filter(c => [c.open, c.high, c.low, c.close].every(value => Number.isFinite(value) && value > 0));
}

export function marketChartChanges(chart: TokenChart | null | undefined, now = Date.now()) {
  if (chart?.source !== 'geckoterminal' || !chart.candles.length) return null;
  const candles = chart.candles, last = candles.at(-1)!;
  const baseline = [...candles].reverse().find(c => c.time <= now / 1000 - 3600);
  const change = (before: number) => String((last.close / before - 1) * 100);
  return { periodChange: change(candles[0].open), change1h: baseline ? change(baseline.close) : null };
}
