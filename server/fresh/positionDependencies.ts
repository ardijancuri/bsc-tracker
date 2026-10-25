import { createHash } from 'node:crypto';
import { freshAddress, freshHash, freshInteger, validateFreshReceipt, type FreshCapturedReceipt } from './capture.js';
import { freshTraceMatchesTransaction, validateFreshTrace } from './trace.js';

export interface FreshPositionDependencies { version: 1; addresses: string[]; proofHash: string }
const callTypes = new Set(['CALL', 'STATICCALL', 'DELEGATECALL', 'CALLCODE', 'CREATE', 'CREATE2', 'SELFDESTRUCT']);

/** A complete captured callTracer tree bounds every contract entered by this
 * execution. Logs alone do not: an opaque caller may change token storage
 * without emitting Transfer. Untraced or malformed evidence stays global.
 * This is a small temporary index of the original 72-hour evidence, never
 * financial approval or a substitute for a canonical balance check. */
export function freshPositionDependencies(entry: FreshCapturedReceipt): FreshPositionDependencies | null {
  try {
    if (!entry.trace || entry.receipt.status !== '0x1') return null;
    if (!freshHash(entry.transaction.hash) || !freshHash(entry.transaction.blockHash) || freshHash(entry.transaction.blockHash) !== freshHash(entry.receipt.blockHash)
      || freshInteger(entry.transaction.blockNumber) !== freshInteger(entry.receipt.blockNumber)) return null;
    validateFreshReceipt(entry.receipt, entry.transaction, { number: entry.receipt.blockNumber, hash: entry.receipt.blockHash,
      parentHash: entry.receipt.blockHash, timestamp: '0x0', transactions: [entry.transaction] });
    const trace = validateFreshTrace(entry.trace);
    if (!freshTraceMatchesTransaction(trace, entry.transaction)
      || typeof entry.transaction.input !== 'string' || trace.input !== entry.transaction.input.toLowerCase()) return null;
    const addresses = new Set<string>();
    const add = (value: unknown) => { const address = freshAddress(value); if (address) addresses.add(address); };
    const visit = (call: typeof trace) => {
      if (!callTypes.has(call.type) || !call.to) throw Error('position_dependency_trace_opaque');
      add(call.from); add(call.to); call.calls?.forEach(visit);
    };
    visit(trace); entry.receipt.logs.forEach(log => add(log.address));
    add(entry.transaction.from); add(entry.transaction.to); add(entry.receipt.contractAddress);
    if (addresses.size > 512) return null;
    return { version: 1, addresses: [...addresses].sort(), proofHash: createHash('sha256')
      .update(JSON.stringify([entry.transaction, entry.receipt, trace])).digest('hex') };
  } catch { return null; }
}

/** NULL means opaque and therefore blocks every book containing this wallet.
 * A proven complete tree can instead block just contracts it actually touched. */
export const freshPositionReceiptOpaqueSql = (e: string) =>
  `(${e}.position_dependency_addresses IS NULL OR cardinality(${e}.position_dependency_addresses)=0
    OR ${e}.position_dependency_proof IS NULL OR ${e}.position_dependency_proof!~'^[0-9a-f]{64}$'
  )`;
export const freshPositionReceiptRelevantSql = (e: string, token: string) =>
  `(${freshPositionReceiptOpaqueSql(e)} OR ${token}=ANY(${e}.position_dependency_addresses))`;
