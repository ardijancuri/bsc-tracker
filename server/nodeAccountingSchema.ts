import type { Pool } from 'pg';
import type { PoolClient } from 'pg';

/** A financial correction makes the previous period total ineligible too.
 * Legacy scalar fields remain gated behind the absent versioned contract. */
export async function invalidateNodeLeaderboardForWallets(db: Pick<PoolClient, 'query'>, wallets: string[]) {
  const selected=[...new Set(wallets)].filter(wallet=>/^0x[0-9a-f]{40}$/.test(wallet));
  if(selected.length)await db.query(`UPDATE leaderboard_snapshots SET node_accounting=NULL
    WHERE period='1d' AND wallet_address=ANY($1::text[]) AND node_accounting IS NOT NULL`,[selected]);
}

export async function rollbackNodeAccounting(db: Pick<PoolClient, 'query'>, fromBlock: bigint | string | number) {
  const from = String(fromBlock);
  await db.query('UPDATE node_accounting_baselines SET invalidated_at=now() WHERE checkpoint_block>=$1', [from]);
  await db.query('DELETE FROM node_accounting_balances WHERE block_number>=$1', [from]);
  await db.query('UPDATE node_accounting_history SET invalidated_at=now() WHERE to_block>=$1', [from]);
  // Saved snapshots share the orphaned valuation and must never remain valid.
  await db.query('UPDATE node_accounting_snapshots SET invalidated_at=now(),last_valid=NULL WHERE valuation_block>=$1 OR (scope_key,wallet_address,token_address) IN(SELECT scope_key,wallet_address,token_address FROM node_accounting_history WHERE invalidated_at IS NOT NULL)', [from]);
  await db.query('UPDATE node_accounting_snapshot_versions SET invalidated_at=now() WHERE valuation_block>=$1 OR covered_through_block>=$1', [from]);
  // A period rollup can include many position histories. It must be rebuilt
  // after any reorg instead of retaining an orphaned partial or complete total.
  await db.query("UPDATE leaderboard_snapshots SET node_accounting=NULL WHERE period='1d' AND node_accounting IS NOT NULL", []);
}

/** Explicit repair invalidation; ordinary new quotes do not erase historical
 * ledger work. Incorrect old valuation evidence cannot remain a saved result. */
export async function invalidateNodeAccountingForTokens(db: Pick<PoolClient, 'query'>, tokens: string[], reason: string) {
  const selected = [...new Set(tokens.map(token => token.toLowerCase()))].filter(token => /^0x[0-9a-f]{40}$/.test(token));
  if (!selected.length) return;
  const managed = !('release' in db && typeof db.release === 'function') && 'connect' in db && typeof db.connect === 'function';
  const client = managed ? await (db as Pool).connect() : null, writer = client ?? db;
  try {
  if (client) await writer.query('BEGIN');
  await writer.query('SELECT pg_advisory_xact_lock(782319)');
  await writer.query('UPDATE node_accounting_history SET invalidated_at=clock_timestamp() WHERE token_address=ANY($1::text[])', [selected]);
  await writer.query('UPDATE node_accounting_snapshots SET invalidated_at=clock_timestamp(),last_valid=NULL WHERE token_address=ANY($1::text[])', [selected]);
  await writer.query('UPDATE node_accounting_snapshot_versions SET invalidated_at=clock_timestamp() WHERE token_address=ANY($1::text[])', [selected]);
  await writer.query(`UPDATE leaderboard_snapshots s SET node_accounting=NULL WHERE s.period='1d' AND s.node_accounting IS NOT NULL
    AND EXISTS(SELECT 1 FROM node_accounting_history h WHERE h.scope_key='public' AND h.wallet_address=s.wallet_address
      AND h.token_address=ANY($1::text[]))`,[selected]);
  await writer.query(`UPDATE node_accounting_jobs SET next_attempt_at=now(),last_error=$2,lease_id=NULL,lease_until=NULL
    WHERE token_address=ANY($1::text[])`, [selected, reason.slice(0, 80)]);
  if (client) await writer.query('COMMIT');
  } catch (error) { if (client) await writer.query('ROLLBACK'); throw error; }
  finally { client?.release(); }
}

