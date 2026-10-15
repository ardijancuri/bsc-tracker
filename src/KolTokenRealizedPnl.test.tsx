import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { KolTokenActivity } from '../shared/kolTokenTrades';
import { KolTokenRealizedPnlValue, tokenPnlStateAfterLoad } from './KolTokenRealizedPnl';
import { verifiedTokenRealizedPnl } from './kolTokenPnlRequest';

const date = '2026-10-14T12:00:00Z', wallet = '0x' + '1'.repeat(40), token = '0x' + '2'.repeat(40);
const activity = (value: string | null, lastTradeAt = date): KolTokenActivity => ({
  kol: { address: wallet, name: 'Trader', avatarUrl: null, twitter: null, source: 'node', lastSeenAt: date },
  token: { address: token, symbol: 'TEST', name: 'Test', logoUrl: null, priceUsd: '1', marketCapUsd: '1000', marketCapSupply: '1000' },
  trades: [], generatedAt: date, coverage: { source: 'indexed', complete: true, indexedTradeCount: 0, returnedTradeCount: 0, historyLimit: 2000, costsIncluded: false },
  summary: { realizedProfitUsd: '999', lastTradeAt, investedUsd: '0', soldUsd: '0', avgBoughtPriceUsd: null, avgSoldPriceUsd: null,
    avgBoughtMcapUsd: null, avgSoldMcapUsd: null, remainingTokenAmount: '0', remainingCostBasisUsd: '0', buyCount: 0, sellCount: 0,
    valuedBuyCount: 0, valuedSellCount: 0, excludedSellCount: 0, unpricedTradeCount: 0, firstTradeAt: date, status: 'closed', profitBasis: 'observed_fifo' },
  inventory: { version: 1, events: [], coverage: { complete: true, reconciled: true, checkedAt: date, balance: '0', fromBlock: '1', toBlock: '2', blockHash: '0x' + 'a'.repeat(64) } },
  realizedAccounting: { version: 1, source: 'gmgn', policy: 'gmgn_realized_profit_v1', walletAddress: wallet, tokenAddress: token,
    status: value === null ? 'unavailable' : 'ready', checkedAt: date, realizedProfitUsd: value,
    coverage: { transactionsComplete: true, balanceMatched: true, ...(value === null ? { reason: 'gmgn_realized_cost_unavailable' } : {}) } } });
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(Date.parse(date)); });
afterEach(() => { vi.useRealTimers(); });
describe('KOL token realized profit display', () => {
  it('ends the initial spinner after the bounded pass and keeps delayed retries explicit until a value is ready', () => {
    const body = activity(null); body.realizedAccounting!.status = 'pending';
    const waiting = tokenPnlStateAfterLoad(null, 'pair', { activity: body, status: 'pending' }, true);
    expect(waiting.busy).toBe(false); expect(waiting.delayed).toBe(true);
    const html = renderToStaticMarkup(<KolTokenRealizedPnlValue activity={waiting.activity} busy={waiting.busy} delayed={waiting.delayed} />);
    expect(html).toContain('Pending'); expect(html).toContain('Retrying automatically');
    expect(html).not.toContain('Loading GMGN realized'); expect(html).not.toContain('$999');
    const stillWaiting = tokenPnlStateAfterLoad(waiting, 'pair', { activity: body, status: 'pending' });
    expect(stillWaiting.busy).toBe(false); expect(stillWaiting.delayed).toBe(true);
    const ready = tokenPnlStateAfterLoad(stillWaiting, 'pair', { activity: activity('30'), status: 'ready' }, true);
    expect(ready.delayed).toBe(false); expect(ready.busy).toBe(false);
    expect(renderToStaticMarkup(<KolTokenRealizedPnlValue activity={ready.activity} busy={ready.busy} delayed={ready.delayed} />)).toContain('+$30');
  });

  it('shows a pending estimate instead of realized zero for a buy-only position with a missing current price', () => {
    const body = activity('0'); body.inventory!.coverage.balance = '10'; body.summary.status = 'open';
    body.realizedAccounting!.position = { status: 'open', estimatedProfitUsd: null, estimatedRoi: null, unrealizedProfitUsd: null,
      priceUsd: null, pricedAt: null, valuationSource: null, remainingTokenAmount: '10', remainingCostBasisUsd: '20', feeInclusiveCostUsd: '20',
      cashFlow: { investedUsd: '18', soldUsd: '0', transferOutIncomeUsd: '0', feesUsd: '2' }, reason: 'current_quote_unavailable', retryAfterMs: 3000 };
    const state = tokenPnlStateAfterLoad(null, 'pair', { activity: body, status: 'pending' }, true);
    const html = renderToStaticMarkup(<KolTokenRealizedPnlValue activity={state.activity} busy={state.busy} delayed={state.delayed} />);
    expect(html).toContain('Est. profit'); expect(html).toContain('Pending'); expect(html).not.toContain('$0');
    expect(html).toContain('Retrying automatically');
  });

  function historyFallback(value = '30') {
    const body = activity(value);
    body.inventory!.coverage = { ...body.inventory!.coverage, complete: false, reconciled: false, status: 'unavailable', reason: 'inventory_history_unavailable' };
    body.realizedAccounting!.coverage = { transactionsComplete: true, balanceMatched: true, verification: 'gmgn_history',
      historyFingerprint: 'b'.repeat(64), historyCheckedAt: date, lastMovementAt: date,
      balanceProof: { walletAddress: wallet, tokenAddress: token, chain: 'bsc', blockNumber: '1000', blockTimestamp: date,
        blockHash: '0x' + 'c'.repeat(64), checkedAt: date, balance: '0' } };
    return body;
  }

  it('retains the original valid fallback through a proof-free cooldown without refreshing any timestamp', () => {
    const original = historyFallback(), before = { pair: 'pair', activity: original, busy: false };
    const waiting = structuredClone(original);
    waiting.realizedAccounting!.status = 'pending'; waiting.realizedAccounting!.realizedProfitUsd = null;
    waiting.realizedAccounting!.coverage = { verification: 'gmgn_history', transactionsComplete: false, balanceMatched: false, reason: 'provider_rate_limited' };
    waiting.inventory!.coverage.toBlock = '3'; waiting.inventory!.coverage.blockHash = '0x' + 'f'.repeat(64);
    vi.advanceTimersByTime(20_000); waiting.realizedAccounting!.checkedAt = new Date(Date.now()).toISOString();
    const retained = tokenPnlStateAfterLoad(before, 'pair', { activity: waiting, status: 'pending' }, true);
    expect(retained.activity).toBe(original); expect(retained.activity?.realizedAccounting?.checkedAt).toBe(date);
    expect(retained.busy).toBe(false); expect(retained.delayed).toBe(true);
    expect(renderToStaticMarkup(<KolTokenRealizedPnlValue activity={retained.activity} busy={retained.busy} delayed={retained.delayed} />)).toContain('+$30');
    expect(tokenPnlStateAfterLoad(before, 'different-pair', { activity: waiting, status: 'pending' }, true).activity).toBe(waiting);
    vi.advanceTimersByTime(10_001);
    const expired = tokenPnlStateAfterLoad(retained, 'pair', { activity: waiting, status: 'pending' }, true);
    expect(expired.activity).toBe(waiting);
    expect(renderToStaticMarkup(<KolTokenRealizedPnlValue activity={expired.activity} busy={expired.busy} delayed={expired.delayed} />)).not.toContain('+$30');
  });

  it('labels provider-history closed profit as an estimate and describes current balance verification honestly', () => {
    const body = historyFallback(), state = tokenPnlStateAfterLoad(null, 'pair', { activity: body, status: 'ready' });
    expect(state.busy).toBe(false); expect(state.activity).toBe(body);
    const html = renderToStaticMarkup(<KolTokenRealizedPnlValue activity={state.activity} busy={state.busy} />);
    expect(html).toContain('Est. realized P&amp;L'); expect(html).toContain('+$30');
    expect(html).toContain('Estimated from GMGN history; current wallet balance checked. Historical movements are not chain-verified.');
  });

  it('shows provider-history open total as estimated profit without changing missing canonical coverage', () => {
    const body = historyFallback(); body.realizedAccounting!.coverage.balanceProof!.balance = '10';
    body.realizedAccounting!.position = { status: 'open', estimatedProfitUsd: '70', estimatedRoi: '3.5', unrealizedProfitUsd: '40',
      priceUsd: '5', pricedAt: date, valuationSource: 'market', remainingTokenAmount: '10', remainingCostBasisUsd: '10', feeInclusiveCostUsd: '20' };
    const html = renderToStaticMarkup(<KolTokenRealizedPnlValue activity={body} busy={false} />);
    expect(html).toContain('Est. profit'); expect(html).toContain('+$70'); expect(html).not.toContain('+$30');
    expect(html).toContain('Historical movements are not chain-verified'); expect(body.inventory!.coverage.complete).toBe(false);
  });

  it('keeps eligible fallback loading, but never retains a value when the history digest or current balance changes', () => {
    const previous = { pair: 'pair', activity: historyFallback(), busy: false };
    const waiting = historyFallback(); waiting.realizedAccounting!.status = 'pending'; waiting.realizedAccounting!.realizedProfitUsd = null;
    const retained = tokenPnlStateAfterLoad(previous, 'pair', { activity: waiting, status: 'pending' });
    expect(retained.activity).toBe(previous.activity); expect(retained.busy).toBe(true);
    waiting.realizedAccounting!.coverage.historyFingerprint = 'd'.repeat(64);
    const changed = tokenPnlStateAfterLoad(previous, 'pair', { activity: waiting, status: 'pending' });
    expect(changed.activity).toBe(waiting); expect(changed.busy).toBe(true);
    const html = renderToStaticMarkup(<KolTokenRealizedPnlValue activity={changed.activity} busy={changed.busy} />);
    expect(html).toContain('…'); expect(html).not.toContain('+$30');
    waiting.realizedAccounting!.coverage.historyFingerprint = previous.activity.realizedAccounting!.coverage.historyFingerprint;
    waiting.realizedAccounting!.coverage.balanceProof!.balance = '1';
    expect(tokenPnlStateAfterLoad(previous, 'pair', { activity: waiting, status: 'pending' }).activity).toBe(waiting);
  });

  it('shows estimated total profit for an open position and realized profit after it closes', () => {
    const body = activity('30');
    body.inventory!.coverage.balance = body.summary.remainingTokenAmount = '10'; body.summary.status = 'open';
    body.realizedAccounting!.position = { status: 'open', estimatedProfitUsd: '70', estimatedRoi: '3.5', unrealizedProfitUsd: '40',
      priceUsd: '5', pricedAt: date, valuationSource: 'market', remainingTokenAmount: '10', remainingCostBasisUsd: '10', feeInclusiveCostUsd: '20' };
    const open = renderToStaticMarkup(<KolTokenRealizedPnlValue activity={body} busy={false} />);
    expect(open).toContain('Est. profit'); expect(open).toContain('+$70'); expect(open).not.toContain('+$30');
    expect(open).toContain('Price as of 12:00:00 UTC.');
    const cashOnly = structuredClone(body); cashOnly.realizedAccounting!.realizedProfitUsd = null;
    cashOnly.realizedAccounting!.position!.remainingCostBasisUsd = null; cashOnly.realizedAccounting!.position!.unrealizedProfitUsd = null;
    cashOnly.realizedAccounting!.position!.cashFlow = { investedUsd: '18', soldUsd: '30', transferOutIncomeUsd: '10', feesUsd: '2' };
    const cashOnlyHtml = renderToStaticMarkup(<KolTokenRealizedPnlValue activity={cashOnly} busy={false} />);
    expect(cashOnlyHtml).toContain('Est. profit'); expect(cashOnlyHtml).toContain('+$70');
    body.realizedAccounting!.position.estimatedProfitUsd = null;
    const pending = renderToStaticMarkup(<KolTokenRealizedPnlValue activity={body} busy />);
    expect(pending).toContain('Realized P&amp;L'); expect(pending).toContain('+$30');
    expect(pending).not.toContain('Est. profit'); expect(pending).not.toContain('Price as of');
    body.inventory!.coverage.balance = '0'; body.realizedAccounting!.position.status = 'closed'; body.realizedAccounting!.position.remainingTokenAmount = '0';
    const closed = renderToStaticMarkup(<KolTokenRealizedPnlValue activity={body} busy={false} />);
    expect(closed).toContain('Realized P&amp;L'); expect(closed).toContain('+$30'); expect(closed).not.toContain('Est. profit');
    expect(closed).not.toContain('Price as of');
  });

  it.each(['missing', 'stale', 'rateLimited'] as const)('keeps verified realized gains visible with the correct label during a %s open-position quote', variant => {
    const body = activity('-12.5');
    body.inventory!.coverage.balance = '10'; body.summary.status = 'open';
    body.realizedAccounting!.position = { status: 'open', estimatedProfitUsd: variant === 'stale' ? '27.5' : null,
      estimatedRoi: null, unrealizedProfitUsd: null, priceUsd: variant === 'stale' ? '5' : null,
      pricedAt: variant === 'stale' ? new Date(Date.now() - 180_001).toISOString() : null,
      valuationSource: variant === 'stale' ? 'market' : null, remainingTokenAmount: '10', remainingCostBasisUsd: '10', feeInclusiveCostUsd: '20',
      ...(variant === 'rateLimited' ? { reason: 'quote_rate_limited', retryAfterMs: 60_000 } : {}) };
    const html = renderToStaticMarkup(<KolTokenRealizedPnlValue activity={body} busy />);
    expect(html).toContain('Realized P&amp;L'); expect(html).toContain('-$12.50'); expect(html).toContain('negative');
    expect(html).not.toContain('Est. profit'); expect(html).not.toContain('Price as of');
    const current = { pair: 'pair', activity: body, busy: false };
    expect(tokenPnlStateAfterLoad(current, 'pair', { activity: null, status: 'pending' }).activity).toBe(body);
    body.inventory!.coverage.complete = false;
    const incomplete = renderToStaticMarkup(<KolTokenRealizedPnlValue activity={body} busy />);
    expect(incomplete).not.toContain('-$12.50');
  });

  it('ends the busy state for a terminal inventory failure even if accounting was marked pending', () => {
    const body = activity(null);
    body.inventory!.coverage = { ...body.inventory!.coverage, status: 'unavailable', complete: false, reconciled: false, reason: 'inventory_balance_mismatch' };
    body.realizedAccounting!.status = 'pending';
    const state = tokenPnlStateAfterLoad(null, 'pair', { activity: body, status: 'pending' });
    expect(state.busy).toBe(false);
    const html = renderToStaticMarkup(<KolTokenRealizedPnlValue activity={state.activity} busy={state.busy} />);
    expect(html).toContain('—'); expect(html).not.toContain('…');
  });
  it('adopts fresh realized-only proof during a quote outage instead of retaining an expiring snapshot', () => {
    const previous = activity('20.47');
    previous.inventory!.coverage.balance = '10'; previous.summary.status = 'open';
    previous.realizedAccounting!.position = { status: 'open', estimatedProfitUsd: null, estimatedRoi: null, unrealizedProfitUsd: null,
      priceUsd: null, pricedAt: null, valuationSource: null, remainingTokenAmount: '10', remainingCostBasisUsd: '10', feeInclusiveCostUsd: '20',
      reason: 'quote_rate_limited', retryAfterMs: 60_000 };
    vi.advanceTimersByTime(179_000);
    const fresh = structuredClone(previous), checkedAt = new Date(Date.now()).toISOString();
    fresh.inventory!.coverage.checkedAt = checkedAt; fresh.realizedAccounting!.checkedAt = checkedAt;
    const state = tokenPnlStateAfterLoad({ pair: 'pair', activity: previous, busy: true }, 'pair', { activity: fresh, status: 'pending' });
    expect(state.activity).toBe(fresh);
    vi.advanceTimersByTime(2000);
    expect(verifiedTokenRealizedPnl(previous)).toBeNull();
    expect(verifiedTokenRealizedPnl(state.activity)).toBe(20.47);
    const retained = tokenPnlStateAfterLoad(state, 'pair', { activity: null, status: 'pending' });
    const html = renderToStaticMarkup(<KolTokenRealizedPnlValue activity={retained.activity} busy={retained.busy} />);
    expect(html).toContain('+$20.47'); expect(html).toContain('Realized P&amp;L'); expect(html).not.toContain('…');
  });

  it('shows pending verification as loading rather than falsely diagnosing missing purchase costs', () => {
    const html = renderToStaticMarkup(<KolTokenRealizedPnlValue activity={activity(null)} busy />);
    expect(html).toContain('aria-busy="true"'); expect(html).toContain('Loading GMGN realized'); expect(html).toContain('…');
    expect(html).not.toContain('purchase costs are missing');
    const missing = renderToStaticMarkup(<KolTokenRealizedPnlValue activity={activity(null)} busy={false} />);
    expect(missing).toContain('aria-busy="false"'); expect(missing).toContain('purchase costs or fees could not be verified'); expect(missing).toContain('—');
    expect(missing).not.toContain('$999');
  });
  it('preserves a verified value only for the same selection through a transient refresh', () => {
    const previous = { pair: 'wallet:token:last-trade', activity: activity('30'), busy: false };
    const pending = tokenPnlStateAfterLoad(previous, previous.pair, { activity: null, status: 'pending' });
    expect(pending.activity).toBe(previous.activity); expect(pending.busy).toBe(true);
    const html = renderToStaticMarkup(<KolTokenRealizedPnlValue activity={pending.activity} busy={pending.busy} />);
    expect(html).toContain('+$30'); expect(html).toContain('positive');
    expect(tokenPnlStateAfterLoad(previous, 'wallet:token:new-last-trade', { activity: null, status: 'pending' }).activity).toBeNull();
    expect(tokenPnlStateAfterLoad(previous, previous.pair, { activity: null, status: 'unavailable' }).activity).toBeNull();
    const changed = activity(null, '2026-10-14T12:01:00Z');
    expect(tokenPnlStateAfterLoad(previous, previous.pair, { activity: changed, status: 'pending' }).activity).toBe(changed);
    expect(verifiedTokenRealizedPnl(tokenPnlStateAfterLoad(previous, previous.pair, { activity: changed, status: 'pending' }).activity)).toBeNull();
  });
  it('keeps zero and losses visible instead of treating them as missing profit', () => {
    const zero = renderToStaticMarkup(<KolTokenRealizedPnlValue activity={activity('0')} busy={false} />);
    expect(zero).toContain('$0'); expect(zero).not.toContain('—');
    const loss = renderToStaticMarkup(<KolTokenRealizedPnlValue activity={activity('-81.5')} busy={false} />);
    expect(loss).toContain('-$81.50'); expect(loss).toContain('negative');
  });
  it('renders David’s GMGN total with transfer gains and fees rather than the unavailable FIFO total', () => {
    const body = activity('348.80'); body.summary.realizedProfitUsd = null;
    const html = renderToStaticMarkup(<KolTokenRealizedPnlValue activity={body} busy={false} />);
    expect(html).toContain('+$348.80'); expect(html).toContain('GMGN realized P&amp;L includes marked transfer-out gains and fees');
    expect(html).not.toContain('Gas fees are excluded');
    expect(html).not.toContain('Estimated from matched');
  });
  it('identifies matched-activity estimates while keeping the available GMGN value visible', () => {
    const body = activity('348.80'); body.realizedAccounting!.coverage.reason = 'gmgn_activity_estimate';
    const html = renderToStaticMarkup(<KolTokenRealizedPnlValue activity={body} busy={false} />);
    expect(html).toContain('+$348.80');
    expect(html).toContain('Estimated from matched GMGN activity; a reported position total is unavailable.');
    expect(html).toContain('marked transfer-out gains and fees');
  });
  it('retains terminal provider unavailability for its explanation without a FIFO substitution', () => {
    const missing = activity(null); missing.realizedAccounting!.coverage.reason = 'gmgn_position_not_found';
    const state = tokenPnlStateAfterLoad({ pair: 'pair', activity: activity('30'), busy: false }, 'pair', { activity: missing, status: 'unavailable' });
    expect(state.activity).toBe(missing);
    const html = renderToStaticMarkup(<KolTokenRealizedPnlValue activity={state.activity} busy={state.busy} />);
    expect(html).toContain('current API key'); expect(html).toContain('—'); expect(html).not.toContain('$999');
  });
  it('invalidates a retained total when transfer-only inventory changes despite an unchanged last trade', () => {
    const previous = { pair: 'pair', activity: activity('30'), busy: false };
    const changed = activity(null); changed.realizedAccounting!.status = 'pending';
    changed.inventory!.coverage.balance = '1';
    changed.inventory!.events.push({ id: 'in', kind: 'transfer_in', txHash: 'hash', timestamp: date, blockNumber: '3', transactionIndex: 0,
      logIndex: 1, tokenAmount: '1', remainingTokenAmount: '1', remainingCostBasisUsd: null, cumulativeRealizedProfitUsd: null, investedUsd: '0', soldUsd: '0' });
    const state = tokenPnlStateAfterLoad(previous, 'pair', { activity: changed, status: 'pending' });
    expect(state.activity).toBe(changed); expect(verifiedTokenRealizedPnl(state.activity)).toBeNull();
  });
  it('preserves same-movement pending data but drops a stale proof or corrected valuation', () => {
    const previous = { pair: 'pair', activity: activity('30'), busy: false }, unchanged = activity(null);
    unchanged.realizedAccounting!.status = 'pending';
    expect(tokenPnlStateAfterLoad(previous, 'pair', { activity: unchanged, status: 'pending' }).activity).toBe(previous.activity);
    unchanged.inventory!.coverage.initialBalanceSource = 'derived_complete_movements';
    expect(tokenPnlStateAfterLoad(previous, 'pair', { activity: unchanged, status: 'pending' }).activity).toBe(unchanged);
    vi.advanceTimersByTime(180_001);
    expect(tokenPnlStateAfterLoad(previous, 'pair', { activity: null, status: 'pending' }).activity).toBeNull();
  });
  it.each(['quoteTokenAddress', 'priceUsd', 'source', 'txHash', 'blockNumber', 'transactionIndex'] as const)
    ('does not retain an earlier fee proof after a %s correction', field => {
      const original = activity('30'), changed = activity(null); changed.realizedAccounting!.status = 'pending';
      const trade = { id: 'buy', side: 'buy', tokenAmount: '1', amountUsd: '1', quoteAmount: '1', quoteSymbol: 'BNB',
        quoteTokenAddress: '0x' + '0'.repeat(40), priceUsd: '1', source: 'node', txHash: 'hash', timestamp: date,
        blockNumber: '1', transactionIndex: 0, valuationStatus: 'valued' } as KolTokenActivity['trades'][number];
      original.trades = [trade]; changed.trades = [{ ...trade, [field]: field === 'transactionIndex' ? 1 : 'changed' }];
      expect(tokenPnlStateAfterLoad({ pair: 'pair', activity: original, busy: false }, 'pair', { activity: changed, status: 'pending' }).activity).toBe(changed);
    });
});
