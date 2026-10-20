import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { advanceNodeDecodeCheckpoints, bootstrapNodeCapture, collectNodeEvidenceRange, drainNodeEvidenceDecode, drainNodeEvidenceProjection, ensureNodeEvidenceSchema, findNodeEvidenceReorgStart, nodeCaptureStart, rollbackNodeEvidence, syncNodeMonitoredWallets, type NodeRpc } from './nodeEvidence.js';
import { transferTopic } from './swap.js';
import { persistNodeExecutions,NODE_EXECUTION_VERSION,type NodeExecution } from './nodeExecution.js';
import { backfillNodeEvidenceCoverageCohorts } from './nodeEvidenceCoverage.js';

const configured = new URL(process.env.DATABASE_URL ?? 'postgres://invalid');
if (!['localhost', '127.0.0.1'].includes(configured.hostname) || configured.port !== '5435') throw new Error('Disposable local PostgreSQL only');
const admin = new pg.Client({ connectionString: configured.href }); await admin.connect();
const name = `node_evidence_test_${randomUUID().replaceAll('-', '')}`;
await admin.query(`CREATE DATABASE "${name}"`);
const connection = new URL(configured); connection.pathname = `/${name}`;
const database = new pg.Pool({ connectionString: connection.href, max: 6 });
const wallet = `0x${'a'.repeat(40)}`, other = `0x${'b'.repeat(40)}`, token = `0x${'c'.repeat(40)}`;
const txHash = `0x${'1'.repeat(64)}`, blockHash = `0x${'2'.repeat(64)}`, parentHash = `0x${'3'.repeat(64)}`;
const log = { address: token, topics: [transferTopic, `0x${other.slice(2).padStart(64, '0')}`, `0x${wallet.slice(2).padStart(64, '0')}`], data: `0x${'0'.repeat(62)}64`, logIndex: '0x0', blockNumber: '0x64', blockHash, transactionHash: txHash };
const transaction = { hash: txHash, from: wallet, to: other, value: '0x1', blockNumber: '0x64', blockHash, transactionIndex: '0x0', gasPrice: '0x2' };
const block = { number: '0x64', hash: blockHash, parentHash, timestamp: '0x1234', transactions: [transaction] };
const receipt = { transactionHash: txHash, blockNumber: '0x64', blockHash, transactionIndex: '0x0', status: '0x1', gasUsed: '0x5', logs: [log] };
const rpc: NodeRpc = async <T>(method: string) => (method === 'eth_getBlockByNumber' ? block : method === 'eth_getTransactionReceipt' ? receipt : method === 'eth_getLogs' ? [log] : null) as T;
try {
  await database.query(`CREATE TABLE kols(address text PRIMARY KEY,is_tracked boolean NOT NULL); CREATE TABLE tokens(address text PRIMARY KEY); CREATE TABLE journal_wallets(wallet_address text,registration_block bigint,registration_hash text);
    CREATE TABLE worker_state(key text PRIMARY KEY,value jsonb NOT NULL,updated_at timestamptz DEFAULT now());
    CREATE TABLE processed_blocks(block_number bigint PRIMARY KEY,block_hash text);
    CREATE TABLE trades(id text PRIMARY KEY,tx_hash text NOT NULL,wallet_address text NOT NULL,token_address text NOT NULL,UNIQUE(tx_hash,wallet_address,token_address));`);
  await Promise.all([ensureNodeEvidenceSchema(database), ensureNodeEvidenceSchema(database)]);
  await database.query('INSERT INTO kols(address,is_tracked) VALUES($1,true)', [wallet]);
  const generations = await syncNodeMonitoredWallets(database);
  await collectNodeEvidenceRange({ database, rpc, from: 100, to: 100, head: 106, generations });
  const capturedCohort = (await database.query(`SELECT r.cohort_fingerprint,c.wallets=r.wallets AS matched FROM node_evidence_ranges r
    JOIN node_evidence_cohorts c ON c.fingerprint=r.cohort_fingerprint`)).rows[0];
  assert.match(capturedCohort.cohort_fingerprint, /^[a-f0-9]{64}$/); assert.equal(capturedCohort.matched, true,
    'A successful capture atomically associates its exact monitoring generation cohort');
  assert.deepEqual(await backfillNodeEvidenceCoverageCohorts(database), { processed: 0, remaining: false }, 'New captures need no legacy map migration');
  // Decode advances lock active registry rows. Routine synchronization must be
  // read-only for those rows rather than taking every row in a different order.
  const beforeSync=(await database.query('SELECT * FROM node_monitored_wallets WHERE wallet_address=$1',[wallet])).rows[0];
  const decoder=await database.connect(),registration=await database.connect();
  try {
    await decoder.query('BEGIN');
    await decoder.query('SELECT 1 FROM node_monitored_wallets WHERE wallet_address=$1 FOR UPDATE',[wallet]);
    await registration.query('BEGIN');await registration.query("SET LOCAL lock_timeout='300ms'");
    const unchanged=await syncNodeMonitoredWallets(registration);
    assert.equal(unchanged.get(wallet),beforeSync.generation);
    await registration.query('COMMIT');await decoder.query('COMMIT');
  } catch(error) {await registration.query('ROLLBACK');await decoder.query('ROLLBACK');throw error;}
  finally{registration.release();decoder.release();}
  assert.deepEqual((await database.query('SELECT * FROM node_monitored_wallets WHERE wallet_address=$1',[wallet])).rows[0],beforeSync,
    'Routine sync does not reset active generation, checkpoints, repair cursor or freshness while decode holds its row');
  assert.equal((await database.query("SELECT value->>'blockNumber' AS value FROM worker_state WHERE key='node_collection'")).rows[0].value, '100');
  assert.equal((await database.query('SELECT count(*)::int n FROM node_evidence_transactions')).rows[0].n, 1);
  const metadataJob = (await database.query('SELECT tokens,feed_complete FROM node_evidence_metadata_jobs WHERE block_number=100')).rows[0];
  assert.deepEqual(metadataJob.tokens, [token]); assert.equal(metadataJob.feed_complete, false,
    'Raw commit durably queues exact-block token and fee evidence without calling metadata RPC');
  // Metadata projection fails; raw evidence and pure execution decoding survive.
  await drainNodeEvidenceDecode({ database, project: async () => { throw new Error('metadata_unavailable'); } });
  assert.equal((await database.query('SELECT decoded_version FROM node_evidence_transactions')).rows[0].decoded_version, 1);
  assert.equal((await database.query('SELECT delta_raw::text FROM node_execution_flows')).rows[0].delta_raw, '100');
  assert.equal((await database.query("SELECT count(*)::int n FROM worker_state WHERE key='node'")).rows[0].n, 1);
  // Simulate pruned RPC: the retry has only PostgreSQL data, no RPC argument.
  await database.query("UPDATE node_evidence_transactions SET next_decode_at=now()-interval '1 second'");
  let projections = 0;
  await Promise.all([drainNodeEvidenceDecode({ database, project: async () => { projections++; } }), drainNodeEvidenceDecode({ database, project: async () => { projections++; } })]);
  assert.equal(projections, 1);
  assert.equal((await database.query("SELECT value->>'blockNumber' AS value FROM worker_state WHERE key='node'")).rows[0].value, '100');
  // Reprocessing is idempotent; no operation is added or fee charged twice.
  await collectNodeEvidenceRange({ database, rpc, from: 100, to: 100, head: 106, generations, repairWallet: wallet });
  await drainNodeEvidenceDecode({ database });
  assert.equal((await database.query('SELECT count(*)::int n FROM node_executions')).rows[0].n, 1);
  assert.equal((await database.query('SELECT fee_native_wei::text FROM node_executions')).rows[0].fee_native_wei, '10');
  // Legacy references stay unchanged while two same-token operations coexist.
  await database.query("INSERT INTO trades(id,tx_hash,wallet_address,token_address) VALUES('legacy',$1,$2,$3)", [txHash, wallet, token]);
  await database.query("INSERT INTO trades(id,tx_hash,wallet_address,token_address,execution_id) VALUES('operation1',$1,$2,$3,'execution1'),('operation2',$1,$2,$3,'execution2')", [txHash, wallet, token]);
  assert.equal((await database.query('SELECT count(*)::int n FROM trades')).rows[0].n, 3);
  // Pause exactly after selecting the completed range and before inserting its
  // node checkpoint. Rollback must wait for this entire advance transaction,
  // then delete the checkpoint; the selected orphan cannot be recreated later.
  let rangeSelected!: () => void, resumeAdvance!: () => void;
  const selected = new Promise<void>(resolve => { rangeSelected = resolve; });
  const resume = new Promise<void>(resolve => { resumeAdvance = resolve; });
  const guardedPool = {
    query: database.query.bind(database),
    connect: async () => {
      const client = await database.connect();
      return { query: async (sql: string, values?: any[]) => {
        const result = await client.query(sql, values);
        if (sql.startsWith('SELECT r.to_block')) { rangeSelected(); await resume; }
        return result;
      }, release: () => client.release() };
    },
  };
  const advancing = advanceNodeDecodeCheckpoints(guardedPool as never);
  await Promise.race([selected, advancing.then(() => { throw new Error('Checkpoint interleaving gate was not reached'); })]);
  const client = await database.connect();
  try {
    await client.query('BEGIN');
    assert.equal((await client.query('SELECT pg_try_advisory_xact_lock(782319) AS acquired')).rows[0].acquired, false,
      'Rollback cannot interleave after range selection and before checkpoint insertion');
    const rollingBack = (async () => {
      await client.query('SELECT pg_advisory_xact_lock(782319)');
      await rollbackNodeEvidence(client, 100); await client.query('COMMIT');
    })();
    resumeAdvance(); await Promise.all([advancing, rollingBack]);
  } catch (error) { resumeAdvance(); await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  assert.equal((await database.query('SELECT count(*)::int n FROM node_executions')).rows[0].n, 0);
  assert.equal((await database.query('SELECT count(*)::int n FROM node_execution_flows')).rows[0].n, 0);
  assert.equal((await database.query('SELECT count(*)::int n FROM node_evidence_transactions')).rows[0].n, 0);
  assert.equal((await database.query('SELECT count(*)::int n FROM node_evidence_metadata_jobs')).rows[0].n, 0, 'Orphaned raw headers cascade into urgent metadata jobs');
  assert.equal((await database.query("SELECT count(*)::int n FROM worker_state WHERE key IN('node','node_collection')")).rows[0].n, 0);
  await advanceNodeDecodeCheckpoints(database);
  assert.equal((await database.query("SELECT count(*)::int n FROM worker_state WHERE key='node'")).rows[0].n, 0,
    'A later advance cannot recreate the removed range checkpoint');
  // A caller-owned transaction remains open and retains its reorg protection.
  const outer = await database.connect(), observer = await database.connect();
  try {
    await outer.query('BEGIN'); await advanceNodeDecodeCheckpoints(outer);
    await observer.query('BEGIN');
    assert.equal((await observer.query('SELECT pg_try_advisory_xact_lock(782319) AS acquired')).rows[0].acquired, false);
    await observer.query('ROLLBACK'); await outer.query('ROLLBACK');
  } finally { outer.release(); observer.release(); }
  // A migrated prototype may retain very old/pruned evidence with no durable
  // collection cursor. Explicit bootstrap preserves it, records an uncovered
  // gap and starts a new segment; the gap is never marked as collected.
  await database.query(`INSERT INTO node_evidence_blocks(block_number,block_hash,parent_hash,timestamp,header) VALUES(1,$1,$2,now(),'{}')`, [parentHash, `0x${'9'.repeat(64)}`]);
  await database.query('INSERT INTO processed_blocks(block_number,block_hash) VALUES(1,$1)', [parentHash]);
  await database.query('INSERT INTO journal_wallets(wallet_address,registration_block,registration_hash) VALUES($1,1,$2)', [wallet, parentHash]);
  await database.query(`CREATE TABLE node_accounting_baselines(wallet_address text,invalidated_at timestamptz);
    CREATE TABLE node_accounting_balances(wallet_address text,invalidated_at timestamptz);
    CREATE TABLE node_accounting_history(wallet_address text,invalidated_at timestamptz);
    CREATE TABLE node_accounting_snapshots(wallet_address text,invalidated_at timestamptz,last_valid jsonb);
    CREATE TABLE node_accounting_snapshot_versions(wallet_address text,invalidated_at timestamptz);
    CREATE TABLE journal_replay_snapshots(wallet_address text,payload jsonb);
    CREATE TABLE node_market_ranges(from_block bigint,to_block bigint,complete boolean);`);
  await database.query('INSERT INTO node_accounting_baselines(wallet_address) VALUES($1)', [wallet]);
  await database.query('INSERT INTO node_accounting_history(wallet_address) VALUES($1)', [wallet]);
  await database.query(`INSERT INTO node_accounting_snapshots(wallet_address,last_valid) VALUES($1,'{}')`, [wallet]);
  await database.query('INSERT INTO node_accounting_balances(wallet_address) VALUES($1),($2)', [wallet, other]);
  await database.query('INSERT INTO node_accounting_snapshot_versions(wallet_address) VALUES($1),($2)', [wallet, other]);
  await database.query(`INSERT INTO journal_replay_snapshots(wallet_address,payload) VALUES($1,'{}'),($2,'{}')`, [wallet, other]);
  await database.query('INSERT INTO node_market_ranges(from_block,to_block,complete) VALUES(1,2,true),(101,110,true)');
  await database.query(`INSERT INTO worker_state(key,value) VALUES('node_market_collection','{"blockNumber":2}')`);
  await assert.rejects(nodeCaptureStart(database, { target: 100 }), /bootstrap_required/);
  const bootstrapRpc: NodeRpc = async <T>(method: string) => (method === 'eth_blockNumber' ? '0x6a' : block) as T;
  const bootstrapped = await bootstrapNodeCapture({ database, rpc: bootstrapRpc, enabled: true });
  assert.equal(bootstrapped.boundary, 100); assert.equal(await nodeCaptureStart(database, { target: 100 }), 101);
  assert.equal((await database.query('SELECT count(*)::int n FROM node_collection_gaps WHERE from_block=1 AND to_block=100')).rows[0].n, 1);
  assert.equal((await database.query('SELECT count(*)::int n FROM node_evidence_ranges')).rows[0].n, 0, 'An uncovered gap is not a completed range');
  assert.equal((await database.query('SELECT count(*)::int n FROM node_evidence_blocks WHERE block_number=1')).rows[0].n, 1, 'Old raw evidence is retained');
  assert.equal((await database.query('SELECT registration_block::text FROM journal_wallets')).rows[0].registration_block, '1', 'Portfolio boundary is unchanged');
  assert.equal((await database.query('SELECT registration_block::text,historical_gap_from::text,historical_gap_to::text FROM node_monitored_wallets')).rows[0].registration_block, '100');
  assert.equal((await database.query('SELECT count(*)::int n FROM node_accounting_snapshots WHERE invalidated_at IS NOT NULL AND last_valid IS NULL')).rows[0].n, 1);
  assert.equal((await database.query('SELECT count(*)::int n FROM node_accounting_balances WHERE wallet_address=$1 AND invalidated_at IS NOT NULL', [wallet])).rows[0].n, 1);
  assert.equal((await database.query('SELECT count(*)::int n FROM node_accounting_snapshot_versions WHERE wallet_address=$1 AND invalidated_at IS NOT NULL', [wallet])).rows[0].n, 1);
  assert.equal((await database.query('SELECT count(*)::int n FROM journal_replay_snapshots WHERE wallet_address=$1', [wallet])).rows[0].n, 0, 'Pre-bootstrap private replay leases are revoked');
  assert.equal((await database.query('SELECT count(*)::int n FROM journal_replay_snapshots WHERE wallet_address=$1', [other])).rows[0].n, 1, 'Unmonitored wallet leases remain unchanged');
  assert.equal((await database.query('SELECT count(*)::int n FROM node_accounting_snapshot_versions WHERE wallet_address=$1 AND invalidated_at IS NULL', [other])).rows[0].n, 1);
  assert.equal((await database.query('SELECT complete FROM node_market_ranges WHERE from_block=1')).rows[0].complete, false);
  assert.equal((await database.query('SELECT complete FROM node_market_ranges WHERE from_block=101')).rows[0].complete, true);
  assert.equal((await database.query("SELECT value->>'blockNumber' AS n FROM worker_state WHERE key='node_market_collection'")).rows[0].n, '100');
  const futureHash = `0x${'4'.repeat(64)}`, future = { ...block, number: '0x65', hash: futureHash, parentHash: blockHash, transactions: [] };
  const futureRpc: NodeRpc = async <T>(method: string) => (method === 'eth_getBlockByNumber' ? future : []) as T;
  await collectNodeEvidenceRange({ database, rpc: futureRpc, from: 101, to: 101, head: 107, generations: await syncNodeMonitoredWallets(database) });
  await drainNodeEvidenceDecode({ database });
  assert.equal((await database.query("SELECT value->>'blockNumber' AS n FROM worker_state WHERE key='node'")).rows[0].n, '101');
  assert.equal((await database.query('SELECT min(from_block)::text AS n FROM node_evidence_ranges')).rows[0].n, '101');
  const checkedHeights: number[] = [];
  assert.equal(await findNodeEvidenceReorgStart(database, async height => { checkedHeights.push(height); return height === 101 ? futureHash : blockHash; }), null);
  assert(checkedHeights.every(height => height >= 100), 'Reorg checks use the explicit new capture segment');
  const reorg = await database.connect();
  try { await reorg.query('BEGIN'); await reorg.query('SELECT pg_advisory_xact_lock(782319)'); await rollbackNodeEvidence(reorg, 101); await reorg.query('COMMIT'); } finally { reorg.release(); }
  assert.equal(await nodeCaptureStart(database, { target: 100 }), 101, 'Ordinary reorg resumes from its still-valid bootstrap anchor');
  assert.equal((await bootstrapNodeCapture({ database, rpc: bootstrapRpc, enabled: true })).alreadyApplied, true);
  assert.equal((await database.query('SELECT count(*)::int n FROM node_collection_gaps')).rows[0].n, 1);
  // A catch-up-sized batch retains the same atomic guarantee. The last missing
  // receipt must prevent all 512 headers and its collection cursor from landing.
  const catchupHash = (height: number) => `0x${height.toString(16).padStart(64, '0')}`;
  const end = 612, catchupTx = { ...transaction, blockNumber: `0x${end.toString(16)}`, blockHash: catchupHash(end) };
  let missingCatchupReceipt = true;
  const catchupRpc: NodeRpc = async <T>(method: string, params: unknown[]) => {
    if (method === 'eth_getLogs') return [] as T;
    if (method === 'eth_getTransactionReceipt') return (missingCatchupReceipt ? null : { ...receipt, blockNumber: catchupTx.blockNumber, blockHash: catchupTx.blockHash, logs: [] }) as T;
    const height = Number(BigInt(String(params[0])));
    return { ...block, number: `0x${height.toString(16)}`, hash: catchupHash(height),
      parentHash: height === 101 ? blockHash : catchupHash(height - 1), timestamp: `0x${(4660 + height).toString(16)}`,
      transactions: height === end ? [catchupTx] : [] } as T;
  };
  const catchup = { database, rpc: catchupRpc, from: 101, to: end, head: end + 6, generations: await syncNodeMonitoredWallets(database) };
  await assert.rejects(collectNodeEvidenceRange(catchup), /incomplete/);
  assert.equal((await database.query('SELECT count(*)::int n FROM node_evidence_blocks WHERE block_number>=101')).rows[0].n, 0);
  assert.equal((await database.query('SELECT count(*)::int n FROM node_evidence_metadata_jobs WHERE block_number>=101')).rows[0].n, 0);
  assert.equal((await database.query("SELECT value->>'blockNumber' AS n FROM worker_state WHERE key='node_collection'")).rows[0].n, '100');
  missingCatchupReceipt = false;
  const caughtUp = await collectNodeEvidenceRange(catchup);
  assert.equal(caughtUp.blocks.length, 512); assert.equal(caughtUp.receipts, 1);
  assert.deepEqual((await database.query('SELECT tokens,feed_complete FROM node_evidence_metadata_jobs WHERE block_number=612')).rows[0], { tokens: [], feed_complete: false },
    'Native-only receipt blocks also queue fee-feed evidence atomically');
  assert.equal((await database.query('SELECT count(*)::int n FROM node_evidence_blocks WHERE block_number BETWEEN 101 AND 612')).rows[0].n, 512);
  assert.equal((await database.query("SELECT value->>'blockNumber' AS n FROM worker_state WHERE key='node_collection'")).rows[0].n, '612');
  assert.equal((await database.query('SELECT header->>\'hash\' AS hash FROM node_evidence_blocks WHERE block_number=612')).rows[0].hash, catchupHash(end));
  await drainNodeEvidenceDecode({ database });
  assert.equal((await database.query("SELECT value->>'blockNumber' AS n FROM worker_state WHERE key='node'")).rows[0].n, '612');
  // Historical pruned-metadata retries stay durable, but cannot sit ahead of
  // new live projections indefinitely after the collector catches the head.
  const currentSeconds = Math.floor(Date.now() / 1000), liveHashes = new Map<number,string>();
  for(let height=613;height<=615;height++)liveHashes.set(height,`0x${(height+10_000).toString(16).padStart(64,'0')}`);
  const freshRpc: NodeRpc = async <T>(method:string,params:unknown[]) => {
    if(method==='eth_getLogs')return [] as T;
    const height=method==='eth_getTransactionReceipt'
      ? [...liveHashes].find(([,value])=>value===params[0])![0] : Number(BigInt(String(params[0])));
    const currentTx={...transaction,hash:liveHashes.get(height)!,blockNumber:`0x${height.toString(16)}`,blockHash:catchupHash(height)};
    if(method==='eth_getTransactionReceipt')return {...receipt,transactionHash:currentTx.hash,blockNumber:currentTx.blockNumber,blockHash:currentTx.blockHash,logs:[]} as T;
    return {...block,number:currentTx.blockNumber,hash:currentTx.blockHash,parentHash:catchupHash(height-1),
      timestamp:`0x${(currentSeconds-(height===613?3600:height===614?20:10)).toString(16)}`,transactions:[currentTx]} as T;
  };
  await collectNodeEvidenceRange({database,rpc:freshRpc,from:613,to:615,head:621,generations:await syncNodeMonitoredWallets(database),liveSince:Date.now()-300_000});
  await drainNodeEvidenceDecode({database});
  await database.query('UPDATE node_evidence_transactions SET observed_live=false WHERE tx_hash=$1',[liveHashes.get(615)]);
  const projectedHashes:string[]=[];
  await drainNodeEvidenceProjection({database,limit:1,project:async entry=>{projectedHashes.push(entry.transaction.hash);}});
  assert.deepEqual(projectedHashes,[liveHashes.get(614)],'Fresh live receipts outrank both historical retries and fresh repair work');
  await drainNodeEvidenceProjection({database,limit:1,project:async entry=>{projectedHashes.push(entry.transaction.hash);}});
  assert.equal(projectedHashes[1],liveHashes.get(615),'Recent non-live repair work still outranks pruned old metadata');
  assert.equal((await database.query('SELECT count(*)::int n FROM node_evidence_transactions WHERE projection_at IS NULL')).rows[0].n,2,
    'Old work stays queued rather than disappearing or falsely completing');
  assert.equal((await database.query("SELECT value->>'blockNumber' AS n FROM worker_state WHERE key='node'")).rows[0].n,'615',
    'Projection scheduling does not rewind the independent decoded checkpoint');
  // A trade can be visible before optional exact precision is available. Its
  // enrichment retry updates the same identity and never re-decodes evidence.
  await database.query('ALTER TABLE trades ADD COLUMN token_amount numeric');
  await database.query('UPDATE node_evidence_transactions SET projection_at=NULL,next_decode_at=now() WHERE tx_hash=$1',[liveHashes.get(614)]);
  const executionCount=(await database.query('SELECT count(*)::int n FROM node_executions')).rows[0].n;
  const publishPartial=async(entry:any,amount:string|null)=>{
    await database.query(`INSERT INTO trades(id,tx_hash,wallet_address,token_address,token_amount) VALUES('partial-live',$1,$2,$3,$4)
      ON CONFLICT(id) DO UPDATE SET token_amount=COALESCE(EXCLUDED.token_amount,trades.token_amount)`,[entry.transaction.hash,wallet,token,amount]);
    return amount===null?{pendingReason:'node_projection_token_decimals_unavailable'}:undefined;
  };
  const partial=await drainNodeEvidenceProjection({database,limit:1,project:entry=>publishPartial(entry,null)});
  assert.deepEqual(partial,{projected:1,pending:1},'Committed partial publication still triggers the live-feed update');
  const unfinished=(await database.query('SELECT projection_at,projection_reason FROM node_evidence_transactions WHERE tx_hash=$1',[liveHashes.get(614)])).rows[0];
  assert.equal(unfinished.projection_at,null);assert.equal(unfinished.projection_reason,'node_projection_token_decimals_unavailable');
  assert.equal((await database.query("SELECT token_amount FROM trades WHERE id='partial-live'")).rows[0].token_amount,null);
  await database.query('UPDATE node_evidence_transactions SET next_decode_at=now() WHERE tx_hash=$1',[liveHashes.get(614)]);
  const repaired=await drainNodeEvidenceProjection({database,limit:1,project:entry=>publishPartial(entry,'1.234')});
  assert.deepEqual(repaired,{projected:1,pending:0});
  assert.deepEqual((await database.query("SELECT count(*)::int n,max(token_amount)::text amount FROM trades WHERE id='partial-live'")).rows[0],{n:1,amount:'1.234'});
  assert.equal((await database.query('SELECT count(*)::int n FROM node_executions')).rows[0].n,executionCount,
    'Enrichment changes no execution identity or fee evidence');
  assert.ok((await database.query('SELECT projection_at FROM node_evidence_transactions WHERE tx_hash=$1',[liveHashes.get(614)])).rows[0].projection_at);
  // More than one maximum batch of unresolved metadata must not starve old
  // first publications, including receipts before the capture boundary.
  await database.query('UPDATE node_evidence_transactions SET projection_at=now(),lease_id=NULL,lease_until=NULL');
  const fairnessHashes=new Map<number,string>();
  for(let height=616;height<=665;height++)fairnessHashes.set(height,`0x${(height+20_000).toString(16).padStart(64,'0')}`);
  const fairnessRpc:NodeRpc=async<T>(method:string,params:unknown[])=>{
    if(method==='eth_getLogs')return [] as T;
    const height=method==='eth_getTransactionReceipt'
      ? [...fairnessHashes].find(([,value])=>value===params[0])![0] : Number(BigInt(String(params[0])));
    const nextTx={...transaction,hash:fairnessHashes.get(height)!,blockNumber:`0x${height.toString(16)}`,blockHash:catchupHash(height)};
    if(method==='eth_getTransactionReceipt')return {...receipt,transactionHash:nextTx.hash,blockNumber:nextTx.blockNumber,blockHash:nextTx.blockHash,logs:[]} as T;
    return {...block,number:nextTx.blockNumber,hash:nextTx.blockHash,parentHash:catchupHash(height-1),
      timestamp:`0x${(currentSeconds-(height>=664?665-height+5:7200)).toString(16)}`,transactions:[nextTx]} as T;
  };
  await collectNodeEvidenceRange({database,rpc:fairnessRpc,from:616,to:665,head:671,generations:await syncNodeMonitoredWallets(database),liveSince:Date.now()-300_000});
  await drainNodeEvidenceDecode({database,limit:128});
  await database.query(`INSERT INTO worker_state(key,value)VALUES('node_capture_boundary','{"blockNumber":623}')
    ON CONFLICT(key)DO UPDATE SET value=EXCLUDED.value`);
  await database.query(`UPDATE node_evidence_transactions SET projection_reason='node_projection_token_decimals_unavailable',decode_attempts=20,
    next_decode_at=now()-interval '1 second' WHERE block_number BETWEEN 624 AND 663`);
  const retryHashes=new Set([...fairnessHashes].filter(([height])=>height>=624&&height<=663).map(([,value])=>value));
  const fairnessOrder:string[]=[];
  const projectFair=async(entry:any)=>{fairnessOrder.push(entry.transaction.hash);return retryHashes.has(entry.transaction.hash)
    ? {pendingReason:'node_projection_token_decimals_unavailable'} : undefined;};
  await drainNodeEvidenceProjection({database,limit:8,project:projectFair});
  assert.deepEqual(fairnessOrder.slice(0,2),[fairnessHashes.get(665),fairnessHashes.get(664)],'Both fresh live receipts publish before historical work in the same batch');
  assert.ok(fairnessOrder.slice(2).includes(fairnessHashes.get(616)!), 'An old untouched receipt outranks the metadata retry backlog across the capture boundary');
  assert.equal(fairnessOrder.filter(hash=>retryHashes.has(hash)).length,1,'A retry receives its reserved share while first publications remain');
  assert.equal((await database.query('SELECT count(*)::int n FROM node_evidence_transactions WHERE block_number BETWEEN 616 AND 623 AND projection_at IS NOT NULL')).rows[0].n,5);
  await Promise.all([drainNodeEvidenceProjection({database,limit:8,project:projectFair}),drainNodeEvidenceProjection({database,limit:8,project:projectFair})]);
  assert.equal((await database.query('SELECT count(*)::int n FROM node_evidence_transactions WHERE block_number BETWEEN 616 AND 623 AND projection_at IS NOT NULL')).rows[0].n,8,
    'Concurrent workers drain every first publication without waiting for irrecoverable metadata');
  assert.equal(new Set(fairnessOrder).size,fairnessOrder.length,'Cross-worker leases prevent duplicate publication and enrichment');
  assert.ok(fairnessOrder.filter(hash=>retryHashes.has(hash)).length>1,'Enrichment continues after first publications progress');
  assert.equal((await database.query('SELECT count(*)::int n FROM node_evidence_transactions WHERE block_number BETWEEN 624 AND 663 AND projection_at IS NULL')).rows[0].n,40,
    'Unknown precision remains explicitly pending; scheduling never invents metadata or completes it');
  // A decoder upgrade repairs permanent evidence without changing its block.
  // Its former and newly discovered financial dependencies must be revoked in
  // the same transaction, including fee-only wallets removed by the new decode.
  for(const table of['node_accounting_history','node_accounting_snapshots','node_accounting_snapshot_versions'])await database.query(`ALTER TABLE ${table} ADD COLUMN token_address text`);
  await database.query('CREATE TABLE leaderboard_snapshots(wallet_address text,period text,node_accounting jsonb)');
  const repairedToken=`0x${'d'.repeat(40)}`,untouchedToken=`0x${'e'.repeat(40)}`,feeWallet=`0x${'f'.repeat(40)}`;
  const repairHash=`0x${'5'.repeat(64)}`,repairTx=`0x${'6'.repeat(64)}`;
  const repairBlock={...block,number:'0x1388',hash:repairHash,parentHash:`0x${'4'.repeat(64)}`};
  const repairTransaction={...transaction,hash:repairTx,value:'0x0',blockNumber:repairBlock.number,blockHash:repairHash};
  const repairLog={...log,address:repairedToken,topics:[transferTopic,`0x${wallet.slice(2).padStart(64,'0')}`,`0x${other.slice(2).padStart(64,'0')}`],
    blockNumber:repairBlock.number,blockHash:repairHash,transactionHash:repairTx};
  const repairReceipt={...receipt,logs:[repairLog],transactionHash:repairTx,blockNumber:repairBlock.number,blockHash:repairHash};
  await database.query(`INSERT INTO node_evidence_blocks(block_number,block_hash,parent_hash,timestamp,header)VALUES(5000,$1,$2,to_timestamp(4660),$3::jsonb)`,
    [repairHash,repairBlock.parentHash,JSON.stringify(repairBlock)]);
  await database.query(`INSERT INTO node_evidence_transactions(tx_hash,block_number,block_hash,transaction_index,timestamp,transaction,receipt,decoded_version)
    VALUES($1,5000,$2,0,to_timestamp(4660),$3::jsonb,$4::jsonb,0)`,[repairTx,repairHash,JSON.stringify(repairTransaction),JSON.stringify(repairReceipt)]);
  await database.query('INSERT INTO node_evidence_wallets VALUES($1,$2),($1,$3)',[repairTx,wallet,other]);
  const priorExecution:NodeExecution={id:'prior-financial-execution',txHash:repairTx,walletAddress:wallet,executionIndex:0,operationHash:null,blockNumber:5000,blockHash:repairHash,
    transactionIndex:0,timestamp:4660,status:'success',kind:'transaction',feeNativeWei:'999',feeComplete:true,feeReason:null,nativeValueRaw:'0',logs:[],
    flows:[{tokenAddress:token,deltaRaw:'100',logIndices:[0],counterparties:[other]}]};
  await persistNodeExecutions(database,[priorExecution,{...priorExecution,id:'prior-fee-only-execution',walletAddress:feeWallet,flows:[]}]);
  const affected=[{wallet,token},{wallet,token:repairedToken},{wallet:other,token:repairedToken}],unaffected={wallet,token:untouchedToken};
  for(const pair of[...affected,unaffected])for(const table of['node_accounting_history','node_accounting_snapshots','node_accounting_snapshot_versions'])
    await database.query(`INSERT INTO ${table}(wallet_address,token_address${table==='node_accounting_snapshots'?',last_valid':''})
      VALUES($1,$2${table==='node_accounting_snapshots'?",'{}'":''})`,[pair.wallet,pair.token]);
  await database.query(`INSERT INTO leaderboard_snapshots VALUES($1,'1d','{"valid":true}'),($2,'1d','{"valid":true}'),($3,'1d','{"valid":true}'),($1,'7d','{"retained":true}')`,[wallet,other,feeWallet]);
  await database.query(`CREATE FUNCTION fail_decode_financial_fixture() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'decoder_fixture_failure';END$$;
    CREATE TRIGGER fail_decode_financial_fixture BEFORE INSERT ON node_execution_flows FOR EACH ROW EXECUTE FUNCTION fail_decode_financial_fixture()`);
  assert.equal((await drainNodeEvidenceDecode({database,limit:1})).decoded,0);
  assert.equal((await database.query('SELECT count(*)::int n FROM node_accounting_history WHERE token_address IS NOT NULL AND invalidated_at IS NOT NULL')).rows[0].n,0,
    'Failed replacement execution persistence rolls back every financial invalidation');
  assert.equal((await database.query("SELECT count(*)::int n FROM leaderboard_snapshots WHERE period='1d' AND node_accounting IS NULL")).rows[0].n,0);
  assert.equal((await database.query('SELECT count(*)::int n FROM node_executions WHERE tx_hash=$1',[repairTx])).rows[0].n,2,'A failed decoder repair preserves the prior executions atomically');
  await database.query('DROP TRIGGER fail_decode_financial_fixture ON node_execution_flows;DROP FUNCTION fail_decode_financial_fixture()');
  await database.query('UPDATE node_evidence_transactions SET next_decode_at=now() WHERE tx_hash=$1',[repairTx]);
  assert.equal((await drainNodeEvidenceDecode({database,limit:1})).decoded,1);
  for(const table of['node_accounting_history','node_accounting_snapshots','node_accounting_snapshot_versions']){
    assert.equal((await database.query(`SELECT count(*)::int n FROM ${table} WHERE token_address IS NOT NULL AND invalidated_at IS NOT NULL`)).rows[0].n,3,
      'Decoder repair revokes the union of old and new wallet/token histories');
    assert.equal((await database.query(`SELECT invalidated_at FROM ${table} WHERE wallet_address=$1 AND token_address=$2`,[wallet,untouchedToken])).rows[0].invalidated_at,null);
  }
  assert.equal((await database.query("SELECT count(*)::int n FROM leaderboard_snapshots WHERE period='1d' AND node_accounting IS NULL")).rows[0].n,3,
    'Existing, newly discovered and removed fee-only wallets cannot retain their previous ranked totals');
  assert.deepEqual((await database.query("SELECT node_accounting FROM leaderboard_snapshots WHERE period='7d'")).rows[0].node_accounting,{retained:true});
  assert.equal((await database.query('SELECT count(*)::int n FROM node_execution_flows f JOIN node_executions e ON e.id=f.execution_id WHERE e.tx_hash=$1 AND f.token_address=$2',[repairTx,repairedToken])).rows[0].n,2);
  await database.query('UPDATE node_accounting_history SET invalidated_at=NULL WHERE token_address=$1',[repairedToken]);
  await database.query("UPDATE leaderboard_snapshots SET node_accounting='{\"unchanged\":true}' WHERE period='1d'");
  assert.equal((await drainNodeEvidenceDecode({database,limit:1})).decoded,0);
  assert.equal((await database.query('SELECT count(*)::int n FROM node_accounting_history WHERE token_address=$1 AND invalidated_at IS NOT NULL',[repairedToken])).rows[0].n,0,
    'An already current decoder does not revoke valid histories or restart work');
  assert.equal((await database.query('SELECT decoded_version FROM node_evidence_transactions WHERE tx_hash=$1',[repairTx])).rows[0].decoded_version,NODE_EXECUTION_VERSION);
  const forwardHash=`0x${'7'.repeat(64)}`,forwardTx=`0x${'8'.repeat(64)}`;
  const forwardBlock={...repairBlock,number:'0x1389',hash:forwardHash,parentHash:repairHash};
  const forwardTransaction={...repairTransaction,hash:forwardTx,blockNumber:forwardBlock.number,blockHash:forwardHash};
  const forwardReceipt={...repairReceipt,transactionHash:forwardTx,blockNumber:forwardBlock.number,blockHash:forwardHash,
    logs:[{...repairLog,blockNumber:forwardBlock.number,blockHash:forwardHash,transactionHash:forwardTx}]};
  await database.query(`INSERT INTO node_evidence_blocks(block_number,block_hash,parent_hash,timestamp,header)VALUES(5001,$1,$2,to_timestamp(4660),$3::jsonb)`,
    [forwardHash,repairHash,JSON.stringify(forwardBlock)]);
  await database.query(`INSERT INTO node_evidence_transactions(tx_hash,block_number,block_hash,transaction_index,timestamp,transaction,receipt)
    VALUES($1,5001,$2,0,to_timestamp(4660),$3::jsonb,$4::jsonb)`,[forwardTx,forwardHash,JSON.stringify(forwardTransaction),JSON.stringify(forwardReceipt)]);
  await database.query('INSERT INTO node_evidence_wallets VALUES($1,$2),($1,$3)',[forwardTx,wallet,other]);
  assert.equal((await drainNodeEvidenceDecode({database,limit:1})).decoded,1);
  assert.equal((await database.query('SELECT count(*)::int n FROM node_accounting_history WHERE token_address=$1 AND invalidated_at IS NOT NULL',[repairedToken])).rows[0].n,0,
    'Ordinary forward decoding leaves the previous dated histories available while their next checkpoint prepares');
  assert.equal((await database.query("SELECT count(*)::int n FROM leaderboard_snapshots WHERE period='1d' AND node_accounting IS NULL")).rows[0].n,0,
    'A first decode does not apply historical-repair invalidation to current rollups');
  console.log('Node evidence integration passed: atomic capture, metadata independence, pruning recovery, concurrent decoding, idempotence, execution migration, reorg-safe checkpoint interleaving, historical-gap bootstrap and atomic decoder-repair financial invalidation.');
} finally {
  await database.end(); await admin.query(`DROP DATABASE "${name}" WITH(FORCE)`); await admin.end();
}
