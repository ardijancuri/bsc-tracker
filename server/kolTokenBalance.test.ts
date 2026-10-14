import { afterEach, describe, expect, it, vi } from 'vitest';
import { createKolTokenBalance } from './kolTokenBalance.js';

const wallet = '0xbf004bff64725914ee36d03b87d6965b0ced4903';
const token = '0x2403e4fe48fbfa0d3f21e7d5b0e0d8353a117777';
const now = Date.parse('2026-10-15T12:00:00Z');
const hash = `0x${'ab'.repeat(32)}`;
const word = (value: bigint) => `0x${value.toString(16).padStart(64, '0')}`;
const hex = (value: number) => `0x${value.toString(16)}`;
const rawBalance = 123456789123456789123456789n;
const block = () => ({ number: '0x64', hash, timestamp: hex(now / 1000 - 3) });
function fixture(overrides: Partial<Record<string, unknown>> = {}) {
  return vi.fn(async (method: string, params: unknown[], _signal: AbortSignal): Promise<unknown> => {
    if (method in overrides) return overrides[method];
    if (method === 'eth_chainId') return '0x38';
    if (method === 'eth_blockNumber') return '0x6a';
    if (method === 'eth_getBlockByNumber') return block();
    if (method === 'eth_call') return (params[0] as { data: string }).data === '0x313ce567' ? word(18n) : word(rawBalance);
    throw new Error('unexpected RPC method');
  });
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers(); });

