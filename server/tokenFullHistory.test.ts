import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFullMarketCharts } from './tokenFullHistory.js';
import { createTokenHistoryArchive, historyArchiveCursor, mergeHistoryCoverage, type HistoryManifest } from './tokenChartHistoryArchive.js';
import { MarketProviderDeferred } from './geckoApi.js';
import type { MarketCandle, TokenChart } from '../shared/intelligence.js';

const address = '0x' + '1'.repeat(40), now = 2_000_000_000_000;
const time = Math.floor(now / 60_000) * 60;
const candle = (time: number, close = 1.5): MarketCandle => ({ time, open: 1, high: 2, low: .5, close, volume: 10 });
const bars = (count: number, until = time) => Array.from({ length: count }, (_, index) => candle(until - (count - index - 1) * 60));
const gmgn = (candles: MarketCandle[]) => ({ code: 0, data: { list: candles.map(c => ({ ...c, time: c.time * 1000, amount: 7 })) } });
function storage() {
  const files = new Map<string, string>();
  const missing = () => Object.assign(new Error('Missing test file'), { code: 'ENOENT' });
  const io = { mkdir: vi.fn(async () => {}), stat: vi.fn(async (file: string) => {
    const data = files.get(file); if (data === undefined) throw missing(); return { size: data.length };
  }), readFile: vi.fn(async (file: string) => { const data = files.get(file); if (data === undefined) throw missing(); return data; }),
  writeFile: vi.fn(async (file: string, text: string) => { files.set(file, text); }),
  rename: vi.fn(async (from: string, to: string) => { files.set(to, files.get(from)!); files.delete(from); }) };
  return { files, io, archive: createTokenHistoryArchive('test-full-history', io as any) };
}
const manifest = (): HistoryManifest => ({ version: 1, address, interval: '1m', updatedAt: null, complete: false, volumeCurrency: 'usd', chunks: [], coverage: [] });
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); });
afterEach(() => vi.useRealTimers());

describe('bounded history chunks and scanned coverage', () => {
  it('retains more than 1000 genuine minute bars older than 24h across restarts without rewriting unchanged chunks', async () => {
    const { archive, io } = storage(), meta = manifest(), candles = bars(2600);
    await archive.savePage(meta, candles, { latest: true, coverage: [candles[0].time, now / 1000] });
    const chunkWrites = () => io.writeFile.mock.calls.filter(([file]) => /[\\/]\d+\.json\./.test(file)).length;
    const writes = chunkWrites();
    await archive.savePage(meta, candles, { latest: true, coverage: [candles[0].time, now / 1000] });
    expect(chunkWrites()).toBe(writes);
    const restored = (await archive.loadManifest(address, '1m'))!;
    expect(await archive.readBefore(restored, now / 1000 + 1, 3000)).toEqual(candles);
    expect(restored.complete).toBe(false);
    await archive.savePage(restored, [], { coverage: [1, candles[0].time - 1] });
    expect((await archive.loadManifest(address, '1m'))?.complete).toBe(true);
  });
  it('does not trust a stale complete flag or an off-cursor empty response across an uncovered middle gap', () => {
    const meta = { ...manifest(), latestTo: 1000, coverage: [[1, 100], [900, 1000]] as [number, number][] };
    expect(historyArchiveCursor(meta)).toBe(900);
    expect(mergeHistoryCoverage(meta.coverage, [1, 10])).toEqual([[1, 100], [900, 1000]]);
    expect(mergeHistoryCoverage(meta.coverage, [100, 899])).toEqual([[1, 1000]]);
  });
  it('rejects damaged chunk contents instead of treating them as a successful empty history page', async () => {
    const { archive, files } = storage(), meta = manifest();
    await archive.savePage(meta, bars(10), { latest: true, coverage: [time - 540, now / 1000] });
    const file = [...files.keys()].find(file => /[\\/]\d+\.json$/.test(file))!;
    files.set(file, JSON.stringify([[time, 1, .5, .5, 1.5, 10]]));
    await expect(archive.readBefore(meta, now / 1000 + 1)).rejects.toThrow('Invalid history');
  });
});

