import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReplayMarketChart } from '../shared/replayChart.js';
import { createReplayChartCache, fetchTradeReplayChart, registerTradeReplayChartRoutes, replayPointsFromBars } from './tradeReplayChart.js';

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
  it('uses configured GMGN thirty-second samples, handles second/millisecond rows, and keeps credentials server-side', async () => {
    const gmgnRequest = vi.fn(async (url: URL, _signal: AbortSignal, headers?: Record<string, string>) => {
      expect(url.origin).toBe('https://openapi.gmgn.ai');
      expect(url.searchParams.get('address')).toBe(token);
      expect(url.searchParams.get('resolution')).toBe('30s');
      expect(Number(url.searchParams.get('from'))).toBe((base + 15) * 1000 - 300_000);
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
  it('does not upsample a missing interior minute or substitute a recent-only market curve', async () => {
    const geckoRequest = vi.fn(async (url: URL) => url.pathname.endsWith('/pools') ? { data: [poolRow(poolAddress, token)] } :
      { data: { attributes: { ohlcv_list: [marketRows[0], marketRows[2]] } } });
    expect(await fetchTradeReplayChart(token, (base + 15) * 1000, (base + 135) * 1000,
      { geckoRequest, now: (base + 600) * 1000 })).toBeNull();
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
