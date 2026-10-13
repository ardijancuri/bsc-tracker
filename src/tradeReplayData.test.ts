import { describe, expect, it } from 'vitest';
import type { Position, TokenChart } from '../shared/intelligence';
import type { KolTokenActivity, KolTokenTrade } from '../shared/kolTokenTrades';
import { prepareTradeReplayData, replayNumber, replaySignedNumber } from './tradeReplayData';
import { replayFileName } from './tradeReplayExport';
import ReplayCanvas from './tradeReplayCanvas';

const wallet = '0x1111111111111111111111111111111111111111';
const token = '0x2222222222222222222222222222222222222222';
const now = Date.parse('2026-10-11T12:00:00Z');
function fill(id: string, side: 'buy' | 'sell', amountUsd: string, priceUsd: string, timestamp: string): KolTokenTrade {
  return { id, side, txHash: `0x${id}`, walletAddress: wallet, tokenAddress: token, kolName: 'Trader', kolAvatarUrl: null, kolTwitter: null,
    tokenSymbol: 'TEST', tokenName: 'Test', tokenLogoUrl: null, tokenAmount: '100', quoteSymbol: 'BNB', quoteAmount: null,
    amountUsd, priceUsd, marketCapUsd: null, timestamp, source: 'node', blockNumber: '1', transactionIndex: 0,
    valuationStatus: 'valued', realizedProfitUsd: null, cumulativeRealizedProfitUsd: null };
}
function activity(): KolTokenActivity {
  return { kol: { address: wallet, name: 'Trader', avatarUrl: null, twitter: null, source: 'node', lastSeenAt: null },
    token: { address: token, symbol: 'TEST', name: 'Test', logoUrl: null, priceUsd: '9', marketCapUsd: '9000', marketCapSupply: '1000' },
    trades: [fill('b', 'buy', '100', '1', '2026-10-11T10:01:00Z'), fill('s', 'sell', '500', '5', '2026-10-11T10:09:00Z')],
    coverage: { source: 'indexed', indexedTradeCount: 2, returnedTradeCount: 2, complete: true, historyLimit: 2000, costsIncluded: false },
    summary: {} as KolTokenActivity['summary'], generatedAt: new Date(now).toISOString() };
}
const position: Position = { walletAddress: wallet, tokenAddress: token, balance: '0', status: 'Exited', checkedAt: new Date(now).toISOString(), blockNumber: '1', lastMovementAt: null };
const chart: TokenChart = { address: token, period: '5m', marketCapSupply: '1000', resolution: '5m', source: 'geckoterminal', pending: false, stale: false, updatedAt: new Date(now).toISOString(),
  candles: [ { time: Date.parse('2026-10-11T10:00:00Z') / 1000, open: 2, high: 4, low: 1, close: 3, volume: 1 },
    { time: Date.parse('2026-10-11T10:05:00Z') / 1000, open: 3, high: 6, low: 2, close: 4, volume: 1 } ], points: [] };

