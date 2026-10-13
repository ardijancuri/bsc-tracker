import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReplayMarketChart } from '../shared/replayChart.js';
import { createReplayChartCache, fetchTradeReplayChart, registerTradeReplayChartRoutes, replayPointsFromBars, replaySparsePointsFromBars } from './tradeReplayChart.js';
import { MarketProviderDeferred } from './geckoApi.js';

const mocks = vi.hoisted(() => ({ query: vi.fn(), geckoFetch: vi.fn() }));
vi.mock('./db.js', () => ({ pool: { query: mocks.query } }));
vi.mock('./geckoApi.js', async original => ({ ...await original<typeof import('./geckoApi.js')>(), geckoFetch: mocks.geckoFetch }));
const token = '0x' + '1'.repeat(40), wallet = '0x' + '2'.repeat(40), poolAddress = '0x' + '3'.repeat(40);
const base = 1791654000;
const iso = (seconds: number) => new Date(seconds * 1000).toISOString();
const bar = (offset: number, open = 1, close = 2) => ({ time: base + offset, open, close });
const poolRow = (pool: string, member: string, liquidity = 100) => ({
  attributes: { address: pool, reserve_in_usd: liquidity }, relationships: { quote_token: { data: { id: `bsc_${member}` } } },
});
const marketRows = [0, 60, 120].map((offset, index) => [base + offset, index + 1, index + 3, .5, index + 2, 20]);
const geckoBody = { data: { attributes: { ohlcv_list: marketRows } } };
const market = (): ReplayMarketChart => ({ address: token, period: 'replay', source: 'geckoterminal', resolution: '1m',
  candles: [], points: [{ timestamp: iso(base), priceUsd: '1' }, { timestamp: iso(base + 180), priceUsd: '4' }],
  updatedAt: iso(base + 600), pending: false, stale: false });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
afterEach(() => { vi.resetAllMocks(); vi.unstubAllEnvs(); });

