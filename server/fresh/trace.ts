import net from 'node:net';
import { stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { freshAddress, freshHash, freshInteger, type FreshTransaction } from './capture.js';

export interface FreshCallTrace { type: string; from: string; to?: string; value?: string; error?: string; input?: string; output?: string; calls?: FreshCallTrace[] }
export type FreshTraceLoader = (transaction: FreshTransaction) => Promise<FreshCallTrace | null>;
export function validateFreshTrace(input: unknown): FreshCallTrace {
  let count = 0, dataBytes = 0;
  function visit(raw: any, depth: number): FreshCallTrace {
    if (!raw || typeof raw !== 'object' || ++count > 5_000 || depth > 32 || typeof raw.type !== 'string' || !freshAddress(raw.from)
      || raw.to != null && !freshAddress(raw.to) || raw.value != null && (typeof raw.value !== 'string' || !/^0x[\da-f]{1,64}$/i.test(raw.value))
      || raw.error !== undefined && typeof raw.error !== 'string' || raw.calls != null && !Array.isArray(raw.calls)) throw new Error('trace_bounds_invalid');
    for (const field of ['input', 'output']) if (raw[field] !== undefined) {
      if (typeof raw[field] !== 'string' || !/^0x(?:[\da-f]{2})*$/i.test(raw[field]) || raw[field].length > 2 + 128 * 1024 * 2) throw new Error('trace_data_bounds_invalid');
      dataBytes += (raw[field].length - 2) / 2;
      if (dataBytes > 2 * 1024 * 1024) throw new Error('trace_data_bounds_invalid');
    }
    return { type: raw.type.toUpperCase(), from: raw.from.toLowerCase(), ...(raw.to ? { to: raw.to.toLowerCase() } : {}), ...(raw.value ? { value: raw.value } : {}),
      ...(raw.input !== undefined ? { input: raw.input.toLowerCase() } : {}), ...(raw.output !== undefined ? { output: raw.output.toLowerCase() } : {}),
      ...(typeof raw.error === 'string' ? { error: raw.error.slice(0, 128) } : {}), ...(raw.calls?.length ? { calls: raw.calls.map((child: unknown) => visit(child, depth + 1)) } : {}) };
  }
  return visit(input, 0);
}
export function freshTraceMatchesTransaction(trace: FreshCallTrace, tx: FreshTransaction) {
  return trace.from === tx.from.toLowerCase() && !trace.error && freshInteger(trace.value ?? '0x0') === freshInteger(tx.value)
    && (tx.to === null ? ['CREATE', 'CREATE2'].includes(trace.type) : trace.type === 'CALL' && trace.to === tx.to.toLowerCase());
}
export function freshNativeDelta(trace: FreshCallTrace, wallet: string): bigint {
  let result = 0n;
  function visit(call: FreshCallTrace) {
    if (call.error) return;
    if (['CALL', 'CREATE', 'CREATE2', 'SELFDESTRUCT'].includes(call.type) && call.from !== call.to && call.value) {
      const value = freshInteger(call.value); if (call.from === wallet) result -= value; if (call.to === wallet) result += value;
    }
    call.calls?.forEach(visit);
  }
  visit(trace); return result;
}
/** Optional local socket only: no public debug RPC, arbitrary methods or shell.
 * The node's configured IPC permissions are checked before opening a socket. */
export async function freshIpcTrace(transaction: FreshTransaction, ipcPath = process.env.BSC_TRACE_IPC): Promise<FreshCallTrace | null> {
  if (!ipcPath) return null;
  if (!isAbsolute(ipcPath) || /^https?:/i.test(ipcPath) || !freshHash(transaction.hash)) throw new Error('trace_local_ipc_required');
  const info = await stat(ipcPath);
  if (!info.isSocket() || info.mode & 0o007) throw new Error('trace_socket_permissions_invalid');
  const trace = await new Promise<FreshCallTrace>((resolve, reject) => {
    const socket = net.createConnection(ipcPath); let buffer = '', done = false;
    const finish = (error?: Error, value?: FreshCallTrace) => { if (done) return; done = true; clearTimeout(timer); socket.destroy(); error ? reject(error) : resolve(value!); };
    const timer = setTimeout(() => finish(new Error('trace_timeout')), 3_000);
    socket.on('error', error => finish(error)); socket.on('end', () => { if (!done) finish(new Error('trace_incomplete')); });
    socket.on('connect', () => socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'debug_traceTransaction', params: [transaction.hash, { tracer: 'callTracer', timeout: '2s', reexec: 128, tracerConfig: { onlyTopCall: false, withLog: false } }] })}\n`));
    socket.on('data', data => {
      buffer += data.toString(); if (Buffer.byteLength(buffer) > 2_000_000) return finish(new Error('trace_too_large'));
      let body: any; try { body = JSON.parse(buffer); } catch { return; }
      if (body.id !== 1 || body.error || !body.result) return finish(new Error('trace_unavailable'));
      try { finish(undefined, validateFreshTrace(body.result)); } catch (error) { finish(error as Error); }
    });
  });
  if (!freshTraceMatchesTransaction(trace, transaction)) throw new Error('trace_transaction_mismatch');
  return trace;
}
