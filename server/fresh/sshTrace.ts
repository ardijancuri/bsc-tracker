import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { freshAddress, freshHash, freshInteger, type FreshTransaction } from './capture.js';
import { freshTraceMatchesTransaction, validateFreshTrace, type FreshCallTrace } from './trace.js';

const host = '65.21.69.43';
const hostFingerprint = 'QjaZ1AxoNaKCXM3m3dc79YSJ8nrHED6Tw8pKv5qPL0w';
const maxBytes = 8 * 1_024 * 1_024;

/** This constant program is sent over SSH, never installed on the node. Its only
 * RPC methods are receipt lookup and a bounded callTracer against private IPC. */
export const FRESH_SSH_TRACE_PROGRAM = String.raw`
import sys,json,socket,time,os,stat,re
LIMIT=8388608
deadline=time.monotonic()+8
payload=sys.stdin.buffer.read(4097)
if len(payload)>4096: raise ValueError('input_bounds')
tx=json.loads(payload)
def hx(value,size):
 return isinstance(value,str) and re.fullmatch('0x[0-9a-fA-F]{'+str(size)+'}',value) is not None
def quantity(value):
 if not isinstance(value,str) or re.fullmatch('0x[0-9a-fA-F]{1,64}',value) is None: raise ValueError('quantity_invalid')
 return int(value,16)
if not hx(tx.get('hash'),64) or not hx(tx.get('blockHash'),64) or not hx(tx.get('from'),40): raise ValueError('identity_invalid')
if tx.get('to') is not None and not hx(tx.get('to'),40): raise ValueError('identity_invalid')
for field in ['blockNumber','transactionIndex','value']: quantity(tx.get(field))
path='/var/lib/bsc/geth.ipc'
info=os.stat(path)
if not stat.S_ISSOCK(info.st_mode) or info.st_mode & 7: raise ValueError('ipc_permissions')
counter=0
def rpc(method,params):
 global counter
 if method not in ['eth_getTransactionReceipt','debug_traceTransaction']: raise ValueError('method_denied')
 counter+=1
 remaining=deadline-time.monotonic()
 if remaining<=0: raise TimeoutError('trace_timeout')
 client=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
 client.settimeout(min(6,remaining))
 try:
  client.connect(path)
  client.sendall((json.dumps({'jsonrpc':'2.0','id':counter,'method':method,'params':params})+'\n').encode())
  raw=b''
  while True:
   chunk=client.recv(min(65536,LIMIT+1-len(raw)))
   if not chunk: raise ValueError('ipc_incomplete')
   raw+=chunk
   if len(raw)>LIMIT: raise ValueError('trace_too_large')
   try: result=json.loads(raw)
   except (ValueError,UnicodeDecodeError): continue
   if result.get('id')!=counter or result.get('error') or result.get('result') is None: raise ValueError('trace_unavailable')
   return result['result']
 finally: client.close()
def receipt(value):
 if not isinstance(value,dict): raise ValueError('receipt_missing')
 for field,expected in [('transactionHash',tx['hash']),('blockHash',tx['blockHash'])]:
  if not isinstance(value.get(field),str) or value[field].lower()!=expected.lower(): raise ValueError('receipt_identity')
 for field in ['blockNumber','transactionIndex']:
  if quantity(value.get(field))!=quantity(tx[field]): raise ValueError('receipt_position')
 if quantity(value.get('status'))!=1: raise ValueError('receipt_failed')
 return {field:value[field] for field in ['transactionHash','blockHash','blockNumber','transactionIndex','status']}
before=receipt(rpc('eth_getTransactionReceipt',[tx['hash']]))
trace=rpc('debug_traceTransaction',[tx['hash'],{'tracer':'callTracer','timeout':'5s','reexec':32,'tracerConfig':{'onlyTopCall':False,'withLog':False}}])
after=receipt(rpc('eth_getTransactionReceipt',[tx['hash']]))
result=json.dumps({'version':1,'before':before,'trace':trace,'after':after},separators=(',',':')).encode()
if len(result)>LIMIT: raise ValueError('trace_too_large')
sys.stdout.buffer.write(result)
`;

