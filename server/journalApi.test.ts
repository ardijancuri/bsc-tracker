import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { registerJournalRoutes } from './journalApi.js';
import { JournalInputError } from './journalService.js';

const user = { id: 'account-a', name: 'Test', username: null, avatarUrl: null };
const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); vi.unstubAllEnvs(); });
function setup(authenticated = true) {
  vi.stubEnv('PUBLIC_APP_URL', 'https://kollens.com'); vi.stubEnv('NODE_ENV', 'production');
  const service = { list: vi.fn(async () => ({ wallets: [], limit: 3 })), add: vi.fn(async () => ({ wallets: [], limit: 3 })),
    updateLabel: vi.fn(async () => ({ wallets: [], limit: 3 })), remove: vi.fn(async () => ({ wallets: [], limit: 3 })),
    summary: vi.fn(async () => ({ complete: false, positions: [] })),
    activity: vi.fn(async () => ({ trades: [], cursor: null })), tokenActivity: vi.fn(async () => ({ journal: { private: true } })),
    replayChart: vi.fn(async () => ({ points: [] })), authorize: vi.fn() };
  const app = Fastify({ logger: false }); apps.push(app);
  registerJournalRoutes(app, { service: service as never, resolveUser: async () => authenticated ? user : null });
  return { app, service };
}
describe('private journal API boundaries', () => {
  it('requires authentication before any data or replay work', async () => {
    const { app, service } = setup(false);
    for (const url of ['/api/journal/wallets', '/api/journal/summary', '/api/journal/positions', '/api/journal/activity', '/api/journal/wallets/0xabc/tokens/0xdef/activity?replay=true', '/api/journal/wallets/0xabc/tokens/0xdef/replay-chart']) {
      const response = await app.inject({ url }); expect(response.statusCode).toBe(401); expect(response.headers['cache-control']).toContain('no-store');
    }
    for (const method of Object.values(service)) expect(method).not.toHaveBeenCalled();
  });
  it('rejects stale account UI context without dispatch', async () => {
    const { app, service } = setup();
    const response = await app.inject({ url: '/api/journal/summary', headers: { 'x-watchlist-owner': 'different-account' } });
    expect(response.statusCode).toBe(409); expect(service.summary).not.toHaveBeenCalled();
  });
  it('requires the app origin for add, removal and label mutations', async () => {
    const { app, service } = setup();
    for (const [method, url] of [['POST', '/api/journal/wallets'], ['PATCH', '/api/journal/wallets/0xabc'], ['DELETE', '/api/journal/wallets/0xabc']] as const) {
      const response = await app.inject({ method, url, headers: { origin: 'https://attacker.invalid' }, ...(method === 'DELETE' ? {} : { payload: {} }) });
      expect(response.statusCode).toBe(403);
    }
    expect(service.add).not.toHaveBeenCalled(); expect(service.remove).not.toHaveBeenCalled();
  });
  it('does not expose the retired older-history endpoint', async () => {
    const { app } = setup();
    expect((await app.inject({ method: 'POST', url: '/api/journal/wallets/0xabc/older', headers: { origin: 'https://kollens.com' } })).statusCode).toBe(404);
  });
  it('binds every read and export to the current account, including frozen snapshots', async () => {
    const { app, service } = setup();
    await app.inject({ url: '/api/journal/summary?wallet=all' }); expect(service.summary).toHaveBeenCalledWith(user.id, 'all');
    await app.inject({ url: '/api/journal/wallets/0xABC/tokens/0xDEF/activity?replay=true&snapshot=abc' });
    expect(service.tokenActivity).toHaveBeenCalledWith(user.id, '0xabc', '0xdef', true, 'abc');
    const chart = await app.inject({ url: '/api/journal/wallets/0xABC/tokens/0xDEF/replay-chart?end=current&snapshot=abc' });
    expect(service.replayChart).toHaveBeenCalledWith(user.id, '0xabc', '0xdef', true, 'abc');
    expect(chart.headers.vary).toBe('Cookie'); expect(chart.headers['referrer-policy']).toBe('no-referrer');
  });
  it('does not expose internal provider responses or labels in errors', async () => {
    const { app, service } = setup(); service.summary.mockRejectedValueOnce(Error('secret upstream response and private label'));
    const response = await app.inject({ url: '/api/journal/summary' }); expect(response.statusCode).toBe(503);
    expect(response.body).not.toMatch(/secret|upstream|label/);
    service.remove.mockRejectedValueOnce(new JournalInputError('Portfolio wallet not found', 404));
    expect((await app.inject({ method: 'DELETE', url: '/api/journal/wallets/nope', headers: { origin: 'https://kollens.com' } })).statusCode).toBe(404);
  });
});
