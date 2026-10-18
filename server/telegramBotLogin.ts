import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { AuthMergeLimitError, authSessionSecret, safeAuthReturnTo, telegramIssuer, verifiedTelegramId, type GuestLoginSnapshot } from './telegramAuth.js';
import type { TelegramBotResult, TelegramMessageButton } from './telegramBot.js';

const browserCookie = 'bscan_bot_login';
const lifetimeSeconds = 600;
const sessionSeconds = 30 * 24 * 60 * 60;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const token = () => randomBytes(32).toString('base64url');
const validToken = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);

export type TelegramBotLoginStart = { updateId: string; telegramId: string; startToken: string; name: string; username: string | null; language?: string };
export type TelegramBotLoginOptions = {
  pool: Pool;
  config: { origin: string; secure: boolean } | null;
  bot: {
    identity(): Promise<{ username: string } | null>;
    webhookMatchesOrigin?(): Promise<boolean>;
    send(chatId: string, text: string, buttons?: TelegramMessageButton[][]): Promise<TelegramBotResult>;
  } | null;
  captureGuest?: (request: FastifyRequest) => Promise<GuestLoginSnapshot>;
  mergeGuest?: (client: PoolClient, userId: string, snapshot: GuestLoginSnapshot, isNewUser: boolean) => Promise<void>;
  /** Returns a server-owned proxy URL, never a Bot API file URL containing a credential. */
  avatarUrl?: (telegramId: string) => Promise<string | null>;
  now?: () => number;
};
type Attempt = {
  id: string; browser_hash: string; return_to: string; guest_snapshot: GuestLoginSnapshot; expires_at: Date | string;
  telegram_id: string | null; name: string | null; username: string | null; avatar_url: string | null;
  finish_hash: string | null; completed_at: Date | string | null; delivery_status: string;
  delivery_lease_until?: Date | string | null; delivery_retry_at?: Date | string | null;
};
class BotLoginInputError extends Error {
  constructor(readonly status: number, readonly reason: string) { super(reason); }
}

export async function ensureTelegramBotLoginSchema(db: Pool) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(782329)');
    await client.query(`CREATE TABLE IF NOT EXISTS auth_bot_login_attempts (
      id uuid PRIMARY KEY, start_hash text UNIQUE NOT NULL, browser_hash text NOT NULL,
      return_to text NOT NULL, guest_snapshot jsonb, expires_at timestamptz NOT NULL,
      telegram_id bigint, name text, username text, avatar_url text, finish_hash text UNIQUE,
      delivery_status text NOT NULL DEFAULT 'waiting', delivery_error text, delivery_update_id bigint,
      completed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS auth_bot_login_expiry_idx ON auth_bot_login_attempts(expires_at);
    CREATE TABLE IF NOT EXISTS auth_bot_login_updates (
      update_id bigint PRIMARY KEY, attempt_id uuid NOT NULL REFERENCES auth_bot_login_attempts(id) ON DELETE CASCADE,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    ALTER TABLE auth_bot_login_attempts ADD COLUMN IF NOT EXISTS delivery_lease_until timestamptz;
    ALTER TABLE auth_bot_login_attempts ADD COLUMN IF NOT EXISTS delivery_retry_at timestamptz;
    CREATE TABLE IF NOT EXISTS auth_bot_login_pacing (
      telegram_id bigint PRIMARY KEY, next_at timestamptz NOT NULL
    );`);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}

