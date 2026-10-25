import { gunzipSync } from 'node:zlib';
import { Interface } from 'ethers';
import { describe, expect, it } from 'vitest';
import type { Rpc } from '../rpc.js';
import { FLAP_PORTAL, PCS_V2_FACTORY, flapInterface } from '../launchpad.js';
import type { FreshLog } from './capture.js';
import type { FreshTokenMetadata } from './pricing.js';
import type { FreshStateReadEvidence } from './stateEvidence.js';
import { FRESH_FLAP_RECOVERY_POOLS, FRESH_FLAP_RECOVERY_QUOTE, recoverFreshFlapQuote, readFreshFlapRawQuote } from './flapQuoteRecovery.js';

// Exact public PCS V2 factory bytecode; the audited embedded pair runtime is
// extracted from the same fixture. No live node or ignored file is a test input.
const factoryCode = gunzipSync(Buffer.from('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', 'base64')).toString();
const pairCode = '0x' + factoryCode.slice(2 + (0xe0c + 0x175) * 2, 2 + (0xe0c + 0x175 + 0x3a85) * 2);
const hash = (n: number) => '0x' + n.toString(16).padStart(64, '0'), hex = (n: number) => '0x' + n.toString(16);
const token = '0x' + '1'.repeat(40), erc20 = new Interface(['function decimals() view returns(uint8)', 'function totalSupply() view returns(uint256)']);
const syncAbi = new Interface(['event Sync(uint112 reserve0,uint112 reserve1)', 'function getReserves() view returns(uint112,uint112,uint32)']);
function fixture() {
  const now = Math.floor(Date.now() / 1000) * 1000;
  const target = {number: 10000, hash: hash(10000), timestamp: new Date(now - 600000).toISOString()};
  const anchor = {number: 10020, hash: hash(10020), timestamp: new Date(now).toISOString()};
  const metadata: FreshTokenMetadata = {address: token, decimals: 18, name: null, symbol: null, supplyRaw: String(10n ** 27n), block: target};
  const state: unknown[] = [1, 5n * 10n ** 23n, 5n * 10n ** 26n, 10n ** 15n, 6, 10n ** 23n, 10n ** 26n,
    36n * 10n ** 31n, 8n * 10n ** 26n, FRESH_FLAP_RECOVERY_QUOTE, false, hash(9), 300, 300, '0x' + '0'.repeat(40), 25n * 10n ** 16n, 0, 0];
  const read = (to: string, abi: Interface, method: string, args: unknown[], result: unknown[]) => ({to, data: abi.encodeFunctionData(method, args), result: abi.encodeFunctionResult(method, result)});
  const source: FreshStateReadEvidence = {version: 1, blockNumber: target.number, blockHash: target.hash, calls: [
    read(token, erc20, 'decimals', [], [18]), read(token, erc20, 'totalSupply', [], [10n ** 27n]),
    read(FLAP_PORTAL, flapInterface, 'getTokenV8Safe', [token], [state]),
  ]};
  const sync = (i: number, n: number, a: bigint, b: bigint): FreshLog => ({address: FRESH_FLAP_RECOVERY_POOLS[i].pool,
    ...syncAbi.encodeEventLog(syncAbi.getEvent('Sync')!, [a, b]), blockNumber: hex(n), blockHash: hash(n), transactionHash: hash(100000 + n), transactionIndex: '0x0', logIndex: '0x1'});
  const logs = [[sync(0, 9990, 3n * 10n ** 20n, 5n * 10n ** 23n)], [sync(1, 9996, 6n * 10n ** 20n, 12n * 10n ** 18n)]];
  const methods: string[] = [], codes = new Map<string, string>([[PCS_V2_FACTORY, factoryCode], ...FRESH_FLAP_RECOVERY_POOLS.map(p => [p.pool, pairCode] as [string, string])]);
  let chainId = '0x38';
  const rpc = (async (method: string, params: any[]) => {
    methods.push(method);
    if (method === 'eth_chainId') return chainId;
    if (method === 'eth_getCode') { expect(params[1]).toEqual({blockHash: anchor.hash, requireCanonical: true}); return codes.get(params[0]); }
    if (method === 'eth_call') {
      expect(params[1]).toEqual({blockHash: anchor.hash, requireCanonical: true});
      const saved = source.calls.find(c => c.to === params[0].to && c.data === params[0].data); if (saved) return saved.result;
      const index = FRESH_FLAP_RECOVERY_POOLS.findIndex(p => p.pool === params[0].to);
      if (index >= 0 && params[0].data === syncAbi.encodeFunctionData('getReserves')) {
        const p = syncAbi.decodeEventLog('Sync', logs[index].at(-1)!.data);
        return syncAbi.encodeFunctionResult('getReserves', [p[0], p[1], 1]);
      }
    }
    if (method === 'eth_getLogs') {
      const index = FRESH_FLAP_RECOVERY_POOLS.findIndex(p => p.pool === params[0].address); expect(index).toBeGreaterThanOrEqual(0);
      expect(params[0]).toMatchObject({fromBlock: hex(5905), toBlock: hex(10000), topics: [syncAbi.getEvent('Sync')!.topicHash]});
      return logs[index];
    }
    throw Error('unexpected_rpc');
  }) as Rpc;
  const mutateState = (index: number, value: unknown) => {state[index] = value; source.calls[2].result = flapInterface.encodeFunctionResult('getTokenV8Safe', [state]);};
  return {source, metadata, logs, sync, codes, methods, mutateState, setChain: (v: string) => {chainId = v;},
    options: {rpc, tokenAddress: token, metadata, source, target, anchor, canonicalHash: async (n: number) => hash(n)}};
}

