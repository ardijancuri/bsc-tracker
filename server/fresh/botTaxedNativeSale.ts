import { AbiCoder } from 'ethers';
import { WBNB } from '../launchpad.js';
import { v3MarketAbi } from '../nodeMarketProtocols.js';
import { beforeExecutionTopic, userOperationTopic } from '../smartAccountTrades.js';
import { transferTopic } from '../swap.js';
import { freshAddress, freshHash, freshInteger, validateFreshReceipt, type FreshCapturedReceipt, type FreshLog, type FreshTransaction } from './capture.js';
import { FRESH_CURRENT_NATIVE_QUOTES } from './currentNativeQuote.js';
import { freshPoolQuotePair } from './currentPoolQuote.js';
import { freshHistoricalV3Pool } from './historicalV3Quote.js';
import type { FreshPriceBlock } from './pricing.js';
import { freshNativeDelta, freshTraceMatchesTransaction, validateFreshTrace } from './trace.js';

const bot = '0x9689992f5b5c09447f15906d8d11214944488341';
const quote = FRESH_CURRENT_NATIVE_QUOTES.bncb;
const selector = '0x3e0f9c3c';
const commands = '0x090023';
const routeFeeRecipient = '0xdec29d79e8cdf009d2fa33e0558cb5648481cac3';
const feeReferral = '0x815d4fca121b80395b5f8d2c4fbd6053b40195e4';
const zero = '0x' + '0'.repeat(40);
const withdrawTopic = '0x7fcf532c15f0a6db0bd6d0e038bea71d30d808c7d98cb3bf7268a95bf5081b65';
const settlementTopic = '0xa615c02f8d2e4ed8939b003560300a25353b784438c2efaa9f20fb5303a4d6d8';
const v2SwapTopic = '0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822';
const abi = AbiCoder.defaultAbiCoder();
const executeTypes = ['bytes', 'bytes[]', 'uint256'];
const word = (v: bigint | string) => (typeof v === 'bigint' ? v.toString(16) : v.slice(2)).padStart(64, '0');
const words = (v: string, count: number) => v.length === 2 + 64 * count && /^0x[0-9a-f]+$/.test(v)
  ? v.slice(2).match(/.{64}/g)! : null;
const matches = (log: FreshLog, emitter: string, topic: string, actors: string[]) => log.address === emitter
  && log.topics.length === actors.length + 1 && log.topics[0] === topic
  && actors.every((actor, i) => log.topics[i + 1] === '0x' + word(actor));

/** Identify a signed route even when its settlement evidence fails. The gross
 * WBNB withdrawal alone is never the wallet payout for this command sequence. */
export function isFreshBotTaxedNativeSale(tx: FreshTransaction): boolean {
  if (tx.to !== bot || typeof tx.input !== 'string' || !tx.input.startsWith(selector) || tx.input.length > 4096) return false;
  try {
    return abi.decode(['bytes'], '0x' + tx.input.slice(10))[0] === commands;
  } catch { return false; }
}

/** Bind the bot's final net payout event to its signed route, the wallet's full
 * taxed token debit, and both actual Pancake swaps. Any captured trace must
 * agree with the payout; chain gas remains a separate fee. */
