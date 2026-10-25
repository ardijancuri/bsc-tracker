/** Permanent compact observations, promotion and real reorg handler. Every
 * fixture relation is session-temporary and the transaction rolls back. */
import assert from'node:assert/strict';
import pg from'pg';
import{freshPendingGangTrade,persistFreshPendingTrades,removeFreshResolvedPendingTrades,freshPendingTradesSchemaSql}from'./pendingTrades.js';
import{pendingGangFixture,pendingHash}from'./fixtures/pendingGangTradeFixture.js';
import{freshTokenAdmissionDigest}from'./tracking.js';
import{encodeFreshEvidence}from'./capture.js';
import{rollbackFreshToAncestor}from'./decode.js';
const url=new URL(process.env.DATABASE_URL??'');if(!['localhost','127.0.0.1'].includes(url.hostname)||url.port!=='5436'||url.pathname!=='/kollens_fresh_20261022_24h')throw Error('pending_trade_fixture_local_only');
const pool=new pg.Pool({connectionString:url.href,max:1}),client=await pool.connect(),rewrite=(sql:string)=>sql.replaceAll('fresh.','pg_temp.');
const db={query:(sql:string,values?:unknown[])=>client.query(rewrite(sql),values)}as unknown as pg.PoolClient,checks:string[]=[];
try{
 await client.query('BEGIN');await client.query("SET LOCAL statement_timeout='5s'");await client.query('SELECT pg_advisory_xact_lock(73621941)');
 for(const table of['wallets','kols','tokens','markets','accounting_scopes','financial_events','scope_event_results','positions','open_lots','launch_facts','recent_blocks','recent_evidence','checkpoints','jobs'])
  await client.query(`CREATE TEMP TABLE ${table}(LIKE fresh.${table} INCLUDING ALL) ON COMMIT DROP`);
 await client.query(rewrite(freshPendingTradesSchemaSql));
 const f=pendingGangFixture();if(f.admission.kind!=='preexisting')throw Error('fixture_admission');f.admission.admissionDigest=freshTokenAdmissionDigest(f.admission.permission);
 const permission=f.admission.permission,at=new Date(f.block.timestamp),now=new Date(at.getTime()+1000),scope='kol:'+f.wallet;
 await db.query("INSERT INTO fresh.checkpoints(key,block_number,block_hash,value) VALUES('start',$1,$2,$3),('capture',$4,$5,$3),('decode',$4,$5,$3)",
  [permission.startBlock,permission.startHash,{startBlock:permission.startBlock,startHash:permission.startHash,startTime:permission.startTime},f.block.number,f.block.hash]);
 await db.query('INSERT INTO fresh.checkpoints(key,value) VALUES($1,$2)',['token_admission:'+permission.tokenAddress,permission]);
 await db.query('INSERT INTO fresh.wallets(address,monitoring_from_block) VALUES($1,1001)',[f.wallet]);await db.query('INSERT INTO fresh.kols(wallet_address) VALUES($1)',[f.wallet]);
 await db.query("INSERT INTO fresh.accounting_scopes(id,kind,wallet_addresses,starts_at,starts_block) VALUES($1,'kol',$2,$3,1001)",[scope,[f.wallet],permission.startTime]);
 for(const number of[1001,1002])await db.query('INSERT INTO fresh.recent_blocks(block_number,block_hash,parent_hash,occurred_at) VALUES($1,$2,$3,$4)',[number,pendingHash(number),pendingHash(number-1),new Date(at.getTime()+(number-1002)*1000)]);
 await db.query(`INSERT INTO fresh.recent_evidence(tx_hash,block_hash,block_number,transaction_index,payload,wallet_addresses,decoder_status,expires_at)
  VALUES($1,$2,1002,0,$3,$4,'repair',$5)`,[f.entry.transaction.hash,f.block.hash,encodeFreshEvidence(f.entry),[f.wallet],new Date(now.getTime()+72*3600_000)]);
 const p=freshPendingGangTrade(f.entry,f.block,f.admission)!;assert.ok(p);
 await persistFreshPendingTrades(db,[p],now);await persistFreshPendingTrades(db,[p],now);
 assert.equal((await db.query('SELECT count(*)::int n FROM fresh.pending_trades')).rows[0].n,1);
 assert.deepEqual((await db.query('SELECT native_fee_wei,fee_key FROM fresh.pending_trades WHERE id=$1',[p.id])).rows[0],{native_fee_wei:p.nativeFeeWei,fee_key:p.feeKey});
 await db.query('UPDATE fresh.pending_trades SET native_fee_wei=NULL,fee_key=NULL WHERE id=$1',[p.id]);await persistFreshPendingTrades(db,[p],now);
 assert.deepEqual((await db.query('SELECT native_fee_wei,fee_key FROM fresh.pending_trades WHERE id=$1',[p.id])).rows[0],{native_fee_wei:p.nativeFeeWei,fee_key:p.feeKey});
 let visible=(await db.query('SELECT * FROM fresh.visible_trades')).rows;assert.equal(visible.length,1);assert.equal(visible[0].quantity,null);assert.equal(visible[0].amount_usd,null);assert.equal(visible[0].raw_quantity,p.rawQuantity);assert.equal(visible[0].accounting_status,'pending_precision');
 assert.equal((await db.query('SELECT launch_status,decimals FROM fresh.tokens WHERE address=$1',[p.tokenAddress])).rows[0].launch_status,'preexisting');
 assert.equal((await db.query('SELECT count(*)::int n FROM fresh.financial_events')).rows[0].n,0);assert.equal((await db.query('SELECT count(*)::int n FROM fresh.positions')).rows[0].n,0);
 checks.push('idempotent raw-only observation; null quantity/USD; truthful token status; no FIFO or financial fact writes');
 await client.query('SAVEPOINT expiry');await db.query('DELETE FROM fresh.recent_evidence');assert.equal((await db.query('SELECT count(*)::int n FROM fresh.visible_trades')).rows[0].n,1);await client.query('ROLLBACK TO SAVEPOINT expiry');
 checks.push('compact trade remains visible after temporary receipt expiry');
 await client.query('SAVEPOINT revoked');await db.query("UPDATE fresh.checkpoints SET value=jsonb_set(value,'{active}','false') WHERE key=$1",['token_admission:'+p.tokenAddress]);
 await assert.rejects(persistFreshPendingTrades(db,[p],now),/pending_trade_admission_changed/);await client.query('ROLLBACK TO SAVEPOINT revoked');
 await assert.rejects(persistFreshPendingTrades(db,[{...p,rawQuantity:'1'}],now),/pending_trade_context_changed/);
 await assert.rejects(persistFreshPendingTrades(db,[{...p,nativeFeeWei:'1'}],now),/pending_trade_context_changed/);
 await client.query('SAVEPOINT changed_fee');await db.query("UPDATE fresh.pending_trades SET native_fee_wei='1' WHERE id=$1",[p.id]);
 await assert.rejects(persistFreshPendingTrades(db,[p],now),/pending_trade_conflict/);await client.query('ROLLBACK TO SAVEPOINT changed_fee');
 checks.push('revoked permission and changed raw facts rejected under current locked context');
 await client.query('SAVEPOINT reorg');const epoch=(await db.query('SELECT correction_epoch FROM fresh.accounting_scopes WHERE id=$1',[scope])).rows[0].correction_epoch;
 const result=await rollbackFreshToAncestor(db,{blockNumber:1001,blockHash:pendingHash(1001)},now);assert.equal(result.scopes,1);
 const orphan=(await db.query('SELECT * FROM fresh.pending_trades WHERE id=$1',[p.id])).rows[0];assert.equal(orphan.canonical,false);assert.equal(orphan.raw_quantity,p.rawQuantity);
 assert.equal(BigInt((await db.query('SELECT correction_epoch FROM fresh.accounting_scopes WHERE id=$1',[scope])).rows[0].correction_epoch),BigInt(epoch)+1n);
 assert.equal((await db.query('SELECT count(*)::int n FROM fresh.visible_trades WHERE canonical')).rows[0].n,0);await client.query('ROLLBACK TO SAVEPOINT reorg');
 checks.push('actual reorg handler retains orphan raw observation, suppresses visibility and advances pending-only book correction epoch');
 await db.query(`INSERT INTO fresh.financial_events(id,execution_key,wallet_address,token_address,kind,quantity,amount_usd,fee_usd,block_number,block_hash,transaction_hash,
  transaction_index,execution_index,log_index,occurred_at) VALUES($1,$2,$3,$4,$5,'1',NULL,'0',$6,$7,$8,$9,$10,$11,$12)`,
  [p.id,p.executionKey,p.walletAddress,p.tokenAddress,p.kind,p.blockNumber,p.blockHash,p.transactionHash,p.transactionIndex,p.executionIndex,p.logIndex,p.occurredAt]);
 visible=(await db.query('SELECT * FROM fresh.visible_trades WHERE canonical')).rows;assert.equal(visible.length,1);assert.equal(visible[0].id,p.id);assert.equal(visible[0].quantity,'1');assert.equal(visible[0].accounting_status,'pending_settlement');
 await removeFreshResolvedPendingTrades(db,[p.id]);assert.equal((await db.query('SELECT count(*)::int n FROM fresh.pending_trades')).rows[0].n,0);assert.equal((await db.query('SELECT count(*)::int n FROM fresh.visible_trades WHERE canonical')).rows[0].n,1);
 checks.push('same-execution promotion deduplicates before cleanup and atomically removes the temporary pending copy');
 await client.query('ROLLBACK');console.log(JSON.stringify({passed:true,checks,persistentRowsWritten:0,fixtureWrites:'temporary tables and rolled back',databasesCreated:0,databasesDeleted:0,nodeCalls:0,providerCalls:0,realMessages:0}));
}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();await pool.end();}
