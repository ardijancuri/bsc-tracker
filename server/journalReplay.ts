import { createHash } from 'node:crypto';
import type { KolTokenActivity, KolTokenBalanceProof, KolTokenTrade } from '../shared/kolTokenTrades.js';
import type { ReplayAccountingSnapshot, TradeReplayAccounting } from '../shared/tradeReplayAccounting.js';
import { calculateJournalLedger, journalDecimalDivide, journalDecimalMultiply, type JournalLedgerEvent, type JournalLedgerTimelineEntry, type JournalLedgerOpeningBalance, sumJournalDecimals } from './journalLedger.js';

function snapshot(position: JournalLedgerTimelineEntry['snapshot']): ReplayAccountingSnapshot {
  return { remainingTokenAmount: position.remainingTokenAmount, remainingCostBasisUsd: position.remainingCostBasisUsd,
    cumulativeRealizedProfitUsd: position.realizedProfitUsd, investedUsd: position.investedUsd, soldUsd: position.soldUsd,
    transferOutIncomeUsd: position.transferOutIncomeUsd, feesUsd: position.feesUsd,
    // Acquisition capital excludes disposal fees; replay total uses cash flows
    // and all fees explicitly, and ROI uses this fee-inclusive denominator.
    feeInclusiveCostUsd: position.investedUsd !== null && position.incomingTransferCostUsd !== null
      ? sumJournalDecimals([position.investedUsd, position.incomingTransferCostUsd, position.feesUsd]) : null };
}
/** The private adapter exposes server-evaluated prefix snapshots. Provider-only
 * executions retain null block positions and are never canonical trade rows. */
