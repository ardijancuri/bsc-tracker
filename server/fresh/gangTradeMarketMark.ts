import{createHash}from'node:crypto';
import{Interface}from'ethers';
import type{PoolClient}from'pg';
import{WBNB}from'../launchpad.js';
import{TRUSTED_QUOTE_FEEDS}from'../nodeMarketProtocols.js';
import{FreshRational}from'./accounting.js';
import{freshQuoteUsd}from'./pricing.js';
import{createFreshStateEvidenceRpc}from'./stateEvidence.js';
import{freshPendingGangTrade,FRESH_GANG_PAIR,type FreshPendingTrade}from'./pendingTrades.js';
import{recoverFreshGangHistoricalMetadata,type FreshGangMetadataInput}from'./gangMetadata.js';
import{recoverFreshHistoricalQuote,type FreshHistoricalQuoteEvidence}from'./historicalQuote.js';
import{freshInteger,validateFreshReceipt,type FreshCapturedReceipt,type FreshBlock}from'./capture.js';
import type{FreshTokenAdmission}from'./tracking.js';
import{GANG_TOKEN_ADDRESS}from'./tracking.js';
import{freshImportedMetadataMatchesState}from'./importedMetadata.js';
import type{FreshPriceBlock}from'./pricing.js';
import{transferTopic}from'../swap.js';

const abi=new Interface(['event Sync(uint112 reserve0,uint112 reserve1)','event Swap(address indexed sender,uint256 amount0In,uint256 amount1In,uint256 amount0Out,uint256 amount1Out,address indexed to)']);
const sha=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sameBlock=(a:FreshPriceBlock,b:FreshPriceBlock)=>a.number===b.number&&a.hash===b.hash&&a.timestamp===b.timestamp;
export interface FreshGangTradeMarketMark {
 version:1;kind:'post_trade_pool_sync';source:'node';eventId:string;executionKey:string;walletAddress:string;tokenAddress:string;transactionHash:string;
 blockNumber:string;blockHash:string;observedAt:string;rawQuantity:string;side:'buy'|'sell';priceUsd:string;marketCapUsd:string;
 evidence:{pair:typeof FRESH_GANG_PAIR;syncLogIndex:number;swapLogIndex:number;reserveTokenRaw:string;reserveBnbRaw:string;supplyRaw:string;bnbUsd:string;
  originalEvidenceHash:string;metadataProof:unknown;feedProof:unknown;maxEvidenceBlock:number};
}
const stable=(value:unknown):string=>JSON.stringify(value,(_k,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))):v);
const approved=new WeakMap<FreshGangTradeMarketMark,string>();
const routedMarkSelectors:Record<string,string>={
 '0x01a21c857a3219991fba2b1a2824b1b758966b54':'0xa21413d8',
 '0xb300000b72deaeb607a12d5f54773d1c19c7028d':'0x810c705b',
};
type MarkTrade=Pick<FreshPendingTrade,'id'|'executionKey'|'walletAddress'|'tokenAddress'|'transactionHash'|'blockNumber'|'blockHash'|'rawQuantity'|'kind'>;
/** Display-only router conservation. This does not admit a pending trade or
 * establish its settlement, acquisition cost, fees or accounting eligibility. */
