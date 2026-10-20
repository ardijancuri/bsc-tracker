import { candleIntervals, type CandleInterval, type ChartRange, type MarketCandle, type TokenChart } from '../shared/intelligence';

type ChartStorage = Pick<Storage, 'getItem' | 'setItem'>;
export type TokenChartPriority = 'chart' | 'prefetch' | 'sparkline';
const priorityOrder: Record<TokenChartPriority, number> = { chart: 0, prefetch: 1, sparkline: 2 };
// Provider-era charts must not appear as the initial node-owned read after cutover.
const storageKey = 'kollens:market-charts:node-v2';
const supplyLifetime = 2 * 86400_000;
const chartWindows: Record<ChartRange, number> = { '24h': 86400, '7d': 604800, '30d': 2592000, '1m': 86400, '5m': 86400, '1h': 2592000, '4h': 7776000, '1d': 15552000 };
const equivalentRanges: Partial<Record<ChartRange, ChartRange[]>> = { '5m': ['24h'], '24h': ['5m'], '1h': ['30d'], '30d': ['1h'], '7d': ['30d', '1h'] };
const fullChartScope = (range: ChartRange, fullHistory: boolean) => fullHistory && candleIntervals.includes(range as CandleInterval);
const chartKey = (address: string, range: ChartRange, fullHistory = false) => `${address.toLowerCase()}-${range}${fullChartScope(range, fullHistory) ? '-full' : ''}`;
const candlePoints = (candles: MarketCandle[]) => candles.map(candle => ({ timestamp: new Date(candle.time * 1000).toISOString(), priceUsd: String(candle.close) }));
const nodeOwnedSource=(source:TokenChart['source'])=>['node','imported','mixed'].includes(source);
function pointsForCandles(chart:TokenChart,candles:MarketCandle[],previous?:TokenChart){
  if(!nodeOwnedSource(chart.source))return candlePoints(candles);
  if(!candles.length)return [];
  const seconds:Record<string,number>={'1m':60,'5m':300,'1h':3600,'4h':14400,'1d':86400};
  const first=candles[0].time*1000,last=(candles.at(-1)!.time+(seconds[chart.resolution??'']??60))*1000;
  const points=new Map<string,TokenChart['points'][number]>();
  for(const point of [...(previous?.points??[]),...(chart.points??[])]){
    const time=Date.parse(point?.timestamp),price=Number(point?.priceUsd);
    if(!Number.isFinite(time)||time<first||time>last||!Number.isFinite(price)||price<=0)continue;
    points.set(point.timestamp,point);
  }
  return [...points.values()].sort((a,b)=>Date.parse(a.timestamp)-Date.parse(b.timestamp));
}
function mergeCandles(previous: MarketCandle[], incoming: MarketCandle[], before?: number) {
  const merged = new Map(previous.map(candle => [candle.time, candle]));
  for (const candle of incoming) {
    if (!Number.isSafeInteger(candle.time) || candle.time <= 0 || (before !== undefined && candle.time >= before) ||
      ![candle.open, candle.high, candle.low, candle.close].every(value => Number.isFinite(value) && value > 0) ||
      !Number.isFinite(candle.volume) || candle.volume < 0) continue;
    merged.set(candle.time, candle);
  }
  return [...merged.values()].sort((a, b) => a.time - b.time);
}
function mergedVolumeCurrency(previous: TokenChart, incoming: TokenChart, incomingCandles: MarketCandle[]) {
  if (incoming.volumeCurrency === 'unknown' && incomingCandles.length) return 'unknown';
  const replaced = new Set(incomingCandles.map(candle => candle.time));
  if (previous.volumeCurrency === 'unknown' && previous.candles.some(candle => !replaced.has(candle.time))) return 'unknown';
  return incoming.volumeCurrency ?? previous.volumeCurrency;
}
function browserStorage(): ChartStorage | undefined {
  try { return typeof window === 'undefined' ? undefined : window.sessionStorage; } catch { return undefined; }
}
export function hasFreshChartSupply(chart: TokenChart, now = Date.now()) {
  const units = Number(chart.marketCapSupply), checked = Date.parse(chart.supplyCheckedAt || '');
  return units > 0 && Number.isFinite(units) && Number.isFinite(checked) && checked <= now && now - checked < supplyLifetime;
}

