import{validateFreshAcquisitionCost,freshAcquisitionCostKey}from'./acquisitionCost.js';
import { createHash } from 'node:crypto';
import {queueFreshTransferValuation} from './deferredTransferValuation.js';
import type { PoolClient } from 'pg';
import type { FreshEventResult, FreshFinancialEvent, FreshLot, FreshPosition, FreshPositionSummary, FreshScope,FreshFeeExclusions } from '../../shared/freshAccounting.js';
import{GANG_TOKEN_ADDRESS,FRESH_GANG_HISTORY_FROM_BLOCK,FRESH_GANG_CREATION_TIME,readFreshGangHistoryAdmission,freshScopeEventSql}from'./tracking.js';
import {advanceFreshRollingKolTotals,addFreshRollingKolResult,addFreshRollingKolExcludedFee,rebuildFreshRollingKolTotals} from './rolling.js';
export type { FreshEventResult, FreshFinancialEvent, FreshLot, FreshPosition, FreshScope } from '../../shared/freshAccounting.js';

const gcd = (a: bigint, b: bigint): bigint => { a = a < 0n ? -a : a; b = b < 0n ? -b : b; while (b) [a, b] = [b, a % b]; return a || 1n; };
/** Persist n/d, round only when a public response is formatted. */
export class FreshRational {
  readonly n: bigint; readonly d: bigint;
  constructor(n: bigint, d = 1n, reduced=false) { if (!d) throw new Error('zero_denominator'); const g = reduced?1n:gcd(n, d); this.n = n / g * (d < 0n ? -1n : 1n); this.d = (d < 0n ? -d : d) / g; }
  /** Only application-written exact-state fields use this path. Their reduced
   * fractions were already normalized before persistence. */
  static fromStored(value:string):FreshRational {
    if(value.length>65_536)throw new Error('exact_state_budget_exceeded');const fraction=/^(-?\d+)\/([1-9]\d*)$/.exec(value);
    return fraction?new FreshRational(BigInt(fraction[1]),BigInt(fraction[2]),true):FreshRational.parse(value);
  }
  static parse(value: string): FreshRational {
    // Exact FIFO splits from many independent lots can have a large least
    // common denominator. Persisted rationals have a separate bounded budget;
    // normalized chain/provider inputs are still small decimal strings.
    if (value.length > 65_536) throw new Error('exact_state_budget_exceeded');
    const fraction = /^(-?\d+)\/(\d+)$/.exec(value);
    if (fraction) return new FreshRational(BigInt(fraction[1]), BigInt(fraction[2]));
    if(value.length>2048)throw new Error('invalid_exact_amount');
    const match = /^([+-]?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(value);
    if (!match) throw new Error('invalid_exact_amount');
    const exponent = Number(match[4] ?? 0), scale = (match[3]?.length ?? 0) - exponent;
    if (!Number.isSafeInteger(exponent) || Math.abs(scale) > 256 || match[2].length + (match[3]?.length ?? 0) > 512) throw new Error('invalid_exact_amount');
    return new FreshRational(BigInt(`${match[1] === '-' ? '-' : ''}${match[2]}${match[3] ?? ''}`) * (scale < 0 ? 10n ** BigInt(-scale) : 1n), scale > 0 ? 10n ** BigInt(scale) : 1n);
  }
  add(v: FreshRational) {
    const common=gcd(this.d,v.d),numerator=this.n*(v.d/common)+v.n*(this.d/common),reduction=gcd(numerator,common);
    return new FreshRational(numerator/reduction,(this.d/common)*(v.d/reduction),true);
  }
  sub(v: FreshRational) { return this.add(new FreshRational(-v.n,v.d,true)); }
  mul(v: FreshRational) {const left=gcd(this.n,v.d),right=gcd(v.n,this.d);return new FreshRational((this.n/left)*(v.n/right),(this.d/right)*(v.d/left),true);}
  div(v: FreshRational) { return this.mul(new FreshRational(v.d,v.n,true)); }
  compare(v: FreshRational) { const n = this.n * v.d - v.n * this.d; return n < 0n ? -1 : n > 0n ? 1 : 0; }
  exact() { const value=this.d === 1n ? `${this.n}` : `${this.n}/${this.d}`;if(value.length>65_536)throw new Error('exact_state_budget_exceeded');return value; }
  decimal(places = 36) {
    const scale = 10n ** BigInt(places), abs = this.n < 0n ? -this.n : this.n;
    let raw = abs * scale / this.d; if (abs * scale % this.d * 2n >= this.d) raw++;
    const tail = (raw % scale).toString().padStart(places, '0').replace(/0+$/, '');
    return `${this.n < 0n && raw ? '-' : ''}${raw / scale}${tail ? `.${tail}` : ''}`;
  }
}
const q = FreshRational.fromStored, zero = q('0');
export const freshDecimal = (value: string | null): string | null => value === null ? null : q(value).decimal();
/** ERC20 decimals are uint8. Quantities retain every possible raw unit; USD and
 * return formatting continues using the separate 36-place formatter above. */
export const freshQuantity = (value: string | null): string | null => value === null ? null : q(value).decimal(255);
export const freshUtcDay = (now: string | Date | number = Date.now()) => new Date(now).toISOString().slice(0, 10);
export const freshEventAccountingEligible=(event:FreshFinancialEvent)=>event.kind!=='fee'||event.feeAttribution?.status==='eligible';
export function freshFeeExclusions(row:Record<string,any>|undefined,daily=false):FreshFeeExclusions{
  const prefix=daily?'today_':'';return {policy:'eligible_new_tokens_only',count:Number(row?.[prefix+'unallocated_fee_count']??0),knownFeesUsd:freshDecimal(row?.[prefix+'unallocated_fee_q']??'0')!,unknownFeeCount:Number(row?.[prefix+'unallocated_fee_unknown_count']??0),unattributedCount:Number(row?.[prefix+'unattributed_fee_count']??0)};
}
const positive = (value: string) => { const parsed = q(value); if (parsed.compare(zero) < 0) throw new Error('negative_financial_input'); return parsed; };
const nullable = (value: string | null) => value === null ? null : positive(value);
const sum = (values: string[]) => values.reduce((v, next) => v.add(q(next)), zero);
export const freshRationalSum = (values: string[]) => sum(values).exact();
const inScope = (scope: FreshScope, event: FreshFinancialEvent) => {
  const history=event.tokenAddress===GANG_TOKEN_ADDRESS&&scope.kind==='kol'&&scope.accountId===null&&scope.walletAddresses.length===1&&scope.id==='kol:'+scope.walletAddresses[0]
    ?scope.tokenHistoryStarts?.[GANG_TOKEN_ADDRESS]:undefined;
  const allowedHistory=history?.policy==='gmgn_gang_only_history_v1'&&history.startsBlock===String(FRESH_GANG_HISTORY_FROM_BLOCK)&&history.startsAt===FRESH_GANG_CREATION_TIME&&/^[0-9a-f]{64}$/.test(history.permissionDigest);
  const boundary = allowedHistory?history!:(scope.walletStarts?.[event.walletAddress] ?? scope);
  return scope.walletAddresses.includes(event.walletAddress) && BigInt(event.blockNumber) >= BigInt(boundary.startsBlock) && Date.parse(event.occurredAt) >= Date.parse(boundary.startsAt);
};
/** Hydrate only trusted public books from a source-bound permission. This is
 * done in ingestion/repair and selected replay reconstruction, never a scan. */
export async function hydrateFreshScopeTokenHistory(client:Pick<PoolClient,'query'>,scope:FreshScope,options:{lock?:boolean}={}){
 delete scope.tokenHistoryStarts;
 if(scope.kind!=='kol'||scope.accountId!==null||scope.walletAddresses.length!==1||scope.id!=='kol:'+scope.walletAddresses[0])return scope;
 const admission=await readFreshGangHistoryAdmission(client,options);if(!admission)return scope;
 const role=(await client.query(`SELECT 1 FROM fresh.kols k JOIN fresh.wallets w ON w.address=k.wallet_address WHERE k.wallet_address=$1 AND k.is_tracked AND w.active${options.lock?' FOR SHARE OF k,w':''}`,[scope.walletAddresses[0]])).rows[0];
 if(role)scope.tokenHistoryStarts={[GANG_TOKEN_ADDRESS]:{startsAt:admission.permission.historyFromTime,startsBlock:String(admission.permission.historyFromBlock),permissionDigest:admission.digest,policy:admission.permission.policy}};
 return scope;
}
export function freshEmptyPosition(scopeId: string, tokenAddress: string): FreshPosition {
  return { scopeId, tokenAddress, quantityQ: '0', investedQ: '0', soldQ: '0', incomingQ: '0', outgoingQ: '0', feesQ: '0', capitalQ: '0', realizedQ: '0', unknownCost: false, unknownFee: false,
    unknownPurchaseValue:false,unknownSaleValue:false,unknownIncomingValue:false,unknownOutgoingValue:false,lastEventId: null, lastEventAt: null, revision: '0' };
}
const add = (value: string, delta: FreshRational) => q(value).add(delta).exact();
const lotOrder = (a: FreshLot, b: FreshLot) => BigInt(a.acquiredBlock) < BigInt(b.acquiredBlock) ? -1 : BigInt(a.acquiredBlock) > BigInt(b.acquiredBlock) ? 1 : a.acquiredTransactionIndex - b.acquiredTransactionIndex || a.acquiredExecutionIndex - b.acquiredExecutionIndex || a.id.localeCompare(b.id);
export const freshEventOrder = (a: FreshFinancialEvent, b: FreshFinancialEvent) => BigInt(a.blockNumber) < BigInt(b.blockNumber) ? -1 : BigInt(a.blockNumber) > BigInt(b.blockNumber) ? 1 : a.transactionIndex - b.transactionIndex || a.executionIndex - b.executionIndex || (a.logIndex ?? -1) - (b.logIndex ?? -1) || a.id.localeCompare(b.id);
export function freshEventQuote(event:Pick<FreshFinancialEvent,'kind'|'quoteAddress'|'quoteSymbol'|'quoteAmount'>){
  const{quoteAddress,quoteSymbol,quoteAmount}=event;
  if(quoteAddress==null&&quoteSymbol==null&&quoteAmount==null)return null;
  if(!['buy','sell'].includes(event.kind)||typeof quoteAddress!=='string'||!/^0x[\da-f]{40}$/.test(quoteAddress)
    ||typeof quoteSymbol!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/.test(quoteSymbol)||typeof quoteAmount!=='string'
    ||quoteAmount.length>1024||quoteAmount.includes('/')||q(quoteAmount).n<=0n
    ||['BNB','WBNB'].includes(quoteSymbol)&&quoteAddress!=='0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c')throw Error('invalid_trade_quote');
  return{quoteAddress,quoteSymbol,quoteAmount};
}
/** Quote display proof can be filled without replaying FIFO. A previously
 * recorded settlement is immutable unless a separate correction is reviewed. */
export function assertFreshEventQuoteCompatible(saved:FreshFinancialEvent,next:FreshFinancialEvent){
  if(saved.acquisitionCost&&next.acquisitionCost&&freshAcquisitionCostKey(saved.acquisitionCost)!==freshAcquisitionCostKey(next.acquisitionCost))throw Error('conflicting_acquisition_cost_evidence');
  const oldQuote=freshEventQuote(saved),newQuote=freshEventQuote(next);
  if(oldQuote&&newQuote&&(oldQuote.quoteAddress!==newQuote.quoteAddress||oldQuote.quoteSymbol!==newQuote.quoteSymbol
    ||q(oldQuote.quoteAmount).compare(q(newQuote.quoteAmount))!==0))throw Error('conflicting_trade_quote_evidence');
}
export function freshSameTradeQuoteContext(saved:FreshFinancialEvent,next:FreshFinancialEvent){
  return saved.canonical!==false&&next.canonical!==false&&saved.id===next.id&&saved.executionKey===next.executionKey
    &&saved.walletAddress===next.walletAddress&&saved.tokenAddress===next.tokenAddress&&saved.kind===next.kind
    &&saved.blockNumber===next.blockNumber&&saved.blockHash===next.blockHash&&saved.transactionHash===next.transactionHash
    &&saved.transactionIndex===next.transactionIndex&&saved.executionIndex===next.executionIndex&&saved.logIndex===next.logIndex
    &&Date.parse(saved.occurredAt)===Date.parse(next.occurredAt)&&q(saved.quantity).compare(q(next.quantity))===0;
}
/** Additive proof enrichment only: lock and compare the complete immutable
 * execution context before filling its three previously empty display fields.
 * It never changes accounting values, canonical flags, results or revisions. */
export async function persistFreshTradeQuote(client:Pick<PoolClient,'query'>,event:FreshFinancialEvent){
  validateFreshFinancialEvent(event);const quote=freshEventQuote(event);if(!quote)return false;
  const prior=(await client.query('SELECT * FROM fresh.financial_events WHERE id=$1 FOR UPDATE',[event.id])).rows[0];
  if(!prior||!freshSameTradeQuoteContext(freshEventFromRow(prior),event))throw Error('trade_quote_context_changed');
  assertFreshEventQuoteCompatible(freshEventFromRow(prior),event);
  if(prior.quote_amount!=null)return false;
  if(prior.quote_address!=null||prior.quote_symbol!=null)throw Error('trade_quote_partial_context');
  return(await client.query(`UPDATE fresh.financial_events SET quote_address=$2,quote_symbol=$3,quote_amount=$4
    WHERE id=$1 AND canonical AND quote_amount IS NULL AND quote_address IS NULL AND quote_symbol IS NULL`,
    [event.id,quote.quoteAddress,quote.quoteSymbol,quote.quoteAmount])).rowCount===1;
}
export function validateFreshFinancialEvent(event: FreshFinancialEvent) {
  if (!event.id || event.id.length > 512 || !event.executionKey || event.executionKey.length > 1024 || !/^0x[\da-f]{40}$/.test(event.walletAddress)
    || event.tokenAddress !== null && !/^0x[\da-f]{40}$/.test(event.tokenAddress) || !/^0x[\da-f]{64}$/.test(event.blockHash)
    || !/^0x[\da-f]{64}$/.test(event.transactionHash) || !/^\d+$/.test(event.blockNumber) || !Number.isSafeInteger(event.transactionIndex) || event.transactionIndex < 0
    || !Number.isSafeInteger(event.executionIndex) || event.executionIndex < 0 || event.logIndex !== null && (!Number.isSafeInteger(event.logIndex) || event.logIndex < 0)
    || !Number.isFinite(Date.parse(event.occurredAt)) || event.kind === 'fee' && event.tokenAddress !== null && event.feeAttribution?.status!=='eligible' || event.kind !== 'fee' && event.tokenAddress === null
    || !['buy', 'sell', 'transfer_in', 'transfer_out', 'fee'].includes(event.kind)) throw new Error('invalid_financial_event');
  for(const amount of [event.quantity,event.amountUsd,event.feeUsd])if(amount!==null&&(amount.includes('/')||amount.length>1024))throw new Error('invalid_source_decimal');
  const quantity = positive(event.quantity); nullable(event.amountUsd); nullable(event.feeUsd);
  freshEventQuote(event);validateFreshAcquisitionCost(event,FreshRational.parse);
  if (event.kind !== 'fee' && quantity.compare(zero) <= 0 || event.kind === 'fee' && quantity.compare(zero) !== 0) throw new Error('invalid_event_quantity');
  if (event.feeUsd !== null && q(event.feeUsd).compare(zero) > 0 && !event.feeKey) throw new Error('fee_identity_required');
  if (event.counterparty !== null && !/^0x[\da-f]{40}$/.test(event.counterparty)) throw new Error('invalid_counterparty');
  const attribution=event.feeAttribution;if(attribution){
    if(!['eligible','unattributed','excluded'].includes(attribution.status)||attribution.nativeFeeWei!==null&&(!/^\d{1,78}$/.test(attribution.nativeFeeWei)||BigInt(attribution.nativeFeeWei)>=(1n<<256n))
      ||attribution.tokenAddress!==undefined&&!/^0x[\da-f]{40}$/.test(attribution.tokenAddress)||attribution.contract!==undefined&&!/^0x[\da-f]{40}$/.test(attribution.contract)
      ||attribution.selector!==undefined&&!/^0x[\da-f]{8}$/.test(attribution.selector))throw new Error('invalid_fee_attribution');
    if(attribution.expensePolicy!==undefined&&(attribution.expensePolicy!=='signed_batch_trade_expenses_v1'||attribution.status!=='eligible'
      ||!/^\d{1,78}$/.test(attribution.batchExpenseNativeWei??'')||!/^\d{1,78}$/.test(attribution.gasNativeWei??'')||attribution.nativeFeeWei===null
      ||BigInt(attribution.batchExpenseNativeWei!)<=0n||BigInt(attribution.gasNativeWei!)<=0n
      ||BigInt(attribution.batchExpenseNativeWei!)+BigInt(attribution.gasNativeWei!)!==BigInt(attribution.nativeFeeWei)))throw Error('invalid_batch_expense_attribution');
    if(attribution.expensePolicy===undefined&&(attribution.batchExpenseNativeWei!==undefined||attribution.gasNativeWei!==undefined))throw Error('invalid_batch_expense_attribution');
    if(event.kind==='fee'&&event.tokenAddress!==null&&attribution.tokenAddress!==undefined&&event.tokenAddress!==attribution.tokenAddress)throw new Error('fee_attribution_token_mismatch');
  }
}

export interface FreshApplyState { position: FreshPosition | null; lots: FreshLot[]; feeAlreadyApplied?: boolean; internalTransferPaired?: boolean; }
/** Apply exactly one normalized execution. Caller provides FIFO lots for one scope/token. */
export function applyFreshEvent(scope: FreshScope, event: FreshFinancialEvent, state: FreshApplyState): { position: FreshPosition | null; lots: FreshLot[]; result: FreshEventResult } {
  validateFreshFinancialEvent(event);
  if(!freshEventAccountingEligible(event))throw new Error('fee_outside_accounting_scope');
  if (!inScope(scope, event)) throw new Error('event_outside_scope');
  const lots = state.lots.map(v => ({ ...v }));
  const position = event.tokenAddress ? { ...(state.position ?? freshEmptyPosition(scope.id, event.tokenAddress)) } : null;
  const fee = state.feeAlreadyApplied ? zero : nullable(event.feeUsd), amount = nullable(event.amountUsd), quantity = positive(event.quantity);
  const result: FreshEventResult = { scopeId: scope.id, eventId: event.id, tokenAddress: event.tokenAddress, realizedQ: '0', knownRealizedQ: '0', capitalQ: '0', feeQ: fee?.exact() ?? null,
    feeKey: state.feeAlreadyApplied ? null : event.feeKey, tradeCount: event.kind === 'buy' || event.kind === 'sell' ? 1 : 0, volumeQ: event.kind === 'buy' || event.kind === 'sell' ? amount?.exact() ?? '0' : '0', tokensTrade: event.kind === 'buy' || event.kind === 'sell', occurredAt: event.occurredAt };
  if (!position) { result.realizedQ = fee ? zero.sub(fee).exact() : null; result.knownRealizedQ = result.realizedQ ?? '0'; return { position, lots, result }; }
  const internal = event.counterparty !== null && inScope(scope, { ...event, walletAddress: event.counterparty }) && event.kind.startsWith('transfer_');
  if (internal && (!event.transferKey || !state.internalTransferPaired)) throw new Error('internal_transfer_unreconciled');
  const consume = () => {
    let remaining = quantity, cost: FreshRational | null = zero; const parts: FreshLot[] = [];
    for (const lot of lots.filter(v => v.walletAddress === event.walletAddress).sort(lotOrder)) {
      if (!remaining.n) break;
      const available = q(lot.quantityQ), used = available.compare(remaining) > 0 ? remaining : available;
      const partCost = lot.costQ === null || !lot.feeKnown ? null : q(lot.costQ).mul(used).div(available);
      parts.push({ ...lot, quantityQ: used.exact(), costQ: partCost?.exact() ?? null });
      cost = cost !== null && partCost !== null ? cost.add(partCost) : null;
      lot.quantityQ = available.sub(used).exact();
      if (lot.costQ !== null) lot.costQ = q(lot.costQ).sub(q(lot.costQ).mul(used).div(available)).exact();
      remaining = remaining.sub(used);
    }
    if (remaining.n) { cost = null; position.unknownCost = true; parts.push({ id: `${event.id}:missing`, scopeId: scope.id, tokenAddress: event.tokenAddress!, walletAddress: event.walletAddress,
      acquiredEventId: event.id, acquiredBlock: event.blockNumber, acquiredTransactionIndex: event.transactionIndex, acquiredExecutionIndex: event.executionIndex, quantityQ: remaining.exact(), costQ: null, feeKnown: false }); }
    return { cost, parts };
  };
  if (fee) position.feesQ = add(position.feesQ, fee); else position.unknownFee = true;
  if(event.kind==='fee'){
    result.realizedQ=fee?zero.sub(fee).exact():null;
  }else if (internal && event.kind === 'transfer_in') {
    // The outgoing half moved the original lots; this half only owns its own authenticated fee.
    result.realizedQ = fee ? zero.sub(fee).exact() : null;
  } else if (event.kind === 'buy' || event.kind === 'transfer_in') {
    const cost = amount !== null && fee !== null ? amount.add(fee) : null;
    if (event.kind === 'buy') position.investedQ = add(position.investedQ, amount ?? zero); else position.incomingQ = add(position.incomingQ, amount ?? zero);
    if(amount===null){if(event.kind==='buy')position.unknownPurchaseValue=true;else position.unknownIncomingValue=true;}
    position.capitalQ = add(position.capitalQ, (amount ?? zero).add(fee ?? zero));
    if (cost === null) position.unknownCost = true;
    lots.push({ id: `${scope.id}:${event.id}`, scopeId: scope.id, tokenAddress: event.tokenAddress!, walletAddress: event.walletAddress, acquiredEventId: event.id,
      acquiredBlock: event.blockNumber, acquiredTransactionIndex: event.transactionIndex, acquiredExecutionIndex: event.executionIndex, quantityQ: quantity.exact(), costQ: cost?.exact() ?? null, feeKnown: fee !== null });
  } else if (event.kind === 'sell' || event.kind === 'transfer_out') {
    const consumed = consume();
    if (internal) {
      for (let i = 0; i < consumed.parts.length; i++) lots.push({ ...consumed.parts[i], id: `${scope.id}:${event.id}:carry:${i}`, walletAddress: event.counterparty! });
      result.realizedQ = fee ? zero.sub(fee).exact() : null;
    } else {
      if (event.kind === 'sell') position.soldQ = add(position.soldQ, amount ?? zero); else position.outgoingQ = add(position.outgoingQ, amount ?? zero);
      if(amount===null){if(event.kind==='sell')position.unknownSaleValue=true;else position.unknownOutgoingValue=true;}
      result.realizedQ = amount !== null && consumed.cost !== null && fee !== null ? amount.sub(consumed.cost).sub(fee).exact() : null;
      result.capitalQ = (consumed.cost ?? zero).add(fee ?? zero).exact();
      if (consumed.cost === null || amount === null) position.unknownCost = true;
    }
  }
  result.knownRealizedQ = result.realizedQ ?? '0';
  position.realizedQ = position.realizedQ !== null && result.realizedQ !== null ? add(position.realizedQ, q(result.realizedQ)) : null;
  position.quantityQ = sum(lots.filter(v => q(v.quantityQ).n > 0n).map(v => v.quantityQ)).exact();
  position.lastEventId = event.id; position.lastEventAt = event.occurredAt; position.revision = `${BigInt(position.revision) + 1n}`;
  return { position, lots: lots.filter(v => q(v.quantityQ).n > 0n), result };
}

/** No history reads: current position + current open lots + current quote only. */
export function summarizeFreshPosition(position: FreshPosition, lots: FreshLot[], priceUsd: string | null): FreshPositionSummary {
  const quantity = q(position.quantityQ), price = nullable(priceUsd), value = price === null ? null : quantity.mul(price);
  const costsKnown = !position.unknownCost && lots.every(l => l.costQ !== null && l.feeKnown), remaining = costsKnown ? sum(lots.map(l => l.costQ!)) : null;
  const complete = costsKnown && !position.unknownFee;
  const profit = complete && (value !== null || quantity.n === 0n) ? q(position.soldQ).add(q(position.outgoingQ)).add(value ?? zero).sub(q(position.investedQ)).sub(q(position.incomingQ)).sub(q(position.feesQ)) : null;
  return { scopeId: position.scopeId, tokenAddress: position.tokenAddress, quantity: quantity.decimal(255), remainingCostUsd: remaining?.decimal() ?? null,
    investedUsd: position.unknownPurchaseValue?null:q(position.investedQ).decimal(), soldUsd:position.unknownSaleValue?null:q(position.soldQ).decimal(), incomingTransferCostUsd:position.unknownIncomingValue?null:q(position.incomingQ).decimal(), transferOutIncomeUsd:position.unknownOutgoingValue?null:q(position.outgoingQ).decimal(),
    feesUsd:position.unknownFee?null:q(position.feesQ).decimal(), capitalUsd:position.unknownCost||position.unknownFee?null:q(position.capitalQ).decimal(), realizedProfitUsd: freshDecimal(position.realizedQ), valueUsd: value?.decimal() ?? (quantity.n === 0n ? '0' : null),
    estimatedProfitUsd: quantity.n === 0n && complete ? freshDecimal(position.realizedQ) : profit?.decimal() ?? null,
    roi: profit && q(position.capitalQ).n > 0n ? profit.div(q(position.capitalQ)).decimal() : null,
    status: !costsKnown ? 'unknown_costs' : position.unknownFee ? 'unknown_fees' : value === null && quantity.n !== 0n ? 'quote_unavailable' : 'complete' };
}

type Row = Record<string, any>;
export function freshEventFromRow(row: Row): FreshFinancialEvent {
  return { id: row.id, executionKey: row.execution_key, walletAddress: row.wallet_address, tokenAddress: row.token_address,
    kind: row.kind, quantity: row.quantity, amountUsd: row.amount_usd, feeUsd: row.fee_usd, feeKey: row.fee_key,
    counterparty: row.counterparty, transferKey: row.transfer_key, blockNumber: `${row.block_number}`, blockHash: row.block_hash,
    transactionHash: row.transaction_hash, transactionIndex: row.transaction_index, executionIndex: row.execution_index, logIndex: row.log_index,
    occurredAt: new Date(row.occurred_at).toISOString(), canonical: row.canonical,...(row.acquisition_cost?{acquisitionCost:row.acquisition_cost}:{}),...(row.fee_attribution?{feeAttribution:row.fee_attribution}:{}),
    ...(row.quote_amount!=null?{quoteAddress:row.quote_address,quoteSymbol:row.quote_symbol,quoteAmount:row.quote_amount}:{}) };
}
export function freshScopeFromRow(row: Row): FreshScope {
  return { id: row.id, kind: row.kind, walletAddresses: row.wallet_addresses, accountId: row.account_id,
    startsAt: new Date(row.starts_at).toISOString(), startsBlock: `${row.starts_block}`, revision: `${row.revision}` };
}
export function freshPositionFromRow(row: Row): FreshPosition {
  return { scopeId: row.scope_id, tokenAddress: row.token_address, quantityQ: row.quantity_q, investedQ: row.invested_q, soldQ: row.sold_q,
    incomingQ: row.incoming_q, outgoingQ: row.outgoing_q, feesQ: row.fees_q, capitalQ: row.capital_q, realizedQ: row.realized_q,
    unknownCost: row.unknown_cost, unknownFee: row.unknown_fee, lastEventId: row.last_event_id,
    unknownPurchaseValue:row.unknown_purchase_value,unknownSaleValue:row.unknown_sale_value,unknownIncomingValue:row.unknown_incoming_value,unknownOutgoingValue:row.unknown_outgoing_value,
    lastEventAt: row.last_event_at ? new Date(row.last_event_at).toISOString() : null, revision: `${row.revision}` };
}
export function freshLotFromRow(row: Row): FreshLot {
  return { id: row.id, scopeId: row.scope_id, tokenAddress: row.token_address, walletAddress: row.wallet_address,
    acquiredEventId: row.acquired_event_id, acquiredBlock: `${row.acquired_block}`, acquiredTransactionIndex: row.acquired_transaction_index,
    acquiredExecutionIndex: row.acquired_execution_index, quantityQ: row.quantity_q, costQ: row.cost_q, feeKnown: row.fee_known };
}
const eventFingerprint = (event: FreshFinancialEvent) => createHash('sha256').update(JSON.stringify([event.id,event.executionKey,event.walletAddress,event.tokenAddress,event.kind,event.quantity,event.amountUsd,event.feeUsd,event.feeKey,event.counterparty,event.transferKey,
  event.blockNumber,event.blockHash,event.transactionHash,event.transactionIndex,event.executionIndex,event.logIndex,new Date(event.occurredAt).toISOString(),event.canonical!==false,
  freshAcquisitionCostKey(event.acquisitionCost),event.feeAttribution?[event.feeAttribution.status,event.feeAttribution.tokenAddress??null,event.feeAttribution.contract??null,event.feeAttribution.selector??null,event.feeAttribution.nativeFeeWei,
    ...(event.feeAttribution.expensePolicy?[event.feeAttribution.expensePolicy,event.feeAttribution.batchExpenseNativeWei,event.feeAttribution.gasNativeWei]:[])]:null])).digest('hex');

async function rollKolDay(client:PoolClient,wallet:string,day:string){await client.query(`UPDATE fresh.kols SET today_utc=$2,today_realized_q='0',today_known_realized_q='0',today_capital_q='0',today_volume_q='0',today_trade_count=0,today_buy_count=0,today_sell_count=0,today_token_count=0,today_unknown_count=0,
  today_valued_sell_count=0,today_unknown_sell_count=0,today_valued_transfer_count=0,today_unknown_transfer_count=0,today_valued_fee_count=0,today_unknown_fee_count=0,today_fee_only_q='0',
  today_unallocated_fee_count=0,today_unallocated_fee_q='0',today_unallocated_fee_unknown_count=0,today_unattributed_fee_count=0,metrics_updated_at=clock_timestamp(),revision=revision+1 WHERE wallet_address=$1 AND today_utc IS DISTINCT FROM $2::date`,[wallet,day]);}

async function recordUnallocatedFee(client:PoolClient,event:FreshFinancialEvent,scopes:FreshScope[],day:string){
  for(const scope of scopes){if(!inScope(scope,event))continue;
    const row=(await client.query('SELECT unallocated_fee_q FROM fresh.accounting_scopes WHERE id=$1 FOR UPDATE',[scope.id])).rows[0];
    await client.query(`UPDATE fresh.accounting_scopes SET unallocated_fee_count=unallocated_fee_count+1,unallocated_fee_q=$2,
      unallocated_fee_unknown_count=unallocated_fee_unknown_count+$3,unattributed_fee_count=unattributed_fee_count+$4 WHERE id=$1`,
    [scope.id,add(row.unallocated_fee_q,q(event.feeUsd??'0')),event.feeUsd===null?1:0,event.feeAttribution?.status==='excluded'?0:1]);
    if(scope.kind==='kol'&&freshUtcDay(event.occurredAt)===day){const wallet=scope.walletAddresses[0];await rollKolDay(client,wallet,day);const kol=(await client.query('SELECT today_unallocated_fee_q FROM fresh.kols WHERE wallet_address=$1 FOR UPDATE',[wallet])).rows[0];
      await client.query(`UPDATE fresh.kols SET today_unallocated_fee_count=today_unallocated_fee_count+1,today_unallocated_fee_q=$2,
        today_unallocated_fee_unknown_count=today_unallocated_fee_unknown_count+$3,today_unattributed_fee_count=today_unattributed_fee_count+$4,metrics_updated_at=clock_timestamp(),revision=revision+1 WHERE wallet_address=$1`,
      [wallet,add(kol.today_unallocated_fee_q,q(event.feeUsd??'0')),event.feeUsd===null?1:0,event.feeAttribution?.status==='excluded'?0:1]);}
  }
}

/** Must be called inside the transaction that advances decode progress. No network I/O. */
export async function applyFreshFinancialEvents(client: PoolClient, incoming: FreshFinancialEvent[], options: { scopes?: FreshScope[]; now?: string | Date | number; updateTokenCounters?: boolean } = {}) {
  const events = [...incoming].sort(freshEventOrder), now = options.now ?? Date.now(), day = freshUtcDay(now);
  for (const event of events) validateFreshFinancialEvent(event);
  const wallets = [...new Set(events.map(v => v.walletAddress))];
  const scopes = (options.scopes ?? (await client.query('SELECT * FROM fresh.accounting_scopes WHERE active AND wallet_addresses && $1::text[] ORDER BY id', [wallets])).rows.map(freshScopeFromRow)).sort((a, b) => a.id.localeCompare(b.id));
  if(events.some(event=>event.tokenAddress===GANG_TOKEN_ADDRESS))for(const scope of scopes)await hydrateFreshScopeTokenHistory(client,scope,{lock:true});
  for (const scope of scopes) if (scope.accountId && !scope.walletStarts) {
    const members = (await client.query('SELECT wallet_address,activity_from,registration_block FROM public.journal_wallets WHERE user_id::text=$1', [scope.accountId])).rows;
    scope.walletStarts = Object.fromEntries(members.map(row => [row.wallet_address, { startsAt: new Date(row.activity_from).toISOString(), startsBlock: `${row.registration_block ?? scope.startsBlock}` }]));
    scope.walletAddresses = scope.walletAddresses.filter(address => scope.walletStarts?.[address]);
  }
  for (const scope of scopes) await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`fresh-scope:${scope.id}`]);
  if(events.length)for(const scope of scopes)if(scope.kind==='kol')await advanceFreshRollingKolTotals(client,scope.walletAddresses[0],now);
  await client.query('SELECT address FROM fresh.tokens WHERE address=ANY($1::text[]) ORDER BY address FOR UPDATE', [[...new Set(events.flatMap(event => event.tokenAddress ? [event.tokenAddress] : []))]]);
  let inserted = 0, applied = 0;
  const transferValuationSeeds:{scopeId:string;tokenAddress:string;tradeEventId:string}[]=[];
  for (const event of events) {
    const saved = await client.query(`INSERT INTO fresh.financial_events(id,execution_key,wallet_address,token_address,kind,quantity,amount_usd,fee_usd,fee_key,counterparty,transfer_key,
      block_number,block_hash,transaction_hash,transaction_index,execution_index,log_index,occurred_at,canonical,fee_attribution,quote_address,quote_symbol,quote_amount,acquisition_cost)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20::jsonb,$21,$22,$23,$24::jsonb) ON CONFLICT DO NOTHING RETURNING id`,
    [event.id, event.executionKey, event.walletAddress, event.tokenAddress, event.kind, event.quantity, event.amountUsd, event.feeUsd, event.feeKey, event.counterparty, event.transferKey,
      event.blockNumber, event.blockHash, event.transactionHash, event.transactionIndex, event.executionIndex, event.logIndex, event.occurredAt, event.canonical !== false,event.feeAttribution?JSON.stringify(event.feeAttribution):null,event.quoteAddress??null,event.quoteSymbol??null,event.quoteAmount??null,event.acquisitionCost?JSON.stringify(event.acquisitionCost):null]);
    if (saved.rowCount) inserted++;
    else {
      const prior = (await client.query('SELECT * FROM fresh.financial_events WHERE id=$1 OR execution_key=$2', [event.id, event.executionKey])).rows;
      if (prior.length !== 1 || eventFingerprint(freshEventFromRow(prior[0])) !== eventFingerprint(event)) throw new Error('conflicting_financial_evidence');
      assertFreshEventQuoteCompatible(freshEventFromRow(prior[0]),event);
      if(event.quoteAmount!=null&&prior[0].quote_amount==null)await persistFreshTradeQuote(client,event);
    }
    if (event.canonical === false) continue;
    if(!freshEventAccountingEligible(event)){if(saved.rowCount){await recordUnallocatedFee(client,event,scopes,day);for(const scope of scopes)if(inScope(scope,event))await addFreshRollingKolExcludedFee(client,scope,event,now);}continue;}
    let newPublicResult = false;
    for (const scope of scopes) {
      if (!inScope(scope, event)) continue;
      if ((await client.query('SELECT 1 FROM fresh.scope_event_results WHERE scope_id=$1 AND event_id=$2', [scope.id, event.id])).rowCount) continue;
      const previousPositionRow = event.tokenAddress ? (await client.query('SELECT * FROM fresh.positions WHERE scope_id=$1 AND token_address=$2 FOR UPDATE', [scope.id, event.tokenAddress])).rows[0] : null;
      const previous = previousPositionRow ? freshPositionFromRow(previousPositionRow) : null;
      if (previous?.lastEventId) {
        const last = (await client.query('SELECT * FROM fresh.financial_events WHERE id=$1', [previous.lastEventId])).rows[0];
        if (last && freshEventOrder(freshEventFromRow(last), event) > 0) throw new Error('out_of_order_financial_event_requires_repair');
      }
      const oldLots = event.tokenAddress ? (await client.query('SELECT * FROM fresh.open_lots WHERE scope_id=$1 AND token_address=$2', [scope.id, event.tokenAddress])).rows.map(freshLotFromRow) : [];
      const priorFees = event.feeKey ? (await client.query('SELECT fee_q FROM fresh.scope_event_results WHERE scope_id=$1 AND fee_key=$2 LIMIT 1', [scope.id, event.feeKey])).rows : [];
      if (priorFees.length && (event.feeUsd === null || priorFees[0].fee_q === null || q(priorFees[0].fee_q).compare(q(event.feeUsd)) !== 0)) throw new Error('conflicting_authenticated_fee');
      const internal = event.counterparty !== null && inScope(scope, { ...event, walletAddress: event.counterparty }) && event.kind.startsWith('transfer_');
      let internalTransferPaired = false;
      if (internal && event.transferKey) {
        const opposite = event.kind === 'transfer_in' ? 'transfer_out' : 'transfer_in';
        const matches = (await client.query(`SELECT * FROM fresh.financial_events WHERE canonical AND transfer_key=$1 AND kind=$2 AND token_address=$3 AND wallet_address=$4 AND counterparty=$5`,
          [event.transferKey, opposite, event.tokenAddress, event.counterparty, event.walletAddress])).rows.map(freshEventFromRow);
        const pending = events.filter(v => v.canonical !== false && v.transferKey === event.transferKey && v.kind === opposite && v.tokenAddress === event.tokenAddress && v.walletAddress === event.counterparty && v.counterparty === event.walletAddress);
        const candidates = new Map([...matches, ...pending].map(v => [v.id, v]));
        internalTransferPaired = candidates.size === 1 && [...candidates.values()].every(v => q(v.quantity).compare(q(event.quantity)) === 0 && v.transactionHash === event.transactionHash && v.blockHash === event.blockHash);
      }
      const output = applyFreshEvent(scope, event, { position: previous, lots: oldLots, feeAlreadyApplied: priorFees.length > 0, internalTransferPaired });
      const firstTokenToday = scope.kind === 'kol' && output.result.tokensTrade && freshUtcDay(event.occurredAt) === day
        && !(await client.query(`SELECT 1 FROM fresh.scope_event_results WHERE scope_id=$1 AND token_address=$2 AND tokens_trade
          AND occurred_at >= ($3::date::timestamp AT TIME ZONE 'UTC') AND occurred_at < (($3::date+1)::timestamp AT TIME ZONE 'UTC') LIMIT 1`, [scope.id, event.tokenAddress, day])).rowCount;
      const r = output.result;
      await client.query(`INSERT INTO fresh.scope_event_results(scope_id,event_id,token_address,realized_q,known_realized_q,capital_q,fee_q,fee_key,trade_count,volume_q,tokens_trade,occurred_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [r.scopeId, r.eventId, r.tokenAddress, r.realizedQ, r.knownRealizedQ, r.capitalQ, r.feeQ, r.feeKey, r.tradeCount, r.volumeQ, r.tokensTrade, r.occurredAt]);
      await addFreshRollingKolResult(client,scope,event,r,now);
      if (event.kind === 'fee'&&event.tokenAddress===null) {
        const row = (await client.query('SELECT fee_only_realized_q,fee_only_fees_q FROM fresh.accounting_scopes WHERE id=$1 FOR UPDATE', [scope.id])).rows[0];
        await client.query('UPDATE fresh.accounting_scopes SET fee_only_realized_q=$2,fee_only_fees_q=$3,fee_only_unknown_count=fee_only_unknown_count+$4 WHERE id=$1',
          [scope.id,row.fee_only_realized_q !== null && r.realizedQ !== null ? add(row.fee_only_realized_q,q(r.realizedQ)) : null,add(row.fee_only_fees_q,q(r.feeQ ?? '0')),r.feeQ === null ? 1 : 0]);
      }
      if (output.position) {
        const p = output.position;
        await client.query(`INSERT INTO fresh.positions(scope_id,token_address,quantity_q,invested_q,sold_q,incoming_q,outgoing_q,fees_q,capital_q,realized_q,unknown_cost,unknown_fee,last_event_id,last_event_at,revision,unknown_purchase_value,unknown_sale_value,unknown_incoming_value,unknown_outgoing_value)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) ON CONFLICT(scope_id,token_address) DO UPDATE SET quantity_q=excluded.quantity_q,invested_q=excluded.invested_q,
          sold_q=excluded.sold_q,incoming_q=excluded.incoming_q,outgoing_q=excluded.outgoing_q,fees_q=excluded.fees_q,capital_q=excluded.capital_q,realized_q=excluded.realized_q,
          unknown_cost=excluded.unknown_cost,unknown_fee=excluded.unknown_fee,last_event_id=excluded.last_event_id,last_event_at=excluded.last_event_at,revision=excluded.revision,balance_status='pending',
          unknown_purchase_value=excluded.unknown_purchase_value,unknown_sale_value=excluded.unknown_sale_value,unknown_incoming_value=excluded.unknown_incoming_value,unknown_outgoing_value=excluded.unknown_outgoing_value`,
        [p.scopeId,p.tokenAddress,p.quantityQ,p.investedQ,p.soldQ,p.incomingQ,p.outgoingQ,p.feesQ,p.capitalQ,p.realizedQ,p.unknownCost,p.unknownFee,p.lastEventId,p.lastEventAt,p.revision,p.unknownPurchaseValue,p.unknownSaleValue,p.unknownIncomingValue,p.unknownOutgoingValue]);
        const retained = new Set(output.lots.map(v => v.id));
        for (const lot of oldLots) if (!retained.has(lot.id)) await client.query('DELETE FROM fresh.open_lots WHERE id=$1', [lot.id]);
        const old = new Map(oldLots.map(v => [v.id, v]));
        for (const lot of output.lots) {
          if (JSON.stringify(old.get(lot.id)) === JSON.stringify(lot)) continue;
          await client.query(`INSERT INTO fresh.open_lots(id,scope_id,token_address,wallet_address,acquired_event_id,acquired_block,acquired_transaction_index,acquired_execution_index,quantity_q,cost_q,fee_known)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(id) DO UPDATE SET quantity_q=excluded.quantity_q,cost_q=excluded.cost_q,wallet_address=excluded.wallet_address,fee_known=excluded.fee_known`,
          [lot.id,lot.scopeId,lot.tokenAddress,lot.walletAddress,lot.acquiredEventId,lot.acquiredBlock,lot.acquiredTransactionIndex,lot.acquiredExecutionIndex,lot.quantityQ,lot.costQ,lot.feeKnown]);
        }
      }
      if (scope.kind === 'kol') {
        newPublicResult = true;
        const wallet = scope.walletAddresses[0];
        await rollKolDay(client,wallet,day);
        const kol = (await client.query('SELECT * FROM fresh.kols WHERE wallet_address=$1 FOR UPDATE', [wallet])).rows[0];
        if (!kol) throw new Error('kol_scope_without_identity');
        const isToday = freshUtcDay(event.occurredAt) === day;
        await client.query(`UPDATE fresh.kols SET today_realized_q=$2,today_capital_q=$3,today_volume_q=$4,today_trade_count=today_trade_count+$5,today_token_count=today_token_count+$6,
          today_unknown_count=today_unknown_count+$7,last_trade_at=CASE WHEN $8::timestamptz IS NULL THEN last_trade_at ELSE greatest(last_trade_at,$8::timestamptz) END,
          today_known_realized_q=$9,today_buy_count=today_buy_count+$10,today_sell_count=today_sell_count+$11,
          today_valued_sell_count=today_valued_sell_count+$12,today_unknown_sell_count=today_unknown_sell_count+$13,
          today_valued_transfer_count=today_valued_transfer_count+$14,today_unknown_transfer_count=today_unknown_transfer_count+$15,
          today_valued_fee_count=today_valued_fee_count+$16,today_unknown_fee_count=today_unknown_fee_count+$17,today_fee_only_q=$18,metrics_updated_at=clock_timestamp(),revision=revision+1 WHERE wallet_address=$1`,
        [wallet,isToday ? kol.today_realized_q !== null && r.realizedQ !== null ? add(kol.today_realized_q,q(r.realizedQ)) : null : kol.today_realized_q,
          isToday ? add(kol.today_capital_q,q(r.capitalQ)) : kol.today_capital_q,isToday ? add(kol.today_volume_q,q(r.volumeQ)) : kol.today_volume_q,
          isToday ? r.tradeCount : 0,firstTokenToday ? 1 : 0,isToday && r.realizedQ === null ? 1 : 0,r.tradeCount ? event.occurredAt : null,
          isToday ? add(kol.today_known_realized_q,q(r.knownRealizedQ)) : kol.today_known_realized_q,isToday && event.kind === 'buy' ? 1 : 0,isToday && event.kind === 'sell' ? 1 : 0,
          isToday&&event.kind==='sell'&&r.realizedQ!==null?1:0,isToday&&event.kind==='sell'&&r.realizedQ===null?1:0,
          isToday&&event.kind==='transfer_out'&&r.realizedQ!==null?1:0,isToday&&event.kind==='transfer_out'&&r.realizedQ===null?1:0,
          isToday&&event.kind==='fee'&&r.realizedQ!==null?1:0,isToday&&event.kind==='fee'&&r.realizedQ===null?1:0,
          isToday&&event.kind==='fee'?add(kol.today_fee_only_q,q(r.feeQ??'0')):kol.today_fee_only_q]);
      }
      if(event.tokenAddress&&(event.kind==='buy'||event.kind==='sell'))transferValuationSeeds.push({scopeId:scope.id,tokenAddress:event.tokenAddress,tradeEventId:event.id});
      applied++;
    }
    if (options.updateTokenCounters !== false && newPublicResult && event.tokenAddress && (event.kind === 'buy' || event.kind === 'sell')) {
      // One canonical public event, independent of how many private scopes subscribe to it.
      await client.query(`UPDATE fresh.tokens SET today_utc=$2,today_buy_count=0,today_sell_count=0,today_kol_count=0,today_volume_q='0'
        WHERE address=$1 AND today_utc IS DISTINCT FROM $2::date`, [event.tokenAddress,day]);
      const token = (await client.query('SELECT tracked_volume_q,today_volume_q FROM fresh.tokens WHERE address=$1 FOR UPDATE', [event.tokenAddress])).rows[0];
      if (!token) throw new Error('financial_event_without_token_identity');
      const today=freshUtcDay(event.occurredAt)===day;
      const firstKolToday=today&&!(await client.query(`SELECT 1 FROM fresh.financial_events e JOIN fresh.scope_event_results r ON r.event_id=e.id JOIN fresh.accounting_scopes s ON s.id=r.scope_id
        WHERE e.canonical AND s.kind='kol' AND e.wallet_address=$1 AND e.token_address=$2 AND e.kind IN('buy','sell') AND e.id<>$3
        AND e.occurred_at >= ($4::date::timestamp AT TIME ZONE 'UTC') AND e.occurred_at < (($4::date+1)::timestamp AT TIME ZONE 'UTC') LIMIT 1`,[event.walletAddress,event.tokenAddress,event.id,day])).rowCount;
      await client.query(`UPDATE fresh.tokens SET tracked_trade_count=tracked_trade_count+1,tracked_buy_count=tracked_buy_count+$2,tracked_sell_count=tracked_sell_count+$3,
        tracked_volume_q=$4,last_trade_at=greatest(last_trade_at,$5::timestamptz),today_buy_count=today_buy_count+$6,today_sell_count=today_sell_count+$7,
        today_volume_q=$8,today_kol_count=today_kol_count+$9,revision=revision+1 WHERE address=$1`,
      [event.tokenAddress,event.kind === 'buy' ? 1 : 0,event.kind === 'sell' ? 1 : 0,add(token.tracked_volume_q,q(event.amountUsd ?? '0')),event.occurredAt,
        today&&event.kind==='buy'?1:0,today&&event.kind==='sell'?1:0,today?add(token.today_volume_q,q(event.amountUsd??'0')):token.today_volume_q,firstKolToday?1:0]);
    }
  }
  if(transferValuationSeeds.length)await queueFreshTransferValuation(client,transferValuationSeeds,new Date(now));
  return { inserted, applied };
}

/** Cheap bounded current-row reset. Run independently of trade arrival. Lots never reset. */
export async function rolloverFreshUtcDay(client: PoolClient, now: string | Date | number = Date.now()) {
  const result = await client.query(`UPDATE fresh.kols SET today_utc=$1,today_realized_q='0',today_known_realized_q='0',today_capital_q='0',today_volume_q='0',today_trade_count=0,today_buy_count=0,today_sell_count=0,today_token_count=0,today_unknown_count=0,
    today_valued_sell_count=0,today_unknown_sell_count=0,today_valued_transfer_count=0,today_unknown_transfer_count=0,today_valued_fee_count=0,today_unknown_fee_count=0,today_fee_only_q='0',today_unallocated_fee_count=0,today_unallocated_fee_q='0',today_unallocated_fee_unknown_count=0,today_unattributed_fee_count=0,metrics_updated_at=clock_timestamp(),revision=revision+1 WHERE today_utc IS DISTINCT FROM $1::date`, [freshUtcDay(now)]);
  await client.query(`UPDATE fresh.tokens SET today_utc=$1,today_buy_count=0,today_sell_count=0,today_kol_count=0,today_volume_q='0',revision=revision+1 WHERE today_utc IS DISTINCT FROM $1::date`,[freshUtcDay(now)]);
  return result.rowCount ?? 0;
}

/** Exceptional repair only: replay compact retained facts, never RPC or archived responses. */
export async function rebuildFreshScopesAfterReorg(client: PoolClient, scopeIds: string[], now: string | Date | number = Date.now()) {
  const scopes = (await client.query('SELECT * FROM fresh.accounting_scopes WHERE id=ANY($1::text[]) ORDER BY id', [scopeIds])).rows.map(freshScopeFromRow);
  for(const scope of scopes)await hydrateFreshScopeTokenHistory(client,scope,{lock:true});
  for (const scope of scopes) await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`fresh-scope:${scope.id}`]);
  const affectedTokens = new Set<string>();
  for (const scope of scopes) {
    for (const row of (await client.query('SELECT token_address FROM fresh.positions WHERE scope_id=$1', [scope.id])).rows) affectedTokens.add(row.token_address);
    await client.query('DELETE FROM fresh.open_lots WHERE scope_id=$1', [scope.id]);
    await client.query('DELETE FROM fresh.positions WHERE scope_id=$1', [scope.id]);
    await client.query('DELETE FROM fresh.scope_event_results WHERE scope_id=$1', [scope.id]);
    await client.query("UPDATE fresh.accounting_scopes SET revision=revision+1,correction_epoch=correction_epoch+1,fee_only_realized_q='0',fee_only_fees_q='0',fee_only_unknown_count=0,unallocated_fee_count=0,unallocated_fee_q='0',unallocated_fee_unknown_count=0,unattributed_fee_count=0 WHERE id=$1", [scope.id]);
    if (scope.kind === 'kol') await client.query(`UPDATE fresh.kols SET rolling_as_of=NULL,today_utc=$2,today_realized_q='0',today_known_realized_q='0',today_capital_q='0',today_volume_q='0',today_trade_count=0,today_buy_count=0,today_sell_count=0,today_token_count=0,today_unknown_count=0,last_trade_at=NULL,
      today_valued_sell_count=0,today_unknown_sell_count=0,today_valued_transfer_count=0,today_unknown_transfer_count=0,today_valued_fee_count=0,today_unknown_fee_count=0,today_fee_only_q='0',today_unallocated_fee_count=0,today_unallocated_fee_q='0',today_unallocated_fee_unknown_count=0,today_unattributed_fee_count=0,metrics_updated_at=clock_timestamp(),revision=revision+1 WHERE wallet_address=$1`, [scope.walletAddresses[0], freshUtcDay(now)]);
    const events = (await client.query(`SELECT e.* FROM fresh.financial_events e JOIN fresh.accounting_scopes s ON s.id=$1 WHERE e.canonical AND e.wallet_address=ANY(s.wallet_addresses) AND ${freshScopeEventSql('e','s')} ORDER BY e.block_number,e.transaction_index,e.execution_index,e.log_index NULLS FIRST,e.id`,
      [scope.id])).rows.map(freshEventFromRow);
    for (const event of events) if (event.tokenAddress) affectedTokens.add(event.tokenAddress);
    await applyFreshFinancialEvents(client, events, { scopes: [scope], now, updateTokenCounters: false });
    for(const event of events)if(!freshEventAccountingEligible(event)&&inScope(scope,event))await recordUnallocatedFee(client,event,[scope],freshUtcDay(now));
    if(scope.kind==='kol')await rebuildFreshRollingKolTotals(client,scope.walletAddresses[0],now);
  }
  for (const token of affectedTokens) {
    const events = (await client.query(`SELECT DISTINCT e.id,e.wallet_address,e.amount_usd,e.kind,e.occurred_at FROM fresh.financial_events e JOIN fresh.scope_event_results r ON r.event_id=e.id JOIN fresh.accounting_scopes s ON s.id=r.scope_id
      WHERE e.canonical AND e.token_address=$1 AND e.kind IN ('buy','sell') AND s.kind='kol'`, [token])).rows;
    const today=events.filter(event=>freshUtcDay(new Date(event.occurred_at))===freshUtcDay(now));
    await client.query(`UPDATE fresh.tokens SET tracked_trade_count=$2,tracked_buy_count=$3,tracked_sell_count=$4,tracked_volume_q=$5,last_trade_at=$6,
      today_utc=$7,today_buy_count=$8,today_sell_count=$9,today_kol_count=$10,today_volume_q=$11,revision=revision+1 WHERE address=$1`,
      [token,events.length,events.filter(v=>v.kind==='buy').length,events.filter(v=>v.kind==='sell').length,sum(events.map(v=>v.amount_usd ?? '0')).exact(),events.length ? new Date(Math.max(...events.map(v=>new Date(v.occurred_at).getTime()))).toISOString() : null,
        freshUtcDay(now),today.filter(e=>e.kind==='buy').length,today.filter(e=>e.kind==='sell').length,new Set(today.map(e=>e.wallet_address)).size,sum(today.map(e=>e.amount_usd??'0')).exact()]);
  }
  return { rebuiltScopes: scopes.length, tokens: affectedTokens.size };
}
