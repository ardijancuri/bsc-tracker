import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { registerChampionshipRoutes } from './championshipApi.js';
import type { ChampionshipBoard, ChampionshipPeriod } from '../shared/championship.js';

const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map(app => app.close()));
  vi.unstubAllEnvs();
});
function setup(fail = false) {
  const service = { get: vi.fn(async (_period, _date) => { if (fail) throw new Error('upstream error with private details'); return { items: [] } as never; }) };
  const app = Fastify(); apps.push(app); registerChampionshipRoutes(app, service); return { app, service };
}
describe('public championship endpoint', () => {
  it('exposes an uncached disabled scheduler status without making background requests by default', async () => {
    vi.stubEnv('CHAMPIONSHIP_AUTO_REFRESH_HOURS', '');
    const { app, service } = setup();
    const response = await app.inject('/api/championship/status');
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toMatchObject({ enabled: false, intervalHours: null, running: false,
      lastOutcome: 'disabled', lastAttemptAt: null, nextAttemptAt: null });
    expect(service.get).not.toHaveBeenCalled();
  });
  it('starts the enabled scheduler on readiness without waiting for upstream requests', async () => {
    vi.stubEnv('CHAMPIONSHIP_AUTO_REFRESH_HOURS', '4');
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const get = vi.fn(async (period: ChampionshipPeriod, date: string | null): Promise<ChampionshipBoard> => {
      await pending;
      return { period, date, items: [], updatedAt: '2026-10-25T12:00:00.000Z', fetchedAt: '2026-10-25T12:00:00.000Z',
        freshness: 'saved', upstreamBlocked: true, sourceUrl: 'https://gmgn.ai/' };
    });
    const app = Fastify(); apps.push(app);
    registerChampionshipRoutes(app, { get });
    await app.ready();
    expect(get).toHaveBeenCalledTimes(2);
    const running = await app.inject('/api/championship/status');
    expect(running.json()).toMatchObject({ enabled: true, intervalHours: 4, running: true, nextAttemptAt: null });
    release();
    await new Promise<void>(resolve => setImmediate(resolve));
    const completed = await app.inject('/api/championship/status');
    expect(completed.json()).toMatchObject({ running: false, lastOutcome: 'blocked', lastSuccessAt: null,
      boards: { overall: { outcome: 'blocked', providerUpdatedAt: '2026-10-25T12:00:00.000Z' } } });
    expect(completed.json().nextAttemptAt).toEqual(expect.any(String));
  });
  it('rejects an invalid configured interval during app registration', () => {
    vi.stubEnv('CHAMPIONSHIP_AUTO_REFRESH_HOURS', 'hourly');
    const app = Fastify(); apps.push(app);
    expect(() => registerChampionshipRoutes(app, { get: vi.fn() })).toThrow('whole number');
  });
  it('dispatches each tab independently and keeps the browser response uncached', async () => {
    const { app, service } = setup();
    const daily = await app.inject('/api/championship?period=daily&date=2026-10-20');
    expect(daily.statusCode).toBe(200); expect(daily.headers['cache-control']).toBe('no-store');
    expect(service.get).toHaveBeenLastCalledWith('daily', '2026-10-20');
    expect((await app.inject('/api/championship?period=overall')).statusCode).toBe(200);
    expect(service.get).toHaveBeenLastCalledWith('overall', null);
  });
  it('rejects unsupported periods, invalid dates and future dates before touching the provider', async () => {
    const { app, service } = setup();
    for (const query of ['period=points', 'period=daily&date=2026-02-30', 'period=daily&date=9999-10-20', 'period=daily&date=2026-10-16', 'period=overall&refresh=yes']) {
      expect((await app.inject('/api/championship?' + query)).statusCode).toBe(400);
    }
    expect(service.get).not.toHaveBeenCalled();
  });
  it('bypasses the service cooldown for page loads and manual refreshes on either tab', async () => {
    const { app, service } = setup();
    expect((await app.inject('/api/championship?period=overall&refresh=1')).statusCode).toBe(200);
    expect(service.get).toHaveBeenLastCalledWith('overall', null, { refresh: true });
    expect((await app.inject('/api/championship?period=daily&date=2026-10-20&refresh=1')).statusCode).toBe(200);
    expect(service.get).toHaveBeenLastCalledWith('daily', '2026-10-20', { refresh: true });
  });
  it('returns a retryable, sanitized failure when the requested day has no saved result', async () => {
    const { app } = setup(true);
    const response = await app.inject('/api/championship?period=overall');
    expect(response.statusCode).toBe(503); expect(response.headers['retry-after']).toBe('60');
    expect(response.json()).toEqual({ error: 'Championship rankings are unavailable' });
    expect(response.body).not.toContain('private');
  });
});
