/** Current quote/reorg commit race guards; every fixture row is rolled back. */
import assert from'node:assert/strict';import{randomBytes}from'node:crypto';import{Pool}from'pg';import{ZeroAddress}from'ethers';
import{commitFreshCurrentQuote,type FreshQuote}from'./pricing.js';import{FRESH_UNISWAP_V4_BSC_MANAGER as manager,freshStockwavePoolId}from'./stockwaveMarket.js';
const url=new URL(process.env.DATABASE_URL??'');if(!['127.0.0.1','localhost'].includes(url.hostname)||url.port!=='5436'||url.pathname!=='/kollens_fresh_20261022_24h')throw Error('isolated_fresh_database_required');
const db=new Pool({connectionString:url.toString(),max:1}),client=await db.connect(),address=()=>`0x${randomBytes(20).toString('hex')}`,hash=()=>`0x${randomBytes(32).toString('hex')}`;
const token=address(),quoteToken=address(),now=new Date(),calls:string[]=[];let serial=0;
// Each wrapper-owned transaction becomes a savepoint inside the immutable
// fixture transaction. A real PoolClient executes all ordinary SQL and locks.
const wrapped={connect:async()=>{const savepoint=`quote_commit_${++serial}`;return{release(){},query:async(sql:string,values?:unknown[])=>{
 calls.push(sql);if(sql==='BEGIN')return client.query(`SAVEPOINT ${savepoint}`);if(sql==='COMMIT')return client.query(`RELEASE SAVEPOINT ${savepoint}`);
 if(sql==='ROLLBACK'){await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);return client.query(`RELEASE SAVEPOINT ${savepoint}`);}
 return client.query(sql.replaceAll('fresh.checkpoints','fresh_quote_test_capture'),values);
 }};}}as unknown as Pool;
