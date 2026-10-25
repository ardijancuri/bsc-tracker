import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFreshSshTrace, FRESH_SSH_TRACE_PROGRAM, parseFreshSshTrace, type FreshSshInvocation } from './sshTrace.js';
import { freshNativeDelta } from './trace.js';
import type { FreshTransaction } from './capture.js';

const address = (digit: string) => `0x${digit.repeat(40)}`, hash = (digit: string) => `0x${digit.repeat(64)}`;
const transaction: FreshTransaction = { hash: hash('a'), from: address('1'), to: address('2'), value: '0x10', blockHash: hash('b'), blockNumber: '0x65', transactionIndex: '0x3' };
const receipt = { transactionHash: transaction.hash, blockHash: transaction.blockHash, blockNumber: transaction.blockNumber, transactionIndex: transaction.transactionIndex, status: '0x1' };
const trace = { type: 'CALL', from: transaction.from, to: transaction.to, value: transaction.value,
  calls: [{ type: 'CALL', from: transaction.to, to: transaction.from, value: '0x4' }, { type: 'CALL', from: transaction.from, to: address('3'), value: '0x100', error: 'reverted', calls: [{ type: 'CALL', from: transaction.from, to: address('3'), value: '0x200' }] }] };
const output = (changes: Record<string, unknown> = {}) => Buffer.from(JSON.stringify({ version: 1, before: receipt, after: receipt, trace, ...changes }));
const folders: string[] = [];
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'fresh-trace-')); folders.push(directory);
  const knownHostsPath = join(directory, 'known_hosts'), keyPath = join(directory, 'identity');
  await writeFile(knownHostsPath, '65.21.69.43 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIG1iRZaH1N/Yl4s4lPJwbqzUd/Jf/9b1QPwiN4O6Qoxi\n');
  await writeFile(keyPath, 'test fixture only; never passed to a real SSH process');
  return { knownHostsPath, keyPath };
}
afterEach(async () => { for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true }); });

