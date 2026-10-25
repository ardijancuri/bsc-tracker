/** Isolated local fixtures only; all writes roll back. No VPS or provider writes. */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import type { Rpc } from '../rpc.js';
import { ensureFreshSchema } from './schema.js';
import { commitFreshRegistrationPage, queueFreshRegistrationRepair, runFreshRegistrationRepair, type FreshRegistrationProgress } from './registration.js';
import { decodeFreshEvidence, encodeFreshEvidence, FRESH_EVIDENCE_TTL_MS, type FreshCapturedReceipt, type FreshBlock, type FreshCapturedPage } from './capture.js';
import { rollbackFreshToAncestor } from './decode.js';
import { transferTopic } from '../swap.js';
const url = new URL(process.env.DATABASE_URL ?? '');
if (!['127.0.0.1', 'localhost'].includes(url.hostname) || !url.pathname.includes('fresh')) throw new Error('Use an isolated local fresh database');
const db = new Pool({ connectionString: url.toString(), max: 2 }), client = await db.connect();
const addr = () => `0x${randomBytes(20).toString('hex')}`, hash = () => `0x${randomBytes(32).toString('hex')}`, word = (value: string) => `0x${value.slice(2).padStart(64, '0')}`;
const existingWallet = addr(), newWallet = addr(), token = addr(), now = new Date(), observedAt = new Date(now.getTime() - 30_000).toISOString();
try {
  await ensureFreshSchema(db); await client.query('BEGIN');
  // Match live reorg processing: acquire the financial lock before capture rows.
  await client.query('SELECT pg_advisory_xact_lock(73621941)');
  const saved = (await client.query("SELECT * FROM fresh.checkpoints WHERE key='capture' FOR UPDATE")).rows[0];
  assert.ok(saved, 'Initialize fresh tracking first');
  const base = Number(saved.block_number) + 100, parentHash = hash(), hashes = [hash(), hash(), hash()];
  await client.query("UPDATE fresh.checkpoints SET block_number=$1,block_hash=$2,value=jsonb_set(jsonb_set(value,'{startBlock}',to_jsonb($3::bigint)),'{startHash}',to_jsonb($4::text)) WHERE key='capture'", [base + 3, hashes[2], base, parentHash]);
  for (const wallet of [existingWallet, newWallet]) await client.query('INSERT INTO fresh.wallets(address,monitoring_from_block) VALUES($1,$2)', [wallet, base + 1]);
  const txHash = hash(), transaction = { hash: txHash, from: existingWallet, to: token, value: '0x0', blockNumber: `0x${(base + 1).toString(16)}`, blockHash: hashes[0], transactionIndex: '0x0', gasPrice: '0x1' };
  const entry: FreshCapturedReceipt = { transaction, receipt: { transactionHash: txHash, transactionIndex: '0x0', blockHash: hashes[0], blockNumber: transaction.blockNumber,
    status: '0x1', gasUsed: '0x5208', effectiveGasPrice: '0x1', logs: [{ address: token, topics: [transferTopic, word(existingWallet), word(newWallet)], data: word('0x64'), logIndex: '0x0',
      transactionHash: txHash, transactionIndex: '0x0', blockNumber: transaction.blockNumber, blockHash: hashes[0] }] }, wallets: [existingWallet], observedAt,
    trace: { type: 'CALL', from: existingWallet, to: token, value: '0x0' } };
  const blocks: FreshBlock[] = hashes.map((blockHash, index) => ({ number: `0x${(base + index + 1).toString(16)}`, hash: blockHash, parentHash: index === 0 ? parentHash : hashes[index - 1],
    timestamp: `0x${Math.floor(now.getTime() / 1_000).toString(16)}`, transactions: index === 0 ? [transaction] : [] }));
  for (const block of blocks) await client.query('INSERT INTO fresh.recent_blocks(block_number,block_hash,parent_hash,occurred_at,captured_at) VALUES($1,$2,$3,$4,$4)', [Number(BigInt(block.number)), block.hash, block.parentHash, new Date(observedAt)]);
  const expiry = new Date(Date.parse(observedAt) + FRESH_EVIDENCE_TTL_MS);
  await client.query("INSERT INTO fresh.recent_evidence(tx_hash,block_hash,block_number,transaction_index,payload,wallet_addresses,expires_at,decoder_status) VALUES($1,$2,$3,0,$4,$5,$6,'done')", [txHash, hashes[0], base + 1, encodeFreshEvidence(entry), [existingWallet], expiry]);
  const queued = await queueFreshRegistrationRepair(client, { wallet: newWallet, fromBlock: base + 1, targetBlock: base + 3, targetHash: hashes[2], now }); assert.equal(queued.queued, true);
  let job = (await client.query('SELECT * FROM fresh.jobs WHERE id=$1', [queued.jobId])).rows[0];
  assert.equal(job.progress.throughBlock, base); assert.equal(job.progress.throughHash, parentHash);
  const lease = randomUUID(); await client.query("UPDATE fresh.jobs SET lease_id=$2,lease_until=$3::timestamptz+interval '45 seconds' WHERE id=$1", [job.id, lease, now]); job.lease_id = lease;
  const incoming = { ...entry, trace: undefined, wallets: [newWallet], observedAt: now.toISOString() };
  const page: FreshCapturedPage = { previous: { blockNumber: base, blockHash: parentHash, revision: 0, startBlock: base, startHash: parentHash }, blocks: [blocks[0]], receipts: [incoming], launches: [] };
  assert.deepEqual(await commitFreshRegistrationPage(client, job, page, now), { blocks: 1, receipts: 1, completed: false });
  const merged = (await client.query('SELECT * FROM fresh.recent_evidence WHERE tx_hash=$1 AND block_hash=$2', [txHash, hashes[0]])).rows[0], body = decodeFreshEvidence(merged.payload);
  assert.deepEqual(body.wallets, [existingWallet, newWallet].sort()); assert.deepEqual(body.historicalWallets, [newWallet]); assert.equal(body.observedAt, observedAt); assert.deepEqual(body.trace, entry.trace);
  assert.deepEqual(body.receipt, entry.receipt); assert.equal(merged.decoder_status, 'pending'); assert.equal(new Date(merged.expires_at).getTime(), expiry.getTime());
  assert.equal((await client.query('SELECT count(*)::int n FROM fresh.recent_evidence WHERE tx_hash=$1', [txHash])).rows[0].n, 1);
  assert.equal(Number((await client.query("SELECT block_number FROM fresh.checkpoints WHERE key='capture'")).rows[0].block_number), base + 3);
  await queueFreshRegistrationRepair(client, { wallet: newWallet, fromBlock: base + 1, targetBlock: base + 3, targetHash: hashes[2], now });
  job = (await client.query('SELECT * FROM fresh.jobs WHERE id=$1', [queued.jobId])).rows[0]; assert.equal(job.progress.throughBlock, base + 1, 'Duplicate queueing must not restart completed pages');
  // A canonical reorg hands the future suffix back to normal live capture.
  await client.query('SAVEPOINT registration_reorg'); await rollbackFreshToAncestor(client, { blockNumber: base + 2, blockHash: hashes[1] }, now);
  const rewound = (await client.query('SELECT progress FROM fresh.jobs WHERE id=$1', [queued.jobId])).rows[0].progress;
  assert.equal(rewound.throughBlock, base + 1); assert.equal(rewound.targetBlock, base + 2); assert.equal(rewound.targetHash, hashes[1]); await client.query('ROLLBACK TO SAVEPOINT registration_reorg');
  const nextLease = randomUUID(); await client.query('UPDATE fresh.jobs SET lease_id=$2 WHERE id=$1', [job.id, nextLease]); job.lease_id = nextLease;
  const finalPage = { previous: { ...page.previous, blockNumber: base + 1, blockHash: hashes[0] }, blocks: blocks.slice(1), receipts: [], launches: [] };
  assert.deepEqual(await commitFreshRegistrationPage(client, job as { id: string; reference: string; lease_id: string; progress: FreshRegistrationProgress }, finalPage, now), { blocks: 2, receipts: 0, completed: true });
  assert.equal((await client.query('SELECT 1 FROM fresh.jobs WHERE id=$1', [job.id])).rowCount, 0);
  // Run the real lease/retry orchestration against fake node responses, using
  // savepoints so its transactions remain inside this rollback-only fixture.
  let txNumber = 0, missingReceipt = true, behind = true;
  const fixtureDb = { query: (sql: string, values?: any[]) => client.query(sql, values), async connect() {
    const point = `registration_fixture_${++txNumber}`;
    return { query: (sql: string, values?: any[]) => client.query(sql === 'BEGIN' ? `SAVEPOINT ${point}` : sql === 'COMMIT' ? `RELEASE SAVEPOINT ${point}` : sql === 'ROLLBACK' ? `ROLLBACK TO SAVEPOINT ${point}` : sql, values), release() {} } as unknown as PoolClient;
  } } as unknown as Pool;
  await client.query("UPDATE fresh.jobs SET due_at=$1::timestamptz+interval '1 day' WHERE kind='registration_capture'", [now]);
  const rpcCalls: string[] = [], rpc = (async (method: string, params: unknown[]) => {
    rpcCalls.push(method);
    if (method === 'eth_blockNumber') return `0x${(base + 3 + 6 + (behind ? 33 : 0)).toString(16)}`;
    if (method === 'eth_getBlockByNumber') return blocks.find(block => BigInt(block.number) === BigInt(String(params[0])));
    if (method === 'eth_getTransactionReceipt') return missingReceipt ? null : entry.receipt;
    if (method === 'eth_getLogs') { const filter = params[0] as { fromBlock: string; toBlock: string; topics: unknown[] }; return filter.topics[0] === transferTopic && BigInt(filter.fromBlock) <= BigInt(base + 1) && BigInt(filter.toBlock) >= BigInt(base + 1) ? entry.receipt.logs : []; }
    throw new Error('unexpected_registration_rpc');
  }) as Rpc;
  await queueFreshRegistrationRepair(client, { wallet: newWallet, fromBlock: base + 1, targetBlock: base + 3, now });
  const yielded = await runFreshRegistrationRepair(fixtureDb, rpc, { now, limitBlocks: 1 }); assert.equal('reason' in yielded?yielded.reason:null, 'live_capture_priority'); assert.deepEqual(rpcCalls, ['eth_blockNumber']);
  behind = false; const failed = await runFreshRegistrationRepair(fixtureDb, rpc, { now, limitBlocks: 1 }); assert.equal('reason' in failed?failed.reason:null, 'required_receipt_missing');
  const retry = (await client.query("SELECT progress,attempts,lease_id FROM fresh.jobs WHERE kind='registration_capture' AND reference=$1", [newWallet])).rows[0];
  assert.equal(retry.progress.throughBlock, base); assert.equal(retry.attempts, 1); assert.equal(retry.lease_id, null);
  missingReceipt = false; const resumedAt = new Date(now.getTime() + 31_000);
  const concurrent = await Promise.all([runFreshRegistrationRepair(fixtureDb, rpc, { now: resumedAt, limitBlocks: 1 }), runFreshRegistrationRepair(fixtureDb, rpc, { now: resumedAt, limitBlocks: 1 })]);
  assert.equal(concurrent.reduce((sum, result) => sum + result.blocks, 0), 1, 'Concurrent workers must share one leased page');
  const completed = await runFreshRegistrationRepair(fixtureDb, rpc, { now: resumedAt, limitBlocks: 2 }); assert.equal(completed.completed, true);
  assert.equal((await client.query("SELECT 1 FROM fresh.jobs WHERE kind='registration_capture' AND reference=$1", [newWallet])).rowCount, 0);
  await client.query('SAVEPOINT expired_registration'); await assert.rejects(queueFreshRegistrationRepair(client, { wallet: newWallet, fromBlock: base + 1, targetBlock: base + 3, now: new Date(now.getTime() + FRESH_EVIDENCE_TTL_MS) }), /registration_outside_repair_window/); await client.query('ROLLBACK TO SAVEPOINT expired_registration');
  console.log(JSON.stringify({ ok: true, checks: ['original_registration_boundary', 'atomic_page_progress', 'canonical_receipt_context_merge', 'no_duplicate_receipt_body', 'original_expiry_and_trace_preserved', 'repair_marked_historical', 'global_checkpoint_unchanged', 'duplicate_queue_resumption', 'reorg_target_handoff', 'live_capture_priority', 'missing_receipt_no_progress', 'concurrent_worker_lease', 'retry_resumption', 'completed_job_removed', '72h_repair_limit'], fixtureWrites: 'rolled back' }));
} finally { await client.query('ROLLBACK'); client.release(); await db.end(); }
