import type { ChartRange, MarketCandle, TokenChart, WatchPricePoint } from '../../shared/intelligence.js';
import type { ReplayMarketChart } from '../../shared/replayChart.js';
import { GmgnHttpError, type GmgnRequestOptions } from '../gmgnTransport.js';
import { MarketProviderDeferred } from '../providerPriority.js';
import { ChartDiskCache, HISTORICAL_CHART_TTL_MS, RECENT_CHART_TTL_MS } from './cache.js';

export const freshChartIntervals = { '1m': 60, '5m': 300, '1h': 3600, '4h': 14400, '1d': 86400 } as const;
export type FreshResolution = keyof typeof freshChartIntervals;
export type FreshChartWorkload = 'browse' | 'replay';
export const freshChartPeriods = { '24h': 86400_000, '7d': 7 * 86400_000, '30d': 30 * 86400_000 } as const;
/** Periods have calendar durations; interval/lifetime views retain bounded
 * 1,000-bucket cursor pages regardless of the chosen candle resolution. */
export function freshChartFrom(launchedAt: number, to: number, resolution: FreshResolution, options: { period?: string; interval?: string; fullHistory?: boolean }) {
  const period = options.period ?? '24h';
  const duration = !options.interval && !options.fullHistory && Object.hasOwn(freshChartPeriods, period)
    ? freshChartPeriods[period as keyof typeof freshChartPeriods] : freshChartIntervals[resolution] * 1000 * 1000;
  return Math.max(launchedAt, to - duration);
}
export type FreshChartRequest = (url: URL, options: GmgnRequestOptions) => Promise<unknown>;
export type FreshChartQuote = { priceUsd: string | null; supply: string | null; timestamp: string | null; supplyEstimated?: boolean };
type Bar = { time: number; open: string; high: string; low: string; close: string; volumeUsd: string | null };
type Page = { bars: Bar[]; from: number; to: number; observedAt: number; resolution: FreshResolution; volumeKnown: boolean };
type ChartInput = { from: number; to: number; resolution?: FreshResolution; period?: ChartRange;
  workload?: FreshChartWorkload; foreground?: boolean; signal?: AbortSignal; quote?: FreshChartQuote };
export class FreshChartError extends Error {
  constructor(readonly reason: 'provider_cooldown' | 'chart_unavailable' | 'chart_coverage' | 'stale_quote', readonly retryAfterMs = 0) { super(reason); }
}
const textNumber = (value: unknown): string | null => {
  const text = typeof value === 'number' ? String(value) : value;
  return typeof text === 'string' && /^\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(text) && Number.isFinite(Number(text)) ? text : null;
};
const addressOf = (token: string) => { const value = token.toLowerCase(); if (!/^0x[0-9a-f]{40}$/.test(value)) throw new Error('Invalid token address'); return value; };
const resolutionOf = (from: number, to: number) => (Object.keys(freshChartIntervals) as FreshResolution[])
  .find(interval => (to - from) / (freshChartIntervals[interval] * 1000) <= 1500) ?? '1d';

/** GMGN's standard API accepts millisecond from/to, as does its official CLI
 * client. Response timestamps can be seconds or milliseconds. The live
 * standard API reports USD in `volume` and token units in `amount`; the
 * calibration fixture proves volume/amount equals the token's USD price.
 * The bundled skill has contradictory descriptions, so it is not a schema. */
export function normalizeFreshCandles(response: unknown, from: number, to: number, resolution: FreshResolution, now: number): Page {
  const body = (response as { data?: unknown })?.data ?? response;
  const rows = Array.isArray(body) ? body : (body as { list?: unknown })?.list;
  if (!Array.isArray(rows) || rows.length > 1000) throw new FreshChartError('chart_unavailable');
  const bars = new Map<number, Bar>();
  let volumeKnown = true;
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new FreshChartError('chart_unavailable');
    const raw = row as Record<string, unknown>, input = Number(raw.time), ms = input >= 1e12 ? input : input * 1000;
    const open = textNumber(raw.open), high = textNumber(raw.high), low = textNumber(raw.low), close = textNumber(raw.close);
    const volumeUsd = textNumber(raw.volume);
    if (!Number.isSafeInteger(ms) || ms < from || ms > to || ms > now || !open || !high || !low || !close
      || Math.min(...[open, high, low, close].map(Number)) <= 0 || Number(high) < Math.max(Number(open), Number(close))
      || Number(low) > Math.min(Number(open), Number(close)) || Number(low) > Number(high)) throw new FreshChartError('chart_unavailable');
    const bar: Bar = { time: ms / 1000, open, high, low, close, volumeUsd };
    const prior = bars.get(bar.time);
    if (prior && JSON.stringify(prior) !== JSON.stringify(bar)) throw new FreshChartError('chart_unavailable');
    bars.set(bar.time, bar); if (volumeUsd === null) volumeKnown = false;
  }
  return { bars: [...bars.values()].sort((a, b) => a.time - b.time), from, to, observedAt: now, resolution, volumeKnown };
}

