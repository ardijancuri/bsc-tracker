// Run only against a disposable bscan_auth_test database.
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import Fastify from 'fastify';
import { ensureSchema, pool } from './db.js';
import { registerIntelligenceRoutes } from './intelligenceApi.js';
import { captureGuestWatchlist, mergeGuestWatchlist } from './accountWatchlist.js';
import { createTelegramOidc, registerTelegramAuthRoutes, telegramIssuer, type TelegramAuthConfig } from './telegramAuth.js';
import { defaultPreferences } from '../shared/intelligence.js';

if (!/^\/bscan_auth_test(?:_\d+)?$/.test(new URL(process.env.DATABASE_URL || '').pathname)) throw new Error('Use a disposable bscan_auth_test database');
process.env.NODE_ENV = 'production';
process.env.PUBLIC_APP_URL = 'https://kollens.com';
const app = Fastify({ logger: false });
const origin = 'https://kollens.com', kol = `0x${'a'.repeat(40)}`, token = `0x${'b'.repeat(40)}`, token2 = `0x${'c'.repeat(40)}`;
const config: TelegramAuthConfig = { clientId: '12345', clientSecret: 'test-only-not-a-real-secret', origin, secure: true };
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test', alg: 'RS256', use: 'sig' };
const claimsByCode = new Map<string, { nonce: string; sub: string }>();
const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  if (url.endsWith('/.well-known/openid-configuration')) return Response.json({ issuer: telegramIssuer, authorization_endpoint: `${telegramIssuer}/auth`, token_endpoint: `${telegramIssuer}/token`, jwks_uri: `${telegramIssuer}/.well-known/jwks.json`, response_types_supported: ['code'], subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['RS256'], token_endpoint_auth_methods_supported: ['client_secret_basic'], code_challenge_methods_supported: ['S256'] });
  if (url.endsWith('/.well-known/jwks.json')) return Response.json({ keys: [jwk] });
  if (url.endsWith('/token')) {
    const params = new URLSearchParams(String(init?.body)), claim = claimsByCode.get(params.get('code') || '');
    assert.ok(claim);
    const now = Math.floor(Date.now() / 1000);
    const payload = { iss: telegramIssuer, aud: config.clientId, ...claim, iat: now, exp: now + 3600, name: 'Telegram Test User', preferred_username: 'test_user' };
    const body = [Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'test' })).toString('base64url'), Buffer.from(JSON.stringify(payload)).toString('base64url')].join('.');
    return Response.json({ access_token: 'discarded-test-token', token_type: 'Bearer', expires_in: 3600, id_token: `${body}.${sign('RSA-SHA256', Buffer.from(body), privateKey).toString('base64url')}` });
  }
  throw new Error('Unexpected authentication endpoint');
};
registerTelegramAuthRoutes(app, { config, captureGuest: captureGuestWatchlist, mergeGuest: mergeGuestWatchlist, oidcConfiguration: () => createTelegramOidc(config, fetcher as never) });
registerIntelligenceRoutes(app);
const cookie = (response: { headers: Record<string, unknown> }, name: string) => {
  const values = [response.headers['set-cookie']].flat().map(String);
  return values.find(value => value.startsWith(name + '='))?.split(';')[0] || '';
};
const request = (method: 'GET' | 'PUT' | 'DELETE' | 'POST', url: string, jar = '', payload?: Record<string, unknown>, owner?: string) => app.inject({ method, url,
  headers: { origin, ...(jar ? { cookie: jar } : {}), ...(owner ? { 'x-watchlist-owner': owner } : {}) }, ...(payload === undefined ? {} : { payload }) });
