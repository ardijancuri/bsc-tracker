import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import type { MarketCandle, TokenChart, WatchPeriod } from '../shared/intelligence.js';
import { geckoFetch } from './geckoApi.js';

export const chartWindows = {
  '24h': { seconds: 86400, timeframe: 'minute', aggregate: 5, resolution: '5m', fresh: 120_000 },
  '7d': { seconds: 604800, timeframe: 'hour', aggregate: 1, resolution: '1h', fresh: 300_000 },
  '30d': { seconds: 2592000, timeframe: 'hour', aggregate: 1, resolution: '1h', fresh: 600_000 },
} as const;
const addressRe = /^0x[0-9a-f]{40}$/;
const poolRe = /^0x(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
type JsonRequest = (url: URL) => Promise<any>;

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
async function providerRequest(url: URL) {
  const response = await geckoFetch(url, { priority: 'chart', timeoutMs: 10_000 });
  if (!response.ok) throw new Error(`Market chart request failed: ${response.status}`);
  return response.json();
}

export async function fetchMarketCandles(address: string, period: WatchPeriod, poolAddress: string | undefined, request: JsonRequest = providerRequest, now = Date.now()): Promise<TokenChart | null> {
  if (!addressRe.test(address) || poolAddress && !poolRe.test(poolAddress)) throw new Error('Invalid chart address');
  const settings = chartWindows[period];
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
const retryAt = new Map<string, number>();
const cacheDirectory = process.env.TOKEN_CHART_CACHE_DIR || path.join(process.cwd(), '.cache', 'token-charts');
async function loadCached(key: string, address: string, period: WatchPeriod) {
  if (cache.has(key)) return cache.get(key)!;
  try {
    const raw = await readFile(path.join(cacheDirectory, `${key}.json`), 'utf8');
    if (raw.length > 400_000) return null;
    const value = JSON.parse(raw) as TokenChart;
    if (value.address !== address || value.period !== period || value.source !== 'geckoterminal' || !Number.isFinite(Date.parse(value.updatedAt || ''))) return null;
    const now = Math.floor(Date.now() / 1000);
    const candles = parseCandles(value.candles?.map(c => [c.time, c.open, c.high, c.low, c.close, c.volume]), now - chartWindows[period].seconds, now);
    if (!candles.length) return null;
    value.candles = candles;
    value.points = candles.map(c => ({ timestamp: new Date(c.time * 1000).toISOString(), priceUsd: String(c.close) }));
    cache.set(key, value);
    return value;
  } catch { return null; }
}

export async function currentMarketChart(address: string, period: WatchPeriod): Promise<{ chart: TokenChart | null; pending: boolean }> {
  const key = `${address}-${period}`;
  const saved = await loadCached(key, address, period);
  const fresh = saved && Date.now() - Date.parse(saved.updatedAt!) < chartWindows[period].fresh;
  if (fresh) return { chart: saved, pending: false };
  let job = jobs.get(key);
  if (!job && Date.now() >= (retryAt.get(key) || 0) && jobs.size < 32) {
    const poolAddress = saved?.poolAddress ?? [...cache.values()].find(c => c.address === address)?.poolAddress;
    job = (async () => {
      try {
        let result: TokenChart | null;
        try { result = await fetchMarketCandles(address, period, poolAddress); }
        catch (error) {
          // Discovery cannot fix a timeout, 429 or a provider cooldown.
          if (!poolAddress || !(error instanceof Error) || !/request failed: (404|422)$/.test(error.message)) throw error;
          result = await fetchMarketCandles(address, period, undefined);
        }
        if (!result && poolAddress) result = await fetchMarketCandles(address, period, undefined);
        if (!result) { retryAt.set(key, Date.now() + 300_000); return null; }
        if (cache.size >= 500) cache.delete(cache.keys().next().value!);
        cache.set(key, result);
        try {
          await mkdir(cacheDirectory, { recursive: true });
          const temporary = path.join(cacheDirectory, `${key}.tmp`);
          await writeFile(temporary, JSON.stringify(result));
          await rename(temporary, path.join(cacheDirectory, `${key}.json`));
        } catch { /* In-memory cache still serves refresh failures on read-only hosts. */ }
        return result;
      } catch (error) { console.warn('[token-chart]', address, period, error instanceof Error ? error.message : 'Refresh failed'); retryAt.set(key, Date.now() + 60_000); return null; }
      finally { jobs.delete(key); }
    })();
    jobs.set(key, job);
  }
  if (saved) return { chart: { ...saved, stale: true }, pending: !!job };
  if (job) {
    const result = await new Promise<TokenChart | null>(resolve => {
      const timer = setTimeout(() => resolve(null), 6500);
      void job!.then(chart => { clearTimeout(timer); resolve(chart); });
    });
    if (result) return { chart: result, pending: false };
  }
  return { chart: null, pending: jobs.has(key) };
}
