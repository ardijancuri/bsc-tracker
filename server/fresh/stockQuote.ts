import { createHash } from 'node:crypto';
import { Interface, zeroPadValue } from 'ethers';
import type { Rpc } from '../rpc.js';
import { WBNB } from '../launchpad.js';
import type { FreshLog, FreshReceipt } from './capture.js';
import type { FreshPriceBlock } from './pricing.js';

// The official WOOFi deployment list names this BSC WooPPV2 multiasset venue:
// https://github.com/woonetwork/docs/blob/main/guides/integrate-woofi-as-liquidity-source.md
// Event ABI: https://github.com/woonetwork/WooPoolV2/blob/main/contracts/interfaces/IWooPPV2.sol
// Its proxy is upgradeable. No current implementation, inventory balance,
// decimals getter or current oracle answer proves its historical exchange rate.
export const FRESH_WOOFI_BSC_POOL = '0x5520385bfcf07ec87c4c53a7d8d65595dff69fa4';
export const FRESH_STOCK_QUOTE_TOKEN = '0x02fca66c1d1afb4e2a7884261eb00f63598a7436';
export const FRESH_STOCK_QUOTE_MAX_AGE_SECONDS = 120;
export const freshWooSwapInterface = new Interface([
  'event WooSwap(address indexed fromToken,address indexed toToken,uint256 fromAmount,uint256 toAmount,address from,address indexed to,address rebateTo,uint256 swapVol,uint256 swapFee)',
  'event Transfer(address indexed from,address indexed to,uint256 value)',
]);
export const FRESH_WOO_SWAP_TOPIC = freshWooSwapInterface.getEvent('WooSwap')!.topicHash;
const transferTopic = freshWooSwapInterface.getEvent('Transfer')!.topicHash;
const hash = (v: unknown): v is string => typeof v === 'string' && /^0x[\da-f]{64}$/.test(v);
const address = (v: unknown): v is string => typeof v === 'string' && /^0x[\da-f]{40}$/.test(v);
const quantity = (v: unknown): v is string => typeof v === 'string' && /^0x[\da-f]{1,16}$/.test(v) && BigInt(v) <= BigInt(Number.MAX_SAFE_INTEGER);
const hex = (n: number) => '0x' + n.toString(16);
const number = (v: string) => Number(BigInt(v));
const stable = (v: unknown): string => JSON.stringify(v, (_key, value: unknown) => value && typeof value === 'object' && !Array.isArray(value)
  ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value);
const digest = (v: unknown) => createHash('sha256').update(stable(v)).digest('hex');
const sameBlock = (a: FreshPriceBlock, b: FreshPriceBlock) => a.number === b.number && a.hash === b.hash && a.timestamp === b.timestamp;
const validBlock = (b: FreshPriceBlock) => b && Number.isSafeInteger(b.number) && b.number >= 0 && hash(b.hash)
  && typeof b.timestamp === 'string' && Number.isFinite(Date.parse(b.timestamp)) && new Date(b.timestamp).toISOString() === b.timestamp;
const decodeEvent = (name: 'WooSwap' | 'Transfer', log: FreshLog) => {
  try {
    const parsed = freshWooSwapInterface.decodeEventLog(name, log.data, log.topics);
    // Reject dirty padding as well as values that a permissive decoder truncates.
    const encoded = freshWooSwapInterface.encodeEventLog(freshWooSwapInterface.getEvent(name)!, [...parsed]);
    if (encoded.data !== log.data || stable(encoded.topics) !== stable(log.topics)) throw Error();
    return parsed;
  } catch { throw Error(name === 'WooSwap' ? 'stock_quote_event_invalid' : 'stock_quote_settlement_invalid'); }
};

export interface FreshStockRawQuoteEvidence {
  version: 1;
  kind: 'woofi_settled_raw_quote';
  chainId: 56;
  venue: typeof FRESH_WOOFI_BSC_POOL;
  quoteToken: typeof FRESH_STOCK_QUOTE_TOKEN;
  nativeToken: typeof WBNB;
  target: FreshPriceBlock;
  source: FreshPriceBlock;
  searchFromBlock: number;
  searchToBlock: number;
  swapLogIndex: number;
  inputLogIndex: number;
  outputLogIndex: number;
  /** Exact WBNB raw / NVDA raw. NVDA decimals are deliberately absent. */
  nativeRaw: string;
  quoteRaw: string;
  receipt: FreshReceipt;
  receiptSha256: string;
}

function validLog(log: FreshLog, source?: FreshPriceBlock, receipt?: FreshReceipt) {
  return !!log && !log.removed && address(log.address) && Array.isArray(log.topics) && log.topics.length <= 4 && log.topics.every(hash)
    && /^0x(?:[\da-f]{2})*$/.test(log.data) && log.data.length <= 8194 && hash(log.blockHash) && hash(log.transactionHash)
    && [log.blockNumber, log.transactionIndex, log.logIndex].every(quantity)
    && (!source || number(log.blockNumber) === source.number && log.blockHash === source.hash)
    && (!receipt || log.transactionHash === receipt.transactionHash && log.transactionIndex === receipt.transactionIndex);
}

