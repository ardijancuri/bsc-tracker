import type { Pool, PoolClient } from 'pg';

/** These are compatibility balance checks, not the permanent accounting ledger.
 * Keep a full day for ordinary rollback/debugging plus the latest observation
 * and successful classification anchors, even for long-closed positions. */
export const positionSnapshotRetentionHours = 24;
const stateKey = 'position_snapshot_retention';
const retentionLock = 782336;
type Cursor = { wallet: string; token: string };
export type PositionSnapshotRetentionResult = {
  prunedRows: number; visitedPairs: number; wrapped: boolean; skipped: boolean;
  cutoff: string | null; reason?: string;
  totalPrunedRows: number; totalVisitedPairs: number;
};
export type PositionSnapshotRetentionOptions = { maxPairs?: number; maxRows?: number; rowsPerPair?: number; budgetMs?: number };
const bounded = (value: number | undefined, fallback: number, maximum: number) =>
  Number.isFinite(value) ? Math.max(1, Math.min(maximum, Math.floor(value!))) : fallback;

/** Seek directly to the next distinct pair using the existing primary key.
 * DISTINCT/GROUP BY would visit millions of old observations on each pass. */
const nextPairSql = `SELECT wallet_address,token_address FROM position_snapshots
  WHERE (wallet_address,token_address)>($1::text,$2::text)
  ORDER BY wallet_address,token_address,block_number LIMIT 1`;

const prunePairSql = `WITH protected AS MATERIALIZED (
    (SELECT block_number FROM position_snapshots WHERE wallet_address=$1 AND token_address=$2
      ORDER BY block_number DESC LIMIT 1)
    UNION
    (SELECT block_number FROM position_snapshots WHERE wallet_address=$1 AND token_address=$2 AND NOT error
      ORDER BY block_number DESC LIMIT 2)
    UNION
    (SELECT block_number FROM position_snapshots WHERE wallet_address=$1 AND token_address=$2 AND NOT error
      AND block_timestamp<$3::timestamptz ORDER BY block_number DESC LIMIT 1)
  ), victims AS (
    SELECT s.ctid FROM position_snapshots s WHERE s.wallet_address=$1 AND s.token_address=$2
      AND s.block_number<$4::bigint AND s.block_timestamp<$3::timestamptz
      AND NOT EXISTS(SELECT 1 FROM protected p WHERE p.block_number=s.block_number)
    ORDER BY s.block_number LIMIT $5 FOR UPDATE OF s SKIP LOCKED
  ) DELETE FROM position_snapshots s USING victims v WHERE s.ctid=v.ctid RETURNING s.block_number`;

/** One small, resumable maintenance transaction. Never scans or deletes trade,
 * receipt, execution, transfer, chart or accounting evidence. Null-dated legacy
 * observations stay intact until their age can be established independently.
 * A shared rollback fence prevents pruning against an orphaned checkpoint. */
