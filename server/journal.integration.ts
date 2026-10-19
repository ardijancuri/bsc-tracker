// This suite destroys only an explicitly disposable local database.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ensureSchema, pool } from './db.js';
import { createJournalService } from './journalService.js';
import { createNodeAccountingService } from './nodeAccounting.js';
import type { NodeMarketQuote } from '../shared/nodeMarket.js';
import { applyJournalReplay } from './journalReplay.js';
import type { JournalLedgerEvent } from './nodeAccountingLedger.js';
import type { KolTokenActivity } from '../shared/kolTokenTrades.js';
const connection = new URL(process.env.DATABASE_URL || '');
if (!['127.0.0.1', 'localhost'].includes(connection.hostname) || !/^\/bscan_journal_test(?:_\d+)?$/.test(connection.pathname)) throw new Error('Use a local disposable bscan_journal_test database');
const now = Date.now(), user = randomUUID(), other = randomUUID(), wallet = `0x${'a'.repeat(40)}`, second = `0x${'b'.repeat(40)}`, third = `0x${'c'.repeat(40)}`, fourth = `0x${'d'.repeat(40)}`, token = `0x${'e'.repeat(40)}`;
const blockHash = `0x${'f'.repeat(64)}`, timestamp = new Date(now - 60_000).toISOString();
const events: JournalLedgerEvent[] = [{ id: 'buy', walletAddress: wallet, tokenAddress: token, kind: 'buy', tokenAmount: '10', amountUsd: '10', feeUsd: '1', txHash: blockHash,
  blockNumber: '150', timestamp }];
const identity: KolTokenActivity = { kol: { address: wallet, name: 'Public', avatarUrl: null, twitter: null, source: 'node', lastSeenAt: null },
  token: { address: token, name: 'Test', symbol: 'TEST', logoUrl: null, priceUsd: null, marketCapUsd: null, marketCapSupply: '1000' }, trades: [],
  summary: { investedUsd: null, soldUsd: null, realizedProfitUsd: null, avgBoughtPriceUsd: null, avgSoldPriceUsd: null, avgBoughtMcapUsd: null, avgSoldMcapUsd: null,
    remainingTokenAmount: null, remainingCostBasisUsd: null, buyCount: 0, sellCount: 0, valuedBuyCount: 0, valuedSellCount: 0, excludedSellCount: 0, unpricedTradeCount: 0,
    firstTradeAt: null, lastTradeAt: null, status: 'unknown', profitBasis: 'observed_fifo' }, coverage: { source: 'indexed', indexedTradeCount: 0, returnedTradeCount: 0, complete: true, historyLimit: 100000, costsIncluded: false }, generatedAt: new Date(now).toISOString() };
const proof = { walletAddress: wallet, tokenAddress: token, chain: 'bsc' as const, blockNumber: '200', blockHash, blockTimestamp: new Date(now - 5_000).toISOString(), balance: '10', checkedAt: new Date(now).toISOString() };
const currentQuote: NodeMarketQuote = { tokenAddress: token, priceUsd: '2', marketCapUsd: '2000', supply: '1000', timestamp: new Date(now).toISOString(), blockNumber: '200', blockHash,
  source: 'node', marketId: null, stale: false, supplyEstimated: false, reason: null };
let evidenceCalls = 0;
const accounting = { ...createNodeAccountingService({ db: pool }),
  evidence: async (request: Parameters<ReturnType<typeof createNodeAccountingService>['evidence']>[0]) => {
    evidenceCalls++; assert.equal(request.scope?.kind, 'portfolio');
    const scoped = events.filter(row => row.walletAddress === request.wallet && request.scope?.kind === 'portfolio' && Date.parse(row.timestamp) >= Date.parse(request.scope.fromAt));
    return { events: scoped, historicalEvents: [], baselines: [], openingBalances: [{ walletAddress: request.wallet, tokenAddress: token, tokenAmount: scoped.length ? '0' : '10' }],
      proof: { ...proof, walletAddress: request.wallet }, quote: currentQuote, source: 'node' as const, historyFingerprint: '1'.repeat(64), fromBlock: '100', throughBlock: '200',
      coverage: { walletAddress: request.wallet, tokenAddress: token, complete: true } };
  },
  activity: async (request: Parameters<ReturnType<typeof createNodeAccountingService>['activity']>[0]) => {
    assert.equal(request.scope?.kind, 'portfolio');
    return applyJournalReplay(identity, { events, proof, quote: { priceUsd: '2', timestamp: currentQuote.timestamp! }, source: 'node', coverageComplete: true, now });
  } };
