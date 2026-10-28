import type{Pool}from'pg';import type{Rpc}from'../rpc.js';import{blockHex}from'../rpc.js';import{decodeFreshEvidence}from'./capture.js';import{FreshRational}from'./accounting.js';import{freshPositionReceiptRelevantSql}from'./positionDependencies.js';import{freshScopeTokenBoundarySql}from'./tracking.js';
const transfer='0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',allowed=new Set(['trade_value_unavailable','exchange_quote_valuation_unavailable','incoming_transfer_cost_unknown','outgoing_transfer_value_unknown','wallet_fee_valuation_unavailable','shared_quote_allocation_unknown']);
/** Selected replay only: monetary repairs are retained. Every affected token
 * movement must match the original canonical Transfer logs and the ending
 * on-chain balance. No historical state scan or financial write is performed. */
export async function verifyFreshEstimatedMovement(db:Pick<Pool,'query'>,rpc:Rpc,input:{scopeId:string;wallet:string;token:string;decimals:number;quantityQ:string;block:string;hash:string}){
 try{
  if(!Number.isInteger(input.decimals)||input.decimals<0||input.decimals>255||!/^\d+$/.test(input.block)||!/^0x[a-f0-9]{64}$/.test(input.hash))return null;
  const rows=(await db.query(`SELECT e.tx_hash,e.block_hash,e.payload,e.last_error FROM fresh.recent_evidence e JOIN fresh.accounting_scopes s ON s.id=$1 AND s.active
   LEFT JOIN fresh.recent_blocks h ON h.block_number=e.block_number AND h.block_hash=e.block_hash
   WHERE e.wallet_addresses&&s.wallet_addresses AND e.decoder_status<>'done' AND e.block_number<=$3
   AND ${freshScopeTokenBoundarySql('s','$2','e.block_number','h.occurred_at',{allowMissingTime:true})} AND ${freshPositionReceiptRelevantSql('e','$2','s')} ORDER BY e.block_number,e.tx_hash LIMIT 65`,[input.scopeId,input.token,input.block])).rows;
  if(rows.length>64||rows.reduce((n,r)=>n+r.payload.length,0)>8*1024*1024)return null;
  for(const row of rows){const reasons=String(row.last_error??'').split(',');if(!reasons.length||reasons.some(r=>!allowed.has(r)))return null;
    const e=decodeFreshEvidence(row.payload);if(e.transaction.hash!==row.tx_hash||e.receipt.transactionHash!==row.tx_hash||e.receipt.blockHash!==row.block_hash||e.transaction.blockHash!==row.block_hash||e.receipt.status!=='0x1'||!e.wallets.includes(input.wallet))return null;
    let raw=0n;for(const log of e.receipt.logs){if(log.address.toLowerCase()!==input.token||log.topics[0]!==transfer)continue;if(log.removed||log.transactionHash!==row.tx_hash||log.blockHash!==row.block_hash||log.topics.length!==3||!/^0x[0-9a-f]{64}$/i.test(log.data))return null;const from='0x'+log.topics[1].slice(-40).toLowerCase(),to='0x'+log.topics[2].slice(-40).toLowerCase(),amount=BigInt(log.data);if(from===input.wallet)raw-=amount;if(to===input.wallet)raw+=amount;}
    const facts=(await db.query(`SELECT e.kind,e.quantity FROM fresh.financial_events e JOIN fresh.scope_event_results r ON r.event_id=e.id AND r.scope_id=$1 WHERE e.transaction_hash=$2 AND e.block_hash=$3 AND e.wallet_address=$4 AND e.token_address=$5 AND e.canonical`,[input.scopeId,row.tx_hash,row.block_hash,input.wallet,input.token])).rows;
    const net=facts.reduce((n,r)=>n.add(FreshRational.parse(r.quantity).mul(new FreshRational(['buy','transfer_in'].includes(r.kind)?1n:['sell','transfer_out'].includes(r.kind)?-1n:0n))),FreshRational.parse('0'));
    if(net.mul(new FreshRational(10n**BigInt(input.decimals))).compare(new FreshRational(raw))!==0)return null;
  }
  const header=await rpc<{hash:string;number:string}>('eth_getBlockByNumber',[blockHex(Number(input.block)),false]);if(header?.hash?.toLowerCase()!==input.hash||BigInt(header.number)!==BigInt(input.block))return null;
  const call=await rpc<string>('eth_call',[{to:input.token,data:'0x70a08231'+input.wallet.slice(2).padStart(64,'0')},blockHex(Number(input.block))]);if(!/^0x[0-9a-f]{64}$/i.test(call))return null;
  const quantity=new FreshRational(BigInt(call),10n**BigInt(input.decimals));if(quantity.compare(FreshRational.fromStored(input.quantityQ))!==0)return null;
  const again=await rpc<{hash:string}>('eth_getBlockByNumber',[blockHex(Number(input.block)),false]);if(again?.hash?.toLowerCase()!==input.hash)return null;
  return{block:input.block,hash:input.hash,quantity:quantity.decimal(255),checkedAt:new Date().toISOString()};
 }catch{return null;}
}