describe('replay historical market sampling', () => {
  it('places only the opening boundary and actual completed closes on their correct times', () => {
    const points = replayPointsFromBars([bar(60, 3, 4), bar(0, 1, 2), bar(30, 2, 3)], 30,
      (base + 15) * 1000, (base + 75) * 1000, (base + 300) * 1000);
    expect(points).toEqual([
      { timestamp: iso(base), priceUsd: '1' }, { timestamp: iso(base + 30), priceUsd: '2' },
      { timestamp: iso(base + 60), priceUsd: '3' }, { timestamp: iso(base + 90), priceUsd: '4' },
    ]);
  });
  it('refuses an interior data gap or a still-forming close, while allowing gaps outside the trade window', () => {
    expect(replayPointsFromBars([bar(0), bar(60)], 30, (base + 15) * 1000, (base + 75) * 1000, (base + 300) * 1000)).toBeNull();
    expect(replayPointsFromBars([bar(0), bar(30)], 30, (base + 15) * 1000, (base + 45) * 1000, (base + 50) * 1000)).toBeNull();
    expect(replayPointsFromBars([bar(0), bar(120), bar(150)], 30, (base + 125) * 1000, (base + 165) * 1000, (base + 300) * 1000)).toHaveLength(3);
  });
  it('does not turn missing or malformed observations into zero-price samples', () => {
    expect(replayPointsFromBars([bar(0, 0, 2), bar(30, 2, NaN)], 30,
      base * 1000, (base + 45) * 1000, (base + 300) * 1000)).toBeNull();
  });
  it('retains only observed opens and completed closes after sparse-history gaps', () => {
    expect(replaySparsePointsFromBars([bar(120, 5, 6), bar(0, 1, 2), bar(30, 2, 3)], 30,
      (base + 15) * 1000, (base + 135) * 1000, (base + 300) * 1000)).toEqual([
      { timestamp: iso(base), priceUsd: '1' }, { timestamp: iso(base + 30), priceUsd: '2' },
      { timestamp: iso(base + 60), priceUsd: '3' }, { timestamp: iso(base + 120), priceUsd: '5' },
      { timestamp: iso(base + 150), priceUsd: '6' },
    ]);
    // The strict candle/history helper keeps its original meaning.
    expect(replayPointsFromBars([bar(0), bar(30), bar(120)], 30,
      (base + 15) * 1000, (base + 135) * 1000, (base + 300) * 1000)).toBeNull();
  });
  it('does not extrapolate sparse history or use a forming/faulty close to prove coverage', () => {
    const rows = [bar(0), bar(120)];
    expect(replaySparsePointsFromBars(rows, 30, (base - 1) * 1000, (base + 135) * 1000, (base + 300) * 1000)).toBeNull();
    expect(replaySparsePointsFromBars(rows, 30, (base + 15) * 1000, (base + 151) * 1000, (base + 300) * 1000)).toBeNull();
    expect(replaySparsePointsFromBars(rows, 30, (base + 15) * 1000, (base + 135) * 1000, (base + 140) * 1000)).toBeNull();
    expect(replaySparsePointsFromBars([bar(0), bar(120, NaN)], 30, (base + 15) * 1000, (base + 135) * 1000, (base + 300) * 1000)).toBeNull();
    expect(replaySparsePointsFromBars([bar(0), bar(15)], 30, (base + 5) * 1000, (base + 35) * 1000, (base + 300) * 1000)).toBeNull();
  });
  it('uses configured GMGN thirty-second samples, handles second/millisecond rows, and keeps credentials server-side', async () => {
    const gmgnRequest = vi.fn(async (url: URL, _signal: AbortSignal, headers?: Record<string, string>) => {
      expect(url.origin).toBe('https://openapi.gmgn.ai');
      expect(url.searchParams.get('address')).toBe(token);
      expect(url.searchParams.get('resolution')).toBe('30s');
      expect(Number(url.searchParams.get('from'))).toBe(base * 1000 - 300_000);
      expect(Number(url.searchParams.get('to'))).toBe((base + 75) * 1000 + 300_000);
      expect(headers).toEqual({ 'X-APIKEY': 'test-key' });
      return { code: 0, data: { list: [bar(0), { ...bar(30, 2, 3), time: (base + 30) * 1000 }, bar(60, 3, 4)] } };
    });
    const geckoRequest = vi.fn();
    const chart = await fetchTradeReplayChart(token, (base + 15) * 1000, (base + 75) * 1000,
      { gmgnKey: 'test-key', gmgnRequest, geckoRequest, now: (base + 600) * 1000 });
    expect(chart).toMatchObject({ source: 'gmgn', resolution: '30s', candles: [] });
    expect(chart?.points.at(-1)).toEqual({ timestamp: iso(base + 90), priceUsd: '4' });
    expect(JSON.stringify(chart)).not.toContain('test-key');
    expect(geckoRequest).not.toHaveBeenCalled();
  });
  it('pages GMGN backward from the last selected fill rather than fetching hours of later activity', async () => {
    const requests: URL[] = [];
    const gmgnRequest = vi.fn(async (url: URL) => {
      requests.push(url);
      return { code: 0, data: (requests.length === 1 ? [150, 180, 210, 240] : [0, 30, 60, 90, 120]).map(offset => bar(offset)) };
    });
    const chart = await fetchTradeReplayChart(token, (base + 15) * 1000, (base + 245) * 1000,
      { gmgnKey: 'key', gmgnRequest, geckoRequest: vi.fn(), now: (base + 10_000) * 1000 });
    expect(chart?.points).toHaveLength(10);
    expect(requests).toHaveLength(2);
    expect(Number(requests[0].searchParams.get('to'))).toBe((base + 245) * 1000 + 300_000);
    expect(Number(requests[1].searchParams.get('to'))).toBe((base + 150) * 1000 - 1);
  });
  it('pages backward through ascending 100-row responses without skipping unreturned bars', async () => {
    const requests: URL[] = [];
    const gmgnRequest = vi.fn(async (url: URL) => {
      requests.push(url);
      const from = Number(url.searchParams.get('from')), to = Number(url.searchParams.get('to'));
      expect(url.searchParams.get('resolution')).toBe('5m');
      const firstBar = Math.ceil(from / 300_000) * 300_000;
      const count = Math.floor((to - firstBar) / 300_000) + 1;
      expect(count).toBeLessThanOrEqual(1000);
      const returned = Math.min(100, count), start = firstBar + (count - returned) * 300_000;
      return { code: 0, data: Array.from({ length: returned }, (_, index) => ({ time: start + index * 300_000, open: index + 1, close: index + 2 })) };
    });
    const first = (base + 15) * 1000, last = (base + 23 * 3600 + 15) * 1000;
    const chart = await fetchTradeReplayChart(token, first, last,
      { gmgnKey: 'key', gmgnRequest, geckoRequest: vi.fn(), now: (base + 24 * 3600) * 1000 });
    expect(chart).toMatchObject({ source: 'gmgn', resolution: '5m' });
    expect(Date.parse(chart!.points[0].timestamp)).toBeLessThanOrEqual(first);
    expect(Date.parse(chart!.points.at(-1)!.timestamp)).toBeGreaterThanOrEqual(last);
    expect(requests).toHaveLength(3);
    const firstPageLast = Math.floor(Number(requests[0].searchParams.get('to')) / 300_000) * 300_000;
    expect(Number(requests[1].searchParams.get('to'))).toBe(firstPageLast - 99 * 300_000 - 1);
    expect(Number(requests[1].searchParams.get('to'))).toBeGreaterThan(Number(requests[0].searchParams.get('from')));
  });
  it('uses genuine GMGN one-minute bars when thirty-second history is unavailable', async () => {
    const gmgnRequest = vi.fn(async (url: URL) => ({ code: 0,
      data: url.searchParams.get('resolution') === '30s' ? [] : [bar(0, 1, 2), bar(60, 2, 3), bar(120, 3, 4)] }));
    const geckoRequest = vi.fn();
    const chart = await fetchTradeReplayChart(token, (base + 15) * 1000, (base + 135) * 1000,
      { gmgnKey: 'key', gmgnRequest, geckoRequest, now: (base + 600) * 1000 });
    expect(chart).toMatchObject({ source: 'gmgn', resolution: '1m' });
    expect(chart?.points).toEqual([{ timestamp: iso(base), priceUsd: '1' },
      ...[60, 120, 180].map((offset, index) => ({ timestamp: iso(base + offset), priceUsd: String(index + 2) }))]);
    expect(gmgnRequest.mock.calls.map(([url]) => url.searchParams.get('resolution'))).toEqual(['30s', '1m']);
    expect(geckoRequest).not.toHaveBeenCalled();
  });
  it('reserves time for one-minute recovery when a thirty-second request stalls', async () => {
    vi.useFakeTimers();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(milliseconds => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException('Timed out', 'TimeoutError')), milliseconds);
      return controller.signal;
    });
    try {
      const requests: { resolution: string | null; signal: AbortSignal }[] = [];
      const held = deferred<unknown>();
      const gmgnRequest = vi.fn(async (url: URL, signal: AbortSignal) => {
        const resolution = url.searchParams.get('resolution');
        requests.push({ resolution, signal });
        return resolution === '30s' ? held.promise : { code: 0, data: [bar(0), bar(60), bar(120)] };
      });
      const chart = fetchTradeReplayChart(token, (base + 15) * 1000, (base + 135) * 1000,
        { gmgnKey: 'key', gmgnRequest, geckoRequest: vi.fn(), now: (base + 600) * 1000 });
      // Exercise the fine deadline without consuming the overall twenty seconds.
      await vi.advanceTimersByTimeAsync(4000);
      expect(requests.map(request => request.resolution)).toEqual(['30s', '1m']);
      expect(requests[0].signal.aborted).toBe(true);
      expect(requests[1].signal.aborted).toBe(false);
      expect(await chart).toMatchObject({ source: 'gmgn', resolution: '1m' });
      held.resolve({ code: 0, data: [] });
    } finally { timeout.mockRestore(); vi.useRealTimers(); }
  });
  it('uses one-minute history directly when thirty-second 100-row pages cannot cover the trade window', async () => {
    const first = (base + 15) * 1000, last = (base + 4 * 3600 + 15) * 1000;
    const gmgnRequest = vi.fn(async (url: URL) => {
      expect(url.searchParams.get('resolution')).toBe('1m');
      const start = Number(url.searchParams.get('from')), end = Number(url.searchParams.get('to'));
      const count = Math.floor((end - start) / 60_000) + 1, returned = Math.min(count, 100);
      const firstBar = start + (count - returned) * 60_000;
      return { code: 0, data: Array.from({ length: returned }, (_, index) => ({ time: firstBar + index * 60_000, open: 1, close: 2 })) };
    });
    const chart = await fetchTradeReplayChart(token, first, last,
      { gmgnKey: 'key', gmgnRequest, geckoRequest: vi.fn(), now: (base + 40 * 3600) * 1000 });
    expect(chart).toMatchObject({ source: 'gmgn', resolution: '1m' });
    expect(gmgnRequest).toHaveBeenCalledTimes(3);
  });
  it('uses genuine coarser bars when finer observations do not cover the selected window', async () => {
    const gmgnRequest = vi.fn(async (url: URL) => {
      const resolution = url.searchParams.get('resolution');
      return { code: 0, data: resolution === '30s' ? [bar(0), bar(60), bar(120)]
        : resolution === '1m' ? [bar(0), bar(120)] : [bar(0), bar(300), bar(600)] };
    });
    const chart = await fetchTradeReplayChart(token, (base + 15) * 1000, (base + 335) * 1000,
      { gmgnKey: 'key', gmgnRequest, geckoRequest: vi.fn(), now: (base + 1200) * 1000 });
    expect(chart).toMatchObject({ source: 'gmgn', resolution: '5m' });
    expect(gmgnRequest.mock.calls.map(([url]) => url.searchParams.get('resolution'))).toEqual(['30s', '1m', '5m']);
    expect(chart?.points.map(point => point.timestamp)).toEqual([iso(base), iso(base + 300), iso(base + 600), iso(base + 900)]);
  });
  it('retrieves an older sparse window through actual 100-row pages and discloses its gaps', async () => {
    const requests: URL[] = [];
    const observed = new Set<string>();
    const gmgnRequest = vi.fn(async (url: URL) => {
      requests.push(url);
      expect(url.searchParams.get('resolution')).toBe('5m');
      const from = Number(url.searchParams.get('from')), to = Number(url.searchParams.get('to'));
      const rows = [];
      for (let time = Math.ceil(from / 300_000) * 300_000; time <= to; time += 300_000) {
        if (Math.floor(time / 300_000) % 7 !== 0) rows.push({ time, open: 1, close: 2 });
      }
      const returned = rows.slice(-100);
      for (const row of returned) {
        observed.add(`${row.time}:${row.open}`); observed.add(`${row.time + 300_000}:${row.close}`);
      }
      return { code: 0, data: returned };
    });
    const first = (base + 15) * 1000, last = (base + 23 * 3600 + 15) * 1000;
    const chart = await fetchTradeReplayChart(token, first, last,
      { gmgnKey: 'key', gmgnRequest, geckoRequest: vi.fn(), now: (base + 24 * 3600) * 1000 });
    expect(chart).toMatchObject({ source: 'gmgn', resolution: '5m', sparseHistory: true, candles: [] });
    expect(Date.parse(chart!.points[0].timestamp)).toBeLessThanOrEqual(first);
    expect(Date.parse(chart!.points.at(-1)!.timestamp)).toBeGreaterThanOrEqual(last);
    expect(requests).toHaveLength(3);
    expect(chart?.points.every(point => observed.has(`${Date.parse(point.timestamp)}:${point.priceUsd}`))).toBe(true);
  });
  it.each(['busy', 'rate_limited'] as const)('preserves GMGN %s instead of adding interval/provider calls', async reason => {
    const error = new MarketProviderDeferred(reason, 2500);
    const gmgnRequest = vi.fn().mockRejectedValue(error), geckoRequest = vi.fn();
    await expect(fetchTradeReplayChart(token, (base + 15) * 1000, (base + 135) * 1000,
      { gmgnKey: 'key', gmgnRequest, geckoRequest, now: (base + 600) * 1000 })).rejects.toBe(error);
    expect(gmgnRequest).toHaveBeenCalledOnce();
    expect(geckoRequest).not.toHaveBeenCalled();
  });
  it('falls back to genuine one-minute candles from a verified quote-side pool and selects the exact token contract', async () => {
    const unrelated = '0x' + '4'.repeat(40);
    const requests: URL[] = [];
    const geckoRequest = vi.fn(async (url: URL) => {
      requests.push(url);
      return url.pathname.endsWith('/pools') ? { data: [poolRow(unrelated, unrelated, 10000), poolRow(poolAddress, token)] } : geckoBody;
    });
    const chart = await fetchTradeReplayChart(token, (base + 15) * 1000, (base + 135) * 1000,
      { gmgnKey: 'key', gmgnRequest: async () => { throw new Error('Provider unavailable'); }, geckoRequest, now: (base + 600) * 1000 });
    expect(chart).toMatchObject({ source: 'geckoterminal', resolution: '1m', poolAddress, candles: [] });
    expect(chart?.points).toEqual([{ timestamp: iso(base), priceUsd: '1' }, ...[60, 120, 180].map((offset, index) => ({ timestamp: iso(base + offset), priceUsd: String(index + 2) }))]);
    expect(requests[1].pathname).toContain(`${poolAddress}/ohlcv/minute`);
    expect(requests[1].searchParams.get('aggregate')).toBe('1');
    expect(requests[1].searchParams.get('token')).toBe(token);
    expect(requests[1].searchParams.get('include_empty_intervals')).toBe('true');
    expect(requests[1].searchParams.get('currency')).toBe('usd');
    expect(Number(requests[1].searchParams.get('before_timestamp'))).toBe(base + 435);
  });
  it('does not multiply public-provider requests after a provider cooldown', async () => {
    const geckoRequest = vi.fn(async (url: URL) => {
      if (url.pathname.endsWith('/pools')) return { data: [poolRow(poolAddress, token), poolRow('0x' + '5'.repeat(40), token)] };
      throw new Error('Rate limited');
    });
    expect(await fetchTradeReplayChart(token, (base + 15) * 1000, (base + 135) * 1000,
      { geckoRequest, now: (base + 600) * 1000 })).toBeNull();
    expect(geckoRequest).toHaveBeenCalledTimes(2);
  });
  it('preserves a public-provider cooldown for the replay retry contract', async () => {
    const error = new MarketProviderDeferred('rate_limited', 6500);
    const geckoRequest = vi.fn(async (url: URL) => {
      if (url.pathname.endsWith('/pools')) return { data: [poolRow(poolAddress, token)] };
      throw error;
    });
    await expect(fetchTradeReplayChart(token, (base + 15) * 1000, (base + 135) * 1000,
      { geckoRequest, now: (base + 600) * 1000 })).rejects.toBe(error);
    expect(geckoRequest).toHaveBeenCalledTimes(2);
  });
  it('uses another verified pool when a removed or unsupported pool returns 404', async () => {
    const secondPool = '0x' + '5'.repeat(40);
    mocks.geckoFetch.mockImplementation(async (url: URL) => {
      if (url.pathname.endsWith('/pools')) return { ok: true, json: async () => ({ data: [poolRow(poolAddress, token, 200), poolRow(secondPool, token)] }) };
      if (url.pathname.includes(poolAddress)) return { ok: false, status: 404 };
      return { ok: true, json: async () => geckoBody };
    });
    const chart = await fetchTradeReplayChart(token, (base + 15) * 1000, (base + 135) * 1000, { now: (base + 600) * 1000 });
    expect(chart?.poolAddress).toBe(secondPool);
    expect(mocks.geckoFetch).toHaveBeenCalledTimes(3);
  });
  it('discloses missing interior minutes without inserting observations into the gaps', async () => {
    const geckoRequest = vi.fn(async (url: URL) => url.pathname.endsWith('/pools') ? { data: [poolRow(poolAddress, token)] } :
      { data: { attributes: { ohlcv_list: [marketRows[0], marketRows[2]] } } });
    expect(await fetchTradeReplayChart(token, (base + 15) * 1000, (base + 135) * 1000,
      { geckoRequest, now: (base + 600) * 1000 })).toMatchObject({ source: 'geckoterminal', resolution: '1m', sparseHistory: true,
      points: [{ timestamp: iso(base), priceUsd: '1' }, { timestamp: iso(base + 60), priceUsd: '2' },
        { timestamp: iso(base + 120), priceUsd: '3' }, { timestamp: iso(base + 180), priceUsd: '4' }] });
  });
  it('bounds waiting on an already queued public request and ignores its late completion', async () => {
    const hold = deferred<unknown>();
    const controller = new AbortController();
    const geckoRequest = vi.fn(() => hold.promise);
    const pending = fetchTradeReplayChart(token, (base + 15) * 1000, (base + 135) * 1000,
      { geckoRequest, signal: controller.signal, now: (base + 600) * 1000 });
    controller.abort();
    expect(await pending).toBeNull();
    hold.resolve({ data: [poolRow(poolAddress, token)] });
    await Promise.resolve();
    expect(geckoRequest).toHaveBeenCalledOnce();
  });
  it('rejects unsafe token addresses and future trade windows before accessing a provider', async () => {
    const geckoRequest = vi.fn();
    await expect(fetchTradeReplayChart('../token', base * 1000, (base + 5) * 1000, { geckoRequest, now: (base + 600) * 1000 })).rejects.toThrow('Invalid replay history range');
    await expect(fetchTradeReplayChart(token, base * 1000, (base + 700) * 1000, { geckoRequest, now: (base + 600) * 1000 })).rejects.toThrow('Invalid replay history range');
    expect(geckoRequest).not.toHaveBeenCalled();
  });
});

