import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerIntelligenceRoutes } from './intelligenceApi.js';

const mocks = vi.hoisted(() => ({ query: vi.fn(), resolveUser: vi.fn() }));
vi.mock('./db.js', () => ({ pool: { query: mocks.query } }));
vi.mock('./telegramAuth.js', async importOriginal => ({ ...await importOriginal<typeof import('./telegramAuth.js')>(), resolveAuthUser: mocks.resolveUser }));
const apps: ReturnType<typeof Fastify>[] = [];
const origin = 'https://kollens.com';
const oldPreferences = { windowMinutes: 30, minBuyers: 2, categories: ['clustered_buys'], muted: true };
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); vi.resetAllMocks(); vi.unstubAllEnvs(); });
function setup() {
  vi.stubEnv('PUBLIC_APP_URL', origin); vi.stubEnv('NODE_ENV', 'production');
  const app = Fastify(); registerIntelligenceRoutes(app); apps.push(app);
  mocks.resolveUser.mockResolvedValue(null); mocks.query.mockResolvedValue({ rows: [] });
  return app;
}

describe('removed watchlist and Radar filters', () => {
  it('returns only favorites and period for a new guest', async () => {
    const app = setup();
    const response = await app.inject('/api/watchlist');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ items: [], period: '24h' });
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it.each([{ preferences: oldPreferences }, { items: [], preferences: oldPreferences }])('rejects obsolete saved filters without mutating storage', async payload => {
    const app = setup();
    const response = await app.inject({ method: 'PUT', url: '/api/watchlist', headers: { origin }, payload });
    expect(response.statusCode).toBe(400);
    expect(mocks.query).not.toHaveBeenCalled();
    expect(mocks.resolveUser).not.toHaveBeenCalled();
  });

  it('uses system signal settings regardless of old account filters', async () => {
    const app = setup();
    mocks.resolveUser.mockResolvedValue({ id: 'account', name: 'Account', username: null, avatarUrl: null, preferences: oldPreferences });
    const response = await app.inject('/api/signals');
    expect(response.statusCode).toBe(200);
    const [sql, values] = mocks.query.mock.calls[0];
    expect(values).toEqual([10, 3, 21]);
    expect(sql).not.toContain('s.kind=ANY(');
    expect(sql).not.toContain('preferences');
  });

  it('does not expose saved account filters in the watchlist', async () => {
    const app = setup();
    mocks.resolveUser.mockResolvedValue({ id: 'account', name: 'Account', username: null, avatarUrl: null, preferences: oldPreferences });
    const response = await app.inject('/api/watchlist?period=7d');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ items: [], period: '7d' });
  });
});
