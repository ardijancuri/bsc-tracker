import { pool } from './db.js';
import { decimalUnits } from './intelligenceLogic.js';
import type { Rpc } from './rpc.js';

const addressPattern = /^0x[0-9a-f]{40}$/;
const wordPattern = /^0x[0-9a-fA-F]{64}$/;
const freshFor = 2 * 86400_000;
const validDecimals = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 36;
export interface TokenSupplyValue { raw: string; decimals: number; units: string; checkedAt: string }
export interface TokenSupplyMetadata { rawSupply?: string | null; decimals?: number | null; supplyCheckedAt?: string | Date | null }
export interface TokenSupplyState { supply: string | null; checkedAt: string | null; pending: boolean; retryAfterMs?: number }
type Query = (sql: string, values: unknown[]) => Promise<unknown>;

let rpcId = 0;
// Match the existing chain RPC endpoint, with a shorter deadline for page data.
const supplyRpc: Rpc = async <T>(method: string, params: unknown[]): Promise<T> => {
  const response = await fetch(process.env.BSC_RPC_HTTP || 'http://127.0.0.1:8545', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(3000),
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  });
  if (!response.ok) throw new Error('Token supply RPC unavailable');
  const body = await response.json();
  if (body?.error || body?.result == null) throw new Error('Token supply RPC unavailable');
  return body.result as T;
};

/** Read actual ERC-20 units. A missing supply is never estimated from market data. */
export async function readTokenSupply(address: string, decimals: number | null | undefined, rpc: Rpc = supplyRpc, now = Date.now): Promise<TokenSupplyValue | null> {
  if (!addressPattern.test(address)) throw new Error('Invalid token supply address');
  const [raw, precision] = await Promise.all([
    rpc<string>('eth_call', [{ to: address, data: '0x18160ddd' }, 'latest']),
    validDecimals(decimals) ? decimals : rpc<string>('eth_call', [{ to: address, data: '0x313ce567' }, 'latest']).then(value => {
      if (!wordPattern.test(value)) throw new Error('Invalid token decimals response');
      const parsed = Number(BigInt(value));
      if (!validDecimals(parsed)) throw new Error('Invalid token decimals response');
      return parsed;
    }),
  ]);
  if (!wordPattern.test(raw)) throw new Error('Invalid token supply response');
  const units = BigInt(raw);
  if (units <= 0n) return null;
  return { raw: units.toString(), decimals: precision, units: decimalUnits(units, precision), checkedAt: new Date(now()).toISOString() };
}

function knownSupply(metadata: TokenSupplyMetadata, now: number): TokenSupplyValue | null {
  if (!validDecimals(metadata.decimals) || !/^\d+$/.test(metadata.rawSupply || '')) return null;
  const checked = metadata.supplyCheckedAt ? new Date(metadata.supplyCheckedAt).getTime() : NaN;
  if (!Number.isFinite(checked) || checked > now + 30_000 || now - checked >= freshFor) return null;
  const raw = BigInt(metadata.rawSupply!);
  if (raw <= 0n) return null;
  return { raw: raw.toString(), decimals: metadata.decimals, units: decimalUnits(raw, metadata.decimals), checkedAt: new Date(checked).toISOString() };
}

/** One on-chain refresh per token, shared by every interval and viewer. */
export function createTokenSupplyRequests({ query = (sql, values) => pool.query(sql, values), rpc = supplyRpc, now = Date.now, waitMs = 250, retryMs = 30_000 }: {
  query?: Query; rpc?: Rpc; now?: () => number; waitMs?: number; retryMs?: number;
} = {}) {
  const saved = new Map<string, TokenSupplyValue>();
  const jobs = new Map<string, Promise<void>>();
  const retries = new Map<string, number>();
  const available = (address: string, metadata: TokenSupplyMetadata) => {
    const memory = saved.get(address);
    const recorded = knownSupply(metadata, now());
    if (memory && now() - Date.parse(memory.checkedAt) < freshFor) return !recorded || Date.parse(memory.checkedAt) >= Date.parse(recorded.checkedAt) ? memory : recorded;
    if (memory) saved.delete(address);
    return recorded;
  };
  const start = (address: string, metadata: TokenSupplyMetadata) => {
    if (!addressPattern.test(address)) throw new Error('Invalid token supply address');
    const snapshot = (): TokenSupplyState => {
      const value = available(address, metadata);
      if (value) return { supply: value.units, checkedAt: value.checkedAt, pending: false };
      return { supply: null, checkedAt: null, pending: jobs.has(address),
        retryAfterMs: jobs.has(address) ? 3000 : Math.max(1000, (retries.get(address) || now() + retryMs) - now()) };
    };
    if (!available(address, metadata) && !jobs.has(address) && now() >= (retries.get(address) || 0) && jobs.size < 32) {
      const job = (async () => {
        try {
          const value = await readTokenSupply(address, metadata.decimals, rpc, now);
          if (!value) throw new Error('Token has no positive supply');
          if (saved.size >= 500 && !saved.has(address)) saved.delete(saved.keys().next().value!);
          saved.set(address, value);
          retries.delete(address);
          // Publish verified units immediately; a persistence failure does not undo a successful chain read.
          await query('UPDATE tokens SET total_supply_raw=$2,decimals=$3,supply_checked_at=$4 WHERE address=$1', [address, value.raw, value.decimals, value.checkedAt]);
        } catch {
          retries.set(address, now() + retryMs);
        } finally { jobs.delete(address); }
      })();
      jobs.set(address, job);
    }
    return { snapshot, settle: async () => {
      const job = jobs.get(address);
      if (job && waitMs > 0) await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, waitMs);
        void job.then(() => { clearTimeout(timer); resolve(); });
      });
      return snapshot();
    } };
  };
  return { start };
}

export const tokenSupplyRequests = createTokenSupplyRequests();
