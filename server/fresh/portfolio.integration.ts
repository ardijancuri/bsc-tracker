import assert from 'node:assert/strict';
import { randomBytes,randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { Interface } from 'ethers';
import { Pool } from 'pg';
import { ensureFreshSchema } from './schema.js';
import { applyFreshFinancialEvents,freshDecimal } from './accounting.js';
import { createFreshReads } from './reads.js';
import { createFreshReplay } from './replay.js';
import { createFreshPortfolio,FreshPortfolioError,freshPortfolioScope,registerFreshPortfolio } from './portfolio.js';
import type { FreshFinancialEvent } from '../../shared/freshAccounting.js';
import type { Rpc } from '../rpc.js';
import { refreshFreshBalances } from './balances.js';
import { refreshFreshRollingKolTotals } from './rolling.js';
const source=new URL(process.env.DATABASE_URL??'');if(!['127.0.0.1','localhost'].includes(source.hostname)||!/fresh/.test(source.pathname))throw new Error('Use an isolated local fresh database');
const name=`bscan_fresh_portfolio_test_${Date.now()}`,adminUrl=new URL(source);adminUrl.pathname='/postgres';const admin=new Pool({connectionString:adminUrl.toString(),max:1});
await admin.query(`CREATE DATABASE ${name}`);const url=new URL(source);url.pathname=`/${name}`;const db=new Pool({connectionString:url.toString(),max:8});
const address=()=>`0x${randomBytes(20).toString('hex')}`,a=address(),b=address(),c=address(),d=address(),token=address(),user=randomUUID(),otherUser=randomUUID();
let clock=Date.parse('2026-10-22T00:01:00Z'),seq=0,upstream=0;const now=()=>clock;
const reads=createFreshReads(db,now),replay=createFreshReplay({secret:'x'.repeat(40),now,charts:{replayChart:async()=>{upstream++;throw new Error('fake chart unavailable');}},validateRevision:async()=>true});
const service=createFreshPortfolio({db,reads,replay,now});
function event(overrides:Partial<FreshFinancialEvent>={}):FreshFinancialEvent{const n=++seq;return{id:`e${n}`,executionKey:`exec${n}`,walletAddress:a,tokenAddress:token,kind:'buy',quantity:'10',amountUsd:'20',feeUsd:'1',feeKey:`fee${n}`,counterparty:null,transferKey:null,blockNumber:`${101+n}`,blockHash:`0x${n.toString(16).padStart(64,'0')}`,transactionHash:`0x${n.toString(16).padStart(64,'0')}`,transactionIndex:0,executionIndex:0,logIndex:0,occurredAt:new Date(clock+1000).toISOString(),...overrides};}
async function apply(events:FreshFinancialEvent[]){const client=await db.connect();try{await client.query('BEGIN');await applyFreshFinancialEvents(client,events,{now:clock});await client.query('COMMIT');}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}}
let app:ReturnType<typeof Fastify>|undefined;
try{
  await ensureFreshSchema(db);
  await db.query(`INSERT INTO public.auth_users(id,issuer,subject,name) VALUES($1::uuid,'test',$1::text,'Test A'),($2::uuid,'test',$2::text,'Test B')`,[user,otherUser]);
  await db.query(`INSERT INTO fresh.checkpoints(key,block_number,block_hash,value) VALUES('start',100,$1,'{}'),('capture',100,$1,'{}'),('decode',100,$1,'{}')`,[`0x${'f'.repeat(64)}`]);
  const initial=await service.add(user,a,'Secret private label');assert.equal(initial.wallets.length,1);assert.equal(initial.wallets[0].preparation.status,'pending');
  await db.query("INSERT INTO fresh.jobs(id,kind,reference) VALUES($1,'registration_capture',$2)",[`registration:${a}`,a]);await db.query("UPDATE fresh.checkpoints SET block_number=1000 WHERE key='decode'");
  assert.equal((await service.list(user)).wallets[0].preparation.status,'pending');assert.equal((await service.summary(user)).preparing,true,'Registration repair remains explicit even before the first position exists');
  await db.query("DELETE FROM fresh.jobs WHERE kind='registration_capture' AND reference=$1",[a]);await db.query("UPDATE fresh.checkpoints SET block_number=100 WHERE key='decode'");
  const revision=initial.wallets[0].revision;await service.add(user,a,'Ignored duplicate');assert.equal((await service.list(user)).wallets[0].revision,revision);assert.equal((await service.list(user)).wallets[0].label,'Secret private label');
  await service.add(user,b,'Second');await service.add(user,c,'Third');await assert.rejects(service.add(user,d),e=>e instanceof FreshPortfolioError&&e.statusCode===409);
  await service.add(otherUser,a,'Different account');assert.equal((await service.list(otherUser)).wallets[0].label,'Different account');
  await assert.rejects(service.authorize(otherUser,b),e=>e instanceof FreshPortfolioError&&e.statusCode===404);
  assert.equal((await db.query('SELECT count(*)::int n FROM fresh.kols')).rows[0].n,0,'Private registration never enters the public roster');
  await db.query(`INSERT INTO fresh.tokens(address,symbol,name,decimals,total_supply_raw,price_usd,market_cap_usd,observed_at,observed_block,observed_hash,launch_status,valuation_status)
    VALUES($1,'PRIVATE','Private token',18,1000000000000000000000,3,3000,$2,110,$3,'eligible','ready')`,[token,new Date(clock).toISOString(),`0x${'f'.repeat(64)}`]);
  const buy=event();await apply([buy]);clock+=2000;
  await db.query(`UPDATE fresh.checkpoints SET block_number=110,updated_at=$1 WHERE key IN('capture','decode')`,[new Date(clock).toISOString()]);
  // Simulate independently confirmed matching holdings; balance proof itself has its own suite.
  await db.query("UPDATE fresh.positions SET balance_status='matched',balance_quantity=quantity_q,balance_block=110,balance_hash=$1,balance_checked_at=$2",[`0x${'f'.repeat(64)}`,new Date(clock).toISOString()]);
  const overview=await service.summary(user);assert.equal(overview.positions.length,1);assert.deepEqual(overview.positions[0].wallets,[a]);assert.equal(overview.totals.investedUsd,'20');assert.equal(overview.totals.estimatedProfitUsd,'9');
  assert.equal((await reads.trades()).items.length,0,'Private executions never appear in public activity');assert.equal((await reads.leaderboard()).items.length,0);
  assert.equal((await db.query('SELECT tracked_trade_count FROM fresh.tokens WHERE address=$1',[token])).rows[0].tracked_trade_count,'0');
  assert.equal(upstream,0,'Current Portfolio summaries need no chart or financial provider calls');
  const activity=await service.activity(user);assert.equal(activity.trades.length,1);await assert.rejects(service.activity(otherUser,b),e=>e instanceof FreshPortfolioError&&e.statusCode===404);
  // A combined transfer carries the original lot; it creates no new investment.
  const tx=`0x${'d'.repeat(64)}`,hash=`0x${'e'.repeat(64)}`,key='internal1';
  await apply([event({kind:'transfer_out',quantity:'4',amountUsd:'12',feeUsd:'0',feeKey:null,counterparty:b,transferKey:key,transactionHash:tx,blockHash:hash,blockNumber:'112',executionIndex:0}),
    event({walletAddress:b,kind:'transfer_in',quantity:'4',amountUsd:'12',feeUsd:'0',feeKey:null,counterparty:a,transferKey:key,transactionHash:tx,blockHash:hash,blockNumber:'112',executionIndex:1})]);
  const combined=(await db.query('SELECT * FROM fresh.positions WHERE scope_id=$1 AND token_address=$2',[freshPortfolioScope(user),token])).rows[0];assert.equal(freshDecimal(combined.capital_q),'21');assert.equal(combined.quantity_q,'10');assert.equal(combined.realized_q,'0');
  const saved=await service.tokenActivity(user,a,token,true);assert.equal(saved?.journal.private,true);assert.equal(saved?.journal.accountId,user);
  const snapshot=saved?.accountingSnapshot?.snapshotId;assert.ok(snapshot);await assert.rejects(service.tokenActivity(otherUser,a,token,true,snapshot),/expired|changed/);
  await service.remove(user,a);await assert.rejects(service.authorize(user,a),e=>e instanceof FreshPortfolioError&&e.statusCode===404);assert.equal((await db.query('SELECT active FROM fresh.wallets WHERE address=$1',[a])).rows[0].active,true,'Another subscriber keeps shared capture active');
  await assert.rejects(service.tokenActivity(user,a,token,true,snapshot),e=>e instanceof FreshPortfolioError&&e.statusCode===404);
  await service.remove(otherUser,a);assert.equal((await db.query('SELECT active FROM fresh.wallets WHERE address=$1',[a])).rows[0].active,false);
  clock+=5000;await service.add(user,a,'Readded');assert.notEqual((await service.authorize(user,a)).revision,revision);assert.equal((await reads.positionRows(freshPortfolioScope(user,a))).length,0,'Re-addition never restores earlier membership results');
  assert.ok((await db.query('SELECT 1 FROM fresh.financial_events WHERE id=$1',[buy.id])).rowCount,'Canonical financial facts survive removal');
  // Public current-row reads, approved inventory identity and an actual concurrent writer.
  await db.query('INSERT INTO fresh.wallets(address,monitoring_from_block) VALUES($1,101)',[d]);
  await db.query("INSERT INTO fresh.kols(wallet_address,display_name) VALUES($1,'Public fixture')",[d]);
  await db.query("INSERT INTO fresh.accounting_scopes(id,kind,wallet_addresses,starts_at,starts_block) VALUES($1,'kol',$2,'2026-10-22T00:00:00Z',101)",[`kol:${d}`,[d]]);
  const publicBuy=event({walletAddress:d,quantity:'3',amountUsd:'3',feeUsd:'0',feeKey:null,blockNumber:'122'}),publicSell=event({walletAddress:d,kind:'sell',quantity:'1',amountUsd:'5',feeUsd:'0',feeKey:null,blockNumber:'123'});
  await apply([publicBuy,publicSell]);clock+=2000;
  // The fixture deliberately inserts observations one second ahead of its
  // clock. Simulate the normal rolling worker tick when that time arrives;
  // an HTTP read must not refresh an expired/future-entry projection itself.
  const upkeep=await db.connect();try{await upkeep.query('BEGIN');await refreshFreshRollingKolTotals(upkeep,{now:clock});await upkeep.query('COMMIT');}
  catch(error){await upkeep.query('ROLLBACK');throw error;}finally{upkeep.release();}
  const proofHash=`0x${'9'.repeat(64)}`;
  await db.query("UPDATE fresh.checkpoints SET block_number=125,block_hash=$1,updated_at=$2 WHERE key IN('capture','decode')",[proofHash,new Date(clock).toISOString()]);
  await db.query("UPDATE fresh.tokens SET observed_block=125,observed_hash=$2,observed_at=$3 WHERE address=$1",[token,proofHash,new Date(clock).toISOString()]);
  await db.query("UPDATE fresh.positions SET balance_status='matched',balance_quantity=quantity_q,balance_block=125,balance_hash=$2,balance_checked_at=$3 WHERE scope_id=$1",[`kol:${d}`,proofHash,new Date(clock).toISOString()]);
  const live=await reads.activity(d,token,`kol:${d}`,true);assert.equal(live?.summary.realizedProfitUsd,'4');assert.equal(live?.realizedAccounting?.position?.estimatedProfitUsd,'8');
  assert.equal(live?.inventory?.events[0].tokenAmount,'3');assert.equal(live?.inventory?.events[1].tokenAmount,'1');assert.equal(live?.inventory?.coverage.reconciled,true);
  assert.equal(live?.replayAccounting?.inventoryBlockHash,proofHash);assert.equal(live?.accountingSnapshot?.coveredThroughBlock,'125');
  assert.equal((await reads.leaderboard()).items.find(item=>item.address===d)?.realizedProfitUsd,live?.summary.realizedProfitUsd);
  assert.equal(await reads.activity(a,token,`kol:${d}`,true),null,'A public scope cannot expose a different wallet identity');
  await db.query('UPDATE fresh.tokens SET observed_at=$2 WHERE address=$1',[token,new Date(clock-300000).toISOString()]);
  const quoteDelay=(await reads.summaries(d,[token]))[token];assert.equal(quoteDelay.status,'pending');assert.equal(quoteDelay.realizedStatus,'ready');assert.equal(quoteDelay.realizedProfitUsd,'4');assert.equal(quoteDelay.estimatedProfitUsd,null);assert.equal(quoteDelay.snapshot?.complete,true,'A price delay does not erase verified realized profit');
  const datedCash=await reads.activity(d,token,`kol:${d}`,true);assert.equal(datedCash?.realizedAccounting?.status,'ready');assert.equal(datedCash?.realizedAccounting?.position?.estimatedProfitUsd,null);assert.equal(datedCash?.accountingSnapshot?.asOf,new Date(clock).toISOString());assert.equal(datedCash?.replayAccounting?.status,'pending');
  await db.query('UPDATE fresh.tokens SET observed_at=$2 WHERE address=$1',[token,new Date(clock).toISOString()]);
  let injected=false;
  const concurrentPool=new Proxy(db,{get(target,key){if(key==='connect')return async()=>{const client=await target.connect();return {release:()=>client.release(),query:async(...args:any[])=>{const value=await(client.query as any)(...args);
    if(!injected&&typeof args[0]==='string'&&args[0].startsWith('SELECT p.*,t.*')){injected=true;await db.query("UPDATE fresh.checkpoints SET block_number=126 WHERE key IN('capture','decode')");await apply([event({walletAddress:d,quantity:'1',amountUsd:'4',feeUsd:'0',feeKey:null,blockNumber:'126',occurredAt:new Date(clock+1000).toISOString()})]);}return value;}};};const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});
  const frozen=await createFreshReads(concurrentPool,now).activity(d,token,`kol:${d}`,true);
  assert.equal(injected,true);assert.equal(frozen?.summary.remainingTokenAmount,'2');assert.equal(frozen?.trades.length,2);assert.equal(frozen?.inventory?.events.length,2,'Read-only repeatable read keeps newly committed events outside the frozen object');
  assert.equal((await reads.summaries(d,[token]))[token].status,'pending','A new movement invalidates the old balance proof');
  clock+=2000;await db.query('UPDATE fresh.tokens SET observed_block=126,observed_hash=$2,observed_at=$3 WHERE address=$1',[token,proofHash,new Date(clock).toISOString()]);
  const balanceAbi=new Interface(['function balanceOf(address) view returns(uint256)']);let stateCalls=0;
  const fakeRpc:Rpc=async<T>(method:string,params:unknown[]=[])=>{if(method==='eth_getBlockByNumber'){assert.equal(params[0],'0x7e');return {number:'0x7e',hash:proofHash,timestamp:`0x${Math.floor(clock/1000).toString(16)}`} as T;}
    if(method==='eth_call'){stateCalls++;assert.deepEqual(params[1],{blockHash:proofHash,requireCanonical:true});const input=params[0] as {data:string};const selected=String(balanceAbi.decodeFunctionData('balanceOf',input.data)[0]).toLowerCase();return balanceAbi.encodeFunctionResult('balanceOf',[selected===d?3n*10n**18n:0n]) as T;}throw new Error('No provider or unconfirmed latest-state request is allowed');};
  await refreshFreshBalances(db,fakeRpc);assert.ok(stateCalls>0);assert.equal((await reads.summaries(d,[token]))[token].status,'ready','Balance checks use the committed capture block rather than a newer head');
  const rawTx=`0x${'8'.repeat(64)}`;await db.query(`INSERT INTO fresh.recent_evidence(tx_hash,block_hash,block_number,transaction_index,payload,expires_at,wallet_addresses) VALUES($1,$2,126,0,$3,$4,$5)`,[rawTx,proofHash,Buffer.from('unused fixture'),new Date(clock+10000),[d]]);
  assert.equal((await reads.summaries(d,[token]))[token].status,'pending');assert.equal((await reads.activity(d,token,`kol:${d}`,true))?.inventory?.coverage.reconciled,false,'Undecoded wallet evidence cannot authorize a replay');
  await db.query('DELETE FROM fresh.recent_evidence WHERE tx_hash=$1',[rawTx]);await db.query("UPDATE fresh.wallets SET decode_gap_from_block=126,decode_gap_reason='fixture' WHERE address=$1",[d]);
  assert.ok((await reads.summaries(d,[token]))[token].snapshot?.reasons.includes('wallet_decode_gap'));assert.equal((await reads.leaderboard()).items.find(item=>item.address===d)?.accounting.complete,false);
  await db.query('UPDATE fresh.wallets SET decode_gap_from_block=NULL,decode_gap_reason=NULL WHERE address=$1',[d]);
  await db.query("UPDATE fresh.positions SET balance_quantity='999' WHERE scope_id=$1",[`kol:${d}`]);assert.equal((await reads.summaries(d,[token]))[token].status,'pending','A matched label cannot override a contradictory proof quantity');
  const close=event({walletAddress:d,kind:'sell',quantity:'3',amountUsd:'12',feeUsd:'1',blockNumber:'128',occurredAt:new Date(clock+1000).toISOString()});await apply([close]);clock+=2000;
  await db.query("UPDATE fresh.checkpoints SET block_number=130 WHERE key IN('capture','decode')");
  await db.query("UPDATE fresh.positions SET balance_status='matched',balance_quantity='0',balance_block=130,balance_hash=$2,balance_checked_at=$3 WHERE scope_id=$1",[`kol:${d}`,proofHash,new Date(clock).toISOString()]);
  await db.query('UPDATE fresh.tokens SET observed_at=$2 WHERE address=$1',[token,new Date(clock-86400000).toISOString()]);
  clock+=4*3600000;const closed=(await reads.summaries(d,[token]))[token];assert.equal(closed.status,'ready');assert.equal(closed.estimatedProfitUsd,'9');assert.equal(closed.realizedProfitUsd,'9');
  const closedReplay=await reads.activity(d,token,`kol:${d}`,true);assert.equal(closedReplay?.replayAccounting?.status,'ready');assert.equal(closedReplay?.replayAccounting?.final?.timestamp,close.occurredAt,'A closed replay keeps its genuine final movement time without requiring a current quote');
  const failedTokenFee=event({walletAddress:d,kind:'fee',quantity:'0',amountUsd:null,feeUsd:'0.2',blockNumber:'131',occurredAt:new Date(clock+1000).toISOString(),feeAttribution:{status:'eligible',tokenAddress:token,nativeFeeWei:'200000000000000'}});await apply([failedTokenFee]);clock+=2000;
  const feeUpkeep=await db.connect();try{await feeUpkeep.query('BEGIN');await refreshFreshRollingKolTotals(feeUpkeep,{now:clock});await feeUpkeep.query('COMMIT');}
  catch(error){await feeUpkeep.query('ROLLBACK');throw error;}finally{feeUpkeep.release();}
  await db.query("UPDATE fresh.checkpoints SET block_number=131 WHERE key IN('capture','decode')");await db.query("UPDATE fresh.positions SET balance_status='matched',balance_quantity='0',balance_block=131,balance_hash=$2,balance_checked_at=$3 WHERE scope_id=$1",[`kol:${d}`,proofHash,new Date(clock).toISOString()]);
  const feeReplay=await reads.activity(d,token,`kol:${d}`,true);assert.equal(feeReplay?.summary.realizedProfitUsd,'8.8');assert.equal(feeReplay?.trades.length,4,'A failed attempt never becomes a buy/sell marker');assert.equal(feeReplay?.inventory?.events.at(-1)?.kind,'fee');assert.equal(feeReplay?.inventory?.events.at(-1)?.tokenAmount,'0');assert.equal(feeReplay?.inventory?.events.at(-1)?.cumulativeRealizedProfitUsd,'8.8');assert.equal(feeReplay?.replayAccounting?.final?.reportedProfitUsd,'8.8');assert.equal(feeReplay?.replayAccounting?.final?.feesUsd,'1.2');assert.equal((await reads.leaderboard()).items.find(item=>item.address===d)?.realizedProfitUsd,feeReplay?.summary.realizedProfitUsd,'Token modal and stored wallet totals include attributable fees once');
  const unallocatedFee=event({walletAddress:c,tokenAddress:null,kind:'fee',quantity:'0',amountUsd:null,feeUsd:null,blockNumber:'131',occurredAt:new Date(clock).toISOString(),feeAttribution:{status:'unattributed',nativeFeeWei:'9999'}});await apply([unallocatedFee]);
  const unallocatedSummary=await service.summary(user,c);assert.equal(unallocatedSummary.exclusions?.feeOnly.count,1);assert.equal(unallocatedSummary.exclusions?.feeOnly.unknownFeeCount,1);assert.equal(unallocatedSummary.positions.length,0);assert.equal(unallocatedSummary.totals.feesUsd,'0','Unrelated unknown failed gas is explicit without blocking eligible-token totals');assert.equal(unallocatedSummary.complete,true);
  const tinyToken=address(),tinyQuantity=`0.${'0'.repeat(76)}1`;await db.query("INSERT INTO fresh.tokens(address,name,symbol,decimals,total_supply_raw,price_usd,observed_at,observed_block,observed_hash,launch_status,valuation_status) VALUES($1,'Exact raw unit','TINY',77,1,'1',$2,133,$3,'eligible','ready')",[tinyToken,new Date(clock+2000).toISOString(),proofHash]);
  await apply([event({walletAddress:d,tokenAddress:tinyToken,quantity:tinyQuantity,amountUsd:'1',feeUsd:'0',feeKey:null,blockNumber:'133',occurredAt:new Date(clock+1000).toISOString()})]);clock+=2000;
  await db.query("UPDATE fresh.checkpoints SET block_number=133,updated_at=$1 WHERE key IN('capture','decode')",[new Date(clock).toISOString()]);
  const tinyRpc:Rpc=async<T>(method:string,params:unknown[]=[])=>{if(method==='eth_getBlockByNumber'){assert.equal(params[0],'0x85');return {number:'0x85',hash:proofHash,timestamp:`0x${Math.floor(clock/1000).toString(16)}`} as T;}
    if(method==='eth_call'){const input=params[0] as {to:string,data:string};assert.deepEqual(params[1],{blockHash:proofHash,requireCanonical:true});const owner=String(balanceAbi.decodeFunctionData('balanceOf',input.data)[0]).toLowerCase();return balanceAbi.encodeFunctionResult('balanceOf',[input.to.toLowerCase()===tinyToken&&owner===d?1n:0n]) as T;}throw new Error('Only confirmed local node reads are allowed');};
  await refreshFreshBalances(db,tinyRpc);
  const tinySummary=(await reads.summaries(d,[tinyToken]))[tinyToken];assert.equal(tinySummary.status,'ready');assert.equal(tinySummary.position,'open');assert.equal(tinySummary.remainingTokenAmount,tinyQuantity);
  const tinyReplay=await reads.activity(d,tinyToken,`kol:${d}`,true);assert.equal(tinyReplay?.trades[0].tokenAmount,tinyQuantity);assert.equal(tinyReplay?.summary.remainingTokenAmount,tinyQuantity);assert.equal(tinyReplay?.inventory?.events[0].tokenAmount,tinyQuantity);assert.equal(tinyReplay?.inventory?.events[0].remainingTokenAmount,tinyQuantity);assert.equal(tinyReplay?.inventory?.coverage.balance,tinyQuantity);assert.equal(tinyReplay?.replayAccounting?.final?.remainingTokenAmount,tinyQuantity);assert.equal(tinyReplay?.token.marketCapSupply,tinyQuantity);
  await db.query("INSERT INTO fresh.jobs(id,kind,reference) VALUES($1,'registration_capture',$2)",[`registration:${d}`,d]);assert.equal((await reads.summaries(d,[token]))[token].reason,'registration_pending');await db.query("DELETE FROM fresh.jobs WHERE kind='registration_capture' AND reference=$1",[d]);
  const unknownToken=address();await db.query("INSERT INTO fresh.tokens(address,name,symbol,decimals,launch_status) VALUES($1,'Unvalued fixture','UNKNOWNVALUE',18,'eligible')",[unknownToken]);
  await apply([event({walletAddress:a,tokenAddress:unknownToken,quantity:'1',amountUsd:null,feeUsd:'0',feeKey:null,blockNumber:'132',occurredAt:new Date(clock+1000).toISOString()})]);
  const unknownPosition=(await service.summary(user,a)).positions.find(position=>position.token.address===unknownToken);assert.equal(unknownPosition?.investedUsd,null);assert.equal(unknownPosition?.feeInclusiveCapitalUsd,null);assert.equal(unknownPosition?.soldUsd,'0','Known zero sales remain distinct from an unknown purchase value');
  // HTTP account/origin isolation uses the same service, with fake authentication.
  let privateCharts=0,revokeDuringChart=false;
  app=Fastify();registerFreshPortfolio(app,{db,reads,replay,now,charts:{chart:async()=>{privateCharts++;if(revokeDuringChart)await service.remove(user,b);return {address:token,period:'1m',resolution:'1m',source:'gmgn',candles:[],points:[],pending:false,stale:false,updatedAt:new Date(clock).toISOString()};}},resolveUser:async req=>req.headers['test-user']==='b'?{id:otherUser,name:'B',username:null,avatarUrl:null}:req.headers['test-user']==='a'?{id:user,name:'A',username:null,avatarUrl:null}:null});
  assert.equal((await app.inject({url:'/api/journal/wallets'})).statusCode,401);
  assert.equal((await app.inject({url:'/api/journal/wallets',headers:{'test-user':'a','x-watchlist-owner':otherUser}})).statusCode,409);
  assert.equal((await app.inject({method:'PATCH',url:`/api/journal/wallets/${b}`,headers:{'test-user':'a',origin:'https://evil.invalid'},payload:{label:'Bad'}})).statusCode,403);
  assert.equal((await app.inject({url:`/api/journal/summary?wallet=${b}`,headers:{'test-user':'b'}})).statusCode,404);
  assert.equal((await app.inject({url:'/api/journal/wallets',headers:{'test-user':'a'}})).headers['cache-control'],'private, no-store');
  assert.equal((await app.inject({url:`/api/journal/wallets/${b}/tokens/${token}/chart`,headers:{'test-user':'b'}})).statusCode,404);assert.equal(privateCharts,0);
  const privateChart=await app.inject({url:`/api/journal/wallets/${b}/tokens/${token}/chart?interval=1m`,headers:{'test-user':'a'}});assert.equal(privateChart.statusCode,200);assert.equal(privateChart.headers['cache-control'],'private, no-store');assert.equal(privateCharts,1);
  revokeDuringChart=true;const revoked=await app.inject({url:`/api/journal/wallets/${b}/tokens/${token}/chart?interval=1m`,headers:{'test-user':'a'}});assert.equal(revoked.statusCode,404);assert.equal(revoked.json().candles,undefined,'Revocation during chart work never returns private data');
  console.log(JSON.stringify({ok:true,checks:['three_wallet_limit','duplicate_registration','private_labels','account_isolation','public_silence','combined_fifo_transfer','node_only_summaries','replay_audience','membership_revocation','resubscription_boundary','origin_protection','stored_profile_leaderboard_equality','canonical_inventory','atomic_replay_reads','capture_pinned_balance','pending_evidence_gate','decode_gap_gate','contradictory_balance_gate'],temporaryDatabase:name}));
}finally{await app?.close();await db.end();await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);await admin.end();}