function chartPoints(bars: Bar[], seconds: number, until: number): WatchPricePoint[] {
  const points = new Map<number, WatchPricePoint>();
  for (const bar of bars) {
    const first = bar.time * 1000, end = first + seconds * 1000;
    points.set(first, { timestamp: new Date(first).toISOString(), priceUsd: bar.open });
    // A still-forming candle has no observed closing time. Its close is shown
    // in candlesticks but never assigned an invented future sample timestamp.
    if (end <= until) points.set(end, { timestamp: new Date(end).toISOString(), priceUsd: bar.close });
  }
  return [...points.entries()].sort(([a], [b]) => a - b).map(([, point]) => point);
}
function providerError(error: unknown): never {
  if (error instanceof MarketProviderDeferred) throw new FreshChartError(error.reason === 'rate_limited' ? 'provider_cooldown' : 'chart_coverage', error.retryAfterMs);
  if (error instanceof GmgnHttpError) throw new FreshChartError(error.status === 401 || error.status === 403 || error.status === 429 ? 'provider_cooldown' : 'chart_coverage', error.retryAfterMs ?? 5000);
  if (error instanceof FreshChartError || error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name)) throw error;
  throw new FreshChartError('chart_coverage', 5000);
}

export function createFreshCharts({ cache, request, now = Date.now }: { cache: ChartDiskCache; request: FreshChartRequest; now?: () => number }) {
  const metrics = { pageRequests: 0, pageCacheHits: 0, providerPageRequests: 0, providerDurationMs: 0, cacheFailures: 0, providerFailures: 0 };
  async function page(token: string, resolution: FreshResolution, from: number, to: number, options: ChartInput): Promise<Page> {
    metrics.pageRequests++;
    const key = JSON.stringify(['gmgn-candles-v2-volume-usd', token, resolution, from, to]);
    const cached = await cache.get<Page>(key).catch(() => { metrics.cacheFailures++; return null; });
    if (cached) { metrics.pageCacheHits++; return cached.value; }
    options.signal?.throwIfAborted();
    const url = new URL('https://openapi.gmgn.ai/v1/market/token_kline');
    for (const [key, value] of Object.entries({ chain: 'bsc', address: token, resolution, from: String(from), to: String(to), limit: '1000' })) url.searchParams.set(key, value);
    try {
      const startedAt = now(); metrics.providerPageRequests++;
      const response = await request(url, { workload: options.workload ?? 'browse', foreground: options.foreground ?? true,
        priority: options.foreground === false ? 'prefetch' : 'chart', signal: options.signal, timeoutMs: 8000, weight: 2 });
      metrics.providerDurationMs += Math.max(0, now() - startedAt);
      const observedAt = now(), result = normalizeFreshCandles(response, from, to, resolution, observedAt);
      // Every page asks for at most 500 possible buckets, safely below the
      // provider's 1,000-row ceiling. Empty intervals remain genuine gaps.
      const historical = to + freshChartIntervals[resolution] * 2000 <= observedAt;
      await cache.put(key, result, historical ? HISTORICAL_CHART_TTL_MS : RECENT_CHART_TTL_MS, observedAt).catch(() => { metrics.cacheFailures++; });
      return result;
    } catch (error) { metrics.providerFailures++; options.signal?.throwIfAborted(); return providerError(error); }
  }
  async function load(tokenInput: string, options: ChartInput): Promise<{ chart: TokenChart; bars: Bar[] }> {
    const token = addressOf(tokenInput), { from, to } = options;
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to < from || to > now() + 1000) throw new Error('Invalid chart window');
    const resolution = options.resolution ?? resolutionOf(from, to), seconds = freshChartIntervals[resolution];
    if (!seconds || (to - from) / (seconds * 1000) > 2000) throw new FreshChartError('chart_coverage');
    const span = 500 * seconds * 1000, first = Math.floor(from / span) * span;
    const pages: Page[] = [];
    // At most five aligned pages even if the selected window straddles a page.
    for (let begin = first; begin <= to; begin += span) {
      if (pages.length >= 5) throw new FreshChartError('chart_coverage');
      // Stable recent bounds allow all callers within 15 seconds to join.
      const requestedEnd = Math.min(begin + span - 1, Math.ceil(to / 15_000) * 15_000, Math.floor(now() / 15_000) * 15_000);
      pages.push(await page(token, resolution, begin, requestedEnd, options));
    }
    const all = new Map<number, Bar>();
    for (const page of pages) for (const bar of page.bars) if (bar.time * 1000 + seconds * 1000 >= from && bar.time * 1000 <= to) all.set(bar.time, bar);
    const bars = [...all.values()].sort((a, b) => a.time - b.time), quote = options.quote;
    const candles: MarketCandle[] = bars.map(bar => ({ time: bar.time, open: Number(bar.open), high: Number(bar.high), low: Number(bar.low), close: Number(bar.close), volume: Number(bar.volumeUsd ?? 0) }));
    const complete = pages.length > 0, observedAt = Math.max(...pages.map(page => page.observedAt));
    return { bars, chart: { address: token, period: options.period ?? resolution, candles, points: chartPoints(bars, seconds, Math.min(to, now())),
      source: bars.length ? 'gmgn' : 'unavailable', resolution, pending: false, stale: false, updatedAt: new Date(observedAt).toISOString(),
      marketCapSupply: quote?.supply ?? null, marketCapEstimated: quote?.supplyEstimated ?? true,
      supplyCheckedAt: quote?.timestamp ?? null, supplyPending: !quote?.supply,
      ...(quote?.priceUsd && quote.timestamp ? { currentQuote: { priceUsd: quote.priceUsd, timestamp: quote.timestamp } } : {}),
      volumeCurrency: pages.every(page => page.volumeKnown) ? 'usd' : 'unknown',
      partialHistory: !complete, fullHistory: complete, historyComplete: complete,
      ...(!bars.length ? { loadStatus: 'no_history' as const } : {}) } };
  }
  return {
    async chart(token: string, options: ChartInput) { return (await load(token, options)).chart; },
    async replayChart(token: string, options: { from: number; to: number; open: boolean; supply: string | null;
      ending?: { timestamp: string; priceUsd: string }; signal?: AbortSignal; foreground?: boolean }): Promise<ReplayMarketChart> {
      const interval = resolutionOf(options.from, options.to), seconds = freshChartIntervals[interval];
      const quoteAt = options.ending ? Date.parse(options.ending.timestamp) : null;
      if (options.open && (!options.ending || quoteAt === null || !Number.isFinite(quoteAt) || now() - quoteAt > 120_000 || quoteAt > now() + 1000 || quoteAt < options.to)) throw new FreshChartError('stale_quote', 2000);
      const completedTo = options.open ? Math.max(options.from, Math.floor(options.to / 60_000) * 60_000)
        : Math.min(now(), (Math.floor(options.to / (seconds * 1000)) + 1) * seconds * 1000);
      // Fine candles replace this whole tail. Do not spend another provider
      // request on coarse candles which will be discarded. Pin the seam to an
      // hour so quote refreshes reuse the completed historical pages.
      const recentFrom = seconds > 60 ? Math.max(options.from, Math.floor(completedTo / 3600_000) * 3600_000 - 6 * 3600_000) : null;
      const { chart, bars } = await load(token, { from: options.from, to: recentFrom ?? completedTo, resolution: interval, workload: 'replay', signal: options.signal, foreground: options.foreground ?? true });
      let points = chart.points;
      let recent: TokenChart | undefined;
      if (recentFrom !== null) {
        recent = (await load(token, { from: recentFrom, to: completedTo, resolution: '1m', workload: 'replay', signal: options.signal, foreground: options.foreground ?? true })).chart;
        const start = recentFrom;
        points = [...points.filter(point => Date.parse(point.timestamp) < start), ...recent.points];
      }
      points = [...new Map(points.map(point => [point.timestamp, point])).values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
      const firstAt = Date.parse(points[0]?.timestamp ?? ''), lastAt = Date.parse(points.at(-1)?.timestamp ?? '');
      // Sparse candles are retained with real timestamps. A fresh node quote
      // can bridge only a short recent ending, never months of absent history.
      const waitingForFirstBar = now() - (options.open ? options.from : options.to) < 60_000;
      const missing = () => new FreshChartError(waitingForFirstBar ? 'chart_coverage' : 'chart_unavailable', waitingForFirstBar ? 3000 : 0);
      if (!points.length || firstAt > options.from || !Number.isFinite(firstAt) || !Number.isFinite(lastAt)
        || lastAt < options.to - (options.open ? 180_000 : 0)) throw missing();
      if (options.open && options.ending) {
        points = [...points.filter(point => Date.parse(point.timestamp) < quoteAt!), options.ending];
      }
      if (points.length < 2) throw missing();
      const sparseHistory = bars.some((bar, index) => index > 0 && bar.time - bars[index - 1].time > seconds)
        || !!recent?.candles.some((bar, index, rows) => index > 0 && bar.time - rows[index - 1].time > 60);
      return { ...chart, period: 'replay', source: 'gmgn', points, marketCapSupply: options.supply, supplyPending: !options.supply,
        sparseHistory, partialHistory: false, historyComplete: true, fullHistory: true,
        ...(recent ? { recentResolution: '1m', recentSource: 'gmgn' } : {}),
        ...(options.ending ? { currentQuote: options.ending } : {}) };
    },
    diagnostics: async () => ({ ...await cache.statistics(), ...metrics }),
  };
}
export type FreshCharts = ReturnType<typeof createFreshCharts>;
