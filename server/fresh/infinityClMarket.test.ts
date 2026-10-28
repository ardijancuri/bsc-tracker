import { describe, expect, it, vi } from 'vitest';
import { toBeHex } from 'ethers';
import type { Rpc } from '../rpc.js';
import type { FreshLog, FreshReceipt } from './capture.js';
import { WBNB } from '../launchpad.js';
import { INFINITY_CL } from '../nodeMarketProtocols.js';
import { authenticateFreshInfinityClInitialization, freshInfinityClInterface as abi, freshInfinityClPoolId, historicalFreshInfinityClPrice, readFreshInfinityClMarket,
  validFreshInfinityClMarketIdentity, type FreshInfinityClMarketIdentity, type FreshInfinityClPoolKey } from './infinityClMarket.js';

const actualInitialization = {"blockHash":"0xb494289cfd34fea2df99cc3e731c0b219dd37187114ac4aa07a6fb2c0ac039bd","blockNumber":"0x7bdbb84","contractAddress":null,"cumulativeGasUsed":"0x8b52bc","effectiveGasPrice":"0x2faf080","from":"0xce88d2a3c616970be5934abd7e8c8bb3092d2d7b","gasUsed":"0x20076","logs":[{"address":"0xa0ffb9c1ce1fe56963b0321b32e7a0302114058b","topics":["0x426cc62fe6a33a40ba2788c2c87a9c34ee4582b95bc9fa5a7bb7ae70b750b99c","0xd66a832bd4586af260a8143221702fd06fb5b1d948345d26cfefd1374595c0a6","0x0000000000000000000000000000000000000000000000000000000000000000","0x00000000000000000000000070208e8c5b31dc9162ed9cd993eee29d73bbb8c2"],"data":"0x0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000006400000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000001c86f7a9b727921e80b34921f377000000000000000000000000000000000000000000000000000000000002b709","blockNumber":"0x7bdbb84","transactionHash":"0x5c6815054f004db5c634b0b81b606be8e04b62aacf5cad24534be02f41e6f721","transactionIndex":"0x49","blockHash":"0xb494289cfd34fea2df99cc3e731c0b219dd37187114ac4aa07a6fb2c0ac039bd","blockTimestamp":"0x6adf1f60","logIndex":"0xed","removed":false}],"logsBloom":"0x00000000000000000000000000000000000000000000000000000000000020100000000000000000000000002000000000000000000000000000000000000000000000100000000000000010000000000000000000000000000000000000000000000000020000000000000000000800000000000000080000000000000000000000000000000000000002000000000000000000000000000000008000000000000008000000000000000080000000000000000000000000000000000000000000000000000000000000000000000000000000000000200000000000000020010000000000000000000000000000000000000000000000000000000000000000","status":"0x1","to":"0xa0ffb9c1ce1fe56963b0321b32e7a0302114058b","transactionHash":"0x5c6815054f004db5c634b0b81b606be8e04b62aacf5cad24534be02f41e6f721","transactionIndex":"0x49","type":"0x2"} as unknown as FreshReceipt;
const token = '0x70208e8c5b31dc9162ed9cd993eee29d73bbb8c2', pool = '0xd66a832bd4586af260a8143221702fd06fb5b1d948345d26cfefd1374595c0a6';
const hash = (n: number) => toBeHex(n, 32), Q96 = 1n << 96n, native = '0x' + '0'.repeat(40);
const target = { number: 1000, hash: hash(1000), timestamp: '2026-10-26T10:20:37.000Z' };
function fixture() {
  const actual = authenticateFreshInfinityClInitialization(actualInitialization, token, pool)!;
  const identity: FreshInfinityClMarketIdentity = { ...actual, initial: { sqrtPriceX96: String(Q96), tick: 0, blockNumber: 900, blockHash: hash(900), transactionHash: hash(9001), logIndex: 1 } };
  const log = (method: string, args: unknown[], block = 999, index = 1): FreshLog => {
    const encoded = abi.encodeEventLog(abi.getEvent(method)!, args);
    return { address: INFINITY_CL, topics: encoded.topics, data: encoded.data, blockNumber: toBeHex(block), blockHash: hash(block), transactionHash: hash(block * 100 + index), transactionIndex: '0x1', logIndex: toBeHex(index) };
  };
  const swap = (block = 999, index = 1, liquidity = 10n ** 18n) => log('Swap', [pool, token, -1n, 2n, Q96, liquidity, 0, 100, 0], block, index);
  const modify = (block = 999, index = 2, delta = -1n) => log('ModifyLiquidity', [pool, token, -100, 100, delta, hash(1)], block, index);
  const donate = (block = 999, index = 2) => log('Donate', [pool, token, 1n, 1n, 0], block, index);
  const canonicalHash = vi.fn(async (n: number) => hash(n));
  const rpcFor = (logs: FreshLog[], sourceSeconds = 1793010036) => vi.fn(async (method: string, params: unknown[]) => {
    if (method === 'eth_getLogs') { expect((params[0] as any).topics).toEqual([null, pool]); return logs; }
    if (method === 'eth_getBlockByNumber') return { number: (params[0] as string), hash: hash(Number(BigInt(params[0] as string))), timestamp: toBeHex(sourceSeconds) };
    throw Error('unexpected_rpc_' + method);
  }) as unknown as Rpc;
  return { identity, log, swap, modify, donate, canonicalHash, rpcFor };
}
const sourceEpoch = Date.parse('2026-10-26T10:20:36.000Z') / 1000;
function historical(f: ReturnType<typeof fixture>, logs: FreshLog[], seconds = sourceEpoch) {
  return { rpc: f.rpcFor(logs, seconds), identity: f.identity, tokenDecimals: 18, target, canonicalHash: f.canonicalHash };
}

