import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { Pool } from 'pg';
import { emailAuthConfig, registerEmailAuthRoutes } from './emailAuth.js';
import { ensureExtensionSchema, registerExtensionApi } from './extensionApi.js';
import { ensureAuthSchema, resolveAuthUser } from './telegramAuth.js';

const source = new URL(process.env.EXTENSION_DATABASE_URL ?? 'postgresql://postgres@127.0.0.1:5442/kollens_extension_local_20261102');
if (source.hostname !== '127.0.0.1' || source.port !== '5442' || !source.pathname.startsWith('/kollens_extension_')) {
  throw new Error('Use only an isolated extension database on 127.0.0.1:5442');
}
const db = new Pool({ connectionString: source.href, max: 8 });
const app = Fastify();
const origin = 'https://kollens.example';
const extension = 'chrome-extension://' + 'a'.repeat(32);
const otherExtension = 'chrome-extension://' + 'b'.repeat(32);
const extensionOrigins = [extension, otherExtension];
const config = emailAuthConfig({
  PUBLIC_APP_URL: origin,
  KOLLENS_EMAIL_FROM: 'auth@example.test',
  KOLLENS_EMAIL_AUTH_SECRET: randomBytes(32).toString('hex'),
  RESEND_API_KEY: 'fake',
});
assert.ok(config);
assert.equal(emailAuthConfig({}), null);
assert.equal(emailAuthConfig({
  PUBLIC_APP_URL: 'http://kollens.example', KOLLENS_EMAIL_FROM: config.from,
  KOLLENS_EMAIL_AUTH_SECRET: config.secret, RESEND_API_KEY: 'fake',
}), null);

const mails = new Map<string, string>();
const pairings: string[] = [];
const email = 'Email-QA-' + randomUUID() + '@example.test';
const otherEmail = randomUUID() + '@example.test';
const nativeEmail = randomUUID() + '@example.test';
const nativeSubject = createHash('sha256').update(nativeEmail).digest('hex');
const emailSubject = createHash('sha256').update(email).digest('hex');
const googleId = randomUUID();
registerEmailAuthRoutes(app, {
  db, config, extensionOrigins,
  fetch: async (input, init) => {
    assert.equal(input, 'https://api.resend.com/emails');
    assert.equal(init?.redirect, 'error');
    const body = JSON.parse(String(init?.body));
    const code = body.text.match(/\b\d{6}\b/)?.[0];
    assert.ok(code);
    mails.set(body.to[0], code);
    return new Response('{}', { status: 200 });
  },
});
registerExtensionApi(app, { db, origin, extensionOrigins });

function call(route: string, payload: object, headers: Record<string, string> = { origin }) {
  return app.inject({ method: 'POST', url: '/api/' + route, payload, headers });
}
function getCookie(header: string | string[] | undefined, name: string) {
  const value = [header].flat().find(cookie => cookie?.startsWith(name + '='));
  assert.ok(value);
  assert.match(value, /; HttpOnly; SameSite=Lax; Secure$/);
  return value.split(';')[0];
}
async function pair(mode: 'web' | 'native' = 'web') {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const response = await call('extension/auth/start', { challenge, ...(mode === 'native' ? {mode} : {}) }, { origin: extension });
  assert.equal(response.statusCode, 200, response.body);
  const { id } = response.json();
  pairings.push(id);
  return { id, verifier };
}

