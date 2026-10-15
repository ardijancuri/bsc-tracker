import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { ReplayMarketChart } from '../shared/replayChart.js';
import type { TokenChart } from '../shared/intelligence.js';
import { pool } from './db.js';
import { geckoFetch, MarketProviderDeferred } from './geckoApi.js';
import { gmgnRequest } from './gmgnApi.js';
import { currentMarketChart, parseCandles, selectChartPools } from './tokenChart.js';
import { isExcludedKolProfileTokenAddress, kolProfileTokenSql } from './kolProfileToken.js';

const addressPattern = /^0x[0-9a-f]{40}$/;
const requestBudgetMs = 20_000;
const contextMs = 5 * 60_000;
const currentCacheMs = 15_000;
const retainedHistoryMs = 24 * 3_600_000;
const maximumHistoryBytes = 400 * 1024;
const gmgnPageBars = 100;
const gmgnResolutions = [['30s', 30], ['1m', 60], ['5m', 300], ['15m', 900], ['1h', 3600]] as const;
type JsonRequest = (url: URL, signal: AbortSignal, headers?: Record<string, string>) => Promise<any>;
interface SampleBar { time: number; open: number; close: number }
type ReplayPageCache = Map<string, { checkedAt: number; bars: SampleBar[] }>;
class ReplayMarketHttpError extends Error {
  constructor(readonly status: number) { super(`Replay market request failed: ${status}`); }
}

function validNumber(value: unknown) {
  if (value == null || value === '' || typeof value === 'boolean') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

/** A queued public request may outlive the response budget, but cannot delay this modal indefinitely. */
function withinBudget<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new DOMException('Replay history cancelled', 'AbortError'));
    if (signal.aborted) { operation.catch(() => {}); abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    operation.then(value => { signal.removeEventListener('abort', abort); resolve(value); }, error => {
      signal.removeEventListener('abort', abort); reject(error);
    });
  });
}

async function requestGmgn(url: URL, signal: AbortSignal, headers?: Record<string, string>) {
  return gmgnRequest(url, { apiKey: headers?.['X-APIKEY'] ?? '', signal, priority: 'chart', weight: 2 });
}

const requestGecko: JsonRequest = async (url, signal) => {
  const response = await withinBudget(geckoFetch(url, { priority: 'chart', timeoutMs: 6000 }), signal);
  if (!response.ok) throw new ReplayMarketHttpError(response.status);
  return withinBudget(response.json(), signal);
};

/** Use only a contiguous run of observed bars that covers every selected trade. */
export function replayPointsFromBars(bars: SampleBar[], seconds: number, first: number, last: number, now: number): ReplayMarketChart['points'] | null {
  const byTime = new Map<number, SampleBar>();
  for (const bar of bars) {
    if (!Number.isInteger(bar.time) || bar.time < 0 || !validNumber(bar.open) || !validNumber(bar.close)
      || (bar.time + seconds) * 1000 > now) continue;
    byTime.set(bar.time, bar);
  }
  const sorted = [...byTime.values()].sort((a, b) => a.time - b.time);
  let start = 0;
  for (let end = 0; end < sorted.length; end += 1) {
    if (end !== sorted.length - 1 && sorted[end + 1].time === sorted[end].time + seconds) continue;
    if (sorted[start].time * 1000 <= first && (sorted[end].time + seconds) * 1000 >= last) {
      const run = sorted.slice(start, end + 1);
      return [{ timestamp: new Date(run[0].time * 1000).toISOString(), priceUsd: String(run[0].open) },
        ...run.map(bar => ({ timestamp: new Date((bar.time + seconds) * 1000).toISOString(), priceUsd: String(bar.close) }))];
    }
    start = end + 1;
  }
  return null;
}

/** Sparse line-replay samples stay at genuine boundaries; gaps are disclosed,
 * never turned into empty candles or claimed continuous observations. */