describe('replay chart job cache', () => {
  it('coalesces identical windows, limits unique concurrent work to two, and preserves exact window keys', async () => {
    const pending = deferred<ReplayMarketChart | null>();
    const loader = vi.fn(() => pending.promise);
    const cache = createReplayChartCache(loader, () => 0);
    const first = cache(token, 1, 2), duplicate = cache(token, 1, 2), second = cache(token, 1, 3);
    const busy = await cache(token, 1, 4);
    expect(loader).toHaveBeenCalledTimes(2);
    expect(busy).toMatchObject({ source: 'unavailable', loadStatus: 'queued', retryAfterMs: 3000 });
    const chart = market(); pending.resolve(chart);
    expect(await first).toBe(chart); expect(await duplicate).toBe(chart); expect(await second).toBe(chart);
    expect(await cache(token, 1, 2)).toBe(chart);
    expect(loader).toHaveBeenCalledTimes(2);
  });
  it('briefly caches failed windows without permanently hiding history when the provider recovers', async () => {
    let now = 0;
    const loader = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(market());
    const cache = createReplayChartCache(loader, () => now);
    expect((await cache(token, 1, 2)).source).toBe('unavailable');
    now = 29_999;
    expect((await cache(token, 1, 2)).source).toBe('unavailable');
    expect(loader).toHaveBeenCalledOnce();
    now = 30_001;
    expect((await cache(token, 1, 2)).resolution).toBe('1m');
    expect(loader).toHaveBeenCalledTimes(2);
  });
  it.each([['busy', 'queued'], ['rate_limited', 'rate_limited']] as const)('returns %s with the remaining retry delay and recovers promptly', async (reason, status) => {
    let now = 0;
    const loader = vi.fn().mockRejectedValueOnce(new MarketProviderDeferred(reason, 2500)).mockResolvedValueOnce(market());
    const cache = createReplayChartCache(loader, () => now);
    expect(await cache(token, 1, 2)).toMatchObject({ source: 'unavailable', loadStatus: status, retryAfterMs: 2500 });
    now = 1000;
    expect(await cache(token, 1, 2)).toMatchObject({ source: 'unavailable', loadStatus: status, retryAfterMs: 1500 });
    expect(loader).toHaveBeenCalledOnce();
    now = 2501;
    expect(await cache(token, 1, 2)).toMatchObject({ source: 'geckoterminal', resolution: '1m' });
    expect(loader).toHaveBeenCalledTimes(2);
  });
});