describe('authenticated Pancake Infinity CL native markets', () => {
  it('authenticates the complete actual Copper Initialize and the entire six-word key', () => {
    const m = authenticateFreshInfinityClInitialization(actualInitialization, token, pool)!;
    expect(m).toMatchObject({ protocol: 'infinity_cl', manager: INFINITY_CL, poolId: pool, tokenAddress: token, quoteAddress: WBNB, initial: { blockNumber: 129874820 } });
    expect(validFreshInfinityClMarketIdentity(m)).toBe(true);
    expect(freshInfinityClPoolId(m.poolKey)).toBe(pool);
  });
  it.each(['status', 'hash', 'pool', 'duplicate', 'log_identity', 'abi_suffix'])('rejects invalid actual initialization: %s', mode => {
    const r = structuredClone(actualInitialization); let expected = pool;
    if (mode === 'status') r.status = '0x0';
    if (mode === 'hash') r.blockHash = hash(123);
    if (mode === 'pool') expected = hash(123);
    if (mode === 'duplicate') r.logs.push(structuredClone(r.logs[0]));
    if (mode === 'log_identity') r.logs[0].transactionHash = hash(123);
    if (mode === 'abi_suffix') r.logs[0].data += '00';
    expect(authenticateFreshInfinityClInitialization(r, token, expected)).toBeNull();
  });
  it.each([
    ['hooks', '0x' + '1'.repeat(40)], ['poolManager', token], ['currency0', WBNB], ['currency1', native], ['fee', 0x800000],
    ['parameters', hash(0)], ['parameters', hash(65537)], ['parameters', toBeHex(1n << 40n | 65536n, 32)], ['parameters', toBeHex(32768n << 16n, 32)],
  ])('rejects unsupported key field %s = %s', (field, value) => {
    const f = fixture(), key = { ...f.identity.poolKey, [field]: value } as FreshInfinityClPoolKey;
    expect(() => freshInfinityClPoolId(key)).toThrow('infinity_cl_pool_key_unsupported');
    expect(validFreshInfinityClMarketIdentity({ ...f.identity, poolKey: key })).toBe(false);
  });
  it('requires exact expected quote and tick while never treating initialization as token birth', () => {
    expect(authenticateFreshInfinityClInitialization(actualInitialization, token, pool, token)).toBeNull();
    expect(authenticateFreshInfinityClInitialization(actualInitialization, token, pool, WBNB, 0)).toBeNull();
    expect(authenticateFreshInfinityClInitialization(actualInitialization, token, pool)).not.toHaveProperty('launch');
  });
});

