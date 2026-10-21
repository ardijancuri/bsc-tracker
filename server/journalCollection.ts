import type { PoolClient } from 'pg';
type Database = Pick<PoolClient, 'query'>;

/** The storage registry includes private wallets, while kols.is_tracked remains
 * the sole public-roster flag. Never promote journal subscriptions into it. */
export const monitoredWalletsSql = `SELECT address FROM kols WHERE is_tracked
  UNION SELECT DISTINCT wallet_address AS address FROM journal_wallets`;
export async function monitoredWallets(database: Database): Promise<Set<string>> {
  const result = await database.query(monitoredWalletsSql);
  return new Set(result.rows.map(row => String(row.address).toLowerCase()));
}

/** The API may register a wallet before the indexer's first checkpoint exists.
 * Bind that subscription to the first collected range rather than leaving it
 * permanently unable to prove any future coverage. */
export async function initializeJournalCollectionBoundary(database: Database, wallets: Set<string>, block: { number: number; hash: string }, generations?: Map<string, string>) {
  await database.query(`UPDATE journal_wallet_coverage c SET registration_block=$2::bigint,registration_hash=$3,
    repair_from_block=LEAST(c.repair_from_block,$2::bigint+1::bigint),updated_at=now()
    WHERE c.registration_block IS NULL AND c.wallet_address=ANY($1::text[])
      AND ($4::jsonb IS NULL OR c.generation::text=($4::jsonb->>c.wallet_address))
      AND EXISTS(SELECT 1 FROM journal_wallets m WHERE m.wallet_address=c.wallet_address)`, [[...wallets], block.number, block.hash, generations ? JSON.stringify(Object.fromEntries(generations)) : null]);
  await database.query(`UPDATE journal_wallets m SET registration_block=$2::bigint,registration_hash=$3
    WHERE m.registration_block IS NULL AND m.wallet_address=ANY($1::text[]) AND EXISTS(
      SELECT 1 FROM journal_wallet_coverage c WHERE c.wallet_address=m.wallet_address AND c.registration_block=$2::bigint AND c.registration_hash=$3
        AND ($4::jsonb IS NULL OR c.generation::text=($4::jsonb->>c.wallet_address)))`, [[...wallets], block.number, block.hash, generations ? JSON.stringify(Object.fromEntries(generations)) : null]);
}

/** Updating only the captured wallet set avoids declaring coverage for a
 * membership registered while eth_getLogs was already in flight. Its repair
 * cursor was recorded against the previous committed node checkpoint. */
export async function recordJournalCollectionRange(database: Database, wallets: Set<string>, from: number, to: number, repair = false, generations?: Map<string, string>) {
  await database.query(`UPDATE journal_wallet_coverage c SET
    collected_from_block=LEAST(COALESCE(c.collected_from_block,$2::bigint),$2::bigint),
    collected_through_block=GREATEST(COALESCE(c.collected_through_block,$3::bigint),$3::bigint),
    repair_from_block=CASE WHEN $4::boolean AND c.repair_from_block >= $2::bigint AND c.repair_from_block <= $3::bigint
      THEN CASE WHEN $3::bigint >= COALESCE((SELECT (value->>'blockNumber')::bigint FROM worker_state WHERE key='node'),$3::bigint) THEN NULL ELSE $3::bigint+1::bigint END
      ELSE c.repair_from_block END,
    last_error=NULL,updated_at=now()
    WHERE c.wallet_address=ANY($1::text[])
      AND ($5::jsonb IS NULL OR c.generation::text=($5::jsonb->>c.wallet_address))
      AND EXISTS(SELECT 1 FROM journal_wallets m WHERE m.wallet_address=c.wallet_address)`, [[...wallets], from, to, repair, generations ? JSON.stringify(Object.fromEntries(generations)) : null]);
}