export function tokenChartNeedsForeground(chart: TokenChart, now = Date.now()) {
  if (chart.loadStatus && chart.loadStatus !== 'queued') return false;
  if (chart.candles.length && hasFreshChartSupply(chart, now)) return false;
  return chart.pending || chart.loadStatus === 'queued';
}

export function tokenChartRefreshDelay(chart: TokenChart, interactive: boolean) {
  const loadingDelay = interactive ? 1000 : 3000;
  if(chart.historyRecoveryPending)return Math.max(1500,Math.min(chart.historyRetryAfterMs??1500,600_000));
  if (chart.retryAfterMs) {
    const delay = Math.max(1000, Math.min(chart.retryAfterMs, 600_000));
    return interactive && chart.pending && (!chart.loadStatus || chart.loadStatus === 'queued') ? Math.min(delay, loadingDelay) : delay;
  }
  return chart.pending ? loadingDelay : 30_000;
}

export function tokenChartHistoryRefreshDelay(chart: TokenChart | null) {
  if (!chart?.fullHistory || !chart.candles.length || !['gmgn', 'geckoterminal','node','imported','mixed'].includes(chart.source) ||
    chart.historyComplete || chart.historyLoadStatus === 'limited') return null;
  return chart.historyRetryAfterMs ? Math.max(1000, Math.min(chart.historyRetryAfterMs, 600_000)) : 1500;
}

