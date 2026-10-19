import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { drainNodeEvidenceMetadata, enqueueNodeEvidenceMetadata, enqueueNodeEvidenceMetadataCheckpoints, ensureNodeEvidenceMetadataSchema } from './nodeEvidenceMetadata.js';
import type { CollectedNodeEvidence } from './nodeEvidence.js';
import { transferTopic } from './swap.js';

const configured = new URL(process.env.DATABASE_URL ?? 'postgres://invalid');
if (!['localhost', '127.0.0.1'].includes(configured.hostname) || configured.port !== '5435') throw new Error('Disposable local PostgreSQL only');
const admin = new pg.Client({ connectionString: configured.href }); await admin.connect();
const name = `node_metadata_test_${randomUUID().replaceAll('-', '')}`;
await admin.query(`CREATE DATABASE "${name}"`);
const target = new URL(configured); target.pathname = `/${name}`;
const database = new pg.Pool({ connectionString: target.href, max: 6 });
const wallet = `0x${'a'.repeat(40)}`, other = `0x${'b'.repeat(40)}`;
const token = (n: number) => `0x${n.toString(16).padStart(40, '0')}`, hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
const now = Math.floor(Date.now() / 1000);
function entry(height: number, tokens: string[], observedLive: boolean): CollectedNodeEvidence {
  const timestamp = height === 1 ? now - 3600 : now - 10;
  const transaction = { hash: hash(height + 100), from: wallet, to: other, value: '0x0', blockNumber: `0x${height.toString(16)}`, blockHash: hash(height), transactionIndex: '0x0' };
  return { transaction, block: { number: transaction.blockNumber, hash: hash(height), parentHash: hash(height - 1), timestamp: `0x${timestamp.toString(16)}`, transactions: [transaction] },
    receipt: { transactionHash: transaction.hash, blockNumber: transaction.blockNumber, blockHash: hash(height), status: '0x1', logs: tokens.map((address, index) => ({
      address, topics: [transferTopic, `0x${other.slice(2).padStart(64, '0')}`, `0x${wallet.slice(2).padStart(64, '0')}`], data: '0x1', logIndex: `0x${index.toString(16)}`,
    })) }, wallets: new Set([wallet]), observedLive };
}
try {
  await database.query(`CREATE TABLE node_evidence_blocks(block_number bigint PRIMARY KEY,block_hash text UNIQUE NOT NULL,timestamp timestamptz NOT NULL DEFAULT to_timestamp(${now - 10}))`);
  await ensureNodeEvidenceMetadataSchema(database);
  for (let n = 1; n <= 5; n++) await database.query('INSERT INTO node_evidence_blocks VALUES($1::bigint,$2)', [n, hash(n)]);
  await database.query('UPDATE node_evidence_blocks SET timestamp=to_timestamp($1) WHERE block_number=1',[now-3600]);
  const manyTokens = Array.from({ length: 45 }, (_, i) => token(i + 1));
  const fresh = entry(2, manyTokens, true);
  // Unrelated transfer logs in the same receipt never expand private monitoring.
  fresh.receipt.logs.push({ address: token(999), topics: [transferTopic, `0x${other.slice(2).padStart(64, '0')}`, `0x${other.slice(2).padStart(64, '0')}`], data: '0x1' });
  await enqueueNodeEvidenceMetadata(database, [entry(1, [token(70)], false), fresh, entry(2, [token(1)], false), entry(3, [], false)]);
  const queued = (await database.query('SELECT * FROM node_evidence_metadata_jobs WHERE block_number=2')).rows[0];
  assert.equal(queued.tokens.length, 45); assert.equal(queued.observed_live, true);
  assert.equal((await database.query('SELECT count(*)::int n FROM node_evidence_metadata_jobs')).rows[0].n, 3, 'Receipt fees enqueue work even without ERC20 transfers');
  const calls: string[][] = [],feedScopes:string[][]=[]; let chunk = 0;
  const partial = await drainNodeEvidenceMetadata({ database,
    captureFeedEvidence: async (checkpoint,tokens=[]) => { assert.equal(checkpoint.blockNumber, 2);feedScopes.push(tokens); return { requested: 3, captured: 3 }; },
    captureMetadata: async (tokens, checkpoint) => {
      assert.equal(checkpoint.blockNumber, 2); calls.push(tokens);
      if (chunk++ === 1) throw new Error('partial RPC outage');
      const capturedTokens = chunk === 1 ? tokens.slice(1) : tokens;
      return { requested: tokens.length, captured: capturedTokens.length, capturedTokens };
    } });
  assert.deepEqual(calls.map(tokens => tokens.length), [20, 20, 5], 'All token chunks are attempted, with no silent twenty-token truncation');
  assert.deepEqual(feedScopes.map(tokens=>tokens.length),[20,20,5]);
  assert.deepEqual(feedScopes.flat(),queued.tokens,'All transferred-token scopes reach exact-block quote dependency capture');
  assert.equal(partial.capturedTokens, 24); assert.equal(partial.waiting, 1);
  const progress = (await database.query('SELECT * FROM node_evidence_metadata_jobs WHERE block_number=2')).rows[0];
  assert.equal(progress.feed_complete, true); assert.equal(progress.completed_tokens.length, 24); assert.equal(progress.lease_id, null);
  assert.equal(progress.last_error, 'token_metadata_unavailable');
  await enqueueNodeEvidenceMetadata(database, [entry(2, [token(46)], true)]);
  let feedRetried = false; const pending: string[] = [];
  const resumed = await drainNodeEvidenceMetadata({ database,
    captureFeedEvidence: async () => { feedRetried = true; return { requested: 3, captured: 3 }; },
    captureMetadata: async tokens => { pending.push(...tokens); return { requested: tokens.length, captured: tokens.length, capturedTokens: tokens }; } });
  assert.equal(feedRetried, true, 'A newly coalesced token rechecks its quote dependencies even when pinned feeds were already captured');
  assert.equal(resumed.completed, 1); assert.equal(pending.length, 22);
  assert.ok(pending.every(address => !progress.completed_tokens.includes(address)), 'Successful token progress survives a partial failure and coalesced addition');
  assert.equal((await database.query('SELECT cardinality(completed_tokens) n FROM node_evidence_metadata_jobs WHERE block_number=2')).rows[0].n, 46);
  assert.ok((await database.query('SELECT count(*)::int n FROM node_token_identity_jobs WHERE completed_at IS NULL')).rows[0].n>0,
    'Optional token-name work remains independently pending after financial precision/feed capture completes');

  const checkpoints: number[] = [];
  const transport = { database, captureFeedEvidence: async (checkpoint: { blockNumber: number }) => {
    checkpoints.push(checkpoint.blockNumber); return { requested: 3, captured: checkpoint.blockNumber === 1 ? 0 : 3 };
  }, captureMetadata: async (tokens: string[]) => ({ requested: tokens.length, captured: 0, capturedTokens: [] }) };
  const concurrent = await Promise.all([drainNodeEvidenceMetadata(transport), drainNodeEvidenceMetadata(transport)]);
  assert.equal(new Set(checkpoints).size, 2, 'Independent workers lease different block jobs');
  assert.equal(concurrent.reduce((sum, result) => sum + result.completed, 0), 1);
  const old = (await database.query('SELECT * FROM node_evidence_metadata_jobs WHERE block_number=1')).rows[0];
  assert.equal(old.last_error, 'historical_token_metadata_unavailable');
  assert.ok(old.next_attempt_at.getTime() > Date.now() + 20_000, 'Unavailable old state has explicit bounded backoff');
  assert.equal(old.completed_at, null);

  await enqueueNodeEvidenceMetadata(database, [entry(4, [token(90)], true)]);
  const orphan = await drainNodeEvidenceMetadata({ database,
    captureFeedEvidence: async () => { await database.query('DELETE FROM node_evidence_blocks WHERE block_number=4'); return { requested: 3, captured: 3 }; },
    captureMetadata: async tokens => ({ requested: tokens.length, captured: tokens.length, capturedTokens: tokens }) });
  assert.equal(orphan.completed, 0); assert.equal((await database.query('SELECT count(*)::int n FROM node_evidence_metadata_jobs WHERE block_number=4')).rows[0].n, 0,
    'Reorg deletion cascades to leased jobs and completion never recreates an orphan');

  await enqueueNodeEvidenceMetadata(database, [entry(5, [token(91)], true)]);
  await drainNodeEvidenceMetadata({ database,
    captureFeedEvidence: async () => ({ requested: 3, captured: 3 }),
    captureMetadata: async tokens => {
      await enqueueNodeEvidenceMetadata(database, [entry(5, [token(92)], true)]);
      return { requested: tokens.length, captured: tokens.length, capturedTokens: tokens };
    } });
  const appended = (await database.query('SELECT * FROM node_evidence_metadata_jobs WHERE block_number=5')).rows[0];
  assert.deepEqual(appended.tokens, [token(91), token(92)]); assert.deepEqual(appended.completed_tokens, [token(91)]);
  assert.equal(appended.completed_at, null, 'A token appended during RPC cannot be falsely marked complete');
  await database.query("UPDATE node_evidence_metadata_jobs SET next_attempt_at=now()+interval '1 hour' WHERE block_number=5");
  await database.query('INSERT INTO node_evidence_blocks VALUES(6,$1),(7,$2)',[hash(6),hash(7)]);
  await enqueueNodeEvidenceMetadata(database,[entry(6,[token(93)],true)]);
  await database.query("UPDATE node_evidence_metadata_jobs SET next_attempt_at=now()-interval '10 seconds' WHERE block_number=6");
  await enqueueNodeEvidenceMetadata(database,[entry(7,[token(94)],true)]);
  const earliest:number[]=[];
  await drainNodeEvidenceMetadata({database,
    captureFeedEvidence:async checkpoint=>{earliest.push(checkpoint.blockNumber);return{requested:3,captured:3};},
    captureMetadata:async tokens=>({requested:tokens.length,captured:tokens.length,capturedTokens:tokens})});
  assert.deepEqual(earliest,[6],'The earliest still-usable checkpoint is captured before newer arrivals can push it beyond the state window');
  assert.equal((await database.query('SELECT completed_at FROM node_evidence_metadata_jobs WHERE block_number=7')).rows[0].completed_at,null);
  await drainNodeEvidenceMetadata({database,captureFeedEvidence:async()=>({requested:3,captured:3}),
    captureMetadata:async tokens=>({requested:tokens.length,captured:tokens.length,capturedTokens:tokens})});
  await database.query('INSERT INTO node_evidence_blocks VALUES(8,$1),(9,$2)',[hash(8),hash(9)]);
  await enqueueNodeEvidenceMetadata(database,[entry(8,[token(95)],true)]);
  await drainNodeEvidenceMetadata({database,
    captureFeedEvidence:async(_checkpoint,tokens)=>{assert.deepEqual(tokens,[token(95)]);return{requested:4,captured:3,quoteRequested:1,quoteCaptured:0};},
    captureMetadata:async tokens=>({requested:tokens.length,captured:tokens.length,capturedTokens:tokens})});
  const missingQuote=(await database.query('SELECT * FROM node_evidence_metadata_jobs WHERE block_number=8')).rows[0];
  assert.equal(missingQuote.feed_complete,false);assert.equal(missingQuote.completed_at,null);assert.equal(missingQuote.last_error,'quote_evidence_unavailable');
  await database.query("UPDATE node_evidence_metadata_jobs SET next_attempt_at=now()-interval '1 second' WHERE block_number=8");
  let repeatedMetadata=false;
  await drainNodeEvidenceMetadata({database,
    captureFeedEvidence:async()=>({requested:4,captured:4,quoteRequested:1,quoteCaptured:1}),
    captureMetadata:async tokens=>{repeatedMetadata=true;return{requested:tokens.length,captured:tokens.length,capturedTokens:tokens};}});
  assert.equal(repeatedMetadata,false,'A quote-only retry reuses completed token precision capture');
  assert.ok((await database.query('SELECT completed_at FROM node_evidence_metadata_jobs WHERE block_number=8')).rows[0].completed_at);
  await enqueueNodeEvidenceMetadata(database,[entry(9,[token(96)],true)]);
  await drainNodeEvidenceMetadata({database,
    captureFeedEvidence:async()=>{await enqueueNodeEvidenceMetadata(database,[entry(9,[token(97)],true)]);return{requested:4,captured:4};},
    captureMetadata:async tokens=>({requested:tokens.length,captured:tokens.length,capturedTokens:tokens})});
  const changedScope=(await database.query('SELECT * FROM node_evidence_metadata_jobs WHERE block_number=9')).rows[0];
  assert.equal(changedScope.feed_complete,false,'A token appended during feed RPC must not inherit proofs for the previous scope');
  assert.equal(changedScope.completed_at,null);
  await database.query("UPDATE node_evidence_metadata_jobs SET next_attempt_at=now()+interval '1 hour' WHERE block_number=9");
  const checkpoint = (blockNumber: number, tokens: string[], observedLive = true) => ({ blockNumber, blockHash: hash(blockNumber), timestamp: new Date((now-10)*1000).toISOString(), tokens, observedLive });
  await database.query('INSERT INTO node_evidence_blocks VALUES(10,$1),(11,$2),(12,$3)',[hash(10),hash(11),hash(12)]);
  const ignored = await enqueueNodeEvidenceMetadataCheckpoints(database,[
    checkpoint(999,[token(100)]), // No permanently retained header.
    {...checkpoint(10,[token(100)]),blockHash:hash(11)},
    {...checkpoint(10,[token(100)]),timestamp:new Date(now*1000).toISOString()},
  ]);
  assert.deepEqual(ignored,{requested:3,queued:0},'Missing, contradictory and wrongly timed header proofs cannot create market jobs');
  const connection=await database.connect();
  try {
    await connection.query('BEGIN');
    await enqueueNodeEvidenceMetadataCheckpoints(connection,[checkpoint(10,[token(100)])]);
    await connection.query('ROLLBACK');
  } finally {connection.release();}
  assert.equal((await database.query('SELECT count(*)::int n FROM node_evidence_metadata_jobs WHERE block_number=10')).rows[0].n,0,
    'A failed market range rolls back its urgent metadata job in the same transaction');
  await enqueueNodeEvidenceMetadataCheckpoints(database,[checkpoint(11,[token(101)],false),checkpoint(11,[token(102),token(101)],true),checkpoint(12,[token(103)])]);
  const marketScope=(await database.query('SELECT * FROM node_evidence_metadata_jobs WHERE block_number=11')).rows[0];
  assert.deepEqual(marketScope.tokens,[token(101),token(102)]);assert.equal(marketScope.observed_live,true);
  const selectedMarketBlocks:number[]=[];
  await drainNodeEvidenceMetadata({database,
    captureFeedEvidence:async checkpoint=>{selectedMarketBlocks.push(checkpoint.blockNumber);return{requested:3,captured:3};},
    captureMetadata:async tokens=>({requested:tokens.length,captured:tokens.length,capturedTokens:tokens})});
  assert.deepEqual(selectedMarketBlocks,[11],'Authenticated market jobs share the same earliest-deadline queue as wallet jobs');
  await drainNodeEvidenceMetadata({database,captureFeedEvidence:async()=>({requested:3,captured:3}),
    captureMetadata:async tokens=>({requested:tokens.length,captured:tokens.length,capturedTokens:tokens})});
  await database.query('INSERT INTO node_evidence_blocks VALUES(13,$1),(14,$2)',[hash(13),hash(14)]);
  await enqueueNodeEvidenceMetadataCheckpoints(database,[checkpoint(13,[token(104)]),checkpoint(14,[token(105)])]);
  const selectedPriorityBlocks:number[]=[];
  const priorityTransport={database,
    captureFeedEvidence:async(checkpoint:{blockNumber:number})=>{selectedPriorityBlocks.push(checkpoint.blockNumber);return{requested:3,captured:3};},
    captureMetadata:async(tokens:string[])=>({requested:tokens.length,captured:tokens.length,capturedTokens:tokens})};
  await drainNodeEvidenceMetadata({...priorityTransport,priorityTokens:[token(104).toUpperCase(),token(104),'invalid']});
  assert.deepEqual(selectedPriorityBlocks,[13],'Fresh selected-token evidence dispatches before newer unrelated live jobs');
  selectedPriorityBlocks.length=0;
  await database.query("UPDATE node_evidence_metadata_jobs SET next_attempt_at=now()-interval '1 minute' WHERE block_number=1");
  await drainNodeEvidenceMetadata({...priorityTransport,priorityTokens:[token(70)]});
  assert.deepEqual(selectedPriorityBlocks,[14],'A historical priority match cannot steal the fresh node-state capture window');
  await database.query('INSERT INTO node_evidence_blocks VALUES(15,$1),(200,$2),(201,$3),(202,$4)',[hash(15),hash(200),hash(201),hash(202)]);
  await enqueueNodeEvidenceMetadataCheckpoints(database,[checkpoint(15,[token(106)]),checkpoint(200,[token(107)])]);
  selectedPriorityBlocks.length=0;
  await drainNodeEvidenceMetadata({...priorityTransport,priorityTokens:[token(106)]});
  assert.deepEqual(selectedPriorityBlocks,[200],'Selected work beyond the retained128-block state horizon cannot outrank ordinary fresh work even with a recent timestamp');
  await enqueueNodeEvidenceMetadataCheckpoints(database,[checkpoint(201,[token(108)]),checkpoint(202,[token(109)])]);
  selectedPriorityBlocks.length=0;
  await drainNodeEvidenceMetadata({...priorityTransport,priorityTokens:[token(108)]});
  assert.deepEqual(selectedPriorityBlocks,[201],'Selected work inside the canonical state horizon still outranks newer unrelated work');
  await database.query("UPDATE node_evidence_metadata_jobs SET completed_at=now() WHERE block_number<>15 AND completed_at IS NULL");
  await drainNodeEvidenceMetadata({database,priorityTokens:[token(106)],captureFeedEvidence:async()=>({requested:3,captured:0}),
    captureMetadata:async tokens=>({requested:tokens.length,captured:0,capturedTokens:[]})});
  const prunedRetry=(await database.query('SELECT * FROM node_evidence_metadata_jobs WHERE block_number=15')).rows[0];
  assert.equal(prunedRetry.last_error,'historical_token_metadata_unavailable');
  assert.ok(prunedRetry.next_attempt_at.getTime()>Date.now()+20_000,'Beyond-horizon jobs retain explicit historical backoff instead of consuming the urgent retry cadence');
  assert.equal(prunedRetry.completed_at,null,'A pruned job is retained as incomplete rather than silently skipped');

  // Precision and fixed feeds have separate leases and retry clocks. The
  // production pool reserves three/two slots respectively, without increasing
  // the eight-worker or per-stage RPC bounds.
  await database.query('UPDATE node_evidence_metadata_jobs SET completed_at=now() WHERE completed_at IS NULL');
  const insertHeader=async(height:number)=>database.query('INSERT INTO node_evidence_blocks VALUES($1,$2)',[height,hash(height)]);
  const good={database,history:'fresh' as const,
    captureMetadata:async(tokens:string[])=>({requested:tokens.length,captured:tokens.length,capturedTokens:tokens}),
    captureFeedEvidence:async()=>({requested:3,captured:3})};
  const rowAt=async(height:number)=>(await database.query('SELECT * FROM node_evidence_metadata_jobs WHERE block_number=$1',[height])).rows[0];
  const isolate=()=>database.query('UPDATE node_evidence_metadata_jobs SET completed_at=now() WHERE completed_at IS NULL');
  for(const height of [500,501])await insertHeader(height);
  await enqueueNodeEvidenceMetadataCheckpoints(database,[checkpoint(500,[token(500)]),checkpoint(501,[token(501)])]);
  const precisionOrder:number[]=[],pinOrder:number[]=[];
  for(let round=0;round<3;round++){
    const newer=502+round;await insertHeader(newer);
    await enqueueNodeEvidenceMetadataCheckpoints(database,[checkpoint(newer,[token(newer)])]);
    const captured=await drainNodeEvidenceMetadata({...good,stage:'precision',priorityTokens:[token(newer)],
      captureMetadata:async(tokens,point)=>{precisionOrder.push(point.blockNumber);return{requested:tokens.length,captured:tokens.length,capturedTokens:tokens};},
      captureFeedEvidence:async()=>{throw Error('Precision never waits for pinned feeds');}});
    assert.equal(captured.capturedTokens,1);
    await drainNodeEvidenceMetadata({...good,stage:'pins',priorityTokens:[token(newer)],
      captureMetadata:async()=>{throw Error('Pinned feeds never wait for precision');},
      captureFeedEvidence:async(point,tokens,options)=>{pinOrder.push(point.blockNumber);assert.deepEqual(tokens,[]);assert.equal(options?.conversions,false);return{requested:3,captured:3};}});
  }
  assert.deepEqual(precisionOrder,[500,501,502]);assert.deepEqual(pinOrder,[500,501,502]);
  const saved=await rowAt(500);assert.deepEqual(saved.completed_tokens,[token(500)]);assert.equal(saved.pinned_feed_complete,true);
  assert.equal(saved.feed_complete,false);assert.equal(saved.completed_at,null);assert.equal(saved.attempts,0);assert.equal(saved.pinned_attempts,0);
  assert.equal(saved.last_error,null);assert.equal(saved.pinned_last_error,null);
  await isolate();

  for(const blockedStage of ['precision','pins'] as const){
    const height=blockedStage==='precision'?510:511;await insertHeader(height);
    await enqueueNodeEvidenceMetadataCheckpoints(database,[checkpoint(height,[token(height)])]);
    let entered!:()=>void,release!:()=>void;
    const started=new Promise<void>(resolve=>entered=resolve),released=new Promise<void>(resolve=>release=resolve);
    const blocked=drainNodeEvidenceMetadata({...good,stage:blockedStage,
      captureMetadata:async tokens=>{entered();await released;return{requested:tokens.length,captured:tokens.length,capturedTokens:tokens};},
      captureFeedEvidence:async()=>{entered();await released;return{requested:3,captured:3};}});
    await started;
    try{
      const otherStage=blockedStage==='precision'?'pins':'precision';
      const independent=await drainNodeEvidenceMetadata({...good,stage:otherStage});
      assert.equal(independent.claimed,1,'The other stage claims the same checkpoint while the first stage is blocked');
      const progress=await rowAt(height);
      if(blockedStage==='precision'){assert.equal(progress.pinned_feed_complete,true);assert.deepEqual(progress.completed_tokens,[]);assert.ok(progress.lease_id);}
      else{assert.deepEqual(progress.completed_tokens,[token(height)]);assert.equal(progress.pinned_feed_complete,false);assert.ok(progress.pinned_lease_id);}
      assert.equal((await database.query("SELECT count(*)::int n FROM pg_stat_activity WHERE datname=current_database() AND state='idle in transaction'")).rows[0].n,0);
    }finally{release();}
    await blocked;
    const finished=await rowAt(height);assert.equal(finished.pinned_feed_complete,true);assert.deepEqual(finished.completed_tokens,[token(height)]);
    await drainNodeEvidenceMetadata({...good,stage:'feed'});assert.ok((await rowAt(height)).completed_at);
  }

  await isolate();await insertHeader(512);await enqueueNodeEvidenceMetadataCheckpoints(database,[checkpoint(512,[])]);
  assert.equal((await drainNodeEvidenceMetadata({...good,stage:'precision'})).claimed,0,'Tokenless fee blocks need no guessed precision');
  assert.equal((await drainNodeEvidenceMetadata({...good,stage:'feed'})).claimed,0,'Conversions cannot steal an unsaved fixed-feed checkpoint');
  await drainNodeEvidenceMetadata({...good,stage:'pins',captureFeedEvidence:async(point,tokens,options)=>{
    assert.equal(point.blockNumber,512);assert.deepEqual(tokens,[]);assert.equal(options?.conversions,false);return{requested:3,captured:3};}});
  assert.equal((await rowAt(512)).pinned_feed_complete,true);assert.equal((await rowAt(512)).feed_complete,false);
  await ensureNodeEvidenceMetadataSchema(database);
  assert.equal((await drainNodeEvidenceMetadata({...good,stage:'pins'})).claimed,0,'Restart does not discard saved fixed feed proofs');
  await enqueueNodeEvidenceMetadataCheckpoints(database,[checkpoint(512,[token(512)])]);
  await drainNodeEvidenceMetadata({...good,stage:'precision'});
  assert.equal((await rowAt(512)).pinned_feed_complete,true,'Adding a token retains scope-independent pinned proofs');
  await drainNodeEvidenceMetadata({...good,stage:'feed'});assert.ok((await rowAt(512)).completed_at);

  await isolate();await insertHeader(513);await enqueueNodeEvidenceMetadataCheckpoints(database,[checkpoint(513,[token(513)])]);
  await drainNodeEvidenceMetadata({...good,stage:'pins',captureFeedEvidence:async()=>({requested:3,captured:2})});
  const failedPin=await rowAt(513);assert.equal(failedPin.pinned_attempts,1);assert.equal(failedPin.pinned_last_error,'feed_evidence_unavailable');
  assert.ok(failedPin.pinned_next_attempt_at.getTime()>Date.now()+1000);
  assert.equal((await drainNodeEvidenceMetadata({...good,stage:'precision'})).claimed,1,'Pinned retry cooldown never delays token precision');
  await database.query("UPDATE node_evidence_metadata_jobs SET pinned_next_attempt_at=now()-interval '1 second' WHERE block_number=513");
  await drainNodeEvidenceMetadata({...good,stage:'pins'});assert.equal((await rowAt(513)).pinned_feed_complete,true);
  await isolate();await insertHeader(514);await enqueueNodeEvidenceMetadataCheckpoints(database,[checkpoint(514,[token(514)])]);
  await drainNodeEvidenceMetadata({...good,stage:'precision',captureMetadata:async tokens=>({requested:tokens.length,captured:0,capturedTokens:[]})});
  assert.equal((await drainNodeEvidenceMetadata({...good,stage:'pins'})).claimed,1,'Precision retry cooldown never delays fixed feeds');
  assert.equal((await rowAt(514)).pinned_feed_complete,true);

  // Historical all-stage completion may establish pinned evidence without
  // acquiring or clearing another independently owned pinned lease.
  await isolate();await insertHeader(300);await enqueueNodeEvidenceMetadataCheckpoints(database,[checkpoint(300,[token(300)])]);
  const historicalPinOwner=randomUUID();
  await database.query("UPDATE node_evidence_metadata_jobs SET pinned_lease_id=$1,pinned_lease_until=clock_timestamp()+interval '10 seconds' WHERE block_number=300",[historicalPinOwner]);
  assert.equal((await drainNodeEvidenceMetadata({...good,stage:'precision',headBlock:700})).claimed,0);
  const historical=await drainNodeEvidenceMetadata({...good,stage:'all',history:'historical',headBlock:700});assert.equal(historical.completed,1);
  const historicalSaved=await rowAt(300);assert.equal(historicalSaved.pinned_feed_complete,true);assert.equal(historicalSaved.pinned_lease_id,historicalPinOwner);

  // Both lease namespaces renew while alive and fence stale owners using wall
  // time after lock waits. Completion never revives an expired lease.
  for(const [index,stage] of (['precision','pins'] as const).entries()){
    await isolate();const height=520+index*10;await insertHeader(height);await enqueueNodeEvidenceMetadataCheckpoints(database,[checkpoint(height,[token(height)])]);
    const leaseColumn=stage==='pins'?'pinned_lease_id':'lease_id',untilColumn=stage==='pins'?'pinned_lease_until':'lease_until';
    const crashed=randomUUID();await database.query(`UPDATE node_evidence_metadata_jobs SET ${leaseColumn}=$1,${untilColumn}=clock_timestamp()+interval '10 seconds' WHERE block_number=$2`,[crashed,height]);
    assert.equal((await drainNodeEvidenceMetadata({...good,stage})).claimed,0);
    await database.query(`UPDATE node_evidence_metadata_jobs SET ${untilColumn}=clock_timestamp()-interval '1 second' WHERE block_number=$1`,[height]);
    assert.equal((await drainNodeEvidenceMetadata({...good,stage})).claimed,1,'Short expired ownership is recoverable');
    assert.equal((await rowAt(height))[leaseColumn],null);

    await isolate();await insertHeader(height+1);await enqueueNodeEvidenceMetadataCheckpoints(database,[checkpoint(height+1,[token(height+1)])]);
    let entered!:()=>void,release!:()=>void;
    const started=new Promise<void>(resolve=>entered=resolve),released=new Promise<void>(resolve=>release=resolve);
    const block={captureMetadata:async(tokens:string[])=>{entered();await released;return{requested:tokens.length,captured:tokens.length,capturedTokens:tokens};},
      captureFeedEvidence:async()=>{entered();await released;return{requested:3,captured:3};}};
    const live=drainNodeEvidenceMetadata({...good,...block,stage});await started;
    const first=await rowAt(height+1);
    assert.ok(first[untilColumn].getTime()-Date.now()<=10100);
    await new Promise(resolve=>setTimeout(resolve,2400));const renewed=await rowAt(height+1);
    assert.equal(renewed[leaseColumn],first[leaseColumn]);assert.ok(renewed[untilColumn].getTime()>first[untilColumn].getTime()+1000);
    assert.equal((await drainNodeEvidenceMetadata({...good,stage})).claimed,0);
    release();await live;assert.equal((await rowAt(height+1))[leaseColumn],null);

    await isolate();await insertHeader(height+2);await enqueueNodeEvidenceMetadataCheckpoints(database,[checkpoint(height+2,[token(height+2)])]);
    let staleEntered!:()=>void,staleRelease!:()=>void,replacementEntered!:()=>void,replacementRelease!:()=>void;
    const staleStarted=new Promise<void>(resolve=>staleEntered=resolve),staleReleased=new Promise<void>(resolve=>staleRelease=resolve);
    const replacementStarted=new Promise<void>(resolve=>replacementEntered=resolve),replacementReleased=new Promise<void>(resolve=>replacementRelease=resolve);
    const held=(start:()=>void,wait:Promise<void>)=>({captureMetadata:async(tokens:string[])=>{start();await wait;return{requested:tokens.length,captured:tokens.length,capturedTokens:tokens};},
      captureFeedEvidence:async()=>{start();await wait;return{requested:3,captured:3};}});
    const stale=drainNodeEvidenceMetadata({...good,...held(staleEntered,staleReleased),stage});await staleStarted;
    await database.query(`UPDATE node_evidence_metadata_jobs SET ${untilColumn}=clock_timestamp()-interval '1 second' WHERE block_number=$1`,[height+2]);
    const replacement=drainNodeEvidenceMetadata({...good,...held(replacementEntered,replacementReleased),stage});await replacementStarted;
    const replacementId=(await rowAt(height+2))[leaseColumn];staleRelease();await stale;
    const fenced=await rowAt(height+2);assert.equal(fenced[leaseColumn],replacementId);
    assert.deepEqual(fenced.completed_tokens,[]);assert.equal(fenced.pinned_feed_complete,false,'Expired owners cannot publish stage progress');
    replacementRelease();await replacement;

    await isolate();await insertHeader(height+3);await enqueueNodeEvidenceMetadataCheckpoints(database,[checkpoint(height+3,[token(height+3)])]);
    let lockedEntered!:()=>void,lockedRelease!:()=>void;
    const lockedStarted=new Promise<void>(resolve=>lockedEntered=resolve),lockedReleased=new Promise<void>(resolve=>lockedRelease=resolve);
    const locked=drainNodeEvidenceMetadata({...good,...held(lockedEntered,lockedReleased),stage});await lockedStarted;
    const lock=await database.connect();
    try{await lock.query('BEGIN');await lock.query(`UPDATE node_evidence_metadata_jobs SET ${untilColumn}=clock_timestamp()+interval '3 seconds' WHERE block_number=$1`,[height+3]);
      await new Promise(resolve=>setTimeout(resolve,4100));await lock.query('COMMIT');await new Promise(resolve=>setTimeout(resolve,100));
      assert.ok((await rowAt(height+3))[untilColumn].getTime()<Date.now(),'Waiting heartbeat cannot revive an expired owner');
    }finally{await lock.query('ROLLBACK');lock.release();lockedRelease();}
    await locked;const late=await rowAt(height+3);assert.deepEqual(late.completed_tokens,[]);assert.equal(late.pinned_feed_complete,false);assert.equal(late[leaseColumn],null);
  }

  await isolate();await insertHeader(550);await enqueueNodeEvidenceMetadataCheckpoints(database,[checkpoint(550,[token(550)])]);
  let precisionEntered!:()=>void,precisionRelease!:()=>void;
  const precisionStarted=new Promise<void>(resolve=>precisionEntered=resolve),precisionReleased=new Promise<void>(resolve=>precisionRelease=resolve);
  const orphanPrecision=drainNodeEvidenceMetadata({...good,stage:'precision',captureMetadata:async tokens=>{precisionEntered();await precisionReleased;return{requested:tokens.length,captured:tokens.length,capturedTokens:tokens};}});
  await precisionStarted;
  await drainNodeEvidenceMetadata({...good,stage:'pins',captureFeedEvidence:async()=>{await database.query('DELETE FROM node_evidence_blocks WHERE block_number=550');return{requested:3,captured:3};}});
  precisionRelease();await orphanPrecision;
  assert.equal((await database.query('SELECT count(*)::int n FROM node_evidence_metadata_jobs WHERE block_number=550')).rows[0].n,0,'Reorg deletion cascades across both active stage leases');
  console.log('Urgent node metadata PostgreSQL regression passed: atomic coalescing, fee-only blocks, independently leased pins/precision/conversions, earliest deadline, foreground fairness, >20 tokens, partial progress, short renewable leases, crash recovery, stale-owner fences, historical budgets, backoff and reorg cascade');
} finally {
  await database.end(); await admin.query(`DROP DATABASE "${name}" WITH(FORCE)`); await admin.end();
}
