import { t, useLanguage, getLocale, localDate } from './i18n';
import { TokenWatchlistPage } from './TokenWatchlist';
import { TokenMarketPanel } from './TokenMarketPanel';
import { WatchlistMarquee } from './WatchlistMarquee';
import { WatchMarketValue, WatchSparkline, WatchTokenChange } from './WatchTokenVisuals';
import { LanguageSelect } from './LanguageSelect';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, NavLink, Navigate, Route, Routes, useNavigate, useSearchParams, useLocation } from 'react-router-dom';
import { Activity, ArrowDownLeft, ArrowLeftRight, ArrowUpRight, Check, ChevronLeft, Copy, ExternalLink, Globe, Menu, Search, Star, X } from 'lucide-react';
import { api, compact, relativeTime, shortAddress, signedMoney } from './lib';
import type { Kol, LeaderboardRow, Overview, Token, Trade } from './types';
import { PrivacyPolicyPage, TermsOfUsePage } from './LegalPages';
import { FeatureTabs, FollowButton, LaunchesView, PositionBadge, RadarFeed, usePositions, useWatchlist, WatchlistProvider, WatchlistView } from './Intelligence';
import './watchlistBanner.css';
import type { Position } from '../shared/intelligence';
import { TokenName, useTokenTranslation } from './TokenName';

type List<T> = { items: T[]; nextCursor?: string | null };
const EMPTY_OVERVIEW: Overview = { trackedKols: 0, trades24h: 0, tokens24h: 0, latestTradeAt: null, lastTokenPriceAt: null, lastNodeBlock: null, nodeLagBlocks: null, lastNodeAt: null, bnbPriceUsd: null, bnbPriceAt: null, lastLeaderboardAt: null, leaderboardSource: 'onchain_estimate' };
const gmgnTokenUrl = (address: string) => `https://gmgn.ai/bsc/token/${address}`;
const gmgnWalletUrl = (address: string) => `https://gmgn.ai/bsc/address/${address}`;
const isFresh = (value: string | null, limitMs: number) => Boolean(value && Date.now() - new Date(value).getTime() < limitMs);
const skopjeTimeZone = () => new Intl.DateTimeFormat('en', { timeZone: 'Europe/Skopje', timeZoneName: 'shortOffset' })
  .formatToParts(Date.now()).find(part => part.type === 'timeZoneName')!.value.replace('GMT', 'UTC');
function tradeTokenAmount(value: string | null) {
  if (value == null) return '—';
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) return '—';
  if (amount > 0 && amount < 0.001) return '<0.001';
  return new Intl.NumberFormat(getLocale(), { notation: amount >= 1000 ? 'compact' : 'standard', maximumFractionDigits: 3 }).format(amount);
}
function tradeBnbValue(trade: Trade, bnbPriceUsd: number | null) {
  const direct = trade.quoteAmount != null && ['BNB', 'WBNB'].includes(trade.quoteSymbol?.toUpperCase() || '') ? Number(trade.quoteAmount) : NaN;
  const estimated = trade.amountUsd != null && bnbPriceUsd && bnbPriceUsd > 0 ? Number(trade.amountUsd) / bnbPriceUsd : NaN;
  const amount = Number.isFinite(direct) && direct >= 0 ? direct : estimated;
  if (!Number.isFinite(amount) || amount < 0) return '— BNB';
  if (amount > 0 && amount < 0.001) return '<0.001 BNB';
  return `${Number.isFinite(direct) && direct >= 0 ? '' : '≈'}${new Intl.NumberFormat(getLocale(), { maximumFractionDigits: 3 }).format(amount)} BNB`;
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
function TokenImage({ logoUrl }: { logoUrl: string }) {
  const [attempt, setAttempt] = useState(0);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!failed || attempt >= 4) return;
    const timer = window.setTimeout(() => { setAttempt(current => current + 1); setFailed(false); }, [1000, 3000, 10000, 20000][attempt]);
    return () => window.clearTimeout(timer);
  }, [failed, attempt]);
  useEffect(() => {
    const retry = () => { setAttempt(current => current + 1); setFailed(false); };
    window.addEventListener('online', retry);
    return () => window.removeEventListener('online', retry);
  }, []);
  const source = attempt === 1 ? logoUrl : tokenImageSrc(logoUrl);
  const src = attempt > 0 ? `${source}${source.includes('?') ? '&' : '?'}retry=${attempt}` : source;
  return <img src={src} alt="" style={{ visibility: failed ? 'hidden' : undefined }} onLoad={() => setFailed(false)} onError={() => setFailed(true)} />;
}
function TokenIdentity({ token }: { token: Pick<Token, 'address' | 'symbol' | 'name' | 'logoUrl'> }) {
  return <span className="identity token-identity"><span className="token-avatar"><span>{(token.symbol || '?').slice(0, 1)}</span>{token.logoUrl && <TokenImage key={token.logoUrl} logoUrl={token.logoUrl} />}</span><TokenName token={token} /></span>;
}

function XBrandIcon({ size = 18 }: { size?: number }) {
  return <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor" aria-hidden="true"><path d="M18.901 1.153h3.68l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.64 7.584H.47l8.6-9.829L0 1.154h7.594l5.243 6.932 6.064-6.933Zm-1.29 19.491h2.039L6.486 3.24H4.299l13.312 17.404Z" /></svg>;
}

