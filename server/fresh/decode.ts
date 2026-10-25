import{isFreshSettlementQuote,freshSettlementQuoteSymbol}from'./settlementQuote.js';
import{freshAcquisitionCostKey}from'./acquisitionCost.js';
import{freshSignedSelfCallSettlement}from'./signedSelfCallSettlement.js';
import { createHash } from 'node:crypto';
import{freshPassiveIncomingOnly}from'./passiveIncoming.js';
import{certifyFreshPassiveImportedPrecision}from'./passivePrecision.js';
import{createFreshDecodeWorkBudget,groupFreshDecodeRows}from'./decodeWorkBudget.js';
import {invalidateFreshNotificationActivation} from './notificationActivation.js';
import { Interface } from 'ethers';
import type { Pool, PoolClient } from 'pg';
import { transferTopic, hasRecognizedSwap, nativeSellProceeds } from '../swap.js';
import { beforeExecutionTopic, userOperationTopic } from '../smartAccountTrades.js';
import { FOUR_MANAGERS, FLAP_PORTAL, WBNB } from '../launchpad.js';
import { fourMarketAbi, flapMarketAbi, TRUSTED_QUOTE_FEEDS, v3MarketAbi, infinityMarketAbi, infinityBinMarketAbi } from '../nodeMarketProtocols.js';
import { isKolProfileToken, isExcludedKolProfileTokenAddress } from '../kolProfileToken.js';
import {RpcRequestError,type Rpc} from '../rpc.js';
import type { FreshFinancialEvent } from '../../shared/freshAccounting.js';
import { applyFreshFinancialEvents,validateFreshFinancialEvent, FreshRational, rebuildFreshScopesAfterReorg, freshEventFromRow, freshEventOrder, freshEventAccountingEligible,assertFreshEventQuoteCompatible,freshSameTradeQuoteContext,persistFreshTradeQuote } from './accounting.js';
import { FRESH_ENTRY_POINTS, decodeFreshEvidence, encodeFreshEvidence, freshAddress, freshHash, freshInteger,validateFreshReceipt, type FreshCapturedReceipt, type FreshLog, type FreshBlock, type FreshCaptureCheckpoint } from './capture.js';
import { freshCall, freshCurrentQuote, freshTokenMetadata, freshQuoteUsd, freshMetadataDiagnostic, type FreshTokenMetadata, type FreshPriceBlock } from './pricing.js';
import { freshIpcTrace, freshNativeDelta, freshTraceMatchesTransaction,validateFreshTrace, type FreshTraceLoader, type FreshCallTrace } from './trace.js';
import { createFreshStateEvidenceRpc, type FreshStateEvidenceRpc, type FreshStateReadEvidence } from './stateEvidence.js';
import {createFreshReceiptRecovery,type FreshReceiptRecoveryEvidence} from './recovery.js';
import {freshNativeBuyCost} from './routerPayment.js';
import type {FreshRecoveryBatch} from './recoveryBatch.js';
import{isFreshSyntheticBatchCandidate,decodeFreshSyntheticTransferBatch,readFreshSyntheticBatchAnchor,type FreshSyntheticBatchAnchor,type FreshSyntheticBatchProof}from'./syntheticTransferBatch.js';
import { freshPositionDependencies } from './positionDependencies.js';
import {hasFreshSmartSellSettlement,freshSmartAccountSellSettlement} from './smartAccountSettlement.js';
import {persistFreshTradeBnbPrice} from './tradeBnbDisplay.js';
import {freshQuotePayment} from './quotePayment.js';
import {freshTokenExchangeSettlement,hasFreshTokenExchangeRoute} from './tokenExchangeSettlement.js';
import {freshSignedBatchNativeBuyPayment} from './signedBatchPayment.js';

export const FRESH_DECODER_VERSION = 3;
const q = FreshRational.parse, units = (raw: bigint, decimals: number) => new FreshRational(raw, 10n ** BigInt(decimals)).decimal(255);
const tokenTopic = (raw: unknown) => typeof raw === 'string' && /^0x0{24}[\da-f]{40}$/i.test(raw) ? `0x${raw.slice(-40).toLowerCase()}` : null;
const zeroAddress = `0x${'0'.repeat(40)}`;
const extraSwapTopics = new Set([v3MarketAbi, infinityMarketAbi, infinityBinMarketAbi].map(abi => abi.getEvent('Swap')!.topicHash));
// A failed receipt has no successful Transfer logs. Only an exact, standard
// call to the verified token itself establishes a token-related attempt here.
// Router calldata, arbitrary embedded addresses and AA wrappers are not proof.
const feeAttemptAbi = new Interface(['function transfer(address to,uint256 amount)', 'function approve(address spender,uint256 amount)', 'function transferFrom(address from,address to,uint256 amount)']);
const attributionKey = (value: FreshFinancialEvent['feeAttribution']) => JSON.stringify(value ? { status: value.status, tokenAddress: value.tokenAddress ?? null,
  contract: value.contract ?? null, selector: value.selector ?? null, nativeFeeWei: value.nativeFeeWei,
  ...(value.expensePolicy?{expensePolicy:value.expensePolicy,batchExpenseNativeWei:value.batchExpenseNativeWei,gasNativeWei:value.gasNativeWei}:{}) } : null);
export interface FreshExecution { key: string; wallet: string; index: number; kind: 'transaction' | 'user_operation' | 'transfer'; logs: FreshLog[]; feeWei: bigint | null; status: 'success' | 'failed' | 'unsupported'; operationHash: string | null; nativeValue: bigint; router: string | null }
export interface FreshDecodedReceipt { events: FreshFinancialEvent[]; reasons: string[]; tokens: FreshTokenMetadata[]; executions: number; trace?: FreshCallTrace | null;syntheticTransferBatch?:FreshSyntheticBatchProof;tradeBnbPrices?:Record<string,string> }
export interface FreshDecodeDiagnostics { version:1; valuationReasons:string[]; firstFailure?:{version:1;at:string;reasons:string[]} }
type FreshDiagnosedReceipt=FreshCapturedReceipt&{decodeDiagnostics?:FreshDecodeDiagnostics};
export interface FreshDecodeServices {
  metadata(token: string): Promise<FreshTokenMetadata | null>;
  eligible(token: FreshTokenMetadata): Promise<boolean>;
  knownLaunch?(tokenAddress: string): Promise<boolean>;
  priceUsd(token: string): Promise<string | null>;
  /** Exact-block retained/imported precision only; optional display enrichment
   * must not launch new historical RPC work after financial valuation succeeds. */
  retainedQuoteMetadata?(token:string):Promise<Pick<FreshTokenMetadata,'decimals'>|null>;
  acquisitionCost?(token:string,wallet:string):FreshFinancialEvent['acquisitionCost']|null;
  additionalNativeFeeWei?(token:string):Promise<bigint|null>;
  directFlapPurchaseUsd?(token:string,wallet:string,receivedRaw:bigint,nativePriceUsd:string|null,trace?:()=>Promise<FreshCallTrace|null>):Promise<string|null>;
  quotePaymentUsd?(token:string,wallet:string,targetRaw:bigint,nativePriceUsd:string|null,retainedOnly?:boolean):Promise<string|null>;
  nativeQuoteChangeUsd?(token:string,wallet:string,targetRaw:bigint,nativePriceUsd:string|null,retainedOnly?:boolean):Promise<string|null>;
  signedBatchPurchaseUsd?(token:string,wallet:string,targetRaw:bigint,nativePriceUsd:string|null,trace:FreshCallTrace):Promise<string|null>;
  syntheticBatchAnchor?(tokenAddress:string):Promise<FreshSyntheticBatchAnchor|null>;
  trace?: FreshTraceLoader;
}

function tokenFlows(wallet: string, logs: FreshLog[]) {
  const flows = new Map<string, { raw: bigint; logs: FreshLog[] }>();
  for (const log of logs) {
    if (log.removed || log.topics[0]?.toLowerCase() !== transferTopic || log.topics.length !== 3 || !/^0x[\da-f]{64}$/i.test(log.data)) continue;
    const from = tokenTopic(log.topics[1]), to = tokenTopic(log.topics[2]);
    if (!from || !to || from !== wallet && to !== wallet) continue;
    const token = log.address.toLowerCase(), entry = flows.get(token) ?? { raw: 0n, logs: [] };
    if (from === to) { flows.set(token, entry); continue; }
    entry.raw += BigInt(log.data) * (from === wallet ? -1n : 1n); entry.logs.push(log); flows.set(token, entry);
  }
  return flows;
}

/** One userOperationEvent closes one authenticated operation. Repeated actions
 * by the same account remain separate; bundler gas is never assigned to it. */
export function decodeFreshExecutions(entry: FreshCapturedReceipt): FreshExecution[] {
  const { transaction: tx, receipt } = entry, watched = new Set(entry.wallets), from = tx.from.toLowerCase(), to = tx.to?.toLowerCase() ?? null;
  const executions: FreshExecution[] = [], used = new Map<string, Set<FreshLog>>(), slots = new Map<FreshLog, number>();
  const append = (wallet: string, kind: FreshExecution['kind'], logs: FreshLog[], details: Partial<FreshExecution>) => {
    const index = details.index ?? 0, operationHash = details.operationHash ?? null;
    const key = `${receipt.blockHash.toLowerCase()}:${tx.hash.toLowerCase()}:${wallet}:${operationHash ?? kind}:${operationHash ? '' : index}`;
    executions.push({ key, wallet, index, kind, logs, feeWei: 0n, status: receipt.status === '0x1' ? 'success' : 'failed', operationHash, nativeValue: 0n, router: to, ...details });
    const set = used.get(wallet) ?? new Set<FreshLog>(); logs.forEach(log => set.add(log)); used.set(wallet, set);
  };
  if (watched.has(from)) append(from, 'transaction', receipt.status === '0x1' && !FRESH_ENTRY_POINTS.includes(to ?? '') ? receipt.logs : [], {
    feeWei: freshInteger(receipt.gasUsed) * freshInteger(receipt.effectiveGasPrice ?? tx.gasPrice), nativeValue: receipt.status === '0x1' ? freshInteger(tx.value) : 0n,
  });
  if (receipt.status === '0x1' && to && FRESH_ENTRY_POINTS.includes(to)) {
    const markers = receipt.logs.map((log, index) => ({ log, index })).filter(value => value.log.address.toLowerCase() === to && value.log.topics[0]?.toLowerCase() === beforeExecutionTopic);
    const validBoundary = markers.length === 1 && markers[0].log.topics.length === 1 && markers[0].log.data === '0x';
    let start = validBoundary ? markers[0].index + 1 : 0, ordinal = 0;
    const seen = new Set<string>();
    for (let index = start; index < receipt.logs.length; index++) {
      const log = receipt.logs[index];
      if (log.address.toLowerCase() !== to || log.topics[0]?.toLowerCase() !== userOperationTopic) continue;
      const sender = tokenTopic(log.topics[2]), paymaster = tokenTopic(log.topics[3]), operationHash = freshHash(log.topics[1]);
      if (!sender || sender === zeroAddress || !paymaster || !operationHash || log.topics.length !== 4 || !/^0x[\da-f]{256}$/i.test(log.data) || seen.has(operationHash)) throw new Error('user_operation_evidence_invalid');
      seen.add(operationHash); const words = log.data.slice(2).match(/.{64}/g)!, success = BigInt(`0x${words[1]}`);
      if (success > 1n) throw new Error('user_operation_success_invalid');
      ordinal++; receipt.logs.slice(start, index + 1).forEach(item => slots.set(item, ordinal));
      if (watched.has(sender)) {
        const supported = validBoundary && paymaster === zeroAddress;
        append(sender, 'user_operation', supported && success === 1n ? receipt.logs.slice(start, index) : [], { operationHash, index: ordinal,
          status: supported ? success === 1n ? 'success' : 'failed' : 'unsupported', feeWei: supported ? BigInt(`0x${words[2]}`) : null, router: null });
        // An unsupported operation's logs must not be reinterpreted as a free
        // incoming transfer in the final recipient pass.
        const set = used.get(sender) ?? new Set<FreshLog>(); receipt.logs.slice(start, index).forEach(item => set.add(item)); used.set(sender, set);
      }
      start = index + 1;
    }
  }
  // A future EntryPoint version must not silently turn a paid swap into a free
  // transfer. Keep its receipt for repair without asserting a fee or ordering.
  if (receipt.status === '0x1') for (const log of receipt.logs) {
    if (log.topics[0]?.toLowerCase() !== userOperationTopic || FRESH_ENTRY_POINTS.includes(log.address.toLowerCase())) continue;
    const sender = tokenTopic(log.topics[2]);
    if (sender && watched.has(sender)) append(sender, 'user_operation', receipt.logs, { status: 'unsupported', feeWei: null, operationHash: freshHash(log.topics[1]) });
  }
  if (receipt.status === '0x1') for (const wallet of watched) {
    const logs = receipt.logs.filter(log => !used.get(wallet)?.has(log));
    const grouped = new Map<number, FreshLog[]>();
    for (const log of logs) { const slot = slots.get(log) ?? 0, group = grouped.get(slot) ?? []; group.push(log); grouped.set(slot, group); }
    for (const [index, group] of grouped) if ([...tokenFlows(wallet, group).values()].some(flow => flow.logs.length)) append(wallet, 'transfer', group, { index });
  }
  return executions;
}

