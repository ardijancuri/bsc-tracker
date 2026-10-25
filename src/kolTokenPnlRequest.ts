import { tradeActivityBase, tradeRequestHeaders, type TradeRequestContext } from './tradeRequestContext';
import { journalTokenProfit } from './journalReplay';
import { canUseGmgnHistoryFallback, kolTokenPositionQuoteMaxAgeMs, type KolTokenActivity } from '../shared/kolTokenTrades';
import { t } from './i18n';
import { capturedPositionDescription, isCapturedPosition } from './nodeAccountingScope';

export interface KolTokenPnlSelection { walletAddress: string; tokenAddress: string; lastTradeAt: string | null; requestContext?: TradeRequestContext }
export interface KolTokenPnlResult { activity: KolTokenActivity | null; status: 'ready' | 'pending' | 'unavailable'; retryAfterMs?: number }
const address = /^0x[0-9a-f]{40}$/i;
const requestBudgetMs = 20_000;
const profileAttemptBudgetMs = 4000;
const recentResultMs = 5000;
const providerHistoryMaxAgeMs = 30_000;
const decimal = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;
export const gmgnRealizedPnlNote = 'GMGN realized P&L includes marked transfer-out gains and fees.';
export const gmgnHistoryPnlNote = 'Estimated from GMGN history; current wallet balance checked. Historical movements are not chain-verified.';
export const gmgnReportedPnlNote = 'GMGN reported profit; current wallet balance checked.';
export const trackedPnlNote = 'Estimate from verified tracked trades; gas fees and earlier untracked trades are excluded.';
export const historicalAccountingMismatchNotice = 'Historical accounting totals conflict. Profit cannot be verified.';
function isNodeAccounting(activity: KolTokenActivity | null) {
  const accounting = activity?.realizedAccounting;
  return accounting?.version === 2 && ['node', 'mixed', 'imported'].includes(accounting.source) && accounting.policy === 'kollens_fifo_v1';
}
function isFreshNodeAccounting(activity: KolTokenActivity | null) {
  return isNodeAccounting(activity) && activity?.tracking?.version === 1 && activity.tracking.source === 'fresh';
}
function nodePnlDescription(activity: KolTokenActivity) {
  const identity = activity.accountingSnapshot;
  const scope = capturedPositionDescription(identity);
  if (identity?.refreshStatus === 'pending' && Number.isFinite(Date.parse(identity.asOf))) return [t('Saved profit as of {time} UTC. Updating data…', { time: new Date(identity.asOf).toISOString().replace('T', ' ').slice(0, 19) }), scope].filter(Boolean).join(' ');
  if (scope) return scope;
  return identity?.source === 'mixed' ? 'Node accounting with imported older history. Includes transfers and wallet-paid fees.'
    : identity?.source === 'imported' ? 'Imported historical accounting continued from a verified wallet checkpoint.'
      : 'Calculated from captured node transactions, transfers and wallet-paid fees.';
}
export function gmgnRealizedPnlDescription(activity: KolTokenActivity | null) {
  if (!activity) return 'Kollens accounting from recorded wallet movements, transfers and wallet-paid fees.';
  if (isNodeAccounting(activity)) return nodePnlDescription(activity!);
  if (isTrackedAccounting(activity)) return trackedPnlNote;
  if (isGmgnReportedAggregate(activity)) return gmgnReportedPnlNote;
  if (isGmgnHistoryFallback(activity)) return gmgnHistoryPnlNote;
  return gmgnRealizedPnlNote + (activity?.realizedAccounting?.status === 'ready'
    && activity.realizedAccounting.coverage?.reason === 'gmgn_activity_estimate'
    ? ' Estimated from matched GMGN activity; a reported position total is unavailable.' : '');
}

export function tokenPositionPnlLabel(activity: KolTokenActivity | null) {
  const estimated = tokenPositionIsOpen(activity)
    && (activity?.realizedAccounting?.position?.status === 'open' && verifiedTokenPositionPnl(activity) !== null
      || verifiedTokenRealizedPnl(activity) === null || openPositionWithoutRealizedProceeds(activity));
  if (isTrackedAccounting(activity) || isCapturedPosition(activity?.accountingSnapshot)) return estimated ? 'Tracked est. profit' : 'Tracked realized P&L';
  return estimated ? 'Est. profit' : isGmgnHistoryFallback(activity) && !isGmgnReportedAggregate(activity) ? 'Est. realized P&L' : 'Realized P&L';
}
export function tokenPositionPnlDescription(activity: KolTokenActivity | null) {
  if (isNodeAccounting(activity)) return nodePnlDescription(activity!);
  if (isTrackedAccounting(activity)) return trackedPnlNote;
  if (isGmgnReportedAggregate(activity)) return gmgnReportedPnlNote;
  if (isGmgnHistoryFallback(activity)) return gmgnHistoryPnlNote;
  return tokenPositionPnlLabel(activity) === 'Est. profit'
    ? 'Estimated total profit includes realized gains, the current value of remaining tokens, marked transfer-out gains and fees.'
    : gmgnRealizedPnlDescription(activity);
}
export function tokenPositionPnlLoadingNotice(activity: KolTokenActivity | null) {
  if (!activity || isNodeAccounting(activity)) return tokenPositionIsOpen(activity) ? 'Updating estimated profit…' : 'Preparing realized P&L…';
  return tokenPositionIsOpen(activity) ? 'Updating estimated profit…' : 'Loading GMGN realized P&L…';
}
export const tokenPositionPnlDelayedNotice = 'Profit data is taking longer to verify. Retrying automatically.';

export function tokenPnlRefreshDelay(result: KolTokenPnlResult, consecutivePending: number) {
  if (isNodeAccounting(result.activity)) return result.activity?.accountingSnapshot?.refreshStatus === 'pending' || result.status === 'pending'
    || isFreshNodeAccounting(result.activity) && tokenPnlNeedsRetry(result.activity!)
    ? Math.max(1500, Math.min(30_000, result.retryAfterMs ?? 2000)) : 20_000;
  if (result.status !== 'pending') {
    if (result.status === 'ready' && result.activity?.realizedAccounting?.source === 'onchain') {
      const accounting = result.activity.realizedAccounting;
      const retries = [accounting.retryAfterMs, accounting.position?.retryAfterMs, result.retryAfterMs]
        .filter((value): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0);
      // Keep the tracked amount usable while waiting to upgrade to GMGN. A
      // provider cooldown takes precedence over the normal proof refresh; the
      // separate expiry timer still removes evidence when it becomes stale.
      if (retries.length) return Math.max(1000, Math.min(300_000, Math.max(...retries)));
    }
    if (result.status === 'ready' && usesProviderHistory(result.activity)) {
      const deadline = tokenPnlExpiresAt(result.activity);
      return Math.max(1000, Math.min(20_000, deadline === null ? 1000 : deadline - Date.now() - 5000));
    }
    return 60_000;
  }
  const backoff = Math.min(30_000, 3000 * 2 ** Math.min(4, Math.max(0, consecutivePending - 1)));
  return Math.max(backoff, Number.isFinite(result.retryAfterMs) ? result.retryAfterMs! : 0);
}

/** Observed buys can identify which detail the user is waiting for, but cannot
 * supply a profit amount or override the verified accounting position. */
