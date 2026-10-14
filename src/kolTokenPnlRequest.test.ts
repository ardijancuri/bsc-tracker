import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { KolTokenActivity } from '../shared/kolTokenTrades';
import { createKolTokenPnlLoader, kolTokenPnlKey, verifiedTokenPositionPnl, verifiedTokenRealizedPnl, type KolTokenPnlSelection } from './kolTokenPnlRequest';

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
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(Date.parse(date)); });
afterEach(() => { vi.useRealTimers(); });

describe('fair token-card realized profit loading', () => {
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

  it('bounds a hung request to twenty seconds and releases the queue for the next card', async () => {
    const fetcher = vi.fn().mockImplementationOnce(() => new Promise<Response>(() => {})).mockResolvedValue(response(activity(selection(3))));
    const loader = createKolTokenPnlLoader({ fetcher }), first = loader(selection(), signal()), second = loader(selection(3), signal());
    await vi.advanceTimersByTimeAsync(20_000);
    expect((await first).status).toBe('pending'); expect((await second).status).toBe('ready');
    expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true); expect(vi.getTimerCount()).toBe(0);
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
