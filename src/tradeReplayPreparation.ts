import type { ReplayMarketRequestResult } from './tradeReplayMarketRequest';

export class ReplayPreparationError extends Error {
  readonly retryAfterMs: number;
  constructor(result: ReplayMarketRequestResult) {
    super(result.preparationStatus === 'pending'
      ? 'The chart and profit data are still loading. Retry to prepare a complete replay.'
      : 'The chart and profit data could not be verified. Retry to prepare this replay.');
    this.name = 'ReplayPreparationError';
    const delay = result.retryAfterMs;
    this.retryAfterMs = typeof delay === 'number' && Number.isFinite(delay) && delay > 0 ? Math.min(600_000, delay) : 0;
  }
}

/** Never save a transaction-only curve as a completed market replay. */
export function requirePreparedReplay(result: ReplayMarketRequestResult): ReplayMarketRequestResult {
  if (result.preparationStatus !== 'ready') throw new ReplayPreparationError(result);
  return result;
}
