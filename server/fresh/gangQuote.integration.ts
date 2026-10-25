/** Admission/quote rehearsal uses only temporary tables and rolls them back. */
import assert from'node:assert/strict';
import{randomBytes}from'node:crypto';
import{Pool}from'pg';
import{RpcRequestError,type Rpc}from'../rpc.js';
import{WBNB,PCS_V2_FACTORY}from'../launchpad.js';
import{commitFreshCurrentQuote,type FreshQuote}from'./pricing.js';
import{selectFreshQuote}from'./quoteQueue.js';
import{freshQuoteWorkSql}from'./worker.js';
import{readFreshQuoteRefreshStates,observeFreshQuoteRefresh,commitFreshQuoteRefreshFailure}from'./quoteRefreshFailure.js';
import{GANG_TOKEN_ADDRESS,freshTokenAdmissionKey,type FreshExistingTokenPermission}from'./tracking.js';

const url=new URL(process.env.DATABASE_URL??'');
if(!['127.0.0.1','localhost'].includes(url.hostname)||url.port!=='5436'||url.pathname!=='/kollens_fresh_20261022_24h')throw Error('isolated_fresh_database_required');
const pool=new Pool({connectionString:url.href,max:1}),client=await pool.connect(),hash=()=>`0x${randomBytes(32).toString('hex')}`;
const rewrite=(sql:string)=>sql.replaceAll('fresh.','pg_temp.');let serial=0;
const fixture={query:(sql:string,args?:unknown[])=>client.query(rewrite(sql),args),connect:async()=>{const savepoint=`gang_quote_${++serial}`;return{release(){},query:async(sql:string,args?:unknown[])=>{
 if(sql==='BEGIN')return client.query(`SAVEPOINT ${savepoint}`);if(sql==='COMMIT')return client.query(`RELEASE SAVEPOINT ${savepoint}`);
 if(sql==='ROLLBACK'){await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);return client.query(`RELEASE SAVEPOINT ${savepoint}`);}return client.query(rewrite(sql),args);
}};}}as unknown as Pool;
const now=Date.now(),startTime=new Date(now-90_000).toISOString(),oldTime=new Date(now-88_000).toISOString(),headTime=new Date(now).toISOString();
const startHash=hash(),oldHash=hash(),headHash=hash(),permission:FreshExistingTokenPermission={version:1,kind:'explicit_existing',chainId:56,tokenAddress:GANG_TOKEN_ADDRESS,active:true,
 startBlock:100,startHash,startTime,fromBlock:101,approvedAt:headTime,reason:'user_approved_gang_only'};
const oldBlock={number:101,hash:oldHash,timestamp:oldTime},head={number:102,hash:headHash,timestamp:headTime},pair='0x'+'2'.repeat(40),other='0x'+'3'.repeat(40);
const quote:FreshQuote={tokenAddress:GANG_TOKEN_ADDRESS,priceUsd:'2',marketCapUsd:'2000000',metadata:{address:GANG_TOKEN_ADDRESS,name:'Gang',symbol:'GANG',decimals:18,supplyRaw:'1000000000000000000000000',block:oldBlock},
 market:{id:'pcs_v2:'+pair,address:pair,protocol:'pcs_v2',quoteAddress:WBNB,identity:{factory:PCS_V2_FACTORY,token0:GANG_TOKEN_ADDRESS,token1:WBNB,fee:null},state:{reserve0:'100000000000000000000',reserve1:'1000000000000000000'}},
 blockNumber:101,blockHash:oldHash,observedAt:oldTime};
