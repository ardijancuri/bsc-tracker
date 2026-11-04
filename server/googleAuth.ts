import {createHash, randomBytes, randomUUID} from 'node:crypto';
import type {FastifyInstance, FastifyReply} from 'fastify';
import * as oidc from 'openid-client';
import type {Pool} from 'pg';
import {z} from 'zod';
import {extensionRequestOrigin, readExtensionNativePairing} from './extensionApi.js';
import {resolveAuthUser} from './telegramAuth.js';

export const googleIssuer = 'https://accounts.google.com';
const callbackPath = '/api/auth/google/callback';
const pairingPath = '/extension/connect';
const nativeLaunchPath = '/api/auth/google/extension/launch';
const purpose = 'extension_google';
const nativePurpose = 'extension_google_native';
const browserCookie = 'bscan_google_login';
const sessionLifetime = 30 * 86_400;
const attemptLifetime = 600;
const opaqueSecret = /^[a-f0-9]{64}$/;
const nativeState = /^n_[a-f0-9]{64}$/;
const nativeOrigin = /^chrome-extension:\/\/([a-p]{32})$/;
const pairingInput = z.object({id: z.string().uuid()}).strict();
const nativeInput = pairingInput.extend({verifier:z.string().regex(/^[A-Za-z0-9_-]{43,128}$/)});
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const secret = () => randomBytes(32).toString('hex');
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

export type GoogleAuthConfig = {clientId: string; clientSecret: string; origin: string; secure: boolean};

export function googleAuthConfig(env: NodeJS.ProcessEnv = process.env): GoogleAuthConfig | null {
  const clientId = env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = env.GOOGLE_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret || !env.PUBLIC_APP_URL?.trim()) return null;
  try {
    const url = new URL(env.PUBLIC_APP_URL);
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/') return null;
    const secure = url.protocol === 'https:';
    const localHttp = url.protocol === 'http:' && env.NODE_ENV !== 'production'
      && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    if (!secure && !localHttp) return null;
    return {clientId, clientSecret, origin: url.origin, secure};
  } catch { return null; }
}

export async function createGoogleOidc(config: GoogleAuthConfig, fetcher?: oidc.CustomFetch) {
  return oidc.discovery(new URL(googleIssuer), config.clientId, {
    client_secret: config.clientSecret, id_token_signed_response_alg: 'RS256',
  }, oidc.ClientSecretPost(config.clientSecret), {
    timeout: 10,
    execute: [oidc.enableNonRepudiationChecks],
    ...(fetcher ? {[oidc.customFetch]: fetcher} : {}),
  });
}

function formatCookie(name: string, value: string, seconds: number, secure: boolean, path = '/') {
  return `${name}=${value}; Path=${path}; HttpOnly; SameSite=Lax; Max-Age=${seconds}${secure ? '; Secure' : ''}`;
}

function bindingCookie(header: string | undefined, name = browserCookie) {
  const prefix = name + '=';
  const values = (header ?? '').split(';').map(value => value.trim()).filter(value => value.startsWith(prefix));
  if (values.length !== 1) return null;
  const value = values[0].slice(prefix.length);
  return opaqueSecret.test(value) ? value : null;
}

function nativeCookie(state: string) {
  return `${browserCookie}_${state.slice(2)}`;
}

function nativeRedirect(reply: FastifyReply, origin: string, result: {id: string; proof: string} | {error: 'cancelled' | 'failed'}) {
  const extensionId = nativeOrigin.exec(origin)?.[1];
  if (!extensionId) return nativeFailure(reply);
  return reply.redirect(`https://${extensionId}.chromiumapp.org/kollens#${new URLSearchParams(result)}`);
}

function nativeFailure(reply: FastifyReply) {
  return reply.code(400).type('text/plain').send('Google sign-in could not finish. Close this window and try again.');
}

function privateResponse(reply: FastifyReply) {
  reply.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer').header('Vary', 'Cookie');
}

function pairingRedirect(reply: FastifyReply, id?: string, error?: 'cancelled' | 'failed') {
  const query = new URLSearchParams();
  if (id) query.set('id', id);
  if (error) query.set('googleError', error);
  return reply.redirect(`${pairingPath}?${query}`);
}