describe('progressive full token charts', () => {
  function setup(candles = bars(2600), snapshotLimit = 1000) {
    const disk = storage();
    const dataset = { candles };
    const request = vi.fn(async (url: URL) => {
      expect(url.searchParams.get('from')).toBe('1000');
      expect(url.searchParams.get('timestamp')).toBe(String(Math.floor(Date.now() / 1000)));
      const until = Math.floor(Number(url.searchParams.get('to')) / 1000);
      return gmgn(dataset.candles.filter(c => c.time <= until).slice(-100));
    });
    const options = { request, archive: disk.archive, apiKey: () => 'test-chart-key', snapshotLimit, fallback: vi.fn(async () => null) };
    return { ...disk, dataset, request, options, service: createFullMarketCharts(options) };
  }
  it('returns the latest page first, pages past 24h/1000 bars, and resumes archived history beyond its bounded memory snapshot', async () => {
    const { service, request, options } = setup();
    const first = await service(address, '1m');
    expect(first.chart).toMatchObject({ fullHistory: true, volumeCurrency: 'usd', historyComplete: false, historyPending: true });
    expect(first.chart.candles).toHaveLength(100); expect(request).toHaveBeenCalledOnce();
    let before = first.chart.historyBefore!, complete = false;
    const retained = new Map(first.chart.candles.map(c => [c.time, c]));
    for (let count = 0; count < 30 && !complete; count++) {
      const result = await service(address, '1m', 'prefetch', before);
      for (const c of result.chart.candles) retained.set(c.time, c);
      before = result.chart.historyBefore!; complete = !!result.chart.historyComplete;
    }
    expect(complete).toBe(true); expect(retained.size).toBe(2600);
    const calls = request.mock.calls.length;
    const restarted = createFullMarketCharts(options);
    const snapshot = (await restarted(address, '1m')).chart;
    expect(snapshot.candles).toHaveLength(1000); expect(snapshot.historyComplete).toBe(false);
    expect(snapshot.historyBefore).toBe(snapshot.candles[0].time);
    const previous = (await restarted(address, '1m', 'prefetch', snapshot.historyBefore)).chart;
    expect(previous.candles).toHaveLength(1000); expect(previous.historyComplete).toBe(false);
    const earliest = (await restarted(address, '1m', 'prefetch', previous.historyBefore)).chart;
    expect(earliest.candles).toHaveLength(600); expect(earliest.historyComplete).toBe(true);
    expect(request).toHaveBeenCalledTimes(calls);
  });
  it('coalesces identical backward requests and gives historical pages background priority', async () => {
    const { service, request } = setup(bars(200));
    const first = await service(address, '1m');
    let finish!: (value: ReturnType<typeof gmgn>) => void;
    request.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const one = service(address, '1m', 'chart', first.chart.historyBefore);
    const two = service(address, '1m', 'chart', first.chart.historyBefore);
    await vi.advanceTimersByTimeAsync(0);
    expect(request).toHaveBeenCalledTimes(2);
    expect((request.mock.calls[1] as unknown[])[1]).toMatchObject({ priority: 'prefetch' });
    finish(gmgn(bars(100, first.chart.candles[0].time - 60)));
    expect((await one).chart.candles).toEqual((await two).chart.candles);
  });
  it('pins concurrent cold states beyond the LRU size until their coalesced latest jobs settle', async () => {
    const { options } = setup(bars(100));
    const waiting = new Map<string, (value: ReturnType<typeof gmgn>) => void>();
    const request = vi.fn((url: URL) => new Promise<ReturnType<typeof gmgn>>(resolve => { waiting.set(url.searchParams.get('address')!, resolve); }));
    const service = createFullMarketCharts({ ...options, request });
    const addresses = Array.from({ length: 6 }, (_, index) => '0x' + String(index + 1).repeat(40));
    const jobs = addresses.map(token => service(token, '1m'));
    await vi.advanceTimersByTimeAsync(0);
    const joined = service(addresses[5], '1m');
    await vi.advanceTimersByTimeAsync(0);
    expect(request).toHaveBeenCalledTimes(6);
    for (const finish of waiting.values()) finish(gmgn(bars(100)));
    const results = await Promise.all(jobs);
    expect((await joined).chart.candles).toEqual(results[5].chart.candles);
    expect((await joined).chart.candles).toHaveLength(100);
  });
  it('keeps prices and the unfinished cursor through a historical cooldown', async () => {
    const { service, request } = setup(bars(200));
    const first = await service(address, '1m');
    request.mockRejectedValueOnce(new MarketProviderDeferred('rate_limited', 90_000));
    const failed = (await service(address, '1m', 'prefetch', first.chart.historyBefore)).chart;
    expect(failed).toMatchObject({ candles: [], historyComplete: false, historyPending: false, historyLoadStatus: 'rate_limited', historyRetryAfterMs: 90_000 });
    expect((await service(address, '1m')).chart.candles).toEqual(first.chart.candles);
    await service(address, '1m', 'prefetch', first.chart.historyBefore);
    expect(request).toHaveBeenCalledTimes(2);
  });
  it('fills the offline refresh middle gap before claiming full history, and ignores arbitrary before=1 exhaustion', async () => {
    const { service, request, dataset } = setup(bars(200), 20_000);
    let current = (await service(address, '1m')).chart;
    await service(address, '1m', 'prefetch', 1);
    expect((await service(address, '1m')).chart.historyComplete).toBe(false);
    for (let count = 0; count < 4 && !current.historyComplete; count++) current = (await service(address, '1m', 'prefetch', current.historyBefore)).chart;
    expect(current.historyComplete).toBe(true);
    await vi.advanceTimersByTimeAsync(480 * 60_000);
    dataset.candles = [...dataset.candles, ...bars(480, time + 480 * 60)];
    await service(address, '1m'); await vi.advanceTimersByTimeAsync(0);
    current = (await service(address, '1m')).chart;
    expect(current.historyComplete).toBe(false);
    expect(current.historyBefore).toBeGreaterThan(current.candles[0].time);
    let restored = new Map(current.candles.map(c => [c.time, c]));
    for (let count = 0; count < 8 && !current.historyComplete; count++) {
      current = (await service(address, '1m', 'prefetch', current.historyBefore)).chart;
      for (const c of current.candles) restored.set(c.time, c);
    }
    expect(current.historyComplete).toBe(true); expect(restored.size).toBe(680);
    expect(request.mock.calls.length).toBeGreaterThan(5);
  });
  it('marks fallback history limited and replaces fallback bars/units when authentic GMGN history recovers', async () => {
    const { options, request } = setup(bars(100));
    const alternative: TokenChart = { address, period: '1m', resolution: '1m', source: 'coinmarketcap', volumeCurrency: 'unknown',
      candles: [candle(time - 50_000, 1.75)], points: [], updatedAt: new Date(now).toISOString(), pending: false, stale: false };
    request.mockRejectedValueOnce(new Error('Unavailable'));
    const service = createFullMarketCharts({ ...options, fallback: vi.fn(async () => alternative) });
    expect((await service(address, '1m')).chart).toMatchObject({ source: 'coinmarketcap', historyPending: false, historyLoadStatus: 'limited', volumeCurrency: 'unknown' });
    await vi.advanceTimersByTimeAsync(31_000);
    await service(address, '1m'); await vi.advanceTimersByTimeAsync(0);
    const recovered = (await service(address, '1m')).chart;
    expect(recovered).toMatchObject({ source: 'gmgn', volumeCurrency: 'usd', historyLoadStatus: 'queued', historyComplete: false });
    expect(recovered.candles).toHaveLength(100);
    expect(recovered.candles.some(c => c.time === alternative.candles[0].time)).toBe(false);
  });
});
