import{createHash,randomUUID}from'node:crypto';
import type{Pool}from'pg';
import type{Rpc}from'../rpc.js';
import{blockHex}from'../rpc.js';
import{decodeFreshEvidence,encodeFreshEvidence,freshHash,freshInteger,validateFreshBlock,validateFreshReceipt,FRESH_EVIDENCE_TTL_MS,type FreshBlock,type FreshReceipt,type FreshLaunchFact}from'./capture.js';
import{enrichFreshKnownTokenBirth}from'./tokenBirth.js';
import{FRESH_DECODER_VERSION}from'./decode.js';

const stable=(value:unknown)=>JSON.stringify(value,(_key,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))):v);
function factFromRow(r:any):FreshLaunchFact{return{tokenAddress:r.token_address,protocol:r.protocol,blockNumber:Number(r.block_number),blockHash:r.block_hash,txHash:r.tx_hash,logIndex:r.log_index,launchedAt:new Date(r.launched_at).toISOString(),proof:r.proof,status:r.status};}
const sameHeader=(b:FreshBlock,other:FreshBlock|null)=>other!==null&&freshInteger(b.number)===freshInteger(other.number)&&b.hash===other.hash&&b.parentHash===other.parentHash&&freshInteger(b.timestamp)===freshInteger(other.timestamp);

/** Selected/actually traded tokens only. One durable reference per token and
 * one creation context per pass; no all-market receipt collection or scans. */
export const freshTokenBirthQueueSql=`INSERT INTO fresh.jobs(id,kind,reference,priority,progress,due_at)
 SELECT 'token_birth:'||l.token_address,'token_birth',l.token_address,CASE WHEN EXISTS(SELECT 1 FROM fresh.jobs selected WHERE selected.kind='quote' AND selected.reference=l.token_address AND selected.priority>=100 AND selected.state='pending')THEN 100 ELSE 50 END,
 jsonb_build_object('version',1,'kind','token_birth_capture_v1','blockNumber',l.block_number,'blockHash',l.block_hash,'transactionHash',l.tx_hash,
  'selectedUntilMs',CASE WHEN EXISTS(SELECT 1 FROM fresh.jobs selected WHERE selected.kind='quote' AND selected.reference=l.token_address AND selected.priority>=100 AND selected.state='pending')THEN(extract(epoch from($1::timestamptz+interval '2 minutes'))*1000)::bigint END),$1
 FROM fresh.launch_facts l WHERE l.status='eligible' AND l.block_number<=$2 AND l.protocol IN('flap','fourmeme','stockwave','evm_creation') AND l.proof->'tokenBirth' IS NULL
 AND(l.protocol<>'evm_creation' OR l.proof->>'creation'='top_level')
 AND(EXISTS(SELECT 1 FROM fresh.positions p JOIN fresh.accounting_scopes s ON s.id=p.scope_id AND s.active WHERE p.token_address=l.token_address AND p.last_event_at>=$1::timestamptz-interval '24 hours')
  OR EXISTS(SELECT 1 FROM fresh.jobs selected WHERE selected.kind='quote' AND selected.reference=l.token_address AND selected.priority>=100 AND selected.state='pending'))
 AND NOT EXISTS(SELECT 1 FROM fresh.jobs prior WHERE prior.kind='token_birth' AND prior.reference=l.token_address AND prior.state<>'cancelled')
 ORDER BY l.block_number DESC,l.token_address LIMIT 16 ON CONFLICT(kind,reference)DO UPDATE SET state='pending',priority=EXCLUDED.priority,progress=EXCLUDED.progress,due_at=EXCLUDED.due_at,lease_id=NULL,lease_until=NULL,last_error=NULL,updated_at=clock_timestamp() WHERE fresh.jobs.state='cancelled'`;

export const freshTokenBirthSelectionSql=`SELECT(EXISTS(SELECT 1 FROM fresh.positions p JOIN fresh.accounting_scopes s ON s.id=p.scope_id AND s.active WHERE p.token_address=$1 AND p.last_event_at>=$2::timestamptz-interval '24 hours')
 OR EXISTS(SELECT 1 FROM fresh.jobs selected WHERE selected.kind='quote' AND selected.reference=$1 AND selected.priority>=100 AND selected.state='pending')
 OR EXISTS(SELECT 1 FROM fresh.jobs selected WHERE selected.kind='token_birth' AND selected.reference=$1 AND selected.progress->>'kind'='token_birth_capture_v1'
  AND CASE WHEN selected.progress->>'selectedUntilMs'~'^[0-9]{13}$' THEN(selected.progress->>'selectedUntilMs')::bigint>=(extract(epoch from $2::timestamptz)*1000)::bigint AND(selected.progress->>'selectedUntilMs')::bigint<=(extract(epoch from($2::timestamptz+interval '2 minutes'))*1000)::bigint ELSE false END))AS selected`;

