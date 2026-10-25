import{freshSignedSelfCallBatch}from'./signedSelfCallSettlement.js';
import{createHash}from'node:crypto';
import{Interface,verifyAuthorization}from'ethers';
import type{Pool}from'pg';
import type{Rpc}from'../rpc.js';
import{transferTopic}from'../swap.js';
import{FOUR_MANAGERS,FLAP_PORTAL}from'../launchpad.js';
import{TRUSTED_QUOTE_FEEDS,poolMarketAbi,v3MarketAbi,fourMarketAbi,flapMarketAbi,infinityMarketAbi,infinityBinMarketAbi}from'../nodeMarketProtocols.js';
import{isExcludedKolProfileTokenAddress}from'../kolProfileToken.js';
import{decodeFreshEvidence,encodeFreshEvidence,freshAddress,freshHash,freshInteger,validateFreshReceipt,type FreshCapturedReceipt,type FreshTransaction,type FreshBlock}from'./capture.js';
import{freshNativeBuyCost}from'./routerPayment.js';
import{freshTraceMatchesTransaction,validateFreshTrace,type FreshCallTrace}from'./trace.js';
import{certifyFreshCompleteCallTrace}from'./passiveIncoming.js';
import{stockwavePoolManagerInterface}from'./stockwaveMarket.js';

export const FRESH_URGENT_TRACE_MAX_AGE_MS=12_000;
const topicAddress=(value:string|undefined)=>value&&/^0x0{24}[\da-f]{40}$/i.test(value)?`0x${value.slice(-40).toLowerCase()}`:null;
const swapAbis=[poolMarketAbi,v3MarketAbi,infinityMarketAbi,infinityBinMarketAbi,stockwavePoolManagerInterface,
 new Interface(['event Swap(address indexed sender,address indexed recipient,int256 amount0,int256 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick)'])];
const context=(entry:FreshCapturedReceipt)=>JSON.stringify({transaction:entry.transaction,receipt:entry.receipt,wallets:[...entry.wallets].sort(),historicalWallets:entry.historicalWallets,observedAt:entry.observedAt});
const attemptKey=(entry:FreshCapturedReceipt)=>createHash('sha256').update(context(entry)).digest('hex');
function selfAuthorized(tx:FreshTransaction){
 try{
  const list=tx.authorizationList as Record<string,unknown>[]|undefined;
  if(tx.type!=='0x4'||tx.to?.toLowerCase()!==tx.from.toLowerCase()||!Array.isArray(list)||list.length!==1)return false;
  const auth=list[0],chain=freshInteger(auth.chainId),nonce=freshInteger(auth.nonce),parity=Number(freshInteger(auth.yParity));
  if(chain!==56n||nonce!==freshInteger(tx.nonce)+1n||(parity!==0&&parity!==1)||!freshAddress(auth.address)||!freshHash(auth.r)||!freshHash(auth.s))return false;
  return verifyAuthorization({address:String(auth.address),chainId:chain,nonce},{r:String(auth.r),s:String(auth.s),yParity:parity}).toLowerCase()===tx.from.toLowerCase();
 }catch{return false;}
}
/** Evidence eligibility only, never financial authorization. Trace exactly one
 * monitored wallet's successful native buy when receipts cannot prove its net
 * payment. Failed transactions, plain transfers and known receipt payments
 * need no new private-node trace. */
