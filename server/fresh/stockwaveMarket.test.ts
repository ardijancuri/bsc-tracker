import { describe, expect, it, vi } from 'vitest';
import { solidityPackedKeccak256, toBeHex } from 'ethers';
import type { Rpc } from '../rpc.js';
import type { FreshLog, FreshReceipt } from './capture.js';
import {
  authenticateFreshStockwavePoolInitialization, FRESH_UNISWAP_V4_BSC_MANAGER, FRESH_UNISWAP_V4_SWAP_TOPIC,
  freshStockwavePoolId, freshStockwaveStorageSlots, historicalFreshStockwavePrice, readFreshStockwaveMarket,
  stockwavePoolManagerInterface, validFreshStockwaveMarketIdentity, type FreshStockwaveMarketIdentity,
} from './stockwaveMarket.js';

const h = (v: string) => `0x${v.repeat(64)}`, Q96 = 1n << 96n;
const token = '0xe36ae6bc18726a84db820ec49dd866145df5a149', quote = '0x02fca66c1d1afb4e2a7884261eb00f63598a7436';
const key = { currency0: quote, currency1: token, fee: 0, tickSpacing: 200, hooks: '0x5e4b06cf354bdfb306d441cad181f5768053a0cc' };
const poolId = '0x0e38433efc106f676d3fc5492de87aa79b1ae02aaf6188e3c9763042e064617c';
function fixture() {
  const log: FreshLog = { address: FRESH_UNISWAP_V4_BSC_MANAGER,
    ...stockwavePoolManagerInterface.encodeEventLog('Initialize', [poolId, quote, token, 0, 200, key.hooks, Q96, 0]),
    transactionHash: h('a'), blockHash: h('1'), blockNumber: '0x64', transactionIndex: '0x0', logIndex: '0x1' };
  const receipt: FreshReceipt = { status: '0x1', transactionHash: log.transactionHash, transactionIndex: log.transactionIndex,
    blockHash: log.blockHash, blockNumber: log.blockNumber, gasUsed: '0x1', logs: [log] };
  const identity = authenticateFreshStockwavePoolInitialization(receipt, token, poolId, quote, 0)!;
  const target = { number: 102, hash: h('3'), timestamp: '2026-10-22T19:00:00Z' };
  const canonicalHash = async (n: number) => ({ 100: h('1'), 101: h('2'), 102: h('3'), 5000: h('4') })[n] ?? null;
  return { log, receipt, identity, target, canonicalHash };
}
function swap(overrides: Partial<FreshLog> = {}): FreshLog {
  return { address: FRESH_UNISWAP_V4_BSC_MANAGER,
    ...stockwavePoolManagerInterface.encodeEventLog('Swap', [poolId, `0x${'8'.repeat(40)}`, -100n, 400n, 2n * Q96, 100000n, 13863, 0]),
    transactionHash: h('b'), blockHash: h('2'), blockNumber: '0x65', transactionIndex: '0x0', logIndex: '0x2', ...overrides };
}

