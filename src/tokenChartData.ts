import type { TokenChart } from '../shared/intelligence';

export function marketChartChanges(chart: TokenChart | null | undefined, now = Date.now()) {
  if (chart?.source !== 'geckoterminal' || !chart.candles.length) return null;
  const candles = chart.candles, last = candles.at(-1)!;
  const baseline = [...candles].reverse().find(c => c.time <= now / 1000 - 3600);
  const change = (before: number) => String((last.close / before - 1) * 100);
  return { periodChange: change(candles[0].open), change1h: baseline ? change(baseline.close) : null };
}
