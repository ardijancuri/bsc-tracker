import type{FreshFinancialEvent}from'../../shared/freshAccounting.js';import type{FreshCapturedReceipt}from'./capture.js';import{freshInteger}from'./capture.js';import type{FreshTokenMetadata}from'./pricing.js';import{FreshRational}from'./accounting.js';import{freshPaidCreationPurchase}from'./paidCreationPurchase.js';import{WBNB}from'../launchpad.js';
import type{PoolClient}from'pg';
type Proof=NonNullable<ReturnType<typeof freshPaidCreationPurchase>>;
type Witness={entry:FreshCapturedReceipt;metadata:FreshTokenMetadata;raw:bigint;proof:Proof;eventBinding:string};
const approved=new WeakMap<FreshFinancialEvent,Witness>(),stable=(v:unknown):string=>JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.entries(x).sort(([a],[b])=>a.localeCompare(b))):x);
const binding=(e:FreshFinancialEvent)=>stable([e.id,e.executionKey,e.walletAddress,e.tokenAddress,e.kind,e.quantity,e.amountUsd,e.feeUsd,e.feeKey,e.blockNumber,e.blockHash,e.transactionHash,e.transactionIndex,e.executionIndex,e.logIndex,e.occurredAt,e.quoteAddress,e.quoteSymbol,e.quoteAmount]);
/** Ephemeral ingestion certificate. Serialized event fields cannot authorize
 * retiring an earlier financial interpretation. The receipt verifier is run
 * again inside the caller's existing atomic accounting transaction. */
export function certifyFreshPaidCreationEvent(event:FreshFinancialEvent,entry:FreshCapturedReceipt,metadata:FreshTokenMetadata,raw:bigint){
 const proof=freshPaidCreationPurchase(entry,event.walletAddress,event.tokenAddress!,raw);if(!proof||event.kind!=='buy'||event.canonical===false||event.amountUsd===null||event.feeUsd===null||event.quoteAddress!==WBNB||event.quoteSymbol!=='BNB'||event.quoteAmount==null||FreshRational.parse(event.quoteAmount).mul(FreshRational.parse('1000000000000000000')).compare(FreshRational.parse(proof.nativeAmountWei))!==0||metadata.address!==event.tokenAddress||metadata.block.number!==Number(event.blockNumber)||metadata.block.hash!==event.blockHash||FreshRational.parse(event.quantity).mul(FreshRational.parse((10n**BigInt(metadata.decimals)).toString())).compare(FreshRational.parse(raw.toString()))!==0)return false;
 approved.set(event,{entry,metadata,raw,proof,eventBinding:binding(event)});return true;
}
export interface FreshPaidCreationKindCorrection{previousId:string;previousExecutionKey:string;event:FreshFinancialEvent;previous:Record<string,any>}
/** Only the same positive canonical Transfer log may be superseded. Original
 * rows remain retained; a paid purchase never zeroes or reinterprets a gift,
 * an internal transfer, a different quantity or another execution. */
export function planFreshPaidCreationKindCorrections(events:FreshFinancialEvent[],saved:Record<string,any>[]):FreshPaidCreationKindCorrection[]{
 const out:FreshPaidCreationKindCorrection[]=[];
 for(const event of events){if(event.kind!=='buy'||event.logIndex===null)continue;
  const matches=saved.filter(r=>r.canonical&&r.kind==='transfer_in'&&r.wallet_address===event.walletAddress&&r.token_address===event.tokenAddress&&String(r.block_number)===event.blockNumber&&r.block_hash===event.blockHash&&r.transaction_hash===event.transactionHash&&r.transaction_index===event.transactionIndex&&r.execution_index===event.executionIndex&&r.log_index===event.logIndex);
  if(!matches.length)continue;if(matches.length!==1)throw Error('paid_creation_previous_movement_ambiguous');
  const witness=approved.get(event);if(!witness)throw Error('paid_creation_kind_correction_not_authenticated');const proof=freshPaidCreationPurchase(witness.entry,event.walletAddress,event.tokenAddress!,witness.raw);
  if(!proof||stable(proof)!==stable(witness.proof)||binding(event)!==witness.eventBinding||witness.entry.transaction.hash!==event.transactionHash||witness.entry.receipt.blockHash!==event.blockHash||String(freshInteger(witness.entry.receipt.blockNumber))!==event.blockNumber||Number(freshInteger(witness.entry.transaction.transactionIndex))!==event.transactionIndex||witness.metadata.block.hash!==event.blockHash||FreshRational.parse(event.quantity).mul(FreshRational.parse((10n**BigInt(witness.metadata.decimals)).toString())).compare(FreshRational.parse(witness.raw.toString()))!==0)throw Error('paid_creation_kind_correction_context_changed');
  const previous=matches[0],log=witness.entry.receipt.logs.find(l=>l.address===event.tokenAddress&&Number(freshInteger(l.logIndex))===event.logIndex);
  if(!log||log.topics.length!==3||log.topics[0]!=='0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'||log.topics[2]!=='0x'+event.walletAddress.slice(2).padStart(64,'0')||BigInt(log.data)!==witness.raw||previous.counterparty!=='0x'+log.topics[1].slice(-40)||FreshRational.parse(previous.quantity).compare(FreshRational.parse(event.quantity))!==0||previous.acquisition_cost!=null||previous.fee_key!==event.feeKey||previous.fee_usd!==null&&event.feeUsd!==null&&FreshRational.parse(previous.fee_usd).compare(FreshRational.parse(event.feeUsd))!==0)throw Error('paid_creation_previous_movement_conflict');
  if(saved.some(r=>r.canonical&&r.id===event.id))throw Error('paid_creation_duplicate_active_interpretation');
  out.push({previousId:previous.id,previousExecutionKey:previous.execution_key,event,previous});
 }
 if(new Set(out.map(p=>p.previousId)).size!==out.length||new Set(out.map(p=>p.event.id)).size!==out.length)throw Error('paid_creation_kind_correction_duplicate');return out;
}
/** Caller retains this transaction through insertion and scope rebuild. No
 * original financial field is rewritten besides the superseded canonical flag. */
export async function retireFreshPaidCreationInterpretations(client:Pick<PoolClient,'query'>,plan:FreshPaidCreationKindCorrection[]){
 if(!plan.length)return;await client.query('SELECT pg_advisory_xact_lock(73621941)');
 for(const correction of plan){const rechecked=planFreshPaidCreationKindCorrections([correction.event],[correction.previous]);if(rechecked.length!==1||rechecked[0].previousId!==correction.previousId||rechecked[0].previousExecutionKey!==correction.previousExecutionKey)throw Error('paid_creation_correction_plan_changed');
  const current=(await client.query('SELECT * FROM fresh.financial_events WHERE id=$1 FOR UPDATE',[correction.previousId])).rows[0];if(!current||stable(current)!==stable(correction.previous))throw Error('paid_creation_previous_row_changed');
  const changed=await client.query('UPDATE fresh.financial_events SET canonical=false WHERE id=$1 AND execution_key=$2 AND canonical RETURNING *',[correction.previousId,correction.previousExecutionKey]);if(changed.rowCount!==1||!changed.rows[0]||changed.rows[0].canonical!==false)throw Error('paid_creation_previous_row_cas');
  const before={...current,canonical:false};if(stable(changed.rows[0])!==stable(before))throw Error('paid_creation_previous_field_changed');
 }
}
