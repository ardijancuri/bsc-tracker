import { describe, expect, it } from 'vitest';
import { ZeroAddress } from 'ethers';
import { decodeFlapState, decodeFourState, flapInterface, fourInterface, fourV1Interface, FOUR_MANAGERS, FLAP_PORTAL, graduationPool, launchTransition, migrationPair, pairInterface, parseLaunchLog, PCS_V2_FACTORY, PCS_V3_FACTORY } from './launchpad.js';
const token = '0x1111111111111111111111111111111111111111', quote = '0x2222222222222222222222222222222222222222', pair = '0x3333333333333333333333333333333333333333';
function four(version: number, funds: bigint, max: bigint, graduated = false, quoteAddress = ZeroAddress) {
  return fourInterface.encodeFunctionResult('getTokenInfo', [version, FOUR_MANAGERS[version - 1], quoteAddress, 0, 0, 0, 1725000000, 0, 0, funds, max, graduated]);
}
function flap(status: number, progress: bigint, method: 'getTokenV8Safe' | 'getTokenV7' = 'getTokenV8Safe') {
  const data: unknown[] = [status, 0, 0, 0, 4, 0, 0, 0, 667000000n * 10n ** 18n, quote, true, `0x${'0'.repeat(64)}`, 500];
  if (method === 'getTokenV8Safe') data.push(700);
  data.push(pair, progress, 0, 0);
  return flapInterface.encodeFunctionResult(method, [data]);
}
describe('official launch interfaces', () => {
  it.each([1, 2])('supports classic Four.meme V%i and its own graduation target', version => {
    expect(decodeFourState(four(version, 89n, 100n))?.stage).toBe('bonding');
    expect(decodeFourState(four(version, 9n, 10n, false, quote))).toMatchObject({ platform: 'fourmeme', stage: 'near_graduation', progress: 90, quoteAddress: quote });
    expect(decodeFourState(four(version, 1n, 0n, true))?.stage).toBe('graduated');
    expect(decodeFourState(four(version, 1n, 0n))?.progress).toBeNull();
  });
  it('rejects an arbitrary token even when its address resembles a launchpad token', () => {
    expect(decodeFourState(fourInterface.encodeFunctionResult('getTokenInfo', [0, ZeroAddress, ZeroAddress, 0, 0, 0, 0, 0, 0, 0, 0, false]))).toBeNull();
    expect(decodeFlapState(flap(0, 0n))).toBeNull();
  });
  it.each(['getTokenV8Safe', 'getTokenV7'] as const)('reads Flap %s progress, quote and confirmed status', method => {
    expect(decodeFlapState(flap(1, 900000000000000000n, method), method)).toMatchObject({ stage: 'near_graduation', progress: 90, quoteAddress: quote });
    expect(decodeFlapState(flap(1, 899900000000000000n, method), method)?.stage).toBe('bonding');
    expect(decodeFlapState(flap(4, 0n, method), method)).toMatchObject({ stage: 'graduated', progress: 100, launchedAt: null });
  });
  it('does not notify for tokens discovered already near graduation or graduated', () => {
    expect(launchTransition(null, 'graduated')).toBeNull();
    expect(launchTransition(null, 'near_graduation')).toBeNull();
    expect(launchTransition('graduated', 'graduated')).toBeNull();
    expect(launchTransition('unavailable', 'graduated')).toBeNull();
    expect(launchTransition('bonding', 'near_graduation')).toBe('near_graduation');
    expect(launchTransition('near_graduation', 'graduated')).toBe('graduated');
  });
  it('uses the separate pool ID for Infinity instead of a vault', () => {
    const poolId = `0x${'a'.repeat(64)}`;
    expect(graduationPool(pair, poolId, 3)).toBe(poolId);
    expect(graduationPool(pair, null, 3)).toBeNull();
    expect(graduationPool(pair, null, 2)).toBeNull();
    expect(graduationPool(pair, null, 0)).toBe(pair);
  });
  it('accepts manager and Portal events only for tokens already tracked', () => {
    const event = flapInterface.encodeEventLog(flapInterface.getEvent('LaunchedToDEX')!, [token, pair, 100, 2]);
    expect(parseLaunchLog({ address: FLAP_PORTAL, ...event }, new Set([token]))).toMatchObject({ token, kind: 'graduated', pool: pair });
    expect(parseLaunchLog({ address: pair, ...event }, new Set([token]))).toBeNull();
    expect(parseLaunchLog({ address: FLAP_PORTAL, ...event }, new Set())).toBeNull();
    for (const abi of [fourInterface, fourV1Interface]) {
      const args = [quote, token, 1, 'Name', 'SYM', 100, 1725000000];
      if (abi === fourInterface) args.push(1);
      const created = abi.encodeEventLog(abi.getEvent('TokenCreate')!, args);
      expect(parseLaunchLog({ address: FOUR_MANAGERS[0], ...created }, new Set([token]))?.kind).toBe('created');
    }
  });
  it('resolves V2/V3 migration pools from the trusted factory and matching quote', () => {
    const v2 = pairInterface.encodeEventLog(pairInterface.getEvent('PairCreated')!, [token, quote, pair, 1]);
    const v3 = pairInterface.encodeEventLog(pairInterface.getEvent('PoolCreated')!, [token, quote, 2500, 50, pair]);
    expect(migrationPair([{ address: PCS_V2_FACTORY, ...v2 }], token, quote)).toBe(pair);
    expect(migrationPair([{ address: PCS_V3_FACTORY, ...v3 }], token, quote)).toBe(pair);
    expect(migrationPair([{ address: pair, ...v2 }], token, quote)).toBeNull();
    expect(migrationPair([{ address: PCS_V2_FACTORY, ...v2 }], token, token)).toBeNull();
  });
});
