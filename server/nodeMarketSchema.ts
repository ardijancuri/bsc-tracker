import type { Pool, PoolClient } from 'pg';

export async function ensureNodeMarketSchema(db: Pick<Pool | PoolClient, 'query'>) {
  await db.query(`
    SELECT pg_advisory_xact_lock(908334);
    -- Earlier, reverted market prototypes used these names with different evidence
    -- semantics. Preserve those tables together rather than upgrading their rows
    -- into authenticated observations. This block and the DDL below are one atomic
    -- PostgreSQL statement batch; API and worker startup share the same lock.
    DO $market_migration$
    DECLARE
      expected record; relation_name text; archived_name text; index_row record;
      incompatible boolean := false; suffix integer; relation_kind "char";
      family text[] := ARRAY['node_market_discoveries','node_markets',
        'node_market_token_evidence','node_market_feed_evidence','node_market_quote_evidence','node_market_raw_logs',
        'node_market_observations','node_market_candles','node_market_ranges','node_market_import_ranges'];
    BEGIN
      FOR expected IN SELECT * FROM (VALUES
        ('node_market_discoveries','token_address','text'),
        ('node_market_discoveries','last_attempt_at','timestamptz'),
        ('node_markets','id','text'),('node_markets','token_address','text'),
        ('node_markets','quote_address','text'),('node_markets','protocol','text'),
        ('node_markets','contract_address','text'),('node_markets','pool_id','text'),
        ('node_markets','token0','text'),('node_markets','token1','text'),
        ('node_markets','decimals0','int4'),('node_markets','decimals1','int4'),
        ('node_markets','authenticated_at_block','int8'),('node_markets','authenticated_block_hash','text'),
        ('node_markets','authentication','jsonb'),('node_markets','decoder_version','int4'),
        ('node_markets','status','text'),('node_markets','discovered_at','timestamptz'),
        ('node_markets','checked_at','timestamptz'),('node_markets','retry_at','timestamptz'),
        ('node_markets','collected_from_block','int8'),('node_markets','collected_through_block','int8'),
        ('node_markets','collection_gap','bool'),('node_markets','last_error','text'),
        ('node_market_token_evidence','token_address','text'),('node_market_token_evidence','block_number','int8'),
        ('node_market_token_evidence','block_hash','text'),('node_market_token_evidence','timestamp','timestamptz'),
        ('node_market_token_evidence','decimals','int4'),('node_market_token_evidence','total_supply_raw','numeric'),
        ('node_market_token_evidence','supply','numeric'),
        ('node_market_feed_evidence','quote_address','text'),('node_market_feed_evidence','feed_address','text'),
        ('node_market_feed_evidence','block_number','int8'),('node_market_feed_evidence','block_hash','text'),
        ('node_market_feed_evidence','timestamp','timestamptz'),('node_market_feed_evidence','round_id','numeric'),
        ('node_market_feed_evidence','answered_in_round','numeric'),('node_market_feed_evidence','answer_raw','numeric'),
        ('node_market_feed_evidence','feed_decimals','int4'),('node_market_feed_evidence','price_usd','numeric'),
        ('node_market_feed_evidence','updated_at','timestamptz'),
        ('node_market_quote_evidence','quote_address','text'),('node_market_quote_evidence','block_number','int8'),
        ('node_market_quote_evidence','block_hash','text'),('node_market_quote_evidence','timestamp','timestamptz'),
        ('node_market_quote_evidence','price_usd','numeric'),('node_market_quote_evidence','base_quote_address','text'),
        ('node_market_quote_evidence','pool_address','text'),('node_market_quote_evidence','protocol','text'),
        ('node_market_quote_evidence','depth_usd','numeric'),('node_market_quote_evidence','evidence','jsonb'),
        ('node_market_quote_evidence','schema_version','int4'),
        ('node_market_raw_logs','market_id','text'),('node_market_raw_logs','block_number','int8'),
        ('node_market_raw_logs','block_hash','text'),('node_market_raw_logs','tx_hash','text'),
        ('node_market_raw_logs','transaction_index','int4'),('node_market_raw_logs','log_index','int4'),
        ('node_market_raw_logs','timestamp','timestamptz'),('node_market_raw_logs','log','jsonb'),
        ('node_market_raw_logs','decoder_version','int4'),('node_market_raw_logs','decode_status','text'),
        ('node_market_observations','id','text'),('node_market_observations','token_address','text'),
        ('node_market_observations','market_id','text'),('node_market_observations','kind','text'),
        ('node_market_observations','source','text'),('node_market_observations','timestamp','timestamptz'),
        ('node_market_observations','block_number','int8'),('node_market_observations','block_hash','text'),
        ('node_market_observations','tx_hash','text'),('node_market_observations','transaction_index','int4'),
        ('node_market_observations','log_index','int4'),('node_market_observations','price_usd','numeric'),
        ('node_market_observations','quote_price_usd','numeric'),('node_market_observations','token_amount_raw','numeric'),
        ('node_market_observations','quote_amount_raw','numeric'),('node_market_observations','volume_usd','numeric'),
        ('node_market_observations','supply','numeric'),('node_market_observations','supply_estimated','bool'),
        ('node_market_observations','interval_seconds','int4'),('node_market_observations','open','numeric'),
        ('node_market_observations','high','numeric'),('node_market_observations','low','numeric'),
        ('node_market_observations','close','numeric'),('node_market_observations','import_id','text'),
        ('node_market_observations','created_at','timestamptz'),
        ('node_market_candles','token_address','text'),('node_market_candles','market_id','text'),
        ('node_market_candles','minute','timestamptz'),('node_market_candles','open','numeric'),
        ('node_market_candles','high','numeric'),('node_market_candles','low','numeric'),
        ('node_market_candles','close','numeric'),('node_market_candles','volume_usd','numeric'),
        ('node_market_candles','observations','int4'),('node_market_candles','first_observation_at','timestamptz'),
        ('node_market_candles','last_observation_at','timestamptz'),
        ('node_market_ranges','market_id','text'),('node_market_ranges','from_block','int8'),
        ('node_market_ranges','to_block','int8'),('node_market_ranges','from_hash','text'),
        ('node_market_ranges','to_hash','text'),('node_market_ranges','from_at','timestamptz'),
        ('node_market_ranges','to_at','timestamptz'),('node_market_ranges','complete','bool'),
        ('node_market_import_ranges','token_address','text'),('node_market_import_ranges','import_id','text'),
        ('node_market_import_ranges','from_at','timestamptz'),('node_market_import_ranges','to_at','timestamptz'),
        ('node_market_import_ranges','complete','bool')
      ) AS required(table_name,column_name,type_name)
      LOOP
        IF to_regclass(expected.table_name) IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM pg_attribute a JOIN pg_type t ON t.oid=a.atttypid
          WHERE a.attrelid=to_regclass(expected.table_name) AND a.attname=expected.column_name
            AND a.attnum>0 AND NOT a.attisdropped AND t.typname=expected.type_name
        ) THEN incompatible := true; END IF;
      END LOOP;
      IF incompatible AND to_regclass('node_token_market_values') IS NOT NULL THEN
        archived_name := 'node_token_market_values_legacy_v1'; suffix := 1;
        WHILE to_regclass(archived_name) IS NOT NULL LOOP
          suffix := suffix+1; archived_name := 'node_token_market_values_legacy_v1_'||suffix;
        END LOOP;
        SELECT relkind INTO relation_kind FROM pg_class WHERE oid=to_regclass('node_token_market_values');
        IF relation_kind='v' THEN
          EXECUTE format('ALTER VIEW node_token_market_values RENAME TO %I',archived_name);
        ELSIF relation_kind='m' THEN
          EXECUTE format('ALTER MATERIALIZED VIEW node_token_market_values RENAME TO %I',archived_name);
        ELSE RAISE EXCEPTION 'Unsupported legacy node_token_market_values relation'; END IF;
      END IF;
      FOREACH relation_name IN ARRAY family||ARRAY['node_market_coverage'] LOOP
        IF to_regclass(relation_name) IS NULL OR (NOT incompatible AND relation_name<>'node_market_coverage') THEN CONTINUE; END IF;
        archived_name := relation_name||'_legacy_v1'; suffix := 1;
        WHILE to_regclass(archived_name) IS NOT NULL LOOP
          suffix := suffix+1; archived_name := relation_name||'_legacy_v1_'||suffix;
        END LOOP;
        -- Index names share the schema namespace. Retain them with the archived
        -- table so fresh current indexes cannot accidentally reuse a legacy one.
        FOR index_row IN SELECT c.relname FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
          WHERE i.indrelid=to_regclass(relation_name)
        LOOP
          EXECUTE format('ALTER INDEX %I RENAME TO %I',index_row.relname,
            left(index_row.relname,38)||'_legacy_'||substr(md5(archived_name||index_row.relname),1,16));
        END LOOP;
        EXECUTE format('ALTER TABLE %I RENAME TO %I',relation_name,archived_name);
      END LOOP;
    END $market_migration$;
    CREATE TABLE IF NOT EXISTS node_market_discoveries (
      token_address text PRIMARY KEY,last_attempt_at timestamptz NOT NULL DEFAULT now(),last_error text
    );
    CREATE TABLE IF NOT EXISTS node_market_refresh_jobs (
      token_address text PRIMARY KEY,requested_at timestamptz NOT NULL DEFAULT now(),
      priority integer NOT NULL DEFAULT 1,expires_at timestamptz NOT NULL
    );
    CREATE TABLE IF NOT EXISTS node_market_history_jobs (
      token_address text NOT NULL,window_id text NOT NULL,snapshot_id text,from_at timestamptz NOT NULL,to_at timestamptz NOT NULL,
      requested_at timestamptz NOT NULL DEFAULT now(),expires_at timestamptz NOT NULL,priority integer NOT NULL DEFAULT 10,
      next_block bigint,end_block bigint,lease_id text,lease_until timestamptz,next_attempt_at timestamptz NOT NULL DEFAULT now(),
      last_error text,completed_at timestamptz,PRIMARY KEY(token_address,window_id),CHECK(to_at>=from_at)
    );
    CREATE TABLE IF NOT EXISTS node_markets (
      id text PRIMARY KEY, token_address text NOT NULL, quote_address text NOT NULL,
      protocol text NOT NULL CHECK(protocol IN ('pcs_v2','pcs_v3','fourmeme','flap','infinity_cl','infinity_bin')),
      contract_address text NOT NULL, pool_id text, token0 text NOT NULL, token1 text NOT NULL,
      decimals0 integer CHECK(decimals0 BETWEEN 0 AND 36), decimals1 integer CHECK(decimals1 BETWEEN 0 AND 36),
      authenticated_at_block bigint NOT NULL, authenticated_block_hash text NOT NULL,
      authentication jsonb NOT NULL, decoder_version integer NOT NULL DEFAULT 1,
      status text NOT NULL CHECK(status IN ('active','graduated','unsupported','repair')),
      discovered_at timestamptz NOT NULL DEFAULT now(), checked_at timestamptz, retry_at timestamptz,
      collected_from_block bigint, collected_through_block bigint, collection_gap boolean NOT NULL DEFAULT false,
      backfill_next_block bigint,backfill_floor_block bigint,
      last_error text
    );
    CREATE INDEX IF NOT EXISTS node_markets_token_idx ON node_markets(token_address,status);
    ALTER TABLE node_markets ADD COLUMN IF NOT EXISTS backfill_next_block bigint;
    ALTER TABLE node_markets ADD COLUMN IF NOT EXISTS backfill_floor_block bigint;
    CREATE INDEX IF NOT EXISTS node_markets_collection_idx ON node_markets(status,collected_through_block);
    CREATE TABLE IF NOT EXISTS node_market_token_evidence (
      token_address text NOT NULL, block_number bigint NOT NULL, block_hash text NOT NULL,
      timestamp timestamptz NOT NULL, decimals integer NOT NULL CHECK(decimals BETWEEN 0 AND 36),
      total_supply_raw numeric NOT NULL CHECK(total_supply_raw>=0), supply numeric NOT NULL CHECK(supply>=0),
      PRIMARY KEY(token_address,block_hash)
    );
    CREATE INDEX IF NOT EXISTS node_market_token_evidence_height ON node_market_token_evidence(token_address,block_number DESC);
    CREATE TABLE IF NOT EXISTS node_market_feed_evidence (
      quote_address text NOT NULL, feed_address text NOT NULL, block_number bigint NOT NULL,
      feed_description text,
      block_hash text NOT NULL, timestamp timestamptz NOT NULL, round_id numeric NOT NULL,
      answered_in_round numeric NOT NULL, answer_raw numeric NOT NULL, feed_decimals integer NOT NULL,
      price_usd numeric NOT NULL CHECK(price_usd>0), updated_at timestamptz NOT NULL,
      PRIMARY KEY(quote_address,block_hash)
    );
    CREATE TABLE IF NOT EXISTS node_market_quote_evidence (
      quote_address text NOT NULL,block_number bigint NOT NULL,block_hash text NOT NULL,timestamp timestamptz NOT NULL,
      price_usd numeric NOT NULL CHECK(price_usd>0),base_quote_address text NOT NULL,pool_address text NOT NULL,
      protocol text NOT NULL CHECK(protocol IN ('pcs_v2','pcs_v3')),depth_usd numeric NOT NULL CHECK(depth_usd>=1000),
      evidence jsonb NOT NULL,schema_version integer NOT NULL DEFAULT 1,PRIMARY KEY(quote_address,block_hash)
    );
    ALTER TABLE node_market_feed_evidence ADD COLUMN IF NOT EXISTS feed_description text;
    CREATE INDEX IF NOT EXISTS node_market_feed_observation ON node_market_feed_evidence(quote_address,timestamp DESC,block_number DESC);
    CREATE INDEX IF NOT EXISTS node_market_quote_observation ON node_market_quote_evidence(quote_address,timestamp DESC,block_number DESC) WHERE schema_version=1;
    CREATE TABLE IF NOT EXISTS node_market_raw_logs (
      market_id text NOT NULL REFERENCES node_markets(id), block_number bigint NOT NULL,
      block_hash text NOT NULL, tx_hash text NOT NULL, transaction_index integer NOT NULL, log_index integer NOT NULL,
      timestamp timestamptz NOT NULL, log jsonb NOT NULL, decoder_version integer NOT NULL DEFAULT 1,
      decode_status text NOT NULL CHECK(decode_status IN ('pending','decoded','unsupported','missing_quote','invalid')),
      PRIMARY KEY(market_id,block_hash,tx_hash,log_index)
    );
    CREATE INDEX IF NOT EXISTS node_market_raw_logs_repair ON node_market_raw_logs(decode_status,block_number);
    CREATE INDEX IF NOT EXISTS node_market_raw_pending_window ON node_market_raw_logs(market_id,timestamp,block_number,transaction_index,log_index)
      WHERE decode_status IN ('pending','missing_quote');
    CREATE TABLE IF NOT EXISTS node_market_observations (
      id text PRIMARY KEY, token_address text NOT NULL, market_id text REFERENCES node_markets(id),
      kind text NOT NULL CHECK(kind IN ('swap','state','imported')),
      source text NOT NULL CHECK(source IN ('node','imported')), timestamp timestamptz NOT NULL,
      block_number bigint, block_hash text, tx_hash text, transaction_index integer, log_index integer,
      price_usd numeric NOT NULL CHECK(price_usd>0), quote_price_usd numeric,
      token_amount_raw numeric, quote_amount_raw numeric, volume_usd numeric CHECK(volume_usd>=0),
      supply numeric, supply_estimated boolean NOT NULL DEFAULT false,
      interval_seconds integer NOT NULL DEFAULT 0 CHECK(interval_seconds>=0),
      open numeric, high numeric, low numeric, close numeric, import_id text,
      candles_pending boolean NOT NULL DEFAULT true,
      quote_evidence jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      CHECK((source='node' AND block_number IS NOT NULL AND block_hash IS NOT NULL)
        OR (source='imported' AND kind='imported' AND import_id IS NOT NULL AND block_number IS NULL AND block_hash IS NULL))
    );
    CREATE INDEX IF NOT EXISTS node_market_observations_token_time ON node_market_observations(token_address,timestamp,block_number,transaction_index,log_index);
    CREATE INDEX IF NOT EXISTS node_market_observations_reorg ON node_market_observations(block_number) WHERE source='node';
    ALTER TABLE node_market_observations ADD COLUMN IF NOT EXISTS candles_pending boolean NOT NULL DEFAULT true;
    ALTER TABLE node_market_observations ADD COLUMN IF NOT EXISTS quote_evidence jsonb;
    CREATE INDEX IF NOT EXISTS node_market_candles_pending ON node_market_observations(timestamp) WHERE kind='swap' AND candles_pending;
    CREATE TABLE IF NOT EXISTS node_market_candles (
      token_address text NOT NULL, market_id text NOT NULL, minute timestamptz NOT NULL,
      open numeric NOT NULL, high numeric NOT NULL, low numeric NOT NULL, close numeric NOT NULL,
      volume_usd numeric NOT NULL, observations integer NOT NULL, first_observation_at timestamptz NOT NULL,
      last_observation_at timestamptz NOT NULL, PRIMARY KEY(token_address,market_id,minute)
    );
    CREATE TABLE IF NOT EXISTS node_market_ranges (
      market_id text NOT NULL REFERENCES node_markets(id), from_block bigint NOT NULL, to_block bigint NOT NULL,
      from_hash text NOT NULL, to_hash text NOT NULL, from_at timestamptz NOT NULL, to_at timestamptz NOT NULL,
      complete boolean NOT NULL, PRIMARY KEY(market_id,from_block,to_block), CHECK(to_block>=from_block)
    );
    CREATE TABLE IF NOT EXISTS node_market_import_ranges (
      token_address text NOT NULL, import_id text NOT NULL, from_at timestamptz NOT NULL,
      to_at timestamptz NOT NULL, complete boolean NOT NULL, PRIMARY KEY(token_address,import_id,from_at,to_at), CHECK(to_at>=from_at)
    );
    CREATE OR REPLACE VIEW node_token_market_values AS
      SELECT DISTINCT ON(token_address) token_address AS address,price_usd,
        price_usd*supply AS market_cap_usd,supply,timestamp AS observed_at,block_number,block_hash,source,
        supply_estimated,market_id FROM node_market_observations
      ORDER BY token_address,timestamp DESC,CASE WHEN source='node' THEN 0 ELSE 1 END,
        COALESCE(block_number,0) DESC,CASE WHEN kind='state' AND tx_hash IS NULL THEN 1 ELSE 0 END DESC,
        COALESCE(transaction_index,-1) DESC,CASE WHEN kind='state' THEN 1 ELSE 0 END DESC,COALESCE(log_index,-1) DESC;
  `);
}
