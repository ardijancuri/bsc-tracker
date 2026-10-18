import { createHash } from 'node:crypto';
import Fastify from 'fastify';
import type { Pool } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTelegramBotLogin, ensureTelegramBotLoginSchema, type TelegramBotLoginStart } from './telegramBotLogin.js';
import { AuthMergeLimitError, telegramIssuer } from './telegramAuth.js';
import type { TelegramBotResult } from './telegramBot.js';

const origin = 'https://kollens.com';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });
type Row = Record<string, any>;

function fakeDatabase(now: () => number) {
  const attempts = new Map<string, Row>(), users = new Map<string, Row>(), sessions = new Map<string, string>(), updates = new Map<string, string>(), pacing = new Map<string, string>();
  const queries: { sql: string; args: unknown[] }[] = [];
  let lock = Promise.resolve(), activeTransactions = 0;
  const live = (row: Row | undefined, at: unknown) => row && !row.completed_at && new Date(row.expires_at).getTime() > new Date(String(at)).getTime();
  const query = vi.fn(async (sql: string, args: unknown[] = []) => {
    queries.push({ sql, args });
    const text = sql.replace(/\s+/g, ' ').trim();
    if (text.startsWith('DELETE FROM auth_bot_login_attempts')) {
      for (const [id, attempt] of attempts) if (new Date(attempt.expires_at).getTime() <= now()) attempts.delete(id);
    } else if (text.startsWith('INSERT INTO auth_bot_login_attempts')) {
      attempts.set(String(args[0]), { id: args[0], start_hash: args[1], browser_hash: args[2], return_to: args[3], guest_snapshot: JSON.parse(String(args[4])), expires_at: args[5],
        telegram_id: null, name: null, username: null, avatar_url: null, finish_hash: null, completed_at: null, delivery_status: 'waiting' });
    } else if (text.startsWith('SELECT * FROM auth_bot_login_attempts WHERE start_hash')) {
      const found = [...attempts.values()].find(row => row.start_hash === args[0]);
      return { rows: live(found, args[1]) ? [{ ...found }] : [] };
    } else if (text.startsWith('SELECT * FROM auth_bot_login_attempts WHERE finish_hash') || text.startsWith('SELECT a.*,COALESCE')) {
      const found = [...attempts.values()].find(row => row.finish_hash === args[0]);
      const user = found && [...users.values()].find(user => user.telegram_id === found.telegram_id);
      return { rows: live(found, args[1]) ? [{ ...found, avatar_url: user?.avatar_url ?? found?.avatar_url ?? null }] : [] };
    } else if (text.startsWith('INSERT INTO auth_bot_login_updates')) {
      if (updates.has(String(args[0]))) return { rows: [] };
      updates.set(String(args[0]), String(args[1])); return { rows: [{ update_id: args[0] }] };
    } else if (text.startsWith('SELECT attempt_id FROM auth_bot_login_updates')) {
      const attempt = updates.get(String(args[0])); return { rows: attempt ? [{ attempt_id: attempt }] : [] };
    } else if (text.startsWith('UPDATE auth_bot_login_attempts SET telegram_id')) {
      Object.assign(attempts.get(String(args[0]))!, { telegram_id: args[1], name: args[2], username: args[3], finish_hash: args[4], delivery_status: 'sending', delivery_error: null, delivery_update_id: args[5], delivery_lease_until: args[6], delivery_retry_at: null });
    } else if (text.startsWith('UPDATE auth_bot_login_attempts SET avatar_url')) {
      const row = attempts.get(String(args[0])); if (row && row.finish_hash === args[1]) row.avatar_url = args[2];
    } else if (text.startsWith('UPDATE auth_bot_login_attempts SET delivery_status')) {
      const row = attempts.get(String(args[0])); if (row && row.finish_hash === args[1] && !row.completed_at) Object.assign(row, { delivery_status: args[2], delivery_error: args[3], delivery_lease_until: null, delivery_retry_at: args[4] });
    } else if (text.startsWith('UPDATE auth_bot_login_attempts SET completed_at')) {
      Object.assign(attempts.get(String(args[0]))!, { completed_at: args[1], finish_hash: null });
    } else if (text.startsWith('INSERT INTO auth_bot_login_pacing')) {
      if (!pacing.has(String(args[0]))) pacing.set(String(args[0]), String(args[1]));
    } else if (text.startsWith('SELECT next_at FROM auth_bot_login_pacing')) {
      const next = pacing.get(String(args[0])); return { rows: next ? [{ next_at: next }] : [] };
    } else if (text.startsWith('UPDATE auth_bot_login_pacing')) {
      const previous = pacing.get(String(args[0]));
      pacing.set(String(args[0]), text.includes('GREATEST') && previous && previous > String(args[1]) ? previous : String(args[1]));
    } else if (text.startsWith('SELECT id FROM auth_users WHERE telegram_id')) {
      const user = [...users.values()].find(user => user.telegram_id === String(args[0])); return { rows: user ? [{ id: user.id }] : [] };
    } else if (text.startsWith('SELECT EXISTS(SELECT 1 FROM auth_users WHERE issuer=')) {
      const legacy = [...users.values()].some(user => user.issuer === args[0] && user.telegram_id == null);
      const mapped = [...users.values()].some(user => user.telegram_id === String(args[1])); return { rows: [{ required: legacy && !mapped }] };
    } else if (text.startsWith('SELECT u.id FROM auth_sessions')) {
      const id = sessions.get(String(args[0])); return { rows: id ? [{ id }] : [] };
    } else if (text.startsWith('INSERT INTO auth_users')) {
      users.set(String(args[0]), { id: args[0], issuer: args[1], subject: args[2], name: args[3], username: args[4], avatar_url: args[5], telegram_id: String(args[6]) });
    } else if (text.startsWith('UPDATE auth_users SET name')) {
      const user = users.get(String(args[0]))!; Object.assign(user, { name: args[1], username: args[2], avatar_url: args[3] ?? user.avatar_url });
    } else if (text.startsWith('INSERT INTO auth_sessions')) sessions.set(String(args[2]), String(args[1]));
    else if (text.startsWith('DELETE FROM auth_sessions')) sessions.delete(String(args[0]));
    return { rows: [] };
  });
  const connect = vi.fn(async () => {
    let releaseLock: (() => void) | null = null;
    let backup: { attempts: typeof attempts; users: typeof users; sessions: typeof sessions; updates: typeof updates; pacing: typeof pacing } | null = null;
    return {
      release: vi.fn(),
      query: async (sql: string, args: unknown[] = []) => {
        if (sql === 'BEGIN') {
          const before = lock; lock = new Promise(resolve => { releaseLock = resolve; }); await before;
          activeTransactions++;
          backup = structuredClone({ attempts, users, sessions, updates, pacing });
        }
        const result = await query(sql, args);
        if (sql === 'ROLLBACK' && backup) for (const [target, source] of [[attempts, backup.attempts], [users, backup.users], [sessions, backup.sessions], [updates, backup.updates], [pacing, backup.pacing]] as [Map<any, any>, Map<any, any>][]) {
          target.clear(); for (const [key, value] of source) target.set(key, value);
        }
        if (sql === 'COMMIT' || sql === 'ROLLBACK') { activeTransactions--; releaseLock?.(); releaseLock = null; }
        return result;
      },
    };
  });
  return { db: { query, connect } as unknown as Pool, query, queries, attempts, users, sessions, updates, activeTransactions: () => activeTransactions };
}

