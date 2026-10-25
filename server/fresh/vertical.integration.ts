/** Isolated fake-node vertical slice. Financial inputs are synthetic; candles
 * are unchanged sanitized genuine observations, served by a fake GMGN HTTP
 * transport. It never calls a financial provider or sends a message. */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Interface } from 'ethers';
import { Pool } from 'pg';
import marketFixture from '../fixtures/closed-replay-market.json' with { type: 'json' };
import { transferTopic } from '../swap.js';
import { FOUR_MANAGERS, fourInterface, WBNB } from '../launchpad.js';
import type { Rpc } from '../rpc.js';
import { ensureFreshSchema } from './schema.js';
import { collectFreshPage, commitFreshPage, type FreshBlock, type FreshCapturedReceipt, type FreshLog } from './capture.js';
import { normalizeFreshReceipt, type FreshDecodeServices } from './decode.js';
import { applyFreshFinancialEvents } from './accounting.js';
import { createFreshReads, publicScope } from './reads.js';
import { createFreshCharts } from './charts.js';
import { ChartDiskCache } from './cache.js';
import { createFreshReplay } from './replay.js';
import { createFreshApp } from './app.js';
import { createGmgnRequester } from '../gmgnTransport.js';
import { refreshFreshBalances } from './balances.js';

const base = new URL(process.env.DATABASE_URL ?? '');
if (!['127.0.0.1', 'localhost'].includes(base.hostname) || base.port !== '5436' || !/^\/kollens_fresh/.test(base.pathname)) throw new Error('Vertical fixtures require the separate local fresh PostgreSQL on port 5436');
const name = `kollens_fresh_vertical_test_${randomBytes(5).toString('hex')}`;
if (!/^kollens_fresh_vertical_test_[a-f0-9]{10}$/.test(name)) throw new Error('Unsafe fixture database');
const admin = new Pool({ connectionString: base.toString(), max: 1 });
const fixtureUrl = new URL(base); fixtureUrl.pathname = '/' + name;
const db = new Pool({ connectionString: fixtureUrl.toString(), max: 5 });
const output = path.resolve('.cache/fresh/vertical');
const hash = (n: number) => '0x' + n.toString(16).padStart(64, '0'), hex = (n: number) => '0x' + n.toString(16);
const word = (v: string | bigint) => typeof v === 'bigint' ? v.toString(16).padStart(64, '0') : v.slice(2).padStart(64, '0');
const wallet = marketFixture.wallet, token = marketFixture.token, other = '0x' + '2'.repeat(40), quote = '0x55d398326f99059ff775485246999027b3197955';
const swap = new Interface(['event Swap(address indexed sender,uint256 amount0In,uint256 amount1In,uint256 amount0Out,uint256 amount1Out,address indexed to)']);
const balanceAbi = new Interface(['function balanceOf(address) view returns(uint256)']);
const from = Date.parse(marketFixture.from), to = Date.parse(marketFixture.to), frozen = Date.parse(marketFixture.frozenAt), scope = publicScope(wallet);
function fixture(side: 'buy' | 'sell', number: number, timestamp: number): { block: FreshBlock; entry: FreshCapturedReceipt } {
  const transaction = { hash: hash(number + 1000), from: wallet, to: other, value: '0x0', blockHash: hash(number), blockNumber: hex(number), transactionIndex: '0x0', gasPrice: '0x3b9aca00' };
  const logs: FreshLog[] = [];
  const add = (address: string, topics: string[], data: string) => logs.push({ address, topics, data, logIndex: hex(logs.length), transactionHash: transaction.hash,
    transactionIndex: '0x0', blockNumber: transaction.blockNumber, blockHash: transaction.blockHash });
  if (side === 'buy') {
    const launch = fourInterface.encodeEventLog('TokenCreate', [other, token, 1n, 'Vertical .ai fixture', 'VAI', 1_000_000_000n, BigInt(timestamp / 1000), 0n]);
    add(FOUR_MANAGERS[1], launch.topics, launch.data);
  }
  const transfer = (asset: string, sender: string, recipient: string, amount: bigint) => add(asset, [transferTopic, '0x' + word(sender), '0x' + word(recipient)], '0x' + word(amount));
  if (side === 'buy') { transfer(quote, wallet, other, 250n * 10n ** 18n); transfer(token, other, wallet, 10_000_000n * 10n ** 18n); }
  else { transfer(token, wallet, other, 10_000_000n * 10n ** 18n); transfer(quote, other, wallet, 300n * 10n ** 18n); }
  const swapped = swap.encodeEventLog('Swap', [other, 1n, 0n, 0n, 1n, wallet]); add(other, swapped.topics, swapped.data);
  return { block: { number: hex(number), hash: hash(number), parentHash: hash(number - 1), timestamp: hex(timestamp / 1000), transactions: [transaction] },
    entry: { transaction, receipt: { transactionHash: transaction.hash, transactionIndex: '0x0', blockHash: transaction.blockHash, blockNumber: transaction.blockNumber,
      status: '0x1', gasUsed: '0x186a0', effectiveGasPrice: transaction.gasPrice, logs }, wallets: [wallet], observedAt: new Date(frozen).toISOString() } };
}
const fixtures = [fixture('buy', 101, from), fixture('sell', 102, to)];
let balanceCalls = 0;
const rpc = (async (method: string, params: unknown[]) => {
  if (method === 'eth_blockNumber') return hex(108);
  if (method === 'eth_getBlockByNumber') {
    const number = Number(BigInt(params[0] as string)); return fixtures.find(value => Number(BigInt(value.block.number)) === number)?.block ?? null;
  }
  if (method === 'eth_getTransactionReceipt') return fixtures.find(value => value.entry.transaction.hash === params[0])?.entry.receipt ?? null;
  if (method === 'eth_getLogs') {
    const filter = params[0] as { topics: (string | string[] | null)[] };
    return fixtures.flatMap(value => value.entry.receipt.logs).filter(log => filter.topics.every((topic, index) => topic === null || Array.isArray(topic) ? topic === null || topic.includes(log.topics[index]) : topic === log.topics[index]));
  }
  if (method === 'eth_call') {
    balanceCalls++;
    assert.deepEqual(params[1], { blockHash: hash(102), requireCanonical: true });
    return balanceAbi.encodeFunctionResult('balanceOf', [0n]);
  }
  throw new Error('Unexpected fake node method');
}) as Rpc;
let app: Awaited<ReturnType<typeof createFreshApp>>['app'] | undefined, created = false;
try {
  await admin.query(`CREATE DATABASE "${name}"`); created = true;
  await ensureFreshSchema(db); await mkdir(output, { recursive: true });
  await db.query(`INSERT INTO fresh.wallets(address,monitoring_from_block) VALUES($1,101);`, [wallet]);
  await db.query(`INSERT INTO fresh.kols(wallet_address,display_name) VALUES($1,'Vertical .ai fixture')`, [wallet]);
  await db.query(`INSERT INTO fresh.accounting_scopes(id,kind,wallet_addresses,starts_at,starts_block) VALUES($1,'kol',$2,$3,101)`, [scope, [wallet], new Date(from - 60_000)]);
  for (const key of ['start', 'capture', 'decode']) await db.query(`INSERT INTO fresh.checkpoints(key,block_number,block_hash,value,updated_at) VALUES($1,100,$2,$3::jsonb,$4)`, [key, hash(100), JSON.stringify({ startBlock: 100, startHash: hash(100) }), new Date(frozen)]);
  const checkpoint = { blockNumber: 100, blockHash: hash(100), revision: 1, startBlock: 100 };
  const page = await collectFreshPage({ rpc, checkpoint, wallets: [{ address: wallet, fromBlock: 101 }], now: new Date(frozen) });
  assert.equal(page.blocks.length, 2); assert.equal(page.receipts.length, 2); assert.equal(page.launches.length, 1);
  const client = await db.connect();
  try { await client.query('BEGIN'); await commitFreshPage(client, page); await client.query('COMMIT'); }
  catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  await db.query(`INSERT INTO fresh.tokens(address,name,symbol,decimals,total_supply_raw,launch_status,price_usd,market_cap_usd,observed_block,observed_hash,observed_at,valuation_status)
    VALUES($1,'Vertical .ai fixture','VAI',18,$2,'eligible',0.00003,30000,102,$3,$4,'ready')`, [token, (1_000_000_000n * 10n ** 18n).toString(), hash(102), new Date(frozen)]);
  const services: FreshDecodeServices = { async metadata(address) { return { address, name: address === token ? 'Vertical .ai fixture' : 'USD stablecoin', symbol: address === token ? 'VAI' : 'USDT', decimals: 18,
    supplyRaw: (1_000_000_000n * 10n ** 18n).toString(), block: { number: 102, hash: hash(102), timestamp: new Date(frozen).toISOString() } }; }, async eligible(meta) { return meta.address === token; },
    async knownLaunch(address) { return page.launches.some(fact => fact.tokenAddress === address); }, async priceUsd(address) { return address === WBNB ? '600' : address === quote ? '1' : '0.00003'; } };
  const normalized = [];
  for (const entry of page.receipts) {
    const block = page.blocks.find(value => value.hash === entry.receipt.blockHash)!;
    const decoded = await normalizeFreshReceipt(entry, block, services); assert.deepEqual(decoded.reasons, []); normalized.push(...decoded.events);
  }
  const financial = await db.connect();
  try { await financial.query('BEGIN'); await applyFreshFinancialEvents(financial, normalized, { now: new Date(frozen) });
    await financial.query(`UPDATE fresh.recent_evidence SET decoder_status='done',decoder_version=1 WHERE block_number BETWEEN 101 AND 102`);
    await financial.query(`UPDATE fresh.checkpoints SET block_number=102,block_hash=$1,updated_at=$2 WHERE key='decode'`, [hash(102), new Date(frozen)]); await financial.query('COMMIT'); }
  catch (error) { await financial.query('ROLLBACK'); throw error; } finally { financial.release(); }
  // The fake node returns a real-shaped canonical block-hash balance call.
  assert.equal(normalized.length, 2, 'synthetic buy and sale must each normalize');
  const balances = await refreshFreshBalances(db, rpc); assert.equal(balances.matched, 1, JSON.stringify({ ...balances, balanceCalls,
    position: (await db.query('SELECT quantity_q,balance_status,revision FROM fresh.positions')).rows, token: (await db.query('SELECT decimals FROM fresh.tokens')).rows }));
  const reads = createFreshReads(db, () => frozen), board = await reads.leaderboard(), activity = await reads.activity(wallet, token, scope, true);
  assert.ok(activity); assert.equal(board.items[0].realizedProfitUsd, '49.88'); assert.equal(activity.realizedAccounting!.realizedProfitUsd, board.items[0].realizedProfitUsd);
  let upstream = 0;
  const transport = createGmgnRequester({ query: (sql, values) => db.query(sql, values), stateTable: 'fresh.checkpoints', now: () => frozen,
    fetcher: async (url) => { upstream++; const selected = url as URL, lower = Number(selected.searchParams.get('from')), upper = Number(selected.searchParams.get('to'));
      assert.equal(selected.pathname, '/v1/market/token_kline');
      return Response.json({ code: 0, data: { list: marketFixture.chart.bars.filter(bar => Date.parse(bar.timestamp) >= lower && Date.parse(bar.timestamp) <= upper).map(bar => ({
        time: Date.parse(bar.timestamp) / 1000, open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: bar.volumeUsd })) } }); } });
  const cache = new ChartDiskCache(path.join(output, 'cache-' + name), { now: () => frozen }), charts = createFreshCharts({ cache, request: (url, options) => transport(url, { ...options, apiKey: 'vertical-fake-no-network-key' }), now: () => frozen });
  const validateRevision = async () => true, replay = createFreshReplay({ charts, secret: 'local-vertical-fixture-secret-at-least-32-bytes', validateRevision, now: () => frozen });
  const prepared = await replay.prepare(activity); assert.equal(prepared.status, 'ready'); assert.equal(prepared.activity!.replayAccounting!.final!.reportedProfitUsd, '49.88');
  assert.equal((await replay.validate(prepared.manifest!)).valid, true); assert.equal(upstream, 1);
  const api = await createFreshApp(db, { services: { reads, charts, replay, cache, validateRevision } }); app = api.app;
  const profile = await app.inject(`/api/kols/${wallet}`), leaderboard = await app.inject('/api/leaderboard');
  assert.equal(profile.statusCode, 200); assert.equal(profile.json().kol.realizedProfitUsd, leaderboard.json().items[0].realizedProfitUsd);
  // Airdrops are retained for accounting, but do not become public traded
  // tokens until a monitored public KOL actually buys or sells them.
  const airdrop='0x'+'d'.repeat(40),recipient='0x'+'e'.repeat(40),recipientScope=publicScope(recipient);
  await db.query(`INSERT INTO fresh.tokens(address,name,symbol,decimals,launch_status) VALUES($1,'Airdrop only','DROP',18,'eligible')`,[airdrop]);
  await db.query(`INSERT INTO fresh.positions(scope_id,token_address,quantity_q) VALUES($1,$2,'1')`,[scope,airdrop]);
  await db.query(`INSERT INTO fresh.financial_events(id,execution_key,wallet_address,token_address,kind,quantity,amount_usd,fee_usd,block_number,block_hash,transaction_hash,transaction_index,execution_index,occurred_at)
    VALUES('airdrop-only','airdrop-only',$1,$2,'transfer_in','1','1','0',102,$3,$4,0,1,$5)`,[wallet,airdrop,hash(102),hash(1102),new Date(frozen)]);
  await db.query(`INSERT INTO fresh.wallets(address,monitoring_from_block) VALUES($1,101)`,[recipient]);
  await db.query(`INSERT INTO fresh.kols(wallet_address,display_name) VALUES($1,'Recipient only')`,[recipient]);
  await db.query(`INSERT INTO fresh.accounting_scopes(id,kind,wallet_addresses,starts_at,starts_block) VALUES($1,'kol',$2,$3,101)`,[recipientScope,[recipient],new Date(from)]);
  await db.query(`INSERT INTO fresh.positions(scope_id,token_address,quantity_q) VALUES($1,$2,'1')`,[recipientScope,token]);
  // This genuine candle fixture is historical. The live eight-hour directory
  // correctly omits it; the KOL's permanent traded-token page still retains it.
  assert.deepEqual((await app.inject('/api/tokens')).json().items.map((item:any)=>item.address),[]);
  assert.deepEqual((await app.inject(`/api/kols/${wallet}/tokens`)).json().items.map((item:any)=>item.address),[token]);
  assert.equal((await app.inject(`/api/kols/${recipient}/tokens`)).json().items.length,0);
  assert.equal((await app.inject(`/api/tokens/${airdrop}`)).json().token,null);
  assert.equal((await app.inject(`/api/tokens/${airdrop}/chart`)).statusCode,404);assert.equal(upstream,1);
  const market=(await app.inject(`/api/tokens/${token}/market?period=24h`)).json();
  assert.equal(market.period,'24h');assert.equal(market.token.address,token);assert.ok(market.utcDay);
  // PostgreSQL date values must remain the UTC calendar date on a host in
  // Europe/Skopje. Watchlist reads share current counters without local-date
  // conversion, and older selections batch compact public facts only.
  const today=new Date().toISOString().slice(0,10);
  await db.query(`UPDATE fresh.tokens SET today_utc=$2::date,today_volume_q='550',today_kol_count=1 WHERE address=$1`,[token,today]);
  await db.query(`UPDATE fresh.financial_events SET occurred_at=now()-interval '1 minute' WHERE token_address=$1 AND kind IN('buy','sell')`,[token]);
  const favorite=await app.inject({method:'PUT',url:`/api/watchlist/items/token/${token}`,headers:{origin:new URL(process.env.PUBLIC_APP_URL??'https://kollens.com').origin}});
  assert.equal(favorite.statusCode,200);assert.equal(favorite.json().items[0].periodVolumeUsd,'550');assert.equal(favorite.json().items[0].periodKolCount,1);
  const cookie=String(favorite.headers['set-cookie']).split(';')[0];
  for(const period of ['7d','30d']){const saved:any=(await app.inject({url:`/api/watchlist?period=${period}`,headers:{cookie}})).json();
    assert.equal(saved.items[0].periodVolumeUsd,'550');assert.equal(saved.items[0].periodKolCount,1);}
  await db.query(`UPDATE fresh.tokens SET today_utc=$2::date-1 WHERE address=$1`,[token,today]);
  const past=(await app.inject({url:'/api/watchlist',headers:{cookie}})).json().items[0];
  assert.equal(past.periodVolumeUsd,'0');assert.equal(past.periodKolCount,0);
  const metrics = { mode: 'synthetic financial execution + unchanged genuine candle fixture + fake GMGN transport', confirmedBlocks: page.blocks.length,
    capturedReceipts: page.receipts.length, financialEvents: normalized.length, storedRealizedProfitUsd: board.items[0].realizedProfitUsd,
    modalProfitUsd: prepared.activity!.replayAccounting!.final!.reportedProfitUsd, modalRoi: prepared.activity!.replayAccounting!.final!.reportedRoi,
    chartCandles: prepared.chart!.candles.length, chartPoints: prepared.chart!.points.length, upstreamRequests: upstream,
    cache: await charts.diagnostics(), prepared: replay.diagnostics(), profileMatchesLeaderboard: true, airdropsExcludedFromTradedTokens:true, isolation: 'temporary fresh database; removed after fixture test' };
  await writeFile(path.join(output, 'prepared.json'), JSON.stringify(prepared, null, 2));
  await writeFile(path.join(output, 'metrics.json'), JSON.stringify(metrics, null, 2));
  await writeFile(path.join(output, 'preview.html'), preview());
  console.log(JSON.stringify({ ok: true, ...metrics, artifacts: output }));
} finally {
  if (app) await app.close(); await db.end();
  if (created) await admin.query(`DROP DATABASE "${name}"`); await admin.end();
}

