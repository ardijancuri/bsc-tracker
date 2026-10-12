import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ gmgn: vi.fn(), cmc: vi.fn(), cmcRequest: vi.fn(), gecko: vi.fn(), readFile: vi.fn(), writeFile: vi.fn(), mkdir: vi.fn(), rename: vi.fn() }));
vi.mock('node:fs/promises', () => ({ readFile: mocks.readFile, writeFile: mocks.writeFile, mkdir: mocks.mkdir, rename: mocks.rename }));
vi.mock('./gmgnApi.js', () => ({ gmgnRequest: mocks.gmgn }));
vi.mock('./cmcChart.js', () => ({ fetchCmcMarketCandles: mocks.cmc, cmcRequest: mocks.cmcRequest }));
vi.mock('./geckoApi.js', async importOriginal => ({ ...await importOriginal<typeof import('./geckoApi.js')>(), geckoFetch: mocks.gecko }));
const address = '0x' + '1'.repeat(40), now = 2_000_000_000_000;
const row = { time: now / 1000 - 300, open: '1', high: '2', low: '.5', close: '1.5', amount: '25', volume: '999999' };
const retained = { address, period: '24h', resolution: '5m', source: 'gmgn', updatedAt: new Date(now - 300_000).toISOString(), pending: false, stale: false,
  candles: [{ time: row.time, open: 1, high: 2, low: .5, close: 1.5, volume: 25 }], points: [] };
beforeEach(() => {
  vi.resetModules(); vi.resetAllMocks(); vi.useFakeTimers(); vi.setSystemTime(now); vi.stubEnv('GMGN_API_KEY', 'private-test-key');
  mocks.readFile.mockRejectedValue(new Error('No disk cache'));
  mocks.gmgn.mockResolvedValue({ code: 0, data: { list: [row] } });
  mocks.cmc.mockResolvedValue(null);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

describe('GMGN chart caching and request coalescing', () => {
  it('coalesces watchlist/page jobs, persists normalized genuine history, and reuses cache without another account request', async () => {
    const { currentMarketChart } = await import('./tokenChart.js');
    const [watchlist, selected] = await Promise.all([currentMarketChart(address, '24h'), currentMarketChart(address, '5m')]);
    expect(watchlist.chart?.source).toBe('gmgn'); expect(selected.chart?.candles[0].volume).toBe(25);
    expect(mocks.gmgn).toHaveBeenCalledOnce(); expect(mocks.gecko).not.toHaveBeenCalled();
    expect(mocks.cmc).not.toHaveBeenCalled();
    expect((await currentMarketChart(address, '5m')).chart?.source).toBe('gmgn'); expect(mocks.gmgn).toHaveBeenCalledOnce();
    const stored = mocks.writeFile.mock.calls[0][1];
    expect(JSON.parse(stored)).toMatchObject({ source: 'gmgn', candles: [{ volume: 25 }] });
    expect(stored).not.toContain('private-test-key');
  });
  it('loads GMGN history from persistent cache after a restart and keeps it while a refresh is cooling down', async () => {
    mocks.readFile.mockResolvedValue(JSON.stringify(retained));
    const { currentMarketChart } = await import('./tokenChart.js');
    const { MarketProviderDeferred } = await import('./geckoApi.js');
    mocks.gmgn.mockRejectedValue(new MarketProviderDeferred('rate_limited', 120_000));
    const first = await currentMarketChart(address, '5m');
    expect(first.chart).toMatchObject({ source: 'gmgn', stale: true, candles: retained.candles });
    await vi.advanceTimersByTimeAsync(10_000);
    const next = await currentMarketChart(address, '5m');
    expect(next).toMatchObject({ pending: false, loadStatus: 'rate_limited', retryAfterMs: 110_000 });
    expect(next.chart?.candles).toEqual(retained.candles);
    expect(mocks.gmgn).toHaveBeenCalledOnce(); expect(mocks.gecko).not.toHaveBeenCalled();
    expect(mocks.cmc).not.toHaveBeenCalled();
  });
  it('shows an actual Gecko fallback once and caches it instead of retrying a missing GMGN history on every poll', async () => {
    mocks.gmgn.mockResolvedValue({ code: 0, data: { list: [] } });
    mocks.gecko.mockImplementation(async (url: URL) => ({ ok: true, json: async () => url.pathname.endsWith('/pools') ? {
      data: [{ attributes: { address: '0x' + '2'.repeat(40) }, relationships: { base_token: { data: { id: `bsc_${address}` } } } }],
    } : { data: { attributes: { ohlcv_list: [[row.time, 1, 2, .5, 1.5, 10]] } } } }));
    const { currentMarketChart } = await import('./tokenChart.js');
    expect((await currentMarketChart(address, '5m')).chart?.source).toBe('geckoterminal');
    expect((await currentMarketChart(address, '5m')).chart?.source).toBe('geckoterminal');
    expect(mocks.gmgn).toHaveBeenCalledOnce(); expect(mocks.gecko).toHaveBeenCalledTimes(2);
    expect(mocks.cmc).toHaveBeenCalledOnce(); expect(mocks.cmcRequest).not.toHaveBeenCalled();
  });
});
