import { createHash } from 'node:crypto';
import type { KolTokenActivity } from '../shared/kolTokenTrades.js';
import { createInventoryRpc } from './kolTokenInventoryRpc.js';
import { requestKolTokenTradeRepair, type KolTokenTradeRepairHint } from './kolTokenTradeRepair.js';
import { verifiedTradeRepair } from './verifiedTradeRepair.js';
import { transferTopic } from './swap.js';

type Rpc = (method: string, params: unknown[], signal: AbortSignal) => Promise<any>;
type Result = 'pending' | 'none';
type Block = { number: string; hash: string; timestamp: string };
type Candidate = { txHash: string; blockNumber: number; blockHash: string };
type State = { createdAt: number; target: number; endpoint: Block; next: number; pageSize: number;
  page?: { end: number; candidates: Candidate[] }; queued: Set<string>; completed?: Result; until?: number };
const address = /^0x[0-9a-f]{40}$/, hash = /^0x[0-9a-f]{64}$/, hexValue = /^0x[0-9a-f]+$/i;
const hex = (value: number) => `0x${value.toString(16)}`;
const heightOf = (value: unknown): number | null => {
  if (typeof value !== 'string' || !hexValue.test(value)) return null;
  const parsed = Number(BigInt(value)); return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
};
function bounded<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) { operation.catch(() => {}); abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    operation.then(value => { signal.removeEventListener('abort', abort); resolve(value); }, error => {
      signal.removeEventListener('abort', abort); reject(error);
    });
  });
}

/** A pruned first purchase must not prevent discovery of a recent missing AA
 * closing sale. This bounded tail scan only submits independently authenticated
 * swap hints to the existing repair queue; it never claims historical coverage,
 * changes balances, or calculates P&L. The worker reverifies every hint. */
