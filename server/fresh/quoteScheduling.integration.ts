/** Real scheduling SQL with only session-temporary, rolled-back fixtures. */
import assert from'node:assert/strict';import{Pool}from'pg';import{freshQuoteWorkSql}from'./worker.js';import{selectFreshQuote}from'./quoteQueue.js';
const url=new URL(process.env.DATABASE_URL??'');if(!['127.0.0.1','localhost'].includes(url.hostname)||url.port!=='5436'||url.pathname!=='/kollens_fresh_20261022_24h')throw Error('isolated_fresh_database_required');
const db=new Pool({connectionString:url.toString(),max:1}),client=await db.connect(),tables=['tokens','jobs','launch_facts','positions','accounting_scopes','scope_event_results','financial_events'];
const addr=(n:number)=>'0x'+n.toString(16).padStart(40,'0'),hash='0x'+'1'.repeat(64),now=new Date(),old=new Date(now.getTime()-180_000),older=new Date(now.getTime()-300_000),recent=new Date(now.getTime()-2_000),future=new Date(now.getTime()+60_000);
const query=(sql:string,values?:unknown[])=>{for(const table of tables)sql=sql.replaceAll('fresh.'+table,'quote_schedule_'+table);return client.query(sql,values);};
const fixture={query}as unknown as Pool,selected=async()=>((await query(freshQuoteWorkSql,[now])).rows as{address:string}[]).map(row=>row.address);
const token=async(n:number,observed:Date|null=old,lastTrade:Date|null=new Date(now.getTime()-9*60*60_000))=>{const address=addr(n);await query("INSERT INTO fresh.tokens(address,launch_status,last_trade_at,observed_at) VALUES($1,'eligible',$2,$3)",[address,lastTrade,observed]);return address;};
const scope=async(id:string,kind='kol',active=true)=>{await query('INSERT INTO fresh.accounting_scopes(id,kind,wallet_addresses,starts_at,starts_block,active) VALUES($1,$2,$3,$4,1,$5)',[id,kind,[addr(999)],old,active]);};
const position=async(scopeId:string,address:string,quantity='1')=>{await query('INSERT INTO fresh.positions(scope_id,token_address,quantity_q) VALUES($1,$2,$3)',[scopeId,address,quantity]);};
const event=async(scopeId:string,address:string,kind='buy',tokensTrade=true,canonical=true)=>{const id=scopeId+':'+address+':'+kind;await query(`INSERT INTO fresh.financial_events(id,execution_key,wallet_address,token_address,kind,quantity,block_number,block_hash,transaction_hash,transaction_index,execution_index,occurred_at,canonical)
 VALUES($1,$1,$2,$3,$4,'1',1,$5,$5,0,0,$6,$7)`,[id,addr(999),address,kind,hash,now,canonical]);await query('INSERT INTO fresh.scope_event_results(scope_id,event_id,token_address,tokens_trade,occurred_at) VALUES($1,$2,$3,$4,$5)',[scopeId,id,address,tokensTrade,now]);};
