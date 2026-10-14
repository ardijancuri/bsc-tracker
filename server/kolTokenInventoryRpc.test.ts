import { describe, expect, it, vi } from 'vitest';
import { createInventoryRpc } from './kolTokenInventoryRpc.js';
const signal = () => AbortSignal.timeout(5000);
const response = (result: unknown) => new Response(JSON.stringify({ result }));
const missing = () => new Response(JSON.stringify({ error: { code: -32000, message: 'header not found' } }));
describe('inventory historical RPC', () => {
  it('uses the local node without extra archive requests when available', async () => {
    const request = vi.fn(async () => response('0x10'));
    expect(await createInventoryRpc({ request, primary: () => 'local', archive: () => 'archive' })('eth_blockNumber', [], signal())).toBe('0x10');
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('classifies pruned history distinctly rather than retrying it as busy forever', async () => {
    const rpc = createInventoryRpc({ request: vi.fn(async () => missing()), archive: () => '' });
    await expect(rpc('eth_getLogs', [{}], signal())).rejects.toThrow('inventory_history_unavailable');
  });
  it('uses a chain-checked archive for missing historical headers and receipts', async () => {
    const request = vi.fn(async (url: any, options: any) => {
      const { method } = JSON.parse(options.body);
      return url === 'local' ? response(null) : response(method === 'eth_chainId' ? '0x38' : { blockHash: 'canonical' });
    });
    const rpc = createInventoryRpc({ request, primary: () => 'local', archive: () => 'archive' });
    expect(await rpc('eth_getTransactionReceipt', ['tx'], signal())).toEqual({ blockHash: 'canonical' });
    await rpc('eth_getBlockByNumber', ['0x10', false], signal());
    expect(request.mock.calls.filter(([, options]) => JSON.parse(options.body).method === 'eth_chainId')).toHaveLength(1);
  });
  it('rejects a different chain and cools down unavailable archives', async () => {
    const request = vi.fn(async (url: any) => url === 'local' ? missing() : response('0x1'));
    const rpc = createInventoryRpc({ request, primary: () => 'local', archive: () => 'archive' });
    for (let i = 0; i < 2; i++) await expect(rpc('eth_getLogs', [{}], signal())).rejects.toThrow('inventory_history_unavailable');
    expect(request.mock.calls.filter(([url]) => url === 'archive')).toHaveLength(1);
  });
  it('does not fail over unrelated errors, current head reads or cancellation', async () => {
    for (const [method, result] of [['eth_blockNumber', missing()], ['eth_call', new Response('{}', { status: 503 })]] as const) {
      const request = vi.fn(async () => result);
      const rpc = createInventoryRpc({ request, primary: () => 'local', archive: () => 'archive' });
      await expect(rpc(method, [], signal())).rejects.toThrow();
      expect(request).toHaveBeenCalledTimes(1);
    }
    const request = vi.fn(async () => missing()), rpc = createInventoryRpc({ request, archive: () => 'archive' });
    await expect(rpc('eth_getLogs', [{}], AbortSignal.abort())).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('lets the scanner shrink an archive log window without cooling down the archive', async () => {
    const request = vi.fn(async (url: any, options: any) => {
      const { method, params } = JSON.parse(options.body);
      if (url === 'local') return missing();
      if (method === 'eth_chainId') return response('0x38');
      return params[0].toBlock === '0xffff' ? new Response(JSON.stringify({ error: { message: 'block range is too large' } })) : response([]);
    });
    const rpc = createInventoryRpc({ request, primary: () => 'local', archive: () => 'archive' });
    await expect(rpc('eth_getLogs', [{ toBlock: '0xffff' }], signal())).rejects.toThrow('inventory_range_too_large');
    await expect(rpc('eth_getLogs', [{ toBlock: '0x20' }], signal())).resolves.toEqual([]);
  });
});
