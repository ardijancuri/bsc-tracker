import { lazy, Suspense, useEffect, useState } from 'react';
import { watchPeriods, type WatchEntry, type WatchPeriod } from '../shared/intelligence';
import { api, relativeTime } from './lib';
import { t } from './i18n';
import { PriceChange, WatchMarketValue } from './WatchTokenVisuals';
import { useTokenChart } from './useTokenChart';
import { marketChartChanges } from './tokenChartData';
import './tokenMarket.css';

const labels: Record<WatchPeriod, string> = { '24h': '24h', '7d': '1 week', '30d': '1 month' };
const emptyPoints: NonNullable<WatchEntry['priceHistory']> = [];
const TokenPriceChart = lazy(() => import('./TokenPriceChart').then(module => ({ default: module.TokenPriceChart })));
type Market = { token: WatchEntry | null; period: WatchPeriod };

export function TokenMarketPanel({ address }: { address: string }) {
  const [period, setPeriod] = useState<WatchPeriod>('24h');
  const [market, setMarket] = useState<Market | null>(null);
  const [error, setError] = useState(false);
  const { chart } = useTokenChart(address, period);
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
  const changes = marketChartChanges(chart);
  return <section className="token-market-panel" aria-label={t('Token market details')}>
    <div className="token-market-toolbar"><h2>{t('Chart')} · {t(labels[period])}</h2><div className="watch-period-tabs" role="tablist" aria-label={t('Token time range')}>
      {watchPeriods.map(value => <button type="button" role="tab" key={value} id={`token-market-${value}`} aria-selected={period === value} aria-controls="token-market-details" onClick={() => setPeriod(value)}>{t(labels[value])}</button>)}
    </div></div>
    {error && <p className="profile-more-error" role="alert">{t('Token market data unavailable')}</p>}
    <div id="token-market-details" role="tabpanel" aria-labelledby={`token-market-${period}`} aria-busy={!market && !error}>
      <div className="token-market-stats">
        <div><span>{t('Market cap')}</span><strong><WatchMarketValue value={token?.marketCapUsd} /></strong></div>
        <div><span>{t('1h')}</span><strong><PriceChange value={changes ? changes.change1h : token?.change1h} /></strong></div>
        <div><span>{t(labels[period])}</span><strong><PriceChange value={changes?.periodChange ?? token?.periodChange} /></strong></div>
        <div><span>{t('Tracked volume')} · {t(labels[period])}</span><strong><WatchMarketValue value={token?.periodVolumeUsd} /></strong></div>
        <div><span>{t('KOLs')} · {t(labels[period])}</span><strong>{token?.periodKolCount ?? '—'}</strong></div>
        <div><span>{t('Last trade')}</span><strong>{relativeTime(token?.lastTradeAt)}</strong></div>
      </div>
      <Suspense fallback={<div className="price-chart-canvas" aria-busy="true" />}><TokenPriceChart address={address} period={period} fallbackPoints={token?.priceHistory || emptyPoints} priceUsd={token?.priceUsd} quoteAt={token?.lastTradeAt} /></Suspense>
    </div>
  </section>;
}
