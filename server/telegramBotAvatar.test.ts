import Fastify from 'fastify';
import sharp from 'sharp';
import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { createTelegramAvatarCache, registerTelegramAvatarRoute } from './telegramBotAvatar.js';

describe('private Telegram profile photos', () => {
  it('coalesces profile loading and stores only normalized image bytes', async () => {
    const image = await sharp({ create: { width: 400, height: 200, channels: 3, background: '#c0ffee' } }).png().toBuffer();
    const photo = vi.fn(async () => image);
    let stored: Buffer | null = null;
    const query = vi.fn(async (sql: string, args: unknown[]) => {
      if (sql.startsWith('SELECT')) return { rows: stored ? [{ image: stored, checked_at: new Date() }] : [] };
      stored = args[1] as Buffer; return { rows: [] };
    });
    const load = createTelegramAvatarCache({ query } as unknown as Pool, photo);
    expect(await Promise.all([load('123'), load('123')])).toEqual(['/api/auth/telegram/avatar/123', '/api/auth/telegram/avatar/123']);
    expect(photo).toHaveBeenCalledTimes(1);
    const metadata = await sharp(stored!).metadata();
    expect(metadata.format).toBe('webp'); expect(metadata.width).toBe(128); expect(metadata.height).toBe(128);
    await load('123'); expect(photo).toHaveBeenCalledTimes(1);
  });
  it('keeps an existing photo if a refresh is unavailable', async () => {
    const query = vi.fn(async () => ({ rows: [{ image: Buffer.from('saved'), checked_at: '2020-01-01' }] }));
    const load = createTelegramAvatarCache({ query } as unknown as Pool, async () => null);
    expect(await load('123')).toBe('/api/auth/telegram/avatar/123');
    expect(query).toHaveBeenCalledTimes(1);
  });
  it('requires a live owner session and never serves another account photo', async () => {
    const app = Fastify();
    const query = vi.fn(async (_sql: string, args: unknown[]) => ({ rows: args[1] === '123' ? [{ image: Buffer.from('webp') }] : [] }));
    registerTelegramAvatarRoute(app, { query } as unknown as Pool);
    try {
      expect((await app.inject('/api/auth/telegram/avatar/123')).statusCode).toBe(404);
      expect(query).not.toHaveBeenCalled();
      const headers = { cookie: 'bscan_auth=' + 'a'.repeat(64) };
      const good = await app.inject({ url: '/api/auth/telegram/avatar/123', headers });
      expect(good.statusCode).toBe(200); expect(good.headers['cache-control']).toBe('private, no-store');
      expect(good.headers['content-type']).toBe('image/webp');
      expect(query.mock.calls[0][0]).toContain('s.user_id=u.id');
      expect((await app.inject({ url: '/api/auth/telegram/avatar/456', headers })).statusCode).toBe(404);
    } finally { await app.close(); }
  });
});