function tokenPositionIsOpen(activity: KolTokenActivity | null) {
  const position = activity?.realizedAccounting?.position;
  if (position) return position.status === 'open';
  return activity?.summary?.status === 'open'
    || !!activity && activity.summary.buyCount > 0 && activity.summary.sellCount === 0;
}
export function tokenPositionPnlPriceTime(activity: KolTokenActivity | null) {
  const position = activity?.realizedAccounting?.position;
  return position?.status === 'open' && position.pricedAt && verifiedTokenPositionPnl(activity) !== null
    ? new Date(position.pricedAt).toISOString().slice(11, 19) : null;
}

/** Open positions require a dated market mark. The historical realized total is
 * still available separately, but must never be mislabeled as current profit. */
export function verifiedTokenPositionPnl(activity: KolTokenActivity | null, now = Date.now()) {
  const accounting = verifiedTokenAccounting(activity, now);
  if (!accounting) return null;
  if (isNodeAccounting(activity)) {
    if (isFreshNodeAccounting(activity) && accounting.position?.status === 'open') {
      const quotedAt = Date.parse(accounting.position.pricedAt ?? '');
      const price = accounting.position.priceUsd;
      if (activity?.accountingSnapshot?.complete !== true || !Number.isFinite(quotedAt) || quotedAt > now + 1000 || now - quotedAt > 120_000
        || typeof price !== 'string' || !decimal.test(price) || !Number.isFinite(Number(price)) || Number(price) <= 0) return null;
    }
    const raw = accounting.position?.status === 'open' ? accounting.position.estimatedProfitUsd : accounting.realizedProfitUsd;
    return typeof raw === 'string' && decimal.test(raw) && Number.isFinite(Number(raw)) ? Number(raw) : null;
  }
  const realized = verifiedTokenRealizedPnl(activity, now), position = accounting.position;
  if (!position) return realized;
  const proofBalance = Number(usesProviderHistory(activity)
    ? accounting.coverage.balanceProof!.balance : activity!.inventory!.coverage.balance);
  const remaining = typeof position.remainingTokenAmount === 'string' && decimal.test(position.remainingTokenAmount.trim())
    ? Number(position.remainingTokenAmount) : NaN;
  if (position.status === 'closed') return remaining === 0 && proofBalance === 0 ? realized : null;
  const price = typeof position.priceUsd === 'string' && decimal.test(position.priceUsd.trim()) ? Number(position.priceUsd) : NaN;
  const pricedAt = typeof position.pricedAt === 'string' ? Date.parse(position.pricedAt) : NaN;
  const value = typeof position.estimatedProfitUsd === 'string' && decimal.test(position.estimatedProfitUsd.trim())
    ? Number(position.estimatedProfitUsd) : NaN;
  if (position.status !== 'open' || !['gmgn', 'market'].includes(position.valuationSource ?? '')
    || !Number.isFinite(remaining) || remaining <= 0 || proofBalance <= 0 || Math.abs(remaining - proofBalance) > proofBalance * 1e-10
    || !Number.isFinite(price) || price <= 0 || !Number.isFinite(pricedAt) || pricedAt > now + 1000
    || now - pricedAt > kolTokenPositionQuoteMaxAgeMs || !Number.isFinite(value)) return null;
  if (usesProviderHistory(activity)
    && pricedAt < Date.parse(accounting.coverage.lastMovementAt!)) return null;
  const positiveNumber = (raw: unknown) => typeof raw === 'string' && decimal.test(raw.trim()) && Number.isFinite(Number(raw)) && Number(raw) >= 0 ? Number(raw) : null;
  const basis = positiveNumber(position.remainingCostBasisUsd), cost = positiveNumber(position.feeInclusiveCostUsd), flow = position.cashFlow;
  const invested = positiveNumber(flow?.investedUsd), sold = positiveNumber(flow?.soldUsd), outgoing = positiveNumber(flow?.transferOutIncomeUsd), fees = positiveNumber(flow?.feesUsd);
  const expected = realized !== null && basis !== null ? realized + remaining * price - basis
    : invested !== null && sold !== null && outgoing !== null && fees !== null && cost !== null && cost + 1e-8 >= invested + fees
      ? sold + outgoing + remaining * price - cost : null;
  if (expected === null || !Number.isFinite(expected) || Math.abs(value - expected) > Math.max(1e-6, Math.abs(expected) * 1e-8)) return null;
  return value;
}

/** A current quote can be temporarily unavailable without invalidating verified
 * historical gains. Keep that realized value visible under its own label while
 * the loader continues to update the open-position estimate. */
export function displayedTokenPnl(activity: KolTokenActivity | null, now = Date.now()) {
  return verifiedTokenPositionPnl(activity, now)
    ?? (activity?.realizedAccounting?.position?.status === 'open' && !openPositionWithoutRealizedProceeds(activity, now)
      ? verifiedTokenRealizedPnl(activity, now) : null);
}

/** A delayed provider retry must not leave an old rendered amount on screen
 * beyond its original proof or quote lifetime. This deadline triggers only a
 * render, never a fresh verification or network request. */
export function tokenPnlExpiresAt(activity: KolTokenActivity | null, now = Date.now()) {
  if (displayedTokenPnl(activity, now) === null) return null;
  if (isNodeAccounting(activity)) {
    if (isFreshNodeAccounting(activity)) {
      const position = activity!.realizedAccounting?.position;
      return position?.status === 'open' && verifiedTokenPositionPnl(activity, now) !== null
        ? Date.parse(position.pricedAt!) + 120_001 : null;
    }
    if (activity?.accountingSnapshot?.refreshStatus === 'pending') return null;
    return Date.parse(activity!.accountingSnapshot!.asOf) + 180_001;
  }
  const accounting = activity!.realizedAccounting!, coverage = accounting.coverage;
  const deadlines = usesProviderHistory(activity)
    ? [Date.parse(accounting.checkedAt) + providerHistoryMaxAgeMs + 1,
      Date.parse(coverage.historyCheckedAt!) + providerHistoryMaxAgeMs + 1,
      Date.parse(coverage.balanceProof!.checkedAt) + 180_001, Date.parse(coverage.balanceProof!.blockTimestamp) + 180_001,
      ...(activity!.inventory!.coverage.complete ? [Date.parse(activity!.inventory!.coverage.checkedAt!) + 180_001] : [])]
    : [Date.parse(activity!.inventory!.coverage.checkedAt!) + 180_001];
  if (accounting.source === 'onchain') deadlines.push(Date.parse(accounting.checkedAt) + 180_001);
  if (accounting.position?.status === 'open' && verifiedTokenPositionPnl(activity, now) !== null) {
    deadlines.push(Date.parse(accounting.position.pricedAt!) + kolTokenPositionQuoteMaxAgeMs + 1);
  }
  return Math.min(...deadlines);
}

/** Before the first disposal, a realized zero is not useful as a replacement
 * for the open position's missing market mark. Keep waiting for its estimate;
 * preserve all nonzero gains/losses and actual sell or transfer-out proceeds. */
function openPositionWithoutRealizedProceeds(activity: KolTokenActivity | null, now = Date.now()) {
  const position = activity?.realizedAccounting?.position, flow = position?.cashFlow;
  const zero = (raw: unknown) => typeof raw === 'string' && decimal.test(raw.trim()) && Number(raw) === 0;
  return position?.status === 'open' && verifiedTokenRealizedPnl(activity, now) === 0
    && zero(flow?.soldUsd) && zero(flow?.transferOutIncomeUsd);
}

