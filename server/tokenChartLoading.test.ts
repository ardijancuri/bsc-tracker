import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), readFile: vi.fn(), writeFile: vi.fn(), mkdir: vi.fn(), rename: vi.fn() }));
vi.mock('node:fs/promises', () => ({ readFile: mocks.readFile, writeFile: mocks.writeFile, mkdir: mocks.mkdir, rename: mocks.rename }));
vi.mock('./geckoApi.js', async importOriginal => ({ ...await importOriginal<typeof import('./geckoApi.js')>(), geckoFetch: mocks.fetch }));
const address = '0x13920fe6467e9e3c852b8d365a036c995f0f7777';
const poolAddress = '0xfd55be774ea18067bd06a6aed49fb1cc4ad966e9';
const now = 2000000000;
const pools = { data: [{ attributes: { address: poolAddress }, relationships: { base_token: { data: { id: `bsc_${address}` } } } }] };
const history = { data: { attributes: { ohlcv_list: [[now - 60, 1, 2, .5, 1.5, 10], [now - 10 * 86400, 1, 2, .5, 1.5, 10]] } } };
const response = (value: unknown) => ({ ok: true, json: async () => value });

beforeEach(() => {
  vi.resetModules(); vi.resetAllMocks(); vi.useFakeTimers(); vi.setSystemTime(now * 1000);
  mocks.readFile.mockRejectedValue(new Error('No disk cache'));
  mocks.fetch.mockImplementation(async (url: URL) => response(url.pathname.endsWith('/pools') ? pools : history));
});
afterEach(() => vi.useRealTimers());

describe('candle loading and shared cache', () => {
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
