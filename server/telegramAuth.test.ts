import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import Fastify from 'fastify';
import type { Pool } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthMergeLimitError, authFailureCategory, authSessionSecret, createTelegramOidc, registerTelegramAuthRoutes, resolveAuthUser, safeAuthReturnTo, telegramAuthConfig, telegramIssuer, verifiedTelegramId, type TelegramAuthConfig } from './telegramAuth.js';

const config: TelegramAuthConfig = { clientId: '12345', clientSecret: 'test-client_secret-with_both-characters', origin: 'https://kollens.com', secure: true };
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const wrongKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test', use: 'sig', alg: 'RS256' };
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });

function fakeDatabase() {
  const loginAttempts = new Map<string, Record<string, unknown>>();
  const sessions = new Map<string, string>();
  const users = new Map<string, Record<string, unknown>>();
  const queries: { sql: string; args: unknown[] }[] = [];
  let backup: { sessions: typeof sessions; users: typeof users } | null = null;
  const query = vi.fn(async (sql: string, args: unknown[] = []) => {
    queries.push({ sql, args });
    if (sql === 'BEGIN') backup = { sessions: new Map(sessions), users: new Map(users) };
    if (sql === 'ROLLBACK' && backup) { sessions.clear(); users.clear(); for (const [k, v] of backup.sessions) sessions.set(k, v); for (const [k, v] of backup.users) users.set(k, v); }
    if (sql.startsWith('INSERT INTO auth_login_attempts')) loginAttempts.set(args[0] as string, { browser_hash: args[1], code_verifier: args[2], nonce: args[3], return_to: args[4], ...(sql.includes("'notifications'")
      ? { guest_snapshot: null, purpose: 'notifications', expected_user_id: args[5], expected_issuer: args[6], expected_subject: args[7], expected_session_hash: args[8], notification_language: args[9] }
      : { guest_snapshot: JSON.parse(args[5] as string), purpose: 'login' }) });
    if (sql.startsWith('DELETE FROM auth_login_attempts WHERE state_hash')) {
      const attempt = loginAttempts.get(args[0] as string);
      if (attempt?.browser_hash === args[1]) { loginAttempts.delete(args[0] as string); return { rows: [attempt] }; }
    }
    if (sql.startsWith('INSERT INTO auth_users')) {
      if (users.has(args[2] as string)) return { rows: [] };
      const user = { id: args[0], issuer: args[1], subject: args[2], name: args[3], username: args[4], avatarUrl: args[5] };
      users.set(args[2] as string, user);
      return { rows: [{ id: args[0] }] };
    }
    if (sql.startsWith('UPDATE auth_users')) return { rows: [{ id: users.get(args[1] as string)?.id }] };
    if (sql.startsWith('INSERT INTO auth_sessions')) sessions.set(args[2] as string, args[1] as string);
    if (sql.startsWith('DELETE FROM auth_sessions WHERE secret_hash')) sessions.delete(args[0] as string);
    if (sql.startsWith('SELECT u.id')) {
      const id = sessions.get(args[0] as string);
      const user = [...users.values()].find(user => user.id === id);
      return { rows: user ? [user] : [] };
    }
    return { rows: [] };
  });
  const connection = { query, release: vi.fn() };
  return { db: { query, connect: vi.fn(async () => connection) } as unknown as Pool, queries, users, sessions, loginAttempts };
}