/** Additive migration: legacy records are preserved until replacement validation. */
export async function ensureNodeAccountingSchema(db: Pool) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(782341)');
    await client.query(`
      CREATE TABLE IF NOT EXISTS node_accounting_baselines (
        wallet_address text NOT NULL,token_address text NOT NULL,checkpoint_block bigint NOT NULL,
        checkpoint_hash text NOT NULL,checkpoint_timestamp timestamptz NOT NULL,balance numeric NOT NULL,
        history_fingerprint text NOT NULL,ledger jsonb NOT NULL,events jsonb NOT NULL DEFAULT '[]',
        verified_at timestamptz NOT NULL DEFAULT now(),invalidated_at timestamptz,schema_version integer NOT NULL DEFAULT 2,
        PRIMARY KEY(wallet_address,token_address)
      );
      ALTER TABLE node_accounting_baselines ADD COLUMN IF NOT EXISTS events jsonb NOT NULL DEFAULT '[]';
      ALTER TABLE node_accounting_baselines ADD COLUMN IF NOT EXISTS verified_at timestamptz;
      ALTER TABLE node_accounting_baselines ADD COLUMN IF NOT EXISTS invalidated_at timestamptz;
      ALTER TABLE node_accounting_baselines ADD COLUMN IF NOT EXISTS schema_version integer;
      CREATE INDEX IF NOT EXISTS node_accounting_baselines_checkpoint_idx ON node_accounting_baselines(checkpoint_block);
      CREATE TABLE IF NOT EXISTS node_accounting_balances (
        wallet_address text NOT NULL,token_address text NOT NULL,block_number bigint NOT NULL,block_hash text NOT NULL,
        block_timestamp timestamptz NOT NULL,balance numeric NOT NULL,checked_at timestamptz NOT NULL,
        schema_version integer NOT NULL DEFAULT 2,invalidated_at timestamptz,
        PRIMARY KEY(wallet_address,token_address)
      );
      ALTER TABLE node_accounting_balances ADD COLUMN IF NOT EXISTS schema_version integer;
      ALTER TABLE node_accounting_balances ADD COLUMN IF NOT EXISTS invalidated_at timestamptz;
      CREATE TABLE IF NOT EXISTS node_accounting_history (
        scope_key text NOT NULL,wallet_address text NOT NULL,token_address text NOT NULL,history_revision text NOT NULL,
        from_block bigint,to_block bigint,to_hash text,source text NOT NULL,payload jsonb NOT NULL,
        observed_at timestamptz NOT NULL DEFAULT now(),invalidated_at timestamptz,schema_version integer NOT NULL DEFAULT 2,
        PRIMARY KEY(scope_key,wallet_address,token_address)
      );
      ALTER TABLE node_accounting_history ADD COLUMN IF NOT EXISTS invalidated_at timestamptz;
      ALTER TABLE node_accounting_history ADD COLUMN IF NOT EXISTS schema_version integer;
      CREATE TABLE IF NOT EXISTS node_accounting_snapshots (
        scope_key text NOT NULL,wallet_address text NOT NULL,token_address text NOT NULL,snapshot_id text NOT NULL,
        history_revision text NOT NULL,valuation_block bigint,valuation_hash text,as_of timestamptz NOT NULL,
        complete boolean NOT NULL,payload jsonb NOT NULL,summary jsonb NOT NULL,last_valid jsonb,
        invalidated_at timestamptz,schema_version integer NOT NULL DEFAULT 2,PRIMARY KEY(scope_key,wallet_address,token_address)
      );
      ALTER TABLE node_accounting_snapshots ADD COLUMN IF NOT EXISTS valuation_block bigint;
      ALTER TABLE node_accounting_snapshots ADD COLUMN IF NOT EXISTS valuation_hash text;
      ALTER TABLE node_accounting_snapshots ADD COLUMN IF NOT EXISTS last_valid jsonb;
      ALTER TABLE node_accounting_snapshots ADD COLUMN IF NOT EXISTS invalidated_at timestamptz;
      ALTER TABLE node_accounting_snapshots ADD COLUMN IF NOT EXISTS schema_version integer;
      CREATE INDEX IF NOT EXISTS node_accounting_snapshots_block_idx ON node_accounting_snapshots(valuation_block);
      CREATE TABLE IF NOT EXISTS node_accounting_snapshot_versions (
        scope_key text NOT NULL,wallet_address text NOT NULL,token_address text NOT NULL,snapshot_id text NOT NULL,
        covered_through_block bigint,valuation_block bigint,valuation_hash text,payload jsonb NOT NULL,
        as_of timestamptz NOT NULL,expires_at timestamptz NOT NULL DEFAULT now()+interval '15 minutes',invalidated_at timestamptz,schema_version integer NOT NULL DEFAULT 2,
        PRIMARY KEY(scope_key,wallet_address,token_address,snapshot_id)
      );
      ALTER TABLE node_accounting_snapshot_versions ADD COLUMN IF NOT EXISTS invalidated_at timestamptz;
      ALTER TABLE node_accounting_snapshot_versions ADD COLUMN IF NOT EXISTS schema_version integer;
      CREATE INDEX IF NOT EXISTS node_accounting_snapshot_versions_expiry_idx ON node_accounting_snapshot_versions(expires_at);
      CREATE TABLE IF NOT EXISTS node_accounting_jobs (
        scope_key text NOT NULL,wallet_address text NOT NULL,token_address text NOT NULL,scope jsonb NOT NULL,
        priority integer NOT NULL DEFAULT 0,requested_at timestamptz NOT NULL DEFAULT now(),
        next_attempt_at timestamptz NOT NULL DEFAULT now(),lease_until timestamptz,lease_id uuid,
        attempts integer NOT NULL DEFAULT 0,last_error text,
        PRIMARY KEY(scope_key,wallet_address,token_address)
      );
      ALTER TABLE node_accounting_jobs ADD COLUMN IF NOT EXISTS priority integer NOT NULL DEFAULT 0;
      ALTER TABLE node_accounting_jobs ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz NOT NULL DEFAULT now();
      ALTER TABLE node_accounting_jobs ADD COLUMN IF NOT EXISTS lease_until timestamptz;
      ALTER TABLE node_accounting_jobs ADD COLUMN IF NOT EXISTS lease_id uuid;
      ALTER TABLE node_accounting_jobs ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0;
      ALTER TABLE node_accounting_jobs ADD COLUMN IF NOT EXISTS last_error text;
    `);
    // A same-name table left by an earlier experimental schema is evidence to
    // retain, never implicit verification. Quarantine its financial records and
    // rebuild through the current service. Separate accounting_* legacy tables
    // are deliberately untouched and are never copied into this namespace.
    for (const table of ['node_accounting_baselines', 'node_accounting_balances', 'node_accounting_history', 'node_accounting_snapshots', 'node_accounting_snapshot_versions']) {
      await client.query(`UPDATE ${table} SET invalidated_at=COALESCE(invalidated_at,now()) WHERE schema_version IS DISTINCT FROM 2`);
      await client.query(`ALTER TABLE ${table} ALTER COLUMN schema_version SET DEFAULT 2`);
    }
    await client.query('UPDATE node_accounting_snapshots SET last_valid=NULL WHERE invalidated_at IS NOT NULL');
    await client.query('ALTER TABLE node_accounting_baselines ALTER COLUMN verified_at SET DEFAULT now()');
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
