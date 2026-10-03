import pg from 'pg';

const { Pool } = pg;
export const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 12 });

export async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS kols (
      address text PRIMARY KEY,
      display_name text,
      avatar_url text,
      twitter text,
      source text NOT NULL DEFAULT 'gmgn',
      first_seen_at timestamptz NOT NULL DEFAULT now(),
      last_seen_at timestamptz,
      profile_checked_at timestamptz,
      avatar_checked_at timestamptz
    );
    ALTER TABLE kols ADD COLUMN IF NOT EXISTS is_tracked boolean NOT NULL DEFAULT false;
    CREATE INDEX IF NOT EXISTS kols_tracked_idx ON kols (is_tracked, address);
    CREATE TABLE IF NOT EXISTS tokens (
      address text PRIMARY KEY,
      symbol text,
      name text,
      logo_url text,
      decimals integer,
      price_usd numeric,
      market_cap_usd numeric,
      change_24h numeric,
      metadata_updated_at timestamptz
    );
    ALTER TABLE tokens ADD COLUMN IF NOT EXISTS logo_checked_at timestamptz;
    ALTER TABLE tokens ADD COLUMN IF NOT EXISTS logo_data bytea;
    ALTER TABLE tokens ADD COLUMN IF NOT EXISTS logo_mime text;
    ALTER TABLE tokens ADD COLUMN IF NOT EXISTS logo_cache_checked_at timestamptz;
    ALTER TABLE tokens ADD COLUMN IF NOT EXISTS price_source text;
    ALTER TABLE tokens ADD COLUMN IF NOT EXISTS total_supply_raw numeric;
    ALTER TABLE tokens ADD COLUMN IF NOT EXISTS supply_checked_at timestamptz;
    ALTER TABLE tokens ADD COLUMN IF NOT EXISTS market_cap_checked_at timestamptz;
    ALTER TABLE tokens ADD COLUMN IF NOT EXISTS is_meme boolean;
    CREATE TABLE IF NOT EXISTS trades (
      id text PRIMARY KEY,
      tx_hash text NOT NULL,
      wallet_address text NOT NULL REFERENCES kols(address),
      token_address text NOT NULL REFERENCES tokens(address),
      side text NOT NULL CHECK (side IN ('buy','sell','swap','unknown')),
      token_amount numeric,
      quote_token_address text,
      quote_symbol text,
      quote_amount numeric,
      amount_usd numeric,
      price_usd numeric,
      block_number bigint,
      block_hash text,
      timestamp timestamptz NOT NULL,
      source text NOT NULL CHECK (source IN ('node','gmgn','node+gmgn')),
      verification_attempted_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (tx_hash, wallet_address, token_address)
    );
    ALTER TABLE trades ADD COLUMN IF NOT EXISTS value_checked_at timestamptz;
    ALTER TABLE trades ADD COLUMN IF NOT EXISTS transaction_index integer;
    CREATE INDEX IF NOT EXISTS trades_recent_idx ON trades (timestamp DESC, id DESC);
    ALTER TABLE kols ADD COLUMN IF NOT EXISTS profile_checked_at timestamptz;
    ALTER TABLE kols ADD COLUMN IF NOT EXISTS avatar_checked_at timestamptz;
    CREATE INDEX IF NOT EXISTS trades_wallet_idx ON trades (wallet_address, timestamp DESC);
    CREATE INDEX IF NOT EXISTS trades_token_idx ON trades (token_address, timestamp DESC);
    CREATE INDEX IF NOT EXISTS trades_block_idx ON trades (block_number);
    ALTER TABLE trades ADD COLUMN IF NOT EXISTS verification_attempted_at timestamptz;
    CREATE INDEX IF NOT EXISTS trades_verification_idx ON trades (timestamp DESC) WHERE source='gmgn' AND verification_attempted_at IS NULL;
    CREATE TABLE IF NOT EXISTS leaderboard_snapshots (
      wallet_address text NOT NULL REFERENCES kols(address),
      period text NOT NULL CHECK (period IN ('1d','7d','30d')),
      realized_profit_usd numeric,
      unrealized_profit_usd numeric,
      buy_count integer,
      sell_count integer,
      win_rate numeric,
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (wallet_address, period)
    );
    CREATE TABLE IF NOT EXISTS processed_blocks (
      block_number bigint PRIMARY KEY,
      block_hash text NOT NULL,
      processed_at timestamptz NOT NULL DEFAULT now()
    );
    ALTER TABLE leaderboard_snapshots DROP CONSTRAINT IF EXISTS leaderboard_snapshots_period_check;
    ALTER TABLE leaderboard_snapshots ADD CONSTRAINT leaderboard_snapshots_period_check CHECK (period IN ('1d','7d','30d','today'));
    ALTER TABLE leaderboard_snapshots ADD COLUMN IF NOT EXISTS window_start timestamptz;
    ALTER TABLE leaderboard_snapshots ADD COLUMN IF NOT EXISTS valued_sell_count integer;
    ALTER TABLE leaderboard_snapshots ADD COLUMN IF NOT EXISTS excluded_sell_count integer;
    CREATE TABLE IF NOT EXISTS worker_state (
      key text PRIMARY KEY,
      value jsonb NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS backfill_jobs (
      wallet_address text PRIMARY KEY REFERENCES kols(address),
      cursor text,
      done boolean NOT NULL DEFAULT false,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
  `);
}

export async function setState(key: string, value: unknown) {
  await pool.query(`INSERT INTO worker_state (key,value,updated_at) VALUES ($1,$2::jsonb,now())
    ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()`, [key, JSON.stringify(value)]);
}

export async function notifyUpdate() {
  await pool.query(`SELECT pg_notify('bscan_update', 'update')`);
}
