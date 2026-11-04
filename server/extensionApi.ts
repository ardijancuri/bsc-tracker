import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { resolveAuthUser, type ResolvedAuthUser } from './telegramAuth.js';
import { defaultExtensionPreferences, extensionMatchTypes, extensionTokenImageUrl, type ExtensionAuthOptions, type ExtensionPreferences, type ExtensionWorkspace } from '../shared/extension.js';
import { registerExtensionSocial, type ExtensionSocialProviders } from './extensionSocial.js';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const challenge = (value: string) => createHash('sha256').update(value).digest('base64url');
const verifierSchema = z.string().regex(/^[A-Za-z0-9_-]{43,128}$/);
const proofSchema = z.string().regex(/^[a-f0-9]{64}$/);
const idSchema = z.string().uuid();
const addressSchema = z.string().regex(/^0x[0-9a-f]{40}$/);
const preferencesSchema = z.object({
  highlights: z.boolean(), matchTypes: z.array(z.enum(extensionMatchTypes)).max(4).refine(a => new Set(a).size === a.length),
  newGroups: z.boolean(), newMembers: z.boolean(), watchedOnly: z.boolean(), sound: z.boolean(),
}).strict();
const itemSchema = z.object({
  chainId: z.literal(56), name: z.string().max(120), symbol: z.string().max(40),
  logoUrl:z.string().max(2048).refine(value=>extensionTokenImageUrl(value)!==null).nullable().optional(),
  pinned: z.boolean(), note: z.string().max(2000), revision: z.number().int().nonnegative().safe(),
}).strict();
const clean = (value: string) => value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
type DatabaseClient = Pick<PoolClient, 'query'>;

export function extensionRequestOrigin(req: FastifyRequest, allowedOrigins: ReadonlySet<string>) {
  const tag = req.headers['x-kollens-extension-origin'];
  const origin = req.headers.origin ?? (typeof tag === 'string' ? tag : undefined);
  return origin && allowedOrigins.has(origin) && (tag === undefined || tag === origin) ? origin : null;
}

function matchesProof(stored: string | null, expected: string) {
  return stored !== null && Buffer.byteLength(stored) === Buffer.byteLength(expected)
    && timingSafeEqual(Buffer.from(stored), Buffer.from(expected));
}

export async function readExtensionNativePairing(db: DatabaseClient, id: string, origin: string, verifier: string) {
  if (!verifierSchema.safeParse(verifier).success) return null;
  const { rows: [row] } = await db.query<{ expires_at: Date; verifier_challenge: string }>(`SELECT expires_at,verifier_challenge
    FROM extension_pairing_attempts WHERE id=$1 AND extension_origin=$2 AND mode='native'
    AND expires_at>now() AND consumed_at IS NULL AND user_id IS NULL`, [id, origin]);
  return row && matchesProof(row.verifier_challenge, challenge(verifier)) ? { expires_at: row.expires_at } : null;
}

/** Two non-financial tables. All existing accounts/session values are preserved. */
export const extensionSchemaSql = `
  CREATE TABLE IF NOT EXISTS extension_pairing_attempts (
    id uuid PRIMARY KEY, verifier_challenge text NOT NULL, extension_origin text NOT NULL,
    user_id uuid REFERENCES auth_users(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
    consumed_at timestamptz
  );
  CREATE INDEX IF NOT EXISTS extension_pairing_expiry_idx ON extension_pairing_attempts(expires_at);
  ALTER TABLE extension_pairing_attempts ADD COLUMN IF NOT EXISTS mode text NOT NULL DEFAULT 'web' CHECK(mode IN ('web','native'));
  ALTER TABLE extension_pairing_attempts ADD COLUMN IF NOT EXISTS completion_hash text;
  ALTER TABLE auth_users ADD COLUMN IF NOT EXISTS email text;
  CREATE TABLE IF NOT EXISTS extension_account_links (
    user_id uuid NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
    provider text NOT NULL CHECK(provider IN ('telegram','x')),
    subject text NOT NULL, username text,
    PRIMARY KEY(user_id,provider), UNIQUE(provider,subject)
  );
  CREATE TABLE IF NOT EXISTS extension_saved_tokens (
    user_id uuid NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
    chain_id integer NOT NULL CHECK(chain_id=56), address text NOT NULL CHECK(address ~ '^0x[0-9a-f]{40}$'),
    name text NOT NULL CHECK(length(name)<=120), symbol text NOT NULL CHECK(length(symbol)<=40),
    pinned boolean NOT NULL DEFAULT true, note text NOT NULL DEFAULT '' CHECK(length(note)<=2000),
    revision bigint NOT NULL DEFAULT 1, updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY(user_id,chain_id,address)
  );
  ALTER TABLE extension_saved_tokens ADD COLUMN IF NOT EXISTS logo_url text CHECK(length(logo_url)<=2048);`;

