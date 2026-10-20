import { describe, expect, it, vi } from 'vitest';
import reference from './data/championship-reference.json' with { type: 'json' };
import { createChampionshipService, parseChampionshipBoard } from './championship.js';
import { championshipApiUrl, validChampionshipDate } from '../shared/championship.js';

const capturedAt = Date.parse(reference.capturedAt);
const payload = () => structuredClone(reference.daily.payload);

describe('official championship rankings', () => {
  it('preserves provider ranks and ratios, caps results at 20, and selects the period-specific PnL', () => {
    const data = payload();
    data.data.list.reverse();
    data.data.list.push({ ...data.data.list[0], rank: 21, user_id: '11111111-1111-4111-8111-111111111111' });
    const board = parseChampionshipBoard(data, 'daily', '2026-10-20', capturedAt);
    expect(board.items).toHaveLength(20);
    expect(board.items.map(item => item.rank)).toEqual(Array.from({ length: 20 }, (_, index) => index + 1));
    expect(board.items[0]).toMatchObject({ name: 'ladyboy⛾', xHandle: 'comethankme12', pnlUsd: '11573.50', roi: '6.2119' });
    expect(parseChampionshipBoard(reference.overall.payload, 'overall', null, capturedAt).items[0]).toMatchObject({ name: 'WaiterG', pnlUsd: '21524.70', roi: '10.8104' });
    expect(championshipApiUrl('daily', '2026-10-20')).toBe('https://gmgn.ai/pf/api/v1/global_championship/daily_leaderboard?championship_id=ggc-s1&date=20261020');
  });

  it('rejects mismatched days, provider errors, duplicate ranks and nonfinite financial values', () => {
    expect(() => parseChampionshipBoard(payload(), 'daily', '2026-10-21', capturedAt)).toThrow('different daily board');
    expect(() => parseChampionshipBoard({ code: 401, data: payload().data }, 'daily', '2026-10-20', capturedAt)).toThrow();
    const duplicate = payload(); duplicate.data.list[1].rank = 1;
    expect(() => parseChampionshipBoard(duplicate, 'daily', '2026-10-20', capturedAt)).toThrow('duplicate');
    const invalid = payload(); invalid.data.list[0].roi = 'Infinity';
    expect(() => parseChampionshipBoard(invalid, 'daily', '2026-10-20', capturedAt)).toThrow();
  });

  it('keeps missing profit unavailable, unknown traders identifiable, and unsafe stream links inert', () => {
    const data = payload();
    Object.assign(data.data.list[0], { user_id: '11111111-1111-4111-8111-111111111111', x_handle: 'new_trader', daily_pnl: null, roi: null, live_url: 'javascript:alert(1)' });
    const trader = parseChampionshipBoard(data, 'daily', '2026-10-20', capturedAt).items[0];
    expect(trader).toMatchObject({ name: 'new_trader', verified: false, avatarUrl: null, liveUrl: null, pnlUsd: null, roi: null });
  });

  it('validates real UTC competition days, including the final day and midnight rollover', () => {
    expect(validChampionshipDate('2026-10-20', capturedAt)).toBe(true);
    for (const date of ['2026-10-16', '2026-10-21', '2026-02-30', '20261020', '2026-10-20x']) expect(validChampionshipDate(date, capturedAt)).toBe(false);
    expect(validChampionshipDate('2026-10-26', Date.parse('2026-11-01'))).toBe(true);
    expect(validChampionshipDate('2026-10-27', Date.parse('2026-11-01'))).toBe(false);
    expect(validChampionshipDate('2026-10-21', Date.parse('2026-10-21T00:00:00Z'))).toBe(true);
  });
});

