const knownMemes = [
  '0xba2ae424d960c26247dd6c32edc70b295c744c43', // DOGE
  '0x2859e4544c4bb03966803b044a93563bd2d0dd4d', // SHIB
  '0xc748673057861a797275cd8a068abb95a902e8de', // BabyDoge
  '0xfb5b838b6cfeedc2873ab27866079ac55363d37e', // FLOKI
];
const nonMemeSymbol = /^(?:BNB|WBNB|ETH|WETH|BTC|BTCB|WBTC|USDT|USDC|BUSD|FDUSD|DAI|USD1|CAKE|UNI-V2|Cake-LP|Pancake-LP)$/i;

export function isMemeToken(token: { address: string; symbol?: string | null; name?: string | null; logoUrl?: string | null }, isPair = false): boolean {
  if (isPair || nonMemeSymbol.test(token.symbol || '') || /(?:dividend[_ ]?tracker|liquidity|\bLP\b)/i.test(`${token.symbol || ''} ${token.name || ''}`)) return false;
  const address = token.address.toLowerCase();
  return knownMemes.includes(address) || /(?:4444|ffff|7777|8888|9999|aaaa)$/.test(address) ||
    /^https:\/\/genius\.fun\/api\/image\?/i.test(token.logoUrl || '');
}

export function memeTokenSql(alias = 'v'): string {
  const known = knownMemes.map(address => `'${address}'`).join(',');
  return `((COALESCE(${alias}.is_meme, lower(${alias}.address) ~ '(4444|ffff|7777|8888|9999|aaaa)$' OR lower(${alias}.address) IN (${known})) OR ${alias}.logo_url LIKE 'https://genius.fun/api/image?%')
    AND COALESCE(${alias}.symbol,'') !~* '^(BNB|WBNB|ETH|WETH|BTC|BTCB|WBTC|USDT|USDC|BUSD|FDUSD|DAI|USD1|CAKE|UNI-V2|Cake-LP|Pancake-LP)$'
    AND concat_ws(' ',${alias}.symbol,${alias}.name) !~* '(dividend[_ ]?tracker|liquidity|\\mLP\\M)')`;
}
