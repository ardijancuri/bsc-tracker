import { Interface, getCreate2Address, keccak256, solidityPackedKeccak256 } from 'ethers';
import { PCS_V2_FACTORY, WBNB } from '../launchpad.js';
import { FRESH_PCS_V2_FACTORY_RUNTIME_HASH, FRESH_PCS_V2_PAIR_INITCODE_HASH, FRESH_PCS_V2_PAIR_RUNTIME_HASH } from './flapQuoteRecovery.js';
import {freshHistoricalValuation,type FreshValuationReadOptions} from './valuationContext.js';

export const FRESH_BTCB_QUOTE = '0x7130d2a12b9bcbfae4f2634d864a1ee1ce3ead9c';
const assets = [FRESH_BTCB_QUOTE, WBNB].sort();
export const FRESH_BTCB_NATIVE_PAIR = getCreate2Address(PCS_V2_FACTORY,
  solidityPackedKeccak256(['address', 'address'], assets), FRESH_PCS_V2_PAIR_INITCODE_HASH).toLowerCase();
const abi = new Interface(['function decimals() view returns(uint8)', 'function factory() view returns(address)',
  'function token0() view returns(address)', 'function token1() view returns(address)',
  'function getReserves() view returns(uint112 reserve0,uint112 reserve1,uint32 timestamp)']);

/** Current BTCB conversion only. An exact PCS V2 pair and its reserve ratio
 * establish the quote; no BTC/USD feed, redemption value, or peg is assumed.
 * The deployed templates are authenticated independently of mutable pool state.
 * https://developer.pancakeswap.finance/contracts/v2/addresses */
export async function readFreshBtcNativeConversion(options: FreshValuationReadOptions) {
  const { rpc, block } = options, timestamp = Date.parse(block.timestamp), age = Date.now() - timestamp;
  const historical=freshHistoricalValuation(options);
  if (!Number.isSafeInteger(block.number) || block.number < 0 || !/^0x[\da-f]{64}$/.test(block.hash)
    || !Number.isFinite(timestamp) || !historical&&(age < -5000 || age > 30000)) throw Error('btcb_quote_current_block_required');
  if (await rpc<string>('eth_chainId', []) !== '0x38') throw Error('btcb_quote_chain_invalid');
  const at = { blockHash: block.hash, requireCanonical: true };
  const [factoryCode, pairCode] = await Promise.all([PCS_V2_FACTORY, FRESH_BTCB_NATIVE_PAIR].map(to => rpc<string>('eth_getCode', [to, at])));
  if (typeof factoryCode !== 'string' || !/^0x[\da-f]{38168}$/.test(factoryCode) || keccak256(factoryCode) !== FRESH_PCS_V2_FACTORY_RUNTIME_HASH
    || typeof pairCode !== 'string' || !/^0x[\da-f]{29962}$/.test(pairCode) || keccak256(pairCode) !== FRESH_PCS_V2_PAIR_RUNTIME_HASH) throw Error('btcb_quote_code_invalid');
  const call = async (to: string, method: string) => {
    const raw = await rpc<string>('eth_call', [{ to, data: abi.encodeFunctionData(method) }, at]);
    try {
      if (typeof raw !== 'string' || !/^0x(?:[\da-f]{2})*$/.test(raw) || raw.length > 1026) throw Error();
      const result = abi.decodeFunctionResult(method, raw);
      if (abi.encodeFunctionResult(method, [...result]) !== raw) throw Error();
      return result;
    } catch { throw Error('btcb_quote_state_invalid'); }
  };
  const [factory, token0, token1, reserves, quotePrecision, nativePrecision] = await Promise.all([
    call(FRESH_BTCB_NATIVE_PAIR, 'factory'), call(FRESH_BTCB_NATIVE_PAIR, 'token0'), call(FRESH_BTCB_NATIVE_PAIR, 'token1'),
    call(FRESH_BTCB_NATIVE_PAIR, 'getReserves'), call(FRESH_BTCB_QUOTE, 'decimals'), call(WBNB, 'decimals'),
  ]);
  if (String(factory[0]).toLowerCase() !== PCS_V2_FACTORY || String(token0[0]).toLowerCase() !== assets[0]
    || String(token1[0]).toLowerCase() !== assets[1]) throw Error('btcb_quote_pair_identity_invalid');
  const quoteDecimals = Number(quotePrecision[0]);
  if (!Number.isInteger(quoteDecimals) || quoteDecimals < 0 || quoteDecimals > 36 || Number(nativePrecision[0]) !== 18) throw Error('btcb_quote_precision_invalid');
  const quoteIs0 = assets[0] === FRESH_BTCB_QUOTE, quoteRaw = BigInt(reserves[quoteIs0 ? 0 : 1]), nativeRaw = BigInt(reserves[quoteIs0 ? 1 : 0]);
  if (quoteRaw <= 0n || nativeRaw <= 0n) throw Error('btcb_quote_pool_empty');
  return { quoteDecimals, quoteRaw, nativeRaw, observedAt: block.timestamp,
    identity: { protocol: 'pcs_v2' as const, factory: PCS_V2_FACTORY, pair: FRESH_BTCB_NATIVE_PAIR,
      token0: assets[0], token1: assets[1], quoteToken: FRESH_BTCB_QUOTE, nativeToken: WBNB,
      factoryRuntimeHash: FRESH_PCS_V2_FACTORY_RUNTIME_HASH, pairInitcodeHash: FRESH_PCS_V2_PAIR_INITCODE_HASH,
      pairRuntimeHash: FRESH_PCS_V2_PAIR_RUNTIME_HASH, quoteDecimals },
    state: { quoteReserveRaw: String(quoteRaw), nativeReserveRaw: String(nativeRaw) } };
}
