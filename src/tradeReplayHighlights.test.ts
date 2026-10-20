import { describe, expect, it } from 'vitest';
import { reweightReplayProgress, selectReplaySellHighlights, type ReplayHighlightAccountingEvent, type ReplayHighlightTrade } from './tradeReplayHighlights.js';

const at = (second: number) => new Date(Date.UTC(2026, 9, 20, 12, 0, second)).toISOString();
const trade = (index: number, amountUsd: number | null, side: 'buy' | 'sell' = 'sell', realized?: number | null): ReplayHighlightTrade => ({
  id: `trade-${index}`, timestamp: at(index), side, amountUsd, cumulativeRealizedProfitUsd: realized,
});
const accountingEvent = (index: number, kind: ReplayHighlightAccountingEvent['kind'], realized: number | string | null): ReplayHighlightAccountingEvent => ({
  timestamp: at(index), kind, tradeId: `trade-${index}`, cumulativeRealizedProfitUsd: realized,
});

describe('replay sell highlights', () => {
  it('emphasizes a material large sale without inferring take profit from proceeds', () => {
    expect(selectReplaySellHighlights([trade(0, 2000, 'buy'), trade(1, 20), trade(2, 1800)]))
      .toEqual([{ tradeIndex: 2, amountUsd: 1800, label: 'Big sell' }]);
  });

  it('ignores buys, unknown amounts, nonfinite amounts and minuscule sales', () => {
    expect(selectReplaySellHighlights([trade(0, 20_000, 'buy'), trade(1, null), trade(2, NaN), trade(3, Infinity), trade(4, 99)]))
      .toEqual([]);
  });

  it('uses a median outlier threshold without highlighting ordinary small sales', () => {
    const trades = [...Array.from({ length: 10 }, (_, index) => trade(index, 100)), trade(10, 300)];
    expect(selectReplaySellHighlights(trades)).toEqual([{ tradeIndex: 10, amountUsd: 300, label: 'Big sell' }]);
  });

  it('keeps large ticket outliers eligible in long histories despite a small lifetime share', () => {
    const trades = [...Array.from({ length: 23 }, (_, index) => trade(index, 1012)),
      trade(23, 2103), trade(24, 1775), trade(25, 1711)];
    const total = trades.reduce((sum, value) => sum + value.amountUsd!, 0);
    expect(trades.slice(-3).every(value => value.amountUsd! / total < .1)).toBe(true);
    expect(selectReplaySellHighlights(trades).map(value => value.tradeIndex)).toEqual([23, 24, 25]);
  });

  it('limits emphasis to three largest qualifying trades in chronological order', () => {
    const trades = [...Array.from({ length: 30 }, (_, index) => trade(index, 10)),
      trade(30, 500), trade(31, 800), trade(32, 650), trade(33, 700)];
    expect(selectReplaySellHighlights(trades).map(value => value.tradeIndex)).toEqual([31, 32, 33]);
  });

  it('requires a positive known realized delta to label a sale Take profit', () => {
    expect(selectReplaySellHighlights([trade(0, 1000, 'buy', 0), trade(1, 1200, 'sell', 200)]))
      .toEqual([{ tradeIndex: 1, amountUsd: 1200, label: 'Take profit' }]);
    expect(selectReplaySellHighlights([trade(0, 2000, 'buy', 0), trade(1, 1200, 'sell', -800)])[0].label).toBe('Big sell');
  });

  it('does not treat a positive lifetime realized total as this sale being profitable', () => {
    expect(selectReplaySellHighlights([trade(0, 2000, 'buy', 500), trade(1, 1200, 'sell', 300)])[0].label).toBe('Big sell');
  });

  it('does not assume a zero opening realized value or bridge an unknown prior snapshot', () => {
    expect(selectReplaySellHighlights([trade(0, 1200, 'sell', 300)])[0].label).toBe('Big sell');
    expect(selectReplaySellHighlights([trade(0, 1000, 'buy', 0), trade(1, 100, 'buy', null), trade(2, 1200, 'sell', 300)])[0].label)
      .toBe('Big sell');
  });

  it('uses matching accounting events without copying an unrelated transfer gain to a sale', () => {
    const trades = [trade(0, 1000, 'buy'), trade(2, 1200)];
    const events = [accountingEvent(0, 'buy', '0'), accountingEvent(1, 'transfer_out', '500'), accountingEvent(2, 'sell', '400')];
    expect(selectReplaySellHighlights(trades, events)[0].label).toBe('Big sell');
    events[2].cumulativeRealizedProfitUsd = '600';
    expect(selectReplaySellHighlights(trades, events)[0].label).toBe('Take profit');
  });

  it('does not assign an atomic group profit to individual simultaneous sells', () => {
    const sells = [trade(0, 1000, 'buy', 0), trade(1, 600, 'sell', 200), { ...trade(2, 600, 'sell', 200), timestamp: at(1) }];
    expect(selectReplaySellHighlights(sells).map(value => value.label)).toEqual(['Big sell', 'Big sell']);
  });

  it('rejects ambiguous same-second snapshots and transfer-out attribution', () => {
    const trades = [trade(0, 1000, 'buy'), trade(1, 1200)];
    const events = [accountingEvent(0, 'buy', '0'), accountingEvent(1, 'sell', '200'),
      { ...accountingEvent(2, 'transfer_out', '300'), timestamp: at(1) }];
    expect(selectReplaySellHighlights(trades, events)[0].label).toBe('Big sell');
  });

  it('keeps authoritative unknown accounting from being replaced by optimistic trade snapshots', () => {
    const trades = [trade(0, 1000, 'buy', 0), trade(1, 1200, 'sell', 200)];
    const events = [accountingEvent(0, 'buy', null), accountingEvent(1, 'sell', null)];
    expect(selectReplaySellHighlights(trades, events)[0].label).toBe('Big sell');
  });

  it('does not mutate trade or accounting input', () => {
    const trades = Object.freeze([Object.freeze(trade(0, 1000, 'buy')), Object.freeze(trade(1, 1200))]);
    const events = Object.freeze([Object.freeze(accountingEvent(0, 'buy', '0')), Object.freeze(accountingEvent(1, 'sell', '200'))]);
    expect(selectReplaySellHighlights(trades, events)[0].label).toBe('Take profit');
  });
});

