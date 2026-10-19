import { describe, expect, it } from 'vitest';
import { nodeCaptureHasPriority, nodeCaptureRepairAllowed, nodeMetadataShouldDrain } from './nodeCaptureScheduling.js';

describe('capture priority over unavailable historical state', () => {
  it('defers old metadata beyond128blocks while preserving fresh work', () => {
    const catchup = { blockNumber: 1000, headBlock: 2000 };
    expect(nodeMetadataShouldDrain(catchup, false)).toBe(false);
    expect(nodeMetadataShouldDrain(catchup, true)).toBe(true);
  });
  it('keeps metadata active at the usable-state boundary', () => {
    expect(nodeCaptureHasPriority({ blockNumber: 1000, headBlock: 1128 })).toBe(false);
    expect(nodeCaptureHasPriority({ blockNumber: 1000, headBlock: 1129 })).toBe(true);
    expect(nodeMetadataShouldDrain({ blockNumber: 1000, headBlock: 1128 }, false)).toBe(true);
  });
  it.each([undefined, {}, { blockNumber: '1000', headBlock: 2000 }, { blockNumber: 2000, headBlock: 1000 },
    { blockNumber: -1, headBlock: 2000 }, { blockNumber: 1, headBlock: Infinity }])('does not invent lag from invalid checkpoint%j', checkpoint => {
    expect(nodeCaptureHasPriority(checkpoint)).toBe(false);
  });
  it('runs registration repairs near the head and retains distant repairs for later', () => {
    expect(nodeCaptureRepairAllowed(1000, 1127)).toBe(true);
    expect(nodeCaptureRepairAllowed(1000, 1128)).toBe(false);
    expect(nodeCaptureRepairAllowed(1129, 1128)).toBe(true);
    expect(nodeCaptureRepairAllowed(-1, 1128)).toBe(false);
  });
});