function settledQuote(receipt: FreshReceipt, source: FreshPriceBlock, selected: FreshLog) {
  if (!receipt || stable(receipt).length > 256 * 1024 || receipt.status !== '0x1' || receipt.blockHash !== source.hash
    || !quantity(receipt.blockNumber) || number(receipt.blockNumber) !== source.number || !hash(receipt.transactionHash)
    || !quantity(receipt.transactionIndex) || !Array.isArray(receipt.logs) || receipt.logs.length > 512) throw Error('stock_quote_receipt_invalid');
  let last = -1, priorSwapIndex = -1;
  for (const l of receipt.logs) {
    if (!validLog(l, source, receipt) || number(l.logIndex) <= last) throw Error('stock_quote_receipt_invalid');
    last = number(l.logIndex);
    if (l.address === FRESH_WOOFI_BSC_POOL && l.topics[0] === FRESH_WOO_SWAP_TOPIC && last < number(selected.logIndex)) priorSwapIndex = last;
  }
  const event = receipt.logs.find(l => l.logIndex === selected.logIndex);
  if (!event || !validLog(selected, source, receipt) || event.address !== selected.address || event.data !== selected.data
    || stable(event.topics) !== stable(selected.topics) || event.address !== FRESH_WOOFI_BSC_POOL
    || event.topics.length !== 4 || event.topics[0] !== FRESH_WOO_SWAP_TOPIC || !/^0x[\da-f]{384}$/.test(event.data)) throw Error('stock_quote_event_invalid');
  const parsed = decodeEvent('WooSwap', event);
  const fromToken = String(parsed.fromToken).toLowerCase(), toToken = String(parsed.toToken).toLowerCase();
  const from = String(parsed.from).toLowerCase(), to = String(parsed.to).toLowerCase();
  const fromAmount = BigInt(parsed.fromAmount), toAmount = BigInt(parsed.toAmount);
  if (fromToken === toToken || ![fromToken, toToken].includes(WBNB) || ![fromToken, toToken].includes(FRESH_STOCK_QUOTE_TOKEN)
    || fromAmount <= 0n || toAmount <= 0n || [from, to].some(v => v === FRESH_WOOFI_BSC_POOL || v === '0x' + '0'.repeat(40))) throw Error('stock_quote_assets_invalid');
  const flows: {log: FreshLog; token: string; from: string; to: string; value: bigint}[] = [];
  for (const log of receipt.logs) {
    const index = number(log.logIndex);
    if (index <= priorSwapIndex || index >= number(event.logIndex) || ![WBNB, FRESH_STOCK_QUOTE_TOKEN].includes(log.address) || log.topics[0] !== transferTopic) continue;
    if (log.topics.length !== 3 || !/^0x[\da-f]{64}$/.test(log.data)) throw Error('stock_quote_settlement_invalid');
    const transfer = decodeEvent('Transfer', log);
    const f = String(transfer.from).toLowerCase(), t = String(transfer.to).toLowerCase();
    if (f === FRESH_WOOFI_BSC_POOL || t === FRESH_WOOFI_BSC_POOL) flows.push({log, token: log.address, from: f, to: t, value: BigInt(transfer.value)});
  }
  const input = flows.filter(f => f.token === fromToken && f.from === from && f.to === FRESH_WOOFI_BSC_POOL && f.value === fromAmount);
  const output = flows.filter(f => f.token === toToken && f.from === FRESH_WOOFI_BSC_POOL && f.to === to && f.value === toAmount);
  if (flows.length !== 2 || input.length !== 1 || output.length !== 1 || number(input[0].log.logIndex) >= number(output[0].log.logIndex)) throw Error('stock_quote_settlement_invalid');
  return {nativeRaw: (fromToken === WBNB ? fromAmount : toAmount).toString(), quoteRaw: (fromToken === FRESH_STOCK_QUOTE_TOKEN ? fromAmount : toAmount).toString(),
    inputLogIndex: number(input[0].log.logIndex), outputLogIndex: number(output[0].log.logIndex)};
}

/** A bounded historical executed rate, including venue spread/fees, never a
 * state/spot oracle. Callers combine this raw rational with NVDARaw/tokenRaw;
 * only final token/native precision is needed. The target is end-of-block, but
 * the quote is strictly from an earlier block, preventing later same-block
 * trades from pricing an earlier receipt. Prior evidence is trusted retained
 * own-node capture, revalidated for canonicality and exact settlement on replay. */
