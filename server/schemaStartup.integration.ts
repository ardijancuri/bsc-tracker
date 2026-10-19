import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import pg from 'pg';
import { runSchemaStartup } from './schemaStartup.js';

const configured = new URL(process.env.DATABASE_URL ?? 'postgres://invalid');
if (!['localhost', '127.0.0.1'].includes(configured.hostname) || configured.port !== '5435') throw new Error('Disposable local PostgreSQL only');
const admin = new pg.Client({ connectionString: configured.href });
await admin.connect();
const name = `schema_startup_test_${randomUUID().replaceAll('-', '')}`;
await admin.query(`CREATE DATABASE "${name}"`);
const connection = new URL(configured); connection.pathname = `/${name}`;
const database = new pg.Pool({ connectionString: connection.href, max: 6 });
try {
  // Real independent processes/pools reproduce API and worker startup against
  // a new cloned schema, including all existing per-module migration locks.
  const child = `import { ensureSchema, pool } from './server/db.ts';
    try { await Promise.all([ensureSchema(),ensureSchema()]); }
    finally { await pool.end(); }`;
  const launch = () => promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', child], {
    cwd: process.cwd(), env: { ...process.env, DATABASE_URL: connection.href, TELEGRAM_BOT_TOKEN: '' }, timeout: 60_000, maxBuffer: 512 * 1024,
  });
  await Promise.all([launch(), launch()]);
  for (const table of ['kols', 'trades', 'position_snapshots', 'node_evidence_transactions', 'node_executions', 'node_import_jobs', 'node_accounting_snapshots', 'telegram_notification_outbox']) {
    assert.equal((await database.query('SELECT to_regclass($1) relation', [`public.${table}`])).rows[0].relation, table);
  }

  await database.query('CREATE TABLE startup_busy(id integer); CREATE TABLE startup_attempts(id integer PRIMARY KEY)');
  const blocker = await database.connect();
  let retryObserved!: () => void;
  const observed = new Promise<void>(resolve => { retryObserved = resolve; });
  let attempts = 0;
  try {
    await blocker.query('BEGIN');
    await blocker.query('LOCK TABLE startup_busy IN ACCESS EXCLUSIVE MODE');
    const startup = runSchemaStartup(database, async () => {
      const client = await database.connect();
      attempts++;
      try {
        await client.query('BEGIN');
        await client.query("SET LOCAL lock_timeout='50ms'");
        await client.query('INSERT INTO startup_attempts(id) VALUES($1)', [attempts]);
        await client.query('LOCK TABLE startup_busy IN ACCESS EXCLUSIVE MODE');
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK'); retryObserved(); throw error;
      } finally { client.release(); }
    });
    // An actual PostgreSQL lock conflict must roll back and then recover; this
    // is not a synthetic rejection from a mocked database implementation.
    await Promise.race([observed, startup.then(() => { throw new Error('Expected startup DDL contention'); })]);
    await blocker.query('COMMIT');
    await startup;
    assert.equal(attempts, 2);
    assert.deepEqual((await database.query('SELECT id FROM startup_attempts')).rows, [{ id: 2 }], 'The failed attempt must leave no committed partial data');
  } finally { await blocker.query('ROLLBACK'); blocker.release(); }

  let deadlocks = 0;
  await assert.rejects(runSchemaStartup(database, async () => {
    deadlocks++;
    await database.query("DO $$ BEGIN RAISE EXCEPTION 'deadlock regression' USING ERRCODE='40P01'; END $$");
  }), (error: unknown) => typeof error === 'object' && error !== null && 'code' in error && error.code === '40P01');
  assert.equal(deadlocks, 4, 'Deadlock retries are bounded');
  let invalidMigrations = 0;
  await assert.rejects(runSchemaStartup(database, async () => {
    invalidMigrations++;
    await database.query('SELECT * FROM missing_startup_relation');
  }));
  assert.equal(invalidMigrations, 1, 'Non-transient migration failures must not retry');
  await runSchemaStartup(database, async () => { await database.query('SELECT 1'); });
  const probe = await database.connect();
  try {
    await probe.query('BEGIN');
    assert.equal((await probe.query('SELECT pg_try_advisory_xact_lock(782344) acquired')).rows[0].acquired, true, 'Failure must release the startup guard');
    await probe.query('ROLLBACK');
  } finally { probe.release(); }
  console.log('Schema-startup PostgreSQL regression passed: independent concurrent migrations, real lock recovery, bounded deadlock retries and lock release');
} finally {
  await database.end();
  await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
  await admin.end();
}