export function replaySparsePointsFromBars(bars: SampleBar[], seconds: number, first: number, last: number, now: number): ReplayMarketChart['points'] | null {
  if (!Number.isInteger(seconds) || seconds <= 0 || !Number.isFinite(first) || first < 0 || !Number.isFinite(last) || last < first || last > now) return null;
  const byTime = new Map<number, SampleBar>();
  for (const bar of bars) {
    if (!Number.isInteger(bar.time) || bar.time < 0 || !validNumber(bar.open) || !validNumber(bar.close)
      || (bar.time + seconds) * 1000 > now) continue;
    byTime.set(bar.time, bar);
  }
  const sorted = [...byTime.values()].sort((a, b) => a.time - b.time);
  if (!sorted.length || sorted[0].time * 1000 > first || (sorted.at(-1)!.time + seconds) * 1000 < last) return null;
  const points: ReplayMarketChart['points'] = [];
  for (let index = 0; index < sorted.length; index += 1) {
    const bar = sorted[index], previous = sorted[index - 1];
    if (previous && previous.time + seconds > bar.time) return null;
    if (!previous || previous.time + seconds !== bar.time) {
      points.push({ timestamp: new Date(bar.time * 1000).toISOString(), priceUsd: String(bar.open) });
    }
    points.push({ timestamp: new Date((bar.time + seconds) * 1000).toISOString(), priceUsd: String(bar.close) });
  }
  return points;
}

function gmgnBars(rows: unknown, from: number, to: number): SampleBar[] {
  if (!Array.isArray(rows)) return [];
  const bars: SampleBar[] = [];
  for (const row of rows.slice(0, 1000)) {
    const rawTime = validNumber(row?.time);
    const open = validNumber(row?.open), close = validNumber(row?.close);
    if (rawTime === null || open === null || close === null) continue;
    // OpenAPI currently returns milliseconds; older responses use seconds.
    const time = rawTime >= 1e12 ? rawTime / 1000 : rawTime;
    if (!Number.isInteger(time) || time * 1000 < from || time * 1000 > to) continue;
    bars.push({ time, open, close });
  }
  return bars;
}

/** A forming bar is a live quote only; its eventual close is not yet history. */
function formingQuote(bars: SampleBar[], seconds: number, now: number): ReplayMarketChart['currentQuote'] {
  const bar = bars.filter(row => Number.isInteger(row.time) && row.time * 1000 <= now && (row.time + seconds) * 1000 > now
    && validNumber(row.close)).sort((a, b) => b.time - a.time)[0];
  return bar ? { timestamp: new Date(now).toISOString(), priceUsd: String(bar.close) } : undefined;
}

function recentChartQuote(chart: TokenChart | null, address: string, now: number): ReplayMarketChart['currentQuote'] {
  const updated = Date.parse(chart?.updatedAt ?? '');
  if (!chart || chart.address !== address || chart.resolution !== '1m' || chart.pending || chart.stale
    || !['gmgn', 'geckoterminal', 'coinmarketcap'].includes(chart.source)
    || !Number.isFinite(updated) || updated > now || now - updated > 30_000) return undefined;
  const formed = formingQuote(chart.candles, 60, now);
  if (formed) return { ...formed, timestamp: new Date(updated).toISOString() };
  const bar = chart.candles.filter(row => Number.isInteger(row.time) && row.time >= 0 && validNumber(row.close) && (row.time + 60) * 1000 <= now)
    .sort((a, b) => b.time - a.time)[0];
  const boundary = bar ? (bar.time + 60) * 1000 : NaN;
  return bar && now - boundary <= 180_000 ? { timestamp: new Date(boundary).toISOString(), priceUsd: String(bar.close) } : undefined;
}

export interface ReplayChartProviderOptions {
  gmgnKey?: string;
  gmgnRequest?: JsonRequest;
  geckoRequest?: JsonRequest;
  signal?: AbortSignal;
  now?: number;
  current?: boolean;
  currentChartRequest?: (address: string, signal: AbortSignal) => Promise<TokenChart | null>;
  /** Short-lived completed pages only; forming quotes are always refreshed. */
  pageCache?: ReplayPageCache;
}

