import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { KolTokenActivity } from '../shared/kolTokenTrades';
import { createKolTokenPnlLoader, displayedTokenPnl, kolTokenPnlKey, terminalTokenInventoryFailure, tokenPnlExpiresAt, tokenPnlMayRetainDuringProviderRetry, tokenPnlMovementsMatch, tokenPnlRefreshDelay, tokenPositionPnlDescription, tokenPositionPnlLabel, tokenPositionPnlLoadingNotice, tokenPositionPnlPriceTime, tokenPositionPnlUnavailableNotice, verifiedTokenPositionPnl, verifiedTokenRealizedPnl, type KolTokenPnlSelection } from './kolTokenPnlRequest';

const wallet = '0x' + '1'.repeat(40), date = '2026-10-14T12:00:00Z';
const selection = (index = 2): KolTokenPnlSelection => ({ walletAddress: wallet, tokenAddress: '0x' + index.toString(16).padStart(40, '0'), lastTradeAt: date });
function activity(selected = selection(), value: string | null = '30'): KolTokenActivity {
  return { kol: { address: selected.walletAddress, name: 'Trader', avatarUrl: null, twitter: null, source: 'node', lastSeenAt: date },
    token: { address: selected.tokenAddress, symbol: 'TEST', name: 'Test', logoUrl: null, priceUsd: '1', marketCapUsd: '1000', marketCapSupply: '1000' },
    trades: [], generatedAt: date, coverage: { source: 'indexed', complete: true, indexedTradeCount: 0, returnedTradeCount: 0, historyLimit: 2000, costsIncluded: false },
    summary: { investedUsd: '20', soldUsd: '50', realizedProfitUsd: value, avgBoughtPriceUsd: '1', avgSoldPriceUsd: '2.5', avgBoughtMcapUsd: '1000', avgSoldMcapUsd: '2500',
      remainingTokenAmount: '0', remainingCostBasisUsd: '0', buyCount: 1, sellCount: 1, valuedBuyCount: 1, valuedSellCount: value === null ? 0 : 1,
      excludedSellCount: value === null ? 1 : 0, unpricedTradeCount: 0, firstTradeAt: date, lastTradeAt: date, status: 'closed', profitBasis: 'observed_fifo' },
    inventory: { version: 1, events: [], coverage: { complete: true, reconciled: true, fromBlock: '1', toBlock: '2', blockHash: '0x' + 'a'.repeat(64), checkedAt: date, balance: '0', status: 'verified' } },
    realizedAccounting: { version: 1, source: 'gmgn', policy: 'gmgn_realized_profit_v1', walletAddress: selected.walletAddress,
      tokenAddress: selected.tokenAddress, status: value === null ? 'unavailable' : 'ready', checkedAt: date, realizedProfitUsd: value,
      coverage: { transactionsComplete: true, balanceMatched: true, ...(value === null ? { reason: 'gmgn_realized_cost_unavailable' } : {}) } } };
}
function pending(selected = selection(), reason = 'scan_pending') {
  const body = activity(selected, null);
  body.inventory!.coverage = { ...body.inventory!.coverage, complete: false, reconciled: false, status: 'pending', reason };
  body.realizedAccounting!.status = 'pending';
  body.realizedAccounting!.coverage.reason = reason;
  return body;
}
const response = (body: unknown, status = 200, retryAfter?: string) => ({ ok: status >= 200 && status < 300, status,
  headers: new Headers(retryAfter ? { 'Retry-After': retryAfter } : {}), json: async () => body }) as Response;
const signal = () => new AbortController().signal;
function openPosition() {
  const body = activity();
  body.inventory!.coverage.balance = body.summary.remainingTokenAmount = '10';
  body.summary.status = 'open';
  body.realizedAccounting!.position = { status: 'open', estimatedProfitUsd: '70', estimatedRoi: '3.5', unrealizedProfitUsd: '40',
    priceUsd: '5', pricedAt: date, valuationSource: 'market', remainingTokenAmount: '10', remainingCostBasisUsd: '10', feeInclusiveCostUsd: '20' };
  return body;
}
function gmgnHistory(body = activity()) {
  const balance = body.inventory!.coverage.balance!;
  body.inventory!.coverage = { ...body.inventory!.coverage, complete: false, reconciled: false, status: 'unavailable',
    reason: 'inventory_history_unavailable', balance: null, checkedAt: null };
  body.realizedAccounting!.coverage = { transactionsComplete: true, balanceMatched: true, verification: 'gmgn_history',
    historyFingerprint: 'b'.repeat(64), historyCheckedAt: date, lastMovementAt: date,
    balanceProof: { walletAddress: body.kol.address, tokenAddress: body.token.address, chain: 'bsc', blockNumber: '1000',
      blockHash: '0x' + 'c'.repeat(64), blockTimestamp: date, balance, checkedAt: date } };
  return body;
}
function gmgnAggregate(body = activity()) {
  const inventory = structuredClone(body.inventory!);
  gmgnHistory(body); body.inventory = inventory;
  body.realizedAccounting!.coverage.reason = 'gmgn_aggregate_verified';
  Object.assign(body.realizedAccounting!.coverage.balanceProof!, {
    blockNumber: inventory.coverage.toBlock, blockHash: inventory.coverage.blockHash,
  });
  return body;
}
function trackedAccounting(body = activity()) {
  Object.assign(body.realizedAccounting!, { source: 'onchain', policy: 'onchain_net_trade_profit_v1' });
  body.realizedAccounting!.coverage.reason = 'onchain_estimate_gas_excluded';
  body.realizedAccounting!.position ??= { status: 'closed', estimatedProfitUsd: body.realizedAccounting!.realizedProfitUsd,
    estimatedRoi: '1.5', unrealizedProfitUsd: '0', remainingTokenAmount: '0', remainingCostBasisUsd: '0', feeInclusiveCostUsd: '20',
    priceUsd: null, pricedAt: null, valuationSource: null };
  const position = body.realizedAccounting!.position;
  position.cashFlow = { investedUsd: position.feeInclusiveCostUsd,
    soldUsd: String(Number(body.realizedAccounting!.realizedProfitUsd) + Number(position.feeInclusiveCostUsd) - Number(position.remainingCostBasisUsd)),
    transferOutIncomeUsd: '0', feesUsd: '0' };
  return body;
}
function trackedHistory(body = openPosition()) {
  trackedAccounting(body); gmgnHistory(body);
  body.realizedAccounting!.coverage.reason = 'onchain_estimate_gas_excluded';
  Object.assign(body.realizedAccounting!.coverage, { verification: 'tracked_history' });
  return body;
}
function fallbackCooldown(body: KolTokenActivity, reason = 'provider_rate_limited') {
  const waiting = structuredClone(body);
  waiting.realizedAccounting!.status = 'pending'; waiting.realizedAccounting!.realizedProfitUsd = null;
  delete waiting.realizedAccounting!.position;
  waiting.realizedAccounting!.coverage = { verification: 'gmgn_history', transactionsComplete: false, balanceMatched: false, reason };
  return waiting;
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(Date.parse(date)); });
afterEach(() => { vi.useRealTimers(); });

