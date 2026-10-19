/** The node's full block retention is much longer than its usable state
 * retention. Optional retries against an old checkpoint must yield to capture. */
export function nodeCaptureHasPriority(checkpoint: unknown): boolean {
  if (!checkpoint || typeof checkpoint !== 'object') return false;
  const { blockNumber, headBlock } = checkpoint as { blockNumber?: unknown; headBlock?: unknown };
  return typeof blockNumber === 'number' && typeof headBlock === 'number'
    && Number.isSafeInteger(blockNumber) && Number.isSafeInteger(headBlock)
    && blockNumber >= 0 && headBlock >= blockNumber && headBlock - blockNumber > 128;
}

export function nodeMetadataShouldDrain(checkpoint: unknown, usableFreshWork: boolean): boolean {
  return !nodeCaptureHasPriority(checkpoint) || usableFreshWork;
}

export function nodeCaptureRepairAllowed(nextBlock: number, confirmedTarget: number): boolean {
  return Number.isSafeInteger(nextBlock) && Number.isSafeInteger(confirmedTarget)
    && nextBlock >= 0 && confirmedTarget >= 0 && confirmedTarget - nextBlock + 1 <= 128;
}
