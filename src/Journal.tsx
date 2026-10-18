import { journalCoverageNotice } from './journalMessages';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus, RefreshCw, Shield, Trash2, Wallet } from 'lucide-react';
import type { JournalActivity, JournalPosition, JournalSummary, JournalWallet, JournalWallets } from '../shared/journal';
import { useAccount } from './Account';
import { t, useLanguage, getLocale, localDate } from './i18n';
import { compact, shortAddress } from './lib';
import { TradeModalLoader } from './TradeModalLoader';
import type { Kol, Token } from './types';
import './journal.css';

function money(value: string | null | undefined, signed = false) {
  return value == null ? '—' : new Intl.NumberFormat(getLocale(), { style: 'currency', currency: 'USD', maximumFractionDigits: 2, signDisplay: signed ? 'exceptZero' : 'auto' }).format(Number(value));
}
export async function journalRequest<T>(accountId: string, path: string, signal?: AbortSignal, method = 'GET', body?: object): Promise<T> {
  const response = await fetch(`/api/journal${path}`, { method, cache: 'no-store', signal,
    headers: { 'Content-Type': 'application/json', 'X-Watchlist-Owner': accountId }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Portfolio could not load. Try again.');
  return result as T;
}
const emptyWallets: JournalWallets = { wallets: [], limit: 3 };
export function PortfolioPage() {
  const account = useAccount();
  return <PortfolioContent key={account.state.user?.id ?? 'guest'} />;
}
function PortfolioContent() {
  useLanguage();
  const account = useAccount(), user = account.state.user;
  const [wallets, setWallets] = useState<JournalWallets>(emptyWallets), [selection, setSelection] = useState('all');
  const [summary, setSummary] = useState<JournalSummary | null>(null), [activity, setActivity] = useState<JournalActivity | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [revision, setRevision] = useState(0);
  const [adding, setAdding] = useState(false), [address, setAddress] = useState(''), [label, setLabel] = useState('');
  const [positionFilter, setPositionFilter] = useState<'all' | 'open' | 'closed'>('all');
  const [selected, setSelected] = useState<{ wallet: string; position: JournalPosition } | null>(null);
  const identity = useRef(user?.id);
  identity.current = user?.id;
  const reload = useCallback(() => setRevision(value => value + 1), []);
  useEffect(() => { setWallets(emptyWallets); setSummary(null); setActivity(null); setSelected(null); setSelection('all'); setError(''); }, [user?.id]);
  useEffect(() => {
    if (!user) return;
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
    setBusy(true); setSummary(null); setActivity(null);
    const load = async () => {
      try {
        const list = await journalRequest<JournalWallets>(user.id, '/wallets', controller.signal);
        if (controller.signal.aborted) return;
        setWallets(list);
        if (selection !== 'all' && !list.wallets.some(value => value.address === selection)) { setSelection('all'); return; }
        if (!list.wallets.length) { setSummary(null); setActivity(null); setError(''); return; }
        const query = `?wallet=${encodeURIComponent(selection)}`;
        const [nextSummary, nextActivity] = await Promise.all([
          journalRequest<JournalSummary>(user.id, `/summary${query}`, controller.signal),
          journalRequest<JournalActivity>(user.id, `/activity${query}`, controller.signal),
        ]);
        if (controller.signal.aborted) return;
        setSummary(nextSummary); setActivity(current => current?.activityFrom === nextActivity.activityFrom && current.trades.length > nextActivity.trades.length
          && JSON.stringify(current.trades.slice(0, nextActivity.trades.length)) === JSON.stringify(nextActivity.trades)
          ? { ...nextActivity, trades: [...nextActivity.trades, ...current.trades.slice(nextActivity.trades.length)], cursor: current.cursor } : nextActivity);
        setError('');
        timer = setTimeout(() => void load(), nextSummary.preparing ? Math.max(3000, nextSummary.retryAfterMs ?? 3000) : 30_000);
      } catch (problem) { if (!controller.signal.aborted) { setError(problem instanceof Error ? problem.message : 'Portfolio could not load. Try again.'); timer = setTimeout(() => void load(), 10_000); } }
      finally { if (!controller.signal.aborted) setBusy(false); }
    };
    void load(); return () => { controller.abort(); clearTimeout(timer); };
  }, [user?.id, selection, revision]);
  const mutate = async (path: string, method: string, body?: object) => {
    if (!user || busy) return;
    const owner = user.id; setBusy(true); setError('');
    try { await journalRequest(owner, path, undefined, method, body); if (identity.current === owner) { setAdding(false); setAddress(''); setLabel(''); setSelected(null); reload(); } }
    catch (problem) { if (identity.current === owner) setError(problem instanceof Error ? problem.message : 'Portfolio could not load. Try again.'); }
    finally { if (identity.current === owner) setBusy(false); }
  };
  const more = async () => {
    if (!user || !activity?.cursor || busy) return;
    const owner = user.id; setBusy(true);
    try { const next = await journalRequest<JournalActivity>(owner, `/activity?wallet=${encodeURIComponent(selection)}&cursor=${encodeURIComponent(activity.cursor)}`); if (identity.current === owner) setActivity(current => ({ ...next, trades: [...(current?.trades ?? []), ...next.trades.filter(row => !current?.trades.some(old => old.id === row.id && old.walletAddress === row.walletAddress))] })); }
    catch { setError('Portfolio could not load. Try again.'); } finally { if (identity.current === owner) setBusy(false); }
  };
  if (!user) return <div className="page journal-page"><div className="journal-title"><h1>{t('Portfolio')}</h1><Shield size={20} /></div><div className="journal-empty"><Wallet size={30} /><h2>{t('Your wallets, privately tracked')}</h2><p>{t('Sign in with Telegram to track up to three BNB wallets. No wallet connection is needed.')}</p><button className="journal-primary" type="button" disabled={!account.loaded || !account.state.enabled} onClick={() => void account.login()}>{t('Log in with Telegram')}</button></div></div>;
  const selectedWallets = selection === 'all' ? wallets.wallets : wallets.wallets.filter(value => value.address === selection);
  const positions = summary?.positions.filter(value => positionFilter === 'all' || value.status === positionFilter) ?? [];
  const totals = summary?.complete ? summary.totals : summary?.savedSnapshot?.totals;
  const dated = summary?.complete ? summary.asOf : summary?.savedSnapshot?.asOf;
  const identityFor = (wallet: string): Kol => { const item = wallets.wallets.find(value => value.address === wallet); return { address: wallet, name: item?.publicIdentity?.name || shortAddress(wallet), avatarUrl: item?.publicIdentity?.avatarUrl ?? null, twitter: null, source: 'journal', lastSeenAt: null }; };
  return <div className="page journal-page">
    <header className="journal-title"><div><span className="journal-private"><Shield size={12} />{t('Private to your account')}</span><h1>{t('Portfolio')}</h1></div><button type="button" className="journal-add" onClick={() => setAdding(!adding)} disabled={wallets.wallets.length >= wallets.limit}><Plus size={16} />{t('Add wallet')} <small>{wallets.wallets.length}/{wallets.limit}</small></button></header>
    {adding && <form className="journal-add-form" onSubmit={event => { event.preventDefault(); void mutate('/wallets', 'POST', { address: address.trim(), label: label.trim() }); }}><label>{t('BNB wallet address')}<input required pattern="0x[0-9a-fA-F]{40}" value={address} onChange={event => setAddress(event.target.value)} placeholder="0x…" /></label><label>{t('Private label')}<input value={label} maxLength={60} onChange={event => setLabel(event.target.value)} placeholder={t('Optional')} /></label><button className="journal-primary" disabled={busy}>{t('Track wallet')}</button></form>}
    {error && <div className="journal-error" role="alert">{t(error)} <button type="button" onClick={reload}>{t('Retry')}</button></div>}
    {!wallets.wallets.length ? <div className="journal-empty"><Wallet size={28} /><h2>{busy ? t('Loading wallets…') : t('Add your first wallet')}</h2><p>{t('Track any BNB wallet privately. Recent activity loads first; older purchase evidence is recovered when available.')}</p></div> : <>
      <div className="journal-toolbar"><label className="journal-selector"><span>{t('Portfolio')}</span><select value={selection} onChange={event => { setSelection(event.target.value); setSelected(null); }}><option value="all">{t('Combined portfolio')}</option>{wallets.wallets.map(value => <option key={value.address} value={value.address}>{value.label || value.publicIdentity?.name || shortAddress(value.address)}</option>)}</select></label><button type="button" onClick={reload} aria-label={t('Refresh portfolio')} disabled={busy}><RefreshCw size={16} /></button></div>
      <div className="journal-metrics" aria-busy={busy || summary?.preparing}>{([['Tracked token value', totals?.valueUsd], ['Invested', totals?.investedUsd], ['Sold', totals?.soldUsd], ['Realized P&L', totals?.realizedProfitUsd], ['Est. total profit', totals?.estimatedProfitUsd]] as const).map(([name, value]) => <div key={name}><span>{t(name)}</span><strong className={name.includes('profit') || name === 'Realized P&L' ? Number(value) > 0 ? 'positive' : Number(value) < 0 ? 'negative' : '' : ''}>{money(value, name.includes('profit') || name === 'Realized P&L')}</strong></div>)}<div><span>{t('Consolidated return')}</span><strong>{totals?.roi == null ? '—' : `${(Number(totals.roi) * 100).toLocaleString(getLocale(), { maximumFractionDigits: 2 })}%`}</strong></div></div>
      <p className="journal-coverage">{t('Profit uses available position history, not the activity window. Internal transfers preserve original costs and do not create profit.')}{dated && <> {t('Valuation as of {time}', { time: localDate(dated) })}</>}{!summary?.complete && summary?.savedSnapshot && <> · {t('Saved valid snapshot')}</>}{summary?.preparing && <> · {t('Preparing accounting…')}</>}</p>
      {!summary?.complete && <p className="journal-coverage" role="status">{t('Combined totals appear when all selected positions reconcile. Available positions are shown below.')}</p>}
      <section className="journal-positions"><div className="journal-section-title"><h2>{t('Positions')}</h2><div className="journal-filter">{(['all', 'open', 'closed'] as const).map(value => <button type="button" key={value} aria-pressed={value === positionFilter} onClick={() => setPositionFilter(value)}>{t(value === 'all' ? 'All' : value === 'open' ? 'Open' : 'Closed')}</button>)}</div></div>
        <div className="journal-position-list">{positions.map(position => <div className="journal-position" key={position.token.address}><div className="journal-token"><span className="journal-token-image">{position.token.logoUrl ? <img src={position.token.logoUrl} alt="" /> : (position.token.symbol || '?').slice(0, 1)}</span><span><strong>{position.token.symbol || shortAddress(position.token.address)}</strong><small>{position.token.name || shortAddress(position.token.address)} · {t(position.status === 'open' ? 'Open' : position.status === 'closed' ? 'Closed' : 'Unknown')}</small></span></div><dl><div><dt>{t('Value')}</dt><dd>{money(position.valueUsd)}</dd></div><div><dt>{t('Invested')}</dt><dd>{money(position.investedUsd)}</dd></div><div><dt>{t('Sold')}</dt><dd>{money(position.soldUsd)}</dd></div><div><dt>{t('Realized P&L')}</dt><dd>{money(position.realizedProfitUsd, true)}</dd></div><div><dt>{t('Est. total profit')}</dt><dd className={Number(position.estimatedProfitUsd) >= 0 ? 'positive' : 'negative'}>{money(position.estimatedProfitUsd, true)}</dd></div></dl><div className="journal-position-actions">{!position.complete && <small title={t(journalCoverageNotice(position.reasons))}>{t(journalCoverageNotice(position.reasons))}</small>}{position.wallets.map(wallet => <button key={wallet} type="button" onClick={() => setSelected({ wallet, position })}>{t('Trade details')} {position.wallets.length > 1 && shortAddress(wallet)}</button>)}</div></div>)}{!positions.length && <p className="journal-state">{summary?.preparing || busy ? t('Discovering recent positions…') : t('No eligible positions in this activity window')}</p>}</div>
      </section>
      <section><div className="journal-section-title"><h2>{t('Trade history')}</h2><span>{activity?.activityFrom ? t('Activity since {date}', { date: localDate(activity.activityFrom) }) : t('Recent trades first')}</span></div><div className="journal-trades">{activity?.trades.map(trade => <div className="journal-trade" key={`${trade.walletAddress}:${trade.id}`}><span className={trade.side === 'buy' ? 'positive' : 'negative'}>{t(trade.side === 'buy' ? 'Buy' : 'Sell')}</span><strong>{trade.tokenSymbol || shortAddress(trade.tokenAddress)}</strong><span className="journal-trade-wallet">{wallets.wallets.find(value => value.address === trade.walletAddress)?.label || shortAddress(trade.walletAddress)}</span><span>{trade.amountUsd == null ? `${compact(trade.quoteAmount)} ${trade.quoteSymbol || ''}` : money(trade.amountUsd)}</span><time dateTime={trade.timestamp}>{localDate(trade.timestamp)}</time></div>)}{!activity?.trades.length && <p className="journal-state">{t('No eligible trades yet')}</p>}</div>{activity?.cursor && <button className="journal-more" type="button" disabled={busy} onClick={() => void more()}>{t('Load more trades')}</button>}</section>
      <section className="journal-wallets"><h2>{t('Tracked wallets')}</h2>{selectedWallets.map(wallet => <WalletSettings key={wallet.address} wallet={wallet} busy={busy} changeLabel={label => void mutate(`/wallets/${wallet.address}`, 'PATCH', { label })} remove={() => void mutate(`/wallets/${wallet.address}`, 'DELETE')} older={() => void mutate(`/wallets/${wallet.address}/older`, 'POST', {})} />)}</section>
    </>}
    {selected && <TradeModalLoader key={`${user.id}:${selected.wallet}:${selected.position.token.address}`} journalAccountId={user.id} kol={identityFor(selected.wallet)} token={{ ...selected.position.token, priceUsd: null, marketCapUsd: null, change24h: null, kolCount24h: 0, buys24h: 0, sells24h: 0, volume24hUsd: null, lastTradeAt: null } as Token} kolIdentity={<strong>{identityFor(selected.wallet).name}</strong>} tokenIdentity={<strong>{selected.position.token.symbol || shortAddress(selected.position.token.address)}</strong>} tokenAddress={<span>{shortAddress(selected.position.token.address)}</span>} onClose={() => setSelected(null)} />}
  </div>;
}

function WalletSettings({ wallet, busy, changeLabel, remove, older }: { wallet: JournalWallet; busy: boolean; changeLabel(label: string): void; remove(): void; older(): void }) {
  const [value, setValue] = useState(wallet.label), [removing, setRemoving] = useState(false);
  useEffect(() => setValue(wallet.label), [wallet.label]);
  return <div className="journal-wallet-row"><Wallet size={19} /><div><input aria-label={t('Private label')} maxLength={60} value={value} onChange={event => setValue(event.target.value)} onBlur={() => { if (value.trim() !== wallet.label) changeLabel(value.trim()); }} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); }} disabled={busy} placeholder={shortAddress(wallet.address)} /><small>{wallet.address}</small><small>{t('Activity since {date}', { date: localDate(wallet.activityFrom) })} · {t(wallet.preparation.status === 'ready' ? 'Ready' : wallet.preparation.status === 'cooldown' ? 'Provider cooldown' : wallet.preparation.status === 'unavailable' ? 'History unavailable' : 'Preparing…')}</small></div><div className="journal-wallet-actions"><button type="button" disabled={busy || wallet.preparation.historyComplete} onClick={older}>{t('Load older history')}</button>{removing ? <><button type="button" disabled={busy} className="negative" onClick={remove}>{t('Remove wallet')}</button><button type="button" onClick={() => setRemoving(false)}>{t('Cancel')}</button></> : <button type="button" disabled={busy} onClick={() => setRemoving(true)} aria-label={t('Remove wallet')}><Trash2 size={15} /></button>}</div></div>;
}