export async function prunePositionSnapshots(database: Pick<Pool, 'connect'>, options: PositionSnapshotRetentionOptions = {}): Promise<PositionSnapshotRetentionResult> {
  const result: PositionSnapshotRetentionResult = { prunedRows: 0, visitedPairs: 0, wrapped: false, skipped: false, cutoff: null,
    totalPrunedRows: 0, totalVisitedPairs: 0 };
  const maxPairs = bounded(options.maxPairs, 8, 32), maxRows = bounded(options.maxRows, 1000, 5000);
  const rowsPerPair = bounded(options.rowsPerPair, 250, 1000), budgetMs = bounded(options.budgetMs, 750, 2000);
  const started = performance.now(), client = await database.connect();
  let priorPrunedRows = 0, priorVisitedPairs = 0;
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL statement_timeout='2s'; SET LOCAL lock_timeout='250ms'");
    const locked = (await client.query('SELECT pg_try_advisory_xact_lock($1) AS locked', [retentionLock])).rows[0]?.locked;
    if (!locked) { await client.query('ROLLBACK'); return { ...result, skipped: true, reason: 'maintenance_busy' }; }
    await client.query('SELECT pg_advisory_xact_lock_shared(782319)');
    const checkpoint = (await client.query(`SELECT b.block_number::text,
      (b.timestamp-($1::integer*interval '1 hour')) AS cutoff,
      now()-b.timestamp<interval '5 minutes' AND b.timestamp<=now()+interval '30 seconds' AS fresh,
      COALESCE((SELECT (value->>'headBlock')::bigint-(value->>'blockNumber')::bigint>128
        FROM worker_state WHERE key='node_collection'),false) AS capture_lagging
      FROM worker_state s JOIN node_evidence_blocks b ON b.block_number=(s.value->>'blockNumber')::bigint
        AND lower(b.block_hash)=lower(s.value->>'blockHash') WHERE s.key='node'`, [positionSnapshotRetentionHours])).rows[0];
    if (!checkpoint?.fresh || checkpoint.capture_lagging) {
      await client.query('ROLLBACK');
      return { ...result, skipped: true, reason: checkpoint?.capture_lagging ? 'capture_priority' : 'confirmed_checkpoint_unavailable' };
    }
    result.cutoff = new Date(checkpoint.cutoff).toISOString();
    const saved = (await client.query('SELECT value FROM worker_state WHERE key=$1', [stateKey])).rows[0]?.value;
    result.totalPrunedRows = priorPrunedRows = safeCount(saved?.totalPrunedRows);
    result.totalVisitedPairs = priorVisitedPairs = safeCount(saved?.totalVisitedPairs);
    let cursor: Cursor = validCursor(saved?.cursor) ? saved.cursor : { wallet: '', token: '' };
    while (result.visitedPairs < maxPairs && result.prunedRows < maxRows) {
      const pair = (await client.query(nextPairSql, [cursor.wallet, cursor.token])).rows[0];
      if (!pair) { cursor = { wallet: '', token: '' }; result.wrapped = true; break; }
      const deleted = await client.query(prunePairSql, [pair.wallet_address, pair.token_address, result.cutoff,
        checkpoint.block_number, Math.min(rowsPerPair, maxRows - result.prunedRows)]);
      result.prunedRows += deleted.rowCount ?? 0;
      result.visitedPairs++;
      cursor = { wallet: pair.wallet_address, token: pair.token_address };
      if (performance.now() - started >= budgetMs) break;
    }
    result.totalPrunedRows += result.prunedRows;
    result.totalVisitedPairs += result.visitedPairs;
    await client.query(`INSERT INTO worker_state(key,value,updated_at) VALUES($1,$2::jsonb,now())
      ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()`, [stateKey, JSON.stringify({
      cursor, cutoff: result.cutoff, confirmedBlock: checkpoint.block_number, prunedRows: result.prunedRows,
      visitedPairs: result.visitedPairs, wrapped: result.wrapped, at: new Date().toISOString(),
      totalPrunedRows: result.totalPrunedRows, totalVisitedPairs: result.totalVisitedPairs,
      durationMs: Math.round(performance.now() - started), retainedHours: positionSnapshotRetentionHours,
    })]);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await rollback(client);
    // A reorg or busy table owns the database budget. Roll back every delete
    // and its cursor atomically; a later batch retries the same keyset range.
    if (['55P03', '57014'].includes(String((error as { code?: string })?.code))) return {
      ...result, prunedRows: 0, visitedPairs: 0, wrapped: false, skipped: true, reason: 'maintenance_budget',
      totalPrunedRows: priorPrunedRows, totalVisitedPairs: priorVisitedPairs,
    };
    throw error;
  }
  finally { client.release(); }
}

function validCursor(value: unknown): value is Cursor {
  if (!value || typeof value !== 'object') return false;
  const pair = value as Partial<Cursor>, address = /^0x[0-9a-f]{40}$/;
  return pair.wallet === '' && pair.token === '' || typeof pair.wallet === 'string' && address.test(pair.wallet)
    && typeof pair.token === 'string' && address.test(pair.token);
}
async function rollback(client: Pick<PoolClient, 'query'>) { try { await client.query('ROLLBACK'); } catch { /* Preserve the original maintenance error. */ } }
function safeCount(value: unknown) { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0; }
