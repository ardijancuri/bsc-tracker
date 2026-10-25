import{createHash}from'node:crypto';
import{Interface,formatUnits}from'ethers';
import type{PoolClient}from'pg';
import{nativeSellProceeds,transferTopic}from'../swap.js';
import{WBNB}from'../launchpad.js';
import{decodeFreshEvidence,freshAddress,freshHash,freshInteger,validateFreshReceipt,type FreshCapturedReceipt,type FreshBlock}from'./capture.js';
import{GANG_TOKEN_ADDRESS,readFreshTokenAdmission,type FreshTokenAdmission}from'./tracking.js';

/** Authenticated PCS V2 GANG/WBNB pair. This narrow observation path does not
 * approve another token, a market price, token precision or an opening cost. */
export const FRESH_GANG_PAIR='0x0bd5ded695d61c2db15c703c345d57e039fd0b6d';
const swapAbi=new Interface(['event Swap(address indexed sender,uint256 amount0In,uint256 amount1In,uint256 amount0Out,uint256 amount1Out,address indexed to)']);
const topicAddress=(value:unknown)=>typeof value==='string'&&/^0x0{24}[0-9a-f]{40}$/.test(value)?'0x'+value.slice(-40):null;
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export interface FreshPendingTrade{
 id:string;executionKey:string;walletAddress:string;tokenAddress:typeof GANG_TOKEN_ADDRESS;kind:'buy'|'sell';rawQuantity:string;
 blockNumber:string;blockHash:string;transactionHash:string;transactionIndex:number;executionIndex:0;logIndex:number;
 occurredAt:string;observedLive:boolean;quoteAddress:string|null;quoteSymbol:string|null;quoteAmount:string|null;evidenceHash:string;admissionDigest:string;
 nativeFeeWei:string;feeKey:string;
}
type Block={number:number;hash:string;timestamp:string};

/** Raw quantities remain integers. A proven swap can be visible while exact
 * historical precision or settlement is unavailable; it never enters FIFO. */
export function freshPendingGangTrade(entry:FreshCapturedReceipt,block:Block,admission:FreshTokenAdmission|null):FreshPendingTrade|null{
 try{
  if(admission?.kind!=='preexisting'||admission.permission.tokenAddress!==GANG_TOKEN_ADDRESS||admission.permission.chainId!==56
   ||!admission.permission.active||block.number<admission.fromBlock||Date.parse(block.timestamp)<Date.parse(admission.history?.historyFromTime??admission.permission.startTime))return null;
  const tx=entry.transaction,wallet=freshAddress(tx.from),router=freshAddress(tx.to);
  if(!wallet||!router||wallet===router||!entry.wallets.includes(wallet)||entry.receipt.status!=='0x1'||entry.launchRepair
   ||!['0x0','0x1','0x2'].includes(String(tx.type??'0x0'))||tx.authorizationList!==undefined
   ||typeof tx.input!=='string'||!/^0x(?:[0-9a-f]{2})*$/.test(tx.input)||!freshHash(block.hash)||!Number.isSafeInteger(block.number)
   ||tx.chainId!==undefined&&freshInteger(tx.chainId)!==56n||!Number.isFinite(Date.parse(block.timestamp))||new Date(block.timestamp).toISOString()!==block.timestamp)return null;
  validateFreshReceipt(entry.receipt,tx,{number:'0x'+block.number.toString(16),hash:block.hash,parentHash:block.hash,
   timestamp:'0x'+Math.floor(Date.parse(block.timestamp)/1000).toString(16),transactions:[tx]}as FreshBlock);
  const swaps=entry.receipt.logs.filter(log=>log.address===FRESH_GANG_PAIR&&log.topics[0]===swapAbi.getEvent('Swap')!.topicHash);
  if(swaps.length!==1)return null;const swap=swapAbi.parseLog(swaps[0]);if(!swap||swap.name!=='Swap')return null;
  const encoded=swapAbi.encodeEventLog(swap.fragment,swap.args);if(encoded.data!==swaps[0].data||JSON.stringify(encoded.topics)!==JSON.stringify(swaps[0].topics))return null;
  const[a0in,a1in,a0out,a1out]=[swap.args.amount0In,swap.args.amount1In,swap.args.amount0Out,swap.args.amount1Out].map(BigInt);
  const side=a0in>0n&&a1out>0n&&a1in===0n&&a0out===0n?'sell':a1in>0n&&a0out>0n&&a0in===0n&&a1out===0n?'buy':null;if(!side)return null;
  const transfers=entry.receipt.logs.filter(log=>log.address===GANG_TOKEN_ADDRESS&&log.topics[0]===transferTopic);
  if(transfers.length!==1)return null;const transfer=transfers[0];
  if(transfer.topics.length!==3||!/^0x[0-9a-f]{64}$/.test(transfer.data))return null;
  const from=topicAddress(transfer.topics[1]),to=topicAddress(transfer.topics[2]),raw=BigInt(transfer.data);
  if(raw<=0n||side==='sell'&&(from!==wallet||to!==FRESH_GANG_PAIR||raw!==a0in)
   ||side==='buy'&&(from!==FRESH_GANG_PAIR||to!==wallet||raw!==a0out))return null;
  // Exactly one ordinary sender execution, one pinned pair Swap and one
  // matching target Transfer. Repeated smart operations are never collapsed.
  const executionIndex=0 as const,logIndex=Number(freshInteger(transfer.logIndex)),transactionIndex=Number(freshInteger(tx.transactionIndex));
  if(!Number.isSafeInteger(logIndex)||!Number.isSafeInteger(transactionIndex))return null;
  const base=`${block.hash}:${tx.hash}:${wallet}:transaction:0`,executionKey=`${base}:${GANG_TOKEN_ADDRESS}:${side}:${logIndex}`;
  const nativeFeeWei=freshInteger(entry.receipt.gasUsed)*freshInteger(entry.receipt.effectiveGasPrice??tx.gasPrice);
  if(nativeFeeWei<0n||nativeFeeWei>=(1n<<256n))return null;
  const native=side==='sell'?nativeSellProceeds(wallet,raw,entry.receipt.logs,router,GANG_TOKEN_ADDRESS):null;
  return{id:createHash('sha256').update(executionKey).digest('hex'),executionKey,walletAddress:wallet,tokenAddress:GANG_TOKEN_ADDRESS,kind:side,rawQuantity:raw.toString(),
   blockNumber:String(block.number),blockHash:block.hash,transactionHash:tx.hash,transactionIndex,executionIndex,logIndex,occurredAt:block.timestamp,
   observedLive:!entry.historicalWallets?.includes(wallet),quoteAddress:native!==null?WBNB:null,quoteSymbol:native!==null?'BNB':null,
   quoteAmount:native!==null?formatUnits(native,18):null,evidenceHash:digest([entry.transaction,entry.receipt]),admissionDigest:admission.admissionDigest,nativeFeeWei:nativeFeeWei.toString(),feeKey:`${base}:fee`};
 }catch{return null;}
}

