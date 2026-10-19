import { useEffect, useState, type Ref } from 'react';
import type { KolTokenActivity } from '../shared/kolTokenTrades';
import type { NodeAccountingSummary } from '../shared/nodeAccounting';
import { requestNodePnlSummary } from './nodePnlSummaryRequest';
import { getLocale, t } from './i18n';
import { displayedTokenPnl, historicalAccountingMismatchNotice, terminalTokenInventoryFailure, tokenPnlMayRetainDuringProviderRetry, tokenPnlMovementsMatch, tokenPositionPnlDelayedNotice, tokenPositionPnlDescription, tokenPositionPnlLabel, tokenPositionPnlLoadingNotice, tokenPositionPnlPriceTime, tokenPositionPnlUnavailableNotice, type KolTokenPnlResult } from './kolTokenPnlRequest';

interface TokenPnlState { pair: string; activity: KolTokenActivity | null; busy: boolean; delayed?: boolean }

export function KolTokenRealizedPnl({ walletAddress, tokenAddress, lastTradeAt, eager = false, initialSummary }: {
  walletAddress: string; tokenAddress: string; lastTradeAt: string | null; eager?: boolean; initialSummary?: NodeAccountingSummary;
}) {
  return <NodeTokenSummary walletAddress={walletAddress} tokenAddress={tokenAddress} lastTradeAt={lastTradeAt} eager={eager} initialSummary={initialSummary} />;
}

function NodeTokenSummary({ walletAddress, tokenAddress, lastTradeAt, initialSummary }: {
  walletAddress: string; tokenAddress: string; lastTradeAt: string | null; eager?: boolean; initialSummary?: NodeAccountingSummary;
}) {
  const [summary, setSummary] = useState(initialSummary);
  useEffect(() => {
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      let delay = 20_000;
      try {
        const value = await requestNodePnlSummary(walletAddress, tokenAddress, controller.signal);
        if (!controller.signal.aborted) setSummary(value);
        if (value.status === 'pending') delay = Math.max(3000, value.retryAfterMs ?? 3000);
      } catch { delay = 5000; }
      if (!controller.signal.aborted) timer = setTimeout(() => void refresh(), delay);
    };
    setSummary(initialSummary);
    const recent = initialSummary?.snapshot && Date.now() - Date.parse(initialSummary.snapshot.asOf) < 20_000;
    timer = setTimeout(() => void refresh(), recent ? initialSummary?.status === 'pending' ? 3000 : 20_000 : 0);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [walletAddress, tokenAddress, lastTradeAt, initialSummary]);
  const raw = summary?.position === 'open' ? summary.estimatedProfitUsd : summary?.realizedProfitUsd;
  const value = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
  const valid = Number.isFinite(value);
  const contradictory = [summary?.reason, ...(summary?.snapshot?.reasons ?? [])].includes('historical_accounting_mismatch');
  const asOf = summary?.snapshot?.asOf;
  const retained = summary?.snapshot?.refreshStatus === 'pending';
  const title = valid ? `${t('Kollens accounting from recorded wallet movements, transfers and wallet-paid fees.')}${asOf ? ` ${t('As of')} ${new Date(asOf).toLocaleString(getLocale())}` : ''}`
    : t(nodeSummaryPendingDescription(summary));
  return <span className="token-card-profit" title={title} aria-busy={!valid && !contradictory && summary?.status !== 'unavailable'}>
    <span>{t(summary?.position === 'open' ? 'Est. profit' : summary?.position === 'closed' ? 'Realized P&L' : 'P&L')}{retained ? ` · ${t('Saved')}` : ''}</span>
    <strong className={valid ? value > 0 ? 'positive' : value < 0 ? 'negative' : '' : ''}>{valid ? new Intl.NumberFormat(getLocale(), {
      style: 'currency', currency: 'USD', notation: Math.abs(value) >= 1000 ? 'compact' : 'standard', maximumFractionDigits: 2, signDisplay: 'exceptZero',
    }).format(value) : contradictory ? t('Unverified') : summary?.status === 'unavailable' ? '—' : summary ? t('Pending') : '…'}</strong>
  </span>;
}

