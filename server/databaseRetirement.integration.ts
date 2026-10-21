import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import pg from 'pg';
import { databaseRetirementStatus, retireObsoleteTables, restoreRetiredTables, retirementSchema, retirementTables } from './databaseRetirement.js';

const configured = new URL(process.env.DATABASE_URL ?? 'postgres://invalid');
if (!['localhost', '127.0.0.1'].includes(configured.hostname) || configured.port !== '5435') throw new Error('Disposable local PostgreSQL only');
const admin = new pg.Client({ connectionString: configured.href });
await admin.connect();
const name = `database_retirement_test_${randomUUID().replaceAll('-', '')}`;
await admin.query(`CREATE DATABASE "${name}"`);
const connection = new URL(configured); connection.pathname = `/${name}`;
const database = new pg.Pool({ connectionString: connection.href, max: 5 });
const startup = () => promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval',
  "import {ensureSchema,pool} from './server/db.ts'; try { await ensureSchema(); await ensureSchema(); } finally { await pool.end(); }"],
{ cwd: process.cwd(), env: { ...process.env, DATABASE_URL: connection.href, TELEGRAM_BOT_TOKEN: '', TELEGRAM_CLIENT_ID: '', TELEGRAM_CLIENT_SECRET: '' }, timeout: 60_000, maxBuffer: 512 * 1024 });
try {
  await startup();
  assert.ok((await databaseRetirementStatus(database)).tables.every(table => table.state === 'absent'),
    'New installs do not recreate obsolete tables');
  const wallet = `0x${'1'.repeat(40)}`, token = `0x${'2'.repeat(40)}`, hash = `0x${'3'.repeat(64)}`;
  await database.query("INSERT INTO kols(address,is_tracked) VALUES($1,true);", [wallet]);
  await database.query('INSERT INTO tokens(address) VALUES($1)', [token]);
  // Old tables keep authentic outgoing links and arbitrary saved contents.
  for (const table of retirementTables) {
    await database.query(`CREATE TABLE public."${table}"(id integer PRIMARY KEY,wallet_address text REFERENCES kols(address),
      token_address text REFERENCES tokens(address),payload jsonb NOT NULL)`);
    await database.query(`INSERT INTO public."${table}" VALUES(1,$1,$2,$3::jsonb),(2,$1,$2,$4::jsonb)`,
      [wallet, token, JSON.stringify({ history: table, amount: '0.000000000000000001' }), JSON.stringify({ preserve: true })]);
  }
  await database.query(`INSERT INTO journal_node_evidence(tx_hash,block_number,block_hash,timestamp,transaction,receipt,bnb_price_usd,bnb_priced_at)
    VALUES($1,100,$1,'2026-10-20T10:00:00Z','{"unique":true}','{"logs":[]}',643.123456789,'2026-10-20T09:59:00Z')`, [hash]);
  const uniqueReceipt = (await database.query('SELECT * FROM journal_node_evidence')).rows;
  const original = await databaseRetirementStatus(database);
  assert.ok(original.tables.every(table => table.state === 'active' && table.publicRows === '2'));

  await database.query(`CREATE SCHEMA ${retirementSchema}; CREATE TABLE ${retirementSchema}.backfill_jobs(id integer)`);
  await assert.rejects(retireObsoleteTables(database), /retirement_destination_collision:backfill_jobs/);
  await database.query(`DROP TABLE ${retirementSchema}.backfill_jobs`);
  assert.ok((await databaseRetirementStatus(database)).tables.every(table => table.state === 'active'));

  await database.query('CREATE TABLE active_dependency(id integer PRIMARY KEY,legacy_id integer REFERENCES backfill_jobs(id))');
  await assert.rejects(retireObsoleteTables(database), /retirement_incoming_foreign_key:public.active_dependency/);
  await database.query('DROP TABLE active_dependency');
  await database.query('CREATE VIEW active_dependency AS SELECT * FROM launch_observations');
  await assert.rejects(retireObsoleteTables(database), /retirement_dependent_view:public.active_dependency/);
  await database.query('DROP VIEW active_dependency');
  await database.query(`CREATE FUNCTION retirement_test_trigger() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN NEW; END$$;
    CREATE TRIGGER custom_dependency BEFORE INSERT ON liquidity_observations FOR EACH ROW EXECUTE FUNCTION retirement_test_trigger()`);
  await assert.rejects(retireObsoleteTables(database), /retirement_custom_trigger:custom_dependency/);
  await database.query('DROP TRIGGER custom_dependency ON liquidity_observations; DROP FUNCTION retirement_test_trigger()');

  const blocker = await database.connect();
  try {
    await blocker.query('BEGIN; LOCK TABLE backfill_jobs IN ACCESS EXCLUSIVE MODE');
    await assert.rejects(retireObsoleteTables(database), (error: unknown) => (error as { code?: string }).code === '55P03');
    await blocker.query('ROLLBACK');
  } finally { await blocker.query('ROLLBACK'); blocker.release(); }
  assert.deepEqual(await databaseRetirementStatus(database), original, 'Lock failure rolls the entire operation back');

  const results = await Promise.all([retireObsoleteTables(database), retireObsoleteTables(database)]);
  assert.deepEqual(results.map(result => result.moved.length).sort((a, b) => a - b), [0, retirementTables.length],
    'Concurrent maintenance requests serialize without moving or copying data twice');
  const retired = await databaseRetirementStatus(database);
  for (const table of retired.tables) {
    const before = original.tables.find(value => value.name === table.name)!;
    assert.equal(table.state, 'retired'); assert.equal(table.retiredOid, before.publicOid); assert.equal(table.retiredRows, before.publicRows);
    assert.deepEqual((await database.query(`SELECT payload FROM ${retirementSchema}."${table.name}" ORDER BY id`)).rows,
      [{ payload: { history: table.name, amount: '0.000000000000000001' } }, { payload: { preserve: true } }]);
  }
  await startup();
  assert.deepEqual(await databaseRetirementStatus(database), retired,
    'Two complete API/worker schema startups preserve archives and do not recreate retired public names');
  assert.deepEqual((await database.query('SELECT * FROM journal_node_evidence')).rows, uniqueReceipt,
    'Unique historical journal receipts and BNB valuation evidence remain unchanged in public');
  assert.equal((await database.query("SELECT to_regclass('public.node_import_page_versions')::text name")).rows[0].name, 'node_import_page_versions');
  const restored = await restoreRetiredTables(database);
  assert.equal(restored.moved.length, retirementTables.length);
  assert.deepEqual((await restoreRetiredTables(database)).moved, []);
  assert.deepEqual(await databaseRetirementStatus(database), original, 'Restore retains every original OID and exact row count');
  assert.deepEqual((await database.query('SELECT * FROM journal_node_evidence')).rows, uniqueReceipt);
  console.log('Database retirement integration passed: preserved OIDs/rows/content, two restarts, blockers, lock timeout, concurrent idempotency, restore and unique receipts');
} finally {
  await database.end();
  await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
  await admin.end();
}
