import { describe, expect, it, vi } from 'vitest';
import { advanceNodeDecodeCheckpoints, bootstrapNodeCapture, collectNodeEvidenceRange, findNodeEvidenceReorgStart, loadNodeEvidenceRange, nodeCaptureStart, nodeCaptureRangeEnd, rollbackNodeEvidence, type NodeRpc } from './nodeEvidence.js';
import { transferTopic } from './swap.js';
import type { NodeBlock, NodeReceipt, NodeTransaction } from './nodeExecution.js';
const wallet = `0x${'a'.repeat(40)}`, other = `0x${'b'.repeat(40)}`, hash = `0x${'1'.repeat(64)}`, blockHash = `0x${'2'.repeat(64)}`;
const tx: NodeTransaction = { hash, from: wallet, to: other, value: '0x42', blockNumber: '0x64', blockHash, transactionIndex: '0x0', gasPrice: '0x2' };
const block: NodeBlock = { number: '0x64', hash: blockHash, parentHash: `0x${'3'.repeat(64)}`, timestamp: '0x1234', transactions: [tx] };
const receipt: NodeReceipt = { transactionHash: hash, blockNumber: '0x64', transactionIndex: '0x0', status: '0x1', blockHash, gasUsed: '0x64', logs: [] };
function rpcFixture(overrides: { block?: NodeBlock; receipt?: NodeReceipt | null } = {}) {
  return vi.fn(async (method: string, _params: unknown[]) => method === 'eth_getBlockByNumber' ? overrides.block ?? block : method === 'eth_getLogs' ? [] : method === 'eth_getTransactionReceipt' ? 'receipt' in overrides ? overrides.receipt : receipt : null) as unknown as NodeRpc;
}
const options = { from: 100, to: 100, head: 106, wallets: new Set([wallet]) };
describe('durable raw node collection', () => {
  it('amortizes catch-up work without skipping or reading beyond the confirmed target', () => {
    expect(nodeCaptureRangeEnd(100, 70_000)).toBe(611);
    expect(nodeCaptureRangeEnd(100, 612)).toBe(227);
    expect(nodeCaptureRangeEnd(100, 613)).toBe(611);
    expect(nodeCaptureRangeEnd(100, 150)).toBe(150);
    expect(nodeCaptureRangeEnd(100, 100)).toBe(100);
    expect(() => nodeCaptureRangeEnd(100, 99)).toThrow('range_invalid');
  });
  it('discovers native-only and failed sender transactions from full block bodies', async () => {
    const rpc = rpcFixture({ receipt: { ...receipt, status: '0x0' } });
    const result = await loadNodeEvidenceRange({ ...options, rpc });
    expect(result.entries).toHaveLength(1); expect(result.entries[0].receipt.status).toBe('0x0'); expect(result.entries[0].wallets.has(wallet)).toBe(true);
    expect(rpc).toHaveBeenCalledWith('eth_getBlockByNumber', ['0x64', true]);
  });
  it('requires six confirmations and exact requested block bodies', async () => {
    await expect(loadNodeEvidenceRange({ ...options, head: 105, rpc: rpcFixture() })).rejects.toThrow('range_invalid');
    await expect(loadNodeEvidenceRange({ ...options, rpc: rpcFixture({ block: { ...block, number: '0x65' } }) })).rejects.toThrow('incorrect block');
    await expect(loadNodeEvidenceRange({ ...options, rpc: rpcFixture({ block: { ...block, transactions: undefined } }) })).rejects.toThrow('body_invalid');
  });
  it('rejects missing receipts, wrong hashes and noncanonical transaction/log positions', async () => {
    await expect(loadNodeEvidenceRange({ ...options, rpc: rpcFixture({ receipt: null }) })).rejects.toThrow('incomplete');
    await expect(loadNodeEvidenceRange({ ...options, rpc: rpcFixture({ receipt: { ...receipt, blockHash: `0x${'f'.repeat(64)}` } }) })).rejects.toThrow('hash');
    await expect(loadNodeEvidenceRange({ ...options, rpc: rpcFixture({ receipt: { ...receipt, transactionIndex: undefined } }) })).rejects.toThrow('identity_incomplete');
  });
  it('captures transfers before first buys without metadata calls or token exclusions', async () => {
    const inboundTx = { ...tx, from: other }, log = { address: `0x${'c'.repeat(40)}`, topics: [transferTopic, `0x${other.slice(2).padStart(64, '0')}`, `0x${wallet.slice(2).padStart(64, '0')}`], data: `0x${'0'.repeat(63)}1`, transactionHash: hash, blockHash, blockNumber: '0x64', logIndex: '0x1' };
    const rpc = vi.fn(async (method: string) => method === 'eth_getBlockByNumber' ? { ...block, transactions: [inboundTx] } : method === 'eth_getLogs' ? [log] : { ...receipt, logs: [log] }) as unknown as NodeRpc;
    const result = await loadNodeEvidenceRange({ ...options, rpc });
    expect(result.entries[0].wallets).toEqual(new Set([wallet])); expect(rpc).not.toHaveBeenCalledWith('eth_call', expect.anything());
  });
  it('does not write any checkpoint when collection is incomplete', async () => {
    const query = vi.fn(async (_sql: string, _values?: any[]) => ({ rows: [] })), connect = vi.fn();
    await expect(collectNodeEvidenceRange({ ...options, database: { query, connect } as any, generations: new Map([[wallet, 'generation']]), rpc: rpcFixture({ receipt: null }) })).rejects.toThrow('incomplete');
    expect(connect).not.toHaveBeenCalled(); expect(query).toHaveBeenCalledTimes(1); expect(query.mock.calls[0][0]).toMatch(/^SELECT/);
  });
  it('fails when the node log query and complete receipt disagree', async () => {
    const log = { address: other, topics: [transferTopic], data: '0x', blockHash, blockNumber: '0x64', transactionHash: hash, logIndex: '0x1' };
    const rpc = vi.fn(async (method: string) => method === 'eth_getBlockByNumber' ? block : method === 'eth_getLogs' ? [log] : receipt) as unknown as NodeRpc;
    await expect(loadNodeEvidenceRange({ ...options, rpc })).rejects.toThrow('log_range_mismatch');
  });
  it('overlaps independent log filters and bounds required receipt loading at eight', async () => {
    const transactions = Array.from({ length: 19 }, (_, index) => ({ ...tx, hash: `0x${(index + 1).toString(16).padStart(64, '0')}`, transactionIndex: `0x${index.toString(16)}` }));
    let receiptsActive = 0, receiptsMax = 0, logsActive = 0, logsMax = 0;
    const rpc = vi.fn(async (method: string, params: unknown[]) => {
      if (method === 'eth_getBlockByNumber') return { ...block, transactions };
      if (method === 'eth_getLogs') { logsMax = Math.max(logsMax, ++logsActive); await Promise.resolve(); logsActive--; return []; }
      if (method === 'eth_getTransactionReceipt') {
        receiptsMax = Math.max(receiptsMax, ++receiptsActive); await Promise.resolve(); receiptsActive--;
        const found = transactions.find(item => item.hash === params[0])!;
        return { ...receipt, transactionHash: found.hash, transactionIndex: found.transactionIndex };
      }
      return null;
    }) as unknown as NodeRpc;
    const result = await loadNodeEvidenceRange({ ...options, rpc });
    expect(result.entries.map(entry => entry.transaction.hash)).toEqual(transactions.map(item => item.hash));
    expect(logsMax).toBe(3); expect(receiptsMax).toBe(8);
    expect(result.timings).toMatchObject({ blockLoadMs: expect.any(Number), discoveryMs: expect.any(Number), receiptLoadMs: expect.any(Number) });
  });
  it('commits receipts, headers, membership generations and checkpoint in one transaction', async () => {
    const fingerprint = 'f'.repeat(64);
    const calls: { sql: string; values: any[] }[] = [], client = { query: vi.fn(async (sql: string, values: any[] = []) => {
      calls.push({ sql, values }); return { rows: sql.includes('INSERT INTO node_evidence_cohorts') ? [{ fingerprint }] : [] };
    }), release: vi.fn() };
    const database = { query: vi.fn(async (_sql: string, _values?: any[]) => ({ rows: [] })), connect: vi.fn(async () => client) };
    await collectNodeEvidenceRange({ ...options, database: database as any, rpc: rpcFixture(), generations: new Map([[wallet, 'generation']]) });
    expect(calls[0].sql).toBe('BEGIN'); expect(calls.at(-1)?.sql).toBe('COMMIT');
    expect(calls.findIndex(item => item.sql.includes('INSERT INTO node_evidence_transactions'))).toBeLessThan(calls.findIndex(item => item.sql.includes("VALUES('node_collection'")));
    expect(calls.find(item => item.sql.includes('INSERT INTO node_evidence_ranges'))?.values[4]).toBe(JSON.stringify({ [wallet]: 'generation' }));
    expect(calls.find(item => item.sql.includes('INSERT INTO node_evidence_ranges'))?.values[5]).toBe(fingerprint);
    expect(calls.findIndex(item => item.sql.includes('INSERT INTO node_evidence_cohorts'))).toBeLessThan(calls.findIndex(item => item.sql.includes('INSERT INTO node_evidence_ranges')));
    const headerWrites = calls.filter(item => item.sql.includes('INSERT INTO node_evidence_blocks'));
    expect(headerWrites).toHaveLength(1);
    expect(JSON.parse(headerWrites[0].values[0])).toEqual([{ block_number: '100', block_hash: blockHash,
      parent_hash: block.parentHash, timestamp_seconds: 4660, header: { ...block, transactions: undefined } }]);
  });
  it('rejects an existing conflicting header before any batch header or checkpoint write', async () => {
    const query = vi.fn(async (sql: string, _values?: any[]) => ({ rows: sql.includes('block_number=ANY') ? [{ block_number: '100', block_hash: `0x${'f'.repeat(64)}` }] : [] }));
    const database = { query: vi.fn(async () => ({ rows: [] })), connect: vi.fn(async () => ({ query, release: vi.fn() })) };
    await expect(collectNodeEvidenceRange({ ...options, database: database as any, rpc: rpcFixture(), generations: new Map([[wallet, 'generation']]) })).rejects.toThrow('node_collection_block_changed');
    expect(query.mock.calls.some(call => call[0].includes('INSERT INTO node_evidence_blocks'))).toBe(false);
    expect(query).toHaveBeenCalledWith('ROLLBACK');
  });
  it('rolls back both evidence and checkpoints if the atomic write fails', async () => {
    const query = vi.fn(async (sql: string) => { if (sql.includes('INSERT INTO node_evidence_transactions')) throw new Error('disk full'); return { rows: [] }; });
    const database = { query: vi.fn(async (_sql: string, _values?: any[]) => ({ rows: [] })), connect: vi.fn(async () => ({ query, release: vi.fn() })) };
    await expect(collectNodeEvidenceRange({ ...options, database: database as any, rpc: rpcFixture(), generations: new Map([[wallet, 'generation']]) })).rejects.toThrow('disk full');
    expect(query).toHaveBeenCalledWith('ROLLBACK'); expect(query).not.toHaveBeenCalledWith('COMMIT');
  });
  it('invalidates orphan execution evidence and both checkpoints after a fork', async () => {
    const query = vi.fn(async (_sql: string, _values?: any[]) => ({ rows: [] })); await rollbackNodeEvidence({ query } as any, 100);
    const sql = query.mock.calls.map(call => call[0]).join('\n'); expect(sql).toContain('DELETE FROM node_evidence_transactions'); expect(sql).toContain('decoded_through_block=LEAST'); expect(sql).toContain("'node_collection','node'");
  });
  it('finds deep common ancestors from retained headers without scanning every block', async () => {
    const query = vi.fn(async (sql: string, values?: any[]) => ({ rows: sql.includes('MIN(block_number)') ? [{ first: '100', last: '10000' }] : [{ block_hash: `0x${String(values![0]).padStart(64, '0')}` }] }));
    const canonical = vi.fn(async (height: number) => `0x${String(height <= 150 ? height : height + 100000).padStart(64, '0')}`);
    expect(await findNodeEvidenceReorgStart({ query } as any, canonical)).toBe(151);
    expect(canonical.mock.calls.length).toBeLessThan(32);
  });
  it('pauses a reorg audit when the canonical node cannot prove the ancestor', async () => {
    const query = vi.fn(async (sql: string) => ({ rows: sql.includes('MIN(block_number)') ? [{ first: '100', last: '200' }] : [{ block_hash: blockHash }] }));
    await expect(findNodeEvidenceReorgStart({ query } as any, async () => null)).rejects.toThrow('canonical_unavailable');
  });
  it('advances pool coverage and its selected checkpoint in one rollback-protected transaction', async () => {
    const query = vi.fn(async (sql: string, _values?: any[]) => ({ rows: sql.startsWith('SELECT r.to_block') ? [{ to_block: '100', head_block: '106', block_hash: blockHash }] : [] }));
    const release = vi.fn(), connect = vi.fn(async () => ({ query, release }));
    await advanceNodeDecodeCheckpoints({ query: vi.fn(), connect } as any);
    const sql = query.mock.calls.map(call => call[0]);
    expect(connect).toHaveBeenCalledOnce(); expect(sql[0]).toBe('BEGIN'); expect(sql[1]).toBe('SELECT pg_advisory_xact_lock_shared(782319)');
    expect(sql.at(-1)).toBe('COMMIT'); expect(sql.some(value => value.includes("VALUES('node'"))).toBe(true); expect(release).toHaveBeenCalledOnce();
  });
  it('leaves an existing client transaction open and does not nest or commit it', async () => {
    const query = vi.fn(async (_sql: string, _values?: any[]) => ({ rows: [] })), release = vi.fn();
    await advanceNodeDecodeCheckpoints({ query, release } as any);
    const sql = query.mock.calls.map(call => call[0]);
    expect(sql[0]).toBe('SELECT pg_advisory_xact_lock_shared(782319)'); expect(sql).not.toContain('BEGIN'); expect(sql).not.toContain('COMMIT'); expect(release).not.toHaveBeenCalled();
  });
  it('rolls back the entire coverage advance when the checkpoint write fails', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("VALUES('node'")) throw new Error('checkpoint_write_failed');
      return { rows: sql.startsWith('SELECT r.to_block') ? [{ to_block: '100', head_block: '106', block_hash: blockHash }] : [] };
    }), release = vi.fn();
    await expect(advanceNodeDecodeCheckpoints({ query: vi.fn(), connect: async () => ({ query, release }) } as any)).rejects.toThrow('checkpoint_write_failed');
    expect(query).toHaveBeenCalledWith('ROLLBACK'); expect(query).not.toHaveBeenCalledWith('COMMIT'); expect(release).toHaveBeenCalledOnce();
  });
  it('uses the durable cursor instead of old prototype header maxima', async () => {
    const query = vi.fn(async (_sql: string) => ({ rows: [{ value: { blockNumber: 100, blockHash } }] }));
    expect(await nodeCaptureStart({ query } as any, { target: 110, configuredStart: 1 })).toBe(101);
    expect(query).toHaveBeenCalledOnce(); expect(query.mock.calls[0][0]).toContain("key='node_collection'");
  });
  it('never implicitly skips a pruned legacy gap or treats prototype headers as completed coverage', async () => {
    const query = vi.fn(async (sql: string) => ({ rows: sql.includes("key='node_collection'") ? [] : [{ present: true }] }));
    await expect(nodeCaptureStart({ query } as any, { target: 1000000, configuredStart: 900000 })).rejects.toThrow('bootstrap_required');
    expect(query.mock.calls.every(call => call[0].startsWith('SELECT'))).toBe(true);
  });
  it('starts an empty application from a bounded fresh window and requires explicit bootstrap consent', async () => {
    const query = vi.fn(async (sql: string) => ({ rows: sql.includes("key='node_collection'") ? [] : [{ present: false }] }));
    expect(await nodeCaptureStart({ query } as any, { target: 100 })).toBe(88);
    const rpc = vi.fn(); await expect(bootstrapNodeCapture({ database: { query } as any, rpc: rpc as NodeRpc, enabled: false })).rejects.toThrow('not_enabled');
    expect(rpc).not.toHaveBeenCalled(); expect(query.mock.calls.every(call => call[0].startsWith('SELECT'))).toBe(true);
  });
  it('does not reset a fully current durable generation when bootstrap is unnecessary', async () => {
    const query = vi.fn(async (sql: string, _values?: any[]) => ({ rows: sql.includes("WHERE key='node_collection' FOR UPDATE") ? [{ value: { blockNumber: 100, blockHash } }] : [] }));
    const rpc = vi.fn(async (method: string) => method === 'eth_blockNumber' ? '0x6a' : block) as unknown as NodeRpc;
    const result = await bootstrapNodeCapture({ database: { query: vi.fn(), connect: async () => ({ query, release: vi.fn() }) } as any, rpc, enabled: true });
    expect(result.alreadyApplied).toBe(true); expect(query.mock.calls.some(call => /INSERT|UPDATE node_monitored/.test(call[0]))).toBe(false);
  });
});
