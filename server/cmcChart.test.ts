import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmcRetryMs, createCmcQueue, createCmcRequester, fetchCmcMarketCandles, parseCmcCandles, reserveCmcSlot } from './cmcChart.js';
import { MarketProviderDeferred } from './geckoApi.js';

const address = '0xdd806e436dda5588bf54061c11590c77ddc87777';
const now = Date.UTC(2026, 9, 12, 12), until = now / 1000;
const candle = (time: number, close = 2) => [1, 3, 0.5, close, 420, time, 7];
const body = (data: unknown = [candle(until * 1000)]) => ({ status: { error_code: 0 }, data });
const url = new URL(`https://pro-api.coinmarketcap.com/public-api/v1/k-line/candles?platform=bsc&address=${address}&interval=5min&unit=usd&pm=p&limit=288`);
afterEach(() => vi.useRealTimers());

describe('CMC latest token history', () => {
  it('reads CMC OHLCV order, seconds and milliseconds without treating traders or token volume as dollars', () => {
    const rows = [candle((until - 300) * 1000), candle(until, 2.5), candle((until - 300) * 1000, 1.5)];
    expect(parseCmcCandles(rows, until - 86_400, until, 300)).toEqual([
      { time: until - 300, open: 1, high: 3, low: 0.5, close: 1.5, volume: 420 },
      { time: until, open: 1, high: 3, low: 0.5, close: 2.5, volume: 420 },
    ]);
  });
  it('rejects future, old, misaligned and impossible bars instead of filling synthetic history', () => {
    const rows = [candle(until), candle(until + 300), candle(until - 90_000), candle(until - 1),
      [1, 0.8, 0.5, 2, 420, until - 300, 7], [1, 3, 1.5, 2, 420, until - 300, 7],
      [1, 3, 0, 2, 420, until - 300, 7], [1, 3, 0.5, 2, -1, until - 300, 7],
      [null, 3, 0.5, 2, 420, until - 300, 7], [1, 3, 0.5, 2, 420, true, 7],
      [until - 300, 1, 3, 0.5, 2, 420], candle((until - 300) * 1000 + 1)];
    expect(parseCmcCandles(rows, until - 86_400, until, 300)).toHaveLength(1);
  });
  it.each([
    ['5m', '5min', '288'], ['1h', '1h', '720'], ['4h', '4h', '540'], ['1d', '1d', '180'],
  ] as const)('requests real latest %s history directly by token address without paid range parameters', async (period, interval, limit) => {
    const step = { '5m': 300, '1h': 3600, '4h': 14_400, '1d': 86_400 }[period];
    const barTime = Math.floor(until / step) * step;
    const request = vi.fn(async (requestUrl: URL) => {
      expect(requestUrl.origin).toBe('https://pro-api.coinmarketcap.com');
      expect(requestUrl.pathname).toBe('/public-api/v1/k-line/candles');
      expect(Object.fromEntries(requestUrl.searchParams)).toEqual({ platform: 'bsc', address, interval, unit: 'usd', pm: 'p', limit });
      return body([candle(barTime * 1000)]);
    });
    const chart = await fetchCmcMarketCandles(address, period, request, now);
    expect(chart).toMatchObject({ source: 'coinmarketcap', resolution: period, volumeCurrency: 'unknown', partialHistory: true });
    expect(chart?.points).toEqual([{ timestamp: new Date(barTime * 1000).toISOString(), priceUsd: '2' }]);
  });
  it('bounds latest requests, flags shortened history, and accepts the provider string success code', async () => {
    const request = vi.fn(async (requestUrl: URL) => {
      expect(requestUrl.searchParams.get('limit')).toBe('5');
      return { ...body([candle(until - 300)]), status: { error_code: '0' } };
    });
    const chart = await fetchCmcMarketCandles(address, '5m', request, now, undefined, { limitCap: 5 });
    expect(chart).toMatchObject({ partialHistory: true, volumeCurrency: 'unknown' });
    const complete = await fetchCmcMarketCandles(address, '5m', async () => body(Array.from({ length: 288 }, (_, i) => candle(until - i * 300))), now);
    expect(complete?.partialHistory).toBe(false);
  });
  it('does not accept error envelopes or missing success status as empty cached history', async () => {
    for (const response of [{ status: { error_code: 1006 }, data: [] }, { data: [] }, { status: { error_code: null }, data: [] }, body({ items: [] })]) {
      await expect(fetchCmcMarketCandles(address, '5m', async () => response, now)).rejects.toThrow('invalid chart response');
    }
    expect(await fetchCmcMarketCandles(address, '5m', async () => body([]), now)).toBeNull();
    const request = vi.fn(async () => body());
    await expect(fetchCmcMarketCandles('not-an-address', '5m', request, now)).rejects.toThrow('Invalid chart address');
    expect(request).not.toHaveBeenCalled();
  });
});

