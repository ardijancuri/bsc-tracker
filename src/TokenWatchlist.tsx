import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Check, Copy, Search } from 'lucide-react';
import { AlertSettings, FeatureIdentity, FollowButton, KolAlertButton, useWatchlist } from './Intelligence';
import { loadWatchlist, watchlistIdentityChanged } from './watchlistClient';
import { AccountWatchlistNotice, useAccount } from './Account';
import { useTokenTranslation } from './TokenName';
import { relativeTime, shortAddress } from './lib';
import { t } from './i18n';
import { watchPeriods, type TokenChart, type WatchEntry, type Watchlist, type WatchPeriod } from '../shared/intelligence';
import { PriceChange, WatchMarketValue, WatchSparkline } from './WatchTokenVisuals';
import { compareWatchTokens, type WatchSortKey } from './watchlistSort';
import { marketChartChanges } from './tokenChartData';
import { tokenChartIntent } from './tokenChartIntent';
import './tokenWatchlist.css';
import { TelegramAlertsSettings } from './TelegramNotifications';

const periodLabels: Record<WatchPeriod, string> = { '24h': '24h', '7d': '1 week', '30d': '1 month' };
const chartLabels: Record<WatchPeriod, string> = { '24h': 'Token price chart · 24h', '7d': 'Token price chart · 1 week', '30d': 'Token price chart · 1 month' };

function WatchSortIcon({ direction }: { direction?: 'ascending' | 'descending' }) {
  return <svg className={direction ? 'watch-sort-icon' : 'watch-sort-icon watch-sort-idle'} width="6" height="11" viewBox="0 0 10 18" fill="currentColor" aria-hidden="true">
    {direction ? <path d={direction === 'ascending' ? 'M5 6 10 12H0Z' : 'M0 6h10l-5 6Z'} /> : <><path d="M5 0 10 6H0Z" /><path d="M0 12h10l-5 6Z" /></>}
  </svg>;
}

function WatchContractAddress({ address }: { address: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  useEffect(() => {
    if (state === 'idle') return;
    const timer = window.setTimeout(() => setState('idle'), 2000);
    return () => window.clearTimeout(timer);
  }, [state]);
  const copy = async () => {
    try { await navigator.clipboard.writeText(address); setState('copied'); }
    catch { setState('failed'); }
  };
  return <button type="button" className="watch-copy-address" onClick={() => void copy()}
    title={`${t('Copy {label}', { label: t('Token contract address') })}: ${address}`}
    aria-label={`${t(state === 'copied' ? '{label} copied' : 'Copy {label}', { label: t('Token contract address') })}: ${address}`} aria-live="polite">
    {state === 'copied' ? t('Copied') : state === 'failed' ? t('Copy failed') : shortAddress(address, 7)}{state === 'copied' ? <Check size={13} /> : <Copy size={13} />}
  </button>;
}

function WatchTokenRow({ token, period, onChart }: { token: WatchEntry; period: WatchPeriod; onChart: (chart: TokenChart) => void }) {
  const navigate = useNavigate();
  const translation = useTokenTranslation(token);
  const name = token.symbol || token.name || shortAddress(token.address);
  const chartIntent = tokenChartIntent(token.address);
  return <tr onMouseEnter={chartIntent.onMouseEnter} onMouseLeave={chartIntent.onMouseLeave} onClick={event => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey ||
      (event.target as Element).closest('a,button,input,select,textarea,[role="button"]')) return;
    chartIntent.onPointerDown();
    navigate(`/token/${token.address}`);
  }}>
    <td className="watch-star"><FollowButton kind="token" address={token.address} label={token.name || token.symbol} /></td>
    <td className="watch-token-name"><Link to={`/token/${token.address}`} {...chartIntent} title={token.name || name}>
      <span className="token-avatar"><span>{name.slice(0, 1)}</span>{token.logoUrl && <img src={token.logoUrl} alt="" loading="lazy" onError={event => { event.currentTarget.style.visibility = 'hidden'; }} />}</span>
      <strong>{name}</strong>{translation?.sourceText && translation.sourceText !== name && <span className="watch-inline-source">{translation.sourceText}</span>}{translation?.englishName && <span className="watch-inline-translation" lang="en" title={translation.englishName}>{translation.englishName}</span>}
    </Link></td>
    <td className="watch-contract"><WatchContractAddress address={token.address} /></td>
    <td className="watch-extra"><PriceChange value={token.change1h} /></td><td><PriceChange value={token.periodChange} /></td>
    <td><WatchMarketValue value={token.marketCapUsd} /></td><td className="watch-extra"><WatchMarketValue value={token.periodVolumeUsd} /></td><td className="watch-extra">{token.periodKolCount ?? '—'}</td>
    <td className="watch-last-trade" title={token.lastTradeAt || undefined}>{relativeTime(token.lastTradeAt)}</td><td className="watch-chart"><WatchSparkline address={token.address} period={period} priceUsd={token.priceUsd} points={token.priceHistory} label={chartLabels[period]} onChart={onChart} /></td>
  </tr>;
}

