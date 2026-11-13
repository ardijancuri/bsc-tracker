import { Interface, ZeroAddress } from 'ethers';
import { describe, expect, it } from 'vitest';
import { PCS_V3_FACTORY } from '../launchpad.js';
import { oracleMarketAbi, poolMarketAbi, TRUSTED_QUOTE_FEEDS, v3MarketAbi, type NodeMarketLog } from '../nodeMarketProtocols.js';
import { blockHex, RpcRequestError, type Rpc } from '../rpc.js';
import { createNodeMomentumIngest, NODE_MOMENTUM_V3_SWAP_TOPIC, type MomentumBlock } from './nodeMomentumIngest.js';

const pool = '0xbc068d059675342fd56eff3b6789cc1d426b71a1';
const jacket = '0xb82535e74b03ffe4910efea1c759b6bbbf0a7777';
const usdt = '0x55d398326f99059ff775485246999027b3197955';
const counterfeit = '0x' + 'b'.repeat(40);
const address = '0x' + 'c'.repeat(40);
const hash = (number: number) => '0x' + number.toString(16).padStart(64, '0');
const at = Date.parse('2026-11-13T12:00:00Z');
const block = (number: number): MomentumBlock => ({ number, hash: hash(number), timestamp: new Date(at + (number - 100) * 1_000).toISOString() });
const token = new Interface(['function decimals() view returns(uint8)', 'function name() view returns(string)', 'function symbol() view returns(string)']);
const abs18 = 10n ** 18n;

function swap(height: number, index: number, buy: boolean, emitter = pool): NodeMarketLog {
  const sign = buy ? 1n : -1n;
  const encoded = v3MarketAbi.encodeEventLog('Swap', [address, address, sign * 100n * abs18, -sign * 20n * abs18, 2n << 96n, 100_000n, 1, 0, 0]);
  return { ...encoded, address: emitter, blockHash: hash(height), blockNumber: blockHex(height), transactionHash: hash(200 + index),
    logIndex: blockHex(index), transactionIndex: '0x1' };
}

type TestRound = { id: bigint; updatedAt: number; answer: number };

function fakeRpc(settings: {
  logs: NodeMarketLog[];
  roundChange?: boolean;
  unavailable?: Set<number>;
  roundAt?: (height: number) => TestRound;
} = { logs: [] }) {
  const calls: { method: string; params: unknown[] }[] = [];
  const rpc: Rpc = async <T>(method: string, params: unknown[]) => {
    calls.push({ method, params });
    if (method === 'eth_getLogs') return settings.logs as T;
    const [request, scope] = params as [{ to: string; data: string }, { blockHash: string; requireCanonical: boolean }];
    expect(method).toBe('eth_call');
    expect(scope.requireCanonical).toBe(true);
    const height = Number(BigInt(scope.blockHash));
    if (settings.unavailable?.has(height)) throw new RpcRequestError('Uncovered state', 'state_unavailable');
    let abi = poolMarketAbi, name: string, args: unknown[];
    if (request.to === pool || request.to === counterfeit) {
      name = poolMarketAbi.parseTransaction({ data: request.data })!.name;
      const values: Record<string, unknown> = { factory: PCS_V3_FACTORY, token0: usdt, token1: jacket, fee: 10_000 };
      args = [values[name]];
    } else if (request.to === PCS_V3_FACTORY) {
      name = 'getPool'; args = [pool];
    } else if (request.to === jacket || request.to === usdt) {
      abi = token;
      name = token.parseTransaction({ data: request.data })!.name;
      const values: Record<string, unknown> = { decimals: 18, name: 'Just a jacket', symbol: 'Jacket' };
      args = [values[name]];
    } else if (request.to === TRUSTED_QUOTE_FEEDS[usdt].feed) {
      abi = oracleMarketAbi;
      name = abi.parseTransaction({ data: request.data })!.name;
      const latest = !!settings.roundChange && height >= 102;
      const round = settings.roundAt?.(height) ?? {
        id: (3n << 64n) + (latest ? 8n : 7n),
        updatedAt: latest ? at / 1_000 + 2 : at / 1_000 - 15,
        answer: latest ? 98_000_000 : 101_000_000,
      };
      const values: Record<string, unknown[]> = { decimals: [8], description: ['USDT / USD'],
        latestRoundData: [round.id, round.answer, round.updatedAt, round.updatedAt, round.id] };
      args = values[name];
    } else {
      name = 'getPool'; args = [ZeroAddress];
    }
    return abi.encodeFunctionResult(name, args) as T;
  };
  return { rpc, calls, settings };
}

function pinnedOracleBlocks(calls: ReturnType<typeof fakeRpc>['calls']) {
  const latest = oracleMarketAbi.encodeFunctionData('latestRoundData');
  return calls.flatMap(call => {
    if (call.method !== 'eth_call') return [];
    const [request, scope] = call.params as [{ to: string; data: string }, { blockHash: string }];
    return request.to === TRUSTED_QUOTE_FEEDS[usdt].feed && request.data === latest ? [Number(BigInt(scope.blockHash))] : [];
  });
}

