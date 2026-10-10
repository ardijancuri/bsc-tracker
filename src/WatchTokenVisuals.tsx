import { useEffect, useRef } from 'react';
import type { TokenChart, WatchEntry, WatchPeriod, WatchPricePoint } from '../shared/intelligence';
import { useChartVisibility, useTokenChart } from './useTokenChart';
import { marketChartChanges } from './tokenChartData';
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
export function WatchTokenChange({ token, period = '24h' }: { token: WatchEntry; period?: WatchPeriod }) {
  const { ref, visible } = useChartVisibility();
  const { chart } = useTokenChart(token.address, period, visible);
  const change = marketChartChanges(chart)?.periodChange ?? (period === '24h' ? token.change24h : null);
  return <span ref={ref} title={t(period === '7d' ? '1 week price change' : '24h price change')}><PriceChange value={change} /></span>;
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
export function WatchSparkline({ points = [], label = 'Token price chart', address, period = '24h', priceUsd, onChart }: {
  points?: WatchPricePoint[]; label?: string; address?: string; period?: WatchPeriod; priceUsd?: string | null; onChart?: (chart: TokenChart) => void;
}) {
  const { ref, visible } = useChartVisibility();
  const { chart } = useTokenChart(address, period, visible);
  const callback = useRef(onChart); callback.current = onChart;
  useEffect(() => { if (chart?.points.length) callback.current?.(chart); }, [chart]);
  const graph = sparklineGeometry(chart?.points.length ? chart.points : points);
  const description = graph ? `${t(label)} · ${t(chart?.source === 'geckoterminal' ? 'Market candles' : 'Recorded trades')}` : t(Number(priceUsd) > 0 || chart?.points.length ? 'Latest available quote' : 'Loading market chart…');
  return <span className="watch-sparkline-host" ref={ref} title={description}>
    <svg className={`watch-sparkline ${graph?.change ? graph.change > 0 ? 'positive' : 'negative' : 'watch-neutral'}`} viewBox="0 0 120 40" role="img" aria-label={description}>
      <title>{description}</title>{graph ? <path d={graph.path} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /> : <><path d="M3 20H117" fill="none" stroke="currentColor" strokeWidth="1" strokeDasharray="3 5" />{(Number(priceUsd) > 0 || chart?.points.length) && <circle cx="60" cy="20" r="2.5" fill="currentColor" />}</>}
    </svg>
  </span>;
}
export function WatchTokenDetails({ token }: { token: WatchEntry }) {
  return <div className="watch-token-details"><span><small>{t('Market cap')}</small><strong><WatchMarketValue value={token.marketCapUsd} /></strong></span>
    <span><small>{t('24h')}</small><WatchTokenChange token={token} /></span><WatchSparkline address={token.address} priceUsd={token.priceUsd} points={token.priceHistory} /></div>;
}
