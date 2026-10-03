import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Bell, BellOff, ChevronDown, ExternalLink, Star, X } from 'lucide-react';
import { api, compact, relativeTime, shortAddress } from './lib';
import { defaultPreferences, signalKinds, signalLabels, type AlertPreferences, type LaunchItem, type LaunchState, type Position, type Signal, type TelegramStatus, type Watchlist } from '../shared/intelligence';

const emptyTelegram: TelegramStatus = { available: false, state: 'disconnected', username: null, recipient: null, linkUrl: null, expiresAt: null };
const emptyWatchlist: Watchlist = { items: [], preferences: defaultPreferences, telegram: emptyTelegram };
async function mutate<T>(url: string, method: string, body?: unknown): Promise<T> {
  const response = await fetch(url, { method, headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Try again shortly');
  return result as T;
}
type WatchContextValue = { data: Watchlist; busy: boolean; loaded: boolean; error: string | null; refresh: () => Promise<void>; toggle: (kind: 'kol' | 'token', address: string) => Promise<void>; preferences: (value: AlertPreferences) => Promise<void>; telegram: (action: 'link' | 'confirm' | 'disconnect') => Promise<TelegramStatus | null>; clear: () => Promise<void> };
const WatchContext = createContext<WatchContextValue | null>(null);
export function WatchlistProvider({ children }: { children: ReactNode }) {
  const [data, setData] = useState<Watchlist>(emptyWatchlist);
  const [loaded, setLoaded] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const current = useRef(data), locked = useRef(false), revision = useRef(0);
  const accept = useCallback((value: Watchlist) => { current.current = value; setData(value); setLoaded(true); }, []);
  const refresh = useCallback(async () => {
    if (locked.current) return;
    const version = revision.current;
    try { const value = await api<Watchlist>('/api/watchlist'); if (!locked.current && version === revision.current) { accept(value); setError(null); } }
    catch { if (!locked.current && version === revision.current) setError('Watchlist unavailable'); }
  }, [accept]);
  useEffect(() => {
    void refresh();
    const focus = () => void refresh(); window.addEventListener('focus', focus);
    const timer = window.setInterval(focus, 15000);
    return () => { window.removeEventListener('focus', focus); window.clearInterval(timer); };
  }, [refresh]);
  const save = async (body: unknown) => {
    if (locked.current) return;
    locked.current = true; revision.current++; setBusy(true); setError(null);
    try { accept(await mutate<Watchlist>('/api/watchlist', 'PUT', body)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not save watchlist'); }
    finally { locked.current = false; setBusy(false); }
  };
  const toggle = async (kind: 'kol' | 'token', address: string) => {
    const key = address.toLowerCase();
    const items = current.current.items.map(item => ({ kind: item.kind, address: item.address }));
    const followed = items.some(item => item.kind === kind && item.address === key);
    await save({ items: followed ? items.filter(item => item.kind !== kind || item.address !== key) : [...items, { kind, address: key }] });
  };
  const telegram = async (action: 'link' | 'confirm' | 'disconnect') => {
    if (locked.current) return null;
    locked.current = true; revision.current++; setBusy(true); setError(null);
    try {
      const value = await mutate<TelegramStatus>(action === 'confirm' ? '/api/telegram/confirm' : '/api/telegram/link', action === 'disconnect' ? 'DELETE' : 'POST');
      accept({ ...current.current, telegram: value }); return value;
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Telegram unavailable'); return null; }
    finally { locked.current = false; setBusy(false); }
  };
  const clear = async () => {
    if (locked.current) return;
    locked.current = true; revision.current++; setBusy(true);
    try { accept(await mutate<Watchlist>('/api/watchlist', 'DELETE')); setError(null); }
    catch { setError('Could not clear watchlist'); }
    finally { locked.current = false; setBusy(false); }
  };
  return <WatchContext.Provider value={{ data, busy, loaded, error, refresh, toggle, preferences: value => save({ preferences: value }), telegram, clear }}>{children}{error && <div className="watchlist-error" role="alert">{error}</div>}</WatchContext.Provider>;
}
export function useWatchlist() { const value = useContext(WatchContext); if (!value) throw new Error('Watchlist provider missing'); return value; }
export function FollowButton({ kind, address, label }: { kind: 'kol' | 'token'; address: string; label?: string | null }) {
  const watch = useWatchlist();
  const followed = watch.data.items.some(item => item.kind === kind && item.address === address.toLowerCase());
  const title = `${followed ? 'Unfollow' : 'Follow'} ${label || shortAddress(address)}`;
  return <button type="button" className={`follow-button${followed ? ' followed' : ''}`} aria-label={title} title={title} aria-pressed={followed}
    disabled={!watch.loaded || watch.busy} onClick={event => { event.preventDefault(); event.stopPropagation(); void watch.toggle(kind, address); }}><Star size={15} fill={followed ? 'currentColor' : 'none'} /></button>;
}
export function FeatureTabs({ page }: { page: 'trades' | 'tokens' }) {
  const [params] = useSearchParams();
  const tabs = page === 'trades' ? [['trades', 'Trades'], ['radar', 'Radar'], ['watchlist', 'Watchlist']] : [['tokens', 'Tokens'], ['launches', 'Launches']];
  const value = params.get('view');
  const selected = tabs.some(([key]) => key === value) ? value : page;
  return <nav className="feature-tabs" aria-label={page === 'trades' ? 'Activity views' : 'Token views'}>{tabs.map(([key, title]) => <Link key={key} className={selected === key ? 'selected' : ''} aria-current={selected === key ? 'page' : undefined} to={`/${page}${key === page ? '' : `?view=${key}`}`}>{title}</Link>)}</nav>;
}
function FeatureIdentity({ address, name, image, token = false }: { address: string; name: string | null; image?: string | null; token?: boolean }) {
  return <span className="identity"><span className={token ? 'token-avatar' : 'avatar'}><span>{(name || '?').slice(0, 1).toUpperCase()}</span>{image && <img src={image} alt="" onError={event => { event.currentTarget.style.display = 'none'; }} />}</span><span className="identity-copy"><strong>{name || shortAddress(address)}</strong><small>{shortAddress(address)}</small></span></span>;
}
function FeatureEmpty({ children }: { children: ReactNode }) { return <div className="feature-empty">{children}</div>; }
function useFeatureData<T>(url: string | null, initial: T) {
  const [result, setResult] = useState({ url, data: initial, error: false, loading: true });
  useEffect(() => {
    if (!url) { setResult({ url, data: initial, loading: false, error: false }); return; }
    let active = true;
    const refresh = () => void api<T>(url).then(data => { if (active) setResult({ url, data, loading: false, error: false }); }).catch(() => { if (active) setResult(current => ({ ...current, url, loading: false, error: true })); });
    setResult({ url, data: initial, error: false, loading: true }); refresh();
    const timer = window.setInterval(refresh, 30000), events = new EventSource('/api/stream');
    events.addEventListener('update', refresh);
    return () => { active = false; window.clearInterval(timer); events.close(); };
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
    <summary><Link to={`/token/${signal.tokenAddress}`} onClick={event => event.stopPropagation()}><FeatureIdentity token address={signal.tokenAddress} name={signal.tokenSymbol || signal.tokenName} image={signal.tokenLogoUrl} /></Link>
      <span className={`signal-label ${signal.kind}`}><strong>{signalLabels[signal.kind]}</strong><small>{signal.corrected ? 'Corrected' : signal.kind === 'clustered_buys' ? `${signal.walletAddresses.length} KOLs · ${signal.windowMinutes}m` : signal.kind === 'repeat_buy' ? `${signal.evidence.length} buys · ${signal.windowMinutes}m` : signal.kols[0]?.name || ''}</small></span>
      <span className="signal-participants" title={signal.kols.map(kol => kol.name || shortAddress(kol.address)).join(', ')}>{signal.kols.slice(0, 3).map(kol => <Link key={kol.address} to={`/kol/${kol.address}`} onClick={event => event.stopPropagation()}>{kol.name || shortAddress(kol.address)}</Link>)}{signal.kols.length > 3 && <span>+{signal.kols.length - 3}</span>}</span>
      <span className="signal-time">{relativeTime(signal.timestamp)}<ChevronDown size={14} /></span></summary>
    <div className="signal-evidence"><div className="signal-observed"><span>Published {relativeTime(signal.publishedAt)}</span>{signal.corrected && <span>Chain correction</span>}</div>{signal.evidence.map(item => <div key={item.id}>
      {item.walletAddress ? <Link to={`/kol/${item.walletAddress}`}>{item.kolName || shortAddress(item.walletAddress)}</Link> : <span>Launch state</span>}
      <span className={item.side === 'sell' ? 'negative' : item.side === 'buy' ? 'positive' : ''}>{item.side === 'state' ? 'Confirmed' : item.side}</span>
      <a href={item.txHash ? `https://bscscan.com/tx/${item.txHash}` : `https://bscscan.com/block/${item.blockNumber}`} target="_blank" rel="noopener noreferrer">{relativeTime(item.timestamp)}<ExternalLink size={12} /></a>
    </div>)}</div>
  </details>;
}
export function RadarFeed({ watched = false }: { watched?: boolean }) {
  const [params] = useSearchParams();
  const watch = useWatchlist();
  const following = watched ? [...watch.data.items.map(item => `${item.kind}:${item.address}`).sort().join('|')].reduce((value, character) => (value * 31 + character.charCodeAt(0)) | 0, 0) : 0;
  const profile = `${watch.data.preferences.windowMinutes}:${watch.data.preferences.minBuyers}:${watch.data.preferences.categories.join(',')}:${following}`;
  const list = useFeatureList<Signal>(`/api/signals?limit=20&profile=${profile}${watched ? '&watched=1' : ''}`);
  const selectedId = params.get('signal');
  const selected = useFeatureData<{ signal: Signal | null }>(selectedId ? `/api/signals/${selectedId}` : null, { signal: null });
  const pinned = selectedId && selected.data.signal && !list.items.some(signal => signal.id === selectedId) ? selected.data.signal : null;
  return <>{!watched && <AlertSettings connections={false} />}<div className="data-table feature-table">{pinned && <SignalRow signal={pinned} open />}{list.items.map(signal => <SignalRow key={signal.id} signal={signal} open={signal.id === selectedId} />)}{!list.items.length && !pinned && <FeatureEmpty>{list.loading ? 'Loading radar…' : list.error ? 'Radar unavailable' : watched ? 'No watched signals yet' : 'No signals yet'}</FeatureEmpty>}</div>
    {list.more && <button className="profile-load-more" disabled={list.busy} onClick={() => void list.loadMore()}>{list.busy ? 'Loading…' : 'Load more'}</button>}{list.moreError && <p className="profile-more-error">Could not load more. Try again.</p>}</>;
}
function AlertSettings({ connections = true }: { connections?: boolean }) {
  const watch = useWatchlist();
  const [link, setLink] = useState<string | null>(null);
  const preferences = watch.data.preferences;
  const telegram = watch.data.telegram;
  const connect = async () => { const result = await watch.telegram('link'); if (result?.linkUrl) setLink(result.linkUrl); };
  const change = (value: Partial<AlertPreferences>) => void watch.preferences({ ...preferences, ...value });
  return <details className={`watch-settings${connections ? '' : ' radar-settings'}`}><summary>{connections ? 'Alerts' : 'Filters'}<ChevronDown size={14} /></summary><div className="alert-settings"><div className="alert-controls"><label>Window<select aria-label="Buying window" value={preferences.windowMinutes} disabled={watch.busy || !watch.loaded} onChange={event => change({ windowMinutes: Number(event.target.value) as AlertPreferences['windowMinutes'] })}>{[5, 10, 30].map(value => <option key={value} value={value}>{value}m</option>)}</select></label><label>KOLs<select aria-label="KOL threshold" value={preferences.minBuyers} disabled={watch.busy || !watch.loaded} onChange={event => change({ minBuyers: Number(event.target.value) })}>{Array.from({ length: 9 }, (_, i) => i + 2).map(value => <option key={value} value={value}>{value}+</option>)}</select></label><button className="feature-button" disabled={watch.busy || !watch.loaded} onClick={() => change({ muted: !preferences.muted })}>{preferences.muted ? <BellOff size={14} /> : <Bell size={14} />}{preferences.muted ? 'Muted' : 'Alerts on'}</button></div>
      <div className="alert-categories">{signalKinds.map(kind => <label key={kind}><input type="checkbox" checked={preferences.categories.includes(kind)} disabled={watch.busy || !watch.loaded} onChange={event => change({ categories: event.target.checked ? [...preferences.categories, kind] : preferences.categories.filter(value => value !== kind) })} />{signalLabels[kind]}</label>)}</div>
      {connections && <>      <div className="telegram-controls"><span>Telegram{telegram.recipient && <small>{telegram.recipient}</small>}</span>{telegram.state === 'connected' ? <><span className="positive">Connected</span><button className="feature-button" disabled={watch.busy} onClick={() => void watch.telegram('disconnect')}>Disconnect</button></> : telegram.state === 'confirm' ? <button className="feature-button" disabled={watch.busy} onClick={() => void watch.telegram('confirm')}>Enable alerts</button> : <><button className="feature-button" disabled={watch.busy || !telegram.available || !watch.data.items.length} title={telegram.available ? 'Connect your watchlist' : 'Telegram unavailable'} onClick={() => void connect()}>{telegram.state === 'pending' ? 'New link' : 'Connect'}</button>{link && telegram.state === 'pending' && <a className="feature-button" href={link} target="_blank" rel="noopener noreferrer">Open Telegram<ExternalLink size={13} /></a>}{!telegram.available && <small>Unavailable</small>}</>}</div>
      <button className="watch-clear" disabled={watch.busy || !watch.loaded} onClick={() => void watch.clear()}><X size={12} />Clear watchlist</button></>}</div></details>;
}
export function WatchlistView() {
  const watch = useWatchlist();
  return <><div className="watchlist-grid">{(['kol', 'token'] as const).map(kind => <section key={kind}><div className="table-toolbar"><h2>{kind === 'kol' ? 'KOLs' : 'Tokens'}</h2><span>{watch.data.items.filter(item => item.kind === kind).length}</span></div><div className="data-table feature-table">{watch.data.items.filter(item => item.kind === kind).map(item => <div className="watch-row" key={`${kind}:${item.address}`}><Link to={`/${kind}/${item.address}`}><FeatureIdentity token={kind === 'token'} address={item.address} name={kind === 'token' ? item.symbol || item.name : item.name} image={kind === 'token' ? item.logoUrl : item.avatarUrl} /></Link><FollowButton kind={kind} address={item.address} label={item.name} /></div>)}{!watch.data.items.some(item => item.kind === kind) && <FeatureEmpty>{watch.loaded ? `No followed ${kind === 'kol' ? 'KOLs' : 'tokens'}` : 'Loading…'}</FeatureEmpty>}</div></section>)}</div>
    <AlertSettings />
    {watch.error && <p className="profile-more-error" role="alert">{watch.error}</p>}<div className="table-toolbar watch-signals-heading"><h2>Watched signals</h2></div><RadarFeed watched />
  </>;
}
export function usePositions(kind: 'kol' | 'token', address: string, tokens?: string[]) {
  const query = kind === 'kol' && tokens?.length ? `?tokens=${tokens.slice(0, 100).join(',')}` : '';
  const result = useFeatureData<{ items: Position[] }>(`/api/${kind === 'kol' ? 'kols' : 'tokens'}/${address}/positions${query}`, { items: [] });
  return useMemo(() => new Map(result.data.items.map(position => [kind === 'kol' ? position.tokenAddress : position.walletAddress, position])), [result.data.items, kind]);
}
export function PositionBadge({ position }: { position?: Position }) {
  const fresh = position?.checkedAt && Date.now() - Date.parse(position.checkedAt) <= 300_000;
  const status = fresh ? position.status : 'Unknown';
  return <details className="position-status"><summary className={`position-badge status-${status.toLowerCase()}`}>{status}</summary><div className="position-popover"><span>Balance<strong title={position?.balance || ''}>{position?.balance ?? '—'}</strong></span><span>Checked<strong>{relativeTime(position?.checkedAt)}</strong></span>{position?.lastMovementAt && <span>Last movement<strong>{relativeTime(position.lastMovementAt)}</strong></span>}</div></details>;
}
const stageLabel = { bonding: 'Bonding', near_graduation: 'Near graduation', graduated: 'Graduated', unavailable: 'Unavailable' };
function Progress({ launch }: { launch: LaunchState }) { return <div className="launch-progress" title={launch.checkedAt ? `Checked ${relativeTime(launch.checkedAt)}` : 'Not checked'}><span><i style={{ width: `${launch.progress ?? 0}%` }} /></span><strong>{launch.progress == null ? '—' : `${Number(launch.progress).toFixed(1)}%`}</strong></div>; }
export function LaunchesView() {
  const [platform, setPlatform] = useState(''), [stage, setStage] = useState('');
  const list = useFeatureList<LaunchItem>(`/api/launches?limit=20&platform=${platform}&stage=${stage}`);
  return <><div className="table-toolbar launch-filters"><span>Tracked KOL tokens</span><div><select aria-label="Launchpad" value={platform} onChange={event => setPlatform(event.target.value)}><option value="">All launchpads</option><option value="fourmeme">Four.meme</option><option value="flap">Flap</option></select><select aria-label="Launch stage" value={stage} onChange={event => setStage(event.target.value)}><option value="">All stages</option><option value="bonding">Bonding</option><option value="near_graduation">Near graduation</option><option value="graduated">Graduated</option></select></div></div><div className="data-table feature-table">{list.items.map(launch => <div className="launch-row" key={launch.tokenAddress}><Link to={`/token/${launch.tokenAddress}`}><FeatureIdentity token address={launch.tokenAddress} name={launch.symbol} image={launch.logoUrl} /></Link><span className="launch-source">{launch.platform === 'fourmeme' ? 'Four.meme' : 'Flap'}<small>{stageLabel[launch.stage]}</small></span><Progress launch={launch} /><span className="launch-liquidity" title={launch.liquidityAt ? `Observed ${relativeTime(launch.liquidityAt)}` : 'Liquidity unavailable'}>{compact(launch.liquidityUsd, true)}<small>Liquidity</small></span><FollowButton kind="token" address={launch.tokenAddress} label={launch.symbol} /></div>)}{!list.items.length && <FeatureEmpty>{list.loading ? 'Loading launches…' : list.error ? 'Launches unavailable' : 'No tracked launches yet'}</FeatureEmpty>}</div>{list.more && <button className="profile-load-more" disabled={list.busy} onClick={() => void list.loadMore()}>{list.busy ? 'Loading…' : 'Load more'}</button>}{list.moreError && <p className="profile-more-error">Could not load more. Try again.</p>}</>;
}
export function LaunchJourney({ address }: { address: string }) {
  const { data } = useFeatureData<{ launch: LaunchState | null }>(`/api/tokens/${address}/launch`, { launch: null });
  const launch = data.launch;
  if (!launch) return null;
  const change = launch.liquidityUsd != null && Number(launch.liquidityBaselineUsd) > 0 ? (Number(launch.liquidityUsd) / Number(launch.liquidityBaselineUsd) - 1) * 100 : null;
  return <section className="launch-journey"><div className="table-toolbar"><h2>{launch.platform === 'fourmeme' ? 'Four.meme' : launch.platform === 'flap' ? 'Flap' : 'Launch'}</h2><span>{stageLabel[launch.stage]}</span></div>{launch.platform && <><Progress launch={launch} /><div className="launch-milestones">{[['Launch', launch.launchedAt], ['First KOL', launch.firstKolAt], ['Graduated', launch.graduatedAt]].map(([label, date]) => <div key={label} className={date ? 'complete' : ''}><i /><span>{label}<strong title={date ? new Date(date).toLocaleString() : 'Time unavailable'}>{relativeTime(date)}</strong></span></div>)}</div><details className="launch-details"><summary>Liquidity<ChevronDown size={13} /></summary><div><span>Observed<strong>{compact(launch.liquidityUsd, true)}</strong></span><span>Since first observation<strong className={change == null ? '' : change >= 0 ? 'positive' : 'negative'}>{change == null ? '—' : `${change > 0 ? '+' : ''}${change.toFixed(1)}%`}</strong></span><span>First observation<strong>{relativeTime(launch.liquidityBaselineAt)}</strong></span><span>Checked<strong>{relativeTime(launch.liquidityAt)}</strong></span>{launch.graduationTxHash && <a href={`https://bscscan.com/tx/${launch.graduationTxHash}`} target="_blank" rel="noopener noreferrer">Migration<ExternalLink size={12} /></a>}{launch.poolAddress && <a href={`https://bscscan.com/address/${launch.poolAddress}`} target="_blank" rel="noopener noreferrer">Pool<ExternalLink size={12} /></a>}{launch.poolId && <span title={launch.poolId}>Pool ID<strong>{shortAddress(launch.poolId)}</strong></span>}</div></details></>}</section>;
}
