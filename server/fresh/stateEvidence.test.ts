import { describe, expect, it, vi } from 'vitest';
import { RpcRequestError, type Rpc } from '../rpc.js';
import { createFreshStateEvidenceRpc, FRESH_STATE_EVIDENCE_MAX_BYTES, FRESH_STATE_EVIDENCE_MAX_CALLS, FRESH_STATE_EVIDENCE_MAX_DATA_BYTES,
  FRESH_STATE_EVIDENCE_MAX_RESULT_BYTES, type FreshStateReadEvidence } from './stateEvidence.js';

const block = { number: 101, hash: `0x${'a'.repeat(64)}` }, token = `0x${'b'.repeat(40)}`, data = '0x313ce567', result = `0x${'0'.repeat(62)}12`;
const request = (input = data, to = token): unknown[] => [{ to, data: input }, { blockHash: block.hash, requireCanonical: true }];
const prior = (): FreshStateReadEvidence => ({ version: 1, blockNumber: block.number, blockHash: block.hash, calls: [{ to: token, data, result }] });

describe('receipt-scoped canonical state evidence', () => {
  it('retains successful decimals when another metadata request fails and reuses them after reopening', async () => {
    const node = vi.fn(async <T>(_method: string, params: unknown[]) => {
      if ((params[0] as any).data !== data) throw new RpcRequestError('RPC eth_call unavailable', 'state_unavailable', { code: -32000 });
      return result as T;
    }) as Rpc;
    const first = createFreshStateEvidenceRpc(node, block);
    await expect(Promise.all([first.rpc('eth_call', request()), first.rpc('eth_call', request('0x18160ddd'))])).rejects.toMatchObject({ category: 'state_unavailable' });
    expect(first.writes).toBe(1); expect(first.snapshot()).toEqual(prior());
    const unavailable = vi.fn().mockRejectedValue(new RpcRequestError('RPC eth_call unavailable', 'state_unavailable')) as unknown as Rpc;
    const retry = createFreshStateEvidenceRpc(unavailable, block, JSON.parse(JSON.stringify(first.snapshot())));
    expect(await retry.rpc('eth_call', request())).toBe(result); expect(unavailable).not.toHaveBeenCalled(); expect(retry.writes).toBe(0);
    await expect(retry.rpc('eth_call', request('0x18160ddd'))).rejects.toMatchObject({ category: 'state_unavailable' });
    expect(retry.snapshot()).toEqual(prior());
  });

  it('normalizes address, calldata, block hash and raw response without losing exact bytes', async () => {
    const node = vi.fn().mockResolvedValue(result.toUpperCase()) as unknown as Rpc, scope = createFreshStateEvidenceRpc(node, block);
    const input = [{ to: token.toUpperCase(), data: data.toUpperCase() }, { blockHash: block.hash.toUpperCase(), requireCanonical: true }];
    expect(await scope.rpc('eth_call', input)).toBe(result); expect(await scope.rpc('eth_call', request())).toBe(result);
    expect(node).toHaveBeenCalledExactlyOnceWith('eth_call', request()); expect(scope.writes).toBe(1); expect(scope.snapshot()).toEqual(prior());
  });

  it('drains a successful slow sibling after another metadata read rejects early', async () => {
    let complete!: (value: string) => void;
    const slow = new Promise<string>(resolve => { complete = resolve; });
    const node = vi.fn(async <T>(_method: string, params: unknown[]) => {
      if ((params[0] as any).data !== data) throw new RpcRequestError('RPC eth_call unavailable', 'state_unavailable');
      return await slow as T;
    }) as Rpc, scope = createFreshStateEvidenceRpc(node, block);
    await expect(Promise.all([scope.rpc('eth_call', request()), scope.rpc('eth_call', request('0x18160ddd'))])).rejects.toMatchObject({ category: 'state_unavailable' });
    expect(scope.snapshot()).toBeUndefined(); const draining = scope.settle(); complete(result); await draining;
    expect(scope.snapshot()).toEqual(prior()); expect(scope.writes).toBe(1);
  });

  it('drains an immediate retry started by a failed sibling without caching its failure', async () => {
    let complete!: (value: string) => void;
    const slow = new Promise<string>(resolve => { complete = resolve; });
    const node = vi.fn().mockRejectedValueOnce(new RpcRequestError('RPC eth_call unavailable', 'transport')).mockReturnValueOnce(slow) as unknown as Rpc;
    const scope = createFreshStateEvidenceRpc(node, block);
    const caller = scope.rpc('eth_call', request()).catch(() => scope.rpc('eth_call', request()));
    const draining = scope.settle(); complete(result); await draining; expect(await caller).toBe(result);
    expect(scope.snapshot()).toEqual(prior()); expect(node).toHaveBeenCalledTimes(2);
  });

  it('coalesces identical concurrent reads and retries failures instead of caching them', async () => {
    const node = vi.fn().mockRejectedValueOnce(new RpcRequestError('RPC eth_call unavailable', 'transport')).mockResolvedValue(result) as unknown as Rpc;
    const scope = createFreshStateEvidenceRpc(node, block);
    const failed = await Promise.allSettled([scope.rpc('eth_call', request()), scope.rpc('eth_call', request())]);
    expect(failed.every(value => value.status === 'rejected')).toBe(true); expect(node).toHaveBeenCalledTimes(1); expect(scope.snapshot()).toBeUndefined();
    expect(await scope.rpc('eth_call', request())).toBe(result); expect(node).toHaveBeenCalledTimes(2); expect(scope.writes).toBe(1);
  });

  it.each([null, {}, { ...prior(), version: 2 }, { ...prior(), blockNumber: 102 }, { ...prior(), blockHash: `0x${'c'.repeat(64)}` },
    { ...prior(), unexpected: true }, { ...prior(), calls: [{ ...prior().calls[0], result: 'secret' }] }, { ...prior(), calls: [{ ...prior().calls[0], to: 'invalid' }] },
    { ...prior(), calls: [{ ...prior().calls[0], data: '0x123' }] }, { ...prior(), calls: [{ ...prior().calls[0], from: token }] },
    { ...prior(), calls: [prior().calls[0], prior().calls[0]] }, { ...prior(), calls: Array(FRESH_STATE_EVIDENCE_MAX_CALLS + 1).fill(prior().calls[0]) }])('discards invalid or foreign saved evidence %#', async value => {
    const node = vi.fn().mockResolvedValue('0x00') as unknown as Rpc, scope = createFreshStateEvidenceRpc(node, block, value);
    expect(scope.rejectedPrior).toBe(true); expect(scope.snapshot()).toBeUndefined();
    expect(await scope.rpc('eth_call', request())).toBe('0x00'); expect(node).toHaveBeenCalledTimes(1);
  });

  it('discards the entire saved set when a later entry is invalid', async () => {
    const node = vi.fn().mockResolvedValue('0x00') as unknown as Rpc;
    const scope = createFreshStateEvidenceRpc(node, block, { ...prior(), calls: [...prior().calls, { to: token, data: '0x18160ddd', result: null }] });
    expect(scope.rejectedPrior).toBe(true); expect(scope.snapshot()).toBeUndefined();
    await scope.rpc('eth_call', request()); expect(node).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['eth_getBalance', request()], ['eth_call', [request()[0], 'latest']], ['eth_call', [request()[0], '0x65']],
    ['eth_call', [request()[0], { blockHash: block.hash, requireCanonical: false }]],
    ['eth_call', [request()[0], { blockHash: `0x${'c'.repeat(64)}`, requireCanonical: true }]],
    ['eth_call', [request()[0], { blockHash: block.hash, requireCanonical: true, blockNumber: '0x65' }]],
    ['eth_call', [{ to: token, data, from: token }, request()[1]]], ['eth_call', [...request(), {}]],
    ['eth_call', [{ to: token, data: `0x${'00'.repeat(FRESH_STATE_EVIDENCE_MAX_DATA_BYTES + 1)}` }, request()[1]]],
  ])('rejects requests outside the captured canonical context %#', async (method, params) => {
    const node = vi.fn().mockResolvedValue(result) as unknown as Rpc, scope = createFreshStateEvidenceRpc(node, block, prior());
    await expect(scope.rpc(method as string, params as unknown[])).rejects.toMatchObject({ message: 'state_evidence_request_invalid', category: 'invalid_response' });
    expect(node).not.toHaveBeenCalled(); expect(scope.snapshot()).toEqual(prior());
  });

  it.each([null, 1, {}, '0x123', 'not hex'])('does not cache malformed node success %#', async value => {
    const node = vi.fn().mockResolvedValue(value) as unknown as Rpc, scope = createFreshStateEvidenceRpc(node, block);
    await expect(scope.rpc('eth_call', request())).rejects.toMatchObject({ category: 'invalid_response' });
    expect(scope.snapshot()).toBeUndefined(); expect(scope.writes).toBe(0);
  });

  it('preserves early evidence without eviction when the count budget fills', async () => {
    const node = vi.fn().mockResolvedValue(result) as unknown as Rpc, scope = createFreshStateEvidenceRpc(node, block);
    for (let index = 0; index < FRESH_STATE_EVIDENCE_MAX_CALLS + 2; index++) await scope.rpc('eth_call', request(`0x${index.toString(16).padStart(8, '0')}`));
    expect(scope.writes).toBe(FRESH_STATE_EVIDENCE_MAX_CALLS); expect(scope.snapshot()?.calls).toHaveLength(FRESH_STATE_EVIDENCE_MAX_CALLS);
    await scope.rpc('eth_call', request('0x00000000')); expect(node).toHaveBeenCalledTimes(FRESH_STATE_EVIDENCE_MAX_CALLS + 2);
  });

  it('bounds serialized bytes and refuses oversized saved proof while still returning uncached valid node results', async () => {
    const large = `0x${'ab'.repeat(FRESH_STATE_EVIDENCE_MAX_RESULT_BYTES)}`, node = vi.fn().mockResolvedValue(large) as unknown as Rpc;
    const scope = createFreshStateEvidenceRpc(node, block);
    for (let index = 0; index < 8; index++) expect(await scope.rpc('eth_call', request(`0x${index.toString(16).padStart(8, '0')}`))).toBe(large);
    const evidence = scope.snapshot()!; expect(scope.writes).toBeGreaterThan(0); expect(scope.writes).toBeLessThan(8);
    expect(Buffer.byteLength(JSON.stringify(evidence))).toBeLessThanOrEqual(FRESH_STATE_EVIDENCE_MAX_BYTES);
    const oversized = { ...prior(), calls: Array.from({ length: 8 }, (_, index) => ({ to: token, data: `0x${index.toString(16).padStart(8, '0')}`, result: large })) };
    expect(createFreshStateEvidenceRpc(node, block, oversized).rejectedPrior).toBe(true);
    const hugeNode = vi.fn().mockResolvedValue(`${large}ff`) as unknown as Rpc, uncached = createFreshStateEvidenceRpc(hugeNode, block);
    expect(await uncached.rpc('eth_call', request())).toBe(`${large}ff`); expect(uncached.snapshot()).toBeUndefined();
  });

  it('keeps snapshots detached from cached proof and preserves valid empty raw responses', async () => {
    const node = vi.fn().mockResolvedValue('0x') as unknown as Rpc, scope = createFreshStateEvidenceRpc(node, block);
    expect(await scope.rpc('eth_call', request())).toBe('0x'); const snapshot = scope.snapshot()!;
    snapshot.calls[0].result = result; snapshot.calls.push({ to: token, data: '0x18160ddd', result });
    expect(await scope.rpc('eth_call', request())).toBe('0x'); expect(scope.snapshot()?.calls).toHaveLength(1);
  });

  it.each([{ number: -1, hash: block.hash }, { number: 1.5, hash: block.hash }, { number: Number.MAX_SAFE_INTEGER + 1, hash: block.hash },
    { number: 101, hash: 'latest' }])('rejects an invalid captured block %#', value => {
    expect(() => createFreshStateEvidenceRpc(vi.fn() as unknown as Rpc, value)).toThrow('state_evidence_block_invalid');
  });
});
