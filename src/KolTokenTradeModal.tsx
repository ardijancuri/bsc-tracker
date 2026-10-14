import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { ArrowLeft, ChevronLeft, ChevronRight, ExternalLink, RefreshCw, Share2, X } from 'lucide-react';
import { candleIntervals, defaultCandleInterval, type CandleInterval } from '../shared/intelligence';
import type { KolTokenActivity, KolTokenTrade } from '../shared/kolTokenTrades';
import type { Kol, Token } from './types';
import { FollowButton, usePositions } from './Intelligence';
import { getLocale, localDate, t, useLanguage } from './i18n';
import { compact, shortAddress } from './lib';
import { TokenPriceChart } from './TokenPriceChart';
import { useTokenChart } from './useTokenChart';
import { tokenChartIntent } from './tokenChartIntent';
import TradeReplayShare, { prepareTradeReplayData } from './TradeReplayShare';
import type { TradeReplayData } from './tradeReplayData';
import { kolTokenPnlKey, requestKolTokenPnl, tokenPositionPnlDescription, tokenPositionPnlLabel, tokenPositionPnlLoadingNotice, tokenPositionPnlPriceTime, tokenPositionPnlUnavailableNotice, verifiedTokenPositionPnl } from './kolTokenPnlRequest';
import { tokenPnlStateAfterLoad } from './KolTokenRealizedPnl';
import './tokenMarket.css';
import './kolTokenTradeModal.css';

function money(value: string | null | undefined, signed = false) {
  if (value == null || !Number.isFinite(Number(value))) return '—';
  return new Intl.NumberFormat(getLocale(), { style: 'currency', currency: 'USD', maximumFractionDigits: 2, signDisplay: signed ? 'exceptZero' : 'auto' }).format(Number(value));
}