async function fixture(overrides: Record<string, unknown> = {}, options: { badSignature?: boolean; disabled?: boolean; mergeLimit?: boolean; notifications?: boolean; tokenError?: { error: string; status: number } } = {}) {
  const database = fakeDatabase();
  let nonce = '';
  const tokenRequests: RequestInit[] = [];
  const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/.well-known/openid-configuration')) return Response.json({ issuer: telegramIssuer, authorization_endpoint: `${telegramIssuer}/auth`, token_endpoint: `${telegramIssuer}/token`, jwks_uri: `${telegramIssuer}/.well-known/jwks.json`, response_types_supported: ['code'], subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['RS256'], token_endpoint_auth_methods_supported: ['client_secret_basic'], code_challenge_methods_supported: ['S256'] });
    if (url.endsWith('/.well-known/jwks.json')) return Response.json({ keys: [jwk] });
    if (url.endsWith('/token')) {
      tokenRequests.push(init!);
      const form = new URLSearchParams(init?.body as URLSearchParams);
      const basic = new Headers(init?.headers).get('authorization') ?? '';
      // Telegram expects raw Basic credentials, rather than percent-encoded OAuth credentials.
      const credentials = basic.startsWith('Basic ') ? Buffer.from(basic.slice(6), 'base64').toString().split(':') : [];
      if (form.getAll('client_id').length !== 1 || form.get('client_id') !== config.clientId || credentials[0] !== config.clientId || credentials[1] !== config.clientSecret) {
        return Response.json({ error: 'invalid_client' }, { status: 401 });
      }
      if (options.tokenError) return Response.json({ error: options.tokenError.error, error_description: 'private-provider-description' }, { status: options.tokenError.status });
      const now = Math.floor(Date.now() / 1000);
      const claims = { iss: telegramIssuer, aud: config.clientId, sub: '987654321', iat: now, exp: now + 3600, nonce, name: 'Kollens Tester', preferred_username: 'tester', picture: 'https://cdn4.telesco.pe/file/avatar.jpg', ...overrides };
      const body = [Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'test' })).toString('base64url'), Buffer.from(JSON.stringify(claims)).toString('base64url')].join('.');
      const signature = sign('RSA-SHA256', Buffer.from(body), options.badSignature ? wrongKey : privateKey).toString('base64url');
      return Response.json({ access_token: 'access-token-never-persisted', token_type: 'Bearer', expires_in: 3600, id_token: `${body}.${signature}` });
    }
    throw new Error(`Unexpected endpoint: ${url}`);
  });
  const captureGuest = vi.fn(async () => ({ sessionId: 'guest-1', secretHash: 'guest-secret-hash' }));
  const mergeGuest = vi.fn(async () => { if (options.mergeLimit) throw new AuthMergeLimitError(); });
  const authorized = vi.fn(async () => {}), consentFailed = vi.fn(async () => {});
  const failures: Record<string, unknown>[] = [];
  const app = Fastify({ logger: options.tokenError ? { level: 'warn', stream: { write: value => { failures.push(JSON.parse(value)); } } } : false });
  apps.push(app);
  registerTelegramAuthRoutes(app, { pool: database.db, config: options.disabled ? null : config, oidcConfiguration: () => createTelegramOidc(config, fetcher as never), captureGuest, mergeGuest,
    notificationConsent: { available: () => !!options.notifications, onAuthorized: authorized, onFailed: consentFailed } });
  async function start(returnTo: unknown = '/token/0xabc?period=7d#chart') {
    const response = await app.inject({ method: 'POST', url: '/api/auth/telegram/start', headers: { origin: config.origin }, payload: { returnTo } });
    if (response.statusCode !== 200) throw new Error(response.body);
    const url = new URL(response.json().url);
    nonce = url.searchParams.get('nonce')!;
    const cookie = response.cookies.find(value => value.name === 'bscan_login')!.value;
    return { response, url, state: url.searchParams.get('state')!, cookie };
  }
  async function callback(state: string, cookie: string, extra = '&code=one-time-code', session = '') {
    return app.inject({ method: 'GET', url: `/api/auth/telegram/callback?state=${state}${extra}`, headers: { cookie: `bscan_login=${cookie}${session ? `; bscan_auth=${session}` : ''}` } });
  }
  async function consent(session: string, payload: unknown = { returnTo: '/watchlist?tab=kols', language: 'zh-CN' }) {
    const response = await app.inject({ method: 'POST', url: '/api/notifications/telegram/enable', headers: { origin: config.origin, cookie: `bscan_auth=${session}` }, payload: payload as never });
    const url = response.statusCode === 200 ? new URL(response.json().url) : null;
    if (url) nonce = url.searchParams.get('nonce')!;
    return { response, url, state: url?.searchParams.get('state')!, cookie: response.cookies.find(value => value.name === 'bscan_login')?.value! };
  }
  return { ...database, app, start, callback, consent, authorized, consentFailed, captureGuest, mergeGuest, tokenRequests, fetcher, failures };
}