export function freshUrgentTraceTargets(entry:FreshCapturedReceipt){
 const tx=entry.transaction,wallet=tx.from.toLowerCase(),signedSelfCall=Boolean(freshSignedSelfCallBatch(entry));
 try{
  if(entry.trace||entry.receipt.status!=='0x1'||!entry.wallets.includes(wallet)||!freshAddress(tx.to)||!signedSelfCall&&freshInteger(tx.value)<=0n)return[];
  const ordinary=['0x0','0x1','0x2'].includes(String(tx.type))&&tx.authorizationList===undefined&&tx.to?.toLowerCase()!==wallet;
  if(!ordinary&&!selfAuthorized(tx)&&!signedSelfCall)return[];
 }catch{return[];}
 const flows=new Map<string,bigint>();
 for(const log of entry.receipt.logs){
  if(log.removed||log.topics[0]?.toLowerCase()!==transferTopic||log.topics.length!==3||!/^0x[\da-f]{64}$/i.test(log.data))continue;
  const from=topicAddress(log.topics[1]),to=topicAddress(log.topics[2]),asset=freshAddress(log.address);if(!from||!to||!asset||from!==wallet&&to!==wallet)continue;
  const raw=BigInt(log.data);flows.set(asset,(flows.get(asset)??0n)+(from===wallet?-raw:0n)+(to===wallet?raw:0n));
 }
 if([...flows].some(([asset,raw])=>TRUSTED_QUOTE_FEEDS[asset]&&raw<0n))return[];
 let swap=entry.receipt.logs.some(log=>swapAbis.some(abi=>{try{const parsed=abi.parseLog(log);if(parsed?.name!=='Swap')return false;const encoded=abi.encodeEventLog(parsed.fragment,parsed.args);
  return encoded.data.toLowerCase()===log.data.toLowerCase()&&encoded.topics.length===log.topics.length&&encoded.topics.every((value,index)=>value.toLowerCase()===log.topics[index].toLowerCase());}catch{return false;}}));
 if(!swap)for(const log of entry.receipt.logs){
  const abi=FOUR_MANAGERS.includes(log.address)?fourMarketAbi:log.address===FLAP_PORTAL?flapMarketAbi:null;
  try{const event=abi?.parseLog(log);if(event&&['TokenPurchase','TokenBought'].includes(event.name)&&String(event.args.account??event.args.buyer).toLowerCase()===wallet){swap=true;break;}}catch{/* Unrecognized payload grants no trace priority. */}
 }
 if(!swap)return[];
 return[...flows].filter(([asset,raw])=>(signedSelfCall?raw!==0n:raw>0n)&&!TRUSTED_QUOTE_FEEDS[asset]&&!isExcludedKolProfileTokenAddress(asset)
  &&freshNativeBuyCost(tx,wallet,asset,raw,entry.receipt.logs)===null).slice(0,8).map(([asset])=>asset);
}

/** Optional full-trace work only after native trade candidates. It supplies no
 * price/cost and keeps the same single request/pass deadline. */
export function freshUrgentPassiveTraceTargets(entry:FreshCapturedReceipt):{wallet:string;token:string}[]{
 if(entry.trace||entry.receipt.status!=='0x1'||entry.transaction.type==='0x4'||entry.transaction.authorizationList!==undefined||entry.launchRepair
  ||entry.wallets.includes(entry.transaction.from.toLowerCase())||entry.transaction.to&&entry.wallets.includes(entry.transaction.to.toLowerCase()))return[];
 const swapped=entry.receipt.logs.some(log=>swapAbis.some(abi=>{try{const parsed=abi.parseLog(log);if(parsed?.name!=='Swap')return false;const encoded=abi.encodeEventLog(parsed.fragment,parsed.args);return encoded.data===log.data&&JSON.stringify(encoded.topics)===JSON.stringify(log.topics);}catch{return false;}}));
 if(!swapped)return[];const result:{wallet:string;token:string}[]=[];
 for(const wallet of entry.wallets){const own=entry.receipt.logs.filter(log=>log.topics[0]===transferTopic&&log.topics.slice(1).some(topic=>topicAddress(topic)===wallet));
  if(!own.length||own.some(log=>log.removed||log.topics.length!==3||!/^0x[\da-f]{64}$/.test(log.data)||BigInt(log.data)<=0n||topicAddress(log.topics[1])===wallet||topicAddress(log.topics[2])!==wallet||TRUSTED_QUOTE_FEEDS[log.address]||isExcludedKolProfileTokenAddress(log.address)))continue;
  for(const token of [...new Set(own.map(log=>log.address))])result.push({wallet,token});
 }return result.slice(0,8);
}

export function mergeFreshUrgentTrace(selected:FreshCapturedReceipt,latest:FreshCapturedReceipt,value:unknown){
 if(context(selected)!==context(latest))throw Error('urgent_trace_context_changed');
 const trace=validateFreshTrace(value);if(!freshTraceMatchesTransaction(trace,latest.transaction))throw Error('urgent_trace_transaction_mismatch');
 if(latest.trace){
  if(JSON.stringify(validateFreshTrace(latest.trace))!==JSON.stringify(trace))throw Error('urgent_trace_conflict');return null;
 }
 // All concurrently retained state, recovery proofs and first diagnostics are
 // kept verbatim. Only one complete original-transaction trace is appended.
 let completeTraceProof;try{completeTraceProof=certifyFreshCompleteCallTrace(latest,trace,{method:'debug_traceTransaction',params:[latest.transaction.hash,{tracer:'callTracer',tracerConfig:{onlyTopCall:false,withLog:false}}]},'private_ipc');}catch{/* Older native traces retain their existing behavior; incomplete context cannot authorize passive completion. */}
 return encodeFreshEvidence({...latest,trace,...(completeTraceProof?{completeTraceProof}:{})});
}

