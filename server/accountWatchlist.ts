import type { FastifyRequest } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { pool } from './db.js';
import { AuthMergeLimitError, resolveAuthUser } from './telegramAuth.js';
import { hashSecret, sessionSecret } from './watchSessionSecrets.js';

/** Account favorites outlive individual device sessions. Guest storage stays compatible. */
export async function ensureAccountWatchlistSchema(database: Pool) {
  const client = await database.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(782322)');
    await client.query(`CREATE TABLE IF NOT EXISTS account_watch_entries (
      user_id uuid NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
      kind text NOT NULL CHECK(kind IN ('kol','token')), address text NOT NULL,
      PRIMARY KEY(user_id,kind,address)
    );
    CREATE INDEX IF NOT EXISTS account_watch_entries_entity_idx ON account_watch_entries(kind,address);
    ALTER TABLE account_watch_entries ADD COLUMN IF NOT EXISTS added_at timestamptz NOT NULL DEFAULT now();
    CREATE OR REPLACE VIEW active_watch_entries AS
      SELECT w.kind,w.address FROM watch_entries w JOIN watch_sessions s ON s.id=w.session_id WHERE s.expires_at>now()
      UNION SELECT kind,address FROM account_watch_entries;`);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

export async function captureGuestWatchlist(request: FastifyRequest) {
  if (await resolveAuthUser(request)) return null;
  const secret = sessionSecret(request.headers.cookie);
  if (!secret) return null;
  const secretHash = hashSecret(secret);
  const found = await pool.query('SELECT id FROM watch_sessions WHERE secret_hash=$1 AND expires_at>now()', [secretHash]);
  return found.rows[0] ? { sessionId: found.rows[0].id, secretHash } : null;
}

export async function mergeGuestWatchlist(client: PoolClient, userId: string, snapshot: unknown) {
  if (!snapshot || typeof snapshot !== 'object' || !('sessionId' in snapshot) || !('secretHash' in snapshot)
    || typeof snapshot.sessionId !== 'string' || typeof snapshot.secretHash !== 'string') return;
  // The callback already locks this account. Re-locking also makes this hook safe independently.
  await client.query('SELECT id FROM auth_users WHERE id=$1 FOR UPDATE', [userId]);
  const guest = await client.query(`SELECT id FROM watch_sessions
    WHERE id=$1 AND secret_hash=$2 AND expires_at>now() FOR UPDATE`, [snapshot.sessionId, snapshot.secretHash]);
  if (!guest.rows[0]) return;
  const counts = await client.query(`SELECT kind,COUNT(*)::int AS count FROM (
    SELECT kind,address FROM account_watch_entries WHERE user_id=$1
    UNION SELECT kind,address FROM watch_entries WHERE session_id=$2
  ) favorites GROUP BY kind`, [userId, snapshot.sessionId]);
  if (counts.rows.some(row => row.count > 100)) throw new AuthMergeLimitError();
  await client.query(`INSERT INTO account_watch_entries(user_id,kind,address)
    SELECT $1,kind,address FROM watch_entries WHERE session_id=$2 ON CONFLICT DO NOTHING`, [userId, snapshot.sessionId]);
  await client.query('DELETE FROM watch_sessions WHERE id=$1', [snapshot.sessionId]);
}