function controllerTrade(execution: FreshExecution, token: string) {
  const matches: { side: 'buy' | 'sell'; log: FreshLog }[] = [];
  for (const log of execution.logs) {
    const address = log.address.toLowerCase(), abi = FOUR_MANAGERS.includes(address) ? fourMarketAbi : address === FLAP_PORTAL ? flapMarketAbi : null;
    if (!abi) continue;
    try { const parsed = abi.parseLog(log); if (parsed && String(parsed.args.token).toLowerCase() === token && String(parsed.args.account ?? parsed.args.buyer ?? parsed.args.seller).toLowerCase() === execution.wallet) matches.push({ side: ['TokenPurchase', 'TokenBought'].includes(parsed.name) ? 'buy' : 'sell', log }); }
    catch { /* Unrecognized controller payload is not a swap proof. */ }
  }
  return matches;
}
function ordinaryNativeQuoteTrace(trace:FreshCallTrace,wallet:string){
  const known=new Set(['CALL','STATICCALL','DELEGATECALL','CALLCODE','CREATE','CREATE2','SELFDESTRUCT']);let valid=true;
  const walk=(call:FreshCallTrace,root:boolean)=>{if(!known.has(call.type)||!root&&call.from===wallet)valid=false;call.calls?.forEach(child=>walk(child,false));};walk(trace,true);
  return valid;
}
const quotePrecisionAbi=new Interface(['function decimals() view returns(uint8)']);
async function retainedTradeQuotePrecision(entry:FreshCapturedReceipt,block:FreshPriceBlock,address:string){
  if(!entry.stateEvidence)return null;
  const saved=createFreshStateEvidenceRpc(async()=>{throw new RpcRequestError('quote_precision_not_captured','state_unavailable');},block,entry.stateEvidence);
  if(saved.rejectedPrior)return null;
  try{const decimals=Number((await freshCall({rpc:saved.rpc,block},address,quotePrecisionAbi,'decimals'))[0]);
    return Number.isInteger(decimals)&&decimals>=0&&decimals<=255?{decimals}:null;
  }catch{return null;}
}

/** Pure financial normalization. Unknown valuations are null, never zero. The
 * surrounding job retains repair state while capture moves independently. */
