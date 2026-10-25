import { AbiCoder, Interface, keccak256, toBeHex } from 'ethers';
import type { Rpc } from '../rpc.js';
import { WBNB } from '../launchpad.js';
import { MarketDecimal, sqrtPrice } from '../nodeMarketMath.js';
import type { FreshLog, FreshReceipt } from './capture.js';
import type { FreshPriceBlock } from './pricing.js';

// Official Uniswap v4 BNB Chain deployment, not Pancake Infinity:
// https://developers.uniswap.org/docs/protocols/v4/deployments
export const FRESH_UNISWAP_V4_BSC_MANAGER = '0x28e2ea090877bf75740558f6bfb36a5ffee9e9df';
export const FRESH_UNISWAP_V4_BSC_STATE_VIEW = '0xd13dd3d6e93f276fafc9db9e6bb47c1180aee0c4';
export const stockwavePoolManagerInterface = new Interface([
  'event Initialize(bytes32 indexed id,address indexed currency0,address indexed currency1,uint24 fee,int24 tickSpacing,address hooks,uint160 sqrtPriceX96,int24 tick)',
  'event Swap(bytes32 indexed id,address indexed sender,int128 amount0,int128 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick,uint24 fee)',
  'function extsload(bytes32[] slots) view returns(bytes32[])',
]);
export const FRESH_UNISWAP_V4_INITIALIZE_TOPIC = stockwavePoolManagerInterface.getEvent('Initialize')!.topicHash;
export const FRESH_UNISWAP_V4_SWAP_TOPIC = stockwavePoolManagerInterface.getEvent('Swap')!.topicHash;
const abi = AbiCoder.defaultAbiCoder(), zero = `0x${'0'.repeat(40)}`, Q96 = 1n << 96n;
const address = (v: unknown): v is string => typeof v === 'string' && /^0x[\da-f]{40}$/.test(v);
const hash = (v: unknown): v is string => typeof v === 'string' && /^0x[\da-f]{64}$/.test(v);
const quantity = (v: unknown): v is string => typeof v === 'string' && /^0x[\da-f]{1,16}$/.test(v) && BigInt(v) <= BigInt(Number.MAX_SAFE_INTEGER);
const precision = (v: number) => Number.isInteger(v) && v >= 0 && v <= 255;
const normalizedQuote = (v: string) => v === zero ? WBNB : v;

export interface FreshStockwavePoolKey { currency0: string; currency1: string; fee: number; tickSpacing: number; hooks: string }
export interface FreshStockwaveMarketIdentity {
  version: 1;
  manager: typeof FRESH_UNISWAP_V4_BSC_MANAGER;
  poolId: string;
  poolKey: FreshStockwavePoolKey;
  tokenAddress: string;
  quoteAddress: string;
  initial: { sqrtPriceX96: string; tick: number; blockNumber: number; blockHash: string; transactionHash: string; logIndex: number };
}

export function freshStockwavePoolId(key: FreshStockwavePoolKey) {
  if (!key || !address(key.currency0) || !address(key.currency1) || BigInt(key.currency0) >= BigInt(key.currency1) || !address(key.hooks)
    || !Number.isInteger(key.fee) || key.fee < 0 || key.fee > 0xffffff || !Number.isInteger(key.tickSpacing) || key.tickSpacing < 1 || key.tickSpacing > 32767) throw Error('stockwave_pool_key_invalid');
  // PoolIdLibrary.toId hashes all five padded ABI words (160 bytes).
  return keccak256(abi.encode(['address', 'address', 'uint24', 'int24', 'address'], [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks]));
}

