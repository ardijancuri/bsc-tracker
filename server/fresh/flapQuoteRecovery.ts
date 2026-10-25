import { Interface, getCreate2Address, keccak256, solidityPackedKeccak256 } from 'ethers';
import type { Rpc } from '../rpc.js';
import { FLAP_PORTAL, PCS_V2_FACTORY, WBNB, flapInterface } from '../launchpad.js';
import { MarketDecimal } from '../nodeMarketMath.js';
import type { FreshLog } from './capture.js';
import type { FreshPriceBlock, FreshTokenMetadata } from './pricing.js';
import type { FreshStateReadEvidence } from './stateEvidence.js';

// This route is deliberately closed. These are raw ERC20 balances, including
// the intermediate upgradeable BNCB stock token; its decimals/UI multiplier
// never enter the calculation.
export const FRESH_FLAP_RECOVERY_QUOTE = '0xf4d5765e448774ed9482870420da7c3c4c787777';
export const FRESH_FLAP_RECOVERY_INTERMEDIATE = '0x4902c5ebc598265ed2212b559b042de8a5eeec3f';
export const FRESH_PCS_V2_FACTORY_RUNTIME_HASH = '0x9e8d17faaee69b053be6ac65b2b2c317741d770cb5fbdd9512536d17e9e076ca';
export const FRESH_PCS_V2_PAIR_INITCODE_HASH = '0x00fb7f630766e6a796048ea87d01acd3068e8ff67d078148a3fa3f4a84f69bd5';
export const FRESH_PCS_V2_PAIR_RUNTIME_HASH = '0x60e4bcb14447615ab7c14fda2c2d70ca4191570e8841c75618e627c8f72662f8';
const hex = (n: number) => '0x' + n.toString(16), scale = 10n ** 18n, supply = 10n ** 27n;
const bep344 = 1718863500000;
const tokenAbi = new Interface(['function decimals() view returns(uint8)', 'function totalSupply() view returns(uint256)']);
const syncAbi = new Interface(['event Sync(uint112 reserve0,uint112 reserve1)', 'function getReserves() view returns(uint112 reserve0,uint112 reserve1,uint32 timestamp)']);
const syncTopic = syncAbi.getEvent('Sync')!.topicHash;
const hash = (v: unknown): v is string => typeof v === 'string' && /^0x[\da-f]{64}$/.test(v);
const address = (v: unknown): v is string => typeof v === 'string' && /^0x[\da-f]{40}$/.test(v);
const quantity = (v: unknown): v is string => typeof v === 'string' && /^0x[\da-f]{1,16}$/.test(v) && BigInt(v) <= BigInt(Number.MAX_SAFE_INTEGER);
const number = (v: string) => Number(BigInt(v));
const stable = (v: unknown): string => JSON.stringify(v, (_key, value: unknown) => value && typeof value === 'object' && !Array.isArray(value)
  ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value);
const validBlock = (v: FreshPriceBlock) => !!v && Number.isSafeInteger(v.number) && v.number >= 0 && hash(v.hash)
  && typeof v.timestamp === 'string' && Number.isFinite(Date.parse(v.timestamp));
const sameBlock = (a: FreshPriceBlock, b: FreshPriceBlock) => validBlock(a) && validBlock(b)
  && a.number === b.number && a.hash === b.hash && Date.parse(a.timestamp) === Date.parse(b.timestamp);
export interface FreshFlapV2RoutePool { pool: string; token0: string; token1: string }
export const FRESH_FLAP_RECOVERY_POOLS: readonly FreshFlapV2RoutePool[] = [
  [FRESH_FLAP_RECOVERY_QUOTE, FRESH_FLAP_RECOVERY_INTERMEDIATE], [FRESH_FLAP_RECOVERY_INTERMEDIATE, WBNB],
].map(assets => {
  assets.sort(); const [token0, token1] = assets;
  return Object.freeze({pool: getCreate2Address(PCS_V2_FACTORY, solidityPackedKeccak256(['address', 'address'], assets), FRESH_PCS_V2_PAIR_INITCODE_HASH).toLowerCase(), token0, token1});
});

