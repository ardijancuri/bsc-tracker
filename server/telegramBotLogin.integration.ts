// Requires a fresh, disposable LOCAL bscan_auth_bot_test database. This suite never resets a schema or application data.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { ensureSchema, pool } from './db.js';
import { captureGuestWatchlist, mergeGuestWatchlist } from './accountWatchlist.js';
import { createTelegramBotLogin, ensureTelegramBotLoginSchema } from './telegramBotLogin.js';
import { registerTelegramAuthRoutes, telegramIssuer, type TelegramAuthConfig } from './telegramAuth.js';
import { registerTelegramNotificationRoutes } from './telegramNotificationsApi.js';
import type { TelegramBotResult, TelegramMessageButton } from './telegramBot.js';
import type { TelegramNotificationState } from '../shared/telegramNotifications.js';

let connection: URL;
try { connection = new URL(process.env.DATABASE_URL || ''); } catch { throw new Error('Use a fresh local bscan_auth_bot_test database'); }
if (!/^\/bscan_auth_bot_test(?:_\d+)?$/.test(connection.pathname)
  || !['localhost', '127.0.0.1', '[::1]', '::1'].includes(connection.hostname)
  || !['postgres:', 'postgresql:'].includes(connection.protocol)) throw new Error('Use a fresh local bscan_auth_bot_test database');

process.env.NODE_ENV = 'production';
process.env.PUBLIC_APP_URL = 'https://kollens.com';
const origin = 'https://kollens.com', webhookSecret = 'local-test-authenticated-webhook-secret';
const config: TelegramAuthConfig = { clientId: '12345', clientSecret: 'local-test-only-not-a-real-secret', origin, secure: true };
const app = Fastify({ logger: false });
let clock = Date.now(), updateId = 1000;
const sent: { chatId: string; text: string; buttons?: TelegramMessageButton[][] }[] = [];
const notificationUpdates: unknown[] = [];
const bot = {
  identity: async () => ({ username: 'kollens_login_bot' }),
  send: async (chatId: string, text: string, buttons?: TelegramMessageButton[][]): Promise<TelegramBotResult> => {
    sent.push({ chatId, text, buttons }); return { kind: 'sent', messageId: sent.length };
  },
};
const service = createTelegramBotLogin({ pool, config, bot, captureGuest: captureGuestWatchlist, mergeGuest: mergeGuestWatchlist, now: () => clock });
service.registerRoutes(app);
registerTelegramAuthRoutes(app, { pool, config, botLogin: service, captureGuest: captureGuestWatchlist, mergeGuest: mergeGuestWatchlist,
  oidcConfiguration: async () => { throw new Error('Unexpected OIDC network work in a bot-login integration test'); } });
