import { describe, expect, it } from 'vitest';
import { readBlockRange } from './blockRange.js';

const block = (height: number) => ({ number: `0x${height.toString(16)}`, hash: `hash-${height}`, parentHash: `hash-${height - 1}` });

describe('block replay range', () => {
  it('reads the entire range in order across concurrent batches', async () => {
    const blocks = await readBlockRange(10, 45, async height => block(height), 'hash-9');
    expect(blocks.map(b => Number(BigInt(b.number)))).toEqual(Array.from({ length: 36 }, (_, i) => i + 10));
  });

  it('refills sixteen rolling slots despite an earlier slow response and preserves authentic order', async () => {
    let releaseFirst!: () => void;
    const first = new Promise<void>(resolve => { releaseFirst = resolve; });
    let active = 0, peak = 0, firstPending = true, refilledBeforeFirst = false;
    const blocks = await readBlockRange(10, 60, async height => {
      active++; peak = Math.max(peak, active);
      if (height === 10) { await first; firstPending = false; }
      if (height === 26) { refilledBeforeFirst = firstPending; releaseFirst(); }
      await Promise.resolve(); active--;
      return block(height);
    }, 'hash-9');
    expect(refilledBeforeFirst).toBe(true); expect(peak).toBe(16); expect(active).toBe(0);
    expect(blocks.map(value => Number(BigInt(value.number)))).toEqual(Array.from({ length: 51 }, (_, index) => 10 + index));
  });

  it('stops dispatch after the first failure and settles all already active requests before rejecting', async () => {
    let releaseOthers!: () => void, reportFailure!: () => void;
    const others = new Promise<void>(resolve => { releaseOthers = resolve; });
    const failed = new Promise<void>(resolve => { reportFailure = resolve; });
    const dispatched: number[] = [], completed: number[] = [];
    let settled = false;
    const outcome = readBlockRange(10, 100, async height => {
      dispatched.push(height);
      if (height === 10) { await Promise.resolve(); reportFailure(); throw new Error('node transport failed'); }
      await others; completed.push(height); return block(height);
    }).then(() => { settled = true; return null; }, error => { settled = true; return error as Error; });
    await failed;
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(dispatched).toHaveLength(16); expect(settled).toBe(false);
    releaseOthers();
    expect((await outcome)?.message).toBe('node transport failed');
    expect(dispatched).toHaveLength(16); expect(completed).toHaveLength(15);
  });

  it('rejects a missing block instead of advancing past it', async () => {
    await expect(readBlockRange(10, 45, async height => height === 27 ? null : block(height)))
      .rejects.toThrow('Missing or incorrect block 27');
  });

  it('rejects an incorrect returned height', async () => {
    await expect(readBlockRange(10, 12, async height => block(height === 11 ? 12 : height)))
      .rejects.toThrow('Missing or incorrect block 11');
  });

  it('checks the previous checkpoint and parent continuity across batches', async () => {
    await expect(readBlockRange(10, 45, async height => block(height), 'different-chain'))
      .rejects.toThrow('Parent hash mismatch at 10');
    await expect(readBlockRange(10, 45, async height => height === 26 ? { ...block(height), parentHash: 'different-chain' } : block(height)))
      .rejects.toThrow('Parent hash mismatch at 26');
  });
});
