/** Failed refresh races and expiry. Every fixture mutation is rolled back. */
import assert from'node:assert/strict';import{randomBytes}from'node:crypto';import{Pool}from'pg';
import{RpcRequestError,type Rpc}from'../rpc.js';import{FreshNoLiquidityError,commitFreshCurrentQuote,type FreshQuote}from'./pricing.js';
import{readFreshQuoteRefreshStates,observeFreshQuoteRefresh,commitFreshQuoteRefreshFailure}from'./quoteRefreshFailure.js';
const url=new URL(process.env.DATABASE_URL??'');if(!['127.0.0.1','localhost'].includes(url.hostname)||url.port!=='5436'||url.pathname!=='/kollens_fresh_20261022_24h')throw Error('isolated_fresh_database_required');
const db=new Pool({connectionString:url.href,max:1}),client=await db.connect(),address=()=>`0x${randomBytes(20).toString('hex')}`,hash=()=>`0x${randomBytes(32).toString('hex')}`;
const token=address(),pair=address(),quote=address(),now=Date.now(),stamp=new Date(now),old=new Date(now-88000),oldHash=hash(),headHash=hash(),transient=new RpcRequestError('rpc_unavailable','transport');let serial=0;
const wrap=(sql:string)=>sql.replaceAll('fresh.checkpoints','fresh_quote_failure_checkpoints');
const fixture={query:(sql:string,args?:unknown[])=>client.query(wrap(sql),args),connect:async()=>{const savepoint=`quote_failure_${++serial}`;return{release(){},query:async(sql:string,args?:unknown[])=>{
 if(sql==='BEGIN')return client.query(`SAVEPOINT ${savepoint}`);if(sql==='COMMIT')return client.query(`RELEASE SAVEPOINT ${savepoint}`);
 if(sql==='ROLLBACK'){await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);return client.query(`RELEASE SAVEPOINT ${savepoint}`);}return client.query(wrap(sql),args);
}};}}as unknown as Pool;
try{
 await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock(73621941)');
 const base=Number((await client.query("SELECT block_number FROM fresh.checkpoints WHERE key='capture'")).rows[0].block_number)+200,birth=base-2,observed=base-1,creationHash=hash();
 const block={number:base,hash:headHash,timestamp:stamp.toISOString()},marketId='pcs_v2:'+pair;
 for(const[number,blockHash,at]of[[birth,creationHash,old],[observed,oldHash,old],[base,headHash,stamp]]as const)await client.query('INSERT INTO fresh.recent_blocks(block_number,block_hash,parent_hash,occurred_at) VALUES($1,$2,$3,$4)',[number,blockHash,hash(),at]);
 await client.query('CREATE TEMP TABLE fresh_quote_failure_checkpoints(LIKE fresh.checkpoints INCLUDING DEFAULTS) ON COMMIT DROP');
 await client.query(`INSERT INTO fresh_quote_failure_checkpoints(key,block_number,block_hash,revision,value,updated_at) VALUES('capture',$1,$2,991,'{}',$3),('health:capture',NULL,NULL,1,'{"ok":true}',$3)`,[base,headHash,stamp]);
 await client.query(`INSERT INTO fresh.tokens(address,launch_status,valuation_status,price_source,decimals,total_supply_raw,price_usd,market_cap_usd,observed_block,observed_hash,observed_at)
  VALUES($1,'eligible','ready','node',18,100000000000000000000000000000000000001,'0.00000000000000000000000000000000012345','12345',$2,$3,$4)`,[token,observed,oldHash,old]);
 await client.query(`INSERT INTO fresh.launch_facts(token_address,protocol,block_number,block_hash,tx_hash,launched_at,proof,status) VALUES($1,'evm_creation',$2,$3,$4,$5,'{}','eligible')`,[token,birth,creationHash,hash(),old]);
 const identity={factory:address(),token0:token,token1:quote,fee:null};
 await client.query(`INSERT INTO fresh.markets(id,token_address,address,protocol,quote_address,identity,state,observed_block,observed_hash,observed_at,status) VALUES($1,$2,$3,'pcs_v2',$4,$5::jsonb,'{"reserve0":"1","reserve1":"1"}',$6,$7,$8,'ready')`,[marketId,token,pair,quote,JSON.stringify(identity),observed,oldHash,old]);
 const prior=(await readFreshQuoteRefreshStates(fixture,[token])).get(token)!;
 assert.equal(prior.token.total_supply_raw,'100000000000000000000000000000000000001');assert.equal(prior.token.price_usd,'0.00000000000000000000000000000000012345');
 const evidence=observeFreshQuoteRefresh((async()=>{throw transient;})as Rpc,block);await evidence.rpc('eth_call',[{to:token,data:'0x313ce567'},{blockHash:headHash,requireCanonical:true}]).catch(()=>{});
 const attempt={captureRevision:991,block,prior,evidence,now:()=>now},row=async()=>(await client.query('SELECT valuation_status,price_usd::text,market_cap_usd::text,observed_at,observed_block,observed_hash FROM fresh.tokens WHERE address=$1',[token])).rows[0];
 const before=await row();assert.equal((await commitFreshQuoteRefreshFailure(fixture,token,transient,attempt)).retained,true);assert.deepEqual(await row(),before);
 // The successful market observation may fail its capture commit while the
 // collector is briefly unhealthy. When capture recovers before this handler,
 // that guard result must not turn the still-valid original quote unavailable.
 const clean=observeFreshQuoteRefresh((async()=>{throw Error('no_rpc_expected');})as Rpc,block);
 await client.query(`UPDATE fresh_quote_failure_checkpoints SET value='{"ok":false}' WHERE key='health:capture'`);
 let guardError:unknown;try{await commitFreshCurrentQuote(fixture,{}as FreshQuote,{captureRevision:991});}catch(error){guardError=error;}
 assert.ok(guardError instanceof Error&&guardError.message==='current_quote_capture_changed');
 await client.query(`UPDATE fresh_quote_failure_checkpoints SET value='{"ok":true}' WHERE key='health:capture'`);
 assert.deepEqual(await commitFreshQuoteRefreshFailure(fixture,token,guardError,{...attempt,evidence:clean}),{retained:false,updated:false,reason:'capture_changed'});
 assert.deepEqual(await row(),before);
 await client.query("UPDATE fresh.tokens SET valuation_status='quote_unavailable' WHERE address=$1",[token]);
 const unavailableBeforeGuard=await row();assert.equal((await commitFreshQuoteRefreshFailure(fixture,token,new Error('current_quote_capture_changed'),{...attempt,evidence:clean})).updated,false);
 assert.deepEqual(await row(),unavailableBeforeGuard);await client.query("UPDATE fresh.tokens SET valuation_status='ready' WHERE address=$1",[token]);
 // A generic aggregate failure needs the underlying exact-block transient.
 assert.equal((await commitFreshQuoteRefreshFailure(fixture,token,new Error('authenticated_market_quote_unavailable'),attempt)).retained,true);
 const noPrior=await commitFreshQuoteRefreshFailure(fixture,token,transient,{...attempt,prior:undefined});assert.equal(noPrior.updated,false);assert.deepEqual(await row(),before);
 await client.query('UPDATE fresh_quote_failure_checkpoints SET revision=992 WHERE key=\'capture\'');assert.equal((await commitFreshQuoteRefreshFailure(fixture,token,transient,attempt)).updated,false);assert.deepEqual(await row(),before);await client.query('UPDATE fresh_quote_failure_checkpoints SET revision=991 WHERE key=\'capture\'');
 await client.query("UPDATE fresh.tokens SET price_usd='3' WHERE address=$1",[token]);assert.equal((await commitFreshQuoteRefreshFailure(fixture,token,new FreshNoLiquidityError(),attempt)).updated,false);assert.equal((await row()).valuation_status,'ready');await client.query('UPDATE fresh.tokens SET price_usd=$2 WHERE address=$1',[token,before.price_usd]);
 await client.query("UPDATE fresh.markets SET identity=jsonb_set(identity,'{canonicalIdentityInvalid}','true') WHERE id=$1",[marketId]);assert.equal((await commitFreshQuoteRefreshFailure(fixture,token,transient,attempt)).retained,false);assert.equal((await row()).valuation_status,'quote_unavailable');
 await client.query('UPDATE fresh.markets SET identity=$2::jsonb WHERE id=$1',[marketId,JSON.stringify(identity)]);await client.query("UPDATE fresh.tokens SET valuation_status='ready' WHERE address=$1",[token]);
 await client.query('UPDATE fresh.recent_blocks SET block_hash=$2 WHERE block_number=$1',[observed,hash()]);assert.equal((await commitFreshQuoteRefreshFailure(fixture,token,transient,attempt)).retained,false);await client.query('UPDATE fresh.recent_blocks SET block_hash=$2 WHERE block_number=$1',[observed,oldHash]);await client.query("UPDATE fresh.tokens SET valuation_status='ready' WHERE address=$1",[token]);
 assert.equal((await commitFreshQuoteRefreshFailure(fixture,token,new FreshNoLiquidityError(),attempt)).retained,false);assert.equal((await row()).valuation_status,'no_liquidity');
 const unavailable=(await readFreshQuoteRefreshStates(fixture,[token])).get(token)!;assert.equal((await commitFreshQuoteRefreshFailure(fixture,token,transient,{...attempt,prior:unavailable})).retained,false);
 await client.query("UPDATE fresh.tokens SET valuation_status='ready' WHERE address=$1",[token]);
 const expired=new Date(now-120001);await client.query('UPDATE fresh.tokens SET observed_at=$2 WHERE address=$1',[token,expired]);await client.query('UPDATE fresh.markets SET observed_at=$2 WHERE id=$1',[marketId,expired]);await client.query('UPDATE fresh.recent_blocks SET occurred_at=$2 WHERE block_number=$1',[observed,expired]);
 const expiredPrior=(await readFreshQuoteRefreshStates(fixture,[token])).get(token)!;assert.equal((await commitFreshQuoteRefreshFailure(fixture,token,transient,{...attempt,prior:expiredPrior})).retained,false);assert.equal((await row()).valuation_status,'quote_unavailable');
 assert.equal(new Date((await row()).observed_at).getTime(),expired.getTime());assert.equal((await row()).observed_hash,oldHash);
 console.log(JSON.stringify({ok:true,checks:['ready88second_quote_retained_exactly','recovered_capture_commit_guard_does_not_downgrade_or_freshen_original_quote','capture_commit_guard_does_not_promote_unavailable_quote','no_json_number_precision_loss','aggregate_requires_transient_evidence','missing_baseline_no_mutation','reorg_generation_rejected','newer_success_wins_over_older_failure','invalidated_market_and_noncanonical_quote_not_retained','no_liquidity_and_unavailable_never_promoted','no_timestamp_or_block_freshening'],fixtureWrites:'rolled back',externalRequests:0}));
}finally{await client.query('ROLLBACK');client.release();await db.end();}
