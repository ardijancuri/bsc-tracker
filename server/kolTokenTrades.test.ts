import { describe, expect, it } from 'vitest';
import { summarizeKolTokenTrades, type IndexedKolTokenTrade, type KolTokenInventoryEvidence, type KolTokenInventoryTransfer } from './kolTokenTrades.js';

const wallet = '0x0000000000000000000000000000000000000001';
const token = '0x0000000000000000000000000000000000000002';
const other = '0x0000000000000000000000000000000000000003';
const now = Date.parse('2026-10-11T12:00:00Z');
const trade = (id: string, side: 'buy' | 'sell' | 'swap', quantity: string | null, usd: string | null,
  extra: Partial<IndexedKolTokenTrade> = {}): IndexedKolTokenTrade => ({
  id, txHash: `hash-${id}`, walletAddress: wallet, tokenAddress: token, kolName: 'Tavern', kolAvatarUrl: null, kolTwitter: null,
  tokenSymbol: 'SAFU', tokenName: 'SAFU', tokenLogoUrl: null, side, tokenAmount: quantity, amountUsd: usd,
  quoteSymbol: 'BNB', quoteAmount: null, priceUsd: null, timestamp: `2026-10-08T01:${id.padStart(2, '0')}:00Z`,
  source: 'node', blockNumber: '100', transactionIndex: Number(id), ...extra,
});

const transfer = (id: string, deltaRaw: string, extra: Partial<KolTokenInventoryTransfer> = {}): KolTokenInventoryTransfer => ({
  id: `transfer-${id}`, txHash: `transfer-hash-${id}`, walletAddress: wallet, tokenAddress: token, deltaRaw,
  timestamp: `2026-10-08T01:${id.padStart(2, '0')}:00Z`, blockNumber: '100', transactionIndex: Number(id), logIndex: Number(id), ...extra,
});
const inventory = (ending: string, transfers: KolTokenInventoryTransfer[] = [], extra: Partial<KolTokenInventoryEvidence> = {}): KolTokenInventoryEvidence => ({
  decimals: 0, initialBalanceRaw: '0', endingBalanceRaw: ending, transfers,
  coverage: { complete: true, reconciled: true, fromBlock: '100', toBlock: '200', blockHash: `0x${'a'.repeat(64)}`,
    checkedAt: new Date(now).toISOString(), balance: ending, status: 'verified', initialBalanceSource: 'historical_call', scannedThroughBlock: '200' }, ...extra,
});
const withInventory = (trades: IndexedKolTokenTrade[], evidence: KolTokenInventoryEvidence, at = now) =>
  summarizeKolTokenTrades(trades, wallet, token, '1000', true, at, evidence);

