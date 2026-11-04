import {createHash, randomBytes} from 'node:crypto';
import type {FastifyInstance, FastifyReply, FastifyRequest} from 'fastify';
import * as oidc from 'openid-client';
import type {Pool} from 'pg';
import {z} from 'zod';

type ProviderName = 'telegram' | 'x';
type Profile = {subject: string; username: string | null};
export interface ExtensionSocialProvider {
  authorizationUrl(input: {callback: string; state: string; nonce: string; verifier: string}): Promise<URL>;
  identity(input: {callbackUrl: URL; state: string; nonce: string; verifier: string}): Promise<Profile>;
}
export type ExtensionSocialProviders = Partial<Record<ProviderName, ExtensionSocialProvider | null>>;
type Authenticate = (request: FastifyRequest, reply: FastifyReply) => Promise<{user: {id: string}; hash: string} | null>;
type Attempt = {
  expected_user_id: string; expected_session_hash: string; return_to: string;
  expires_at: Date; nonce: string; code_verifier: string; guest_snapshot: Profile | null;
};
const names = z.enum(['telegram','x']);
const opaque = z.string().regex(/^[a-f0-9]{64}$/);
const chromeOrigin = /^chrome-extension:\/\/([a-p]{32})$/;
const secret = () => randomBytes(32).toString('hex');
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const pathFor = (name: ProviderName) => `/api/auth/extension-social/${name}`;
const purposeFor = (name: ProviderName) => `extension_social_${name}`;
const cookieFor = (state: string) => `kollens_social_${state}`;

function setCookie(state: string, value: string, name: ProviderName, origin: string, age: number) {
  return `${cookieFor(state)}=${value}; Path=${pathFor(name)}/callback; HttpOnly; SameSite=Lax; Max-Age=${age}${origin.startsWith('https:') ? '; Secure' : ''}`;
}
function readCookie(header: string | undefined, state: string) {
  const prefix = `${cookieFor(state)}=`;
  const values = (header ?? '').split(';').map(value => value.trim()).filter(value => value.startsWith(prefix));
  return values.length === 1 && opaque.safeParse(values[0].slice(prefix.length)).success ? values[0].slice(prefix.length) : null;
}
function finishRedirect(reply: FastifyReply, origin: string, values: Record<string,string>) {
  const id = chromeOrigin.exec(origin)?.[1];
  if (!id) return reply.code(400).send({error: 'Invalid account link'});
  return reply.redirect(`https://${id}.chromiumapp.org/kollens#${new URLSearchParams(values)}`);
}
function privateHeaders(reply: FastifyReply) {
  reply.header('Cache-Control','no-store').header('Referrer-Policy','no-referrer');
}
function getSingle(url: URL, key: string) {
  const values = url.searchParams.getAll(key);
  return values.length === 1 && opaque.safeParse(values[0]).success ? values[0] : null;
}
function requestExtensionOrigin(req: FastifyRequest) {
  const value = req.headers.origin ?? req.headers['x-kollens-extension-origin'];
  return typeof value === 'string' && chromeOrigin.test(value) ? value : null;
}

