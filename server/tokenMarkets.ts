type Pair = { baseToken?: { address?: string }; marketCap?: number | null; liquidity?: { usd?: number }; priceChange?: { h24?: number | null } };
export function selectTokenMarkets(pairs: Pair[], addresses: string[]) {
  const wanted = new Set(addresses.map(address => address.toLowerCase()));
  const markets = new Map<string, { cap: number; liquidity: number; change24h: number | null }>();
  for (const pair of pairs) {
    const address = pair.baseToken?.address?.toLowerCase();
    const cap = Number(pair.marketCap), liquidity = Number(pair.liquidity?.usd || 0);
    if (!address || !wanted.has(address) || !Number.isFinite(cap) || cap <= 0 || !Number.isFinite(liquidity)) continue;
    const change = pair.priceChange?.h24;
    const change24h = typeof change === 'number' && Number.isFinite(change) && change >= -100 ? change : null;
    if (!markets.has(address) || liquidity > markets.get(address)!.liquidity) markets.set(address, { cap, liquidity, change24h });
  }
  return markets;
}