function preview() { return `<!doctype html><meta charset="utf-8"><title>Fresh Kollens vertical validation</title>
<style>body{background:#0b0e0e;color:#fff;font:16px system-ui;max-width:1180px;margin:24px auto}canvas,video{width:420px;vertical-align:top}button{background:#f0b90b;border:0;border-radius:8px;padding:12px 20px;cursor:pointer}pre{white-space:pre-wrap}</style>
<h1>Fresh Kollens local replay validation</h1><p>Synthetic confirmed buy/sell; unchanged genuine historical candle fixture. Fake GMGN transport. No real post or alert.</p>
<button id="generate">Generate actual MP4</button> <span id="status">Loading…</span><p><canvas id="canvas"></canvas><video id="video" controls></video></p><pre id="metrics"></pre>
<script type="module">
import {prepareTradeReplayData,applyReplayMarketChart,validReplayAccountingFinal} from '/src/tradeReplayData.ts';
import ReplayCanvas from '/src/tradeReplayCanvas.js';import {recordTradeReplay} from '/src/tradeReplayExport.ts';
const result=await(await fetch('./prepared.json')).json(),at=Date.parse(result.activity.generatedAt);
// The fixture script checked this exact signed object before writing it. The
// real app revalidates via its authorized server route before every export.
const approval={manifest:result.manifest,expiresAt:new Date(at+15*60*1000).toISOString(),preparedAt:new Date(at).toISOString(),validatedAt:new Date(at).toISOString()};
const raw=prepareTradeReplayData(result.activity,null,undefined,at,undefined,approval);if(!raw)throw Error('render_adapter_rejected');
const data=applyReplayMarketChart(raw,result.chart,at),player=new ReplayCanvas(document.querySelector('canvas'));await player.setData(data);player.render(1);
const end=player.snapshot(1),final=result.activity.replayAccounting.final;
const same=(a,b)=>Math.abs(Number(a)-Number(b))<1e-9;
const metrics={modalProfit:final.reportedProfitUsd,modalRoi:final.reportedRoi,videoProfit:end.totalPnl,videoRoi:end.totalRoi,profitEqual:same(final.reportedProfitUsd,end.totalPnl),roiEqual:same(final.reportedRoi,end.totalRoi),points:data.chart.points.length};
if(!metrics.profitEqual||!metrics.roiEqual)throw Error('modal_video_ending_mismatch');document.querySelector('#metrics').textContent=JSON.stringify(metrics,null,2);document.querySelector('#status').textContent='Ready';window.replayMetrics=metrics;
const save=async(kind,body)=>fetch('http://127.0.0.1:3304/'+kind,{method:'POST',body});
try{await save('metrics',JSON.stringify(metrics));await new Promise(resolve=>player.canvas.toBlob(async blob=>{await save('frame',blob);resolve();}));}catch{}
document.querySelector('#generate').onclick=async()=>{const started=performance.now();try{const file=await recordTradeReplay(player,'fresh-kollens-vertical',new AbortController().signal,p=>document.querySelector('#status').textContent='Encoding '+Math.round(p*100)+'%');await save('video',file);document.querySelector('#video').src=URL.createObjectURL(file);player.render(1);document.querySelector('#status').textContent='Generated '+file.type+', '+file.size+' bytes in '+((performance.now()-started)/1000).toFixed(1)+'s';window.replayVideo={type:file.type,bytes:file.size,encodingMs:performance.now()-started};}catch(error){document.querySelector('#status').textContent=error.message;throw error;}};
</script>`; }