const retryableInventoryReasons = new Set(['inventory_rpc_unavailable', 'canonical_block_unavailable',
  'canonical_receipt_unavailable', 'canonical_transaction_unavailable', 'movement_scan_unavailable', 'confirmed_endpoint_stale']);
export function terminalTokenInventoryFailure(activity: KolTokenActivity | null) {
  if (isNodeAccounting(activity)) return activity!.realizedAccounting!.status === 'unavailable';
  const proof = activity?.inventory?.coverage;
  if (isGmgnHistoryFallback(activity) || isTrackedHistoryFallback(activity)) {
    return activity!.realizedAccounting!.status !== 'pending' && verifiedTokenAccounting(activity) === null;
  }
  return proof?.status === 'unavailable' && !retryableInventoryReasons.has(proof.reason ?? '');
}

export function tokenPositionPnlUnavailableNotice(activity: KolTokenActivity | null) {
  if (!tokenPositionIsOpen(activity)) return tokenRealizedPnlUnavailableNotice(activity);
  const detail = tokenPnlVerificationFailureNotice(activity);
  if (detail) return detail;
  if (verifiedTokenAccounting(activity) !== null) return 'Estimated profit is unavailable until a current token price is verified.';
  const reason = activity?.realizedAccounting?.coverage.reason;
  if (reason === 'gmgn_position_not_found') return 'Estimated profit is unavailable for this position with the current API key.';
  return 'Estimated profit is unavailable until wallet movements, purchase costs and the current balance are verified.';
}

/** Explain the failed check without suggesting that already verified balances
 * or movements are still loading. Both cards and the modal use these notices. */
function tokenPnlVerificationFailureNotice(activity: KolTokenActivity | null) {
  if (isNodeAccounting(activity)) {
    const reasons = activity!.accountingSnapshot?.reasons ?? [activity!.realizedAccounting?.coverage.reason ?? ''];
    if (reasons.includes('historical_accounting_mismatch')) return historicalAccountingMismatchNotice;
    if (reasons.includes('native_trace_required')) return 'Waiting for the node to verify native BNB spent or received.';
    if (reasons.includes('historical_import_cooldown')) return 'Historical data import is waiting for the provider cooldown.';
    if (reasons.some(reason => /(?:unreconciled|mismatch|contradictory)/.test(reason))) return 'Transaction amounts do not match the confirmed wallet balance.';
    if (reasons.some(reason => /(?:cost_unknown|cost_invalid|capital_unknown)/.test(reason))) return 'Purchase or incoming-transfer costs are unavailable for this position.';
    if (reasons.some(reason => /(?:historical_baseline_required|historical_gap)/.test(reason))) return 'Older accounting history needs recovery.';
    if (reasons.some(reason => /(?:decod|attribution|allocation|operation_|receipt)/.test(reason))) return 'Captured transactions need additional decoding before profit is available.';
    if (reasons.some(reason => /(?:fee)/.test(reason))) return 'Wallet-paid fees are still being valued.';
    if (reasons.some(reason => /(?:quote|valuation)/.test(reason))) return 'Waiting for a fresh confirmed market price.';
    if (reasons.some(reason => /(?:collection|indexing|indexer|balance_unavailable)/.test(reason))) return 'Captured wallet transactions are still being prepared.';
    return 'Position accounting is being prepared.';
  }
  const reasons = [activity?.realizedAccounting?.coverage.reason, activity?.realizedAccounting?.position?.reason,
    activity?.inventory?.coverage.reason];
  if (reasons.some(reason => ['inventory_balance_mismatch', 'balance_mismatch', 'gmgn_history_balance_mismatch'].includes(reason ?? ''))) {
    return 'Profit is unavailable because transaction amounts do not match the wallet balance.';
  }
  if (reasons.some(reason => ['provider_transaction_mismatch', 'gmgn_history_indexed_mismatch', 'provider_activity_conflict', 'gmgn_history_conflict'].includes(reason ?? ''))) {
    return 'Profit is unavailable because GMGN and the verified trade history do not match.';
  }
  if (reasons.some(reason => ['gmgn_realized_cost_unavailable', 'quote_or_fee_unavailable', 'transfer_fee_schema_unavailable',
    'gmgn_history_opening_cost_unknown', 'gmgn_history_cost_invalid', 'purchase_cost_unavailable', 'provider_basis_unreconciled'].includes(reason ?? ''))) {
    return 'Profit is unavailable because purchase costs or fees could not be verified.';
  }
  return null;
}

export function tokenPnlNeedsRetry(activity: KolTokenActivity) {
  if (isFreshNodeAccounting(activity)) return activity.realizedAccounting?.status === 'pending' || activity.accountingSnapshot?.refreshStatus === 'pending'
    || activity.realizedAccounting?.position?.status === 'open' && verifiedTokenPositionPnl(activity) === null;
  if (isNodeAccounting(activity)) return activity.realizedAccounting?.status === 'pending' || activity.accountingSnapshot?.refreshStatus === 'pending';
  if (terminalTokenInventoryFailure(activity)) return false;
  const proof = activity.inventory?.coverage, accounting = activity.realizedAccounting, position = accounting?.position;
  const retryAfter = Math.max(accounting?.retryAfterMs ?? 0, position?.retryAfterMs ?? 0);
  const retryQuote = accounting?.status === 'ready' && position?.status === 'open'
    && (!position.reason || /^(current_quote_unavailable|quote_rate_limited|provider_(busy|rate_limited|timeout|unavailable)|provider_http_(429|5\d\d))$/.test(position.reason));
  return accounting?.status === 'pending' || retryQuote || Number.isFinite(retryAfter) && retryAfter > 0
    || proof?.status === 'pending' || retryableInventoryReasons.has(proof?.reason ?? '');
}

export function kolTokenPnlKey(selection: KolTokenPnlSelection) {
  const time = Date.parse(selection.lastTradeAt ?? '');
  return `${selection.requestContext ? `journal:${selection.requestContext.accountId}:` : ''}${selection.walletAddress.toLowerCase()}:${selection.tokenAddress.toLowerCase()}:${Number.isFinite(time) ? time : selection.lastTradeAt ?? ''}`;
}

