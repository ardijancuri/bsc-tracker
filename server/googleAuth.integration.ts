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
const discoveryEndpoint = googleIssuer + '/.well-known/openid-configuration';
const authorizeEndpoint = googleIssuer + '/o/oauth2/v2/auth';
const tokenEndpoint = 'https://oauth2.googleapis.com/token';
const keysEndpoint = 'https://www.googleapis.com/oauth2/v3/certs';
const callbackPath = '/api/auth/google/callback';
const {privateKey, publicKey} = generateKeyPairSync('rsa', {modulusLength: 2048});
const badKey = generateKeyPairSync('rsa', {modulusLength: 2048}).privateKey;
const jwk = {...publicKey.export({format: 'jwk'}), kid: 'mock-key', alg: 'RS256', use: 'sig'};
const sub = randomUUID();
const codes = new Map<string, {nonce: string; challenge: string; badSignature?: boolean}>();
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
    {iss: googleIssuer, aud: config.clientId, sub, nonce: expected.nonce, iat: now, exp: now + 3600, name: 'Google fixture'},
  ].map(value => Buffer.from(JSON.stringify(value)).toString('base64url')).join('.');
  return Response.json({
    access_token: 'discarded-google-access-token', token_type: 'Bearer', expires_in: 3600,
    id_token: body + '.' + sign('RSA-SHA256', Buffer.from(body), expected.badSignature ? badKey : privateKey).toString('base64url'),
  });
};
const app = Fastify(), unavailableApp = Fastify();
let oidc: ReturnType<typeof createGoogleOidc> | undefined;
registerGoogleAuthRoutes(app, {db, config, oidcConfiguration: () => oidc ??= createGoogleOidc(config, fetcher)});
registerGoogleAuthRoutes(unavailableApp, {db, config: null});
registerExtensionApi(app, {db, origin: config.origin, extensionOrigins: [extension]});
const pairingIds: string[] = [];
const verifier = randomBytes(32).toString('hex');
const challenge = createHash('sha256').update(verifier).digest('base64url');
const cookie = (headers: Record<string, unknown>, name: string) => [headers['set-cookie']].flat().map(String)
  .find(value => value.startsWith(name + '='))?.split(';')[0];
const pair = async () => {
  const reply = await app.inject({
    method: 'POST', url: '/api/extension/auth/start', payload: {challenge}, headers: {origin: extension},
  });
  assert.equal(reply.statusCode, 200, reply.body);
  const id = reply.json().id as string;
  pairingIds.push(id);
  return id;
};
const start = (id: string, headers: Record<string, string> = {}) => app.inject({
  method: 'POST', url: '/api/auth/google/start', payload: {id}, headers: {origin: config.origin, ...headers},
});
async function authorize(id: string, overrides: {badSignature?: boolean; wrongNonce?: boolean} = {}) {
  const reply = await start(id);
  assert.equal(reply.statusCode, 200, reply.body);
  const browser = cookie(reply.headers, 'bscan_google_login')!;
  assert.ok(browser);
  const authorization = new URL(reply.json().url);
  assert.equal(authorization.origin + authorization.pathname, authorizeEndpoint);
  assert.equal(authorization.searchParams.get('scope'), 'openid profile');
  assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
  const code = randomUUID();
  const state = authorization.searchParams.get('state')!;
  codes.set(code, {
    nonce: overrides.wrongNonce ? 'wrong-nonce' : authorization.searchParams.get('nonce')!,
    challenge: authorization.searchParams.get('code_challenge')!,
    badSignature: overrides.badSignature,
  });
  return {browser, state, url: `${callbackPath}?code=${code}&state=${state}`};
}
const callback = (url: string, browser: string) => app.inject({method: 'GET', url, headers: {cookie: browser}});
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

  const lookup = await db.query('SELECT id,name FROM auth_users WHERE issuer=$1 AND subject=$2', [googleIssuer, sub]);
  assert.equal(lookup.rows[0].name, 'Google fixture');
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
  const repeat = await authorize(next);
  const secondLogin = await callback(repeat.url, repeat.browser);
  const secondCookie = cookie(secondLogin.headers, 'bscan_auth')!;
  assert.equal((await resolveAuthUser({headers: {cookie: secondCookie}} as never, db))?.id, userId);
  console.log('Google extension integration passed: verified JWT, wrong browser, replay, invalid signature and nonce, cancellation, stable identity, and paired extension session.');
} finally {
  await app.close();
  await unavailableApp.close();
  const returnUrls = pairingIds.map(id => '/extension/connect?id=' + id);
  await db.query('DELETE FROM auth_login_attempts WHERE return_to=ANY($1::text[])', [returnUrls]);
  await db.query('DELETE FROM extension_pairing_attempts WHERE id=ANY($1::uuid[])', [pairingIds]);
  await db.query('DELETE FROM auth_users WHERE issuer=$1 AND subject=$2', [googleIssuer, sub]);
  await db.end();
}