describe('Telegram auth configuration and inputs', () => {
  it('classifies failures without returning provider credentials, URLs or claim values', () => {
    const details = authFailureCategory({ message: 'Provider rejected token containing a-private-token', cause: { claim: 'nonce', expected: 'private-nonce', actual: 'other-private-nonce' } });
    expect(details).toEqual({ reason: 'claim_validation', field: 'nonce' });
    expect(JSON.stringify(details)).not.toMatch(/private|https/);
    expect(authFailureCategory({ code: '23505', detail: 'private-user-id' })).toEqual({ reason: 'database_error' });
    expect(authFailureCategory({ message: 'private-secret' })).toEqual({ reason: 'unexpected_error' });
  });
  it('prefers fixed OAuth errors over missing fields without exposing nested response values', () => {
    const error = { code: 'OAUTH_INVALID_RESPONSE', cause: { message: '"response" body "access_token" property must be a string', cause: { body: { error: 'invalid_client', error_description: 'private-client-secret', access_token: 'private-token' } } } };
    expect(authFailureCategory(error)).toEqual({ reason: 'invalid_client' });
    expect(authFailureCategory({ ...error, cause: { ...error.cause, cause: { body: { error: 'private-provider-error' } } } })).toEqual({ reason: 'protocol_validation', field: 'access_token' });
  });
  it.each(['access_token', 'token_type', 'id_token', 'expires_in'])('classifies the fixed token response field %s', field => {
    expect(authFailureCategory({ cause: { message: `"response" body "${field}" property is invalid`, cause: { body: { [field]: 'private-value' } } } })).toEqual({ reason: 'protocol_validation', field });
  });
  it('requires explicit complete config and HTTPS in production', () => {
    expect(telegramAuthConfig({})).toBeNull();
    expect(telegramAuthConfig({ TELEGRAM_CLIENT_ID: '1', TELEGRAM_CLIENT_SECRET: 'secret', PUBLIC_APP_URL: 'http://kollens.com', NODE_ENV: 'production' })).toBeNull();
    expect(telegramAuthConfig({ TELEGRAM_CLIENT_ID: '1', TELEGRAM_CLIENT_SECRET: 'secret', PUBLIC_APP_URL: 'https://kollens.com/path' })).toBeNull();
    expect(telegramAuthConfig({ TELEGRAM_CLIENT_ID: '1', TELEGRAM_CLIENT_SECRET: 'secret', PUBLIC_APP_URL: 'https://attacker@kollens.com/' })).toBeNull();
    expect(telegramAuthConfig({ TELEGRAM_CLIENT_ID: '1', TELEGRAM_CLIENT_SECRET: 'secret', PUBLIC_APP_URL: 'http://127.0.0.1:5173', NODE_ENV: 'development' })?.secure).toBe(false);
  });
  it.each(['https://evil.example', '//evil.example', '/\\evil.example', '/api/auth/logout', '/\nlogin'])('rejects unsafe return URL %s', value => expect(safeAuthReturnTo(value)).toBe('/watchlist'));
  it('accepts local paths and strips previous login errors', () => expect(safeAuthReturnTo('/watchlist?authError=failed&tab=kols#list')).toBe('/watchlist?tab=kols#list'));
  it('rejects malformed and duplicate auth cookies', () => {
    expect(authSessionSecret('bscan_auth=bad')).toBeNull();
    expect(authSessionSecret(`bscan_auth=${'a'.repeat(64)}; bscan_auth=${'b'.repeat(64)}`)).toBeNull();
  });
  it('does not query a database without an auth cookie', async () => {
    const { db } = fakeDatabase();
    expect(await resolveAuthUser({ headers: {} } as never, db)).toBeNull();
    expect(db.query).not.toHaveBeenCalled();
  });
  it('accepts only safe positive signed Telegram numeric IDs, never an opaque subject', () => {
    expect(verifiedTelegramId(987654321)).toBe('987654321');
    expect(verifiedTelegramId('987654321')).toBe('987654321');
    for (const value of [null, undefined, 'opaque-sub', '001', 0, -1, 1.25, Number.MAX_SAFE_INTEGER + 1, '9007199254740992']) expect(verifiedTelegramId(value)).toBeNull();
  });
});