describe('explicit GMGN history fallback for unavailable historical RPC reads', () => {
  it.each(['provider_busy', 'provider_rate_limited', 'provider_timeout', 'provider_unavailable', 'provider_http_429', 'provider_http_500', 'provider_http_503'])(
    'permits retaining only the still-valid original snapshot during an evidence-free %s response', reason => {
      for (const inventoryReason of ['inventory_history_unavailable', 'inventory_rpc_unavailable']) {
        const before = gmgnHistory(openPosition()); before.inventory!.coverage.reason = inventoryReason;
        const waiting = fallbackCooldown(before, reason);
        vi.setSystemTime(Date.parse(date) + 20_000);
        expect(tokenPnlMovementsMatch(before, waiting)).toBe(false);
        expect(tokenPnlMayRetainDuringProviderRetry(before, waiting)).toBe(true);
        expect(displayedTokenPnl(waiting)).toBeNull(); // No proof is merged into the pending response.
        expect(tokenPositionPnlPriceTime(before)).toBe('12:00:00');
        expect(tokenPnlExpiresAt(before)).toBe(Date.parse(date) + 30_001);
        vi.setSystemTime(Date.parse(date) + 30_001);
        expect(tokenPnlMayRetainDuringProviderRetry(before, waiting)).toBe(false);
        expect(tokenPnlExpiresAt(before)).toBeNull();
      }
    });

  it.each(['terminal', 'unknownReason', 'wrongWallet', 'wrongToken', 'noMarker', 'canonicalReasonChanged', 'canonicalMismatch',
    'canonicalBlockChanged', 'scanChanged', 'inventoryBalance', 'history', 'historyDate', 'movementDate', 'balanceProof', 'position',
    'realized', 'completeClaim', 'matchedClaim', 'indexedCount', 'indexedTrade', 'inventoryEvent'] as const)(
    'rejects cooldown retention with contradictory or partial %s data', variant => {
      const before = gmgnHistory(openPosition()), waiting = fallbackCooldown(before), accounting = waiting.realizedAccounting!, coverage = accounting.coverage;
      if (variant === 'terminal') accounting.status = 'unavailable';
      if (variant === 'unknownReason') coverage.reason = 'gmgn_history_indexed_mismatch';
      if (variant === 'wrongWallet') waiting.kol.address = accounting.walletAddress = selection(3).tokenAddress;
      if (variant === 'wrongToken') waiting.token.address = accounting.tokenAddress = selection(3).tokenAddress;
      if (variant === 'noMarker') delete coverage.verification;
      if (variant === 'canonicalReasonChanged') waiting.inventory!.coverage.reason = 'inventory_rpc_unavailable';
      if (variant === 'canonicalMismatch') waiting.inventory!.coverage.reason = 'inventory_balance_mismatch';
      if (variant === 'canonicalBlockChanged') waiting.inventory!.coverage.blockHash = '0x' + 'f'.repeat(64);
      if (variant === 'scanChanged') waiting.inventory!.coverage.scannedThroughBlock = '5';
      if (variant === 'inventoryBalance') waiting.inventory!.coverage.balance = '1';
      if (variant === 'history') coverage.historyFingerprint = before.realizedAccounting!.coverage.historyFingerprint;
      if (variant === 'historyDate') coverage.historyCheckedAt = date;
      if (variant === 'movementDate') coverage.lastMovementAt = date;
      if (variant === 'balanceProof') coverage.balanceProof = before.realizedAccounting!.coverage.balanceProof;
      if (variant === 'position') accounting.position = before.realizedAccounting!.position;
      if (variant === 'realized') accounting.realizedProfitUsd = '400';
      if (variant === 'completeClaim') coverage.transactionsComplete = true;
      if (variant === 'matchedClaim') coverage.balanceMatched = true;
      if (variant === 'indexedCount') waiting.coverage.indexedTradeCount = 1;
      if (variant === 'indexedTrade') waiting.trades.push({ id: 'new', side: 'buy', txHash: 'new', tokenAmount: '5' } as KolTokenActivity['trades'][number]);
      if (variant === 'inventoryEvent') waiting.inventory!.events.push({ id: 'new', kind: 'transfer_out', txHash: 'new', tokenAmount: '5' } as NonNullable<KolTokenActivity['inventory']>['events'][number]);
      expect(tokenPnlMayRetainDuringProviderRetry(before, waiting)).toBe(false);
    });

  it('retains unchanged indexed inputs when an unavailable RPC read targets a newer valid chain head', () => {
    const before = gmgnHistory(openPosition()); before.inventory!.coverage.reason = 'inventory_rpc_unavailable';
    const waiting = fallbackCooldown(before);
    waiting.inventory!.coverage.toBlock = '3'; waiting.inventory!.coverage.blockHash = '0x' + 'd'.repeat(64);
    expect(tokenPnlMayRetainDuringProviderRetry(before, waiting)).toBe(true);
    expect(tokenPnlExpiresAt(before)).toBe(Date.parse(date) + 30_001);
    expect(before.inventory!.coverage.toBlock).toBe('2');
    expect(before.realizedAccounting!.coverage.balanceProof!.blockNumber).toBe('1000');
    expect(displayedTokenPnl(waiting)).toBeNull();
  });

  it.each(['sameHeightReorg', 'backwards', 'badHash', 'badHeight', 'missingHeight', 'scanAdvanced'] as const)(
    'rejects cooldown retention after %s in the unavailable RPC snapshot', variant => {
      const before = gmgnHistory(openPosition()); before.inventory!.coverage.reason = 'inventory_rpc_unavailable';
      const waiting = fallbackCooldown(before), proof = waiting.inventory!.coverage;
      proof.toBlock = '3'; proof.blockHash = '0x' + 'd'.repeat(64);
      if (variant === 'sameHeightReorg') proof.toBlock = '2';
      if (variant === 'backwards') proof.toBlock = '1';
      if (variant === 'badHash') proof.blockHash = '0xinvalid';
      if (variant === 'badHeight') proof.toBlock = '2.5';
      if (variant === 'missingHeight') proof.toBlock = null;
      if (variant === 'scanAdvanced') proof.scannedThroughBlock = '3';
      expect(tokenPnlMayRetainDuringProviderRetry(before, waiting)).toBe(false);
    });

  it('expires the displayed mark before its proof, then allows only the remaining realized lifetime', () => {
    const body = openPosition(); body.realizedAccounting!.position!.pricedAt = new Date(Date.now() - 120_000).toISOString();
    expect(displayedTokenPnl(body)).toBe(70); expect(tokenPnlExpiresAt(body)).toBe(Date.parse(date) + 60_001);
    vi.advanceTimersByTime(60_001);
    expect(displayedTokenPnl(body)).toBe(30); expect(tokenPnlExpiresAt(body)).toBe(Date.parse(date) + 180_001);
    vi.advanceTimersByTime(120_000);
    expect(displayedTokenPnl(body)).toBeNull(); expect(tokenPnlExpiresAt(body)).toBeNull();
  });

  it.each(['inventory_history_unavailable', 'inventory_rpc_unavailable'])(
    'shows independently verified open and closed estimates after %s without promoting canonical coverage', reason => {
    const open = gmgnHistory(openPosition()), closed = gmgnHistory();
    open.inventory!.coverage.reason = closed.inventory!.coverage.reason = reason;
    expect(verifiedTokenPositionPnl(open)).toBe(70); expect(verifiedTokenRealizedPnl(open)).toBe(30);
    expect(verifiedTokenPositionPnl(closed)).toBe(30); expect(terminalTokenInventoryFailure(open)).toBe(false);
    expect(open.inventory!.coverage.complete).toBe(false); expect(open.inventory!.coverage.reconciled).toBe(false);
    expect(tokenPositionPnlLabel(open)).toBe('Est. profit'); expect(tokenPositionPnlLabel(closed)).toBe('Est. realized P&L');
    expect(tokenPositionPnlDescription(open)).toContain('current wallet balance checked');
    expect(tokenPositionPnlDescription(closed)).toContain('Historical movements are not chain-verified');
    open.realizedAccounting!.position!.estimatedProfitUsd = null;
    expect(displayedTokenPnl(open)).toBe(30); expect(tokenPositionPnlLabel(open)).toBe('Est. realized P&L');
  });

  it.each(['historyStale', 'historyFuture', 'historyMissing', 'balanceStale', 'balanceFuture', 'blockStale', 'blockFuture',
    'blockAfterCheck', 'accountingStale', 'invalidBalance', 'negativeBalance', 'infiniteBalance', 'wrongWallet', 'wrongToken',
    'wrongAccountingPair', 'wrongChain', 'invalidBlock', 'invalidHash', 'invalidFingerprint', 'missingProof',
    'incompleteHistory', 'unmatchedBalance', 'incompleteIndex', 'canonicalMismatch', 'canonicalPending', 'canonicalPromoted',
    'unmarkedHistory', 'unknownVerification', 'missingMovementTime', 'invalidMovementTime', 'movementAfterBlock', 'unindexedSwap', 'unfinishedScan'] as const)('rejects invalid fallback evidence: %s', variant => {
      const body = gmgnHistory(openPosition()), accounting = body.realizedAccounting!, coverage = accounting.coverage, proof = coverage.balanceProof!;
      const stale = new Date(Date.now() - 180_001).toISOString(), future = new Date(Date.now() + 1001).toISOString();
      if (variant === 'historyStale') coverage.historyCheckedAt = stale;
      if (variant === 'historyFuture') coverage.historyCheckedAt = future;
      if (variant === 'historyMissing') delete coverage.historyCheckedAt;
      if (variant === 'balanceStale') proof.checkedAt = stale;
      if (variant === 'balanceFuture') proof.checkedAt = future;
      if (variant === 'blockStale') proof.blockTimestamp = stale;
      if (variant === 'blockFuture') proof.blockTimestamp = future;
      if (variant === 'blockAfterCheck') proof.blockTimestamp = new Date(Date.now() + 1).toISOString();
      if (variant === 'accountingStale') accounting.checkedAt = stale;
      if (variant === 'invalidBalance') proof.balance = '0xa';
      if (variant === 'negativeBalance') proof.balance = '-1';
      if (variant === 'infiniteBalance') proof.balance = '1e999';
      if (variant === 'wrongWallet') proof.walletAddress = selection(3).tokenAddress;
      if (variant === 'wrongToken') proof.tokenAddress = selection(3).tokenAddress;
      if (variant === 'wrongAccountingPair') accounting.tokenAddress = selection(3).tokenAddress;
      if (variant === 'wrongChain') Object.assign(proof, { chain: 'eth' });
      if (variant === 'invalidBlock') proof.blockNumber = '1.5';
      if (variant === 'invalidHash') proof.blockHash = '0x1234';
      if (variant === 'invalidFingerprint') coverage.historyFingerprint = 'not-a-digest';
      if (variant === 'missingProof') delete coverage.balanceProof;
      if (variant === 'incompleteHistory') coverage.transactionsComplete = false;
      if (variant === 'unmatchedBalance') coverage.balanceMatched = false;
      if (variant === 'incompleteIndex') body.coverage.complete = false;
      if (variant === 'canonicalMismatch') body.inventory!.coverage.reason = 'inventory_balance_mismatch';
      if (variant === 'unindexedSwap') body.inventory!.coverage.reason = 'unindexed_swap_pending';
      if (variant === 'unfinishedScan') body.inventory!.coverage.reason = 'scan_pending';
      if (variant === 'canonicalPending') body.inventory!.coverage.status = 'pending';
      if (variant === 'canonicalPromoted') Object.assign(body.inventory!.coverage, { complete: true, reconciled: true, checkedAt: date, balance: '10' });
      if (variant === 'unmarkedHistory') delete coverage.verification;
      if (variant === 'unknownVerification') Object.assign(coverage, { verification: 'other_provider' });
      if (variant === 'missingMovementTime') delete coverage.lastMovementAt;
      if (variant === 'invalidMovementTime') coverage.lastMovementAt = 'invalid';
      if (variant === 'movementAfterBlock') coverage.lastMovementAt = new Date(Date.parse(proof.blockTimestamp) + 1).toISOString();
      expect(verifiedTokenRealizedPnl(body)).toBeNull(); expect(verifiedTokenPositionPnl(body)).toBeNull();
    });

  it('does not let proof-source fields pass through the canonical branch when the fallback marker is missing', () => {
    const body = gmgnHistory();
    Object.assign(body.inventory!.coverage, { complete: true, reconciled: true, status: 'verified', checkedAt: date, balance: '0' });
    delete body.realizedAccounting!.coverage.verification;
    expect(verifiedTokenRealizedPnl(body)).toBeNull();
  });

  it('uses fallback balance for remaining-position checks and rejects mismatched open and closed balances', () => {
    const open = gmgnHistory(openPosition()); open.realizedAccounting!.position!.remainingTokenAmount = '11';
    expect(verifiedTokenPositionPnl(open)).toBeNull();
    const closed = gmgnHistory(); closed.realizedAccounting!.position = { ...openPosition().realizedAccounting!.position!, status: 'closed', remainingTokenAmount: '0' };
    closed.realizedAccounting!.coverage.balanceProof!.balance = '1';
    expect(verifiedTokenPositionPnl(closed)).toBeNull();
  });

  it.each(['inventory_history_unavailable', 'inventory_rpc_unavailable'])(
    'continues an explicitly marked pending GMGN fallback until ready after %s', async reason => {
    const waiting = gmgnHistory(), ready = gmgnHistory();
    waiting.inventory!.coverage.reason = ready.inventory!.coverage.reason = reason;
    waiting.realizedAccounting!.status = 'pending'; waiting.realizedAccounting!.realizedProfitUsd = null;
    waiting.realizedAccounting!.coverage.transactionsComplete = false;
    delete waiting.realizedAccounting!.coverage.balanceProof; delete waiting.realizedAccounting!.coverage.historyFingerprint;
    expect(terminalTokenInventoryFailure(waiting)).toBe(false);
    const fetcher = vi.fn().mockResolvedValueOnce(response(waiting)).mockResolvedValue(response(ready));
    const result = createKolTokenPnlLoader({ fetcher })(selection(), signal());
    await vi.advanceTimersByTimeAsync(1000);
    expect(await result).toEqual({ activity: ready, status: 'ready' }); expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('stops loading an RPC fallback when the independent provider evidence has a terminal failure', async () => {
    const body = gmgnHistory(); body.inventory!.coverage.reason = 'inventory_rpc_unavailable';
    body.realizedAccounting!.status = 'unavailable'; body.realizedAccounting!.realizedProfitUsd = null;
    body.realizedAccounting!.coverage.reason = 'gmgn_history_indexed_mismatch';
    body.realizedAccounting!.coverage.transactionsComplete = false;
    expect(terminalTokenInventoryFailure(body)).toBe(true);
    const fetcher = vi.fn().mockResolvedValue(response(body));
    expect((await createKolTokenPnlLoader({ fetcher })(selection(), signal())).status).toBe('unavailable');
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it.each(['unmarked', 'mismatch', 'incompleteIndex', 'wrongPair'] as const)('does not retry an ineligible pending fallback: %s', async variant => {
    const body = gmgnHistory(); body.realizedAccounting!.status = 'pending';
    if (variant === 'unmarked') delete body.realizedAccounting!.coverage.verification;
    if (variant === 'mismatch') body.inventory!.coverage.reason = 'inventory_balance_mismatch';
    if (variant === 'incompleteIndex') body.coverage.complete = false;
    if (variant === 'wrongPair') body.realizedAccounting!.tokenAddress = selection(3).tokenAddress;
    expect(terminalTokenInventoryFailure(body)).toBe(true);
    const fetcher = vi.fn().mockResolvedValue(response(body));
    expect((await createKolTokenPnlLoader({ fetcher })(selection(), signal())).status).toBe('unavailable');
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it.each(['fingerprint', 'balance', 'verification', 'proofPair', 'blockHash', 'invalidBlockHash', 'movementTime'] as const)('invalidates retained accounting when fallback %s changes', variant => {
    const before = gmgnHistory(), after = gmgnHistory();
    after.realizedAccounting!.status = 'pending'; after.realizedAccounting!.realizedProfitUsd = null;
    expect(tokenPnlMovementsMatch(before, after)).toBe(true);
    if (variant === 'fingerprint') after.realizedAccounting!.coverage.historyFingerprint = 'f'.repeat(64);
    if (variant === 'balance') after.realizedAccounting!.coverage.balanceProof!.balance = '1';
    if (variant === 'verification') delete after.realizedAccounting!.coverage.verification;
    if (variant === 'proofPair') after.realizedAccounting!.coverage.balanceProof!.walletAddress = selection(3).tokenAddress;
    if (variant === 'blockHash') after.realizedAccounting!.coverage.balanceProof!.blockHash = '0x' + 'd'.repeat(64);
    if (variant === 'invalidBlockHash') after.realizedAccounting!.coverage.balanceProof!.blockHash = 'invalid';
    if (variant === 'movementTime') after.realizedAccounting!.coverage.lastMovementAt = new Date(Date.now() - 1000).toISOString();
    expect(tokenPnlMovementsMatch(before, after)).toBe(false);
  });

  it('expires recent-result cache when fallback history or current balance proof becomes stale', async () => {
    const old = gmgnHistory(), fresh = gmgnHistory();
    old.realizedAccounting!.coverage.historyCheckedAt = new Date(Date.now() - 29_000).toISOString();
    const fetcher = vi.fn().mockResolvedValueOnce(response(old)).mockResolvedValue(response(fresh));
    const loader = createKolTokenPnlLoader({ fetcher });
    expect((await loader(selection(), signal())).status).toBe('ready');
    await vi.advanceTimersByTimeAsync(1001);
    expect((await loader(selection(), signal())).status).toBe('ready'); expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('requires the current mark to follow the latest provider movement while accepting old historical movement dates', () => {
    const body = gmgnHistory(openPosition());
    body.realizedAccounting!.position!.pricedAt = new Date(Date.now() - 1000).toISOString();
    expect(verifiedTokenPositionPnl(body)).toBeNull();
    expect(verifiedTokenRealizedPnl(body)).toBe(30);
    body.realizedAccounting!.coverage.lastMovementAt = '2026-09-28T12:00:00Z';
    expect(verifiedTokenPositionPnl(body)).toBe(70);
    body.realizedAccounting!.coverage.lastMovementAt = body.realizedAccounting!.position!.pricedAt!;
    expect(verifiedTokenPositionPnl(body)).toBe(70);
  });

  it('shows a provider-history cash-flow total with unknown realized split, only after the latest movement', async () => {
    const body = gmgnHistory(openPosition()), accounting = body.realizedAccounting!, position = accounting.position!;
    accounting.realizedProfitUsd = null; position.remainingCostBasisUsd = null; position.unrealizedProfitUsd = null;
    position.cashFlow = { investedUsd: '18', soldUsd: '30', transferOutIncomeUsd: '10', feesUsd: '2' };
    expect(verifiedTokenRealizedPnl(body)).toBeNull(); expect(verifiedTokenPositionPnl(body)).toBe(70);
    expect(tokenPositionPnlLabel(body)).toBe('Est. profit');
    const loader = createKolTokenPnlLoader({ fetcher: vi.fn().mockResolvedValue(response(body)) });
    expect((await loader(selection(), signal())).status).toBe('ready');
    position.pricedAt = new Date(Date.now() - 1000).toISOString();
    expect(displayedTokenPnl(body)).toBeNull();
  });
});

describe('GMGN reported lifetime totals with separately verified history', () => {
  it.each(['sameHead', 'laterHead'] as const)('shows reported open and closed totals with a compatible %s current balance proof', async variant => {
    for (const body of [gmgnAggregate(openPosition()), gmgnAggregate()]) {
      if (variant === 'laterHead') {
        body.realizedAccounting!.coverage.balanceProof!.blockNumber = '3';
        body.realizedAccounting!.coverage.balanceProof!.blockHash = '0x' + 'd'.repeat(64);
      }
      expect(verifiedTokenRealizedPnl(body)).toBe(30);
      expect(verifiedTokenPositionPnl(body)).toBe(body.summary.status === 'open' ? 70 : 30);
      expect(tokenPositionPnlLabel(body)).toBe(body.summary.status === 'open' ? 'Est. profit' : 'Realized P&L');
      expect(tokenPositionPnlDescription(body)).toBe('GMGN reported profit; current wallet balance checked.');
      expect(body.inventory!.coverage.complete).toBe(true);
      expect(terminalTokenInventoryFailure(body)).toBe(false);
      expect((await createKolTokenPnlLoader({ fetcher: vi.fn().mockResolvedValue(response(body)) })(selection(), signal())).status).toBe('ready');
    }
  });

  it.each(['inventory_history_unavailable', 'inventory_rpc_unavailable'])(
    'also permits reported totals with independent history after %s', reason => {
      const body = gmgnHistory(openPosition()); body.inventory!.coverage.reason = reason;
      body.realizedAccounting!.coverage.reason = 'gmgn_aggregate_verified';
      expect(verifiedTokenRealizedPnl(body)).toBe(30); expect(verifiedTokenPositionPnl(body)).toBe(70);
      expect(tokenPositionPnlDescription(body)).toBe('GMGN reported profit; current wallet balance checked.');
      expect(body.inventory!.coverage.complete).toBe(false);
    });

  it.each(['missingMarker', 'estimateMarker', 'pendingScan', 'unreconciled', 'canonicalMismatch', 'missingStatus', 'backwardsHead',
    'sameHeadConflict', 'invalidCanonicalHead', 'invalidProviderHead', 'invalidCanonicalHash', 'balanceMismatch', 'zeroVersusDust',
    'invalidCanonicalBalance', 'staleCanonical', 'staleHistory', 'staleAccounting', 'staleBalance', 'staleBlock', 'futureBlock',
    'missingProof', 'wrongWallet', 'wrongToken', 'incompleteIndex', 'incompleteHistory'] as const)(
    'rejects reported totals with %s evidence instead of bypassing canonical checks', variant => {
      const body = gmgnAggregate(openPosition()), inventory = body.inventory!.coverage, accounting = body.realizedAccounting!;
      const coverage = accounting.coverage, proof = coverage.balanceProof!;
      if (variant === 'missingMarker') delete coverage.reason;
      if (variant === 'estimateMarker') coverage.reason = 'gmgn_history_estimate';
      if (variant === 'pendingScan') inventory.status = 'pending';
      if (variant === 'unreconciled') inventory.reconciled = false;
      if (variant === 'canonicalMismatch') inventory.reason = 'inventory_balance_mismatch';
      if (variant === 'missingStatus') delete inventory.status;
      if (variant === 'backwardsHead') proof.blockNumber = '1';
      if (variant === 'sameHeadConflict') proof.blockHash = '0x' + 'd'.repeat(64);
      if (variant === 'invalidCanonicalHead') inventory.toBlock = '2.5';
      if (variant === 'invalidProviderHead') proof.blockNumber = '0x2';
      if (variant === 'invalidCanonicalHash') inventory.blockHash = 'bad';
      if (variant === 'balanceMismatch') inventory.balance = '11';
      if (variant === 'zeroVersusDust') { inventory.balance = '0'; proof.balance = '0.00000000000001'; }
      if (variant === 'invalidCanonicalBalance') inventory.balance = '0xa';
      if (variant === 'staleCanonical') inventory.checkedAt = new Date(Date.now() - 180_001).toISOString();
      if (variant === 'staleHistory') coverage.historyCheckedAt = new Date(Date.now() - 30_001).toISOString();
      if (variant === 'staleAccounting') accounting.checkedAt = new Date(Date.now() - 30_001).toISOString();
      if (variant === 'staleBalance') proof.checkedAt = new Date(Date.now() - 180_001).toISOString();
      if (variant === 'staleBlock') proof.blockTimestamp = new Date(Date.now() - 180_001).toISOString();
      if (variant === 'futureBlock') proof.blockTimestamp = new Date(Date.now() + 1).toISOString();
      if (variant === 'missingProof') delete coverage.balanceProof;
      if (variant === 'wrongWallet') proof.walletAddress = selection(3).tokenAddress;
      if (variant === 'wrongToken') proof.tokenAddress = selection(3).tokenAddress;
      if (variant === 'incompleteIndex') body.coverage.complete = false;
      if (variant === 'incompleteHistory') coverage.transactionsComplete = false;
      expect(verifiedTokenRealizedPnl(body)).toBeNull(); expect(verifiedTokenPositionPnl(body)).toBeNull();
      expect(displayedTokenPnl(body)).toBeNull();
    });

  it.each(['aggregate', 'history'] as const)('refreshes and expires %s evidence on its original thirty-second lifetime', async source => {
    const body = source === 'aggregate' ? gmgnAggregate(openPosition()) : gmgnHistory(openPosition());
    body.realizedAccounting!.coverage.historyCheckedAt = new Date(Date.now() - 10_000).toISOString();
    expect(tokenPnlRefreshDelay({ activity: body, status: 'ready' }, 0)).toBe(15_001);
    expect(tokenPnlExpiresAt(body)).toBe(Date.parse(date) + 20_001);
    vi.advanceTimersByTime(20_001);
    expect(displayedTokenPnl(body)).toBeNull(); expect(tokenPnlExpiresAt(body)).toBeNull();
  });

  it('rejects a recently cached reported total when its history expires', async () => {
    const old = gmgnAggregate(), fresh = gmgnAggregate();
    old.realizedAccounting!.coverage.historyCheckedAt = new Date(Date.now() - 29_000).toISOString();
    const fetcher = vi.fn().mockResolvedValueOnce(response(old)).mockResolvedValue(response(fresh));
    const loader = createKolTokenPnlLoader({ fetcher });
    expect((await loader(selection(), signal())).status).toBe('ready');
    await vi.advanceTimersByTimeAsync(1001);
    expect((await loader(selection(), signal())).status).toBe('ready'); expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

describe('explicit verified tracked-trade estimates', () => {
  it.each([[1, 1000], [3000, 3000], [75_000, 75_000], [900_000, 300_000]])(
    'schedules a ready tracked estimate after a bounded GMGN retry of %d ms', (retryAfterMs, expected) => {
      const body = trackedAccounting(); body.realizedAccounting!.retryAfterMs = retryAfterMs;
      expect(tokenPnlRefreshDelay({ activity: body, status: 'ready' }, 0)).toBe(expected);
    });

  it('honors the longer quote cooldown while upgrading tracked accounting', () => {
    const body = trackedAccounting(openPosition());
    body.realizedAccounting!.retryAfterMs = 3000; body.realizedAccounting!.position!.retryAfterMs = 75_000;
    expect(tokenPnlRefreshDelay({ activity: body, status: 'ready', retryAfterMs: 5000 }, 0)).toBe(75_000);
    delete body.realizedAccounting!.retryAfterMs; delete body.realizedAccounting!.position!.retryAfterMs;
    expect(tokenPnlRefreshDelay({ activity: body, status: 'ready' }, 0)).toBe(60_000);
    body.realizedAccounting!.retryAfterMs = NaN;
    expect(tokenPnlRefreshDelay({ activity: body, status: 'ready' }, 0)).toBe(60_000);
  });

  it('returns verified tracked totals immediately and leaves the GMGN upgrade to the scheduled retry', async () => {
    const body = trackedAccounting(openPosition()); body.realizedAccounting!.retryAfterMs = 3000;
    const fetcher = vi.fn().mockResolvedValue(response(body));
    const result = await createKolTokenPnlLoader({ fetcher })(selection(), signal());
    expect(result).toEqual({ activity: body, status: 'ready', retryAfterMs: 3000 });
    expect(tokenPnlRefreshDelay(result, 0)).toBe(3000); expect(fetcher).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps a missing tracked market mark pending and respects its longer quote retry', async () => {
    const body = trackedAccounting(openPosition()); body.realizedAccounting!.retryAfterMs = 3000;
    body.realizedAccounting!.position!.estimatedProfitUsd = null;
    body.realizedAccounting!.position!.reason = 'quote_rate_limited'; body.realizedAccounting!.position!.retryAfterMs = 75_000;
    const fetcher = vi.fn().mockResolvedValue(response(body));
    const result = await createKolTokenPnlLoader({ fetcher })(selection(), signal());
    expect(result).toEqual({ activity: body, status: 'pending', retryAfterMs: 75_000 });
    expect(displayedTokenPnl(result.activity)).toBe(30);
    expect(tokenPnlRefreshDelay(result, 0)).toBe(75_000); expect(fetcher).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['missingPosition', 'missingFlow', 'unknownFees', 'nonzeroFees', 'unknownOutgoing', 'nonzeroOutgoing',
    'negativeInvested', 'zeroInvested', 'unknownSold', 'infiniteCost', 'costMismatch', 'unknownBasis', 'excessBasis',
    'balanceMismatch', 'zeroVersusDust', 'wrongPositionStatus', 'unknownRealized', 'realizedMismatch', 'closedBasis'] as const)(
    'rejects inconsistent tracked cash flows: %s', variant => {
      const body = trackedAccounting(variant === 'closedBasis' ? activity() : openPosition()), accounting = body.realizedAccounting!;
      const position = accounting.position!, flow = position.cashFlow!;
      if (variant === 'missingPosition') delete accounting.position;
      if (variant === 'missingFlow') delete position.cashFlow;
      if (variant === 'unknownFees') flow.feesUsd = '';
      if (variant === 'nonzeroFees') flow.feesUsd = '1';
      if (variant === 'unknownOutgoing') flow.transferOutIncomeUsd = 'unknown';
      if (variant === 'nonzeroOutgoing') flow.transferOutIncomeUsd = '2';
      if (variant === 'negativeInvested') flow.investedUsd = '-20';
      if (variant === 'zeroInvested') flow.investedUsd = '0';
      if (variant === 'unknownSold') flow.soldUsd = '0x28';
      if (variant === 'infiniteCost') position.feeInclusiveCostUsd = '1e999';
      if (variant === 'costMismatch') position.feeInclusiveCostUsd = '21';
      if (variant === 'unknownBasis') position.remainingCostBasisUsd = null;
      if (variant === 'excessBasis') position.remainingCostBasisUsd = '21';
      if (variant === 'balanceMismatch') position.remainingTokenAmount = '11';
      if (variant === 'zeroVersusDust') { body.inventory!.coverage.balance = '0'; position.remainingTokenAmount = '0.00000000000001'; }
      if (variant === 'wrongPositionStatus') position.status = 'closed';
      if (variant === 'unknownRealized') accounting.realizedProfitUsd = null;
      if (variant === 'realizedMismatch') accounting.realizedProfitUsd = '31';
      if (variant === 'closedBasis') position.remainingCostBasisUsd = '1';
      expect(verifiedTokenRealizedPnl(body)).toBeNull(); expect(verifiedTokenPositionPnl(body)).toBeNull();
    });

  it.each(['-10', '0', '30'])('accepts consistent signed tracked realized gains of %s', realized => {
    const body = trackedAccounting(), accounting = body.realizedAccounting!, position = accounting.position!;
    accounting.realizedProfitUsd = realized; position.cashFlow!.soldUsd = String(20 + Number(realized));
    position.estimatedProfitUsd = realized;
    expect(verifiedTokenRealizedPnl(body)).toBe(Number(realized)); expect(verifiedTokenPositionPnl(body)).toBe(Number(realized));
  });

  it('shows the separate tracked labels and gas exclusion without presenting a GMGN total', async () => {
    for (const body of [trackedAccounting(openPosition()), trackedAccounting()]) {
      const open = body.summary.status === 'open';
      expect(verifiedTokenRealizedPnl(body)).toBe(30); expect(verifiedTokenPositionPnl(body)).toBe(open ? 70 : 30);
      expect(tokenPositionPnlLabel(body)).toBe(open ? 'Tracked est. profit' : 'Tracked realized P&L');
      expect(tokenPositionPnlDescription(body)).toBe('Estimate from verified tracked trades; gas fees and earlier untracked trades are excluded.');
      expect(tokenPnlRefreshDelay({ activity: body, status: 'ready' }, 0)).toBe(60_000);
      expect(tokenPnlExpiresAt(body)).toBe(Date.parse(date) + 180_001);
      expect((await createKolTokenPnlLoader({ fetcher: vi.fn().mockResolvedValue(response(body)) })(selection(), signal())).status).toBe('ready');
    }
  });

  it.each(['gmgnPolicy', 'gmgnSource', 'gmgnMarker', 'missingReason', 'unknownReason', 'pendingCanonical', 'canonicalMismatch',
    'incompleteCanonical', 'unreconciledCanonical', 'staleCanonical', 'staleAccounting', 'historyVerification', 'historyProof',
    'historyFingerprint', 'providerHistoryUnavailable', 'invalidHead', 'reversedWindow', 'missingBlockHash'] as const)(
    'rejects tracked estimates with %s instead of borrowing another accounting policy', variant => {
      const body = trackedAccounting(openPosition()), accounting = body.realizedAccounting!, proof = body.inventory!.coverage;
      if (variant === 'gmgnPolicy') accounting.policy = 'gmgn_realized_profit_v1';
      if (variant === 'gmgnSource') accounting.source = 'gmgn';
      if (variant === 'gmgnMarker') { accounting.source = 'gmgn'; accounting.policy = 'gmgn_realized_profit_v1'; }
      if (variant === 'missingReason') delete accounting.coverage.reason;
      if (variant === 'unknownReason') accounting.coverage.reason = 'gmgn_activity_estimate';
      if (variant === 'pendingCanonical') proof.status = 'pending';
      if (variant === 'canonicalMismatch') proof.reason = 'inventory_balance_mismatch';
      if (variant === 'incompleteCanonical') proof.complete = false;
      if (variant === 'unreconciledCanonical') proof.reconciled = false;
      if (variant === 'staleCanonical') proof.checkedAt = new Date(Date.now() - 180_001).toISOString();
      if (variant === 'staleAccounting') accounting.checkedAt = new Date(Date.now() - 180_001).toISOString();
      if (variant === 'invalidHead') proof.toBlock = '2.5';
      if (variant === 'reversedWindow') proof.fromBlock = '3';
      if (variant === 'missingBlockHash') proof.blockHash = null;
      if (variant === 'historyVerification') accounting.coverage.verification = 'gmgn_history';
      if (variant === 'historyProof') accounting.coverage.balanceProof = gmgnHistory().realizedAccounting!.coverage.balanceProof;
      if (variant === 'historyFingerprint') accounting.coverage.historyFingerprint = 'b'.repeat(64);
      if (variant === 'providerHistoryUnavailable') Object.assign(proof, { complete: false, reconciled: false, status: 'unavailable', reason: 'inventory_history_unavailable' });
      expect(verifiedTokenRealizedPnl(body)).toBeNull(); expect(verifiedTokenPositionPnl(body)).toBeNull();
    });

  it('keeps known tracked realized gains under their own label during a quote outage', () => {
    const body = trackedAccounting(openPosition());
    body.realizedAccounting!.position!.estimatedProfitUsd = null;
    body.realizedAccounting!.position!.reason = 'current_quote_unavailable';
    expect(displayedTokenPnl(body)).toBe(30); expect(tokenPositionPnlLabel(body)).toBe('Tracked realized P&L');
  });

  it('expires an older tracked accounting snapshot even when its canonical proof is newer', () => {
    const body = trackedAccounting();
    body.realizedAccounting!.checkedAt = new Date(Date.now() - 120_000).toISOString();
    expect(tokenPnlExpiresAt(body)).toBe(Date.parse(date) + 60_001);
    vi.advanceTimersByTime(60_001);
    expect(displayedTokenPnl(body)).toBeNull();
  });

  it('does not carry a retained amount across a switch between tracked and GMGN policies', () => {
    const tracked = trackedAccounting(), gmgn = activity();
    expect(tokenPnlMovementsMatch(tracked, gmgn)).toBe(false); expect(tokenPnlMovementsMatch(gmgn, tracked)).toBe(false);
    const waiting = trackedAccounting(); waiting.realizedAccounting!.status = 'pending'; waiting.realizedAccounting!.realizedProfitUsd = null;
    expect(tokenPnlMovementsMatch(tracked, waiting)).toBe(true);
  });

  it('upgrades a tracked result to newly verified GMGN accounting after the short recent-result cache', async () => {
    const tracked = trackedAccounting(), gmgn = activity();
    const fetcher = vi.fn().mockResolvedValueOnce(response(tracked)).mockResolvedValue(response(gmgn));
    const loader = createKolTokenPnlLoader({ fetcher });
    expect(tokenPositionPnlLabel((await loader(selection(), signal())).activity)).toBe('Tracked realized P&L');
    await vi.advanceTimersByTimeAsync(5001);
    expect(tokenPositionPnlLabel((await loader(selection(), signal())).activity)).toBe('Realized P&L');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

describe('tracked estimates with independent provider history and a current-chain balance', () => {
  it('honors a GMGN cooldown beyond history expiry without extending the displayed evidence', async () => {
    const body = trackedHistory(); body.realizedAccounting!.retryAfterMs = 75_000;
    const fetcher = vi.fn().mockResolvedValue(response(body));
    const result = await createKolTokenPnlLoader({ fetcher })(selection(), signal());
    expect(result.status).toBe('ready'); expect(tokenPnlRefreshDelay(result, 0)).toBe(75_000);
    expect(tokenPnlExpiresAt(body)).toBe(Date.parse(date) + 30_001);
    vi.advanceTimersByTime(30_001);
    expect(displayedTokenPnl(body)).toBeNull(); expect(fetcher).toHaveBeenCalledOnce();
    expect(body.realizedAccounting!.coverage.historyCheckedAt).toBe(date);
  });

  it.each(['inventory_history_unavailable', 'inventory_rpc_unavailable'])(
    'shows separately labelled open and closed tracked totals after %s', reason => {
      for (const body of [trackedHistory(openPosition()), trackedHistory(activity())]) {
        body.inventory!.coverage.reason = reason;
        const open = body.summary.status === 'open';
        expect(verifiedTokenRealizedPnl(body)).toBe(30); expect(verifiedTokenPositionPnl(body)).toBe(open ? 70 : 30);
        expect(tokenPositionPnlLabel(body)).toBe(open ? 'Tracked est. profit' : 'Tracked realized P&L');
        expect(tokenPositionPnlDescription(body)).toContain('gas fees and earlier untracked trades are excluded');
        expect(terminalTokenInventoryFailure(body)).toBe(false);
        expect(tokenPnlRefreshDelay({ activity: body, status: 'ready' }, 0)).toBe(20_000);
        expect(tokenPnlExpiresAt(body)).toBe(Date.parse(date) + 30_001);
        expect(body.inventory!.coverage.complete).toBe(false);
      }
    });

  it.each(['canonicalComplete', 'canonicalMismatch', 'canonicalPending', 'gmgnVerification', 'gmgnSource', 'missingMarker',
    'incompleteIndex', 'incompleteHistory', 'unmatchedBalance', 'staleHistory', 'staleAccounting', 'staleBalance', 'staleBlock',
    'futureBlock', 'movementAfterBlock', 'missingMovement', 'badFingerprint', 'missingProof', 'wrongWallet', 'wrongToken',
    'wrongChain', 'invalidBlock', 'invalidHash', 'balanceDisagreement', 'unknownFees', 'falseRealized'] as const)(
    'rejects tracked-history accounting with %s evidence', variant => {
      const body = trackedHistory(), accounting = body.realizedAccounting!, coverage = accounting.coverage;
      const inventory = body.inventory!.coverage, proof = coverage.balanceProof!;
      if (variant === 'canonicalComplete') Object.assign(inventory, { complete: true, reconciled: true, status: 'verified', reason: undefined, checkedAt: date, balance: '10' });
      if (variant === 'canonicalMismatch') inventory.reason = 'inventory_balance_mismatch';
      if (variant === 'canonicalPending') inventory.status = 'pending';
      if (variant === 'gmgnVerification') coverage.verification = 'gmgn_history';
      if (variant === 'gmgnSource') { accounting.source = 'gmgn'; accounting.policy = 'gmgn_realized_profit_v1'; coverage.reason = 'gmgn_aggregate_verified'; }
      if (variant === 'missingMarker') delete coverage.reason;
      if (variant === 'incompleteIndex') body.coverage.complete = false;
      if (variant === 'incompleteHistory') coverage.transactionsComplete = false;
      if (variant === 'unmatchedBalance') coverage.balanceMatched = false;
      if (variant === 'staleHistory') coverage.historyCheckedAt = new Date(Date.now() - 30_001).toISOString();
      if (variant === 'staleAccounting') accounting.checkedAt = new Date(Date.now() - 30_001).toISOString();
      if (variant === 'staleBalance') proof.checkedAt = new Date(Date.now() - 180_001).toISOString();
      if (variant === 'staleBlock') proof.blockTimestamp = new Date(Date.now() - 180_001).toISOString();
      if (variant === 'futureBlock') proof.blockTimestamp = new Date(Date.now() + 1).toISOString();
      if (variant === 'movementAfterBlock') coverage.lastMovementAt = new Date(Date.now() + 1).toISOString();
      if (variant === 'missingMovement') delete coverage.lastMovementAt;
      if (variant === 'badFingerprint') coverage.historyFingerprint = 'bad';
      if (variant === 'missingProof') delete coverage.balanceProof;
      if (variant === 'wrongWallet') proof.walletAddress = selection(3).tokenAddress;
      if (variant === 'wrongToken') proof.tokenAddress = selection(3).tokenAddress;
      if (variant === 'wrongChain') Object.assign(proof, { chain: 'eth' });
      if (variant === 'invalidBlock') proof.blockNumber = '1.5';
      if (variant === 'invalidHash') proof.blockHash = 'bad';
      if (variant === 'balanceDisagreement') proof.balance = '11';
      if (variant === 'unknownFees') accounting.position!.cashFlow!.feesUsd = 'unknown';
      if (variant === 'falseRealized') accounting.realizedProfitUsd = '31';
      expect(verifiedTokenRealizedPnl(body)).toBeNull(); expect(verifiedTokenPositionPnl(body)).toBeNull();
      expect(displayedTokenPnl(body)).toBeNull();
    });

  it('expires tracked history at thirty seconds without renewing any evidence date', () => {
    const body = trackedHistory();
    expect(displayedTokenPnl(body)).toBe(70);
    vi.advanceTimersByTime(30_001);
    expect(displayedTokenPnl(body)).toBeNull(); expect(tokenPnlExpiresAt(body)).toBeNull();
    expect(body.realizedAccounting!.coverage.historyCheckedAt).toBe(date);
  });
});

describe('fair token-card realized profit loading', () => {
  it.each(['provider_transaction_mismatch', 'gmgn_history_indexed_mismatch', 'provider_activity_conflict', 'gmgn_history_conflict'])(
    'explains a provider history mismatch for both open and closed positions: %s', reason => {
      for (const status of ['open', 'closed'] as const) {
        const body = activity(selection(), null); body.summary.status = status;
        body.realizedAccounting!.coverage.reason = reason;
        // CATTO has a verified current-cycle ledger; the provider history can
        // still describe a different scope. Do not blame its verified balance.
        expect(body.inventory!.coverage.complete).toBe(true);
        expect(tokenPositionPnlUnavailableNotice(body)).toBe('Profit is unavailable because GMGN and the verified trade history do not match.');
        expect(displayedTokenPnl(body)).toBeNull();
      }
    });
  it.each(['inventory_balance_mismatch', 'balance_mismatch', 'gmgn_history_balance_mismatch'])(
    'explains balance reconciliation failure from either coverage source: %s', reason => {
      for (const status of ['open', 'closed'] as const) {
        for (const source of ['accounting', 'inventory'] as const) {
          const body = activity(selection(), null); body.summary.status = status;
          delete body.realizedAccounting!.coverage.reason;
          if (source === 'accounting') body.realizedAccounting!.coverage.reason = reason;
          else body.inventory!.coverage.reason = reason;
          expect(tokenPositionPnlUnavailableNotice(body)).toBe('Profit is unavailable because transaction amounts do not match the wallet balance.');
          expect(displayedTokenPnl(body)).toBeNull();
        }
      }
    });
  it.each(['gmgn_realized_cost_unavailable', 'quote_or_fee_unavailable', 'transfer_fee_schema_unavailable',
    'gmgn_history_opening_cost_unknown', 'gmgn_history_cost_invalid', 'purchase_cost_unavailable', 'provider_basis_unreconciled'])(
    'explains unverifiable purchase costs or fees for both position states: %s', reason => {
      for (const status of ['open', 'closed'] as const) {
        const body = activity(selection(), null); body.summary.status = status;
        body.realizedAccounting!.coverage.reason = reason;
        expect(tokenPositionPnlUnavailableNotice(body)).toBe('Profit is unavailable because purchase costs or fees could not be verified.');
        expect(displayedTokenPnl(body)).toBeNull();
      }
    });
  it('does not describe a position cost failure as a missing quote', () => {
    const body = openPosition();
    body.realizedAccounting!.position!.estimatedProfitUsd = null;
    body.realizedAccounting!.position!.reason = 'purchase_cost_unavailable';
    expect(tokenPositionPnlUnavailableNotice(body)).toBe('Profit is unavailable because purchase costs or fees could not be verified.');
    delete body.realizedAccounting!.position!.reason;
    expect(tokenPositionPnlUnavailableNotice(body)).toBe('Estimated profit is unavailable until a current token price is verified.');
  });

  it('uses an estimated-profit label for buy-only activity while waiting for verified accounting, without inventing a total', () => {
    const body = activity(selection(), null);
    body.summary.status = 'open'; body.summary.sellCount = 0; body.summary.remainingTokenAmount = '10';
    delete body.realizedAccounting;
    expect(tokenPositionPnlLabel(body)).toBe('Est. profit');
    expect(tokenPositionPnlLoadingNotice(body)).toBe('Updating estimated profit…');
    expect(tokenPositionPnlUnavailableNotice(body)).toContain('Estimated profit');
    expect(displayedTokenPnl(body)).toBeNull();
    body.realizedAccounting = activity().realizedAccounting;
    expect(tokenPositionPnlLabel(body)).toBe('Realized P&L');
    expect(displayedTokenPnl(body)).toBe(30);
    // A verified transfer-out can close a buy-only position; never let observed
    // buys override the accounting position or pretend all holdings remain.
    body.realizedAccounting = { ...activity().realizedAccounting!, position: {
      ...openPosition().realizedAccounting!.position!, status: 'closed', remainingTokenAmount: '0',
    } };
    expect(tokenPositionPnlLabel(body)).toBe('Realized P&L');
  });

  it('backs off recurring verification without retrying sooner than the provider allows', () => {
    const waiting = { activity: null, status: 'pending' as const };
    expect(tokenPnlRefreshDelay(waiting, 1)).toBe(3000);
    expect(tokenPnlRefreshDelay(waiting, 2)).toBe(6000);
    expect(tokenPnlRefreshDelay(waiting, 20)).toBe(30_000);
    expect(tokenPnlRefreshDelay({ ...waiting, retryAfterMs: 75_000 }, 20)).toBe(75_000);
    expect(tokenPnlRefreshDelay({ activity: activity(), status: 'ready' }, 20)).toBe(60_000);
  });

  it('does not poll a terminal open-position valuation error solely because the position is open', async () => {
    const body = openPosition(); body.realizedAccounting!.position!.estimatedProfitUsd = null;
    body.realizedAccounting!.position!.reason = 'purchase_cost_unavailable';
    const fetcher = vi.fn().mockResolvedValue(response(body));
    const result = await createKolTokenPnlLoader({ fetcher })(selection(), signal());
    expect(result.status).toBe('unavailable'); expect(fetcher).toHaveBeenCalledOnce();
    expect(displayedTokenPnl(result.activity)).toBe(30);
  });

  it('lets the other five initial cards load while accepted profile work is still running and honors its retry time', async () => {
    const selections = Array.from({ length: 6 }, (_, index) => selection(index + 2));
    const calls: string[] = []; let coldAttempts = 0;
    const pendingResponse = response({ status: 'pending' }, 202, '3');
    const readPendingBody = vi.spyOn(pendingResponse, 'json');
    const fetcher = vi.fn((input: RequestInfo | URL) => {
      const token = String(input).split('/tokens/')[1].split('/')[0];
      const selected = selections.find(item => item.tokenAddress === token)!;
      calls.push(token);
      return Promise.resolve(token === selections[0].tokenAddress && coldAttempts++ === 0
        ? pendingResponse : response(activity(selected)));
    });
    const loader = createKolTokenPnlLoader({ fetcher }), results = selections.map(item => loader(item, signal()));
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual(selections.map(item => item.tokenAddress));
    expect((await Promise.all(results.slice(1))).every(result => result.status === 'ready')).toBe(true);
    expect(readPendingBody).not.toHaveBeenCalled();
    expect(fetcher.mock.calls.every(([url]) => String(url).endsWith('/activity?pnl=true&profile=true'))).toBe(true);
    await vi.advanceTimersByTimeAsync(2999); expect(calls).toHaveLength(6);
    await vi.advanceTimersByTimeAsync(1); expect((await results[0]).status).toBe('ready');
    expect(calls).toHaveLength(7); expect(calls.at(-1)).toBe(selections[0].tokenAddress);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps a long accepted-work cooldown pending without validating or caching the status response', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(response({ status: 'pending' }, 202, '75')).mockResolvedValue(response(activity()));
    const loader = createKolTokenPnlLoader({ fetcher });
    expect(await loader(selection(), signal())).toEqual({ activity: null, status: 'pending', retryAfterMs: 75_000 });
    expect(fetcher).toHaveBeenCalledOnce();
    expect((await loader(selection(), signal())).status).toBe('ready');
    expect(fetcher).toHaveBeenCalledTimes(2); expect(vi.getTimerCount()).toBe(0);
  });

  it('suspends queued and newly mounted cards during a trade modal while foreground preparation can finish', async () => {
    let release!: (value: Response) => void;
    const fetcher = vi.fn().mockImplementationOnce(() => new Promise<Response>(resolve => { release = resolve; }))
      .mockImplementation((input: RequestInfo | URL) => Promise.resolve(response(activity(String(input).includes(selection(3).tokenAddress) ? selection(3) : selection(4)))));
    const loader = createKolTokenPnlLoader({ fetcher }), active = loader(selection(), signal());
    await vi.advanceTimersByTimeAsync(0);
    const resume = loader.suspendBackground(), resumeNested = loader.suspendBackground();
    const queued = loader(selection(3), signal());
    release(response(activity())); await active;
    const foreground = await loader(selection(4), signal(), { priority: 'foreground' });
    expect(foreground.status).toBe('ready'); expect(fetcher).toHaveBeenCalledTimes(2);
    // A nested modal must not accidentally resume cards owned by the first one.
    resumeNested(); resumeNested(); await vi.advanceTimersByTimeAsync(30_000);
    expect(fetcher).toHaveBeenCalledTimes(2);
    resume(); expect((await queued).status).toBe('ready'); expect(fetcher).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels a card waiting behind an open modal without making a provider request', async () => {
    const fetcher = vi.fn(), loader = createKolTokenPnlLoader({ fetcher }), resume = loader.suspendBackground();
    const controller = new AbortController(), queued = loader(selection(), controller.signal);
    const stopped = expect(queued).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort(); await stopped; resume(); await vi.advanceTimersByTimeAsync(0);
    expect(fetcher).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });

  it('selects current total for an open position, keeps realized available separately, and waits for a fresh mark', async () => {
    const body = openPosition();
    expect(verifiedTokenRealizedPnl(body)).toBe(30); expect(verifiedTokenPositionPnl(body)).toBe(70);
    const missing = structuredClone(body); missing.realizedAccounting!.position!.estimatedProfitUsd = null;
    missing.realizedAccounting!.position!.retryAfterMs = 3000;
    const fetcher = vi.fn().mockResolvedValueOnce(response(missing)).mockResolvedValue(response(body));
    const loader = createKolTokenPnlLoader({ fetcher }), result = loader(selection(), signal());
    await vi.advanceTimersByTimeAsync(2999); expect(fetcher).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1); expect((await result).status).toBe('ready');
    expect(fetcher).toHaveBeenCalledTimes(2); expect(vi.getTimerCount()).toBe(0);
  });

  it('displays realized gains while continuing to retry a current quote, then switches to the estimated total', async () => {
    const missing = openPosition(); missing.realizedAccounting!.position!.estimatedProfitUsd = null;
    missing.realizedAccounting!.position!.retryAfterMs = 3000;
    expect(displayedTokenPnl(missing)).toBe(30); expect(tokenPositionPnlLabel(missing)).toBe('Realized P&L');
    expect(tokenPositionPnlDescription(missing)).toContain('GMGN realized');
    const seen: { amount: number | null; label: string }[] = [];
    const fetcher = vi.fn().mockResolvedValueOnce(response(missing)).mockResolvedValue(response(openPosition()));
    const loader = createKolTokenPnlLoader({ fetcher });
    const result = loader(selection(), signal(), { priority: 'foreground', onActivity: body => seen.push({ amount: displayedTokenPnl(body), label: tokenPositionPnlLabel(body) }) });
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toEqual([{ amount: 30, label: 'Realized P&L' }]);
    await vi.advanceTimersByTimeAsync(3000);
    expect((await result).status).toBe('ready');
    expect(seen).toEqual([{ amount: 30, label: 'Realized P&L' }, { amount: 70, label: 'Est. profit' }]);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('waits for estimated profit for a verified buy-only position instead of falling back to realized zero', async () => {
    const missing = openPosition(), accounting = missing.realizedAccounting!, position = accounting.position!;
    missing.summary.sellCount = 0;
    accounting.realizedProfitUsd = '0'; position.estimatedProfitUsd = null;
    position.cashFlow = { investedUsd: '18', soldUsd: '0', transferOutIncomeUsd: '0', feesUsd: '2' };
    position.retryAfterMs = 3000;
    expect(verifiedTokenRealizedPnl(missing)).toBe(0); // Valid historical value is still independently available.
    expect(displayedTokenPnl(missing)).toBeNull(); expect(tokenPositionPnlLabel(missing)).toBe('Est. profit');
    const ready = structuredClone(missing);
    ready.realizedAccounting!.position!.estimatedProfitUsd = '40';
    delete ready.realizedAccounting!.position!.retryAfterMs;
    const seen: (number | null)[] = [];
    const fetcher = vi.fn().mockResolvedValueOnce(response(missing)).mockResolvedValue(response(ready));
    const result = createKolTokenPnlLoader({ fetcher })(selection(), signal(), { onActivity: body => seen.push(displayedTokenPnl(body)) });
    await vi.advanceTimersByTimeAsync(3000);
    expect((await result).status).toBe('ready'); expect(seen).toEqual([null, 40]);
    expect(tokenPositionPnlLabel(ready)).toBe('Est. profit');
  });

  it.each(['nonzero', 'sold', 'transferred', 'unknownCashFlow'] as const)('preserves realized fallback when %s evidence makes it useful', variant => {
    const body = openPosition(), accounting = body.realizedAccounting!, position = accounting.position!;
    accounting.realizedProfitUsd = '0'; position.estimatedProfitUsd = null;
    position.cashFlow = { investedUsd: '18', soldUsd: '0', transferOutIncomeUsd: '0', feesUsd: '2' };
    if (variant === 'nonzero') accounting.realizedProfitUsd = '-2';
    if (variant === 'sold') position.cashFlow.soldUsd = '5';
    if (variant === 'transferred') position.cashFlow.transferOutIncomeUsd = '5';
    if (variant === 'unknownCashFlow') delete position.cashFlow;
    expect(displayedTokenPnl(body)).toBe(variant === 'nonzero' ? -2 : 0);
    expect(tokenPositionPnlLabel(body)).toBe('Realized P&L');
  });

  it.each(['stale', 'future', 'undated', 'invalidPrice', 'balanceMismatch', 'unknownSource', 'missingTotal'] as const)
    ('does not present historical realized profit as current open profit for a %s mark', variant => {
      const body = openPosition(), position = body.realizedAccounting!.position!;
      if (variant === 'stale') position.pricedAt = new Date(Date.now() - 180_001).toISOString();
      if (variant === 'future') position.pricedAt = new Date(Date.now() + 1001).toISOString();
      if (variant === 'undated') position.pricedAt = null;
      if (variant === 'invalidPrice') position.priceUsd = '0x10';
      if (variant === 'balanceMismatch') position.remainingTokenAmount = '11';
      if (variant === 'unknownSource') position.valuationSource = null;
      if (variant === 'missingTotal') position.estimatedProfitUsd = null;
      expect(verifiedTokenPositionPnl(body)).toBeNull(); expect(verifiedTokenRealizedPnl(body)).toBe(30);
    });

  it('does not reuse a recently cached open profit after its quote expires', async () => {
    const body = openPosition(); body.realizedAccounting!.position!.pricedAt = new Date(Date.now() - 179_000).toISOString();
    const fresh = openPosition();
    const fetcher = vi.fn().mockResolvedValueOnce(response(body)).mockResolvedValue(response(fresh));
    const loader = createKolTokenPnlLoader({ fetcher });
    expect((await loader(selection(), signal())).status).toBe('ready');
    await vi.advanceTimersByTimeAsync(1001);
    expect((await loader(selection(), signal())).status).toBe('ready'); expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('shows an open total from complete cash flows without inventing a realized/unrealized split', async () => {
    const body = openPosition(), accounting = body.realizedAccounting!, position = accounting.position!;
    accounting.realizedProfitUsd = null; position.remainingCostBasisUsd = null; position.unrealizedProfitUsd = null;
    position.cashFlow = { investedUsd: '18', soldUsd: '30', transferOutIncomeUsd: '10', feesUsd: '2' };
    expect(verifiedTokenRealizedPnl(body)).toBeNull(); expect(verifiedTokenPositionPnl(body)).toBe(70);
    const loader = createKolTokenPnlLoader({ fetcher: vi.fn().mockResolvedValue(response(body)) });
    expect((await loader(selection(), signal())).status).toBe('ready');
    position.cashFlow.feesUsd = 'missing'; expect(verifiedTokenPositionPnl(body)).toBeNull();
    position.cashFlow.feesUsd = '2'; position.estimatedProfitUsd = '700'; expect(verifiedTokenPositionPnl(body)).toBeNull();
    position.estimatedProfitUsd = '70'; position.feeInclusiveCostUsd = '1'; expect(verifiedTokenPositionPnl(body)).toBeNull();
  });
  it('publishes a provisional known estimate immediately and retries toward the reported total without monopolizing card requests', async () => {
    const estimate = activity(); estimate.realizedAccounting!.coverage.reason = 'gmgn_activity_estimate'; estimate.realizedAccounting!.retryAfterMs = 3000;
    const exact = activity(selection(), '31'), seen = vi.fn();
    const fetcher = vi.fn().mockResolvedValueOnce(response(estimate)).mockResolvedValueOnce(response(activity(selection(3)))).mockResolvedValue(response(exact));
    const loader = createKolTokenPnlLoader({ fetcher }), first = loader(selection(), signal(), { onActivity: seen });
    await vi.advanceTimersByTimeAsync(0); expect(seen).toHaveBeenCalledWith(estimate);
    expect((await loader(selection(3), signal())).status).toBe('ready');
    await vi.advanceTimersByTimeAsync(3000); expect(await first).toEqual({ activity: exact, status: 'ready' });
    expect(fetcher).toHaveBeenCalledTimes(3); expect(vi.getTimerCount()).toBe(0);
  });
  it('returns a known estimate during a long aggregate cooldown as pending and never caches it as final', async () => {
    const estimate = activity(); estimate.realizedAccounting!.coverage.reason = 'gmgn_activity_estimate'; estimate.realizedAccounting!.retryAfterMs = 60_000;
    const fetcher = vi.fn().mockResolvedValueOnce(response(estimate)).mockResolvedValue(response(activity(selection(), '31')));
    const loader = createKolTokenPnlLoader({ fetcher });
    expect(await loader(selection(), signal())).toEqual({ activity: estimate, status: 'pending', retryAfterMs: 60_000 });
    expect((await loader(selection(), signal())).activity?.realizedAccounting?.realizedProfitUsd).toBe('31');
    expect(fetcher).toHaveBeenCalledTimes(2); expect(vi.getTimerCount()).toBe(0);
  });
  it('rejects a closed label while canonical tokens remain and never treats a dust quantity as an empty balance', () => {
    const body = openPosition(); body.realizedAccounting!.position!.status = 'closed';
    expect(verifiedTokenPositionPnl(body)).toBeNull();
    body.realizedAccounting!.position!.status = 'open'; body.realizedAccounting!.position!.remainingTokenAmount = '0.0000000000001';
    body.inventory!.coverage.balance = '0'; expect(verifiedTokenPositionPnl(body)).toBeNull();
  });
  it('lets nineteen other cards load before retrying a pending old token, with one background request at a time', async () => {
    const selections = Array.from({ length: 20 }, (_, index) => selection(index + 2));
    const calls: string[] = []; let inFlight = 0, peak = 0, oldCalls = 0;
    const fetcher = vi.fn((input: RequestInfo | URL) => {
      const token = String(input).split('/tokens/')[1].split('/')[0], selected = selections.find(item => item.tokenAddress === token)!;
      calls.push(token); inFlight++; peak = Math.max(peak, inFlight);
      return new Promise<Response>(resolve => setTimeout(() => {
        inFlight--; resolve(response(token === selections[0].tokenAddress && oldCalls++ === 0 ? pending(selected) : activity(selected), 200, '1'));
      }, 5));
    });
    const loader = createKolTokenPnlLoader({ fetcher }), results = selections.map(item => loader(item, signal()));
    await vi.advanceTimersByTimeAsync(999);
    expect(fetcher.mock.calls.every(([url]) => String(url).endsWith('/activity?pnl=true&profile=true'))).toBe(true);
    expect(calls).toEqual(selections.map(item => item.tokenAddress)); expect(peak).toBe(1);
    await vi.advanceTimersByTimeAsync(11);
    expect((await Promise.all(results)).every(result => result.status === 'ready')).toBe(true);
    expect(calls.at(-1)).toBe(selections[0].tokenAddress); expect(calls).toHaveLength(21); expect(vi.getTimerCount()).toBe(0);
  });

  it('gives a foreground modal its own slot without waiting behind a slow card or losing its partial transactions', async () => {
    let release!: (value: Response) => void;
    const fetcher = vi.fn((input: RequestInfo | URL) => String(input).includes(selection().tokenAddress)
      ? new Promise<Response>(resolve => { release = resolve; }) : Promise.resolve(response(activity(selection(3)))));
    const loader = createKolTokenPnlLoader({ fetcher }), background = loader(selection(), signal());
    const queued = loader(selection(4), signal());
    const seen = vi.fn();
    const foreground = loader(selection(3), signal(), { priority: 'foreground', onActivity: seen });
    await vi.advanceTimersByTimeAsync(0);
    expect((await foreground).status).toBe('ready'); expect(fetcher).toHaveBeenCalledTimes(2); expect(seen).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[1][0]).toMatch(/\/activity\?pnl=true$/);
    release(response(activity()));
    await background; await queued; expect(fetcher).toHaveBeenCalledTimes(3); expect(vi.getTimerCount()).toBe(0);
  });

  it('coalesces duplicate selections and does not abort another subscriber when one card unmounts', async () => {
    let release!: (value: Response) => void;
    const fetcher = vi.fn((_input: RequestInfo | URL, _options?: RequestInit) => new Promise<Response>(resolve => { release = resolve; })), loader = createKolTokenPnlLoader({ fetcher });
    const first = new AbortController(), abandoned = loader(selection(), first.signal), retained = loader(selection(), signal());
    const stopped = expect(abandoned).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(0); first.abort(); await stopped;
    expect(fetcher).toHaveBeenCalledOnce(); expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(false);
    release(response(activity())); expect((await retained).status).toBe('ready');
    expect((await loader(selection(), signal())).status).toBe('ready'); expect(fetcher).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels an unmounted queued card before it dispatches and suppresses later callbacks', async () => {
    let release!: (value: Response) => void;
    const fetcher = vi.fn(() => new Promise<Response>(resolve => { release = resolve; })), loader = createKolTokenPnlLoader({ fetcher });
    const first = loader(selection(), signal()), controller = new AbortController(), seen = vi.fn();
    const queued = loader(selection(3), controller.signal, { onActivity: seen }), stopped = expect(queued).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort(); await stopped; await vi.advanceTimersByTimeAsync(0);
    release(response(activity())); await first; await vi.advanceTimersByTimeAsync(0);
    expect(fetcher).toHaveBeenCalledOnce(); expect(seen).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });

  it('releases a hung profile connection after four seconds so the other cards can load', async () => {
    const fetcher = vi.fn().mockImplementationOnce(() => new Promise<Response>(() => {}))
      .mockResolvedValueOnce(response(activity(selection(3)))).mockResolvedValue(response(activity()));
    const loader = createKolTokenPnlLoader({ fetcher }), first = loader(selection(), signal()), second = loader(selection(3), signal());
    await vi.advanceTimersByTimeAsync(4000);
    expect((await second).status).toBe('ready'); expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect((await first).status).toBe('ready'); expect(vi.getTimerCount()).toBe(0);
  });

  it('still allows a foreground history request its bounded twenty-second budget', async () => {
    const fetcher = vi.fn().mockImplementation(() => new Promise<Response>(() => {}));
    const request = createKolTokenPnlLoader({ fetcher })(selection(), signal(), { priority: 'foreground' });
    await vi.advanceTimersByTimeAsync(19_999);
    expect(fetcher.mock.calls[0][1].signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect((await request).status).toBe('pending'); expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retries transient JSON inventory failures while leaving missing purchase cost and mismatches unavailable', async () => {
    for (const reason of ['inventory_rpc_unavailable', 'confirmed_endpoint_stale', 'canonical_block_unavailable']) {
      const body = pending(); body.inventory!.coverage.status = 'unavailable'; body.inventory!.coverage.reason = reason;
      const fetcher = vi.fn().mockResolvedValueOnce(response(body, 200, '1')).mockResolvedValue(response(activity())), loader = createKolTokenPnlLoader({ fetcher });
      const result = loader(selection(), signal()); await vi.advanceTimersByTimeAsync(999); expect(fetcher).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1); expect((await result).status).toBe('ready');
    }
    for (const body of [activity(selection(), null), { ...activity(), kol: { ...activity().kol, address: selection(3).tokenAddress } }]) {
      const fetcher = vi.fn().mockResolvedValue(response(body)), loader = createKolTokenPnlLoader({ fetcher });
      expect((await loader(selection(), signal())).status).toBe('unavailable');
      expect((await loader(selection(), signal())).status).toBe('unavailable'); expect(fetcher).toHaveBeenCalledTimes(2);
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not keep terminal inventory failures pending because downstream accounting has a retry time', async () => {
    const body = pending();
    body.inventory!.coverage.status = 'unavailable'; body.inventory!.coverage.reason = 'inventory_balance_mismatch';
    body.realizedAccounting!.retryAfterMs = 3000;
    const fetcher = vi.fn().mockResolvedValue(response(body)), loader = createKolTokenPnlLoader({ fetcher });
    expect(await loader(selection(), signal())).toEqual({ activity: body, status: 'unavailable' });
    expect(fetcher).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });

  it('never caches an older or missing last-trade snapshot under a new token-card version', async () => {
    for (const value of ['2026-10-14T11:59:00Z', null, 'invalid']) {
      const old = activity(); old.summary.lastTradeAt = value;
      const seen = vi.fn(), fetcher = vi.fn().mockResolvedValueOnce(response(old)).mockResolvedValue(response(activity()));
      const loader = createKolTokenPnlLoader({ fetcher }), result = loader(selection(), signal(), { onActivity: seen });
      await vi.advanceTimersByTimeAsync(999); expect(seen).not.toHaveBeenCalled(); expect(fetcher).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1); expect((await result).status).toBe('ready'); expect(seen).toHaveBeenCalledOnce();
    }
    const newer = activity(); newer.summary.lastTradeAt = '2026-10-14T12:01:00Z';
    const loader = createKolTokenPnlLoader({ fetcher: vi.fn().mockResolvedValue(response(newer)) });
    expect((await loader(selection(), signal())).status).toBe('ready'); expect(vi.getTimerCount()).toBe(0);
  });

  it('accepts a resumed foreground modal with an older exact-pair trade instead of gating it on another wallet’s global token timestamp', async () => {
    const body = activity(); body.summary.lastTradeAt = '2026-10-14T11:00:00Z';
    const fetcher = vi.fn().mockResolvedValue(response(body)), loader = createKolTokenPnlLoader({ fetcher });
    const result = await loader({ ...selection(), lastTradeAt: null }, signal(), { priority: 'foreground' });
    expect(result.status).toBe('ready'); expect(result.activity?.summary.realizedProfitUsd).toBe('30');
    expect(fetcher).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps positive, negative and zero verified totals numeric and rejects incomplete totals', () => {
    for (const value of ['30', '-20', '0']) expect(verifiedTokenRealizedPnl(activity(selection(), value))).toBe(Number(value));
    for (const value of [null, '', ' ', 'NaN']) expect(verifiedTokenRealizedPnl(activity(selection(), value))).toBeNull();
    const incomplete = activity(); incomplete.coverage.complete = false; expect(verifiedTokenRealizedPnl(incomplete)).toBeNull();
    expect(kolTokenPnlKey(selection())).not.toBe(kolTokenPnlKey({ ...selection(), lastTradeAt: '2026-10-14T12:01:00Z' }));
  });
  it('uses David’s validated GMGN realized value even when indexed FIFO profit is unavailable', async () => {
    const selected = { walletAddress: '0x7a2363a401b2340c7941dd2eeff0196a5078d2e6', tokenAddress: '0xba5dd6b869512f7f3acaf565e5c6dde076727777', lastTradeAt: date };
    const body = activity(selected, '348.80'); body.summary.realizedProfitUsd = null;
    body.inventory!.coverage.balance = '8136698.140676733293235668';
    expect(verifiedTokenRealizedPnl(body)).toBe(348.8);
    const fetcher = vi.fn().mockResolvedValue(response(body)), loader = createKolTokenPnlLoader({ fetcher });
    expect(await loader(selected, signal())).toEqual({ activity: body, status: 'ready' });
    expect(fetcher).toHaveBeenCalledWith(expect.stringContaining('/activity?pnl=true'), expect.objectContaining({ cache: 'no-store' }));
  });
  it.each(['missing', 'pending', 'source', 'policy', 'wallet', 'token', 'transactions', 'balance', 'proof', 'staleProof', 'futureProof', 'futureProvider', 'invalidProvider', 'invalidBalance'] as const)
    ('does not substitute FIFO totals when GMGN accounting is %s', variant => {
      const body = activity(); body.summary.realizedProfitUsd = '999';
      if (variant === 'missing') delete body.realizedAccounting;
      if (variant === 'pending') body.realizedAccounting!.status = 'pending';
      if (variant === 'source') Object.assign(body.realizedAccounting!, { source: 'indexed' });
      if (variant === 'policy') Object.assign(body.realizedAccounting!, { policy: 'observed_fifo' });
      if (variant === 'wallet') body.realizedAccounting!.walletAddress = selection(3).tokenAddress;
      if (variant === 'token') body.realizedAccounting!.tokenAddress = selection(3).tokenAddress;
      if (variant === 'transactions') body.realizedAccounting!.coverage.transactionsComplete = false;
      if (variant === 'balance') body.realizedAccounting!.coverage.balanceMatched = false;
      if (variant === 'proof') delete body.inventory;
      if (variant === 'staleProof') body.inventory!.coverage.checkedAt = new Date(Date.now() - 180_001).toISOString();
      if (variant === 'futureProof') body.inventory!.coverage.checkedAt = new Date(Date.now() + 1001).toISOString();
      if (variant === 'futureProvider') body.realizedAccounting!.checkedAt = new Date(Date.now() + 1001).toISOString();
      if (variant === 'invalidProvider') body.realizedAccounting!.checkedAt = 'invalid';
      if (variant === 'invalidBalance') body.inventory!.coverage.balance = '-1';
      expect(verifiedTokenRealizedPnl(body)).toBeNull();
    });
  it('accepts a small server clock skew and rejects malformed nondecimal provider totals', () => {
    const body = activity();
    body.realizedAccounting!.checkedAt = body.inventory!.coverage.checkedAt = new Date(Date.now() + 1000).toISOString();
    expect(verifiedTokenRealizedPnl(body)).toBe(30);
    for (const value of ['0x10', 'Infinity', '1_000', 'true']) {
      body.realizedAccounting!.realizedProfitUsd = value;
      expect(verifiedTokenRealizedPnl(body)).toBeNull();
    }
  });
  it('honors provider cooldowns without retrying early or caching pending values', async () => {
    const body = activity(); body.summary.realizedProfitUsd = '999';
    body.realizedAccounting!.status = 'pending'; body.realizedAccounting!.realizedProfitUsd = null;
    body.realizedAccounting!.retryAfterMs = 75_000; body.realizedAccounting!.coverage.reason = 'provider_rate_limited';
    const fetcher = vi.fn().mockResolvedValueOnce(response(body)).mockResolvedValue(response(activity()));
    const loader = createKolTokenPnlLoader({ fetcher });
    expect(await loader(selection(), signal())).toEqual({ activity: body, status: 'pending', retryAfterMs: 75_000 });
    expect(fetcher).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
    expect((await loader(selection(), signal())).status).toBe('ready'); expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('keeps terminal GMGN unavailability data for explanation and preserves valid transaction details', async () => {
    const body = activity(selection(), null); body.summary.realizedProfitUsd = '999';
    const fetcher = vi.fn().mockResolvedValue(response(body)), loader = createKolTokenPnlLoader({ fetcher });
    expect(await loader(selection(), signal())).toEqual({ activity: body, status: 'unavailable' });
    expect(verifiedTokenRealizedPnl(body)).toBeNull();
    expect((await loader(selection(), signal())).status).toBe('unavailable'); expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
