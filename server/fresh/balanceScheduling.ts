import { freshPositionReceiptRelevantSql,freshPendingTradeScopeSql } from './positionDependencies.js';
import{freshScopeTokenBoundarySql}from'./tracking.js';
import{freshScopeTokenCaptureSql}from'./gangTokenCoverage.js';

/** Receipt eligibility follows the same scope and per-wallet membership
 * boundaries as accounting. Missing headers conservatively remain pending. */
const membershipMissing=`(s.account_id IS NOT NULL AND EXISTS(SELECT 1 FROM unnest(s.wallet_addresses) member(wallet_address)
 LEFT JOIN public.journal_wallets j ON j.user_id::text=s.account_id AND j.wallet_address=member.wallet_address WHERE j.wallet_address IS NULL))`;
const decodingPending=(block:string)=>`(EXISTS(SELECT 1 FROM fresh.recent_evidence e
 LEFT JOIN fresh.recent_blocks h USING(block_number,block_hash)
 WHERE e.wallet_addresses&&s.wallet_addresses AND ${freshScopeTokenBoundarySql('s','p.token_address','e.block_number','h.occurred_at',{allowMissingTime:true})} AND e.block_number<=${block} AND e.decoder_status<>'done'
 AND ${freshPositionReceiptRelevantSql('e','p.token_address','s')} AND EXISTS(
  SELECT 1 FROM unnest(s.wallet_addresses) member(wallet_address)
  LEFT JOIN public.journal_wallets j ON s.account_id IS NOT NULL AND j.user_id::text=s.account_id AND j.wallet_address=member.wallet_address
  WHERE member.wallet_address=ANY(e.wallet_addresses) AND (
   s.account_id IS NULL AND ${freshScopeTokenBoundarySql('s','p.token_address','e.block_number','h.occurred_at',{allowMissingTime:true})}
   OR s.account_id IS NOT NULL AND j.wallet_address IS NOT NULL
    AND e.block_number>=greatest(s.starts_block,coalesce(j.registration_block,s.starts_block))
    AND(h.occurred_at IS NULL OR h.occurred_at>=greatest(s.starts_at,j.activity_from))))) OR ${freshPendingTradeScopeSql('s','p.token_address',block)})`;
// The wallet retains only the earliest missing block, not a bounded gap end.
// A marker before this book cannot prove that later missing blocks do not
// overlap it; preserve the explicit gap until independently repaired.
export const freshPositionWalletGapSql=(block:string)=>`EXISTS(SELECT 1 FROM fresh.wallets w WHERE w.address=ANY(s.wallet_addresses) AND w.decode_gap_from_block<=${block})`;
const registrationPending=`(${membershipMissing} OR EXISTS(SELECT 1 FROM fresh.jobs j WHERE j.kind='registration_capture'
 AND j.reference=ANY(s.wallet_addresses) AND j.state NOT IN('done','cancelled')))`;

/** Reconciliation-ready work precedes receipts correctly blocked by history.
 * A failed attempt never advances any balance confirmation/proof metadata. */
export const freshBalanceWorkSql=`WITH candidates AS(SELECT p.scope_id,p.token_address,p.quantity_q,p.revision::text,s.wallet_addresses,s.revision::text AS scope_revision,t.decimals,coverage.block AS effective_capture_block,
 ${freshPositionWalletGapSql('coverage.block')} AS wallet_gap,${registrationPending} AS registration_pending,${decodingPending('coverage.block')} AS decoding_pending,
 last.block_number AS last_event_block,p.balance_checked_at,p.last_event_at
 FROM fresh.positions p JOIN fresh.accounting_scopes s ON s.id=p.scope_id JOIN fresh.tokens t ON t.address=p.token_address
 CROSS JOIN LATERAL(SELECT ${freshScopeTokenCaptureSql('s','p.token_address')} AS block) coverage
 LEFT JOIN fresh.financial_events last ON last.id=p.last_event_id
 WHERE s.active AND coverage.block>=$2 AND(p.balance_checked_at IS NULL OR p.balance_quantity IS NULL OR p.balance_hash IS NULL OR p.balance_block IS NULL OR last.block_number>p.balance_block
  OR p.last_event_at>p.balance_checked_at OR p.balance_status<>'matched'))
 SELECT * FROM candidates ORDER BY(wallet_gap OR registration_pending OR decoding_pending OR decimals IS NULL OR last_event_block IS NULL OR last_event_block>effective_capture_block),
 balance_checked_at NULLS FIRST,last_event_at DESC,scope_id,token_address LIMIT $1`;

/** Recheck the identical membership/history gates after asynchronous RPC. */
export const freshBalanceCommitSql=`UPDATE fresh.positions SET balance_quantity=$3,balance_block=$4,balance_hash=$5,balance_checked_at=$6,balance_status=$7
 WHERE scope_id=$1 AND token_address=$2 AND revision=$8 AND EXISTS(SELECT 1 FROM fresh.accounting_scopes s WHERE s.id=$1 AND s.active AND s.revision=$9
 AND NOT ${freshPositionWalletGapSql('$4')} AND NOT ${registrationPending} AND NOT ${decodingPending('$4').replaceAll('p.token_address','fresh.positions.token_address')}
 AND $4<=${freshScopeTokenCaptureSql('s','$2')})
 AND(EXISTS(SELECT 1 FROM fresh.recent_blocks b WHERE b.block_number=$4 AND b.block_hash=$5)
  OR EXISTS(SELECT 1 FROM fresh.checkpoints c WHERE c.key='capture' AND c.block_number=$4 AND c.block_hash=$5))`;
