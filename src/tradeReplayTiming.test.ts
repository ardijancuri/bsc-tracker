import { describe, expect, it } from 'vitest';
import { createTradeReplayTiming, tradeReplayEndHoldSeconds, tradeReplayFrameRate, tradeReplayViewportSeconds } from './tradeReplayTiming';

const start = Date.parse('2026-10-25T12:00:00.000Z');
const minute = 60_000;

describe('adaptive chronological replay timing', () => {
  it('gives longer positions longer videos within the requested five-to-twenty-five-second range', () => {
    const minutes = [0, 1 / 6, 1, 5, 60, 24 * 60];
    const durations = minutes.map(span => createTradeReplayTiming(start, start + span * minute).durationSeconds);
    expect(durations[0]).toBe(5);
    expect(durations[2]).toBe(7.5);
    expect(durations[3]).toBeCloseTo(11.4666666667, 8);
    expect(durations[4]).toBeCloseTo(19.8333333333, 8);
    expect(durations.at(-1)).toBe(25);
    for (let index = 1; index < durations.length; index++) expect(durations[index]).toBeGreaterThan(durations[index - 1]);
    expect(createTradeReplayTiming(start, start + 365 * 24 * 60 * minute).durationSeconds).toBe(25);
  });

  it('allocates a bounded whole-video readability floor for distinct movement timestamps', () => {
    const end = start + minute;
    const events = Array.from({ length: 30 }, (_, index) => start + index * 1000);
    const sparse = createTradeReplayTiming(start, end, [start, end]);
    const dense = createTradeReplayTiming(start, end, events);
    expect(dense.durationSeconds).toBeGreaterThan(sparse.durationSeconds);
    // The denser video still has the same chronological ratio between unequal gaps.
    expect(dense.progressAtTime(start + 30_000)).toBeCloseTo(dense.activePhase / 2, 12);
    const veryDense = createTradeReplayTiming(start, end, Array.from({ length: 1000 }, (_, index) => start + index * 50));
    expect(veryDense.durationSeconds).toBe(25);
  });

  it('counts simultaneous movements once and ignores invalid or out-of-window evidence', () => {
    const end = start + minute;
    const events = [start, start + 30_000, end];
    const noisy = [...events, ...Array(500).fill(start + 30_000), NaN, Infinity, -Infinity, start - 1, end + 1];
    const original = [...noisy];
    const expected = createTradeReplayTiming(start, end, events);
    const actual = createTradeReplayTiming(start, end, noisy);
    expect(actual.durationSeconds).toBe(expected.durationSeconds);
    expect(actual.activePhase).toBe(expected.activePhase);
    expect(actual.progressAtTime(start + 30_000)).toBe(expected.progressAtTime(start + 30_000));
    expect(noisy).toEqual(original);
  });

  it('uses one linear scale through quiet gaps, dense activity and midnight', () => {
    const from = Date.parse('2026-10-25T23:58:00Z'), to = Date.parse('2026-10-26T01:03:00Z');
    const timing = createTradeReplayTiming(from, to, [from, from + 1000, from + minute, to]);
    const step = 37_000;
    const progressStep = timing.progressAtTime(from + step) - timing.progressAtTime(from);
    for (const offset of [0, 1000, minute, 40 * minute]) {
      expect(timing.progressAtTime(from + offset + step) - timing.progressAtTime(from + offset)).toBeCloseTo(progressStep, 12);
    }
    for (const timestamp of [from, from + 1000, Date.parse('2026-10-26T00:00:00Z'), to]) {
      expect(timing.timeAtProgress(timing.progressAtTime(timestamp))).toBe(timestamp);
    }
    expect(timing.progressAtTime(from)).toBe(0);
    expect(timing.progressAtTime(to)).toBe(timing.activePhase);
  });

  it('keeps prehistory and future axis context on the same inverse scale', () => {
    const end = start + 10 * minute, timing = createTradeReplayTiming(start, end, [start, end]);
    expect(timing.progressAtTime(start - minute)).toBeLessThan(0);
    expect(timing.progressAtTime(end + minute)).toBeGreaterThan(timing.activePhase);
    for (const timestamp of [start - 2 * minute, start, start + 13_457, end, end + 2 * minute]) {
      expect(timing.timeAtProgress(timing.progressAtTime(timestamp))).toBe(timestamp);
    }
  });

  it('keeps horizontal chart movement at the same pixels per playback second across video lengths', () => {
    const plotWidth = 772;
    const speeds = [minute / 6, minute, 30 * minute, 24 * 60 * minute].map(span => {
      const timing = createTradeReplayTiming(start, start + span, [start, start + span]);
      const before = 1 / timing.durationSeconds;
      const after = 2 / timing.durationSeconds;
      return (after - before) / timing.storyWindow * plotWidth;
    });
    for (const speed of speeds) expect(speed).toBeCloseTo(plotWidth / tradeReplayViewportSeconds, 12);
  });

  it('quantizes frame count and keeps the ending hold at a fixed presentation duration', () => {
    for (const span of [1, 53_123, minute, 5 * minute, 73 * minute, 365 * 24 * 60 * minute]) {
      const timing = createTradeReplayTiming(start, start + span);
      expect(timing.durationSeconds).toBeGreaterThanOrEqual(5);
      expect(timing.durationSeconds).toBeLessThanOrEqual(25);
      expect(timing.durationSeconds * tradeReplayFrameRate).toBeCloseTo(Math.round(timing.durationSeconds * tradeReplayFrameRate), 10);
      expect((1 - timing.activePhase) * timing.durationSeconds).toBeCloseTo(tradeReplayEndHoldSeconds, 12);
    }
  });

  it('keeps a zero-span position static instead of inventing time or future history', () => {
    const timing = createTradeReplayTiming(start, start, Array(100).fill(start));
    expect(timing.durationSeconds).toBe(5);
    expect(timing.activePhase).toBe(0);
    expect(timing.storyWindow).toBe(2);
    for (const timestamp of [start - minute, start, start + minute]) expect(timing.progressAtTime(timestamp)).toBe(0);
    for (const progress of [-1, 0, 0.5, 1, 2]) expect(timing.timeAtProgress(progress)).toBe(start);
  });

  it.each([[NaN, start], [start, Infinity], [-Infinity, start], [start, start - 1], [-Number.MAX_VALUE, Number.MAX_VALUE]])
    ('rejects an invalid approved window %s–%s', (from, to) => {
      expect(() => createTradeReplayTiming(from, to)).toThrow('finite, ordered');
    });
});
