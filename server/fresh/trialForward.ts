import type {Pool} from 'pg';
import {FRESH_DECODER_VERSION} from './decode.js';
import type {FreshTrialPosition,FreshForwardTrialScope} from './trialValidation.js';

/** This is a validation boundary only. It never replaces the financial start. */
export type FreshForwardSnapshotScope=FreshForwardTrialScope;
export interface FreshForwardTrialPosition extends FreshTrialPosition {
 scope_id:string;token_address:string;unknown_fee:boolean|null;unknown_purchase_value:boolean|null;
 unknown_sale_value:boolean|null;unknown_incoming_value:boolean|null;unknown_outgoing_value:boolean|null;
 application_ready:boolean;
}
const membership=`e.block_number>=s.starts_block AND e.occurred_at>=s.starts_at AND(
 s.account_id IS NULL OR EXISTS(SELECT 1 FROM public.journal_wallets j WHERE j.user_id::text=s.account_id
  AND j.wallet_address=e.wallet_address AND e.block_number>=coalesce(j.registration_block,s.starts_block)
  AND e.occurred_at>=j.activity_from))`;
// Include expected projections for all movements and eligible token-bound fees,
// not only results already present. Missing projection cannot omit a new book.
const affected=`WITH forward_events AS(SELECT e.* FROM fresh.financial_events e WHERE e.canonical
 AND e.token_address IS NOT NULL AND(e.kind<>'fee' OR e.fee_attribution->>'status'='eligible')
 AND e.block_number>$1 AND e.block_number<=$2), expected AS(
 SELECT s.id AS scope_id,e.token_address,e.id AS event_id,e.kind FROM forward_events e
 JOIN fresh.accounting_scopes s ON s.active AND e.wallet_address=ANY(s.wallet_addresses)
 WHERE ${membership}), affected AS(SELECT DISTINCT scope_id,token_address FROM expected)`;

/** One read-only repeatable-read snapshot covers the captured watermark,
 * future receipts, accounting projections and their old dependencies. Network
 * work and storage measurements belong outside this short transaction. */
