import { decodeBytes32String, Interface, ZeroAddress } from 'ethers';
import { FLAP_PORTAL, FOUR_HELPER, FOUR_MANAGERS, PCS_V2_FACTORY, WBNB, flapInterface, fourInterface } from '../launchpad.js';
import { poolMarketAbi } from '../nodeMarketProtocols.js';
import type { Rpc } from '../rpc.js';
import { freshAddress, freshHash } from './capture.js';
import { readFreshFlapDexTax } from './flapDexTax.js';
import { readFreshFourMemeMarketTax } from './fourMemeMarketTax.js';
import { freshCall, type FreshPriceBlock } from './pricing.js';
import { trendingQuoteSymbol, verifiedMarketQuoteSymbol } from './settlementQuote.js';

export interface TrendingLaunchMarketRequest {
  address: string;
  protocol: 'flap' | 'fourmeme';
  quoteAddress?: string;
  marketAddress?: string;
  marketProtocol?: string;
}
export interface TrendingLaunchMarketDetails {
  quoteSymbol?: string;
  buyTaxBps?: number;
  sellTaxBps?: number;
  expiresAtSeconds?: number;
}

const tokenSymbolAbi = new Interface(['function symbol() view returns (string)']);
const bytesSymbolAbi = new Interface(['function symbol() view returns (bytes32)']);
type CanonicalCall = Parameters<typeof readFreshFourMemeMarketTax>[1];

async function symbolFor(address: string, native: boolean, call: CanonicalCall) {
  if (native) return 'BNB';
  const known = trendingQuoteSymbol(address);
  if (known) return known;
  try {
    return verifiedMarketQuoteSymbol((await call(address, tokenSymbolAbi, 'symbol'))[0]);
  } catch {
    try {
      return verifiedMarketQuoteSymbol(decodeBytes32String(String((await call(address, bytesSymbolAbi, 'symbol'))[0])));
    } catch {
      return undefined;
    }
  }
}

/** Authenticate a newly discovered preferred pool only when no suitable
 * previously authenticated market is available to the caller. */
async function pancakeV2Pair(token: string, quote: string, call: CanonicalCall, expected?: string) {
  try {
    const pair = freshAddress((await call(PCS_V2_FACTORY, poolMarketAbi, 'getPair', [token, quote]))[0]);
    if (!pair || pair === ZeroAddress || pair === token || pair === quote || expected && expected !== pair) return;
    const [[factory], [left], [right]] = await Promise.all([
      call(pair, poolMarketAbi, 'factory'),
      call(pair, poolMarketAbi, 'token0'),
      call(pair, poolMarketAbi, 'token1'),
    ]);
    const t0 = freshAddress(left), t1 = freshAddress(right);
    if (freshAddress(factory) === PCS_V2_FACTORY && (t0 === token && t1 === quote || t0 === quote && t1 === token)) return pair;
  } catch {
    // State may not exist at this block. Leave tax unknown.
  }
}

function supportsCurve(request: TrendingLaunchMarketRequest, controller: string) {
  return (!request.marketProtocol || request.marketProtocol === request.protocol)
    && (!request.marketAddress || request.marketAddress === controller);
}

