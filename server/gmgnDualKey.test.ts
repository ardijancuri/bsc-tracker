import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGmgnRequester, gmgnApiKey, type GmgnDiagnostic } from './gmgnApi.js';

const url = (token: string, route = '/v1/market/token_kline') => new URL(`https://openapi.gmgn.ai${route}?chain=bsc&address=${token}`);
const success = () => Response.json({ code: 0, data: { value: 1 } });
const query = async (sql: string) => ({ rows: sql.startsWith('WITH clock') ? [{ delay: 0 }] : [] });
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
afterEach(() => vi.useRealTimers());

describe('GMGN dual-key public data requests', () => {
  it('resolves separate workload keys and preserves single-key precedence', () => {
    const env = { GMGN_ACCOUNTING_API_KEY: ' accounting ', GMGN_CHART_API_KEY: ' market ', GMGN_API_KEY: ' legacy ' };
    expect(gmgnApiKey('accounting', env)).toBe('accounting');
    expect(gmgnApiKey('market', env)).toBe('market');
    expect(gmgnApiKey('accounting', { ...env, GMGN_ACCOUNTING_API_KEY: ' ' })).toBe('market');
    expect(gmgnApiKey('market', { GMGN_API_KEY: ' legacy ' })).toBe('legacy');
    expect(gmgnApiKey('accounting', { GMGN_API_KEY: ' legacy ' })).toBe('legacy');
    expect(gmgnApiKey('market', { GMGN_ACCOUNTING_API_KEY: 'accounting' })).toBe('');
  });

  it('overlaps distinct credentials while serializing different requests for the same credential', async () => {
    const releases: (() => void)[] = [];
    const fetcher = vi.fn(() => new Promise<Response>(resolve => releases.push(() => resolve(success()))));
    const request = createGmgnRequester({ query, fetcher });
    const first = request(url('one'), { apiKey: 'market' });
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    const queued = request(url('two'), { apiKey: 'market', workload: 'accounting' });
    const parallel = request(url('three', '/v1/user/wallet_activity'), { apiKey: 'accounting', workload: 'accounting' });
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    releases[0](); await first;
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(3));
    releases[1](); releases[2](); await Promise.all([queued, parallel]);
  });

  it('coalesces public requests independently of authentication and query ordering, with isolated response objects', async () => {
    let finish!: (response: Response) => void;
    const fetcher = vi.fn(() => new Promise<Response>(resolve => { finish = resolve; }));
    const observations: GmgnDiagnostic[] = [];
    const request = createGmgnRequester({ query, fetcher, observe: event => observations.push(event) });
    const firstUrl = url('one'); firstUrl.searchParams.set('timestamp', '1'); firstUrl.searchParams.set('client_id', 'old');
    const secondUrl = new URL('https://openapi.gmgn.ai/v1/market/token_kline?address=one&client_id=new&chain=bsc&timestamp=2');
    const first = request(firstUrl, { apiKey: 'private-first-key' });
    const second = request(secondUrl, { apiKey: 'private-second-key', foreground: true });
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    finish(success()); const [left, right] = await Promise.all([first, second]);
    left.data.value = 9; expect(right.data.value).toBe(1);
    expect(observations.filter(event => event.event === 'coalesced')).toHaveLength(1);
    expect(JSON.stringify(observations)).not.toContain('private-');
    expect(JSON.stringify(observations)).not.toContain('openapi.gmgn.ai');
  });

  it('keeps cursor pages distinct and never coalesces unapproved routes or POSTs', async () => {
    const fetcher = vi.fn(async () => success());
    const request = createGmgnRequester({ query, fetcher });
    const a = url('one', '/v1/user/wallet_activity'), b = new URL(a); b.searchParams.set('cursor', 'next-page');
    await Promise.all([request(a, { apiKey: 'key' }), request(b, { apiKey: 'key' })]);
    await Promise.all([request(url('one', '/v1/user/info'), { apiKey: 'key' }), request(url('one', '/v1/user/info'), { apiKey: 'key' })]);
    await Promise.all([request(a, { apiKey: 'key', method: 'POST', body: {} }), request(a, { apiKey: 'key', method: 'POST', body: {} })]);
    expect(fetcher).toHaveBeenCalledTimes(6);
  });

  it('promotes a joined selected trade ahead of ordinary chart work without a duplicate fetch', async () => {
    let finish!: (response: Response) => void;
    const order: string[] = [];
    const fetcher = vi.fn((input: string | URL | Request) => {
      const token = (input as URL).searchParams.get('address')!; order.push(token);
      return token === 'active' ? new Promise<Response>(resolve => { finish = resolve; }) : Promise.resolve(success());
    });
    const request = createGmgnRequester({ query, fetcher });
    const active = request(url('active'), { apiKey: 'key' });
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    const chart = request(url('ordinary-chart'), { apiKey: 'key', priority: 'chart' });
    const background = request(url('selected-token'), { apiKey: 'key', priority: 'prefetch' });
    const selected = request(url('selected-token'), { apiKey: 'key', priority: 'prefetch', foreground: true });
    finish(success()); await Promise.all([active, chart, background, selected]);
    expect(order).toEqual(['active', 'selected-token', 'ordinary-chart']);
  });

  it('cancels one subscriber without aborting another subscriber transport', async () => {
    let finish!: (response: Response) => void;
    let transport!: AbortSignal;
    const fetcher = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
      transport = init!.signal!; return new Promise<Response>(resolve => { finish = resolve; });
    });
    const request = createGmgnRequester({ query, fetcher });
    const controller = new AbortController();
    const first = request(url('one'), { apiKey: 'key', signal: controller.signal });
    const rejection = expect(first).rejects.toThrow('Closed');
    const second = request(url('one'), { apiKey: 'key' });
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    controller.abort(new Error('Closed')); await rejection;
    expect(transport.aborted).toBe(false); finish(success());
    await expect(second).resolves.toMatchObject({ code: 0 });
  });

  it('removes queued requests once every subscriber cancels, before DB or network work', async () => {
    let finish!: (response: Response) => void;
    const querySpy = vi.fn(query);
    const fetcher = vi.fn(() => new Promise<Response>(resolve => { finish = resolve; }));
    const request = createGmgnRequester({ query: querySpy, fetcher });
    const active = request(url('active'), { apiKey: 'key' });
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    const a = new AbortController(), b = new AbortController();
    const left = request(url('queued'), { apiKey: 'key', signal: a.signal });
    const right = request(url('queued'), { apiKey: 'key', signal: b.signal });
    const rejections = [expect(left).rejects.toThrow('Cancelled'), expect(right).rejects.toThrow('Cancelled')];
    a.abort(Error('Cancelled')); b.abort(Error('Cancelled')); await Promise.all(rejections);
    finish(success()); await active; await tick();
    expect(fetcher).toHaveBeenCalledOnce(); expect(querySpy).toHaveBeenCalledTimes(2);
  });

  it('keeps an aborted active transport in its lane until it actually settles', async () => {
    let finish!: (response: Response) => void;
    const fetcher = vi.fn().mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve; }))
      .mockImplementation(async () => success());
    const request = createGmgnRequester({ query, fetcher });
    const controller = new AbortController();
    const first = request(url('active'), { apiKey: 'key', signal: controller.signal });
    const rejection = expect(first).rejects.toThrow('Closed');
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    controller.abort(Error('Closed')); await rejection;
    const second = request(url('second'), { apiKey: 'key' });
    await tick(); expect(fetcher).toHaveBeenCalledOnce();
    finish(success()); await second;
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('lets a foreground subscriber outlive the first subscriber timeout', async () => {
    vi.useFakeTimers();
    let finish!: (response: Response) => void;
    let transport!: AbortSignal;
    const fetcher = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
      transport = init!.signal!; return new Promise<Response>(resolve => { finish = resolve; });
    });
    const request = createGmgnRequester({ query, fetcher });
    const first = request(url('one'), { apiKey: 'key', timeoutMs: 20 });
    const rejection = expect(first).rejects.toMatchObject({ name: 'TimeoutError' });
    const selected = request(url('one'), { apiKey: 'key', foreground: true, timeoutMs: 100 });
    await vi.advanceTimersByTimeAsync(30); await rejection;
    expect(transport.aborted).toBe(false);
    finish(success()); await expect(selected).resolves.toMatchObject({ code: 0 });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('honors the affected credential cooldown across requesters without rerouting to the healthy key', async () => {
    const pauses = new Map<unknown, { delay: number; pauseStatus: number }>();
    const sharedQuery = async (sql: string, values: unknown[]) => {
      const pause = pauses.get(values[0]);
      if (sql.startsWith('WITH clock')) return { rows: pause ? [] : [{ delay: 0 }] };
      if (sql.startsWith('UPDATE')) { pauses.set(values[0], { delay: Number(values[1]), pauseStatus: Number(values[2]) }); return { rows: [] }; }
      return { rows: pause ? [pause] : [] };
    };
    const fetcher = vi.fn(async (_input: string | URL | Request, init?: RequestInit) =>
      (init!.headers as Record<string, string>)['X-APIKEY'] === 'accounting'
        ? Response.json({ code: 429 }, { status: 429 }) : success());
    const first = createGmgnRequester({ query: sharedQuery, fetcher });
    const anotherProcess = createGmgnRequester({ query: sharedQuery, fetcher });
    await expect(first(url('data'), { apiKey: 'accounting' })).rejects.toMatchObject({ reason: 'rate_limited' });
    await expect(anotherProcess(url('data'), { apiKey: 'accounting' })).rejects.toMatchObject({ reason: 'rate_limited' });
    await expect(first(url('market'), { apiKey: 'market' })).resolves.toMatchObject({ code: 0 });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
