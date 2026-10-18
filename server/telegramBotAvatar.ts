import sharp from 'sharp';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { authSessionSecret } from './telegramAuth.js';
import { createHash } from 'node:crypto';

export async function ensureTelegramAvatarSchema(db: Pool) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(782330)');
    await client.query(`CREATE TABLE IF NOT EXISTS auth_telegram_avatars (
    telegram_id bigint PRIMARY KEY, image bytea, checked_at timestamptz NOT NULL DEFAULT now()
  )`);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}

/** Cache only normalized image bytes, never Telegram's credential-bearing file URL. */
export function createTelegramAvatarCache(db: Pool, photo: (telegramId: string) => Promise<Buffer | null>) {
  const jobs = new Map<string, Promise<string | null>>();
  async function load(id: string) {
    const existing = await db.query('SELECT image,checked_at FROM auth_telegram_avatars WHERE telegram_id=$1', [id]);
    const row = existing.rows[0];
    const url = `/api/auth/telegram/avatar/${id}`;
    if (row && Date.now() - new Date(row.checked_at).getTime() < (row.image ? 86_400_000 : 300_000)) return row.image ? url : null;
    let data: Buffer | null = null;
    try {
      const bytes = await photo(id);
      if (bytes) data = await sharp(bytes, { limitInputPixels: 16_777_216, animated: false }).rotate().resize(128, 128, { fit: 'cover' }).webp({ quality: 80 }).toBuffer();
    } catch { /* An optional photo must never prevent authentication. */ }
    if (!data && row?.image) return url;
    await db.query(`INSERT INTO auth_telegram_avatars(telegram_id,image) VALUES($1,$2)
      ON CONFLICT(telegram_id) DO UPDATE SET image=EXCLUDED.image,checked_at=now()`, [id, data]);
    return data ? url : null;
  }
  return (id: string) => {
    let pending = jobs.get(id);
    if (!pending) { pending = load(id).catch(() => null).finally(() => { jobs.delete(id); }); jobs.set(id, pending); }
    return pending;
  };
}

export function registerTelegramAvatarRoute(app: FastifyInstance, db: Pool) {
  app.get<{ Params: { id: string } }>('/api/auth/telegram/avatar/:id', { logLevel: 'silent' }, async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store').header('Vary', 'Cookie').header('Referrer-Policy', 'no-referrer').header('X-Content-Type-Options', 'nosniff');
    const value = authSessionSecret(request.headers.cookie);
    if (!value || !/^[1-9][0-9]{0,15}$/.test(request.params.id)) return reply.code(404).send();
    const result = await db.query(`SELECT a.image FROM auth_telegram_avatars a JOIN auth_users u ON u.telegram_id=a.telegram_id
      JOIN auth_sessions s ON s.user_id=u.id WHERE s.secret_hash=$1 AND s.expires_at>now() AND a.telegram_id=$2`,
    [createHash('sha256').update(value).digest('hex'), request.params.id]);
    if (!result.rows[0]?.image) return reply.code(404).send();
    return reply.type('image/webp').send(result.rows[0].image);
  });
}