export async function readFreshForwardTrialSnapshot(database:Pick<Pool,'connect'>,scope:FreshForwardSnapshotScope,now:number){
 if(scope.version!==1||scope.policy!=='forward_activity_v1'||!Number.isSafeInteger(scope.blockNumber)||scope.blockNumber<0
  ||!/^0x[\da-f]{64}$/.test(scope.blockHash)||!Number.isFinite(Date.parse(scope.occurredAt))||!Number.isFinite(Date.parse(scope.activatedAt))
  ||!/^\d+$/.test(String(scope.captureRevision))||!Number.isSafeInteger(now))throw Error('invalid_forward_trial_scope');
 const client=await database.connect();
 try{
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const checkpoints=(await client.query('SELECT key,block_number::text,block_hash,value,updated_at FROM fresh.checkpoints')).rows;
  const capture=checkpoints.find(row=>row.key==='capture'),height=Number(capture?.block_number);
  if(!Number.isSafeInteger(height)||height<scope.blockNumber)throw Error('forward_capture_before_boundary');
  const boundary=(await client.query('SELECT block_hash,occurred_at FROM fresh.recent_blocks WHERE block_number=$1',[scope.blockNumber])).rows[0];
  const boundaryCanonical=boundary?.block_hash===scope.blockHash&&new Date(boundary?.occurred_at).getTime()===Date.parse(scope.occurredAt);
  const counts=(await client.query(`SELECT
   (SELECT count(*) FROM fresh.financial_events WHERE canonical)::text AS financial_events,
   (SELECT count(*) FROM fresh.financial_events e JOIN fresh.kols k ON k.wallet_address=e.wallet_address AND k.is_tracked
    WHERE e.canonical AND e.observed_live AND e.block_number>$3 AND e.block_number<=$4 AND e.kind='buy'
     AND EXISTS(SELECT 1 FROM fresh.recent_blocks h WHERE h.block_number=e.block_number AND h.block_hash=e.block_hash))::text AS public_buys,
   (SELECT count(*) FROM fresh.financial_events e JOIN fresh.kols k ON k.wallet_address=e.wallet_address AND k.is_tracked
    WHERE e.canonical AND e.observed_live AND e.block_number>$3 AND e.block_number<=$4 AND e.kind='sell'
     AND EXISTS(SELECT 1 FROM fresh.recent_blocks h WHERE h.block_number=e.block_number AND h.block_hash=e.block_hash))::text AS public_sells,
   (SELECT count(DISTINCT token_address) FROM fresh.financial_events WHERE canonical AND kind IN('buy','sell') AND block_number>$3 AND block_number<=$4)::text AS tokens,
   (SELECT count(*) FROM fresh.positions)::text AS positions,
   (SELECT count(*) FROM fresh.recent_evidence WHERE block_number>$3 AND block_number<=$4)::text AS evidence,
   (SELECT count(*) FROM fresh.recent_evidence WHERE block_number>$3 AND block_number<=$4 AND decoder_status<>'done')::text AS pending_evidence,
   (SELECT min(block_number) FROM fresh.recent_evidence WHERE block_number>$3 AND block_number<=$4 AND decoder_status<>'done')::text AS first_pending_block,
   (SELECT extract(epoch FROM $1::timestamptz-min(created_at)) FROM fresh.recent_evidence WHERE block_number>$3 AND block_number<=$4 AND decoder_status<>'done')::text AS oldest_pending_age_seconds,
   (SELECT count(*) FROM fresh.recent_evidence WHERE block_number>$3 AND block_number<=$4 AND decoder_status='repair')::text AS repair_evidence,
   (SELECT coalesce(jsonb_object_agg(reason,amount),'{}') FROM(SELECT coalesce(last_error,'unknown') reason,count(*)::text amount
     FROM fresh.recent_evidence WHERE block_number>$3 AND block_number<=$4 AND decoder_status='repair' GROUP BY last_error) reasons) AS repair_reasons,
   (SELECT count(*) FROM fresh.financial_events WHERE canonical AND block_number>$3 AND block_number<=$4
    AND kind IN('transfer_in','transfer_out') AND amount_usd IS NULL)::text AS unpriced_transfer_events,
   (SELECT count(*) FROM fresh.recent_evidence WHERE block_number>$3 AND block_number<=$4 AND decoder_status='done' AND last_error IS NOT NULL)::text AS completed_evidence_warnings,
   (SELECT count(*) FROM fresh.recent_evidence WHERE block_number>$3 AND block_number<=$4 AND decoder_status='done' AND decoder_version<$2)::text AS outdated_evidence,
   (SELECT count(*) FROM fresh.financial_events WHERE canonical AND block_number>$3 AND block_number<=$4 AND decoder_version<$2)::text AS outdated_financial_events,
   (SELECT count(*) FROM fresh.wallets w WHERE w.decode_gap_from_block>$3 AND w.decode_gap_from_block<=$4 AND EXISTS(
    SELECT 1 FROM fresh.accounting_scopes s WHERE s.active AND w.address=ANY(s.wallet_addresses)))::text AS durable_wallet_gaps,
   (SELECT count(*) FROM fresh.jobs j WHERE j.kind='registration_capture' AND j.state NOT IN('done','cancelled')
    AND coalesce((j.progress->>'targetBlock')::bigint,$4)>$3)::text AS registration_jobs,
   (SELECT count(*) FROM fresh.recent_blocks)::text AS headers,(SELECT count(*) FROM fresh.jobs)::text AS jobs,
   (SELECT count(*) FROM fresh.launch_facts)::text AS launches`,[new Date(now),FRESH_DECODER_VERSION,scope.blockNumber,height])).rows[0];
  const positions=(await client.query(`${affected}, dependencies AS(SELECT a.*,s.wallet_addresses,s.starts_block,s.account_id,
   EXISTS(SELECT 1 FROM fresh.wallets w WHERE w.address=ANY(s.wallet_addresses) AND w.decode_gap_from_block<=$2) AS wallet_gap,
   EXISTS(SELECT 1 FROM fresh.jobs j WHERE j.kind='registration_capture' AND j.reference=ANY(s.wallet_addresses) AND j.state NOT IN('done','cancelled'))
    OR(s.account_id IS NOT NULL AND EXISTS(SELECT 1 FROM unnest(s.wallet_addresses) member(wallet)
     WHERE NOT EXISTS(SELECT 1 FROM public.journal_wallets j WHERE j.user_id::text=s.account_id AND j.wallet_address=member.wallet))) AS registration_pending,
   EXISTS(SELECT 1 FROM fresh.recent_evidence e WHERE e.wallet_addresses&&s.wallet_addresses
    AND e.block_number>=s.starts_block AND e.block_number<=$2 AND e.decoder_status<>'done') AS decoding_pending,
   EXISTS(SELECT 1 FROM expected ex LEFT JOIN fresh.scope_event_results r ON r.scope_id=ex.scope_id AND r.event_id=ex.event_id
    WHERE ex.scope_id=a.scope_id AND ex.token_address=a.token_address AND(r.event_id IS NULL
     OR r.tokens_trade IS DISTINCT FROM(ex.kind IN('buy','sell')) OR r.token_address IS DISTINCT FROM ex.token_address)) AS projection_missing
   FROM affected a JOIN fresh.accounting_scopes s ON s.id=a.scope_id)
  SELECT d.scope_id,d.token_address,p.quantity_q,p.unknown_cost,p.unknown_fee,p.unknown_purchase_value,p.unknown_sale_value,
   p.unknown_incoming_value,p.unknown_outgoing_value,
   EXISTS(SELECT 1 FROM fresh.scope_event_results r JOIN fresh.financial_events f ON f.id=r.event_id AND f.canonical
    WHERE r.scope_id=d.scope_id AND r.token_address=d.token_address AND r.tokens_trade AND f.kind IN('buy','sell')) AS has_trades,
   p.balance_status,p.balance_quantity,p.balance_block::text,p.balance_hash,
   e.block_number::text AS last_event_block,(e.canonical AND NOT EXISTS(SELECT 1 FROM fresh.recent_blocks h
    WHERE h.block_number=e.block_number AND h.block_hash<>e.block_hash) AND(EXISTS(SELECT 1 FROM fresh.recent_blocks h
    WHERE h.block_number=e.block_number AND h.block_hash=e.block_hash) OR e.block_number<(SELECT min(block_number) FROM fresh.recent_blocks))) AS last_event_canonical,
   p.balance_block<=$2 AND NOT EXISTS(SELECT 1 FROM fresh.recent_blocks b WHERE b.block_number=p.balance_block AND b.block_hash<>p.balance_hash)
    AND(EXISTS(SELECT 1 FROM fresh.recent_blocks b WHERE b.block_number=p.balance_block AND b.block_hash=p.balance_hash)
      OR p.balance_block<(SELECT min(block_number) FROM fresh.recent_blocks)) AS balance_canonical,
   t.price_usd::text,t.valuation_status,t.observed_at,t.observed_block::text,t.observed_hash,
   t.observed_block<=$2 AND NOT EXISTS(SELECT 1 FROM fresh.recent_blocks b WHERE b.block_number=t.observed_block AND b.block_hash<>t.observed_hash)
    AND(EXISTS(SELECT 1 FROM fresh.recent_blocks b WHERE b.block_number=t.observed_block AND b.block_hash=t.observed_hash)
      OR t.observed_block<(SELECT min(block_number) FROM fresh.recent_blocks)) AS quote_canonical,
   d.wallet_gap,d.registration_pending,d.decoding_pending,d.projection_missing,
   coalesce(p.scope_id IS NOT NULL AND t.launch_status='eligible' AND NOT d.wallet_gap AND NOT d.registration_pending
    AND NOT d.decoding_pending AND NOT d.projection_missing AND p.balance_status='matched' AND p.balance_quantity IS NOT NULL
    AND p.balance_block>=e.block_number AND p.balance_block<=$2 AND p.balance_checked_at>=p.last_event_at
    AND NOT p.unknown_cost AND NOT p.unknown_fee AND p.realized_q IS NOT NULL
    AND NOT p.unknown_purchase_value AND NOT p.unknown_sale_value AND NOT p.unknown_incoming_value AND NOT p.unknown_outgoing_value,false) AS application_ready
   FROM dependencies d LEFT JOIN fresh.positions p ON p.scope_id=d.scope_id AND p.token_address=d.token_address
   LEFT JOIN fresh.tokens t ON t.address=d.token_address LEFT JOIN fresh.financial_events e ON e.id=p.last_event_id
   ORDER BY d.scope_id,d.token_address`,[scope.blockNumber,height])).rows as FreshForwardTrialPosition[];
  const projection=(await client.query(`${affected} SELECT
   (SELECT count(*) FROM forward_events e WHERE NOT EXISTS(SELECT 1 FROM expected x WHERE x.event_id=e.id))::text AS no_scope,
   (SELECT count(*) FROM forward_events e WHERE NOT EXISTS(SELECT 1 FROM fresh.recent_blocks h
    WHERE h.block_number=e.block_number AND h.block_hash=e.block_hash))::text AS noncanonical,
   (SELECT count(*) FROM expected ex LEFT JOIN fresh.scope_event_results r ON r.scope_id=ex.scope_id AND r.event_id=ex.event_id
    LEFT JOIN fresh.positions p ON p.scope_id=ex.scope_id AND p.token_address=ex.token_address
    WHERE r.event_id IS NULL OR r.tokens_trade IS DISTINCT FROM(ex.kind IN('buy','sell'))
     OR r.token_address IS DISTINCT FROM ex.token_address OR p.scope_id IS NULL)::text AS missing`,[scope.blockNumber,height])).rows[0];
  counts.forward_projection_missing=String(Number(projection.no_scope)+Number(projection.missing)+Number(projection.noncanonical));
  counts.forward_dependency_pending=String(positions.filter(row=>(row as any).wallet_gap||(row as any).registration_pending||(row as any).decoding_pending).length);
  const historicalDiagnostics=(await client.query(`SELECT
   (SELECT count(*) FROM fresh.recent_evidence WHERE block_number<=$1 AND decoder_status<>'done')::text AS pending_evidence,
   (SELECT count(*) FROM fresh.recent_evidence WHERE block_number<=$1 AND decoder_status='repair')::text AS repair_evidence,
   (SELECT coalesce(jsonb_object_agg(reason,amount),'{}') FROM(SELECT coalesce(last_error,'unknown') reason,count(*)::text amount
     FROM fresh.recent_evidence WHERE block_number<=$1 AND decoder_status='repair' GROUP BY last_error) reasons) AS repair_reasons,
   (SELECT count(*) FROM fresh.wallets WHERE decode_gap_from_block<=$1)::text AS durable_wallet_gaps,
   (SELECT count(*) FROM fresh.positions WHERE unknown_cost OR unknown_fee)::text AS unknown_financial_positions,
   (SELECT block_number::text FROM fresh.checkpoints WHERE key='decode') AS global_decode_block`,[scope.blockNumber])).rows[0];
  await client.query('COMMIT');
  return{checkpoints,counts,positions,historicalDiagnostics,boundaryCanonical,
   forwardRepresentativeCounts:{public_buys:counts.public_buys,public_sells:counts.public_sells,tokens:counts.tokens}};
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
