import { candleIntervals, type CandleInterval, type ChartRange, type TokenChart } from '../shared/intelligence';

type ChartStorage = Pick<Storage, 'getItem' | 'setItem'>;
const storageKey = 'kollens:market-charts:v1';
const supplyLifetime = 2 * 86400_000;
function browserStorage(): ChartStorage | undefined {
  try { return typeof window === 'undefined' ? undefined : window.sessionStorage; } catch { return undefined; }
}
export function hasFreshChartSupply(chart: TokenChart, now = Date.now()) {
  const units = Number(chart.marketCapSupply), checked = Date.parse(chart.supplyCheckedAt || '');
  return units > 0 && Number.isFinite(units) && Number.isFinite(checked) && checked <= now && now - checked < supplyLifetime;
}

/** One browser request per token/interval; transient loading responses retain real cached history. */
export function createTokenChartRequests({ fetcher = fetch, now = Date.now, timeoutMs = 12_000, storage = browserStorage() }: {
  fetcher?: typeof fetch; now?: () => number; timeoutMs?: number; storage?: ChartStorage;
} = {}) {
  const saved = new Map<string, { chart: TokenChart; checked: number }>();
  const pending = new Map<string, Promise<TokenChart>>();
  try {
    const raw = storage?.getItem(storageKey);
    const entries = raw && raw.length <= 3_000_000 ? JSON.parse(raw) : [];
    if (Array.isArray(entries)) for (const chart of entries.slice(-12) as TokenChart[]) {
      if (!/^0x[0-9a-f]{40}$/.test(chart?.address || '') || !['24h', '7d', '30d', ...candleIntervals].includes(chart.period) ||
        !['geckoterminal', 'gmgn', 'coinmarketcap'].includes(chart.source) || !hasFreshChartSupply(chart, now()) ||
        !Array.isArray(chart.candles) || !chart.candles.length || chart.candles.length > 1000 ||
        !Number.isFinite(Date.parse(chart.updatedAt || '')) || Date.parse(chart.updatedAt!) > now()) continue;
      const windowSeconds = { '24h': 86400, '7d': 604800, '30d': 2592000, '5m': 86400, '1h': 2592000, '4h': 7776000, '1d': 15552000 }[chart.period];
      const candles = chart.candles.filter(c => Number.isInteger(c.time) && c.time <= now() / 1000 && c.time >= now() / 1000 - windowSeconds &&
        [c.open, c.high, c.low, c.close].every(v => Number.isFinite(v) && v > 0) && Number.isFinite(c.volume) && c.volume >= 0);
      if (!candles.length) continue;
      saved.set(`${chart.address}-${chart.period}`, { chart: { ...chart, candles, stale: true }, checked: now() - 10_001 });
    }
  } catch { /* A restricted browser or invalid cache must not prevent chart loading. */ }
  const persist = () => {
    try {
      const entries = [...saved.values()].map(item => item.chart).filter(chart => chart.candles.length && hasFreshChartSupply(chart, now())).slice(-12);
      storage?.setItem(storageKey, JSON.stringify(entries));
    } catch { /* Quota and privacy restrictions leave the memory cache usable. */ }
  };
  const peek = (address: string, range: ChartRange) => saved.get(`${address.toLowerCase()}-${range}`)?.chart ?? null;
  const request = (address: string, range: ChartRange): Promise<TokenChart> => {
    const normalized = address.toLowerCase();
    const key = `${normalized}-${range}`;
    const cached = saved.get(key);
    if (cached && now() - cached.checked < (cached.chart.pending || cached.chart.loadStatus ? 1000 : 10_000)) return Promise.resolve(cached.chart);
    const existing = pending.get(key);
    if (existing) return existing;
    const parameter = candleIntervals.includes(range as CandleInterval) ? 'interval' : 'period';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const job = (async () => {
      const response = await fetcher(`/api/tokens/${encodeURIComponent(normalized)}/chart?${parameter}=${range}`, {
        headers: { Accept: 'application/json' }, signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Market chart request failed: ${response.status}`);
      const value = await response.json() as TokenChart;
      if (value.address?.toLowerCase() !== normalized || value.period !== range || !Array.isArray(value.candles) || !Array.isArray(value.points)) {
        throw new Error('Invalid token chart response');
      }
      let chart = value;
      if (!value.candles.length && cached?.chart.candles.length && value.loadStatus !== 'no_history' && (value.pending || value.loadStatus)) {
        chart = { ...cached.chart, ...value, candles: cached.chart.candles, points: cached.chart.points,
          source: cached.chart.source, resolution: cached.chart.resolution, updatedAt: cached.chart.updatedAt,
          partialHistory: cached.chart.partialHistory, stale: true };
        chart.volumeCurrency = cached.chart.volumeCurrency;
      }
      if (!Number.isFinite(Number(value.marketCapSupply)) || Number(value.marketCapSupply) <= 0) {
        const previous = [...saved.values()].map(item => item.chart).filter(item => item.address === normalized && hasFreshChartSupply(item, now()))
          .sort((a, b) => Date.parse(b.supplyCheckedAt!) - Date.parse(a.supplyCheckedAt!))[0];
        if (previous) chart = { ...chart, marketCapSupply: previous.marketCapSupply, supplyCheckedAt: previous.supplyCheckedAt, stale: true };
      }
      if (saved.size >= 500 && !saved.has(key)) saved.delete(saved.keys().next().value!);
      saved.set(key, { chart, checked: now() });
      persist();
      return chart;
    })().finally(() => { clearTimeout(timer); pending.delete(key); });
    pending.set(key, job);
    return job;
  };
  return { request, peek };
}