export function registerExtensionSocial(app: FastifyInstance, db: Pool, origin: string, providers: ExtensionSocialProviders, authenticate: Authenticate) {
  for (const name of names.options) {
    const provider = providers[name];
    if (!provider) continue;
    const path = pathFor(name), purpose = purposeFor(name), callback = origin + path + '/callback';
    const expired = {error:'The account link expired. Start again.'};
    const startPath = `/api/extension/auth/social/${name}`;

    app.post(startPath + '/start', {logLevel:'silent',bodyLimit:1024}, async (req,reply) => {
      const auth = await authenticate(req,reply); if (!auth) return;
      const extensionOrigin = requestExtensionOrigin(req);
      if (!extensionOrigin) return reply.code(403).send({error:'Extension origin rejected'});
      const state = secret(), ticket = secret(), nonce = oidc.randomNonce(), verifier = oidc.randomPKCECodeVerifier();
      const client = await db.connect();
      try {
        await client.query('BEGIN');
        const session = await client.query(`SELECT id FROM auth_sessions WHERE secret_hash=$1 AND user_id=$2 AND purpose='extension' AND expires_at>now() FOR UPDATE`, [auth.hash,auth.user.id]);
        if (!session.rowCount) { await client.query('ROLLBACK'); return reply.code(401).send({error:'Extension session expired'}); }
        await client.query(`DELETE FROM auth_login_attempts WHERE purpose IN ($1,$2)
          AND (expires_at<=now() OR expected_session_hash=$3)`, [purpose,purpose+'_finish',auth.hash]);
        await client.query(`INSERT INTO auth_login_attempts (state_hash,browser_hash,code_verifier,nonce,return_to,purpose,expires_at,expected_user_id,expected_session_hash)
          VALUES($1,$2,$3,$4,$5,$6,now()+interval '10 minutes',$7,$8)`,
          [digest(state),digest(ticket),verifier,nonce,extensionOrigin,purpose,auth.user.id,auth.hash]);
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
      return {url: origin + path + '/launch?' + new URLSearchParams({state,ticket}), state};
    });

    app.get(path + '/launch', {logLevel:'silent'}, async (req,reply) => {
      privateHeaders(reply);
      const url = new URL(req.url,origin), state = getSingle(url,'state'), ticket = getSingle(url,'ticket');
      if (!state || !ticket) return reply.code(410).send(expired);
      const browser = secret();
      const {rows:[attempt]} = await db.query<Attempt>(`UPDATE auth_login_attempts SET browser_hash=$1 WHERE state_hash=$2 AND browser_hash=$3
        AND purpose=$4 AND expires_at>now() RETURNING code_verifier,nonce,return_to`, [digest(browser),digest(state),digest(ticket),purpose]);
      if (!attempt) return reply.code(410).send(expired);
      try {
        const destination = await provider.authorizationUrl({callback,state,nonce:attempt.nonce,verifier:attempt.code_verifier});
        reply.header('Set-Cookie',setCookie(state,browser,name,origin,600));
        return reply.redirect(destination.href);
      } catch {
        return finishRedirect(reply,attempt.return_to,{state,error:'failed'});
      }
    });

    app.get(path + '/callback', {logLevel:'silent'}, async (req,reply) => {
      privateHeaders(reply);
      if (req.url.length > 8192) return reply.code(400).send(expired);
      const url = new URL(callback);
      url.search = req.url.slice(req.url.indexOf('?') >= 0 ? req.url.indexOf('?') : req.url.length);
      const states = url.searchParams.getAll('state');
      const state = opaque.safeParse(states[0]).success && states.every(value => value === states[0]) ? states[0] : null;
      const browser = state && readCookie(req.headers.cookie,state);
      if (!state || !browser) return reply.code(410).send(expired);
      const {rows:[attempt]} = await db.query<Attempt>(`DELETE FROM auth_login_attempts WHERE state_hash=$1 AND browser_hash=$2
        AND purpose=$3 AND expires_at>now() RETURNING code_verifier,nonce,return_to,expected_user_id,expected_session_hash,expires_at`,
        [digest(state),digest(browser),purpose]);
      if (!attempt) return reply.code(410).send(expired);
      reply.header('Set-Cookie',setCookie(state,'',name,origin,0));
      if (url.searchParams.has('error')) return finishRedirect(reply,attempt.return_to,{state,error:'cancelled'});
      try {
        const profile = await provider.identity({callbackUrl:url,state,nonce:attempt.nonce,verifier:attempt.code_verifier});
        const proof = secret();
        await db.query(`INSERT INTO auth_login_attempts (state_hash,browser_hash,code_verifier,nonce,return_to,purpose,expires_at,expected_user_id,expected_session_hash,guest_snapshot)
          VALUES($1,$2,'','',$3,$4,$5,$6,$7,$8::jsonb)`,
          [digest(state),digest(proof),attempt.return_to,purpose+'_finish',attempt.expires_at,attempt.expected_user_id,attempt.expected_session_hash,JSON.stringify(profile)]);
        return finishRedirect(reply,attempt.return_to,{state,proof});
      } catch {
        return finishRedirect(reply,attempt.return_to,{state,error:'failed'});
      }
    });

    app.post(startPath + '/finish', {logLevel:'silent',bodyLimit:1024}, async (req,reply) => {
      const auth = await authenticate(req,reply); if (!auth) return;
      const input = z.object({state:opaque,proof:opaque}).strict().safeParse(req.body);
      if (!input.success) return reply.code(400).send(expired);
      const client = await db.connect();
      try {
        await client.query('BEGIN');
        const session = await client.query(`SELECT id FROM auth_sessions WHERE secret_hash=$1 AND user_id=$2 AND purpose='extension'
          AND expires_at>now() FOR UPDATE`,[auth.hash,auth.user.id]);
        if (!session.rowCount) { await client.query('ROLLBACK'); return reply.code(401).send({error:'Extension session expired'}); }
        const {rows:[attempt]} = await client.query<Attempt>(`DELETE FROM auth_login_attempts WHERE state_hash=$1 AND browser_hash=$2 AND purpose=$3
          AND expected_user_id=$4 AND expected_session_hash=$5 AND return_to=$6 AND expires_at>now() RETURNING guest_snapshot`,
          [digest(input.data.state),digest(input.data.proof),purpose+'_finish',auth.user.id,auth.hash,requestExtensionOrigin(req)]);
        const profile = attempt?.guest_snapshot;
        if (!profile) { await client.query('ROLLBACK'); return reply.code(410).send(expired); }
        if (name === 'telegram') {
          await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,782325))',[profile.subject]);
          const conflict = await client.query('SELECT 1 FROM auth_users WHERE (telegram_id=$1 AND id<>$2) OR (id=$2 AND telegram_id<>$1)',[profile.subject,auth.user.id]);
          if (conflict.rowCount) { await client.query('COMMIT'); return reply.code(409).send({error:'This account already has a link, or the profile is linked elsewhere.'}); }
        }
        const saved = await client.query(`INSERT INTO extension_account_links(user_id,provider,subject,username)
          VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING user_id`,[auth.user.id,name,profile.subject,profile.username]);
        await client.query('COMMIT');
        if (!saved.rowCount) return reply.code(409).send({error:'This account already has a link, or the profile is linked elsewhere.'});
        return {linked:true};
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    });
  }
}
