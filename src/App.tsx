import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, NavLink, Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import { Activity, ArrowDownLeft, ArrowLeftRight, ArrowUpRight, Check, ChevronLeft, Copy, ExternalLink, Menu, Search, X } from 'lucide-react';
import { api, compact, relativeTime, shortAddress, signedMoney } from './lib';
import type { Kol, LeaderboardRow, Overview, Token, Trade } from './types';
import { PrivacyPolicyPage, TermsOfUsePage } from './LegalPages';

type List<T> = { items: T[]; nextCursor?: string | null };
const EMPTY_OVERVIEW: Overview = { trackedKols: 0, trades24h: 0, tokens24h: 0, latestTradeAt: null, lastTokenPriceAt: null, lastNodeBlock: null, nodeLagBlocks: null, lastNodeAt: null, bnbPriceUsd: null, bnbPriceAt: null, lastLeaderboardAt: null };
const gmgnTokenUrl = (address: string) => `https://gmgn.ai/bsc/token/${address}`;
const isFresh = (value: string | null, limitMs: number) => Boolean(value && Date.now() - new Date(value).getTime() < limitMs);
function tradeTokenAmount(value: string | null) {
  if (value == null) return '—';
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) return '—';
  if (amount > 0 && amount < 0.001) return '<0.001';
  return new Intl.NumberFormat('en-US', { notation: amount >= 1000 ? 'compact' : 'standard', maximumFractionDigits: 3 }).format(amount);
}
function tradeBnbValue(trade: Trade, bnbPriceUsd: number | null) {
  const direct = trade.quoteAmount != null && ['BNB', 'WBNB'].includes(trade.quoteSymbol?.toUpperCase() || '') ? Number(trade.quoteAmount) : NaN;
  const estimated = trade.amountUsd != null && bnbPriceUsd && bnbPriceUsd > 0 ? Number(trade.amountUsd) / bnbPriceUsd : NaN;
  const amount = Number.isFinite(direct) && direct >= 0 ? direct : estimated;
  if (!Number.isFinite(amount) || amount < 0) return '— BNB';
  if (amount > 0 && amount < 0.001) return '<0.001 BNB';
  return `${Number.isFinite(direct) && direct >= 0 ? '' : '≈'}${new Intl.NumberFormat('en-US', { maximumFractionDigits: 3 }).format(amount)} BNB`;
}

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

