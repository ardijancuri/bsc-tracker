/** Actual SQL and fake RPC, using TEMP tables inside a rollback only. */
import assert from'node:assert/strict';
import{resolve}from'node:path';import{fileURLToPath}from'node:url';import{Pool}from'pg';
import type{Rpc}from'../rpc.js';import{refreshFreshBalances}from'./balances.js';import{freshBalanceWorkSql}from'./balanceScheduling.js';
export async function runFreshBalanceSchedulingIntegration(){
 const u=new URL(process.env.DATABASE_URL??'');if(!['127.0.0.1','localhost'].includes(u.hostname)||u.port!=='5436'||u.pathname!=='/kollens_fresh_20261022_24h')throw Error('Exact isolated Fresh PostgreSQL required');
 const db=new Pool({connectionString:u.toString(),max:1}),client=await db.connect(),checks:string[]=[];
 const h=(n:number)=>'0x'+BigInt(n).toString(16).padStart(64,'0'),a=(n:number)=>'0x'+BigInt(n).toString(16).padStart(40,'0');
 const base=Date.parse('2026-10-23T21:00:00Z'),at=(n:number)=>new Date(base+n*1000),names=['positions','accounting_scopes','tokens','financial_events','pending_trades','wallets','kols','launch_facts','jobs','recent_evidence','recent_blocks','checkpoints'];
 const rewrite=(sql:string)=>names.reduce((s,name)=>s.replaceAll('fresh.'+name,'pg_temp.balance_'+name),sql).replaceAll('public.journal_wallets','pg_temp.balance_members');
 let serial:Promise<unknown>=Promise.resolve();
 const facade={query:(sql:string,args:unknown[])=>{const work=serial.then(()=>client.query(rewrite(sql),args));serial=work.then(()=>undefined,()=>undefined);return work;}}as unknown as Pool;
 let stateCalls=0,beforeState:undefined|(()=>Promise<void>);
 const rpc=(async(method:string,params:any[])=>{
  if(method==='eth_getBlockByNumber'){assert.deepEqual(params,['0x78',false]);return{number:'0x78',hash:h(120),timestamp:'0x'+Math.floor(at(120).getTime()/1000).toString(16)};}
  assert.equal(method,'eth_call');assert.deepEqual(params[1],{blockHash:h(120),requireCanonical:true});assert.ok(params[0].data.startsWith('0x70a08231'));stateCalls++;if(beforeState){const next=beforeState;beforeState=undefined;await next();}return'0x'+(1n).toString(16).padStart(64,'0');
 })as Rpc;
 async function reset(){await client.query('TRUNCATE '+names.map(n=>'balance_'+n).concat('balance_members').join(','));await client.query("INSERT INTO balance_checkpoints(key,block_number,block_hash)VALUES('capture',120,$1)",[h(120)]);for(const n of[10,50,80,100,110,120])await client.query('INSERT INTO balance_recent_blocks VALUES($1,$2,$3)',[n,h(n),at(n)]);stateCalls=0;beforeState=undefined;}
 async function scope(id:string,wallets:string[],account:string|null=null){await client.query('INSERT INTO balance_accounting_scopes VALUES($1,$2,$3,$4,$5,10,1,true)',[id,account?'portfolio_combined':'kol',wallets,account,at(10)]);for(const w of wallets)await client.query('INSERT INTO balance_wallets(address,decode_gap_from_block)VALUES($1,NULL)ON CONFLICT DO NOTHING',[w]);}
 async function position(id:string,n:number,quantity='1/1',last=50){const token=a(10000+n),event=id+':'+n;await client.query('INSERT INTO balance_tokens(address,decimals)VALUES($1,0)ON CONFLICT DO NOTHING',[token]);await client.query('INSERT INTO balance_financial_events(id,block_number)VALUES($1,$2)',[event,last]);await client.query(`INSERT INTO balance_positions(scope_id,token_address,quantity_q,revision,balance_status,last_event_id,last_event_at)VALUES($1,$2,$3,1,'pending',$4,$5)`,[id,token,quantity,event,at(last)]);return token;}
 async function pending(wallet:string,n=80){await client.query("INSERT INTO balance_recent_evidence(block_number,block_hash,wallet_addresses,decoder_status)VALUES($1,$2,ARRAY[$3]::text[],'repair')",[n,h(n),wallet]);}
 async function selected(){return(await facade.query(freshBalanceWorkSql,[64,120])).rows;}
 try{
  await client.query('BEGIN');await client.query("SET LOCAL statement_timeout='10s'");
  await client.query(`CREATE TEMP TABLE balance_positions(scope_id text,token_address text,quantity_q text,revision bigint,balance_status text,balance_quantity text,balance_block bigint,balance_hash text,balance_checked_at timestamptz,last_event_id text,last_event_at timestamptz,PRIMARY KEY(scope_id,token_address))ON COMMIT DROP;
   CREATE TEMP TABLE balance_accounting_scopes(id text PRIMARY KEY,kind text,wallet_addresses text[],account_id text,starts_at timestamptz,starts_block bigint,revision bigint,active boolean)ON COMMIT DROP;
   CREATE TEMP TABLE balance_tokens(address text PRIMARY KEY,decimals integer,launch_status text DEFAULT 'eligible',symbol text,name text)ON COMMIT DROP;
   CREATE TEMP TABLE balance_financial_events(id text PRIMARY KEY,block_number bigint,execution_key text,canonical boolean DEFAULT true)ON COMMIT DROP;
   CREATE TEMP TABLE balance_pending_trades(id text,execution_key text,wallet_address text,token_address text,kind text,block_number bigint,occurred_at timestamptz,canonical boolean)ON COMMIT DROP;
   CREATE TEMP TABLE balance_wallets(address text PRIMARY KEY,decode_gap_from_block bigint,monitoring_from_block bigint DEFAULT 0,monitoring_to_block bigint,active boolean DEFAULT true)ON COMMIT DROP;
   CREATE TEMP TABLE balance_kols(wallet_address text,is_tracked boolean)ON COMMIT DROP;
   CREATE TEMP TABLE balance_launch_facts(token_address text,status text)ON COMMIT DROP;
   CREATE TEMP TABLE balance_jobs(kind text,reference text,state text)ON COMMIT DROP;
   CREATE TEMP TABLE balance_recent_evidence(block_number bigint,block_hash text,wallet_addresses text[],decoder_status text,position_dependency_addresses text[],position_dependency_proof text)ON COMMIT DROP;
   CREATE TEMP TABLE balance_recent_blocks(block_number bigint,block_hash text,occurred_at timestamptz,PRIMARY KEY(block_number,block_hash))ON COMMIT DROP;
   CREATE TEMP TABLE balance_checkpoints(key text PRIMARY KEY,block_number bigint,block_hash text,value jsonb DEFAULT '{}')ON COMMIT DROP;
   CREATE TEMP TABLE balance_members(user_id text,wallet_address text,registration_block bigint,activity_from timestamptz,PRIMARY KEY(user_id,wallet_address))ON COMMIT DROP`);
  await reset();await scope('blocked',[a(1)]);await scope('ready',[a(2)]);await pending(a(1));
  for(let n=0;n<70;n++)await position('blocked',n,'1/1',100);const ready=await position('ready',100);
  const old=(await client.query('SELECT scope_id FROM balance_positions ORDER BY balance_checked_at NULLS FIRST,last_event_at DESC LIMIT 64')).rows;assert.ok(old.every(r=>r.scope_id==='blocked'));
  const work=await selected();assert.equal(work.length,64);assert.equal(work[0].scope_id,'ready');assert.equal(work[0].decoding_pending,false);assert.ok(work.slice(1).every(r=>r.decoding_pending));checks.push('ready_work_outside_old64_precedes_history_blocked_prefix');
  const immutable=(await client.query('SELECT md5(string_agg(id||block_number::text,\',\' ORDER BY id)) AS digest FROM balance_financial_events')).rows[0].digest;
  const pendingBefore=(await client.query("SELECT scope_id,token_address,ctid::text FROM balance_positions WHERE scope_id='blocked' ORDER BY token_address")).rows;
  const result=await refreshFreshBalances(facade,rpc);assert.equal(result.matched,1);assert.equal(result.pending,63);assert.equal(stateCalls,1);
  const proof=(await client.query('SELECT * FROM balance_positions WHERE scope_id=$1 AND token_address=$2',['ready',ready])).rows[0];assert.equal(proof.balance_status,'matched');assert.equal(proof.balance_quantity,'1');assert.equal(Number(proof.balance_block),120);assert.equal(proof.balance_hash,h(120));
  const blocked=(await client.query("SELECT * FROM balance_positions WHERE scope_id='blocked'")).rows;assert.ok(blocked.every(r=>r.balance_status==='pending'&&r.balance_block===null&&r.balance_checked_at===null));checks.push('blocked_rows_remain_explicit_pending_without_state_calls_or_false_proofs','real_canonical_balance_updates_only_ready_current_row');
  await refreshFreshBalances(facade,rpc);assert.deepEqual((await client.query("SELECT scope_id,token_address,ctid::text FROM balance_positions WHERE scope_id='blocked' ORDER BY token_address")).rows,pendingBefore);assert.equal(stateCalls,1);checks.push('idle_blocked_poll_rewrites_no_unchanged_position_rows');
  assert.equal((await client.query('SELECT md5(string_agg(id||block_number::text,\',\' ORDER BY id)) AS digest FROM balance_financial_events')).rows[0].digest,immutable);checks.push('no_financial_journal_writes');
  await reset();await scope('private',[a(1),a(2)],'account');await scope('public',[a(2)]);await scope('removed',[a(3)],'account');
  await client.query('INSERT INTO balance_members VALUES($1,$2,10,$3),($1,$4,100,$5)',['account',a(1),at(10),a(2),at(101)]);
  await position('private',1,'2/1');await position('public',2);await position('removed',3);await pending(a(2),80);await pending(a(2),100);
  const privacy=await selected();assert.equal(privacy[0].scope_id,'private');assert.equal(privacy[0].decoding_pending,false);assert.equal(privacy.find(r=>r.scope_id==='public').decoding_pending,true);assert.equal(privacy.find(r=>r.scope_id==='removed').registration_pending,true);
  const privateResult=await refreshFreshBalances(facade,rpc);assert.equal(privateResult.matched,1);assert.equal(privateResult.pending,2);assert.equal(stateCalls,2);checks.push('portfolio_member_block_and_time_boundaries_do_not_adopt_public_older_repairs','missing_private_membership_cannot_authorize_balance');
  await pending(a(2),110);await client.query("UPDATE balance_positions SET balance_status='pending'WHERE scope_id='private'");assert.equal((await selected()).find(r=>r.scope_id==='private').decoding_pending,true);checks.push('post_membership_pending_receipt_still_blocks_entire_scope');
  await reset();await scope('race',[a(1)]);const raceToken=await position('race',1);beforeState=async()=>pending(a(1),110);const race=await refreshFreshBalances(facade,rpc);assert.equal(race.matched,0);assert.equal(race.pending,1);
  const held=(await client.query('SELECT * FROM balance_positions WHERE scope_id=$1 AND token_address=$2',['race',raceToken])).rows[0];assert.equal(held.balance_status,'pending');assert.equal(held.balance_block,null);assert.equal(held.balance_checked_at,null);checks.push('commit_rechecks_new_canonical_pending_receipt_after_async_rpc');
  await reset();await scope('member-race',[a(1)],'account');await client.query('INSERT INTO balance_members VALUES($1,$2,10,$3)',['account',a(1),at(10)]);await position('member-race',1);beforeState=async()=>{await client.query('DELETE FROM balance_members WHERE user_id=$1',['account']);};const removed=await refreshFreshBalances(facade,rpc);assert.equal(removed.matched,0);assert.equal(removed.pending,1);checks.push('commit_rechecks_membership_removal_after_async_rpc');
  await reset();await scope('gap',[a(1)]);await position('gap',1);await client.query('UPDATE balance_wallets SET decode_gap_from_block=80');assert.equal((await selected())[0].wallet_gap,true);const gap=await refreshFreshBalances(facade,rpc);assert.equal(gap.pending,1);assert.equal(stateCalls,0);checks.push('durable_coverage_gap_stays_blocked');
  await client.query('UPDATE balance_wallets SET decode_gap_from_block=5');assert.equal((await selected())[0].wallet_gap,true);const earlierGap=await refreshFreshBalances(facade,rpc);assert.equal(earlierGap.pending,1);assert.equal(stateCalls,0);checks.push('earliest_gap_before_scope_does_not_prove_no_later_missing_blocks');
  await reset();await scope('dependency',[a(1)]);const selectedToken=await position('dependency',1);await pending(a(1));
  await client.query('UPDATE balance_recent_evidence SET position_dependency_addresses=$1,position_dependency_proof=$2',[[a(2),a(3)],'a'.repeat(64)]);
  assert.equal((await selected())[0].decoding_pending,false);assert.equal((await refreshFreshBalances(facade,rpc)).matched,1);checks.push('authenticated_unrelated_complete_execution_does_not_block_position_balance');
  await client.query("UPDATE balance_positions SET balance_status='pending'");await client.query('UPDATE balance_recent_evidence SET position_dependency_addresses=array_append(position_dependency_addresses,$1)',[selectedToken]);
  assert.equal((await selected())[0].decoding_pending,true);stateCalls=0;assert.equal((await refreshFreshBalances(facade,rpc)).pending,1);assert.equal(stateCalls,0);checks.push('touched_token_remains_blocked');
  await client.query('UPDATE balance_recent_evidence SET position_dependency_addresses=$1,position_dependency_proof=NULL',[[a(2)]]);assert.equal((await selected())[0].decoding_pending,true);checks.push('unbound_dependency_index_remains_wallet_wide');
  await reset();const permanentScope='kol:'+a(1);await scope(permanentScope,[a(1)]);await client.query('INSERT INTO balance_kols VALUES($1,true)',[a(1)]);const permanentToken=await position(permanentScope,1);
  const insertPermanent=()=>client.query("INSERT INTO balance_pending_trades VALUES('pending','pending:operation:0',$1,$2,'buy',110,$3,true)",[a(1),permanentToken,at(110)]);
  await insertPermanent();assert.equal((await selected())[0].decoding_pending,true);assert.equal((await refreshFreshBalances(facade,rpc)).pending,1);assert.equal(stateCalls,0);
  assert.equal((await client.query('SELECT count(*)::int n FROM balance_recent_evidence')).rows[0].n,0);checks.push('compact_pending_trade_blocks_balance_after_original_receipt_expiry_without_any_state_call');
  await client.query('TRUNCATE balance_pending_trades');beforeState=async()=>{await insertPermanent();};const pendingRace=await refreshFreshBalances(facade,rpc);assert.equal(pendingRace.matched,0);assert.equal(pendingRace.pending,1);
  const permanentHeld=(await client.query('SELECT balance_block,balance_checked_at FROM balance_positions WHERE scope_id=$1',[permanentScope])).rows[0];assert.equal(permanentHeld.balance_block,null);assert.equal(permanentHeld.balance_checked_at,null);checks.push('commit_rechecks_permanent_pending_trade_discovered_during_balance_rpc');
  await client.query('ROLLBACK');return{ok:true,checks,fixtureWrites:'TEMP tables rolled back',financialWrites:0,realNetworkCalls:0};
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();await db.end();}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(JSON.stringify(await runFreshBalanceSchedulingIntegration()));