export function validFreshStockwaveMarketIdentity(value: unknown): value is FreshStockwaveMarketIdentity {
  try {
    const m = value as FreshStockwaveMarketIdentity;
    if (!m || m.version !== 1 || m.manager !== FRESH_UNISWAP_V4_BSC_MANAGER || !hash(m.poolId) || !address(m.tokenAddress) || m.tokenAddress === zero
      || !address(m.quoteAddress) || freshStockwavePoolId(m.poolKey) !== m.poolId || ![m.poolKey.currency0, m.poolKey.currency1].includes(m.tokenAddress)) return false;
    const quote = m.poolKey.currency0 === m.tokenAddress ? m.poolKey.currency1 : m.poolKey.currency0, i = m.initial;
    return normalizedQuote(quote) === m.quoteAddress && !!i && /^\d{1,49}$/.test(i.sqrtPriceX96) && BigInt(i.sqrtPriceX96) > 0n && BigInt(i.sqrtPriceX96) < (1n << 160n)
      && Number.isInteger(i.tick) && Math.abs(i.tick) <= 887272 && Number.isSafeInteger(i.blockNumber) && i.blockNumber >= 0 && hash(i.blockHash)
      && hash(i.transactionHash) && Number.isSafeInteger(i.logIndex) && i.logIndex >= 0;
  } catch { return false; }
}

/** Called only after the complete creation transaction/receipt and factory
 * CREATE2 proof have been validated. The authenticated TokenLaunched pool ID,
 * pair and start tick must match this canonical manager Initialize exactly.
 * A pool-created event alone never authenticates token creation. */
export function authenticateFreshStockwavePoolInitialization(receipt: FreshReceipt, tokenAddress: string, expectedPoolId: string, expectedPairAddress: string, expectedStartTick: number): FreshStockwaveMarketIdentity | null {
  try {
    const token = tokenAddress.toLowerCase(), pool = expectedPoolId.toLowerCase(), pair = expectedPairAddress.toLowerCase();
    if (!address(token) || !address(pair) || token === pair || !hash(pool) || receipt.status !== '0x1' || !hash(receipt.blockHash) || !hash(receipt.transactionHash)
      || !quantity(receipt.blockNumber) || !quantity(receipt.transactionIndex) || !Array.isArray(receipt.logs)) return null;
    const matching = receipt.logs.filter(l => l.address.toLowerCase() === FRESH_UNISWAP_V4_BSC_MANAGER && l.topics[0]?.toLowerCase() === FRESH_UNISWAP_V4_INITIALIZE_TOPIC && l.topics[1]?.toLowerCase() === pool);
    if (matching.length !== 1) return null;
    const l = matching[0];
    if (l.removed || l.topics.length !== 4 || l.topics.some(t => !hash(t)) || !/^0x[\da-f]{320}$/.test(l.data)
      || l.blockHash !== receipt.blockHash || l.transactionHash !== receipt.transactionHash || l.blockNumber !== receipt.blockNumber
      || l.transactionIndex !== receipt.transactionIndex || !quantity(l.logIndex)) return null;
    const p = stockwavePoolManagerInterface.parseLog(l); if (!p || p.name !== 'Initialize') return null;
    const encoded = stockwavePoolManagerInterface.encodeEventLog(p.fragment, p.args);
    if (encoded.data !== l.data || encoded.topics.some((topic, index) => topic !== l.topics[index])) return null;
    const key: FreshStockwavePoolKey = { currency0: String(p.args.currency0).toLowerCase(), currency1: String(p.args.currency1).toLowerCase(),
      fee: Number(p.args.fee), tickSpacing: Number(p.args.tickSpacing), hooks: String(p.args.hooks).toLowerCase() };
    if (freshStockwavePoolId(key) !== pool || ![key.currency0, key.currency1].includes(token) || ![key.currency0, key.currency1].includes(pair)
      || Number(p.args.tick) !== expectedStartTick) return null;
    const market: FreshStockwaveMarketIdentity = { version: 1, manager: FRESH_UNISWAP_V4_BSC_MANAGER, poolId: pool, poolKey: key,
      tokenAddress: token, quoteAddress: normalizedQuote(pair), initial: { sqrtPriceX96: String(p.args.sqrtPriceX96), tick: Number(p.args.tick),
        blockNumber: Number(BigInt(l.blockNumber)), blockHash: l.blockHash, transactionHash: l.transactionHash, logIndex: Number(BigInt(l.logIndex)) } };
    return validFreshStockwaveMarketIdentity(market) ? market : null;
  } catch { return null; }
}

