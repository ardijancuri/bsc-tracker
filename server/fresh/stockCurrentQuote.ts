import { Interface, keccak256 } from 'ethers';
import type { Rpc } from '../rpc.js';
import { WBNB } from '../launchpad.js';
import type { FreshPriceBlock } from './pricing.js';
import { FRESH_STOCK_QUOTE_TOKEN, FRESH_WOOFI_BSC_POOL } from './stockQuote.js';

// Official current WOOFi venue and ABI:
// https://github.com/woonetwork/docs/blob/main/guides/integrate-woofi-as-liquidity-source.md
// https://github.com/woonetwork/WooPoolV2/blob/main/contracts/interfaces/IWooPPV2.sol
// query checks output reserves; tryQuery does not. This is a current executable
// venue quote for one verified whole stock token, not a historical settlement
// or an assertion that an arbitrary wallet's transaction will execute.
export const freshStockCurrentQuoteInterface = new Interface([
  'function decimals() view returns(uint8)',
  'function query(address fromToken,address toToken,uint256 fromAmount) view returns(uint256 toAmount)',
]);
export interface FreshStockCurrentRawQuote {
  version: 1;
  kind: 'woofi_current_query';
  chainId: 56;
  venue: typeof FRESH_WOOFI_BSC_POOL;
  quoteToken: typeof FRESH_STOCK_QUOTE_TOKEN;
  nativeToken: typeof WBNB;
  target: FreshPriceBlock;
  source: FreshPriceBlock;
  quoteDecimals: number;
  nativeDecimals: 18;
  quoteRaw: string;
  nativeRaw: string;
  venueRuntimeHash: string;
  calldataHash: string;
}
const hash = (value: unknown): value is string => typeof value === 'string' && /^0x[\da-f]{64}$/.test(value);
const bytes = (value: unknown): value is string => typeof value === 'string' && /^0x(?:[\da-f]{2})*$/i.test(value);

/** Current state only. Precision is read at this exact canonical block even
 * though the stock token's beacon implementation is mutable. Raw stock units
 * cancel when this output is composed with the V4 raw quote/token ratio.
 * No prior receipt, latest state, cached decimals or token peg is substituted. */
export async function readFreshStockCurrentRawQuote(options: { rpc: Rpc; block: FreshPriceBlock }): Promise<FreshStockCurrentRawQuote> {
  const { rpc, block } = options;
  if (!block || !Number.isSafeInteger(block.number) || block.number < 0 || !hash(block.hash)
    || typeof block.timestamp !== 'string' || !Number.isFinite(Date.parse(block.timestamp))
    || new Date(block.timestamp).toISOString() !== block.timestamp) throw Error('stock_current_quote_block_invalid');
  const selector = { blockHash: block.hash, requireCanonical: true };
  async function call(address: string, method: 'decimals' | 'query', args: unknown[] = []) {
    const data = freshStockCurrentQuoteInterface.encodeFunctionData(method, args), raw = await rpc<string>('eth_call', [{ to: address, data }, selector]);
    try {
      if (!bytes(raw)) throw Error();
      const decoded = freshStockCurrentQuoteInterface.decodeFunctionResult(method, raw);
      if (freshStockCurrentQuoteInterface.encodeFunctionResult(method, decoded).toLowerCase() !== raw.toLowerCase()) throw Error();
      return decoded;
    } catch { throw Error('stock_current_quote_response_invalid'); }
  }
  const [chainId, code, quotePrecision, nativePrecision] = await Promise.all([
    rpc<string>('eth_chainId', []), rpc<string>('eth_getCode', [FRESH_WOOFI_BSC_POOL, selector]),
    call(FRESH_STOCK_QUOTE_TOKEN, 'decimals'), call(WBNB, 'decimals'),
  ]);
  if (typeof chainId !== 'string' || !/^0x[\da-f]{1,16}$/i.test(chainId) || BigInt(chainId) !== 56n) throw Error('stock_current_quote_chain_unverified');
  if (!bytes(code) || code === '0x' || code.length > 2 + 64 * 1024 * 2) throw Error('stock_current_quote_venue_unverified');
  const decimals = Number(quotePrecision[0]);
  // A one-whole-token uint256 query supports precision through 77, not an
  // assumed ERC20 18. Larger powers cannot be represented as uint256 inputs.
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 77 || Number(nativePrecision[0]) !== 18) throw Error('stock_current_quote_precision_unverified');
  const quoteRaw = 10n ** BigInt(decimals), args = [FRESH_STOCK_QUOTE_TOKEN, WBNB, quoteRaw];
  const nativeRaw = BigInt((await call(FRESH_WOOFI_BSC_POOL, 'query', args))[0]);
  if (nativeRaw <= 0n) throw Error('stock_current_quote_unavailable');
  return { version: 1, kind: 'woofi_current_query', chainId: 56, venue: FRESH_WOOFI_BSC_POOL,
    quoteToken: FRESH_STOCK_QUOTE_TOKEN, nativeToken: WBNB, target: block, source: block,
    quoteDecimals: decimals, nativeDecimals: 18, quoteRaw: String(quoteRaw), nativeRaw: String(nativeRaw),
    venueRuntimeHash: keccak256(code), calldataHash: keccak256(freshStockCurrentQuoteInterface.encodeFunctionData('query', args)) };
}
