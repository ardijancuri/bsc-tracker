import{kolProfileTokenSql}from'../kolProfileToken.js';
import{freshTrackedTokenSql,freshTrackedEventSql}from'./tracking.js';
import{freshPublicTradeScopeSql}from'./publicTokens.js';

/** Resolve one wallet's distinct public traded-token IDs once. Materializing
 * this small set prevents PostgreSQL rescanning the wallet's trades for every
 * token before applying the six-card page. It also proves the global public
 * activity EXISTS, so that identical second scan is unnecessary. */
export function freshPublicKolTokenPageSql(){
 return`WITH wallet_traded_tokens AS MATERIALIZED (
  SELECT DISTINCT e.token_address FROM fresh.visible_trades e JOIN fresh.tokens wallet_token ON wallet_token.address=e.token_address
  WHERE e.wallet_address=$1 AND ${freshPublicTradeScopeSql('e')} AND ${freshTrackedEventSql('e','wallet_token')}
 ), token_page AS MATERIALIZED (
  SELECT t.* FROM wallet_traded_tokens wallet_token JOIN fresh.tokens t ON t.address=wallet_token.token_address
  WHERE ${freshTrackedTokenSql('t')} AND ${kolProfileTokenSql('t')}
  ORDER BY t.last_trade_at DESC NULLS LAST,t.address LIMIT $2 OFFSET $3
 ) SELECT t.*,t.today_utc::text AS utc_date,fill.occurred_at AS last_priced_fill_at,
   fill.amount_usd AS last_fill_amount_usd,fill.quantity AS last_fill_quantity
 FROM token_page t LEFT JOIN LATERAL (
  SELECT e.occurred_at,e.amount_usd,e.quantity FROM fresh.financial_events e
  WHERE (t.market_cap_usd IS NULL OR t.valuation_status<>'ready') AND t.total_supply_raw>0 AND t.decimals IS NOT NULL
    AND e.wallet_address=$1 AND e.token_address=t.address AND e.amount_usd IS NOT NULL
    AND ${freshPublicTradeScopeSql('e')} AND ${freshTrackedEventSql('e','t')}
  ORDER BY e.occurred_at DESC,e.block_number DESC,e.transaction_index DESC,e.execution_index DESC,e.id DESC LIMIT 1
 ) fill ON true ORDER BY t.last_trade_at DESC NULLS LAST,t.address`;
}