/** Prefer the finest genuine history that fits bounded work. Never split coarse bars. */
export async function fetchTradeReplayChart(address: string, first: number, last: number, options: ReplayChartProviderOptions = {}): Promise<ReplayMarketChart | null> {
  const now = options.now ?? Date.now();
  if (!addressPattern.test(address) || !Number.isFinite(first) || first < 0 || !Number.isFinite(last) || last < first || last > now) {
    throw new Error('Invalid replay history range');
  }
  const signal = options.signal ?? AbortSignal.timeout(requestBudgetMs);
  const from = Math.max(0, first - contextMs), targetTo = options.current ? now : Math.min(now, last + contextMs);
  let currentQuote: ReplayMarketChart['currentQuote'];
  const readNow = () => options.now ?? Date.now();
  // Independently coalesced live work starts alongside historical paging. A
  // timed-out history window must not discard a successfully obtained quote.
  const quoteJob = options.current ? (async () => {
    try {
      const current = await withinBudget((options.currentChartRequest ?? (async (token, requestSignal) =>
        (await withinBudget(currentMarketChart(token, '1m', 'chart'), requestSignal)).chart))(address, signal), signal);
      return recentChartQuote(current, address, readNow());
    } catch { return undefined; }
  })() : null;
  const finish = async (history: ReplayMarketChart | null): Promise<ReplayMarketChart | null> => {
    if (quoteJob && !currentQuote) currentQuote = await quoteJob;
    if (currentQuote && Date.parse(currentQuote.timestamp) < last) currentQuote = undefined;
    const result = history ?? (currentQuote ? unavailable(address) : null);
    if (!result || !currentQuote) return result;
    const finalObservation = Date.parse(result.points.at(-1)?.timestamp ?? '');
    const interval = gmgnResolutions.find(([resolution]) => resolution === result.resolution)?.[1];
    const uncoveredTail = Number.isFinite(finalObservation) && interval !== undefined
      && Date.parse(currentQuote.timestamp) - finalObservation > interval * 1000;
    return { ...result, currentQuote, ...(uncoveredTail ? { sparseHistory: true } : {}) };
  };
  const historyEnd = (bars: SampleBar[], seconds: number) => options.current
    ? Math.max(last, ...bars.filter(bar => (bar.time + seconds) * 1000 <= now).map(bar => (bar.time + seconds) * 1000)) : last;
  const chart = (points: ReplayMarketChart['points'], source: ReplayMarketChart['source'], resolution: string, poolAddress?: string, sparseHistory = false): ReplayMarketChart => ({
    address, period: 'replay', candles: [], points, source, resolution, poolAddress,
    updatedAt: new Date(now).toISOString(), pending: false, stale: false,
    ...(sparseHistory ? { sparseHistory: true } : {}),
  });
  if (options.gmgnKey) {
    const deadline = Date.now() + requestBudgetMs;
    // The free endpoint currently returns at most 100 rows, even when a larger
    // time range is requested. Long positions need a genuine coarser interval.
    const candidates = gmgnResolutions.map(([resolution, seconds]) => ({ resolution, seconds,
      pages: Math.ceil((Math.floor(targetTo / (seconds * 1000)) - Math.floor(first / (seconds * 1000)) + 1) / gmgnPageBars),
    })).filter(candidate => candidate.pages <= 4);
    for (let index = 0; index < candidates.length; index += 1) {
      const { resolution, seconds, pages } = candidates[index];
      const stepMs = seconds * 1000;
      const historyFrom = Math.floor(from / stepMs) * stepMs;
      const remainingPages = candidates.slice(index).reduce((sum, candidate) => sum + candidate.pages, 0);
      // Give multi-page candidates proportionate time while reserving a share
      // of the same deadline for coarser recovery after fine-data gaps/stalls.
      const candidateBudget = Math.max(1, Math.floor((deadline - Date.now()) * pages / remainingPages));
      const resolutionSignal = AbortSignal.any([signal, AbortSignal.timeout(candidateBudget)]);
      try {
        const bars = new Map<number, SampleBar>();
        let to = targetTo;
        for (let page = 0; page < 4 && to >= historyFrom && !resolutionSignal.aborted; page += 1) {
          // A wide ascending response can otherwise lose its newest observations
          // when the parser retains 1,000 rows. Request at most 1,000 bar times.
          const latestBar = Math.floor(to / stepMs) * stepMs;
          const pageFrom = Math.max(historyFrom, latestBar - 999 * stepMs);
          const url = new URL('https://openapi.gmgn.ai/v1/market/token_kline');
          for (const [key, value] of Object.entries({ chain: 'bsc', address, resolution, from: pageFrom, to,
            timestamp: Math.floor(now / 1000), client_id: randomUUID() })) url.searchParams.set(key, String(value));
          const pageKey = `${address}:${resolution}:${pageFrom}:${latestBar}`;
          const savedPage = options.pageCache?.get(pageKey);
          let rows: SampleBar[];
          if (savedPage && savedPage.checkedAt <= now && now - savedPage.checkedAt <= 180_000) rows = savedPage.bars;
          else {
            const body = await withinBudget((options.gmgnRequest ?? requestGmgn)(url, resolutionSignal, { 'X-APIKEY': options.gmgnKey }), resolutionSignal);
            if (body?.code !== 0) throw new Error('Replay market provider rejected history');
            rows = gmgnBars(Array.isArray(body?.data) ? body.data : body?.data?.list, pageFrom, to);
            const completed = rows.filter(bar => (bar.time + seconds) * 1000 <= now);
            if (completed.length && options.pageCache) {
              options.pageCache.delete(pageKey); options.pageCache.set(pageKey, { checkedAt: now, bars: completed });
              while (options.pageCache.size > 20) options.pageCache.delete(options.pageCache.keys().next().value!);
            }
          }
          if (options.current && page === 0) currentQuote ??= formingQuote(rows, seconds, readNow());
          if (!rows.length) break;
          for (const bar of rows) bars.set(bar.time, bar);
          const observations = [...bars.values()], end = historyEnd(observations, seconds);
          const points = replayPointsFromBars(observations, seconds, first, end, now);
          if (points) return finish(chart(points, 'gmgn', resolution));
          const oldest = Math.min(...rows.map(bar => bar.time)) * 1000;
          if (oldest <= first) {
            const sparse = replaySparsePointsFromBars(observations, seconds, first, end, now);
            if (sparse) return finish(chart(sparse, 'gmgn', resolution, undefined, true));
            break;
          }
          if (oldest - 1 >= to) break;
          to = oldest - 1;
        }
      } catch (problem) {
        // Retrying another interval/provider during a cooldown adds work without
        // recovering history. Preserve the explicit retry contract for the UI.
        if (problem instanceof MarketProviderDeferred) {
          if (options.current) {
            const quoted = await finish(unavailable(address, problem));
            if (quoted?.currentQuote) return quoted;
          }
          throw problem;
        }
        // Unavailable fine history can still use a genuine coarser source.
      }
    }
  }
  if (signal.aborted) return finish(null);
  const request = options.geckoRequest ?? requestGecko;
  try {
    const discovery = new URL(`https://api.geckoterminal.com/api/v2/networks/bsc/tokens/${address}/pools`);
    const pools = selectChartPools(await withinBudget(request(discovery, signal), signal), address).slice(0, 2);
    for (const poolAddress of pools) {
      const bars = new Map<number, SampleBar>();
      let before = Math.ceil(targetTo / 1000);
      for (let page = 0; page < 2 && !signal.aborted; page += 1) {
        const url = new URL(`https://api.geckoterminal.com/api/v2/networks/bsc/pools/${poolAddress}/ohlcv/minute`);
        for (const [key, value] of Object.entries({ aggregate: '1', limit: '1000', currency: 'usd', token: address,
          before_timestamp: String(before), include_empty_intervals: 'true' })) url.searchParams.set(key, value);
        let body: any;
        try { body = await withinBudget(request(url, signal), signal); }
        catch (problem) {
          // Unsupported or removed pools may use the next verified pool;
          // timeouts and cooldowns must not trigger more upstream requests.
          if (problem instanceof ReplayMarketHttpError && [404, 422].includes(problem.status)) break;
          throw problem;
        }
        const rows = parseCandles(body?.data?.attributes?.ohlcv_list, Math.floor(from / 1000), Math.min(before, Math.floor(now / 1000) - (options.current ? 0 : 60)));
        if (options.current && page === 0) currentQuote ??= formingQuote(rows, 60, readNow());
        if (!rows.length) break;
        for (const bar of rows) bars.set(bar.time, bar);
        const observations = [...bars.values()], end = historyEnd(observations, 60);
        const points = replayPointsFromBars(observations, 60, first, end, now);
        if (points) return finish(chart(points, 'geckoterminal', '1m', poolAddress));
        const oldest = Math.min(...rows.map(bar => bar.time));
        if (oldest * 1000 <= first) {
          const sparse = replaySparsePointsFromBars(observations, 60, first, end, now);
          if (sparse) return finish(chart(sparse, 'geckoterminal', '1m', poolAddress, true));
          break;
        }
        if (oldest - 1 >= before) break;
        before = oldest - 1;
      }
    }
  } catch (problem) {
    if (problem instanceof MarketProviderDeferred) {
      if (options.current) {
        const quoted = await finish(unavailable(address, problem));
        if (quoted?.currentQuote) return quoted;
      }
      throw problem;
    }
    // Keep provider gaps unavailable rather than inventing observations.
  }
  return finish(null);
}