try{
 await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock(73621941)');
 const base=Number((await client.query("SELECT block_number FROM fresh.checkpoints WHERE key='capture'")).rows[0].block_number)+100,initial=base,observed=base+1;
 const creation=base-1,creationHash=hash(),initialHash=hash(),observedHash=hash(),currencies=[token,quoteToken].sort(),poolKey={currency0:currencies[0],currency1:currencies[1],fee:500,tickSpacing:10,hooks:ZeroAddress};
 const identity={version:1 as const,manager,poolId:freshStockwavePoolId(poolKey),poolKey,tokenAddress:token,quoteAddress:quoteToken,
  initial:{sqrtPriceX96:String(1n<<96n),tick:0,blockNumber:initial,blockHash:initialHash,transactionHash:hash(),logIndex:1}};
 const marketId=`uniswap_v4:${manager}:${identity.poolId}`,block={number:observed,hash:observedHash,timestamp:now.toISOString()};
 const quote:FreshQuote={tokenAddress:token,priceUsd:'2',marketCapUsd:'2000000',metadata:{address:token,name:'Fixture',symbol:'TEST',decimals:18,supplyRaw:String(10n**24n),block},
  market:{id:marketId,address:manager,protocol:'uniswap_v4',quoteAddress:quoteToken,identity:{manager,poolId:identity.poolId,poolKey,market:identity},state:{sqrtPriceX96:'1'}},
  blockNumber:observed,blockHash:observedHash,observedAt:now.toISOString()};
 await client.query('INSERT INTO fresh.tokens(address,launch_status) VALUES($1,\'eligible\')',[token]);
 await client.query(`INSERT INTO fresh.launch_facts(token_address,protocol,block_number,block_hash,tx_hash,launched_at,proof,status)
  VALUES($1,'evm_creation',$2,$3,$4,$5,'{}','eligible')`,[token,creation,creationHash,hash(),now]);
 for(const[number,blockHash]of[[creation,creationHash],[initial,initialHash],[observed,observedHash]]as const)await client.query('INSERT INTO fresh.recent_blocks(block_number,block_hash,parent_hash,occurred_at) VALUES($1,$2,$3,$4)',[number,blockHash,hash(),now]);
 await client.query('CREATE TEMP TABLE fresh_quote_test_capture(LIKE fresh.checkpoints INCLUDING DEFAULTS) ON COMMIT DROP');
 await client.query("INSERT INTO fresh_quote_test_capture(key,block_number,block_hash,value) VALUES('start',$1,$2,'{}')",[creation-1,hash()]);
 await client.query("INSERT INTO fresh_quote_test_capture(key,block_number,block_hash,revision,value,updated_at) VALUES('capture',$1,$2,991,'{}',$3),('health:capture',NULL,NULL,1,'{\"ok\":true}',$3)",[observed,observedHash,now]);
 await client.query("INSERT INTO fresh.markets(id,token_address,address,protocol,quote_address,identity,status) VALUES($1,$2,NULL,'uniswap_v4',$3,$4::jsonb,'pending')",[marketId,token,quoteToken,JSON.stringify(identity)]);
 await commitFreshCurrentQuote(wrapped,quote,{captureRevision:'991'});
 assert.equal((await client.query('SELECT price_usd::text FROM fresh.tokens WHERE address=$1',[token])).rows[0].price_usd,'2');
 assert.equal((await client.query('SELECT status FROM fresh.markets WHERE id=$1',[marketId])).rows[0].status,'ready');
 // Authenticity correction does not need a capture revision change. Its
 // locked launch status still invalidates an already completed observation.
 await client.query("UPDATE fresh.launch_facts SET status='excluded_non_token' WHERE token_address=$1",[token]);
 await assert.rejects(commitFreshCurrentQuote(wrapped,quote,{captureRevision:'991'}),/current_quote_token_changed/);
 await client.query("UPDATE fresh.launch_facts SET status='eligible' WHERE token_address=$1",[token]);
 await client.query("UPDATE fresh_quote_test_capture SET revision=992 WHERE key='capture'");
 await assert.rejects(commitFreshCurrentQuote(wrapped,quote,{captureRevision:'991'}),/current_quote_capture_changed/);
 await client.query("UPDATE fresh_quote_test_capture SET revision=991 WHERE key='capture'");
 for(const status of['pending','ready']){await client.query('UPDATE fresh.markets SET status=$2,identity=$3::jsonb WHERE id=$1',[marketId,status,JSON.stringify({market:identity,canonicalIdentityInvalid:true})]);
  await assert.rejects(commitFreshCurrentQuote(wrapped,quote,{captureRevision:991}),/current_quote_market_invalidated/);}
 await client.query('UPDATE fresh.markets SET identity=$2::jsonb WHERE id=$1',[marketId,JSON.stringify({market:identity})]);
 await client.query('UPDATE fresh.recent_blocks SET block_hash=$2 WHERE block_number=$1',[observed,hash()]);
 // A missing capture header is an invalid capture generation, before writes.
 await assert.rejects(commitFreshCurrentQuote(wrapped,quote,{captureRevision:991}),/current_quote_capture_changed/);
 await client.query('UPDATE fresh.recent_blocks SET block_hash=$2 WHERE block_number=$1',[observed,observedHash]);
 const wrongQuote={...quote,blockHash:hash(),metadata:{...quote.metadata,block:{...block,hash:hash()}}};wrongQuote.metadata.block.hash=wrongQuote.blockHash;
 await assert.rejects(commitFreshCurrentQuote(wrapped,wrongQuote,{captureRevision:991}),/current_quote_noncanonical/);
 await client.query('UPDATE fresh.recent_blocks SET block_hash=$2 WHERE block_number=$1',[initial,hash()]);
 await assert.rejects(commitFreshCurrentQuote(wrapped,quote,{captureRevision:991}),/current_quote_market_noncanonical/);
 await client.query('UPDATE fresh.recent_blocks SET block_hash=$2 WHERE block_number=$1',[initial,initialHash]);
 await client.query("UPDATE fresh_quote_test_capture SET value='{\"ok\":false}' WHERE key='health:capture'");
 await assert.rejects(commitFreshCurrentQuote(wrapped,quote,{captureRevision:991}),/current_quote_capture_changed/);
 await client.query("UPDATE fresh_quote_test_capture SET value='{\"ok\":true}',updated_at=$1 WHERE key='health:capture'",[new Date(Date.now()-91_000)]);
 await assert.rejects(commitFreshCurrentQuote(wrapped,quote,{captureRevision:991}),/current_quote_capture_changed/);
 await client.query("UPDATE fresh_quote_test_capture SET updated_at=clock_timestamp() WHERE key='health:capture'");
 await client.query('UPDATE fresh.recent_blocks SET occurred_at=$2 WHERE block_number=$1',[observed,new Date(Date.now()-21_000)]);
 await assert.rejects(commitFreshCurrentQuote(wrapped,quote,{captureRevision:991}),/current_quote_capture_changed/);
 await client.query('UPDATE fresh.recent_blocks SET occurred_at=$2 WHERE block_number=$1',[observed,now]);
 const ahead=(distance:number)=>({...quote,blockNumber:observed+distance,metadata:{...quote.metadata,block:{...block,number:observed+distance}}});
 for(const distance of[1,32,33])await assert.rejects(commitFreshCurrentQuote(wrapped,ahead(distance),{captureRevision:991}),/current_quote_observation_invalid/);
 assert.equal((await client.query('SELECT observed_block FROM fresh.tokens WHERE address=$1',[token])).rows[0].observed_block,String(observed));
 assert.ok(calls.some(sql=>sql.includes('pg_advisory_xact_lock(73621941)')));assert.ok(calls.some(sql=>sql.includes('FOR SHARE OF c,h,b')));
 console.log(JSON.stringify({ok:true,checks:['valid_same_revision_commit','stale_inflight_revision_rejected','launch_authenticity_correction_rejected_without_revision_change','pending_and_ready_invalidated_v4_rejected','canonical_quote_and_initialize_headers_checked','failed_stale_capture_health_rejected','uncaptured_quote_rejected','capture_locks_held_before_persistence'],fixtureWrites:'rolled back'}));
}finally{await client.query('ROLLBACK');client.release();await db.end();}
