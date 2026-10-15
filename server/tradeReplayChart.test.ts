import Fastify from 'fastify';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReplayMarketChart } from '../shared/replayChart.js';
import type { TokenChart } from '../shared/intelligence.js';
import { createReplayChartCache, fetchTradeReplayChart, registerTradeReplayChartRoutes, replayPointsFromBars, replaySparsePointsFromBars } from './tradeReplayChart.js';
import { MarketProviderDeferred } from './geckoApi.js';
import { kolProfileTokenSql } from './kolProfileToken.js';

const mocks = vi.hoisted(() => ({ query: vi.fn(), geckoFetch: vi.fn(), currentMarketChart: vi.fn() }));
vi.mock('./db.js', () => ({ pool: { query: mocks.query } }));
vi.mock('./geckoApi.js', async original => ({ ...await original<typeof import('./geckoApi.js')>(), geckoFetch: mocks.geckoFetch }));
vi.mock('./tokenChart.js', async original => ({ ...await original<typeof import('./tokenChart.js')>(), currentMarketChart: mocks.currentMarketChart }));
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
const liveMarket = (): TokenChart => ({ address: token, period: '1m', source: 'gmgn', resolution: '1m',
  candles: [{ time: base + 600, open: 5, high: 7, low: 5, close: 7, volume: 10 }], points: [],
  updatedAt: iso(base + 615), pending: false, stale: false });
const historyDirectories: string[] = [];
async function historyDirectory() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'bscan-replay-history-'));
  historyDirectories.push(directory); return directory;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
afterEach(async () => {
  vi.resetAllMocks(); vi.unstubAllEnvs();
  for (const directory of historyDirectories.splice(0)) {
    const resolved = path.resolve(directory);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('bscan-replay-history-')) throw Error('Unsafe test cleanup path');
    await rm(resolved, { recursive: true, force: true });
  }
});