export function createRecentTradeRepair({ rpc = createInventoryRpc({ archive: () => '' }),
  enqueue = requestKolTokenTradeRepair, now = Date.now, budgetMs = 5000, pagesPerCall = 12,
}: { rpc?: Rpc; enqueue?: (hint: KolTokenTradeRepairHint) => Promise<void>; now?: () => number;
  budgetMs?: number; pagesPerCall?: number } = {}) {
  const states = new Map<string, State>(), jobs = new Map<string, Promise<Result>>();
  const maxPages = Math.max(1, Math.min(50, Math.floor(pagesPerCall)));
  return async (activity: KolTokenActivity, callerSignal?: AbortSignal): Promise<Result> => {
    const wallet = activity.kol.address.toLowerCase(), token = activity.token.address.toLowerCase();
    if (!address.test(wallet) || !address.test(token) || !activity.coverage.complete || !activity.trades.length || callerSignal?.aborted) return 'none';
    const indexed = new Set<string>(); let first = 0;
    for (const trade of activity.trades) {
      const height = Number(trade.blockNumber);
      if (trade.walletAddress.toLowerCase() !== wallet || trade.tokenAddress.toLowerCase() !== token
        || !hash.test(trade.txHash.toLowerCase()) || !/^\d+$/.test(trade.blockNumber ?? '') || !Number.isSafeInteger(height)) return 'none';
      indexed.add(trade.txHash.toLowerCase()); first = Math.max(first, height);
    }
    const key = createHash('sha256').update(JSON.stringify([wallet, token, first, [...indexed].sort()])).digest('hex');
    const previous = jobs.get(key); if (previous) return previous;
    if (jobs.size >= 2) return 'pending';
    for (const [savedKey, saved] of states) if (now() - saved.createdAt > 300_000) states.delete(savedKey);
    while (states.size >= 32 && !states.has(key)) {
      const removable = [...states.keys()].find(savedKey => !jobs.has(savedKey));
      if (!removable) return 'pending'; states.delete(removable);
    }
    const cached = states.get(key);
    if (cached?.completed && (cached.until ?? 0) > now()) return cached.completed;
    if (cached?.completed) states.delete(key);
    const work = async (): Promise<Result> => {
      const timeout = AbortSignal.timeout(Math.max(1, Math.min(5000, budgetMs)));
      const signal = callerSignal ? AbortSignal.any([timeout, callerSignal]) : timeout;
      const call = (method: string, params: unknown[]) => bounded(Promise.resolve().then(() => {
        if (signal.aborted) throw signal.reason; return rpc(method, params, signal);
      }), signal);
      const block = async (height: number): Promise<Block> => {
        const value = await call('eth_getBlockByNumber', [hex(height), false]);
        if (!value || heightOf(value.number) !== height || !hash.test(value.hash?.toLowerCase() ?? '') || heightOf(value.timestamp) === null)
          throw Error('recent_block_invalid');
        return { number: value.number, hash: value.hash.toLowerCase(), timestamp: value.timestamp };
      };
      let state = states.get(key);
      const finish = (result: Result) => {
        if (state) { state.completed = result; state.until = now() + (result === 'pending' ? 30_000 : 15_000); }
        return result;
      };
      try {
        const chain = await call('eth_chainId', []), head = heightOf(await call('eth_blockNumber', []));
        if (chain !== '0x38' || head === null || head < 6 || first > head - 6) return 'none';
        if (state && (await block(state.target)).hash !== state.endpoint.hash) { states.delete(key); state = undefined; }
        if (!state) {
          const target = head - 6;
          if (target - first > 200_000) return 'none';
          const [start, endpoint] = await Promise.all([block(first), block(target)]);
          const endpointTime = heightOf(endpoint.timestamp)! * 1000, startTime = heightOf(start.timestamp)! * 1000;
          if (endpointTime > now() || now() - endpointTime > 180_000 || startTime > endpointTime || endpointTime - startTime > 86_400_000) return 'none';
          state = { createdAt: now(), target, endpoint, next: first, pageSize: 4096, queued: new Set() }; states.set(key, state);
        }
        let pages = 0;
        while (state.next <= state.target && pages < maxPages) {
          if (!state.page) {
            const end = Math.min(state.target, state.next + state.pageSize - 1);
            let logs: any;
            try { logs = await call('eth_getLogs', [{ address: token, fromBlock: hex(state.next), toBlock: hex(end),
              topics: [transferTopic, `0x${wallet.slice(2).padStart(64, '0')}`] }]); }
            catch (error) {
              if (!signal.aborted && error instanceof Error && error.message === 'inventory_range_too_large' && state.pageSize > 256) {
                state.pageSize = Math.max(256, Math.floor(state.pageSize / 2)); continue;
              }
              throw error;
            }
            if (!Array.isArray(logs) || logs.length > 256) throw Error('recent_logs_invalid');
            const candidates = new Map<string, Candidate>();
            for (const log of logs) {
              const height = heightOf(log?.blockNumber), txHash = String(log?.transactionHash ?? '').toLowerCase();
              if (log?.removed || log?.address?.toLowerCase() !== token || log?.topics?.length !== 3
                || log.topics[0]?.toLowerCase() !== transferTopic || log.topics[1]?.toLowerCase() !== `0x${wallet.slice(2).padStart(64, '0')}`
                || !/^0x0{24}[0-9a-f]{40}$/i.test(log.topics[2] ?? '') || !hash.test(log.blockHash?.toLowerCase() ?? '')
                || !hash.test(txHash) || height === null || height < state.next || height > end || !/^0x[0-9a-f]{64}$/i.test(log.data ?? ''))
                throw Error('recent_logs_invalid');
              if (!indexed.has(txHash) && !state.queued.has(txHash) && BigInt(log.data) > 0n)
                candidates.set(txHash, { txHash, blockNumber: height, blockHash: log.blockHash.toLowerCase() });
            }
            if (candidates.size > 32) throw Error('recent_candidate_limit');
            state.page = { end, candidates: [...candidates.values()] };
          }
          while (state.page.candidates.length) {
            const candidate = state.page.candidates[0];
            const [tx, receipt, canonical] = await Promise.all([
              call('eth_getTransactionByHash', [candidate.txHash]), call('eth_getTransactionReceipt', [candidate.txHash]), block(candidate.blockNumber),
            ]);
            const hint = { txHash: candidate.txHash, walletAddress: wallet, tokenAddress: token,
              blockNumber: String(candidate.blockNumber), blockHash: candidate.blockHash };
            if (receipt && Array.isArray(receipt.logs) && verifiedTradeRepair(hint, tx, receipt, canonical, head)) {
              await bounded(enqueue(hint), signal); state.queued.add(candidate.txHash);
              if (state.queued.size >= 4) return finish('pending');
            }
            state.page.candidates.shift();
          }
          state.next = state.page.end + 1; state.page = undefined; pages++;
        }
        if (state.next <= state.target) return 'pending';
        if ((await block(state.target)).hash !== state.endpoint.hash) { states.delete(key); return 'pending'; }
        return finish(state.queued.size ? 'pending' : 'none');
      } catch {
        if (signal.aborted && state) return 'pending';
        return finish(state?.queued.size ? 'pending' : 'none');
      }
    };
    const job = work(); jobs.set(key, job);
    try { return await job; } finally { jobs.delete(key); }
  };
}

export const currentRecentTradeRepair = createRecentTradeRepair();