export interface FreshSshInvocation { executable: string; args: string[]; input: Buffer; signal: AbortSignal; maxBytes: number }
export type FreshSshRunner = (invocation: FreshSshInvocation) => Promise<{ code: number | null; stdout: Buffer }>;

const execute: FreshSshRunner = async invocation => new Promise((resolveResult, reject) => {
  const process = spawn(invocation.executable, invocation.args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const chunks: Buffer[] = []; let bytes = 0, errorBytes = 0, settled = false;
  const finish = (error?: Error, code?: number | null) => {
    if (settled) return; settled = true;
    invocation.signal.removeEventListener('abort', abort);
    error ? reject(error) : resolveResult({ code: code ?? null, stdout: Buffer.concat(chunks) });
  };
  const abort = () => { process.kill(); finish(new Error('trace_cancelled')); };
  invocation.signal.addEventListener('abort', abort, { once: true });
  if (invocation.signal.aborted) { abort(); return; }
  process.on('error', () => finish(new Error('trace_ssh_unavailable')));
  process.stdin.on('error', () => { /* Process exit is handled without exposing stderr. */ });
  process.stdout.on('data', (value: Buffer) => {
    bytes += value.length;
    if (bytes > invocation.maxBytes) { process.kill(); finish(new Error('trace_too_large')); }
    else chunks.push(value);
  });
  process.stderr.on('data', (value: Buffer) => { errorBytes += value.length; if (errorBytes > 64 * 1_024) { process.kill(); finish(new Error('trace_ssh_unavailable')); } });
  process.on('close', code => finish(undefined, code));
  process.stdin.end(invocation.input);
});

function transactionInput(transaction: FreshTransaction): Buffer {
  if (!freshHash(transaction.hash) || !freshHash(transaction.blockHash) || !freshAddress(transaction.from)
    || transaction.to !== null && !freshAddress(transaction.to)) throw new Error('trace_transaction_invalid');
  for (const value of [transaction.blockNumber, transaction.transactionIndex, transaction.value]) freshInteger(value);
  return Buffer.from(JSON.stringify({ hash: transaction.hash.toLowerCase(), blockHash: transaction.blockHash.toLowerCase(),
    blockNumber: transaction.blockNumber, transactionIndex: transaction.transactionIndex, from: transaction.from.toLowerCase(),
    to: transaction.to?.toLowerCase() ?? null, value: transaction.value }));
}

function receiptMatches(value: unknown, transaction: FreshTransaction): boolean {
  if (!value || typeof value !== 'object') return false;
  const receipt = value as Record<string, unknown>;
  try { return freshHash(receipt.transactionHash) === transaction.hash.toLowerCase() && freshHash(receipt.blockHash) === transaction.blockHash.toLowerCase()
    && freshInteger(receipt.blockNumber) === freshInteger(transaction.blockNumber) && freshInteger(receipt.transactionIndex) === freshInteger(transaction.transactionIndex)
    && freshInteger(receipt.status) === 1n; } catch { return false; }
}

export function parseFreshSshTrace(output: Buffer, transaction: FreshTransaction): FreshCallTrace {
  if (output.length > maxBytes) throw new Error('trace_too_large');
  let value: any; try { value = JSON.parse(output.toString()); } catch { throw new Error('trace_response_invalid'); }
  if (value?.version !== 1 || !receiptMatches(value.before, transaction) || !receiptMatches(value.after, transaction)) throw new Error('trace_receipt_mismatch');
  const trace = validateFreshTrace(value.trace);
  if (!freshTraceMatchesTransaction(trace, transaction)) throw new Error('trace_transaction_mismatch');
  return trace;
}

export interface FreshSshTraceOptions {
  knownHostsPath?: string; keyPath?: string; sshPath?: string;
  /** Injection is for deterministic local tests. No alternate remote host or command is accepted. */
  runner?: FreshSshRunner; timeoutMs?: number; maxQueued?: number;
}

/** Optional local-only adapter. Failures leave an explicit unknown value in the
 * decoder; it cannot mutate VPS configuration or expose public tracing RPC. */
export function createFreshSshTrace(options: FreshSshTraceOptions = {}) {
  const knownHostsPath = resolve(options.knownHostsPath ?? '.cache/fresh/known_hosts');
  const keyPath = resolve(options.keyPath ?? `${homedir()}/.ssh/codex_hams_vps`);
  const runner = options.runner ?? execute, timeoutMs = Math.min(10_000, Math.max(1, options.timeoutMs ?? 10_000));
  const maxQueued = Math.min(32, Math.max(0, options.maxQueued ?? 8));
  const queue: { input: Buffer; transaction: FreshTransaction; signal?: AbortSignal; resolve: (trace: FreshCallTrace | null) => void; abort: () => void }[] = [];
  let active = false, verified: Promise<void> | undefined;
  const verify = () => verified ??= (async () => {
    const [knownHosts, key] = await Promise.all([readFile(knownHostsPath, 'utf8'), stat(keyPath)]);
    if (!key.isFile()) throw new Error('trace_key_missing');
    const records = knownHosts.split(/\r?\n/).filter(line => line.trim() && !line.startsWith('#')).map(line => line.trim().split(/\s+/));
    if (records.length !== 1 || records[0][0] !== host || records[0][1] !== 'ssh-ed25519'
      || createHash('sha256').update(Buffer.from(records[0][2] ?? '', 'base64')).digest('base64').replace(/=+$/, '') !== hostFingerprint) throw new Error('trace_host_key_mismatch');
  })().catch(error => { verified = undefined; throw error; });

  const pump = async () => {
    if (active || queue.length === 0) return;
    active = true; const job = queue.shift()!; job.signal?.removeEventListener('abort', job.abort);
    const controller = new AbortController(), abort = () => controller.abort();
    job.signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      if (job.signal?.aborted) return job.resolve(null);
      await verify();
      if (controller.signal.aborted) return job.resolve(null);
      const command = `python3 -c 'import base64;exec(base64.b64decode("${Buffer.from(FRESH_SSH_TRACE_PROGRAM).toString('base64')}"))'`;
      const running = runner({ executable: options.sshPath ?? 'ssh', args: ['-T', '-i', keyPath, '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes',
        '-o', 'StrictHostKeyChecking=yes', '-o', `UserKnownHostsFile=${knownHostsPath}`, '-o', 'HostKeyAlgorithms=ssh-ed25519', '-o', 'UpdateHostKeys=no',
        '-o', 'ConnectTimeout=5', '-o', 'ConnectionAttempts=1', `root@${host}`, command], input: job.input, signal: controller.signal, maxBytes });
      const result = await new Promise<Awaited<ReturnType<FreshSshRunner>>>((resolveResult, reject) => {
        const timeout = () => reject(new Error('trace_timeout'));
        controller.signal.addEventListener('abort', timeout, { once: true });
        running.then(resolveResult, reject).finally(() => controller.signal.removeEventListener('abort', timeout));
        if (controller.signal.aborted) timeout();
      });
      job.resolve(result.code === 0 && !controller.signal.aborted ? parseFreshSshTrace(result.stdout, job.transaction) : null);
    } catch { job.resolve(null); }
    finally { clearTimeout(timer); job.signal?.removeEventListener('abort', abort); active = false; void pump(); }
  };

  return (transaction: FreshTransaction, signal?: AbortSignal): Promise<FreshCallTrace | null> => {
    let input: Buffer; try { input = transactionInput(transaction); } catch { return Promise.resolve(null); }
    if (signal?.aborted || active && queue.length >= maxQueued) return Promise.resolve(null);
    return new Promise(resolveResult => {
      const job = { input, transaction, signal, resolve: resolveResult, abort: () => { const index = queue.indexOf(job); if (index >= 0) { queue.splice(index, 1); resolveResult(null); } } };
      signal?.addEventListener('abort', job.abort, { once: true }); queue.push(job); void pump();
    });
  };
}
