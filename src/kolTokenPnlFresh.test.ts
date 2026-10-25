import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { KolTokenActivity } from '../shared/kolTokenTrades';
import type { JournalTokenActivity } from '../shared/journal';
import { createKolTokenPnlLoader, displayedTokenPnl, tokenPnlExpiresAt, tokenPnlRefreshDelay, verifiedTokenPositionPnl, verifiedTokenRealizedPnl } from './kolTokenPnlRequest';
const now = Date.parse('2026-10-22T12:00:00Z'), earlier = '2026-10-21T11:00:00Z', current = '2026-10-22T12:00:00Z';
const wallet = `0x${'1'.repeat(40)}`, token = `0x${'7'.repeat(40)}`, accountId = '11111111-1111-4111-8111-111111111111';
function activity(open = false): KolTokenActivity {
  const asOf = open ? current : earlier;
  return { tracking: { version: 1, source: 'fresh', fromBlock: '100', utcDay: '2026-10-22' },
    kol: { address: wallet, name: 'Fresh KOL', avatarUrl: null, twitter: null, source: 'node', lastSeenAt: earlier },
    token: { address: token, name: 'Token', symbol: 'TEST', logoUrl: null, priceUsd: open ? '10' : null, marketCapUsd: null, marketCapSupply: null },
    trades: [], summary: { investedUsd: '100', soldUsd: '140', realizedProfitUsd: '38', avgBoughtPriceUsd: null, avgSoldPriceUsd: null, avgBoughtMcapUsd: null, avgSoldMcapUsd: null,
      remainingTokenAmount: open ? '10' : '0', remainingCostBasisUsd: open ? '60' : '0', buyCount: 1, sellCount: 1, valuedBuyCount: 1, valuedSellCount: 1, excludedSellCount: 0, unpricedTradeCount: 0, firstTradeAt: earlier, lastTradeAt: earlier, status: open ? 'open' : 'closed', profitBasis: 'observed_fifo' },
    accountingSnapshot: { version: 2, snapshotId: 'a'.repeat(64), source: 'node', scope: 'public', asOf, historyFingerprint: 'b'.repeat(64), historyFrom: earlier, coveredThroughBlock: '200', valuationBlock: open ? '200' : null, valuationHash: open ? `0x${'c'.repeat(64)}` : null, complete: true, reasons: [], historyBoundary: 'token_creation' },
    realizedAccounting: { version: 2, source: 'node', policy: 'kollens_fifo_v1', walletAddress: wallet, tokenAddress: token, status: 'ready', checkedAt: asOf, realizedProfitUsd: '38',
      coverage: { transactionsComplete: true, balanceMatched: true, verification: 'node_history' },
      position: { status: open ? 'open' : 'closed', estimatedProfitUsd: open ? '78' : '38', estimatedRoi: open ? '0.78' : '0.38', unrealizedProfitUsd: open ? '40' : '0',
        remainingTokenAmount: open ? '10' : '0', remainingCostBasisUsd: open ? '60' : '0', feeInclusiveCostUsd: '102', priceUsd: open ? '10' : null, pricedAt: open ? current : null, valuationSource: 'node',
        cashFlow: { investedUsd: '100', soldUsd: '140', transferOutIncomeUsd: '0', feesUsd: '2' } } },
    // This is a paginated detail/card response, not the replay's full ledger.
    coverage: { source: 'indexed', complete: false, indexedTradeCount: 500, returnedTradeCount: 100, historyLimit: 100, costsIncluded: false }, generatedAt: current };
}
function privateActivity(): JournalTokenActivity {
  const body = activity(); body.accountingSnapshot!.scope = 'portfolio'; body.accountingSnapshot!.historyBoundary = 'membership_added';
  return Object.assign(body, { journal: { accountId, walletAddress: wallet, membershipRevision: '22222222-2222-4222-8222-222222222222', preparedAt: current, private: true as const } });
}
const response = (body: unknown) => ({ ok: true, status: 200, headers: new Headers(), async json() { return body; } }) as Response;
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); }); afterEach(() => vi.useRealTimers());
describe('fresh current-row P&L responses', () => {
  it('shows server-approved closed profit without a receipt history, inventory copy or fresh market quote', () => {
    const body = activity(); expect(body.inventory).toBeUndefined(); expect(body.replayAccounting).toBeUndefined();
    expect(verifiedTokenPositionPnl(body)).toBe(38); expect(displayedTokenPnl(body)).toBe(38); expect(tokenPnlExpiresAt(body)).toBeNull();
    vi.advanceTimersByTime(8 * 24 * 60 * 60 * 1000); expect(verifiedTokenRealizedPnl(body)).toBe(38); expect(displayedTokenPnl(body)).toBe(38);
  });
  it('expires an open estimate at two minutes while retaining the historical realized result', () => {
    const body = activity(true); expect(verifiedTokenPositionPnl(body)).toBe(78); expect(tokenPnlExpiresAt(body)).toBe(now + 120_001);
    vi.advanceTimersByTime(120_001); expect(verifiedTokenPositionPnl(body)).toBeNull(); expect(verifiedTokenRealizedPnl(body)).toBe(38); expect(displayedTokenPnl(body)).toBe(38); expect(tokenPnlExpiresAt(body)).toBeNull();
  });
  it.each(['wallet', 'token', 'version', 'source', 'boundary', 'coverage', 'balance', 'snapshot', 'status', 'asOf', 'future', 'valuation'] as const)('rejects incompatible fresh contract %s', variant => {
    const body = activity(true);
    if (variant === 'wallet') body.realizedAccounting!.walletAddress = token;
    if (variant === 'token') body.realizedAccounting!.tokenAddress = wallet;
    if (variant === 'version') (body.tracking as any).version = 2;
    if (variant === 'source') (body.tracking as any).source = 'gmgn';
    if (variant === 'boundary') body.tracking!.fromBlock = '201';
    if (variant === 'coverage') body.realizedAccounting!.coverage.transactionsComplete = false;
    if (variant === 'balance') body.realizedAccounting!.coverage.balanceMatched = false;
    if (variant === 'snapshot') body.accountingSnapshot!.complete = false;
    if (variant === 'status') body.realizedAccounting!.status = 'unavailable';
    if (variant === 'asOf') body.realizedAccounting!.checkedAt = earlier;
    if (variant === 'future') body.accountingSnapshot!.asOf = body.realizedAccounting!.checkedAt = new Date(now + 2_000).toISOString();
    if (variant === 'valuation') body.accountingSnapshot!.valuationHash = null;
    expect(verifiedTokenPositionPnl(body)).toBeNull();
  });
  it('requires private membership identity and never caches a private response through a public route', async () => {
    const body = privateActivity(), fetcher = vi.fn(async () => response(body)), loader = createKolTokenPnlLoader({ fetcher, now: () => now });
    const selected = { walletAddress: wallet, tokenAddress: token, lastTradeAt: earlier };
    expect(await loader(selected, new AbortController().signal)).toEqual({ activity: null, status: 'unavailable' });
    expect((await loader({ ...selected, requestContext: { kind: 'journal', accountId } }, new AbortController().signal)).status).toBe('ready');
    expect((await loader({ ...selected, requestContext: { kind: 'journal', accountId: 'wrong-account' } }, new AbortController().signal)).status).toBe('unavailable');
    delete (body as any).journal; expect(verifiedTokenPositionPnl(body)).toBeNull();
  });
  it('loads a light paginated profile activity in one database-backed response', async () => {
    const body = activity(), fetcher = vi.fn(async () => response(body)), loader = createKolTokenPnlLoader({ fetcher, now: () => now });
    const result = await loader({ walletAddress: wallet, tokenAddress: token, lastTradeAt: earlier }, new AbortController().signal);
    expect(result.status).toBe('ready'); expect(result.activity).toBe(body); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('returns independently approved realized cash immediately while an open quote refresh waits', async () => {
    const body = activity(true); body.tracking!.realizedComplete = true; body.accountingSnapshot!.valuationBlock = body.accountingSnapshot!.valuationHash = null;
    body.accountingSnapshot!.refreshStatus = 'pending'; body.accountingSnapshot!.refreshReason = 'quote_unavailable';
    Object.assign(body.realizedAccounting!.position!, { estimatedProfitUsd: null, priceUsd: null, pricedAt: null, reason: 'quote_unavailable' });
    const fetcher = vi.fn(async () => response(body)), loader = createKolTokenPnlLoader({ fetcher, now: () => now });
    const result = await loader({ walletAddress: wallet, tokenAddress: token, lastTradeAt: earlier }, new AbortController().signal);
    expect(result.status).toBe('ready'); expect(displayedTokenPnl(result.activity)).toBe(38); expect(fetcher).toHaveBeenCalledTimes(1);
    expect(tokenPnlRefreshDelay(result, 0)).toBe(2000);
  });
});
