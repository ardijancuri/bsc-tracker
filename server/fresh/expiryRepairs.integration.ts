/** Temporary-table, rolled-back checks; never starts a worker or alters an app book. */
import assert from'node:assert/strict';
import{createHash}from'node:crypto';
import{Pool,type PoolClient}from'pg';
import{expireFreshEvidenceInTransaction}from'./capture.js';
const url=new URL(process.env.DATABASE_URL??'');
if(!['127.0.0.1','localhost'].includes(url.hostname)||url.port!=='5436'||!/^\/(?:kollens_fresh_|kollens_pnl_repair_)/.test(url.pathname))throw Error('isolated_local_database_required');
const db=new Pool({connectionString:url.toString(),max:1}),c=await db.connect(),now=new Date('2020-01-04T00:00:00Z'),wallet='0x'+'11'.repeat(20),hash=(n:number)=>'0x'+n.toString(16).padStart(64,'0');
let writes=0;
const q={query:async(sql:string,args?:unknown[])=>{if(/fresh\.(?:financial_events|positions|open_lots|scope_event_results|kols)/.test(sql)||/\b(?:INSERT INTO|UPDATE|DELETE FROM)\s+fresh\.accounting_scopes/i.test(sql))throw Error('financial_or_account_mutation_forbidden');
 if(/^(?:INSERT|UPDATE|DELETE)/i.test(sql.trim()))writes++;return c.query(sql.replaceAll('fresh.','pg_temp.'),args);}}as PoolClient;
try{await c.query('BEGIN');
 for(const table of['recent_blocks','recent_evidence','wallets','jobs','checkpoints','accounting_scopes'])await c.query(`CREATE TEMP TABLE ${table}(LIKE fresh.${table} INCLUDING ALL)ON COMMIT DROP`);
 await c.query('INSERT INTO pg_temp.wallets(address,monitoring_from_block)VALUES($1,1)',[wallet]);
 const payload=Buffer.from('original-unresolved-compressed-body'),expiry=now.toISOString();
 for(const[n,status]of[[1,'repair'],[2,'done']]as const){await c.query('INSERT INTO pg_temp.recent_blocks(block_number,block_hash,parent_hash,occurred_at,captured_at)VALUES($1,$2,$3,$4,$4)',[n,hash(n),hash(n-1),'2020-01-01T00:00:00Z']);
 await c.query(`INSERT INTO pg_temp.recent_evidence(tx_hash,block_hash,block_number,transaction_index,payload,wallet_addresses,decoder_status,last_error,expires_at)VALUES($1,$2,$3,0,$4,$5,$6,$7,$8)`,[hash(n+100),hash(n),n,payload,[wallet],status,status==='repair'?'trade_value_unavailable':null,expiry]);
 await c.query("INSERT INTO pg_temp.jobs(id,kind,reference,progress,attempts,lease_id,lease_until)VALUES($1,'decode_receipt',$2,$3,7,'11111111-1111-4111-8111-111111111111',$4)",[String(n),hash(n+100)+':'+hash(n),JSON.stringify({firstFailure:{at:'2020-01-01T00:00:00Z',reason:'original_failure'}}),new Date(now.getTime()+60000)]);}
 assert.equal((await expireFreshEvidenceInTransaction(q,new Date(now.getTime()-1))).evidence,0);
 const result=await expireFreshEvidenceInTransaction(q,now);assert.equal(result.evidence,2);assert.equal(result.expiredUndecoded,1);
 assert.equal((await c.query('SELECT count(*)::int n FROM pg_temp.recent_evidence')).rows[0].n,0);
 const jobs=(await c.query('SELECT * FROM pg_temp.jobs')).rows;assert.equal(jobs.length,1);const job=jobs[0],proof=job.progress.expiredEvidence;
 assert.equal(job.state,'unavailable');assert.equal(job.lease_id,null);assert.equal(job.lease_until,null);assert.equal(job.attempts,7);
 assert.equal(job.progress.firstFailure.reason,'original_failure');assert.equal(proof.kind,'expired_receipt_reference_v1');assert.equal(proof.transactionHash,hash(101));assert.equal(proof.blockHash,hash(1));assert.equal(proof.blockNumber,1);
 assert.deepEqual(proof.walletAddresses,[wallet]);assert.equal(proof.payloadSha256,createHash('sha256').update(payload).digest('hex'));assert.equal(proof.expiresAt,expiry);assert.equal(proof.lastError,'trade_value_unavailable');
 assert.equal(Number((await c.query('SELECT decode_gap_from_block FROM pg_temp.wallets WHERE address=$1',[wallet])).rows[0].decode_gap_from_block),1);
 const before=JSON.stringify(jobs);assert.equal((await expireFreshEvidenceInTransaction(q,new Date(now.getTime()+1000))).evidence,0);assert.equal(JSON.stringify((await c.query('SELECT * FROM pg_temp.jobs')).rows),before);
 // Missing decode jobs still get a compact repair identity, never a silent gap.
 await c.query(`INSERT INTO pg_temp.recent_evidence(tx_hash,block_hash,block_number,transaction_index,payload,wallet_addresses,decoder_status,last_error,expires_at)VALUES($1,$2,3,0,$3,$4,'pending','token_discovery_pending',$5)`,[hash(103),hash(3),payload,[wallet],expiry]);
 await expireFreshEvidenceInTransaction(q,now);assert.equal((await c.query('SELECT count(*)::int n FROM pg_temp.jobs')).rows[0].n,2);
 await c.query('ROLLBACK');console.log(JSON.stringify({ok:true,checks:['exact_expiry_boundary','raw_buffer_expires','done_job_removed','unresolved_identity_preserved','first_failure_and_attempts_retained','active_lease_released','wallet_gap_remains_explicit','repeated_expiry_no_churn','missing_job_identity_created','no_financial_or_account_mutations'],temporaryWrites:writes,persistentWrites:0,financialWrites:0}));
}finally{await c.query('ROLLBACK');c.release();await db.end();}
