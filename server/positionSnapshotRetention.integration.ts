/** Creates its own disposable local database. No VPS or provider requests. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import Fastify from 'fastify';
import { prunePositionSnapshots, positionSnapshotRetentionHours } from './positionSnapshotRetention.js';
import { classifyPosition } from './intelligenceLogic.js';

const configured = new URL(process.env.DATABASE_URL ?? 'postgres://invalid');
if (!['127.0.0.1', 'localhost'].includes(configured.hostname) || configured.port !== '5435') throw new Error('Disposable local PostgreSQL only');
const admin = new pg.Client({ connectionString: configured.href }); await admin.connect();
const name = `position_retention_test_${randomUUID().replaceAll('-', '')}`;
await admin.query(`CREATE DATABASE "${name}"`);
const target = new URL(configured); target.pathname = `/${name}`;
process.env.DATABASE_URL = target.href;
const { pool, ensureSchema } = await import('./db.js');
const { registerIntelligenceRoutes } = await import('./intelligenceApi.js');
const app = Fastify();
const nativeFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('Position retention must not request a node or provider'); };
const wallet = `0x${'1'.repeat(40)}`, tokens = Array.from({ length: 6 }, (_, index) => `0x${(index + 2).toString(16).repeat(40)}`);
const hash = (height: number) => `0x${height.toString(16).padStart(64, '0')}`;
const now = Date.now(), recent = new Date(now - 20_000).toISOString(), old = new Date(now - 3 * 86400_000).toISOString();
const rows = async (token: string) => (await pool.query(`SELECT block_number::integer AS height,balance_raw::text,status,error,block_timestamp
  FROM position_snapshots WHERE wallet_address=$1 AND token_address=$2 ORDER BY block_number`, [wallet, token])).rows;
const readPositions = async () => {
  const response = await app.inject(`/api/kols/${wallet}/positions`);
  assert.equal(response.statusCode, 200, response.body);
  return response.json().items;
};
const fingerprint = async (table: string) => (await pool.query(`SELECT md5(COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text)::text,'')) AS digest FROM ${table} t`)).rows[0].digest;
const durableTables = ['trades', 'wallet_transfers', 'node_evidence_transactions', 'node_execution_flows', 'node_accounting_history',
  'node_accounting_snapshots', 'node_accounting_snapshot_versions', 'node_import_movements', 'node_market_candles', 'leaderboard_snapshots'];
try {
  await ensureSchema();
  await pool.query('INSERT INTO kols(address,is_tracked) VALUES($1,true)', [wallet]);
  await pool.query('INSERT INTO tokens(address,decimals) SELECT unnest($1::text[]),0', [tokens]);
  await pool.query(`INSERT INTO node_evidence_blocks(block_number,block_hash,parent_hash,timestamp,header) VALUES(500,$1,$2,$3,'{}')`, [hash(500), hash(499), recent]);
  await pool.query(`INSERT INTO worker_state(key,value) VALUES('node',jsonb_build_object('blockNumber',500,'blockHash',$1::text)),
      ('node_collection','{"blockNumber":500,"headBlock":506}')`, [hash(500)]);
  for (const token of tokens) await pool.query(`INSERT INTO trades(id,tx_hash,wallet_address,token_address,side,token_amount,block_number,block_hash,timestamp,source)
    VALUES($1,$1,$2,$3,'buy',1,1,$4,$5,'node')`, [hash(1000 + tokens.indexOf(token)), wallet, token, hash(1), old]);
  const seed = async (token: string, from: number, to: number, error: boolean, timestamp: string | null, balance = 100, status = 'Holding') => {
    await pool.query(`INSERT INTO position_snapshots(wallet_address,token_address,block_number,block_hash,balance_raw,status,error,checked_at,block_timestamp)
      SELECT $1,$2,n,'0x'||lpad(to_hex(n),64,'0'),CASE WHEN $5 THEN NULL ELSE $6::numeric END,$7,$5,now(),$8::timestamptz
      FROM generate_series($3::integer,$4::integer) n`, [wallet, token, from, to, error, balance, error ? 'Unknown' : status, timestamp]);
  };
  await seed(tokens[0], 1, 40, false, old);
  await seed(tokens[0], 100, 101, false, recent, 125, 'Added');
  await seed(tokens[0], 102, 102, true, recent);
  await seed(tokens[1], 1, 20, false, old, 0, 'Exited');
  await seed(tokens[2], 1, 40, false, old);
  await seed(tokens[2], 41, 42, true, old);
  await seed(tokens[3], 1, 5, false, null);
  await seed(tokens[3], 6, 15, false, old);
  await seed(tokens[4], 1, 30, false, old);
  await seed(tokens[4], 498, 500, false, recent, 150, 'Reduced');
  // A unique old successful anchor must survive many recent failures, even
  // though the API correctly keeps displaying the latest failed observation.
  await seed(tokens[5], 1, 15, false, old);
  await seed(tokens[5], 100, 140, true, recent);
  await pool.query(`INSERT INTO wallet_transfers(id,tx_hash,log_index,wallet_address,token_address,delta_raw,kind,block_number,block_hash,timestamp)
    VALUES('fixture-transfer',$1,0,$2,$3,25,'buy',101,$4,$5)`, [hash(1001), wallet, tokens[0], hash(101), recent]);
  await pool.query(`INSERT INTO node_evidence_transactions(tx_hash,block_number,block_hash,transaction_index,timestamp,transaction,receipt)
    VALUES($1,1,$2,0,$3,'{"input":"saved"}','{"logs":[{"data":"permanent"}]}')`, [hash(1001), hash(1), old]);
  await pool.query(`INSERT INTO node_accounting_history(scope_key,wallet_address,token_address,history_revision,from_block,to_block,to_hash,source,payload)
    VALUES('public',$1,$2,'original',1,500,$3,'node','{"purchases":[{"cost":"123.456789"}]}')`, [wallet, tokens[0], hash(500)]);
  await pool.query(`INSERT INTO node_accounting_snapshots(scope_key,wallet_address,token_address,snapshot_id,history_revision,as_of,complete,payload,summary)
    VALUES('public',$1,$2,'snapshot','original',now(),true,'{"profit":"456.78"}','{"realizedProfitUsd":"456.78"}')`, [wallet, tokens[0]]);
  await pool.query(`INSERT INTO node_import_movements(wallet_address,token_address,id,event,raw,payload_hash)
    VALUES($1,$2,'historical','{"kind":"buy"}','{"historical":true}','hash')`, [wallet, tokens[0]]);
  await pool.query(`INSERT INTO node_market_candles(token_address,market_id,minute,open,high,low,close,volume_usd,observations,first_observation_at,last_observation_at)
    VALUES($1,'market',$2,1,2,1,2,100,2,$2,$2)`, [tokens[0], old]);
  await pool.query(`INSERT INTO leaderboard_snapshots(wallet_address,period,realized_profit_usd) VALUES($1,'1d',456.78)`, [wallet]);
  registerIntelligenceRoutes(app);
  const before = await readPositions();
  const durable = new Map(await Promise.all(durableTables.map(async table => [table, await fingerprint(table)] as const)));
  let removed = 0, stablePasses = 0;
  for (let iteration = 0; iteration < 250 && stablePasses < 2; iteration++) {
    // Every invocation recreates the orchestration, proving the saved keyset
    // cursor resumes across restarts instead of relying on a process cache.
    const result = await prunePositionSnapshots(pool, { maxPairs: 2, maxRows: 7, rowsPerPair: 3, budgetMs: 1500 });
    assert.equal(result.skipped, false);
    assert.ok(result.visitedPairs <= 2 && result.prunedRows <= 7);
    removed += result.prunedRows;
    if (result.prunedRows) stablePasses = 0;
    else if (result.wrapped) stablePasses++;
  }
  assert.ok(removed > 100, `Expected meaningful compaction, got ${removed}`);
  assert.deepEqual(await readPositions(), before, 'Latest API balances/statuses/freshness are unchanged');
  assert.deepEqual((await rows(tokens[0])).map(row => row.height), [40, 100, 101, 102], 'Recent errors and pre-window anchor survive');
  assert.deepEqual((await rows(tokens[1])).map(row => row.height), [19, 20], 'Old closed positions retain current and prior successful rows');
  assert.deepEqual((await rows(tokens[2])).map(row => row.height), [39, 40, 42], 'Latest old failure and older successful baselines survive');
  assert.deepEqual((await rows(tokens[3])).map(row => row.height), [1, 2, 3, 4, 5, 14, 15], 'Unknown-age evidence is not assumed old');
  assert.deepEqual((await rows(tokens[4])).map(row => row.height), [30, 498, 499, 500]);
  assert.deepEqual((await rows(tokens[5])).filter(row => !row.error).map(row => row.height), [14, 15], 'Long failed streak cannot erase success anchors');
  const baseline = (await pool.query(`SELECT balance_raw::text,status FROM position_snapshots
    WHERE wallet_address=$1 AND token_address=$2 AND block_number<500 AND NOT error ORDER BY block_number DESC LIMIT 1`, [wallet, tokens[4]])).rows[0];
  assert.equal(baseline.balance_raw, '150', 'Same-height reruns still have an earlier successful baseline');
  assert.equal(classifyPosition(BigInt(baseline.balance_raw), 150n, [], baseline.status), 'Reduced');
  assert.equal(classifyPosition(100n, 125n, [{ kind: 'buy', delta: 25n }], 'Holding'), 'Added');
  for (const table of durableTables) assert.equal(await fingerprint(table), durable.get(table), `${table}: permanent financial history unchanged`);

  // Row locks are skipped rather than waited on. Advancing the pair cursor is
  // safe because the next complete sweep will revisit the still-present row.
  await seed(tokens[0], 1, 1, false, old);
  await pool.query(`UPDATE worker_state SET value=jsonb_set(value,'{cursor}','{"wallet":"","token":""}') WHERE key='position_snapshot_retention'`);
  const rowHolder = await pool.connect();
  try {
    await rowHolder.query('BEGIN');
    await rowHolder.query('SELECT 1 FROM position_snapshots WHERE wallet_address=$1 AND token_address=$2 AND block_number=1 FOR UPDATE', [wallet, tokens[0]]);
    const skippedRow = await prunePositionSnapshots(pool, { maxPairs: 1 });
    assert.equal(skippedRow.prunedRows, 0);
    assert.ok((await rows(tokens[0])).some(row => row.height === 1));
    await rowHolder.query('ROLLBACK');
  } finally { rowHolder.release(); }

  // A timed-out later pair rolls back an earlier pair's deletion AND the
  // resumable cursor. No counters may report deletions that were rolled back.
  await seed(tokens[1], 1, 1, false, old);
  await pool.query(`UPDATE worker_state SET value=jsonb_set(value,'{cursor}','{"wallet":"","token":""}') WHERE key='position_snapshot_retention'`);
  await pool.query(`CREATE FUNCTION slow_position_fixture() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
    IF OLD.token_address='${tokens[1]}' THEN PERFORM pg_sleep(3); END IF; RETURN OLD; END$$;
    CREATE TRIGGER slow_position_fixture BEFORE DELETE ON position_snapshots FOR EACH ROW EXECUTE FUNCTION slow_position_fixture()`);
  const positionsBeforeTimeout = await fingerprint('position_snapshots'), stateBeforeTimeout = await fingerprint('worker_state');
  const timeout = await prunePositionSnapshots(pool, { maxPairs: 2, maxRows: 4, rowsPerPair: 2, budgetMs: 2000 });
  assert.equal(timeout.reason, 'maintenance_budget');
  assert.equal(timeout.prunedRows, 0);
  assert.equal(await fingerprint('position_snapshots'), positionsBeforeTimeout);
  assert.equal(await fingerprint('worker_state'), stateBeforeTimeout);
  await pool.query('DROP TRIGGER slow_position_fixture ON position_snapshots; DROP FUNCTION slow_position_fixture()');

  // Another worker owns maintenance; do not duplicate deletion or advance the
  // cursor. This is a real PostgreSQL advisory lock, not a mocked transport.
  const holder = await pool.connect();
  try {
    await holder.query('BEGIN'); await holder.query('SELECT pg_advisory_xact_lock(782336)');
    const cursor = await fingerprint('worker_state');
    assert.equal((await prunePositionSnapshots(pool)).reason, 'maintenance_busy');
    assert.equal(await fingerprint('worker_state'), cursor);
    await holder.query('ROLLBACK');
  } finally { holder.release(); }
  const forkHolder = await pool.connect();
  try {
    await forkHolder.query('BEGIN'); await forkHolder.query('SELECT pg_advisory_xact_lock(782319)');
    assert.equal((await prunePositionSnapshots(pool)).reason, 'maintenance_budget', 'A reorg owns the rollback fence');
    await forkHolder.query('ROLLBACK');
  } finally { forkHolder.release(); }
  await pool.query(`UPDATE worker_state SET value='{"blockNumber":500,"headBlock":1000}' WHERE key='node_collection'`);
  assert.equal((await prunePositionSnapshots(pool)).reason, 'capture_priority');
  await pool.query(`UPDATE worker_state SET value='{"blockNumber":500,"headBlock":506}' WHERE key='node_collection'`);
  await pool.query('UPDATE node_evidence_blocks SET timestamp=now()-interval \'6 minutes\' WHERE block_number=500');
  assert.equal((await prunePositionSnapshots(pool)).reason, 'confirmed_checkpoint_unavailable');
  await pool.query('UPDATE node_evidence_blocks SET timestamp=$1 WHERE block_number=500', [recent]);
  await pool.query(`UPDATE worker_state SET value=jsonb_set(value,'{blockHash}',to_jsonb($1::text)) WHERE key='node'`, [hash(501)]);
  assert.equal((await prunePositionSnapshots(pool)).reason, 'confirmed_checkpoint_unavailable', 'Wrong canonical hash never authorizes pruning');
  await pool.query(`UPDATE worker_state SET value=jsonb_set(value,'{blockHash}',to_jsonb($1::text)) WHERE key='node'`, [hash(500)]);

  // Every recent checkpoint survives, so an ordinary rollback reveals exactly
  // the same earlier status/balance rather than a fabricated reconstruction.
  const rollbackExpected = (await rows(tokens[0])).filter(row => row.height < 102);
  await pool.query('BEGIN; SELECT pg_advisory_xact_lock(782319)');
  await pool.query('DELETE FROM position_snapshots WHERE block_number>=102');
  await pool.query('COMMIT');
  assert.deepEqual(await rows(tokens[0]), rollbackExpected);
  assert.equal((await readPositions()).find((row: { tokenAddress: string }) => row.tokenAddress === tokens[0]).status, 'Added');
  console.log(`Position retention PostgreSQL regression passed: ${removed} redundant observations pruned in bounded batches; ${positionSnapshotRetentionHours}h rollback window, failed/closed states and permanent trade/P&L/chart history preserved.`);
} finally {
  globalThis.fetch = nativeFetch;
  await app.close(); await pool.end();
  await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`); await admin.end();
}
