/** Real PostgreSQL, fake market transport, no node, Telegram or wallet API. */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pool as db, ensureSchema } from './db.js';
import { createNodeMarketService, readNodeMarketChart } from './nodeMarket.js';
import { createTokenChartRecovery } from './nodeTokenChartRecovery.js';
import { migrateSavedTokenCharts } from './importSavedTokenCharts.js';
import { MarketProviderDeferred } from './geckoApi.js';
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
    return { data: [candle(from, 4), candle(to, 5)] };
  };
  const recovery = createTokenChartRecovery({ db, market, request: request as never, now: () => now });
  const window = { from: boundary - 60_000, to: now, seconds: 60 };
  const queued = await recovery.requestWindow(token, window); assert.equal(queued.pending, true);
  await recovery.requestWindow(token, window);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM node_import_chart_jobs')).rows[0].n, 1, 'visitors share one normalized segment');
  const entered = new Promise<void>(resolve => { enter = resolve; }); blocked = new Promise<void>(resolve => { release = resolve; });
  const active = recovery.tick(); await entered;
  assert.equal((await recovery.tick()).status, 'idle', 'a second worker cannot dispatch the leased segment');
  release!(); assert.equal((await active).status, 'progress'); assert.equal(calls, 1);
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
  console.log('Token chart recovery PostgreSQL integration passed; fake market requests only.');
} finally {
  await db.end();
  const resolved = path.resolve(directory), expected = path.resolve(tmpdir()) + path.sep;
  if (resolved.startsWith(expected) && path.basename(resolved).startsWith('kollens-chart-recovery-')) await rm(resolved, { recursive: true, force: true });
}
