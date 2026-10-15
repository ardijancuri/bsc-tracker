import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { KolTokenActivity } from '../shared/kolTokenTrades.js';
import { createRecentTradeRepair } from './recentTradeRepair.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/smartAccountSale.json', import.meta.url), 'utf8'));
const saleHeight = Number(BigInt(fixture.block.number)), time = Number(BigInt(fixture.block.timestamp)) * 1000 + 60_000;
const h = (value: number) => '0x' + value.toString(16).padStart(64, '0');
const hex = (value: number) => `0x${value.toString(16)}`;
function scenario() {
  const evidence = structuredClone(fixture);
  const activity = { kol: { address: fixture.wallet }, token: { address: fixture.token }, coverage: { complete: true },
    trades: [{ walletAddress: fixture.wallet, tokenAddress: fixture.token, txHash: h(1), blockNumber: String(saleHeight - 20) }] } as KolTokenActivity;
  let head = saleHeight + 5006, clock = time;
  const enqueue = vi.fn(async () => {});
  const rpc = vi.fn(async (method: string, params: unknown[], _signal: AbortSignal): Promise<any> => {
    if (method === 'eth_chainId') return '0x38';
    if (method === 'eth_blockNumber') return hex(head);
    if (method === 'eth_getBlockByNumber') {
      const height = Number(BigInt(params[0] as string));
      return height === saleHeight ? evidence.block : { number: hex(height), hash: h(height), timestamp: hex(Math.floor(time / 1000) - (height < saleHeight ? 70 : 5)) };
    }
    if (method === 'eth_getLogs') {
      const filter = params[0] as { fromBlock: string; toBlock: string };
      return Number(BigInt(filter.fromBlock)) <= saleHeight && Number(BigInt(filter.toBlock)) >= saleHeight
        ? evidence.receipt.logs.filter((log: any) => log.address === fixture.token && log.topics[1] === '0x' + fixture.wallet.slice(2).padStart(64, '0')) : [];
    }
    if (method === 'eth_getTransactionByHash') return evidence.tx;
    if (method === 'eth_getTransactionReceipt') return evidence.receipt;
    throw Error(method);
  });
  return { activity, evidence, rpc, enqueue, now: () => clock, setHead: (value: number) => { head = value; }, setClock: (value: number) => { clock = value; } };
}