function routedGangMarketTrade(entry:FreshCapturedReceipt,block:FreshPriceBlock,admission:FreshTokenAdmission|null):MarkTrade|null{
 try{
  const tx=entry.transaction,wallet=tx.from,router=tx.to;
  if(admission?.kind!=='preexisting'||admission.permission.tokenAddress!==GANG_TOKEN_ADDRESS||!admission.permission.active||admission.permission.chainId!==56
   ||block.number<admission.fromBlock||Date.parse(block.timestamp)<Date.parse(admission.history?.historyFromTime??admission.permission.startTime)
   ||!router||wallet===router||!/^0x[0-9a-f]{40}$/.test(wallet)||!entry.wallets.includes(wallet)||entry.launchRepair||entry.receipt.status!=='0x1'
   ||!['0x0','0x1','0x2'].includes(String(tx.type??'0x0'))||tx.authorizationList!==undefined||tx.chainId!==undefined&&freshInteger(tx.chainId)!==56n
   ||!routedMarkSelectors[router]||typeof tx.input!=='string'||!tx.input.startsWith(routedMarkSelectors[router])||!/^0x(?:[0-9a-f]{2})*$/.test(tx.input)||tx.input.length>65538)return null;
  validateFreshReceipt(entry.receipt,tx,{number:'0x'+block.number.toString(16),hash:block.hash,parentHash:block.hash,
   timestamp:'0x'+Math.floor(Date.parse(block.timestamp)/1000).toString(16),transactions:[tx]}as FreshBlock);
  const swaps=entry.receipt.logs.filter(l=>l.address===FRESH_GANG_PAIR&&l.topics[0]===abi.getEvent('Swap')!.topicHash);
  if(swaps.length!==1)return null;const swap=abi.parseLog(swaps[0]);if(!swap)return null;const swapEncoding=abi.encodeEventLog(swap.fragment,swap.args);
  if(swapEncoding.data!==swaps[0].data||JSON.stringify(swapEncoding.topics)!==JSON.stringify(swaps[0].topics))return null;
  const[a0in,a1in,a0out,a1out]=[swap.args.amount0In,swap.args.amount1In,swap.args.amount0Out,swap.args.amount1Out].map(BigInt);
  const side=a0in>0n&&a1out>0n&&a1in===0n&&a0out===0n?'sell':a1in>0n&&a0out>0n&&a0in===0n&&a1out===0n?'buy':null;
  if(!side||side==='buy'&&String(swap.args.to).toLowerCase()!==router||router==='0x01a21c857a3219991fba2b1a2824b1b758966b54'&&side!=='sell')return null;
  const logs=entry.receipt.logs.filter(l=>l.address===GANG_TOKEN_ADDRESS&&l.topics[0]===transferTopic);if(logs.length!==2)return null;
  const legs=logs.map(l=>{if(l.topics.length!==3||!l.topics.slice(1).every(t=>/^0x0{24}[0-9a-f]{40}$/.test(t))||!/^0x[0-9a-f]{64}$/.test(l.data))throw Error('route_transfer_invalid');
   return{from:'0x'+l.topics[1].slice(-40),to:'0x'+l.topics[2].slice(-40),raw:BigInt(l.data),index:Number(freshInteger(l.logIndex))};});
  const raw=side==='buy'?a0out:a0in,expected=side==='buy'?[FRESH_GANG_PAIR,router,wallet]:[wallet,router,FRESH_GANG_PAIR];
  if(legs.some(l=>l.raw!==raw||!Number.isSafeInteger(l.index))||legs[0].index>=legs[1].index
   ||legs[0].from!==expected[0]||legs[0].to!==expected[1]||legs[1].from!==expected[1]||legs[1].to!==expected[2]
   ||side==='sell'&&legs[1].index>=Number(freshInteger(swaps[0].logIndex)))return null;
  const walletLog=side==='buy'?legs[1]:legs[0],base=`${block.hash}:${tx.hash}:${wallet}:transaction:0`,executionKey=`${base}:${GANG_TOKEN_ADDRESS}:${side}:${walletLog.index}`;
  return{id:createHash('sha256').update(executionKey).digest('hex'),executionKey,walletAddress:wallet,tokenAddress:GANG_TOKEN_ADDRESS,transactionHash:tx.hash,
   blockNumber:String(block.number),blockHash:block.hash,rawQuantity:raw.toString(),kind:side};
 }catch{return null;}
}
/** A market mark is distinct from settled trade proceeds and FIFO profit.
 * Both inputs are genuine historical observations. No chart candle, current
 * token quote, symbol peg or default decimals can enter this computation. */