function privateResponse(reply: FastifyReply) {
  reply.header('Cache-Control', 'no-store').header('Vary', 'Cookie').header('Referrer-Policy', 'no-referrer');
}
function cookie(name: string, value: string, seconds: number, secure: boolean) {
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${seconds}${secure ? '; Secure' : ''}`;
}
function browserSecret(request: FastifyRequest) {
  const found = (request.headers.cookie ?? '').split(';').map(value => value.trim()).filter(value => value.startsWith(`${browserCookie}=`));
  if (found.length !== 1) return null;
  const value = found[0].slice(browserCookie.length + 1);
  return /^[a-f0-9]{64}$/.test(value) ? value : null;
}
function cleanName(value: unknown) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 120) || 'Telegram user' : 'Telegram user';
}
function cleanUsername(value: unknown) { return typeof value === 'string' && /^[A-Za-z0-9_]{1,64}$/.test(value) ? value : null; }
function safeAvatar(value: unknown, origin: string) {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const url = new URL(value, origin);
    if (url.username || url.password || url.hash) return null;
    if (url.origin === origin && /^\/api\/auth\/telegram\/avatar(?:\/[1-9][0-9]{0,15})?$/.test(url.pathname)) return `${url.pathname}${url.search}`;
    if (url.protocol === 'https:' && url.hostname !== 'api.telegram.org' && /(^|\.)(telegram\.org|telesco\.pe|t\.me|telegram-cdn\.org)$/.test(url.hostname)) return url.href;
  } catch { /* Optional images never prevent authentication. */ }
  return null;
}
function successfulReturn(value: string) {
  const url = new URL(safeAuthReturnTo(value), 'https://kollens.com');
  url.searchParams.set('telegramLogin', 'success');
  return `${url.pathname}${url.search}${url.hash}`;
}

/** Telegram's authenticated private webhook establishes identity. Neither /start nor a GET creates a session. */
export function createTelegramBotLogin(options: TelegramBotLoginOptions) {
  const db = options.pool, now = options.now ?? Date.now;
  const available = () => !!options.config && !!options.bot;
  async function transaction<T>(run: (client: PoolClient) => Promise<T>) {
    const client = await db.connect();
    try { await client.query('BEGIN'); const result = await run(client); await client.query('COMMIT'); return result; }
    catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }
  async function recoveryRequired(client: Pick<Pool, 'query'> | Pick<PoolClient, 'query'>, telegramId: string) {
    const result = await client.query<{ required: boolean }>(`SELECT EXISTS(SELECT 1 FROM auth_users WHERE issuer=$1 AND telegram_id IS NULL)
      AND NOT EXISTS(SELECT 1 FROM auth_users WHERE telegram_id=$2) AS required`, [telegramIssuer, telegramId]);
    return result.rows[0]?.required === true;
  }
  /** A bot-delivered bearer proves the numeric identity only for a bounded OIDC recovery attempt. */
  async function recoveryIdentity(secret: string): Promise<{ telegramId: string; returnTo: string } | null> {
    if (!available() || !validToken(secret)) return null;
    const attempt = (await db.query<Attempt>(`SELECT * FROM auth_bot_login_attempts WHERE finish_hash=$1 AND expires_at>$2 AND completed_at IS NULL`, [hash(secret), new Date(now()).toISOString()])).rows[0];
    const telegramId = verifiedTelegramId(attempt?.telegram_id);
    return attempt && telegramId ? { telegramId, returnTo: safeAuthReturnTo(attempt.return_to) } : null;
  }

  async function start(request: FastifyRequest, reply: FastifyReply, returnTo: string) {
    privateResponse(reply);
    if (!available()) return reply.code(503).send({ error: 'Telegram login is not configured' });
    try {
      if (options.bot!.webhookMatchesOrigin && !await options.bot!.webhookMatchesOrigin()) return reply.code(503).send({ error: 'Telegram bot login is not connected to this app.', code: 'bot_webhook_mismatch' });
      const identity = await options.bot!.identity();
      if (!identity || !/^[A-Za-z0-9_]{5,32}$/.test(identity.username)) return reply.code(503).send({ error: 'Telegram login is temporarily unavailable' });
      const startSecret = token(), browser = randomBytes(32).toString('hex');
      const guest = await options.captureGuest?.(request) ?? null;
      await db.query('DELETE FROM auth_bot_login_attempts WHERE expires_at<=now()');
      await db.query('DELETE FROM auth_sessions WHERE expires_at<=now()');
      await db.query(`INSERT INTO auth_bot_login_attempts(id,start_hash,browser_hash,return_to,guest_snapshot,expires_at)
        VALUES($1,$2,$3,$4,$5::jsonb,$6)`, [randomUUID(), hash(startSecret), hash(browser), safeAuthReturnTo(returnTo), JSON.stringify(guest), new Date(now() + lifetimeSeconds * 1000).toISOString()]);
      reply.header('Set-Cookie', cookie(browserCookie, browser, lifetimeSeconds, options.config!.secure));
      return { url: `https://t.me/${identity.username}?start=login_${startSecret}` };
    } catch { return reply.code(503).send({ error: 'Telegram login is temporarily unavailable' }); }
  }

  async function handleStart(input: TelegramBotLoginStart): Promise<boolean> {
    const plainStart = input.startToken === '';
    if (!plainStart && !/^login_[A-Za-z0-9_-]{43}$/.test(input.startToken)) return false;
    if (!available() || !verifiedTelegramId(input.telegramId) || !/^[0-9]{1,16}$/.test(input.updateId)) return true;
    const finishSecret = token();
    const pending = await transaction(async client => {
      // Serialize each Telegram update before creating a standalone attempt, including webhook redelivery after a restart.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,782326))', [input.updateId]);
      if ((await client.query('SELECT attempt_id FROM auth_bot_login_updates WHERE update_id=$1', [input.updateId])).rows.length) return null;
      let attempt = plainStart ? undefined : (await client.query<Attempt>(`SELECT * FROM auth_bot_login_attempts WHERE start_hash=$1 AND expires_at>$2 AND completed_at IS NULL FOR UPDATE`, [hash(input.startToken.slice(6)), new Date(now()).toISOString()])).rows[0];
      const renewed = !plainStart && !attempt;
      if (!attempt) {
        // Direct bot starts and stale/cross-environment payloads have no browser or guest authority to inherit.
        attempt = { id: randomUUID(), browser_hash: hash(randomBytes(32).toString('hex')), return_to: '/watchlist', guest_snapshot: null,
          expires_at: new Date(now() + lifetimeSeconds * 1000).toISOString(), telegram_id: null, name: null, username: null, avatar_url: null,
          finish_hash: null, completed_at: null, delivery_status: 'waiting' };
        await client.query(`INSERT INTO auth_bot_login_attempts(id,start_hash,browser_hash,return_to,guest_snapshot,expires_at)
          VALUES($1,$2,$3,$4,$5::jsonb,$6)`, [attempt.id, hash(token()), attempt.browser_hash, attempt.return_to, null, attempt.expires_at]);
      }
      if (attempt.telegram_id && String(attempt.telegram_id) !== input.telegramId) return null;
      const update = await client.query(`INSERT INTO auth_bot_login_updates(update_id,attempt_id) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING update_id`, [input.updateId, attempt.id]);
      if (!update.rows.length) return null;
      if ((attempt.delivery_lease_until && new Date(attempt.delivery_lease_until).getTime() > now())
        || (attempt.delivery_retry_at && new Date(attempt.delivery_retry_at).getTime() > now())) return null;
      await client.query('INSERT INTO auth_bot_login_pacing(telegram_id,next_at) VALUES($1,$2) ON CONFLICT DO NOTHING', [input.telegramId, new Date(now()).toISOString()]);
      const pacing = (await client.query<{ next_at: Date | string }>('SELECT next_at FROM auth_bot_login_pacing WHERE telegram_id=$1 FOR UPDATE', [input.telegramId])).rows[0];
      if (pacing && new Date(pacing.next_at).getTime() > now()) return null;
      await client.query('UPDATE auth_bot_login_pacing SET next_at=$2 WHERE telegram_id=$1', [input.telegramId, new Date(now() + 1000).toISOString()]);
      // A new /start is an explicit retry. Replace its old proof instead of blindly resending an ambiguous delivery.
      await client.query(`UPDATE auth_bot_login_attempts SET telegram_id=$2,name=$3,username=$4,finish_hash=$5,
        delivery_status='sending',delivery_error=NULL,delivery_update_id=$6,delivery_lease_until=$7,delivery_retry_at=NULL WHERE id=$1`,
      [attempt.id, input.telegramId, cleanName(input.name), cleanUsername(input.username), hash(finishSecret), input.updateId, new Date(now() + 60_000).toISOString()]);
      return { ...attempt, renewed };
    });
    if (!pending) return true;
    let avatar: string | null = null;
    try { avatar = safeAvatar(await options.avatarUrl?.(input.telegramId), options.config!.origin); } catch { /* Keep the existing avatar. */ }
    if (avatar) await db.query('UPDATE auth_bot_login_attempts SET avatar_url=$3 WHERE id=$1 AND finish_hash=$2', [pending.id, hash(finishSecret), avatar]);
    const chinese = input.language?.toLowerCase().startsWith('zh') ?? false;
    const name = cleanName(input.name), username = cleanUsername(input.username);
    const identity = `${name}${username ? ` (@${username})` : ''}`;
    const remaining = Math.max(1, Math.ceil((new Date(pending.expires_at).getTime() - now()) / 60_000));
    const renewedNotice = pending.renewed ? (chinese ? '之前的登录请求已失效。请使用下方的新链接继续。\n\n' : 'The previous login request is no longer active. Use this fresh link to continue.\n\n') : '';
    const text = chinese ? `登录 Kollens\n\n${renewedNotice}以 ${identity} 继续。\n此一次性链接将在 ${remaining} 分钟后失效。请勿转发此链接。`
      : `Sign in to Kollens\n\n${renewedNotice}Continue as ${identity}.\nThis one-time link expires in ${remaining} minute${remaining === 1 ? '' : 's'}. Do not forward it.`;
    let result: TelegramBotResult;
    try {
      result = await options.bot!.send(input.telegramId, text, [[{ text: chinese ? '登录 Kollens' : 'Continue to Kollens', url: `${options.config!.origin}/auth/telegram/finish#token=${finishSecret}` }]]);
    } catch { result = { kind: 'uncertain', reason: 'network' }; }
    const status = result.kind === 'sent' ? 'sent' : result.kind === 'retry' ? 'retry' : result.kind === 'uncertain' ? 'uncertain' : 'failed';
    const reason = result.kind === 'sent' ? null : result.kind === 'blocked' ? 'bot_blocked' : result.kind === 'retry' ? 'rate_limited' : result.kind === 'uncertain' ? 'delivery_unconfirmed' : 'delivery_failed';
    const retryAt = new Date(now() + (result.kind === 'retry' ? Math.max(1000, Math.min(86_400_000, result.retryAfterMs)) : 1000)).toISOString();
    await transaction(async client => {
      await client.query(`UPDATE auth_bot_login_attempts SET delivery_status=$3,delivery_error=$4,delivery_lease_until=NULL,delivery_retry_at=$5
        WHERE id=$1 AND finish_hash=$2 AND completed_at IS NULL`, [pending.id, hash(finishSecret), status, reason, retryAt]);
      await client.query('UPDATE auth_bot_login_pacing SET next_at=GREATEST(next_at,$2::timestamptz) WHERE telegram_id=$1', [input.telegramId, retryAt]);
    });
    return true;
  }

  function registerRoutes(app: FastifyInstance) {
    const attempts = new Map<string, { count: number; until: number }>();
    function allowed(request: FastifyRequest, reply: FastifyReply) {
      privateResponse(reply);
      if (!available()) { reply.code(503).send({ error: 'Telegram login is not configured' }); return false; }
      if (request.headers.origin !== options.config!.origin) { reply.code(403).send({ error: 'Request origin rejected' }); return false; }
      if (attempts.size > 5000) for (const [key, value] of attempts) if (value.until <= now()) attempts.delete(key);
      if (attempts.size >= 10_000 && !attempts.has(request.ip)) { reply.code(429).header('Retry-After', '60').send({ error: 'Try again shortly' }); return false; }
      const old = attempts.get(request.ip), entry = old && old.until > now() ? old : { count: 0, until: now() + 60_000 };
      attempts.set(request.ip, entry);
      if (++entry.count > 60) { reply.code(429).header('Retry-After', '60').send({ error: 'Try again shortly' }); return false; }
      return true;
    }
    function readToken(body: unknown, completing: boolean) {
      if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
      const value = body as Record<string, unknown>;
      if (Object.keys(value).some(key => !['token', ...(completing ? ['confirmed'] : [])].includes(key)) || !validToken(value.token) || (completing && value.confirmed !== true)) return null;
      return value.token;
    }
    const requestOptions = { logLevel: 'silent' as const, bodyLimit: 4096, onRequest: async (_request: FastifyRequest, reply: FastifyReply) => { privateResponse(reply); } };
    app.post('/api/auth/telegram/bot/preview', requestOptions, async (request, reply) => {
      if (!allowed(request, reply)) return;
      const secret = readToken(request.body, false);
      if (!secret) return reply.code(400).send({ error: 'Invalid Telegram login link' });
      try {
        const attempt = (await db.query<Attempt>(`SELECT a.*,COALESCE(u.avatar_url,a.avatar_url) AS avatar_url FROM auth_bot_login_attempts a
          LEFT JOIN auth_users u ON u.telegram_id=a.telegram_id WHERE a.finish_hash=$1 AND a.expires_at>$2 AND a.completed_at IS NULL`, [hash(secret), new Date(now()).toISOString()])).rows[0];
        if (!attempt?.telegram_id || !attempt.name) return reply.code(410).send({ error: 'This Telegram login link has expired. Start again from Kollens.' });
        const browser = browserSecret(request);
        return { user: { name: attempt.name, username: attempt.username, avatarUrl: attempt.avatar_url },
          sameBrowser: !!browser && hash(browser) === attempt.browser_hash, expiresAt: new Date(attempt.expires_at).toISOString(),
          requiresRecovery: await recoveryRequired(db, String(attempt.telegram_id)) };
      } catch { return reply.code(503).send({ error: 'Telegram login is temporarily unavailable' }); }
    });
    app.post('/api/auth/telegram/bot/complete', requestOptions, async (request, reply) => {
      if (!allowed(request, reply)) return;
      const secret = readToken(request.body, true);
      if (!secret) return reply.code(400).send({ error: 'Confirm your Telegram account to continue' });
      const session = randomBytes(32).toString('hex');
      try {
        const result = await transaction(async client => {
          const attempt = (await client.query<Attempt>(`SELECT * FROM auth_bot_login_attempts WHERE finish_hash=$1 AND expires_at>$2 AND completed_at IS NULL FOR UPDATE`, [hash(secret), new Date(now()).toISOString()])).rows[0];
          if (!attempt?.telegram_id || !attempt.name) throw new BotLoginInputError(410, 'This Telegram login link has expired. Start again from Kollens.');
          // Serialize new accounts too; a second login attempt cannot create a duplicate Telegram identity.
          await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,782325))', [String(attempt.telegram_id)]);
          const existing = (await client.query<{ id: string }>('SELECT id FROM auth_users WHERE telegram_id=$1 FOR UPDATE', [String(attempt.telegram_id)])).rows[0];
          const oldSession = authSessionSecret(request.headers.cookie);
          const current = oldSession ? (await client.query<{ id: string }>(`SELECT u.id FROM auth_sessions s JOIN auth_users u ON u.id=s.user_id WHERE s.secret_hash=$1 AND s.expires_at>$2`, [hash(oldSession), new Date(now()).toISOString()])).rows[0] : null;
          if (current && current.id !== existing?.id) throw new BotLoginInputError(409, 'You are signed in to a different account. Log out before using this link.');
          // Older OIDC accounts may have no numeric identity yet. Never silently replace their favorites/journal with a new empty account.
          if (!existing && await recoveryRequired(client, String(attempt.telegram_id))) throw new BotLoginInputError(428, 'Verify your existing Telegram login once before continuing.');
          const userId = existing?.id ?? randomUUID();
          if (existing) await client.query(`UPDATE auth_users SET name=$2,username=$3,avatar_url=COALESCE($4,avatar_url),updated_at=now() WHERE id=$1`, [userId, attempt.name, attempt.username, attempt.avatar_url]);
          else await client.query(`INSERT INTO auth_users(id,issuer,subject,name,username,avatar_url,telegram_id) VALUES($1,$2,$3,$4,$5,$6,$7)`,
            [userId, telegramIssuer, `bot:${attempt.telegram_id}`, attempt.name, attempt.username, attempt.avatar_url, String(attempt.telegram_id)]);
          const browser = browserSecret(request), sameBrowser = !!browser && hash(browser) === attempt.browser_hash;
          if (sameBrowser) await options.mergeGuest?.(client, userId, attempt.guest_snapshot, !existing);
          if (oldSession) await client.query('DELETE FROM auth_sessions WHERE secret_hash=$1', [hash(oldSession)]);
          await client.query(`INSERT INTO auth_sessions(id,user_id,secret_hash,expires_at) VALUES($1,$2,$3,$4)`, [randomUUID(), userId, hash(session), new Date(now() + sessionSeconds * 1000).toISOString()]);
          await client.query('UPDATE auth_bot_login_attempts SET completed_at=$2,finish_hash=NULL WHERE id=$1', [attempt.id, new Date(now()).toISOString()]);
          return { returnTo: successfulReturn(attempt.return_to), sameBrowser, mergedGuest: sameBrowser && !!attempt.guest_snapshot };
        });
        reply.header('Set-Cookie', [cookie('bscan_auth', session, sessionSeconds, options.config!.secure), cookie(browserCookie, '', 0, options.config!.secure),
          ...(result.mergedGuest ? [`bscan_watch=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${options.config!.secure ? '; Secure' : ''}`] : [])]);
        return { returnTo: result.returnTo };
      } catch (error) {
        if (error instanceof BotLoginInputError) return reply.code(error.status).send({ error: error.reason });
        if (error instanceof AuthMergeLimitError) return reply.code(422).send({ error: 'Your browser and account favorites exceed the limit. Remove some favorites and try again.' });
        return reply.code(503).send({ error: 'Telegram login is temporarily unavailable' });
      }
    });
  }
  return { available, start, handleStart, recoveryIdentity, registerRoutes };
}
