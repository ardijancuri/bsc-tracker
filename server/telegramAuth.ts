import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import * as oidc from 'openid-client';
import { pool } from './db.js';
import { defaultPreferences, type AlertPreferences } from '../shared/intelligence.js';
import type { AuthError, AuthState, AuthUser } from '../shared/auth.js';

export const telegramIssuer = 'https://oauth.telegram.org';
const authCookie = 'bscan_auth';
const loginCookie = 'bscan_login';
const sessionSeconds = 30 * 24 * 60 * 60;
const loginSeconds = 10 * 60;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const secret = () => randomBytes(32).toString('hex');

export type TelegramAuthConfig = { clientId: string; clientSecret: string; origin: string; secure: boolean };
export type ResolvedAuthUser = AuthUser & { preferences: AlertPreferences };
export type GuestLoginSnapshot = { sessionId: string; secretHash: string } | null;
export type TelegramNotificationConsent = {
  available(): boolean;
  onAuthorized(value: { userId: string; telegramId: string; language: 'en' | 'zh-CN' }): Promise<void>;
  onFailed?(userId: string, reason: 'denied' | 'identity_mismatch' | 'failed'): Promise<void>;
};
export class AuthMergeLimitError extends Error {
  constructor() { super('Too many favorites to merge'); this.name = 'AuthMergeLimitError'; }
}

