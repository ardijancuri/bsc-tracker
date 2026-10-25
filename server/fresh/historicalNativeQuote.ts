import { getCreate2Address, keccak256, solidityPackedKeccak256 } from 'ethers';
import { PCS_V2_FACTORY, WBNB } from '../launchpad.js';
import type { Rpc } from '../rpc.js';
import { freshPcsV2SyncState, validateFreshPcsV2FactoryCode, FRESH_PCS_V2_FACTORY_RUNTIME_HASH,
  FRESH_PCS_V2_PAIR_INITCODE_HASH, FRESH_PCS_V2_PAIR_RUNTIME_HASH } from './flapQuoteRecovery.js';
import { FRESH_BTCB_QUOTE } from './currentBtcQuote.js';
import type { FreshLog } from './capture.js';
import type { FreshPriceBlock } from './pricing.js';

const syncTopic = '0x1c411e9a96e071241c2f21f7726b17ae89e3cab4c78be50e062b03a9fffbbad1';
const hash = (value: unknown): value is string => typeof value === 'string' && /^0x[\da-f]{64}$/.test(value);
const validBlock = (value: FreshPriceBlock) => value && Number.isSafeInteger(value.number) && value.number >= 0 && hash(value.hash)
  && Number.isFinite(Date.parse(value.timestamp)) && new Date(value.timestamp).toISOString() === value.timestamp;
const stable = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
export const FRESH_HISTORICAL_BTCB_PAIR = getCreate2Address(PCS_V2_FACTORY,
  solidityPackedKeccak256(['address', 'address'], [FRESH_BTCB_QUOTE, WBNB].sort()), FRESH_PCS_V2_PAIR_INITCODE_HASH).toLowerCase();
export interface FreshHistoricalNativeQuoteEvidence {
  version: 1; kind: 'historical_raw_btcb_native_v2'; quoteAddress: typeof FRESH_BTCB_QUOTE;
  target: FreshPriceBlock; transactionIndex: number; fromBlock: number; toBlock: number;
  code: { chainId: 56; block: FreshPriceBlock; factoryRuntimeHash: typeof FRESH_PCS_V2_FACTORY_RUNTIME_HASH;
    pairRuntimeHash: typeof FRESH_PCS_V2_PAIR_RUNTIME_HASH; pairInitcodeHash: typeof FRESH_PCS_V2_PAIR_INITCODE_HASH };
  pool: { address: typeof FRESH_HISTORICAL_BTCB_PAIR; token0: string; token1: string; lastSync: FreshLog };
  nativeRaw: string; quoteRaw: string;
}

/** A raw BTCB/wei ratio from genuine canonical Sync history preceding the
 * selected transaction. No current reserve, current price or historical BTCB
 * decimals are substituted. The exact immutable factory/pair template and
 * deterministic sorted-token address authenticate historical pool identity.
 * The small proof lives beside its original receipt for its existing TTL. */
