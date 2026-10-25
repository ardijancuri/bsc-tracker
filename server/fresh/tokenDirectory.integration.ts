/** Session-temporary fixtures only; no application rows or external requests. */
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {Pool} from 'pg';
import {readFreshTokenDirectory} from './tokenDirectory.js';

const url=new URL(process.env.DATABASE_URL??'');
if(!['127.0.0.1','localhost'].includes(url.hostname)||url.port!=='5436'||!url.pathname.startsWith('/kollens_fresh_'))throw Error('Local fresh directory fixtures only');
const db=new Pool({connectionString:url.toString(),max:1}),client=await db.connect(),now=Date.parse('2026-10-24T12:00:00Z');
const address=()=>`0x${randomBytes(20).toString('hex')}`,hash=()=>`0x${randomBytes(32).toString('hex')}`;
const publicWallet=address(),privateWallet=address(),untrackedWallet=address();
const tables=['tokens','financial_events','kols','recent_blocks','checkpoints'];
const fixtureDb={query:(sql:string,values?:unknown[])=>{for(const name of tables)sql=sql.replaceAll(`fresh.${name}`,`directory_fixture_${name}`);
  sql=sql.replaceAll('published_kols','directory_fixture_published_kols');return client.query(sql,values);}} as unknown as Pool;
