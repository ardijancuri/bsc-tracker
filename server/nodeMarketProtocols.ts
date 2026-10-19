import { AbiCoder, Interface, ZeroAddress, keccak256 } from 'ethers';
import { FLAP_PORTAL, FOUR_MANAGERS, PCS_V2_FACTORY, PCS_V3_FACTORY, WBNB } from './launchpad.js';
import type { NodeMarketProtocol } from '../shared/nodeMarket.js';
import { abs, MarketDecimal, ratioPrice, sqrtPrice } from './nodeMarketMath.js';

// Authenticated deployed contracts, not symbols. Official protocol interfaces:
// github.com/four-meme-community/fourmeme-docs/abi/TokenManager2.lite.json
// docs.flap.sh/dev/trade-tokens
// github.com/pancakeswap/infinity-core/src/{pool-cl,pool-bin}/interfaces
export const INFINITY_CL = '0xa0ffb9c1ce1fe56963b0321b32e7a0302114058b';
export const INFINITY_BIN = '0xc697d2898e0d09264376196696c51d7abbbaa4a9';
export const TRUSTED_QUOTE_FEEDS: Record<string, { feed: string; description:string; maxAgeSeconds: number }> = {
  [WBNB]: { feed: '0x0567f2323251f0aab15c8dfb1967e4e8a7d42aee',description:'BNB / USD', maxAgeSeconds: 3600 },
  '0x55d398326f99059ff775485246999027b3197955': { feed: '0xb97ad0e74fa7d920791e90258a6e2085088b4320',description:'USDT / USD', maxAgeSeconds: 86400 },
  '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d': { feed: '0x51597f405303c4377e36123cbc172b13269ea163',description:'USDC / USD', maxAgeSeconds: 86400 },
};
export const erc20MarketAbi = new Interface(['function decimals() view returns(uint8)', 'function totalSupply() view returns(uint256)','function balanceOf(address) view returns(uint256)']);
export const oracleMarketAbi = new Interface(['function decimals() view returns(uint8)','function description() view returns(string)',
  'function latestRoundData() view returns(uint80 roundId,int256 answer,uint256 startedAt,uint256 updatedAt,uint80 answeredInRound)']);
export const poolMarketAbi = new Interface([
  'function token0() view returns(address)', 'function token1() view returns(address)',
  'function factory() view returns(address)', 'function fee() view returns(uint24)',
  'function getPair(address,address) view returns(address)', 'function getPool(address,address,uint24) view returns(address)',
  'function getReserves() view returns(uint112 reserve0,uint112 reserve1,uint32 blockTimestampLast)',
  'function slot0() view returns(uint160 sqrtPriceX96,int24 tick,uint16 observationIndex,uint16 observationCardinality,uint16 observationCardinalityNext,uint32 feeProtocol,bool unlocked)',
  'function liquidity() view returns(uint128)',
  'event Swap(address indexed sender,uint256 amount0In,uint256 amount1In,uint256 amount0Out,uint256 amount1Out,address indexed to)',
  'event Sync(uint112 reserve0,uint112 reserve1)',
]);
// Pancake's authentic V3 event includes protocol-fee fields; the shorter
// Uniswap signature has a different topic and silently misses real PCS swaps.
// github.com/pancakeswap/pancake-v3-contracts/.../IPancakeV3PoolEvents.sol
export const v3MarketAbi = new Interface(['event Swap(address indexed sender,address indexed recipient,int256 amount0,int256 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick,uint128 protocolFeesToken0,uint128 protocolFeesToken1)']);
export const nodeMarketDecoderVersion=2;
export const fourMarketAbi = new Interface([
  'event TokenPurchase(address token,address account,uint256 price,uint256 amount,uint256 cost,uint256 fee,uint256 offers,uint256 funds)',
  'event TokenSale(address token,address account,uint256 price,uint256 amount,uint256 cost,uint256 fee,uint256 offers,uint256 funds)',
]);
export const flapMarketAbi = new Interface([
  'event TokenBought(uint256 ts,address token,address buyer,uint256 amount,uint256 eth,uint256 fee,uint256 postPrice)',
  'event TokenSold(uint256 ts,address token,address seller,uint256 amount,uint256 eth,uint256 fee,uint256 postPrice)',
]);
export const infinityMarketAbi = new Interface([
  'function poolIdToPoolKey(bytes32) view returns(address currency0,address currency1,address hooks,address poolManager,uint24 fee,bytes32 parameters)',
  'function getSlot0(bytes32) view returns(uint160 sqrtPriceX96,int24 tick,uint24 protocolFee,uint24 lpFee)',
  'event Swap(bytes32 indexed id,address indexed sender,int128 amount0,int128 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick,uint24 fee,uint16 protocolFee)',
]);
export const infinityBinMarketAbi = new Interface([
  'function getSlot0(bytes32) view returns(uint24 activeId,uint24 protocolFee,uint24 lpFee)',
  'event Swap(bytes32 indexed id,address indexed sender,int128 amount0,int128 amount1,uint24 activeId,uint24 fee,uint16 protocolFee)',
]);
export const protocolMarketTopics = [...new Set([poolMarketAbi, v3MarketAbi, fourMarketAbi, flapMarketAbi, infinityMarketAbi, infinityBinMarketAbi]
  .flatMap(abi => abi.fragments.filter(f => f.type === 'event').map(f => abi.getEvent(f.format('sighash'))!.topicHash)))];

