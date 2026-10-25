/** Session-temporary fixtures only; no application row is written. */
import assert from'node:assert/strict';import{Pool}from'pg';
import{FRESH_DECODER_VERSION}from'./decode.js';
import{readFreshForwardTrialSnapshot,type FreshForwardSnapshotScope}from'./trialForward.js';
const url=new URL(process.env.DATABASE_URL??'');if(!['127.0.0.1','localhost'].includes(url.hostname)||url.port!=='5436'||url.pathname!=='/kollens_fresh_20261022_24h')throw Error('isolated_fresh_database_required');
const database=new Pool({connectionString:url.href,max:1}),client=await database.connect();
const tables=['checkpoints','recent_blocks','financial_events','kols','positions','recent_evidence','wallets','accounting_scopes','scope_event_results','jobs','launch_facts','tokens'];
const rewrite=(sql:string)=>sql.replace(/fresh\.([a-z_]+)/g,'forward_fixture_$1').replaceAll('public.journal_wallets','forward_fixture_journal_wallets');
let observedReadOnly=false;
const fixture={connect:async()=>({release(){},query:async(sql:string,args?:unknown[])=>{const result=await client.query(rewrite(sql),args);
 if(sql.startsWith('BEGIN ISOLATION')){assert.equal((await client.query('SHOW transaction_isolation')).rows[0].transaction_isolation,'repeatable read');assert.equal((await client.query('SHOW transaction_read_only')).rows[0].transaction_read_only,'on');observedReadOnly=true;}return result;}})}as any;
const address=(n:number)=>'0x'+n.toString(16).padStart(40,'0'),hash=(n:number)=>'0x'+n.toString(16).padStart(64,'0');
const now=Date.now(),stamp=new Date(now).toISOString(),wallet=address(1),privateWallet=address(2),oldWallet=address(3),token=address(4),oldToken=address(5),scopeId='kol:'+wallet;
const scope:FreshForwardSnapshotScope={version:1,policy:'forward_activity_v1',blockNumber:100,blockHash:hash(100),occurredAt:new Date(now-1000).toISOString(),activatedAt:stamp,captureRevision:'7'};
async function event(id:string,w:string,t:string,kind:string,block:number,live=true){await client.query(`INSERT INTO forward_fixture_financial_events(id,execution_key,wallet_address,token_address,kind,quantity,amount_usd,fee_usd,block_number,block_hash,transaction_hash,transaction_index,execution_index,occurred_at,observed_live,decoder_version)
 VALUES($1,$1,$2,$3,$4,'1','2','0',$5,$6,$6,0,0,$7,$8,$9)`,[id,w,t,kind,block,hash(block),stamp,live,FRESH_DECODER_VERSION]);}
async function receipt(id:number,block:number,status:string,w=oldWallet){await client.query(`INSERT INTO forward_fixture_recent_evidence(tx_hash,block_hash,block_number,transaction_index,payload,wallet_addresses,decoder_status,decoder_version,last_error,expires_at,created_at)
 VALUES($1,$2,$3,0,'\\x00',ARRAY[$4]::text[],$5,$6,'metadata_unavailable',$7,$8)`,[hash(id),hash(block),block,w,status,FRESH_DECODER_VERSION,new Date(now+100000),stamp]);}
