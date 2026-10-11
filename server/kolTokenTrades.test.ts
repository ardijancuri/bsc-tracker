import { describe, expect, it } from 'vitest';
import { summarizeKolTokenTrades, type IndexedKolTokenTrade } from './kolTokenTrades.js';

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
