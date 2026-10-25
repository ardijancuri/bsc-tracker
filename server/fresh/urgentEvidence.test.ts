import { describe, expect, it, vi } from 'vitest';
import { Interface } from 'ethers';
import type { Pool } from 'pg';
import type { Rpc } from '../rpc.js';
import { transferTopic } from '../swap.js';
import { decodeFreshEvidence, encodeFreshEvidence, type FreshCapturedReceipt } from './capture.js';
import { createFreshUrgentEvidenceCapture, freshUrgentTokenTargets, mergeFreshUrgentEvidence, persistFreshUrgentEvidence, FRESH_URGENT_EVIDENCE_MAX_RPC } from './urgentEvidence.js';
import type { FreshStateReadEvidence } from './stateEvidence.js';

const address = (digit: string) => `0x${digit.repeat(40)}`, hash = (digit: string) => `0x${digit.repeat(64)}`;
const wallet = address('1'), other = address('2'), token = address('7'), intermediary = address('8'), blockHash = hash('a'), txHash = hash('b');
const abi = new Interface(['function decimals() view returns(uint8)', 'function totalSupply() view returns(uint256)']);
const word = (value: string) => `0x${value.slice(2).padStart(64, '0')}`;
function fixture(transactionHash = txHash, time = new Date()): FreshCapturedReceipt {
  const log = (asset: string, from: string, to: string, index: number) => ({ address: asset, topics: [transferTopic, word(from), word(to)], data: word('0x1'), logIndex: `0x${index.toString(16)}`,
    transactionHash, transactionIndex: '0x0', blockNumber: '0x65', blockHash });
  return { transaction: { hash: transactionHash, from: wallet, to: other, value: '0x0', blockHash, blockNumber: '0x65', transactionIndex: '0x0', gasPrice: '0x0' },
    receipt: { transactionHash, transactionIndex: '0x0', blockHash, blockNumber: '0x65', status: '0x1', gasUsed: '0x5208', effectiveGasPrice: '0x0',
      logs: [log(intermediary, other, address('3'), 0), log(token, other, wallet, 1)] }, wallets: [wallet], observedAt: time.toISOString() };
}
const proof = (calls: FreshStateReadEvidence['calls'] = [{ to: token, data: abi.encodeFunctionData('decimals'), result: abi.encodeFunctionResult('decimals', [18]) }]): FreshStateReadEvidence => ({ version: 1, blockNumber: 101, blockHash, calls });

function memory(entries: FreshCapturedReceipt[], time = new Date()) {
  const rows = entries.map(entry => ({ tx_hash: entry.transaction.hash, block_hash: blockHash, block_number: '101', occurred_at: time,
    payload: encodeFreshEvidence(entry), wallet_addresses: [...entry.wallets], decoder_status: 'pending', last_error: 'original_failure' }));
  const calls: { sql: string; params: unknown[] }[] = [];
  let canonical = blockHash;
  const query = vi.fn(async (sql: string, params: unknown[] = []): Promise<any> => {
    calls.push({ sql, params });
    if (sql.startsWith('SELECT e.payload')) return { rows: rows.map(row => ({ ...row, payload: Buffer.from(row.payload) })) };
    if (sql.startsWith('SELECT block_hash')) return { rows: [{ block_hash: canonical }] };
    if (sql.startsWith('SELECT payload')) return { rows: rows.filter(row => row.tx_hash === params[0]).map(row => ({ ...row })) };
    if (sql.startsWith('UPDATE fresh.recent_evidence')) { const row = rows.find(row => row.tx_hash === params[0])!; row.payload = params[2] as Buffer; return { rowCount: 1, rows: [] }; }
    return { rows: [], rowCount: 0 };
  });
  return { rows, calls, query, orphan() { canonical = hash('c'); },
    database: { query, connect: async () => ({ query, release() {} }) } as unknown as Pool };
}

