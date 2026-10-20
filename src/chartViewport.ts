import type { CandleInterval, MarketCandle } from '../shared/intelligence';

export type CandleViewport = { from: number; to: number };

const intervalSeconds: Record<CandleInterval, number> = { '1m': 60, '5m': 300, '1h': 3600, '4h': 14400, '1d': 86400 };
export type CandleObservationGap = { index: number; from: number; to: number };

/** A gap describes absent observations, not proof that the market was inactive.
 * Keep real bars unchanged; missing intervals must never become synthetic OHLC. */
export function majorCandleGaps(candles: MarketCandle[], interval: CandleInterval): CandleObservationGap[] {
  const step = intervalSeconds[interval];
  const threshold = Math.max(3600, step * 10);
  const gaps: CandleObservationGap[] = [];
  for (let index = 1; index < candles.length; index++) {
    if (candles[index].time - candles[index - 1].time >= threshold) {
      gaps.push({ index, from: candles[index - 1].time + step, to: candles[index].time });
    }
  }
  return gaps;
}

/** Avoid combining a useful recent segment with a much older disconnected one
 * merely to fill the initial viewport. All earlier observations remain pannable. */
export function latestSubstantialSegmentStart(candles: MarketCandle[], interval: CandleInterval) {
  const gap = majorCandleGaps(candles, interval).at(-1);
  return gap && candles.length - gap.index >= 40 ? gap.index : 0;
}

export function readableCandleSlots(plotWidth: number) {
  const width = Number.isFinite(plotWidth) && plotWidth > 0 ? plotWidth : 480;
  return { minimum: Math.max(40, Math.ceil(width / 12)), maximum: Math.max(40, Math.floor(width / 7)) };
}

/** Rebase logical coordinates onto the same observed times after a backfill.
 * Index-only restoration would silently pan to earlier data when rows prepend. */
export function remapChartViewport(previous: MarketCandle[], next: MarketCandle[], range: CandleViewport | null, followLatest = false): CandleViewport | null {
  if (!range || !previous.length || !next.length) return null;
  const indexForTime = (time: number) => {
    let lo = 0, hi = next.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (next[mid].time === time) return mid;
      if (next[mid].time < time) lo = mid + 1; else hi = mid - 1;
    }
    if (hi < 0) return 0;
    if (lo >= next.length) return next.length - 1;
    return hi + (time - next[hi].time) / (next[lo].time - next[hi].time);
  };
  const rebase = (index: number) => {
    if (index <= 0) return indexForTime(previous[0].time) + index;
    const last = previous.length - 1;
    if (index >= last) return indexForTime(previous[last].time) + index - last;
    const left = Math.floor(index), fraction = index - left;
    return indexForTime(previous[left].time + (previous[left + 1].time - previous[left].time) * fraction);
  };
  // An untouched recent view follows new live bars, while historical pages do
  // not change its visible time window. A user pan always keeps its anchors.
  if (followLatest && range.to >= previous.length - 1 && next.at(-1)!.time > previous.at(-1)!.time) {
    const to = next.length - 1 + range.to - (previous.length - 1);
    return { from: to - (range.to - range.from), to };
  }
  const result = { from: rebase(range.from), to: rebase(range.to) };
  // A replaced window may no longer contain either anchor. Leave initial
  // fitting to the caller instead of collapsing a chart to a zero-width range.
  return result.to > result.from ? result : null;
}

export function formatChartPrice(value: number, marketCap: boolean, locale: string, significantDigits = 5) {
  return new Intl.NumberFormat(locale, {
    style: 'currency', currency: 'USD', notation: marketCap ? 'compact' : 'standard',
    minimumFractionDigits: 0, maximumSignificantDigits: significantDigits,
  }).format(value);
}

/** Tick precision follows the actual scale, including when a user zooms in.
 * Fixed one-decimal compact labels turn $1.02M and $1.04M into the same $1M. */
export function chartPriceTickmarks(values: number[], marketCap: boolean, locale: string) {
  const distinct = [...new Set(values)];
  let digits = 3;
  for (; digits < 12; digits++) {
    if (new Set(distinct.map(value => formatChartPrice(value, marketCap, locale, digits))).size === distinct.length) break;
  }
  return values.map(value => formatChartPrice(value, marketCap, locale, digits));
}
