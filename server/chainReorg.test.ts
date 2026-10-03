import { expect, it } from 'vitest';
import { reorgStart } from './chainReorg.js';
it('rolls back to the actual fork, including forks deeper than twelve blocks', async () => {
  const checkpoints = Array.from({ length: 40 }, (_, i) => ({ height: 100 + i, hash: `old${i}` }));
  expect(await reorgStart(checkpoints, async height => height <= 105 ? `old${height - 100}` : `new${height}`)).toBe(106);
});
it('does not erase state when the node cannot establish a canonical ancestor', async () => {
  await expect(reorgStart([{ height: 1, hash: 'old' }], async () => null)).rejects.toThrow('unavailable');
  await expect(reorgStart([{ height: 1, hash: 'old' }], async () => 'new')).rejects.toThrow('No common');
});