function CopyAddress({ address, label }: { address: string; label: string }) {
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
  return <button className="address-pill copy-wallet" type="button" onClick={() => void copy()} title={`${t('Copy {label}', { label: label.toLowerCase() })}: ${address}`} aria-label={state === 'copied' ? t('{label} copied', { label }) : t('Copy {label}', { label: label.toLowerCase() })} aria-live="polite">{state === 'copied' ? t("Copied") : state === 'failed' ? t("Copy failed") : shortAddress(address, 7)}{state === 'copied' ? <Check size={14} /> : <Copy size={14} />}</button>;
}

function ChainLogo() { return <img className="bnb-logo" src="/bnb-chain.svg" alt={t("BNB Chain")} />; }

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
  return <div className="dialog-scrim" onMouseDown={close}><div className="search-dialog" role="dialog" aria-modal="true" aria-label={t("Search bscan")} onMouseDown={event => event.stopPropagation()}>
    <div className="search-input-row"><Search size={20} /><input autoFocus placeholder={t("Search KOL, wallet, token, or contract")} value={query} onChange={event => setQuery(event.target.value)} /><button className="icon-button" aria-label={t("Close search")} onClick={close}><X size={18} /></button></div>
    <div className="search-results">{!query && <p className="search-hint">{t("Search tracked KOL wallets and tokens on BNB Smart Chain.")}</p>}
      {results.kols.length > 0 && <><span className="eyebrow">{t("KOLs")}</span>{results.kols.map(kol => <button className="search-result" key={kol.address} onClick={() => go(`/kol/${kol.address}`)}><Identity name={kol.name} address={kol.address} avatar={kol.avatarUrl} twitter={kol.twitter} /><ArrowUpRight size={16} /></button>)}</>}
      {results.tokens.length > 0 && <><span className="eyebrow">{t("Tokens")}</span>{results.tokens.map(token => <button className="search-result" key={token.address} onClick={() => go(`/token/${token.address}`)}><TokenIdentity token={token} /><ArrowUpRight size={16} /></button>)}</>}
      {query && !results.kols.length && !results.tokens.length && <p className="search-hint">{t("No tracked results. Try a contract address or KOL name.")}</p>}
    </div>
  </div></div>;
}

function Header({ overview }: { overview: Overview }) {
  const [searchOpen, setSearchOpen] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  useEffect(() => { const onKey = (event: KeyboardEvent) => { if (event.key === '/' && !(event.target instanceof HTMLInputElement)) { event.preventDefault(); setSearchOpen(true); } }; document.addEventListener('keydown', onKey); return () => document.removeEventListener('keydown', onKey); }, []);
  return <><header className="site-header"><div className="header-inner">
    <Link className="brand" to="/trades"><img className="brand-logo" src="/bscan-fingerprint-logo.svg?v=2" alt="bscan" width="103" height="30" /></Link>
    <span className="header-divider" />
    <nav className={mobileOpen ? 'main-nav open' : 'main-nav'} aria-label={t("Main navigation")}>
      <NavLink to="/trades" onClick={() => setMobileOpen(false)}>{t("Trades")}</NavLink><NavLink to="/tokens" onClick={() => setMobileOpen(false)}>{t("Tokens")}</NavLink><NavLink to="/leaderboard" onClick={() => setMobileOpen(false)}>{t("Leaderboard")}</NavLink><NavLink to="/watchlist" onClick={() => setMobileOpen(false)}>{t("Watchlist")}</NavLink>
      <a className="mobile-social-link" href="https://x.com/bscanfun" target="_blank" rel="noopener noreferrer"><XBrandIcon size={14} />{t('bscan on X')}</a>
    </nav>
    <div className="header-social">
      <span className="bnb-price" title={overview.bnbPriceAt ? t('Chainlink BNB/USD updated {time}', { time: localDate(overview.bnbPriceAt) }) : t("BNB/USD price unavailable")}><span>BNB</span><strong>{isFresh(overview.bnbPriceAt, 2 * 60 * 60_000) ? compact(overview.bnbPriceUsd, true) : '—'}</strong></span>
      <a className="header-x-link" href="https://x.com/bscanfun" target="_blank" rel="noopener noreferrer" aria-label={t("bscan on X")} title={t("bscan on X")}><svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M18.901 1.153h3.68l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.64 7.584H.47l8.6-9.829L0 1.154h7.594l5.243 6.932 6.064-6.933Zm-1.29 19.491h2.039L6.486 3.24H4.299l13.312 17.404Z" /></svg></a>
    </div>
    <div className="header-right"><LanguageSelect /><span className="chain-label"><ChainLogo /><span>{t("On BNB Chain")}</span></span><button className="header-search" onClick={() => setSearchOpen(true)} aria-label={t("Search")}><Search size={18} /><span>{t("Search")}</span><kbd>/</kbd></button><button className="mobile-menu icon-button" onClick={() => setMobileOpen(!mobileOpen)} aria-label={t("Toggle menu")}><Menu size={21} /></button></div>
  </div></header>{searchOpen && <SearchDialog close={() => setSearchOpen(false)} />}</>;
}

