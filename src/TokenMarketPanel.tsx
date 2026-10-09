import { useEffect, useState } from 'react';
import { watchPeriods, type WatchEntry, type WatchPeriod } from '../shared/intelligence';
import { api, relativeTime } from './lib';
import { getLocale, t } from './i18n';
import { PriceChange, sparklineGeometry, WatchMarketValue } from './WatchTokenVisuals';
import './tokenMarket.css';

const labels: Record<WatchPeriod, string> = { '24h': '24h', '7d': '1 week', '30d': '1 month' };
const chartLabels: Record<WatchPeriod, string> = { '24h': 'Recorded trade prices in the last 24 hours', '7d': 'Recorded trade prices in the last week', '30d': 'Recorded trade prices in the last 30 days' };
type Market = { token: WatchEntry | null; period: WatchPeriod };

export function TokenMarketPanel({ address }: { address: string }) {
  const [period, setPeriod] = useState<WatchPeriod>('24h');
  const [market, setMarket] = useState<Market | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setMarket(null); setError(false);
    const refresh = async () => {
      try {
        const result = await api<Market>(`/api/tokens/${address}/market?period=${period}`);
        if (!cancelled) { setMarket(result); setError(false); }
      } catch { if (!cancelled) setError(true); }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 20000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [address, period]);
  const token = market?.period === period && market.token?.address === address.toLowerCase() ? market.token : null;
  const points = token?.priceHistory || [];
  const graph = sparklineGeometry(points);
  const timestamps = points.filter(point => Number.isFinite(Date.parse(point.timestamp)) && Number(point.priceUsd) > 0).map(point => Date.parse(point.timestamp)).sort((a, b) => a - b);
  const timeLabel = (value: number) => new Intl.DateTimeFormat(getLocale(), period === '24h' ? { hour: '2-digit', minute: '2-digit' } : { month: 'short', day: 'numeric' }).format(value);
  return <section className="token-market-panel" aria-label={t('Token market details')}>
    <div className="token-market-toolbar"><h2>{t('Chart')} · {t(labels[period])}</h2><div className="watch-period-tabs" role="tablist" aria-label={t('Token time range')}>
      {watchPeriods.map(value => <button type="button" role="tab" key={value} id={`token-market-${value}`} aria-selected={period === value} aria-controls="token-market-details" onClick={() => setPeriod(value)}>{t(labels[value])}</button>)}
    </div></div>
    {error && <p className="profile-more-error" role="alert">{t('Token market data unavailable')}</p>}
    <div id="token-market-details" role="tabpanel" aria-labelledby={`token-market-${period}`} aria-busy={!market && !error}>
      <div className="token-market-stats">
        <div><span>{t('Market cap')}</span><strong><WatchMarketValue value={token?.marketCapUsd} /></strong></div>
        <div><span>{t('1h')}</span><strong><PriceChange value={token?.change1h} /></strong></div>
        <div><span>{t(labels[period])}</span><strong><PriceChange value={token?.periodChange} /></strong></div>
        <div><span>{t('Tracked volume')} · {t(labels[period])}</span><strong><WatchMarketValue value={token?.periodVolumeUsd} /></strong></div>
        <div><span>{t('KOLs')} · {t(labels[period])}</span><strong>{token?.periodKolCount ?? '—'}</strong></div>
        <div><span>{t('Last trade')}</span><strong>{relativeTime(token?.lastTradeAt)}</strong></div>
      </div>
      <div className="token-market-chart">
        {graph ? <><svg viewBox="0 0 120 40" preserveAspectRatio="none" className={graph.change > 0 ? 'positive' : graph.change < 0 ? 'negative' : 'watch-neutral'} role="img" aria-label={t(chartLabels[period])}>
          <title>{t(chartLabels[period])}</title><path d={graph.path} fill="none" stroke="currentColor" strokeWidth="2" vectorEffect="non-scaling-stroke" strokeLinecap="round" strokeLinejoin="round" />
        </svg><div className="token-market-chart-times"><span>{timeLabel(timestamps[0])}</span><span>{timeLabel(timestamps.at(-1)!)}</span></div></> : <div className="token-market-chart-empty">{t(!market && !error ? 'Loading…' : 'More priced trades are needed for a chart')}</div>}
      </div>
    </div>
  </section>;
}
