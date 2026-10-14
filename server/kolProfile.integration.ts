// Exercise the actual HTTP routes against an explicitly named, empty test database.
// Run with DATABASE_URL set directly; this runner never reads a local .env file.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

if (!process.env.DATABASE_URL || !/^\/bscan_intelligence_test(?:_\d+)?$/.test(new URL(process.env.DATABASE_URL).pathname)) {
  throw new Error('Use an empty disposable bscan_intelligence_test database');
}
const { pool } = await import('./db.js');
const wallet = '0x3391a39a1b508e54a361924a26056c01c1c2c07d'; // Rell remains tracked after ensureSeeds.
const address = (number: number) => `0x${number.toString(16).padStart(40, '0')}`;
const hash = (number: number) => `0x${number.toString(16).padStart(64, '0')}`;
type Asset = { address: string; symbol: string | null; name?: string };
const eligible: Asset[] = [
  { address: '0x409f0bcdc9a70565a71af56cb50b2a6688cb7777', symbol: 'BIBI' },
  { address: '0x1a9fd6ec3144da3dd6ea13ec1c25c58423a379b1', symbol: 'SPA' },
  { address: '0x25d887ce7a35172c62febfd67a1856f20faebb00', symbol: 'PEPE' },
  { address: address(1001), symbol: 'XAUt', name: 'Unrelated meme' },
  { address: address(1002), symbol: 'REWARD', name: 'Dividend Dog' },
  { address: address(1003), symbol: null },
  { address: address(1004), symbol: 'MEME' },
];
const excluded: Asset[] = [
  { address: '0x21caef8a43163eea865baee23b9c2e327696a3bf', symbol: null },
  { address: '0x7130d2a12b9bcbfae4f2634d864a1ee1ce3ead9c', symbol: 'RENAMED' },
  { address: '0x7ddef360f3c2db4cc41c3967984fefa2598cc9a6', symbol: 'xOPAI' },
  { address: '0xbe9d156892e55e7154bcd3cb0fea677f9d3103e1', symbol: 'MEME' },
  { address: address(2001), symbol: 'usdt' },
  { address: address(2002), symbol: 'POOL', name: 'Pancake LP' },
  { address: address(2003), symbol: 'AUX', name: 'ETHBack_Dividend_Tracker' },
];

// Block all provider HTTP calls in the child, including accidental calls caused by
// a missing eligibility guard. PostgreSQL uses its own socket transport.
const bootstrap = `
  import { MockAgent, setGlobalDispatcher } from 'undici';
  const dispatcher = new MockAgent(); dispatcher.disableNetConnect(); setGlobalDispatcher(dispatcher);
  globalThis.fetch = async () => { console.error('UNEXPECTED_PROVIDER_FETCH'); throw new Error('Provider HTTP disabled in profile integration'); };
  await import(${JSON.stringify(new URL('./index.ts', import.meta.url).href)});
`;
const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', bootstrap], {
  cwd: fileURLToPath(new URL('..', import.meta.url)), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  env: { ...process.env, PORT: '0', NODE_ENV: 'test', GMGN_API_KEY: '', GMGN_CHART_API_KEY: '',
    BSC_RPC_HTTP: 'http://127.0.0.1:1', BSC_HISTORICAL_RPC_HTTP: 'http://127.0.0.1:1', BSC_INVENTORY_ARCHIVE_RPC_HTTP: '' },
});
let log = '', providerFetches = 0;
const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
const ready = new Promise<string>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`API startup timed out: ${log}`)), 30_000);
  child.once('error', error => { clearTimeout(timer); reject(error); });
  child.once('exit', code => { clearTimeout(timer); reject(new Error(`API exited ${code}: ${log}`)); });
  child.stdout.on('data', chunk => {
    const text = String(chunk); log = (log + text).slice(-16_000);
    const url = log.match(/Server listening at (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
    if (url) { clearTimeout(timer); resolve(url); }
  });
  child.stderr.on('data', chunk => {
    const text = String(chunk); log = (log + text).slice(-16_000);
    providerFetches += text.split('UNEXPECTED_PROVIDER_FETCH').length - 1;
  });
});

