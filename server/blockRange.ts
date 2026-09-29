export type ChainBlock = { number: string; hash: string; parentHash: string };

export async function readBlockRange<T extends ChainBlock>(from: number, to: number, load: (height: number) => Promise<T | null>, previousHash?: string): Promise<T[]> {
  const blocks: T[] = [];
  for (let start = from; start <= to; start += 16) {
    const heights = Array.from({ length: Math.min(16, to - start + 1) }, (_, index) => start + index);
    const batch = await Promise.all(heights.map(load));
    for (let index = 0; index < batch.length; index++) {
      const block = batch[index];
      const height = heights[index];
      if (!block || Number(BigInt(block.number)) !== height) throw new Error(`Missing or incorrect block ${height}`);
      const parent = blocks.at(-1)?.hash ?? previousHash;
      if (parent && parent.toLowerCase() !== block.parentHash.toLowerCase()) throw new Error(`Parent hash mismatch at ${height}`);
      blocks.push(block);
    }
  }
  return blocks;
}