try {
  await ensureAuthSchema(db);
  await ensureExtensionSchema(db);
  await db.query("INSERT INTO auth_users (id,issuer,subject,name) VALUES ($1,'https://accounts.google.com',$2,'Google test')", [googleId, emailSubject]);
  const status = await app.inject('/api/auth/email/status');
  assert.deepEqual(status.json(), { available: true });
  const { id, verifier } = await pair();
  assert.equal((await call('auth/email/start', { id, email }, { origin: 'https://invalid.example' })).statusCode, 403);
  assert.equal((await call('auth/email/start', { id: randomUUID(), email })).statusCode, 410);
  assert.equal(mails.size, 0);

  const started = await call('auth/email/start', { id, email: email.replace('example.test', 'EXAMPLE.test') });
  assert.equal(started.statusCode, 200, started.body);
  assert.deepEqual(started.json(), { sent: true });
  const cookie = getCookie(started.headers['set-cookie'], 'bscan_email_login');
  const code = mails.get(email);
  assert.ok(code);
  const stored = await db.query('SELECT code_hash,browser_hash FROM auth_email_login_attempts WHERE pairing_id=$1', [id]);
  assert.equal(stored.rows[0].code_hash.length, 64);
  assert.notEqual(stored.rows[0].code_hash, code);
  assert.notEqual(stored.rows[0].browser_hash, cookie.split('=')[1]);
  assert.equal((await call('auth/email/start', { id, email })).statusCode, 429);
  assert.equal((await call('auth/email/verify', { id, email, code })).statusCode, 400);
  const wrong = code === '000000' ? '999999' : '000000';
  assert.equal((await call('auth/email/verify', { id, email, code: wrong }, { origin, cookie })).statusCode, 400);
  const verified = await Promise.all(Array.from({ length: 2 }, () => call('auth/email/verify', { id, email, code }, { origin, cookie })));
  assert.deepEqual(verified.map(response => response.statusCode).sort(), [200, 400]);

  const success = verified.find(response => response.statusCode === 200)!;
  assert.deepEqual(success.json(), { authenticated: true });
  const webCookie = getCookie(success.headers['set-cookie'], 'bscan_auth');
  const me = await resolveAuthUser({ headers: { cookie: webCookie } } as Parameters<typeof resolveAuthUser>[0], db);
  assert.ok(me);
  assert.notEqual(me.id, googleId);
  assert.equal((await db.query('SELECT email FROM auth_users WHERE id=$1', [me.id])).rows[0].email, email);
  assert.equal((await call('extension/auth/exchange', { id, verifier }, { origin: extension })).statusCode, 202);
  assert.equal((await call('extension/auth/approve', { id, expectedUserId: me.id }, { origin, cookie: webCookie })).statusCode, 200);
  assert.equal((await call('extension/auth/exchange', { id, verifier }, { origin: extension })).statusCode, 200);

  const second = await pair();
  const secondStarted = await call('auth/email/start', { id: second.id, email: otherEmail });
  assert.equal(secondStarted.statusCode, 200, secondStarted.body);
  const secondCookie = getCookie(secondStarted.headers['set-cookie'], 'bscan_email_login');
  const secondCode = mails.get(otherEmail);
  assert.ok(secondCode);
  const guess = secondCode === '000000' ? '999999' : '000000';
  for (let index = 0; index < 5; index++) {
    assert.equal((await call('auth/email/verify', { id: second.id, email: otherEmail, code: guess }, { origin, cookie: secondCookie })).statusCode, 400);
  }
  assert.equal((await call('auth/email/verify', { id: second.id, email: otherEmail, code: secondCode }, { origin, cookie: secondCookie })).statusCode, 400);
  assert.equal((await db.query('SELECT tries FROM auth_email_login_attempts WHERE pairing_id=$1', [second.id])).rows[0].tries, 5);
  const native = await pair('native');
  const nativeHeaders = { 'x-kollens-extension-origin': extension, cookie: webCookie };
  const nativeInput = { ...native, email: nativeEmail };
  const invalidVerifier = randomBytes(32).toString('base64url');
  assert.equal((await call('auth/email/start', { id: native.id, email: nativeEmail })).statusCode, 410);
  assert.equal((await call('extension/auth/email/start', nativeInput, { origin })).statusCode, 403);
  assert.equal((await call('extension/auth/email/start', nativeInput, { origin: otherExtension })).statusCode, 410);
  assert.equal((await call('extension/auth/email/start', { ...nativeInput, verifier: invalidVerifier }, nativeHeaders)).statusCode, 410);
  assert.equal((await call('extension/auth/email/start', { id: native.id, email: nativeEmail }, nativeHeaders)).statusCode, 400);
  assert.equal(mails.has(nativeEmail), false);

  const nativeStarted = await call('extension/auth/email/start', nativeInput, nativeHeaders);
  assert.equal(nativeStarted.statusCode, 200, nativeStarted.body);
  assert.deepEqual(nativeStarted.json(), { sent: true });
  assert.equal(nativeStarted.headers['set-cookie'], undefined);
  assert.equal(nativeStarted.headers['access-control-allow-origin'], extension);
  assert.equal((await call('extension/auth/email/start', nativeInput, nativeHeaders)).statusCode, 429);
  const nativeCode = mails.get(nativeEmail);
  assert.ok(nativeCode);
  const nativeVerify = { ...nativeInput, code: nativeCode };
  assert.equal((await call('extension/auth/email/verify', { ...nativeVerify, verifier: invalidVerifier }, nativeHeaders)).statusCode, 410);
  assert.equal((await call('extension/auth/email/verify', nativeVerify, { origin: otherExtension })).statusCode, 410);
  assert.equal((await call('extension/auth/exchange', native, nativeHeaders)).statusCode, 202);

  const nativeResults = await Promise.all(Array.from({ length: 2 }, () => call('extension/auth/email/verify', nativeVerify, nativeHeaders)));
  assert.equal(nativeResults.filter(response => response.statusCode === 200).length, 1);
  assert.ok(nativeResults.some(response => [400, 410].includes(response.statusCode)));
  const nativeSuccess = nativeResults.find(response => response.statusCode === 200)!;
  assert.equal(nativeSuccess.headers['set-cookie'], undefined);
  assert.equal(nativeSuccess.json().verified, true);
  const proof = nativeSuccess.json().proof;
  assert.match(proof, /^[a-f0-9]{64}$/);
  const staged = (await db.query(`SELECT p.completion_hash,u.id,u.email FROM extension_pairing_attempts p
    JOIN auth_users u ON u.id=p.user_id WHERE p.id=$1`, [native.id])).rows[0];
  assert.equal(staged.completion_hash, createHash('sha256').update(proof).digest('hex'));
  assert.equal(staged.email, nativeEmail);
  assert.notEqual(staged.id, me.id);
  assert.equal((await db.query('SELECT count(*)::int AS count FROM auth_sessions WHERE user_id=$1', [staged.id])).rows[0].count, 0);
  assert.equal((await resolveAuthUser({ headers: { cookie: webCookie } } as Parameters<typeof resolveAuthUser>[0], db))?.id, me.id);
  assert.equal((await call('extension/auth/exchange', native, nativeHeaders)).statusCode, 401);
  assert.equal((await call('extension/auth/exchange', { ...native, proof: randomBytes(32).toString('hex') }, nativeHeaders)).statusCode, 401);
  const exchanged = await call('extension/auth/exchange', { ...native, proof }, nativeHeaders);
  assert.equal(exchanged.statusCode, 200, exchanged.body);
  assert.match(exchanged.json().token, /^kex_/);
  assert.equal(exchanged.headers['set-cookie'], undefined);
  assert.equal((await call('extension/auth/exchange', { ...native, proof }, nativeHeaders)).statusCode, 410);
  assert.deepEqual((await db.query('SELECT purpose FROM auth_sessions WHERE user_id=$1', [staged.id])).rows, [{ purpose: 'extension' }]);

  console.log('Email sign-in passed legacy and native origin, rate, retry, cookie isolation, proof and atomic pairing checks using fake delivery.');
} finally {
  await app.close();
  await db.query('DELETE FROM extension_pairing_attempts WHERE id=ANY($1::uuid[])', [pairings]);
  await db.query("DELETE FROM auth_users WHERE id=$1 OR issuer='urn:kollens:email' AND subject=ANY($2::text[])", [googleId, [emailSubject, nativeSubject]]);
  await db.end();
}
