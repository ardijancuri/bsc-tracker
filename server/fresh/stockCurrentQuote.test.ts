import { describe, expect, it, vi } from 'vitest';
import { keccak256 } from 'ethers';
import type { Rpc } from '../rpc.js';
import { WBNB } from '../launchpad.js';
import { FRESH_STOCK_QUOTE_TOKEN, FRESH_WOOFI_BSC_POOL } from './stockQuote.js';
import { freshStockCurrentQuoteInterface as abi, readFreshStockCurrentRawQuote } from './stockCurrentQuote.js';

const block = { number: 129204900, hash: `0x${'a'.repeat(64)}`, timestamp: '2026-10-22T21:50:00.000Z' };
function fixture(options: { decimals?: number; nativeDecimals?: number; chain?: string; code?: string; zero?: boolean; unavailable?: boolean; dirty?: boolean } = {}) {
  return vi.fn(async (method: string, params: any[]) => {
    if (method === 'eth_chainId') { expect(params).toEqual([]); return options.chain ?? '0x38'; }
    expect(params[1]).toEqual({ blockHash: block.hash, requireCanonical: true });
    if (method === 'eth_getCode') { expect(params[0]).toBe(FRESH_WOOFI_BSC_POOL); return options.code ?? '0x60006000'; }
    expect(method).toBe('eth_call');
    const call = params[0], parsed = abi.parseTransaction(call)!;
    if (parsed.name === 'decimals') return abi.encodeFunctionResult('decimals', [call.to === WBNB ? options.nativeDecimals ?? 18 : options.decimals ?? 6]);
    expect(call.to).toBe(FRESH_WOOFI_BSC_POOL); expect(parsed.name).toBe('query');
    expect(parsed.args[0].toLowerCase()).toBe(FRESH_STOCK_QUOTE_TOKEN); expect(parsed.args[1].toLowerCase()).toBe(WBNB);
    expect(parsed.args[2]).toBe(10n ** BigInt(options.decimals ?? 6));
    if (options.unavailable) throw Error('current_state_unavailable');
    return abi.encodeFunctionResult('query', [options.zero ? 0n : 123456789n]) + (options.dirty ? '00' : '');
  }) as unknown as Rpc;
}

describe('current official WOOFi stock conversion', () => {
  it('quotes one verified whole stock token at exact canonical current state, with reserve checks', async () => {
    const rpc = fixture(), quote = await readFreshStockCurrentRawQuote({ rpc, block });
    expect(quote).toMatchObject({ version: 1, kind: 'woofi_current_query', chainId: 56, venue: FRESH_WOOFI_BSC_POOL,
      quoteToken: FRESH_STOCK_QUOTE_TOKEN, nativeToken: WBNB, target: block, source: block, quoteDecimals: 6, nativeDecimals: 18,
      quoteRaw: '1000000', nativeRaw: '123456789', venueRuntimeHash: keccak256('0x60006000') });
    expect(quote.calldataHash).toBe(keccak256(abi.encodeFunctionData('query', [FRESH_STOCK_QUOTE_TOKEN, WBNB, 1000000n])));
    expect(rpc).toHaveBeenCalledTimes(5); expect(JSON.stringify(quote)).not.toMatch(/receipt|logs|tryQuery/);
  });
  it.each([0, 18, 77])('reads current %s precision without a cached 18-decimal assumption', async decimals => {
    expect((await readFreshStockCurrentRawQuote({ rpc: fixture({ decimals }), block })).quoteRaw).toBe(String(10n ** BigInt(decimals)));
  });
  it.each([
    ['wrong chain', { chain: '0x1' }, 'stock_current_quote_chain_unverified'],
    ['missing venue code', { code: '0x' }, 'stock_current_quote_venue_unverified'],
    ['unrepresentable precision', { decimals: 78 }, 'stock_current_quote_precision_unverified'],
    ['wrong native precision', { nativeDecimals: 6 }, 'stock_current_quote_precision_unverified'],
    ['zero quote', { zero: true }, 'stock_current_quote_unavailable'],
    ['dirty quote response', { dirty: true }, 'stock_current_quote_response_invalid'],
  ] as const)('rejects %s', async (_label, options, error) => {
    await expect(readFreshStockCurrentRawQuote({ rpc: fixture(options), block })).rejects.toThrow(error);
  });
  it('does not retry unavailable state, query without reserves, latest state or historical settlements', async () => {
    const rpc = fixture({ unavailable: true });
    await expect(readFreshStockCurrentRawQuote({ rpc, block })).rejects.toThrow('current_state_unavailable');
    expect(rpc).toHaveBeenCalledTimes(5);
    expect((rpc as any).mock.calls.map(([method]: any[]) => method)).toEqual(['eth_chainId', 'eth_getCode', 'eth_call', 'eth_call', 'eth_call']);
  });
  it('rejects invalid canonical target before requesting any state', async () => {
    const rpc = fixture();
    await expect(readFreshStockCurrentRawQuote({ rpc, block: { ...block, hash: 'latest' } })).rejects.toThrow('stock_current_quote_block_invalid');
    expect(rpc).not.toHaveBeenCalled();
  });
});
