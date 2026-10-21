/** Disposable local PostgreSQL only. No node, provider, messaging or live writes. */
import assert from 'node:assert/strict';
import pg from 'pg';
import {ensureNodeMarketSchema,createNodeMarketService,rollbackNodeMarket} from './nodeMarket.js';
import {backfillNodeMarketCoverage,pruneValidatedLegacyMarketCoverage,invalidateMarketCoverage} from './nodeMarketCoverage.js';
import type {Rpc} from './rpc.js';
const connection=new URL(process.env.DATABASE_URL||'');
if(!['localhost','127.0.0.1'].includes(connection.hostname)||connection.port!=='5435'
  ||!/^\/bscan_node_market_coverage_test_\d+$/.test(connection.pathname))throw new Error('Use a dedicated disposable bscan_node_market_coverage_test_<timestamp> database');
const db=new pg.Pool({connectionString:connection.href});
const hash=(n:number)=>`0x${n.toString(16).padStart(64,'0')}`,address=(n:number)=>`0x${n.toString(16).padStart(40,'0')}`;
const at=(n:number)=>new Date(Date.parse('2026-10-20T00:00:00Z')+n*1000).toISOString(),hex=(n:number)=>`0x${n.toString(16)}`;
const market=(n:number)=>`coverage:${n}`;
let failed=false;
const rpc:Rpc=async<T>(method:string,params:unknown[])=>{
  if(failed)throw new Error('test_node_failure');
  if(method==='eth_getLogs')return [] as T;
  if(method==='eth_getBlockByNumber'){const n=Number(BigInt(String(params[0])));return {number:hex(n),hash:hash(n),parentHash:hash(n-1),timestamp:hex(Date.parse(at(n))/1000)} as T;}
  throw new Error('unexpected_rpc');
};
async function addMarket(n:number){await db.query(`INSERT INTO node_markets(id,token_address,quote_address,protocol,contract_address,token0,token1,
  decimals0,decimals1,authenticated_at_block,authenticated_block_hash,authentication,status)
  VALUES($1,$2,$3,'pcs_v2',$4,$2,$3,18,18,0,$5,'{}','active')`,[market(n),address(100000+n),address(40000),address(50000),hash(0)]);}
