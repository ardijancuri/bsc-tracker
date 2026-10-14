import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTokenPositionQuote } from './tokenPositionQuote.js';

const date = '2026-10-15T00:00:00.000Z';
const token = (index = 1) => '0x' + index.toString(16).padStart(40, '0');
const pair = (index = 1, priceUsd = '0.123', usd = 1000) => ({ chainId: 'bsc', baseToken: { address: token(index) }, priceUsd, liquidity: { usd } });
const response = (rows: unknown, headers: Record<string, string> = {}, status = 200) => Response.json(rows, { status, headers });
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(date); });
afterEach(() => { vi.useRealTimers(); });

describe('independent batched position spot quotes', () => {
  it('batches six visible tokens and coalesces duplicate requests, selecting the most liquid exact BSC base token', async () => {
    const fetcher = vi.fn().mockResolvedValue(response([
      ...Array.from({ length: 6 }, (_, index) => pair(index + 1)), pair(1, '0.5', 10_000),
      { ...pair(1, '999', 1_000_000), chainId: 'ethereum' },
      { ...pair(20, '999', 1_000_000), quoteToken: { address: token(1) } },
    ]));
    const load = createTokenPositionQuote({ fetcher });
    const pending = Array.from({ length: 6 }, (_, index) => load(token(index + 1)));
    pending.push(load(token(1).toUpperCase().replace('0X', '0x')));
    await vi.advanceTimersByTimeAsync(25);
    const values = await Promise.all(pending);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0][0]).toBe(`https://api.dexscreener.com/tokens/v1/bsc/${Array.from({ length: 6 }, (_, index) => token(index + 1)).join(',')}`);
    expect(values[0].quote?.priceUsd).toBe('0.5'); expect(values[6]).toEqual(values[0]);
    expect(values.every(value => value.quote?.timestamp === '2026-10-15T00:00:00.025Z')).toBe(true);
    expect(await load(token(1))).toEqual(values[0]); expect(fetcher).toHaveBeenCalledOnce();
  });

  it('splits more than thirty tokens and spaces requests within the provider limit', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => response(String(input).split('/').at(-1)!.split(',').map(address => ({ ...pair(), baseToken: { address } }))));
    const load = createTokenPositionQuote({ fetcher });
    const pending = Array.from({ length: 31 }, (_, index) => load(token(index + 1)));
    await vi.advanceTimersByTimeAsync(25); expect(fetcher).toHaveBeenCalledOnce();
    expect(String(fetcher.mock.calls[0][0]).split('/').at(-1)!.split(',')).toHaveLength(30);
    await vi.advanceTimersByTimeAsync(249); expect(fetcher).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1); expect(fetcher).toHaveBeenCalledTimes(2);
    expect((await Promise.all(pending)).every(value => value.quote !== undefined)).toBe(true);
  });

  it('preserves HTTP Date/Age observation time across cache reads and refreshes', async () => {
    const observedAt = '2026-10-14T23:59:20.000Z';
    const fetcher = vi.fn().mockResolvedValue(response([pair()], { Date: 'Wed, 14 Oct 2026 23:59:20 GMT', Age: '10' }));
    const load = createTokenPositionQuote({ fetcher });
    const pending = load(token()); await vi.advanceTimersByTimeAsync(25);
    expect((await pending).quote?.timestamp).toBe(observedAt);
    const retained = await load(token()); expect(retained.quote?.timestamp).toBe(observedAt);
    await vi.advanceTimersByTimeAsync(250);
    expect((await load(token())).quote?.timestamp).toBe(observedAt);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('honors Age when it is older than Date without counting both cache ages twice', async () => {
    const fetcher = vi.fn().mockResolvedValue(response([pair()], { Date: 'Thu, 15 Oct 2026 00:00:00 GMT', Age: '60' }));
    const load = createTokenPositionQuote({ fetcher });
    const pending = load(token()); await vi.advanceTimersByTimeAsync(25);
    expect((await pending).quote?.timestamp).toBe('2026-10-14T23:59:00.025Z');
  });

  it.each([
    { Date: 'Thu, 15 Oct 2026 00:00:30 GMT' }, { Date: 'invalid' }, { Age: '-1' }, { Age: 'NaN' }, { Age: '181' },
    { Date: 'Wed, 14 Oct 2026 23:50:00 GMT' },
  ] as Record<string, string>[])('rejects a stale, invalid or future observation header %j', async headers => {
    const load = createTokenPositionQuote({ fetcher: vi.fn().mockResolvedValue(response([pair()], headers)) });
    const pending = load(token()); await vi.advanceTimersByTimeAsync(25);
    expect((await pending).quote).toBeUndefined();
  });

  it.each(['0', '-1', 'NaN', 'Infinity', '0x10', '1_000', '', ' 1'])('rejects invalid quote price %s', async price => {
    const fetcher = vi.fn().mockResolvedValue(response([pair(1, price)])), load = createTokenPositionQuote({ fetcher });
    const pending = load(token()); await vi.advanceTimersByTimeAsync(25);
    expect((await pending).quote).toBeUndefined();
    await load(token()); expect(fetcher).toHaveBeenCalledOnce();
  });

  it('does not accept errors, wrong tokens, wrong chains or unbacked liquidity as spot prices', async () => {
    for (const rows of [{ error: 'rate limited' }, [pair(2)], [{ ...pair(), chainId: 'base' }], [pair(1, '2', 0)],
      [{ ...pair(), liquidity: null }], [null, false, 'invalid']]) {
      const load = createTokenPositionQuote({ fetcher: vi.fn().mockResolvedValue(response(rows)) });
      const pending = load(token()); await vi.advanceTimersByTimeAsync(25);
      expect((await pending).quote).toBeUndefined();
    }
  });

  it('retains a genuine recent quote during a failed refresh without redating it or using it beyond 180 seconds', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(response([pair()])).mockRejectedValue(Error('network failure'));
    const load = createTokenPositionQuote({ fetcher });
    const pending = load(token()); await vi.advanceTimersByTimeAsync(25);
    const initial = await pending;
    await vi.advanceTimersByTimeAsync(30_001);
    expect(await load(token())).toEqual(initial);
    await vi.advanceTimersByTimeAsync(25);
    const failed = await load(token()); expect(failed.quote).toEqual(initial.quote); expect(failed.reason).toBe('current_quote_unavailable');
    await vi.advanceTimersByTimeAsync(150_000);
    const expired = load(token()); await vi.advanceTimersByTimeAsync(25);
    expect((await expired).quote).toBeUndefined();
  });

  it('honors a shared 429 cooldown without additional requests and recovers afterward', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(response({}, { 'Retry-After': '90' }, 429)).mockResolvedValue(response([pair(2)]));
    const load = createTokenPositionQuote({ fetcher });
    const pending = load(token()); await vi.advanceTimersByTimeAsync(25);
    expect(await pending).toEqual({ reason: 'quote_rate_limited', retryAfterMs: 90_000 });
    expect(await load(token(2))).toEqual({ reason: 'quote_rate_limited', retryAfterMs: 90_000 });
    expect(fetcher).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(90_000);
    const recovered = load(token(2)); await vi.advanceTimersByTimeAsync(25);
    expect((await recovered).quote?.priceUsd).toBe('0.123'); expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('bounds a hung response and response body, clears timers and leaves future tokens usable', async () => {
    for (const hung of [new Promise<Response>(() => {}), Promise.resolve({ ok: true, status: 200, headers: new Headers(), json: () => new Promise(() => {}) } as Response)]) {
      const fetcher = vi.fn().mockReturnValueOnce(hung).mockResolvedValue(response([pair(2)]));
      const load = createTokenPositionQuote({ fetcher });
      const pending = load(token()); await vi.advanceTimersByTimeAsync(1825);
      expect((await pending).quote).toBeUndefined(); expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true);
      const recovered = load(token(2)); await vi.advanceTimersByTimeAsync(25);
      expect((await recovered).quote).toBeDefined(); expect(vi.getTimerCount()).toBe(0);
    }
  });

  it('bounds queue waits and rejects invalid addresses before making a request', async () => {
    const fetcher = vi.fn().mockImplementation(() => new Promise<Response>(() => {}));
    const load = createTokenPositionQuote({ fetcher, maxEntries: 32 });
    expect(await load('not-a-token')).toEqual({ reason: 'current_quote_unavailable' });
    const pending = Array.from({ length: 32 }, (_, index) => load(token(index + 1)));
    expect(await load(token(33))).toEqual({ reason: 'quote_busy', retryAfterMs: 3000 });
    await vi.advanceTimersByTimeAsync(2400);
    expect((await Promise.all(pending)).every(value => value.quote === undefined)).toBe(true);
    await vi.advanceTimersByTimeAsync(2000); expect(vi.getTimerCount()).toBe(0);
  });
});
