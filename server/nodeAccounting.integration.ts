// Never run against an application database. All provider transports are disabled.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ensureSchema, pool } from './db.js';
import { createNodeAccountingService, saveNodeAccountingBaseline } from './nodeAccounting.js';
import { rollbackNodeAccounting,invalidateNodeAccountingForTokens } from './nodeAccountingSchema.js';
import { ensureNodeAccountingSchema } from './nodeAccountingSchema.js';
import type { NodeMarketQuote } from '../shared/nodeMarket.js';
import { FOUR_MANAGERS, fourInterface } from './launchpad.js';
import { captureNodeTraceBatch,queueNodeTraceRepairs } from './nodeTrace.js';
import { calculateJournalLedgerPeriod } from './nodeAccountingLedger.js';
const connection = new URL(process.env.DATABASE_URL || '');
if (!['127.0.0.1', 'localhost'].includes(connection.hostname) || !/^\/bscan_node_accounting_test(?:_\d+)?$/.test(connection.pathname)) throw new Error('Use a local disposable bscan_node_accounting_test database');
const wallet = `0x${'a'.repeat(40)}`, token = `0x${'b'.repeat(40)}`, blockHash = `0x${'f'.repeat(64)}`, tx = `0x${'1'.repeat(64)}`;
const closedToken = `0x${'9'.repeat(40)}`;
const now = Date.now(), start = new Date(now - 120_000).toISOString(), bought = new Date(now - 60_000).toISOString(), quoted = new Date(now - 5_000).toISOString();
const current: NodeMarketQuote = { tokenAddress: token, priceUsd: '2', marketCapUsd: '2000', supply: '1000', timestamp: quoted, blockNumber: '200', blockHash,
  source: 'node', marketId: 'fixture', stale: false, supplyEstimated: false, reason: null };
let nodeBalanceCalls = 0, historicalValuationCalls = 0, currentPrice: string | null = '2', currentBalance = '10', quoteTimestamp=quoted,quoteBlock='200';
const markRequests: { token: string; priority?: number }[] = [];
const fetchBefore = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('All external financial providers are disabled'); };
const service = createNodeAccountingService({ db: pool, now: () => now,
  balance: async request => { nodeBalanceCalls++; return { walletAddress: request.wallet, tokenAddress: request.token, chain: 'bsc', blockNumber: '200', blockHash,
    blockTimestamp: quoted, checkedAt: quoted, balance: request.token === closedToken ? '0' : currentBalance }; },
  market: { quote: async asset => ({ ...current, tokenAddress: asset, priceUsd: currentPrice,timestamp:quoteTimestamp,blockNumber:quoteBlock,
      ...(asset === closedToken ? { timestamp: new Date(now - 86400_000).toISOString(), stale: true } : {}) }),
    priceAt: async asset => { historicalValuationCalls++; return { ...current, tokenAddress: asset, priceUsd: asset === token ? '2' : '1000' }; },
    requestRefresh: async (asset, options) => { markRequests.push({ token: asset, priority: options?.priority }); } } });
