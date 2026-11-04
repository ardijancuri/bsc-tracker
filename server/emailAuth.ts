import { createHash, createHmac, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { authSessionSecret } from './telegramAuth.js';

const issuer = 'urn:kollens:email';
const browserCookie = 'bscan_email_login';
const browserCookiePath = '/api/auth/email';
const startInput = z.object({ id: z.string().uuid(), email: z.string().max(254).email() }).strict();
const verifyInput = startInput.extend({ code: z.string().regex(/^\d{6}$/) });
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

interface EmailAuthConfig {
  origin: string;
  secure: boolean;
  resendApiKey: string;
  from: string;
  secret: string;
}

export function emailAuthConfig(env: NodeJS.ProcessEnv = process.env): EmailAuthConfig | null {
  const resendApiKey = env.RESEND_API_KEY?.trim();
  const from = env.KOLLENS_EMAIL_FROM?.trim();
  const secret = env.KOLLENS_EMAIL_AUTH_SECRET?.trim();
  if (!resendApiKey || !from || !startInput.shape.email.safeParse(from).success || !secret || !/^[a-f0-9]{64}$/i.test(secret)) return null;
  try {
    const url = new URL(env.PUBLIC_APP_URL ?? '');
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/') return null;
    const secure = url.protocol === 'https:';
    if (!secure && (env.NODE_ENV === 'production' || url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) return null;
    return { origin: url.origin, secure, resendApiKey, from, secret };
  } catch {
    return null;
  }
}

const schema = `
  CREATE TABLE IF NOT EXISTS auth_email_login_attempts (
    id uuid PRIMARY KEY,
    pairing_id uuid NOT NULL REFERENCES extension_pairing_attempts(id) ON DELETE CASCADE,
    browser_hash text NOT NULL,
    email_hash text NOT NULL,
    ip_hash text NOT NULL,
    code_hash text NOT NULL,
    tries smallint NOT NULL DEFAULT 0 CHECK (tries BETWEEN 0 AND 5),
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    sent_at timestamptz,
    consumed_at timestamptz
  );
  CREATE INDEX IF NOT EXISTS auth_email_login_pairing_idx ON auth_email_login_attempts(pairing_id);
`;

function normalizeEmail(value: string) {
  // Domains are case-insensitive. Keep the mailbox exactly as supplied.
  const at = value.lastIndexOf('@');
  return value.slice(0, at + 1) + value.slice(at + 1).toLowerCase();
}

function cookieSecret(header?: string) {
  const cookies = (header ?? '').split(';').map(value => value.trim())
    .filter(value => value.startsWith(browserCookie + '='));
  const value = cookies[0]?.slice(browserCookie.length + 1);
  return cookies.length === 1 && value && /^[a-f0-9]{64}$/.test(value) ? value : null;
}

function cookie(name: string, value: string, path: string, maxAge: number, secure: boolean) {
  return `${name}=${value}; Max-Age=${maxAge}; Path=${path}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}

export function registerEmailAuthRoutes(
  app: FastifyInstance,
  options: { db: Pool; config?: EmailAuthConfig | null; fetch?: typeof fetch },
) {
  const { db } = options;
  const config = options.config === undefined ? emailAuthConfig() : options.config;
  const send = options.fetch ?? fetch;
  const privateHeaders = (reply: FastifyReply) => reply.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer');
  const noCode = { error: 'This code is invalid or has expired.' };
  const unavailable = { error: 'Email sign-in is unavailable.' };
  const codeHash = (id: string, email: string, browser: string, code: string) =>
    createHmac('sha256', Buffer.from(config!.secret, 'hex')).update(JSON.stringify([id, email, browser, code])).digest('hex');
  const emailFingerprint = (email: string) =>
    createHmac('sha256', Buffer.from(config!.secret, 'hex')).update('email:' + email).digest('hex');
  const ipFingerprint = (ip: string) =>
    createHmac('sha256', Buffer.from(config!.secret, 'hex')).update('ip:' + ip).digest('hex');
  const allowed = (req: FastifyRequest) => req.headers.origin === config?.origin;

  if (config) app.addHook('onReady', async () => {
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(782327,1)');
      await client.query(schema);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  });

  app.get('/api/auth/email/status', { logLevel: 'silent' }, async (_req, reply) => {
    privateHeaders(reply);
    return { available: config !== null };
  });

  app.post('/api/auth/email/start', { logLevel: 'silent', bodyLimit: 2048 }, async (req, reply) => {
    privateHeaders(reply);
    if (!config) return reply.code(503).send(unavailable);
    if (!allowed(req)) return reply.code(403).send({ error: 'Request origin rejected.' });
    const input = startInput.safeParse(req.body);
    if (!input.success) return reply.code(400).send({ error: 'Enter a valid email address.' });

    const email = normalizeEmail(input.data.email);
    const emailHash = emailFingerprint(email);
    const ipHash = ipFingerprint(req.ip);
    const browser = cookieSecret(req.headers.cookie) ?? randomBytes(32).toString('hex');
    const id = randomUUID();
    const code = String(randomInt(1_000_000)).padStart(6, '0');
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const pairing = await client.query(
        'SELECT id FROM extension_pairing_attempts WHERE id=$1 AND expires_at>now() AND user_id IS NULL AND consumed_at IS NULL',
        [input.data.id],
      );
      if (!pairing.rowCount) {
        await client.query('ROLLBACK');
        return reply.code(410).send({ error: 'Connection expired. Open the extension to start again.' });
      }
      // Serialize the send budget across browser tabs and server processes.
      const { rows: [lock] } = await client.query('SELECT pg_try_advisory_xact_lock(782327,2) AS acquired');
      if (!lock.acquired) {
        await client.query('ROLLBACK');
        return reply.code(429).header('Retry-After', '1').send({ error: 'Try again shortly.' });
      }
      await client.query("DELETE FROM auth_email_login_attempts WHERE created_at <= now()-interval '10 minutes'");
      const { rows: [usage] } = await client.query(`
        SELECT count(*)::int AS total,
          count(*) FILTER (WHERE email_hash=$1)::int AS email,
          count(*) FILTER (WHERE email_hash=$1 AND created_at>now()-interval '1 minute')::int AS recent,
          count(*) FILTER (WHERE ip_hash=$2)::int AS ip
        FROM auth_email_login_attempts`, [emailHash, ipHash]);
      if (usage.total >= 60 || usage.email >= 3 || usage.recent >= 1 || usage.ip >= 10) {
        await client.query('ROLLBACK');
        return reply.code(429).header('Retry-After', usage.recent >= 1 && usage.email < 3 ? '60' : '600')
          .send({ error: 'Too many requests. Try again later.' });
      }
      const inserted = await client.query(`
        INSERT INTO auth_email_login_attempts (id,pairing_id,browser_hash,email_hash,ip_hash,code_hash,expires_at)
        SELECT $1,id,$3,$4,$5,$6,least(expires_at,now()+interval '10 minutes')
        FROM extension_pairing_attempts WHERE id=$2 AND expires_at>now() AND user_id IS NULL AND consumed_at IS NULL
        RETURNING id`, [id, input.data.id, hash(browser), emailHash, ipHash, codeHash(id, email, browser, code)]);
      await client.query('COMMIT');
      if (!inserted.rowCount) return reply.code(410).send({ error: 'Connection expired. Open the extension to start again.' });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    try {
      const response = await send('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.resendApiKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': id },
        body: JSON.stringify({
          from: config.from,
          to: [email],
          subject: 'Your Kollens sign-in code',
          text: `Your Kollens sign-in code is ${code}. Enter it only in the Kollens tab where you requested it. It expires within 10 minutes.`,
        }),
        redirect: 'error',
        signal: AbortSignal.timeout(8000),
      });
      await response.body?.cancel().catch(() => {});
      if (!response.ok) return reply.code(503).send({ error: 'Could not send a code. Try again later.' });
    } catch {
      return reply.code(503).send({ error: 'Could not send a code. Try again later.' });
    }

    const marked = await db.query('UPDATE auth_email_login_attempts SET sent_at=now() WHERE id=$1 AND expires_at>now()', [id]);
    if (!marked.rowCount) return reply.code(410).send({ error: 'Connection expired. Open the extension to start again.' });
    reply.header('Set-Cookie', cookie(browserCookie, browser, browserCookiePath, 600, config.secure));
    return { sent: true };
  });

  app.post('/api/auth/email/verify', { logLevel: 'silent', bodyLimit: 2048 }, async (req, reply) => {
    privateHeaders(reply);
    if (!config) return reply.code(503).send(unavailable);
    if (!allowed(req)) return reply.code(403).send({ error: 'Request origin rejected.' });
    const input = verifyInput.safeParse(req.body);
    const browser = cookieSecret(req.headers.cookie);
    if (!input.success || !browser) return reply.code(400).send(noCode);
    const email = normalizeEmail(input.data.email);
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const { rows: [attempt] } = await client.query(`
        SELECT a.id,a.code_hash,a.tries,a.consumed_at,
          a.expires_at>now() AND a.sent_at IS NOT NULL AS available
        FROM auth_email_login_attempts a JOIN extension_pairing_attempts p ON p.id=a.pairing_id
        WHERE p.id=$1 AND a.browser_hash=$2 AND a.email_hash=$3
          AND p.expires_at>now() AND p.user_id IS NULL AND p.consumed_at IS NULL
        ORDER BY a.created_at DESC LIMIT 1 FOR UPDATE OF a,p`,
      [input.data.id, hash(browser), emailFingerprint(email)]);
      if (!attempt?.available || attempt.consumed_at || attempt.tries >= 5) {
        await client.query('ROLLBACK');
        return reply.code(400).send(noCode);
      }
      const expected = Buffer.from(attempt.code_hash, 'hex');
      const supplied = Buffer.from(codeHash(attempt.id, email, browser, input.data.code), 'hex');
      if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
        await client.query('UPDATE auth_email_login_attempts SET tries=tries+1 WHERE id=$1', [attempt.id]);
        await client.query('COMMIT');
        return reply.code(400).send(noCode);
      }

      await client.query('UPDATE auth_email_login_attempts SET consumed_at=now() WHERE id=$1', [attempt.id]);
      const { rows: [user] } = await client.query(`
        INSERT INTO auth_users (id,issuer,subject,name) VALUES ($1,$2,$3,'Email account')
        ON CONFLICT (issuer,subject) DO UPDATE SET updated_at=now()
        RETURNING id`, [randomUUID(), issuer, hash(email)]);
      const session = randomBytes(32).toString('hex');
      const oldSession = authSessionSecret(req.headers.cookie);
      if (oldSession) await client.query("DELETE FROM auth_sessions WHERE secret_hash=$1 AND purpose='web'", [hash(oldSession)]);
      await client.query(`
        INSERT INTO auth_sessions (id,user_id,secret_hash,expires_at,purpose)
        VALUES ($1,$2,$3,now()+interval '30 days','web')`, [randomUUID(), user.id, hash(session)]);
      await client.query('COMMIT');
      reply.header('Set-Cookie', [
        cookie(browserCookie, '', browserCookiePath, 0, config.secure),
        cookie('bscan_auth', session, '/', 30 * 24 * 60 * 60, config.secure),
      ]);
      return { authenticated: true };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  });
}
