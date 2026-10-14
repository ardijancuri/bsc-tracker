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
  it('shows pending verification as loading rather than falsely diagnosing missing purchase costs', () => {
    const html = renderToStaticMarkup(<KolTokenRealizedPnlValue activity={activity(null)} busy />);
    expect(html).toContain('aria-busy="true"'); expect(html).toContain('Loading GMGN realized'); expect(html).toContain('…');
    expect(html).not.toContain('purchase costs are missing');
    const missing = renderToStaticMarkup(<KolTokenRealizedPnlValue activity={activity(null)} busy={false} />);
    expect(missing).toContain('aria-busy="false"'); expect(missing).toContain('transfer costs or fee data are missing'); expect(missing).toContain('—');
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
