import {createHash} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';

export const FRESH_TRANSFER_VALUATION_PAGE_LIMIT=64;
type Seed={scopeId:string;tokenAddress:string;tradeEventId:string};
type Progress={version:1;scopeId:string;tokenAddress:string;scopeRevision:string;tradeEventId:string;wallet:string|null;afterId:string};
const address=(v:unknown):v is string=>typeof v==='string'&&/^0x[\da-f]{40}$/.test(v);
const eventId=(v:unknown):v is string=>typeof v==='string'&&v.length>0&&v.length<=512&&!/[\u0000-\u001f\u007f]/.test(v);
const scopeId=(v:unknown):v is string=>typeof v==='string'&&v.length>0&&v.length<=256;
export const FRESH_TRANSFER_VALUE_WARNINGS=['incoming_transfer_cost_unknown','outgoing_transfer_value_unknown','incoming_transfer_cost_unknown,outgoing_transfer_value_unknown','outgoing_transfer_value_unknown,incoming_transfer_cost_unknown'];
const warnings=FRESH_TRANSFER_VALUE_WARNINGS;

/** One wallet/token prefix, with LIMIT applied before receipt/scope filtering.
 * The partial index contains exactly these raw null-valued canonical facts.
 * Other wallets holding this token cannot add examined facts to a page. */
export const FRESH_TRANSFER_VALUATION_PAGE_SQL=`SELECT id FROM fresh.financial_events
 WHERE wallet_address=$1 AND token_address=$2 AND canonical AND amount_usd IS NULL
 AND kind IN('transfer_in','transfer_out') AND id>$3 ORDER BY id LIMIT $4`;

export const FRESH_TRANSFER_VALUATION_ELIGIBLE_SQL=`SELECT DISTINCT e.tx_hash,e.block_hash
 FROM fresh.financial_events f JOIN fresh.scope_event_results r ON r.scope_id=$1 AND r.event_id=f.id
 JOIN fresh.accounting_scopes s ON s.id=r.scope_id AND s.active
 JOIN fresh.recent_blocks b ON b.block_number=f.block_number AND b.block_hash=f.block_hash
 JOIN fresh.recent_evidence e ON e.tx_hash=f.transaction_hash AND e.block_hash=f.block_hash
 LEFT JOIN public.journal_wallets m ON m.user_id::text=s.account_id AND m.wallet_address=f.wallet_address
 LEFT JOIN public.journal_wallets cp ON cp.user_id::text=s.account_id AND cp.wallet_address=f.counterparty
 WHERE f.id=ANY($2::text[]) AND f.canonical AND f.amount_usd IS NULL AND f.kind IN('transfer_in','transfer_out')
 AND f.token_address=$3 AND f.wallet_address=ANY(s.wallet_addresses) AND f.wallet_address=ANY(e.wallet_addresses)
 AND f.block_number>=s.starts_block AND f.occurred_at>=s.starts_at
 AND (s.account_id IS NULL OR m.wallet_address IS NOT NULL AND f.block_number>=COALESCE(m.registration_block,s.starts_block) AND f.occurred_at>=m.activity_from)
 AND NOT(COALESCE(f.counterparty=ANY(s.wallet_addresses),false) AND
   (s.account_id IS NULL OR cp.wallet_address IS NOT NULL AND f.block_number>=COALESCE(cp.registration_block,s.starts_block) AND f.occurred_at>=cp.activity_from))
 AND (s.kind<>'kol' OR EXISTS(SELECT 1 FROM fresh.kols k WHERE k.wallet_address=f.wallet_address AND k.is_tracked))
 AND e.decoder_status='done' AND e.last_error=ANY($4::text[]) AND e.expires_at>$5
 ORDER BY e.tx_hash,e.block_hash`;

export const FRESH_TRANSFER_VALUATION_TRADE_SQL=`SELECT 1 FROM fresh.scope_event_results r JOIN fresh.financial_events f ON f.id=r.event_id
 LEFT JOIN public.journal_wallets m ON m.user_id::text=$4 AND m.wallet_address=f.wallet_address
 WHERE r.scope_id=$1 AND r.event_id=$2 AND r.token_address=$3 AND r.tokens_trade AND f.canonical AND f.kind IN('buy','sell')
 AND f.wallet_address=ANY($5::text[]) AND f.block_number>=$6 AND f.occurred_at>=$7
 AND ($4::text IS NULL OR m.wallet_address IS NOT NULL AND f.block_number>=COALESCE(m.registration_block,$6) AND f.occurred_at>=m.activity_from)`;

