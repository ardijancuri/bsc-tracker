import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerKolTokenTradesRoutes, kolTokenHistoryLimit } from './kolTokenTradesApi.js';

const mocks = vi.hoisted(() => ({ query: vi.fn(), inventory: vi.fn(), replay: vi.fn(), pnl: vi.fn() }));
vi.mock('./db.js', () => ({ pool: { query: mocks.query } }));
vi.mock('./kolTokenInventory.js', () => ({ currentKolTokenInventory: mocks.inventory }));
vi.mock('./tradeReplayGmgn.js', () => ({ currentTradeReplayGmgnAccounting: mocks.replay }));
vi.mock('./kolTokenGmgnPnl.js', () => ({ currentKolTokenGmgnPnl: mocks.pnl }));
const wallet = '0x664d6645a04be9e27a8b33088f85025f29d45dc1';
const token = '0xdd806e436dda5588bf54061c11590c77ddc87777';
const date = '2026-10-08T01:00:00Z';
const identity = { kol: { address: wallet, name: 'Tavern', avatarUrl: null, twitter: null, source: 'gmgn', lastSeenAt: null },
  token: { address: token, name: 'SAFU', symbol: 'SAFU', logoUrl: null, priceUsd: null, marketCapUsd: null, marketCapSupply: '1000', decimals: 0 }, firstBlock: '100',
  indexedTradeCount: 2, buyCount: 1, sellCount: 1, firstTradeAt: date, lastTradeAt: '2026-10-08T02:00:00Z' };
const history = ['sell', 'buy'].map((side, index) => ({ id: String(index), txHash: `hash-${index}`, walletAddress: wallet, tokenAddress: token,
  kolName: 'Tavern', kolAvatarUrl: null, kolTwitter: null, tokenSymbol: 'SAFU', tokenName: 'SAFU', tokenLogoUrl: null,
  side, tokenAmount: '2', amountUsd: side === 'sell' ? '50' : '20', priceUsd: null, quoteSymbol: 'BNB', quoteAmount: '1',
  timestamp: side === 'sell' ? identity.lastTradeAt : date, source: 'node', blockNumber: '100', transactionIndex: side === 'buy' ? 0 : 1, sharedQuote: false }));