async function fixture(options: { mergeLimit?: boolean; disabled?: boolean; avatar?: string | null; sendResult?: TelegramBotResult; name?: string | null; webhookMatches?: boolean } = {}) {
  let clock = Date.parse('2026-10-18T18:00:00Z');
  const database = fakeDatabase(() => clock), app = Fastify({ logger: false }); apps.push(app);
  const send = vi.fn(async () => options.sendResult ?? { kind: 'sent', messageId: 1 } as TelegramBotResult);
  const identity = vi.fn(async () => options.name === null ? null : { username: options.name ?? 'kollens_login_bot' });
  const captureGuest = vi.fn(async () => ({ sessionId: 'source-guest', secretHash: 'captured-guest-proof' }));
  const mergeGuest = vi.fn(async () => { if (options.mergeLimit) throw new AuthMergeLimitError(); });
  const avatarUrl = vi.fn(async () => options.avatar ?? null);
  const webhookMatchesOrigin = vi.fn(async () => options.webhookMatches ?? true);
  const service = createTelegramBotLogin({ pool: database.db, config: options.disabled ? null : { origin, secure: true }, bot: { identity, send, ...(options.webhookMatches === undefined ? {} : { webhookMatchesOrigin }) }, now: () => clock, captureGuest, mergeGuest, avatarUrl });
  service.registerRoutes(app);
  app.post('/start', async (request, reply) => service.start(request, reply, (request.body as { returnTo?: string })?.returnTo ?? '/watchlist'));
  async function start(returnTo = '/watchlist?tab=kols#saved') {
    const response = await app.inject({ method: 'POST', url: '/start', payload: { returnTo } });
    const url = response.statusCode === 200 ? new URL(response.json().url) : null;
    const browser = response.cookies.find(value => value.name === 'bscan_bot_login')?.value;
    return { response, url, browser, startToken: url?.searchParams.get('start')! };
  }
  async function authorize(startToken: string, input: Partial<TelegramBotLoginStart> = {}) {
    await service.handleStart({ updateId: '1', telegramId: '12345678', startToken, name: 'Telegram Tester', username: 'tester', language: 'en', ...input });
    const call = send.mock.calls.at(-1) as unknown as [string, string, { text: string; url: string }[][]] | undefined;
    return call ? new URL(call[2][0][0].url).hash.slice('#token='.length) : null;
  }
  const post = (path: 'preview' | 'complete', secret: string | null, cookie = '', body: Record<string, unknown> = {}) => app.inject({
    method: 'POST', url: `/api/auth/telegram/bot/${path}`, headers: { origin, ...(cookie ? { cookie } : {}) }, payload: { token: secret, ...(path === 'complete' ? { confirmed: true } : {}), ...body },
  });
  return { ...database, app, service, send, identity, captureGuest, mergeGuest, avatarUrl, webhookMatchesOrigin, start, authorize, post, advance: (ms: number) => { clock += ms; } };
}

