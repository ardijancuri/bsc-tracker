import {kolProfileTokenSql} from '../kolProfileToken.js';
/** Public discovery requires a genuine public buy/sell. Retained transfer
 * accounting, a private position, or a new pool cannot publish a token. */
export function freshPublicTokenSql(alias='t'){
  if(!/^[a-z_][a-z0-9_]*$/i.test(alias))throw new Error('Invalid SQL alias');
  return `${alias}.launch_status='eligible' AND ${kolProfileTokenSql(alias)} AND EXISTS(
    SELECT 1 FROM fresh.financial_events visible_event JOIN fresh.kols visible_kol ON visible_kol.wallet_address=visible_event.wallet_address AND visible_kol.is_tracked
    WHERE visible_event.token_address=${alias}.address AND visible_event.canonical AND visible_event.kind IN('buy','sell')
    AND visible_event.block_number<=COALESCE((SELECT block_number FROM fresh.checkpoints WHERE key='capture'),0))`;
}