describe('Telegram notification consent', () => {
  async function signedIn(f: Awaited<ReturnType<typeof fixture>>) {
    const { state, cookie } = await f.start('/watchlist');
    const login = await f.callback(state, cookie);
    const session = login.cookies.find(value => value.name === 'bscan_auth')!.value;
    f.mergeGuest.mockClear(); f.captureGuest.mockClear();
    return session;
  }
  it('uses separate messaging scope and activates only the bound current account without replacing its session', async () => {
    const f = await fixture({ id: 123456789, sub: 'opaque-telegram-subject' }, { notifications: true });
    const session = await signedIn(f);
    const beforeSessions = new Map(f.sessions), beforeUsers = f.users.size;
    const { response, url, state, cookie } = await f.consent(session);
    expect(response.statusCode).toBe(200);
    expect(url!.searchParams.get('scope')).toBe('openid profile telegram:bot_access');
    const result = await f.callback(state, cookie, '&code=consent-code', session);
    expect(result.headers.location).toBe('/watchlist?tab=kols&telegramAlerts=pending');
    expect(f.authorized).toHaveBeenCalledWith({ userId: [...f.users.values()][0].id, telegramId: '123456789', language: 'zh-CN' });
    expect(f.captureGuest).not.toHaveBeenCalled(); expect(f.mergeGuest).not.toHaveBeenCalled();
    expect(f.sessions).toEqual(beforeSessions); expect(f.users.size).toBe(beforeUsers);
    expect(result.cookies.map(value => value.name)).toEqual(['bscan_login']);
  });
  it('does not infer a chat ID from sub when the numeric profile id is missing', async () => {
    const f = await fixture({}, { notifications: true });
    const session = await signedIn(f), { state, cookie } = await f.consent(session);
    expect((await f.callback(state, cookie, '&code=consent-code', session)).headers.location).toContain('telegramAlerts=failed');
    expect(f.authorized).not.toHaveBeenCalled();
    expect(f.consentFailed).toHaveBeenCalledWith([...f.users.values()][0].id, 'failed');
  });
  it('does not merge or log in a different identity during messaging consent', async () => {
    const f = await fixture({ id: 1234 }, { notifications: true });
    const session = await signedIn(f), { state, cookie } = await f.consent(session);
    f.loginAttempts.get(digest(state))!.expected_subject = 'another-identity';
    expect((await f.callback(state, cookie, '&code=consent-code', session)).headers.location).toContain('telegramAlerts=identity_mismatch');
    expect(f.authorized).not.toHaveBeenCalled(); expect(f.mergeGuest).not.toHaveBeenCalled(); expect(f.users.size).toBe(1);
  });
  it('rejects a newly signed different Telegram identity after the token exchange', async () => {
    const claims = { id: 1234, sub: 'original-subject' };
    const f = await fixture(claims, { notifications: true });
    const session = await signedIn(f), { state, cookie } = await f.consent(session);
    claims.id = 6789; claims.sub = 'another-subject';
    expect((await f.callback(state, cookie, '&code=consent-code', session)).headers.location).toContain('telegramAlerts=identity_mismatch');
    expect(f.authorized).not.toHaveBeenCalled(); expect(f.mergeGuest).not.toHaveBeenCalled(); expect(f.users.size).toBe(1);
    expect(f.consentFailed).toHaveBeenCalledWith([...f.users.values()][0].id, 'identity_mismatch');
  });
  it.each(['', 'b'.repeat(64)])('rejects a missing or changed current session before token exchange', async changed => {
    const f = await fixture({ id: 1234 }, { notifications: true });
    const session = await signedIn(f), { state, cookie } = await f.consent(session);
    const count = f.tokenRequests.length;
    expect((await f.callback(state, cookie, '&code=consent-code', changed)).headers.location).toContain('telegramAlerts=identity_mismatch');
    expect(f.tokenRequests).toHaveLength(count); expect(f.authorized).not.toHaveBeenCalled();
  });
  it('records denied consent without changing session or requesting tokens', async () => {
    const f = await fixture({ id: 1234 }, { notifications: true });
    const session = await signedIn(f), { state, cookie } = await f.consent(session);
    const count = f.tokenRequests.length;
    expect((await f.callback(state, cookie, '&error=access_denied', session)).headers.location).toContain('telegramAlerts=denied');
    expect(f.tokenRequests).toHaveLength(count); expect(f.authorized).not.toHaveBeenCalled();
    expect(f.consentFailed).toHaveBeenCalledWith([...f.users.values()][0].id, 'denied');
  });
  it('keeps the account signed in when consent persistence or activation queue creation fails', async () => {
    const f = await fixture({ id: 1234 }, { notifications: true });
    const session = await signedIn(f), { state, cookie } = await f.consent(session);
    f.authorized.mockRejectedValueOnce(new Error('private-storage-details'));
    const result = await f.callback(state, cookie, '&code=consent-code', session);
    expect(result.headers.location).toContain('telegramAlerts=failed');
    expect(f.sessions.has(digest(session))).toBe(true); expect(f.mergeGuest).not.toHaveBeenCalled();
    expect(result.cookies.map(value => value.name)).toEqual(['bscan_login']);
    expect(f.consentFailed).toHaveBeenCalledWith([...f.users.values()][0].id, 'failed');
  });
  it('requires a signed-in user, configured transport and valid input', async () => {
    const f = await fixture({}, { notifications: false });
    expect((await f.consent('')).response.statusCode).toBe(401);
    expect((await f.consent(await signedIn(f))).response.statusCode).toBe(503);
    const ready = await fixture({}, { notifications: true }), session = await signedIn(ready);
    expect((await ready.consent(session, { language: 'fr' })).response.statusCode).toBe(400);
    expect((await ready.app.inject({ method: 'POST', url: '/api/notifications/telegram/enable', headers: { origin: config.origin, cookie: `bscan_auth=${session}`, 'x-watchlist-owner': 'another-user' }, payload: {} })).statusCode).toBe(409);
  });
});