describe('transfer-aware KOL token inventory', () => {
  it('keeps completed realized gains when a later unpriced buy makes the remaining cost unavailable', () => {
    const trades = [trade('1', 'buy', '2', '20'), trade('2', 'sell', '2', '50'), trade('3', 'buy', '1', null)];
    for (const result of [summarizeKolTokenTrades(trades, wallet, token, '1000', true, now), withInventory(trades, inventory('1'))]) {
      expect(result.summary).toMatchObject({ realizedProfitUsd: '30', investedUsd: null, soldUsd: '50', remainingCostBasisUsd: null,
        valuedSellCount: 1, excludedSellCount: 0 });
    }
    trades.push(trade('4', 'sell', '1', '40'));
    expect(withInventory(trades, inventory('0')).summary.realizedProfitUsd).toBeNull();
  });

  it('removes transferred FIFO cost before a later sale without adding proceeds or realized profit', () => {
    const result = withInventory([trade('1', 'buy', '2', '20'), trade('2', 'buy', '4', '80'), trade('4', 'sell', '2', '50')],
      inventory('1', [transfer('3', '-3')]));
    expect(result.summary).toMatchObject({ investedUsd: '100', soldUsd: '50', realizedProfitUsd: '10',
      remainingTokenAmount: '1', remainingCostBasisUsd: '20', buyCount: 2, sellCount: 1, status: 'open' });
    expect(result.trades[0]).toMatchObject({ realizedProfitUsd: '10', cumulativeRealizedProfitUsd: '10' });
    expect(result.inventory?.events.map(event => event.kind)).toEqual(['buy', 'buy', 'transfer_out', 'sell']);
    expect(result.inventory?.events[2]).toMatchObject({ tokenAmount: '3', remainingTokenAmount: '3', remainingCostBasisUsd: '60',
      cumulativeRealizedProfitUsd: '0', investedUsd: '100', soldUsd: '0' });
    expect(result.inventory?.events[2].tradeId).toBeUndefined();
    expect(result.inventory?.coverage).toMatchObject({ complete: true, reconciled: true, balance: '1' });
  });

  it('closes a position transferred out in full without inventing a sell or realized loss', () => {
    const result = withInventory([trade('1', 'buy', '2', '20')], inventory('0', [transfer('2', '-2')]));
    expect(result.summary).toMatchObject({ realizedProfitUsd: '0', soldUsd: '0', investedUsd: '20', sellCount: 0,
      remainingTokenAmount: '0', remainingCostBasisUsd: '0', status: 'closed' });
    expect(result.inventory?.events.at(-1)).toMatchObject({ kind: 'transfer_out', cumulativeRealizedProfitUsd: '0', remainingCostBasisUsd: '0' });
  });

  it('protects unknown incoming cost from being treated as a free purchase or reused by subsequent sales', () => {
    const result = withInventory([trade('2', 'buy', '1', '10'), trade('3', 'sell', '1', '30'), trade('4', 'sell', '1', '40')],
      inventory('0', [transfer('1', '1')]));
    expect(result.inventory?.coverage.reconciled).toBe(true);
    expect(result.inventory?.events[0]).toMatchObject({ kind: 'transfer_in', remainingTokenAmount: '1', remainingCostBasisUsd: null });
    expect(result.trades[1]).toMatchObject({ realizedProfitUsd: null, cumulativeRealizedProfitUsd: null });
    expect(result.trades[0]).toMatchObject({ realizedProfitUsd: '30', cumulativeRealizedProfitUsd: null });
    expect(result.summary).toMatchObject({ investedUsd: '10', soldUsd: '70', realizedProfitUsd: null,
      remainingTokenAmount: '0', remainingCostBasisUsd: '0', valuedSellCount: 1, excludedSellCount: 1 });
  });

  it('can value known remaining lots after unknown opening inventory leaves without an unknown-cost sale', () => {
    const evidence = inventory('1', [transfer('2', '-1')], { initialBalanceRaw: '1' });
    evidence.coverage.initialBalanceSource = 'derived_complete_movements';
    const result = withInventory([trade('1', 'buy', '1', '10')], evidence);
    expect(result.inventory?.events[0].remainingCostBasisUsd).toBeNull();
    expect(result.summary).toMatchObject({ realizedProfitUsd: '0', investedUsd: '10', remainingTokenAmount: '1', remainingCostBasisUsd: '10' });
    expect(result.inventory?.coverage.initialBalanceSource).toBe('derived_complete_movements');
  });

  it('preserves one raw token unit, including after a partial transfer and sale', () => {
    const evidence = inventory('1', [transfer('2', '-1')], { decimals: 18 });
    evidence.coverage.balance = '0.000000000000000001';
    const result = withInventory([trade('1', 'buy', '0.000000000000000003', '30'), trade('3', 'sell', '0.000000000000000001', '20')], evidence);
    expect(result.summary).toMatchObject({ realizedProfitUsd: '10', remainingTokenAmount: '0.000000000000000001', remainingCostBasisUsd: '10' });
  });

  it('uses canonical transaction order for a transfer and later rebuy/sale in the same block and second', () => {
    const timestamp = '2026-10-08T01:00:00Z';
    const result = withInventory([trade('4', 'sell', '1', '30', { timestamp }), trade('3', 'buy', '2', '40', { timestamp }),
      trade('1', 'buy', '2', '20', { timestamp })], inventory('2', [transfer('2', '-1', { timestamp })]));
    expect(result.summary).toMatchObject({ realizedProfitUsd: '20', remainingTokenAmount: '2', remainingCostBasisUsd: '40' });
    expect(result.inventory?.events.map(event => event.transactionIndex)).toEqual([1, 2, 3, 4]);
  });

  it.each(['incomplete', 'unreconciled', 'wrong-ending-balance'] as const)('withholds profit and basis when inventory is %s', variant => {
    const evidence = inventory(variant === 'wrong-ending-balance' ? '0' : '1');
    if (variant === 'incomplete') evidence.coverage.complete = false;
    if (variant === 'unreconciled') evidence.coverage.reconciled = false;
    const result = withInventory([trade('1', 'buy', '2', '20'), trade('2', 'sell', '1', '30')], evidence);
    expect(result.inventory?.coverage.reconciled).toBe(false);
    expect(result.summary).toMatchObject({ investedUsd: '20', soldUsd: '30', realizedProfitUsd: null,
      remainingTokenAmount: null, remainingCostBasisUsd: null, status: 'unknown' });
    expect(result.inventory?.events.every(event => event.remainingCostBasisUsd === null && event.cumulativeRealizedProfitUsd === null)).toBe(true);
    expect(result.trades.every(row => row.realizedProfitUsd === null && row.cumulativeRealizedProfitUsd === null)).toBe(true);
  });

  it.each(['wrong-pair', 'future', 'malformed-raw', 'duplicate-id', 'duplicate-log', 'swap-log', 'missing-order', 'outside-window'] as const)(
    'rejects %s transfer evidence rather than authorizing wallet profit', variant => {
      let row = transfer('2', '-1');
      if (variant === 'wrong-pair') row.walletAddress = other;
      if (variant === 'future') row.timestamp = '2026-10-12T00:00:00Z';
      if (variant === 'malformed-raw') row.deltaRaw = '-1x';
      if (variant === 'swap-log') row.txHash = 'hash-1';
      if (variant === 'missing-order') row.transactionIndex = null;
      if (variant === 'outside-window') row.blockNumber = '201';
      const rows = variant === 'duplicate-id' ? [row, row] : variant === 'duplicate-log' ? [row, { ...row, id: 'different-id' }] : [row];
      const result = withInventory([trade('1', 'buy', '2', '20')], inventory('1', rows));
      expect(result.inventory?.coverage).toMatchObject({ complete: false, reconciled: false });
      expect(result.summary.realizedProfitUsd).toBeNull(); expect(result.summary.remainingCostBasisUsd).toBeNull();
    });

  it('does not authorize excess token precision, unpriced sales or an inventory underflow', () => {
    const precision = withInventory([trade('1', 'buy', '1.5', '10')], inventory('1'));
    expect(precision.inventory?.coverage.reconciled).toBe(false);
    const missing = withInventory([trade('1', 'buy', '2', '20'), trade('2', 'sell', '1', null)], inventory('1'));
    expect(missing.summary.realizedProfitUsd).toBeNull(); expect(missing.summary.soldUsd).toBeNull();
    const oversell = withInventory([trade('1', 'buy', '1', '20'), trade('3', 'sell', '1', '30')], inventory('0', [transfer('2', '-1')]));
    expect(oversell.inventory?.coverage.reconciled).toBe(false); expect(oversell.summary.realizedProfitUsd).toBeNull();
  });

  it('requires movement coverage through the exact ending block and explicit proof availability', () => {
    for (const mutate of [
      (evidence: KolTokenInventoryEvidence) => { evidence.coverage.scannedThroughBlock = '199'; },
      (evidence: KolTokenInventoryEvidence) => { evidence.coverage.initialBalanceSource = null; },
      (evidence: KolTokenInventoryEvidence) => { evidence.coverage.status = 'pending'; },
      (evidence: KolTokenInventoryEvidence) => { evidence.coverage.checkedAt = new Date(now + 1).toISOString(); },
    ]) {
      const evidence = inventory('1'); mutate(evidence);
      const result = withInventory([trade('1', 'buy', '1', '10')], evidence);
      expect(result.inventory?.coverage).toMatchObject({ complete: false, reconciled: false });
      expect(result.summary.remainingCostBasisUsd).toBeNull(); expect(result.summary.realizedProfitUsd).toBeNull();
    }
  });

  it('reconciles the confirmed Yukaz quantities and removes transfer cost before the two later buys', () => {
    const at = Date.parse('2026-10-14T00:41:44.789Z');
    const trades = [
      trade('1', 'buy', '89957115.521226503814815401', '519.64829', { timestamp: '2026-10-13T15:57:27Z', blockNumber: '127430619', transactionIndex: 1 }),
      trade('2', 'sell', '42516099.04942224167971405', '549.6839156709573', { timestamp: '2026-10-13T15:57:46Z', blockNumber: '127430663', transactionIndex: 12 }),
      trade('4', 'buy', '845506.16787510963042443', '7.4311935386000005', { timestamp: '2026-10-13T16:00:01Z', blockNumber: '127430963', transactionIndex: 1 }),
      trade('5', 'buy', '100864.278724180551767221', '3.7250799999999997', { timestamp: '2026-10-13T16:16:09Z', blockNumber: '127433114', transactionIndex: 3 }),
    ];
    const evidence = inventory('25723472706839610620428313', [transfer('3', '-22663914211563941696864689', {
      timestamp: '2026-10-13T15:58:00Z', blockNumber: '127430722', transactionIndex: 1,
    })], { decimals: 18 });
    evidence.coverage = { ...evidence.coverage, fromBlock: '127430619', toBlock: '127433114', scannedThroughBlock: '127433114',
      checkedAt: new Date(at).toISOString(), balance: '25723472.706839610620428313' };
    const result = withInventory(trades, evidence, at);
    expect(result.inventory?.coverage.reconciled).toBe(true);
    expect(result.inventory?.events.map(event => event.kind)).toEqual(['buy', 'sell', 'transfer_out', 'buy', 'buy']);
    expect(result.summary.remainingTokenAmount).toBe('25723472.706839610620428313');
    expect(Number(result.summary.remainingCostBasisUsd)).toBeCloseTo(154.284237859, 8);
    expect(Number(result.summary.realizedProfitUsd)).toBeCloseTo(304.084464860536, 9);
    expect(result.summary).toMatchObject({ investedUsd: '530.8045635386', soldUsd: '549.683915670957', buyCount: 3, sellCount: 1 });
  });
});
const summarize = (trades: IndexedKolTokenTrade[], supply: string | null = '1000', complete = true) => summarizeKolTokenTrades(trades, wallet, token, supply, complete, now);

