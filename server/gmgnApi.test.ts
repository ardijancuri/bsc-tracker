import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGmgnQueue, createGmgnRequester, gmgnRetryMs, reserveGmgnSlot } from './gmgnApi.js';
import { MarketProviderDeferred } from './geckoApi.js';

const url = new URL('https://openapi.gmgn.ai/v1/market/token_kline?chain=bsc');
const now = 2_000_000_000_000;
afterEach(() => vi.useRealTimers());

describe('GMGN account request budget', () => {
  it('paces documented route weights and uses the same private hashed account row for app and worker', async () => {
    const keys: unknown[] = [];
    await reserveGmgnSlot('private-test-key', 2, 'chart', async (_sql, values) => {
      keys.push(values[0]); expect(values.slice(1)).toEqual([1000, 1500]); return { rows: [{ delay: 1000 }] };
    });
    await reserveGmgnSlot('private-test-key', 3, 'metadata', async (_sql, values) => {
      keys.push(values[0]); expect(values.slice(1)).toEqual([1500, 0]); return { rows: [{ delay: 0 }] };
    });
    expect(keys[0]).toBe(keys[1]);
    expect(keys[0]).toMatch(/^gmgn_api_budget:[a-f0-9]{16}$/);
    expect(keys[0]).not.toContain('private-test-key');
    await reserveGmgnSlot('rotated-test-key', 2, 'chart', async (_sql, values) => {
      expect(values[0]).not.toBe(keys[0]); return { rows: [{ delay: 0 }] };
    });
  });
  it('returns shared cooldowns and refuses extra queued slots when the account is already busy', async () => {
    await expect(reserveGmgnSlot('key', 2, 'chart', async () => ({ rows: [] }))).rejects.toMatchObject({ reason: 'busy', retryAfterMs: 1000 });
    let calls = 0;
    await expect(reserveGmgnSlot('key', 2, 'chart', async () => ({ rows: ++calls === 1 ? [] : [{ delay: 125_000 }] })))
      .rejects.toMatchObject({ reason: 'rate_limited', retryAfterMs: 125_000 });
  });
  it('honors header and body reset times and safely bounds missing or extreme delays', () => {
    expect(gmgnRetryMs(new Headers({ 'X-RateLimit-Reset': String(now / 1000 + 5) }), { reset_at: now / 1000 + 90 }, now)).toBe(90_000);
    expect(gmgnRetryMs(new Headers(), { reset_at: now + 300_000 }, now)).toBe(300_000);
    expect(gmgnRetryMs(new Headers({ 'Retry-After': '2' }), {}, now)).toBe(2000);
    expect(gmgnRetryMs(new Headers({ 'Retry-After': new Date(now + 120_000).toUTCString() }), {}, now)).toBe(120_000);
    expect(gmgnRetryMs(new Headers(), { reset_at: 'unknown' }, now)).toBe(60_000);
    expect(gmgnRetryMs(new Headers(), { reset_at: now / 1000 + 9999 }, now)).toBe(600_000);
  });
  it('dispatches charts ahead of sparklines and removes cancelled queued work before a request can run', async () => {
    const enqueue = createGmgnQueue<number>();
    let finish!: (value: number) => void;
    const signal = new AbortController().signal;
    const order: string[] = [];
    const first = enqueue('sparkline', signal, () => new Promise(resolve => { finish = resolve; }));
    const background = enqueue('sparkline', signal, async () => { order.push('background'); return 2; });
    const cancelled = new AbortController(), run = vi.fn(async () => 0);
    const queued = enqueue('chart', cancelled.signal, run);
    const rejection = expect(queued).rejects.toThrow('Cancelled');
    cancelled.abort(new Error('Cancelled'));
    const chart = enqueue('chart', signal, async () => { order.push('chart'); return 3; });
    await expect(enqueue('metadata', signal, async () => 4)).rejects.toBeInstanceOf(MarketProviderDeferred);
    finish(1); await Promise.all([first, background, chart, rejection]);
    expect(order).toEqual(['chart', 'background']); expect(run).not.toHaveBeenCalled();
  });
});

