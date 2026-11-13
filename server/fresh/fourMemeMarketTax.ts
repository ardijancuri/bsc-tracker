import { Interface, ZeroAddress } from 'ethers';
import { FOUR_MANAGERS, WBNB } from '../launchpad.js';
import { freshAddress } from './capture.js';

// github.com/four-meme-community/fourmeme-docs: ITokenManager2.sol and tax-guide.md.
const managerAbi = new Interface([
  'function _tokenInfos(address token) view returns (address base,address quote,uint256 template,uint256 totalSupply,uint256 maxOffers,uint256 maxRaising,uint256 launchTime,uint256 offers,uint256 funds,uint256 lastPrice,uint256 K,uint256 T,uint256 status)',
]);
const taxAbi = new Interface([
  'function pair() view returns (address)',
  'function feeRate() view returns (uint256)',
  'function feeRateBuy() view returns (uint256)',
  'function feeRateSell() view returns (uint256)',
]);

interface FourMemeTaxMarket {
  tokenAddress: string;
  manager: string;
  version: bigint;
  helperQuoteAddress: string;
  liquidityAdded: boolean;
  market: { address: string; protocol: string; quoteAddress: string };
}

type CanonicalCall = (to: string, abi: Interface, method: string, args?: unknown[]) => Promise<readonly unknown[]>;

/** Read token tax for a market already authenticated by the current price path.
 * Helper3's tradingFeeRate describes the protocol fee, independent of this tax. */
export async function readFreshFourMemeMarketTax(input: FourMemeTaxMarket, call: CanonicalCall) {
  const token = freshAddress(input.tokenAddress);
  const manager = freshAddress(input.manager);
  const helperQuote = freshAddress(input.helperQuoteAddress);
  const market = freshAddress(input.market.address);
  const migrated = input.liquidityAdded;
  if (input.version !== 2n || manager !== FOUR_MANAGERS[1] || !token || token === ZeroAddress
    || !helperQuote || helperQuote === token || !market || market === ZeroAddress
    || freshAddress(input.market.quoteAddress) !== (helperQuote === ZeroAddress ? WBNB : helperQuote)) return null;
  if (migrated ? input.market.protocol !== 'pcs_v2'
    : input.market.protocol !== 'fourmeme' || market !== manager) return null;

  try {
    const info = await call(manager, managerAbi, '_tokenInfos', [token]);
    const template = info[2];
    const offers = info[7];
    const status = info[12];
    if (freshAddress(info[0]) !== token || freshAddress(info[1]) !== helperQuote || typeof template !== 'bigint'
      || typeof status !== 'bigint'
      || (migrated ? status !== 3n : status !== 0n || typeof offers !== 'bigint' || offers <= 0n)) return null;
    const creatorType = (template >> 10n) & 63n;
    if (creatorType !== 8n && creatorType !== 9n && !(creatorType === 5n && migrated)) return null;

    if (migrated && freshAddress((await call(token, taxAbi, 'pair'))[0]) !== market) return null;
    if (creatorType === 5n) {
      const [rate] = await call(token, taxAbi, 'feeRate');
      if (typeof rate !== 'bigint' || rate < 0n || rate > 10_000n) return null;
      return { buyTaxBps: Number(rate), sellTaxBps: Number(rate) };
    }

    const [[buy], [sell]] = await Promise.all([
      call(token, taxAbi, 'feeRateBuy'),
      call(token, taxAbi, 'feeRateSell'),
    ]);
    if (typeof buy !== 'bigint' || buy < 0n || buy > 10n || typeof sell !== 'bigint' || sell < 0n || sell > 10n) return null;
    return { buyTaxBps: Number(buy * 100n), sellTaxBps: Number(sell * 100n) };
  } catch {
    return null;
  }
}