function WatchlistBanner() {
  const watch = useWatchlist();
  const tokens = watch.data.items.filter(item => item.kind === 'token');
  return <nav className="watchlist-banner" aria-label={t('Watchlist tokens')}>
    <div className="watchlist-banner-inner">
      <Link className="watchlist-banner-shortcut" to="/watchlist" title={t('Watchlist')} aria-label={t('Watchlist')}><Star size={15} fill="currentColor" /><span>{t('Watchlist')}</span></Link>
      <WatchlistMarquee enabled={tokens.length > 0} label={t('Watchlist tokens')}>
        {tokens.map(token => {
          return <Link className="watchlist-banner-token" key={token.address} to={`/token/${token.address}`} title={token.name || token.symbol || token.address}>
            <span className="watchlist-banner-avatar"><span>{(token.symbol || token.name || '?').slice(0, 1)}</span>{token.logoUrl && <TokenImage key={token.logoUrl} logoUrl={token.logoUrl} />}</span>
            <strong>{token.symbol || token.name || shortAddress(token.address)}</strong>
            <span className="watchlist-banner-cap" title={t('Market cap')}>MC <WatchMarketValue value={token.marketCapUsd} /></span>
            <WatchTokenChange token={token} period="7d" />
            <WatchSparkline address={token.address} priceUsd={token.priceUsd} period="7d" label="Token price chart · 1 week" />
          </Link>;
        })}
        {!tokens.length && <Link className="watchlist-banner-empty" to="/tokens">{!watch.loaded ? t('Loading…') : t('Star tokens to add them here')}</Link>}
      </WatchlistMarquee>
    </div>
  </nav>;
}

function EmptyState({ title, detail }: { title: string; detail: string }) { return <div className="empty-state"><span className="empty-icon"><Activity size={22} /></span><strong>{title}</strong><p>{detail}</p></div>; }
function SectionTitle({ eyebrow, title, description, right }: { eyebrow: string; title: string; description?: string; right?: React.ReactNode }) { return <div className="section-title"><div><span className="eyebrow">{eyebrow}</span><h1>{title}</h1>{description && <p>{description}</p>}</div>{right}</div>; }
function Metric({ label, value, detail }: { label: string; value: string | number; detail?: string }) { return <div className="metric"><span>{label}</span><strong>{value}</strong>{detail && <small>{detail}</small>}</div>; }

function TradeRow({ trade, bnbPriceUsd, showSide = true, tokenGmgnLink = false }: { trade: Trade; bnbPriceUsd: number | null; showSide?: boolean; tokenGmgnLink?: boolean }) {
  const sideIcon = trade.side === 'buy' ? <ArrowDownLeft size={14} /> : trade.side === 'sell' ? <ArrowUpRight size={14} /> : <ArrowLeftRight size={14} />;
  const tokenIdentity = <TokenIdentity token={{ address: trade.tokenAddress, symbol: trade.tokenSymbol, name: trade.tokenName, logoUrl: trade.tokenLogoUrl }} />;
  return <div className="trade-row">
    <div className="trade-kol"><Link to={`/kol/${trade.walletAddress}`}><Identity name={trade.kolName} address={trade.walletAddress} avatar={trade.kolAvatarUrl} twitter={trade.kolTwitter} subtitle={false} /></Link></div>
    <div className="trade-activity">{showSide && <span className={`side-pill ${trade.side}`}>{sideIcon}{t(trade.side)}</span>}{tokenGmgnLink ? <a href={gmgnTokenUrl(trade.tokenAddress)} target="_blank" rel="noopener noreferrer" title={t("View token on GMGN")}>{tokenIdentity}</a> : <Link to={`/token/${trade.tokenAddress}`}>{tokenIdentity}</Link>}</div>
    <div className={`trade-value ${trade.side}`} title={trade.quoteSymbol === 'BNB' || trade.quoteSymbol === 'WBNB' ? t("Recorded BNB trade amount") : t("Approximate BNB amount based on the current BNB/USD price")}><strong>{tradeBnbValue(trade, bnbPriceUsd)}</strong><span className="trade-amount">{tradeTokenAmount(trade.tokenAmount)}</span></div>
    <div className="trade-time"><a href={gmgnTokenUrl(trade.tokenAddress)} target="_blank" rel="noopener noreferrer" title={`${localDate(trade.timestamp)} · ${t('View token activity on GMGN')}`} aria-label={t('View {token} activity on GMGN, {time}', { token: trade.tokenSymbol || t('token'), time: relativeTime(trade.timestamp) })}>{relativeTime(trade.timestamp)}<ExternalLink size={13} /></a></div>
  </div>;
}

