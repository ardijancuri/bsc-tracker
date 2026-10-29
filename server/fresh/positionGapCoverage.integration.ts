/** Real PostgreSQL predicates and balance worker, TEMP fixtures rolled back.
 * Run only against the separately cloned local replay database. */
import assert from'node:assert/strict';import{Pool}from'pg';import{resolve}from'node:path';import{fileURLToPath}from'node:url';
import{freshPositionWalletGapSql}from'./positionGapCoverage.js';import{refreshFreshBalances}from'./balances.js';
import{enrichFreshKnownTokenBirth}from'./tokenBirth.js';import{tokenBirthFixture,topLevelBirthFixture,stockwaveBirthFixture,birthHash as hash,birthAddress as address}from'./fixtures/tokenBirthFixture.js';import type{Rpc}from'../rpc.js';
import{completeFreshDecodeRepair,expireFreshEvidenceInTransaction}from'./capture.js';
import{ensureFreshPositionGapEpoch,invalidateFreshPositionGapEpoch}from'./positionGapJournal.js';
export async function runFreshPositionGapCoverageIntegration(){
 const url=new URL(process.env.DATABASE_URL??'');if(url.hostname!=='127.0.0.1'||url.port!=='5439'||url.pathname!=='/kollens_replay_gap_20261029')throw Error('owned_replay_clone_only');
 const pool=new Pool({connectionString:url.href,max:1}),c=await pool.connect(),checks:string[]=[],wallet=address(801),other=address(802),scope='kol:'+wallet;
 const fixture=tokenBirthFixture(),fact=enrichFreshKnownTokenBirth(fixture.fact,fixture.creation,fixture.start),token=fixture.token,iso=(n:number)=>new Date(Date.UTC(2026,0,1)+n*1000).toISOString();
 const query=(sql:string,args:any[]=[])=>c.query(sql.replaceAll('fresh.','pg_temp.').replaceAll('public.journal_wallets','pg_temp.journal_wallets'),args);
 let serial:Promise<unknown>=Promise.resolve();const db={query:(sql:string,args:any[]=[])=>{const p=serial.then(()=>query(sql,args));serial=p.then(()=>undefined,()=>undefined);return p;}}as unknown as Pool;
 const blocked=async(asset=token,cutoff=130,selected=scope)=>Boolean((await query(`SELECT ${freshPositionWalletGapSql('$3','$2')} AS blocked FROM fresh.accounting_scopes s WHERE s.id=$1`,[selected,asset,cutoff])).rows[0].blocked);
 async function expired(block:number,w=wallet,patch:any={}){const tx=hash(10000+block),bh=hash(block),reference=tx+':'+bh;
  const e={version:1,kind:'expired_receipt_reference_v1',transactionHash:tx,blockHash:bh,blockNumber:block,transactionIndex:0,walletAddresses:[w],dependencyAddresses:[],dependencyProof:null,payloadSha256:'a'.repeat(64),expiresAt:iso(10000),expiredAt:iso(10001),lastError:'incoming_transfer_cost_unknown',...patch};
  await query(`INSERT INTO fresh.jobs(id,kind,reference,state,progress,last_error)VALUES($1,'decode_receipt',$2,'unavailable',$3,'expired_undecoded_evidence')`,['decode:'+reference,reference,{expiredEvidence:e}]);
 }
 async function negative(name:string,change:()=>Promise<unknown>){await c.query('SAVEPOINT negative');await change();assert.equal(await blocked(),true,name);await c.query('ROLLBACK TO SAVEPOINT negative');checks.push(name);}
 let beforeCall:(()=>Promise<unknown>)|null=null,calls=0;
 const rpc=(async(method:string,params:any[])=>{if(method==='eth_getBlockByNumber')return{number:'0x82',hash:hash(130),timestamp:'0x'+Math.floor(Date.parse(iso(130))/1000).toString(16)};assert.equal(method,'eth_call');assert.equal(params[0].to,token);calls++;if(beforeCall){const f=beforeCall;beforeCall=null;await f();}return'0x'+(10n**18n).toString(16).padStart(64,'0');})as Rpc;
 try{
  await c.query('BEGIN');await c.query("SET LOCAL statement_timeout='15s';SET LOCAL jit=off");
  for(const name of['wallets','tokens','accounting_scopes','scope_event_results','positions','financial_events','pending_trades','kols','launch_facts','jobs','recent_evidence','recent_blocks','checkpoints'])await c.query(`CREATE TEMP TABLE ${name}(LIKE fresh.${name} INCLUDING DEFAULTS)ON COMMIT DROP`);
  await c.query('CREATE TEMP TABLE journal_wallets(LIKE public.journal_wallets INCLUDING DEFAULTS)ON COMMIT DROP');
  await query('ALTER TABLE fresh.checkpoints ADD PRIMARY KEY(key)');
  await query("INSERT INTO fresh.checkpoints(key,block_number,block_hash,value)VALUES('start',100,$1,$2),('capture',130,$3,$2)",[hash(100),{startBlock:100,startHash:hash(100)},hash(130)]);
  for(const n of[119,120,125,130])await query('INSERT INTO fresh.recent_blocks(block_number,block_hash,parent_hash,occurred_at)VALUES($1,$2,$3,$4)',[n,hash(n),hash(n-1),iso(n)]);
  await query("INSERT INTO fresh.wallets(address,monitoring_from_block,decode_gap_from_block,decode_gap_reason)VALUES($1,101,105,'expired_undecoded_evidence'),($2,101,106,'expired_undecoded_evidence')",[wallet,other]);
  await query("INSERT INTO fresh.accounting_scopes(id,kind,wallet_addresses,starts_at,starts_block)VALUES($1,'kol',ARRAY[$2],$3,101),($4,'kol',ARRAY[$5],$3,101)",[scope,wallet,iso(101),'kol:'+other,other]);
  await query("INSERT INTO fresh.tokens(address,decimals,launch_status,symbol)VALUES($1,18,'eligible','TEST')",[token]);
  await query('INSERT INTO fresh.launch_facts(token_address,protocol,block_number,block_hash,tx_hash,log_index,launched_at,proof,status)VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[fact.tokenAddress,fact.protocol,fact.blockNumber,fact.blockHash,fact.txHash,fact.logIndex,fact.launchedAt,fact.proof,fact.status]);
  await expired(105);await expired(115);await expired(126,other);
  assert.equal(await blocked(),false);checks.push('complete earlier expiry journal and authenticated later creation isolate only this token');
  for(const make of[()=>tokenBirthFixture('fourmeme'),()=>tokenBirthFixture('fourmemeffff'),topLevelBirthFixture,stockwaveBirthFixture]){
   await c.query('SAVEPOINT protocol');const next=make(),f=enrichFreshKnownTokenBirth(next.fact,next.creation,next.start);
   await query('DELETE FROM fresh.launch_facts');await query('INSERT INTO fresh.launch_facts(token_address,protocol,block_number,block_hash,tx_hash,log_index,launched_at,proof,status)VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[f.tokenAddress,f.protocol,f.blockNumber,f.blockHash,f.txHash,f.logIndex,f.launchedAt,f.proof,f.status]);
   await query('DELETE FROM fresh.recent_blocks WHERE block_number IN(119,120)');assert.equal(await blocked(next.token),false);await c.query('ROLLBACK TO SAVEPOINT protocol');checks.push(f.protocol+' authenticated birth stays valid after header expiry');
  }
  assert.equal(await blocked(token,130,'kol:'+other),true);checks.push('another public or private wallet is not covered by the first wallet journal');
  await negative('same-block expiry cannot infer within-block creation order',()=>expired(120));
  await negative('a later missing receipt still blocks',()=>expired(121));
  await c.query('SAVEPOINT future');await expired(131);assert.equal(await blocked(),false);assert.equal(await blocked(token,132),true);await c.query('ROLLBACK TO SAVEPOINT future');checks.push('a frozen cutoff ignores later gaps without ignoring gaps inside its window');
  await negative('missing earliest receipt cannot establish journal completeness',()=>query('DELETE FROM fresh.jobs WHERE reference=$1',[hash(10105)+':'+hash(105)]));
  await negative('no expiry journal remains unbounded',()=>query('DELETE FROM fresh.jobs'));
  await negative('malformed later block cannot disappear from the upper bound',()=>expired(116,wallet,{blockNumber:'invalid'}));
  await negative('missing original payload digest stays unverified',()=>expired(116,wallet,{payloadSha256:null}));
  await negative('wrong expiry reference cannot authorize a replay',()=>query("UPDATE fresh.jobs SET reference='wrong' WHERE progress->'expiredEvidence'->>'blockNumber'='115'"));
  await negative('unknown and registration gaps stay blocking',()=>query("UPDATE fresh.wallets SET decode_gap_reason='registration_history_unavailable' WHERE address=$1",[wallet]));
  await negative('an unmatched earliest marker stays blocking',()=>query('UPDATE fresh.wallets SET decode_gap_from_block=104 WHERE address=$1',[wallet]));
  await negative('a different token does not borrow this creation certificate',()=>query('UPDATE fresh.launch_facts SET token_address=$1',[other]));
  await negative('raw pool/launch evidence alone does not prove token birth',()=>query("UPDATE fresh.launch_facts SET proof=proof-'tokenBirth'"));
  await negative('changed creation identity fails closed',()=>query('UPDATE fresh.launch_facts SET tx_hash=$1',[hash(888)]));
  await negative('excluded or reorg-invalidated creation stays unavailable',()=>query("UPDATE fresh.launch_facts SET status='unverified'"));
  await negative('a conflicting canonical birth header invalidates the certificate',()=>query('UPDATE fresh.recent_blocks SET block_hash=$1 WHERE block_number=120',[hash(999)]));
  await negative('a conflicting canonical parent invalidates the certificate',()=>query('UPDATE fresh.recent_blocks SET block_hash=$1 WHERE block_number=119',[hash(999)]));
  await negative('a different capture lineage invalidates the certificate',()=>query("UPDATE fresh.checkpoints SET value=jsonb_set(value,'{startHash}',to_jsonb($1::text)) WHERE key='capture'",[hash(999)]));
  await negative('changed tracking boundary invalidates the certificate',()=>query("UPDATE fresh.checkpoints SET block_hash=$1 WHERE key='start'",[hash(999)]));
  await c.query('SAVEPOINT expired_headers');await query('DELETE FROM fresh.recent_blocks WHERE block_number IN(119,120)');assert.equal(await blocked(),false);await c.query('ROLLBACK TO SAVEPOINT expired_headers');checks.push('original authenticated creation certificate survives ordinary 72-hour header expiry');
  const expiredBefore=(await query('SELECT progress FROM fresh.jobs ORDER BY id')).rows;
  await completeFreshDecodeRepair(db,hash(10105)+':'+hash(105));assert.equal(await blocked(),false);assert.deepEqual((await query('SELECT progress FROM fresh.jobs ORDER BY id')).rows,expiredBefore);
  await completeFreshDecodeRepair(db,hash(10105)+':'+hash(105));assert.equal(await blocked(),false);checks.push('normal decoder completion retains the compact expiry journal without resetting coverage');
  await query("INSERT INTO fresh.recent_evidence(tx_hash,block_hash,block_number,transaction_index,payload,wallet_addresses,decoder_status,expires_at)VALUES($1,$2,105,0,$3,ARRAY[$4],'done',$5)",[hash(10105),hash(105),Buffer.from('completed TEMP fixture'),wallet,iso(10000)]);
  const expiredResult=await expireFreshEvidenceInTransaction(db as any,new Date(iso(11000)),1);assert.equal(expiredResult.evidence,1);assert.equal(await blocked(),false);assert.deepEqual((await query('SELECT progress FROM fresh.jobs ORDER BY id')).rows,expiredBefore);checks.push('later raw-buffer expiry cannot erase the original compact gap bound');
  await query("INSERT INTO fresh.jobs(id,kind,reference,state)VALUES('normal','decode_receipt','normal','pending')");await completeFreshDecodeRepair(db,'normal');assert.equal((await query("SELECT count(*)::int count FROM fresh.jobs WHERE reference='normal'")).rows[0].count,0);checks.push('ordinary completed receipt jobs are still removed');
  await query("INSERT INTO fresh.financial_events(id,execution_key,wallet_address,token_address,kind,quantity,amount_usd,fee_usd,block_number,block_hash,transaction_hash,transaction_index,execution_index,occurred_at)VALUES('last','last',$1,$2,'buy','1','1','0',125,$3,$4,0,0,$5)",[wallet,token,hash(125),hash(555),iso(125)]);
  await negative('canonical token facts contradicting its claimed creation cannot be waived',()=>query("UPDATE fresh.financial_events SET block_number=105 WHERE id='last'"));
  await query("INSERT INTO fresh.positions(scope_id,token_address,quantity_q,last_event_id,last_event_at)VALUES($1,$2,'1/1','last',$3)",[scope,token,iso(125)]);
  const digest=async()=> (await query("SELECT md5(string_agg(to_jsonb(e)::text,',' ORDER BY id)) digest FROM fresh.financial_events e")).rows[0].digest,original=await digest();
  const balance=await refreshFreshBalances(db,rpc,1);assert.equal(balance.matched,1);assert.equal(calls,1);assert.equal((await query('SELECT balance_status FROM fresh.positions')).rows[0].balance_status,'matched');checks.push('real balance worker confirms exact inventory after old gap isolation');
  const clear=()=>query("UPDATE fresh.positions SET balance_status='pending',balance_quantity=NULL,balance_block=NULL,balance_hash=NULL,balance_checked_at=NULL");
  await clear();await c.query('SAVEPOINT race');beforeCall=()=>expired(126);const raced=await refreshFreshBalances(db,rpc,1);assert.equal(raced.matched,0);assert.equal(raced.pending,1);assert.equal((await query('SELECT balance_block FROM fresh.positions')).rows[0].balance_block,null);await c.query('ROLLBACK TO SAVEPOINT race');checks.push('an expiry racing the RPC prevents committing a stale balance approval');
  await clear();await c.query('SAVEPOINT reorg');beforeCall=()=>query("UPDATE fresh.launch_facts SET status='unverified'");assert.equal((await refreshFreshBalances(db,rpc,1)).matched,0);await c.query('ROLLBACK TO SAVEPOINT reorg');checks.push('a reorg racing the RPC prevents committing a stale approval');
  await clear();await c.query('SAVEPOINT mismatch');await query("UPDATE fresh.positions SET quantity_q='2/1'");const mismatch=await refreshFreshBalances(db,rpc,1);assert.equal(mismatch.mismatch,1);assert.equal((await query('SELECT balance_status FROM fresh.positions')).rows[0].balance_status,'mismatch');await c.query('ROLLBACK TO SAVEPOINT mismatch');checks.push('a true inventory contradiction remains a mismatch');
  assert.equal(await digest(),original);assert.equal((await query('SELECT decode_gap_from_block FROM fresh.wallets WHERE address=$1',[wallet])).rows[0].decode_gap_from_block,'105');checks.push('original trades profit inputs unknown markers and expiry references are preserved');
  await c.query('SAVEPOINT legacy');await query("INSERT INTO fresh.checkpoints(key,value)VALUES('health:maintenance',$1)",[{ok:true,result:{positionGapJournalVersion:1}}]);await ensureFreshPositionGapEpoch(db);
  await query('DELETE FROM fresh.jobs');const later=tokenBirthFixture('flap',140),laterFact=enrichFreshKnownTokenBirth(later.fact,later.creation,later.start);
  await query('INSERT INTO fresh.launch_facts(token_address,protocol,block_number,block_hash,tx_hash,log_index,launched_at,proof,status)VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[laterFact.tokenAddress,laterFact.protocol,laterFact.blockNumber,laterFact.blockHash,laterFact.txHash,laterFact.logIndex,laterFact.launchedAt,laterFact.proof,laterFact.status]);
  await query("UPDATE fresh.checkpoints SET block_number=150,block_hash=$1 WHERE key='capture'",[hash(150)]);
  assert.equal(await blocked(later.token,150),false);assert.equal(await blocked(token),true);checks.push('all legacy wallets can track post-activation tokens without asserting a complete lost journal or clearing old gaps');
  assert.equal(await blocked(later.token,150,'kol:'+other),false);checks.push('post-activation isolation applies to every wallet without hardcoded identities');
  await ensureFreshPositionGapEpoch(db);assert.equal((await query("SELECT block_number FROM fresh.checkpoints WHERE key='coverage:position_gap_journal'")).rows[0].block_number,'130');checks.push('normal maintenance retains its existing coverage horizon rather than moving it on every poll');
  await c.query('SAVEPOINT later_gap');await expired(145);assert.equal(await blocked(later.token,150),true);await c.query('ROLLBACK TO SAVEPOINT later_gap');checks.push('a new expired gap inside the new token lifetime remains blocking');
  await c.query('SAVEPOINT guard');await query("UPDATE fresh.checkpoints SET value='{}' WHERE key='health:maintenance'");assert.equal(await blocked(later.token,150),true);await c.query('ROLLBACK TO SAVEPOINT guard');checks.push('an old or missing expiry writer cannot authorize the new coverage horizon');
  await invalidateFreshPositionGapEpoch(db,129);assert.equal(await blocked(later.token,150),true);checks.push('a reorg invalidates an orphaned activation horizon');await c.query('ROLLBACK TO SAVEPOINT legacy');
  await c.query('ROLLBACK');return{passed:true,checks,financialWrites:0,persistentFixtureWrites:0,nodeProviderCalls:0};
 }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();await pool.end();}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(JSON.stringify(await runFreshPositionGapCoverageIntegration()));
