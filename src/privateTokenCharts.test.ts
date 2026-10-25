import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPrivateTokenChartRequests, privateTokenChartRequests, tokenChartContextKey } from './privateTokenCharts';
import { createTokenChartRequests } from './tokenChartRequest';
const token = '0x' + '1'.repeat(40), wallet = '0x' + '2'.repeat(40), now = Date.parse('2026-10-21T12:00:00Z');
const chart = () => ({ address: token, period: '1m', resolution: '1m', candles: [{ time: now / 1000 - 60, open: 1, high: 2, low: 1, close: 2, volume: 50 }],
  points: [], source: 'gmgn', updatedAt: new Date(now).toISOString(), pending: false, stale: false });
afterEach(() => vi.unstubAllGlobals());
describe('private Portfolio token chart scope', () => {
  it('uses the authorized wallet route, owner header and current membership revision', async () => {
    const fetcher = vi.fn(async () => Response.json(chart()));
    const requests = createPrivateTokenChartRequests({ accountId: 'account-one', walletAddress: wallet, membershipRevision: 'revision-one' }, { fetcher, now: () => now });
    await requests.request(token, '1m');
    const [url, options] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain(`/api/journal/wallets/${wallet}/tokens/${token}/chart?`); expect(url).toContain('membership=revision-one');
    expect(new Headers(options.headers).get('X-Watchlist-Owner')).toBe('account-one');
    expect(url).not.toMatch(/^\/api\/tokens/);
  });
  it('separates public, another account and removal/re-addition caches while sharing the same active membership', async () => {
    const fetcher = vi.fn(async () => Response.json(chart())); vi.stubGlobal('fetch', fetcher);
    const context = { accountId: 'private-one', walletAddress: wallet, membershipRevision: 'member-one' };
    const first = privateTokenChartRequests(context), same = privateTokenChartRequests({ ...context });
    expect(first).toBe(same); await first.request(token, '1m');
    const other = privateTokenChartRequests({ ...context, accountId: 'private-two' }), readded = privateTokenChartRequests({ ...context, membershipRevision: 'member-two' });
    expect(other.peek(token, '1m')).toBeNull(); expect(readded.peek(token, '1m')).toBeNull();
    expect(createTokenChartRequests({ storage: null }).peek(token, '1m')).toBeNull();
    expect(tokenChartContextKey(context)).not.toBe(tokenChartContextKey({ ...context, membershipRevision: 'member-two' }));
  });
  it('never persists private chart identities to browser storage and never falls back to the public route on denial', async () => {
    const getItem = vi.fn(), setItem = vi.fn(); vi.stubGlobal('window', { sessionStorage: { getItem, setItem } });
    const fetcher = vi.fn(async () => new Response('{}', { status: 403 }));
    const requests = createPrivateTokenChartRequests({ accountId: 'denied', walletAddress: wallet }, { fetcher, now: () => now });
    await expect(requests.request(token, '1m')).rejects.toThrow('403');
    expect(fetcher).toHaveBeenCalledOnce(); expect(getItem).not.toHaveBeenCalled(); expect(setItem).not.toHaveBeenCalled();
    expect(requests.peek(token, '1m')).toBeNull();
  });
});
