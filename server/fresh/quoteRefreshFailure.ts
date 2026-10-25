import type {Pool} from 'pg';
import {Interface,ZeroAddress,keccak256} from 'ethers';
import {RpcRequestError,type Rpc} from '../rpc.js';
import {FLAP_PORTAL,FOUR_HELPER,FOUR_MANAGERS,flapInterface,fourInterface,WBNB} from '../launchpad.js';
import {poolMarketAbi,oracleMarketAbi,TRUSTED_QUOTE_FEEDS} from '../nodeMarketProtocols.js';
import {freshAddress,freshHash} from './capture.js';
import {FreshRational} from './accounting.js';
import {FreshMetadataReadError,FreshNoLiquidityError,type FreshPriceBlock} from './pricing.js';
import {createFreshCurrentMarketCanonicalHash,freshMarketIdentityInvalid,freshMarketLaunchDigest} from './currentMarketAnchor.js';
import {stockwavePoolManagerInterface,freshStockwaveStorageSlots,validFreshStockwaveMarketIdentity} from './stockwaveMarket.js';
import{GANG_TOKEN_ADDRESS,readFreshTokenAdmission}from'./tracking.js';

const tokenAbi=new Interface(['function decimals() view returns(uint8)','function totalSupply() view returns(uint256)']);
const tokenFields=['address','launch_status','valuation_status','price_source','price_usd','market_cap_usd','decimals','total_supply_raw','observed_block','observed_hash','observed_at'] as const;
const marketFields=['id','token_address','address','protocol','quote_address','identity','state','status','observed_block','observed_hash','observed_at'] as const;
// PostgreSQL JSON numeric values must not pass through JavaScript Number.
const tokenJson=`to_jsonb(t)||jsonb_build_object('price_usd',t.price_usd::text,'market_cap_usd',t.market_cap_usd::text,'total_supply_raw',t.total_supply_raw::text,'observed_block',t.observed_block::text)`;
type Row=Record<string,any>;
export interface FreshQuoteRefreshState {token:Row;markets:Row[]}
const project=(row:Row,keys:readonly string[])=>Object.fromEntries(keys.map(key=>[key,row[key]==null?null:key==='observed_at'?new Date(row[key]).toISOString():key==='observed_block'?String(row[key]):row[key]]));
const equal=(a:unknown,b:unknown)=>freshMarketLaunchDigest(a)===freshMarketLaunchDigest(b);
const rawKey=(to:string,data:string)=>`${to.toLowerCase()}:${data.toLowerCase()}`;
const temporary=(error:unknown)=>error instanceof RpcRequestError&&['transport','rate_limit','state_unavailable'].includes(error.category)
 ||error instanceof FreshMetadataReadError&&['transport','rate_limit','state_unavailable'].includes(error.category);

/** The node retains a short state window. Each four-token group starts from
 * the latest captured confirmed header, rather than an aged whole-batch head. */
export async function readFreshQuoteRefreshAnchor(database:Pick<Pool,'query'>,now=Date.now()){
 const captured=(await database.query(`SELECT c.block_number,c.block_hash,c.revision,b.occurred_at FROM fresh.checkpoints c
  JOIN fresh.recent_blocks b ON b.block_number=c.block_number AND b.block_hash=c.block_hash WHERE c.key='capture'`)).rows[0];
 const revision=Number(captured?.revision),at=Date.parse(captured?.occurred_at),number=Number(captured?.block_number),hash=freshHash(captured?.block_hash);
 if(!Number.isSafeInteger(revision)||!Number.isSafeInteger(number)||number<0||!hash||!Number.isFinite(at)||now-at>20000||at>now+5000)throw Error('current_quote_capture_unavailable');
 const block={number,hash,timestamp:new Date(at).toISOString()},hashes=new Map<number,Promise<string|null>>([[number,Promise.resolve(hash)]]);
 const canonicalHash=(target:number)=>{let work=hashes.get(target);if(!work){work=database.query('SELECT block_hash FROM fresh.recent_blocks WHERE block_number=$1',[target]).then(result=>result.rows[0]?.block_hash??null);hashes.set(target,work);}return work;};
 return{captureRevision:revision,block,canonicalHash};
}

/** Read once before the bounded worker batch. Snapshot only the quote and its
 * authenticating market, not token counters or financial response copies. */