function TradesPage({ overview }: { overview: Overview }) {
  const [params] = useSearchParams();
  const view = params.get('view');
  if (view === 'radar' || view === 'watchlist') return <div className="page trades-page"><SectionTitle eyebrow={t("THE LIVE TAPE")} title={view === 'radar' ? t("Radar") : t("Watchlist")} /><FeatureTabs page="trades" />{view === 'radar' ? <RadarFeed /> : <WatchlistView />}</div>;
  return <TradeTape overview={overview} />;
}
function TradeTape({ overview }: { overview: Overview }) {
  const { data, loading, error } = useData<List<Trade>>('/api/trades?limit=10', { items: [], nextCursor: null }, 10000);
  const items = data.items.slice(0, 10);
  return <div className="page trades-page"><SectionTitle eyebrow={t("THE LIVE TAPE")} title={t("Realtime trades")} right={<div className="freshness"><i className={isFresh(overview.latestTradeAt, 15 * 60000) ? 'status-dot live' : 'status-dot'} /><span>{overview.latestTradeAt ? t('Latest trade {time}', { time: relativeTime(overview.latestTradeAt) }) : t("Waiting for trades")}</span></div>} />
    <FeatureTabs page="trades" /><div className="overview-strip"><Metric label={t("Tracked KOLs")} value={overview.trackedKols} /><Metric label={t("Trades · 24h")} value={compact(overview.trades24h)} /><Metric label={t("Tokens · 24h")} value={compact(overview.tokens24h)} /><Metric label={t("Last trade")} value={relativeTime(overview.latestTradeAt)} /></div>
    <div className="table-toolbar"><h2>{t("Recent activity")}</h2></div>
    <div className="data-table trades-table">{items.map(trade => <TradeRow key={trade.id} trade={trade} bnbPriceUsd={overview.bnbPriceUsd} showSide={false} tokenGmgnLink />)}{!items.length && !loading && <EmptyState title={error ? t("Live feed unavailable") : t("Watching for the next trade")} detail={error ? t("The API is reconnecting. Try again shortly.") : t("Trades from tracked KOL wallets will appear here automatically.")} />}</div>
    <section className="trades-faq" aria-labelledby="trades-faq-title">
      <h2 id="trades-faq-title">{t("FAQs")}</h2>
      <div className="faq-list">
        <details className="faq-item" name="trades-faq"><summary>{t("What does bscan track?")}</summary><p>{t("bscan shows token trades from a curated list of KOL wallets on BNB Smart Chain.")}</p></details>
        <details className="faq-item" name="trades-faq"><summary>{t("How often do new trades appear?")}</summary><p>{t("The feed updates automatically as newly indexed trades become available.")}</p></details>
        <details className="faq-item" name="trades-faq"><summary>{t("What can I find in the token tracker?")}</summary><p>{t("Browse tokens traded by tracked KOLs, grouped by market cap. Open a token to see its recent KOL trades and the wallets trading it.")}</p></details>
        <details className="faq-item" name="trades-faq"><summary>{t("What does a KOL profile show?")}</summary><p>{t("Each tracked wallet has a profile with its last 24 hours of trades, traded tokens, and realized profit from positions bought and sold in that window.")}</p></details>
        <details className="faq-item" name="trades-faq"><summary>{t("How does the leaderboard work?")}</summary><p>{t("It ranks tracked positions by realized USD profit over the last 24 hours. Sales without enough priced purchases in that window are excluded. A dash means there are no fully priced completed positions yet.")}</p></details>
      </div>
    </section>
    <section className="trades-follow" aria-labelledby="trades-follow-title"><div><h2 id="trades-follow-title">{t("Follow us on X")}</h2><p>{t("Updates from bscan.")}</p></div><a href="https://x.com/bscanfun" target="_blank" rel="noopener noreferrer">@bscanfun <ExternalLink size={15} /></a></section>
  </div>;
}

function TokenCard({ token, recentTrades, bnbPriceUsd, position, showPosition }: { token: Token; recentTrades?: Trade[]; bnbPriceUsd?: number | null; position?: Position; showPosition?: boolean }) {
  return <div className="token-card"><Link className="token-card-main" to={`/token/${token.address}`}><div className="token-card-top"><TokenIdentity token={token} /><span className="token-card-cap">{token.marketCapUsd ? t('MC {value}', { value: compact(token.marketCapUsd, true) }) : t("MC —")}</span></div><div className="token-card-stats"><div><span>{t("Observed price")}</span><strong>{compact(token.priceUsd, true)}</strong></div><div><span>{t("24h volume")}</span><strong>{compact(token.volume24hUsd, true)}</strong></div><div><span>{t("Last trade")}</span><strong>{relativeTime(token.lastTradeAt)}</strong></div></div></Link>
    <FollowButton kind="token" address={token.address} label={token.symbol} />{showPosition && <div className="token-position-row"><PositionBadge position={position} /></div>}
    {recentTrades && recentTrades.length > 0 && <div className="token-card-trades" aria-label={t('Recent {token} trades', { token: token.symbol || t('token') })}>
      {recentTrades.slice(0, 5).map(trade => <div className="token-card-trade" key={trade.id}>
        <Link className="token-trade-kol" to={`/kol/${trade.walletAddress}`} title={trade.kolName || trade.walletAddress}><Identity name={trade.kolName} address={trade.walletAddress} avatar={trade.kolAvatarUrl} subtitle={false} /></Link>
        <span className={`token-trade-side ${trade.side}`}>{t(trade.side)}</span>
        <span className={`token-trade-value ${trade.side}`}>{tradeBnbValue(trade, bnbPriceUsd ?? null)}</span>
        <time dateTime={trade.timestamp} title={localDate(trade.timestamp)}>{relativeTime(trade.timestamp)}</time>
      </div>)}
    </div>}
  </div>;
}