function unavailable(address: string, deferred?: MarketProviderDeferred): ReplayMarketChart {
  return { address, period: 'replay', candles: [], points: [], source: 'unavailable', resolution: '30s',
    updatedAt: null, pending: false, stale: false,
    loadStatus: deferred ? deferred.reason === 'rate_limited' ? 'rate_limited' : 'queued' : undefined,
    retryAfterMs: deferred ? Math.max(1000, deferred.retryAfterMs) : 30_000 };
}

/** Retain only genuine completed observations, never a cached current quote or supply. */
function retainedHistory(chart: ReplayMarketChart, address: string, first: number, last: number, now: number): ReplayMarketChart | null {
  if (chart.address !== address || chart.period !== 'replay' || !['gmgn', 'geckoterminal'].includes(chart.source)
    || !gmgnResolutions.some(([resolution]) => resolution === chart.resolution) || chart.pending || chart.stale || chart.partialHistory
    || !Array.isArray(chart.points) || chart.points.length < 2 || chart.points.length > 4002) return null;
  const updated = Date.parse(chart.updatedAt ?? '');
  if (!Number.isFinite(updated) || updated > now) return null;
  const points: ReplayMarketChart['points'] = [];
  let previous = -1;
  for (const point of chart.points) {
    const time = Date.parse(point?.timestamp ?? ''), price = validNumber(point?.priceUsd);
    if (!Number.isFinite(time) || time < 0 || time <= previous || time > now || price === null) return null;
    points.push({ timestamp: new Date(time).toISOString(), priceUsd: String(price) }); previous = time;
  }
  if (Date.parse(points[0].timestamp) > first || previous < last) return null;
  return { address, period: 'replay', candles: [], points, source: chart.source, resolution: chart.resolution,
    updatedAt: chart.updatedAt, pending: false, stale: false,
    ...(chart.poolAddress && addressPattern.test(chart.poolAddress) ? { poolAddress: chart.poolAddress } : {}),
    ...(chart.sparseHistory ? { sparseHistory: true } : {}) };
}

