import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { createFreshPortfolio, freshPortfolioScope } from './portfolio.js';

type Options = Parameters<typeof createFreshPortfolio>[0];
const account = 'account-a', wallet = '0x' + '1'.repeat(40), otherWallet = '0x' + '2'.repeat(40);
const member = { wallet_address: wallet, revision: 'one', activity_from: '2026-10-24T00:00:00Z' };
const stableQuotes = [
  ['USDC', '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d'],
  ['USDT', '0x55d398326f99059ff775485246999027b3197955'],
] as const;
function fixture(symbol: string, address: string) {
  const row = { id: 'trade', walletAddress: wallet, tokenAddress: '0x' + '3'.repeat(40), tokenSymbol: 'TOKEN', tokenName: 'Token', tokenLogoUrl: null,
    side: 'sell', tokenAmount: '1000', amountUsd: '123.4', quoteAmount: '123.456789123456789123', quoteSymbol: symbol,
    quoteTokenAddress: address, bnbEquivalentAmount: '0.15425', txHash: '0x' + 'a'.repeat(64), timestamp: '2026-10-24T00:01:00Z' };
  const query = vi.fn(async (sql: string, args: unknown[]) => {
    expect(sql).toBe('SELECT * FROM public.journal_wallets WHERE user_id=$1 ORDER BY added_at,wallet_address');
    expect(args).toEqual([account]); return { rows: [member] };
  });
  const trades = vi.fn(async () => ({ items: [row], nextCursor: 'next' }));
  const service = createFreshPortfolio({ db: { query } as unknown as Pool, reads: { trades } as unknown as Options['reads'], replay: {} as Options['replay'] });
  return { row, query, trades, service };
}

describe('private activity historical BNB display fields', () => {
  it.each(stableQuotes)('retains the %s settlement and equivalent in its account-scoped response', async (symbol, address) => {
    const { row, trades, query, service } = fixture(symbol, address);
    const value = await service.activity(account, wallet, 'prior');
    expect(trades).toHaveBeenCalledWith({ scopeId: freshPortfolioScope(account, wallet), cursor: 'prior', limit: 50 });
    expect(query).toHaveBeenCalledTimes(2);
    expect(value.trades[0]).toMatchObject({ quoteTokenAddress: address, quoteSymbol: symbol, quoteAmount: row.quoteAmount,
      bnbEquivalentAmount: row.bnbEquivalentAmount, amountUsd: row.amountUsd });
    expect(value.cursor).toBe('next');
  });
  it('checks private wallet membership before looking up any trading or conversion values', async () => {
    const { service, trades } = fixture(...stableQuotes[0]);
    await expect(service.activity(account, otherWallet)).rejects.toMatchObject({ statusCode: 404 });
    expect(trades).not.toHaveBeenCalled();
  });
  it('does not release a response after its wallet membership changes during the read', async () => {
    const { service, query } = fixture(...stableQuotes[0]);
    query.mockResolvedValueOnce({ rows: [member] }).mockResolvedValueOnce({ rows: [{ ...member, revision: 'changed' }] });
    await expect(service.activity(account, wallet)).rejects.toMatchObject({ statusCode: 409 });
  });
});