function verifiedTokenAccounting(activity: KolTokenActivity | null, now = Date.now()) {
  if (isNodeAccounting(activity)) return verifiedNodeAccounting(activity!, now);
  const proof = activity?.inventory?.coverage, accounting = activity?.realizedAccounting;
  if (!activity || typeof activity.kol?.address !== 'string' || typeof activity.token?.address !== 'string'
    || !address.test(activity.kol.address) || !address.test(activity.token.address)
    || activity.coverage?.complete !== true || activity.inventory?.version !== 1 || !proof
    || !accounting || accounting.version !== 1
    || !supportedAccountingPolicy(accounting) || accounting.status !== 'ready'
    || accounting.coverage?.transactionsComplete !== true || accounting.coverage.balanceMatched !== true
    || typeof accounting.walletAddress !== 'string' || typeof accounting.tokenAddress !== 'string'
    || accounting.walletAddress.toLowerCase() !== activity.kol.address.toLowerCase()
    || accounting.tokenAddress.toLowerCase() !== activity.token.address.toLowerCase()) return null;
  if (usesProviderHistory(activity)) {
    const balanceProof = accounting.coverage.balanceProof;
    const balance = typeof balanceProof?.balance === 'string' && decimal.test(balanceProof.balance.trim()) ? Number(balanceProof.balance) : NaN;
    const lastMovementAt = typeof accounting.coverage.lastMovementAt === 'string' ? Date.parse(accounting.coverage.lastMovementAt) : NaN;
    if (!(isGmgnHistoryFallback(activity) || isTrackedHistoryFallback(activity)) || !balanceProof || balanceProof.chain !== 'bsc'
      || typeof balanceProof.walletAddress !== 'string' || typeof balanceProof.tokenAddress !== 'string'
      || balanceProof.walletAddress.toLowerCase() !== activity.kol.address.toLowerCase()
      || balanceProof.tokenAddress.toLowerCase() !== activity.token.address.toLowerCase()
      || typeof balanceProof.blockNumber !== 'string' || !/^[1-9]\d*$/.test(balanceProof.blockNumber)
      || typeof balanceProof.blockHash !== 'string' || !/^0x[0-9a-f]{64}$/i.test(balanceProof.blockHash)
      || typeof accounting.coverage.historyFingerprint !== 'string' || !/^[0-9a-f]{64}$/i.test(accounting.coverage.historyFingerprint)
      || !freshProofTime(accounting.coverage.historyCheckedAt, now, providerHistoryMaxAgeMs) || !freshProofTime(balanceProof.checkedAt, now)
      || !freshProofTime(balanceProof.blockTimestamp, now) || Date.parse(balanceProof.blockTimestamp) > now
      || Date.parse(balanceProof.blockTimestamp) > Date.parse(balanceProof.checkedAt)
      || !Number.isFinite(lastMovementAt) || lastMovementAt > Date.parse(balanceProof.blockTimestamp)
      || !freshProofTime(accounting.checkedAt, now, providerHistoryMaxAgeMs) || !Number.isFinite(balance) || balance < 0
      || proof.complete && !freshProofTime(proof.checkedAt, now)) return null;
    if (accounting.source === 'onchain' && !trackedCashFlowMatches(accounting, balance)) return null;
    return accounting;
  }
  // Provider-history evidence must never silently pass as canonical history.
  if (accounting.coverage.verification !== undefined || accounting.coverage.historyFingerprint !== undefined
    || accounting.coverage.historyCheckedAt !== undefined || accounting.coverage.balanceProof !== undefined
    || accounting.coverage.lastMovementAt !== undefined
    || proof.complete !== true || proof.reconciled !== true) return null;
  const checkedAt = typeof proof.checkedAt === 'string' ? Date.parse(proof.checkedAt) : NaN;
  const providerCheckedAt = typeof accounting.checkedAt === 'string' ? Date.parse(accounting.checkedAt) : NaN;
  const balance = typeof proof.balance === 'string' && decimal.test(proof.balance.trim()) ? Number(proof.balance) : NaN;
  if (!Number.isFinite(checkedAt) || checkedAt > now + 1000 || now - checkedAt > 180_000
    || !Number.isFinite(providerCheckedAt) || providerCheckedAt > now + 1000 || !Number.isFinite(balance) || balance < 0) return null;
  if (accounting.source === 'onchain' && (proof.status !== 'verified' || proof.reason !== undefined
    || typeof proof.fromBlock !== 'string' || !/^\d+$/.test(proof.fromBlock)
    || typeof proof.toBlock !== 'string' || !/^\d+$/.test(proof.toBlock) || BigInt(proof.toBlock) < BigInt(proof.fromBlock)
    || typeof proof.blockHash !== 'string' || !/^0x[0-9a-f]{64}$/i.test(proof.blockHash)
    || !freshProofTime(accounting.checkedAt, now) || !trackedCashFlowMatches(accounting, balance))) return null;
  return accounting;
}

/** The server decides financial eligibility. The browser validates the version,
 * selected identity, immutable snapshot agreement and dated evidence only. */
function verifiedNodeAccounting(activity: KolTokenActivity, now: number) {
  if (activity.tracking !== undefined) return verifiedFreshNodeAccounting(activity, now);
  const raw = activity.realizedAccounting!, snapshot = activity.accountingSnapshot, proof = raw.coverage?.balanceProof;
  const fingerprint = /^[a-f0-9]{64}$/i, hash = /^0x[a-f0-9]{64}$/i;
  const dated = snapshot?.refreshStatus === 'pending';
  const time = (value: unknown, current = false) => typeof value === 'string' && Number.isFinite(Date.parse(value))
    && Date.parse(value) <= now + 1000 && (!current || dated || now - Date.parse(value) <= 180_000);
  const quantity = (value: unknown) => typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value)
    ? value.replace(/^0+(?=\d)/, '').replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1') : null;
  if (!snapshot || snapshot.version !== 2 || !snapshot.complete || !fingerprint.test(snapshot.snapshotId) || !fingerprint.test(snapshot.historyFingerprint)
    || snapshot.source !== raw.source || raw.status !== 'ready' || !raw.coverage.transactionsComplete || !raw.coverage.balanceMatched
    || raw.walletAddress?.toLowerCase() !== activity.kol.address.toLowerCase() || raw.tokenAddress?.toLowerCase() !== activity.token.address.toLowerCase()
    || !address.test(activity.kol.address) || !address.test(activity.token.address) || !time(snapshot.asOf, true) || !time(raw.checkedAt, true)
    || raw.coverage.historyFingerprint !== snapshot.historyFingerprint || !proof || proof.chain !== 'bsc'
    || proof.walletAddress?.toLowerCase() !== raw.walletAddress.toLowerCase() || proof.tokenAddress?.toLowerCase() !== raw.tokenAddress.toLowerCase()
    || !/^\d+$/.test(proof.blockNumber) || !hash.test(proof.blockHash) || snapshot.coveredThroughBlock !== proof.blockNumber
    || !time(proof.checkedAt, true) || !time(proof.blockTimestamp, true) || Date.parse(proof.blockTimestamp) > Date.parse(proof.checkedAt)
    || !/^\d+$/.test(snapshot.valuationBlock ?? '') || !hash.test(snapshot.valuationHash ?? '')) return null;
  const position = raw.position, actual = quantity(proof.balance), remaining = quantity(position?.remainingTokenAmount);
  if (!position || actual === null || remaining !== actual || position.status === 'closed' && actual !== '0'
    || position.status === 'open' && (actual === '0' || !time(position.pricedAt, true) || !position.priceUsd || !decimal.test(position.priceUsd)
      || !Number.isFinite(Number(position.priceUsd)) || Number(position.priceUsd) <= 0)) return null;
  if (snapshot.scope === 'portfolio' && !('journal' in activity)) return null;
  return raw;
}

/** Current-row accounting is approved by the server. Light profile responses
 * deliberately omit receipt histories and balance-proof response copies. A
 * closed result is dated financial history, not a quote that expires in 3m. */
