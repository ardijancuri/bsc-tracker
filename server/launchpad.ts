import { Interface, ZeroAddress, id } from 'ethers';
import type { LaunchStage } from '../shared/intelligence.js';

// Official integration references, checked 2026-10-03:
// github.com/four-meme-community/fourmeme-docs (Helper3 and V1/V2 lite ABIs)
// docs.flap.sh/flap/developers/deployed-contract-addresses and inspect-a-token
export const FOUR_HELPER = '0xf251f83e40a78868fcfa3fa4599dad6494e46034';
export const FOUR_MANAGERS = ['0xec4549cadce5da21df6e6422d448034b5233bfbc', '0x5c952063c7fc8610ffdb798152d69f0b9550762b'];
export const FLAP_PORTAL = '0xe2ce6ab80874fa9fa2aae65d277dd6b8e65c9de0';
export const PCS_V2_FACTORY = '0xca143ce32fe78f1f7019d7d551a6402fc5350c73';
export const PCS_V3_FACTORY = '0x0bfbcf9fa4f9c56b0f40a671ad40e0805a091865';
export const WBNB = '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c';
export const pairInterface = new Interface([
  'function getPair(address tokenA,address tokenB) view returns (address pair)',
  'event PairCreated(address indexed token0,address indexed token1,address pair,uint256)',
  'event PoolCreated(address indexed token0,address indexed token1,uint24 indexed fee,int24 tickSpacing,address pool)',
]);
export function migrationPair(logs: { address: string; topics: string[]; data: string }[], token: string, quote: string) {
  if (token === quote) return null;
  const pools = new Set<string>();
  for (const log of logs) {
    if (![PCS_V2_FACTORY, PCS_V3_FACTORY].includes(log.address.toLowerCase())) continue;
    try {
      const parsed = pairInterface.parseLog(log);
      const assets = parsed ? [String(parsed.args.token0).toLowerCase(), String(parsed.args.token1).toLowerCase()] : [];
      if (assets.includes(token) && assets.includes(quote)) pools.add(String(parsed!.args.pair ?? parsed!.args.pool).toLowerCase());
    } catch { /* Ignore unrelated factory logs. */ }
  }
  return pools.size === 1 ? [...pools][0] : null;
}
export const fourInterface = new Interface([
  'function getTokenInfo(address token) view returns (uint256 version,address tokenManager,address quote,uint256 lastPrice,uint256 tradingFeeRate,uint256 minTradingFee,uint256 launchTime,uint256 offers,uint256 maxOffers,uint256 funds,uint256 maxFunds,bool liquidityAdded)',
  'event TokenCreate(address creator,address token,uint256 requestId,string name,string symbol,uint256 totalSupply,uint256 launchTime,uint256 launchFee)',
  'event LiquidityAdded(address base,uint256 offers,address quote,uint256 funds)',
  'event TradeStop(address token)',
]);
export const fourV1Interface = new Interface(['event TokenCreate(address creator,address token,uint256 requestId,string name,string symbol,uint256 totalSupply,uint256 launchTime)']);
export const flapInterface = new Interface([
  'function getTokenV8Safe(address token) view returns ((uint8 status,uint256 reserve,uint256 circulatingSupply,uint256 price,uint8 tokenVersion,uint256 r,uint256 h,uint256 k,uint256 dexSupplyThresh,address quoteTokenAddress,bool nativeToQuoteSwapEnabled,bytes32 extensionID,uint256 buyTaxRate,uint256 sellTaxRate,address pool,uint256 progress,uint8 lpFeeProfile,uint8 dexId) state)',
  'function getTokenV7(address token) view returns ((uint8 status,uint256 reserve,uint256 circulatingSupply,uint256 price,uint8 tokenVersion,uint256 r,uint256 h,uint256 k,uint256 dexSupplyThresh,address quoteTokenAddress,bool nativeToQuoteSwapEnabled,bytes32 extensionID,uint256 taxRate,address pool,uint256 progress,uint8 lpFeeProfile,uint8 dexId) state)',
  'event LaunchedToDEX(address token,address pool,uint256 amount,uint256 eth)',
  'event FlapTokenCLPoolCreated(address token,bytes32 poolId,uint160 sqrtPriceX96)',
  'event TokenCreated(uint256 ts,address creator,uint256 nonce,address token,string name,string symbol,string meta)',
  'event TokenMigratorSet(address token,uint8 migratorType)',
]);
export interface ChainLaunch {
  platform: 'fourmeme' | 'flap'; stage: LaunchStage; progress: number | null;
  launchedAt: string | null; quoteAddress: string | null; poolAddress: string | null; poolId: string | null;
}
const nonzero = (value: string) => value.toLowerCase() === ZeroAddress ? null : value.toLowerCase();
const percentage = (value: bigint, maximum: bigint) => maximum > 0n ? Math.max(0, Math.min(100, Number(value * 10_000n / maximum) / 100)) : null;
export function decodeFourState(raw: string): ChainLaunch | null {
  const info = fourInterface.decodeFunctionResult('getTokenInfo', raw);
  if (![1n, 2n].includes(info.version) || !FOUR_MANAGERS.includes(String(info.tokenManager).toLowerCase())) return null;
  const progress = info.liquidityAdded ? 100 : percentage(info.funds, info.maxFunds);
  const launchedAt = info.launchTime > 0n && info.launchTime < 10_000_000_000n ? new Date(Number(info.launchTime) * 1000).toISOString() : null;
  return { platform: 'fourmeme', stage: info.liquidityAdded ? 'graduated' : progress != null && progress >= 90 ? 'near_graduation' : 'bonding',
    progress, launchedAt, quoteAddress: nonzero(info.quote), poolAddress: null, poolId: null };
}
export function decodeFlapState(raw: string, method: 'getTokenV8Safe' | 'getTokenV7' = 'getTokenV8Safe'): ChainLaunch | null {
  const info = flapInterface.decodeFunctionResult(method, raw)[0];
  if (info.status === 0n) return null;
  const progress = percentage(info.progress, 10n ** 18n);
  return { platform: 'flap', stage: info.status === 4n ? 'graduated' : info.status === 1n ? progress != null && progress >= 90 ? 'near_graduation' : 'bonding' : 'unavailable',
    progress: info.status === 4n ? 100 : progress, launchedAt: null, quoteAddress: nonzero(info.quoteTokenAddress), poolAddress: nonzero(info.pool), poolId: null };
}
export function graduationPool(pool: string | null, poolId: string | null, migrator: number | null) {
  // Infinity's event pool field is a vault, not the actual pool. Never use it as a pair.
  return poolId || (migrator === 2 || migrator === 3 ? null : pool);
}
export function launchTransition(previous: LaunchStage | null, next: LaunchStage): 'near_graduation' | 'graduated' | null {
  if (!previous || previous === next || previous === 'unavailable') return null;
  if (next === 'graduated') return 'graduated';
  return next === 'near_graduation' && previous === 'bonding' ? 'near_graduation' : null;
}
export const launchEventTopics = [
  ...[fourInterface, fourV1Interface].flatMap(abi => abi.fragments.filter(fragment => fragment.type === 'event').map(fragment => id(fragment.format('sighash')))),
  ...flapInterface.fragments.filter(fragment => fragment.type === 'event').map(fragment => id(fragment.format('sighash'))),
];
export function parseLaunchLog(log: { address: string; topics: string[]; data: string }, tokens: Set<string>) {
  const contract = log.address.toLowerCase();
  if (!FOUR_MANAGERS.includes(contract) && contract !== FLAP_PORTAL) return null;
  const interfaces = FOUR_MANAGERS.includes(contract) ? [fourInterface, fourV1Interface] : [flapInterface];
  for (const abi of interfaces) {
    try {
      const parsed = abi.parseLog(log);
      if (!parsed) continue;
      const token = String(parsed.args.token ?? parsed.args.base).toLowerCase();
      if (!tokens.has(token)) continue;
      const kind = ['TokenCreate', 'TokenCreated'].includes(parsed.name) ? 'created' : ['LiquidityAdded', 'LaunchedToDEX'].includes(parsed.name) ? 'graduated' : parsed.name === 'TradeStop' ? 'stopped' : parsed.name === 'FlapTokenCLPoolCreated' ? 'pool' : 'migrator';
      const launchTime = parsed.args.launchTime ?? parsed.args.ts;
      return { token, platform: contract === FLAP_PORTAL ? 'flap' : 'fourmeme', kind,
        launchedAt: kind === 'created' && launchTime > 0n && launchTime < 10_000_000_000n ? new Date(Number(launchTime) * 1000).toISOString() : null,
        pool: parsed.args.pool ? String(parsed.args.pool).toLowerCase() : null,
        poolId: parsed.args.poolId ? String(parsed.args.poolId).toLowerCase() : null,
        migratorType: parsed.args.migratorType == null ? null : Number(parsed.args.migratorType) };
    } catch { /* An unsupported event version must not manufacture a milestone. */ }
  }
  return null;
}
