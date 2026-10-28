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
 ) SELECT t.*,t.today_utc::text AS utc_date FROM wallet_traded_tokens wallet_token JOIN fresh.tokens t ON t.address=wallet_token.token_address
 WHERE ${freshTrackedTokenSql('t')} AND ${kolProfileTokenSql('t')}
 ORDER BY t.last_trade_at DESC NULLS LAST,t.address LIMIT $2 OFFSET $3`;
}