type LiveToken = Token & { recentTrades: Trade[] };
function TokensPage({ bnbPriceUsd }: { bnbPriceUsd: number | null }) {
  const [params] = useSearchParams();
  if (params.get('view') === 'launches') return <div className="page tokens-page"><SectionTitle eyebrow={t("KOL CONVICTION")} title={t("Launches")} /><FeatureTabs page="tokens" /><LaunchesView /></div>;
  return <TrackedTokensPage bnbPriceUsd={bnbPriceUsd} />;
}
function TrackedTokensPage({ bnbPriceUsd }: { bnbPriceUsd: number | null }) {
  const [initialWindowStart] = useState(() => new Date(Date.now() - 60 * 60_000).toISOString());
  const [items, setItems] = useState<LiveToken[]>([]);
  const { data, error } = useData<{ items: LiveToken[] }>(`/api/tokens?since=${encodeURIComponent(initialWindowStart)}&limit=300&withTrades=1`, { items: [] }, 10000);
  useEffect(() => {
    setItems(data.items);
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
  return <div className="page tokens-page"><SectionTitle eyebrow={t("KOL CONVICTION")} title={t("Meme coin tracker")} right={<div className="freshness"><i className={error ? 'status-dot' : 'status-dot live'} /><span>{error ? t("Live feed reconnecting") : t("Watching live trades")}</span></div>} />
    <FeatureTabs page="tokens" /><div className="token-columns">{([
      { key: 'low', title: t("Low caps"), range: t("Under $100K") },
      { key: 'mid', title: t("$100K+"), range: t("$100K to $1M") },
      { key: 'high', title: t("$1M+"), range: t("$1M and above") },
    ] as const).map(column => <section className="token-column" key={column.key}><div className="column-heading"><div><h2>{t(column.title)}</h2><p>{t(column.range)}</p></div></div><div className="token-list">{groups[column.key].map(token => <TokenCard key={token.address} token={token} recentTrades={token.recentTrades} bnbPriceUsd={bnbPriceUsd} />)}</div></section>)}</div>
  </div>;
}

function LeaderboardPage({ overview }: { overview: Overview }) {
  const { data, loading, error } = useData<List<LeaderboardRow>>('/api/leaderboard', { items: [] }, 60000);
  return <div className="page leaderboard-page"><SectionTitle eyebrow={t("THE PERFORMANCE BOARD")} title={t("KOL Leaderboard")} description={t("Realized profit from positions bought and sold in the last 24 hours.")} right={<div className="freshness"><i className={isFresh(overview.lastLeaderboardAt, 5 * 60000) ? 'status-dot live' : 'status-dot'} /><span>{overview.lastLeaderboardAt ? t('Calculated {time}', { time: relativeTime(overview.lastLeaderboardAt) }) : t("Calculating rankings")}</span></div>} />
    <div className="table-toolbar leaderboard-toolbar"><span className="small-label">{t("LAST 24 HOURS · RANKED BY REALIZED P&L")}</span><span className="coverage-note">{t('{active} active · {tracked} tracked KOLs', { active: data.items.filter(row => row.tradeCount24h > 0).length, tracked: data.items.length })}</span></div>
    <div className="data-table leaderboard-table">{data.items.map((row, index) => <div className="leaderboard-entry" key={row.address}><Link className={`leaderboard-row ${row.realizedProfitUsd == null || !row.tradeCount24h ? '' : `leader-rank-${index + 1}`}`} to={`/kol/${row.address}`}>
      <span className="rank-number">{row.realizedProfitUsd == null || !row.tradeCount24h ? '—' : String(index + 1).padStart(2, '0')}</span>
      <span className="leader-identity"><Identity name={row.name} address={row.address} avatar={row.avatarUrl} subtitle={false} /><span className="leader-handle">{row.twitter ? `@${row.twitter}` : shortAddress(row.address)}</span></span>
      <span className="leader-activity"><strong>{row.tradeCount24h} <span>{t(row.tradeCount24h === 1 ? 'trade' : 'trades')}</span></strong><span className="leader-sides"><span className="positive">{row.buyCount24h} {t(row.buyCount24h === 1 ? 'buy' : 'buys')}</span><span className="leader-separator">·</span><span className="negative">{row.sellCount24h} {t(row.sellCount24h === 1 ? 'sell' : 'sells')}</span></span></span>
      <strong className={`pnl ${row.realizedProfitUsd == null ? '' : Number(row.realizedProfitUsd) >= 0 ? 'positive' : 'negative'}`} title={t('{matched} matched sales in the last 24 hours; {excluded} sales excluded because purchase costs or prices are unavailable', { matched: row.valuedSellCount || 0, excluded: row.excludedSellCount || 0 })}>{signedMoney(row.realizedProfitUsd)}<small className="pnl-status">{row.realizedProfitUsd == null ? row.unpricedSellCount24h > 0 ? t("Unpriced sales") : t("Missing purchase costs") : t("24H realized P&L")}</small></strong>
    </Link><FollowButton kind="kol" address={row.address} label={row.name} /></div>)}{!data.items.length && !loading && <EmptyState title={error ? t("Leaderboard unavailable") : t("No KOL trades in the last 24 hours")} detail={error ? t("The API is reconnecting.") : t("Recent wallet activity will appear here automatically.")} />}</div>
  </div>;
}

function KolPage({ bnbPriceUsd }: { bnbPriceUsd: number | null }) {
  const address = window.location.pathname.split('/').pop() || '';
  const [extraTrades, setExtraTrades] = useState<Trade[]>([]);
  const [extraCursor, setExtraCursor] = useState<string | null | undefined>(undefined);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState(false);
  const [tokenPage, setTokenPage] = useState<{ address: string; items: Token[]; cursor?: string | null; visibleCount: number; loading: boolean; error: boolean }>({ address, items: [], visibleCount: 10, loading: false, error: false });
  const { data, loading } = useData<{ kol: Kol | null; stats: LeaderboardRow | null; trades: Trade[]; tradesNextCursor: string | null; tradeCount24h: number; buyCount24h: number; sellCount24h: number; unpricedSellCount24h: number; tokens: Token[]; tokensNextCursor: string | null; windowStart: string | null }>(`/api/kols/${address}`, { kol: null, stats: null, trades: [], tradesNextCursor: null, tradeCount24h: 0, buyCount24h: 0, sellCount24h: 0, unpricedSellCount24h: 0, tokens: [], tokensNextCursor: null, windowStart: null }, 20000);
  useEffect(() => { setExtraTrades([]); setExtraCursor(undefined); setMoreError(false); }, [address]);
  useEffect(() => { setTokenPage({ address, items: [], visibleCount: 10, loading: false, error: false }); }, [address]);
  const currentTokenPage = tokenPage.address === address ? tokenPage : { address, items: [], cursor: undefined, visibleCount: 10, loading: false, error: false };
  const allTokens = useMemo(() => {
    const unique = new Map<string, Token>();
    for (const token of [...(tokenPage.address === address ? tokenPage.items : []), ...data.tokens]) unique.set(token.address, token);
    return [...unique.values()].sort((a, b) => new Date(b.lastTradeAt || 0).getTime() - new Date(a.lastTradeAt || 0).getTime() || b.address.localeCompare(a.address));
  }, [data.tokens, tokenPage.items, tokenPage.address, address]);
  const visibleTokens = allTokens.slice(0, currentTokenPage.visibleCount);
  const positions = usePositions('kol', address, visibleTokens.map(token => token.address));
  const tokensNextCursor = currentTokenPage.cursor === undefined ? data.tokensNextCursor : currentTokenPage.cursor;
  const hasMoreTokens = allTokens.length > visibleTokens.length || Boolean(tokensNextCursor);
  const loadMoreTokens = async () => {
    if (currentTokenPage.loading || !hasMoreTokens) return;
    if (allTokens.length >= currentTokenPage.visibleCount + 10 || !tokensNextCursor) {
      setTokenPage(current => current.address === address ? { ...current, visibleCount: current.visibleCount + 10 } : current);
      return;
    }
    setTokenPage(current => ({ ...current, items: allTokens, loading: true, error: false }));
    try {
      const page = await api<List<Token>>(`/api/kols/${encodeURIComponent(address)}/tokens?cursor=${encodeURIComponent(tokensNextCursor)}`);
      setTokenPage(current => current.address === address ? { ...current, items: [...current.items, ...page.items], cursor: page.nextCursor ?? null, visibleCount: current.visibleCount + 10, loading: false } : current);
    } catch {
      setTokenPage(current => current.address === address ? { ...current, loading: false, error: true } : current);
    }
  };
  const visibleTrades = useMemo(() => {
    const unique = new Map<string, Trade>();
    for (const trade of [...data.trades, ...extraTrades]) unique.set(trade.id, trade);
    const cutoff = data.windowStart ? Date.parse(data.windowStart) : Infinity;
    return [...unique.values()].filter(trade => new Date(trade.timestamp).getTime() >= cutoff)
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime() || b.id.localeCompare(a.id));
  }, [data.trades, extraTrades, data.windowStart]);
  const nextCursor = extraCursor === undefined ? data.tradesNextCursor : extraCursor;
  const loadMore = async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    setMoreError(false);
    try {
      const page = await api<List<Trade>>(`/api/trades?kol=${encodeURIComponent(address)}&window=24h&limit=20&cursor=${encodeURIComponent(nextCursor)}`);
      setExtraTrades(current => [...current, ...page.items]);
      setExtraCursor(page.nextCursor ?? null);
    } catch { setMoreError(true); }
    finally { setLoadingMore(false); }
  };
  if (!loading && !data.kol) return <div className="page"><EmptyState title={t("KOL not found")} detail={t("This wallet is not in the supplied KOL roster.")} /></div>;
  return <div className="page profile-page kol-detail-page"><Link className="back-link" to="/leaderboard"><ChevronLeft size={15} aria-hidden="true" />{t("Back to leaderboard")}</Link><div className="profile-header"><a className="profile-title-link" href={gmgnWalletUrl(address)} target="_blank" rel="noopener noreferrer" title={t("View KOL profile on GMGN")}><Identity name={data.kol?.name || null} address={address} avatar={data.kol?.avatarUrl} twitter={data.kol?.twitter} subtitle={false} /></a><div className="profile-links"><FollowButton kind="kol" address={address} label={data.kol?.name} /><CopyAddress key={address} address={address} label={t("KOL wallet address")} /><a className="profile-icon-link" href={`https://bscscan.com/address/${address}`} target="_blank" rel="noopener noreferrer" aria-label={t("View KOL wallet on BscScan")} title={t("View wallet on BscScan")}><img src="/bscscan-icon-light.svg" alt="" width="18" height="18" /></a><a className="profile-icon-link" href={gmgnWalletUrl(address)} target="_blank" rel="noopener noreferrer" aria-label={t("View KOL profile on GMGN")} title={t("View KOL profile on GMGN")}><img src="/gmgn-icon-transparent.png" alt="" width="24" height="24" /></a>{data.kol?.twitter && <a className="profile-icon-link" href={`https://x.com/${data.kol.twitter}`} target="_blank" rel="noopener noreferrer" aria-label={t("View KOL on X")} title={t("View KOL on X")}><XBrandIcon /></a>}</div></div>
    <div className="profile-stats"><Metric label={t("24H tracked realized P&L")} value={signedMoney(data.stats?.realizedProfitUsd)} detail={data.stats?.realizedProfitUsd == null ? (data.unpricedSellCount24h > 0 ? t("Sale prices unavailable") : t("Purchase costs unavailable in the last 24 hours")) : t('{matched} matched sales · {excluded} excluded', { matched: data.stats?.valuedSellCount || 0, excluded: data.stats?.excludedSellCount || 0 })} /><Metric label={t("Trades · last 24 hours")} value={data.tradeCount24h} detail={t('{buys} buys · {sells} sells · {zone}', { buys: data.buyCount24h, sells: data.sellCount24h, zone: skopjeTimeZone() })} /><Metric label={t("Last trade")} value={relativeTime(data.kol?.lastSeenAt)} /></div>
    <div className="profile-grid"><section><div className="table-toolbar"><div><h2>{t("Trades · last 24 hours")}</h2><span>{t('{count} indexed trades from this wallet', { count: data.tradeCount24h })}</span></div></div><div className="data-table profile-trades">{visibleTrades.map(trade => <TradeRow key={trade.id} trade={trade} bnbPriceUsd={bnbPriceUsd} />)}{!visibleTrades.length && !loading && <EmptyState title={t("No trades in the last 24 hours")} detail={t("New swaps from this wallet will appear here automatically.")} />}</div>{nextCursor && <button className="profile-load-more" type="button" onClick={() => void loadMore()} disabled={loadingMore}>{loadingMore ? t("Loading trades…") : t("Load more trades")}</button>}{moreError && <p className="profile-more-error">{t("Could not load more trades. Try again.")}</p>}</section><section><div className="table-toolbar"><div><h2>{t("Traded tokens")}</h2><span>{t("Recent token activity")}</span></div></div><div className="profile-token-list">{visibleTokens.map(token => <TokenCard key={token.address} token={token} position={positions.get(token.address)} showPosition />)}{!visibleTokens.length && !loading && <EmptyState title={t("No tracked tokens yet")} detail={t("Tokens appear after a tracked swap.")} />}</div>{hasMoreTokens && <button className="profile-load-more" type="button" onClick={() => void loadMoreTokens()} disabled={currentTokenPage.loading}>{currentTokenPage.loading ? t("Loading tokens…") : t("Load more tokens")}</button>}{currentTokenPage.error && <p className="profile-more-error" role="alert">{t("Could not load more tokens. Try again.")}</p>}</section></div>
  </div>;
}