export function applyJournalReplay(activity: KolTokenActivity, input: { events: JournalLedgerEvent[]; proof: KolTokenBalanceProof;
  coverageComplete: boolean; openingBalances?: JournalLedgerOpeningBalance[]; quote: { priceUsd: string; timestamp: string } | null; source: 'node' | 'gmgn'; now: number }): KolTokenActivity {
  const wallet = activity.kol.address.toLowerCase(), token = activity.token.address.toLowerCase();
  const ordered = [...input.events].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp)
    || (a.blockNumber && b.blockNumber ? Number(BigInt(a.blockNumber) - BigInt(b.blockNumber)) : 0)
    || (a.transactionIndex ?? 0) - (b.transactionIndex ?? 0) || (a.logIndex ?? 0) - (b.logIndex ?? 0) || a.id.localeCompare(b.id));
  const checkedAt = new Date(input.now).toISOString();
  const evaluated = calculateJournalLedger({ wallets: [wallet], events: ordered, openingBalances: input.openingBalances,
    coverage: [{ walletAddress: wallet, tokenAddress: token, complete: input.coverageComplete }],
    valuations: [{ tokenAddress: token, priceUsd: input.quote?.priceUsd ?? null, pricedAt: input.quote?.timestamp ?? checkedAt,
      balances: [{ walletAddress: wallet, tokenAmount: input.proof.balance }] }], asOf: checkedAt, timeline: true });
  const ending = evaluated.positions[0];
  if (!ending) return activity;
  const indexed = new Map(activity.trades.map(trade => [`${trade.txHash}:${trade.side}`, trade]));
  const trades: KolTokenTrade[] = [];
  for (const event of ordered) {
    if (event.kind !== 'buy' && event.kind !== 'sell') continue;
    const known = indexed.get(`${event.txHash}:${event.kind}`), amount = event.amountUsd, quantity = Number(event.tokenAmount), price = amount !== null && quantity > 0 ? String(Number(amount) / quantity) : null;
    trades.push({ id: event.id, txHash: event.txHash, walletAddress: wallet, tokenAddress: token,
      kolName: activity.kol.name, kolAvatarUrl: activity.kol.avatarUrl, kolTwitter: activity.kol.twitter,
      tokenSymbol: activity.token.symbol, tokenName: activity.token.name, tokenLogoUrl: activity.token.logoUrl,
      side: event.kind, tokenAmount: event.tokenAmount, amountUsd: amount, priceUsd: price,
      marketCapUsd: price && activity.token.marketCapSupply ? String(Number(price) * Number(activity.token.marketCapSupply)) : null,
      quoteAmount: known?.quoteAmount ?? null, quoteSymbol: known?.quoteSymbol ?? null, timestamp: event.timestamp,
      source: event.blockNumber ? known?.source ?? 'node' : 'gmgn', blockNumber: event.blockNumber ?? null,
      transactionIndex: event.transactionIndex ?? null, valuationStatus: amount === null ? 'unpriced' : 'valued',
      realizedProfitUsd: null, cumulativeRealizedProfitUsd: null });
  }
  const events: NonNullable<TradeReplayAccounting['history']>['events'] = [];
  const prefixByEvent = new Map<string, JournalLedgerTimelineEntry['snapshot']>();
  for (const group of evaluated.timeline ?? []) for (const id of group.eventIds) prefixByEvent.set(id, group.snapshot);
  for (const event of ordered) {
    const value = prefixByEvent.get(event.id);
    events.push({ id: event.id, kind: event.kind,
      ...(event.kind === 'buy' || event.kind === 'sell' ? { tradeId: event.id } : {}), txHash: event.txHash, timestamp: event.timestamp,
      blockNumber: event.blockNumber ?? null, transactionIndex: event.transactionIndex ?? null, logIndex: event.logIndex ?? null,
      tokenAmount: event.tokenAmount, ...(value ? snapshot(value) : { remainingTokenAmount: null, remainingCostBasisUsd: null,
        cumulativeRealizedProfitUsd: null, investedUsd: null, soldUsd: null, transferOutIncomeUsd: null, feesUsd: null, feeInclusiveCostUsd: null }) });
  }
  const fullSnapshot = snapshot(ending), complete = ending.complete && input.coverageComplete;
  const average = (kind: 'buy' | 'sell') => {
    const rows = ordered.filter(row => row.kind === kind);
    return input.coverageComplete && rows.length && rows.every(row => row.amountUsd !== null)
      ? journalDecimalDivide(sumJournalDecimals(rows.map(row => row.amountUsd!)), sumJournalDecimals(rows.map(row => row.tokenAmount))) : null;
  };
  const averageBuy = average('buy'), averageSell = average('sell');
  const recoverable = !input.coverageComplete || ending.reasons.some(reason => ['balance_unreconciled', 'quote_unavailable'].includes(reason));
  const accounting: TradeReplayAccounting = { version: 1, source: 'gmgn', policy: 'gmgn_total_profit_v1', walletAddress: wallet, tokenAddress: token,
    status: complete ? 'estimated' : recoverable ? 'pending' : 'unavailable', checkedAt, inventoryBlockNumber: input.proof.blockNumber,
    inventoryBlockHash: input.proof.blockHash, events: [], final: complete ? { ...fullSnapshot,
      reportedProfitUsd: ending.estimatedProfitUsd, reportedRoi: ending.roi, priceUsd: input.quote?.priceUsd ?? null,
      timestamp: input.quote?.timestamp ?? checkedAt } : null,
    history: { fingerprint: createHash('sha256').update(JSON.stringify([ordered, input.proof])).digest('hex'), checkedAt, balanceProof: input.proof, events },
    coverage: { transactionsComplete: input.coverageComplete, balanceMatched: !ending.reasons.includes('balance_unreconciled'),
      exactFinal: false, verification: 'gmgn_history', ...(complete ? { reason: `journal_${input.source}_accounting` } : { reason: ending.reasons[0] ?? 'history_preparing' }) },
    ...(!complete && recoverable ? { retryAfterMs: 1500 } : {}) };
  return { ...activity, trades: trades.reverse(), coverage: { ...activity.coverage, complete: input.coverageComplete, indexedTradeCount: trades.length, returnedTradeCount: trades.length },
    summary: { ...activity.summary, investedUsd: ending.investedUsd, soldUsd: ending.soldUsd, realizedProfitUsd: ending.realizedProfitUsd,
      avgBoughtPriceUsd: averageBuy, avgSoldPriceUsd: averageSell,
      avgBoughtMcapUsd: averageBuy && activity.token.marketCapSupply ? journalDecimalMultiply(averageBuy, activity.token.marketCapSupply) : null,
      avgSoldMcapUsd: averageSell && activity.token.marketCapSupply ? journalDecimalMultiply(averageSell, activity.token.marketCapSupply) : null,
      remainingTokenAmount: ending.remainingTokenAmount, remainingCostBasisUsd: ending.remainingCostBasisUsd,
      status: ending.state, buyCount: trades.filter(trade => trade.side === 'buy').length, sellCount: trades.filter(trade => trade.side === 'sell').length,
      firstTradeAt: ordered[0]?.timestamp ?? null, lastTradeAt: ordered.at(-1)?.timestamp ?? null }, replayAccounting: accounting,
    realizedAccounting: { version: 1, source: input.source === 'node' ? 'onchain' : 'gmgn',
      policy: input.source === 'node' ? 'onchain_net_trade_profit_v1' : 'gmgn_realized_profit_v1', walletAddress: wallet, tokenAddress: token,
      status: complete ? 'ready' : recoverable ? 'pending' : 'unavailable', checkedAt, realizedProfitUsd: complete ? ending.realizedProfitUsd : null,
      coverage: { transactionsComplete: input.coverageComplete, balanceMatched: accounting.coverage.balanceMatched,
        reason: accounting.coverage.reason, balanceProof: input.proof, historyFingerprint: accounting.history!.fingerprint },
      position: { status: ending.state === 'closed' ? 'closed' : 'open', estimatedProfitUsd: complete ? ending.estimatedProfitUsd : null,
        estimatedRoi: complete ? ending.roi : null, unrealizedProfitUsd: ending.unrealizedProfitUsd,
        remainingTokenAmount: ending.remainingTokenAmount ?? input.proof.balance, remainingCostBasisUsd: ending.remainingCostBasisUsd,
        feeInclusiveCostUsd: ending.feeInclusiveCapitalUsd ?? '0', cashFlow: ending.investedUsd !== null && ending.soldUsd !== null && ending.transferOutIncomeUsd !== null ? {
          investedUsd: ending.investedUsd, soldUsd: ending.soldUsd, transferOutIncomeUsd: ending.transferOutIncomeUsd, feesUsd: ending.feesUsd } : undefined,
        priceUsd: input.quote?.priceUsd ?? null, pricedAt: input.quote?.timestamp ?? null, valuationSource: input.source === 'gmgn' ? 'gmgn' : 'market',
        ...(!complete ? { reason: accounting.coverage.reason, ...(recoverable ? { retryAfterMs: 1500 } : {}) } : {}) } }, generatedAt: checkedAt };
}
