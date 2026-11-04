import {createHash, randomBytes, randomUUID} from 'node:crypto';
import type {FastifyInstance, FastifyReply} from 'fastify';
import * as oidc from 'openid-client';
import type {Pool} from 'pg';
import {z} from 'zod';
import {resolveAuthUser} from './telegramAuth.js';

export const googleIssuer = 'https://accounts.google.com';
const callbackPath = '/api/auth/google/callback';
const pairingPath = '/extension/connect';
const purpose = 'extension_google';
const browserCookie = 'bscan_google_login';
const sessionLifetime = 30 * 86_400;
const attemptLifetime = 600;
const opaqueSecret = /^[a-f0-9]{64}$/;
const pairingInput = z.object({id: z.string().uuid()}).strict();
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

function formatCookie(name: string, value: string, seconds: number, secure: boolean) {
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${seconds}${secure ? '; Secure' : ''}`;
}

function bindingCookie(header: string | undefined) {
  const prefix = browserCookie + '=';
  const values = (header ?? '').split(';').map(value => value.trim()).filter(value => value.startsWith(prefix));
  if (values.length !== 1) return null;
  const value = values[0].slice(prefix.length);
  return opaqueSecret.test(value) ? value : null;
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
}) {
  const {db} = options;
  const config = options.config === undefined ? googleAuthConfig() : options.config;
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
        WHERE id=$1 AND expires_at>now() AND consumed_at IS NULL AND user_id IS NULL FOR UPDATE`, [id]);
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
      const url = oidc.buildAuthorizationUrl(await getConfiguration(), {
        redirect_uri: config.origin + callbackPath,
        scope: 'openid profile',
        state,
        nonce,
        code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
        code_challenge_method: 'S256',
      });
      reply.header('Set-Cookie', formatCookie(browserCookie, browser, attemptLifetime, config.secure));
      return {url: url.href};
    } catch {
      return reply.code(503).send({error: 'Google sign-in is temporarily unavailable.'});
    }
  });

  app.get(callbackPath, {logLevel: 'silent'}, async (request, reply) => {
    privateResponse(reply);
    if (!config) return reply.code(503).send({error: 'Google sign-in is not configured.'});
    if (request.url.length > 8192) return pairingRedirect(reply, undefined, 'failed');
    const url = new URL(config.origin + callbackPath);
    url.search = request.url.split('?').slice(1).join('?');
    const states = url.searchParams.getAll('state');
    const browser = bindingCookie(request.headers.cookie);
    if (states.length !== 1 || !opaqueSecret.test(states[0]) || !browser) {
      return pairingRedirect(reply, undefined, 'failed');
    }

    let id: string | undefined;
    try {
      const {rows} = await db.query<{code_verifier: string; nonce: string; return_to: string}>(`DELETE FROM auth_login_attempts
        WHERE state_hash=$1 AND browser_hash=$2 AND purpose=$3 AND expires_at>now()
        RETURNING code_verifier,nonce,return_to`, [digest(states[0]), digest(browser), purpose]);
      const attempt = rows[0];
      if (!attempt) return pairingRedirect(reply, undefined, 'failed');
      reply.header('Set-Cookie', formatCookie(browserCookie, '', 0, config.secure));
      const pairing = pairingInput.safeParse({id: attempt.return_to.slice(pairingPath.length + 4)});
      if (!pairing.success || attempt.return_to !== `${pairingPath}?id=${pairing.data.id}`) {
        return pairingRedirect(reply, undefined, 'failed');
      }
      id = pairing.data.id;
      if (url.searchParams.has('error')) {
        return pairingRedirect(reply, id, url.searchParams.get('error') === 'access_denied' ? 'cancelled' : 'failed');
      }
      if (await resolveAuthUser(request, db)) return pairingRedirect(reply, id);

      const tokens = await oidc.authorizationCodeGrant(await getConfiguration(), url, {
        pkceCodeVerifier: attempt.code_verifier, expectedState: states[0], expectedNonce: attempt.nonce, idTokenExpected: true,
      });
      const claims = tokens.claims();
      if (!claims || claims.iss !== googleIssuer || typeof claims.sub !== 'string'
        || !/^[\x21-\x7e]{1,255}$/.test(claims.sub) || claims.exp <= Date.now() / 1000) {
        return pairingRedirect(reply, id, 'failed');
      }
      const name = typeof claims.name === 'string' ? claims.name.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 120) : '';
      const session = secret();
      const connection = await db.connect();
      try {
        await connection.query('BEGIN');
        const pairing = await connection.query(`SELECT id FROM extension_pairing_attempts
          WHERE id=$1 AND expires_at>now() AND consumed_at IS NULL AND user_id IS NULL FOR UPDATE`, [id]);
        if (!pairing.rows[0]) {
          await connection.query('ROLLBACK');
          return pairingRedirect(reply, id, 'failed');
        }
        const {rows: [user]} = await connection.query<{id: string}>(`INSERT INTO auth_users(id,issuer,subject,name)
          VALUES($1,$2,$3,$4) ON CONFLICT(issuer,subject)
          DO UPDATE SET name=EXCLUDED.name,updated_at=now() RETURNING id`, [randomUUID(), googleIssuer, claims.sub, name || 'Google user']);
        await connection.query(`INSERT INTO auth_sessions(id,user_id,secret_hash,expires_at,purpose)
          VALUES($1,$2,$3,now()+interval '30 days','web')`, [randomUUID(), user.id, digest(session)]);
        await connection.query('COMMIT');
      } catch (error) {
        await connection.query('ROLLBACK');
        throw error;
      } finally { connection.release(); }
      reply.header('Set-Cookie', [formatCookie(browserCookie, '', 0, config.secure), formatCookie('bscan_auth', session, sessionLifetime, config.secure)]);
      return pairingRedirect(reply, id);
    } catch {
      request.log.warn({event: 'google_extension_login_failed'}, 'Google sign-in did not complete');
      return pairingRedirect(reply, id, 'failed');
    }
  });
}
