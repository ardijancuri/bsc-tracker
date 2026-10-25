import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ChartDiskCache } from './cache.js';
import { createFreshCharts, freshChartIntervals, normalizeFreshCandles, type FreshResolution } from './charts.js';
import { createGmgnRequester, gmgnApiKey, reserveGmgnSlot } from '../gmgnTransport.js';

const token = '0x' + '1'.repeat(40), directories: string[] = [];
const start = Date.parse('2026-10-21T10:00:00Z');
afterEach(async () => { vi.useRealTimers(); await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });
const row = (time: number, price = '1') => ({ time: time / 1000, open: price, high: price, low: price, close: price, volume: '50', amount: '10000000' });
async function cache(now: () => number) { const folder = await mkdtemp(path.join(os.tmpdir(), 'kollens-chart-test-')); directories.push(folder); return new ChartDiskCache(folder, { now }); }
const query = async (sql: string) => ({ rows: sql.startsWith('WITH clock') ? [{ delay: 0 }] : [] });

describe('fresh GMGN chart-only workloads', () => {
  it('reuses existing keys for browsing/replays while preserving single-key deployments', () => {
    const env = { GMGN_CHART_API_KEY: 'first', GMGN_ACCOUNTING_API_KEY: 'second' };
    expect(gmgnApiKey('browse', env)).toBe('first'); expect(gmgnApiKey('replay', env)).toBe('second');
    expect(gmgnApiKey('replay', { GMGN_CHART_API_KEY: 'only' })).toBe('only');
    expect(gmgnApiKey('browse', { GMGN_API_KEY: 'only' })).toBe('only');
  });
  it('uses the fresh checkpoint table and weighted pacing without legacy schema writes', async () => {
    await reserveGmgnSlot('secret', 2, 'chart', async (sql, values) => {
      expect(sql).toContain('INSERT INTO fresh.checkpoints AS budget'); expect(sql).not.toContain('worker_state');
      expect(values.slice(1)).toEqual([1000, 1500]); expect(values[0]).not.toContain('secret'); return { rows: [{ delay: 0 }] };
    }, 'fresh.checkpoints');
  });
  it('leases one active upstream request per credential across API processes', async () => {
    const active = new Map<unknown, unknown>();
    const sharedQuery = async (sql: string, values: unknown[]) => {
      if (sql.startsWith('WITH clock')) {
        if (active.has(values[0])) return { rows: [] };
        active.set(values[0], values[3]); return { rows: [{ delay: 0 }] };
      }
      if (sql.includes("value=value-'activeUntil'")) { if (active.get(values[0]) === values[1]) active.delete(values[0]); return { rows: [] }; }
      if (sql.includes('greatest(0')) return { rows: [{ delay: 0, busyDelay: 1000 }] };
      return { rows: [] };
    };
    const releases: (() => void)[] = [], fetcher = vi.fn(() => new Promise<Response>(resolve => releases.push(() => resolve(Response.json({ code: 0, data: {} })))));
    const first = createGmgnRequester({ query: sharedQuery, stateTable: 'fresh.checkpoints', fetcher });
    const otherProcess = createGmgnRequester({ query: sharedQuery, stateTable: 'fresh.checkpoints', fetcher });
    const url = new URL('https://openapi.gmgn.ai/v1/market/token_kline?chain=bsc&address=one');
    const pending = first(url, { apiKey: 'key' }); await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    await expect(otherProcess(url, { apiKey: 'key' })).rejects.toMatchObject({ reason: 'busy' });
    expect(fetcher).toHaveBeenCalledOnce();
    const independent = otherProcess(url, { apiKey: 'other-key' }); await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    releases[0](); releases[1](); await Promise.all([pending, independent]); expect(active.size).toBe(0);
  });
  it('normalizes genuine candles, dollar amount and exact timestamps without filling gaps', () => {
    const result = normalizeFreshCandles({ data: { list: [row(start), row(start + 120_000)] } }, start, start + 180_000, '1m', start + 180_000);
    expect(result.bars.map(bar => bar.time)).toEqual([start / 1000, start / 1000 + 120]);
    expect(result.bars[0].volumeUsd).toBe('50');
    const unknown = normalizeFreshCandles({ data: { list: [{ ...row(start), volume: undefined }] } }, start, start, '1m', start);
    expect(unknown.volumeKnown).toBe(false); expect(unknown.bars[0].volumeUsd).toBeNull();
    expect(() => normalizeFreshCandles({ data: { list: [row(start), row(start, '2')] } }, start, start, '1m', start)).toThrow();
    expect(() => normalizeFreshCandles({ data: { list: [{ ...row(start), high: '0.1' }] } }, start, start, '1m', start)).toThrow();
  });
  it('uses observed live GMGN USD volume rather than base-token amount', () => {
    const price = '0.0000041494386', volume = '0.0014838672', amount = '357.60674936';
    const page = normalizeFreshCandles({ data: { list: [{ time: start / 1000, open: price, high: price, low: price, close: price, volume, amount }] } }, start, start, '1m', start);
    expect(page.bars[0].volumeUsd).toBe(volume);
    expect(Number(volume) / Number(amount)).toBeCloseTo(Number(price), 12);
    expect(page.bars[0].volumeUsd).not.toBe(amount);
  });
  it('serves matching cards/modal/replay candles through one normalized cache and preserves original time', async () => {
    let now = start + 3600_000;
    const request = vi.fn(async () => ({ data: { list: [row(start), row(start + 60_000)] } }));
    const service = createFreshCharts({ cache: await cache(() => now), request, now: () => now });
    const input = { from: start, to: start + 120_000, resolution: '1m' as const };
    const first = await service.chart(token, input); now += 1000;
    const next = await service.chart(token, { ...input, workload: 'replay' });
    expect(request).toHaveBeenCalledOnce(); expect(next.updatedAt).toBe(first.updatedAt);
    const [url, options] = request.mock.calls[0] as unknown as [URL, Record<string, unknown>];
    expect(Number(url.searchParams.get('from'))).toBeGreaterThan(1e12); expect(options.workload).toBe('browse');
  });
  it('coalesces independent subscriptions, promotes a foreground join and isolates cancellation', async () => {
    let finish!: (value: Response) => void; let upstreamSignal!: AbortSignal;
    const fetcher = vi.fn((_input: unknown, options?: RequestInit) => { upstreamSignal = options!.signal!; return new Promise<Response>(resolve => { finish = resolve; }); });
    const requester = createGmgnRequester({ query, fetcher });
    const request = (url: URL, options: Parameters<typeof requester>[1]) => requester(url, { ...options, apiKey: 'same' });
    const service = createFreshCharts({ cache: await cache(() => start + 3600_000), request, now: () => start + 3600_000 });
    const controller = new AbortController(), input = { from: start, to: start + 120_000, resolution: '1m' as const };
    const first = service.chart(token, { ...input, signal: controller.signal, foreground: false });
    const rejected = expect(first).rejects.toThrow('Closed');
    const second = service.chart(token, { ...input, foreground: true, workload: 'replay' });
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    controller.abort(Error('Closed')); await rejected; expect(upstreamSignal.aborted).toBe(false);
    finish(Response.json({ code: 0, data: { list: [row(start), row(start + 60_000)] } })); await second;
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it('selects coarse/fine genuine chart segments for a long replay and freezes its node ending', async () => {
    const end = start + 100 * 86400_000 + 25_000, now = end;
    const request = vi.fn(async (url: URL) => {
      const seconds = freshChartIntervals[url.searchParams.get('resolution') as FreshResolution];
      const from = Number(url.searchParams.get('from')), to = Number(url.searchParams.get('to'));
      const rows = []; for (let time = Math.ceil(from / (seconds * 1000)) * seconds * 1000; time <= to; time += seconds * 1000) rows.push(row(time));
      return { data: { list: rows } };
    });
    const service = createFreshCharts({ cache: await cache(() => now), request, now: () => now });
    const ending = { timestamp: new Date(end).toISOString(), priceUsd: '1.25' };
    const chart = await service.replayChart(token, { from: start, to: end, open: true, supply: '1000000', ending });
    expect(chart.resolution).toBe('4h'); expect(chart.recentResolution).toBe('1m'); expect(chart.points.at(-1)).toEqual(ending);
    expect(new Set(request.mock.calls.map(([url]) => url.searchParams.get('resolution')))).toEqual(new Set(['4h', '1m']));
  });
  it('keeps recent tail freshness separate from daily/coarse historical bars', async () => {
    const end = start + 100 * 86400_000, request = vi.fn(async (url: URL) => {
      const seconds = freshChartIntervals[url.searchParams.get('resolution') as FreshResolution], from = Number(url.searchParams.get('from')), to = Number(url.searchParams.get('to'));
      const rows = []; for (let time = Math.ceil(from / (seconds * 1000)) * seconds * 1000; time <= to - 3600_000; time += seconds * 1000) rows.push(row(time));
      return { data: { list: rows } };
    });
    const service = createFreshCharts({ cache: await cache(() => end), request, now: () => end });
    await expect(service.replayChart(token, { from: start, to: end, open: true, supply: '1', ending: { timestamp: new Date(end).toISOString(), priceUsd: '1' } })).rejects.toMatchObject({ reason: 'chart_unavailable' });
  });
  it('returns an explicit cooldown and never falls back to another financial provider', async () => {
    const requester = createGmgnRequester({ query, fetcher: vi.fn(async () => Response.json({ code: 429, reset_at: (start + 120_000) / 1000 }, { status: 429 })), now: () => start });
    const request = (url: URL, options: Parameters<typeof requester>[1]) => requester(url, { ...options, apiKey: 'only' });
    const service = createFreshCharts({ cache: await cache(() => start), request, now: () => start });
    await expect(service.chart(token, { from: start - 120_000, to: start })).rejects.toMatchObject({ reason: 'provider_cooldown', retryAfterMs: 121_000 });
  });
});
