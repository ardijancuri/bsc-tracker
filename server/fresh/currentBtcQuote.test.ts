import {factoryCode,pairCode} from './currentQuote.fixture.js';
import { Interface } from 'ethers';
import { describe, expect, it, vi } from 'vitest';
import type { Rpc } from '../rpc.js';
import { FLAP_PORTAL, FOUR_HELPER, PCS_V2_FACTORY, WBNB, flapInterface } from '../launchpad.js';
import { oracleMarketAbi, TRUSTED_QUOTE_FEEDS } from '../nodeMarketProtocols.js';
import { freshCurrentQuote } from './pricing.js';
import { FRESH_BTCB_NATIVE_PAIR, FRESH_BTCB_QUOTE, readFreshBtcNativeConversion } from './currentBtcQuote.js';
import {createFreshHistoricalValuationOptions} from './valuationContext.js';

// Public deployed PCS V2 template, also used by the retained historical route.
// Tests use these exact bytes without a node, network request or ignored file.
const token = '0x' + '7'.repeat(40), zero = '0x' + '0'.repeat(40), hash = '0x' + 'a'.repeat(64);
const abi = new Interface(['function decimals() view returns(uint8)', 'function factory() view returns(address)',
  'function token0() view returns(address)', 'function token1() view returns(address)',
  'function getReserves() view returns(uint112 reserve0,uint112 reserve1,uint32 timestamp)',
  'function totalSupply() view returns(uint256)', 'function name() view returns(string)', 'function symbol() view returns(string)']);
function fixture(options: { chain?: string; badCode?: 'factory' | 'pair'; badIdentity?: 'factory' | 'token0' | 'token1';
  quoteDecimals?: number; nativeDecimals?: number; empty?: boolean; malformed?: boolean } = {}) {
  const block = { number: 1000, hash, timestamp: new Date().toISOString() }, quoteDecimals = options.quoteDecimals ?? 18;
  const quoteRaw = 5n * 10n ** BigInt(quoteDecimals > 36 ? 18 : quoteDecimals), nativeRaw = 500n * 10n ** 18n;
  const rpc = vi.fn(async (rpcMethod: string, params: unknown[]) => {
    if (rpcMethod === 'eth_chainId') return options.chain ?? '0x38';
    expect(params[1]).toEqual({ blockHash: hash, requireCanonical: true });
    if (rpcMethod === 'eth_getCode') {
      if (params[0] === PCS_V2_FACTORY) return options.badCode === 'factory' ? '0x00' : factoryCode;
      expect(params[0]).toBe(FRESH_BTCB_NATIVE_PAIR);
      return options.badCode === 'pair' ? '0x00' : pairCode;
    }
    expect(rpcMethod).toBe('eth_call');
    const call = params[0] as { to: string; data: string }, to = call.to.toLowerCase();
    if (to === FOUR_HELPER) throw Error('not_fourmeme');
    if (to === FLAP_PORTAL) {
      const method = flapInterface.parseTransaction(call)!.name;
      return flapInterface.encodeFunctionResult(method, [[1, 10n ** BigInt(quoteDecimals), 5n * 10n ** 25n, 60_000_000n, 6,
        60_000_000_000_000_000n, 107036751n * 10n ** 18n, 66370312712296875000000000n, 8n * 10n ** 26n,
        FRESH_BTCB_QUOTE, true, hash, 100, 100, zero, 1n, 0, 0]]);
    }
    const feed = TRUSTED_QUOTE_FEEDS[WBNB];
    if (to === feed.feed) {
      const method = oracleMarketAbi.parseTransaction(call)!.name;
      if (method === 'decimals') return oracleMarketAbi.encodeFunctionResult(method, [8]);
      if (method === 'description') return oracleMarketAbi.encodeFunctionResult(method, [feed.description]);
      return oracleMarketAbi.encodeFunctionResult(method, [1n, 600n * 10n ** 8n, 1n, BigInt(Math.floor(Date.parse(block.timestamp) / 1000)), 1n]);
    }
    const method = abi.parseTransaction(call)!.name;
    if (to === FRESH_BTCB_NATIVE_PAIR) {
      if (options.malformed && method === 'getReserves') return '0x00';
      if (method === 'factory') return abi.encodeFunctionResult(method, [options.badIdentity === method ? token : PCS_V2_FACTORY]);
      if (method === 'token0') return abi.encodeFunctionResult(method, [options.badIdentity === method ? token : FRESH_BTCB_QUOTE]);
      if (method === 'token1') return abi.encodeFunctionResult(method, [options.badIdentity === method ? token : WBNB]);
      if (method === 'getReserves') return abi.encodeFunctionResult(method, [options.empty ? 0n : quoteRaw, nativeRaw, 1]);
    }
    if (method === 'decimals') return abi.encodeFunctionResult(method, [to === FRESH_BTCB_QUOTE ? quoteDecimals : to === WBNB ? options.nativeDecimals ?? 18 : 18]);
    if (to === token && method === 'totalSupply') return abi.encodeFunctionResult(method, [10n ** 27n]);
    if (to === token && method === 'name') return abi.encodeFunctionResult(method, ['Current BTCB token']);
    if (to === token && method === 'symbol') return abi.encodeFunctionResult(method, ['NEW']);
    throw Error('unexpected_current_read');
  }) as Rpc & ReturnType<typeof vi.fn>;
  return { rpc, block, quoteRaw, nativeRaw };
}

