import { describe, expect, it } from 'vitest';
import { calculateJournalLedger, calculateJournalLedgerPeriod, type JournalLedgerBaseline, type JournalLedgerEvent, type JournalLedgerInput, type JournalLedgerPeriodClosedBaseline } from './nodeAccountingLedger.js';

const wallet = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', otherWallet = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const token = '0x1111111111111111111111111111111111111111', otherToken = '0x2222222222222222222222222222222222222222';
const at = (hour: number) => new Date(Date.UTC(2026, 9, 19, hour)).toISOString();
const period = { from: at(0), to: at(24) };
function event(id: string, kind: JournalLedgerEvent['kind'], quantity: string, usd: string | null, hour: number, extra: Partial<JournalLedgerEvent> = {}): JournalLedgerEvent {
  return { id, walletAddress: wallet, tokenAddress: token, kind, tokenAmount: quantity, amountUsd: usd, feeUsd: '0', txHash: `tx-${id}`, timestamp: at(hour), ...extra };
}
function input(events: JournalLedgerEvent[], extra: Partial<JournalLedgerInput> = {}): JournalLedgerInput & { period: typeof period } {
  return { wallets: [wallet], events, valuations: [], coverage: [{ walletAddress: wallet, tokenAddress: token, complete: true }], asOf: period.to, period, ...extra };
}
function baseline(extra: Partial<JournalLedgerBaseline> = {}): JournalLedgerBaseline {
  return { walletAddress: wallet, tokenAddress: token, investedUsd: '100', soldUsd: '1000', incomingTransferCostUsd: '0', transferOutIncomeUsd: '0',
    realizedProfitUsd: '900', feesUsd: '2', feeInclusiveCapitalUsd: '102', lots: [{ tokenAmount: '10', costBasisUsd: '102' }], ...extra };
}
function closedBaseline(): JournalLedgerPeriodClosedBaseline {
  return { walletAddress: wallet, tokenAddress: token, scope: 'lifetime', checkpointTimestamp: at(5), checkpointBlock: '100', checkpointHash: `0x${'a'.repeat(64)}`,
    balance: '0', verified: true, historyComplete: true, historyFingerprint: 'f'.repeat(64),
    baseline: baseline({ investedUsd: '80', soldUsd: '60', incomingTransferCostUsd: '20', transferOutIncomeUsd: '90', realizedProfitUsd: '40',
      feesUsd: '10', feeInclusiveCapitalUsd: '103', lots: [] }),
    events: [event('historic-in', 'transfer_in', '2', '20', 1, { feeUsd: null }), event('historic-buy', 'buy', '8', '80', 2, { feeUsd: null }),
      event('historic-sale', 'sell', '4', '60', 3, { feeUsd: null }), event('historic-out', 'transfer_out', '6', '90', 4, { feeUsd: null })] };
}

