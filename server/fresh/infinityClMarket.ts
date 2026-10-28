import { AbiCoder, Interface, keccak256 } from 'ethers';
import type { Rpc } from '../rpc.js';
import { WBNB } from '../launchpad.js';
import { INFINITY_CL } from '../nodeMarketProtocols.js';
import { MarketDecimal } from '../nodeMarketMath.js';
import type { FreshLog, FreshReceipt } from './capture.js';
import type { FreshPriceBlock } from './pricing.js';

// Official interfaces and parameter layout:
// github.com/pancakeswap/infinity-core/src/pool-cl/interfaces/ICLPoolManager.sol
// github.com/pancakeswap/infinity-core/src/pool-cl/libraries/CLPoolParametersHelper.sol
export const freshInfinityClInterface = new Interface([
  'event Initialize(bytes32 indexed id,address indexed currency0,address indexed currency1,address hooks,uint24 fee,bytes32 parameters,uint160 sqrtPriceX96,int24 tick)',
  'event Swap(bytes32 indexed id,address indexed sender,int128 amount0,int128 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick,uint24 fee,uint16 protocolFee)',
  'event ModifyLiquidity(bytes32 indexed id,address indexed sender,int24 tickLower,int24 tickUpper,int256 liquidityDelta,bytes32 salt)',
  'event Donate(bytes32 indexed id,address indexed sender,uint256 amount0,uint256 amount1,int24 tick)',
  'function poolIdToPoolKey(bytes32) view returns(address currency0,address currency1,address hooks,address poolManager,uint24 fee,bytes32 parameters)',
  'function getSlot0(bytes32) view returns(uint160 sqrtPriceX96,int24 tick,uint24 protocolFee,uint24 lpFee)',
  'function getLiquidity(bytes32) view returns(uint128 liquidity)',
]);
export const FRESH_INFINITY_CL_INITIALIZE_TOPIC = freshInfinityClInterface.getEvent('Initialize')!.topicHash;
export const FRESH_INFINITY_CL_SWAP_TOPIC = freshInfinityClInterface.getEvent('Swap')!.topicHash;
export const FRESH_INFINITY_CL_MAX_LOGS = 256;
const zero = '0x' + '0'.repeat(40), Q96 = 1n << 96n, Q192 = 1n << 192n;
const address = (v: unknown): v is string => typeof v === 'string' && /^0x[\da-f]{40}$/.test(v);
const hash = (v: unknown): v is string => typeof v === 'string' && /^0x[\da-f]{64}$/.test(v);
const quantity = (v: unknown): v is string => typeof v === 'string' && /^0x[\da-f]{1,16}$/.test(v) && BigInt(v) <= BigInt(Number.MAX_SAFE_INTEGER);
const index = (v: unknown): v is string => quantity(v) && BigInt(v) < 1n << 32n;
const precision = (v: number) => Number.isInteger(v) && v >= 0 && v <= 255;
const stable = (v: unknown): string => JSON.stringify(v, (_key, item: unknown) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const same = (a: unknown, b: unknown) => stable(a) === stable(b);
const validBlock = (v: FreshPriceBlock) => !!v && Number.isSafeInteger(v.number) && v.number >= 0 && hash(v.hash) && Number.isFinite(Date.parse(v.timestamp)) && new Date(v.timestamp).toISOString() === v.timestamp;
const validSqrt = (v: bigint) => v >= 4295128739n && v < 1461446703485210103287273052203988822378723970342n;
const validTick = (v: number) => Number.isInteger(v) && Math.abs(v) <= 887272;

export interface FreshInfinityClPoolKey { currency0: string; currency1: string; hooks: string; poolManager: string; fee: number; parameters: string }
export interface FreshInfinityClMarketIdentity {
  version: 1; protocol: 'infinity_cl'; manager: typeof INFINITY_CL; poolId: string; poolKey: FreshInfinityClPoolKey;
  tokenAddress: string; quoteAddress: string;
  initial: { sqrtPriceX96: string; tick: number; blockNumber: number; blockHash: string; transactionHash: string; logIndex: number };
}

/** This bounded version supports hook-free, static-fee native BNB pools only.
 * A pool's address/name or a Swap alone cannot establish its currency key. */
export function freshInfinityClPoolId(key: FreshInfinityClPoolKey) {
  if (!key || key.currency0 !== zero || !address(key.currency1) || key.currency1 === zero || !address(key.hooks) || key.hooks !== zero
    || key.poolManager !== INFINITY_CL || !Number.isInteger(key.fee) || key.fee < 0 || key.fee > 1_000_000 || !hash(key.parameters)) throw Error('infinity_cl_pool_key_unsupported');
  const parameters = BigInt(key.parameters), spacing = Number(parameters >> 16n & 0xffffffn);
  if (parameters & 65535n || parameters >> 40n || spacing < 1 || spacing > 32767) throw Error('infinity_cl_pool_key_unsupported');
  return keccak256(AbiCoder.defaultAbiCoder().encode(['address', 'address', 'address', 'address', 'uint24', 'bytes32'],
    [key.currency0, key.currency1, key.hooks, key.poolManager, key.fee, key.parameters]));
}
export function validFreshInfinityClMarketIdentity(value: unknown): value is FreshInfinityClMarketIdentity {
  try {
    const m = value as FreshInfinityClMarketIdentity, i = m?.initial;
    return !!m && m.version === 1 && m.protocol === 'infinity_cl' && m.manager === INFINITY_CL && hash(m.poolId)
      && address(m.tokenAddress) && m.tokenAddress !== WBNB && m.tokenAddress === m.poolKey.currency1 && m.quoteAddress === WBNB
      && freshInfinityClPoolId(m.poolKey) === m.poolId && !!i && /^\d{1,49}$/.test(i.sqrtPriceX96) && validSqrt(BigInt(i.sqrtPriceX96))
      && validTick(i.tick) && Number.isSafeInteger(i.blockNumber) && i.blockNumber >= 0 && hash(i.blockHash) && hash(i.transactionHash)
      && Number.isSafeInteger(i.logIndex) && i.logIndex >= 0;
  } catch { return false; }
}

export function authenticateFreshInfinityClInitialization(receipt: FreshReceipt, tokenAddress: string, expectedPoolId: string, expectedQuote = WBNB, expectedTick?: number): FreshInfinityClMarketIdentity | null {
  try {
    const token = tokenAddress.toLowerCase(), poolId = expectedPoolId.toLowerCase();
    if (!address(token) || !hash(poolId) || expectedQuote !== WBNB || receipt.status !== '0x1' || !hash(receipt.blockHash) || !hash(receipt.transactionHash)
      || !quantity(receipt.blockNumber) || !index(receipt.transactionIndex) || !Array.isArray(receipt.logs)) return null;
    const matching = receipt.logs.filter(l => l.address?.toLowerCase() === INFINITY_CL && l.topics?.[0]?.toLowerCase() === FRESH_INFINITY_CL_INITIALIZE_TOPIC && l.topics?.[1]?.toLowerCase() === poolId);
    if (matching.length !== 1) return null;
    const l = matching[0];
    if (l.removed || l.address !== INFINITY_CL || l.topics.length !== 4 || l.topics.some(t => !hash(t)) || !/^0x[\da-f]{320}$/.test(l.data)
      || l.blockHash !== receipt.blockHash || l.transactionHash !== receipt.transactionHash || l.blockNumber !== receipt.blockNumber
      || l.transactionIndex !== receipt.transactionIndex || !index(l.logIndex)) return null;
    const p = freshInfinityClInterface.parseLog(l); if (!p || p.name !== 'Initialize') return null;
    const encoded = freshInfinityClInterface.encodeEventLog(p.fragment, p.args);
    if (encoded.data !== l.data || !same(encoded.topics, l.topics) || expectedTick !== undefined && Number(p.args.tick) !== expectedTick) return null;
    const poolKey: FreshInfinityClPoolKey = { currency0: String(p.args.currency0).toLowerCase(), currency1: String(p.args.currency1).toLowerCase(), hooks: String(p.args.hooks).toLowerCase(), poolManager: INFINITY_CL, fee: Number(p.args.fee), parameters: String(p.args.parameters) };
    const m: FreshInfinityClMarketIdentity = { version: 1, protocol: 'infinity_cl', manager: INFINITY_CL, poolId, poolKey, tokenAddress: token, quoteAddress: WBNB,
      initial: { sqrtPriceX96: String(p.args.sqrtPriceX96), tick: Number(p.args.tick), blockNumber: Number(BigInt(l.blockNumber)), blockHash: l.blockHash, transactionHash: l.transactionHash, logIndex: Number(BigInt(l.logIndex)) } };
    return validFreshInfinityClMarketIdentity(m) ? m : null;
  } catch { return null; }
}

export function freshInfinityClRawQuoteRatio(identity: FreshInfinityClMarketIdentity, sqrt: bigint) {
  if (!validFreshInfinityClMarketIdentity(identity) || !validSqrt(sqrt)) throw Error('infinity_cl_market_price_invalid');
  return { numerator: String(Q192), denominator: String(sqrt * sqrt) };
}
function observation(m: FreshInfinityClMarketIdentity, sqrt: bigint, liquidity: bigint, tokenDecimals: number) {
  if (!precision(tokenDecimals) || !validSqrt(sqrt) || liquidity <= 0n || liquidity >= 1n << 128n) throw Error('infinity_cl_market_state_invalid');
  const raw = freshInfinityClRawQuoteRatio(m, sqrt), virtual = new MarketDecimal(liquidity * Q96, sqrt), price = new MarketDecimal(BigInt(raw.numerator) * 10n ** BigInt(tokenDecimals), BigInt(raw.denominator) * 10n ** 18n);
  return { rawQuoteRatio: raw, virtualQuoteLiquidityRaw: { numerator: String(virtual.n), denominator: String(virtual.d) },
    priceQuote: price.text(), priceNative: price.text(), quoteLiquidityNative: virtual.div(new MarketDecimal(10n ** 18n)).text(),
    virtualQuoteLiquidity: virtual.div(new MarketDecimal(10n ** 18n)).text(), sqrtPriceX96: String(sqrt), liquidityRaw: String(liquidity) };
}
export async function readFreshInfinityClMarket(options: { rpc: Rpc; identity: FreshInfinityClMarketIdentity; tokenDecimals: number; block: FreshPriceBlock }) {
  const { identity: m, block } = options;
  if (!validFreshInfinityClMarketIdentity(m) || !validBlock(block) || block.number < m.initial.blockNumber || !precision(options.tokenDecimals)) throw Error('infinity_cl_market_identity_invalid');
  const call = async (method: string) => {
    const data = freshInfinityClInterface.encodeFunctionData(method, [m.poolId]), raw = await options.rpc<string>('eth_call', [{ to: m.manager, data }, { blockHash: block.hash, requireCanonical: true }]);
    if (typeof raw !== 'string' || !/^0x[\da-f]+$/.test(raw) || raw.length > 2 + 192 * 2) throw Error('infinity_cl_market_state_invalid');
    const values = freshInfinityClInterface.decodeFunctionResult(method, raw);
    if (freshInfinityClInterface.encodeFunctionResult(method, [...values]) !== raw) throw Error('infinity_cl_market_state_invalid');
    return values;
  };
  const [key, slot, liquidity] = await Promise.all([call('poolIdToPoolKey'), call('getSlot0'), call('getLiquidity')]);
  const actual: FreshInfinityClPoolKey = { currency0: String(key[0]).toLowerCase(), currency1: String(key[1]).toLowerCase(), hooks: String(key[2]).toLowerCase(), poolManager: String(key[3]).toLowerCase(), fee: Number(key[4]), parameters: String(key[5]) };
  if (!same(actual, m.poolKey) || freshInfinityClPoolId(actual) !== m.poolId || !validTick(Number(slot.tick))) throw Error('infinity_cl_market_key_changed');
  return { protocol: 'infinity_cl' as const, identity: m, ...observation(m, BigInt(slot.sqrtPriceX96), BigInt(liquidity.liquidity), options.tokenDecimals),
    tick: Number(slot.tick), protocolFee: Number(slot.protocolFee), lpFee: Number(slot.lpFee), quoteAddress: WBNB, tokenIs0: false, observedBlock: { ...block } };
}

export interface FreshInfinityClHistoricalPrice {
  version: 1; kind: 'historical_infinity_cl_native'; identity: FreshInfinityClMarketIdentity; target: FreshPriceBlock; tokenDecimals: number;
  fromBlock: number; toBlock: number; events: FreshLog[]; lastSwap: FreshLog; source: FreshPriceBlock;
  rawQuoteRatio: { numerator: string; denominator: string }; virtualQuoteLiquidityRaw: { numerator: string; denominator: string };
  priceQuote: string; priceNative: string; quoteLiquidityNative: string; virtualQuoteLiquidity: string; sqrtPriceX96: string; liquidityRaw: string;
  /** Actual canonical node observations for otherwise absent event headers.
   * They expire with the original receipt; they never advance collection. */
  canonicalHeaders?: FreshInfinityClCanonicalHeader[];
}
export interface FreshInfinityClCanonicalHeader extends FreshPriceBlock { parentHash: string }
const FRESH_INFINITY_CL_MAX_HEADERS = 32, FRESH_INFINITY_CL_HEADER_BUDGET_MS = 12000;
function canonicalHeader(value: any, expected: number): FreshInfinityClCanonicalHeader {
  if (!value || typeof value !== 'object' || !quantity(value.number) || Number(BigInt(value.number)) !== expected || !hash(value.hash)
    || !hash(value.parentHash) || !quantity(value.timestamp) || !Array.isArray(value.transactions) || value.transactions.length > 10000
    || value.transactions.some((tx: unknown) => !hash(tx))) throw Error('infinity_cl_market_header_invalid');
  const header = { number: expected, hash: value.hash, parentHash: value.parentHash, timestamp: new Date(Number(BigInt(value.timestamp)) * 1000).toISOString() };
  if (!validBlock(header)) throw Error('infinity_cl_market_header_invalid'); return header;
}
function retainedHeader(value: any): value is FreshInfinityClCanonicalHeader {
  return validBlock(value) && hash(value.parentHash) && Object.keys(value).sort().join(',') === 'hash,number,parentHash,timestamp';
}
/** All manager events for this pool are queried, including liquidity removals.
 * Nonzero liquidity changes after the last Swap fail closed until another Swap
 * authenticates active liquidity. Initialize never invents a trading price. */
export async function historicalFreshInfinityClPrice(options: { rpc: Rpc; identity: FreshInfinityClMarketIdentity; tokenDecimals: number; target: FreshPriceBlock; canonicalHash: (number: number) => Promise<string | null>; prior?: FreshInfinityClHistoricalPrice }): Promise<FreshInfinityClHistoricalPrice> {
  const { identity: m, target, canonicalHash, prior } = options;
  if (!validFreshInfinityClMarketIdentity(m) || !validBlock(target) || target.number < m.initial.blockNumber || !precision(options.tokenDecimals)) throw Error('infinity_cl_market_identity_invalid');
  if (await canonicalHash(target.number) !== target.hash || await canonicalHash(m.initial.blockNumber) !== m.initial.blockHash) throw Error('infinity_cl_market_noncanonical');
  const windows = [...new Set([64, 256, 1024].map(size => Math.max(m.initial.blockNumber, target.number - size + 1)))];
  if (prior && (prior.version !== 1 || prior.kind !== 'historical_infinity_cl_native' || !same(prior.identity, m) || !same(prior.target, target) || prior.tokenDecimals !== options.tokenDecimals || prior.toBlock !== target.number || !windows.includes(prior.fromBlock) || Buffer.byteLength(stable(prior)) > 256 * 1024)) throw Error('infinity_cl_market_prior_invalid');
  const deadline = Date.now() + FRESH_INFINITY_CL_HEADER_BUDGET_MS, observed = new Map<number, FreshInfinityClCanonicalHeader>(), eventNumbers = new Set<number>();
  if (prior?.canonicalHeaders !== undefined) {
    if (!Array.isArray(prior.canonicalHeaders) || !prior.canonicalHeaders.length || prior.canonicalHeaders.length > FRESH_INFINITY_CL_MAX_HEADERS) throw Error('infinity_cl_market_header_invalid');
    for (const h of prior.canonicalHeaders) {
      if (!retainedHeader(h) || observed.has(h.number) || h.number < prior.fromBlock || h.number > target.number || Date.parse(h.timestamp) > Date.parse(target.timestamp)) throw Error('infinity_cl_market_header_invalid');
      const current = await canonicalHash(h.number); if (current !== null && current !== h.hash) throw Error('infinity_cl_market_noncanonical'); observed.set(h.number, h);
    }
    const anchor = observed.get(target.number); if (!anchor || anchor.hash !== target.hash || anchor.timestamp !== target.timestamp) throw Error('infinity_cl_market_header_invalid');
  }
  const boundedHeader = async (number: number) => {
    const remaining = deadline - Date.now(); if (remaining <= 0) throw Error('infinity_cl_market_header_deadline');
    // Rpc has no cancellation/settlement handle. Await its bounded transport
    // before releasing this task; racing a timer would orphan the request and
    // let the next receipt start another wire. Twelve seconds limits starts,
    // and a response settling later cannot approve a historical mark.
    const raw = await options.rpc<any>('eth_getBlockByNumber', ['0x' + number.toString(16), false]);
    if (Date.now() > deadline) throw Error('infinity_cl_market_header_deadline'); return canonicalHeader(raw, number);
  };
  const ensureAnchor = async () => {
    if (observed.has(target.number)) return;
    const header = await boundedHeader(target.number); if (header.hash !== target.hash || header.timestamp !== target.timestamp) throw Error('infinity_cl_market_noncanonical'); observed.set(target.number, header);
  };
  const eventHash = async (number: number) => {
    const current = await canonicalHash(number), saved = observed.get(number);
    if (current !== null) { if (saved && saved.hash !== current) throw Error('infinity_cl_market_noncanonical'); return current; }
    if (saved) return saved.hash;
    if (prior) throw Error('infinity_cl_market_header_missing');
    await ensureAnchor(); if (observed.size >= FRESH_INFINITY_CL_MAX_HEADERS) throw Error('infinity_cl_market_header_bounds');
    const header = await boundedHeader(number); if (Date.parse(header.timestamp) > Date.parse(target.timestamp)) throw Error('infinity_cl_market_header_invalid'); observed.set(number, header); return header.hash;
  };
  for (const fromBlock of prior ? [prior.fromBlock] : windows) {
    const logs = prior ? prior.events : await options.rpc<FreshLog[]>('eth_getLogs', [{ address: m.manager, fromBlock: '0x' + fromBlock.toString(16), toBlock: '0x' + target.number.toString(16), topics: [null, m.poolId] }]);
    if (!Array.isArray(logs) || logs.length > FRESH_INFINITY_CL_MAX_LOGS || Buffer.byteLength(stable(logs)) > 240 * 1024) throw Error('infinity_cl_market_work_bounds');
    let previous = -1n, lastSwap: FreshLog | undefined, sqrt = 0n, liquidity = 0n, changedAfterSwap = false;
    const headers = new Map<number, string | null>();
    for (const l of logs) {
      if (!l || l.removed || l.address !== m.manager || !Array.isArray(l.topics) || l.topics.length < 2 || l.topics[1] !== m.poolId || l.topics.some(t => !hash(t)) || !hash(l.transactionHash) || !hash(l.blockHash)
        || !quantity(l.blockNumber) || !index(l.transactionIndex) || !index(l.logIndex) || typeof l.data !== 'string' || !/^0x(?:[\da-f]{2})*$/.test(l.data)) throw Error('infinity_cl_market_log_invalid');
      const number = Number(BigInt(l.blockNumber)), position = BigInt(number) * (1n << 64n) + BigInt(l.transactionIndex) * (1n << 32n) + BigInt(l.logIndex);
      if (number < fromBlock || number > target.number || position <= previous || number === m.initial.blockNumber && Number(BigInt(l.logIndex)) < m.initial.logIndex) throw Error('infinity_cl_market_log_order_invalid');
      previous = position;
      eventNumbers.add(number); if (!headers.has(number)) headers.set(number, await eventHash(number));
      if (headers.get(number) !== l.blockHash) throw Error('infinity_cl_market_noncanonical');
      const parsed = freshInfinityClInterface.parseLog(l); if (!parsed) throw Error('infinity_cl_market_event_unsupported');
      const encoded = freshInfinityClInterface.encodeEventLog(parsed.fragment, parsed.args);
      if (encoded.data !== l.data || !same(encoded.topics, l.topics)) throw Error('infinity_cl_market_log_invalid');
      if (parsed.name === 'Initialize') {
        const receipt = { status: '0x1', blockNumber: l.blockNumber, blockHash: l.blockHash, transactionHash: l.transactionHash, transactionIndex: l.transactionIndex, logs: [l], gasUsed: '0x0' };
        const authenticated = authenticateFreshInfinityClInitialization(receipt, m.tokenAddress, m.poolId);
        if (!authenticated || !same(authenticated.initial, m.initial) || !same(authenticated.poolKey, m.poolKey)) throw Error('infinity_cl_market_initial_changed');
      } else if (parsed.name === 'Swap') {
        const a = BigInt(parsed.args.amount0), b = BigInt(parsed.args.amount1);
        if (!a || !b || (a > 0n) === (b > 0n) || !validTick(Number(parsed.args.tick))) throw Error('infinity_cl_market_swap_invalid');
        sqrt = BigInt(parsed.args.sqrtPriceX96); liquidity = BigInt(parsed.args.liquidity);
        if (!validSqrt(sqrt) || liquidity < 0n || liquidity >= 1n << 128n) throw Error('infinity_cl_market_swap_invalid');
        lastSwap = l; changedAfterSwap = false;
      } else if (parsed.name === 'ModifyLiquidity') {
        const lower = Number(parsed.args.tickLower), upper = Number(parsed.args.tickUpper);
        if (!validTick(lower) || !validTick(upper) || lower >= upper) throw Error('infinity_cl_market_liquidity_invalid');
        if (lastSwap && BigInt(parsed.args.liquidityDelta) !== 0n) changedAfterSwap = true;
      } else if (parsed.name === 'Donate') {
        if (!validTick(Number(parsed.args.tick))) throw Error('infinity_cl_market_log_invalid');
      } else throw Error('infinity_cl_market_event_unsupported');
    }
    if (!lastSwap) { if (prior) throw Error('infinity_cl_market_prior_invalid'); continue; }
    if (changedAfterSwap) throw Error('infinity_cl_market_liquidity_changed');
    const savedSource = observed.get(Number(BigInt(lastSwap.blockNumber))), raw = prior || savedSource ? null : await options.rpc<any>('eth_getBlockByNumber', [lastSwap.blockNumber, false]);
    const source = prior?.source ?? (savedSource ? { number: savedSource.number, hash: savedSource.hash, timestamp: savedSource.timestamp } : { number: Number(BigInt(raw?.number)), hash: raw?.hash, timestamp: new Date(Number(BigInt(raw?.timestamp)) * 1000).toISOString() });
    const age = Date.parse(target.timestamp) - Date.parse(source.timestamp);
    if (!validBlock(source) || source.number !== Number(BigInt(lastSwap.blockNumber)) || source.hash !== lastSwap.blockHash || age < 0 || age > 120000 || await eventHash(source.number) !== source.hash) throw Error('infinity_cl_market_source_invalid');
    const retained = [...observed.values()].sort((a, b) => a.number - b.number);
    if (retained.length) {
      for (let i = 0; i < retained.length; i++) {
        const h = retained[i], previous = retained[i - 1]; if (h.number !== target.number && !eventNumbers.has(h.number) || previous && (Date.parse(previous.timestamp) > Date.parse(h.timestamp) || previous.number + 1 === h.number && h.parentHash !== previous.hash)) throw Error('infinity_cl_market_header_invalid');
      }
      if (!prior) { const after = await boundedHeader(target.number); if (!same(after, observed.get(target.number))) throw Error('infinity_cl_market_noncanonical'); }
      if (await canonicalHash(target.number) !== target.hash || await canonicalHash(m.initial.blockNumber) !== m.initial.blockHash) throw Error('infinity_cl_market_noncanonical');
    }
    const proof: FreshInfinityClHistoricalPrice = { version: 1, kind: 'historical_infinity_cl_native', identity: structuredClone(m), target: { ...target }, tokenDecimals: options.tokenDecimals,
      fromBlock, toBlock: target.number, events: structuredClone(logs), lastSwap: structuredClone(lastSwap), source: { ...source }, ...observation(m, sqrt, liquidity, options.tokenDecimals), ...(retained.length ? { canonicalHeaders: retained } : {}) };
    if (Buffer.byteLength(stable(proof)) > 256 * 1024 || prior && !same(prior, proof)) throw Error('infinity_cl_market_prior_invalid');
    return proof;
  }
  throw Error('infinity_cl_market_price_window_empty');
}