function verifiedFreshNodeAccounting(activity: KolTokenActivity, now: number) {
  const raw = activity.realizedAccounting, snapshot = activity.accountingSnapshot, tracking = activity.tracking;
  const digest = /^[a-f0-9]{64}$/i, blockHash = /^0x[a-f0-9]{64}$/i;
  const time = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value)) && Date.parse(value) <= now + 1000;
  const height = (value: unknown): value is string => typeof value === 'string' && /^\d+$/.test(value);
  if (!raw || !snapshot || tracking?.version !== 1 || tracking.source !== 'fresh' || !height(tracking.fromBlock)
    || !/^\d{4}-\d{2}-\d{2}$/.test(tracking.utcDay) || !Number.isFinite(Date.parse(`${tracking.utcDay}T00:00:00Z`))
    || snapshot.version !== 2 || snapshot.source !== 'node' || raw.source !== 'node' || raw.policy !== 'kollens_fifo_v1' || raw.version !== 2
    || snapshot.complete !== true && tracking.realizedComplete !== true || raw.status !== 'ready' || raw.coverage?.transactionsComplete !== true || raw.coverage.balanceMatched !== true
    || !digest.test(snapshot.snapshotId) || !digest.test(snapshot.historyFingerprint) || !height(snapshot.coveredThroughBlock)
    || BigInt(snapshot.coveredThroughBlock) < BigInt(tracking.fromBlock)
    || typeof raw.walletAddress !== 'string' || typeof raw.tokenAddress !== 'string'
    || !address.test(activity.kol.address) || !address.test(activity.token.address)
    || raw.walletAddress.toLowerCase() !== activity.kol.address.toLowerCase() || raw.tokenAddress.toLowerCase() !== activity.token.address.toLowerCase()
    || !time(snapshot.asOf) || !time(raw.checkedAt) || Date.parse(raw.checkedAt) !== Date.parse(snapshot.asOf)
    || raw.coverage.historyFingerprint !== undefined && raw.coverage.historyFingerprint !== snapshot.historyFingerprint) return null;
  const position = raw.position, quantity = position?.remainingTokenAmount;
  if (!position || !['open', 'closed'].includes(position.status) || typeof quantity !== 'string' || !decimal.test(quantity)
    || !Number.isFinite(Number(quantity)) || Number(quantity) < 0 || (position.status === 'closed') !== (Number(quantity) === 0)) return null;
  if (position.status === 'open' && position.estimatedProfitUsd !== null && (!height(snapshot.valuationBlock) || !blockHash.test(snapshot.valuationHash ?? ''))) return null;
  if (snapshot.scope === 'portfolio') {
    const membership = 'journal' in activity ? activity.journal as { accountId?: string; walletAddress?: string; membershipRevision?: string; private?: boolean } : null;
    if (!membership || membership.private !== true || typeof membership.accountId !== 'string' || !membership.accountId
      || membership.walletAddress !== activity.kol.address.toLowerCase() || !/^[a-f0-9-]{36}$/i.test(membership.membershipRevision ?? '')) return null;
  } else if (snapshot.scope !== 'public' || 'journal' in activity) return null;
  return raw;
}

/** This policy includes only verified buy/sell cash flows, never fabricated
 * transfer income or zero-valued unknown fees. Gas is explicitly excluded. */
function trackedCashFlowMatches(accounting: NonNullable<KolTokenActivity['realizedAccounting']>, balance: number) {
  const position = accounting.position, flow = position?.cashFlow;
  const amount = (raw: unknown, signed = false) => typeof raw === 'string' && decimal.test(raw.trim()) && Number.isFinite(Number(raw))
    && (signed || Number(raw) >= 0) ? Number(raw) : null;
  const invested = amount(flow?.investedUsd), sold = amount(flow?.soldUsd), outgoing = amount(flow?.transferOutIncomeUsd), fees = amount(flow?.feesUsd);
  const cost = amount(position?.feeInclusiveCostUsd), basis = amount(position?.remainingCostBasisUsd), remaining = amount(position?.remainingTokenAmount);
  const realized = amount(accounting.realizedProfitUsd, true);
  if (!position || invested === null || invested <= 0 || sold === null || outgoing !== 0 || fees !== 0
    || cost === null || basis === null || remaining === null || realized === null
    || position.status !== (balance === 0 ? 'closed' : 'open') || (remaining === 0) !== (balance === 0)
    || Math.abs(remaining - balance) > Math.max(remaining, balance) * 1e-10 || balance === 0 && basis !== 0) return false;
  const close = (a: number, b: number) => Math.abs(a - b) <= Math.max(1e-8, Math.max(Math.abs(a), Math.abs(b)) * 1e-10);
  return close(cost, invested) && basis <= invested + Math.max(1e-8, invested * 1e-10)
    && close(realized, sold - invested + basis);
}

function usesProviderHistory(activity: KolTokenActivity | null) {
  const verification = activity?.realizedAccounting?.coverage.verification;
  return verification === 'gmgn_history' || verification === 'tracked_history';
}

function supportedAccountingPolicy(accounting: KolTokenActivity['realizedAccounting']) {
  return accounting?.source === 'gmgn' && accounting.policy === 'gmgn_realized_profit_v1' && accounting.coverage?.reason !== 'onchain_estimate_gas_excluded'
    || accounting?.source === 'onchain' && accounting.policy === 'onchain_net_trade_profit_v1'
      && accounting.coverage?.reason === 'onchain_estimate_gas_excluded';
}

function isTrackedAccounting(activity: KolTokenActivity | null) {
  return activity?.realizedAccounting?.source === 'onchain' && supportedAccountingPolicy(activity.realizedAccounting);
}

/** Independently indexed swap cash flows can use complete provider movements
 * and a current-chain balance when historical RPC reads are unavailable. */
function isTrackedHistoryFallback(activity: KolTokenActivity | null) {
  const proof = activity?.inventory?.coverage, accounting = activity?.realizedAccounting;
  return !!activity && activity.coverage?.complete === true && activity.inventory?.version === 1
    && proof?.complete === false && proof.reconciled === false && proof.status === 'unavailable' && canUseGmgnHistoryFallback(proof.reason)
    && accounting?.version === 1 && isTrackedAccounting(activity) && accounting.coverage?.verification === 'tracked_history'
    && typeof activity.kol?.address === 'string' && address.test(activity.kol.address)
    && typeof activity.token?.address === 'string' && address.test(activity.token.address)
    && typeof accounting.walletAddress === 'string' && typeof accounting.tokenAddress === 'string'
    && accounting.walletAddress.toLowerCase() === activity.kol.address.toLowerCase()
    && accounting.tokenAddress.toLowerCase() === activity.token.address.toLowerCase();
}

function freshProofTime(raw: unknown, now: number, maxAgeMs = 180_000) {
  const time = typeof raw === 'string' ? Date.parse(raw) : NaN;
  return Number.isFinite(time) && time <= now + 1000 && now - time <= maxAgeMs;
}

/** A lifetime GMGN aggregate can cover earlier closed positions outside the
 * canonical window. The backend verifies their history separately; the client
 * still requires the current balance and canonical head to agree. */
function canonicalInventoryAllowsAggregate(activity: KolTokenActivity) {
  const inventory = activity.inventory!.coverage, current = activity.realizedAccounting!.coverage.balanceProof;
  if (activity.realizedAccounting!.coverage.reason !== 'gmgn_aggregate_verified'
    || inventory.complete !== true || inventory.reconciled !== true || inventory.status !== 'verified'
    || inventory.reason !== undefined || !current
    || typeof inventory.toBlock !== 'string' || !/^[1-9]\d*$/.test(inventory.toBlock)
    || typeof current.blockNumber !== 'string' || !/^[1-9]\d*$/.test(current.blockNumber)
    || typeof inventory.blockHash !== 'string' || !/^0x[0-9a-f]{64}$/i.test(inventory.blockHash)
    || typeof current.blockHash !== 'string' || !/^0x[0-9a-f]{64}$/i.test(current.blockHash)) return false;
  const canonicalBalance = typeof inventory.balance === 'string' && decimal.test(inventory.balance.trim()) ? Number(inventory.balance) : NaN;
  const currentBalance = typeof current.balance === 'string' && decimal.test(current.balance.trim()) ? Number(current.balance) : NaN;
  if (!Number.isFinite(canonicalBalance) || canonicalBalance < 0 || !Number.isFinite(currentBalance) || currentBalance < 0
    || (canonicalBalance === 0) !== (currentBalance === 0)
    || Math.abs(canonicalBalance - currentBalance) > Math.max(canonicalBalance, currentBalance) * 1e-12) return false;
  const canonicalHead = BigInt(inventory.toBlock), currentHead = BigInt(current.blockNumber);
  return currentHead > canonicalHead || currentHead === canonicalHead && current.blockHash.toLowerCase() === inventory.blockHash.toLowerCase();
}

