/** All fixtures, including additive DDL, are rolled back. No RPC/provider work. */
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {Pool} from 'pg';
import {applyFreshFinancialEvents,freshDecimal,rebuildFreshScopesAfterReorg,rolloverFreshUtcDay} from './accounting.js';
import {advanceFreshRollingKolTotals,refreshFreshRollingKolTotals,rebuildFreshRollingKolTotals} from './rolling.js';
import {freshStoredKolRollingMetrics} from './leaderboard.js';
import {freshRollingSchemaSql} from './rollingSchema.js';
import type {FreshFinancialEvent} from '../../shared/freshAccounting.js';
const url=new URL(process.env.DATABASE_URL??'');
if(!['localhost','127.0.0.1'].includes(url.hostname)||url.port!=='5436'||url.pathname!=='/kollens_fresh_20261022_24h')throw Error('isolated_local_fresh_only');
const db=new Pool({connectionString:url.href,max:1}),c=await db.connect(),wallet='0x'+randomBytes(20).toString('hex'),privateWallet='0x'+randomBytes(20).toString('hex'),token='0x'+randomBytes(20).toString('hex'),token2='0x'+randomBytes(20).toString('hex'),scope='kol:'+wallet;
const now='2026-10-24T12:00:00.000Z';let sequence=0,checks=0;
function event(overrides:Partial<FreshFinancialEvent>={}):FreshFinancialEvent{const n=++sequence;return{id:`rolling:${wallet}:${n}`,executionKey:`rolling:${wallet}:${n}`,walletAddress:wallet,tokenAddress:token,kind:'buy',quantity:'10',amountUsd:'100',feeUsd:'1',feeKey:`fee:${wallet}:${n}`,counterparty:null,transferKey:null,blockNumber:String(100+n),blockHash:'0x'+n.toString(16).padStart(64,'0'),transactionHash:'0x'+n.toString(16).padStart(64,'0'),transactionIndex:0,executionIndex:0,logIndex:0,occurredAt:'2026-10-24T01:00:00Z',canonical:true,...overrides};}
const row=async()=>(await c.query('SELECT * FROM fresh.kols WHERE wallet_address=$1',[wallet])).rows[0];
try{
 await c.query('BEGIN');await c.query('SELECT pg_advisory_xact_lock(73621941)');await c.query(freshRollingSchemaSql);
 await c.query('INSERT INTO fresh.wallets(address,monitoring_from_block) VALUES($1,1),($2,1)',[wallet,privateWallet]);
 await c.query("INSERT INTO fresh.kols(wallet_address,display_name) VALUES($1,'Rolling fixture')",[wallet]);
 await c.query("INSERT INTO fresh.tokens(address,launch_status) VALUES($1,'eligible'),($2,'eligible')",[token,token2]);
 await c.query("INSERT INTO fresh.accounting_scopes(id,kind,wallet_addresses,starts_at,starts_block) VALUES($1,'kol',$2,'2026-10-20T00:00:00Z',1),($3,'portfolio_wallet',$4,'2026-10-20T00:00:00Z',1)",[scope,[wallet],`private:${wallet}`,[privateWallet]]);
 const oldBuy=event({occurredAt:'2026-10-22T23:59:00Z'}),yesterdaySale=event({kind:'sell',quantity:'5',amountUsd:'80',feeUsd:'2',occurredAt:'2026-10-23T23:00:00Z'}),todaySale=event({kind:'sell',quantity:'5',amountUsd:'70',feeUsd:'1',occurredAt:'2026-10-24T01:00:00Z'});
 await applyFreshFinancialEvents(c,[oldBuy,yesterdaySale,todaySale],{now});let k=await row();
 assert.equal(freshDecimal(k.rolling_realized_q),'46');assert.equal(freshDecimal(k.today_realized_q),'18.5');assert.equal(k.rolling_trade_count,2);assert.equal(k.rolling_token_count,1);checks+=4;
 assert.equal(new Date(k.rolling_next_expiry_at).toISOString(),'2026-10-24T23:00:00.000Z');checks++;
 const after=JSON.stringify(k);assert.deepEqual(await applyFreshFinancialEvents(c,[oldBuy,yesterdaySale,todaySale],{now}),{inserted:0,applied:0});assert.equal(JSON.stringify(await row()),after);checks+=2;
 await applyFreshFinancialEvents(c,[todaySale],{now:'2026-10-24T12:00:01Z'});assert.equal(JSON.stringify(await row()),after,'Duplicate work before an expiry must not rewrite current state');checks++;
 await rolloverFreshUtcDay(c,'2026-10-25T00:00:00Z');await advanceFreshRollingKolTotals(c,wallet,'2026-10-25T00:00:00Z');k=await row();
 assert.equal(k.today_trade_count,0);assert.equal(k.rolling_trade_count,1);assert.equal(freshDecimal(k.rolling_realized_q),'18.5');checks+=3;
 await advanceFreshRollingKolTotals(c,wallet,'2026-10-25T01:00:00Z');k=await row();assert.equal(k.rolling_realized_q,'0');assert.equal(k.rolling_token_count,0);assert.equal(k.rolling_trade_count,0);assert.equal(k.rolling_next_expiry_at,null);checks+=4;
 // Controlled rewind is an explicit projection rebuild, never a data reset.
 await rebuildFreshRollingKolTotals(c,wallet,now);
 const unknown=event({tokenAddress:token2,kind:'sell',quantity:'1',amountUsd:'5',feeUsd:'0',feeKey:null,occurredAt:'2026-10-24T02:00:00Z'});
 await applyFreshFinancialEvents(c,[unknown],{now});k=await row();assert.equal(k.rolling_realized_q,null);assert.equal(k.rolling_unknown_count,1);assert.equal(k.rolling_token_count,2);checks+=3;
 await c.query('UPDATE fresh.financial_events SET canonical=false WHERE id=$1',[unknown.id]);await rebuildFreshScopesAfterReorg(c,[scope],now);k=await row();assert.equal(freshDecimal(k.rolling_realized_q),'46');assert.equal(k.rolling_unknown_count,0);assert.equal(k.rolling_token_count,1);checks+=3;
 const late=event({tokenAddress:token2,kind:'buy',quantity:'1',amountUsd:'3',feeUsd:'0',feeKey:null,occurredAt:'2026-10-23T14:00:00Z'});await applyFreshFinancialEvents(c,[late],{now});k=await row();assert.equal(k.rolling_token_count,2);assert.equal(k.rolling_trade_count,3);checks+=2;
 const future=event({tokenAddress:token2,kind:'sell',quantity:'1',amountUsd:'6',feeUsd:'0',feeKey:null,occurredAt:'2026-10-24T12:00:05Z'});await applyFreshFinancialEvents(c,[future],{now});k=await row();assert.equal(k.rolling_trade_count,3);assert.equal(new Date(k.rolling_next_expiry_at).toISOString(),new Date(future.occurredAt).toISOString());checks+=2;
 await advanceFreshRollingKolTotals(c,wallet,future.occurredAt);k=await row();assert.equal(k.rolling_trade_count,4);assert.equal(freshDecimal(k.rolling_realized_q),'49');checks+=2;
 const privateEvent=event({walletAddress:privateWallet,tokenAddress:token2,kind:'buy',occurredAt:'2026-10-24T12:00:06Z'});await applyFreshFinancialEvents(c,[privateEvent],{now:'2026-10-24T12:00:06Z'});assert.equal((await row()).rolling_trade_count,4);checks++;
 const unallocated=event({kind:'fee',tokenAddress:null,quantity:'0',amountUsd:null,feeUsd:'7',feeAttribution:{status:'unattributed',nativeFeeWei:'123'},occurredAt:'2026-10-24T12:00:06Z'});await applyFreshFinancialEvents(c,[unallocated],{now:'2026-10-24T12:00:06Z'});k=await row();assert.equal(k.rolling_unallocated_fee_count,1);assert.equal(k.rolling_unallocated_fee_q,'7');assert.equal(freshDecimal(k.rolling_realized_q),'49');checks+=3;
 // Bootstrap and idle expiration run in a bounded maintenance pass.
 await c.query('UPDATE fresh.kols SET rolling_as_of=NULL,rolling_next_expiry_at=NULL WHERE wallet_address=$1',[wallet]);const maintenance=await refreshFreshRollingKolTotals(c,{now:'2026-10-24T12:00:06Z',limit:256});assert.ok(maintenance.updated>0);k=await row();assert.equal(freshDecimal(k.rolling_realized_q),'49');assert.equal(k.rolling_unallocated_fee_count,1);checks+=3;
 // Make the saved projection disagree with the canonical sell that is about to expire.
 const otherWallet='0x'+randomBytes(20).toString('hex');
 await c.query('INSERT INTO fresh.wallets(address,monitoring_from_block) VALUES($1,1)',[otherWallet]);
 await c.query("INSERT INTO fresh.kols(wallet_address,display_name) VALUES($1,'Independent rolling fixture')",[otherWallet]);
 await c.query("INSERT INTO fresh.accounting_scopes(id,kind,wallet_addresses,starts_at,starts_block) VALUES($1,'kol',$2,'2026-10-20T00:00:00Z',1)",['kol:'+otherWallet,[otherWallet]]);
 await c.query('UPDATE fresh.kols SET rolling_trade_count=0,rolling_sell_count=0 WHERE wallet_address=$1',[wallet]);
 const correctionAt='2026-10-24T23:00:00Z';
 const newBuy=event({occurredAt:correctionAt}),otherBuy=event({walletAddress:otherWallet,occurredAt:correctionAt});
 const otherGas=event({kind:'fee',tokenAddress:null,quantity:'0',amountUsd:null,feeUsd:'4',feeAttribution:{status:'unattributed',nativeFeeWei:'1'},occurredAt:correctionAt});
 assert.deepEqual(await applyFreshFinancialEvents(c,[newBuy,otherBuy,otherGas],{now:correctionAt}),{inserted:3,applied:2});
 k=await row();
 assert.equal(k.rolling_trade_count,3);
 assert.equal(k.rolling_sell_count,2);
 assert.equal(k.rolling_unallocated_fee_count,2);
 assert.equal(k.rolling_unallocated_fee_q,'11');
 assert.equal((await c.query('SELECT rolling_trade_count FROM fresh.kols WHERE wallet_address=$1',[otherWallet])).rows[0].rolling_trade_count,1);
 assert.deepEqual(await applyFreshFinancialEvents(c,[newBuy,otherBuy,otherGas],{now:correctionAt}),{inserted:0,applied:0});
 assert.equal((await row()).rolling_unallocated_fee_q,'11');checks+=8;

 // Exercise a real PostgreSQL transaction error during projection rebuild.
 await c.query(`
   CREATE FUNCTION pg_temp.fail_rolling_rebuild() RETURNS trigger LANGUAGE plpgsql AS $$
   BEGIN
     IF NEW.wallet_address = TG_ARGV[0] AND NEW.rolling_as_of IS NOT NULL
       AND NEW.rolling_as_of IS DISTINCT FROM OLD.rolling_as_of THEN
       RAISE EXCEPTION 'canceling statement due to statement timeout' USING ERRCODE='57014';
     END IF;
     RETURN NEW;
   END $$;
   CREATE TRIGGER rolling_fixture_timeout BEFORE UPDATE ON fresh.kols
     FOR EACH ROW EXECUTE FUNCTION pg_temp.fail_rolling_rebuild('${wallet}');
 `);
 await c.query('UPDATE fresh.kols SET rolling_trade_count=0,rolling_sell_count=0 WHERE wallet_address=$1',[wallet]);
 const expiryAt='2026-10-25T01:00:00Z';
 const timedOutBuy=event({occurredAt:expiryAt}), independentBuy=event({walletAddress:otherWallet,occurredAt:expiryAt});
 const timedOutGas=event({kind:'fee',tokenAddress:null,quantity:'0',amountUsd:null,feeUsd:'3',feeAttribution:{status:'excluded',nativeFeeWei:'1'},occurredAt:expiryAt});
 assert.deepEqual(await applyFreshFinancialEvents(c,[timedOutBuy,independentBuy,timedOutGas],{now:expiryAt}),{inserted:3,applied:2});
 k=await row();
 assert.equal(k.rolling_as_of,null);
 assert.equal(new Date(k.rolling_next_expiry_at).toISOString(),'2026-10-25T01:00:05.000Z');
 assert.deepEqual(freshStoredKolRollingMetrics(k,Date.parse(expiryAt)).reasons,['rolling_totals_pending']);
 assert.equal(freshStoredKolRollingMetrics(k,Date.parse(expiryAt)).realizedProfitUsd,null);
 assert.equal((await c.query('SELECT rolling_trade_count FROM fresh.kols WHERE wallet_address=$1',[otherWallet])).rows[0].rolling_trade_count,2);
 assert.equal((await c.query('SELECT unallocated_fee_q FROM fresh.accounting_scopes WHERE id=$1',[scope])).rows[0].unallocated_fee_q,'14');
 assert.equal(await advanceFreshRollingKolTotals(c,wallet,'2026-10-25T01:00:04Z'),null);
 await c.query('DROP TRIGGER rolling_fixture_timeout ON fresh.kols');
 await refreshFreshRollingKolTotals(c,{now:'2026-10-25T01:00:05Z',limit:256});
 k=await row();
 assert.equal(k.rolling_trade_count,3);
 assert.equal(k.rolling_sell_count,1);
 assert.equal(k.rolling_unallocated_fee_count,3);
 assert.equal(k.rolling_unallocated_fee_q,'14');checks+=12;

 const immutable=(await c.query('SELECT id,quantity,amount_usd,fee_usd,canonical FROM fresh.financial_events WHERE wallet_address=$1 ORDER BY id',[wallet])).rows;
 await advanceFreshRollingKolTotals(c,wallet,'2026-10-26T12:00:06Z');k=await row();assert.equal(k.rolling_realized_q,'0');assert.equal(k.rolling_trade_count,0);assert.equal(k.rolling_unallocated_fee_count,0);assert.deepEqual((await c.query('SELECT id,quantity,amount_usd,fee_usd,canonical FROM fresh.financial_events WHERE wallet_address=$1 ORDER BY id',[wallet])).rows,immutable);checks+=4;
 console.log(JSON.stringify({ok:true,checks,fixtureWrites:'rolled_back',nodeRequests:0,financialProviderRequests:0}));
}finally{await c.query('ROLLBACK');c.release();await db.end();}
