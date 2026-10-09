import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { TokenChart } from '../shared/intelligence';
import { TokenPriceChart } from './TokenPriceChart';

const state = vi.hoisted(() => ({ chart: null as TokenChart | null }));
vi.mock('./useTokenChart', () => ({ useTokenChart: () => ({ chart: state.chart, error: false }) }));
const address = '0xd75a0cc8614b7c8cac56f5af39d73491c2ea7777';
const render = () => renderToStaticMarkup(<TokenPriceChart address={address} period="24h" />);

describe('chart mode controls', () => {
  it('selects the actual line fallback and explains pending candle data', () => {
    state.chart = { address, period: '24h', source: 'recorded', candles: [], points: [{ timestamp: '2026-10-10T00:00:00Z', priceUsd: '1' }], pending: true, stale: false, updatedAt: null, resolution: '5m' };
    const html = render();
    expect(html).toMatch(/disabled=""[^>]*aria-pressed="false"[^>]*>Candles/);
    expect(html).toMatch(/aria-pressed="true"[^>]*>Line/);
    expect(html).toContain('Loading candles…');
  });
  it('enables and selects candles when real OHLC history arrives', () => {
    state.chart = { address, period: '24h', source: 'geckoterminal', candles: [{ time: 1791586800, open: 1, high: 2, low: .5, close: 1.5, volume: 10 }], points: [], pending: false, stale: false, updatedAt: null, resolution: '5m' };
    expect(render()).toMatch(/<button[^>]*aria-pressed="true"[^>]*>Candles/);
    expect(render()).not.toContain('disabled=""');
  });
  it('offers the live chart without pretending missing data is candlesticks', () => {
    state.chart = { address, period: '24h', source: 'recorded', candles: [], points: [{ timestamp: '2026-10-10T00:00:00Z', priceUsd: '1' }], pending: false, stale: false, updatedAt: null, resolution: '5m' };
    const html = render();
    expect(html).toContain('Candle data unavailable');
    expect(html).toContain(`https://gmgn.ai/bsc/token/${address}`);
  });
});