/** One browser request per token/interval; transient loading responses retain real cached history. */
export function createTokenChartRequests({ fetcher = fetch, now = Date.now, timeoutMs = 12_000, storage = browserStorage() }: {
  fetcher?: typeof fetch; now?: () => number; timeoutMs?: number; storage?: ChartStorage;
} = {}) {
  const saved = new Map<string, { chart: TokenChart; checked: number; priority?: TokenChartPriority; historyChecked?: number; latestRevision?: number }>();
  let nextLatestRevision = 0;
  type PendingChart = { promise: Promise<TokenChart>; priority: TokenChartPriority; generation: number; controller?: AbortController; releaseForeground?: () => void };
  const pending = new Map<string, PendingChart>();
  const listeners = new Map<string, Set<() => void>>();
  const derived = new Map<string, { source: TokenChart; chart: TokenChart }>();
  let foregroundLoads = 0;
  const priorityListeners = new Set<() => void>();
  const isForegroundLoading = () => foregroundLoads > 0;
  const holdForeground = () => {
    if (++foregroundLoads === 1) for (const listener of priorityListeners) listener();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (--foregroundLoads === 0) for (const listener of priorityListeners) listener();
    };
  };
  const subscribePriority = (listener: () => void) => {
    priorityListeners.add(listener);
    return () => { priorityListeners.delete(listener); };
  };
  try {
    const raw = storage?.getItem(storageKey);
    const entries = raw && raw.length <= 3_000_000 ? JSON.parse(raw) : [];
    if (Array.isArray(entries)) for (const chart of entries.slice(-12) as TokenChart[]) {
      if (!/^0x[0-9a-f]{40}$/.test(chart?.address || '') || !['24h', '7d', '30d', ...candleIntervals].includes(chart.period) ||
        !nodeOwnedSource(chart.source) || !hasFreshChartSupply(chart, now()) ||
        !Array.isArray(chart.candles) || !chart.candles.length || chart.candles.length > (fullChartScope(chart.period, !!chart.fullHistory) ? 2000 : 1000) ||
        !Number.isFinite(Date.parse(chart.updatedAt || '')) || Date.parse(chart.updatedAt!) > now()) continue;
      const fullHistory = fullChartScope(chart.period, !!chart.fullHistory);
      const windowSeconds = fullHistory ? Infinity : chartWindows[chart.period];
      const candles = chart.candles.filter(c => Number.isInteger(c.time) && c.time > 0 && c.time <= now() / 1000 && c.time >= now() / 1000 - windowSeconds &&
        [c.open, c.high, c.low, c.close].every(v => Number.isFinite(v) && v > 0) && Number.isFinite(c.volume) && c.volume >= 0);
      if (!candles.length) continue;
      const points=pointsForCandles(chart,candles).filter(point=>Date.parse(point.timestamp)<=now());
      saved.set(chartKey(chart.address, chart.period, fullHistory), { chart: { ...chart, candles, points, stale: true }, checked: now() - 10_001, historyChecked: now(), latestRevision: ++nextLatestRevision });
    }
  } catch { /* A restricted browser or invalid cache must not prevent chart loading. */ }
  const persist = () => {
    try {
      const entries = [...saved.values()].map(item => item.chart).filter(chart => chart.candles.length && hasFreshChartSupply(chart, now())).slice(-12).map(chart => {
        if (!chart.fullHistory || chart.candles.length <= 2000) return chart;
        const candles = chart.candles.slice(-2000);
        return { ...chart, candles, points: pointsForCandles(chart,candles), historyComplete: false, historyPending: true,
          historyLoadStatus: 'queued' as const, historyRetryAfterMs: 1500, historyBefore: candles[0].time };
      });
      let encoded = JSON.stringify(entries);
      while (encoded.length > 3_000_000 && entries.length) { entries.shift(); encoded = JSON.stringify(entries); }
      storage?.setItem(storageKey, encoded);
    } catch { /* Quota and privacy restrictions leave the memory cache usable. */ }
  };
  const peek = (address: string, range: ChartRange, fullHistory = false): TokenChart | null => {
    const normalized = address.toLowerCase(), key = chartKey(normalized, range, fullHistory);
    const exact = saved.get(key)?.chart;
    if (exact?.candles.length || exact?.loadStatus === 'no_history') return exact;
    if (fullChartScope(range, fullHistory)) {
      const source = peek(normalized, range);
      if (!source?.candles.length) return exact ?? null;
      const previous = derived.get(key);
      if (previous?.source === source) return previous.chart;
      const chart: TokenChart = { ...source, fullHistory: true, historyComplete: false, historyPending: true, historyLoadStatus: 'queued' };
      derived.set(key, { source, chart });
      return chart;
    }
    const source = equivalentRanges[range]?.map(value => saved.get(`${normalized}-${value}`)?.chart)
      .filter((value): value is TokenChart => !!value?.candles.length)
      .sort((a, b) => Date.parse(b.updatedAt || '') - Date.parse(a.updatedAt || ''))[0];
    if (!source) return exact ?? null;
    const previous = derived.get(key);
    if (previous?.source === source) return previous.chart;
    const until = Math.floor(now() / 1000);
    const candles = source.candles.filter(candle => candle.time >= until - chartWindows[range] && candle.time <= until);
    if (!candles.length) return exact ?? null;
    const chart = { ...source, period: range, candles, points: pointsForCandles(source,candles) };
    if (derived.size >= 500 && !derived.has(key)) derived.delete(derived.keys().next().value!);
    derived.set(key, { source, chart });
    return chart;
  };
  const subscribe = (address: string, listener: () => void) => {
    const key = address.toLowerCase();
    const subscribers = listeners.get(key) ?? new Set<() => void>();
    subscribers.add(listener); listeners.set(key, subscribers);
    return () => { subscribers.delete(listener); if (!subscribers.size) listeners.delete(key); };
  };
  const request = (address: string, range: ChartRange, priority: TokenChartPriority = 'chart', retry = false, fullHistory = false, before?: number): Promise<TokenChart> => {
    const normalized = address.toLowerCase();
    fullHistory = fullChartScope(range, fullHistory);
    const key = chartKey(normalized, range, fullHistory), jobKey = before === undefined ? key : `${key}-before-${before}`;
    const existing = pending.get(jobKey);
    if (existing) {
      if (priorityOrder[priority] < priorityOrder[existing.priority]) {
        existing.priority = priority;
        existing.generation++;
        if (priority === 'chart' && !existing.releaseForeground) existing.releaseForeground = holdForeground();
        // The server keeps the shared provider job alive and promotes it on this new request.
        existing.controller?.abort();
      }
      return existing.promise;
    }
    const cached = saved.get(key);
    const cachedChart = peek(normalized, range, fullHistory);
    const historical = fullHistory && before !== undefined;
    const coolingDown = historical ? !!cached?.chart.historyRetryAfterMs && !!cached.chart.historyLoadStatus && cached.chart.historyLoadStatus !== 'queued'
      : !!cached?.chart.loadStatus && cached.chart.loadStatus !== 'queued' && !!cached.chart.retryAfterMs;
    const retryAfterMs = historical ? cached?.chart.historyRetryAfterMs : cached?.chart.retryAfterMs;
    const checked = historical ? cached?.historyChecked ?? cached?.checked : cached?.checked;
    const reuseMs = coolingDown ? Math.max(1000, Math.min(retryAfterMs!, 600_000))
      : cached?.chart.pending || cached?.chart.loadStatus ? 1000 : 10_000;
    // Background provider caches have a longer freshness window; mounting must check foreground freshness once.
    const promoteCached = priority === 'chart' && !!cached?.priority && cached.priority !== 'chart' && !coolingDown;
    if (cached && (!historical || coolingDown) && !promoteCached && (!retry || coolingDown) && now() - checked! < reuseMs) {
      const chart = coolingDown
        ? { ...cachedChart!, [historical ? 'historyRetryAfterMs' : 'retryAfterMs']: Math.max(1000, retryAfterMs! - (now() - checked!)) } : cachedChart!;
      return Promise.resolve(chart);
    }
    const parameter = candleIntervals.includes(range as CandleInterval) ? 'interval' : 'period';
    const jobState: PendingChart = { promise: undefined!, priority, generation: 0,
      releaseForeground: priority === 'chart' ? holdForeground() : undefined };
    const job = (async () => {
      let value: TokenChart;
      for (;;) {
        const generation = jobState.generation;
        const controller = new AbortController();
        jobState.controller = controller;
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const response = await fetcher(`/api/tokens/${encodeURIComponent(normalized)}/chart?${parameter}=${range}&priority=${jobState.priority}${fullHistory ? '&history=full' : ''}${historical ? `&before=${before}` : ''}`, {
            cache: 'no-store', headers: { Accept: 'application/json' }, signal: controller.signal,
          });
          if (!response.ok) throw new Error(`Market chart request failed: ${response.status}`);
          value = await response.json() as TokenChart;
          if (generation !== jobState.generation) continue;
          break;
        } catch (error) {
          if (generation !== jobState.generation) continue;
          throw error;
        } finally { clearTimeout(timer); }
      }
      if (value.address?.toLowerCase() !== normalized || value.period !== range || !Array.isArray(value.candles) || !Array.isArray(value.points) || (fullHistory && value.fullHistory !== true)) {
        throw new Error('Invalid token chart response');
      }
      let chart: TokenChart = value.source === 'gmgn' && !value.volumeCurrency ? { ...value, volumeCurrency: 'unknown' } : value;
      if (fullHistory) {
        const candles = mergeCandles([], chart.candles, before);
        chart = { ...chart, candles, points: pointsForCandles(chart,candles) };
      }
      const current = saved.get(key), retained = current?.chart ?? cachedChart;
      if (historical && retained) {
        const compatible = (value.source === retained.source || nodeOwnedSource(value.source)&&nodeOwnedSource(retained.source)) && value.resolution === retained.resolution;
        const incoming = mergeCandles([], compatible ? chart.candles : [], before);
        const candles = mergeCandles(retained.candles, incoming);
        const cursorProgress = Number.isSafeInteger(value.historyBefore) && value.historyBefore! > 0 && value.historyBefore! < before!;
        const retryable = value.historyLoadStatus === 'queued' || value.historyLoadStatus === 'rate_limited' || value.historyLoadStatus === 'provider_error';
        const limited = (!compatible && !!value.candles.length) || (!value.historyComplete && !incoming.length && !cursorProgress && !retryable);
        chart = { ...retained, candles, points: pointsForCandles(chart,candles,retained), fullHistory: true,
          source:compatible&&retained.source!==value.source?'mixed':retained.source,
          partialHistory:!!retained.partialHistory||!!value.partialHistory,
          volumeCurrency: mergedVolumeCurrency(retained, chart, incoming), historyComplete: limited || nodeOwnedSource(value.source)&&retained.partialHistory ? false : value.historyComplete,
          historyPending: limited ? false : value.historyPending, historyLoadStatus: limited ? 'limited' : value.historyLoadStatus,
          historyRetryAfterMs: limited ? undefined : value.historyRetryAfterMs, historyBefore: value.historyBefore };
      } else if (fullHistory && retained?.fullHistory && (retained.source === chart.source || nodeOwnedSource(retained.source)&&nodeOwnedSource(chart.source)) && retained.resolution === chart.resolution) {
        const incoming = mergeCandles([], chart.candles), candles = mergeCandles(retained.candles, incoming);
        const keepProgress=nodeOwnedSource(chart.source)&&Number.isSafeInteger(retained.historyBefore)&&Number.isSafeInteger(chart.historyBefore)&&retained.historyBefore!<chart.historyBefore!;
        chart = { ...chart, candles, points: pointsForCandles(chart,candles,retained), volumeCurrency: mergedVolumeCurrency(retained, chart, incoming),
          source:retained.source===chart.source?chart.source:'mixed',
          ...(keepProgress?{historyBefore:retained.historyBefore,historyPending:retained.historyPending,historyLoadStatus:retained.historyLoadStatus,
            historyComplete:!!retained.historyComplete&&!value.partialHistory,partialHistory:!!retained.partialHistory||!!value.partialHistory}:{}), };
      }
      if (!historical && !value.candles.length && retained?.candles.length && value.loadStatus !== 'no_history' && (value.pending || value.loadStatus)) {
        chart = { ...retained, ...value, candles: retained.candles, points: retained.points,
          source: retained.source, resolution: retained.resolution, updatedAt: retained.updatedAt,
          partialHistory: retained.partialHistory, stale: true };
        chart.volumeCurrency = retained.volumeCurrency;
      }
      if (!Number.isFinite(Number(value.marketCapSupply)) || Number(value.marketCapSupply) <= 0) {
        const previous = [...saved.values()].map(item => item.chart).filter(item => item.address === normalized && hasFreshChartSupply(item, now()))
          .sort((a, b) => Date.parse(b.supplyCheckedAt!) - Date.parse(a.supplyCheckedAt!))[0];
        if (previous) chart = { ...chart, marketCapSupply: previous.marketCapSupply, supplyCheckedAt: previous.supplyCheckedAt, stale: true };
      }
      if (saved.size >= 500 && !saved.has(key)) saved.delete(saved.keys().next().value!);
      saved.set(key, { chart, checked: historical ? current?.checked ?? now() - 10_001 : now(),
        priority: historical ? current?.priority : jobState.priority,
        historyChecked: fullHistory ? now() : current?.historyChecked,
        latestRevision: historical ? current?.latestRevision : ++nextLatestRevision });
      for (const listener of listeners.get(normalized) ?? []) listener();
      persist();
      return chart;
    })().catch(error => {
      const current = saved.get(key);
      if (!historical || !current?.chart.candles.length) throw error;
      const chart: TokenChart = { ...current.chart, historyPending: false, historyLoadStatus: 'provider_error', historyRetryAfterMs: 3000 };
      saved.set(key, { ...current, chart, historyChecked: now() });
      for (const listener of listeners.get(normalized) ?? []) listener();
      persist();
      return chart;
    }).finally(() => { pending.delete(jobKey); jobState.releaseForeground?.(); });
    jobState.promise = job;
    pending.set(jobKey, jobState);
    return job;
  };
  const requestOlder = (address: string, range: ChartRange, before: number) => {
    if (!Number.isSafeInteger(before) || before <= 0 || !candleIntervals.includes(range as CandleInterval)) return Promise.reject(new Error('Invalid chart history boundary'));
    return request(address, range, 'prefetch', false, true, before);
  };
  const historyDelay = (address: string, range: ChartRange) => {
    const cached = saved.get(chartKey(address, range, true));
    const chart = cached?.chart ?? peek(address, range, true);
    const delay = tokenChartHistoryRefreshDelay(chart);
    if (delay === null || !chart?.historyRetryAfterMs) return delay;
    return Math.max(1000, delay - Math.max(0, now() - (cached?.historyChecked ?? now())));
  };
  const latestRevision = (address: string, range: ChartRange, fullHistory = false) => saved.get(chartKey(address, range, fullHistory))?.latestRevision ?? 0;
  return { request, requestOlder, historyDelay, latestRevision, peek, subscribe, isForegroundLoading, holdForeground, subscribePriority };
}