try {
  const base = await ready;
  assert.equal((await pool.query('SELECT COUNT(*)::int AS count FROM trades')).rows[0].count, 0,
    'This runner requires a fresh database and will not overwrite existing fixtures');
  assert.equal((await pool.query('SELECT is_tracked FROM kols WHERE address=$1', [wallet])).rows[0]?.is_tracked, true);
  for (const asset of [...eligible, ...excluded]) await pool.query(
    'INSERT INTO tokens(address,symbol,name,decimals,is_meme) VALUES($1,$2,$3,18,true)',
    [asset.address, asset.symbol, asset.name ?? null]);

  const expectedTrades: { id: string; tokenAddress: string; side: string; timestamp: string }[] = [];
  const start = Date.now() - 60_000;
  let sequence = 0;
  for (let round = 0; round < 2; round++) for (let index = 0; index < eligible.length; index++) {
    for (const [asset, visible] of [[eligible[index], true], [excluded[index], false]] as const) {
      const number = ++sequence, side = round === 0 ? 'buy' : 'sell';
      const timestamp = new Date(start + number * 1000).toISOString(), id = `profile-${number}`;
      await pool.query(`INSERT INTO trades(id,tx_hash,wallet_address,token_address,side,token_amount,
        quote_symbol,quote_amount,amount_usd,block_number,block_hash,transaction_index,timestamp,source)
        VALUES($1,$2,$3,$4,$5,10,'BNB',0.1,50,$6,$7,0,$8,'node')`,
      [id, hash(number), wallet, asset.address, side, number, hash(1000 + number), timestamp]);
      if (visible) expectedTrades.unshift({ id, tokenAddress: asset.address, side, timestamp });
    }
  }
  // A reward disposal is the wallet's latest indexed activity, but must not be
  // reported as the profile's last visible trade.
  await pool.query('UPDATE kols SET last_seen_at=$2 WHERE address=$1', [wallet, new Date(start + sequence * 1000)]);
  const storedTrades = (await pool.query('SELECT COUNT(*)::int AS count FROM trades')).rows[0].count;
  const get = async (route: string, status = 200) => {
    const response = await fetch(`${base}${route}`, { signal: AbortSignal.timeout(10_000) });
    const body = await response.json();
    assert.equal(response.status, status, `${route}: ${JSON.stringify(body)}`);
    return body;
  };

  const profile = await get(`/api/kols/${wallet}`);
  const expectedTokens = [...eligible].reverse().map(asset => asset.address);
  assert.equal(profile.tokens.length, 6, 'Excluded assets cannot consume initial token slots');
  assert.deepEqual(profile.tokens.map((token: Asset) => token.address), expectedTokens.slice(0, 6));
  assert.ok(profile.tokensNextCursor);
  const moreTokens = await get(`/api/kols/${wallet}/tokens?cursor=${encodeURIComponent(profile.tokensNextCursor)}`);
  assert.deepEqual([...profile.tokens, ...moreTokens.items].map((token: Asset) => token.address), expectedTokens,
    'Token pagination has no hidden rows, duplicates or missing eligible assets');
  assert.equal(moreTokens.nextCursor, null);
  assert.deepEqual([profile.tradeCount24h, profile.buyCount24h, profile.sellCount24h, profile.unpricedSellCount24h], [14, 7, 7, 0]);
  assert.equal(Date.parse(profile.kol.lastSeenAt), Date.parse(expectedTrades[0].timestamp), 'Last trade ignores newer excluded activity');
  assert.equal(profile.trades.length, 10, 'Excluded assets cannot consume initial trade slots');
  assert.deepEqual(profile.trades.map((trade: { id: string }) => trade.id), expectedTrades.slice(0, 10).map(trade => trade.id));
  assert.ok(profile.tradesNextCursor);
  const moreTrades = await get(`/api/trades?kol=${wallet}&window=24h&limit=10&cursor=${encodeURIComponent(profile.tradesNextCursor)}`);
  assert.deepEqual([...profile.trades, ...moreTrades.items].map((trade: { id: string }) => trade.id), expectedTrades.map(trade => trade.id),
    'Trade pagination has no hidden rows, duplicates or missing eligible trades');
  assert.equal(moreTrades.nextCursor, null);

  for (const asset of excluded) {
    await get(`/api/kols/${wallet}/tokens/${asset.address}/activity?pnl=true&replay=true`, 404);
    await get(`/api/kols/${wallet}/tokens/${asset.address}/replay-chart?end=current`, 404);
  }
  assert.equal(providerFetches, 0, 'Hidden assets must not start inventory, P&L or chart provider work');
  assert.equal((await pool.query('SELECT COUNT(*)::int AS count FROM trades')).rows[0].count, storedTrades,
    'Display filtering preserves indexed transaction evidence');
  console.log('KOL profile integration passed: pagination, counts, last trade, provider guards, and retained history.');
} finally {
  if (child.exitCode === null) child.kill();
  await Promise.race([exited, new Promise<void>(resolve => setTimeout(resolve, 3000))]);
  if (child.exitCode === null) child.kill('SIGKILL');
  await pool.end();
}
