import { createHash, randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { analyticsDay, analyticsPublicPath } from '../shared/analytics.js';
import { registerAnalytics } from './analytics.js';

describe('website analytics', () => {
  it('uses Skopje midnight in both summer and winter', () => {
    expect(analyticsDay(new Date('2026-06-30T21:59:59Z'))).toBe('2026-06-30');
    expect(analyticsDay(new Date('2026-06-30T22:00:00Z'))).toBe('2026-07-01');
    expect(analyticsDay(new Date('2026-11-10T22:59:59Z'))).toBe('2026-11-10');
    expect(analyticsDay(new Date('2026-11-10T23:00:00Z'))).toBe('2026-11-11');
  });

  it('counts canonical public navigation and rejects sensitive or ambiguous paths', () => {
    expect(analyticsPublicPath('/')).toBe('/');
    expect(analyticsPublicPath('/tokens/')).toBe('/tokens');
    expect(analyticsPublicPath('/kol/0x' + 'A'.repeat(40))).toBe('/kol/0x' + 'a'.repeat(40));
    for (const path of ['//', '/trades', '/creator', '/watchlist', '/portfolio', '/extension/connect', '/tokens?account=private']) {
      expect(analyticsPublicPath(path), path).toBeNull();
    }
  });

  it('filters private traffic and sends only hashed keys to storage', async () => {
    const app = Fastify();
    const query = vi.fn<(...args: unknown[]) => Promise<void>>(async () => {});
    registerAnalytics(app, { query } as unknown as Pick<Pool, 'query'>);
    try {
      await app.ready();
      query.mockClear();
      const payload = { id: randomUUID(), visitor: randomUUID(), path: '/token/0x' + 'a'.repeat(40) };
      const post = (headers: Record<string, string>, path = payload.path) => app.inject({
        method: 'POST',
        url: '/api/analytics/page-view',
        headers: { origin: 'https://kollens.com', 'user-agent': 'Mozilla/5.0 Chrome/140.0.0.0', ...headers },
        payload: { ...payload, path },
      });
      expect((await post({ dnt: '1' })).statusCode).toBe(204);
      expect((await post({ 'sec-gpc': '1' })).statusCode).toBe(204);
      expect((await post({ 'user-agent': 'Googlebot' })).statusCode).toBe(204);
      expect((await post({ origin: 'https://other.example' })).statusCode).toBe(403);
      expect((await post({ 'sec-fetch-site': 'cross-site' })).statusCode).toBe(403);
      expect((await post({}, '/portfolio')).statusCode).toBe(400);
      expect(query).not.toHaveBeenCalled();

      expect((await post({ 'sec-fetch-site': 'same-origin' })).statusCode).toBe(204);
      expect(query).toHaveBeenCalledTimes(1);
      const [day, eventDigest, visitorDigest] = query.mock.calls[0][1] as [string, Buffer, Buffer];
      expect(day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(eventDigest).toEqual(createHash('sha256').update(payload.id).digest());
      expect(visitorDigest).toEqual(createHash('sha256').update(`${day}:${payload.visitor}`).digest());
      expect(JSON.stringify(query.mock.calls)).not.toContain(payload.path);
    } finally {
      await app.close();
    }
  });
});
