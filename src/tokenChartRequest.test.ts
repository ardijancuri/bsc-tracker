import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TokenChart } from '../shared/intelligence';
import { createTokenChartRequests } from './tokenChartRequest';
const address = '0x' + 'a'.repeat(40);
const history: TokenChart = { address, period: '5m', source: 'geckoterminal', updatedAt: '2026-10-12T00:00:00Z',
  resolution: '5m', pending: false, stale: false, marketCapSupply: '1000000', supplyCheckedAt: '1970-01-01T00:00:00.000Z',
  candles: [{ time: 100, open: 1, high: 2, low: 1, close: 2, volume: 50 }], points: [{ timestamp: '1970-01-01T00:01:40Z', priceUsd: '2' }] };
const response = (chart: TokenChart) => new Response(JSON.stringify(chart), { headers: { 'Content-Type': 'application/json' } });
afterEach(() => vi.useRealTimers());

describe('browser chart requests', () => {
  it('coalesces concurrent viewers of the same normalized token and timeframe', async () => {
    let complete!: (response: Response) => void;
    const fetcher = vi.fn<typeof fetch>(() => new Promise(resolve => { complete = resolve; }));
    const charts = createTokenChartRequests({ fetcher });
    const one = charts.request(address, '5m');
    const two = charts.request(address.toUpperCase(), '5m');
    expect(two).toBe(one); expect(fetcher).toHaveBeenCalledTimes(1);
    complete(response(history));
    expect(await one).toEqual(history);
  });
  it('aborts a stalled request and releases the job so a later retry can succeed', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>().mockImplementationOnce((_url, options) => new Promise((_resolve,reject) => {
      options?.signal?.addEventListener('abort', () => reject(new DOMException('Timed out', 'AbortError')), { once: true });
    })).mockResolvedValueOnce(response(history));
    const charts = createTokenChartRequests({ fetcher, timeoutMs: 12000 });
    const failed = expect(charts.request(address, '5m')).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(12000); await failed;
    expect(await charts.request(address, '5m')).toEqual(history);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('keeps actual cached prices visible during a provider cooldown without replacing its retry duration', async () => {
    let clock = 0;
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response(history)).mockResolvedValueOnce(response({ ...history,
      candles: [], points: [], source: 'unavailable', marketCapSupply: null, loadStatus: 'rate_limited', retryAfterMs: 120000 }));
    const charts = createTokenChartRequests({ fetcher, now: () => clock });
    await charts.request(address, '5m'); clock = 15000;
    const cached = await charts.request(address, '5m');
    expect(cached).toMatchObject({ candles: history.candles, source: 'geckoterminal', stale: true, loadStatus: 'rate_limited', retryAfterMs: 120000, marketCapSupply: '1000000' });
  });
  it('never caches another token’s response and keeps separate timeframes separate', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response({ ...history, address: '0x'+'b'.repeat(40) }))
      .mockResolvedValueOnce(response(history)).mockResolvedValueOnce(response({ ...history, period: '1h', resolution: '1h' }));
    const charts = createTokenChartRequests({ fetcher });
    await expect(charts.request(address, '5m')).rejects.toThrow('Invalid token chart response');
    expect(charts.peek(address, '5m')).toBeNull();
    await charts.request(address, '5m'); await charts.request(address, '1h');
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(charts.peek(address, '1h')?.resolution).toBe('1h');
  });
  it('retains the volume denomination of cached CMC bars during an empty retry response', async () => {
    let clock = 0;
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response({ ...history, source: 'coinmarketcap', volumeCurrency: 'unknown' }))
      .mockResolvedValueOnce(response({ ...history, source: 'unavailable', candles: [], points: [], loadStatus: 'queued' }));
    const charts = createTokenChartRequests({ fetcher, now: () => clock });
    await charts.request(address, '5m'); clock = 15000;
    expect(await charts.request(address, '5m')).toMatchObject({ source: 'coinmarketcap', candles: history.candles, volumeCurrency: 'unknown', stale: true });
  });
  it('keeps verified supply when new candles arrive before their metadata, including across intervals', async () => {
    let clock = 0;
    const latest = [{ ...history.candles[0], close: 3 }];
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response(history))
      .mockResolvedValueOnce(response({ ...history, period: '1h', resolution: '1h', candles: latest, marketCapSupply: null, supplyCheckedAt: null, supplyPending: true, pending: true, retryAfterMs: 3000 }));
    const charts = createTokenChartRequests({ fetcher, now: () => clock });
    await charts.request(address, '5m'); clock = 15000;
    expect(await charts.request(address, '1h')).toMatchObject({ candles: latest, marketCapSupply: '1000000', supplyCheckedAt: history.supplyCheckedAt, pending: true, retryAfterMs: 3000 });
  });
  it('does not extend the validity of expired supply when fresh candles arrive', async () => {
    let clock = 0;
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response(history))
      .mockResolvedValueOnce(response({ ...history, marketCapSupply: null, supplyCheckedAt: null, supplyPending: true, pending: true }));
    const charts = createTokenChartRequests({ fetcher, now: () => clock });
    await charts.request(address, '5m'); clock = 2 * 86400_000;
    expect(await charts.request(address, '5m')).toMatchObject({ marketCapSupply: null, supplyCheckedAt: null });
  });
  it('restores a verified chart synchronously on reload and refreshes its data in the background', async () => {
    const clock = Date.parse('2026-10-12T12:00:00Z');
    const current = { ...history, updatedAt: new Date(clock).toISOString(), supplyCheckedAt: new Date(clock).toISOString(), candles: [{ ...history.candles[0], time: clock / 1000 - 300 }] };
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
    const first = createTokenChartRequests({ fetcher: vi.fn<typeof fetch>().mockResolvedValue(response(current)), now: () => clock, storage });
    await first.request(address, '5m');
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(current));
    const reloaded = createTokenChartRequests({ fetcher, now: () => clock + 1000, storage });
    expect(reloaded.peek(address, '5m')).toMatchObject({ candles: current.candles, marketCapSupply: '1000000', stale: true });
    expect(fetcher).not.toHaveBeenCalled();
    await reloaded.request(address, '5m'); expect(fetcher).toHaveBeenCalledOnce();
  });
  it('ignores invalid or expired session history and keeps working if browser storage is blocked', async () => {
    const clock = Date.parse('2026-10-12T12:00:00Z');
    const expiredStorage = { getItem: () => JSON.stringify([{ ...history, supplyCheckedAt: new Date(clock - 2 * 86400_000).toISOString() }]), setItem: vi.fn() };
    const expired = createTokenChartRequests({ now: () => clock, storage: expiredStorage });
    expect(expired.peek(address, '5m')).toBeNull();
    const storage = { getItem: () => { throw new Error('Blocked'); }, setItem: () => { throw new Error('Blocked'); } };
    const charts = createTokenChartRequests({ fetcher: vi.fn<typeof fetch>().mockResolvedValue(response(history)), storage });
    expect(await charts.request(address, '5m')).toEqual(history);
  });
});
