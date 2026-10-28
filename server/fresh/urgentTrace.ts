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
import{freshNativeBuyCost,freshSupplementalNativeBuyCost}from'./routerPayment.js';
import{freshNativeDelta,freshTraceMatchesTransaction,validateFreshTrace,type FreshCallTrace}from'./trace.js';
import{certifyFreshCompleteCallTrace,validFreshCompleteCallTrace}from'./passiveIncoming.js';
import{freshPositionDependencies}from'./positionDependencies.js';
import{stockwavePoolManagerInterface}from'./stockwaveMarket.js';
import{readFreshTokenAdmission}from'./tracking.js';
import{freshVerifiedAirdropClaimCandidate}from'./verifiedAirdropClaim.js';
import{freshPaidCreationPurchaseCandidate}from'./paidCreationPurchase.js';

export const FRESH_URGENT_TRACE_MAX_AGE_MS=12_000;
export const FRESH_URGENT_TRACE_RETRY_DELAY_MS=500;
export interface FreshUrgentTraceAttempts{version:1;contextSha256:string;count:1|2;lastStartedAt:string;lastFinishedAt?:string;lastDurationMs?:number;lastOutcome:'started'|'saved'|'unavailable'|'transport_error'|'aborted'|'expired'|'rejected';priority:0|1|2|3;candidateCount:number;startAgeMs:number}
declare module './capture.js'{interface FreshCapturedReceipt{urgentTraceAttempts?:FreshUrgentTraceAttempts}}
const topicAddress=(value:string|undefined)=>value&&/^0x0{24}[\da-f]{40}$/i.test(value)?`0x${value.slice(-40).toLowerCase()}`:null;
const swapAbis=[poolMarketAbi,v3MarketAbi,infinityMarketAbi,infinityBinMarketAbi,stockwavePoolManagerInterface,
 new Interface(['event Swap(address indexed sender,address indexed recipient,int256 amount0,int256 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick)'])];
const context=(entry:FreshCapturedReceipt)=>JSON.stringify({transaction:entry.transaction,receipt:entry.receipt,wallets:[...entry.wallets].sort(),historicalWallets:entry.historicalWallets,observedAt:entry.observedAt});
const attemptKey=(entry:FreshCapturedReceipt)=>createHash('sha256').update(context(entry)).digest('hex');
const attemptOutcomes=new Set(['started','saved','unavailable','transport_error','aborted','expired','rejected']);
/** Only our bounded evidence telemetry is accepted. Its context excludes
 * additive trace/state data, so decoder-first evidence cannot reset the cap. */
