import { describe, expect, it, vi } from 'vitest';
import { fetchGmgnMarketCandles, fetchPreferredMarketCandles, parseGmgnCandles } from './tokenChart.js';
import { MarketProviderDeferred } from './geckoApi.js';
const address = '0x' + '1'.repeat(40), pool = '0x' + '2'.repeat(40), now = 2_000_000_000_000;
const bar = (time = now / 1000 - 300) => ({ time, open: '1', high: '2', low: '.5', close: '1.5', volume: '1214', amount: '5379110' });

describe('GMGN token market history', () => {
  it('normalizes seconds/milliseconds, USD turnover, duplicate timestamps and genuine OHLC only', () => {
    const until = now / 1000, since = until - 1000;
    expect(parseGmgnCandles([
      bar(until - 300), { ...bar(until - 600), time: (until - 600) * 1000 }, { ...bar(until - 300), close: '1.75' },
      bar(until + 1), bar(since - 1), { ...bar(until - 200), volume: undefined },
      { ...bar(until - 100), low: '1.2' }, { ...bar(until - 150), high: '1.1' },
      { ...bar(until - 400), open: '0' }, { ...bar(until - 500), close: 'NaN' }, { ...bar(until - 250), volume: '-1' },
    ], since, until)).toEqual([
      { time: until - 600, open: 1, high: 2, low: .5, close: 1.5, volume: 1214 },
      { time: until - 300, open: 1, high: 2, low: .5, close: 1.75, volume: 1214 },
    ]);
    expect(parseGmgnCandles(undefined, since, until)).toEqual([]);
  });
  it.each(['1m', '5m', '1h', '4h', '1d'] as const)('requests direct BSC %s history with official auth and millisecond range', async period => {
    const request = vi.fn(async (url: URL, _signal: AbortSignal, headers: Record<string, string>) => {
      expect(url.origin + url.pathname).toBe('https://openapi.gmgn.ai/v1/market/token_kline');
      expect(url.searchParams.get('chain')).toBe('bsc'); expect(url.searchParams.get('address')).toBe(address);
      expect(url.searchParams.get('resolution')).toBe(period); expect(url.searchParams.get('to')).toBe(String(now));
      expect(Number(url.searchParams.get('from'))).toBeGreaterThan(1e12);
      expect(url.searchParams.get('timestamp')).toBe(String(now / 1000)); expect(url.searchParams.get('client_id')).toBeTruthy();
      expect(headers).toEqual({ 'X-APIKEY': 'private-test-key' });
      expect(url.href).not.toContain('private-test-key');
      return { code: 0, data: { list: [bar()] } };
    });
    const chart = await fetchGmgnMarketCandles(address, period, ' private-test-key ', request, now);
    expect(chart).toMatchObject({ source: 'gmgn', resolution: period, volumeCurrency: 'usd', stale: false, pending: false });
    expect(chart?.points[0].priceUsd).toBe('1.5'); expect(chart?.candles[0].volume).toBe(1214);
    expect(JSON.stringify(chart)).not.toContain('private-test-key'); expect(chart?.poolAddress).toBeUndefined();
  });
  it('reads USD turnover from the current live-shaped BSC payload without labeling token amount as dollars', async () => {
    const liveBar = { time: now - 60_000, open: '0.001213', high: '0.00124', low: '0.00120', close: '0.001215181',
      volume: '1448.23321694', amount: '1184122.58585189' };
    const chart = await fetchGmgnMarketCandles(address, '1m', 'test-key', async () => ({ code: 0, data: { list: [liveBar] } }), now);
    expect(chart).toMatchObject({ volumeCurrency: 'usd', candles: [{ open: 0.001213, high: 0.00124, low: 0.0012, close: 0.001215181, volume: 1448.23321694 }] });
    const impliedPrice = Number(liveBar.volume) / Number(liveBar.amount);
    expect(impliedPrice).toBeGreaterThanOrEqual(Number(liveBar.low));
    expect(impliedPrice).toBeLessThanOrEqual(Number(liveBar.high));
    expect(chart?.candles[0].volume).not.toBe(Number(liveBar.amount));
  });
  it('uses one primary request and does not call Gecko after valid GMGN history', async () => {
    const geckoRequest = vi.fn(), cmcRequest = vi.fn(async () => ({ status: { error_code: 0 }, data: [] }));
    const chart = await fetchPreferredMarketCandles(address, '5m', undefined, { gmgnKey: 'key', now,
      gmgnRequest: async () => ({ code: 0, data: [bar()] }), cmcRequest, geckoRequest });
    expect(chart?.source).toBe('gmgn'); expect(geckoRequest).not.toHaveBeenCalled(); expect(cmcRequest).not.toHaveBeenCalled();
  });
  it('requests the newest retained minute history instead of truncating recent bars from a longer ascending response', async () => {
    const chart = await fetchGmgnMarketCandles(address, '1m', 'key', async url => {
      const from = Number(url.searchParams.get('from')) / 1000;
      const to = Number(url.searchParams.get('to')) / 1000;
      expect(to - from).toBe(999 * 60);
      return { code: 0, data: { list: Array.from({ length: 1000 }, (_, index) => bar(from + index * 60)) } };
    }, now);
    expect(chart).toMatchObject({ resolution: '1m', partialHistory: true });
    expect(chart?.candles).toHaveLength(1000);
    expect(chart?.candles.at(-1)?.time).toBe(now / 1000);
  });
  it('keeps stale cached history during a GMGN cooldown instead of spraying fallback calls', async () => {
    const saved = (await fetchGmgnMarketCandles(address, '5m', 'key', async () => ({ code: 0, data: [bar()] }), now))!;
    const geckoRequest = vi.fn(), cmcRequest = vi.fn(async () => ({ status: { error_code: 0 }, data: [] }));
    await expect(fetchPreferredMarketCandles(address, '5m', undefined, { gmgnKey: 'key', saved, cmcRequest, geckoRequest, now,
      gmgnRequest: async () => { throw new MarketProviderDeferred('rate_limited', 90_000); } })).rejects.toMatchObject({ retryAfterMs: 90_000 });
    expect(geckoRequest).not.toHaveBeenCalled(); expect(cmcRequest).not.toHaveBeenCalled();
  });
  it('falls back once to real public history when the configured provider is unavailable and there is no cache', async () => {
    const geckoRequest = vi.fn(async () => ({ data: { attributes: { ohlcv_list: [[now / 1000 - 300, 1, 2, .5, 1.5, 250]] } } }));
    const gmgnRequest = vi.fn(async () => { throw new Error('Unavailable'); });
    const cmcRequest = vi.fn(async () => ({ status: { error_code: 0 }, data: [] }));
    const chart = await fetchPreferredMarketCandles(address, '5m', pool, { gmgnKey: 'key', gmgnRequest, cmcRequest, geckoRequest, now });
    expect(chart?.source).toBe('geckoterminal'); expect(gmgnRequest).toHaveBeenCalledOnce(); expect(cmcRequest).toHaveBeenCalledOnce(); expect(geckoRequest).toHaveBeenCalledOnce();
  });
  it('refreshes a retained CMC fallback after GMGN fails instead of treating all cached history as GMGN history', async () => {
    const saved = { ...(await fetchGmgnMarketCandles(address, '5m', 'key', async () => ({ code: 0, data: [bar()] }), now))!, source: 'coinmarketcap' as const };
    const cmcRequest = vi.fn(async () => ({ status: { error_code: 0 }, data: [[1, 3, .5, 2.5, 250, Math.floor(now / 300_000) * 300_000]] }));
    const geckoRequest = vi.fn();
    const chart = await fetchPreferredMarketCandles(address, '5m', pool, { gmgnKey: 'key', saved, cmcRequest, geckoRequest, now,
      gmgnRequest: async () => { throw new MarketProviderDeferred('rate_limited', 90_000); } });
    expect(chart).toMatchObject({ source: 'coinmarketcap', candles: [{ close: 2.5 }] });
    expect(cmcRequest).toHaveBeenCalledOnce(); expect(geckoRequest).not.toHaveBeenCalled();
  });
  it('refreshes real Gecko history when that is the retained provider and both preferred providers are unavailable', async () => {
    const saved = { ...(await fetchGmgnMarketCandles(address, '5m', 'key', async () => ({ code: 0, data: [bar()] }), now))!, source: 'geckoterminal' as const, poolAddress: pool };
    const geckoRequest = vi.fn(async () => ({ data: { attributes: { ohlcv_list: [[now / 1000 - 300, 1, 3, .5, 2.5, 250]] } } }));
    const chart = await fetchPreferredMarketCandles(address, '5m', pool, { gmgnKey: 'key', saved, geckoRequest, now,
      gmgnRequest: async () => { throw new Error('Unavailable'); },
      cmcRequest: async () => { throw new MarketProviderDeferred('rate_limited', 90_000); } });
    expect(chart).toMatchObject({ source: 'geckoterminal', candles: [{ close: 2.5 }] });
    expect(geckoRequest).toHaveBeenCalledOnce();
  });
  it('does not report no history when GMGN failed and the public fallbacks returned empty responses', async () => {
    const geckoRequest = vi.fn(async () => ({ data: { attributes: { ohlcv_list: [] } } }));
    await expect(fetchPreferredMarketCandles(address, '5m', pool, { gmgnKey: 'key', now, geckoRequest,
      cmcRequest: async () => ({ status: { error_code: 0 }, data: [] }),
      gmgnRequest: async () => { throw new MarketProviderDeferred('rate_limited', 90_000); } }))
      .rejects.toMatchObject({ reason: 'rate_limited', retryAfterMs: 90_000 });
  });
  it('does not manufacture bars for missing history or accept an error envelope as successful data', async () => {
    expect(await fetchGmgnMarketCandles(address, '5m', 'key', async () => ({ code: 0, data: { list: [] } }), now)).toBeNull();
    await expect(fetchGmgnMarketCandles(address, '5m', 'key', async () => ({ code: 429, data: [bar()] }), now)).rejects.toThrow('invalid chart response');
    const request = vi.fn();
    await expect(fetchGmgnMarketCandles('../token', '5m', 'key', request, now)).rejects.toThrow('Invalid chart address');
    expect(request).not.toHaveBeenCalled();
  });
});