/** Provider evidence cannot override a contradictory or unfinished canonical
 * scan. Complete canonical windows additionally require a verified aggregate. */
function isGmgnHistoryFallback(activity: KolTokenActivity | null) {
  const proof = activity?.inventory?.coverage, accounting = activity?.realizedAccounting;
  return !!activity && activity.coverage?.complete === true && activity.inventory?.version === 1
    && !!proof && accounting?.version === 1
    && accounting.source === 'gmgn' && accounting.policy === 'gmgn_realized_profit_v1'
    && accounting.coverage?.verification === 'gmgn_history'
    && typeof activity.kol?.address === 'string' && address.test(activity.kol.address)
    && typeof activity.token?.address === 'string' && address.test(activity.token.address)
    && typeof accounting.walletAddress === 'string' && typeof accounting.tokenAddress === 'string'
    && accounting.walletAddress.toLowerCase() === activity.kol.address.toLowerCase()
    && accounting.tokenAddress.toLowerCase() === activity.token.address.toLowerCase()
    && (proof.complete === false && proof.reconciled === false && proof.status === 'unavailable' && canUseGmgnHistoryFallback(proof.reason)
      || canonicalInventoryAllowsAggregate(activity));
}

function isGmgnReportedAggregate(activity: KolTokenActivity | null) {
  return isGmgnHistoryFallback(activity) && activity!.realizedAccounting!.coverage.reason === 'gmgn_aggregate_verified';
}

export function verifiedTokenRealizedPnl(activity: KolTokenActivity | null, now = Date.now()) {
  const accounting = verifiedTokenAccounting(activity, now);
  const raw = accounting?.realizedProfitUsd;
  if (typeof raw !== 'string' || !decimal.test(raw.trim())) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

export function tokenRealizedPnlUnavailableNotice(activity: KolTokenActivity | null) {
  if (!activity) return 'Position accounting is being prepared.';
  const detail = tokenPnlVerificationFailureNotice(activity);
  if (detail) return detail;
  const accounting = activity?.realizedAccounting, reason = accounting?.coverage?.reason;
  if (reason === 'inventory_history_unavailable') return 'Historical transaction data is unavailable.';
  if (reason === 'gmgn_position_not_found') return 'GMGN realized P&L is unavailable for this position with the current API key.';
  if (['gmgn_not_configured', 'gmgn_key_unavailable', 'provider_key_unavailable'].includes(reason ?? '')) return 'GMGN realized P&L is unavailable because the provider is not configured.';
  if (activity && (activity.coverage?.complete !== true || activity.inventory?.coverage?.complete !== true
    || activity.inventory?.coverage?.reconciled !== true)) return 'GMGN realized P&L is unavailable until wallet movements and balance are verified.';
  return 'GMGN realized P&L could not be verified for this token.';
}

/** Transfer-only changes also invalidate a retained total, even when the last
 * indexed trade timestamp has stayed the same. */
function tokenPnlIndexedInputsMatch(left: KolTokenActivity, right: KolTokenActivity) {
  if (!left.inventory?.coverage || !right.inventory?.coverage || !Array.isArray(left.inventory.events) || !Array.isArray(right.inventory.events)
    || !Array.isArray(left.trades) || !Array.isArray(right.trades) || left.inventory.coverage.balance !== right.inventory.coverage.balance
    || left.inventory.coverage.fromBlock !== right.inventory.coverage.fromBlock
    || left.inventory.coverage.initialBalanceSource !== right.inventory.coverage.initialBalanceSource) return false;
  const events = (activity: KolTokenActivity) => activity.inventory!.events.map(event => [event.id, event.kind, event.txHash,
    event.timestamp, event.blockNumber, event.transactionIndex, event.logIndex, event.tokenAmount]);
  const trades = (activity: KolTokenActivity) => activity.trades.map(trade => [trade.id, trade.side, trade.tokenAmount,
    trade.amountUsd, trade.quoteAmount, trade.quoteSymbol, trade.quoteTokenAddress, trade.priceUsd, trade.source,
    trade.txHash, trade.timestamp, trade.blockNumber, trade.transactionIndex, trade.valuationStatus]);
  return JSON.stringify(events(left)) === JSON.stringify(events(right)) && JSON.stringify(trades(left)) === JSON.stringify(trades(right));
}

export function tokenPnlMovementsMatch(left: KolTokenActivity, right: KolTokenActivity) {
  if (isNodeAccounting(left) || isNodeAccounting(right)) return isNodeAccounting(left) && isNodeAccounting(right)
    && left.kol.address === right.kol.address && left.token.address === right.token.address
    && left.accountingSnapshot?.snapshotId === right.accountingSnapshot?.snapshotId
    && left.accountingSnapshot?.historyFingerprint === right.accountingSnapshot?.historyFingerprint;
  if (!tokenPnlIndexedInputsMatch(left, right)) return false;
  const oldAccounting = left.realizedAccounting, incoming = right.realizedAccounting;
  if (!oldAccounting || !incoming || incoming.version !== 1 || !supportedAccountingPolicy(incoming)
    || incoming.source !== oldAccounting.source || incoming.policy !== oldAccounting.policy
    || typeof incoming.walletAddress !== 'string' || typeof incoming.tokenAddress !== 'string'
    || typeof oldAccounting.walletAddress !== 'string' || typeof oldAccounting.tokenAddress !== 'string'
    || incoming.walletAddress.toLowerCase() !== oldAccounting.walletAddress.toLowerCase()
    || incoming.tokenAddress.toLowerCase() !== oldAccounting.tokenAddress.toLowerCase()
    || incoming.realizedProfitUsd !== null && incoming.realizedProfitUsd !== oldAccounting.realizedProfitUsd) return false;
  if (oldAccounting.coverage.verification !== incoming.coverage.verification
    || oldAccounting.coverage.historyFingerprint !== incoming.coverage.historyFingerprint
    || oldAccounting.coverage.lastMovementAt !== incoming.coverage.lastMovementAt
    || oldAccounting.coverage.balanceProof?.balance !== incoming.coverage.balanceProof?.balance) return false;
  if (usesProviderHistory(right)) {
    const oldProof = oldAccounting.coverage.balanceProof, nextProof = incoming.coverage.balanceProof;
    if (!(isGmgnHistoryFallback(left) || isTrackedHistoryFallback(left)) || !(isGmgnHistoryFallback(right) || isTrackedHistoryFallback(right)) || !oldProof || !nextProof
      || oldProof.chain !== nextProof.chain || typeof oldProof.walletAddress !== 'string' || typeof nextProof.walletAddress !== 'string'
      || typeof oldProof.tokenAddress !== 'string' || typeof nextProof.tokenAddress !== 'string'
      || oldProof.walletAddress.toLowerCase() !== nextProof.walletAddress.toLowerCase()
      || oldProof.tokenAddress.toLowerCase() !== nextProof.tokenAddress.toLowerCase()
      || typeof nextProof.blockNumber !== 'string' || !/^[1-9]\d*$/.test(nextProof.blockNumber)
      || typeof nextProof.blockHash !== 'string' || !/^0x[0-9a-f]{64}$/i.test(nextProof.blockHash)
      || oldProof.blockNumber === nextProof.blockNumber && oldProof.blockHash.toLowerCase() !== nextProof.blockHash.toLowerCase()) return false;
  }
  return true;
}

/** A provider cooldown has no replacement evidence. Keep an independently
 * verified, unexpired original snapshot only when all indexed inputs are the
 * same and the incoming response contains no partial/contradictory proof.
 * Never merge proof fields into the pending response or refresh their dates. */
export function tokenPnlMayRetainDuringProviderRetry(left: KolTokenActivity, right: KolTokenActivity, now = Date.now()) {
  if (!isGmgnHistoryFallback(left) || !isGmgnHistoryFallback(right) || displayedTokenPnl(left, now) === null
    || !tokenPnlIndexedInputsMatch(left, right) || left.inventory!.coverage.reason !== right.inventory!.coverage.reason
    || !compatibleUnavailableHead(left.inventory!.coverage, right.inventory!.coverage)
    || left.inventory!.coverage.scannedThroughBlock !== right.inventory!.coverage.scannedThroughBlock
    || left.kol.address.toLowerCase() !== right.kol.address.toLowerCase()
    || left.token.address.toLowerCase() !== right.token.address.toLowerCase()
    || left.coverage.indexedTradeCount !== right.coverage.indexedTradeCount
    || left.coverage.returnedTradeCount !== right.coverage.returnedTradeCount) return false;
  const incoming = right.realizedAccounting!, coverage = incoming.coverage;
  return incoming.status === 'pending' && incoming.realizedProfitUsd === null && incoming.position === undefined
    && /^(provider_(busy|rate_limited|timeout|unavailable)|provider_http_(429|5\d\d))$/.test(coverage.reason ?? '')
    && coverage.transactionsComplete === false && coverage.balanceMatched === false
    && coverage.historyFingerprint === undefined && coverage.historyCheckedAt === undefined
    && coverage.lastMovementAt === undefined && coverage.balanceProof === undefined;
}

/** A failed historical read can be retried against a later chain head without
 * introducing a new ledger. A backwards head or same-height hash conflict is
 * contradictory; a newer head never renews the retained snapshot's evidence. */
function compatibleUnavailableHead(left: NonNullable<KolTokenActivity['inventory']>['coverage'], right: NonNullable<KolTokenActivity['inventory']>['coverage']) {
  if (left.toBlock === null && right.toBlock === null) return left.blockHash === null && right.blockHash === null;
  if (typeof left.toBlock !== 'string' || !/^[1-9]\d*$/.test(left.toBlock)
    || typeof right.toBlock !== 'string' || !/^[1-9]\d*$/.test(right.toBlock)
    || typeof left.blockHash !== 'string' || !/^0x[0-9a-f]{64}$/i.test(left.blockHash)
    || typeof right.blockHash !== 'string' || !/^0x[0-9a-f]{64}$/i.test(right.blockHash)) return false;
  const before = BigInt(left.toBlock), after = BigInt(right.toBlock);
  return after > before || after === before && left.blockHash.toLowerCase() === right.blockHash.toLowerCase();
}

function cancelled() { return new DOMException('Token P&L request cancelled.', 'AbortError'); }
function bounded<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? cancelled());
    if (signal.aborted) { work.catch(() => {}); abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    work.then(value => { signal.removeEventListener('abort', abort); resolve(value); }, error => { signal.removeEventListener('abort', abort); reject(error); });
  });
}
function pause(delay: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(cancelled()); return; }
    const abort = () => { clearTimeout(timer); reject(cancelled()); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, delay);
    signal.addEventListener('abort', abort, { once: true });
  });
}
function retryDelay(response: Response | undefined, attempt: number) {
  const raw = response?.headers?.get('Retry-After');
  if (raw) {
    const seconds = Number(raw), until = Number.isFinite(seconds) ? Date.now() + seconds * 1000 : Date.parse(raw);
    if (Number.isFinite(until) && until > Date.now()) return Math.max(1000, until - Date.now());
  }
  return Math.min(3000, (attempt + 1) * 1000);
}

