/** Only session TEMP copies change; original financial/account tables are read-only. */
import assert from'node:assert/strict';import{Pool}from'pg';import{createFreshReads}from'./reads.js';import{createFreshLeaderboardReadCache,freshLeaderboardCacheBoundsSql}from'./leaderboardCache.js';
const url=new URL(process.env.DATABASE_URL??'');if(url.hostname!=='127.0.0.1'||url.port!=='5439'||url.pathname!=='/kollens_replay_gap_20261029')throw Error('owned_clone_required');
const pool=new Pool({connectionString:url.href,max:1,options:'-c jit=off -c timezone=UTC'}),c=await pool.connect(),checks:string[]=[],wallet='0x7a2363a401b2340c7941dd2eeff0196a5078d2e6';
const replace=(s:string)=>s.replaceAll('fresh.kols','cache_kols').replaceAll('fresh.wallets','cache_wallets').replaceAll('fresh.checkpoints','cache_checkpoints').replaceAll('published_kols','cache_published');
const db={connect:async()=>({query:(s:string,v?:unknown[])=>c.query(replace(s),v),release(){}})}as unknown as Pool;
let at=Date.parse('2026-10-29T23:09:40Z');const cache=createFreshLeaderboardReadCache({maxAgeMs:10000}),cached=createFreshReads(db,()=>at,false,{leaderboardCache:cache}),plain=createFreshReads(db,()=>at);
async function equal(label:string){const actual=await cached.leaderboard(),expected=await plain.leaderboard();assert.deepEqual(actual,expected,label);checks.push(label);return actual;}
try{
 await c.query('BEGIN');for(const[old,temp]of[['fresh.kols','cache_kols'],['fresh.wallets','cache_wallets'],['fresh.checkpoints','cache_checkpoints'],['published_kols','cache_published']])await c.query(`CREATE TEMP TABLE ${temp} AS SELECT * FROM ${old}`);await c.query('COMMIT');
 await equal('cold cache preserves complete response');await equal('warm cache preserves complete response');assert.ok(cache.stats().hits>0);
 const oldStats=cache.stats();const profile=await cached.kol(wallet),board=await cached.leaderboard();assert.deepEqual(profile.kol,board.items.find(r=>r.address===wallet));assert.equal(profile.windowEnd,board.windowEnd);assert.ok(cache.stats().hits>oldStats.hits);checks.push('profile reuses exact public ranking frame');
 async function change(sql:string,values:unknown[],label:string){const before=cache.stats().loads;await c.query('BEGIN');await c.query(sql,values);await c.query('COMMIT');await equal(label);assert.ok(cache.stats().loads>before,label+' invalidates');}
 await change('UPDATE cache_published SET display_name=$2 WHERE address=$1',[wallet,'TEMP renamed'],'creator/profile metadata invalidation');
 await change("UPDATE cache_kols SET rolling_realized_q='10',rolling_known_realized_q='10',revision=revision+1 WHERE wallet_address=$1",[wallet],'stored accounting repair invalidation');
 await change("UPDATE cache_checkpoints SET block_hash=$1 WHERE key='capture'",['0x'+'0'.repeat(64)],'reorg/canonical capture invalidation');
 await change('UPDATE cache_kols SET is_tracked=false WHERE wallet_address=$1',[wallet],'tracking removal invalidation');assert.equal((await cached.kol(wallet)).kol,null);
 await change('UPDATE cache_wallets SET decode_gap_from_block=1,decode_gap_reason=$2 WHERE address=$1',[wallet,'registration_gap'],'wallet evidence invalidation');
 const b=cache.stats().loads;at+=2000;await equal('rolling time expiry without a new database write');assert.ok(cache.stats().loads>b);
 // Inclusive discovery-window edges and health expiry use distinct clocks.
 const now=new Date(),window=new Date(at),from=new Date(at-86400000);
 await c.query('BEGIN');await c.query("UPDATE cache_checkpoints SET updated_at=$1 WHERE key='health:maintenance'",[new Date(now.getTime()-119950)]);
 const bounds=(await c.query(replace(freshLeaderboardCacheBoundsSql),[from.toISOString(),window.toISOString(),now.toISOString()])).rows[0];assert.ok(new Date(bounds.database_until).getTime()<=now.getTime()+50);checks.push('maintenance lease ends at its real 120-second boundary');await c.query('ROLLBACK');
 await c.query('BEGIN');await c.query('UPDATE cache_kols SET is_tracked=true WHERE wallet_address=$1',[wallet]);await c.query('CREATE TEMP TABLE cache_window_results(scope_id text,occurred_at timestamptz)');
 const clockBounds=()=>c.query(replace(freshLeaderboardCacheBoundsSql).replaceAll('fresh.scope_event_results','cache_window_results'),[from.toISOString(),window.toISOString(),now.toISOString()]);
 await c.query('INSERT INTO cache_window_results VALUES($1,$2)',['kol:'+wallet,from]);assert.equal(new Date((await clockBounds()).rows[0].window_until).getTime(),at);checks.push('inclusive discovery edge is not cached across the following millisecond');
 await c.query('UPDATE cache_window_results SET occurred_at=$1',[new Date(from.getTime()+1)]);assert.equal(new Date((await clockBounds()).rows[0].window_until).getTime(),at+1);checks.push('earliest rolling contribution expiry bounds the lease');
 await c.query('UPDATE cache_window_results SET occurred_at=$1',[new Date(at+1)]);assert.equal(new Date((await clockBounds()).rows[0].window_until).getTime(),at+1);checks.push('future evidence entering the window bounds the lease');
 await c.query("UPDATE cache_checkpoints SET updated_at=$1 WHERE key='health:maintenance'",[new Date(now.getTime()-119999)]);await c.query('SELECT pg_sleep(0.015)');assert.ok(new Date((await clockBounds()).rows[0].database_until).getTime()<=now.getTime()+1);checks.push('health expiring during a cache fill cannot extend approval');
 await c.query("INSERT INTO cache_checkpoints(key,value)VALUES('coverage:realized_gap:invalid','{\"activatedAt\":\"2026-99-99T00:00:00Z\"}')");await clockBounds();checks.push('malformed future timestamps do not crash the cache guard');await c.query('ROLLBACK');
 console.log(JSON.stringify({passed:true,checks,cache:cache.stats(),permanentRowsWritten:0,financialWrites:0,collectorStarted:false}));
}finally{await c.query('ROLLBACK');c.release();await pool.end()}
