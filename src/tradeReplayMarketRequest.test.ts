import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReplayMarketChart } from '../shared/replayChart';
import type { TradeReplayData } from './tradeReplayData';
import { recordedPriceEstimateNotice, replayMarketData, replayUsesRecordedPrices } from './tradeReplayMarketRequest';

const token = '0x2222222222222222222222222222222222222222';
const now = Date.parse('2026-10-11T12:00:00Z');

function data(): TradeReplayData {
  return {
    kol: { address: '0x1111111111111111111111111111111111111111', name: 'Trader', avatarUrl: null, twitter: null },
    token: { address: token, symbol: 'TEST', name: 'Test', logoUrl: null, priceUsd: 9, marketCapUsd: 9000 },
    trades: [
      { id: 'buy', txHash: 'buy', timestamp: '2026-10-11T10:01:15Z', side: 'buy', tokenAmount: 1, amountUsd: 1, priceUsd: 1, marketCapUsd: 1000 },
      { id: 'sell', txHash: 'sell', timestamp: '2026-10-11T10:09:45Z', side: 'sell', tokenAmount: 1, amountUsd: 5, priceUsd: 5, marketCapUsd: 5000 },
    ],
    position: { status: 'unknown', tokenBalance: null, tradeFlowMatched: false, tradesComplete: true, checkedAt: null },
    chart: { points: [], marketCapSupply: 1000, resolution: '5m', source: 'Recorded fills' },
    source: { chart: 'Recorded fills', tradesComplete: true }, realizedAccounting: { available: true }, generatedAt: new Date(now).toISOString(),
  };
}

function chart(): ReplayMarketChart {
  return {
    address: token, period: 'replay', candles: [],
    points: Array.from({ length: 11 }, (_, minute) => ({ timestamp: new Date(Date.parse('2026-10-11T10:00:00Z') + minute * 60000).toISOString(), priceUsd: String(1 + minute) })),
    source: 'gmgn', resolution: '1m', marketCapSupply: '1000', pending: false, stale: false, updatedAt: new Date(now).toISOString(),
  };
}

function deferredChart(loadStatus?: 'queued' | 'rate_limited', retryAfterMs = 3000): ReplayMarketChart {
  return { ...chart(), source: 'unavailable', points: [], updatedAt: null, loadStatus, retryAfterMs };
}

