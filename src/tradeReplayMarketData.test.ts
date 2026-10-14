import { describe, expect, it } from 'vitest';
import { applyReplayMarketChart, replayEndTimestamp, type TradeReplayData } from './tradeReplayData';
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
  it('covers and trims a closed replay through its last transfer rather than stopping at the final sale', () => {
    const original = data(); original.position.status = 'closed';
    original.inventory = { version: 1, coverage: { complete: true, reconciled: true, fromBlock: '1', toBlock: '3',
      blockHash: `0x${'f'.repeat(64)}`, checkedAt: new Date(now).toISOString(), balance: '0' }, events: [
      { id: 'out', kind: 'transfer_out', txHash: `0x${'c'.repeat(64)}`, timestamp: '2026-10-11T10:11:30Z', blockNumber: '3',
        transactionIndex: 0, logIndex: 1, tokenAmount: .5, remainingTokenAmount: 0, remainingCostBasisUsd: 0,
        cumulativeRealizedProfitUsd: 2, investedUsd: 1, soldUsd: 2.5 },
    ] };
    expect(applyReplayMarketChart(original, chart(), now)).toBe(original);
    const observed = chart();
    observed.points.push({ timestamp: '2026-10-11T10:15:00Z', priceUsd: '21' });
    observed.currentQuote = { timestamp: new Date(now).toISOString(), priceUsd: '99' };
    const replay = applyReplayMarketChart(original, observed, now);
    expect(replay.chart.points.at(-1)?.timestamp).toBe('2026-10-11T10:11:30.000Z');
    expect(replayEndTimestamp(replay)).toBe(Date.parse('2026-10-11T10:11:30Z'));
    expect(replay.currentQuote).toBeUndefined(); expect(replay.trades).toBe(original.trades); expect(replay.inventory).toBe(original.inventory);
  });

  it('rejects a current quote before the latest wallet movement even when it follows every recorded swap', () => {
    const original = data(); original.position.status = 'open';
    original.inventory = { version: 1, coverage: { complete: true, reconciled: true, fromBlock: '1', toBlock: '3',
      blockHash: `0x${'f'.repeat(64)}`, checkedAt: new Date(now).toISOString(), balance: '.5' }, events: [
      { id: 'in', kind: 'transfer_in', txHash: `0x${'c'.repeat(64)}`, timestamp: '2026-10-11T11:59:30Z', blockNumber: '3',
        transactionIndex: 0, logIndex: 1, tokenAmount: .5, remainingTokenAmount: .5, remainingCostBasisUsd: null,
        cumulativeRealizedProfitUsd: 4, investedUsd: 1, soldUsd: 5 },
    ] };
    const observed = { ...chart(), source: 'unavailable' as const, points: [],
      currentQuote: { timestamp: '2026-10-11T11:59:00Z', priceUsd: '12' } };
    expect(applyReplayMarketChart(original, observed, now).currentQuote).toBeUndefined();
    expect(applyReplayMarketChart(original, { ...observed, currentQuote: { timestamp: new Date(now).toISOString(), priceUsd: '12' } }, now).currentQuote?.priceUsd).toBe(12);
  });

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

  it('retains open post-fill observations up to a separate genuine current quote without changing trade accounting', () => {
    const original = data(); original.trades[1].tokenAmount = .5;
    const observed = chart();
    observed.points.push(
      { timestamp: '2026-10-11T11:58:00Z', priceUsd: '10' },
      { timestamp: '2026-10-11T11:59:30Z', priceUsd: '50' },
    );
    observed.currentQuote = { timestamp: '2026-10-11T11:59:00Z', priceUsd: '12' };
    const replay = applyReplayMarketChart(original, observed, now);
    expect(replay.trades).toBe(original.trades); expect(replay.position).toBe(original.position);
    expect(replay.realizedAccounting).toBe(original.realizedAccounting); expect(replay.trades).toHaveLength(2);
    expect(replay.chart.points.at(-1)?.timestamp).toBe('2026-10-11T11:58:00.000Z');
    expect(replay.chart.points.some(point => point.priceUsd === 50)).toBe(false);
    expect(replay.currentQuote).toEqual({ timestamp: '2026-10-11T11:59:00.000Z', priceUsd: 12, marketCapUsd: 12000 });
    expect(replay.chart.points.some(point => point.timestamp === replay.currentQuote!.timestamp)).toBe(false);
  });

  it('keeps closed histories ending at the final fill and ignores a current quote returned by the server', () => {
    const original = data(), observed = chart();
    observed.currentQuote = { timestamp: new Date(now).toISOString(), priceUsd: '99' };
    observed.points.push({ timestamp: new Date(now - 60_000).toISOString(), priceUsd: '50' });
    const replay = applyReplayMarketChart(original, observed, now);
    expect(replay.currentQuote).toBeUndefined();
    expect(replay.chart.points.at(-1)?.timestamp).toBe('2026-10-11T10:09:45.000Z');
    expect(replay.chart.points.some(point => point.priceUsd === 50)).toBe(false);
  });

  it('accepts a fresh current endpoint even when history is unavailable without calling fills historical observations', () => {
    const original = data(); original.trades[1].tokenAmount = .5;
    const unavailable = { ...chart(), source: 'unavailable' as const, points: [], currentQuote: { timestamp: new Date(now).toISOString(), priceUsd: '12' } };
    const replay = applyReplayMarketChart(original, unavailable, now);
    expect(replay.chart.source).toBe('Recorded fills'); expect(replay.source.chart).toBe('Recorded fills');
    expect(replay.chart.points).toEqual([]); expect(replay.trades).toBe(original.trades);
    expect(replay.currentQuote?.marketCapUsd).toBe(12000);
    expect(replay.token.priceUsd).toBe(9);
    const retained = { ...original, chart: { ...original.chart, source: 'Historical market samples', points: [
      { timestamp: '2026-10-11T11:58:00Z', priceUsd: 10, marketCapUsd: 10000 },
      { timestamp: '2026-10-11T12:00:00Z', priceUsd: 20, marketCapUsd: 20000 },
    ] } };
    const earlierQuote = { ...unavailable, currentQuote: { timestamp: '2026-10-11T11:59:00Z', priceUsd: '12' } };
    expect(applyReplayMarketChart(retained, earlierQuote, now).chart.points.map(point => point.priceUsd)).toEqual([10]);
  });

  it('rejects stale, future, pre-fill or invalid current quotes rather than reusing activity snapshot prices', () => {
    const original = data(); original.trades[1].tokenAmount = .5;
    for (const currentQuote of [
      { timestamp: new Date(now - 180_001).toISOString(), priceUsd: '12' },
      { timestamp: new Date(now + 1).toISOString(), priceUsd: '12' },
      { timestamp: '2026-10-11T10:00:00Z', priceUsd: '12' },
      { timestamp: new Date(now).toISOString(), priceUsd: '0' },
      { timestamp: 'invalid', priceUsd: '12' },
    ]) {
      const replay = applyReplayMarketChart(original, { ...chart(), currentQuote }, now);
      expect(replay.currentQuote).toBeUndefined(); expect(replay.token.priceUsd).toBe(9);
    }
    const unknownSupply = { ...original, chart: { ...original.chart, marketCapSupply: null } };
    const replay = applyReplayMarketChart(unknownSupply, { ...chart(), marketCapSupply: null, currentQuote: { timestamp: new Date(now).toISOString(), priceUsd: '12' } }, now);
    expect(replay.currentQuote?.marketCapUsd).toBeNull();
  });

  it('discloses a gap from genuine old observations to the current quote for accepted and retained history', () => {
    const original = data(); original.trades[1].tokenAmount = .5;
    const observed = { ...chart(), currentQuote: { timestamp: new Date(now).toISOString(), priceUsd: '12' } };
    const accepted = applyReplayMarketChart(original, observed, now);
    expect(accepted.chart.sparseHistory).toBe(true);
    expect(accepted.chart.points.at(-1)?.timestamp).toBe('2026-10-11T10:10:00.000Z');

    const retained = { ...original, chart: { ...original.chart, source: 'Historical market samples', resolution: '1m', points: [
      { timestamp: '2026-10-11T11:50:00Z', priceUsd: 10, marketCapUsd: 10000 },
    ] } };
    const quoteOnly = { ...observed, source: 'unavailable' as const, points: [] };
    const fallback = applyReplayMarketChart(retained, quoteOnly, now);
    expect(fallback.chart.sparseHistory).toBe(true); expect(fallback.chart.points.map(point => point.priceUsd)).toEqual([10]);
    expect(retained.chart.sparseHistory).toBeUndefined();

    const recent = { ...retained, chart: { ...retained.chart, points: [
      { timestamp: '2026-10-11T11:59:00Z', priceUsd: 10, marketCapUsd: 10000 },
    ] } };
    expect(applyReplayMarketChart(recent, quoteOnly, now).chart.sparseHistory).not.toBe(true);
    expect(applyReplayMarketChart({ ...recent, chart: { ...recent.chart, sparseHistory: true } }, quoteOnly, now).chart.sparseHistory).toBe(true);
  });
});
