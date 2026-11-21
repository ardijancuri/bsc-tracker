import { encodeBytes32String, Interface, ZeroAddress, ZeroHash } from 'ethers';
import { describe, expect, it, vi } from 'vitest';
import { FLAP_PORTAL, FOUR_HELPER, FOUR_MANAGERS, PCS_V2_FACTORY, WBNB, flapInterface, fourInterface } from '../launchpad.js';
import { poolMarketAbi } from '../nodeMarketProtocols.js';
import type { Rpc } from '../rpc.js';
import { freshConstantCloneRuntime } from './constantMetadataRecovery.js';
import { createTrendingLaunchMarketReader } from './trendingLaunchMarket.js';

const block = { number: 134803721, hash: '0x' + 'a'.repeat(64), timestamp: '2026-11-21T02:00:00.000Z' };
const cat = '0x040ef664834122d2e8a50341141a757535027777';
const fxion = '0x9b8e987e6fec8cf1380c4dca7071e2c7853aeea1';
const zc = '0x63d4986c50d441ec2e55a5d6f761dafbe6eb7777';
const nflxb = '0xd6829ea836b6fa224d099d40e54b31262f874631';
const zcPool = '0x18eab0b0751d7cc03e4536c4a6f9b6392a11adde';
const ant = '0x523611ed006ef9b16f3315e36ea427fceb36ffff';
const antb = '0x38dd26788cf2d901e3abf04efe3007d459d0fc53';
const antPool = '0x243de50ddbf4762dd13e106790a3cedc3886093e';
const expiry = 4948779058;
const other = '0x' + '3'.repeat(40);

const symbolAbi = new Interface(['function symbol() view returns (string)']);
const bytesAbi = new Interface(['function symbol() view returns (bytes32)']);
const tokenTaxAbi = new Interface([
  'function mainPool() view returns (address)',
  'function getPoolStateData() view returns (uint8,uint16,uint16,uint256,uint256,uint256)',
  'function pair() view returns (address)',
  'function feeRateBuy() view returns (uint256)',
  'function feeRateSell() view returns (uint256)',
]);
const managerAbi = new Interface([
  'function _tokenInfos(address token) view returns (address,address,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256)',
]);

type Rule = { to: string; data: string; result: string };
function rule(to: string, abi: Interface, method: string, values: unknown[], args: unknown[] = []): Rule {
  return { to, data: abi.encodeFunctionData(method, args), result: abi.encodeFunctionResult(method, values) };
}
function mock(rules: Rule[], codeAt?: string) {
  const wrapped = vi.fn(async (method: string, params: unknown[]) => {
    expect(params[1]).toEqual({ blockHash: block.hash, requireCanonical: true });
    if (method === 'eth_getCode' && params[0] === codeAt) return freshConstantCloneRuntime('flap');
    expect(method).toBe('eth_call');
    const { to, data } = params[0] as { to: string; data: string };
    const result = rules.find(x => x.to === to && x.data === data);
    if (!result) throw new Error('State unavailable in test');
    return result.result;
  });
  return { rpc: wrapped, read: createTrendingLaunchMarketReader(wrapped as Rpc) };
}
function flap(token: string, quote: string, { status = 1, version = 6, pool = ZeroAddress, buy = 100, sell = 100 } = {}) {
  return rule(FLAP_PORTAL, flapInterface, 'getTokenV8Safe', [[
    status, 1, 1, 1, version, 1, 1, 1, 1, quote, true, ZeroHash, buy, sell, pool, 1, 0, 0,
  ]], [token]);
}
function v2(token: string, quote: string, pair: string, factory = PCS_V2_FACTORY) {
  return [
    rule(PCS_V2_FACTORY, poolMarketAbi, 'getPair', [pair], [token, quote]),
    rule(pair, poolMarketAbi, 'factory', [factory]),
    rule(pair, poolMarketAbi, 'token0', [token]),
    rule(pair, poolMarketAbi, 'token1', [quote]),
  ];
}
function zcRules(expiresAt = expiry) {
  return [
    flap(zc, nflxb, { status: 4, pool: zcPool, buy: 0 }),
    rule(nflxb, symbolAbi, 'symbol', ['NFLXB']),
    rule(zc, tokenTaxAbi, 'mainPool', [zcPool]),
    rule(zc, tokenTaxAbi, 'getPoolStateData', [2, 0, 100, 0, expiresAt, 0]),
  ];
}
function antRules() {
  const manager = FOUR_MANAGERS[1];
  return [
    rule(FOUR_HELPER, fourInterface, 'getTokenInfo', [2, manager, antb, 1, 100, 0, 1, 1, 1, 1, 1, true], [ant]),
    rule(manager, managerAbi, '_tokenInfos', [ant, antb, 9n << 10n, 0, 0, 0, 0, 1, 0, 0, 0, 0, 3], [ant]),
    rule(antb, symbolAbi, 'symbol', ['ANTB']),
    rule(ant, tokenTaxAbi, 'pair', [antPool]),
    rule(ant, tokenTaxAbi, 'feeRateBuy', [1]),
    rule(ant, tokenTaxAbi, 'feeRateSell', [1]),
  ];
}