type RetainedHistory = { chart: ReplayMarketChart; savedAt: number };
const historyDigest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Historical windows outlive live-quote refreshes. Failures never erase actual
 * observations, including across process restarts, or revive an old live quote. */
export function createReplayChartCache(loader: typeof fetchTradeReplayChart, now = Date.now, directory?: string) {
  const saved = new Map<string, { chart: ReplayMarketChart; until: number; retryAt?: number }>();
  const histories = new Map<string, RetainedHistory>();
  const jobs = new Map<string, Promise<ReplayMarketChart>>();
  const pages = new Map<string, ReplayPageCache>();
  const fileFor = (key: string) => path.join(directory!, historyDigest(key) + '.json');
  async function loadHistory(key: string, address: string, first: number, last: number): Promise<RetainedHistory | null> {
    if (!directory) return null;
    try {
      const file = fileFor(key);
      if ((await stat(file)).size > maximumHistoryBytes) return null;
      const text = await readFile(file, 'utf8');
      if (Buffer.byteLength(text) > maximumHistoryBytes) return null;
      const envelope = JSON.parse(text), value = envelope?.value;
      if (envelope?.version !== 1 || envelope.checksum !== historyDigest(value) || value?.key !== key
        || typeof value.savedAt !== 'number' || !Number.isFinite(value.savedAt) || value.savedAt > now()
        || now() - value.savedAt >= retainedHistoryMs) return null;
      const chart = retainedHistory(value.chart ?? {}, address, first, last, value.savedAt);
      return chart ? { chart, savedAt: value.savedAt } : null;
    } catch { return null; }
  }
  async function persistHistory(key: string, history: RetainedHistory) {
    if (!directory) return;
    const file = fileFor(key), temporary = `${file}.${randomUUID()}.tmp`;
    const value = { key, ...history }, text = JSON.stringify({ version: 1, checksum: historyDigest(value), value });
    if (Buffer.byteLength(text) > maximumHistoryBytes) return;
    try { await mkdir(directory, { recursive: true }); await writeFile(temporary, text); await rename(temporary, file); }
    catch { /* Public history still remains usable on a read-only host. */ }
  }
  function withHistory(chart: ReplayMarketChart, history: ReplayMarketChart, last: number, current: boolean): ReplayMarketChart {
    const candidate = chart.currentQuote, candidateTime = Date.parse(candidate?.timestamp ?? '');
    const quote = current && chart.address === history.address && chart.period === 'replay'
      && validNumber(candidate?.priceUsd) && Number.isFinite(candidateTime) && candidateTime >= last
      && candidateTime <= now() && now() - candidateTime <= 180_000 ? candidate : undefined;
    const quoteTime = Date.parse(quote?.timestamp ?? ''), observed = Date.parse(history.points.at(-1)!.timestamp);
    const interval = gmgnResolutions.find(([resolution]) => resolution === history.resolution)![1] * 1000;
    return { ...history, ...(quote ? { currentQuote: quote } : {}), loadStatus: chart.loadStatus, retryAfterMs: chart.retryAfterMs,
      ...(history.sparseHistory || Number.isFinite(quoteTime) && quoteTime - observed > interval ? { sparseHistory: true } : {}) };
  }
  return async (address: string, first: number, last: number, current = false): Promise<ReplayMarketChart> => {
    const key = `${address}:${first}:${last}:${current ? 'current' : 'closed'}`;
    const cached = saved.get(key);
    if (cached && cached.until > now()) return cached.chart.loadStatus === 'queued' || cached.chart.loadStatus === 'rate_limited'
      ? { ...cached.chart, retryAfterMs: Math.max(1000, (cached.retryAt ?? cached.until) - now()) } : cached.chart;
    const pending = jobs.get(key);
    if (pending) return pending;
    if (jobs.size >= 2) {
      const history = histories.get(key), unavailableChart = unavailable(address, new MarketProviderDeferred('busy', 3000));
      return history && history.savedAt <= now() && now() - history.savedAt < retainedHistoryMs
        ? withHistory(unavailableChart, history.chart, last, current) : unavailableChart;
    }
    const job = (async () => {
      let history = histories.get(key) ?? (directory ? await loadHistory(key, address, first, last) : null);
      if (history && (history.savedAt > now() || now() - history.savedAt >= retainedHistoryMs)) history = null;
      if (history) {
        if (histories.size >= 250 && !histories.has(key)) histories.delete(histories.keys().next().value!);
        histories.set(key, history);
      }
      else histories.delete(key);
      let chart: ReplayMarketChart;
      let pageCache = pages.get(key);
      if (!pageCache) {
        pageCache = new Map(); pages.set(key, pageCache);
        while (pages.size > 32) pages.delete(pages.keys().next().value!);
      }
      try { chart = await loader(address, first, last, { gmgnKey: process.env.GMGN_CHART_API_KEY?.trim() || process.env.GMGN_API_KEY?.trim(),
        signal: AbortSignal.timeout(requestBudgetMs), current, pageCache }) ?? unavailable(address); }
      catch (problem) { chart = unavailable(address, problem instanceof MarketProviderDeferred ? problem : undefined); }
      const observed = retainedHistory(chart, address, first, last, now());
      if (observed) {
        history = { chart: observed, savedAt: now() };
        if (histories.size >= 250 && !histories.has(key)) histories.delete(histories.keys().next().value!);
        histories.set(key, history);
        await persistHistory(key, history);
      } else if (history) chart = withHistory(chart, history.chart, last, current);
      if (saved.size >= 250) saved.delete(saved.keys().next().value!);
      const deferred = chart.loadStatus === 'queued' || chart.loadStatus === 'rate_limited';
      const lifetime = current ? chart.currentQuote ? currentCacheMs : deferred ? chart.retryAfterMs ?? 30_000 : 5000
        : chart.points.length ? 3_600_000 : chart.retryAfterMs ?? 30_000;
      saved.set(key, { chart, until: now() + lifetime, retryAt: deferred ? now() + (chart.retryAfterMs ?? 30_000) : undefined });
      return chart;
    })().finally(() => jobs.delete(key));
    jobs.set(key, job);
    return job;
  };
}
const cachedReplayChart = createReplayChartCache(fetchTradeReplayChart, Date.now,
  path.join(process.env.TOKEN_CHART_CACHE_DIR || path.join(process.cwd(), '.cache', 'token-charts'), 'replay-history'));