describe('replay highlight pacing', () => {
  it('gives the approach and departure extra presentation time within the same phase', () => {
    const base = [0, .2, .4, .6, .8], paced = reweightReplayProgress(base, [2], .8);
    // Most of the phase now goes to the approach/departure of this sale,
    // giving it a longer slow-motion beat without extending the video.
    expect(paced[2] - paced[1]).toBeGreaterThan(.3);
    expect(paced[3] - paced[2]).toBeGreaterThan(.3);
    expect(paced[0]).toBe(0);
    expect(paced.at(-1)).toBe(.8);
    expect(base).toEqual([0, .2, .4, .6, .8]);
  });

  it('retains duplicate progress knots as an atomic group', () => {
    const paced = reweightReplayProgress([0, .2, .4, .4, .4, .6, .8], [3], .8);
    expect(paced[2]).toBe(paced[3]);
    expect(paced[3]).toBe(paced[4]);
    expect(paced[2] - paced[1]).toBeGreaterThan(.2);
    expect(paced[5] - paced[4]).toBeGreaterThan(.2);
    expect(paced.at(-1)).toBe(.8);
  });

  it('pins every member of the ending atomic group to the exact ending phase', () => {
    const paced = reweightReplayProgress([0, 0, .13, .42, .84, .84, .84], [2], .84);
    expect(paced.slice(0, 2)).toEqual([0, 0]);
    expect(paced.slice(-3)).toEqual([.84, .84, .84]);
  });

  it('preserves monotonicity for dense events and overlapping highlights', () => {
    const base = Array.from({ length: 128 }, (_, index) => index / 127 * .84);
    const paced = reweightReplayProgress(base, [50, 51, 100], .84);
    expect(paced.every((value, index) => Number.isFinite(value) && (!index || value > paced[index - 1]))).toBe(true);
    expect(paced.at(-1)).toBe(.84);
  });

  it('does not create extra phases or progress events for opening/closing highlights', () => {
    const paced = reweightReplayProgress([0, .2, .4, .6, .84], [0, 4], .84);
    expect(paced).toHaveLength(5);
    expect(paced[0]).toBe(0);
    expect(paced.at(-1)).toBe(.84);
    expect(paced[1]).toBeGreaterThan(.2);
    expect(paced[4] - paced[3]).toBeGreaterThan(.24);
  });

  it('returns an independent unchanged sequence when there is no eligible emphasis', () => {
    const base = [0, .3, .84];
    const paced = reweightReplayProgress(base, [-1, NaN, 1.5, 100]);
    expect(paced).toEqual(base);
    expect(paced).not.toBe(base);
    expect(reweightReplayProgress(base, [])).toEqual(base);
    expect(reweightReplayProgress([], [])).toEqual([]);
    expect(reweightReplayProgress([0], [0])).toEqual([0]);
  });

  it('keeps degenerate or invalid sequences untouched rather than inventing event timing', () => {
    expect(reweightReplayProgress([0, 0, 0], [1])).toEqual([0, 0, 0]);
    expect(reweightReplayProgress([0, .4, .2], [1])).toEqual([0, .4, .2]);
    expect(reweightReplayProgress([0, NaN, .84], [1])).toEqual([0, NaN, .84]);
  });

  it('preserves a nonzero first knot and exact supplied ending', () => {
    const paced = reweightReplayProgress([.1, .3, .5, .8], [1], .8);
    expect(paced[0]).toBe(.1);
    expect(paced.at(-1)).toBe(.8);
    expect(paced.every(value => value >= .1 && value <= .8)).toBe(true);
  });

  it('is deterministic when exported frames are rendered out of order', () => {
    const base = Object.freeze([0, .1, .22, .48, .68, .84]);
    expect(reweightReplayProgress(base, [2, 4])).toEqual(reweightReplayProgress(base, [2, 4]));
    expect(reweightReplayProgress(base, [2, 2, 4])).toEqual(reweightReplayProgress(base, [4, 2]));
  });
});