export async function normalizeFreshReceipt(entry: FreshCapturedReceipt, block: Pick<FreshBlock, 'number' | 'hash' | 'timestamp'>, services: FreshDecodeServices): Promise<FreshDecodedReceipt> {
  const events: FreshFinancialEvent[] = [], reasons = new Set<string>(), tokens = new Map<string, FreshTokenMetadata>();
  const tradeBnbPrices:Record<string,string>={};
  const syntheticTransferBatch=isFreshSyntheticBatchCandidate(entry)?decodeFreshSyntheticTransferBatch(entry,block,await services.syntheticBatchAnchor?.(entry.transaction.to!)):null;
  // The original raw receipt remains intact for capture/repair. Only this
  // authenticated execution's proven non-financial logs leave normalization.
  const executions=decodeFreshExecutions(syntheticTransferBatch?{...entry,receipt:{...entry.receipt,logs:[]}}:entry);
  const prices = new Map<string, Promise<string | null>>(), metadata = new Map<string, Promise<FreshTokenMetadata | null>>(),metadataFailures=new Map<string,string>();
  const price = (token: string) => { let value = prices.get(token); if (!value) { value = services.priceUsd(token).catch(() => null); prices.set(token, value); } return value; };
  const meta = (token: string) => { let value = metadata.get(token); if (!value) { value = services.metadata(token).catch(error => {const diagnostic=freshMetadataDiagnostic(error);if(diagnostic)metadataFailures.set(token,diagnostic);return null;}); metadata.set(token, value); } return value; };
  const tx = entry.transaction, occurredAt = new Date(Number(freshInteger(block.timestamp)) * 1_000).toISOString();
  let trace: FreshCallTrace | null | undefined = entry.trace;
  const getTrace = async () => {
    if (trace !== undefined) return trace;
    trace = services.trace ? await services.trace(tx).catch(() => null) : null;
    if (trace && !freshTraceMatchesTransaction(trace, tx)) throw new Error('trace_transaction_mismatch');
    return trace;
  };
  const exactTokenFeeAttribution = async (execution: FreshExecution): Promise<NonNullable<FreshFinancialEvent['feeAttribution']>> => {
    const attribution: NonNullable<FreshFinancialEvent['feeAttribution']> = { status: 'unattributed', nativeFeeWei: execution.feeWei?.toString() ?? null };
    const contract = freshAddress(tx.to), input = typeof tx.input === 'string' ? tx.input : null;
    if (execution.kind !== 'transaction' || !contract || !input || !/^0x(?:[\da-f]{2})+$/i.test(input)) return attribution;
    let selector: string;
    try {
      const parsed = feeAttemptAbi.parseTransaction({ data: input });
      if (!parsed || feeAttemptAbi.encodeFunctionData(parsed.fragment, parsed.args).toLowerCase() !== input.toLowerCase()) return attribution;
      selector = input.slice(0, 10).toLowerCase();
    } catch { return attribution; }
    const identified = { ...attribution, contract, selector };
    if (isExcludedKolProfileTokenAddress(contract) || isFreshSettlementQuote(contract)) return { ...identified, status: 'excluded', tokenAddress: contract };
    const token = await meta(contract);
    if (!token || token.address !== contract) return identified;
    if (!isKolProfileToken(token) || services.knownLaunch && !await services.knownLaunch(contract) || !await services.eligible(token)) return { ...identified, status: 'excluded', tokenAddress: contract };
    tokens.set(contract, token);
    return { ...identified, status: 'eligible', tokenAddress: contract };
  };
  for (const execution of executions) {
    if (execution.status === 'unsupported') { reasons.add('unsupported_smart_account_operation'); continue; }
    const flows = tokenFlows(execution.wallet, execution.logs), targets: { token: string; raw: bigint; logs: FreshLog[]; metadata: FreshTokenMetadata }[] = [];
    for (const [token, flow] of flows) {
      if (isExcludedKolProfileTokenAddress(token) || isFreshSettlementQuote(token)) continue;
      if (services.knownLaunch && !await services.knownLaunch(token)) continue;
      const tokenMetadata = await meta(token);
      if (!tokenMetadata) { reasons.add('token_decimals_unavailable');const diagnostic=metadataFailures.get(token);if(diagnostic)reasons.add(diagnostic);continue; }
      if (!isKolProfileToken(tokenMetadata) || !await services.eligible(tokenMetadata)) continue;
      tokens.set(token, tokenMetadata); targets.push({ token, ...flow, metadata: tokenMetadata });
    }
    if (!targets.length && execution.status !== 'failed') {
      // A successful direct approval also pays wallet gas. Only a known new
      // token and exact standard calldata can attribute this fee-only fact.
      const contract=freshAddress(tx.to);
      if(execution.kind!=='transaction'||!contract||!services.knownLaunch||!await services.knownLaunch(contract))continue;
    }
    const feeAttribution = targets.length===0 ? syntheticTransferBatch&&execution.kind==='transaction'
      ?{status:'eligible' as const,tokenAddress:syntheticTransferBatch.tokenAddress,contract:syntheticTransferBatch.tokenAddress,selector:String(tx.input).slice(0,10),nativeFeeWei:execution.feeWei?.toString()??null}
      :await exactTokenFeeAttribution(execution) : undefined;
    const batchTrace=execution.kind==='transaction'&&targets.length===1&&targets[0].raw>0n&&tx.type==='0x4'&&tx.from===tx.to?await getTrace():null;
    const batchPayment=batchTrace?freshSignedBatchNativeBuyPayment({...entry,trace:batchTrace},{number:Number(freshInteger(block.number)),hash:block.hash,timestamp:occurredAt},targets[0].token,execution.wallet,targets[0].raw):null;
    const messageFee=execution.kind==='transaction'&&targets.length===1&&services.additionalNativeFeeWei?await services.additionalNativeFeeWei(targets[0].token):0n;
    const extraFee=messageFee===null?null:messageFee+(batchPayment?BigInt(batchPayment.extraNativeWei):0n);
    if(extraFee===null)reasons.add('native_message_fee_unverified');
    const paidFee=execution.feeWei===null||extraFee===null?null:execution.feeWei+extraFee;
    const extraFeeAttribution=extraFee!==0n?{status:'eligible' as const,tokenAddress:targets[0]?.token,contract:tx.to??undefined,
      selector:typeof tx.input==='string'?tx.input.slice(0,10):undefined,nativeFeeWei:paidFee?.toString()??null,
      ...(batchPayment?{expensePolicy:batchPayment.expensePolicy,batchExpenseNativeWei:batchPayment.extraNativeWei,gasNativeWei:batchPayment.gasFeeWei}:{})}:undefined;
    const feePrice = paidFee === 0n ? '0' : await price(WBNB);
    const feeUsd = paidFee !== null && feePrice !== null ? q(units(paidFee, 18)).mul(q(feePrice)).decimal() : null;
    if (feeUsd === null && (!feeAttribution || feeAttribution.status === 'eligible')) reasons.add('wallet_fee_valuation_unavailable');
    // An authenticated two-token exchange has one real wallet gas payment.
    // Keep it as a separate eligible wallet fee, without inventing a split
    // between the disposed position and the new acquisition's FIFO lot.
    const exchangeTrace=targets.length>=1&&targets.length<=2&&execution.kind==='transaction'&&hasFreshTokenExchangeRoute(entry)?await getTrace():null;
    const exchangeCandidate=exchangeTrace?freshTokenExchangeSettlement(entry,execution,block,exchangeTrace):null;
    const exchange=exchangeCandidate&&targets.every(target=>target.token===exchangeCandidate.sellToken&&target.raw===-exchangeCandidate.sellRaw
      ||target.token===exchangeCandidate.buyToken&&target.raw===exchangeCandidate.buyRaw)?exchangeCandidate:null;
    let exchangeUsd:string|null=null;
    if(exchange){const precision=await meta(exchange.quoteAddress),usd=await price(exchange.quoteAddress);
      if(precision&&usd!==null)exchangeUsd=q(units(exchange.quoteRaw,precision.decimals)).mul(q(usd)).decimal();}
    const base = { walletAddress: execution.wallet, blockNumber: String(freshInteger(block.number)), blockHash: block.hash.toLowerCase(), transactionHash: tx.hash.toLowerCase(),
      transactionIndex: Number(freshInteger(tx.transactionIndex)), executionIndex: execution.index, occurredAt, canonical: true };
    const emit = (token: string | null, kind: FreshFinancialEvent['kind'], quantity: string, amountUsd: string | null, logIndex: number | null, counterparty: string | null, transferKey: string | null, attribution:FreshFinancialEvent['feeAttribution']=extraFeeAttribution,
      quote?:Pick<FreshFinancialEvent,'quoteAddress'|'quoteSymbol'|'quoteAmount'>) => {
      // Attribution can be repaired independently of authentic execution ID.
      const executionKey = `${execution.key}:${kind === 'fee' ? 'native_fee' : token ?? 'native_fee'}:${kind}:${logIndex ?? 'aggregate'}`, id = createHash('sha256').update(executionKey).digest('hex');
      const allocatedFee = kind !== 'fee' && exchange && targets.length>1 ? '0' : kind !== 'fee' && targets.length > 1 && feeUsd !== '0' ? null : feeUsd;
      events.push({ ...base, id, executionKey, tokenAddress: token, kind, quantity, amountUsd, feeUsd: allocatedFee,
        feeKey: `${execution.key}:fee${kind !== 'fee' && targets.length > 1 ? `:unallocated:${token}` : ''}`, logIndex, counterparty, transferKey, ...(attribution ? { feeAttribution: attribution } : {}),...(quote??{}) });
    };
    if (targets.length === 0) {
      if (execution.status === 'failed'||feeAttribution?.status==='eligible') emit(syntheticTransferBatch?null:feeAttribution?.status === 'eligible' ? feeAttribution.tokenAddress ?? null : null, 'fee', '0', '0', null, null, null, feeAttribution);
      continue;
    }
    const selfTransfersOnly = targets.every(target => target.raw === 0n && target.logs.length === 0);
    if (targets.length > 1 && !exchange && !selfTransfersOnly && feeUsd !== '0') reasons.add('operation_fee_allocation_unknown');
    const previousEvents = events.length;
    for (const target of targets) {
      const controller = controllerTrade(execution, target.token);
      if (controller.length > 1) { reasons.add('multiple_actions_require_execution_decoder'); continue; }
      const positive = target.raw > 0n, opposingQuotes = [...flows].filter(([token, flow]) => isFreshSettlementQuote(token) && flow.raw !== 0n && (flow.raw < 0n) === positive);
      const swap = execution.kind !== 'transfer' && (controller.length === 1 || hasRecognizedSwap(execution.logs) || execution.logs.some(log => extraSwapTopics.has(log.topics[0])));
      if (swap && target.raw !== 0n) {
        if (controller.length && (controller[0].side === 'buy') !== positive) { reasons.add('controller_quantity_direction_mismatch'); continue; }
        const selfCallTrace=execution.kind==='transaction'&&targets.length===1&&entry.selfCallContext?await getTrace():null;
        const selfCallSettlement=selfCallTrace&&entry.selfCallContext?freshSignedSelfCallSettlement({...entry,trace:selfCallTrace},{number:Number(freshInteger(block.number)),hash:block.hash,timestamp:occurredAt},target.token,execution.wallet,target.raw,entry.selfCallContext):null;
        let settledQuote:Pick<FreshFinancialEvent,'quoteAddress'|'quoteSymbol'|'quoteAmount'>|undefined=selfCallSettlement?{quoteAddress:WBNB,quoteSymbol:'BNB',quoteAmount:units(BigInt(selfCallSettlement.nativeAmountWei),18)}:undefined;
        const selfCallNativeUsd=selfCallSettlement?await price(WBNB):null;
        let amountUsd: string | null = selfCallSettlement&&selfCallNativeUsd!==null?q(units(BigInt(selfCallSettlement.nativeAmountWei),18)).mul(q(selfCallNativeUsd)).decimal():batchPayment&&batchTrace&&services.signedBatchPurchaseUsd
          ?await services.signedBatchPurchaseUsd(target.token,execution.wallet,target.raw,await price(WBNB),batchTrace).catch(()=>null):exchange ? exchangeUsd : positive && targets.length === 1 && execution.kind === 'transaction' && services.directFlapPurchaseUsd
          ? await services.directFlapPurchaseUsd(target.token,execution.wallet,target.raw,await price(WBNB),()=>getTrace()).catch(()=>null) : null;
        // Reuse an already authenticated valuation route before trying a newly
        // available metadata source. Future recovery must not reprice old facts.
        if(amountUsd===null&&targets.length===1&&execution.kind==='transaction'&&services.quotePaymentUsd)
          amountUsd=await services.quotePaymentUsd(target.token,execution.wallet,target.raw,await price(WBNB),true).catch(()=>null);
        if(amountUsd===null&&positive&&targets.length===1&&execution.kind==='transaction'&&services.nativeQuoteChangeUsd)
          amountUsd=await services.nativeQuoteChangeUsd(target.token,execution.wallet,target.raw,await price(WBNB),true).catch(()=>null);
        if(amountUsd===null&&positive&&targets.length===1&&execution.kind==='transaction'&&opposingQuotes.length===0&&services.nativeQuoteChangeUsd)
          amountUsd=await services.nativeQuoteChangeUsd(target.token,execution.wallet,target.raw,await price(WBNB)).catch(()=>null);
        const smartTrace=!positive&&targets.length===1&&execution.kind==='user_operation'&&hasFreshSmartSellSettlement(execution.logs)?await getTrace():null;
        const smartSettlement=smartTrace?freshSmartAccountSellSettlement(entry,execution,target.token,target.raw,smartTrace):null;
        if(smartSettlement){
          const quoteMetadata=await meta(smartSettlement.quoteAddress),usd=await price(smartSettlement.quoteAddress);
          if(quoteMetadata){const quoteAmount=units(smartSettlement.quoteRaw,quoteMetadata.decimals);
            settledQuote={quoteAddress:smartSettlement.quoteAddress,quoteSymbol:smartSettlement.quoteAddress===WBNB?'BNB':TRUSTED_QUOTE_FEEDS[smartSettlement.quoteAddress].description.split(' / ')[0],quoteAmount};
            if(usd!==null)amountUsd=q(quoteAmount).mul(q(usd)).decimal();
          }
        }
        if (!smartSettlement && targets.length === 1 && opposingQuotes.length === 1) {
          const [quoteAddress, flow] = opposingQuotes[0];
          // A supported non-feed asset is valued from its authenticated raw
          // wallet settlement and historical conversion, never a generic token
          // price/current mark. Keep existing feed-backed quote behavior.
          if(amountUsd===null&&execution.kind==='transaction'&&!TRUSTED_QUOTE_FEEDS[quoteAddress]&&services.quotePaymentUsd)
            amountUsd=await services.quotePaymentUsd(target.token,execution.wallet,target.raw,await price(WBNB)).catch(()=>null);
          // A retained USD payment route remains authoritative. Optional quote
          // display cannot start fresh historical metadata/feed requests after
          // that route succeeded; only original exact-block precision may add it.
          const quoteMetadata=amountUsd===null?await meta(quoteAddress):(await retainedTradeQuotePrecision(entry,
            {number:Number(freshInteger(block.number)),hash:block.hash.toLowerCase(),timestamp:occurredAt},quoteAddress)
            ??await services.retainedQuoteMetadata?.(quoteAddress).catch(()=>null));
          const usd=amountUsd===null&&TRUSTED_QUOTE_FEEDS[quoteAddress]?await price(quoteAddress):null;
          if(quoteMetadata){
            const quoteAmount=units(flow.raw < 0n ? -flow.raw : flow.raw,quoteMetadata.decimals);
            // The trusted contract mapping identifies the asset. Arbitrary
            // token metadata cannot relabel an ERC20 balance as native BNB.
            const quoteSymbol=freshSettlementQuoteSymbol(quoteAddress)!;
            if([...flows].every(([asset,flow])=>asset===target.token||asset===quoteAddress||flow.raw===0n))settledQuote={quoteAddress,quoteSymbol,quoteAmount};
            if(amountUsd===null&&usd!==null)amountUsd=q(quoteAmount).mul(q(usd)).decimal();
          }
          if(amountUsd===null&&execution.kind==='transaction'&&TRUSTED_QUOTE_FEEDS[quoteAddress]&&services.quotePaymentUsd)
            amountUsd=await services.quotePaymentUsd(target.token,execution.wallet,target.raw,await price(WBNB)).catch(()=>null);
        } else if (!smartSettlement && targets.length === 1 && opposingQuotes.length === 0 && [...flows].every(([asset, flow]) => asset === target.token || flow.raw === 0n)) {
          let native: bigint | null = null, contradictoryNative = false;
          const receiptPayment=positive?freshNativeBuyCost(tx,execution.wallet,target.token,target.raw,execution.logs)
            :nativeSellProceeds(execution.wallet,-target.raw,execution.logs,execution.router,target.token);
          if (execution.kind === 'transaction') {
            // Authenticated recipient/input/output receipts already establish
            // payment. Trace unsupported cash flows; retain and cross-check
            // any trace we captured originally instead of hiding a conflict.
            const traced = entry.trace||receiptPayment===null?await getTrace():null;
            if (traced) { const delta = freshNativeDelta(traced, execution.wallet); native = positive ? delta < 0n ? -delta : null : delta > 0n ? delta : null;
              if (delta===0n || positive && delta > 0n || !positive && delta < 0n) { contradictoryNative = true; reasons.add('native_payout_mismatch'); } }
          }
          if (receiptPayment!==null) {
            if (native !== null && native !== receiptPayment) { native = null; reasons.add('native_payout_mismatch'); }
            else if (native === null && !contradictoryNative) native = receiptPayment;
          }
          const nativeSettlementSupported=!!selfCallSettlement||execution.kind!=='transaction'||(['0x0','0x1','0x2'].includes(String(tx.type??'0x0'))&&tx.authorizationList===undefined&&tx.to!==execution.wallet
            &&(!trace||ordinaryNativeQuoteTrace(trace,execution.wallet)));
          if(native!==null&&nativeSettlementSupported)settledQuote={quoteAddress:WBNB,quoteSymbol:'BNB',quoteAmount:units(native,18)};
          const usd = await price(WBNB); if (amountUsd===null&&native !== null && usd !== null&&nativeSettlementSupported) amountUsd = q(units(native, 18)).mul(q(usd)).decimal();
        }
        if (amountUsd === null) reasons.add(exchange?'exchange_quote_valuation_unavailable':targets.length > 1 ? 'shared_quote_allocation_unknown' : 'trade_value_unavailable');
        emit(target.token, positive ? 'buy' : 'sell', units(target.raw < 0n ? -target.raw : target.raw, target.metadata.decimals), amountUsd,
          controller[0] ? Number(freshInteger(controller[0].log.logIndex)) : target.logs.length === 1 ? Number(freshInteger(target.logs[0].logIndex)) : null, null, null,extraFeeAttribution,settledQuote);
        if(positive&&amountUsd!==null){const basis=services.acquisitionCost?.(target.token,execution.wallet);if(basis){if(basis.tokenCostUsd!==amountUsd)throw Error('acquisition_cost_value_mismatch');const event=events[events.length-1],grossQuote=units(BigInt(basis.grossNativeWei),18);if(event.quoteAmount!=null&&(event.quoteAddress!==WBNB||event.quoteSymbol!=='BNB'||q(event.quoteAmount).compare(q(grossQuote))!==0))throw Error('acquisition_cost_gross_quote_conflict');event.quoteAddress=WBNB;event.quoteSymbol='BNB';event.quoteAmount=grossQuote;event.acquisitionCost=basis;}}
        if(amountUsd!==null&&settledQuote&&settledQuote.quoteAddress!==WBNB){
          const nativeUsd=await price(WBNB);
          try{if(nativeUsd!==null&&nativeUsd.length<=384&&/^\d+(?:\.\d+)?$/.test(nativeUsd)&&q(nativeUsd).n>0n)tradeBnbPrices[events[events.length-1].id]=nativeUsd;}
          catch{/* Optional display conversion must not invalidate a known financial value. */}
        }
      } else {
        const usd = await price(target.token);
        for (const log of target.logs) {
          const raw = BigInt(log.data); if (!raw) continue;
          const from = tokenTopic(log.topics[1])!, to = tokenTopic(log.topics[2])!, incoming = to === execution.wallet, index = Number(freshInteger(log.logIndex));
          const quantity = units(raw, target.metadata.decimals), amount = usd === null ? null : q(quantity).mul(q(usd)).decimal();
          if (amount === null) reasons.add(incoming ? 'incoming_transfer_cost_unknown' : 'outgoing_transfer_value_unknown');
          emit(target.token, incoming ? 'transfer_in' : 'transfer_out', quantity, amount, index, incoming ? from : to, `${block.hash.toLowerCase()}:${tx.hash.toLowerCase()}:${target.token}:${index}`);
        }
      }
    }
    if(exchange&&targets.length>1)emit(null,'fee','0','0',null,null,null,{status:'eligible',contract:tx.to!,selector:String(tx.input).slice(0,10),nativeFeeWei:paidFee?.toString()??null});
    if (events.length === previousEvents && selfTransfersOnly && execution.feeWei !== 0n) emit(targets.length === 1 ? targets[0].token : null, 'fee', '0', '0', null, null, null,
      { status: targets.length === 1 ? 'eligible' : 'unattributed', ...(targets.length === 1 ? { tokenAddress: targets[0].token } : {}), ...(tx.to ? { contract: tx.to.toLowerCase() } : {}), nativeFeeWei: execution.feeWei?.toString() ?? null });
  }
  return { events, reasons: [...reasons].sort(), tokens: [...tokens.values()], executions: executions.length, ...(trace !== undefined ? { trace } : {}),...(syntheticTransferBatch?{syntheticTransferBatch}:{}),...(Object.keys(tradeBnbPrices).length?{tradeBnbPrices}:{}) };
}

