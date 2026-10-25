/** Group the tradable directory while retaining tokens whose valuation is pending. */
export function groupTrackedTokens<T extends { marketCapUsd: string | null; valuationStatus?: string }>(tokens: readonly T[]) {
  const groups: Record<'low' | 'mid' | 'high' | 'unpriced', T[]> = { low: [], mid: [], high: [], unpriced: [] };
  for (const token of tokens) {
    if (token.valuationStatus === 'no_liquidity') continue;
    const cap = token.marketCapUsd == null ? NaN : Number(token.marketCapUsd);
    const group = !Number.isFinite(cap) || cap <= 0 ? 'unpriced' : cap < 100_000 ? 'low' : cap < 1_000_000 ? 'mid' : 'high';
    groups[group].push(token);
  }
  return groups;
}