describe('current confirmed token balance proof', () => {
  it('reads the exact same confirmed block on BSC and preserves all decimal digits', async () => {
    const rpc = fixture();
    expect(await createKolTokenBalance({ rpc, now: () => now })({ wallet: wallet.toUpperCase(), token, decimals: 18 })).toEqual({
      walletAddress: wallet, tokenAddress: token, chain: 'bsc', blockNumber: '100', blockHash: hash, blockTimestamp: '2026-10-15T11:59:57.000Z',
      balance: '123456789.123456789123456789', checkedAt: '2026-10-15T12:00:00.000Z',
    });
    expect(rpc.mock.calls.filter(([method]) => method === 'eth_getBlockByNumber')).toEqual([
      ['eth_getBlockByNumber', ['0x64', false], expect.any(AbortSignal)],
      ['eth_getBlockByNumber', ['0x64', false], expect.any(AbortSignal)],
    ]);
    expect(rpc.mock.calls.filter(([method]) => method === 'eth_call')).toEqual([
      ['eth_call', [{ to: token, data: '0x313ce567' }, '0x64'], expect.any(AbortSignal)],
      ['eth_call', [{ to: token, data: `0x70a08231${wallet.slice(2).padStart(64, '0')}` }, '0x64'], expect.any(AbortSignal)],
    ]);
    expect(new Set(rpc.mock.calls.map(([, , signal]) => signal)).size).toBe(1);
  });

  it.each([0, 18, 36])('correctly formats a zero balance with %i decimals', async decimals => {
    const rpc = fixture();
    const read = async (method: string, params: unknown[], signal: AbortSignal) => method === 'eth_call'
      ? (params[0] as { data: string }).data === '0x313ce567' ? word(BigInt(decimals)) : word(0n) : rpc(method, params, signal);
    expect(await createKolTokenBalance({ rpc: read, now: () => now })({ wallet, token })).toMatchObject({ balance: '0' });
  });

  it('rejects another chain before attempting token balance calls', async () => {
    const rpc = fixture({ eth_chainId: '0x1' });
    await expect(createKolTokenBalance({ rpc, now: () => now })({ wallet, token })).rejects.toThrow('balance_chain_mismatch');
    expect(rpc.mock.calls.some(([method]) => method === 'eth_call')).toBe(false);
  });

  it.each(['0x', '0x01', '-1', 100, '0x20000000000000', '0x5'])('rejects an invalid/unconfirmed head %s', async head => {
    await expect(createKolTokenBalance({ rpc: fixture({ eth_blockNumber: head }), now: () => now })({ wallet, token })).rejects.toThrow('balance_block_invalid');
  });

  it.each([null, { ...block(), number: '0x65' }, { ...block(), hash: '0xinvalid' }, { ...block(), timestamp: 'yesterday' }])('rejects a corrupt block header', async value => {
    await expect(createKolTokenBalance({ rpc: fixture({ eth_getBlockByNumber: value }), now: () => now })({ wallet, token })).rejects.toThrow('balance_block_invalid');
  });

  it.each([[-181, 'balance_block_stale'], [1, 'balance_block_future']] as const)('rejects a block timestamp %i seconds from now', async (seconds, reason) => {
    const rpc = fixture({ eth_getBlockByNumber: { ...block(), timestamp: hex(now / 1000 + seconds) } });
    await expect(createKolTokenBalance({ rpc, now: () => now })({ wallet, token })).rejects.toThrow(reason);
  });

  it('rechecks freshness after the token calls complete', async () => {
    let clock = now;
    const base = fixture();
    const rpc = async (method: string, params: unknown[], signal: AbortSignal) => {
      const result = await base(method, params, signal);
      if (method === 'eth_call') clock = now + 181_000;
      return result;
    };
    await expect(createKolTokenBalance({ rpc, now: () => clock })({ wallet, token })).rejects.toThrow('balance_block_stale');
  });

  it.each(['hash', 'timestamp'] as const)('rejects a changed confirmed block %s after balance reads', async changed => {
    const base = fixture(); let blockCalls = 0;
    const rpc = async (method: string, params: unknown[], signal: AbortSignal) => method === 'eth_getBlockByNumber' && ++blockCalls === 2
      ? { ...block(), [changed]: changed === 'hash' ? `0x${'cd'.repeat(32)}` : hex(now / 1000 - 2) } : base(method, params, signal);
    await expect(createKolTokenBalance({ rpc, now: () => now })({ wallet, token })).rejects.toThrow('balance_reorg');
  });

  it('always verifies on-chain decimals even when the caller supplies them', async () => {
    await expect(createKolTokenBalance({ rpc: fixture(), now: () => now })({ wallet, token, decimals: 9 })).rejects.toThrow('balance_decimals_mismatch');
  });

  it.each(['0x12', word(37n), 'invalid'])('rejects invalid token decimals %s', async precision => {
    const base = fixture();
    const rpc = async (method: string, params: unknown[], signal: AbortSignal) => method === 'eth_call' && (params[0] as { data: string }).data === '0x313ce567'
      ? precision : base(method, params, signal);
    await expect(createKolTokenBalance({ rpc, now: () => now })({ wallet, token })).rejects.toThrow('balance_decimals_invalid');
  });

  it.each(['0x1', '-1', '0x', null, word(rawBalance).replace('7', 'g')])('rejects an invalid ERC-20 balance response', async balance => {
    const base = fixture();
    const rpc = async (method: string, params: unknown[], signal: AbortSignal) => method === 'eth_call' && (params[0] as { data: string }).data !== '0x313ce567'
      ? balance : base(method, params, signal);
    await expect(createKolTokenBalance({ rpc, now: () => now })({ wallet, token })).rejects.toThrow('balance_response_invalid');
  });

  it('rejects invalid requests before doing RPC work', async () => {
    const rpc = fixture(), read = createKolTokenBalance({ rpc, now: () => now });
    await expect(read({ wallet: 'bad', token })).rejects.toThrow('balance_address_invalid');
    await expect(read({ wallet, token: 'bad' })).rejects.toThrow('balance_address_invalid');
    await expect(read({ wallet, token, decimals: -1 })).rejects.toThrow('balance_decimals_invalid');
    expect(rpc).not.toHaveBeenCalled();
  });

  it('does not expose RPC URLs or raw provider error messages', async () => {
    const rpc = vi.fn().mockRejectedValue(new Error('RPC failed for https://provider.test/private-key'));
    await expect(createKolTokenBalance({ rpc })({ wallet, token })).rejects.toThrow(/^balance_rpc_unavailable$/);
  });

  it('bounds an RPC that ignores cancellation and supports explicit caller cancellation', async () => {
    vi.useFakeTimers();
    const rpc = vi.fn((_method: string, _params: unknown[], _signal: AbortSignal) => new Promise<unknown>(() => {}));
    const timed = createKolTokenBalance({ rpc, budgetMs: 5000 })({ wallet, token });
    const timedResult = expect(timed).rejects.toThrow('balance_timeout');
    await vi.advanceTimersByTimeAsync(5000); await timedResult;
    const controller = new AbortController();
    const cancelled = createKolTokenBalance({ rpc })({ wallet, token }, controller.signal);
    const cancelledResult = expect(cancelled).rejects.toThrow('balance_aborted');
    controller.abort(); await cancelledResult;
    expect(rpc.mock.calls[0][2].aborted).toBe(true);
  });

  it('does not start a cancelled request', async () => {
    const rpc = fixture();
    await expect(createKolTokenBalance({ rpc })({ wallet, token }, AbortSignal.abort())).rejects.toThrow('balance_aborted');
    expect(rpc).not.toHaveBeenCalled();
  });

  it('uses only the normal node URL even when an archive URL is configured', async () => {
    vi.stubEnv('BSC_RPC_HTTP', 'http://normal-node.test');
    vi.stubEnv('BSC_INVENTORY_ARCHIVE_RPC_HTTP', 'http://archive.test');
    const rpc = fixture();
    const request = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, options) => {
      const body = JSON.parse(String(options?.body));
      return new Response(JSON.stringify({ result: await rpc(body.method, body.params, options?.signal as AbortSignal) }));
    });
    expect(await createKolTokenBalance({ now: () => now })({ wallet, token })).toMatchObject({ blockNumber: '100' });
    expect(request.mock.calls.every(([url]) => url === 'http://normal-node.test')).toBe(true);
    expect(request.mock.calls.every(([, options]) => options?.signal instanceof AbortSignal)).toBe(true);
  });
});