/** An existing canonical fact already identifies its traded token and scaled
 * quantity. Native wallet payment is a separate proof, in wei; it does not
 * need or reassert token decimals. This fallback supports only one ordinary
 * successful sender execution with no other nonzero wallet asset movement. */
function retainedNativeQuote(entry:FreshCapturedReceipt,event:FreshFinancialEvent,events:readonly FreshFinancialEvent[]){
  const tx=entry.transaction,wallet=event.walletAddress;
  if(entry.receipt.status!=='0x1'||!['0x0','0x1','0x2'].includes(String(tx.type))||tx.authorizationList!==undefined||tx.from!==wallet||tx.to===wallet
    ||FRESH_ENTRY_POINTS.includes(tx.to??'')||entry.receipt.logs.some(log=>[beforeExecutionTopic,userOperationTopic].includes(log.topics[0]))
    ||events.filter(other=>other.walletAddress===wallet&&other.executionIndex===event.executionIndex).length!==1)return null;
  const execution=decodeFreshExecutions(entry).find(value=>value.wallet===wallet&&value.index===event.executionIndex&&value.kind==='transaction'&&value.status==='success');
  if(!execution||!event.tokenAddress)return null;
  const flows=tokenFlows(wallet,execution.logs),target=flows.get(event.tokenAddress),positive=event.kind==='buy';
  if(!target||target.raw===0n||(target.raw>0n)!==positive||[...flows].some(([asset,flow])=>asset!==event.tokenAddress&&flow.raw!==0n))return null;
  const controller=controllerTrade(execution,event.tokenAddress);
  if(controller.length>1||controller.length&&(controller[0].side==='buy')!==positive||!controller.length&&!hasRecognizedSwap(execution.logs)
    &&!execution.logs.some(log=>extraSwapTopics.has(log.topics[0])))return null;
  const logIndex=controller[0]?Number(freshInteger(controller[0].log.logIndex)):target.logs.length===1?Number(freshInteger(target.logs[0].logIndex)):null;
  const key=`${execution.key}:${event.tokenAddress}:${event.kind}:${logIndex??'aggregate'}`;
  if(event.executionKey!==key||event.id!==createHash('sha256').update(key).digest('hex')||event.logIndex!==logIndex)return null;
  const raw=target.raw>0n?target.raw:-target.raw;
  const receiptPayment=positive?freshNativeBuyCost(tx,wallet,event.tokenAddress,raw,execution.logs):nativeSellProceeds(wallet,raw,execution.logs,execution.router,event.tokenAddress);
  let native:bigint|null=null;
  if(entry.trace){
    if(!ordinaryNativeQuoteTrace(entry.trace,wallet))return null;
    const delta=freshNativeDelta(entry.trace,wallet);if(positive?delta>=0n:delta<=0n)return null;
    native=positive?-delta:delta;if(receiptPayment!==null&&native!==receiptPayment)return null;
  }else native=receiptPayment;
  return native!==null&&native>0n?{quoteAddress:WBNB,quoteSymbol:'BNB',quoteAmount:units(native,18)}:null;
}

/** Finite operator preview for retained compact facts. Reuse the normal decoder
 * with original checksum-verified state and call trees only. Uncaptured reads
 * fail locally; there are no RPC, price, provider or database requests here.
 * The returned copies preserve every original financial/accounting field.
 * Callers must recheck the payload checksum and canonical header under locks
 * before using persistFreshTradeQuote for additive quote-column enrichment. */
export async function recoverFreshRetainedTradeQuotes(entry:FreshCapturedReceipt,block:FreshPriceBlock,events:readonly FreshFinancialEvent[]){
  if(events.length>128||!Number.isSafeInteger(block.number)||block.number<0||!freshHash(block.hash)||!Number.isFinite(Date.parse(block.timestamp)))throw Error('trade_quote_recovery_bounds');
  const rawBlock={number:'0x'+block.number.toString(16),hash:block.hash,timestamp:'0x'+Math.floor(Date.parse(block.timestamp)/1000).toString(16)} as FreshBlock;
  validateFreshReceipt(entry.receipt,entry.transaction,rawBlock);
  if(entry.transaction.blockHash!==block.hash||freshInteger(entry.transaction.blockNumber)!==BigInt(block.number))throw Error('trade_quote_recovery_block');
  for(const event of events)if(event.canonical===false||!['buy','sell'].includes(event.kind)||event.blockNumber!==String(block.number)||event.blockHash!==block.hash
    ||event.transactionHash!==entry.transaction.hash||event.transactionIndex!==Number(freshInteger(entry.transaction.transactionIndex))
    ||Date.parse(event.occurredAt)!==Date.parse(block.timestamp)||!entry.wallets.includes(event.walletAddress))throw Error('trade_quote_recovery_context');
  if(entry.trace){const trace=validateFreshTrace(entry.trace);if(!freshTraceMatchesTransaction(trace,entry.transaction))throw Error('trade_quote_recovery_trace');entry={...entry,trace};}
  let missingStateReads=0;
  const localOnly:Rpc=async()=>{missingStateReads++;throw new RpcRequestError('retained_state_not_captured','state_unavailable');};
  const state=createFreshStateEvidenceRpc(localOnly,block,entry.stateEvidence),known=new Set(events.flatMap(event=>event.tokenAddress?[event.tokenAddress]:[]));
  if(state.rejectedPrior)throw Error('trade_quote_recovery_state_invalid');
  const decoded=await normalizeFreshReceipt(entry,rawBlock,{metadata:address=>freshTokenMetadata(address,{rpc:state.rpc,block,requireSupply:false}),
    knownLaunch:async address=>known.has(address),eligible:async token=>known.has(token.address),priceUsd:async()=>null});
  const byId=new Map(events.map(event=>[event.id,event])),quotes:FreshFinancialEvent[]=[];
  for(const event of decoded.events){const saved=byId.get(event.id);if(!saved||!freshSameTradeQuoteContext(saved,event)||event.quoteAmount==null)continue;
    assertFreshEventQuoteCompatible(saved,event);quotes.push({...saved,quoteAddress:event.quoteAddress,quoteSymbol:event.quoteSymbol,quoteAmount:event.quoteAmount});
  }
  for(const saved of events)if(!quotes.some(value=>value.id===saved.id)&&!decoded.events.some(value=>value.id===saved.id&&!freshSameTradeQuoteContext(saved,value))){
    const quote=retainedNativeQuote(entry,saved,events);if(!quote)continue;
    const enriched={...saved,...quote};assertFreshEventQuoteCompatible(saved,enriched);quotes.push(enriched);
  }
  return{events:quotes,missingStateReads,reasons:decoded.reasons,rpcRequests:0 as const,providerRequests:0 as const};
}

/** Match a previously approved compact trade to its actual wallet settlement.
 * Its recorded token units are checked against the original raw movement; no
 * token metadata, price or P&L is inferred or changed. The caller authenticates
 * the quote's supplied precision at this exact canonical block before commit.
 * Useful for old receipts whose token precision was a separate retained proof. */
export function recoverFreshRetainedStableTradeQuote(entry:FreshCapturedReceipt,block:FreshPriceBlock,event:FreshFinancialEvent,
  precision:{address:string;decimals:number;blockNumber:number;blockHash:string}):FreshFinancialEvent|null{
  try{
    const stable=new Set(['0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d','0x55d398326f99059ff775485246999027b3197955']);
    if(!stable.has(precision.address)||!Number.isInteger(precision.decimals)||precision.decimals<0||precision.decimals>255
      ||precision.blockNumber!==block.number||precision.blockHash!==block.hash||event.canonical===false||!['buy','sell'].includes(event.kind)||!event.tokenAddress
      ||event.blockNumber!==String(block.number)||event.blockHash!==block.hash||event.transactionHash!==entry.transaction.hash
      ||event.transactionIndex!==Number(freshInteger(entry.transaction.transactionIndex))||Date.parse(event.occurredAt)!==Date.parse(block.timestamp))return null;
    validateFreshReceipt(entry.receipt,entry.transaction,{number:'0x'+block.number.toString(16),hash:block.hash,timestamp:'0x'+Math.floor(Date.parse(block.timestamp)/1000).toString(16),transactions:[entry.transaction]} as FreshBlock);
    const execution=decodeFreshExecutions(entry).find(e=>e.wallet===event.walletAddress&&e.index===event.executionIndex&&e.kind==='transaction'&&e.status==='success');
    if(!execution)return null;
    const target=tokenFlows(event.walletAddress,execution.logs).get(event.tokenAddress),positive=event.kind==='buy';
    if(!target||target.raw===0n||(target.raw>0n)!==positive)return null;
    const controller=controllerTrade(execution,event.tokenAddress);
    if(controller.length>1||controller.length&&(controller[0].side==='buy')!==positive||!controller.length&&!hasRecognizedSwap(execution.logs)
      &&!execution.logs.some(log=>extraSwapTopics.has(log.topics[0])))return null;
    const logIndex=controller[0]?Number(freshInteger(controller[0].log.logIndex)):target.logs.length===1?Number(freshInteger(target.logs[0].logIndex)):null;
    const key=`${execution.key}:${event.tokenAddress}:${event.kind}:${logIndex??'aggregate'}`;
    if(event.executionKey!==key||event.id!==createHash('sha256').update(key).digest('hex')||event.logIndex!==logIndex||q(event.quantity).n<=0n)return null;
    const scale=new FreshRational(target.raw>0n?target.raw:-target.raw).div(q(event.quantity));
    if(scale.d!==1n||!/^10{0,255}$/.test(scale.n.toString()))return null;
    const payment=freshQuotePayment(entry,block,event.tokenAddress,event.walletAddress,target.raw);
    if(!payment||payment.quoteAddress!==precision.address)return null;
    const enriched={...event,quoteAddress:precision.address,quoteSymbol:TRUSTED_QUOTE_FEEDS[precision.address].description.split(' / ')[0],quoteAmount:units(BigInt(payment.quoteRaw),precision.decimals)};
    assertFreshEventQuoteCompatible(event,enriched);return enriched;
  }catch{return null;}
}