export async function recoverFreshGangTradeMarketMark(options:{entry:FreshCapturedReceipt;metadata?:FreshGangMetadataInput;block?:FreshPriceBlock;
 canonicalHeader?:(number:number)=>Promise<FreshPriceBlock|null>;admission:FreshTokenAdmission|null;historicalBnbFeed?:FreshHistoricalQuoteEvidence}):Promise<FreshGangTradeMarketMark|null>{
 try{
  const{entry,metadata:input}=options,block=input?.target??options.block,canonicalHeader=input?.canonicalHeader??options.canonicalHeader;if(!block||!canonicalHeader)return null;
  const pending=freshPendingGangTrade(entry,block,options.admission)??routedGangMarketTrade(entry,block,options.admission),canonical=await canonicalHeader(block.number);
  if(!pending||!canonical||!sameBlock(canonical,block))return null;
  const unavailable=async()=>{throw Error('gang_market_mark_retained_evidence_missing');};
  const state=createFreshStateEvidenceRpc(unavailable,block,entry.stateEvidence);if(state.rejectedPrior)return null;
  const calls=state.snapshot()?.calls??[],precision=calls.find(c=>c.to===GANG_TOKEN_ADDRESS&&c.data==='0x313ce567'),supplyCall=calls.find(c=>c.to===GANG_TOKEN_ADDRESS&&c.data==='0x18160ddd');
  let supply:string|null=null,metadataProof:unknown;
  if(precision&&supplyCall&&/^0x[0-9a-f]{64}$/.test(precision.result)&&BigInt(precision.result)===18n&&/^0x[0-9a-f]{64}$/.test(supplyCall.result)&&BigInt(supplyCall.result)>0n){
   supply=BigInt(supplyCall.result).toString();metadataProof={kind:'same_block_raw_metadata',block,supplyObservation:'block_end',calls:[precision,supplyCall]};
  }else{const recovered=input?await recoverFreshGangHistoricalMetadata(input):null;
   if(!recovered||!freshImportedMetadataMatchesState(recovered.metadata,entry.stateEvidence))return null;supply=recovered.metadata.supplyRaw;metadataProof=recovered.proof;}
  if(!supply)return null;
  const pairLogs=entry.receipt.logs.filter(log=>log.address===FRESH_GANG_PAIR),swaps=pairLogs.filter(log=>log.topics[0]===abi.getEvent('Swap')!.topicHash),syncs=pairLogs.filter(log=>log.topics[0]===abi.getEvent('Sync')!.topicHash);
  if(swaps.length!==1||syncs.length!==1||pairLogs.indexOf(syncs[0])+1!==pairLogs.indexOf(swaps[0]))return null;
  const sync=abi.parseLog(syncs[0]);if(!sync)return null;const encoded=abi.encodeEventLog(sync.fragment,sync.args);
  if(encoded.data!==syncs[0].data||JSON.stringify(encoded.topics)!==JSON.stringify(syncs[0].topics)||freshInteger(syncs[0].logIndex)>=freshInteger(swaps[0].logIndex))return null;
  const reserveToken=BigInt(sync.args.reserve0),reserveBnb=BigInt(sync.args.reserve1);if(reserveToken<=0n||reserveBnb<=0n)return null;
  let bnbUsd:string,feedProof:unknown;
  try{bnbUsd=await freshQuoteUsd(WBNB,{rpc:state.rpc,block});feedProof={kind:'same_block_raw_feed',block,stateEvidenceSha256:sha(state.snapshot()),calls:state.snapshot()?.calls.filter(c=>c.to===TRUSTED_QUOTE_FEEDS[WBNB].feed)};}
  catch{const prior=options.historicalBnbFeed;if(!prior||prior.tokenAddress!==WBNB||!sameBlock(prior.target,block))return null;
   const anchor=await canonicalHeader(prior.anchor.number);if(!anchor||!sameBlock(anchor,prior.anchor))return null;
   const validated=await recoverFreshHistoricalQuote({rpc:unavailable,tokenAddress:WBNB,target:block,anchor:prior.anchor,prior});bnbUsd=validated.priceUsd;feedProof=validated;}
  const rate=FreshRational.parse(bnbUsd);if(rate.n<=0n)return null;
  // Raw supply and token reserve share units; their decimals cancel. BNB has
  // verified native18 precision, independent from token metadata/spot USD.
  const mcap=new FreshRational(reserveBnb*BigInt(supply),reserveToken*10n**18n).mul(rate),price=new FreshRational(reserveBnb,reserveToken).mul(rate);
  const derivedMetadata=(metadataProof as{kind?:string}).kind==='gang_exact_immutable_metadata',historicalFeed=(feedProof as{kind?:string}).kind==='historical_oracle_round';
  const mark:FreshGangTradeMarketMark={version:1,kind:'post_trade_pool_sync',source:'node',eventId:pending.id,executionKey:pending.executionKey,walletAddress:pending.walletAddress,tokenAddress:pending.tokenAddress,
   transactionHash:pending.transactionHash,blockNumber:pending.blockNumber,blockHash:pending.blockHash,observedAt:block.timestamp,rawQuantity:pending.rawQuantity,side:pending.kind,priceUsd:price.decimal(),marketCapUsd:mcap.decimal(),
   evidence:{pair:FRESH_GANG_PAIR,syncLogIndex:Number(freshInteger(syncs[0].logIndex)),swapLogIndex:Number(freshInteger(swaps[0].logIndex)),reserveTokenRaw:String(reserveToken),reserveBnbRaw:String(reserveBnb),supplyRaw:supply,bnbUsd,
    originalEvidenceHash:sha([entry.transaction,entry.receipt]),metadataProof,feedProof,maxEvidenceBlock:Math.max(block.number,derivedMetadata?input?.runtime.block.number??0:0,derivedMetadata?input?.after?.block.number??0:0,historicalFeed?options.historicalBnbFeed?.anchor.number??0:0)}};
  approved.set(mark,stable(mark));return Object.freeze(mark);
 }catch{return null;}
}