describe('trade replay factual boundary', () => {
  it('keeps missing amounts missing and never infers supply from current market cap/price', () => {
    for (const raw of [null, undefined, '', true, 'NaN', '-1', 'Infinity']) expect(replayNumber(raw)).toBeNull();
    const payload = activity(); payload.token.marketCapSupply = null; payload.trades[0].amountUsd = null; payload.trades[0].priceUsd = null;
    const data = prepareTradeReplayData(payload, null, position, now)!;
    expect(data.chart.marketCapSupply).toBeNull();
    expect(data.trades[0].amountUsd).toBeNull(); expect(data.trades[0].priceUsd).toBeNull();
    expect(data.position.tradeFlowMatched).toBe(false);
  });
  it('gates profit on complete flow, fresh independently checked balance, and usable USD fills', () => {
    expect(prepareTradeReplayData(activity(), chart, position, now)!.position.tradeFlowMatched).toBe(true);
    const stale = { ...position, checkedAt: new Date(now - 180001).toISOString() };
    expect(prepareTradeReplayData(activity(), chart, stale, now)!.position.status).toBe('unknown');
    expect(prepareTradeReplayData(activity(), chart, { ...position, balance: '1' }, now)!.position.tradeFlowMatched).toBe(false);
    const incomplete = activity(); incomplete.coverage.complete = false;
    expect(prepareTradeReplayData(incomplete, chart, position, now)!.position.tradeFlowMatched).toBe(false);
    const shared = activity(); shared.trades[0].valuationStatus = 'shared_quote';
    const sharedReplay = prepareTradeReplayData(shared, chart, position, now)!;
    expect(sharedReplay.position.tradeFlowMatched).toBe(false);
    expect(sharedReplay.trades[0].amountUsd).toBeNull(); expect(sharedReplay.trades[0].priceUsd).toBeNull(); expect(sharedReplay.trades[0].marketCapUsd).toBeNull();
    const unknown = prepareTradeReplayData(activity(), chart, { ...position, status: 'Unknown' }, now)!;
    expect(unknown.position.tradeFlowMatched).toBe(false); expect(unknown.position.status).toBe('unknown');
    expect(unknown.position.tokenBalance).toBeNull();
  });
  it('uses block and transaction ordering before IDs for same-second fills', () => {
    const payload = activity();
    payload.trades[0] = { ...payload.trades[0], id: 'z-buy', timestamp: '2026-10-11T10:01:00Z', blockNumber: '100', transactionIndex: 1 };
    payload.trades[1] = { ...payload.trades[1], id: 'a-sell', timestamp: '2026-10-11T10:01:00Z', blockNumber: '100', transactionIndex: 2 };
    payload.trades.reverse();
    const replay = prepareTradeReplayData(payload, chart, position, now)!;
    expect(replay.trades.map(trade => trade.id)).toEqual(['z-buy', 'a-sell']); expect(replay.position.tradeFlowMatched).toBe(true);
    payload.trades[0].blockNumber = '101'; payload.trades[0].transactionIndex = 0;
    expect(prepareTradeReplayData(payload, chart, position, now)!.trades.map(trade => trade.id)).toEqual(['z-buy', 'a-sell']);
  });
  it('reconciles tiny quantities relatively instead of treating nonzero balances as zero', () => {
    const payload = activity(); payload.trades.forEach(trade => { trade.tokenAmount = '1e-12'; });
    expect(prepareTradeReplayData(payload, chart, position, now)!.position.tradeFlowMatched).toBe(true);
    expect(prepareTradeReplayData(payload, chart, { ...position, balance: '1e-12', status: 'Holding' }, now)!.position.tradeFlowMatched).toBe(false);
  });
  it('filters other wallets and exact contracts and withholds completeness when records are rejected', () => {
    const payload = activity(); payload.trades.push({ ...payload.trades[0], id: 'other', tokenAddress: wallet });
    const data = prepareTradeReplayData(payload, chart, position, now)!;
    expect(data.trades.map(trade => trade.id)).toEqual(['b', 's']); expect(data.source.tradesComplete).toBe(false);
    expect(prepareTradeReplayData(activity(), { ...chart, address: wallet }, position, now)!.chart.points).toHaveLength(0);
  });
  it('uses completed closes at interval end and interpolates market endpoints separately from execution prices', () => {
    const data = prepareTradeReplayData(activity(), chart, position, now)!;
    const opening = data.chart.points.find(point => point.timestamp === '2026-10-11T10:00:00.000Z')!;
    const close = data.chart.points.find(point => point.timestamp === '2026-10-11T10:05:00.000Z')!;
    const lastTrade = data.chart.points.find(point => Date.parse(point.timestamp) === Date.parse(data.trades[1].timestamp))!;
    expect(opening.priceUsd).toBe(2); expect(close.priceUsd).toBe(3);
    expect(lastTrade.priceUsd).toBeCloseTo(3.8); expect(data.trades[1].priceUsd).toBe(5);
    expect(lastTrade.marketCapUsd).toBeCloseTo(3800);
  });
  it('uses completed minute candles for a minute trade replay and preserves missing intervals', () => {
    const minute: TokenChart = { ...chart, period: '1m', resolution: '1m', candles: Array.from({ length: 10 }, (_, i) => ({
      ...chart.candles[0], time: chart.candles[0].time + i * 60, open: 2 + i, close: 3 + i,
    })) };
    const data = prepareTradeReplayData(activity(), minute, position, now)!;
    expect(data.source.chart).toBe('Historical market samples');
    expect(data.chart.points.find(point => Date.parse(point.timestamp) === Date.parse('2026-10-11T10:01:00Z'))?.priceUsd).toBe(3);
    expect(data.chart.points.at(-1)?.priceUsd).toBe(11);
    expect(prepareTradeReplayData(activity(), { ...minute, candles: minute.candles.filter((_, i) => i !== 4) }, position, now)!.source.chart).toBe('Recorded fills');
  });
  it('labels fill-only fallback when recent charts cannot cover the selected history', () => {
    const recent = { ...chart, candles: chart.candles.map(candle => ({ ...candle, time: candle.time + 3600 })) };
    const data = prepareTradeReplayData(activity(), recent, position, now)!;
    expect(data.chart.points).toEqual([]); expect(data.source.chart).toBe('Recorded fills');
  });
  it('orders completed candles and preserves closing timestamps independently of response order', () => {
    const data = prepareTradeReplayData(activity(), { ...chart, candles: [...chart.candles].reverse() }, position, now)!;
    expect(data.chart.points.map(point => [point.timestamp, point.priceUsd])).toEqual([
      ['2026-10-11T10:00:00.000Z', 2], ['2026-10-11T10:01:00Z', 2.2],
      ['2026-10-11T10:05:00.000Z', 3], ['2026-10-11T10:09:00Z', 3.8],
    ]);
  });
  it('uses an explicit fill-only replay when a missing interval separates the selected trades', () => {
    const payload = activity(); payload.trades[1].timestamp = '2026-10-11T10:14:00Z';
    const missing = { ...chart, candles: [chart.candles[0], { ...chart.candles[1], time: chart.candles[1].time + 300 }] };
    const data = prepareTradeReplayData(payload, missing, position, now)!;
    expect(data.chart.points).toEqual([]); expect(data.source.chart).toBe('Recorded fills');
    expect(data.trades).toHaveLength(2);
  });
  it('keeps a contiguous selected trade window when unrelated older or later candles are separated by gaps', () => {
    const other = { ...chart.candles[0], time: chart.candles[0].time - 3600, open: 99, close: 100 };
    const later = { ...other, time: chart.candles[1].time + 3600 };
    const data = prepareTradeReplayData(activity(), { ...chart, candles: [later, chart.candles[1], other, chart.candles[0]] }, null, now)!;
    expect(data.source.chart).toBe('Historical market samples');
    expect(data.chart.points.some(point => point.priceUsd >= 99)).toBe(false);
    expect(data.chart.points.at(-1)?.timestamp).toBe('2026-10-11T10:09:00Z');
  });
  it('ends open and unknown-balance recaps at the final recorded trade rather than a later market quote', () => {
    const later = { ...chart.candles[1], time: chart.candles[1].time + 300, close: 50 };
    for (const selectedPosition of [null, { ...position, status: 'Holding' as const, balance: '50' }]) {
      const data = prepareTradeReplayData(activity(), { ...chart, candles: [...chart.candles, later] }, selectedPosition, now)!;
      expect(data.chart.points.at(-1)?.timestamp).toBe('2026-10-11T10:09:00Z');
      expect(data.chart.points.at(-1)?.priceUsd).toBeCloseTo(3.8);
      expect(data.chart.points.every(point => Date.parse(point.timestamp) <= Date.parse(data.trades.at(-1)!.timestamp))).toBe(true);
    }
  });
  it('does not use an unfinished candle close to project a market price through the latest fill', () => {
    const current = Date.parse('2026-10-11T10:09:30Z');
    const data = prepareTradeReplayData(activity(), chart, { ...position, checkedAt: new Date(current).toISOString() }, current)!;
    expect(data.chart.points).toEqual([]); expect(data.source.chart).toBe('Recorded fills');
  });
  it('rejects future executions and withholds complete accounting for rejected records', () => {
    const payload = activity(); payload.trades[1].timestamp = new Date(now + 1000).toISOString();
    const data = prepareTradeReplayData(payload, chart, position, now)!;
    expect(data.trades.map(trade => trade.id)).toEqual(['b']);
    expect(data.position.tradesComplete).toBe(false); expect(data.position.tradeFlowMatched).toBe(false);
  });
  it('uses codec-appropriate extensions and safe bounded file names', () => {
    expect(replayFileName('Trader / TOKEN', 'video/mp4')).toBe('trader-token-trade-replay.mp4');
    expect(replayFileName('Trader / TOKEN', 'video/webm;codecs=vp9')).toBe('trader-token-trade-replay.webm');
  });
});

