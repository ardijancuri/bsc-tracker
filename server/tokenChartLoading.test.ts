import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), cmc: vi.fn(), cmcRequest: vi.fn(), readFile: vi.fn(), writeFile: vi.fn(), mkdir: vi.fn(), rename: vi.fn() }));
vi.mock('node:fs/promises', () => ({ readFile: mocks.readFile, writeFile: mocks.writeFile, mkdir: mocks.mkdir, rename: mocks.rename }));
vi.mock('./geckoApi.js', async importOriginal => ({ ...await importOriginal<typeof import('./geckoApi.js')>(), geckoFetch: mocks.fetch }));
vi.mock('./cmcChart.js', () => ({ fetchCmcMarketCandles: mocks.cmc, cmcRequest: mocks.cmcRequest }));
const address = '0x13920fe6467e9e3c852b8d365a036c995f0f7777';
const poolAddress = '0xfd55be774ea18067bd06a6aed49fb1cc4ad966e9';
const now = 2000000000;
const pools = { data: [{ attributes: { address: poolAddress }, relationships: { base_token: { data: { id: `bsc_${address}` } } } }] };
const history = { data: { attributes: { ohlcv_list: [[now - 60, 1, 2, .5, 1.5, 10], [now - 10 * 86400, 1, 2, .5, 1.5, 10]] } } };
const response = (value: unknown) => ({ ok: true, json: async () => value });