/** Caller owns the ordinary decoder financial/canonical/CAS locks. Re-read
 * the original receipt and current permission here as an independent final
 * binding. Only one small unresolved observation is stored, never a response. */
export async function persistFreshPendingTrades(client:PoolClient,pending:readonly FreshPendingTrade[],now:Date){
 for(const proposed of pending){
  const admission=await readFreshTokenAdmission(client,proposed.tokenAddress,{blockNumber:Number(proposed.blockNumber),lock:true});
  if(admission?.kind!=='preexisting'||admission.admissionDigest!==proposed.admissionDigest)throw Error('pending_trade_admission_changed');
  const row=(await client.query(`SELECT e.payload,e.expires_at,b.occurred_at FROM fresh.recent_evidence e JOIN fresh.recent_blocks b USING(block_number,block_hash)
   WHERE e.tx_hash=$1 AND e.block_hash=$2 AND e.block_number=$3 FOR SHARE OF e,b`,[proposed.transactionHash,proposed.blockHash,proposed.blockNumber])).rows[0];
  if(!row||new Date(row.expires_at).getTime()<=now.getTime())throw Error('pending_trade_evidence_unavailable');
  const entry=decodeFreshEvidence(row.payload),actual=freshPendingGangTrade(entry,{number:Number(proposed.blockNumber),hash:proposed.blockHash,timestamp:new Date(row.occurred_at).toISOString()},admission);
  if(!actual||JSON.stringify(actual)!==JSON.stringify(proposed))throw Error('pending_trade_context_changed');
  const wallet=(await client.query('SELECT active,monitoring_from_block,monitoring_to_block FROM fresh.wallets WHERE address=$1 FOR SHARE',[actual.walletAddress])).rows[0];
  if(!wallet?.active||Number(wallet.monitoring_from_block)>Number(actual.blockNumber)||wallet.monitoring_to_block!=null&&Number(wallet.monitoring_to_block)<Number(actual.blockNumber))throw Error('pending_trade_wallet_changed');
  const resolved=(await client.query(`SELECT id FROM fresh.financial_events WHERE canonical AND kind IN('buy','sell') AND
   (id=$1 OR execution_key=$2 OR(transaction_hash=$3 AND wallet_address=$4 AND token_address=$5 AND execution_index=$6 AND kind=$7)) LIMIT 1`,
   [actual.id,actual.executionKey,actual.transactionHash,actual.walletAddress,actual.tokenAddress,actual.executionIndex,actual.kind])).rows.length>0;
  if(resolved)continue;
  // Current identity may arrive separately. No current precision or supply is
  // substituted for this historical execution's missing proof.
  await client.query("INSERT INTO fresh.tokens(address,launch_status) VALUES($1,'preexisting') ON CONFLICT(address) DO NOTHING",[GANG_TOKEN_ADDRESS]);
  const previous=(await client.query('SELECT * FROM fresh.pending_trades WHERE id=$1 OR execution_key=$2 FOR UPDATE',[actual.id,actual.executionKey])).rows[0];
  if(previous&&(previous.id!==actual.id||previous.execution_key!==actual.executionKey||previous.wallet_address!==actual.walletAddress||previous.token_address!==actual.tokenAddress
   ||previous.kind!==actual.kind||previous.raw_quantity!==actual.rawQuantity||String(previous.block_number)!==actual.blockNumber||previous.block_hash!==actual.blockHash
   ||previous.transaction_hash!==actual.transactionHash||Number(previous.transaction_index)!==actual.transactionIndex||Number(previous.execution_index)!==actual.executionIndex||Number(previous.log_index)!==actual.logIndex
   ||new Date(previous.occurred_at).toISOString()!==actual.occurredAt||previous.evidence_hash!==actual.evidenceHash
   ||previous.quote_address!==actual.quoteAddress||previous.quote_symbol!==actual.quoteSymbol||previous.quote_amount!==actual.quoteAmount
   ||previous.native_fee_wei!=null&&previous.native_fee_wei!==actual.nativeFeeWei||previous.fee_key!=null&&previous.fee_key!==actual.feeKey))throw Error('pending_trade_conflict');
  await client.query(`INSERT INTO fresh.pending_trades(id,execution_key,wallet_address,token_address,kind,raw_quantity,block_number,block_hash,transaction_hash,
   transaction_index,execution_index,log_index,occurred_at,canonical,observed_live,quote_address,quote_symbol,quote_amount,evidence_hash,native_fee_wei,fee_key,decoder_version)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,true,$14,$15,$16,$17,$18,$19,$20,3)
   ON CONFLICT(id) DO UPDATE SET canonical=true,observed_live=fresh.pending_trades.observed_live AND EXCLUDED.observed_live,
   native_fee_wei=COALESCE(fresh.pending_trades.native_fee_wei,EXCLUDED.native_fee_wei),fee_key=COALESCE(fresh.pending_trades.fee_key,EXCLUDED.fee_key)`,
   [actual.id,actual.executionKey,actual.walletAddress,actual.tokenAddress,actual.kind,actual.rawQuantity,actual.blockNumber,actual.blockHash,actual.transactionHash,
    actual.transactionIndex,actual.executionIndex,actual.logIndex,actual.occurredAt,actual.observedLive,actual.quoteAddress,actual.quoteSymbol,actual.quoteAmount,actual.evidenceHash,actual.nativeFeeWei,actual.feeKey]);
 }
}