export interface NodeMarketIdentity {
  id: string; token: string; quote: string; protocol: NodeMarketProtocol; contract: string;
  poolId: string | null; token0: string; token1: string; decimals0: number; decimals1: number;
  authentication: Record<string, unknown>;
}
export interface NodeMarketLog {
  address: string; topics: string[]; data: string; blockNumber: string; blockHash: string;
  transactionHash: string; transactionIndex: string; logIndex: string; removed?: boolean;
}
/** Controller events share an address across hundreds of tokens. Inspect ABI
 * address words once, including unknown event versions, before any ABI decode.
 * The normal decoder still authenticates and validates each matched event. */
export function indexNodeControllerLogs<T extends Pick<NodeMarketLog,'data'|'topics'>>(tokens:Iterable<string>,logs:readonly T[]){
  const tracked=new Set([...tokens].map(token=>token.toLowerCase())),indexed=new Map<string,T[]>();
  for(const log of logs){const matched=new Set<string>();
    const inspect=(word:string)=>{if(!/^0{24}[0-9a-f]{40}$/.test(word))return;const token=`0x${word.slice(24)}`;if(tracked.has(token))matched.add(token);};
    const data=log.data.toLowerCase();
    for(let offset=2;offset+64<=data.length;offset+=64)inspect(data.slice(offset,offset+64));
    for(const topic of log.topics.slice(1))inspect(topic.toLowerCase().replace(/^0x/,''));
    for(const token of matched){const rows=indexed.get(token)??[];rows.push(log);indexed.set(token,rows);}
  }
  return indexed;
}
export interface DecodedMarketObservation {
  priceQuote: string; tokenAmountRaw: string; quoteAmountRaw: string; swap: boolean;
}
export const normalizedCurrency = (address: string) => address.toLowerCase() === ZeroAddress ? WBNB : address.toLowerCase();
export function authenticatedPoolKey(poolId: string, contract: string, key: readonly unknown[]) {
  if (![INFINITY_CL, INFINITY_BIN].includes(contract.toLowerCase()) || key.length !== 6 || String(key[3]).toLowerCase() !== contract.toLowerCase()) return false;
  const encoded = AbiCoder.defaultAbiCoder().encode(['address','address','address','address','uint24','bytes32'], [...key]);
  return keccak256(encoded).toLowerCase() === poolId.toLowerCase();
}
/** Infinity's price is a raw currency1/currency0 ratio. Bounded 128-bit fixed
 * point arithmetic avoids allocating exponential-size rational denominators. */
export function binPrice(activeId: number, parameters: string, tokenIs0: boolean, decimals0: number, decimals1: number) {
  const binStep = Number(BigInt(parameters) >> 16n & 65535n), scale = 1n << 128n;
  if (!binStep || !Number.isInteger(activeId) || activeId < 0 || activeId > 16_777_215) return null;
  let exponent = activeId - 8_388_608, base = scale + BigInt(binStep) * scale / 10_000n, power = scale;
  const negative = exponent < 0; exponent = Math.abs(exponent);
  while (exponent) {
    if (exponent & 1) power = power * base / scale;
    exponent = Math.floor(exponent / 2);
    if (exponent) base = base * base / scale;
    if (base > (1n << 512n) || power > (1n << 512n) || !power) return null;
  }
  if (negative) power = scale * scale / power;
  if (!power) return null;
  const raw = new MarketDecimal(power * 10n ** BigInt(decimals0), scale * 10n ** BigInt(decimals1));
  return (tokenIs0 ? raw : new MarketDecimal(1n).div(raw)).text();
}

/** Requires an independently authenticated registry identity. Arbitrary pool-
 * shaped logs and lookalike controller events cannot enter market history. */