const key=freshTokenAdmissionKey(GANG_TOKEN_ADDRESS),checks:string[]=[];
try{
 await client.query('BEGIN');await client.query("SET LOCAL statement_timeout='5s'");
 for(const table of['checkpoints','tokens','launch_facts','recent_blocks','markets','jobs','positions','accounting_scopes','scope_event_results','financial_events'])
  await client.query(`CREATE TEMP TABLE ${table}(LIKE fresh.${table} INCLUDING ALL) ON COMMIT DROP`);
 await fixture.query(`INSERT INTO fresh.checkpoints(key,block_number,block_hash,value,revision,updated_at) VALUES
 ('start',100,$1,$2,1,$5),('capture',102,$3,'{}',991,$5),('health:capture',NULL,NULL,'{"ok":true}',1,$5),($6,NULL,NULL,$4,1,$5)`,
 [startHash,JSON.stringify({startBlock:100,startHash,startTime}),headHash,JSON.stringify(permission),headTime,key]);
 for(const[number,h,time]of[[100,startHash,startTime],[101,oldHash,oldTime],[102,headHash,headTime]]as const)
  await fixture.query('INSERT INTO fresh.recent_blocks(block_number,block_hash,parent_hash,occurred_at) VALUES($1,$2,$3,$4)',[number,h,hash(),time]);
 await fixture.query("INSERT INTO fresh.tokens(address,launch_status,last_trade_at) VALUES($1,'preexisting',$3),($2,'preexisting',$3)",[GANG_TOKEN_ADDRESS,other,headTime]);
 await selectFreshQuote(fixture,GANG_TOKEN_ADDRESS);await selectFreshQuote(fixture,other);
 assert.deepEqual((await fixture.query('SELECT reference FROM fresh.jobs')).rows,[{reference:GANG_TOKEN_ADDRESS}]);
 await fixture.query('UPDATE fresh.jobs SET due_at=$1',[headTime]);
 const work=(await fixture.query(freshQuoteWorkSql,[headTime])).rows;assert.equal(work.length,1);assert.equal(work[0].address,GANG_TOKEN_ADDRESS);assert.equal(work[0].launch_fact,null);
 checks.push('selected and ordinary quote work admits only explicitly permitted GANG with no launch fact');
 await commitFreshCurrentQuote(fixture,quote,{captureRevision:991});
 assert.deepEqual((await fixture.query('SELECT launch_status,price_usd::text,market_cap_usd::text FROM fresh.tokens WHERE address=$1',[GANG_TOKEN_ADDRESS])).rows[0],{launch_status:'preexisting',price_usd:'2',market_cap_usd:'2000000'});
 assert.equal((await fixture.query('SELECT count(*)::int AS n FROM fresh.launch_facts')).rows[0].n,0);
 checks.push('authenticated ordinary-market observation persists without inventing token creation');
 await assert.rejects(commitFreshCurrentQuote(fixture,{...quote,market:{...quote.market,protocol:'uniswap_v4'}},{captureRevision:991}),/current_quote_market_admission_unsupported/);
 checks.push('existing-token permission cannot authorize V4 launch or Initialize evidence');
 const prior=(await readFreshQuoteRefreshStates(fixture,[GANG_TOKEN_ADDRESS])).get(GANG_TOKEN_ADDRESS)!;
 const transient=new RpcRequestError('rpc_unavailable','transport'),evidence=observeFreshQuoteRefresh((async()=>{throw transient;})as Rpc,head);
 await evidence.rpc('eth_call',[{to:GANG_TOKEN_ADDRESS,data:'0x313ce567'},{blockHash:headHash,requireCanonical:true}]).catch(()=>{});
 const attempt={captureRevision:991,block:head,prior,evidence,now:()=>now};
 const before=(await fixture.query('SELECT to_jsonb(t) AS row FROM fresh.tokens t WHERE address=$1',[GANG_TOKEN_ADDRESS])).rows[0].row;
 assert.equal((await commitFreshQuoteRefreshFailure(fixture,GANG_TOKEN_ADDRESS,transient,attempt)).retained,true);
 assert.deepEqual((await fixture.query('SELECT to_jsonb(t) AS row FROM fresh.tokens t WHERE address=$1',[GANG_TOKEN_ADDRESS])).rows[0].row,before);
 checks.push('temporary refresh failure retains only the original dated quote without freshening');
 for(const bad of[{...permission,active:false},{...permission,startHash:hash()},{...permission,tokenAddress:other}]){
  await fixture.query('UPDATE fresh.checkpoints SET value=$2 WHERE key=$1',[key,JSON.stringify(bad)]);
  await assert.rejects(commitFreshCurrentQuote(fixture,quote,{captureRevision:991}),/current_quote_token_changed/);
  assert.deepEqual((await fixture.query(freshQuoteWorkSql,[headTime])).rows,[]);
  const result=await commitFreshQuoteRefreshFailure(fixture,GANG_TOKEN_ADDRESS,transient,attempt);assert.equal(result.updated,false);assert.equal(result.retained,false);
 }
 await fixture.query('DELETE FROM fresh.checkpoints WHERE key=$1',[key]);
 await assert.rejects(commitFreshCurrentQuote(fixture,quote,{captureRevision:991}),/current_quote_token_changed/);
 assert.equal((await commitFreshQuoteRefreshFailure(fixture,GANG_TOKEN_ADDRESS,transient,attempt)).updated,false);
 checks.push('revoked, mismatched and missing permissions reject both commit and retention without mutations');
 await fixture.query('INSERT INTO fresh.checkpoints(key,value) VALUES($1,$2)',[key,JSON.stringify(permission)]);
 await assert.rejects(commitFreshCurrentQuote(fixture,{...quote,tokenAddress:other,metadata:{...quote.metadata,address:other}},{captureRevision:991}),/current_quote_token_changed/);
 await fixture.query("INSERT INTO fresh.launch_facts(token_address,protocol,block_number,block_hash,tx_hash,launched_at,proof,status) VALUES($1,'evm_creation',99,$2,$3,$4,'{}','excluded_non_token')",[GANG_TOKEN_ADDRESS,hash(),hash(),startTime]);
 await assert.rejects(commitFreshCurrentQuote(fixture,quote,{captureRevision:991}),/current_quote_token_changed/);
 checks.push('another old token cannot borrow permission and authenticated non-token exclusions still win');
 console.log(JSON.stringify({ok:true,checks,temporaryTablesOnly:true,persistentRowsWritten:0,externalRequests:0}));
}finally{await client.query('ROLLBACK');client.release();await pool.end();}
