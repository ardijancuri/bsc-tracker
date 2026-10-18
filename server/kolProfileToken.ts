import { isStockToken, nonStockTokenSql } from './stockToken.js';

// Reward/pair assets explicitly excluded from KOL profiles. Match their contracts so
// unrelated meme tokens with the same names remain eligible.
const excludedProfileAssets = [
  '0x21caef8a43163eea865baee23b9c2e327696a3bf', // XAUt
  '0x7130d2a12b9bcbfae4f2634d864a1ee1ce3ead9c', // BTCB
  '0x7ddef360f3c2db4cc41c3967984fefa2598cc9a6', // xOPAI
  '0x24b518b332543a4e1c3649d063dab199d103760a', // oANTHROPIC (user-excluded reward/pair asset)
  '0xce7de646e7208a4ef112cb6ed5038fa6cc6b12e3', // TRX
  '0x1ba42e5193dfa8b03d15dd1b86a3113bbbef8eeb', // ZEC
  '0xce24439f2d9c6a2289f741120fe202248b666666', // User-excluded reward/pair asset
  '0x000ae314e2a2172a039b26378814c252734f556a', // User-excluded KOL profile asset
  // Other established payout/pair assets present in indexed KOL activity.
  // Contract identities: https://github.com/pancakeswap/token-list/blob/main/lists/pancakeswap-extended.json
  '0x85eac5ac2f758618dfa09bdbe0cf174e7d574d5b', // TRX (second contract)
  '0x4b0f1812e5df2a09796481ff14017e6005508003', // TWT
  '0x570a5d26f7765ecb712c0924e4de545b89fd43df', // SOL
  '0xbf5140a22578168fd562dccf235e5d43a02ce9b1', // UNI
  '0xfceb31a79f71ac9cbdcf853519c1b12d379edc46', // LISTA
  '0x0782b6d8c4551b9760e74c0545a9bcd90bdc41e5', // lisUSD
  '0x1d2f0da169ceb9fc7b3144628db156f3f6c60dbe', // XRP
  '0x23396cf899ca06c4472205fc903bdb4de249d6fc', // UST
  '0x7083609fce4d1d8dc0c979aab8c869ea2c873402', // DOT
  '0x4338665cbb7b2485a8855a139b75d5e34ab0db94', // LTC
  '0xb0b84d294e0c75a6abe60171b70edeb2efd14a1b', // slisBNB
  '0x1fa4a73a3f0133f0025378af00236f3abdee5d63', // NEAR (Trust Wallet verified BSC peg)
  '0xfb6115445bff7b52feb98650c87f44907e58f802', // AAVE (Trust Wallet verified asset)
  '0x2f8a339b5889ffac4c5a956787cda593b3c36867', // CMC20 (CoinMarketCap/Reserve index contract)
  // Paimon market contracts: https://app.paimon.finance/
  '0x1d80392d12caaaf9e333bb0bb7f021eacf297fe6', // pPOLY
  '0xe0cbb7ffc0883810569d84d78f02bbcb747cfe43', // xKLSH
  // ERC-4626 asset() checked against https://xstocks.com/products on 2026-10-17.
  '0x41333df9e7639188bbfca5522dc4844398af9f9e', // Wrapped Tencent xStock
  '0x4ebf5fd25b02022afad96e2fa25da54a246fded0', // Wrapped Pop Mart International xStock
  '0x076cf393e701839fc7a5832d2c68aafa235682ae', // Wrapped Xiaomi xStock
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