describe('KOL token activity accounting', () => {
  it('matches all-history FIFO lots across partial sells and uses quantity-weighted average MCAP', () => {
    const result = summarize([trade('4', 'sell', '3', '90'), trade('2', 'buy', '4', '80'), trade('3', 'sell', '3', '75'), trade('1', 'buy', '2', '20')]);
    expect(result.summary).toMatchObject({ investedUsd: '100', soldUsd: '165', realizedProfitUsd: '65', remainingTokenAmount: '0',
      remainingCostBasisUsd: '0', status: 'closed', buyCount: 2, sellCount: 2, valuedSellCount: 2, excludedSellCount: 0 });
    expect(Number(result.summary.avgBoughtPriceUsd)).toBeCloseTo(100 / 6);
    expect(Number(result.summary.avgBoughtMcapUsd)).toBeCloseTo(100 / 6 * 1000);
    expect(result.summary.avgSoldMcapUsd).toBe('27500');
    expect(result.trades.map(row => [row.id, row.realizedProfitUsd, row.cumulativeRealizedProfitUsd])).toEqual([
      ['4', '30', '65'], ['3', '35', '35'], ['2', null, '0'], ['1', null, '0'],
    ]);
  });
  it('isolates the exact wallet and contract, ignores unconfirmed/future rows, and retains purchases older than 24h', () => {
    const result = summarize([
      trade('1', 'buy', '2', '20'), trade('2', 'sell', '2', '50'),
      trade('3', 'sell', '4', '100', { walletAddress: other }), trade('4', 'buy', '100', '1000', { tokenAddress: other }),
      trade('5', 'sell', '100', '1000', { blockNumber: null }), trade('6', 'sell', '100', '1000', { timestamp: '2026-10-12T00:00:00Z' }),
    ]);
    expect(result.trades.map(row => row.id)).toEqual(['2', '1']);
    expect(result.summary).toMatchObject({ realizedProfitUsd: '30', buyCount: 1, sellCount: 1, firstTradeAt: '2026-10-08T01:01:00.000Z' });
  });
  it('never displays a partial total when one sale has an unmatched cost basis', () => {
    const result = summarize([trade('1', 'buy', '2', '20'), trade('2', 'sell', '3', '60'), trade('3', 'buy', '2', '20'), trade('4', 'sell', '2', '40')]);
    expect(result.summary).toMatchObject({ realizedProfitUsd: null, valuedSellCount: 1, excludedSellCount: 1, status: 'unknown' });
    expect(result.trades[0]).toMatchObject({ realizedProfitUsd: '20', cumulativeRealizedProfitUsd: null });
    expect(result.trades[2].realizedProfitUsd).toBeNull();
  });
  it('consumes unpriced purchase lots before newer purchases and does not reuse incomplete sale lots', () => {
    const result = summarize([trade('1', 'buy', '2', null), trade('2', 'buy', '2', '20'), trade('3', 'sell', '3', '90'), trade('4', 'sell', '1', '40')]);
    expect(result.summary).toMatchObject({ investedUsd: null, avgBoughtMcapUsd: null, realizedProfitUsd: null,
      valuedSellCount: 1, excludedSellCount: 1, remainingTokenAmount: '0' });
    expect(result.trades[0].realizedProfitUsd).toBe('30');
  });
  it('excludes a duplicated shared quote budget from purchase cost and inferred trade MCAP', () => {
    const result = summarize([trade('1', 'buy', '2', '100', { sharedQuote: true, priceUsd: '50' }), trade('2', 'sell', '2', '150')]);
    expect(result.summary).toMatchObject({ investedUsd: null, avgBoughtPriceUsd: null, avgBoughtMcapUsd: null, realizedProfitUsd: null, excludedSellCount: 1 });
    expect(result.trades[1]).toMatchObject({ valuationStatus: 'shared_quote', priceUsd: null, marketCapUsd: null });
  });
  it('omits MCAP without a verified supply while preserving price averages and observed profit', () => {
    const result = summarize([trade('1', 'buy', '2', '20'), trade('2', 'sell', '1', '30')], null);
    expect(result.summary).toMatchObject({ realizedProfitUsd: '20', avgBoughtPriceUsd: '10', avgSoldPriceUsd: '30',
      avgBoughtMcapUsd: null, avgSoldMcapUsd: null, remainingTokenAmount: '1', remainingCostBasisUsd: '10', status: 'open' });
    expect(result.trades.every(row => row.marketCapUsd === null)).toBe(true);
  });
  it('nulls all-history totals and profit when the bounded history is truncated', () => {
    const result = summarize([trade('1', 'buy', '2', '20'), trade('2', 'sell', '2', '50')], '1000', false);
    expect(result.summary).toMatchObject({ investedUsd: null, soldUsd: null, realizedProfitUsd: null, remainingTokenAmount: null,
      avgBoughtMcapUsd: null, avgSoldMcapUsd: null, status: 'unknown' });
    expect(result.trades.every(row => row.realizedProfitUsd === null && row.cumulativeRealizedProfitUsd === null)).toBe(true);
  });
  it('uses block/transaction order for trades in the same second and records zero profit before sales', () => {
    const timestamp = '2026-10-08T01:00:00Z';
    const result = summarize([trade('1', 'sell', '2', '50', { timestamp, transactionIndex: 2 }), trade('2', 'buy', '2', '20', { timestamp, transactionIndex: 1 })]);
    expect(result.summary.realizedProfitUsd).toBe('30');
    expect(summarize([trade('1', 'buy', '2', '20')]).summary).toMatchObject({ realizedProfitUsd: '0', soldUsd: '0', avgSoldPriceUsd: null, status: 'open' });
  });
  it('does not invent cost or profit for invalid quantities, negative USD, or unresolved swaps', () => {
    const result = summarize([trade('1', 'buy', null, '20'), trade('2', 'sell', '2', '-5'), trade('3', 'swap', '2', '30')]);
    expect(result.summary).toMatchObject({ investedUsd: null, soldUsd: null, realizedProfitUsd: null, remainingTokenAmount: null, status: 'unknown' });
    expect(result.trades[2].valuationStatus).toBe('invalid_quantity');
  });
  it('matches quantities below one trillionth of a token instead of treating the sale as free proceeds', () => {
    const result = summarize([trade('1', 'buy', '0.000000000000002', '20'), trade('2', 'sell', '0.000000000000001', '30')], null);
    expect(result.summary).toMatchObject({ realizedProfitUsd: '20', remainingTokenAmount: '1e-15', remainingCostBasisUsd: '10', status: 'open' });
  });
  it.each([
    [{ tokenAmount: null, amountUsd: '100' }, 'invalid_quantity'],
    [{ tokenAmount: '2', amountUsd: null }, 'unpriced'],
  ] as const)('hides stored fill price and MCAP when transaction valuation is %s', (values, valuationStatus) => {
    const result = summarize([trade('1', 'buy', values.tokenAmount, values.amountUsd, { priceUsd: '50' })]);
    expect(result.trades[0]).toMatchObject({ valuationStatus, priceUsd: null, marketCapUsd: null });
    expect(result.summary.avgBoughtMcapUsd).toBeNull();
  });
});
