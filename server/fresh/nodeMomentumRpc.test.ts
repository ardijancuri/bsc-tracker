import { describe, expect, it, vi } from 'vitest';
import { createNodeMomentumRpc, NodeMomentumLogRangeLimitError } from './nodeMomentumRpc.js';

describe('bounded node momentum transport', () => {
  it('uses the loopback node with a bounded deadline and matches batch results by ID', async () => {
    const fetchRpc = vi.fn<typeof fetch>(async (_url, init) => {
      const rows = JSON.parse(String(init?.body)) as { id: number }[];
      expect(init?.redirect).toBe('error');
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return Response.json([
        { jsonrpc: '2.0', id: rows[1].id, result: { number: '0x2' } },
        { jsonrpc: '2.0', id: 999, result: 'foreign' },
        { jsonrpc: '2.0', id: rows[0].id, result: '0x1' },
      ]);
    });
    const rpc = createNodeMomentumRpc('http://127.0.0.1:18545', { fetch: fetchRpc });
    expect(await rpc.batch!([{ method: 'eth_blockNumber', params: [] }, { method: 'eth_getBlockByNumber', params: ['0x2', false] }])).toEqual([
      { status: 'fulfilled', value: '0x1' }, { status: 'fulfilled', value: { number: '0x2' } },
    ]);
    expect(rpc.stats()).toMatchObject({ requests: 1, calls: 2 });
    expect(rpc.stats().responseBytes).toBeGreaterThan(0);
  });

  it('rejects duplicate IDs, foreign or malformed responses, and methods outside the worker scope', async () => {
    const rpc = createNodeMomentumRpc(undefined, { fetch: async (_url, init) => {
      const rows = JSON.parse(String(init?.body)) as { id: number }[];
      return Response.json([{ jsonrpc: '2.0', id: rows[0].id, result: 'valid' },
        { jsonrpc: '2.0', id: rows[0].id, result: 'duplicate' }, { jsonrpc: '1.0', id: rows[1].id, result: 'wrong' }]);
    } });
    const calls = [{ method: 'eth_blockNumber', params: [] }, { method: 'eth_call', params: [] }];
    expect((await rpc.batch!(calls)).map(row => row.status)).toEqual(['rejected', 'rejected']);
    await expect(rpc.batch!(Array(33).fill(calls[0]))).rejects.toThrow('momentum_rpc_request_invalid');
    await expect(rpc('eth_sendRawTransaction', [])).rejects.toThrow('momentum_rpc_request_invalid');
    expect(() => createNodeMomentumRpc('https://other.test')).toThrow('momentum_rpc_endpoint_invalid');
  });

  it('cancels oversized responses before JSON decode and permits one in-flight request', async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(4 * 1024 * 1024 + 1)); }, cancel });
    const fetchRpc = vi.fn<typeof fetch>().mockResolvedValue(new Response(stream));
    const rpc = createNodeMomentumRpc(undefined, { fetch: fetchRpc });
    const request = rpc('eth_getLogs', []);
    await expect(rpc('eth_blockNumber', [])).rejects.toThrow('momentum_rpc_busy');
    await expect(request).rejects.toBeInstanceOf(NodeMomentumLogRangeLimitError);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(fetchRpc).toHaveBeenCalledTimes(1);
  });

  it('exposes sanitized historical-state errors to the quote decoder', async () => {
    const rpc = createNodeMomentumRpc(undefined, { fetch: async (_url, init) => {
      const { id } = JSON.parse(String(init?.body)) as { id: number };
      return Response.json({ jsonrpc: '2.0', id, error: { code: -32000, message: 'missing trie node at private details' } });
    } });
    await expect(rpc('eth_call', [])).rejects.toMatchObject({ category: 'state_unavailable', message: 'Momentum node request failed' });
  });

  it('classifies explicit node getLogs limits without treating generic RPC errors as size limits', async () => {
    const fetchRpc = vi.fn<typeof fetch>(async (_url, init) => {
      const { id, method } = JSON.parse(String(init?.body)) as { id: number; method: string };
      return Response.json({ jsonrpc: '2.0', id, error: { code: -32005,
        message: method === 'eth_getLogs' ? 'query returned more than 10000 results' : 'Too many requests' } });
    });
    const rpc = createNodeMomentumRpc(undefined, { fetch: fetchRpc });
    await expect(rpc('eth_getLogs', [])).rejects.toBeInstanceOf(NodeMomentumLogRangeLimitError);
    await expect(rpc('eth_call', [])).rejects.toMatchObject({ category: 'rate_limit' });
    const http = createNodeMomentumRpc(undefined, { fetch: async () => new Response(null, { status: 413 }) });
    await expect(http('eth_getLogs', [])).rejects.toBeInstanceOf(NodeMomentumLogRangeLimitError);
    await expect(http('eth_call', [])).rejects.toMatchObject({ httpStatus: 413 });
  });
});
