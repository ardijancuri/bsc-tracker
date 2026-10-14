type Rpc = (method: string, params: unknown[], signal: AbortSignal) => Promise<any>;
class RpcFailure extends Error {
  constructor(readonly missingHistory: boolean, readonly rangeTooLarge = false) {
    super(missingHistory ? 'inventory_history_unavailable' : rangeTooLarge ? 'inventory_range_too_large' : 'inventory_rpc_unavailable');
  }
}
const historicalMethods = new Set(['eth_getBlockByNumber', 'eth_getTransactionReceipt', 'eth_getTransactionByHash', 'eth_getLogs', 'eth_call']);

/** Keep head/balance verification on our node; use an explicitly configured
 * archive only for pruned historical data. The inventory scanner still checks
 * block hashes, receipt logs, exact quantities, and its same-block end balance. */
export function createInventoryRpc({ request = fetch, primary = () => process.env.BSC_RPC_HTTP || 'http://127.0.0.1:8545',
  archive = () => process.env.BSC_INVENTORY_ARCHIVE_RPC_HTTP || '', now = Date.now,
}: { request?: typeof fetch; primary?: () => string; archive?: () => string; now?: () => number } = {}): Rpc {
  let id = 0, archiveVerified: string | null = null, unavailableUntil = 0;
  const call = async (endpoint: string, method: string, params: unknown[], signal: AbortSignal) => {
    const response = await request(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal,
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) });
    if (!response.ok) throw new RpcFailure(false);
    const body = await response.json();
    if (body.error || body.result == null) {
      const missing = body.result === null || /header not found|block not found|missing trie node|historical.*(unavailable|pruned)|pruned.*(history|state)|history.*pruned/i.test(body.error?.message ?? '');
      const rangeTooLarge = /range.*(too (large|wide)|limit|exceed|over \d+)|(?:limited|max(?:imum)?).*\d+.*blocks|exceed.*block.*range/i.test(body.error?.message ?? '');
      throw new RpcFailure(missing, rangeTooLarge);
    }
    return body.result;
  };
  return async (method, params, signal) => {
    try { return await call(primary(), method, params, signal); }
    catch (error) {
      if (signal.aborted || !(error instanceof RpcFailure) || !error.missingHistory || !historicalMethods.has(method)) throw error;
      const endpoint = archive();
      if (!endpoint || endpoint === primary() || now() < unavailableUntil) throw new Error('inventory_history_unavailable');
      try {
        if (archiveVerified !== endpoint) {
          if (await call(endpoint, 'eth_chainId', [], signal) !== '0x38') throw new Error('inventory_history_unavailable');
          archiveVerified = endpoint;
        }
        return await call(endpoint, method, params, signal);
      } catch (failure) {
        if (signal.aborted) throw failure;
        if (failure instanceof RpcFailure && failure.rangeTooLarge) throw failure;
        unavailableUntil = now() + 60_000;
        throw new Error('inventory_history_unavailable');
      }
    }
  };
}
