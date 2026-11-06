import { Interface, ZeroAddress, ZeroHash } from 'ethers';
import { describe, expect, it, vi } from 'vitest';
import { quoteLaunchpadBuy } from './walletBuyLaunchpads';

const token = '0x1111111111111111111111111111111111111111';
const wallet = '0x2222222222222222222222222222222222222222';
const quoteToken = '0x3333333333333333333333333333333333333333';
const fourHelper = '0xf251f83e40a78868fcfa3fa4599dad6494e46034';
const fourV1 = '0xec4549cadce5da21df6e6422d448034b5233bfbc';
const fourV2 = '0x5c952063c7fc8610ffdb798152d69f0b9550762b';
const portal = '0xe2ce6ab80874fa9fa2aae65d277dd6b8e65c9de0';
const poolPortal = '0x000042108465206185a077edc3f3fd2b49060000';
const pool = '0x4444444444444444444444444444444444444444';
const budget = 10n ** 16n;
const estimated = 5n * 10n ** 22n;
const minimum = estimated * 99n / 100n;

const fixtureAbi = new Interface([
  'function getTokenInfo(address) view returns (uint256,address,address,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,bool)',
  'function tryBuy(address,uint256,uint256) view returns (address,address,uint256,uint256,uint256,uint256,uint256,uint256)',
  'function purchaseTokenAMAP(address,uint256,uint256) payable',
  'function buyTokenAMAP(address,uint256,uint256) payable',
  'function getTokenV8Safe(address) view returns ((uint8,uint256,uint256,uint256,uint8,uint256,uint256,uint256,uint256,address,bool,bytes32,uint256,uint256,address,uint256,uint8,uint8))',
  'function getLaunchToken(address) view returns ((uint8,uint8,uint8,uint8,uint8,address,uint8,uint256,uint256,address,uint8,bytes,uint256))',
  'function getPair(address,address) view returns (address)',
  'function quoteExactInput((address,address,uint256)) returns (uint256)',
  'function swapExactInput((address,address,uint256,uint256,bytes)) payable returns (uint256)',
]);

interface QuoteFixture {
  version?: bigint;
  manager?: string;
  helperTarget?: string;
  fourQuote?: string;
  sentValue?: bigint;
  migrated?: boolean;
  flapStatus?: number;
  flapQuote?: string;
  nativeConversion?: boolean;
  flapOutput?: bigint;
  flapPool?: string;
  directPool?: string;
  factoryPool?: string;
  directQuote?: string;
}

function rpcFixture({
  version = 0n,
  manager = ZeroAddress,
  helperTarget = manager,
  fourQuote = ZeroAddress,
  sentValue = budget,
  migrated = false,
  flapStatus = 0,
  flapQuote = ZeroAddress,
  nativeConversion = false,
  flapOutput = estimated,
  flapPool = ZeroAddress,
  directPool = ZeroAddress,
  factoryPool = directPool,
  directQuote = ZeroAddress,
}: QuoteFixture = {}) {
  return vi.fn(async (method: string, params: unknown[]) => {
    expect(method).toBe('eth_call');
    expect(params[1]).toBe('latest');
    const request = params[0] as { from: string; to: string; data: string };
    expect(request.from).toBe(wallet);
    const call = fixtureAbi.parseTransaction(request)!;
    const result = (name: string, values: unknown[]) => fixtureAbi.encodeFunctionResult(name, values);
    switch (call.name) {
      case 'getTokenInfo':
        expect(request.to).toBe(fourHelper);
        expect(call.args[0]).toBe(token);
        return result(call.name, [version, manager, fourQuote, 1, 100, 1, 0, 200, 400, 300, 500, migrated]);
      case 'tryBuy':
        expect(request.to).toBe(fourHelper);
        expect([...call.args]).toEqual([token, 0n, budget]);
        return result(call.name, [helperTarget, fourQuote, estimated, 10, 1, sentValue, 0, budget]);
      case 'getTokenV8Safe':
        expect(request.to).toBe(portal);
        expect(call.args[0]).toBe(token);
        return result(call.name, [[flapStatus, 1, 1, 1, 6, 0, 0, 0, 0, flapQuote, nativeConversion, ZeroHash, 0, 0, flapPool, 0, 0, 0]]);
      case 'getLaunchToken':
        expect(request.to).toBe(poolPortal);
        expect(call.args[0]).toBe(token);
        return result(call.name, [[0, 0, 1, 0, directQuote === ZeroAddress ? 0 : 1, directQuote, 4, 1, 0, directPool, 0, '0x', 1]]);
      case 'getPair':
        expect(request.to).toBe('0xca143ce32fe78f1f7019d7d551a6402fc5350c73');
        expect(call.args[0]).toBe(token);
        expect(call.args[1].toLowerCase()).toBe('0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c');
        return result(call.name, [factoryPool]);
      case 'quoteExactInput':
        expect(request.to).toBe(directPool === ZeroAddress ? portal : poolPortal);
        expect([...call.args[0]]).toEqual([ZeroAddress, token, budget]);
        return result(call.name, [flapOutput]);
      default:
        throw new Error('Unexpected request');
    }
  });
}

