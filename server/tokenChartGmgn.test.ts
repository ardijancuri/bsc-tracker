import { describe, expect, it, vi } from 'vitest';
import { fetchGmgnMarketCandles, fetchPreferredMarketCandles, parseGmgnCandles } from './tokenChart.js';
import { MarketProviderDeferred } from './geckoApi.js';
const address = '0x' + '1'.repeat(40), pool = '0x' + '2'.repeat(40), now = 2_000_000_000_000;
const bar = (time = now / 1000 - 300) => ({ time, open: '1', high: '2', low: '.5', close: '1.5', amount: '1214', volume: '5379110' });

describe('GMGN token market history', () => {
  it('normalizes seconds/milliseconds, USD turnover, duplicate timestamps and genuine OHLC only', () => {
    const until = now / 1000, since = until - 1000;
    expect(parseGmgnCandles([
      bar(until - 300), { ...bar(until - 600), time: (until - 600) * 1000 }, { ...bar(until - 300), close: '1.75' },
      bar(until + 1), bar(since - 1), { ...bar(until - 200), amount: undefined },
      { ...bar(until - 100), low: '1.2' }, { ...bar(until - 150), high: '1.1' },
      { ...bar(until - 400), open: '0' }, { ...bar(until - 500), close: 'NaN' }, { ...bar(until - 250), amount: '-1' },
    ], since, until)).toEqual([
      { time: until - 600, open: 1, high: 2, low: .5, close: 1.5, volume: 1214 },
      { time: until - 300, open: 1, high: 2, low: .5, close: 1.75, volume: 1214 },
    ]);
    expect(parseGmgnCandles(undefined, since, until)).toEqual([]);
  });
  it.each(['5m', '1h', '4h', '1d'] as const)('requests direct BSC %s history with official auth and millisecond range', async period => {
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
    expect(chart).toMatchObject({ source: 'gmgn', resolution: period, stale: false, pending: false });
    expect(chart?.points[0].priceUsd).toBe('1.5'); expect(chart?.candles[0].volume).toBe(1214);
    expect(JSON.stringify(chart)).not.toContain('private-test-key'); expect(chart?.poolAddress).toBeUndefined();
  });
  it('uses one primary request and does not call Gecko after valid GMGN history', async () => {
    const geckoRequest = vi.fn(), cmcRequest = vi.fn(async () => ({ status: { error_code: 0 }, data: [] }));
    const chart = await fetchPreferredMarketCandles(address, '5m', undefined, { gmgnKey: 'key', now,
      gmgnRequest: async () => ({ code: 0, data: [bar()] }), cmcRequest, geckoRequest });
    expect(chart?.source).toBe('gmgn'); expect(geckoRequest).not.toHaveBeenCalled(); expect(cmcRequest).not.toHaveBeenCalled();
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
  it('does not manufacture bars for missing history or accept an error envelope as successful data', async () => {
    expect(await fetchGmgnMarketCandles(address, '5m', 'key', async () => ({ code: 0, data: { list: [] } }), now)).toBeNull();
    await expect(fetchGmgnMarketCandles(address, '5m', 'key', async () => ({ code: 429, data: [bar()] }), now)).rejects.toThrow('invalid chart response');
    const request = vi.fn();
    await expect(fetchGmgnMarketCandles('../token', '5m', 'key', request, now)).rejects.toThrow('Invalid chart address');
    expect(request).not.toHaveBeenCalled();
  });
});