describe('bot-first Telegram login initiation and delivery', () => {
  it('creates a bounded deep link and HttpOnly browser binding, storing only hashed proofs', async () => {
    const f = await fixture(), started = await f.start();
    expect(started.url?.origin).toBe('https://t.me'); expect(started.url?.pathname).toBe('/kollens_login_bot');
    expect(started.startToken).toMatch(/^login_[A-Za-z0-9_-]{43}$/); expect(started.startToken.length).toBeLessThanOrEqual(64);
    expect(started.response.headers['set-cookie']).toContain('HttpOnly; SameSite=Lax; Max-Age=600; Secure');
    const secret = await f.authorize(started.startToken);
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/); expect(secret).not.toBe(started.startToken.slice(6));
    expect(JSON.stringify(f.queries)).not.toContain(secret); expect(JSON.stringify(f.queries)).not.toContain(started.startToken.slice(6));
    expect(f.sessions.size).toBe(0); expect(f.users.size).toBe(0);
  });
  it.each([{ disabled: true }, { name: null }, { name: 'bad_bot?start=evil' }])('fails closed when configuration/verified identity is unavailable (%j)', async options => {
    const f = await fixture(options); expect((await f.start()).response.statusCode).toBe(503); expect(f.attempts.size).toBe(0);
  });
  it('does not issue links or capture guest state when the bot webhook belongs to a different app origin', async () => {
    const f = await fixture({ webhookMatches: false }), result = await f.start();
    expect(result.response.statusCode).toBe(503); expect(result.response.json().code).toBe('bot_webhook_mismatch');
    expect(f.attempts.size).toBe(0); expect(f.captureGuest).not.toHaveBeenCalled(); expect(f.identity).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled();
  });
  it('keeps return destinations local', async () => {
    const f = await fixture(); await f.start('//attacker.example'); expect([...f.attempts.values()][0].return_to).toBe('/watchlist');
  });
  it('never holds a database transaction during Telegram or avatar requests', async () => {
    const f = await fixture(); f.send.mockImplementation(async () => { expect(f.activeTransactions()).toBe(0); return { kind: 'sent', messageId: 2 }; });
    f.avatarUrl.mockImplementation(async () => { expect(f.activeTransactions()).toBe(0); return null; });
    await f.authorize((await f.start()).startToken); expect(f.send).toHaveBeenCalledOnce();
  });
  it('deduplicates webhook updates and binds an attempt to one immutable numeric identity', async () => {
    const f = await fixture(), started = await f.start(); await f.authorize(started.startToken); await f.authorize(started.startToken);
    await f.authorize(started.startToken, { updateId: '2', telegramId: '999' });
    expect(f.send).toHaveBeenCalledOnce(); expect([...f.attempts.values()][0].telegram_id).toBe('12345678');
  });
  it('accepts a new explicit start from the same identity and invalidates the old finish link', async () => {
    const f = await fixture(), started = await f.start(), first = await f.authorize(started.startToken);
    f.advance(1001); const second = await f.authorize(started.startToken, { updateId: '2' });
    expect(f.send).toHaveBeenCalledTimes(2); expect(first).not.toBe(second);
    expect((await f.post('preview', first)).statusCode).toBe(410); expect((await f.post('preview', second)).statusCode).toBe(200);
  });
  it('does not replace a proof while its delivery is still in progress', async () => {
    const f = await fixture(), started = await f.start();
    let release!: (result: TelegramBotResult) => void;
    f.send.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const sending = f.service.handleStart({ updateId: '1', telegramId: '12345678', startToken: started.startToken, name: 'Tester', username: null });
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledOnce());
    const proof = [...f.attempts.values()][0].finish_hash;
    f.advance(2000); await f.service.handleStart({ updateId: '2', telegramId: '12345678', startToken: started.startToken, name: 'Tester', username: null });
    expect(f.send).toHaveBeenCalledOnce(); expect([...f.attempts.values()][0].finish_hash).toBe(proof);
    release({ kind: 'sent', messageId: 3 }); await sending;
  });
  it('honors provider cooldown across new explicit starts and separate attempts for the same chat', async () => {
    const f = await fixture({ sendResult: { kind: 'retry', reason: 'rate_limited', retryAfterMs: 60_000 } }), first = await f.start();
    await f.authorize(first.startToken); f.advance(2000);
    await f.authorize(first.startToken, { updateId: '2' });
    const next = await f.start(); await f.authorize(next.startToken, { updateId: '3' });
    expect(f.send).toHaveBeenCalledOnce();
    f.advance(60_001); await f.authorize(next.startToken, { updateId: '4' }); expect(f.send).toHaveBeenCalledTimes(2);
  });
  it('enforces conservative chat pacing when a user immediately starts a second login', async () => {
    const f = await fixture(), first = await f.start(); await f.authorize(first.startToken);
    const next = await f.start(); await f.authorize(next.startToken, { updateId: '2' }); expect(f.send).toHaveBeenCalledOnce();
    f.advance(1001); await f.authorize(next.startToken, { updateId: '3' }); expect(f.send).toHaveBeenCalledTimes(2);
  });
  it.each([
    [{ kind: 'retry', retryAfterMs: 1000, reason: 'rate_limited' }, 'retry', 'rate_limited'],
    [{ kind: 'uncertain', reason: 'network' }, 'uncertain', 'delivery_unconfirmed'],
    [{ kind: 'blocked' }, 'failed', 'bot_blocked'],
    [{ kind: 'failed', reason: 'private-provider-value' }, 'failed', 'delivery_failed'],
  ] as const)('categorizes %s without blindly resending duplicate updates', async (result, status, reason) => {
    const f = await fixture({ sendResult: result }), started = await f.start(); await f.authorize(started.startToken); await f.authorize(started.startToken);
    expect([...f.attempts.values()][0]).toMatchObject({ delivery_status: status, delivery_error: reason }); expect(f.send).toHaveBeenCalledOnce();
  });
  it('renews expired starts without inheriting old guest authority, and rejects unsafe IDs and unrelated commands', async () => {
    const f = await fixture(), started = await f.start();
    expect(await f.service.handleStart({ updateId: '1', telegramId: '1', startToken: 'hello', name: 'Test', username: null })).toBe(false);
    await f.authorize(started.startToken, { telegramId: 'opaque-subject' }); expect(f.send).not.toHaveBeenCalled();
    f.advance(601_000); const fresh = await f.authorize(started.startToken);
    expect(f.send).toHaveBeenCalledOnce(); expect((f.send.mock.calls[0] as unknown as [string, string])[1]).toContain('previous login request is no longer active');
    expect((await f.post('preview', fresh, `bscan_bot_login=${started.browser}`)).json().sameBrowser).toBe(false);
    expect((await f.post('complete', fresh, `bscan_bot_login=${started.browser}`)).json().returnTo).toBe('/watchlist?telegramLogin=success');
    expect(f.mergeGuest).not.toHaveBeenCalled();
  });
  it('makes a plain private start login-first for an unregistered user without automatically signing in', async () => {
    const f = await fixture(), secret = await f.authorize('');
    expect(f.captureGuest).not.toHaveBeenCalled(); expect(f.sessions.size).toBe(0); expect(f.users.size).toBe(0);
    expect((f.send.mock.calls[0] as unknown as [string, string])[1]).toContain('Sign in to Kollens');
    expect((f.send.mock.calls[0] as unknown as [string, string])[1]).not.toContain('Manage alerts');
    expect((await f.post('preview', secret)).json()).toMatchObject({ user: { name: 'Telegram Tester' }, sameBrowser: false });
    const attempt = [...f.attempts.values()][0]; expect(attempt.guest_snapshot).toBeNull(); expect(attempt.return_to).toBe('/watchlist');
    expect((await f.post('complete', secret)).statusCode).toBe(200); expect(f.users.size).toBe(1); expect(f.mergeGuest).not.toHaveBeenCalled();
  });
  it('makes plain start login-first for a mapped user and deduplicates its webhook update across standalone attempts', async () => {
    const f = await fixture(); f.users.set('known', { id: 'known', issuer: telegramIssuer, subject: 'opaque', telegram_id: '12345678' });
    const secret = await f.authorize(''); await f.authorize('');
    expect(f.send).toHaveBeenCalledOnce(); expect(f.attempts.size).toBe(1); expect(f.updates.size).toBe(1);
    expect((await f.post('complete', secret)).statusCode).toBe(200); expect([...f.sessions.values()]).toEqual(['known']); expect(f.users.size).toBe(1);
  });
  it('sends fresh login guidance for unknown payloads using only the configured app origin', async () => {
    const f = await fixture(), secret = await f.authorize(`login_${'a'.repeat(43)}`);
    const message = f.send.mock.calls[0] as unknown as [string, string, { text: string; url: string }[][]];
    expect(message[1]).toContain('fresh link'); expect(message[2][0][0].url).toMatch(/^https:\/\/kollens\.com\/auth\/telegram\/finish#token=/);
    expect((await f.post('preview', secret)).json().sameBrowser).toBe(false); expect([...f.attempts.values()][0].guest_snapshot).toBeNull();
  });
});