function priceFor(market: FreshStockwaveMarketIdentity, sqrt: bigint, tokenDecimals: number, quoteDecimals: number) {
  if (!precision(tokenDecimals) || !precision(quoteDecimals) || sqrt <= 0n || sqrt >= 1n << 160n) throw Error('stockwave_market_precision_invalid');
  const tokenIs0 = market.poolKey.currency0 === market.tokenAddress;
  const value = sqrtPrice(sqrt, tokenIs0, tokenIs0 ? tokenDecimals : quoteDecimals, tokenIs0 ? quoteDecimals : tokenDecimals);
  if (!value || MarketDecimal.parse(value).n <= 0n) throw Error('stockwave_market_price_invalid');
  return value;
}

export interface FreshStockwaveHistoricalPrice {
  version: 1; kind: 'historical_uniswap_v4_sqrt'; identity: FreshStockwaveMarketIdentity;
  target: FreshPriceBlock; fromBlock: number; toBlock: number; lastSwap: FreshLog | null;
  tokenDecimals: number; quoteDecimals: number | null; priceQuote: string | null; quoteAddress: string; sqrtPriceX96: string;
  tokenIs0: boolean; rawQuoteRatio: { numerator: string; denominator: string };
}

/** Raw quote units per raw token unit. Composing this rational with an
 * authenticated BNB-wei/raw-quote rational needs no assumed quote decimals. */
export function freshStockwaveRawQuoteRatio(market: FreshStockwaveMarketIdentity, sqrt: bigint) {
  if (!validFreshStockwaveMarketIdentity(market) || sqrt <= 0n || sqrt >= 1n << 160n) throw Error('stockwave_market_price_invalid');
  const tokenIs0 = market.poolKey.currency0 === market.tokenAddress;
  return { numerator: String(tokenIs0 ? sqrt * sqrt : 1n << 192n), denominator: String(tokenIs0 ? 1n << 192n : sqrt * sqrt) };
}

/** The last canonical Swap carries the complete post-swap sqrt price. One
 * bounded log query (at most 4096 blocks/8192 logs) reconstructs target block-end
 * price; Initialize is usable only if it lies inside that covered window.
 * An empty older window cannot reuse the launch price. No permanent history. */