async function readFlapMarket(
  request: TrendingLaunchMarketRequest, call: CanonicalCall, options: { rpc: Rpc; block: FreshPriceBlock },
): Promise<TrendingLaunchMarketDetails> {
  const v8 = await call(FLAP_PORTAL, flapInterface, 'getTokenV8Safe', [request.address]).catch(() => null);
  const result = v8?.[0] ?? (await call(FLAP_PORTAL, flapInterface, 'getTokenV7', [request.address]))[0];
  if (!result || typeof result !== 'object') return {};
  const state = result as Record<string, unknown>;
  if (state.status !== 1n && state.status !== 4n) return {};

  const curve = state.status === 1n;
  const portalQuote = freshAddress(state.quoteTokenAddress);
  const quote = portalQuote === ZeroAddress ? WBNB : portalQuote;
  if (!quote || quote === request.address || request.quoteAddress && request.quoteAddress !== quote) return {};
  const symbol = symbolFor(quote, curve && portalQuote === ZeroAddress, call);
  const taxRead = async () => {
    const version = state.tokenVersion, buy = state.buyTaxRate, sell = state.sellTaxRate;
    if (!v8 || typeof version !== 'bigint' || typeof buy !== 'bigint' || typeof sell !== 'bigint'
      || buy < 0n || sell < 0n || buy > 10_000n || sell > 10_000n) return;
    const rates = { buyTaxBps: Number(buy), sellTaxBps: Number(sell) };
    const nonTaxed = [0n, 1n, 2n, 7n].includes(version) && buy === 0n && sell === 0n;
    if (curve) {
      const known = nonTaxed || version === 6n || [4n, 5n].includes(version) && buy === sell;
      return supportsCurve(request, FLAP_PORTAL) && known ? rates : undefined;
    }

    const pool = freshAddress(state.pool);
    if (!pool || pool === ZeroAddress || request.marketAddress && request.marketAddress !== pool || !nonTaxed && version !== 6n) return;
    const confirmed = request.marketAddress && ['pcs_v2', 'pcs_v3'].includes(request.marketProtocol ?? '');
    if (!confirmed && (request.marketProtocol && request.marketProtocol !== 'pcs_v2'
      || !await pancakeV2Pair(request.address, quote, call, pool))) return;
    return nonTaxed ? rates : readFreshFlapDexTax(options.rpc, options.block, request.address, pool, rates);
  };
  const [quoteSymbol, tax] = await Promise.all([symbol, taxRead()]);
  return { ...(quoteSymbol === undefined ? {} : { quoteSymbol }), ...tax };
}

async function readFourMarket(request: TrendingLaunchMarketRequest, call: CanonicalCall): Promise<TrendingLaunchMarketDetails> {
  const info = await call(FOUR_HELPER, fourInterface, 'getTokenInfo', [request.address]);
  const manager = freshAddress(info[1]);
  const helperQuote = freshAddress(info[2]);
  const version = info[0], migrated = info[11];
  if (!manager || !FOUR_MANAGERS.includes(manager) || !helperQuote || version !== 1n && version !== 2n || typeof migrated !== 'boolean') return {};

  const quote = helperQuote === ZeroAddress ? WBNB : helperQuote;
  if (quote === request.address || request.quoteAddress && request.quoteAddress !== quote) return {};
  const symbol = symbolFor(quote, !migrated && helperQuote === ZeroAddress, call);
  const taxRead = async () => {
    if (version !== 2n || manager !== FOUR_MANAGERS[1]
      || (!migrated && !supportsCurve(request, manager))
      || (migrated && request.marketProtocol && request.marketProtocol !== 'pcs_v2')) return;
    const market = !migrated ? manager
      : request.marketProtocol === 'pcs_v2' && request.marketAddress ? request.marketAddress
        : await pancakeV2Pair(request.address, quote, call, request.marketAddress);
    if (!market) return;
    return readFreshFourMemeMarketTax({
      tokenAddress: request.address, helperQuoteAddress: helperQuote, manager, version, liquidityAdded: migrated,
      market: { address: market, protocol: migrated ? 'pcs_v2' : 'fourmeme', quoteAddress: quote },
    }, call);
  };
  const [quoteSymbol, tax] = await Promise.all([symbol, taxRead()]);
  return { ...(quoteSymbol === undefined ? {} : { quoteSymbol }), ...tax };
}

/** Display metadata only. Every state read uses the same confirmed BSC block,
 * without currency conversion, price sampling, or any write to trade state. */
export function createTrendingLaunchMarketReader(rpc: Rpc) {
  return async (request: TrendingLaunchMarketRequest, block: FreshPriceBlock): Promise<TrendingLaunchMarketDetails> => {
    const address = freshAddress(request.address);
    const quote = freshAddress(request.quoteAddress);
    const market = freshAddress(request.marketAddress);
    if (!address || address === ZeroAddress || !freshHash(block.hash)
      || (request.quoteAddress !== undefined && !quote) || (request.marketAddress !== undefined && !market)) return {};
    const options = { rpc, block };
    const call: CanonicalCall = (to, abi, method, args) => freshCall(options, to, abi, method, args);
    const normalized = { ...request, address, quoteAddress: quote === ZeroAddress ? WBNB : quote ?? undefined, marketAddress: market ?? undefined };
    try {
      return request.protocol === 'flap' ? await readFlapMarket(normalized, call, options) : await readFourMarket(normalized, call);
    } catch {
      return {};
    }
  };
}