export interface FreshFlapQuoteRecoveryEvidence {
  version: 1;
  kind: 'historical_flap_raw_v2_route';
  tokenAddress: string;
  target: FreshPriceBlock;
  source: FreshStateReadEvidence;
  curve: { priceScaled18: string; derivativeNumerator: string; derivativeDenominator: string;
    reserveModelScale: {factor: string; normalizedReserve: string; rawReserve: string} };
  code: { chainId: 56; block: FreshPriceBlock; factory: typeof PCS_V2_FACTORY; factoryRuntimeHash: typeof FRESH_PCS_V2_FACTORY_RUNTIME_HASH;
    pairInitcodeHash: typeof FRESH_PCS_V2_PAIR_INITCODE_HASH; pairRuntimeHash: typeof FRESH_PCS_V2_PAIR_RUNTIME_HASH };
  pools: (FreshFlapV2RoutePool & {fromBlock: number; toBlock: number; lastSync: FreshLog})[];
  rawNativeRatio: {numerator: string; denominator: string};
  priceNative: string;
}

/** Immutable factory template: creation bytes at 0xe0c/0x3c4c hash to the
 * official initcode hash. Its constructor returns the fixed 0x3a85-byte runtime
 * at 0x175; factory createPair initializes the sorted assets immediately. The
 * exact pair runtime has no DELEGATECALL/CALLCODE/SELFDESTRUCT/CREATE/CREATE2.
 * Therefore its deterministic address and an earlier canonical Sync identify
 * the historical pair without using a current getPair/token0/reserves answer.
 * https://developer.pancakeswap.finance/contracts/v2/addresses
 * https://github.com/pancakeswap/pancake-swap-core/blob/3b214306770e86bc3a64e67c2b5bdb566b4e94a7/contracts/PancakeFactory.sol
 */
function validateFactoryCode(code: unknown) {
  if (typeof code !== 'string' || !/^0x[\da-f]{38168}$/.test(code) || keccak256(code) !== FRESH_PCS_V2_FACTORY_RUNTIME_HASH) throw Error('flap_quote_factory_code_invalid');
  const initcode = '0x' + code.slice(2 + 0xe0c * 2, 2 + (0xe0c + 0x3c4c) * 2);
  if (keccak256(initcode) !== FRESH_PCS_V2_PAIR_INITCODE_HASH
    || keccak256('0x' + initcode.slice(2 + 0x175 * 2, 2 + (0x175 + 0x3a85) * 2)) !== FRESH_PCS_V2_PAIR_RUNTIME_HASH) throw Error('flap_quote_factory_code_invalid');
}

