import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react';
import { candleIntervals, type CandleInterval, type WatchEntry, type WatchPeriod } from '../shared/intelligence';
import { api, relativeTime } from './lib';
import { t } from './i18n';
import { PriceChange, WatchMarketValue } from './WatchTokenVisuals';
import { useTokenChart } from './useTokenChart';
import { marketChartChanges } from './tokenChartData';
import './tokenMarket.css';

const TokenPriceChart = lazy(() => import('./TokenPriceChart').then(module => ({ default: module.TokenPriceChart })));
type Market = { token: WatchEntry | null; period: WatchPeriod };

export function TokenMarketPanel({ address, identity }: { address: string; identity: ReactNode }) {
  const period: WatchPeriod = '24h';
  const [interval, setInterval] = useState<CandleInterval>('5m');
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
    <div className="token-market-summary"><div className="token-market-identity">{identity}</div>
      <div className="token-market-stats">
        <div><span>{t('Market cap')}</span><strong><WatchMarketValue value={token?.marketCapUsd} /></strong></div>
        <div><span>{t('1h')}</span><strong><PriceChange value={changes ? changes.change1h : token?.change1h} /></strong></div>
        <div><span>{t('24h')}</span><strong><PriceChange value={changes?.periodChange ?? token?.periodChange} /></strong></div>
        <div><span>{t('Tracked volume')} · {t('24h')}</span><strong><WatchMarketValue value={token?.periodVolumeUsd} /></strong></div>
        <div><span>{t('KOLs')} · {t('24h')}</span><strong>{token?.periodKolCount ?? '—'}</strong></div>
        <div><span>{t('Last trade')}</span><strong>{relativeTime(token?.lastTradeAt)}</strong></div>
      </div>
    </div>
    <div className="token-market-toolbar"><h2>{t('Chart')}</h2><div className="candle-interval-tabs" role="tablist" aria-label={t('Candle interval')}>
      {candleIntervals.map(value => <button type="button" role="tab" key={value} id={`token-market-${value}`} aria-selected={interval === value} aria-controls="token-market-details" onClick={() => setInterval(value)}>{value}</button>)}
    </div></div>
    {error && <p className="profile-more-error" role="alert">{t('Token market data unavailable')}</p>}
    <div id="token-market-details" role="tabpanel" aria-labelledby={`token-market-${interval}`} aria-busy={!market && !error}>
      <Suspense fallback={<div className="price-chart-canvas" aria-busy="true" />}><TokenPriceChart address={address} interval={interval} /></Suspense>
    </div>
  </section>;
}
