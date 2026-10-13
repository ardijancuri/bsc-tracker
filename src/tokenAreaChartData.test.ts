import { describe, expect, it } from 'vitest';
import type { MarketCandle } from '../shared/intelligence';
import { areaChartPaths, constrainChartWindow, fullChartWindow, marketCapAxis, marketCapLinePoints, nearestAreaPoint } from './tokenAreaChartData';

const candle = (time: number, close: number, volume = 10): MarketCandle => ({ time, open: close, high: close, low: close, close, volume });

describe('market cap area chart data', () => {
  it('uses real closes and current supply, preserving USD volume and sorting unique timestamps', () => {
    const points = marketCapLinePoints([candle(1200, .002, 90), candle(600, .001, 20), candle(600, .0015, 30), candle(900, NaN)], '1000000000');
    expect(points).toEqual([{ time: 600, value: 1_500_000, volume: 30 }, { time: 1200, value: 2_000_000, volume: 90 }]);
    expect(marketCapLinePoints([candle(600, .001)], null)).toEqual([]);
    expect(marketCapLinePoints([candle(600, .001)], '0')).toEqual([]);
  });
  it('places sparse samples by actual time rather than presenting gaps as consecutive candles', () => {
    const points = marketCapLinePoints([candle(300, 1), candle(900, 2), candle(1200, 3)], '1');
    const paths = areaChartPaths(points, time => (time - 300) / 9, value => 100 - value * 10, 100);
    expect(paths.line).toBe('M0,90 L66.67,80 L100,70');
    expect(paths.area).toBe('M0,90 L66.67,80 L100,70 L100,100 L0,100 Z');
    expect(paths.line).not.toContain('NaN');
  });
  it('clamps pan and zoom to the real available history and a useful minimum interval', () => {
    const full = { from: 1000, to: 2000 };
    expect(constrainChartWindow({ from: 700, to: 1200 }, full, 200)).toEqual({ from: 1000, to: 1500 });
    expect(constrainChartWindow({ from: 1800, to: 2300 }, full, 200)).toEqual({ from: 1500, to: 2000 });
    expect(constrainChartWindow({ from: 1200, to: 1220 }, full, 200)).toEqual({ from: 1200, to: 1400 });
    expect(constrainChartWindow({ from: 500, to: 3000 }, full, 200)).toEqual(full);
  });
  it('keeps empty and one-point histories finite without inventing additional samples', () => {
    const single = marketCapLinePoints([candle(600, 1)], '1000');
    expect(fullChartWindow(single, '5m')).toEqual({ from: 600, to: 900 });
    expect(fullChartWindow(single, '1m')).toEqual({ from: 600, to: 660 });
    expect(single).toHaveLength(1);
    for (const points of [[], single]) {
      const axis = marketCapAxis(points);
      expect(axis.min).toBeGreaterThanOrEqual(0);
      expect(axis.max).toBeGreaterThan(axis.min);
      expect(axis.ticks.every(Number.isFinite)).toBe(true);
    }
    expect(areaChartPaths([], value => value, value => value, 100)).toEqual({ line: '', area: '' });
  });
  it('snaps inspection to the closest real market sample including history boundaries', () => {
    const points = marketCapLinePoints([candle(300, 1), candle(900, 2), candle(1200, 3)], '1');
    expect(nearestAreaPoint(points, 700)).toBe(points[1]);
    expect(nearestAreaPoint(points, 600)).toBe(points[0]);
    expect(nearestAreaPoint(points, 10)).toBe(points[0]);
    expect(nearestAreaPoint(points, 9000)).toBe(points[2]);
    expect(nearestAreaPoint([], 600)).toBeNull();
  });
});