export async function historicalFreshStockwavePrice(options: { rpc: Rpc; identity: FreshStockwaveMarketIdentity; tokenDecimals: number; quoteDecimals?: number;
  target: FreshPriceBlock; canonicalHash: (number: number) => Promise<string | null>; prior?: FreshStockwaveHistoricalPrice }): Promise<FreshStockwaveHistoricalPrice> {
  const { identity: m, target, canonicalHash } = options, quoteDecimals = options.quoteDecimals ?? null;
  if (!validFreshStockwaveMarketIdentity(m) || !Number.isSafeInteger(target.number) || target.number < m.initial.blockNumber || !hash(target.hash)
    || !Number.isFinite(Date.parse(target.timestamp)) || !precision(options.tokenDecimals) || quoteDecimals !== null && !precision(quoteDecimals)) throw Error('stockwave_market_identity_invalid');
  if (await canonicalHash(m.initial.blockNumber) !== m.initial.blockHash || await canonicalHash(target.number) !== target.hash) throw Error('stockwave_market_noncanonical');
  const fromBlock = Math.max(m.initial.blockNumber, target.number - 4095), toBlock = target.number, prior = options.prior;
  if (prior && (prior.version !== 1 || prior.kind !== 'historical_uniswap_v4_sqrt' || JSON.stringify(prior.identity) !== JSON.stringify(m)
    || JSON.stringify(prior.target) !== JSON.stringify(target) || prior.tokenDecimals !== options.tokenDecimals || prior.quoteDecimals !== quoteDecimals
    || prior.fromBlock !== fromBlock || prior.toBlock !== toBlock)) throw Error('stockwave_market_prior_invalid');
  const logs = prior ? prior.lastSwap ? [prior.lastSwap] : [] : await options.rpc<FreshLog[]>('eth_getLogs', [{ address: m.manager,
    fromBlock: `0x${fromBlock.toString(16)}`, toBlock: `0x${toBlock.toString(16)}`, topics: [FRESH_UNISWAP_V4_SWAP_TOPIC, m.poolId] }]);
  if (!Array.isArray(logs) || logs.length > 8192) throw Error('stockwave_market_work_bounds');
  let sqrt = BigInt(m.initial.sqrtPriceX96), lastSwap: FreshLog | null = null, previous: [number, number, number] | null = null;
  const headers = new Map<number, string | null>();
  for (const l of logs) {
    if (!l || l.removed || l.address !== m.manager || l.topics.length !== 3 || l.topics[0] !== FRESH_UNISWAP_V4_SWAP_TOPIC || l.topics[1] !== m.poolId
      || !hash(l.topics[2]) || !/^0x[\da-f]{384}$/.test(l.data) || !hash(l.transactionHash) || !hash(l.blockHash)
      || !quantity(l.blockNumber) || !quantity(l.transactionIndex) || !quantity(l.logIndex)) throw Error('stockwave_market_log_invalid');
    const pos = [Number(BigInt(l.blockNumber)), Number(BigInt(l.transactionIndex)), Number(BigInt(l.logIndex))] as [number, number, number];
    if (pos[0] < fromBlock || pos[0] > toBlock || pos[0] === m.initial.blockNumber && pos[2] <= m.initial.logIndex
      || previous && (pos[0] < previous[0] || pos[0] === previous[0] && (pos[1] < previous[1] || pos[1] === previous[1] && pos[2] <= previous[2]))) throw Error('stockwave_market_log_order_invalid');
    if (!headers.has(pos[0])) headers.set(pos[0], await canonicalHash(pos[0]));
    if (headers.get(pos[0]) !== l.blockHash) throw Error('stockwave_market_noncanonical');
    const p = stockwavePoolManagerInterface.parseLog(l); if (!p || p.name !== 'Swap') throw Error('stockwave_market_log_invalid');
    const encoded = stockwavePoolManagerInterface.encodeEventLog(p.fragment, p.args);
    if (encoded.data !== l.data || encoded.topics.some((topic, i) => topic !== l.topics[i])) throw Error('stockwave_market_log_invalid');
    sqrt = BigInt(p.args.sqrtPriceX96); freshStockwaveRawQuoteRatio(m, sqrt);
    if (Math.abs(Number(p.args.tick)) > 887272) throw Error('stockwave_market_log_invalid');
    lastSwap = l; previous = pos;
  }
  if (!lastSwap && m.initial.blockNumber < fromBlock) throw Error('stockwave_market_price_window_empty');
  const priceQuote = quoteDecimals === null ? null : priceFor(m, sqrt, options.tokenDecimals, quoteDecimals);
  if (prior && (prior.priceQuote !== priceQuote || prior.quoteAddress !== m.quoteAddress || prior.sqrtPriceX96 !== String(sqrt))) throw Error('stockwave_market_prior_invalid');
  return { version: 1, kind: 'historical_uniswap_v4_sqrt', identity: m, target: { ...target }, fromBlock, toBlock, lastSwap,
    tokenDecimals: options.tokenDecimals, quoteDecimals, priceQuote, quoteAddress: m.quoteAddress, sqrtPriceX96: String(sqrt),
    tokenIs0: m.poolKey.currency0 === m.tokenAddress, rawQuoteRatio: freshStockwaveRawQuoteRatio(m, sqrt) };
}

