import { isStockToken, nonStockTokenSql } from './stockToken.js';

// Reward assets explicitly excluded from KOL profiles. Match their contracts so
// unrelated meme tokens with the same names remain eligible.
const excludedProfileAssets = [
  '0x21caef8a43163eea865baee23b9c2e327696a3bf', // XAUt
  '0x7130d2a12b9bcbfae4f2634d864a1ee1ce3ead9c', // BTCB
  '0x7ddef360f3c2db4cc41c3967984fefa2598cc9a6', // xOPAI
] as const;
const excludedAddresses = new Set<string>(excludedProfileAssets);
const excludedAddressesSql = excludedProfileAssets.map(address => `'${address}'`).join(',');

// Keep the established quote, pool and auxiliary tracker exclusions used by the
// token directory, without requiring a launchpad suffix or a known meme address.
const quoteSymbolPattern = '^(BNB|WBNB|ETH|WETH|BTC|BTCB|WBTC|USDT|USDC|BUSD|FDUSD|DAI|USD1|CAKE|UNI-V2|Cake-LP|Pancake-LP)$';
const quoteSymbol = new RegExp(quoteSymbolPattern, 'i');
const auxiliaryToken = /(?:dividend[_ ]?tracker|liquidity|\bLP\b)/i;

export function isExcludedKolProfileTokenAddress(address: string): boolean {
  return excludedAddresses.has(address.toLowerCase()) || isStockToken(address);
}

export function isKolProfileToken(token: { address: string; symbol?: string | null; name?: string | null }): boolean {
  return !isExcludedKolProfileTokenAddress(token.address)
    && !quoteSymbol.test(token.symbol || '')
    && !auxiliaryToken.test(`${token.symbol || ''} ${token.name || ''}`);
}

// Apply before pagination and aggregation, and before starting P&L preparation.
export function kolProfileTokenSql(alias = 'v'): string {
  return `(${nonStockTokenSql(`${alias}.address`)}
    AND lower(${alias}.address) NOT IN (${excludedAddressesSql})
    AND COALESCE(${alias}.symbol,'') !~* '${quoteSymbolPattern}'
    AND concat_ws(' ',${alias}.symbol,${alias}.name) !~* '(dividend[_ ]?tracker|liquidity|\\mLP\\M)')`;
}
