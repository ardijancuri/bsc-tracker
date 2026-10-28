import { useEffect, useState, type Ref } from 'react';
import type { KolTokenActivity } from '../shared/kolTokenTrades';
import type { NodeAccountingSummary } from '../shared/nodeAccounting';
import { requestNodePnlSummary, nodeSummaryDisplay, validNodeSummaryIdentity } from './nodePnlSummaryRequest';
import { getLocale, t } from './i18n';
import { capturedPositionDescription, isCapturedPosition } from './nodeAccountingScope';
import{validNodeCostEstimate,nodeCostEstimateNote}from'../shared/nodeCostEstimate';
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
  const [, refreshClock] = useState(0);
  useEffect(() => {
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      let delay = 20_000;
      try {
        const value = await requestNodePnlSummary(walletAddress, tokenAddress, controller.signal);
        if (!controller.signal.aborted) setSummary(value);
        delay = nodeSummaryRefreshDelay(value);
      } catch { delay = 5000; }
      if (!controller.signal.aborted) timer = setTimeout(() => void refresh(), delay);
    };
    setSummary(initialSummary);
    const recent = validNodeSummaryIdentity(initialSummary, walletAddress, tokenAddress)
      && (initialSummary?.tracking?.source === 'fresh' && initialSummary.position === 'closed' && initialSummary.realizedStatus === 'ready'
        || initialSummary?.snapshot && Date.now() - Date.parse(initialSummary.snapshot.asOf) < 20_000);
    timer = setTimeout(() => void refresh(), recent ? nodeSummaryRefreshDelay(initialSummary) : 0);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [walletAddress, tokenAddress, lastTradeAt, initialSummary]);
  const fresh = summary?.tracking?.source === 'fresh';
  const display = nodeSummaryDisplay(summary, walletAddress, tokenAddress, Date.now(), { realizedOnly: fresh }), value = display.value ?? NaN, valid = display.value !== null;
  useEffect(() => {
    if (display.kind !== 'estimated'||validNodeCostEstimate(summary?.snapshot)) return;
    const fresh = summary?.tracking?.source === 'fresh', at = Date.parse((fresh ? summary?.quotedAt : summary?.snapshot?.asOf) ?? '');
    if (!Number.isFinite(at)) return;
    // Expire only the rendered market mark. A stalled refresh must not leave an
    // old estimate painted indefinitely or start another provider request.
    const timer = setTimeout(() => refreshClock(value => value + 1), Math.max(1, at + (fresh ? 120_001 : 180_001) - Date.now()));
    return () => clearTimeout(timer);
  }, [summary, display.kind]);
  const contradictory = [summary?.reason, ...(summary?.snapshot?.reasons ?? [])].includes('historical_accounting_mismatch');
  const asOf = summary?.snapshot?.asOf;
  const retained = summary?.snapshot?.refreshStatus === 'pending';
  const title = valid ? `${validNodeCostEstimate(summary?.snapshot)?t(nodeCostEstimateNote):capturedPositionDescription(summary?.snapshot) ?? t('Kollens accounting from recorded wallet movements, transfers and wallet-paid fees.')}${asOf ? ` ${t('As of')} ${new Date(asOf).toLocaleString(getLocale())}` : ''}`
    : t(nodeSummaryPendingDescription(summary));
  const tracked = isCapturedPosition(summary?.snapshot);
  const unavailable = nodeSummaryUnavailableLabel(summary);
  return <span className="token-card-profit" title={title} aria-busy={!valid && !contradictory && unavailable === 'Pending'}>
    <span>{t(validNodeCostEstimate(summary?.snapshot)?'Estimated realized P&L':fresh || display.kind === 'realized' ? tracked ? 'Tracked realized P&L' : 'Realized P&L' : summary?.position === 'open' ? tracked ? 'Tracked est. profit' : 'Est. profit' : summary?.position === 'closed' ? tracked ? 'Tracked realized P&L' : 'Realized P&L' : 'P&L')}{retained ? ` · ${t('Saved')}` : ''}</span>
    <strong className={valid ? value > 0 ? 'positive' : value < 0 ? 'negative' : '' : ''}>{valid ? new Intl.NumberFormat(getLocale(), {
      style: 'currency', currency: 'USD', notation: Math.abs(value) >= 1000 ? 'compact' : 'standard', maximumFractionDigits: 2, signDisplay: 'exceptZero',
    }).format(value) : contradictory ? t('Unverified') : summary ? t(unavailable) : '…'}</strong>
  </span>;
}

export function nodeSummaryRefreshDelay(summary: NodeAccountingSummary | undefined) {
  if (summary?.tracking?.source === 'fresh' && summary.position === 'closed' && summary.realizedStatus === 'ready') return 60_000;
  return summary?.status === 'pending' || summary?.snapshot?.refreshStatus === 'pending'
    ? Math.max(3000, Math.min(30_000, summary.retryAfterMs ?? 3000)) : 20_000;
}

export function nodeSummaryUnavailableLabel(summary: NodeAccountingSummary | undefined) {
  const reasons = [summary?.reason, ...(summary?.snapshot?.reasons ?? [])].filter(Boolean).join(' ');
  if (/unknown_cost|unknown_purchase|unknown_incoming/.test(reasons)) return 'Cost unknown';
  if (/unknown_fee/.test(reasons)) return 'Fee unknown';
  if (/balance_mismatch/.test(reasons)) return 'Balance mismatch';
  if (/wallet_decode_gap|historical_gap|historical_baseline_required/.test(reasons)) return 'History incomplete';
  if (/decoding_pending|native_trace_required/.test(reasons)) return 'Evidence needed';
  return summary?.realizedStatus === 'unavailable' || summary?.status === 'unavailable' ? '—' : 'Pending';
}

function nodeSummaryPendingDescription(summary: NodeAccountingSummary | undefined) {
  const reasons = [summary?.reason, ...(summary?.snapshot?.reasons ?? [])].filter(Boolean).join(' ');
  if (/historical_accounting_mismatch/.test(reasons)) return historicalAccountingMismatchNotice;
  if (/wallet_decode_gap/.test(reasons)) return 'Recorded wallet history has a coverage gap. Unknown amounts are not counted as zero.';
  if (/unknown_fee/.test(reasons)) return 'The wallet-paid fee for this position has not been verified.';
  if (/balance_mismatch/.test(reasons)) return 'Recorded token movements do not match the confirmed wallet balance.';
  if (/balance_pending/.test(reasons)) return 'Waiting for a confirmed wallet balance check.';
  if (/decoding_pending/.test(reasons)) return 'A captured transaction still needs execution evidence before this position can be verified.';
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