export async function removeFreshResolvedPendingTrades(client:PoolClient,eventIds:readonly string[]){
 if(!eventIds.length)return;
 // Preserve a previously verified observation when quantity/settlement repair
 // promotes the same execution; never recalculate or overwrite a newer mark.
 await client.query(`UPDATE fresh.financial_events f SET market_cap_usd=p.market_cap_usd,market_mark=p.market_mark FROM fresh.pending_trades p
  WHERE f.id=ANY($1::text[]) AND f.canonical AND p.canonical AND f.kind=p.kind AND f.token_address=p.token_address AND f.wallet_address=p.wallet_address
  AND f.transaction_hash=p.transaction_hash AND f.block_hash=p.block_hash AND f.block_number=p.block_number AND f.execution_index=p.execution_index
  AND(f.id=p.id OR f.execution_key=p.execution_key) AND f.market_cap_usd IS NULL AND p.market_cap_usd IS NOT NULL
  AND p.market_mark->>'version'='1' AND p.market_mark->>'kind'='post_trade_pool_sync' AND p.market_mark->>'source'='node'
  AND p.market_mark->>'eventId'=p.id AND p.market_mark->>'executionKey'=p.execution_key AND p.market_mark->>'walletAddress'=p.wallet_address
  AND p.market_mark->>'tokenAddress'=p.token_address AND p.market_mark->>'blockHash'=p.block_hash AND p.market_mark->>'transactionHash'=p.transaction_hash
  AND p.market_mark->>'marketCapUsd'=p.market_cap_usd AND(NOT(p.market_mark?'canonicalInvalid') OR p.market_mark->'canonicalInvalid'='false'::jsonb)`,[eventIds]);
 await client.query(`DELETE FROM fresh.pending_trades p USING fresh.financial_events f WHERE f.id=ANY($1::text[]) AND f.canonical AND f.kind IN('buy','sell')
  AND(p.id=f.id OR p.execution_key=f.execution_key OR(p.transaction_hash=f.transaction_hash AND p.wallet_address=f.wallet_address AND p.token_address=f.token_address
   AND p.execution_index=f.execution_index AND p.kind=f.kind))`,[eventIds]);
}

