import assert from'node:assert/strict';
import pg from'pg';
import{createNodeMarketService,ensureNodeMarketSchema}from'./nodeMarket.js';
import{erc20MarketAbi,oracleMarketAbi,poolMarketAbi,TRUSTED_QUOTE_FEEDS,flapMarketAbi}from'./nodeMarketProtocols.js';
import{WBNB,PCS_V2_FACTORY,PCS_V3_FACTORY,FOUR_HELPER,FLAP_PORTAL,fourInterface,flapInterface}from'./launchpad.js';
import type{Rpc}from'./rpc.js';
const url=new URL(process.env.DATABASE_URL||'');
if(!['127.0.0.1','localhost'].includes(url.hostname)||url.port!=='5435'||!/^\/bscan_node_market_conversion_test_\d+$/.test(url.pathname))throw Error('Disposable local conversion database required');
const db=new pg.Pool({connectionString:url.href});
const token='0x1111111111111111111111111111111111111111',quote='0x2222222222222222222222222222222222222222',pool='0x3333333333333333333333333333333333333333',trader='0x4444444444444444444444444444444444444444',zero='0x0000000000000000000000000000000000000000';
const hash=(n:number)=>`0x${n.toString(16).padStart(64,'0')}`,at=(n:number)=>new Date(Date.now()-60000+(n-100)*1000).toISOString();
let imposter=false,noLiquidity=false,noRoute=false,prunedRoute=false,rpcCalls=0,factoryCalls=0,baseReserves=2000n*10n**18n;
const timestamps=new Map<number,string>();const timestamp=(n:number)=>{if(!timestamps.has(n))timestamps.set(n,at(n));return timestamps.get(n)!;};
const swap=flapMarketAbi.encodeEventLog(flapMarketAbi.getEvent('TokenBought')!,[1,token,trader,10n*10n**18n,20n*10n**6n,0,2n*10n**18n]);
const rpc:Rpc=async<T>(method:string,args:unknown[]):Promise<T>=>{
  rpcCalls++;
  if(method==='eth_getBlockByNumber'){const n=Number(BigInt(String(args[0])));return{number:'0x'+n.toString(16),hash:hash(n),parentHash:hash(n-1),timestamp:'0x'+Math.floor(Date.parse(timestamp(n))/1000).toString(16)}as T;}
  if(method==='eth_getLogs')return[{address:FLAP_PORTAL,...swap,blockNumber:'0x64',blockHash:hash(100),transactionHash:hash(1000),transactionIndex:'0x0',logIndex:'0x0'}]as T;
  if(method!=='eth_call')throw Error('unexpected_rpc');
  const req=args[0]as{to:string;data:string},tag=args[1]as{blockHash:string;requireCanonical:boolean};assert.equal(tag.requireCanonical,true);
  const n=Number(BigInt(tag.blockHash)),to=req.to.toLowerCase();
  if([token,quote,WBNB].includes(to)){const f=erc20MarketAbi.getFunction(req.data.slice(0,10))!.name;
    if(f==='decimals')return erc20MarketAbi.encodeFunctionResult(f,[to===quote?6:18])as T;
    if(f==='totalSupply')return erc20MarketAbi.encodeFunctionResult(f,[1_000_000n*10n**BigInt(to===quote?6:18)])as T;}
  if(to===TRUSTED_QUOTE_FEEDS[WBNB].feed){const f=oracleMarketAbi.getFunction(req.data.slice(0,10))!.name;return oracleMarketAbi.encodeFunctionResult(f,f==='decimals'?[8]:f==='description'?['BNB / USD']:[1,500n*10n**8n,Math.floor(Date.parse(timestamp(n))/1000),Math.floor(Date.parse(timestamp(n))/1000),1])as T;}
  if(to===PCS_V2_FACTORY||to===PCS_V3_FACTORY){const f=to===PCS_V2_FACTORY?'getPair':'getPool',a=poolMarketAbi.decodeFunctionData(f,req.data);
    if(prunedRoute)throw Error('historical_state_pruned');
    factoryCalls++;
    return poolMarketAbi.encodeFunctionResult(f,[!noRoute&&to===PCS_V2_FACTORY&&[String(a[0]).toLowerCase(),String(a[1]).toLowerCase()].includes(quote)&&[String(a[0]).toLowerCase(),String(a[1]).toLowerCase()].includes(WBNB)?pool:zero])as T;}
  if(to===pool){const f=poolMarketAbi.getFunction(req.data.slice(0,10))!.name;const r=f==='factory'?[imposter?zero:PCS_V2_FACTORY]:f==='token0'?[quote]:f==='token1'?[WBNB]:[noLiquidity?0n:1_000_000n*10n**6n,baseReserves,0];return poolMarketAbi.encodeFunctionResult(f,r)as T;}
  if(to===FOUR_HELPER)return fourInterface.encodeFunctionResult('getTokenInfo',[0,zero,zero,0,0,0,0,0,0,0,0,false])as T;
  if(to===FLAP_PORTAL){const f=flapInterface.getFunction(req.data.slice(0,10))!.name;return flapInterface.encodeFunctionResult(f,[[1,1,1,2n*10n**18n,4,0,0,0,0,quote,false,hash(0),0,...(f==='getTokenV8Safe'?[0]:[]),zero,0,0,0]])as T;}
  throw Error('unavailable_test_contract');
};
const batchSizes:number[]=[];
rpc.batch=async requests=>{batchSizes.push(requests.length);return Promise.allSettled(requests.map(request=>rpc(request.method,request.params)));};
try{
  await ensureNodeMarketSchema(db);const svc=createNodeMarketService({db,rpc});
  const checkpoint=(n:number)=>({blockNumber:n,blockHash:hash(n),timestamp:new Date(Math.floor(Date.parse(timestamp(n))/1000)*1000).toISOString()});
  const partial=await svc.captureMetadata([token,'0x9999999999999999999999999999999999999999'],checkpoint(100));
  assert.deepEqual(partial,{requested:2,captured:1,capturedTokens:[token]},'Urgent capture can complete valid token proofs independently of unknown metadata');
  const ids=await svc.discover(token,checkpoint(100));assert.equal(ids.length,1,'Authenticated Flap registry accepts an encountered non-feed quote');
  const urgentQuote=await svc.captureFeedEvidence(checkpoint(104),[token]);
  assert.equal(urgentQuote.quoteRequested,1);assert.equal(urgentQuote.quoteCaptured,1);assert.deepEqual(urgentQuote.capturedQuoteTokens,[quote]);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM node_market_quote_evidence WHERE quote_address=$1 AND block_number=104',[quote])).rows[0].n,1,'Urgent token work preserves its authenticated converted quote at the same block before state pruning');
  assert.equal((await db.query('SELECT decimals FROM node_market_token_evidence WHERE token_address=$1 AND block_number=104',[quote])).rows[0].decimals,6,'Quote precision is captured independently of the target token');
  const dependencyQuote=await svc.captureFeedEvidence(checkpoint(104),[quote]);
  assert.equal(dependencyQuote.quoteRequested,1);assert.equal(dependencyQuote.quoteCaptured,1);assert.deepEqual(dependencyQuote.unresolvedTokens,[],
    'A genuine quote-only dependency needs its authenticated conversion proof, not a second target-token market');
  const bothAssets=await svc.captureFeedEvidence(checkpoint(104),[token,quote]);
  assert.equal(bothAssets.quoteRequested,1);assert.equal(bothAssets.quoteCaptured,1);assert.deepEqual(bothAssets.unresolvedTokens,[],
    'Target and quote precision in one job share the same exact conversion dependency');
  const beforeFastFactories=factoryCalls;
  const trustedOnly=await svc.captureFeedEvidence(checkpoint(150),[token,quote],{conversions:false});
  assert.equal(trustedOnly.quoteRequested,0);assert.equal(factoryCalls,beforeFastFactories,'The urgent pinned-feed lane never waits for pool-route discovery');
  assert.equal((await db.query('SELECT count(*)::int n FROM node_market_feed_evidence WHERE quote_address=$1 AND block_number=150',[WBNB])).rows[0].n,1,
    'Exact native-fee valuation evidence is captured independently of converted token quotes');
  assert.equal((await db.query('SELECT count(*)::int n FROM node_market_quote_evidence WHERE block_number=150')).rows[0].n,0,'The fast path does not fabricate completed quote routes');
  const unknownTarget='0x9999999999999999999999999999999999999999',unknownFeed=await svc.captureFeedEvidence(checkpoint(104),[unknownTarget]);
  assert.deepEqual(unknownFeed.unresolvedTokens,[unknownTarget]);assert.ok(unknownFeed.captured<unknownFeed.requested,'Pre-discovery jobs cannot prematurely complete without their quote dependencies');
  await svc.refreshState(ids[0],checkpoint(100));assert.equal((await svc.quote(token)).priceUsd,'2','Six-decimal quote conversion and eighteen-decimal Flap price remain separate');
  const proof=(await db.query('SELECT price_usd::text,evidence,depth_usd::text FROM node_market_quote_evidence')).rows[0];
  assert.equal(proof.price_usd,'1');assert.equal(proof.evidence.decimals0,6);assert.equal(proof.evidence.basePriceUsd,'500');assert.equal(proof.evidence.state.reserve0,'1000000000000');
  const before=rpcCalls;assert.equal((await svc.priceAt(quote,{timestamp:checkpoint(100).timestamp})).priceUsd,'1');assert.equal(rpcCalls,before,'Conversion reads are database-only');
  baseReserves*=2n;const knownFactories=factoryCalls;
  await svc.captureFeedEvidence(checkpoint(106),[token]);
  assert.equal((await db.query('SELECT price_usd::text,evidence FROM node_market_quote_evidence WHERE block_number=106')).rows[0].price_usd,'2','Reused route identities still read current reserves instead of an old price');
  assert.equal(factoryCalls-knownFactories,1,'A known route reauthenticates its factory lookup without rescanning fifteen discovery slots');
  const oldCatalogueFactories=factoryCalls;await svc.captureFeedEvidence(checkpoint(200),[token]);
  assert.ok(factoryCalls-oldCatalogueFactories>=16,'Route discovery refreshes periodically instead of preserving a pool catalogue forever');
  baseReserves/=2n;
  await svc.collectRange(100,100);await svc.decodePending();
  const candle=(await db.query('SELECT close::text,volume_usd::text FROM node_market_candles')).rows[0];assert.equal(candle.close,'2');assert.equal(candle.volume_usd,'20');
  imposter=true;await svc.refreshState(ids[0],checkpoint(101));assert.equal((await db.query('SELECT count(*)::int AS n FROM node_market_quote_evidence WHERE block_number=101')).rows[0].n,0,'Factory lookalikes cannot establish conversion evidence');imposter=false;
  noLiquidity=true;await svc.refreshState(ids[0],checkpoint(102));assert.equal((await db.query('SELECT count(*)::int AS n FROM node_market_quote_evidence WHERE block_number=102')).rows[0].n,0,'Zero reserves never authorize a mark');noLiquidity=false;
  noRoute=true;await svc.refreshState(ids[0],checkpoint(103));assert.equal((await db.query('SELECT count(*)::int AS n FROM node_market_quote_evidence WHERE block_number=103')).rows[0].n,0,'Missing routes stay unavailable');
  const unavailableQuote=await svc.captureFeedEvidence(checkpoint(105),[token]);assert.equal(unavailableQuote.quoteCaptured,0,'A missing current route cannot be completed using a different block proof');
  const unavailableDependency=await svc.captureFeedEvidence(checkpoint(105),[quote]);
  assert.equal(unavailableDependency.quoteRequested,1);assert.equal(unavailableDependency.quoteCaptured,0);assert.deepEqual(unavailableDependency.unresolvedTokens,[],
    'A recognized quote with no genuine route remains incomplete rather than receiving an invented price');
  noRoute=false;await svc.captureMetadata([token,quote],checkpoint(107));prunedRoute=true;
  const retry=createNodeMarketService({db,rpc});await retry.refreshState(ids[0],checkpoint(107));
  const recovered=(await db.query(`SELECT price_usd::text,quote_evidence FROM node_market_observations WHERE token_address=$1 AND block_number=107`,[token])).rows[0];
  assert.equal(recovered.price_usd,'4','A genuinely unavailable route may reuse a recent authenticated conversion');
  assert.equal(recovered.quote_evidence.block_number,'106');assert.equal(recovered.quote_evidence.timestamp,checkpoint(106).timestamp);
  assert.equal(recovered.quote_evidence.evidence.state.reserve1,(4000n*10n**18n).toString(),'Original pool state evidence remains attached');
  assert.equal((await db.query('SELECT count(*)::int n FROM node_market_quote_evidence WHERE block_number=107')).rows[0].n,0,'Fallback never manufactures an exact-block conversion proof');
  await retry.refreshState(ids[0],checkpoint(99));await retry.refreshState(ids[0],checkpoint(401));
  assert.equal((await db.query('SELECT count(*)::int n FROM node_market_observations WHERE block_number IN(99,401)')).rows[0].n,0,'Future and older-than-two-minute proofs never authorize a price');
  prunedRoute=false;
  const exactRetry=await retry.captureFeedEvidence(checkpoint(107),[token]);
  assert.equal(exactRetry.quoteCaptured,1,'A dated fallback is not cached as exact and cannot block a later exact-block recovery');
  assert.equal((await db.query('SELECT price_usd::text FROM node_market_quote_evidence WHERE block_number=107')).rows[0].price_usd,'1');
  const unchanged=(await db.query('SELECT quote_evidence,quote_price_usd::text FROM node_market_observations WHERE block_number=107')).rows[0];
  assert.equal(unchanged.quote_price_usd,'2');assert.equal(unchanged.quote_evidence.price_usd,'2');assert.equal(unchanged.quote_evidence.block_number,'106','A later proof cannot relabel the original observation valuation');
  await db.query(`CREATE TABLE node_evidence_blocks(block_number bigint PRIMARY KEY,block_hash text UNIQUE NOT NULL,parent_hash text NOT NULL,timestamp timestamptz NOT NULL)`);
  for(const n of[400,500,501]){
    const point=checkpoint(n);
    await db.query('INSERT INTO node_evidence_blocks VALUES($1,$2,$3,$4)',[n,point.blockHash,hash(n-1),point.timestamp]);
    if(n!==501)await svc.captureMetadata([token,quote],point);
    const log={address:FLAP_PORTAL,...swap,blockNumber:'0x'+n.toString(16),blockHash:point.blockHash,transactionHash:hash(n+10000),transactionIndex:'0x0',logIndex:'0x0'};
    await db.query(`INSERT INTO node_market_raw_logs(market_id,block_number,block_hash,tx_hash,transaction_index,log_index,timestamp,log,decode_status)
      VALUES($1,$2,$3,$4,0,0,$5,$6::jsonb,'pending')`,[ids[0],n,point.blockHash,log.transactionHash,point.timestamp,JSON.stringify(log)]);
  }
  await svc.captureFeedEvidence(checkpoint(500),[token]);
  const hotRpc=rpcCalls,hotFactories=factoryCalls;
  const hot=createNodeMarketService({db,rpc});
  const hotResult=await hot.decodePending(3,{minimumBlock:500,allowCapturedOlder:true,maxDurationMs:1500,databaseOnly:true});
  assert.equal(hotResult.examined,3);assert.equal(hotResult.decoded,1);
  assert.equal(rpcCalls,hotRpc);assert.equal(factoryCalls,hotFactories,'An old missing quote must not scan pruned conversion routes or delay the fresh swap');
  assert.equal((await db.query('SELECT decode_status FROM node_market_raw_logs WHERE block_number=400')).rows[0].decode_status,'missing_quote','Neither future nor older-than-two-minute conversion evidence is invented for an old log');
  assert.equal((await db.query('SELECT decode_status FROM node_market_raw_logs WHERE block_number=500')).rows[0].decode_status,'decoded','Fresh genuine swaps continue while old conversion evidence is unavailable');
  assert.equal((await db.query('SELECT decode_status FROM node_market_raw_logs WHERE block_number=501')).rows[0].decode_status,'missing_quote','Database-only decoding leaves missing fresh precision to the urgent capture stage rather than duplicating state RPC');
  const client=await db.connect();try{await client.query('BEGIN');await svc.rollback(client,100);await client.query('COMMIT');}finally{client.release();}
  assert.equal((await db.query('SELECT count(*)::int AS n FROM node_market_quote_evidence')).rows[0].n,0,'Reorg removes conversion proofs with their dependent observations');
  assert.ok(batchSizes.includes(15),'Independent route discovery is sent as one bounded batch');assert.ok(batchSizes.every(size=>size<=32));
  console.log('Node quote conversion integration passed');
}finally{await db.end();}