describe('Telegram OIDC route flow', () => {
  it('is disabled safely when credentials are absent and keeps responses private', async () => {
    const f = await fixture({}, { disabled: true });
    const me = await f.app.inject('/api/auth/me');
    expect(me.json()).toEqual({ enabled: false, user: null });
    expect(me.headers['cache-control']).toBe('no-store');
    const start = await f.app.inject({ method: 'POST', url: '/api/auth/telegram/start', headers: { origin: config.origin }, payload: { returnTo: '/' } });
    expect(start.statusCode).toBe(503);
    expect(f.captureGuest).not.toHaveBeenCalled();
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it('expires invalid or expired auth cookies so guests can save favorites again without clearing their guest list', async () => {
    const f = await fixture();
    for (const value of ['invalid', 'a'.repeat(64)]) {
      const me = await f.app.inject({ url: '/api/auth/me', headers: { cookie: `bscan_auth=${value}; bscan_watch=${'b'.repeat(64)}` } });
      expect(me.json()).toEqual({ enabled: true, user: null });
      expect(me.cookies).toHaveLength(1);
      expect(me.cookies[0]).toMatchObject({ name: 'bscan_auth', value: '', maxAge: 0 });
    }
  });
  it('starts with basic profile scope, nonce, PKCE and a secure browser-binding cookie', async () => {
    const f = await fixture();
    const { response, url, cookie, state } = await f.start();
    expect(url.origin).toBe(telegramIssuer);
    expect(url.searchParams.get('scope')).toBe('openid profile');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toHaveLength(43);
    expect(response.headers['set-cookie']).toEqual(expect.arrayContaining([expect.stringContaining('HttpOnly; SameSite=Lax; Max-Age=600; Secure')]));
    const attempt = f.loginAttempts.get(digest(state))!;
    expect(attempt.browser_hash).toBe(digest(cookie));
    expect(attempt.guest_snapshot).toEqual({ sessionId: 'guest-1', secretHash: 'guest-secret-hash' });
    expect(JSON.stringify(attempt)).not.toContain(config.clientSecret);
    expect(JSON.stringify(attempt)).not.toContain(state);
  });
  it('validates a signed token, atomically merges favorites and creates only hashed server sessions', async () => {
    const f = await fixture();
    const { state, cookie } = await f.start();
    const response = await f.callback(state, cookie);
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe('/token/0xabc?period=7d&telegramLogin=success#chart');
    expect(f.mergeGuest).toHaveBeenCalledWith(expect.anything(), expect.any(String), { sessionId: 'guest-1', secretHash: 'guest-secret-hash' }, true);
    const session = response.cookies.find(value => value.name === 'bscan_auth')!.value;
    expect(f.sessions.has(digest(session))).toBe(true);
    expect(f.sessions.has(session)).toBe(false);
    expect(response.headers['set-cookie']).toEqual(expect.arrayContaining([expect.stringContaining('Max-Age=2592000; Secure'), expect.stringContaining('bscan_watch=;')]));
    const me = await f.app.inject({ url: '/api/auth/me', headers: { cookie: `bscan_auth=${session}` } });
    expect(me.json().user).toEqual({ id: expect.any(String), name: 'Kollens Tester', username: 'tester', avatarUrl: 'https://cdn4.telesco.pe/file/avatar.jpg' });
    expect(JSON.stringify(f.queries)).not.toContain('access-token-never-persisted');
    const tokenBody = f.tokenRequests[0].body as URLSearchParams;
    expect(new URLSearchParams(tokenBody as never).get('code_verifier')).toBeTruthy();
    expect(new URLSearchParams(tokenBody as never).getAll('client_id')).toEqual([config.clientId]);
    expect(new Headers(f.tokenRequests[0].headers).get('authorization')).toBe(`Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')}`);
  });
  it.each([200, 401])('safely reports Telegram OAuth body errors with HTTP %i', async status => {
    const f = await fixture({}, { tokenError: { error: 'invalid_grant', status } });
    const { state, cookie } = await f.start('/watchlist');
    const response = await f.callback(state, cookie);
    expect(response.headers.location).toBe('/watchlist?authError=failed');
    expect(f.users.size).toBe(0);
    expect(f.sessions.size).toBe(0);
    expect(f.failures).toEqual([expect.objectContaining({ event: 'telegram_login_failed', stage: 'token_exchange', reason: 'invalid_grant' })]);
    expect(JSON.stringify(f.failures)).not.toMatch(/private-provider-description|one-time-code|test-client_secret|access-token-never-persisted/);
  });
  it('accepts repeated identical state values from the Telegram browser handoff', async () => {
    const f = await fixture();
    const { state, cookie } = await f.start('/watchlist');
    const response = await f.callback(state, cookie, `&state=${state}&state=${state}&code=one-time-code`);
    expect(response.headers.location).toBe('/watchlist?telegramLogin=success');
    expect(response.cookies.some(value => value.name === 'bscan_auth')).toBe(true);
    expect(f.tokenRequests).toHaveLength(1);
    expect(f.users.size).toBe(1);
  });
  it.each(['b'.repeat(64), '', 'invalid'])('rejects conflicting duplicate state values before consuming the login attempt: %s', async duplicate => {
    const f = await fixture();
    const { state, cookie } = await f.start('/watchlist');
    const conflicting = duplicate === state ? 'c'.repeat(64) : duplicate;
    const response = await f.callback(state, cookie, `&state=${conflicting}&code=one-time-code`);
    expect(response.headers.location).toBe('/watchlist?authError=failed');
    expect(f.tokenRequests).toHaveLength(0);
    expect(f.users.size).toBe(0);
    expect(f.loginAttempts.has(digest(state))).toBe(true);
  });
  it.each([
    ['wrong issuer', { iss: 'https://attacker.example' }], ['wrong audience', { aud: 'other-client' }],
    ['expired token', { exp: Math.floor(Date.now() / 1000) - 300 }], ['just expired token', { exp: Math.floor(Date.now() / 1000) - 1 }],
    ['future issued token', { iat: Math.floor(Date.now() / 1000) + 300 }], ['wrong nonce', { nonce: 'replayed-nonce' }],
    ['missing nonce', { nonce: undefined }], ['missing subject', { sub: undefined }],
  ])('rejects %s before any account or favorite is written', async (_name, claims) => {
    const f = await fixture(claims);
    const { state, cookie } = await f.start();
    const response = await f.callback(state, cookie);
    expect(response.headers.location).toContain('authError=failed');
    expect(f.users.size).toBe(0);
    expect(f.sessions.size).toBe(0);
    expect(f.mergeGuest).not.toHaveBeenCalled();
  });
  it('rejects a forged signature even though it came from the token endpoint', async () => {
    const f = await fixture({}, { badSignature: true });
    const { state, cookie } = await f.start();
    expect((await f.callback(state, cookie)).headers.location).toContain('authError=failed');
    expect(f.mergeGuest).not.toHaveBeenCalled();
  });
  it('rejects callback replay and browser/state mismatch without using the token endpoint', async () => {
    const f = await fixture();
    const { state, cookie } = await f.start();
    expect((await f.callback(state, 'b'.repeat(64))).headers.location).toContain('authError=failed');
    expect(f.tokenRequests).toHaveLength(0);
    await f.callback(state, cookie);
    expect(f.tokenRequests).toHaveLength(1);
    expect((await f.callback(state, cookie)).headers.location).toContain('authError=failed');
    expect(f.tokenRequests).toHaveLength(1);
  });
  it('keeps favorites and sessions unchanged when merge limits abort login', async () => {
    const f = await fixture({}, { mergeLimit: true });
    const { state, cookie } = await f.start('/watchlist');
    expect((await f.callback(state, cookie)).headers.location).toBe('/watchlist?authError=merge_limit');
    expect(f.users.size).toBe(0);
    expect(f.sessions.size).toBe(0);
    expect(f.queries.some(query => query.sql === 'ROLLBACK')).toBe(true);
  });
  it('handles cancellation without changing favorites or requesting tokens', async () => {
    const f = await fixture();
    const { state, cookie } = await f.start('/watchlist');
    expect((await f.callback(state, cookie, '&error=access_denied')).headers.location).toBe('/watchlist?authError=cancelled');
    expect(f.tokenRequests).toHaveLength(0);
    expect(f.mergeGuest).not.toHaveBeenCalled();
  });
  it('removes only the current session on logout and clears guest/login cookies', async () => {
    const f = await fixture();
    const { state, cookie } = await f.start();
    const login = await f.callback(state, cookie);
    const session = login.cookies.find(value => value.name === 'bscan_auth')!.value;
    f.sessions.set(digest('another-device'), 'other-device-session');
    const response = await f.app.inject({ method: 'POST', url: '/api/auth/logout', headers: { origin: config.origin, cookie: `bscan_auth=${session}` } });
    expect(response.json()).toEqual({ enabled: true, user: null });
    expect(f.sessions.has(digest(session))).toBe(false);
    expect(f.sessions.has(digest('another-device'))).toBe(true);
    expect(response.cookies.map(value => value.name)).toEqual(['bscan_auth', 'bscan_login', 'bscan_watch']);
  });
  it.each(['/api/auth/telegram/start', '/api/auth/logout'])('rejects cross-origin mutation %s', async url => {
    const f = await fixture();
    expect((await f.app.inject({ method: 'POST', url, headers: { origin: 'https://attacker.example' }, payload: { returnTo: '/' } })).statusCode).toBe(403);
    expect(f.captureGuest).not.toHaveBeenCalled();
    expect(f.queries).toHaveLength(0);
  });
  it('rate limits repeated login attempts', async () => {
    const f = await fixture({}, { disabled: true });
    for (let i = 0; i < 30; i++) await f.app.inject({ method: 'POST', url: '/api/auth/telegram/start', headers: { origin: config.origin }, payload: { returnTo: '/' } });
    const response = await f.app.inject({ method: 'POST', url: '/api/auth/telegram/start', headers: { origin: config.origin }, payload: { returnTo: '/' } });
    expect(response.statusCode).toBe(429);
    expect(response.headers['retry-after']).toBe('60');
  });
  it('never logs callback authorization codes, state or binding cookies through automatic Fastify request logging', async () => {
    const output: string[] = [];
    const app = Fastify({ logger: { level: 'info', stream: { write: value => { output.push(value); } } } });
    apps.push(app);
    registerTelegramAuthRoutes(app, { config: null });
    await app.inject({ url: '/api/auth/telegram/callback?code=private-login-code&state=private-login-state', headers: { cookie: 'bscan_login=private-binding' } });
    expect(output.join('')).not.toMatch(/private-login-code|private-login-state|private-binding/);
  });
});
