import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { TokenChart } from '../shared/intelligence';
import { TokenPriceChart } from './TokenPriceChart';

const state = vi.hoisted(() => ({ chart: null as TokenChart | null }));
vi.mock('./useTokenChart', () => ({ useTokenChart: () => ({ chart: state.chart, error: false }) }));
const address = '0xd75a0cc8614b7c8cac56f5af39d73491c2ea7777';
const render = () => renderToStaticMarkup(<TokenPriceChart address={address} interval="5m" />);

describe('market cap candle chart', () => {
  it.each([
    ['queued', 'Waiting for market data…'],
    ['rate_limited', 'Market provider cooling down. Retrying automatically…'],
    ['provider_error', 'Market provider unavailable. Retrying automatically…'],
  ] as const)('explains %s without falsely claiming that candles do not exist', (loadStatus, message) => {
    state.chart = { address, period: '5m', source: 'unavailable', candles: [], points: [], pending: false, stale: false, updatedAt: null, resolution: '5m', loadStatus, retryAfterMs: 30_000 };
    const html = render();
    expect(html).toContain(message);
    expect(html).not.toContain('Candle data unavailable');
  });
  it('keeps missing OHLC history empty rather than showing a recorded-price line', () => {
    state.chart = { address, period: '5m', source: 'recorded', candles: [], points: [{ timestamp: '2026-10-10T00:00:00Z', priceUsd: '1' }], pending: true, stale: false, updatedAt: null, resolution: '5m' };
    const html = render();
    expect(html).toContain('Loading candles…');
    expect(html).toContain('0 candles');
    expect(html).not.toContain('<button');
    expect(html).not.toContain('USD 1');
  });
  it('shows market cap OHLC instead of token prices, without changing dollar volume', () => {
    state.chart = { address, period: '5m', source: 'geckoterminal', candles: [{ time: 1791586800, open: .001, high: .002, low: .0005, close: .0015, volume: 10 }], points: [], pending: false, stale: false, updatedAt: null, resolution: '5m', marketCapSupply: '1000000000' };
    const html = render();
    expect(html).toContain('Market cap <b>$1.5M</b>');
    expect(html).toContain('O <b>$1M</b>');
    expect(html).toContain('H <b>$2M</b>');
    expect(html).toContain('L <b>$500K</b>');
    expect(html).toContain('Volume <b>$10</b>');
    expect(html).not.toContain('>Line<');
    expect(html).not.toContain('>Reset<');
  });
  it('explains unavailable supply and offers the live chart', () => {
    state.chart = { address, period: '5m', source: 'geckoterminal', candles: [{ time: 1791586800, open: 1, high: 2, low: .5, close: 1.5, volume: 10 }], points: [], pending: false, stale: false, updatedAt: null, resolution: '5m', marketCapSupply: null };
    const html = render();
    expect(html).toContain('Market cap data unavailable');
    expect(html).toContain(`https://gmgn.ai/bsc/token/${address}`);
    expect(html).not.toContain('$1.50');
  });
});
