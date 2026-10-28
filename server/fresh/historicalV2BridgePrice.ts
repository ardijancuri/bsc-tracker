import type{Pool}from'pg';
import type{Rpc}from'../rpc.js';
import{WBNB}from'../launchpad.js';
import{decodeFreshEvidence,freshAddress,type FreshCapturedReceipt}from'./capture.js';
import type{FreshPriceBlock,FreshTokenMetadata}from'./pricing.js';
import{freshPoolQuotePair}from'./currentPoolQuote.js';
import{recoverFreshHistoricalV2PairQuote,type FreshHistoricalV2PairQuote}from'./historicalV2PairQuote.js';
import{FreshRational}from'./accounting.js';
const transfer='0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',sync='0x1c411e9a96e071241c2f21f7726b17ae89e3cab4c78be50e062b03a9fffbbad1';
const stable=(v:unknown):string=>JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.entries(x).sort(([a],[b])=>a.localeCompare(b))):x);
/** Only a discovery hint: its time and wallet never value a transfer. Each
 * selected pair must independently have a canonical historical Sync at the
 * target cutoff and the immutable official CREATE2 identity. */
export function freshV2BridgeQuoteHints(token:string,entries:readonly FreshCapturedReceipt[]):string[]{
 const found=new Set<string>();for(const e of entries.slice(0,16)){if(!e.receipt||e.receipt.status!=='0x1')continue;
  const pools=new Set(e.receipt.logs.filter(l=>!l.removed&&l.topics.length===1&&l.topics[0]===sync&&/^0x[\da-f]{128}$/.test(l.data)).map(l=>l.address));
  const assets=[...new Set(e.receipt.logs.filter(l=>!l.removed&&l.topics[0]===transfer&&l.topics.length===3&&/^0x[\da-f]{64}$/.test(l.data)).map(l=>l.address))];
  for(const asset of assets.slice(0,64))if(asset!==token&&asset!==WBNB&&freshAddress(asset)===asset&&pools.has(freshPoolQuotePair(token,asset)))found.add(asset);
 }return[...found].sort().slice(0,4);
}
/** Repair/ingestion only, using the existing token/time index and bounded
 * public trade locators. Private-only activity cannot seed public hints. */
export async function findFreshV2BridgeQuoteHints(db:Pick<Pool,'query'>,token:string,entry:FreshCapturedReceipt):Promise<string[]>{
 const immediate=freshV2BridgeQuoteHints(token,[entry]);if(immediate.length)return immediate;
 const refs=(await db.query(`SELECT f.transaction_hash,f.block_hash FROM fresh.financial_events f
 WHERE f.token_address=$1 AND f.canonical AND f.kind IN('buy','sell')
 AND EXISTS(SELECT 1 FROM fresh.kols k JOIN fresh.wallets w ON w.address=k.wallet_address
 JOIN fresh.accounting_scopes s ON s.id='kol:'||w.address AND s.active AND s.kind='kol' AND s.account_id IS NULL
 JOIN fresh.scope_event_results r ON r.scope_id=s.id AND r.event_id=f.id AND r.tokens_trade
 WHERE k.wallet_address=f.wallet_address AND k.is_tracked AND w.active AND f.wallet_address=ANY(s.wallet_addresses)
 AND f.block_number>=greatest(w.monitoring_from_block,s.starts_block) AND f.occurred_at>=s.starts_at
 AND(w.monitoring_to_block IS NULL OR f.block_number<=w.monitoring_to_block))
 ORDER BY f.occurred_at DESC,f.id DESC LIMIT 12`,[token])).rows;
 let bytes=0;
 for(const ref of refs){const row=(await db.query(`SELECT e.payload,e.block_number,e.block_hash FROM fresh.recent_evidence e JOIN fresh.recent_blocks b USING(block_number,block_hash)
 WHERE e.tx_hash=$1 AND e.block_hash=$2 AND e.expires_at>clock_timestamp()`,[ref.transaction_hash,ref.block_hash])).rows[0];
  if(!row||!Buffer.isBuffer(row.payload)||row.payload.length>2*1024*1024)continue;bytes+=row.payload.length;if(bytes>8*1024*1024)break;
  try{const e=decodeFreshEvidence(row.payload);if(e.transaction.hash!==ref.transaction_hash||e.receipt.transactionHash!==ref.transaction_hash||e.receipt.blockHash!==ref.block_hash||Number(BigInt(e.receipt.blockNumber))!==Number(row.block_number))continue;const hints=freshV2BridgeQuoteHints(token,[e]);if(hints.length)return hints;}catch{/* A corrupt optional hint is never financial evidence. */}
 }
 return[];
}
export interface FreshHistoricalV2BridgePrice{version:1;kind:'historical_pcs_v2_bridge_price';tokenAddress:string;quoteAddress:string;target:FreshPriceBlock;market:FreshHistoricalV2PairQuote;conversion:FreshHistoricalV2PairQuote;rawNativeRatio:{numerator:string;denominator:string};priceNative:string;}
export async function recoverFreshHistoricalV2BridgePrice(o:{rpc:Rpc;tokenAddress:string;quoteAddress:string;target:FreshPriceBlock;anchor:FreshPriceBlock;verifiedMetadata:FreshTokenMetadata;canonicalHash:(n:number)=>Promise<string|null>;prior?:FreshHistoricalV2BridgePrice}):Promise<FreshHistoricalV2BridgePrice>{
 const token=freshAddress(o.tokenAddress),quote=freshAddress(o.quoteAddress),p=o.prior;if(!token||!quote||token===quote||[token,quote].includes(WBNB)||o.verifiedMetadata.address!==token||stable(o.verifiedMetadata.block)!==stable(o.target)||!Number.isInteger(o.verifiedMetadata.decimals)||o.verifiedMetadata.decimals<0||o.verifiedMetadata.decimals>255)throw Error('v2_bridge_identity_invalid');
 if(p&&(Buffer.byteLength(stable(p))>256*1024||p.version!==1||p.kind!=='historical_pcs_v2_bridge_price'||p.tokenAddress!==token||p.quoteAddress!==quote||stable(p.target)!==stable(o.target)))throw Error('v2_bridge_prior_invalid');
 const market=await recoverFreshHistoricalV2PairQuote({...o,baseAddress:token,quoteAddress:quote,prior:p?.market}),conversion=await recoverFreshHistoricalV2PairQuote({...o,baseAddress:quote,quoteAddress:WBNB,prior:p?.conversion});
 const raw=new FreshRational(BigInt(market.quoteRaw)*BigInt(conversion.quoteRaw),BigInt(market.baseRaw)*BigInt(conversion.baseRaw)),price=raw.mul(new FreshRational(10n**BigInt(o.verifiedMetadata.decimals),10n**18n));
 const priceNative=price.decimal();if(price.n<=0n||FreshRational.parse(priceNative).n<=0n)throw Error('v2_bridge_empty');const result:FreshHistoricalV2BridgePrice={version:1,kind:'historical_pcs_v2_bridge_price',tokenAddress:token,quoteAddress:quote,target:{...o.target},market,conversion,rawNativeRatio:{numerator:String(raw.n),denominator:String(raw.d)},priceNative};
 if(Buffer.byteLength(stable(result))>256*1024||p&&stable(p)!==stable(result))throw Error('v2_bridge_prior_invalid');return result;
}
