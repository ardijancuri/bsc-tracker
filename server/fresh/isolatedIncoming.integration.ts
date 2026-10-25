/** Fixture writes roll back; no RPC, providers, messages or schema changes. */
import assert from 'node:assert/strict';import{randomBytes}from'node:crypto';import{Pool}from'pg';
import{applyFreshFinancialEvents}from'./accounting.js';
import{canAppendFreshIsolatedIncoming,persistFreshDecodedReceipt,type FreshDecodedReceipt}from'./decode.js';
import type{FreshFinancialEvent}from'../../shared/freshAccounting.js';
const url=new URL(process.env.DATABASE_URL??'');if(url.hostname!=='127.0.0.1'||url.port!=='5436'||url.pathname!=='/kollens_fresh_20261022_24h')throw Error('isolated_database_required');
const db=new Pool({connectionString:url.href,max:1}),c=await db.connect(),address=()=>`0x${randomBytes(20).toString('hex')}`,hash=()=>`0x${randomBytes(32).toString('hex')}`;
const wallet=address(),external=address(),bibi=address(),newToken=address(),scope='kol:'+wallet,now=new Date();let n=0;
const event=(overrides:Partial<FreshFinancialEvent>={}):FreshFinancialEvent=>{const id=wallet+':fixture:'+(++n);return{id,executionKey:id,walletAddress:wallet,tokenAddress:bibi,kind:'buy',quantity:'10',amountUsd:'100',feeUsd:'1',feeKey:id+':fee',counterparty:null,transferKey:null,blockNumber:'120',blockHash:hash(),transactionHash:hash(),transactionIndex:0,executionIndex:0,logIndex:0,occurredAt:new Date(now.getTime()-120000).toISOString(),canonical:true,...overrides};};
const decoded=(e:FreshFinancialEvent):FreshDecodedReceipt=>({events:[e],tokens:[{address:e.tokenAddress!,name:null,symbol:null,decimals:18,supplyRaw:null,block:{number:Number(e.blockNumber),hash:e.blockHash,timestamp:e.occurredAt}}],reasons:['incoming_transfer_cost_unknown'],executions:1});
const sameRows=async(table:string,token:string)=>(await c.query(`SELECT to_jsonb(t)::text body FROM fresh.${table} t WHERE scope_id=$1 AND token_address=$2 ORDER BY to_jsonb(t)::text`,[scope,token])).rows;
try{
 await c.query('BEGIN');await c.query('SELECT pg_advisory_xact_lock(73621941)');
 await c.query('INSERT INTO fresh.wallets(address,monitoring_from_block) VALUES($1,100)',[wallet]);await c.query('INSERT INTO fresh.kols(wallet_address) VALUES($1)',[wallet]);
 await c.query("INSERT INTO fresh.tokens(address,name,launch_status) VALUES($1,'BIBI preservation fixture','eligible'),($2,'New incoming fixture','eligible')",[bibi,newToken]);
 await c.query("INSERT INTO fresh.accounting_scopes(id,kind,wallet_addresses,starts_at,starts_block) VALUES($1,'kol',$2,$3,100)",[scope,[wallet],new Date(now.getTime()-3600000)]);
 const buy=event(),sell=event({kind:'sell',quantity:'5',amountUsd:'80',feeUsd:'2',blockNumber:'130',occurredAt:new Date(now.getTime()-60000).toISOString()});
 await applyFreshFinancialEvents(c,[buy,sell],{now});await c.query("UPDATE fresh.positions SET balance_status='matched',balance_quantity='5',balance_block=130,balance_hash=$3,balance_checked_at=$4 WHERE scope_id=$1 AND token_address=$2",[scope,bibi,sell.blockHash,now]);
 const preserved={position:await sameRows('positions',bibi),lots:await sameRows('open_lots',bibi),results:await sameRows('scope_event_results',bibi),epoch:(await c.query('SELECT correction_epoch FROM fresh.accounting_scopes WHERE id=$1',[scope])).rows[0].correction_epoch,
  metrics:(await c.query('SELECT rolling_realized_q,rolling_capital_q,rolling_trade_count,rolling_token_count,today_realized_q,today_trade_count FROM fresh.kols WHERE wallet_address=$1',[wallet])).rows[0]};
 const incoming=event({tokenAddress:newToken,kind:'transfer_in',quantity:'1',amountUsd:null,feeUsd:'0',counterparty:external,transferKey:'isolated:'+wallet,blockNumber:'110',occurredAt:new Date(now.getTime()-180000).toISOString()}),d=decoded(incoming);
 assert.equal(await canAppendFreshIsolatedIncoming(c,[incoming],[d],[scope]),true);
 await persistFreshDecodedReceipt(c,d,now);
 assert.deepEqual(await sameRows('positions',bibi),preserved.position,'unrelated BIBI balance/revision must remain byte exact');assert.deepEqual(await sameRows('open_lots',bibi),preserved.lots);assert.deepEqual(await sameRows('scope_event_results',bibi),preserved.results);
 assert.equal((await c.query('SELECT correction_epoch FROM fresh.accounting_scopes WHERE id=$1',[scope])).rows[0].correction_epoch,preserved.epoch,'new token must not rebuild the book');
 assert.deepEqual((await c.query('SELECT rolling_realized_q,rolling_capital_q,rolling_trade_count,rolling_token_count,today_realized_q,today_trade_count FROM fresh.kols WHERE wallet_address=$1',[wallet])).rows[0],preserved.metrics);
 const position=(await c.query('SELECT * FROM fresh.positions WHERE scope_id=$1 AND token_address=$2',[scope,newToken])).rows[0];assert.equal(position.quantity_q,'1');assert.equal(position.unknown_cost,true);assert.equal(position.unknown_incoming_value,true);
 assert.equal((await c.query('SELECT cost_q FROM fresh.open_lots WHERE acquired_event_id=$1',[incoming.id])).rows[0].cost_q,null);
 assert.equal(await canAppendFreshIsolatedIncoming(c,[incoming],[d],[scope]),false,'existing target position prevents shortcut');
 await c.query('SAVEPOINT isolated_guards');await c.query('DELETE FROM fresh.positions WHERE scope_id=$1 AND token_address=$2',[scope,newToken]);await c.query('DELETE FROM fresh.scope_event_results WHERE scope_id=$1 AND token_address=$2',[scope,newToken]);
 assert.equal(await canAppendFreshIsolatedIncoming(c,[incoming],[d],[scope]),false,'orphan retained lot prevents shortcut');await c.query('ROLLBACK TO SAVEPOINT isolated_guards');
 await c.query('DELETE FROM fresh.positions WHERE scope_id=$1 AND token_address=$2',[scope,newToken]);await c.query('DELETE FROM fresh.open_lots WHERE scope_id=$1 AND token_address=$2',[scope,newToken]);assert.equal(await canAppendFreshIsolatedIncoming(c,[incoming],[d],[scope]),false,'retained event result prevents shortcut');await c.query('ROLLBACK TO SAVEPOINT isolated_guards');
 const otherToken=address(),externalIncoming={...incoming,id:incoming.id+':other',executionKey:incoming.executionKey+':other',tokenAddress:otherToken},otherD=decoded(externalIncoming);
 await c.query('UPDATE fresh.accounting_scopes SET wallet_addresses=$2 WHERE id=$1',[scope,[wallet,external]]);assert.equal(await canAppendFreshIsolatedIncoming(c,[externalIncoming],[otherD],[scope]),false,'internal counterparties retain ordinary pairing');await c.query('ROLLBACK TO SAVEPOINT isolated_guards');
 const older=event({tokenAddress:newToken,kind:'transfer_in',quantity:'2',amountUsd:null,feeUsd:'0',counterparty:external,transferKey:'older:'+wallet,blockNumber:'105',occurredAt:new Date(now.getTime()-240000).toISOString()});
 await persistFreshDecodedReceipt(c,decoded(older),now);
 assert.equal((await c.query('SELECT balance_status FROM fresh.positions WHERE scope_id=$1 AND token_address=$2',[scope,bibi])).rows[0].balance_status,'pending','same-token late history must still use the existing rebuild');
 assert.ok(BigInt((await c.query('SELECT correction_epoch FROM fresh.accounting_scopes WHERE id=$1',[scope])).rows[0].correction_epoch)>BigInt(preserved.epoch));
 assert.equal((await c.query('SELECT quantity_q FROM fresh.positions WHERE scope_id=$1 AND token_address=$2',[scope,newToken])).rows[0].quantity_q,'3');
 console.log(JSON.stringify({passed:true,checks:13,fixturesRolledBack:true,nodeCalls:0,providerCalls:0,unrelatedBibiExact:true,newCostUnknown:true,sameTokenLateStillRebuilds:true}));
}finally{await c.query('ROLLBACK');c.release();await db.end();}
