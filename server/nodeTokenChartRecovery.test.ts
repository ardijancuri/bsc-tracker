import { describe, expect, it } from 'vitest';
import { historicalChartSegments } from './nodeTokenChartRecovery.js';
describe('coalesced historical token chart windows', () => {
  const to = Date.parse('2026-10-19T19:46:07Z');
  it.each([[60, 86400], [300, 432000], [3600, 2592000], [14400, 7776000], [86400, 15552000]])('bounds %ss requests in fixed completed segments', (seconds, span) => {
    const windows = historicalChartSegments(to - span * 1000, to, seconds);
    expect(windows.length).toBeLessThanOrEqual(4);
    expect(Date.parse(windows[0].from)).toBeLessThanOrEqual(to - span * 1000);
    expect(Date.parse(windows.at(-1)!.to)).toBe(Math.floor(to / (seconds * 1000)) * seconds * 1000);
    for (const window of windows) expect((Date.parse(window.to) - Date.parse(window.from)) / seconds / 1000).toBeLessThanOrEqual(1000);
    expect(historicalChartSegments(to - span * 1000 + 1000, to, seconds)).toEqual(windows);
  });
  it('rejects unbounded or invalid work without contacting a provider', () => {
    expect(() => historicalChartSegments(1, to, 60)).toThrow('import_chart_window_too_large');
    expect(() => historicalChartSegments(to, to, 60)).toThrow('import_chart_window_invalid');
    expect(() => historicalChartSegments(to - 1000, to, 15)).toThrow('import_chart_window_invalid');
  });
});
