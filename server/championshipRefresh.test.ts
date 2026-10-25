import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChampionshipBoard, ChampionshipPeriod } from '../shared/championship.js';
import { championshipAutoRefreshHours, createChampionshipRefresh } from './championshipRefresh.js';

const controllers: ReturnType<typeof createChampionshipRefresh>[] = [];
const at = Date.parse('2026-10-25T12:00:00.000Z');
function board(period: ChampionshipPeriod, date: string | null, changes: Partial<ChampionshipBoard> = {}): ChampionshipBoard {
  return { period, date, items: [], updatedAt: new Date(at).toISOString(), fetchedAt: new Date(at).toISOString(),
    freshness: 'live', upstreamBlocked: false, sourceUrl: 'https://gmgn.ai/', ...changes };
}
function setup(get = vi.fn(async (period: ChampionshipPeriod, date: string | null) => board(period, date)), intervalHours: number | null = 4) {
  const onCycle = vi.fn();
  const controller = createChampionshipRefresh({ service: { get }, intervalHours, onCycle });
  controllers.push(controller);
  return { controller, get, onCycle };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(at); });
afterEach(async () => {
  await Promise.all(controllers.splice(0).map(controller => controller.stop()));
  vi.useRealTimers();
});

describe('API-owned championship refresh schedule', () => {
  it('requires a bounded explicit schedule and rejects mistyped production settings', () => {
    expect(championshipAutoRefreshHours(undefined)).toBeNull();
    expect(championshipAutoRefreshHours('')).toBeNull();
    expect(championshipAutoRefreshHours('4')).toBe(4);
    expect(championshipAutoRefreshHours('24')).toBe(24);
    for (const value of ['0', '25', '-1', '4.5', 'true', 'Infinity', '4h']) {
      expect(() => championshipAutoRefreshHours(value)).toThrow('whole number');
    }
    expect(() => createChampionshipRefresh({ service: { get: vi.fn() }, intervalHours: 0 })).toThrow('Invalid');
  });

  it('does no work when disabled and exposes a disabled status', async () => {
    const { controller, get } = setup(undefined, null);
    controller.start();
    await vi.advanceTimersByTimeAsync(48 * 3_600_000);
    expect(get).not.toHaveBeenCalled();
    expect(controller.status()).toMatchObject({ enabled: false, running: false, intervalHours: null,
      lastOutcome: 'disabled', lastAttemptAt: null, nextAttemptAt: null });
  });

  it('starts one immediate cycle, refreshes both boards and schedules from completion', async () => {
    const { controller, get, onCycle } = setup();
    controller.start(); controller.start();
    expect(controller.status()).toMatchObject({ enabled: true, running: true, lastAttemptAt: new Date(at).toISOString() });
    await vi.advanceTimersByTimeAsync(0);
    expect(get.mock.calls).toEqual([
      ['daily', '2026-10-25', { refresh: true }], ['overall', null, { refresh: true }],
    ]);
    expect(controller.status()).toMatchObject({ running: false, lastOutcome: 'success',
      lastSuccessAt: new Date(at).toISOString(), nextAttemptAt: '2026-10-25T16:00:00.000Z',
      boards: { daily: { outcome: 'live', date: '2026-10-25', providerUpdatedAt: new Date(at).toISOString() } } });
    expect(onCycle).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(4 * 3_600_000);
    expect(get).toHaveBeenCalledTimes(4);
  });

  it('does not overlap cycles even when a refresh takes longer than the interval', async () => {
    const pending = deferred<void>();
    const get = vi.fn(async (period: ChampionshipPeriod, date: string | null) => {
      await pending.promise; return board(period, date);
    });
    const { controller } = setup(get);
    controller.start();
    await vi.advanceTimersByTimeAsync(5 * 3_600_000);
    expect(get).toHaveBeenCalledTimes(2);
    expect(controller.status()).toMatchObject({ running: true, nextAttemptAt: null });
    pending.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(controller.status()).toMatchObject({ running: false, nextAttemptAt: '2026-10-25T21:00:00.000Z' });
  });

  it('marks a resolved blocked fallback honestly and preserves provider timestamps', async () => {
    const get = vi.fn(async (period: ChampionshipPeriod, date: string | null) =>
      board(period, date, { freshness: 'saved', upstreamBlocked: true }));
    const { controller } = setup(get);
    controller.start(); await vi.advanceTimersByTimeAsync(0);
    expect(controller.status()).toMatchObject({ lastOutcome: 'blocked', lastSuccessAt: null,
      boards: { daily: { outcome: 'blocked', providerUpdatedAt: new Date(at).toISOString(), fetchedAt: new Date(at).toISOString() },
        overall: { outcome: 'blocked' } } });
    await vi.advanceTimersByTimeAsync(4 * 3_600_000);
    expect(controller.status().boards.daily.fetchedAt).toBe(new Date(at).toISOString());
  });

  it('counts saved results and unavailable boards separately from a successful update', async () => {
    const get = vi.fn(async (period: ChampionshipPeriod, date: string | null) => board(period, date));
    const { controller } = setup(get);
    controller.start(); await vi.advanceTimersByTimeAsync(0);
    const firstSuccess = controller.status().lastSuccessAt;
    get.mockImplementation(async (period, date) => board(period, date, { freshness: 'saved' }));
    await vi.advanceTimersByTimeAsync(4 * 3_600_000);
    expect(controller.status()).toMatchObject({ lastOutcome: 'saved', lastSuccessAt: firstSuccess });
    get.mockRejectedValue(new Error('private upstream credential failure'));
    await vi.advanceTimersByTimeAsync(4 * 3_600_000);
    expect(controller.status()).toMatchObject({ lastOutcome: 'failed', lastSuccessAt: firstSuccess,
      boards: { daily: { outcome: 'unavailable', providerUpdatedAt: new Date(at).toISOString() } } });
    expect(JSON.stringify(controller.status())).not.toContain('private');
  });

  it('refreshes the new Daily UTC date at midnight ahead of the four-hour interval', async () => {
    vi.setSystemTime('2026-10-25T23:59:00.000Z');
    const { controller, get } = setup();
    controller.start(); await vi.advanceTimersByTimeAsync(0);
    expect(controller.status().nextAttemptAt).toBe('2026-10-26T00:00:00.000Z');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(get.mock.calls[2]).toEqual(['daily', '2026-10-26', { refresh: true }]);
  });

  it('immediately catches up if a cycle spans UTC midnight and does not carry yesterday into an unavailable day', async () => {
    vi.setSystemTime('2026-10-25T23:59:59.000Z');
    const pending = deferred<void>();
    const get = vi.fn(async (period: ChampionshipPeriod, date: string | null) => {
      await pending.promise;
      if (date === '2026-10-26') throw new Error('new day unavailable');
      return board(period, date);
    });
    const { controller } = setup(get);
    controller.start();
    await vi.advanceTimersByTimeAsync(2000);
    pending.resolve();
    await vi.advanceTimersByTimeAsync(1);
    expect(get.mock.calls[2]).toEqual(['daily', '2026-10-26', { refresh: true }]);
    expect(controller.status().boards.daily).toEqual({ date: '2026-10-26', outcome: 'unavailable',
      providerUpdatedAt: null, fetchedAt: null });
  });

  it('keeps requesting the last valid competition date after qualifiers end', async () => {
    vi.setSystemTime('2026-10-28T12:00:00.000Z');
    const { controller, get } = setup();
    controller.start(); await vi.advanceTimersByTimeAsync(0);
    expect(get.mock.calls[0]).toEqual(['daily', '2026-10-26', { refresh: true }]);
  });

  it('waits for the current cycle on close and never schedules work after shutdown', async () => {
    const pending = deferred<void>();
    const get = vi.fn(async (period: ChampionshipPeriod, date: string | null) => {
      await pending.promise; return board(period, date);
    });
    const { controller } = setup(get);
    controller.start();
    let closed = false;
    const closing = controller.stop().then(() => { closed = true; });
    await Promise.resolve(); expect(closed).toBe(false);
    pending.resolve(); await closing;
    expect(controller.status()).toMatchObject({ running: false, nextAttemptAt: null });
    controller.start();
    await vi.advanceTimersByTimeAsync(24 * 3_600_000);
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('keeps status snapshots isolated from callers and keeps retrying if reporting fails', async () => {
    const get = vi.fn(async (period: ChampionshipPeriod, date: string | null) => board(period, date));
    const controller = createChampionshipRefresh({ service: { get }, intervalHours: 4, onCycle() { throw Error('logger unavailable'); } });
    controllers.push(controller);
    controller.start(); await vi.advanceTimersByTimeAsync(0);
    controller.status().boards.daily.outcome = 'unavailable';
    expect(controller.status().boards.daily.outcome).toBe('live');
    await vi.advanceTimersByTimeAsync(4 * 3_600_000);
    expect(get).toHaveBeenCalledTimes(4);
  });
});
