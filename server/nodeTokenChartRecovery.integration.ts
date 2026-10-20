/** Real PostgreSQL, fake market transport, no node, Telegram or wallet API. */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { pool as db, ensureSchema } from './db.js';
import { createNodeMarketService, readNodeMarketChart } from './nodeMarket.js';
import { createTokenChartRecovery } from './nodeTokenChartRecovery.js';
import { migrateSavedTokenCharts } from './importSavedTokenCharts.js';
import { MarketProviderDeferred } from './geckoApi.js';
import { importHistoricalChartPage } from './nodeChartImport.js';
import { registerIntelligenceRoutes } from './intelligenceApi.js';
const connection = new URL(process.env.DATABASE_URL ?? 'postgres://invalid');
if (!['127.0.0.1', 'localhost'].includes(connection.hostname) || connection.port !== '5435' || !/^\/bscan_chart_recovery_test_\d+$/.test(connection.pathname)) throw new Error('Explicit disposable local chart recovery database required');
const wallet = `0x${'1'.repeat(40)}`, token = `0x${'2'.repeat(40)}`, other = `0x${'3'.repeat(40)}`, privateToken = `0x${'4'.repeat(40)}`;
const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
const now = Date.now(), boundary = Math.floor((now - 600_000) / 60000) * 60000;
const old = Math.floor((now - 10 * 86400_000) / 3600_000) * 3600_000;
const directory = await mkdtemp(path.join(tmpdir(), 'kollens-chart-recovery-'));
globalThis.fetch = async () => { throw new Error('unexpected_network_transport'); };
try {
  await ensureSchema();
  await db.query('INSERT INTO kols(address,is_tracked) VALUES($1,true)', [wallet]);
  for (const address of [token, other, privateToken]) await db.query('INSERT INTO tokens(address,symbol,name) VALUES($1,\'TEST\',\'Test\')', [address]);
  for (const [index, address] of [token, other].entries()) await db.query(`INSERT INTO trades(id,tx_hash,wallet_address,token_address,side,token_amount,timestamp,source,block_number)
    VALUES($1,$1,$2,$3,'buy',10,$4,'node',1)`, [hash(index + 1), wallet, address, new Date(old)]);
  await db.query(`INSERT INTO node_evidence_blocks(block_number,block_hash,parent_hash,timestamp,header) VALUES(200,$1,$2,$3,'{}')`, [hash(200), hash(199), new Date(boundary)]);
  await db.query(`INSERT INTO worker_state(key,value) VALUES('node_capture_boundary',$1::jsonb),('node_collection',$1::jsonb)`, [JSON.stringify({ blockNumber: 200, blockHash: hash(200), headBlock: 206 })]);
  // The wallet's historical accounting is permanently failing. Chart recovery
  // must not consult that job or require a reconciled baseline.
  await db.query(`INSERT INTO node_import_jobs(wallet_address,token_address,last_error) VALUES($1,$2,'import_execution_identity_ambiguous')`, [wallet, token]);
  const market = createNodeMarketService({ db, rpc: async () => { throw new Error('unexpected_node_request'); }, now: () => now });
  const candle = (time: number, value = 2, volume = 5) => ({ time: time / 1000, open: value, high: value + 1, low: value / 2, close: value, volume });
  const savedAt = new Date(old + 900_000).toISOString();
  const saved = { address: token, source: 'gmgn', resolution: '1m', period: '1m', updatedAt: savedAt, volumeCurrency: 'usd', complete: true,
    candles: [candle(old), candle(old + 60_000), candle(old + 840_000), candle(old + 900_000)] };
  await writeFile(path.join(directory, `${token}-1m.json`), JSON.stringify(saved));
  await writeFile(path.join(directory, `${token}-5m.json`), JSON.stringify({ ...saved, resolution: '5m', candles: [candle(old, 9, 40)] }));
  await writeFile(path.join(directory, `${privateToken}-1m.json`), JSON.stringify({ ...saved, address: privateToken }));
  await writeFile(path.join(directory, `${other}-1m.json`), '{bad json');
  // The migration must isolate a damaged file rather than discard good files.
  const archive = path.join(directory, 'full-history', `${token}-1m`), bucket = Math.floor((old / 1000) / 60000);
  await mkdir(archive, { recursive: true });
  const archiveRows = [[old / 1000, 1, 3, 0.5, 2, 10]];
  await writeFile(path.join(archive, 'manifest.json'), JSON.stringify({ version: 1, address: token, interval: '1m', updatedAt: savedAt, complete: true, volumeCurrency: 'unknown',
    coverage: [[1, old / 1000 + 900]], chunks: [{ bucket, first: old / 1000, last: old / 1000, count: 1 }] }));
  await writeFile(path.join(archive, `${bucket}.json`), JSON.stringify(archiveRows));
  const dry = await migrateSavedTokenCharts(directory, { db, market, now: () => now });
  assert.equal(dry.dryRun, true); assert.equal((await db.query('SELECT count(*)::int AS n FROM node_market_observations')).rows[0].n, 0);
  const first = await migrateSavedTokenCharts(directory, { db, market, dryRun: false, now: () => now });
  assert.equal(first.imported, 3); assert.equal(first.skipped, 1, 'private-only token cache is not migrated into public recovery');
  assert.equal(first.invalid,1,'one damaged JSON file cannot discard valid history');
  assert.equal((await db.query('SELECT count(*)::int AS n FROM node_market_import_ranges WHERE complete')).rows[0].n, 0, 'legacy completeness is never promoted into replay proof');
  const evidence = (await db.query('SELECT created_at,volume_usd FROM node_market_observations ORDER BY created_at LIMIT 1')).rows[0];
  assert.equal(new Date(evidence.created_at).toISOString(), savedAt, 'original cache timestamp survives migration');
  const repeat = await migrateSavedTokenCharts(directory, { db, market, dryRun: false, now: () => now });
  assert.equal(repeat.imported, 0); assert.equal(repeat.bars, 0);
  const fiveMinute = await readNodeMarketChart(db, token, { from: new Date(old).toISOString(), to: new Date(old + 300_000).toISOString(), intervalSeconds: 300 });
  assert.equal(fiveMinute.bars[0].close, '9'); assert.equal(fiveMinute.bars[0].volumeUsd, '40', 'coarse and overlapping fine candles never inflate volume');
  assert.equal(fiveMinute.complete, false); assert.equal(fiveMinute.source, 'imported');
  const unknownVolume = (await db.query("SELECT volume_usd FROM node_market_observations WHERE import_id LIKE 'legacy-cache:%' AND volume_usd IS NULL")).rows;
  assert.equal(unknownVolume.length, 1);
  console.log('PASS saved regular/chunked charts, timestamps, forming bars, unknown volume, public isolation, idempotency and interval overlap');

  let calls = 0, fail = false, release: (() => void) | undefined, enter: (() => void) | undefined;
  let blocked: Promise<void> | undefined;
  const request = async (url: URL, options: any) => {
    calls++; assert.ok(url.pathname.endsWith('/token_kline')); assert.equal(options.workload, 'market'); assert.equal(options.foreground, true); assert.equal(options.priority, 'chart');
    assert.equal(url.searchParams.has('wallet_address'), false);
    if (enter) { enter(); enter = undefined; await blocked; }
    if (fail) throw new MarketProviderDeferred('rate_limited', 12000);
    const from = Number(url.searchParams.get('from')), to = Number(url.searchParams.get('to'));
    return { data: from===to?[candle(from,4)]:[candle(from, 4), candle(to, 5)] };
  };
  const recovery = createTokenChartRecovery({ db, market, request: request as never, now: () => now });
  const window = { from: boundary - 60_000, to: now, seconds: 60 };
  const queued = await recovery.requestWindow(token, window); assert.equal(queued.pending, true);
  await recovery.requestWindow(token, window);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM node_import_chart_jobs')).rows[0].n, 1, 'visitors share one normalized segment');
  const entered = new Promise<void>(resolve => { enter = resolve; }); blocked = new Promise<void>(resolve => { release = resolve; });
  const active = recovery.tick(); await entered;
  assert.equal((await recovery.tick()).status, 'idle', 'a second worker cannot dispatch the leased segment');
  release!(); const activeResult=await active;assert.equal(activeResult.status, 'progress',JSON.stringify(activeResult)); assert.equal(calls, 1);
  assert.equal((await recovery.requestWindow(token, window)).pending, false);
  const publicChart = await readNodeMarketChart(db, token, { from: new Date(window.from).toISOString(), to: new Date(boundary).toISOString(), intervalSeconds: 60 });
  assert.ok(publicChart.bars.length > 0); assert.equal((await db.query('SELECT count(*)::int AS n FROM node_accounting_baselines')).rows[0].n, 0);
  assert.equal((await db.query('SELECT last_error FROM node_import_jobs')).rows[0].last_error, 'import_execution_identity_ambiguous');
  // A matching wallet chart import reuses the same completed provider page.
  const job = (await db.query('SELECT * FROM node_import_chart_jobs LIMIT 1')).rows[0];
  await db.query('UPDATE node_import_chart_jobs SET completed_at=NULL,cursor_at=to_at');
  assert.equal((await recovery.tick()).cacheHit, true); assert.equal(calls, 1);
  console.log('PASS selected chart runs without P&L, concurrent visitors/workers coalesce, shared provider page reused');

  fail = true;
  await recovery.requestWindow(other, window);
  assert.equal((await recovery.tick()).status, 'retry'); const before = calls;
  const waiting = await recovery.requestWindow(other, window); assert.equal(waiting.coolingDown, true);
  assert.equal((await recovery.tick()).status, 'idle'); assert.equal(calls, before, 'polling cannot reset a provider cooldown');
  fail = false;
  await db.query('UPDATE node_import_chart_jobs SET next_attempt_at=now() WHERE token_address=$1', [other]);
  assert.equal((await createTokenChartRecovery({ db, market, request: request as never, now: () => now }).tick()).status, 'progress');
  await db.query('UPDATE node_import_chart_jobs SET completed_at=NULL,cursor_at=to_at,expires_at=now()-interval \'1 second\'');
  assert.equal((await recovery.tick()).status, 'idle', 'closed/expired selections pause without discarding completed pages');
  assert.equal((await recovery.requestWindow(privateToken, window)).pending, false);
  await recovery.requestWindow(token, { from: now - 86400_000, to: now, seconds: 60, lastKnownTradeAt: old });
  const dormant = (await db.query('SELECT min(from_at) AS first FROM node_import_chart_jobs')).rows[0].first;
  assert.ok(Date.parse(dormant) < old, 'dormant token recovery uses its historical market window, not an empty recent day');
  console.log('PASS cooldowns survive polls/restarts, cancellation/expiry, private exclusion and dormant older token windows');
  await db.query('DELETE FROM node_import_chart_jobs WHERE token_address=$1',[other]);
  const app=Fastify();registerIntelligenceRoutes(app);
  try{
    const older=`/api/tokens/${other}/chart?interval=1m&history=full&before=${Math.floor(old/1000)+3600}`;
    const read=await app.inject(older);assert.equal(read.statusCode,200);
    assert.equal((await db.query('SELECT count(*)::int n FROM node_import_chart_jobs WHERE token_address=$1',[other])).rows[0].n,0,
      'Ordinary historical pagination is a database-only read');
    const selected=await app.inject(older+'&priority=chart');assert.equal(selected.statusCode,200);
    assert.equal(selected.json().historyRecoveryPending,true,'An explicitly selected older page can recover its absent market history');
    assert.ok((await db.query('SELECT count(*)::int n FROM node_import_chart_jobs WHERE token_address=$1',[other])).rows[0].n>0);
    assert.equal((await app.inject(older.replace(other,privateToken)+'&priority=chart')).statusCode,404);
  }finally{await app.close();}
  console.log('PASS selected paginated chart recovery, ordinary database-only pagination and private API isolation');
  const gapToken=`0x${'5'.repeat(40)}`,gapMarket='selected-market',marketAt=boundary+3600_000,headAt=boundary+3*3600_000;
  await db.query('INSERT INTO tokens(address,symbol,name) VALUES($1,\'GAP\',\'Gap\')',[gapToken]);
  await db.query(`INSERT INTO trades(id,tx_hash,wallet_address,token_address,side,token_amount,timestamp,source,block_number)
    VALUES($1,$1,$2,$3,'buy',10,$4,'node',201)`,[hash(301),wallet,gapToken,new Date(marketAt)]);
  await db.query(`INSERT INTO node_evidence_blocks(block_number,block_hash,parent_hash,timestamp,header)
    VALUES(201,$1,$2,$3,'{}'),(202,$4,$1,$5,'{}')`,[hash(201),hash(200),new Date(marketAt),hash(202),new Date(headAt)]);
  await db.query(`UPDATE worker_state SET value=$1::jsonb WHERE key='node_collection'`,[JSON.stringify({blockNumber:202,blockHash:hash(202),headBlock:208})]);
  await db.query(`INSERT INTO node_markets(id,token_address,quote_address,protocol,contract_address,token0,token1,decimals0,decimals1,
    authenticated_at_block,authenticated_block_hash,authentication,status,discovered_at,collected_from_block)
    VALUES($1,$2,$3,'pcs_v2',$4,$2,$3,18,18,201,$5,'{}','active',$6,1)`,
  [gapMarket,gapToken,token,other,hash(201),new Date(marketAt+600_000)]);
  const chartFrom=boundary-3600_000,chartTo=headAt+3600_000;
  const chart={tokenAddress:gapToken,from:new Date(chartFrom).toISOString(),to:new Date(chartTo).toISOString(),intervalSeconds:60,
    bars:[{timestamp:new Date(chartFrom).toISOString(),open:'1',high:'1',low:'1',close:'1',volumeUsd:'1',source:'imported' as const,intervalSeconds:60,supply:null,supplyEstimated:true}],
    source:'imported' as const,sparse:true,complete:false,coverage:[],reason:'incomplete_chart_coverage' as const};
  const gapRecovery=createTokenChartRecovery({db,market,request:request as never,now:()=>headAt+3600_000});
  assert.equal((await gapRecovery.requestChart(gapToken,chart)).pending,true);
  let imports=(await db.query('SELECT from_at,to_at FROM node_import_chart_jobs WHERE token_address=$1 ORDER BY to_at',[gapToken])).rows;
  assert.equal(Date.parse(imports.at(-1)!.to_at),marketAt,
    'Historical market bootstrap extends past the global wallet boundary to its first authenticated checkpoint');
  assert.ok(imports.every(row=>Date.parse(row.to_at)<=marketAt),'The immutable market boundary never imports later captured activity');
  let nodeJobs=(await db.query('SELECT from_at,to_at FROM node_market_history_jobs WHERE token_address=$1',[gapToken])).rows;
  assert.equal(nodeJobs.length,1);assert.equal(Date.parse(nodeJobs[0].to_at),headAt,'Repair never requests beyond the committed node head');
  assert.equal(Date.parse(nodeJobs[0].to_at)-Date.parse(nodeJobs[0].from_at),1800_000,'Selected repair is a bounded recent half-hour');
  await gapRecovery.requestChart(gapToken,chart);
  assert.equal((await db.query('SELECT count(*)::int n FROM node_market_history_jobs WHERE token_address=$1',[gapToken])).rows[0].n,1,'Repeated visitors join the same repair');
  await db.query('UPDATE node_markets SET collected_from_block=0 WHERE id=$1',[gapMarket]);
  await gapRecovery.requestChart(gapToken,chart);
  imports=(await db.query('SELECT max(to_at) AS ending FROM node_import_chart_jobs WHERE token_address=$1',[gapToken])).rows;
  assert.equal(Date.parse(imports[0].ending),marketAt,'Backfilled raw logs cannot move the immutable metadata bootstrap boundary');
  await db.query('DELETE FROM node_market_history_jobs WHERE token_address=$1',[gapToken]);
  const covered={...chart,coverage:[{from:chart.from,to:new Date(headAt).toISOString(),source:'node' as const}]};
  assert.equal((await gapRecovery.requestChart(gapToken,covered)).pending,false,'Proven no-swap intervals need neither imports nor node rescans');
  await db.query(`INSERT INTO node_market_raw_logs(market_id,block_number,block_hash,tx_hash,transaction_index,log_index,timestamp,log,decode_status)
    VALUES($1,201,$2,$3,0,0,$4,'{}','pending')`,[gapMarket,hash(201),hash(401),new Date(marketAt+60_000)]);
  assert.equal((await gapRecovery.requestChart(gapToken,covered)).pending,true,'Captured undecoded logs retain selected repair priority');
  assert.equal((await db.query('SELECT count(*)::int n FROM node_market_history_jobs WHERE token_address=$1',[gapToken])).rows[0].n,1);
  await db.query('DELETE FROM node_market_history_jobs WHERE token_address=$1',[gapToken]);
  assert.equal((await gapRecovery.requestChart(gapToken,{...covered,bars:[]})).pending,true);
  assert.equal((await db.query('SELECT count(*)::int n FROM node_market_history_jobs WHERE token_address=$1',[gapToken])).rows[0].n,1,
    'A new token with no decoded candles still queues selected node work for its captured raw logs');
  await db.query('DELETE FROM node_market_history_jobs WHERE token_address=$1',[gapToken]);
  const coveredPendingFrom=marketAt+60_000,coveredPendingTo=marketAt+180_000,laterPendingAt=marketAt+45*60_000;
  await db.query(`INSERT INTO node_market_import_ranges(token_address,import_id,from_at,to_at,complete)
    VALUES($1,'covered-pending-prefix:interval:60',$2,$3,true)`,[gapToken,new Date(coveredPendingFrom),new Date(coveredPendingTo)]);
  // More than the old read limit remains pending behind a completed provider
  // projection. These immutable raw rows must not hide a later node repair.
  const prefixTransactions=Array.from({length:33},(_,index)=>hash(410+index));
  for(const [index,tx] of prefixTransactions.entries())await db.query(`INSERT INTO node_market_raw_logs
    (market_id,block_number,block_hash,tx_hash,transaction_index,log_index,timestamp,log,decode_status)
    VALUES($1,$2,$3,$4,0,$5,$6,'{}','pending')`,
  [gapMarket,index<32?203:204,hash(index<32?203:204),tx,index,new Date(index<32?marketAt+90_000:laterPendingAt)]);
  const prefixCovered={...covered,coverage:[...covered.coverage,
    {from:new Date(coveredPendingFrom).toISOString(),to:new Date(coveredPendingTo).toISOString(),source:'imported' as const}]};
  assert.equal((await gapRecovery.requestChart(gapToken,prefixCovered)).pending,true);
  const selectedLater=(await db.query('SELECT from_at,to_at FROM node_market_history_jobs WHERE token_address=$1',[gapToken])).rows;
  const selectedStart=Math.floor(laterPendingAt/(30*60_000))*30*60_000;
  assert.equal(selectedLater.length,1);assert.equal(Date.parse(selectedLater[0].from_at),selectedStart,
    'Covered raw logs are excluded before the bounded selection, so a later unresolved price receives foreground priority');
  assert.equal(Date.parse(selectedLater[0].to_at),Math.min(headAt,selectedStart+30*60_000));
  assert.equal((await db.query("SELECT count(*)::int n FROM node_market_raw_logs WHERE tx_hash=ANY($1::text[]) AND decode_status='pending'",[prefixTransactions])).rows[0].n,33,
    'Selecting the unresolved window never mutates the preserved pending raw evidence');
  await db.query('DELETE FROM node_market_history_jobs WHERE token_address=$1',[gapToken]);
  await db.query('DELETE FROM node_market_raw_logs WHERE tx_hash=ANY($1::text[])',[prefixTransactions]);
  await db.query("DELETE FROM node_market_import_ranges WHERE import_id='covered-pending-prefix:interval:60'");
  console.log('PASS covered pending prefixes cannot starve a later selected node repair');
  await db.query('DELETE FROM node_import_chart_jobs WHERE token_address=$1',[gapToken]);
  await db.query(`UPDATE worker_state SET value=$1::jsonb WHERE key='node_collection'`,[JSON.stringify({blockNumber:200,blockHash:hash(200),headBlock:206})]);
  await gapRecovery.requestWindow(gapToken,{from:chartFrom,to:chartTo,seconds:60});
  const clamped=(await db.query('SELECT max(to_at) AS ending FROM node_import_chart_jobs WHERE token_address=$1',[gapToken])).rows[0].ending;
  assert.equal(Date.parse(clamped),boundary,'Missing or later authentication evidence cannot import beyond the committed node head');
  assert.equal((await gapRecovery.requestChart(privateToken,{...chart,tokenAddress:privateToken})).pending,false,'Internal-gap recovery enforces public token access too');
  console.log('PASS internal gaps, immutable per-market bootstrap, bounded post-boundary repairs, no-swap coverage and decoder priority');
  const emptyFrom=marketAt-600_000,firstFrom=emptyFrom-60_000,logicalId='shared-coarse-fine-identity';
  const qualifiedMarket=createNodeMarketService({db,rpc:async()=>{throw Error('unexpected_node_request');},now:()=>headAt+3600_000});
  const load=async(seconds:number,from:number,to:number,data:unknown[])=>importHistoricalChartPage({db,market:qualifiedMarket,token:gapToken,seconds,from,to,importId:logicalId,
    now:headAt+3600_000,request:(async()=>({data})) as never});
  await load(60,firstFrom,firstFrom,[candle(firstFrom,4)]);
  await load(300,emptyFrom,emptyFrom,[candle(emptyFrom,99)]);
  const empty=await load(60,emptyFrom,emptyFrom+240_000,[]);
  assert.equal(empty.retrievalComplete,true);assert.equal(empty.observations.length,0);
  const completeSparse=await qualifiedMarket.chart(gapToken,{from:new Date(firstFrom).toISOString(),to:new Date(emptyFrom+300_000).toISOString(),intervalSeconds:60});
  assert.equal(completeSparse.complete,true,'An empty completed minute retrieval proves inactivity without borrowing overlapping coarse candles');
  assert.equal(completeSparse.bars.length,1);assert.equal(completeSparse.bars[0].close,'4');
  assert.ok(completeSparse.coverage.some(range=>Date.parse(range.from)===emptyFrom&&Date.parse(range.to)===emptyFrom+300_000),
    'Resolution-qualified empty pages retain their actual retrieved coverage even without an observation row');
  assert.equal((await load(60,emptyFrom,emptyFrom+240_000,[])).cacheHit,true,'Qualified market identities preserve the shared raw-page cache');
  console.log('PASS separate coarse/fine import proofs, completed empty minute pages and raw-page reuse');
  // Raw collection may be complete while exact conversion/precision capture
  // failed before historical state was pruned. Node ranges cannot certify that
  // missing price projection or force it back through an endless repair loop.
  const failedAt=marketAt+3600_000,failedFrom=failedAt-60_000,failedTo=failedAt+120_000;
  await db.query(`INSERT INTO node_evidence_blocks(block_number,block_hash,parent_hash,timestamp,header)
    VALUES(501,$1,$2,$3,'{}'),(2000,$4,$5,$6,'{}')`,[hash(501),hash(500),new Date(failedAt),hash(2000),hash(1999),new Date(headAt)]);
  await db.query(`UPDATE worker_state SET value=$1::jsonb WHERE key='node_collection'`,[JSON.stringify({blockNumber:2000,blockHash:hash(2000),headBlock:2006})]);
  await db.query(`INSERT INTO node_market_raw_logs(market_id,block_number,block_hash,tx_hash,transaction_index,log_index,timestamp,log,decode_status)
    VALUES($1,501,$2,$3,0,0,$4,'{}','missing_quote')`,[gapMarket,hash(501),hash(502),new Date(failedAt)]);
  await db.query(`INSERT INTO node_evidence_metadata_jobs(block_number,block_hash,timestamp,tokens,attempts,last_error)
    VALUES(501,$1,$2,$3,1,'historical_token_metadata_unavailable')`,[hash(501),new Date(failedAt),[gapToken]]);
  await db.query(`INSERT INTO node_market_ranges(market_id,from_block,to_block,from_hash,to_hash,from_at,to_at,complete)
    VALUES($1,201,2000,$2,$3,$4,$5,true)`,[gapMarket,hash(201),hash(2000),new Date(marketAt),new Date(headAt)]);
  await db.query('DELETE FROM node_import_chart_jobs WHERE token_address=$1',[gapToken]);
  await db.query('DELETE FROM node_market_history_jobs WHERE token_address=$1',[gapToken]);
  const failedChart={...chart,from:new Date(failedFrom).toISOString(),to:new Date(failedTo).toISOString(),
    coverage:[{from:new Date(failedFrom).toISOString(),to:new Date(failedTo).toISOString(),source:'node' as const}]};
  const historicalRecovery=createTokenChartRecovery({db,market:qualifiedMarket,request:request as never,now:()=>headAt+3600_000});
  const recovering=await historicalRecovery.requestChart(gapToken,failedChart,{exactWindow:true});
  assert.equal(recovering.pending,true);
  const historicalJobs=(await db.query('SELECT from_at,to_at FROM node_import_chart_jobs WHERE token_address=$1',[gapToken])).rows;
  assert.equal(historicalJobs.length,1);assert.ok(Date.parse(historicalJobs[0].to_at)>marketAt,
    'A canonical failed historical state projection can recover after the market bootstrap boundary');
  assert.equal((await db.query('SELECT count(*)::int n FROM node_market_history_jobs WHERE token_address=$1',[gapToken])).rows[0].n,0,
    'Known unavailable historical precision does not restart the same node repair');
  const callsBeforeHistorical=calls;
  const historicalTick=await historicalRecovery.tick();assert.equal(historicalTick.status,'progress',JSON.stringify(historicalTick));assert.equal(calls,callsBeforeHistorical+1);
  const repaired=await qualifiedMarket.chart(gapToken,{from:failedChart.from,to:failedChart.to,intervalSeconds:60});
  assert.equal(repaired.complete,true,'Completed genuine provider coverage makes a historical chart usable despite retained undecoded raw evidence');
  assert.ok(repaired.bars.every(bar=>bar.source==='imported'));
  assert.equal((await historicalRecovery.requestChart(gapToken,repaired,{exactWindow:true})).pending,false);
  assert.equal(calls,callsBeforeHistorical+1,'Completed recovery is reused without another upstream request');
  // A completed empty response remains explicit absence of market prices. Its
  // retrieval proof is durable and cannot be endlessly resubmitted by polls.
  await db.query('UPDATE node_import_chart_jobs SET completed_at=now() WHERE token_address=$1',[gapToken]);
  assert.equal((await historicalRecovery.requestChart(gapToken,failedChart,{exactWindow:true})).exhausted,true);
  await db.query('DELETE FROM node_import_chart_jobs WHERE token_address=$1',[gapToken]);
  await db.query("UPDATE node_market_raw_logs SET decode_status='pending' WHERE market_id=$1 AND block_number=501",[gapMarket]);
  assert.equal((await historicalRecovery.requestChart(gapToken,failedChart,{exactWindow:true})).pending,true);
  assert.ok((await db.query('SELECT count(*)::int n FROM node_import_chart_jobs WHERE token_address=$1',[gapToken])).rows[0].n>0,
    'A decoder blocked before its first attempt by proven unavailable historical precision also recovers');
  await db.query('DELETE FROM node_import_chart_jobs WHERE token_address=$1',[gapToken]);
  await db.query("UPDATE node_evidence_metadata_jobs SET last_error='token_metadata_unavailable' WHERE block_number=501");
  assert.equal((await historicalRecovery.requestChart(gapToken,failedChart,{exactWindow:true})).pending,true);
  assert.equal((await db.query('SELECT count(*)::int n FROM node_import_chart_jobs WHERE token_address=$1',[gapToken])).rows[0].n,0,
    'A temporary or fresh metadata failure stays on the node repair path even when its block is old');
  assert.equal((await db.query('SELECT count(*)::int n FROM node_market_history_jobs WHERE token_address=$1',[gapToken])).rows[0].n,1);
  await db.query(`INSERT INTO node_market_token_evidence(token_address,block_number,block_hash,timestamp,decimals,total_supply_raw,supply)
    SELECT unnest($1::text[]),501,$2,$3,18,1000000000000000000,1 ON CONFLICT DO NOTHING`,[[gapToken,token],hash(501),new Date(failedAt)]);
  await db.query(`INSERT INTO node_market_quote_evidence(quote_address,block_number,block_hash,timestamp,price_usd,base_quote_address,pool_address,protocol,depth_usd,evidence)
    VALUES($1,501,$2,$3,1,$1,$4,'pcs_v2',1000,'{}')`,[token,hash(501),new Date(failedAt),other]);
  await db.query("UPDATE node_evidence_metadata_jobs SET last_error='historical_feed_evidence_unavailable' WHERE block_number=501");
  await historicalRecovery.requestChart(gapToken,failedChart,{exactWindow:true});
  assert.equal((await db.query('SELECT count(*)::int n FROM node_import_chart_jobs WHERE token_address=$1',[gapToken])).rows[0].n,0,
    'A broad metadata job failing for another asset cannot hide this market\'s complete original precision and quote proof');
  await db.query("UPDATE node_market_history_jobs SET last_error='pruned_market_range' WHERE token_address=$1",[gapToken]);
  assert.equal((await historicalRecovery.requestChart(gapToken,failedChart,{exactWindow:true})).pending,true);
  assert.ok((await db.query('SELECT count(*)::int n FROM node_import_chart_jobs WHERE token_address=$1',[gapToken])).rows[0].n>0,
    'An independently failed pruned block-body range also admits bounded provider recovery');
  assert.equal((await historicalRecovery.requestChart(privateToken,{...failedChart,tokenAddress:privateToken},{exactWindow:true})).pending,false);
  console.log('PASS failed historical precision after bootstrap, immutable node evidence, temporary-failure separation, durable exhaustion and public isolation');
  await db.query('DELETE FROM node_import_chart_jobs WHERE token_address=$1',[other]);
  const endingFrom=old+23000,endingTo=old+40000;
  await historicalRecovery.requestWindow(other,{from:endingFrom,to:endingTo,seconds:60,exactWindow:true});
  const exactJob=(await db.query('SELECT to_at FROM node_import_chart_jobs WHERE token_address=$1',[other])).rows[0];
  assert.equal(Date.parse(exactJob.to_at),old+60000,'A closed intraminute ending retrieves its completed genuine final candle');
  await db.query("UPDATE node_import_chart_jobs SET expires_at=now()-interval '1 second' WHERE token_address<>$1",[other]);
  const exactTick=await historicalRecovery.tick();assert.equal(exactTick.status,'progress',JSON.stringify(exactTick));
  const exactChart=await qualifiedMarket.chart(other,{from:new Date(endingFrom).toISOString(),to:new Date(endingTo).toISOString(),intervalSeconds:60});
  assert.equal(exactChart.complete,true);assert.ok(exactChart.bars.some(bar=>Date.parse(bar.timestamp)===old));
  assert.ok(exactChart.coverage.some(range=>Date.parse(range.to)===old+60000),'Recorded provider proof follows the actual completed candle endpoint');
  assert.equal(exactChart.from,new Date(endingFrom).toISOString());assert.equal(exactChart.to,new Date(endingTo).toISOString(),
    'The approved frozen accounting window is never rounded or extended with its market retrieval bucket');
  const currentMinute=Math.floor((headAt+3600_000)/60000)*60000;
  await historicalRecovery.requestWindow(other,{from:currentMinute+1000,to:currentMinute+40000,seconds:60,exactWindow:true});
  assert.equal((await db.query('SELECT max(to_at) ending FROM node_import_chart_jobs WHERE token_address=$1',[other])).rows[0].ending.getTime(),old+60000,
    'An unfinished current or unconfirmed bucket cannot become historical provider proof');
  console.log('PASS sub-minute closed replay endpoints, original approved windows and no forming/unconfirmed candle imports');
  const emptyToken=`0x${'6'.repeat(40)}`;
  await db.query("INSERT INTO tokens(address,symbol,name) VALUES($1,'EMPTY','Empty historical market')",[emptyToken]);
  await db.query(`INSERT INTO trades(id,tx_hash,wallet_address,token_address,side,token_amount,timestamp,source,block_number)
    VALUES($1,$1,$2,$3,'buy',1,$4,'node',201)`,[hash(601),wallet,emptyToken,new Date(old)]);
  let emptyRequests=0;
  const emptyRecovery=createTokenChartRecovery({db,market:qualifiedMarket,request:(async()=>{emptyRequests++;return{data:[]};}) as never,now:()=>headAt+3600_000});
  const emptyBefore=await qualifiedMarket.chart(emptyToken,{from:new Date(endingFrom).toISOString(),to:new Date(endingTo).toISOString(),intervalSeconds:60});
  assert.equal((await emptyRecovery.requestChart(emptyToken,emptyBefore,{exactWindow:true})).pending,true);
  assert.equal((await emptyRecovery.tick()).status,'progress');
  const emptyAfter=await qualifiedMarket.chart(emptyToken,{from:emptyBefore.from,to:emptyBefore.to,intervalSeconds:60});
  assert.equal(emptyAfter.bars.length,0);assert.equal(emptyAfter.complete,false);
  const exhausted=await emptyRecovery.requestChart(emptyToken,emptyAfter,{exactWindow:true});
  assert.equal(exhausted.pending,false);assert.equal(exhausted.exhausted,true);
  assert.equal((await emptyRecovery.tick()).status,'idle');assert.equal(emptyRequests,1,
    'A legitimately exhausted empty provider result remains unavailable instead of generating candles or infinite retries');
  console.log('PASS explicit empty-history exhaustion without fabricated prices or repeat requests');
  const liveMinute=Math.floor(headAt/60000)*60000;
  await db.query(`INSERT INTO node_evidence_blocks(block_number,block_hash,parent_hash,timestamp,header)
    VALUES(3000,$1,$2,$3,'{}'),(3001,$4,$1,$5,'{}')`,[hash(3000),hash(2999),new Date(liveMinute+5000),hash(3001),new Date(liveMinute+55000)]);
  await db.query(`UPDATE worker_state SET value=$1::jsonb WHERE key='node_collection'`,[JSON.stringify({blockNumber:3001,blockHash:hash(3001),headBlock:3007})]);
  await db.query(`INSERT INTO node_markets(id,token_address,quote_address,protocol,contract_address,token0,token1,decimals0,decimals1,
    authenticated_at_block,authenticated_block_hash,authentication,status,discovered_at)
    VALUES('forming-minute',$1,$2,'pcs_v2',$3,$1,$2,18,18,3000,$4,'{}','active',$5)`,[emptyToken,token,other,hash(3000),new Date(liveMinute+5000)]);
  const formingRecovery=createTokenChartRecovery({db,market:qualifiedMarket,request:(async()=>{throw Error('No completed bucket to request');}) as never,now:()=>liveMinute+55000});
  const forming=await formingRecovery.requestChart(emptyToken,{...emptyBefore,from:new Date(liveMinute).toISOString(),to:new Date(liveMinute+20000).toISOString(),coverage:[]},{exactWindow:true});
  assert.equal(forming.pending,false);assert.notEqual(forming.exhausted,true,
    'A just-closed position inside the current incomplete candle has not exhausted a provider retrieval that never happened');
  console.log('PASS waiting for a completed historical candle never becomes false terminal exhaustion');

  const unregisteredToken=`0x${'9'.repeat(40)}`,unregisteredFrom=headAt-30*60_000,unregisteredTo=headAt-20*60_000;
  await db.query("INSERT INTO tokens(address,symbol,name) VALUES($1,'ONBOARD','Uncaptured market history')",[unregisteredToken]);
  await db.query(`INSERT INTO trades(id,tx_hash,wallet_address,token_address,side,token_amount,timestamp,source,block_number)
    VALUES($1,$1,$2,$3,'buy',1,$4,'node',201)`,[hash(901),wallet,unregisteredToken,new Date(marketAt)]);
  const unregisteredChart={...chart,tokenAddress:unregisteredToken,from:new Date(unregisteredFrom).toISOString(),to:new Date(unregisteredTo).toISOString(),bars:[],coverage:[]};
  assert.equal((await historicalRecovery.requestChart(unregisteredToken,unregisteredChart,{exactWindow:true})).pending,true);
  const onboardingJobs=(await db.query('SELECT from_at,to_at FROM node_import_chart_jobs WHERE token_address=$1',[unregisteredToken])).rows;
  assert.equal(Date.parse(onboardingJobs.at(-1)!.to_at),unregisteredTo,
    'A global wallet checkpoint cannot clamp uncaptured historical markets to the beginning of wallet monitoring');
  assert.ok(Date.parse(onboardingJobs.at(-1)!.to_at)>boundary);
  assert.equal((await db.query('SELECT count(*)::int n FROM node_market_history_jobs WHERE token_address=$1',[unregisteredToken])).rows[0].n,0,
    'An unregistered old market does not endlessly request node pool logs before its market exists');
  assert.equal((await historicalRecovery.tick()).status,'progress');
  assert.equal((await qualifiedMarket.chart(unregisteredToken,{from:unregisteredChart.from,to:unregisteredChart.to,intervalSeconds:60})).complete,true);
  const freshUnregistered={...unregisteredChart,from:new Date(liveMinute+10000).toISOString(),to:new Date(liveMinute+20000).toISOString()};
  const freshState=await formingRecovery.requestChart(unregisteredToken,freshUnregistered,{exactWindow:true});
  assert.notEqual(freshState.exhausted,true);
  await formingRecovery.requestWindow(unregisteredToken,{from:liveMinute-5*60_000+40000,to:liveMinute-4*60_000+20000,seconds:60,exactWindow:true});
  assert.ok((await db.query('SELECT to_at FROM node_import_chart_jobs WHERE token_address=$1',[unregisteredToken])).rows.every(row=>Date.parse(row.to_at)<=liveMinute-5*60_000),
    'Unregistered market fallback never imports recent or forming observations during node discovery');
  await db.query(`INSERT INTO node_markets(id,token_address,quote_address,protocol,contract_address,token0,token1,decimals0,decimals1,
    authenticated_at_block,authenticated_block_hash,authentication,status)
    VALUES('registered-repair',$1,$2,'pcs_v2',$3,$1,$2,18,18,201,$4,'{}','unsupported')`,[unregisteredToken,token,other,hash(201)]);
  for(const status of ['unsupported','repair']){
    await db.query('UPDATE node_markets SET status=$1 WHERE id=\'registered-repair\'',[status]);
    await historicalRecovery.requestChart(unregisteredToken,{...unregisteredChart,from:new Date(headAt-15*60_000).toISOString(),to:new Date(headAt-5*60_000).toISOString()},{exactWindow:true});
    assert.ok((await db.query('SELECT to_at FROM node_import_chart_jobs WHERE token_address=$1',[unregisteredToken])).rows.every(row=>Date.parse(row.to_at)<=unregisteredTo),
      'Registered '+status+' markets are not misclassified as uncaptured onboarding history');
  }
  console.log('PASS unregistered old-market recovery beyond wallet monitoring, confirmed/fresh boundaries and registered repair separation');

  const mergeToken=`0x${'7'.repeat(40)}`,mergeMarket='mixed-resolution-market',mergeFrom='2026-10-18T12:00:00.000Z',mergeTo='2026-10-18T13:00:00.000Z';
  await db.query("INSERT INTO tokens(address,symbol,name) VALUES($1,'MERGE','Genuine interval merge')",[mergeToken]);
  await db.query(`INSERT INTO node_markets(id,token_address,quote_address,protocol,contract_address,token0,token1,decimals0,decimals1,
    authenticated_at_block,authenticated_block_hash,authentication,status)
    VALUES($1,$2,$3,'pcs_v2',$4,$2,$3,18,18,201,$5,'{}','active')`,[mergeMarket,mergeToken,token,other,hash(201)]);
  await db.query(`INSERT INTO node_market_ranges(market_id,from_block,to_block,from_hash,to_hash,from_at,to_at,complete)
    VALUES($1,7000,7100,$2,$3,$4,$5,true)`,[mergeMarket,hash(7000),hash(7100),mergeFrom,mergeTo]);
  const nativeMinute=async(minute:string,price:string,volume:string)=>db.query(`INSERT INTO node_market_candles(token_address,market_id,minute,open,high,low,close,volume_usd,observations,first_observation_at,last_observation_at)
    VALUES($1,$2,$3,$4,$4,$4,$4,$5,1,$3::timestamptz+interval '10 seconds',$3::timestamptz+interval '10 seconds')`,[mergeToken,mergeMarket,minute,price,volume]);
  await nativeMinute('2026-10-18T12:05:00Z','1','10');await nativeMinute('2026-10-18T12:35:00Z','2','5');
  const rawMinute=async(minute:string,index:number)=>db.query(`INSERT INTO node_market_raw_logs(market_id,block_number,block_hash,tx_hash,transaction_index,log_index,timestamp,log,decode_status)
    VALUES($1,$2,$3,$4,0,0,$5,'{}','missing_quote')`,[mergeMarket,7000+index,hash(7000+index),hash(8000+index),minute]);
  await rawMinute('2026-10-18T12:35:30Z',35);
  await qualifiedMarket.importObservations({token:mergeToken,importId:'actual-recovered-minute:interval:60',from:'2026-10-18T12:35:00Z',to:'2026-10-18T12:36:00Z',complete:true,
    observations:[{timestamp:'2026-10-18T12:35:00Z',intervalSeconds:60,priceUsd:'10',open:'10',high:'10',low:'10',close:'10',volumeUsd:'100'}]});
  let merged=await qualifiedMarket.chart(mergeToken,{from:mergeFrom,to:mergeTo,intervalSeconds:3600});
  assert.equal(merged.complete,true);assert.equal(merged.source,'mixed');assert.equal(merged.bars[0].source,'mixed');
  assert.deepEqual({open:merged.bars[0].open,high:merged.bars[0].high,low:merged.bars[0].low,close:merged.bars[0].close,volume:merged.bars[0].volumeUsd},
    {open:'1',high:'10',low:'1',close:'10',volume:'110'},'A recovered minute must contribute to its hour instead of disappearing behind an already aggregated node hour');
  assert.equal(merged.bars[0].firstObservationAt,'2026-10-18T12:05:10.000Z');assert.equal(merged.bars[0].lastObservationAt,'2026-10-18T12:36:00.000Z');
  await nativeMinute('2026-10-18T12:01:00Z','200','7');await nativeMinute('2026-10-18T12:50:00Z','3','30');await rawMinute('2026-10-18T12:01:30Z',1);
  await qualifiedMarket.importObservations({token:mergeToken,importId:'actual-five-minute:interval:300',from:mergeFrom,to:'2026-10-18T12:05:00Z',complete:true,
    observations:[{timestamp:mergeFrom,intervalSeconds:300,priceUsd:'4',open:'2',high:'4',low:'2',close:'4',volumeUsd:'50'}]});
  await qualifiedMarket.importObservations({token:mergeToken,importId:'overlapping-minute:interval:60',from:'2026-10-18T12:02:00Z',to:'2026-10-18T12:03:00Z',complete:true,
    observations:[{timestamp:'2026-10-18T12:02:00Z',intervalSeconds:60,priceUsd:'99',volumeUsd:'900'}]});
  merged=await qualifiedMarket.chart(mergeToken,{from:mergeFrom,to:mergeTo,intervalSeconds:3600});
  assert.equal(merged.complete,true);assert.equal(merged.source,'mixed');assert.equal(merged.bars[0].source,'mixed');
  assert.deepEqual({open:merged.bars[0].open,high:merged.bars[0].high,low:merged.bars[0].low,close:merged.bars[0].close,volume:merged.bars[0].volumeUsd},
    {open:'2',high:'10',low:'1',close:'3',volume:'190'},'A five-minute import replaces only actual overlapping intervals, while independent node minutes remain and volumes enter once');
  console.log('PASS fine imported/node merging before coarse aggregation, real interval precedence, endpoints and no doubled volume');
  console.log('Token chart recovery PostgreSQL integration passed; fake market requests only.');
} finally {
  await db.end();
  const resolved = path.resolve(directory), expected = path.resolve(tmpdir()) + path.sep;
  if (resolved.startsWith(expected) && path.basename(resolved).startsWith('kollens-chart-recovery-')) await rm(resolved, { recursive: true, force: true });
}
