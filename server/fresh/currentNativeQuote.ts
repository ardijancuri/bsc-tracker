import { Interface, getCreate2Address, keccak256, solidityPackedKeccak256 } from 'ethers';
import { PCS_V2_FACTORY, WBNB } from '../launchpad.js';
import { FRESH_PCS_V2_FACTORY_RUNTIME_HASH, FRESH_PCS_V2_PAIR_INITCODE_HASH, FRESH_PCS_V2_PAIR_RUNTIME_HASH } from './flapQuoteRecovery.js';
import {freshHistoricalValuation,type FreshValuationReadOptions} from './valuationContext.js';

export const FRESH_CURRENT_NATIVE_QUOTES=Object.freeze({
  bncb:'0x4902c5ebc598265ed2212b559b042de8a5eeec3f',
  spcxb:'0xbe9d156892e55e7154bcd3cb0fea677f9d3103e1',
});
export type FreshCurrentNativeQuote=keyof typeof FRESH_CURRENT_NATIVE_QUOTES;
export function freshCurrentNativePair(kind:FreshCurrentNativeQuote){
  const quote=FRESH_CURRENT_NATIVE_QUOTES[kind];
  if(!Object.hasOwn(FRESH_CURRENT_NATIVE_QUOTES,kind))throw Error('current_native_quote_unsupported');
  return getCreate2Address(PCS_V2_FACTORY,solidityPackedKeccak256(['address','address'],[quote,WBNB].sort()),FRESH_PCS_V2_PAIR_INITCODE_HASH).toLowerCase();
}
const abi = new Interface(['function decimals() view returns(uint8)', 'function factory() view returns(address)',
  'function token0() view returns(address)', 'function token1() view returns(address)',
  'function getPair(address,address) view returns(address)',
  'function getReserves() view returns(uint112 reserve0,uint112 reserve1,uint32 timestamp)']);

/** For these explicitly approved mutable quote tokens, use only the current canonical block's
 * precision and authenticated PCS V2 reserves. No stock price, peg, historical
 * metadata or saved historical reserve may supply this current conversion. */
export async function readFreshCurrentNativeConversion(kind:FreshCurrentNativeQuote,options: FreshValuationReadOptions) {
  const quote=FRESH_CURRENT_NATIVE_QUOTES[kind];
  if(!Object.hasOwn(FRESH_CURRENT_NATIVE_QUOTES,kind))throw Error('current_native_quote_unsupported');
  const pairAddress=freshCurrentNativePair(kind),assets=[quote,WBNB].sort(),failure=(reason:string)=>Error(kind+'_quote_'+reason);
  const { rpc, block } = options, timestamp = Date.parse(block.timestamp), age = Date.now() - timestamp;
  const historical=freshHistoricalValuation(options);
  if (!Number.isSafeInteger(block.number) || block.number < 0 || !/^0x[\da-f]{64}$/.test(block.hash)
    || !Number.isFinite(timestamp) || !historical&&(age < -5000 || age > 30000)) throw failure('current_block_required');
  if (await rpc<string>('eth_chainId', []) !== '0x38') throw failure('chain_invalid');
  const at = { blockHash: block.hash, requireCanonical: true };
  const [factoryCode, pairCode, quoteCode] = await Promise.all([PCS_V2_FACTORY, pairAddress, quote].map(to => rpc<string>('eth_getCode', [to, at])));
  if (typeof factoryCode !== 'string' || !/^0x[\da-f]{38168}$/.test(factoryCode) || keccak256(factoryCode) !== FRESH_PCS_V2_FACTORY_RUNTIME_HASH
    || typeof pairCode !== 'string' || !/^0x[\da-f]{29962}$/.test(pairCode) || keccak256(pairCode) !== FRESH_PCS_V2_PAIR_RUNTIME_HASH
    || typeof quoteCode !== 'string' || !/^0x(?:[\da-f]{2})+$/.test(quoteCode)) throw failure('code_invalid');
  const call = async (to: string, method: string, args: unknown[] = []) => {
    const raw = await rpc<string>('eth_call', [{ to, data: abi.encodeFunctionData(method,args) }, at]);
    try {
      if (typeof raw !== 'string' || !/^0x(?:[\da-f]{2})*$/.test(raw) || raw.length > 1026) throw Error();
      const result = abi.decodeFunctionResult(method, raw);
      if (abi.encodeFunctionResult(method, [...result]) !== raw) throw Error();
      return result;
    } catch { throw failure('state_invalid'); }
  };
  const [pair, factory, token0, token1, reserves, quotePrecision, nativePrecision] = await Promise.all([
    call(PCS_V2_FACTORY,'getPair',[quote,WBNB]),
    call(pairAddress, 'factory'), call(pairAddress, 'token0'), call(pairAddress, 'token1'),
    call(pairAddress, 'getReserves'), call(quote, 'decimals'), call(WBNB, 'decimals'),
  ]);
  if (String(pair[0]).toLowerCase() !== pairAddress || String(factory[0]).toLowerCase() !== PCS_V2_FACTORY
    || String(token0[0]).toLowerCase() !== assets[0] || String(token1[0]).toLowerCase() !== assets[1]) throw failure('pair_identity_invalid');
  const quoteDecimals = Number(quotePrecision[0]);
  if (!Number.isInteger(quoteDecimals) || quoteDecimals < 0 || quoteDecimals > 36 || Number(nativePrecision[0]) !== 18) throw failure('precision_invalid');
  const quoteIs0 = assets[0] === quote, quoteRaw = BigInt(reserves[quoteIs0 ? 0 : 1]), nativeRaw = BigInt(reserves[quoteIs0 ? 1 : 0]);
  if (quoteRaw <= 0n || nativeRaw <= 0n) throw failure('pool_empty');
  return { quoteDecimals, quoteRaw, nativeRaw, observedAt: block.timestamp,
    identity: { protocol: 'pcs_v2' as const, factory: PCS_V2_FACTORY, pair: pairAddress,
      token0: assets[0], token1: assets[1], quoteToken: quote, nativeToken: WBNB,
      factoryRuntimeHash: FRESH_PCS_V2_FACTORY_RUNTIME_HASH, pairInitcodeHash: FRESH_PCS_V2_PAIR_INITCODE_HASH,
      pairRuntimeHash: FRESH_PCS_V2_PAIR_RUNTIME_HASH, quoteDecimals },
    state: { quoteReserveRaw: String(quoteRaw), nativeReserveRaw: String(nativeRaw) } };
}