export default function KolTokenTradeModal({ kol, token, kolIdentity, tokenIdentity, tokenAddress, onClose }: {
  kol: Kol; token: Token; kolIdentity: ReactNode; tokenIdentity: ReactNode; tokenAddress: ReactNode; onClose: () => void;
}) {
  useLanguage();
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const shareTrigger = useRef<HTMLButtonElement>(null);
  const [shareSnapshot, setShareSnapshot] = useState<TradeReplayData | null>(null);
  const [activity, setActivity] = useState<KolTokenActivity | null>(null);
  const [error, setError] = useState(false);
  const [activityBusy, setActivityBusy] = useState(true);
  const [refresh, setRefresh] = useState(0);
  const [interval, setInterval] = useState<CandleInterval>(defaultCandleInterval);
  const [side, setSide] = useState<'all' | 'buy' | 'sell'>('all');
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(6);
  const transactionList = useRef<HTMLDivElement>(null);
  const fittedPageSize = useRef(6);
  const positions = usePositions('kol', kol.address, [token.address]);
  const { chart } = useTokenChart(token.address, interval, !shareSnapshot);
  const replay = useMemo(() => activity ? prepareTradeReplayData(activity, chart, positions.get(token.address)) : null, [activity, chart, positions, token.address]);
  const retry = useCallback(() => { setError(false); setRefresh(value => value + 1); }, []);
  const backToTrades = useCallback(() => {
    setShareSnapshot(null);
    requestAnimationFrame(() => shareTrigger.current?.focus());
  }, []);

  useEffect(() => {
    const element = dialog.current;
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const resumeBackgroundPnl = requestKolTokenPnl.suspendBackground();
    element?.showModal();
    return () => { resumeBackgroundPnl(); element?.close(); document.body.style.overflow = overflow; if (previous?.isConnected) previous.focus(); };
  }, []);

  useEffect(() => {
    // The share view prepares its own frozen accounting and chart snapshot.
    // Keep this hidden details refresh from competing for the same provider budget.
    if (shareSnapshot) return;
    const controller = new AbortController();
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const pair = kolTokenPnlKey({ walletAddress: kol.address, tokenAddress: token.address, lastTradeAt: null });
    setActivity(current => current?.kol.address.toLowerCase() === kol.address.toLowerCase()
      && current.token.address.toLowerCase() === token.address.toLowerCase() ? current : null);
    const load = async () => {
      setActivityBusy(true);
      try {
        // Resumed modals can carry the token's global last trade from another
        // wallet. Only the exact-pair activity response dates this selection.
        const result = await requestKolTokenPnl({ walletAddress: kol.address, tokenAddress: token.address, lastTradeAt: null }, controller.signal,
          { priority: 'foreground', onActivity: value => { if (active) {
            const status = verifiedTokenPositionPnl(value) !== null ? 'ready'
              : value.realizedAccounting?.status === 'pending' || value.inventory?.coverage?.status === 'pending'
                || value.realizedAccounting?.position?.status === 'open' && value.realizedAccounting.status === 'ready' ? 'pending' : 'unavailable';
            setActivity(current => tokenPnlStateAfterLoad({ pair, activity: current, busy: true }, pair, { activity: value, status }).activity);
            setError(false);
          } } });
        if (!active) return;
        setActivityBusy(result.status === 'pending');
        if (result.activity) {
          setActivity(current => tokenPnlStateAfterLoad({ pair, activity: current, busy: true }, pair, result).activity);
          setError(false);
        }
        else if (result.status === 'unavailable') { setActivity(null); setError(true); }
        timer = setTimeout(() => void load(), result.status === 'pending' ? Math.max(3000, result.retryAfterMs ?? 3000) : 60_000);
      } catch { if (active) { setActivityBusy(false); setError(true); } }
    };
    void load();
    return () => { active = false; controller.abort(); if (timer) clearTimeout(timer); };
  }, [kol.address, token.address, refresh, Boolean(shareSnapshot)]);

  const trades = useMemo(() => (activity?.trades ?? []).filter(trade => side === 'all' || trade.side === side), [activity, side]);
  const pageCount = Math.max(1, Math.ceil(trades.length / pageSize));
  const currentPage = Math.min(page, pageCount - 1);
  const summary = activity?.summary;
  const profit = verifiedTokenPositionPnl(activity);
  const priceTime = tokenPositionPnlPriceTime(activity);
  const profitDescription = t(tokenPositionPnlDescription(activity)) + (priceTime ? ' ' + t('Price as of {time} UTC.', { time: priceTime }) : '');
  const profitClass = profit === null ? '' : profit > 0 ? 'positive' : profit < 0 ? 'negative' : '';

  useEffect(() => {
    const element = transactionList.current;
    if (!element) return;
    const observer = new ResizeObserver(entries => {
      const height = entries[0]?.contentRect.height ?? 0;
      // Sharing keeps the trades mounted but hidden; retain its fitted page size.
      if (height <= 0) return;
      const next = Math.max(1, Math.min(6, Math.floor(height / 44)));
      const previous = fittedPageSize.current;
      if (next !== previous) {
        fittedPageSize.current = next;
        setPage(value => Math.floor(value * previous / next));
        setPageSize(next);
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [error, Boolean(activity), trades.length > 0]);

  return createPortal(<dialog ref={dialog} className="kol-trade-modal" aria-labelledby={titleId} onCancel={event => { event.preventDefault(); if (shareSnapshot) backToTrades(); else onClose(); }} onClick={event => { if (event.target === event.currentTarget) { const bounds = event.currentTarget.getBoundingClientRect(); if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) onClose(); } }}>
    <header className="kol-trade-modal-header">
      <div className="kol-trade-modal-title" id={titleId}>{shareSnapshot && <button type="button" className="kol-trade-back" onClick={backToTrades}><ArrowLeft size={16} /> {t('Back')}</button>}{kolIdentity}</div>
      <div className="kol-trade-modal-actions">{!shareSnapshot && <button ref={shareTrigger} className="trade-replay-trigger" type="button" disabled={!replay?.trades.length} onClick={() => { if (replay) setShareSnapshot(replay); }}><Share2 size={15} /> {t('Share trade')}</button>}<button type="button" className="kol-trade-close" onClick={onClose} aria-label={t('Close trade details')} autoFocus><X size={19} /></button></div>
    </header>
    {shareSnapshot && <TradeReplayShare data={shareSnapshot} />}
    <div className="kol-trade-modal-body" hidden={Boolean(shareSnapshot)}>
      <section className="kol-trade-market" aria-label={t('Token chart and trades')}>
        <div className="kol-trade-token-header"><div className="kol-trade-token-identity">{tokenIdentity}</div><div className="kol-trade-contract">{tokenAddress}<FollowButton kind="token" address={token.address} label={token.symbol} /><Link to={`/token/${token.address}`} {...tokenChartIntent(token.address)} onClick={onClose} aria-label={t('Open token page')} title={t('Open token page')}><ExternalLink size={13} /></Link><div className="kol-trade-current-cap" title={t('Market cap')}><span>{t('MCAP')}</span><strong>{compact(activity?.token.marketCapUsd ?? token.marketCapUsd, true)}</strong></div></div></div>
        <div className="kol-trade-chart-toolbar"><div className="kol-trade-marker-key"><span className="positive">B {summary?.buyCount ?? '—'}</span><span className="negative">S {summary?.sellCount ?? '—'}</span><span>{t('KOL trades')}</span></div><div className="candle-interval-tabs" aria-label={t('Chart interval')}>{candleIntervals.map(value => <button type="button" key={value} aria-pressed={interval === value} {...tokenChartIntent(token.address, value)} onClick={() => setInterval(value)}>{value}</button>)}</div></div>
        <TokenPriceChart address={token.address} interval={interval} trades={activity?.trades} focusTrades />
      </section>
      <aside className="kol-trade-details" aria-label={t('Trade details')}>
        <div className="kol-trade-profit" aria-busy={activityBusy} title={profitDescription}><span>{t(tokenPositionPnlLabel(activity))}</span><strong className={profitClass}>{profit === null && activityBusy ? '…' : money(profit === null ? null : String(profit), true)}</strong></div>
        <p className="kol-trade-coverage">{profitDescription}</p>
        <dl className="kol-trade-summary"><div title={t('Indexed buy amount. GMGN realized P&L also includes transfer gains and fees.')}><dt>{t('Invested')}</dt><dd>{money(summary?.investedUsd)}</dd></div><div title={t('Indexed sell amount. Transfer-out values are included in GMGN realized P&L.')}><dt>{t('Sold')}</dt><dd>{money(summary?.soldUsd)}</dd></div><div title={t('Quantity-weighted average using current verified token supply')}><dt>{t('Avg buy MCAP')}</dt><dd>{compact(summary?.avgBoughtMcapUsd, true)}</dd></div><div title={t('Quantity-weighted average using current verified token supply')}><dt>{t('Avg sell MCAP')}</dt><dd>{compact(summary?.avgSoldMcapUsd, true)}</dd></div></dl>
        {activity && !activity.coverage.complete && <p className="kol-trade-coverage" role="status">{t('Showing the latest {count} of {total} indexed trades. Complete totals are unavailable.', { count: activity.coverage.returnedTradeCount, total: activity.coverage.indexedTradeCount })}</p>}
        {activity && activityBusy && profit === null && <p className="kol-trade-coverage" role="status">{t(tokenPositionPnlLoadingNotice(activity))}</p>}
        {activity && !activityBusy && profit === null && <p className="kol-trade-coverage">{t(tokenPositionPnlUnavailableNotice(activity))}</p>}
        <div className="kol-trade-transactions-heading"><h2>{t('Transactions')} <span>({activity?.coverage.indexedTradeCount ?? '—'}) · UTC</span></h2><button type="button" onClick={retry} title={t('Refresh trades')} aria-label={t('Refresh trades')}><RefreshCw size={14} /></button></div>
        <div className="kol-trade-filters" aria-label={t('Filter transactions')}>{(['all', 'buy', 'sell'] as const).map(value => <button type="button" key={value} aria-pressed={side === value} onClick={() => { setSide(value); setPage(0); }}>{t(value === 'all' ? 'All' : value === 'buy' ? 'Buys' : 'Sells')}</button>)}</div>
        {error ? <div className="kol-trade-state" role="alert">{t('Trade history unavailable')}<button type="button" onClick={retry}>{t('Try again')}</button></div> : !activity ? <div className="kol-trade-state" role="status">{t('Loading trade history…')}</div> : !trades.length ? <div className="kol-trade-state">{t('No indexed trades for this selection')}</div> : <>
          <div ref={transactionList} className="kol-trade-transactions">{trades.slice(currentPage * pageSize, currentPage * pageSize + pageSize).map(trade => <TradeReceipt key={trade.id} trade={trade} />)}</div>
          <nav className="kol-trade-pagination" aria-label={t('Transaction pagination')}><button type="button" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)} aria-label={t('Previous trades')}><ChevronLeft size={15} /></button><span aria-live="polite">{t('{page} of {pages}', { page: currentPage + 1, pages: pageCount })}</span><button type="button" disabled={currentPage + 1 >= pageCount} onClick={() => setPage(currentPage + 1)} aria-label={t('Next trades')}><ChevronRight size={15} /></button></nav>
        </>}
      </aside>
    </div>
  </dialog>, document.body);
}

function TradeReceipt({ trade }: { trade: KolTokenTrade }) {
  const amount = trade.valuationStatus === 'valued' ? trade.amountUsd : null;
  const valuationNote = trade.valuationStatus === 'shared_quote' ? t('Transaction spend could not be allocated to this token') : amount == null ? t('Trade valuation unavailable') : undefined;
  return <div className="kol-trade-receipt">
    <span className={`kol-trade-side ${trade.side}`}>{t(trade.side)}</span><span className="kol-trade-receipt-values"><strong title={valuationNote}>{money(amount)}</strong><span>{t('at {value} MCAP', { value: compact(trade.marketCapUsd, true) })}</span></span><span className="kol-trade-receipt-time"><time dateTime={trade.timestamp} title={localDate(trade.timestamp)}>{new Date(trade.timestamp).toLocaleString(getLocale(), { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' })}</time><span>{shortAddress(trade.txHash)}</span></span>
  </div>;
}