/** Official StateLibrary layout, pinned to v4-core commit
 * 46c6834698c48bc4a463a86d8420f4eb1d7f3b75/src/libraries/StateLibrary.sol:
 * pools mapping slot6; slot0 low160 sqrt, next signed24 tick, next24 protocolFee,
 * next24 lpFee; active uint128 liquidity at base+3. One EIP-1898 state read. */
export function freshStockwaveStorageSlots(poolId: string) {
  if (!hash(poolId)) throw Error('stockwave_pool_id_invalid');
  const base = keccak256(abi.encode(['bytes32', 'uint256'], [poolId, 6]));
  return [base, toBeHex((BigInt(base) + 3n) % (1n << 256n), 32)];
}

export async function readFreshStockwaveMarket(options: { rpc: Rpc; identity: FreshStockwaveMarketIdentity; tokenDecimals: number; quoteDecimals?: number; block: FreshPriceBlock }) {
  const { identity: m, block } = options, quoteDecimals = options.quoteDecimals ?? null;
  if (!validFreshStockwaveMarketIdentity(m) || !Number.isSafeInteger(block.number) || block.number < m.initial.blockNumber || !hash(block.hash)
    || !Number.isFinite(Date.parse(block.timestamp)) || !precision(options.tokenDecimals) || quoteDecimals !== null && !precision(quoteDecimals)) throw Error('stockwave_market_identity_invalid');
  const data = stockwavePoolManagerInterface.encodeFunctionData('extsload', [freshStockwaveStorageSlots(m.poolId)]);
  const raw = await options.rpc<string>('eth_call', [{ to: m.manager, data }, { blockHash: block.hash, requireCanonical: true }]);
  if (typeof raw !== 'string' || !/^0x[\da-f]+$/.test(raw) || raw.length > 2 + 192 * 2) throw Error('stockwave_market_state_invalid');
  const decoded = stockwavePoolManagerInterface.decodeFunctionResult('extsload', raw), slots = decoded[0];
  if (slots.length !== 2 || stockwavePoolManagerInterface.encodeFunctionResult('extsload', [slots]) !== raw) throw Error('stockwave_market_state_invalid');
  const slot0 = BigInt(slots[0]), liquidityWord = BigInt(slots[1]), sqrt = slot0 & ((1n << 160n) - 1n), liquidity = liquidityWord & ((1n << 128n) - 1n);
  let tick = Number(slot0 >> 160n & 0xffffffn); if (tick & 0x800000) tick -= 0x1000000;
  if (slot0 >> 232n || liquidityWord >> 128n || !liquidity || Math.abs(tick) > 887272) throw Error('stockwave_market_state_invalid');
  const priceQuote = quoteDecimals === null ? null : priceFor(m, sqrt, options.tokenDecimals, quoteDecimals), quoteIs0 = m.poolKey.currency0 !== m.tokenAddress;
  // Virtual active-range quote reserve is useful only for candidate ordering.
  // It is not actual total reserves, redeemable backing or USD TVL.
  const virtualRaw = quoteIs0 ? new MarketDecimal(liquidity * Q96, sqrt) : new MarketDecimal(liquidity * sqrt, Q96);
  const virtualQuoteLiquidity = quoteDecimals === null ? null : virtualRaw.div(new MarketDecimal(10n ** BigInt(quoteDecimals))).text();
  return { protocol: 'uniswap_v4' as const, identity: m, priceQuote, quoteAddress: m.quoteAddress, sqrtPriceX96: String(sqrt), tick,
    protocolFee: Number(slot0 >> 184n & 0xffffffn), lpFee: Number(slot0 >> 208n & 0xffffffn), liquidityRaw: String(liquidity),
    virtualQuoteLiquidity, virtualQuoteLiquidityRaw: { numerator: String(virtualRaw.n), denominator: String(virtualRaw.d) },
    tokenIs0: m.poolKey.currency0 === m.tokenAddress, rawQuoteRatio: freshStockwaveRawQuoteRatio(m, sqrt), observedBlock: { ...block } };
}
