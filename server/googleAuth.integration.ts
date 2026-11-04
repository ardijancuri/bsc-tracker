import assert from 'node:assert/strict';
import {createHash, generateKeyPairSync, randomBytes, randomUUID, sign} from 'node:crypto';
import Fastify from 'fastify';
import type {CustomFetch} from 'openid-client';
import {Pool} from 'pg';
import {ensureExtensionSchema, registerExtensionApi} from './extensionApi.js';
import {createGoogleOidc, googleIssuer, registerGoogleAuthRoutes} from './googleAuth.js';
import {ensureAuthSchema, resolveAuthUser} from './telegramAuth.js';

const database = new URL(process.env.EXTENSION_DATABASE_URL ?? 'postgresql://postgres@127.0.0.1:5442/kollens_extension_local_20261102');
if (database.hostname !== '127.0.0.1' || database.port !== '5442' || !/^\/kollens_extension_/.test(database.pathname)) {
  throw new Error('Use only an isolated extension database on 127.0.0.1:5442');
}
const db = new Pool({connectionString: database.href});
const config = {clientId: 'test-client', clientSecret: 'test-secret', origin: 'https://kollens.example', secure: true};
const extension = 'chrome-extension://' + 'a'.repeat(32);
const nativeRedirect = 'https://' + 'a'.repeat(32) + '.chromiumapp.org/kollens';
const discoveryEndpoint = googleIssuer + '/.well-known/openid-configuration';
const authorizeEndpoint = googleIssuer + '/o/oauth2/v2/auth';
const tokenEndpoint = 'https://oauth2.googleapis.com/token';
const keysEndpoint = 'https://www.googleapis.com/oauth2/v3/certs';
const callbackPath = '/api/auth/google/callback';
const {privateKey, publicKey} = generateKeyPairSync('rsa', {modulusLength: 2048});
const badKey = generateKeyPairSync('rsa', {modulusLength: 2048}).privateKey;
const jwk = {...publicKey.export({format: 'jwk'}), kid: 'mock-key', alg: 'RS256', use: 'sig'};
const sub = randomUUID();
const verifiedEmail = 'google-fixture@example.com';
const codes = new Map<string, {nonce: string; challenge: string; badSignature?: boolean; unverifiedEmail?: boolean}>();
let exchanges = 0;
const fetcher: CustomFetch = async (input, init) => {
  const url = String(input);
  if (url === discoveryEndpoint) return Response.json({
    issuer: googleIssuer, authorization_endpoint: authorizeEndpoint, token_endpoint: tokenEndpoint,
    jwks_uri: keysEndpoint, response_types_supported: ['code'], subject_types_supported: ['public'],
    id_token_signing_alg_values_supported: ['RS256'], token_endpoint_auth_methods_supported: ['client_secret_post'],
    code_challenge_methods_supported: ['S256'],
  });
  if (url === keysEndpoint) return Response.json({keys: [jwk]});
  assert.equal(url, tokenEndpoint);
  exchanges++;
  const form = new URLSearchParams(String(init?.body));
  const code = form.get('code') ?? '';
  const expected = codes.get(code);
  assert.ok(expected, 'Only fixture codes are accepted');
  codes.delete(code);
  assert.equal(form.get('client_id'), config.clientId);
  assert.equal(form.get('client_secret'), config.clientSecret);
  assert.equal(form.get('redirect_uri'), config.origin + callbackPath);
  assert.equal(createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url'), expected.challenge);
  const now = Math.floor(Date.now() / 1000);
  const body = [
    {alg: 'RS256', kid: 'mock-key'},
    {iss: googleIssuer, aud: config.clientId, sub, nonce: expected.nonce, iat: now, exp: now + 3600, name: 'Google fixture',
      email: expected.unverifiedEmail ? 'unverified@example.com' : verifiedEmail, email_verified: !expected.unverifiedEmail},
  ].map(value => Buffer.from(JSON.stringify(value)).toString('base64url')).join('.');
  return Response.json({
    access_token: 'discarded-google-access-token', token_type: 'Bearer', expires_in: 3600,
    id_token: body + '.' + sign('RSA-SHA256', Buffer.from(body), expected.badSignature ? badKey : privateKey).toString('base64url'),
  });
};
const app = Fastify(), unavailableApp = Fastify();
let oidc: ReturnType<typeof createGoogleOidc> | undefined;
registerGoogleAuthRoutes(app, {db, config, extensionOrigins: [extension], oidcConfiguration: () => oidc ??= createGoogleOidc(config, fetcher)});
registerGoogleAuthRoutes(unavailableApp, {db, config: null});
registerExtensionApi(app, {db, origin: config.origin, extensionOrigins: [extension]});
const pairingIds: string[] = [];
const verifier = randomBytes(32).toString('hex');
const challenge = createHash('sha256').update(verifier).digest('base64url');
const cookie = (headers: Record<string, unknown>, name: string) => [headers['set-cookie']].flat().map(String)
  .find(value => value.startsWith(name + '='))?.split(';')[0];
const pair = async (native = false) => {
  const reply = await app.inject({
    method: 'POST', url: '/api/extension/auth/start', payload: {challenge, ...(native ? {mode: 'native'} : {})}, headers: {origin: extension},
  });
  assert.equal(reply.statusCode, 200, reply.body);
  const id = reply.json().id as string;
  pairingIds.push(id);
  return id;
};
const start = (id: string, headers: Record<string, string> = {}) => app.inject({
  method: 'POST', url: '/api/auth/google/start', payload: {id}, headers: {origin: config.origin, ...headers},
});
const nativeStart = (id: string, proof = verifier, headers: Record<string, string> = {}) => app.inject({
  method: 'POST', url: '/api/extension/auth/google/start', payload: {id, verifier: proof}, headers: {origin: extension, ...headers},
});
function providerCallback(authorization: URL, overrides: {badSignature?: boolean; wrongNonce?: boolean; unverifiedEmail?: boolean} = {}) {
  assert.equal(authorization.origin + authorization.pathname, authorizeEndpoint);
  assert.equal(authorization.searchParams.get('scope'), 'openid profile email');
  assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
  const code = randomUUID();
  const state = authorization.searchParams.get('state')!;
  codes.set(code, {
    nonce: overrides.wrongNonce ? 'wrong-nonce' : authorization.searchParams.get('nonce')!,
    challenge: authorization.searchParams.get('code_challenge')!,
    badSignature: overrides.badSignature,
    unverifiedEmail: overrides.unverifiedEmail,
  });
  return {state, url: `${callbackPath}?code=${code}&state=${state}`};
}
async function authorize(id: string, overrides: {badSignature?: boolean; wrongNonce?: boolean; unverifiedEmail?: boolean} = {}) {
  const reply = await start(id);
  assert.equal(reply.statusCode, 200, reply.body);
  const browser = cookie(reply.headers, 'bscan_google_login')!;
  assert.ok(browser);
  return {browser, ...providerCallback(new URL(reply.json().url), overrides)};
}
async function authorizeNative(id: string, overrides: {wrongNonce?: boolean; unverifiedEmail?: boolean} = {}) {
  const reply = await nativeStart(id);
  assert.equal(reply.statusCode, 200, reply.body);
  assert.equal(reply.headers['set-cookie'], undefined);
  const bootstrap = new URL(reply.json().url);
  assert.equal(bootstrap.origin, config.origin);
  assert.equal(bootstrap.pathname, '/api/auth/google/extension/launch');
  const launch = await app.inject(bootstrap.pathname + bootstrap.search);
  assert.equal(launch.statusCode, 302, launch.body);
  assert.equal((await app.inject(bootstrap.pathname + bootstrap.search)).statusCode, 400, 'Bootstrap tickets are single-use');
  const authorization = new URL(launch.headers.location!);
  const browser = cookie(launch.headers, 'bscan_google_login_' + authorization.searchParams.get('state')!.slice(2))!;
  assert.ok(browser);
  assert.equal(authorization.searchParams.get('prompt'), 'select_account');
  assert.equal(authorization.searchParams.get('redirect_uri'), config.origin + callbackPath);
  assert.ok(!authorization.href.includes(bootstrap.searchParams.get('ticket')!));
  return {browser, ...providerCallback(authorization, overrides)};
}
const callback = (url: string, browser: string) => app.inject({method: 'GET', url, headers: {cookie: browser}});
const exchangeNative = (id: string, proof?: string, secret = verifier) => app.inject({
  method: 'POST', url: '/api/extension/auth/exchange', payload: {id, verifier: secret, ...(proof ? {proof} : {})}, headers: {origin: extension},
});
try {
  await ensureAuthSchema(db);
  await ensureExtensionSchema(db);
  assert.equal((await unavailableApp.inject('/api/auth/google/status')).json().enabled, false);
  assert.equal((await app.inject('/api/auth/google/status')).json().enabled, true);
  assert.equal((await start(randomUUID())).statusCode, 410);
  const id = await pair();
  assert.equal((await start(id, {origin: 'https://elsewhere.example'})).statusCode, 403);
  const first = await authorize(id);
  assert.equal((await callback(first.url, 'bscan_google_login=' + '1'.repeat(64))).headers.location, '/extension/connect?googleError=failed');
  assert.equal(exchanges, 0);
  const signed = await callback(first.url, first.browser);
  assert.equal(signed.headers.location, '/extension/connect?id=' + id);
  const web = cookie(signed.headers, 'bscan_auth');
  assert.ok(web);
  assert.match(String(signed.headers['set-cookie']), /bscan_auth=[a-f0-9]{64}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=2592000; Secure/);
  assert.equal((await callback(first.url, first.browser)).headers.location, '/extension/connect?googleError=failed');
  assert.equal(exchanges, 1);

  const lookup = await db.query('SELECT id,name,email FROM auth_users WHERE issuer=$1 AND subject=$2', [googleIssuer, sub]);
  assert.equal(lookup.rows[0].name, 'Google fixture');
  assert.equal(lookup.rows[0].email, verifiedEmail);
  const userId = lookup.rows[0].id as string;
  assert.equal((await resolveAuthUser({headers: {cookie: web}} as never, db))?.id, userId);
  const approval = await app.inject({
    method: 'POST', url: '/api/extension/auth/approve', payload: {id, expectedUserId: userId},
    headers: {origin: config.origin, cookie: web},
  });
  assert.equal(approval.statusCode, 200, approval.body);
  const exchange = await app.inject({
    method: 'POST', url: '/api/extension/auth/exchange', payload: {id, verifier}, headers: {origin: extension},
  });
  assert.equal(exchange.statusCode, 200, exchange.body);
  assert.match(exchange.json().token, /^kex_/);

  const next = await pair();
  assert.equal((await start(next, {cookie: web})).statusCode, 409);
  const invalidSignature = await authorize(next, {badSignature: true});
  const rejected = await callback(invalidSignature.url, invalidSignature.browser);
  assert.equal(rejected.headers.location, `/extension/connect?id=${next}&googleError=failed`);
  assert.equal(cookie(rejected.headers, 'bscan_auth'), undefined);
  const invalidNonce = await authorize(next, {wrongNonce: true});
  assert.equal((await callback(invalidNonce.url, invalidNonce.browser)).headers.location, `/extension/connect?id=${next}&googleError=failed`);
  const cancelled = await authorize(next);
  assert.equal((await callback(`${callbackPath}?error=access_denied&state=${cancelled.state}`, cancelled.browser)).headers.location,
    `/extension/connect?id=${next}&googleError=cancelled`);
  const repeat = await authorize(next, {unverifiedEmail: true});
  const secondLogin = await callback(repeat.url, repeat.browser);
  const secondCookie = cookie(secondLogin.headers, 'bscan_auth')!;
  assert.equal((await resolveAuthUser({headers: {cookie: secondCookie}} as never, db))?.id, userId);
  assert.equal((await db.query('SELECT email FROM auth_users WHERE id=$1', [userId])).rows[0].email, verifiedEmail);

  // A forged extension tag or shared pairing UUID cannot start native authorization.
  const nativeId = await pair(true);
  assert.equal((await nativeStart(nativeId, verifier, {origin: 'https://elsewhere.example', 'x-kollens-extension-origin': extension})).statusCode, 403);
  assert.equal((await nativeStart(nativeId, 'f'.repeat(64))).statusCode, 410);
  assert.equal((await nativeStart(next)).statusCode, 410);
  assert.equal((await start(nativeId)).statusCode, 410);
  const nativeApproval = await app.inject({
    method: 'POST', url: '/api/extension/auth/approve', payload: {id: nativeId, expectedUserId: userId},
    headers: {origin: config.origin, cookie: web},
  });
  assert.equal(nativeApproval.statusCode, 410);
  const native = await authorizeNative(nativeId);
  assert.equal((await callback(native.url, first.browser)).statusCode, 400, 'A callback must be bound to its native launch browser');
  const nativeResult = await callback(native.url, `${native.browser}; ${web}`);
  assert.equal(nativeResult.statusCode, 302, nativeResult.body);
  assert.equal(cookie(nativeResult.headers, 'bscan_auth'), undefined, 'Native authorization must leave the web session alone');
  const destination = new URL(nativeResult.headers.location!);
  assert.equal(destination.origin + destination.pathname, nativeRedirect);
  assert.equal(destination.search, '');
  const finish = new URLSearchParams(destination.hash.slice(1));
  assert.equal(finish.get('id'), nativeId);
  const proof = finish.get('proof')!;
  assert.match(proof, /^[a-f0-9]{64}$/);
  const stored = (await db.query('SELECT completion_hash FROM extension_pairing_attempts WHERE id=$1', [nativeId])).rows[0];
  assert.equal(stored.completion_hash, createHash('sha256').update(proof).digest('hex'));

  // A signed-in victim can open a phishing bootstrap in an ordinary browser tab.
  // Its result proof is delivered only to that browser, so the verifier alone cannot steal the session.
  assert.equal((await exchangeNative(nativeId)).statusCode, 401);
  assert.equal((await exchangeNative(nativeId, 'f'.repeat(64))).statusCode, 401);
  assert.equal((await exchangeNative(nativeId, proof, 'f'.repeat(64))).statusCode, 401);
  const nativeExchange = await exchangeNative(nativeId, proof);
  assert.equal(nativeExchange.statusCode, 200, nativeExchange.body);
  assert.match(nativeExchange.json().token, /^kex_/);
  assert.equal((await exchangeNative(nativeId, proof)).statusCode, 410);
  assert.equal((await callback(native.url, native.browser)).statusCode, 400);
  const nativeWorkspace = await app.inject({url: '/api/extension/workspace',
    headers: {origin: extension, authorization: 'Bearer ' + nativeExchange.json().token}});
  assert.equal(nativeWorkspace.json().user.id, userId);
  const nativeCancelledId = await pair(true);
  const nativeCancelled = await authorizeNative(nativeCancelledId);
  assert.equal((await callback(`${callbackPath}?error=access_denied&state=${nativeCancelled.state}`, nativeCancelled.browser)).headers.location,
    nativeRedirect + '#error=cancelled');
  assert.equal((await exchangeNative(nativeCancelledId, 'f'.repeat(64))).statusCode, 202);
  console.log('Google extension integration passed: web compatibility, verified email, native authorization, wrong browser, replay, invalid signature and nonce, cancellation, stable identity, and two-proof extension session.');
} finally {
  await app.close();
  await unavailableApp.close();
  const returnUrls = pairingIds.map(id => '/extension/connect?id=' + id);
  await db.query('DELETE FROM auth_login_attempts WHERE return_to=ANY($1::text[])', [returnUrls]);
  await db.query('DELETE FROM extension_pairing_attempts WHERE id=ANY($1::uuid[])', [pairingIds]);
  await db.query('DELETE FROM auth_users WHERE issuer=$1 AND subject=$2', [googleIssuer, sub]);
  await db.end();
}
