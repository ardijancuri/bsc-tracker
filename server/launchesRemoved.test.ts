import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerIntelligenceRoutes } from './intelligenceApi.js';

const mocks = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('./db.js', () => ({ pool: { query: mocks.query } }));
const apps: ReturnType<typeof Fastify>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map(app => app.close()));
  vi.resetAllMocks();
});

describe('retired public Launches feature', () => {
  it.each([
    '/api/launches',
    '/api/launches?platform=flap&stage=bonding',
    '/api/tokens/0x1111111111111111111111111111111111111111/launch',
    '/api/tokens/not-an-address/launch',
  ])('does not register %s or query its projection', async url => {
    const app = Fastify();
    registerIntelligenceRoutes(app);
    apps.push(app);
    const response = await app.inject(url);
    expect(response.statusCode).toBe(404);
    expect(mocks.query).not.toHaveBeenCalled();
  });
});