describe('replay historical market sampling', () => {
  it('resumes completed GMGN pages after cooldown without reusing a forming quote', async () => {
    let clock = (base + 280 * 3600 + 1800) * 1000, calls = 0;
    const requested: number[] = [];
    const gmgnRequest = vi.fn(async (url: URL) => {
      calls++; const to = Number(url.searchParams.get('to')); requested.push(to);
      if (calls === 2) throw new MarketProviderDeferred('rate_limited', 3000);
      const latest = Math.floor(to / 3_600_000) * 3600;
      return { code: 0, data: Array.from({ length: 100 }, (_, index) => ({ time: latest - (99 - index) * 3600,
        open: 1, close: latest - (99 - index) * 3600 === base + 280 * 3600 ? 999 : 2 })) };
    });
    const currentChartRequest = vi.fn(async () => ({ ...liveMarket(), updatedAt: new Date(clock).toISOString(),
      candles: [{ time: Math.floor(clock / 60_000) * 60, open: 7, high: 8, low: 7, close: 8, volume: 10 }] }));
    const load = createReplayChartCache((address, first, last, options) => fetchTradeReplayChart(address, first, last,
      { ...options, gmgnKey: 'test-key', gmgnRequest, currentChartRequest, geckoRequest: vi.fn(), now: clock }), () => clock);
    const first = (base + 15) * 1000, last = (base + 260 * 3600) * 1000;
    const pending = await load(token, first, last, true);
    expect(pending.loadStatus).toBe('rate_limited'); expect(pending.points).toHaveLength(0);
    clock += 15_001;
    const ready = await load(token, first, last, true);
    expect(ready.source).toBe('gmgn'); expect(ready.resolution).toBe('1h');
    expect(ready.points.length).toBeGreaterThan(250); expect(ready.currentQuote?.priceUsd).toBe('8');
    expect(ready.points.some(point => point.priceUsd === '999')).toBe(false);
    expect(requested.filter(to => Math.floor(to / 3_600_000) === Math.floor((clock - 15_001) / 3_600_000))).toHaveLength(1);
    expect(requested[1]).toBe(requested[2]);
    clock += 180_001;
    await load(token, first, last, true);
    expect(gmgnRequest.mock.calls.slice(4).some(([url]) => Number(url.searchParams.get('to')) === clock)).toBe(true);
  });
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
  it('coalesces current windows separately and refreshes live quotes after fifteen seconds', async () => {
    let now = 0;
    const ready = deferred<ReplayMarketChart | null>();
    const current = { ...market(), currentQuote: { timestamp: iso(base + 615), priceUsd: '7' } };
    const loader = vi.fn().mockImplementationOnce(() => ready.promise).mockResolvedValue(current);
    const cache = createReplayChartCache(loader, () => now);
    const first = cache(token, 1, 2, true), duplicate = cache(token, 1, 2, true);
    expect(loader).toHaveBeenCalledOnce();
    expect(loader.mock.calls[0][3]).toMatchObject({ current: true });
    ready.resolve(current);
    expect(await first).toBe(current); expect(await duplicate).toBe(current);
    now = 14_999;
    expect(await cache(token, 1, 2, true)).toBe(current);
    expect(loader).toHaveBeenCalledOnce();
    await cache(token, 1, 2);
    expect(loader).toHaveBeenCalledTimes(2);
    expect(loader.mock.calls[1][3]).toMatchObject({ current: false });
    now = 15_001;
    await cache(token, 1, 2, true);
    expect(loader).toHaveBeenCalledTimes(3);
    now = 3_000_000;
    await cache(token, 1, 2);
    expect(loader).toHaveBeenCalledTimes(3);
  });
  it('retries current windows without a current quote after five seconds', async () => {
    let now = 0;
    const loader = vi.fn().mockResolvedValue(market());
    const cache = createReplayChartCache(loader, () => now);
    await cache(token, 1, 2, true);
    now = 4999;
    await cache(token, 1, 2, true);
    expect(loader).toHaveBeenCalledOnce();
    now = 5001;
    await cache(token, 1, 2, true);
    expect(loader).toHaveBeenCalledTimes(2);
  });
  it('does not retain a live quote for the duration of a long historical-provider cooldown', async () => {
    let now = 0;
    const quoted: ReplayMarketChart = { ...market(), source: 'unavailable', points: [], loadStatus: 'rate_limited', retryAfterMs: 60_000,
      currentQuote: { timestamp: iso(base + 615), priceUsd: '7' } };
    const loader = vi.fn().mockResolvedValue(quoted);
    const cache = createReplayChartCache(loader, () => now);
    await cache(token, 1, 2, true);
    now = 1000;
    expect(await cache(token, 1, 2, true)).toMatchObject({ retryAfterMs: 59_000 });
    expect(loader).toHaveBeenCalledOnce();
    now = 15_001;
    await cache(token, 1, 2, true);
    expect(loader).toHaveBeenCalledTimes(2);
  });
  it('retains completed history across live-quote refreshes and discloses only the uncovered tail', async () => {
    let now = (base + 615) * 1000;
    const original = { ...market(), currentQuote: { timestamp: iso(base + 615), priceUsd: '7' } };
    const quoted: ReplayMarketChart = { ...original, source: 'unavailable', points: [],
      loadStatus: 'rate_limited', retryAfterMs: 60_000, currentQuote: { timestamp: iso(base + 631), priceUsd: '8' } };
    const loader = vi.fn().mockResolvedValueOnce(original).mockResolvedValueOnce(quoted);
    const cache = createReplayChartCache(loader, () => now);
    await cache(token, (base + 15) * 1000, (base + 135) * 1000, true);
    now += 16_000;
    const replay = await cache(token, (base + 15) * 1000, (base + 135) * 1000, true);
    expect(replay).toMatchObject({ source: 'geckoterminal', resolution: '1m', points: original.points,
      updatedAt: original.updatedAt, currentQuote: quoted.currentQuote, sparseHistory: true, loadStatus: 'rate_limited', retryAfterMs: 60_000 });
    expect(replay.points.some(point => point.timestamp === quoted.currentQuote!.timestamp)).toBe(false);
    expect(loader).toHaveBeenCalledTimes(2);
  });
  it('never revives or retimestamps the previous current quote when the refresh fails', async () => {
    let now = (base + 615) * 1000;
    const original = { ...market(), currentQuote: { timestamp: iso(base + 615), priceUsd: '7' } };
    const loader = vi.fn().mockResolvedValueOnce(original).mockRejectedValueOnce(new MarketProviderDeferred('rate_limited', 60_000));
    const cache = createReplayChartCache(loader, () => now);
    await cache(token, (base + 15) * 1000, (base + 135) * 1000, true);
    now += 16_000;
    const replay = await cache(token, (base + 15) * 1000, (base + 135) * 1000, true);
    expect(replay).toMatchObject({ source: 'geckoterminal', points: original.points, updatedAt: original.updatedAt,
      loadStatus: 'rate_limited', retryAfterMs: 60_000 });
    expect(replay.currentQuote).toBeUndefined();
    now += 1000;
    expect(await cache(token, (base + 15) * 1000, (base + 135) * 1000, true)).toMatchObject({ retryAfterMs: 59_000 });
    expect(loader).toHaveBeenCalledTimes(2);
    now += 59_001;
    await cache(token, (base + 15) * 1000, (base + 135) * 1000, true);
    expect(loader).toHaveBeenCalledTimes(3);
  });
  it('serves remembered observations while unique refresh work is busy without reviving the old quote', async () => {
    let now = (base + 615) * 1000;
    const held = deferred<ReplayMarketChart | null>();
    const original = { ...market(), currentQuote: { timestamp: iso(base + 615), priceUsd: '7' } };
    const loader = vi.fn().mockResolvedValueOnce(original).mockImplementation(() => held.promise);
    const cache = createReplayChartCache(loader, () => now), first = (base + 15) * 1000, last = (base + 135) * 1000;
    await cache(token, first, last, true);
    now += 16_000;
    const one = cache(token, first, last + 1000, true), two = cache(wallet, first, last, true);
    expect(await cache(token, first, last, true)).toMatchObject({ source: 'geckoterminal', points: original.points,
      loadStatus: 'queued', retryAfterMs: 3000 });
    expect((await cache(token, first, last, true)).currentQuote).toBeUndefined();
    expect(loader).toHaveBeenCalledTimes(3);
    held.resolve(null); await Promise.all([one, two]);
  });
  it.each(['address', 'period'] as const)('never grafts a fresh quote with the wrong %s onto retained history', async field => {
    let now = (base + 615) * 1000;
    const original = { ...market(), currentQuote: { timestamp: iso(base + 615), priceUsd: '7' } };
    const quote = { ...market(), source: 'unavailable', points: [], currentQuote: { timestamp: iso(base + 631), priceUsd: '900' },
      ...(field === 'address' ? { address: wallet } : { period: '1m' }) } as ReplayMarketChart;
    const loader = vi.fn().mockResolvedValueOnce(original).mockResolvedValueOnce(quote);
    const cache = createReplayChartCache(loader, () => now), first = (base + 15) * 1000, last = (base + 135) * 1000;
    await cache(token, first, last, true);
    now += 16_000;
    const replay = await cache(token, first, last, true);
    expect(replay).toMatchObject({ address: token, period: 'replay', source: 'geckoterminal', points: original.points });
    expect(replay.currentQuote).toBeUndefined();
  });
  it('recovers genuine history after process restart without persisting current quotes or supply', async () => {
    const directory = await historyDirectory();
    let now = (base + 615) * 1000;
    const original = { ...market(), marketCapSupply: '1000000000', currentQuote: { timestamp: iso(base + 615), priceUsd: '7' } };
    const first = (base + 15) * 1000, last = (base + 135) * 1000;
    await createReplayChartCache(vi.fn().mockResolvedValue(original), () => now, directory)(token, first, last, true);
    const files = await readdir(directory);
    expect(files).toHaveLength(1);
    const persisted = JSON.parse(await readFile(path.join(directory, files[0]), 'utf8'));
    expect(persisted.value.chart.points).toEqual(original.points);
    expect(persisted.value.chart.currentQuote).toBeUndefined();
    expect(persisted.value.chart.marketCapSupply).toBeUndefined();
    now += 16_000;
    const quote: ReplayMarketChart = { ...original, source: 'unavailable', points: [], currentQuote: { timestamp: iso(base + 631), priceUsd: '9' } };
    const loader = vi.fn().mockResolvedValue(quote), restarted = createReplayChartCache(loader, () => now, directory);
    expect(await restarted(token, first, last, true)).toMatchObject({ source: 'geckoterminal', points: original.points,
      currentQuote: quote.currentQuote, sparseHistory: true });
    expect(loader).toHaveBeenCalledOnce();
    expect((await restarted(token, first, last + 60_000, true)).source).toBe('unavailable');
    expect((await restarted(token, first, last, false)).source).toBe('unavailable');
    expect((await restarted(wallet, first, last, true)).source).toBe('unavailable');
  });
  it.each(['checksum', 'key', 'address', 'source', 'resolution', 'future', 'futureAtSave', 'unordered', 'zero', 'start', 'end', 'expired', 'size'] as const)
    ('rejects %s persisted observations instead of using them as replay history', async variant => {
      const directory = await historyDirectory();
      const now = (base + 615) * 1000, first = (base + 15) * 1000, last = (base + 135) * 1000;
      await createReplayChartCache(vi.fn().mockResolvedValue(market()), () => now, directory)(token, first, last, true);
      const file = path.join(directory, (await readdir(directory))[0]);
      const envelope = JSON.parse(await readFile(file, 'utf8'));
      if (variant === 'key') envelope.value.key += ':different';
      if (variant === 'address') envelope.value.chart.address = wallet;
      if (variant === 'source') envelope.value.chart.source = 'recorded';
      if (variant === 'resolution') envelope.value.chart.resolution = '1d';
      if (variant === 'future') envelope.value.chart.points[1].timestamp = iso(base + 616);
      if (variant === 'futureAtSave') envelope.value.savedAt = (base + 170) * 1000;
      if (variant === 'unordered') envelope.value.chart.points.reverse();
      if (variant === 'zero') envelope.value.chart.points[0].priceUsd = '0';
      if (variant === 'start') envelope.value.chart.points[0].timestamp = iso(base + 16);
      if (variant === 'end') envelope.value.chart.points[1].timestamp = iso(base + 134);
      if (variant === 'expired') envelope.value.savedAt = now - 24 * 3_600_000;
      envelope.checksum = variant === 'checksum' ? 'tampered' : createHash('sha256').update(JSON.stringify(envelope.value)).digest('hex');
      await writeFile(file, variant === 'size' ? ' '.repeat(400 * 1024 + 1) : JSON.stringify(envelope));
      const loader = vi.fn().mockResolvedValue(null);
      const replay = await createReplayChartCache(loader, () => now, directory)(token, first, last, true);
      expect(replay).toMatchObject({ source: 'unavailable', points: [] });
      expect(loader).toHaveBeenCalledOnce();
    });
  it('does not refresh retained-history lifetime just because live quotes succeed', async () => {
    let now = (base + 615) * 1000;
    const original = { ...market(), currentQuote: { timestamp: iso(base + 615), priceUsd: '7' } };
    const loader = vi.fn().mockResolvedValueOnce(original).mockResolvedValue(null);
    const cache = createReplayChartCache(loader, () => now), first = (base + 15) * 1000, last = (base + 135) * 1000;
    await cache(token, first, last, true);
    now += 16_000;
    expect((await cache(token, first, last, true)).points).toEqual(original.points);
    now = (base + 615) * 1000 + 24 * 3_600_000;
    expect(await cache(token, first, last, true)).toMatchObject({ source: 'unavailable', points: [] });
  });
});

