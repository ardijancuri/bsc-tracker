/** Synthetic transaction-rolled-back correction fixtures. Never commits. */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { getCreateAddress } from 'ethers';
import { Pool } from 'pg';
import type { FreshFinancialEvent } from '../../shared/freshAccounting.js';
import { applyFreshFinancialEvents, freshDecimal } from './accounting.js';
import { repairFreshNonledgerCreations, type FreshCreationContext } from './authenticityRepair.js';
import { encodeFreshEvidence, type FreshCapturedReceipt } from './capture.js';
import { FRESH_NONLEDGER_TEMPLATES } from './tokenAuthenticity.js';
import { transferTopic } from '../swap.js';

const url = new URL(process.env.DATABASE_URL ?? '');
if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.port !== '5436' || url.pathname !== '/kollens_fresh_20261022_24h') throw new Error('Use the authorized isolated local fresh database');
const db = new Pool({ connectionString: url.toString(), max: 1 }), client = await db.connect();
const address = () => `0x${randomBytes(20).toString('hex')}`, hash = () => `0x${randomBytes(32).toString('hex')}`;
const hex = (value: number) => `0x${value.toString(16)}`, topic = (value: string) => `0x${value.slice(2).padStart(64, '0')}`;
const now = new Date(Math.floor(Date.now() / 1_000) * 1_000), occurredAt = now.toISOString(), wallet = address(), unrelatedWallet = address(), creator = address();
const scope = `kol:${wallet}`, unrelatedScope = `kol:${unrelatedWallet}`, legitimateToken = address(), router = address();

function creationContext(number: number, from = creator): FreshCreationContext {
  const blockHash = hash(), txHash = hash(), contractAddress = getCreateAddress({ from, nonce: 0 }).toLowerCase();
  const transaction = { hash: txHash, from, to: null, nonce: '0x0', value: '0x0', input: FRESH_NONLEDGER_TEMPLATES[0].initcode,
    blockHash, blockNumber: hex(number), transactionIndex: '0x0', gasPrice: '0x1' };
  return { transaction, receipt: { transactionHash: txHash, blockHash, blockNumber: hex(number), transactionIndex: '0x0', status: '0x1',
    contractAddress, gasUsed: '0x5208', effectiveGasPrice: '0x1', logs: [] },
    block: { hash: blockHash, parentHash: hash(), number: hex(number), timestamp: hex(Math.floor(now.getTime() / 1_000)), transactions: [transaction] } };
}