function readCurve(token: string, metadata: FreshTokenMetadata, source: FreshStateReadEvidence, target: FreshPriceBlock) {
  if (!address(token) || metadata.address !== token || !sameBlock(metadata.block, target) || metadata.decimals !== 18 || metadata.supplyRaw !== supply.toString()
    || !source || source.version !== 1 || source.blockNumber !== target.number || source.blockHash !== target.hash || !Array.isArray(source.calls)
    || source.calls.length > 128 || Buffer.byteLength(stable(source)) > 128 * 1024) throw Error('flap_quote_source_invalid');
  const calls = new Map<string, string>();
  for (const c of source.calls) {
    if (!c || !address(c.to) || !/^0x(?:[\da-f]{2})*$/.test(c.data) || c.data.length > 8194 || !/^0x(?:[\da-f]{2})*$/.test(c.result)
      || c.result.length > 32770 || calls.has(c.to + ':' + c.data)) throw Error('flap_quote_source_invalid');
    calls.set(c.to + ':' + c.data, c.result);
  }
  const read = (to: string, abi: Interface, method: string, args: unknown[] = []) => {
    try {
      const raw = calls.get(to + ':' + abi.encodeFunctionData(method, args)); if (raw === undefined) throw Error();
      const parsed = abi.decodeFunctionResult(method, raw);
      if (abi.encodeFunctionResult(method, [...parsed]) !== raw) throw Error();
      return parsed;
    } catch { throw Error('flap_quote_source_invalid'); }
  };
  if (BigInt(read(token, tokenAbi, 'decimals')[0]) !== 18n || BigInt(read(token, tokenAbi, 'totalSupply')[0]) !== supply) throw Error('flap_quote_source_invalid');
  const state = read(FLAP_PORTAL, flapInterface, 'getTokenV8Safe', [token])[0];
  if (BigInt(state.status) !== 1n || BigInt(state.tokenVersion) !== 6n || String(state.quoteTokenAddress).toLowerCase() !== FRESH_FLAP_RECOVERY_QUOTE
    || BigInt(state.price) <= 0n || BigInt(state.reserve) <= 0n || BigInt(state.r) <= 0n || BigInt(state.h) <= 0n || BigInt(state.k) <= 0n
    || BigInt(state.circulatingSupply) < 0n || BigInt(state.circulatingSupply) > supply) throw Error('flap_quote_curve_unsupported');
  // Flap's V8 model returns raw reserve but normalized curve parameters and
  // price. Infer the MODEL normalization factor from the complete captured
  // invariant, rather than claiming an historical ERC20 decimals() answer.
  // Source LibCurve.price uses Wad multiplication BEFORE Wad division; its
  // intermediate floor is significant. estimateReserveV2 rounds reserve up.
  // https://docs.flap.sh/flap/developers/basic-and-mechanism/bonding-curve
  const denominator = supply - BigInt(state.circulatingSupply) + BigInt(state.h), squareWad = denominator * denominator / scale;
  if (squareWad <= 0n || BigInt(state.k) * scale / squareWad !== BigInt(state.price)) throw Error('flap_quote_curve_scale_mismatch');
  const normalizedReserve = (BigInt(state.k) * scale + denominator - 1n) / denominator - BigInt(state.r), rawReserve = BigInt(state.reserve);
  if (normalizedReserve <= 0n) throw Error('flap_quote_curve_scale_mismatch');
  const matches: bigint[] = [];
  for (let exponent = 0; exponent <= 18; exponent++) {
    const factor = 10n ** BigInt(exponent);
    if ((normalizedReserve + factor - 1n) / factor === rawReserve) matches.push(factor);
  }
  if (matches.length !== 1) throw Error('flap_quote_curve_scale_ambiguous');
  return {priceScaled18: String(state.price), derivativeNumerator: String(normalizedReserve + BigInt(state.r)), derivativeDenominator: String(denominator),
    reserveModelScale: {factor: String(matches[0]), normalizedReserve: String(normalizedReserve), rawReserve: String(rawReserve)}};
}

function syncState(logs: FreshLog[], route: FreshFlapV2RoutePool, fromBlock: number, target: FreshPriceBlock) {
  if (!Array.isArray(logs) || logs.length > 512) throw Error('flap_quote_work_bounds');
  let last: FreshLog | undefined, previous = -1n, reserve0 = 0n, reserve1 = 0n;
  for (const l of logs) {
    if (!l || l.removed || l.address !== route.pool || !Array.isArray(l.topics) || l.topics.length !== 1 || l.topics[0] !== syncTopic || !/^0x[\da-f]{128}$/.test(l.data)
      || !hash(l.blockHash) || !hash(l.transactionHash) || ![l.blockNumber, l.transactionIndex, l.logIndex].every(quantity)
      || number(l.blockNumber) < fromBlock || number(l.blockNumber) > target.number || BigInt(l.transactionIndex) >= (1n << 32n) || BigInt(l.logIndex) >= (1n << 32n)) throw Error('flap_quote_sync_invalid');
    const position = BigInt(l.blockNumber) * (1n << 64n) + BigInt(l.transactionIndex) * (1n << 32n) + BigInt(l.logIndex);
    if (position <= previous) throw Error('flap_quote_sync_order_invalid'); previous = position;
    try {
      const p = syncAbi.decodeEventLog('Sync', l.data, l.topics);
      if (syncAbi.encodeEventLog(syncAbi.getEvent('Sync')!, [...p]).data !== l.data) throw Error();
      reserve0 = BigInt(p.reserve0); reserve1 = BigInt(p.reserve1);
    } catch { throw Error('flap_quote_sync_invalid'); }
    last = l;
  }
  if (!last) throw Error('flap_quote_sync_unavailable');
  if (reserve0 <= 0n || reserve1 <= 0n) throw Error('flap_quote_pool_empty');
  return {last, reserve0, reserve1};
}

