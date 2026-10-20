import { describe, expect, it } from 'vitest';
import { normalizeSavedTokenChart } from './importSavedTokenCharts.js';
import { normalizeImportedChart } from './nodeChartImport.js';
const now = Date.parse('2026-10-19T20:00:00Z'), time = now / 1000 - 600;
const chart = { address: `0x${'2'.repeat(40)}`, source: 'gmgn', resolution: '1m', updatedAt: new Date(now - 30_000).toISOString(),
  candles: [{ time, open: 1e-9, high: 3e-9, low: 0.5e-9, close: 2e-9, volume: 5 }], volumeCurrency: 'usd' };
describe('saved chart migration evidence', () => {
  it('preserves original observation time, resolution and tiny real prices', () => {
    const input = normalizeSavedTokenChart(chart, now), normalized = normalizeImportedChart({ data: input.rows }, time * 1000, time * 1000, input.seconds, Date.parse(input.observedAt));
    expect(input.observedAt).toBe(chart.updatedAt); expect(input.provider).toBe('gmgn');
    expect(normalized.observations[0]).toMatchObject({ priceUsd: '0.000000002', volumeUsd: '5', intervalSeconds: 60 });
    expect(normalized.retrievalComplete).toBe(false);
  });
  it('does not relabel unknown volume as USD and never completes the forming candle later', () => {
    const input = normalizeSavedTokenChart({ ...chart, volumeCurrency: 'unknown', candles: [...chart.candles, { ...chart.candles[0], time: (now - 60_000) / 1000 }] }, now);
    const normalized = normalizeImportedChart({ data: input.rows }, time * 1000, now, input.seconds, Date.parse(input.observedAt));
    expect(normalized.observations).toHaveLength(1); expect(normalized.observations[0].volumeUsd).toBeNull();
  });
  it.each([{ source: 'node' }, { resolution: '15s' }, { address: '../outside' }, { updatedAt: new Date(now + 1).toISOString() }, { candles: Array(1001).fill(chart.candles[0]) }, { candles: [null] }, { candles: [[]] }])('rejects untrusted cache identity/shape %j', patch => {
    expect(() => normalizeSavedTokenChart({ ...chart, ...patch }, now)).toThrow('legacy_chart_invalid');
  });
});