export async function recoverFreshHistoricalNativeQuote(options: { rpc: Rpc; target: FreshPriceBlock; transactionIndex: number;
  anchor: FreshPriceBlock; canonicalHash: (number: number) => Promise<string | null>; prior?: FreshHistoricalNativeQuoteEvidence }): Promise<FreshHistoricalNativeQuoteEvidence> {
  const { rpc, target, anchor, transactionIndex, canonicalHash, prior } = options;
  if (!validBlock(target) || !validBlock(anchor) || anchor.number < target.number || Date.parse(anchor.timestamp) < Date.parse(target.timestamp)
    || Date.parse(target.timestamp) < 1718863500000 || !Number.isSafeInteger(transactionIndex) || transactionIndex < 0 || transactionIndex >= 2 ** 32) throw Error('historical_native_quote_identity_invalid');
  if (await canonicalHash(target.number) !== target.hash) throw Error('historical_native_quote_noncanonical');
  const fromBlock = Math.max(0, target.number - 4095), toBlock = target.number, codeBlock = prior?.code?.block ?? anchor;
  if (!validBlock(codeBlock) || codeBlock.number < target.number || codeBlock.number > anchor.number
    || Date.parse(codeBlock.timestamp) < Date.parse(target.timestamp) || await canonicalHash(codeBlock.number) !== codeBlock.hash) throw Error('historical_native_quote_noncanonical');
  const code: FreshHistoricalNativeQuoteEvidence['code'] = { chainId: 56, block: { ...codeBlock }, factoryRuntimeHash: FRESH_PCS_V2_FACTORY_RUNTIME_HASH,
    pairRuntimeHash: FRESH_PCS_V2_PAIR_RUNTIME_HASH, pairInitcodeHash: FRESH_PCS_V2_PAIR_INITCODE_HASH };
  if (prior) {
    if (Buffer.byteLength(stable(prior)) > 16384 || prior.version !== 1 || prior.kind !== 'historical_raw_btcb_native_v2'
      || prior.quoteAddress !== FRESH_BTCB_QUOTE || stable(prior.target) !== stable(target) || prior.transactionIndex !== transactionIndex
      || prior.fromBlock !== fromBlock || prior.toBlock !== toBlock || stable(prior.code) !== stable(code)) throw Error('historical_native_quote_prior_invalid');
  } else {
    if (Date.now() - Date.parse(anchor.timestamp) > 30000 || Date.parse(anchor.timestamp) - Date.now() > 5000) throw Error('historical_native_quote_anchor_stale');
    if (await rpc<string>('eth_chainId', []) !== '0x38') throw Error('historical_native_quote_chain_invalid');
    const at = { blockHash: anchor.hash, requireCanonical: true }, [factoryCode, pairCode] = await Promise.all([
      rpc<string>('eth_getCode', [PCS_V2_FACTORY, at]), rpc<string>('eth_getCode', [FRESH_HISTORICAL_BTCB_PAIR, at]),
    ]);
    validateFreshPcsV2FactoryCode(factoryCode);
    if (typeof pairCode !== 'string' || !/^0x[\da-f]{29962}$/.test(pairCode) || keccak256(pairCode) !== FRESH_PCS_V2_PAIR_RUNTIME_HASH) throw Error('historical_native_quote_pair_code_invalid');
  }
  const [token0, token1] = [FRESH_BTCB_QUOTE, WBNB].sort(), route = { pool: FRESH_HISTORICAL_BTCB_PAIR, token0, token1 };
  if (prior && (prior.pool?.address !== route.pool || prior.pool.token0 !== token0 || prior.pool.token1 !== token1)) throw Error('historical_native_quote_prior_invalid');
  const logs = prior ? [prior.pool.lastSync] : await rpc<FreshLog[]>('eth_getLogs', [{ address: route.pool, fromBlock: '0x' + fromBlock.toString(16), toBlock: '0x' + toBlock.toString(16), topics: [syncTopic] }]);
  // Validate the full bounded result before selecting earlier transaction state.
  freshPcsV2SyncState(logs, route, fromBlock, target);
  const checked = new Map<number, string | null>();
  for (const log of logs) {
    const number = Number(BigInt(log.blockNumber)); if (!checked.has(number)) checked.set(number, await canonicalHash(number));
    if (checked.get(number) !== log.blockHash) throw Error('historical_native_quote_noncanonical');
  }
  const preceding = logs.filter(log => Number(BigInt(log.blockNumber)) < target.number || Number(BigInt(log.transactionIndex)) < transactionIndex);
  const state = freshPcsV2SyncState(preceding, route, fromBlock, target), quoteIs0 = token0 === FRESH_BTCB_QUOTE;
  const result: FreshHistoricalNativeQuoteEvidence = { version: 1, kind: 'historical_raw_btcb_native_v2', quoteAddress: FRESH_BTCB_QUOTE,
    target: { ...target }, transactionIndex, fromBlock, toBlock, code,
    pool: { address: route.pool, token0, token1, lastSync: structuredClone(state.last) },
    nativeRaw: String(quoteIs0 ? state.reserve1 : state.reserve0), quoteRaw: String(quoteIs0 ? state.reserve0 : state.reserve1) };
  if (prior && stable(prior) !== stable(result)) throw Error('historical_native_quote_prior_invalid');
  return result;
}