function canvasStub(drawn?: string[], dashes?: number[][]): HTMLCanvasElement {
  const context = new Proxy({}, { get: (_target, key) => key === 'measureText' ? (value: string) => ({ width: value.length * 20 })
    : key === 'fillText' ? (value: string) => drawn?.push(value)
    : key === 'setLineDash' ? (value: number[]) => dashes?.push(value)
    : key === 'createLinearGradient' ? () => ({ addColorStop() {} }) : () => undefined });
  return { width: 0, height: 0, getContext: () => context } as unknown as HTMLCanvasElement;
}

describe('replay renderer accounting and chart', () => {
  it('shows cash profit after a reconciled closed trade and adds exact fill anchors to the sampled recap', async () => {
    const data = prepareTradeReplayData(activity(), chart, position, now)!;
    const renderer = new ReplayCanvas(canvasStub()); await renderer.setData(data);
    expect(renderer.snapshot(1).pnl).toBeCloseTo(400);
    expect(renderer.snapshot(1).roi).toBeCloseTo(4);
    expect(renderer.snapshot(1).currentCap).toBeCloseTo(5000);
    const internals = renderer as unknown as { plotPoints: { priceUsd: number; kind: string }[] };
    expect(internals.plotPoints.some(point => point.kind === 'market')).toBe(true);
    expect(internals.plotPoints.some(point => point.kind === 'fill' && point.priceUsd === 5)).toBe(true);
  });
  it('withholds P&L for a stale balance even when observed swaps net to zero', async () => {
    const data = prepareTradeReplayData(activity(), chart, null, now)!;
    const renderer = new ReplayCanvas(canvasStub()); await renderer.setData(data);
    expect(renderer.snapshot(1).pnl).toBeNull(); expect(renderer.snapshot(1).status).toBe('Unknown');
  });
  it('preserves unpriced fill amounts and withholds incomplete investment instead of showing a zero total', async () => {
    const payload = activity(); payload.trades[0].amountUsd = null;
    const data = prepareTradeReplayData(payload, chart, position, now)!;
    const renderer = new ReplayCanvas(canvasStub()); await renderer.setData(data);
    const internals = renderer as unknown as { trades: { amountUsd: number | null; tokenAmount: number | null }[] };
    expect(internals.trades[0].amountUsd).toBeNull(); expect(renderer.snapshot(1).invested).toBeNull();
    expect(renderer.snapshot(1).avgEntryCap).toBeNull(); expect(renderer.snapshot(1).pnl).toBeNull();
    payload.coverage.complete = false;
    const partial = new ReplayCanvas(canvasStub()); await partial.setData(prepareTradeReplayData(payload, chart, position, now)!);
    expect(partial.snapshot(0).invested).toBeNull();
  });
  it('allows closed cash profit but withholds open marked profit in a fill-only replay', async () => {
    const payload = activity();
    const closed = new ReplayCanvas(canvasStub()); await closed.setData(prepareTradeReplayData(payload, null, position, now)!);
    expect(closed.snapshot(1).pnl).toBeCloseTo(400);
    payload.trades = payload.trades.slice(0, 1);
    const open = new ReplayCanvas(canvasStub()); await open.setData(prepareTradeReplayData(payload, null, { ...position, balance: '100' }, now)!);
    expect(open.snapshot(1).pnl).toBeNull();
  });
  it('retains distinct same-second executions in the explicitly fill-only replay', async () => {
    const payload = activity(); payload.trades[1].timestamp = payload.trades[0].timestamp; payload.trades[1].transactionIndex = 1;
    const renderer = new ReplayCanvas(canvasStub()); await renderer.setData(prepareTradeReplayData(payload, null, position, now)!);
    const internals = renderer as unknown as { storyVertices: { q: number; priceUsd: number }[] };
    expect(internals.storyVertices.map(point => point.priceUsd)).toEqual([1, 5]);
    expect(internals.storyVertices[1].q).toBeGreaterThan(internals.storyVertices[0].q);
    expect(renderer.snapshot(1).pnl).toBeCloseTo(400);
    expect(renderer.snapshot(1).time).toBe(new Date(payload.trades[1].timestamp).toISOString());
  });
  it('renders unavailable execution prices with a dash instead of a zero quote and omits the current-price guide', async () => {
    const payload = activity(); payload.trades.forEach(trade => { trade.valuationStatus = 'unpriced'; trade.amountUsd = null; trade.priceUsd = null; });
    const drawn: string[] = [], dashes: number[][] = [];
    const renderer = new ReplayCanvas(canvasStub(drawn, dashes)); await renderer.setData(prepareTradeReplayData(payload, null, position, now)!);
    drawn.length = 0; dashes.length = 0; renderer.render(1);
    expect(drawn).toContain('Execution prices unavailable'); expect(drawn).toContain('—');
    expect(drawn.some(value => /^\$0(?:\.0+)?$/.test(value))).toBe(false);
    expect(dashes).not.toContainEqual([12, 13]);
  });
  it('shows separately labelled backend realized profit with an unknown balance while keeping gross P&L withheld', async () => {
    const payload = activity(); payload.summary.realizedProfitUsd = '400'; payload.trades[1].cumulativeRealizedProfitUsd = '400';
    const drawn: string[] = [], renderer = new ReplayCanvas(canvasStub(drawn));
    await renderer.setData(prepareTradeReplayData(payload, chart, { ...position, checkedAt: new Date(now - 200000).toISOString() }, now)!);
    expect(renderer.snapshot(0).realizedPnl).toBe(0);
    expect(renderer.snapshot(1).pnl).toBeNull(); expect(renderer.snapshot(1).realizedPnl).toBe(400);
    expect(renderer.snapshot(1).realizedRoi).toBe(4);
    drawn.length = 0; renderer.render(1);
    expect(drawn).toContain('REALIZED P&L'); expect(drawn).toContain('+$400.00'); expect(drawn).toContain('RECORDED TRADES');
    expect(drawn).not.toContain('UNKNOWN');
  });
  it('uses cumulative realized results per revealed sale, including negative profits', async () => {
    const payload = activity(); payload.summary.realizedProfitUsd = '-20';
    payload.trades[1] = { ...payload.trades[1], id: 'sell-first', amountUsd: '40', tokenAmount: '50', cumulativeRealizedProfitUsd: '-10' };
    payload.trades.push({ ...payload.trades[1], id: 'sell-last', timestamp: '2026-10-11T10:09:30Z', cumulativeRealizedProfitUsd: '-20' });
    const renderer = new ReplayCanvas(canvasStub()); await renderer.setData(prepareTradeReplayData(payload, chart, null, now)!);
    expect(renderer.snapshot(renderer.eventProgress(1)).realizedPnl).toBe(-10);
    expect(renderer.snapshot(1).realizedPnl).toBe(-20); expect(renderer.snapshot(1).realizedRoi).toBe(-.2);
    expect(replaySignedNumber('-20')).toBe(-20); expect(replaySignedNumber('0')).toBe(0); expect(replaySignedNumber(' ')).toBeNull();
  });
  it('withholds realized fallback for missing full summary, incomplete coverage, or unmatched cumulative sale results', async () => {
    for (const variant of ['summary', 'coverage', 'sale'] as const) {
      const payload = activity(); payload.summary.realizedProfitUsd = '400'; payload.trades[1].cumulativeRealizedProfitUsd = '400';
      if (variant === 'summary') payload.summary.realizedProfitUsd = null;
      if (variant === 'coverage') payload.coverage.complete = false;
      if (variant === 'sale') payload.trades[1].cumulativeRealizedProfitUsd = null;
      const renderer = new ReplayCanvas(canvasStub()); await renderer.setData(prepareTradeReplayData(payload, chart, null, now)!);
      expect(renderer.snapshot(1).pnl).toBeNull(); expect(renderer.snapshot(1).realizedPnl).toBeNull(); expect(renderer.snapshot(1).realizedRoi).toBeNull();
    }
  });
  it('withholds realized ROI if the invested total is missing', async () => {
    const payload = activity(); payload.summary.realizedProfitUsd = '400'; payload.trades[1].cumulativeRealizedProfitUsd = '400'; payload.trades[0].amountUsd = null;
    const renderer = new ReplayCanvas(canvasStub()); await renderer.setData(prepareTradeReplayData(payload, chart, null, now)!);
    expect(renderer.snapshot(1).realizedPnl).toBe(400); expect(renderer.snapshot(1).realizedRoi).toBeNull();
  });
});
