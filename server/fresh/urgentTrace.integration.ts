/** Canonical/registration locks and proof preservation; all writes roll back. */
import assert from'node:assert/strict';
import{randomBytes}from'node:crypto';
import{Pool}from'pg';
import type{Rpc}from'../rpc.js';
import{transferTopic}from'../swap.js';
import{poolMarketAbi}from'../nodeMarketProtocols.js';
import{decodeFreshEvidence,encodeFreshEvidence,type FreshCapturedReceipt}from'./capture.js';
import{createFreshUrgentTraceCapture,persistFreshUrgentTrace,freshUrgentTraceAttempts}from'./urgentTrace.js';
import{validFreshCompleteCallTrace}from'./passiveIncoming.js';
const url=new URL(process.env.DATABASE_URL??'');
if(!['127.0.0.1','localhost'].includes(url.hostname)||url.port!=='5436'||!url.pathname.includes('fresh')&&url.pathname!=='/kollens_tempo_wpc_20261025_192724'&&!/^\/kollens_pnl_repair_\d{14}$/.test(url.pathname))throw Error('Isolated local fresh database required');
const database=new Pool({connectionString:url.toString(),max:1}),client=await database.connect();
const address=()=>`0x${randomBytes(20).toString('hex')}`,hash=()=>`0x${randomBytes(32).toString('hex')}`,word=(value:string)=>`0x${value.slice(2).padStart(64,'0')}`;
const wallet=address(),router=address(),token=address(),txHash=hash(),blockHash=hash(),parentHash=hash(),now=new Date();
try{
 await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock(73621941)');
 const number=Number((await client.query("SELECT block_number FROM fresh.checkpoints WHERE key='capture'")).rows[0].block_number)+100,hex=`0x${number.toString(16)}`;
 const common={transactionHash:txHash,transactionIndex:'0x0',blockHash,blockNumber:hex};
 const entry:FreshCapturedReceipt={transaction:{hash:txHash,from:wallet,to:router,value:'0x64',input:'0x4d819a2a',type:'0x0',nonce:'0x1',gasPrice:'0x1',blockHash,blockNumber:hex,transactionIndex:'0x0'},
  receipt:{...common,status:'0x1',gasUsed:'0x5208',effectiveGasPrice:'0x1',logs:[{...common,address:address(),...poolMarketAbi.encodeEventLog('Swap',[router,100n,0n,0n,10n,wallet]),logIndex:'0x0'},
   {...common,address:token,topics:[transferTopic,word(router),word(wallet)],data:word('0xa'),logIndex:'0x1'}]},wallets:[wallet],observedAt:now.toISOString()};
 const trace={type:'CALL',from:wallet,to:router,value:'0x64',input:'0x4d819a2a',calls:[{type:'CALL',from:router,to:wallet,value:'0x1'}]};
 await client.query('INSERT INTO fresh.wallets(address,monitoring_from_block) VALUES($1,$2)',[wallet,number-10]);
 const revision=String((await client.query('SELECT revision FROM fresh.wallets WHERE address=$1',[wallet])).rows[0].revision);
 await client.query("INSERT INTO fresh.launch_facts(token_address,protocol,block_number,block_hash,tx_hash,launched_at,proof,status) VALUES($1,'evm_creation',$2,$3,$4,$5,'{}','eligible')",[token,number-1,hash(),hash(),now]);
 await client.query('INSERT INTO fresh.recent_blocks(block_number,block_hash,parent_hash,occurred_at) VALUES($1,$2,$3,$4)',[number,blockHash,parentHash,new Date(now.getTime()-3000)]);
 await client.query("INSERT INTO fresh.recent_evidence(tx_hash,block_hash,block_number,transaction_index,payload,expires_at,wallet_addresses,decoder_status,last_error) VALUES($1,$2,$3,0,$4,$5,$6,'repair','original_failure')",[txHash,blockHash,number,encodeFreshEvidence(entry),new Date(now.getTime()+72*3600_000),[wallet]]);
 const statements:string[]=[];let selectedTxHash=txHash,helperTransactionOpen=false;
 const query=async(sql:string,params?:unknown[])=>{
  statements.push(sql);
  if(sql==='BEGIN'){helperTransactionOpen=true;return client.query('SAVEPOINT urgent_trace_fixture');}
  if(sql==='COMMIT'){helperTransactionOpen=false;return client.query('RELEASE SAVEPOINT urgent_trace_fixture');}
  if(sql==='ROLLBACK'){helperTransactionOpen=false;await client.query('ROLLBACK TO SAVEPOINT urgent_trace_fixture');return client.query('RELEASE SAVEPOINT urgent_trace_fixture');}
  if(sql.startsWith('SELECT c.block_number'))return{rows:[{block_number:number,value:{startBlock:number-10},occurred_at:now,capture_ok:'true'}]};
  if(sql.startsWith('SELECT e.tx_hash'))return client.query('SELECT e.*,b.parent_hash,b.occurred_at FROM fresh.recent_evidence e JOIN fresh.recent_blocks b USING(block_number,block_hash) WHERE e.tx_hash=$1',[selectedTxHash]);
  return client.query(sql,params);
 };
 const db={query,connect:async()=>({query,release(){}})}as unknown as Pool;
 const rpc:Rpc=async<T>(method:string)=>{assert.equal(method,'eth_blockNumber');return`0x${(number+6).toString(16)}`as T;};
 const latest=structuredClone(entry);latest.stateEvidence={version:1,blockNumber:number,blockHash,calls:[{to:token,data:'0x313ce567',result:word('0x12')}]};
 (latest as any).recoveryEvidence={version:1,concurrent:'authenticated_retained_proof'};
 latest.decodeDiagnostics={version:1,valuationReasons:['original_failure'],firstFailure:{version:1,at:now.toISOString(),reasons:['original_failure']}};
 let calls=0;const run=createFreshUrgentTraceCapture(db,rpc,async()=>{
  calls++;assert.equal(helperTransactionOpen,false,'Trace starts after reservation transaction commits');
  latest.urgentTraceAttempts=decodeFreshEvidence((await client.query('SELECT payload FROM fresh.recent_evidence WHERE tx_hash=$1',[txHash])).rows[0].payload).urgentTraceAttempts;
  await client.query('UPDATE fresh.recent_evidence SET payload=$2 WHERE tx_hash=$1',[txHash,encodeFreshEvidence(latest)]);return trace;
 });
 assert.deepEqual(await run({now}),{receipts:1,attempted:1,saved:1,unavailable:0});assert.equal(calls,1);
 const saved=(await client.query('SELECT * FROM fresh.recent_evidence WHERE tx_hash=$1',[txHash])).rows[0],decoded=decodeFreshEvidence(saved.payload);
 assert.deepEqual(decoded.trace,trace);assert.deepEqual(decoded.stateEvidence,latest.stateEvidence);assert.deepEqual(decoded.recoveryEvidence,latest.recoveryEvidence);assert.deepEqual(decoded.decodeDiagnostics,latest.decodeDiagnostics);
 assert.deepEqual(decoded.receipt,entry.receipt);assert.deepEqual(decoded.transaction,entry.transaction);assert.equal(saved.decoder_status,'repair');assert.equal(saved.last_error,'original_failure');
 // Missing admission cannot prevent lossless evidence capture. In particular
 // an unresolved approval or synthetic airdrop is not allowed to remain an
 // untraced global blocker simply because ordinary accounting cannot approve it.
 for(const mode of['unknown_approval','inbound_synthetic','inbound_constructor']as const){
  const unknown=address(),nextHash=hash(),sender=mode==='unknown_approval'?wallet:address(),input=mode==='unknown_approval'?'0x095ea7b3':'0x729ad39e';
  const common2={...common,transactionHash:nextHash,transactionIndex:'0x1'},raw:FreshCapturedReceipt={transaction:{...entry.transaction,hash:nextHash,from:sender,to:unknown,value:'0x0',input,transactionIndex:'0x1'},
   receipt:{...entry.receipt,...common2,logs:[{...common2,address:unknown,topics:[transferTopic,word(router),word(wallet)],data:word('0xa'),logIndex:'0x2'}]},wallets:[wallet],observedAt:now.toISOString()};
  if(mode==='inbound_constructor'){raw.transaction.to=null;raw.receipt.contractAddress=unknown;}
  const originalPayload=encodeFreshEvidence(raw),originalExpiry=new Date(now.getTime()+72*3600_000);
  await client.query("INSERT INTO fresh.recent_evidence(tx_hash,block_hash,block_number,transaction_index,payload,expires_at,wallet_addresses,decoder_status,last_error)VALUES($1,$2,$3,1,$4,$5,$6,'repair','token_discovery_pending')",[nextHash,blockHash,number,originalPayload,originalExpiry,[wallet]]);
  selectedTxHash=nextHash;const full={type:mode==='inbound_constructor'?'CREATE':'CALL',from:sender,to:unknown,value:'0x0',input};
  assert.equal((await createFreshUrgentTraceCapture(db,rpc,async()=>full)({now})).saved,1);
  const captured=(await client.query('SELECT * FROM fresh.recent_evidence WHERE tx_hash=$1',[nextHash])).rows[0],proof=decodeFreshEvidence(captured.payload);
  assert.equal(validFreshCompleteCallTrace(proof,proof.trace!),true);assert.deepEqual([proof.transaction,proof.receipt],[raw.transaction,raw.receipt]);assert.equal(new Date(captured.expires_at).getTime(),originalExpiry.getTime());
  assert.equal(captured.decoder_status,'repair');assert.equal(captured.last_error,'token_discovery_pending');assert(captured.position_dependency_addresses.includes(unknown));assert(!captured.position_dependency_addresses.includes(token));assert.match(captured.position_dependency_proof,/^[a-f0-9]{64}$/);
  assert.equal((await client.query('SELECT count(*) FROM fresh.financial_events WHERE transaction_hash=$1',[nextHash])).rows[0].count,'0');
 }
 // Exact retry telemetry is evidence-only, bounded, durable across factory
 // restarts and compatible with ordinary decoder CAS. These fixtures are all
 // inside the isolated database's enclosing transaction and roll back below.
 const retryChecks:string[]=[];
 {
  const nextHash=hash(),common2={...common,transactionHash:nextHash,transactionIndex:'0x3'},raw:FreshCapturedReceipt={...entry,transaction:{...entry.transaction,hash:nextHash,transactionIndex:'0x3'},receipt:{...entry.receipt,...common2,logs:entry.receipt.logs.map(l=>({...l,...common2}))}};
  raw.decodeDiagnostics=latest.decodeDiagnostics;const expiry=new Date(now.getTime()+72*3600_000),originalPayload=encodeFreshEvidence(raw);await client.query("INSERT INTO fresh.recent_evidence(tx_hash,block_hash,block_number,transaction_index,payload,expires_at,wallet_addresses,decoder_status,last_error)VALUES($1,$2,$3,3,$4,$5,$6,'repair','original_failure')",[nextHash,blockHash,number,originalPayload,expiry,[wallet]]);selectedTxHash=nextHash;
  let requests=0;const failed=async()=>{requests++;assert.equal(helperTransactionOpen,false);return null;};
  assert.equal((await createFreshUrgentTraceCapture(db,rpc,failed)({now})).attempted,1);let row=(await client.query('SELECT * FROM fresh.recent_evidence WHERE tx_hash=$1',[nextHash])).rows[0],retained=decodeFreshEvidence(row.payload);assert.equal(freshUrgentTraceAttempts(retained)?.count,1);assert.equal(retained.urgentTraceAttempts?.lastOutcome,'unavailable');assert.equal(retained.trace,undefined);retryChecks.push('null_outcome_durable_before_restart');
  assert.equal((await createFreshUrgentTraceCapture(db,rpc,failed)({now})).attempted,0);assert.equal(requests,1);retryChecks.push('cooldown_retained_across_restart');
  retained.stateEvidence=latest.stateEvidence;await client.query('UPDATE fresh.recent_evidence SET payload=$2 WHERE tx_hash=$1',[nextHash,encodeFreshEvidence(retained)]);
  assert.equal((await createFreshUrgentTraceCapture(db,rpc,failed)({now:new Date(now.getTime()+600)})).attempted,1);assert.equal((await createFreshUrgentTraceCapture(db,rpc,failed)({now:new Date(now.getTime()+1200)})).attempted,0);assert.equal(requests,2);row=(await client.query('SELECT * FROM fresh.recent_evidence WHERE tx_hash=$1',[nextHash])).rows[0];retained=decodeFreshEvidence(row.payload);assert.equal(retained.urgentTraceAttempts?.count,2);retryChecks.push('restart_and_additive_evidence_cap_two');
  assert.equal(row.decoder_status,'repair');assert.equal(row.last_error,'original_failure');assert.equal(new Date(row.expires_at).getTime(),expiry.getTime());assert.deepEqual(retained.transaction,raw.transaction);assert.deepEqual(retained.receipt,raw.receipt);assert.deepEqual(retained.stateEvidence,latest.stateEvidence);assert.deepEqual(retained.decodeDiagnostics,raw.decodeDiagnostics);assert(Buffer.byteLength(JSON.stringify(retained.urgentTraceAttempts))<=1024);assert.equal((await client.query('SELECT count(*) FROM fresh.financial_events WHERE transaction_hash=$1',[nextHash])).rows[0].count,'0');retryChecks.push('body_ttl_status_fee_proofs_preserved');
  assert.equal((await client.query('UPDATE fresh.recent_evidence SET payload=$3 WHERE tx_hash=$1 AND payload=$2',[nextHash,originalPayload,encodeFreshEvidence(raw)])).rowCount,0);retryChecks.push('stale_decoder_payload_cas_rejected');
  const successfulHash=hash(),common3={...common,transactionHash:successfulHash,transactionIndex:'0x4'},successful:FreshCapturedReceipt={...raw,transaction:{...raw.transaction,hash:successfulHash,transactionIndex:'0x4'},receipt:{...raw.receipt,...common3,logs:raw.receipt.logs.map(l=>({...l,...common3}))}};
  await client.query("INSERT INTO fresh.recent_evidence(tx_hash,block_hash,block_number,transaction_index,payload,expires_at,wallet_addresses,decoder_status,last_error)VALUES($1,$2,$3,4,$4,$5,$6,'repair','original_failure')",[successfulHash,blockHash,number,encodeFreshEvidence(successful),expiry,[wallet]]);selectedTxHash=successfulHash;
  assert.equal((await createFreshUrgentTraceCapture(db,rpc,async()=>null)({now})).attempted,1);const full={...trace,input:String(successful.transaction.input)};assert.equal((await createFreshUrgentTraceCapture(db,rpc,async()=>full)({now:new Date(now.getTime()+600)})).saved,1);const completed=decodeFreshEvidence((await client.query('SELECT payload FROM fresh.recent_evidence WHERE tx_hash=$1',[successfulHash])).rows[0].payload);assert.equal(completed.urgentTraceAttempts?.count,2);assert.equal(completed.urgentTraceAttempts?.lastOutcome,'saved');assert.equal(validFreshCompleteCallTrace(completed,completed.trace!),true);retryChecks.push('transient_null_then_success_atomic_outcome');
  const invalidHash=hash(),common4={...common,transactionHash:invalidHash,transactionIndex:'0x5'},invalid:FreshCapturedReceipt={...raw,transaction:{...raw.transaction,hash:invalidHash,transactionIndex:'0x5'},receipt:{...raw.receipt,...common4,logs:raw.receipt.logs.map(l=>({...l,...common4}))}};await client.query("INSERT INTO fresh.recent_evidence(tx_hash,block_hash,block_number,transaction_index,payload,expires_at,wallet_addresses,decoder_status,last_error)VALUES($1,$2,$3,5,$4,$5,$6,'repair','original_failure')",[invalidHash,blockHash,number,encodeFreshEvidence(invalid),expiry,[wallet]]);selectedTxHash=invalidHash;
  await assert.rejects(createFreshUrgentTraceCapture(db,rpc,async()=>({...trace,value:'0x65'}))({now}),/urgent_trace_transaction_mismatch/);assert.equal((await createFreshUrgentTraceCapture(db,rpc,failed)({now:new Date(now.getTime()+600)})).attempted,0);assert.equal(decodeFreshEvidence((await client.query('SELECT payload FROM fresh.recent_evidence WHERE tx_hash=$1',[invalidHash])).rows[0].payload).urgentTraceAttempts?.lastOutcome,'rejected');retryChecks.push('mismatch_terminal_no_retry');
  const cancelled=new AbortController();cancelled.abort();const before=Buffer.from((await client.query('SELECT payload FROM fresh.recent_evidence WHERE tx_hash=$1',[invalidHash])).rows[0].payload);assert.equal((await createFreshUrgentTraceCapture(db,rpc,failed)({now,signal:cancelled.signal})).attempted,0);assert.deepEqual((await client.query('SELECT payload FROM fresh.recent_evidence WHERE tx_hash=$1',[invalidHash])).rows[0].payload,before);retryChecks.push('cancelled_no_reservation_or_request');
 }
 // Ordinary decoding may have saved the full tree first. The urgent lane
 // must really re-fetch it and compare equality before appending provenance;
 // merely finding a prior tree does not authenticate its completeness.
 {
  const nextHash=hash(),common2={...common,transactionHash:nextHash,transactionIndex:'0x2'},raw:FreshCapturedReceipt={transaction:{...entry.transaction,hash:nextHash,value:'0x0',input:'0x095ea7b3',transactionIndex:'0x2'},
   receipt:{...entry.receipt,...common2,logs:[{...common2,address:token,topics:[transferTopic,word(router),word(wallet)],data:word('0xa'),logIndex:'0x3'}]},wallets:[wallet],observedAt:now.toISOString(),stateEvidence:latest.stateEvidence,decodeDiagnostics:latest.decodeDiagnostics};
  const full={type:'CALL',from:wallet,to:router,value:'0x0',input:'0x095ea7b3'};raw.trace=full;const expiry=new Date(now.getTime()+72*3600_000);
  await client.query("INSERT INTO fresh.recent_evidence(tx_hash,block_hash,block_number,transaction_index,payload,expires_at,wallet_addresses,decoder_status,last_error)VALUES($1,$2,$3,2,$4,$5,$6,'repair','original_failure')",[nextHash,blockHash,number,encodeFreshEvidence(raw),expiry,[wallet]]);
  const before=(await client.query('SELECT * FROM fresh.recent_evidence WHERE tx_hash=$1',[nextHash])).rows[0];selectedTxHash=nextHash;let actualReads=0;
  assert.equal((await createFreshUrgentTraceCapture(db,rpc,async()=>{actualReads++;return full;})({now})).saved,1);assert.equal(actualReads,1);
  const after=(await client.query('SELECT * FROM fresh.recent_evidence WHERE tx_hash=$1',[nextHash])).rows[0],merged=decodeFreshEvidence(after.payload);
  assert.equal(validFreshCompleteCallTrace(merged,merged.trace!),true);for(const key of Object.keys(raw))assert.deepEqual((merged as any)[key],(raw as any)[key]);
  for(const key of Object.keys(before).filter(k=>!['payload','position_dependency_addresses','position_dependency_proof'].includes(k)))assert.deepEqual(after[key],before[key]);
  assert(after.position_dependency_addresses.includes(router));assert.equal((await client.query('SELECT count(*) FROM fresh.financial_events WHERE transaction_hash=$1',[nextHash])).rows[0].count,'0');
 }
 selectedTxHash=txHash;
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
 console.log(JSON.stringify({ok:true,checks:['fresh_native_swap_trace','trace_after_reservation_commit','latest_proof_and_first_failure_preserved','original_receipt_and_repair_retained','unknown_approval_proof_without_admission','bounded_inbound_synthetic_dependency_proof','inbound_constructor_complete_dependency_proof','immediate_complete_dependency_index','original_ttl_retained','single_attempt_per_pass','conflicting_or_mismatched_trace_rejected','registration_revision_and_context_rejected','canonical_reorg_rejected','no_financial_or_checkpoint_writes',...retryChecks],retryChecks:retryChecks.length,fixtureWrites:'rolled back'}));
}finally{await client.query('ROLLBACK');client.release();await database.end();}
