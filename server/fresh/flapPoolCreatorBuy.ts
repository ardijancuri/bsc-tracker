import { Interface, ZeroAddress } from 'ethers';
import { poolMarketAbi } from '../nodeMarketProtocols.js';
import { transferTopic } from '../swap.js';
import { freshInteger, type FreshLog, type FreshTransaction } from './capture.js';
import { freshPoolQuotePair } from './currentPoolQuote.js';
import { FRESH_FLAP_POOL_PORTAL, type decodeFreshFlapPoolLaunch } from './flapPoolLaunch.js';

const creatorBuyAbi = new Interface([
  'function launchTaxTokenV2((string name,string symbol,string meta,uint256 totalSupply,bytes32 salt,address quoteToken,uint8 dexId,uint256 poolQuote,uint256 poolToken,uint16 buyTaxRate,uint16 sellTaxRate,uint32 taxDuration,uint32 antiFarmerDuration,(uint8 feeType,uint16 bps,bytes configData)[] feeConfigs,uint8 antiSniperMode,uint32 exemptWindow,address[] exemptAddrs,uint256 creatorBuyQuote,bytes32 extensionID,bytes extensionData,address commissionReceiver) p,(uint8 target,address strategy,uint128 amount,bytes configData) distribution,(uint256 minOutputAmount,bytes permitData) creatorBuy) payable returns (address token,address pool)',
  'event Mint(address indexed sender,uint256 amount0,uint256 amount1)',
]);
const swapTopic = poolMarketAbi.getEvent('Swap')!.topicHash;
const mintTopic = creatorBuyAbi.getEvent('Mint')!.topicHash;
const addressTopic = (address: string) => `0x${address.slice(2).padStart(64, '0')}`;
type PoolLaunch = NonNullable<ReturnType<typeof decodeFreshFlapPoolLaunch>>;

export function freshFlapPoolSwaps(launch: PoolLaunch, logs: FreshLog[]) {
  return logs.filter(log => !log.removed && log.address.toLowerCase() === launch.poolAddress && log.topics[0]?.toLowerCase() === swapTopic);
}

/** Only a direct, signed launch with a matching V2 seed and swap can use
 * creatorBuyQuote as wallet cost. Pool liquidity and vault allocations never
 * enter the purchase lot. Routed or bundled launches require separate proof. */
export function freshFlapPoolCreatorBuy(
  tx: FreshTransaction, wallet: string, launch: PoolLaunch, logs: FreshLog[], swaps: FreshLog[],
  delivery: FreshLog[], receivedRaw: bigint, quoteDelta: bigint,
) {
  if (wallet !== launch.creator || wallet !== tx.from.toLowerCase() || tx.to?.toLowerCase() !== FRESH_FLAP_POOL_PORTAL ||
      !['0x0', '0x1', '0x2'].includes(String(tx.type ?? '0x0')) || tx.authorizationList !== undefined ||
      typeof tx.input !== 'string' || swaps.length !== 1 || delivery.length !== 1 || receivedRaw <= 0n) return null;
  try {
    if (tx.chainId !== undefined && freshInteger(tx.chainId) !== 56n ||
        freshPoolQuotePair(launch.token, launch.quoteAddress) !== launch.poolAddress) return null;
    const parsed = creatorBuyAbi.parseTransaction({ data: tx.input });
    if (!parsed || creatorBuyAbi.encodeFunctionData(parsed.fragment, parsed.args).toLowerCase() !== tx.input.toLowerCase()) return null;
    const p = parsed.args.p;
    if (String(p.quoteToken).toLowerCase() !== launch.quoteToken || p.totalSupply.toString() !== launch.totalSupplyRaw ||
        p.dexId !== 0n || p.poolQuote <= 0n || p.poolToken <= 0n || p.creatorBuyQuote <= 0n) return null;
    const totalQuote = BigInt(p.poolQuote) + BigInt(p.creatorBuyQuote), value = freshInteger(tx.value), native = launch.quoteToken === ZeroAddress;
    if (native ? value !== totalQuote || quoteDelta !== 0n : value !== 0n || quoteDelta !== -totalQuote) return null;

    const seeds = logs.filter(log => !log.removed && log.address.toLowerCase() === launch.poolAddress && log.topics[0]?.toLowerCase() === mintTopic);
    const delivered = delivery[0], swapLog = swaps[0];
    if (seeds.length !== 1 || freshInteger(seeds[0].logIndex) >= freshInteger(delivered.logIndex) ||
        freshInteger(delivered.logIndex) >= freshInteger(swapLog.logIndex) || delivered.address.toLowerCase() !== launch.token ||
        delivered.topics.length !== 3 || delivered.topics[0].toLowerCase() !== transferTopic ||
        delivered.topics[1].toLowerCase() !== addressTopic(launch.poolAddress) ||
        delivered.topics[2].toLowerCase() !== addressTopic(wallet) || freshInteger(delivered.data) !== receivedRaw) return null;
    const payments = logs.filter(log => !log.removed && log.address.toLowerCase() === launch.quoteAddress &&
      log.topics.length === 3 && log.topics[0].toLowerCase() === transferTopic && log.topics[2].toLowerCase() === addressTopic(launch.poolAddress));
    if (payments.length !== 2 || payments.some(log => log.topics[1].toLowerCase() !== addressTopic(FRESH_FLAP_POOL_PORTAL) &&
        (native || log.topics[1].toLowerCase() !== addressTopic(wallet))) ||
        freshInteger(payments[0].data) !== p.poolQuote || freshInteger(payments[1].data) !== p.creatorBuyQuote ||
        freshInteger(payments[0].logIndex) >= freshInteger(seeds[0].logIndex) ||
        freshInteger(payments[1].logIndex) <= freshInteger(seeds[0].logIndex) ||
        freshInteger(payments[1].logIndex) >= freshInteger(swapLog.logIndex)) return null;
    const seed = creatorBuyAbi.decodeEventLog('Mint', seeds[0].data, seeds[0].topics);
    const swap = poolMarketAbi.decodeEventLog('Swap', swapLog.data, swapLog.topics);
    const tokenIs0 = launch.token < launch.quoteAddress;
    const [tokenIn, tokenOut, quoteIn, quoteOut] = tokenIs0
      ? [swap.amount0In, swap.amount0Out, swap.amount1In, swap.amount1Out]
      : [swap.amount1In, swap.amount1Out, swap.amount0In, swap.amount0Out];
    if (String(seed.sender).toLowerCase() !== FRESH_FLAP_POOL_PORTAL || String(swap.sender).toLowerCase() !== FRESH_FLAP_POOL_PORTAL ||
        (tokenIs0 ? seed.amount0 : seed.amount1) !== p.poolToken || (tokenIs0 ? seed.amount1 : seed.amount0) !== p.poolQuote ||
        String(swap.to).toLowerCase() !== wallet || tokenIn !== 0n || quoteOut !== 0n || quoteIn !== p.creatorBuyQuote ||
        tokenOut < receivedRaw || parsed.args.creatorBuy.minOutputAmount > receivedRaw) return null;
    return { quoteRaw: BigInt(p.creatorBuyQuote), native, logIndex: Number(freshInteger(delivered.logIndex)) };
  } catch {
    return null;
  }
}
