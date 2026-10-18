// Public-surface regression against the actual API entry point, on an empty disposable DB only.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { pool } from './db.js';

if (!/^\/bscan_intelligence_test(?:_\d+)?$/.test(new URL(process.env.DATABASE_URL || '').pathname)) throw new Error('Use a disposable bscan_intelligence_test database');
const publicWallet = '0xbf004bff64725914ee36d03b87d6965b0ced4903', privateWallet = `0x${'9'.repeat(40)}`;
const publicToken = `0x${'a'.repeat(40)}`, privateToken = `0x${'b'.repeat(40)}`;
const ownerId = randomUUID(), secret = randomBytes(32).toString('hex'), privateLabel = 'PRIVATE-LABEL-NEVER-PUBLIC';
const hash = (char: string) => `0x${char.repeat(64)}`;
const bootstrap = `
  import { MockAgent,setGlobalDispatcher } from 'undici';
  const dispatcher=new MockAgent();dispatcher.disableNetConnect();setGlobalDispatcher(dispatcher);
  globalThis.fetch=async()=>{throw new Error('Provider HTTP disabled in public identity integration');};
  await import(${JSON.stringify(new URL('./index.ts', import.meta.url).href)});
`;
const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', bootstrap], {
  cwd: fileURLToPath(new URL('..', import.meta.url)), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  env: { ...process.env, PORT: '0', NODE_ENV: 'test', TELEGRAM_BOT_TOKEN: '', TELEGRAM_WEBHOOK_SECRET: '',
    GMGN_API_KEY: '', GMGN_CHART_API_KEY: '', GMGN_ACCOUNTING_API_KEY: '', BSC_RPC_HTTP: 'http://127.0.0.1:1',
    BSC_HISTORICAL_RPC_HTTP: 'http://127.0.0.1:1', BSC_INVENTORY_ARCHIVE_RPC_HTTP: '' },
});
let log = '';
const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
const ready = new Promise<string>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`API startup timed out: ${log}`)), 30000);
  child.once('error', error => { clearTimeout(timer); reject(error); });
  child.once('exit', code => { clearTimeout(timer); reject(new Error(`API exited ${code}: ${log}`)); });
  child.stdout.on('data', chunk => { log = (log + String(chunk)).slice(-12000); const url = log.match(/Server listening at (http:\/\/127\.0\.0\.1:\d+)/)?.[1]; if (url) { clearTimeout(timer); resolve(url); } });
  child.stderr.on('data', chunk => { log = (log + String(chunk)).slice(-12000); });
});
try {
  const base = await ready;
  assert.equal((await pool.query('SELECT COUNT(*)::int AS count FROM trades')).rows[0].count, 0, 'This integration requires an empty database');
  await pool.query(`INSERT INTO auth_users(id,issuer,subject,name) VALUES($1,'https://oauth.telegram.org','public-identity-test','Test owner')`, [ownerId]);
  await pool.query(`INSERT INTO auth_sessions(id,user_id,secret_hash,expires_at) VALUES($1,$2,$3,now()+interval '1 day')`, [randomUUID(), ownerId, createHash('sha256').update(secret).digest('hex')]);
  await pool.query(`INSERT INTO creator_claims(wallet_address,user_id,proof_chain_id,proof_block_number,proof_kind) VALUES($1,$2,56,100,'eoa')`, [publicWallet, ownerId]);
  await pool.query(`INSERT INTO creator_profiles(wallet_address,display_name,bio,website_url,x_url,telegram_url,avatar_hash,avatar_data)
    VALUES($1,'Published creator identity','Public creator bio','https://example.com','https://x.com/published','https://t.me/published','testavatar',$2)`, [publicWallet, Buffer.from('public-fixture-avatar')]);
  await pool.query(`INSERT INTO kols(address,is_tracked) VALUES($1,false)`, [privateWallet]);
  await pool.query(`INSERT INTO journal_wallets(user_id,wallet_address,label,revision) VALUES($1,$2,$3,$4)`, [ownerId, privateWallet, privateLabel, randomUUID()]);
  await pool.query(`INSERT INTO tokens(address,symbol,name,decimals,is_meme,price_usd,price_source,metadata_updated_at)
    VALUES($1,'PUBLIC','Public token',18,true,1,'onchain',now()),($2,'PRIVATEONLY','Private-only token',18,true,1,'onchain',now())`, [publicToken, privateToken]);
  for (const [index, wallet, token] of [[0, publicWallet, publicToken], [1, privateWallet, publicToken], [2, privateWallet, privateToken]] as const) {
    await pool.query(`INSERT INTO trades(id,tx_hash,wallet_address,token_address,side,token_amount,quote_symbol,quote_amount,amount_usd,price_usd,block_number,block_hash,transaction_index,timestamp,source,observed_live)
      VALUES($1,$2,$3,$4,'buy',100,'BNB',0.1,100,1,$5,$6,0,now()-interval '1 minute','node',true)`, [`identity-trade-${index}`, hash(String(index + 1)), wallet, token, 100 + index, hash('f')]);
  }
  await pool.query(`INSERT INTO account_watch_entries(user_id,kind,address) VALUES($1,'kol',$2)`, [ownerId, publicWallet]);
  // Defense in depth: even a stale mixed/private signal must never expose private participation.
  for (const [id, wallets] of [[hash('a').slice(2), [publicWallet]], [hash('b').slice(2), [privateWallet]], [hash('c').slice(2), [publicWallet, privateWallet]]] as const) {
    await pool.query(`INSERT INTO radar_signals(id,kind,entity,token_address,wallet_addresses,evidence,window_minutes,min_buyers,timestamp,source_block,source_hash)
      VALUES($1,'repeat_buy',$1,$2,$3,$4::jsonb,0,0,now(),100,$5)`, [id, publicToken, wallets, JSON.stringify({ wallets }), hash('f')]);
  }
  async function get(path: string, authenticated = false) {
    const response = await fetch(base + path, { signal: AbortSignal.timeout(10000), ...(authenticated ? { headers: { Cookie: `bscan_auth=${secret}`, 'X-Watchlist-Owner': ownerId } } : {}) });
    assert.ok(response.ok, `${path}: ${response.status} ${await response.clone().text()}`);
    const body = await response.json();
    const serialized = JSON.stringify(body);
    assert.ok(!serialized.includes(privateWallet), `${path} leaked a private wallet`);
    assert.ok(!serialized.includes(privateLabel), `${path} leaked a private label`);
    assert.ok(!serialized.includes(ownerId), `${path} leaked a creator account ID`);
    return body;
  }
  const profile = await get(`/api/kols/${publicWallet}`);
  assert.equal(profile.kol.name, 'Published creator identity'); assert.equal(profile.kol.creator.claimed, true);
  assert.equal(profile.kol.creator.bio, 'Public creator bio'); assert.ok(profile.kol.avatarUrl.includes('/creator/avatar'));
  assert.equal(profile.trades[0].kolName, 'Published creator identity');
  const trades = await get('/api/trades'); assert.equal(trades.items.length, 1); assert.equal(trades.items[0].kolName, 'Published creator identity');
  const token = await get(`/api/tokens/${publicToken}`); assert.equal(token.trades.length, 1); assert.equal(token.kols[0].name, 'Published creator identity');
  const leaderboard = await get('/api/leaderboard'); assert.equal(leaderboard.items.find((row: { address: string }) => row.address === publicWallet).name, 'Published creator identity');
  const search = await get('/api/search?q=Published%20creator'); assert.equal(search.kols[0].name, 'Published creator identity');
  const favorites = await get('/api/watchlist', true); assert.equal(favorites.items.find((row: { kind: string }) => row.kind === 'kol').name, 'Published creator identity');
  const signals = await get('/api/signals'); assert.equal(signals.items.length, 1); assert.equal(signals.items[0].kols[0].name, 'Published creator identity');
  assert.equal((await get(`/api/signals/${'b'.repeat(64)}`)).signal, null);
  assert.equal((await get(`/api/signals/${'c'.repeat(64)}`)).signal, null);
  const overview = await get('/api/overview'); assert.equal(overview.trades24h, 1);
  assert.equal((await get(`/api/kols/${privateWallet}`)).kol, null);
  assert.equal((await get(`/api/tokens/${privateToken}`)).token, null);
  assert.equal((await get(`/api/kols/${privateWallet}/positions`)).items.length, 0);
  assert.equal((await get('/api/search?q=PRIVATEONLY')).tokens.length, 0);
  console.log('Public creator identity/private collection integration passed across profile, feeds, token page, leaderboard, search, favorites, counts, positions and signals.');
} finally { child.kill(); await exited; await pool.end(); }