try {
  await client.query('BEGIN');
  await client.query("SET LOCAL statement_timeout='10s'");
  const base = Number((await client.query("SELECT block_number FROM fresh.checkpoints WHERE key='capture'")).rows[0].block_number) + 10_000;
  const context = creationContext(base), token = context.receipt.contractAddress!, receiptHash = hash(), tradeBlockHash = hash();
  const boundaryBefore = (await client.query("SELECT block_number,block_hash,value FROM fresh.checkpoints WHERE key='start'")).rows[0];
  await client.query('INSERT INTO fresh.wallets(address,monitoring_from_block) VALUES($1,$3),($2,$3)', [wallet, unrelatedWallet, base]);
  await client.query('INSERT INTO fresh.kols(wallet_address) VALUES($1),($2)', [wallet, unrelatedWallet]);
  await client.query(`INSERT INTO fresh.accounting_scopes(id,kind,wallet_addresses,starts_at,starts_block)
    VALUES($1,'kol',$2,$3,$4),($5,'kol',$6,$3,$4)`, [scope, [wallet], occurredAt, base, unrelatedScope, [unrelatedWallet]]);
  await client.query(`INSERT INTO fresh.tokens(address,name,symbol,decimals,total_supply_raw,launch_status,valuation_status,metadata_updated_at)
    VALUES($1,'Retained Event Emitter','FIXTURE',18,'1000000000000000000','eligible','pending',$3),
      ($2,'Legitimate Fixture','LEGIT',18,'1000000000000000000','eligible','ready',$3)`, [token, legitimateToken, now]);
  await client.query(`INSERT INTO fresh.recent_blocks(block_number,block_hash,parent_hash,occurred_at)
    VALUES($1,$2,$3,$4),($5,$6,$2,$4)`, [base, context.block.hash, context.block.parentHash, now, base + 2, tradeBlockHash]);
  await client.query(`INSERT INTO fresh.launch_facts(token_address,protocol,block_number,block_hash,tx_hash,launched_at,proof,status)
    VALUES($1,'evm_creation',$2,$3,$4,$5,$6::jsonb,'eligible')`, [token, base, context.block.hash, context.transaction.hash, now, JSON.stringify({ creator, creation: 'top_level' })]);

  const makeEvent = (suffix: string, overrides: Partial<FreshFinancialEvent> = {}): FreshFinancialEvent => ({ id: `${wallet}:${suffix}`, executionKey: `${wallet}:execution:${suffix}`,
    walletAddress: wallet, tokenAddress: legitimateToken, kind: 'buy', quantity: '10', amountUsd: '100', feeUsd: '1', feeKey: `${wallet}:fee:${suffix}`,
    counterparty: null, transferKey: null, blockNumber: String(base + 1), blockHash: hash(), transactionHash: hash(), transactionIndex: 0,
    executionIndex: 0, logIndex: 0, occurredAt, canonical: true, ...overrides });
  const bought = makeEvent('buy'), sold = makeEvent('sell', { kind: 'sell', quantity: '5', amountUsd: '80', feeUsd: '2',
    blockNumber: String(base + 2), blockHash: tradeBlockHash, transactionHash: receiptHash, logIndex: 1 });
  const phantom = makeEvent('phantom', { tokenAddress: token, kind: 'transfer_out', quantity: '7.123456789', amountUsd: null, feeUsd: '0.003',
    blockNumber: String(base + 2), blockHash: tradeBlockHash, transactionHash: receiptHash, counterparty: router,
    transferKey: `${tradeBlockHash}:${receiptHash}:${token}:0` });
  const unrelated = makeEvent('unrelated', { walletAddress: unrelatedWallet, quantity: '3', amountUsd: '30', feeUsd: '0.5' });
  await applyFreshFinancialEvents(client, [bought, sold, phantom, unrelated], { now });

  const entry: FreshCapturedReceipt = { transaction: { hash: receiptHash, from: wallet, to: router, value: '0x0', input: '0x12345678',
    blockNumber: hex(base + 2), blockHash: tradeBlockHash, transactionIndex: '0x0', gasPrice: '0x1' },
    receipt: { transactionHash: receiptHash, blockHash: tradeBlockHash, blockNumber: hex(base + 2), transactionIndex: '0x0',
      status: '0x1', gasUsed: '0x5208', effectiveGasPrice: '0x1', logs: [token, legitimateToken].map((asset, index) => ({ address: asset,
        topics: [transferTopic, topic(wallet), topic(router)], data: topic(hex(index + 1)), logIndex: hex(index), transactionHash: receiptHash,
        transactionIndex: '0x0', blockNumber: hex(base + 2), blockHash: tradeBlockHash })) }, wallets: [wallet], observedAt: occurredAt };
  const payload = encodeFreshEvidence(entry), reference = `${receiptHash}:${tradeBlockHash}`, progress = { firstFailure: { version: 1, at: occurredAt, reasons: ['outgoing_transfer_value_unknown'] } };
  await client.query(`INSERT INTO fresh.recent_evidence(tx_hash,block_hash,block_number,transaction_index,payload,expires_at,decoder_status,last_error,wallet_addresses)
    VALUES($1,$2,$3,0,$4,$5,'repair','retained_original_diagnostic',$6)`, [receiptHash, tradeBlockHash, base + 2, payload, new Date(now.getTime() + 72 * 3600_000), [wallet]]);
  await client.query(`INSERT INTO fresh.jobs(id,kind,reference,state,progress,due_at,attempts,last_error)
    VALUES($1,'decode_receipt',$2,'pending',$3::jsonb,$4,9,'retained_original_diagnostic')`, [`decode:${reference}`, reference, JSON.stringify(progress), new Date(now.getTime() + 600_000)]);
  const originals = (await client.query('SELECT * FROM fresh.financial_events WHERE id=ANY($1::text[]) ORDER BY id', [[bought.id, sold.id, phantom.id, unrelated.id]])).rows;
  const beforeMetadata = (await client.query('SELECT name,symbol,decimals,total_supply_raw,metadata_updated_at FROM fresh.tokens WHERE address=$1', [token])).rows[0];

  // An otherwise valid creation context that contradicts the canonical launch
  // header must fail before the preceding valid context can mutate anything.
  const contradicting = structuredClone(context);
  contradicting.block.hash = hash(); contradicting.transaction.blockHash = contradicting.block.hash;
  contradicting.receipt.blockHash = contradicting.block.hash;
  const otherContext = creationContext(base + 3, address());
  await assert.rejects(repairFreshNonledgerCreations(client, [context, otherContext], now), /not_canonical/);
  await assert.rejects(repairFreshNonledgerCreations(client, [contradicting], now), /not_canonical/);
  const forged = structuredClone(context); forged.transaction.input = '0x60006000f3';
  await assert.rejects(repairFreshNonledgerCreations(client, [forged], now), /unproven/);
  await client.query('SAVEPOINT conflicting_authenticity_proof');
  await client.query(`UPDATE fresh.launch_facts SET proof=jsonb_set(proof,'{authenticity}','{"version":99}'::jsonb) WHERE token_address=$1`, [token]);
  await assert.rejects(repairFreshNonledgerCreations(client, [context], now), /proof_conflict/);
  await client.query('ROLLBACK TO SAVEPOINT conflicting_authenticity_proof');
  assert.equal((await client.query('SELECT status FROM fresh.launch_facts WHERE token_address=$1', [token])).rows[0].status, 'eligible');
  assert.equal((await client.query('SELECT canonical FROM fresh.financial_events WHERE id=$1', [phantom.id])).rows[0].canonical, true);

  const result = await repairFreshNonledgerCreations(client, [context], now);
  assert.deepEqual(result, { tokens: [token], excludedLaunches: 1, excludedTokens: 1, invalidatedEvents: 1, rebuiltScopes: 1, queuedReceipts: 1 });
  const retained = (await client.query('SELECT * FROM fresh.financial_events WHERE id=ANY($1::text[]) ORDER BY id', [[bought.id, sold.id, phantom.id, unrelated.id]])).rows;
  assert.equal(retained.length, originals.length);
  assert.deepEqual(retained.map(row => ({ ...row, canonical: true })), originals, 'Only the false movement canonical flag may change; quantities, fees, IDs and original evidence remain');
  assert.equal(retained.find(row => row.id === phantom.id).canonical, false);
  assert.equal(retained.filter(row => row.id !== phantom.id).every(row => row.canonical), true);
  assert.equal((await client.query('SELECT count(*)::int n FROM fresh.positions WHERE scope_id=$1 AND token_address=$2', [scope, token])).rows[0].n, 0);
  const legitimate = (await client.query('SELECT quantity_q,realized_q FROM fresh.positions WHERE scope_id=$1 AND token_address=$2', [scope, legitimateToken])).rows[0];
  assert.equal(freshDecimal(legitimate.quantity_q), '5'); assert.equal(freshDecimal(legitimate.realized_q), '27.5');
  const kol = (await client.query('SELECT today_realized_q,today_unknown_count,today_trade_count FROM fresh.kols WHERE wallet_address=$1', [wallet])).rows[0];
  assert.equal(freshDecimal(kol.today_realized_q), '27.5'); assert.equal(kol.today_unknown_count, 0); assert.equal(kol.today_trade_count, 2);
  assert.deepEqual((await client.query('SELECT name,symbol,decimals,total_supply_raw,metadata_updated_at FROM fresh.tokens WHERE address=$1', [token])).rows[0], beforeMetadata);
  const fact = (await client.query('SELECT status,proof FROM fresh.launch_facts WHERE token_address=$1', [token])).rows[0];
  assert.equal(fact.status, 'excluded_non_token'); assert.equal(fact.proof.creation, 'top_level'); assert.equal(fact.proof.authenticity.ledgerAbsent, true);
  const pending = (await client.query('SELECT decoder_status,payload,last_error FROM fresh.recent_evidence WHERE tx_hash=$1 AND block_hash=$2', [receiptHash, tradeBlockHash])).rows[0];
  assert.equal(pending.decoder_status, 'pending'); assert.equal(pending.payload.equals(payload), true); assert.equal(pending.last_error, 'retained_original_diagnostic');
  const job = (await client.query("SELECT state,due_at,progress,attempts,last_error FROM fresh.jobs WHERE kind='decode_receipt' AND reference=$1", [reference])).rows[0];
  assert.equal(job.state, 'pending'); assert.equal(job.due_at.toISOString(), occurredAt); assert.deepEqual(job.progress, progress);
  assert.equal(job.attempts, 9); assert.equal(job.last_error, 'retained_original_diagnostic');
  const epochs = (await client.query('SELECT id,correction_epoch FROM fresh.accounting_scopes WHERE id=ANY($1::text[]) ORDER BY id', [[scope, unrelatedScope]])).rows;
  assert.equal(epochs.find(row => row.id === scope).correction_epoch, '1'); assert.equal(epochs.find(row => row.id === unrelatedScope).correction_epoch, '0');
  const repeated = await repairFreshNonledgerCreations(client, [context], new Date(now.getTime() + 1_000));
  assert.deepEqual(repeated, { tokens: [token], excludedLaunches: 0, excludedTokens: 0, invalidatedEvents: 0, rebuiltScopes: 0, queuedReceipts: 0 });
  assert.deepEqual((await client.query('SELECT id,correction_epoch FROM fresh.accounting_scopes WHERE id=ANY($1::text[]) ORDER BY id', [[scope, unrelatedScope]])).rows, epochs);
  assert.deepEqual((await client.query("SELECT block_number,block_hash,value FROM fresh.checkpoints WHERE key='start'")).rows[0], boundaryBefore);
  assert.equal((await client.query("SELECT state FROM fresh.jobs WHERE kind='token_authenticity_correction' AND reference=$1", [token])).rows[0].state, 'completed');
  console.log(JSON.stringify({ ok: true, checks: ['canonical_creation_required', 'forged_template_rejected', 'conflicting_proof_not_overwritten', 'all_contexts_validated_before_writes',
    'original_financial_fields_retained', 'false_movement_invalidated', 'legitimate_same_receipt_trade_preserved', 'pnl_rebuilt', 'metadata_and_raw_payload_retained',
    'whole_receipt_redecode_pending', 'first_diagnostic_retained', 'only_affected_scope_epoch_changed', 'idempotent_repeat', 'original_boundary_unchanged'], fixtureWrites: 'rolled back' }));
} finally { await client.query('ROLLBACK'); client.release(); await db.end(); }