function response(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('bounded replay historical-market preparation', () => {
  it('waits through queued and rate-limited responses before applying genuine history without changing accounting', async () => {
    const original = data();
    const fetcher = vi.fn().mockResolvedValueOnce(response(deferredChart('queued', 3000)))
      .mockResolvedValueOnce(response(deferredChart('rate_limited', 2000))).mockResolvedValue(response(chart()));
    vi.stubGlobal('fetch', fetcher);
    const pending = replayMarketData(original, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(2999); expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); expect(fetcher).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1999); expect(fetcher).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    const result = await pending;
    expect(fetcher).toHaveBeenCalledTimes(3); expect(result.notice).toBeNull();
    expect(result.data.chart.resolution).toBe('1m'); expect(result.data.chart.points.at(-1)?.timestamp).toBe('2026-10-11T10:09:45.000Z');
    expect(result.data.trades).toBe(original.trades); expect(result.data.position).toBe(original.position);
    expect(result.data.realizedAccounting).toBe(original.realizedAccounting);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds repeated queue deferrals and uses at least a one-second delay', async () => {
    const original = data();
    const fetcher = vi.fn().mockResolvedValue(response(deferredChart('queued', 1)));
    vi.stubGlobal('fetch', fetcher);
    const pending = replayMarketData(original, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(4999); expect(fetcher).toHaveBeenCalledTimes(5);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual({ data: original, notice: 'Historical market data is still loading; the replay is using available data.' });
    expect(fetcher).toHaveBeenCalledTimes(6); expect(vi.getTimerCount()).toBe(0);
  });

  it('reports a cooldown beyond the remaining session budget without shortening it or sending more requests', async () => {
    const original = data(), fetcher = vi.fn().mockResolvedValue(response(deferredChart('rate_limited', 30_000)));
    vi.stubGlobal('fetch', fetcher);
    const result = await replayMarketData(original, new AbortController().signal);
    expect(result).toEqual({ data: original, notice: 'Historical market data is rate limited; the replay is using available data.' });
    expect(fetcher).toHaveBeenCalledOnce(); expect(Date.now()).toBe(now); expect(vi.getTimerCount()).toBe(0);
  });

  it('does not retry permanently missing or partial history despite a retryAfterMs field', async () => {
    for (const body of [deferredChart(undefined, 1000), { ...chart(), partialHistory: true }]) {
      const original = data(), fetcher = vi.fn().mockResolvedValue(response(body));
      vi.stubGlobal('fetch', fetcher);
      const result = await replayMarketData(original, new AbortController().signal);
      expect(result.data).toBe(original); expect(result.notice).toMatch(/unavailable/);
      expect(fetcher).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
    }
  });

  it('discloses recorded-price estimates only when the retained replay has fill-only or empty chart data', async () => {
    const fallback = data();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(deferredChart())));
    const result = await replayMarketData(fallback, new AbortController().signal);
    expect(result.notice).toBe(recordedPriceEstimateNotice); expect(replayUsesRecordedPrices(result.data)).toBe(true);

    const genuine = data();
    genuine.source.chart = genuine.chart.source = 'Historical market samples';
    genuine.chart.points = [{ timestamp: '2026-10-11T10:01:15Z', priceUsd: 1, marketCapUsd: 1000 }];
    const retained = await replayMarketData(genuine, new AbortController().signal);
    expect(retained.data).toBe(genuine); expect(replayUsesRecordedPrices(retained.data)).toBe(false);
    expect(retained.notice).toBe('Historical market data is unavailable for this replay.');
    genuine.chart.points = [];
    expect(replayUsesRecordedPrices(genuine)).toBe(true);
  });

  it('accepts sparse observations bracketing the trade window and discloses interpolated estimates', async () => {
    const original = data(), observed = chart();
    observed.points = [observed.points[0], observed.points[6], observed.points[10]];
    observed.sparseHistory = true;
    const fetcher = vi.fn().mockResolvedValue(response(observed)); vi.stubGlobal('fetch', fetcher);
    const result = await replayMarketData(original, new AbortController().signal);
    expect(result.data).not.toBe(original); expect(result.data.trades).toBe(original.trades);
    expect(result.data.position).toBe(original.position); expect(result.data.realizedAccounting).toBe(original.realizedAccounting);
    expect(result.data.chart.source).toBe('GMGN historical samples'); expect(replayUsesRecordedPrices(result.data)).toBe(false);
    expect(result.notice).toBe('Market observations are sparse. Prices and P&L between observations are estimates.');
    expect(fetcher).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });

  it('terminates bad-address and missing-pair HTTP responses and does not request malformed addresses', async () => {
    for (const status of [400, 404]) {
      const original = data(), fetcher = vi.fn().mockResolvedValue(response({ error: 'Unavailable' }, status));
      vi.stubGlobal('fetch', fetcher);
      expect((await replayMarketData(original, new AbortController().signal)).data).toBe(original);
      expect(fetcher).toHaveBeenCalledOnce();
    }
    const invalid = data(); invalid.token.address = 'invalid';
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    await expect(replayMarketData(invalid, new AbortController().signal)).rejects.toThrow('Invalid KOL or token address');
    expect(fetcher).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels retry waiting on modal close and never starts the deferred request', async () => {
    const fetcher = vi.fn().mockResolvedValue(response(deferredChart('queued', 3000)));
    vi.stubGlobal('fetch', fetcher);
    const controller = new AbortController();
    const pending = replayMarketData(data(), controller.signal);
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(1000); controller.abort();
    await rejected; await vi.advanceTimersByTimeAsync(30_000);
    expect(fetcher).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels a hung fetch even if the fetch implementation ignores its abort signal', async () => {
    const fetcher = vi.fn().mockImplementation(() => new Promise<Response>(() => {}));
    vi.stubGlobal('fetch', fetcher);
    const controller = new AbortController(), pending = replayMarketData(data(), controller.signal);
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort(); await rejected;
    expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true); expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps the entire preparation bounded to 22 seconds including a stalled JSON response', async () => {
    const original = data();
    const fetcher = vi.fn().mockResolvedValue({ ok: true, status: 200, json: () => new Promise(() => {}) });
    vi.stubGlobal('fetch', fetcher);
    const pending = replayMarketData(original, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(22_000);
    expect(await pending).toEqual({ data: original, notice: 'Historical market data timed out; the replay is using available data.' });
    expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true); expect(vi.getTimerCount()).toBe(0);
  });

  it('reports network, non-transient HTTP, and mismatched-response errors instead of silently burying them', async () => {
    for (const fetcher of [
      vi.fn().mockRejectedValue(new TypeError('Network error')),
      vi.fn().mockResolvedValue(response(chart(), 502)),
      vi.fn().mockResolvedValue(response({ ...deferredChart('queued'), address: data().kol.address })),
    ]) {
      const original = data(); vi.stubGlobal('fetch', fetcher);
      expect(await replayMarketData(original, new AbortController().signal)).toEqual({ data: original, notice: 'Historical market data could not be loaded; the replay is using available data.' });
      expect(fetcher).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
    }
  });
});
