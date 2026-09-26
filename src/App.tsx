import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, NavLink, Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import { Activity, ArrowDownLeft, ArrowLeftRight, ArrowUpRight, ChevronDown, ChevronLeft, ExternalLink, Menu, Search, X } from 'lucide-react';
import { api, compact, relativeTime, shortAddress, signedMoney } from './lib';
import type { Kol, LeaderboardRow, Overview, Token, Trade } from './types';

type List<T> = { items: T[]; nextCursor?: string | null };
const EMPTY_OVERVIEW: Overview = { trackedKols: 0, trades24h: 0, tokens24h: 0, latestTradeAt: null, lastTokenPriceAt: null, lastNodeBlock: null, nodeLagBlocks: null, lastNodeAt: null, bnbPriceUsd: null, bnbPriceAt: null, lastLeaderboardAt: null };
const isFresh = (value: string | null, limitMs: number) => Boolean(value && Date.now() - new Date(value).getTime() < limitMs);

function useData<T>(url: string, initial: T, interval = 15000) {
  const [data, setData] = useState(initial);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);
  const refresh = useCallback(async () => {
    try { setData(await api<T>(url)); setError(false); }
    catch { setError(true); }
    finally { setLoading(false); }
  }, [url]);
  useEffect(() => {
    setData(initial);
    setLoading(true);
    setError(false);
    void refresh();
    const timer = window.setInterval(() => void refresh(), interval);
    const events = new EventSource('/api/stream');
    events.addEventListener('update', () => void refresh());
    return () => { window.clearInterval(timer); events.close(); };
  }, [refresh, interval]);
  return { data, error, loading, refresh };
}

function Identity({ name, address, avatar, subtitle = true }: { name: string | null; address: string; avatar?: string | null; twitter?: string | null; subtitle?: boolean }) {
  return <span className="identity">
    <span className="avatar"><span>{(name || address).slice(0, 1).toUpperCase()}</span>{avatar && <img src={avatar} alt="" loading="lazy" referrerPolicy="no-referrer" onError={event => { event.currentTarget.style.display = 'none'; }} />}</span>
    <span className="identity-copy"><strong>{name || shortAddress(address)}</strong>{subtitle && <small>{shortAddress(address)}</small>}</span>
  </span>;
}

function tokenImageError(event: React.SyntheticEvent<HTMLImageElement>) {
  const image = event.currentTarget;
  const url = new URL(image.src);
  if (url.hostname === 'flap.mypinata.cloud' && url.pathname.startsWith('/ipfs/') && !image.dataset.alternateGateway) {
    image.dataset.alternateGateway = 'true';
    image.src = `https://gateway.pinata.cloud${url.pathname}`;
  } else image.style.display = 'none';
}
function TokenIdentity({ token }: { token: Pick<Token, 'address' | 'symbol' | 'name' | 'logoUrl'> }) {
  return <span className="identity token-identity"><span className="token-avatar"><span>{(token.symbol || '?').slice(0, 1)}</span>{token.logoUrl && <img key={token.logoUrl} src={token.logoUrl} alt="" onError={tokenImageError} />}</span><span className="identity-copy"><strong>{token.symbol || 'Unknown'}</strong><small>{token.name || shortAddress(token.address)}</small></span></span>;
}

function ChainLogo() { return <img className="bnb-logo" src="/bnb-chain.svg" alt="BNB Chain" />; }