async function persistMetadata(client: PoolClient, tokens: FreshTokenMetadata[]) {
  for (const token of tokens) await client.query(`INSERT INTO fresh.tokens(address,name,symbol,decimals,total_supply_raw,launch_status,metadata_updated_at)
    VALUES($1,$2,$3,$4,$5,'eligible',$6) ON CONFLICT(address) DO UPDATE SET name=COALESCE(EXCLUDED.name,fresh.tokens.name),symbol=COALESCE(EXCLUDED.symbol,fresh.tokens.symbol),
    decimals=EXCLUDED.decimals,total_supply_raw=COALESCE(EXCLUDED.total_supply_raw,fresh.tokens.total_supply_raw),metadata_updated_at=EXCLUDED.metadata_updated_at,launch_status='eligible'
    WHERE fresh.tokens.metadata_updated_at IS NULL OR fresh.tokens.metadata_updated_at<=EXCLUDED.metadata_updated_at AND
      (fresh.tokens.name,fresh.tokens.symbol,fresh.tokens.decimals,fresh.tokens.total_supply_raw,fresh.tokens.launch_status) IS DISTINCT FROM
      (COALESCE(EXCLUDED.name,fresh.tokens.name),COALESCE(EXCLUDED.symbol,fresh.tokens.symbol),EXCLUDED.decimals,COALESCE(EXCLUDED.total_supply_raw,fresh.tokens.total_supply_raw),'eligible')`, [token.address, token.name, token.symbol, token.decimals, token.supplyRaw, token.block.timestamp]);
}

/** A canonical fact already valued successfully must not lose that value just
 * because a later retry cannot read the same historical feed or trace. Changed
 * quantities, fee identities and contradictory evidence never use this path. */
export function preserveFreshVerifiedValuations(decoded: FreshDecodedReceipt, previous: ReadonlyMap<string, FreshFinancialEvent>) {
  const contradiction = decoded.reasons.some(reason => /mismatch|contradict|invalid/.test(reason));
  for (const event of decoded.events) {
    const saved = previous.get(event.id);
    const same = saved && saved.canonical !== false && event.canonical !== false && saved.executionKey === event.executionKey
      && saved.walletAddress === event.walletAddress && saved.kind === event.kind && (event.kind === 'fee' || saved.tokenAddress === event.tokenAddress)
      && saved.blockNumber === event.blockNumber && saved.blockHash === event.blockHash && saved.transactionHash === event.transactionHash
      && saved.transactionIndex === event.transactionIndex && saved.logIndex === event.logIndex && q(saved.quantity).compare(q(event.quantity)) === 0;
    if (!same || contradiction) continue;
    assertFreshEventQuoteCompatible(saved,event);
    if(!event.acquisitionCost&&saved.acquisitionCost)event.acquisitionCost=saved.acquisitionCost;
    if(event.quoteAmount==null&&saved.quoteAmount!=null){event.quoteAddress=saved.quoteAddress;event.quoteSymbol=saved.quoteSymbol;event.quoteAmount=saved.quoteAmount;}
    if (event.amountUsd === null && saved.amountUsd !== null && !decoded.reasons.includes('shared_quote_allocation_unknown')) event.amountUsd = saved.amountUsd;
    const priorWei = saved.feeAttribution?.nativeFeeWei, nextWei = event.feeAttribution?.nativeFeeWei;
    if (event.feeUsd === null && saved.feeUsd !== null && saved.feeKey === event.feeKey && !(priorWei != null && nextWei != null && priorWei !== nextWei)
      && !decoded.reasons.includes('operation_fee_allocation_unknown')) event.feeUsd = saved.feeUsd;
  }
  const unresolved = (events: FreshFinancialEvent[], field: 'feeUsd' | 'amountUsd') => events.length === 0 || events.some(event => event[field] === null);
  decoded.reasons = decoded.reasons.filter(reason => {
    if (reason === 'wallet_fee_valuation_unavailable') return unresolved(decoded.events.filter(freshEventAccountingEligible), 'feeUsd');
    if (reason === 'trade_value_unavailable' || reason === 'exchange_quote_valuation_unavailable') return unresolved(decoded.events.filter(event => event.kind === 'buy' || event.kind === 'sell'), 'amountUsd');
    if (reason === 'incoming_transfer_cost_unknown') return unresolved(decoded.events.filter(event => event.kind === 'transfer_in'), 'amountUsd');
    if (reason === 'outgoing_transfer_value_unknown') return unresolved(decoded.events.filter(event => event.kind === 'transfer_out'), 'amountUsd');
    return true;
  });
}

/** A missing market value is not missing movement evidence. This narrow case
 * retains every null amount and unknown-cost lot; mixed receipts and any
 * execution, precision, fee or contradictory-evidence failure still repair. */
export function freshTransferValuationOnly(decoded:FreshDecodedReceipt,entry?:FreshCapturedReceipt) {
  const allowed=new Set(['incoming_transfer_cost_unknown','outgoing_transfer_value_unknown']);
  if(!decoded.reasons.length||decoded.reasons.some(reason=>!allowed.has(reason))||!decoded.events.length)return false;
  if(entry&&(entry.receipt.status!=='0x1'||hasRecognizedSwap(entry.receipt.logs)||entry.receipt.logs.some(log=>extraSwapTopics.has(log.topics[0]))))return false;
  if(entry)for(const wallet of new Set(decoded.events.map(event=>event.walletAddress))){
    try{if(entry.transaction.from.toLowerCase()===wallet&&freshInteger(entry.transaction.value)!==0n)return false;}catch{return false;}
    if([...tokenFlows(wallet,entry.receipt.logs)].some(([token,flow])=>TRUSTED_QUOTE_FEEDS[token]&&flow.raw!==0n))return false;
  }
  const metadata=new Map(decoded.tokens.map(token=>[token.address,token]));
  let unvalued=false;
  for(const event of decoded.events){
    const token=event.tokenAddress&&metadata.get(event.tokenAddress);
    if(!token||!Number.isInteger(token.decimals)||token.decimals<0||token.decimals>255||event.canonical===false
      ||token.block.number!==Number(event.blockNumber)||token.block.hash!==event.blockHash||Date.parse(token.block.timestamp)!==Date.parse(event.occurredAt)
      ||!['transfer_in','transfer_out'].includes(event.kind)||event.feeUsd===null||event.logIndex===null||!event.transferKey)return false;
    try{if(q(event.quantity).n<=0n||q(event.feeUsd).n<0n||event.amountUsd!==null&&q(event.amountUsd).n<0n)return false;}catch{return false;}
    if(event.amountUsd===null){unvalued=true;if(!decoded.reasons.includes(event.kind==='transfer_in'?'incoming_transfer_cost_unknown':'outgoing_transfer_value_unknown'))return false;}
  }
  return unvalued&&decoded.reasons.every(reason=>decoded.events.some(event=>event.amountUsd===null&&event.kind===(reason==='incoming_transfer_cost_unknown'?'transfer_in':'transfer_out')));
}

/** Run under the decoder transaction lock, after this block's facts commit to
 * its transaction. Scope results preserve exact membership boundaries. The
 * selected batch also prevents an earlier transfer warning from completing
 * while a trade for the same affected book is waiting later in this batch. */
export async function canCompleteFreshUntradedTransfers(database:Pick<Pool,'query'>,decoded:FreshDecodedReceipt,batchEvents:FreshFinancialEvent[]=[]) {
  if(!freshTransferValuationOnly(decoded))return false;
  const pairs=[...new Map(decoded.events.map(event=>[`${event.walletAddress}:${event.tokenAddress}`,{wallet:event.walletAddress,token:event.tokenAddress!}])).values()];
  const trades=batchEvents.filter(event=>event.canonical!==false&&(event.kind==='buy'||event.kind==='sell'));
  if(pairs.length>256||trades.length>4096||pairs.some(pair=>trades.some(event=>event.walletAddress===pair.wallet&&event.tokenAddress===pair.token)))return false;
  const batch=trades.map(event=>({wallet_address:event.walletAddress,token_address:event.tokenAddress,block_number:event.blockNumber,occurred_at:event.occurredAt}));
  const result=await database.query(`WITH candidates AS(SELECT * FROM unnest($1::text[],$2::text[]) AS c(wallet_address,token_address)),
    batch AS(SELECT * FROM jsonb_to_recordset($3::jsonb) AS b(wallet_address text,token_address text,block_number bigint,occurred_at timestamptz))
    SELECT EXISTS(
      SELECT 1 FROM candidates c JOIN fresh.accounting_scopes s ON s.active AND c.wallet_address=ANY(s.wallet_addresses)
      JOIN fresh.scope_event_results r ON r.scope_id=s.id AND r.token_address=c.token_address AND r.tokens_trade
      JOIN fresh.financial_events e ON e.id=r.event_id AND e.canonical AND e.kind IN('buy','sell')
      UNION ALL
      SELECT 1 FROM candidates c JOIN fresh.accounting_scopes s ON s.active AND c.wallet_address=ANY(s.wallet_addresses)
      JOIN batch b ON b.token_address=c.token_address AND b.wallet_address=ANY(s.wallet_addresses)
      LEFT JOIN public.journal_wallets j ON j.user_id::text=s.account_id AND j.wallet_address=b.wallet_address
      WHERE (s.account_id IS NULL AND b.block_number>=s.starts_block AND b.occurred_at>=s.starts_at)
        OR (s.account_id IS NOT NULL AND j.wallet_address IS NOT NULL AND b.block_number>=COALESCE(j.registration_block,s.starts_block) AND b.occurred_at>=j.activity_from)
    ) AS has_trade`,[pairs.map(pair=>pair.wallet),pairs.map(pair=>pair.token),JSON.stringify(batch)]);
  return result.rows[0]?.has_trade===false;
}

/** An older external, unpriced, zero-fee receipt cannot change another token's
 * FIFO state. Only an entirely new token/book pair may use this shortcut;
 * any existing position, lot, result or internal counterpart keeps repair. */
export async function canAppendFreshIsolatedIncoming(database:Pick<Pool,'query'>,events:FreshFinancialEvent[],contexts:FreshDecodedReceipt[],scopes:string[]){
  if(!events.length||!contexts.length||!scopes.length||contexts.some(context=>!freshTransferValuationOnly(context)
    ||context.events.some(event=>event.kind!=='transfer_in'||event.amountUsd!==null||event.feeUsd!=='0'||!freshAddress(event.counterparty)))
    ||events.some(event=>event.kind!=='transfer_in'||event.amountUsd!==null||event.feeUsd!=='0'||event.canonical===false||!freshAddress(event.counterparty)))return false;
  const tokens=[...new Set(events.map(event=>event.tokenAddress!))],counterparties=[...new Set(events.map(event=>event.counterparty!))];
  const row=(await database.query(`SELECT EXISTS(
    SELECT 1 FROM fresh.positions WHERE scope_id=ANY($1::text[]) AND token_address=ANY($2::text[])
    UNION ALL SELECT 1 FROM fresh.open_lots WHERE scope_id=ANY($1::text[]) AND token_address=ANY($2::text[])
    UNION ALL SELECT 1 FROM fresh.scope_event_results WHERE scope_id=ANY($1::text[]) AND token_address=ANY($2::text[])
  ) AS has_state,EXISTS(SELECT 1 FROM fresh.accounting_scopes
    WHERE id=ANY($1::text[]) AND wallet_addresses&&$3::text[]) AS internal_counterparty,
    (SELECT count(*) FROM fresh.accounting_scopes WHERE active AND id=ANY($1::text[]))=cardinality($1::text[]) AS scopes_valid`,[scopes,tokens,counterparties])).rows[0];
  return row?.has_state===false&&row?.internal_counterparty===false&&row?.scopes_valid===true;
}

