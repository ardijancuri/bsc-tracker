import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { KolTokenActivity } from '../shared/kolTokenTrades';
import { createKolTokenPnlLoader, displayedTokenPnl, tokenPnlExpiresAt, tokenPnlRefreshDelay, tokenPositionPnlDescription,
  tokenPositionPnlLoadingNotice, tokenPositionPnlUnavailableNotice, verifiedTokenPositionPnl } from './kolTokenPnlRequest';
const now = Date.parse('2026-10-19T12:00:00Z'), date = new Date(now).toISOString();
const wallet = `0x${'a'.repeat(40)}`, token = `0x${'b'.repeat(40)}`, blockHash = `0x${'c'.repeat(64)}`;
function activity(source: 'node' | 'mixed' | 'imported' = 'node'): KolTokenActivity {
  return { kol: { address: wallet, name: 'KOL', avatarUrl: null, twitter: null, source: 'node', lastSeenAt: date },
    token: { address: token, symbol: 'TEST', name: 'Test', logoUrl: null, priceUsd: '2', marketCapUsd: '2000', marketCapSupply: '1000' }, trades: [],
    summary: { investedUsd: '10', soldUsd: '0', realizedProfitUsd: '0', avgBoughtPriceUsd: '1', avgSoldPriceUsd: null, avgBoughtMcapUsd: '1000', avgSoldMcapUsd: null,
      remainingTokenAmount: '10', remainingCostBasisUsd: '11', buyCount: 1, sellCount: 0, valuedBuyCount: 1, valuedSellCount: 0, excludedSellCount: 0, unpricedTradeCount: 0,
      firstTradeAt: date, lastTradeAt: date, status: 'open', profitBasis: 'observed_fifo' },
    coverage: { source: 'indexed', indexedTradeCount: 1, returnedTradeCount: 1, complete: true, historyLimit: 100000, costsIncluded: false }, generatedAt: date,
    accountingSnapshot: { version: 2, snapshotId: '1'.repeat(64), source, scope: 'public', asOf: date, historyFingerprint: '2'.repeat(64), historyFrom: date,
      coveredThroughBlock: '200', valuationBlock: '200', valuationHash: blockHash, complete: true, reasons: [] },
    realizedAccounting: { version: 2, source, policy: 'kollens_fifo_v1', walletAddress: wallet, tokenAddress: token, status: 'ready', checkedAt: date, realizedProfitUsd: '0',
      position: { status: 'open', estimatedProfitUsd: '9', estimatedRoi: '0.818181818181818181818181818181818182', unrealizedProfitUsd: '9', remainingTokenAmount: '10',
        remainingCostBasisUsd: '11', feeInclusiveCostUsd: '11', priceUsd: '2', pricedAt: date, valuationSource: source },
      coverage: { transactionsComplete: true, balanceMatched: true, verification: source === 'node' ? 'node_history' : source === 'mixed' ? 'mixed_history' : 'imported_history',
        historyFingerprint: '2'.repeat(64), balanceProof: { walletAddress: wallet, tokenAddress: token, chain: 'bsc', blockNumber: '200', blockHash, blockTimestamp: date, balance: '10', checkedAt: date } } } };
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); });
afterEach(() => vi.useRealTimers());
describe('VPS snapshot P&L contract', () => {
  it('explains pending native payment verification before secondary unknown purchase costs', () => {
    const body=activity();body.accountingSnapshot!.complete=false;
    body.accountingSnapshot!.reasons=['purchase_cost_unknown','native_trace_required'];
    body.realizedAccounting!.status='pending';
    expect(displayedTokenPnl(body)).toBeNull();
    expect(tokenPositionPnlUnavailableNotice(body)).toBe('Waiting for the node to verify native BNB spent or received.');
  });
  it.each(['node', 'mixed', 'imported'] as const)('displays server-approved %s profit without the retired inventory contract', source => {
    const body = activity(source); expect(displayedTokenPnl(body)).toBe(9); expect(body.inventory).toBeUndefined();
    expect(tokenPositionPnlDescription(body)).not.toContain('GMGN'); expect(tokenPositionPnlLoadingNotice(body)).not.toContain('GMGN');
  });
  it('does not reimplement accounting eligibility or cash-flow arithmetic in the browser', () => {
    const body = activity(); body.realizedAccounting!.position!.estimatedProfitUsd = '123.456';
    expect(verifiedTokenPositionPnl(body)).toBe(123.456);
  });
  it.each(['wallet', 'token', 'version', 'snapshot', 'fingerprint', 'source', 'balance', 'block', 'hash', 'quote', 'future', 'stale'] as const)('rejects a mismatched %s envelope', variant => {
    const body = activity(), proof = body.realizedAccounting!.coverage.balanceProof!, identity = body.accountingSnapshot!;
    if (variant === 'wallet') body.realizedAccounting!.walletAddress = token;
    if (variant === 'token') proof.tokenAddress = wallet;
    if (variant === 'version') identity.version = 1 as 2;
    if (variant === 'snapshot') identity.snapshotId = 'wrong';
    if (variant === 'fingerprint') identity.historyFingerprint = '3'.repeat(64);
    if (variant === 'source') identity.source = 'mixed';
    if (variant === 'balance') proof.balance = '10.000000000000000001';
    if (variant === 'block') identity.coveredThroughBlock = '199';
    if (variant === 'hash') identity.valuationHash = 'broken';
    if (variant === 'quote') body.realizedAccounting!.position!.pricedAt = null;
    if (variant === 'future') identity.asOf = new Date(now + 5000).toISOString();
    if (variant === 'stale') vi.setSystemTime(now + 181_000);
    expect(displayedTokenPnl(body)).toBeNull();
  });
  it('retains original dated amounts while the server refreshes a saved valid snapshot', () => {
    const body = activity(); body.accountingSnapshot!.refreshStatus = 'pending'; body.accountingSnapshot!.refreshReason = 'indexing_lag';
    vi.setSystemTime(now + 3600_000);
    expect(displayedTokenPnl(body)).toBe(9); expect(tokenPositionPnlDescription(body)).toContain('2026-10-19 12:00:00 UTC');
    expect(tokenPositionPnlDescription(body)).toContain('Saved profit'); expect(tokenPnlExpiresAt(body)).toBeNull();
    expect(body.accountingSnapshot!.asOf).toBe(date); expect(tokenPnlRefreshDelay({ activity: body, status: 'ready' }, 0)).toBe(2000);
  });
  it('returns a precise missing-cost explanation without suggesting another provider API request', () => {
    const body = activity(); body.accountingSnapshot!.complete = false; body.accountingSnapshot!.reasons = ['incoming_transfer_cost_unknown'];
    body.realizedAccounting!.status = 'unavailable';
    expect(displayedTokenPnl(body)).toBeNull(); expect(tokenPositionPnlUnavailableNotice(body)).toBe('Purchase or incoming-transfer costs are unavailable for this position.');
  });
  it('identifies a historical import cooldown without describing all node data as unavailable', () => {
    const body = activity(); body.accountingSnapshot!.complete = false;
    body.accountingSnapshot!.reasons = ['historical_baseline_required', 'historical_import_cooldown'];
    body.realizedAccounting!.status = 'pending';
    expect(tokenPositionPnlUnavailableNotice(body)).toBe('Historical data import is waiting for the provider cooldown.');
  });
  it('accepts a closed position with no current market quote', () => {
    const body = activity(); body.realizedAccounting!.realizedProfitUsd = '-2';
    Object.assign(body.realizedAccounting!.position!, { status: 'closed', remainingTokenAmount: '0', priceUsd: null, pricedAt: null });
    body.realizedAccounting!.coverage.balanceProof!.balance = '0'; expect(displayedTokenPnl(body)).toBe(-2);
  });
  it('loads a selected modern trade immediately from the shared server snapshot', async () => {
    const fetcher = vi.fn(async () => ({ ok: true, status: 200, headers: new Headers(), json: async () => activity() } as Response));
    const load = createKolTokenPnlLoader({ fetcher, now: () => now });
    const result = await load({ walletAddress: wallet, tokenAddress: token, lastTradeAt: date }, new AbortController().signal, { priority: 'foreground' });
    expect(result.status).toBe('ready'); expect(displayedTokenPnl(result.activity)).toBe(9); expect(fetcher).toHaveBeenCalledOnce();
  });
});