async function login(sub: string, guest = '') {
  const start = await request('POST', '/api/auth/telegram/start', guest, { returnTo: '/watchlist?kind=kol' });
  assert.equal(start.statusCode, 200, start.body);
  const authorization = new URL(start.json().url), code = randomUUID();
  claimsByCode.set(code, { nonce: authorization.searchParams.get('nonce')!, sub });
  const callback = await request('GET', `/api/auth/telegram/callback?code=${code}&state=${authorization.searchParams.get('state')}`, cookie(start, 'bscan_login'));
  return { callback, jar: cookie(callback, 'bscan_auth') };
}

try {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await ensureSchema();
  await Promise.all([ensureSchema(), ensureSchema()]);
  await pool.query(`INSERT INTO kols(address,display_name,is_tracked) VALUES($1,'Test KOL',true)`, [kol]);
  for (const [key, symbol] of [[token, 'ONE'], [token2, 'TWO']]) {
    await pool.query(`INSERT INTO tokens(address,symbol,name,price_usd,price_source,decimals,is_meme) VALUES($1,$2,$2,0.001,'onchain',18,true)`, [key, symbol]);
    await pool.query(`INSERT INTO trades(id,tx_hash,wallet_address,token_address,side,timestamp,source,block_number,price_usd,amount_usd) VALUES($1,$1,$2,$3,'buy',now(),'node',1,0.001,10)`, [randomUUID(), kol, key]);
  }
  const first = await request('PUT', `/api/watchlist/items/token/${token}`, '', undefined, 'guest');
  assert.equal(first.statusCode, 200, first.body);
  const guestJar = cookie(first, 'bscan_watch'); assert.ok(guestJar);
  const preferences = { ...defaultPreferences, windowMinutes: 30, minBuyers: 4 };
  assert.equal((await request('PUT', '/api/watchlist', guestJar, { preferences }, 'guest')).statusCode, 200);
  const firstLogin = await login('telegram-user-one', guestJar);
  assert.equal(firstLogin.callback.headers.location, '/watchlist?kind=kol&telegramLogin=success', firstLogin.callback.body);
  assert.ok(firstLogin.jar);
  const identity = (await request('GET', '/api/auth/me', firstLogin.jar)).json().user;
  assert.ok(identity.id);
  const signed = (await request('GET', '/api/watchlist', firstLogin.jar)).json();
  assert.equal(signed.items[0].address, token);
  assert.equal(signed.preferences.windowMinutes, 30);
  assert.equal((await request('GET', '/api/watchlist', guestJar)).json().items.length, 0, 'Merged guest cookie is revoked');
  assert.equal((await request('PUT', '/api/watchlist', firstLogin.jar, { items: [] }, identity.id)).statusCode, 409, 'Legacy stale replacement cannot erase account favorites');

  const secondDevice = await login('telegram-user-one');
  assert.equal((await request('GET', '/api/watchlist', secondDevice.jar)).json().items[0].address, token);
  const additions = await Promise.all([
    request('PUT', `/api/watchlist/items/token/${token2}`, firstLogin.jar, undefined, identity.id),
    request('PUT', `/api/watchlist/items/kol/${kol}`, secondDevice.jar, undefined, identity.id),
  ]);
  additions.forEach(response => assert.equal(response.statusCode, 200, response.body));
  assert.equal((await request('GET', '/api/watchlist', secondDevice.jar)).json().items.length, 3, 'Concurrent device additions compose');
  assert.equal((await request('GET', '/api/watchlist', firstLogin.jar, undefined, 'guest')).statusCode, 409);
  assert.equal((await request('DELETE', `/api/watchlist/items/token/${token}`, secondDevice.jar, undefined, 'guest')).statusCode, 409);
  assert.equal((await request('PUT', `/api/watchlist/items/kol/${kol}`, firstLogin.jar, undefined, identity.id)).statusCode, 200, 'Repeated add is idempotent');
  const intruder = await login('telegram-user-two');
  assert.equal((await request('GET', '/api/watchlist', intruder.jar)).json().items.length, 0, 'Accounts are isolated');
  const rejectedOrigin = await app.inject({ method: 'DELETE', url: `/api/watchlist/items/token/${token}`, headers: { cookie: firstLogin.jar, origin: 'https://attacker.invalid' } });
  assert.equal(rejectedOrigin.statusCode, 403);

  const cleared = await request('DELETE', '/api/watchlist', secondDevice.jar, undefined, identity.id);
  assert.equal(cleared.json().items.length, 0);
  assert.deepEqual(cleared.json().preferences, defaultPreferences);
  assert.equal((await request('GET', '/api/auth/me', secondDevice.jar)).json().user.id, identity.id, 'Clear retains login');
  await request('PUT', `/api/watchlist/items/token/${token}`, firstLogin.jar, undefined, identity.id);
  await request('POST', '/api/auth/logout', firstLogin.jar);
  assert.equal((await request('GET', '/api/auth/me', firstLogin.jar)).json().user, null);
  assert.equal((await request('GET', '/api/auth/me', secondDevice.jar)).json().user.id, identity.id, 'Logout revokes only one device');
  assert.equal((await request('GET', '/api/watchlist', secondDevice.jar)).json().items.length, 1);

  const preferenceGuest = await request('PUT', `/api/watchlist/items/token/${token2}`);
  const returningGuestJar = cookie(preferenceGuest, 'bscan_watch');
  await request('PUT', '/api/watchlist', returningGuestJar, { preferences: { ...defaultPreferences, windowMinutes: 5 } });
  const returning = await login('telegram-user-one', returningGuestJar);
  assert.equal((await request('GET', '/api/watchlist', returning.jar)).json().items.length, 2);
  assert.equal((await request('GET', '/api/watchlist', returning.jar)).json().preferences.windowMinutes, 10, 'Returning account retains its preferences');

  // Exceeding a merge limit must roll back both the account merge and guest consumption.
  const overflowGuest = await request('PUT', `/api/watchlist/items/kol/${kol}`);
  const overflowJar = cookie(overflowGuest, 'bscan_watch');
  const synthetic = Array.from({ length: 100 }, (_, index) => [identity.id, `0x${(index + 1).toString(16).padStart(40, '0')}`]);
  for (const [userId, address] of synthetic) await pool.query(`INSERT INTO account_watch_entries(user_id,kind,address) VALUES($1,'kol',$2)`, [userId, address]);
  const overflow = await login('telegram-user-one', overflowJar);
  assert.match(String(overflow.callback.headers.location), /authError=merge_limit/);
  assert.equal(overflow.jar, '');
  assert.equal((await request('GET', '/api/watchlist', overflowJar)).json().items[0].address, kol);
  assert.equal((await pool.query(`SELECT COUNT(*)::int AS count FROM account_watch_entries WHERE user_id=$1 AND kind='kol'`, [identity.id])).rows[0].count, 100);
  await pool.query(`DELETE FROM account_watch_entries WHERE user_id=$1 AND kind='kol'`, [identity.id]);

  const hash = createHash('sha256').update(returning.jar.split('=')[1]).digest('hex');
  await pool.query(`UPDATE auth_sessions SET expires_at=now()-interval '1 second' WHERE secret_hash=$1`, [hash]);
  assert.equal((await request('PUT', `/api/watchlist/items/kol/${kol}`, returning.jar, undefined, identity.id)).statusCode, 409);
  const expired = await request('GET', '/api/auth/me', returning.jar);
  assert.equal(expired.json().user, null);
  assert.match(cookie(expired, 'bscan_auth'), /^bscan_auth=$/);
  assert.equal((await pool.query(`SELECT COUNT(*)::int AS count FROM active_watch_entries WHERE kind='token' AND address=ANY($1::text[])`, [[token, token2]])).rows[0].count, 2, 'Account favorites retain worker priority after session expiry');
  console.log('Account integration passed: real signed OIDC callback, schema concurrency, guest merge, account isolation, device sync, atomic saves, limits, logout, expiry and persistent worker favorites.');
} finally { await app.close(); await pool.end(); }