export function freshUrgentTraceAttempts(entry:FreshCapturedReceipt):FreshUrgentTraceAttempts|undefined{
 const d=entry.urgentTraceAttempts;if(d===undefined)return;
 const keys=['version','contextSha256','count','lastStartedAt','lastFinishedAt','lastDurationMs','lastOutcome','priority','candidateCount','startAgeMs'],iso=(v:unknown)=>typeof v==='string'&&v.length===24&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v;
 if(!d||typeof d!=='object'||Array.isArray(d)||Buffer.byteLength(JSON.stringify(d))>1024||Object.keys(d).some(k=>!keys.includes(k))||d.version!==1||d.contextSha256!==attemptKey(entry)||![1,2].includes(d.count)||!iso(d.lastStartedAt)||!attemptOutcomes.has(d.lastOutcome)||!Number.isInteger(d.priority)||d.priority<0||d.priority>3||!Number.isInteger(d.candidateCount)||d.candidateCount<1||d.candidateCount>256||!Number.isInteger(d.startAgeMs)||d.startAgeMs<0||d.startAgeMs>FRESH_URGENT_TRACE_MAX_AGE_MS
  ||(d.lastOutcome==='started'?(d.lastFinishedAt!==undefined||d.lastDurationMs!==undefined):(!iso(d.lastFinishedAt)||Date.parse(d.lastFinishedAt!)<Date.parse(d.lastStartedAt)||!Number.isSafeInteger(d.lastDurationMs)||d.lastDurationMs!<0)))throw Error('urgent_trace_attempts_invalid');
 return d;
}
function attemptAvailable(entry:FreshCapturedReceipt,now:number){try{const d=freshUrgentTraceAttempts(entry);return!d||d.count<2&&['unavailable','transport_error'].includes(d.lastOutcome)&&now-Date.parse(d.lastFinishedAt!)>=FRESH_URGENT_TRACE_RETRY_DELAY_MS;}catch{return false;}}
function completedTraceCandidate(entry:FreshCapturedReceipt,status:string|undefined){
 if(status!=='done')return true;
 const outgoing=freshUrgentOutgoingTraceCandidate(entry),passive=outgoing?[]:freshUrgentPassiveTraceTargets(entry),inbound=outgoing?[]:freshUrgentInboundDependencyTargets(entry);
 const completedDependency=(inbound.length>0||passive.length>0)&&typeof entry.transaction.input==='string'&&/^0x(?:[\da-f]{2}){4,}$/i.test(entry.transaction.input);
 return completedDependency||taxReceiptNativeCost(entry)!==null||freshVerifiedAirdropClaimCandidate(entry)||freshPaidCreationPurchaseCandidate(entry);
}
type AttemptContext={walletRevision:string;walletAddress:string;outgoingEvidenceOnly:boolean;inboundEvidenceOnly:boolean};
type AttemptFinish={reservation:FreshUrgentTraceAttempts;at:Date;durationMs:number;outcome:Exclude<FreshUrgentTraceAttempts['lastOutcome'],'started'>};
function finishedAttempt(value:AttemptFinish):FreshUrgentTraceAttempts{return{...value.reservation,lastFinishedAt:value.at.toISOString(),lastDurationMs:Math.max(0,Math.round(value.durationMs)),lastOutcome:value.outcome};}
function sameReservation(entry:FreshCapturedReceipt,reservation:FreshUrgentTraceAttempts){const d=freshUrgentTraceAttempts(entry);return!!d&&d.contextSha256===reservation.contextSha256&&d.count===reservation.count&&d.lastStartedAt===reservation.lastStartedAt&&d.lastOutcome==='started';}
/** Reserve before load, including failed requests and process restarts. These
 * small transactions change payload telemetry only, never status/jobs/TTL. */