try{
 for(const table of tables)await client.query(`CREATE TEMP TABLE forward_fixture_${table}(LIKE fresh.${table} INCLUDING DEFAULTS)`);
 await client.query('CREATE TEMP TABLE forward_fixture_journal_wallets(user_id text,wallet_address text,registration_block bigint,activity_from timestamptz)');
 for(const n of[80,90,100,101,102])await client.query('INSERT INTO forward_fixture_recent_blocks(block_number,block_hash,parent_hash,occurred_at) VALUES($1,$2,$3,$4)',[n,hash(n),hash(n-1),n===100?scope.occurredAt:stamp]);
 await client.query(`INSERT INTO forward_fixture_checkpoints(key,block_number,block_hash,revision,value) VALUES('capture',102,$1,7,'{}'),('decode',79,$2,1,'{}')`,[hash(102),hash(79)]);
 for(const w of[wallet,privateWallet,oldWallet])await client.query('INSERT INTO forward_fixture_wallets(address,monitoring_from_block) VALUES($1,1)',[w]);
 await client.query('INSERT INTO forward_fixture_kols(wallet_address) VALUES($1)',[wallet]);
 for(const t of[token,oldToken])await client.query(`INSERT INTO forward_fixture_tokens(address,launch_status,price_usd,valuation_status,observed_block,observed_hash,observed_at) VALUES($1,'eligible',2,'ready',102,$2,$3)`,[t,hash(102),stamp]);
 for(const[id,w,account]of[[scopeId,wallet,null],['private',privateWallet,'user'],['old',oldWallet,null]])await client.query(`INSERT INTO forward_fixture_accounting_scopes(id,kind,wallet_addresses,account_id,starts_at,starts_block) VALUES($1,$2,ARRAY[$3]::text[],$4,$5,1)`,[id,account?'portfolio_wallet':'kol',w,account,new Date(now-100000)]);
 await client.query('INSERT INTO forward_fixture_journal_wallets VALUES($1,$2,1,$3)',['user',privateWallet,new Date(now-100000)]);
 await event('new-buy',wallet,token,'buy',101);await event('new-sell',wallet,token,'sell',102);await event('private-buy',privateWallet,token,'buy',101);
 await event('old-buy',oldWallet,oldToken,'buy',90);await event('old-public-sell',wallet,oldToken,'sell',90);
 await event('private-transfer',privateWallet,oldToken,'transfer_in',101);await event('public-transfer',wallet,oldToken,'transfer_in',101);
 for(const[id,s,t]of[['new-buy',scopeId,token],['new-sell',scopeId,token],['private-buy','private',token]])await client.query(`INSERT INTO forward_fixture_scope_event_results(scope_id,event_id,token_address,tokens_trade,occurred_at) VALUES($1,$2,$3,true,$4)`,[s,id,t,stamp]);
 await client.query(`INSERT INTO forward_fixture_scope_event_results(scope_id,event_id,token_address,tokens_trade,occurred_at) VALUES($1,'old-public-sell',$2,true,$3),($1,'public-transfer',$2,false,$3),('private','private-transfer',$2,false,$3)`,[scopeId,oldToken,stamp]);
 for(const[s,id]of[[scopeId,'new-sell'],['private','private-buy']])await client.query(`INSERT INTO forward_fixture_positions(scope_id,token_address,quantity_q,realized_q,last_event_id,last_event_at,balance_status,balance_quantity,balance_block,balance_hash,balance_checked_at) VALUES($1,$2,'1','0',$3,$4,'matched','1',102,$5,$4)`,[s,token,id,stamp,hash(102)]);
 for(const[s,id]of[[scopeId,'public-transfer'],['private','private-transfer']])await client.query(`INSERT INTO forward_fixture_positions(scope_id,token_address,quantity_q,realized_q,last_event_id,last_event_at,balance_status,balance_quantity,balance_block,balance_hash,balance_checked_at,unknown_cost)
 VALUES($1,$2,'1',$3,$4,$5,'matched','1',102,$6,$5,$7)`,[s,oldToken,s==='private'?null:'0',id,stamp,hash(102),s==='private']);
 await receipt(201,90,'repair');
 let result=await readFreshForwardTrialSnapshot(fixture,scope,now);
 assert.equal(observedReadOnly,true);assert.equal(result.boundaryCanonical,true);assert.equal(result.counts.repair_evidence,'0');assert.equal(result.historicalDiagnostics.repair_evidence,'1');
 assert.equal(result.counts.public_buys,'1');assert.equal(result.counts.public_sells,'1');assert.equal(result.positions.length,4);assert(result.positions.filter(row=>row.token_address===token).every(row=>row.application_ready));assert.equal(result.counts.forward_projection_missing,'0');
 assert.equal(result.positions.find(row=>row.scope_id==='private'&&row.token_address===oldToken)?.has_trades,false);assert.equal(result.positions.find(row=>row.scope_id===scopeId&&row.token_address===oldToken)?.has_trades,true);
 await client.query("UPDATE forward_fixture_positions SET balance_status='mismatch' WHERE scope_id='private' AND token_address=$1",[oldToken]);assert.equal((await readFreshForwardTrialSnapshot(fixture,scope,now)).positions.find(row=>row.scope_id==='private'&&row.token_address===oldToken)?.balance_status,'mismatch');await client.query("UPDATE forward_fixture_positions SET balance_status='matched' WHERE scope_id='private'");
 await client.query("DELETE FROM forward_fixture_scope_event_results WHERE event_id='private-transfer'");assert.equal((await readFreshForwardTrialSnapshot(fixture,scope,now)).counts.forward_projection_missing,'1');await client.query("INSERT INTO forward_fixture_scope_event_results(scope_id,event_id,token_address,tokens_trade,occurred_at) VALUES('private','private-transfer',$1,false,$2)",[oldToken,stamp]);
 await client.query('UPDATE forward_fixture_kols SET is_tracked=false');result=await readFreshForwardTrialSnapshot(fixture,scope,now);assert.equal(result.counts.public_buys,'0');assert.equal(result.counts.public_sells,'0');await client.query('UPDATE forward_fixture_kols SET is_tracked=true');
 await client.query("UPDATE forward_fixture_financial_events SET observed_live=false WHERE id='new-sell'");assert.equal((await readFreshForwardTrialSnapshot(fixture,scope,now)).counts.public_sells,'0');await client.query("UPDATE forward_fixture_financial_events SET observed_live=true WHERE id='new-sell'");
 // New undecoded work is counted before any buy/sell exists; private transfers
 // and the old unrelated wallet cannot manufacture public representative data.
 await receipt(202,101,'repair',privateWallet);result=await readFreshForwardTrialSnapshot(fixture,scope,now);assert.equal(result.counts.repair_evidence,'1');assert.equal(result.counts.forward_dependency_pending,'2');assert.equal(result.positions.find(row=>row.scope_id==='private')?.application_ready,false);
 await client.query("DELETE FROM forward_fixture_recent_evidence WHERE block_number=101");
 await receipt(203,90,'repair',wallet);result=await readFreshForwardTrialSnapshot(fixture,scope,now);assert.equal(result.counts.repair_evidence,'0');assert.equal(result.counts.forward_dependency_pending,'2');assert.equal(result.positions.find(row=>row.scope_id===scopeId)?.application_ready,false);
 await client.query('DELETE FROM forward_fixture_recent_evidence WHERE tx_hash=$1',[hash(203)]);
 await client.query("UPDATE forward_fixture_recent_blocks SET block_hash=$1 WHERE block_number=101",[hash(998)]);result=await readFreshForwardTrialSnapshot(fixture,scope,now);assert.equal(result.counts.forward_projection_missing,'4');assert.equal(result.positions.find(row=>row.scope_id==='private')?.last_event_canonical,false);await client.query('UPDATE forward_fixture_recent_blocks SET block_hash=$1 WHERE block_number=101',[hash(101)]);
 await client.query("DELETE FROM forward_fixture_positions WHERE scope_id='private' AND token_address=$1",[token]);result=await readFreshForwardTrialSnapshot(fixture,scope,now);assert.equal(result.counts.forward_projection_missing,'1');assert.equal(result.positions.find(row=>row.scope_id==='private')?.application_ready,false);
 await client.query(`INSERT INTO forward_fixture_positions(scope_id,token_address,quantity_q,realized_q,last_event_id,last_event_at,balance_status,balance_quantity,balance_block,balance_hash,balance_checked_at) VALUES('private',$1,'1','0','private-buy',$2,'matched','1',102,$3,$2)`,[token,stamp,hash(102)]);
 await client.query('DELETE FROM forward_fixture_scope_event_results WHERE event_id=$1',['new-sell']);result=await readFreshForwardTrialSnapshot(fixture,scope,now);assert.equal(result.counts.forward_projection_missing,'1');assert.equal(result.positions.find(row=>row.scope_id===scopeId)?.application_ready,false);
 await client.query("UPDATE forward_fixture_positions SET unknown_cost=true WHERE scope_id='private'");result=await readFreshForwardTrialSnapshot(fixture,scope,now);assert.equal(result.positions.find(row=>row.scope_id==='private')?.unknown_cost,true);assert.equal(result.positions.find(row=>row.scope_id==='private')?.application_ready,false);
 await client.query('UPDATE forward_fixture_recent_blocks SET block_hash=$1 WHERE block_number=100',[hash(999)]);assert.equal((await readFreshForwardTrialSnapshot(fixture,scope,now)).boundaryCanonical,false);
 console.log(JSON.stringify({ok:true,checks:20,permanentWrites:0,temporaryFixtures:true,externalRequests:0}));
}finally{await client.query('ROLLBACK');client.release();await database.end();}