const job=async(address:string,{priority=0,due=old,attempted=older,error='quote_unavailable'}:{priority?:number;due?:Date;attempted?:Date;error?:string}={})=>query("INSERT INTO fresh.jobs(id,kind,reference,priority,due_at,updated_at,last_error) VALUES('quote:'||$1,'quote',$1,$2,$3,$4,$5)",[address,priority,due,attempted,error]);
try{
 await client.query('BEGIN');for(const table of tables)await client.query(`CREATE TEMP TABLE quote_schedule_${table}(LIKE fresh.${table} INCLUDING DEFAULTS) ON COMMIT DROP`);
 await client.query('CREATE UNIQUE INDEX ON quote_schedule_jobs(kind,reference)');
 await scope('public');await scope('private','portfolio_wallet');await scope('inactive','kol',false);await scope('transfer_only');await scope('closed');await scope('elsewhere');
 // Ordinary retry pressure exceeds one whole batch, including closed trades
 // and a token transferred into one scope but traded only in another scope.
 const ordinary:string[]=[];for(let n=1;n<=72;n++){const address=await token(n);ordinary.push(address);await job(address);await position('closed',address,'0');await event('closed',address);}
 const globalOnly=await token(80);ordinary.push(globalOnly);await job(globalOnly);await position('transfer_only',globalOnly);await event('transfer_only',globalOnly,'transfer_in',false);await event('elsewhere',globalOnly);
 const inactive=await token(81);ordinary.push(inactive);await job(inactive);await position('inactive',inactive);await event('inactive',inactive);
 const uncanonical=await token(82);ordinary.push(uncanonical);await job(uncanonical);await position('public',uncanonical);await event('public',uncanonical,'buy',true,false);
 const flaggedFalse=await token(83);ordinary.push(flaggedFalse);await job(flaggedFalse);await position('public',flaggedFalse);await event('public',flaggedFalse,'buy',false);
 const publicHeld=await token(900,older);await position('public',publicHeld);await event('public',publicHeld);
 const privateHeld=await token(901,old);await position('private',privateHeld);await event('private',privateHeld);
 const failedHeld=await token(902,null);await position('public',failedHeld);await event('public',failedHeld);await job(failedHeld,{attempted:recent});
 const foreground=await token(903);await job(foreground,{priority:100,attempted:recent});
 const cooledHeld=await token(904);await position('private',cooledHeld);await event('private',cooledHeld);await job(cooledHeld,{priority:100,due:future,error:'no_liquidity'});
 const cooledRetry=await token(905);await job(cooledRetry,{due:future});
 let rows=await selected();assert.equal(rows.length,64);assert.deepEqual(rows.slice(0,4),[foreground,publicHeld,privateHeld,failedHeld]);
 assert.ok(!rows.includes(cooledHeld));assert.ok(!rows.includes(cooledRetry));assert.ok(rows.indexOf(globalOnly)<0||rows.indexOf(globalOnly)>3);assert.ok(rows.indexOf(inactive)<0||rows.indexOf(inactive)>3);
 assert.ok(rows.indexOf(uncanonical)<0||rows.indexOf(uncanonical)>3);assert.ok(rows.indexOf(flaggedFalse)<0||rows.indexOf(flaggedFalse)>3);
 // Foreground promotion retains its existing confirmed-no-liquidity cooldown.
 await selectFreshQuote(fixture,cooledHeld);assert.equal((await selected()).includes(cooledHeld),false);
 // Success rotates required work out for 30s; the ordinary oldest attempts
 // still fill remaining slots instead of acquiring a permanent starvation.
 await query('UPDATE fresh.tokens SET observed_at=$2 WHERE address=ANY($1::text[])',[[publicHeld,privateHeld],now]);
 rows=await selected();assert.deepEqual(rows.slice(0,2),[foreground,failedHeld]);assert.ok(rows.some(address=>ordinary.includes(address)));assert.equal(rows.length,64);
 await query('DELETE FROM fresh.jobs WHERE reference=$1',[foreground]);await query('UPDATE fresh.tokens SET observed_at=$2 WHERE address=$1',[foreground,now]);
 await query('UPDATE fresh.jobs SET due_at=$2 WHERE reference=$1',[failedHeld,future]);rows=await selected();assert.ok(!rows.includes(failedHeld));assert.ok(rows.every(address=>ordinary.includes(address)));assert.equal(rows.length,64);
 // More than two batches of open positions used to permanently outrank a
 // recently sold tracker token. Share urgency and use oldest quote/attempt.
 for(const table of tables)await query('TRUNCATE fresh.'+table);
 await scope('public');await scope('closed');
 const held:string[]=[];for(let n=1000;n<1160;n++){const address=await token(n,old);held.push(address);await position('public',address);await event('public',address);}
 const recentClosed=await token(1200,older,now);await position('closed',recentClosed,'0');await event('closed',recentClosed,'sell');
 const staleOldClosed=await token(1201,new Date(now.getTime()-600_000));await position('closed',staleOldClosed,'0');await event('closed',staleOldClosed,'sell');
 const untraded=await token(1202,null,null);await position('public',untraded);await event('public',untraded,'transfer_in',false);
 rows=await selected();assert.equal(rows[0],recentClosed);assert.equal(rows.length,64);assert.ok(rows.includes(staleOldClosed));assert.ok(rows.includes(untraded));assert.equal(new Set(rows).size,rows.length);
 await query('UPDATE fresh.tokens SET observed_at=$2 WHERE address=ANY($1::text[])',[rows,now]);
 rows=await selected();assert.ok(!rows.includes(recentClosed));assert.ok(rows.every(address=>held.includes(address)));
 // Selected-token jobs and genuine no-liquidity cooldowns remain stronger
 // constraints than the shared recent/open freshness class.
 await job(staleOldClosed,{priority:100});await job(recentClosed,{priority:100,due:future,error:'no_liquidity'});
 rows=await selected();assert.equal(rows[0],staleOldClosed);assert.ok(!rows.includes(recentClosed));
 // Under continuous urgent pressure, eight ordinary due retries still advance.
 const background:string[]=[];for(let n=1300;n<1320;n++){const address=await token(n,new Date(now.getTime()-600_000));background.push(address);await job(address);}
 rows=await selected();assert.equal(rows[0],staleOldClosed);assert.equal(rows.filter(address=>background.includes(address)).length,8);assert.equal(new Set(rows).size,64);
 const firstOrdinary=rows.filter(address=>background.includes(address));await query('UPDATE fresh.jobs SET due_at=$2 WHERE reference=ANY($1::text[])',[firstOrdinary,future]);
 const next=await selected();assert.equal(next.filter(address=>background.includes(address)).length,8);assert.ok(next.every(address=>!firstOrdinary.includes(address)));assert.equal(new Set(next).size,64);
 // A retained READY quote must use its real observation deadline after a
 // capture-CAS retry; the recent failed-attempt timestamp cannot demote it
 // behind newer successful quotes or old unsupported work.
 for(const table of tables)await query('TRUNCATE fresh.'+table);
 const retained=await token(2000,new Date(now.getTime()-100_000),now),lessOld=await token(2001,new Date(now.getTime()-80_000),now),
  newer=await token(2002,new Date(now.getTime()-40_000),now),unsupported=await token(2003,new Date(now.getTime()-6*60*60_000),now),
  unsupportedRecent=await token(2004,new Date(now.getTime()-7*60*60_000),now),cooledReady=await token(2005,new Date(now.getTime()-110_000),now);
 await query("UPDATE fresh.tokens SET valuation_status='ready' WHERE address=ANY($1::text[])",[[retained,lessOld,newer,cooledReady]]);
 await query("UPDATE fresh.tokens SET valuation_status='quote_unavailable' WHERE address=ANY($1::text[])",[[unsupported,unsupportedRecent]]);
 await job(retained,{attempted:recent});await job(lessOld,{attempted:old});await job(unsupported,{attempted:older});await job(unsupportedRecent,{attempted:recent});await job(cooledReady,{due:future});
 rows=await selected();assert.deepEqual(rows.slice(0,2),[retained,lessOld]);assert.ok(rows.indexOf(unsupported)<rows.indexOf(unsupportedRecent));assert.ok(!rows.includes(cooledReady));
 const priorRetained=(await query('SELECT observed_at FROM fresh.tokens WHERE address=$1',[retained])).rows[0].observed_at;
 assert.equal(new Date(priorRetained).getTime(),now.getTime()-100_000,'Selecting by deadline never refreshes the original observation');
 await job(newer,{priority:100});rows=await selected();assert.equal(rows[0],newer);assert.deepEqual(rows.slice(1,3),[retained,lessOld]);
 console.log(JSON.stringify({ok:true,checks:['held_own_scope_trades_outrank_more_than64_ordinary_retries','selected_foreground_priority_preserved','active_private_books_get_same_required_priority','closed_untraded_inactive_and_noncanonical_not_promoted_outside_tracker_window','future_cooldowns_not_bypassed','oldest_attempt_fairness_and_ordinary_progress','recent_closed_tracker_token_not_starved_by160_held_tokens','null_last_public_trade_does_not_gain_urgent_priority','recent_success_rotates_out_without_freshening_old_quotes','eight_ordinary_retries_reserved_and_rotated_under_urgent_pressure','no_duplicate_tokens','selection_bound64_unchanged','retained_ready_deadline_uses_oldest_observation_not_retry_attempt','unavailable_work_keeps_attempt_rotation','ready_deadline_preserves_cooldowns_and_does_not_freshen_evidence'],fixtureWrites:'session temporary and rolled back',externalRequests:0}));
}finally{await client.query('ROLLBACK');client.release();await db.end();}
