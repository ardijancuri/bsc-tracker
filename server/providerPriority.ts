/** Provider-neutral scheduling metadata. This module performs no I/O. */
export type GeckoPriority = 'chart' | 'prefetch' | 'sparkline' | 'metadata';
export const marketPriorityRank: Record<GeckoPriority, number> = { chart: 0, prefetch: 1, sparkline: 2, metadata: 3 };
export class MarketProviderDeferred extends Error {
  constructor(public readonly reason: 'busy' | 'rate_limited', public readonly retryAfterMs: number) {
    super(reason === 'rate_limited' ? 'Market provider cooling down' : 'Market provider busy; retry shortly');
  }
}
