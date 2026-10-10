import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import type { MarketCandle, TokenChart, ChartRange } from '../shared/intelligence.js';
import { geckoFetch, MarketProviderDeferred, type GeckoPriority } from './geckoApi.js';

export const chartWindows = {
  '24h': { seconds: 86400, timeframe: 'minute', aggregate: 5, resolution: '5m', fresh: 120_000 },
  '7d': { seconds: 604800, timeframe: 'hour', aggregate: 1, resolution: '1h', fresh: 300_000 },
  '30d': { seconds: 2592000, timeframe: 'hour', aggregate: 1, resolution: '1h', fresh: 600_000 },
} as const;
export const candleWindows = {
  '1m': { seconds: 60_000, timeframe: 'minute', aggregate: 1, resolution: '1m', fresh: 60_000 },
  '5m': chartWindows['24h'],
  '1h': chartWindows['30d'],
  '4h': { seconds: 7_776_000, timeframe: 'hour', aggregate: 4, resolution: '4h', fresh: 600_000 },
  '1d': { seconds: 15_552_000, timeframe: 'day', aggregate: 1, resolution: '1d', fresh: 900_000 },
} as const;
export function chartSettings(range: ChartRange) { return range in candleWindows ? candleWindows[range as keyof typeof candleWindows] : chartWindows[range as keyof typeof chartWindows]; }
export function chartForRange(chart: TokenChart, range: ChartRange, now = Date.now()): TokenChart {
  const until = Math.floor(now / 1000);
  const candles = chart.candles.filter(c => c.time >= until - chartSettings(range).seconds && c.time <= until);
  return { ...chart, period: range, candles, points: candles.map(c => ({ timestamp: new Date(c.time * 1000).toISOString(), priceUsd: String(c.close) })) };
}
const addressRe = /^0x[0-9a-f]{40}$/;
const poolRe = /^0x(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
type JsonRequest = (url: URL) => Promise<any>;
const resolutionSeconds: Record<string, number> = { '1m': 60, '5m': 300, '1h': 3600, '4h': 14400, '1d': 86400 };

// Combine real finer candles; never split a coarse candle into invented prices.
export function aggregateCandles(candles: MarketCandle[], seconds: number): MarketCandle[] {
  const buckets = new Map<number, MarketCandle>();
  for (const candle of [...candles].sort((a, b) => a.time - b.time)) {
    const time = Math.floor(candle.time / seconds) * seconds;
    const bucket = buckets.get(time);
    if (!bucket) buckets.set(time, { ...candle, time });
    else { bucket.high = Math.max(bucket.high, candle.high); bucket.low = Math.min(bucket.low, candle.low); bucket.close = candle.close; bucket.volume += candle.volume; }
  }
  const result = [...buckets.values()];
  // A truncated history may begin halfway through a closed bucket. Omit that
  // bucket rather than presenting an incomplete historical open/high/low.
  if (result.length > 1 && Math.min(...candles.map(c => c.time)) > result[0].time) result.shift();
  return result;
}

export function parseCandles(rows: unknown, since: number, until: number): MarketCandle[] {
  if (!Array.isArray(rows)) return [];
  const candles = new Map<number, MarketCandle>();
  for (const row of rows.slice(0, 1000)) {
    if (!Array.isArray(row) || row.length < 6 || row.slice(0, 6).some(v => v == null || v === '' || typeof v === 'boolean')) continue;
    const [time, open, high, low, close, volume] = row.slice(0, 6).map(Number);
    if (![time, open, high, low, close, volume].every(Number.isFinite) || !Number.isInteger(time) || time < since || time > until ||
      Math.min(open, high, low, close) <= 0 || volume < 0 || low > Math.min(open, close) || high < Math.max(open, close)) continue;
    candles.set(time, { time, open, high, low, close, volume });
  }
  return [...candles.values()].sort((a, b) => a.time - b.time);
}

export function selectChartPools(payload: any, address: string): string[] {
  const pools = Array.isArray(payload?.data) ? payload.data : [];
  const match = pools.filter((p: any) => {
    const tokens = [p?.relationships?.base_token?.data?.id, p?.relationships?.quote_token?.data?.id];
    return poolRe.test(p?.attributes?.address || '') && tokens.includes(`bsc_${address}`);
  }).sort((a: any, b: any) => (Number(b.attributes.reserve_in_usd) || 0) - (Number(a.attributes.reserve_in_usd) || 0));
  return [...new Set<string>(match.map((p: any) => p.attributes.address))].slice(0, 3);
}
export function selectChartPool(payload: any, address: string): string | null { return selectChartPools(payload, address)[0] ?? null; }

// Public API budget is shared across all users. Coalesce identical jobs and keep
// cached data visible while queued refreshes run; never turn missing data into candles.
type RequestPriority = GeckoPriority | (() => GeckoPriority);
const upstream = new Map<string, { promise: Promise<any>; priorities: RequestPriority[] }>();
const discoveries = new Map<string, { value: any; checked: number }>();
function providerRequest(url: URL, priority: RequestPriority = 'chart'): Promise<any> {
  const key = url.href;
  const discovery = url.pathname.endsWith('/pools');
  const saved = discovery ? discoveries.get(key) : undefined;
  if (saved && Date.now() - saved.checked < 600_000) return Promise.resolve(saved.value);
  const existing = upstream.get(key);
  if (existing) { existing.priorities.push(priority); return existing.promise; }
  const priorities = [priority];
  const promise = (async () => {
    const response = await geckoFetch(url, { priority: () => priorities.some(value => (typeof value === 'function' ? value() : value) === 'chart') ? 'chart' : 'sparkline', timeoutMs: 10_000 });
    if (!response.ok) throw new Error(`Market chart request failed: ${response.status}`);
    const value = await response.json();
    if (discovery) {
      if (discoveries.size >= 500) discoveries.delete(discoveries.keys().next().value!);
      discoveries.set(key, { value, checked: Date.now() });
    }
    return value;
  })().finally(() => upstream.delete(key));
  upstream.set(key, { promise, priorities });
  return promise;
}

export async function fetchMarketCandles(address: string, period: ChartRange, poolAddress: string | undefined, request: JsonRequest = providerRequest, now = Date.now()): Promise<TokenChart | null> {
  if (!addressRe.test(address) || poolAddress && !poolRe.test(poolAddress)) throw new Error('Invalid chart address');
  const settings = chartSettings(period);
  const pools = poolAddress ? [poolAddress] : selectChartPools(await request(new URL(`https://api.geckoterminal.com/api/v2/networks/bsc/tokens/${address}/pools`)), address);
  for (const pool of pools) {
    const url = new URL(`https://api.geckoterminal.com/api/v2/networks/bsc/pools/${pool}/ohlcv/${settings.timeframe}`);
    url.searchParams.set('aggregate', String(settings.aggregate));
    url.searchParams.set('limit', '1000');
    url.searchParams.set('currency', 'usd');
    // A contract address selects the requested token even when it is the quote asset.
    url.searchParams.set('token', address);
    url.searchParams.set('include_empty_intervals', 'true');
    const until = Math.floor(now / 1000);
    let body: any;
    try { body = await request(url); }
    catch (error) {
      if (poolAddress || !(error instanceof Error) || !/request failed: (404|422)$/.test(error.message)) throw error;
      continue;
    }
    const candles = parseCandles(body?.data?.attributes?.ohlcv_list, until - settings.seconds, until);
    if (!candles.length) continue;
    return { address, period, candles, points: candles.map(c => ({ timestamp: new Date(c.time * 1000).toISOString(), priceUsd: String(c.close) })),
      source: 'geckoterminal', updatedAt: new Date(now).toISOString(), resolution: settings.resolution, poolAddress: pool, pending: false, stale: false };
  }
  return null;
}

const cache = new Map<string, TokenChart>();
const jobs = new Map<string, Promise<TokenChart | null>>();
const priorities = new Map<string, GeckoPriority>();
const retryAt = new Map<string, { at: number; status: NonNullable<TokenChart['loadStatus']> }>();
const cacheDirectory = process.env.TOKEN_CHART_CACHE_DIR || path.join(process.cwd(), '.cache', 'token-charts');
function finerCachedChart(address: string, range: ChartRange): TokenChart | null {
  const settings = chartSettings(range), step = resolutionSeconds[settings.resolution];
  const candidates = [...cache.values()].filter(c => c.address === address && resolutionSeconds[c.resolution] < step && c.candles.length)
    .sort((a, b) => b.candles.at(-1)!.time - a.candles.at(-1)!.time || Date.parse(b.updatedAt!) - Date.parse(a.updatedAt!));
  const source = candidates[0];
  if (!source) return null;
  const now = Math.floor(Date.now() / 1000);
  const candles = aggregateCandles(source.candles.filter(c => c.time >= now - settings.seconds && c.time <= now), step);
  if (!candles.length) return null;
  return { ...source, period: range, resolution: settings.resolution, candles,
    points: candles.map(c => ({ timestamp: new Date(c.time * 1000).toISOString(), priceUsd: String(c.close) })), stale: true, partialHistory: true };
}
async function loadCached(key: string, address: string, period: ChartRange) {
  if (cache.has(key)) return cache.get(key)!;
  try {
    const raw = await readFile(path.join(cacheDirectory, `${key}.json`), 'utf8');
    if (raw.length > 400_000) return null;
    const value = JSON.parse(raw) as TokenChart;
    if (value.address !== address || value.period !== period || value.source !== 'geckoterminal' || !Number.isFinite(Date.parse(value.updatedAt || ''))) return null;
    const now = Math.floor(Date.now() / 1000);
    if (value.resolution !== chartSettings(period).resolution) return null;
    const candles = parseCandles(value.candles?.map(c => [c.time, c.open, c.high, c.low, c.close, c.volume]), now - chartSettings(period).seconds, now);
    if (!candles.length) return null;
    value.candles = candles;
    value.points = candles.map(c => ({ timestamp: new Date(c.time * 1000).toISOString(), priceUsd: String(c.close) }));
    cache.set(key, value);
    return value;
  } catch { return null; }
}

export async function currentMarketChart(address: string, range: ChartRange): Promise<{ chart: TokenChart | null; pending: boolean; loadStatus?: TokenChart['loadStatus']; retryAfterMs?: number }> {
  // These intervals are identical to existing watchlist requests. Reuse their
  // cache and in-flight jobs rather than spending another provider request.
  const period = range === '5m' ? '24h' : range === '1h' || range === '7d' ? '30d' : range;
  const key = `${address}-${period}`;
  const interactive = range in candleWindows;
  // Promote an existing watchlist job when the user opens its full chart.
  if (interactive && jobs.has(key)) priorities.set(key, 'chart');
  const saved = await loadCached(key, address, period);
  const lifetime = interactive ? chartSettings(period).fresh : Math.max(300_000, chartSettings(period).fresh);
  const fresh = saved && Date.now() - Date.parse(saved.updatedAt!) < lifetime;
  if (fresh) return { chart: chartForRange(saved, range), pending: false };
  let job = jobs.get(key);
  const interactiveJobs = [...priorities.values()].filter(priority => priority === 'chart').length;
  if (!job && Date.now() >= (retryAt.get(key)?.at || 0) && (jobs.size < 32 || interactive && interactiveJobs < 8)) {
    priorities.set(key, interactive ? 'chart' : 'sparkline');
    const request = (url: URL) => providerRequest(url, () => priorities.get(key) ?? 'sparkline');
    const poolAddress = saved?.poolAddress ?? [...cache.values()].find(c => c.address === address)?.poolAddress;
    job = (async () => {
      try {
        let result: TokenChart | null;
        try { result = await fetchMarketCandles(address, period, poolAddress, request); }
        catch (error) {
          // Discovery cannot fix a timeout, 429 or a provider cooldown.
          if (!poolAddress || !(error instanceof Error) || !/request failed: (404|422)$/.test(error.message)) throw error;
          result = await fetchMarketCandles(address, period, undefined, request);
        }
        if (!result && poolAddress) result = await fetchMarketCandles(address, period, undefined, request);
        if (!result) { retryAt.set(key, { at: Date.now() + 300_000, status: 'no_history' }); return null; }
        retryAt.delete(key);
        if (cache.size >= 500) cache.delete(cache.keys().next().value!);
        cache.set(key, result);
        try {
          await mkdir(cacheDirectory, { recursive: true });
          const temporary = path.join(cacheDirectory, `${key}.tmp`);
          await writeFile(temporary, JSON.stringify(result));
          await rename(temporary, path.join(cacheDirectory, `${key}.json`));
        } catch { /* In-memory cache still serves refresh failures on read-only hosts. */ }
        return result;
      } catch (error) {
        const deferred = error instanceof MarketProviderDeferred;
        if (!deferred) console.warn('[token-chart]', address, period, error instanceof Error ? error.message : 'Refresh failed');
        retryAt.set(key, { at: Date.now() + (deferred ? error.retryAfterMs : 30_000),
          status: deferred ? error.reason === 'rate_limited' ? 'rate_limited' : 'queued' : 'provider_error' });
        return null;
      }
      finally { jobs.delete(key); priorities.delete(key); }
    })();
    jobs.set(key, job);
  }
  const available = saved ?? (range in candleWindows ? finerCachedChart(address, range) : null);
  const state = () => {
    const retry = retryAt.get(key);
    return { loadStatus: jobs.has(key) || !retry || retry.at <= Date.now() ? 'queued' as const : retry.status,
      retryAfterMs: jobs.has(key) || !retry ? 3000 : Math.max(1000, retry.at - Date.now()) };
  };
  if (available) return { chart: chartForRange({ ...available, stale: true }, range), pending: !!job, ...state() };
  if (job) {
    const result = await new Promise<TokenChart | null>(resolve => {
      const timer = setTimeout(() => resolve(null), 1000);
      void job!.then(chart => { clearTimeout(timer); resolve(chart); });
    });
    if (result) return { chart: chartForRange(result, range), pending: false };
  }
  return { chart: null, pending: jobs.has(key), ...state() };
}