function SearchDialog({ close }: { close: () => void }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<{ kols: Kol[]; tokens: Token[] }>({ kols: [], tokens: [] });
  const navigate = useNavigate();
  useEffect(() => {
    if (!query.trim()) { setResults({ kols: [], tokens: [] }); return; }
    const timer = window.setTimeout(() => { void api<{ kols: Kol[]; tokens: Token[] }>(`/api/search?q=${encodeURIComponent(query)}`).then(setResults).catch(() => setResults({ kols: [], tokens: [] })); }, 250);
    return () => window.clearTimeout(timer);
  }, [query]);
  useEffect(() => { const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') close(); }; document.addEventListener('keydown', onKey); return () => document.removeEventListener('keydown', onKey); }, [close]);
  const go = (path: string) => { navigate(path); close(); };
  return <div className="dialog-scrim" onMouseDown={close}><div className="search-dialog" role="dialog" aria-modal="true" aria-label="Search bscan" onMouseDown={event => event.stopPropagation()}>
    <div className="search-input-row"><Search size={20} /><input autoFocus placeholder="Search KOL, wallet, token, or contract" value={query} onChange={event => setQuery(event.target.value)} /><button className="icon-button" aria-label="Close search" onClick={close}><X size={18} /></button></div>
    <div className="search-results">{!query && <p className="search-hint">Search tracked KOL wallets and tokens on BNB Smart Chain.</p>}
      {results.kols.length > 0 && <><span className="eyebrow">KOLs</span>{results.kols.map(kol => <button className="search-result" key={kol.address} onClick={() => go(`/kol/${kol.address}`)}><Identity name={kol.name} address={kol.address} avatar={kol.avatarUrl} twitter={kol.twitter} /><ArrowUpRight size={16} /></button>)}</>}
      {results.tokens.length > 0 && <><span className="eyebrow">Tokens</span>{results.tokens.map(token => <button className="search-result" key={token.address} onClick={() => go(`/token/${token.address}`)}><TokenIdentity token={token} /><ArrowUpRight size={16} /></button>)}</>}
      {query && !results.kols.length && !results.tokens.length && <p className="search-hint">No tracked results. Try a contract address or KOL name.</p>}
    </div>
  </div></div>;
}

function Header({ overview }: { overview: Overview }) {
  const [searchOpen, setSearchOpen] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  useEffect(() => { const onKey = (event: KeyboardEvent) => { if (event.key === '/' && !(event.target instanceof HTMLInputElement)) { event.preventDefault(); setSearchOpen(true); } }; document.addEventListener('keydown', onKey); return () => document.removeEventListener('keydown', onKey); }, []);
  return <><header className="site-header"><div className="header-inner">
    <Link className="brand" to="/trades"><span className="brand-mark"><img src="/bscan-mark.png" alt="" /></span><span>bscan</span></Link>
    <span className="header-divider" />
    <nav className={mobileOpen ? 'main-nav open' : 'main-nav'} aria-label="Main navigation">
      <NavLink to="/trades" onClick={() => setMobileOpen(false)}>Trades</NavLink><NavLink to="/tokens" onClick={() => setMobileOpen(false)}>Tokens</NavLink><NavLink to="/leaderboard" onClick={() => setMobileOpen(false)}>Leaderboard</NavLink>
    </nav>
    <div className="header-social">
      <span className="bnb-price" title={overview.bnbPriceAt ? `Chainlink BNB/USD updated ${new Date(overview.bnbPriceAt).toLocaleString()}` : 'BNB/USD price unavailable'}><span>BNB</span><strong>{isFresh(overview.bnbPriceAt, 2 * 60 * 60_000) ? compact(overview.bnbPriceUsd, true) : '—'}</strong></span>
      <a className="header-x-link" href="https://x.com/bscanfun" target="_blank" rel="noopener noreferrer" aria-label="bscan on X" title="bscan on X"><svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M18.901 1.153h3.68l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.64 7.584H.47l8.6-9.829L0 1.154h7.594l5.243 6.932 6.064-6.933Zm-1.29 19.491h2.039L6.486 3.24H4.299l13.312 17.404Z" /></svg></a>
    </div>
    <div className="header-right"><span className="chain-label"><ChainLogo /><span>On BNB Chain</span></span><button className="header-search" onClick={() => setSearchOpen(true)} aria-label="Search"><Search size={18} /><span>Search</span><kbd>/</kbd></button><button className="mobile-menu icon-button" onClick={() => setMobileOpen(!mobileOpen)} aria-label="Toggle menu"><Menu size={21} /></button></div>
  </div></header>{searchOpen && <SearchDialog close={() => setSearchOpen(false)} />}</>;
}

function EmptyState({ title, detail }: { title: string; detail: string }) { return <div className="empty-state"><span className="empty-icon"><Activity size={22} /></span><strong>{title}</strong><p>{detail}</p></div>; }
function SectionTitle({ eyebrow, title, description, right }: { eyebrow: string; title: string; description?: string; right?: React.ReactNode }) { return <div className="section-title"><div><span className="eyebrow">{eyebrow}</span><h1>{title}</h1>{description && <p>{description}</p>}</div>{right}</div>; }
function Metric({ label, value, detail }: { label: string; value: string | number; detail?: string }) { return <div className="metric"><span>{label}</span><strong>{value}</strong>{detail && <small>{detail}</small>}</div>; }

function TradeRow({ trade }: { trade: Trade }) {
  const sideIcon = trade.side === 'buy' ? <ArrowDownLeft size={14} /> : trade.side === 'sell' ? <ArrowUpRight size={14} /> : <ArrowLeftRight size={14} />;
  return <div className="trade-row">
    <div className="trade-kol"><Link to={`/kol/${trade.walletAddress}`}><Identity name={trade.kolName} address={trade.walletAddress} avatar={trade.kolAvatarUrl} twitter={trade.kolTwitter} subtitle={false} /></Link></div>
    <div className="trade-activity"><span className={`side-pill ${trade.side}`}>{sideIcon}{trade.side}</span><Link to={`/token/${trade.tokenAddress}`}><TokenIdentity token={{ address: trade.tokenAddress, symbol: trade.tokenSymbol, name: trade.tokenName, logoUrl: trade.tokenLogoUrl }} /></Link><span className="trade-amount">{compact(trade.tokenAmount)}</span></div>
    <div className="trade-value">{trade.amountUsd != null ? compact(trade.amountUsd, true) : trade.quoteAmount && trade.quoteSymbol ? `${compact(trade.quoteAmount)} ${trade.quoteSymbol}` : '—'}</div>
    <div className="trade-time"><a href={`https://bscscan.com/tx/${trade.txHash}`} target="_blank" rel="noreferrer" title={`${new Date(trade.timestamp).toLocaleString()} · ${trade.source}`}>{relativeTime(trade.timestamp)}<ExternalLink size={13} /></a></div>
  </div>;
}

function TradesPage({ overview }: { overview: Overview }) {
  const [side, setSide] = useState<'all' | 'buy' | 'sell'>('all');
  const [olderItems, setOlderItems] = useState<Trade[]>([]);
  const [olderCursor, setOlderCursor] = useState<string | null | undefined>(undefined);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [olderError, setOlderError] = useState(false);
  const url = `/api/trades?limit=50${side !== 'all' ? `&side=${side}` : ''}`;
  const { data, loading, error } = useData<List<Trade>>(url, { items: [], nextCursor: null }, 10000);
  const items = useMemo(() => [...new Map([...data.items, ...olderItems].filter(item => side === 'all' || item.side === side).map(item => [item.id, item])).values()], [data.items, olderItems, side]);
  const nextCursor = olderCursor === undefined ? data.nextCursor : olderCursor;
  const changeSide = (value: 'all' | 'buy' | 'sell') => { setOlderCursor(undefined); setOlderItems([]); setOlderError(false); setSide(value); };
  const loadOlder = async () => {
    if (!nextCursor || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const page = await api<List<Trade>>(`${url}&cursor=${encodeURIComponent(nextCursor)}`);
      setOlderItems(previous => [...new Map([...previous, ...page.items].map(item => [item.id, item])).values()]);
      setOlderCursor(page.nextCursor || null);
      setOlderError(false);
    } catch {
      setOlderError(true);
    } finally { setLoadingOlder(false); }
  };
  return <div className="page trades-page"><SectionTitle eyebrow="THE LIVE TAPE" title="Realtime trades" description="Recent BNB Chain swaps from tracked KOL wallets." right={<div className="freshness"><i className={isFresh(overview.latestTradeAt, 15 * 60000) ? 'status-dot live' : 'status-dot'} /><span>{overview.latestTradeAt ? `Latest trade ${relativeTime(overview.latestTradeAt)}` : 'Waiting for trades'}</span></div>} />
    <div className="overview-strip"><Metric label="Tracked KOLs" value={overview.trackedKols} /><Metric label="Trades · 24h" value={compact(overview.trades24h)} /><Metric label="Tokens · 24h" value={compact(overview.tokens24h)} /><Metric label="Last trade" value={relativeTime(overview.latestTradeAt)} /></div>
    <div className="table-toolbar"><div><h2>Recent activity</h2><span>{items.length} trades shown</span></div><div className="segmented" role="group" aria-label="Trade direction"><button className={side === 'all' ? 'selected' : ''} onClick={() => changeSide('all')}>All trades</button><button className={side === 'buy' ? 'selected' : ''} onClick={() => changeSide('buy')}>Buys</button><button className={side === 'sell' ? 'selected' : ''} onClick={() => changeSide('sell')}>Sells</button></div></div>
    <div className="data-table trades-table"><div className="table-head trade-row"><span>KOL</span><span>Trade</span><span>Value</span><span className="align-right">Time</span></div>{items.map(trade => <TradeRow key={trade.id} trade={trade} />)}{!items.length && !loading && <EmptyState title={error ? 'Live feed unavailable' : 'Watching for the next trade'} detail={error ? 'The API is reconnecting. Try again shortly.' : 'Trades from tracked KOL wallets will appear here automatically.'} />}</div>
    {nextCursor && <div className="load-more"><button onClick={() => void loadOlder()} disabled={loadingOlder}>{loadingOlder ? 'Loading…' : olderError ? 'Retry earlier trades' : 'Load earlier trades'} <ChevronDown size={16} /></button></div>}
  </div>;
}

function TokenCard({ token }: { token: Token }) {
  return <Link className="token-card" to={`/token/${token.address}`}><div className="token-card-top"><TokenIdentity token={token} /><ArrowUpRight size={18} /></div><div className="token-card-stats"><div><span>Observed price</span><strong>{compact(token.priceUsd, true)}</strong></div><div><span>24h volume</span><strong>{compact(token.volume24hUsd, true)}</strong></div><div><span>Last trade</span><strong>{relativeTime(token.lastTradeAt)}</strong></div></div><div className="token-card-foot"><span><span className="mini-dot" />{token.kolCount24h} KOLs · 24h</span><span className="positive">{token.buys24h} buys</span><span className="negative">{token.sells24h} sells</span></div></Link>;
}

function TokensPage({ overview }: { overview: Overview }) {
  const [offset, setOffset] = useState(0);
  const [items, setItems] = useState<Token[]>([]);
  const { data, loading, error } = useData<{ items: Token[]; total: number; nextOffset: number | null }>(`/api/tokens?limit=150&offset=${offset}`, { items: [], total: 0, nextOffset: null }, 20000);
  useEffect(() => { setItems(previous => offset === 0 ? data.items : [...new Map([...previous, ...data.items].map(token => [token.address, token])).values()]); }, [data, offset]);
  return <div className="page tokens-page"><SectionTitle eyebrow="KOL CONVICTION" title="Token tracker" description="Tokens traded by tracked KOL wallets." right={<div className="freshness"><i className={isFresh(overview.lastTokenPriceAt, 90 * 60000) ? 'status-dot live' : 'status-dot'} /><span>{overview.lastTokenPriceAt ? `Last priced trade ${relativeTime(overview.lastTokenPriceAt)}` : 'Trade pricing unavailable'}</span></div>} />
    <div className="column-heading"><div><h2>Recently traded</h2><p>{data.total} tokens observed</p></div></div><div className="token-list">{items.map(token => <TokenCard key={token.address} token={token} />)}</div>
    {!items.length && !loading && <EmptyState title={error ? 'Token data unavailable' : 'No KOL tokens yet'} detail={error ? 'The API is reconnecting.' : 'This page fills as tracked KOL wallets trade tokens.'} />}
    {data.nextOffset != null && <div className="load-more"><button onClick={() => setOffset(data.nextOffset!)}>Load more tokens · {Math.max(0, data.total - items.length)} remaining <ChevronDown size={16} /></button></div>}
  </div>;
}

function LeaderboardPage({ overview }: { overview: Overview }) {
  const [period, setPeriod] = useState<'1d' | '7d' | '30d'>('1d');
  const { data, loading, error } = useData<List<LeaderboardRow>>(`/api/leaderboard?period=${period}`, { items: [] }, 60000);
  return <div className="page leaderboard-page"><SectionTitle eyebrow="THE PERFORMANCE BOARD" title="KOL leaderboard" description="Realized USD profit from observed wallet trades." right={<div className="freshness"><i className={isFresh(overview.lastLeaderboardAt, 5 * 60000) ? 'status-dot live' : 'status-dot'} /><span>{overview.lastLeaderboardAt ? `Calculated ${relativeTime(overview.lastLeaderboardAt)}` : 'Calculating rankings'}</span></div>} />
    <div className="table-toolbar leaderboard-toolbar"><div><span className="small-label">RANKING PERIOD</span><div className="segmented period-select" role="group" aria-label="Leaderboard period"><button className={period === '1d' ? 'selected' : ''} onClick={() => setPeriod('1d')}>1 day</button><button className={period === '7d' ? 'selected' : ''} onClick={() => setPeriod('7d')}>7 days</button><button className={period === '30d' ? 'selected' : ''} onClick={() => setPeriod('30d')}>30 days</button></div></div><span className="coverage-note">{overview.trackedKols} tracked KOLs · supplied roster</span></div>
    <div className="data-table leaderboard-table"><div className="table-head leaderboard-row"><span>Rank</span><span>KOL</span><span>Buys / sells</span><span className="align-right">Realized P&L</span></div>{data.items.map((row, index) => <Link className={`leaderboard-row leader-rank-${index + 1}`} key={row.address} to={`/kol/${row.address}`}><span className="rank-number">{String(index + 1).padStart(2, '0')}</span><span className="leader-identity"><Identity name={row.name} address={row.address} avatar={row.avatarUrl} twitter={row.twitter} subtitle={false} />{row.twitter && <span className="twitter-handle">@{row.twitter}</span>}</span><span className="buy-sell"><span className="positive">{row.buyCount ?? '—'}</span><span className="slash">/</span><span className="negative">{row.sellCount ?? '—'}</span></span><strong className={`pnl ${row.realizedProfitUsd == null ? '' : Number(row.realizedProfitUsd) >= 0 ? 'positive' : 'negative'}`}>{signedMoney(row.realizedProfitUsd)}</strong></Link>)}{!data.items.length && !loading && <EmptyState title={error ? 'Leaderboard unavailable' : 'Calculating rankings'} detail={error ? 'The API is reconnecting.' : 'The worker is indexing trades from the tracked wallets.'} />}</div>
    <p className="method-note">Each row represents one tracked wallet; a KOL with multiple wallets can appear more than once. P&L uses observed buys and sells with a USD value and FIFO cost basis. Missing historical buys or unpriced trades are excluded, so figures may be partial. $0 means no sells in the period; a dash means sales lack a complete USD value or observed cost basis.</p>
  </div>;
}

function KolPage() {
  const address = window.location.pathname.split('/').pop() || '';
  const { data, loading } = useData<{ kol: Kol | null; stats: LeaderboardRow | null; trades: Trade[]; tokens: Token[] }>(`/api/kols/${address}`, { kol: null, stats: null, trades: [], tokens: [] }, 20000);
  if (!loading && !data.kol) return <div className="page"><EmptyState title="KOL not found" detail="This wallet is not in the supplied KOL roster." /></div>;
  return <div className="page profile-page kol-detail-page"><Link className="back-link" to="/leaderboard"><ChevronLeft size={15} aria-hidden="true" />Back to leaderboard</Link><div className="profile-header"><Identity name={data.kol?.name || null} address={address} avatar={data.kol?.avatarUrl} twitter={data.kol?.twitter} subtitle={false} /><div className="profile-links"><span className="address-pill">{shortAddress(address, 7)}</span><a href={`https://bscscan.com/address/${address}`} target="_blank" rel="noreferrer">BscScan <ExternalLink size={14} /></a>{data.kol?.twitter && <a href={`https://x.com/${data.kol.twitter}`} target="_blank" rel="noreferrer">@{data.kol.twitter} <ExternalLink size={14} /></a>}</div></div>
    <div className="profile-stats"><Metric label="7D realized P&L" value={signedMoney(data.stats?.realizedProfitUsd)} detail={data.stats?.realizedProfitUsd == null && (data.stats?.sellCount || 0) > 0 ? 'Insufficient valued trade history' : undefined} /><Metric label="7D buys / sells" value={`${data.stats?.buyCount ?? '—'} / ${data.stats?.sellCount ?? '—'}`} /><Metric label="Last trade" value={relativeTime(data.kol?.lastSeenAt)} /></div>
    <div className="profile-grid"><section><div className="table-toolbar"><div><h2>Recent trades</h2><span>Indexed activity from this wallet</span></div></div><div className="data-table profile-trades">{data.trades.map(trade => <TradeRow key={trade.id} trade={trade} />)}{!data.trades.length && <EmptyState title="No indexed trades yet" detail="The worker is watching this wallet for BSC swaps." />}</div></section><section><div className="table-toolbar"><div><h2>Traded tokens</h2><span>Recent token activity</span></div></div><div className="profile-token-list">{data.tokens.map(token => <TokenCard key={token.address} token={token} />)}{!data.tokens.length && <EmptyState title="No tracked tokens yet" detail="Tokens appear after a tracked swap." />}</div></section></div>
  </div>;
}

function TokenPage() {
  const address = window.location.pathname.split('/').pop() || '';
  const { data, loading } = useData<{ token: Token | null; trades: Trade[]; kols: Kol[] }>(`/api/tokens/${address}`, { token: null, trades: [], kols: [] }, 20000);
  if (!loading && !data.token) return <div className="page"><EmptyState title="Token not found" detail="No tracked KOL has traded this contract yet." /></div>;
  return <div className="page profile-page token-detail-page"><Link className="back-link" to="/tokens"><ChevronLeft size={15} aria-hidden="true" />Back to tokens</Link><div className="profile-header"><TokenIdentity token={data.token || { address, symbol: null, name: null, logoUrl: null }} /><div className="profile-links"><span className="address-pill">{shortAddress(address, 7)}</span><a href={`https://bscscan.com/token/${address}`} target="_blank" rel="noreferrer">Contract <ExternalLink size={14} /></a></div></div><div className="profile-stats"><Metric label="Observed price" value={compact(data.token?.priceUsd, true)} /><Metric label="KOLs · 24h" value={data.token?.kolCount24h ?? '—'} /><Metric label="24h KOL volume" value={compact(data.token?.volume24hUsd, true)} /><Metric label="Last trade" value={relativeTime(data.token?.lastTradeAt)} /></div><div className="profile-grid"><section><div className="table-toolbar"><div><h2>KOL trades</h2><span>Recent activity in this token</span></div></div><div className="data-table profile-trades">{data.trades.map(trade => <TradeRow key={trade.id} trade={trade} />)}</div></section><section><div className="table-toolbar"><div><h2>KOLs trading it</h2><span>Distinct tracked wallets</span></div></div><div className="kol-list">{data.kols.map(kol => <Link key={kol.address} to={`/kol/${kol.address}`}><Identity name={kol.name} address={kol.address} avatar={kol.avatarUrl} twitter={kol.twitter} /><ArrowUpRight size={16} /></Link>)}</div></section></div></div>;
}

export default function App() {
  const { data: overview } = useData<Overview>('/api/overview', EMPTY_OVERVIEW, 10000);
  return <><Header overview={overview} /><main><Routes><Route path="/" element={<Navigate to="/trades" replace />} /><Route path="/trades" element={<TradesPage overview={overview} />} /><Route path="/tokens" element={<TokensPage overview={overview} />} /><Route path="/leaderboard" element={<LeaderboardPage overview={overview} />} /><Route path="/kol/:address" element={<KolPage />} /><Route path="/token/:address" element={<TokenPage />} /><Route path="*" element={<Navigate to="/trades" replace />} /></Routes></main><footer className="footer"><div><span className="footer-brand"><img src="/bscan-mark.png" alt="" />bscan</span><span>Independent BNB Smart Chain KOL analytics.</span></div></footer></>;
}
