import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { CandleInterval, MarketCandle, TokenChart } from '../shared/intelligence.js';
import { gmgnApiKey, gmgnRequest, type GmgnRequestOptions } from './gmgnApi.js';
import { MarketProviderDeferred, marketPriorityRank, type GeckoPriority } from './geckoApi.js';
import { chartSettings, fetchPreferredMarketCandles, parseGmgnCandles } from './tokenChart.js';
import { createTokenHistoryArchive, historyArchiveCursor, mergeHistoryCandles, mergeHistoryCoverage, type HistoryManifest } from './tokenChartHistoryArchive.js';

type Retry = { at: number; status: 'queued' | 'rate_limited' | 'provider_error' };
type State = { manifest: HistoryManifest; candles: MarketCandle[]; source: TokenChart['source']; fallbackVolumeCurrency?: 'usd' | 'unknown'; latestRetry?: Retry; historyRetry?: Retry };
type Result = { chart: TokenChart; pending: boolean; loadStatus?: TokenChart['loadStatus']; retryAfterMs?: number };
type Archive = ReturnType<typeof createTokenHistoryArchive>;
type Page = { candles: MarketCandle[]; coverage: [number, number] };
const defaultDirectory = path.join(process.env.TOKEN_CHART_CACHE_DIR || path.join(process.cwd(), '.cache', 'token-charts'), 'full-history');

