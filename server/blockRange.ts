export type ChainBlock = { number: string; hash: string; parentHash: string };

export async function readBlockRange<T extends ChainBlock>(from: number, to: number, load: (height: number) => Promise<T | null>, previousHash?: string): Promise<T[]> {
  const blocks: T[] = new Array(Math.max(0, to - from + 1));
  let next = from, validated = 0, failure: { error: unknown } | undefined;
  // Refill each completed slot immediately instead of waiting for the slowest
  // request in a wave. Keep the same maximum of sixteen active node requests.
  const worker = async () => {
    while (!failure && next <= to) {
      const height = next++;
      try {
        const block = await load(height);
        if (failure) return;
        if (!block || Number(BigInt(block.number)) !== height) throw new Error(`Missing or incorrect block ${height}`);
        blocks[height - from] = block;
        // Responses may arrive out of order; authenticate only the contiguous
        // ready prefix and always return the original block-number ordering.
        while (blocks[validated]) {
          const current = blocks[validated], parent = validated ? blocks[validated - 1].hash : previousHash;
          if (parent && parent.toLowerCase() !== current.parentHash.toLowerCase()) throw new Error(`Parent hash mismatch at ${from + validated}`);
          validated++;
        }
      } catch (error) { failure ??= { error }; }
    }
  };
  // A failed request stops further dispatch. Settle the other bounded requests
  // before returning the failure so a retry cannot overlap an abandoned wave.
  await Promise.all(Array.from({ length: Math.min(16, blocks.length) }, worker));
  if (failure) throw failure.error;
  return blocks;
}
