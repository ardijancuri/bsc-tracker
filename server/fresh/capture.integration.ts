/** All fixtures are rolled back. Refuses live/legacy databases. */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import { ensureFreshSchema } from './schema.js';
import { commitFreshPage, encodeFreshEvidence, expireFreshEvidenceInTransaction, FRESH_EVIDENCE_TTL_MS, type FreshCapturedReceipt } from './capture.js';
import { applyFreshFinancialEvents } from './accounting.js';
import { rollbackFreshToAncestor } from './decode.js';
import type { FreshFinancialEvent } from '../../shared/freshAccounting.js';
import{FRESH_UNISWAP_V4_BSC_MANAGER,freshStockwavePoolId}from'./stockwaveMarket.js';
import{readFreshV4MarketIdentities}from'./v4Discovery.js';
const url = new URL(process.env.DATABASE_URL ?? '');
if (!['127.0.0.1', 'localhost'].includes(url.hostname) || !url.pathname.includes('fresh')) throw new Error('Use an isolated local fresh database');
const db = new Pool({ connectionString: url.toString(), max: 2 }), client = await db.connect();
const hash = () => `0x${randomBytes(32).toString('hex')}`, wallet = `0x${randomBytes(20).toString('hex')}`, token = `0x${randomBytes(20).toString('hex')}`;
try {
  await ensureFreshSchema(db); await client.query('BEGIN');
  // Match live reorg processing: acquire the financial lock before capture rows.
  await client.query('SELECT pg_advisory_xact_lock(73621941)');
  const saved = (await client.query("SELECT * FROM fresh.checkpoints WHERE key='capture' FOR UPDATE")).rows[0];
  assert.ok(saved, 'initialize the local fresh database first');
  const base = Number(saved.block_number) + 100, parent = hash(), blockHash = hash(), txHash = hash(), scope = `kol:${wallet}`, observed = new Date('2020-01-01T00:00:00Z');
  await client.query("UPDATE fresh.checkpoints SET block_number=$1,block_hash=$2 WHERE key='capture'", [base, parent]);
  await client.query('INSERT INTO fresh.wallets(address,monitoring_from_block) VALUES($1,$2)', [wallet, base + 1]);
  await client.query('INSERT INTO fresh.kols(wallet_address) VALUES($1)', [wallet]);
  await client.query("INSERT INTO fresh.tokens(address,decimals,launch_status) VALUES($1,18,'eligible')", [token]);
  await client.query("INSERT INTO fresh.accounting_scopes(id,kind,wallet_addresses,starts_at,starts_block) VALUES($1,'kol',$2,'2019-01-01',$3)", [scope, [wallet], base + 1]);
  await client.query('INSERT INTO fresh.recent_blocks(block_number,block_hash,parent_hash,occurred_at) VALUES($1,$2,$3,$4)', [base, parent, hash(), observed]);
  const tx = { hash: txHash, from: wallet, to: token, value: '0x0', blockNumber: `0x${(base + 1).toString(16)}`, blockHash, transactionIndex: '0x0', gasPrice: '0x1' };
  const entry: FreshCapturedReceipt = { transaction: tx, receipt: { transactionHash: txHash, transactionIndex: '0x0', blockNumber: tx.blockNumber, blockHash, status: '0x1', gasUsed: '0x1', effectiveGasPrice: '0x1', logs: [] }, wallets: [wallet], observedAt: observed.toISOString() };
  const page = { previous: { blockNumber: base, blockHash: parent, revision: Number(saved.revision), startBlock: Number(saved.value.startBlock) }, blocks: [{ number: tx.blockNumber, hash: blockHash, parentHash: parent, timestamp: '0x5e0be100', transactions: [tx] }], receipts: [entry], launches: [] };
  await commitFreshPage(client, page);
  const checkpoint = (await client.query("SELECT block_number,block_hash FROM fresh.checkpoints WHERE key='capture'")).rows[0]; assert.equal(Number(checkpoint.block_number), base + 1); assert.equal(checkpoint.block_hash, blockHash);
  assert.equal((await client.query('SELECT count(*)::int n FROM fresh.recent_evidence WHERE tx_hash=$1', [txHash])).rows[0].n, 1);
  await client.query('SAVEPOINT duplicate_capture'); await assert.rejects(commitFreshPage(client, page), /capture_checkpoint_changed/); await client.query('ROLLBACK TO SAVEPOINT duplicate_capture');
  const event: FreshFinancialEvent = { id: hash(), executionKey: `${blockHash}:${txHash}:${wallet}:${token}:buy`, walletAddress: wallet, tokenAddress: token, kind: 'buy', quantity: '10', amountUsd: '100', feeUsd: '1', feeKey: `${txHash}:fee`,
    counterparty: null, transferKey: null, blockNumber: `${base + 1}`, blockHash, transactionHash: txHash, transactionIndex: 0, executionIndex: 0, logIndex: null, occurredAt: observed.toISOString() };
  await applyFreshFinancialEvents(client, [event], { now: observed });
  // A reorg invalidates the compact record but never deletes delivery/history
  // identity. It also rebuilds only books holding affected facts or proofs.
  await client.query('SAVEPOINT reorg');
  // Initialize identity can be orphaned before its first valuation, when the
  // old observed_block-only rollback condition would leave it usable.
  const quote='0x0000000000000000000000000000000000000008',currencies=[token,quote].sort();
  for(const[fee,status]of[[0,'pending'],[3000,'ready']]as const){
    const poolKey={currency0:currencies[0],currency1:currencies[1],fee,tickSpacing:10,hooks:'0x0000000000000000000000000000000000000000'},poolId=freshStockwavePoolId(poolKey);
    const identity={version:1,manager:FRESH_UNISWAP_V4_BSC_MANAGER,poolId,poolKey,tokenAddress:token,quoteAddress:quote,
      initial:{sqrtPriceX96:String(1n<<96n),tick:0,blockNumber:base+1,blockHash,transactionHash:txHash,logIndex:1}};
    await client.query(`INSERT INTO fresh.markets(id,token_address,address,protocol,quote_address,identity,state,status,observed_block,observed_hash,observed_at)
      VALUES($1,$2,NULL,'uniswap_v4',$3,$4::jsonb,'{"original":"state"}',$5,$6,$7,$8)`,[`reorg-fixture:${poolId}`,token,quote,JSON.stringify(status==='ready'?{market:identity}:identity),status,status==='ready'?base+1:null,status==='ready'?blockHash:null,status==='ready'?observed:null]);
  }
  assert.equal((await readFreshV4MarketIdentities(client as any,[token])).get(token)!.length,2);
  const rolled = await rollbackFreshToAncestor(client, { blockNumber: base, blockHash: parent }, observed); assert.equal(rolled.scopes, 1);
  const orphaned=(await client.query('SELECT identity,status,observed_block,state FROM fresh.markets WHERE token_address=$1',[token])).rows;
  assert.equal(orphaned.length,2);assert.ok(orphaned.every(row=>row.identity.canonicalIdentityInvalid===true&&row.status==='reorg'&&row.observed_block===null&&Object.keys(row.state).length===0));
  assert.equal((await readFreshV4MarketIdentities(client as any,[token])).has(token),false);
  assert.equal((await client.query('SELECT canonical FROM fresh.financial_events WHERE id=$1', [event.id])).rows[0].canonical, false);
  assert.equal((await client.query('SELECT count(*)::int n FROM fresh.positions WHERE scope_id=$1', [scope])).rows[0].n, 0); await client.query('ROLLBACK TO SAVEPOINT reorg');
  // Expiration never touches compact trades, positions or original cost lots.
  const before = await expireFreshEvidenceInTransaction(client, new Date(observed.getTime() + FRESH_EVIDENCE_TTL_MS - 1)); assert.equal(before.evidence, 0);
  const after = await expireFreshEvidenceInTransaction(client, new Date(observed.getTime() + FRESH_EVIDENCE_TTL_MS)); assert.equal(after.evidence, 1); assert.equal(after.expiredUndecoded, 1);
  const gap = (await client.query('SELECT decode_gap_from_block FROM fresh.wallets WHERE address=$1', [wallet])).rows[0]; assert.equal(Number(gap.decode_gap_from_block), base + 1);
  assert.equal((await client.query('SELECT count(*)::int n FROM fresh.financial_events WHERE id=$1 AND canonical', [event.id])).rows[0].n, 1);
  assert.equal((await client.query('SELECT quantity_q FROM fresh.positions WHERE scope_id=$1', [scope])).rows[0].quantity_q, '10');
  assert.equal((await client.query('SELECT count(*)::int n FROM fresh.open_lots WHERE scope_id=$1', [scope])).rows[0].n, 1);
  console.log(JSON.stringify({ ok: true, checks: ['atomic_capture_progress', 'duplicate_capture', 'reorg_retains_journal_identity', 'pending_and_ready_market_initialization_invalidated', 'invalidated_market_reader_rejected', 'affected_book_rebuild', 'controlled_72h_expiry', 'expiry_preserves_financial_history', 'expired_unknown_coverage_remains_explicit'], fixtureWrites: 'rolled back' }));
} finally { await client.query('ROLLBACK'); client.release(); await db.end(); }