export function CreatorProfilesPage() {
  const account = useAccount();
  return <CreatorProfilesContent key={account.state.user?.id ?? 'guest'} />;
}
function CreatorProfilesContent() {
  useLanguage(); const account = useAccount();
  const [profiles, setProfiles] = useState<{ walletAddress: string; displayName: string | null; avatarUrl: string | null }[]>([]);
  useEffect(() => { setProfiles([]); if (!account.state.user) return; const controller = new AbortController(); void fetch('/api/creator/profiles', { cache: 'no-store', signal: controller.signal, headers: { 'X-Watchlist-Owner': account.state.user.id } }).then(response => response.ok ? response.json() : Promise.reject()).then(value => setProfiles(value.profiles)).catch(() => {}); return () => controller.abort(); }, [account.state.user?.id]);
  return <div className="page journal-page"><h1>{t('My creator profiles')}</h1>{!profiles.length && <p className="journal-coverage">{t('Claim an existing KOL profile from its page using a wallet signature.')}</p>}{profiles.map(profile => <Link className="journal-wallet-row" to={`/kol/${profile.walletAddress}`} key={profile.walletAddress}>{profile.avatarUrl && <img width="40" height="40" src={profile.avatarUrl} alt="" />}<strong>{profile.displayName || shortAddress(profile.walletAddress)}</strong><span>{t('Edit profile')}</span></Link>)}</div>;
}
