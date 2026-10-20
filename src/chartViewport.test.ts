import { describe, expect, it } from 'vitest';
import { chartPriceTickmarks, formatChartPrice, latestSubstantialSegmentStart, majorCandleGaps, readableCandleSlots, remapChartViewport } from './chartViewport';

const history = (count: number, offset = 0) => Array.from({ length: count }, (_, index) => ({ time: 1791586800 + (offset + index) * 60, open: 1, high: 2, low: .5, close: 1.5, volume: 10 }));

describe('gaps in available observations', () => {
  it('identifies the observed bounds without inserting or modifying candles', () => {
    const candles = [...history(949), ...history(109, 949 + 792)];
    const before = structuredClone(candles);
    expect(majorCandleGaps(candles, '1m')).toEqual([{ index: 949, from: candles[948].time + 60, to: candles[949].time }]);
    expect(latestSubstantialSegmentStart(candles, '1m')).toBe(949);
    expect(candles).toEqual(before);
  });
  it('does not classify brief sparse trading as a major gap', () => {
    expect(majorCandleGaps([...history(5), ...history(50, 35)], '1m')).toEqual([]);
    expect(majorCandleGaps([...history(5), ...history(50, 65)], '1h')).toEqual([]);
  });
  it.each([['1m', 3600], ['5m', 3600], ['1h', 36000], ['4h', 144000], ['1d', 864000]] as const)('scales the major-gap threshold for %s candles', (interval, threshold) => {
    const first = history(1)[0];
    expect(majorCandleGaps([first, { ...first, time: first.time + threshold - 1 }], interval)).toHaveLength(0);
    expect(majorCandleGaps([first, { ...first, time: first.time + threshold }], interval)).toHaveLength(1);
  });
  it('retains useful earlier history when the newest disconnected segment is too short', () => {
    expect(latestSubstantialSegmentStart([...history(150), ...history(39, 150 + 792)], '1m')).toBe(0);
    expect(latestSubstantialSegmentStart([], '1m')).toBe(0);
  });
});

describe('chart viewport continuity', () => {
  it('keeps a panned historical window on the same timestamps when earlier pages are prepended', () => {
    const previous = history(100, 100), next = history(200);
    expect(remapChartViewport(previous, next, { from: 15.5, to: 55.5 })).toEqual({ from: 115.5, to: 155.5 });
  });
  it('preserves observed time anchors when genuine missing candles arrive inside a gap', () => {
    const all = history(120), previous = [...all.slice(0, 20), ...all.slice(100)];
    expect(remapChartViewport(previous, all, { from: 10, to: 30 })).toEqual({ from: 10, to: 110 });
    expect(remapChartViewport(previous, all, { from: 19.5, to: 31.5 })).toEqual({ from: 59.5, to: 111.5 });
  });
  it('preserves blank context rather than clamping a short centered history to its edges', () => {
    expect(remapChartViewport(history(4, 10), history(14), { from: -18.5, to: 21.5 })).toEqual({ from: -8.5, to: 31.5 });
  });
  it('follows live bars only for an untouched view at the latest edge', () => {
    const before = history(100), next = history(102);
    expect(remapChartViewport(before, next, { from: 60, to: 102 }, true)).toEqual({ from: 62, to: 104 });
    expect(remapChartViewport(before, next, { from: 60, to: 102 }, false)).toEqual({ from: 60, to: 102 });
    expect(remapChartViewport(before, next, { from: 20, to: 60 }, true)).toEqual({ from: 20, to: 60 });
  });
  it('does not create a viewport before real data is present', () => {
    expect(remapChartViewport([], history(10), { from: 0, to: 20 })).toBeNull();
    expect(remapChartViewport(history(10), [], { from: 0, to: 20 })).toBeNull();
    expect(remapChartViewport(history(10), history(10), null)).toBeNull();
  });
  it('allows a readable reset when a corrected history no longer includes either visible anchor', () => {
    expect(remapChartViewport(history(100), history(100, 200), { from: 20, to: 60 })).toBeNull();
    expect(remapChartViewport(history(100, 200), history(100), { from: 20, to: 60 })).toBeNull();
  });
  it.each([0, -1, NaN, Infinity])('has a compact fallback for invalid plot width %s', width => {
    expect(readableCandleSlots(width)).toEqual(readableCandleSlots(480));
  });
});

describe('readable chart price ticks', () => {
  it('distinguishes adjacent market-cap ticks around a million rather than repeating $1M', () => {
    const prices = [980_000, 1_000_000, 1_020_000, 1_040_000];
    expect(chartPriceTickmarks(prices, true, 'en-US')).toEqual(['$980K', '$1M', '$1.02M', '$1.04M']);
  });
  it('increases precision for tight zoom ranges and preserves tick order', () => {
    const prices = [1_000_002, 1_000_001, 1_000_000, 1_000_001];
    const labels = chartPriceTickmarks(prices, true, 'en-US');
    expect(new Set(labels).size).toBe(3); expect(labels[1]).toBe(labels[3]);
    expect(prices).toEqual([1_000_002, 1_000_001, 1_000_000, 1_000_001]);
  });
  it('retains precision for tiny real prices and supports Chinese formatting', () => {
    expect(formatChartPrice(1.25e-12, false, 'en-US')).toBe('$0.00000000000125');
    const labels = chartPriceTickmarks([1e-12, 1.01e-12, 1.02e-12], false, 'zh-CN');
    expect(new Set(labels).size).toBe(3);
    expect(new Set(chartPriceTickmarks([1_000_000, 1_020_000, 1_040_000], true, 'zh-CN')).size).toBe(3);
  });
});