export const freshPendingTradesSchemaSql=`
 CREATE TABLE IF NOT EXISTS fresh.pending_trades(
  id text PRIMARY KEY,execution_key text NOT NULL UNIQUE,wallet_address text NOT NULL REFERENCES fresh.wallets(address),token_address text NOT NULL REFERENCES fresh.tokens(address),
  kind text NOT NULL CHECK(kind IN('buy','sell')),raw_quantity text NOT NULL CHECK(raw_quantity ~ '^[1-9][0-9]{0,77}$'),
  block_number bigint NOT NULL,block_hash text NOT NULL,transaction_hash text NOT NULL,transaction_index integer NOT NULL,execution_index integer NOT NULL,log_index integer NOT NULL,
  occurred_at timestamptz NOT NULL,canonical boolean NOT NULL DEFAULT true,observed_live boolean NOT NULL DEFAULT false,
  quote_address text,quote_symbol text,quote_amount text,evidence_hash text NOT NULL CHECK(evidence_hash ~ '^[0-9a-f]{64}$'),native_fee_wei text,fee_key text,decoder_version integer NOT NULL DEFAULT 3
 );
 ALTER TABLE fresh.pending_trades ADD COLUMN IF NOT EXISTS market_cap_usd text;
 ALTER TABLE fresh.pending_trades ADD COLUMN IF NOT EXISTS market_mark jsonb;
 ALTER TABLE fresh.pending_trades ADD COLUMN IF NOT EXISTS native_fee_wei text;
 ALTER TABLE fresh.pending_trades ADD COLUMN IF NOT EXISTS fee_key text;
 CREATE INDEX IF NOT EXISTS pending_trades_wallet_idx ON fresh.pending_trades(wallet_address,occurred_at DESC,id DESC) WHERE canonical;
 CREATE INDEX IF NOT EXISTS pending_trades_wallet_token_block_idx ON fresh.pending_trades(wallet_address,token_address,block_number) WHERE canonical;
 CREATE INDEX IF NOT EXISTS pending_trades_token_idx ON fresh.pending_trades(token_address,occurred_at DESC,id DESC) WHERE canonical;
 CREATE INDEX IF NOT EXISTS pending_trades_time_idx ON fresh.pending_trades(occurred_at DESC,id DESC) WHERE canonical;
 CREATE INDEX IF NOT EXISTS pending_trades_block_idx ON fresh.pending_trades(block_number);
 CREATE OR REPLACE VIEW fresh.visible_trades AS
 SELECT f.id,f.execution_key,f.wallet_address,f.token_address,f.kind,f.quantity,f.amount_usd,f.fee_usd,f.block_number,f.block_hash,f.transaction_hash,f.transaction_index,
  f.execution_index,f.log_index,f.occurred_at,f.canonical,f.observed_live,f.quote_address,f.quote_symbol,f.quote_amount,f.price_usd,f.decoder_version,f.bnb_price_usd,f.acquisition_cost,
  NULL::text AS raw_quantity,CASE WHEN f.amount_usd IS NULL THEN 'pending_settlement'::text ELSE 'ready'::text END AS accounting_status,f.market_cap_usd,f.market_mark,f.provenance
 FROM fresh.financial_events f WHERE f.kind IN('buy','sell')
 UNION ALL
 SELECT p.id,p.execution_key,p.wallet_address,p.token_address,p.kind,NULL::text,NULL::text,NULL::text,p.block_number,p.block_hash,p.transaction_hash,p.transaction_index,
  p.execution_index,p.log_index,p.occurred_at,p.canonical,p.observed_live,p.quote_address,p.quote_symbol,p.quote_amount,NULL::text,p.decoder_version,NULL::text,NULL::jsonb,
  p.raw_quantity,'pending_precision'::text,p.market_cap_usd,p.market_mark,NULL::jsonb
 FROM fresh.pending_trades p WHERE NOT EXISTS(SELECT 1 FROM fresh.financial_events f WHERE f.canonical AND f.kind IN('buy','sell')
  AND(f.id=p.id OR f.execution_key=p.execution_key OR(f.transaction_hash=p.transaction_hash AND f.wallet_address=p.wallet_address AND f.token_address=p.token_address
   AND f.execution_index=p.execution_index AND f.kind=p.kind)));
`;
