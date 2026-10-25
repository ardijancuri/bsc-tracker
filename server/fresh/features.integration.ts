/** Current-feature privacy fixtures only. Every database write is rolled back. */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { Pool } from 'pg';
import { ensureFreshSchema } from './schema.js';
import { registerFreshFeatures } from './features.js';
const url = new URL(process.env.DATABASE_URL ?? '');
if (!['127.0.0.1', 'localhost'].includes(url.hostname) || !url.pathname.includes('fresh')) throw new Error('Use an isolated local fresh database');
const db = new Pool({ connectionString: url.toString(), max: 2 }), client = await db.connect(), app = Fastify();
const addr = () => `0x${randomBytes(20).toString('hex')}`, hash = () => `0x${randomBytes(32).toString('hex')}`;
const wallets = [addr(), addr(), addr()], privateWallets = [addr(), addr(), addr()], token = addr(), privateToken = addr(), users = [randomUUID(), randomUUID()];
const now = Date.parse('2000-01-01T12:00:00Z'); let sequence = 0;
try {
  await ensureFreshSchema(db); await client.query('BEGIN');
  for (const wallet of [...wallets, ...privateWallets]) await client.query('INSERT INTO fresh.wallets(address,monitoring_from_block) VALUES($1,1)', [wallet]);
  for (const wallet of wallets) await client.query("INSERT INTO fresh.kols(wallet_address,display_name) VALUES($1,'Public creator')", [wallet]);
  for (const address of [token, privateToken]) {
    await client.query("INSERT INTO fresh.tokens(address,name,symbol,decimals,launch_status) VALUES($1,'Token','TEST',18,'eligible')", [address]);
    await client.query("INSERT INTO fresh.launch_facts(token_address,protocol,block_number,block_hash,tx_hash,log_index,launched_at,proof,status) VALUES($1,'fourmeme',1,$2,$3,0,$4,'{}','eligible')", [address, hash(), hash(), new Date(now - 3600_000)]);
  }
  for (const user of users) await client.query("INSERT INTO auth_users(id,issuer,subject,name) VALUES($1::uuid,'https://oauth.telegram.org',$1::text,'Fixture')", [user]);
  await client.query("INSERT INTO account_watch_entries(user_id,kind,address) VALUES($1,'kol',$2),($1,'token',$3),($4,'kol',$5)", [users[0], privateWallets[0], privateToken, users[1], wallets[0]]);
  await client.query("UPDATE fresh.checkpoints SET block_number=1000000 WHERE key='capture'");
  async function event(wallet: string, asset: string, side: 'buy' | 'sell', age: number, input: { live?: boolean; canonical?: boolean; block?: number } = {}) {
    const id = randomUUID(), number = input.block ?? ++sequence, blockHash = hash();
    await client.query(`INSERT INTO fresh.financial_events(id,execution_key,wallet_address,token_address,kind,quantity,amount_usd,fee_usd,block_number,block_hash,transaction_hash,
      transaction_index,execution_index,occurred_at,observed_live,canonical) VALUES($1,$2,$3,$4,$5,'1','10','0',$6,$7,$8,0,0,$9,$10,$11)`,
      [id, `feature:${id}`, wallet, asset, side, number, blockHash, hash(), new Date(now - age), input.live ?? true, input.canonical ?? true]);
  }
  for (let i = 0; i < 3; i++) { await event(wallets[i], token, 'buy', (6 - i) * 60_000); await event(privateWallets[i], privateToken, 'buy', (6 - i) * 60_000); }
  await event(wallets[0], token, 'buy', 3 * 60_000); await event(wallets[0], token, 'sell', 2 * 60_000);
  await event(wallets[0], token, 'buy', 60_000, { live: false }); await event(wallets[0], token, 'buy', 30_000, { canonical: false }); await event(wallets[0], token, 'buy', 1_000, { block: 1_000_001 });
  const fixtureDb = { query: (sql: string, values?: any[]) => client.query(sql, values) } as unknown as Pool;
  registerFreshFeatures(app, { db: fixtureDb, now: () => now, resolveUser: async request => request.headers['x-fixture-user'] ? { id: String(request.headers['x-fixture-user']) } as any : null });
  const result = await app.inject('/api/signals'); assert.equal(result.statusCode, 200); const signals = result.json().items; assert.ok(signals.length >= 3);
  assert.ok(signals.every((signal: any) => signal.tokenAddress === token && signal.walletAddresses.every((wallet: string) => wallets.includes(wallet))));
  assert.deepEqual(new Set(signals.map((signal: any) => signal.kind)), new Set(['clustered_buys', 'repeat_buy', 'buyer_selling']));
  assert.equal((await app.inject(`/api/signals?token=${privateToken}`)).json().items.length, 0);
  assert.equal((await app.inject(`/api/signals?kol=${privateWallets[0]}`)).json().items.length, 0);
  assert.equal((await app.inject({ url: '/api/signals?watched=1', headers: { 'x-fixture-user': users[0], 'x-watchlist-owner': users[0] } })).json().items.length, 0);
  assert.ok((await app.inject({ url: '/api/signals?watched=1', headers: { 'x-fixture-user': users[1], 'x-watchlist-owner': users[1] } })).json().items.length);
  assert.equal((await app.inject({ url: '/api/signals?watched=1', headers: { 'x-fixture-user': users[0], 'x-watchlist-owner': users[1] } })).statusCode, 409);
  const selected = (await app.inject(`/api/signals/${signals[0].id}`)).json().signal; assert.equal(selected.id, signals[0].id);
  assert.equal((await app.inject('/api/launches')).statusCode, 404);
  assert.equal((await app.inject(`/api/tokens/${token}/launch`)).statusCode, 404);
  assert.equal((await app.inject(`/api/tokens/${privateToken}/launch`)).statusCode, 404);
  console.log(JSON.stringify({ ok: true, checks: ['compact_current_signals', 'public_canonical_only', 'historical_and_unconfirmed_silence', 'private_token_wallet_isolation', 'watched_account_isolation', 'signal_detail', 'launch_feature_removed'], fixtureWrites: 'rolled back' }));
} finally { await app.close(); await client.query('ROLLBACK'); client.release(); await db.end(); }
