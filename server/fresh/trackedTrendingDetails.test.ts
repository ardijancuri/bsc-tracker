import { expect, it, vi } from 'vitest';
import type { TrendingToken } from '../../shared/trendingTokens.js';
import { createTrackedTrendingDetails } from './trackedTrendingDetails.js';
import type { TrendingLaunchMarketRequest } from './trendingLaunchMarket.js';

const address = (n: number) => '0x' + n.toString(16).padStart(40, '0');
const token = (n: number): TrendingToken => ({
  address: address(n), name: 'Tracked', symbol: 'TOKEN', logoUrl: null, marketCapUsd: null,
  volumeUsd: '700', volumeIncomplete: false, kolCount: 2, buyCount: 4, sellCount: 6, recentKols: [],
});
const time = Date.parse('2026-11-21T02:50:00Z');
const block = { number: 100, hash: '0x' + '1'.repeat(64), timestamp: new Date(time - 3000).toISOString() };

it('resolves the launch pair and effective tax independently of USD valuation and reuses the result', async () => {
  const row = token(1);
  const context = new Map([[row.address, { protocol: 'flap' as const }]]);
  const marketLookup = {
    confirmedBlock: vi.fn(async () => block),
    read: vi.fn(async () => ({ quoteSymbol: 'FXIon', buyTaxBps: 0, sellTaxBps: 100 })),
  };
  const fetcher = vi.fn<typeof fetch>(async () => Response.json([]));
  const enrich = createTrackedTrendingDetails({ marketLookup, fetcher, now: () => time });
  const expected = [{ ...row, quoteSymbol: 'FXIon', buyTaxBps: 0, sellTaxBps: 100, taxAsOf: block.timestamp }];
  expect(await enrich([row], context)).toEqual(expected);
  expect(await enrich([row], context)).toEqual(expected);
  expect(marketLookup.read).toHaveBeenCalledExactlyOnceWith({ address: row.address, protocol: 'flap' }, block);
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it('refreshes dated rates and rejects a near-expiry replacement', async () => {
  const expiring = { ...token(2), quoteSymbol: 'NFLXB' };
  const stale = { ...token(1), quoteSymbol: 'NFLXB', buyTaxBps: 100, sellTaxBps: 100,
    taxAsOf: new Date(time - 6 * 60_000).toISOString() };
  const context = new Map([stale, expiring].map(item => [item.address, { protocol: 'flap' as const }]));
  const marketLookup = {
    confirmedBlock: vi.fn(async () => block),
    read: vi.fn(async ({ address: contract }) => ({ buyTaxBps: 0, sellTaxBps: 25,
      expiresAtSeconds: time / 1000 + (contract === stale.address ? 300 : 10) })),
  };
  const fetcher = vi.fn<typeof fetch>();
  const enrich = createTrackedTrendingDetails({ marketLookup, fetcher, now: () => time });
  expect(await enrich([stale, expiring], context)).toEqual([
    { ...stale, buyTaxBps: 0, sellTaxBps: 25, taxAsOf: block.timestamp }, expiring,
  ]);
  expect(fetcher).not.toHaveBeenCalled();
});

it('uses only an exact BSC pool for a bound market and labels provider-only tax data', async () => {
  const row = token(1);
  const quote = address(4), market = address(5), competingPool = address(6);
  const pool = { chainId: 'bsc', pairAddress: market, baseToken: { address: row.address },
    quoteToken: { address: quote, symbol: 'ZEC' }, liquidity: { usd: 100 } };
  const fetcher = vi.fn<typeof fetch>(async url => Response.json(String(url).includes('dexscreener') ? [
    { ...pool, chainId: 'other', pairAddress: market, quoteToken: { address: quote, symbol: 'WRONG' }, liquidity: { usd: 400 } },
    { ...pool, pairAddress: competingPool, quoteToken: { address: quote, symbol: 'WRONG' }, liquidity: { usd: 300 } },
    { ...pool, baseToken: { address: 17 }, liquidity: { usd: 200 } },
    pool,
  ] : { code: 1, result: { [row.address]: { buy_tax: '0', sell_tax: '' } } }));
  const enrich = createTrackedTrendingDetails({ fetcher, now: () => time });
  expect(await enrich([row], new Map([[row.address, { marketAddress: market, quoteAddress: quote }]]))).toEqual([
    { ...row, quoteSymbol: 'ZEC', quoteSource: 'dexscreener', buyTaxBps: 0, taxSource: 'goplus' },
  ]);
});

it('bounds requests across repeated feed reads and advances to unseen contracts', async () => {
  let clock = time;
  const rows = [1, 2, 3, 4, 5].map(token);
  const marketLookup = { confirmedBlock: vi.fn(async () => block), read: vi.fn(async (_request: TrendingLaunchMarketRequest) => ({})) };
  const contexts = new Map(rows.map(item => [item.address, { protocol: 'fourmeme' as const }]));
  const fetcher = vi.fn<typeof fetch>(async () => Response.json([]));
  const enrich = createTrackedTrendingDetails({ marketLookup, fetcher, now: () => clock });
  expect(await enrich(rows, contexts)).toEqual(rows);
  await enrich(rows, contexts);
  expect(marketLookup.read).toHaveBeenCalledTimes(4);
  clock += 60_001;
  await enrich(rows, contexts);
  expect(marketLookup.read.mock.calls[4]?.[0]).toEqual({ address: rows[4].address, protocol: 'fourmeme' });
});
