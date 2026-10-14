import type { KolTokenBalanceProof } from '../shared/kolTokenTrades.js';

type Rpc = (method: string, params: unknown[], signal: AbortSignal) => Promise<unknown>;
export interface KolTokenBalanceRequest { wallet: string; token: string; decimals?: number | null }
const addressPattern = /^0x[0-9a-f]{40}$/;
const hashPattern = /^0x[0-9a-f]{64}$/i;
const wordPattern = /^0x[0-9a-f]{64}$/i;
const quantityPattern = /^0x(?:0|[1-9a-f][0-9a-f]*)$/i;
const validDecimals = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 36;
class BalanceFailure extends Error {}
const fail = (reason: string): never => { throw new BalanceFailure(reason); };
const quantity = (value: unknown, reason: string) => {
  if (typeof value !== 'string' || !quantityPattern.test(value)) return fail(reason);
  const parsed = Number(BigInt(value));
  if (!Number.isSafeInteger(parsed) || parsed < 0) return fail(reason);
  return parsed;
};
const units = (raw: bigint, decimals: number) => {
  if (!decimals) return raw.toString();
  const digits = raw.toString().padStart(decimals + 1, '0');
  return `${digits.slice(0, -decimals)}.${digits.slice(-decimals)}`.replace(/\.?0+$/, '');
};
let rpcId = 0;
// Current confirmed state is available on the ordinary node, even when its
// historical receipts and state have been pruned. Never send these to an archive.
const balanceRpc: Rpc = async (method, params, signal) => {
  const response = await fetch(process.env.BSC_RPC_HTTP || 'http://127.0.0.1:8545', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal,
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  });
  if (!response.ok) return fail('balance_rpc_unavailable');
  const body = await response.json();
  if (body?.error || body?.result == null) return fail('balance_rpc_unavailable');
  return body.result;
};

/** Prove the current balance only. This deliberately makes no claim about the
 * completeness of historical swaps or transfers supplied by a provider. */
export function createKolTokenBalance({ rpc = balanceRpc, now = Date.now, budgetMs = 5000 }: {
  rpc?: Rpc; now?: () => number; budgetMs?: number;
} = {}) {
  return async (request: KolTokenBalanceRequest, signal?: AbortSignal): Promise<KolTokenBalanceProof> => {
    const wallet = request.wallet.toLowerCase(), token = request.token.toLowerCase();
    if (!addressPattern.test(wallet) || !addressPattern.test(token)) return fail('balance_address_invalid');
    if (request.decimals != null && !validDecimals(request.decimals)) return fail('balance_decimals_invalid');
    const controller = new AbortController();
    const abort = () => controller.abort(new BalanceFailure('balance_aborted'));
    if (signal?.aborted) return fail('balance_aborted');
    signal?.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(() => controller.abort(new BalanceFailure('balance_timeout')), Math.max(1, Math.min(5000, budgetMs)));
    const call = (method: string, params: unknown[]) => new Promise<unknown>((resolve, reject) => {
      const aborted = () => reject(controller.signal.reason);
      if (controller.signal.aborted) { aborted(); return; }
      controller.signal.addEventListener('abort', aborted, { once: true });
      Promise.resolve().then(() => {
        if (controller.signal.aborted) throw controller.signal.reason;
        return rpc(method, params, controller.signal);
      }).then(resolve, reject).finally(() => controller.signal.removeEventListener('abort', aborted));
    });
    const block = async (height: number) => {
      const raw = await call('eth_getBlockByNumber', [`0x${height.toString(16)}`, false]);
      if (!raw || typeof raw !== 'object') return fail('balance_block_invalid');
      const data = raw as Record<string, unknown>;
      if (quantity(data.number, 'balance_block_invalid') !== height || typeof data.hash !== 'string' || !hashPattern.test(data.hash)) return fail('balance_block_invalid');
      const timestamp = quantity(data.timestamp, 'balance_block_invalid');
      if (!Number.isSafeInteger(timestamp * 1000)) return fail('balance_block_invalid');
      const age = now() - timestamp * 1000;
      if (!Number.isFinite(age)) return fail('balance_block_invalid');
      if (age < 0) return fail('balance_block_future');
      if (age > 180_000) return fail('balance_block_stale');
      return { hash: data.hash.toLowerCase(), timestamp };
    };
    try {
      const [chain, headValue] = await Promise.all([call('eth_chainId', []), call('eth_blockNumber', [])]);
      if (quantity(chain, 'balance_chain_mismatch') !== 56) return fail('balance_chain_mismatch');
      const head = quantity(headValue, 'balance_block_invalid');
      if (head < 6) return fail('balance_block_invalid');
      const height = head - 6, blockTag = `0x${height.toString(16)}`;
      const before = await block(height);
      const [precision, raw] = await Promise.all([
        call('eth_call', [{ to: token, data: '0x313ce567' }, blockTag]),
        call('eth_call', [{ to: token, data: `0x70a08231${wallet.slice(2).padStart(64, '0')}` }, blockTag]),
      ]);
      if (typeof precision !== 'string' || !wordPattern.test(precision)) return fail('balance_decimals_invalid');
      const decimals = Number(BigInt(precision));
      if (!validDecimals(decimals)) return fail('balance_decimals_invalid');
      if (request.decimals != null && request.decimals !== decimals) return fail('balance_decimals_mismatch');
      if (typeof raw !== 'string' || !wordPattern.test(raw)) return fail('balance_response_invalid');
      const after = await block(height);
      if (before.hash !== after.hash || before.timestamp !== after.timestamp) return fail('balance_reorg');
      if (controller.signal.aborted) throw controller.signal.reason;
      return { walletAddress: wallet, tokenAddress: token, chain: 'bsc', blockNumber: String(height), blockHash: after.hash, blockTimestamp: new Date(after.timestamp * 1000).toISOString(),
        balance: units(BigInt(raw), decimals), checkedAt: new Date(now()).toISOString() };
    } catch (error) {
      if (controller.signal.aborted) throw controller.signal.reason;
      if (error instanceof BalanceFailure) throw error;
      return fail('balance_rpc_unavailable');
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
    }
  };
}

export const currentKolTokenBalance = createKolTokenBalance();
