import { RpcRequestError, type Rpc } from '../rpc.js';

export const FRESH_STATE_EVIDENCE_MAX_CALLS = 128;
export const FRESH_STATE_EVIDENCE_MAX_BYTES = 128 * 1_024;
export const FRESH_STATE_EVIDENCE_MAX_DATA_BYTES = 4 * 1_024;
export const FRESH_STATE_EVIDENCE_MAX_RESULT_BYTES = 16 * 1_024;

export interface FreshStateReadEvidence {
  version: 1;
  blockNumber: number;
  blockHash: string;
  calls: { to: string; data: string; result: string }[];
}
export interface FreshStateEvidenceRpc {
  rpc: Rpc;
  /** Successful new reads added since this receipt was opened. */
  readonly writes: number;
  /** Invalid or foreign saved evidence was discarded, never used as proof. */
  readonly rejectedPrior: boolean;
  /** Drain started sibling reads before serializing a failed Promise.all. */
  settle(): Promise<void>;
  /** Include this in the existing compressed receipt, on repair and on done. */
  snapshot(): FreshStateReadEvidence | undefined;
}

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value: Record<string, unknown>, allowed: readonly string[]) => Object.keys(value).length === allowed.length && allowed.every(key => Object.hasOwn(value, key));
const hash = (value: unknown): value is string => typeof value === 'string' && /^0x[\da-f]{64}$/i.test(value);
const address = (value: unknown): value is string => typeof value === 'string' && /^0x[\da-f]{40}$/i.test(value);
const hex = (value: unknown, maxBytes: number): value is string => typeof value === 'string' && value.length <= 2 + maxBytes * 2 && /^0x(?:[\da-f]{2})*$/i.test(value);
const keyOf = (call: { to: string; data: string }) => `${call.to}:${call.data}`;

/** A bounded cache of successful raw node responses at one receipt block.
 * The caller still checks its captured block is canonical before committing.
 * This proof never authorizes a different block or current-row metadata. ABI
 * decoding and financial validation remain the responsibility of each caller. */
export function createFreshStateEvidenceRpc(nodeRpc: Rpc, block: { number: number; hash: string }, prior?: unknown): FreshStateEvidenceRpc {
  if (!Number.isSafeInteger(block.number) || block.number < 0 || !hash(block.hash)) throw new Error('state_evidence_block_invalid');
  const blockNumber = block.number, blockHash = block.hash.toLowerCase();
  const saved = new Map<string, FreshStateReadEvidence['calls'][number]>(), pending = new Map<string, Promise<string>>();
  const envelope = (calls: FreshStateReadEvidence['calls']): FreshStateReadEvidence => ({ version: 1, blockNumber, blockHash, calls });
  let bytes = Buffer.byteLength(JSON.stringify(envelope([]))), writes = 0;
  let rejectedPrior = false;
  if (prior !== undefined) {
    if (!record(prior) || !keys(prior, ['version', 'blockNumber', 'blockHash', 'calls']) || prior.version !== 1 || prior.blockNumber !== blockNumber
      || !hash(prior.blockHash) || prior.blockHash.toLowerCase() !== blockHash || !Array.isArray(prior.calls) || prior.calls.length > FRESH_STATE_EVIDENCE_MAX_CALLS) rejectedPrior = true;
    else {
      for (const value of prior.calls) {
        if (!record(value) || !keys(value, ['to', 'data', 'result']) || !address(value.to)
          || !hex(value.data, FRESH_STATE_EVIDENCE_MAX_DATA_BYTES) || !hex(value.result, FRESH_STATE_EVIDENCE_MAX_RESULT_BYTES)) { rejectedPrior = true; break; }
        const call = { to: value.to.toLowerCase(), data: value.data.toLowerCase(), result: value.result.toLowerCase() }, key = keyOf(call);
        if (saved.has(key)) { rejectedPrior = true; break; }
        bytes += Buffer.byteLength(JSON.stringify(call)) + (saved.size ? 1 : 0);
        if (bytes > FRESH_STATE_EVIDENCE_MAX_BYTES) { rejectedPrior = true; break; }
        saved.set(key, call);
      }
    }
    if (rejectedPrior) { saved.clear(); bytes = Buffer.byteLength(JSON.stringify(envelope([]))); }
  }
  const rpc: Rpc = async <T>(method: string, params: unknown[]): Promise<T> => {
    if (method !== 'eth_call' || !Array.isArray(params) || params.length !== 2 || !record(params[0]) || !keys(params[0], ['to', 'data'])
      || !address(params[0].to) || !hex(params[0].data, FRESH_STATE_EVIDENCE_MAX_DATA_BYTES) || !record(params[1]) || !keys(params[1], ['blockHash', 'requireCanonical'])
      || !hash(params[1].blockHash) || params[1].blockHash.toLowerCase() !== blockHash || params[1].requireCanonical !== true) throw new RpcRequestError('state_evidence_request_invalid', 'invalid_response');
    const call = { to: params[0].to.toLowerCase(), data: params[0].data.toLowerCase() }, key = keyOf(call), cached = saved.get(key);
    if (cached) return cached.result as T;
    let work = pending.get(key);
    if (!work) {
      work = (async () => {
        const result = await nodeRpc<unknown>('eth_call', [call, { blockHash, requireCanonical: true }]);
        if (typeof result !== 'string' || !/^0x(?:[\da-f]{2})*$/i.test(result)) throw new RpcRequestError('state_response_invalid', 'invalid_response');
        const normalized = result.toLowerCase();
        if (hex(normalized, FRESH_STATE_EVIDENCE_MAX_RESULT_BYTES) && saved.size < FRESH_STATE_EVIDENCE_MAX_CALLS) {
          const value = { ...call, result: normalized }, additional = Buffer.byteLength(JSON.stringify(value)) + (saved.size ? 1 : 0);
          if (bytes + additional <= FRESH_STATE_EVIDENCE_MAX_BYTES) { saved.set(key, value); bytes += additional; writes++; }
        }
        return normalized;
      })();
      pending.set(key, work);
    }
    try { return await work as T; }
    finally { if (pending.get(key) === work) pending.delete(key); }
  };
  return {
    rpc,
    get writes() { return writes; },
    get rejectedPrior() { return rejectedPrior; },
    async settle() { while (pending.size) await Promise.allSettled([...pending.values()]); },
    snapshot() { return saved.size ? envelope([...saved.values()].map(call => ({ ...call }))) : undefined; },
  };
}