beforeEach(() => {
  vi.resetModules(); vi.resetAllMocks(); vi.useFakeTimers(); vi.setSystemTime(now * 1000);
  vi.stubEnv('GMGN_API_KEY', '');
  vi.stubEnv('GMGN_CHART_API_KEY', '');
  mocks.cmc.mockResolvedValue(null);
  mocks.readFile.mockRejectedValue(new Error('No disk cache'));
  mocks.fetch.mockImplementation(async (url: URL) => response(url.pathname.endsWith('/pools') ? pools : history));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

describe('candle loading and shared cache', () => {
  it('returns an interactive chart as soon as a provider taking more than one second finishes', async () => {
    const { currentMarketChart } = await import('./tokenChart.js');
    mocks.fetch.mockImplementation(async (url: URL) => {
      if (url.pathname.endsWith('/pools')) return response(pools);
      await new Promise(resolve => setTimeout(resolve, 1500));
      return response(history);
    });
    let settled = false;
    const selected = currentMarketChart(address, '5m').then(result => { settled = true; return result; });
    await vi.advanceTimersByTimeAsync(1000);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(500);
    expect(await selected).toMatchObject({ pending: false, chart: { resolution: '5m', candles: [{ close: 1.5 }] } });
    expect(settled).toBe(true);
  });
  it('keeps the shorter watchlist wait and bounds interactive requests when a provider is slow', async () => {
    const { currentMarketChart } = await import('./tokenChart.js');
    mocks.fetch.mockImplementation(() => new Promise(() => {}));
    const background = currentMarketChart(address, '24h');
    await vi.advanceTimersByTimeAsync(1000);
    expect(await background).toMatchObject({ chart: null, pending: true });
    let settled = false;
    const selected = currentMarketChart(address, '5m').then(result => { settled = true; return result; });
    await vi.advanceTimersByTimeAsync(7999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await selected).toMatchObject({ chart: null, pending: true, loadStatus: 'queued' });
    expect(mocks.fetch).toHaveBeenCalledOnce();
  });
  it('serves newly fetched candles while persistent cache writes are still pending', async () => {
    const { currentMarketChart } = await import('./tokenChart.js');
    let finishWrite!: () => void;
    mocks.writeFile.mockImplementation(() => new Promise<void>(resolve => { finishWrite = resolve; }));
    let settled = false;
    const selected = currentMarketChart(address, '5m').then(result => { settled = true; return result; });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(true);
    expect((await selected).chart?.candles).toHaveLength(1);
    expect(mocks.rename).not.toHaveBeenCalled();
    expect((await currentMarketChart(address, '5m')).chart?.candles).toHaveLength(1);
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    finishWrite();
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.rename).toHaveBeenCalledOnce();
  });
  it('keeps minute history separate and never invents minute candles from a cached five-minute chart', async () => {
    const { currentMarketChart } = await import('./tokenChart.js');
    expect((await currentMarketChart(address, '5m')).chart?.resolution).toBe('5m');
    mocks.fetch.mockImplementation(() => new Promise(() => {}));
    const minute = currentMarketChart(address, '1m');
    await vi.advanceTimersByTimeAsync(8000);
    expect(await minute).toMatchObject({ chart: null, pending: true });
    expect(mocks.fetch.mock.calls.at(-1)?.[0].searchParams.get('aggregate')).toBe('1');
  });
  it('reuses genuine cached minute candles immediately for a coarser chart while its full history loads', async () => {
    const { currentMarketChart } = await import('./tokenChart.js');
    const bucket = Math.floor(now / 300) * 300 - 300;
    mocks.fetch.mockImplementation(async (url: URL) => response(url.pathname.endsWith('/pools') ? pools : {
      data: { attributes: { ohlcv_list: [[bucket, 1, 2, .5, 1.5, 10], [bucket + 60, 1.5, 3, 1, 2, 20]] } },
    }));
    expect((await currentMarketChart(address, '1m')).chart?.resolution).toBe('1m');
    mocks.fetch.mockImplementation(() => new Promise(() => {}));
    const coarser = await currentMarketChart(address, '5m');
    expect(coarser).toMatchObject({ pending: true, chart: { resolution: '5m', stale: true, partialHistory: true,
      candles: [{ time: bucket, open: 1, high: 3, low: .5, close: 2, volume: 30 }] } });
  });
  it('distinguishes a provider cooldown from missing 5m history and respects its remaining duration', async () => {
    const { currentMarketChart } = await import('./tokenChart.js');
    const { MarketProviderDeferred } = await import('./geckoApi.js');
    mocks.fetch.mockRejectedValue(new MarketProviderDeferred('rate_limited', 120_000));
    const first = await currentMarketChart(address, '5m');
    expect(first).toMatchObject({ chart: null, pending: false, loadStatus: 'rate_limited', retryAfterMs: 120_000 });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await currentMarketChart(address, '5m')).toMatchObject({ loadStatus: 'rate_limited', retryAfterMs: 105_000 });
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });
  it('retries a busy queue after one slot instead of imposing the old one-minute penalty', async () => {
    const { currentMarketChart } = await import('./tokenChart.js');
    const { MarketProviderDeferred } = await import('./geckoApi.js');
    mocks.fetch.mockRejectedValueOnce(new MarketProviderDeferred('busy', 6500));
    expect(await currentMarketChart(address, '5m')).toMatchObject({ loadStatus: 'queued', retryAfterMs: 6500 });
    await vi.advanceTimersByTimeAsync(6500);
    const result = await currentMarketChart(address, '5m');
    expect(result.chart?.candles).toHaveLength(1);
    expect(result.pending).toBe(false);
    expect(result.loadStatus).toBeUndefined();
  });
  it('reports no history only after a successful provider response actually contains no candles', async () => {
    const { currentMarketChart } = await import('./tokenChart.js');
    mocks.fetch.mockImplementation(async (url: URL) => response(url.pathname.endsWith('/pools') ? pools : { data: { attributes: { ohlcv_list: [] } } }));
    expect(await currentMarketChart(address, '5m')).toMatchObject({ chart: null, pending: false, loadStatus: 'no_history', retryAfterMs: 300_000 });
  });
  it('shares hourly data between weekly, monthly and 1h views without adding upstream calls', async () => {
    const { currentMarketChart } = await import('./tokenChart.js');
    const weekly = await currentMarketChart(address, '7d');
    expect(weekly.chart?.candles).toHaveLength(1);
    const monthly = await currentMarketChart(address, '30d');
    expect(monthly.chart?.candles).toHaveLength(2);
    const hourly = await currentMarketChart(address, '1h');
    expect(hourly.chart?.candles).toHaveLength(2);
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
  });
  it('coalesces discovery across intervals and promotes requests when a full chart joins them', async () => {
    const { currentMarketChart } = await import('./tokenChart.js');
    let finish!: (value: unknown) => void;
    mocks.fetch.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const background = currentMarketChart(address, '24h');
    await vi.advanceTimersByTimeAsync(0);
    const selected = currentMarketChart(address, '4h');
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(mocks.fetch.mock.calls[0][1].priority()).toBe('chart');
    finish(response(pools));
    expect((await selected).chart?.resolution).toBe('4h');
    expect((await background).chart?.resolution).toBe('5m');
    expect(mocks.fetch).toHaveBeenCalledTimes(3);
  });
});