const service = createJournalService({ db: pool, accounting, now: () => now });
try {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public'); await ensureSchema();
  for (const id of [user, other]) await pool.query(`INSERT INTO auth_users(id,issuer,subject,name) VALUES($1::uuid,'https://oauth.telegram.org',$1::text,'Test')`, [id]);
  await pool.query('INSERT INTO processed_blocks(block_number,block_hash) VALUES(100,$1)', [blockHash]);
  await pool.query(`INSERT INTO worker_state(key,value) VALUES('node',$1::jsonb)`, [JSON.stringify({ blockNumber: 100, blockHash })]);
  const first = (await service.add(user, wallet, 'Private name')).wallets[0];
  assert.equal(first.addedAt, first.activityFrom); assert.equal(first.label, 'Private name');
  assert.equal((await service.add(user, wallet, 'Replacement')).wallets[0].revision, first.revision);
  const meta = (await pool.query('SELECT display_name,is_tracked FROM kols WHERE address=$1', [wallet])).rows[0];
  assert.deepEqual(meta, { display_name: null, is_tracked: false });
  const adds = await Promise.allSettled([service.add(user, second), service.add(user, third), service.add(user, fourth)]);
  assert.equal(adds.filter(row => row.status === 'fulfilled').length, 2); assert.equal((await service.list(user)).wallets.length, 3);
  await assert.rejects(() => service.authorize(other, wallet), /not found/);
  const empty = await service.summary(user, wallet); assert.deepEqual(empty.positions, []); assert.equal(evidenceCalls, 0);
  await pool.query(`UPDATE journal_wallets SET added_at=$1::timestamptz+interval '456 microseconds',activity_from=$1::timestamptz+interval '456 microseconds' WHERE user_id=$2 AND wallet_address=$3`, [new Date(now - 180_000).toISOString(), user, wallet]);
  await pool.query(`INSERT INTO node_monitored_wallets(wallet_address,generation,active,registration_block,registration_hash,collected_through_block,decoded_through_block) VALUES($1,$2,true,100,$3,200,200)`, [wallet, randomUUID(), blockHash]);
  await pool.query(`UPDATE worker_state SET value=$1::jsonb,updated_at=now() WHERE key='node'`, [JSON.stringify({ blockNumber: 200, blockHash })]);
  await pool.query(`INSERT INTO tokens(address,symbol,name,decimals) VALUES($1,'TEST','Test',18)`, [token]);
  await pool.query(`INSERT INTO trades(id,wallet_address,token_address,side,token_amount,amount_usd,tx_hash,timestamp,source,block_number,block_hash) VALUES('trade',$1,$2,'buy',10,10,$3,$4,'node',150,$5)`, [wallet, token, blockHash, timestamp, blockHash]);
  const summary = await service.summary(user, wallet);
  assert.equal(summary.complete, true); assert.equal(summary.totals.estimatedProfitUsd, '9'); assert.equal(summary.coverage, 'since_wallet_added');
  const prepared = await service.tokenActivity(user, wallet, token, true);
  assert.ok(prepared?.journal.snapshotId); assert.equal(prepared.replayAccounting?.final?.reportedProfitUsd, prepared.realizedAccounting?.position?.estimatedProfitUsd);
  assert.equal(prepared.replayAccounting?.source, 'node'); assert.ok(!JSON.stringify(prepared).includes('Private name'));
  const frozen = await service.tokenActivity(user, wallet, token, true, prepared.journal.snapshotId); assert.deepEqual(frozen, prepared);
  await pool.query('UPDATE journal_replay_snapshots SET payload=$2::jsonb WHERE snapshot_id=$1', [prepared.journal.snapshotId,
    JSON.stringify({ ...prepared, accountingSnapshot: { version: 2, snapshotId: 'e'.repeat(64) } })]);
  await assert.rejects(() => service.tokenActivity(user, wallet, token, true, prepared.journal.snapshotId),
    (error: unknown) => error instanceof Error && 'statusCode' in error && error.statusCode === 410,
    'A private wrapper cannot revive an invalidated or missing immutable accounting version');
  await pool.query('UPDATE journal_replay_snapshots SET payload=$2::jsonb WHERE snapshot_id=$1', [prepared.journal.snapshotId, JSON.stringify(prepared)]);
  await pool.query(`INSERT INTO node_evidence_transactions(tx_hash,block_number,block_hash,transaction_index,timestamp,transaction,receipt)
    VALUES($1,180,$2,0,$3,'{}','{}')`, [`0x${'d'.repeat(64)}`, blockHash, timestamp]);
  await pool.query(`INSERT INTO node_executions(id,tx_hash,wallet_address,execution_index,block_number,block_hash,transaction_index,timestamp,status,kind,fee_native_wei,fee_complete,native_value_raw,logs,decoder_version)
    VALUES('failed',$1,$2,0,180,$3,0,$4,'failed','transaction',100,true,0,'[]',1)`, [`0x${'d'.repeat(64)}`, wallet, blockHash, timestamp]);
  const feeIncomplete = await service.summary(user, wallet);
  assert.equal(feeIncomplete.complete, false); assert.ok(feeIncomplete.reasons.includes('failed_execution_attribution_unknown'));
  assert.equal(feeIncomplete.positions[0].estimatedProfitUsd, '9', 'Unallocated wallet expenses do not hide a known token position');
  assert.equal(feeIncomplete.totals.estimatedProfitUsd, null, 'Combined profit cannot silently omit a failed execution fee');
  await assert.rejects(() => service.tokenActivity(other, wallet, token, true, prepared.journal.snapshotId), /not found/);
  await service.remove(user, wallet); await assert.rejects(() => service.tokenActivity(user, wallet, token, true, prepared.journal.snapshotId), /not found/);
  const next = (await service.add(user, wallet)).wallets.find(row => row.address === wallet)!; assert.notEqual(next.revision, first.revision);
  assert.deepEqual((await service.activity(user, wallet)).trades, []);
  console.log('Portfolio integration passed: private scopes, registration boundaries, original account isolation, limits, removal, frozen snapshots, forward-only re-addition and one shared accounting engine.');
} finally { await pool.end(); }
