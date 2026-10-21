import assert from 'node:assert/strict';
import { ensureSchema,pool as db } from './db.js';
import { createNodeHistoricalImporter } from './nodeHistoricalImport.js';
import { createNodeMarketService } from './nodeMarket.js';
import type { KolTokenBalanceProof } from '../shared/kolTokenTrades.js';
const connection=new URL(process.env.DATABASE_URL||'');
if(!['localhost','127.0.0.1'].includes(connection.hostname)||connection.port!=='5435'||!/^\/bscan_node_import_test_\d+$/.test(connection.pathname))throw new Error('Use a disposable local bscan_node_import_test_<timestamp> database');
const wallet='0x1111111111111111111111111111111111111111',second='0x3333333333333333333333333333333333333333',token='0x2222222222222222222222222222222222222222';
const third='0x4444444444444444444444444444444444444444',privateWallet='0x5555555555555555555555555555555555555555',oldToken='0x6666666666666666666666666666666666666666',olderToken='0x7777777777777777777777777777777777777777';
const hash=(n:number)=>`0x${n.toString(16).padStart(64,'0')}`,now=Date.now(),ending=Math.floor((now-60_000)/1000)*1000,first=ending-7200_000;
let headChanged=false,activityCalls=0,marketCalls=0,failSecondPage=true,failDiscovery=true,failAggregateOrder=true;
const aggregateOrders:string[]=[];
const row=(owner:string,event_type:string,amount:string,cost:string,ordinal:number,at:number)=>({wallet:owner,chain:'bsc',token:{address:token},tx_hash:hash(ordinal),event_type,token_amount:amount,cost_usd:cost,gas_usd:'0',dex_usd:'0',priority_fee:'0',tip_fee:'0',timestamp:at/1000});
const buys=new Map([wallet,second].map((owner,index)=>[owner,row(owner,'buy','10','100',index*100+1,first)]));
const sells=new Map([wallet,second].map((owner,index)=>[owner,row(owner,'sell','4','80',index*100+2,first+3600_000)]));
const transfer=row(wallet,'transferIn','1','10',3,first+5400_000);
const proof=(owner:string):KolTokenBalanceProof=>({walletAddress:owner,tokenAddress:token,chain:'bsc',blockNumber:'200',blockHash:hash(200),blockTimestamp:new Date(ending).toISOString(),checkedAt:new Date(now).toISOString(),balance:owner===wallet?'7':'6'});
const request=async(url:URL,options:any)=>{
  if(url.pathname.endsWith('/wallet_activity')){
    assert.equal(options.workload,'accounting');activityCalls++;
    const owner=url.searchParams.get('wallet_address')!,cursor=url.searchParams.get('cursor');
    assert.notEqual(owner,privateWallet,'private Portfolio memberships never enter provider onboarding discovery');
    if(owner===third){assert.equal(url.searchParams.has('token_address'),false,'discovery is unfiltered lifetime wallet activity');
      if(cursor&&failDiscovery){failDiscovery=false;throw new Error('fake_discovery_cooldown');}
      const item={...row(third,'buy','10','100',300,cursor?first-60000:first),token:{address:cursor?olderToken:oldToken,symbol:'NEW',name:'Discovered historical token'}};
      return {code:0,data:{activities:[item],next:cursor?null:'discover-older'}};}
    if(owner===second){if(cursor==='older'&&failSecondPage){failSecondPage=false;throw new Error('fake_provider_cooldown');}
      return {code:0,data:{activities:cursor?[buys.get(owner)]:[sells.get(owner)],next:cursor?null:'older'}};}
    const activities=headChanged?[transfer,sells.get(owner),buys.get(owner)]:[sells.get(owner),buys.get(owner)];
    headChanged=true;return {code:0,data:{activities,next:null}};
  }
  if(url.pathname.endsWith('/token_top_traders')){assert.equal(options.workload,'accounting','top traders keeps accounting key despite /market path');
    const order=url.searchParams.get('order_by')!;aggregateOrders.push(order);
    if(order==='profit'&&failAggregateOrder){failAggregateOrder=false;throw new Error('fake_aggregate_cooldown');}
    return {code:0,data:{list:[]}};}
  if(url.pathname.endsWith('/token_kline')){
    assert.equal(options.workload,'market');marketCalls++;
    const from=Number(url.searchParams.get('from')),to=Number(url.searchParams.get('to')),data=[];
    const step=({'1m':60,'5m':300,'1h':3600,'4h':14400,'1d':86400} as Record<string,number>)[url.searchParams.get('resolution')!]*1000;
    for(let time=from;time<=to;time+=step)data.push({time,open:'1',high:'2',low:'0.5',close:'1.5',volume:'10'});
    return {code:0,data};
  }
  throw new Error('unexpected_import_endpoint');
};
globalThis.fetch=async()=>{throw new Error('external_financial_request_forbidden');};
try{
  await ensureSchema();
  await db.query('INSERT INTO tokens(address,decimals) VALUES($1,9)',[token]);
  await db.query(`INSERT INTO node_market_token_evidence(token_address,block_number,block_hash,timestamp,decimals,total_supply_raw,supply) VALUES($1,200,$2,$3,18,1000000000000000000000000,1000000)`,[token,hash(200),new Date(ending)]);
  await db.query(`INSERT INTO node_evidence_blocks(block_number,block_hash,parent_hash,timestamp,header) VALUES(200,$1,$2,$3,'{}')`,[hash(200),hash(199),new Date(ending)]);
  for(const owner of [wallet,second]){
    await db.query('INSERT INTO kols(address,is_tracked) VALUES($1,true)',[owner]);
    await db.query(`INSERT INTO node_monitored_wallets(wallet_address,generation,active,registration_block,registration_hash,decoded_through_block,collected_through_block)
      VALUES($1,'00000000-0000-4000-8000-000000000001',true,100,$2,200,200)`,[owner,hash(100)]);
    for(const entry of [buys.get(owner)!,sells.get(owner)!])await db.query(`INSERT INTO trades(id,tx_hash,wallet_address,token_address,side,token_amount,amount_usd,timestamp,source,block_number,block_hash)
      VALUES($1,$1,$2,$3,$4,$5,$6,$7,'node',150,$8)`,[entry.tx_hash,owner,token,entry.event_type,entry.token_amount,entry.cost_usd,new Date(entry.timestamp*1000),hash(150)]);
  }
  // Raw capture can be complete while the legacy trade projection still awaits
  // historical metadata. Its authentic execution must reconcile without a
  // provider display quantity becoming the independent evidence.
  const pendingBuy=buys.get(wallet)!;
  await db.query('UPDATE trades SET token_amount=NULL WHERE tx_hash=$1',[pendingBuy.tx_hash]);
  await db.query(`INSERT INTO node_evidence_blocks(block_number,block_hash,parent_hash,timestamp,header)
    VALUES(150,$1,$2,$3,'{}')`,[hash(150),hash(149),new Date(first)]);
  await db.query(`INSERT INTO node_evidence_transactions(tx_hash,block_number,block_hash,transaction_index,timestamp,transaction,receipt,observed_live)
    VALUES($1,150,$2,0,$3,'{}','{}',true)`,[pendingBuy.tx_hash,hash(150),new Date(first)]);
  await db.query(`INSERT INTO node_executions(id,tx_hash,wallet_address,execution_index,block_number,block_hash,transaction_index,timestamp,status,kind,
    fee_native_wei,fee_complete,native_value_raw,logs,decoder_version) VALUES('pending-buy',$1,$2,0,150,$3,0,$4,'success','transaction',0,true,0,'[]',1)`,
    [pendingBuy.tx_hash,wallet,hash(150),new Date(first)]);
  await db.query(`INSERT INTO node_execution_flows(execution_id,token_address,delta_raw,log_indices,counterparties)
    VALUES('pending-buy',$1,10000000000000000000,'{}','{}')`,[token]);
  const market=createNodeMarketService({db,rpc:async()=>{throw new Error('unexpected_node_read');},now:()=>now});
  const importer=createNodeHistoricalImporter({db,request:request as never,market,now:()=>now,balance:async input=>{
    assert.equal(input.decimals,18,'verified contract precision replaces legacy guessed token metadata');return proof(input.wallet);
  }});
  await importer.queuePublicKols();
  // Keep the second job behind the first to test a changing first head and
  // independently resumable older pages in deterministic order.
  await db.query('UPDATE node_import_jobs SET priority=100 WHERE wallet_address=$1',[wallet]);
  await db.query('UPDATE node_import_jobs SET priority=20 WHERE wallet_address=$1',[second]);
  assert.equal((await importer.tick()).stage,'history');
  assert.equal((await importer.tick()).stage,'aggregate');
  assert.equal((await db.query('SELECT aggregate_orders FROM node_import_jobs WHERE wallet_address=$1',[wallet])).rows[0].aggregate_orders.length,1,
    'A completed aggregate scan is persisted before the next weighted request');
  assert.equal((await importer.tick()).status,'retry');
  assert.deepEqual((await db.query('SELECT aggregate_orders FROM node_import_jobs WHERE wallet_address=$1',[wallet])).rows[0].aggregate_orders,['amount_percentage']);
  await db.query('UPDATE node_import_jobs SET next_attempt_at=now() WHERE wallet_address=$1',[wallet]);
  assert.equal((await importer.tick()).stage,'aggregate');
  assert.equal((await importer.tick()).stage,'aggregate');
  assert.deepEqual(aggregateOrders,['amount_percentage','profit','profit','buy_volume_cur'],
    'A retry resumes the deferred aggregate order instead of repeating an already completed scan');
  await db.query('UPDATE node_monitored_wallets SET registration_block=NULL WHERE wallet_address=$1',[wallet]);
  const unanchored=await importer.tick();
  assert.equal(unanchored.status,'retry');assert.equal(unanchored.reason,'import_node_checkpoint_pending','an unanchored monitoring generation waits explicitly instead of creating a baseline');
  assert.equal((await db.query('SELECT count(*)::int AS n FROM node_accounting_baselines WHERE wallet_address=$1',[wallet])).rows[0].n,0);
  await db.query('UPDATE node_monitored_wallets SET registration_block=100 WHERE wallet_address=$1',[wallet]);
  let firstComplete=false;
  for(let count=0;count<12;count++){
    await db.query("UPDATE node_import_jobs SET next_attempt_at=now()-interval '1 second'");
    const state=await importer.tick();assert.notEqual(state.status,'retry',JSON.stringify(state));
    if((await db.query('SELECT stage FROM node_import_jobs WHERE wallet_address=$1',[wallet])).rows[0].stage==='done'){firstComplete=true;break;}
  }
  assert.equal(firstComplete,true,'head refresh compares against updated persisted movements, never retries forever');
  assert.equal((await db.query('SELECT priority FROM node_import_jobs WHERE wallet_address=$1',[wallet])).rows[0].priority,100,
    'A selected replay retains foreground priority after its accounting baseline completes');
  const baseline=(await db.query('SELECT ledger,events FROM node_accounting_baselines WHERE wallet_address=$1',[wallet])).rows[0];
  assert.equal(baseline.events.length,3);assert.equal(baseline.ledger.incomingTransferCostUsd,'10');assert.equal(baseline.ledger.realizedProfitUsd,'40');
  assert.equal(baseline.ledger.lots.reduce((sum:number,lot:any)=>sum+Number(lot.tokenAmount),0),7);assert.ok(baseline.events.every((event:any)=>event.blockNumber===null));
  assert.equal((await db.query("SELECT count(*)::int n FROM node_import_page_versions WHERE wallet_address=$1 AND cursor_key='head'",[wallet])).rows[0].n,2,'both successful head versions retained as evidence');
  const requestsBefore=marketCalls;assert.equal(requestsBefore,1);
  // These fixture wallets already have explicit pair histories; keep unrelated
  // onboarding discovery out of the card-to-background-chart scheduling test.
  await db.query("UPDATE node_import_wallet_jobs SET stage='done',completed_at=now() WHERE wallet_address=ANY($1::text[])",[[wallet,second]]);
  let failed=false,secondComplete=false;
  for(let count=0;count<12;count++){
    await db.query("UPDATE node_import_jobs SET next_attempt_at=now()-interval '1 second'");
    const state=await importer.tick();
    if(state.status==='retry'){failed=true;assert.equal((await db.query('SELECT cursor FROM node_import_jobs WHERE wallet_address=$1',[second])).rows[0].cursor,'older');
      assert.equal((await db.query('SELECT count(*)::int n FROM node_import_movements WHERE wallet_address=$1',[second])).rows[0].n,1,'a cooldown preserves completed earlier pages');}
    if((await db.query('SELECT stage FROM node_import_jobs WHERE wallet_address=$1',[second])).rows[0].stage==='done'){secondComplete=true;break;}
  }
  assert.equal(failed,true);assert.equal(secondComplete,true);assert.equal(marketCalls,requestsBefore,'shared historical market pages are reused across wallets');
  assert.equal((await db.query('SELECT priority FROM node_import_jobs WHERE wallet_address=$1',[second])).rows[0].priority,0,
    'A card-only import releases priority after its baseline, keeping a long chart behind waiting card histories');
  assert.equal((await db.query('SELECT count(DISTINCT cursor_key)::int n FROM node_import_page_versions WHERE wallet_address=$1',[second])).rows[0].n,2,
    'Immutable page evidence preserves both completed cursors without a duplicate mutable page table');
  assert.equal((await market.chart(token,{from:new Date(first).toISOString(),to:new Date(ending).toISOString()})).source,'imported');
  await db.query("UPDATE node_import_wallet_jobs SET stage='done',completed_at=now()");
  await db.query('INSERT INTO kols(address,is_tracked) VALUES($1,true),($2,false)',[third,privateWallet]);
  await importer.queuePublicKols();
  assert.equal((await db.query('SELECT count(*)::int n FROM node_import_wallet_jobs WHERE wallet_address=$1',[privateWallet])).rows[0].n,0);
  assert.equal((await importer.tick()).stage,'wallet_discovery');
  assert.equal((await db.query('SELECT count(*)::int n FROM node_import_jobs WHERE wallet_address=$1 AND token_address=$2',[third,oldToken])).rows[0].n,1,'a public wallet with zero indexed trades queues its discovered old token');
  assert.equal((await db.query('SELECT decimals FROM tokens WHERE address=$1',[oldToken])).rows[0].decimals,null,'provider metadata never guesses financial precision');
  await db.query('UPDATE node_import_jobs SET priority=0 WHERE wallet_address=$1',[third]);
  assert.equal((await importer.tick()).status,'retry');
  assert.equal((await db.query('SELECT cursor FROM node_import_wallet_jobs WHERE wallet_address=$1',[third])).rows[0].cursor,'discover-older');
  assert.equal((await db.query('SELECT count(*)::int n FROM node_import_wallet_pages WHERE wallet_address=$1',[third])).rows[0].n,1,'cooldown preserves earlier wallet discovery pages');
  await db.query("UPDATE node_import_wallet_jobs SET next_attempt_at=now()-interval '1 second' WHERE wallet_address=$1",[third]);
  assert.equal((await importer.tick()).status,'progress');
  await db.query('UPDATE node_import_jobs SET priority=0 WHERE wallet_address=$1',[third]);
  assert.equal((await importer.tick()).stage,'wallet_discovery_verified');
  await importer.queuePublicKols();
  assert.equal((await db.query('SELECT stage FROM node_import_wallet_jobs WHERE wallet_address=$1',[third])).rows[0].stage,'done','completed wallet onboarding never restarts');
  assert.equal((await db.query('SELECT count(*)::int n FROM node_import_jobs WHERE wallet_address=$1',[third])).rows[0].n,2);
  assert.ok((await db.query('SELECT head_verified_at FROM node_import_wallet_jobs WHERE wallet_address=$1',[third])).rows[0].head_verified_at,'completed history includes a refreshed head check');
  const longToken='0x8888888888888888888888888888888888888888',oldFrom='2026-04-15T10:00:35Z',oldEnding='2026-10-16T10:00:25Z';
  await db.query(`INSERT INTO node_import_jobs(wallet_address,token_address,priority,stage,history_complete,chart_from,chart_to,chart_cursor)
    VALUES($1,$2,1000,'chart',true,$3,$4,$4)`,[wallet,longToken,oldFrom,oldEnding]);
  let oldComplete=false,tailStage=false;
  for(let count=0;count<8;count++){
    const status=await importer.tick();assert.notEqual(status.status,'retry',JSON.stringify(status));
    const state=(await db.query('SELECT stage FROM node_import_jobs WHERE wallet_address=$1 AND token_address=$2',[wallet,longToken])).rows[0].stage;
    tailStage||=state==='chart_tail';if(state==='done'){oldComplete=true;break;}
  }
  assert.equal(tailStage,true);assert.equal(oldComplete,true,'long imports prepare their fine ending segment before completion');
  const fine=await market.chart(longToken,{from:new Date(Date.parse(oldEnding)-6*3600_000).toISOString(),to:oldEnding,intervalSeconds:60});
  assert.equal(fine.complete,true);assert.ok(fine.bars.length>=350);assert.equal(fine.bars.at(-1)?.intervalSeconds,60);
  const chartProofs=(await db.query(`SELECT DISTINCT import_id FROM node_market_import_ranges WHERE token_address=$1 AND complete`,[longToken])).rows.map(row=>row.import_id);
  assert.ok(chartProofs.some(id=>id.endsWith(':interval:60'))&&chartProofs.some(id=>id.endsWith(':interval:14400')),
    'Coarse lifetime history and its overlapping genuine minute tail retain separate resolution proofs');
  assert.ok(Date.parse(fine.bars.at(-1)!.timestamp)+60000>=Date.parse(oldEnding),'an old closed ending has a genuinely completed bracketing minute bar');
  const cooldown=new Date(now+300000);
  await db.query(`UPDATE node_import_jobs SET chart_gaps=true,next_attempt_at=$3,last_error='import_provider_cooldown'
    WHERE wallet_address=$1 AND token_address=$2`,[wallet,token,cooldown]);
  const beforeResume=marketCalls;
  assert.equal(await importer.resumeChartGaps(wallet,token,{from:new Date(first).toISOString(),to:new Date(now).toISOString()}),true);
  const resumed=(await db.query('SELECT stage,next_attempt_at,chart_to FROM node_import_jobs WHERE wallet_address=$1 AND token_address=$2',[wallet,token])).rows[0];
  assert.equal(resumed.stage,'chart');assert.equal(resumed.next_attempt_at.toISOString(),cooldown.toISOString(),'selected resumption never shortens a provider cooldown');
  assert.equal(resumed.chart_to.toISOString(),new Date(ending).toISOString(),'normal node activity after the baseline never extends GMGN financial requests');
  assert.equal(marketCalls,beforeResume,'resumption is a database queue action, never a page request');
  assert.equal(await importer.resumeChartGaps(privateWallet,token),false,'private memberships cannot invoke public historical imports');
  await db.query("UPDATE node_import_jobs SET stage='done',chart_gaps=false,last_error=NULL,next_attempt_at=now() WHERE wallet_address=$1 AND token_address=$2",[wallet,token]);
  const retainedPages=(await db.query('SELECT count(*)::int AS n FROM node_import_page_versions WHERE wallet_address=$1',[wallet])).rows[0].n;
  const retainedDiscovery=(await db.query('SELECT count(*)::int AS n FROM node_import_wallet_pages WHERE wallet_address=$1',[wallet])).rows[0].n;
  await db.query(`UPDATE node_monitored_wallets SET registration_block=201,registered_at=clock_timestamp() WHERE wallet_address=$1`,[wallet]);
  await importer.queuePublicKols();
  assert.equal((await db.query('SELECT stage FROM node_import_jobs WHERE wallet_address=$1 AND token_address=$2',[wallet,token])).rows[0].stage,'history','a baseline older than a new monitor boundary resumes import');
  assert.equal((await db.query('SELECT stage FROM node_import_wallet_jobs WHERE wallet_address=$1',[wallet])).rows[0].stage,'history','old wallet-wide absence evidence cannot authorize a newly monitored interval');
  assert.equal((await db.query('SELECT count(*)::int AS n FROM node_import_page_versions WHERE wallet_address=$1',[wallet])).rows[0].n,retainedPages,'re-registration preserves successful historical pages');
  assert.equal((await db.query('SELECT count(*)::int AS n FROM node_import_wallet_pages WHERE wallet_address=$1',[wallet])).rows[0].n,retainedDiscovery);
  const restartedAt=(await db.query('SELECT requested_at FROM node_import_jobs WHERE wallet_address=$1 AND token_address=$2',[wallet,token])).rows[0].requested_at.toISOString();
  await importer.queuePublicKols();
  assert.equal((await db.query('SELECT requested_at FROM node_import_jobs WHERE wallet_address=$1 AND token_address=$2',[wallet,token])).rows[0].requested_at.toISOString(),restartedAt,'worker discovery does not repeatedly restart the new generation');
  console.log('Historical importer integration passed: changing head converges, page evidence survives cooldown, verified decimals, full transfer-aware FIFO baseline, provider-only block identities, separate workloads and shared persisted chart pages.');
}finally{await db.end();}
