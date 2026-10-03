import { describe, expect, it } from 'vitest';
import { calculateLeaderboard, calculateTodayLeaderboard, calculate24hLeaderboard, type ValuedTrade } from './pnl.js';

const now = Date.parse('2026-09-26T12:00:00Z');
const wallet = '0x0000000000000000000000000000000000000001';
const token = '0x0000000000000000000000000000000000000002';
const trade = (side: 'buy' | 'sell', daysAgo: number, tokenAmount: string, amountUsd: string | null): ValuedTrade => ({
  walletAddress: wallet, tokenAddress: token, side, tokenAmount, amountUsd,
  timestamp: new Date(now - daysAgo * 86400_000).toISOString(),
});

describe('rolling 24-hour matched realized P&L', () => {
  const at = Date.parse('2026-10-03T02:45:00Z');
  const timed = (side: 'buy' | 'sell', timestamp: string): ValuedTrade => ({
    walletAddress: wallet, tokenAddress: token, side, timestamp, tokenAmount: '2', amountUsd: side === 'buy' ? '20' : '40',
  });
  it('includes yesterday trades within 24 hours and carries them across midnight', () => {
    const trades = [timed('buy', '2026-10-02T03:00:00Z'), timed('sell', '2026-10-02T20:00:00Z')];
    expect(calculate24hLeaderboard(trades, [wallet], at)[0])
      .toMatchObject({ period: '1d', windowStart: '2026-10-02T02:45:00.000Z', realizedProfitUsd: 20, buyCount: 1, sellCount: 1 });
  });
  it('includes purchases at the cutoff and drops them when the window moves past them', () => {
    const trades = [timed('buy', '2026-10-02T02:45:00Z'), timed('sell', '2026-10-02T20:00:00Z')];
    expect(calculate24hLeaderboard(trades, [wallet], at)[0].realizedProfitUsd).toBe(20);
    expect(calculate24hLeaderboard(trades, [wallet], at + 1000)[0]).toMatchObject({ realizedProfitUsd: null, excludedSellCount: 1 });
  });
  it('excludes trades beyond both ends of the rolling window', () => {
    expect(calculate24hLeaderboard([timed('buy', '2026-10-02T02:44:59Z'), timed('sell', '2026-10-03T02:45:01Z')], [wallet], at)[0])
      .toMatchObject({ realizedProfitUsd: 0, buyCount: 0, sellCount: 0 });
  });
});

