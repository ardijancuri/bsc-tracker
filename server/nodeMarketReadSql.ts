import { kolProfileTokenSql } from './kolProfileToken.js';

/** Eligibility only: imported evidence does not become canonical trade activity.
 * An optional public wallet alias scopes the same proof for the token's KOL list. */
export function publicTokenEvidenceSql(alias='v',walletAlias?:string) {
  if(!/^[a-z_]+$/.test(alias)||walletAlias!==undefined&&!/^[a-z_]+$/.test(walletAlias))throw new Error('invalid_sql_alias');
  const wallet=walletAlias?` AND public_wallet.address=${walletAlias}.address`:'';
  return `(EXISTS(SELECT 1 FROM trades public_trade JOIN published_kols public_wallet ON public_wallet.address=public_trade.wallet_address
    WHERE public_trade.token_address=${alias}.address AND public_wallet.is_tracked AND public_trade.block_number IS NOT NULL${wallet})
    OR (${kolProfileTokenSql(alias)} AND EXISTS(SELECT 1 FROM node_accounting_baselines public_baseline
      JOIN published_kols public_wallet ON public_wallet.address=public_baseline.wallet_address AND public_wallet.is_tracked
      JOIN node_evidence_blocks public_checkpoint ON public_checkpoint.block_number=public_baseline.checkpoint_block
        AND public_checkpoint.block_hash=public_baseline.checkpoint_hash AND public_checkpoint.timestamp=public_baseline.checkpoint_timestamp
      WHERE public_baseline.token_address=${alias}.address AND public_baseline.schema_version=2 AND public_baseline.invalidated_at IS NULL${wallet}
        AND EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(public_baseline.events)='array' THEN public_baseline.events ELSE '[]'::jsonb END) imported_event
          WHERE imported_event->>'kind' IN ('buy','sell') AND imported_event->>'tokenAddress'=${alias}.address
            AND imported_event->>'walletAddress'=public_baseline.wallet_address))))`;
}

/** Current UI marks come only from captured market observations. Old provider
 * values in the tokens metadata table are deliberately not financial fallbacks. */
export function nodeTokenMarketSql(column: 'price_usd' | 'market_cap_usd', alias = 'v') {
  if (!/^[a-z_]+$/.test(alias)) throw new Error('invalid_sql_alias');
  return `(SELECT q.${column} FROM node_token_market_values q WHERE q.address=${alias}.address AND q.observed_at>now()-interval '3 minutes')`;
}
