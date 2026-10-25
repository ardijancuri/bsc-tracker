/** Decoder correction SQL fixtures. Every write rolls back; no node writes. */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { Interface } from 'ethers';
import { Pool } from 'pg';
import { ensureFreshSchema } from './schema.js';
import { FRESH_DECODER_VERSION, normalizeFreshReceipt, persistFreshDecodedReceipt, selectFreshDecodeEvidence, queueFreshDecodeRepair, finishFreshDecodedReceipt, canCompleteFreshUntradedTransfers, assertFreshDecodeEvidenceUnchanged,runFreshDecode, type FreshDecodeServices } from './decode.js';
import { FreshRational } from './accounting.js';
import { WBNB } from '../launchpad.js';
import {decodeFreshEvidence,encodeFreshEvidence,type FreshCapturedReceipt} from './capture.js';
import {createFreshStateEvidenceRpc} from './stateEvidence.js';
import {createFreshReads} from './reads.js';
import {transferTopic} from '../swap.js';
import type {Rpc} from '../rpc.js';
const url = new URL(process.env.DATABASE_URL ?? '');
if (!['127.0.0.1', 'localhost'].includes(url.hostname) || !url.pathname.includes('fresh')) throw new Error('Use an isolated local fresh database');
const db = new Pool({ connectionString: url.toString(), max: 2 }), client = await db.connect();
const address = () => `0x${randomBytes(20).toString('hex')}`, hash = () => `0x${randomBytes(32).toString('hex')}`;
const wallet = address(), token = address(), to = address(), txHash = hash(), blockHash = hash(), now = new Date(), occurredAt = new Date(Math.floor(now.getTime() / 1000) * 1000).toISOString();
const erc20 = new Interface(['function approve(address spender,uint256 amount)']);
try {
  await ensureFreshSchema(db); await client.query('BEGIN');
  const number = Number((await client.query("SELECT block_number FROM fresh.checkpoints WHERE key='capture'")).rows[0].block_number) + 100;
  const scope = `kol:${wallet}`, block = { number: `0x${number.toString(16)}`, hash: blockHash, timestamp: `0x${Math.floor(Date.parse(occurredAt) / 1000).toString(16)}` };
  await client.query('INSERT INTO fresh.wallets(address,monitoring_from_block) VALUES($1,$2)', [wallet, number]);
  await client.query('INSERT INTO fresh.kols(wallet_address) VALUES($1)', [wallet]);
  await client.query("INSERT INTO fresh.accounting_scopes(id,kind,wallet_addresses,starts_at,starts_block) VALUES($1,'kol',$2,$3,$4)", [scope, [wallet], occurredAt, number]);
  const entry: FreshCapturedReceipt = { transaction: { hash: txHash, from: wallet, to: token, value: '0x0', blockHash, blockNumber: block.number, transactionIndex: '0x0', gasPrice: '0x3b9aca00', input: erc20.encodeFunctionData('approve', [to, 10n]) },
    receipt: { transactionHash: txHash, transactionIndex: '0x0', blockHash, blockNumber: block.number, status: '0x0', gasUsed: '0x186a0', effectiveGasPrice: '0x3b9aca00', logs: [] }, wallets: [wallet], observedAt: occurredAt };
  const services: FreshDecodeServices = { async metadata(address) { return { address, name: 'Fresh Token', symbol: 'FRESH', decimals: 18, supplyRaw: '1000000000000000000000000', block: { number, hash: blockHash, timestamp: occurredAt } }; }, async eligible(value) { return value.address === token; }, async knownLaunch() { return true; }, async priceUsd(address) { return address === WBNB ? '600' : '1'; } };
  const unallocated = await normalizeFreshReceipt(entry, block, { ...services, async metadata() { return null; } });
  await persistFreshDecodedReceipt(client, unallocated, now);
  assert.equal((await client.query('SELECT count(*)::int n FROM fresh.scope_event_results WHERE scope_id=$1', [scope])).rows[0].n, 0);
  assert.equal((await client.query('SELECT count(*)::int n FROM fresh.positions WHERE scope_id=$1', [scope])).rows[0].n, 0);
  const resolved = await normalizeFreshReceipt(entry, block, services); assert.equal(resolved.events[0].id, unallocated.events[0].id);
  await persistFreshDecodedReceipt(client, resolved, now);
  const temporaryGap = structuredClone(resolved); temporaryGap.events[0].feeUsd = null; temporaryGap.reasons = ['wallet_fee_valuation_unavailable'];
  await persistFreshDecodedReceipt(client, temporaryGap, now);
  assert.equal(temporaryGap.events[0].feeUsd, '0.06'); assert.deepEqual(temporaryGap.reasons, []);
  const retainedFee = (await client.query('SELECT fee_usd,decoder_version FROM fresh.financial_events WHERE id=$1', [resolved.events[0].id])).rows[0];
  assert.equal(retainedFee.fee_usd, '0.06'); assert.equal(retainedFee.decoder_version, FRESH_DECODER_VERSION);
  const retained = (await client.query('SELECT id,token_address,fee_attribution FROM fresh.financial_events WHERE id=$1', [resolved.events[0].id])).rows[0];
  assert.equal(retained.token_address, token); assert.equal(retained.fee_attribution.status, 'eligible'); assert.equal(retained.fee_attribution.nativeFeeWei, '100000000000000');
  const position = (await client.query('SELECT quantity_q,fees_q,realized_q FROM fresh.positions WHERE scope_id=$1 AND token_address=$2', [scope, token])).rows[0];
  assert.equal(position.quantity_q, '0'); assert.equal(FreshRational.fromStored(position.fees_q).decimal(), '0.06'); assert.equal(FreshRational.fromStored(position.realized_q).decimal(), '-0.06');
  await persistFreshDecodedReceipt(client, resolved, now);
  assert.equal((await client.query('SELECT count(*)::int n FROM fresh.financial_events WHERE transaction_hash=$1', [txHash])).rows[0].n, 1);
  assert.equal((await client.query('SELECT count(*)::int n FROM fresh.scope_event_results WHERE scope_id=$1', [scope])).rows[0].n, 1);
  const kol = (await client.query('SELECT today_realized_q,today_trade_count,today_token_count FROM fresh.kols WHERE wallet_address=$1', [wallet])).rows[0];
  assert.equal(FreshRational.fromStored(kol.today_realized_q).decimal(), '-0.06'); assert.equal(kol.today_trade_count, 0); assert.equal(kol.today_token_count, 0);
  const excluded = await normalizeFreshReceipt(entry, block, { ...services, async knownLaunch() { return false; } });
  assert.equal(excluded.events[0].id, resolved.events[0].id); await persistFreshDecodedReceipt(client, excluded, now);
  assert.equal((await client.query('SELECT token_address FROM fresh.financial_events WHERE id=$1', [resolved.events[0].id])).rows[0].token_address, null);
  assert.equal((await client.query('SELECT count(*)::int n FROM fresh.positions WHERE scope_id=$1', [scope])).rows[0].n, 0);
  assert.equal((await client.query('SELECT count(*)::int n FROM fresh.scope_event_results WHERE scope_id=$1', [scope])).rows[0].n, 0);
  assert.equal((await client.query('SELECT count(*)::int n FROM fresh.financial_events WHERE transaction_hash=$1', [txHash])).rows[0].n, 1);
  // Exercise the real selector against session-temporary relation copies, so
  // current live trial work cannot influence priority/limit assertions.
  await client.query('CREATE TEMP TABLE fresh_decode_test_evidence(LIKE fresh.recent_evidence INCLUDING DEFAULTS) ON COMMIT DROP');
  await client.query('CREATE TEMP TABLE fresh_decode_test_blocks(LIKE fresh.recent_blocks INCLUDING DEFAULTS) ON COMMIT DROP');
  await client.query('CREATE TEMP TABLE fresh_decode_test_jobs(LIKE fresh.jobs INCLUDING DEFAULTS) ON COMMIT DROP');
  const ids: string[] = [];
  for (const [index, status, version] of [[1, 'pending', FRESH_DECODER_VERSION], [2, 'repair', 1], [3, 'done', 1], [4, 'done', FRESH_DECODER_VERSION], [5, 'repair', 1]] as const) {
    const blockHash = hash(), tx = hash(); ids.push(tx);
    await client.query('INSERT INTO fresh_decode_test_blocks(block_number,block_hash,parent_hash,occurred_at) VALUES($1,$2,$3,$4)', [index, blockHash, hash(), now]);
    await client.query('INSERT INTO fresh_decode_test_evidence(tx_hash,block_hash,block_number,transaction_index,payload,expires_at,decoder_status,decoder_version) VALUES($1,$2,$3,0,$4,$5,$6,$7)', [tx, blockHash, index, Buffer.from('selector-only'), new Date(now.getTime() + 72 * 3600_000), status, version]);
    if (status === 'repair') await client.query("INSERT INTO fresh_decode_test_jobs(id,kind,reference,due_at) VALUES($1,'decode_receipt',$2,$3)", [`decode:${tx}`, `${tx}:${blockHash}`, new Date(now.getTime() + (index === 5 ? 60_000 : -1000))]);
  }
  const selectionDb = { query: (sql: string, values?: unknown[]) => client.query(sql.replaceAll('fresh.recent_evidence', 'fresh_decode_test_evidence').replaceAll('fresh.recent_blocks', 'fresh_decode_test_blocks').replaceAll('fresh.jobs', 'fresh_decode_test_jobs'), values) } as unknown as Pick<Pool, 'query'>;
  assert.deepEqual((await selectFreshDecodeEvidence(selectionDb, now, 2)).rows.map(row => row.tx_hash), ids.slice(0, 2));
  assert.deepEqual((await selectFreshDecodeEvidence(selectionDb, now, 64)).rows.map(row => row.tx_hash), ids.slice(0, 3));
  await client.query('ALTER TABLE fresh_decode_test_jobs ADD UNIQUE(kind,reference)');
  const diagnosticRow={tx_hash:hash(),block_hash:hash()},diagnostic='token_metadata_decimals_transport';
  await queueFreshDecodeRepair(selectionDb,diagnosticRow,now,[diagnostic]);
  await queueFreshDecodeRepair(selectionDb,diagnosticRow,new Date(now.getTime()+10_000),['token_metadata_decimals_state_unavailable_code_-32000']);
  const retry=(await client.query('SELECT progress,last_error,attempts FROM fresh_decode_test_jobs WHERE reference=$1',[`${diagnosticRow.tx_hash}:${diagnosticRow.block_hash}`])).rows[0];
  assert.deepEqual(retry.progress.firstFailure,{version:1,at:now.toISOString(),reasons:[diagnostic]});
  assert.equal(retry.last_error,'token_metadata_decimals_state_unavailable_code_-32000');assert.equal(retry.attempts,1);
  const legacyRow={tx_hash:hash(),block_hash:hash()};
  await client.query("INSERT INTO fresh_decode_test_jobs(id,kind,reference) VALUES($1,'decode_receipt',$2)",['legacy-unknown',`${legacyRow.tx_hash}:${legacyRow.block_hash}`]);
  await queueFreshDecodeRepair(selectionDb,legacyRow,now,['token_metadata_decimals_state_unavailable_code_-32000']);
  assert.deepEqual((await client.query('SELECT progress FROM fresh_decode_test_jobs WHERE id=$1',['legacy-unknown'])).rows[0].progress,{});
  // A genuine untraded distribution has complete movement coverage even when
  // no market existed. Keep its original warning and null-cost inventory; an
  // unrelated known-cost book must remain usable after movement completion.
  const drop=address(),dropHash=hash(),dropTx=hash(),dropAt=new Date(now.getTime()+1000).toISOString(),dropNumber=number+1;
  const known=structuredClone(resolved),knownEvent=known.events[0];
  Object.assign(knownEvent,{id:hash().slice(2),executionKey:hash(),kind:'buy',quantity:'10',amountUsd:'100',feeUsd:'0',feeKey:hash(),transactionHash:hash()});
  await persistFreshDecodedReceipt(client,known,now);
  const rawDrop:FreshCapturedReceipt={transaction:{...entry.transaction,hash:dropTx,from:to,to:drop,blockNumber:`0x${dropNumber.toString(16)}`,blockHash:dropHash,input:'0x'},
    receipt:{...entry.receipt,transactionHash:dropTx,blockNumber:`0x${dropNumber.toString(16)}`,blockHash:dropHash,status:'0x1',logs:[{
      address:drop,topics:[transferTopic,`0x${to.slice(2).padStart(64,'0')}`,`0x${wallet.slice(2).padStart(64,'0')}`],data:`0x${(5n*10n**18n).toString(16).padStart(64,'0')}`,
      logIndex:'0x0',transactionHash:dropTx,transactionIndex:'0x0',blockNumber:`0x${dropNumber.toString(16)}`,blockHash:dropHash}]},wallets:[wallet],observedAt:dropAt};
  const dropServices:FreshDecodeServices={...services,async metadata(address){return{address,name:'Untraded distribution',symbol:'DROP',decimals:18,supplyRaw:null,block:{number:dropNumber,hash:dropHash,timestamp:dropAt}};},async eligible(value){return value.address===drop;},async priceUsd(){return null;}};
  const unvalued=await normalizeFreshReceipt(rawDrop,{number:`0x${dropNumber.toString(16)}`,hash:dropHash,timestamp:`0x${Math.floor(Date.parse(dropAt)/1000).toString(16)}`},dropServices);
  // Block timestamps are second-granularity, matching the metadata target.
  const dropTime=unvalued.events[0].occurredAt;unvalued.tokens[0].block.timestamp=dropTime;
  await persistFreshDecodedReceipt(client,unvalued,now);
  await client.query('INSERT INTO fresh_decode_test_blocks(block_number,block_hash,parent_hash,occurred_at) VALUES($1,$2,$3,$4)',[dropNumber,dropHash,blockHash,dropTime]);
  await client.query(`INSERT INTO fresh_decode_test_evidence(tx_hash,block_hash,block_number,transaction_index,payload,expires_at,decoder_status,wallet_addresses)
    VALUES($1,$2,$3,0,$4,$5,'repair',$6)`,[dropTx,dropHash,dropNumber,encodeFreshEvidence(rawDrop),new Date(now.getTime()+72*3600_000),[wallet]]);
  const dropRow={tx_hash:dropTx,block_hash:dropHash};
  await queueFreshDecodeRepair(selectionDb,dropRow,now,unvalued.reasons);
  const originalFirst=(await client.query('SELECT progress FROM fresh_decode_test_jobs WHERE reference=$1',[`${dropTx}:${dropHash}`])).rows[0].progress.firstFailure;
  const completed=await finishFreshDecodedReceipt(selectionDb,{row:dropRow,entry:rawDrop,decoded:unvalued,
    state:createFreshStateEvidenceRpc((async()=>{throw Error('no_node_reads');}) as Rpc,{number:dropNumber,hash:dropHash}),now});
  assert.deepEqual(completed,{waiting:false,valuationOnly:true});
  const savedDrop=(await client.query('SELECT * FROM fresh_decode_test_evidence WHERE tx_hash=$1',[dropTx])).rows[0],savedPayload=decodeFreshEvidence(savedDrop.payload);
  assert.equal(savedDrop.decoder_status,'done');assert.equal(savedDrop.last_error,'incoming_transfer_cost_unknown');
  assert.deepEqual(savedPayload.transaction,rawDrop.transaction);assert.deepEqual(savedPayload.receipt,rawDrop.receipt);
  assert.deepEqual(savedPayload.decodeDiagnostics?.firstFailure,originalFirst);
  assert.deepEqual(savedPayload.decodeDiagnostics?.valuationReasons,['incoming_transfer_cost_unknown']);
  assert.equal((await client.query('SELECT count(*)::int n FROM fresh_decode_test_jobs WHERE reference=$1',[`${dropTx}:${dropHash}`])).rows[0].n,0);
  const unknown=(await client.query('SELECT unknown_cost,unknown_incoming_value,quantity_q FROM fresh.positions WHERE scope_id=$1 AND token_address=$2',[scope,drop])).rows[0];
  assert.deepEqual(unknown,{unknown_cost:true,unknown_incoming_value:true,quantity_q:'5'});
  assert.equal((await client.query('SELECT cost_q FROM fresh.open_lots WHERE scope_id=$1 AND token_address=$2',[scope,drop])).rows[0].cost_q,null);
  assert.equal((await client.query('SELECT amount_usd FROM fresh.financial_events WHERE id=$1',[unvalued.events[0].id])).rows[0].amount_usd,null);
  await client.query('CREATE TEMP TABLE fresh_decode_test_checkpoints(LIKE fresh.checkpoints INCLUDING DEFAULTS) ON COMMIT DROP');
  await client.query(`INSERT INTO fresh_decode_test_checkpoints(key,block_number,block_hash,updated_at,value) VALUES('capture',$1,$2,$3,'{}'),('decode',$1,$2,$3,'{}')`,[dropNumber,dropHash,dropTime]);
  await client.query(`UPDATE fresh.positions SET balance_status='matched',balance_quantity=quantity_q,balance_block=$2,balance_hash=$3,balance_checked_at=$4 WHERE scope_id=$1`,[scope,dropNumber,dropHash,dropTime]);
  await client.query(`UPDATE fresh.tokens SET price_usd='2',observed_at=$2,observed_block=$3,observed_hash=$4,valuation_status='ready' WHERE address=$1`,[token,dropTime,dropNumber,dropHash]);
  const readDb={query:(sql:string,values?:unknown[])=>selectionDb.query(sql.replaceAll('fresh.checkpoints','fresh_decode_test_checkpoints'),values)} as unknown as Pool;
  const summaries=await createFreshReads(readDb,()=>Date.parse(dropTime),true).summaries(wallet,[token,drop]);
  assert.equal(summaries[token].status,'ready');assert.equal(summaries[drop].status,'unavailable');assert.equal(summaries[drop].reason,'unknown_costs');
  const sold=structuredClone(unvalued),sale=sold.events[0];
  Object.assign(sale,{id:hash().slice(2),executionKey:hash(),kind:'sell',amountUsd:'10',feeKey:hash(),transferKey:null,counterparty:null,blockNumber:String(dropNumber+1),transactionHash:hash(),occurredAt:new Date(Date.parse(dropTime)+1000).toISOString()});
  sold.reasons=[];await persistFreshDecodedReceipt(client,sold,now);
  const soldPosition=(await client.query('SELECT quantity_q,unknown_cost,realized_q FROM fresh.positions WHERE scope_id=$1 AND token_address=$2',[scope,drop])).rows[0];
  assert.deepEqual(soldPosition,{quantity_q:'0',unknown_cost:true,realized_q:null});
  assert.equal(await canCompleteFreshUntradedTransfers(selectionDb,unvalued),false);
  assert.equal((await client.query('SELECT decoder_status FROM fresh_decode_test_evidence WHERE tx_hash=$1',[dropTx])).rows[0].decoder_status,'done');
  // A receipt repaired while RPC work was outside the transaction must not be
  // replaced by that earlier normalized payload on the next locked commit.
  const stalePayload=Buffer.from(savedDrop.payload),newPayload=encodeFreshEvidence({...savedPayload,observedAt:'2026-10-23T03:00:00.000Z'});
  await client.query('UPDATE fresh_decode_test_evidence SET payload=$2 WHERE tx_hash=$1',[dropTx,newPayload]);
  const changedEvidence=(await client.query('SELECT wallet_addresses,payload FROM fresh_decode_test_evidence WHERE tx_hash=$1 FOR UPDATE',[dropTx])).rows[0];
  assert.throws(()=>assertFreshDecodeEvidenceUnchanged(changedEvidence,{payload:stalePayload},[wallet]),/decode_evidence_changed/);
  assertFreshDecodeEvidenceUnchanged(changedEvidence,{payload:Buffer.from(newPayload)},[wallet]);
  assert.deepEqual(decodeFreshEvidence(changedEvidence.payload).decodeDiagnostics?.firstFailure,originalFirst);
  // Reproduce the actual urgent/raw-state race while the real normalizer is
  // outside its financial transaction. Additive state must merge at the lock,
  // commit the ordered financial fact once, and remain usable after pruning.
  const raceTx=hash(),raceHash=hash(),raceNumber=number+2,raceHex=`0x${raceNumber.toString(16)}`,extra=address();
  const metadataAbi=new Interface(['function decimals() view returns(uint8)','function totalSupply() view returns(uint256)','function name() view returns(string)','function symbol() view returns(string)']);
  const raceEntry:FreshCapturedReceipt={...structuredClone(entry),transaction:{...entry.transaction,hash:raceTx,blockNumber:raceHex,blockHash:raceHash,gasPrice:'0x0'},
    receipt:{...entry.receipt,transactionHash:raceTx,blockNumber:raceHex,blockHash:raceHash,effectiveGasPrice:'0x0'},
    decodeDiagnostics:{version:1,valuationReasons:[],firstFailure:{version:1,at:occurredAt,reasons:['token_decimals_unavailable']}}};
  await client.query('INSERT INTO fresh.recent_blocks(block_number,block_hash,parent_hash,occurred_at) VALUES($1,$2,$3,$4)',[raceNumber,raceHash,blockHash,occurredAt]);
  await client.query("INSERT INTO fresh.launch_facts(token_address,protocol,block_number,block_hash,tx_hash,launched_at,proof,status) VALUES($1,'fourmeme',$2,$3,$4,$5,'{}','eligible') ON CONFLICT(token_address) DO NOTHING",[token,raceNumber-1,hash(),hash(),occurredAt]);
  await client.query('INSERT INTO fresh.recent_evidence(tx_hash,block_hash,block_number,transaction_index,payload,expires_at,wallet_addresses) VALUES($1,$2,$3,0,$4,$5,$6)',[raceTx,raceHash,raceNumber,encodeFreshEvidence(raceEntry),new Date(now.getTime()+72*3600_000),[wallet]]);
  const raceQuery=async(sql:string,params?:unknown[])=>{
    if(sql==='BEGIN')return client.query('SAVEPOINT decode_urgent_race');
    if(sql==='COMMIT')return client.query('RELEASE SAVEPOINT decode_urgent_race');
    if(sql==='ROLLBACK')return client.query('ROLLBACK TO SAVEPOINT decode_urgent_race');
    if(sql.startsWith('SELECT e.*,b.parent_hash,b.occurred_at'))return client.query('SELECT e.*,b.occurred_at FROM fresh.recent_evidence e JOIN fresh.recent_blocks b USING(block_number,block_hash) WHERE e.tx_hash=$1',[raceTx]);
    return client.query(sql,params);
  };
  const raceDb={query:raceQuery,connect:async()=>({query:raceQuery,release(){}})}as unknown as Pool;
  let injected=false;
  const raceRpc:Rpc=async<T>(method:string,params:unknown[]):Promise<T>=>{
    assert.equal(method,'eth_call');assert.deepEqual(params[1],{blockHash:raceHash,requireCanonical:true});
    const call=params[0]as{to:string;data:string};assert.equal(call.to,token);
    if(!injected){injected=true;await client.query('UPDATE fresh.recent_evidence SET payload=$2 WHERE tx_hash=$1',[raceTx,encodeFreshEvidence({...raceEntry,stateEvidence:{version:1,blockNumber:raceNumber,blockHash:raceHash,calls:[{to:extra,data:metadataAbi.encodeFunctionData('decimals'),result:metadataAbi.encodeFunctionResult('decimals',[6])}]}})]);}
    for(const name of ['decimals','totalSupply','name','symbol']as const)if(call.data===metadataAbi.encodeFunctionData(name))return metadataAbi.encodeFunctionResult(name,[name==='decimals'?18:name==='totalSupply'?10n**24n:name==='name'?'Race-proof token':'RACE'])as T;
    throw Error('unexpected_race_fixture_rpc');
  };
  const raceResult=await runFreshDecode(raceDb,raceRpc,{now});assert.equal(raceResult.evidenceMerges,1);assert.equal(raceResult.events,1);assert.equal(raceResult.repair,0);
  const raceRow=(await client.query('SELECT * FROM fresh.recent_evidence WHERE tx_hash=$1',[raceTx])).rows[0],raceSaved=decodeFreshEvidence(raceRow.payload);
  assert.equal(raceRow.decoder_status,'done');assert.equal(raceSaved.stateEvidence!.calls.length,5);assert.deepEqual(raceSaved.decodeDiagnostics?.firstFailure,raceEntry.decodeDiagnostics?.firstFailure);
  assert.deepEqual(raceSaved.receipt,raceEntry.receipt);assert.deepEqual(raceSaved.transaction,raceEntry.transaction);
  const noRpc:Rpc=async()=>{throw Error('all_state_now_pruned');};
  assert.equal((await runFreshDecode(raceDb,noRpc,{now})).events,1);
  assert.equal((await client.query('SELECT count(*)::int n FROM fresh.financial_events WHERE transaction_hash=$1',[raceTx])).rows[0].n,1);
  console.log(JSON.stringify({ok:true,checks:['concurrent_urgent_state_addition_commits_without_decoder_starvation','all_exact_raw_reads_and_first_failure_preserved','ordered_financial_event_applied_once','same_receipt_decodes_after_node_state_pruned'],fixtureWrites:'rolled back'}));
  console.log(JSON.stringify({ok:true,checks:['stale_decode_cannot_overwrite_concurrent_receipt_proof','same_reviewed_payload_can_resume','first_failure_not_lost'],fixtureWrites:'rolled back'}));
  console.log(JSON.stringify({ok:true,checks:['untraded_null_cost_movement_complete','original_receipt_and_first_diagnostic_preserved','valuation_warning_remains_visible','only_completed_decode_job_removed','unrelated_book_ready','later_sell_unknown_profit_retained'],fixtureWrites:'rolled back'}));
  console.log(JSON.stringify({ok:true,checks:['first_metadata_diagnostic_preserved','legacy_unknown_first_cause_not_invented'],fixtureWrites:'rolled back'}));
  console.log(JSON.stringify({ ok: true, checks: ['failed_gas_fact_retained', 'unattributed_fee_not_applied', 'attribution_repair_preserves_event_identity', 'token_address_correction_persisted', 'zero_holdings_fee_position', 'single_application_after_retry', 'profile_token_fee_consistency', 'transient_null_does_not_erase_verified_fee', 'actual_financial_decoder_version', 'bounded_done_receipt_upgrade', 'pending_and_due_repairs_before_upgrade', 'invalidated_attribution_rebuild', 'no_fake_trade_counters'], fixtureWrites: 'rolled back' }));
} finally { await client.query('ROLLBACK'); client.release(); await db.end(); }