/** A correction is exceptional durable work, never a page-read recalculation.
 * Existing event identities stay stable; only the affected books are rebuilt. */
async function persistDecoded(client: PoolClient, decoded: FreshDecodedReceipt, now: Date, contexts: FreshDecodedReceipt[] = [decoded]) {
  await persistMetadata(client, decoded.tokens);
  const saved = decoded.events.length ? (await client.query(`SELECT * FROM fresh.financial_events WHERE id=ANY($1::text[]) OR
    canonical AND transaction_hash=ANY($2::text[]) AND block_hash=ANY($3::text[]) AND wallet_address=ANY($4::text[])`, [decoded.events.map(event => event.id),
    [...new Set(decoded.events.map(event => event.transactionHash))], [...new Set(decoded.events.map(event => event.blockHash))], [...new Set(decoded.events.map(event => event.walletAddress))]])).rows : [];
  // Early local decoder versions used the monitored-wallet iteration order in
  // transfer keys. Match the authentic Transfer log identity when repairing a
  // receipt so its retained financial/notification ID never changes.
  for (const event of decoded.events) if (!saved.some(row => row.id === event.id) && event.kind.startsWith('transfer_') && event.logIndex !== null) {
    const same = saved.filter(row => row.canonical && row.wallet_address === event.walletAddress && row.token_address === event.tokenAddress && row.kind === event.kind
      && row.block_hash === event.blockHash && row.transaction_hash === event.transactionHash && row.log_index === event.logIndex);
    if (same.length > 1) throw new Error('ambiguous_transfer_identity');
    if (same.length === 1) { event.id = same[0].id; event.executionKey = same[0].execution_key; }
  }
  const old = new Map(saved.map(row => [row.id, freshEventFromRow(row)]));
  for (const context of contexts) preserveFreshVerifiedValuations(context, old);
  const quoteUpdates=decoded.events.filter(event=>old.has(event.id)&&old.get(event.id)!.quoteAmount==null&&event.quoteAmount!=null&&freshSameTradeQuoteContext(old.get(event.id)!,event));
  for(const event of decoded.events){validateFreshFinancialEvent(event);const prior=old.get(event.id);if(prior)assertFreshEventQuoteCompatible(prior,event);}
  const changed = decoded.events.filter(event => { const previous = old.get(event.id); return previous && (['tokenAddress', 'quantity', 'amountUsd', 'feeUsd', 'feeKey', 'counterparty', 'transferKey', 'executionIndex'].some(key => previous[key as keyof FreshFinancialEvent] !== event[key as keyof FreshFinancialEvent])
    || freshAcquisitionCostKey(previous.acquisitionCost)!==freshAcquisitionCostKey(event.acquisitionCost)|| attributionKey(previous.feeAttribution) !== attributionKey(event.feeAttribution)); });
  const scopes = (await client.query('SELECT id FROM fresh.accounting_scopes WHERE active AND wallet_addresses && $1::text[] ORDER BY id', [[...new Set(decoded.events.map(event => event.walletAddress))]])).rows.map(row => row.id as string);
  for (const id of scopes) await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`fresh-scope:${id}`]);
  for (const event of changed) await client.query('UPDATE fresh.financial_events SET quantity=$2,amount_usd=$3,fee_usd=$4,fee_key=$5,counterparty=$6,transfer_key=$7,decoder_version=$8,execution_index=$9,fee_attribution=$10::jsonb,token_address=$11,acquisition_cost=$12::jsonb WHERE id=$1 AND canonical',
    [event.id, event.quantity, event.amountUsd, event.feeUsd, event.feeKey, event.counterparty, event.transferKey, FRESH_DECODER_VERSION, event.executionIndex, event.feeAttribution ? JSON.stringify(event.feeAttribution) : null, event.tokenAddress,event.acquisitionCost?JSON.stringify(event.acquisitionCost):null]);
  for(const event of quoteUpdates)await persistFreshTradeQuote(client,event);
  // Late metadata repair can insert older facts after later transactions were
  // already handled; reset only those affected books, not all KOL history.
  const first = decoded.events.filter(event => !old.has(event.id) && freshEventAccountingEligible(event)).sort(freshEventOrder)[0];
  const late = first ? (await client.query(`SELECT 1 FROM fresh.positions p JOIN fresh.financial_events last ON last.id=p.last_event_id
    WHERE p.scope_id=ANY($1::text[]) AND (last.block_number,last.transaction_index,last.execution_index,coalesce(last.log_index,-1),last.id)>
      ($2::bigint,$3::integer,$4::integer,$5::integer,$6::text) LIMIT 1`, [scopes, first.blockNumber, first.transactionIndex, first.executionIndex, first.logIndex ?? -1, first.id])).rowCount : 0;
  const isolatedAppend=!changed.length&&Boolean(late)&&await canAppendFreshIsolatedIncoming(client,
    decoded.events.filter(event=>!old.has(event.id)&&freshEventAccountingEligible(event)),contexts,scopes);
  if (changed.length || late&&!isolatedAppend) {
    for (const event of decoded.events.filter(event => !old.has(event.id))) await client.query(`INSERT INTO fresh.financial_events(id,execution_key,wallet_address,token_address,kind,quantity,amount_usd,fee_usd,fee_key,counterparty,transfer_key,
      block_number,block_hash,transaction_hash,transaction_index,execution_index,log_index,occurred_at,canonical,fee_attribution,quote_address,quote_symbol,quote_amount,acquisition_cost)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,true,$19::jsonb,$20,$21,$22,$23::jsonb) ON CONFLICT DO NOTHING`, [event.id, event.executionKey, event.walletAddress, event.tokenAddress, event.kind, event.quantity, event.amountUsd, event.feeUsd,
      event.feeKey, event.counterparty, event.transferKey, event.blockNumber, event.blockHash, event.transactionHash, event.transactionIndex, event.executionIndex, event.logIndex, event.occurredAt, event.feeAttribution ? JSON.stringify(event.feeAttribution) : null,event.quoteAddress??null,event.quoteSymbol??null,event.quoteAmount??null,event.acquisitionCost?JSON.stringify(event.acquisitionCost):null]);
    await rebuildFreshScopesAfterReorg(client, scopes, now);
  } else await applyFreshFinancialEvents(client, decoded.events, { now });
  for(const context of contexts)for(const[id,rate]of Object.entries(context.tradeBnbPrices??{})){
    const event=decoded.events.find(event=>event.id===id);if(!event)throw Error('trade_bnb_display_event_missing');
    await persistFreshTradeBnbPrice(client,event,rate);
  }
  if (decoded.events.length) await client.query('UPDATE fresh.financial_events SET decoder_version=$2 WHERE id=ANY($1::text[]) AND decoder_version IS DISTINCT FROM $2', [decoded.events.map(event => event.id), FRESH_DECODER_VERSION]);
}
/** Transaction-owned entry for decoder correction integration and repair jobs. */
export { persistDecoded as persistFreshDecodedReceipt };

/** One block per transaction: receipt events stay ordered, paired transfers
 * reach the combined Portfolio together, and unsupported work remains durable. */
export async function selectFreshDecodeEvidence(database: Pick<Pool, 'query'>, now: Date, limit = 16) {
  return database.query(`SELECT e.*,b.parent_hash,b.occurred_at FROM fresh.recent_evidence e JOIN fresh.recent_blocks b USING(block_number,block_hash)
    LEFT JOIN fresh.jobs j ON j.kind='decode_receipt' AND j.reference=e.tx_hash||':'||e.block_hash
    WHERE e.decoder_status='pending' OR e.decoder_status='repair' AND j.due_at<=$1 AND j.state='pending'
      OR e.decoder_status='done' AND e.decoder_version<$3
    ORDER BY CASE e.decoder_status WHEN 'pending' THEN 0 WHEN 'repair' THEN 1 ELSE 2 END,
      CASE WHEN e.decoder_status='repair' THEN j.due_at END,e.block_number,e.transaction_index,e.tx_hash LIMIT $2`, [now, Math.min(64, Math.max(1, limit)), FRESH_DECODER_VERSION]);
}
/** First failure is insertion-only. Retrying a pre-diagnostic job with empty
 * progress must leave its original unknown cause unknown. */
export async function queueFreshDecodeRepair(database:Pick<Pool,'query'>,row:{tx_hash:string;block_hash:string},now:Date,reasons:string[]){
  const safeReasons=reasons.filter(reason=>/^[a-z][a-z0-9_-]{0,127}$/.test(reason));
  const retained=safeReasons.length?safeReasons:['receipt_decoder_unavailable'],first={firstFailure:{version:1,at:now.toISOString(),reasons:retained}};
  await database.query(`INSERT INTO fresh.jobs(id,kind,reference,priority,due_at,last_error,progress) VALUES($1,'decode_receipt',$2,80,$3,$4,$6::jsonb)
    ON CONFLICT(kind,reference) DO UPDATE SET state='pending',attempts=fresh.jobs.attempts+1,
    due_at=$5::timestamptz+least(600,30*power(2,least(fresh.jobs.attempts,5)))*interval '1 second',last_error=EXCLUDED.last_error`,
    [`decode:${row.tx_hash}:${row.block_hash}`,`${row.tx_hash}:${row.block_hash}`,new Date(now.getTime()+30_000),retained.join(','),now,JSON.stringify(first)]);
}

/** Retain authentic state successes beside their original receipt, including
 * partial repairs. This never changes its transaction, logs or observation. */
export function freshDecodedEvidencePayload(entry:FreshCapturedReceipt,state:FreshStateEvidenceRpc,trace?:FreshCallTrace|null,recovery?:FreshReceiptRecoveryEvidence,diagnostics?:FreshDecodeDiagnostics){
  const changedRecovery=recovery&&JSON.stringify(recovery)!==JSON.stringify(entry.recoveryEvidence);
  const changedDiagnostics=diagnostics&&JSON.stringify(diagnostics)!==JSON.stringify((entry as FreshDiagnosedReceipt).decodeDiagnostics);
  if(!state.writes&&!state.rejectedPrior&&!(trace&&!entry.trace)&&!changedRecovery&&!changedDiagnostics)return null;
  const {stateEvidence:_prior,...original}=entry,proof=state.snapshot();
  return encodeFreshEvidence({...original,...(proof?{stateEvidence:proof}:{}),...(trace&&!entry.trace?{trace}:{}),...(recovery?{recoveryEvidence:recovery}:{}),...(diagnostics?{decodeDiagnostics:diagnostics}:{})} as FreshDiagnosedReceipt);
}
function retainedFirstFailure(value:unknown):FreshDecodeDiagnostics['firstFailure'] {
  if(!value||typeof value!=='object')return undefined;
  const first=value as NonNullable<FreshDecodeDiagnostics['firstFailure']>;
  if(first.version!==1||typeof first.at!=='string'||first.at.length>64||!Number.isFinite(Date.parse(first.at))||!Array.isArray(first.reasons)||!first.reasons.length||first.reasons.length>128
    ||first.reasons.some(reason=>typeof reason!=='string'||!/^[a-z][a-z0-9_-]{0,127}$/.test(reason)))return undefined;
  return{version:1,at:first.at,reasons:[...first.reasons]};
}
/** Finish movement coverage without inventing a transfer's unavailable value.
 * First diagnostic provenance moves into the same retained receipt before its
 * now-complete decode job is removed. Current warnings remain in last_error. */
