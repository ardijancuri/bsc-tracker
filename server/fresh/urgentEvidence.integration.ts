/** All fixture mutations remain inside one rolled-back local transaction. */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { Interface } from 'ethers';
import { Pool } from 'pg';
import type { Rpc } from '../rpc.js';
import { transferTopic } from '../swap.js';
import { decodeFreshEvidence, encodeFreshEvidence, type FreshCapturedReceipt } from './capture.js';
import { createFreshUrgentEvidenceCapture, persistFreshUrgentEvidence } from './urgentEvidence.js';
import type { FreshStateReadEvidence } from './stateEvidence.js';
const url = new URL(process.env.DATABASE_URL ?? '');
if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.port !== '5436' || !url.pathname.includes('fresh')) throw Error('Isolated local fresh database required');
const database = new Pool({ connectionString: url.toString(), max: 1 }), client = await database.connect();
const addr = () => `0x${randomBytes(20).toString('hex')}`, hash = () => `0x${randomBytes(32).toString('hex')}`, word = (value: string) => `0x${value.slice(2).padStart(64, '0')}`;
const wallet = addr(), other = addr(), token = addr(), transactionHash = hash(), blockHash = hash(), now = new Date();
const abi = new Interface(['function decimals() view returns(uint8)', 'function totalSupply() view returns(uint256)']);
try {
  await client.query('BEGIN'); await client.query('SELECT pg_advisory_xact_lock(73621941)');
  const number = Number((await client.query("SELECT block_number FROM fresh.checkpoints WHERE key='capture'")).rows[0].block_number) + 100, hex = `0x${number.toString(16)}`;
  const entry: FreshCapturedReceipt = { transaction: { hash: transactionHash, from: other, to: other, value: '0x0', blockHash, blockNumber: hex, transactionIndex: '0x0', gasPrice: '0x0' },
    receipt: { transactionHash, transactionIndex: '0x0', blockHash, blockNumber: hex, status: '0x1', gasUsed: '0x5208', effectiveGasPrice: '0x0', logs: [{ address: token,
      topics: [transferTopic, word(other), word(wallet)], data: word('0xa'), logIndex: '0x0', transactionHash, transactionIndex: '0x0', blockHash, blockNumber: hex }] }, wallets: [wallet], observedAt: now.toISOString() };
  await client.query('INSERT INTO fresh.recent_blocks(block_number,block_hash,parent_hash,occurred_at) VALUES($1,$2,$3,$4)', [number, blockHash, hash(), now]);
  await client.query("INSERT INTO fresh.recent_evidence(tx_hash,block_hash,block_number,transaction_index,payload,expires_at,wallet_addresses,decoder_status,last_error) VALUES($1,$2,$3,0,$4,$5,$6,'repair','original_failure')",
    [transactionHash, blockHash, number, encodeFreshEvidence(entry), new Date(now.getTime() + 72 * 3_600_000), [wallet]]);
  let statements: string[] = [];
  const query = async (sql: string, params?: unknown[]) => {
    statements.push(sql);
    if (sql === 'BEGIN') return client.query('SAVEPOINT urgent_fixture');
    if (sql === 'COMMIT') return client.query('RELEASE SAVEPOINT urgent_fixture');
    if (sql === 'ROLLBACK') return client.query('ROLLBACK TO SAVEPOINT urgent_fixture');
    if (sql.startsWith('SELECT e.payload')) return client.query('SELECT e.*,b.occurred_at FROM fresh.recent_evidence e JOIN fresh.recent_blocks b USING(block_number,block_hash) WHERE e.tx_hash=$1', [transactionHash]);
    return client.query(sql, params);
  };
  const db = { query, connect: async () => ({ query, release() {} }) } as unknown as Pool;
  const rpc: Rpc = async <T>(method: string, params: unknown[]): Promise<T> => {
    assert.equal(method, 'eth_call'); assert.deepEqual(params[1], { blockHash, requireCanonical: true });
    const call = params[0] as { to: string; data: string };
    if (call.to === token && call.data === abi.encodeFunctionData('decimals')) return abi.encodeFunctionResult('decimals', [18]) as T;
    throw Error('unavailable_fixture_supply_or_quote');
  };
  const result = await createFreshUrgentEvidenceCapture(db, rpc)({ now }); assert.equal(result.receipts, 1); assert.equal(result.saved, 1);
  const saved = (await client.query('SELECT * FROM fresh.recent_evidence WHERE tx_hash=$1', [transactionHash])).rows[0], retained = decodeFreshEvidence(saved.payload);
  assert.equal(saved.decoder_status, 'repair'); assert.equal(saved.last_error, 'original_failure');
  assert.equal(retained.stateEvidence!.calls.length, 1); assert.deepEqual(retained.receipt, entry.receipt); assert.deepEqual(retained.transaction, entry.transaction);
  assert.ok(!statements.some(sql => /financial_events|fresh.jobs|UPDATE fresh.checkpoints/.test(sql)));
  // A later recovery/diagnostic edit has won the row before this urgent writer
  // reaches its lock. Merge into those latest bytes, never its earlier copy.
  const firstFailure = { version: 1 as const, at: now.toISOString(), reasons: ['original_failure'] };
  retained.decodeDiagnostics = { version: 1, valuationReasons: ['original_failure'], firstFailure };
  (retained as any).recoveryEvidence = { version: 1, concurrent: 'retained_proof' };
  await client.query('UPDATE fresh.recent_evidence SET payload=$2 WHERE tx_hash=$1', [transactionHash, encodeFreshEvidence(retained)]);
  const supply: FreshStateReadEvidence = { version: 1, blockNumber: number, blockHash, calls: [{ to: token, data: abi.encodeFunctionData('totalSupply'), result: abi.encodeFunctionResult('totalSupply', [1000]) }] };
  assert.equal(await persistFreshUrgentEvidence(db, entry, supply), true);
  const merged = decodeFreshEvidence((await client.query('SELECT payload FROM fresh.recent_evidence WHERE tx_hash=$1', [transactionHash])).rows[0].payload);
  assert.equal(merged.stateEvidence!.calls.length, 2); assert.deepEqual(merged.decodeDiagnostics, retained.decodeDiagnostics); assert.deepEqual(merged.recoveryEvidence, retained.recoveryEvidence);
  const before = encodeFreshEvidence(merged);
  await client.query('UPDATE fresh.recent_evidence SET wallet_addresses=$2 WHERE tx_hash=$1', [transactionHash, [other]]);
  await assert.rejects(persistFreshUrgentEvidence(db, entry, supply), /urgent_wallet_context_changed/);
  await client.query('UPDATE fresh.recent_evidence SET wallet_addresses=$2 WHERE tx_hash=$1', [transactionHash, [wallet]]);
  const conflict = { ...supply, calls: [{ ...supply.calls[0], result: abi.encodeFunctionResult('totalSupply', [2000]) }] };
  await assert.rejects(persistFreshUrgentEvidence(db, entry, conflict), /urgent_state_evidence_conflict/);
  assert.deepEqual((await client.query('SELECT payload FROM fresh.recent_evidence WHERE tx_hash=$1', [transactionHash])).rows[0].payload, before);
  await client.query('UPDATE fresh.recent_blocks SET block_hash=$2 WHERE block_number=$1', [number, hash()]);
  assert.equal(await persistFreshUrgentEvidence(db, entry, supply), false);
  assert.equal((await client.query('SELECT count(*) FROM fresh.financial_events WHERE transaction_hash=$1', [transactionHash])).rows[0].count, '0');
  console.log(JSON.stringify({ ok: true, checks: ['near_head_metadata_retained_without_financial_writes', 'failed_supply_stays_unavailable', 'exact_block_state_only', 'locked_latest_proof_and_first_failure_preserved', 'registration_context_conflict_rejected', 'canonical_reorg_rejected', 'conflicting_proof_rejected', 'original_receipt_preserved'], fixtureWrites: 'rolled back' }));
} finally { await client.query('ROLLBACK'); client.release(); await database.end(); }
