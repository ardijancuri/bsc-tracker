import { describe, expect, it } from 'vitest';
import { fetchMarketCandles, parseCandles, selectChartPool, selectChartPools } from './tokenChart.js';

const address = '0x13920fe6467e9e3c852b8d365a036c995f0f7777';
const pool = '0xfd55be774ea18067bd06a6aed49fb1cc4ad966e9';
const other = '0xbaaf1d8434c42f2bea01a997e849ba9254d09905';
const poolRow = (address: string, token: string, liquidity: number) => ({ attributes: { address, reserve_in_usd: liquidity }, relationships: { quote_token: { data: { id: `bsc_${token}` } } } });

describe('market chart data', () => {
  it('sorts candles chronologically and discards invalid, future, out-of-window and impossible OHLC values', () => {
    expect(parseCandles([
      [200, 2, 4, 1, 3, 50], [100, 1, 2, .5, 1.5, 20],
      [50, 1, 2, .5, 1.5, 1], [301, 1, 2, .5, 1.5, 1],
      [150, 1, 2, 1.2, 1.5, 1], [160, 1, 1.1, .5, 1.5, 1],
      [170, 0, 2, 0, 1, 1], [180, 1, 2, .5, 1.5, -1],
      [190, null, 2, .5, 1.5, 1], [195, 1, 2, .5, 'NaN', 1],
    ], 100, 300)).toEqual([
      { time: 100, open: 1, high: 2, low: .5, close: 1.5, volume: 20 },
      { time: 200, open: 2, high: 4, low: 1, close: 3, volume: 50 },
    ]);
  });
  it('deduplicates timestamps for chart engines that require strictly increasing time', () => {
    expect(parseCandles([[100, 1, 2, .5, 1, 1], [100, 1, 2, .5, 1.5, 2]], 0, 200)).toHaveLength(1);
    expect(parseCandles(undefined, 0, 200)).toEqual([]);
  });
  it('selects a liquid pool that actually contains the requested token, including quote-side tokens', () => {
    expect(selectChartPool({ data: [poolRow(other, address, 100), poolRow(pool, address, 1000), poolRow('0x' + '1'.repeat(40), '0x' + '2'.repeat(40), 999999)] }, address)).toBe(pool);
    expect(selectChartPool({ data: [poolRow(other, '0x' + '2'.repeat(40), 100)] }, address)).toBeNull();
  });
  it('requests USD candles for the token contract instead of accidentally charting the paired asset', async () => {
    const urls: URL[] = [];
    const now = 2000000000;
    const result = await fetchMarketCandles(address, '24h', undefined, async url => {
      urls.push(url);
      return urls.length === 1 ? { data: [poolRow(pool, address, 100)] } : { data: { attributes: { ohlcv_list: [[now - 300, 1, 2, .5, 1.5, 250]] } } };
    }, now * 1000);
    expect(urls[1].searchParams.get('token')).toBe(address);
    expect(urls[1].searchParams.get('currency')).toBe('usd');
    expect(urls[1].searchParams.get('aggregate')).toBe('5');
    expect(result?.candles[0].volume).toBe(250);
    expect(result?.source).toBe('geckoterminal');
  });
  it('uses enough hourly candles for a month, and does not fabricate history when providers have none', async () => {
    const urls: URL[] = [];
    const result = await fetchMarketCandles(address, '30d', pool, async url => { urls.push(url); return { data: { attributes: { ohlcv_list: [] } } }; });
    expect(urls[0].pathname).toContain('/ohlcv/hour');
    expect(urls[0].searchParams.get('limit')).toBe('1000');
    expect(result).toBeNull();
  });
  it('accepts v4 pool IDs while keeping token contracts restricted to 20 bytes', async () => {
    const v4Pool = '0x' + 'a'.repeat(64);
    expect(selectChartPools({ data: [poolRow(v4Pool, address, 1000), poolRow(pool, address, 100)] }, address)).toEqual([v4Pool, pool]);
    const now = 2000000000;
    const result = await fetchMarketCandles(address, '24h', v4Pool, async url => {
      expect(url.pathname).toContain(v4Pool);
      return { data: { attributes: { ohlcv_list: [[now - 300, 1, 2, .5, 1.5, 20]] } } };
    }, now * 1000);
    expect(result?.poolAddress).toBe(v4Pool);
    await expect(fetchMarketCandles(v4Pool, '24h', pool)).rejects.toThrow('Invalid chart address');
  });
  it('tries another verified pool when the most liquid pool has no candles', async () => {
    const now = 2000000000;
    const urls: URL[] = [];
    const result = await fetchMarketCandles(address, '24h', undefined, async url => {
      urls.push(url);
      if (url.pathname.endsWith('/pools')) return { data: [poolRow(pool, address, 1000), poolRow(other, address, 100)] };
      return { data: { attributes: { ohlcv_list: url.pathname.includes(other) ? [[now - 300, 1, 2, .5, 1.5, 20]] : [] } } };
    }, now * 1000);
    expect(result?.poolAddress).toBe(other);
    expect(urls).toHaveLength(3);
  });
  it('does not multiply upstream requests after a rate limit', async () => {
    const urls: URL[] = [];
    await expect(fetchMarketCandles(address, '24h', undefined, async url => {
      urls.push(url);
      if (url.pathname.endsWith('/pools')) return { data: [poolRow(pool, address, 1000), poolRow(other, address, 100)] };
      throw new Error('Market chart request failed: 429');
    })).rejects.toThrow('429');
    expect(urls).toHaveLength(2);
  });
});
