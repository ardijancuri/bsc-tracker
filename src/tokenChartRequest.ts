import { candleIntervals, type CandleInterval, type ChartRange, type TokenChart } from '../shared/intelligence';

type ChartStorage = Pick<Storage, 'getItem' | 'setItem'>;
export type TokenChartPriority = 'chart' | 'prefetch' | 'sparkline';
const priorityOrder: Record<TokenChartPriority, number> = { chart: 0, prefetch: 1, sparkline: 2 };
const storageKey = 'kollens:market-charts:v1';
const supplyLifetime = 2 * 86400_000;
const chartWindows: Record<ChartRange, number> = { '24h': 86400, '7d': 604800, '30d': 2592000, '1m': 86400, '5m': 86400, '1h': 2592000, '4h': 7776000, '1d': 15552000 };
const equivalentRanges: Partial<Record<ChartRange, ChartRange[]>> = { '5m': ['24h'], '24h': ['5m'], '1h': ['30d'], '30d': ['1h'], '7d': ['30d', '1h'] };
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
  if (chart.retryAfterMs) {
    const delay = Math.max(1000, Math.min(chart.retryAfterMs, 600_000));
    return interactive && chart.pending && (!chart.loadStatus || chart.loadStatus === 'queued') ? Math.min(delay, loadingDelay) : delay;
  }
  return chart.pending ? loadingDelay : 30_000;
}

/** One browser request per token/interval; transient loading responses retain real cached history. */
export function createTokenChartRequests({ fetcher = fetch, now = Date.now, timeoutMs = 12_000, storage = browserStorage() }: {
  fetcher?: typeof fetch; now?: () => number; timeoutMs?: number; storage?: ChartStorage;
} = {}) {
  const saved = new Map<string, { chart: TokenChart; checked: number; priority?: TokenChartPriority }>();
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
        !['geckoterminal', 'gmgn', 'coinmarketcap'].includes(chart.source) || !hasFreshChartSupply(chart, now()) ||
        !Array.isArray(chart.candles) || !chart.candles.length || chart.candles.length > 1000 ||
        !Number.isFinite(Date.parse(chart.updatedAt || '')) || Date.parse(chart.updatedAt!) > now()) continue;
      const windowSeconds = chartWindows[chart.period];
      const candles = chart.candles.filter(c => Number.isInteger(c.time) && c.time <= now() / 1000 && c.time >= now() / 1000 - windowSeconds &&
        [c.open, c.high, c.low, c.close].every(v => Number.isFinite(v) && v > 0) && Number.isFinite(c.volume) && c.volume >= 0);
      if (!candles.length) continue;
      const volumeCurrency = chart.source === 'gmgn' && chart.volumeCurrency !== 'usd' ? 'unknown' : chart.volumeCurrency;
      saved.set(`${chart.address}-${chart.period}`, { chart: { ...chart, candles, volumeCurrency, stale: true }, checked: now() - 10_001 });
    }
  } catch { /* A restricted browser or invalid cache must not prevent chart loading. */ }
  const persist = () => {
    try {
      const entries = [...saved.values()].map(item => item.chart).filter(chart => chart.candles.length && hasFreshChartSupply(chart, now())).slice(-12);
      storage?.setItem(storageKey, JSON.stringify(entries));
    } catch { /* Quota and privacy restrictions leave the memory cache usable. */ }
  };
  const peek = (address: string, range: ChartRange): TokenChart | null => {
    const normalized = address.toLowerCase(), key = `${normalized}-${range}`;
    const exact = saved.get(key)?.chart;
    if (exact?.candles.length || exact?.loadStatus === 'no_history') return exact;
    const source = equivalentRanges[range]?.map(value => saved.get(`${normalized}-${value}`)?.chart)
      .filter((value): value is TokenChart => !!value?.candles.length)
      .sort((a, b) => Date.parse(b.updatedAt || '') - Date.parse(a.updatedAt || ''))[0];
    if (!source) return exact ?? null;
    const previous = derived.get(key);
    if (previous?.source === source) return previous.chart;
    const until = Math.floor(now() / 1000);
    const candles = source.candles.filter(candle => candle.time >= until - chartWindows[range] && candle.time <= until);
    if (!candles.length) return exact ?? null;
    const chart = { ...source, period: range, candles, points: candles.map(candle => ({ timestamp: new Date(candle.time * 1000).toISOString(), priceUsd: String(candle.close) })) };
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
  const request = (address: string, range: ChartRange, priority: TokenChartPriority = 'chart', retry = false): Promise<TokenChart> => {
    const normalized = address.toLowerCase();
    const key = `${normalized}-${range}`;
    const existing = pending.get(key);
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
    const cachedChart = peek(normalized, range);
    const coolingDown = !!cached?.chart.loadStatus && cached.chart.loadStatus !== 'queued' && !!cached.chart.retryAfterMs;
    const reuseMs = coolingDown ? Math.max(1000, Math.min(cached!.chart.retryAfterMs!, 600_000))
      : cached?.chart.pending || cached?.chart.loadStatus ? 1000 : 10_000;
    // Background provider caches have a longer freshness window; mounting must check foreground freshness once.
    const promoteCached = priority === 'chart' && !!cached?.priority && cached.priority !== 'chart' && !coolingDown;
    if (cached && !promoteCached && (!retry || coolingDown) && now() - cached.checked < reuseMs) {
      const chart = coolingDown
        ? { ...cachedChart!, retryAfterMs: Math.max(1000, cached.chart.retryAfterMs! - (now() - cached.checked)) } : cachedChart!;
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
          const response = await fetcher(`/api/tokens/${encodeURIComponent(normalized)}/chart?${parameter}=${range}&priority=${jobState.priority}`, {
            headers: { Accept: 'application/json' }, signal: controller.signal,
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
      if (value.address?.toLowerCase() !== normalized || value.period !== range || !Array.isArray(value.candles) || !Array.isArray(value.points)) {
        throw new Error('Invalid token chart response');
      }
      let chart: TokenChart = value.source === 'gmgn' && !value.volumeCurrency ? { ...value, volumeCurrency: 'unknown' } : value;
      if (!value.candles.length && cachedChart?.candles.length && value.loadStatus !== 'no_history' && (value.pending || value.loadStatus)) {
        chart = { ...cachedChart, ...value, candles: cachedChart.candles, points: cachedChart.points,
          source: cachedChart.source, resolution: cachedChart.resolution, updatedAt: cachedChart.updatedAt,
          partialHistory: cachedChart.partialHistory, stale: true };
        chart.volumeCurrency = cachedChart.volumeCurrency;
      }
      if (!Number.isFinite(Number(value.marketCapSupply)) || Number(value.marketCapSupply) <= 0) {
        const previous = [...saved.values()].map(item => item.chart).filter(item => item.address === normalized && hasFreshChartSupply(item, now()))
          .sort((a, b) => Date.parse(b.supplyCheckedAt!) - Date.parse(a.supplyCheckedAt!))[0];
        if (previous) chart = { ...chart, marketCapSupply: previous.marketCapSupply, supplyCheckedAt: previous.supplyCheckedAt, stale: true };
      }
      if (saved.size >= 500 && !saved.has(key)) saved.delete(saved.keys().next().value!);
      saved.set(key, { chart, checked: now(), priority: jobState.priority });
      for (const listener of listeners.get(normalized) ?? []) listener();
      persist();
      return chart;
    })().finally(() => { pending.delete(key); jobState.releaseForeground?.(); });
    jobState.promise = job;
    pending.set(key, jobState);
    return job;
  };
  return { request, peek, subscribe, isForegroundLoading, holdForeground, subscribePriority };
}