let block=1;
const token=async(options:{status?:string;launch?:string;symbol?:string;globalLast?:number}={})=>{
  const key=address();await client.query(`INSERT INTO directory_fixture_tokens(address,name,symbol,launch_status,valuation_status,last_trade_at)
    VALUES($1,'Directory token',$2,$3,$4,$5)`,[key,options.symbol??'MEME',options.launch??'eligible',options.status??'ready',new Date(options.globalLast??now)]);return key;
};
const trade=async(key:string,at:number,options:{wallet?:string;kind?:string;canonical?:boolean;live?:boolean;orphan?:boolean;ahead?:boolean}={})=>{
  const number=options.ahead?2000:block++,canonicalHash=hash(),eventHash=options.orphan?hash():canonicalHash,id=hash();
  await client.query('INSERT INTO directory_fixture_recent_blocks(block_number,block_hash,parent_hash,occurred_at) VALUES($1,$2,$3,$4)',[number,canonicalHash,hash(),new Date(at)]);
  await client.query(`INSERT INTO directory_fixture_financial_events(id,execution_key,wallet_address,token_address,kind,quantity,amount_usd,fee_usd,block_number,block_hash,transaction_hash,transaction_index,execution_index,occurred_at,canonical,observed_live)
    VALUES($1,$1,$2,$3,$4,'1','1','0',$5,$6,$1,0,0,$7,$8,$9)`,[id,options.wallet??publicWallet,key,options.kind??'buy',number,eventHash,new Date(at),options.canonical??true,options.live??true]);return id;
};
try{
 await client.query('BEGIN');
 for(const name of tables)await client.query(`CREATE TEMP TABLE directory_fixture_${name}(LIKE fresh.${name} INCLUDING DEFAULTS) ON COMMIT DROP`);
 await client.query(`CREATE TEMP TABLE directory_fixture_published_kols(address text,display_name text,avatar_url text,twitter text) ON COMMIT DROP`);
 await client.query(`INSERT INTO directory_fixture_checkpoints(key,block_number) VALUES('capture',1000)`);
 await client.query(`INSERT INTO directory_fixture_kols(wallet_address,is_tracked) VALUES($1,true),($2,false)`,[publicWallet,untrackedWallet]);
 await client.query(`INSERT INTO directory_fixture_published_kols(address,display_name) VALUES($1,'Public KOL')`,[publicWallet]);
 const newest=await token(),delayed=await token(),unpriced=await token({status:'pending'}),old=await token({globalLast:now+10_000}),boundary=await token(),expired=await token();
 await client.query(`UPDATE directory_fixture_tokens SET price_usd=0.01,market_cap_usd=50000,observed_at=$1 WHERE address=ANY($2::text[])`,[new Date(now-30_000),[newest,delayed]]);
 await client.query("UPDATE directory_fixture_tokens SET valuation_status='quote_unavailable' WHERE address=$1",[delayed]);
 await trade(newest,now-1000,{kind:'sell'});await trade(delayed,now-2000,{live:false});await trade(unpriced,now-3000);
 await trade(old,now-3600_000);await trade(old,now,{wallet:privateWallet});await trade(old,now-9*3600_000);
 await trade(boundary,now-8*3600_000);await trade(expired,now-8*3600_000-1);
 const privateRenewal=await token({globalLast:now});await trade(privateRenewal,now-9*3600_000);await trade(privateRenewal,now,{wallet:privateWallet});
 for(const options of[{wallet:privateWallet},{wallet:untrackedWallet},{kind:'transfer_in'},{canonical:false},{orphan:true},{ahead:true}])await trade(await token(),now-500,options);
 await trade(await token({status:'no_liquidity'}),now-500);await trade(await token({launch:'unverified'}),now-500);await trade(await token({symbol:'USDT'}),now-500);
 const future=await token(),futureEvent=await trade(future,now+1);
 const first=await readFreshTokenDirectory(fixtureDb,{now,limit:2,withTrades:true});
 assert.equal(first.total,5);assert.deepEqual(first.items.map(item=>item.address),[newest,delayed]);assert.equal(first.nextOffset,2);
 assert.equal((await readFreshTokenDirectory(fixtureDb,{now})).items.some(item=>item.address===privateRenewal),false,'A newer private trade cannot renew a token whose last public trade expired');
 assert.equal(first.items[0].marketCapUsd,'50000');assert.equal(first.items[1].marketCapUsd,null,'Failed refresh cannot publish retained old cap as current');
 assert.equal((await client.query('SELECT market_cap_usd FROM directory_fixture_tokens WHERE address=$1',[delayed])).rows[0].market_cap_usd,'50000','The original dated value remains stored');
 assert.equal((first.items[1] as any).recentTrades.length,1,'Silently captured node trades remain genuine');
 const second=await readFreshTokenDirectory(fixtureDb,{now,limit:2,offset:2,withTrades:true});
 assert.equal(second.total,5);assert.deepEqual(second.items.map(item=>item.address),[unpriced,old]);
 assert.equal(second.items[1].lastTradeAt,new Date(now-3600_000).toISOString(),'A private newer trade cannot renew/order public activity');
 assert.equal((second.items[1] as any).recentTrades.length,1,'Private and older-than-window preview rows stay excluded');
 assert.deepEqual((await readFreshTokenDirectory(fixtureDb,{now,limit:2,offset:4})).items.map(item=>item.address),[boundary],'Exactly eight hours ago is included');
 assert.deepEqual(await readFreshTokenDirectory(fixtureDb,{now,offset:100}),{items:[],total:5,nextOffset:null,nextCursor:null,windowStart:'2026-10-24T04:00:00.000Z',windowEnd:'2026-10-24T12:00:00.000Z',windowHours:8});
 await client.query('UPDATE directory_fixture_financial_events SET canonical=false WHERE id=$1',[futureEvent]);
 assert.equal((await readFreshTokenDirectory(fixtureDb,{now:now+1})).total,4,'Window advances on each request; old tokens expire');
 await trade(expired,now);assert.equal((await readFreshTokenDirectory(fixtureDb,{now:now+1})).total,5,'A new real trade brings an expired token back');
 assert.equal((await client.query('SELECT count(*)::int n FROM directory_fixture_financial_events WHERE token_address=$1',[expired])).rows[0].n,2,'Old records were not removed');
 console.log(JSON.stringify({ok:true,checks:['rolling_eight_hours','inclusive_boundary','public_only','buy_sell_only','canonical_header','confirmed_capture','silent_catchup','no_liquidity_hidden','unpriced_retained','page_total_consistency','offset_empty_total','public_latest_order','windowed_preview','expires_and_reappears','history_preserved'],fixtureWrites:'session temporary and rolled back',externalRequests:0}));
}finally{await client.query('ROLLBACK');client.release();await db.end();}