export function registerGoogleAuthRoutes(app: FastifyInstance, options: {
  db: Pool;
  config?: GoogleAuthConfig | null;
  oidcConfiguration?: () => Promise<oidc.Configuration>;
  extensionOrigins?: string[];
}) {
  const {db} = options;
  const config = options.config === undefined ? googleAuthConfig() : options.config;
  const extensionOrigins = new Set((options.extensionOrigins ?? []).filter(origin => nativeOrigin.test(origin)));
  let configuration: Promise<oidc.Configuration> | null = null;
  const getConfiguration = options.oidcConfiguration ?? (() => {
    return configuration ??= createGoogleOidc(config!).catch(error => { configuration = null; throw error; });
  });
  const startLimits = new Map<string, {count: number; expiresAt: number}>();

  function allowStart(ip: string) {
    const now = Date.now();
    if (startLimits.size >= 4096) {
      for (const [key, entry] of startLimits) if (entry.expiresAt <= now) startLimits.delete(key);
      if (startLimits.size >= 4096 && !startLimits.has(ip)) return false;
    }
    const entry = startLimits.get(ip);
    if (!entry || entry.expiresAt <= now) {
      startLimits.set(ip, {count: 1, expiresAt: now + 60_000});
      return true;
    }
    return ++entry.count <= 20;
  }

  async function authorizationUrl(state: string, verifier: string, nonce: string, native = false) {
    return oidc.buildAuthorizationUrl(await getConfiguration(), {
      redirect_uri: config!.origin + callbackPath,
      scope: 'openid profile email',
      state,
      nonce,
      code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
      code_challenge_method: 'S256',
      ...(native ? {prompt: 'select_account'} : {}),
    });
  }

  app.get('/api/auth/google/status', {logLevel: 'silent'}, (_request, reply) => {
    privateResponse(reply);
    return {enabled: Boolean(config)};
  });

  app.post('/api/auth/google/start', {logLevel: 'silent', bodyLimit: 1024}, async (request, reply) => {
    privateResponse(reply);
    if (!config) return reply.code(503).send({error: 'Google sign-in is not configured.'});
    if (request.headers.origin !== config.origin) return reply.code(403).send({error: 'Request origin rejected.'});
    const input = pairingInput.safeParse(request.body);
    if (!input.success) return reply.code(400).send({error: 'Invalid extension connection.'});
    if (!allowStart(request.ip)) return reply.code(429).header('Retry-After', '60').send({error: 'Too many sign-in requests. Try again shortly.'});
    if (await resolveAuthUser(request, db)) return reply.code(409).send({error: 'You are already signed in to Kollens.'});

    const state = secret();
    const browser = secret();
    const verifier = oidc.randomPKCECodeVerifier();
    const nonce = oidc.randomNonce();
    const id = input.data.id.toLowerCase();
    const returnTo = `${pairingPath}?id=${id}`;
    // Serialize starts for this pairing so they cannot accumulate auth attempts.
    // Only an outstanding extension pairing can start this sign-in flow.
    const connection = await db.connect();
    try {
      await connection.query('BEGIN');
      const pairing = await connection.query<{expires_at: Date}>(`SELECT expires_at FROM extension_pairing_attempts
        WHERE id=$1 AND mode='web' AND expires_at>now() AND consumed_at IS NULL AND user_id IS NULL FOR UPDATE`, [id]);
      if (!pairing.rows[0]) {
        await connection.query('ROLLBACK');
        return reply.code(410).send({error: 'Connection expired. Start again from the extension.'});
      }
      await connection.query(`DELETE FROM auth_login_attempts WHERE purpose=$1 AND (expires_at<=now() OR return_to=$2)`, [purpose, returnTo]);
      await connection.query(`INSERT INTO auth_login_attempts
        (state_hash,browser_hash,code_verifier,nonce,return_to,purpose,expires_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7)`, [
        digest(state), digest(browser), verifier, nonce, returnTo, purpose, pairing.rows[0].expires_at,
      ]);
      await connection.query('COMMIT');
    } catch (error) {
      await connection.query('ROLLBACK');
      throw error;
    } finally { connection.release(); }

    try {
      const url = await authorizationUrl(state, verifier, nonce);
      reply.header('Set-Cookie', formatCookie(browserCookie, browser, attemptLifetime, config.secure));
      return {url: url.href};
    } catch {
      return reply.code(503).send({error: 'Google sign-in is temporarily unavailable.'});
    }
  });

  app.post('/api/extension/auth/google/start', {logLevel: 'silent', bodyLimit: 1024}, async (request, reply) => {
    privateResponse(reply);
    if (!config) return reply.code(503).send({error: 'Google sign-in is not configured.'});
    const origin = extensionRequestOrigin(request, extensionOrigins);
    if (!origin) return reply.code(403).send({error: 'Request origin rejected.'});
    reply.header('Access-Control-Allow-Origin', origin).header('Vary', 'Cookie, Origin');
    const input = nativeInput.safeParse(request.body);
    if (!input.success) return reply.code(400).send({error: 'Invalid extension connection.'});
    if (!allowStart(request.ip)) return reply.code(429).header('Retry-After', '60').send({error: 'Too many sign-in requests. Try again shortly.'});

    const id = input.data.id.toLowerCase();
    const state = 'n_' + secret();
    const ticket = secret();
    const returnTo = `${pairingPath}?id=${id}`;
    const connection = await db.connect();
    try {
      await connection.query('BEGIN');
      await connection.query('SELECT id FROM extension_pairing_attempts WHERE id=$1 AND mode=\'native\' FOR UPDATE', [id]);
      const pairing = await readExtensionNativePairing(connection, id, origin, input.data.verifier);
      if (!pairing) {
        await connection.query('ROLLBACK');
        return reply.code(410).send({error: 'Connection expired. Start again from the extension.'});
      }
      await connection.query(`DELETE FROM auth_login_attempts WHERE purpose=$1 AND (expires_at<=now() OR return_to=$2)`, [nativePurpose, returnTo]);
      // Before the bootstrap is visited, browser_hash holds the launch ticket hash.
      // The bootstrap spends it and replaces it with the fresh browser-cookie hash.
      await connection.query(`INSERT INTO auth_login_attempts
        (state_hash,browser_hash,code_verifier,nonce,return_to,purpose,expires_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7)`, [
        digest(state), digest(ticket), oidc.randomPKCECodeVerifier(), oidc.randomNonce(), returnTo, nativePurpose, pairing.expires_at,
      ]);
      await connection.query('COMMIT');
    } catch (error) {
      await connection.query('ROLLBACK');
      throw error;
    } finally { connection.release(); }
    return {url: config.origin + nativeLaunchPath + '?' + new URLSearchParams({state,ticket})};
  });

  app.get(nativeLaunchPath, {logLevel: 'silent'}, async (request, reply) => {
    privateResponse(reply);
    if (!config || request.url.length > 512) return nativeFailure(reply);
    const query = new URL(request.url, config.origin).searchParams;
    const states = query.getAll('state'), tickets = query.getAll('ticket');
    if (states.length !== 1 || tickets.length !== 1 || !nativeState.test(states[0]) || !opaqueSecret.test(tickets[0])) {
      return nativeFailure(reply);
    }
    const state = states[0], browser = secret();
    const {rows: [attempt]} = await db.query<{code_verifier: string; nonce: string}>(`UPDATE auth_login_attempts
      SET browser_hash=$1 WHERE state_hash=$2 AND browser_hash=$3 AND purpose=$4 AND expires_at>now()
      RETURNING code_verifier,nonce`, [digest(browser), digest(state), digest(tickets[0]), nativePurpose]);
    if (!attempt) return nativeFailure(reply);
    try {
      const url = await authorizationUrl(state, attempt.code_verifier, attempt.nonce, true);
      reply.header('Set-Cookie', formatCookie(nativeCookie(state), browser, attemptLifetime, config.secure, callbackPath));
      return reply.redirect(url.href);
    } catch { return nativeFailure(reply); }
  });

  app.get(callbackPath, {logLevel: 'silent'}, async (request, reply) => {
    privateResponse(reply);
    if (!config) return reply.code(503).send({error: 'Google sign-in is not configured.'});
    if (request.url.length > 8192) return pairingRedirect(reply, undefined, 'failed');
    const url = new URL(config.origin + callbackPath);
    url.search = request.url.split('?').slice(1).join('?');
    const states = url.searchParams.getAll('state');
    const native = states.some(state => nativeState.test(state));
    const state = states[0];
    if (states.length !== 1 || !(native ? nativeState : opaqueSecret).test(state)) {
      return native ? nativeFailure(reply) : pairingRedirect(reply, undefined, 'failed');
    }
    const cookie = native ? nativeCookie(state) : browserCookie;
    const browser = bindingCookie(request.headers.cookie, cookie);
    if (!browser) {
      if (native) return nativeFailure(reply);
      return pairingRedirect(reply, undefined, 'failed');
    }

    let id: string | undefined;
    let extensionOrigin: string | undefined;
    const fail = (error: 'cancelled' | 'failed' = 'failed') => {
      if (!native) return pairingRedirect(reply, id, error);
      return extensionOrigin ? nativeRedirect(reply, extensionOrigin, {error}) : nativeFailure(reply);
    };
    try {
      const {rows} = await db.query<{code_verifier: string; nonce: string; return_to: string}>(`DELETE FROM auth_login_attempts
        WHERE state_hash=$1 AND browser_hash=$2 AND purpose=$3 AND expires_at>now()
        RETURNING code_verifier,nonce,return_to`, [digest(state), digest(browser), native ? nativePurpose : purpose]);
      const attempt = rows[0];
      if (!attempt) return fail();
      reply.header('Set-Cookie', formatCookie(cookie, '', 0, config.secure, native ? callbackPath : '/'));
      const pairing = pairingInput.safeParse({id: attempt.return_to.slice(pairingPath.length + 4)});
      if (!pairing.success || attempt.return_to !== `${pairingPath}?id=${pairing.data.id}`) {
        return fail();
      }
      id = pairing.data.id;
      if (native) {
        const {rows: [pending]} = await db.query<{extension_origin: string}>(`SELECT extension_origin FROM extension_pairing_attempts
          WHERE id=$1 AND mode='native' AND expires_at>now() AND consumed_at IS NULL AND user_id IS NULL`, [id]);
        if (!pending || !extensionOrigins.has(pending.extension_origin)) return fail();
        extensionOrigin = pending.extension_origin;
      }
      if (url.searchParams.has('error')) {
        return fail(url.searchParams.get('error') === 'access_denied' ? 'cancelled' : 'failed');
      }
      if (!native && await resolveAuthUser(request, db)) return pairingRedirect(reply, id);

      const tokens = await oidc.authorizationCodeGrant(await getConfiguration(), url, {
        pkceCodeVerifier: attempt.code_verifier, expectedState: state, expectedNonce: attempt.nonce, idTokenExpected: true,
      });
      const claims = tokens.claims();
      if (!claims || claims.iss !== googleIssuer || typeof claims.sub !== 'string'
        || !/^[\x21-\x7e]{1,255}$/.test(claims.sub) || claims.exp <= Date.now() / 1000) {
        return fail();
      }
      const name = typeof claims.name === 'string' ? claims.name.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 120) : '';
      const email = claims.email_verified === true && typeof claims.email === 'string'
        && claims.email.length <= 254 && emailPattern.test(claims.email) ? claims.email : null;
      const proof = secret();
      const connection = await db.connect();
      try {
        await connection.query('BEGIN');
        const pairing = await connection.query(`SELECT id FROM extension_pairing_attempts
          WHERE id=$1 AND mode=$2 AND expires_at>now() AND consumed_at IS NULL AND user_id IS NULL
          AND ($3::text IS NULL OR extension_origin=$3) FOR UPDATE`, [id, native ? 'native' : 'web', extensionOrigin ?? null]);
        if (!pairing.rows[0]) {
          await connection.query('ROLLBACK');
          return fail();
        }
        const {rows: [user]} = await connection.query<{id: string}>(`INSERT INTO auth_users(id,issuer,subject,name,email)
          VALUES($1,$2,$3,$4,$5) ON CONFLICT(issuer,subject)
          DO UPDATE SET name=EXCLUDED.name,email=COALESCE(EXCLUDED.email,auth_users.email),updated_at=now() RETURNING id`,
        [randomUUID(), googleIssuer, claims.sub, name || 'Google user', email]);
        if (extensionOrigin) {
          await connection.query('UPDATE extension_pairing_attempts SET user_id=$2,completion_hash=$3 WHERE id=$1',
            [id, user.id, digest(proof)]);
        } else {
          await connection.query(`INSERT INTO auth_sessions(id,user_id,secret_hash,expires_at,purpose)
            VALUES($1,$2,$3,now()+interval '30 days','web')`, [randomUUID(), user.id, digest(proof)]);
        }
        await connection.query('COMMIT');
      } catch (error) {
        await connection.query('ROLLBACK');
        throw error;
      } finally { connection.release(); }
      if (extensionOrigin) return nativeRedirect(reply, extensionOrigin, {id, proof});
      reply.header('Set-Cookie', [formatCookie(browserCookie, '', 0, config.secure), formatCookie('bscan_auth', proof, sessionLifetime, config.secure)]);
      return pairingRedirect(reply, id);
    } catch {
      request.log.warn({event: 'google_extension_login_failed'}, 'Google sign-in did not complete');
      return fail();
    }
  });
}
