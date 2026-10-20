import type { PoolClient } from 'pg';
import { isExcludedKolProfileTokenAddress, kolProfileTokenSql } from './kolProfileToken.js';

type Database = Pick<PoolClient, 'query'>;
export type PublicAccountingPair = { wallet: string; token: string; priority: number; throughBlock?: string | null };

/** Queue one preparation per public pair. A new movement may promote waiting
 * work, but cannot steal an active lease or bypass a provider/repair cooldown. */
export async function enqueuePublicNodeAccountingPairs(database: Database, pairs: PublicAccountingPair[]) {
  const selected = new Map<string, PublicAccountingPair>();
  for (const pair of pairs) {
    const wallet = pair.wallet.toLowerCase(), token = pair.token.toLowerCase();
    if (!/^0x[a-f0-9]{40}$/.test(wallet) || !/^0x[a-f0-9]{40}$/.test(token) || isExcludedKolProfileTokenAddress(token)) continue;
    const key = `${wallet}:${token}`, priority = Number.isFinite(pair.priority) ? Math.min(5, Math.max(0, Math.trunc(pair.priority))) : 0;
    const previous = selected.get(key), block = /^\d+$/.test(pair.throughBlock ?? '') ? pair.throughBlock! : null;
    const throughBlock = previous?.throughBlock && (block === null || BigInt(previous.throughBlock) > BigInt(block)) ? previous.throughBlock : block;
    selected.set(key, { wallet, token, priority: Math.max(previous?.priority ?? 0, priority), throughBlock });
  }
  if (!selected.size) return;
  await database.query(`INSERT INTO node_accounting_jobs(scope_key,wallet_address,token_address,scope,priority,requested_through_block)
    SELECT 'public',j.wallet,j.token,'{"kind":"public"}'::jsonb,j.priority,j."throughBlock"
    FROM jsonb_to_recordset($1::jsonb) j(wallet text,token text,priority integer,"throughBlock" bigint)
    JOIN kols k ON k.address=j.wallet AND k.is_tracked
    JOIN tokens v ON v.address=j.token AND ${kolProfileTokenSql('v')}
    ON CONFLICT(scope_key,wallet_address,token_address) DO UPDATE SET
      priority=CASE WHEN EXCLUDED.requested_through_block>COALESCE(node_accounting_jobs.requested_through_block,-1)
        THEN GREATEST(node_accounting_jobs.priority,EXCLUDED.priority) ELSE node_accounting_jobs.priority END,
      requested_through_block=GREATEST(node_accounting_jobs.requested_through_block,EXCLUDED.requested_through_block)`, [JSON.stringify([...selected.values()])]);
}

export interface NodeAccountingTickResult { claimed: number; active: number; updated: number; completed: number; wallets: string[] }

/** Each slot claims its own next job as soon as it finishes. A slow historical
 * pair cannot hold the other slots behind the slowest member of a batch. */
export async function runNodeAccountingWorkers(options: {
  tick(limit: number): Promise<NodeAccountingTickResult>;
  onProgress?(result: NodeAccountingTickResult): Promise<void> | void;
  onError?(error: unknown): Promise<void> | void;
  pause?(milliseconds: number): Promise<void>;
  signal?: AbortSignal;
}) {
  const pause = options.pause ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (!options.signal?.aborted) {
      try {
        const result = await options.tick(1);
        await options.onProgress?.(result);
        if (!result.claimed) await pause(1000);
      } catch (error) {
        await options.onError?.(error);
        await pause(1000);
      }
    }
  }));
}