function TokenPage({ bnbPriceUsd }: { bnbPriceUsd: number | null }) {
  const address = window.location.pathname.split('/').pop() || '';
  const [kolPage, setKolPage] = useState({ address, visibleCount: 15 });
  const visibleKolCount = kolPage.address === address ? kolPage.visibleCount : 15;
  const positions = usePositions('token', address);
  const { data: website } = useData<{ tokenAddress: string | null; websiteUrl: string | null }>(`/api/tokens/${address}/website`, { tokenAddress: null, websiteUrl: null }, 300000);
  const tokenWebsite = website.tokenAddress === address ? website.websiteUrl : null;
  const [tradePage, setTradePage] = useState<{ address: string; items: Trade[]; cursor?: string | null; visibleCount: number; loading: boolean; error: boolean }>({ address, items: [], visibleCount: 20, loading: false, error: false });
  const { data, loading } = useData<{ token: Token | null; trades: Trade[]; tradesNextCursor: string | null; kols: Kol[] }>(`/api/tokens/${address}`, { token: null, trades: [], tradesNextCursor: null, kols: [] }, 20000);
  const translatedToken = useTokenTranslation(data.token?.address === address.toLowerCase() ? data.token : { address });
  useEffect(() => {
    setTradePage({ address, items: [], visibleCount: 20, loading: false, error: false });
    setKolPage({ address, visibleCount: 15 });
  }, [address]);
  const currentTradePage = tradePage.address === address ? tradePage : { address, items: [], cursor: undefined, visibleCount: 20, loading: false, error: false };
  const allTrades = useMemo(() => {
    const unique = new Map<string, Trade>();
    for (const trade of [...(tradePage.address === address ? tradePage.items : []), ...data.trades]) unique.set(trade.id, trade);
    return [...unique.values()].sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime() || b.id.localeCompare(a.id));
  }, [data.trades, tradePage.items, tradePage.address, address]);
  const visibleTrades = allTrades.slice(0, currentTradePage.visibleCount);
  const nextCursor = currentTradePage.cursor === undefined ? data.tradesNextCursor : currentTradePage.cursor;
  const hasMoreTrades = allTrades.length > visibleTrades.length || Boolean(nextCursor);
  const loadMore = async () => {
    if (currentTradePage.loading || !hasMoreTrades) return;
    if (allTrades.length >= currentTradePage.visibleCount + 20 || !nextCursor) {
      setTradePage(current => current.address === address ? { ...current, visibleCount: current.visibleCount + 20 } : current);
      return;
    }
    setTradePage(current => ({ ...current, items: allTrades, loading: true, error: false }));
    try {
      const page = await api<List<Trade>>(`/api/trades?token=${encodeURIComponent(address)}&limit=20&cursor=${encodeURIComponent(nextCursor)}`);
      setTradePage(current => current.address === address ? { ...current, items: [...current.items, ...page.items], cursor: page.nextCursor ?? null, visibleCount: current.visibleCount + 20, loading: false } : current);
    } catch {
      setTradePage(current => current.address === address ? { ...current, loading: false, error: true } : current);
    }
  };
  if (!loading && !data.token) return <div className="page"><EmptyState title={t("Token not found")} detail={t("No tracked KOL has traded this contract yet.")} /></div>;
  return <div className="page profile-page token-detail-page"><div className="token-page-toolbar"><Link className="back-link" to="/tokens"><ChevronLeft size={15} aria-hidden="true" />{t("Back to tokens")}</Link><div className="profile-links"><FollowButton kind="token" address={address} label={data.token?.symbol} /><CopyAddress key={address} address={address} label={t("Token contract address")} /><a className="profile-icon-link" href={`https://bscscan.com/token/${address}`} target="_blank" rel="noopener noreferrer" aria-label={t("View token contract on BscScan")} title={t("View contract on BscScan")}><img src="/bscscan-icon-light.svg" alt="" width="18" height="18" /></a><a className="profile-icon-link" href={gmgnTokenUrl(address)} target="_blank" rel="noopener noreferrer" aria-label={t("View token on GMGN")} title={t("View token on GMGN")}><img src="/gmgn-icon-transparent.png" alt="" width="24" height="24" /></a>{tokenWebsite && <a className="profile-icon-link" href={tokenWebsite} target="_blank" rel="noopener noreferrer" aria-label={t("Visit token website")} title={t("Visit token website")}><Globe size={18} /></a>}</div></div><TokenMarketPanel key={address} address={address} identity={<div className="token-profile-title"><a className="profile-title-link" href={gmgnTokenUrl(address)} target="_blank" rel="noopener noreferrer" title={t("View token on GMGN")}><TokenIdentity token={data.token || { address, symbol: null, name: null, logoUrl: null }} /></a>{translatedToken?.sourceText && !translatedToken.englishName && <div className="token-translation-fallback" title={t('Automatic translation of {name}', { name: translatedToken.sourceText })}><a href={`https://translate.google.com/?sl=zh-CN&tl=en&text=${encodeURIComponent(translatedToken.sourceText)}&op=translate`} target="_blank" rel="noopener noreferrer">{t("Translate name")}<ExternalLink size={12} /></a></div>}</div>} /><div className="profile-grid"><section><div className="table-toolbar"><div><h2>{t("KOL trades")}</h2><span>{t("Recent activity in this token")}</span></div></div><div className="data-table profile-trades">{visibleTrades.map(trade => <TradeRow key={trade.id} trade={trade} bnbPriceUsd={bnbPriceUsd} />)}{!visibleTrades.length && !loading && <EmptyState title={t("No tracked trades yet")} detail={t("New KOL trades in this token will appear here automatically.")} />}</div>{hasMoreTrades && <button className="profile-load-more" type="button" onClick={() => void loadMore()} disabled={currentTradePage.loading}>{currentTradePage.loading ? t("Loading trades…") : t("Load more trades")}</button>}{currentTradePage.error && <p className="profile-more-error" role="alert">{t("Could not load more trades. Try again.")}</p>}</section><section><div className="table-toolbar"><div><h2>{t("KOLs trading it")}</h2></div></div><div className="kol-list">{data.kols.slice(0, visibleKolCount).map(kol => <div className="kol-holder-row" key={kol.address}><Link to={`/kol/${kol.address}`}><Identity name={kol.name} address={kol.address} avatar={kol.avatarUrl} twitter={kol.twitter} /></Link><PositionBadge position={positions.get(kol.address)} /></div>)}</div>{data.kols.length > visibleKolCount && <button className="profile-load-more" type="button" onClick={() => setKolPage({ address, visibleCount: visibleKolCount + 15 })}>{t("Load more KOLs")}</button>}</section></div></div>;
}

