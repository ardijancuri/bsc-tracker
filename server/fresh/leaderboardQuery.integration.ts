/** TEMP-only fixtures on the existing owned clone; every write rolls back. */
import assert from'node:assert/strict';import{Pool}from'pg';
import{freshRollingLeaderboardPendingSql,freshPublicTokenDiscoveryPendingSql}from'./leaderboard.js';
import{freshLeaderboardPendingReceiptsSql}from'./leaderboardQuery.js';
const url=new URL(process.env.DATABASE_URL??'');if(url.hostname!=='127.0.0.1'||url.port!=='5439'||url.pathname!=='/kollens_replay_gap_20261029')throw Error('owned_clone_required');
const p=new Pool({connectionString:url.href,max:1,options:'-c jit=off -c timezone=UTC'}),c=await p.connect(),checks:string[]=[],wallet='0x'+'1'.repeat(40),token='0x'+'2'.repeat(40),other='0x'+'3'.repeat(40),tx='0x'+'a'.repeat(64),hash='0x'+'b'.repeat(64),scope='kol:'+wallet,at='2026-10-24T12:30:00Z',from='2026-10-23T12:30:00Z';
const names=['wallets','recent_evidence','recent_blocks','scope_event_results','pending_trades','financial_events','accounting_scopes','tokens','kols','launch_facts','checkpoints'];
const rewrite=(sql:string)=>names.reduce((s,n)=>s.replaceAll('fresh.'+n,'board_'+n),sql).replaceAll('public.journal_wallets','board_members');
async function check(label:string,expected?:boolean,discovery?:boolean){
 const sql=`WITH ${rewrite(freshLeaderboardPendingReceiptsSql)} SELECT ${rewrite(freshRollingLeaderboardPendingSql())} AS old_pending,${rewrite(freshRollingLeaderboardPendingSql(true))} AS new_pending,
  ${rewrite(freshPublicTokenDiscoveryPendingSql())} AS old_discovery,${rewrite(freshPublicTokenDiscoveryPendingSql(true))} AS new_discovery FROM board_kols k JOIN board_wallets w ON w.address=k.wallet_address WHERE k.wallet_address=$3`;
 const r=(await c.query(sql,[from,at,wallet])).rows[0];assert.equal(r.new_pending,r.old_pending,label);assert.equal(r.new_discovery,r.old_discovery,label);
 if(expected!==undefined)assert.equal(r.new_pending,expected,label);if(discovery!==undefined)assert.equal(r.new_discovery,discovery,label);checks.push(label);
}
try{await c.query('BEGIN');for(const n of names)await c.query(`CREATE TEMP TABLE board_${n} AS SELECT * FROM fresh.${n} WITH NO DATA`);await c.query('CREATE TEMP TABLE board_members AS SELECT * FROM public.journal_wallets WITH NO DATA');
 await c.query('INSERT INTO board_wallets(address,active,monitoring_from_block)VALUES($1,true,0)',[wallet]);await c.query('INSERT INTO board_kols(wallet_address,is_tracked)VALUES($1,true)',[wallet]);
 await c.query("INSERT INTO board_accounting_scopes(id,kind,account_id,wallet_addresses,starts_block,starts_at,active)VALUES($1,'kol',NULL,$2,0,'2026-10-20T00:00:00Z',true)",[scope,[wallet]]);
 await c.query('INSERT INTO board_scope_event_results(scope_id,token_address,occurred_at)VALUES($1,$2,$3)',[scope,token,at]);
 await check('empty repair set',false,false);
 await c.query("INSERT INTO board_recent_blocks(block_number,block_hash,parent_hash,occurred_at)VALUES(100,$1,$1,'2026-10-24T00:00:00Z')",[hash]);
 await c.query("INSERT INTO board_recent_evidence(tx_hash,block_hash,block_number,wallet_addresses,decoder_status,position_dependency_addresses,position_dependency_proof,last_error)VALUES($1,$2,100,$3,'repair',$4,$5,'unknown')",[tx,hash,[wallet],[other],'a'.repeat(64)]);
 await check('every current-window receipt remains blocking',true,false);
 await c.query("UPDATE board_recent_evidence SET last_error='token_discovery_pending'");await check('public discovery remains pending',true,true);
 await c.query('UPDATE board_accounting_scopes SET account_id=$1',['private-account']);await check('private scope cannot publish discovery',true,false);await c.query('UPDATE board_accounting_scopes SET account_id=NULL');
 await c.query("UPDATE board_recent_blocks SET occurred_at='2026-10-23T12:29:59Z'");await check('earlier bounded unrelated execution',false,false);
 await c.query('UPDATE board_recent_evidence SET position_dependency_addresses=$1',[[token]]);await check('earlier execution touching a traded token',true,false);
 await c.query('UPDATE board_recent_evidence SET position_dependency_addresses=NULL');await check('opaque earlier evidence remains blocking',true,false);
 await c.query('UPDATE board_recent_evidence SET position_dependency_addresses=$1,position_dependency_proof=NULL',[[other]]);await check('unproven dependency list',true,false);
 await c.query("UPDATE board_recent_blocks SET occurred_at='2026-10-23T12:30:00Z'");await check('exact rolling-window boundary remains conservative',true,true);
 await c.query("UPDATE board_recent_blocks SET occurred_at='2026-10-24T12:30:01Z'");await c.query('UPDATE board_recent_evidence SET position_dependency_addresses=$1,position_dependency_proof=$2',[[other],'a'.repeat(64)]);await check('future receipt cannot approve or block earlier time',false,false);
 await c.query('UPDATE board_recent_blocks SET block_hash=$1',['0x'+'c'.repeat(64)]);await check('orphan canonical header remains blocking',true,false);
 await c.query("UPDATE board_recent_evidence SET decoder_status='done'");await check('completed receipts leave the shared input',false,false);
 await c.query("UPDATE board_recent_evidence SET decoder_status='repair',wallet_addresses=$1",[[other]]);await check('other/private wallet evidence does not block this wallet',false,false);
 console.log(JSON.stringify({passed:true,checks,appRowsWritten:0,financialWrites:0,collectorStarted:false}));
}finally{await c.query('ROLLBACK');c.release();await p.end()}
