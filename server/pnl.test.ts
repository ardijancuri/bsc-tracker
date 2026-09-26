import { describe, expect, it } from 'vitest';
import { calculateLeaderboard, type ValuedTrade } from './pnl.js';

const now = Date.parse('2026-09-26T12:00:00Z');
const wallet = '0x0000000000000000000000000000000000000001';
const token = '0x0000000000000000000000000000000000000002';
const trade = (side: 'buy' | 'sell', daysAgo: number, tokenAmount: string, amountUsd: string | null): ValuedTrade => ({
  walletAddress: wallet, tokenAddress: token, side, tokenAmount, amountUsd,
  timestamp: new Date(now - daysAgo * 86400_000).toISOString(),
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

  it('consumes FIFO lots and leaves unmatched quantities out of profit', () => {
    const stats = calculateLeaderboard([trade('buy', 4, '2', '20'), trade('buy', 3, '2', '40'), trade('sell', 0.5, '5', '100')], [wallet], now);
    expect(stats.find(row => row.period === '1d')?.realizedProfitUsd).toBe(20);
  });
});