export function telegramAuthConfig(env: NodeJS.ProcessEnv = process.env): TelegramAuthConfig | null {
  if (!env.TELEGRAM_CLIENT_ID?.trim() || !env.TELEGRAM_CLIENT_SECRET?.trim() || !env.PUBLIC_APP_URL?.trim()) return null;
  try {
    const url = new URL(env.PUBLIC_APP_URL);
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/' || !['http:', 'https:'].includes(url.protocol)) return null;
    const secure = env.NODE_ENV === 'production' || url.protocol === 'https:';
    if ((secure && url.protocol !== 'https:') || (!secure && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) return null;
    return { clientId: env.TELEGRAM_CLIENT_ID.trim(), clientSecret: env.TELEGRAM_CLIENT_SECRET.trim(), origin: url.origin, secure };
  } catch { return null; }
}

export async function ensureAuthSchema(db: Pool) {
  const client = await db.connect();
  try {
  await client.query('BEGIN');
  await client.query('SELECT pg_advisory_xact_lock(782321)');
  await client.query(`
    CREATE TABLE IF NOT EXISTS auth_users (
      id uuid PRIMARY KEY, issuer text NOT NULL, subject text NOT NULL,
      name text NOT NULL, username text, avatar_url text,
      preferences jsonb NOT NULL DEFAULT '${JSON.stringify(defaultPreferences)}',
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (issuer,subject)
    );
    CREATE TABLE IF NOT EXISTS auth_sessions (
      id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
      secret_hash text UNIQUE NOT NULL, expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS auth_sessions_expiry_idx ON auth_sessions(expires_at);
    CREATE INDEX IF NOT EXISTS auth_sessions_user_idx ON auth_sessions(user_id);
    CREATE TABLE IF NOT EXISTS auth_login_attempts (
      state_hash text PRIMARY KEY, browser_hash text NOT NULL, code_verifier text NOT NULL, nonce text NOT NULL,
      return_to text NOT NULL, guest_snapshot jsonb, expires_at timestamptz NOT NULL
    );
    CREATE INDEX IF NOT EXISTS auth_login_expiry_idx ON auth_login_attempts(expires_at);
    ALTER TABLE auth_users ADD COLUMN IF NOT EXISTS telegram_id bigint;
    CREATE UNIQUE INDEX IF NOT EXISTS auth_users_telegram_id_idx ON auth_users(telegram_id) WHERE telegram_id IS NOT NULL;
    ALTER TABLE auth_login_attempts ADD COLUMN IF NOT EXISTS purpose text NOT NULL DEFAULT 'login';
    ALTER TABLE auth_login_attempts ADD COLUMN IF NOT EXISTS expected_user_id uuid;
    ALTER TABLE auth_login_attempts ADD COLUMN IF NOT EXISTS expected_issuer text;
    ALTER TABLE auth_login_attempts ADD COLUMN IF NOT EXISTS expected_subject text;
    ALTER TABLE auth_login_attempts ADD COLUMN IF NOT EXISTS expected_session_hash text;
    ALTER TABLE auth_login_attempts ADD COLUMN IF NOT EXISTS notification_language text;
  `);
  await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}

function cookieValue(cookie: string | undefined, name: string) {
  const values = (cookie ?? '').split(';').map(value => value.trim()).filter(value => value.startsWith(`${name}=`));
  if (values.length !== 1) return null;
  const value = values[0].slice(name.length + 1);
  return /^[a-f0-9]{64}$/.test(value) ? value : null;
}
export const authSessionSecret = (cookie: string | undefined) => cookieValue(cookie, authCookie);

export async function resolveAuthUser(request: FastifyRequest, db: Pool = pool): Promise<ResolvedAuthUser | null> {
  const value = authSessionSecret(request.headers.cookie);
  if (!value) return null;
  const result = await db.query(`SELECT u.id,u.name,u.username,u.avatar_url AS "avatarUrl",u.preferences
    FROM auth_sessions s JOIN auth_users u ON u.id=s.user_id WHERE s.secret_hash=$1 AND s.expires_at>now()`, [digest(value)]);
  return result.rows[0] ?? null;
}

export function safeAuthReturnTo(value: unknown) {
  if (typeof value !== 'string' || value.length > 2048 || !value.startsWith('/') || value.startsWith('//') || /[\\\u0000-\u0020\u007f]/.test(value)) return '/watchlist';
  try {
    const url = new URL(value, 'https://kollens.com');
    if (url.origin !== 'https://kollens.com' || url.pathname.startsWith('/api/')) return '/watchlist';
    url.searchParams.delete('authError');
    return `${url.pathname}${url.search}${url.hash}`;
  } catch { return '/watchlist'; }
}
function returnWithError(returnTo: string, error: AuthError) {
  const url = new URL(returnTo, 'https://kollens.com');
  url.searchParams.set('authError', error);
  return `${url.pathname}${url.search}${url.hash}`;
}
function returnWithNotificationStatus(returnTo: string, status: string) {
  const url = new URL(returnTo, 'https://kollens.com');
  url.searchParams.set('telegramAlerts', status);
  return `${url.pathname}${url.search}${url.hash}`;
}
function returnAfterTelegramLogin(returnTo: string) {
  const url = new URL(returnTo, 'https://kollens.com');
  url.searchParams.set('telegramLogin', 'success');
  return `${url.pathname}${url.search}${url.hash}`;
}
/** Telegram's OIDC subject is opaque. Only its signed profile `id` is a Bot API chat ID. */
export function verifiedTelegramId(value: unknown): string | null {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? String(value) : null;
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,15}$/.test(value)) return null;
  return BigInt(value) <= BigInt(Number.MAX_SAFE_INTEGER) ? value : null;
}
function privateResponse(reply: FastifyReply) { reply.header('Cache-Control', 'no-store').header('Vary', 'Cookie').header('Referrer-Policy', 'no-referrer'); }
/** Report fixed failure categories without OAuth URLs, credentials or claim values. */
export function authFailureCategory(error: unknown): { reason: string; field?: string } {
  if (error instanceof AuthMergeLimitError) return { reason: 'merge_limit' };
  const fields = ['nonce', 'iss', 'aud', 'exp', 'iat', 'state', 'code', 'alg', 'access_token', 'token_type', 'id_token', 'expires_in'];
  const oauthErrors = ['invalid_client', 'invalid_grant', 'invalid_request', 'unauthorized_client', 'unsupported_grant_type', 'invalid_scope', 'access_denied', 'server_error', 'temporarily_unavailable'];
  const causes: { code?: unknown; claim?: unknown; message?: unknown; cause?: unknown; error?: unknown; body?: unknown }[] = [];
  let current = error;
  for (let level = 0; level < 4 && current && typeof current === 'object'; level++) {
    const value = current as typeof causes[number];
    causes.push(value);
    current = value.cause;
  }
  // Telegram can return an OAuth error with HTTP 200. The library then reports a missing token field;
  // prefer the fixed provider error code nested in its cause without exposing the response body.
  for (const value of causes) {
    const bodyError = value.body && typeof value.body === 'object' && 'error' in value.body ? value.body.error : undefined;
    for (const code of [bodyError, value.error]) if (typeof code === 'string' && oauthErrors.includes(code)) return { reason: code };
  }
  for (const value of causes) {
    if (typeof value.claim === 'string' && fields.includes(value.claim)) return { reason: 'claim_validation', field: value.claim };
    const message = value.message;
    if (typeof message === 'string') {
      const field = fields.find(name => message.includes(`"${name}"`));
      if (field) return { reason: 'protocol_validation', field };
    }
  }
  const code = error && typeof error === 'object' && 'code' in error ? error.code : null;
  if (typeof code === 'string' && /^OAUTH_[A-Z_]{1,60}$/.test(code)) return { reason: code };
  if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return { reason: 'database_error' };
  return { reason: 'unexpected_error' };
}
function cookies(reply: FastifyReply, values: string[]) { reply.header('Set-Cookie', values); }
function formatCookie(name: string, value: string, seconds: number, secure: boolean) {
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${seconds}${secure ? '; Secure' : ''}`;
}
function clearGuestCookie(secure: boolean) { return `bscan_watch=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? '; Secure' : ''}`; }
function profile(claims: oidc.IDToken): Omit<AuthUser, 'id'> {
  let avatarUrl: string | null = null;
  if (typeof claims.picture === 'string' && claims.picture.length < 2048) {
    try {
      const url = new URL(claims.picture);
      if (url.protocol === 'https:' && !url.username && !url.password && /(^|\.)(telegram\.org|telesco\.pe|t\.me|telegram-cdn\.org)$/.test(url.hostname)) avatarUrl = url.href;
    } catch { /* A malformed optional profile image must not fail login. */ }
  }
  const clean = (value: unknown, max: number) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max) : '';
  return { name: clean(claims.name, 120) || clean(claims.preferred_username, 64) || 'Telegram user', username: clean(claims.preferred_username, 64) || null, avatarUrl };
}

export async function createTelegramOidc(config: TelegramAuthConfig, fetch?: oidc.CustomFetch) {
  // Telegram documents raw client_id:client_secret Basic credentials. The generic OAuth helper
  // form-encodes characters such as '-' and '_' first, which changes Telegram's client secret.
  const authenticate: oidc.ClientAuth = (_issuer, client, _body, headers) => {
    headers.set('authorization', `Basic ${Buffer.from(`${client.client_id}:${config.clientSecret}`).toString('base64')}`);
  };
  const client = await oidc.discovery(new URL(telegramIssuer), config.clientId, { client_secret: config.clientSecret, id_token_signed_response_alg: 'RS256' }, authenticate, {
    timeout: 10, execute: [oidc.enableNonRepudiationChecks], ...(fetch ? { [oidc.customFetch]: fetch } : {}),
  });
  // Discovery is rooted at the pinned issuer. No UserInfo call is made: Telegram returns profile claims in the ID token.
  if (client.serverMetadata().issuer !== telegramIssuer) throw new Error('Unexpected Telegram issuer');
  return client;
}

type AuthOptions = {
  pool?: Pool;
  config?: TelegramAuthConfig | null;
  oidcConfiguration?: () => Promise<oidc.Configuration>;
  captureGuest?: (request: FastifyRequest) => Promise<GuestLoginSnapshot>;
  mergeGuest?: (client: PoolClient, userId: string, snapshot: GuestLoginSnapshot, isNewUser: boolean) => Promise<void>;
  notificationConsent?: TelegramNotificationConsent;
};
type LoginAttempt = {
  code_verifier: string; nonce: string; return_to: string; guest_snapshot: GuestLoginSnapshot;
  purpose?: 'login' | 'notifications'; expected_user_id?: string; expected_issuer?: string; expected_subject?: string;
  expected_session_hash?: string; notification_language?: 'en' | 'zh-CN';
};

export function registerTelegramAuthRoutes(app: FastifyInstance, options: AuthOptions = {}) {
  const db = options.pool ?? pool;
  const config = options.config === undefined ? telegramAuthConfig() : options.config;
  let configuration: Promise<oidc.Configuration> | null = null;
  const getConfiguration = options.oidcConfiguration ?? (() => configuration ??= createTelegramOidc(config!).catch(error => { configuration = null; throw error; }));
  const secure = config?.secure ?? process.env.NODE_ENV === 'production';
  const reportFailure = (stage: string, error?: unknown) => app.log.warn({ event: 'telegram_login_failed', stage, ...authFailureCategory(error) }, 'Telegram sign-in did not complete');
  const attempts = new Map<string, { count: number; until: number }>();
  function limit(request: FastifyRequest, reply: FastifyReply, key: string, max: number) {
    const now = Date.now();
    if (attempts.size > 5000) for (const [key, entry] of attempts) if (entry.until <= now) attempts.delete(key);
    // Bound memory even if requests arrive with distinct spoofed forwarding addresses.
    if (attempts.size >= 10000 && !attempts.has(`${key}:${request.ip}`)) { reply.code(429).header('Retry-After', '60').send({ error: 'Try again shortly' }); return false; }
    const id = `${key}:${request.ip}`;
    const previous = attempts.get(id);
    const entry = previous && previous.until > now ? previous : { count: 0, until: now + 60_000 };
    attempts.set(id, entry);
    if (++entry.count > max) { reply.code(429).header('Retry-After', '60').send({ error: 'Try again shortly' }); return false; }
    return true;
  }
  function mutationAllowed(request: FastifyRequest, reply: FastifyReply) {
    let expected = config?.origin ?? 'https://kollens.com';
    try { expected = config?.origin ?? new URL(process.env.PUBLIC_APP_URL || 'https://kollens.com').origin; } catch { /* Invalid disabled configuration uses the production origin. */ }
    const origin = request.headers.origin;
    const development = process.env.NODE_ENV !== 'production' && origin === `${request.protocol}://${request.headers.host}`;
    if (origin !== expected && !development) { reply.code(403).send({ error: 'Request origin rejected' }); return false; }
    return limit(request, reply, 'mutation', 30);
  }
  async function currentIdentity(request: FastifyRequest) {
    const value = authSessionSecret(request.headers.cookie);
    if (!value) return null;
    const result = await db.query(`SELECT u.id,u.issuer,u.subject FROM auth_sessions s JOIN auth_users u ON u.id=s.user_id
      WHERE s.secret_hash=$1 AND s.expires_at>now()`, [digest(value)]);
    return result.rows[0] ? { ...result.rows[0], sessionHash: digest(value) } as { id: string; issuer: string; subject: string; sessionHash: string } : null;
  }
  async function consentIdentityMatches(request: FastifyRequest, attempt: LoginAttempt) {
    const identity = await currentIdentity(request);
    return !!identity && identity.id === attempt.expected_user_id && identity.issuer === attempt.expected_issuer
      && identity.subject === attempt.expected_subject && identity.sessionHash === attempt.expected_session_hash;
  }
  app.get('/api/auth/me', { logLevel: 'silent' }, async (request, reply): Promise<AuthState> => {
    privateResponse(reply);
    const user = await resolveAuthUser(request, db);
    if (!user && (request.headers.cookie ?? '').split(';').some(value => value.trim().startsWith(`${authCookie}=`))) cookies(reply, [formatCookie(authCookie, '', 0, secure)]);
    return { enabled: !!config, user: user ? { id: user.id, name: user.name, username: user.username, avatarUrl: user.avatarUrl } : null };
  });
  app.post('/api/auth/telegram/start', { logLevel: 'silent', bodyLimit: 4096 }, async (request, reply) => {
    privateResponse(reply);
    if (!mutationAllowed(request, reply)) return;
    if (!config) return reply.code(503).send({ error: 'Telegram login is not configured' });
    const body = request.body as { returnTo?: unknown } | null;
    if (body === null || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => key !== 'returnTo')) return reply.code(400).send({ error: 'Invalid login request' });
    const returnTo = safeAuthReturnTo(body.returnTo);
    try {
      const client = await getConfiguration();
      const state = secret(), browser = secret(), nonce = oidc.randomNonce(), verifier = oidc.randomPKCECodeVerifier();
      // Snapshot an authenticated guest at initiation; SameSite=Strict guest cookies are absent on the callback.
      const guest = await options.captureGuest?.(request) ?? null;
      await db.query('DELETE FROM auth_login_attempts WHERE expires_at<=now()');
      await db.query('DELETE FROM auth_sessions WHERE expires_at<=now()');
      await db.query(`INSERT INTO auth_login_attempts (state_hash,browser_hash,code_verifier,nonce,return_to,guest_snapshot,expires_at)
        VALUES ($1,$2,$3,$4,$5,$6::jsonb,now()+interval '10 minutes')`, [digest(state), digest(browser), verifier, nonce, returnTo, JSON.stringify(guest)]);
      const url = oidc.buildAuthorizationUrl(client, { redirect_uri: `${config.origin}/api/auth/telegram/callback`, scope: 'openid profile', state, nonce, code_challenge: await oidc.calculatePKCECodeChallenge(verifier), code_challenge_method: 'S256' });
      cookies(reply, [formatCookie(loginCookie, browser, loginSeconds, secure)]);
      return { url: url.href };
    } catch { return reply.code(503).send({ error: 'Telegram login is temporarily unavailable' }); }
  });
  app.post('/api/notifications/telegram/enable', { logLevel: 'silent', bodyLimit: 4096 }, async (request, reply) => {
    privateResponse(reply);
    if (!mutationAllowed(request, reply)) return;
    const identity = await currentIdentity(request);
    if (!identity) return reply.code(401).send({ error: 'Sign in to enable Telegram alerts' });
    if (request.headers['x-watchlist-owner'] !== undefined && request.headers['x-watchlist-owner'] !== identity.id) return reply.code(409).send({ error: 'Your account changed. Refresh and try again.' });
    if (!config || !options.notificationConsent?.available()) return reply.code(503).send({ error: 'Telegram alerts are not configured' });
    const body = request.body as { returnTo?: unknown; language?: unknown } | null;
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['returnTo', 'language'].includes(key))
      || (body.language !== undefined && body.language !== 'en' && body.language !== 'zh-CN')) return reply.code(400).send({ error: 'Invalid notification request' });
    try {
      const client = await getConfiguration();
      const state = secret(), browser = secret(), nonce = oidc.randomNonce(), verifier = oidc.randomPKCECodeVerifier();
      await db.query('DELETE FROM auth_login_attempts WHERE expires_at<=now()');
      await db.query(`INSERT INTO auth_login_attempts (state_hash,browser_hash,code_verifier,nonce,return_to,guest_snapshot,expires_at,
        purpose,expected_user_id,expected_issuer,expected_subject,expected_session_hash,notification_language)
        VALUES ($1,$2,$3,$4,$5,NULL,now()+interval '10 minutes','notifications',$6,$7,$8,$9,$10)`,
      [digest(state), digest(browser), verifier, nonce, safeAuthReturnTo(body.returnTo), identity.id, identity.issuer, identity.subject, identity.sessionHash, body.language ?? 'en']);
      const url = oidc.buildAuthorizationUrl(client, { redirect_uri: `${config.origin}/api/auth/telegram/callback`, scope: 'openid profile telegram:bot_access', state, nonce, code_challenge: await oidc.calculatePKCECodeChallenge(verifier), code_challenge_method: 'S256' });
      cookies(reply, [formatCookie(loginCookie, browser, loginSeconds, secure)]);
      return { url: url.href };
    } catch { return reply.code(503).send({ error: 'Telegram alerts are temporarily unavailable' }); }
  });
  app.get('/api/auth/telegram/callback', { logLevel: 'silent' }, async (request, reply) => {
    privateResponse(reply);
    cookies(reply, [formatCookie(loginCookie, '', 0, secure)]);
    if (!config || !limit(request, reply, 'callback', 60)) return config ? undefined : reply.code(503).send({ error: 'Telegram login is not configured' });
    const url = new URL(request.url, config.origin);
    const states = url.searchParams.getAll('state');
    const state = states.length > 0 && /^[a-f0-9]{64}$/.test(states[0]) && states.every(value => value === states[0]) ? states[0] : null;
    const browser = cookieValue(request.headers.cookie, loginCookie);
    if (!state || !browser || request.url.length > 8192) {
      reportFailure(!state ? 'callback_state' : !browser ? 'browser_binding' : 'callback_size');
      return reply.redirect('/watchlist?authError=failed');
    }
    // Telegram may repeat the same state during its browser handoff; conflicting values remain invalid.
    url.searchParams.set('state', state);
    let attempt: LoginAttempt | undefined;
    let stage = 'login_attempt';
    try {
      const consumed = await db.query(`DELETE FROM auth_login_attempts WHERE state_hash=$1 AND browser_hash=$2 AND expires_at>now()
        RETURNING code_verifier,nonce,return_to,guest_snapshot,purpose,expected_user_id,expected_issuer,expected_subject,expected_session_hash,notification_language`, [digest(state), digest(browser)]);
      attempt = consumed.rows[0];
      if (!attempt) { reportFailure(stage); return reply.redirect('/watchlist?authError=failed'); }
      if (url.searchParams.has('error')) {
        reportFailure('provider_response');
        if (attempt.purpose === 'notifications') {
          if (await consentIdentityMatches(request, attempt)) await options.notificationConsent?.onFailed?.(attempt.expected_user_id!, url.searchParams.get('error') === 'access_denied' ? 'denied' : 'failed');
          return reply.redirect(returnWithNotificationStatus(attempt.return_to, url.searchParams.get('error') === 'access_denied' ? 'denied' : 'failed'));
        }
        return reply.redirect(returnWithError(attempt.return_to, url.searchParams.get('error') === 'access_denied' ? 'cancelled' : 'failed'));
      }
      if (attempt.purpose === 'notifications' && !await consentIdentityMatches(request, attempt)) return reply.redirect(returnWithNotificationStatus(attempt.return_to, 'identity_mismatch'));
      stage = 'token_exchange';
      const client = await getConfiguration();
      const tokens = await oidc.authorizationCodeGrant(client, url, { pkceCodeVerifier: attempt.code_verifier, expectedState: state, expectedNonce: attempt.nonce, idTokenExpected: true }, { client_id: config.clientId });
      const claims = tokens.claims();
      stage = 'identity_validation';
      // openid-client enforces issuer, audience, time, nonce and PKCE; non-repudiation additionally verifies the JWKS signature.
      if (!claims || claims.iss !== telegramIssuer || typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 255 || !claims.exp || claims.exp <= Date.now() / 1000 || !Number.isFinite(claims.iat) || claims.iat > Date.now() / 1000 + 60) throw new Error('Invalid Telegram identity');
      const telegramId = verifiedTelegramId(claims.id);
      if (attempt.purpose === 'notifications') {
        stage = 'notification_identity';
        if (!options.notificationConsent?.available() || !telegramId) throw new Error('Telegram notification identity unavailable');
        if (claims.iss !== attempt.expected_issuer || claims.sub !== attempt.expected_subject || !await consentIdentityMatches(request, attempt)) {
          if (await consentIdentityMatches(request, attempt)) await options.notificationConsent.onFailed?.(attempt.expected_user_id!, 'identity_mismatch');
          return reply.redirect(returnWithNotificationStatus(attempt.return_to, 'identity_mismatch'));
        }
        await options.notificationConsent.onAuthorized({ userId: attempt.expected_user_id!, telegramId, language: attempt.notification_language ?? 'en' });
        return reply.redirect(returnWithNotificationStatus(attempt.return_to, 'pending'));
      }
      const identity = profile(claims);
      stage = 'save_session';
      const connection = await db.connect();
      const session = secret();
      try {
        await connection.query('BEGIN');
        const inserted = await connection.query(`INSERT INTO auth_users (id,issuer,subject,name,username,avatar_url) VALUES ($1,$2,$3,$4,$5,$6)
          ON CONFLICT (issuer,subject) DO NOTHING RETURNING id`, [randomUUID(), telegramIssuer, claims.sub, identity.name, identity.username, identity.avatarUrl]);
        const isNewUser = inserted.rows.length === 1;
        const existing = isNewUser ? inserted : await connection.query(`UPDATE auth_users SET name=$3,username=$4,avatar_url=$5,updated_at=now()
          WHERE issuer=$1 AND subject=$2 RETURNING id`, [telegramIssuer, claims.sub, identity.name, identity.username, identity.avatarUrl]);
        const userId = existing.rows[0].id as string;
        if (telegramId) await connection.query('UPDATE auth_users SET telegram_id=$2 WHERE id=$1 AND (telegram_id IS NULL OR telegram_id=$2)', [userId, telegramId]);
        await options.mergeGuest?.(connection, userId, attempt.guest_snapshot, isNewUser);
        const oldSession = authSessionSecret(request.headers.cookie);
        if (oldSession) await connection.query('DELETE FROM auth_sessions WHERE secret_hash=$1', [digest(oldSession)]);
        await connection.query(`INSERT INTO auth_sessions (id,user_id,secret_hash,expires_at) VALUES ($1,$2,$3,now()+interval '30 days')`, [randomUUID(), userId, digest(session)]);
        await connection.query('COMMIT');
      } catch (error) { await connection.query('ROLLBACK'); throw error; } finally { connection.release(); }
      cookies(reply, [formatCookie(loginCookie, '', 0, secure), formatCookie(authCookie, session, sessionSeconds, secure), clearGuestCookie(secure)]);
      return reply.redirect(returnAfterTelegramLogin(attempt.return_to));
    } catch (error) {
      reportFailure(stage, error);
      if (attempt?.purpose === 'notifications') {
        try { if (await consentIdentityMatches(request, attempt)) await options.notificationConsent?.onFailed?.(attempt.expected_user_id!, 'failed'); } catch { /* Leave the connection inactive when its error state cannot be saved. */ }
        return reply.redirect(returnWithNotificationStatus(attempt.return_to, 'failed'));
      }
      return reply.redirect(returnWithError(attempt?.return_to ?? '/watchlist', error instanceof AuthMergeLimitError ? 'merge_limit' : 'failed'));
    }
  });
  app.post('/api/auth/logout', { logLevel: 'silent' }, async (request, reply) => {
    privateResponse(reply);
    if (!mutationAllowed(request, reply)) return;
    const value = authSessionSecret(request.headers.cookie);
    if (value) await db.query('DELETE FROM auth_sessions WHERE secret_hash=$1', [digest(value)]);
    cookies(reply, [formatCookie(authCookie, '', 0, secure), formatCookie(loginCookie, '', 0, secure), clearGuestCookie(secure)]);
    return { enabled: !!config, user: null } satisfies AuthState;
  });
}
