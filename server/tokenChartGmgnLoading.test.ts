import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ gmgn: vi.fn(), cmc: vi.fn(), cmcRequest: vi.fn(), gecko: vi.fn(), readFile: vi.fn(), writeFile: vi.fn(), mkdir: vi.fn(), rename: vi.fn() }));
vi.mock('node:fs/promises', () => ({ readFile: mocks.readFile, writeFile: mocks.writeFile, mkdir: mocks.mkdir, rename: mocks.rename }));
vi.mock('./gmgnApi.js', async importOriginal => ({ ...await importOriginal<typeof import('./gmgnApi.js')>(), gmgnRequest: mocks.gmgn }));
vi.mock('./cmcChart.js', () => ({ fetchCmcMarketCandles: mocks.cmc, cmcRequest: mocks.cmcRequest }));
vi.mock('./geckoApi.js', async importOriginal => ({ ...await importOriginal<typeof import('./geckoApi.js')>(), geckoFetch: mocks.gecko }));
const address = '0x' + '1'.repeat(40), now = 2_000_000_000_000;
const row = { time: now / 1000 - 300, open: '1', high: '2', low: '.5', close: '1.5', volume: '25', amount: '999999' };
const retained = { address, period: '24h', resolution: '5m', source: 'gmgn', volumeCurrency: 'usd', updatedAt: new Date(now - 300_000).toISOString(), pending: false, stale: false,
  candles: [{ time: row.time, open: 1, high: 2, low: .5, close: 1.5, volume: 25 }], points: [] };
