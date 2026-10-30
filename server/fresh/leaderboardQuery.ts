/** Shared, narrow repair/header input. The lateral LIMIT keeps the canonical
 * header lookup indexed; MATERIALIZED prevents repeating it for every KOL.
 * Missing/orphan headers remain NULL and retain the original strict gate.
 * No raw payload, accounting value or public/private boundary is changed. */
export const freshLeaderboardPendingReceiptsSql=`board_pending_receipts AS MATERIALIZED(
 SELECT e.tx_hash,e.block_hash,e.block_number,e.wallet_addresses,e.decoder_status,e.last_error,
  e.position_dependency_addresses,e.position_dependency_proof,h.block_number AS canonical_block_number,h.occurred_at
 FROM fresh.recent_evidence e LEFT JOIN LATERAL(
  SELECT b.block_number,b.occurred_at FROM fresh.recent_blocks b
  WHERE b.block_number=e.block_number AND b.block_hash=e.block_hash LIMIT 1
 )h ON true WHERE e.decoder_status<>'done'
)`;
