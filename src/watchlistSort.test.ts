import { describe, expect, it } from 'vitest';
import type { WatchEntry } from '../shared/intelligence';
import { compareWatchTokens, type WatchSortKey } from './watchlistSort';

const points = (end: string) => [
  { timestamp: '2026-10-09T10:00:00Z', priceUsd: '10' },
  { timestamp: '2026-10-09T11:00:00Z', priceUsd: end },
];
const low: WatchEntry = { kind: 'token', address: '0x111', name: 'Zebra', symbol: 'Alpha', change1h: '-5', periodChange: '-10', marketCapUsd: '9000', periodVolumeUsd: '800', periodKolCount: 0, lastTradeAt: '2026-10-09T10:00:00Z', priceHistory: points('5') };
const high: WatchEntry = { kind: 'token', address: '0x222', name: 'Apple', symbol: 'Beta', change1h: '2', periodChange: '10', marketCapUsd: '10000', periodVolumeUsd: '1200', periodKolCount: 10, lastTradeAt: '2026-10-09T11:00:00Z', priceHistory: points('15') };
const keys: WatchSortKey[] = ['name', 'address', 'change1h', 'periodChange', 'marketCapUsd', 'periodVolumeUsd', 'periodKolCount', 'lastTradeAt', 'chart'];

describe('watchlist ordering', () => {
  it.each(keys)('orders %s in both directions using the displayed data', key => {
    expect([high, low].sort((a, b) => compareWatchTokens(a, b, key, true))).toEqual([low, high]);
    expect([low, high].sort((a, b) => compareWatchTokens(a, b, key, false))).toEqual([high, low]);
  });
  it.each(keys.filter(key => key !== 'name' && key !== 'address'))('keeps missing %s after real values in either direction', key => {
    const missing: WatchEntry = { kind: 'token', address: '0x000', name: null, change1h: '', periodChange: 'invalid', marketCapUsd: null, lastTradeAt: 'invalid', priceHistory: points('invalid') };
    for (const ascending of [true, false]) {
      const result = [missing, high, low].sort((a, b) => compareWatchTokens(a, b, key, ascending));
      expect(result.at(-1)).toEqual(missing);
      expect(result[0]).toEqual(ascending ? low : high);
    }
  });
  it('orders chart trends by the plotted first and last prices rather than the period percentage', () => {
    expect(compareWatchTokens({ ...low, periodChange: '500' }, { ...high, periodChange: '-500' }, 'chart', true)).toBeLessThan(0);
  });
});
