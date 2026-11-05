import { AbiCoder, Interface, ZeroAddress, id } from 'ethers';
import { WBNB } from '../launchpad.js';
import type { FreshLog } from './capture.js';

// Flap Pool Launch uses a separate BNB Chain Portal and a versioned payload.
// https://docs.flap.sh/en/flap/drafts/pool-launch
export const FRESH_FLAP_POOL_PORTAL = '0x000042108465206185a077edc3f3fd2b49060000';
export const flapPoolLaunchInterface = new Interface([
  'event FlapDirectLaunched(address token,uint8 kind,address creator,bytes32 schemaId,bytes data)',
]);
export const FRESH_FLAP_POOL_LAUNCH_TOPIC = flapPoolLaunchInterface.getEvent('FlapDirectLaunched')!.topicHash;
export const FRESH_FLAP_POOL_V2_SCHEMA = id('DirectLaunchV2(DirectLaunchV2Data)');
export const flapPoolLaunchDataType = 'tuple(uint256 nonce,uint256 ts,uint8 tokenVersion,address quoteToken,uint8 migratorType,uint256 initialPriceWad,string name,string symbol,string meta,address pool,uint256 totalSupply,uint8 antiSniperMode,uint16 maxBuyBps)';
const abi = AbiCoder.defaultAbiCoder();

export function decodeFreshFlapPoolLaunch(log: Pick<FreshLog, 'address' | 'topics' | 'data' | 'removed'>) {
  if (log.removed || log.address.toLowerCase() !== FRESH_FLAP_POOL_PORTAL || log.topics.length !== 1 ||
      log.topics[0].toLowerCase() !== FRESH_FLAP_POOL_LAUNCH_TOPIC) return null;
  try {
    const event = flapPoolLaunchInterface.decodeEventLog('FlapDirectLaunched', log.data, log.topics);
    if (event.kind !== 0n || event.schemaId !== FRESH_FLAP_POOL_V2_SCHEMA ||
        flapPoolLaunchInterface.encodeEventLog('FlapDirectLaunched', event).data !== log.data.toLowerCase()) return null;
    const [data] = abi.decode([flapPoolLaunchDataType], event.data);
    if (data.tokenVersion !== 0n || data.migratorType !== 1n || data.antiSniperMode !== 0n || data.maxBuyBps !== 0n ||
        abi.encode([flapPoolLaunchDataType], [data]) !== event.data) return null;
    const token = String(event.token).toLowerCase(), creator = String(event.creator).toLowerCase();
    const poolAddress = String(data.pool).toLowerCase(), quoteToken = String(data.quoteToken).toLowerCase();
    const quoteAddress = quoteToken === ZeroAddress ? WBNB : quoteToken;
    if ([token, creator, poolAddress].includes(ZeroAddress) || new Set([token, poolAddress, quoteAddress]).size !== 3 ||
        data.ts === 0n || data.totalSupply === 0n) return null;
    return {
      token, creator, poolAddress, quoteAddress, quoteToken,
      name: String(data.name), symbol: String(data.symbol), meta: String(data.meta),
      reportedLaunchTime: String(data.ts), totalSupplyRaw: String(data.totalSupply),
    };
  } catch {
    return null;
  }
}
