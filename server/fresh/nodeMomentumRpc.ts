import { RpcRequestError, type Rpc, type RpcBatchRequest } from '../rpc.js';

const allowedMethods = new Set(['eth_blockNumber', 'eth_getBlockByNumber', 'eth_getLogs', 'eth_call']);
const maxBatch = 32;
const maxBytes = 4 * 1024 * 1024;
const defaultDeadlineMs = 4_000;

export interface NodeMomentumRpcStats {
  requests: number;
  calls: number;
  responseBytes: number;
  elapsedMs: number;
  maxRequestMs: number;
}

export class NodeMomentumLogRangeLimitError extends RpcRequestError {
  constructor() { super('Momentum log range exceeds limit', 'invalid_response'); }
}

function logRangeLimit(message: string) {
  return /query returned more than|(?:max(?:imum)? (?:allowed )?block range|block range (?:is )?(?:too (?:wide|large)|limit(?: exceeded)?))|(?:too many (?:logs|results)|(?:log|result) (?:count|size|limit) exceeded)|(?:response (?:body |size )?too large|response (?:size |body )?limit exceeded)/i.test(message);
}

/** Market discovery shares the node with capture. Give it a separate, short
 * deadline, bounded body reads and a single in-flight HTTP request. */
export function createNodeMomentumRpc(endpoint = 'http://127.0.0.1:8545', options: {
  deadlineMs?: number;
  fetch?: typeof fetch;
} = {}): Rpc & { stats(): NodeMomentumRpcStats } {
  const target = new URL(endpoint);
  if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1' || target.pathname !== '/' ||
      target.username || target.password || target.search || target.hash) throw Error('momentum_rpc_endpoint_invalid');
  const deadlineMs = options.deadlineMs ?? defaultDeadlineMs;
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > defaultDeadlineMs) throw Error('momentum_rpc_deadline_invalid');
  const fetchRpc = options.fetch ?? fetch;
  const stats = { requests: 0, calls: 0, responseBytes: 0, elapsedMs: 0, maxRequestMs: 0 };
  let requestId = 0;
  let active = false;

  async function request(items: RpcBatchRequest[], batch: boolean): Promise<PromiseSettledResult<unknown>[]> {
    if (!items.length || items.length > maxBatch || items.some(item => !allowedMethods.has(item.method))) throw Error('momentum_rpc_request_invalid');
    if (active) throw Error('momentum_rpc_busy');
    active = true;
    const start = performance.now();
    stats.requests++;
    stats.calls += items.length;
    try {
      const requests = items.map(item => ({ jsonrpc: '2.0', id: ++requestId, ...item }));
      const logQuery = !batch && items[0].method === 'eth_getLogs';
      const response = await fetchRpc(target, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        redirect: 'error', signal: AbortSignal.timeout(deadlineMs),
        body: JSON.stringify(batch ? requests : requests[0]),
      });
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        if (logQuery && response.status === 413) throw new NodeMomentumLogRangeLimitError();
        throw new RpcRequestError('Momentum node unavailable', response.status === 429 ? 'rate_limit' : 'transport', { httpStatus: response.status });
      }
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      let body: unknown;
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.length;
          stats.responseBytes += chunk.value.length;
          if (bytes > maxBytes) {
            await reader.cancel();
            if (logQuery) throw new NodeMomentumLogRangeLimitError();
            throw new RpcRequestError('Momentum node response exceeds limit', 'invalid_response');
          }
          chunks.push(chunk.value);
        }
        try { body = JSON.parse(Buffer.concat(chunks, bytes).toString('utf8')); }
        catch { throw new RpcRequestError('Momentum node response invalid', 'invalid_response'); }
      } finally { reader.releaseLock(); }
      if (batch !== Array.isArray(body)) throw new RpcRequestError('Momentum node response invalid', 'invalid_response');
      const expected = new Set(requests.map(item => item.id));
      const results = new Map<number, PromiseSettledResult<unknown>>();
      for (const raw of (Array.isArray(body) ? body : [body])) {
        if (!raw || typeof raw !== 'object') continue;
        const row = raw as Record<string, unknown>;
        if (typeof row.id !== 'number' || !expected.has(row.id)) continue;
        const valid = !results.has(row.id) && row.jsonrpc === '2.0';
        if (valid && row.error == null && row.result != null) results.set(row.id, { status: 'fulfilled', value: row.result });
        else {
          const providerError = valid && row.error && typeof row.error === 'object' ? row.error as Record<string, unknown> : null;
          const detail = typeof providerError?.message === 'string' ? providerError.message : '';
          if (logQuery && logRangeLimit(detail)) {
            results.set(row.id, { status: 'rejected', reason: new NodeMomentumLogRangeLimitError() });
            continue;
          }
          const category = !providerError ? 'invalid_response'
            : /missing trie|header not found|historical state|state (?:is )?(?:unavailable|not available)|not supported/i.test(detail) ? 'state_unavailable'
            : providerError.code === 3 || /revert/i.test(detail) ? 'revert'
            : providerError.code === -32005 ? 'rate_limit' : 'rpc_error';
          results.set(row.id, { status: 'rejected', reason: new RpcRequestError('Momentum node request failed', category,
            { code: providerError?.code, nullResult: valid && row.error == null && row.result === null }) });
        }
      }
      return requests.map(({ id }) => results.get(id) ?? {
        status: 'rejected', reason: new RpcRequestError('Momentum node response missing', 'invalid_response'),
      });
    } catch (error) {
      if (error instanceof RpcRequestError) throw error;
      throw new RpcRequestError('Momentum node unavailable', 'transport');
    } finally {
      const elapsed = performance.now() - start;
      stats.elapsedMs += elapsed;
      stats.maxRequestMs = Math.max(stats.maxRequestMs, elapsed);
      active = false;
    }
  }

  const rpc: Rpc = async <T>(method: string, params: unknown[]) => {
    const [result] = await request([{ method, params }], false);
    if (result.status === 'rejected') throw result.reason;
    return result.value as T;
  };
  rpc.batch = items => items.length ? request(items, true) : Promise.resolve([]);
  return Object.assign(rpc, { stats: () => ({ ...stats }) });
}