function nodeSummaryPendingDescription(summary: NodeAccountingSummary | undefined) {
  const reasons = [summary?.reason, ...(summary?.snapshot?.reasons ?? [])].filter(Boolean).join(' ');
  if (/historical_accounting_mismatch/.test(reasons)) return historicalAccountingMismatchNotice;
  if (/native_trace_required/.test(reasons)) return 'Waiting for the node to verify native BNB spent or received.';
  if (/collection_pending|indexing_lag|node_indexer_lag/.test(reasons)) return 'The indexer is catching up with confirmed wallet transactions.';
  if (/historical_baseline_required|historical_gap/.test(reasons)) return 'Older transaction history needs recovery before profit can be calculated.';
  if (/decimals|precision/.test(reasons)) return 'Token precision at the trade block is unavailable.';
  if (/quote|valuation/.test(reasons)) return 'Waiting for a fresh confirmed market price.';
  if (/unsupported|decoder/.test(reasons)) return 'Captured transactions need additional decoding before profit is available.';
  if (/cost|capital/.test(reasons)) return 'Purchase or incoming-transfer costs are unavailable for this position.';
  return 'Wallet transactions or market prices are still being processed.';
}

export function KolTokenRealizedPnlValue({ activity, busy, delayed = false, elementRef }: { activity: KolTokenActivity | null; busy: boolean; delayed?: boolean; elementRef?: Ref<HTMLSpanElement> }) {
  const amount = displayedTokenPnl(activity) ?? NaN;
  const valid = Number.isFinite(amount);
  const color = valid ? amount > 0 ? 'positive' : amount < 0 ? 'negative' : '' : '';
  const formatted = valid ? new Intl.NumberFormat(getLocale(), {
    style: 'currency', currency: 'USD', notation: Math.abs(amount) >= 1000 ? 'compact' : 'standard',
    maximumFractionDigits: 2, signDisplay: 'exceptZero',
  }).format(amount) : delayed ? t('Pending') : busy ? '…' : '—';
  const priceTime = tokenPositionPnlPriceTime(activity);
  const title = valid ? t(tokenPositionPnlDescription(activity)) + (priceTime ? ' ' + t('Price as of {time} UTC.', { time: priceTime }) : '')
    : delayed ? t(tokenPositionPnlDelayedNotice) : busy ? t(tokenPositionPnlLoadingNotice(activity)) : t(tokenPositionPnlUnavailableNotice(activity));

  return <span ref={elementRef} className="token-card-profit" title={title} aria-busy={busy}>
    <span>{t(tokenPositionPnlLabel(activity))}</span><strong className={color}>{formatted}</strong>
  </span>;
}

export function tokenPnlStateAfterLoad(current: TokenPnlState | null,
  pair: string, loaded: KolTokenPnlResult, completed = false): TokenPnlState {
  const delayed = loaded.status === 'pending' && (completed || current?.pair === pair && !!current.delayed);
  const busy = loaded.status === 'pending' && !delayed;
  if (terminalTokenInventoryFailure(loaded.activity)) return { pair, activity: loaded.activity, busy: false };
  // A fresh realized-only response also renews canonical proof. Keeping the
  // older object here would let its proof expire during a prolonged quote
  // outage even though the server keeps returning verified historical gains.
  if (displayedTokenPnl(loaded.activity) !== null) return { pair, activity: loaded.activity, busy, delayed };
  const changedTrade = loaded.activity && current?.activity && Date.parse(loaded.activity.summary.lastTradeAt ?? '') !== Date.parse(current.activity.summary.lastTradeAt ?? '');
  const unchangedMovements = !loaded.activity || current?.activity && (tokenPnlMovementsMatch(current.activity, loaded.activity)
    || tokenPnlMayRetainDuringProviderRetry(current.activity, loaded.activity));
  const retained = loaded.status === 'pending' && !changedTrade && unchangedMovements && current?.pair === pair
    && displayedTokenPnl(current.activity) !== null ? current.activity : null;
  return { pair, activity: loaded.status === 'pending' ? retained ?? loaded.activity : loaded.activity, busy, delayed };
}