describe('bounded read-only VPS IPC tracing', () => {
  it('validates canonical receipts on both sides and excludes reverted child subtrees', () => {
    const parsed = parseFreshSshTrace(output(), transaction);
    expect(freshNativeDelta(parsed, transaction.from)).toBe(-12n);
    expect(() => parseFreshSshTrace(output({ before: { ...receipt, blockHash: hash('c') } }), transaction)).toThrow('trace_receipt_mismatch');
    expect(() => parseFreshSshTrace(output({ after: { ...receipt, transactionIndex: '0x4' } }), transaction)).toThrow('trace_receipt_mismatch');
    expect(() => parseFreshSshTrace(output({ after: { ...receipt, status: '0x0' } }), transaction)).toThrow('trace_receipt_mismatch');
  });

  it('rejects a different top-level execution and oversized output', () => {
    expect(() => parseFreshSshTrace(output({ trace: { ...trace, value: '0x11' } }), transaction)).toThrow('trace_transaction_mismatch');
    expect(() => parseFreshSshTrace(Buffer.alloc(8 * 1_024 * 1_024 + 1), transaction)).toThrow('trace_too_large');
    expect(() => parseFreshSshTrace(Buffer.from('not JSON'), transaction)).toThrow('trace_response_invalid');
  });

  it('allows only the pinned host and constant bounded private RPC program', async () => {
    const config = await fixture();
    const runner = vi.fn(async (request: FreshSshInvocation) => {
      expect(request.args).toContain('root@65.21.69.43'); expect(request.args).toContain('StrictHostKeyChecking=yes');
      expect(request.args).toContain('BatchMode=yes'); expect(request.args).toContain('HostKeyAlgorithms=ssh-ed25519');
      expect(request.args).toContain(`UserKnownHostsFile=${config.knownHostsPath}`);
      expect(request.input.toString()).not.toContain('calls'); expect(JSON.parse(request.input.toString())).toEqual(transaction);
      const encoded = request.args.at(-1)!.match(/b64decode\("([A-Za-z0-9+/=]+)"\)/)![1];
      expect(Buffer.from(encoded, 'base64').toString()).toBe(FRESH_SSH_TRACE_PROGRAM);
      expect(FRESH_SSH_TRACE_PROGRAM).toContain("path='/var/lib/bsc/geth.ipc'");
      expect(FRESH_SSH_TRACE_PROGRAM).toContain("'timeout':'5s','reexec':32");
      expect(FRESH_SSH_TRACE_PROGRAM.match(/rpc\('/g)).toHaveLength(3);
      expect(FRESH_SSH_TRACE_PROGRAM).not.toMatch(/open\(|system\(|subprocess|http/);
      return { code: 0, stdout: output() };
    });
    // stdout is deliberately the only write; the program never writes a VPS file.
    expect(FRESH_SSH_TRACE_PROGRAM).toContain('sys.stdout.buffer.write(result)');
    await expect(createFreshSshTrace({ ...config, runner })(transaction)).resolves.toMatchObject({ from: transaction.from, value: '0x10' });
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it('refuses replaced host keys before starting SSH', async () => {
    const config = await fixture(), runner = vi.fn(async (_request: FreshSshInvocation) => ({ code: 0, stdout: output() }));
    await writeFile(config.knownHostsPath, '65.21.69.43 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n');
    await expect(createFreshSshTrace({ ...config, runner })(transaction)).resolves.toBeNull(); expect(runner).not.toHaveBeenCalled();
  });

  it('rejects malformed transaction inputs without running a remote command', async () => {
    const config = await fixture(), runner = vi.fn(async (_request: FreshSshInvocation) => ({ code: 0, stdout: output() }));
    const load = createFreshSshTrace({ ...config, runner });
    await expect(load({ ...transaction, hash: '0x1;shutdown' })).resolves.toBeNull();
    await expect(load({ ...transaction, blockNumber: '-1' })).resolves.toBeNull(); expect(runner).not.toHaveBeenCalled();
  });

  it('serializes active traces and drops independently cancelled queued work', async () => {
    const config = await fixture(); let release!: () => void;
    const started = new Promise<void>(resolve => { release = resolve; }), calls: FreshSshInvocation[] = [];
    let firstStarted!: () => void; const firstRunning = new Promise<void>(resolve => { firstStarted = resolve; });
    const runner = vi.fn(async (request: FreshSshInvocation) => { calls.push(request); firstStarted(); if (calls.length === 1) await started; return { code: 0, stdout: output() }; });
    const load = createFreshSshTrace({ ...config, runner });
    const first = load(transaction); await firstRunning;
    const cancelled = new AbortController(), second = load(transaction, cancelled.signal), third = load(transaction);
    cancelled.abort(); await expect(second).resolves.toBeNull(); expect(calls).toHaveLength(1);
    release(); await expect(first).resolves.not.toBeNull(); await expect(third).resolves.not.toBeNull(); expect(calls).toHaveLength(2);
  });

  it('bounds its queue and leaves failed remote lookups unavailable', async () => {
    const config = await fixture(); let release!: () => void, firstStarted!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { firstStarted = resolve; });
    const runner = vi.fn(async (_request: FreshSshInvocation) => { firstStarted(); await held; return { code: 1, stdout: Buffer.alloc(0) }; });
    const load = createFreshSshTrace({ ...config, runner, maxQueued: 0 });
    const first = load(transaction); await started; await expect(load(transaction)).resolves.toBeNull();
    release(); await expect(first).resolves.toBeNull(); expect(runner).toHaveBeenCalledTimes(1);
  });

  it('aborts the active subprocess at its total deadline', async () => {
    const config = await fixture(); let signal: AbortSignal | undefined;
    const runner = vi.fn(async (request: FreshSshInvocation) => {
      signal = request.signal;
      await new Promise<void>(resolve => { request.signal.addEventListener('abort', () => resolve(), { once: true }); });
      return { code: null, stdout: Buffer.alloc(0) };
    });
    await expect(createFreshSshTrace({ ...config, runner, timeoutMs: 30 })(transaction)).resolves.toBeNull();
    expect(signal?.aborted).toBe(true);
  });

  it('keeps cancellation isolated from the next queued trace', async () => {
    const config = await fixture(); let firstStarted!: () => void, calls = 0;
    const started = new Promise<void>(resolve => { firstStarted = resolve; });
    const runner = vi.fn(async (request: FreshSshInvocation) => {
      calls++; if (calls === 1) { firstStarted(); await new Promise<void>(resolve => request.signal.addEventListener('abort', () => resolve(), { once: true })); }
      return { code: 0, stdout: output() };
    });
    const load = createFreshSshTrace({ ...config, runner }), controller = new AbortController();
    const first = load(transaction, controller.signal); await started; const second = load(transaction); controller.abort();
    await expect(first).resolves.toBeNull(); await expect(second).resolves.not.toBeNull(); expect(calls).toBe(2);
  });
});