export async function ensureExtensionSchema(db: Pool) {
  await db.query(extensionSchemaSql);
}
function storedPreferences(raw: unknown): { preferences: ExtensionPreferences; revision: number } {
  const value = raw as { settings?: unknown; revision?: unknown } | null;
  const result = preferencesSchema.safeParse(value?.settings);
  return { preferences: result.success ? result.data : { ...defaultExtensionPreferences },
    revision: typeof value?.revision === 'number' && Number.isSafeInteger(value.revision) ? value.revision : 0 };
}
async function workspace(db: DatabaseClient, user: { id: string; name: string }): Promise<ExtensionWorkspace> {
  const [rows, prefs] = await Promise.all([
    db.query(`SELECT address,chain_id AS "chainId",name,symbol,logo_url AS "logoUrl",pinned,note,revision::int,updated_at AS "updatedAt"
      FROM extension_saved_tokens WHERE user_id=$1 ORDER BY updated_at DESC,address LIMIT 100`, [user.id]),
    db.query(`SELECT u.preferences->'extension' AS extension,u.email,
      (u.telegram_id IS NOT NULL OR telegram.subject IS NOT NULL) AS telegram_linked,
      COALESCE(telegram.username,CASE WHEN u.telegram_id IS NOT NULL THEN u.username END) AS telegram_username,
      x.username AS x_username
      FROM auth_users u
      LEFT JOIN extension_account_links telegram ON telegram.user_id=u.id AND telegram.provider='telegram'
      LEFT JOIN extension_account_links x ON x.user_id=u.id AND x.provider='x' WHERE u.id=$1`, [user.id]),
  ]);
  const profile = prefs.rows[0];
  const settings = storedPreferences(profile?.extension);
  return { user: { ...user, email: profile?.email ?? null, telegramLinked: profile?.telegram_linked === true,
    telegramUsername: profile?.telegram_username ?? null, xUsername: profile?.x_username ?? null },
    items: rows.rows.map(row => ({ ...row, updatedAt: new Date(row.updatedAt).toISOString() })),
    preferences: settings.preferences, preferencesRevision: settings.revision };
}
export interface ExtensionApiOptions {
  db: Pool; origin: string; extensionOrigins: string[];
  authOptions?: ExtensionAuthOptions;
  socialProviders?: ExtensionSocialProviders;
  now?: () => number;
  resolveWebUser?: (request: FastifyRequest, db: Pool) => Promise<ResolvedAuthUser | null>;
}
export function registerExtensionApi(app: FastifyInstance, options: ExtensionApiOptions) {
  const { db } = options, now = options.now ?? Date.now;
  const webOrigin = new URL(options.origin).origin;
  const allowedOrigins = new Set(options.extensionOrigins.filter(origin => /^chrome-extension:\/\/[a-p]{32}$/.test(origin)
    || process.env.NODE_ENV !== 'production' && /^http:\/\/(?:127\.0\.0\.1|localhost):\d+$/.test(origin)));
  const webUser = options.resolveWebUser ?? resolveAuthUser;
  const requests = new Map<string, { count: number; expires: number }>();
  function limit(req: FastifyRequest, reply: FastifyReply, action: string, max: number, ms = 60_000) {
    const key = `${action}:${req.ip}`, at = now();
    for (const [key, entry] of requests) if (entry.expires <= at) requests.delete(key);
    if (requests.size >= 4096 && !requests.has(key)) { reply.code(429).send({ error: 'Try again shortly' }); return false; }
    const entry = requests.get(key) ?? { count: 0, expires: at + ms }; entry.count++; requests.set(key, entry);
    if (entry.count > max) { reply.code(429).header('Retry-After', '60').send({ error: 'Try again shortly' }); return false; }
    return true;
  }
  function extensionRequest(req: FastifyRequest, reply: FastifyReply) {
    // Privileged Chrome extension GET fetches may omit Origin. This registered
    // client tag is routing/CSRF context, never authentication: bearer secrets
    // or the single-use pairing verifier are still independently mandatory.
    const origin=extensionRequestOrigin(req, allowedOrigins);
    if(!origin){reply.code(403).send({error:'Extension origin rejected'});return false;}
    reply.header('Access-Control-Allow-Origin', origin).header('Vary', 'Origin');
    return origin;
  }
  const privateHeaders = (reply: FastifyReply) => reply.header('Cache-Control', 'private,no-store').header('Referrer-Policy', 'no-referrer');
  async function bearer(req: FastifyRequest, reply: FastifyReply) {
    privateHeaders(reply);
    if (!extensionRequest(req, reply) || !limit(req, reply, 'workspace', 180)) return null;
    const match = req.headers.authorization?.match(/^Bearer (kex_[A-Za-z0-9_-]{43})$/);
    if (!match) { reply.code(401).send({ error: 'Connect your Kollens account' }); return null; }
    const result = await db.query(`SELECT u.id,u.name FROM auth_sessions s JOIN auth_users u ON u.id=s.user_id
      WHERE s.secret_hash=$1 AND s.purpose='extension' AND s.expires_at>$2`, [digest(match[1]), new Date(now())]);
    if (!result.rows[0]) { reply.code(401).send({ error: 'Extension session expired or disconnected' }); return null; }
    return { user: result.rows[0] as { id: string; name: string }, hash: digest(match[1]) };
  }
  async function signedWeb(req: FastifyRequest, reply: FastifyReply, mutate = false) {
    privateHeaders(reply);
    if (mutate && req.headers.origin !== webOrigin) { reply.code(403).send({ error: 'Request origin rejected' }); return null; }
    const user = await webUser(req, db);
    if (!user) { reply.code(401).send({ error: 'Log in to Kollens first' }); return null; }
    return user;
  }
  app.options('/api/extension/*', { logLevel: 'silent' }, async (req, reply) => {
    if (!extensionRequest(req, reply)) return;
    return reply.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS')
      .header('Access-Control-Allow-Headers', 'Authorization,Content-Type,X-Kollens-Extension-Origin').header('Access-Control-Max-Age', '600').code(204).send();
  });
  app.get('/api/extension/auth/options', { logLevel: 'silent' }, async (req, reply) => {
    privateHeaders(reply);
    if (!extensionRequest(req, reply) || !limit(req, reply, 'auth_options', 30)) return;
    return { ...options.authOptions ?? { google: false, email: false },
      telegram: Boolean(options.socialProviders?.telegram), x: Boolean(options.socialProviders?.x) };
  });
  if (options.socialProviders) registerExtensionSocial(app, db, webOrigin, options.socialProviders, bearer);
  app.post('/api/extension/auth/start', { logLevel: 'silent' }, async (req, reply) => {
    privateHeaders(reply);
    const origin = extensionRequest(req, reply);
    if (!origin || !limit(req, reply, 'pair', 10, 600_000)) return;
    const input = z.object({ challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/), mode: z.enum(['web','native']).default('web') }).strict().safeParse(req.body);
    if (!input.success) return reply.code(400).send({ error: 'Invalid connection request' });
    if (input.data.mode === 'native' && !origin.startsWith('chrome-extension://')) return reply.code(403).send({ error: 'Extension origin rejected' });
    await db.query('DELETE FROM extension_pairing_attempts WHERE expires_at<=$1', [new Date(now())]);
    const count = await db.query('SELECT count(*)::int AS n FROM extension_pairing_attempts');
    if (count.rows[0].n >= 2048) return reply.code(429).send({ error: 'Try again shortly' });
    const id = randomUUID(), expiresAt = new Date(now() + 600_000).toISOString();
    await db.query(`INSERT INTO extension_pairing_attempts(id,verifier_challenge,extension_origin,expires_at,mode) VALUES($1,$2,$3,$4,$5)`,
      [id, input.data.challenge, origin, expiresAt, input.data.mode]);
    return { id, expiresAt, pollAfterMs: 2000, ...(input.data.mode === 'web' ? { url: `${webOrigin}/extension/connect?id=${id}` } : {}) };
  });
  app.get<{ Params: { id: string } }>('/api/extension/auth/attempt/:id', { logLevel: 'silent' }, async (req, reply) => {
    const user = await signedWeb(req, reply); if (!user) return;
    if (!idSchema.safeParse(req.params.id).success) return reply.code(400).send({ error: 'Invalid connection' });
    const found = await db.query(`SELECT extension_origin,expires_at FROM extension_pairing_attempts WHERE id=$1 AND mode='web' AND expires_at>$2 AND consumed_at IS NULL`,
      [req.params.id, new Date(now())]);
    if (!found.rows[0]) return reply.code(410).send({ error: 'Connection expired. Start again from the extension.' });
    return { user: { id: user.id, name: user.name }, extensionOrigin: found.rows[0].extension_origin, expiresAt: found.rows[0].expires_at };
  });
  app.post('/api/extension/auth/approve', { logLevel: 'silent' }, async (req, reply) => {
    const user = await signedWeb(req, reply, true); if (!user) return;
    const input = z.object({ id: idSchema, expectedUserId: idSchema }).strict().safeParse(req.body);
    if (!input.success) return reply.code(400).send({ error: 'Invalid connection' });
    if (input.data.expectedUserId !== user.id) return reply.code(409).send({ error: 'Your account changed. Review the connection again.' });
    const result = await db.query(`UPDATE extension_pairing_attempts SET user_id=$2 WHERE id=$1 AND mode='web' AND expires_at>$3 AND consumed_at IS NULL AND user_id IS NULL RETURNING id`,
      [input.data.id, user.id, new Date(now())]);
    return result.rowCount ? { approved: true } : reply.code(410).send({ error: 'Connection expired or already approved' });
  });
  app.post('/api/extension/auth/exchange', { logLevel: 'silent' }, async (req, reply) => {
    privateHeaders(reply);
    const origin = extensionRequest(req, reply);
    if (!origin || !limit(req, reply, 'exchange', 90)) return;
    const input = z.object({ id: idSchema, verifier: verifierSchema, proof: proofSchema.optional() }).strict().safeParse(req.body);
    if (!input.success) return reply.code(400).send({ error: 'Invalid connection' });
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const row = (await client.query(`SELECT * FROM extension_pairing_attempts WHERE id=$1 FOR UPDATE`, [input.data.id])).rows[0];
      if (!row || row.extension_origin !== origin || row.consumed_at || new Date(row.expires_at).getTime() <= now()) {
        await client.query('ROLLBACK'); return reply.code(410).send({ error: 'Connection expired or already used' });
      }
      if (!matchesProof(row.verifier_challenge, challenge(input.data.verifier))) {
        await client.query('ROLLBACK'); return reply.code(401).send({ error: 'Connection proof rejected' });
      }
      if (!row.user_id) { await client.query('ROLLBACK'); return reply.code(202).send({ pending: true }); }
      if (row.mode === 'native' ? !input.data.proof || !matchesProof(row.completion_hash, digest(input.data.proof)) : Boolean(input.data.proof)) {
        await client.query('ROLLBACK'); return reply.code(401).send({ error: 'Connection proof rejected' });
      }
      const token = `kex_${randomBytes(32).toString('base64url')}`, expiresAt = new Date(now() + 30 * 86400_000).toISOString();
      await client.query(`INSERT INTO auth_sessions(id,user_id,secret_hash,expires_at,purpose) VALUES($1,$2,$3,$4,'extension')`,
        [randomUUID(), row.user_id, digest(token), expiresAt]);
      await client.query('UPDATE extension_pairing_attempts SET consumed_at=$2,completion_hash=NULL WHERE id=$1', [row.id, new Date(now())]);
      await client.query('COMMIT'); return { token, expiresAt };
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  });
  app.post('/api/extension/auth/revoke', { logLevel: 'silent' }, async (req, reply) => {
    const identity = await bearer(req, reply); if (!identity) return;
    await db.query(`DELETE FROM auth_sessions WHERE secret_hash=$1 AND purpose='extension'`, [identity.hash]);
    return { disconnected: true };
  });
  app.post('/api/extension/auth/revoke-all', { logLevel: 'silent' }, async (req, reply) => {
    const user = await signedWeb(req, reply, true); if (!user) return;
    await db.query(`DELETE FROM auth_sessions WHERE user_id=$1 AND purpose='extension'`, [user.id]); return { disconnected: true };
  });
  app.get('/api/extension/workspace', { logLevel: 'silent' }, async (req, reply) => {
    const identity = await bearer(req, reply); if (!identity) return; return workspace(db, identity.user);
  });
  for (const method of ['PUT','DELETE'] as const) app.route<{ Params: { address: string } }>({
    method, url: '/api/extension/tokens/:address', logLevel: 'silent', handler: async (req, reply) => {
      const identity = await bearer(req, reply); if (!identity) return;
      if (!addressSchema.safeParse(req.params.address).success) return reply.code(400).send({ error: 'Invalid BSC token address' });
      const input = (method === 'PUT' ? itemSchema : z.object({ revision: z.number().int().positive().safe() }).strict()).safeParse(req.body);
      if (!input.success) return reply.code(400).send({ error: 'Invalid saved token' });
      const client = await db.connect();
      try {
        await client.query('BEGIN');
        const account = (await client.query(`SELECT preferences->>'extensionTokenRevision' AS revision FROM auth_users WHERE id=$1 FOR UPDATE`, [identity.user.id])).rows[0];
        const old = (await client.query(`SELECT revision::int FROM extension_saved_tokens WHERE user_id=$1 AND chain_id=56 AND address=$2`,
          [identity.user.id, req.params.address])).rows[0];
        if ((old?.revision ?? 0) !== input.data.revision) {
          const current = await workspace(client, identity.user); await client.query('ROLLBACK');
          return reply.code(409).send({ error: 'Saved token changed on another device', workspace: current });
        }
        const nextRevision = Number(account?.revision ?? 0) + 1;
        if (!Number.isSafeInteger(nextRevision)) throw new Error('extension_revision_limit');
        await client.query(`UPDATE auth_users SET preferences=jsonb_set(preferences,'{extensionTokenRevision}',$2::jsonb) WHERE id=$1`, [identity.user.id, JSON.stringify(nextRevision)]);
        if (method === 'DELETE') await client.query('DELETE FROM extension_saved_tokens WHERE user_id=$1 AND chain_id=56 AND address=$2', [identity.user.id, req.params.address]);
        else {
          const item = itemSchema.parse(input.data);
          const count = (await client.query('SELECT count(*)::int AS n FROM extension_saved_tokens WHERE user_id=$1', [identity.user.id])).rows[0].n;
          if (!old && count >= 100) { await client.query('ROLLBACK'); return reply.code(409).send({ error: 'Save up to 100 tokens' }); }
          await client.query(`INSERT INTO extension_saved_tokens(user_id,chain_id,address,name,symbol,pinned,note,revision,logo_url) VALUES($1,56,$2,$3,$4,$5,$6,$7,$8)
            ON CONFLICT(user_id,chain_id,address) DO UPDATE SET name=EXCLUDED.name,symbol=EXCLUDED.symbol,pinned=EXCLUDED.pinned,
              note=EXCLUDED.note,revision=EXCLUDED.revision,logo_url=CASE WHEN $9 THEN EXCLUDED.logo_url ELSE extension_saved_tokens.logo_url END,updated_at=now()`,
          [identity.user.id, req.params.address, clean(item.name), clean(item.symbol), item.pinned, clean(item.note), nextRevision,extensionTokenImageUrl(item.logoUrl),item.logoUrl!==undefined]);
        }
        const result = await workspace(client, identity.user); await client.query('COMMIT'); return result;
      } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    },
  });
  app.put('/api/extension/preferences', { logLevel: 'silent' }, async (req, reply) => {
    const identity = await bearer(req, reply); if (!identity) return;
    const input = z.object({ preferences: preferencesSchema, revision: z.number().int().nonnegative().safe() }).strict().safeParse(req.body);
    if (!input.success) return reply.code(400).send({ error: 'Invalid extension preferences' });
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const row = (await client.query(`SELECT preferences->'extension' AS extension FROM auth_users WHERE id=$1 FOR UPDATE`, [identity.user.id])).rows[0];
      const old = storedPreferences(row?.extension);
      if (old.revision !== input.data.revision) {
        const current = await workspace(client, identity.user); await client.query('ROLLBACK');
        return reply.code(409).send({ error: 'Preferences changed on another device', workspace: current });
      }
      await client.query(`UPDATE auth_users SET preferences=jsonb_set(preferences,'{extension}',$2::jsonb),updated_at=now() WHERE id=$1`,
        [identity.user.id, JSON.stringify({ settings: input.data.preferences, revision: old.revision + 1 })]);
      const result = await workspace(client, identity.user); await client.query('COMMIT'); return result;
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  });
}
