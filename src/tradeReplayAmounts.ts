export interface TradeReplayAmountEvent {
  index: number;
  side: 'buy' | 'sell';
  atSeconds: number;
  amountUsd: number | null;
}

export interface TradeReplayAmountCluster {
  entries: { index: number; startSeconds: number }[];
  cadenceSeconds: number;
  lifetimeSeconds: number;
}

const buyBurstGapSeconds = 0.4;
const buyBurstCadenceSeconds = 0.22;
const buyBurstLifetimeSteps = 3.6;
const singletonLifetimeSeconds = 1.35;

/**
 * Presentation-only callouts. Sorted source events retain their own amounts and
 * cannot be shown before arrival. Source events end at least 1.5s before the
 * clip does, leaving room for a bounded queue during the existing ending hold.
 */
export function createTradeReplayAmountSchedule(
  events: readonly TradeReplayAmountEvent[],
  durationSeconds: number,
): TradeReplayAmountCluster[] {
  const sources: TradeReplayAmountEvent[][] = [];
  let pendingBuys: TradeReplayAmountEvent[] | undefined;
  for (const event of events) {
    // An unpriced sell still interrupts the sequence of buy circles.
    if (event.side === 'sell') pendingBuys = undefined;
    if (event.amountUsd === null || !Number.isFinite(event.amountUsd) || event.amountUsd <= 0
      || !Number.isFinite(event.atSeconds)) continue;
    const previousBuy = pendingBuys?.at(-1);
    const gap = previousBuy ? event.atSeconds - previousBuy.atSeconds : Infinity;
    if (event.side === 'buy' && pendingBuys && gap >= 0 && gap <= buyBurstGapSeconds + 1e-9) {
      pendingBuys.push(event);
    } else {
      const source = [event];
      sources.push(source);
      pendingBuys = event.side === 'buy' ? source : undefined;
    }
  }

  return sources.map(source => {
    if (source.length === 1) {
      return { entries: [{ index: source[0].index, startSeconds: source[0].atSeconds }],
        cadenceSeconds: 0, lifetimeSeconds: singletonLifetimeSeconds };
    }
    const deadline = durationSeconds - 0.02;
    // This bound considers every source arrival, including a late final fill.
    // A very dense ending shortens only its callout cadence, never source time.
    const cadenceSeconds = source.reduce((cadence, event, index) => Math.min(cadence,
      (deadline - event.atSeconds) / (source.length - 1 - index + buyBurstLifetimeSteps)), buyBurstCadenceSeconds);
    let previousStart = -Infinity;
    const entries = source.map(event => {
      const startSeconds = Math.max(event.atSeconds, previousStart + cadenceSeconds);
      previousStart = startSeconds;
      return { index: event.index, startSeconds };
    });
    return { entries, cadenceSeconds, lifetimeSeconds: cadenceSeconds * buyBurstLifetimeSteps };
  });
}
