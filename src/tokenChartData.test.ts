import { describe, expect, it } from 'vitest';
import { marketCapCandles, marketChartChanges } from './tokenChartData';
import type { TokenChart } from '../shared/intelligence';
const chart: TokenChart = { address: '0x123', period: '24h', source: 'geckoterminal', candles: [
  { time: 100, open: 10, high: 12, low: 9, close: 12, volume: 1 },
  { time: 3700, open: 12, high: 15, low: 11, close: 15, volume: 1 },
], points: [], resolution: '5m', pending: false, stale: false, updatedAt: null };
describe('market chart changes', () => {
  it('converts all candle and hover values to market cap while retaining USD volume', () => {
    expect(marketCapCandles(chart.candles, '1000000')[0]).toEqual({ time: 100, open: 10000000, high: 12000000, low: 9000000, close: 12000000, volume: 1 });
    expect(chart.candles[0].close).toBe(12);
  });
  it('does not display price as market cap when supply is unknown or invalid', () => {
    for (const supply of [undefined, null, '', '0', '-1', 'NaN', 'Infinity']) expect(marketCapCandles(chart.candles, supply)).toEqual([]);
    expect(marketCapCandles(chart.candles, '1e308')).toEqual([]);
  });
  it('uses market prices rather than the last KOL transaction for change columns', () => {
    const result = marketChartChanges(chart, 3700_000);
    expect(Number(result?.periodChange)).toBeCloseTo(50);
    expect(Number(result?.change1h)).toBeCloseTo(25);
  });
  it('does not claim an hourly return without an hour of market history', () => {
    expect(marketChartChanges({ ...chart, candles: [chart.candles[1]] }, 3700_000)?.change1h).toBeNull();
  });
  it('does not fabricate market returns from a fallback quote or missing data', () => {
    expect(marketChartChanges({ ...chart, source: 'quote' })).toBeNull();
    expect(marketChartChanges(null)).toBeNull();
  });
});