describe('today-only realized P&L', () => {
  const start = '2026-09-25T22:00:00Z';
  const today = (side: 'buy' | 'sell', hour: number, quantity: string, usd: string | null, extra: Partial<ValuedTrade> = {}): ValuedTrade => ({
    walletAddress: wallet, tokenAddress: token, side, tokenAmount: quantity, amountUsd: usd,
    timestamp: new Date(Date.parse(start) + hour * 3600_000), ...extra,
  });
  const calculate = (trades: ValuedTrade[]) => calculateTodayLeaderboard(trades, [wallet], start, now)[0];
  it('uses FIFO purchase costs for positions opened and sold today', () => {
    expect(calculate([today('buy', 1, '2', '20'), today('buy', 2, '2', '40'), today('sell', 3, '3', '75')]))
      .toMatchObject({ realizedProfitUsd: 35, valuedSellCount: 1, excludedSellCount: 0 });
  });
  it('excludes older purchases and preserves the profit of valid today positions', () => {
    expect(calculate([today('buy', -1, '2', '10'), today('sell', 1, '2', '20'), today('buy', 2, '2', '30'), today('sell', 3, '2', '50')]))
      .toMatchObject({ realizedProfitUsd: 20, buyCount: 1, sellCount: 2, valuedSellCount: 1, excludedSellCount: 1 });
  });
  it('consumes incomplete sales without reusing their purchase costs', () => {
    expect(calculate([today('buy', 1, '2', '20'), today('sell', 2, '3', '60'), today('sell', 3, '1', '30')]))
      .toMatchObject({ realizedProfitUsd: null, excludedSellCount: 2 });
  });
  it('consumes unpriced purchases before newer priced purchases', () => {
    expect(calculate([today('buy', 1, '2', null), today('buy', 2, '2', '20'), today('sell', 3, '2', '30'), today('sell', 4, '2', '40')]))
      .toMatchObject({ realizedProfitUsd: 20, valuedSellCount: 1, excludedSellCount: 1 });
  });
  it('orders same-second trades by their block and transaction index', () => {
    expect(calculate([today('sell', 1, '2', '40', { blockNumber: 100, transactionIndex: 2 }), today('buy', 1, '2', '20', { blockNumber: 100, transactionIndex: 1 })]).realizedProfitUsd).toBe(20);
  });
  it('does not share cost basis between wallets or count future trades', () => {
    expect(calculate([today('buy', 1, '2', '20', { walletAddress: 'other' }), today('sell', 2, '2', '40'), today('buy', 20, '2', '20')]))
      .toMatchObject({ realizedProfitUsd: null, buyCount: 0, sellCount: 1 });
  });
  it('excludes a quote value assigned to multiple assets in one transaction', () => {
    const quote = { txHash: 'tx', quoteSymbol: 'BNB', quoteAmount: '1' };
    expect(calculate([today('buy', 1, '2', '100', quote), today('buy', 1, '2', '100', { ...quote, tokenAddress: 'other' }), today('sell', 2, '2', '150')]))
      .toMatchObject({ realizedProfitUsd: null, excludedSellCount: 1 });
  });
  it('ignores auxiliary dividend trackers without removing the actual meme position', () => {
    const quote = { txHash: 'tx', quoteSymbol: 'BNB', quoteAmount: '1' };
    expect(calculate([today('buy', 1, '2', '100', quote), today('buy', 1, '2', '100', { ...quote, tokenAddress: 'other', tokenSymbol: 'ETHBack_Dividend_Tracker' }), today('sell', 2, '2', '150')]))
      .toMatchObject({ realizedProfitUsd: 50, buyCount: 1, valuedSellCount: 1 });
  });
  it('shows zero for buys with no realized sales and resets at the next midnight', () => {
    const trades = [today('buy', 1, '2', '20')];
    expect(calculate(trades)).toMatchObject({ realizedProfitUsd: 0, buyCount: 1 });
    expect(calculateTodayLeaderboard(trades, [wallet], '2026-09-26T22:00:00Z', Date.parse('2026-09-27T12:00:00Z'))[0])
      .toMatchObject({ realizedProfitUsd: 0, buyCount: 0, sellCount: 0 });
  });
});

describe('observed realized P&L', () => {
  it('shows zero realized profit when there are no sales in the selected period', () => {
    const stats = calculateLeaderboard([trade('buy', 0.5, '2', '100')], [wallet], now);
    expect(stats.find(row => row.period === '7d')?.realizedProfitUsd).toBe(0);
    expect(stats.find(row => row.period === '7d')?.sellCount).toBe(0);
  });
  it('uses earlier cost basis for a sale in the selected window', () => {
    const stats = calculateLeaderboard([trade('buy', 12, '10', '100'), trade('sell', 0.5, '5', '75')], [wallet], now);
    expect(stats.find(row => row.period === '1d')?.realizedProfitUsd).toBe(25);
    expect(stats.find(row => row.period === '1d')?.buyCount).toBe(0);
    expect(stats.find(row => row.period === '1d')?.sellCount).toBe(1);
  });

  it('excludes sales without observed priced cost basis', () => {
    const stats = calculateLeaderboard([trade('buy', 2, '2', null), trade('sell', 0.5, '2', '100')], [wallet], now);
    expect(stats.find(row => row.period === '1d')?.realizedProfitUsd).toBeNull();
  });

  it('does not show a partial total when a sale exceeds observed FIFO lots', () => {
    const stats = calculateLeaderboard([trade('buy', 4, '2', '20'), trade('buy', 3, '2', '40'), trade('sell', 0.5, '5', '100')], [wallet], now);
    expect(stats.find(row => row.period === '1d')?.realizedProfitUsd).toBeNull();
  });

  it('does not rank a wallet on complete sales when another sale lacks a cost basis', () => {
    const otherToken = '0x0000000000000000000000000000000000000003';
    const stats = calculateLeaderboard([
      trade('buy', 3, '2', '20'), trade('sell', 1, '2', '30'),
      { ...trade('sell', 0.5, '1', '40'), tokenAddress: otherToken },
    ], [wallet], now);
    expect(stats.find(row => row.period === '7d')?.realizedProfitUsd).toBeNull();
  });
});