describe('explicit one-time completion', () => {
  it('previews without consuming or creating sessions and requires explicit confirmation', async () => {
    const f = await fixture(), started = await f.start(), secret = await f.authorize(started.startToken);
    for (let i = 0; i < 2; i++) expect((await f.post('preview', secret, `bscan_bot_login=${started.browser}`)).json()).toMatchObject({ user: { name: 'Telegram Tester', username: 'tester' }, sameBrowser: true });
    expect((await f.post('complete', secret, '', { confirmed: false })).statusCode).toBe(400);
    for (const method of ['GET', 'HEAD'] as const) expect((await f.app.inject({ method, url: `/api/auth/telegram/bot/complete?token=${secret}` })).statusCode).toBe(404);
    expect(f.sessions.size).toBe(0); expect((await f.post('preview', secret)).statusCode).toBe(200);
  });
  it('creates one account/session, merges only the original browser guest and consumes atomically', async () => {
    const f = await fixture(), started = await f.start(), secret = await f.authorize(started.startToken), binding = `bscan_bot_login=${started.browser}`;
    const result = await f.post('complete', secret, binding);
    expect(result.statusCode).toBe(200); expect(result.json().returnTo).toBe('/watchlist?tab=kols&telegramLogin=success#saved');
    expect(result.cookies.find(cookie => cookie.name === 'bscan_auth')?.value).toMatch(/^[a-f0-9]{64}$/);
    expect(result.headers['set-cookie']).toEqual(expect.arrayContaining([expect.stringContaining('bscan_watch=;')]));
    expect(f.mergeGuest).toHaveBeenCalledWith(expect.anything(), [...f.users.keys()][0], { sessionId: 'source-guest', secretHash: 'captured-guest-proof' }, true);
    expect([...f.users.values()][0]).toMatchObject({ issuer: telegramIssuer, subject: 'bot:12345678', telegram_id: '12345678' });
    expect((await f.post('complete', secret, binding)).statusCode).toBe(410); expect(f.sessions.size).toBe(1);
  });
  it('isolates source guest favorites in a different Telegram browser and leaves its guest cookie intact', async () => {
    const f = await fixture(), secret = await f.authorize((await f.start()).startToken);
    expect((await f.post('preview', secret)).json().sameBrowser).toBe(false);
    const response = await f.post('complete', secret, `bscan_watch=${'a'.repeat(64)}`);
    expect(response.statusCode).toBe(200); expect(f.mergeGuest).not.toHaveBeenCalled();
    expect(response.cookies.some(cookie => cookie.name === 'bscan_watch')).toBe(false);
  });
  it('does not consider duplicate browser cookies a verified source-browser binding', async () => {
    const f = await fixture(), start = await f.start(), secret = await f.authorize(start.startToken);
    const duplicate = `bscan_bot_login=${start.browser}; bscan_bot_login=${start.browser}`;
    expect((await f.post('preview', secret, duplicate)).json().sameBrowser).toBe(false);
    await f.post('complete', secret, duplicate); expect(f.mergeGuest).not.toHaveBeenCalled();
  });
  it('reuses an existing OIDC identity and preserves its opaque subject and avatar', async () => {
    const f = await fixture(); f.users.set('old-user', { id: 'old-user', telegram_id: '12345678', issuer: telegramIssuer, subject: 'opaque-signed-subject', name: 'Before', avatar_url: 'https://cdn4.telesco.pe/photo.jpg' });
    const secret = await f.authorize((await f.start()).startToken);
    expect((await f.post('preview', secret)).json().user.avatarUrl).toBe('https://cdn4.telesco.pe/photo.jpg');
    expect((await f.post('complete', secret)).statusCode).toBe(200); expect(f.users.size).toBe(1);
    expect(f.users.get('old-user')).toMatchObject({ subject: 'opaque-signed-subject', avatar_url: 'https://cdn4.telesco.pe/photo.jpg', name: 'Telegram Tester' });
  });
  it('requires recovery instead of matching by username or creating a duplicate while an old OIDC account lacks its numeric identity', async () => {
    const f = await fixture(); f.users.set('unlinked', { id: 'unlinked', issuer: telegramIssuer, telegram_id: null, subject: '12345678', username: 'tester' });
    const secret = await f.authorize((await f.start()).startToken);
    expect((await f.post('preview', secret)).json().requiresRecovery).toBe(true);
    expect((await f.post('complete', secret)).statusCode).toBe(428);
    expect(f.users.size).toBe(1); expect(f.sessions.size).toBe(0); expect(f.users.get('unlinked')?.telegram_id).toBeNull();
    expect((await f.post('preview', secret)).statusCode).toBe(200);
  });
  it('does not block a mapped Telegram identity because another legacy account is still unmapped', async () => {
    const f = await fixture(); f.users.set('unlinked', { id: 'unlinked', issuer: telegramIssuer, telegram_id: null });
    f.users.set('mapped', { id: 'mapped', issuer: telegramIssuer, telegram_id: '12345678' });
    const secret = await f.authorize((await f.start()).startToken);
    expect((await f.post('preview', secret)).json().requiresRecovery).toBe(false);
    expect((await f.post('complete', secret)).statusCode).toBe(200); expect(f.users.size).toBe(2);
  });
  it('exposes only a valid fresh bot identity to the bounded OIDC recovery handoff without consuming its proof', async () => {
    const f = await fixture(), secret = await f.authorize((await f.start('/kol/0xabc')).startToken);
    expect(await f.service.recoveryIdentity(secret!)).toEqual({ telegramId: '12345678', returnTo: '/kol/0xabc' });
    expect(f.sessions.size).toBe(0); expect(f.users.size).toBe(0); expect((await f.post('preview', secret)).statusCode).toBe(200);
    expect(await f.service.recoveryIdentity('bad')).toBeNull();
    f.advance(601_000); expect(await f.service.recoveryIdentity(secret!)).toBeNull();
  });
  it('does not expose a consumed proof as an OIDC recovery identity', async () => {
    const f = await fixture(), secret = await f.authorize((await f.start()).startToken);
    await f.post('complete', secret); expect(await f.service.recoveryIdentity(secret!)).toBeNull();
  });
  it('rejects a currently signed-in different account without consuming the link or modifying accounts', async () => {
    const f = await fixture(); f.users.set('other', { id: 'other', telegram_id: '999' }); f.sessions.set(hash('a'.repeat(64)), 'other');
    const secret = await f.authorize((await f.start()).startToken);
    expect((await f.post('complete', secret, `bscan_auth=${'a'.repeat(64)}`)).statusCode).toBe(409);
    expect(f.users.size).toBe(1); expect(f.sessions.size).toBe(1); expect((await f.post('preview', secret)).statusCode).toBe(200);
  });
  it('replaces the current session when it belongs to the verified same account', async () => {
    const f = await fixture(); f.users.set('same', { id: 'same', telegram_id: '12345678' }); f.sessions.set(hash('a'.repeat(64)), 'same');
    const secret = await f.authorize((await f.start()).startToken);
    expect((await f.post('complete', secret, `bscan_auth=${'a'.repeat(64)}`)).statusCode).toBe(200);
    expect(f.sessions.has(hash('a'.repeat(64)))).toBe(false); expect([...f.sessions.values()]).toEqual(['same']);
  });
  it('only one concurrent completion redeems the same link', async () => {
    const f = await fixture(), secret = await f.authorize((await f.start()).startToken);
    const results = await Promise.all([f.post('complete', secret), f.post('complete', secret)]);
    expect(results.map(result => result.statusCode).sort()).toEqual([200, 410]); expect(f.users.size).toBe(1); expect(f.sessions.size).toBe(1);
  });
  it('serializes different login attempts for the same new Telegram identity', async () => {
    const f = await fixture(), first = await f.authorize((await f.start()).startToken); f.advance(1001);
    const second = await f.authorize((await f.start()).startToken, { updateId: '2' });
    expect((await Promise.all([f.post('complete', first), f.post('complete', second)])).every(result => result.statusCode === 200)).toBe(true);
    expect(f.users.size).toBe(1); expect(f.sessions.size).toBe(2);
  });
  it('rolls back account/session changes and retains the proof if the guest merge cannot complete', async () => {
    const f = await fixture({ mergeLimit: true }), start = await f.start(), secret = await f.authorize(start.startToken);
    expect((await f.post('complete', secret, `bscan_bot_login=${start.browser}`)).statusCode).toBe(422);
    expect(f.users.size).toBe(0); expect(f.sessions.size).toBe(0); expect((await f.post('preview', secret)).statusCode).toBe(200);
  });
  it('rejects expired completion proofs', async () => {
    const f = await fixture(), secret = await f.authorize((await f.start()).startToken); f.advance(601_000);
    expect((await f.post('complete', secret)).statusCode).toBe(410); expect(f.users.size).toBe(0);
  });
  it('enforces same-origin JSON mutations, bounded bodies, no-store and no-referrer', async () => {
    const f = await fixture(), secret = await f.authorize((await f.start()).startToken);
    const rejected = await f.app.inject({ method: 'POST', url: '/api/auth/telegram/bot/complete', headers: { origin: 'https://attacker.example' }, payload: { token: secret, confirmed: true } });
    expect(rejected.statusCode).toBe(403); expect(rejected.headers['cache-control']).toBe('no-store'); expect(rejected.headers['referrer-policy']).toBe('no-referrer');
    expect((await f.post('preview', secret, '', { unexpected: true })).statusCode).toBe(400);
    const large = await f.post('preview', 'x'.repeat(5000)); expect(large.statusCode).toBe(413); expect(large.headers['cache-control']).toBe('no-store'); expect(large.headers['referrer-policy']).toBe('no-referrer'); expect(f.sessions.size).toBe(0);
  });
  it.each(['https://api.telegram.org/file/botSECRET/photo.jpg', 'https://attacker.example/photo.jpg'])('rejects unsafe photo URLs (%s)', async avatar => {
    const f = await fixture({ avatar }), secret = await f.authorize((await f.start()).startToken);
    expect((await f.post('preview', secret)).json().user.avatarUrl).toBeNull();
  });
  it('accepts the server-owned profile photo proxy and sanitizes optional profile fields', async () => {
    const f = await fixture({ avatar: '/api/auth/telegram/avatar/12345678' }), secret = await f.authorize((await f.start()).startToken, { name: '\nTester\u0000', username: '@invalid', language: 'zh-CN' });
    expect((await f.post('preview', secret)).json().user).toMatchObject({ name: 'Tester', username: null, avatarUrl: '/api/auth/telegram/avatar/12345678' });
    expect((f.send.mock.calls[0] as unknown as [string, string])[1]).toContain('登录 Kollens');
  });
  it('bounds repeated preview requests without consuming a valid proof', async () => {
    const f = await fixture(), secret = await f.authorize((await f.start()).startToken);
    for (let i = 0; i < 60; i++) expect((await f.post('preview', secret)).statusCode).toBe(200);
    expect((await f.post('preview', secret)).statusCode).toBe(429); expect(f.sessions.size).toBe(0);
  });
});

