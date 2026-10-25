/** Actual position-summary reads against TEMP fixtures, with no app writes. */
import assert from 'node:assert/strict';import {Pool} from 'pg';import {createFreshReads} from './reads.js';
const url=new URL(process.env.DATABASE_URL??'');if(!['127.0.0.1','localhost'].includes(url.hostname)||url.port!=='5436'||url.pathname!=='/kollens_fresh_20261022_24h')throw Error('Exact local database required');
const db=new Pool({connectionString:url.toString(),max:1}),client=await db.connect(),checks:string[]=[];
const a=(n:number)=>`0x${n.toString(16).padStart(40,'0')}`,h=(n:number)=>`0x${n.toString(16).padStart(64,'0')}`,wallet=a(1),token=a(2),scope=`kol:${wallet}`,now=Date.parse('2026-10-24T01:00:00Z');
const names=['positions','tokens','accounting_scopes','financial_events','recent_blocks','checkpoints','recent_evidence','wallets','jobs','open_lots'];
const rewrite=(sql:string)=>names.reduce((value,name)=>value.replaceAll('fresh.'+name,'pg_temp.position_read_'+name),sql)
 .replaceAll('fresh.pending_trades','pg_temp.position_read_pending_trades').replaceAll('fresh.visible_trades','pg_temp.position_read_financial_events');
const facade={query:(sql:string,args?:unknown[])=>client.query(rewrite(sql),args)}as unknown as Pool,reads=createFreshReads(facade,()=>now,true);
try{await client.query('BEGIN');await client.query("SET LOCAL statement_timeout='10s'");for(const name of names)await client.query(`CREATE TEMP TABLE position_read_${name} AS SELECT * FROM fresh.${name} LIMIT 0`);
await client.query('ALTER TABLE position_read_financial_events ADD COLUMN IF NOT EXISTS provenance jsonb');
await client.query('CREATE TEMP TABLE position_read_pending_trades AS SELECT * FROM position_read_financial_events LIMIT 0');
await client.query('ALTER TABLE position_read_recent_evidence ADD COLUMN IF NOT EXISTS position_dependency_addresses text[],ADD COLUMN IF NOT EXISTS position_dependency_proof text');
await client.query(`INSERT INTO position_read_accounting_scopes(id,kind,wallet_addresses,starts_block,starts_at,revision,correction_epoch,active)VALUES($1,'kol',$2,10,'2026-10-23T00:00:00Z',1,0,true)`,[scope,[wallet]]);
await client.query(`INSERT INTO position_read_tokens(address,name,symbol,decimals,launch_status,valuation_status)VALUES($1,'Test','TEST',18,'eligible','pending')`,[token]);
await client.query(`INSERT INTO position_read_wallets(address)VALUES($1)`,[wallet]);
await client.query(`INSERT INTO position_read_financial_events(id,block_number)VALUES('last',50)`);
await client.query(`INSERT INTO position_read_positions(scope_id,token_address,quantity_q,invested_q,sold_q,incoming_q,outgoing_q,fees_q,capital_q,realized_q,unknown_cost,unknown_fee,unknown_purchase_value,unknown_sale_value,unknown_incoming_value,unknown_outgoing_value,last_event_id,last_event_at,revision,balance_quantity,balance_block,balance_hash,balance_checked_at,balance_status)
VALUES($1,$2,'0','10','15','0','0','1','11','4',false,false,false,false,false,false,'last','2026-10-24T00:01:00Z',1,'0',100,$3,'2026-10-24T00:02:00Z','matched')`,[scope,token,h(100)]);
await client.query(`INSERT INTO position_read_checkpoints(key,block_number,block_hash,updated_at,value)VALUES('start',10,$1,'2026-10-23T00:00:00Z','{}'),('capture',120,$2,'2026-10-24T00:03:00Z','{}'),('decode',120,$2,'2026-10-24T00:03:00Z','{}')`,[h(10),h(120)]);
const read=async()=> (await reads.summaries(wallet,[token]))[token];
assert.equal((await read()).realizedStatus,'ready');assert.equal((await read()).realizedProfitUsd,'4');assert.equal((await read()).status,'ready');checks.push('closed_stored_realized_requires_no_current_quote');
await client.query(`INSERT INTO position_read_recent_evidence(block_number,block_hash,wallet_addresses,decoder_status,position_dependency_addresses,position_dependency_proof)VALUES(80,$1,$2,'repair',$3,$4)`,[h(80),[wallet],[a(3)],'a'.repeat(64)]);
assert.equal((await read()).realizedStatus,'ready');checks.push('proven_unrelated_execution_does_not_suppress_stored_realized');
await client.query('UPDATE position_read_recent_evidence SET position_dependency_addresses=$1',[[token]]);assert.notEqual((await read()).realizedStatus,'ready');checks.push('same_token_unknown_execution_still_blocks_realized');
await client.query('UPDATE position_read_recent_evidence SET position_dependency_addresses=$1,position_dependency_proof=NULL',[[a(3)]]);assert.notEqual((await read()).realizedStatus,'ready');checks.push('unverified_index_stays_opaque');
await client.query('DELETE FROM position_read_recent_evidence');await client.query('UPDATE position_read_wallets SET decode_gap_from_block=5');assert.equal((await read()).reason,'wallet_decode_gap');assert.notEqual((await read()).realizedStatus,'ready');checks.push('earliest_unbounded_gap_before_scope_is_not_hidden');
await client.query('UPDATE position_read_wallets SET decode_gap_from_block=130');assert.equal((await read()).realizedStatus,'ready');checks.push('future_gap_after_captured_cutoff_does_not_invalidate_dated_proof');
await client.query('UPDATE position_read_wallets SET decode_gap_from_block=NULL');await client.query("UPDATE position_read_positions SET quantity_q='1',balance_quantity='1'");let value=await read();assert.equal(value.realizedStatus,'ready');assert.equal(value.realizedProfitUsd,'4');assert.equal(value.status,'pending');assert.equal(value.reason,'quote_unavailable');checks.push('open_realized_survives_quote_outage_but_replay_total_does_not');
await client.query('UPDATE position_read_positions SET unknown_cost=true');value=await read();assert.notEqual(value.realizedStatus,'ready');assert.equal(value.realizedProfitUsd,null);checks.push('genuine_unknown_cost_is_never_approved');
await client.query('ROLLBACK');console.log(JSON.stringify({ok:true,checks,fixtureWrites:'TEMP tables rolled back',appWrites:0,rpc:0}));
}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();await db.end()}
