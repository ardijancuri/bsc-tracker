import assert from 'node:assert/strict';
import { ensureSchema,pool } from './db.js';
import { persistNodeExecutions,type NodeExecution } from './nodeExecution.js';
import { captureNodeTraceBatch,nodeExecutionNeedsTrace } from './nodeTrace.js';
const connection=new URL(process.env.DATABASE_URL??'');if(!['127.0.0.1','localhost'].includes(connection.hostname)||connection.port!=='5435'||!/^\/bscan_node_trace_test_\d+$/.test(connection.pathname))throw Error('Disposable local trace database only');
const wallet=`0x${'a'.repeat(40)}`,router=`0x${'b'.repeat(40)}`,token=`0x${'c'.repeat(40)}`,wbnb='0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c';const hash=(n:number)=>`0x${n.toString(16).padStart(64,'0')}`;
const logs=[{address:router,topics:['0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822'],data:'0x'}],now=Date.now();
const execution=(n:number):NodeExecution=>({id:`execution-${n}`,txHash:hash(n),walletAddress:wallet,executionIndex:0,operationHash:null,blockNumber:100+n,blockHash:hash(100+n),transactionIndex:0,timestamp:Math.floor(now/1000),kind:'transaction',status:'success',nativeValueRaw:'100',transactionTo:router,logs,flows:[{tokenAddress:token,deltaRaw:'10',logIndices:[1],counterparties:[router]}],feeNativeWei:'1',feeComplete:true,feeReason:null});
async function seed(n:number){const e=execution(n);await pool.query(`INSERT INTO node_evidence_blocks(block_number,block_hash,parent_hash,timestamp,header)VALUES($1,$2,$3,now(),'{}')`,[e.blockNumber,e.blockHash,hash(e.blockNumber-1)]);await pool.query(`INSERT INTO node_evidence_transactions(tx_hash,block_number,block_hash,transaction_index,timestamp,transaction,receipt)VALUES($1,$2,$3,0,now(),$4::jsonb,'{"status":"0x1"}')`,[e.txHash,e.blockNumber,e.blockHash,JSON.stringify({from:wallet,to:router,value:'0x64'})]);await persistNodeExecutions(pool,[e]);return e;}
const trace={type:'CALL',from:wallet,to:router,value:'0x64',calls:[{type:'CALL',from:router,to:wallet,value:'0x19'}]};
try{await ensureSchema();
 assert.equal(nodeExecutionNeedsTrace({...execution(1),flows:[]}),false);
 assert.equal(nodeExecutionNeedsTrace({...execution(1),kind:'user_operation'}),false);
 assert.equal(nodeExecutionNeedsTrace({...execution(1),flows:[...execution(1).flows,{tokenAddress:wbnb,deltaRaw:'-100',logIndices:[],counterparties:[]}]}),false);
 const first=await seed(1);await persistNodeExecutions(pool,[first]);assert.equal((await pool.query('SELECT count(*)::int AS n FROM node_trace_jobs')).rows[0].n,1,'duplicate decoding coalesces the durable job');
 await pool.query("INSERT INTO kols(address,display_name,is_tracked)VALUES($1,'Trace fixture',true)",[wallet]);
 await pool.query(`INSERT INTO node_accounting_history(scope_key,wallet_address,token_address,history_revision,source,payload)VALUES('public',$1,$2,'old','node','{}')`,[wallet,token]);
 await pool.query(`INSERT INTO node_accounting_snapshots(scope_key,wallet_address,token_address,snapshot_id,history_revision,as_of,complete,payload,summary,last_valid)VALUES('public',$1,$2,'old','old',now(),true,'{}','{}','{}')`,[wallet,token]);
 await pool.query(`INSERT INTO node_accounting_snapshot_versions(scope_key,wallet_address,token_address,snapshot_id,payload,as_of)VALUES('public',$1,$2,'old','{}',now())`,[wallet,token]);
 await pool.query(`INSERT INTO leaderboard_snapshots(wallet_address,period,node_accounting)VALUES($1,'1d','{"old":true}'),($1,'7d','{"retained":true}')`,[wallet]);
 let enter!:()=>void,resume!:()=>void;const entered=new Promise<void>(r=>enter=r),released=new Promise<void>(r=>resume=r);let calls=0;
 const firstRun=captureNodeTraceBatch(pool,{limit:1,trace:async()=>{calls++;assert.equal((await pool.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND state='idle in transaction'")).rows[0].n,0,'no transaction spans the node call');enter();await released;return trace;}});
 await entered;const joining=await captureNodeTraceBatch(pool,{trace:async()=>{throw Error('duplicate trace');}});assert.equal(joining.busy,true);
 const claimed=(await pool.query('SELECT extract(epoch FROM lease_until-now())::float AS remaining FROM node_trace_jobs WHERE tx_hash=$1',[first.txHash])).rows[0];
 assert.ok(claimed.remaining>0&&claimed.remaining<=10,'A crashed trace worker leaves at most ten seconds of unusable lease time');
 await pool.query("UPDATE node_trace_jobs SET lease_until=now()+interval '5 seconds' WHERE tx_hash=$1",[first.txHash]);
 await new Promise(resolve=>setTimeout(resolve,2300));
 assert.ok((await pool.query('SELECT extract(epoch FROM lease_until-now())::float AS remaining FROM node_trace_jobs WHERE tx_hash=$1',[first.txHash])).rows[0].remaining>5,
   'A live bounded trace renews its lease without holding a database transaction during RPC');
 resume();assert.equal((await firstRun).captured,1);assert.equal(calls,1);
 assert.equal((await pool.query('SELECT state FROM node_trace_jobs')).rows[0].state,'done');assert.equal((await pool.query('SELECT count(*)::int AS n FROM node_trace_evidence')).rows[0].n,1);
 const snapshot=(await pool.query('SELECT invalidated_at,last_valid FROM node_accounting_snapshots')).rows[0];assert.ok(snapshot.invalidated_at);assert.equal(snapshot.last_valid,null,'new financial evidence invalidates the old dated amount');
 assert.ok((await pool.query('SELECT invalidated_at FROM node_accounting_history')).rows[0].invalidated_at);assert.ok((await pool.query('SELECT invalidated_at FROM node_accounting_snapshot_versions')).rows[0].invalidated_at);
 assert.equal((await pool.query("SELECT node_accounting FROM leaderboard_snapshots WHERE period='1d'")).rows[0].node_accounting,null,'A trace correction immediately revokes an already published realized-profit ranking');
 assert.deepEqual((await pool.query("SELECT node_accounting FROM leaderboard_snapshots WHERE period='7d'")).rows[0].node_accounting,{retained:true});
 await pool.query("UPDATE leaderboard_snapshots SET node_accounting='{\"unchanged\":true}' WHERE period='1d'");
 await pool.query("UPDATE node_trace_jobs SET state='pending',next_attempt_at=now(),completed_at=NULL WHERE tx_hash=$1",[first.txHash]);
 assert.equal((await captureNodeTraceBatch(pool,{limit:1,trace:async()=>trace})).captured,1);
 assert.deepEqual((await pool.query("SELECT node_accounting FROM leaderboard_snapshots WHERE period='1d'")).rows[0].node_accounting,{unchanged:true},'Rechecking identical trace evidence leaves a still-valid period result intact');
 const retry=await seed(2);assert.equal((await captureNodeTraceBatch(pool,{limit:1,trace:async()=>{throw Error('node_trace_timeout');}})).unavailable,1);
 const job=(await pool.query('SELECT attempts,lease_id,next_attempt_at,last_error FROM node_trace_jobs WHERE tx_hash=$1',[retry.txHash])).rows[0];assert.equal(job.attempts,1);assert.equal(job.lease_id,null);assert.equal(job.last_error,'node_trace_timeout');assert.ok(job.next_attempt_at.getTime()>Date.now());
 assert.equal((await captureNodeTraceBatch(pool,{trace:async()=>{throw Error('hot retry');}})).unavailable,0,'a restart honors stored backoff');
 await pool.query("UPDATE node_trace_jobs SET attempts=5,next_attempt_at=now() WHERE tx_hash=$1",[retry.txHash]);
 await captureNodeTraceBatch(pool,{limit:1,trace:async()=>{throw Error('node_trace_state_unavailable');}});assert.equal((await pool.query('SELECT state FROM node_trace_jobs WHERE tx_hash=$1',[retry.txHash])).rows[0].state,'unavailable');
 const orphan=await seed(3);await captureNodeTraceBatch(pool,{limit:1,trace:async()=>{await pool.query('UPDATE node_evidence_blocks SET block_hash=$2 WHERE block_number=$1',[orphan.blockNumber,hash(999)]);return trace;}});
 assert.equal((await pool.query('SELECT count(*)::int AS n FROM node_trace_evidence WHERE tx_hash=$1',[orphan.txHash])).rows[0].n,0,'a canonical change during the call cannot publish a trace');
 const mismatch=await seed(4);await captureNodeTraceBatch(pool,{limit:1,trace:async()=>({...trace,from:router})});assert.equal((await pool.query('SELECT last_error FROM node_trace_jobs WHERE tx_hash=$1',[mismatch.txHash])).rows[0].last_error,'node_trace_root_mismatch');
 const expired=await seed(5);let expiredEntered!:()=>void,expiredResume!:()=>void;
 const expiryReady=new Promise<void>(resolve=>expiredEntered=resolve),expiryRelease=new Promise<void>(resolve=>expiredResume=resolve);
 const expiryRun=captureNodeTraceBatch(pool,{limit:1,trace:async()=>{expiredEntered();await expiryRelease;return trace;}});await expiryReady;
 const expiryLock=await pool.connect();
 try{
  await expiryLock.query('BEGIN');
  await expiryLock.query("UPDATE node_trace_jobs SET lease_until=clock_timestamp()+interval '500 milliseconds' WHERE tx_hash=$1",[expired.txHash]);
  // The heartbeat starts while the committed old lease is still valid, then
  // waits on this row until the newly committed deadline has really expired.
  await new Promise(resolve=>setTimeout(resolve,2300));
  let queued=false;
  for(let attempt=0;attempt<10&&!queued;attempt++){
   queued=(await pool.query(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
     AND wait_event_type='Lock' AND query LIKE 'UPDATE node_trace_jobs SET lease_until=%') AS queued`)).rows[0].queued;
   if(!queued)await new Promise(resolve=>setTimeout(resolve,100));
  }
  assert.equal(queued,true,'The regression observes a heartbeat waiting behind the locked expiry update');
  await expiryLock.query('COMMIT');
 }finally{await expiryLock.query('ROLLBACK');expiryLock.release();}
 await new Promise(resolve=>setTimeout(resolve,100));
 assert.equal((await pool.query('SELECT lease_until>now() AS active FROM node_trace_jobs WHERE tx_hash=$1',[expired.txHash])).rows[0].active,false,
   'A heartbeat cannot revive an already expired trace lease');
 expiredResume();assert.equal((await expiryRun).captured,0);
 assert.equal((await pool.query('SELECT count(*)::int n FROM node_trace_evidence WHERE tx_hash=$1',[expired.txHash])).rows[0].n,0,'A late trace cannot publish after losing its lease');
 await pool.query('DELETE FROM node_evidence_transactions WHERE tx_hash=$1',[retry.txHash]);assert.equal((await pool.query('SELECT count(*)::int AS n FROM node_trace_jobs WHERE tx_hash=$1',[retry.txHash])).rows[0].n,0,'orphan evidence deletion removes its durable job');
 console.log('Private trace PostgreSQL integration passed: bounded candidates, duplicate decoding, global concurrency, leases, retry, root/canonical proof, correction invalidation and reorg deletion.');
}finally{await pool.end()}