describe('current open-replay observations', () => {
  it('continues completed history after the final fill and keeps a forming close as a separate current quote', async () => {
    const gmgnRequest = vi.fn(async (url: URL) => {
      expect(Number(url.searchParams.get('to'))).toBe((base + 615) * 1000);
      return { code: 0, data: [...Array.from({ length: 20 }, (_, index) => bar(index * 30, 1, 2)), bar(600, 2, 9)] };
    });
    const chart = await fetchTradeReplayChart(token, (base + 15) * 1000, (base + 135) * 1000,
      { current: true, gmgnKey: 'key', gmgnRequest, geckoRequest: vi.fn(), currentChartRequest: async () => null, now: (base + 615) * 1000 });
    expect(chart).toMatchObject({ source: 'gmgn', resolution: '30s', currentQuote: { timestamp: iso(base + 615), priceUsd: '9' } });
    expect(chart?.points.at(-1)).toEqual({ timestamp: iso(base + 600), priceUsd: '2' });
    expect(chart?.sparseHistory).toBeUndefined();
    expect(chart?.points.some(point => point.priceUsd === '9' || Date.parse(point.timestamp) > (base + 615) * 1000)).toBe(false);
  });
  it('does not append a current quote or fetch the live market for a closed replay', async () => {
    const gmgnRequest = vi.fn(async () => ({ code: 0, data: [bar(0), bar(30), bar(60), bar(600, 2, 9)] }));
    const currentChartRequest = vi.fn();
    const chart = await fetchTradeReplayChart(token, (base + 15) * 1000, (base + 75) * 1000,
      { gmgnKey: 'key', gmgnRequest, currentChartRequest, geckoRequest: vi.fn(), now: (base + 615) * 1000 });
    expect(chart?.currentQuote).toBeUndefined();
    expect(chart?.points.at(-1)?.timestamp).toBe(iso(base + 90));
    expect(currentChartRequest).not.toHaveBeenCalled();
  });
  it('retains a genuine current quote even when historical coverage is unavailable', async () => {
    const currentChartRequest = vi.fn().mockResolvedValue(liveMarket());
    const chart = await fetchTradeReplayChart(token, (base + 15) * 1000, (base + 135) * 1000,
      { current: true, currentChartRequest, geckoRequest: async () => ({ data: [] }), now: (base + 615) * 1000 });
    expect(chart).toMatchObject({ source: 'unavailable', points: [], currentQuote: { timestamp: iso(base + 615), priceUsd: '7' } });
    expect(currentChartRequest).toHaveBeenCalledOnce();
  });
  it('discloses an uncovered tail between old observations and an independent current quote', async () => {
    const rows = [bar(0), bar(30), bar(60)];
    const chart = await fetchTradeReplayChart(token, (base + 15) * 1000, (base + 75) * 1000,
      { current: true, gmgnKey: 'key', gmgnRequest: async () => ({ code: 0, data: rows }),
        currentChartRequest: async () => liveMarket(), geckoRequest: vi.fn(), now: (base + 615) * 1000 });
    expect(chart).toMatchObject({ source: 'gmgn', resolution: '30s', sparseHistory: true,
      currentQuote: { timestamp: iso(base + 615), priceUsd: '7' } });
    expect(chart?.points).toEqual(replayPointsFromBars(rows, 30, (base + 15) * 1000, (base + 90) * 1000, (base + 615) * 1000));
  });
  it('timestamps a fresh completed one-minute quote at its actual closing boundary', async () => {
    const chart = liveMarket(); chart.candles[0].time = base + 540;
    const result = await fetchTradeReplayChart(token, (base + 15) * 1000, (base + 135) * 1000,
      { current: true, currentChartRequest: async () => chart, geckoRequest: async () => ({ data: [] }), now: (base + 615) * 1000 });
    expect(result?.currentQuote).toEqual({ timestamp: iso(base + 600), priceUsd: '7' });
  });
  it('rejects stale, pending, future, unrelated and synthetic current-chart quotes', async () => {
    const original = liveMarket();
    const variants: TokenChart[] = [
      { ...original, updatedAt: iso(base + 580) }, { ...original, updatedAt: iso(base + 616) },
      { ...original, stale: true }, { ...original, pending: true }, { ...original, address: wallet },
      { ...original, source: 'quote' }, { ...original, source: 'recorded' },
      { ...original, candles: [{ ...original.candles[0], time: base + 660 }] },
      { ...original, candles: [{ ...original.candles[0], time: base + 300 }] },
      { ...original, candles: [{ ...original.candles[0], close: 0 }] },
    ];
    for (const current of variants) {
      expect(await fetchTradeReplayChart(token, (base + 15) * 1000, (base + 135) * 1000,
        { current: true, currentChartRequest: async () => current, geckoRequest: async () => ({ data: [] }), now: (base + 615) * 1000 })).toBeNull();
    }
  });
  it('does not use a cached current quote timestamp from before the final fill', async () => {
    const current = { ...liveMarket(), updatedAt: iso(base + 610) };
    expect(await fetchTradeReplayChart(token, (base + 15) * 1000, (base + 614) * 1000,
      { current: true, currentChartRequest: async () => current, geckoRequest: async () => ({ data: [] }), now: (base + 615) * 1000 })).toBeNull();
  });
  it('starts live work alongside history and preserves a successful quote when history is aborted', async () => {
    const controller = new AbortController(), held = deferred<unknown>();
    const currentChartRequest = vi.fn().mockResolvedValue(liveMarket());
    const gmgnRequest = vi.fn(() => held.promise);
    const pending = fetchTradeReplayChart(token, (base + 15) * 1000, (base + 135) * 1000,
      { current: true, gmgnKey: 'key', gmgnRequest, geckoRequest: vi.fn(), currentChartRequest, signal: controller.signal, now: (base + 615) * 1000 });
    for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
    expect(currentChartRequest).toHaveBeenCalledOnce(); expect(gmgnRequest).toHaveBeenCalledOnce();
    controller.abort();
    expect(await pending).toMatchObject({ source: 'unavailable', points: [], currentQuote: { timestamp: iso(base + 615), priceUsd: '7' } });
    held.resolve({ code: 0, data: [] });
  });
});