describe('recent missing swap repair on pruned nodes', () => {
  it('queues the authenticated AA closing sale without reading pruned opening state or asserting PNL', async () => {
    const s = scenario(), load = createRecentTradeRepair(s);
    expect(await load(s.activity)).toBe('pending');
    expect(s.enqueue).toHaveBeenCalledExactlyOnceWith({ walletAddress: fixture.wallet, tokenAddress: fixture.token,
      txHash: fixture.tx.hash, blockNumber: String(saleHeight), blockHash: fixture.block.hash });
    expect(s.rpc.mock.calls.every(([method]) => method !== 'eth_call')).toBe(true);
    for (const [, params] of s.rpc.mock.calls.filter(([method]) => method === 'eth_getLogs')) {
      const range = params[0] as { fromBlock: string; toBlock: string };
      expect(Number(BigInt(range.toBlock)) - Number(BigInt(range.fromBlock))).toBeLessThan(4096);
    }
    const calls = s.rpc.mock.calls.length;
    expect(await load(s.activity)).toBe('pending');
    expect(s.rpc).toHaveBeenCalledTimes(calls); expect(s.enqueue).toHaveBeenCalledTimes(1);
  });

  it('resumes the remaining confirmed range without repeating pages or queued repairs', async () => {
    const s = scenario(), load = createRecentTradeRepair({ ...s, pagesPerCall: 1 });
    expect(await load(s.activity)).toBe('pending');
    expect(s.rpc.mock.calls.filter(([method]) => method === 'eth_getLogs')).toHaveLength(1);
    expect(await load(s.activity)).toBe('pending');
    const scans = s.rpc.mock.calls.filter(([method]) => method === 'eth_getLogs');
    expect(scans).toHaveLength(2);
    expect((scans[1][1][0] as any).fromBlock).toBe(hex(saleHeight - 20 + 4096));
    expect(s.enqueue).toHaveBeenCalledTimes(1);
  });

  it('coalesces simultaneous callers for the same wallet, token and indexed snapshot', async () => {
    const s = scenario(), load = createRecentTradeRepair(s);
    expect(await Promise.all([load(s.activity), load(s.activity)])).toEqual(['pending', 'pending']);
    expect(s.enqueue).toHaveBeenCalledTimes(1);
  });

  it.each(['another-wallet', 'failed-operation', 'reorg', 'unconfirmed', 'removed-log', 'wrong-chain', 'malformed-log'])(
    'never queues %s evidence', async variant => {
      const s = scenario();
      if (variant === 'another-wallet') s.evidence.tx.to = '0x' + '3'.repeat(40);
      if (variant === 'failed-operation') s.evidence.receipt.status = '0x0';
      if (variant === 'reorg') s.evidence.block.hash = h(200);
      if (variant === 'unconfirmed') s.setHead(saleHeight + 5);
      if (variant === 'removed-log') s.evidence.receipt.logs[1].removed = true;
      if (variant === 'wrong-chain') s.rpc.mockImplementationOnce(async () => '0x1');
      if (variant === 'malformed-log') s.evidence.receipt.logs[1].blockNumber = '0xz';
      await createRecentTradeRepair(s)(s.activity);
      expect(s.enqueue).not.toHaveBeenCalled();
    });

  it('skips already indexed swaps and invalidates cached scan results when the indexed snapshot changes', async () => {
    const s = scenario(), load = createRecentTradeRepair(s);
    expect(await load(s.activity)).toBe('pending');
    s.activity.trades.push({ ...s.activity.trades[0], txHash: fixture.tx.hash, blockNumber: String(saleHeight) });
    expect(await load(s.activity)).toBe('none'); expect(s.enqueue).toHaveBeenCalledTimes(1);
  });

  it.each(['block-limit', 'time-limit', 'stale-head', 'incomplete-trades'])(
    'does not scan beyond the %s bound', async variant => {
      const s = scenario();
      if (variant === 'block-limit') s.setHead(saleHeight + 200_007);
      if (variant === 'stale-head') s.setClock(time + 180_001);
      if (variant === 'incomplete-trades') s.activity.coverage.complete = false;
      if (variant === 'time-limit') {
        const original = s.rpc.getMockImplementation()!;
        s.rpc.mockImplementation(async (method, params, signal) => {
          const value = await original(method, params, signal);
          return method === 'eth_getBlockByNumber' && params[0] === hex(saleHeight - 20)
            ? { ...value, timestamp: hex(Math.floor(time / 1000) - 86410) } : value;
        });
      }
      expect(await createRecentTradeRepair(s)(s.activity)).toBe('none');
      expect(s.rpc.mock.calls.some(([method]) => method === 'eth_getLogs')).toBe(false); expect(s.enqueue).not.toHaveBeenCalled();
    });

  it('adapts oversized page ranges without ever exceeding the original bound', async () => {
    const s = scenario(), original = s.rpc.getMockImplementation()!;
    let rejected = false;
    s.rpc.mockImplementation(async (method, params, signal) => {
      if (method === 'eth_getLogs' && !rejected) { rejected = true; throw Error('inventory_range_too_large'); }
      return original(method, params, signal);
    });
    expect(await createRecentTradeRepair(s)(s.activity)).toBe('pending');
    const scans = s.rpc.mock.calls.filter(([method]) => method === 'eth_getLogs');
    expect((scans[1][1][0] as any).toBlock).toBe(hex(saleHeight - 20 + 2047)); expect(s.enqueue).toHaveBeenCalledTimes(1);
  });

  it('keeps a timed-out page available for retry, without claiming no missing trades', async () => {
    const s = scenario(), original = s.rpc.getMockImplementation()!;
    let hanging = true;
    s.rpc.mockImplementation(async (method, params, signal) => {
      if (method === 'eth_getTransactionReceipt' && hanging) return new Promise(() => {});
      return original(method, params, signal);
    });
    const load = createRecentTradeRepair({ ...s, budgetMs: 10 });
    expect(await load(s.activity)).toBe('pending'); expect(s.enqueue).not.toHaveBeenCalled();
    hanging = false;
    expect(await load(s.activity)).toBe('pending'); expect(s.enqueue).toHaveBeenCalledTimes(1);
    expect(s.rpc.mock.calls.filter(([method]) => method === 'eth_getLogs')).toHaveLength(2);
  });

  it('does not mark a repair queued when the durable queue rejects it', async () => {
    const s = scenario(); s.enqueue.mockRejectedValueOnce(Error('queue unavailable'));
    const load = createRecentTradeRepair(s);
    expect(await load(s.activity)).toBe('none');
    s.setClock(time + 16_000);
    expect(await load(s.activity)).toBe('pending'); expect(s.enqueue).toHaveBeenCalledTimes(2);
  });

  it('caps authenticated repairs at four per snapshot even when more missing swaps are discovered', async () => {
    const s = scenario(), original = s.rpc.getMockImplementation()!;
    const transactions = Array.from({ length: 5 }, (_, index) => {
      const item = structuredClone(fixture), txHash = h(100 + index);
      item.tx.hash = txHash; item.receipt.transactionHash = txHash;
      for (const log of item.receipt.logs) log.transactionHash = txHash;
      return item;
    });
    s.rpc.mockImplementation(async (method, params, signal) => {
      if (method === 'eth_getLogs') return transactions.map(item => item.receipt.logs[1]);
      if (method === 'eth_getTransactionByHash') return transactions.find(item => item.tx.hash === params[0])!.tx;
      if (method === 'eth_getTransactionReceipt') return transactions.find(item => item.tx.hash === params[0])!.receipt;
      return original(method, params, signal);
    });
    expect(await createRecentTradeRepair(s)(s.activity)).toBe('pending');
    expect(s.enqueue).toHaveBeenCalledTimes(4);
  });
});