/** Cards poll the nonblocking profile endpoint through one fair HTTP slot.
 * A pending scan releases the slot immediately, so cached cards can load while
 * it continues. Foreground modal work keeps its dedicated request path. */
export function createKolTokenPnlLoader({ fetcher = (input, init) => fetch(input, init), now = Date.now }:
  { fetcher?: typeof fetch; now?: () => number } = {}) {
  type Client = { resolve(value: KolTokenPnlResult): void; reject(error: unknown): void; detach(): void; onActivity?(activity: KolTokenActivity): void };
  type Job = { key: string; cacheKey: string; selection: KolTokenPnlSelection; controller: AbortController; clients: Set<Client>; foreground: boolean };
  type Ticket = { job: Job; start(): void; stop(): void };
  const jobs = new Map<string, Job>(), queue: Ticket[] = [];
  const recent = new Map<string, { value: KolTokenPnlResult; checkedAt: number }>();
  let active = false, backgroundHolds = 0;
  const dispatch = () => {
    if (active || backgroundHolds > 0) return;
    const next = queue.shift();
    if (!next) return;
    if (next.job.controller.signal.aborted) { next.stop(); dispatch(); return; }
    active = true; next.start();
  };
  function slot(job: Job): Promise<() => void> {
    if (job.controller.signal.aborted) return Promise.reject(cancelled());
    if (job.foreground) return Promise.resolve(() => {});
    return new Promise((resolve, reject) => {
      const signal = job.controller.signal;
      const stop = () => {
        const index = queue.indexOf(ticket); if (index >= 0) queue.splice(index, 1);
        signal.removeEventListener('abort', stop); reject(cancelled());
      };
      const ticket: Ticket = { job, stop, start: () => {
        signal.removeEventListener('abort', stop);
        let released = false;
        resolve(() => { if (released) return; released = true; active = false; dispatch(); });
      } };
      signal.addEventListener('abort', stop, { once: true }); queue.push(ticket); dispatch();
    });
  }
  async function run(job: Job): Promise<KolTokenPnlResult> {
    const { walletAddress, tokenAddress } = job.selection, signal = job.controller.signal;
    let deadline = Infinity, timer: ReturnType<typeof setTimeout> | undefined;
    let activity: KolTokenActivity | null = null, pending = false, delay = 1000;
    try {
      for (let attempt = 0; attempt < 6; attempt += 1) {
        const release = await slot(job);
        if (!timer) { deadline = now() + requestBudgetMs; timer = setTimeout(() => job.controller.abort(), requestBudgetMs); }
        const request = new AbortController();
        const abortRequest = () => request.abort(signal.reason);
        signal.addEventListener('abort', abortRequest, { once: true });
        // The profile endpoint returns 202 quickly while its server job keeps
        // running. A stalled connection must not occupy every card's only slot.
        const requestTimer = job.foreground ? undefined : setTimeout(() => request.abort(), profileAttemptBudgetMs);
        let response: Response | undefined, providerDelay = 0;
        try {
          signal.throwIfAborted();
          response = await bounded(fetcher(`${tradeActivityBase(walletAddress, tokenAddress, job.selection.requestContext)}/activity?pnl=true${job.selection.requestContext ? '&replay=true' : ''}${job.foreground ? '' : '&profile=true'}`,
            { signal: request.signal, cache: 'no-store', headers: tradeRequestHeaders(job.selection.requestContext) }), request.signal);
          if (response.status === 202) {
            // Accepted profile work is still running on the server; its small
            // status response is not an activity snapshot to validate or cache.
            pending = true;
          } else if (!response.ok) {
            pending = response.status === 429 || response.status >= 500;
            if (!pending) return { activity: null, status: 'unavailable' };
          } else {
            const body: KolTokenActivity = await bounded(response.json(), request.signal);
            if (typeof body?.kol?.address !== 'string' || typeof body?.token?.address !== 'string'
              || body.kol.address.toLowerCase() !== walletAddress.toLowerCase() || body.token.address.toLowerCase() !== tokenAddress.toLowerCase()
              || !body.coverage || !body.summary || !Array.isArray(body.trades)) return { activity: null, status: 'unavailable' };
            const expectedTime = Date.parse(job.selection.lastTradeAt ?? ''), returnedTime = Date.parse(body.summary.lastTradeAt ?? '');
            const datedNode = isNodeAccounting(body) && body.accountingSnapshot?.refreshStatus === 'pending';
            if (Number.isFinite(expectedTime) && (!Number.isFinite(returnedTime) || returnedTime < expectedTime) && !datedNode) pending = true;
            else {
              if (isNodeAccounting(body) && job.selection.requestContext) {
                const membership = 'journal' in body ? body.journal as { accountId?: string; walletAddress?: string; membershipRevision?: string; snapshotId?: string; private?: boolean } : null;
                if (body.accountingSnapshot?.scope !== 'portfolio' || membership?.accountId !== job.selection.requestContext.accountId
                  || membership.private !== true || membership.walletAddress !== walletAddress.toLowerCase()
                  || !/^[a-f0-9-]{36}$/i.test(membership.membershipRevision ?? '')
                  || job.selection.requestContext.snapshotId && membership.snapshotId !== job.selection.requestContext.snapshotId)
                  return { activity: null, status: 'unavailable' };
              }
              if (isFreshNodeAccounting(body) && !job.selection.requestContext && body.accountingSnapshot?.scope !== 'public')
                return { activity: null, status: 'unavailable' };
              activity = body;
              for (const client of job.clients) client.onActivity?.(body);
              if (!isNodeAccounting(body) && job.selection.requestContext && journalTokenProfit(body, job.selection.requestContext, now()) !== null)
                return { activity: body, status: 'ready' };
              const accounting = body.realizedAccounting;
              // A terminal canonical-history failure cannot be fixed by polling
              // a downstream provider's pending status indefinitely.
              if (terminalTokenInventoryFailure(body)) return { activity: body, status: 'unavailable' };
              const retryAfter = Math.max(accounting?.retryAfterMs ?? 0, accounting?.position?.retryAfterMs ?? 0);
              const provisional = Number.isFinite(retryAfter) && retryAfter > 0;
              if (verifiedTokenPositionPnl(body, now()) !== null && (!provisional || accounting?.source === 'onchain')) {
                return { activity: body, status: 'ready', ...(provisional ? { retryAfterMs: retryAfter } : {}) };
              }
              if (isFreshNodeAccounting(body) && displayedTokenPnl(body, now()) !== null)
                return { activity: body, status: 'ready', ...(tokenPnlNeedsRetry(body) ? { retryAfterMs: Math.max(2000, retryAfter) } : {}) };
              pending = tokenPnlNeedsRetry(body);
              if (Number.isFinite(retryAfter) && retryAfter > 0) providerDelay = Math.max(1000, retryAfter);
              if (!pending) return { activity, status: 'unavailable' };
            }
          }
        } catch {
          if (signal.aborted) break;
          pending = true;
        } finally {
          if (requestTimer) clearTimeout(requestTimer);
          signal.removeEventListener('abort', abortRequest);
          release();
        }
        delay = Math.max(retryDelay(response, attempt), providerDelay);
        if (attempt === 5 || delay >= deadline - now()) break;
        await pause(delay, signal);
      }
      return { activity, status: pending || signal.aborted ? 'pending' : 'unavailable', retryAfterMs: delay };
    } catch {
      return { activity, status: 'pending', retryAfterMs: delay };
    } finally { if (timer) clearTimeout(timer); }
  }
  function start(job: Job) {
    void run(job).then(value => {
      // Settle ownership before notifying subscribers. Their next request can
      // start immediately, including after an unavailable result with no cache.
      if (jobs.get(job.key) === job) jobs.delete(job.key);
      if (!job.selection.requestContext && value.status === 'ready' && job.clients.size) {
        recent.delete(job.cacheKey); recent.set(job.cacheKey, { value, checkedAt: now() });
        while (recent.size > 64) recent.delete(recent.keys().next().value!);
      }
      for (const client of job.clients) { client.detach(); client.resolve(value); }
    });
  }
  const load = (selection: KolTokenPnlSelection, signal: AbortSignal,
    options: { priority?: 'background' | 'foreground'; onActivity?(activity: KolTokenActivity): void } = {}): Promise<KolTokenPnlResult> => {
    if (signal.aborted) return Promise.reject(cancelled());
    if (!address.test(selection.walletAddress) || !address.test(selection.tokenAddress)) return Promise.resolve({ activity: null, status: 'unavailable' });
    const cacheKey = kolTokenPnlKey(selection), cached = recent.get(cacheKey);
    if (!selection.requestContext && cached && now() >= cached.checkedAt && now() - cached.checkedAt < recentResultMs
      && verifiedTokenPositionPnl(cached.value.activity, now()) !== null) {
      if (cached.value.activity) options.onActivity?.(cached.value.activity);
      return Promise.resolve(cached.value);
    }
    recent.delete(cacheKey);
    const foreground = options.priority === 'foreground', key = `${cacheKey}:${foreground ? 'foreground' : 'background'}`;
    let job = jobs.get(key), created = false;
    if (!job) { job = { key, cacheKey, selection, foreground, controller: new AbortController(), clients: new Set() }; jobs.set(key, job); created = true; }
    const selected = job;
    const result = new Promise<KolTokenPnlResult>((resolve, reject) => {
      const abort = () => {
        selected.clients.delete(client); client.detach(); reject(cancelled());
        if (!selected.clients.size) { selected.controller.abort(); if (jobs.get(key) === selected) jobs.delete(key); }
      };
      const client: Client = { resolve, reject, onActivity: options.onActivity, detach: () => signal.removeEventListener('abort', abort) };
      selected.clients.add(client); signal.addEventListener('abort', abort, { once: true });
    });
    if (created) start(selected);
    return result;
  };
  return Object.assign(load, { suspendBackground: () => {
    backgroundHolds++;
    let released = false;
    return () => { if (!released) { released = true; backgroundHolds--; dispatch(); } };
  } });
}

export const requestKolTokenPnl = createKolTokenPnlLoader();
