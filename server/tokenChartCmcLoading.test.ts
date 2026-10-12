import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ cmc: vi.fn(), gecko: vi.fn(), readFile: vi.fn(), writeFile: vi.fn(), mkdir: vi.fn(), rename: vi.fn() }));
vi.mock('node:fs/promises', () => ({ readFile: mocks.readFile, writeFile: mocks.writeFile, mkdir: mocks.mkdir, rename: mocks.rename }));
vi.mock('./cmcChart.js', async original => ({ ...await original<typeof import('./cmcChart.js')>(), cmcRequest: mocks.cmc }));
vi.mock('./geckoApi.js', async original => ({ ...await original<typeof import('./geckoApi.js')>(), geckoFetch: mocks.gecko }));
const address = '0x' + '1'.repeat(40), poolAddress = '0x' + '2'.repeat(40), now = 2_000_000_000_000;
const time = Math.floor(now / 300_000) * 300 - 300;
const body = { status: { error_code: '0' }, data: [[1, 2, .5, 1.5, 9999, time * 1000, 5]] };
const retained = { address, period: '24h', resolution: '5m', source: 'coinmarketcap', volumeCurrency: 'unknown',
  updatedAt: new Date(now - 300_000).toISOString(), candles: [{ time, open: 1, high: 2, low: .5, close: 1.5, volume: 9999 }], points: [], pending: false, stale: false };

beforeEach(() => {
  vi.resetModules(); vi.resetAllMocks(); vi.useFakeTimers(); vi.setSystemTime(now); vi.stubEnv('GMGN_API_KEY', '');
  mocks.readFile.mockRejectedValue(new Error('No disk cache'));
  mocks.cmc.mockResolvedValue(body);
  mocks.gecko.mockImplementation(async (url: URL) => ({ ok: true, json: async () => url.pathname.endsWith('/pools') ? {
    data: [{ attributes: { address: poolAddress }, relationships: { base_token: { data: { id: `bsc_${address}` } } } }],
  } : { data: { attributes: { ohlcv_list: [[time, 1, 2, .5, 1.5, 10]] } } } }));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

describe('keyless chart provider integration', () => {
  it('coalesces watchlist and full chart requests, persists real CMC history, and avoids pool discovery', async () => {
    const { currentMarketChart } = await import('./tokenChart.js');
    const [watchlist, selected] = await Promise.all([currentMarketChart(address, '24h'), currentMarketChart(address, '5m')]);
    expect(watchlist.chart?.source).toBe('coinmarketcap');
    expect(selected.chart).toMatchObject({ source: 'coinmarketcap', period: '5m', volumeCurrency: 'unknown', candles: retained.candles });
    expect(mocks.cmc).toHaveBeenCalledOnce(); expect(mocks.gecko).not.toHaveBeenCalled();
    expect(JSON.parse(mocks.writeFile.mock.calls[0][1])).toMatchObject({ source: 'coinmarketcap', volumeCurrency: 'unknown' });
    expect((await currentMarketChart(address, '5m')).chart?.source).toBe('coinmarketcap');
    expect(mocks.cmc).toHaveBeenCalledOnce();
  });
  it('retains persistent history during cooldown across restarts without additional fallback calls', async () => {
    mocks.readFile.mockResolvedValue(JSON.stringify(retained));
    const { currentMarketChart } = await import('./tokenChart.js');
    const { MarketProviderDeferred } = await import('./geckoApi.js');
    mocks.cmc.mockRejectedValue(new MarketProviderDeferred('rate_limited', 90_000));
    const first = await currentMarketChart(address, '5m');
    expect(first.chart).toMatchObject({ source: 'coinmarketcap', stale: true, volumeCurrency: 'unknown', candles: retained.candles });
    await vi.advanceTimersByTimeAsync(10_000);
    const next = await currentMarketChart(address, '5m');
    expect(next).toMatchObject({ pending: false, loadStatus: 'rate_limited', retryAfterMs: 80_000 });
    expect(next.chart?.candles).toEqual(retained.candles);
    expect(mocks.cmc).toHaveBeenCalledOnce(); expect(mocks.gecko).not.toHaveBeenCalled();
  });
  it.each(['empty', 'rate_limited'])('uses real Gecko history for a cold %s CMC response and then reuses cache', async kind => {
    const { currentMarketChart } = await import('./tokenChart.js');
    const { MarketProviderDeferred } = await import('./geckoApi.js');
    if (kind === 'empty') mocks.cmc.mockResolvedValue({ status: { error_code: 0 }, data: [] });
    else mocks.cmc.mockRejectedValue(new MarketProviderDeferred('rate_limited', 90_000));
    expect((await currentMarketChart(address, '5m')).chart?.source).toBe('geckoterminal');
    expect((await currentMarketChart(address, '5m')).chart?.candles[0].volume).toBe(10);
    expect(mocks.cmc).toHaveBeenCalledOnce(); expect(mocks.gecko).toHaveBeenCalledTimes(2);
  });
  it('honors the primary cooldown when both providers are limited instead of polling empty history', async () => {
    const { currentMarketChart } = await import('./tokenChart.js');
    const { MarketProviderDeferred } = await import('./geckoApi.js');
    mocks.cmc.mockRejectedValue(new MarketProviderDeferred('rate_limited', 90_000));
    mocks.gecko.mockRejectedValue(new MarketProviderDeferred('rate_limited', 30_000));
    expect(await currentMarketChart(address, '5m')).toMatchObject({ chart: null, pending: false, loadStatus: 'rate_limited', retryAfterMs: 90_000 });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await currentMarketChart(address, '5m')).toMatchObject({ chart: null, loadStatus: 'rate_limited', retryAfterMs: 60_000 });
    expect(mocks.cmc).toHaveBeenCalledOnce(); expect(mocks.gecko).toHaveBeenCalledOnce();
  });
  it('allows cold fallback once all in-memory candles have aged outside the requested window', async () => {
    const { currentMarketChart } = await import('./tokenChart.js');
    const { MarketProviderDeferred } = await import('./geckoApi.js');
    await currentMarketChart(address, '5m');
    await vi.advanceTimersByTimeAsync(86_400_000 + 300_000);
    mocks.cmc.mockRejectedValue(new MarketProviderDeferred('rate_limited', 60_000));
    mocks.gecko.mockImplementation(async (url: URL) => ({ ok: true, json: async () => url.pathname.endsWith('/pools') ? {
      data: [{ attributes: { address: poolAddress }, relationships: { base_token: { data: { id: `bsc_${address}` } } } }],
    } : { data: { attributes: { ohlcv_list: [[Math.floor(Date.now() / 1000) - 300, 1, 2, .5, 1.5, 10]] } } } }));
    expect((await currentMarketChart(address, '5m')).chart?.source).toBe('geckoterminal');
    expect(mocks.gecko).toHaveBeenCalledTimes(2);
  });
});