const state = async (): Promise<TelegramNotificationState> => ({ available: true, enabled: false, connection: 'not_connected', buys: true, sells: true, language: 'en', mutedKols: [], lastError: null });
registerTelegramNotificationRoutes(app, { pool, config, webhookSecret, available: () => true, state, update: state, mute: state,
  webhook: async update => { notificationUpdates.push(update); }, botLoginStart: service.handleStart });

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const cookie = (response: { headers: Record<string, unknown> }, name: string) => [response.headers['set-cookie']].flat().map(String).find(value => value.startsWith(`${name}=`))?.split(';')[0] ?? '';
const post = (path: string, payload: Record<string, unknown>, jar = '') => app.inject({ method: 'POST', url: path, headers: { origin, ...(jar ? { cookie: jar } : {}) }, payload });
const preview = (secret: string, jar = '') => post('/api/auth/telegram/bot/preview', { token: secret }, jar);
const complete = (secret: string, jar = '', automatic = false) => post('/api/auth/telegram/bot/complete', { token: secret, confirmed: true, ...(automatic ? { automatic: true } : {}) }, jar);
async function count(table: 'auth_sessions' | 'auth_users' | 'auth_bot_login_updates' | 'telegram_notification_updates') {
  return Number((await pool.query(`SELECT COUNT(*)::int AS count FROM ${table}`)).rows[0].count);
}
async function guest(address: string) {
  const id = randomUUID(), secret = randomBytes(32).toString('hex');
  await pool.query(`INSERT INTO watch_sessions(id,secret_hash,expires_at) VALUES($1,$2,now()+interval '1 day')`, [id, hash(secret)]);
  await pool.query(`INSERT INTO watch_entries(session_id,kind,address) VALUES($1,'token',$2)`, [id, address]);
  return { id, jar: `bscan_watch=${secret}` };
}
async function start(jar = '', returnTo = '/watchlist?tab=kols') {
  const response = await post('/api/auth/telegram/start', { returnTo }, jar);
  assert.equal(response.statusCode, 200, response.body);
  const url = new URL(response.json().url);
  assert.equal(url.origin, 'https://t.me'); assert.equal(url.pathname, '/kollens_login_bot');
  const payload = url.searchParams.get('start')!; assert.match(payload, /^login_[A-Za-z0-9_-]{43}$/);
  return { payload, browserJar: cookie(response, 'bscan_bot_login') };
}
async function authorize(payload: string, telegramId = 12345678, customUpdateId = ++updateId) {
  clock += 1001;
  const before = sent.length;
  const body = { update_id: customUpdateId, message: { message_id: customUpdateId, date: Math.floor(clock / 1000),
    chat: { id: telegramId, type: 'private' }, from: { id: telegramId, is_bot: false, first_name: 'Real PG', last_name: 'Tester', username: 'pg_test', language_code: 'en' }, text: payload ? `/start ${payload}` : '/start' } };
  const response = await app.inject({ method: 'POST', url: '/api/telegram/webhook', headers: { 'x-telegram-bot-api-secret-token': webhookSecret }, payload: body });
  assert.equal(response.statusCode, 200, response.body);
  return { body, updateId: customUpdateId, secret: sent.length > before ? new URL(sent.at(-1)!.buttons![0][0].url).hash.slice('#token='.length) : null };
}
const passes: string[] = [];
const pass = (value: string) => { passes.push(value); console.log(`PASS ${value}`); };
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('External HTTP is forbidden during local bot-login integration'); };

