import { describe, expect, it } from 'vitest';
import { applyReplayMarketChart, type TradeReplayData } from './tradeReplayData';
import type { ReplayMarketChart } from '../shared/replayChart';

const token = '0x2222222222222222222222222222222222222222';
const now = Date.parse('2026-10-11T12:00:00Z');
function data(): TradeReplayData {
  return {
    kol: { address: '0x1111111111111111111111111111111111111111', name: 'Trader', avatarUrl: null, twitter: null },
    token: { address: token, symbol: 'TEST', name: 'Test', logoUrl: null, priceUsd: 9, marketCapUsd: 9000 },
    trades: [{ id: 'b', txHash: 'b', timestamp: '2026-10-11T10:01:15Z', side: 'buy', tokenAmount: 1, amountUsd: 1, priceUsd: 1, marketCapUsd: 1000 },
      { id: 's', txHash: 's', timestamp: '2026-10-11T10:09:45Z', side: 'sell', tokenAmount: 1, amountUsd: 5, priceUsd: 5, marketCapUsd: 5000 }],
    position: { status: 'unknown', tokenBalance: null, tradeFlowMatched: false, tradesComplete: true, checkedAt: null },
    chart: { points: [], marketCapSupply: 1000, resolution: '5m', source: 'Recorded fills' },
    source: { chart: 'Recorded fills', tradesComplete: true }, realizedAccounting: { available: true }, generatedAt: new Date(now).toISOString(),
  };
}
function chart(): ReplayMarketChart {
  return { address: token, period: 'replay', candles: [], points: Array.from({ length: 11 }, (_, minute) => ({ timestamp: new Date(Date.parse('2026-10-11T10:00:00Z') + minute * 60000).toISOString(), priceUsd: String(1 + minute) })),
    source: 'geckoterminal', resolution: '1m', marketCapSupply: '1000', pending: false, stale: false, updatedAt: new Date(now).toISOString() };
}
describe('finer observed replay history', () => {
  it('accepts genuine coarse observations covering a long replay and retains explicit sparse-history metadata', () => {
    const original = data();
    const observed = { ...chart(), resolution: '5m', sparseHistory: true,
      points: [chart().points[0], chart().points[5], chart().points[10]] };
    const replay = applyReplayMarketChart(original, observed, now);
    expect(replay).not.toBe(original);
    expect(replay.chart.resolution).toBe('5m'); expect(replay.chart.sparseHistory).toBe(true);
    expect(replay.trades).toBe(original.trades); expect(replay.realizedAccounting).toBe(original.realizedAccounting);
    expect(Date.parse(replay.chart.points.at(-1)!.timestamp)).toBe(Date.parse(original.trades.at(-1)!.timestamp));
    expect(replay.chart.points.at(-1)?.priceUsd).toBeCloseTo(10.75);
  });
  it('keeps the exact executions and accounting while bounding finer observed prices to the trade window', () => {
    const original = data();
    const replay = applyReplayMarketChart(original, chart(), now);
    expect(replay.trades).toBe(original.trades); expect(replay.position).toBe(original.position); expect(replay.realizedAccounting).toBe(original.realizedAccounting);
    expect(replay.chart.resolution).toBe('1m'); expect(replay.chart.points.at(-1)?.priceUsd).toBeCloseTo(10.75);
    expect(replay.chart.points.at(-1)?.marketCapUsd).toBeCloseTo(10750);
    expect(replay.chart.points.at(-1)?.timestamp).toBe('2026-10-11T10:09:45.000Z');
    expect(replay.chart.points[0].timestamp).toBe('2026-10-11T10:01:00.000Z');
  });
  it('retains the existing fallback for a wrong token, unavailable provider, partial history or uncovered first fill', () => {
    const original = data(), observed = chart();
    for (const invalid of [{ ...observed, address: original.kol.address }, { ...observed, source: 'unavailable' as const }, { ...observed, partialHistory: true }, { ...observed, points: observed.points.slice(2) }]) {
      expect(applyReplayMarketChart(original, invalid, now)).toBe(original);
    }
  });
  it('keeps missing supply unknown instead of inferring it from a later token quote', () => {
    const original = data(); original.chart.marketCapSupply = null;
    const replay = applyReplayMarketChart(original, { ...chart(), marketCapSupply: null }, now);
    expect(replay.chart.marketCapSupply).toBeNull(); expect(replay.chart.points.every(point => point.marketCapUsd === null)).toBe(true);
    expect(replay.position.status).toBe('unknown'); expect(replay.position.tradeFlowMatched).toBe(false);
  });
});
