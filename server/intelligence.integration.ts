// Runs only against an explicitly named disposable database. No live RPC requests.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import Fastify from 'fastify';
import { ZeroAddress } from 'ethers';
import { ensureSchema, pool, setState } from './db.js';
import { ensureSeeds } from './seeds.js';
import { ensureIntelligenceSchema } from './intelligenceSchema.js';
import { registerIntelligenceRoutes } from './intelligenceApi.js';
import { collectLaunches, collectPositions, collectSignals, recordLaunchRange, recordWalletTransfers, rollbackIntelligence } from './intelligenceWorker.js';
import { hashSecret } from './intelligenceApi.js';
import { defaultPreferences } from '../shared/intelligence.js';
import { flapInterface, fourInterface, FLAP_PORTAL, FOUR_HELPER, FOUR_MANAGERS, pairInterface } from './launchpad.js';
import { transferTopic } from './swap.js';
import { getTokenTranslation } from './tokenTranslation.js';

if (!/^\/bscan_intelligence_test(?:_\d+)?$/.test(new URL(process.env.DATABASE_URL || '').pathname)) throw new Error('Use a disposable bscan_intelligence_test database');
process.env.NODE_ENV = 'production';
process.env.PUBLIC_APP_URL = 'https://bscan.fun';
const token = `0x${'1'.repeat(40)}`, flapToken = `0x${'2'.repeat(40)}`, unsupported = `0x${'3'.repeat(40)}`, pair = `0x${'4'.repeat(40)}`;
const poolId = `0x${'5'.repeat(64)}`, outsider = `0x${'6'.repeat(40)}`, unit = 10n ** 36n;
const hash = (height: number) => `0x${height.toString(16).padStart(64, '0')}`;
let height = 108, curve = 40, fourGraduated = false, balanceFails = false, staleBlock = false, liquidity = 1000;
const balances = new Map<string, bigint>();
let translationCalls = 0;
const nativeFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(String(input));
  if (url.hostname === 'api.mymemory.translated.net') {
    translationCalls++;
    const source = url.searchParams.get('q');
    if (source === '失败名称') return new Response('', { status: 503 });
    return Response.json({ responseStatus: 200, responseData: { translatedText: source === '毛毯小象' ? 'Blanket elephant' : 'Panda' } });
  }
  if (url.hostname === 'api.dexscreener.com') return Response.json({ pairs: [{ chainId: 'bsc', pairAddress: poolId, baseToken: { address: flapToken }, quoteToken: { address: outsider }, liquidity: { usd: liquidity } }] });
  return nativeFetch(input, init);
};
const block = (number: number) => ({ number: `0x${number.toString(16)}`, hash: hash(number), timestamp: `0x${Math.floor(Date.now() / 1000 - (staleBlock ? 601 : 2)).toString(16)}` });
const flapLogs = [
  { address: FLAP_PORTAL, ...flapInterface.encodeEventLog(flapInterface.getEvent('LaunchedToDEX')!, [flapToken, pair, 100, 2]) },
  { address: FLAP_PORTAL, ...flapInterface.encodeEventLog(flapInterface.getEvent('FlapTokenCLPoolCreated')!, [flapToken, poolId, 1]) },
  { address: FLAP_PORTAL, ...flapInterface.encodeEventLog(flapInterface.getEvent('TokenMigratorSet')!, [flapToken, 3]) },
].map((log, index) => ({ ...log, transactionHash: hash(900), logIndex: `0x${index.toString(16)}`, blockNumber: '0x6e', blockHash: hash(110) }));
const rpc = createServer(async (request, response) => {
  let body = ''; for await (const chunk of request) body += chunk;
  const query = JSON.parse(body); let result: unknown;
  try {
    if (query.method === 'eth_getBlockByNumber') result = block(Number(BigInt(query.params[0])));
    else if (query.method === 'eth_getLogs') result = flapLogs;
    else if (query.method === 'eth_call') {
      const { to, data } = query.params[0]; const key = `0x${data.slice(-40)}`.toLowerCase();
      if (data.startsWith('0x70a08231')) {
        if (balanceFails && to === token) throw new Error('RPC check failed');
        result = `0x${(balances.get(`${key}:${to}`) || 0n).toString(16).padStart(64, '0')}`;
      } else if (to === FOUR_HELPER) result = fourInterface.encodeFunctionResult('getTokenInfo', [key === token ? 2 : 0, key === token ? FOUR_MANAGERS[1] : ZeroAddress, ZeroAddress, 0, 0, 0, 1725000000, 0, 0, curve, 100, fourGraduated && key === token]);
      else if (to === FLAP_PORTAL) {
        const method = data.slice(0, 10) === flapInterface.getFunction('getTokenV8Safe')!.selector ? 'getTokenV8Safe' : 'getTokenV7';
        const values: unknown[] = [key === flapToken ? 4 : 0, 0, 0, 0, 4, 0, 0, 0, 100, ZeroAddress, false, `0x${'0'.repeat(64)}`, 0];
        if (method === 'getTokenV8Safe') values.push(0);
        values.push(pair, 10n ** 18n, 0, 0); result = flapInterface.encodeFunctionResult(method, [values]);
      } else result = pairInterface.encodeFunctionResult('getPair', [ZeroAddress]);
    } else throw new Error('Unexpected RPC');
    response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ jsonrpc: '2.0', id: query.id, result }));
  } catch { response.end(JSON.stringify({ jsonrpc: '2.0', id: query.id, error: { code: -32000, message: 'Simulated failure' } })); }
});
await new Promise<void>(resolve => rpc.listen(0, '127.0.0.1', resolve));
process.env.BSC_RPC_HTTP = `http://127.0.0.1:${(rpc.address() as { port: number }).port}`;
const app = Fastify(); registerIntelligenceRoutes(app);
try {
  await ensureSchema(); await ensureSeeds();
  // Exercise retirement on an existing watchlist without losing its session or filters.
  await pool.query(`ALTER TABLE watch_sessions ADD COLUMN telegram_chat_id text,
    ADD COLUMN telegram_username text, ADD COLUMN telegram_connected_at timestamptz;
    CREATE TABLE telegram_links (id text PRIMARY KEY);
    CREATE TABLE telegram_updates (update_id bigint PRIMARY KEY);
    CREATE TABLE notification_deliveries (id text PRIMARY KEY);`);
  await pool.query(`INSERT INTO watch_sessions(id,secret_hash,expires_at,telegram_chat_id)
    VALUES('retirement-test',$1,now()+interval '1 year','12345')`, [hashSecret('retirement-test')]);
  await Promise.all([ensureIntelligenceSchema(pool), ensureIntelligenceSchema(pool)]);
  assert.equal((await pool.query(`SELECT id FROM watch_sessions WHERE id='retirement-test'`)).rowCount, 1);
  assert.equal((await pool.query(`SELECT column_name FROM information_schema.columns
    WHERE table_name='watch_sessions' AND column_name LIKE 'telegram_%'`)).rowCount, 0);
  assert.equal((await pool.query(`SELECT tablename FROM pg_tables WHERE schemaname='public'
    AND tablename IN ('telegram_links','telegram_updates','notification_deliveries')`)).rowCount, 0);
  await pool.query(`DELETE FROM watch_sessions WHERE id='retirement-test'`);
  for (const [method, url] of [['GET', '/api/telegram/status'], ['POST', '/api/telegram/link'],
    ['POST', '/api/telegram/confirm'], ['DELETE', '/api/telegram/link'], ['POST', '/api/telegram/webhook']] as const) {
    assert.equal((await app.inject({ method, url })).statusCode, 404);
  }
  assert.equal('telegram' in (await app.inject('/api/watchlist')).json(), false);
  const wallets = (await pool.query('SELECT address FROM kols WHERE is_tracked ORDER BY address LIMIT 3')).rows.map(row => row.address as string);
  for (const [address, symbol] of [[token, 'RADAR'], [flapToken, 'FLAP'], [unsupported, 'OTHER']]) await pool.query(`INSERT INTO tokens(address,symbol,name,decimals,is_meme,price_source,price_usd,total_supply_raw,supply_checked_at) VALUES($1,$2,$2,36,true,'onchain',0.001,$3,now())`, [address, symbol, (1000000000n * unit).toString()]);
  for (let number = 100; number <= 125; number++) await pool.query('INSERT INTO processed_blocks(block_number,block_hash) VALUES($1,$2)', [number, hash(number)]);
  const node = async (number: number) => { height = number; await setState('node', { blockNumber: height, blockHash: hash(height), headBlock: height + 6 }); };
  const insertTrade = async (id: number, wallet: string, side: string, number: number, minutesAgo = 0, live = true, asset = token) => {
    await pool.query(`INSERT INTO trades(id,tx_hash,wallet_address,token_address,side,block_number,block_hash,transaction_index,timestamp,source,observed_live,token_amount,quote_symbol,quote_amount,amount_usd) VALUES($1,$2,$3,$4,$5,$6,$7,0,$8,'node',$9,25,'BNB',0.1,50)`, [String(id), hash(1000 + id), wallet, asset, side, number, hash(number), new Date(Date.now() - minutesAgo * 60_000).toISOString(), live]);
  };
  await node(108);
  await insertTrade(1, wallets[0], 'buy', 101, 9, false); await insertTrade(2, wallets[0], 'buy', 102, 8, false);
  await insertTrade(3, wallets[1], 'buy', 103, 7, false); await insertTrade(4, wallets[2], 'buy', 104, 6, false); await insertTrade(5, wallets[0], 'sell', 105, 5, false);
  await insertTrade(30, wallets[2], 'buy', 101, 3, false, flapToken); await insertTrade(31, wallets[2], 'buy', 101, 3, false, unsupported);
  await pool.query('UPDATE tokens SET name=$1 WHERE address=ANY($2::text[])', ['毛毯小象', [token, flapToken]]);
  const translated = await Promise.all([getTokenTranslation(token), getTokenTranslation(flapToken)]);
  assert.ok(translated.every(item => item.englishName === 'Blanket elephant')); assert.equal(translationCalls, 1);
  assert.equal((await getTokenTranslation(token)).englishName, 'Blanket elephant'); assert.equal(translationCalls, 1);
  await pool.query('UPDATE tokens SET name=$1 WHERE address=$2', ['熊猫', token]);
  assert.equal((await getTokenTranslation(token)).englishName, 'Panda'); assert.equal(translationCalls, 2);
  await pool.query('UPDATE tokens SET name=$1 WHERE address=$2', ['失败名称', token]);
  assert.equal((await getTokenTranslation(token)).englishName, null); assert.equal(translationCalls, 3);
  await getTokenTranslation(token); assert.equal(translationCalls, 3);
  await pool.query('UPDATE token_translation_usage SET characters=5000');
  await pool.query('UPDATE tokens SET name=$1 WHERE address=$2', ['财富自由', token]);
  assert.equal((await getTokenTranslation(token)).englishName, null); assert.equal(translationCalls, 3);
  assert.equal((await getTokenTranslation(outsider)).sourceText, null);
  await pool.query('UPDATE tokens SET name=symbol WHERE address=ANY($1::text[])', [[token, flapToken]]);
  await pool.query('DELETE FROM token_translation_usage');
  await collectSignals();
  const historical = await pool.query('SELECT * FROM radar_signals');
  assert.equal(historical.rowCount, 3); assert.ok(historical.rows.every(row => !row.live));
  await collectSignals(); assert.equal((await pool.query('SELECT * FROM radar_signals')).rowCount, 3);
  const headers = { origin: 'https://bscan.fun' };
  const put = (cookie: string | undefined, payload: Record<string, unknown>) => app.inject({ method: 'PUT', url: '/api/watchlist', headers: { ...headers, ...(cookie ? { cookie } : {}) }, payload });
  const first = await put(undefined, { items: [{ kind: 'token', address: token }] }); assert.equal(first.statusCode, 200);
  const cookieA = String(first.headers['set-cookie']).split(';')[0]; assert.match(String(first.headers['set-cookie']), /HttpOnly; SameSite=Strict.*Secure/);
  const second = await put(undefined, { items: [{ kind: 'token', address: flapToken }] }); const cookieB = String(second.headers['set-cookie']).split(';')[0];
  assert.notEqual(cookieA, cookieB);
  assert.equal((await app.inject('/api/watchlist')).json().items.length, 0);
  assert.equal((await app.inject({ url: '/api/watchlist', headers: { cookie: cookieA } })).json().items[0].address, token);
  assert.equal((await app.inject({ url: '/api/watchlist', headers: { cookie: cookieB } })).json().items[0].address, flapToken);
  assert.equal((await app.inject({ method: 'PUT', url: '/api/watchlist', headers: { origin: 'https://attacker.invalid', cookie: cookieA }, payload: { items: [] } })).statusCode, 403);
  assert.equal((await put(cookieA, { preferences: { ...defaultPreferences, minBuyers: 11 } })).statusCode, 400);
  assert.equal((await put(cookieA, { items: [{ kind: 'kol', address: outsider }] })).statusCode, 400);
  const page1 = (await app.inject('/api/signals?limit=1')).json(), page2 = (await app.inject(`/api/signals?limit=1&cursor=${page1.nextCursor}`)).json();
  assert.notEqual(page1.items[0].id, page2.items[0].id); assert.equal((await app.inject('/api/signals?cursor=bad')).statusCode, 400);
  assert.equal((await app.inject({ url: '/api/signals?watched=1', headers: { cookie: cookieB } })).json().items.length, 0);
  await put(cookieB, { preferences: { ...defaultPreferences, windowMinutes: 30, minBuyers: 2, categories: ['clustered_buys'] } });
  await collectSignals();
  const custom = (await app.inject({ url: '/api/signals', headers: { cookie: cookieB } })).json();
  assert.ok(custom.items.length > 0); assert.ok(custom.items.every((row: { kind: string; minBuyers: number; windowMinutes: number }) => row.kind === 'clustered_buys' && row.minBuyers === 2 && row.windowMinutes === 30));
  assert.ok((await pool.query(`SELECT live FROM radar_signals WHERE window_minutes=30`)).rows.every(row => !row.live));
  const sessionA = (await pool.query('SELECT id FROM watch_sessions WHERE secret_hash=$1', [hashSecret(cookieA.split('=')[1])])).rows[0].id;
  await node(109); balances.set(`${wallets[0]}:${token}`, 100n * unit); await collectPositions();
  const position = async () => (await app.inject(`/api/kols/${wallets[0]}/positions?tokens=${token}`)).json().items[0];
  assert.equal((await position()).status, 'Holding');
  const movement = async (id: number, number: number, from: string, to: string, value: bigint, initiator: string) => {
    const log = { address: token, topics: [transferTopic, `0x${from.slice(2).padStart(64, '0')}`, `0x${to.slice(2).padStart(64, '0')}`], data: `0x${value.toString(16).padStart(64, '0')}`, transactionHash: hash(1000 + id), logIndex: '0x0' };
    await recordWalletTransfers({ hash: log.transactionHash, from: initiator }, { logs: [log] }, block(number), new Set(wallets));
  };
  await insertTrade(20, wallets[0], 'buy', 110); await movement(20, 110, pair, wallets[0], 25n * unit + 1n, wallets[0]); await movement(20, 110, pair, wallets[0], 25n * unit + 1n, wallets[0]);
  assert.equal((await pool.query('SELECT * FROM wallet_transfers')).rowCount, 1);
  balances.set(`${wallets[0]}:${token}`, 125n * unit + 1n); await node(110); await collectPositions();
  assert.equal((await position()).status, 'Added'); assert.equal((await position()).balance, `125.${'0'.repeat(35)}1`);
  await movement(21, 111, wallets[0], pair, 25n * unit, outsider); balances.set(`${wallets[0]}:${token}`, 100n * unit + 1n); await node(111); await collectPositions(); assert.equal((await position()).status, 'Transferred');
  await insertTrade(22, wallets[0], 'buy', 112); await movement(22, 112, pair, wallets[0], 10n * unit, wallets[0]); await movement(23, 112, wallets[0], pair, 5n * unit, outsider);
  balances.set(`${wallets[0]}:${token}`, 105n * unit + 1n); await node(112); await collectPositions(); assert.equal((await position()).status, 'Unknown');
  await insertTrade(24, wallets[0], 'sell', 113); await movement(24, 113, wallets[0], pair, 105n * unit + 1n, wallets[0]); balances.set(`${wallets[0]}:${token}`, 0n); await node(113); await collectPositions(); assert.equal((await position()).status, 'Exited');
  balanceFails = true; await pool.query(`UPDATE position_snapshots SET checked_at=now()-interval '61 seconds'`); await node(114); await collectPositions(); assert.equal((await position()).status, 'Unknown'); assert.equal((await position()).balance, null); balanceFails = false;
  await pool.query(`UPDATE position_snapshots SET error=false,status='Holding',checked_at=now()-interval '6 minutes' WHERE block_number=114`); assert.equal((await position()).status, 'Unknown');
  staleBlock = true; const snapshotCount = (await pool.query('SELECT COUNT(*) AS count FROM position_snapshots')).rows[0].count; await collectPositions(); assert.equal((await pool.query('SELECT COUNT(*) AS count FROM position_snapshots')).rows[0].count, snapshotCount); staleBlock = false;
  await recordLaunchRange(110, 114, Array.from({ length: 5 }, (_, i) => block(110 + i))); await collectLaunches();
  const launch = async (address: string) => (await app.inject(`/api/tokens/${address}/launch`)).json().launch;
  assert.equal((await launch(token)).stage, 'bonding'); assert.equal((await launch(flapToken)).stage, 'graduated'); assert.equal((await launch(flapToken)).poolId, poolId); assert.equal((await launch(flapToken)).poolAddress, null); assert.equal((await launch(flapToken)).launchedAt, null);
  assert.equal((await launch(unsupported)).stage, 'unavailable'); assert.equal((await pool.query(`SELECT * FROM radar_signals WHERE kind='graduated'`)).rowCount, 0);
  const baseline = (await launch(flapToken)).liquidityBaselineAt; assert.equal(Number((await launch(flapToken)).liquidityUsd), 1000);
  // A cold historical catalog must not starve an active, unfollowed bonding curve.
  const followers = (await pool.query(`DELETE FROM watch_entries WHERE kind='token' AND address=$1 RETURNING session_id`, [token])).rows;
  const coldTokens: string[] = [];
  for (let index = 0; index < 9; index++) {
    const address = `0x${(4000 + index).toString(16).padStart(40, '0')}`; coldTokens.push(address);
    await pool.query(`INSERT INTO tokens(address,symbol,decimals) VALUES($1,'COLD',18)`, [address]);
    await insertTrade(4000 + index, wallets[0], 'buy', 101, 60, false, address);
  }
  await pool.query(`UPDATE token_launches SET checked_at=now()-interval '61 seconds',liquidity_at=now()-interval '121 seconds'`); liquidity = 1500; curve = 90; await node(115); await collectLaunches();
  assert.equal((await launch(token)).stage, 'near_graduation'); assert.equal((await launch(flapToken)).liquidityBaselineAt, baseline); assert.equal(Number((await launch(flapToken)).liquidityBaselineUsd), 1000); assert.equal(Number((await launch(flapToken)).liquidityUsd), 1500);
  for (const follower of followers) await pool.query(`INSERT INTO watch_entries(session_id,kind,address) VALUES($1,'token',$2)`, [follower.session_id, token]);
  await pool.query('DELETE FROM trades WHERE token_address=ANY($1::text[])', [coldTokens]);
  await pool.query('DELETE FROM launch_observations WHERE token_address=ANY($1::text[])', [coldTokens]);
  await pool.query('DELETE FROM token_launches WHERE token_address=ANY($1::text[])', [coldTokens]);
  await pool.query('DELETE FROM tokens WHERE address=ANY($1::text[])', [coldTokens]);
  assert.equal((await pool.query(`SELECT * FROM radar_signals WHERE kind='near_graduation'`)).rowCount, 1);
  await pool.query(`UPDATE token_launches SET checked_at=now()-interval '61 seconds'`); await collectLaunches(); assert.equal((await pool.query(`SELECT * FROM radar_signals WHERE kind='near_graduation'`)).rowCount, 1);
  fourGraduated = true; await node(116); await pool.query(`UPDATE token_launches SET checked_at=now()-interval '61 seconds'`); await collectLaunches(); assert.equal((await launch(token)).stage, 'graduated'); assert.equal((await launch(token)).graduatedAt, null);
  const launches = (await app.inject('/api/launches?limit=1')).json(); assert.equal(launches.items.length, 1); assert.ok(launches.nextCursor);
  assert.notEqual((await app.inject(`/api/launches?limit=1&cursor=${launches.nextCursor}`)).json().items[0].tokenAddress, launches.items[0].tokenAddress);
  const client = await pool.connect(); try { await client.query('BEGIN'); await rollbackIntelligence(client, 110); await client.query('DELETE FROM trades WHERE block_number>=110'); await client.query('DELETE FROM processed_blocks WHERE block_number>=110'); await client.query('COMMIT'); } finally { client.release(); }
  assert.equal((await pool.query('SELECT * FROM wallet_transfers WHERE block_number>=110')).rowCount, 0); assert.equal((await pool.query('SELECT * FROM position_snapshots WHERE block_number>=110')).rowCount, 0); assert.equal((await pool.query('SELECT * FROM launch_events WHERE block_number>=110')).rowCount, 0);
  assert.ok((await pool.query('SELECT * FROM radar_signals WHERE source_block>=110')).rows.every(row => row.corrected));
  assert.equal((await launch(token)).stage, 'unavailable');
  await app.inject({ method: 'DELETE', url: '/api/watchlist', headers: { ...headers, cookie: cookieA } }); assert.equal((await pool.query('SELECT * FROM watch_sessions WHERE id=$1', [sessionA])).rowCount, 0);
  if (process.env.INTELLIGENCE_PREVIEW_FIXTURES === '1') {
    for (let number = 110; number <= 125; number++) await pool.query('INSERT INTO processed_blocks(block_number,block_hash) VALUES($1,$2) ON CONFLICT DO NOTHING', [number, hash(number)]);
    await node(125);
    for (let i = 0; i < 24; i++) {
      await pool.query(`INSERT INTO radar_signals(id,kind,entity,token_address,wallet_addresses,evidence,window_minutes,min_buyers,timestamp,source_block,source_hash,live)
        SELECT $1,'clustered_buys',token_address,token_address,$2,evidence,10,3,now()-$3*interval '1 minute',108,$4,false FROM radar_signals WHERE kind='clustered_buys' LIMIT 1`, [hashSecret(`preview${i}`), wallets, i, hash(108)]);
      const asset = `0x${(5000 + i).toString(16).padStart(40, '0')}`;
      await pool.query(`INSERT INTO tokens(address,symbol,name,decimals,is_meme,price_source,price_usd,total_supply_raw,supply_checked_at) VALUES($1,$2,$2,18,true,'onchain',$3,$4,now())`, [asset, `DEMO${i + 1}`, [0.05,0.5,5][i % 3], (1000000n * 10n ** 18n).toString()]);
      await insertTrade(100 + i, wallets[0], i % 2 ? 'buy' : 'sell', 108, i, false, asset);
      await insertTrade(200 + i, wallets[i % 3], i % 2 ? 'buy' : 'sell', 108, i, false, token);
      await pool.query(`INSERT INTO token_launches(token_address,platform,stage,progress,first_kol_at,checked_at,block_number,block_hash) VALUES($1,'fourmeme','bonding',$2,now()-$3*interval '1 minute',now(),125,$4)`, [asset, i * 4, i, hash(125)]);
    }
    await pool.query(`UPDATE token_launches SET platform='fourmeme',stage='near_graduation',progress=94,checked_at=now(),first_kol_at=now()-interval '10 minutes',launched_at=now()-interval '1 hour' WHERE token_address=$1`, [token]);
    for (const wallet of wallets) await pool.query(`INSERT INTO position_snapshots(wallet_address,token_address,block_number,block_hash,balance_raw,status,checked_at,block_timestamp) VALUES($1,$2,125,$3,$4,'Added',now(),now())`, [wallet, token, hash(125), (125n * unit + 1n).toString()]);
    console.log(`Preview fixtures: /token/${token}, /kol/${wallets[0]}`);
  }
  console.log('Intelligence integration checks passed: migrations, Telegram retirement, signals, sessions, positions, launches and reorgs.');
} finally { globalThis.fetch = nativeFetch; await app.close(); await new Promise<void>(resolve => rpc.close(() => resolve())); await pool.end(); }