/** Called only after NEW scope trade results were applied, in their existing
 * accounting transaction. Duplicate delivery creates no new result or job.
 * A rebuilt/membership-changed book resets its one bounded cursor. */
export async function queueFreshTransferValuation(database:Pick<PoolClient,'query'>,seeds:Seed[],now:Date){
 const unique=new Map<string,Seed>();for(const seed of seeds){
  if(!scopeId(seed.scopeId)||!address(seed.tokenAddress)||!eventId(seed.tradeEventId))throw Error('transfer_revaluation_seed_invalid');
  unique.set(seed.scopeId+':'+seed.tokenAddress,seed);
 }
 let queued=0;
 const values=[...unique.values()];
 for(let offset=0;offset<values.length;offset+=128){
  const batch=values.slice(offset,offset+128).map(seed=>{const reference=seed.scopeId+':'+seed.tokenAddress;return{scope_id:seed.scopeId,token_address:seed.tokenAddress,trade_event_id:seed.tradeEventId,reference,id:'transfer_revaluation:'+createHash('sha256').update(reference).digest('hex')};});
  const result=await database.query(`INSERT INTO fresh.jobs(id,kind,reference,priority,state,progress,due_at)
   SELECT seed.id,'transfer_revaluation',seed.reference,70,'pending',jsonb_build_object('version',1,'scopeId',s.id,'tokenAddress',p.token_address,
     'scopeRevision',s.revision::text,'tradeEventId',seed.trade_event_id,'wallet',NULL,'afterId',''),$2
   FROM jsonb_to_recordset($1::jsonb)AS seed(id text,reference text,scope_id text,token_address text,trade_event_id text)
   JOIN fresh.accounting_scopes s ON s.id=seed.scope_id JOIN fresh.positions p ON p.scope_id=s.id AND p.token_address=seed.token_address
   JOIN fresh.scope_event_results r ON r.scope_id=s.id AND r.event_id=seed.trade_event_id AND r.token_address=p.token_address AND r.tokens_trade
   JOIN fresh.financial_events f ON f.id=r.event_id AND f.canonical AND f.kind IN('buy','sell')
   WHERE s.active AND (p.unknown_incoming_value OR p.unknown_outgoing_value)
   ON CONFLICT(kind,reference) DO UPDATE SET progress=EXCLUDED.progress,state='pending',due_at=EXCLUDED.due_at,
     lease_id=NULL,lease_until=NULL,updated_at=clock_timestamp()
   WHERE fresh.jobs.progress->>'scopeRevision' IS DISTINCT FROM EXCLUDED.progress->>'scopeRevision'`,
   [JSON.stringify(batch),now]);
  queued+=result.rowCount??0;
 }
 return queued;
}

function readProgress(value:any):Progress{
 if(value?.version!==1||!scopeId(value.scopeId)||!address(value.tokenAddress)||!eventId(value.tradeEventId)
  ||typeof value.scopeRevision!=='string'||!/^[1-9]\d{0,18}$/.test(value.scopeRevision)
  ||value.wallet!==null&&!address(value.wallet)||typeof value.afterId!=='string'||value.afterId!==''&&!eventId(value.afterId))throw Error('transfer_revaluation_progress_invalid');
 return value;
}

/** Caller holds the existing financial and scope locks. This routine changes
 * only receipt scheduling and its own job cursor; originals, warning and first
 * failure stay untouched. Values and costs remain the decoder's responsibility. */
