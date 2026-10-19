import assert from'node:assert/strict';
import pg from'pg';
import{writeNodeTradeProjection}from'./nodeTradeProjection.js';
import{projectionFixture,projectionWallet}from'./nodeTradeProjection.fixture.js';
const connection=new URL(process.env.DATABASE_URL??'');
if(!['127.0.0.1','localhost'].includes(connection.hostname)||connection.port!=='5435'||!/^\/bscan_node_projection_test_\d+$/.test(connection.pathname))throw Error('Disposable local projection database only');
const pool=new pg.Pool({connectionString:connection.href,max:2,connectionTimeoutMillis:3000}),{input,prepared}=projectionFixture();
try{
 await pool.query(`CREATE TABLE kols(address text PRIMARY KEY,last_seen_at timestamptz);CREATE TABLE trades(id text PRIMARY KEY,tx_hash text,wallet_address text,token_address text,
  side text,token_amount numeric,quote_token_address text,quote_symbol text,quote_amount numeric,amount_usd numeric,price_usd numeric,block_number bigint,block_hash text,timestamp timestamptz,
  source text,verification_attempted_at timestamptz,transaction_index integer,execution_id text,observed_live boolean default false);
  CREATE UNIQUE INDEX legacy_trade ON trades(tx_hash,wallet_address,token_address) WHERE execution_id IS NULL;
  CREATE UNIQUE INDEX execution_trade ON trades(execution_id,token_address) WHERE execution_id IS NOT NULL;`);
 await pool.query('INSERT INTO kols(address)VALUES($1)',[projectionWallet]);
 const writer=await pool.connect(),collector=await pool.connect();let queued:Promise<unknown>|undefined;
 try{
  await writer.query('BEGIN');await writer.query('SELECT pg_advisory_xact_lock_shared(782319)');
  const collectorPid=(await collector.query('SELECT pg_backend_pid()AS pid')).rows[0].pid;
  await collector.query('BEGIN');const blocked=collector.query('SELECT pg_advisory_xact_lock(782319)');
  for(let attempt=0;attempt<100;attempt++){
   const wait=(await writer.query(`SELECT cardinality(pg_blocking_pids($1))AS n`,[collectorPid])).rows[0].n;
   if(wait>0)break;if(attempt===99)throw Error('Collector did not queue behind projection');await new Promise(resolve=>setTimeout(resolve,5));
  }
  queued=pool.query('SELECT 1');await new Promise(resolve=>setImmediate(resolve));assert.equal(pool.waitingCount,1,'Every pool connection is held; a new global query cannot run');
  await writeNodeTradeProjection(writer,input,prepared);await writer.query('COMMIT');
  await blocked;await collector.query('COMMIT');
  const result=(await writer.query('SELECT token_amount::text,quote_amount::text,amount_usd::text,price_usd::text,observed_live FROM trades')).rows[0];
  assert.deepEqual(result,{token_amount:'5',quote_amount:'1',amount_usd:'600',price_usd:'120',observed_live:true});
 }finally{await writer.query('ROLLBACK');await collector.query('ROLLBACK');writer.release();collector.release();await queued;}
 console.log('Prepared trade projection PostgreSQL regression passed: actual writer commits under exhausted pool and releases queued collection lock.');
}finally{await pool.end()}