describe('CMC public request protection', () => {
  it('gives an interactive chart one conservative slot while background charts cannot reserve a backlog', async () => {
    const priorities = ['chart', 'sparkline', 'metadata'] as const;
    const keys: unknown[] = [];
    for (const priority of priorities) await reserveCmcSlot(priority, async (_sql, values) => {
      keys.push(values[0]); expect(values.slice(1)).toEqual([6500, priority === 'chart' ? 6500 : 0]); return { rows: [{ delay: 0 }] };
    });
    expect(new Set(keys).size).toBe(1);
    await expect(reserveCmcSlot('chart', async () => ({ rows: [] }))).rejects.toMatchObject({ reason: 'busy', retryAfterMs: 6500 });
    let calls = 0;
    await expect(reserveCmcSlot('chart', async () => ({ rows: ++calls === 1 ? [] : [{ delay: 120_000 }] })))
      .rejects.toMatchObject({ reason: 'rate_limited', retryAfterMs: 120_000 });
  });
  it('honors server retry/reset signals with a minute minimum and bounded exponential backoff', () => {
    expect(cmcRetryMs(new Headers({ 'Retry-After': '90' }), {}, now)).toBe(90_000);
    expect(cmcRetryMs(new Headers({ 'Retry-After': new Date(now + 120_000).toUTCString() }), {}, now)).toBe(120_000);
    expect(cmcRetryMs(new Headers(), { status: { retry_after: 150, reset_at: until + 200 } }, now)).toBe(200_000);
    expect(cmcRetryMs(new Headers(), { reset_at: now + 180_000 }, now)).toBe(180_000);
    expect(cmcRetryMs(new Headers({ 'Retry-After': 'invalid' }), {}, now)).toBe(60_000);
    expect(cmcRetryMs(new Headers({ 'Retry-After': '2' }), {}, now)).toBe(60_000);
    expect(cmcRetryMs(new Headers({ 'Retry-After': '99999' }), {}, now)).toBe(600_000);
  });
  it('prioritizes a newly selected chart, cancels abandoned work and bounds watchlist bursts', async () => {
    const enqueue = createCmcQueue<number>(), controller = new AbortController();
    let finish!: (value: number) => void, selected: 'chart' | 'sparkline' = 'sparkline';
    const order: string[] = [];
    const first = enqueue('sparkline', controller.signal, () => new Promise(resolve => { finish = resolve; }));
    const background = enqueue('sparkline', controller.signal, async () => { order.push('background'); return 1; });
    const promoted = enqueue(() => selected, controller.signal, async () => { order.push('selected'); return 2; });
    const cancel = new AbortController(), run = vi.fn(async () => 0);
    const abandoned = enqueue('chart', cancel.signal, run), rejection = expect(abandoned).rejects.toThrow('Cancelled');
    cancel.abort(new Error('Cancelled'));
    const others = Array.from({ length: 6 }, () => enqueue('sparkline', controller.signal, async () => 3));
    await expect(enqueue('sparkline', controller.signal, async () => 4)).rejects.toBeInstanceOf(MarketProviderDeferred);
    selected = 'chart'; finish(0); await Promise.all([first, background, promoted, ...others, rejection]);
    expect(order).toEqual(['selected', 'background']); expect(run).not.toHaveBeenCalled();
  });

  function dependencies(response: () => Response) {
    let time = now, pausedUntil = 0, failures = 0;
    const query = vi.fn(async (sql: string, values: unknown[]) => {
      if (sql.startsWith('WITH clock')) return { rows: pausedUntil > time ? [] : [{ delay: 0 }] };
      if (sql.includes("'failures',least(6")) {
        const delay = Math.max(Number(values[1]), Math.min(600_000, Number(values[2]) * 2 ** failures++));
        pausedUntil = Math.max(pausedUntil, time + delay); return { rows: [{ delay: pausedUntil - time }] };
      }
      if (sql.includes("jsonb_build_object('failures',0)")) { failures = 0; return { rows: [] }; }
      return { rows: pausedUntil > time ? [{ delay: pausedUntil - time }] : [] };
    });
    const fetcher = vi.fn(async () => response());
    return { query, fetcher, now: () => time, advance: (ms: number) => { time += ms; } };
  }
  it.each([{ status: 429, code: 1008 }, { status: 200, code: 1008 }, { status: 200, code: 1022 }])(
    'coalesces HTTP $status/body $code rate limits and shares the cooldown with another app process', async ({ status, code }) => {
    const deps = dependencies(() => Response.json({ status: { error_code: code }, data: [] }, { status, headers: { 'Retry-After': '120' } }));
    const request = createCmcRequester(deps), anotherProcess = createCmcRequester(deps);
    await Promise.all([
      expect(request(url)).rejects.toMatchObject({ reason: 'rate_limited', retryAfterMs: 120_000 }),
      expect(request(url)).rejects.toMatchObject({ reason: 'rate_limited', retryAfterMs: 120_000 }),
    ]);
    await expect(anotherProcess(new URL(url.href + '&other=1'))).rejects.toMatchObject({ reason: 'rate_limited', retryAfterMs: 120_000 });
    expect(deps.fetcher).toHaveBeenCalledOnce();
    const cooldown = deps.query.mock.calls.find(([sql]) => sql.includes("'failures',least(6"));
    expect(cooldown?.[1].slice(1)).toEqual([120_000, 60_000]);
  });
  it('uses exponential shared backoff instead of returning to an immediate retry storm', async () => {
    const deps = dependencies(() => Response.json({ status: { error_code: 1008 } }, { status: 429 }));
    const request = createCmcRequester(deps);
    await expect(request(url)).rejects.toMatchObject({ retryAfterMs: 60_000 });
    deps.advance(60_000);
    await expect(request(url)).rejects.toMatchObject({ retryAfterMs: 120_000 });
    expect(deps.fetcher).toHaveBeenCalledTimes(2);
  });
  it.each([403, 503])('opens an IP-wide circuit for HTTP %i failures so every token does not repeat the failing request', async status => {
    const deps = dependencies(() => new Response('unavailable', { status }));
    const request = createCmcRequester(deps);
    await expect(request(url)).rejects.toThrow(`HTTP ${status}`);
    await expect(request(new URL(url.href + '&other=1'))).rejects.toMatchObject({ reason: 'rate_limited', retryAfterMs: status === 403 ? 300_000 : 60_000 });
    expect(deps.fetcher).toHaveBeenCalledOnce();
  });
  it('coalesces identical successful history while cancellation of one viewer preserves the other viewer', async () => {
    let finish!: (value: Response) => void;
    const query = vi.fn(async (sql: string) => ({ rows: sql.startsWith('WITH clock') ? [{ delay: 0 }] : [] }));
    const fetcher = vi.fn(() => new Promise<Response>(resolve => { finish = resolve; }));
    const request = createCmcRequester({ query, fetcher }), controller = new AbortController();
    const one = request(url, { signal: controller.signal }), two = request(new URL(url.href));
    const rejection = expect(one).rejects.toThrow('Viewer left');
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    controller.abort(new Error('Viewer left')); await rejection;
    finish(Response.json(body())); await expect(two).resolves.toEqual(body());
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it('allows a viewer to reopen an abandoned chart without joining its cancelled request', async () => {
    let finish!: (value: Response) => void;
    const query = vi.fn(async (sql: string) => ({ rows: sql.startsWith('WITH clock') ? [{ delay: 0 }] : [] }));
    const fetcher = vi.fn<typeof fetch>().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
      .mockResolvedValueOnce(Response.json(body([candle(until, 2.5)])));
    const request = createCmcRequester({ query, fetcher }), controller = new AbortController();
    const abandoned = request(url, { signal: controller.signal }), rejection = expect(abandoned).rejects.toThrow('Viewer left');
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    controller.abort(new Error('Viewer left')); await rejection;
    const reopened = request(new URL(url.href));
    finish(Response.json(body()));
    await expect(reopened).resolves.toEqual(body([candle(until, 2.5)]));
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('rejects nonofficial and paid-range URLs before consuming the shared allowance', async () => {
    const deps = dependencies(() => Response.json(body())), request = createCmcRequester(deps);
    await expect(request(new URL('https://other.example/public-api/v1/k-line/candles'))).rejects.toThrow('Invalid CoinMarketCap chart URL');
    await expect(request(new URL(url.href + '&from=123'))).rejects.toThrow('Invalid CoinMarketCap chart URL');
    expect(deps.query).not.toHaveBeenCalled(); expect(deps.fetcher).not.toHaveBeenCalled();
  });
});
