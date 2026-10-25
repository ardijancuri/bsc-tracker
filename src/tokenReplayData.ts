import type { TokenChart, WatchPeriod } from '../shared/intelligence';
import type { Token } from './types';
import { hasFreshChartSupply } from './tokenChartRequest';

export const tokenReplayPeriods = ['24h', '7d', '30d'] as const;
export interface TokenReplayPoint { time: number; marketCap: number }
export interface TokenReplayData {
  token: Pick<Token, 'address' | 'symbol' | 'name' | 'logoUrl'>;
  period: WatchPeriod; points: TokenReplayPoint[]; resolutionMs: number;
  source: 'gmgn' | 'geckoterminal' | 'coinmarketcap' | 'node' | 'mixed' | 'imported';
  partialHistory: boolean; sparseHistory: boolean; generatedAt: string;
  marketCapEstimated?: boolean;
}
const periods: Record<WatchPeriod, number> = { '24h': 86400_000, '7d': 7 * 86400_000, '30d': 30 * 86400_000 };
// The existing chart endpoint refreshes weekly/monthly history every 5/10 min.
const observationMaxAge: Record<WatchPeriod, number> = { '24h': 180_000, '7d': 360_000, '30d': 660_000 };
const resolutions: Record<string, number> = { '30s': 30_000, '1m': 60_000, '5m': 300_000, '15m': 900_000, '1h': 3600_000, '4h': 14400_000, '1d': 86400_000 };

export class TokenReplayPreparationError extends Error {
  constructor(message: string, readonly retryAfterMs = 0) { super(message); this.name = 'TokenReplayPreparationError'; }
}

/** Freeze genuine observations; neither recorded fills nor token metadata are a market curve. */
export function prepareTokenReplayData(token: Token, period: WatchPeriod, chart: TokenChart, now = Date.now()): TokenReplayData {
  const reject = () => { throw new TokenReplayPreparationError('Token market history is unavailable. Try another period or retry.'); };
  if (!/^0x[0-9a-f]{40}$/i.test(token.address) || !tokenReplayPeriods.includes(period) || chart.address?.toLowerCase() !== token.address.toLowerCase()
    || chart.period !== period || !['gmgn', 'geckoterminal', 'coinmarketcap', 'node', 'mixed', 'imported'].includes(chart.source)) return reject();
  if (!hasFreshChartSupply(chart, now)) throw new TokenReplayPreparationError('Token market cap is still loading. Retry shortly.', chart.supplyPending || chart.pending ? 1500 : 0);
  const updated = Date.parse(chart.updatedAt ?? ''), resolutionMs = resolutions[chart.resolution], supply = Number(chart.marketCapSupply);
  if (!Number.isFinite(updated) || updated > now + 1000 || now - updated > observationMaxAge[period] || !resolutionMs || !Array.isArray(chart.candles)
    || chart.candles.length > 50_000) return reject();
  const candles = new Map<number, TokenChart['candles'][number]>();
  for (const candle of chart.candles) {
    if (!Number.isSafeInteger(candle.time) || candle.time <= 0 || candle.time * 1000 > updated
      || ![candle.open, candle.high, candle.low, candle.close].every(value => Number.isFinite(value) && value > 0)
      || candle.high < Math.max(candle.open, candle.close) || candle.low > Math.min(candle.open, candle.close)) continue;
    candles.set(candle.time, candle);
  }
  const cutoff = now - periods[period], points = new Map<number, TokenReplayPoint>();
  const modern = ['node', 'mixed', 'imported'].includes(chart.source);
  if (modern) {
    // Database observations keep their original swap/state timestamps. Minute
    // bucket boundaries must not manufacture a flat ending or extra volume.
    if (chart.stale) return reject();
    for (const point of [...chart.points, ...(chart.currentQuote ? [chart.currentQuote] : [])]) {
      const time = Date.parse(point.timestamp), price = Number(point.priceUsd);
      const observedCap = 'marketCapUsd' in point ? Number(point.marketCapUsd) : NaN;
      if (Number.isFinite(time) && time >= cutoff && time <= updated && time <= now && Number.isFinite(price) && price > 0)
        points.set(time, { time, marketCap: Number.isFinite(observedCap) && observedCap > 0 ? observedCap : price * supply });
    }
  } else for (const candle of [...candles.values()].sort((a, b) => a.time - b.time)) {
    const start = candle.time * 1000, end = Math.min(start + resolutionMs, updated, now);
    if (end < cutoff || end <= start) continue;
    if (!points.size && start >= cutoff) points.set(start, { time: start, marketCap: candle.open * supply });
    points.set(end, { time: end, marketCap: candle.close * supply });
  }
  const samples = [...points.values()].filter(point => Number.isFinite(point.marketCap) && point.marketCap > 0).sort((a, b) => a.time - b.time);
  if (samples.length < 2 || samples.at(-1)!.time <= samples[0].time) return reject();
  return { token: { address: token.address.toLowerCase(), symbol: token.symbol, name: token.name, logoUrl: token.logoUrl }, period,
    points: samples, resolutionMs, source: chart.source as TokenReplayData['source'], generatedAt: new Date(now).toISOString(),
    marketCapEstimated: chart.marketCapEstimated, partialHistory: chart.partialHistory === true || samples[0].time > cutoff + resolutionMs,
    sparseHistory: samples.some((point, index) => index > 0 && point.time - samples[index - 1].time > resolutionMs * 2) };
}

