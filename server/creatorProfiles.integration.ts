// This runner deliberately never reads .env. A dedicated disposable database is mandatory.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { AbiCoder, Wallet } from 'ethers';
import sharp from 'sharp';
import { ensureSchema, pool } from './db.js';
import { ensureCreatorSchema } from './creatorSchema.js';
import { creatorSessionHash } from './creatorProfiles.js';
import { registerCreatorRoutes } from './creatorApi.js';
import { ensureSeeds } from './seeds.js';
import type { CreatorChallenge } from '../shared/creatorProfiles.js';
import type { Rpc } from './rpc.js';

if (!/^\/bscan_auth_test(?:_\d+)?$/.test(new URL(process.env.DATABASE_URL || '').pathname)) throw new Error('Use a disposable bscan_auth_test database');
const origin = 'https://kollens.com', app = Fastify({ logger: false });
const contracts = new Set<string>();
const rpc: Rpc = async <T>(method: string, params: unknown[]) => {
  const value = method === 'eth_chainId' ? '0x38' : method === 'eth_blockNumber' ? '0x100' : method === 'eth_getCode'
    ? contracts.has(String(params[0])) ? '0x6000' : '0x' : method === 'eth_call' ? AbiCoder.defaultAbiCoder().encode(['bytes4'], ['0x1626ba7e']) : undefined;
  if (!value) throw new Error('Unexpected RPC'); return value as T;
};
registerCreatorRoutes(app, { origin, rpc });
type Account = { id: string; cookie: string; secret: string };
async function account(name: string): Promise<Account> {
  const id = randomUUID(), secret = randomBytes(32).toString('hex');
  await pool.query(`INSERT INTO auth_users(id,issuer,subject,name) VALUES($1,'https://oauth.telegram.org',$2,$2)`, [id, name]);
  await pool.query(`INSERT INTO auth_sessions(id,user_id,secret_hash,expires_at) VALUES($1,$2,$3,now()+interval '1 day')`, [randomUUID(), id, creatorSessionHash(secret)]);
  return { id, secret, cookie: `bscan_auth=${secret}` };
}
const send = (method: 'GET' | 'POST' | 'PATCH', url: string, user?: Account, payload?: Record<string, unknown>, requestOrigin = origin) => app.inject({ method, url,
  headers: { origin: requestOrigin, ...(user ? { cookie: user.cookie, 'x-watchlist-owner': user.id } : {}) }, payload });
