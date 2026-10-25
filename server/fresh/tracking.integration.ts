/** Local temporary-table rehearsal; no persistent schema/data changes. */
import assert from 'node:assert/strict';
import pg from 'pg';
import {freshTrackedTokenSql,freshTrackedEventSql,validFreshExistingTokenPermission,readFreshTokenAdmission,GANG_TOKEN_ADDRESS,type FreshExistingTokenPermission} from './tracking.js';
const url=new URL(process.env.DATABASE_URL??'');
if(!['127.0.0.1','localhost'].includes(url.hostname)||url.port!=='5436'||url.pathname!=='/kollens_fresh_20261022_24h')throw Error('tracking_rehearsal_local_database_only');
const pool=new pg.Pool({connectionString:url.href,max:1}),client=await pool.connect();
const sql=(s:string)=>s.replaceAll('fresh.','pg_temp.'),db={query:(s:string,p?:unknown[])=>client.query(sql(s),p)} as any;
const start={block_number:'100',block_hash:'0x'+'a'.repeat(64),value:{startBlock:100,startHash:'0x'+'a'.repeat(64),startTime:'2026-10-25T02:42:03.000Z'}};
const permission:FreshExistingTokenPermission={version:1,kind:'explicit_existing',chainId:56,tokenAddress:GANG_TOKEN_ADDRESS,active:true,startBlock:100,startHash:start.block_hash,startTime:start.value.startTime,fromBlock:101,approvedAt:'2026-10-25T12:00:00.000Z',reason:'user_approved_gang_only'};
const checks:string[]=[];
try{
 await client.query('BEGIN');await client.query("SET LOCAL statement_timeout='5s'");
 await client.query(`CREATE TEMP TABLE checkpoints(key text PRIMARY KEY,block_number bigint,block_hash text,value jsonb NOT NULL);
 CREATE TEMP TABLE launch_facts(token_address text PRIMARY KEY,status text,block_number bigint,block_hash text);
 CREATE TEMP TABLE tokens(address text PRIMARY KEY,launch_status text);
 CREATE TEMP TABLE events(id text PRIMARY KEY,token_address text,block_number bigint,occurred_at timestamptz);`);
 await client.query('INSERT INTO pg_temp.checkpoints VALUES($1,$2,$3,$4)', ['start',100,start.block_hash,start.value]);
 await client.query('INSERT INTO pg_temp.checkpoints VALUES($1,NULL,NULL,$2)',['token_admission:'+GANG_TOKEN_ADDRESS,permission]);
 await client.query('INSERT INTO pg_temp.tokens VALUES($1,$2),($3,$2),($4,$5)',[GANG_TOKEN_ADDRESS,'preexisting','0x'+'b'.repeat(40),'0x'+'c'.repeat(40),'eligible']);
 const candidates:unknown[]=[permission,{...permission,active:false},{...permission,tokenAddress:'0x'+'b'.repeat(40)},{...permission,chainId:1},{...permission,fromBlock:100},
 {...permission,startBlock:'100'},{...permission,startHash:'0x'+'b'.repeat(64)},{...permission,startTime:'2026-10-25T02:42:04.000Z'},
 {...permission,approvedAt:'2026-02-30T12:00:00.000Z'},{...permission,approvedAt:'2026-10-25T24:00:00.000Z'},{...permission,approvedAt:'0000-01-01T00:00:00.000Z'},
 {...permission,approvedAt:'2026-10-25T12:00:00Z'},{...permission,extra:true},{version:1},[],null];
 for(const p of candidates){await client.query('UPDATE pg_temp.checkpoints SET value=$1 WHERE key=$2',[JSON.stringify(p),'token_admission:'+GANG_TOKEN_ADDRESS]);
  const expected=validFreshExistingTokenPermission(p,start),rows=(await db.query(`SELECT t.address,${freshTrackedTokenSql('t')} AS allowed FROM fresh.tokens t ORDER BY address`)).rows;
  assert.equal(Boolean(rows.find((r:any)=>r.address===GANG_TOKEN_ADDRESS).allowed),expected);assert.equal(Boolean(rows.find((r:any)=>r.address==='0x'+'b'.repeat(40)).allowed),false);
  assert.equal(Boolean(rows.find((r:any)=>r.address==='0x'+'c'.repeat(40)).allowed),true);
  assert.equal((await readFreshTokenAdmission(db,GANG_TOKEN_ADDRESS,{blockNumber:101,lock:true}))!==null,expected);
 }
 checks.push('SQL and JS agree for valid, revoked, malformed, wrong-chain, wrong-contract and noncanonical-date permissions; other older tokens stay excluded');
 await client.query('UPDATE pg_temp.checkpoints SET value=$1 WHERE key=$2',[permission,'token_admission:'+GANG_TOKEN_ADDRESS]);
 await client.query('INSERT INTO pg_temp.events VALUES($1,$4,$5,$6),($2,$4,$7,$6),($3,$4,$7,$8)',['before-block','valid','before-time',GANG_TOKEN_ADDRESS,100,permission.startTime,101,'2026-10-25T02:42:02.000Z']);
 const visible=(await db.query(`SELECT e.id FROM fresh.events e JOIN fresh.tokens t ON t.address=e.token_address WHERE ${freshTrackedEventSql('e','t')} ORDER BY e.id`)).rows;
 assert.deepEqual(visible,[{id:'valid'}]);checks.push('GANG events before the original collection block/time are not published');
 await client.query('INSERT INTO pg_temp.launch_facts VALUES($1,$2,$3,$4)',[GANG_TOKEN_ADDRESS,'excluded_non_token',90,start.block_hash]);
 assert.equal((await db.query(`SELECT ${freshTrackedTokenSql('t')} AS allowed FROM fresh.tokens t WHERE address=$1`,[GANG_TOKEN_ADDRESS])).rows[0].allowed,false);
 assert.equal(await readFreshTokenAdmission(db,GANG_TOKEN_ADDRESS,{blockNumber:200,lock:true}),null);checks.push('An authenticated non-token exclusion overrides the exception');
 await client.query('DELETE FROM pg_temp.launch_facts');
 await client.query("UPDATE pg_temp.checkpoints SET block_hash=$1 WHERE key='start'",['0x'+'f'.repeat(64)]);
 assert.equal((await db.query(`SELECT ${freshTrackedTokenSql('t')} AS allowed FROM fresh.tokens t WHERE address=$1`,[GANG_TOKEN_ADDRESS])).rows[0].allowed,false);
 assert.equal(await readFreshTokenAdmission(db,GANG_TOKEN_ADDRESS),null);checks.push('Changing the tracking boundary invalidates the permission');
 await client.query('ROLLBACK');
 console.log(JSON.stringify({ok:true,checks,temporaryTablesOnly:true,persistentRowsWritten:0,databasesCreated:0,databasesDeleted:0,networkRequests:0}));
}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();await pool.end();}
