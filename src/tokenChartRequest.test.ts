import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TokenChart } from '../shared/intelligence';
import { createTokenChartRequests, tokenChartNeedsForeground, tokenChartRefreshDelay } from './tokenChartRequest';
const address = '0x' + 'a'.repeat(40);
const history: TokenChart = { address, period: '5m', source: 'geckoterminal', updatedAt: '2026-10-12T00:00:00Z',
  resolution: '5m', pending: false, stale: false, marketCapSupply: '1000000', supplyCheckedAt: '1970-01-01T00:00:00.000Z',
  candles: [{ time: 100, open: 1, high: 2, low: 1, close: 2, volume: 50 }], points: [{ timestamp: '1970-01-01T00:01:40Z', priceUsd: '2' }] };
const response = (chart: TokenChart) => new Response(JSON.stringify(chart), { headers: { 'Content-Type': 'application/json' } });
afterEach(() => vi.useRealTimers());

describe('browser chart requests', () => {
  it('displays watchlist history synchronously when opening the equivalent full chart', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response({ ...history, period: '24h' }))
      .mockResolvedValueOnce(response({ ...history, candles: [], points: [], source: 'unavailable', pending: true, loadStatus: 'queued' }));
    const charts = createTokenChartRequests({ fetcher, now: () => 200_000 });
    await charts.request(address, '24h');
    const snapshot = charts.peek(address, '5m');
    expect(snapshot).toMatchObject({ period: '5m', resolution: '5m', candles: history.candles });
    expect(charts.peek(address, '5m')).toBe(snapshot);
    expect(await charts.request(address, '5m')).toMatchObject({ candles: history.candles, stale: true, pending: true });
    expect(fetcher.mock.calls[1][0]).toContain('interval=5m');
  });
  it('clips hourly history to a week without letting a weekly cache stand in for monthly history', async () => {
    const clock = 40 * 86400_000;
    const candles = [20, 39].map(day => ({ ...history.candles[0], time: day * 86400 }));
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ ...history, period: '1h', resolution: '1h', candles }));
    const charts = createTokenChartRequests({ fetcher, now: () => clock });
    await charts.request(address, '1h');
    expect(charts.peek(address, '7d')?.candles).toEqual([candles[1]]);
    expect(charts.peek(address, '30d')?.candles).toEqual(candles);
    const weekly = createTokenChartRequests({ fetcher: vi.fn<typeof fetch>().mockResolvedValue(response({ ...history, period: '7d', resolution: '1h', candles: [candles[1]] })), now: () => clock });
    await weekly.request(address, '7d');
    expect(weekly.peek(address, '1h')).toBeNull();
  });
  it('keeps a confirmed no-history response visible instead of reviving equivalent cached data', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response({ ...history, period: '24h' }))
      .mockResolvedValueOnce(response({ ...history, candles: [], points: [], source: 'unavailable', loadStatus: 'no_history', retryAfterMs: 300_000 }));
    const charts = createTokenChartRequests({ fetcher, now: () => 200_000 });
    await charts.request(address, '24h');
    expect(charts.peek(address, '5m')?.candles).toHaveLength(1);
    await charts.request(address, '5m');
    expect(charts.peek(address, '5m')).toMatchObject({ candles: [], loadStatus: 'no_history' });
  });
  it('publishes completed preloads to mounted subscribers immediately and releases subscriptions', async () => {
    const charts = createTokenChartRequests({ fetcher: vi.fn<typeof fetch>().mockResolvedValueOnce(response(history))
      .mockResolvedValueOnce(response({ ...history, period: '1m', resolution: '1m' })) });
    const updated = vi.fn(), unrelated = vi.fn();
    const unsubscribe = charts.subscribe(address.toUpperCase(), updated);
    charts.subscribe('0x' + 'b'.repeat(40), unrelated);
    await charts.request(address, '5m');
    expect(updated).toHaveBeenCalledOnce(); expect(unrelated).not.toHaveBeenCalled();
    unsubscribe();
    await charts.request(address, '1m');
    expect(updated).toHaveBeenCalledOnce();
  });
  it('requests and restores minute history separately without borrowing five-minute bars', async () => {
    const clock = Date.parse('2026-10-12T12:00:00Z');
    const minute: TokenChart = { ...history, period: '1m', resolution: '1m', updatedAt: new Date(clock).toISOString(), supplyCheckedAt: new Date(clock).toISOString(), candles: [{ ...history.candles[0], time: clock / 1000 - 60 }] };
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response(history)).mockResolvedValueOnce(response(minute));
    const charts = createTokenChartRequests({ fetcher, now: () => clock, storage });
    await charts.request(address, '5m');
    expect(charts.peek(address, '1m')).toBeNull();
    await charts.request(address, '1m');
    expect(fetcher.mock.calls[1][0]).toContain('interval=1m');
    const reloaded = createTokenChartRequests({ now: () => clock + 1000, storage });
    expect(reloaded.peek(address, '1m')).toMatchObject({ period: '1m', resolution: '1m', candles: minute.candles, stale: true });
  });
  it('checks selected loading charts sooner while retaining provider cooldowns', () => {
    expect(tokenChartRefreshDelay({ ...history, pending: true, loadStatus: 'queued', retryAfterMs: 3000 }, true)).toBe(1000);
    expect(tokenChartRefreshDelay({ ...history, pending: true, loadStatus: 'queued', retryAfterMs: 3000 }, false)).toBe(3000);
    expect(tokenChartRefreshDelay({ ...history, pending: false, loadStatus: 'rate_limited', retryAfterMs: 120_000 }, true)).toBe(120_000);
    expect(tokenChartRefreshDelay(history, true)).toBe(30_000);
  });
  it('pauses background work only while foreground history or supply can actively load', () => {
    expect(tokenChartNeedsForeground({ ...history, candles: [], pending: true, loadStatus: 'queued' }, 0)).toBe(true);
    expect(tokenChartNeedsForeground({ ...history, marketCapSupply: null, pending: true, supplyPending: true }, 0)).toBe(true);
    expect(tokenChartNeedsForeground({ ...history, pending: true, supplyPending: true }, 0)).toBe(false);
    for (const loadStatus of ['rate_limited', 'provider_error', 'no_history'] as const) {
      expect(tokenChartNeedsForeground({ ...history, candles: [], pending: true, supplyPending: true, loadStatus, retryAfterMs: 120_000 }, 0)).toBe(false);
    }
  });
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
  it('promotes an in-flight speculative request when the main chart mounts without splitting its consumers', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementationOnce((_url, options) => new Promise((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => reject(new DOMException('Promoted', 'AbortError')), { once: true });
    })).mockResolvedValueOnce(response(history));
    const charts = createTokenChartRequests({ fetcher });
    const preload = charts.request(address, '5m', 'prefetch');
    expect(charts.isForegroundLoading()).toBe(false);
    const mounted = charts.request(address.toUpperCase(), '5m', 'chart');
    expect(mounted).toBe(preload);
    expect(charts.isForegroundLoading()).toBe(true);
    expect(await mounted).toEqual(history);
    expect(await preload).toEqual(history);
    expect(fetcher.mock.calls.map(call => call[0])).toEqual([
      `/api/tokens/${address}/chart?interval=5m&priority=prefetch`,
      `/api/tokens/${address}/chart?interval=5m&priority=chart`,
    ]);
    expect(charts.isForegroundLoading()).toBe(false);
  });
  it('promotes a background queued response immediately rather than reusing its short waiting response', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response({ ...history, candles: [], points: [], pending: true, loadStatus: 'queued', retryAfterMs: 3000 }))
      .mockResolvedValueOnce(response(history));
    const charts = createTokenChartRequests({ fetcher, now: () => 0 });
    await charts.request(address, '5m', 'prefetch');
    expect(await charts.request(address, '5m', 'chart')).toEqual(history);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('refreshes completed background history once at foreground priority while continuing to display its cached candles', async () => {
    let complete!: (response: Response) => void;
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response(history))
      .mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    const charts = createTokenChartRequests({ fetcher, now: () => 0 });
    await charts.request(address, '5m', 'prefetch');
    const cached = charts.peek(address, '5m');
    const main = charts.request(address, '5m', 'chart');
    expect(charts.peek(address, '5m')).toBe(cached);
    expect(fetcher.mock.calls[1][0]).toContain('priority=chart');
    const fresh = { ...history, candles: [{ ...history.candles[0], close: 3 }] };
    complete(response(fresh));
    expect(await main).toEqual(fresh);
    expect(await charts.request(address, '5m', 'chart')).toEqual(fresh);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('holds speculative loading until all mounted main-chart consumers have released their loading lease', () => {
    const charts = createTokenChartRequests();
    const changed = vi.fn();
    const unsubscribe = charts.subscribePriority(changed);
    const releasePage = charts.holdForeground(), releaseModal = charts.holdForeground();
    expect(charts.isForegroundLoading()).toBe(true);
    expect(changed).toHaveBeenCalledOnce();
    releasePage(); releasePage();
    expect(charts.isForegroundLoading()).toBe(true);
    releaseModal();
    expect(charts.isForegroundLoading()).toBe(false);
    expect(changed).toHaveBeenCalledTimes(2);
    unsubscribe(); charts.holdForeground()();
    expect(changed).toHaveBeenCalledTimes(2);
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
  it('does not refetch a cooling provider when another viewer opens the same chart', async () => {
    let clock = 0;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => response({ ...history, loadStatus: 'rate_limited', retryAfterMs: 120_000 }));
    const charts = createTokenChartRequests({ fetcher, now: () => clock });
    await charts.request(address, '5m'); clock = 15_000;
    expect(await charts.request(address, '5m')).toMatchObject({ retryAfterMs: 105_000 });
    expect(fetcher).toHaveBeenCalledOnce();
    clock = 120_000; await charts.request(address, '5m');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('keeps manual retries and foreground promotion inside a provider cooldown even when supply remains pending', async () => {
    let clock = 0;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => response({ ...history, pending: true, supplyPending: true, loadStatus: 'rate_limited', retryAfterMs: 120_000 }));
    const charts = createTokenChartRequests({ fetcher, now: () => clock });
    await charts.request(address, '5m', 'sparkline');
    clock = 15_000;
    expect(await charts.request(address, '5m', 'chart', true)).toMatchObject({ retryAfterMs: 105_000 });
    expect(fetcher).toHaveBeenCalledOnce();
    clock = 120_000;
    await charts.request(address, '5m', 'chart', true);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('allows a manual refresh without erasing valid cached history when its HTTP retry fails', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response(history)).mockResolvedValueOnce(new Response('', { status: 503 }));
    const charts = createTokenChartRequests({ fetcher, now: () => 0 });
    await charts.request(address, '5m');
    const snapshot = charts.peek(address, '5m');
    await expect(charts.request(address, '5m', 'chart', true)).rejects.toThrow('503');
    expect(charts.peek(address, '5m')).toBe(snapshot);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('joins an active manual retry rather than letting another viewer reuse the pre-retry snapshot', async () => {
    let complete!: (response: Response) => void;
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response(history)).mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    const charts = createTokenChartRequests({ fetcher, now: () => 0 });
    await charts.request(address, '5m');
    const retry = charts.request(address, '5m', 'chart', true);
    expect(charts.request(address, '5m')).toBe(retry);
    const fresh = { ...history, candles: [{ ...history.candles[0], close: 3 }] };
    complete(response(fresh));
    expect(await retry).toEqual(fresh);
    expect(fetcher).toHaveBeenCalledTimes(2);
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
  it('keeps old GMGN prices visible while hiding unverified volume until a correctly labelled refresh arrives', async () => {
    const clock = Date.parse('2026-10-12T12:00:00Z');
    const legacy: TokenChart = { ...history, source: 'gmgn', updatedAt: new Date(clock).toISOString(), supplyCheckedAt: new Date(clock).toISOString(), candles: [{ ...history.candles[0], time: clock / 1000 - 300 }] };
    const fresh: TokenChart = { ...legacy, volumeCurrency: 'usd', candles: [{ ...legacy.candles[0], volume: 1234 }] };
    const charts = createTokenChartRequests({ now: () => clock, storage: { getItem: () => JSON.stringify([legacy]), setItem: vi.fn() }, fetcher: vi.fn<typeof fetch>().mockResolvedValue(response(fresh)) });
    expect(charts.peek(address, '5m')).toMatchObject({ candles: legacy.candles, volumeCurrency: 'unknown' });
    expect(await charts.request(address, '5m')).toMatchObject({ candles: fresh.candles, volumeCurrency: 'usd' });
  });
  it('does not label volume from an older GMGN API response as dollars without a denomination', async () => {
    const charts = createTokenChartRequests({ fetcher: vi.fn<typeof fetch>().mockResolvedValue(response({ ...history, source: 'gmgn' })) });
    expect(await charts.request(address, '5m')).toMatchObject({ candles: history.candles, volumeCurrency: 'unknown' });
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
