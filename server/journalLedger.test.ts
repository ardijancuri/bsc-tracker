import { describe, expect, it } from 'vitest';
import { calculateJournalLedger, type JournalLedgerEvent } from './journalLedger.js';
const a = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', b = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', c = '0xcccccccccccccccccccccccccccccccccccccccc';
const token = '0x1111111111111111111111111111111111111111', other = '0x2222222222222222222222222222222222222222';
const at = (second: number) => new Date(Date.UTC(2026, 9, 18, 0, 0, second)).toISOString();
function event(id: string, kind: JournalLedgerEvent['kind'], quantity: string, usd: string | null, options: Partial<JournalLedgerEvent> = {}): JournalLedgerEvent {
  return { id, kind, tokenAmount: quantity, amountUsd: usd, tokenAddress: token, walletAddress: a, timestamp: at(Number(id.replace(/\D/g, '')) || 1), txHash: `tx${id}`, feeUsd: '0', ...options };
}
function calculate(events: JournalLedgerEvent[], balance = '0', options: { wallets?: string[]; bBalance?: string; price?: string | null; complete?: boolean } = {}) {
  const wallets = options.wallets || [a];
  return calculateJournalLedger({ wallets, events, asOf: at(59), coverage: wallets.map(walletAddress => ({ walletAddress, tokenAddress: token, complete: options.complete ?? true })),
    valuations: [{ tokenAddress: token, priceUsd: options.price === undefined ? '2' : options.price, pricedAt: at(58), balances: wallets.map(walletAddress => ({ walletAddress, tokenAmount: walletAddress === b ? options.bBalance || '0' : balance })) }] });
}
describe('private journal reconciled exact-decimal ledger', () => {
  it('calculates an open position and fee-inclusive return from lifetime movements', () => {
    const result = calculate([event('1', 'buy', '10', '10', { feeUsd: '1' }), event('2', 'sell', '4', '12', { feeUsd: '0.5' })], '6');
    expect(result.complete).toBe(true);
    expect(result.positions[0]).toMatchObject({ state: 'open', investedUsd: '10', soldUsd: '12', valueUsd: '12', remainingCostBasisUsd: '6.6',
      realizedProfitUsd: '7.1', unrealizedProfitUsd: '5.4', estimatedProfitUsd: '12.5', feeInclusiveCapitalUsd: '11', feesUsd: '1.5' });
    expect(Number(result.totals.roi)).toBeCloseTo(12.5 / 11, 12);
  });
  it('moves original FIFO lots between selected wallets without profit or acquisition capital', () => {
    const result = calculate([event('1', 'buy', '10', '10'), event('2', 'transfer_out', '6', '600', { counterparty: b, txHash: 'move', transferId: 'm' }),
      event('3', 'transfer_in', '6', '600', { walletAddress: b, counterparty: a, txHash: 'move', transferId: 'm' }),
      event('4', 'sell', '3', '9', { walletAddress: b })], '4', { wallets: [a, b], bBalance: '3' });
    expect(result.complete).toBe(true);
    expect(result.positions[0]).toMatchObject({ investedUsd: '10', incomingTransferCostUsd: '0', transferOutIncomeUsd: '0', remainingTokenAmount: '7', remainingCostBasisUsd: '7',
      realizedProfitUsd: '6', estimatedProfitUsd: '13', feeInclusiveCapitalUsd: '10' });
  });
  it('routes same-amount transfers in one transaction to their actual recipients across three wallets', () => {
    const rows = [event('1', 'buy', '20', '20'), event('2', 'buy', '20', '60', { walletAddress: b }),
      event('3', 'transfer_out', '20', '100', { walletAddress: b, counterparty: a, txHash: 'move', transferId: 'legacy-amount-id' }),
      event('4', 'transfer_in', '20', '100', { walletAddress: c, counterparty: a, txHash: 'move', transferId: 'legacy-amount-id' }),
      event('5', 'transfer_out', '20', '100', { walletAddress: a, counterparty: c, txHash: 'move', transferId: 'legacy-amount-id' }),
      event('6', 'transfer_in', '20', '100', { walletAddress: a, counterparty: b, txHash: 'move', transferId: 'legacy-amount-id' }),
      event('7', 'sell', '20', '100', { walletAddress: c })];
    const result = calculateJournalLedger({ wallets: [a, b, c], events: rows, asOf: at(59),
      coverage: [a, b, c].map(walletAddress => ({ walletAddress, tokenAddress: token, complete: true })),
      valuations: [{ tokenAddress: token, priceUsd: '2', pricedAt: at(58), balances: [a, b, c].map(walletAddress => ({ walletAddress, tokenAmount: walletAddress === a ? '20' : '0' })) }] });
    expect(result.complete).toBe(true); expect(result.positions[0]).toMatchObject({ remainingCostBasisUsd: '60', realizedProfitUsd: '80', feeInclusiveCapitalUsd: '80', estimatedProfitUsd: '60' });
  });
  it('leaves ambiguous same-amount provider transfers unavailable instead of choosing an arbitrary pairing', () => {
    const rows = [event('1', 'buy', '20', '20'), event('2', 'buy', '20', '60', { walletAddress: b }),
      event('3', 'transfer_out', '10', '20', { txHash: 'move', transferId: 'legacy-amount-id' }),
      event('4', 'transfer_out', '10', '20', { walletAddress: b, txHash: 'move', transferId: 'legacy-amount-id' }),
      event('5', 'transfer_in', '10', '20', { walletAddress: c, txHash: 'move', transferId: 'legacy-amount-id' }),
      event('6', 'transfer_in', '10', '20', { walletAddress: c, txHash: 'move', transferId: 'legacy-amount-id' })];
    const result = calculateJournalLedger({ wallets: [a, b, c], events: rows, asOf: at(59),
      coverage: [a, b, c].map(walletAddress => ({ walletAddress, tokenAddress: token, complete: true })),
      valuations: [{ tokenAddress: token, priceUsd: '2', pricedAt: at(58), balances: [a, b, c].map(walletAddress => ({ walletAddress, tokenAmount: walletAddress === c ? '20' : '10' })) }] });
    expect(result.complete).toBe(false); expect(result.reasons).toContain('internal_transfer_unreconciled'); expect(result.totals.estimatedProfitUsd).toBeNull();
  });
  it('uses a genuine shared receipt log identity without requiring provider counterparties', () => {
    const result = calculate([event('1', 'buy', '5', '5'), event('2', 'transfer_out', '3', null, { txHash: 'move', transferId: 'log4', blockNumber: '10', logIndex: 4 }),
      event('3', 'transfer_in', '3', null, { walletAddress: b, txHash: 'move', transferId: 'log4', blockNumber: '10', logIndex: 4 })], '2', { wallets: [a, b], bBalance: '3' });
    expect(result.complete).toBe(true); expect(result.positions[0].incomingTransferCostUsd).toBe('0');
  });
  it('uses external receipt valuation for one wallet and original purchase cost for the combined portfolio', () => {
    const rows = [event('1', 'buy', '10', '10'), event('2', 'transfer_out', '6', '12', { counterparty: b, txHash: 'move', transferId: 'm' }),
      event('3', 'transfer_in', '6', '12', { walletAddress: b, counterparty: a, txHash: 'move', transferId: 'm' })];
    expect(calculate(rows, '4').positions[0]).toMatchObject({ transferOutIncomeUsd: '12', realizedProfitUsd: '6', estimatedProfitUsd: '10' });
    expect(calculate(rows, '4', { wallets: [a, b], bBalance: '6' }).positions[0]).toMatchObject({ transferOutIncomeUsd: '0', realizedProfitUsd: '0', estimatedProfitUsd: '10' });
  });
  it('preserves original acquisition order when older lots move into a wallet with newer lots', () => {
    const result = calculate([event('1', 'buy', '5', '5'), event('2', 'buy', '5', '10', { walletAddress: b }),
      event('3', 'transfer_out', '5', '20', { counterparty: b, txHash: 'move', transferId: 'm' }),
      event('4', 'transfer_in', '5', '20', { walletAddress: b, counterparty: a, txHash: 'move', transferId: 'm' }), event('5', 'sell', '5', '20', { walletAddress: b })], '0', { wallets: [a, b], bBalance: '5' });
    expect(result.complete).toBe(true); expect(result.positions[0].realizedProfitUsd).toBe('15');
    expect(result.positions[0].remainingCostBasisUsd).toBe('10'); expect(result.totals.estimatedProfitUsd).toBe('15');
  });
  it('deduplicates a shared wallet-paid fee and charges distinct smart-account operation fees independently', () => {
    const result = calculate([event('1', 'buy', '3', '3', { txHash: 'bundle', feeId: 'op1', feeUsd: '0.2' }),
      event('2', 'buy', '2', '2', { txHash: 'bundle', feeId: 'op1', feeUsd: '0.2' }), event('3', 'sell', '1', '3', { txHash: 'bundle', feeId: 'op2', feeUsd: '0.1' })], '4');
    expect(result.complete).toBe(true);
    expect(result.totals.feesUsd).toBe('0.3'); expect(result.totals.estimatedProfitUsd).toBe('5.7');
  });
  it('deduplicates identical processing while rejecting contradictory evidence', () => {
    const buy = event('1', 'buy', '1', '1');
    expect(calculate([buy, buy], '1').totals.investedUsd).toBe('1');
    const result = calculate([buy, { ...buy, amountUsd: '2' }], '1');
    expect(result.complete).toBe(false); expect(result.reasons).toContain('contradictory_event'); expect(result.totals.estimatedProfitUsd).toBeNull();
  });
  it('retains exact quantities above IEEE-754 precision', () => {
    const result = calculate([event('1', 'buy', '9007199254740993.000000000000000001', '10'),
      event('2', 'sell', '9007199254740993', '12')], '0.000000000000000001');
    expect(result.complete).toBe(true); expect(result.positions[0].remainingTokenAmount).toBe('0.000000000000000001');
    expect(result.positions[0].valueUsd).toBe('0.000000000000000002');
  });
  it('preserves fractional FIFO costs through repeated splits', () => {
    const result = calculate([event('1', 'buy', '3', '1'), event('2', 'sell', '1', '1'), event('3', 'sell', '1', '1'), event('4', 'sell', '1', '1')]);
    expect(result.complete).toBe(true); expect(result.totals.realizedProfitUsd).toBe('2'); expect(result.totals.estimatedProfitUsd).toBe('2');
  });
  it('handles closure and reopening while retaining lifetime capital and realized profit', () => {
    const result = calculate([event('1', 'buy', '2', '2'), event('2', 'sell', '2', '6'), event('3', 'buy', '3', '3')], '3');
    expect(result.complete).toBe(true); expect(result.positions[0]).toMatchObject({ state: 'open', realizedProfitUsd: '4', estimatedProfitUsd: '7', feeInclusiveCapitalUsd: '5' });
  });
  it('keeps unknown incoming costs unavailable instead of assigning zero', () => {
    const result = calculate([event('1', 'transfer_in', '5', null)], '5');
    expect(result.complete).toBe(false); expect(result.reasons).toContain('incoming_transfer_cost_unknown');
    expect(result.positions[0].remainingCostBasisUsd).toBeNull(); expect(result.positions[0].estimatedProfitUsd).toBeNull();
  });
  it('keeps missing purchase history and balance contradictions explicit', () => {
    const result = calculate([event('1', 'sell', '5', '10')]);
    expect(result.complete).toBe(false); expect(result.reasons).toContain('purchase_cost_unknown'); expect(result.totals.estimatedProfitUsd).toBeNull();
    expect(calculate([event('1', 'buy', '5', '5')], '4').reasons).toContain('balance_unreconciled');
  });
  it('does not turn absent fees into zero or distribute aggregate fees into history', () => {
    const result = calculate([event('1', 'buy', '5', '5', { feeUsd: null })], '5');
    expect(result.positions[0].estimated).toBe(true); expect(result.reasons).toContain('fees_incomplete');
    expect(result.positions[0].feesUsd).toBe('0'); expect(result.totals.estimatedProfitUsd).toBeNull();
  });
  it('requires matching internal transfer evidence for both selected wallets', () => {
    const result = calculate([event('1', 'buy', '5', '5'), event('2', 'transfer_out', '3', '6', { counterparty: b })], '2', { wallets: [a, b] });
    expect(result.complete).toBe(false); expect(result.reasons).toContain('internal_transfer_unreconciled');
  });
  it('preserves fee losses on internal transfers without creating new acquisition capital', () => {
    const result = calculate([event('1', 'buy', '5', '5'), event('2', 'transfer_out', '3', null, { counterparty: b, txHash: 'move', transferId: 'm', feeUsd: '0.3' }),
      event('3', 'transfer_in', '3', null, { walletAddress: b, counterparty: a, txHash: 'move', transferId: 'm' })], '2', { wallets: [a, b], bBalance: '3' });
    expect(result.complete).toBe(true); expect(result.positions[0]).toMatchObject({ realizedProfitUsd: '-0.3', estimatedProfitUsd: '4.7', feeInclusiveCapitalUsd: '5' });
  });
  it('does not invent intra-second FIFO order for provider-only movements', () => {
    const result = calculate([event('1', 'buy', '5', '5', { timestamp: at(1) }), event('2', 'sell', '3', '9', { timestamp: at(1) })], '2');
    expect(result.complete).toBe(false); expect(result.reasons).toContain('execution_order_unknown'); expect(result.positions[0].realizedProfitUsd).toBeNull();
  });
  it('detects ambiguous same-second activity even when another wallet interleaves the rows', () => {
    const result = calculate([event('1', 'buy', '5', '5', { timestamp: at(1) }),
      event('2', 'buy', '1', '1', { timestamp: at(1), walletAddress: b }), event('3', 'sell', '3', '9', { timestamp: at(1) })], '2', { wallets: [a, b], bBalance: '1' });
    expect(result.complete).toBe(false); expect(result.reasons).toContain('execution_order_unknown');
  });
  it('does not guess FIFO order for different-cost provider buys before a later partial sale', () => {
    const result = calculate([event('1', 'buy', '5', '5', { timestamp: at(1) }), event('2', 'buy', '5', '10', { timestamp: at(1) }), event('3', 'sell', '5', '15')], '5');
    expect(result.complete).toBe(false); expect(result.reasons).toContain('execution_order_unknown'); expect(result.positions[0].realizedProfitUsd).toBeNull();
  });
  it('permits interchangeable unknown-order buys with identical fee-inclusive unit costs', () => {
    const result = calculate([event('1', 'buy', '5', '5', { timestamp: at(1), feeUsd: '0.5' }), event('2', 'buy', '10', '10', { timestamp: at(1), feeUsd: '1' }), event('3', 'sell', '5', '15')], '10');
    expect(result.complete).toBe(true); expect(result.positions[0].realizedProfitUsd).toBe('9.5');
  });
  it('preserves acquisition-order uncertainty when internal transfers merge same-second lots from separate wallets', () => {
    const result = calculate([event('1', 'buy', '5', '5', { timestamp: at(1) }), event('2', 'buy', '5', '10', { timestamp: at(1), walletAddress: b }),
      event('3', 'transfer_out', '5', '10', { counterparty: b, txHash: 'move' }), event('4', 'transfer_in', '5', '10', { walletAddress: b, counterparty: a, txHash: 'move' }),
      event('5', 'sell', '5', '15', { walletAddress: b })], '0', { wallets: [a, b], bBalance: '5' });
    expect(result.complete).toBe(false); expect(result.reasons).toContain('execution_order_unknown'); expect(result.positions[0].realizedProfitUsd).toBeNull();
  });
  it('accepts independently known same-second transaction order', () => {
    const result = calculate([event('1', 'buy', '5', '5', { timestamp: at(1), blockNumber: '10', transactionIndex: 1 }),
      event('2', 'sell', '3', '9', { timestamp: at(1), blockNumber: '10', transactionIndex: 2 })], '2');
    expect(result.complete).toBe(true); expect(result.totals.estimatedProfitUsd).toBe('8');
  });
  it('uses configured source quantity rounding bounds rather than floating tolerances', () => {
    const result = calculateJournalLedger({ wallets: [a], asOf: at(59), events: [event('1', 'buy', '1', '1')], coverage: [{ walletAddress: a, tokenAddress: token, complete: true }],
      valuations: [{ tokenAddress: token, priceUsd: '2', pricedAt: at(58), balances: [{ walletAddress: a, tokenAmount: '0.999999999999999999', tolerance: '0.000000000000000001' }] }] });
    expect(result.complete).toBe(true);
  });
  it('returns available positions while suppressing incomplete combined profit', () => {
    const result = calculateJournalLedger({ wallets: [a], asOf: at(59), events: [event('1', 'buy', '1', '1'), event('2', 'buy', '1', null, { tokenAddress: other })],
      coverage: [token, other].map(tokenAddress => ({ walletAddress: a, tokenAddress, complete: true })),
      valuations: [token, other].map(tokenAddress => ({ tokenAddress, priceUsd: '2', pricedAt: at(58), balances: [{ walletAddress: a, tokenAmount: '1' }] })) });
    expect(result.positions[0].estimatedProfitUsd).toBe('1'); expect(result.positions[1].estimatedProfitUsd).toBeNull();
    expect(result.totals.estimatedProfitUsd).toBeNull();
  });
  it('ignores wallets outside the account-selected set', () => {
    const result = calculate([event('1', 'buy', '1', '1'), event('2', 'sell', '100', '1000', { walletAddress: b })], '1');
    expect(result.complete).toBe(true); expect(result.positions[0].wallets).toEqual([a]); expect(result.totals.estimatedProfitUsd).toBe('1');
  });
  it('emits historical snapshots in one fold with the same FIFO and cash flows as independent prefixes', () => {
    const rows = [event('1', 'buy', '10', '10', { feeUsd: '1' }), event('2', 'sell', '4', '12', { feeUsd: '0.5' }), event('3', 'buy', '2', '4')];
    const input = { wallets: [a], events: rows, asOf: at(59), coverage: [{ walletAddress: a, tokenAddress: token, complete: true }],
      valuations: [{ tokenAddress: token, priceUsd: '2', pricedAt: at(58), balances: [{ walletAddress: a, tokenAmount: '8' }] }] };
    const result = calculateJournalLedger({ ...input, timeline: true });
    expect(result.timeline).toHaveLength(3);
    for (let index = 0; index < rows.length; index++) {
      const prefix = calculate(rows.slice(0, index + 1), ['10', '6', '8'][index]).positions[0];
      expect(result.timeline![index].snapshot).toMatchObject(Object.fromEntries(Object.keys(result.timeline![index].snapshot).map(field => [field, prefix[field as keyof typeof prefix]])));
    }
  });
  it('emits only group-ending snapshots for same-second activity', () => {
    const rows = [event('1', 'buy', '5', '5', { timestamp: at(1), blockNumber: '10', transactionIndex: 1 }), event('2', 'sell', '3', '9', { timestamp: at(1), blockNumber: '10', transactionIndex: 2 })];
    const result = calculateJournalLedger({ wallets: [a], events: rows, asOf: at(59), timeline: true,
      coverage: [{ walletAddress: a, tokenAddress: token, complete: true }], valuations: [{ tokenAddress: token, priceUsd: '2', pricedAt: at(58), balances: [{ walletAddress: a, tokenAmount: '2' }] }] });
    expect(result.timeline).toHaveLength(1); expect(result.timeline![0]).toMatchObject({ eventIds: ['1', '2'], snapshot: { remainingTokenAmount: '2', realizedProfitUsd: '6' } });
  });
  it('never leaks a later fee or unknown fee backwards into earlier frames', () => {
    const result = calculateJournalLedger({ wallets: [a], events: [event('1', 'buy', '5', '5', { feeUsd: '0.1' }), event('2', 'sell', '2', '4', { feeUsd: null })],
      asOf: at(59), timeline: true, coverage: [{ walletAddress: a, tokenAddress: token, complete: true }],
      valuations: [{ tokenAddress: token, priceUsd: '2', pricedAt: at(58), balances: [{ walletAddress: a, tokenAmount: '3' }] }] });
    expect(result.timeline![0].snapshot).toMatchObject({ feesUsd: '0.1', complete: true });
    expect(result.timeline![1].snapshot).toMatchObject({ feesUsd: '0.1', complete: false });
    expect(result.timeline![0].snapshot.reasons).not.toContain('fees_incomplete');
  });
  it('prepares ten thousand moving historical snapshots without rescanning every prefix', () => {
    const count = 10000, beginning = Date.UTC(2026, 9, 17), rows = Array.from({ length: count }, (_, index) => event(String(index), 'buy', '1', '1', { timestamp: new Date(beginning + index * 1000).toISOString() }));
    const result = calculateJournalLedger({ wallets: [a], events: rows, asOf: at(59), timeline: true, coverage: [{ walletAddress: a, tokenAddress: token, complete: true }],
      valuations: [{ tokenAddress: token, priceUsd: '2', pricedAt: at(58), balances: [{ walletAddress: a, tokenAmount: String(count) }] }] });
    expect(result.complete).toBe(true); expect(result.timeline).toHaveLength(count);
    expect(result.timeline![count - 1].snapshot.remainingTokenAmount).toBe(String(count));
    expect(result.timeline![0].snapshot.investedUsd).toBe('1'); expect(result.totals.estimatedProfitUsd).toBe(String(count));
  }, 10000);
});