describe('GMGN HTTP adapter', () => {
  function dependencies(response: Response) {
    let pauseMs = 0;
    const query = vi.fn(async (sql: string, values: unknown[]) => {
      if (sql.startsWith('WITH clock')) return { rows: pauseMs ? [] : [{ delay: 0 }] };
      if (sql.startsWith('UPDATE')) { pauseMs = Number(values[1]); return { rows: [] }; }
      if (sql.includes('greatest(0')) return { rows: pauseMs ? [{ delay: pauseMs }] : [] };
      return { rows: [] };
    });
    const fetcher = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => response);
    return { query, fetcher, request: createGmgnRequester({ query, fetcher, now: () => now }) };
  }
  it('keeps credentials in the server-side header and supports the weighted worker POST through the same adapter', async () => {
    const { request, fetcher } = dependencies(Response.json({ code: 0, data: { list: [] } }));
    const value = await request(url, { apiKey: ' server-test-key ', method: 'POST', body: { chain: 'bsc' }, weight: 3 });
    expect(fetcher.mock.calls[0][0]).toBe(url);
    const options = fetcher.mock.calls[0][1] as RequestInit;
    expect(options.headers).toMatchObject({ 'X-APIKEY': 'server-test-key', 'Content-Type': 'application/json' });
    expect(options.body).toBe('{"chain":"bsc"}');
    expect(JSON.stringify(value)).not.toContain('server-test-key');
    expect(url.href).not.toContain('server-test-key');
  });
  it.each([429, 200])('persists cooldown from an HTTP %i/body429 response and stops requests during it', async status => {
    const { request, fetcher, query } = dependencies(Response.json({ code: 429, reset_at: now / 1000 + 120 }, { status }));
    await expect(request(url, { apiKey: 'key' })).rejects.toMatchObject({ reason: 'rate_limited', retryAfterMs: 120_000 });
    await expect(request(url, { apiKey: 'key' })).rejects.toMatchObject({ reason: 'rate_limited', retryAfterMs: 120_000 });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(query.mock.calls.some(([sql, values]) => sql.startsWith('UPDATE') && values[1] === 120_000)).toBe(true);
  });
  it('cools down invalid credentials without leaking upstream error text', async () => {
    const { request, fetcher } = dependencies(Response.json({ message: 'secret-is-private' }, { status: 401 }));
    await expect(request(url, { apiKey: 'secret-is-private' })).rejects.toThrow('GMGN request failed: HTTP 401');
    await expect(request(url, { apiKey: 'secret-is-private' })).rejects.toMatchObject({ retryAfterMs: 300_000 });
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it('bounds a queued request and aborts it before any DB reservation or network dispatch', async () => {
    let finish!: (value: Response) => void;
    const query = vi.fn(async (sql: string) => ({ rows: sql.startsWith('WITH clock') ? [{ delay: 0 }] : [] }));
    const fetcher = vi.fn(() => new Promise<Response>(resolve => { finish = resolve; }));
    const request = createGmgnRequester({ query, fetcher });
    const first = request(url, { apiKey: 'key' });
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    const controller = new AbortController();
    const queued = request(url, { apiKey: 'key', signal: controller.signal });
    const rejection = expect(queued).rejects.toThrow('Cancelled');
    controller.abort(new Error('Cancelled')); await rejection;
    finish(Response.json({ code: 0, data: [] })); await first;
    expect(fetcher).toHaveBeenCalledOnce(); expect(query).toHaveBeenCalledTimes(2);
  });
  it('rejects missing credentials and non-official origins before consuming a slot', async () => {
    const { request, fetcher, query } = dependencies(Response.json({ code: 0 }));
    await expect(request(url, { apiKey: ' ' })).rejects.toThrow('not configured');
    await expect(request(new URL('https://other.example/v1/market/token_kline'), { apiKey: 'key' })).rejects.toThrow('Invalid GMGN API URL');
    expect(query).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
  });
});
