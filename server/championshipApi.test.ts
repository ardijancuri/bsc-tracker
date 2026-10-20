import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { registerChampionshipRoutes } from './championshipApi.js';

const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });
function setup(fail = false) {
  const service = { get: vi.fn(async (_period, _date) => { if (fail) throw new Error('upstream error with private details'); return { items: [] } as never; }) };
  const app = Fastify(); apps.push(app); registerChampionshipRoutes(app, service); return { app, service };
}
describe('public championship endpoint', () => {
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