export async function persistFreshUrgentTrace(database:Pool,selected:FreshCapturedReceipt,value:unknown,options:{walletRevision:string;token:string;walletAddress?:string}){
 const client=await database.connect();
 try{
  await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock(73621941)');
  const block=Number(freshInteger(selected.receipt.blockNumber)),hash=selected.receipt.blockHash.toLowerCase();
  const canonical=(await client.query('SELECT block_hash FROM fresh.recent_blocks WHERE block_number=$1 FOR SHARE',[block])).rows[0];
  if(canonical?.block_hash!==hash){await client.query('ROLLBACK');return false;}
  const owner=options.walletAddress??selected.transaction.from.toLowerCase();if(!selected.wallets.includes(owner))throw Error('urgent_trace_wallet_changed');
  const wallet=(await client.query('SELECT active,revision,monitoring_from_block,monitoring_to_block FROM fresh.wallets WHERE address=$1 FOR SHARE',[owner])).rows[0];
  if(!wallet?.active||String(wallet.revision)!==options.walletRevision||Number(wallet.monitoring_from_block)>block||wallet.monitoring_to_block!==null&&Number(wallet.monitoring_to_block)<block)throw Error('urgent_trace_wallet_changed');
  const fact=(await client.query("SELECT block_number FROM fresh.launch_facts WHERE token_address=$1 AND status='eligible' FOR SHARE",[options.token])).rows[0];
  if(!fact||Number(fact.block_number)>block)throw Error('urgent_trace_token_changed');
  const row=(await client.query('SELECT payload,wallet_addresses FROM fresh.recent_evidence WHERE tx_hash=$1 AND block_hash=$2 FOR UPDATE',[selected.transaction.hash.toLowerCase(),hash])).rows[0];
  if(!row){await client.query('ROLLBACK');return false;}
  const latest=decodeFreshEvidence(row.payload);
  if([...row.wallet_addresses].sort().join(',')!==[...latest.wallets].sort().join(','))throw Error('urgent_trace_wallet_changed');
  const payload=mergeFreshUrgentTrace(selected,latest,value);
  if(payload)await client.query('UPDATE fresh.recent_evidence SET payload=$3 WHERE tx_hash=$1 AND block_hash=$2',[selected.transaction.hash.toLowerCase(),hash,payload]);
  await client.query('COMMIT');return Boolean(payload);
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}

/** Own loader/queue, independent of slow ordinary repair decoding. Every call
 * settles before the next pass; no detached traces accumulate after timeout. */
export function createFreshUrgentTraceCapture(database:Pool,rpc:Rpc,load:(tx:FreshTransaction,signal?:AbortSignal)=>Promise<FreshCallTrace|null>){
 const attempted=new Map<string,number>();let running=false;
 return async(options:{now?:Date;signal?:AbortSignal}={})=>{
  const empty={receipts:0,attempted:0,saved:0,unavailable:0};if(running||options.signal?.aborted)return{...empty,yielded:true};running=true;
  const start=performance.now(),now=options.now??new Date(),clock=()=>now.getTime()+Math.max(0,performance.now()-start);
  try{
   const capture=(await database.query(`SELECT c.block_number,c.value,b.occurred_at,h.value->>'ok' AS capture_ok FROM fresh.checkpoints c
    JOIN fresh.recent_blocks b ON b.block_number=c.block_number AND b.block_hash=c.block_hash JOIN fresh.checkpoints h ON h.key='health:capture' WHERE c.key='capture'`)).rows[0];
   if(!capture||capture.capture_ok!=='true'||clock()-new Date(capture.occurred_at).getTime()>20_000)return{...empty,yielded:true};
   const head=Number(freshInteger(await rpc<string>('eth_blockNumber',[])));
   if(head-6-Number(capture.block_number)>32)return{...empty,yielded:true};
   const rows=(await database.query(`SELECT e.tx_hash,e.block_hash,e.block_number,e.transaction_index,e.wallet_addresses,e.payload,b.parent_hash,b.occurred_at
    FROM fresh.recent_evidence e JOIN fresh.recent_blocks b USING(block_number,block_hash)
    WHERE e.decoder_status IN('pending','repair') AND b.occurred_at>=$1 AND b.occurred_at<=$2
    ORDER BY e.block_number DESC,e.transaction_index DESC,e.tx_hash LIMIT 16`,[new Date(clock()-FRESH_URGENT_TRACE_MAX_AGE_MS),new Date(clock()+5_000)])).rows;
   for(const[key,at]of attempted)if(clock()-at>60_000)attempted.delete(key);while(attempted.size>512)attempted.delete(attempted.keys().next().value!);
   const candidates=rows.flatMap(row=>{
    const entry=decodeFreshEvidence(row.payload),key=attemptKey(entry),nativeTargets=freshUrgentTraceTargets(entry),passive=nativeTargets.length?[]:freshUrgentPassiveTraceTargets(entry),targets=nativeTargets.length?nativeTargets:passive.map(candidate=>candidate.token);if(!targets.length||attempted.has(key))return[];
    const walletAddress=nativeTargets.length?entry.transaction.from.toLowerCase():passive[0].wallet;
    const block=Number(row.block_number),hash=row.block_hash;
    if(entry.transaction.hash.toLowerCase()!==row.tx_hash||entry.receipt.transactionHash.toLowerCase()!==row.tx_hash||entry.receipt.blockHash.toLowerCase()!==hash
     ||Number(freshInteger(entry.transaction.blockNumber))!==block||Number(freshInteger(entry.receipt.blockNumber))!==block||entry.transaction.blockHash.toLowerCase()!==hash
     ||Number(freshInteger(entry.transaction.transactionIndex))!==Number(row.transaction_index)||[...row.wallet_addresses].sort().join(',')!==[...entry.wallets].sort().join(','))throw Error('urgent_trace_receipt_invalid');
    validateFreshReceipt(entry.receipt,entry.transaction,{number:entry.receipt.blockNumber,hash,parentHash:row.parent_hash,timestamp:`0x${Math.floor(new Date(row.occurred_at).getTime()/1000).toString(16)}`,transactions:[]}as FreshBlock);
    return nativeTargets.length?[{row,entry,key,targets,walletAddress,passive:false}]:[...new Set(passive.map(candidate=>candidate.wallet))].map(walletAddress=>({row,entry,key,targets:passive.filter(candidate=>candidate.wallet===walletAddress).map(candidate=>candidate.token),walletAddress,passive:true}));
   });
   candidates.sort((a,b)=>Number(a.passive)-Number(b.passive));
   if(!candidates.length)return empty;
   const tokens=[...new Set(candidates.flatMap(candidate=>candidate.targets))],wallets=[...new Set(candidates.map(candidate=>candidate.walletAddress))];
   const[launches,active]=await Promise.all([
    database.query("SELECT token_address,block_number FROM fresh.launch_facts WHERE token_address=ANY($1::text[]) AND status='eligible' AND block_number>$2",[tokens,Number(capture.value?.startBlock)]),
    database.query('SELECT address,revision,monitoring_from_block,monitoring_to_block FROM fresh.wallets WHERE address=ANY($1::text[]) AND active',[wallets])
   ]);
   for(const candidate of candidates){
    const{row,entry,key}=candidate,age=clock()-new Date(row.occurred_at).getTime();if(options.signal?.aborted||age<0||age>FRESH_URGENT_TRACE_MAX_AGE_MS)continue;
    const block=Number(row.block_number),eligible=candidate.targets.filter(token=>launches.rows.some(fact=>fact.token_address===token&&Number(fact.block_number)<=block));
    const wallet=active.rows.find(wallet=>wallet.address===candidate.walletAddress&&Number(wallet.monitoring_from_block)<=block&&(wallet.monitoring_to_block===null||Number(wallet.monitoring_to_block)>=block));
    if(eligible.length!==1||!wallet)continue;
    // The independent SSH adapter has no queued jobs, but host-key verification
    // can still wait on local I/O. Expire its signal at the receipt's remaining
    // age budget so that verification cannot start an already-old request.
    attempted.set(key,clock());const deadline=new AbortController(),timer=setTimeout(()=>deadline.abort(),Math.max(1,FRESH_URGENT_TRACE_MAX_AGE_MS-age));
    const signal=options.signal?AbortSignal.any([options.signal,deadline.signal]):deadline.signal;
    let trace:FreshCallTrace|null;try{trace=await load(entry.transaction,signal);}finally{clearTimeout(timer);}
    if(!trace||signal.aborted)return{receipts:1,attempted:1,saved:0,unavailable:1};
    const saved=await persistFreshUrgentTrace(database,entry,trace,{walletRevision:String(wallet.revision),token:eligible[0],walletAddress:candidate.walletAddress});
    return{receipts:1,attempted:1,saved:saved?1:0,unavailable:0};
   }
   return empty;
  }finally{running=false;}
 };
}
