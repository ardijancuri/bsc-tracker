import type { CandleInterval, MarketCandle } from '../shared/intelligence';
import { marketCapCandles } from './tokenChartData';

export interface AreaPoint { time: number; value: number; volume: number }
export interface ChartWindow { from: number; to: number }
export const intervalSeconds: Record<CandleInterval, number> = { '5m': 300, '1h': 3600, '4h': 14400, '1d': 86400 };

// Plot real candle closes against their timestamps. Do not turn recorded KOL
// fills into a continuous market history, or manufacture prices for gaps.
export function marketCapLinePoints(candles: MarketCandle[], supply: string | null | undefined): AreaPoint[] {
  const unique = new Map<number, AreaPoint>();
  for (const candle of marketCapCandles(candles, supply)) {
    if (!Number.isFinite(candle.time) || candle.time <= 0) continue;
    unique.set(candle.time, { time: candle.time, value: candle.close, volume: Number.isFinite(candle.volume) && candle.volume >= 0 ? candle.volume : 0 });
  }
  return [...unique.values()].sort((a, b) => a.time - b.time);
}

export function fullChartWindow(points: AreaPoint[], interval: CandleInterval): ChartWindow {
  const first = points[0]?.time ?? 0;
  return { from: first, to: Math.max(first + intervalSeconds[interval], points.at(-1)?.time ?? first) };
}

export function constrainChartWindow(window: ChartWindow, full: ChartWindow, minimumSpan = 1): ChartWindow {
  const fullSpan = Math.max(1, full.to - full.from);
  const span = Math.min(fullSpan, Math.max(Math.min(minimumSpan, fullSpan), window.to - window.from));
  const from = Math.max(full.from, Math.min(full.to - span, window.from));
  return { from, to: from + span };
}

export function nearestAreaPoint(points: AreaPoint[], time: number): AreaPoint | null {
  if (!points.length) return null;
  let low = 0, high = points.length - 1;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (points[middle].time < time) low = middle + 1; else high = middle;
  }
  const previous = points[Math.max(0, low - 1)], next = points[low];
  return Math.abs(previous.time - time) <= Math.abs(next.time - time) ? previous : next;
}

export function marketCapAxis(points: AreaPoint[]) {
  const values = points.map(point => point.value);
  const low = values.length ? Math.min(...values) : 0;
  const high = values.length ? Math.max(...values) : 1;
  const padding = Math.max((high - low) * .12, high * .025, .000001);
  const minimum = Math.max(0, low - padding), maximum = high + padding;
  const rawStep = (maximum - minimum) / 4;
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const fraction = rawStep / magnitude;
  const step = (fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 2.5 ? 2.5 : fraction <= 5 ? 5 : 10) * magnitude;
  const min = Math.floor(minimum / step) * step, max = Math.ceil(maximum / step) * step;
  const ticks: number[] = [];
  for (let value = min; value <= max + step * .01; value += step) ticks.push(value);
  return { min, max, ticks };
}

export function areaChartPaths(points: AreaPoint[], x: (time: number) => number, y: (value: number) => number, baseline: number) {
  if (!points.length) return { line: '', area: '' };
  const coordinate = (value: number) => String(Math.round(value * 100) / 100);
  const line = points.map((point, index) => `${index ? 'L' : 'M'}${coordinate(x(point.time))},${coordinate(y(point.value))}`).join(' ');
  return { line, area: `${line} L${coordinate(x(points.at(-1)!.time))},${coordinate(baseline)} L${coordinate(x(points[0].time))},${coordinate(baseline)} Z` };
}
