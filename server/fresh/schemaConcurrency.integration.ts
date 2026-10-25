/** Local, existing Fresh database only. The synthetic writer changes no rows. */
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import pg,{type Pool,type PoolClient} from 'pg';
import {ensureFreshSchema} from './schema.js';

const url=new URL(process.env.DATABASE_URL??'');
assert.ok(url.hostname==='127.0.0.1'&&url.port==='5436'&&url.pathname==='/kollens_fresh_20261022_24h','isolated_existing_fresh_database_required');
assert.equal(process.env.FRESH_LOCAL_ONLY,'true');
const db=new pg.Pool({connectionString:url.href,max:4,options:'-c lock_timeout=10000 -c statement_timeout=15000'});
const writer=await db.connect(),observer=await db.connect();
let writerOpen=false,startup:Promise<void>|undefined,coreClientSeen=false,ddlStarted=false,corePid=0;
let financialWait!:()=>void;const waiting=new Promise<void>(resolve=>{financialWait=resolve;});
let baseline:unknown,coreFinancialUnchanged=false;
const fingerprint=async(c:PoolClient)=>{
  const rows:Record<string,unknown>={};
  for(const table of ['financial_events','scope_event_results','open_lots'])rows[table]=(await c.query(`SELECT count(*)::text n,md5(COALESCE(string_agg(md5(to_jsonb(t)::text),'' ORDER BY to_jsonb(t)::text),'')) sha FROM fresh.${table} t`)).rows[0];
  rows.positions=(await c.query(`SELECT count(*)::text n,md5(COALESCE(string_agg(md5((to_jsonb(t)-ARRAY['balance_quantity','balance_block','balance_hash','balance_checked_at','balance_status'])::text),'' ORDER BY scope_id,token_address),'')) sha FROM fresh.positions t`)).rows[0];
  return rows;
};
const report:any={at:new Date().toISOString(),checks:[],fixtureFinancialWrites:0,nodeRequests:0,providerRequests:0,realMessages:0,passed:false};
try{
  const boundary=(await observer.query("SELECT block_number::text,block_hash FROM fresh.checkpoints WHERE key='start'")).rows[0];
  assert.deepEqual(boundary,{block_number:'129180844',block_hash:'0x32588e1f98d9d2c5bf163a8700ac3740b4aaf86237e57d9f0f86406600c90103'});
  await writer.query('BEGIN');writerOpen=true;await writer.query('SELECT pg_advisory_xact_lock(73621941)');
  await writer.query('LOCK TABLE fresh.tokens IN ROW EXCLUSIVE MODE');
  const wrapped={
    query:db.query.bind(db),
    async connect(){
      const client=await db.connect();if(coreClientSeen)return client;coreClientSeen=true;
      corePid=(await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      return{
        async query(sql:string,params?:unknown[]){
          if(sql==='SELECT pg_advisory_xact_lock(73621941)'){
            financialWait();const result=await client.query(sql,params);
            // A real worker may finish ahead of startup in the lock queue.
            // Compare only the interval protected by startup's own lock.
            baseline=await fingerprint(client);return result;
          }
          if(sql.includes('CREATE SCHEMA IF NOT EXISTS fresh'))ddlStarted=true;
          if(sql==='COMMIT'){
            assert.deepEqual(await fingerprint(client),baseline,'startup_changed_existing_financial_records');coreFinancialUnchanged=true;
          }
          return client.query(sql,params);
        },
        release:()=>client.release(),
      };
    },
  } as unknown as Pool;
  const started=performance.now();startup=ensureFreshSchema(wrapped);startup.catch(()=>{});
  let waitTimer:ReturnType<typeof setTimeout>|undefined;
  try{await Promise.race([waiting,new Promise<never>((_resolve,reject)=>{waitTimer=setTimeout(()=>reject(Error('schema_financial_wait_not_reached')),5000);})]);}
  finally{if(waitTimer)clearTimeout(waitTimer);}
  let locks:any[]=[];
  for(let attempt=0;attempt<100;attempt++){
    locks=(await observer.query("SELECT locktype,mode,granted,relation::regclass::text AS relation,objid FROM pg_locks WHERE pid=$1 AND(locktype='advisory' OR relation IN('fresh.tokens'::regclass,'fresh.markets'::regclass))",[corePid])).rows;
    if(locks.some(row=>row.locktype==='advisory'&&Number(row.objid)===73621941&&!row.granted))break;
    await new Promise(resolve=>setTimeout(resolve,20));
  }
  assert.ok(locks.some(row=>row.locktype==='advisory'&&Number(row.objid)===73621940&&row.granted),'schema_guard_missing');
  assert.ok(locks.some(row=>row.locktype==='advisory'&&Number(row.objid)===73621941&&!row.granted),'schema_did_not_wait_for_writer');
  assert.equal(ddlStarted,false,'DDL_ran_before_financial_lock');assert.ok(locks.every(row=>row.locktype!=='relation'),'schema_took_financial_relation_lock_before_writer_finished');
  report.blockedSchemaLocks=locks;report.checks.push('startup_waits_on_financial_advisory_before_DDL');
  // This is the second relation in the real failure: the old DDL had locked
  // markets while waiting for tokens, preventing this writer from finishing.
  await writer.query("SET LOCAL lock_timeout='1000ms'");await writer.query('LOCK TABLE fresh.markets IN ROW EXCLUSIVE MODE');
  report.checks.push('held_writer_can_acquire_markets_and_finish');await writer.query('ROLLBACK');writerOpen=false;
  await startup;assert.equal(coreFinancialUnchanged,true);assert.equal(ddlStarted,true);
  report.checks.push('startup_completes_after_writer_release','all_existing_financial_fingerprints_unchanged','synthetic_writer_rolled_back','legacy_boundary_unchanged');
  report.elapsedMs=performance.now()-started;report.boundary=boundary;report.passed=true;
}catch(error){report.error=error instanceof Error?error.message:String(error);process.exitCode=1;}
finally{
  if(writerOpen)await writer.query('ROLLBACK');
  if(startup)await startup.catch(error=>{report.startupError=error instanceof Error?error.message:String(error);});
  writer.release();observer.release();await db.end();
  const directory='.cache/fresh/private/v14-accounting-gaps-20261024';await mkdir(directory,{recursive:true});
  await writeFile(directory+'/schema-concurrency-'+Date.now()+'.json',JSON.stringify(report,null,2),{flag:'wx'});console.log(JSON.stringify(report));
}
