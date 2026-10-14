import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MarketProviderDeferred } from './geckoApi.js';
import { createGmgnRequester, GmgnHttpError } from './gmgnApi.js';
import { createTokenGmgnPositionQuote } from './tokenGmgnPositionQuote.js';

const token = '0x' + '1'.repeat(40), other = '0x' + '2'.repeat(40), date = '2026-10-15T00:00:00.000Z';
const body = (price = '0.0123', address = token) => ({ code: 0, data: { address, price: { price } } });
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(date); });
afterEach(() => { vi.useRealTimers(); });

describe('lightweight GMGN position spot quote', () => {
  it('receives required dispatch-time authentication through the shared requester', async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json(body()));
    const request = createGmgnRequester({ fetcher, query: async sql => ({ rows: sql.startsWith('WITH clock') ? [{ delay: 0 }] : [] }) });
    const load = createTokenGmgnPositionQuote({ request, apiKey: () => 'private-test-key' });
    expect((await load(token)).quote?.priceUsd).toBe('0.0123');
    const [url, options] = fetcher.mock.calls[0];
    expect(url.pathname).toBe('/v1/token/info');
    expect(url.searchParams.get('chain')).toBe('bsc'); expect(url.searchParams.get('address')).toBe(token);
    expect(url.searchParams.get('timestamp')).toBe(String(Date.now() / 1000));
    expect(url.searchParams.get('client_id')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(options.headers).toMatchObject({ 'X-APIKEY': 'private-test-key' }); expect(url.href).not.toContain('private-test-key');
  });
  it('uses the documented address and nested USD price with weight 1 shared-budget requests and coalesces cached reads', async () => {
    const request = vi.fn().mockResolvedValue(body());
    const load = createTokenGmgnPositionQuote({ request, apiKey: () => 'test-key' });
    const [first, joined] = await Promise.all([load(token), load(token)]);
    expect(first).toEqual({ quote: { priceUsd: '0.0123', timestamp: date } }); expect(joined).toEqual(first);
    expect(request).toHaveBeenCalledOnce();
    const [url, options] = request.mock.calls[0];
    expect(url.href).toBe(`https://openapi.gmgn.ai/v1/token/info?chain=bsc&address=${token}`);
    expect(options).toMatchObject({ apiKey: 'test-key', weight: 1, priority: 'prefetch', timeoutMs: 1500 });
    await vi.advanceTimersByTimeAsync(29_000);
    expect(await load(token)).toEqual(first); expect(request).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['0', '-1', 'NaN', 'Infinity', '0x10', '1_000', '', ' 1'])('rejects malformed or nonpositive USD price %s', async price => {
    const request = vi.fn().mockResolvedValue(body(price));
    const load = createTokenGmgnPositionQuote({ request, apiKey: () => 'test-key' });
    expect((await load(token)).quote).toBeUndefined(); await load(token);
    expect(request).toHaveBeenCalledOnce();
  });

  it.each([null, {}, { code: 0, data: { address: token, price: '123' } }, { code: 500, ...{ data: body().data } }, body('123', other)])
    ('rejects malformed bodies and wrong tokens: %j', async response => {
      const load = createTokenGmgnPositionQuote({ request: vi.fn().mockResolvedValue(response), apiKey: () => 'test-key' });
      expect((await load(token)).quote).toBeUndefined();
    });

  it('retains a recent observed quote on timeout without redating it, then expires it after 180 seconds', async () => {
    const request = vi.fn().mockResolvedValueOnce(body()).mockImplementation(() => new Promise(() => {}));
    const load = createTokenGmgnPositionQuote({ request, apiKey: () => 'test-key' });
    const first = await load(token);
    await vi.advanceTimersByTimeAsync(30_001);
    expect(await load(token)).toEqual(first);
    await vi.advanceTimersByTimeAsync(1500);
    expect(await load(token)).toMatchObject({ quote: first.quote, reason: 'current_quote_unavailable' });
    await vi.advanceTimersByTimeAsync(150_000);
    const pending = load(token); await vi.advanceTimersByTimeAsync(1500);
    expect((await pending).quote).toBeUndefined(); expect(vi.getTimerCount()).toBe(0);
  });

  it.each([new MarketProviderDeferred('rate_limited', 60_000), new GmgnHttpError(401, 300_000)])
    ('respects shared-provider cooldowns and does not return raw errors', async error => {
      const request = vi.fn().mockRejectedValue(error), load = createTokenGmgnPositionQuote({ request, apiKey: () => 'secret-test-key' });
      const first = await load(token);
      expect(first.retryAfterMs).toBe(error.retryAfterMs); expect(JSON.stringify(first)).not.toContain('secret-test-key');
      expect(first.reason).toBe(error instanceof MarketProviderDeferred ? 'quote_rate_limited' : 'quote_key_unavailable');
      await vi.advanceTimersByTimeAsync(1000); await load(token); expect(request).toHaveBeenCalledOnce();
    });

  it('never serves a future cached observation after a backward clock jump', async () => {
    const request = vi.fn().mockResolvedValueOnce(body()).mockRejectedValue(Error('unavailable'));
    const load = createTokenGmgnPositionQuote({ request, apiKey: () => 'test-key' });
    await load(token); vi.setSystemTime(Date.parse(date) - 10_000);
    expect((await load(token)).quote).toBeUndefined();
  });

  it('rejects invalid addresses and missing configuration without making a provider request', async () => {
    const request = vi.fn(), load = createTokenGmgnPositionQuote({ request, apiKey: () => '' });
    expect((await load(token)).reason).toBe('quote_key_unavailable');
    expect((await load('invalid')).reason).toBe('current_quote_unavailable');
    expect(request).not.toHaveBeenCalled();
  });
});