export function registerTradeReplayChartRoutes(app: FastifyInstance) {
  app.get<{ Params: { address: string; token: string }; Querystring: { end?: string } }>('/api/kols/:address/tokens/:token/replay-chart', async (request, reply) => {
    const wallet = request.params.address.toLowerCase(), token = request.params.token.toLowerCase();
    if (!addressPattern.test(wallet) || !addressPattern.test(token)) return reply.code(400).send({ error: 'Invalid KOL or token address' });
    if (request.query.end !== undefined && request.query.end !== 'current') return reply.code(400).send({ error: 'Invalid replay ending' });
    if (isExcludedKolProfileTokenAddress(token)) return reply.code(404).send({ error: 'KOL token activity not found' });
    const current = request.query.end === 'current';
    const result = await pool.query(`SELECT MIN(t.timestamp) AS first,GREATEST(MAX(t.timestamp),COALESCE((SELECT MAX(m.timestamp) FROM wallet_transfers m
      WHERE m.wallet_address=$1 AND m.token_address=$2 AND m.kind='transfer' AND m.timestamp<=now()
        AND NOT EXISTS(SELECT 1 FROM trades swapped WHERE swapped.wallet_address=m.wallet_address AND swapped.token_address=m.token_address
          AND swapped.tx_hash=m.tx_hash AND swapped.block_number IS NOT NULL AND swapped.side IN('buy','sell'))),MAX(t.timestamp))) AS last,
      CASE WHEN v.total_supply_raw>0 AND v.decimals BETWEEN 0 AND 36 AND v.supply_checked_at>now()-interval '2 days'
        THEN (v.total_supply_raw/power(10::numeric,v.decimals))::text END AS supply
      FROM trades t JOIN kols k ON k.address=t.wallet_address JOIN tokens v ON v.address=t.token_address
      WHERE t.wallet_address=$1 AND t.token_address=$2 AND k.is_tracked AND t.block_number IS NOT NULL
        AND t.timestamp<=now() AND t.side IN ('buy','sell') AND ${kolProfileTokenSql()}
      GROUP BY v.address`, [wallet, token]);
    const row = result.rows[0];
    if (!row) return reply.code(404).send({ error: 'KOL token activity not found' });
    const chart = await cachedReplayChart(token, new Date(row.first).getTime(), new Date(row.last).getTime(), current);
    return reply.header('Cache-Control', !current && chart.points.length ? 'public, max-age=60' : 'no-store')
      .send({ ...chart, marketCapSupply: row.supply ?? null });
  });
}
