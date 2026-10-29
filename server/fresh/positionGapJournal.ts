import type{Pool}from'pg';
export const FRESH_POSITION_GAP_EPOCH='coverage:position_gap_journal';
/** A single current coverage marker, never a financial snapshot. At activation
 * every preexisting captured gap is at or below this committed checkpoint.
 * The upgraded expiry writer retains all later compact receipt references. */
export async function ensureFreshPositionGapEpoch(db:Pick<Pool,'query'>){
 await db.query(`INSERT INTO fresh.checkpoints(key,block_number,block_hash,value)
  SELECT '${FRESH_POSITION_GAP_EPOCH}',c.block_number,c.block_hash,jsonb_build_object('version',1,'kind','position_gap_journal_epoch_v1',
   'start',jsonb_build_object('number',s.block_number,'hash',s.block_hash),'activatedAt',to_char(clock_timestamp()AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
  FROM fresh.checkpoints c JOIN fresh.checkpoints s ON s.key='start' WHERE c.key='capture' AND c.block_number>=s.block_number
   AND c.value->>'startBlock'=s.block_number::text AND c.value->>'startHash'=s.block_hash
  ON CONFLICT(key)DO UPDATE SET block_number=EXCLUDED.block_number,block_hash=EXCLUDED.block_hash,value=EXCLUDED.value,
   revision=fresh.checkpoints.revision+1,updated_at=clock_timestamp()
  WHERE fresh.checkpoints.value ? 'invalidatedAt' OR fresh.checkpoints.value->>'kind' IS DISTINCT FROM 'position_gap_journal_epoch_v1'
   OR fresh.checkpoints.value->'version' IS DISTINCT FROM '1'::jsonb
   OR fresh.checkpoints.value->'start' IS DISTINCT FROM EXCLUDED.value->'start'
   OR NOT COALESCE((SELECT value->'result'->'positionGapJournalVersion'='1'::jsonb FROM fresh.checkpoints WHERE key='health:maintenance'),false)`);
}
export async function invalidateFreshPositionGapEpoch(db:Pick<Pool,'query'>,ancestor:number){
 await db.query(`UPDATE fresh.checkpoints SET value=value||jsonb_build_object('invalidatedAt',clock_timestamp(),'invalidationReason','reorg'),
  revision=revision+1,updated_at=clock_timestamp() WHERE key='${FRESH_POSITION_GAP_EPOCH}' AND block_number>$1 AND NOT(value ? 'invalidatedAt')`,[ancestor]);
}
export const freshTrustedPositionGapEpochSql=`epoch.key='${FRESH_POSITION_GAP_EPOCH}' AND epoch.value->'version'='1'::jsonb
 AND epoch.value->>'kind'='position_gap_journal_epoch_v1' AND NOT(epoch.value ? 'invalidatedAt')
 AND epoch.block_hash~'^0x[0-9a-f]{64}$' AND epoch.value->'start'=jsonb_build_object('number',epoch_start.block_number,'hash',epoch_start.block_hash)
 AND epoch_capture.value->>'startBlock'=epoch_start.block_number::text AND epoch_capture.value->>'startHash'=epoch_start.block_hash
 AND epoch_capture.block_number>=epoch.block_number
 AND NOT EXISTS(SELECT 1 FROM fresh.recent_blocks epoch_header WHERE epoch_header.block_number=epoch.block_number AND epoch_header.block_hash<>epoch.block_hash)
 AND epoch_health.value->'ok'='true'::jsonb AND epoch_health.value->'result'->'positionGapJournalVersion'='1'::jsonb
 AND epoch_health.updated_at>clock_timestamp()-interval '120 seconds' AND epoch_health.updated_at<=clock_timestamp()`;