/** Optional proof enrichment is independent of capture and accounting. RPC
 * precedes the transaction, and only an exact authenticated creation can add
 * a certificate. All original financial values and receipt expiries remain. */
export async function runFreshTokenBirthCapture(db:Pool,rpc:Rpc,options:{signal?:AbortSignal;now?:Date}={}){
 const empty={queued:0,attempted:0,certified:0,yielded:false},now=options.now??new Date();if(options.signal?.aborted)return{...empty,yielded:true};
 const anchor=(await db.query(`SELECT c.revision::text,c.block_number::text,b.occurred_at FROM fresh.checkpoints c JOIN fresh.recent_blocks b ON b.block_number=c.block_number AND b.block_hash=c.block_hash JOIN fresh.checkpoints h ON h.key='health:capture' WHERE c.key='capture' AND h.value->>'ok'='true'`)).rows[0];
 if(!anchor||now.getTime()-new Date(anchor.occurred_at).getTime()>20_000)return{...empty,yielded:true};
 const queued=(await db.query(freshTokenBirthQueueSql,[now,anchor.block_number])).rowCount??0,lease=randomUUID();
 const job=(await db.query(`UPDATE fresh.jobs SET lease_id=$2,lease_until=$1::timestamptz+interval '30 seconds' WHERE id=(SELECT id FROM fresh.jobs WHERE kind='token_birth' AND state='pending' AND due_at<=$1 AND(lease_until IS NULL OR lease_until<=$1)ORDER BY priority DESC,due_at,id LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING *`,[now,lease])).rows[0];
 if(!job)return{...empty,queued};
 try{
  const row=(await db.query('SELECT * FROM fresh.launch_facts WHERE token_address=$1',[job.reference])).rows[0],startRow=(await db.query("SELECT block_number::text,block_hash FROM fresh.checkpoints WHERE key='start'")).rows[0];
  if(!row||row.status!=='eligible'||!startRow||!freshHash(startRow.block_hash))throw Error('token_birth_context_unavailable');
  const fact=factFromRow(row),start={number:Number(startRow.block_number),hash:startRow.block_hash};
  if(fact.blockNumber>Number(anchor.block_number))throw Error('token_birth_ahead_of_capture');
  if(job.progress?.version!==1||job.progress.kind!=='token_birth_capture_v1'||job.progress.blockNumber!==fact.blockNumber||job.progress.blockHash!==fact.blockHash||job.progress.transactionHash!==fact.txHash)throw Error('token_birth_job_changed');
  if(!(await db.query(freshTokenBirthSelectionSql,[fact.tokenAddress,options.now??new Date()])).rows[0]?.selected)throw Error('token_birth_not_selected');
  const deadline=Date.now()+8000,invoke=async<T>(method:string,params:unknown[])=>{if(options.signal?.aborted||Date.now()>deadline)throw Error('token_birth_capture_yielded');return rpc<T>(method,params);};
  const block=await invoke<FreshBlock>('eth_getBlockByNumber',[blockHex(fact.blockNumber),true]);validateFreshBlock(block,fact.blockNumber);if(block.hash!==fact.blockHash)throw Error('token_birth_creation_orphaned');
  const transaction=block.transactions.find(tx=>tx.hash===fact.txHash);if(!transaction)throw Error('token_birth_transaction_missing');
  const retained=(await db.query('SELECT payload FROM fresh.recent_evidence WHERE tx_hash=$1 AND block_hash=$2',[fact.txHash,fact.blockHash])).rows[0];
  const original=retained?decodeFreshEvidence(retained.payload):null,receipt=original?.receipt??await invoke<FreshReceipt|null>('eth_getTransactionReceipt',[fact.txHash]);validateFreshReceipt(receipt,transaction,block);
  if(original&&stable(original.transaction)!==stable(transaction))throw Error('token_birth_original_context_changed');
  const next=enrichFreshKnownTokenBirth(fact,{transaction,receipt,block},start);if(!next.proof.tokenBirth)throw Error('token_birth_creation_unsupported');
  const after=await invoke<FreshBlock|null>('eth_getBlockByNumber',[blockHex(fact.blockNumber),false]);if(!sameHeader(block,after))throw Error('token_birth_creation_orphaned');
  const client=await db.connect();try{
   await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock(73621941)');
   const held=(await client.query('SELECT * FROM fresh.jobs WHERE id=$1 AND lease_id=$2 AND lease_until>clock_timestamp() FOR UPDATE',[job.id,lease])).rows[0];if(!held||stable(held.progress)!==stable(job.progress))throw Error('token_birth_lease_changed');
   const currentStart=(await client.query("SELECT block_number::text,block_hash FROM fresh.checkpoints WHERE key='start' FOR SHARE")).rows[0],currentCapture=(await client.query("SELECT revision::text,block_number::text FROM fresh.checkpoints WHERE key='capture' FOR SHARE")).rows[0];
   if(stable(currentStart)!==stable(startRow)||String(currentCapture?.revision)!==String(anchor.revision)||Number(currentCapture?.block_number)<fact.blockNumber)throw Error('token_birth_boundary_changed');
   const canonical=(await client.query('SELECT block_hash,parent_hash,occurred_at FROM fresh.recent_blocks WHERE block_number=$1 FOR SHARE',[fact.blockNumber])).rows[0];if(!canonical||canonical.block_hash!==block.hash||canonical.parent_hash!==block.parentHash||new Date(canonical.occurred_at).toISOString()!==fact.launchedAt)throw Error('token_birth_creation_orphaned');
   const latest=(await client.query('SELECT * FROM fresh.launch_facts WHERE token_address=$1 FOR UPDATE',[fact.tokenAddress])).rows[0];if(!latest||stable(factFromRow(latest))!==stable(fact))throw Error('token_birth_context_changed');
   if(!(await client.query(freshTokenBirthSelectionSql,[fact.tokenAddress,options.now??new Date()])).rows[0]?.selected)throw Error('token_birth_not_selected');
   await client.query('UPDATE fresh.launch_facts SET proof=$2::jsonb WHERE token_address=$1',[fact.tokenAddress,JSON.stringify(next.proof)]);
   // One selected-token creation witness enters the same temporary buffer.
   // Existing rows and their original expiry/context are never replaced.
   const latestBody=(await client.query('SELECT payload FROM fresh.recent_evidence WHERE tx_hash=$1 AND block_hash=$2 FOR SHARE',[fact.txHash,fact.blockHash])).rows[0];
   if(latestBody){const value=decodeFreshEvidence(latestBody.payload);if(stable([value.transaction,value.receipt])!==stable([transaction,receipt]))throw Error('token_birth_original_context_changed');}
   else await client.query(`INSERT INTO fresh.recent_evidence(tx_hash,block_hash,block_number,transaction_index,payload,wallet_addresses,decoder_status,decoder_version,expires_at,created_at)VALUES($1,$2,$3,$4,$5,'{}','done',$6,$7,$8)`,[fact.txHash,fact.blockHash,fact.blockNumber,Number(freshInteger(transaction.transactionIndex)),encodeFreshEvidence({transaction,receipt,wallets:[],observedAt:now.toISOString()}),FRESH_DECODER_VERSION,new Date(now.getTime()+FRESH_EVIDENCE_TTL_MS),now]);
   const done=await client.query("UPDATE fresh.jobs SET state='done',lease_id=NULL,lease_until=NULL,last_error=NULL,progress=progress||$3::jsonb,updated_at=clock_timestamp() WHERE id=$1 AND lease_id=$2 AND lease_until>clock_timestamp()",[job.id,lease,JSON.stringify({stage:'certified',certificateSha256:createHash('sha256').update(stable(next.proof.tokenBirth)).digest('hex')})]);if(done.rowCount!==1)throw Error('token_birth_lease_changed');
   await client.query('COMMIT');
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  await db.query("SELECT pg_notify('bscan_update','update')");return{queued,attempted:1,certified:1,yielded:false};
 }catch(error){const reason=error instanceof Error?error.message.replace(/https?:\/\/\S+/g,'[endpoint]').slice(0,120):'token_birth_unavailable';await db.query("UPDATE fresh.jobs SET state=CASE WHEN $3='token_birth_not_selected' THEN 'cancelled' ELSE state END,lease_id=NULL,lease_until=NULL,attempts=attempts+1,last_error=$3,due_at=$4::timestamptz+CASE WHEN $3='token_birth_creation_unsupported' THEN interval '1 hour' ELSE interval '60 seconds' END,updated_at=clock_timestamp() WHERE id=$1 AND lease_id=$2",[job.id,lease,reason,now]);return{queued,attempted:1,certified:0,yielded:false,reason};}
}