describe('Trending Tokens launch market details', () => {
  it('reads the FXIon quote and 1%/1% curve tax without a priced observation', async () => {
    const { read, rpc } = mock([flap(cat, fxion), rule(fxion, symbolAbi, 'symbol', ['FXIon'])]);
    await expect(read({ address: cat, protocol: 'flap' }, block)).resolves.toEqual({
      quoteSymbol: 'FXIon', buyTaxBps: 100, sellTaxBps: 100,
    });
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it('reads explicit zero rates for supported untaxed native curves', async () => {
    const { read, rpc } = mock([flap(cat, ZeroAddress, { version: 2, buy: 0, sell: 0 })]);
    await expect(read({ address: cat, protocol: 'flap', quoteAddress: WBNB }, block)).resolves.toEqual({
      quoteSymbol: 'BNB', buyTaxBps: 0, sellTaxBps: 0,
    });
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('supports a legacy bytes32 quote symbol and declines malformed symbol text', async () => {
    const legacy = mock([flap(cat, fxion), rule(fxion, bytesAbi, 'symbol', [encodeBytes32String('FXIon')])]);
    await expect(legacy.read({ address: cat, protocol: 'flap' }, block)).resolves.toMatchObject({ quoteSymbol: 'FXIon' });
    const unsafe = mock([flap(cat, fxion), rule(fxion, symbolAbi, 'symbol', ['<FXIon>'])]);
    await expect(unsafe.read({ address: cat, protocol: 'flap' }, block)).resolves.toEqual({ buyTaxBps: 100, sellTaxBps: 100 });
  });

  it('reads zc effective 0%/1% tax from its exact graduated market', async () => {
    const { read, rpc } = mock(zcRules(), zc);
    await expect(read({ address: zc, protocol: 'flap', quoteAddress: nflxb, marketProtocol: 'pcs_v2', marketAddress: zcPool }, block))
      .resolves.toEqual({ quoteSymbol: 'NFLXB', buyTaxBps: 0, sellTaxBps: 100, expiresAtSeconds: expiry });
    expect(rpc).toHaveBeenCalledTimes(5);
  });

  it('rejects a mismatched market or quote and elapsed Flap rates', async () => {
    const { read } = mock(zcRules(1), zc);
    await expect(read({ address: zc, protocol: 'flap', marketProtocol: 'pcs_v2', marketAddress: zcPool }, block))
      .resolves.toEqual({ quoteSymbol: 'NFLXB' });
    await expect(read({ address: zc, protocol: 'flap', marketProtocol: 'pcs_v2', marketAddress: other }, block))
      .resolves.toEqual({ quoteSymbol: 'NFLXB' });
    await expect(read({ address: zc, protocol: 'flap', quoteAddress: other }, block)).resolves.toEqual({});
  });

  it('authenticates a missing Flap market against the PancakeSwap factory and pool', async () => {
    const { read } = mock([...zcRules(), ...v2(zc, nflxb, zcPool)], zc);
    await expect(read({ address: zc, protocol: 'flap' }, block))
      .resolves.toEqual({ quoteSymbol: 'NFLXB', buyTaxBps: 0, sellTaxBps: 100, expiresAtSeconds: expiry });
    const mismatch = mock([...zcRules(), ...v2(zc, nflxb, zcPool, other)], zc);
    await expect(mismatch.read({ address: zc, protocol: 'flap' }, block)).resolves.toEqual({ quoteSymbol: 'NFLXB' });
  });

  it('reads Four.Meme V2 tax for its migrated ANTB PancakeSwap pair', async () => {
    const { read } = mock([...antRules(), ...v2(ant, antb, antPool)]);
    await expect(read({ address: ant, protocol: 'fourmeme' }, block))
      .resolves.toEqual({ quoteSymbol: 'ANTB', buyTaxBps: 100, sellTaxBps: 100 });
    await expect(read({ address: ant, protocol: 'fourmeme', quoteAddress: antb, marketAddress: other, marketProtocol: 'pcs_v2' }, block))
      .resolves.toEqual({ quoteSymbol: 'ANTB' });
  });

  it('fails closed for unsupported or missing controller data', async () => {
    const { read, rpc } = mock([]);
    await expect(read({ address: cat, protocol: 'flap' }, block)).resolves.toEqual({});
    expect(rpc).toHaveBeenCalledTimes(2);
  });
});
