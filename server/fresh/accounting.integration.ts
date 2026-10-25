/** Transaction-rolled-back fixtures only; refuses remote or legacy application databases. */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import { ensureFreshSchema } from './schema.js';
import { applyFreshFinancialEvents, freshDecimal, freshPositionFromRow, rebuildFreshScopesAfterReorg, rolloverFreshUtcDay } from './accounting.js';
import type { FreshFinancialEvent } from '../../shared/freshAccounting.js';
const url = new URL(process.env.DATABASE_URL ?? '');
if (!['127.0.0.1','localhost'].includes(url.hostname) || !/fresh/.test(url.pathname)) throw new Error('Use an isolated local fresh database');
const db = new Pool({connectionString:url.toString(),max:2});
const wallet=`0x${randomBytes(20).toString('hex')}`, other=`0x${randomBytes(20).toString('hex')}`, token=`0x${randomBytes(20).toString('hex')}`;
const scope=`kol:${wallet}`, privateScope=`portfolio:${wallet}`, combined=`combined:${wallet}`;
const now='2026-10-22T01:00:00Z';let seq=0;
function event(overrides:Partial<FreshFinancialEvent>={}):FreshFinancialEvent {
  const n=++seq;return {id:`${wallet}:event:${n}`,executionKey:`${wallet}:execution:${n}`,walletAddress:wallet,tokenAddress:token,kind:'buy',quantity:'10',amountUsd:'100',feeUsd:'1',feeKey:`${wallet}:fee:${n}`,
    counterparty:null,transferKey:null,blockNumber:`${100+n}`,blockHash:`0x${n.toString(16).padStart(64,'0')}`,transactionHash:`0x${n.toString(16).padStart(64,'0')}`,transactionIndex:0,executionIndex:0,logIndex:0,occurredAt:'2026-10-22T00:01:00Z',...overrides};
}
const client=await db.connect();
try {
  await ensureFreshSchema(db);await client.query('BEGIN');
  await client.query('INSERT INTO fresh.wallets(address,monitoring_from_block) VALUES($1,100),($2,100)',[wallet,other]);
  await client.query('INSERT INTO fresh.kols(wallet_address,display_name,today_utc) VALUES($1,$2,$3)',[wallet,'Isolated accounting test','2026-10-21']);
  await client.query('INSERT INTO fresh.tokens(address,name,launch_status) VALUES($1,$2,$3)',[token,'Accounting test','eligible']);
  await client.query(`INSERT INTO fresh.accounting_scopes(id,kind,wallet_addresses,starts_at,starts_block) VALUES($1,'kol',$2,'2026-10-21T00:00:00Z',100),($3,'portfolio_wallet',$2,'2026-10-21T00:00:00Z',100),($4,'portfolio_combined',$5,'2026-10-21T00:00:00Z',100)`,[scope,[wallet],privateScope,combined,[wallet,other]]);
  const bought=event({occurredAt:'2026-10-21T23:59:59Z'}),sold=event({kind:'sell',quantity:'5',amountUsd:'80',feeUsd:'2'});
  const first=await applyFreshFinancialEvents(client,[bought,sold],{now});assert.equal(first.applied,6);
  const repeat=await applyFreshFinancialEvents(client,[bought,sold],{now});assert.deepEqual(repeat,{inserted:0,applied:0});
  const kol=(await client.query('SELECT *,today_utc::text AS utc_day FROM fresh.kols WHERE wallet_address=$1',[wallet])).rows[0];
  assert.equal(kol.utc_day,'2026-10-22');assert.equal(freshDecimal(kol.today_realized_q),'27.5');
  assert.ok(Number.isFinite(new Date(kol.metrics_updated_at).getTime()),'Stored daily metrics retain their actual write timestamp');
  assert.equal(kol.today_trade_count,1);assert.equal(kol.today_sell_count,1);assert.equal(kol.today_token_count,1);
  const position=freshPositionFromRow((await client.query('SELECT * FROM fresh.positions WHERE scope_id=$1',[scope])).rows[0]);assert.equal(freshDecimal(position.realizedQ),'27.5');
  const counted=(await client.query('SELECT * FROM fresh.tokens WHERE address=$1',[token])).rows[0];assert.equal(`${counted.tracked_trade_count}`,'2');assert.equal(freshDecimal(counted.tracked_volume_q),'180');
  // Two distinct smart-account operations in one receipt remain separate executions.
  const tx=`0x${'f'.repeat(64)}`,block=`0x${'e'.repeat(64)}`;
  const op1=event({blockNumber:'103',blockHash:block,transactionHash:tx,executionIndex:1,quantity:'1',amountUsd:'2',feeUsd:'0',feeKey:null});
  const op2=event({blockNumber:'103',blockHash:block,transactionHash:tx,executionIndex:2,quantity:'1',amountUsd:'3',feeUsd:'0',feeKey:null});
  await applyFreshFinancialEvents(client,[op1,op2],{now});
  assert.equal((await client.query('SELECT count(*)::int n FROM fresh.financial_events WHERE wallet_address=$1 AND transaction_hash=$2',[wallet,tx])).rows[0].n,2);
  // Legacy authenticated tokenless gas remains a distinct scope-only charge.
  const fee=event({kind:'fee',tokenAddress:null,quantity:'0',amountUsd:null,feeUsd:'0.5',feeAttribution:{status:'eligible',nativeFeeWei:'500000000000000'}});await applyFreshFinancialEvents(client,[fee],{now});
  assert.equal(freshDecimal((await client.query('SELECT fee_only_realized_q FROM fresh.accounting_scopes WHERE id=$1',[privateScope])).rows[0].fee_only_realized_q),'-0.5');
  const unallocated=event({kind:'fee',tokenAddress:null,quantity:'0',amountUsd:null,feeUsd:'3',feeAttribution:{status:'unattributed',contract:other,selector:'0x12345678',nativeFeeWei:'1234567890123456789'}}),excluded=event({kind:'fee',tokenAddress:null,quantity:'0',amountUsd:null,feeUsd:null,feeAttribution:{status:'excluded',tokenAddress:token,nativeFeeWei:'999999999999999999'}});
  assert.deepEqual(await applyFreshFinancialEvents(client,[unallocated,excluded],{now}),{inserted:2,applied:0});
  assert.equal((await client.query('SELECT count(*)::int n FROM fresh.scope_event_results WHERE event_id=ANY($1::text[])',[[unallocated.id,excluded.id]])).rows[0].n,0);
  const excludedKol=(await client.query('SELECT * FROM fresh.kols WHERE wallet_address=$1',[wallet])).rows[0];assert.equal(freshDecimal(excludedKol.today_realized_q),'27');assert.equal(excludedKol.today_unknown_count,0);assert.equal(excludedKol.today_unallocated_fee_count,2);assert.equal(freshDecimal(excludedKol.today_unallocated_fee_q),'3');assert.equal(excludedKol.today_unallocated_fee_unknown_count,1);assert.equal(excludedKol.today_unattributed_fee_count,1);
  const privateExclusions=(await client.query('SELECT * FROM fresh.accounting_scopes WHERE id=$1',[privateScope])).rows[0];assert.equal(privateExclusions.fee_only_unknown_count,'0');assert.equal(privateExclusions.unallocated_fee_count,'2');assert.equal(freshDecimal(privateExclusions.unallocated_fee_q),'3');
  assert.equal((await client.query('SELECT fee_attribution FROM fresh.financial_events WHERE id=$1',[unallocated.id])).rows[0].fee_attribution.nativeFeeWei,'1234567890123456789');
  const reordered=Object.fromEntries(Object.entries({...unallocated,feeAttribution:{nativeFeeWei:'1234567890123456789',selector:'0x12345678',contract:other,status:'unattributed' as const}}).reverse()) as unknown as FreshFinancialEvent;
  assert.deepEqual(await applyFreshFinancialEvents(client,[reordered],{now}),{inserted:0,applied:0},'JSONB ordering and input property ordering cannot duplicate a retained fee');
  // Re-decoding can prove attribution later, without changing or duplicating the original identity/native fee.
  const corrected={status:'eligible' as const,tokenAddress:token,contract:other,selector:'0x12345678',nativeFeeWei:'1234567890123456789'};
  await client.query('UPDATE fresh.financial_events SET fee_attribution=$2::jsonb,token_address=$3 WHERE id=$1',[unallocated.id,JSON.stringify(corrected),token]);await rebuildFreshScopesAfterReorg(client,[scope,privateScope,combined],now);
  const attributedKol=(await client.query('SELECT * FROM fresh.kols WHERE wallet_address=$1',[wallet])).rows[0];assert.equal(freshDecimal(attributedKol.today_realized_q),'24');assert.equal(attributedKol.today_unallocated_fee_count,1);assert.equal(attributedKol.today_unattributed_fee_count,0);
  const attributedPosition=(await client.query('SELECT * FROM fresh.positions WHERE scope_id=$1 AND token_address=$2',[privateScope,token])).rows[0];assert.equal(freshDecimal(attributedPosition.realized_q),'24.5');assert.equal(freshDecimal(attributedPosition.fees_q),'6');assert.equal(freshDecimal((await client.query('SELECT fee_only_fees_q FROM fresh.accounting_scopes WHERE id=$1',[privateScope])).rows[0].fee_only_fees_q),'0.5','Attributed token gas must not be counted again as a scope-only fee');
  assert.deepEqual(await applyFreshFinancialEvents(client,[{...unallocated,tokenAddress:token,feeAttribution:corrected}],{now}),{inserted:0,applied:0});
  // Correcting it back outside the policy removes the former deduction once, while retaining the fact.
  await client.query('UPDATE fresh.financial_events SET fee_attribution=$2::jsonb,token_address=NULL WHERE id=$1',[unallocated.id,JSON.stringify({...corrected,status:'excluded'})]);await rebuildFreshScopesAfterReorg(client,[scope,privateScope,combined],now);
  assert.equal(freshDecimal((await client.query('SELECT today_realized_q FROM fresh.kols WHERE wallet_address=$1',[wallet])).rows[0].today_realized_q),'27');
  // Orphan the sale and rebuild only affected books from compact journal facts.
  await client.query('UPDATE fresh.financial_events SET canonical=false WHERE id=$1',[sold.id]);
  await rebuildFreshScopesAfterReorg(client,[scope,privateScope,combined],now);
  const repaired=(await client.query('SELECT * FROM fresh.kols WHERE wallet_address=$1',[wallet])).rows[0];assert.equal(freshDecimal(repaired.today_realized_q),'-0.5');
  assert.equal(repaired.today_sell_count,0);assert.equal((await client.query('SELECT quantity_q FROM fresh.positions WHERE scope_id=$1',[scope])).rows[0].quantity_q,'12');
  assert.equal(`${(await client.query('SELECT tracked_trade_count FROM fresh.tokens WHERE address=$1',[token])).rows[0].tracked_trade_count}`,'3');
  const held=(await client.query('SELECT count(*)::int n FROM fresh.open_lots WHERE scope_id=$1',[scope])).rows[0].n;
  await rolloverFreshUtcDay(client,'2026-10-23T00:00:01Z');
  const midnight=(await client.query('SELECT * FROM fresh.kols WHERE wallet_address=$1',[wallet])).rows[0];assert.equal(midnight.today_realized_q,'0');assert.equal(midnight.today_trade_count,0);
  assert.equal((await client.query('SELECT count(*)::int n FROM fresh.open_lots WHERE scope_id=$1',[scope])).rows[0].n,held);
  // Conflicting duplicate evidence never silently overwrites a previously applied fact.
  await client.query('SAVEPOINT conflicting_event');
  await assert.rejects(applyFreshFinancialEvents(client,[{...bought,quantity:'999'}],{now}),/conflicting_financial_evidence/);
  await client.query('ROLLBACK TO SAVEPOINT conflicting_event');
  console.log(JSON.stringify({ok:true,checks:['idempotency','incremental_fifo','utc_midnight','smart_operations','private_scope','failed_fee','reorg_rebuild','public_counter_isolation','conflicting_evidence'],fixtureWrites:'rolled back'}));
} finally {await client.query('ROLLBACK');client.release();await db.end();}
