/** Local-only regression for schemas left behind by the reverted market prototype. */
import assert from 'node:assert/strict';
import pg from 'pg';
import { ensureNodeMarketSchema } from './nodeMarketSchema.js';

const connection=new URL(process.env.DATABASE_URL||'');
if(!['localhost','127.0.0.1'].includes(connection.hostname)||connection.port!=='5435'||!/^\/bscan_node_market_migration_test_\d+$/.test(connection.pathname))
  throw new Error('Use an explicitly disposable local bscan_node_market_migration_test_<timestamp> database');
const db=new pg.Pool({connectionString:connection.href});
try {
  await db.query(`
    CREATE TABLE node_market_observations (
      token_address text NOT NULL,market_address text NOT NULL,block_number bigint NOT NULL,
      block_hash text NOT NULL,timestamp timestamptz NOT NULL,transaction_index integer NOT NULL,
      log_index integer NOT NULL,price_usd numeric NOT NULL,volume_usd numeric,kind text NOT NULL,
      sampled boolean NOT NULL,quote_depth_usd numeric,pricing_version integer NOT NULL
    );
    CREATE INDEX node_market_observations_token_time ON node_market_observations(token_address,timestamp);
    INSERT INTO node_market_observations VALUES('old-token','old-market',1,'old-hash','2026-01-01',0,0,999,10,'swap',true,NULL,1);
    CREATE VIEW node_token_market_values AS SELECT token_address AS address,price_usd FROM node_market_observations;
    CREATE TABLE node_market_coverage (
      token_address text NOT NULL,from_block bigint NOT NULL,to_block bigint NOT NULL,
      from_time timestamptz NOT NULL,to_time timestamptz NOT NULL,block_hash text NOT NULL,
      complete boolean NOT NULL,reason text,sampled boolean NOT NULL,pricing_version integer NOT NULL
    );
    INSERT INTO node_market_coverage VALUES('old-token',1,2,'2026-01-01','2026-01-02','old-hash',true,NULL,true,1);
  `);
  await Promise.all([ensureNodeMarketSchema(db),ensureNodeMarketSchema(db)]);
  assert.equal((await db.query('SELECT price_usd::text FROM node_market_observations_legacy_v1')).rows[0].price_usd,'999');
  assert.equal((await db.query('SELECT count(*)::int AS n FROM node_market_coverage_legacy_v1')).rows[0].n,1);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM node_token_market_values_legacy_v1')).rows[0].n,1,'old view still references preserved rows');
  assert.equal((await db.query('SELECT count(*)::int AS n FROM node_market_observations')).rows[0].n,0,'legacy rows never become authenticated node data');
  assert.equal((await db.query('SELECT count(*)::int AS n FROM node_token_market_values')).rows[0].n,0);
  assert.equal((await db.query("SELECT c.relname FROM pg_index i JOIN pg_class c ON c.oid=i.indrelid WHERE i.indexrelid='node_market_observations_token_time'::regclass")).rows[0].relname,'node_market_observations','fresh index belongs to fresh evidence table');
  await db.query(`INSERT INTO node_market_observations(id,token_address,kind,source,timestamp,price_usd,import_id)
    VALUES('new-row','new-token','imported','imported','2026-10-01',2,'migration-fixture')`);
  // These are genuine additive upgrades, not an incompatible financial schema.
  await db.query('ALTER TABLE node_market_observations DROP COLUMN candles_pending');
  await db.query('ALTER TABLE node_markets DROP COLUMN backfill_next_block');
  await db.query('ALTER TABLE node_market_feed_evidence DROP COLUMN feed_description');
  await Promise.all([ensureNodeMarketSchema(db),ensureNodeMarketSchema(db)]);
  assert.equal((await db.query('SELECT id FROM node_market_observations')).rows[0].id,'new-row');
  assert.equal((await db.query('SELECT price_usd::text FROM node_token_market_values')).rows[0].price_usd,'2');
  assert.equal((await db.query("SELECT to_regclass('node_market_observations_legacy_v1_2') AS name")).rows[0].name,null,'compatible reruns never archive current rows');
  console.log('node market legacy migration integration passed');
} finally { await db.end(); }
