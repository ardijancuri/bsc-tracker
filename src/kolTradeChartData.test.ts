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
    expect(tradeVisibleRange(candles, [trade('1', 50 * 300), trade('2', 55 * 300)])).toEqual({ from: 32.5, to: 72.5 });
    expect(tradeVisibleRange(candles, [trade('1', -301)])).toBeNull();
    expect(tradeVisibleRange(candles, [trade('1', 100 * 300)])).toBeNull();
    expect(tradeVisibleRange(candles, [])).toBeNull();
  });
  it('keeps four new-token minute candles centered at normal spacing instead of stretching them', () => {
    const candles = Array.from({ length: 4 }, (_, i) => candle(i * 60));
    const trades = [trade('buy', 0), trade('sell', 180, 'sell')];
    const range = tradeVisibleRange(candles, trades, '1m', 720)!;
    expect(range).toEqual({ from: -28.5, to: 31.5 });
    const x = (index: number) => (index - range.from) / (range.to - range.from) * 720;
    expect((x(0) + x(3)) / 2).toBe(360);
    expect(x(1) - x(0)).toBe(12);
  });
  it.each([0, 99])('centers a trade at candle %s without clamping away the empty side', index => {
    const candles = Array.from({ length: 100 }, (_, i) => candle(i * 300));
    expect(tradeVisibleRange(candles, [trade('buy', index * 300)], '5m', 480)).toEqual({ from: index - 20, to: index + 20 });
  });
  it('scales the visible range to plot width while keeping the same trade center', () => {
    const candles = Array.from({ length: 100 }, (_, i) => candle(i * 300));
    const trades = [trade('buy', 50 * 300), trade('sell', 55 * 300, 'sell')];
    expect(tradeVisibleRange(candles, trades, '5m', 240)).toEqual({ from: 32.5, to: 72.5 });
    expect(tradeVisibleRange(candles, trades, '5m', 960)).toEqual({ from: 12.5, to: 92.5 });
  });
  it('includes the full long trade span and equal context on both sides', () => {
    const candles = Array.from({ length: 500 }, (_, i) => candle(i * 300));
    const range = tradeVisibleRange(candles, [trade('buy', 10 * 300), trade('sell', 410 * 300, 'sell')], '5m', 480)!;
    expect((range.from + range.to) / 2).toBe(210);
    expect(10 - range.from).toBe(range.to - 410);
    expect(range.from).toBeLessThan(10); expect(range.to).toBeGreaterThan(410);
  });
  it('focuses only observed trade bars when history partially overlaps or contains gaps', () => {
    const candles = [candle(0), candle(60), candle(180)];
    const trades = [trade('before', -60), trade('buy', 60), trade('gap', 120), trade('after', 240), trade('unknown', 180, 'unknown')];
    expect(tradeVisibleRange(candles, trades, '1m', 480)).toEqual({ from: -19, to: 21 });
    expect(tradeVisibleRange(candles, [trade('gap', 120), trade('after', 240)], '1m', 480)).toBeNull();
  });
  it.each([0, -1, NaN, Infinity])('uses the compact default when plot width is %s', width => {
    expect(tradeVisibleRange([candle(0)], [trade('buy', 0)], '5m', width)).toEqual({ from: -20, to: 20 });
  });
  it('returns no trade focus for absent candles or invalid trades without changing input data', () => {
    const candles = [candle(0)], original = JSON.stringify(candles);
    expect(tradeVisibleRange([], [trade('buy', 0)])).toBeNull();
    expect(tradeVisibleRange(candles, [{ id: 'invalid', timestamp: 'bad', side: 'buy' }, trade('unknown', 0, 'unknown')])).toBeNull();
    expect(JSON.stringify(candles)).toBe(original);
  });
});