function tokenImageSrc(logoUrl: string) {
  return logoUrl.replace(/^https:\/\/flap\.mypinata\.cloud\/ipfs\//i, 'https://gateway.pinata.cloud/ipfs/');
}
function tokenImageError(event: React.SyntheticEvent<HTMLImageElement>) {
  const image = event.currentTarget;
  const original = image.dataset.originalSrc;
  if (original && !image.dataset.triedOriginal && original !== image.src) {
    image.dataset.triedOriginal = 'true';
    image.src = original;
  } else image.style.display = 'none';
}
function TokenIdentity({ token }: { token: Pick<Token, 'address' | 'symbol' | 'name' | 'logoUrl'> }) {
  return <span className="identity token-identity"><span className="token-avatar"><span>{(token.symbol || '?').slice(0, 1)}</span>{token.logoUrl && <img key={token.logoUrl} src={tokenImageSrc(token.logoUrl)} data-original-src={token.logoUrl} alt="" onError={tokenImageError} />}</span><span className="identity-copy"><strong>{token.symbol || 'Unknown'}</strong><small>{token.name || shortAddress(token.address)}</small></span></span>;
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

function TradeRow({ trade, bnbPriceUsd, showSide = true, tokenGmgnLink = false }: { trade: Trade; bnbPriceUsd: number | null; showSide?: boolean; tokenGmgnLink?: boolean }) {
  const sideIcon = trade.side === 'buy' ? <ArrowDownLeft size={14} /> : trade.side === 'sell' ? <ArrowUpRight size={14} /> : <ArrowLeftRight size={14} />;
  const tokenIdentity = <TokenIdentity token={{ address: trade.tokenAddress, symbol: trade.tokenSymbol, name: trade.tokenName, logoUrl: trade.tokenLogoUrl }} />;
  return <div className="trade-row">
    <div className="trade-kol"><Link to={`/kol/${trade.walletAddress}`}><Identity name={trade.kolName} address={trade.walletAddress} avatar={trade.kolAvatarUrl} twitter={trade.kolTwitter} subtitle={false} /></Link></div>
    <div className="trade-activity">{showSide && <span className={`side-pill ${trade.side}`}>{sideIcon}{trade.side}</span>}{tokenGmgnLink ? <a href={gmgnTokenUrl(trade.tokenAddress)} target="_blank" rel="noopener noreferrer" title="View token on GMGN">{tokenIdentity}</a> : <Link to={`/token/${trade.tokenAddress}`}>{tokenIdentity}</Link>}</div>
    <div className={`trade-value ${trade.side}`} title={trade.quoteSymbol === 'BNB' || trade.quoteSymbol === 'WBNB' ? 'Recorded BNB trade amount' : 'Approximate BNB amount based on the current BNB/USD price'}><strong>{tradeBnbValue(trade, bnbPriceUsd)}</strong><span className="trade-amount">{tradeTokenAmount(trade.tokenAmount)}</span></div>
    <div className="trade-time"><a href={gmgnTokenUrl(trade.tokenAddress)} target="_blank" rel="noopener noreferrer" title={`${new Date(trade.timestamp).toLocaleString()} · View token activity on GMGN`} aria-label={`View ${trade.tokenSymbol || 'token'} activity on GMGN, ${relativeTime(trade.timestamp)}`}>{relativeTime(trade.timestamp)}<ExternalLink size={13} /></a></div>
  </div>;
}

function TradesPage({ overview }: { overview: Overview }) {
  const { data, loading, error } = useData<List<Trade>>('/api/trades?limit=10', { items: [], nextCursor: null }, 10000);
  const items = data.items.slice(0, 10);
  return <div className="page trades-page"><SectionTitle eyebrow="THE LIVE TAPE" title="Realtime trades" description="Recent BNB Chain swaps from tracked KOL wallets." right={<div className="freshness"><i className={isFresh(overview.latestTradeAt, 15 * 60000) ? 'status-dot live' : 'status-dot'} /><span>{overview.latestTradeAt ? `Latest trade ${relativeTime(overview.latestTradeAt)}` : 'Waiting for trades'}</span></div>} />
    <div className="overview-strip"><Metric label="Tracked KOLs" value={overview.trackedKols} /><Metric label="Trades · 24h" value={compact(overview.trades24h)} /><Metric label="Tokens · 24h" value={compact(overview.tokens24h)} /><Metric label="Last trade" value={relativeTime(overview.latestTradeAt)} /></div>
    <div className="table-toolbar"><h2>Recent activity</h2></div>
    <div className="data-table trades-table">{items.map(trade => <TradeRow key={trade.id} trade={trade} bnbPriceUsd={overview.bnbPriceUsd} showSide={false} tokenGmgnLink />)}{!items.length && !loading && <EmptyState title={error ? 'Live feed unavailable' : 'Watching for the next trade'} detail={error ? 'The API is reconnecting. Try again shortly.' : 'Trades from tracked KOL wallets will appear here automatically.'} />}</div>
    <section className="trades-faq" aria-labelledby="trades-faq-title">
      <h2 id="trades-faq-title">FAQs</h2>
      <div className="faq-list">
        <details className="faq-item" name="trades-faq"><summary>What does bscan track?</summary><p>bscan shows token trades from a curated list of KOL wallets on BNB Smart Chain.</p></details>
        <details className="faq-item" name="trades-faq"><summary>How often do new trades appear?</summary><p>The feed updates automatically as newly indexed trades become available.</p></details>
        <details className="faq-item" name="trades-faq"><summary>What can I find in the token tracker?</summary><p>Browse tokens traded by tracked KOLs, grouped by market cap. Open a token to see its recent KOL trades and the wallets trading it.</p></details>
        <details className="faq-item" name="trades-faq"><summary>What does a KOL profile show?</summary><p>Each tracked wallet has a profile with recent trades, traded tokens, and 7-day realized P&amp;L.</p></details>
        <details className="faq-item" name="trades-faq"><summary>How does the leaderboard work?</summary><p>It ranks tracked wallets by realized USD profit from observed trades over 1, 7, or 30 days.</p></details>
      </div>
    </section>
    <section className="trades-follow" aria-labelledby="trades-follow-title"><div><h2 id="trades-follow-title">Follow us on X</h2><p>Updates from bscan.</p></div><a href="https://x.com/bscanfun" target="_blank" rel="noopener noreferrer">@bscanfun <ExternalLink size={15} /></a></section>
  </div>;
}

function TokenCard({ token, recentTrades, bnbPriceUsd }: { token: Token; recentTrades?: Trade[]; bnbPriceUsd?: number | null }) {
  return <div className="token-card"><Link className="token-card-main" to={`/token/${token.address}`}><div className="token-card-top"><TokenIdentity token={token} /><span className="token-card-cap">{token.marketCapUsd ? `MC ${compact(token.marketCapUsd, true)}` : 'MC —'}</span></div><div className="token-card-stats"><div><span>Observed price</span><strong>{compact(token.priceUsd, true)}</strong></div><div><span>24h volume</span><strong>{compact(token.volume24hUsd, true)}</strong></div><div><span>Last trade</span><strong>{relativeTime(token.lastTradeAt)}</strong></div></div></Link>
    {recentTrades && recentTrades.length > 0 && <div className="token-card-trades" aria-label={`Recent ${token.symbol || 'token'} trades`}>
      {recentTrades.slice(0, 5).map(trade => <div className="token-card-trade" key={trade.id}>
        <Link className="token-trade-kol" to={`/kol/${trade.walletAddress}`} title={trade.kolName || trade.walletAddress}><Identity name={trade.kolName} address={trade.walletAddress} avatar={trade.kolAvatarUrl} subtitle={false} /></Link>
        <span className={`token-trade-side ${trade.side}`}>{trade.side}</span>
        <span className={`token-trade-value ${trade.side}`}>{tradeBnbValue(trade, bnbPriceUsd ?? null)}</span>
        <time dateTime={trade.timestamp} title={new Date(trade.timestamp).toLocaleString()}>{relativeTime(trade.timestamp)}</time>
      </div>)}
    </div>}
  </div>;
}

type LiveToken = Token & { recentTrades: Trade[] };
function TokensPage({ bnbPriceUsd }: { bnbPriceUsd: number | null }) {
  const [initialWindowStart] = useState(() => new Date(Date.now() - 60 * 60_000).toISOString());
  const [items, setItems] = useState<LiveToken[]>([]);
  const { data, error } = useData<{ items: LiveToken[] }>(`/api/tokens?since=${encodeURIComponent(initialWindowStart)}&limit=300&withTrades=1`, { items: [] }, 10000);
  useEffect(() => {
    if (!data.items.length) return;
    setItems(previous => [...new Map([...previous, ...data.items].map(token => [token.address, token])).values()]
      .sort((a, b) => new Date(b.lastTradeAt || 0).getTime() - new Date(a.lastTradeAt || 0).getTime()));
  }, [data]);
  const groups = useMemo(() => {
    const result: Record<'low' | 'mid' | 'high', LiveToken[]> = { low: [], mid: [], high: [] };
    for (const token of items) {
      const cap = token.marketCapUsd == null ? NaN : Number(token.marketCapUsd);
      if (!Number.isFinite(cap) || cap <= 0) continue;
      result[cap < 100_000 ? 'low' : cap < 1_000_000 ? 'mid' : 'high'].push(token);
    }
    return result;
  }, [items]);
  return <div className="page tokens-page"><SectionTitle eyebrow="KOL CONVICTION" title="Token tracker" right={<div className="freshness"><i className={error ? 'status-dot' : 'status-dot live'} /><span>{error ? 'Live feed reconnecting' : 'Watching live trades'}</span></div>} />
    <div className="token-columns">{([
      { key: 'low', title: 'Low caps', range: 'Under $100K' },
      { key: 'mid', title: '$100K+', range: '$100K to $1M' },
      { key: 'high', title: '$1M+', range: '$1M and above' },
    ] as const).map(column => <section className="token-column" key={column.key}><div className="column-heading"><div><h2>{column.title}</h2><p>{column.range}</p></div></div><div className="token-list">{groups[column.key].map(token => <TokenCard key={token.address} token={token} recentTrades={token.recentTrades} bnbPriceUsd={bnbPriceUsd} />)}</div></section>)}</div>
  </div>;
}

function LeaderboardPage({ overview }: { overview: Overview }) {
  const [period, setPeriod] = useState<'1d' | '7d' | '30d'>('1d');
  const { data, loading, error } = useData<List<LeaderboardRow>>(`/api/leaderboard?period=${period}`, { items: [] }, 60000);
  return <div className="page leaderboard-page"><SectionTitle eyebrow="THE PERFORMANCE BOARD" title="KOL leaderboard" description="Realized USD profit from observed wallet trades." right={<div className="freshness"><i className={isFresh(overview.lastLeaderboardAt, 5 * 60000) ? 'status-dot live' : 'status-dot'} /><span>{overview.lastLeaderboardAt ? `Calculated ${relativeTime(overview.lastLeaderboardAt)}` : 'Calculating rankings'}</span></div>} />
    <div className="table-toolbar leaderboard-toolbar"><div><span className="small-label">RANKING PERIOD</span><div className="segmented period-select" role="group" aria-label="Leaderboard period"><button className={period === '1d' ? 'selected' : ''} onClick={() => setPeriod('1d')}>1 day</button><button className={period === '7d' ? 'selected' : ''} onClick={() => setPeriod('7d')}>7 days</button><button className={period === '30d' ? 'selected' : ''} onClick={() => setPeriod('30d')}>30 days</button></div></div><span className="coverage-note">{overview.trackedKols} tracked KOLs · supplied roster</span></div>
    <div className="data-table leaderboard-table">{data.items.map((row, index) => <Link className={`leaderboard-row leader-rank-${index + 1}`} key={row.address} to={`/kol/${row.address}`}><span className="rank-number">{String(index + 1).padStart(2, '0')}</span><span className="leader-identity"><Identity name={row.name} address={row.address} avatar={row.avatarUrl} twitter={row.twitter} subtitle={false} />{row.twitter && <span className="twitter-handle">@{row.twitter}</span>}</span><span className="buy-sell"><span className="positive">{row.buyCount ?? '—'}</span><span className="slash">/</span><span className="negative">{row.sellCount ?? '—'}</span></span><strong className={`pnl ${row.realizedProfitUsd == null ? '' : Number(row.realizedProfitUsd) >= 0 ? 'positive' : 'negative'}`}>{signedMoney(row.realizedProfitUsd)}</strong></Link>)}{!data.items.length && !loading && <EmptyState title={error ? 'Leaderboard unavailable' : 'Calculating rankings'} detail={error ? 'The API is reconnecting.' : 'The worker is indexing trades from the tracked wallets.'} />}</div>
  </div>;
}

function KolPage({ bnbPriceUsd }: { bnbPriceUsd: number | null }) {
  const address = window.location.pathname.split('/').pop() || '';
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const copyWallet = async () => {
    try { await navigator.clipboard.writeText(address); setCopyState('copied'); }
    catch { setCopyState('failed'); }
  };
  const { data, loading } = useData<{ kol: Kol | null; stats: LeaderboardRow | null; trades: Trade[]; tokens: Token[] }>(`/api/kols/${address}`, { kol: null, stats: null, trades: [], tokens: [] }, 20000);
  if (!loading && !data.kol) return <div className="page"><EmptyState title="KOL not found" detail="This wallet is not in the supplied KOL roster." /></div>;
  return <div className="page profile-page kol-detail-page"><Link className="back-link" to="/leaderboard"><ChevronLeft size={15} aria-hidden="true" />Back to leaderboard</Link><div className="profile-header"><Identity name={data.kol?.name || null} address={address} avatar={data.kol?.avatarUrl} twitter={data.kol?.twitter} subtitle={false} /><div className="profile-links"><a href={`https://bscscan.com/address/${address}`} target="_blank" rel="noopener noreferrer">BscScan <ExternalLink size={14} /></a><button className="address-pill copy-wallet" type="button" onClick={() => void copyWallet()} title={address} aria-label={copyState === 'copied' ? 'Wallet address copied' : 'Copy KOL wallet address'}>{copyState === 'copied' ? 'Copied' : copyState === 'failed' ? 'Copy failed' : shortAddress(address, 7)}{copyState === 'copied' ? <Check size={14} /> : <Copy size={14} />}</button>{data.kol?.twitter && <a href={`https://x.com/${data.kol.twitter}`} target="_blank" rel="noreferrer">@{data.kol.twitter} <ExternalLink size={14} /></a>}</div></div>
    <div className="profile-stats"><Metric label="7D realized P&L" value={signedMoney(data.stats?.realizedProfitUsd)} detail={data.stats?.realizedProfitUsd == null && (data.stats?.sellCount || 0) > 0 ? 'Insufficient valued trade history' : undefined} /><Metric label="7D buys / sells" value={`${data.stats?.buyCount ?? '—'} / ${data.stats?.sellCount ?? '—'}`} /><Metric label="Last trade" value={relativeTime(data.kol?.lastSeenAt)} /></div>
    <div className="profile-grid"><section><div className="table-toolbar"><div><h2>Recent trades</h2><span>Indexed activity from this wallet</span></div></div><div className="data-table profile-trades">{data.trades.map(trade => <TradeRow key={trade.id} trade={trade} bnbPriceUsd={bnbPriceUsd} />)}{!data.trades.length && <EmptyState title="No indexed trades yet" detail="The worker is watching this wallet for BSC swaps." />}</div></section><section><div className="table-toolbar"><div><h2>Traded tokens</h2><span>Recent token activity</span></div></div><div className="profile-token-list">{data.tokens.map(token => <TokenCard key={token.address} token={token} />)}{!data.tokens.length && <EmptyState title="No tracked tokens yet" detail="Tokens appear after a tracked swap." />}</div></section></div>
  </div>;
}

function TokenPage({ bnbPriceUsd }: { bnbPriceUsd: number | null }) {
  const address = window.location.pathname.split('/').pop() || '';
  const { data, loading } = useData<{ token: Token | null; trades: Trade[]; kols: Kol[] }>(`/api/tokens/${address}`, { token: null, trades: [], kols: [] }, 20000);
  if (!loading && !data.token) return <div className="page"><EmptyState title="Token not found" detail="No tracked KOL has traded this contract yet." /></div>;
  return <div className="page profile-page token-detail-page"><Link className="back-link" to="/tokens"><ChevronLeft size={15} aria-hidden="true" />Back to tokens</Link><div className="profile-header"><TokenIdentity token={data.token || { address, symbol: null, name: null, logoUrl: null }} /><div className="profile-links"><span className="address-pill">{shortAddress(address, 7)}</span><a href={`https://bscscan.com/token/${address}`} target="_blank" rel="noopener noreferrer">Contract <ExternalLink size={14} /></a><a href={gmgnTokenUrl(address)} target="_blank" rel="noopener noreferrer">GMGN <ExternalLink size={14} /></a></div></div><div className="profile-stats"><Metric label="Observed price" value={compact(data.token?.priceUsd, true)} /><Metric label="Market cap" value={compact(data.token?.marketCapUsd, true)} /><Metric label="KOLs · 24h" value={data.token?.kolCount24h ?? '—'} /><Metric label="24h KOL volume" value={compact(data.token?.volume24hUsd, true)} /><Metric label="Last trade" value={relativeTime(data.token?.lastTradeAt)} /></div><div className="profile-grid"><section><div className="table-toolbar"><div><h2>KOL trades</h2><span>Recent activity in this token</span></div></div><div className="data-table profile-trades">{data.trades.map(trade => <TradeRow key={trade.id} trade={trade} bnbPriceUsd={bnbPriceUsd} />)}</div></section><section><div className="table-toolbar"><div><h2>KOLs trading it</h2></div></div><div className="kol-list">{data.kols.map(kol => <Link key={kol.address} to={`/kol/${kol.address}`}><Identity name={kol.name} address={kol.address} avatar={kol.avatarUrl} twitter={kol.twitter} /><ArrowUpRight size={16} /></Link>)}</div></section></div></div>;
}

export default function App() {
  const { data: overview } = useData<Overview>('/api/overview', EMPTY_OVERVIEW, 10000);
  return <>
    <Header overview={overview} />
    <main><Routes>
      <Route path="/" element={<Navigate to="/trades" replace />} />
      <Route path="/trades" element={<TradesPage overview={overview} />} />
      <Route path="/tokens" element={<TokensPage bnbPriceUsd={overview.bnbPriceUsd} />} />
      <Route path="/leaderboard" element={<LeaderboardPage overview={overview} />} />
      <Route path="/kol/:address" element={<KolPage bnbPriceUsd={overview.bnbPriceUsd} />} />
      <Route path="/token/:address" element={<TokenPage bnbPriceUsd={overview.bnbPriceUsd} />} />
      <Route path="/privacy-policy" element={<PrivacyPolicyPage />} />
      <Route path="/terms-of-use" element={<TermsOfUsePage />} />
      <Route path="*" element={<Navigate to="/trades" replace />} />
    </Routes></main>
    <footer className="footer">
      <div><span className="footer-brand"><img src="/bscan-mark.png" alt="" />bscan</span><span>BNB Smart Chain KOL analytics.</span></div>
      <nav className="footer-legal" aria-label="Legal"><span aria-hidden="true">|</span><Link to="/privacy-policy">Privacy Policy</Link><span aria-hidden="true">|</span><Link to="/terms-of-use">Terms of Use</Link></nav>
    </footer>
  </>;
}
