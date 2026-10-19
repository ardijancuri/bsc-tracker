import { MarketDecimal, positiveDecimal } from './nodeMarketMath.js';

export interface NodeQuoteConversionRoute {
  pool: string; protocol: 'pcs_v2'|'pcs_v3'; base: string; priceUsd: string; depthUsd: string;
  evidence: Record<string,unknown>;
}

/** Compare authenticated, same-block routes only. Thin or contradictory spot
 * pools cannot authorize a quote asset's USD mark. No symbol/peg assumptions. */
export function selectNodeQuoteConversion(routes:NodeQuoteConversionRoute[]) {
  const valid=routes.filter(route=>positiveDecimal(route.priceUsd)&&positiveDecimal(route.depthUsd)
    &&MarketDecimal.parse(route.depthUsd).compare(MarketDecimal.parse('1000'))>=0);
  if(!valid.length)return null;
  const prices=valid.map(route=>MarketDecimal.parse(route.priceUsd)).sort((a,b)=>a.compare(b));
  if(prices.at(-1)!.compare(prices[0].mul(MarketDecimal.parse('1.05')))>0)return null;
  return valid.sort((a,b)=>MarketDecimal.parse(b.depthUsd).compare(MarketDecimal.parse(a.depthUsd))||a.pool.localeCompare(b.pool))[0];
}