export async function nextJournalCollectionRepair(database: Database, confirmedThrough: number): Promise<{ wallet: string; from: number; to: number } | null> {
  const result = await database.query(`SELECT c.wallet_address,c.repair_from_block FROM journal_wallet_coverage c
    WHERE c.repair_from_block IS NOT NULL AND c.repair_from_block <= $1::bigint
      AND EXISTS(SELECT 1 FROM journal_wallets m WHERE m.wallet_address=c.wallet_address)
    ORDER BY c.updated_at,c.wallet_address LIMIT 1`, [confirmedThrough]);
  const row = result.rows[0];
  if (!row) return null;
  const from = Number(row.repair_from_block);
  if (!Number.isSafeInteger(from) || from < 0) throw new Error('journal_collection_checkpoint_invalid');
  return { wallet: row.wallet_address, from, to: Math.min(confirmedThrough, from + 511) };
}

export async function rollbackJournalCollection(database: Database, from: number) {
  await database.query('DELETE FROM journal_node_evidence WHERE block_number >= $1::bigint', [from]);
  await database.query('DELETE FROM journal_opening_balances WHERE block_number >= $1::bigint', [from]);
  await database.query(`UPDATE journal_wallet_coverage SET
    collected_through_block=LEAST(collected_through_block,$1::bigint-1::bigint),
    registration_hash=CASE WHEN registration_block >= $1::bigint THEN (SELECT block_hash FROM processed_blocks WHERE block_number=$1::bigint-1::bigint) ELSE registration_hash END,
    registration_block=LEAST(registration_block,$1::bigint-1::bigint),
    repair_from_block=LEAST(COALESCE(repair_from_block,$1::bigint),$1::bigint),history_complete=false,
    last_error='chain_reorganization',updated_at=now()
    WHERE collected_through_block >= $1::bigint OR registration_block >= $1::bigint`, [from]);
  await database.query(`UPDATE journal_wallets SET registration_hash=CASE WHEN registration_block >= $1::bigint THEN (SELECT block_hash FROM processed_blocks WHERE block_number=$1::bigint-1::bigint) ELSE registration_hash END,
    registration_block=LEAST(registration_block,$1::bigint-1::bigint),revision=md5(revision::text||':reorg:'||($1::bigint)::text)::uuid WHERE registration_block >= $1::bigint`, [from]);
  await database.query('DELETE FROM journal_replay_snapshots');
  // Saved snapshots certify one canonical valuation; an orphaned proof cannot
  // remain available as a dated fallback after a reorganization.
  await database.query('DELETE FROM journal_snapshots');
}

type Transaction = { hash: string; blockNumber: string; blockHash?: string; transactionIndex: string | null };
type Receipt = { transactionHash?: string; blockNumber?: string; blockHash: string; status: string; logs: { blockHash?: string; blockNumber?: string; transactionHash?: string; removed?: boolean }[] };
export function validateCollectedReceipt(hash: string, tx: Transaction | null, receipt: Receipt | null, from: number, to: number) {
  if (!tx || !receipt) throw new Error('Missing transaction or receipt; collection range is incomplete');
  if (tx.hash.toLowerCase() !== hash.toLowerCase() || receipt.transactionHash != null && receipt.transactionHash.toLowerCase() !== hash.toLowerCase()) throw new Error('Transaction identity mismatch');
  const height = Number(BigInt(tx.blockNumber));
  if (!Number.isSafeInteger(height) || height < from || height > to || receipt.blockNumber != null && Number(BigInt(receipt.blockNumber)) !== height) throw new Error('Receipt block number mismatch');
  if (!/^0x[0-9a-f]{64}$/i.test(receipt.blockHash) || tx.blockHash != null && tx.blockHash.toLowerCase() !== receipt.blockHash.toLowerCase()) throw new Error('Receipt block hash mismatch');
  if (!['0x0', '0x1'].includes(receipt.status)) throw new Error('Invalid receipt execution status');
  for (const log of receipt.logs) if (log.removed || log.transactionHash != null && log.transactionHash.toLowerCase() !== hash.toLowerCase()
    || log.blockHash != null && log.blockHash.toLowerCase() !== receipt.blockHash.toLowerCase()
    || log.blockNumber != null && Number(BigInt(log.blockNumber)) !== height) throw new Error('Receipt log canonical evidence mismatch');
  return height;
}