describe('current Infinity CL state uses one exact confirmed block', () => {
  const currentRpc = (identity: FreshInfinityClMarketIdentity, changes: Record<string, unknown[]> = {}) => vi.fn(async (method: string, params: unknown[]) => {
    expect(method).toBe('eth_call'); expect(params[1]).toEqual({ blockHash: target.hash, requireCanonical: true });
    expect((params[0] as any).to).toBe(INFINITY_CL);
    const call = abi.parseTransaction({ data: (params[0] as any).data })!;
    expect(call.args[0]).toBe(pool);
    const values = changes[call.name] ?? (call.name === 'poolIdToPoolKey' ? Object.values(identity.poolKey) : call.name === 'getSlot0' ? [Q96, 0, 0, 100] : [10n ** 18n]);
    return abi.encodeFunctionResult(call.name, values);
  }) as unknown as Rpc;
  it('checks key, sqrt and active liquidity and returns exact native raw ratios', async () => {
    const f = fixture(), rpc = currentRpc(f.identity), r = await readFreshInfinityClMarket({ rpc, identity: f.identity, tokenDecimals: 18, block: target });
    expect(r.protocol).toBe('infinity_cl'); expect(r.priceQuote).toBe('1'); expect(r.liquidityRaw).toBe('1000000000000000000');
    expect(r.rawQuoteRatio.numerator).toBe(r.rawQuoteRatio.denominator); expect(r.virtualQuoteLiquidity).toBe('1'); expect(r.quoteAddress).toBe(WBNB);
    expect(rpc).toHaveBeenCalledTimes(3);
  });
  it('honors verified token precision rather than a default', async () => {
    const f = fixture(), r = await readFreshInfinityClMarket({ rpc: currentRpc(f.identity), identity: f.identity, tokenDecimals: 6, block: target });
    expect(r.priceQuote).toBe('0.000000000001');
  });
  it.each([['zero liquidity', { getLiquidity: [0] }], ['zero sqrt', { getSlot0: [0, 0, 0, 100] }], ['bad tick', { getSlot0: [Q96, 887273, 0, 100] }]])('rejects %s', async (_label, changes) => {
    const f = fixture(); await expect(readFreshInfinityClMarket({ rpc: currentRpc(f.identity, changes as Record<string, unknown[]>), identity: f.identity, tokenDecimals: 18, block: target })).rejects.toThrow();
  });
  it('rejects changed pool keys even with syntactically valid replies', async () => {
    const f = fixture(), key = Object.values({ ...f.identity.poolKey, fee: 500 });
    await expect(readFreshInfinityClMarket({ rpc: currentRpc(f.identity, { poolIdToPoolKey: key }), identity: f.identity, tokenDecimals: 18, block: target })).rejects.toThrow('infinity_cl_market_key_changed');
  });
});

