import { Interface, ZeroAddress, id } from 'ethers';
import { WBNB } from '../launchpad.js';
import { poolMarketAbi } from '../nodeMarketProtocols.js';
import { transferTopic } from '../swap.js';
import { freshAddress, freshHash, freshInteger, type FreshLog, type FreshTransaction } from './capture.js';
import { freshPoolQuotePair } from './currentPoolQuote.js';

const router = '0x10ed43c718714eb63d5aa57b78b54704e256024e';
const swapMethod = 'swapExactTokensForTokensSupportingFeeOnTransferTokens';
const routerAbi = new Interface([
  'function swapExactTokensForTokensSupportingFeeOnTransferTokens(uint256 amountIn,uint256 amountOutMin,address[] path,address to,uint256 deadline)',
]);
const swapTopic = poolMarketAbi.getEvent('Swap')!.topicHash;
const wrappedNativeEvents = new Set([id('Deposit(address,uint256)'), id('Withdrawal(address,uint256)')]);
const topicAddress = (value: string | undefined) => value && /^0x0{24}[\da-f]{40}$/.test(value) ? '0x' + value.slice(-40) : null;

/** Authenticate the one-hop, nonpayable Pancake V2 route against an already
 * verified Flap launch pair. The router pulls input from the signer and sends
 * the pair output straight to the signed recipient, including wrapped BNB.
 * https://github.com/pancakeswap/pancake-swap-periphery/blob/master/contracts/PancakeRouter.sol
 */
export function freshFlapPoolV2Settlement(tx: FreshTransaction, wallet: string, token: string, targetRaw: bigint, logs: FreshLog[],
  identity: { poolAddress: string; quoteAddress: string }): bigint | null {
  try {
    const pair = freshAddress(identity.poolAddress), quote = freshAddress(identity.quoteAddress);
    if (!pair || !quote || !freshAddress(token) || !freshAddress(wallet) || [token, quote, wallet].includes(ZeroAddress)
      || new Set([token, quote, pair, wallet, router]).size !== 5 || freshPoolQuotePair(token, quote) !== pair
      || tx.from !== wallet || tx.to !== router || !['0x0', '0x1', '0x2'].includes(String(tx.type ?? '0x0'))
      || tx.authorizationList !== undefined || tx.chainId !== undefined && freshInteger(tx.chainId) !== 56n
      || freshInteger(tx.value) !== 0n || !freshHash(tx.hash) || !freshHash(tx.blockHash)
      || targetRaw === 0n || logs.length > 512 || typeof tx.input !== 'string' || !/^0x[\da-f]{520}$/i.test(tx.input)) return null;

    const call = routerAbi.parseTransaction({ data: tx.input });
    const buying = targetRaw > 0n, input = buying ? quote : token, output = buying ? token : quote;
    if (!call || call.name !== swapMethod || routerAbi.encodeFunctionData(swapMethod, call.args) !== tx.input.toLowerCase()
      || call.args.path.length !== 2 || freshAddress(call.args.path[0]) !== input || freshAddress(call.args.path[1]) !== output
      || freshAddress(call.args.to) !== wallet) return null;

    const swaps = logs.filter(log => log.address === pair && log.topics[0] === swapTopic);
    if (swaps.length !== 1) return null;
    const [swap] = swaps, event = poolMarketAbi.decodeEventLog('Swap', swap.data, swap.topics);
    const encoded = poolMarketAbi.encodeEventLog('Swap', event);
    if (encoded.data !== swap.data || encoded.topics.length !== swap.topics.length
      || encoded.topics.some((topic, i) => topic !== swap.topics[i]) || freshAddress(event.sender) !== router || freshAddress(event.to) !== wallet) return null;
    const inputIs0 = input < output;
    const pairInput = BigInt(inputIs0 ? event.amount0In : event.amount1In);
    const pairOutput = BigInt(inputIs0 ? event.amount1Out : event.amount0Out);
    const unexpectedInput = BigInt(inputIs0 ? event.amount1In : event.amount0In);
    const unexpectedOutput = BigInt(inputIs0 ? event.amount0Out : event.amount1Out);
    if (pairInput <= 0n || pairOutput <= 0n || unexpectedInput !== 0n || unexpectedOutput !== 0n) return null;

    let previous = -1n, walletInput = 0n, walletOutput = 0n, receivedByPair = 0n, sentByPair = 0n;
    const swapIndex = freshInteger(swap.logIndex);
    for (const log of logs) {
      const index = freshInteger(log.logIndex);
      if (log.removed || log.transactionHash !== tx.hash || log.blockHash !== tx.blockHash || log.transactionIndex !== tx.transactionIndex
        || log.blockNumber !== tx.blockNumber || index <= previous) return null;
      previous = index;
      const topic = log.topics[0];
      if (log.address === WBNB && wrappedNativeEvents.has(topic)) return null;
      if (topic !== transferTopic) continue;
      const from = topicAddress(log.topics[1]), to = topicAddress(log.topics[2]);
      if (!from || !to || log.topics.length !== 3 || !/^0x[\da-f]{64}$/.test(log.data)) return null;
      const amount = BigInt(log.data), asset = log.address;
      if (!amount || ![from, to].some(address => address === wallet || address === pair)) continue;
      if (index >= swapIndex) return null;
      // Flap's transfer tax goes to the traded token contract. Count it as
      // part of the wallet debit or pair gross delivery, as appropriate.
      const tax = asset === token && to === token;
      if (asset === input && from === wallet && (to === pair || tax)) {
        walletInput += amount;
        if (to === pair) receivedByPair += amount;
      } else if (asset === output && from === pair && (to === wallet || tax)) {
        sentByPair += amount;
        if (to === wallet) walletOutput += amount;
      } else return null;
    }
    if (walletInput !== call.args.amountIn || receivedByPair !== pairInput || sentByPair !== pairOutput
      || walletOutput <= 0n || walletOutput < call.args.amountOutMin || (buying ? walletOutput : -walletInput) !== targetRaw) return null;
    return buying ? walletInput : walletOutput;
  } catch {
    return null;
  }
}
