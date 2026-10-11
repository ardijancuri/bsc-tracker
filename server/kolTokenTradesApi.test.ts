import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerKolTokenTradesRoutes, kolTokenHistoryLimit } from './kolTokenTradesApi.js';

const mocks = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('./db.js', () => ({ pool: { query: mocks.query } }));
const wallet = '0x664d6645a04be9e27a8b33088f85025f29d45dc1';
const token = '0xdd806e436dda5588bf54061c11590c77ddc87777';
const date = '2026-10-08T01:00:00Z';
const identity = { kol: { address: wallet, name: 'Tavern', avatarUrl: null, twitter: null, source: 'gmgn', lastSeenAt: null },
  token: { address: token, name: 'SAFU', symbol: 'SAFU', logoUrl: null, priceUsd: null, marketCapUsd: null, marketCapSupply: '1000' },
  indexedTradeCount: 2, buyCount: 1, sellCount: 1, firstTradeAt: date, lastTradeAt: '2026-10-08T02:00:00Z' };
const history = ['sell', 'buy'].map((side, index) => ({ id: String(index), txHash: `hash-${index}`, walletAddress: wallet, tokenAddress: token,
  kolName: 'Tavern', kolAvatarUrl: null, kolTwitter: null, tokenSymbol: 'SAFU', tokenName: 'SAFU', tokenLogoUrl: null,
  side, tokenAmount: '2', amountUsd: side === 'sell' ? '50' : '20', priceUsd: null, quoteSymbol: 'BNB', quoteAmount: '1',
  timestamp: side === 'sell' ? identity.lastTradeAt : date, source: 'node', blockNumber: '100', transactionIndex: index, sharedQuote: false }));
afterEach(() => vi.resetAllMocks());

describe('KOL token activity API', () => {
  it('serves an exact pair beyond 24h, with verified supply MCAP and bounded history metadata', async () => {
    const app = Fastify(); registerKolTokenTradesRoutes(app);
    mocks.query.mockResolvedValueOnce({ rows: [identity] }).mockResolvedValueOnce({ rows: history });
    try {
      const response = await app.inject(`/api/kols/${wallet.toUpperCase().replace('0X', '0x')}/tokens/${token}/activity`);
      expect(response.statusCode).toBe(200); expect(response.headers['cache-control']).toBe('no-store');
      expect(response.json()).toMatchObject({ kol: { address: wallet }, token: { address: token },
        summary: { investedUsd: '20', soldUsd: '50', realizedProfitUsd: '30', avgBoughtMcapUsd: '10000' },
        coverage: { source: 'indexed', complete: true, indexedTradeCount: 2, returnedTradeCount: 2, historyLimit: 2000, costsIncluded: false } });
      const [identityCall, historyCall] = mocks.query.mock.calls;
      expect(identityCall[1]).toEqual([wallet, token]); expect(historyCall[1]).toEqual([wallet, token, kolTokenHistoryLimit]);
      expect(historyCall[0]).toContain('t.wallet_address=$1 AND t.token_address=$2');
      expect(historyCall[0]).toContain('k.is_tracked'); expect(historyCall[0]).toContain('t.block_number IS NOT NULL');
      expect(historyCall[0]).not.toContain("interval '24 hours'");
      expect(historyCall[0]).toContain('other.token_address<>t.token_address');
      expect(identityCall[0]).toContain("v.supply_checked_at>now()-interval '2 days'");
    } finally { await app.close(); }
  });
  it.each([['invalid', token, 400], [wallet, '0x123', 400], [wallet, 'x'.repeat(200), 414]])('rejects malformed wallet/token addresses without DB work', async (kol, address, status) => {
    const app = Fastify(); registerKolTokenTradesRoutes(app);
    try { expect((await app.inject(`/api/kols/${kol}/tokens/${address}/activity`)).statusCode).toBe(status); expect(mocks.query).not.toHaveBeenCalled(); }
    finally { await app.close(); }
  });
  it('returns not-found rather than a different wallet/contract or untracked identity', async () => {
    const app = Fastify(); registerKolTokenTradesRoutes(app); mocks.query.mockResolvedValue({ rows: [] });
    try { expect((await app.inject(`/api/kols/${wallet}/tokens/${token}/activity`)).statusCode).toBe(404); }
    finally { await app.close(); }
  });
  it('keeps full indexed counts and first/last dates but nulls monetary totals for truncated history', async () => {
    const app = Fastify(); registerKolTokenTradesRoutes(app);
    mocks.query.mockResolvedValueOnce({ rows: [{ ...identity, indexedTradeCount: 2500, buyCount: 1000, sellCount: 1500 }] })
      .mockResolvedValueOnce({ rows: history });
    try {
      const response = await app.inject(`/api/kols/${wallet}/tokens/${token}/activity`);
      expect(response.json()).toMatchObject({ summary: { investedUsd: null, soldUsd: null, realizedProfitUsd: null, avgBoughtMcapUsd: null,
        buyCount: 1000, sellCount: 1500, firstTradeAt: '2026-10-08T01:00:00.000Z' }, coverage: { complete: false, indexedTradeCount: 2500, returnedTradeCount: 2 } });
    } finally { await app.close(); }
  });
});