describe('historical Infinity CL prices cover every pool event through cutoff', () => {
  it('queries all pool topics and authenticates a genuine recent Swap before the cutoff', async () => {
    const f = fixture(), o = historical(f, [f.modify(998, 1, 10n ** 18n), f.swap()]), r = await historicalFreshInfinityClPrice(o);
    expect(r.priceNative).toBe('1'); expect(r.liquidityRaw).toBe('1000000000000000000'); expect(r.source.number).toBe(999);
    expect(r.fromBlock).toBe(937); expect(r.events).toHaveLength(2); expect(o.rpc).toHaveBeenCalledTimes(2);
  });
  it('revalidates retained proof with zero RPC and exact result identity', async () => {
    const f = fixture(), p = await historicalFreshInfinityClPrice(historical(f, [f.swap()])), rpc = vi.fn(async () => { throw Error('no_network'); }) as unknown as Rpc;
    expect(await historicalFreshInfinityClPrice({ ...historical(f, []), rpc, prior: p })).toEqual(p); expect(rpc).not.toHaveBeenCalled();
  });
  it.each(['price', 'source', 'liquidity', 'events'])('rejects altered retained %s', async mode => {
    const f = fixture(), p = await historicalFreshInfinityClPrice(historical(f, [f.swap()]));
    if (mode === 'price') p.priceQuote = '2'; if (mode === 'source') p.source.hash = hash(15); if (mode === 'liquidity') p.liquidityRaw = '2'; if (mode === 'events') p.events = [];
    await expect(historicalFreshInfinityClPrice({ ...historical(f, []), prior: p })).rejects.toThrow();
  });
  it('never uses Initialize alone or an empty old window as market trading activity', async () => {
    const f = fixture(), o = historical(f, []); await expect(historicalFreshInfinityClPrice(o)).rejects.toThrow('infinity_cl_market_price_window_empty'); expect(o.rpc).toHaveBeenCalledTimes(2);
  });
  it.each([-1n, 1n])('rejects a later nonzero liquidity change (%s) instead of trusting Swap liquidity', async delta => {
    const f = fixture(); await expect(historicalFreshInfinityClPrice(historical(f, [f.swap(), f.modify(999, 2, delta)]))).rejects.toThrow('infinity_cl_market_liquidity_changed');
  });
  it('a later authentic Swap reestablishes active liquidity after a modification', async () => {
    const f = fixture(), r = await historicalFreshInfinityClPrice(historical(f, [f.swap(998), f.modify(998, 2), f.swap(999)])); expect(r.source.number).toBe(999);
  });
  it('a later positive Swap supersedes an earlier genuine empty-liquidity state', async () => {
    const f = fixture(), r = await historicalFreshInfinityClPrice(historical(f, [f.swap(998, 1, 0n), f.swap(999)])); expect(r.liquidityRaw).toBe('1000000000000000000');
  });
  it.each(['transactionIndex', 'logIndex'])('rejects overflowing %s instead of overlapping ordering components', async field => {
    const f = fixture(), l = f.swap(); l[field as 'transactionIndex' | 'logIndex'] = toBeHex(1n << 32n);
    await expect(historicalFreshInfinityClPrice(historical(f, [l]))).rejects.toThrow('infinity_cl_market_log_invalid');
  });
  it('zero liquidity modifications and donations cannot invent volume or change the Swap price', async () => {
    const f = fixture(), r = await historicalFreshInfinityClPrice(historical(f, [f.swap(), f.modify(999, 2, 0n), f.donate(999, 3)])); expect(r.priceNative).toBe('1'); expect(r.events).toHaveLength(3);
  });
  it.each(['orphan', 'duplicate', 'future', 'foreign_pool', 'foreign_manager', 'malformed', 'unknown_event', 'zero_liquidity', 'wrong_sign'])('rejects %s pool evidence', async mode => {
    const f = fixture(), l = f.swap(), logs = [l];
    if (mode === 'orphan') l.blockHash = hash(3); if (mode === 'duplicate') logs.push(structuredClone(l)); if (mode === 'future') { l.blockNumber = toBeHex(1001); l.blockHash = hash(1001); }
    if (mode === 'foreign_pool') l.topics[1] = hash(3); if (mode === 'foreign_manager') l.address = token; if (mode === 'malformed') l.data += '00'; if (mode === 'unknown_event') l.topics[0] = hash(3);
    if (mode === 'zero_liquidity') logs[0] = f.swap(999, 1, 0n); if (mode === 'wrong_sign') { const bad = abi.encodeEventLog(abi.getEvent('Swap')!, [pool, token, 1n, 2n, Q96, 10n ** 18n, 0, 100, 0]); l.data = bad.data; }
    await expect(historicalFreshInfinityClPrice(historical(f, logs))).rejects.toThrow();
  });
  it.each([sourceEpoch - 121, sourceEpoch + 2])('rejects stale or future source time %s', async seconds => {
    const f = fixture(); await expect(historicalFreshInfinityClPrice(historical(f, [f.swap()], seconds))).rejects.toThrow('infinity_cl_market_source_invalid');
  });
  it('bounds pool-event work without dropping excess events', async () => {
    const f = fixture(), logs = Array.from({ length: 257 }, (_, i) => f.swap(999, i));
    await expect(historicalFreshInfinityClPrice(historical(f, logs))).rejects.toThrow('infinity_cl_market_work_bounds');
  });
});

