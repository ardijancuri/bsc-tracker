import assert from 'node:assert/strict';
import { createHash,randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import pg from 'pg';
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import { loadPublicNodeLeaderboardAccounting } from './nodeLeaderboardAccounting.js';
import { advanceNodeDecodeCheckpoints } from './nodeEvidence.js';
import type { NodeLeaderboardCalculationRequest } from './nodeLeaderboard.js';
import type { NodeAccountingEvidence } from './nodeAccounting.js';
import type { JournalLedgerEvent } from './nodeAccountingLedger.js';
import { TRUSTED_QUOTE_FEEDS } from './nodeMarketProtocols.js';

const configured = new URL(process.env.DATABASE_URL ?? 'postgres://invalid');
if (!['localhost', '127.0.0.1'].includes(configured.hostname) || configured.port !== '5435') throw new Error('Disposable local PostgreSQL only');
const admin = new pg.Client({ connectionString: configured.href }); await admin.connect();
const name = `node_leaderboard_accounting_test_${randomUUID().replaceAll('-', '')}`;
await admin.query(`CREATE DATABASE "${name}"`);
const target = new URL(configured); target.pathname = `/${name}`;
const database = new pg.Pool({ connectionString: target.href, max: 3 });
const originalFetch = globalThis.fetch, originalDispatcher = getGlobalDispatcher(), transport = new MockAgent();
transport.disableNetConnect(); setGlobalDispatcher(transport);
let attemptedFetches = 0;
globalThis.fetch = async () => { attemptedFetches++; throw new Error('All RPC and financial provider requests disabled'); };
const wallet = `0x${'1'.repeat(40)}`, privateWallet = `0x${'9'.repeat(40)}`;
const token = `0x${'a'.repeat(40)}`, unknownToken = `0x${'b'.repeat(40)}`, rewardToken = '0x24b518b332543a4e1c3649d063dab199d103760a';
const wbnb = '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c', trustedFeed = TRUSTED_QUOTE_FEEDS[wbnb];
const end = new Date('2026-10-19T18:00:00.000Z').getTime(), start = end - 86_400_000;
const iso = (milliseconds: number) => new Date(milliseconds).toISOString(), windowStart = iso(start), windowEnd = iso(end);
const hash = (number: number) => `0x${number.toString(16).padStart(64, '0')}`;
const generation = randomUUID(), privateGeneration = randomUUID();
const timestamps = new Map([[50, start - 72 * 3_600_000], [100, start - 48 * 3_600_000], [200, start - 1000],
  [250, start + 3_600_000], [260, start + 2 * 3_600_000], [275, start + 3 * 3_600_000], [300, end - 5000]]);
function event(id: string, kind: JournalLedgerEvent['kind'], quantity: string, usd: string | null, block: number, fee = '0', asset = token, payer = wallet): JournalLedgerEvent {
  return { id, walletAddress: payer, tokenAddress: asset, kind, tokenAmount: quantity, amountUsd: usd, feeUsd: fee, feeId: id,
    txHash: hash(block * 100 + Number(id.charCodeAt(0))), timestamp: iso(timestamps.get(block)!), blockNumber: String(block), transactionIndex: 0, logIndex: 1 };
}
const events = [event('buy', 'buy', '10', '100', 100, '2'), event('sale', 'sell', '4', '70', 250, '1'),
  { ...event('out', 'transfer_out', '2', '40', 260, '0.5'), counterparty: privateWallet }];
async function execution(row: JournalLedgerEvent, status = 'success') {
  const block = Number(row.blockNumber), negative = row.kind === 'sell' || row.kind === 'transfer_out';
  await database.query(`INSERT INTO node_evidence_transactions(tx_hash,block_number,block_hash,transaction_index,timestamp,transaction,receipt)
    VALUES($1,$2,$3,0,$4,$5::jsonb,$6::jsonb) ON CONFLICT DO NOTHING`, [row.txHash, block, hash(block), row.timestamp,
    JSON.stringify({ from: row.walletAddress, to: row.tokenAddress, value: '0x0' }), JSON.stringify({ status: '0x1', logs: [] })]);
  await database.query(`INSERT INTO node_executions(id,tx_hash,wallet_address,execution_index,block_number,block_hash,transaction_index,timestamp,status,kind,
    fee_native_wei,fee_complete,native_value_raw,logs,decoder_version)VALUES($1,$2,$3,0,$4,$5,0,$6,$7,'transaction',0,true,0,'[]',1)`,
  [row.id + row.walletAddress + row.tokenAddress, row.txHash, row.walletAddress, block, hash(block), row.timestamp, status]);
  await database.query(`INSERT INTO node_execution_flows(execution_id,token_address,delta_raw,log_indices,counterparties)
    VALUES($1,$2,$3,ARRAY[1],$4::text[])`, [row.id + row.walletAddress + row.tokenAddress, row.tokenAddress,
    `${negative ? '-' : ''}${BigInt(row.tokenAmount) * 10n ** 18n}`, row.counterparty ? [row.counterparty] : []]);
}
async function history(asset: string, rows: JournalLedgerEvent[], payer = wallet, complete = true) {
  const remaining = rows.reduce((sum, row) => sum + BigInt(row.tokenAmount) * (row.kind === 'sell' || row.kind === 'transfer_out' ? -1n : 1n), 0n);
  const payload: NodeAccountingEvidence = { events: rows, historicalEvents: [], baselines: [], openingBalances: [{ walletAddress: payer, tokenAddress: asset, tokenAmount: '0' }],
    proof: { walletAddress: payer, tokenAddress: asset, chain: 'bsc', blockNumber: '300', blockHash: hash(300), blockTimestamp: iso(end - 5000), checkedAt: iso(end - 5000), balance: remaining >= 0n ? remaining.toString() : '0' },
    coverage: { walletAddress: payer, tokenAddress: asset, complete, quantitiesComplete: true }, quote: null, source: 'node',
    historyFingerprint: 'f'.repeat(64), fromBlock: '50', throughBlock: '300', monitoringGeneration: payer === wallet ? generation : privateGeneration,
    historyBoundary: 'token_creation', reasons: [] };
  await database.query(`INSERT INTO node_accounting_history(scope_key,wallet_address,token_address,history_revision,from_block,to_block,to_hash,source,payload)
    VALUES('public',$1,$2,$3,50,300,$4,'node',$5::jsonb)ON CONFLICT(scope_key,wallet_address,token_address)DO UPDATE SET payload=EXCLUDED.payload,invalidated_at=NULL`,
  [payer, asset, 'f'.repeat(64), hash(300), JSON.stringify(payload)]);
}
async function calculate() { return loadPublicNodeLeaderboardAccounting({ database, wallets: [wallet, privateWallet], windowStart, windowEnd }); }
type PublicationCheck = Parameters<NonNullable<NodeLeaderboardCalculationRequest['beforePublish']>>[0];
async function capturePublicationChecks(wallets=[wallet,privateWallet]) {
  const checks: PublicationCheck[] = [];
  const snapshots = await loadPublicNodeLeaderboardAccounting({ database, wallets, windowStart, windowEnd,
    beforePublish: validate => { checks.push(validate); } });
  assert.ok(checks.length > 0, 'Consumed accounting evidence registers an internal publication fence');
  return { snapshots, checks };
}
async function validatePublication(checks: PublicationCheck[]) {
  const publication = await database.connect();
  try {
    await publication.query('BEGIN');
    await publication.query('SELECT pg_advisory_xact_lock_shared(782319)');
    for (const validate of checks) await validate(publication);
  } finally { await publication.query('ROLLBACK'); publication.release(); }
}

try {
  const initialize = `import {MockAgent,setGlobalDispatcher}from'undici';const guard=new MockAgent();guard.disableNetConnect();setGlobalDispatcher(guard);
    globalThis.fetch=async()=>{throw Error('No providers or RPC during disposable schema setup')};
    const {ensureSchema,pool}=await import('./server/db.ts');try{await ensureSchema()}finally{await pool.end();await guard.close()}`;
  await promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', initialize], {
    cwd: process.cwd(), windowsHide: true, timeout: 60_000, maxBuffer: 512 * 1024,
    env: { ...process.env, DATABASE_URL: target.href, TELEGRAM_BOT_TOKEN: '', TELEGRAM_WEBHOOK_SECRET: '', TELEGRAM_CLIENT_ID: '', TELEGRAM_CLIENT_SECRET: '',
      GMGN_API_KEY: '', GMGN_CHART_API_KEY: '', GMGN_ACCOUNTING_API_KEY: '', NODE_HISTORICAL_IMPORTS: '0' },
  });
  await database.query('INSERT INTO kols(address,display_name,is_tracked)VALUES($1,\'Public fixture\',true),($2,\'Private wallet\',false)', [wallet, privateWallet]);
  for (const asset of [token, unknownToken, rewardToken]) await database.query(`INSERT INTO tokens(address,symbol,name,decimals,is_meme)VALUES($1,$2,$2,18,true)`, [asset, asset === token ? 'NODE' : asset === unknownToken ? 'UNKNOWN-COST' : 'Reward']);
  for (const [block, time] of timestamps) await database.query(`INSERT INTO node_evidence_blocks(block_number,block_hash,parent_hash,timestamp,header)VALUES($1,$2,$3,$4,'{}')`, [block, hash(block), hash(block - 1), iso(time)]);
  await database.query(`INSERT INTO worker_state(key,value)VALUES('node','{"blockNumber":300}'),('node_collection','{"blockNumber":300}')`);
  for (const [payer, revision] of [[wallet, generation], [privateWallet, privateGeneration]]) {
    await database.query(`INSERT INTO node_monitored_wallets(wallet_address,generation,active,registration_block,registration_hash,collected_through_block,decoded_through_block,registered_at)
      VALUES($1,$2,true,50,$3,300,300,$4)`, [payer, revision, hash(50), iso(timestamps.get(50)!)]);
    await database.query(`INSERT INTO node_evidence_ranges(from_block,to_block,head_block,wallets,decoded_at)VALUES(51,300,306,jsonb_build_object($1::text,$2::text),now())`, [payer, revision]);
  }
  await database.query("UPDATE node_monitored_wallets SET registered_at=registered_at+interval '0.000321 seconds'");
  for (const row of events) await execution(row);
  await history(token, events);
  const privateSale = event('private-sale', 'sell', '1', '999999', 250, '0', token, privateWallet);
  await execution(privateSale); await history(token, [privateSale], privateWallet);
  const first = await calculate();
  assert.deepEqual(first.map(row => row.walletAddress), [wallet], 'Private monitored wallets are not public KOL accounting inputs or outputs');
  assert.equal(first[0].complete, true, JSON.stringify(first));
  assert.equal(first[0].source, 'node');
  assert.equal(first[0].realizedProfitUsd, '47.3', 'The current period consumes pre-window FIFO costs and their acquisition fees, then values external transfer-out gains');
  assert.equal(first[0].valuedSellCount, 1); assert.equal(first[0].valuedTransferOutCount, 1);
  assert.equal(first[0].coveredThroughBlock, '300'); assert.equal(first[0].asOf, iso(end - 5000));
  // Normalized range cohorts and unnormalized retained ranges prove the same
  // exact coverage. Both branches must participate during bounded backfill.
  const originalRange=(await database.query(`SELECT id,wallets,encode(sha256(convert_to(wallets::text,'UTF8')),'hex') AS fingerprint
    FROM node_evidence_ranges WHERE wallets ? $1`,[wallet])).rows[0];
  await database.query(`INSERT INTO node_evidence_cohorts(fingerprint,wallets)VALUES($1,$2::jsonb) ON CONFLICT DO NOTHING`,
    [originalRange.fingerprint,JSON.stringify(originalRange.wallets)]);
  await database.query('UPDATE node_evidence_ranges SET to_block=225 WHERE id=$1',[originalRange.id]);
  const normalizedRange=(await database.query(`INSERT INTO node_evidence_ranges(from_block,to_block,head_block,wallets,decoded_at,cohort_fingerprint)
    VALUES(226,300,306,$1::jsonb,now(),$2) RETURNING id`,[JSON.stringify(originalRange.wallets),originalRange.fingerprint])).rows[0];
  assert.equal((await calculate())[0].snapshotId,first[0].snapshotId,
    'Mixed normalized and legacy ranges retain the identical genuine coverage and accounting result');
  await database.query('UPDATE node_evidence_ranges SET decoded_at=NULL WHERE id=$1',[normalizedRange.id]);
  const pendingNormalized=(await calculate())[0];
  assert.equal(pendingNormalized.complete,false);assert.ok(pendingNormalized.reasons.includes('period_collection_incomplete'),
    'A normalized cohort never authorizes an undecoded range');
  await database.query('UPDATE node_evidence_ranges SET decoded_at=now() WHERE id=$1',[normalizedRange.id]);
  const wrongMap={...originalRange.wallets,[wallet]:randomUUID()};
  const wrongCohort=(await database.query(`INSERT INTO node_evidence_cohorts(fingerprint,wallets)
    SELECT encode(sha256(convert_to($1::jsonb::text,'UTF8')),'hex'),$1::jsonb RETURNING fingerprint`,[JSON.stringify(wrongMap)])).rows[0];
  await database.query('UPDATE node_evidence_ranges SET cohort_fingerprint=$2,wallets=$3::jsonb WHERE id=$1',
    [normalizedRange.id,wrongCohort.fingerprint,JSON.stringify(wrongMap)]);
  const wrongGeneration=(await calculate())[0];
  assert.equal(wrongGeneration.complete,false);assert.ok(wrongGeneration.reasons.includes('period_collection_incomplete'),
    'A normalized range for another monitoring generation cannot fill a retained legacy gap');
  await database.query('DELETE FROM node_evidence_ranges WHERE id=$1',[normalizedRange.id]);
  await database.query('UPDATE node_evidence_ranges SET to_block=300,cohort_fingerprint=$2 WHERE id=$1',
    [originalRange.id,originalRange.fingerprint]);
  assert.equal((await calculate())[0].snapshotId,first[0].snapshotId,
    'Completed normalized coverage preserves exact profit, source, as-of time and snapshot identity');
  // Captured position readiness cannot imply that the wallet was monitored
  // throughout a preceding 24-hour leaderboard window.
  const recentWallet=`0x${'4'.repeat(40)}`,recentGeneration=privateGeneration;
  await database.query("INSERT INTO kols(address,display_name,is_tracked)VALUES($1,'Recently monitored',true)",[recentWallet]);
  await database.query(`INSERT INTO node_monitored_wallets(wallet_address,generation,active,registration_block,registration_hash,collected_through_block,decoded_through_block,registered_at)
    VALUES($1,$2,true,250,$3,300,300,$4)`,[recentWallet,recentGeneration,hash(250),iso(timestamps.get(250)!)]);
  await database.query(`INSERT INTO node_evidence_ranges(from_block,to_block,head_block,wallets,decoded_at)
    VALUES(251,300,306,jsonb_build_object($1::text,$2::text),now())`,[recentWallet,recentGeneration]);
  const recentEvents=[event('recent-buy','buy','10','100',260,'2',token,recentWallet),event('recent-sale','sell','4','70',275,'1',token,recentWallet)];
  for(const row of recentEvents)await execution(row);
  await history(token,recentEvents,recentWallet);
  await database.query(`UPDATE node_accounting_history SET from_block=250,payload=payload||$3::jsonb WHERE wallet_address=$1 AND token_address=$2`,
    [recentWallet,token,JSON.stringify({fromBlock:'250',historyBoundary:'verified_zero_position',historyFrom:iso(timestamps.get(250)!),coverage:{walletAddress:recentWallet,tokenAddress:token,complete:true,quantitiesComplete:true}})]);
  const recentPeriod=(await loadPublicNodeLeaderboardAccounting({database,wallets:[recentWallet],windowStart,windowEnd}))[0];
  assert.equal(recentPeriod.complete,false,'Complete captured-position P&L does not authorize a period before monitoring began');
  assert.equal(recentPeriod.realizedProfitUsd,null);
  assert.equal(recentPeriod.knownRealizedProfitUsd,'28.2','The known, fully captured sale remains available as an explicit partial result');
  assert.ok(recentPeriod.reasons.includes('period_collection_incomplete'));
  const coveredRecent=(await loadPublicNodeLeaderboardAccounting({database,wallets:[recentWallet],windowStart:iso(timestamps.get(260)!+1000),windowEnd}))[0];
  assert.equal(coveredRecent.complete,true,'A requested period wholly inside proven monitoring can use the captured purchase history: '+JSON.stringify(coveredRecent));
  assert.equal(coveredRecent.realizedProfitUsd,'28.2');
  assert.equal((await calculate())[0].snapshotId, first[0].snapshotId, 'Unchanged database evidence and original observation time give an identical snapshot');
  const preciseRegistration=await capturePublicationChecks();
  await assert.doesNotReject(validatePublication(preciseRegistration.checks),
    'Unchanged PostgreSQL microsecond registration timestamps survive publication proof serialization without JS Date truncation');

  // A normal bulk checkpoint update need not visit wallets in lexical order.
  // Hold its later row and a publisher's earlier row to reproduce that real
  // reverse-order cycle; publication must yield rather than deadlock capture.
  const laterWallet=`0x${'2'.repeat(40)}`;
  await database.query("INSERT INTO kols(address,display_name,is_tracked)VALUES($1,'Concurrent collector',true)",[laterWallet]);
  await database.query(`INSERT INTO node_monitored_wallets(wallet_address,generation,active,registration_block,registration_hash,collected_through_block,decoded_through_block,registered_at)
    VALUES($1,$2,true,50,$3,300,300,$4)`,[laterWallet,randomUUID(),hash(50),iso(timestamps.get(50)!)]);
  const contention=await capturePublicationChecks([wallet,laterWallet]);
  const publishing=await database.connect(),collecting=await database.connect();
  let advancing:Promise<void>|undefined;
  try {
    await collecting.query('BEGIN');await collecting.query('SELECT pg_advisory_xact_lock_shared(782319)');
    await collecting.query('SELECT wallet_address FROM node_monitored_wallets WHERE wallet_address=$1 FOR UPDATE',[laterWallet]);
    await publishing.query('BEGIN');await publishing.query('SELECT pg_advisory_xact_lock_shared(782319)');
    await publishing.query('SELECT wallet_address FROM node_monitored_wallets WHERE wallet_address=$1 FOR SHARE',[wallet]);
    const validating=contention.checks[0](publishing);
    advancing=advanceNodeDecodeCheckpoints(collecting);
    await assert.rejects(validating,/node_leaderboard_monitoring_changed/,
      'A contended monitoring fence yields with its ordinary retry status instead of forming a wallet-row deadlock');
    await publishing.query('ROLLBACK');
    await advancing;await collecting.query('COMMIT');
  } finally {
    await publishing.query('ROLLBACK');
    if(advancing)await advancing.catch(()=>undefined);
    await collecting.query('ROLLBACK');publishing.release();collecting.release();
  }
  await assert.doesNotReject(validatePublication((await capturePublicationChecks([wallet,laterWallet])).checks),
    'After the concurrent collector commits, unchanged monitoring proof can publish normally');

  const failedHash = hash(27500);
  await database.query(`INSERT INTO node_evidence_transactions(tx_hash,block_number,block_hash,transaction_index,timestamp,transaction,receipt)
    VALUES($1,275,$2,1,$3,$4::jsonb,'{"status":"0x0","logs":[]}')`, [failedHash, hash(275), iso(timestamps.get(275)!), JSON.stringify({ from: wallet, to: token, value: '0x0' })]);
  await database.query(`INSERT INTO node_executions(id,tx_hash,wallet_address,execution_index,block_number,block_hash,transaction_index,timestamp,status,kind,
    fee_native_wei,fee_complete,native_value_raw,logs,decoder_version)VALUES('failed-fee',$1,$2,0,275,$3,1,$4,'failed','transaction',100000000000000,true,0,'[]',1)`,
  [failedHash, wallet, hash(275), iso(timestamps.get(275)!)]);
  await database.query(`INSERT INTO node_market_feed_evidence(quote_address,feed_address,feed_description,block_number,block_hash,timestamp,round_id,answered_in_round,answer_raw,feed_decimals,price_usd,updated_at)
    VALUES($1,$2,$3,275,$4,$5,1,1,100000000000,8,1000,$5)`, [wbnb, trustedFeed.feed, trustedFeed.description, hash(275), iso(timestamps.get(275)!)]);
  const withFailed = (await calculate())[0];
  assert.equal(withFailed.complete, true); assert.equal(withFailed.realizedProfitUsd, '47.2');
  assert.equal(withFailed.feeOnlyFeesUsd, '0.1'); assert.equal(withFailed.valuedFeeCount, 1);
  assert.equal((await calculate())[0].realizedProfitUsd, '47.2', 'Rerunning collection never duplicates failed execution fees');
  const beforeGenerationChange=await capturePublicationChecks();
  await database.query('UPDATE node_monitored_wallets SET generation=$2 WHERE wallet_address=$1',[wallet,randomUUID()]);
  await assert.rejects(validatePublication(beforeGenerationChange.checks),/node_leaderboard_monitoring_changed/,
    'A collection generation change cannot publish accounting prepared against an earlier registry');
  await database.query('UPDATE node_monitored_wallets SET generation=$2 WHERE wallet_address=$1',[wallet,generation]);
  const beforeRepair=await capturePublicationChecks();
  await database.query('UPDATE node_monitored_wallets SET repair_from_block=250 WHERE wallet_address=$1',[wallet]);
  await assert.rejects(validatePublication(beforeRepair.checks),/node_leaderboard_monitoring_changed/,
    'A newly discovered repair gap invalidates a calculated period before publication');
  await database.query('UPDATE node_monitored_wallets SET repair_from_block=NULL WHERE wallet_address=$1',[wallet]);
  await database.query('UPDATE node_executions SET timestamp=$1 WHERE id<>$2',[iso(start-1000),'failed-fee']);
  const feeOnly=await capturePublicationChecks();
  assert.equal(feeOnly.snapshots[0].realizedProfitUsd,'-0.1','Fee-only public wallets have the same collection proof requirements as token positions');
  await database.query('UPDATE node_monitored_wallets SET generation=$2 WHERE wallet_address=$1',[wallet,randomUUID()]);
  await assert.rejects(validatePublication(feeOnly.checks),/node_leaderboard_monitoring_changed/,
    'A fee-only wallet without consumed position history is still protected by the monitoring fence');
  await database.query('UPDATE node_monitored_wallets SET generation=$2 WHERE wallet_address=$1',[wallet,generation]);
  for(const row of events)await database.query('UPDATE node_executions SET timestamp=$2 WHERE id=$1',[row.id+row.walletAddress+row.tokenAddress,row.timestamp]);

  const originalHistory = (await database.query(`SELECT payload FROM node_accounting_history WHERE scope_key='public'
    AND wallet_address=$1 AND token_address=$2`, [wallet, token])).rows[0].payload;
  const beforeFinancialCorrection = await capturePublicationChecks();
  assert.equal(beforeFinancialCorrection.snapshots[0].realizedProfitUsd, '47.2');
  await database.query(`UPDATE node_accounting_history SET payload=jsonb_set(payload,'{events,1,amountUsd}','"71"')
    WHERE scope_key='public' AND wallet_address=$1 AND token_address=$2`, [wallet, token]);
  await assert.rejects(validatePublication(beforeFinancialCorrection.checks), /node_leaderboard_accounting_evidence_changed/,
    'A same-block correction cannot publish an earlier amount even if the stored history revision is unchanged');
  await database.query(`UPDATE node_accounting_history SET payload=$3::jsonb WHERE scope_key='public'
    AND wallet_address=$1 AND token_address=$2`, [wallet, token, JSON.stringify(originalHistory)]);
  const beforeInvalidation = await capturePublicationChecks();
  await database.query(`UPDATE node_accounting_history SET invalidated_at=clock_timestamp() WHERE scope_key='public'
    AND wallet_address=$1 AND token_address=$2`, [wallet, token]);
  await assert.rejects(validatePublication(beforeInvalidation.checks), /node_leaderboard_accounting_evidence_changed/,
    'A canonical trace/repair invalidation between calculation and publication fences the stale result');
  await database.query(`UPDATE node_accounting_history SET invalidated_at=NULL WHERE scope_key='public'
    AND wallet_address=$1 AND token_address=$2`, [wallet, token]);
  const beforeQuoteRefresh = await capturePublicationChecks();
  const quoteRefreshed = { ...originalHistory, quote: { priceUsd: '999', timestamp: iso(end - 1000), asOf: iso(end - 1000) },
    proof: { ...originalHistory.proof, checkedAt: iso(end - 1000) } };
  await database.query(`UPDATE node_accounting_history SET payload=$3::jsonb,observed_at=clock_timestamp()
    WHERE scope_key='public' AND wallet_address=$1 AND token_address=$2`, [wallet, token, JSON.stringify(quoteRefreshed)]);
  await assert.doesNotReject(validatePublication(beforeQuoteRefresh.checks),
    'Ordinary quote/as-of and proof-check refreshes do not repeatedly starve an unchanged realized-profit publication');
  await database.query(`UPDATE node_accounting_history SET payload=$3::jsonb WHERE scope_key='public'
    AND wallet_address=$1 AND token_address=$2`, [wallet, token, JSON.stringify(originalHistory)]);

  const lockedPublication = await database.connect(), concurrentCorrection = await database.connect();
  try {
    const publication = await capturePublicationChecks();
    await lockedPublication.query('BEGIN');
    await lockedPublication.query('SELECT pg_advisory_xact_lock_shared(782319)');
    for (const validate of publication.checks) await validate(lockedPublication);
    await concurrentCorrection.query('BEGIN');
    await concurrentCorrection.query("SET LOCAL lock_timeout='100ms'");
    await assert.rejects(concurrentCorrection.query(`UPDATE node_accounting_history SET invalidated_at=clock_timestamp()
      WHERE scope_key='public' AND wallet_address=$1 AND token_address=$2`, [wallet, token]),
    (error: any) => error.code === '55P03', 'Publication locks protect the validated financial rows until its transaction finishes');
    await concurrentCorrection.query('ROLLBACK');await concurrentCorrection.query('BEGIN');
    await concurrentCorrection.query("SET LOCAL lock_timeout='100ms'");
    await assert.rejects(concurrentCorrection.query('UPDATE node_monitored_wallets SET generation=$2 WHERE wallet_address=$1',[wallet,randomUUID()]),
      (error:any)=>error.code==='55P03','The first publication fence holds the monitored generation stable until commit');
  } finally {
    await concurrentCorrection.query('ROLLBACK'); await lockedPublication.query('ROLLBACK');
    concurrentCorrection.release(); lockedPublication.release();
  }

  const beforeFeeCorrection = await capturePublicationChecks();
  await database.query("UPDATE node_executions SET fee_native_wei=200000000000000 WHERE id='failed-fee'");
  await assert.rejects(validatePublication(beforeFeeCorrection.checks), /node_leaderboard_(?:accounting|fee)_evidence_changed/,
    'Changing the authenticated fee-only execution after calculation cannot publish the old gas cost');
  await database.query("UPDATE node_executions SET fee_native_wei=100000000000000 WHERE id='failed-fee'");

  await database.query(`UPDATE node_accounting_history SET payload=jsonb_set(payload,'{proof,balance}','"5"') WHERE wallet_address=$1 AND token_address=$2`, [wallet, token]);
  const contradictoryBalance = (await calculate())[0];
  assert.equal(contradictoryBalance.complete, false); assert.equal(contradictoryBalance.realizedProfitUsd, null);
  assert.ok(contradictoryBalance.reasons.includes('balance_unreconciled'), 'A current real-balance contradiction cannot authorize the dated FIFO result');
  await database.query(`UPDATE node_accounting_history SET payload=jsonb_set(payload,'{proof,balance}','"4"') WHERE wallet_address=$1 AND token_address=$2`, [wallet, token]);
  await database.query('UPDATE node_market_feed_evidence SET feed_address=$1 WHERE quote_address=$2', [hash(999).slice(0, 42), wbnb]);
  const unknownFee = (await calculate())[0];
  assert.equal(unknownFee.complete, false); assert.equal(unknownFee.realizedProfitUsd, null);
  assert.ok(unknownFee.reasons.includes('fees_incomplete')); assert.equal(unknownFee.excludedFeeCount, 1, 'An unauthenticated feed is not a usable fee valuation');
  await database.query('UPDATE node_market_feed_evidence SET feed_address=$1 WHERE quote_address=$2', [trustedFeed.feed, wbnb]);

  const unpricedEvents = [event('unknown-buy', 'buy', '2', null, 100, '0', unknownToken), event('unknown-sale', 'sell', '1', '20', 250, '0', unknownToken)];
  for (const row of unpricedEvents) await execution(row);
  await history(unknownToken, unpricedEvents);
  const partial = (await calculate())[0];
  assert.equal(partial.complete, false); assert.equal(partial.realizedProfitUsd, null);
  assert.equal(partial.knownRealizedProfitUsd, '47.2', 'A partial result retains proved contributions without publishing them as the complete wallet total');
  assert.equal(partial.valuedSellCount, 1); assert.equal(partial.excludedSellCount, 1);
  assert.ok(partial.reasons.includes('purchase_cost_unknown'));
  await database.query('UPDATE node_accounting_history SET invalidated_at=now() WHERE wallet_address=$1 AND token_address=$2', [wallet, unknownToken]);
  const pending = (await calculate())[0];
  assert.ok(pending.reasons.includes('accounting_pending'));
  assert.equal((await database.query(`SELECT count(*)::int AS count FROM node_accounting_jobs WHERE scope_key='public'AND wallet_address=$1 AND token_address=$2`, [wallet, unknownToken])).rows[0].count, 1,
    'An invalidated selected history joins one durable accounting job');
  await database.query('DELETE FROM node_executions WHERE wallet_address=$1 AND id LIKE $2', [wallet, '%'+unknownToken]);
  const ignoredReward = event('reward-sale', 'sell', '1', '999999', 260, '0', rewardToken);
  await execution(ignoredReward);
  const rewardExcluded = (await calculate())[0];
  assert.equal(rewardExcluded.complete, true); assert.equal(rewardExcluded.realizedProfitUsd, '47.2', 'Reward/pair token exclusions apply before accounting preparation');
  assert.equal((await database.query('SELECT count(*)::int AS count FROM node_accounting_jobs WHERE token_address=$1', [rewardToken])).rows[0].count, 0);

  await database.query("DELETE FROM worker_state WHERE key='node_collection'");
  const missingCheckpoint = (await calculate())[0];
  assert.equal(missingCheckpoint.complete, false); assert.equal(missingCheckpoint.realizedProfitUsd, null);
  assert.equal(missingCheckpoint.coveredThroughBlock, null, 'A remaining decoder checkpoint alone cannot authorize collection coverage');
  assert.ok(missingCheckpoint.reasons.includes('period_collection_incomplete'));
  await database.query(`INSERT INTO worker_state(key,value)VALUES('node_collection','{"blockNumber":300}')`);
  await database.query('UPDATE node_evidence_ranges SET decoded_at=NULL WHERE wallets ? $1', [wallet]);
  const missingRange = (await calculate())[0];
  assert.equal(missingRange.complete, false); assert.ok(missingRange.reasons.includes('period_collection_incomplete'));
  await database.query('UPDATE node_evidence_ranges SET decoded_at=now() WHERE wallets ? $1', [wallet]);
  await database.query('UPDATE node_monitored_wallets SET registration_block=400,registered_at=$2 WHERE wallet_address=$1', [wallet, iso(end + 1000)]);
  const futureRegistration = (await calculate())[0];
  assert.equal(futureRegistration.complete, false); assert.ok(futureRegistration.reasons.includes('period_collection_incomplete'),
    'A registration after the committed checkpoint stays unavailable instead of constructing a reversed PostgreSQL range');
  await database.query('UPDATE node_monitored_wallets SET registration_block=50,registered_at=$2 WHERE wallet_address=$1', [wallet, iso(timestamps.get(50)!)]);
  await database.query('UPDATE node_accounting_history SET to_hash=$1 WHERE wallet_address=$2 AND token_address=$3', [hash(9999), wallet, token]);
  const orphan = (await calculate())[0];
  assert.equal(orphan.complete, false); assert.ok(orphan.reasons.includes('chain_reorganization'));
  await database.query('UPDATE node_accounting_history SET to_hash=$1 WHERE wallet_address=$2 AND token_address=$3',[hash(300),wallet,token]);
  const closedAsset=`0x${'c'.repeat(40)}`;
  await database.query("INSERT INTO tokens(address,symbol,name,decimals,is_meme)VALUES($1,'CLOSED','Whole imported history',18,true)",[closedAsset]);
  const closedHistory=[{...event('closed-buy','buy','10','100',250,'0',closedAsset),feeUsd:null},
    {...event('closed-sale','sell','10','130',260,'0',closedAsset),feeUsd:null}];
  const closedLedger={investedUsd:'100',soldUsd:'130',incomingTransferCostUsd:'0',transferOutIncomeUsd:'0',feesUsd:'5',
    realizedProfitUsd:'25',feeInclusiveCapitalUsd:'103',lots:[]};
  const canonicalJson=(value:any):any=>Array.isArray(value)?value.map(canonicalJson):value&&typeof value==='object'
    ?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>[key,canonicalJson(item)])):value;
  const closedFingerprint=createHash('sha256').update(JSON.stringify(canonicalJson(closedHistory))).digest('hex');
  const closedPayload:NodeAccountingEvidence={...originalHistory,source:'imported',historyBoundary:'imported_baseline',events:[],historicalEvents:closedHistory,
    baselines:[{walletAddress:wallet,tokenAddress:closedAsset,...closedLedger}],openingBalances:[],proof:{...originalHistory.proof!,tokenAddress:closedAsset,balance:'0'},
    coverage:{walletAddress:wallet,tokenAddress:closedAsset,complete:true,quantitiesComplete:true}};
  await database.query(`INSERT INTO node_accounting_baselines(wallet_address,token_address,checkpoint_block,checkpoint_hash,checkpoint_timestamp,balance,history_fingerprint,ledger,events)
    VALUES($1,$2,275,$3,$4,0,$5,$6::jsonb,$7::jsonb)`,[wallet,closedAsset,hash(275),iso(timestamps.get(275)!),closedFingerprint,JSON.stringify(closedLedger),JSON.stringify(closedHistory)]);
  await database.query(`INSERT INTO node_import_jobs(wallet_address,token_address,stage,history_complete,head_fingerprint)
    VALUES($1,$2,'done',true,$3)`,[wallet,closedAsset,'a'.repeat(64)]);
  for(const movement of closedHistory)await database.query(`INSERT INTO node_import_movements(wallet_address,token_address,id,event,raw,payload_hash)
    VALUES($1,$2,$3,$4::jsonb,'{}',$5)`,[wallet,closedAsset,movement.id,JSON.stringify(movement),closedFingerprint]);
  await database.query(`INSERT INTO node_accounting_history(scope_key,wallet_address,token_address,history_revision,from_block,to_block,to_hash,source,payload)
    VALUES('public',$1,$2,$3,275,300,$4,'imported',$5::jsonb)`,[wallet,closedAsset,closedFingerprint,hash(300),JSON.stringify(closedPayload)]);
  const wholeClosed=(await calculate())[0];
  assert.equal(wholeClosed.complete,true,JSON.stringify(wholeClosed));assert.equal(wholeClosed.realizedProfitUsd,'72.2');
  assert.equal(wholeClosed.valuedSellCount,2,'A wholly closed lifetime history inside the period uses verified aggregate fees without dating those fees to individual rows');
  await database.query(`INSERT INTO node_evidence_transactions(tx_hash,block_number,block_hash,transaction_index,timestamp,transaction,receipt)
    VALUES($1,260,$2,2,$3,$4::jsonb,'{"status":"0x1","logs":[]}')`,[closedHistory[1].txHash,hash(260),closedHistory[1].timestamp,JSON.stringify({from:wallet,to:closedAsset,value:'0x0'})]);
  await database.query(`INSERT INTO node_executions(id,tx_hash,wallet_address,execution_index,block_number,block_hash,transaction_index,timestamp,status,kind,
    fee_native_wei,fee_complete,native_value_raw,logs,decoder_version)VALUES('covered-import-gas',$1,$2,0,260,$3,2,$4,'success','transaction',100000000000000,true,0,'[]',1)`,
    [closedHistory[1].txHash,wallet,hash(260),closedHistory[1].timestamp]);
  await database.query(`INSERT INTO node_market_feed_evidence(quote_address,feed_address,feed_description,block_number,block_hash,timestamp,round_id,answered_in_round,answer_raw,feed_decimals,price_usd,updated_at)
    VALUES($1,$2,$3,260,$4,$5,1,1,100000000000,8,1000,$5)`,[wbnb,trustedFeed.feed,trustedFeed.description,hash(260),closedHistory[1].timestamp]);
  const withCoveredGas=(await calculate())[0];assert.equal(withCoveredGas.realizedProfitUsd,'72.2');assert.equal(withCoveredGas.valuedFeeCount,1,
    'An imported closed aggregate already includes EOA gas even when imported and node fee identities differ');
  await database.query("DELETE FROM node_executions WHERE id='covered-import-gas'");
  const reopenedEvents=[event('reopen-buy','buy','2','20',300,'1',closedAsset),
    {...event('reopen-sale','sell','1','15',300,'1',closedAsset),transactionIndex:1}];
  const reopened={...closedPayload,source:'mixed' as const,events:reopenedEvents,proof:{...closedPayload.proof!,balance:'1'}};
  await database.query('UPDATE node_accounting_history SET payload=$3::jsonb WHERE wallet_address=$1 AND token_address=$2',[wallet,closedAsset,JSON.stringify(reopened)]);
  assert.equal((await calculate())[0].realizedProfitUsd,'75.7','A node reopening after the closed baseline adds normal FIFO profit without counting lifetime gains twice');
  await database.query('UPDATE node_accounting_history SET payload=$3::jsonb WHERE wallet_address=$1 AND token_address=$2',[wallet,closedAsset,JSON.stringify(closedPayload)]);
  await database.query('UPDATE node_import_jobs SET history_complete=false WHERE wallet_address=$1 AND token_address=$2',[wallet,closedAsset]);
  const partialImport=(await calculate())[0];assert.equal(partialImport.realizedProfitUsd,null);assert.equal(partialImport.knownRealizedProfitUsd,'47.2');
  assert.ok(partialImport.reasons.includes('historical_fee_allocation_unknown'),'An incomplete lifetime import cannot substitute aggregate profit for a period');
  await database.query('UPDATE node_import_jobs SET history_complete=true WHERE wallet_address=$1 AND token_address=$2',[wallet,closedAsset]);
  const truncated={...closedPayload,historicalEvents:closedHistory.slice(1)};
  await database.query('UPDATE node_accounting_history SET payload=$3::jsonb WHERE wallet_address=$1 AND token_address=$2',[wallet,closedAsset,JSON.stringify(truncated)]);
  assert.equal((await calculate())[0].knownRealizedProfitUsd,'47.2','A truncated cached history cannot bypass the persisted full-history fingerprint');
  const straddled={...closedPayload,historicalEvents:[{...closedHistory[0],timestamp:iso(start-1000)},closedHistory[1]]};
  const straddledFingerprint=createHash('sha256').update(JSON.stringify(canonicalJson(straddled.historicalEvents))).digest('hex');
  await database.query('UPDATE node_accounting_baselines SET history_fingerprint=$3,events=$4::jsonb WHERE wallet_address=$1 AND token_address=$2',
    [wallet,closedAsset,straddledFingerprint,JSON.stringify(straddled.historicalEvents)]);
  await database.query('UPDATE node_accounting_history SET payload=$3::jsonb WHERE wallet_address=$1 AND token_address=$2',[wallet,closedAsset,JSON.stringify(straddled)]);
  assert.equal((await calculate())[0].knownRealizedProfitUsd,'47.2','A lifetime aggregate straddling the period cannot allocate unknown historical fees into the period');
  const openLedger={...closedLedger,lots:[{tokenAmount:'1',costBasisUsd:'10'}]};
  const openPayload={...closedPayload,baselines:[{walletAddress:wallet,tokenAddress:closedAsset,...openLedger}],proof:{...closedPayload.proof!,balance:'1'}};
  await database.query('UPDATE node_accounting_baselines SET balance=1,ledger=$3::jsonb,history_fingerprint=$4 WHERE wallet_address=$1 AND token_address=$2',
    [wallet,closedAsset,JSON.stringify(openLedger),closedFingerprint]);
  await database.query('UPDATE node_accounting_history SET payload=$3::jsonb WHERE wallet_address=$1 AND token_address=$2',[wallet,closedAsset,JSON.stringify(openPayload)]);
  const openAggregate=(await calculate())[0];assert.equal(openAggregate.realizedProfitUsd,null);assert.equal(openAggregate.knownRealizedProfitUsd,'47.2',
    'An open imported baseline cannot substitute an aggregate result for unknown FIFO fee allocation');
  assert.equal(attemptedFetches, 0, 'The loader obtains no data from RPC, GMGN or any other HTTP financial provider');
  console.log('Node leaderboard accounting PostgreSQL integration passed: full-history FIFO, acquisition/disposal fees, external marked transfers, private/reward isolation, failed fees, authenticated feeds, financial publication fences/locks, nonfinancial refreshes, partial costs, coalesced preparation, missing checkpoints/ranges and reorg evidence; all network financial transports disabled.');
} finally {
  globalThis.fetch = originalFetch; setGlobalDispatcher(originalDispatcher); await transport.close(); await database.end();
  if (!/^node_leaderboard_accounting_test_[a-f0-9]{32}$/.test(name)) throw new Error('Invalid disposable database name');
  await admin.query(`DROP DATABASE "${name}" WITH(FORCE)`); await admin.end();
}
