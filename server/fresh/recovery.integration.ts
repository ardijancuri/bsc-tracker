/** Real PostgreSQL decoder/recovery fixtures. Every fixture write is enclosed
 * in one rolled-back transaction; node responses are deterministic mocks. */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { getCreateAddress, Interface } from 'ethers';
import { Pool } from 'pg';
import { RpcRequestError, type Rpc } from '../rpc.js';
import { PCS_V2_FACTORY, WBNB } from '../launchpad.js';
import { TRUSTED_QUOTE_FEEDS } from '../nodeMarketProtocols.js';
import { transferTopic, swapTopics } from '../swap.js';
import { decodeFreshEvidence, encodeFreshEvidence, type FreshBlock, type FreshCapturedReceipt, type FreshLog, type FreshReceipt } from './capture.js';
import { FRESH_INITIALIZED_DECIMALS_AUDIT } from './metadataRecovery.js';
import { createFreshReceiptRecovery } from './recovery.js';
import { createFreshRecoveryBatch } from './recoveryBatch.js';
import { FRESH_DECODER_VERSION, runFreshDecode } from './decode.js';

const url = new URL(process.env.DATABASE_URL ?? '');
if (!['localhost', '127.0.0.1'].includes(url.hostname) || url.port !== '5436'
  || !/^\/kollens_fresh_[a-z0-9_]+$/.test(url.pathname)) throw new Error('Local isolated Fresh PostgreSQL required');
const db = new Pool({ connectionString: url.toString(), max: 1 }), client = await db.connect();
const address = () => `0x${randomBytes(20).toString('hex')}`, hash = () => `0x${randomBytes(32).toString('hex')}`;
const creator = address(), wallet = address(), sender = address(), pool = address(), token = getCreateAddress({ from: creator, nonce: 0 }).toLowerCase();
const scope = `kol:${wallet}`, sourceTx = hash(), targetTx = hash(), throwingTx = hash(), creationTxHash = hash();
const wall = Math.floor(Date.now() / 1000) * 1000, now = new Date(wall), iso = (secondsAgo: number) => new Date(wall - secondsAgo * 1000).toISOString();
const hex = (value: number | bigint) => `0x${BigInt(value).toString(16)}`, word = (value: string) => `0x${value.slice(2).padStart(64, '0')}`;
const abi = new Interface(['function decimals() view returns(uint8)', 'function totalSupply() view returns(uint256)',
  'function factory() view returns(address)', 'function token0() view returns(address)', 'function token1() view returns(address)',
  'function getPair(address,address) view returns(address)', 'function getReserves() view returns(uint112,uint112,uint32)',
  'event Sync(uint112 reserve0,uint112 reserve1)']);
const oracleAbi = new Interface(['function decimals() view returns(uint8)', 'function description() view returns(string)',
  'function latestRoundData() view returns(uint80,int256,uint256,uint256,uint80)', 'function getRoundData(uint80) view returns(uint80,int256,uint256,uint256,uint80)']);

// Reuse the checked-in exact public bytecode fixture without duplicating it or
// reading live contracts/credentials. This never imports or runs Vitest.
const testSource = await readFile(new URL('./metadataRecovery.test.ts', import.meta.url), 'utf8');
const compressed = testSource.match(/gunzipSync\(Buffer\.from\('([A-Za-z0-9+/=]+)', 'base64'\)\)/)?.[1];
assert.ok(compressed, 'Audited public implementation fixture missing');
const implementationCode = gunzipSync(Buffer.from(compressed, 'base64')).toString();

