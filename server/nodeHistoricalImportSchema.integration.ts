import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { ensureNodeHistoricalImportSchema } from './nodeHistoricalImportSchema.js';

const configured = new URL(process.env.DATABASE_URL ?? 'postgres://invalid');
if (!['localhost', '127.0.0.1'].includes(configured.hostname) || configured.port !== '5435') throw new Error('Disposable local PostgreSQL only');
const admin = new pg.Client({ connectionString: configured.href });
await admin.connect();
const name = `node_import_schema_test_${randomUUID().replaceAll('-', '')}`;
await admin.query(`CREATE DATABASE "${name}"`);
const connection = new URL(configured); connection.pathname = `/${name}`;
const database = new pg.Pool({ connectionString: connection.href, max: 5 });
try {
  const gate = await database.connect();
  try {
    await gate.query('BEGIN');
    await gate.query('SELECT pg_advisory_xact_lock(782343)');
    // Stand in for the API and worker starting against a fresh cloned schema.
    // Both must wait before any catalog writes, not merely tolerate a race.
    const starts = Promise.allSettled([ensureNodeHistoricalImportSchema(database), ensureNodeHistoricalImportSchema(database)]);
    try {
      const deadline = Date.now() + 5000;
      let waiting = 0;
      while (Date.now() < deadline) {
        waiting = (await database.query(`SELECT count(*)::int AS n FROM pg_locks
          WHERE locktype='advisory' AND classid=0 AND objid=782343 AND NOT granted
            AND database=(SELECT oid FROM pg_database WHERE datname=current_database())`)).rows[0].n;
        if (waiting === 2) break;
        await delay(10);
      }
      assert.equal(waiting, 2, 'Both concurrent starts must wait on the shared transaction lock');
      assert.equal((await gate.query("SELECT to_regclass('public.node_import_jobs') AS relation")).rows[0].relation, null,
        'No import table may be created while another process holds its migration lock');
    } finally { await gate.query('ROLLBACK'); }
    const outcomes = await starts;
    for (const outcome of outcomes) if (outcome.status === 'rejected') throw outcome.reason;
  } finally { gate.release(); }

  const tables = ['node_import_jobs', 'node_import_pages', 'node_import_movements', 'node_import_page_versions',
    'node_import_chart_pages', 'node_import_wallet_jobs', 'node_import_wallet_pages', 'node_import_wallet_head_checks', 'node_import_aggregates'];
  assert.equal((await database.query('SELECT count(*)::int n FROM pg_tables WHERE schemaname=\'public\' AND tablename=ANY($1::text[])', [tables])).rows[0].n, tables.length);
  await database.query(`INSERT INTO node_import_jobs(wallet_address,token_address,cursor,pagination_cursors,attempts)
    VALUES('wallet','token','completed-page',ARRAY['initial','completed-page'],2);
    INSERT INTO node_import_pages(wallet_address,token_address,cursor_key,payload,payload_hash)
      VALUES('wallet','token','initial','{"complete":true}','evidence-hash');`);
  await Promise.all([ensureNodeHistoricalImportSchema(database), ensureNodeHistoricalImportSchema(database), ensureNodeHistoricalImportSchema(database)]);
  const progress = (await database.query('SELECT cursor,pagination_cursors,attempts FROM node_import_jobs')).rows[0];
  assert.deepEqual(progress, { cursor: 'completed-page', pagination_cursors: ['initial', 'completed-page'], attempts: 2 });
  assert.deepEqual((await database.query('SELECT payload,payload_hash FROM node_import_pages')).rows[0], { payload: { complete: true }, payload_hash: 'evidence-hash' });
  // The advisory lock belongs to the batch's transaction, not a pooled session.
  const probe = await database.connect();
  try {
    await probe.query('BEGIN');
    assert.equal((await probe.query('SELECT pg_try_advisory_xact_lock(782343) acquired')).rows[0].acquired, true);
    await probe.query('ROLLBACK');
  } finally { probe.release(); }
  console.log('Historical-import PostgreSQL schema regression passed: concurrent initial starts, idempotent restarts, preserved progress and released lock');
} finally {
  await database.end();
  await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
  await admin.end();
}