describe('current Flap BTCB conversion through exact PCS V2 reserves', () => {
  it('values an old observation only with original-block RPC/code/precision/feed proof and an authenticated historical context',async()=>{
    const f=fixture();f.block.timestamp='2026-10-20T00:00:00.000Z';
    await expect(readFreshBtcNativeConversion(f)).rejects.toThrow('btcb_quote_current_block_required');
    const rpc=(async<T>(method:string,params:unknown[])=>method==='eth_getBlockByNumber'?{number:'0x3e8',hash,timestamp:'0x'+(Date.parse(f.block.timestamp)/1000).toString(16)} as T:f.rpc<T>(method,params)) as Rpc;
    const options=await createFreshHistoricalValuationOptions(rpc,f.block),conversion=await readFreshBtcNativeConversion(options);
    expect(conversion.observedAt).toBe(f.block.timestamp);expect(conversion.nativeRaw).toBe(f.nativeRaw);
    const quote=await freshCurrentQuote(token,options);expect(quote).toMatchObject({observationContext:'historical_block',observedAt:f.block.timestamp,blockHash:hash,blockNumber:1000});
  });
  it('derives the official BTCB/WBNB pair and authenticates its exact template and raw reserves', async () => {
    const f = fixture(), result = await readFreshBtcNativeConversion(f);
    expect(FRESH_BTCB_NATIVE_PAIR).toBe('0x61eb789d75a95caa3ff50ed7e47b96c132fec082');
    expect(result).toMatchObject({ quoteDecimals: 18, quoteRaw: f.quoteRaw, nativeRaw: f.nativeRaw, observedAt: f.block.timestamp,
      identity: { factory: PCS_V2_FACTORY, pair: FRESH_BTCB_NATIVE_PAIR, quoteToken: FRESH_BTCB_QUOTE, nativeToken: WBNB } });
    expect(f.rpc.mock.calls).toHaveLength(9);
  });

  it.each([6, 18])('converts the normalized Flap price using current %i-decimal quote precision without a peg', async quoteDecimals => {
    const f = fixture({ quoteDecimals }), result = await freshCurrentQuote(token, f);
    // 6e-11 BTCB/token * 100 BNB/BTCB * $600/BNB. A BTC peg is irrelevant.
    expect(result).toMatchObject({ priceUsd: '0.0000036', marketCapUsd: '3600', observedAt: f.block.timestamp, blockHash: hash,
      market: { protocol: 'flap', address: FLAP_PORTAL, quoteAddress: FRESH_BTCB_QUOTE,
        identity: { quoteConversion: { pair: FRESH_BTCB_NATIVE_PAIR, quoteDecimals } } } });
  });

  it.each(['factory', 'pair'] as const)('rejects an unauthenticated %s runtime', async badCode => {
    await expect(readFreshBtcNativeConversion(fixture({ badCode }))).rejects.toThrow('btcb_quote_code_invalid');
  });
  it.each(['factory', 'token0', 'token1'] as const)('rejects contradictory pair %s storage', async badIdentity => {
    await expect(readFreshBtcNativeConversion(fixture({ badIdentity }))).rejects.toThrow('btcb_quote_pair_identity_invalid');
  });
  it('rejects a wrong chain, empty reserve, invalid precision or malformed return', async () => {
    await expect(readFreshBtcNativeConversion(fixture({ chain: '0x1' }))).rejects.toThrow('btcb_quote_chain_invalid');
    await expect(readFreshBtcNativeConversion(fixture({ empty: true }))).rejects.toThrow('btcb_quote_pool_empty');
    await expect(readFreshBtcNativeConversion(fixture({ quoteDecimals: 37 }))).rejects.toThrow('btcb_quote_precision_invalid');
    await expect(readFreshBtcNativeConversion(fixture({ nativeDecimals: 17 }))).rejects.toThrow('btcb_quote_precision_invalid');
    await expect(readFreshBtcNativeConversion(fixture({ malformed: true }))).rejects.toThrow('btcb_quote_state_invalid');
  });
  it.each([-31_000, 6000])('refuses historical/future block time offset %i before making any RPC', async offset => {
    const f = fixture(); f.block.timestamp = new Date(Date.now() + offset).toISOString();
    await expect(readFreshBtcNativeConversion(f)).rejects.toThrow('btcb_quote_current_block_required');
    expect(f.rpc).not.toHaveBeenCalled();
  });
  it('does not fall back to another block when canonical state is unavailable', async () => {
    const f = fixture(), original = f.rpc;
    const rpc = vi.fn(async (method: string, params: unknown[]) => {
      if (method === 'eth_call') throw Error('canonical_state_unavailable');
      return original(method, params);
    }) as Rpc;
    await expect(readFreshBtcNativeConversion({ ...f, rpc })).rejects.toThrow('canonical_state_unavailable');
  });
});
