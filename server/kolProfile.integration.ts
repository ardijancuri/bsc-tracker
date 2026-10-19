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
  { address: '0x24b518b332543a4e1c3649d063dab199d103760a', symbol: null },
  { address: '0xce7de646e7208a4ef112cb6ed5038fa6cc6b12e3', symbol: 'RENAMED' },
  { address: '0x1ba42e5193dfa8b03d15dd1b86a3113bbbef8eeb', symbol: 'ZEC' },
  { address: '0xce24439f2d9c6a2289f741120fe202248b666666', symbol: null },
  { address: '0x000ae314e2a2172a039b26378814c252734f556a', symbol: null },
  { address: '0x85eac5ac2f758618dfa09bdbe0cf174e7d574d5b', symbol: 'TRX' },
  { address: '0x4b0f1812e5df2a09796481ff14017e6005508003', symbol: null },
  { address: '0x570a5d26f7765ecb712c0924e4de545b89fd43df', symbol: 'SOL' },
  { address: '0xbf5140a22578168fd562dccf235e5d43a02ce9b1', symbol: 'UNI' },
  { address: '0xfceb31a79f71ac9cbdcf853519c1b12d379edc46', symbol: 'LISTA' },
  { address: '0x0782b6d8c4551b9760e74c0545a9bcd90bdc41e5', symbol: 'lisUSD' },
  { address: '0x1d2f0da169ceb9fc7b3144628db156f3f6c60dbe', symbol: 'XRP' },
  { address: '0x23396cf899ca06c4472205fc903bdb4de249d6fc', symbol: 'UST' },
  { address: '0x7083609fce4d1d8dc0c979aab8c869ea2c873402', symbol: 'DOT' },
  { address: '0x4338665cbb7b2485a8855a139b75d5e34ab0db94', symbol: 'LTC' },
  { address: '0xb0b84d294e0c75a6abe60171b70edeb2efd14a1b', symbol: 'slisBNB' },
  { address: '0x1fa4a73a3f0133f0025378af00236f3abdee5d63', symbol: 'NEAR' },
  { address: '0xfb6115445bff7b52feb98650c87f44907e58f802', symbol: 'AAVE' },
  { address: '0x2f8a339b5889ffac4c5a956787cda593b3c36867', symbol: 'CMC20' },
  { address: '0x1d80392d12caaaf9e333bb0bb7f021eacf297fe6', symbol: 'pPOLY' },
  { address: '0xe0cbb7ffc0883810569d84d78f02bbcb747cfe43', symbol: 'xKLSH' },
  { address: '0x41333df9e7639188bbfca5522dc4844398af9f9e', symbol: null },
  { address: '0x4ebf5fd25b02022afad96e2fa25da54a246fded0', symbol: 'wPOPMTx' },
  { address: '0x076cf393e701839fc7a5832d2c68aafa235682ae', symbol: 'wXIAOx' },
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
  env: { ...process.env, PORT: '0', NODE_ENV: 'test', GMGN_API_KEY: '', GMGN_CHART_API_KEY: '', GMGN_ACCOUNTING_API_KEY: '',
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
  const start = Date.now() - ((eligible.length + excluded.length) * 2 + 10) * 1000;
  let sequence = 0;
  for (let round = 0; round < 2; round++) for (let index = 0; index < Math.max(eligible.length, excluded.length); index++) {
    for (const [asset, visible] of [[eligible[index], true], [excluded[index], false]] as const) {
      if (!asset) continue;
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
  // Verified historical imports can contain a token whose trades predate the
  // canonical index. It must appear without fabricating a public trade row.
  const recovered=address(20000),recoveredAt=new Date().toISOString(),recoveredEvent={id:'import-only',walletAddress:wallet,tokenAddress:recovered,kind:'buy',
    tokenAmount:'10',amountUsd:'100',txHash:hash(20000),timestamp:recoveredAt,blockNumber:null,transactionIndex:null,logIndex:null};
  await pool.query("INSERT INTO tokens(address,symbol,name,price_usd) VALUES($1,'RECOVERED','Recovered historical token',999)",[recovered]);
  await pool.query(`INSERT INTO node_import_movements(wallet_address,token_address,id,event,raw,payload_hash) VALUES($1,$2,'import-only',$3::jsonb,'{}',$4)`,[wallet,recovered,JSON.stringify(recoveredEvent),'a'.repeat(64)]);
  await pool.query(`INSERT INTO node_accounting_baselines(wallet_address,token_address,checkpoint_block,checkpoint_hash,checkpoint_timestamp,balance,history_fingerprint,ledger,events)
    VALUES($1,$2,125,$3,$4,10,$5,'{}',$6::jsonb)`,[wallet,recovered,hash(125),recoveredAt,'b'.repeat(64),JSON.stringify([recoveredEvent])]);
  await pool.query(`INSERT INTO node_evidence_blocks(block_number,block_hash,parent_hash,timestamp,header) VALUES(125,$1,$2,$3,'{}')`,[hash(125),hash(124),recoveredAt]);
  await pool.query(`INSERT INTO node_market_observations(id,token_address,kind,source,timestamp,block_number,block_hash,price_usd,supply)
    VALUES('profile-market',$1,'state','node',$2,125,$3,0.25,1000000)`,[recovered,recoveredAt,hash(125)]);
  const recoveredProfile=await get(`/api/kols/${wallet}`),recoveredCard=recoveredProfile.tokens.find((item:Asset)=>item.address===recovered);
  assert.ok(recoveredCard,'A provider-only token appears in the actual six-card HTTP response');
  assert.equal(Number(recoveredCard.priceUsd),0.25,'Current UI values use the genuine market observation, never old provider metadata');
  assert.equal(Number(recoveredCard.marketCapUsd),250000);
  assert.equal((await pool.query('SELECT COUNT(*)::int AS count FROM trades')).rows[0].count,storedTrades,'Historical recovery does not insert canonical trades');
  const detail=await get(`/api/tokens/${recovered}`);
  assert.equal(detail.token.address,recovered,'Provider-only public token has a usable token page');
  assert.deepEqual([detail.token.kolCount24h,detail.token.buys24h,detail.token.sells24h],[0,0,0],'Imported eligibility does not fabricate canonical activity counts');
  assert.deepEqual(detail.trades,[]);assert.ok(detail.kols.some((kol:Asset)=>kol.address===wallet));
  const minute=Math.floor((Date.now()-120000)/60000)*60000;
  for(let index=0;index<2;index++)await pool.query(`INSERT INTO node_market_observations(id,token_address,kind,source,timestamp,price_usd,interval_seconds,open,high,low,close,import_id)
    VALUES($1,$2,'imported','imported',$3,0.2,60,0.1,0.3,0.1,0.2,'profile-import')`,[`profile-import-${index}`,recovered,new Date(minute+index*60000)]);
  const importedChart=await get(`/api/tokens/${recovered}/chart?interval=1m&priority=chart`);
  assert.equal(importedChart.source,'imported');assert.ok(importedChart.candles.length>0);assert.equal(importedChart.pending,false);
  assert.equal((await get(`/api/tokens/${recovered}/market`)).token.address,recovered);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM node_market_refresh_jobs WHERE token_address=$1',[recovered])).rows[0].n,1,'Selected token chart creates one durable refresh request without HTTP/RPC');
  const follow=await fetch(`${base}/api/watchlist/items/token/${recovered}`,{method:'PUT',headers:{origin:new URL(base).origin}});
  assert.equal(follow.status,200,'A recovered public token can be favorited');
  const followCookie=follow.headers.get('set-cookie')!.split(';')[0];
  const privateWallet=address(30000),privateToken=address(30001);
  await pool.query('INSERT INTO kols(address,is_tracked) VALUES($1,false)',[privateWallet]);
  await pool.query("INSERT INTO tokens(address,symbol,name) VALUES($1,'PRIVATE','Private-only token')",[privateToken]);
  await pool.query(`INSERT INTO node_accounting_baselines(wallet_address,token_address,checkpoint_block,checkpoint_hash,checkpoint_timestamp,balance,history_fingerprint,ledger,events)
    VALUES($1,$2,125,$3,$4,10,$5,'{}',$6::jsonb)`,[privateWallet,privateToken,hash(125),recoveredAt,'c'.repeat(64),JSON.stringify([{...recoveredEvent,walletAddress:privateWallet,tokenAddress:privateToken}])]);
  for(const asset of [recovered,privateToken])await pool.query(`INSERT INTO trades(id,tx_hash,wallet_address,token_address,side,token_amount,amount_usd,block_number,block_hash,timestamp,source)
    VALUES($1,$2,$3,$4,'buy',10,99999,125,$5,$6,'node')`,[`private-${asset}`,hash(30001),privateWallet,asset,hash(125),recoveredAt]);
  assert.equal((await get(`/api/tokens/${recovered}`)).token.kolCount24h,0,'Private executions do not inflate recovered public token counts');
  assert.equal((await get(`/api/tokens/${privateToken}`)).token,null);
  assert.equal((await get(`/api/tokens/${privateToken}/market`)).token,null);
  await get(`/api/tokens/${privateToken}/chart?interval=1m`,404);
  const privateFollow=await fetch(`${base}/api/watchlist/items/token/${privateToken}`,{method:'PUT',headers:{origin:new URL(base).origin}});
  assert.equal(privateFollow.status,400,'Private-only evidence does not grant public favorite eligibility');
  await pool.query('UPDATE node_accounting_baselines SET invalidated_at=now() WHERE wallet_address=$1 AND token_address=$2',[wallet,recovered]);
  assert.ok(!(await get(`/api/kols/${wallet}`)).tokens.some((item:Asset)=>item.address===recovered),'An invalidated historical baseline cannot stay in the card list');
  assert.equal((await get(`/api/tokens/${recovered}`)).token,null,'Invalidated imported evidence no longer grants a public token page');
  await get(`/api/tokens/${recovered}/chart?interval=1m`,404);
  const hiddenFavorites=await fetch(`${base}/api/watchlist`,{headers:{cookie:followCookie}});
  assert.deepEqual((await hiddenFavorites.json()).items,[],'Existing favorites cannot reveal a token after its public proof is invalidated');
  assert.equal(providerFetches,0,'Cold imported token summaries are queued without calling external providers or RPC in HTTP requests');
  console.log('KOL profile integration passed: pagination, counts, last trade, provider guards, and retained history.');
} finally {
  if (child.exitCode === null) child.kill();
  await Promise.race([exited, new Promise<void>(resolve => setTimeout(resolve, 3000))]);
  if (child.exitCode === null) child.kill('SIGKILL');
  await pool.end();
}