export async function readFreshQuoteRefreshStates(database:Pick<Pool,'query'>,tokens:readonly string[]){
 if(tokens.length>64)throw Error('quote_refresh_batch_bounds');
 const rows=(await database.query(`SELECT ${tokenJson} AS token,COALESCE((SELECT jsonb_agg(x.row ORDER BY x.id) FROM
  (SELECT m.id,to_jsonb(m) AS row FROM fresh.markets m WHERE m.token_address=t.address AND m.observed_block=t.observed_block
   AND m.observed_hash=t.observed_hash AND m.observed_at=t.observed_at ORDER BY m.id LIMIT 9)x),'[]'::jsonb) AS markets
  FROM fresh.tokens t WHERE t.address=ANY($1::text[])`,[tokens])).rows;
 return new Map<string,FreshQuoteRefreshState>(rows.map(row=>[row.token.address,{token:project(row.token,tokenFields),markets:row.markets.map((market:Row)=>project(market,marketFields))}]));
}

/** Observe only the existing RPC work. Absence and transport errors are never
 * new financial evidence; contradictory successful calls prevent retention. */
export function observeFreshQuoteRefresh(rpc:Rpc,block:FreshPriceBlock){
 const calls=new Map<string,string>(),codes=new Map<string,string>(),failedCalls=new Map<string,string>(),failedCodes=new Map<string,string>();let bytes=0,invalid=false,transient=false;
 const wrapped=(async<T>(method:string,params:unknown[]):Promise<T>=>{
  try{const result=await rpc<T>(method,params);
   if(method==='eth_chainId'&&result!=='0x38')invalid=true;
   if(method==='eth_call'){
    const[call,at]=params as [{to?:unknown;data?:unknown},{blockHash?:unknown;requireCanonical?:unknown}];
    if(at?.blockHash!==block.hash||at.requireCanonical!==true||!freshAddress(call?.to)||typeof call?.data!=='string')invalid=true;
    else if(typeof result!=='string'||!/^0x(?:[\da-f]{2})*$/i.test(result)||result.length>32770)invalid=true;
    else{const key=rawKey(call.to as string,call.data),prior=calls.get(key);if(prior!==undefined&&prior!==result)invalid=true;
     if(prior===undefined){bytes+=result.length;if(calls.size>=256||bytes>524288)invalid=true;else calls.set(key,result);}}
   }else if(method==='eth_getCode'){
    const[to,at]=params as[string,{blockHash?:unknown;requireCanonical?:unknown}];
    if(at?.blockHash!==block.hash||at.requireCanonical!==true||!freshAddress(to)||typeof result!=='string'||!/^0x(?:[\da-f]{2})*$/i.test(result)||result.length>131074)invalid=true;
    else{const prior=codes.get(to);if(prior!==undefined&&prior!==result)invalid=true;
     if(prior===undefined){bytes+=result.length;if(codes.size>=128||bytes>524288)invalid=true;else codes.set(to,result);}}
   }return result;
  }catch(error){if(temporary(error))transient=true;else if(error instanceof RpcRequestError&&error.category==='invalid_response')invalid=true;
   if(method==='eth_call'||method==='eth_getCode'){
    const call=method==='eth_call'?params[0]as{to?:unknown;data?:unknown}:{to:params[0],data:''},at=params[1]as{blockHash?:unknown;requireCanonical?:unknown};
    if(at?.blockHash===block.hash&&at.requireCanonical===true&&freshAddress(call?.to)&&typeof call.data==='string'){
     const map=method==='eth_call'?failedCalls:failedCodes,key=method==='eth_call'?rawKey(call.to as string,call.data):call.to as string;
     if(key.length>4096||map.size>=256)invalid=true;else if(!map.has(key)||!temporary(error))map.set(key,error instanceof RpcRequestError?error.category:'unknown');
    }else invalid=true;
   }else if(method==='eth_chainId'&&!temporary(error))invalid=true;
   throw error;}
 })as Rpc;
 return{rpc:wrapped,block,calls,codes,failedCalls,failedCodes,get invalid(){return invalid;},get transient(){return transient;}};
}
export type FreshQuoteRefreshEvidence=ReturnType<typeof observeFreshQuoteRefresh>;

/** Missing calls are allowed only after a genuine transient failure. A raw
 * call that succeeded must still agree with the original precision/identity. */
