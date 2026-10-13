import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { TokenChart } from '../shared/intelligence';
import { TokenPriceChart } from './TokenPriceChart';
import { TokenMarketPanel } from './TokenMarketPanel';

const state = vi.hoisted(() => ({ chart: null as TokenChart | null, error: false, retry: vi.fn(), useTokenChart: vi.fn() }));
vi.mock('./useTokenChart', () => ({ useTokenChart: (...args: unknown[]) => { state.useTokenChart(...args); return { chart: state.chart, error: state.error, retry: state.retry }; } }));
const address = '0xd75a0cc8614b7c8cac56f5af39d73491c2ea7777';
const render = () => renderToStaticMarkup(<TokenPriceChart address={address} interval="5m" />);

describe('market cap candle chart', () => {
  beforeEach(() => { state.chart = null; state.error = false; state.retry.mockClear(); state.useTokenChart.mockClear(); });
  it('uses a single candlestick consumer at the default 1m interval on the token detail page', () => {
    const html = renderToStaticMarkup(<TokenMarketPanel address={address} identity="Token" />);
    expect(html).toContain('id="token-market-1m" aria-selected="true"');
    expect(html).toContain('class="price-chart-canvas"');
    expect(html).not.toContain('token-area-chart-line');
    expect(state.useTokenChart.mock.calls).toEqual([[address, '1m']]);
  });
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
    expect(html).toContain('>Try again</button>');
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
  it('retains cached candles and offers recovery when refreshing fails', () => {
    state.chart = { address, period: '5m', source: 'gmgn', candles: [{ time: 1791586800, open: .001, high: .002, low: .0005, close: .0015, volume: 10 }], points: [], pending: false, stale: true, updatedAt: null, resolution: '5m', marketCapSupply: '1000000000' };
    state.error = true;
    const html = render();
    expect(html).toContain('1 candles');
    expect(html).toContain('Cached');
    expect(html).toContain('Chart refresh failed. Retrying automatically…');
    expect(html).toContain('>Try again</button>');
    expect(html).not.toContain('class="price-chart-status"');
    expect(html).not.toContain('Refresh paused');
  });
  it('prevents manual retries during a provider cooldown', () => {
    state.chart = { address, period: '5m', source: 'unavailable', candles: [], points: [], pending: false, stale: false, updatedAt: null, resolution: '5m', loadStatus: 'rate_limited', retryAfterMs: 30_000 };
    expect(render()).toContain('<button type="button" disabled="">Try again</button>');
  });
  it('identifies GMGN and CMC data and omits dollar volume for unknown units', () => {
    const candles = [{ time: 1791586800, open: .001, high: .002, low: .0005, close: .0015, volume: 10 }];
    state.chart = { address, period: '5m', source: 'gmgn', candles, points: [], pending: false, stale: false, updatedAt: null, resolution: '5m', marketCapSupply: '1000000000' };
    expect(render()).toContain('>GMGN</a>');
    state.chart = { ...state.chart, source: 'coinmarketcap', volumeCurrency: 'unknown' };
    expect(render()).toContain('>CoinMarketCap</span>');
    expect(render()).not.toContain('Volume <b>');
  });
});
