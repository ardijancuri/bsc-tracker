import type { Pool } from 'pg';

export async function ensureIntelligenceSchema(pool: Pool) {
  const client = await pool.connect();
  try {
  await client.query('BEGIN');
  await client.query('SELECT pg_advisory_xact_lock(782320)');
  await client.query(`
    ALTER TABLE trades ADD COLUMN IF NOT EXISTS observed_live boolean NOT NULL DEFAULT false;
    ALTER TABLE trades ADD COLUMN IF NOT EXISTS intelligence_processed boolean NOT NULL DEFAULT false;
    CREATE INDEX IF NOT EXISTS trades_intelligence_pending_idx ON trades(block_number,transaction_index,id) WHERE NOT intelligence_processed AND block_number IS NOT NULL;
    CREATE TABLE IF NOT EXISTS watch_sessions (
      id text PRIMARY KEY, secret_hash text UNIQUE NOT NULL, expires_at timestamptz NOT NULL,
      preferences jsonb NOT NULL DEFAULT '{"windowMinutes":10,"minBuyers":3,"categories":["clustered_buys","repeat_buy","buyer_selling","near_graduation","graduated"],"muted":false}',
      telegram_chat_id text, telegram_username text, telegram_connected_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS watch_sessions_chat_idx ON watch_sessions(telegram_chat_id) WHERE telegram_chat_id IS NOT NULL;
    CREATE TABLE IF NOT EXISTS watch_entries (
      session_id text NOT NULL REFERENCES watch_sessions(id) ON DELETE CASCADE,
      kind text NOT NULL CHECK(kind IN ('kol','token')), address text NOT NULL,
      PRIMARY KEY(session_id,kind,address)
    );
    CREATE INDEX IF NOT EXISTS watch_entries_entity_idx ON watch_entries(kind,address);
    CREATE TABLE IF NOT EXISTS telegram_links (
      id text PRIMARY KEY, session_id text NOT NULL REFERENCES watch_sessions(id) ON DELETE CASCADE,
      nonce_hash text UNIQUE NOT NULL, expires_at timestamptz NOT NULL,
      chat_id text, username text, claimed_at timestamptz, confirmed_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS telegram_updates (update_id bigint PRIMARY KEY, received_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS radar_signals (
      id text PRIMARY KEY, kind text NOT NULL, entity text NOT NULL, token_address text NOT NULL REFERENCES tokens(address),
      wallet_addresses text[] NOT NULL, evidence jsonb NOT NULL, window_minutes integer NOT NULL, min_buyers integer NOT NULL,
      timestamp timestamptz NOT NULL, published_at timestamptz NOT NULL DEFAULT now(),
      source_block bigint NOT NULL, source_hash text NOT NULL,
      live boolean NOT NULL DEFAULT false, corrected boolean NOT NULL DEFAULT false
    );
    CREATE INDEX IF NOT EXISTS radar_signals_recent_idx ON radar_signals(timestamp DESC,id DESC);
    CREATE INDEX IF NOT EXISTS radar_signals_cooldown_idx ON radar_signals(entity,kind,window_minutes,min_buyers,timestamp DESC);
    CREATE TABLE IF NOT EXISTS radar_profiles (
      profile text PRIMARY KEY, window_minutes integer NOT NULL, min_buyers integer NOT NULL, backfilled_at timestamptz
    );
    INSERT INTO radar_profiles(profile,window_minutes,min_buyers) VALUES('10:3',10,3) ON CONFLICT(profile) DO NOTHING;
    CREATE TABLE IF NOT EXISTS notification_deliveries (
      session_id text NOT NULL REFERENCES watch_sessions(id) ON DELETE CASCADE,
      signal_id text NOT NULL REFERENCES radar_signals(id),
      status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','sending','sent','cancelled','failed','uncertain')),
      attempts integer NOT NULL DEFAULT 0, available_at timestamptz NOT NULL DEFAULT now(),
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
      message_id text, last_error text, PRIMARY KEY(session_id,signal_id)
    );
    CREATE INDEX IF NOT EXISTS notification_deliveries_pending_idx ON notification_deliveries(available_at) WHERE status='queued';
    CREATE TABLE IF NOT EXISTS wallet_transfers (
      id text PRIMARY KEY, tx_hash text NOT NULL, log_index integer NOT NULL,
      wallet_address text NOT NULL REFERENCES kols(address), token_address text NOT NULL REFERENCES tokens(address),
      delta_raw numeric NOT NULL, kind text NOT NULL CHECK(kind IN ('buy','sell','transfer')),
      block_number bigint NOT NULL, block_hash text NOT NULL, timestamp timestamptz NOT NULL
    );
    CREATE INDEX IF NOT EXISTS wallet_transfers_position_idx ON wallet_transfers(wallet_address,token_address,block_number);
    CREATE TABLE IF NOT EXISTS position_snapshots (
      wallet_address text NOT NULL REFERENCES kols(address), token_address text NOT NULL REFERENCES tokens(address),
      block_number bigint NOT NULL, block_hash text NOT NULL, balance_raw numeric,
      status text NOT NULL DEFAULT 'Unknown', checked_at timestamptz NOT NULL DEFAULT now(),
      last_movement_at timestamptz, error boolean NOT NULL DEFAULT false,
      PRIMARY KEY(wallet_address,token_address,block_number)
    );
    CREATE INDEX IF NOT EXISTS position_snapshots_latest_idx ON position_snapshots(wallet_address,token_address,block_number DESC);
    ALTER TABLE position_snapshots ADD COLUMN IF NOT EXISTS block_timestamp timestamptz;
    CREATE TABLE IF NOT EXISTS token_launches (
      token_address text PRIMARY KEY REFERENCES tokens(address), platform text, stage text NOT NULL DEFAULT 'unavailable',
      progress numeric, launched_at timestamptz, first_kol_at timestamptz,
      graduated_at timestamptz, graduation_tx_hash text, quote_address text,
      pool_address text, pool_id text, migrator_type integer,
      block_number bigint, block_hash text, checked_at timestamptz,
      liquidity_usd numeric, liquidity_baseline_usd numeric, liquidity_baseline_at timestamptz, liquidity_at timestamptz
    );
    CREATE TABLE IF NOT EXISTS launch_events (
      id text PRIMARY KEY, token_address text NOT NULL REFERENCES tokens(address), platform text NOT NULL,
      kind text NOT NULL, block_number bigint NOT NULL, block_hash text NOT NULL,
      tx_hash text NOT NULL, timestamp timestamptz NOT NULL, details jsonb NOT NULL DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS launch_events_token_idx ON launch_events(token_address,kind,block_number);
    CREATE TABLE IF NOT EXISTS launch_observations (
      token_address text NOT NULL REFERENCES tokens(address),block_number bigint NOT NULL,block_hash text NOT NULL,
      platform text,stage text NOT NULL,progress numeric,observed_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY(token_address,block_number)
    );
    CREATE TABLE IF NOT EXISTS liquidity_observations (
      token_address text NOT NULL REFERENCES tokens(address), observed_at timestamptz NOT NULL DEFAULT now(),
      liquidity_usd numeric NOT NULL, pool_identifier text NOT NULL, PRIMARY KEY(token_address,observed_at)
    );
    ALTER TABLE liquidity_observations ADD COLUMN IF NOT EXISTS block_number bigint;
    ALTER TABLE liquidity_observations ADD COLUMN IF NOT EXISTS block_hash text;
  `);
  await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