export default function App() {
  const [language] = useLanguage();
  const { pathname } = useLocation();
  useEffect(() => { document.documentElement.lang = language; if (!['/privacy-policy', '/terms-of-use'].includes(pathname)) document.title = t('bscan — BSC KOL tracker'); }, [language, pathname]);
  const { data: overview } = useData<Overview>('/api/overview', EMPTY_OVERVIEW, 10000);
  return <WatchlistProvider>
    <Header overview={overview} />
    <WatchlistBanner />
    <main><Routes>
      <Route path="/" element={<Navigate to="/trades" replace />} />
      <Route path="/trades" element={<TradesPage overview={overview} />} />
      <Route path="/tokens" element={<TokensPage bnbPriceUsd={overview.bnbPriceUsd} />} />
      <Route path="/watchlist" element={<TokenWatchlistPage />} />
      <Route path="/leaderboard" element={<LeaderboardPage overview={overview} />} />
      <Route path="/kol/:address" element={<KolPage bnbPriceUsd={overview.bnbPriceUsd} />} />
      <Route path="/token/:address" element={<TokenPage bnbPriceUsd={overview.bnbPriceUsd} />} />
      <Route path="/privacy-policy" element={<PrivacyPolicyPage />} />
      <Route path="/terms-of-use" element={<TermsOfUsePage />} />
      <Route path="*" element={<Navigate to="/trades" replace />} />
    </Routes></main>
    <footer className="footer">
      <div><span className="footer-brand"><img src="/bscan-fingerprint-icon.svg" alt="" width="18" height="18" /><span>bscan</span></span><span>{t("BNB Smart Chain KOL analytics.")}</span></div>
      <nav className="footer-legal" aria-label={t("Legal")}><span aria-hidden="true">|</span><Link to="/privacy-policy">{t("Privacy Policy")}</Link><span aria-hidden="true">|</span><Link to="/terms-of-use">{t("Terms of Use")}</Link></nav>
    </footer>
  </WatchlistProvider>;
}
