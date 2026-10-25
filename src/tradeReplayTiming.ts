export const tradeReplayFrameRate = 30;
export const tradeReplayEndHoldSeconds = 1.5;
export const tradeReplayViewportSeconds = 10;

export interface TradeReplayTiming {
  durationSeconds: number;
  activePhase: number;
  storyWindow: number;
  /** Unclamped so genuine observations and axis ticks can precede the first fill. */
  progressAtTime(timestamp: number): number;
  /** The inverse time scale; the renderer owns playback and ending-hold clamping. */
  timeAtProgress(progress: number): number;
}

/** One chronological scale for the complete position, independent of prices and sizes. */
export function createTradeReplayTiming(start: number, end: number, eventTimes: readonly number[] = []): TradeReplayTiming {
  const span = end - start;
  if (!Number.isFinite(start) || !Number.isFinite(end) || !Number.isFinite(span) || span < 0) {
    throw new RangeError('Replay timing requires finite, ordered timestamps');
  }
  const groups = new Set(eventTimes.filter(time => Number.isFinite(time) && time >= start && time <= end)).size;
  const spanMinutes = span / 60_000;
  const activeSeconds = Math.min(23.5, Math.max(3.5,
    3.5 + 2.5 * Math.log2(1 + spanMinutes),
    1.35 + 0.3 * (groups - 1)));
  const durationSeconds = Math.round((activeSeconds + tradeReplayEndHoldSeconds) * tradeReplayFrameRate) / tradeReplayFrameRate;
  const activePhase = span > 0 ? (durationSeconds - tradeReplayEndHoldSeconds) / durationSeconds : 0;
  return {
    durationSeconds,
    activePhase,
    storyWindow: tradeReplayViewportSeconds / durationSeconds,
    progressAtTime: timestamp => span > 0 ? (timestamp - start) / span * activePhase : 0,
    timeAtProgress: progress => span > 0 ? start + progress / activePhase * span : start,
  };
}
