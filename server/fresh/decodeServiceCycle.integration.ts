/** Real bounded selector fairness. Session-temporary rows only; no RPC or
 * financial normalization. Every fixture mutation rolls back. */
import assert from'node:assert/strict';import{Pool}from'pg';
import{selectFreshDecodeEvidence,FRESH_DECODER_VERSION}from'./decode.js';
import{createFreshDecodeServiceCycle}from'./decodeWorkBudget.js';
const url=new URL(process.env.DATABASE_URL??'');if(!['127.0.0.1','localhost'].includes(url.hostname)||url.port!=='5436'||!/^\/kollens_(?:tempo_wpc|pnl_repair)_\d{8}_?\d{6}$/.test(url.pathname))throw Error('decode_cycle_fixture_owned_local_clone_only');
const pool=new Pool({connectionString:url.href,max:1}),c=await pool.connect(),hash=(n:number)=>'0x'+n.toString(16).padStart(64,'0'),now=new Date(),checks:string[]=[];
const db={query:(sql:string,args?:unknown[])=>c.query(sql.replaceAll('fresh.','pg_temp.'),args)}as unknown as Pick<Pool,'query'>;
try{await c.query('BEGIN');await c.query("SET LOCAL statement_timeout='10s'");for(const name of['recent_blocks','recent_evidence','jobs'])await c.query(`CREATE TEMP TABLE ${name}(LIKE fresh.${name} INCLUDING ALL)ON COMMIT DROP`);
 async function add(n:number,status:'pending'|'repair'|'done',version=FRESH_DECODER_VERSION,job?:{state:'pending'|'done';future?:boolean}){
  await c.query('INSERT INTO pg_temp.recent_blocks(block_number,block_hash,parent_hash,occurred_at)VALUES($1,$2,$3,$4)',[n,hash(n),hash(n-1),now]);
  await c.query('INSERT INTO pg_temp.recent_evidence(tx_hash,block_hash,block_number,transaction_index,payload,expires_at,decoder_status,decoder_version)VALUES($1,$2,$3,0,$4,$5,$6,$7)',[hash(10000+n),hash(n),n,Buffer.from('selector-only'),new Date(now.getTime()+72*3600_000),status,version]);
  if(job)await c.query("INSERT INTO pg_temp.jobs(id,kind,reference,state,due_at)VALUES($1,'decode_receipt',$2,$3,$4)",['cycle:'+n,hash(10000+n)+':'+hash(n),job.state,new Date(now.getTime()+(job.future?60000:-1000))]);
 }
 for(const n of[10,20,30])await add(n,'repair',FRESH_DECODER_VERSION,{state:'pending'});
 await add(40,'repair',FRESH_DECODER_VERSION,{state:'pending',future:true});await add(41,'repair',FRESH_DECODER_VERSION,{state:'done'});await add(42,'repair');await add(43,'done');await add(44,'done',FRESH_DECODER_VERSION-1);
 await add(100,'pending');assert.equal((await selectFreshDecodeEvidence(db,now,1)).rows[0].block_number,'100');assert.equal((await selectFreshDecodeEvidence(db,now,1,{repairFirst:false})).rows[0].block_number,'100');assert.equal((await selectFreshDecodeEvidence(db,now,1,{repairFirst:true})).rows[0].block_number,'10');checks.push('Default and explicit normal mode retain pending-first ordering; due repair mode changes only priority');
 const next=createFreshDecodeServiceCycle(),selected:{block:number;status:string;repairFirst:boolean}[]=[];
 for(let pass=0;pass<12;pass++){if(pass)await add(100+pass,'pending');const mode=next(),rows=(await selectFreshDecodeEvidence(db,now,1,mode)).rows;assert.equal(rows.length,1);const row=rows[0];assert.equal(row.decoder_status,mode.repairFirst?'repair':'pending');selected.push({block:Number(row.block_number),status:row.decoder_status,...mode});await c.query("UPDATE pg_temp.recent_evidence SET decoder_status='done',decoder_version=$2 WHERE tx_hash=$1",[row.tx_hash,FRESH_DECODER_VERSION]);if(row.decoder_status==='repair')await c.query("UPDATE pg_temp.jobs SET state='done' WHERE reference=$1",[row.tx_hash+':'+row.block_hash]);}
 assert.deepEqual(selected.filter(r=>r.repairFirst).map(r=>r.block),[10,20,30]);assert.equal(selected.filter(r=>!r.repairFirst).length,9);assert(selected.every(r=>![40,41,42,43,44].includes(r.block)));checks.push('Continuous new pending receipts and old due repairs both receive service in a three-to-one worker cycle');
 for(const repairFirst of[false,true]){const rows=(await selectFreshDecodeEvidence(db,now,64,{repairFirst})).rows;assert(rows.every(r=>![40,41,42,43].includes(Number(r.block_number))));assert(rows.some(r=>Number(r.block_number)===44));}checks.push('Future-due, completed-job, missing-job repairs and current completed evidence remain excluded; stale-version migration eligibility is unchanged');
 await c.query('ROLLBACK');console.log(JSON.stringify({at:new Date().toISOString(),passed:true,checks,selected,persistentWrites:0,financialWrites:0,networkCalls:0}));
}catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();await pool.end();}
