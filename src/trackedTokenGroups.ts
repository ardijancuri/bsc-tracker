/** Only tokens with a known positive market cap belong in the tracker buckets. */
export function groupTrackedTokens<T extends { marketCapUsd: string | null; valuationStatus?: string }>(tokens: readonly T[]) {
  const groups: Record<'low' | 'mid' | 'high', T[]> = { low: [], mid: [], high: [] };
  for (const token of tokens) {
    if (token.valuationStatus === 'no_liquidity') continue;
    const cap = token.marketCapUsd == null ? NaN : Number(token.marketCapUsd);
    if (!Number.isFinite(cap) || cap <= 0) continue;
    const group = cap < 100_000 ? 'low' : cap < 1_000_000 ? 'mid' : 'high';
    groups[group].push(token);
  }
  return groups;
}
