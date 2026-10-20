import type { Pool } from 'pg';

export async function ensureNodeHistoricalImportSchema(db: Pick<Pool, 'query'>) {
  await db.query(`
    -- This complete SQL batch executes in one transaction, including when db
    -- is a pool. Separate startup processes must acquire the same lock before
    -- checking catalog names: IF NOT EXISTS alone cannot prevent a pg_type race.
    SELECT pg_advisory_xact_lock(782343);
    CREATE TABLE IF NOT EXISTS node_import_jobs (
      wallet_address text NOT NULL,token_address text NOT NULL,stage text NOT NULL DEFAULT 'history',
      cursor text,head_fingerprint text,history_complete boolean NOT NULL DEFAULT false,
      aggregate jsonb,aggregate_checked_at timestamptz,chart_from timestamptz,chart_to timestamptz,chart_cursor timestamptz,
      priority integer NOT NULL DEFAULT 0,requested_at timestamptz NOT NULL DEFAULT now(),
      next_attempt_at timestamptz NOT NULL DEFAULT now(),lease_id uuid,lease_until timestamptz,
      attempts integer NOT NULL DEFAULT 0,last_error text,completed_at timestamptz,
      pagination_cursors text[] NOT NULL DEFAULT '{}',chart_gaps boolean NOT NULL DEFAULT false,
      PRIMARY KEY(wallet_address,token_address)
    );
    ALTER TABLE node_import_jobs ADD COLUMN IF NOT EXISTS pagination_cursors text[] NOT NULL DEFAULT '{}';
    ALTER TABLE node_import_jobs ADD COLUMN IF NOT EXISTS chart_gaps boolean NOT NULL DEFAULT false;
    ALTER TABLE node_import_jobs ADD COLUMN IF NOT EXISTS aggregate_orders text[] NOT NULL DEFAULT '{}';
    CREATE TABLE IF NOT EXISTS node_import_pages (
      wallet_address text NOT NULL,token_address text NOT NULL,cursor_key text NOT NULL,
      next_cursor text,payload jsonb NOT NULL,payload_hash text NOT NULL,observed_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY(wallet_address,token_address,cursor_key)
    );
    CREATE TABLE IF NOT EXISTS node_import_movements (
      wallet_address text NOT NULL,token_address text NOT NULL,id text NOT NULL,event jsonb NOT NULL,
      raw jsonb NOT NULL,payload_hash text NOT NULL,observed_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY(wallet_address,token_address,id)
    );
    CREATE TABLE IF NOT EXISTS node_import_page_versions (
      wallet_address text NOT NULL,token_address text NOT NULL,cursor_key text NOT NULL,
      payload_hash text NOT NULL,payload jsonb NOT NULL,observed_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY(wallet_address,token_address,cursor_key,payload_hash)
    );
    CREATE TABLE IF NOT EXISTS node_import_chart_pages (
      token_address text NOT NULL,resolution integer NOT NULL,from_at timestamptz NOT NULL,to_at timestamptz NOT NULL,
      payload_hash text NOT NULL,payload jsonb NOT NULL,observed_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY(token_address,resolution,from_at,to_at,payload_hash)
    );
    CREATE TABLE IF NOT EXISTS node_import_chart_jobs (
      token_address text NOT NULL,resolution integer NOT NULL,from_at timestamptz NOT NULL,to_at timestamptz NOT NULL,
      cursor_at timestamptz NOT NULL,selected_at timestamptz NOT NULL DEFAULT now(),expires_at timestamptz NOT NULL,
      next_attempt_at timestamptz NOT NULL DEFAULT now(),attempts integer NOT NULL DEFAULT 0,last_error text,
      lease_id uuid,lease_until timestamptz,completed_at timestamptz,
      PRIMARY KEY(token_address,resolution,from_at,to_at),CHECK(to_at>from_at)
    );
    CREATE INDEX IF NOT EXISTS node_import_chart_pending ON node_import_chart_jobs(next_attempt_at,selected_at DESC)
      WHERE completed_at IS NULL;
    CREATE TABLE IF NOT EXISTS node_legacy_chart_imports (
      content_hash text PRIMARY KEY,source_path text NOT NULL,token_address text NOT NULL,resolution integer NOT NULL,
      provider text NOT NULL,observed_at timestamptz NOT NULL,bar_count integer NOT NULL,
      completed_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS node_import_wallet_jobs (
      wallet_address text PRIMARY KEY,stage text NOT NULL DEFAULT 'history',cursor text,
      pagination_cursors text[] NOT NULL DEFAULT '{}',requested_at timestamptz NOT NULL DEFAULT now(),
      next_attempt_at timestamptz NOT NULL DEFAULT now(),lease_id uuid,lease_until timestamptz,
      attempts integer NOT NULL DEFAULT 0,last_error text,completed_at timestamptz
    );
    ALTER TABLE node_import_wallet_jobs ADD COLUMN IF NOT EXISTS head_fingerprint text;
    ALTER TABLE node_import_wallet_jobs ADD COLUMN IF NOT EXISTS head_verified_at timestamptz;
    ALTER TABLE node_import_wallet_jobs ADD COLUMN IF NOT EXISTS head_verified_fingerprint text;
    CREATE TABLE IF NOT EXISTS node_import_wallet_pages (
      wallet_address text NOT NULL,cursor_key text NOT NULL,payload_hash text NOT NULL,
      next_cursor text,payload jsonb NOT NULL,observed_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY(wallet_address,cursor_key,payload_hash)
    );
    CREATE TABLE IF NOT EXISTS node_import_wallet_head_checks (
      wallet_address text NOT NULL,payload_hash text NOT NULL,payload jsonb NOT NULL,
      cutoff_at timestamptz NOT NULL,checked_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(wallet_address,payload_hash)
    );
    CREATE TABLE IF NOT EXISTS node_import_aggregates (
      wallet_address text NOT NULL,token_address text NOT NULL,payload_hash text NOT NULL,payload jsonb NOT NULL,
      observed_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(wallet_address,token_address,payload_hash)
    );
  `);
}