describe('championship feed availability and caching', () => {
  it('coalesces concurrent requests and cools down for a minute without spending API credentials', async () => {
    let now = capturedAt;
    const fetcher = vi.fn<typeof fetch>(async () => Response.json(payload()));
    const service = createChampionshipService({ fetcher, now: () => now });
    const [first, second] = await Promise.all([service.get('daily', '2026-10-20'), service.get('daily', '2026-10-20')]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(first).toEqual(second);
    expect(first.freshness).toBe('live');
    expect(fetcher.mock.calls[0]?.[1]?.headers).toEqual({ Accept: 'application/json' });
    await service.get('daily', '2026-10-20'); expect(fetcher).toHaveBeenCalledTimes(1);
    now += 60_001;
    await service.get('daily', '2026-10-20'); expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('reports HTTP 403 as a saved reference with its original update time and never uses it for another day', async () => {
    const fetcher = vi.fn(async () => new Response('blocked', { status: 403 }));
    const service = createChampionshipService({ fetcher, now: () => capturedAt });
    const board = await service.get('daily', '2026-10-20');
    expect(board).toMatchObject({ freshness: 'saved', upstreamBlocked: true, date: '2026-10-20', updatedAt: new Date(reference.daily.payload.data.updated_at * 1000).toISOString() });
    await expect(service.get('daily', '2026-10-21')).rejects.toThrow('unavailable');
    expect((await service.get('overall', null)).items[0].name).toBe('WaiterG');
    await service.get('daily', '2026-10-20'); expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('fetches changed rankings on each explicit page refresh inside the polling cooldown and coalesces concurrent loads', async () => {
    let now = capturedAt;
    const fetcher = vi.fn<typeof fetch>(async () => Response.json(payload()));
    const service = createChampionshipService({ fetcher, now: () => now });
    const first = await service.get('daily', '2026-10-20', { refresh: true });
    now += 1000;
    const changed = payload(); changed.data.updated_at += 1; changed.data.list[0].daily_pnl = '12500.00';
    fetcher.mockImplementationOnce(async () => Response.json(changed));
    const [second, concurrent] = await Promise.all([
      service.get('daily', '2026-10-20', { refresh: true }),
      service.get('daily', '2026-10-20', { refresh: true }),
    ]);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(second).toEqual(concurrent);
    expect(second.items[0].pnlUsd).toBe('12500.00');
    expect(second.freshness).toBe('live');
    expect(second.fetchedAt).not.toBe(first.fetchedAt);
    expect(second.updatedAt).toBe(new Date(changed.data.updated_at * 1000).toISOString());
    expect(fetcher.mock.calls[1]?.[1]?.cache).toBe('no-store');
    await service.get('daily', '2026-10-20');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('retries a blocked upstream on the next page load without altering the saved timestamps', async () => {
    const fetcher = vi.fn(async () => new Response('blocked', { status: 403 }));
    const service = createChampionshipService({ fetcher, now: () => capturedAt });
    const first = await service.get('overall', null, { refresh: true });
    await service.get('overall', null);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const reloaded = await service.get('overall', null, { refresh: true });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(reloaded).toMatchObject({ freshness: 'saved', upstreamBlocked: true, updatedAt: first.updatedAt, fetchedAt: first.fetchedAt });
  });

  it('marks the last good result as saved after network/parse failures without refreshing its timestamps', async () => {
    let now = capturedAt;
    const fetcher = vi.fn(async () => Response.json(payload()));
    const service = createChampionshipService({ fetcher, now: () => now });
    const good = await service.get('daily', '2026-10-20');
    now += 60_001;
    fetcher.mockRejectedValueOnce(new Error('network unavailable'));
    const failed = await service.get('daily', '2026-10-20');
    expect(failed.freshness).toBe('saved'); expect(failed.fetchedAt).toBe(good.fetchedAt); expect(failed.updatedAt).toBe(good.updatedAt);
    now += 60_001; fetcher.mockResolvedValueOnce(Response.json({ code: 0, data: {} }));
    expect((await service.get('daily', '2026-10-20')).freshness).toBe('saved');
  });

  it('persists successful snapshots and restores a newer saved snapshot when GMGN is blocked', async () => {
    const data = payload(); data.data.updated_at += 60; data.data.list[0].daily_pnl = '12000.00';
    let saved: unknown;
    const store = { load: vi.fn(async () => saved), save: vi.fn(async (_key, value) => { saved = value; }) };
    const firstService = createChampionshipService({ fetcher: async () => Response.json(data), now: () => capturedAt + 60_000, store });
    await firstService.get('daily', '2026-10-20');
    expect(store.save).toHaveBeenCalledTimes(1);
    const restarted = createChampionshipService({ fetcher: async () => new Response('', { status: 403 }), now: () => capturedAt + 120_000, store });
    const board = await restarted.get('daily', '2026-10-20');
    expect(board.items[0].pnlUsd).toBe('12000.00'); expect(board.freshness).toBe('saved');
    expect(board.updatedAt).toBe(new Date(data.data.updated_at * 1000).toISOString());
  });

  it('does not replace a snapshot with an older upstream response or label stale provider data live', async () => {
    const old = payload(); old.data.updated_at -= 1000;
    const service = createChampionshipService({ fetcher: async () => Response.json(old), now: () => capturedAt });
    const board = await service.get('daily', '2026-10-20');
    expect(board.freshness).toBe('saved');
    expect(board.updatedAt).toBe(new Date(reference.daily.payload.data.updated_at * 1000).toISOString());
    const stale = createChampionshipService({ fetcher: async () => Response.json(payload()), now: () => capturedAt + 600_000 });
    expect((await stale.get('daily', '2026-10-20')).freshness).toBe('saved');
  });
});
