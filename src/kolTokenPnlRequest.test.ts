import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { KolTokenActivity } from '../shared/kolTokenTrades';
import { createKolTokenPnlLoader, kolTokenPnlKey, verifiedTokenRealizedPnl, type KolTokenPnlSelection } from './kolTokenPnlRequest';

const wallet = '0x' + '1'.repeat(40), date = '2026-10-14T12:00:00Z';
const selection = (index = 2): KolTokenPnlSelection => ({ walletAddress: wallet, tokenAddress: '0x' + index.toString(16).padStart(40, '0'), lastTradeAt: date });
function activity(selected = selection(), value: string | null = '30'): KolTokenActivity {
  return { kol: { address: selected.walletAddress, name: 'Trader', avatarUrl: null, twitter: null, source: 'node', lastSeenAt: date },
    token: { address: selected.tokenAddress, symbol: 'TEST', name: 'Test', logoUrl: null, priceUsd: '1', marketCapUsd: '1000', marketCapSupply: '1000' },
    trades: [], generatedAt: date, coverage: { source: 'indexed', complete: true, indexedTradeCount: 0, returnedTradeCount: 0, historyLimit: 2000, costsIncluded: false },
    summary: { investedUsd: '20', soldUsd: '50', realizedProfitUsd: value, avgBoughtPriceUsd: '1', avgSoldPriceUsd: '2.5', avgBoughtMcapUsd: '1000', avgSoldMcapUsd: '2500',
      remainingTokenAmount: '0', remainingCostBasisUsd: '0', buyCount: 1, sellCount: 1, valuedBuyCount: 1, valuedSellCount: value === null ? 0 : 1,
      excludedSellCount: value === null ? 1 : 0, unpricedTradeCount: 0, firstTradeAt: date, lastTradeAt: date, status: 'closed', profitBasis: 'observed_fifo' },
    inventory: { version: 1, events: [], coverage: { complete: true, reconciled: true, fromBlock: '1', toBlock: '2', blockHash: '0x' + 'a'.repeat(64), checkedAt: date, balance: '0', status: 'verified' } } };
}
function pending(selected = selection(), reason = 'scan_pending') {
  const body = activity(selected, null);
  body.inventory!.coverage = { ...body.inventory!.coverage, complete: false, reconciled: false, status: 'pending', reason };
  return body;
}
const response = (body: unknown, status = 200, retryAfter?: string) => ({ ok: status >= 200 && status < 300, status,
  headers: new Headers(retryAfter ? { 'Retry-After': retryAfter } : {}), json: async () => body }) as Response;
const signal = () => new AbortController().signal;
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(Date.parse(date)); });
afterEach(() => { vi.useRealTimers(); });

describe('fair token-card realized profit loading', () => {
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
});