// Shared by the direct gross-quote receipt recovery. Keep the same complete
// immutable-template and canonical Sync validation as the captured-curve path.
export { validateFactoryCode as validateFreshPcsV2FactoryCode, syncState as freshPcsV2SyncState };

/** Target-block Flap capture plus two fully event-sourced PCS V2 reserve
 * snapshots. A current price, current reserve or historical eth_call never
 * seeds this proof. A Sync is full state, so the latest Sync in a completely
 * covered 4096-block window remains the block-end state even if no swap follows.
 * Retain only in the existing 72-hour receipt payload. Saved own-node evidence
 * replays without network reads after canonical source/target/code-anchor checks.
 */
export async function recoverFreshFlapQuote(options: {rpc: Rpc; tokenAddress: string; metadata: FreshTokenMetadata; source: FreshStateReadEvidence;
  target: FreshPriceBlock; anchor: FreshPriceBlock; canonicalHash: (number: number) => Promise<string | null>; prior?: FreshFlapQuoteRecoveryEvidence}): Promise<FreshFlapQuoteRecoveryEvidence> {
  const {rpc, tokenAddress: token, target, anchor, canonicalHash, prior} = options;
  if (!validBlock(target) || !validBlock(anchor) || anchor.number < target.number || Date.parse(target.timestamp) < bep344
    || Date.parse(anchor.timestamp) < Date.parse(target.timestamp)) throw Error('flap_quote_identity_invalid');
  if (await canonicalHash(target.number) !== target.hash) throw Error('flap_quote_noncanonical');
  const curve = readCurve(token, options.metadata, options.source, target), fromBlock = Math.max(0, target.number - 4095);
  if (prior && (prior.version !== 1 || prior.kind !== 'historical_flap_raw_v2_route' || prior.tokenAddress !== token || !sameBlock(prior.target, target)
    || stable(prior.source) !== stable(options.source) || !Array.isArray(prior.pools) || prior.pools.length !== 2)) throw Error('flap_quote_prior_invalid');
  const codeBlock = prior?.code?.block ?? anchor;
  if (!validBlock(codeBlock) || codeBlock.number < target.number || codeBlock.number > anchor.number || Date.parse(codeBlock.timestamp) < Date.parse(target.timestamp)
    || await canonicalHash(codeBlock.number) !== codeBlock.hash) throw Error('flap_quote_noncanonical');
  const code: FreshFlapQuoteRecoveryEvidence['code'] = {chainId: 56, block: {...codeBlock}, factory: PCS_V2_FACTORY,
    factoryRuntimeHash: FRESH_PCS_V2_FACTORY_RUNTIME_HASH, pairInitcodeHash: FRESH_PCS_V2_PAIR_INITCODE_HASH, pairRuntimeHash: FRESH_PCS_V2_PAIR_RUNTIME_HASH};
  if (prior) { if (stable(prior.code) !== stable(code)) throw Error('flap_quote_prior_invalid'); }
  else {
    if (Date.now() - Date.parse(anchor.timestamp) > 30000 || Date.parse(anchor.timestamp) - Date.now() > 5000) throw Error('flap_quote_anchor_stale');
    if (await rpc<string>('eth_chainId', []) !== '0x38') throw Error('flap_quote_chain_invalid');
    const codeAt = {blockHash: anchor.hash, requireCanonical: true};
    const [factoryCode, ...pairCodes] = await Promise.all([PCS_V2_FACTORY, ...FRESH_FLAP_RECOVERY_POOLS.map(p => p.pool)]
      .map(to => rpc<string>('eth_getCode', [to, codeAt])));
    validateFactoryCode(factoryCode);
    if (pairCodes.some(c => typeof c !== 'string' || !/^0x[\da-f]{29962}$/.test(c) || keccak256(c) !== FRESH_PCS_V2_PAIR_RUNTIME_HASH)) throw Error('flap_quote_pair_code_invalid');
  }
  let numerator = BigInt(curve.priceScaled18), denominator = scale * BigInt(curve.reserveModelScale.factor);
  const pools: FreshFlapQuoteRecoveryEvidence['pools'] = [], checked = new Map<number, string | null>();
  let fromToken = FRESH_FLAP_RECOVERY_QUOTE;
  for (let i = 0; i < FRESH_FLAP_RECOVERY_POOLS.length; i++) {
    const route = FRESH_FLAP_RECOVERY_POOLS[i], old = prior?.pools[i];
    if (old && (old.pool !== route.pool || old.token0 !== route.token0 || old.token1 !== route.token1 || old.fromBlock !== fromBlock || old.toBlock !== target.number)) throw Error('flap_quote_prior_invalid');
    const logs = old ? [old.lastSync] : await rpc<FreshLog[]>('eth_getLogs', [{address: route.pool, fromBlock: hex(fromBlock), toBlock: hex(target.number), topics: [syncTopic]}]);
    const state = syncState(logs, route, fromBlock, target);
    for (const l of logs) {
      const n = number(l.blockNumber); if (!checked.has(n)) checked.set(n, await canonicalHash(n));
      if (checked.get(n) !== l.blockHash) throw Error('flap_quote_noncanonical');
    }
    const fromIs0 = route.token0 === fromToken;
    numerator *= fromIs0 ? state.reserve1 : state.reserve0;
    denominator *= fromIs0 ? state.reserve0 : state.reserve1;
    fromToken = fromIs0 ? route.token1 : route.token0;
    pools.push({...route, fromBlock, toBlock: target.number, lastSync: state.last});
  }
  if (fromToken !== WBNB) throw Error('flap_quote_route_invalid');
  // Target precision is captured as 18; native BNB is defined in wei (18).
  // All intermediate token precision and UI multipliers cancel algebraically.
  const rawNativeRatio = {numerator: String(numerator), denominator: String(denominator)}, priceNative = new MarketDecimal(numerator, denominator).text();
  const result: FreshFlapQuoteRecoveryEvidence = {version: 1, kind: 'historical_flap_raw_v2_route', tokenAddress: token, target: {...target},
    source: structuredClone(options.source), curve, code, pools, rawNativeRatio, priceNative};
  if (prior && stable(prior) !== stable(result)) throw Error('flap_quote_prior_invalid');
  return result;
}

