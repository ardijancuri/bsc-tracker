/** Session-temporary fixtures only; every application write is rolled back. */
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import sharp from 'sharp';
import {Pool} from 'pg';
import {runFreshArtwork,type FreshArtwork} from './artwork.js';
import {selectFreshQuote} from './quoteQueue.js';
const url=new URL(process.env.DATABASE_URL??'');
if(!['127.0.0.1','localhost'].includes(url.hostname)||url.port!=='5436'||!url.pathname.startsWith('/kollens_fresh_'))throw Error('Local fresh artwork fixtures only');
const db=new Pool({connectionString:url.toString(),max:1}),client=await db.connect();
const address=()=>`0x${randomBytes(20).toString('hex')}`,wallet=address(),privateWallet=address(),token=address(),privateToken=address();
const tables=['tokens','jobs','financial_events','kols','launch_facts'];
const fixtureDb={query:(sql:string,values?:unknown[])=>{for(const name of tables)sql=sql.replaceAll(`fresh.${name}`,`artwork_fixture_${name}`);return client.query(sql,values);}} as unknown as Pool;
try{
 await client.query('BEGIN');
 for(const name of tables)await client.query(`CREATE TEMP TABLE artwork_fixture_${name}(LIKE fresh.${name} INCLUDING DEFAULTS) ON COMMIT DROP`);
 await client.query('CREATE UNIQUE INDEX ON artwork_fixture_jobs(kind,reference)');
 await client.query("INSERT INTO artwork_fixture_kols(wallet_address,display_name) VALUES($1,'Public artwork test')",[wallet]);
 for(const t of[token,privateToken]){
  await client.query("INSERT INTO artwork_fixture_tokens(address,name,symbol,launch_status,last_trade_at) VALUES($1,'Artwork','ART','eligible',now())",[t]);
  await client.query("INSERT INTO artwork_fixture_launch_facts(token_address,protocol,block_number,block_hash,tx_hash,launched_at,proof,status) VALUES($1,'flap',1,$2,$2,now(),'{}','eligible')",[t,'0x'+'a'.repeat(64)]);
  await client.query(`INSERT INTO artwork_fixture_financial_events(id,execution_key,wallet_address,token_address,kind,quantity,amount_usd,fee_usd,block_number,block_hash,transaction_hash,transaction_index,execution_index,occurred_at)
   VALUES($1,$1,$2,$3,'buy','1','1','0',1,$4,$4,0,0,now())`,[t,t===token?wallet:privateWallet,t,'0x'+'a'.repeat(64)]);
 }
 const data=await sharp({create:{width:16,height:16,channels:3,background:'#f0b90b'}}).webp().toBuffer();
 const image:FreshArtwork={data,mime:'image/webp',url:'https://public.example/art.webp',source:'flap_contract_page'};
 let calls=0,release!:()=>void,entered!:()=>void;
 const started=new Promise<void>(resolve=>entered=resolve),waiting=new Promise<void>(resolve=>release=resolve);
 const first=runFreshArtwork(fixtureDb,{loader:async selected=>{assert.equal(selected,token);calls++;entered();await waiting;return image;}});
 await started;
 assert.deepEqual(await runFreshArtwork(fixtureDb,{loader:async()=>{throw Error('duplicate_work');}}),{ready:0,failed:0});
 release();assert.deepEqual(await first,{ready:1,failed:0});assert.equal(calls,1);
 assert.equal((await client.query('SELECT count(*)::int n FROM artwork_fixture_jobs')).rows[0].n,0,'Completed jobs do not accumulate');
 const saved=(await client.query('SELECT logo_data,logo_mime,price_usd FROM artwork_fixture_tokens WHERE address=$1',[token])).rows[0];assert.ok(saved.logo_data.equals(data));assert.equal(saved.logo_mime,'image/webp');assert.equal(saved.price_usd,null);
 assert.equal((await client.query('SELECT logo_data FROM artwork_fixture_tokens WHERE address=$1',[privateToken])).rows[0].logo_data,null);
 // A reorg during HTTP must prevent caching and must not strand a done job.
 await client.query('UPDATE artwork_fixture_tokens SET logo_data=NULL WHERE address=$1',[token]);
 assert.deepEqual(await runFreshArtwork(fixtureDb,{loader:async()=>{await client.query('UPDATE artwork_fixture_financial_events SET canonical=false WHERE token_address=$1',[token]);return image;}}),{ready:0,failed:0});
 assert.equal((await client.query('SELECT count(*)::int n FROM artwork_fixture_jobs')).rows[0].n,0);
 assert.equal((await client.query('SELECT logo_data FROM artwork_fixture_tokens WHERE address=$1',[token])).rows[0].logo_data,null);
 await client.query('UPDATE artwork_fixture_financial_events SET canonical=true WHERE token_address=$1',[token]);
 assert.deepEqual(await runFreshArtwork(fixtureDb,{loader:async()=>image}),{ready:1,failed:0});
 // Failed optional media work records bounded backoff and never changes money.
 await client.query('UPDATE artwork_fixture_tokens SET logo_data=NULL WHERE address=$1',[token]);
 assert.deepEqual(await runFreshArtwork(fixtureDb,{loader:async()=>{throw Error('private_response');}}),{ready:0,failed:1});
 const retry=(await client.query("SELECT state,last_error,due_at>clock_timestamp()+interval '59 minutes' AS bounded FROM artwork_fixture_jobs WHERE reference=$1",[token])).rows[0];
 assert.deepEqual(retry,{state:'pending',last_error:'artwork_unavailable',bounded:true});
 assert.deepEqual(await runFreshArtwork(fixtureDb,{loader:async()=>{throw Error('cooldown_ignored');}}),{ready:0,failed:0});
 await client.query(`INSERT INTO artwork_fixture_jobs(id,kind,reference,due_at,last_error) VALUES($1,'quote',$2,now()+interval '60 seconds','no_liquidity')`,['quote:'+token,token]);
 await selectFreshQuote(fixtureDb,token);
 assert.equal((await client.query("SELECT due_at>now()+interval '59 seconds' AS cooldown FROM artwork_fixture_jobs WHERE kind='quote' AND reference=$1",[token])).rows[0].cooldown,true,'Page polling cannot bypass confirmed no-liquidity backoff');
 await client.query("UPDATE artwork_fixture_jobs SET last_error='quote_unavailable' WHERE kind='quote' AND reference=$1",[token]);
 await selectFreshQuote(fixtureDb,token);
 assert.equal((await client.query("SELECT due_at<=now() AS promoted FROM artwork_fixture_jobs WHERE kind='quote' AND reference=$1",[token])).rows[0].promoted,true,'Selected uncertain quotes retain foreground promotion');
 console.log(JSON.stringify({ok:true,checks:['exact_public_selection','private_only_never_fetched','concurrent_lease_coalescing','normalized_cache_only','completed_jobs_removed','reorg_while_loading','zero_save_reschedules','failure_backoff','no_financial_changes'],fixtureWrites:'session temporary and rolled back',externalRequests:0}));
}finally{await client.query('ROLLBACK');client.release();await db.end();}
