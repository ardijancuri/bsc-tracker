import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { TokenChart } from '../shared/intelligence';
import { marketHistoryViewport, TokenPriceChart } from './TokenPriceChart';
import { TokenMarketPanel } from './TokenMarketPanel';

const state = vi.hoisted(() => ({ chart: null as TokenChart | null, error: false, retry: vi.fn(), useTokenChart: vi.fn() }));
vi.mock('./useTokenChart', () => ({ useTokenChart: (...args: unknown[]) => { state.useTokenChart(...args); return { chart: state.chart, error: state.error, retry: state.retry }; } }));
const address = '0xd75a0cc8614b7c8cac56f5af39d73491c2ea7777';
const render = (fullHistory = false) => renderToStaticMarkup(<TokenPriceChart address={address} interval="5m" fullHistory={fullHistory} />);

describe('complete token history viewport', () => {
  const history = (count: number, start = 1791586800) => Array.from({ length: count }, (_, index) => ({ time: start + index * 60, open: 1, high: 2, low: .5, close: 1.5, volume: 10 }));
  const bounds = (candles: ReturnType<typeof history>) => ({ firstTime: candles[0].time, lastTime: candles.at(-1)!.time, count: candles.length });
  it('includes the first and last candles even when there are thousands of one-minute bars', () => {
    const candles = history(4000);
    const range = marketHistoryViewport(candles, null)!;
    expect(range.from).toBeLessThanOrEqual(-.5);
    expect(range.to).toBeGreaterThanOrEqual(candles.length - 1);
  });
  it('expands the viewport when older candles are loaded', () => {
    const latest = history(100);
    const older = history(4000, latest[0].time - 3900 * 60);
    expect(marketHistoryViewport(older, bounds(latest))).toEqual({ from: -1.75, to: 4000.75 });
  });
  it('expands when backfill fills a gap between retained and latest history', () => {
    const candles = history(1000);
    const separatedWindows = [...candles.slice(0, 100), ...candles.slice(800)];
    expect(marketHistoryViewport(candles, bounds(separatedWindows))).toEqual({ from: -1.75, to: 1000.75 });
    // A live candle can arrive before the missing history does.
    const withNewLatest = [...separatedWindows, history(1, candles.at(-1)!.time + 60)[0]];
    expect(marketHistoryViewport(withNewLatest, bounds(separatedWindows))).toBeNull();
    expect(marketHistoryViewport([...candles, withNewLatest.at(-1)!], bounds(withNewLatest))).toEqual({ from: -1.75, to: 1001.75 });
  });
  it('preserves pan and zoom on candle refreshes and newly appended candles', () => {
    const candles = history(100), previous = bounds(candles);
    expect(marketHistoryViewport(candles.map(candle => ({ ...candle, close: 1.7 })), previous)).toBeNull();
    expect(marketHistoryViewport(history(101), previous)).toBeNull();
    expect(marketHistoryViewport(candles.slice(1), previous)).toBeNull();
  });
  it('waits for candles and handles a token with a single candle', () => {
    expect(marketHistoryViewport([], null)).toBeNull();
    const range = marketHistoryViewport(history(1), null)!;
    expect(range.from).toBeLessThan(0);
    expect(range.to).toBeGreaterThan(1);
    expect(range.to - range.from).toBeGreaterThanOrEqual(100);
  });
  it('keeps ten launch candles narrow and exactly centered on desktop', () => {
    const candles = history(10), width = 1200;
    const range = marketHistoryViewport(candles, null, width)!;
    const spacing = width / (range.to - range.from);
    const center = ((candles.length - 1) / 2 - range.from) / (range.to - range.from);
    expect(spacing).toBeLessThanOrEqual(12);
    expect(spacing).toBeGreaterThanOrEqual(10);
    expect(center).toBeCloseTo(.5, 10);
    expect(range.from).toBeLessThan(0);
    expect(range.to).toBeGreaterThan(candles.length - 1);
  });
  it('retains readable short-history candles on a narrow chart', () => {
    const range = marketHistoryViewport(history(10), null, 360)!;
    const spacing = 360 / (range.to - range.from);
    expect(spacing).toBeGreaterThanOrEqual(8);
    expect(spacing).toBeLessThanOrEqual(12);
    expect(range.from).toBeLessThan(0);
    expect(range.to).toBeGreaterThan(9);
    expect((4.5 - range.from) / (range.to - range.from)).toBeCloseTo(.5, 10);
  });
  it.each([1, 15, 4000])('centers all %i candles with equal blank time on both sides', count => {
    const range = marketHistoryViewport(history(count), null)!;
    expect((range.from + range.to) / 2).toBe((count - 1) / 2);
    expect(-range.from).toBeCloseTo(range.to - (count - 1), 10);
  });
});

describe('market cap candle chart', () => {
  beforeEach(() => { state.chart = null; state.error = false; state.retry.mockClear(); state.useTokenChart.mockClear(); });
  it('uses a single candlestick consumer at the default 1m interval on the token detail page', () => {
    const html = renderToStaticMarkup(<TokenMarketPanel address={address} identity="Token" />);
    expect(html).toContain('id="token-market-1m" aria-selected="true"');
    expect(html).toContain('class="price-chart-canvas"');
    expect(html).not.toContain('token-area-chart-line');
    expect(state.useTokenChart.mock.calls).toEqual([[address, '1m', true, 'chart', true]]);
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
  it('keeps full-history paging opt-in so trade-focused charts use the recent window', () => {
    renderToStaticMarkup(<TokenPriceChart address={address} interval="1m" focusTrades />);
    expect(state.useTokenChart.mock.calls).toEqual([[address, '1m', true, 'chart', false]]);
  });
  it('keeps current candles visible while fetching earlier history and removes the limit when complete', () => {
    state.chart = { address, period: '5m', source: 'gmgn', candles: [{ time: 1791586800, open: .001, high: .002, low: .0005, close: .0015, volume: 10 }], points: [], pending: false, stale: false, updatedAt: null, resolution: '5m', marketCapSupply: '1000000000', partialHistory: true, historyPending: true };
    const html = render(true);
    expect(html).toContain('1 candles');
    expect(html).toContain('Loading earlier candles…');
    expect(html).not.toContain('class="price-chart-status"');
    state.chart = { ...state.chart, historyComplete: true, historyPending: false };
    expect(render(true)).not.toContain('Limited history');
    expect(render(true)).not.toContain('Loading earlier candles…');
  });
  it.each([
    ['rate_limited', 'Earlier history cooling down. Retrying automatically…', true],
    ['provider_error', 'Earlier history unavailable. Retrying automatically…', false],
    ['limited', 'Earlier history unavailable', null],
  ] as const)('describes %s history while preserving loaded candles', (historyLoadStatus, message, disabled) => {
    state.chart = { address, period: '5m', source: 'gmgn', candles: [{ time: 1791586800, open: .001, high: .002, low: .0005, close: .0015, volume: 10 }], points: [], pending: false, stale: false, updatedAt: null, resolution: '5m', marketCapSupply: '1000000000', partialHistory: true, historyPending: false, historyLoadStatus };
    const html = render(true);
    expect(html).toContain('1 candles');
    expect(html).toContain(message);
    expect(html).not.toContain('class="price-chart-status"');
    if (disabled === true) expect(html).toContain('<button type="button" disabled="">Try again</button>');
    else if (disabled === false) expect(html).toContain('<button type="button">Try again</button>');
    else expect(html).not.toContain('>Try again</button>');
    expect(render(false)).not.toContain('Earlier history');
  });
});