describe('dated realized results from the shared full-history FIFO', () => {
  it('uses purchases before the window and recognizes their allocated acquisition fee only when sold', () => {
    const result = calculateJournalLedgerPeriod(input([event('buy', 'buy', '10', '100', -48, { feeUsd: '2' }), event('sell', 'sell', '4', '70', 1, { feeUsd: '1' })]));
    expect(result.complete).toBe(true);
    expect(result.totals).toMatchObject({ realizedProfitUsd: '28.2', valuedSellCount: 1, excludedSellCount: 0 });
  });
  it('excludes older realized gains while retaining remaining historical purchase lots', () => {
    const result = calculateJournalLedgerPeriod(input([event('buy', 'buy', '10', '100', -48), event('old-sale', 'sell', '4', '100', -25), event('sale', 'sell', '2', '50', 1)]));
    expect(result.totals.realizedProfitUsd).toBe('30');
  });
  it('excludes a baseline lifetime profit, proceeds and aggregate fees from the dated change', () => {
    const result = calculateJournalLedgerPeriod(input([event('sale', 'sell', '5', '80', 1, { feeUsd: '1' })], { baselines: [baseline()] }));
    expect(result.totals.realizedProfitUsd).toBe('28');
  });
  it('does not require an opaque baseline lifetime realized split when surviving FIFO costs are known', () => {
    const result = calculateJournalLedgerPeriod(input([event('sale', 'sell', '5', '80', 1)], { baselines: [baseline({ realizedProfitUsd: null })] }));
    expect(result.totals.realizedProfitUsd).toBe('29');
  });
  it('keeps unknown baseline acquisition fee allocation unavailable', () => {
    const result = calculateJournalLedgerPeriod(input([event('sale', 'sell', '5', '80', 1)], { baselines: [baseline({ feesUsd: null })] }));
    expect(result.complete).toBe(false); expect(result.totals.realizedProfitUsd).toBeNull(); expect(result.reasons).toContain('fees_incomplete');
  });
  it('marks an external transfer out at its receipt valuation and allocates its FIFO cost and fees', () => {
    const result = calculateJournalLedgerPeriod(input([event('buy', 'buy', '10', '100', -48, { feeUsd: '2' }),
      event('out', 'transfer_out', '2', '40', 2, { feeUsd: '0.5', counterparty: otherWallet })]));
    expect(result.totals).toMatchObject({ realizedProfitUsd: '19.1', valuedSellCount: 0, valuedTransferOutCount: 1 });
  });
  it('uses external incoming transfer receipt cost rather than zero purchase cost', () => {
    const result = calculateJournalLedgerPeriod(input([event('in', 'transfer_in', '5', '50', -24, { feeUsd: '1' }), event('sale', 'sell', '2', '30', 2)]));
    expect(result.totals.realizedProfitUsd).toBe('9.6');
  });
  it('does not charge a new unsold acquisition to realized profit', () => {
    const result = calculateJournalLedgerPeriod(input([event('buy', 'buy', '10', '100', 1, { feeUsd: '2' })]));
    expect(result.totals.realizedProfitUsd).toBe('0');
  });
  it('ignores current price movement and does not require a quote to calculate realized profit', () => {
    const events = [event('buy', 'buy', '10', '100', -48), event('sell', 'sell', '4', '70', 1)];
    const first = calculateJournalLedger(input(events, { valuations: [{ tokenAddress: token, priceUsd: '1000', pricedAt: period.to, balances: [{ walletAddress: wallet, tokenAmount: '6' }] }] }));
    const second = calculateJournalLedgerPeriod(input(events));
    expect(first.period?.totals.realizedProfitUsd).toBe('30'); expect(second.totals.realizedProfitUsd).toBe('30');
  });
  it('does not turn unknown opening holdings into zero-cost realized gains', () => {
    const result = calculateJournalLedgerPeriod(input([event('sell', 'sell', '1', '50', 1)], { openingBalances: [{ walletAddress: wallet, tokenAddress: token, tokenAmount: '2' }] }));
    expect(result.totals.realizedProfitUsd).toBeNull(); expect(result.totals.excludedSellCount).toBe(1); expect(result.reasons).toContain('purchase_cost_unknown');
  });
  it('leaves a disposal unavailable when its acquisition fee or its own fee is unknown', () => {
    for (const unknown of ['buy', 'sell']) {
      const result = calculateJournalLedgerPeriod(input([event('buy', 'buy', '2', '10', -2, { feeUsd: unknown === 'buy' ? null : '0' }), event('sell', 'sell', '1', '10', 1, { feeUsd: unknown === 'sell' ? null : '0' })]));
      expect(result.totals.realizedProfitUsd).toBeNull(); expect(result.reasons).toContain('fees_incomplete');
    }
  });
  it('retains available contributions while excluding an unknown sale without making a partial total complete', () => {
    const result = calculateJournalLedgerPeriod(input([event('buy', 'buy', '2', '10', -2), event('known', 'sell', '1', '10', 1), event('unknown', 'sell', '1', null, 2)]));
    expect(result.totals).toMatchObject({ realizedProfitUsd: null, knownRealizedProfitUsd: '5', valuedSellCount: 1, excludedSellCount: 1 });
  });
  it('includes all movements at the inclusive boundary while preserving an independently known execution order', () => {
    const result = calculateJournalLedgerPeriod(input([event('buy', 'buy', '2', '10', 0, { blockNumber: '100', transactionIndex: 1 }),
      event('sell', 'sell', '1', '10', 0, { blockNumber: '100', transactionIndex: 2 })]));
    expect(result.totals.realizedProfitUsd).toBe('5'); expect(result.totals.valuedSellCount).toBe(1);
  });
  it('does not invent an order for mixed acquisitions and disposals in the same second', () => {
    const result = calculateJournalLedgerPeriod(input([event('buy', 'buy', '2', '10', 0), event('sell', 'sell', '1', '10', 0)]));
    expect(result.totals.realizedProfitUsd).toBeNull(); expect(result.reasons).toContain('execution_order_unknown');
  });
  it('treats equivalent timestamp spellings as the same atomic boundary group', () => {
    const result = calculateJournalLedgerPeriod(input([event('buy', 'buy', '2', '10', 0, { timestamp: '2026-10-19T00:00:00Z' }),
      event('sell', 'sell', '1', '10', 0, { timestamp: '2026-10-19T02:00:00+02:00' })]));
    expect(result.totals.realizedProfitUsd).toBeNull(); expect(result.reasons).toContain('execution_order_unknown');
  });
  it('preserves internal Portfolio lots without transfer profits and counts their wallet-paid fees once', () => {
    const result = calculateJournalLedgerPeriod(input([event('buy', 'buy', '10', '100', -48),
      event('out', 'transfer_out', '2', '1000', 1, { txHash: 'move', counterparty: otherWallet, feeUsd: '1', transferId: 'move' }),
      event('in', 'transfer_in', '2', '1000', 1, { walletAddress: otherWallet, txHash: 'move', counterparty: wallet, feeUsd: '0', transferId: 'move' }),
      event('sell', 'sell', '1', '30', 2, { walletAddress: otherWallet })], { wallets: [wallet, otherWallet], coverage: [wallet, otherWallet].map(walletAddress => ({ walletAddress, tokenAddress: token, complete: true })) }));
    expect(result.totals).toMatchObject({ realizedProfitUsd: '19', valuedSellCount: 1, valuedTransferOutCount: 0 });
  });
  it('allocates shared execution fees once across tokens and keeps individual smart-account operation fees distinct', () => {
    const result = calculateJournalLedgerPeriod(input([event('buy-a', 'buy', '1', '10', -2), event('buy-b', 'buy', '1', '10', -2, { tokenAddress: otherToken }),
      event('sell-a', 'sell', '1', '20', 1, { txHash: 'bundle', feeId: 'op-one', feeUsd: '1' }),
      event('sell-b', 'sell', '1', '20', 1, { tokenAddress: otherToken, txHash: 'bundle', feeId: 'op-one', feeUsd: '1' })],
    { coverage: [token, otherToken].map(tokenAddress => ({ walletAddress: wallet, tokenAddress, complete: true })) }));
    expect(result.totals.realizedProfitUsd).toBe('19');
  });
  it('includes authenticated fee-only failed executions once and never charges an entire bundler fee', () => {
    const fee = { id: 'failed-op', walletAddress: wallet, txHash: 'bundle', feeId: 'failed-one', timestamp: at(3), feeUsd: '0.25' };
    const result = calculateJournalLedgerPeriod(input([], { periodFeeEvents: [fee, fee, { ...fee, id: 'failed-two', feeId: 'failed-two', feeUsd: '0.1' }] }));
    expect(result.totals).toMatchObject({ realizedProfitUsd: '-0.35', feeOnlyFeesUsd: '0.35', valuedFeeCount: 2, excludedFeeCount: 0 });
  });
  it('deduplicates fee-only evidence against normal movement fee identities', () => {
    const result = calculateJournalLedgerPeriod(input([event('buy', 'buy', '1', '10', -2), event('sell', 'sell', '1', '20', 1, { txHash: 'sale', feeId: 'op', feeUsd: '1' })],
      { periodFeeEvents: [{ id: 'same-fee', walletAddress: wallet, txHash: 'sale', feeId: 'op', timestamp: at(1), feeUsd: '1' }] }));
    expect(result.totals).toMatchObject({ realizedProfitUsd: '9', feeOnlyFeesUsd: '0', valuedFeeCount: 0 });
  });
  it('leaves fee-only unknown or contradictory costs explicit', () => {
    const fee = { id: 'fee', walletAddress: wallet, txHash: 'failure', timestamp: at(3), feeUsd: null };
    const unknown = calculateJournalLedgerPeriod(input([], { periodFeeEvents: [fee] }));
    expect(unknown.totals.realizedProfitUsd).toBeNull(); expect(unknown.reasons).toContain('fees_incomplete');
    const contradictory = calculateJournalLedgerPeriod(input([], { periodFeeEvents: [{ ...fee, feeUsd: '1' }, { ...fee, feeUsd: '2' }] }));
    expect(contradictory.totals.realizedProfitUsd).toBeNull(); expect(contradictory.reasons).toContain('contradictory_fee');
  });
  it('keeps incomplete evidence and contradictory confirmed balances unavailable', () => {
    const events = [event('buy', 'buy', '1', '10', -2), event('sell', 'sell', '1', '20', 1)];
    const gap = calculateJournalLedgerPeriod(input(events, { coverage: [{ walletAddress: wallet, tokenAddress: token, complete: false, reason: 'collection_incomplete' }] }));
    expect(gap.totals.realizedProfitUsd).toBeNull(); expect(gap.reasons).toContain('collection_incomplete');
    const balance = calculateJournalLedgerPeriod(input(events, { valuations: [{ tokenAddress: token, priceUsd: null, pricedAt: at(24), balances: [{ walletAddress: wallet, tokenAmount: '1' }] }] }));
    expect(balance.totals.realizedProfitUsd).toBeNull(); expect(balance.reasons).toContain('balance_unreconciled');
  });
  it('preserves exact fractional FIFO allocation and rejects invalid windows', () => {
    const result = calculateJournalLedgerPeriod(input([event('buy', 'buy', '3', '1', -2), event('sale-1', 'sell', '1', '1', 1), event('sale-2', 'sell', '1', '1', 2), event('sale-3', 'sell', '1', '1', 3)]));
    expect(result.totals.realizedProfitUsd).toBe('2');
    expect(() => calculateJournalLedgerPeriod(input([], { period: { from: at(25), to: at(24) } }))).toThrow('invalid_ledger_period');
  });
  it('keeps closure and reopening independent of prior realized results', () => {
    const result = calculateJournalLedgerPeriod(input([event('old-buy', 'buy', '1', '10', -48), event('old-sale', 'sell', '1', '40', -25),
      event('new-buy', 'buy', '2', '10', -1), event('new-sale', 'sell', '1', '10', 1)]));
    expect(result.totals.realizedProfitUsd).toBe('5');
  });
  it('lets a new ordered cycle realize profit after an older ambiguous FIFO group was fully closed', () => {
    const rows = [event('old-buy-a', 'buy', '1', '10', -48), event('old-buy-b', 'buy', '1', '20', -48),
      event('old-close', 'sell', '2', '60', -25), event('new-buy', 'buy', '2', '10', 1, { blockNumber: '200', transactionIndex: 0 }),
      event('new-sale', 'sell', '1', '10', 2, { blockNumber: '201', transactionIndex: 0 })];
    const result = calculateJournalLedger(input(rows));
    expect(result.period?.complete).toBe(true); expect(result.period?.totals.realizedProfitUsd).toBe('5');
    expect(result.period?.totals.excludedSellCount).toBe(0);
    expect(result.reasons, 'Lifetime uncertainty is retained independently of the new period cycle').toContain('execution_order_unknown');
  });
  it('does not reset ambiguous order while any affected FIFO holdings survive into a new timestamp', () => {
    const result = calculateJournalLedgerPeriod(input([event('old-buy-a', 'buy', '1', '10', -48), event('old-buy-b', 'buy', '1', '20', -48),
      event('old-partial', 'sell', '1', '30', -25), event('new-buy', 'buy', '2', '10', 1, { blockNumber: '200', transactionIndex: 0 }),
      event('new-sale', 'sell', '1', '40', 2, { blockNumber: '201', transactionIndex: 0 })]));
    expect(result.complete).toBe(false); expect(result.totals.realizedProfitUsd).toBeNull(); expect(result.reasons).toContain('execution_order_unknown');
  });
  it('keeps an affected sale inside the requested period excluded even after its cycle closes and another reopens', () => {
    const result = calculateJournalLedgerPeriod(input([event('buy-a', 'buy', '1', '10', 0), event('buy-b', 'buy', '1', '20', 0),
      event('close', 'sell', '2', '60', 1), event('new-buy', 'buy', '2', '10', 2, { blockNumber: '200', transactionIndex: 0 }),
      event('new-sale', 'sell', '1', '10', 3, { blockNumber: '201', transactionIndex: 0 })]));
    expect(result.complete).toBe(false); expect(result.totals.realizedProfitUsd).toBeNull();
    expect(result.totals).toMatchObject({ knownRealizedProfitUsd: '5', valuedSellCount: 1, excludedSellCount: 1 });
    expect(result.reasons).toContain('execution_order_unknown');
  });
  it('does not count a missing marked outgoing value or an unproved FIFO lot as a zero-profit result', () => {
    const result = calculateJournalLedgerPeriod(input([event('buy', 'buy', '1', '10', -2), event('out', 'transfer_out', '1', null, 1)]));
    expect(result.totals).toMatchObject({ realizedProfitUsd: null, valuedTransferOutCount: 0, excludedTransferOutCount: 1 });
    expect(result.reasons).toContain('outgoing_transfer_value_unknown');
  });
  it('rejects contradictory movement/fee-only operation evidence and excludes other accounts fees', () => {
    const rows = [event('buy', 'buy', '1', '10', -2), event('sell', 'sell', '1', '20', 1, { txHash: 'sale', feeId: 'operation', feeUsd: '1' })];
    const result = calculateJournalLedgerPeriod(input(rows, { periodFeeEvents: [
      { id: 'conflict', walletAddress: wallet, txHash: 'different-sale', feeId: 'operation', timestamp: at(1), feeUsd: '1' },
      { id: 'other-account', walletAddress: otherWallet, txHash: 'other', timestamp: at(2), feeUsd: '100' },
    ] }));
    expect(result.totals.realizedProfitUsd).toBeNull(); expect(result.totals.knownRealizedProfitUsd).toBe('9');
    expect(result.reasons).toContain('contradictory_fee');
  });
  it('does not change existing lifetime outputs when a period result is requested', () => {
    const plain = input([event('buy', 'buy', '10', '100', -48, { feeUsd: '2' }), event('sell', 'sell', '4', '70', 1, { feeUsd: '1' })],
      { valuations: [{ tokenAddress: token, priceUsd: '3', pricedAt: at(24), balances: [{ walletAddress: wallet, tokenAmount: '6' }] }], timeline: true });
    const withPeriod = calculateJournalLedger(plain), withoutPeriod = calculateJournalLedger({ ...plain, period: undefined });
    const { period: _period, ...lifetime } = withPeriod;
    expect(lifetime).toEqual(withoutPeriod);
  });
  it('does not call an observed FIFO gain known when older opening holdings or movements are unproved', () => {
    for (const reason of ['opening_balance_unavailable', 'history_incomplete']) {
      const result = calculateJournalLedgerPeriod(input([event('buy', 'buy', '2', '10', -2), event('sale', 'sell', '1', '10', 1)],
        { coverage: [{ walletAddress: wallet, tokenAddress: token, complete: false, quantitiesComplete: false, reason }] }));
      expect(result.totals).toMatchObject({ realizedProfitUsd: null, knownRealizedProfitUsd: '0', valuedSellCount: 0, excludedSellCount: 1 });
      expect(result.reasons).toContain(reason);
    }
  });
  it('removes a position subtotal when confirmed holdings contradict its reconstructed lots', () => {
    const result = calculateJournalLedgerPeriod(input([event('buy', 'buy', '2', '10', -2), event('sale', 'sell', '1', '10', 1)],
      { valuations: [{ tokenAddress: token, priceUsd: null, pricedAt: at(24), balances: [{ walletAddress: wallet, tokenAmount: '3' }] }] }));
    expect(result.totals).toMatchObject({ realizedProfitUsd: null, knownRealizedProfitUsd: '0', valuedSellCount: 0, excludedSellCount: 1 });
    expect(result.reasons).toContain('balance_unreconciled');
  });
  it('keeps independently covered positions and authenticated failed fees when another position lacks quantity coverage', () => {
    const result = calculateJournalLedgerPeriod(input([event('buy-known', 'buy', '2', '10', -2), event('sale-known', 'sell', '1', '10', 1),
      event('buy-unknown', 'buy', '2', '10', -2, { tokenAddress: otherToken }), event('sale-unknown', 'sell', '1', '1000', 1, { tokenAddress: otherToken }),
      event('out-unknown', 'transfer_out', '1', '2000', 2, { tokenAddress: otherToken })],
    { coverage: [{ walletAddress: wallet, tokenAddress: token, complete: true }, { walletAddress: wallet, tokenAddress: otherToken, complete: false, reason: 'history_incomplete' }],
      periodFeeEvents: [{ id: 'failed', walletAddress: wallet, txHash: 'failed', timestamp: at(3), feeUsd: '0.1' }] }));
    expect(result.totals).toMatchObject({ realizedProfitUsd: null, knownRealizedProfitUsd: '4.9', valuedSellCount: 1, excludedSellCount: 1,
      valuedTransferOutCount: 0, excludedTransferOutCount: 1, feeOnlyFeesUsd: '0.1' });
    expect(result.positions.find(row => row.tokenAddress === token)?.knownRealizedProfitUsd).toBe('5');
    expect(result.positions.find(row => row.tokenAddress === otherToken)?.knownRealizedProfitUsd).toBe('0');
  });
  it('does not call the first retained contradictory movement or fee variant a known gain', () => {
    const buy = event('buy', 'buy', '2', '10', -2), sale = event('sale', 'sell', '1', '10', 1);
    const duplicate = calculateJournalLedgerPeriod(input([buy, sale, { ...sale, amountUsd: '1000' }]));
    expect(duplicate.totals).toMatchObject({ realizedProfitUsd: null, knownRealizedProfitUsd: '0', valuedSellCount: 0, excludedSellCount: 1 });
    expect(duplicate.reasons).toContain('contradictory_event');
    const contradictoryFees = calculateJournalLedgerPeriod(input([buy,
      { ...sale, feeId: 'same-operation', feeUsd: '1' }, event('sale-two', 'sell', '1', '10', 2, { feeId: 'same-operation', feeUsd: '2' })]));
    expect(contradictoryFees.totals).toMatchObject({ realizedProfitUsd: null, knownRealizedProfitUsd: '0', valuedSellCount: 0, excludedSellCount: 2 });
    expect(contradictoryFees.reasons).toContain('contradictory_fee');
  });
  it('recognizes one verified whole closed lifetime inside the period without assigning its aggregate fees to movement rows', () => {
    const contribution = closedBaseline(), result = calculateJournalLedgerPeriod(input([], { periodClosedBaselines: [contribution] }));
    expect(result.complete).toBe(true);
    expect(result.totals).toMatchObject({ realizedProfitUsd: '40', knownRealizedProfitUsd: '40', closedBaselineFeesUsd: '10',
      valuedSellCount: 1, valuedTransferOutCount: 1, feeOnlyFeesUsd: '0' });
    expect(contribution.events.every(row => row.feeUsd === null), 'No unknown historical fee was distributed or rewritten').toBe(true);
  });
  it('rejects an open, partial, outside-window or financially incomplete aggregate history', () => {
    const original = closedBaseline();
    const invalid = [
      { ...original, balance: '1' },
      { ...original, baseline: { ...original.baseline, lots: [{ tokenAmount: '1', costBasisUsd: '10' }] } },
      { ...original, historyComplete: false },
      { ...original, events: [{ ...original.events[0], timestamp: at(-1) }, ...original.events.slice(1)] },
      { ...original, baseline: { ...original.baseline, feesUsd: null } },
      { ...original, baseline: { ...original.baseline, realizedProfitUsd: '999' } },
      { ...original, baseline: { ...original.baseline, investedUsd: '180', realizedProfitUsd: '-60', feeInclusiveCapitalUsd: '203' } },
    ];
    for (const contribution of invalid) {
      const result = calculateJournalLedgerPeriod(input([], { periodClosedBaselines: [contribution as JournalLedgerPeriodClosedBaseline] }));
      expect(result.totals.realizedProfitUsd).toBeNull(); expect(result.totals.knownRealizedProfitUsd).toBe('0');
      expect(result.reasons).toContain('historical_fee_allocation_unknown');
    }
  });
  it('counts a repeated verified aggregate and its covered fee identities only once', () => {
    const contribution = closedBaseline(), historicalFee = contribution.events[1];
    const result = calculateJournalLedgerPeriod(input([], { periodClosedBaselines: [contribution, contribution], periodFeeEvents: [
      { id: 'covered-fee', walletAddress: wallet, txHash: historicalFee.txHash, timestamp: historicalFee.timestamp, feeUsd: '5' },
      { id: 'independent-failed-fee', walletAddress: wallet, txHash: 'failed', timestamp: at(6), feeUsd: '0.25' },
    ] }));
    expect(result.totals).toMatchObject({ realizedProfitUsd: '39.75', closedBaselineFeesUsd: '10', valuedSellCount: 1, valuedTransferOutCount: 1,
      feeOnlyFeesUsd: '0.25', valuedFeeCount: 1 });
  });
  it('rejects aggregate overlap with normal historical movements or another ordinary cumulative baseline', () => {
    const contribution = closedBaseline();
    for (const extra of [{ events: contribution.events }, { baselines: [contribution.baseline] }]) {
      const result = calculateJournalLedgerPeriod(input(extra.events ?? [], { ...extra, periodClosedBaselines: [contribution] }));
      expect(result.totals.realizedProfitUsd).toBeNull(); expect(result.totals.knownRealizedProfitUsd).toBe('0');
      expect(result.reasons).toContain('historical_fee_allocation_unknown');
    }
  });
  it('continues a fresh FIFO after a proved closed baseline, including block-ordered same-second reopening', () => {
    const contribution = closedBaseline(), result = calculateJournalLedgerPeriod(input([
      event('new-buy', 'buy', '2', '10', 5, { feeUsd: '1', blockNumber: '101', transactionIndex: 0 }),
      event('new-sale', 'sell', '1', '10', 6, { feeUsd: '0.5', blockNumber: '102', transactionIndex: 0 }),
    ], { periodClosedBaselines: [contribution] }));
    expect(result.complete).toBe(true);
    expect(result.totals).toMatchObject({ realizedProfitUsd: '44', closedBaselineFeesUsd: '10', valuedSellCount: 2, valuedTransferOutCount: 1 });
    const unknownOrder = calculateJournalLedgerPeriod(input([event('new-buy', 'buy', '1', '10', 5)], { periodClosedBaselines: [contribution] }));
    expect(unknownOrder.totals.realizedProfitUsd).toBeNull();
  });
  it('permits only the established bounded provider rounding between retained movements and the verified closed aggregate', () => {
    const contribution = closedBaseline();
    contribution.events[1].amountUsd = '79.99999999999998';
    expect(calculateJournalLedgerPeriod(input([], { periodClosedBaselines: [contribution] })).totals.realizedProfitUsd).toBe('40');
    contribution.events[1].amountUsd = '79';
    expect(calculateJournalLedgerPeriod(input([], { periodClosedBaselines: [contribution] })).totals.realizedProfitUsd).toBeNull();
  });
  it('leaves lifetime outputs and earlier timeline frames untouched by the internal dated aggregate contribution', () => {
    const contribution = closedBaseline(), normal = input([], { timeline: true });
    const withContribution = calculateJournalLedger({ ...normal, periodClosedBaselines: [contribution] });
    const without = calculateJournalLedger(normal);
    expect(withContribution.positions).toEqual(without.positions); expect(withContribution.timeline).toEqual(without.timeline);
    expect(withContribution.totals).toEqual(without.totals);
    expect(withContribution.period?.totals.realizedProfitUsd).toBe('40');
  });
  it('does not apply individual-wallet marked transfer aggregates to consolidated Portfolio accounting', () => {
    const contribution = closedBaseline();
    const result = calculateJournalLedgerPeriod(input([], { wallets: [wallet, otherWallet], periodClosedBaselines: [contribution],
      coverage: [wallet, otherWallet].map(walletAddress => ({ walletAddress, tokenAddress: token, complete: true })) }));
    expect(result.totals.realizedProfitUsd).toBeNull(); expect(result.reasons).toContain('historical_fee_allocation_unknown');
  });
  it('deduplicates authenticated EOA gas across imported and node identities without merging smart-account operation fees', () => {
    const contribution = closedBaseline(), movement = contribution.events[1];
    movement.feeId = `gmgn:${movement.txHash}`;
    const eoa = { id: 'node-execution', walletAddress: wallet, txHash: movement.txHash, feeId: 'node-execution', timestamp: movement.timestamp, feeUsd: '1', transactionScoped: true };
    const result = calculateJournalLedgerPeriod(input([], { periodClosedBaselines: [contribution], periodFeeEvents: [eoa] }));
    expect(result.totals).toMatchObject({ realizedProfitUsd: '40', feeOnlyFeesUsd: '0', valuedFeeCount: 0 });
    const operation = calculateJournalLedgerPeriod(input([], { periodClosedBaselines: [contribution], periodFeeEvents: [{ ...eoa, feeId: 'different-aa-operation', transactionScoped: false }] }));
    expect(operation.totals).toMatchObject({ realizedProfitUsd: '39', feeOnlyFeesUsd: '1', valuedFeeCount: 1 });
  });
  it('rejects known closed-movement fees that together exceed the verified entire aggregate fee', () => {
    const contribution = closedBaseline();
    const fees = contribution.events.slice(0, 2).map((row, index) => ({ id: `proved-${index}`, walletAddress: wallet, txHash: row.txHash,
      timestamp: row.timestamp, feeUsd: '6' }));
    const result = calculateJournalLedgerPeriod(input([], { periodClosedBaselines: [contribution], periodFeeEvents: fees }));
    expect(result.totals).toMatchObject({ realizedProfitUsd: null, knownRealizedProfitUsd: '0', valuedSellCount: 0, excludedSellCount: 1 });
    expect(result.reasons).toContain('contradictory_fee');
  });
});