describe('launchpad buy quotes', () => {
  it.each([[1n, fourV1, 'purchaseTokenAMAP'], [2n, fourV2, 'buyTokenAMAP']])(
    'encodes the canonical Four.Meme V%s minimum and exact native input',
    async (version, manager, method) => {
      const result = await quoteLaunchpadBuy({ token, wallet, value: budget, rpc: rpcFixture({ version, manager }) });
      expect(result).toMatchObject({ kind: 'fourmeme', estimatedOutput: estimated });
      expect(result!.buildData(minimum)).toEqual({
        to: manager,
        value: budget,
        data: fixtureAbi.encodeFunctionData(method, [token, budget, minimum]),
      });
      expect(() => result!.buildData(0n)).toThrow('Invalid minimum token amount');
    },
  );

  it.each([false, true])('encodes an exact Flap buy with native conversion %s', async nativeConversion => {
    const rpc = rpcFixture({ flapStatus: 1, nativeConversion, flapQuote: nativeConversion ? quoteToken : ZeroAddress });
    const result = await quoteLaunchpadBuy({ token, wallet, value: budget, rpc });
    expect(result).toMatchObject({ kind: 'flap', estimatedOutput: estimated });
    expect(result!.buildData(minimum)).toEqual({
      to: portal,
      value: budget,
      data: fixtureAbi.encodeFunctionData('swapExactInput', [[ZeroAddress, token, budget, minimum, '0x']]),
    });
    expect(() => result!.buildData(estimated + 1n)).toThrow('Invalid minimum token amount');
  });

  it.each([
    { fixture: { flapStatus: 4, flapPool: pool, flapQuote: quoteToken, nativeConversion: true }, destination: portal },
    { fixture: { directPool: pool }, destination: poolPortal },
  ])('uses the authenticated Flap DEX registry and exact minimum for $destination', async ({ fixture, destination }) => {
    const result = await quoteLaunchpadBuy({ token, wallet, value: budget, rpc: rpcFixture(fixture) });
    expect(result).toMatchObject({ kind: 'flap', estimatedOutput: estimated });
    expect(result!.buildData(minimum)).toEqual({
      to: destination,
      value: budget,
      data: fixtureAbi.encodeFunctionData('swapExactInput', [[ZeroAddress, token, budget, minimum, '0x']]),
    });
  });

  it.each([
    { version: 2n, manager: fourV1 },
    { version: 2n, manager: fourV2, helperTarget: fourV1 },
    { version: 2n, manager: fourV2, sentValue: budget + 1n },
    { version: 2n, manager: fourV2, fourQuote: quoteToken },
    { version: 2n, manager: fourV2, migrated: true },
    { flapStatus: 1, flapQuote: quoteToken },
    { flapStatus: 1, flapOutput: 0n },
    { flapStatus: 4 },
    { flapStatus: 4, flapPool: pool, flapQuote: quoteToken },
    { directPool: pool, factoryPool: ZeroAddress },
    { directPool: pool, directQuote: quoteToken },
  ])('excludes unsupported or out-of-budget quotes %o', async fixture => {
    expect(await quoteLaunchpadBuy({ token, wallet, value: budget, rpc: rpcFixture(fixture) })).toBeNull();
  });
});