beforeEach(() => {
  vi.resetModules(); vi.resetAllMocks(); vi.useFakeTimers(); vi.setSystemTime(now); vi.stubEnv('GMGN_API_KEY', 'private-test-key');
  vi.stubEnv('GMGN_CHART_API_KEY', '');
  mocks.readFile.mockRejectedValue(new Error('No disk cache'));
  mocks.gmgn.mockResolvedValue({ code: 0, data: { list: [row] } });
  mocks.cmc.mockResolvedValue(null);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

describe('GMGN chart caching and request coalescing', () => {
  it('lets replay recovery join a stale background refresh and opt into an independent provider without another GMGN request', async () => {
    const saved = { ...retained, period: '1m', resolution: '1m' };
    mocks.readFile.mockResolvedValue(JSON.stringify(saved));
    const { currentMarketChart } = await import('./tokenChart.js');
    const { MarketProviderDeferred } = await import('./geckoApi.js');
    let reject!: (problem: unknown) => void;
    mocks.gmgn.mockImplementation(() => new Promise((_, no) => { reject = no; }));
    const recovered = { ...saved, source: 'coinmarketcap', updatedAt: new Date(now).toISOString(),
      candles: [{ ...saved.candles[0], time: Math.floor(now / 60_000) * 60 - 60, close: 1.7 }] };
    mocks.cmc.mockResolvedValue(recovered);
    const background = await currentMarketChart(address, '1m', 'prefetch');
    expect(background.chart?.stale).toBe(true);
    const joined = currentMarketChart(address, '1m', 'chart', { allowProviderFallback: true, waitForRefresh: true });
    await vi.advanceTimersByTimeAsync(0);
    reject(new MarketProviderDeferred('rate_limited', 120_000));
    expect((await joined).chart).toMatchObject({ source: 'coinmarketcap', stale: false, candles: recovered.candles });
    expect(mocks.gmgn).toHaveBeenCalledOnce(); expect(mocks.cmc).toHaveBeenCalledOnce(); expect(mocks.gecko).not.toHaveBeenCalled();
  });
  it('recovers independently after an ordinary cached GMGN refresh already entered cooldown without retrying that key', async () => {
    const saved = { ...retained, period: '1m', resolution: '1m' };
    mocks.readFile.mockResolvedValue(JSON.stringify(saved));
    const { currentMarketChart } = await import('./tokenChart.js');
    const { MarketProviderDeferred } = await import('./geckoApi.js');
    mocks.gmgn.mockRejectedValue(new MarketProviderDeferred('rate_limited', 120_000));
    await currentMarketChart(address, '1m', 'prefetch'); await vi.advanceTimersByTimeAsync(0);
    expect(mocks.gmgn).toHaveBeenCalledOnce(); expect(mocks.cmc).not.toHaveBeenCalled();
    const recovered = { ...saved, source: 'coinmarketcap', updatedAt: new Date(now).toISOString() };
    mocks.cmc.mockResolvedValue(recovered);
    expect((await currentMarketChart(address, '1m', 'chart', { allowProviderFallback: true, waitForRefresh: true })).chart?.source).toBe('coinmarketcap');
    expect(mocks.gmgn).toHaveBeenCalledOnce(); expect(mocks.cmc).toHaveBeenCalledOnce();
  });
  it('honors independent cooldowns without retrying GMGN or losing retained bars', async () => {
    const saved = { ...retained, period: '1m', resolution: '1m' };
    mocks.readFile.mockResolvedValue(JSON.stringify(saved));
    const { currentMarketChart } = await import('./tokenChart.js');
    const { MarketProviderDeferred } = await import('./geckoApi.js');
    mocks.gmgn.mockRejectedValue(new MarketProviderDeferred('rate_limited', 120_000));
    mocks.cmc.mockRejectedValue(new MarketProviderDeferred('rate_limited', 60_000));
    mocks.gecko.mockRejectedValue(new MarketProviderDeferred('rate_limited', 30_000));
    const first = await currentMarketChart(address, '1m', 'chart', { allowProviderFallback: true, waitForRefresh: true });
    expect(first).toMatchObject({ chart: { source: 'gmgn', stale: true }, loadStatus: 'rate_limited', retryAfterMs: 30_000 });
    await vi.advanceTimersByTimeAsync(10_000);
    const next = await currentMarketChart(address, '1m', 'chart', { allowProviderFallback: true, waitForRefresh: true });
    expect(next).toMatchObject({ chart: { candles: saved.candles }, retryAfterMs: 20_000 });
    expect(mocks.gmgn).toHaveBeenCalledOnce(); expect(mocks.cmc).toHaveBeenCalledOnce(); expect(mocks.gecko).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(20_001);
    mocks.gecko.mockImplementation(async (url: URL) => ({ ok: true, json: async () => url.pathname.endsWith('/pools') ? {
      data: [{ attributes: { address: '0x' + '2'.repeat(40) }, relationships: { base_token: { data: { id: `bsc_${address}` } } } }],
    } : { data: { attributes: { ohlcv_list: [[Math.floor(Date.now() / 60_000) * 60 - 60, 1, 2, .5, 1.5, 10]] } } } }));
    expect((await currentMarketChart(address, '1m', 'chart', { allowProviderFallback: true, waitForRefresh: true })).chart?.source).toBe('geckoterminal');
    expect(mocks.gmgn).toHaveBeenCalledOnce(); expect(mocks.cmc).toHaveBeenCalledTimes(2);
  });
  it('recovers fresh-but-lagging GMGN observations independently instead of re-requesting the same stale head', async () => {
    const saved = { ...retained, period: '1m', resolution: '1m', updatedAt: new Date(now - 1000).toISOString(),
      candles: [{ ...retained.candles[0], time: Math.floor(now / 60_000) * 60 - 1200 }] };
    mocks.readFile.mockResolvedValue(JSON.stringify(saved));
    const recovered = { ...saved, source: 'coinmarketcap', updatedAt: new Date(now).toISOString(),
      candles: [{ ...saved.candles[0], time: Math.floor(now / 60_000) * 60 - 60 }] };
    mocks.cmc.mockResolvedValue(recovered);
    const { currentMarketChart } = await import('./tokenChart.js');
    expect((await currentMarketChart(address, '1m', 'chart', { allowProviderFallback: true, waitForRefresh: true })).chart?.source).toBe('coinmarketcap');
    expect(mocks.gmgn).not.toHaveBeenCalled(); expect(mocks.cmc).toHaveBeenCalledOnce();
  });
  it.each(['503', 'network', 'empty'] as const)('retries an independent %s failure after thirty seconds while GMGN stays in cooldown', async failure => {
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const saved = { ...retained, period: '1m', resolution: '1m' };
      mocks.readFile.mockResolvedValue(JSON.stringify(saved));
      const { currentMarketChart } = await import('./tokenChart.js');
      const { MarketProviderDeferred } = await import('./geckoApi.js');
      mocks.gmgn.mockRejectedValue(new MarketProviderDeferred('rate_limited', 60_000));
      if (failure === 'empty') {
        mocks.cmc.mockResolvedValue(null);
        mocks.gecko.mockResolvedValue({ ok: true, json: async () => ({ data: [] }) });
      } else {
        mocks.cmc.mockRejectedValue(new Error(failure === '503' ? 'CoinMarketCap chart request failed: HTTP 503' : 'Connection failed'));
        if (failure === '503') mocks.gecko.mockResolvedValue({ ok: false, status: 503 });
        else mocks.gecko.mockRejectedValue(new Error('Connection failed'));
      }
      const options = { allowProviderFallback: true, waitForRefresh: true };
      expect(await currentMarketChart(address, '1m', 'chart', options)).toMatchObject({
        chart: { source: 'gmgn', stale: true }, pending: false, loadStatus: 'provider_error', retryAfterMs: 30_000 });
      await vi.advanceTimersByTimeAsync(29_999);
      expect((await currentMarketChart(address, '1m', 'chart', options)).retryAfterMs).toBe(1000);
      expect(mocks.gmgn).toHaveBeenCalledOnce(); expect(mocks.cmc).toHaveBeenCalledOnce(); expect(mocks.gecko).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(2);
      const recovered = { ...saved, source: 'coinmarketcap', updatedAt: new Date(Date.now()).toISOString(),
        candles: [{ ...saved.candles[0], time: Math.floor(Date.now() / 60_000) * 60 - 60 }] };
      mocks.cmc.mockResolvedValue(recovered);
      expect((await currentMarketChart(address, '1m', 'chart', options)).chart?.source).toBe('coinmarketcap');
      expect(mocks.gmgn).toHaveBeenCalledOnce(); expect(mocks.cmc).toHaveBeenCalledTimes(2); expect(mocks.gecko).toHaveBeenCalledOnce();
    } finally { warnings.mockRestore(); }
  });
  it('refreshes an older background chart for current valuation without raising its provider priority', async () => {
    const saved = { ...retained, period: '1m', resolution: '1m', updatedAt: new Date(now - 120_000).toISOString() };
    mocks.readFile.mockResolvedValue(JSON.stringify(saved));
    const { currentMarketChart } = await import('./tokenChart.js');
    expect((await currentMarketChart(address, '1m', 'prefetch')).chart?.stale).toBe(false);
    expect(mocks.gmgn).not.toHaveBeenCalled();
    let finish!: (value: unknown) => void;
    mocks.gmgn.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    expect((await currentMarketChart(address, '1m', 'prefetch', { maxAgeMs: 30_000 })).chart?.stale).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.gmgn).toHaveBeenCalledOnce(); expect(mocks.gmgn.mock.calls[0][1].priority()).toBe('prefetch');
    finish({ code: 0, data: { list: [row] } }); await vi.advanceTimersByTimeAsync(0);
    expect((await currentMarketChart(address, '1m', 'prefetch', { maxAgeMs: 30_000 })).chart?.stale).toBe(false);
  });
  it('prefers the dedicated chart key while retaining the legacy key as a fallback', async () => {
    vi.stubEnv('GMGN_CHART_API_KEY', ' chart-only-test-key ');
    vi.stubEnv('GMGN_ACCOUNTING_API_KEY', 'accounting-only-test-key');
    const { currentMarketChart } = await import('./tokenChart.js');
    expect((await currentMarketChart(address, '1m')).chart?.source).toBe('gmgn');
    expect(mocks.gmgn.mock.calls[0][1].apiKey).toBe('chart-only-test-key');
    expect(mocks.gmgn.mock.calls[0][1].workload).toBe('market');
    expect(JSON.stringify(mocks.writeFile.mock.calls)).not.toContain('chart-only-test-key');
    expect(JSON.stringify(mocks.writeFile.mock.calls)).not.toContain('private-test-key');
  });
  it('promotes an existing background candle request when selected valuation joins without restarting it', async () => {
    const { currentMarketChart } = await import('./tokenChart.js');
    let finish!: (value: unknown) => void;
    mocks.gmgn.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const background = currentMarketChart(address, '1m', 'prefetch');
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.gmgn.mock.calls[0][1].foreground()).toBe(false);
    let selected = false;
    const joined = currentMarketChart(address, '1m', 'chart', { foreground: () => selected });
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.gmgn.mock.calls[0][1].foreground()).toBe(false);
    selected = true;
    expect(mocks.gmgn.mock.calls[0][1].foreground()).toBe(true);
    expect(mocks.gmgn).toHaveBeenCalledOnce();
    finish({ code: 0, data: { list: [row] } });
    expect((await joined).chart?.source).toBe('gmgn');
    expect((await background).chart?.source).toBe('gmgn');
  });
  it('coalesces watchlist/page jobs, persists normalized genuine history, and reuses cache without another account request', async () => {
    const { currentMarketChart } = await import('./tokenChart.js');
    const [watchlist, selected] = await Promise.all([currentMarketChart(address, '24h'), currentMarketChart(address, '5m')]);
    expect(watchlist.chart?.source).toBe('gmgn'); expect(selected.chart?.candles[0].volume).toBe(25);
    expect(mocks.gmgn).toHaveBeenCalledOnce(); expect(mocks.gecko).not.toHaveBeenCalled();
    expect(mocks.cmc).not.toHaveBeenCalled();
    expect((await currentMarketChart(address, '5m')).chart?.source).toBe('gmgn'); expect(mocks.gmgn).toHaveBeenCalledOnce();
    const stored = mocks.writeFile.mock.calls[0][1];
    expect(JSON.parse(stored)).toMatchObject({ source: 'gmgn', volumeCurrency: 'usd', candles: [{ volume: 25 }] });
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
  it('preserves all legacy GMGN prices while marking unverified cached volume as unknown', async () => {
    const legacy = { ...retained, volumeCurrency: undefined, candles: [{ ...retained.candles[0], volume: 999999 }] };
    mocks.readFile.mockResolvedValue(JSON.stringify(legacy));
    const { currentMarketChart } = await import('./tokenChart.js');
    const { MarketProviderDeferred } = await import('./geckoApi.js');
    mocks.gmgn.mockRejectedValue(new MarketProviderDeferred('rate_limited', 120_000));
    const first = await currentMarketChart(address, '5m');
    expect(first.chart).toMatchObject({ source: 'gmgn', volumeCurrency: 'unknown', candles: legacy.candles, stale: true });
    await vi.advanceTimersByTimeAsync(0);
    const reused = await currentMarketChart(address, '5m');
    expect(reused.chart?.volumeCurrency).toBe('unknown');
    expect(reused.chart?.candles).toEqual(legacy.candles);
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });
  it.each(['prefetch', 'sparkline'] as const)('promotes simultaneous %s/main minute requests after disk reads and retains one GMGN job', async priority => {
    const { currentMarketChart } = await import('./tokenChart.js');
    let finish!: (value: unknown) => void;
    mocks.gmgn.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const background = currentMarketChart(address, '1m', priority);
    const selected = currentMarketChart(address, '1m', 'chart');
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.gmgn).toHaveBeenCalledOnce();
    expect(mocks.gmgn.mock.calls[0][1].priority()).toBe('chart');
    finish({ code: 0, data: { list: [row] } });
    expect((await selected).chart?.resolution).toBe('1m');
    expect((await background).chart?.resolution).toBe('1m');
  });
  it('keeps a minute prefetch in background priority until a main chart joins it', async () => {
    const { currentMarketChart } = await import('./tokenChart.js');
    let finish!: (value: unknown) => void;
    mocks.gmgn.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const background = currentMarketChart(address, '1m', 'prefetch');
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.gmgn.mock.calls[0][1].priority()).toBe('prefetch');
    await vi.advanceTimersByTimeAsync(1000);
    expect(await background).toMatchObject({ chart: null, pending: true });
    const selected = currentMarketChart(address, '1m', 'chart');
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.gmgn.mock.calls[0][1].priority()).toBe('chart');
    finish({ code: 0, data: { list: [row] } });
    expect((await selected).chart?.source).toBe('gmgn');
    expect(mocks.gmgn).toHaveBeenCalledOnce();
  });
  it('retains cached fallback candles while GMGN and that public provider are both cooling down', async () => {
    const fallback = { ...retained, source: 'coinmarketcap' };
    mocks.readFile.mockResolvedValue(JSON.stringify(fallback));
    const { currentMarketChart } = await import('./tokenChart.js');
    const { MarketProviderDeferred } = await import('./geckoApi.js');
    mocks.gmgn.mockRejectedValue(new MarketProviderDeferred('rate_limited', 120_000));
    mocks.cmc.mockRejectedValue(new MarketProviderDeferred('rate_limited', 90_000));
    expect((await currentMarketChart(address, '5m')).chart).toMatchObject({ source: 'coinmarketcap', stale: true, candles: retained.candles });
    await vi.advanceTimersByTimeAsync(10_000);
    const next = await currentMarketChart(address, '5m');
    expect(next).toMatchObject({ chart: { source: 'coinmarketcap', candles: retained.candles }, pending: false, loadStatus: 'rate_limited', retryAfterMs: 80_000 });
    expect(mocks.gmgn).toHaveBeenCalledOnce(); expect(mocks.cmc).toHaveBeenCalledOnce();
    expect(mocks.gecko).not.toHaveBeenCalled(); expect(mocks.writeFile).not.toHaveBeenCalled();
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