describe('narrow captured Flap state and deterministic historical PCS V2 route', () => {
  it('composes exact raw ratios without intermediate decimals or current reserves', async () => {
    const f = fixture(), proof = await recoverFreshFlapQuote(f.options);
    expect(proof.priceNative).toBe('0.000000012');
    expect(proof.curve.priceScaled18).toBe('1000000000000000');
    expect(proof.pools.map(p => p.lastSync.blockNumber)).toEqual([hex(9990), hex(9996)]);
    expect(f.methods.filter(m => m === 'eth_getCode')).toHaveLength(3); expect(f.methods.filter(m => m === 'eth_getLogs')).toHaveLength(2);
    expect(f.methods).not.toContain('eth_call'); expect(JSON.stringify(proof)).not.toContain('quoteDecimals');
  });
  it('uses the last complete Sync and includes the target block end', async () => {
    const f = fixture(); f.logs[0].push(f.sync(0, 10000, 6n * 10n ** 20n, 5n * 10n ** 23n));
    expect((await recoverFreshFlapQuote(f.options)).priceNative).toBe('0.000000024');
  });
  it('does not reuse a launch/default reserve when the bounded window has no Sync', async () => {
    const f = fixture(); f.logs[0] = [];
    await expect(recoverFreshFlapQuote(f.options)).rejects.toThrow('flap_quote_sync_unavailable');
  });
  it('replays saved proofs with JSONB key ordering and no RPC', async () => {
    const f = fixture(), prior = await recoverFreshFlapQuote(f.options), reordered = Object.fromEntries(Object.entries(prior).reverse()) as typeof prior;
    const result = await recoverFreshFlapQuote({...f.options, prior: reordered, rpc: (async () => {throw Error('must_not_read');}) as Rpc});
    expect(result.priceNative).toBe(prior.priceNative);
  });
  it('invalidates saved target, Sync, and code-anchor reorgs', async () => {
    const f = fixture(), prior = await recoverFreshFlapQuote(f.options);
    for (const replaced of [10000, 9990, 9996, 10020]) await expect(recoverFreshFlapQuote({...f.options, prior,
      canonicalHash: async n => hash(n === replaced ? 22222 : n)})).rejects.toThrow('flap_quote_noncanonical');
  });
  it('rejects altered retained ratios, prices, code templates and source data', async () => {
    const f = fixture(), prior = await recoverFreshFlapQuote(f.options);
    for (const patch of [{priceNative: '99'}, {rawNativeRatio: {numerator: '1', denominator: '1'}},
      {code: {...prior.code, factoryRuntimeHash: hash(9)}}, {source: {...prior.source, blockHash: hash(9)}}]) {
      await expect(recoverFreshFlapQuote({...f.options, prior: {...prior, ...patch} as typeof prior})).rejects.toThrow('flap_quote_prior_invalid');
    }
  });
  it('rejects a current/foreign metadata row and mismatched captured precision or supply', async () => {
    for (const patch of [{decimals: 9}, {supplyRaw: '123'}, {block: {...fixture().options.target, number: 10020}}]) {
      const f = fixture(); await expect(recoverFreshFlapQuote({...f.options, metadata: {...f.metadata, ...patch}})).rejects.toThrow('flap_quote_source_invalid');
    }
    const f = fixture(); f.source.calls[0].result = erc20.encodeFunctionResult('decimals', [9]);
    await expect(recoverFreshFlapQuote(f.options)).rejects.toThrow('flap_quote_source_invalid');
  });
  it('requires exact same-block captured token and portal responses', async () => {
    const f = fixture(); f.source.blockHash = hash(9);
    await expect(recoverFreshFlapQuote(f.options)).rejects.toThrow('flap_quote_source_invalid');
    const g = fixture(); g.source.calls.pop(); await expect(recoverFreshFlapQuote(g.options)).rejects.toThrow('flap_quote_source_invalid');
    const j = fixture(); j.source.calls.push(j.source.calls[0]); await expect(recoverFreshFlapQuote(j.options)).rejects.toThrow('flap_quote_source_invalid');
  });
  it('rejects unsupported curve status, token version, quote and scale', async () => {
    for (const [index, value] of [[0, 4], [4, 3], [9, token], [3, 10n ** 15n + 1n]]) {
      const f = fixture(); f.mutateState(Number(index), value); await expect(recoverFreshFlapQuote(f.options)).rejects.toThrow();
    }
  });
  it('rejects arbitrary, mutable, proxy and altered runtime templates', async () => {
    const f = fixture(); f.codes.set(PCS_V2_FACTORY, factoryCode.slice(0, -2) + 'ff');
    await expect(recoverFreshFlapQuote(f.options)).rejects.toThrow('flap_quote_factory_code_invalid');
    const g = fixture(); g.codes.set(FRESH_FLAP_RECOVERY_POOLS[0].pool, '0x363d3d373d3d3d363d73' + token.slice(2) + '5af43d82803e903d91602b57fd5bf3');
    await expect(recoverFreshFlapQuote(g.options)).rejects.toThrow('flap_quote_pair_code_invalid');
  });
  it('requires BSC, a post-BEP344 target and a recent canonical code anchor', async () => {
    const f = fixture(); f.setChain('0x1'); await expect(recoverFreshFlapQuote(f.options)).rejects.toThrow('flap_quote_chain_invalid');
    const g = fixture(); g.options.target.timestamp = '2024-01-01T00:00:00.000Z'; await expect(recoverFreshFlapQuote(g.options)).rejects.toThrow('flap_quote_identity_invalid');
    const j = fixture(); j.options.anchor.timestamp = new Date(Date.now() - 60000).toISOString(); await expect(recoverFreshFlapQuote(j.options)).rejects.toThrow('flap_quote_anchor_stale');
  });
  it('bounds event work and rejects missing, foreign, removed, unordered and future Syncs', async () => {
    const f = fixture(); f.logs[0] = Array(513).fill(f.logs[0][0]); await expect(recoverFreshFlapQuote(f.options)).rejects.toThrow('flap_quote_work_bounds');
    for (const mutate of [(l: FreshLog) => {l.address = token;}, (l: FreshLog) => {l.removed = true;}, (l: FreshLog) => {l.blockNumber = hex(10001);},
      (l: FreshLog) => {l.blockHash = hash(999);}, (l: FreshLog) => {l.data += '00';}]) {
      const g = fixture(); mutate(g.logs[0][0]); await expect(recoverFreshFlapQuote(g.options)).rejects.toThrow();
    }
    const j = fixture(); j.logs[0].push(j.logs[0][0]); await expect(recoverFreshFlapQuote(j.options)).rejects.toThrow('flap_quote_sync_order_invalid');
  });
  it('infers the captured reserve MODEL scale without asserting ERC20 decimals', async () => {
    const f = fixture(); f.mutateState(1, 5n * 10n ** 22n);
    const proof = await recoverFreshFlapQuote(f.options);
    expect(proof.curve.reserveModelScale.factor).toBe('10'); expect(proof.priceNative).toBe('0.0000000012');
    expect(JSON.stringify(proof.curve)).not.toContain('decimals');
  });
  it('rejects zero, inconsistent and ambiguous raw reserves', async () => {
    const f = fixture(); f.mutateState(1, 0n); await expect(recoverFreshFlapQuote(f.options)).rejects.toThrow('flap_quote_curve_unsupported');
    const g = fixture(); g.mutateState(1, 5n * 10n ** 23n + 1n); await expect(recoverFreshFlapQuote(g.options)).rejects.toThrow('flap_quote_curve_scale_ambiguous');
    const j = fixture(), denominator = 6n * 10n ** 26n, k = (10n ** 23n + 1n) * denominator / 10n ** 18n;
    j.mutateState(1, 1n); j.mutateState(7, k); j.mutateState(3, k * 10n ** 18n / (denominator * denominator / 10n ** 18n));
    await expect(recoverFreshFlapQuote(j.options)).rejects.toThrow('flap_quote_curve_scale_ambiguous');
  });
  it('uses the actual Wad-square floor before price division', async () => {
    const f = fixture(), denominator = 1234567890123n, k = 10n ** 30n, r = 10n ** 10n, scale = 10n ** 18n;
    const expected = k * scale / (denominator * denominator / scale), rawReserve = (k * scale + denominator - 1n) / denominator - r;
    expect(expected).not.toBe(k * scale * scale / (denominator * denominator));
    f.mutateState(1, rawReserve); f.mutateState(2, 10n ** 27n); f.mutateState(3, expected); f.mutateState(5, r); f.mutateState(6, denominator); f.mutateState(7, k);
    expect((await recoverFreshFlapQuote(f.options)).curve.priceScaled18).toBe(String(expected));
  });
  it('reads current values only at one block, using the same code and model checks', async () => {
    const f = fixture(), value = await readFreshFlapRawQuote({rpc: f.options.rpc, token: {...f.metadata, block: f.options.anchor}, block: f.options.anchor});
    expect(value.nativePerToken).toBe('0.000000012'); expect(value.reserveModelScale.factor).toBe('1');
    expect(value.state.pair0Reserve0).toBe(String(3n * 10n ** 20n)); expect(f.methods).not.toContain('eth_getLogs');
    expect(f.methods.filter(m => m === 'eth_call')).toHaveLength(5);
  });
  it('rejects current state with a foreign raw curve or mutated pair code', async () => {
    const f = fixture(); f.mutateState(9, token);
    await expect(readFreshFlapRawQuote({rpc: f.options.rpc, token: {...f.metadata, block: f.options.anchor}, block: f.options.anchor})).rejects.toThrow('flap_quote_curve_unsupported');
    const g = fixture(); g.codes.set(FRESH_FLAP_RECOVERY_POOLS[1].pool, '0x00');
    await expect(readFreshFlapRawQuote({rpc: g.options.rpc, token: {...g.metadata, block: g.options.anchor}, block: g.options.anchor})).rejects.toThrow('flap_quote_pair_code_invalid');
  });
});
