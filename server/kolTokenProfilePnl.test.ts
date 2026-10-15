import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { KolTokenActivity } from '../shared/kolTokenTrades.js';
import { createKolTokenProfilePnl } from './kolTokenProfilePnl.js';

const checkedAt = '2026-10-14T12:00:00.000Z';
function activity(profit = '70'): KolTokenActivity {
  return {
    kol: { address: '0x' + '1'.repeat(40), name: 'KOL', avatarUrl: null, twitter: null, source: 'gmgn', lastSeenAt: null },
    token: { address: '0x' + '2'.repeat(40), symbol: 'TOKEN', name: 'Token', logoUrl: null, priceUsd: null, marketCapUsd: null, marketCapSupply: null },
    trades: [], summary: { investedUsd: '100', soldUsd: '170', realizedProfitUsd: profit, avgBoughtPriceUsd: null, avgSoldPriceUsd: null,
      avgBoughtMcapUsd: null, avgSoldMcapUsd: null, remainingTokenAmount: '0', remainingCostBasisUsd: '0', buyCount: 1, sellCount: 1,
      valuedBuyCount: 1, valuedSellCount: 1, excludedSellCount: 0, unpricedTradeCount: 0, firstTradeAt: checkedAt, lastTradeAt: checkedAt,
      status: 'closed', profitBasis: 'observed_fifo' },
    inventory: { version: 1, events: [], coverage: { complete: true, reconciled: true, fromBlock: '100', toBlock: '101',
      blockHash: '0x' + '3'.repeat(64), balance: '0', checkedAt } },
    realizedAccounting: { version: 1, source: 'gmgn', policy: 'gmgn_realized_profit_v1', walletAddress: '0x' + '1'.repeat(40),
      tokenAddress: '0x' + '2'.repeat(40), status: 'ready', checkedAt, realizedProfitUsd: profit,
      coverage: { transactionsComplete: true, balanceMatched: true } },
    coverage: { source: 'indexed', indexedTradeCount: 2, returnedTradeCount: 2, complete: true, historyLimit: 2000, costsIncluded: false }, generatedAt: checkedAt,
  };
}
function deferred() {
  let resolve!: (value: KolTokenActivity) => void, reject!: (error: Error) => void;
  const work = new Promise<KolTokenActivity>((accept, fail) => { resolve = accept; reject = fail; });
  return { work, resolve, reject };
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(checkedAt); });
afterEach(() => { vi.useRealTimers(); });

