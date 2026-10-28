/** Actual predicates against session TEMP tables only; all mutations roll back. */
import assert from'node:assert/strict';
import type{PoolClient}from'pg';
import{freshReceiptOptionalTransferPriceSql,freshPositionReceiptRelevantSql}from'./positionDependencies.js';
import{freshDailyLeaderboardPendingSql,freshRollingLeaderboardPendingSql}from'./leaderboard.js';
export async function verifyFreshOptionalTransferPriceSql(c:PoolClient){
 const checks:string[]=[],a=(n:number)=>'0x'+n.toString(16).padStart(40,'0'),h=(n:number)=>'0x'+n.toString(16).padStart(64,'0');
 const wallet=a(1),other=a(2),token=a(3),second=a(4),scope='kol:'+wallet,from='2026-10-27T12:00:00.000Z',to='2026-10-28T12:00:00.000Z',at='2026-10-28T11:00:00.000Z';
 const names=['recent_evidence','recent_blocks','financial_events','scope_event_results','accounting_scopes','tokens','wallets','kols','checkpoints','pending_trades','launch_facts'];
 const rewrite=(sql:string)=>names.reduce((s,n)=>s.replaceAll('fresh.'+n,'pg_temp.optional_'+n),sql).replaceAll('public.journal_wallets','pg_temp.optional_members');
 const query=(sql:string,p:unknown[]=[])=>c.query(rewrite(sql),p);
 const state=async(id=scope)=>{
  const coverage=(await query(`SELECT ${freshReceiptOptionalTransferPriceSql('e','s')} covered,${freshPositionReceiptRelevantSql('e','$2','s')} relevant
   FROM fresh.recent_evidence e JOIN fresh.accounting_scopes s ON s.id=$1`,[id,token])).rows[0];
  const rolling=id===scope?(await query(`SELECT ${freshRollingLeaderboardPendingSql()} pending FROM fresh.wallets w WHERE w.address=$3`,[from,to,wallet])).rows[0].pending:null;
  const daily=id===scope?(await query(`SELECT ${freshDailyLeaderboardPendingSql()} pending FROM fresh.wallets w WHERE w.address=$2`,['2026-10-28',wallet])).rows[0].pending:null;
  return{...coverage,rolling,daily};
 };
 const rejected=async(name:string,sql:string,p:unknown[]=[],relevant=true)=>{await c.query('SAVEPOINT mutation');await query(sql,p);const x=await state();assert.equal(x.covered,false,name);assert.equal(x.relevant,relevant,name);assert.equal(x.rolling,true,name);assert.equal(x.daily,true,name);await c.query('ROLLBACK TO SAVEPOINT mutation');checks.push(name);};
 await c.query('BEGIN');
 try{
  await c.query("SET LOCAL statement_timeout='10s'");
  for(const name of names)await c.query('CREATE TEMP TABLE optional_'+name+'(LIKE fresh.'+name+' INCLUDING ALL) ON COMMIT DROP');
  await c.query('CREATE TEMP TABLE optional_members(user_id text,wallet_address text,registration_block bigint,activity_from timestamptz) ON COMMIT DROP');
  await query("INSERT INTO fresh.checkpoints(key,block_number,block_hash,value)VALUES('start',100,$1,$2),('capture',200,$3,'{}'),('accounting:realized_policy',NULL,NULL,$4)",[h(100),{startBlock:100,startHash:h(100),startTime:'2026-10-26T00:00:00.000Z'},h(200),{version:1,policy:'sales_fifo_fees_v2',state:'complete'}]);
  await query("INSERT INTO fresh.wallets(address,monitoring_from_block)VALUES($1,101),($2,101)",[wallet,other]);
  await query('INSERT INTO fresh.kols(wallet_address)VALUES($1),($2)',[wallet,other]);
  await query("INSERT INTO fresh.accounting_scopes(id,kind,wallet_addresses,starts_block,starts_at,active)VALUES($1,'kol',$2,101,'2026-10-26',true),($3,'kol',$4,101,'2026-10-26',true)",[scope,[wallet],'kol:'+other,[other]]);
  await query("INSERT INTO fresh.tokens(address,symbol,name,decimals,launch_status)VALUES($1,'TOKEN','Token',18,'eligible'),($2,'OTHER','Other',18,'eligible')",[token,second]);
  await query('INSERT INTO fresh.recent_blocks(block_number,block_hash,parent_hash,occurred_at)VALUES(150,$1,$2,$3)',[h(150),h(149),at]);
  await query("INSERT INTO fresh.recent_evidence(tx_hash,block_hash,block_number,transaction_index,payload,wallet_addresses,expires_at,decoder_status,last_error,position_dependency_addresses,position_dependency_proof)VALUES($1,$2,150,0,$3,$4,$5,'repair','incoming_transfer_cost_unknown',$6,$7)",[h(999),h(150),Buffer.from('original immutable receipt'),[wallet,other],to,[wallet,other,token,second],'a'.repeat(64)]);
  await query("INSERT INTO fresh.financial_events(id,execution_key,wallet_address,token_address,kind,quantity,amount_usd,fee_usd,block_number,block_hash,transaction_hash,transaction_index,execution_index,occurred_at)VALUES('in','in',$1,$2,'transfer_in','1',NULL,'0',150,$3,$4,0,0,$5)",[wallet,token,h(150),h(999),at]);
  await query("INSERT INTO fresh.scope_event_results(scope_id,event_id,token_address,realized_q,fee_q,occurred_at)VALUES($1,'in',$2,'0','0',$3)",[scope,token,at]);
  const evidenceBefore=(await query('SELECT to_jsonb(e) data FROM fresh.recent_evidence e')).rows[0].data;
  assert.deepEqual(await state(),{covered:true,relevant:false,rolling:false,daily:false});checks.push('Unknown incoming acquisition basis stays null while fully applied realized results are ready');
  await rejected('Missing own result cannot borrow another public book',"UPDATE fresh.scope_event_results SET scope_id=$1",['kol:'+other]);
  await rejected('Another token result is not coverage',"UPDATE fresh.scope_event_results SET token_address=$1",[second]);
  await rejected('Missing charged fee remains pending',"UPDATE fresh.scope_event_results SET fee_q=NULL");
  await rejected('Missing authentic fee remains pending',"UPDATE fresh.financial_events SET fee_usd=NULL");
  await rejected('Null realization remains pending',"UPDATE fresh.scope_event_results SET realized_q=NULL");
  await rejected('Unvalued actual buy is never waived',"UPDATE fresh.financial_events SET kind='buy'");
  await rejected('Unvalued actual sale is never waived',"UPDATE fresh.financial_events SET kind='sell'");
  await rejected('Null result for a valued actual sale remains pending',"UPDATE fresh.financial_events SET kind='sell',amount_usd='10'; UPDATE fresh.scope_event_results SET realized_q=NULL");
  await rejected('Mixed missing trade result rejects otherwise covered transfers',`INSERT INTO fresh.financial_events(id,execution_key,wallet_address,token_address,kind,quantity,amount_usd,fee_usd,block_number,block_hash,transaction_hash,transaction_index,execution_index,occurred_at)VALUES('sale','sale',$1,$2,'sell','1','10','1',150,$3,$4,0,1,$5)`,[wallet,second,h(150),h(999),at]);
  await rejected('Opaque address index remains globally pending',"UPDATE fresh.recent_evidence SET position_dependency_addresses=NULL");
  await rejected('Missing proof cannot authenticate the address list',"UPDATE fresh.recent_evidence SET position_dependency_proof=NULL");
  await rejected('Unbound token dependency cannot waive global pending',"UPDATE fresh.recent_evidence SET position_dependency_addresses=$1",[[wallet,other]],false);
  await rejected('Unknown precision is not a mark-only repair',"UPDATE fresh.tokens SET decimals=NULL");
  await rejected('Orphaned receipt header remains pending',"UPDATE fresh.recent_blocks SET block_hash=$1",[h(151)]);
  await rejected('Contradictory canonical event time remains pending',"UPDATE fresh.financial_events SET occurred_at='2026-10-28T10:59:00Z'");
  await rejected('Result time must match the exact fact',"UPDATE fresh.scope_event_results SET occurred_at='2026-10-28T10:59:00Z'");
  await rejected('Unmonitored wallet history remains pending',"UPDATE fresh.wallets SET monitoring_from_block=151 WHERE address=$1",[wallet]);
  for(const warning of['incoming_transfer_cost_unknown,trade_value_unavailable','token_discovery_pending','historical_precision_unavailable','synthetic_transfer_batch_unverified','outgoing_transfer_value_unknown,','incoming_transfer_cost_unknown,incoming_transfer_cost_unknown'])await rejected('Non-allowlisted error '+warning,"UPDATE fresh.recent_evidence SET last_error=$1",[warning]);
  await rejected('Unsupported execution cannot use a repair-only gate',"UPDATE fresh.recent_evidence SET decoder_status='unsupported'");
  await rejected('Old or unfinished realized policy remains pending',"DELETE FROM fresh.checkpoints WHERE key='accounting:realized_policy'");
  await rejected('An unpromoted own swap remains pending',`INSERT INTO fresh.pending_trades(id,execution_key,wallet_address,token_address,kind,raw_quantity,block_number,block_hash,transaction_hash,transaction_index,execution_index,log_index,occurred_at,evidence_hash)VALUES('pending','pending',$1,$2,'buy','1',150,$3,$4,0,1,1,$5,$6)`,[wallet,token,h(150),h(999),at,'b'.repeat(64)]);
  await c.query('SAVEPOINT shared');
  await query("INSERT INTO fresh.financial_events(id,execution_key,wallet_address,token_address,kind,quantity,amount_usd,fee_usd,block_number,block_hash,transaction_hash,transaction_index,execution_index,occurred_at)VALUES('other-sale','other-sale',$1,$2,'sell','1','10','1',150,$3,$4,0,2,$5)",[other,second,h(150),h(999),at]);
  await query("INSERT INTO fresh.scope_event_results(scope_id,event_id,token_address,realized_q,fee_q,occurred_at)VALUES($1,'other-sale',$2,NULL,'1',$3)",['kol:'+other,second,at]);
  assert.equal((await state()).covered,true);assert.equal((await state('kol:'+other)).covered,false);checks.push('Shared receipt never imports another wallet actual unknown sale into a complete book');
  await c.query('ROLLBACK TO SAVEPOINT shared');
  await c.query('SAVEPOINT private');
  await query("INSERT INTO fresh.accounting_scopes(id,kind,account_id,wallet_addresses,starts_block,starts_at,active)VALUES('private','portfolio_wallet','account',$1,101,'2026-10-26',true)",[[wallet]]);
  await query("INSERT INTO fresh.scope_event_results SELECT 'private',event_id,token_address,realized_q,known_realized_q,capital_q,fee_q,fee_key,trade_count,volume_q,tokens_trade,occurred_at FROM fresh.scope_event_results");
  assert.equal((await state('private')).covered,false);
  await c.query('INSERT INTO pg_temp.optional_members VALUES($1,$2,151,$3)',['account',wallet,'2026-10-28T11:00:01Z']);assert.equal((await state('private')).covered,false);
  await c.query("UPDATE pg_temp.optional_members SET registration_block=101,activity_from='2026-10-26'");assert.equal((await state('private')).covered,true);checks.push('Private scope needs its own result and both exact active membership boundaries');
  await c.query('ROLLBACK TO SAVEPOINT private');
  assert.deepEqual((await query('SELECT to_jsonb(e) data FROM fresh.recent_evidence e')).rows[0].data,evidenceBefore);checks.push('Original evidence payload, repair status, warning, TTL and dependency proof remain identical');
  await c.query('ROLLBACK');return{passed:true,checks,providerCalls:0,applicationWrites:0,fixtureWrites:'TEMP only, rolled back'};
 }catch(error){await c.query('ROLLBACK');throw error;}
}