try {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  // Reverted experimental namespaces remain untouched. A same-name partial
  // snapshot table is extended additively and quarantined, never auto-verified.
  await pool.query(`CREATE TABLE accounting_baselines(wallet_address text,token_address text,payload jsonb);
    INSERT INTO accounting_baselines VALUES('${wallet}','${token}','{"unverified":true}');
    CREATE TABLE node_accounting_snapshots(scope_key text,wallet_address text,token_address text,snapshot_id text,
      history_revision text,as_of timestamptz,complete boolean,payload jsonb,summary jsonb,PRIMARY KEY(scope_key,wallet_address,token_address));
    INSERT INTO node_accounting_snapshots VALUES('public','${wallet}','${token}','legacy','legacy',now(),true,'{"legacy":true}','{}');`);
  await ensureSchema(); await ensureNodeAccountingSchema(pool);
  assert.deepEqual((await pool.query('SELECT payload FROM accounting_baselines')).rows[0].payload, { unverified: true });
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM node_accounting_baselines')).rows[0].count, 0,
    'Legacy baselines are never copied or silently promoted to verified accounting');
  const oldSchemaSnapshot = (await pool.query('SELECT invalidated_at,last_valid,schema_version FROM node_accounting_snapshots')).rows[0];
  assert.ok(oldSchemaSnapshot.invalidated_at); assert.equal(oldSchemaSnapshot.last_valid, null); assert.equal(oldSchemaSnapshot.schema_version, null);
  await pool.query(`INSERT INTO kols(address,display_name,source,is_tracked) VALUES($1,'Fixture KOL','node',true)`, [wallet]);
  await pool.query(`INSERT INTO tokens(address,symbol,name,decimals) VALUES($1,'TEST','Test',18)`, [token]);
  await pool.query(`INSERT INTO node_market_token_evidence(token_address,block_number,block_hash,timestamp,decimals,total_supply_raw,supply)
    VALUES($1,100,$2,$3,18,1000000000000000000000,1000)`, [token, `0x${'100'.padStart(64, '0')}`, start]);
  await pool.query(`INSERT INTO worker_state(key,value) VALUES('node',$1::jsonb)`, [JSON.stringify({ blockNumber: 200, blockHash })]);
  for (const height of [100, 150, 200]) await pool.query(`INSERT INTO node_evidence_blocks(block_number,block_hash,parent_hash,timestamp,header)
    VALUES($1,$2,$3,$4,'{}')`, [height, height === 200 ? blockHash : `0x${height.toString().padStart(64, '0')}`, `0x${'0'.repeat(64)}`, height === 100 ? start : bought]);
  await pool.query(`INSERT INTO node_monitored_wallets(wallet_address,generation,active,registration_block,registration_hash,collected_through_block,decoded_through_block,registered_at)
    VALUES($1,$2,true,100,$3,200,200,$4)`, [wallet, randomUUID(), `0x${'100'.padStart(64, '0')}`, start]);
  await pool.query(`INSERT INTO node_evidence_ranges(from_block,to_block,head_block,wallets,decoded_at)
    SELECT 101,200,206,jsonb_build_object(wallet_address,generation::text),now() FROM node_monitored_wallets WHERE wallet_address=$1`, [wallet]);
  await pool.query(`INSERT INTO journal_opening_balances(wallet_address,token_address,block_number,block_hash,balance_raw,decimals)
    VALUES($1,$2,100,$3,0,18)`, [wallet, token, `0x${'100'.padStart(64, '0')}`]);
  const logs = [{ address: token, topics: ['0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822'], data: '0x' }];
  const encodedCreation = fourInterface.encodeEventLog(fourInterface.getEvent('TokenCreate')!, [wallet, token, 1n, 'Test', 'TEST', 1000n * 10n ** 18n, BigInt(Math.floor(Date.parse(bought) / 1000)), 0n]);
  const creation = { address: FOUR_MANAGERS[0], ...encodedCreation };
  await pool.query(`INSERT INTO node_evidence_transactions(tx_hash,block_number,block_hash,transaction_index,timestamp,transaction,receipt)
    VALUES($1,150,$2,0,$3,'{}',$4::jsonb)`, [tx, `0x${'150'.padStart(64, '0')}`, bought, JSON.stringify({ logs: [creation] })]);
  await pool.query(`INSERT INTO node_executions(id,tx_hash,wallet_address,execution_index,block_number,block_hash,transaction_index,timestamp,status,kind,
    fee_native_wei,fee_complete,native_value_raw,logs,decoder_version)
    VALUES('execution',$1,$2,0,150,$3,0,$4,'success','transaction',1000000000000000,true,10000000000000000,$5::jsonb,1)`, [tx, wallet, `0x${'150'.padStart(64, '0')}`, bought, JSON.stringify(logs)]);
  await pool.query(`INSERT INTO node_execution_flows(execution_id,token_address,delta_raw,log_indices,counterparties)
    VALUES('execution',$1,10000000000000000000,ARRAY[1],ARRAY[]::text[])`, [token]);
  await pool.query(`INSERT INTO node_trace_evidence(tx_hash,block_hash,trace,checked_at)VALUES($1,$2,$3::jsonb,$4::timestamptz)`,[tx,`0x${'150'.padStart(64,'0')}`,
    JSON.stringify({type:'CALL',from:wallet,to:token,value:'0x2386f26fc10000'}),quoted]);
  // A page read only queues durable work; it never calls a financial provider or
  // performs even a current balance read before the worker handles its lease.
  const pending = await service.activity({ wallet, token, foreground: true });
  assert.equal(pending?.realizedAccounting?.status, 'pending'); assert.equal(nodeBalanceCalls, 0);
  assert.deepEqual(markRequests, [{ token, priority: 10 }], 'Selected pending accounting promotes its quote before a replay can reach the valuation stage');
  await Promise.all([service.refresh({ wallet, token }), service.refresh({ wallet, token })]);
  assert.equal(nodeBalanceCalls, 1, 'Concurrent profile/modal requests coalesce their work');
  const ready = await service.activity({ wallet, token });
  assert.ok(ready?.accountingSnapshot?.complete, JSON.stringify(ready));
  assert.equal(ready.replayAccounting?.source, 'node'); assert.equal(ready.summary.investedUsd, '10');
  assert.equal(ready.realizedAccounting?.position?.estimatedProfitUsd, '9');
  assert.equal(ready.replayAccounting?.final?.reportedProfitUsd, ready.realizedAccounting?.position?.estimatedProfitUsd);
  assert.equal(ready.replayAccounting?.final?.reportedRoi, ready.realizedAccounting?.position?.estimatedRoi);
  const summaries = await service.summaries(wallet, [token]); assert.equal(summaries[token].estimatedProfitUsd, '9');
  assert.equal(nodeBalanceCalls, 1, 'Warm reads use persisted snapshots');
  await pool.query(`INSERT INTO leaderboard_snapshots(wallet_address,period,node_accounting)VALUES($1,'1d','{"current":true}'),($1,'7d','{"retained":true}')`,[wallet]);
  quoteTimestamp=new Date(Date.parse(bought)-1000).toISOString();quoteBlock='149';
  const beforeLatestMovement=await service.refresh({wallet,token,foreground:true});
  assert.equal(beforeLatestMovement?.accountingSnapshot?.complete,false,
    'A recent mark before the latest movement cannot value the later confirmed holdings');
  assert.ok(beforeLatestMovement?.accountingSnapshot?.reasons.includes('quote_unavailable'));
  assert.equal(beforeLatestMovement?.replayAccounting?.final,null);
  assert.deepEqual(markRequests.at(-1),{token,priority:10},'A selected ending valuation requests its next confirmed market mark');
  quoteTimestamp=quoted;quoteBlock='200';
  assert.equal((await service.refresh({wallet,token}))?.accountingSnapshot?.complete,true,
    'The same reconciled history becomes available when a genuine later valuation arrives');
  assert.deepEqual((await pool.query("SELECT node_accounting FROM leaderboard_snapshots WHERE wallet_address=$1 AND period='1d'",[wallet])).rows[0].node_accounting,{current:true},'A spot-quote refresh does not revoke realized profit');
  await pool.query("UPDATE tokens SET symbol='NODE',name='Confirmed node name' WHERE address=$1",[token]);
  const correctedIdentity=await service.activity({wallet,token});
  assert.equal(correctedIdentity?.token.symbol,'NODE');assert.equal(correctedIdentity?.token.name,'Confirmed node name');
  assert.equal(correctedIdentity.accountingSnapshot?.snapshotId,ready.accountingSnapshot.snapshotId);
  assert.equal(correctedIdentity.realizedAccounting?.position?.estimatedProfitUsd,'9',
    'A cached identity update changes only cosmetic token metadata, preserving the frozen accounting values');
  await pool.query('DELETE FROM journal_opening_balances WHERE wallet_address=$1', [wallet]);
  await service.refresh({ wallet, token });
  assert.equal((await service.activity({ wallet, token }))?.accountingSnapshot?.complete, true,
    'A pruned registration RPC cannot force a provider dependency after complete raw transfer capture');
  assert.equal((await pool.query('SELECT balance_raw::text FROM journal_opening_balances WHERE wallet_address=$1', [wallet])).rows[0].balance_raw, '0');
  assert.equal(historicalValuationCalls, 1, 'Completed historical accounting is reused when only balance/head/quote refreshes');
  const beforeNormalizationUpgrade=historicalValuationCalls;
  await pool.query(`UPDATE node_accounting_history SET payload=jsonb_set(payload-'normalizationRevision','{events,0,amountUsd}','"1"')
    WHERE scope_key='public' AND wallet_address=$1 AND token_address=$2`,[wallet,token]);
  const upgradedNormalization=await service.refresh({wallet,token});
  assert.equal(upgradedNormalization?.summary.investedUsd,'10',
    'An unversioned complete historical cache cannot retain an old conversion despite matching raw evidence and cache identity');
  assert.equal(upgradedNormalization.realizedAccounting?.position?.estimatedProfitUsd,'9');
  assert.equal(historicalValuationCalls,beforeNormalizationUpgrade+1,'A pre-revision complete history is re-valued from original captured proofs once');
  await service.refresh({wallet,token});
  assert.equal(historicalValuationCalls,beforeNormalizationUpgrade+1,'The unchanged upgraded history reuses its completed normalization');
  await pool.query('DELETE FROM node_trace_evidence WHERE tx_hash=$1',[tx]);
  const awaitingNative=await service.refresh({wallet,token,foreground:true});
  assert.ok(awaitingNative?.accountingSnapshot?.reasons.includes('native_trace_required'));
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM node_trace_jobs WHERE tx_hash=$1',[tx])).rows[0].n,1,
    'Missing native proof queues one durable repair from captured evidence');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM node_import_jobs WHERE wallet_address=$1 AND token_address=$2',[wallet,token])).rows[0].n,0,
    'Fresh native repair never becomes a live financial-provider fallback');
  await pool.query("UPDATE node_trace_jobs SET state='unavailable',last_error='node_trace_state_unavailable',attempts=6 WHERE tx_hash=$1",[tx]);
  const prunedNative=await service.refresh({wallet,token,foreground:true});
  assert.ok(prunedNative?.accountingSnapshot?.reasons.includes('native_trace_unavailable'));
  assert.ok(prunedNative?.accountingSnapshot?.reasons.includes('historical_gap'));
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM node_import_jobs WHERE wallet_address=$1 AND token_address=$2',[wallet,token])).rows[0].n,1,
    'An explicitly exhausted pruned historical native proof can request a reconciled public migration baseline');
  await pool.query('DELETE FROM node_trace_jobs WHERE tx_hash=$1',[tx]);
  await pool.query('DELETE FROM node_import_jobs WHERE wallet_address=$1 AND token_address=$2',[wallet,token]);
  // This fixture is an already-known proof, not the later concurrent capture
  // exercised below. Give it an explicit earlier time; PostgreSQL microseconds
  // otherwise race the JS millisecond preparation timestamp on fast machines.
  await pool.query(`INSERT INTO node_trace_evidence(tx_hash,block_hash,trace,checked_at)VALUES($1,$2,$3::jsonb,$4::timestamptz)`,[tx,`0x${'150'.padStart(64,'0')}`,
    JSON.stringify({type:'CALL',from:wallet,to:token,value:'0x2386f26fc10000'}),quoted]);
  await service.refresh({wallet,token});
  await pool.query("UPDATE node_evidence_transactions SET receipt='{}' WHERE tx_hash=$1", [tx]);
  await pool.query('DELETE FROM node_accounting_balances WHERE wallet_address=$1 AND token_address=$2', [wallet, token]);
  await pool.query('DELETE FROM journal_opening_balances WHERE wallet_address=$1 AND token_address=$2', [wallet, token]);
  const delayedNode = createNodeAccountingService({ db: pool, now: () => now,
    balance: async () => { throw new Error('temporary_node_failure'); },
    market: { quote: async () => current, priceAt: async () => current } });
  const temporaryDelay = await delayedNode.refresh({ wallet, token, foreground: true });
  assert.ok(temporaryDelay?.accountingSnapshot?.reasons.includes('balance_unavailable'));
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM node_import_jobs WHERE wallet_address=$1 AND token_address=$2', [wallet, token])).rows[0].count, 0,
    'A temporary unavailable balance and opening proof cannot be mistaken for missing lifetime history');
  const unknownPriorCycles = await service.refresh({ wallet, token, foreground: true });
  assert.equal(unknownPriorCycles?.accountingSnapshot?.complete, true,
    'A confirmed zero opening and complete captured costs provide an explicitly bounded position while older cycles remain unknown');
  assert.equal(unknownPriorCycles.accountingSnapshot?.historyBoundary, 'verified_zero_position');
  assert.equal(unknownPriorCycles.accountingSnapshot?.historyFrom, start);
  assert.equal(unknownPriorCycles.accountingSnapshot?.lifetimeComplete, false);
  assert.equal(unknownPriorCycles.accountingSnapshot?.lifetimeReason, 'historical_baseline_required');
  assert.equal(unknownPriorCycles.realizedAccounting?.position?.estimatedProfitUsd, '9');
  assert.equal(unknownPriorCycles.replayAccounting?.final?.reportedProfitUsd, '9');
  const capturedVersion = await service.savedActivity({wallet,token},unknownPriorCycles.accountingSnapshot!.snapshotId);
  assert.equal(capturedVersion?.accountingSnapshot?.historyBoundary,'verified_zero_position',
    'The modal and export retain the same explicit captured boundary in their frozen snapshot');
  const scopedDelayNow=now+600_000,scopedDelayAt=new Date(scopedDelayNow).toISOString();
  const scopedLagService=createNodeAccountingService({db:pool,now:()=>scopedDelayNow,
    balance:async request=>({walletAddress:request.wallet,tokenAddress:request.token,chain:'bsc',blockNumber:'200',blockHash,
      blockTimestamp:quoted,checkedAt:scopedDelayAt,balance:'10'}),
    market:{quote:async()=>({...current,timestamp:scopedDelayAt,priceUsd:'4'}),priceAt:async asset=>({...current,tokenAddress:asset,priceUsd:'1000'})}});
  const scopedLag=await scopedLagService.refresh({wallet,token});
  assert.equal(scopedLag?.accountingSnapshot?.complete,false,'An explicit captured scope does not make a stale node checkpoint current');
  assert.equal(scopedLag.accountingSnapshot?.historyBoundary,'verified_zero_position');
  assert.ok(scopedLag.accountingSnapshot?.reasons.includes('node_indexer_lag'));
  assert.equal(scopedLag.accountingSnapshot?.historyFingerprint,unknownPriorCycles.accountingSnapshot?.historyFingerprint);
  const datedScoped=await scopedLagService.activity({wallet,token});
  assert.equal(datedScoped?.accountingSnapshot?.snapshotId,unknownPriorCycles.accountingSnapshot?.snapshotId);
  assert.equal(datedScoped.accountingSnapshot?.asOf,unknownPriorCycles.accountingSnapshot?.asOf,'A temporary head delay retains the original dated mark');
  assert.equal(datedScoped.accountingSnapshot?.refreshStatus,'pending');
  assert.equal((await scopedLagService.summaries(wallet,[token]))[token].estimatedProfitUsd,'9');
  await pool.query("UPDATE node_executions SET fee_native_wei=2000000000000000 WHERE id='execution'");
  await scopedLagService.refresh({wallet,token});
  const changedScoped=await scopedLagService.activity({wallet,token});
  assert.notEqual(changedScoped?.accountingSnapshot?.snapshotId,unknownPriorCycles.accountingSnapshot?.snapshotId,
    'Changed canonical costs cannot reuse a dated scoped snapshot during the same temporary head delay');
  assert.equal(changedScoped?.accountingSnapshot?.complete,false);
  await pool.query("UPDATE node_executions SET fee_native_wei=1000000000000000 WHERE id='execution'");
  await service.refresh({wallet,token});
  const queuedRecovery = (await pool.query('SELECT priority,stage FROM node_import_jobs WHERE wallet_address=$1 AND token_address=$2', [wallet, token])).rows[0];
  assert.equal(queuedRecovery.priority, 100, 'Selected worker preparation creates its missing recovery job without scanning every public wallet');
  assert.equal(queuedRecovery.stage, 'history');
  const capturedOldToken = await service.evidence({ wallet, token });
  assert.deepEqual(capturedOldToken?.openingBalances, [{ walletAddress: wallet, tokenAddress: token, tokenAmount: '0' }],
    'A confirmed zero registration quantity survives independently of unproved lifetime history');
  assert.equal(capturedOldToken?.coverage.quantitiesComplete, true);
  assert.equal(capturedOldToken?.coverage.complete, true);
  assert.equal(capturedOldToken?.historyBoundary, 'verified_zero_position');
  assert.equal(capturedOldToken?.historicalRecoveryNeeded, true, 'Usable captured-position P&L does not cancel lifetime recovery');
  assert.equal(capturedOldToken?.source, 'node', 'A proved zero quantity is node evidence, not a provider lifetime absence claim');
  // The token existed before registration and wallet discovery is not done.
  // A future sale still uses the permanently captured node purchase FIFO.
  const periodSale = `0x${'27'.repeat(32)}`, periodSaleHash = `0x${'175'.padStart(64, '0')}`;
  const periodSoldAt = new Date(now - 30_000).toISOString();
  await pool.query(`INSERT INTO node_evidence_transactions(tx_hash,block_number,block_hash,transaction_index,timestamp,transaction,receipt)
    VALUES($1,175,$2,0,$3,$4::jsonb,$5::jsonb)`, [periodSale, periodSaleHash, periodSoldAt,
    JSON.stringify({ hash: periodSale, from: wallet, to: token, value: '0x0', transactionIndex: '0x0' }), JSON.stringify({ status: '0x1', logs })]);
  await pool.query(`INSERT INTO node_executions(id,tx_hash,wallet_address,execution_index,block_number,block_hash,transaction_index,timestamp,status,kind,
    fee_native_wei,fee_complete,native_value_raw,logs,decoder_version)
    VALUES('period-sale',$1,$2,0,175,$3,0,$4,'success','transaction',500000000000000,true,0,$5::jsonb,1)`,
  [periodSale, wallet, periodSaleHash, periodSoldAt, JSON.stringify(logs)]);
  await pool.query(`INSERT INTO node_execution_flows(execution_id,token_address,delta_raw,log_indices,counterparties)
    VALUES('period-sale',$1,-4000000000000000000,ARRAY[1],ARRAY[]::text[])`, [token]);
  await pool.query(`INSERT INTO node_trace_evidence(tx_hash,block_hash,trace,checked_at)VALUES($1,$2,$3::jsonb,$4)`,
  [periodSale, periodSaleHash, JSON.stringify({ type: 'CALL', from: wallet, to: token, value: '0x0', calls: [
    { type: 'CALL', from: token, to: wallet, value: `0x${8000000000000000n.toString(16)}` },
  ] }), quoted]);
  currentBalance = '6';
  const futureNodeOnly = await service.refresh({ wallet, token });
  const futureEvidence = await service.evidence({ wallet, token });
  assert.equal(futureNodeOnly?.accountingSnapshot?.complete, true, 'A captured sale uses the full captured purchase FIFO');
  assert.equal(futureNodeOnly.accountingSnapshot?.lifetimeComplete,false,'Captured readiness never claims unknown lifetime profit');
  assert.equal(futureNodeOnly.accountingSnapshot?.historyBoundary,'verified_zero_position');
  assert.equal(futureNodeOnly.realizedAccounting?.realizedProfitUsd,'3.1');
  assert.equal(futureEvidence?.coverage.quantitiesComplete, true);
  const periodResult = calculateJournalLedgerPeriod({ wallets: [wallet], events: futureEvidence!.events, openingBalances: futureEvidence!.openingBalances,
    baselines: [], coverage: [{ ...futureEvidence!.coverage, complete: futureEvidence!.coverage.quantitiesComplete === true, reason: undefined }],
    asOf: quoted, period: { from: start, to: quoted } });
  assert.equal(periodResult.complete, true);
  assert.equal(periodResult.totals.realizedProfitUsd, '3.1', 'Known full FIFO purchase cost and allocated fees give a node-only future period result');
  assert.equal((await pool.query('SELECT stage FROM node_import_jobs WHERE wallet_address=$1 AND token_address=$2', [wallet, token])).rows[0].stage, 'history',
    'No completed GMGN onboarding or imported baseline was required for captured period profit');
  await pool.query('UPDATE journal_opening_balances SET balance_raw=1000000000000000000 WHERE wallet_address=$1 AND token_address=$2', [wallet, token]);
  await service.refresh({ wallet, token });
  const nonzeroOpening = await service.evidence({ wallet, token });
  assert.deepEqual(nonzeroOpening?.openingBalances, []);
  assert.equal(nonzeroOpening?.coverage.quantitiesComplete, false, 'Unpriced nonzero opening holdings still require historical cost recovery');
  const unavailablePeriod = calculateJournalLedgerPeriod({ wallets: [wallet], events: nonzeroOpening!.events, coverage: [nonzeroOpening!.coverage],
    asOf: quoted, period: { from: start, to: quoted } });
  assert.equal(unavailablePeriod.totals.realizedProfitUsd, null);
  await pool.query('UPDATE journal_opening_balances SET balance_raw=0 WHERE wallet_address=$1 AND token_address=$2', [wallet, token]);
  await pool.query("DELETE FROM node_execution_flows WHERE execution_id='period-sale'");
  await pool.query("DELETE FROM node_executions WHERE id='period-sale'");
  await pool.query('DELETE FROM node_evidence_transactions WHERE tx_hash=$1', [periodSale]);
  currentBalance = '10'; await service.refresh({ wallet, token });
  await pool.query('DELETE FROM node_import_jobs WHERE wallet_address=$1 AND token_address=$2',[wallet,token]);
  await pool.query(`INSERT INTO node_accounting_jobs(scope_key,wallet_address,token_address,scope,priority)
    VALUES('public',$1,$2,'{"kind":"public"}',10) ON CONFLICT(scope_key,wallet_address,token_address)DO UPDATE SET priority=10`,[wallet,token]);
  await service.refresh({wallet,token});
  assert.equal((await pool.query('SELECT priority FROM node_import_jobs WHERE wallet_address=$1 AND token_address=$2',[wallet,token])).rows[0].priority,20,
    'A worker-classified historical gap inherits the visible card priority when first queued');
  // A failed old selection must not permanently outrank the six visible cards.
  const visible=Array.from({length:6},(_,index)=>`0x${String(index+2).repeat(40)}`);
  await pool.query('DELETE FROM node_accounting_jobs WHERE wallet_address=$1',[wallet]);
  for(const asset of visible)await pool.query('INSERT INTO tokens(address,symbol,name) VALUES($1,$2,$2)',[asset,`VISIBLE-${asset.slice(2,3)}`]);
  const importCooldown=new Date(Date.now()+60000),importLease=randomUUID();
  await pool.query(`INSERT INTO node_import_jobs(wallet_address,token_address,priority,next_attempt_at,lease_id,lease_until)
    VALUES($1,$2,0,$3,$4,$3),($1,$5,100,$3,NULL,NULL)`,[wallet,visible[0],importCooldown,importLease,visible[1]]);
  await pool.query("INSERT INTO node_import_jobs(wallet_address,token_address,stage,priority)VALUES($1,$2,'chart',0)",[wallet,visible[2]]);
  await pool.query("INSERT INTO node_market_refresh_jobs(token_address,priority,expires_at) VALUES($1,10,now()+interval '1 minute')",[visible[0]]);
  await service.summaries(wallet,visible);
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM node_accounting_jobs WHERE wallet_address=$1 AND priority=10',[wallet])).rows[0].count,6,
    'Visible summaries receive bounded priority above background preparation');
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM node_market_refresh_jobs WHERE token_address=ANY($1::text[]) AND priority=5',[visible])).rows[0].count,5,
    'Visible cards enqueue their marks in one database batch below selected quotes');
  assert.equal((await pool.query('SELECT priority FROM node_market_refresh_jobs WHERE token_address=$1',[visible[0]])).rows[0].priority,10,
    'The card quote batch preserves an existing selected quote priority');
  const visibleImport=(await pool.query('SELECT priority,lease_id,next_attempt_at FROM node_import_jobs WHERE wallet_address=$1 AND token_address=$2',[wallet,visible[0]])).rows[0];
  assert.equal(visibleImport.priority,20);assert.equal(visibleImport.lease_id,importLease);assert.equal(visibleImport.next_attempt_at.toISOString(),importCooldown.toISOString());
  assert.equal((await pool.query('SELECT priority FROM node_import_jobs WHERE wallet_address=$1 AND token_address=$2',[wallet,visible[1]])).rows[0].priority,100,
    'Visible card promotion never demotes an already selected historical recovery');
  assert.equal((await pool.query('SELECT priority FROM node_import_jobs WHERE wallet_address=$1 AND token_address=$2',[wallet,visible[2]])).rows[0].priority,0,
    'Summary loading does not prioritize historical chart exports that were never requested');
  await pool.query('UPDATE journal_opening_balances SET balance_raw=1000000000000000000 WHERE wallet_address=$1 AND token_address=$2',[wallet,token]);
  await service.refresh({wallet,token});
  await service.activity({wallet,token,foreground:true});
  await pool.query("UPDATE node_accounting_jobs SET requested_at=now()-interval '1 hour' WHERE wallet_address=$1 AND token_address=$2",[wallet,token]);
  assert.equal((await service.tick(1)).claimed,1);
  const attempted=(await pool.query('SELECT priority,requested_at,next_attempt_at,last_error FROM node_accounting_jobs WHERE wallet_address=$1 AND token_address=$2',[wallet,token])).rows[0];
  assert.equal(attempted.priority,0,'A completed pending attempt releases its selected priority');
  assert.ok(attempted.requested_at.getTime()>Date.now()-60000,'Pending work rotates behind other waiting jobs');
  assert.ok(attempted.next_attempt_at.getTime()>Date.now(),'Retry spacing remains in force');
  await service.tick(1);
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM node_accounting_jobs WHERE wallet_address=$1 AND token_address=ANY($2::text[]) AND attempts=1',[wallet,visible])).rows[0].count,1,
    'A visible card dispatches after the old pending selection, without waiting for it to become ready');
  await pool.query('UPDATE journal_opening_balances SET balance_raw=0 WHERE wallet_address=$1 AND token_address=$2',[wallet,token]);
  const joining=visible.at(-1)!,cardCooldown=new Date(Date.now()+60000),activeLease=randomUUID();
  await pool.query('UPDATE node_accounting_jobs SET next_attempt_at=$3,lease_id=$4,lease_until=$3 WHERE wallet_address=$1 AND token_address=$2',[wallet,joining,cardCooldown,activeLease]);
  await service.activity({wallet,token:joining,foreground:true});
  const promoted=(await pool.query('SELECT priority,next_attempt_at,lease_id FROM node_accounting_jobs WHERE wallet_address=$1 AND token_address=$2',[wallet,joining])).rows[0];
  assert.equal(promoted.priority,100);assert.equal(promoted.lease_id,activeLease);assert.equal(promoted.next_attempt_at.toISOString(),cardCooldown.toISOString(),
    'A joining selected caller promotes existing work without clearing its lease or cooldown');
  await pool.query('DELETE FROM node_accounting_jobs WHERE wallet_address=$1',[wallet]);
  await service.activity({wallet,token:joining,foreground:true});
  const failingWorker=createNodeAccountingService({db:pool,now:()=>now,balance:async()=>{throw new Error('unavailable');},
    market:{quote:async()=>{throw new Error('unavailable');},priceAt:async()=>current}});
  await failingWorker.tick(1);
  const failedJob=(await pool.query('SELECT priority,last_error,requested_at,next_attempt_at FROM node_accounting_jobs WHERE wallet_address=$1 AND token_address=$2',[wallet,joining])).rows[0];
  assert.equal(failedJob.priority,0);assert.equal(failedJob.last_error,'snapshot_preparation_failed');assert.ok(failedJob.next_attempt_at.getTime()>Date.now(),
    'Thrown preparations also rotate behind unattempted cards without a tight retry loop');
  await pool.query('DELETE FROM node_accounting_jobs WHERE wallet_address=$1',[wallet]);
  await pool.query("UPDATE node_import_jobs SET stage='done',completed_at=now() WHERE wallet_address=$1 AND token_address=$2", [wallet, token]);
  await service.refresh({ wallet, token, foreground: true });
  assert.equal((await pool.query('SELECT stage FROM node_import_jobs WHERE wallet_address=$1 AND token_address=$2', [wallet, token])).rows[0].stage, 'reconcile',
    'A completed job with newly unavailable accounting resumes reconciliation instead of staying permanently done');
  await pool.query(`UPDATE node_import_jobs SET last_error='import_provider_unavailable',next_attempt_at=now()+interval '30 seconds' WHERE wallet_address=$1 AND token_address=$2`, [wallet, token]);
  const cooldown = await service.refresh({ wallet, token });
  assert.ok(cooldown);
  assert.equal(cooldown?.accountingSnapshot?.complete,true,'A provider cooldown cannot block fully captured node position accounting');
  assert.equal(cooldown?.accountingSnapshot?.lifetimeComplete,false);
  await pool.query("UPDATE node_import_jobs SET last_error='import_aggregate_inconsistent' WHERE wallet_address=$1 AND token_address=$2",[wallet,token]);
  const contradictoryImport=await service.refresh({wallet,token});
  assert.ok(contradictoryImport?.accountingSnapshot?.reasons.includes('historical_accounting_mismatch'));
  assert.equal(contradictoryImport?.realizedAccounting?.position?.estimatedProfitUsd,null);
  assert.equal((await service.summaries(wallet,[token]))[token].reason,'historical_accounting_mismatch',
    'A known contradictory imported aggregate is distinguished from ordinary history recovery without publishing its profit');
  const waitingImport = (await pool.query('SELECT next_attempt_at FROM node_import_jobs WHERE wallet_address=$1 AND token_address=$2', [wallet, token])).rows[0];
  await service.activity({ wallet, token, foreground: true });
  const selectedImport = (await pool.query('SELECT priority,next_attempt_at FROM node_import_jobs WHERE wallet_address=$1 AND token_address=$2', [wallet, token])).rows[0];
  assert.equal(selectedImport.priority, 100, 'The selected trade promotes existing historical recovery work alongside accounting');
  assert.equal(selectedImport.next_attempt_at.toISOString(), waitingImport.next_attempt_at.toISOString(), 'Selected priority must preserve the shared provider cooldown');
  await pool.query('DELETE FROM node_import_jobs WHERE wallet_address=$1 AND token_address=$2', [wallet, token]);
  const originalHead = 'e'.repeat(64), verifiedHead = 'f'.repeat(64);
  const discovered = { version: 1, tokens: [{ address: token }], activityCount: 1, movements: [{ tokenAddress: token, timestamp: bought, kind: 'buy', txHash: tx }] };
  await pool.query(`INSERT INTO node_import_wallet_jobs(wallet_address,stage,pagination_cursors,completed_at,head_fingerprint,head_verified_at,head_verified_fingerprint)
    VALUES($1,'done',ARRAY['head'],now(),$2,now(),$3)`, [wallet, originalHead, verifiedHead]);
  await pool.query(`INSERT INTO node_import_wallet_pages(wallet_address,cursor_key,payload_hash,next_cursor,payload) VALUES($1,'head',$2,NULL,$3::jsonb)`, [wallet, originalHead, JSON.stringify(discovered)]);
  await pool.query(`INSERT INTO node_import_wallet_head_checks(wallet_address,payload_hash,payload,cutoff_at)
    SELECT wallet_address,$2,$3::jsonb,requested_at FROM node_import_wallet_jobs WHERE wallet_address=$1`,
  [wallet, verifiedHead, JSON.stringify({ version: 1, movements: discovered.movements, nextCursor: null, originalHeadFingerprint: originalHead })]);
  const absenceProved = await service.refresh({ wallet, token });
  assert.equal(absenceProved?.accountingSnapshot?.complete, true, 'A complete verified onboarding traversal can prove absent older cycles');
  assert.equal(absenceProved.accountingSnapshot?.historyBoundary, 'wallet_discovery');
  assert.equal(absenceProved.accountingSnapshot?.source, 'mixed', 'Provider absence evidence is identified instead of claiming node-only lifetime coverage');
  await pool.query(`INSERT INTO node_import_wallet_pages(wallet_address,cursor_key,payload_hash,next_cursor,payload) VALUES($1,'older-observed',$2,NULL,$3::jsonb)`,
  [wallet, 'd'.repeat(64), JSON.stringify({ ...discovered, movements: [{ ...discovered.movements[0], timestamp: new Date(now - 86400_000).toISOString() }] })]);
  const oldCycleObserved = await service.refresh({ wallet, token });
  assert.equal(oldCycleObserved?.accountingSnapshot?.complete, true, 'Independent captured position accounting survives discovery of an older closed cycle');
  assert.equal(oldCycleObserved.accountingSnapshot?.historyBoundary,'verified_zero_position');
  assert.equal(oldCycleObserved.accountingSnapshot?.lifetimeComplete,false, 'A prior observed cycle cannot be erased by a later empty page or presented as complete lifetime history');
  await pool.query('DELETE FROM node_import_wallet_pages WHERE wallet_address=$1', [wallet]);
  await pool.query('DELETE FROM node_import_wallet_head_checks WHERE wallet_address=$1', [wallet]);
  await pool.query('DELETE FROM node_import_wallet_jobs WHERE wallet_address=$1', [wallet]);
  await pool.query('UPDATE node_evidence_transactions SET receipt=$2::jsonb WHERE tx_hash=$1', [tx, JSON.stringify({ logs: [creation] })]);
  const newToken = await service.refresh({ wallet, token });
  assert.equal(newToken?.accountingSnapshot?.complete, true);
  assert.equal(newToken.accountingSnapshot?.historyBoundary, 'token_creation');
  assert.equal(newToken.accountingSnapshot?.source, 'node', 'Authenticated new tokens remain independent of historical providers');
  await pool.query('DELETE FROM node_import_jobs WHERE wallet_address=$1 AND token_address=$2', [wallet, token]);
  currentPrice = '3'; await service.refresh({ wallet, token });
  const moved = await service.activity({ wallet, token });
  assert.equal(moved?.realizedAccounting?.position?.estimatedProfitUsd, '19', 'Other market activity changes open-position P&L without a new KOL trade');
  assert.notEqual(moved?.accountingSnapshot?.snapshotId, ready.accountingSnapshot.snapshotId);
  const frozen = await service.savedActivity({ wallet, token }, ready.accountingSnapshot.snapshotId);
  assert.equal(frozen?.realizedAccounting?.position?.estimatedProfitUsd, '9', 'Share preparation uses the exact modal snapshot even after the latest valuation moves');
  assert.equal(await service.savedActivity({ wallet, token: `0x${'d'.repeat(40)}` }, ready.accountingSnapshot.snapshotId), undefined);
  const later = now + 600_000, laterCheckedAt = new Date(later).toISOString();
  const laggingLedger = createNodeAccountingService({ db: pool, now: () => later,
    balance: async request => ({ walletAddress: request.wallet, tokenAddress: request.token, chain: 'bsc', blockNumber: '200', blockHash,
      blockTimestamp: quoted, checkedAt: laterCheckedAt, balance: '10' }),
    market: { quote: async () => ({ ...current, priceUsd: '4', timestamp: laterCheckedAt }), priceAt: async () => current } });
  const behind = await laggingLedger.refresh({ wallet, token, foreground: true });
  assert.equal(behind?.accountingSnapshot?.complete, false, 'A successful fresh RPC check cannot make an old ledger checkpoint current');
  assert.ok(behind.accountingSnapshot?.reasons.includes('node_indexer_lag'));
  const savedDuringLag = await laggingLedger.activity({ wallet, token });
  assert.equal(savedDuringLag?.accountingSnapshot?.snapshotId, moved!.accountingSnapshot!.snapshotId);
  assert.equal(savedDuringLag.accountingSnapshot?.asOf, moved!.accountingSnapshot!.asOf);
  assert.equal(savedDuringLag.accountingSnapshot?.refreshStatus, 'pending');
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM node_import_jobs WHERE wallet_address=$1 AND token_address=$2', [wallet, token])).rows[0].count, 0,
    'Indexer lag alone never requests historical provider recovery');
  await service.refresh({ wallet, token });
  currentPrice = null; await service.refresh({ wallet, token });
  const dated = await service.activity({ wallet, token });
  assert.equal(dated?.realizedAccounting?.position?.estimatedProfitUsd, '19');
  assert.equal(dated.accountingSnapshot?.snapshotId, moved!.accountingSnapshot!.snapshotId);
  assert.equal(dated.accountingSnapshot?.asOf, moved!.accountingSnapshot!.asOf);
  assert.equal(dated.accountingSnapshot?.refreshStatus, 'pending');
  assert.equal((await service.summaries(wallet, [token]))[token].estimatedProfitUsd, '19');
  currentPrice = '3'; currentBalance = '11'; await service.refresh({ wallet, token });
  const contradictory = await service.activity({ wallet, token });
  assert.notEqual(contradictory?.accountingSnapshot?.refreshStatus, 'pending', 'Contradictory balances cannot retain dated prior profit');
  assert.equal(contradictory?.accountingSnapshot?.complete, false);
  currentBalance = '10'; await service.refresh({ wallet, token });
  // A background import may finish after fully covered node accounting. Its
  // retained baseline is fallback evidence, not a reason to demote node data.
  const importedCurrentCheckpoint = { walletAddress: wallet, tokenAddress: token, chain: 'bsc' as const, blockNumber: '200', blockHash,
    blockTimestamp: quoted, checkedAt: quoted, balance: '10' };
  await pool.query("UPDATE leaderboard_snapshots SET node_accounting='{\"current\":true}' WHERE wallet_address=$1 AND period='1d'",[wallet]);
  const correction=await pool.connect();
  try{
    await correction.query('BEGIN');await invalidateNodeAccountingForTokens(correction,[token],'valuation_evidence_corrected');
    assert.equal((await correction.query("SELECT node_accounting FROM leaderboard_snapshots WHERE wallet_address=$1 AND period='1d'",[wallet])).rows[0].node_accounting,null,'Financial invalidation and period revocation are one transaction');
    await correction.query('ROLLBACK');
  }finally{correction.release();}
  assert.deepEqual((await pool.query("SELECT node_accounting FROM leaderboard_snapshots WHERE wallet_address=$1 AND period='1d'",[wallet])).rows[0].node_accounting,{current:true},'Rolling back a failed correction preserves the committed period too');
  await invalidateNodeAccountingForTokens(pool,[token],'valuation_evidence_corrected');
  assert.equal((await pool.query("SELECT node_accounting FROM leaderboard_snapshots WHERE wallet_address=$1 AND period='1d'",[wallet])).rows[0].node_accounting,null,'Committed corrected financial evidence cannot leave the old total ranked');
  assert.deepEqual((await pool.query("SELECT node_accounting FROM leaderboard_snapshots WHERE wallet_address=$1 AND period='7d'",[wallet])).rows[0].node_accounting,{retained:true});
  await pool.query("UPDATE leaderboard_snapshots SET node_accounting='{\"oldBaseline\":true}' WHERE wallet_address=$1 AND period='1d'",[wallet]);
  await saveNodeAccountingBaseline(pool, { wallet, token, checkpoint: importedCurrentCheckpoint, historyFingerprint: 'e'.repeat(64), overlapVerified: true, quantityVerified: true,
    ledger: { investedUsd: '10', soldUsd: '0', incomingTransferCostUsd: '0', transferOutIncomeUsd: '0', feesUsd: '1', realizedProfitUsd: '0', feeInclusiveCapitalUsd: '11',
      lots: [{ tokenAmount: '10', costBasisUsd: '11' }] } });
  assert.equal((await pool.query("SELECT node_accounting FROM leaderboard_snapshots WHERE wallet_address=$1 AND period='1d'",[wallet])).rows[0].node_accounting,null,'A new reconciled baseline atomically revokes an older period rollup');
  const nodePreferred = await service.refresh({ wallet, token });
  assert.equal(nodePreferred?.accountingSnapshot?.complete, true);
  assert.equal(nodePreferred?.accountingSnapshot?.source, 'node', 'Complete authenticated token-creation history wins even when a provider baseline already exists');
  assert.equal(nodePreferred.accountingSnapshot?.historyBoundary, 'token_creation');
  assert.equal(nodePreferred.realizedAccounting?.position?.estimatedProfitUsd, '19');
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM node_accounting_baselines WHERE wallet_address=$1 AND token_address=$2', [wallet, token])).rows[0].count, 1,
    'Selecting node evidence preserves the separately verified historical fallback');
  await pool.query('DELETE FROM node_trace_evidence WHERE tx_hash=$1', [tx]);
  const importedFallback = await service.refresh({ wallet, token });
  assert.equal(importedFallback?.accountingSnapshot?.complete, true);
  assert.equal(importedFallback?.accountingSnapshot?.source, 'imported', 'Missing node-native cost proof keeps the reconciled imported fallback available');
  assert.equal(importedFallback.realizedAccounting?.position?.estimatedProfitUsd, '19');
  await pool.query(`INSERT INTO node_trace_evidence(tx_hash,block_hash,trace,checked_at)VALUES($1,$2,$3::jsonb,$4::timestamptz)`,
  [tx, `0x${'150'.padStart(64, '0')}`, JSON.stringify({ type: 'CALL', from: wallet, to: token, value: '0x2386f26fc10000' }), quoted]);
  assert.equal((await service.refresh({ wallet, token }))?.accountingSnapshot?.source, 'node', 'Recovering actual node proof restores node priority without deleting the import');
  await pool.query("UPDATE node_executions SET fee_complete=false WHERE id='execution'");
  assert.equal((await service.refresh({ wallet, token }))?.accountingSnapshot?.source, 'imported', 'Incomplete node fee attribution cannot displace a verified imported cost ledger');
  await pool.query("UPDATE node_executions SET fee_complete=true WHERE id='execution'");
  await pool.query('DELETE FROM node_market_token_evidence WHERE token_address=$1 AND block_number=100', [token]);
  assert.equal((await service.refresh({ wallet, token }))?.accountingSnapshot?.source, 'imported', 'Legacy guessed token decimals do not authorize node-only source selection');
  await pool.query(`INSERT INTO node_market_token_evidence(token_address,block_number,block_hash,timestamp,decimals,total_supply_raw,supply)
    VALUES($1,100,$2,$3,18,1000000000000000000000,1000)`, [token, `0x${'100'.padStart(64, '0')}`, start]);
  assert.equal((await service.refresh({ wallet, token }))?.accountingSnapshot?.source, 'node');
  // The following fixture represents an older token: it has no creation proof
  // within the monitored segment and genuinely needs its lifetime baseline.
  await pool.query("UPDATE node_evidence_transactions SET receipt='{}' WHERE tx_hash=$1", [tx]);
  // A reconciled import at a known checkpoint carries old realized profit and
  // complete acquisition capital even when the old position is flat.
  const checkpoint = { walletAddress: wallet, tokenAddress: token, chain: 'bsc' as const, blockNumber: '100', blockHash: `0x${'100'.padStart(64, '0')}`,
    blockTimestamp: start, checkedAt: start, balance: '0' };
  await saveNodeAccountingBaseline(pool, { wallet, token, checkpoint, historyFingerprint: 'a'.repeat(64), overlapVerified: true, quantityVerified: true,
    ledger: { investedUsd: '100', soldUsd: '150', incomingTransferCostUsd: '0', transferOutIncomeUsd: '0', feesUsd: '2', realizedProfitUsd: '48', feeInclusiveCapitalUsd: '101', lots: [] }, events: [] });
  assert.equal(await service.savedActivity({ wallet, token }, ready.accountingSnapshot.snapshotId), undefined, 'Historical corrections invalidate old frozen versions');
  await service.refresh({ wallet, token });
  const mixed = await service.activity({ wallet, token });
  assert.equal(mixed?.accountingSnapshot?.source, 'mixed'); assert.equal(mixed.realizedAccounting?.position?.estimatedProfitUsd, '67');
  assert.equal(mixed.realizedAccounting?.position?.feeInclusiveCostUsd, '112');
  const aggregateToken=`0x${'81'.repeat(20)}`;
  await pool.query("INSERT INTO tokens(address,symbol,name)VALUES($1,'AGGREGATE','Aggregate ending')",[aggregateToken]);
  await pool.query(`INSERT INTO node_market_token_evidence(token_address,block_number,block_hash,timestamp,decimals,total_supply_raw,supply)
    VALUES($1,200,$2,$3,18,1000000000000000000000,1000)`,[aggregateToken,blockHash,quoted]);
  const aggregateCheckpoint={...checkpoint,tokenAddress:aggregateToken,blockNumber:'200',blockHash,blockTimestamp:quoted,checkedAt:quoted,balance:'10'};
  const aggregateLedger={investedUsd:'100',soldUsd:'150',incomingTransferCostUsd:'0',transferOutIncomeUsd:'0',feesUsd:'2',realizedProfitUsd:null,
    feeInclusiveCapitalUsd:'101',lots:[{tokenAmount:'10',costBasisUsd:null}]};
  await saveNodeAccountingBaseline(pool,{wallet,token:aggregateToken,checkpoint:aggregateCheckpoint,historyFingerprint:'b'.repeat(64),overlapVerified:true,quantityVerified:true,ledger:aggregateLedger});
  const aggregateReady=await service.refresh({wallet,token:aggregateToken});
  assert.equal(aggregateReady?.realizedAccounting?.position?.estimatedProfitUsd,'78');
  assert.ok(aggregateReady?.accountingSnapshot?.reasons.includes('fifo_allocation_unknown'));
  currentPrice=null;await service.refresh({wallet,token:aggregateToken});
  const aggregateDated=await service.activity({wallet,token:aggregateToken});
  assert.equal(aggregateDated?.realizedAccounting?.position?.estimatedProfitUsd,'78',
    'Unknown FIFO allocation cannot erase an independently verified ending during a temporary quote delay');
  assert.equal(aggregateDated.accountingSnapshot?.snapshotId,aggregateReady.accountingSnapshot?.snapshotId);
  assert.equal(aggregateDated.accountingSnapshot?.asOf,aggregateReady.accountingSnapshot?.asOf);
  assert.equal(aggregateDated.accountingSnapshot?.refreshReason,'quote_unavailable');
  assert.equal((await service.summaries(wallet,[aggregateToken]))[aggregateToken].estimatedProfitUsd,'78');
  currentBalance='11';await service.refresh({wallet,token:aggregateToken});
  assert.notEqual((await service.activity({wallet,token:aggregateToken}))?.accountingSnapshot?.refreshStatus,'pending',
    'Changed confirmed holdings cannot reuse an older aggregate ending');
  currentBalance='10';currentPrice='3';
  assert.equal((await service.refresh({wallet,token:aggregateToken}))?.realizedAccounting?.position?.estimatedProfitUsd,'78');
  await saveNodeAccountingBaseline(pool,{wallet,token:aggregateToken,checkpoint:aggregateCheckpoint,historyFingerprint:'c'.repeat(64),overlapVerified:true,quantityVerified:true,
    ledger:{...aggregateLedger,investedUsd:null}});
  currentPrice=null;await service.refresh({wallet,token:aggregateToken});
  assert.notEqual((await service.activity({wallet,token:aggregateToken}))?.accountingSnapshot?.refreshStatus,'pending',
    'A genuine correction to unknown acquisition costs invalidates dated aggregate totals');
  currentPrice='3';
  await pool.query("UPDATE node_monitored_wallets SET repair_from_block=50,last_error='pruned_history' WHERE wallet_address=$1", [wallet]);
  const bridged = await service.refresh({ wallet, token });
  assert.equal(bridged?.accountingSnapshot?.complete, true, 'A validated baseline and completed later coverage bridge an unavailable older repair range');
  await pool.query('UPDATE node_monitored_wallets SET repair_from_block=180 WHERE wallet_address=$1', [wallet]);
  const newGap = await service.refresh({ wallet, token });
  assert.equal(newGap?.accountingSnapshot?.complete, false, 'A current gap after the imported checkpoint still prevents readiness');
  await pool.query('UPDATE node_monitored_wallets SET repair_from_block=NULL,last_error=NULL WHERE wallet_address=$1', [wallet]);
  await pool.query(`INSERT INTO tokens(address,symbol,name,decimals) VALUES($1,'CLOSED','Closed',18)`, [closedToken]);
  await pool.query(`INSERT INTO node_market_token_evidence(token_address,block_number,block_hash,timestamp,decimals,total_supply_raw,supply)
    VALUES($1,100,$2,$3,18,1000000000000000000000,1000)`, [closedToken, checkpoint.blockHash, start]);
  await saveNodeAccountingBaseline(pool, { wallet, token: closedToken, checkpoint: { ...checkpoint, tokenAddress: closedToken }, historyFingerprint: 'c'.repeat(64), overlapVerified: true, quantityVerified: true,
    ledger: { investedUsd: '100', soldUsd: '150', incomingTransferCostUsd: '0', transferOutIncomeUsd: '0', feesUsd: '2', realizedProfitUsd: '48', feeInclusiveCapitalUsd: '101', lots: [] } });
  const closed = await service.refresh({ wallet, token: closedToken });
  assert.equal(closed?.accountingSnapshot?.complete, true, 'A closed position requires no current quote');
  assert.equal(closed.accountingSnapshot?.asOf, quoted, 'Closed accounting dates come from the confirmed proof, never a stale market quote');
  assert.equal(closed.realizedAccounting?.realizedProfitUsd, '48');
  // A first preparation has no existing snapshot for trace invalidation to
  // mark. Its writer must still detect evidence published after preparation.
  await pool.query('DELETE FROM node_accounting_snapshots WHERE scope_key=\'public\' AND wallet_address=$1 AND token_address=$2',[wallet,token]);
  await pool.query('DELETE FROM node_accounting_history WHERE scope_key=\'public\' AND wallet_address=$1 AND token_address=$2',[wallet,token]);
  await pool.query('DELETE FROM node_trace_evidence WHERE tx_hash=$1',[tx]);
  await pool.query('DELETE FROM node_trace_jobs WHERE tx_hash=$1',[tx]);
  await pool.query(`UPDATE node_evidence_transactions SET transaction=$2::jsonb,receipt=jsonb_set(receipt,'{status}','"0x1"') WHERE tx_hash=$1`,[tx,JSON.stringify({from:wallet,to:token,value:'0x2386f26fc10000'})]);
  await queueNodeTraceRepairs(pool,{wallet,token});
  let traceQuoteEntered!:()=>void,releaseTraceQuote!:()=>void;
  const traceQuoteBarrier=new Promise<void>(resolve=>traceQuoteEntered=resolve),traceQuoteResume=new Promise<void>(resolve=>releaseTraceQuote=resolve);
  const traceRaceService=createNodeAccountingService({db:pool,now:()=>now,balance:async()=>({walletAddress:wallet,tokenAddress:token,chain:'bsc',blockNumber:'200',blockHash,blockTimestamp:quoted,checkedAt:quoted,balance:'10'}),
    market:{quote:async()=>{traceQuoteEntered();await traceQuoteResume;return {...current,priceUsd:'3'};},priceAt:async()=>current}});
  const unpublished=traceRaceService.refresh({wallet,token});const guarded=assert.rejects(unpublished,/snapshot_evidence_changed/);
  await traceQuoteBarrier;
  assert.equal((await captureNodeTraceBatch(pool,{limit:1,trace:async()=>({type:'CALL',from:wallet,to:token,value:'0x2386f26fc10000'})})).captured,1);
  releaseTraceQuote();await guarded;
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM node_accounting_snapshots WHERE scope_key=\'public\' AND wallet_address=$1 AND token_address=$2',[wallet,token])).rows[0].n,0,
    'An in-flight first preparation cannot publish older evidence after a verified trace');
  assert.equal((await service.refresh({wallet,token}))?.accountingSnapshot?.complete,true);
  // A private subscription receives only its own registration scope.
  const account = randomUUID(), revision = randomUUID(), added = new Date(now - 90_000).toISOString();
  await pool.query(`INSERT INTO auth_users(id,issuer,subject,name) VALUES($1::uuid,'https://oauth.telegram.org',$1::text,'Private')`, [account]);
  await pool.query(`INSERT INTO journal_wallets(user_id,wallet_address,revision,registration_block,registration_hash,added_at,activity_from)
    VALUES($1,$2,$3,100,$4,$5,$5)`, [account, wallet, revision, checkpoint.blockHash, added]);
  const scope = { kind: 'portfolio' as const, accountId: account, membershipRevision: revision, fromAt: added, fromBlock: '100' };
  await service.refresh({ wallet, token, scope });
  const privatePosition = await service.activity({ wallet, token, scope });
  assert.equal(privatePosition?.realizedAccounting?.position?.estimatedProfitUsd, '19', 'Private accounting never inherits the public lifetime baseline');
  const bootstrappedGeneration = randomUUID();
  await pool.query(`UPDATE node_monitored_wallets SET generation=$2,registration_block=150,registration_hash=$3 WHERE wallet_address=$1`,
    [wallet, bootstrappedGeneration, `0x${'150'.padStart(64, '0')}`]);
  const privateGap = await service.refresh({ wallet, token, scope });
  assert.equal(privateGap?.accountingSnapshot?.complete, false);
  assert.ok(privateGap.accountingSnapshot?.reasons.includes('historical_gap'),
    'A new capture boundary cannot turn an older private membership gap into an ordinary temporary delay');
  assert.equal((await pool.query('SELECT registration_block::text FROM journal_wallets WHERE user_id=$1', [account])).rows[0].registration_block, '100',
    'A capture bootstrap preserves the original private membership boundary');
  await pool.query(`INSERT INTO node_evidence_ranges(from_block,to_block,head_block,wallets,decoded_at)
    VALUES(101,200,206,jsonb_build_object($1::text,$2::text),now())`, [wallet, bootstrappedGeneration]);
  const privateBridged = await service.refresh({ wallet, token, scope });
  assert.equal(privateBridged?.accountingSnapshot?.complete, true,
    'Complete same-generation evidence can genuinely cover activity before the latest registration boundary');
  assert.equal(privateBridged.accountingSnapshot?.reasons.includes('historical_gap'), false);
  assert.equal(privateBridged.realizedAccounting?.position?.estimatedProfitUsd, '19');
  // An in-flight first snapshot has no existing row for bootstrap invalidation
  // to mark. Its captured monitoring generation must still reject the commit.
  const raceToken = `0x${'8'.repeat(40)}`;
  await pool.query(`INSERT INTO tokens(address,symbol,name,decimals) VALUES($1,'RACE','Race',18)`, [raceToken]);
  await pool.query(`INSERT INTO node_market_token_evidence(token_address,block_number,block_hash,timestamp,decimals,total_supply_raw,supply)
    VALUES($1,200,$2,$3,18,1000000000000000000000,1000)`, [raceToken, blockHash, quoted]);
  await saveNodeAccountingBaseline(pool, { wallet, token: raceToken, checkpoint: { ...checkpoint, tokenAddress: raceToken, blockNumber: '200', blockHash, blockTimestamp: quoted },
    historyFingerprint: '8'.repeat(64), overlapVerified: true, quantityVerified: true,
    ledger: { investedUsd: '0', soldUsd: '0', incomingTransferCostUsd: '0', transferOutIncomeUsd: '0', feesUsd: '0', realizedProfitUsd: '0', feeInclusiveCapitalUsd: '0', lots: [] } });
  let quoteReached!: () => void, resumeQuote!: () => void;
  const pausedQuote = new Promise<void>(resolve => { quoteReached = resolve; });
  const continueQuote = new Promise<void>(resolve => { resumeQuote = resolve; });
  const racingService = createNodeAccountingService({ db: pool, now: () => now,
    balance: async request => ({ walletAddress: request.wallet, tokenAddress: request.token, chain: 'bsc', blockNumber: '200', blockHash,
      blockTimestamp: quoted, checkedAt: quoted, balance: '0' }),
    market: { priceAt: async () => current, quote: async () => { quoteReached(); await continueQuote; return { ...current, tokenAddress: raceToken }; } } });
  const racingRefresh = racingService.refresh({ wallet, token: raceToken });
  const rejectedRefresh = assert.rejects(racingRefresh, /snapshot_monitoring_changed/);
  await pausedQuote;
  const bootstrap = await pool.connect();
  try {
    await bootstrap.query('BEGIN'); await bootstrap.query('SELECT pg_advisory_xact_lock(782319)');
    await bootstrap.query(`UPDATE node_monitored_wallets SET generation=$2,registration_block=200,registration_hash=$3 WHERE wallet_address=$1`,
      [wallet, randomUUID(), blockHash]);
    await bootstrap.query('COMMIT');
  } finally { bootstrap.release(); resumeQuote(); }
  await rejectedRefresh;
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM node_accounting_snapshots WHERE token_address=$1', [raceToken])).rows[0].count, 0);
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM node_accounting_history WHERE token_address=$1', [raceToken])).rows[0].count, 0);
  await assert.rejects(saveNodeAccountingBaseline(pool, { wallet, token, checkpoint, historyFingerprint: 'a'.repeat(64), overlapVerified: true, quantityVerified: true,
    ledger: { investedUsd: '100', soldUsd: '150', incomingTransferCostUsd: '0', transferOutIncomeUsd: '0', feesUsd: '2', realizedProfitUsd: '48', feeInclusiveCapitalUsd: '101', lots: [] } }),
  /baseline_checkpoint_before_monitoring/, 'An import prepared before bootstrap cannot publish an older baseline after the capture boundary moves');
  await pool.query('DELETE FROM journal_wallets WHERE user_id=$1', [account]);
  assert.equal(await service.activity({ wallet, token, scope }), undefined, 'Removing membership invalidates access immediately');
  await rollbackNodeAccounting(pool, 150);
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM node_accounting_balances')).rows[0].count, 0);
  assert.ok((await pool.query('SELECT invalidated_at FROM node_accounting_snapshots WHERE scope_key=\'public\'')).rows[0].invalidated_at);
  console.log('Node accounting integration passed: external providers disabled, coalescing, durable snapshots, frozen modal/video ending, changing quote, mixed import handoff, zero-balance capital, private scope and reorg invalidation.');
} finally { globalThis.fetch = fetchBefore; await pool.end(); }
