const MINUTE = 60_000;
export const MIN_TRADE_REPLAY_SECONDS = 8;
export const MAX_TRADE_REPLAY_SECONDS = 25;
export const REPLAY_ENDING_HOLD_SECONDS = 2;
export const REPLAY_CURRENT_HOLD_SECONDS = 1;

// Real elapsed time, compressed smoothly for sharing. Interpolation in log
// time gives minutes, hours and days useful screen time without long jumps
// at a bucket boundary. Candle padding and financial values are not inputs.
const durationStops = [
  [0, 8], [0.5, 8], [2, 9], [10, 11], [60, 14],
  [360, 17], [1440, 20], [4320, 23], [10080, 25],
] as const;

export function tradeReplayDuration(startMs: number, endMs: number, eventCount = 0): number {
  const elapsed = Number.isFinite(startMs) && Number.isFinite(endMs) && endMs >= startMs
    ? (endMs - startMs) / MINUTE : 0;
  let seconds = MAX_TRADE_REPLAY_SECONDS;
  for (let i = 1; i < durationStops.length; i++) {
    const [to, high] = durationStops[i], [from, low] = durationStops[i - 1];
    if (elapsed > to) continue;
    const fraction = (Math.log1p(elapsed) - Math.log1p(from)) / (Math.log1p(to) - Math.log1p(from));
    seconds = low + (high - low) * Math.max(0, Math.min(1, fraction));
    break;
  }
  // A burst of many executions must still be readable. Atomic ledger groups
  // count once at the call site; money, profit and price swings cannot alter
  // the duration or stretch an individual sale's timeline.
  const count = Number.isFinite(eventCount) ? Math.max(0, eventCount) : 0;
  const readingTime = MIN_TRADE_REPLAY_SECONDS + Math.min(12, 1.1 * Math.sqrt(Math.max(0, count - 2)));
  return Math.min(MAX_TRADE_REPLAY_SECONDS, Math.ceil(Math.max(seconds, readingTime) * 2) / 2);
}