export async function finishFreshDecodedReceipt(database:Pick<Pool,'query'>,options:{row:{tx_hash:string;block_hash:string};entry:FreshCapturedReceipt;decoded:FreshDecodedReceipt;
  state:FreshStateEvidenceRpc;recovery?:FreshReceiptRecoveryEvidence;now:Date;batchEvents?:FreshFinancialEvent[]}) {
  const{row,entry,decoded,state,recovery,now}=options;
  const ordinaryValuationOnly=freshTransferValuationOnly(decoded,entry);
  let passiveValuationOnly=false;
  if(!ordinaryValuationOnly){
    const proofEntry:FreshCapturedReceipt={...entry,...(decoded.trace?{trace:decoded.trace}:{}),...(state.snapshot()?{stateEvidence:state.snapshot()}:{}),...(recovery?{recoveryEvidence:recovery}:{})};
    if(proofEntry.completeTraceProof&&decoded.events.length&&decoded.events.every(event=>event.kind==='transfer_in'&&event.amountUsd===null&&event.feeUsd==='0')){
      for(const token of decoded.tokens)if((proofEntry.recoveryEvidence?.metadata?.[token.address]as{kind?:unknown}|undefined)?.kind==='imported_pinned_token_metadata')
        await certifyFreshPassiveImportedPrecision(token,proofEntry,{canonicalHash:async(number:number)=>(await database.query('SELECT block_hash FROM fresh.recent_blocks WHERE block_number=$1',[number])).rows[0]?.block_hash??null});
      passiveValuationOnly=freshPassiveIncomingOnly(decoded,proofEntry);
    }
  }
  const valuationOnly=(ordinaryValuationOnly||passiveValuationOnly)&&await canCompleteFreshUntradedTransfers(database,decoded,options.batchEvents);
  const waiting=decoded.reasons.length>0&&!valuationOnly;
  let diagnostics:FreshDecodeDiagnostics|undefined;
  if(!waiting){
    const job=(await database.query("SELECT progress FROM fresh.jobs WHERE kind='decode_receipt' AND reference=$1",[`${row.tx_hash}:${row.block_hash}`])).rows[0];
    const first=retainedFirstFailure((entry as FreshDiagnosedReceipt).decodeDiagnostics?.firstFailure)??retainedFirstFailure(job?.progress?.firstFailure);
    if(valuationOnly||first)diagnostics={version:1,valuationReasons:[...decoded.reasons],...(first?{firstFailure:first}:{})};
  }
  const dependencies=freshPositionDependencies({...entry,...(decoded.trace?{trace:decoded.trace}:{})});
  await database.query(`UPDATE fresh.recent_evidence SET decoder_status=$3,decoder_version=$4,last_error=$5,payload=COALESCE($6,payload),position_dependency_addresses=$7,position_dependency_proof=$8 WHERE tx_hash=$1 AND block_hash=$2`,
    [row.tx_hash,row.block_hash,waiting?'repair':'done',FRESH_DECODER_VERSION,decoded.reasons.join(',')||null,freshDecodedEvidencePayload(entry,state,decoded.trace,recovery,diagnostics),dependencies?.addresses??null,dependencies?.proofHash??null]);
  if(waiting)await queueFreshDecodeRepair(database,row,now,decoded.reasons);
  else await database.query("DELETE FROM fresh.jobs WHERE kind='decode_receipt' AND reference=$1",[`${row.tx_hash}:${row.block_hash}`]);
  return{waiting,valuationOnly};
}
/** Called with the receipt row locked. A concurrent authenticated repair must
 * win over work normalized from its earlier bytes outside the transaction. */
export function assertFreshDecodeEvidenceUnchanged(current:{wallet_addresses:string[];payload:Buffer}|undefined,selected:{payload:Buffer},wallets:string[]){
  if(!current||[...current.wallet_addresses].sort().join(',')!==[...wallets].sort().join(','))throw Error('decode_wallet_context_changed');
  if(!Buffer.isBuffer(current.payload)||!Buffer.isBuffer(selected.payload)||!current.payload.equals(selected.payload))throw Error('decode_evidence_changed');
}

/** Urgent capture may append exact-block raw successes while normalization is
 * outside its transaction. Only that additive change is compatible: immutable
 * receipt context, recovery/trace/launch proofs and diagnostics must match.
 * Keep the locked latest envelope and union agreeing raw reads without RPC.
 * A proof correction or registration change still requires normalization again. */
export function reconcileFreshDecodeEvidence(current:{wallet_addresses:string[];payload:Buffer}|undefined,selected:{payload:Buffer},entry:FreshCapturedReceipt,state:FreshStateEvidenceRpc){
  if(!current||[...current.wallet_addresses].sort().join(',')!==[...entry.wallets].sort().join(','))throw Error('decode_wallet_context_changed');
  if(!Buffer.isBuffer(current.payload)||!Buffer.isBuffer(selected.payload))throw Error('decode_evidence_changed');
  if(current.payload.equals(selected.payload))return{entry,state,merged:false};
  const latest=decodeFreshEvidence(current.payload),original=decodeFreshEvidence(selected.payload);
  const withoutState=(value:FreshCapturedReceipt)=>{const{stateEvidence:_state,version:_envelope,...context}=value as FreshCapturedReceipt&{version?:number};return JSON.stringify(context);};
  if(withoutState(latest)!==withoutState(original)||withoutState(entry)!==withoutState(original))throw Error('decode_evidence_changed');
  const block={number:Number(freshInteger(original.receipt.blockNumber)),hash:original.receipt.blockHash};
  const validate=(proof:FreshStateReadEvidence|undefined)=>{
    const checked=createFreshStateEvidenceRpc((async()=>{throw Error('decode_state_merge_no_rpc');})as Rpc,block,proof);
    if(checked.rejectedPrior)throw Error('decode_state_evidence_changed');return checked.snapshot();
  };
  const before=validate(original.stateEvidence),after=validate(latest.stateEvidence),normalized=validate(state.snapshot());
  const key=(call:FreshStateReadEvidence['calls'][number])=>`${call.to}:${call.data}`;
  const calls=new Map((after?.calls??[]).map(call=>[key(call),call]));
  for(const call of before?.calls??[])if(calls.get(key(call))?.result!==call.result)throw Error('decode_state_evidence_changed');
  for(const call of normalized?.calls??[]){
    const retained=calls.get(key(call));if(retained&&retained.result!==call.result)throw Error('decode_state_evidence_conflict');
    if(!retained)calls.set(key(call),call);
  }
  const combined=validate({version:1,blockNumber:block.number,blockHash:block.hash,calls:[...calls.values()]});
  const mergedState:FreshStateEvidenceRpc={rpc:state.rpc,get writes(){return state.writes;},get rejectedPrior(){return state.rejectedPrior;},settle:()=>state.settle(),snapshot:()=>combined};
  return{entry:latest,state:mergedState,merged:true};
}

/** A node outage/cooldown may use the same independently verified retained
 * proof as pruned state. The failure itself proves nothing; malformed ABI,
 * reverts and generic RPC failures still do not enter this recovery path. */
export function canRecoverFreshMetadata(error:unknown){
  if(!error||typeof error!=='object'||!('category' in error))return false;
  return error.category==='state_unavailable'||error.category==='transport'||error.category==='rate_limit';
}

