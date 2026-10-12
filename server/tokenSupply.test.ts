import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTokenSupplyRequests, readTokenSupply } from './tokenSupply.js';
import type { Rpc } from './rpc.js';

const address = '0xdd806e436dda5588bf54061c11590c77ddc87777';
const now = Date.parse('2026-10-12T12:00:00Z');
const word = (value: bigint) => `0x${value.toString(16).padStart(64, '0')}`;
const raw = 1234567890000000000n;
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('verified token supply', () => {
  it('preserves integer precision when formatting 36-decimal units', async () => {
    const value = 1000000000n * 10n ** 36n + 1n;
    const rpc = vi.fn().mockResolvedValue(word(value)) as unknown as Rpc;
    expect(await readTokenSupply(address, 36, rpc, () => now)).toEqual({ raw: value.toString(), decimals: 36,
      units: '1000000000.000000000000000000000000000000000001', checkedAt: '2026-10-12T12:00:00.000Z' });
  });
  it('reads missing decimals from the same contract before calculating units', async () => {
    const rpc = vi.fn(async (_method, params) => (params[0] as any).data === '0x18160ddd' ? word(raw) : word(18n)) as unknown as Rpc;
    expect(await readTokenSupply(address, null, rpc, () => now)).toMatchObject({ decimals: 18, units: '1.23456789' });
    expect(rpc).toHaveBeenCalledTimes(2);
  });
  it('rejects malformed responses and unsupported precision instead of inventing supply', async () => {
    await expect(readTokenSupply(address, 18, vi.fn().mockResolvedValue('0x01') as unknown as Rpc)).rejects.toThrow('Invalid token supply');
    const rpc = vi.fn(async (_method, params) => (params[0] as any).data === '0x18160ddd' ? word(raw) : word(37n)) as unknown as Rpc;
    await expect(readTokenSupply(address, null, rpc)).rejects.toThrow('Invalid token decimals');
    expect(await readTokenSupply(address, 18, vi.fn().mockResolvedValue(word(0n)) as unknown as Rpc)).toBeNull();
  });
  it('attaches an abort deadline to default node calls', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true, json: async () => ({ result: word(raw) }) } as Response);
    expect(await readTokenSupply(address, 18, undefined, () => now)).toMatchObject({ units: '1.23456789' });
    const options = fetcher.mock.calls[0][1]!;
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(String(options.body))).toMatchObject({ method: 'eth_call', params: [{ to: address, data: '0x18160ddd' }, 'latest'] });
  });
});

describe('on-demand supply cache', () => {
  it('returns a fresh recorded supply immediately without calling the node', async () => {
    const rpc = vi.fn() as unknown as Rpc, query = vi.fn();
    const requests = createTokenSupplyRequests({ rpc, query, now: () => now });
    const state = requests.start(address, { rawSupply: raw.toString(), decimals: 18, supplyCheckedAt: new Date(now - 1000) }).snapshot();
    expect(state).toEqual({ supply: '1.23456789', checkedAt: '2026-10-12T11:59:59.000Z', pending: false });
    expect(rpc).not.toHaveBeenCalled(); expect(query).not.toHaveBeenCalled();
  });
  it('coalesces stale supply refreshes across viewers and persists verified raw units', async () => {
    const rpc = vi.fn().mockResolvedValue(word(raw)) as unknown as Rpc, query = vi.fn().mockResolvedValue({});
    const requests = createTokenSupplyRequests({ rpc, query, now: () => now });
    const old = { rawSupply: '99', decimals: 18, supplyCheckedAt: new Date(now - 2 * 86400_000) };
    const states = await Promise.all(Array.from({ length: 4 }, () => requests.start(address, old).settle()));
    expect(states.every(state => state.supply === '1.23456789' && !state.pending)).toBe(true);
    expect(rpc).toHaveBeenCalledOnce();
    expect(query).toHaveBeenCalledWith(expect.stringContaining('supply_checked_at=$4'), [address, raw.toString(), 18, '2026-10-12T12:00:00.000Z']);
  });
  it('returns a short pending response while one background read continues', async () => {
    vi.useFakeTimers();
    let complete!: (value: string) => void;
    const rpc = vi.fn(() => new Promise<string>(resolve => { complete = resolve; })) as unknown as Rpc;
    const query = vi.fn().mockResolvedValue({});
    const requests = createTokenSupplyRequests({ rpc, query, now: () => now, waitMs: 250 });
    const first = requests.start(address, { decimals: 18 });
    const waiting = first.settle();
    await vi.advanceTimersByTimeAsync(250);
    expect(await waiting).toEqual({ supply: null, checkedAt: null, pending: true, retryAfterMs: 3000 });
    expect(requests.start(address, { decimals: 18 }).snapshot().pending).toBe(true);
    expect(rpc).toHaveBeenCalledOnce();
    complete(word(raw)); await vi.advanceTimersByTimeAsync(0);
    expect(first.snapshot()).toEqual({ supply: '1.23456789', checkedAt: '2026-10-12T12:00:00.000Z', pending: false });
  });
  it('uses a retry cooldown after failures and never persists invalid or expired supply', async () => {
    let clock = now;
    const rpc = vi.fn().mockRejectedValue(new Error('Node unavailable')) as unknown as Rpc, query = vi.fn();
    const requests = createTokenSupplyRequests({ rpc, query, now: () => clock });
    const old = { rawSupply: raw.toString(), decimals: 18, supplyCheckedAt: new Date(now - 3 * 86400_000) };
    expect(await requests.start(address, old).settle()).toMatchObject({ supply: null, pending: false, retryAfterMs: 30_000 });
    clock += 1000;
    expect(await requests.start(address, old).settle()).toMatchObject({ retryAfterMs: 29_000 });
    expect(rpc).toHaveBeenCalledOnce(); expect(query).not.toHaveBeenCalled();
    clock += 30_000; await requests.start(address, old).settle();
    expect(rpc).toHaveBeenCalledTimes(2);
  });
  it('retains a verified memory value when database persistence is temporarily unavailable', async () => {
    const rpc = vi.fn().mockResolvedValue(word(raw)) as unknown as Rpc;
    const requests = createTokenSupplyRequests({ rpc, query: vi.fn().mockRejectedValue(new Error('DB unavailable')), now: () => now });
    expect(await requests.start(address, { decimals: 18 }).settle()).toMatchObject({ supply: '1.23456789', pending: false });
    expect(requests.start(address, { decimals: 18 }).snapshot().supply).toBe('1.23456789');
    expect(rpc).toHaveBeenCalledOnce();
  });
});
