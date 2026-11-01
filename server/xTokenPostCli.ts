import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pool } from './db.js';
import { createXTokenPostCredentials, requestXOAuthToken, xTokenPostEncryptionKey } from './xTokenPostAuth.js';
import { createXTokenPostRuntime } from './xTokenPostRuntime.js';
import { createXTokenPostTransport } from './xTokenPostTransport.js';
import { ensureXTokenPostSchema } from './xTokenPostSchema.js';

const args = process.argv.slice(2), command = args[0] ?? 'status';
const value = (name: string) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
const output = (value: unknown) => console.log(JSON.stringify(value, null, 2));

async function connect() {
  const clientId = process.env.X_CLIENT_ID;
  if (!clientId) throw new Error('Configure server-only X_CLIENT_ID before connecting');
  xTokenPostEncryptionKey(process.env.X_TOKEN_POST_ENCRYPTION_KEY);
  const redirect = new URL(process.env.X_REDIRECT_URI ?? 'http://127.0.0.1:4387/callback');
  if (redirect.protocol !== 'http:' || redirect.hostname !== '127.0.0.1' || !redirect.port || redirect.username || redirect.password || redirect.search || redirect.hash) throw new Error('Operator callback must use a registered loopback HTTP URL');
  const verifier = randomBytes(32).toString('base64url'), state = randomBytes(32).toString('base64url');
  const authorize = new URL('https://x.com/i/oauth2/authorize');
  for (const [key, item] of Object.entries({ response_type: 'code', client_id: clientId, redirect_uri: redirect.href,
    scope: 'tweet.read tweet.write users.read media.write offline.access', state, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' })) authorize.searchParams.set(key, item);
  let consumed = false;
  const server = createServer();
  const code = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('x_connection_expired')), 600_000);
    server.on('request', (request, response) => {
      const url = new URL(request.url ?? '/', redirect.origin);
      if (consumed || request.method !== 'GET' || url.pathname !== redirect.pathname || url.searchParams.get('state') !== state) { response.writeHead(400).end('Invalid connection request.'); return; }
      consumed = true; clearTimeout(timer);
      const code = url.searchParams.get('code');
      response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }).end(code ? 'Kollens received the connection. Return to the operator terminal.' : 'X connection declined.');
      if (!code || code.length > 4096) reject(new Error('x_connection_declined')); else resolve(code);
    });
    server.once('error', error => { clearTimeout(timer); reject(error); });
  });
  void code.catch(() => undefined); // Binding can fail before the code promise is awaited.
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(Number(redirect.port), '127.0.0.1', resolve); });
    console.log('Authorize the Kollens publishing account in your browser:'); console.log(authorize.href);
    const credentials = await requestXOAuthToken({ clientId, clientSecret: process.env.X_CLIENT_SECRET,
      parameters: { grant_type: 'authorization_code', code: await code, redirect_uri: redirect.href, code_verifier: verifier } });
    const identity = await createXTokenPostTransport({ getAccessToken: async () => credentials.accessToken }).verifyAccount();
    await createXTokenPostCredentials(pool).save(identity, credentials);
    output({ connected: true, account: identity.username, publishingEnabled: false });
  } finally { server.close(); }
}

async function main() {
  if (!['init','verify','preview', 'dry-run', 'status', 'enable', 'pause', 'connect', 'reconcile'].includes(command)) throw new Error('Commands: init, verify, preview, dry-run, status, enable, pause, connect, reconcile');
  const asOf = value('--as-of'), offline = args.includes('--offline') || Boolean(asOf);
  let now: (() => number) | undefined;
  if (asOf) {
    const target = new URL(process.env.DATABASE_URL ?? ''), time = Date.parse(asOf);
    if (!['127.0.0.1','localhost'].includes(target.hostname) || !(target.port==='5439' && target.pathname==='/kollens_replay_gap_20261029'
      || target.port==='5436' && /^\/kollens_fresh_[a-z0-9_]+$/.test(target.pathname)
      || /^\/bscan_x_posts_test(?:_\d+)?$/.test(target.pathname))
      || !['preview', 'dry-run'].includes(command) || !Number.isFinite(time)) throw new Error('Historical preview clocks require the local test/clone database');
    now = () => time;
  }
  // Operator reads never initialize, reset or migrate the core trading schema.
  if(command==='init'||command==='connect'){
    const ready=(await pool.query("SELECT to_regclass('fresh.positions') IS NOT NULL AS ready")).rows[0]?.ready;
    if(!ready)throw new Error('Fresh trading schema required');
    await ensureXTokenPostSchema(pool);
    if(command==='init'){const state=await createXTokenPostRuntime(pool,{offline:true}).status();output({initialized:true,publishingEnabled:state.mode==='live'&&state.settings?.enabled===true});return;}
    await connect();return;
  }
  const runtime = createXTokenPostRuntime(pool, { now, offline });
  if (command === 'status') { output(await runtime.status()); return; }
  if(command==='verify'){
    const credentials=createXTokenPostCredentials(pool);
    const identity=await createXTokenPostTransport({getAccessToken:credentials.getAccessToken,refreshAccessToken:credentials.refreshAccessToken}).verifyAccount();
    const status=await runtime.status();
    output({verified:true,account:identity.username,connection:status.connection,publishingEnabled:status.mode==='live'&&status.settings?.enabled===true});return;
  }
  if (command === 'enable') { output(await runtime.enable()); return; }
  if (command === 'pause') { output(await runtime.pause()); return; }
  if (command === 'reconcile') { output({ inspected: await runtime.reconcileOne() }); return; }
  if (command === 'dry-run') {
    const collected = await runtime.collect({ force: true }); let prepared = 0;
    while (prepared < 12 && await runtime.prepareOne(true)) prepared++;
    output({ ...collected, prepared, published: 0 }); return;
  }
  const token = value('--token');
  if (token && !/^0x[0-9a-f]{40}$/i.test(token)) throw new Error('Invalid token address');
  const preview = await runtime.preview(token?.toLowerCase());
  const destination = path.resolve(value('--out') ?? '.cache/x-token-posts'); await mkdir(destination, { recursive: true });
  const items = [];
  for (const item of preview.items) {
    const prefix = path.join(destination, item.evidence.token.address);
    await writeFile(prefix + '.png', item.image);
    const { image, ...data } = item; await writeFile(prefix + '.json', JSON.stringify(data, null, 2) + '\n');
    items.push({ token: item.evidence.token.address, caption: item.caption, png: prefix + '.png', fallback: item.narrative.reason });
  }
  output({ items, reason: preview.reason, evaluatedAt: preview.evaluatedAt, published: 0 });
}

try { await main(); } catch { console.error('X operator command failed. Check local configuration and command arguments; publishing remains gated.'); process.exitCode = 1; }
finally { await pool.end(); }
