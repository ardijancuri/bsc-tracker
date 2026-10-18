import { replayMarketData, type ReplayMarketRequestResult } from './tradeReplayMarketRequest';
import type { TradeReplayData } from './tradeReplayData';

const preparationMessages = {
  accounting_pending: 'Wallet transaction history is still being verified. Retry shortly.',
  accounting_mismatch: 'Wallet movements and the token balance do not reconcile. This replay cannot be prepared yet.',
  unknown_costs: 'Purchase costs or transaction fees are missing. Ending profit cannot be calculated yet.',
  chart_coverage: 'Market chart history does not cover the full replay window yet.',
  stale_quote: 'A recent token price is unavailable. Retry when the current price refreshes.',
  provider_cooldown: 'GMGN is rate limited. Retry after the displayed countdown.',
} as const;

export class ReplayPreparationError extends Error {
  readonly retryAfterMs: number;
  constructor(result: ReplayMarketRequestResult) {
    super(result.blockingReason ? preparationMessages[result.blockingReason] : result.preparationStatus === 'pending'
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

function cancelled() { return new DOMException('Video export cancelled.', 'AbortError'); }

/** A provider cooldown is resumable work, not a failed video. Each pass remains
 * bounded by the market request's 22-second budget; the whole automatic wait is
 * bounded too. Retaining genuine observations lets later passes finish the
 * missing accounting/quote instead of rebuilding the replay from its old card. */
export async function prepareReplayForShare(data: TradeReplayData, signal: AbortSignal, options: {
  onResult?: (result: ReplayMarketRequestResult) => void;
  onWait?: (retryAt: number) => void;
  prepare?: typeof replayMarketData;
} = {}): Promise<ReplayMarketRequestResult> {
  const deadline = Date.now() + 180_000;
  let selected = data;
  for (let attempt = 0; ; attempt += 1) {
    if (signal.aborted) throw cancelled();
    const result = await (options.prepare ?? replayMarketData)(selected, signal);
    if (signal.aborted) throw cancelled();
    options.onResult?.(result);
    if (result.preparationStatus === 'ready') return result;
    const rawDelay = result.retryAfterMs;
    const delay = typeof rawDelay === 'number' && Number.isFinite(rawDelay) && rawDelay > 0 ? Math.max(1000, rawDelay) : 1500;
    if (result.preparationStatus !== 'pending' || attempt >= 7 || Date.now() + delay + 22_000 > deadline) return requirePreparedReplay(result);
    selected = result.data;
    options.onWait?.(Date.now() + delay);
    await new Promise<void>((resolve, reject) => {
      const abort = () => { clearTimeout(timer); reject(cancelled()); };
      const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, delay);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) { signal.removeEventListener('abort', abort); abort(); }
    });
    if (signal.aborted) throw cancelled();
    options.onWait?.(0);
  }
}