try {
  await client.query('BEGIN'); await client.query('SELECT pg_advisory_xact_lock(73621941)');
  const existing = (await client.query("SELECT block_number FROM fresh.checkpoints WHERE key='capture'")).rows[0];
  assert.ok(existing, 'Initialize the local Fresh database before this integration test');
  const base = Number(existing.block_number) + 100, creationN = base, sourceN = base + 10, syncN = base + 20, targetN = base + 30, anchorN = base + 40;
  const creationHash = hash(), sourceHash = hash(), syncHash = hash(), targetHash = hash(), anchorHash = hash();
  const target = { number: targetN, hash: targetHash, timestamp: iso(120) }, anchor = { number: anchorN, hash: anchorHash, timestamp: iso(2) };
  const tables = new Map([
    ['fresh.recent_evidence', 'recovery_fixture_evidence'], ['fresh.recent_blocks', 'recovery_fixture_blocks'],
    ['fresh.jobs', 'recovery_fixture_jobs'], ['fresh.checkpoints', 'recovery_fixture_checkpoints'], ['fresh.launch_facts', 'recovery_fixture_launches'],
  ]);
  for (const [original, temporary] of tables) await client.query(`CREATE TEMP TABLE ${temporary}(LIKE ${original} INCLUDING ALL) ON COMMIT DROP`);
  for (const [number, blockHash, timestamp] of [[creationN, creationHash, iso(300)], [sourceN, sourceHash, iso(240)], [syncN, syncHash, iso(150)], [targetN, targetHash, target.timestamp], [anchorN, anchorHash, anchor.timestamp]] as const) {
    await client.query('INSERT INTO recovery_fixture_blocks(block_number,block_hash,parent_hash,occurred_at) VALUES($1,$2,$3,$4)', [number, blockHash, hash(), timestamp]);
  }
  await client.query("INSERT INTO recovery_fixture_checkpoints(key,block_number,block_hash,value) VALUES('capture',$1,$2,$3::jsonb)", [anchorN, anchorHash, JSON.stringify({ startBlock: base - 10 })]);
  await client.query('INSERT INTO fresh.wallets(address,monitoring_from_block) VALUES($1,$2)', [wallet, base - 10]);
  await client.query('INSERT INTO fresh.kols(wallet_address,display_name) VALUES($1,$2)', [wallet, 'Recovery integration fixture']);
  await client.query("INSERT INTO fresh.accounting_scopes(id,kind,wallet_addresses,starts_at,starts_block) VALUES($1,'kol',$2,$3,$4)", [scope, [wallet], iso(360), base - 10]);
  // Bait values must never become historical precision or historical USD.
  await client.query("INSERT INTO fresh.tokens(address,name,decimals,price_usd,launch_status,valuation_status) VALUES($1,'Current-row bait',18,9999,'eligible','ready')", [token]);

  const creationTransaction = { hash: creationTxHash, from: creator, to: null, nonce: '0x0', value: '0x0', blockHash: creationHash, blockNumber: hex(creationN), transactionIndex: '0x0', gasPrice: '0x0',
    input: `0x3d602d80600a3d3981f3363d3d373d3d3d363d73${FRESH_INITIALIZED_DECIMALS_AUDIT.implementationAddress.slice(2)}5af43d82803e903d91602b57fd5bf3` };
  const creationBlock: FreshBlock = { number: hex(creationN), hash: creationHash, parentHash: hash(), timestamp: hex(BigInt(Date.parse(iso(300))) / 1000n), transactions: [creationTransaction] };
  const creationReceipt: FreshReceipt = { transactionHash: creationTxHash, blockHash: creationHash, blockNumber: hex(creationN), transactionIndex: '0x0', status: '0x1', contractAddress: token, gasUsed: '0x1', effectiveGasPrice: '0x0', logs: [] };
  await client.query('UPDATE recovery_fixture_blocks SET parent_hash=$2 WHERE block_number=$1', [creationN, creationBlock.parentHash]);
  await client.query(`INSERT INTO recovery_fixture_launches(token_address,protocol,block_number,block_hash,tx_hash,launched_at,proof,status)
    VALUES($1,'evm_creation',$2,$3,$4,$5,$6::jsonb,'eligible')`, [token, creationN, creationHash, creationTxHash, iso(300), JSON.stringify({ creator, creation: 'top_level' })]);

  const sourceCall = (to: string, method: string, args: unknown[], result: unknown[]) => ({ to, data: abi.encodeFunctionData(method, args), result: abi.encodeFunctionResult(method, result) });
  const sourceEntry: FreshCapturedReceipt = { transaction: { hash: sourceTx, from: sender, to: sender, value: '0x0', blockHash: sourceHash, blockNumber: hex(sourceN), transactionIndex: '0x0' },
    receipt: { transactionHash: sourceTx, blockHash: sourceHash, blockNumber: hex(sourceN), transactionIndex: '0x0', status: '0x1', gasUsed: '0x1', logs: [] },
    wallets: [wallet], observedAt: iso(240), stateEvidence: { version: 1, blockNumber: sourceN, blockHash: sourceHash, calls: [
      sourceCall(token, 'decimals', [], [9]), sourceCall(WBNB, 'decimals', [], [18]), sourceCall(PCS_V2_FACTORY, 'getPair', [token, WBNB], [pool]),
      sourceCall(pool, 'factory', [], [PCS_V2_FACTORY]), sourceCall(pool, 'token0', [], [token]), sourceCall(pool, 'token1', [], [WBNB]),
      sourceCall(pool, 'getReserves', [], [1000n * 10n ** 9n, 10n ** 18n, 1]),
    ] } };
  const transfer: FreshLog = { address: token, topics: [transferTopic, word(sender), word(wallet)], data: word(hex(10n * 10n ** 9n)), logIndex: '0x0', transactionHash: targetTx, transactionIndex: '0x0', blockNumber: hex(targetN), blockHash: targetHash };
  const entry: FreshCapturedReceipt = { transaction: { hash: targetTx, from: sender, to: token, value: '0x0', blockHash: targetHash, blockNumber: hex(targetN), transactionIndex: '0x0', gasPrice: '0x0', input: '0x' },
    receipt: { transactionHash: targetTx, transactionIndex: '0x0', blockHash: targetHash, blockNumber: hex(targetN), status: '0x1', gasUsed: '0x5208', effectiveGasPrice: '0x0', logs: [transfer] }, wallets: [wallet], observedAt: target.timestamp };
  const insertEvidence = (value: FreshCapturedReceipt, status: string) => client.query(`INSERT INTO recovery_fixture_evidence(tx_hash,block_hash,block_number,transaction_index,payload,expires_at,wallet_addresses,decoder_status,decoder_version)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [value.transaction.hash, value.transaction.blockHash, Number(BigInt(value.transaction.blockNumber)), Number(BigInt(value.transaction.transactionIndex)), encodeFreshEvidence(value), new Date(wall + 72 * 3600_000), value.wallets, status, FRESH_DECODER_VERSION]);
  await insertEvidence(sourceEntry, 'done'); await insertEvidence(entry, 'pending');
  // Token-specific source discovery must not lose the real saved observation
  // behind the old global latest-256 window. These rows contain no state or
  // wallet facts and live only in the transaction's temporary receipt table.
  const unrelatedN=sourceN+1,unrelatedHash=hash();
  await client.query('INSERT INTO recovery_fixture_blocks(block_number,block_hash,parent_hash,occurred_at) VALUES($1,$2,$3,$4)',[unrelatedN,unrelatedHash,sourceHash,iso(230)]);
  for(let index=0;index<300;index++){
    const unrelated=structuredClone(sourceEntry),tx=hash();delete unrelated.stateEvidence;unrelated.wallets=[];
    unrelated.transaction={...unrelated.transaction,hash:tx,blockHash:unrelatedHash,blockNumber:hex(unrelatedN),transactionIndex:hex(index)};
    unrelated.receipt={...unrelated.receipt,transactionHash:tx,blockHash:unrelatedHash,blockNumber:hex(unrelatedN),transactionIndex:hex(index)};
    await insertEvidence(unrelated,'done');
  }
  const encodedSync = abi.encodeEventLog(abi.getEvent('Sync')!, [1000n * 10n ** 9n, 2n * 10n ** 18n]);
  const sync: FreshLog = { address: pool, ...encodedSync, blockNumber: hex(syncN), blockHash: syncHash, transactionHash: hash(), transactionIndex: '0x0', logIndex: '0x1' };

  const query = async (sql: string, values?: unknown[]) => {
    if (sql === 'BEGIN') return client.query('SAVEPOINT recovery_decoder');
    if (sql === 'COMMIT') return client.query('RELEASE SAVEPOINT recovery_decoder');
    if (sql === 'ROLLBACK') return client.query('ROLLBACK TO SAVEPOINT recovery_decoder');
    for (const [original, temporary] of tables) sql = sql.replaceAll(original, temporary);
    return client.query(sql, values);
  };
  const fixtureDb = { query, connect: async () => ({ query, release() {} }) } as unknown as Pool;
  let oracleAvailable = false;
  let targetStateFailure:'transport'|'state_unavailable'='transport';
  const requests: { method: string; oracle: boolean; targetState: boolean }[] = [];
  const feed = TRUSTED_QUOTE_FEEDS[WBNB];
  const rpc: Rpc = async <T>(method: string, params: unknown[]): Promise<T> => {
    const call = params[0] as { to?: string; data?: string }, selected = params[1] as { blockHash?: string; requireCanonical?: boolean };
    const oracle = method === 'eth_call' && call.to === feed.feed, targetState = method === 'eth_call' && selected?.blockHash === targetHash;
    requests.push({ method, oracle, targetState });
    if (targetState) throw new RpcRequestError('historical_fixture_state_unavailable', targetStateFailure, targetStateFailure==='state_unavailable'?{code:-32000}:{});
    if (method === 'eth_getBlockByNumber') { assert.equal(params[0], hex(creationN)); assert.equal(params[1], true); return creationBlock as T; }
    if (method === 'eth_getTransactionReceipt') { assert.equal(params[0], creationTxHash); return creationReceipt as T; }
    if (method === 'eth_getCode') { assert.equal(params[0], FRESH_INITIALIZED_DECIMALS_AUDIT.implementationAddress); assert.deepEqual(selected, { blockHash: anchorHash, requireCanonical: true }); return implementationCode as T; }
    if (method === 'eth_chainId') return '0x38' as T;
    if (method === 'eth_getLogs') {
      const filter = params[0] as { address: string; fromBlock: string; toBlock: string; topics: string[] };
      assert.equal(filter.address, pool); assert.equal(filter.fromBlock, hex(sourceN + 1)); assert.equal(filter.toBlock, hex(targetN)); assert.deepEqual(filter.topics, [abi.getEvent('Sync')!.topicHash]);
      return [sync] as T;
    }
    assert.equal(method, 'eth_call', 'No arbitrary/provider calls permitted');
    assert.equal(oracle, true, 'No current token/pool metadata or price fallback permitted');
    assert.deepEqual(selected, { blockHash: anchorHash, requireCanonical: true });
    if (!oracleAvailable) throw new RpcRequestError('oracle_fixture_temporarily_unavailable', 'transport');
    const parsed = oracleAbi.parseTransaction({ data: call.data! })!;
    if (parsed.name === 'decimals') return oracleAbi.encodeFunctionResult('decimals', [8]) as T;
    if (parsed.name === 'description') return oracleAbi.encodeFunctionResult('description', [feed.description]) as T;
    const low = parsed.name === 'latestRoundData' ? 3n : BigInt(parsed.args[0]) & ((1n << 64n) - 1n);
    assert.ok(low >= 1n && low <= 3n);
    const roundId = (1n << 64n) | low, timestamp = BigInt(Date.parse(low === 1n ? iso(300) : low === 2n ? iso(130) : iso(110)) / 1000);
    const answer = (low === 1n ? 500n : low === 2n ? 600n : 800n) * 10n ** 8n;
    return oracleAbi.encodeFunctionResult(parsed.name, [roundId, answer, timestamp, timestamp, roundId]) as T;
  };
  const loadTarget = async (tx = targetTx) => (await client.query('SELECT * FROM recovery_fixture_evidence WHERE tx_hash=$1', [tx])).rows[0];

  const batch=createFreshRecoveryBatch(fixtureDb,rpc,{now:()=>wall});
  await client.query("UPDATE recovery_fixture_evidence SET decoder_status='repair' WHERE tx_hash=$1",[sourceTx]);
  const firstMetadata=createFreshReceiptRecovery(fixtureDb,rpc,entry,target,{batch});
  assert.equal((await firstMetadata.metadata(token))?.decimals,9);
  const firstMetadataReads=requests.filter(request=>['eth_getBlockByNumber','eth_getTransactionReceipt','eth_getCode','eth_chainId'].includes(request.method)).length;
  const crossTarget=createFreshReceiptRecovery(fixtureDb,rpc,entry,{number:syncN,hash:syncHash,timestamp:iso(150)},{batch});
  assert.equal((await crossTarget.metadata(token))?.decimals,9);
  assert.equal(requests.filter(request=>['eth_getBlockByNumber','eth_getTransactionReceipt','eth_getCode','eth_chainId'].includes(request.method)).length,firstMetadataReads,'Exact creation and implementation work is shared across canonical targets');
  assert.equal(batch.stats().scans,1);assert.ok(batch.stats().scannedRows>300);
  const proofOne=firstMetadata.snapshot()!.metadata[token] as {target:{number:number}},proofTwo=crossTarget.snapshot()!.metadata[token] as {target:{number:number}};
  assert.equal(proofOne.target.number,targetN);assert.equal(proofTwo.target.number,syncN,'Each receipt retains its own revalidated target proof');
  const corruptedPrior=structuredClone(entry);corruptedPrior.recoveryEvidence=structuredClone(firstMetadata.snapshot()!);
  (corruptedPrior.recoveryEvidence.metadata[token] as {decimals:number}).decimals=18;
  const priorChecked=createFreshReceiptRecovery(fixtureDb,rpc,corruptedPrior,target,{batch});
  assert.equal((await priorChecked.metadata(token))?.decimals,9,'Serialized mutable/corrupt proof cannot replace the original canonical raw read');
  assert.equal((priorChecked.snapshot()!.metadata[token] as {decimals:number}).decimals,9);
  const originalSourcePayload=(await client.query('SELECT payload FROM recovery_fixture_evidence WHERE tx_hash=$1',[sourceTx])).rows[0].payload as Buffer;
  const corruptPayload=Buffer.from(originalSourcePayload);corruptPayload[4]^=1;
  await client.query('UPDATE recovery_fixture_evidence SET payload=$2 WHERE tx_hash=$1',[sourceTx,corruptPayload]);
  assert.equal(await createFreshReceiptRecovery(fixtureDb,rpc,entry,target,{batch}).metadata(token),null,'Warm memo inputs cannot authorize a corrupt source');
  await client.query("UPDATE recovery_fixture_evidence SET payload=$2,decoder_status='done' WHERE tx_hash=$1",[sourceTx,originalSourcePayload]);
  await client.query('UPDATE recovery_fixture_blocks SET block_hash=$2 WHERE block_number=$1',[targetN,hash()]);
  assert.equal(await createFreshReceiptRecovery(fixtureDb,rpc,entry,target,{batch}).metadata(token),null,'Warm memo inputs cannot authorize an orphaned target');
  await client.query('UPDATE recovery_fixture_blocks SET block_hash=$2 WHERE block_number=$1',[targetN,targetHash]);

  // This untraded transfer's movement is fully decoded. A missing historical
  // market value remains a visible warning and null basis, not a coverage gap.
  await runFreshDecode(fixtureDb, rpc, { now, trace: async () => null });
  const first = await loadTarget(), partial = decodeFreshEvidence(first.payload);
  assert.equal(first.decoder_status, 'done'); assert.equal(first.last_error, 'incoming_transfer_cost_unknown');
  assert.deepEqual(partial.decodeDiagnostics?.valuationReasons,['incoming_transfer_cost_unknown']);
  assert.equal((await client.query("SELECT count(*)::int n FROM recovery_fixture_jobs WHERE kind='decode_receipt' AND reference=$1",[`${targetTx}:${targetHash}`])).rows[0].n,0);
  assert.equal((partial.recoveryEvidence!.metadata[token] as { kind: string }).kind, 'initialized_immutable_decimals');
  assert.deepEqual(partial.transaction, entry.transaction); assert.deepEqual(partial.receipt, entry.receipt);
  const originalEvent = (await client.query('SELECT * FROM fresh.financial_events WHERE transaction_hash=$1', [targetTx])).rows[0];
  assert.equal(originalEvent.quantity, '10'); assert.equal(originalEvent.amount_usd, null);
  const unknownBasis=(await client.query('SELECT unknown_cost,unknown_incoming_value FROM fresh.positions WHERE scope_id=$1 AND token_address=$2',[scope,token])).rows[0];
  assert.deepEqual(unknownBasis,{unknown_cost:true,unknown_incoming_value:true});
  targetStateFailure='state_unavailable';

  oracleAvailable = true;
  // Explicitly requeue only this fixture to exercise an optional later value
  // correction. Completed movement warnings do not leave automatic decode jobs.
  await client.query("UPDATE recovery_fixture_evidence SET decoder_status='pending' WHERE tx_hash=$1",[targetTx]);
  await runFreshDecode(fixtureDb, rpc, { now: new Date(wall + 90_000), trace: async () => null });
  const completed = await loadTarget(), retained = decodeFreshEvidence(completed.payload), proof = retained.recoveryEvidence!;
  assert.equal(completed.decoder_status, 'done'); assert.equal(completed.last_error, null);
  assert.equal(proof.pools.length, 1); assert.equal(proof.pools[0].priceQuote, '0.002'); assert.equal(proof.pools[0].lastSync!.blockHash, syncHash);
  assert.equal(proof.quotes.length, 1); assert.equal(proof.quotes[0].priceUsd, '600'); assert.equal(proof.quotes[0].selectedRound, String((1n << 64n) | 2n));
  const valued = (await client.query('SELECT * FROM fresh.financial_events WHERE transaction_hash=$1', [targetTx])).rows;
  assert.equal(valued.length, 1); assert.equal(valued[0].id, originalEvent.id); assert.equal(valued[0].quantity, '10'); assert.equal(valued[0].amount_usd, '12'); assert.equal(valued[0].fee_usd, '0');
  const position = (await client.query('SELECT quantity_q,unknown_cost FROM fresh.positions WHERE scope_id=$1 AND token_address=$2', [scope, token])).rows[0];
  assert.equal(position.quantity_q, '10'); assert.equal(position.unknown_cost, false);
  assert.deepEqual(retained.transaction, entry.transaction); assert.deepEqual(retained.receipt, entry.receipt);

  const beforeReplay = requests.length, replay = createFreshReceiptRecovery(fixtureDb, rpc, retained, target);
  assert.equal(await replay.priceUsd(token), '1.2');
  assert.equal(requests.slice(beforeReplay).filter(request => request.method === 'eth_getLogs' || request.oracle).length, 0, 'Saved proofs must revalidate without rescanning logs or oracle rounds');

  // Exercise the exception handler after immutable metadata was recovered.
  // An invalid operation trace must retain its metadata proof in the repair
  // receipt, without committing a partial financial interpretation.
  const throwing: FreshCapturedReceipt = structuredClone(entry);
  throwing.transaction = { ...throwing.transaction, hash: throwingTx, from: wallet, to: sender, transactionIndex: '0x1' };
  throwing.receipt = { ...throwing.receipt, transactionHash: throwingTx, transactionIndex: '0x1', logs: [
    { ...transfer, transactionHash: throwingTx, transactionIndex: '0x1' },
    { address: pool, topics: [[...swapTopics][0]], data: '0x', logIndex: '0x1', transactionHash: throwingTx, transactionIndex: '0x1', blockNumber: hex(targetN), blockHash: targetHash },
  ] };
  await insertEvidence(throwing, 'pending');
  const unsupported = await runFreshDecode(fixtureDb, rpc, { now: new Date(wall + 180_000), trace: async () => ({ type: 'CALL', from: sender, to: sender, value: '0x0' }) });
  assert.equal(unsupported.unsupported, 1);
  const failed = await loadTarget(throwingTx), failedEntry = decodeFreshEvidence(failed.payload);
  assert.equal(failed.decoder_status,'repair');assert.equal(failed.last_error, 'trace_transaction_mismatch'); assert.ok(failedEntry.recoveryEvidence?.metadata[token]);
  assert.equal((await client.query('SELECT count(*)::int count FROM fresh.financial_events WHERE transaction_hash=$1', [throwingTx])).rows[0].count, 0);

  // Actual trade and fee valuation failures retain repair coverage. They must
  // not inherit the completed untraded-transfer policy from the first fixture.
  oracleAvailable=false;
  const tradeGap=structuredClone(throwing),tradeGapTx=hash();
  tradeGap.transaction={...tradeGap.transaction,hash:tradeGapTx,transactionIndex:'0x2'};
  tradeGap.receipt={...tradeGap.receipt,transactionHash:tradeGapTx,transactionIndex:'0x2',logs:tradeGap.receipt.logs.map(log=>({...log,transactionHash:tradeGapTx,transactionIndex:'0x2'}))};
  await insertEvidence(tradeGap,'pending');
  await runFreshDecode(fixtureDb,rpc,{now:new Date(wall+180_000),trace:async()=>null});
  const tradeUnvalued=await loadTarget(tradeGapTx);
  assert.equal(tradeUnvalued.decoder_status,'repair');assert.match(tradeUnvalued.last_error,/trade_value_unavailable/);
  assert.equal((await client.query('SELECT amount_usd FROM fresh.financial_events WHERE transaction_hash=$1',[tradeGapTx])).rows[0].amount_usd,null);
  const feeGap=structuredClone(entry),feeGapTx=hash();
  feeGap.transaction={...feeGap.transaction,hash:feeGapTx,from:wallet,gasPrice:'0x3b9aca00',transactionIndex:'0x3'};
  feeGap.receipt={...feeGap.receipt,transactionHash:feeGapTx,effectiveGasPrice:'0x3b9aca00',transactionIndex:'0x3',logs:feeGap.receipt.logs.map(log=>({...log,transactionHash:feeGapTx,transactionIndex:'0x3'}))};
  await insertEvidence(feeGap,'pending');
  await runFreshDecode(fixtureDb,rpc,{now:new Date(wall+180_000),trace:async()=>null});
  const feeUnvalued=await loadTarget(feeGapTx);
  assert.equal(feeUnvalued.decoder_status,'repair');assert.match(feeUnvalued.last_error,/wallet_fee_valuation_unavailable/);
  assert.equal((await client.query('SELECT fee_usd FROM fresh.financial_events WHERE transaction_hash=$1',[feeGapTx])).rows[0].fee_usd,null);

  await client.query('UPDATE recovery_fixture_blocks SET block_hash=$2 WHERE block_number=$1', [syncN, hash()]);
  const orphanedPool = createFreshReceiptRecovery(fixtureDb, rpc, retained, target);
  assert.equal(await orphanedPool.priceUsd(token), null, 'Orphaned retained Sync proof must be rejected');
  await client.query('UPDATE recovery_fixture_blocks SET block_hash=$2 WHERE block_number=$1', [syncN, syncHash]);
  await client.query('UPDATE recovery_fixture_blocks SET block_hash=$2 WHERE block_number=$1', [sourceN, hash()]);
  const orphanedSource = createFreshReceiptRecovery(fixtureDb, rpc, retained, target);
  assert.equal(await orphanedSource.metadata(token), null); assert.equal(await orphanedSource.priceUsd(token), null, 'Current token row cannot replace an orphaned historical source');
  const metadataGap=structuredClone(entry),metadataGapTx=hash();
  metadataGap.transaction={...metadataGap.transaction,hash:metadataGapTx,transactionIndex:'0x4'};
  metadataGap.receipt={...metadataGap.receipt,transactionHash:metadataGapTx,transactionIndex:'0x4',logs:metadataGap.receipt.logs.map(log=>({...log,transactionHash:metadataGapTx,transactionIndex:'0x4'}))};
  await insertEvidence(metadataGap,'pending');
  await runFreshDecode(fixtureDb,rpc,{now:new Date(wall+185_000),trace:async()=>null});
  const precisionUnverified=await loadTarget(metadataGapTx);
  assert.equal(precisionUnverified.decoder_status,'repair');assert.match(precisionUnverified.last_error,/token_decimals_unavailable/);
  assert.equal((await client.query('SELECT count(*)::int n FROM fresh.financial_events WHERE transaction_hash=$1',[metadataGapTx])).rows[0].n,0);

  console.log(JSON.stringify({ ok: true, checks: ['real_pg_unavailable_state_decoder_path', 'untraded_movement_done_with_null_basis_warning', 'explicit_optional_value_correction', 'trade_fee_precision_and_trace_failures_remain_repair', 'partial_repair_proof_persisted', 'exception_path_proof_persisted', 'exact_historical_pool_times_oracle_usd',
    'same_financial_identity_after_repair', 'original_receipt_unchanged', 'retained_proof_replay_without_network_history', 'source_and_sync_reorg_rejection', 'no_current_token_row_fallback',
    'metadata_source_older_than_300_unrelated_receipts', 'cross_target_shared_creation_work_with_independent_proofs', 'transport_failure_with_independent_canonical_metadata_proof'],
    exactUsd: '12', fixtureWrites: 'rolled back', externalNetworkCalls: 0 }));
} finally { await client.query('ROLLBACK'); client.release(); await db.end(); }
