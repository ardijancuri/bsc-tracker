// Curated public evidence from the reported closed trade. No live transports.
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {MockAgent,getGlobalDispatcher,setGlobalDispatcher} from 'undici';
import position from './fixtures/closed-replay-position.json' with {type:'json'};
import evidence from './fixtures/closed-replay-market-db.json' with {type:'json'};
import type {KolTokenActivity} from '../shared/kolTokenTrades.js';

const target=new URL(process.env.DATABASE_URL??'');
if(!['127.0.0.1','localhost'].includes(target.hostname)||target.port!=='5435'||!/^\/bscan_closed_replay_test_\d+$/.test(target.pathname))
  throw Error('Use a fresh local disposable bscan_closed_replay_test database');
const originalNow=Date.now,originalDispatcher=getGlobalDispatcher(),blocked=new MockAgent();
blocked.disableNetConnect();setGlobalDispatcher(blocked);Date.now=()=>Date.parse(position.frozenAt);
const {pool,ensureSchema}=await import('./db.js');
const {nodeMarketService}=await import('./nodeMarket.js');
const {createNodeReplayPreparation}=await import('./nodeReplayPreparation.js');
const browserContract='../src/tradeReplayData.ts';
const {prepareTradeReplayData,applyReplayMarketChart,validReplayAccountingFinal}=await import(browserContract);
const tables=['node_evidence_blocks','node_markets','node_market_observations','node_market_candles','node_market_ranges','node_market_raw_logs'] as const;
try{
  await ensureSchema();
  await pool.query('INSERT INTO tokens(address,name,symbol,decimals) VALUES($1,$2,$3,18)',[position.token,position.activity.token.name,position.activity.token.symbol]);
  for(const table of tables)for(const source of evidence.tables[table]){
    const row=table==='node_evidence_blocks'?{header:{},...source}:source;
    const columns=Object.keys(row);assert.ok(columns.every(column=>/^[a-z_][a-z_0-9]*$/.test(column)));
    await pool.query(`INSERT INTO ${table}(${columns.join(',')}) SELECT ${columns.join(',')} FROM jsonb_populate_record(NULL::${table},$1::jsonb) ON CONFLICT DO NOTHING`,[JSON.stringify(row)]);
  }
  const activity=structuredClone(position.activity) as KolTokenActivity;
  const chart=await nodeMarketService.chart(position.token,{from:evidence.from,to:evidence.to,intervalSeconds:60});
  const {backfillNodeMarketCoverage,pruneValidatedLegacyMarketCoverage}=await import('./nodeMarketCoverage.js');
  const protectedTables=['node_market_observations','node_market_candles','node_market_raw_logs'] as const;
  const protectedRows=async()=>Promise.all(protectedTables.map(async table=>(await pool.query(`SELECT count(*)::text AS count,
    bit_xor(hashtextextended(row_to_json(t)::text,721683))::text AS checksum FROM ${table} t`)).rows[0]));
  const savedRows=await protectedRows();
  let completed=false;
  for(let attempt=0;attempt<100;attempt++){
    const migration=await backfillNodeMarketCoverage(pool,{limit:10});
    if(migration.idle){completed=true;break;}
  }
  assert.ok(completed,'Legacy replay coverage migration finishes in bounded pages');
  for(let attempt=0;attempt<100;attempt++){
    const pruning=await pruneValidatedLegacyMarketCoverage(pool,{limit:10});
    if(pruning.idle)break;
  }
  assert.equal((await pool.query('SELECT count(*)::int n FROM node_market_ranges')).rows[0].n,0,
    'This replay is prepared entirely from compacted coverage after old range rows retire');
  const compactedChart=await nodeMarketService.chart(position.token,{from:evidence.from,to:evidence.to,intervalSeconds:60});
  assert.deepEqual(compactedChart.bars,chart.bars,'Genuine historical candles and prices remain identical');
  assert.equal(compactedChart.complete,chart.complete);
  assert.deepEqual(await protectedRows(),savedRows,'Compaction preserves every observation, candle and pending raw log');
  assert.equal(chart.complete,false,'The pending original closing swaps must not become a completed candle projection');
  assert.ok(Date.parse(chart.bars.at(-1)?.lastObservationAt??'')<Date.parse(evidence.to),'The curated incomplete node projection ends before the sale');
  let recoveries=0;
  const service=createNodeReplayPreparation({market:nodeMarketService,recovery:{requestChart:async()=>{recoveries++;return {pending:true};}}});
  const [preparation,joined]=await Promise.all([service.prepare(activity),service.prepare(structuredClone(activity))]);
  if(preparation.status!=='ready'&&process.env.NODE_CLOSED_REPLAY_ARTIFACT)await writeFile(process.env.NODE_CLOSED_REPLAY_ARTIFACT+'.debug.json',JSON.stringify({chart,preparation,
    samples:await nodeMarketService.replaySamples(position.token,{from:evidence.from,to:new Date(Date.parse(evidence.to)+180_000).toISOString(),limit:5000})},null,2));
  assert.equal(preparation,joined,'Concurrent consumers coalesce the same frozen window');
  assert.equal(preparation.status,'ready',JSON.stringify({reason:preparation.reason,stages:preparation.stages}));
  assert.equal(recoveries,0,'Already captured bracketing prices need neither provider requests nor historical imports');
  assert.equal(preparation.window?.from,evidence.from);assert.equal(preparation.window?.to,evidence.to);
  assert.equal(preparation.chart?.points.at(-1)?.timestamp,'2026-10-20T12:20:24.000Z');
  const base=prepareTradeReplayData(activity,null,undefined,Date.now());assert.ok(base);
  const rendered=applyReplayMarketChart(base,preparation.chart,Date.now()),final=validReplayAccountingFinal(rendered,Date.now());
  assert.ok(final);assert.equal(rendered.chart.points.at(-1)?.timestamp,evidence.to);
  assert.equal(final.reportedProfitUsd,Number(activity.realizedAccounting!.realizedProfitUsd));
  assert.equal(final.reportedRoi,Number(activity.realizedAccounting!.position!.estimatedRoi));
  assert.equal(rendered.inventory.events.length,13);
  if(process.env.NODE_CLOSED_REPLAY_ARTIFACT)await writeFile(process.env.NODE_CLOSED_REPLAY_ARTIFACT,JSON.stringify({frozenAt:position.frozenAt,activity,
    summary:{estimatedProfitUsd:activity.realizedAccounting!.position!.estimatedProfitUsd,roi:activity.realizedAccounting!.position!.estimatedRoi},preparation},null,2));
  // The same receipts/coverage do not authorize carrying a prior price beyond
  // closure when the genuinely later bracket is absent.
  await pool.query('DELETE FROM node_market_observations WHERE token_address=$1 AND timestamp>$2',[position.token,evidence.to]);
  assert.equal((await service.prepare(activity)).status,'pending');assert.ok(recoveries>0);
  assert.equal((await pool.query('SELECT count(*)::int n FROM node_market_raw_logs')).rows[0].n,4,'Preparation preserves pending canonical raw evidence');
  assert.equal((await pool.query('SELECT count(*)::int n FROM node_import_jobs')).rows[0].n,0,'A node-accounted replay does not need a wallet import record');
  console.log(JSON.stringify({result:'Captured closed replay PostgreSQL integration passed',movements:13,profit:final.reportedProfitUsd,roi:final.reportedRoi,
    snapshot:preparation.snapshotId,points:preparation.chart?.points.length,ending:evidence.to,externalProvidersDisabled:true}));
}finally{await pool.end();Date.now=originalNow;setGlobalDispatcher(originalDispatcher);await blocked.close();}