/** Latest candles and backward pages have separate lifetimes and in-flight jobs. */
export function createFullMarketCharts({ request = gmgnRequest, archive = createTokenHistoryArchive(defaultDirectory), now = Date.now,
  apiKey = () => gmgnApiKey('market'), snapshotLimit = 20_000,
  fallback = (address: string, interval: CandleInterval, signal: AbortSignal) => fetchPreferredMarketCandles(address, interval, undefined, { signal }),
}: { request?: (url: URL, options: GmgnRequestOptions) => Promise<any>; archive?: Archive; now?: () => number; apiKey?: () => string;
  snapshotLimit?: number; fallback?: (address: string, interval: CandleInterval, signal: AbortSignal) => Promise<TokenChart | null> } = {}) {
  const retainedLimit = Math.min(100_000, Math.max(1000, Math.floor(snapshotLimit)));
  const states = new Map<string, State>(), loading = new Map<string, Promise<State>>();
  const latestJobs = new Map<string, Promise<void>>(), historyJobs = new Map<string, Promise<MarketCandle[]>>();
  const priorities = new Map<string, GeckoPriority>();
  const readers = new Map<string, number>();
  const keyFor = (address: string, interval: CandleInterval) => `${address}-${interval}`;
  const prune = () => {
    for (const key of states.keys()) {
      if (states.size <= 5) break;
      if (!readers.has(key) && !latestJobs.has(key) && ![...historyJobs.keys()].some(job => job.startsWith(`${key}:`))) states.delete(key);
    }
  };
  const getState = async (address: string, interval: CandleInterval): Promise<State> => {
    const key = keyFor(address, interval), saved = states.get(key);
    if (saved) { states.delete(key); states.set(key, saved); return saved; }
    const existing = loading.get(key);
    if (existing) return existing;
    const job = (async () => {
      let manifest: HistoryManifest | null = null, candles: MarketCandle[] = [];
      try {
        manifest = await archive.loadManifest(address, interval);
        if (manifest) candles = await archive.readBefore(manifest, Math.floor(now() / 1000) + 1, retainedLimit);
      } catch {
        // Lost chunk data also invalidates its claim of fully scanned coverage.
        if (manifest) { manifest.complete = false; manifest.coverage = []; manifest.latestTo = undefined; }
      }
      const state: State = { manifest: manifest ?? { version: 1, address, interval, updatedAt: null, complete: false, volumeCurrency: 'usd', chunks: [] },
        candles, source: candles.length ? 'gmgn' : 'unavailable' };
      states.set(key, state); prune(); return state;
    })().finally(() => loading.delete(key));
    loading.set(key, job); return job;
  };
  const retryFor = (error: unknown): Retry => ({ at: now() + (error instanceof MarketProviderDeferred ? error.retryAfterMs : 30_000),
    status: error instanceof MarketProviderDeferred ? error.reason === 'rate_limited' ? 'rate_limited' : 'queued' : 'provider_error' });
  const page = async (address: string, interval: CandleInterval, key: string, before?: number): Promise<Page> => {
    const secret = apiKey();
    if (!secret) throw new Error('GMGN chart history is not configured');
    const end = before === undefined ? now() : before * 1000 - 1;
    const url = new URL('https://openapi.gmgn.ai/v1/market/token_kline');
    for (const [name, value] of Object.entries({ chain: 'bsc', address, resolution: interval, from: 1000, to: end,
      timestamp: Math.floor(now() / 1000), client_id: randomUUID() })) url.searchParams.set(name, String(value));
    const body = await request(url, { apiKey: secret, workload: 'market', signal: AbortSignal.timeout(20_000),
      priority: before === undefined ? () => priorities.get(key) ?? 'chart' : 'prefetch' });
    const rows = Array.isArray(body?.data) ? body.data : body?.data?.list;
    if (body?.code !== 0 || !Array.isArray(rows)) throw new Error('GMGN returned an invalid history page');
    const candles = parseGmgnCandles(rows, 1, Math.floor(end / 1000));
    // Ignored bounds, invalid rows and future samples must never prove exhaustion.
    if (rows.length && !candles.length) throw new Error('GMGN history page contains no valid candles');
    return { candles, coverage: [candles[0]?.time ?? 1, Math.floor(end / 1000)] };
  };
  const applyCoverage = (state: State, coverage: [number, number], latest = false) => {
    if (latest) state.manifest.latestTo = coverage[1];
    state.manifest.coverage = mergeHistoryCoverage(state.manifest.coverage ?? [], coverage);
    state.manifest.complete = state.manifest.latestTo !== undefined && state.manifest.coverage.some(([from, to]) => from === 1 && to >= state.manifest.latestTo!);
  };
  const persist = async (state: State, candles: MarketCandle[], options: { latest?: boolean; coverage?: [number, number] } = {}) => {
    try { await archive.savePage(state.manifest, candles, options); }
    catch { /* Keep genuine in-memory data visible; a future page can retry persistence. */ }
  };
  const startLatest = (state: State, address: string, interval: CandleInterval, priority: GeckoPriority) => {
    const key = keyFor(address, interval), currentPriority = priorities.get(key);
    const existing = latestJobs.get(key);
    if (existing) {
      if (!currentPriority || marketPriorityRank[priority] < marketPriorityRank[currentPriority]) priorities.set(key, priority);
      return existing;
    }
    if (state.latestRetry && state.latestRetry.at > now()) return undefined;
    if (state.manifest.updatedAt && (state.source !== 'gmgn' && state.candles.length || state.manifest.latestTo !== undefined &&
      state.manifest.coverage?.some(([from, to]) => from <= state.manifest.latestTo! && to >= state.manifest.latestTo!)) &&
      now() - Date.parse(state.manifest.updatedAt) < chartSettings(interval).fresh) return undefined;
    if (latestJobs.size >= 8) { state.latestRetry = { at: now() + 1500, status: 'queued' }; return undefined; }
    priorities.set(key, priority);
    const job = (async () => {
      try {
        let fetched: Page;
        try { fetched = await page(address, interval, key); }
        catch (error) {
          if (state.candles.length) throw error;
          const alternative = await fallback(address, interval, AbortSignal.timeout(12_000));
          if (!alternative?.candles.length) throw error;
          state.candles = alternative.candles; state.source = alternative.source;
          state.manifest.updatedAt = alternative.updatedAt;
          state.fallbackVolumeCurrency = alternative.volumeCurrency === 'unknown' ? 'unknown' : 'usd';
          state.latestRetry = undefined; state.historyRetry = retryFor(error); return;
        }
        const { candles, coverage } = fetched;
        if (!candles.length && state.candles.length) throw new Error('GMGN chart history temporarily unavailable');
        if (state.source !== 'gmgn') {
          // Public fallback bars must never become source-labelled GMGN history.
          try { state.candles = await archive.readBefore(state.manifest, Math.floor(now() / 1000) + 1, retainedLimit); }
          catch { state.candles = []; }
          if (!state.manifest.chunks.length) state.manifest.volumeCurrency = 'usd';
        }
        state.candles = mergeHistoryCandles(state.candles, candles, retainedLimit);
        state.source = candles.length ? 'gmgn' : 'unavailable';
        state.manifest.updatedAt = new Date(now()).toISOString();
        state.latestRetry = undefined;
        state.historyRetry = undefined;
        applyCoverage(state, coverage, true);
        await persist(state, candles, { latest: true, coverage });
      } catch (error) { state.latestRetry = retryFor(error); }
      finally { latestJobs.delete(key); priorities.delete(key); prune(); }
    })();
    latestJobs.set(key, job); return job;
  };
  const hasEarlier = (state: State, time: number) => state.manifest.chunks.some(chunk => chunk.first < time) || state.candles.some(c => c.time < time);
  const response = (state: State, address: string, interval: CandleInterval, candles: MarketCandle[], before?: number): Result => {
    const key = keyFor(address, interval), latestPending = latestJobs.has(key), retry = state.latestRetry;
    const complete = state.manifest.complete && !(candles.length && hasEarlier(state, candles[0].time));
    const gapCursor = historyArchiveCursor(state.manifest);
    const historicalRetry = state.historyRetry && state.historyRetry.at > now() ? state.historyRetry : undefined;
    const historyLimited = state.source !== 'gmgn' && state.candles.length > 0;
    const historyPending = !complete && !historicalRetry && !historyLimited;
    const latestStatus = latestPending ? 'queued' as const : retry && retry.at > now() ? retry.status : !candles.length && complete ? 'no_history' as const : undefined;
    const chart: TokenChart = { address, period: interval, resolution: interval, source: state.source, updatedAt: state.manifest.updatedAt,
      candles, points: candles.map(c => ({ timestamp: new Date(c.time * 1000).toISOString(), priceUsd: String(c.close) })),
      volumeCurrency: state.source === 'gmgn' ? state.manifest.volumeCurrency : state.fallbackVolumeCurrency ?? state.manifest.volumeCurrency,
      stale: !!retry || latestPending, pending: latestPending,
      fullHistory: true, historyComplete: complete, historyPending,
      partialHistory: !complete, historyBefore: gapCursor !== undefined && (candles[0] === undefined || gapCursor > candles[0].time)
        ? gapCursor : candles[0]?.time ?? before,
      ...(historyLimited ? { historyLoadStatus: 'limited' as const } : historicalRetry ? { historyLoadStatus: historicalRetry.status, historyRetryAfterMs: Math.max(1000, historicalRetry.at - now()) }
        : historyPending ? { historyLoadStatus: 'queued' as const, historyRetryAfterMs: 1500 } : {}),
    };
    return { chart, pending: latestPending, ...(latestStatus ? { loadStatus: latestStatus, retryAfterMs: latestPending ? 1500 : retry ? Math.max(1000, retry.at - now()) : 300_000 } : {}) };
  };
  const older = async (state: State, address: string, interval: CandleInterval, before: number): Promise<MarketCandle[]> => {
    const key = keyFor(address, interval), jobKey = `${key}:${before}`;
    // Disk can contain older bars outside the small in-memory tail.
    try {
      const covered = state.manifest.coverage?.find(([from, to]) => from < before && to >= before - 1);
      if (!covered) throw new Error('History boundary has an unscanned gap');
      const cached = await archive.readBefore(state.manifest, before, 1000, covered[0]);
      if (cached.length) return cached;
    } catch { /* Fetch the uncovered boundary instead of skipping to older cached bars. */ }
    const coveredBelow = state.manifest.coverage?.some(([from, to]) => from < before && to >= before - 1);
    const remembered = coveredBelow ? state.candles.filter(c => c.time < before).slice(-1000) : [];
    if (remembered.length) return remembered;
    if (state.manifest.complete || state.historyRetry && state.historyRetry.at > now()) return [];
    const existing = historyJobs.get(jobKey);
    if (existing) return existing;
    // Bound background work and never chain pages after the viewer leaves.
    if (historyJobs.size >= 2) { state.historyRetry = { at: now() + 1500, status: 'queued' }; return []; }
    const job = (async () => {
      try {
        const { candles, coverage } = await page(address, interval, key, before);
        state.historyRetry = undefined;
        applyCoverage(state, coverage);
        state.candles = mergeHistoryCandles(state.candles, candles, retainedLimit);
        await persist(state, candles, { coverage });
        return candles;
      } catch (error) { state.historyRetry = retryFor(error); return []; }
      finally { historyJobs.delete(jobKey); prune(); }
    })();
    historyJobs.set(jobKey, job); return job;
  };
  return async (address: string, interval: CandleInterval, priority: GeckoPriority = 'chart', before?: number): Promise<Result> => {
    const key = keyFor(address, interval);
    readers.set(key, (readers.get(key) ?? 0) + 1);
    try {
      const state = await getState(address, interval);
      if (before !== undefined) return response(state, address, interval, await older(state, address, interval, before), before);
      const job = startLatest(state, address, interval, priority);
      if (!state.candles.length && job) await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, priority === 'chart' ? 8000 : 1000);
        void job.then(() => { clearTimeout(timer); resolve(); });
      });
      return response(state, address, interval, state.candles);
    } finally {
      const remaining = readers.get(key)! - 1;
      if (remaining) readers.set(key, remaining); else readers.delete(key);
      prune();
    }
  };
}

export const currentFullMarketChart = createFullMarketCharts();