export function freshQuoteRefreshCanRetain(state:FreshQuoteRefreshState|undefined,evidence:FreshQuoteRefreshEvidence,error:unknown,now:number){
 if(!state||state.token.valuation_status!=='ready'||state.token.price_source!=='node'||!(state.token.launch_status==='eligible'||state.token.address===GANG_TOKEN_ADDRESS&&state.token.launch_status==='preexisting')||state.markets.length<1||state.markets.length>8
  ||error instanceof FreshNoLiquidityError||evidence.invalid||!(temporary(error)||error instanceof Error&&error.message==='authenticated_market_quote_unavailable'&&evidence.transient))return false;
 // Admission is not a substitute for genuine V4 launch/Initialize evidence.
 if(state.token.launch_status==='preexisting'&&state.markets.some(m=>m.protocol==='uniswap_v4'))return false;
 const t=state.token,age=now-Date.parse(t.observed_at);
 try{
  if(!Number.isFinite(age)||age<0||age>120000||FreshRational.parse(t.price_usd).n<=0n||FreshRational.parse(t.market_cap_usd).n<=0n||!freshHash(t.observed_hash))return false;
  const failed=(map:Map<string,string>,key:string)=>{const category=map.get(key);return category!==undefined&&!['transport','rate_limit','state_unavailable'].includes(category);};
  const read=(to:string,abi:Interface,method:string,args:unknown[]=[])=>{const key=rawKey(to,abi.encodeFunctionData(method,args));if(failed(evidence.failedCalls,key))throw Error('quote_refresh_expected_getter_failed');const raw=evidence.calls.get(key);if(raw===undefined)return null;
   const result=abi.decodeFunctionResult(method,raw);if(abi.encodeFunctionResult(method,[...result])!==raw)throw Error('quote_refresh_raw_invalid');return result;};
  const codeMatches=(address:string,expected:unknown)=>{if(failed(evidence.failedCodes,address))return false;const raw=evidence.codes.get(address);return raw===undefined||raw!=='0x'&&(typeof expected!=='string'||keccak256(raw)===expected);};
  const registrationMatches=(factory:string,pair:string,a:string,b:string,fee:unknown)=>{
   for(const assets of[[a,b],[b,a]]){const result=fee==null?read(factory,poolMarketAbi,'getPair',assets):read(factory,poolMarketAbi,'getPool',[...assets,fee]);
    if(result&&String(result[0]).toLowerCase()!==pair)return false;}
   return true;
  };
  const feedAssets=new Set<string>();
  for(const[method,expected]of[['decimals',t.decimals],['totalSupply',t.total_supply_raw]]as const){const result=read(t.address,tokenAbi,method);if(result&&BigInt(result[0])!==BigInt(expected))return false;}
  for(const market of state.markets){
   feedAssets.add(market.quote_address);
   if(market.status!=='ready'||freshMarketIdentityInvalid(market.identity)||market.identity.stockConversion)return false;
   if(market.address&&!codeMatches(market.address,market.identity.pairRuntimeHash)||market.identity.factory&&!codeMatches(market.identity.factory,market.identity.factoryRuntimeHash))return false;
   if(market.protocol==='flap'){
    const method=market.identity?.method??'getTokenV8Safe';if(!['getTokenV8Safe','getTokenV7'].includes(method))return false;
    const result=read(FLAP_PORTAL,flapInterface,method,[t.address]);if(result){const info=result[0],quote=String(info.quoteTokenAddress).toLowerCase();
     if(BigInt(info.status)!==1n||BigInt(info.reserve)<=0n||BigInt(info.price)<=0n||(quote===ZeroAddress?WBNB:quote)!==market.quote_address)return false;}
   }else if(market.protocol==='fourmeme'){
    const result=read(FOUR_HELPER,fourInterface,'getTokenInfo',[t.address]);if(result){const quote=String(result.quote).toLowerCase();
     if(![1n,2n].includes(BigInt(result.version))||!FOUR_MANAGERS.includes(String(result.tokenManager).toLowerCase())||result.liquidityAdded
      ||BigInt(result.lastPrice)<=0n||BigInt(result.funds)<=0n||(quote===ZeroAddress?WBNB:quote)!==market.quote_address
      ||String(result.tokenManager).toLowerCase()!==String(market.identity.manager).toLowerCase())return false;}
   }else if(['pcs_v2','pcs_v3'].includes(market.protocol)){
    if(!registrationMatches(market.identity.factory,market.address,t.address,market.quote_address,market.protocol==='pcs_v3'?market.identity.fee:null))return false;
    for(const method of['factory','token0','token1','fee']){if(market.identity[method]==null)continue;const result=read(market.address,poolMarketAbi,method);
     if(result&&String(result[0]).toLowerCase()!==String(market.identity[method]).toLowerCase())return false;}
    if(market.protocol==='pcs_v2'){const result=read(market.address,poolMarketAbi,'getReserves');if(result&&(BigInt(result[0])<=0n||BigInt(result[1])<=0n))return false;}
    else{const slot=read(market.address,poolMarketAbi,'slot0'),liquidity=read(market.address,poolMarketAbi,'liquidity');if(slot&&(BigInt(slot[0])<=0n||!slot[6])||liquidity&&BigInt(liquidity[0])<=0n)return false;}
   }else if(market.protocol==='uniswap_v4'){
    const identity=market.identity.market??market.identity;if(!validFreshStockwaveMarketIdentity(identity))return false;
    const result=read(identity.manager,stockwavePoolManagerInterface,'extsload',[freshStockwaveStorageSlots(identity.poolId)]);
    if(result&&(result[0].length!==2||(BigInt(result[0][0])&((1n<<160n)-1n))===0n||(BigInt(result[0][1])&((1n<<128n)-1n))===0n))return false;
   }else return false;
   // The original quote's conversion pool is part of its proof too. A newly
   // observed empty bridge or changed precision must not be hidden by another
   // simultaneous transport error elsewhere in the attempt.
   const conversions=[market.identity.quoteConversion,...(Array.isArray(market.identity.pairs)?market.identity.pairs:[])].filter(Boolean);
   if(conversions.length>8)return false;
   for(const route of conversions){
    for(const asset of[route.settlementToken,route.nativeToken,route.nativeAddress,market.identity.nativeAddress])if(asset)feedAssets.add(asset);
    const pair=route.pair??route.address;if(!freshAddress(pair))return false;
    if(!registrationMatches(route.factory??market.identity.factory,pair,route.token0,route.token1,route.protocol==='pcs_v3'?route.fee:null))return false;
    if(!codeMatches(pair,route.pairRuntimeHash)||route.factory&&!codeMatches(route.factory,route.factoryRuntimeHash)||route.deployer&&!codeMatches(route.deployer,route.deployerRuntimeHash))return false;
    for(const method of['factory','token0','token1','fee']){if(route[method]==null)continue;const result=read(pair,poolMarketAbi,method);
     if(result&&String(result[0]).toLowerCase()!==String(route[method]).toLowerCase())return false;}
    for(const[asset,precision]of[[route.quoteToken,route.quoteDecimals],[route.settlementToken,route.settlementDecimals],[route.nativeToken,18]]){
     if(asset&&precision!=null){const result=read(asset,tokenAbi,'decimals');if(result&&BigInt(result[0])!==BigInt(precision))return false;}
    }
    if(route.protocol==='pcs_v3'){const slot=read(pair,poolMarketAbi,'slot0'),liquidity=read(pair,poolMarketAbi,'liquidity');
     if(slot&&(BigInt(slot[0])<=0n||!slot[6])||liquidity&&BigInt(liquidity[0])<=0n)return false;
    }else{const reserves=read(pair,poolMarketAbi,'getReserves');if(reserves&&(BigInt(reserves[0])<=0n||BigInt(reserves[1])<=0n))return false;}
   }
  }
  for(const asset of feedAssets){const feed=TRUSTED_QUOTE_FEEDS[asset];if(!feed)continue;
   const result=read(feed.feed,oracleMarketAbi,'latestRoundData'),description=read(feed.feed,oracleMarketAbi,'description'),precision=read(feed.feed,oracleMarketAbi,'decimals');
   if(precision&&(BigInt(precision[0])<0n||BigInt(precision[0])>36n))return false;
   if(description&&description[0]!==feed.description)return false;
   if(result){const updated=Number(result[3]),at=Date.parse(evidence.block.timestamp)/1000;
    if(BigInt(result[1])<=0n||updated<=0||updated>at||at-updated>feed.maxAgeSeconds||BigInt(result[4])<BigInt(result[0]))return false;}
  }
  return true;
 }catch{return false;}
}

