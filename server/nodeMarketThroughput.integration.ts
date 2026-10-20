/** Disposable PostgreSQL only: genuine encoded swaps, no real RPC/providers. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {createNodeMarketService,ensureNodeMarketSchema} from './nodeMarket.js';
import {poolMarketAbi,TRUSTED_QUOTE_FEEDS} from './nodeMarketProtocols.js';
import {PCS_V2_FACTORY,WBNB} from './launchpad.js';
const configured=new URL(process.env.DATABASE_URL??'postgres://invalid');
if(!['127.0.0.1','localhost'].includes(configured.hostname)||configured.port!=='5435')throw Error('Disposable local PostgreSQL only');
const admin=new pg.Client({connectionString:configured.href});await admin.connect();
const name='bscan_node_market_throughput_'+randomUUID().replaceAll('-','');await admin.query(`CREATE DATABASE "${name}"`);
const target=new URL(configured);target.pathname='/'+name;const db=new pg.Pool({connectionString:target.href,max:6});
const token='0x1111111111111111111111111111111111111111',contract='0x2222222222222222222222222222222222222222',trader='0x3333333333333333333333333333333333333333';
const hash=(n:number)=>'0x'+n.toString(16).padStart(64,'0'),base=Date.now()-60_000,at=(n:number)=>new Date(base+(n-100)*1000).toISOString();
const feed=TRUSTED_QUOTE_FEEDS[WBNB],market=contract+':'+token;
let rpcCalls=0;const noRpc=async()=>{rpcCalls++;throw Error('No node or financial network in persisted decode');};
let boundedDeadlineTest=false;
let proofQuery:{sql:string;parameters:any[]}|null=null;
const measured={connect:db.connect.bind(db),query:(async(...args:any[])=>{
  if(typeof args[0]==='string'&&args[0].includes('SELECT proof.* FROM ('))proofQuery={sql:args[0],parameters:args[1]};
  if(boundedDeadlineTest&&typeof args[0]==='string'&&args[0].startsWith('UPDATE node_market_raw_logs SET decode_status='))
    await new Promise(resolve=>setTimeout(resolve,10));
  return(db.query as any)(...args);
}) as typeof db.query};
try{
  await ensureNodeMarketSchema(db);
  await db.query(`CREATE TABLE worker_state(key text PRIMARY KEY,value jsonb NOT NULL,updated_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE tokens(address text PRIMARY KEY,symbol text,name text);
    CREATE TABLE node_evidence_blocks(block_number bigint PRIMARY KEY,block_hash text UNIQUE NOT NULL,parent_hash text NOT NULL,timestamp timestamptz NOT NULL)`);
  await db.query('INSERT INTO tokens VALUES($1,\'TEST\',\'Independent market\')',[token]);
  await db.query(`INSERT INTO node_markets(id,token_address,quote_address,protocol,contract_address,token0,token1,decimals0,decimals1,
    authenticated_at_block,authenticated_block_hash,authentication,status) VALUES($1,$2,$3,'pcs_v2',$4,$2,$3,18,18,100,$5,$6::jsonb,'active')`,
    [market,token,WBNB,contract,hash(100),JSON.stringify({factory:PCS_V2_FACTORY})]);
  for(let height=100;height<=121;height++){
    await db.query('INSERT INTO node_evidence_blocks VALUES($1,$2,$3,$4)',[height,hash(height),hash(height-1),at(height)]);
    await db.query(`INSERT INTO node_market_token_evidence(token_address,block_number,block_hash,timestamp,decimals,total_supply_raw,supply)
      SELECT unnest($1::text[]),$2,$3,$4,18,1000000000000000000000000,1000000`,[[token,WBNB],height,hash(height),at(height)]);
    await db.query(`INSERT INTO node_market_feed_evidence(quote_address,feed_address,feed_description,block_number,block_hash,timestamp,
      round_id,answered_in_round,answer_raw,feed_decimals,price_usd,updated_at) VALUES($1,$2,$3,$4,$5,$6,10,10,50000000000,8,500,$6)`,
      [WBNB,feed.feed,feed.description,height,hash(height),at(height)]);
  }
  // Large unrelated older proof histories make the real lookup plan choose an
  // observation index; neither test timing nor enable_seqscan is manipulated.
  await db.query(`INSERT INTO node_market_feed_evidence(quote_address,feed_address,feed_description,block_number,block_hash,timestamp,
    round_id,answered_in_round,answer_raw,feed_decimals,price_usd,updated_at)
    SELECT $1,$2,$3,n,'0x'||lpad(to_hex(100000+n),64,'0'),$4::timestamptz-interval '1 day'-n*interval '1 minute',
      10,10,50000000000,8,500,$4::timestamptz-interval '1 day'-n*interval '1 minute' FROM generate_series(1,12000)n`,[WBNB,feed.feed,feed.description,at(100)]);
  await db.query(`INSERT INTO node_market_quote_evidence(quote_address,block_number,block_hash,timestamp,price_usd,base_quote_address,pool_address,protocol,depth_usd,evidence)
    SELECT $1,n,'0x'||lpad(to_hex(200000+n),64,'0'),$4::timestamptz-interval '1 day'-n*interval '1 minute',500,$1,$2,'pcs_v2',1000,$3::jsonb
      FROM generate_series(1,12000)n`,[WBNB,contract,'{}',at(100)]);
  await db.query('ANALYZE node_market_feed_evidence;ANALYZE node_market_quote_evidence');
  const event=poolMarketAbi.encodeEventLog(poolMarketAbi.getEvent('Swap')!,[trader,0,2n*10n**18n,1000n*10n**18n,0,trader]);
  const entries=Array.from({length:300},(_,index)=>{const height=100+index%20;return{market_id:market,block_number:height,block_hash:hash(height),tx_hash:hash(10000+index),
    transaction_index:index,log_index:0,timestamp:at(height),log:{address:contract,...event,blockNumber:'0x'+height.toString(16),blockHash:hash(height),
      transactionHash:hash(10000+index),transactionIndex:'0x'+index.toString(16),logIndex:'0x0'}};});
  const insert=async(rows:typeof entries)=>db.query(`INSERT INTO node_market_raw_logs(market_id,block_number,block_hash,tx_hash,transaction_index,log_index,timestamp,log,decode_status)
    SELECT market_id,block_number,block_hash,tx_hash,transaction_index,log_index,timestamp,log,'pending' FROM jsonb_to_recordset($1::jsonb)
      r(market_id text,block_number bigint,block_hash text,tx_hash text,transaction_index integer,log_index integer,timestamp timestamptz,log jsonb)`,[JSON.stringify(rows)]);
  await insert(entries);
  const service=createNodeMarketService({db:measured,rpc:noRpc});
  const locker=await db.connect();await locker.query('BEGIN');await locker.query('SELECT pg_advisory_xact_lock(908335)');
  let result:Awaited<ReturnType<typeof service.decodePending>>|undefined;
  const running=service.decodePending(300,{minimumBlock:100,databaseOnly:true}).then(value=>{result=value;return value;});
  // Observe rejection immediately and always drain after releasing the test's
  // projection lock. Otherwise an earlier assertion can end the pool while
  // the intentionally blocked decoder is still using it, masking that failure.
  const drained=running.then(()=>undefined,()=>undefined);
  try{
    const deadline=Date.now()+10_000;let saved=0;
    while(Date.now()<deadline){saved=(await db.query("SELECT count(*)::int n FROM node_market_observations WHERE source='node'")).rows[0].n;if(saved===300)break;await new Promise(resolve=>setTimeout(resolve,20));}
    assert.equal(saved,300,'All bounded append-only observations progress while unrelated collection/projection owns908335');
    assert.equal((await db.query("SELECT count(*)::int n FROM node_market_raw_logs WHERE decode_status='decoded'")).rows[0].n,300);
    assert.equal(result,undefined,'Mutable candle projection still waits for its serialization lock');
  }finally{try{await locker.query('ROLLBACK');}finally{locker.release();await drained;}}
  const completed=await running;assert.equal(completed.decoded,300);assert.equal(rpcCalls,0);
  assert.ok('timings'in completed&&completed.timings.selected===300);assert.ok((await service.chart(token,{from:at(100),to:at(119)})).bars.length>0);
  assert.ok(proofQuery);const captured=proofQuery as {sql:string;parameters:any[]};
  const plan=(await db.query('EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON) '+captured.sql,captured.parameters)).rows[0]['QUERY PLAN'][0];
  const nodes:any[]=[];const walk=(node:any)=>{nodes.push(node);for(const child of node.Plans??[])walk(child);};walk(plan.Plan);
  assert.ok(nodes.some(node=>node['Index Name']==='node_market_feed_observation'));
  assert.ok(!nodes.some(node=>node['Node Type']==='Seq Scan'&&['node_market_feed_evidence','node_market_quote_evidence'].includes(node['Relation Name'])),
    'Actual source query uses bounded indexes rather than scanning either proof history per swap');

  await db.query('DELETE FROM node_market_feed_evidence WHERE block_hash=$1',[hash(120)]);
  await db.query(`INSERT INTO node_market_feed_evidence(quote_address,feed_address,block_number,block_hash,timestamp,round_id,answered_in_round,answer_raw,feed_decimals,price_usd,updated_at,feed_description)
    SELECT quote_address,feed_address,120,$1,$2,round_id,answered_in_round,100000000000,feed_decimals,1000,$2,feed_description
    FROM node_market_feed_evidence WHERE block_hash=$3`,[hash(999120),at(120),hash(119)]);
  const last={...entries[0],block_number:120,block_hash:hash(120),timestamp:at(120),tx_hash:hash(999120),
    log:{...entries[0].log,blockNumber:'0x78',blockHash:hash(120),transactionHash:hash(999120)}};
  await insert([last]);
  assert.equal((await service.decodePending(1,{minimumBlock:120,databaseOnly:true})).decoded,1);
  const kept=(await db.query('SELECT quote_evidence,price_usd::text FROM node_market_observations WHERE tx_hash=$1',[hash(999120)])).rows[0];
  assert.equal(kept.quote_evidence.block_number,'119');assert.equal(kept.price_usd,'1',
    'An orphaned newer proof cannot hide a valid older canonical proof inside the two-minute window');
  const entryAt=(height:number,id:number)=>({...entries[0],block_number:height,block_hash:hash(height),timestamp:at(height),tx_hash:hash(id),transaction_index:id,
    log:{...entries[0].log,blockNumber:'0x'+height.toString(16),blockHash:hash(height),transactionHash:hash(id),transactionIndex:'0x'+id.toString(16)}});
  const older=entryAt(100,2000000);
  await insert([older]);
  await db.query(`INSERT INTO node_market_history_jobs(token_address,window_id,from_at,to_at,priority,expires_at)
    VALUES($1,'deadline-fairness',$2,$2,10,now()+interval '10 minutes')`,[token,at(105)]);
  await db.query(`INSERT INTO worker_state(key,value)VALUES('node_market_decode_recovery',$1::jsonb)
    ON CONFLICT(key)DO UPDATE SET value=EXCLUDED.value`,[JSON.stringify({nextLane:0,pending:{block:'104',transactionIndex:0,logIndex:0,market,transaction:hash(0),hash:hash(104)}})]);
  boundedDeadlineTest=true;
  const boundedRuns=[];
  for(let cycle=0;cycle<8;cycle++){
    // Both higher-priority queues and the recent ready retry queue remain
    // full. Recreate the service each time:
    // persisted examined progress, not process-local rotation, must protect
    // the old ready row from a one-row deadline and worker restarts.
    const recent=[entryAt(115,2300000+cycle*2),entryAt(115,2300001+cycle*2)];
    await insert([entryAt(105,2100000+cycle*2),entryAt(105,2100001+cycle*2),entryAt(121,2200000+cycle*2),entryAt(121,2200001+cycle*2),...recent]);
    await db.query("UPDATE node_market_raw_logs SET decode_status='missing_quote' WHERE tx_hash=ANY($1::text[])",[recent.map(row=>row.tx_hash)]);
    const restarted=createNodeMarketService({db:measured,rpc:noRpc});
    const value=await restarted.decodePending(2,{minimumBlock:110,allowCapturedOlder:true,databaseOnly:true,maxDurationMs:1});
    assert.equal(value.examined,1);boundedRuns.push(value.decoded);
  }
  boundedDeadlineTest=false;
  assert.equal((await db.query('SELECT decode_status FROM node_market_raw_logs WHERE tx_hash=$1',[older.tx_hash])).rows[0].decode_status,'decoded',
    'A captured older row progresses despite continuously full selected/current/recent-retry queues and deadlines that permit one examined row');
  assert.equal((await db.query('SELECT count(*)::int n FROM node_market_observations WHERE tx_hash=$1',[older.tx_hash])).rows[0].n,1,
    'Resumed recovery creates one canonical observation');
  assert.equal(rpcCalls,0);
  console.log(JSON.stringify({passed:true,observations:300,providerRequests:rpcCalls,timings:'timings'in completed?completed.timings:null,
    boundedFairRuns:boundedRuns,proofPlanMs:plan['Execution Time'],proofBuffers:plan.Plan['Shared Hit Blocks'],indexes:[...new Set(nodes.map(node=>node['Index Name']).filter(Boolean))]}));
}finally{await db.end();await admin.query(`DROP DATABASE "${name}" WITH(FORCE)`);await admin.end();}
