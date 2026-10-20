import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { TokenChart } from '../shared/intelligence';
import { marketHistoryViewport, tradeChartViewport, tradeChartNeedsRefit, TokenPriceChart } from './TokenPriceChart';
import { TokenMarketPanel } from './TokenMarketPanel';

const state = vi.hoisted(() => ({ chart: null as TokenChart | null, error: false, retry: vi.fn(), useTokenChart: vi.fn() }));
vi.mock('./useTokenChart', () => ({ useTokenChart: (...args: unknown[]) => { state.useTokenChart(...args); return { chart: state.chart, error: state.error, retry: state.retry }; } }));
const address = '0xd75a0cc8614b7c8cac56f5af39d73491c2ea7777';
const render = (fullHistory = false) => renderToStaticMarkup(<TokenPriceChart address={address} interval="5m" fullHistory={fullHistory} />);

describe('readable token history viewport', () => {
  const history = (count: number, start = 1791586800) => Array.from({ length: count }, (_, index) => ({ time: start + index * 60, open: 1, high: 2, low: .5, close: 1.5, volume: 10 }));
  const bounds = (candles: ReturnType<typeof history>) => ({ firstTime: candles[0].time, lastTime: candles.at(-1)!.time, count: candles.length });
  it('opens thousands of minute bars at a readable recent window while leaving all history available', () => {
    const candles = history(4000);
    const range = marketHistoryViewport(candles, null)!;
    expect(range.from).toBeGreaterThan(3800);
    expect(range.to).toBeGreaterThanOrEqual(candles.length - 1);
    expect(1200 / (range.to - range.from)).toBeGreaterThanOrEqual(7);
  });
  it('does not refit all history when older candles are loaded', () => {
    const latest = history(100);
    const older = history(4000, latest[0].time - 3900 * 60);
    expect(marketHistoryViewport(older, bounds(latest))).toBeNull();
  });
  it('does not refit when backfill fills a gap between retained and latest history', () => {
    const candles = history(1000);
    const separatedWindows = [...candles.slice(0, 100), ...candles.slice(800)];
    expect(marketHistoryViewport(candles, bounds(separatedWindows))).toBeNull();
    // A live candle can arrive before the missing history does.
    const withNewLatest = [...separatedWindows, history(1, candles.at(-1)!.time + 60)[0]];
    expect(marketHistoryViewport(withNewLatest, bounds(separatedWindows))).toBeNull();
    expect(marketHistoryViewport([...candles, withNewLatest.at(-1)!], bounds(withNewLatest))).toBeNull();
  });
  it('opens the substantial recent segment without pulling older bars across a thirteen-hour gap', () => {
    const older = history(949), recent = history(109, older.at(-1)!.time + 793 * 60);
    const candles = [...older, ...recent];
    const range = marketHistoryViewport(candles, null, 1200, '1m')!;
    expect(range.from).toBeGreaterThan(948);
    expect(range.from).toBeLessThan(949);
    expect(range.to).toBeGreaterThan(1057);
    expect(1200 / (range.to - range.from)).toBeLessThanOrEqual(12);
    expect(candles).toHaveLength(1058);
    expect(marketHistoryViewport(candles, bounds(candles), 1200, '1m')).toBeNull();
  });
  it('keeps the ordinary context when fewer than forty recent observations follow a large gap', () => {
    const older = history(949), recent = history(39, older.at(-1)!.time + 793 * 60);
    const candles = [...older, ...recent];
    const range = marketHistoryViewport(candles, null, 1200, '1m')!;
    expect(range.from).toBeLessThan(949);
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
  it.each([1, 15, 80])('centers short histories of %i candles with equal blank time on both sides', count => {
    const range = marketHistoryViewport(history(count), null)!;
    expect((range.from + range.to) / 2).toBe((count - 1) / 2);
    expect(-range.from).toBeCloseTo(range.to - (count - 1), 10);
  });
});

describe('initial trade modal viewport', () => {
  const history = (count: number) => Array.from({ length: count }, (_, index) => ({ time: 1791586800 + index * 60, open: 1, high: 2, low: .5, close: 1.5, volume: 10 }));
  it('keeps a four-candle history narrow and centered before activity finishes', () => {
    const range = tradeChartViewport(history(4), [], '1m', 620)!;
    expect(620 / (range.to - range.from)).toBeLessThanOrEqual(12);
    expect((1.5 - range.from) / (range.to - range.from)).toBeCloseTo(.5, 10);
    expect(range.from).toBeLessThan(0);
    expect(range.to).toBeGreaterThan(3);
  });
  it('centers the recent context when selected trades are outside the available history', () => {
    const candles = history(400);
    const range = tradeChartViewport(candles, [{ id: 'older', side: 'buy', timestamp: new Date((candles[0].time - 60) * 1000).toISOString() }], '1m', 620)!;
    expect(range.to - range.from).toBeLessThanOrEqual(89);
    expect(range.from).toBeGreaterThan(300);
    expect(range.to).toBeGreaterThan(399);
  });
  it('centers the whole short history even when the KOL traded only its early candles', () => {
    const candles = history(15);
    const trades = [{ id: 'buy', side: 'buy' as const, timestamp: new Date(candles[0].time * 1000).toISOString() },
      { id: 'sell', side: 'sell' as const, timestamp: new Date(candles[3].time * 1000).toISOString() }];
    const range = tradeChartViewport(candles, trades, '1m', 620)!;
    expect((range.from + range.to) / 2).toBe(7);
    expect(-range.from).toBeCloseTo(range.to - 14, 10);
    expect(620 / (range.to - range.from)).toBeLessThanOrEqual(12);
  });
  it('waits for genuine candles', () => {
    expect(tradeChartViewport([], [], '1m', 620)).toBeNull();
  });
  it('recenters cached candles when a fresh window grows or shifts until the user adjusts the view', () => {
    const cached = history(6), previous = { firstTime: cached[0].time, lastTime: cached.at(-1)!.time, count: cached.length };
    const fresh = history(18), shifted = fresh.slice(12).map(candle => ({ ...candle, time: candle.time + 60 }));
    expect(tradeChartNeedsRefit(fresh, previous, false, false)).toBe(true);
    expect(tradeChartNeedsRefit(shifted, previous, false, false)).toBe(true);
    expect(tradeChartNeedsRefit(cached.map(candle => ({ ...candle, close: 1.6 })), previous, false, false)).toBe(false);
    expect(tradeChartNeedsRefit(fresh, previous, false, true)).toBe(false);
    expect(tradeChartNeedsRefit(fresh, previous, true, true)).toBe(false);
    expect(tradeChartNeedsRefit([], null, true, false)).toBe(false);
    const range = tradeChartViewport(fresh, [], '1m', 620)!;
    expect((range.from + range.to) / 2).toBe(8.5);
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
  it('shows real prices immediately when supply is unavailable instead of blocking older candles', () => {
    state.chart = { address, period: '5m', source: 'geckoterminal', candles: [{ time: 1791586800, open: 1, high: 2, low: .5, close: 1.5, volume: 10 }], points: [], pending: false, stale: false, updatedAt: null, resolution: '5m', marketCapSupply: null };
    const html = render();
    expect(html).toContain('Market cap unavailable; showing token price');
    expect(html).toContain('Price <b>$1.5</b>');
    expect(html).toContain('1 candles');
    expect(html).not.toContain('class="price-chart-status"');
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
  it('keeps genuine candles visible during independent token-history recovery', () => {
    state.chart={address,period:'5m',source:'imported',candles:[{time:1791586800,open:1,high:2,low:.5,close:1.5,volume:0}],points:[],pending:false,stale:true,
      updatedAt:'2026-10-10T00:00:00Z',resolution:'5m',marketCapSupply:null,volumeCurrency:'unknown',partialHistory:true,historyLoadStatus:'limited',historyRecoveryPending:true};
    const html=render(true);
    expect(html).toContain('Recovering historical candles…');expect(html).toContain('1 candles');
    expect(html).toContain('Price <b>$1.5</b>');expect(html).not.toContain('Volume <b>');
    expect(html).not.toContain('Earlier history unavailable');
  });
  it('discloses major observation gaps with at most five dated windows rather than fabricating bars', () => {
    const start = 1791586800;
    state.chart = { address, period: '1m', source: 'mixed', candles: Array.from({ length: 8 }, (_, index) => ({ time: start + index * 3600, open: 1, high: 2, low: .5, close: 1.5, volume: 10 })), points: [], pending: false, stale: false, updatedAt: null, resolution: '1m' };
    const html = renderToStaticMarkup(<TokenPriceChart address={address} interval="1m" />);
    expect(html).toContain('8 candles');
    expect(html).toContain('Gaps in available observations: 7');
    const title = html.match(/title="Gaps in available observations([^\"]*)"/)?.[1] ?? '';
    expect(title.match(/ UTC/g)).toHaveLength(5);
    expect(html).not.toContain('0 volume');
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
