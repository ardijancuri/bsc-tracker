import { kolProfileTokenSql } from './kolProfileToken.js';
import { publicTokenEvidenceSql } from './nodeMarketReadSql.js';

/** Receipt hints are worker-only discovery inputs, not financial proof. Retain
 * useful old receipts after node pruning; authenticate candidate markets at the
 * current confirmed checkpoint in the market service. A receipt appears once
 * even when several wallets or operations reference the same token. */
export function nodeMarketReceiptHintsSql() {
  return `WITH receipts AS MATERIALIZED (
    SELECT DISTINCT e.tx_hash,e.block_number,e.transaction_index
    FROM node_execution_flows f JOIN node_executions x ON x.id=f.execution_id
    JOIN node_evidence_transactions e ON e.tx_hash=x.tx_hash AND e.block_number=x.block_number AND e.block_hash=x.block_hash
    JOIN node_evidence_blocks b ON b.block_number=e.block_number AND b.block_hash=e.block_hash
    WHERE f.token_address=$1 AND e.block_number<=$2::bigint
    ORDER BY e.block_number DESC,e.transaction_index DESC,e.tx_hash DESC LIMIT 3
  ) SELECT l.value AS log FROM receipts r JOIN node_evidence_transactions e ON e.tx_hash=r.tx_hash
    CROSS JOIN LATERAL jsonb_array_elements(e.receipt->'logs') WITH ORDINALITY l(value,position)
    ORDER BY r.block_number DESC,r.transaction_index DESC,r.tx_hash DESC,l.position LIMIT 150`;
}

/** Eight bounded discoveries: selected work first, recent activity next, with
 * one remaining slot reserved for older history when foreground demand permits.
 * Private activity is used only by this worker scheduler, never public APIs. */
export function nodeMarketDiscoverySql() {
  return `WITH recent_activity AS (
    SELECT token_address,max(timestamp) AS activity_at FROM (
      SELECT t.token_address,t.timestamp FROM trades t JOIN published_kols k ON k.address=t.wallet_address AND k.is_tracked
        WHERE t.block_number IS NOT NULL AND t.timestamp>now()-interval '24 hours'
      UNION ALL SELECT f.token_address,e.timestamp FROM node_execution_flows f JOIN node_executions e ON e.id=f.execution_id
        JOIN node_monitored_wallets w ON w.wallet_address=e.wallet_address AND w.active
        WHERE e.timestamp>now()-interval '24 hours'
    ) activity GROUP BY token_address
  ), candidates AS MATERIALIZED (
    SELECT v.address,d.last_attempt_at,r.activity_at,
      CASE WHEN EXISTS(SELECT 1 FROM node_market_refresh_jobs j WHERE j.token_address=v.address AND j.expires_at>now()) THEN 0
        WHEN EXISTS(SELECT 1 FROM node_accounting_jobs j WHERE j.token_address=v.address AND j.priority>0) THEN 1 ELSE 2 END AS selection_tier
    FROM tokens v LEFT JOIN node_market_discoveries d ON d.token_address=v.address
    LEFT JOIN recent_activity r ON r.token_address=v.address
    WHERE ${kolProfileTokenSql('v')} AND (${publicTokenEvidenceSql('v')}
      OR EXISTS(SELECT 1 FROM node_execution_flows f JOIN node_executions e ON e.id=f.execution_id
        JOIN node_monitored_wallets w ON w.wallet_address=e.wallet_address AND w.active WHERE f.token_address=v.address))
  ), selected AS (
    SELECT * FROM candidates WHERE selection_tier<2 ORDER BY selection_tier,last_attempt_at ASC NULLS FIRST,address LIMIT 8
  ), recent AS (
    SELECT c.* FROM candidates c WHERE selection_tier=2 AND activity_at IS NOT NULL
      AND (last_attempt_at IS NULL OR last_attempt_at<now()-interval '5 minutes')
    ORDER BY last_attempt_at ASC NULLS FIRST,activity_at DESC,address LIMIT GREATEST(0,7-(SELECT count(*)::int FROM selected))
  ), historical AS (
    SELECT c.* FROM candidates c WHERE selection_tier=2 AND NOT EXISTS(SELECT 1 FROM recent r WHERE r.address=c.address)
    ORDER BY last_attempt_at ASC NULLS FIRST,address
    LIMIT GREATEST(0,8-(SELECT count(*)::int FROM selected)-(SELECT count(*)::int FROM recent))
  ) SELECT address FROM (
    SELECT address,0 AS scheduling_group,selection_tier,last_attempt_at,activity_at FROM selected
    UNION ALL SELECT address,1,selection_tier,last_attempt_at,activity_at FROM recent
    UNION ALL SELECT address,2,selection_tier,last_attempt_at,activity_at FROM historical
  ) work ORDER BY scheduling_group,selection_tier,last_attempt_at ASC NULLS FIRST,activity_at DESC NULLS LAST,address`;
}