async function legacy(n:number,from:number,to:number,complete=true){await db.query(`INSERT INTO node_market_ranges(market_id,from_block,to_block,from_hash,to_hash,from_at,to_at,complete)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[market(n),from,to,hash(from),hash(to),at(from),at(to),complete]);}
async function unions(n:number){return (await db.query(`SELECT complete,range_agg(int8range(from_block,to_block,'[]'))::text AS spans
  FROM node_market_coverage WHERE market_id=$1 GROUP BY complete ORDER BY complete`,[market(n)])).rows;}
async function migrateAll(){let completed=0;for(let i=0;i<200;i++){const result=await backfillNodeMarketCoverage(db,{limit:2});assert.ok(result.processed<=2);
  if(result.completed)completed++;if('idle'in result&&result.idle)return completed;}throw new Error('migration_did_not_finish');}
async function transaction(action:(db:pg.PoolClient)=>Promise<void>){const client=await db.connect();try{await client.query('BEGIN');
  await client.query('SELECT pg_advisory_xact_lock(782319)');await client.query('SELECT pg_advisory_xact_lock(908335)');
  await action(client);await client.query('COMMIT');}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}}
try{
  await ensureNodeMarketSchema(db);const coverageOid=(await db.query("SELECT 'node_market_coverage'::regclass::oid oid")).rows[0].oid;
  await ensureNodeMarketSchema(db);assert.equal((await db.query("SELECT 'node_market_coverage'::regclass::oid oid")).rows[0].oid,coverageOid);
  assert.equal((await db.query("SELECT count(*)::int n FROM pg_class WHERE relname LIKE 'node_market_coverage_legacy%'")).rows[0].n,0,'startup cannot archive the current coverage view repeatedly');
  await db.query(`CREATE TABLE node_evidence_blocks(block_number bigint PRIMARY KEY,block_hash text UNIQUE NOT NULL,parent_hash text NOT NULL,timestamp timestamptz NOT NULL);
    CREATE TABLE worker_state(key text PRIMARY KEY,value jsonb NOT NULL,updated_at timestamptz NOT NULL DEFAULT now());`);
  await db.query(`INSERT INTO node_evidence_blocks SELECT n,'0x'||lpad(to_hex(n),64,'0'),'0x'||lpad(to_hex(n-1),64,'0'),$1::timestamptz+n*interval '1 second'
      FROM generate_series(0,300)n`,[at(0)]);
  for(let n=1;n<=1000;n++)await addMarket(n);
  const service=createNodeMarketService({db,rpc});
  await service.collectRange(100,100,{liveCheckpoint:true});
  assert.equal((await db.query('SELECT count(*)::int n FROM node_market_collection_ranges')).rows[0].n,1,'one proof, not one thousand market/range rows');
  assert.equal((await db.query('SELECT count(*)::int n FROM node_market_ranges')).rows[0].n,0,'new capture never appends legacy fanout');
  assert.equal((await db.query('SELECT count(*)::int n FROM node_market_collection_members')).rows[0].n,1000);
  assert.equal((await db.query('SELECT count(*)::int n FROM node_markets WHERE collected_through_block IS NOT NULL')).rows[0].n,0,'forward capture avoids per-market summary updates');
  await service.collectRange(101,103,{liveCheckpoint:true});
  assert.equal((await db.query("SELECT count(*)::int n FROM node_market_collection_cohorts WHERE kind='set'")).rows[0].n,1,'unchanged memberships are reused');
  await addMarket(1001);await service.collectRange(104,104,{liveCheckpoint:true});
  assert.equal((await db.query('SELECT min(from_block)::text n FROM node_market_coverage WHERE market_id=$1',[market(1001)])).rows[0].n,'104','a new market cannot inherit historical scans');
  await service.collectRange(90,92,{marketIds:[market(1)]});
  assert.equal((await db.query('SELECT count(*)::int n FROM node_market_coverage WHERE market_id=$1 AND from_block=90',[market(2)])).rows[0].n,0,'targeted backfills cannot grant another market coverage');
  await Promise.all([service.collectRange(104,104,{liveCheckpoint:true}),service.collectRange(104,104,{liveCheckpoint:true})]);
  assert.equal((await db.query('SELECT count(*)::int n FROM node_market_collection_ranges')).rows[0].n,4,'concurrent duplicate capture is idempotent');
  failed=true;await assert.rejects(()=>service.collectRange(105,105,{liveCheckpoint:true}),/test_node_failure/);failed=false;
  assert.equal((await db.query("SELECT value->>'blockNumber' n FROM worker_state WHERE key='node_market_collection'")).rows[0].n,'104','a failed range never advances its atomic checkpoint');
  const initialMembers=(await db.query('SELECT count(*)::int n FROM node_market_collection_members')).rows[0].n;
  for(let n=1002;n<=1101;n++){await addMarket(n);await service.collectRange(104,104,{liveCheckpoint:true});}
  const discoveryMembers=(await db.query('SELECT count(*)::int n FROM node_market_collection_members')).rows[0].n-initialMembers;
  assert.ok(discoveryMembers<=100*129,'one hundred discoveries rewrite bounded immutable chunks, rather than copying the thousand-market roster');
  console.log(`100 discoveries added ${discoveryMembers} member rows; naive whole-roster cohorts would add over100,000.`);

  await legacy(1,10,10);await legacy(1,11,11);await legacy(1,12,14);await legacy(1,20,21);await legacy(1,15,19,false);
  const expected=await unions(1),sourceCount=(await db.query('SELECT count(*)::int n FROM node_market_ranges')).rows[0].n;
  const first=await backfillNodeMarketCoverage(db,{limit:2});assert.equal(first.processed,2);
  assert.deepEqual(await unions(1),expected,'an interrupted import retains full legacy coverage');
  await Promise.all([backfillNodeMarketCoverage(db,{limit:2}),backfillNodeMarketCoverage(db,{limit:2})]);await migrateAll();
  assert.deepEqual(await unions(1),expected,'compaction preserves both complete and explicitly incomplete exact range unions');
  assert.equal((await db.query('SELECT count(*)::int n FROM node_market_ranges')).rows[0].n,sourceCount,'source records are kept until separate parity-approved pruning');
  const migration=(await db.query('SELECT * FROM node_market_coverage_migrations WHERE market_id=$1',[market(1)])).rows[0];
  assert.ok(migration.completed_at);assert.equal(migration.state.expectedHash,migration.state.actualHash);
  assert.equal(migration.state.expectedCount,3,'three genuine spans include the incomplete interval; no gap is filled');
  await assert.rejects(()=>db.query('UPDATE node_market_collection_ranges SET to_at=to_at+interval \'1 second\' WHERE legacy_market_id=$1',[market(1)]),/market_coverage_immutable/);
  await assert.rejects(()=>db.query('DELETE FROM node_market_collection_members WHERE market_id=$1',[market(1)]),/market_coverage_immutable/,
    'published membership and parity-validated compacted ranges cannot be changed before pruning');
  const pruned=await pruneValidatedLegacyMarketCoverage(db,{limit:2});assert.equal(pruned.removed,2);
  assert.deepEqual(await unions(1),expected,'validated bounded pruning preserves all coverage and original boundary values');
  while((await pruneValidatedLegacyMarketCoverage(db,{limit:2})).removed){}
  await assert.rejects(()=>legacy(1,22,22),/market_legacy_coverage_retired/,'an old writer cannot invalidate a retired source revision');
  await legacy(4,23,24);
  await assert.rejects(()=>db.query('UPDATE node_market_ranges SET market_id=$1 WHERE market_id=$2',[market(1),market(4)]),/market_legacy_coverage_retired/,
    'reassigning a row into a retired destination must be rejected too');
  await legacy(5,25,26);await migrateAll();
  await db.query('UPDATE node_market_ranges SET market_id=$1 WHERE market_id=$2',[market(5),market(4)]);
  assert.equal((await db.query('SELECT completed_at FROM node_market_coverage_migrations WHERE market_id=$1',[market(5)])).rows[0].completed_at,null,
    'a destination scope must be invalidated even though its rows were absent from the OLD transition table');
  await migrateAll();assert.equal((await unions(5)).find(row=>row.complete)?.spans,'{[23,27),[100,105)}');

  await legacy(2,30,40);await backfillNodeMarketCoverage(db,{limit:1});
  await transaction(client=>rollbackNodeMarket(client,35));
  await migrateAll();
  assert.ok(!(await unions(2)).some(row=>row.spans.includes('41')),'a resumed migration cannot resurrect orphaned coverage');
  assert.equal((await db.query('SELECT max(to_block)::text n FROM node_market_coverage WHERE market_id=$1',[market(2)])).rows[0].n,'34','a reorg preserves the genuine older prefix');
  await transaction(client=>invalidateMarketCoverage(client,31,32));
  assert.deepEqual((await unions(2)).find(row=>row.complete)?.spans,'{[30,31),[33,35)}','an explicit gap splits coverage without dropping the valid suffix');
  const ends=(await db.query('SELECT from_block::text,to_block::text,from_hash,to_hash FROM node_market_coverage WHERE market_id=$1 AND complete ORDER BY from_block',[market(2)])).rows;
  assert.ok(ends.some(row=>row.to_block==='30'&&row.to_hash===hash(30))&&ends.some(row=>row.from_block==='33'&&row.from_hash===hash(33)),'split endpoints use canonical saved hashes');

  await legacy(3,50,52);await migrateAll();const previousRevision=(await db.query('SELECT revision FROM node_market_coverage_migrations WHERE market_id=$1',[market(3)])).rows[0].revision;
  await legacy(3,53,54);assert.equal((await db.query('SELECT completed_at FROM node_market_coverage_migrations WHERE market_id=$1',[market(3)])).rows[0].completed_at,null,'an older writer invalidates an unretired migrated revision');
  await migrateAll();assert.notEqual((await db.query('SELECT revision FROM node_market_coverage_migrations WHERE market_id=$1',[market(3)])).rows[0].revision,previousRevision);
  assert.equal((await unions(3)).find(row=>row.complete)?.spans,'{[50,55)}');
  // Authentic old per-block endpoints survive pruning even when full durable
  // headers were never captured for that older period.
  for(let n=60;n<=70;n++)await legacy(6,n,n);
  await migrateAll();while((await pruneValidatedLegacyMarketCoverage(db,{limit:5})).removed){}
  await db.query('DELETE FROM node_evidence_blocks WHERE block_number BETWEEN 60 AND 70');
  await transaction(client=>invalidateMarketCoverage(client,64,65));
  assert.equal((await unions(6)).find(row=>row.complete)?.spans,'{[60,64),[66,71)}');
  await transaction(client=>rollbackNodeMarket(client,68));assert.equal((await unions(6)).find(row=>row.complete)?.spans,'{[60,64),[66,68)}');
  await legacy(7,75,85);await migrateAll();while((await pruneValidatedLegacyMarketCoverage(db,{limit:5})).removed){}
  await db.query('DELETE FROM node_evidence_blocks WHERE block_number BETWEEN 76 AND 84');
  await transaction(client=>rollbackNodeMarket(client,80));
  assert.equal((await unions(7)).find(row=>row.complete)?.spans,'{[75,76)}','unknown interior endpoints retain the maximal authentic prefix and leave an explicit gap without blocking rollback');
  await legacy(8,210,220);await legacy(8,210,214,false);await backfillNodeMarketCoverage(db,{limit:1});
  await transaction(client=>invalidateMarketCoverage(client,215,219));
  assert.equal((await unions(8)).find(row=>row.complete)?.spans,'{[210,215),[220,221)}',
    'a complete surviving prefix cannot disappear on conflict with an older incomplete row of identical bounds');
  await migrateAll();
  await legacy(9,240,250);await legacy(9,240,260);
  await db.query('UPDATE node_market_ranges SET from_at=$1 WHERE market_id=$2 AND to_block=260',[at(255),market(9)]);
  await assert.rejects(()=>backfillNodeMarketCoverage(db,{limit:10}),/market_coverage_legacy_time_conflict/,
    'contradictory times at a shared height cannot manufacture continuous time coverage');
  assert.equal((await db.query('SELECT completed_at FROM node_market_coverage_migrations WHERE market_id=$1',[market(9)])).rows[0].completed_at,null);
  await db.query('DELETE FROM node_market_ranges WHERE market_id=$1',[market(9)]);
  await legacy(9,240,260);await legacy(9,245,250);
  await db.query('UPDATE node_market_ranges SET from_at=$1,to_at=$2 WHERE market_id=$3 AND from_block=245',[at(270),at(275),market(9)]);
  await assert.rejects(()=>backfillNodeMarketCoverage(db,{limit:10}),/market_coverage_legacy_time_conflict/,'impossible nested endpoint times remain unvalidated');
  await db.query('DELETE FROM node_market_ranges WHERE market_id=$1',[market(9)]);await migrateAll();
  while((await pruneValidatedLegacyMarketCoverage(db,{limit:5})).removed){}

  // Pause the actual pruning helper after locking its validated scope. An old
  // writer must wait BEFORE inserting, then reject after retirement commits.
  await legacy(10,270,271);await migrateAll();
  const pruningClient=await db.connect(),oldWriter=await db.connect();
  let enterPrune!:()=>void,releasePrune!:()=>void;const enteredPrune=new Promise<void>(resolve=>{enterPrune=resolve;});
  const continuePrune=new Promise<void>(resolve=>{releasePrune=resolve;});
  const wrapped=new Proxy(pruningClient,{get(target,key){if(key==='query')return async(text:string,values?:unknown[])=>{
    const result=await target.query(text,values);if(text.includes('SELECT s.market_id')){enterPrune();await continuePrune;}return result;};
    const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
  const prune=pruneValidatedLegacyMarketCoverage({connect:async()=>wrapped} as Pick<pg.Pool,'connect'>,{limit:5});
  await enteredPrune;const writerPid=(await oldWriter.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  const pendingWrite=oldWriter.query(`INSERT INTO node_market_ranges(market_id,from_block,to_block,from_hash,to_hash,from_at,to_at,complete)
    VALUES($1,272,272,$2,$2,$3,$3,true)`,[market(10),hash(272),at(272)]).then(()=>null,error=>error as Error);
  await new Promise(resolve=>setTimeout(resolve,25));
  assert.equal((await db.query('SELECT wait_event FROM pg_stat_activity WHERE pid=$1',[writerPid])).rows[0].wait_event,'advisory',
    'legacy mutation acquires the maintenance lock before its row locks');
  releasePrune();assert.equal((await prune).removed,1);
  assert.match(String(await pendingWrite),/market_legacy_coverage_retired/,'a waiting writer cannot hide newly pruned compact history');oldWriter.release();
  assert.equal((await unions(10)).find(row=>row.complete)?.spans,'{[270,272)}');
  await transaction(client=>rollbackNodeMarket(client,13));
  assert.equal((await unions(1)).find(row=>row.complete)?.spans,'{[10,13)}','reorg after full legacy pruning keeps the compacted historical prefix');
  await ensureNodeMarketSchema(db);assert.equal((await unions(1)).find(row=>row.complete)?.spans,'{[10,13)}','repeated startup never resets migrated evidence');
  console.log('Node market coverage integration passed: 1,000-market fanout removed; migration, exact unions, pruning, concurrent capture, gaps and reorgs verified.');
}finally{await db.end();}
