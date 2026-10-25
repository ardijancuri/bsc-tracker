/** Local, rolled-back fixtures; no RPC or historical/accounting recalculation. */
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {Pool} from 'pg';
import {applyFreshFinancialEvents} from './accounting.js';
import {persistFreshDecodedReceipt} from './decode.js';
import {persistFreshTradeBnbPrice,freshTradeBnbEquivalent} from './tradeBnbDisplay.js';
import type {FreshFinancialEvent} from '../../shared/freshAccounting.js';
const url=new URL(process.env.DATABASE_URL??'');
if(!['localhost','127.0.0.1'].includes(url.hostname)||url.port!=='5436'||url.pathname!=='/kollens_fresh_20261022_24h')throw Error('isolated_local_fresh_only');
const db=new Pool({connectionString:url.href,max:1}),c=await db.connect(),wallet='0x'+randomBytes(20).toString('hex'),token='0x'+randomBytes(20).toString('hex'),scope='kol:'+wallet;
const now='2026-10-24T00:00:00Z',event:FreshFinancialEvent={id:'bnb-display:'+wallet,executionKey:'bnb-display:'+wallet,walletAddress:wallet,tokenAddress:token,kind:'buy',quantity:'10',amountUsd:'123.456789',feeUsd:'1',feeKey:'fee:'+wallet,counterparty:null,transferKey:null,blockNumber:'2',blockHash:'0x'+'a'.repeat(64),transactionHash:'0x'+'b'.repeat(64),transactionIndex:0,executionIndex:0,logIndex:0,occurredAt:now,canonical:true,quoteAddress:'0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d',quoteSymbol:'USDC',quoteAmount:'123.5'};
try{
 await c.query('BEGIN');await c.query('INSERT INTO fresh.wallets(address,monitoring_from_block) VALUES($1,1)',[wallet]);await c.query("INSERT INTO fresh.kols(wallet_address,display_name,today_utc) VALUES($1,'BNB display fixture','2026-10-24')",[wallet]);
 await c.query("INSERT INTO fresh.tokens(address,name,launch_status) VALUES($1,'Display fixture','eligible')",[token]);await c.query("INSERT INTO fresh.accounting_scopes(id,kind,wallet_addresses,starts_at,starts_block) VALUES($1,'kol',$2,'2026-10-23T00:00:00Z',1)",[scope,[wallet]]);
 await applyFreshFinancialEvents(c,[event],{now});
 const current=async()=>({positions:(await c.query('SELECT * FROM fresh.positions WHERE scope_id=$1',[scope])).rows,lots:(await c.query('SELECT * FROM fresh.open_lots WHERE scope_id=$1',[scope])).rows,kol:(await c.query('SELECT * FROM fresh.kols WHERE wallet_address=$1',[wallet])).rows,scope:(await c.query('SELECT * FROM fresh.accounting_scopes WHERE id=$1',[scope])).rows,results:(await c.query('SELECT * FROM fresh.scope_event_results WHERE scope_id=$1',[scope])).rows});
 const before=await current(),old=(await c.query('SELECT * FROM fresh.financial_events WHERE id=$1',[event.id])).rows[0];
 await persistFreshDecodedReceipt(c,{events:[event],tokens:[],reasons:[],executions:1,tradeBnbPrices:{[event.id]:'800'}},new Date(now));
 assert.deepEqual(await current(),before,'A display rate cannot rebuild accounting or update metrics');
 const after=(await c.query('SELECT * FROM fresh.financial_events WHERE id=$1',[event.id])).rows[0];assert.equal(freshTradeBnbEquivalent(after),'0.15432098625');assert.deepEqual({...after,bnb_price_usd:null,decoder_version:old.decoder_version},old);assert.equal(after.decoder_version,3);
 assert.equal(await persistFreshTradeBnbPrice(c,event,'800.0'),false,'Same dated rate is idempotent');
 for(const change of[{amountUsd:'124'},{quoteAmount:'124'},{quoteSymbol:'BNB'},{quantity:'11'},{transactionIndex:1},{blockHash:'0x'+'f'.repeat(64)}])await assert.rejects(persistFreshTradeBnbPrice(c,{...event,...change},'800'),/context_changed/);
 await assert.rejects(persistFreshTradeBnbPrice(c,event,'801'),/conflicting_trade_bnb_display_rate/);
 await assert.rejects(persistFreshTradeBnbPrice(c,event,'0'),/invalid_trade_bnb_display_rate/);
 assert.deepEqual(await current(),before);
 const added={...event,id:event.id+':new',executionKey:event.executionKey+':new',transactionHash:'0x'+'c'.repeat(64),blockNumber:'3',occurredAt:'2026-10-24T00:00:01Z'};
 await persistFreshDecodedReceipt(c,{events:[added],tokens:[],reasons:[],executions:1,tradeBnbPrices:{[added.id]:'800'}},new Date(now));
 assert.equal((await c.query('SELECT bnb_price_usd FROM fresh.financial_events WHERE id=$1',[added.id])).rows[0].bnb_price_usd,'800');
 console.log(JSON.stringify({ok:true,checks:13,fixtureWrites:'rolled_back',nodeRequests:0,financialProviderRequests:0}));
}finally{await c.query('ROLLBACK');c.release();await db.end();}