type TestWallet = { address: string; signMessage(message: string): Promise<string> };
async function addWallet(wallet: TestWallet) {
  await pool.query(`INSERT INTO kols(address,display_name,is_tracked) VALUES($1,'Seed name',true)`, [wallet.address.toLowerCase()]);
}
async function challenge(wallet: string, user: Account, action: 'claim' | 'release' = 'claim') {
  const response = await send('POST', `/api/kols/${wallet}/creator/challenge`, user, { action, chainId: 56 });
  assert.equal(response.statusCode, 200, response.body); return response.json() as CreatorChallenge;
}
async function claim(wallet: TestWallet, user: Account) {
  const proof = await challenge(wallet.address, user);
  const response = await send('POST', `/api/kols/${wallet.address}/creator/claim`, user, { challengeId: proof.challengeId, signature: await wallet.signMessage(proof.message) });
  assert.equal(response.statusCode, 200, response.body); return proof;
}
try {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await ensureSchema(); await ensureCreatorSchema(pool);
  await Promise.all([ensureCreatorSchema(pool), ensureCreatorSchema(pool)]);
  const alice = await account('creator-a'), bob = await account('creator-b');
  const wallet = Wallet.createRandom(); await addWallet(wallet);
  const path = `/api/kols/${wallet.address}/creator`;
  assert.equal((await send('POST', `${path}/challenge`, undefined, { action: 'claim', chainId: 56 })).statusCode, 401);
  assert.equal((await send('POST', `${path}/challenge`, alice, { action: 'claim', chainId: 1 })).statusCode, 400);
  assert.equal((await send('POST', `${path}/challenge`, alice, { action: 'claim', chainId: 56 }, 'https://evil.test')).statusCode, 403);
  const proof = await challenge(wallet.address, alice);
  const signed = { challengeId: proof.challengeId, signature: await wallet.signMessage(proof.message) };
  assert.equal((await send('POST', `${path}/claim`, bob, signed)).statusCode, 409, 'A proof cannot switch Telegram accounts');
  const anotherSession = { ...alice, secret: randomBytes(32).toString('hex'), cookie: '' }; anotherSession.cookie = `bscan_auth=${anotherSession.secret}`;
  await pool.query(`INSERT INTO auth_sessions(id,user_id,secret_hash,expires_at) VALUES($1,$2,$3,now()+interval '1 day')`, [randomUUID(), alice.id, creatorSessionHash(anotherSession.secret)]);
  assert.equal((await send('POST', `${path}/claim`, anotherSession, signed)).statusCode, 409, 'A proof is bound to the original browser session');
  const wrongSignature = await Wallet.createRandom().signMessage(proof.message);
  assert.equal((await send('POST', `${path}/claim`, alice, { ...signed, signature: wrongSignature })).statusCode, 400);
  const success = await send('POST', `${path}/claim`, alice, signed);
  assert.equal(success.statusCode, 200, success.body);
  assert.equal(success.json().canEdit, true);
  assert.equal((await send('POST', `${path}/claim`, alice, signed)).statusCode, 409, 'Proof is single use');
  assert.equal((await send('POST', `${path}/challenge`, bob, { action: 'claim', chainId: 56 })).statusCode, 409, 'Existing ownership cannot be overwritten');
  assert.equal((await send('PATCH', path, bob, { displayName: 'Unauthorized' })).statusCode, 403);
  const updated = await send('PATCH', path, alice, { displayName: 'Published creator', bio: 'A public bio', websiteUrl: 'https://example.com', xUrl: 'https://x.com/creator', telegramUrl: 'https://t.me/creator' });
  assert.equal(updated.statusCode, 200, updated.body);
  const source = await sharp({ create: { width: 600, height: 400, channels: 3, background: '#ffcc00' } }).png().toBuffer();
  assert.equal((await send('POST', `${path}/avatar`, alice, { mime: 'image/png', data: source.toString('base64') })).statusCode, 200);
  const avatar = await send('GET', `${path}/avatar`); assert.equal(avatar.statusCode, 200);
  assert.equal((await sharp(avatar.rawPayload).metadata()).width, 512);
  const publicStatus = (await send('GET', path)).json();
  assert.equal(publicStatus.claimed, true); assert.equal(publicStatus.canEdit, false);
  assert.ok(!JSON.stringify(publicStatus).includes(alice.id));
  const published = (await pool.query('SELECT * FROM published_kols WHERE address=$1', [wallet.address.toLowerCase()])).rows[0];
  assert.equal(published.display_name, 'Published creator'); assert.equal(published.twitter, 'creator');
  assert.ok(!Object.keys(published).some(key => ['user_id', 'owner_id', 'session_hash'].includes(key)));
  await pool.query(`UPDATE kols SET display_name='Refreshed seed',avatar_url='https://seed.test/avatar',twitter='seed' WHERE address=$1`, [wallet.address.toLowerCase()]);
  assert.equal((await pool.query('SELECT display_name FROM published_kols WHERE address=$1', [wallet.address.toLowerCase()])).rows[0].display_name, 'Published creator');
  const release = await challenge(wallet.address, alice, 'release');
  assert.equal((await send('POST', `${path}/release`, alice, { challengeId: release.challengeId, signature: await wallet.signMessage(release.message) })).statusCode, 200);
  assert.equal((await send('GET', path)).json().claimed, false);
  assert.equal((await send('GET', `${path}/avatar`)).statusCode, 404);
  assert.equal((await pool.query('SELECT display_name FROM published_kols WHERE address=$1', [wallet.address.toLowerCase()])).rows[0].display_name, 'Refreshed seed');

  const expiredWallet = Wallet.createRandom(); await addWallet(expiredWallet);
  const expired = await challenge(expiredWallet.address, bob);
  await pool.query(`UPDATE creator_challenges SET issued_at=now()-interval '20 minutes',expires_at=now()-interval '10 minutes' WHERE id=$1`, [expired.challengeId]);
  assert.equal((await send('POST', `/api/kols/${expiredWallet.address}/creator/claim`, bob, { challengeId: expired.challengeId, signature: await expiredWallet.signMessage(expired.message) })).statusCode, 409);

  const racingWallet = Wallet.createRandom(); await addWallet(racingWallet);
  const [first, second] = await Promise.all([challenge(racingWallet.address, alice), challenge(racingWallet.address, bob)]);
  const raced = await Promise.all([[alice, first], [bob, second]].map(async ([user, item]) => {
    const proof = item as CreatorChallenge;
    return send('POST', `/api/kols/${racingWallet.address}/creator/claim`, user as Account, { challengeId: proof.challengeId, signature: await racingWallet.signMessage(proof.message) });
  }));
  assert.deepEqual(raced.map(response => response.statusCode).sort(), [200, 409]);
  assert.equal((await pool.query('SELECT COUNT(*)::int AS count FROM creator_claims WHERE wallet_address=$1', [racingWallet.address.toLowerCase()])).rows[0].count, 1);
  // A real roster refresh keeps a separate creator's customization intact.
  await ensureSeeds();
  const afeng = '0xbf004bff64725914ee36d03b87d6965b0ced4903'; contracts.add(afeng);
  const smart = await challenge(afeng, bob);
  assert.equal((await send('POST', `/api/kols/${afeng}/creator/claim`, bob, { challengeId: smart.challengeId, signature: '0xabcd' })).statusCode, 200);
  assert.equal((await send('PATCH', `/api/kols/${afeng}/creator`, bob, { displayName: 'Creator survives roster refresh' })).statusCode, 200);
  await ensureSeeds();
  assert.equal((await pool.query('SELECT display_name FROM published_kols WHERE address=$1', [afeng])).rows[0].display_name, 'Creator survives roster refresh');
  assert.equal((await pool.query('SELECT proof_kind FROM creator_claims WHERE wallet_address=$1', [afeng])).rows[0].proof_kind, 'erc1271');
  console.log('Creator profile integration passed: auth isolation, single-use proof, origin/chain/session checks, concurrent claims, avatar, release and roster survival.');
} finally { await app.close(); await pool.end(); }