/** Caller holds decoder canonical/financial locks. Only the authenticated
 * display observation changes; quantities, cash flows, FIFO and fees do not. */
export async function persistFreshGangTradeMarketMark(client:Pick<PoolClient,'query'>,mark:FreshGangTradeMarketMark){
 if(approved.get(mark)!==stable(mark))throw Error('gang_market_mark_not_validated');
 for(const table of['financial_events','pending_trades']){
  const row=(await client.query(`SELECT * FROM fresh.${table} WHERE id=$1 AND execution_key=$2 AND canonical FOR UPDATE`,[mark.eventId,mark.executionKey])).rows[0];
  if(!row)continue;
  if(row.wallet_address!==mark.walletAddress||row.token_address!==mark.tokenAddress||row.transaction_hash!==mark.transactionHash||row.block_hash!==mark.blockHash
   ||String(row.block_number)!==mark.blockNumber||new Date(row.occurred_at).toISOString()!==mark.observedAt||row.kind!==mark.side
   ||table==='pending_trades'&&row.raw_quantity!==mark.rawQuantity
   ||table==='financial_events'&&FreshRational.parse(row.quantity).compare(new FreshRational(BigInt(mark.rawQuantity),10n**18n))!==0)throw Error('gang_market_mark_context_changed');
  if(row.market_cap_usd!=null){if(row.market_cap_usd!==mark.marketCapUsd)throw Error('gang_market_mark_conflict');continue;}
  await client.query(`UPDATE fresh.${table} SET market_cap_usd=$2,market_mark=$3::jsonb WHERE id=$1 AND canonical AND market_cap_usd IS NULL`,[mark.eventId,mark.marketCapUsd,JSON.stringify(mark)]);
 }
}
export async function invalidateFreshTradeMarketMarks(client:Pick<PoolClient,'query'>,ancestor:number){
 if(!Number.isSafeInteger(ancestor)||ancestor<0)throw Error('gang_market_mark_ancestor_invalid');
 for(const table of['financial_events','pending_trades'])await client.query(`UPDATE fresh.${table} SET market_cap_usd=NULL,
   market_mark=market_mark||'{"canonicalInvalid":true}'::jsonb WHERE market_mark IS NOT NULL AND
   (block_number>$1 OR CASE WHEN market_mark#>>'{evidence,maxEvidenceBlock}' ~ '^[0-9]{1,16}$'
     THEN (market_mark#>>'{evidence,maxEvidenceBlock}')::bigint>$1 ELSE false END)`,[ancestor]);
}
