import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadWatchlist, mutateWatchlist, watchlistIdentityChanged } from './watchlistClient';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
describe('account-bound watchlist requests', () => {
  it('binds private reads to the current account and prevents browser caching', async () => {
    const payload = { items: [], preferences: {} }, fetcher = vi.fn().mockResolvedValue(Response.json(payload));
    vi.stubGlobal('fetch', fetcher);
    expect(await loadWatchlist('/api/watchlist?period=7d', 'account-id')).toEqual(payload);
    expect(fetcher).toHaveBeenCalledWith('/api/watchlist?period=7d', expect.objectContaining({ method: 'GET', cache: 'no-store', headers: { Accept: 'application/json', 'X-Watchlist-Owner': 'account-id' } }));
  });
  it('adds one favorite without submitting an outdated list from another device', async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ items: [] })); vi.stubGlobal('fetch', fetcher);
    await mutateWatchlist('/api/watchlist/items/token/0x123', 'PUT', 'guest');
    expect(fetcher).toHaveBeenCalledWith('/api/watchlist/items/token/0x123', expect.objectContaining({ method: 'PUT', headers: { Accept: 'application/json', 'X-Watchlist-Owner': 'guest' } }));
    expect(fetcher.mock.calls[0][1]).not.toHaveProperty('body');
  });
  it('binds removal, clearing, and preferences to the same authenticated owner', async () => {
    const fetcher = vi.fn().mockImplementation(async () => Response.json({ items: [] })); vi.stubGlobal('fetch', fetcher);
    await mutateWatchlist('/api/watchlist/items/kol/0x123', 'DELETE', 'account-id');
    await mutateWatchlist('/api/watchlist', 'DELETE', 'account-id');
    await mutateWatchlist('/api/watchlist', 'PUT', 'account-id', { preferences: { muted: true } });
    for (const call of fetcher.mock.calls) expect(call[1].headers['X-Watchlist-Owner']).toBe('account-id');
    expect(fetcher.mock.calls[2][1].body).toBe('{"preferences":{"muted":true}}');
  });
  it.each([401, 409])('recognizes identity change (%i) without retrying a mutation under a different account', async status => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ error: 'Watchlist changed' }, { status })); vi.stubGlobal('fetch', fetcher);
    const reason = await mutateWatchlist('/api/watchlist', 'DELETE', 'old-account').catch(reason => reason);
    expect(watchlistIdentityChanged(reason)).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('does not treat service errors as an account switch', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ error: 'Service unavailable' }, { status: 503 })));
    const reason = await loadWatchlist('/api/watchlist', 'guest').catch(reason => reason);
    expect(watchlistIdentityChanged(reason)).toBe(false);
    expect(reason.message).toBe('Service unavailable');
  });
  it('bounds a stalled request so favorite controls can recover', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn().mockImplementation((_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('Aborted'))))));
    const response = loadWatchlist('/api/watchlist', 'guest').catch(reason => reason);
    await vi.advanceTimersByTimeAsync(15_000);
    expect((await response).message).toBe('Aborted');
  });
});
