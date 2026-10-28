import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import type {PoolClient} from 'pg';
import {decodeFreshEvidence} from './capture.js';
import {freshPositionDependencies,freshReceiptOptionalTransferPriceSql} from './positionDependencies.js';
import {freshRollingLeaderboardPendingSql} from './leaderboard.js';

/** Original passive-transfer fixture, real PostgreSQL predicates, TEMP only. */
export async function verifyFreshTransferParticipantIndex(c:PoolClient){
 const fixture=JSON.parse(gunzipSync(readFileSync(new URL('./fixtures/position-transfer-participants.json.gz',import.meta.url))).toString()),entry=decodeFreshEvidence(Buffer.from(fixture.payloadBase64,'base64')),fact=fixture.fact;
 const next=freshPositionDependencies(entry);assert(next);
 const oldAddresses=new Set<string>();const visit=(call:NonNullable<typeof entry.trace>)=>{if(call.from)oldAddresses.add(call.from);if(call.to)oldAddresses.add(call.to);call.calls?.forEach(visit);};visit(entry.trace!);
 entry.receipt.logs.forEach(log=>oldAddresses.add(log.address));oldAddresses.add(entry.transaction.from);if(entry.transaction.to)oldAddresses.add(entry.transaction.to);
 assert(!oldAddresses.has(fact.wallet_address));assert(next.addresses.includes(fact.wallet_address));
 const names=['recent_evidence','recent_blocks','financial_events','scope_event_results','accounting_scopes','tokens','wallets','kols','checkpoints','pending_trades','launch_facts'],checks:string[]=[];
 const rewrite=(sql:string)=>names.reduce((s,n)=>s.replaceAll('fresh.'+n,'pg_temp.participant_'+n),sql).replaceAll('public.journal_wallets','pg_temp.participant_members');
 const query=(sql:string,args:unknown[]=[])=>c.query(rewrite(sql),args),scope='kol:'+fact.wallet_address,at=fact.occurred_at,from=new Date(Date.parse(at)-3600000).toISOString(),to=new Date(Date.parse(at)+23*3600000).toISOString();
 const state=async()=>(await query(`SELECT ${freshReceiptOptionalTransferPriceSql('e','s')} optional,${freshRollingLeaderboardPendingSql()} rolling_pending
  FROM fresh.recent_evidence e JOIN fresh.accounting_scopes s ON s.id=$3 JOIN fresh.wallets w ON w.address=$4`,[from,to,scope,fact.wallet_address])).rows[0];
 const originals=async()=>({facts:(await query('SELECT to_jsonb(f) value FROM fresh.financial_events f ORDER BY f.id')).rows,results:(await query('SELECT to_jsonb(r) value FROM fresh.scope_event_results r ORDER BY r.event_id')).rows,
  evidence:(await query("SELECT encode(payload,'base64') payload,expires_at,last_error,decoder_status,decoder_version FROM fresh.recent_evidence")).rows});
 await c.query('BEGIN');try{
  await c.query("SET LOCAL statement_timeout='10s'");for(const name of names)await c.query('CREATE TEMP TABLE participant_'+name+'(LIKE fresh.'+name+' INCLUDING ALL) ON COMMIT DROP');
  await c.query('CREATE TEMP TABLE participant_members(user_id text,wallet_address text,registration_block bigint,activity_from timestamptz) ON COMMIT DROP');
  await query("INSERT INTO fresh.checkpoints(key,block_number,block_hash,value)VALUES('start',129627586,$1,$2),('capture',$3,$4,'{}'),('accounting:realized_policy',NULL,NULL,$5)",['0x11a1ab790a8a32d1ef7569c17447bb0283ab534d5231951fc6e3f384cd049d27',{startBlock:129627586,startHash:'0x11a1ab790a8a32d1ef7569c17447bb0283ab534d5231951fc6e3f384cd049d27',startTime:'2026-10-25T02:42:03.000Z'},fact.block_number,fact.block_hash,{version:1,policy:'sales_fifo_fees_v2',state:'complete'}]);
  await query('INSERT INTO fresh.wallets(address,monitoring_from_block)VALUES($1,129627587)',[fact.wallet_address]);await query('INSERT INTO fresh.kols(wallet_address)VALUES($1)',[fact.wallet_address]);
  await query("INSERT INTO fresh.accounting_scopes(id,kind,wallet_addresses,starts_block,starts_at)VALUES($1,'kol',$2,129627587,'2026-10-25T02:42:03.000Z')",[scope,[fact.wallet_address]]);
  await query("INSERT INTO fresh.tokens(address,symbol,name,decimals,launch_status)VALUES($1,'悲伤蛙','Passive token',18,'eligible')",[fact.token_address]);
  await query('INSERT INTO fresh.recent_blocks(block_number,block_hash,parent_hash,occurred_at)VALUES($1,$2,$3,$4)',[fact.block_number,fact.block_hash,'0x'+'1'.repeat(64),fact.occurred_at]);
  await query("INSERT INTO fresh.recent_evidence(tx_hash,block_hash,block_number,transaction_index,payload,wallet_addresses,expires_at,decoder_status,decoder_version,last_error,position_dependency_addresses,position_dependency_proof)VALUES($1,$2,$3,$4,$5,$6,$7,'repair',3,'incoming_transfer_cost_unknown',$8,$9)",[fact.transaction_hash,fact.block_hash,fact.block_number,fact.transaction_index,Buffer.from(fixture.payloadBase64,'base64'),entry.wallets,new Date(Date.parse(entry.observedAt)+72*3600000),[...oldAddresses].sort(),next.proofHash]);
  await query("INSERT INTO fresh.financial_events(id,execution_key,wallet_address,token_address,kind,quantity,amount_usd,fee_usd,block_number,block_hash,transaction_hash,transaction_index,execution_index,log_index,occurred_at)VALUES($1,$2,$3,$4,'transfer_in',$5,NULL,'0',$6,$7,$8,$9,$10,$11,$12)",[fact.id,fact.execution_key,fact.wallet_address,fact.token_address,fact.quantity,fact.block_number,fact.block_hash,fact.transaction_hash,fact.transaction_index,fact.execution_index,fact.log_index,fact.occurred_at]);
  await query("INSERT INTO fresh.scope_event_results(scope_id,event_id,token_address,realized_q,known_realized_q,fee_q,trade_count,occurred_at)VALUES($1,$2,$3,'0','0','0',0,$4)",[scope,fact.id,fact.token_address,fact.occurred_at]);
  const before=await originals();assert.deepEqual(await state(),{optional:false,rolling_pending:true});checks.push('Actual passive beneficiary absent from former call/emitter index reproduces pending');
  await query('UPDATE fresh.recent_evidence SET position_dependency_addresses=$1,position_dependency_proof=$2',[next.addresses,next.proofHash]);
  assert.deepEqual(await state(),{optional:true,rolling_pending:false});checks.push('Actual canonical Transfer participant addition enables only fully applied optional-transfer readiness');
  assert.deepEqual(await originals(),before);checks.push('Original payload warning TTL status decoder version and all financial facts/results unchanged');
  for(const[name,sql]of [['unknown_actual_realization','UPDATE fresh.scope_event_results SET realized_q=NULL'],['unknown_actual_fee','UPDATE fresh.financial_events SET fee_usd=NULL'],['unvalued_actual_sale',"UPDATE fresh.financial_events SET kind='sell'"],['orphaned_header',"UPDATE fresh.recent_blocks SET block_hash='0x"+'f'.repeat(64)+"'"],['missing_proof','UPDATE fresh.recent_evidence SET position_dependency_proof=NULL']]as const){
   await c.query('SAVEPOINT negative');await query(sql);assert.equal((await state()).optional,false);assert.equal((await state()).rolling_pending,true);await c.query('ROLLBACK TO SAVEPOINT negative');checks.push(name+' remains pending');
  }
  await c.query('ROLLBACK');return{passed:true,checks,fixture:'actual David certified passive batch transfer',financialWrites:0,applicationWrites:0,nodeCalls:0,providerCalls:0,fixtureWrites:'TEMP only, rolled back'};
 }catch(error){await c.query('ROLLBACK');throw error;}
}
