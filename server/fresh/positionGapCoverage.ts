import{freshAuthenticatedTokenBirthBlockSql}from'./positionDependencies.js';
import{freshTrustedPositionGapEpochSql}from'./positionGapJournal.js';

/** Expiry commits the wallet marker and its compact receipt reference in the
 * same transaction. Read the complete retained expiry journal, not just its
 * earliest marker. Malformed references or a missing earliest reference cannot
 * establish an upper bound. No original receipt, financial fact or gap is
 * removed/approved by this current-position gate. */
const expiredGapBounds=`(WITH refs AS(
 SELECT member.wallet,n.block_number,COALESCE(
  j.id='decode:'||j.reference AND j.reference=(j.progress->'expiredEvidence'->>'transactionHash')||':'||(j.progress->'expiredEvidence'->>'blockHash')
  AND j.progress->'expiredEvidence'->'version'='1'::jsonb
  AND j.progress->'expiredEvidence'->>'kind'='expired_receipt_reference_v1'
  AND j.progress->'expiredEvidence'->>'transactionHash'~'^0x[0-9a-f]{64}$'
  AND j.progress->'expiredEvidence'->>'blockHash'~'^0x[0-9a-f]{64}$'
  AND j.progress->'expiredEvidence'->>'payloadSha256'~'^[0-9a-f]{64}$'
  AND jsonb_typeof(j.progress->'expiredEvidence'->'blockNumber')='number' AND n.block_number IS NOT NULL
  AND jsonb_typeof(j.progress->'expiredEvidence'->'transactionIndex')='number'
  AND j.progress->'expiredEvidence'->>'transactionIndex'~'^(0|[1-9][0-9]{0,8})$'
  AND j.progress->'expiredEvidence'->>'expiresAt'~'^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$'
  AND j.progress->'expiredEvidence'->>'expiredAt'~'^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$'
  AND j.progress->'expiredEvidence'->>'expiresAt'<=j.progress->'expiredEvidence'->>'expiredAt'
  AND member.wallet~'^0x[0-9a-f]{40}$',false) AS valid
 FROM fresh.jobs j
 CROSS JOIN LATERAL(SELECT CASE WHEN j.progress->'expiredEvidence'->>'blockNumber'~'^[1-9][0-9]{0,14}$'
  THEN(j.progress->'expiredEvidence'->>'blockNumber')::bigint END AS block_number)n
 CROSS JOIN LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof(j.progress->'expiredEvidence'->'walletAddresses')='array'
  THEN j.progress->'expiredEvidence'->'walletAddresses' ELSE '[]'::jsonb END)member(wallet)
 WHERE j.kind='decode_receipt' AND j.progress ? 'expiredEvidence')
 SELECT jsonb_object_agg(b.wallet,b.bounds)FROM(SELECT wallet,jsonb_build_object('first',min(block_number),
  'blocks',jsonb_agg(DISTINCT block_number)FILTER(WHERE block_number IS NOT NULL),
  'badThrough',max(CASE WHEN valid THEN NULL ELSE COALESCE(block_number,9007199254740991) END))AS bounds FROM refs GROUP BY wallet)b)`;

/** A wallet gap stays blocking unless ALL its recorded missing receipts ended
 * before this token actually existed. A pool/launch timestamp is insufficient.
 * Same-block gaps, unknown birth, unbounded/registration gaps, contradictory
 * earlier token facts and incomplete expiry journals remain blocking. Current
 * receipt decoding and exact canonical balance checks are still mandatory. */
export function freshPositionWalletGapSql(block:string,token='p.token_address'){
 if(!/^\$[1-9][0-9]*$|^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$|^\(SELECT block_number FROM fresh\.checkpoints WHERE key='capture'\)$/i.test(block))throw Error('position_gap_block_invalid');
 const birth=freshAuthenticatedTokenBirthBlockSql(token,{durableCertificate:true});
 return`EXISTS(SELECT 1 FROM fresh.wallets w WHERE w.address=ANY(s.wallet_addresses) AND w.decode_gap_from_block<=${block}
  AND NOT COALESCE(w.decode_gap_reason='expired_undecoded_evidence' AND EXISTS(
   SELECT 1 FROM(SELECT ${expiredGapBounds}->w.address AS bounds) gap_bound
   CROSS JOIN LATERAL(SELECT min(candidate.last_block) AS last_block FROM(
    SELECT max(b.number::bigint) AS last_block FROM jsonb_array_elements_text(COALESCE(NULLIF(gap_bound.bounds->'blocks','null'::jsonb),'[]'::jsonb))b(number)
     WHERE b.number::bigint<=${block}
     HAVING (gap_bound.bounds->>'first')::bigint=w.decode_gap_from_block AND gap_bound.bounds->>'badThrough' IS NULL
    UNION ALL
    SELECT greatest(epoch.block_number,COALESCE((SELECT max(b.number::bigint)
     FROM jsonb_array_elements_text(COALESCE(NULLIF(gap_bound.bounds->'blocks','null'::jsonb),'[]'::jsonb))b(number)
     WHERE b.number::bigint>epoch.block_number AND b.number::bigint<=${block}),epoch.block_number))
    FROM fresh.checkpoints epoch JOIN fresh.checkpoints epoch_start ON epoch_start.key='start'
    JOIN fresh.checkpoints epoch_capture ON epoch_capture.key='capture' JOIN fresh.checkpoints epoch_health ON epoch_health.key='health:maintenance'
    WHERE ${freshTrustedPositionGapEpochSql} AND epoch.block_number<=${block}
     AND COALESCE((gap_bound.bounds->>'badThrough')::bigint,0)<=epoch.block_number
   )candidate)cutoff
   WHERE cutoff.last_block<${birth}
    AND NOT EXISTS(SELECT 1 FROM fresh.financial_events contradiction WHERE contradiction.canonical
     AND contradiction.wallet_address=w.address AND contradiction.token_address=${token}
     AND contradiction.block_number<=cutoff.last_block)),false))`;
}
