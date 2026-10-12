import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { TokenChart } from '../shared/intelligence';
import { TokenAreaChart } from './TokenAreaChart';

const address = '0xd75a0cc8614b7c8cac56f5af39d73491c2ea7777';
const chart = (overrides: Partial<TokenChart> = {}): TokenChart => ({ address, period: '5m', source: 'geckoterminal', candles: [{ time: 1791586800, open: .001, high: .002, low: .0005, close: .0015, volume: 10 }], points: [], pending: false, stale: false, updatedAt: null, resolution: '5m', marketCapSupply: '1000000000', ...overrides });
const render = (data: TokenChart | null, error = false) => renderToStaticMarkup(<TokenAreaChart address={address} interval="5m" data={data} error={error} />);

describe('native token market chart', () => {
  it('renders market cap and dollar volume as a native gradient line chart', () => {
    const html = render(chart());
    expect(html).toContain('Market cap <b>$1.5M</b>');
    expect(html).toContain('Volume <b>$10</b>');
    expect(html).toContain('<linearGradient');
    expect(html).toContain('class="token-area-chart-line"');
    expect(html).toContain('1 market samples');
    expect(html).not.toContain('TradingView');
    expect(html).not.toContain('Loading');
    expect(html).not.toContain('NaN');
  });
  it.each([
    ['queued', 'Waiting for market data…'],
    ['rate_limited', 'Market provider cooling down. Retrying automatically…'],
    ['provider_error', 'Market provider unavailable. Retrying automatically…'],
  ] as const)('describes %s while keeping the retry automatic', (loadStatus, message) => {
    const html = render(chart({ candles: [], loadStatus }));
    expect(html).toContain(message);
    expect(html).toContain('Open live chart');
  });
  it('keeps cached history visible through a provider refresh failure', () => {
    const html = render(chart({ stale: true, loadStatus: 'rate_limited' }), true);
    expect(html).toContain('Market cap <b>$1.5M</b>');
    expect(html).toContain('Cached');
    expect(html).toContain('Refresh paused');
    expect(html).not.toContain('token-area-chart-status');
  });
  it('identifies CMC while omitting a dollar volume label for unspecified provider volume units', () => {
    const html = render(chart({ source: 'coinmarketcap', volumeCurrency: 'unknown' }));
    expect(html).toContain('CoinMarketCap');
    expect(html).toContain('Market cap <b>$1.5M</b>');
    expect(html).not.toContain('Volume <b>');
  });
  it('does not substitute recorded fills for missing market history or invent cap without supply', () => {
    const html = render(chart({ source: 'recorded', candles: [], points: [{ timestamp: '2026-10-10T00:00:00Z', priceUsd: '99' }], pending: true }));
    expect(html).toContain('Loading market chart…');
    expect(html).toContain('0 market samples');
    expect(html).not.toContain('$99');
    expect(render(chart({ marketCapSupply: null }))).toContain('Market cap data unavailable');
  });
  it('treats a supply refresh as loading instead of a permanent missing-market-cap error', () => {
    const html = render(chart({ marketCapSupply: null, supplyPending: true, pending: true, retryAfterMs: 3000 }));
    expect(html).toContain('Loading market cap…');
    expect(html).not.toContain('Market cap data unavailable');
    expect(html).not.toContain('$1.5M');
  });
});
