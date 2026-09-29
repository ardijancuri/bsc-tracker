import { describe, expect, it } from 'vitest';
import { readBlockRange } from './blockRange.js';

const block = (height: number) => ({ number: `0x${height.toString(16)}`, hash: `hash-${height}`, parentHash: `hash-${height - 1}` });

describe('block replay range', () => {
  it('reads the entire range in order across concurrent batches', async () => {
    const blocks = await readBlockRange(10, 45, async height => block(height), 'hash-9');
    expect(blocks.map(b => Number(BigInt(b.number)))).toEqual(Array.from({ length: 36 }, (_, i) => i + 10));
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
