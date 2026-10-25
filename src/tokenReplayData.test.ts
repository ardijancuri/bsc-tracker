import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TokenChart } from '../shared/intelligence';
import type { Token } from './types';
import { loadTokenReplay, prepareTokenReplayData, tokenReplaySnapshot } from './tokenReplayData';

const now = Date.parse('2026-10-15T00:00:00Z'), address = '0x' + '1'.repeat(40);
const token: Token = { address, symbol: 'TEST', name: 'Test token', logoUrl: null, priceUsd: '999', marketCapUsd: '999',
  change24h: null, kolCount24h: 2, buys24h: 1, sells24h: 1, volume24hUsd: '10', lastTradeAt: null };
const candle = (offset: number, close: number) => ({ time: now / 1000 + offset, open: 1, high: Math.max(1, close), low: Math.min(1, close), close, volume: 10 });
function chart(): TokenChart {
  return { address, period: '24h', source: 'gmgn', resolution: '1m', candles: [candle(-120, 2), candle(-60, 3)], points: [],
    updatedAt: new Date(now).toISOString(), pending: false, stale: false, marketCapSupply: '1000', supplyCheckedAt: new Date(now).toISOString() };
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('token replay market history', () => {
  it('preserves node observation times and a separate frozen state quote without inventing candle endpoints', () => {
    const raw = chart(); raw.source = 'node'; raw.resolution = '5m';
    raw.points = [{ timestamp: new Date(now - 119_000).toISOString(), priceUsd: '2' },
      { timestamp: new Date(now - 91_000).toISOString(), priceUsd: '3' }];
    raw.currentQuote = { timestamp: new Date(now - 10_000).toISOString(), priceUsd: '4' };
    const data = prepareTokenReplayData(token, '24h', raw, now);
    expect(data.points.map(point => point.time)).toEqual([now - 119_000, now - 91_000, now - 10_000]);
    expect(data.points.map(point => point.marketCap)).toEqual([2000, 3000, 4000]);
    expect(data.points.at(-1)?.time).not.toBe(now);
    raw.points[0].marketCapUsd = '6000';
    expect(prepareTokenReplayData(token, '24h', raw, now).points[0].marketCap).toBe(6000);
  });
  it('uses observed opens/closes and current proven supply, independent of token metadata', () => {
    const data = prepareTokenReplayData(token, '24h', chart(), now);
    expect(data.points.map(point => point.marketCap)).toEqual([1000, 2000, 3000]);
    expect(data.points.map(point => point.time)).toEqual([now - 120_000, now - 60_000, now]);
    expect(data.partialHistory).toBe(true); expect(data.token.address).toBe(address);
    expect(tokenReplaySnapshot(data, 0)).toMatchObject({ marketCap: 1000, changePercent: 0 });
    expect(tokenReplaySnapshot(data, 1)).toMatchObject({ marketCap: 3000, changePercent: 200, peak: 3000, time: now });
    expect(tokenReplaySnapshot(data, .94)).toEqual(tokenReplaySnapshot(data, 1));
  });
  it('never uses a forming candle after the actual observation timestamp', () => {
    const raw = chart(); raw.updatedAt = new Date(now - 30_000).toISOString();
    const data = prepareTokenReplayData(token, '24h', raw, now);
    expect(data.points.at(-1)!.time).toBe(now - 30_000);
  });
  it.each([['7d', 240_000], ['30d', 540_000]] as const)('accepts the endpoint cache lifetime for %s with unchanged observation dates', (period, age) => {
    const raw = chart(); raw.period = period; raw.resolution = '1h'; raw.updatedAt = new Date(now - age).toISOString();
    raw.candles = [candle(-7200, 2), candle(-3600, 3)];
    const data = prepareTokenReplayData(token, period, raw, now);
    expect(data.points.at(-1)!.time).toBe(now - age);
  });
  it.each(['recorded', 'quote', 'unavailable', 'other-token', 'other-period', 'no-supply', 'old-supply', 'old-observation', 'future', 'invalid-resolution', 'one-point', 'invalid-candles'])(
    'rejects %s instead of making a synthetic market replay', variant => {
      const raw = chart();
      if (['recorded', 'quote', 'unavailable'].includes(variant)) raw.source = variant as TokenChart['source'];
      if (variant === 'other-token') raw.address = '0x' + '2'.repeat(40);
      if (variant === 'other-period') raw.period = '7d';
      if (variant === 'no-supply') raw.marketCapSupply = null;
      if (variant === 'old-supply') raw.supplyCheckedAt = new Date(now - 3 * 86400_000).toISOString();
      if (variant === 'old-observation') raw.updatedAt = new Date(now - 180_001).toISOString();
      if (variant === 'future') raw.updatedAt = new Date(now + 2000).toISOString();
      if (variant === 'invalid-resolution') raw.resolution = 'unknown';
      if (variant === 'one-point') raw.candles = [];
      if (variant === 'invalid-candles') raw.candles.forEach(value => { value.high = 0; });
      expect(() => prepareTokenReplayData(token, '24h', raw, now)).toThrow();
    });
  it('sorts/deduplicates real buckets and clips them to the requested window', () => {
    const raw = chart(); raw.candles = [candle(-60, 2), candle(-90000, 10), candle(-120, 2), candle(-60, 4)];
    const data = prepareTokenReplayData(token, '24h', raw, now);
    expect(data.points.map(point => point.marketCap)).toEqual([1000, 2000, 4000]);
  });
  it('holds the last observation through a gap and finishes with the actual final price', () => {
    const raw = chart(); raw.candles = [candle(-3600, 2), candle(-60, .5)];
    const data = prepareTokenReplayData(token, '24h', raw, now);
    expect(data.sparseHistory).toBe(true);
    expect(tokenReplaySnapshot(data, .5)).toMatchObject({ inGap: true, marketCap: 2000 });
    expect(tokenReplaySnapshot(data, 1)).toMatchObject({ marketCap: 500, changePercent: -50, peak: 2000 });
  });
});

describe('token replay preparation', () => {
  it('requests only the selected token chart through the server, without wallet accounting', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify(chart())));
    const data = await loadTokenReplay(token, '24h', new AbortController().signal, { now: () => now, fetcher });
    expect(data.points).toHaveLength(3);
    expect(fetcher).toHaveBeenCalledWith(`/api/tokens/${address}/chart?period=24h&priority=chart&workload=replay`, expect.objectContaining({ cache: 'no-store' }));
  });
  it('honors provider cooldowns and resumes the same period', async () => {
    vi.useFakeTimers(); vi.setSystemTime(now);
    const fetcher = vi.fn().mockResolvedValueOnce(new Response('{}', { status: 429, headers: { 'Retry-After': '3' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify(chart())));
    const onWait = vi.fn(), work = loadTokenReplay(token, '24h', new AbortController().signal, { fetcher, onWait });
    await vi.advanceTimersByTimeAsync(2999); expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); expect((await work).points).toHaveLength(3); expect(fetcher).toHaveBeenCalledTimes(2);
    expect(onWait).toHaveBeenCalledWith(now + 3000); expect(onWait).toHaveBeenLastCalledWith(0);
  });
  it('offers a paced retry when a cooldown exceeds the total preparation budget', async () => {
    const fetcher = vi.fn(async () => new Response('{}', { status: 429, headers: { 'Retry-After': '300' } }));
    await expect(loadTokenReplay(token, '24h', new AbortController().signal, { now: () => now, fetcher })).rejects.toMatchObject({ retryAfterMs: 300_000 });
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it('cancels a provider wait on close without retrying or producing a replay', async () => {
    vi.useFakeTimers(); vi.setSystemTime(now);
    const controller = new AbortController(), fetcher = vi.fn(async () => new Response('{}', { status: 503 }));
    const result = loadTokenReplay(token, '24h', controller.signal, { fetcher }).catch(error => error);
    await vi.advanceTimersByTimeAsync(0); controller.abort();
    expect(await result).toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(20_000); expect(fetcher).toHaveBeenCalledOnce();
  });
  it('does not keep retrying a token with no usable market history', async () => {
    const fetcher = vi.fn(async () => new Response('{}', { status: 404 }));
    await expect(loadTokenReplay(token, '24h', new AbortController().signal, { fetcher })).rejects.toMatchObject({ retryAfterMs: 0 });
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