export function TokenWatchlistPage() {
  const watch = useWatchlist();
  const account = useAccount();
  const [params, setParams] = useSearchParams();
  const kind = params.get('tab') === 'kols' ? 'kol' : 'token';
  const setKind = (value: 'token' | 'kol') => setParams(current => {
    const next = new URLSearchParams(current);
    if (value === 'kol') next.set('tab', 'kols'); else next.delete('tab');
    return next;
  }, { replace: true });
  const [query, setQuery] = useState('');
  const [period, setPeriod] = useState<WatchPeriod>('24h');
  const [history, setHistory] = useState<Watchlist | null>(null);
  const [historyError, setHistoryError] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [sort, setSort] = useState<{ key: WatchSortKey; ascending: boolean }>({ key: 'name', ascending: true });
  const [chartHistory, setChartHistory] = useState<Record<string, TokenChart>>({});
  const chartLoaded = useCallback((chart: TokenChart) => setChartHistory(current => ({ ...current, [`${chart.address}-${chart.period}`]: chart })), []);
  const membership = watch.data.items.filter(item => item.kind === 'token').map(item => item.address).sort().join(',');
  useEffect(() => {
    setHistory(null); setHistoryError(false); setLoadingHistory(false);
    if (kind !== 'token' || period === '24h' || !watch.loaded || watch.busy || !membership) return;
    let cancelled = false;
    const refresh = async () => {
      setLoadingHistory(true);
      try { const value = await loadWatchlist(`/api/watchlist?period=${period}`, account.state.user?.id || 'guest'); if (!cancelled) { setHistory(value); setHistoryError(false); } }
      catch (reason) { if (!cancelled) { if (watchlistIdentityChanged(reason)) void account.refresh(); else setHistoryError(true); } }
      finally { if (!cancelled) setLoadingHistory(false); }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 15000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [kind, period, membership, watch.loaded, watch.busy, account.revision]);
  const tokens = useMemo(() => {
    const selected = new Map(history?.period === period ? history.items.map(item => [item.address, item]) : []);
    return watch.data.items.filter(item => item.kind === 'token').map(item => period === '24h' ? item : selected.get(item.address) || { ...item, periodChange: null, periodVolumeUsd: null, periodKolCount: undefined, priceHistory: [] });
  }, [watch.data.items, history, period]);
  const visible = useMemo(() => tokens.map(item => { const chart = chartHistory[`${item.address}-${period}`]; const changes = marketChartChanges(chart);
    return chart?.points.length ? { ...item, priceHistory: chart.points, ...(changes || {}) } : item; })
    .filter(item => `${item.name || ''} ${item.symbol || ''} ${item.address}`.toLowerCase().includes(query.toLowerCase().trim())).sort((a, b) => compareWatchTokens(a, b, sort.key, sort.ascending)), [tokens, query, sort, chartHistory, period]);
  const column = (key: WatchSortKey, label: string, className = '') => <th className={className} scope="col" aria-sort={sort.key === key ? sort.ascending ? 'ascending' : 'descending' : 'none'}><button type="button" title={key === 'chart' ? t('Sort by chart price change') : undefined} onClick={() => setSort(current => ({ key, ascending: current.key === key ? !current.ascending : key === 'name' || key === 'address' }))}>
    {t(label)}{key === 'chart' && <> · {t(periodLabels[period])}</>}<WatchSortIcon direction={sort.key === key ? sort.ascending ? 'ascending' : 'descending' : undefined} /></button></th>;
  return <div className="page token-watchlist-page">
    <div className="token-watchlist-heading"><h1>{t('Watchlist')}</h1><AccountWatchlistNotice /></div>
    <div className="watchlist-kind-tabs" role="tablist" aria-label={t('Favorites')}>
      {(['token', 'kol'] as const).map(value => <button type="button" key={value} role="tab" id={`watchlist-${value}-tab`} aria-selected={kind === value} aria-controls={`watchlist-${value}-panel`} onClick={() => setKind(value)}>{t(value === 'token' ? 'Tokens' : 'KOLs')}<span>{watch.data.items.filter(item => item.kind === value).length}</span></button>)}
    </div>
    {kind === 'token' ? <section id="watchlist-token-panel" role="tabpanel" aria-labelledby="watchlist-token-tab">
    <div className="token-watchlist-toolbar"><div className="watch-search-actions"><label className="watch-token-search"><Search size={15} /><input aria-label={t('Search watched tokens')} placeholder={t('Search watched tokens')} value={query} onChange={event => setQuery(event.target.value)} /></label><Link className="feature-button" to="/tokens">{t('Add tokens')}</Link></div>
      <div className="watch-period-controls"><div className="watch-period-tabs feature-tabs" role="tablist" aria-label={t('Token time range')}>{watchPeriods.map(value => <button type="button" key={value} role="tab" aria-selected={period === value} aria-controls="watch-token-details" id={`watch-period-${value}`} onClick={() => setPeriod(value)}>{t(periodLabels[value])}</button>)}</div></div></div>
    {(watch.error || historyError) && <p className="profile-more-error" role="alert">{t(watch.error || 'Watchlist unavailable')}</p>}
    <div id="watch-token-details" role="tabpanel" aria-labelledby={`watch-period-${period}`} aria-busy={loadingHistory} className="token-watchlist-table-wrap"><table className="token-watchlist-table"><thead><tr>
      <th scope="col" className="watch-star" aria-label={t('Watchlist')} />{column('name', 'Name', 'watch-token-name')}{column('address', 'Contract address', 'watch-contract')}{column('change1h', '1h', 'watch-extra')}{column('periodChange', periodLabels[period])}{column('marketCapUsd', 'Market cap')}{column('periodVolumeUsd', 'Tracked volume', 'watch-extra')}
      {column('periodKolCount', 'KOLs', 'watch-extra')}{column('lastTradeAt', 'Last trade', 'watch-last-trade')}{column('chart', 'Chart', 'watch-chart')}
    </tr></thead><tbody>{visible.map(token => <WatchTokenRow key={token.address} token={token} period={period} onChart={chartLoaded} />)}</tbody></table></div>
    {!visible.length && <div className="watch-token-empty"><strong>{!watch.loaded ? t('Loading…') : query ? t('No matching tokens') : t('No followed tokens')}</strong>{watch.loaded && !query && <Link to="/tokens">{t('Star tokens to add them here')}</Link>}</div>}
    </section> : <section id="watchlist-kol-panel" className="watchlist-kol-layout" role="tabpanel" aria-labelledby="watchlist-kol-tab">
      <aside className="watchlist-kol-settings" aria-label={t('Telegram alerts')}><TelegramAlertsSettings /><AlertSettings label="Radar filters" /></aside>
      <div className="watchlist-kol-following"><div className="token-watchlist-toolbar"><h2>{t('KOLs')}</h2><Link className="feature-button" to="/leaderboard">{t('Add KOLs')}</Link></div>
      <div className="data-table feature-table watch-kol-list">{watch.data.items.filter(item => item.kind === 'kol').map(item => <div className="watch-row" key={item.address}><Link to={`/kol/${item.address}`}><FeatureIdentity address={item.address} name={item.name} image={item.avatarUrl} /></Link><div className="telegram-kol-controls"><KolAlertButton address={item.address} label={item.name} /><FollowButton kind="kol" address={item.address} label={item.name} /></div></div>)}</div>
      {!watch.data.items.some(item => item.kind === 'kol') && <div className="watch-token-empty"><strong>{t(watch.loaded ? 'No followed KOLs' : 'Loading…')}</strong>{watch.loaded && <Link to="/leaderboard">{t('Star KOLs to add them here')}</Link>}</div>}
      </div>
    </section>}
    {kind === 'token' && <AlertSettings />}
  </div>;
}
