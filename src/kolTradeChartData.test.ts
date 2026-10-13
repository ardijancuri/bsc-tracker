import { describe, expect, it } from 'vitest';
import { kolTradeMarkers, tradeVisibleRange } from './kolTradeChartData';
import type { MarketCandle } from '../shared/intelligence';

const start = Date.parse('2026-10-08T00:00:00Z') / 1000;
const candle = (offset: number): MarketCandle => ({ time: start + offset, open: 1, high: 2, low: .5, close: 1.5, volume: 100 });
const trade = (id: string, offset: number, side: 'buy' | 'sell' | 'unknown' = 'buy') => ({ id, timestamp: new Date((start + offset) * 1000).toISOString(), side });

describe('KOL chart trade markers', () => {
  it('groups unique fills by actual candle and side without changing price data', () => {
    const candles = [candle(0), candle(300)];
    const original = JSON.stringify(candles);
    expect(kolTradeMarkers(candles, [trade('1', 60), trade('2', 120), trade('2', 120), trade('3', 180, 'sell'), trade('4', 300)], '5m'))
      .toMatchObject([{ time: start, position: 'belowBar', text: 'B2' }, { time: start, position: 'aboveBar', text: 'S' }, { time: start + 300, text: 'B' }]);
    expect(JSON.stringify(candles)).toBe(original);
  });
  it('does not move out-of-range trades or gap trades onto unrelated candles', () => {
    expect(kolTradeMarkers([candle(0), candle(900)], [trade('early', -1), trade('gap', 600), trade('late', 1200), trade('unknown', 100, 'unknown')], '5m')).toEqual([]);
  });
  it('uses the selected interval and ignores invalid times', () => {
    expect(kolTradeMarkers([candle(0)], [trade('valid', 3599), { id: 'bad', timestamp: 'bad', side: 'buy' }], '1h')).toMatchObject([{ text: 'B' }]);
    expect(kolTradeMarkers([candle(0)], [trade('boundary', 3600)], '1h')).toEqual([]);
  });
  it('places minute trades on their own bars and excludes trades in a missing minute', () => {
    expect(kolTradeMarkers([candle(0), candle(60), candle(180)], [trade('first', 59), trade('next', 60), trade('gap', 120)], '1m'))
      .toMatchObject([{ time: start, text: 'B' }, { time: start + 60, text: 'B' }]);
    expect(tradeVisibleRange([candle(0)], [trade('late', 60)], '1m')).toBeNull();
  });
});

describe('KOL chart history selection', () => {
  it('focuses around actual trades while preserving context and handling missing history', () => {
    const candles = Array.from({ length: 100 }, (_, i) => candle(i * 300));
    expect(tradeVisibleRange(candles, [trade('1', 50 * 300), trade('2', 55 * 300)])).toEqual({ from: 42, to: 75 });
    expect(tradeVisibleRange(candles, [trade('1', -301)])).toBeNull();
    expect(tradeVisibleRange(candles, [trade('1', 100 * 300)])).toBeNull();
    expect(tradeVisibleRange(candles, [])).toBeNull();
  });
});