describe('fresh urgent evidence preservation', () => {
  it('prioritizes wallet assets then intermediates, bounds token count and ignores malformed/spoof transfer shapes', () => {
    const entry = fixture(); expect(freshUrgentTokenTargets(entry)).toEqual([token, intermediary]);
    entry.receipt.logs[0].removed = true; expect(freshUrgentTokenTargets(entry)).toEqual([token]);
    entry.receipt.logs[0].removed = false; entry.receipt.logs[0].topics.push(hash('c')); expect(freshUrgentTokenTargets(entry)).toEqual([token]);
    expect(freshUrgentTokenTargets(fixture(), 1)).toEqual([token]);
  });
  it('captures fee-attribution precision for exact approvals and failed transfers without treating a router as a token', () => {
    const entry = fixture(), call = new Interface(['function approve(address,uint256)', 'function transfer(address,uint256)']); entry.receipt.logs = []; entry.transaction.to = token;
    entry.transaction.input = call.encodeFunctionData('approve', [other, 10]); expect(freshUrgentTokenTargets(entry)).toEqual([token]);
    entry.receipt.status = '0x0'; entry.transaction.input = call.encodeFunctionData('transfer', [other, 10]); expect(freshUrgentTokenTargets(entry)).toEqual([token]);
    entry.transaction.input += '00'; expect(freshUrgentTokenTargets(entry)).toEqual([]);
    entry.transaction.input = '0x12345678'; expect(freshUrgentTokenTargets(entry)).toEqual([]);
  });
  it('merges independent successes while preserving concurrent recovery, trace and original first diagnostics', () => {
    const selected = fixture(), latest = structuredClone(selected);
    latest.stateEvidence = proof([{ to: token, data: abi.encodeFunctionData('totalSupply'), result: abi.encodeFunctionResult('totalSupply', [100]) }]);
    const firstFailure = { version: 1 as const, at: latest.observedAt, reasons: ['trade_value_unavailable'] };
    latest.decodeDiagnostics = { version: 1, valuationReasons: ['trade_value_unavailable'], firstFailure };
    (latest as any).recoveryEvidence = { version: 1, original: 'recovery_proof' }; (latest as any).trace = { original: 'trace_proof' };
    const merged = decodeFreshEvidence(mergeFreshUrgentEvidence(selected, latest, proof())!);
    expect(merged.stateEvidence!.calls).toHaveLength(2); expect(merged.recoveryEvidence).toEqual(latest.recoveryEvidence);
    expect(merged.decodeDiagnostics).toEqual(latest.decodeDiagnostics); expect(merged.trace).toEqual(latest.trace);
    expect(merged.receipt).toEqual(latest.receipt); expect(merged.transaction).toEqual(latest.transaction);
    expect(mergeFreshUrgentEvidence(merged, merged, proof())).toBeNull();
  });
  it('rejects conflicting, wrong block/current and inconsistent wallet proof without replacing existing bytes', () => {
    const selected = fixture(), latest = structuredClone(selected); latest.stateEvidence = proof(); const original = encodeFreshEvidence(latest);
    expect(() => mergeFreshUrgentEvidence(selected, latest, proof([{ ...proof().calls[0], result: abi.encodeFunctionResult('decimals', [6]) }]))).toThrow('urgent_state_evidence_conflict');
    expect(() => mergeFreshUrgentEvidence(selected, latest, { ...proof(), blockHash: hash('c') })).toThrow('urgent_state_evidence_invalid');
    expect(() => mergeFreshUrgentEvidence(selected, latest, { ...proof(), blockNumber: 102 })).toThrow('urgent_state_evidence_invalid');
    expect(() => mergeFreshUrgentEvidence(selected, { ...latest, wallets: [other] }, proof())).toThrow('urgent_receipt_context_changed');
    expect(encodeFreshEvidence(latest)).toEqual(original);
  });
  it('rechecks canonical header and latest registration wallet context before saving and has no financial writer', async () => {
    const entry = fixture(), db = memory([entry]); db.orphan();
    expect(await persistFreshUrgentEvidence(db.database, entry, proof())).toBe(false);
    expect(db.calls.some(call => call.sql.startsWith('UPDATE'))).toBe(false);
    const current = memory([entry]); current.rows[0].wallet_addresses = [other];
    await expect(persistFreshUrgentEvidence(current.database, entry, proof())).rejects.toThrow('urgent_wallet_context_changed');
    expect(current.calls.at(-1)!.sql).toBe('ROLLBACK');
    expect(current.calls.some(call => /financial_events|fresh.jobs|UPDATE fresh.checkpoints/.test(call.sql))).toBe(false);
  });
  it('durably saves a successful decimals sibling before a stalled supply call ends; failed reads never become proof', async () => {
    const now = new Date(), entry = fixture(txHash, now), db = memory([entry], now); let release!: () => void, blocked = false;
    const supplied = new Promise<void>(resolve => { release = resolve; });
    const rpc: Rpc = async <T>(_method: string, params: unknown[]) => {
      expect(params[1]).toEqual({ blockHash, requireCanonical: true });
      const call = params[0] as { to: string; data: string };
      if (call.to === token && call.data === abi.encodeFunctionData('decimals')) return abi.encodeFunctionResult('decimals', [18]) as T;
      if (call.to === token && call.data === abi.encodeFunctionData('totalSupply')) { blocked = true; await supplied; }
      throw Error('historical_state_unavailable');
    };
    const run = createFreshUrgentEvidenceCapture(db.database, rpc)({ now });
    await vi.waitFor(() => { expect(blocked).toBe(true); expect(decodeFreshEvidence(db.rows[0].payload).stateEvidence?.calls).toEqual(proof().calls); });
    expect(db.rows[0].decoder_status).toBe('pending'); expect(db.rows[0].last_error).toBe('original_failure'); release();
    const result = await run; expect(result.saved).toBe(1); expect(result.unavailable).toBe(1);
    expect(db.calls.every(call => !/financial_events|fresh.jobs|UPDATE fresh.checkpoints/.test(call.sql))).toBe(true);
  });
  it('bounds concurrent RPC, retains only exact canonical state and selects newest serviceable evidence independent of old repairs', async () => {
    const now = new Date(), db = memory([fixture(hash('b'), now), fixture(hash('c'), now), fixture(hash('d'), now), fixture(hash('e'), now)], now);
    let active = 0, max = 0;
    const rpc: Rpc = async <T>(method: string, params: unknown[]) => {
      expect(method).toBe('eth_call'); expect(params[1]).toEqual({ blockHash, requireCanonical: true });
      active++; max = Math.max(max, active); await new Promise(resolve => setTimeout(resolve, 1)); active--; return `0x${'0'.repeat(63)}1` as T;
    };
    const result = await createFreshUrgentEvidenceCapture(db.database, rpc)({ now });
    expect(max).toBeLessThanOrEqual(2); expect(result.rpcCalls).toBeLessThanOrEqual(FRESH_URGENT_EVIDENCE_MAX_RPC); expect(result.receipts).toBe(4);
    const selection = db.calls[0]; expect(selection.sql).toMatch(/b.occurred_at>=\$1/); expect(selection.sql).toMatch(/ORDER BY e.block_number DESC/); expect(selection.params[2]).toBe(32);
    expect(decodeFreshEvidence(db.rows[0].payload).stateEvidence!.calls.length).toBeGreaterThan(0);
  });
  it('does not start old/current substitutions or keep retrying a fixed failed top candidate ahead of fresh lower rows', async () => {
    const now = new Date(), entries = [fixture(hash('b'), now), fixture(hash('c'), now)], db = memory(entries, now);
    const rpc = vi.fn(async () => { throw Error('state_unavailable'); }) as unknown as Rpc, capture = createFreshUrgentEvidenceCapture(db.database, rpc);
    expect((await capture({ now, limit: 1 })).receipts).toBe(1);
    expect((await capture({ now, limit: 1 })).receipts).toBe(1);
    expect((await capture({ now, limit: 1 })).receipts).toBe(0);
    const old = memory([fixture(txHash, now)], new Date(now.getTime() - 60_000)), oldRpc = vi.fn(async () => '0x') as unknown as Rpc;
    const result = await createFreshUrgentEvidenceCapture(old.database, oldRpc)({ now }); expect(result.rpcCalls).toBe(0); expect(oldRpc).not.toHaveBeenCalled();
  });
  it('rechecks the pass deadline after waiting for a wire slot without abandoning either in-flight request', async () => {
    const now = new Date(), db = memory([fixture(hash('b'), now), fixture(hash('c'), now)], now); let elapsed = 0, release!: () => void;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => elapsed), wait = new Promise<void>(resolve => { release = resolve; });
    const rpc = vi.fn(async () => { await wait; return abi.encodeFunctionResult('decimals', [18]); }) as unknown as Rpc;
    try {
      const work = createFreshUrgentEvidenceCapture(db.database, rpc)({ now });
      await vi.waitFor(() => expect(rpc).toHaveBeenCalledTimes(2)); elapsed = 9_000; release();
      const result = await work; expect(rpc).toHaveBeenCalledTimes(2); expect(result.rpcCalls).toBeGreaterThanOrEqual(2);
      expect(decodeFreshEvidence(db.rows[0].payload).stateEvidence!.calls.length).toBe(2);
    } finally { release(); clock.mockRestore(); }
  });
  it('enforces a hard per-pass wire budget even with eight receipts and distinct intermediate assets', async () => {
    const now = new Date(), entries = Array.from({ length: 8 }, (_, index) => {
      const entry = fixture(`0x${(index + 1).toString(16).padStart(64, '0')}`, now), first = entry.receipt.logs[1];
      entry.receipt.logs = Array.from({ length: 8 }, (__, asset) => ({ ...first, address: `0x${(index * 8 + asset + 100).toString(16).padStart(40, '0')}`, logIndex: `0x${asset.toString(16)}` })); return entry;
    });
    const db = memory(entries, now), rpc = vi.fn(async () => word('0x1')) as unknown as Rpc;
    const result = await createFreshUrgentEvidenceCapture(db.database, rpc)({ now, limit: 8 });
    expect(result.rpcCalls).toBe(FRESH_URGENT_EVIDENCE_MAX_RPC); expect(rpc).toHaveBeenCalledTimes(FRESH_URGENT_EVIDENCE_MAX_RPC);
  });
});