export async function recoverFreshStockRawQuote(options: {rpc: Rpc; target: FreshPriceBlock;
  canonicalHash: (number: number) => Promise<string | null>; prior?: FreshStockRawQuoteEvidence}): Promise<FreshStockRawQuoteEvidence> {
  const {rpc, target, canonicalHash, prior} = options;
  if (!validBlock(target) || target.number < 1) throw Error('stock_quote_target_invalid');
  if (await canonicalHash(target.number) !== target.hash) throw Error('stock_quote_noncanonical');
  const searchFromBlock = Math.max(0, target.number - 512), searchToBlock = target.number - 1;
  if (prior && (prior.version !== 1 || prior.kind !== 'woofi_settled_raw_quote' || prior.chainId !== 56 || prior.venue !== FRESH_WOOFI_BSC_POOL
    || prior.quoteToken !== FRESH_STOCK_QUOTE_TOKEN || prior.nativeToken !== WBNB || !validBlock(prior.target) || !sameBlock(prior.target, target)
    || prior.searchFromBlock !== searchFromBlock || prior.searchToBlock !== searchToBlock || !validBlock(prior.source))) throw Error('stock_quote_prior_invalid');
  let selected: FreshLog, source: FreshPriceBlock, receipt: FreshReceipt;
  if (prior) {
    source = prior.source; receipt = prior.receipt;
    selected = receipt?.logs?.find(l => quantity(l.logIndex) && number(l.logIndex) === prior.swapLogIndex)!;
    if (!selected || digest(receipt) !== prior.receiptSha256) throw Error('stock_quote_prior_invalid');
  } else {
    if (await rpc<string>('eth_chainId', []) !== '0x38') throw Error('stock_quote_chain_invalid');
    const tokens = [zeroPadValue(WBNB, 32), zeroPadValue(FRESH_STOCK_QUOTE_TOKEN, 32)];
    const logs = await rpc<FreshLog[]>('eth_getLogs', [{address: FRESH_WOOFI_BSC_POOL, fromBlock: hex(searchFromBlock), toBlock: hex(searchToBlock), topics: [FRESH_WOO_SWAP_TOPIC, tokens, tokens]}]);
    if (!Array.isArray(logs) || logs.length > 512) throw Error('stock_quote_work_bounds');
    let previous = -1n;
    for (const l of logs) {
      if (!validLog(l) || l.address !== FRESH_WOOFI_BSC_POOL || l.topics.length !== 4 || l.topics[0] !== FRESH_WOO_SWAP_TOPIC
        || l.topics[1] === l.topics[2] || !tokens.includes(l.topics[1]) || !tokens.includes(l.topics[2])
        || number(l.blockNumber) < searchFromBlock || number(l.blockNumber) > searchToBlock) throw Error('stock_quote_log_invalid');
      const position = BigInt(l.blockNumber) * (1n << 64n) + BigInt(l.transactionIndex) * (1n << 32n) + BigInt(l.logIndex);
      if (position <= previous || BigInt(l.transactionIndex) >= (1n << 32n) || BigInt(l.logIndex) >= (1n << 32n)) throw Error('stock_quote_log_order_invalid');
      previous = position;
    }
    if (!logs.length) throw Error('stock_quote_unavailable');
    selected = logs.at(-1)!;
    const block = await rpc<{number: string; hash: string; timestamp: string; transactions: string[]}>('eth_getBlockByNumber', [selected.blockNumber, false]);
    if (!block || !quantity(block.number) || block.number !== selected.blockNumber || block.hash !== selected.blockHash || !quantity(block.timestamp)
      || number(block.timestamp) > 8640000000000 || !Array.isArray(block.transactions)
      || block.transactions[number(selected.transactionIndex)] !== selected.transactionHash) throw Error('stock_quote_block_invalid');
    source = {number: number(block.number), hash: block.hash, timestamp: new Date(number(block.timestamp) * 1000).toISOString()};
    receipt = await rpc<FreshReceipt>('eth_getTransactionReceipt', [selected.transactionHash]);
  }
  if (source.number < searchFromBlock || source.number > searchToBlock || await canonicalHash(source.number) !== source.hash) throw Error('stock_quote_noncanonical');
  const age = (Date.parse(target.timestamp) - Date.parse(source.timestamp)) / 1000;
  if (age < 0 || age > FRESH_STOCK_QUOTE_MAX_AGE_SECONDS) throw Error('stock_quote_stale');
  const settled = settledQuote(receipt, source, selected);
  const result: FreshStockRawQuoteEvidence = {version: 1, kind: 'woofi_settled_raw_quote', chainId: 56, venue: FRESH_WOOFI_BSC_POOL,
    quoteToken: FRESH_STOCK_QUOTE_TOKEN, nativeToken: WBNB, target: {...target}, source, searchFromBlock, searchToBlock,
    swapLogIndex: number(selected.logIndex), ...settled, receipt, receiptSha256: digest(receipt)};
  if (prior && stable(prior) !== stable(result)) throw Error('stock_quote_prior_invalid');
  return result;
}