/** Unobserved gaps hold the last observation instead of inventing a moving price. */
export function tokenReplaySnapshot(data: TokenReplayData, progress: number) {
  const points = data.points, first = points[0], last = points.at(-1)!;
  const phase = Math.min(1, Math.max(0, Number.isFinite(progress) ? progress : 0) / .94);
  const time = first.time + (last.time - first.time) * phase;
  let low = 0, high = points.length - 1;
  while (low < high) { const mid = Math.ceil((low + high) / 2); if (points[mid].time <= time) low = mid; else high = mid - 1; }
  const previous = points[low], next = points[low + 1];
  const inGap = !!next && next.time - previous.time > data.resolutionMs * 2;
  const ratio = next && !inGap ? (time - previous.time) / (next.time - previous.time) : 0;
  const marketCap = previous.marketCap + (next && !inGap ? (next.marketCap - previous.marketCap) * ratio : 0);
  const peak = Math.max(marketCap, ...points.slice(0, low + 1).map(point => point.marketCap));
  return { time, marketCap, changePercent: (marketCap / first.marketCap - 1) * 100, peak, index: low, inGap };
}

const cancelled = () => new DOMException('Video export cancelled.', 'AbortError');
/** Read the shared database chart; only the worker collects financial evidence. */
export async function loadTokenReplay(token: Token, period: WatchPeriod, signal: AbortSignal, options: {
  fetcher?: typeof fetch; now?: () => number; onWait?: (retryAt: number) => void;
} = {}): Promise<TokenReplayData> {
  const now = options.now ?? Date.now, fetcher = options.fetcher ?? fetch, deadline = now() + 90_000;
  if (!/^0x[0-9a-f]{40}$/i.test(token.address) || !tokenReplayPeriods.includes(period)) {
    throw new TokenReplayPreparationError('Token market history is unavailable. Try another period or retry.');
  }
  for (let attempt = 0; ; attempt++) {
    if (signal.aborted) throw cancelled();
    const controller = new AbortController(), abort = () => controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, Math.min(12_000, Math.max(1, deadline - now())));
    let problem = new TokenReplayPreparationError('Token market history is still loading. Retry shortly.', 1500);
    try {
      const response = await fetcher(`/api/tokens/${encodeURIComponent(token.address.toLowerCase())}/chart?period=${period}&priority=chart&workload=replay`,
        { signal: controller.signal, cache: 'no-store' });
      const retry = response.headers.get('Retry-After'), seconds = retry ? Number(retry) : NaN;
      const retryMs = Number.isFinite(seconds) ? seconds * 1000 : retry ? Date.parse(retry) - now() : 0;
      if (response.ok) {
        const chart = await response.json() as TokenChart;
        try { return prepareTokenReplayData(token, period, chart, now()); }
        catch (error) {
          if (!(error instanceof TokenReplayPreparationError)) throw error;
          problem = error;
          if ((chart.pending || chart.supplyPending || chart.loadStatus === 'rate_limited' || chart.loadStatus === 'provider_error') && !problem.retryAfterMs) {
            problem = new TokenReplayPreparationError(problem.message, chart.retryAfterMs || 1500);
          }
          if (chart.retryAfterMs) problem = new TokenReplayPreparationError(problem.message, Math.max(problem.retryAfterMs, chart.retryAfterMs));
        }
      } else if ([429, 502, 503, 504].includes(response.status)) {
        problem = new TokenReplayPreparationError('Token market history is still loading. Retry shortly.', Math.max(1500, retryMs));
      } else throw new TokenReplayPreparationError('Token market history is unavailable. Try another period or retry.');
    } catch (error) {
      if (signal.aborted) throw cancelled();
      if (error instanceof TokenReplayPreparationError) problem = error;
      else problem = new TokenReplayPreparationError('Token market history is still loading. Retry shortly.', 2000);
    } finally { clearTimeout(timer); signal.removeEventListener('abort', abort); }
    if (signal.aborted) throw cancelled();
    const delay = Math.max(1000, problem.retryAfterMs);
    if (!problem.retryAfterMs || attempt >= 7 || now() + delay + 12_000 > deadline) throw problem;
    options.onWait?.(now() + delay);
    await new Promise<void>((resolve, reject) => {
      const abortWait = () => { clearTimeout(wait); reject(cancelled()); };
      const wait = setTimeout(() => { signal.removeEventListener('abort', abortWait); resolve(); }, delay);
      signal.addEventListener('abort', abortWait, { once: true });
      if (signal.aborted) { signal.removeEventListener('abort', abortWait); abortWait(); }
    });
    options.onWait?.(0);
  }
}
