/** Canonical/registration locks and proof preservation; all writes roll back. */
import assert from'node:assert/strict';
import{randomBytes}from'node:crypto';
import{Pool}from'pg';
import type{Rpc}from'../rpc.js';
import{transferTopic}from'../swap.js';
import{poolMarketAbi}from'../nodeMarketProtocols.js';
import{decodeFreshEvidence,encodeFreshEvidence,type FreshCapturedReceipt}from'./capture.js';
import{createFreshUrgentTraceCapture,persistFreshUrgentTrace}from'./urgentTrace.js';
const url=new URL(process.env.DATABASE_URL??'');
if(!['127.0.0.1','localhost'].includes(url.hostname)||url.port!=='5436'||!url.pathname.includes('fresh'))throw Error('Isolated local fresh database required');
const database=new Pool({connectionString:url.toString(),max:1}),client=await database.connect();
const address=()=>`0x${randomBytes(20).toString('hex')}`,hash=()=>`0x${randomBytes(32).toString('hex')}`,word=(value:string)=>`0x${value.slice(2).padStart(64,'0')}`;
const wallet=address(),router=address(),token=address(),txHash=hash(),blockHash=hash(),parentHash=hash(),now=new Date();
try{
 await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock(73621941)');
 const number=Number((await client.query("SELECT block_number FROM fresh.checkpoints WHERE key='capture'")).rows[0].block_number)+100,hex=`0x${number.toString(16)}`;
 const common={transactionHash:txHash,transactionIndex:'0x0',blockHash,blockNumber:hex};
 const entry:FreshCapturedReceipt={transaction:{hash:txHash,from:wallet,to:router,value:'0x64',type:'0x0',nonce:'0x1',gasPrice:'0x1',blockHash,blockNumber:hex,transactionIndex:'0x0'},
  receipt:{...common,status:'0x1',gasUsed:'0x5208',effectiveGasPrice:'0x1',logs:[{...common,address:address(),...poolMarketAbi.encodeEventLog('Swap',[router,100n,0n,0n,10n,wallet]),logIndex:'0x0'},
   {...common,address:token,topics:[transferTopic,word(router),word(wallet)],data:word('0xa'),logIndex:'0x1'}]},wallets:[wallet],observedAt:now.toISOString()};
 const trace={type:'CALL',from:wallet,to:router,value:'0x64',calls:[{type:'CALL',from:router,to:wallet,value:'0x1'}]};
 await client.query('INSERT INTO fresh.wallets(address,monitoring_from_block) VALUES($1,$2)',[wallet,number-10]);
 const revision=String((await client.query('SELECT revision FROM fresh.wallets WHERE address=$1',[wallet])).rows[0].revision);
 await client.query("INSERT INTO fresh.launch_facts(token_address,protocol,block_number,block_hash,tx_hash,launched_at,proof,status) VALUES($1,'evm_creation',$2,$3,$4,$5,'{}','eligible')",[token,number-1,hash(),hash(),now]);
 await client.query('INSERT INTO fresh.recent_blocks(block_number,block_hash,parent_hash,occurred_at) VALUES($1,$2,$3,$4)',[number,blockHash,parentHash,new Date(now.getTime()-3000)]);
 await client.query("INSERT INTO fresh.recent_evidence(tx_hash,block_hash,block_number,transaction_index,payload,expires_at,wallet_addresses,decoder_status,last_error) VALUES($1,$2,$3,0,$4,$5,$6,'repair','original_failure')",[txHash,blockHash,number,encodeFreshEvidence(entry),new Date(now.getTime()+72*3600_000),[wallet]]);
 const statements:string[]=[];
 const query=async(sql:string,params?:unknown[])=>{
  statements.push(sql);
  if(sql==='BEGIN')return client.query('SAVEPOINT urgent_trace_fixture');
  if(sql==='COMMIT')return client.query('RELEASE SAVEPOINT urgent_trace_fixture');
  if(sql==='ROLLBACK'){await client.query('ROLLBACK TO SAVEPOINT urgent_trace_fixture');return client.query('RELEASE SAVEPOINT urgent_trace_fixture');}
  if(sql.startsWith('SELECT c.block_number'))return{rows:[{block_number:number,value:{startBlock:number-10},occurred_at:now,capture_ok:'true'}]};
  if(sql.startsWith('SELECT e.tx_hash'))return client.query('SELECT e.*,b.parent_hash,b.occurred_at FROM fresh.recent_evidence e JOIN fresh.recent_blocks b USING(block_number,block_hash) WHERE e.tx_hash=$1',[txHash]);
  return client.query(sql,params);
 };
 const db={query,connect:async()=>({query,release(){}})}as unknown as Pool;
 const rpc:Rpc=async<T>(method:string)=>{assert.equal(method,'eth_blockNumber');return`0x${(number+6).toString(16)}`as T;};
 const latest=structuredClone(entry);latest.stateEvidence={version:1,blockNumber:number,blockHash,calls:[{to:token,data:'0x313ce567',result:word('0x12')}]};
 (latest as any).recoveryEvidence={version:1,concurrent:'authenticated_retained_proof'};
 latest.decodeDiagnostics={version:1,valuationReasons:['original_failure'],firstFailure:{version:1,at:now.toISOString(),reasons:['original_failure']}};
 let calls=0;const run=createFreshUrgentTraceCapture(db,rpc,async()=>{
  calls++;assert.ok(!statements.includes('BEGIN'),'Trace is outside write transaction');
  await client.query('UPDATE fresh.recent_evidence SET payload=$2 WHERE tx_hash=$1',[txHash,encodeFreshEvidence(latest)]);return trace;
 });
 assert.deepEqual(await run({now}),{receipts:1,attempted:1,saved:1,unavailable:0});assert.equal(calls,1);
 const saved=(await client.query('SELECT * FROM fresh.recent_evidence WHERE tx_hash=$1',[txHash])).rows[0],decoded=decodeFreshEvidence(saved.payload);
 assert.deepEqual(decoded.trace,trace);assert.deepEqual(decoded.stateEvidence,latest.stateEvidence);assert.deepEqual(decoded.recoveryEvidence,latest.recoveryEvidence);assert.deepEqual(decoded.decodeDiagnostics,latest.decodeDiagnostics);
 assert.deepEqual(decoded.receipt,entry.receipt);assert.deepEqual(decoded.transaction,entry.transaction);assert.equal(saved.decoder_status,'repair');assert.equal(saved.last_error,'original_failure');
 assert.equal((await run({now})).attempted,0);assert.equal(await persistFreshUrgentTrace(db,entry,trace,{walletRevision:revision,token}),false);
 await assert.rejects(persistFreshUrgentTrace(db,entry,{...trace,value:'0x65'},{walletRevision:revision,token}),/urgent_trace_transaction_mismatch/);
 await assert.rejects(persistFreshUrgentTrace(db,entry,{...trace,calls:[]},{walletRevision:revision,token}),/urgent_trace_conflict/);
 await client.query('UPDATE fresh.wallets SET revision=revision+1 WHERE address=$1',[wallet]);
 await assert.rejects(persistFreshUrgentTrace(db,entry,trace,{walletRevision:revision,token}),/urgent_trace_wallet_changed/);
 await client.query('UPDATE fresh.wallets SET revision=$2 WHERE address=$1',[wallet,revision]);
 await client.query('UPDATE fresh.recent_evidence SET wallet_addresses=$2 WHERE tx_hash=$1',[txHash,[router]]);
 await assert.rejects(persistFreshUrgentTrace(db,entry,trace,{walletRevision:revision,token}),/urgent_trace_wallet_changed/);
 await client.query('UPDATE fresh.recent_evidence SET wallet_addresses=$2 WHERE tx_hash=$1',[txHash,[wallet]]);
 await client.query('UPDATE fresh.recent_blocks SET block_hash=$2 WHERE block_number=$1',[number,hash()]);
 assert.equal(await persistFreshUrgentTrace(db,entry,trace,{walletRevision:revision,token}),false);
 assert.deepEqual((await client.query('SELECT payload FROM fresh.recent_evidence WHERE tx_hash=$1',[txHash])).rows[0].payload,saved.payload);
 assert.equal((await client.query('SELECT count(*) FROM fresh.financial_events WHERE transaction_hash=$1',[txHash])).rows[0].count,'0');
 assert.ok(!statements.some(sql=>/financial_events|fresh.jobs|UPDATE fresh.checkpoints|decoder_status=/.test(sql)));
 console.log(JSON.stringify({ok:true,checks:['fresh_native_swap_trace','trace_before_write_lock','latest_proof_and_first_failure_preserved','original_receipt_and_repair_retained','single_attempt','conflicting_or_mismatched_trace_rejected','registration_revision_and_context_rejected','canonical_reorg_rejected','no_financial_or_checkpoint_writes'],fixtureWrites:'rolled back'}));
}finally{await client.query('ROLLBACK');client.release();await database.end();}