describe('bounded canonical headers for sparse historical Infinity collection', () => {
  const sparse = (logs: FreshLog[], changes: (h: any, call: number) => void = () => {}) => {
    const f = fixture(), canonicalHash = vi.fn(async (n: number) => n === target.number || n === f.identity.initial.blockNumber ? hash(n) : null);
    let calls = 0;
    const rpc = vi.fn(async (method: string, params: unknown[]) => {
      if (method === 'eth_getLogs') return logs;
      if (method !== 'eth_getBlockByNumber') throw Error('unexpected_rpc');
      const number = Number(BigInt(params[0] as string)), h = { number: toBeHex(number), hash: hash(number), parentHash: hash(number - 1), timestamp: toBeHex(sourceEpoch + number - 999), transactions: [] };
      changes(h, ++calls); return h;
    }) as unknown as Rpc;
    return { ...f, canonicalHash, rpc };
  };
  it('captures real missing event headers under a pinned target and replays them without RPC', async () => {
    const f = fixture(), s = sparse([f.modify(998, 1, 10n ** 18n), f.swap()]), p = await historicalFreshInfinityClPrice({ ...s, tokenDecimals: 18, target });
    expect(p.canonicalHeaders?.map(h => h.number)).toEqual([998, 999, 1000]); expect(p.priceNative).toBe('1'); expect(s.rpc).toHaveBeenCalledTimes(5);
    const noRpc = vi.fn(async () => { throw Error('no_replay_rpc'); }) as unknown as Rpc;
    expect(await historicalFreshInfinityClPrice({ ...s, rpc: noRpc, tokenDecimals: 18, target, prior: p })).toEqual(p); expect(noRpc).not.toHaveBeenCalled();
    const nowKnown = async (n: number) => hash(n);
    expect(await historicalFreshInfinityClPrice({ ...s, canonicalHash: nowKnown, rpc: noRpc, tokenDecimals: 18, target, prior: p })).toEqual(p);
  });
  it.each(['target', 'initial'])('never falls back for a missing pinned %s header', async mode => {
    const f = fixture(), s = sparse([f.swap()]), canonicalHash = async (n: number) => n === (mode === 'target' ? 1000 : 900) ? null : hash(n);
    await expect(historicalFreshInfinityClPrice({ ...s, canonicalHash, tokenDecimals: 18, target })).rejects.toThrow('infinity_cl_market_noncanonical'); expect(s.rpc).not.toHaveBeenCalled();
  });
  it('rejects a known conflicting event header instead of borrowing the node observation', async () => {
    const f = fixture(), s = sparse([f.swap()]), canonicalHash = async (n: number) => n === 999 ? hash(17) : hash(n);
    await expect(historicalFreshInfinityClPrice({ ...s, canonicalHash, tokenDecimals: 18, target })).rejects.toThrow('infinity_cl_market_noncanonical'); expect(s.rpc).toHaveBeenCalledTimes(1);
  });
  it.each(['hash', 'number', 'parent', 'timestamp', 'transactions'])('rejects malformed actual missing header %s', async mode => {
    const f = fixture(), s = sparse([f.swap()], h => { if (Number(BigInt(h.number)) !== 999) return; if (mode === 'hash') h.hash = hash(17); if (mode === 'number') h.number = toBeHex(998); if (mode === 'parent') h.parentHash = '0x00'; if (mode === 'timestamp') h.timestamp = '0xno'; if (mode === 'transactions') h.transactions = [{}]; });
    await expect(historicalFreshInfinityClPrice({ ...s, tokenDecimals: 18, target })).rejects.toThrow();
  });
  it('requires the actual target bookends to remain identical', async () => {
    const f = fixture(), s = sparse([f.swap()], (h, count) => { if (Number(BigInt(h.number)) === 1000 && count > 1) h.hash = hash(17); });
    await expect(historicalFreshInfinityClPrice({ ...s, tokenDecimals: 18, target })).rejects.toThrow('infinity_cl_market_noncanonical');
  });
  it.each(['known_conflict', 'missing_event', 'extra_event', 'extra_field', 'duplicate', 'parent', 'time'])('rejects changed retained header evidence %s', async mode => {
    const f = fixture(), s = sparse([f.modify(998, 1, 1n), f.swap()]), p = await historicalFreshInfinityClPrice({ ...s, tokenDecimals: 18, target });
    let canonicalHash = s.canonicalHash;
    if (mode === 'known_conflict') canonicalHash = vi.fn(async n => n === 999 ? hash(17) : n === 900 || n === 1000 ? hash(n) : null);
    if (mode === 'missing_event') p.canonicalHeaders = p.canonicalHeaders!.filter(h => h.number !== 999);
    if (mode === 'extra_event') p.canonicalHeaders!.push({ number: 997, hash: hash(997), parentHash: hash(996), timestamp: '2026-10-26T10:20:34.000Z' });
    if (mode === 'extra_field') (p.canonicalHeaders![0] as any).financialHistory = [];
    if (mode === 'duplicate') p.canonicalHeaders!.push(structuredClone(p.canonicalHeaders![0]));
    if (mode === 'parent') p.canonicalHeaders![1].parentHash = hash(17);
    if (mode === 'time') p.canonicalHeaders![0].timestamp = '2026-10-26T10:20:38.000Z';
    const rpc = vi.fn(async () => { throw Error('no_rpc'); }) as unknown as Rpc;
    await expect(historicalFreshInfinityClPrice({ ...s, canonicalHash, rpc, tokenDecimals: 18, target, prior: p })).rejects.toThrow(); expect(rpc).not.toHaveBeenCalled();
  });
  it('allows at most32 unique header observations including the target', async () => {
    const f = fixture(), okay = sparse(Array.from({ length: 31 }, (_, i) => f.swap(969 + i))), p = await historicalFreshInfinityClPrice({ ...okay, tokenDecimals: 18, target });
    expect(p.canonicalHeaders).toHaveLength(32);
    const over = sparse(Array.from({ length: 32 }, (_, i) => f.swap(968 + i)));
    await expect(historicalFreshInfinityClPrice({ ...over, tokenDecimals: 18, target })).rejects.toThrow('infinity_cl_market_header_bounds');
  });
  it('awaits a slow node request settlement before rejecting the12-second start budget', async () => {
    vi.useFakeTimers(); try {
      const f = fixture(), s = sparse([f.swap()]); let finish!: (value: unknown) => void, settled = false;
      const rpc = vi.fn(async (method: string) => method === 'eth_getLogs' ? [f.swap()] : new Promise(resolve => { finish = resolve; })) as unknown as Rpc;
      const work = historicalFreshInfinityClPrice({ ...s, rpc, tokenDecimals: 18, target }); work.then(() => { settled = true; }, () => { settled = true; });
      const outcome = expect(work).rejects.toThrow('infinity_cl_market_header_deadline'); await vi.advanceTimersByTimeAsync(0); expect(finish).toBeTypeOf('function');
      await vi.advanceTimersByTimeAsync(13000); expect(settled).toBe(false); expect(rpc).toHaveBeenCalledTimes(2);
      finish({ number: toBeHex(1000), hash: target.hash, parentHash: hash(999), timestamp: toBeHex(sourceEpoch + 1), transactions: [] }); await outcome; expect(settled).toBe(true); expect(rpc).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); }
  });
  it('does not start another header wire when the existing request exhausts the start budget', async () => {
    vi.useFakeTimers(); try {
      const f = fixture(), s = sparse([f.swap()]), rpc = vi.fn(async (method: string) => {
        if (method === 'eth_getLogs') return [f.swap()]; vi.setSystemTime(Date.now() + 12000);
        return { number: toBeHex(1000), hash: target.hash, parentHash: hash(999), timestamp: toBeHex(sourceEpoch + 1), transactions: [] };
      }) as unknown as Rpc;
      await expect(historicalFreshInfinityClPrice({ ...s, rpc, tokenDecimals: 18, target })).rejects.toThrow('infinity_cl_market_header_deadline'); expect(rpc).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); }
  });
});