async function warmPreviousOracleAnchor(fixture: ReturnType<typeof fakeRpc>) {
  fixture.settings.logs = [swap(100, 0, true)];
  const ingest = createNodeMomentumIngest(fixture.rpc, { minimumObservations: 1 });
  const result = await ingest.scan([block(100)]);
  expect(result.coveredPools).toEqual([pool]);
  expect(pinnedOracleBlocks(fixture.calls)).toEqual([100]);
  fixture.calls.length = 0;
  return ingest;
}

describe('node market discovery', () => {
  it('discovers established exact-contract JACKET as token1 and deduplicates canonical swap logs', async () => {
    const a = swap(100, 0, true), b = swap(101, 1, false);
    const fixture = fakeRpc({ logs: [b, a, a, swap(100, 2, true, counterfeit)] });
    const ingest = createNodeMomentumIngest(fixture.rpc, { minimumObservations: 1 });
    const result = await ingest.scan([block(100), block(101)]);
    expect(fixture.calls[0]).toEqual({ method: 'eth_getLogs', params: [{ fromBlock: '0x64', toBlock: '0x65', topics: [NODE_MOMENTUM_V3_SWAP_TOPIC] }] });
    expect(result.coveredPools).toEqual([pool]);
    expect(result.observations.map(({ tokenAddress, quoteAddress, at, side, volumeUsd, priceUsd }) => ({ tokenAddress, quoteAddress, at, side, volumeUsd, priceUsd }))).toEqual([
      { tokenAddress: jacket, quoteAddress: usdt, at, side: 'buy', volumeUsd: 101, priceUsd: 5.05 },
      { tokenAddress: jacket, quoteAddress: usdt, at: at + 1_000, side: 'sell', volumeUsd: 101, priceUsd: 5.05 },
    ]);
    expect(result.stats).toMatchObject({ logs: 3, emitters: 2, identitiesAttempted: 2, identitiesVerified: 1, decoded: 2 });
    const factoryLookups = fixture.calls.filter(c => (c.params[0] as { to?: string }).to === PCS_V3_FACTORY);
    expect(factoryLookups).toHaveLength(2);
    fixture.settings.logs = [];
    expect(await ingest.scan([block(102)], { pools: [pool] })).toMatchObject({ observations: [], coveredPools: [pool] });
    ingest.clear();
    expect(await ingest.scan([block(103)])).toMatchObject({ observations: [], coveredPools: [] });
  });

  it('uses each authenticated Chainlink round, with a precise pinned check at the change second', async () => {
    const fixture = fakeRpc({ logs: [swap(100, 0, true), swap(101, 1, true), swap(102, 2, true), swap(103, 3, true)], roundChange: true });
    const ingest = createNodeMomentumIngest(fixture.rpc);
    const result = await ingest.scan([block(100), block(101), block(102), block(103)]);
    expect(result.observations.map(s => s.volumeUsd)).toEqual([101, 101, 98, 98]);
    expect(result.stats.quoteBlocksRead).toBe(3);
    expect(fixture.calls.some(c => c.method === 'eth_call' && (c.params[1] as { blockHash: string }).blockHash === hash(101))).toBe(false);
  });

  it('reports no coverage where pinned state is missing during the round transition', async () => {
    const fixture = fakeRpc({ logs: [swap(100, 0, true), swap(101, 1, true), swap(102, 2, true), swap(103, 3, true)],
      roundChange: true, unavailable: new Set([102]) });
    const result = await createNodeMomentumIngest(fixture.rpc).scan([block(100), block(101), block(102), block(103)]);
    expect(result).toMatchObject({ observations: [], coveredPools: [], stats: { unpricedPools: 1 } });
  });

  it.each([
    ['same', false, [101, 101, 101]],
    ['adjacent same-phase', true, [101, 98, 98]],
  ] as const)('reuses a matching preceding canonical anchor for a %s round', async (_label, roundChange, amounts) => {
    const fixture = fakeRpc({ logs: [], roundChange, unavailable: new Set([101]) });
    const ingest = await warmPreviousOracleAnchor(fixture);
    fixture.settings.logs = [swap(101, 1, true), swap(103, 2, true), swap(104, 3, true)];

    const result = await ingest.scan([block(101), block(102), block(103), block(104)], { parentHash: hash(100) });
    expect(result.coveredPools).toEqual([pool]);
    expect(result.observations.map(row => row.volumeUsd)).toEqual(amounts);
    expect(pinnedOracleBlocks(fixture.calls)).toEqual([104]);
  });

  it('reads the exact first block when its timestamp matches the next round update second', async () => {
    const roundAt = (height: number) => height < 102
      ? { id: (3n << 64n) + 7n, updatedAt: at / 1_000 - 15, answer: 101_000_000 }
      : { id: (3n << 64n) + 8n, updatedAt: at / 1_000 + 1, answer: 98_000_000 };
    const fixture = fakeRpc({ logs: [], roundAt });
    const ingest = await warmPreviousOracleAnchor(fixture);
    fixture.settings.logs = [swap(101, 1, true), swap(102, 2, true), swap(104, 3, true)];

    const first = block(101), equalSecond = { ...block(102), timestamp: first.timestamp };
    const result = await ingest.scan([first, equalSecond, block(103), block(104)], { parentHash: hash(100) });
    expect(result.coveredPools).toEqual([pool]);
    expect(result.observations.map(row => row.volumeUsd)).toEqual([101, 98, 98]);
    expect(pinnedOracleBlocks(fixture.calls)).toEqual([104, 101, 102]);
  });

  it.each([
    ['missing parent hash', undefined, 3n, 8n],
    ['mismatched parent hash', hash(999), 3n, 8n],
    ['different phase', hash(100), 4n, 8n],
    ['skipped round', hash(100), 3n, 9n],
  ] as const)('checks the exact first block for a %s instead of borrowing the previous anchor', async (_label, parentHash, phase, round) => {
    const roundAt = (height: number) => height < 102
      ? { id: (3n << 64n) + 7n, updatedAt: at / 1_000 - 15, answer: 101_000_000 }
      : { id: (phase << 64n) + round, updatedAt: at / 1_000 + 2, answer: 98_000_000 };
    const fixture = fakeRpc({ logs: [], roundAt });
    const ingest = await warmPreviousOracleAnchor(fixture);
    fixture.settings.logs = [swap(101, 1, true), swap(104, 2, true)];

    const result = await ingest.scan([block(101), block(102), block(103), block(104)], { parentHash });
    expect(result.coveredPools).toEqual([pool]);
    expect(result.observations.map(row => row.volumeUsd)).toEqual([101, 98]);
    expect(pinnedOracleBlocks(fixture.calls)).toEqual([104, 101]);
  });

  it('leaves a pool uncovered when a preceding rate expires before its first new swap', async () => {
    const roundAt = (height: number) => height < 102
      ? { id: (3n << 64n) + 7n, updatedAt: at / 1_000 - TRUSTED_QUOTE_FEEDS[usdt].maxAgeSeconds, answer: 101_000_000 }
      : { id: (3n << 64n) + 8n, updatedAt: at / 1_000 + 2, answer: 98_000_000 };
    const fixture = fakeRpc({ logs: [], roundAt });
    const ingest = await warmPreviousOracleAnchor(fixture);
    fixture.settings.logs = [swap(101, 1, true), swap(104, 2, true)];

    const result = await ingest.scan([block(101), block(102), block(103), block(104)], { parentHash: hash(100) });
    expect(result).toMatchObject({ observations: [], coveredPools: [], stats: { unpricedPools: 1 } });
  });

  it('requires genuine and contiguous block identities and stops before optional work when collection needs the node', async () => {
    const fixture = fakeRpc({ logs: [{ ...swap(100, 0, true), blockHash: hash(99) }] });
    const ingest = createNodeMomentumIngest(fixture.rpc, { minimumObservations: 1 });
    await expect(ingest.scan([block(100)])).rejects.toThrow('momentum_scan_log_noncanonical');
    await expect(ingest.scan([block(100), block(102)])).rejects.toThrow('momentum_scan_range_invalid');
    fixture.settings.logs = [swap(100, 0, true)];
    let checks = 0;
    await expect(ingest.scan([block(100)], { shouldContinue: () => ++checks === 1 })).rejects.toThrow('momentum_scan_yielded');
    expect(fixture.calls.every(c => c.method === 'eth_getLogs')).toBe(true);
  });

  it('rejects conflicting duplicate positions and keeps malformed authenticated swaps out of coverage', async () => {
    const a = swap(100, 0, true), fixture = fakeRpc({ logs: [a, { ...a, transactionHash: hash(6) }] });
    const ingest = createNodeMomentumIngest(fixture.rpc, { minimumObservations: 1 });
    await expect(ingest.scan([block(100)])).rejects.toThrow('momentum_scan_log_conflict');
    fixture.settings.logs = [{ ...a, data: '0x1234' }];
    expect(await ingest.scan([block(100)])).toMatchObject({ observations: [], coveredPools: [], stats: { unpricedPools: 1 } });
  });

  it('uses the effective fill through extreme post-swap spot and ignores canonical zero-output dust', async () => {
    const a = swap(100, 0, true), b = swap(100, 1, true);
    const nearMinimum = 4295128740n;
    const values = [address, address, 100n * abs18, -20n * abs18, nearMinimum, 0n, -887271, 0, 0] as const;
    const exact = v3MarketAbi.encodeEventLog('Swap', [...values]);
    const dust = v3MarketAbi.encodeEventLog('Swap', [address, address, 1n, 0n, nearMinimum, 0n, -887271, 0, 0]);
    const fixture = fakeRpc({ logs: [{ ...a, ...exact }, { ...b, ...dust }] });
    const result = await createNodeMomentumIngest(fixture.rpc, { minimumObservations: 1 }).scan([block(100)]);
    expect(result.coveredPools).toEqual([pool]);
    expect(result.observations).toHaveLength(1);
    expect(result.observations[0]).toMatchObject({ volumeUsd: 101, priceUsd: 5.05 });
  });
});