export function freshBotTaxedNativeSale(entry: FreshCapturedReceipt, block: FreshPriceBlock, token: string, wallet: string, targetRaw: bigint) {
  try {
    const { transaction: tx, receipt } = entry;
    const sold = -targetRaw;
    const seconds = Date.parse(block.timestamp) / 1_000;
    if (!isFreshBotTaxedNativeSale(tx) || !freshAddress(token) || !freshAddress(wallet) || [wallet, bot, WBNB, quote, zero].includes(token)
      || tx.from !== wallet || !entry.wallets.includes(wallet) || sold <= 0n || freshInteger(tx.value) !== 0n || tx.chainId !== '0x38'
      || !['0x0', '0x1', '0x2'].includes(String(tx.type)) || tx.authorizationList !== undefined || receipt.status !== '0x1'
      || receipt.from !== wallet || receipt.to !== bot || !freshHash(block.hash) || tx.blockHash !== block.hash
      || freshInteger(tx.blockNumber) !== BigInt(block.number) || !Number.isSafeInteger(seconds)
      || receipt.logs.length > 64 || receipt.logs.some(log => [beforeExecutionTopic, userOperationTopic].includes(log.topics[0]))) return null;
    validateFreshReceipt(receipt, tx, { number: tx.blockNumber, hash: block.hash, parentHash: block.hash, timestamp: '0x' + seconds.toString(16), transactions: [tx] });

    const v2 = freshPoolQuotePair(token, quote), v3 = freshHistoricalV3Pool(quote, WBNB, 2500);
    const payload = '0x' + String(tx.input).slice(10);
    const args = abi.decode(executeTypes, payload);
    const input = args[1] as string[];
    if (abi.encode(executeTypes, args) !== payload || input.length !== 3 || args[2] < BigInt(seconds)) return null;
    const path = quote.slice(2) + '0009c4' + WBNB.slice(2) + v3.slice(2) + '00';
    const v2Call = '0x' + [2n, sold, 0n, 160n, 1n, 3n, token, quote, v2].map(word).join('');
    const v3Call = '0x' + [2n, 1n << 255n, 0n, 160n, 0n, 63n].map(word).join('') + path;
    const unwrapCall = abi.encode(['uint256', 'address[]', 'uint256[]'], [0n, [feeReferral], [180n]]);
    if (input[0] !== v2Call || input[1] !== v3Call || input[2] !== unwrapCall) return null;

    const logs = receipt.logs;
    const walletTransfers = logs.filter(log => log.topics[0] === transferTopic
      && log.topics.slice(1).some(topic => topic.endsWith(wallet.slice(2))));
    const [tax, delivery] = walletTransfers;
    const taxed = sold / 100n, traded = sold - taxed;
    if (walletTransfers.length !== 2 || taxed <= 0n
      || !matches(tax, token, transferTopic, [wallet, token]) || tax.data !== '0x' + word(taxed)
      || !matches(delivery, token, transferTopic, [wallet, v2]) || delivery.data !== '0x' + word(traded)) return null;

    const incomingQuote = logs.filter(log => matches(log, quote, transferTopic, [v2, bot]));
    const paidQuote = logs.filter(log => matches(log, quote, transferTopic, [bot, v3]));
    const wrapped = logs.filter(log => matches(log, WBNB, transferTopic, [v3, bot]));
    const withdrawal = logs.filter(log => log.address === WBNB && log.topics[0] === withdrawTopic);
    const settlement = logs.filter(log => log.address === bot && log.topics[0] === settlementTopic);
    if (incomingQuote.length !== 1 || paidQuote.length !== 1 || wrapped.length !== 1 || withdrawal.length !== 1 || settlement.length !== 1
      || !matches(withdrawal[0], WBNB, withdrawTopic, [bot]) || !matches(settlement[0], bot, settlementTopic, []) || settlement[0] !== logs.at(-1)
      || !words(incomingQuote[0].data, 1) || !words(wrapped[0].data, 1)
      || incomingQuote[0].data !== paidQuote[0].data || wrapped[0].data !== withdrawal[0].data) return null;
    const middle = BigInt(incomingQuote[0].data), gross = BigInt(wrapped[0].data);
    const fee = gross / 100n, net = gross - fee;
    if (middle <= 0n || fee <= 0n || settlement[0].data !== '0x' + word(sold) + word(net)) return null;

    const v2Amounts = token < quote ? [traded, 0n, 0n, middle] : [0n, traded, middle, 0n];
    const v2Swaps = logs.filter(log => matches(log, v2, v2SwapTopic, [bot, bot]) && log.data === '0x' + v2Amounts.map(word).join(''));
    const v3Swaps = logs.filter(log => log.address === v3 && log.topics[0] === v3MarketAbi.getEvent('Swap')!.topicHash);
    if (v2Swaps.length !== 1 || v3Swaps.length !== 1) return null;
    const swap = v3MarketAbi.parseLog(v3Swaps[0]);
    if (!swap || swap.name !== 'Swap' || String(swap.args.sender).toLowerCase() !== bot || String(swap.args.recipient).toLowerCase() !== bot
      || swap.args.amount0 !== middle || swap.args.amount1 !== -gross || swap.args.sqrtPriceX96 <= 0n || swap.args.liquidity <= 0n) return null;
    const encoded = v3MarketAbi.encodeEventLog(swap.fragment, swap.args);
    if (encoded.data !== v3Swaps[0].data || JSON.stringify(encoded.topics) !== JSON.stringify(v3Swaps[0].topics)) return null;
    const ordered = [tax, delivery, incomingQuote[0], v2Swaps[0], wrapped[0], paidQuote[0], v3Swaps[0], withdrawal[0], settlement[0]];
    if (ordered.some((log, i) => i > 0 && freshInteger(ordered[i - 1].logIndex) >= freshInteger(log.logIndex))) return null;

    if (entry.trace) {
      const trace = validateFreshTrace(entry.trace);
      if (!freshTraceMatchesTransaction(trace, tx) || trace.input !== tx.input || freshNativeDelta(trace, wallet) !== net) return null;
      const cash: { from: string; to: string; amount: bigint; input?: string }[] = [];
      const visit = (call: typeof trace) => {
        if (call.error) return;
        if (call.type === 'CALL' && call.to && call.from !== call.to && call.value && freshInteger(call.value) > 0n) {
          cash.push({ from: call.from, to: call.to, amount: freshInteger(call.value), input: call.input });
        }
        call.calls?.forEach(visit);
      };
      visit(trace);
      if (cash.length !== 3 || !cash.some(c => c.from === WBNB && c.to === bot && c.amount === gross && c.input === '0x')
        || !cash.some(c => c.from === bot && c.to === routeFeeRecipient && c.amount === fee && c.input?.startsWith('0x98b1e06a'))
        || !cash.some(c => c.from === bot && c.to === wallet && c.amount === net && c.input === '0x')) return null;
    }
    return { grossWithdrawnWei: String(gross), walletReceivedWei: String(net), routeExpenseWei: String(fee) };
  } catch { return null; }
}
