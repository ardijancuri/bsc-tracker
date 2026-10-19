/** Never contacts Telegram, external financial providers or the real node. */
import assert from 'node:assert/strict';
import pg from 'pg';
import { createNodeMarketService, ensureNodeMarketSchema, rollbackNodeMarket } from './nodeMarket.js';
import {ensureNodeEvidenceMetadataSchema} from './nodeEvidenceMetadata.js';
import { erc20MarketAbi, oracleMarketAbi, poolMarketAbi,v3MarketAbi,flapMarketAbi, TRUSTED_QUOTE_FEEDS, type NodeMarketLog } from './nodeMarketProtocols.js';
import { FLAP_PORTAL, FOUR_HELPER, PCS_V2_FACTORY, PCS_V3_FACTORY, WBNB, flapInterface, fourInterface } from './launchpad.js';
import type { Rpc } from './rpc.js';
const connection=new URL(process.env.DATABASE_URL||'');
if(!['localhost','127.0.0.1'].includes(connection.hostname)||connection.port!=='5435'||!/^\/bscan_node_market_test_\d+$/.test(connection.pathname)) throw new Error('Use an explicitly disposable local bscan_node_market_test_<timestamp> database');
const db=new pg.Pool({connectionString:connection.href});
const token='0x1111111111111111111111111111111111111111',pool='0x2222222222222222222222222222222222222222',otherTrader='0x3333333333333333333333333333333333333333';
const zero='0x0000000000000000000000000000000000000000',hash=(height:number)=>`0x${height.toString(16).padStart(64,'0')}`;
const start=Date.parse('2026-10-18T10:00:00Z'),timestamp=(height:number)=>new Date(start+(height-100)*60_000).toISOString(),hex=(height:number)=>`0x${height.toString(16)}`;
let now=Date.parse(timestamp(102)),feedAvailable=true,wrongBlock=false,quoteReserves=2n*10n**18n,supply=1_000_000n*10n**18n,rpcCalls=0,headerRpcCalls=0,rpcHead=108;
let forkAt=Infinity,pauseState=false,enteredState:()=>void=()=>{},releaseState:()=>void=()=>{};
let statePause=Promise.resolve();const canonicalHash=(height:number)=>hash(height>=forkAt?height+100000:height);
const logs:NodeMarketLog[]=[100,101].flatMap(height=>{
  const sync=poolMarketAbi.encodeEventLog(poolMarketAbi.getEvent('Sync')!,[1000n*10n**18n,2n*10n**18n]);
  const swap=poolMarketAbi.encodeEventLog(poolMarketAbi.getEvent('Swap')!,[otherTrader,0,2n*10n**18n,1000n*10n**18n,0,otherTrader]);
  return [sync,swap].map((event,index)=>({address:pool,...event,blockNumber:hex(height),blockHash:hash(height),transactionHash:hash(height+10000),transactionIndex:'0x0',logIndex:hex(index)}));
});
const rpc:Rpc=async<T>(method:string,params:unknown[]):Promise<T>=>{
  rpcCalls++;
  if(method==='eth_blockNumber')return hex(rpcHead) as T;
  if(method==='eth_getBlockByNumber'){headerRpcCalls++;const height=Number(BigInt(String(params[0])));return {number:hex(wrongBlock?height+1:height),hash:canonicalHash(height),parentHash:canonicalHash(Math.max(0,height-1)),timestamp:hex(Date.parse(timestamp(height))/1000)} as T;}
  if(method==='eth_getLogs'){const filter=params[0] as {fromBlock:string;toBlock:string;address:string[]};return logs.filter(log=>BigInt(log.blockNumber)>=BigInt(filter.fromBlock)&&BigInt(log.blockNumber)<=BigInt(filter.toBlock)&&filter.address.includes(log.address)) as T;}
  if(method!=='eth_call')throw new Error('unexpected_rpc');
  const request=params[0] as {to:string;data:string},tag=params[1] as {blockHash:string;requireCanonical:boolean};
  assert.equal(tag.requireCanonical,true,'state calls are bound to a canonical hash, never just a mutable height');
  const encodedHeight=Number(BigInt(tag.blockHash)),height=encodedHeight>=100000?encodedHeight-100000:encodedHeight,to=request.to.toLowerCase();
  if(tag.blockHash!==canonicalHash(height))throw new Error('noncanonical_hash');
  if(to===token||to===WBNB){
    const method=erc20MarketAbi.getFunction(request.data.slice(0,10))?.name;
    if(method==='decimals')return erc20MarketAbi.encodeFunctionResult(method,[18]) as T;
    if(method==='totalSupply')return erc20MarketAbi.encodeFunctionResult(method,[supply]) as T;
  }
  if(to===TRUSTED_QUOTE_FEEDS[WBNB].feed){
    if(!feedAvailable)throw new Error('temporary_node_failure');
    const method=oracleMarketAbi.getFunction(request.data.slice(0,10))?.name;
    if(method==='decimals')return oracleMarketAbi.encodeFunctionResult(method,[8]) as T;
    if(method==='description')return oracleMarketAbi.encodeFunctionResult(method,['BNB / USD']) as T;
    if(method==='latestRoundData')return oracleMarketAbi.encodeFunctionResult(method,[10,500n*10n**8n,Date.parse(timestamp(height))/1000,Date.parse(timestamp(height))/1000,10]) as T;
  }
  if(to===PCS_V2_FACTORY||to===PCS_V3_FACTORY){
    const method=to===PCS_V2_FACTORY?'getPair':'getPool',args=poolMarketAbi.decodeFunctionData(method,request.data);
    return poolMarketAbi.encodeFunctionResult(method,[to===PCS_V2_FACTORY&&[String(args[0]).toLowerCase(),String(args[1]).toLowerCase()].includes(WBNB)?pool:zero]) as T;
  }
  if(to===pool){
    const method=poolMarketAbi.getFunction(request.data.slice(0,10))!.name;
    if(method==='getReserves'&&pauseState){enteredState();await statePause;}
    const result=method==='factory'?[PCS_V2_FACTORY]:method==='token0'?[token]:method==='token1'?[WBNB]:method==='getReserves'?[1000n*10n**18n,quoteReserves,Date.parse(timestamp(height))/1000]:null;
    if(result)return poolMarketAbi.encodeFunctionResult(method,result) as T;
  }
  if(to===FOUR_HELPER)return fourInterface.encodeFunctionResult('getTokenInfo',[0,zero,zero,0,0,0,0,0,0,0,0,false]) as T;
  if(to===FLAP_PORTAL){const method=flapInterface.getFunction(request.data.slice(0,10))!.name;throw new Error(`not_a_flap_${method}`);}
  throw new Error('unsupported_test_contract');
};
try{
  await ensureNodeMarketSchema(db);await ensureNodeMarketSchema(db);
  await db.query('CREATE TABLE worker_state(key text PRIMARY KEY,value jsonb NOT NULL,updated_at timestamptz NOT NULL DEFAULT now())');
  const service=createNodeMarketService({db,rpc,now:()=>now});
  const discovered=await service.discover(token,{blockNumber:100,blockHash:hash(100),timestamp:timestamp(100),logs});
  assert.deepEqual(discovered,[`${pool}:${token}`]);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM node_markets')).rows[0].n,1,'factory-shaped impostors never become markets');
  feedAvailable=false;
  await service.collectRange(100,101);await service.decodePending();
  assert.equal((await db.query('SELECT count(*)::int AS n FROM node_market_raw_logs')).rows[0].n,4,'every participant log captured, not just a watched transaction');
  assert.equal((await db.query("SELECT count(*)::int AS n FROM node_market_raw_logs WHERE decode_status='missing_quote'")).rows[0].n,4,'valuation failure cannot lose raw evidence');
  assert.equal((await db.query('SELECT collected_through_block::text FROM node_markets')).rows[0].collected_through_block,'101');
  feedAvailable=true;await service.decodePending();
  assert.equal((await db.query("SELECT count(*)::int AS n FROM node_market_raw_logs WHERE decode_status='decoded'")).rows[0].n,4,'failed feed requests remain retriable');
  assert.equal((await db.query('SELECT count(*)::int AS n FROM node_market_candles')).rows[0].n,2);
  const quote=await service.quote(token);assert.equal(quote.priceUsd,'1');assert.equal(quote.marketCapUsd,'1000000');
  const at=await service.priceAt(token,{timestamp:timestamp(100),blockNumber:'100'});assert.equal(at.blockNumber,'100');assert.equal(at.priceUsd,'1');
  const chart=await service.chart(token,{from:timestamp(100),to:timestamp(101)});assert.equal(chart.complete,true);assert.equal(chart.bars.length,2);assert.equal(chart.bars[0].volumeUsd,'1000','Sync events never invent swap volume');
  await service.collectRange(102,102,{liveCheckpoint:true});
  assert.equal((await db.query("SELECT value->>'blockNumber' AS n FROM worker_state WHERE key='node_market_collection'")).rows[0].n,'102','live cursor commits with collected evidence');
  await service.tick({confirmedBlock:102,maxMarkets:1,retainedBlocks:102});
  assert.equal((await db.query('SELECT backfill_floor_block::text FROM node_markets')).rows[0].backfill_floor_block,'100','newest live coverage never skips the older retained-node backfill');
  const before=rpcCalls;await Promise.all([service.quote(token),service.priceAt(token,{timestamp:timestamp(100)}),service.chart(token,{from:timestamp(100),to:timestamp(101)})]);assert.equal(rpcCalls,before,'all request-path reads are database-only');
  await service.collectRange(100,101);await service.decodePending();assert.equal((await db.query('SELECT count(*)::int AS n FROM node_market_observations WHERE tx_hash IS NOT NULL')).rows[0].n,4,'duplicate scans are idempotent');
  quoteReserves=4n*10n**18n;supply=2_000_000n*10n**18n;
  now=Date.parse(timestamp(103));await service.refreshState(discovered[0],{blockNumber:103,blockHash:hash(103),timestamp:timestamp(103)});
  assert.equal((await service.quote(token)).priceUsd,'2','a confirmed pool-state change updates profit without a KOL transaction');
  assert.equal((await service.quote(token)).marketCapUsd,'4000000','supply is observed at its applicable block');
  assert.equal((await db.query('SELECT count(*)::int AS n FROM node_market_candles')).rows[0].n,2,'state refresh does not manufacture a candle or volume');
  const samples=await service.replaySamples(token,{from:timestamp(100),to:timestamp(103)});
  assert.equal(samples.truncated,false);assert.ok(samples.observations.some(row=>row.kind==='state'&&row.timestamp===timestamp(103)&&row.priceUsd==='2'),'Replay samples retain actual confirmed pool-state prices');
  assert.equal(samples.observations.find(row=>row.kind==='state'&&row.timestamp===timestamp(103))?.blockNumber,'103');
  assert.equal(samples.coverage.at(-1)?.to,timestamp(102),'A current state price never extends raw market collection coverage');
  assert.equal((await service.replaySamples(token,{from:timestamp(100),to:timestamp(103),limit:2})).truncated,true,'A bounded sample result discloses truncation');
  assert.equal((await db.query('SELECT count(*)::int AS n FROM node_market_candles')).rows[0].n,2,'A sampled replay read cannot invent OHLC or volume');
  await service.refreshState(discovered[0],{blockNumber:104,blockHash:hash(104),timestamp:timestamp(104)});
  const entered=new Promise<void>(resolve=>{enteredState=resolve;});statePause=new Promise<void>(resolve=>{releaseState=resolve;});pauseState=true;
  const delayed=service.refreshState(discovered[0],{blockNumber:104,blockHash:hash(104),timestamp:timestamp(104)});await entered;
  forkAt=104;
  const forkClient=await db.connect();try{await forkClient.query('BEGIN');await forkClient.query('SELECT pg_advisory_xact_lock(782319)');await service.rollback(forkClient,104);await forkClient.query('COMMIT');}finally{forkClient.release();}
  releaseState();await delayed;pauseState=false;
  assert.equal((await db.query("SELECT value->>'blockNumber' AS n FROM worker_state WHERE key='node_market_collection'")).rows[0].n,'102','a reorg above the live cursor preserves its earlier checkpoint');
  assert.equal((await db.query("SELECT count(*)::int AS n FROM node_market_observations WHERE block_number=104 AND block_hash=$1",[hash(104)])).rows[0].n,0,'in-flight pre-reorg RPC cannot recreate an orphan valuation after rollback');
  assert.equal((await db.query("SELECT count(*)::int AS n FROM node_market_feed_evidence WHERE block_number=104 AND block_hash=$1",[hash(104)])).rows[0].n,0,'in-flight pre-reorg RPC cannot recreate an orphan feed');
  forkAt=Infinity;
  now+=3600_000;const stale=await service.quote(token);assert.equal(stale.stale,true);assert.equal(stale.timestamp,timestamp(103),'cached reads never become fresh by access');
  wrongBlock=true;await assert.rejects(()=>service.collectRange(103,104),/market_block_mismatch/);wrongBlock=false;
  assert.equal((await db.query('SELECT collected_through_block::text FROM node_markets')).rows[0].collected_through_block,'102','a wrong block cannot advance coverage');
  logs[0].blockHash=hash(999);await assert.rejects(()=>service.collectRange(100,101),/market_log_block_mismatch/);logs[0].blockHash=hash(100);
  const client=await db.connect();try{await client.query('BEGIN');await service.rollback(client,101);await client.query('COMMIT');}finally{client.release();}
  assert.equal((await db.query("SELECT value->>'blockNumber' AS n FROM worker_state WHERE key='node_market_collection'")).rows[0].n,'100','orphan collection cursor rewinds atomically for canonical replacements');
  assert.equal((await db.query('SELECT count(*)::int AS n FROM node_market_observations')).rows[0].n,2,'orphan state and swap observations removed');
  assert.equal((await db.query('SELECT count(*)::int AS n FROM node_market_candles')).rows[0].n,1,'orphan candles rebuilt from surviving evidence');
  assert.equal((await service.chart(token,{from:timestamp(100),to:timestamp(101)})).complete,false,'reorg invalidates coverage');
  // A fresh process reprojects candles solely from durable observations; the
  // node can have pruned the original block by this point.
  await db.query("UPDATE node_market_observations SET candles_pending=true WHERE kind='swap'");await db.query('DELETE FROM node_market_candles');
  const offline=createNodeMarketService({db,rpc:async()=>{throw new Error('history_pruned');},now:()=>now});await offline.decodePending();
  assert.equal((await db.query('SELECT count(*)::int AS n FROM node_market_candles')).rows[0].n,1,'projection resumes after pruning without RPC');
  await service.importObservations({token,importId:'sanitized-April-October',from:'2026-04-15T00:00:00Z',to:'2026-10-16T00:00:00Z',complete:true,
    observations:[{timestamp:'2026-04-15T00:00:00Z',priceUsd:'0.1',intervalSeconds:86400,open:'0.08',high:'0.12',low:'0.07',close:'0.1',volumeUsd:'20'},
      {timestamp:'2026-10-16T00:00:00Z',priceUsd:'0.5',intervalSeconds:86400,volumeUsd:'30'}]});
  const long=await service.chart(token,{from:'2026-04-15T00:00:00Z',to:'2026-10-16T00:00:00Z',intervalSeconds:86400});
  assert.equal(long.bars.length,2);assert.equal(long.sparse,true);assert.equal(long.bars[0].timestamp,'2026-04-15T00:00:00.000Z');assert.equal(long.source,'imported');
  assert.equal((await db.query("SELECT count(*)::int AS n FROM node_market_observations WHERE source='imported' AND block_number IS NOT NULL")).rows[0].n,0,'imports never invent block positions');
  await assert.rejects(()=>service.importObservations({token,importId:'bad',from:timestamp(100),to:timestamp(101),complete:true,observations:[{timestamp:timestamp(100),priceUsd:'1',open:'5',high:'2',low:'1',close:'1'}]}),/invalid_imported_candle/);
  await db.query(`INSERT INTO node_markets(id,token_address,quote_address,protocol,contract_address,token0,token1,
    decimals0,decimals1,authenticated_at_block,authenticated_block_hash,authentication,status)
    SELECT 'waiting-background-market',$1,quote_address,protocol,$1,$1,token1,decimals0,decimals1,
      authenticated_at_block,authenticated_block_hash,authentication,'active' FROM node_markets WHERE id=$2`,[otherTrader,discovered[0]]);
  await db.query('UPDATE node_markets SET checked_at=$2 WHERE id=$1',[discovered[0],timestamp(104)]);
  const priorityTick=await service.tick({confirmedBlock:106,maxMarkets:1,retainedBlocks:106,priorityTokens:[token,otherTrader]});
  assert.equal(priorityTick.unavailableFeeds,2,'unrelated unavailable trusted feeds are counted without blocking required BNB pricing');
  assert.equal((await db.query('SELECT checked_at FROM node_markets WHERE id=$1',['waiting-background-market'])).rows[0].checked_at,null,'selected stale token dispatches before older background markets');
  await service.tick({confirmedBlock:106,maxMarkets:1,retainedBlocks:106,priorityTokens:[token,otherTrader]});
  assert.ok((await db.query('SELECT checked_at FROM node_markets WHERE id=$1',['waiting-background-market'])).rows[0].checked_at,'a recently refreshed selection yields priority so background markets rotate');
  await service.requestRefresh(token,{priority:10});await service.requestRefresh(token,{priority:1});
  assert.equal((await db.query('SELECT count(*)::int AS n FROM node_market_refresh_jobs WHERE token_address=$1',[token])).rows[0].n,1,'selected chart refreshes coalesce into a durable job');
  const priorCursor=(await db.query('SELECT backfill_next_block::text FROM node_markets WHERE id=$1',[discovered[0]])).rows[0].backfill_next_block;
  await db.query("UPDATE node_markets SET collection_gap=true,last_error='pruned_market_range' WHERE id=$1",[discovered[0]]);
  await service.tick({confirmedBlock:1000,maxMarkets:1,retainedBlocks:1000});
  assert.equal((await db.query('SELECT from_block::text FROM node_market_ranges WHERE market_id=$1 AND to_block=1000',[discovered[0]])).rows[0].from_block,'501','selected newly discovered market captures its recent missing page before old bulk history');
  assert.equal((await db.query('SELECT backfill_next_block::text FROM node_markets WHERE id=$1',[discovered[0]])).rows[0].backfill_next_block,priorCursor,'recent backfill never advances the independent older cursor past missing history');
  assert.equal((await db.query('SELECT collection_gap FROM node_markets WHERE id=$1',[discovered[0]])).rows[0].collection_gap,true,'old pruned coverage remains explicit while recent selected repairs progress');
  await service.tick({confirmedBlock:1000,maxMarkets:1,retainedBlocks:1000,priorityTokens:[token]});
  const resumed=(await db.query('SELECT from_block::text FROM node_market_ranges WHERE market_id=$1 AND to_block=500',[discovered[0]])).rows[0];
  assert.ok(resumed,JSON.stringify((await db.query('SELECT id,status,collection_gap,last_error,retry_at FROM node_markets')).rows));
  assert.equal(resumed.from_block,'100','selected backfill resumes backwards from completed coverage rather than refetching the same recent page');
  await db.query('DELETE FROM node_market_ranges WHERE market_id=$1 AND to_block=500',[discovered[0]]);
  await svcHistoryRequest();
  async function svcHistoryRequest(){
    const options={snapshotId:'snapshot-proof',windowId:'approved-window'};
    await service.requestHistoryWindow(token,timestamp(200),timestamp(202),options);
    await service.requestHistoryWindow(token,timestamp(200),timestamp(202),options);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM node_market_history_jobs')).rows[0].n,1,'Preparation polls join the same approved window');
    await assert.rejects(()=>service.requestHistoryWindow(token,timestamp(201),timestamp(202),options),/binding_mismatch/);
    const step=await service.tick({confirmedBlock:1000,maxMarkets:1,retainedBlocks:1000});assert.equal(step.repairedWindow,true,JSON.stringify((await db.query('SELECT last_error,next_block::text,end_block::text FROM node_market_history_jobs')).rows));
    const saved=(await db.query('SELECT next_block::text,end_block::text,completed_at,snapshot_id FROM node_market_history_jobs')).rows[0];
    assert.equal(saved.next_block,'204');assert.equal(saved.end_block,'203');assert.ok(saved.completed_at);assert.equal(saved.snapshot_id,'snapshot-proof');
    assert.equal((await db.query('SELECT count(*)::int AS n FROM node_market_ranges WHERE market_id=$1 AND from_block=199 AND to_block=203',[discovered[0]])).rows[0].n,1,'Small closed windows repair directly before generic historical pages');
  }
  const v3Pool='0x5555555555555555555555555555555555555555';
  await db.query(`INSERT INTO node_markets(id,token_address,quote_address,protocol,contract_address,token0,token1,decimals0,decimals1,
    authenticated_at_block,authenticated_block_hash,authentication,status) VALUES('pcs-nine-field',$1,$2,'pcs_v3',$3,$1,$2,18,18,100,$4,$5::jsonb,'active')`,
  [token,WBNB,v3Pool,hash(100),JSON.stringify({factory:PCS_V3_FACTORY})]);
  const realV3=v3MarketAbi.encodeEventLog(v3MarketAbi.getEvent('Swap')!,[otherTrader,otherTrader,-(10n**18n),10n**18n,1n<<96n,100n,0,1,2]);
  await db.query(`INSERT INTO node_market_raw_logs(market_id,block_number,block_hash,tx_hash,transaction_index,log_index,timestamp,log,decode_status,decoder_version)
    VALUES('pcs-nine-field',105,$1,$2,0,0,$3,$4::jsonb,'unsupported',1)`,[hash(105),hash(10005),timestamp(105),JSON.stringify({address:v3Pool,...realV3,blockNumber:'0x69',blockHash:hash(105),transactionHash:hash(10005),transactionIndex:'0x0',logIndex:'0x0'})]);
  await service.decodePending(300,{minimumBlock:105,allowCapturedOlder:true});
  const recoveredV3=(await db.query("SELECT decode_status,decoder_version FROM node_market_raw_logs WHERE market_id='pcs-nine-field'")).rows[0];
  assert.equal(recoveredV3.decode_status,'decoded');assert.equal(recoveredV3.decoder_version,2,'Retained real Pancake nine-field swaps recover after decoder upgrade');
  feedAvailable=false;
  await service.refreshState(discovered[0],{blockNumber:107,blockHash:hash(107),timestamp:timestamp(107)});
  const dated=(await db.query("SELECT quote_evidence FROM node_market_observations WHERE market_id=$1 AND block_number=107",[discovered[0]])).rows[0]?.quote_evidence;
  assert.equal(dated.block_number,'106');assert.equal(dated.timestamp,timestamp(106),'A retained earlier feed mark keeps its original block/time');
  assert.equal((await db.query('SELECT count(*)::int AS n FROM node_market_feed_evidence WHERE block_number=107')).rows[0].n,0,'Fallback never manufactures a newer oracle proof');
  await service.refreshState(discovered[0],{blockNumber:400,blockHash:hash(400),timestamp:timestamp(400)});
  assert.equal((await db.query('SELECT count(*)::int AS n FROM node_market_observations WHERE block_number=400')).rows[0].n,0,'Old or future oracle observations cannot fill an unobserved historical price');
  const rangesBefore=(await db.query('SELECT count(*)::int AS n FROM node_market_ranges')).rows[0].n;
  const deferred=await service.tick({confirmedBlock:1001,maxMarkets:1,retainedBlocks:1000,priorityTokens:[token],deferHistoricalBackfill:true});
  assert.equal(deferred.historicalBackfillDeferred,true);assert.equal((await db.query('SELECT count(*)::int AS n FROM node_market_ranges')).rows[0].n,rangesBefore,'Capture lag defers ordinary backfill instead of pretending it completed');
  const urgentFeeds=await service.captureFeedEvidence({blockNumber:1002,blockHash:hash(1002),timestamp:timestamp(1002)});
  assert.equal(urgentFeeds.captured,0,'A dated fallback cannot complete an urgent exact-block oracle capture job');
  feedAvailable=true;rpcHead=1008;now=Date.parse(timestamp(1002))+5000;
  const freshState=await service.tick({confirmedBlock:100,maxMarkets:1,retainedBlocks:1000,priorityTokens:[token],deferHistoricalBackfill:true,refreshStateHead:true});
  assert.equal(freshState.quoteBlock,1002,'Live state work reacquires its own confirmed head after a slow discovery batch');
  assert.equal((await service.quote(token)).blockNumber,'1002','An old collection/discovery input cannot make the resulting current mark stale');
  const marketLocker=await db.connect();
  let proofTimer:ReturnType<typeof setTimeout>|undefined,lockedMarketWrite:Promise<void>|undefined;
  const urgentCheckpoint={blockNumber:1003,blockHash:hash(1003),timestamp:timestamp(1003)};
  await marketLocker.query('BEGIN');await marketLocker.query('SELECT pg_advisory_xact_lock(908335)');
  const urgentProofs=Promise.all([service.captureMetadata([token],urgentCheckpoint),service.captureFeedEvidence(urgentCheckpoint)]);
  try{
    const proofs=await Promise.race([urgentProofs,new Promise<null>(resolve=>{proofTimer=setTimeout(()=>resolve(null),1000);})]);
    assert.ok(proofs,'Append-only token/feed proofs must not wait behind a market range transaction');
    assert.equal(proofs[0].captured,1);assert.equal(proofs[1].captured,1);
    lockedMarketWrite=service.refreshState(discovered[0],urgentCheckpoint);
    const marketFinished=await Promise.race([lockedMarketWrite.then(()=>true),new Promise<boolean>(resolve=>setTimeout(()=>resolve(false),1000))]);
    assert.equal(marketFinished,true,'Append-only observations use the reorg guard without waiting behind unrelated market-range projection locks');
  }finally{
    if(proofTimer)clearTimeout(proofTimer);await marketLocker.query('ROLLBACK');marketLocker.release();
    await Promise.allSettled([urgentProofs,...(lockedMarketWrite?[lockedMarketWrite]:[])]);
  }
  await db.query(`CREATE TABLE node_evidence_blocks(block_number bigint PRIMARY KEY,block_hash text UNIQUE NOT NULL,parent_hash text NOT NULL,timestamp timestamptz NOT NULL);
    CREATE TABLE tokens(address text PRIMARY KEY,symbol text,name text)`);
  await db.query('INSERT INTO node_evidence_blocks VALUES(90,$1,$2,$3)',[hash(90),hash(89),timestamp(90)]);
  const oldRaw={address:v3Pool,...realV3,blockNumber:'0x5a',blockHash:hash(90),transactionHash:hash(10090),transactionIndex:'0x0',logIndex:'0x0'};
  await db.query(`INSERT INTO node_market_raw_logs(market_id,block_number,block_hash,tx_hash,transaction_index,log_index,timestamp,log,decode_status)
    VALUES('pcs-nine-field',90,$1,$2,0,0,$3,$4::jsonb,'pending')`,[hash(90),hash(10090),timestamp(90),JSON.stringify(oldRaw)]);
  const beforeDeferredRpc=rpcCalls,deferredRaw=await service.decodePending(4,{minimumBlock:1000,allowCapturedOlder:true,maxDurationMs:1500});
  assert.equal(deferredRaw.examined,0);assert.equal(rpcCalls,beforeDeferredRpc,'Pruned old rows without captured precision cannot stall current valuation with repeated RPC');
  assert.equal((await db.query("SELECT decode_status FROM node_market_raw_logs WHERE tx_hash=$1",[hash(10090)])).rows[0].decode_status,'pending','Deferral preserves all raw evidence and does not mark unfinished decoding complete');
  await service.captureMetadata([token,WBNB],{blockNumber:90,blockHash:hash(90),timestamp:timestamp(90)});
  const noQuoteRpc=rpcCalls,missingOldQuote=await service.decodePending(4,{minimumBlock:1000,allowCapturedOlder:true,maxDurationMs:1500});
  assert.equal(missingOldQuote.decoded,0);assert.equal(rpcCalls,noQuoteRpc,'Captured precision without a dated quote must not trigger pruned feed or route RPC in the hot decoder');
  assert.equal((await db.query("SELECT decode_status FROM node_market_raw_logs WHERE tx_hash=$1",[hash(10090)])).rows[0].decode_status,'missing_quote');
  const oldRetry={...oldRaw,blockNumber:hex(1),blockHash:hash(1),transactionHash:hash(8001)};
  await db.query(`INSERT INTO node_market_raw_logs(market_id,block_number,block_hash,tx_hash,transaction_index,log_index,timestamp,log,decode_status)
    VALUES('pcs-nine-field',1,$1,$2,0,0,$3,$4::jsonb,'missing_quote')`,[hash(1),hash(8001),timestamp(1),JSON.stringify(oldRetry)]);
  await db.query(`UPDATE worker_state SET value=jsonb_set(value,'{missing_quote}',$1::jsonb) WHERE key='node_market_decode_recovery'`,
    [JSON.stringify({block:'50',transactionIndex:0,logIndex:0,market:'pcs-nine-field',transaction:hash(8050),hash:hash(50)})]);
  await service.captureFeedEvidence({blockNumber:90,blockHash:hash(90),timestamp:timestamp(90)});
  const capturedOldRpc=rpcCalls;
  const capturedOld=await service.decodePending(4,{minimumBlock:1000,allowCapturedOlder:true,maxDurationMs:1500});assert.equal(capturedOld.decoded,1,'Older raw work remains resumable once genuine precision proofs exist');
  assert.equal(rpcCalls,capturedOldRpc,'Captured old market work decodes entirely from canonical database evidence');
  assert.equal((await db.query("SELECT decode_status FROM node_market_raw_logs WHERE tx_hash=$1",[hash(10090)])).rows[0].decode_status,'decoded',
    'A newly captured quote retries recent failed decoding immediately even after the legacy cursor passed its height');
  await db.query('DELETE FROM node_market_raw_logs WHERE tx_hash=$1',[hash(8001)]);
  await db.query("UPDATE node_market_raw_logs SET decode_status='missing_quote' WHERE tx_hash=$1",[hash(10090)]);
  await service.requestHistoryWindow(token,timestamp(90),timestamp(90),{windowId:'selected-old-quote-retry',priority:10});
  assert.equal((await service.decodePending(1,{minimumBlock:3000,allowCapturedOlder:true,databaseOnly:true})).decoded,1,
    'A selected replay retries old missing-quote work outside the recent lane before the ordinary legacy sweep');
  assert.equal(rpcCalls,capturedOldRpc);
  const recoveryTransactions:string[]=[];
  for(let index=0;index<51;index++){
    const height=index===50?90:99,transactionHash=hash(90000+index);recoveryTransactions.push(transactionHash);
    const row={...oldRaw,blockNumber:hex(height),blockHash:hash(height),transactionHash,logIndex:hex(index)};
    await db.query(`INSERT INTO node_market_raw_logs(market_id,block_number,block_hash,tx_hash,transaction_index,log_index,timestamp,log,decode_status)
      VALUES('pcs-nine-field',$1,$2,$3,0,$4,$5,$6::jsonb,'pending')`,[height,hash(height),transactionHash,index,timestamp(height),JSON.stringify(row)]);
  }
  let boundedCohorts=0;
  const boundedDatabase={connect:db.connect.bind(db),query:(async(...args:any[])=>{
    const cohort=typeof args[0]==='string'&&args[0].includes('SELECT market_id,block_hash,tx_hash,log_index,block_number::text,transaction_index');
    if(cohort){boundedCohorts++;assert.ok(args[1][2]<=2);assert.ok(!args[0].includes('JOIN'),'Proof/eligibility joins cannot run before the raw cohort limit');}
    const result=await(db.query as any)(...args);if(cohort)assert.ok(result.rows.length<=2);return result;
  })as typeof db.query};
  const recoveryRpc=rpcCalls;
  for(let round=0;round<30;round++){
    // Each instance reads the durable cursor, as a replacement worker would.
    await createNodeMarketService({db:boundedDatabase,rpc,now:()=>now}).decodePending(6,{minimumBlock:1000,allowCapturedOlder:true,databaseOnly:true,maxDurationMs:1500});
    if((await db.query('SELECT decode_status FROM node_market_raw_logs WHERE tx_hash=$1',[recoveryTransactions.at(-1)])).rows[0].decode_status==='decoded')break;
  }
  assert.ok(boundedCohorts>3);assert.equal(rpcCalls,recoveryRpc);
  assert.equal((await db.query('SELECT decode_status FROM node_market_raw_logs WHERE tx_hash=$1',[recoveryTransactions.at(-1)])).rows[0].decode_status,'decoded',
    'Bounded recovery resumes across restarts and progresses past many newer rows without usable historical precision');
  await db.query('DELETE FROM node_market_raw_logs WHERE tx_hash=ANY($1::text[])',[recoveryTransactions]);
  await ensureNodeEvidenceMetadataSchema(db);
  await db.query('INSERT INTO node_evidence_blocks VALUES(108,$1,$2,$3)',[hash(108),hash(107),timestamp(108)]);
  await db.query('INSERT INTO tokens VALUES($1,\'TEST\',\'A supported token\')',[token]);
  const burstEvent=poolMarketAbi.encodeEventLog(poolMarketAbi.getEvent('Swap')!,[otherTrader,0,2n*10n**18n,1000n*10n**18n,0,otherTrader]);
  const burst:NodeMarketLog[]=Array.from({length:501},(_,index)=>({address:pool,...burstEvent,blockNumber:'0x6c',blockHash:hash(108),
    transactionHash:hash(20000+index),transactionIndex:'0x0',logIndex:hex(index)}));
  logs.push(...burst);
  const cursorBefore=(await db.query("SELECT value FROM worker_state WHERE key='node_market_collection'")).rows[0].value;
  await db.query(`CREATE FUNCTION fail_market_batch_fixture() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'fixture_batch_failure';END$$;
    CREATE TRIGGER fail_market_batch_fixture BEFORE UPDATE ON node_markets FOR EACH ROW EXECUTE FUNCTION fail_market_batch_fixture()`);
  await assert.rejects(()=>service.collectRange(108,108,{marketIds:[discovered[0]],liveCheckpoint:true}),/fixture_batch_failure/);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM node_market_raw_logs WHERE block_number=108')).rows[0].n,0,'Failure after multiple raw batches rolls back every inserted event');
  assert.equal((await db.query('SELECT count(*)::int AS n FROM node_market_ranges WHERE from_block=108 AND to_block=108')).rows[0].n,0,'Failure cannot commit a completed range');
  assert.equal((await db.query('SELECT count(*)::int AS n FROM node_evidence_metadata_jobs')).rows[0].n,0,'Failed ranges cannot leave urgent financial jobs behind');
  assert.deepEqual((await db.query("SELECT value FROM worker_state WHERE key='node_market_collection'")).rows[0].value,cursorBefore,'Failed batch cannot advance the live checkpoint');
  await db.query('DROP TRIGGER fail_market_batch_fixture ON node_markets;DROP FUNCTION fail_market_batch_fixture()');
  await service.collectRange(108,108,{marketIds:[discovered[0]],liveCheckpoint:true});await service.collectRange(108,108,{marketIds:[discovered[0]]});
  const metadataDependencies=(await db.query('SELECT tokens FROM node_evidence_metadata_jobs WHERE block_hash=$1',[hash(108)])).rows[0].tokens;
  assert.ok(metadataDependencies.includes(token)&&metadataDependencies.includes(WBNB),'Other participants’ swaps queue both authenticated assets, including quote precision excluded from public token lists');
  assert.equal((await db.query('SELECT count(*)::int AS n FROM node_market_raw_logs WHERE block_number=108')).rows[0].n,501,'Committed batches preserve every execution identity and duplicate scans remain idempotent');
  const marketProofJob=(await db.query('SELECT block_number::text,tokens,observed_live FROM node_evidence_metadata_jobs')).rows;
  assert.deepEqual(marketProofJob,[{block_number:'108',tokens:[token,WBNB],observed_live:true}],'All-participant market swaps coalesce both financial assets into one exact-block urgent capture job');
  const shortTo=new Date(Date.parse(timestamp(108))+40_000).toISOString();
  await db.query("UPDATE node_market_raw_logs SET decode_status='missing_quote' WHERE block_number=108");
  logs.push({address:pool,...burstEvent,blockNumber:'0x6d',blockHash:hash(109),transactionHash:hash(30109),transactionIndex:'0x0',logIndex:'0x0'});
  await service.collectRange(109,109,{marketIds:[discovered[0]]});
  await service.requestHistoryWindow(token,timestamp(108),shortTo,{windowId:'selected-decode-priority',priority:10});
  const capturedHeaderReads=headerRpcCalls;
  const prioritized=await service.decodePending(1);
  assert.equal(headerRpcCalls,capturedHeaderReads,'Matching permanently captured headers authorize writes without a per-log header RPC');
  assert.equal(prioritized.examined,1);assert.equal(prioritized.decoded,1,'Selected replay retries keep the existing one-row decode budget');
  assert.equal((await db.query("SELECT count(*)::int AS n FROM node_market_raw_logs WHERE block_number=108 AND decode_status='decoded'")).rows[0].n,1,'A selected replay retry dispatches before a newer unrelated pending row');
  assert.equal((await db.query('SELECT decode_status FROM node_market_raw_logs WHERE block_number=109')).rows[0].decode_status,'pending');
  await service.refreshState(discovered[0],{blockNumber:108,blockHash:hash(109),timestamp:timestamp(108)});
  assert.equal((await db.query('SELECT count(*)::int n FROM node_market_observations WHERE block_number=108 AND block_hash=$1',[hash(109)])).rows[0].n,0,'A captured contradictory hash rejects the write instead of falling back to RPC');
  const absentHeaderReads=headerRpcCalls;
  await service.refreshState(discovered[0],{blockNumber:109,blockHash:hash(109),timestamp:timestamp(109)});
  assert.ok(headerRpcCalls>absentHeaderReads,'A backfill without a permanent header retains its genuine RPC canonical guard');
  await db.query("UPDATE node_market_raw_logs SET decode_status='missing_quote' WHERE block_number=108");
  assert.ok((await db.query("SELECT count(*)::int n FROM node_market_raw_logs WHERE block_number=108 AND decode_status='missing_quote'")).rows[0].n>=300);
  const fair=await service.decodePending(300,{minimumBlock:109,allowCapturedOlder:true,maxDurationMs:100});
  assert.ok(fair.decoded>=1);
  assert.equal((await db.query('SELECT decode_status FROM node_market_raw_logs WHERE block_number=109')).rows[0].decode_status,'decoded','Fresh pending swaps cannot starve behind hundreds of selected old missing-quote retries');
  await db.query("UPDATE node_market_raw_logs SET decode_status='pending' WHERE block_number=109");
  await db.query("UPDATE node_market_raw_logs SET decode_status='pending' WHERE block_number=108");
  await db.query(`INSERT INTO node_market_raw_logs(market_id,block_number,block_hash,tx_hash,transaction_index,log_index,timestamp,log,decode_status)
    SELECT market_id,block_number,block_hash,'0x'||lpad(to_hex(41000+n),64,'0'),n+1,log_index,timestamp,
      jsonb_set(jsonb_set(log,'{transactionHash}',to_jsonb('0x'||lpad(to_hex(41000+n),64,'0'))),'{transactionIndex}',to_jsonb('0x'||to_hex(n+1))),'pending'
      FROM node_market_raw_logs CROSS JOIN generate_series(0,11)n WHERE block_number=109`);
  for(let round=0;round<3;round++){
    const shared=await service.decodePending(3,{minimumBlock:109,allowCapturedOlder:true,maxDurationMs:1000});
    assert.equal(shared.examined,3);
    assert.ok((await db.query("SELECT count(*)::int n FROM node_market_raw_logs WHERE block_number=109 AND decode_status='decoded'")).rows[0].n>=Math.floor((round+1)*3/4),'Recent trades retain their share across bounded cycles despite a huge selected historical backlog');
    assert.ok((await db.query("SELECT count(*)::int n FROM node_market_raw_logs WHERE block_number=108 AND decode_status='decoded'")).rows[0].n>=Math.floor((round+1)*3/2),'Selected history keeps its weighted share while fresh and recovery queues remain active');
  }
  await db.query("UPDATE node_market_history_jobs SET expires_at=now()-interval '1 second'");
  const freshBeforeSpare=(await db.query("SELECT count(*)::int n FROM node_market_raw_logs WHERE block_number=109 AND decode_status='decoded'")).rows[0].n;
  const historicalBeforeSpare=(await db.query("SELECT count(*)::int n FROM node_market_raw_logs WHERE block_number=108 AND decode_status='decoded'")).rows[0].n;
  const spare=await service.decodePending(3,{minimumBlock:109,allowCapturedOlder:true,maxDurationMs:1000});assert.equal(spare.examined,3);
  assert.ok((await db.query("SELECT count(*)::int n FROM node_market_raw_logs WHERE block_number=109 AND decode_status='decoded'")).rows[0].n>freshBeforeSpare,'Expired selected windows lend their slots to current work');
  assert.ok((await db.query("SELECT count(*)::int n FROM node_market_raw_logs WHERE block_number=108 AND decode_status='decoded'")).rows[0].n>historicalBeforeSpare,'Ordinary captured recovery still progresses after the selected window expires');
  await db.query("DELETE FROM node_market_raw_logs WHERE block_number=109 AND transaction_index>0");
  await db.query("UPDATE node_market_raw_logs SET decode_status='pending' WHERE block_number=109");
  await service.requestHistoryWindow(token,timestamp(108),timestamp(109),{windowId:'chronological-selected-window',priority:10});
  await db.query("UPDATE node_market_raw_logs SET decode_status='pending' WHERE block_number=108");
  let selectionEntered:()=>void=()=>{};const selectionReady=new Promise<void>(resolve=>{selectionEntered=resolve;});
  const delayedDatabase={connect:db.connect.bind(db),query:(async(...args:any[])=>{
    if(typeof args[0]==='string'&&args[0].includes('AS raw_log')){selectionEntered();await new Promise(resolve=>setTimeout(resolve,150));}
    return (db.query as any)(...args);
  })as typeof db.query};
  const delayedService=createNodeMarketService({db:delayedDatabase,rpc,now:()=>now});
  const inProgress=delayedService.decodePending(2,{maxDurationMs:100});await selectionReady;
  assert.deepEqual(await service.decodePending(2),{examined:0,decoded:0,coalesced:true},'Independent service instances join the same session lease instead of duplicating decode RPC/work');
  const progressed=await inProgress;
  assert.equal(progressed.examined,2,'A slow SELECT cannot consume the bounded decode-work budget before it starts');
  assert.equal((await db.query("SELECT count(*)::int AS n FROM node_market_raw_logs WHERE block_number=108 AND decode_status='decoded'")).rows[0].n,2,'Selected windows establish their earliest genuine prices before newer rows');
  assert.equal((await db.query('SELECT decode_status FROM node_market_raw_logs WHERE block_number=109')).rows[0].decode_status,'pending');
  const skipTick=await service.tick({confirmedBlock:109,maxMarkets:1,deferHistoricalBackfill:true,skipDecoding:true});
  assert.equal(skipTick.examined,0);assert.equal(skipTick.decoded,0);
  assert.equal((await db.query('SELECT decode_status FROM node_market_raw_logs WHERE block_number=109')).rows[0].decode_status,'pending','Independent quote ticks can yield all raw decoding to its dedicated stage');
  await service.importObservations({token,importId:'completed-intraminute-history',from:timestamp(108),to:timestamp(109),complete:true,
    observations:[{timestamp:timestamp(108),priceUsd:'3',open:'2',high:'4',low:'1',close:'3',intervalSeconds:60,volumeUsd:'100',supply:'1000000'}]});
  const importedPending=await service.chart(token,{from:timestamp(108),to:shortTo,intervalSeconds:60});
  assert.equal(importedPending.complete,true,'Complete imported coverage is usable while independent node raw logs remain pending');
  assert.equal(importedPending.bars.length,1);assert.equal(importedPending.bars[0].open,'2');assert.equal(importedPending.source,'imported','An incomplete node minute cannot replace the complete imported candle');
  await db.query("UPDATE node_market_import_ranges SET complete=false WHERE import_id='completed-intraminute-history'");
  assert.equal((await service.chart(token,{from:timestamp(108),to:shortTo,intervalSeconds:60})).complete,false,'Partial imported history cannot authorize pending node coverage');
  const stateOnly=poolMarketAbi.encodeEventLog(poolMarketAbi.getEvent('Sync')!,[1000n*10n**18n,2n*10n**18n]);
  const stateCheckpoint={blockNumber:110,blockHash:hash(110),timestamp:timestamp(110)};
  await db.query('INSERT INTO node_evidence_blocks VALUES(110,$1,$2,$3)',[hash(110),hash(109),timestamp(110)]);
  logs.push({address:pool,...stateOnly,blockNumber:hex(110),blockHash:hash(110),transactionHash:hash(50110),transactionIndex:'0x0',logIndex:'0x0'});
  await service.collectRange(110,110,{marketIds:[discovered[0]]});
  assert.deepEqual((await db.query('SELECT tokens FROM node_evidence_metadata_jobs WHERE block_hash=$1',[hash(110)])).rows[0].tokens,[token,WBNB],
    'A genuine Sync-only pool update queues both exact precision dependencies even without a Swap event');
  await service.captureMetadata([token,WBNB],stateCheckpoint);await service.captureFeedEvidence(stateCheckpoint,[token]);
  assert.equal((await service.decodePending(1,{minimumBlock:110,databaseOnly:true})).decoded,1);
  const stateObservation=(await db.query('SELECT kind,volume_usd FROM node_market_observations WHERE tx_hash=$1',[hash(50110)])).rows[0];
  assert.equal(stateObservation.kind,'state');assert.equal(stateObservation.volume_usd,null);
  assert.equal((await db.query('SELECT count(*)::int n FROM node_market_candles WHERE minute=$1',[timestamp(110)])).rows[0].n,0,
    'A captured liquidity-state valuation does not manufacture a swap candle or trading volume');
  const excluded='0x000ae314e2a2172a039b26378814c252734f556a',excludedMarket='retained-excluded-market';
  await db.query('INSERT INTO tokens VALUES($1,\'ASTER\',\'User-excluded asset\')',[excluded]);
  await db.query(`INSERT INTO node_markets(id,token_address,quote_address,protocol,contract_address,token0,token1,decimals0,decimals1,
    authenticated_at_block,authenticated_block_hash,authentication,status) VALUES($1,$2,$3,'pcs_v2',$4,$2,$3,18,18,100,$5,$6::jsonb,'active')`,
  [excludedMarket,excluded,WBNB,pool,hash(100),JSON.stringify({factory:PCS_V2_FACTORY})]);
  const excludedBefore=rpcCalls;
  assert.deepEqual(await service.discover(excluded,{blockNumber:110,blockHash:hash(110),timestamp:timestamp(110)}),[]);
  assert.deepEqual(await service.collectRange(110,110,{marketIds:[excludedMarket]}),{markets:0,logs:0});
  assert.equal(rpcCalls,excludedBefore,'Excluded target assets trigger neither discovery nor normal collection RPC');
  await db.query(`INSERT INTO node_market_raw_logs(market_id,block_number,block_hash,tx_hash,transaction_index,log_index,timestamp,log,decode_status)
    VALUES($1,110,$2,$3,0,0,$4,$5::jsonb,'pending')`,[excludedMarket,hash(110),hash(30110),timestamp(110),JSON.stringify({...burst[0],blockNumber:'0x6e',blockHash:hash(110),transactionHash:hash(30110)})]);
  const excludedDecode=await service.decodePending(1,{minimumBlock:110});assert.equal(excludedDecode.examined,0);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM node_market_raw_logs WHERE market_id=$1',[excludedMarket])).rows[0].n,1,'Scheduling exclusions preserve old raw evidence');
  await db.query("UPDATE node_markets SET status='unsupported' WHERE id<>$1",[excludedMarket]);
  await service.tick({confirmedBlock:110,maxMarkets:1,priorityTokens:[excluded],deferHistoricalBackfill:true});
  assert.equal((await db.query('SELECT checked_at FROM node_markets WHERE id=$1',[excludedMarket])).rows[0].checked_at,null,'Even foreground priority cannot schedule a user-excluded target state refresh');
  const controllerTargets=Array.from({length:700},(_,index)=>`0x${(100000+index).toString(16).padStart(40,'0')}`);
  await db.query(`INSERT INTO node_markets(id,token_address,quote_address,protocol,contract_address,token0,token1,decimals0,decimals1,
    authenticated_at_block,authenticated_block_hash,authentication,status)
    SELECT $1||':'||v.token,v.token,$2,'flap',$1,v.token,$2,18,18,100,$3,$4::jsonb,'active' FROM unnest($5::text[]) v(token)`,
  [FLAP_PORTAL,WBNB,hash(100),JSON.stringify({controller:FLAP_PORTAL,method:'getTokenV8Safe'}),controllerTargets]);
  const scaleLogs=Array.from({length:2354},(_,index)=>{
    const target=controllerTargets[index%700],height=111+index%500;
    const body=index%7===0?{topics:[`0x${'f'.repeat(64)}`],data:`0x${target.slice(2).padStart(64,'0')}`}
      :flapMarketAbi.encodeEventLog(flapMarketAbi.getEvent('TokenBought')!,[1,target,otherTrader,10n**18n,10n**12n,0,10n**12n]);
    return {address:FLAP_PORTAL,...body,blockNumber:hex(height),blockHash:hash(height),transactionHash:hash(1000000+index),transactionIndex:'0x0',logIndex:hex(index)};
  });
  logs.push(...scaleLogs);
  let yielded=false;const eventLoopTick=new Promise<void>(resolve=>setImmediate(()=>{yielded=true;resolve();}));
  const scale=await service.collectRange(111,610,{marketIds:controllerTargets.map(target=>`${FLAP_PORTAL}:${target}`)});
  await eventLoopTick;assert.equal(yielded,true,'A large controller page yields to other worker loops');
  assert.equal(scale.markets,700);assert.equal(scale.decodeCandidates,2354,'Decoder work is linear in actual token matches instead of700times every controller log');
  assert.equal((await db.query('SELECT count(*)::int AS n FROM node_market_raw_logs WHERE block_number BETWEEN 111 AND 610')).rows[0].n,2354,'Unknown controller event versions remain durable raw evidence');
  console.log('Node market integration passed: authentic discovery, all-participant swaps, durable raw capture, retriable feed gaps, exact decimals, no request RPC, idempotency, quote-only state refresh, supply, wrong blocks, reorgs, pruning recovery and sparse daily history.');
}finally{await db.end();}