/** Current route only: every raw value and exact code-template check is pinned
 * to the same fresh EIP-1898 block. No historical log scan or retained history
 * is needed. The caller supplies the separately authenticated BNB/USD rate. */
export async function readFreshFlapRawQuote(options: {rpc: Rpc; token: FreshTokenMetadata; block: FreshPriceBlock}) {
  const {rpc, token, block} = options;
  if (!validBlock(block) || Date.parse(block.timestamp) < bep344 || Date.now() - Date.parse(block.timestamp) > 30000
    || Date.parse(block.timestamp) - Date.now() > 5000) throw Error('flap_quote_anchor_stale');
  if (await rpc<string>('eth_chainId', []) !== '0x38') throw Error('flap_quote_chain_invalid');
  const codeAt = {blockHash: block.hash, requireCanonical: true};
  const [factoryCode, ...pairCodes] = await Promise.all([PCS_V2_FACTORY, ...FRESH_FLAP_RECOVERY_POOLS.map(p => p.pool)].map(to => rpc<string>('eth_getCode', [to, codeAt])));
  validateFactoryCode(factoryCode);
  if (pairCodes.some(c => typeof c !== 'string' || !/^0x[\da-f]{29962}$/.test(c) || keccak256(c) !== FRESH_PCS_V2_PAIR_RUNTIME_HASH)) throw Error('flap_quote_pair_code_invalid');
  const call = async (to: string, abi: Interface, method: string, args: unknown[] = []) => {
    const data = abi.encodeFunctionData(method, args), result = await rpc<string>('eth_call', [{to, data}, codeAt]);
    if (typeof result !== 'string' || !/^0x(?:[\da-f]{2})*$/.test(result) || result.length > 32770) throw Error('flap_quote_state_invalid');
    return {to, data, result};
  };
  const calls = await Promise.all([call(token.address, tokenAbi, 'decimals'), call(token.address, tokenAbi, 'totalSupply'), call(FLAP_PORTAL, flapInterface, 'getTokenV8Safe', [token.address])]);
  const source: FreshStateReadEvidence = {version: 1, blockNumber: block.number, blockHash: block.hash, calls};
  const curve = readCurve(token.address, token, source, block);
  const reserves = await Promise.all(FRESH_FLAP_RECOVERY_POOLS.map(async route => {
    const {result} = await call(route.pool, syncAbi, 'getReserves');
    try {
      const p = syncAbi.decodeFunctionResult('getReserves', result);
      if (syncAbi.encodeFunctionResult('getReserves', [...p]) !== result || BigInt(p.reserve0) <= 0n || BigInt(p.reserve1) <= 0n) throw Error();
      return {reserve0: BigInt(p.reserve0), reserve1: BigInt(p.reserve1)};
    } catch { throw Error('flap_quote_pool_state_invalid'); }
  }));
  let numerator = BigInt(curve.priceScaled18), denominator = scale * BigInt(curve.reserveModelScale.factor), fromToken = FRESH_FLAP_RECOVERY_QUOTE;
  for (let i = 0; i < reserves.length; i++) {
    const route = FRESH_FLAP_RECOVERY_POOLS[i], fromIs0 = route.token0 === fromToken;
    numerator *= fromIs0 ? reserves[i].reserve1 : reserves[i].reserve0;
    denominator *= fromIs0 ? reserves[i].reserve0 : reserves[i].reserve1;
    fromToken = fromIs0 ? route.token1 : route.token0;
  }
  if (fromToken !== WBNB) throw Error('flap_quote_route_invalid');
  return {nativePerToken: new MarketDecimal(numerator, denominator).text(), rawNativeRatio: {numerator: String(numerator), denominator: String(denominator)},
    reserveModelScale: curve.reserveModelScale, observedBlock: {...block},
    identity: {protocol: 'flap_v2_raw_route' as const, portal: FLAP_PORTAL, quoteAddress: FRESH_FLAP_RECOVERY_QUOTE,
      intermediateAddress: FRESH_FLAP_RECOVERY_INTERMEDIATE, nativeAddress: WBNB, factory: PCS_V2_FACTORY, pairs: FRESH_FLAP_RECOVERY_POOLS.map(p => ({...p})),
      factoryRuntimeHash: FRESH_PCS_V2_FACTORY_RUNTIME_HASH, pairInitcodeHash: FRESH_PCS_V2_PAIR_INITCODE_HASH, pairRuntimeHash: FRESH_PCS_V2_PAIR_RUNTIME_HASH},
    state: {priceScaled18: curve.priceScaled18, reserveModelFactor: curve.reserveModelScale.factor, reserveRaw: curve.reserveModelScale.rawReserve,
      normalizedReserve: curve.reserveModelScale.normalizedReserve, pair0Reserve0: String(reserves[0].reserve0), pair0Reserve1: String(reserves[0].reserve1),
      pair1Reserve0: String(reserves[1].reserve0), pair1Reserve1: String(reserves[1].reserve1)}};
}