/** Serialize a failed refresh with reorgs and successful quotes. Retention is
 * permission to use the original dated observation only until its existing
 * deadline; it never promotes a previously unavailable quote or freshens it. */
export async function commitFreshQuoteRefreshFailure(database:Pool,token:string,error:unknown,options:{captureRevision:string|number;block:FreshPriceBlock;prior?:FreshQuoteRefreshState;evidence:FreshQuoteRefreshEvidence;now?:()=>number}){
 // A successful market read can lose the separate capture commit guard. Capture
 // may be healthy again before this handler runs; that race is not evidence
 // against the earlier dated quote. Do not downgrade it or promote/freshen any
 // unavailable row. Reorg processing owns invalidation and readers keep the
 // original hard expiry. The worker still schedules a bounded retry.
 if(error instanceof Error&&error.message==='current_quote_capture_changed')return{retained:false,updated:false,reason:'capture_changed'};
 const client=await database.connect();try{
  await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock(73621941)');
  const capture=(await client.query(`SELECT c.block_number,c.block_hash,c.revision,b.occurred_at,h.value->>'ok' AS capture_ok,h.updated_at AS health_at
   FROM fresh.checkpoints c JOIN fresh.checkpoints h ON h.key='health:capture' JOIN fresh.recent_blocks b ON b.block_number=c.block_number AND b.block_hash=c.block_hash
   WHERE c.key='capture' FOR SHARE OF c,h,b`)).rows[0];
  const now=(options.now??Date.now)(),age=now-Date.parse(capture?.occurred_at),healthAge=now-Date.parse(capture?.health_at);
  if(!capture||String(capture.revision)!==String(options.captureRevision)||capture.capture_ok!=='true'||!Number.isFinite(age)||age< -5000||age>20000
   ||!Number.isFinite(healthAge)||healthAge< -5000||healthAge>90000){await client.query('ROLLBACK');return{retained:false,updated:false,reason:'capture_changed'};}
  const current=(await client.query(`SELECT ${tokenJson} AS token,to_jsonb(lf) AS launch FROM fresh.tokens t LEFT JOIN fresh.launch_facts lf ON lf.token_address=t.address
   WHERE t.address=$1 FOR UPDATE OF t`,[token])).rows[0];
  if(!options.prior){await client.query('ROLLBACK');return{retained:false,updated:false,reason:'quote_snapshot_missing'};}
  const admission=current?await readFreshTokenAdmission(client,token,{blockNumber:options.block.number,lock:true}):null;
  if(!current||!admission||current.token.launch_status!==admission.launchStatus
   ||Number(current.token.observed_block)>options.block.number){await client.query('ROLLBACK');return{retained:false,updated:false,reason:'quote_changed'};}
  // A newer success or canonical correction always wins over an older failure.
  // Status-only changes also count: a previous failure must never be promoted.
  if(options.prior&&!equal(project(current.token,tokenFields),options.prior.token)){
   await client.query('ROLLBACK');return{retained:false,updated:false,reason:'quote_changed'};
  }
  const attempted=(await client.query('SELECT block_hash FROM fresh.recent_blocks WHERE block_number=$1 FOR SHARE',[options.block.number])).rows[0]?.block_hash;
  if(attempted!==options.block.hash||Number(options.block.number)>Number(capture.block_number)||!equal(options.block,options.evidence.block)){
   await client.query('ROLLBACK');return{retained:false,updated:false,reason:'capture_changed'};
  }
  let retain=freshQuoteRefreshCanRetain(options.prior,options.evidence,error,now)&&equal(project(current.token,tokenFields),options.prior?.token);
  if(retain){
   const canonical=(await client.query('SELECT block_hash,occurred_at FROM fresh.recent_blocks WHERE block_number=$1 FOR SHARE',[current.token.observed_block])).rows[0];
   const birth=admission.kind==='new_launch'?(await client.query('SELECT block_hash FROM fresh.recent_blocks WHERE block_number=$1 FOR SHARE',[admission.fact.block_number])).rows[0]?.block_hash:null;
   if(canonical?.block_hash!==current.token.observed_hash||new Date(canonical?.occurred_at).getTime()!==Date.parse(current.token.observed_at)
    ||Number(current.token.observed_block)>Number(capture.block_number)||birth&&admission.kind==='new_launch'&&birth!==admission.fact.block_hash)retain=false;
   const markets=(await client.query('SELECT * FROM fresh.markets WHERE id=ANY($1::text[]) ORDER BY id FOR SHARE',[options.prior!.markets.map(m=>m.id)])).rows;
   if(!equal(markets.map((row:Row)=>project(row,marketFields)),options.prior!.markets))retain=false;
   for(const market of markets)if(market.protocol==='uniswap_v4'){
    const identity=market.identity.market??market.identity,canonicalHash=createFreshCurrentMarketCanonicalHash(client,{token,block:options.block});
    if(freshMarketIdentityInvalid(market.identity)||!validFreshStockwaveMarketIdentity(identity)||await canonicalHash(identity.initial.blockNumber)!==identity.initial.blockHash)retain=false;
   }
  }
  if(!retain)await client.query('UPDATE fresh.tokens SET valuation_status=$2 WHERE address=$1',[token,error instanceof FreshNoLiquidityError?'no_liquidity':'quote_unavailable']);
  await client.query('COMMIT');return{retained:retain,updated:!retain,reason:retain?'dated_quote_retained':'quote_unavailable'};
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
