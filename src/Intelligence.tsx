import { t } from './i18n';
import { TelegramKolBell } from './TelegramNotifications';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ChevronDown, ExternalLink, Star } from 'lucide-react';
import { api, relativeTime, shortAddress } from './lib';
import { TokenName } from './TokenName';
import { WatchTokenDetails } from './WatchTokenVisuals';
import { tokenChartIntent } from './tokenChartIntent';
import { subscribeToUpdates } from './updateStream';
import { createCoalescedRefresh } from './coalescedRefresh';
import { accountCheckEvent, notifyWatchlistTabs, useAccount, watchlistSyncKey } from './Account';
import { loadWatchlist, mutateWatchlist, watchlistIdentityChanged } from './watchlistClient';
import './tokenWatchlist.css';
import { signalLabels, type Position, type Signal, type Watchlist } from '../shared/intelligence';

const emptyWatchlist: Watchlist = { items: [] };
type WatchContextValue = { data: Watchlist; busy: boolean; loaded: boolean; error: string | null; refresh: () => Promise<void>; toggle: (kind: 'kol' | 'token', address: string) => Promise<void> };
const WatchContext = createContext<WatchContextValue | null>(null);
export function WatchlistProvider({ children }: { children: ReactNode }) {
  const account = useAccount();
  const [data, setData] = useState<Watchlist>(emptyWatchlist);
  const [loaded, setLoaded] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const current = useRef(data), locked = useRef(false), revision = useRef(0);
  const dataOwner = useRef<string | null>(null);
  const auth = useRef(account); auth.current = account;
  const accept = useCallback((value: Watchlist) => { dataOwner.current = auth.current.state.user?.id || 'guest'; current.current = value; setData(value); setLoaded(true); }, []);
  const refresh = useCallback(async () => {
    if (locked.current || !auth.current.loaded || auth.current.checking || auth.current.busy || auth.current.unavailable) return;
    const version = revision.current;
    try { const value = await loadWatchlist('/api/watchlist', auth.current.state.user?.id || 'guest'); if (!locked.current && version === revision.current) { accept(value); setError(null); } }
    catch (reason) { if (!locked.current && version === revision.current) { if (watchlistIdentityChanged(reason)) { await auth.current.refresh(); } else setError('Watchlist unavailable'); } }
  }, [accept]);
  useEffect(() => {
    const invalidate = () => { revision.current++; locked.current = false; setBusy(false); };
    const storage = (event: StorageEvent) => { if (event.key === watchlistSyncKey || event.key === null) { invalidate(); void refresh(); } };
    window.addEventListener(accountCheckEvent, invalidate); window.addEventListener('storage', storage);
    const timer = window.setInterval(() => void refresh(), 15000);
    return () => { revision.current++; window.removeEventListener(accountCheckEvent, invalidate); window.removeEventListener('storage', storage); window.clearInterval(timer); };
  }, [refresh]);
  useEffect(() => {
    revision.current++; locked.current = false; setBusy(false); accept(emptyWatchlist); setLoaded(false); setError(null);
  }, [account.revision, accept]);
  useEffect(() => { if (account.loaded && !account.checking && !account.busy && !account.unavailable) void refresh(); }, [account.loaded, account.checking, account.busy, account.unavailable, account.revision, refresh]);
  const save = async (url: string, method: 'PUT' | 'DELETE') => {
    if (locked.current || !loaded || account.checking || account.busy || account.unavailable) return;
    locked.current = true; const version = ++revision.current; setBusy(true); setError(null);
    try {
      const value = await mutateWatchlist(url, method, account.state.user?.id || 'guest');
      if (version === revision.current) { accept(value); notifyWatchlistTabs(); }
    } catch (reason) {
      if (version !== revision.current) return;
      if (watchlistIdentityChanged(reason)) { await account.refresh(); return; }
      setError(reason instanceof Error ? reason.message : 'Could not save watchlist');
    } finally { if (version === revision.current) { locked.current = false; setBusy(false); } }
  };
  const toggle = async (kind: 'kol' | 'token', address: string) => {
    const key = address.toLowerCase();
    const followed = current.current.items.some(item => item.kind === kind && item.address === key);
    await save(`/api/watchlist/items/${kind}/${encodeURIComponent(key)}`, followed ? 'DELETE' : 'PUT');
  };
  const ownerMatches = dataOwner.current === (account.state.user?.id || 'guest');
  return <WatchContext.Provider value={{ data: ownerMatches ? data : emptyWatchlist, busy: busy || account.checking || account.busy || account.unavailable, loaded: loaded && ownerMatches, error, refresh, toggle }}>{children}{error && <div className="watchlist-error" role="alert">{t(error)}</div>}</WatchContext.Provider>;
}
export function useWatchlist() { const value = useContext(WatchContext); if (!value) throw new Error('Watchlist provider missing'); return value; }
export function FollowButton({ kind, address, label }: { kind: 'kol' | 'token'; address: string; label?: string | null }) {
  const watch = useWatchlist();
  const followed = watch.data.items.some(item => item.kind === kind && item.address === address.toLowerCase());
  const title = t('{action} {name}', { action: t(followed ? 'Unfollow' : 'Follow'), name: label || shortAddress(address) });
  return <button type="button" className={`follow-button${followed ? ' followed' : ''}`} aria-label={title} title={title} aria-pressed={followed}
    disabled={!watch.loaded || watch.busy} onClick={event => { event.preventDefault(); event.stopPropagation(); void watch.toggle(kind, address); }}><Star size={18} fill={followed ? 'currentColor' : 'none'} /></button>;
}
export function KolAlertButton({ address, label }: { address: string; label?: string | null }) {
  const watch = useWatchlist();
  const followed = watch.loaded && watch.data.items.some(item => item.kind === 'kol' && item.address === address.toLowerCase());
  return followed ? <TelegramKolBell address={address} label={label || shortAddress(address)} /> : null;
}
export function FeatureTabs({ page }: { page: 'trades' }) {
  const [params] = useSearchParams();
  const tabs = [['trades', 'Trades'], ['radar', 'Radar'], ['watchlist', 'Watchlist']];
  const value = params.get('view');
  const selected = tabs.some(([key]) => key === value) ? value : page;
  return <nav className="feature-tabs" aria-label={t("Activity views")}>{tabs.map(([key, title]) => <Link key={key} className={selected === key ? 'selected' : ''} aria-current={selected === key ? 'page' : undefined} to={`/${page}${key === page ? '' : `?view=${key}`}`}>{t(title)}</Link>)}</nav>;
}
export function FeatureIdentity({ address, name, symbol, image, token = false }: { address: string; name: string | null; symbol?: string | null; image?: string | null; token?: boolean }) {
  return <span className="identity"><span className={token ? 'token-avatar' : 'avatar'}><span>{(symbol || name || '?').slice(0, 1).toUpperCase()}</span>{image && <img src={image} alt="" onError={event => { event.currentTarget.style.display = 'none'; }} />}</span>{token ? <TokenName token={{ address, symbol, name }} addressSubtitle /> : <span className="identity-copy"><strong>{name || shortAddress(address)}</strong><small>{shortAddress(address)}</small></span>}</span>;
}
function FeatureEmpty({ children }: { children: ReactNode }) { return <div className="feature-empty">{children}</div>; }
function useFeatureData<T>(url: string | null, initial: T) {
  const [result, setResult] = useState({ url, data: initial, error: false, loading: true });
  useEffect(() => {
    if (!url) { setResult({ url, data: initial, loading: false, error: false }); return; }
    const refresh = createCoalescedRefresh(async signal => {
      try { const data = await api<T>(url, { signal }); if (!signal.aborted) setResult({ url, data, loading: false, error: false }); }
      catch { if (!signal.aborted) setResult(current => ({ ...current, url, loading: false, error: true })); }
    });
    setResult({ url, data: initial, error: false, loading: true }); void refresh.refresh();
    const timer = window.setInterval(() => void refresh.refresh(), 30000), unsubscribe = subscribeToUpdates(() => void refresh.refresh());
    return () => { refresh.dispose(); window.clearInterval(timer); unsubscribe(); };
  }, [url]);
  return result.url === url ? result : { url, data: initial, error: false, loading: true };
}
function useFeatureList<T extends { id?: string; tokenAddress?: string }>(url: string) {
  const result = useFeatureData<{ items: T[]; nextCursor: string | null }>(url, { items: [], nextCursor: null });
  const [extra, setExtra] = useState<{ url: string; items: T[]; cursor: string | null | undefined; visible: number }>({ url, items: [], cursor: undefined, visible: 20 });
  const [busy, setBusy] = useState(false), [error, setError] = useState(false);
  const requestNumber = useRef(0);
  useEffect(() => { requestNumber.current++; setBusy(false); setError(false); setExtra({ url, items: [], cursor: undefined, visible: 20 }); }, [url]);
  const state = extra.url === url ? extra : { url, items: [], cursor: undefined, visible: 20 };
  const latest = new Map(result.data.items.map(item => [item.id || item.tokenAddress, item]));
  const all = [...new Map([...result.data.items, ...state.items].map(item => [item.id || item.tokenAddress, latest.get(item.id || item.tokenAddress) || item])).values()];
  const cursor = state.cursor === undefined ? result.data.nextCursor : state.cursor;
  const loadMore = async () => {
    if (busy) return;
    if (all.length > state.visible) { setExtra({ ...state, visible: state.visible + 20 }); return; }
    if (!cursor) return;
    const number = ++requestNumber.current; setBusy(true); setError(false);
    try {
      const page = await api<{ items: T[]; nextCursor: string | null }>(`${url}&cursor=${encodeURIComponent(cursor)}`);
      if (number === requestNumber.current) setExtra({ url, items: [...all, ...page.items], cursor: page.nextCursor, visible: state.visible + 20 });
    } catch { if (number === requestNumber.current) setError(true); }
    finally { if (number === requestNumber.current) setBusy(false); }
  };
  return { ...result, items: all.slice(0, state.visible), more: Boolean(cursor) || all.length > state.visible, busy, moreError: error, loadMore };
}
function SignalRow({ signal, open = false }: { signal: Signal; open?: boolean }) {
  return <details className={`signal-row${signal.corrected ? ' corrected' : ''}`} open={open || undefined}>
    <summary><Link to={`/token/${signal.tokenAddress}`} {...tokenChartIntent(signal.tokenAddress)} onClick={event => event.stopPropagation()}><FeatureIdentity token address={signal.tokenAddress} name={signal.tokenName} symbol={signal.tokenSymbol} image={signal.tokenLogoUrl} /></Link>
      <span className={`signal-label ${signal.kind}`}><strong>{t(signalLabels[signal.kind])}</strong><small>{signal.corrected ? t("Corrected") : signal.kind === 'clustered_buys' ? t('{count} KOLs · {minutes}m', { count: signal.walletAddresses.length, minutes: signal.windowMinutes }) : signal.kind === 'repeat_buy' ? t('{count} buys · {minutes}m', { count: signal.evidence.length, minutes: signal.windowMinutes }) : signal.kols[0]?.name || ''}</small></span>
      <span className="signal-participants" title={signal.kols.map(kol => kol.name || shortAddress(kol.address)).join(', ')}>{signal.kols.slice(0, 3).map(kol => <Link key={kol.address} to={`/kol/${kol.address}`} onClick={event => event.stopPropagation()}>{kol.name || shortAddress(kol.address)}</Link>)}{signal.kols.length > 3 && <span>+{signal.kols.length - 3}</span>}</span>
      <span className="signal-time">{relativeTime(signal.timestamp)}<ChevronDown size={14} /></span></summary>
    <div className="signal-evidence"><div className="signal-observed"><span>{t("Published")}{' '}{relativeTime(signal.publishedAt)}</span>{signal.corrected && <span>{t("Chain correction")}</span>}</div>{signal.evidence.map(item => <div key={item.id}>
      {item.walletAddress ? <Link to={`/kol/${item.walletAddress}`}>{item.kolName || shortAddress(item.walletAddress)}</Link> : <span>{t("Launch state")}</span>}
      <span className={item.side === 'sell' ? 'negative' : item.side === 'buy' ? 'positive' : ''}>{item.side === 'state' ? t("Confirmed") : t(item.side)}</span>
      <a href={item.txHash ? `https://bscscan.com/tx/${item.txHash}` : `https://bscscan.com/block/${item.blockNumber}`} target="_blank" rel="noopener noreferrer">{relativeTime(item.timestamp)}<ExternalLink size={12} /></a>
    </div>)}</div>
  </details>;
}
export function RadarFeed({ watched = false }: { watched?: boolean }) {
  const [params] = useSearchParams();
  const watch = useWatchlist();
  const following = watched ? [...watch.data.items.map(item => `${item.kind}:${item.address}`).sort().join('|')].reduce((value, character) => (value * 31 + character.charCodeAt(0)) | 0, 0) : 0;
  const list = useFeatureList<Signal>(`/api/signals?limit=20${watched ? `&watched=1&following=${following}` : ''}`);
  const selectedId = params.get('signal');
  const selected = useFeatureData<{ signal: Signal | null }>(selectedId ? `/api/signals/${selectedId}` : null, { signal: null });
  const pinned = selectedId && selected.data.signal && !list.items.some(signal => signal.id === selectedId) ? selected.data.signal : null;
  return <><div className="data-table feature-table">{pinned && <SignalRow signal={pinned} open />}{list.items.map(signal => <SignalRow key={signal.id} signal={signal} open={signal.id === selectedId} />)}{!list.items.length && !pinned && <FeatureEmpty>{list.loading ? t("Loading radar…") : list.error ? t("Radar unavailable") : watched ? t("No watched signals yet") : t("No signals yet")}</FeatureEmpty>}</div>
    {list.more && <button className="profile-load-more" disabled={list.busy} onClick={() => void list.loadMore()}>{list.busy ? t("Loading…") : t("Load more")}</button>}{list.moreError && <p className="profile-more-error">{t("Could not load more. Try again.")}</p>}</>;
}
export function WatchlistView() {
  const watch = useWatchlist();
  return <><div className="watchlist-grid">{(['kol', 'token'] as const).map(kind => <section key={kind}><div className="table-toolbar"><h2>{kind === 'kol' ? t("KOLs") : t("Tokens")}</h2><span>{watch.data.items.filter(item => item.kind === kind).length}</span>{kind === 'token' && <Link className="watch-token-more" to="/watchlist">{t('View token watchlist')}<ExternalLink size={12} /></Link>}</div><div className="data-table feature-table">{watch.data.items.filter(item => item.kind === kind).map(item => <div className={`watch-row${kind === 'token' ? ' watch-row-token' : ''}`} key={`${kind}:${item.address}`}><div><Link to={`/${kind}/${item.address}`}><FeatureIdentity token={kind === 'token'} address={item.address} name={item.name} symbol={kind === 'token' ? item.symbol : undefined} image={kind === 'token' ? item.logoUrl : item.avatarUrl} /></Link>{kind === 'token' && <WatchTokenDetails token={item} />}</div><div className="telegram-kol-controls">{kind === 'kol' && <KolAlertButton address={item.address} label={item.name} />}<FollowButton kind={kind} address={item.address} label={item.name} /></div></div>)}{!watch.data.items.some(item => item.kind === kind) && <FeatureEmpty>{watch.loaded ? t(kind === 'kol' ? 'No followed KOLs' : 'No followed tokens') : t("Loading…")}</FeatureEmpty>}</div></section>)}</div>
    {watch.error && <p className="profile-more-error" role="alert">{t(watch.error)}</p>}<div className="table-toolbar watch-signals-heading"><h2>{t("Watched signals")}</h2></div><RadarFeed watched />
  </>;
}
export function usePositions(kind: 'kol' | 'token', address: string, tokens?: string[], enabled = true) {
  const query = kind === 'kol' && tokens?.length ? `?tokens=${tokens.slice(0, 100).join(',')}` : '';
  const result = useFeatureData<{ items: Position[] }>(enabled ? `/api/${kind === 'kol' ? 'kols' : 'tokens'}/${address}/positions${query}` : null, { items: [] });
  return useMemo(() => new Map(result.data.items.map(position => [kind === 'kol' ? position.tokenAddress : position.walletAddress, position])), [result.data.items, kind]);
}
export function PositionBadge({ position }: { position?: Position }) {
  const fresh = position?.confirmed === true || position?.confirmed === undefined && position?.checkedAt && Date.now() - Date.parse(position.checkedAt) <= 300_000;
  const status = fresh ? position.status : 'Unknown';
  return <details className="position-status"><summary className={`position-badge status-${status.toLowerCase()}`}>{t(status)}</summary><div className="position-popover"><span>{t("Balance")}<strong title={position?.balance || ''}>{position?.balance ?? '—'}</strong></span><span>{t("Checked")}<strong>{relativeTime(position?.checkedAt)}</strong></span>{position?.lastMovementAt && <span>{t("Last movement")}<strong>{relativeTime(position.lastMovementAt)}</strong></span>}</div></details>;
}