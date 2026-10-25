import { describe, expect, it } from 'vitest';
import { createTradeReplayAmountSchedule, type TradeReplayAmountEvent } from './tradeReplayAmounts';

const buy = (index: number, atSeconds: number, amountUsd: number | null = 15): TradeReplayAmountEvent =>
  ({ index, side: 'buy', atSeconds, amountUsd });
const sell = (index: number, atSeconds: number, amountUsd: number | null = 20): TradeReplayAmountEvent =>
  ({ index, side: 'sell', atSeconds, amountUsd });

describe('sequential replay buy amount callouts', () => {
  it('keeps singleton buy and sell callouts at their genuine arrival and existing lifetime', () => {
    expect(createTradeReplayAmountSchedule([], 5)).toEqual([]);
    expect(createTradeReplayAmountSchedule([buy(3, 0), sell(8, 0.1), buy(9, 2)], 5)).toEqual([
      { entries: [{ index: 3, startSeconds: 0 }], cadenceSeconds: 0, lifetimeSeconds: 1.35 },
      { entries: [{ index: 8, startSeconds: 0.1 }], cadenceSeconds: 0, lifetimeSeconds: 1.35 },
      { entries: [{ index: 9, startSeconds: 2 }], cadenceSeconds: 0, lifetimeSeconds: 1.35 },
    ]);
  });

  it('reveals close buys separately in source order with staggered entrances', () => {
    const events = [buy(0, 1), buy(1, 1), buy(2, 1.03), buy(3, 1.09)];
    const [cluster] = createTradeReplayAmountSchedule(events, 5);
    expect(cluster.cadenceSeconds).toBe(0.22);
    expect(cluster.lifetimeSeconds).toBeCloseTo(0.792, 12);
    expect(cluster.entries.map(entry => entry.index)).toEqual([0, 1, 2, 3]);
    for (const [index, entry] of cluster.entries.entries()) {
      expect(entry.startSeconds).toBeCloseTo(1 + index * 0.22, 12);
      expect(entry.startSeconds).toBeGreaterThanOrEqual(events[index].atSeconds);
    }
  });

  it('never advances a future buy when its actual arrival follows the queue cadence', () => {
    const events = [buy(0, 1), buy(1, 1.3), buy(2, 1.6), buy(3, 2.01)];
    const clusters = createTradeReplayAmountSchedule(events, 5);
    expect(clusters).toHaveLength(2);
    expect(clusters[0].entries.map(entry => entry.startSeconds)).toEqual([1, 1.3, 1.6]);
    expect(clusters[1].entries).toEqual([{ index: 3, startSeconds: 2.01 }]);
  });

  it('keeps the inclusive burst boundary stable under floating-point subtraction', () => {
    expect(createTradeReplayAmountSchedule([buy(0, 1), buy(1, 1.4), buy(2, 1.8)], 5))
      .toHaveLength(1);
  });

  it('skips unknown and nonpositive amounts without blank rows but retains sell boundaries', () => {
    const events = [buy(0, 0), buy(1, 0.05, null), buy(2, 0.1), sell(3, 0.15, null),
      buy(4, 0.2), buy(5, 0.25, 0), buy(6, 0.3, NaN), buy(7, 0.35, Infinity),
      buy(8, 0.4, -1), buy(9, 0.5), sell(10, 0.6), buy(11, 0.7)];
    const clusters = createTradeReplayAmountSchedule(events, 5);
    expect(clusters.map(cluster => cluster.entries.map(entry => entry.index))).toEqual([[0, 2], [4, 9], [10], [11]]);
  });

  it('has at most four simultaneously active rows in a dense burst', () => {
    const [cluster] = createTradeReplayAmountSchedule(Array.from({ length: 50 }, (_, index) => buy(index, 1)), 25);
    let maximumRows = 0;
    for (let time = 0; time < 25; time += 0.005) {
      maximumRows = Math.max(maximumRows, cluster.entries.filter(entry =>
        entry.startSeconds <= time && time < entry.startSeconds + cluster.lifetimeSeconds).length);
    }
    expect(maximumRows).toBe(4);
  });

  it.each([2, 9, 100])('fits %s late buy callouts inside the original clip ending hold', count => {
    const duration = 9.23;
    const events = Array.from({ length: count }, (_, index) => buy(index, duration - 1.5 + index / count * 0.02));
    const [cluster] = createTradeReplayAmountSchedule(events, duration);
    expect(cluster.cadenceSeconds).toBeGreaterThan(0);
    expect(cluster.cadenceSeconds).toBeLessThanOrEqual(0.22);
    for (const [index, entry] of cluster.entries.entries()) {
      expect(entry.startSeconds).toBeGreaterThanOrEqual(events[index].atSeconds);
      expect(entry.startSeconds + cluster.lifetimeSeconds).toBeLessThanOrEqual(duration - 0.02 + 1e-10);
      if (index) expect(entry.startSeconds - cluster.entries[index - 1].startSeconds)
        .toBeGreaterThanOrEqual(cluster.cadenceSeconds - 1e-10);
    }
  });

  it('returns identical results without changing frozen source events', () => {
    const events = Object.freeze([Object.freeze(buy(3, 1)), Object.freeze(buy(5, 1.01)), Object.freeze(sell(8, 2))]);
    const original = structuredClone(events);
    expect(createTradeReplayAmountSchedule(events, 5)).toEqual(createTradeReplayAmountSchedule(events, 5));
    expect(events).toEqual(original);
  });
});