describe('authenticated Stockwave Uniswap v4 market', () => {
  it('matches the genuine BSC pool ID using padded ABI PoolKey encoding', () => {
    expect(freshStockwavePoolId(key)).toBe(poolId);
    expect(solidityPackedKeccak256(['address', 'address', 'uint24', 'int24', 'address'], Object.values(key))).not.toBe(poolId);
    expect(validFreshStockwaveMarketIdentity(fixture().identity)).toBe(true);
  });

  it('rejects spoofed initialization, wrong pool assets and ambiguous initialization', () => {
    const f = fixture();
    expect(authenticateFreshStockwavePoolInitialization({ ...f.receipt, logs: [{ ...f.log, address: quote }] }, token, poolId, quote, 0)).toBeNull();
    expect(authenticateFreshStockwavePoolInitialization(f.receipt, token, h('f'), quote, 0)).toBeNull();
    expect(authenticateFreshStockwavePoolInitialization(f.receipt, token, poolId, key.hooks, 0)).toBeNull();
    expect(authenticateFreshStockwavePoolInitialization(f.receipt, token, poolId, quote, 1)).toBeNull();
    expect(authenticateFreshStockwavePoolInitialization({ ...f.receipt, logs: [f.log, { ...f.log, logIndex: '0x2' }] }, token, poolId, quote, 0)).toBeNull();
  });

  it('uses the latest canonical Swap sqrt and verified decimal inputs', async () => {
    const f = fixture(), rpc = vi.fn(async () => [swap()]) as unknown as Rpc;
    const result = await historicalFreshStockwavePrice({ ...f, rpc, tokenDecimals: 18, quoteDecimals: 18 });
    expect(result.priceQuote).toBe('0.25'); expect(result.quoteAddress).toBe(quote);
    expect(result.sqrtPriceX96).toBe(String(2n * Q96)); expect(result.lastSwap?.transactionHash).toBe(h('b'));
    expect(rpc).toHaveBeenCalledExactlyOnceWith('eth_getLogs', [{ address: FRESH_UNISWAP_V4_BSC_MANAGER,
      fromBlock: '0x64', toBlock: '0x66', topics: [FRESH_UNISWAP_V4_SWAP_TOPIC, poolId] }]);
  });

  it('exposes an exact raw ratio without assuming the quote token precision', async () => {
    const f = fixture(), rpc = vi.fn(async () => [swap()]) as unknown as Rpc;
    const result = await historicalFreshStockwavePrice({ ...f, rpc, tokenDecimals: 18 });
    expect(result.priceQuote).toBeNull(); expect(result.quoteDecimals).toBeNull(); expect(result.tokenIs0).toBe(false);
    expect(BigInt(result.rawQuoteRatio.denominator)).toBe(4n * BigInt(result.rawQuoteRatio.numerator));
  });

  it('uses Initialize only when the complete covered window contains creation', async () => {
    const f = fixture(), rpc = vi.fn(async () => []) as unknown as Rpc;
    expect((await historicalFreshStockwavePrice({ ...f, rpc, tokenDecimals: 18, quoteDecimals: 18 })).priceQuote).toBe('1');
    await expect(historicalFreshStockwavePrice({ ...f, target: { ...f.target, number: 5000, hash: h('4') }, rpc, tokenDecimals: 18 }))
      .rejects.toThrow('stockwave_market_price_window_empty');
    expect((rpc as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1]).toEqual([{ address: FRESH_UNISWAP_V4_BSC_MANAGER,
      fromBlock: `0x${(5000 - 4095).toString(16)}`, toBlock: '0x1388', topics: [FRESH_UNISWAP_V4_SWAP_TOPIC, poolId] }]);
  });

  it.each([
    ['removed log', { removed: true }], ['wrong manager', { address: quote }], ['orphan log', { blockHash: h('f') }],
    ['outside window', { blockNumber: '0x67' }], ['wrong pool', { topics: [FRESH_UNISWAP_V4_SWAP_TOPIC, h('f'), h('8')] }],
  ])('rejects %s', async (_label, changed) => {
    const f = fixture(), rpc = vi.fn(async () => [swap(changed)]) as unknown as Rpc;
    await expect(historicalFreshStockwavePrice({ ...f, rpc, tokenDecimals: 18 })).rejects.toThrow();
  });

  it('rejects contradictory order and noncanonical target headers', async () => {
    const f = fixture(), rpc = vi.fn(async () => [swap(), swap()]) as unknown as Rpc;
    await expect(historicalFreshStockwavePrice({ ...f, rpc, tokenDecimals: 18 })).rejects.toThrow('stockwave_market_log_order_invalid');
    await expect(historicalFreshStockwavePrice({ ...f, rpc, target: { ...f.target, hash: h('f') }, tokenDecimals: 18 }))
      .rejects.toThrow('stockwave_market_noncanonical');
  });

  it('reuses only exact matching retained evidence and revalidates its last log', async () => {
    const f = fixture(), rpc = vi.fn(async () => [swap()]) as unknown as Rpc;
    const prior = await historicalFreshStockwavePrice({ ...f, rpc, tokenDecimals: 18 });
    const noRpc = vi.fn(async () => { throw Error('must_not_request'); }) as unknown as Rpc;
    expect((await historicalFreshStockwavePrice({ ...f, rpc: noRpc, tokenDecimals: 18, prior })).rawQuoteRatio).toEqual(prior.rawQuoteRatio);
    expect(noRpc).not.toHaveBeenCalled();
    await expect(historicalFreshStockwavePrice({ ...f, rpc: noRpc, tokenDecimals: 18, prior: { ...prior, priceQuote: '2' } }))
      .rejects.toThrow('stockwave_market_prior_invalid');
  });

  it('reads verified slot0 and active liquidity in one canonical extsload call', async () => {
    const f = fixture(), signedTick = 0xfffffen;
    const packed = 2n * Q96 | signedTick << 160n | 5n << 184n | 100n << 208n;
    const raw = stockwavePoolManagerInterface.encodeFunctionResult('extsload', [[toBeHex(packed, 32), toBeHex(100000n, 32)]]);
    const rpc = vi.fn(async () => raw) as unknown as Rpc;
    const result = await readFreshStockwaveMarket({ ...f, rpc, block: f.target, tokenDecimals: 18, quoteDecimals: 18 });
    expect(result).toMatchObject({ priceQuote: '0.25', quoteAddress: quote, tick: -2, protocolFee: 5, lpFee: 100, liquidityRaw: '100000',
      virtualQuoteLiquidity: '0.00000000000005' });
    expect(rpc).toHaveBeenCalledExactlyOnceWith('eth_call', [{ to: FRESH_UNISWAP_V4_BSC_MANAGER,
      data: stockwavePoolManagerInterface.encodeFunctionData('extsload', [freshStockwaveStorageSlots(poolId)]) }, { blockHash: f.target.hash, requireCanonical: true }]);
    const withoutPrecision = await readFreshStockwaveMarket({ ...f, rpc, block: f.target, tokenDecimals: 18 });
    expect(withoutPrecision.priceQuote).toBeNull(); expect(withoutPrecision.virtualQuoteLiquidity).toBeNull();
  });

  it('rejects zero liquidity, unknown slot layout bits and unavailable state without latest retry', async () => {
    const f = fixture();
    for (const [slot0, liquidity] of [[Q96, 0n], [Q96 | 1n << 240n, 1n], [Q96, 1n << 200n]]) {
      const rpc = vi.fn(async () => stockwavePoolManagerInterface.encodeFunctionResult('extsload', [[toBeHex(slot0, 32), toBeHex(liquidity, 32)]])) as unknown as Rpc;
      await expect(readFreshStockwaveMarket({ ...f, rpc, block: f.target, tokenDecimals: 18 })).rejects.toThrow('stockwave_market_state_invalid');
      expect(rpc).toHaveBeenCalledTimes(1);
    }
    const rpc = vi.fn(async () => { throw Error('state_unavailable'); }) as unknown as Rpc;
    await expect(readFreshStockwaveMarket({ ...f, rpc, block: f.target, tokenDecimals: 18 })).rejects.toThrow('state_unavailable');
    expect(rpc).toHaveBeenCalledTimes(1);
  });
});