export async function runFreshDecode(database: Pool, rpc: Rpc, options: { limit?: number; now?: Date; trace?: FreshTraceLoader; recoveryBatch?: FreshRecoveryBatch; maxNormalizeMs?:number; normalizationNow?:()=>number } = {}) {
  const now = options.now ?? new Date(), selected = await selectFreshDecodeEvidence(database, now, options.limit);
  if (!selected.rows.length) return { receipts: 0, attemptedReceipts:0,deferredReceipts:0,events: 0, repair: 0, unsupported: 0, evidenceMerges:0,completeCutoffBlock: null };
  const boundary = (await database.query("SELECT value FROM fresh.checkpoints WHERE key='capture'")).rows[0]?.value?.startBlock;
  if (!Number.isSafeInteger(Number(boundary))) throw new Error('tracking_boundary_uninitialized');
  const decodedRows: { row: any; entry: FreshCapturedReceipt; decoded: FreshDecodedReceipt; state:FreshStateEvidenceRpc; recovery:ReturnType<typeof createFreshReceiptRecovery> }[] = [];
  const launchCache = new Map<string, Promise<{ status: string; block_number: string } | undefined>>();
  const launchFact = (token: string) => { let value = launchCache.get(token); if (!value) { value = database.query('SELECT status,block_number FROM fresh.launch_facts WHERE token_address=$1', [token]).then(result => result.rows[0]); launchCache.set(token, value); } return value; };
  // Coalesce wire reads while each receipt records the successful values it
  // actually used. Caching whole metadata promises lost those proofs on retry.
  const wireReads=new Map<string,Promise<unknown>>();
  const sharedRpc:Rpc=async<T>(method:string,params:unknown[]):Promise<T>=>{
    const key=JSON.stringify([method,params]);let pending=wireReads.get(key);
    if(!pending){pending=rpc<unknown>(method,params);if(wireReads.size<4096)wireReads.set(key,pending);}
    try{return await pending as T;}catch(error){if(wireReads.get(key)===pending)wireReads.delete(key);throw error;}
  };
  let unsupported = 0,attemptedReceipts=0;
  const canStartGroup=createFreshDecodeWorkBudget({maxMs:options.maxNormalizeMs,now:options.normalizationNow});
  // Yield before another complete selected block group, never inside a receipt
  // or its financial transaction. Unstarted rows remain exactly as selected.
  for(const group of groupFreshDecodeRows(selected.rows)){
    if(!canStartGroup())break;
    for (const row of group) {attemptedReceipts++;
    const entry = decodeFreshEvidence(row.payload), block: FreshPriceBlock = { number: Number(row.block_number), hash: row.block_hash, timestamp: new Date(row.occurred_at).toISOString() };
    const state=createFreshStateEvidenceRpc(sharedRpc,block,entry.stateEvidence);
    const recovery=createFreshReceiptRecovery(database,sharedRpc,entry,block,{state:()=>state.snapshot()??undefined,batch:options.recoveryBatch});
    const services: FreshDecodeServices = {
      async metadata(token) {const imported=await recovery.importedMetadata(token);if(imported)return imported;
        try{return await freshTokenMetadata(token,{rpc:state.rpc,block,requireSupply:false});}
        catch(error){if(canRecoverFreshMetadata(error)){
          const recovered=await recovery.metadata(token).catch(()=>null);if(recovered)return recovered;
        }throw error;}},
      async knownLaunch(token) { const fact = await launchFact(token); return Boolean(fact && fact.status === 'eligible' && Number(fact.block_number) > Number(boundary) && Number(fact.block_number) <= block.number); },
      async eligible(token) { const fact = await launchFact(token.address); return Boolean(fact && fact.status === 'eligible' && Number(fact.block_number) > Number(boundary) && Number(fact.block_number) <= block.number); },
      priceUsd(token) { return (TRUSTED_QUOTE_FEEDS[token]?freshQuoteUsd(token,{rpc:state.rpc,block}):freshCurrentQuote(token,{rpc:state.rpc,block}).then(quote=>quote.priceUsd)).catch(()=>recovery.priceUsd(token)); },
      additionalNativeFeeWei:recovery.additionalNativeFeeWei,
      directFlapPurchaseUsd:recovery.directFlapPurchaseUsd,
      quotePaymentUsd:recovery.quotePaymentUsd,
      retainedQuoteMetadata:recovery.importedMetadata,
      nativeQuoteChangeUsd:recovery.nativeQuoteChangeUsd,
      acquisitionCost:recovery.acquisitionCost,
      signedBatchPurchaseUsd:recovery.signedBatchPurchaseUsd,
      syntheticBatchAnchor:token=>readFreshSyntheticBatchAnchor(database,token),
      trace: options.trace ?? freshIpcTrace,
    };
    try { const decoded = await normalizeFreshReceipt(entry, { number: `0x${block.number.toString(16)}`, hash: block.hash, timestamp: `0x${Math.floor(Date.parse(block.timestamp) / 1_000).toString(16)}` }, services);
      if(entry.launchRepair)decoded.reasons.push('factory_launch_unverified');await state.settle();decodedRows.push({ row, entry, decoded,state,recovery }); }
    catch (error) {
      unsupported++;
      const reason = error instanceof Error ? error.message.slice(0, 128) : 'receipt_decoder_unavailable';
      await state.settle();
      const client=await database.connect();
      try{
        await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock(73621941)');
        const transactionNow=options.now??new Date();
        const canonical=(await client.query('SELECT block_hash FROM fresh.recent_blocks WHERE block_number=$1 FOR SHARE',[block.number])).rows[0];
        if(canonical?.block_hash===block.hash){
          const saved=await client.query(`UPDATE fresh.recent_evidence SET decoder_status='repair',last_error=$3,payload=COALESCE($4,payload)
            WHERE tx_hash=$1 AND block_hash=$2 AND payload=$5`,[row.tx_hash,row.block_hash,reason,freshDecodedEvidencePayload(entry,state,undefined,recovery.snapshot()),row.payload]);
          if(saved.rowCount)await queueFreshDecodeRepair(client,row,transactionNow,[reason]);
        }
        await client.query('COMMIT');
      }catch(failure){await client.query('ROLLBACK');throw failure;}finally{client.release();}
    }
  }}
  decodedRows.sort((a, b) => Number(a.row.block_number) - Number(b.row.block_number) || Number(freshInteger(a.entry.transaction.transactionIndex)) - Number(freshInteger(b.entry.transaction.transactionIndex)));
  let events = 0, repair = 0,evidenceMerges=0;
  const byBlock = new Map<number, typeof decodedRows>();
  for (const row of decodedRows) { const rows = byBlock.get(Number(row.row.block_number)) ?? []; rows.push(row); byBlock.set(Number(row.row.block_number), rows); }
  for (const [number, rows] of byBlock) {
    const client = await database.connect();
    try {
      await client.query('BEGIN'); await client.query('SELECT pg_advisory_xact_lock(73621941)');
      // Selection/RPC work and a contended financial lock may outlive a rolling
      // refresh. Sample the live accounting clock only after owning this block.
      const transactionNow=options.now??new Date();
      const canonical = await client.query('SELECT block_hash FROM fresh.recent_blocks WHERE block_number=$1 FOR SHARE', [number]);
      if (!canonical.rows[0] || canonical.rows[0].block_hash !== rows[0].row.block_hash) throw new Error('decode_block_invalidated');
      for (const work of rows) {
        const current = (await client.query('SELECT wallet_addresses,payload FROM fresh.recent_evidence WHERE tx_hash=$1 AND block_hash=$2 FOR UPDATE', [work.row.tx_hash, work.row.block_hash])).rows[0];
        const reconciled=reconcileFreshDecodeEvidence(current,work.row,work.entry,work.state);
        work.entry=reconciled.entry;work.state=reconciled.state;if(reconciled.merged)evidenceMerges++;
      }
      // A concurrent authenticated correction must win over a previously
      // cached eligible launch, even when that stale decode emitted no facts.
      const contracts=[...new Set(rows.flatMap(({entry})=>entry.receipt.logs.map(log=>log.address.toLowerCase())))];
      if(contracts.length){
        const excluded=(await client.query("SELECT token_address FROM fresh.launch_facts WHERE token_address=ANY($1::text[]) AND status='excluded_non_token'",[contracts])).rows;
        for(const item of excluded)if((await launchCache.get(item.token_address))?.status==='eligible')throw new Error('decode_token_authenticity_changed');
      }
      for(const token of new Set(rows.flatMap(row=>row.decoded.syntheticTransferBatch?[row.decoded.syntheticTransferBatch.tokenAddress]:[])))if(!await readFreshSyntheticBatchAnchor(client,token))throw Error('decode_synthetic_birth_changed');
      // Apply the whole block's normalized events together for transfer pairing.
      const combined = { events: rows.flatMap(row => row.decoded.events), reasons: rows.flatMap(row => row.decoded.reasons), tokens: rows.flatMap(row => row.decoded.tokens), executions: rows.reduce((sum, row) => sum + row.decoded.executions, 0) };
      await persistDecoded(client, combined, transactionNow, rows.map(row => row.decoded)); events += combined.events.length;
      for (const { entry, decoded } of rows) if (entry.historicalWallets?.length) await client.query(`UPDATE fresh.financial_events SET observed_live=false
        WHERE id=ANY($1::text[]) AND wallet_address=ANY($2::text[]) AND observed_live`, [decoded.events.map(event => event.id), entry.historicalWallets]);
      const batchEvents=decodedRows.flatMap(row=>row.decoded.events);
      for (const { row, decoded, entry,state,recovery } of rows) {
        const{waiting}=await finishFreshDecodedReceipt(client,{row,entry,decoded,state,recovery:recovery.snapshot(),now:transactionNow,batchEvents});if(waiting)repair++;
      }
      await client.query(`INSERT INTO fresh.checkpoints(key,block_number,block_hash) VALUES('decode',$1,$2)
        ON CONFLICT(key) DO UPDATE SET block_number=greatest(fresh.checkpoints.block_number,EXCLUDED.block_number),block_hash=CASE WHEN fresh.checkpoints.block_number<=EXCLUDED.block_number THEN EXCLUDED.block_hash ELSE fresh.checkpoints.block_hash END,updated_at=clock_timestamp()`, [number, rows[0].row.block_hash]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }
  const pending = await database.query(`SELECT min(block_number) AS first_pending FROM fresh.recent_evidence WHERE decoder_status<>'done'`), capture = (await database.query("SELECT block_number FROM fresh.checkpoints WHERE key='capture'")).rows[0];
  return { receipts: decodedRows.length,attemptedReceipts,deferredReceipts:selected.rows.length-attemptedReceipts,events, repair, unsupported,evidenceMerges,completeCutoffBlock: pending.rows[0].first_pending == null ? Number(capture?.block_number ?? 0) : Number(pending.rows[0].first_pending) - 1 };
}

/** Caller has independently found a common canonical ancestor. Data outside
 * the 72-hour repair window fails closed; no unverifiable rewrite is attempted. */
export async function rollbackFreshToAncestor(client: PoolClient, ancestor: { blockNumber: number; blockHash: string }, now = new Date(), onRollback?: (client: PoolClient, blockNumber: number) => Promise<void>) {
  await client.query('SELECT pg_advisory_xact_lock(73621941)');
  const checkpoint = (await client.query("SELECT * FROM fresh.checkpoints WHERE key='capture' FOR UPDATE")).rows[0];
  if (!checkpoint || ancestor.blockNumber < Number(checkpoint.value?.startBlock) || !freshHash(ancestor.blockHash)) throw new Error('reorg_outside_tracking_boundary');
  const known = (await client.query('SELECT 1 FROM fresh.recent_blocks WHERE block_number=$1 AND block_hash=$2', [ancestor.blockNumber, ancestor.blockHash])).rowCount;
  if (!known && (Number(checkpoint.value?.startBlock) !== ancestor.blockNumber || checkpoint.value?.startHash !== ancestor.blockHash)) throw new Error('reorg_beyond_repair_buffer');
  await invalidateFreshNotificationActivation(client,ancestor.blockNumber,now);
  const wallets = (await client.query(`UPDATE fresh.financial_events SET canonical=false WHERE canonical AND block_number>$1 RETURNING wallet_address`, [ancestor.blockNumber])).rows.map(row => row.wallet_address);
  const scopes = (await client.query(`SELECT id FROM fresh.accounting_scopes s WHERE wallet_addresses && $1::text[]
    OR EXISTS(SELECT 1 FROM fresh.positions p LEFT JOIN fresh.tokens t ON t.address=p.token_address WHERE p.scope_id=s.id AND (p.balance_block>$2 OR t.observed_block>$2))
    ORDER BY id`, [wallets, ancestor.blockNumber])).rows.map(row => row.id);
  await rebuildFreshScopesAfterReorg(client, scopes, now);
  if (onRollback) await onRollback(client, ancestor.blockNumber);
  await client.query(`DELETE FROM fresh.jobs WHERE kind='decode_receipt' AND reference IN(SELECT tx_hash||':'||block_hash FROM fresh.recent_evidence WHERE block_number>$1)`, [ancestor.blockNumber]);
  await client.query('DELETE FROM fresh.recent_evidence WHERE block_number>$1', [ancestor.blockNumber]);
  // The normal collector includes the registered wallet when it resumes past
  // the ancestor. Registration repair therefore needs only its earlier gap.
  await client.query(`DELETE FROM fresh.jobs WHERE kind='registration_capture' AND
    ((progress->>'fromBlock')::bigint>$1 OR (progress->>'throughBlock')::bigint>=$1)`, [ancestor.blockNumber]);
  await client.query(`UPDATE fresh.jobs SET progress=jsonb_set(jsonb_set(progress,'{targetBlock}',to_jsonb($1::bigint)),'{targetHash}',to_jsonb($2::text)),
    lease_id=NULL,lease_until=NULL,due_at=$3,last_error='registration_reorg_rewind',updated_at=clock_timestamp()
    WHERE kind='registration_capture' AND (progress->>'targetBlock')::bigint>$1`, [ancestor.blockNumber, ancestor.blockHash, now]);
  await client.query('DELETE FROM fresh.launch_facts WHERE block_number>$1', [ancestor.blockNumber]);
  await client.query("UPDATE fresh.tokens SET launch_status='unverified',price_usd=NULL,market_cap_usd=NULL,valuation_status='reorg' WHERE launch_status='eligible' AND NOT EXISTS(SELECT 1 FROM fresh.launch_facts f WHERE f.token_address=fresh.tokens.address AND f.status='eligible')");
  await client.query("UPDATE fresh.tokens SET price_usd=NULL,market_cap_usd=NULL,valuation_status='reorg' WHERE observed_block>$1", [ancestor.blockNumber]);
  await client.query("UPDATE fresh.positions SET balance_quantity=NULL,balance_block=NULL,balance_hash=NULL,balance_checked_at=NULL,balance_status='pending' WHERE balance_block>$1", [ancestor.blockNumber]);
  await client.query("UPDATE fresh.markets SET state='{}',status='reorg',observed_block=NULL,observed_hash=NULL,observed_at=NULL WHERE observed_block>$1", [ancestor.blockNumber]);
  await client.query(`UPDATE fresh.markets SET identity=jsonb_set(identity,'{canonicalIdentityInvalid}','true'::jsonb),state='{}',status='reorg',
    observed_block=NULL,observed_hash=NULL,observed_at=NULL WHERE protocol='uniswap_v4'
    AND CASE WHEN jsonb_typeof(COALESCE(identity->'market'->'initial'->'blockNumber',identity->'initial'->'blockNumber'))='number'
      THEN (COALESCE(identity->'market'->'initial'->>'blockNumber',identity->'initial'->>'blockNumber'))::numeric>$1 ELSE false END`,[ancestor.blockNumber]);
  await client.query('DELETE FROM fresh.recent_blocks WHERE block_number>$1', [ancestor.blockNumber]);
  await client.query('UPDATE fresh.wallets SET decode_gap_from_block=NULL,decode_gap_reason=NULL WHERE decode_gap_from_block>$1', [ancestor.blockNumber]);
  await client.query("UPDATE fresh.checkpoints SET block_number=$1,block_hash=$2,revision=revision+1,updated_at=clock_timestamp() WHERE key IN('capture','decode')", [ancestor.blockNumber, ancestor.blockHash]);
  return { scopes: scopes.length, wallets: new Set(wallets).size };
}
