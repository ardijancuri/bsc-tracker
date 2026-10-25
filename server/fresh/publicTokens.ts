import {kolProfileTokenSql} from '../kolProfileToken.js';
import {freshTrackedTokenSql,freshTrackedEventSql,freshScopeEventSql,freshScopeWalletMonitoringSql} from './tracking.js';
import{freshScopeTokenCaptureSql}from'./gangTokenCoverage.js';
/** A public identity alone cannot publish private or pre-membership activity. */
export function freshPublicTradeScopeSql(eventAlias='e'){
  if(!/^[a-z_][a-z0-9_]*$/i.test(eventAlias))throw new Error('Invalid SQL alias');
  const e=eventAlias;
  return `${e}.canonical AND ${e}.kind IN('buy','sell')
    AND EXISTS(SELECT 1 FROM fresh.kols public_trade_kol JOIN fresh.wallets public_trade_wallet ON public_trade_wallet.address=public_trade_kol.wallet_address
      JOIN fresh.accounting_scopes public_trade_scope ON public_trade_scope.id='kol:'||public_trade_kol.wallet_address
      WHERE public_trade_kol.wallet_address=${e}.wallet_address AND public_trade_kol.is_tracked AND public_trade_wallet.active
      AND public_trade_scope.active AND public_trade_scope.kind='kol' AND ${e}.wallet_address=ANY(public_trade_scope.wallet_addresses)
      AND ${freshScopeEventSql(e,'public_trade_scope')}
      AND ${freshScopeWalletMonitoringSql(e,'public_trade_scope','public_trade_wallet')}
      AND ${e}.block_number<=${freshScopeTokenCaptureSql('public_trade_scope',e+'.token_address')}
      AND(public_trade_wallet.monitoring_to_block IS NULL OR ${e}.block_number<=public_trade_wallet.monitoring_to_block))`;
}
/** Public discovery requires a genuine public buy/sell. Retained transfer
 * accounting, a private position, or a new pool cannot publish a token. */
export function freshPublicTokenSql(alias='t'){
  if(!/^[a-z_][a-z0-9_]*$/i.test(alias))throw new Error('Invalid SQL alias');
  return `${freshTrackedTokenSql(alias)} AND ${kolProfileTokenSql(alias)} AND EXISTS(
    SELECT 1 FROM fresh.visible_trades visible_event
    WHERE visible_event.token_address=${alias}.address AND ${freshPublicTradeScopeSql('visible_event')}
    AND ${freshTrackedEventSql('visible_event',alias)})`;
}
