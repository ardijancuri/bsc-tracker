import { randomUUID } from 'node:crypto';
import { pool } from './db.js';

export interface KolTokenTradeRepairHint {
  txHash: string; walletAddress: string; tokenAddress: string; blockNumber: string; blockHash: string;
}
export interface KolTokenTradeRepairJob extends KolTokenTradeRepairHint {
  key: string; leaseId: string; attempts: number;
}
interface RecordValue extends KolTokenTradeRepairHint {
  version: 1; attempts: number; nextAttemptAt: number; requestedAt: number; leaseId: string | null;
}
type Client = { query: (sql: string, values?: unknown[]) => Promise<{ rows: any[] }>; release: () => void };
const prefix = 'kol_token_trade_repair:';
const address = /^0x[0-9a-f]{40}$/, hash = /^0x[0-9a-f]{64}$/;
const validHint = (value: KolTokenTradeRepairHint) => !!value && hash.test(value.txHash) && address.test(value.walletAddress)
  && address.test(value.tokenAddress) && hash.test(value.blockHash) && /^\d+$/.test(value.blockNumber) && Number.isSafeInteger(Number(value.blockNumber));
const keyOf = (value: KolTokenTradeRepairHint) => `${prefix}${value.txHash}:${value.walletAddress}:${value.tokenAddress}`;
const validRecord = (value: RecordValue, key: string) => validHint(value) && key === keyOf(value) && value.version === 1
  && Number.isSafeInteger(value.attempts) && value.attempts >= 0 && value.attempts <= 8
  && Number.isFinite(value.nextAttemptAt) && Number.isFinite(value.requestedAt)
  && (value.leaseId === null || typeof value.leaseId === 'string');

/** Only confirmed missing swaps discovered by the inventory scanner enter this
 * small durable queue. A worker must reverify their receipt before indexing. */
export function createKolTokenTradeRepairQueue({ connect = () => pool.connect(), now = Date.now }:
  { connect?: () => Promise<Client>; now?: () => number } = {}) {
  async function transaction<T>(work: (client: Client) => Promise<T>): Promise<T> {
    const client = await connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL statement_timeout='1000ms'");
      const result = await work(client); await client.query('COMMIT'); return result;
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { client.release(); }
  }
  return {
    async request(hint: KolTokenTradeRepairHint): Promise<void> {
      if (!validHint(hint)) return;
      await transaction(async client => {
        // Serialize admission so concurrent profile scans cannot exceed the cap.
        await client.query('SELECT pg_advisory_xact_lock(782323)');
        await client.query(`DELETE FROM worker_state WHERE left(key,length($1))=$1 AND updated_at < now() - interval '7 days'`, [prefix]);
        const existing = await client.query('SELECT value FROM worker_state WHERE key=$1 FOR UPDATE', [keyOf(hint)]);
        const previous = existing.rows[0]?.value as RecordValue | undefined;
        if (previous && validRecord(previous, keyOf(hint)) && previous.blockHash === hint.blockHash && previous.blockNumber === hint.blockNumber) return;
        const count = await client.query('SELECT COUNT(*)::int AS count FROM worker_state WHERE left(key,length($1))=$1', [prefix]);
        if (!previous && Number(count.rows[0]?.count) >= 128) return;
        const value: RecordValue = { ...hint, version: 1, attempts: 0, nextAttemptAt: now(), requestedAt: now(), leaseId: null };
        await client.query(`INSERT INTO worker_state(key,value,updated_at)
          SELECT $1,$2::jsonb,now() WHERE EXISTS(SELECT 1 FROM kols WHERE address=$3 AND is_tracked)
          ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()`, [keyOf(hint), JSON.stringify(value), hint.walletAddress]);
      });
    },
    async claim(limit = 4): Promise<KolTokenTradeRepairJob[]> {
      if (!Number.isInteger(limit) || limit < 1 || limit > 4) return [];
      return transaction(async client => {
        const candidates = await client.query(`SELECT key,value FROM worker_state WHERE left(key,length($1))=$1
          ORDER BY updated_at ASC LIMIT 128 FOR UPDATE SKIP LOCKED`, [prefix]);
        const jobs: KolTokenTradeRepairJob[] = [];
        for (const row of candidates.rows) {
          const value = row.value as RecordValue;
          if (!validRecord(value, row.key)) { await client.query('DELETE FROM worker_state WHERE key=$1', [row.key]); continue; }
          if (value.nextAttemptAt > now() || jobs.length >= limit) continue;
          const leaseId = randomUUID(), attempts = value.attempts >= 8 ? 1 : value.attempts + 1;
          const claimed: RecordValue = { ...value, leaseId, attempts, nextAttemptAt: now() + 120_000 };
          await client.query('UPDATE worker_state SET value=$2::jsonb,updated_at=now() WHERE key=$1', [row.key, JSON.stringify(claimed)]);
          jobs.push({ txHash: value.txHash, walletAddress: value.walletAddress, tokenAddress: value.tokenAddress,
            blockNumber: value.blockNumber, blockHash: value.blockHash, key: row.key, leaseId, attempts });
        }
        return jobs;
      });
    },
    async finish(job: KolTokenTradeRepairJob, success: boolean): Promise<void> {
      if (!validHint(job) || job.key !== keyOf(job) || typeof job.leaseId !== 'string'
        || !Number.isInteger(job.attempts) || job.attempts < 1 || job.attempts > 8) return;
      await transaction(async client => {
        if (success) await client.query(`DELETE FROM worker_state WHERE key=$1 AND value->>'leaseId'=$2`, [job.key, job.leaseId]);
        else {
          const delay = job.attempts >= 8 ? 3_600_000 : Math.min(300_000, 10_000 * 2 ** (job.attempts - 1));
          await client.query(`UPDATE worker_state SET value=jsonb_set(jsonb_set(value,'{nextAttemptAt}',$3::jsonb),'{leaseId}','null'::jsonb),updated_at=now()
            WHERE key=$1 AND value->>'leaseId'=$2`, [job.key, job.leaseId, String(now() + delay)]);
        }
      });
    },
  };
}

const queue = createKolTokenTradeRepairQueue();
export const requestKolTokenTradeRepair = queue.request;
export const claimKolTokenTradeRepairs = queue.claim;
export const finishKolTokenTradeRepair = queue.finish;