async function persistTraceAttempt(database:Pool,selected:FreshCapturedReceipt,options:AttemptContext,work:{start:{at:Date;ageMs:number;priority:0|1|2|3;candidateCount:number}}|{finish:AttemptFinish}){
 const client=await database.connect();try{
  await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock(73621941)');const block=Number(freshInteger(selected.receipt.blockNumber)),hash=selected.receipt.blockHash.toLowerCase();
  const canonical=(await client.query('SELECT block_hash FROM fresh.recent_blocks WHERE block_number=$1 FOR SHARE',[block])).rows[0];
  if(canonical?.block_hash!==hash){await client.query('ROLLBACK');return null;}
  const wallet=(await client.query('SELECT active,revision,monitoring_from_block,monitoring_to_block FROM fresh.wallets WHERE address=$1 FOR SHARE',[options.walletAddress])).rows[0];
  if(!wallet?.active||String(wallet.revision)!==options.walletRevision||Number(wallet.monitoring_from_block)>block||wallet.monitoring_to_block!==null&&Number(wallet.monitoring_to_block)<block){await client.query('ROLLBACK');return null;}
  const row=(await client.query('SELECT payload,wallet_addresses,decoder_status FROM fresh.recent_evidence WHERE tx_hash=$1 AND block_hash=$2 FOR UPDATE',[selected.transaction.hash.toLowerCase(),hash])).rows[0];
  if(!row){await client.query('ROLLBACK');return null;}const latest=decodeFreshEvidence(row.payload);
  if(context(latest)!==context(selected)||[...row.wallet_addresses].sort().join(',')!==[...latest.wallets].sort().join(',')||!latest.wallets.includes(options.walletAddress)){await client.query('ROLLBACK');return null;}
  let diagnostic:FreshUrgentTraceAttempts;
  if('start'in work){const{at,ageMs,priority,candidateCount}=work.start;
   if(ageMs<0||ageMs>FRESH_URGENT_TRACE_MAX_AGE_MS||!attemptAvailable(latest,at.getTime())||hasCompleteTrace(latest)||!completedTraceCandidate(latest,row.decoder_status)
    ||options.outgoingEvidenceOnly&&!freshUrgentOutgoingTraceCandidate(latest)||options.inboundEvidenceOnly&&!freshUrgentInboundDependencyTargets(latest).includes(options.walletAddress)&&!freshUrgentPassiveTraceTargets(latest).some(t=>t.wallet===options.walletAddress)){await client.query('ROLLBACK');return null;}
   const old=freshUrgentTraceAttempts(latest);diagnostic={version:1,contextSha256:attemptKey(latest),count:(old?old.count+1:1)as 1|2,lastStartedAt:at.toISOString(),lastOutcome:'started',priority,candidateCount,startAgeMs:Math.round(ageMs)};
  }else{if(!sameReservation(latest,work.finish.reservation)){await client.query('ROLLBACK');return null;}diagnostic=finishedAttempt(work.finish);}
  const merged={...latest,urgentTraceAttempts:diagnostic};freshUrgentTraceAttempts(merged);
  await client.query('UPDATE fresh.recent_evidence SET payload=$3 WHERE tx_hash=$1 AND block_hash=$2',[selected.transaction.hash.toLowerCase(),hash,encodeFreshEvidence(merged)]);await client.query('COMMIT');return diagnostic;
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
function hasCompleteTrace(entry:FreshCapturedReceipt){
 try{return!!entry.trace&&validFreshCompleteCallTrace(entry,validateFreshTrace(entry.trace));}catch{return false;}
}
function taxReceiptNativeCost(entry:FreshCapturedReceipt,wallet=entry.transaction.from.toLowerCase()){
 const flows=new Map<string,bigint>();for(const l of entry.receipt.logs)if(l.topics[0]?.toLowerCase()===transferTopic&&l.topics.length===3&&/^0x[\da-f]{64}$/i.test(l.data)){const asset=l.address.toLowerCase(),n=BigInt(l.data);flows.set(asset,(flows.get(asset)??0n)+(topicAddress(l.topics[2])===wallet?n:0n)-(topicAddress(l.topics[1])===wallet?n:0n));}
 for(const[asset,raw]of flows){const cost=freshSupplementalNativeBuyCost(entry.transaction,wallet,asset,raw,entry.receipt.logs);if(cost!==null)return cost;}return null;
}
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
  if(hasCompleteTrace(entry)||entry.receipt.status!=='0x1'||!entry.wallets.includes(wallet)||!freshAddress(tx.to)||!signedSelfCall&&freshInteger(tx.value)<=0n)return[];
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
 if(!swap)swap=[...flows].some(([asset,raw])=>raw>0n&&!TRUSTED_QUOTE_FEEDS[asset]&&!isExcludedKolProfileTokenAddress(asset)
  &&freshSupplementalNativeBuyCost(tx,wallet,asset,raw,entry.receipt.logs)!==null);
 if(!swap)return[];
 return[...flows].filter(([asset,raw])=>(signedSelfCall?raw!==0n:raw>0n)&&!TRUSTED_QUOTE_FEEDS[asset]&&!isExcludedKolProfileTokenAddress(asset)
  &&(freshNativeBuyCost(tx,wallet,asset,raw,entry.receipt.logs)===null||freshSupplementalNativeBuyCost(tx,wallet,asset,raw,entry.receipt.logs)!==null)).slice(0,8).map(([asset])=>asset);
}

/** An outgoing monitored contract execution is original chain evidence even
 * while a token's age/launch is unresolved. In particular zero-native sells
 * and approvals must not lose their complete call tree behind admission or
 * ordinary historical repair work. This grants no financial eligibility. */
export function freshUrgentOutgoingTraceCandidate(entry:FreshCapturedReceipt){
 const tx=entry.transaction,wallet=freshAddress(tx.from);
 if(hasCompleteTrace(entry)||entry.receipt.status!=='0x1'||!wallet||!entry.wallets.includes(wallet)||!freshAddress(tx.to)&&!freshUrgentTopLevelCreation(entry))return false;
 const ordinary=['0x0','0x1','0x2'].includes(String(tx.type))&&tx.authorizationList===undefined&&tx.to!==wallet;
 if(!ordinary&&!selfAuthorized(tx)&&!freshSignedSelfCallBatch(entry))return false;
 // Existing native-swap recognition also accepts the older original envelope
 // shape without calldata. All other fallback work needs a real method call.
 return freshUrgentTraceTargets(entry).length>0||typeof tx.input==='string'&&/^0x(?:[\da-f]{2}){4,}$/i.test(tx.input);
}

/** Creation receipts are already captured when their constructor touches a
 * watched wallet. Keep the complete tree before pruning just as for a method
 * call; the created address and ordinary envelope are required, not inferred. */
function freshUrgentTopLevelCreation(entry:FreshCapturedReceipt){
 const tx=entry.transaction;
 return tx.to===null&&['0x0','0x1','0x2'].includes(String(tx.type))&&tx.authorizationList===undefined
  &&!!freshAddress(entry.receipt.contractAddress)&&typeof tx.input==='string'&&/^0x(?:[\da-f]{2}){4,}$/i.test(tx.input);
}

/** Lowest-priority dependency proof for an already captured watched-recipient
 * context. Synthetic transfer batches otherwise remain globally opaque long
 * after an unrelated real token launches. This never scans other chain calls
 * or treats their emitted transfers as real economic movements. */
export function freshUrgentInboundDependencyTargets(entry:FreshCapturedReceipt){
 if(hasCompleteTrace(entry)||entry.receipt.status!=='0x1'||entry.wallets.includes(entry.transaction.from.toLowerCase())||!freshAddress(entry.transaction.to)&&!freshUrgentTopLevelCreation(entry)
  ||typeof entry.transaction.input!=='string'||!/^0x(?:[\da-f]{2}){4,}$/i.test(entry.transaction.input))return[];
 const watched=new Set(entry.wallets),targets=new Set<string>();
 for(const log of entry.receipt.logs){if(log.removed||log.topics[0]?.toLowerCase()!==transferTopic||log.topics.length!==3||!/^0x[\da-f]{64}$/i.test(log.data)||!freshAddress(log.address)||TRUSTED_QUOTE_FEEDS[log.address]||isExcludedKolProfileTokenAddress(log.address))continue;
  for(const topic of log.topics.slice(1)){const wallet=topicAddress(topic);if(wallet&&watched.has(wallet))targets.add(wallet);}}
 return[...targets].sort().slice(0,8);
}

/** Optional full-trace work only after native trade candidates. It supplies no
 * price/cost and keeps the same single request/pass deadline. */
export function freshUrgentPassiveTraceTargets(entry:FreshCapturedReceipt):{wallet:string;token:string}[]{
 if(hasCompleteTrace(entry)||entry.receipt.status!=='0x1'||entry.transaction.type==='0x4'||entry.transaction.authorizationList!==undefined||entry.launchRepair
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
 const trace=validateFreshTrace(value);if(!freshTraceMatchesTransaction(trace,latest.transaction)
  ||latest.transaction.to===null&&trace.to!==freshAddress(latest.receipt.contractAddress))throw Error('urgent_trace_transaction_mismatch');
 if(latest.trace){
  if(JSON.stringify(validateFreshTrace(latest.trace))!==JSON.stringify(trace))throw Error('urgent_trace_conflict');
  if(hasCompleteTrace(latest))return null;
  // An existing certificate, even an invalid one, is retained as conflicting
  // evidence rather than overwritten. A decoder-first tree with no certificate
  // can be attested only after this actual independent full private-IPC read.
  if(latest.completeTraceProof!==undefined)throw Error('urgent_trace_attestation_conflict');
 }
 // All concurrently retained state, recovery proofs and first diagnostics are
 // kept verbatim. Only one complete original-transaction trace is appended.
 let completeTraceProof;try{completeTraceProof=certifyFreshCompleteCallTrace(latest,trace,{method:'debug_traceTransaction',params:[latest.transaction.hash,{tracer:'callTracer',tracerConfig:{onlyTopCall:false,withLog:false}}]},'private_ipc');}catch{/* Older native traces retain their existing behavior; incomplete context cannot authorize passive completion. */}
 if(latest.trace&&!completeTraceProof)return null;
 return encodeFreshEvidence({...latest,trace:latest.trace??trace,...(completeTraceProof?{completeTraceProof}:{})});
}

export async function persistFreshUrgentTrace(database:Pool,selected:FreshCapturedReceipt,value:unknown,options:{walletRevision:string;token?:string;walletAddress?:string;outgoingEvidenceOnly?:boolean;inboundEvidenceOnly?:boolean;attemptFinish?:AttemptFinish}){
 const client=await database.connect();
 try{
  await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock(73621941)');
  const block=Number(freshInteger(selected.receipt.blockNumber)),hash=selected.receipt.blockHash.toLowerCase();
  const canonical=(await client.query('SELECT block_hash FROM fresh.recent_blocks WHERE block_number=$1 FOR SHARE',[block])).rows[0];
  if(canonical?.block_hash!==hash){await client.query('ROLLBACK');return false;}
  const owner=options.walletAddress??selected.transaction.from.toLowerCase();if(!selected.wallets.includes(owner))throw Error('urgent_trace_wallet_changed');
  const wallet=(await client.query('SELECT active,revision,monitoring_from_block,monitoring_to_block FROM fresh.wallets WHERE address=$1 FOR SHARE',[owner])).rows[0];
  if(!wallet?.active||String(wallet.revision)!==options.walletRevision||Number(wallet.monitoring_from_block)>block||wallet.monitoring_to_block!==null&&Number(wallet.monitoring_to_block)<block)throw Error('urgent_trace_wallet_changed');
  if(options.outgoingEvidenceOnly&&options.inboundEvidenceOnly)throw Error('urgent_trace_capture_mode_invalid');
  if(options.outgoingEvidenceOnly){if(owner!==selected.transaction.from.toLowerCase()||!freshUrgentOutgoingTraceCandidate(selected))throw Error('urgent_trace_outgoing_context_changed');}
  else if(options.inboundEvidenceOnly){if(!freshUrgentInboundDependencyTargets(selected).includes(owner)&&!freshUrgentPassiveTraceTargets(selected).some(target=>target.wallet===owner))throw Error('urgent_trace_inbound_context_changed');}
  else{const admission=options.token?await readFreshTokenAdmission(client,options.token,{blockNumber:block,lock:true}):null;
   if(!admission)throw Error('urgent_trace_token_changed');}
  const row=(await client.query('SELECT payload,wallet_addresses,decoder_status,position_dependency_addresses,position_dependency_proof FROM fresh.recent_evidence WHERE tx_hash=$1 AND block_hash=$2 FOR UPDATE',[selected.transaction.hash.toLowerCase(),hash])).rows[0];
  if(!row){await client.query('ROLLBACK');return false;}
  const latest=decodeFreshEvidence(row.payload);
  if([...row.wallet_addresses].sort().join(',')!==[...latest.wallets].sort().join(','))throw Error('urgent_trace_wallet_changed');
  if(options.attemptFinish&&!sameReservation(latest,options.attemptFinish.reservation))throw Error('urgent_trace_attempt_changed');
  let payload=mergeFreshUrgentTrace(selected,latest,value);
  if(options.attemptFinish){const merged=payload?decodeFreshEvidence(payload):latest;merged.urgentTraceAttempts=finishedAttempt(options.attemptFinish);freshUrgentTraceAttempts(merged);payload=encodeFreshEvidence(merged);}
  if(payload){const merged=decodeFreshEvidence(payload),dependencies=merged.trace&&validFreshCompleteCallTrace(merged,merged.trace)?freshPositionDependencies(merged):null;
   if(dependencies&&(row.position_dependency_proof&&row.position_dependency_proof!==dependencies.proofHash||row.position_dependency_addresses&&JSON.stringify([...row.position_dependency_addresses].sort())!==JSON.stringify(dependencies.addresses)))throw Error('urgent_trace_dependency_conflict');
   const cost=row.decoder_status==='done'&&hasCompleteTrace(merged)?taxReceiptNativeCost(latest,owner):null;
   if(cost!==null&&freshNativeDelta(merged.trace!,owner)!==-cost){const now=new Date(),reason='native_payout_mismatch',first=latest.decodeDiagnostics?.firstFailure??{version:1 as const,at:now.toISOString(),reasons:[reason]};
    merged.decodeDiagnostics={version:1,valuationReasons:[...new Set([reason,...(latest.decodeDiagnostics?.valuationReasons??[])])].slice(0,64),firstFailure:first};payload=encodeFreshEvidence(merged);
    await client.query("UPDATE fresh.recent_evidence SET decoder_status='repair',last_error='native_payout_mismatch' WHERE tx_hash=$1 AND block_hash=$2",[selected.transaction.hash.toLowerCase(),hash]);
    await client.query(`INSERT INTO fresh.jobs(id,kind,reference,priority,due_at,last_error,progress)VALUES($1,'decode_receipt',$2,80,$3,$4,$5::jsonb) ON CONFLICT(kind,reference)DO UPDATE SET state='pending',due_at=least(fresh.jobs.due_at,EXCLUDED.due_at),last_error=EXCLUDED.last_error,updated_at=clock_timestamp()`,['decode:'+selected.transaction.hash.toLowerCase()+':'+hash,selected.transaction.hash.toLowerCase()+':'+hash,now,reason,JSON.stringify({firstFailure:first})]);
   }
   await client.query('UPDATE fresh.recent_evidence SET payload=$3,position_dependency_addresses=COALESCE($4,position_dependency_addresses),position_dependency_proof=COALESCE($5,position_dependency_proof) WHERE tx_hash=$1 AND block_hash=$2',[selected.transaction.hash.toLowerCase(),hash,payload,dependencies?.addresses??null,dependencies?.proofHash??null]);
   if(row.decoder_status==='done'&&hasCompleteTrace(merged)&&(freshVerifiedAirdropClaimCandidate(merged)||freshPaidCreationPurchaseCandidate(merged))){
    // These exact supported methods need the newly captured tree even when a
    // quick earlier interpretation already finished. Revalidate normally;
    // acquisition policy, kind and money remain the decoder's responsibility.
    await client.query("UPDATE fresh.recent_evidence SET decoder_status='pending' WHERE tx_hash=$1 AND block_hash=$2 AND decoder_status='done'",[selected.transaction.hash.toLowerCase(),hash]);
    await client.query(`INSERT INTO fresh.jobs(id,kind,reference,priority,state,due_at)VALUES($1,'decode_receipt',$2,80,'pending',clock_timestamp())
     ON CONFLICT(kind,reference)DO UPDATE SET state='pending',due_at=least(fresh.jobs.due_at,EXCLUDED.due_at),priority=greatest(fresh.jobs.priority,EXCLUDED.priority),updated_at=clock_timestamp()
     WHERE fresh.jobs.lease_until IS NULL OR fresh.jobs.lease_until<=clock_timestamp()`,['decode:'+selected.transaction.hash.toLowerCase()+':'+hash,selected.transaction.hash.toLowerCase()+':'+hash]);
   }}
  await client.query('COMMIT');return Boolean(payload);
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}

/** Own loader/queue, independent of slow ordinary repair decoding. Every call
 * settles before the next pass; no detached traces accumulate after timeout. */
export function createFreshUrgentTraceCapture(database:Pool,rpc:Rpc,load:(tx:FreshTransaction,signal?:AbortSignal)=>Promise<FreshCallTrace|null>){
 let running=false;
 return async(options:{now?:Date;signal?:AbortSignal}={})=>{
  const empty={receipts:0,attempted:0,saved:0,unavailable:0};if(running||options.signal?.aborted)return{...empty,yielded:true};running=true;
  const start=performance.now(),now=options.now??new Date(),clock=()=>now.getTime()+Math.max(0,performance.now()-start);
  try{
   const capture=(await database.query(`SELECT c.block_number,c.value,b.occurred_at,h.value->>'ok' AS capture_ok FROM fresh.checkpoints c
    JOIN fresh.recent_blocks b ON b.block_number=c.block_number AND b.block_hash=c.block_hash JOIN fresh.checkpoints h ON h.key='health:capture' WHERE c.key='capture'`)).rows[0];
   if(!capture||capture.capture_ok!=='true'||clock()-new Date(capture.occurred_at).getTime()>20_000)return{...empty,yielded:true};
   const head=Number(freshInteger(await rpc<string>('eth_blockNumber',[])));
   if(head-6-Number(capture.block_number)>32)return{...empty,yielded:true};
   const rows=(await database.query(`SELECT e.tx_hash,e.block_hash,e.block_number,e.transaction_index,e.wallet_addresses,e.payload,e.decoder_status,b.parent_hash,b.occurred_at
    FROM fresh.recent_evidence e JOIN fresh.recent_blocks b USING(block_number,block_hash)
    WHERE e.decoder_status IN('pending','repair','done') AND b.occurred_at>=$1 AND b.occurred_at<=$2
    ORDER BY CASE e.decoder_status WHEN 'done' THEN 1 ELSE 0 END,e.block_number DESC,e.transaction_index DESC,e.tx_hash LIMIT 16`,[new Date(clock()-FRESH_URGENT_TRACE_MAX_AGE_MS),new Date(clock()+5_000)])).rows;
   const candidates=rows.flatMap(row=>{
    const entry=decodeFreshEvidence(row.payload),nativeTargets=freshUrgentTraceTargets(entry),outgoing=freshUrgentOutgoingTraceCandidate(entry),passive=outgoing?[]:freshUrgentPassiveTraceTargets(entry),inbound=outgoing?[]:freshUrgentInboundDependencyTargets(entry),targets=outgoing?nativeTargets:passive.map(candidate=>candidate.token);if(!outgoing&&!targets.length&&!inbound.length||!attemptAvailable(entry,clock()))return[];
    // Dependency evidence must survive a fast ordinary incoming interpretation.
    // This keeps the same method-call eligibility and grants no financial approval.
    const completedDependency=(inbound.length>0||passive.length>0)&&typeof entry.transaction.input==='string'&&/^0x(?:[\da-f]{2}){4,}$/i.test(entry.transaction.input);
    if(row.decoder_status==='done'&&!completedDependency&&taxReceiptNativeCost(entry)===null&&!freshVerifiedAirdropClaimCandidate(entry)&&!freshPaidCreationPurchaseCandidate(entry))return[];
    const walletAddress=outgoing?entry.transaction.from.toLowerCase():passive[0]?.wallet??inbound[0];
    const block=Number(row.block_number),hash=row.block_hash;
    if(entry.transaction.hash.toLowerCase()!==row.tx_hash||entry.receipt.transactionHash.toLowerCase()!==row.tx_hash||entry.receipt.blockHash.toLowerCase()!==hash
     ||Number(freshInteger(entry.transaction.blockNumber))!==block||Number(freshInteger(entry.receipt.blockNumber))!==block||entry.transaction.blockHash.toLowerCase()!==hash
     ||Number(freshInteger(entry.transaction.transactionIndex))!==Number(row.transaction_index)||[...row.wallet_addresses].sort().join(',')!==[...entry.wallets].sort().join(','))throw Error('urgent_trace_receipt_invalid');
    validateFreshReceipt(entry.receipt,entry.transaction,{number:entry.receipt.blockNumber,hash,parentHash:row.parent_hash,timestamp:`0x${Math.floor(new Date(row.occurred_at).getTime()/1000).toString(16)}`,transactions:[]}as FreshBlock);
    const attemptCount=freshUrgentTraceAttempts(entry)?.count??0;
    return outgoing?[{row,entry,targets,walletAddress,passive:false,inbound:false,priority:(nativeTargets.length?0:1)as 0|1|2|3,attemptCount}]:[
     ...[...new Set(passive.map(candidate=>candidate.wallet))].map(walletAddress=>({row,entry,targets:passive.filter(candidate=>candidate.wallet===walletAddress).map(candidate=>candidate.token),walletAddress,passive:true,inbound:false,priority:2 as 0|1|2|3,attemptCount})),
     ...inbound.map(walletAddress=>({row,entry,targets:[]as string[],walletAddress,passive:false,inbound:true,priority:3 as 0|1|2|3,attemptCount}))];
   });
   candidates.sort((a,b)=>a.priority-b.priority||a.attemptCount-b.attemptCount||Number(a.row.block_number)-Number(b.row.block_number)||Number(a.row.transaction_index)-Number(b.row.transaction_index));
   if(!candidates.length)return empty;
   const wallets=[...new Set(candidates.map(candidate=>candidate.walletAddress))];
   const active=await database.query('SELECT address,revision,monitoring_from_block,monitoring_to_block FROM fresh.wallets WHERE address=ANY($1::text[]) AND active',[wallets]);
   for(const candidate of candidates){
    const{row,entry}=candidate,age=clock()-new Date(row.occurred_at).getTime();if(options.signal?.aborted||age<0||age>FRESH_URGENT_TRACE_MAX_AGE_MS)continue;
    const block=Number(row.block_number);
    const wallet=active.rows.find(wallet=>wallet.address===candidate.walletAddress&&Number(wallet.monitoring_from_block)<=block&&(wallet.monitoring_to_block===null||Number(wallet.monitoring_to_block)>=block));
    if(!wallet)continue;
    // The independent SSH adapter has no queued jobs, but host-key verification
    // can still wait on local I/O. Expire its signal at the receipt's remaining
    // age budget so that verification cannot start an already-old request.
    const attemptContext:AttemptContext={walletRevision:String(wallet.revision),walletAddress:candidate.walletAddress,outgoingEvidenceOnly:!candidate.passive&&!candidate.inbound,inboundEvidenceOnly:candidate.passive||candidate.inbound};
    const reservation=await persistTraceAttempt(database,entry,attemptContext,{start:{at:new Date(clock()),ageMs:age,priority:candidate.priority,candidateCount:candidates.length}});if(!reservation)continue;
    const started=clock(),remaining=FRESH_URGENT_TRACE_MAX_AGE_MS-(started-new Date(row.occurred_at).getTime());
    const finish=(outcome:AttemptFinish['outcome'])=>({reservation,at:new Date(clock()),durationMs:clock()-started,outcome});
    if(options.signal?.aborted||remaining<=0){await persistTraceAttempt(database,entry,attemptContext,{finish:finish(options.signal?.aborted?'aborted':'expired')});return{receipts:1,attempted:0,saved:0,unavailable:1};}
    const deadline=new AbortController(),timer=setTimeout(()=>deadline.abort(),Math.max(1,remaining));
    const signal=options.signal?AbortSignal.any([options.signal,deadline.signal]):deadline.signal;
    let trace:FreshCallTrace|null,transport=false;try{trace=await load(entry.transaction,signal);}catch(error){transport=error instanceof Error&&/^(?:trace_timeout|rpc_timeout|ECONNRESET|ETIMEDOUT|EPIPE|transport_error)$/.test(error.message);await persistTraceAttempt(database,entry,attemptContext,{finish:finish(options.signal?.aborted?'aborted':deadline.signal.aborted?'expired':transport?'transport_error':'rejected')});if(!transport&&!signal.aborted)throw error;return{receipts:1,attempted:1,saved:0,unavailable:1};}finally{clearTimeout(timer);}
    if(!trace||signal.aborted||clock()-new Date(row.occurred_at).getTime()>=FRESH_URGENT_TRACE_MAX_AGE_MS){await persistTraceAttempt(database,entry,attemptContext,{finish:finish(options.signal?.aborted?'aborted':deadline.signal.aborted||clock()-new Date(row.occurred_at).getTime()>=FRESH_URGENT_TRACE_MAX_AGE_MS?'expired':'unavailable')});return{receipts:1,attempted:1,saved:0,unavailable:1};}
    try{const saved=await persistFreshUrgentTrace(database,entry,trace,{...attemptContext,attemptFinish:finish('saved')});return{receipts:1,attempted:1,saved:saved?1:0,unavailable:0};}
    catch(error){await persistTraceAttempt(database,entry,attemptContext,{finish:finish('rejected')});throw error;}
   }
   return empty;
  }finally{running=false;}
 };
}
