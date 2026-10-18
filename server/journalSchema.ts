import type { Pool } from 'pg';

export async function ensureJournalSchema(db: Pool) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(782329)');
    await client.query(`
      CREATE TABLE IF NOT EXISTS journal_wallets (
        user_id uuid NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
        wallet_address text NOT NULL REFERENCES kols(address), label varchar(60) NOT NULL DEFAULT '',
        added_at timestamptz NOT NULL DEFAULT now(), activity_from timestamptz NOT NULL DEFAULT now(),
        registration_block bigint, registration_hash text, revision uuid NOT NULL,
        PRIMARY KEY(user_id,wallet_address)
      );
      CREATE INDEX IF NOT EXISTS journal_wallets_wallet_idx ON journal_wallets(wallet_address);
      CREATE TABLE IF NOT EXISTS journal_wallet_coverage (
        wallet_address text PRIMARY KEY REFERENCES kols(address), registered_at timestamptz NOT NULL DEFAULT now(),
        registration_block bigint, registration_hash text, collected_from_block bigint, collected_through_block bigint,
        repair_from_block bigint, history_complete boolean NOT NULL DEFAULT false, last_error text,
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      ALTER TABLE journal_wallet_coverage ADD COLUMN IF NOT EXISTS generation uuid;
      CREATE TABLE IF NOT EXISTS journal_history_jobs (
        wallet_address text NOT NULL REFERENCES kols(address), scope text NOT NULL,
        cursor text, cursors jsonb NOT NULL DEFAULT '[]', complete boolean NOT NULL DEFAULT false,
        covered_to timestamptz, head_checked_at timestamptz, pages integer NOT NULL DEFAULT 0,
        status text NOT NULL DEFAULT 'pending', retry_at timestamptz, error text,
        lease_id uuid, lease_until timestamptz, updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY(wallet_address,scope)
      );
      ALTER TABLE journal_history_jobs ADD COLUMN IF NOT EXISTS refresh_cursor text;
      ALTER TABLE journal_history_jobs ADD COLUMN IF NOT EXISTS refresh_pending boolean NOT NULL DEFAULT false;
      CREATE TABLE IF NOT EXISTS journal_provider_movements (
        wallet_address text NOT NULL REFERENCES kols(address), token_address text NOT NULL REFERENCES tokens(address),
        event_key text NOT NULL, kind text NOT NULL CHECK(kind IN('buy','sell','transfer_in','transfer_out')),
        tx_hash text NOT NULL, timestamp timestamptz NOT NULL, token_amount numeric NOT NULL,
        amount_usd numeric, fee_usd numeric, quote_amount numeric, quote_symbol text,
        counterparty text, evidence_hash text NOT NULL, observed_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY(wallet_address,event_key)
      );
      CREATE INDEX IF NOT EXISTS journal_provider_pair_idx ON journal_provider_movements(wallet_address,token_address,timestamp);
      CREATE TABLE IF NOT EXISTS journal_pair_preparations (
        wallet_address text NOT NULL REFERENCES kols(address), token_address text NOT NULL REFERENCES tokens(address),
        history_revision text, balance_proof jsonb, quote jsonb, checked_at timestamptz, attempted_at timestamptz,
        status text NOT NULL DEFAULT 'pending', reason text,
        PRIMARY KEY(wallet_address,token_address)
      );
      ALTER TABLE journal_pair_preparations ADD COLUMN IF NOT EXISTS events jsonb;
      ALTER TABLE journal_pair_preparations ADD COLUMN IF NOT EXISTS source text;
      ALTER TABLE journal_pair_preparations ADD COLUMN IF NOT EXISTS coverage jsonb;
      ALTER TABLE journal_pair_preparations ADD COLUMN IF NOT EXISTS generation uuid;
      ALTER TABLE journal_pair_preparations ADD COLUMN IF NOT EXISTS canonical_revision text;
      ALTER TABLE journal_pair_preparations ADD COLUMN IF NOT EXISTS tracking_from timestamptz;
      ALTER TABLE journal_pair_preparations ADD COLUMN IF NOT EXISTS opening_balances jsonb;
      ALTER TABLE journal_pair_preparations ADD COLUMN IF NOT EXISTS membership_revision uuid;
      ALTER TABLE wallet_transfers ADD COLUMN IF NOT EXISTS counterparty_address text;
      CREATE TABLE IF NOT EXISTS journal_node_evidence (
        tx_hash text PRIMARY KEY,block_number bigint NOT NULL,block_hash text NOT NULL,timestamp timestamptz NOT NULL,
        transaction jsonb NOT NULL,receipt jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS journal_node_evidence_block_idx ON journal_node_evidence(block_number);
      ALTER TABLE journal_node_evidence ADD COLUMN IF NOT EXISTS bnb_price_usd numeric;
      ALTER TABLE journal_node_evidence ADD COLUMN IF NOT EXISTS bnb_priced_at timestamptz;
      CREATE TABLE IF NOT EXISTS journal_opening_balances (
        wallet_address text NOT NULL REFERENCES kols(address),token_address text NOT NULL REFERENCES tokens(address),
        block_number bigint NOT NULL,block_hash text NOT NULL,balance_raw numeric NOT NULL,decimals integer NOT NULL,
        checked_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(wallet_address,token_address,block_number)
      );
      CREATE TABLE IF NOT EXISTS journal_replay_snapshots (
        snapshot_id text PRIMARY KEY,user_id uuid NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
        wallet_address text NOT NULL,token_address text NOT NULL,membership_revision uuid NOT NULL,
        payload jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),expires_at timestamptz NOT NULL,
        FOREIGN KEY(user_id,wallet_address) REFERENCES journal_wallets(user_id,wallet_address) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS journal_replay_snapshots_expiry_idx ON journal_replay_snapshots(expires_at);
      CREATE TABLE IF NOT EXISTS journal_snapshots (
        user_id uuid NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE, wallet_set_hash text NOT NULL,
        snapshot_id text NOT NULL, membership_revision text NOT NULL, as_of timestamptz NOT NULL,
        payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY(user_id,wallet_set_hash)
      );
    `);
    // Preserve membership/evidence data while replacing the former seven-day
    // window. Rotate only changed memberships, invalidating their dated lifetime
    // summaries and replay leases without replaying historical acquisitions.
    await client.query(`ALTER TABLE journal_wallets ALTER COLUMN activity_from SET DEFAULT now();
      UPDATE journal_wallet_coverage SET repair_from_block=GREATEST(repair_from_block,registration_block+1) WHERE repair_from_block<registration_block+1;
      WITH changed AS (
        UPDATE journal_wallets SET activity_from=added_at,revision=md5(revision::text||':since-wallet-added')::uuid
          WHERE activity_from<>added_at RETURNING user_id
      ) DELETE FROM journal_snapshots WHERE user_id IN(SELECT user_id FROM changed);
      DELETE FROM journal_replay_snapshots s WHERE NOT EXISTS(SELECT 1 FROM journal_wallets m
        WHERE m.user_id=s.user_id AND m.wallet_address=s.wallet_address AND m.revision=s.membership_revision);`);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