describe('automatic completion remains bound to the initiating browser', () => {
  it('completes a source-browser request automatically and preserves its normal guest merge and one-use session behavior', async () => {
    const f = await fixture(), start = await f.start(), secret = await f.authorize(start.startToken);
    const response = await f.post('complete', secret, `bscan_bot_login=${start.browser}`, { automatic: true });
    expect(response.statusCode).toBe(200); expect(f.sessions.size).toBe(1); expect(f.mergeGuest).toHaveBeenCalledOnce();
    expect(response.cookies.find(cookie => cookie.name === 'bscan_auth')?.value).toMatch(/^[a-f0-9]{64}$/);
    expect((await f.post('complete', secret, `bscan_bot_login=${start.browser}`, { automatic: true })).statusCode).toBe(410);
  });
  it.each(['missing', 'wrong', 'duplicate'] as const)('rejects automatic completion for a %s browser cookie before account/session mutation, without consuming the link', async kind => {
    const f = await fixture(); f.users.set('existing', { id: 'existing', issuer: telegramIssuer, telegram_id: '12345678', subject: 'original-opaque', name: 'Before login' });
    const start = await f.start(), secret = await f.authorize(start.startToken);
    expect((await f.post('preview', secret, `bscan_bot_login=${start.browser}`)).json().sameBrowser).toBe(true);
    const jar = kind === 'missing' ? '' : kind === 'wrong' ? `bscan_bot_login=${'a'.repeat(64)}` : `bscan_bot_login=${start.browser}; bscan_bot_login=${start.browser}`;
    const before = f.queries.length;
    const response = await f.post('complete', secret, jar, { automatic: true });
    expect(response.statusCode).toBe(403); expect(response.cookies).toHaveLength(0);
    expect(f.sessions.size).toBe(0); expect(f.users.size).toBe(1); expect(f.users.get('existing')?.name).toBe('Before login'); expect(f.mergeGuest).not.toHaveBeenCalled();
    expect(f.queries.slice(before).some(({ sql }) => /^(?:UPDATE auth_users|INSERT INTO auth_users|INSERT INTO auth_sessions)/.test(sql))).toBe(false);
    expect((await f.post('preview', secret)).statusCode).toBe(200);
    expect((await f.post('complete', secret, jar)).statusCode).toBe(200); expect(f.mergeGuest).not.toHaveBeenCalled();
  });
  it('never automatically completes a standalone bot-origin link, while retaining manual confirmation', async () => {
    const f = await fixture(), secret = await f.authorize('');
    expect((await f.post('complete', secret, '', { automatic: true })).statusCode).toBe(403); expect(f.users.size).toBe(0); expect(f.sessions.size).toBe(0);
    expect((await f.post('preview', secret)).statusCode).toBe(200); expect((await f.post('complete', secret)).statusCode).toBe(200);
  });
  it('retains the different-account conflict guard for otherwise valid automatic browser proof', async () => {
    const f = await fixture(); f.users.set('other', { id: 'other', telegram_id: '999' }); f.sessions.set(hash('a'.repeat(64)), 'other');
    const start = await f.start(), secret = await f.authorize(start.startToken);
    const response = await f.post('complete', secret, `bscan_bot_login=${start.browser}; bscan_auth=${'a'.repeat(64)}`, { automatic: true });
    expect(response.statusCode).toBe(409); expect(f.users.size).toBe(1); expect(f.sessions.size).toBe(1);
    expect(f.sessions.get(hash('a'.repeat(64)))).toBe('other'); expect((await f.post('preview', secret)).statusCode).toBe(200);
  });
  it('retains the legacy-account recovery guard for otherwise valid automatic browser proof', async () => {
    const f = await fixture(); f.users.set('legacy', { id: 'legacy', issuer: telegramIssuer, telegram_id: null, subject: 'legacy-subject' });
    const start = await f.start(), secret = await f.authorize(start.startToken);
    expect((await f.post('complete', secret, `bscan_bot_login=${start.browser}`, { automatic: true })).statusCode).toBe(428);
    expect(f.users.size).toBe(1); expect(f.sessions.size).toBe(0); expect(f.mergeGuest).not.toHaveBeenCalled();
    expect((await f.post('preview', secret)).json().requiresRecovery).toBe(true);
  });
  it.each(['true', 1, null])('rejects non-boolean automatic metadata (%j) without consuming the proof', async automatic => {
    const f = await fixture(), start = await f.start(), secret = await f.authorize(start.startToken);
    expect((await f.post('complete', secret, `bscan_bot_login=${start.browser}`, { automatic })).statusCode).toBe(400);
    expect(f.sessions.size).toBe(0); expect((await f.post('preview', secret)).statusCode).toBe(200);
  });
  it('does not allow the automatic flag to replace the confirmed=true request contract', async () => {
    const f = await fixture(), start = await f.start(), secret = await f.authorize(start.startToken);
    expect((await f.post('complete', secret, `bscan_bot_login=${start.browser}`, { automatic: true, confirmed: false })).statusCode).toBe(400);
    expect(f.sessions.size).toBe(0); expect((await f.post('preview', secret)).statusCode).toBe(200);
  });
  it('allows exactly one concurrent automatic completion under the server row lock', async () => {
    const f = await fixture(), start = await f.start(), secret = await f.authorize(start.startToken), binding = `bscan_bot_login=${start.browser}`;
    const results = await Promise.all([f.post('complete', secret, binding, { automatic: true }), f.post('complete', secret, binding, { automatic: true })]);
    expect(results.map(result => result.statusCode).sort()).toEqual([200, 410]); expect(f.sessions.size).toBe(1); expect(f.users.size).toBe(1); expect(f.mergeGuest).toHaveBeenCalledOnce();
  });
});

it('creates independent login tables without modifying notification deduplication or existing sessions', async () => {
  const f = fakeDatabase(Date.now); await ensureTelegramBotLoginSchema(f.db);
  const schema = f.queries.map(query => query.sql).join('\n');
  expect(schema).toContain('auth_bot_login_updates'); expect(schema).not.toContain('telegram_notification_updates'); expect(schema).not.toMatch(/DROP|TRUNCATE/i);
});
