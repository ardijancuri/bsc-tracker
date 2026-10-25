/** Local transaction-rolled-back fixtures. No source/provider RPC or app rows changed. */
import assert from'node:assert/strict';
import{randomBytes}from'node:crypto';
import{Pool}from'pg';
import{applyFreshFinancialEvents,freshEventFromRow,persistFreshTradeQuote}from'./accounting.js';
import{persistFreshDecodedReceipt}from'./decode.js';
import type{FreshFinancialEvent}from'../../shared/freshAccounting.js';
const url=new URL(process.env.DATABASE_URL??'');
if(!['127.0.0.1','localhost'].includes(url.hostname)||url.port!=='5436'||url.pathname!=='/kollens_fresh_20261022_24h')throw Error('Use the isolated local Fresh database');
const db=new Pool({connectionString:url.toString(),max:1}),client=await db.connect(),wallet='0x'+randomBytes(20).toString('hex'),token='0x'+randomBytes(20).toString('hex'),scope='kol:'+wallet,native='0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c';
const now='2026-10-24T00:00:00Z',event:FreshFinancialEvent={id:'quote-test:'+wallet,executionKey:'quote-test:'+wallet,walletAddress:wallet,tokenAddress:token,kind:'buy',quantity:'10',amountUsd:'100',feeUsd:'1',feeKey:'quote-fee:'+wallet,
 counterparty:null,transferKey:null,blockNumber:'2',blockHash:'0x'+'a'.repeat(64),transactionHash:'0x'+'b'.repeat(64),transactionIndex:0,executionIndex:0,logIndex:0,occurredAt:now,canonical:true};
try{
 await client.query('BEGIN');
 await client.query('INSERT INTO fresh.wallets(address,monitoring_from_block)VALUES($1,1)',[wallet]);
 await client.query("INSERT INTO fresh.kols(wallet_address,display_name,today_utc)VALUES($1,'Quote fixture','2026-10-24')",[wallet]);
 await client.query("INSERT INTO fresh.tokens(address,name,launch_status)VALUES($1,'Quote fixture','eligible')",[token]);
 await client.query("INSERT INTO fresh.accounting_scopes(id,kind,wallet_addresses,starts_at,starts_block)VALUES($1,'kol',$2,'2026-10-23T00:00:00Z',1)",[scope,[wallet]]);
 await applyFreshFinancialEvents(client,[event],{now});
 const current=async()=>({position:(await client.query('SELECT * FROM fresh.positions WHERE scope_id=$1',[scope])).rows,
  lots:(await client.query('SELECT * FROM fresh.open_lots WHERE scope_id=$1',[scope])).rows,metrics:(await client.query('SELECT * FROM fresh.kols WHERE wallet_address=$1',[wallet])).rows,
  results:(await client.query('SELECT * FROM fresh.scope_event_results WHERE scope_id=$1',[scope])).rows});
 const before=await current(),quoted={...event,quoteAddress:native,quoteSymbol:'BNB',quoteAmount:'0.1'};
 await persistFreshDecodedReceipt(client,{events:[quoted],tokens:[],reasons:[],executions:1},new Date(now));
 assert.deepEqual(await current(),before,'Quote enrichment cannot rebuild FIFO or touch current totals');
 const stored=(await client.query('SELECT * FROM fresh.financial_events WHERE id=$1',[event.id])).rows[0];
 assert.equal(stored.quote_address,native);assert.equal(stored.quote_symbol,'BNB');assert.equal(stored.quote_amount,'0.1');assert.equal(stored.amount_usd,'100');assert.equal(stored.fee_usd,'1');
 assert.equal(freshEventFromRow(stored).quoteAmount,'0.1');
 assert.deepEqual(await applyFreshFinancialEvents(client,[event],{now}),{inserted:0,applied:0});assert.deepEqual(await current(),before);
 await client.query('SAVEPOINT conflicting_quote');
 await assert.rejects(persistFreshDecodedReceipt(client,{events:[{...quoted,quoteAmount:'0.2'}],tokens:[],reasons:[],executions:1},new Date(now)),/conflicting_trade_quote_evidence/);
 await client.query('ROLLBACK TO SAVEPOINT conflicting_quote');
 assert.equal((await client.query('SELECT quote_amount FROM fresh.financial_events WHERE id=$1',[event.id])).rows[0].quote_amount,'0.1');
 for(const changed of[{quantity:'11'},{executionKey:event.executionKey+':wrong'},{executionIndex:1},{blockHash:'0x'+'f'.repeat(64)},{transactionIndex:1},{walletAddress:token},{tokenAddress:wallet},{logIndex:1}]){
  await client.query('SAVEPOINT stale_quote');await assert.rejects(persistFreshTradeQuote(client,{...quoted,...changed}),/trade_quote_context_changed/);await client.query('ROLLBACK TO SAVEPOINT stale_quote');
 }
 assert.deepEqual(await current(),before,'Mismatched context cannot alter financial state');
 const newEvent={...quoted,id:event.id+':new',executionKey:event.executionKey+':new',transactionHash:'0x'+'c'.repeat(64),blockNumber:'3',occurredAt:'2026-10-24T00:00:01Z'};
 await applyFreshFinancialEvents(client,[newEvent],{now});assert.equal((await client.query('SELECT quote_amount FROM fresh.financial_events WHERE id=$1',[newEvent.id])).rows[0].quote_amount,'0.1');
 console.log(JSON.stringify({ok:true,checks:17,fixtureWrites:'rolled back',rpcRequests:0,financialProviderRequests:0}));
}finally{await client.query('ROLLBACK');client.release();await db.end();}