describe('KOL replay chart route', () => {
  it('validates address input before database/provider work and requires indexed tracked activity', async () => {
    const app = Fastify(); registerTradeReplayChartRoutes(app);
    try {
      expect((await app.inject(`/api/kols/bad/tokens/${token}/replay-chart`)).statusCode).toBe(400);
      expect(mocks.query).not.toHaveBeenCalled();
      mocks.query.mockResolvedValue({ rows: [] });
      expect((await app.inject(`/api/kols/${wallet}/tokens/${token}/replay-chart`)).statusCode).toBe(404);
      expect(mocks.geckoFetch).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
  it('derives the exact confirmed pair/window and verified supply on the server without adding normal one-minute charts', async () => {
    vi.stubEnv('GMGN_API_KEY', '');
    mocks.query.mockResolvedValue({ rows: [{ first: iso(base + 15), last: iso(base + 135), supply: '1000000000' }] });
    mocks.geckoFetch.mockImplementation(async (url: URL) => ({ ok: true, json: async () => url.pathname.endsWith('/pools') ? { data: [poolRow(poolAddress, token)] } : geckoBody }));
    const app = Fastify(); registerTradeReplayChartRoutes(app);
    try {
      const response = await app.inject(`/api/kols/${wallet.toUpperCase().replace('0X', '0x')}/tokens/${token}/replay-chart`);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ address: token, period: 'replay', source: 'geckoterminal', resolution: '1m', marketCapSupply: '1000000000', candles: [] });
      expect(mocks.query.mock.calls[0][1]).toEqual([wallet, token]);
      expect(mocks.query.mock.calls[0][0]).toContain('t.block_number IS NOT NULL');
      expect(mocks.query.mock.calls[0][0]).toContain("t.side IN ('buy','sell')");
      expect(mocks.query.mock.calls[0][0]).toContain('k.is_tracked');
      expect(response.headers['cache-control']).toBe('public, max-age=60');
    } finally { await app.close(); }
  });
});