afterEach(() => vi.resetAllMocks());
beforeEach(() => mocks.inventory.mockResolvedValue({ decimals: 0, initialBalanceRaw: '0', endingBalanceRaw: '0', transfers: [],
  coverage: { complete: true, reconciled: true, fromBlock: '100', toBlock: '100', blockHash: '0x' + '1'.repeat(64), checkedAt: new Date().toISOString(), balance: '0', status: 'verified', initialBalanceSource: 'historical_call' } }));

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
      expect(historyCall[0]).toContain('t.quote_token_address AS "quoteTokenAddress"');
      expect(historyCall[0]).toContain('k.is_tracked'); expect(historyCall[0]).toContain('t.block_number IS NOT NULL');
      expect(historyCall[0]).not.toContain("interval '24 hours'");
      expect(historyCall[0]).toContain('other.token_address<>t.token_address');
      expect(identityCall[0]).toContain("v.supply_checked_at>now()-interval '2 days'");
      expect(mocks.inventory).toHaveBeenCalledWith({ wallet, token, firstBlock: '100', decimals: 0, trades: history, tradesComplete: true });
      expect(response.json().inventory.coverage).toMatchObject({ complete: true, reconciled: true, balance: '0' });
      expect(mocks.replay).not.toHaveBeenCalled();
      expect(mocks.pnl).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
  it.each(['true', 'false', '1'])('requests policy-separated realized accounting only for pnl=%s when explicitly true', async pnl => {
    const app = Fastify(); registerKolTokenTradesRoutes(app);
    mocks.query.mockResolvedValueOnce({ rows: [identity] }).mockResolvedValueOnce({ rows: history });
    mocks.pnl.mockResolvedValue({ version: 1, source: 'gmgn', policy: 'gmgn_realized_profit_v1', walletAddress: wallet, tokenAddress: token,
      status: 'ready', checkedAt: new Date().toISOString(), realizedProfitUsd: '70', coverage: { transactionsComplete: true, balanceMatched: true } });
    try {
      const response = await app.inject(`/api/kols/${wallet}/tokens/${token}/activity?pnl=${pnl}`);
      expect(response.statusCode).toBe(200); expect(response.json().summary.realizedProfitUsd).toBe('30');
      if (pnl === 'true') {
        expect(mocks.pnl).toHaveBeenCalledOnce(); expect(mocks.pnl.mock.calls[0][1]).toBeUndefined();
        expect(mocks.pnl.mock.calls[0][2]).toEqual({ foreground: true });
        expect(response.json().realizedAccounting).toMatchObject({ policy: 'gmgn_realized_profit_v1', status: 'ready', realizedProfitUsd: '70' });
      } else { expect(mocks.pnl).not.toHaveBeenCalled(); expect(response.json().realizedAccounting).toBeUndefined(); }
      expect(mocks.replay).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
  it('shares one provider accounting call for both policies and reports its retry cooldown', async () => {
    const app = Fastify(); registerKolTokenTradesRoutes(app);
    mocks.query.mockResolvedValueOnce({ rows: [identity] }).mockResolvedValueOnce({ rows: history });
    const replay = { version: 1, source: 'gmgn', status: 'pending', coverage: { exactFinal: false } };
    mocks.replay.mockResolvedValue(replay);
    mocks.pnl.mockImplementation(async (_activity, supplied) => {
      expect(await supplied).toEqual(replay);
      return { status: 'pending', realizedProfitUsd: null, retryAfterMs: 45_000 };
    });
    try {
      const response = await app.inject(`/api/kols/${wallet}/tokens/${token}/activity?replay=true&pnl=true`);
      expect(mocks.replay).toHaveBeenCalledOnce(); expect(mocks.pnl).toHaveBeenCalledOnce();
      expect(response.headers['retry-after']).toBe('45');
      expect(response.json()).toMatchObject({ replayAccounting: replay, realizedAccounting: { status: 'pending', realizedProfitUsd: null } });
    } finally { await app.close(); }
  });
  it('retains historical realized gains and requests a paced retry while an open position needs a current mark', async () => {
    const app = Fastify(); registerKolTokenTradesRoutes(app);
    mocks.query.mockResolvedValueOnce({ rows: [identity] }).mockResolvedValueOnce({ rows: history });
    mocks.pnl.mockResolvedValue({ version: 1, source: 'gmgn', policy: 'gmgn_realized_profit_v1', walletAddress: wallet, tokenAddress: token,
      status: 'ready', checkedAt: new Date().toISOString(), realizedProfitUsd: '70', coverage: { transactionsComplete: true, balanceMatched: true },
      position: { status: 'open', estimatedProfitUsd: null, reason: 'quote_rate_limited', retryAfterMs: 45_000 } });
    try {
      const response = await app.inject(`/api/kols/${wallet}/tokens/${token}/activity?pnl=true`);
      expect(response.statusCode).toBe(200); expect(response.headers['retry-after']).toBe('45');
      expect(response.json().realizedAccounting).toMatchObject({ status: 'ready', realizedProfitUsd: '70', position: { status: 'open', estimatedProfitUsd: null } });
      expect(mocks.replay).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
  it.each(['true', 'false', '1'])('requests additional GMGN accounting only for replay=%s when explicitly true', async replay => {
    const app = Fastify(); registerKolTokenTradesRoutes(app);
    mocks.query.mockResolvedValueOnce({ rows: [identity] }).mockResolvedValueOnce({ rows: history });
    mocks.replay.mockResolvedValue({ version: 1, source: 'gmgn', status: 'pending', retryAfterMs: 1000, coverage: { exactFinal: false } });
    try {
      const response = await app.inject(`/api/kols/${wallet}/tokens/${token}/activity?replay=${replay}`);
      expect(response.statusCode).toBe(200);
      if (replay === 'true') {
        expect(mocks.replay).toHaveBeenCalledOnce();
        expect(mocks.replay.mock.calls[0][0]).toMatchObject({ kol: { address: wallet }, token: { address: token }, inventory: { coverage: { reconciled: true } } });
        expect(response.json().replayAccounting).toMatchObject({ status: 'pending', retryAfterMs: 1000 });
        expect(mocks.pnl).toHaveBeenCalledOnce();
        expect(mocks.pnl.mock.calls[0][1]).toEqual(response.json().replayAccounting);
        expect(mocks.pnl.mock.calls[0][2]).toEqual({ markPosition: false });
        expect(response.json().realizedAccounting).toBeUndefined();
      } else { expect(mocks.replay).not.toHaveBeenCalled(); expect(response.json().replayAccounting).toBeUndefined(); }
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
  it('withholds inventory profit while canonical movement coverage is pending', async () => {
    mocks.inventory.mockResolvedValue({ decimals: 0, initialBalanceRaw: null, endingBalanceRaw: null, transfers: [],
      coverage: { complete: false, reconciled: false, fromBlock: '100', toBlock: '200', blockHash: null, checkedAt: null, balance: null, status: 'pending', reason: 'scan_pending' } });
    mocks.query.mockResolvedValueOnce({ rows: [identity] }).mockResolvedValueOnce({ rows: history });
    const app = Fastify(); registerKolTokenTradesRoutes(app);
    try {
      const response = await app.inject(`/api/kols/${wallet}/tokens/${token}/activity`);
      expect(response.headers['retry-after']).toBe('1');
      expect(response.json()).toMatchObject({ summary: { investedUsd: '20', soldUsd: '50', realizedProfitUsd: null, remainingTokenAmount: null, remainingCostBasisUsd: null, status: 'unknown' },
        inventory: { coverage: { complete: false, reconciled: false, status: 'pending', reason: 'scan_pending' } } });
    } finally { await app.close(); }
  });
  it('returns 202 promptly for profile preparation, coalesces polls, and returns the completed result', async () => {
    const app = Fastify(); registerKolTokenTradesRoutes(app);
    mocks.query.mockImplementation(async sql => ({ rows: sql.includes('json_build_object') ? [identity] : history }));
    const evidence = await mocks.inventory(); mocks.inventory.mockClear();
    let finish!: (value: typeof evidence) => void;
    mocks.inventory.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    mocks.pnl.mockResolvedValue({ status: 'ready', realizedProfitUsd: '70' });
    try {
      const started = performance.now();
      const response = await app.inject(`/api/kols/${wallet}/tokens/${token}/activity?pnl=true&profile=true`);
      expect(response.statusCode).toBe(202); expect(response.json()).toEqual({ status: 'pending' });
      expect(response.headers['retry-after']).toBe('1'); expect(response.headers['cache-control']).toBe('no-store');
      expect(performance.now() - started).toBeLessThan(1000);
      expect(mocks.inventory).toHaveBeenCalledWith({ wallet, token, firstBlock: '100', decimals: 0,
        trades: history, tradesComplete: true, priority: 'background' });
      expect((await app.inject(`/api/kols/${wallet}/tokens/${token}/activity?pnl=true&profile=true`)).statusCode).toBe(202);
      expect(mocks.inventory).toHaveBeenCalledOnce(); expect(mocks.pnl).not.toHaveBeenCalled();
      finish(evidence);
      await vi.waitFor(() => expect(mocks.pnl).toHaveBeenCalledOnce());
      const completed = await app.inject(`/api/kols/${wallet}/tokens/${token}/activity?pnl=true&profile=true`);
      expect(completed.statusCode).toBe(200);
      expect(completed.json()).toMatchObject({ realizedAccounting: { status: 'ready', realizedProfitUsd: '70' } });
      expect(mocks.inventory).toHaveBeenCalledOnce(); expect(mocks.query).toHaveBeenCalledTimes(6);
    } finally { finish?.(evidence); await app.close(); }
  });
  it.each(['profile=true', 'profile=true&pnl=false', 'profile=true&pnl=true&replay=true', 'pnl=true'])(
    'keeps foreground inventory and complete responses for %s', async parameters => {
      const app = Fastify(); registerKolTokenTradesRoutes(app);
      mocks.query.mockResolvedValueOnce({ rows: [identity] }).mockResolvedValueOnce({ rows: history });
      mocks.replay.mockResolvedValue({ status: 'ready' }); mocks.pnl.mockResolvedValue({ status: 'ready', realizedProfitUsd: '70' });
      try {
        expect((await app.inject(`/api/kols/${wallet}/tokens/${token}/activity?${parameters}`)).statusCode).toBe(200);
        expect(mocks.inventory).toHaveBeenCalledOnce(); expect(mocks.inventory.mock.calls[0][0].priority).toBeUndefined();
        if (parameters.includes('replay=true')) expect(mocks.replay).toHaveBeenCalledOnce();
      } finally { await app.close(); }
    });
  it('invalidates a profile snapshot after a corrected historical cost without a changed last trade date', async () => {
    const app = Fastify(); registerKolTokenTradesRoutes(app);
    let selectedHistory = history.map(trade => ({ ...trade })), selectedIdentity = { ...identity };
    mocks.query.mockImplementation(async sql => ({ rows: sql.includes('json_build_object') ? [selectedIdentity] : selectedHistory }));
    mocks.pnl.mockResolvedValueOnce({ status: 'ready', realizedProfitUsd: '70' }).mockResolvedValueOnce({ status: 'ready', realizedProfitUsd: '69' })
      .mockResolvedValueOnce({ status: 'ready', realizedProfitUsd: '59' });
    try {
      const url = `/api/kols/${wallet}/tokens/${token}/activity?pnl=true&profile=true`;
      const first = await app.inject(url), same = await app.inject(url);
      expect(first.statusCode).toBe(200); expect(same.json()).toEqual(first.json()); expect(mocks.inventory).toHaveBeenCalledOnce();
      selectedHistory = selectedHistory.map(trade => trade.side === 'buy' ? { ...trade, amountUsd: '21' } : trade);
      const corrected = await app.inject(url);
      expect(corrected.statusCode).toBe(200); expect(mocks.inventory).toHaveBeenCalledTimes(2); expect(mocks.pnl).toHaveBeenCalledTimes(2);
      expect(corrected.json()).toMatchObject({ summary: { investedUsd: '21', lastTradeAt: new Date(identity.lastTradeAt).toISOString() },
        realizedAccounting: { realizedProfitUsd: '69' } });
      selectedIdentity = { ...identity, indexedTradeCount: 3, buyCount: 2 };
      selectedHistory = [...selectedHistory, { ...selectedHistory[1], id: 'reindexed-buy', txHash: 'reindexed-hash', amountUsd: '10' }];
      const expanded = await app.inject(url);
      expect(expanded.statusCode).toBe(200); expect(mocks.inventory).toHaveBeenCalledTimes(3);
      expect(expanded.json()).toMatchObject({ coverage: { indexedTradeCount: 3, complete: true }, summary: { buyCount: 2, investedUsd: '31' },
        realizedAccounting: { realizedProfitUsd: '59' } });
    } finally { await app.close(); }
  });
});