describe('KOL replay chart route', () => {
  it('validates address input before database/provider work and requires indexed tracked activity', async () => {
    const app = Fastify(); registerTradeReplayChartRoutes(app);
    try {
      expect((await app.inject(`/api/kols/bad/tokens/${token}/replay-chart`)).statusCode).toBe(400);
      expect((await app.inject(`/api/kols/${wallet}/tokens/${token}/replay-chart?end=tomorrow`)).statusCode).toBe(400);
      expect((await app.inject(`/api/kols/${wallet}/tokens/${token}/replay-chart?end=1799999999`)).statusCode).toBe(400);
      expect(mocks.query).not.toHaveBeenCalled();
      mocks.query.mockResolvedValue({ rows: [] });
      expect((await app.inject(`/api/kols/${wallet}/tokens/${token}/replay-chart`)).statusCode).toBe(404);
      expect(mocks.query.mock.calls[0][0]).toContain(kolProfileTokenSql());
      expect(mocks.geckoFetch).not.toHaveBeenCalled();
      expect(mocks.currentMarketChart).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
  it.each([
    ['XAUt', '0x21caef8a43163eea865baee23b9c2e327696a3bf'],
    ['BTCB', '0x7130d2a12b9bcbfae4f2634d864a1ee1ce3ead9c'],
    ['xOPAI', '0x7ddef360f3c2db4cc41c3967984fefa2598cc9a6'],
  ])('rejects excluded %s contracts before database or historical/current chart requests', async (_symbol, address) => {
    const app = Fastify(); registerTradeReplayChartRoutes(app);
    try {
      for (const contract of [address, address.toUpperCase().replace('0X', '0x')]) {
        for (const ending of ['', '?end=current']) {
          const response = await app.inject(`/api/kols/${wallet}/tokens/${contract}/replay-chart${ending}`);
          expect(response.statusCode).toBe(404);
          expect(response.json()).toEqual({ error: 'KOL token activity not found' });
        }
      }
      expect(mocks.query).not.toHaveBeenCalled();
      expect(mocks.geckoFetch).not.toHaveBeenCalled();
      expect(mocks.currentMarketChart).not.toHaveBeenCalled();
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
      expect(mocks.query.mock.calls[0][0]).toContain(kolProfileTokenSql());
      expect(response.headers['cache-control']).toBe('public, max-age=60');
    } finally { await app.close(); }
  });
  it('bounds current endings to server time and disables browser caching', async () => {
    vi.useFakeTimers(); vi.setSystemTime((base + 615) * 1000);
    vi.stubEnv('GMGN_API_KEY', ''); vi.stubEnv('GMGN_CHART_API_KEY', '');
    const currentToken = '0x' + '7'.repeat(40);
    mocks.currentMarketChart.mockResolvedValue({ chart: null, pending: false });
    mocks.query.mockResolvedValue({ rows: [{ first: iso(base + 15), last: iso(base + 135), supply: '1000' }] });
    const latest = Array.from({ length: 11 }, (_, index) => [base + index * 60, 1, 9, 1, index === 10 ? 9 : 2, 10]);
    mocks.geckoFetch.mockImplementation(async (url: URL) => {
      if (!url.pathname.endsWith('/pools')) expect(Number(url.searchParams.get('before_timestamp'))).toBe(base + 615);
      return { ok: true, json: async () => url.pathname.endsWith('/pools') ? { data: [poolRow(poolAddress, currentToken)] } : { data: { attributes: { ohlcv_list: latest } } } };
    });
    const app = Fastify(); registerTradeReplayChartRoutes(app);
    try {
      const response = await app.inject(`/api/kols/${wallet}/tokens/${currentToken}/replay-chart?end=current`);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ source: 'geckoterminal', currentQuote: { timestamp: iso(base + 615), priceUsd: '9' }, marketCapSupply: '1000' });
      expect(response.json().points.at(-1)).toEqual({ timestamp: iso(base + 600), priceUsd: '2' });
      expect(response.headers['cache-control']).toBe('no-store');
    } finally { await app.close(); vi.useRealTimers(); }
  });
  it('loads a closed replay through its last standalone transfer after the final swap', async () => {
    vi.stubEnv('GMGN_API_KEY', ''); vi.stubEnv('GMGN_CHART_API_KEY', '');
    const movedToken = '0x' + '6'.repeat(40);
    mocks.query.mockResolvedValue({ rows: [{ first: iso(base + 15), last: iso(base + 335), supply: '1000' }] });
    mocks.geckoFetch.mockImplementation(async (url: URL) => {
      if (!url.pathname.endsWith('/pools')) expect(Number(url.searchParams.get('before_timestamp'))).toBe(base + 635);
      return { ok: true, json: async () => url.pathname.endsWith('/pools') ? { data: [poolRow(poolAddress, movedToken)] }
        : { data: { attributes: { ohlcv_list: Array.from({ length: 11 }, (_, index) => [base + index * 60, 1, 3, 1, 2, 10]) } } } };
    });
    const app = Fastify(); registerTradeReplayChartRoutes(app);
    try {
      const response = await app.inject(`/api/kols/${wallet}/tokens/${movedToken}/replay-chart`);
      expect(response.statusCode).toBe(200);
      expect(Date.parse(response.json().points.at(-1).timestamp)).toBeGreaterThanOrEqual((base + 335) * 1000);
      expect(mocks.query.mock.calls[0][0]).toContain("m.kind='transfer'");
      expect(mocks.query.mock.calls[0][0]).toContain('swapped.tx_hash=m.tx_hash');
      expect(mocks.query.mock.calls[0][0]).toContain("swapped.side IN('buy','sell')");
    } finally { await app.close(); }
  });
});