export async function commitFreshTransferValuationPage(client:PoolClient,job:{id:string;reference:string;progress:unknown},now:Date,limit=FRESH_TRANSFER_VALUATION_PAGE_LIMIT){
 let progress=readProgress(job.progress);
 if(job.reference!==progress.scopeId+':'+progress.tokenAddress)throw Error('transfer_revaluation_reference_invalid');
 const scope=(await client.query('SELECT * FROM fresh.accounting_scopes WHERE id=$1 AND active FOR SHARE',[progress.scopeId])).rows[0];
 const complete=async()=>{await client.query('DELETE FROM fresh.jobs WHERE id=$1',[job.id]);return{jobs:1,scanned:0,receipts:0,completed:true};};
 if(!scope)return complete();
 const members=scope.account_id?(await client.query('SELECT wallet_address FROM public.journal_wallets WHERE user_id::text=$1 ORDER BY wallet_address FOR SHARE',[scope.account_id])).rows.map(r=>r.wallet_address):scope.wallet_addresses;
 const wallets=[...new Set<string>(scope.wallet_addresses.filter((wallet:string)=>members.includes(wallet)))].sort();
 if(wallets.length>256||wallets.some(wallet=>!address(wallet)))throw Error('transfer_revaluation_membership_bound');
 if(!wallets.length)return complete();
 const trade=(await client.query(FRESH_TRANSFER_VALUATION_TRADE_SQL,
  [scope.id,progress.tradeEventId,progress.tokenAddress,scope.account_id,wallets,scope.starts_block,scope.starts_at])).rowCount;
 const unknown=(await client.query('SELECT 1 FROM fresh.positions WHERE scope_id=$1 AND token_address=$2 AND (unknown_incoming_value OR unknown_outgoing_value)',[scope.id,progress.tokenAddress])).rowCount;
 if(!trade||!unknown)return complete();
 if(progress.scopeRevision!==String(scope.revision))progress={...progress,scopeRevision:String(scope.revision),wallet:null,afterId:''};
 const wallet=progress.wallet??wallets[0];
 if(!wallets.includes(wallet)){progress={...progress,wallet:null,afterId:''};return commitFreshTransferValuationPage(client,{...job,progress},now,limit);}
 const cap=Math.max(1,Math.min(FRESH_TRANSFER_VALUATION_PAGE_LIMIT,Math.floor(limit))),facts=(await client.query(FRESH_TRANSFER_VALUATION_PAGE_SQL,[wallet,progress.tokenAddress,progress.afterId,cap])).rows;
 const eligible=facts.length?(await client.query(FRESH_TRANSFER_VALUATION_ELIGIBLE_SQL,[scope.id,facts.map(f=>f.id),progress.tokenAddress,warnings,now])).rows:[];
 let receipts=0;
 for(const receipt of eligible){
  const updated=await client.query(`UPDATE fresh.recent_evidence SET decoder_status='pending'
   WHERE tx_hash=$1 AND block_hash=$2 AND decoder_status='done' AND last_error=ANY($3::text[]) AND expires_at>$4`,
   [receipt.tx_hash,receipt.block_hash,warnings,now]);receipts+=updated.rowCount??0;
 }
 const nextWallet=facts.length<cap?wallets[wallets.indexOf(wallet)+1]:wallet;
 if(!nextWallet)await client.query('DELETE FROM fresh.jobs WHERE id=$1',[job.id]);
 else{
  const next={...progress,wallet:nextWallet,afterId:nextWallet===wallet?facts.at(-1)!.id:''};
  await client.query("UPDATE fresh.jobs SET progress=$2::jsonb,lease_id=NULL,lease_until=NULL,due_at=$3,updated_at=clock_timestamp() WHERE id=$1",[job.id,JSON.stringify(next),now]);
 }
 return{jobs:1,scanned:facts.length,receipts,completed:!nextWallet};
}

/** Invoked by the existing decoder pass, never by API reads or a new loop.
 * Empty polling is one indexed SELECT and zero writes. Lock ordering matches
 * accounting: financial -> scope -> job -> receipt, without holding RPC work. */
export async function runFreshTransferValuation(database:Pool,options:{now?:Date;limit?:number}={}){
 const now=options.now??new Date(),empty={jobs:0,scanned:0,receipts:0,completed:false};
 const candidate=(await database.query("SELECT id,reference,progress FROM fresh.jobs WHERE kind='transfer_revaluation' AND state='pending' AND due_at<=$1 ORDER BY priority DESC,due_at,id LIMIT 1",[now])).rows[0];
 if(!candidate)return empty;
 const progress=readProgress(candidate.progress),client=await database.connect();
 try{
  await client.query('BEGIN');await client.query("SET LOCAL lock_timeout='250ms'");await client.query("SET LOCAL statement_timeout='2000ms'");await client.query('SELECT pg_advisory_xact_lock(73621941)');
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['fresh-scope:'+progress.scopeId]);
  const current=(await client.query("SELECT id,reference,progress FROM fresh.jobs WHERE id=$1 AND kind='transfer_revaluation' AND state='pending' AND due_at<=$2 FOR UPDATE SKIP LOCKED",[candidate.id,now])).rows[0];
  const result=current?await commitFreshTransferValuationPage(client,current,now,options.limit):empty;
  await client.query('COMMIT');return result;
 }catch(error){await client.query('ROLLBACK');if(error&&typeof error==='object'&&'code'in error&&['55P03','57014'].includes(String(error.code)))return{...empty,yielded:true,reason:'bounded_database_work_deferred'};throw error;}finally{client.release();}
}
