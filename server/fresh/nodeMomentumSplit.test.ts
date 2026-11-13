import { describe, expect, it, vi } from 'vitest';
import type { NodeMarketLog } from '../nodeMarketProtocols.js';
import { blockHex, RpcRequestError, type Rpc } from '../rpc.js';
import { createNodeMomentumIngest, NODE_MOMENTUM_MAX_LOGS, NODE_MOMENTUM_V3_SWAP_TOPIC, type MomentumBlock } from './nodeMomentumIngest.js';
import { NodeMomentumLogRangeLimitError } from './nodeMomentumRpc.js';

const hash = (number: number) => '0x' + number.toString(16).padStart(64, '0');
const pool = '0x' + 'b'.repeat(40);
const headers = (start: number, count: number): MomentumBlock[] => Array.from({ length: count }, (_, index) => ({
  number: start + index, hash: hash(start + index), timestamp: new Date(1_790_000_000_000 + index * 1_000).toISOString(),
}));
const log = (height: number, index: number): NodeMarketLog => ({
  address: pool, blockHash: hash(height), blockNumber: blockHex(height), logIndex: blockHex(index), transactionHash: hash(index + 50_000),
  transactionIndex: '0x0', data: '0x', topics: [NODE_MOMENTUM_V3_SWAP_TOPIC],
});

function mockRanges(read: (first: number, last: number) => unknown) {
  const calls: { first: number; last: number; address: string[] | undefined }[] = [];
  const rpc: Rpc = async <T>(method: string, params: unknown[]) => {
    expect(method).toBe('eth_getLogs');
    const [filter] = params as [{ fromBlock: string; toBlock: string; topics: string[]; address?: string[] }];
    expect(filter.topics).toEqual([NODE_MOMENTUM_V3_SWAP_TOPIC]);
    const first = Number(BigInt(filter.fromBlock)), last = Number(BigInt(filter.toBlock));
    calls.push({ first, last, address: filter.address });
    return read(first, last) as T;
  };
  return { rpc, calls };
}

describe('adaptive node momentum log ranges', () => {
  it('queries exhaustive disjoint halves with the original filter and validates them before returning coverage', async () => {
    const fixture = mockRanges((first, last) => {
      if (last - first >= 2) throw new NodeMomentumLogRangeLimitError();
      return [];
    });
    // Discovery without fixed pools has no state work for a log-free range.
    const result = await createNodeMomentumIngest(fixture.rpc).scan(headers(100, 4));
    expect(result).toMatchObject({ observations: [], coveredPools: [], stats: { logRequests: 3, logSplits: 1, logs: 0 } });
    expect(fixture.calls).toEqual([
      { first: 100, last: 103, address: undefined }, { first: 100, last: 101, address: undefined }, { first: 102, last: 103, address: undefined },
    ]);
  });

  it('accepts more aggregate logs than the per-query limit and preserves pool filter through a failed page', async () => {
    const dense = mockRanges((first, last) => first !== last ? Array(NODE_MOMENTUM_MAX_LOGS + 1).fill(log(101, 0)) :
      Array.from({ length: 2_500 }, (_, index) => log(first, index)));
    const rpc: Rpc = async <T>(method: string, params: unknown[]) => {
      if (method !== 'eth_getLogs') throw new RpcRequestError('Unrelated pool mock', 'revert');
      return dense.rpc<T>(method, params);
    };
    expect(await createNodeMomentumIngest(rpc).scan(headers(100, 2), { pools: [pool] })).toMatchObject({
      observations: [], coveredPools: [], stats: { logRequests: 3, logSplits: 1, logs: 5_000 },
    });
    expect(dense.calls.every(call => call.address?.[0] === pool)).toBe(true);
  });

  it('rejects impossible single-block and combined limits and makes no state requests', async () => {
    const single = mockRanges(() => { throw new NodeMomentumLogRangeLimitError(); });
    await expect(createNodeMomentumIngest(single.rpc).scan(headers(100, 1))).rejects.toThrow('momentum_scan_log_block_budget');
    const dense = mockRanges((first, last) => {
      if (first !== last) throw new NodeMomentumLogRangeLimitError();
      return Array.from({ length: 3_000 }, (_, index) => log(first, index));
    });
    await expect(createNodeMomentumIngest(dense.rpc).scan(headers(100, 3))).rejects.toThrow('momentum_scan_log_total_budget');
    const many = mockRanges((first, last) => {
      if (first !== last) throw new NodeMomentumLogRangeLimitError();
      return [];
    });
    await expect(createNodeMomentumIngest(many.rpc).scan(headers(100, 16))).rejects.toThrow('momentum_scan_log_request_budget');
    expect(many.calls).toHaveLength(8);
  });

  it('rejects logs outside their requested half and never treats generic failure as a size error', async () => {
    const fixture = mockRanges((first, last) => {
      if (first !== last) throw new NodeMomentumLogRangeLimitError();
      return first === 100 ? [log(101, 0)] : [];
    });
    await expect(createNodeMomentumIngest(fixture.rpc).scan(headers(100, 2))).rejects.toThrow('momentum_scan_log_noncanonical');
    expect(fixture.calls).toHaveLength(2);
    const generic = mockRanges(() => { throw new RpcRequestError('Node unavailable', 'transport'); });
    await expect(createNodeMomentumIngest(generic.rpc).scan(headers(100, 2))).rejects.toMatchObject({ category: 'transport' });
    expect(generic.calls).toHaveLength(1);
  });

  it('yields between split calls and rejects a spent time budget', async () => {
    const fixture = mockRanges((first, last) => {
      if (first !== last) throw new NodeMomentumLogRangeLimitError();
      return [];
    });
    await expect(createNodeMomentumIngest(fixture.rpc).scan(headers(100, 2), {
      shouldContinue: () => fixture.calls.length < 2,
    })).rejects.toThrow('momentum_scan_yielded');
    expect(fixture.calls).toHaveLength(2);
    const timing = vi.spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValue(5_001);
    try {
      const slow = mockRanges(() => []);
      await expect(createNodeMomentumIngest(slow.rpc).scan(headers(100, 1))).rejects.toThrow('momentum_scan_log_request_budget');
    } finally { timing.mockRestore(); }
  });
});