export function decodeNodeMarketLog(market: NodeMarketIdentity, log: Pick<NodeMarketLog, 'address' | 'topics' | 'data' | 'removed'>): DecodedMarketObservation | null {
  if (log.removed || market.contract !== log.address.toLowerCase()) return null;
  const tokenIs0 = market.token0 === market.token, tokenDecimals = tokenIs0 ? market.decimals0 : market.decimals1;
  const quoteDecimals = tokenIs0 ? market.decimals1 : market.decimals0;
  try {
    if (market.protocol === 'pcs_v2') {
      if (market.authentication.factory !== PCS_V2_FACTORY) return null;
      const parsed = poolMarketAbi.parseLog(log);
      if (parsed?.name === 'Sync') {
        const token = BigInt(tokenIs0 ? parsed.args.reserve0 : parsed.args.reserve1), quote = BigInt(tokenIs0 ? parsed.args.reserve1 : parsed.args.reserve0);
        const priceQuote = ratioPrice(quote, token, quoteDecimals, tokenDecimals);
        return priceQuote ? { priceQuote, tokenAmountRaw: '0', quoteAmountRaw: '0', swap: false } : null;
      }
      if (parsed?.name !== 'Swap') return null;
      const tokenIn = BigInt(tokenIs0 ? parsed.args.amount0In : parsed.args.amount1In), tokenOut = BigInt(tokenIs0 ? parsed.args.amount0Out : parsed.args.amount1Out);
      const quoteIn = BigInt(tokenIs0 ? parsed.args.amount1In : parsed.args.amount0In), quoteOut = BigInt(tokenIs0 ? parsed.args.amount1Out : parsed.args.amount0Out);
      if (!(tokenIn > 0n && quoteOut > 0n && tokenOut === 0n && quoteIn === 0n || tokenOut > 0n && quoteIn > 0n && tokenIn === 0n && quoteOut === 0n)) return null;
      const token = tokenIn + tokenOut, quote = quoteIn + quoteOut, priceQuote = ratioPrice(quote, token, quoteDecimals, tokenDecimals);
      return priceQuote ? { priceQuote, tokenAmountRaw: token.toString(), quoteAmountRaw: quote.toString(), swap: true } : null;
    }
    if (market.protocol === 'pcs_v3' || market.protocol === 'infinity_cl' || market.protocol === 'infinity_bin') {
      if (market.protocol === 'pcs_v3' && market.authentication.factory !== PCS_V3_FACTORY) return null;
      if (market.protocol === 'infinity_cl' && market.contract !== INFINITY_CL || market.protocol === 'infinity_bin' && market.contract !== INFINITY_BIN) return null;
      if (market.protocol.startsWith('infinity') && (!market.poolId || !log.topics[1] || log.topics[1].toLowerCase() !== market.poolId)) return null;
      const abi = market.protocol === 'pcs_v3' ? v3MarketAbi : market.protocol === 'infinity_cl' ? infinityMarketAbi : infinityBinMarketAbi;
      const parsed = abi.parseLog(log); if (parsed?.name !== 'Swap') return null;
      const amount0 = BigInt(parsed.args.amount0), amount1 = BigInt(parsed.args.amount1);
      if (amount0 === 0n || amount1 === 0n || amount0 > 0n === amount1 > 0n) return null;
      const priceQuote = market.protocol === 'infinity_bin'
        ? binPrice(Number(parsed.args.activeId), String(market.authentication.parameters), tokenIs0, market.decimals0, market.decimals1)
        : sqrtPrice(BigInt(parsed.args.sqrtPriceX96), tokenIs0, market.decimals0, market.decimals1);
      return priceQuote ? { priceQuote, tokenAmountRaw: abs(tokenIs0 ? amount0 : amount1).toString(), quoteAmountRaw: abs(tokenIs0 ? amount1 : amount0).toString(), swap: true } : null;
    }
    const isFour = market.protocol === 'fourmeme';
    if (isFour ? !FOUR_MANAGERS.includes(market.contract) : market.contract !== FLAP_PORTAL) return null;
    const parsed = (isFour ? fourMarketAbi : flapMarketAbi).parseLog(log);
    if (!parsed || String(parsed.args.token).toLowerCase() !== market.token) return null;
    const quantity = BigInt(parsed.args.amount), quote = BigInt(isFour ? parsed.args.cost : parsed.args.eth);
    // Flap's documented TokenState price uses eighteen decimal quote units,
    // independently of the quote ERC20 precision. Quantities retain raw units.
    // Unrecognized base token precision remains unsupported evidence.
    if (tokenDecimals !== 18 || quantity <= 0n || quote <= 0n) return null;
    const price = BigInt(isFour ? parsed.args.price : parsed.args.postPrice);
    const priceQuote = MarketDecimal.raw(price,isFour?quoteDecimals:18).text();
    return price > 0n ? { priceQuote, tokenAmountRaw: quantity.toString(), quoteAmountRaw: quote.toString(), swap: true } : null;
  } catch { return null; }
}