try {
  const existingTables = Number((await pool.query(`SELECT COUNT(*)::int AS count FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'`)).rows[0].count);
  assert.equal(existingTables, 0, 'Use a newly created empty disposable database; this suite never resets data');
  await ensureSchema();
  const existingId = randomUUID(), oldFavorite = `0x${'a'.repeat(40)}`, guestFavorite = `0x${'b'.repeat(40)}`, crossFavorite = `0x${'c'.repeat(40)}`;
  await pool.query(`INSERT INTO auth_users(id,issuer,subject,name,username,avatar_url,telegram_id)
    VALUES($1,$2,'opaque-existing-subject','Existing user','pg_test','https://cdn4.telesco.pe/existing.jpg',12345678)`, [existingId, telegramIssuer]);
  await pool.query(`INSERT INTO account_watch_entries(user_id,kind,address) VALUES($1,'token',$2)`, [existingId, oldFavorite]);

  const sourceGuest = await guest(guestFavorite), initiated = await start(sourceGuest.jar);
  const authorized = await authorize(initiated.payload); assert.ok(authorized.secret);
  assert.equal(await count('auth_sessions'), 0, 'Starting the bot must not sign in a browser');
  assert.equal(notificationUpdates.length, 0, 'Login starts must not become alert status commands');
  assert.equal(await count('telegram_notification_updates'), 0, 'Login deduplication must not consume notification update IDs');
  assert.equal(sent.at(-1)!.chatId, '12345678'); assert.match(sent.at(-1)!.buttons![0][0].url, /^https:\/\/kollens\.com\/auth\/telegram\/finish#token=/);
  const firstPreview = await preview(authorized.secret, initiated.browserJar);
  assert.equal(firstPreview.statusCode, 200, firstPreview.body); assert.equal(firstPreview.json().user.name, 'Real PG Tester'); assert.equal(firstPreview.json().sameBrowser, true);
  assert.equal(firstPreview.json().user.avatarUrl, 'https://cdn4.telesco.pe/existing.jpg');
  const signed = await complete(authorized.secret, `${initiated.browserJar}; ${sourceGuest.jar}`, true);
  assert.equal(signed.statusCode, 200, signed.body); assert.match(signed.json().returnTo, /telegramLogin=success/);
  const authenticatedJar = cookie(signed, 'bscan_auth'); assert.ok(authenticatedJar);
  const account = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: authenticatedJar } });
  assert.equal(account.json().user.id, existingId); assert.equal(account.json().user.name, 'Real PG Tester');
  assert.equal((await pool.query('SELECT subject FROM auth_users WHERE id=$1', [existingId])).rows[0].subject, 'opaque-existing-subject');
  assert.deepEqual((await pool.query('SELECT address FROM account_watch_entries WHERE user_id=$1 ORDER BY address', [existingId])).rows.map(row => row.address), [oldFavorite, guestFavorite]);
  assert.equal((await pool.query('SELECT 1 FROM watch_sessions WHERE id=$1', [sourceGuest.id])).rowCount, 0, 'Verified source guest is consumed only on completion');
  assert.equal(await count('auth_users'), 1); assert.equal((await complete(authorized.secret)).statusCode, 410);
  pass('source-browser automatic POST reuses numeric OIDC account, preserves opaque identity and favorites, and merges only verified source guest');

  const duplicateBefore = sent.length;
  await app.inject({ method: 'POST', url: '/api/telegram/webhook', headers: { 'x-telegram-bot-api-secret-token': webhookSecret }, payload: authorized.body });
  assert.equal(sent.length, duplicateBefore); assert.equal(await count('auth_bot_login_updates'), 1);
  const sessionBefore = await count('auth_sessions');
  for (const method of ['GET', 'HEAD'] as const) {
    const response = await app.inject({ method, url: '/api/auth/telegram/bot/complete?token=link-preview' }); assert.equal(response.statusCode, 404);
  }
  assert.equal(await count('auth_sessions'), sessionBefore);
  pass('duplicate webhook updates do not resend, GET/HEAD create no sessions, consumed links cannot be replayed');

  const otherGuest = await guest(crossFavorite), otherStart = await start(otherGuest.jar), otherAuthorized = await authorize(otherStart.payload);
  assert.ok(otherAuthorized.secret); const crossPreview = await preview(otherAuthorized.secret);
  assert.equal(crossPreview.json().sameBrowser, false);
  assert.equal((await preview(otherAuthorized.secret, otherStart.browserJar)).json().sameBrowser, true, 'A prior valid preview does not replace the completion-time browser check');
  const sessionsBeforeBadAutomatic = await count('auth_sessions');
  for (const jar of ['', `bscan_bot_login=${'a'.repeat(64)}`, `${otherStart.browserJar}; ${otherStart.browserJar}`]) {
    const rejected = await complete(otherAuthorized.secret, jar, true); assert.equal(rejected.statusCode, 403, rejected.body);
    assert.equal(cookie(rejected, 'bscan_auth'), ''); assert.equal(await count('auth_sessions'), sessionsBeforeBadAutomatic);
    assert.equal((await preview(otherAuthorized.secret)).statusCode, 200, 'A rejected automatic request must not consume the proof');
  }
  assert.equal((await pool.query('SELECT 1 FROM watch_sessions WHERE id=$1', [otherGuest.id])).rowCount, 1);
  pass('missing, wrong and duplicate source cookies reject automatic completion before mutation and leave the proof usable');
  const crossComplete = await complete(otherAuthorized.secret); assert.equal(crossComplete.statusCode, 200, crossComplete.body);
  assert.equal((await pool.query('SELECT 1 FROM watch_sessions WHERE id=$1', [otherGuest.id])).rowCount, 1);
  assert.equal((await pool.query('SELECT 1 FROM account_watch_entries WHERE user_id=$1 AND address=$2', [existingId, crossFavorite])).rowCount, 0);
  assert.ok(!cookie(crossComplete, 'bscan_watch'), 'Cross-browser completion must not erase unmerged guest state');
  pass('Telegram browser completion isolates source-browser guest favorites');

  const concurrentStart = await start(), concurrent = await authorize(concurrentStart.payload); assert.ok(concurrent.secret);
  const beforeConcurrent = await count('auth_sessions');
  const concurrentResults = await Promise.all([complete(concurrent.secret, concurrentStart.browserJar, true), complete(concurrent.secret, concurrentStart.browserJar, true)]);
  assert.deepEqual(concurrentResults.map(result => result.statusCode).sort(), [200, 410]);
  assert.equal(await count('auth_sessions'), beforeConcurrent + 1); assert.equal(await count('auth_users'), 1);
  pass('real PostgreSQL row locks allow exactly one concurrent automatic completion');

  const expired = await authorize((await start()).payload); assert.ok(expired.secret);
  await pool.query("UPDATE auth_bot_login_attempts SET expires_at=now()-interval '1 second' WHERE finish_hash=$1", [hash(expired.secret)]);
  assert.equal((await preview(expired.secret)).statusCode, 410); assert.equal((await complete(expired.secret)).statusCode, 410);
  const forged = await app.inject({ method: 'POST', url: '/api/auth/telegram/bot/complete', headers: { origin: 'https://attacker.invalid' }, payload: { token: 'a'.repeat(43), confirmed: true } });
  assert.equal(forged.statusCode, 403);
  const forgedWebhook = await app.inject({ method: 'POST', url: '/api/telegram/webhook', headers: { 'x-telegram-bot-api-secret-token': 'wrong-secret' }, payload: { update_id: 99999 } });
  assert.equal(forgedWebhook.statusCode, 403);
  const forgedStart = await app.inject({ method: 'POST', url: '/api/auth/telegram/start', headers: { origin: 'https://attacker.invalid' }, payload: { returnTo: '/watchlist' } });
  assert.equal(forgedStart.statusCode, 403);
  pass('expiry, initiation/completion origins and authenticated webhook secret fail closed');

  const differentId = randomUUID(), differentSession = randomBytes(32).toString('hex');
  await pool.query(`INSERT INTO auth_users(id,issuer,subject,name,telegram_id) VALUES($1,$2,'other-subject','Other',87654321)`, [differentId, telegramIssuer]);
  await pool.query(`INSERT INTO auth_sessions(id,user_id,secret_hash,expires_at) VALUES($1,$2,$3,now()+interval '1 day')`, [randomUUID(), differentId, hash(differentSession)]);
  const switchingStart = await start(), switching = await authorize(switchingStart.payload); assert.ok(switching.secret);
  assert.equal((await complete(switching.secret, `${switchingStart.browserJar}; bscan_auth=${differentSession}`, true)).statusCode, 409);
  assert.equal((await complete(switching.secret, `bscan_auth=${differentSession}`)).statusCode, 409);
  assert.equal((await preview(switching.secret)).statusCode, 200, 'Rejected account switching must retain the proof');
  pass('an authenticated different account cannot be silently replaced');

  const knownPlain = await authorize(''); assert.ok(knownPlain.secret);
  assert.match(sent.at(-1)!.text, /Sign in to Kollens/); assert.doesNotMatch(sent.at(-1)!.text, /Manage alerts/);
  assert.equal((await preview(knownPlain.secret)).json().sameBrowser, false);
  const standalone = (await pool.query('SELECT guest_snapshot,return_to FROM auth_bot_login_attempts WHERE finish_hash=$1', [hash(knownPlain.secret)])).rows[0];
  assert.equal(standalone.guest_snapshot, null); assert.equal(standalone.return_to, '/watchlist');
  assert.equal((await complete(knownPlain.secret, '', true)).statusCode, 403, 'Bot-origin links still require manual confirmation');
  const knownPlainResult = await complete(knownPlain.secret); assert.equal(knownPlainResult.statusCode, 200, knownPlainResult.body);
  const knownPlainMe = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: cookie(knownPlainResult, 'bscan_auth') } });
  assert.equal(knownPlainMe.json().user.id, existingId);
  const beforePlainRepeat = sent.length;
  await app.inject({ method: 'POST', url: '/api/telegram/webhook', headers: { 'x-telegram-bot-api-secret-token': webhookSecret }, payload: knownPlain.body });
  assert.equal(sent.length, beforePlainRepeat); assert.equal(notificationUpdates.length, 0);
  pass('plain private /start sends a one-time login button for a mapped user, with no alert-status reply or source-browser authority');

  const usersBeforePlain = await count('auth_users'), sessionsBeforePlain = await count('auth_sessions');
  const newPlain = await authorize('', 33334444); assert.ok(newPlain.secret);
  assert.equal(await count('auth_users'), usersBeforePlain); assert.equal(await count('auth_sessions'), sessionsBeforePlain);
  assert.match(sent.at(-1)!.buttons![0][0].text, /Continue to Kollens/);
  const newPlainResult = await complete(newPlain.secret); assert.equal(newPlainResult.statusCode, 200, newPlainResult.body);
  assert.equal(await count('auth_users'), usersBeforePlain + 1);
  const newPlainMe = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: cookie(newPlainResult, 'bscan_auth') } });
  assert.notEqual(newPlainMe.json().user.id, existingId);
  pass('unregistered private /start does not authenticate automatically and creates its own account only after explicit confirmation');

  const renewed = await authorize(`login_${'z'.repeat(43)}`); assert.ok(renewed.secret);
  assert.match(sent.at(-1)!.text, /previous login request is no longer active/);
  assert.match(sent.at(-1)!.buttons![0][0].url, /^https:\/\/kollens\.com\/auth\/telegram\/finish#token=/);
  assert.equal((await preview(renewed.secret)).json().sameBrowser, false); assert.equal(notificationUpdates.length, 0);
  pass('unknown or cross-environment login payloads receive fresh configured-origin login guidance without inheriting browser state');

  const legacyId = randomUUID();
  await pool.query(`INSERT INTO auth_users(id,issuer,subject,name,username) VALUES($1,$2,'legacy-opaque-subject','Legacy','pg_test')`, [legacyId, telegramIssuer]);
  const usersBeforeRecovery = await count('auth_users'), legacyStart = await start(), legacy = await authorize(legacyStart.payload, 22223333); assert.ok(legacy.secret);
  assert.equal((await preview(legacy.secret)).json().requiresRecovery, true);
  assert.equal((await complete(legacy.secret, legacyStart.browserJar, true)).statusCode, 428, 'Automatic mode cannot bypass legacy identity recovery');
  assert.equal((await complete(legacy.secret)).statusCode, 428); assert.equal(await count('auth_users'), usersBeforeRecovery);
  assert.deepEqual(await service.recoveryIdentity(legacy.secret), { telegramId: '22223333', returnTo: '/watchlist?tab=kols' });
  assert.equal((await pool.query('SELECT telegram_id FROM auth_users WHERE id=$1', [legacyId])).rows[0].telegram_id, null);
  pass('legacy unmapped identities require bounded recovery and never create an empty duplicate account');

  const snapshots = { users: await count('auth_users'), sessions: await count('auth_sessions'), updates: await count('auth_bot_login_updates') };
  await ensureTelegramBotLoginSchema(pool); await ensureTelegramBotLoginSchema(pool);
  assert.deepEqual({ users: await count('auth_users'), sessions: await count('auth_sessions'), updates: await count('auth_bot_login_updates') }, snapshots);
  pass('repeated schema initialization preserves accounts, sessions and durable login evidence');
  console.log(JSON.stringify({ event: 'telegram_bot_login_integration_passed', scenarios: passes.length, fakeMessages: sent.length, externalRequests: 0 }));
} finally {
  globalThis.fetch = originalFetch;
  await app.close(); await pool.end();
}
