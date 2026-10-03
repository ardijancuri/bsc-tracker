export async function reorgStart(checkpoints: { height: number; hash: string }[], canonicalHash: (height: number) => Promise<string | null>) {
  for (const checkpoint of [...checkpoints].sort((a, b) => b.height - a.height)) {
    const hash = await canonicalHash(checkpoint.height);
    if (!hash) throw new Error('Canonical block unavailable during reorg check');
    if (hash.toLowerCase() === checkpoint.hash.toLowerCase()) return checkpoint.height + 1;
  }
  throw new Error('No common canonical checkpoint found; indexing paused');
}
