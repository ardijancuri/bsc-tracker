import type { WatchEntry, WatchPricePoint } from '../shared/intelligence';
import { compact } from './lib';
import { getLocale, t } from './i18n';

export function WatchMarketValue({ value }: { value: string | null | undefined }) {
  const amount = value == null ? NaN : Number(value);
  const tier = !Number.isFinite(amount) || amount < 0 ? 'missing' : amount < 10_000 ? 'white' : amount < 30_000 ? 'green' : amount < 150_000 ? 'blue' : 'yellow';
  return <span className={`watch-market-value watch-market-${tier}`}>{tier === 'missing' ? '—' : compact(value, true)}</span>;
}
export function PriceChange({ value }: { value?: string | null }) {
  const number = value == null ? NaN : Number(value);
  return <span className={Number.isFinite(number) ? number > 0 ? 'positive' : number < 0 ? 'negative' : 'watch-neutral' : 'watch-neutral'}>
    {Number.isFinite(number) ? `${number > 0 ? '+' : ''}${new Intl.NumberFormat(getLocale(), { maximumFractionDigits: 2 }).format(number)}%` : '—'}
  </span>;
}
export function sparklineGeometry(points: WatchPricePoint[]) {
  const samples = points.map(p => ({ time: Date.parse(p.timestamp), price: Number(p.priceUsd) }))
    .filter(p => Number.isFinite(p.time) && Number.isFinite(p.price) && p.price > 0).sort((a, b) => a.time - b.time);
  if (samples.length < 2) return null;
  const low = Math.min(...samples.map(p => p.price)), high = Math.max(...samples.map(p => p.price));
  const duration = samples.at(-1)!.time - samples[0].time;
  if (!duration) return null;
  const path = samples.map((p, index) => `${index ? 'L' : 'M'}${(3 + (p.time - samples[0].time) / duration * 114).toFixed(2)},${(high === low ? 20 : 36 - (p.price - low) / (high - low) * 32).toFixed(2)}`).join(' ');
  const change = (samples.at(-1)!.price / samples[0].price - 1) * 100;
  return { path, change };
}
export function WatchSparkline({ points = [], label = 'Recorded trade prices in the last 24 hours' }: { points?: WatchPricePoint[]; label?: string }) {
  const graph = sparklineGeometry(points);
  if (!graph) return <span className="watch-chart-empty" title={t('More priced trades are needed for a chart')}>—</span>;
  return <svg className={`watch-sparkline ${graph.change > 0 ? 'positive' : graph.change < 0 ? 'negative' : 'watch-neutral'}`} viewBox="0 0 120 40" role="img" aria-label={t(label)}>
    <title>{t(label)}</title>
    <path d={graph.path} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
  </svg>;
}
export function WatchTokenDetails({ token }: { token: WatchEntry }) {
  return <div className="watch-token-details"><span><small>{t('Market cap')}</small><strong><WatchMarketValue value={token.marketCapUsd} /></strong></span>
    <span><small>{t('24h')}</small><PriceChange value={token.change24h} /></span><WatchSparkline points={token.priceHistory} /></div>;
}