describe('nonblocking profile PNL preparation', () => {
  it('releases a slow request after 75ms while coalescing later polls into the same preparation', async () => {
    vi.useFakeTimers();
    const pending = deferred(), prepare = vi.fn(() => pending.work), load = createKolTokenProfilePnl();
    const first = load('pair', 'revision', prepare), delivered = vi.fn(); void first.then(delivered);
    await vi.advanceTimersByTimeAsync(74); expect(delivered).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect(await first).toBeNull();
    const second = load('pair', 'revision', prepare);
    await vi.advanceTimersByTimeAsync(75); expect(await second).toBeNull(); expect(prepare).toHaveBeenCalledOnce();
    const value = activity(); pending.resolve(value); await vi.advanceTimersByTimeAsync(0);
    expect(await load('pair', 'revision', prepare)).toBe(value); expect(prepare).toHaveBeenCalledOnce();
  });
  it('returns a warm card independently while another token is still preparing', async () => {
    vi.useFakeTimers();
    const load = createKolTokenProfilePnl(), warm = activity(), prepareWarm = vi.fn(async () => warm);
    expect(await load('warm', 'r1', prepareWarm)).toBe(warm);
    const pending = deferred(), slow = load('slow', 'r1', () => pending.work);
    expect(await load('warm', 'r1', prepareWarm)).toBe(warm); expect(prepareWarm).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(75); expect(await slow).toBeNull();
    pending.resolve(activity()); await vi.advanceTimersByTimeAsync(0);
  });
  it('keeps verified cards visible through refresh without duplicating work or renewing evidence', async () => {
    const load = createKolTokenProfilePnl(), previous = activity(), pending = deferred();
    const prepare = vi.fn().mockResolvedValueOnce(previous).mockImplementation(() => pending.work);
    expect(await load('pair', 'revision', prepare)).toBe(previous);
    await vi.advanceTimersByTimeAsync(10_000);
    // Another card's poll must not evict reusable evidence for this one.
    await load('other', 'revision', async () => activity());
    const refreshing = load('pair', 'revision', prepare);
    await vi.advanceTimersByTimeAsync(75);
    expect(await refreshing).toMatchObject({ ...previous, realizedAccounting: { ...previous.realizedAccounting, retryAfterMs: 1000 } });
    const repeated = load('pair', 'revision', prepare);
    await vi.advanceTimersByTimeAsync(75);
    expect(await repeated).toMatchObject(previous); expect(prepare).toHaveBeenCalledTimes(2);
    expect(previous.inventory!.coverage.checkedAt).toBe(checkedAt);
    expect(previous.realizedAccounting!.checkedAt).toBe(checkedAt);
    expect(previous.realizedAccounting!.retryAfterMs).toBeUndefined();
    const next = activity('90'); pending.resolve(next); await vi.advanceTimersByTimeAsync(0);
    expect(await load('pair', 'revision', prepare)).toBe(next);
  });
  it('stops retaining a verified result when evidence expires or the new result contradicts it', async () => {
    const load = createKolTokenProfilePnl(), previous = activity(), pending = deferred();
    previous.inventory!.coverage.checkedAt = new Date(Date.now() - 169_900).toISOString();
    const prepare = vi.fn().mockResolvedValueOnce(previous).mockImplementation(() => pending.work);
    await load('pair', 'revision', prepare); await vi.advanceTimersByTimeAsync(10_000);
    const refreshing = load('pair', 'revision', prepare); await vi.advanceTimersByTimeAsync(75);
    expect(await refreshing).toMatchObject(previous);
    const expired = load('pair', 'revision', prepare); await vi.advanceTimersByTimeAsync(75);
    expect(await expired).toBeNull();
    const rejected = activity(); rejected.realizedAccounting!.status = 'unavailable'; rejected.realizedAccounting!.realizedProfitUsd = null;
    pending.resolve(rejected); await vi.advanceTimersByTimeAsync(0);
    expect(await load('pair', 'revision', prepare)).toBe(rejected);
  });
  it('keeps a usable result while all preparation slots are occupied, then refreshes once a slot is free', async () => {
    const load = createKolTokenProfilePnl({ maxJobs: 1 }), previous = activity(), pending = deferred();
    const prepare = vi.fn().mockResolvedValueOnce(previous).mockResolvedValue(activity('90'));
    await load('pair', 'revision', prepare); await vi.advanceTimersByTimeAsync(10_000);
    const other = load('other', 'revision', () => pending.work); await vi.advanceTimersByTimeAsync(75);
    expect(await other).toBeNull();
    expect(await load('pair', 'revision', prepare)).toMatchObject(previous);
    expect(await load('pair', 'revision', prepare)).toMatchObject(previous); expect(prepare).toHaveBeenCalledOnce();
    pending.resolve(activity()); await vi.advanceTimersByTimeAsync(0);
    expect(await load('pair', 'revision', prepare)).toMatchObject({ realizedAccounting: { realizedProfitUsd: '90' } });
    expect(prepare).toHaveBeenCalledTimes(2);
  });
  it('refreshes GMGN-history snapshots when the original history verification expires', async () => {
    const load = createKolTokenProfilePnl(), previous = activity(), fresh = activity('90');
    previous.inventory!.coverage.complete = false;
    Object.assign(previous.realizedAccounting!.coverage, { verification: 'gmgn_history', historyCheckedAt: new Date(Date.now() - 29_500).toISOString(),
      balanceProof: { checkedAt } });
    const prepare = vi.fn().mockResolvedValueOnce(previous).mockResolvedValue(fresh);
    expect(await load('pair', 'revision', prepare)).toBe(previous);
    await vi.advanceTimersByTimeAsync(501);
    expect(await load('pair', 'revision', prepare)).toBe(fresh); expect(prepare).toHaveBeenCalledTimes(2);
  });
  it('does not publish an older revision over a newer completed response', async () => {
    vi.useFakeTimers();
    const load = createKolTokenProfilePnl(), previous = deferred(), prepareOld = vi.fn(() => previous.work);
    const old = load('pair', 'old', prepareOld); await vi.advanceTimersByTimeAsync(75); expect(await old).toBeNull();
    const newer = activity('80'), prepareNew = vi.fn(async () => newer);
    expect(await load('pair', 'new', prepareNew)).toBe(newer);
    previous.resolve(activity('70')); await vi.advanceTimersByTimeAsync(0);
    expect(await load('pair', 'new', prepareNew)).toBe(newer); expect(prepareNew).toHaveBeenCalledOnce();
  });
  it('retains original proof, accounting, quote, and generation timestamps for at most ten seconds', async () => {
    vi.useFakeTimers(); vi.setSystemTime(checkedAt);
    const load = createKolTokenProfilePnl(), value = activity();
    value.realizedAccounting!.position = { status: 'open', remainingTokenAmount: '5', remainingCostBasisUsd: '20', feeInclusiveCostUsd: '100',
      estimatedProfitUsd: '80', estimatedRoi: '0.8', unrealizedProfitUsd: '10', priceUsd: '6', pricedAt: checkedAt, valuationSource: 'gmgn' };
    const original = structuredClone(value), prepare = vi.fn(async () => value);
    expect(await load('pair', 'r1', prepare)).toEqual(original);
    await vi.advanceTimersByTimeAsync(9999);
    expect(await load('pair', 'r1', prepare)).toEqual(original); expect(prepare).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(await load('pair', 'r1', prepare)).toEqual(original); expect(prepare).toHaveBeenCalledTimes(2);
  });
  it.each(['proof', 'quote'] as const)('refreshes cached ready PNL as soon as its %s expires, before ten seconds', async field => {
    const load = createKolTokenProfilePnl(), initial = activity();
    const almostExpired = new Date(Date.now() - 179_000).toISOString();
    if (field === 'proof') initial.inventory!.coverage.checkedAt = almostExpired;
    else initial.realizedAccounting!.position = { status: 'open', remainingTokenAmount: '5', remainingCostBasisUsd: '20', feeInclusiveCostUsd: '100',
      estimatedProfitUsd: '80', estimatedRoi: '0.8', unrealizedProfitUsd: '10', priceUsd: '6', pricedAt: almostExpired, valuationSource: 'market' };
    const original = structuredClone(initial), fresh = activity('90');
    const prepare = vi.fn().mockResolvedValueOnce(initial).mockResolvedValue(fresh);
    expect(await load('pair', 'r1', prepare)).toEqual(original);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await load('pair', 'r1', prepare)).toEqual(original); expect(prepare).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(await load('pair', 'r1', prepare)).toBe(fresh); expect(prepare).toHaveBeenCalledTimes(2);
    expect(initial).toEqual(original);
  });
  it.each(['proof', 'quote'] as const)('does not reuse cached ready PNL with an invalid or future %s timestamp', async field => {
    for (const date of [null, 'invalid', new Date(Date.now() + 1001).toISOString()]) {
      const load = createKolTokenProfilePnl(), invalid = activity(), fresh = activity('90');
      if (field === 'proof') invalid.inventory!.coverage.checkedAt = date;
      else invalid.realizedAccounting!.position = { status: 'open', remainingTokenAmount: '5', remainingCostBasisUsd: '20', feeInclusiveCostUsd: '100',
        estimatedProfitUsd: '80', estimatedRoi: '0.8', unrealizedProfitUsd: '10', priceUsd: '6', pricedAt: date, valuationSource: 'market' };
      const prepare = vi.fn().mockResolvedValueOnce(invalid).mockResolvedValue(fresh);
      await load('pair', 'r1', prepare);
      expect(await load('pair', 'r1', prepare)).toBe(fresh); expect(prepare).toHaveBeenCalledTimes(2);
    }
  });
  it('preserves the delivery lifetime for pending payloads even when their proof is expired', async () => {
    const load = createKolTokenProfilePnl(), pending = activity(), fresh = activity('90');
    pending.realizedAccounting!.status = 'pending'; pending.realizedAccounting!.realizedProfitUsd = null;
    pending.inventory!.coverage.checkedAt = new Date(Date.now() - 180_001).toISOString();
    const prepare = vi.fn().mockResolvedValueOnce(pending).mockResolvedValue(fresh);
    expect(await load('pair', 'r1', prepare)).toBe(pending);
    await vi.advanceTimersByTimeAsync(999);
    expect(await load('pair', 'r1', prepare)).toBe(pending); expect(prepare).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(await load('pair', 'r1', prepare)).toBe(fresh); expect(prepare).toHaveBeenCalledTimes(2);
  });
  it('keeps a completed pending result until delivery, then retries after one second without extending that deadline', async () => {
    vi.useFakeTimers();
    const load = createKolTokenProfilePnl(), pending = deferred(), value = activity();
    value.realizedAccounting!.status = 'pending'; value.realizedAccounting!.realizedProfitUsd = null;
    const prepare = vi.fn(() => pending.work), first = load('pair', 'r1', prepare);
    await vi.advanceTimersByTimeAsync(75); expect(await first).toBeNull();
    pending.resolve(value); await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(3000);
    expect(await load('pair', 'r1', prepare)).toBe(value); expect(prepare).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(999);
    expect(await load('pair', 'r1', prepare)).toBe(value); expect(prepare).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    await load('pair', 'r1', prepare); expect(prepare).toHaveBeenCalledTimes(2);
  });
  it('refreshes a valid open-position estimate after one delivered second when its quote refresh is pending', async () => {
    vi.useFakeTimers(); vi.setSystemTime(checkedAt);
    const load = createKolTokenProfilePnl(), initial = activity(), pending = deferred();
    initial.realizedAccounting!.position = { status: 'open', remainingTokenAmount: '5', remainingCostBasisUsd: '20', feeInclusiveCostUsd: '100',
      estimatedProfitUsd: '80', estimatedRoi: '0.8', unrealizedProfitUsd: '10', priceUsd: '6', pricedAt: checkedAt,
      valuationSource: 'market', retryAfterMs: 3000, reason: 'quote_rate_limited' };
    const fresh = structuredClone(initial); delete fresh.realizedAccounting!.position!.retryAfterMs;
    delete fresh.realizedAccounting!.position!.reason;
    const prepare = vi.fn().mockImplementationOnce(() => pending.work).mockResolvedValue(fresh);
    const first = load('pair', 'r1', prepare);
    await vi.advanceTimersByTimeAsync(75); expect(await first).toBeNull();
    pending.resolve(initial); await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(3000);
    // The first delivery must remain usable even if preparation completed earlier.
    expect(await load('pair', 'r1', prepare)).toBe(initial); expect(prepare).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(999);
    expect(await load('pair', 'r1', prepare)).toBe(initial); expect(prepare).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(await load('pair', 'r1', prepare)).toBe(fresh); expect(prepare).toHaveBeenCalledTimes(2);
  });
  it('caps preparation at eight active jobs and recovers a slot after failure', async () => {
    vi.useFakeTimers();
    const load = createKolTokenProfilePnl(), pending = Array.from({ length: 8 }, deferred);
    const preparations = pending.map(item => vi.fn(() => item.work));
    const active = preparations.map((prepare, index) => load(String(index), 'r1', prepare));
    const extra = deferred(), prepareExtra = vi.fn(() => extra.work);
    expect(await load('ninth', 'r1', prepareExtra)).toBeNull(); expect(prepareExtra).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(75); expect(await Promise.all(active)).toEqual(Array(8).fill(null));
    // HTTP replies alone must not release still-running provider work.
    expect(await load('ninth', 'r1', prepareExtra)).toBeNull(); expect(prepareExtra).not.toHaveBeenCalled();
    pending[0].reject(Error('provider failure')); await vi.advanceTimersByTimeAsync(0);
    const admitted = load('ninth', 'r1', prepareExtra); await vi.advanceTimersByTimeAsync(0);
    expect(prepareExtra).toHaveBeenCalledOnce();
    extra.resolve(activity()); expect(await admitted).not.toBeNull();
    for (const item of pending.slice(1)) item.resolve(activity()); await vi.advanceTimersByTimeAsync(0);
  });
  it('does not let revision churn bypass the active limit and never caches a synchronous preparation error', async () => {
    vi.useFakeTimers();
    const load = createKolTokenProfilePnl({ maxJobs: 1 }), pending = deferred();
    const first = load('pair', 'old', () => pending.work); await vi.advanceTimersByTimeAsync(75); expect(await first).toBeNull();
    const replacement = vi.fn(async () => activity('80'));
    expect(await load('pair', 'new', replacement)).toBeNull(); expect(replacement).not.toHaveBeenCalled();
    pending.reject(Error('provider failure')); await vi.advanceTimersByTimeAsync(0);
    const fail = vi.fn(() => { throw Error('sync failure'); });
    expect(await load('pair', 'new', fail)).toBeNull();
    expect(await load('pair', 'new', replacement)).toMatchObject({ realizedAccounting: { realizedProfitUsd: '80' } });
    expect(replacement).toHaveBeenCalledOnce();
  });
});
