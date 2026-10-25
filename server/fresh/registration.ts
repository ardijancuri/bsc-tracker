import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { Rpc } from '../rpc.js';
import { blockHex } from '../rpc.js';
import { collectFreshPage, decodeFreshEvidence, encodeFreshEvidence, freshAddress, freshHash, freshInteger,
  FRESH_CONFIRMATIONS, FRESH_EVIDENCE_TTL_MS, type FreshCapturedPage, type FreshCapturedReceipt } from './capture.js';

export interface FreshRegistrationProgress {
  fromBlock: number; throughBlock: number; throughHash: string; targetBlock: number; targetHash: string; startBlock: number; startHash: string;
}
const integer = (value: unknown) => { const number = Number(value); if (!Number.isSafeInteger(number) || number < 0) throw new Error('registration_block_invalid'); return number; };
function progress(value: unknown): FreshRegistrationProgress {
  const row = value as Partial<FreshRegistrationProgress> | undefined;
  if (!row || !freshHash(row.throughHash) || !freshHash(row.targetHash) || !freshHash(row.startHash)) throw new Error('registration_progress_invalid');
  const parsed = { fromBlock: integer(row.fromBlock), throughBlock: integer(row.throughBlock), throughHash: row.throughHash!, targetBlock: integer(row.targetBlock), targetHash: row.targetHash!, startBlock: integer(row.startBlock), startHash: row.startHash! };
  if (parsed.fromBlock <= parsed.startBlock || parsed.throughBlock < parsed.fromBlock - 1 || parsed.throughBlock > parsed.targetBlock || parsed.targetBlock < parsed.fromBlock) throw new Error('registration_progress_invalid');
  return parsed;
}

/** Caller owns its registration transaction and the capture checkpoint lock.
 * The target is immutable confirmed coverage, never a newly chosen time that
 * could hide the wallet's original subscription boundary. */
export async function queueFreshRegistrationRepair(client: PoolClient, options: { wallet: string; fromBlock: number; targetBlock: number; targetHash?: string; now?: Date }) {
  const wallet = freshAddress(options.wallet); if (!wallet) throw new Error('registration_wallet_invalid');
  const fromBlock = integer(options.fromBlock), targetBlock = integer(options.targetBlock), now = options.now ?? new Date();
  if (targetBlock < fromBlock) return { queued: false, jobId: null };
  const capture = (await client.query("SELECT * FROM fresh.checkpoints WHERE key='capture' FOR UPDATE")).rows[0];
  if (!capture || !freshHash(capture.value?.startHash)) throw new Error('tracking_boundary_uninitialized');
  const startBlock = integer(capture.value.startBlock), startHash = capture.value.startHash;
  if (fromBlock <= startBlock || targetBlock > Number(capture.block_number)) throw new Error('registration_outside_confirmed_tracking');
  const headers = (await client.query('SELECT block_number,block_hash,occurred_at FROM fresh.recent_blocks WHERE block_number=ANY($1::bigint[])', [[fromBlock - 1, fromBlock, targetBlock]])).rows;
  const header = (number: number) => headers.find(row => Number(row.block_number) === number);
  const first = header(fromBlock), target = header(targetBlock), parent = fromBlock - 1 === startBlock ? startHash : header(fromBlock - 1)?.block_hash;
  if (!first || !target || !freshHash(parent)) throw new Error('registration_evidence_unavailable');
  if (Date.parse(first.occurred_at) <= now.getTime() - FRESH_EVIDENCE_TTL_MS) throw new Error('registration_outside_repair_window');
  if (options.targetHash && target.block_hash !== options.targetHash.toLowerCase()) throw new Error('registration_target_changed');
  const existing = (await client.query("SELECT * FROM fresh.jobs WHERE kind='registration_capture' AND reference=$1 FOR UPDATE", [wallet])).rows[0];
  let saved: FreshRegistrationProgress = { fromBlock, throughBlock: fromBlock - 1, throughHash: parent, targetBlock, targetHash: target.block_hash, startBlock, startHash };
  if (existing) {
    const previous = progress(existing.progress);
    if (previous.fromBlock !== fromBlock || previous.startHash !== startHash || previous.targetBlock > targetBlock || previous.targetBlock === targetBlock && previous.targetHash !== target.block_hash) throw new Error('registration_boundary_changed');
    if (existing.state === 'unavailable') throw new Error(existing.last_error || 'registration_evidence_unavailable');
    saved = { ...previous, targetBlock, targetHash: target.block_hash };
  }
  const jobId = `registration:${wallet}`;
  await client.query(`INSERT INTO fresh.jobs(id,kind,reference,priority,state,progress,due_at) VALUES($1,'registration_capture',$2,40,'pending',$3::jsonb,$4)
    ON CONFLICT(kind,reference) DO UPDATE SET progress=EXCLUDED.progress,due_at=least(fresh.jobs.due_at,EXCLUDED.due_at),updated_at=clock_timestamp()`, [jobId, wallet, JSON.stringify(saved), now]);
  return { queued: true, jobId };
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
}
const evidenceDigest = (value: FreshCapturedReceipt) => createHash('sha256').update(canonicalJson({ transaction: value.transaction, receipt: value.receipt })).digest('hex');

/** The transaction and receipt stay one canonical body. Adding a subscriber
 * changes only collection context; it cannot replace gas, logs or traces. */
export function mergeFreshRegistrationEvidence(existing: FreshCapturedReceipt | null, incoming: FreshCapturedReceipt, wallet: string) {
  if (!incoming.wallets.includes(wallet)) throw new Error('registration_wallet_evidence_missing');
  if (existing && evidenceDigest(existing) !== evidenceDigest(incoming)) throw new Error('registration_receipt_contradiction');
  if (existing?.wallets.includes(wallet)) return { value: existing, changed: false };
  const value: FreshCapturedReceipt = { ...(existing ?? incoming), wallets: [...new Set([...(existing?.wallets ?? []), ...incoming.wallets])].sort(),
    historicalWallets: [...new Set([...(existing?.historicalWallets ?? []), wallet])].sort() };
  return { value, changed: true };
}

/** Caller owns transaction. Exported for rollback-only integration fixtures. */
export async function commitFreshRegistrationPage(client: PoolClient, job: { id: string; reference: string; lease_id: string; progress: FreshRegistrationProgress }, page: FreshCapturedPage, now = new Date()) {
  if (page.previous.blockNumber !== job.progress.throughBlock || page.previous.blockHash !== job.progress.throughHash || page.blocks.length === 0
    || Number(freshInteger(page.blocks.at(-1)!.number)) > job.progress.targetBlock) throw new Error('registration_page_progress_mismatch');
  // Same ordering as decoding and reorg rollback; no network occurs here.
  await client.query('SELECT pg_advisory_xact_lock(73621941)');
  const capture = (await client.query("SELECT * FROM fresh.checkpoints WHERE key='capture' FOR SHARE")).rows[0];
  const locked = (await client.query('SELECT * FROM fresh.jobs WHERE id=$1 FOR UPDATE', [job.id])).rows[0];
  if (!locked || locked.lease_id !== job.lease_id || canonicalJson(locked.progress) !== canonicalJson(job.progress)) throw new Error('registration_lease_changed');
  if (!capture || capture.value?.startHash !== job.progress.startHash || Number(capture.block_number) < job.progress.targetBlock) throw new Error('registration_capture_reorged');
  const blocks = (await client.query('SELECT block_number,block_hash,parent_hash,occurred_at,captured_at FROM fresh.recent_blocks WHERE block_number=ANY($1::bigint[]) ORDER BY block_number FOR SHARE', [page.blocks.map(block => Number(freshInteger(block.number)))])).rows;
  if (blocks.length !== page.blocks.length) throw new Error('registration_evidence_unavailable');
  for (const [index, block] of page.blocks.entries()) {
    const saved = blocks[index];
    if (Number(saved.block_number) !== Number(freshInteger(block.number)) || saved.block_hash !== block.hash.toLowerCase() || saved.parent_hash !== block.parentHash.toLowerCase()) throw new Error('registration_capture_reorged');
    if (Date.parse(saved.occurred_at) <= now.getTime() - FRESH_EVIDENCE_TTL_MS) throw new Error('registration_outside_repair_window');
  }
  let receipts = 0;
  for (const entry of page.receipts) {
    const prior = (await client.query('SELECT payload,expires_at FROM fresh.recent_evidence WHERE tx_hash=$1 AND block_hash=$2 FOR UPDATE', [entry.transaction.hash.toLowerCase(), entry.receipt.blockHash.toLowerCase()])).rows[0];
    const merged = mergeFreshRegistrationEvidence(prior ? decodeFreshEvidence(prior.payload) : null, entry, job.reference);
    if (!merged.changed) continue;
    const header = blocks.find(block => Number(block.block_number) === Number(freshInteger(entry.receipt.blockNumber)))!;
    const expiresAt = prior?.expires_at ?? new Date(Math.min(now.getTime(), Date.parse(header.captured_at)) + FRESH_EVIDENCE_TTL_MS);
    await client.query(`INSERT INTO fresh.recent_evidence(tx_hash,block_hash,block_number,transaction_index,payload,wallet_addresses,expires_at,decoder_status,decoder_version)
      VALUES($1,$2,$3,$4,$5,$6,$7,'pending',0) ON CONFLICT(tx_hash,block_hash) DO UPDATE SET payload=EXCLUDED.payload,wallet_addresses=EXCLUDED.wallet_addresses,
        decoder_status='pending',last_error=NULL`, [entry.transaction.hash.toLowerCase(), entry.receipt.blockHash.toLowerCase(), Number(freshInteger(entry.receipt.blockNumber)), Number(freshInteger(entry.transaction.transactionIndex)), encodeFreshEvidence(merged.value), merged.value.wallets, expiresAt]);
    receipts++;
  }
  const last = page.blocks.at(-1);
  if (!last) throw new Error('registration_empty_page');
  const updated = { ...job.progress, throughBlock: Number(freshInteger(last.number)), throughHash: last.hash.toLowerCase() };
  const completed = updated.throughBlock === updated.targetBlock;
  if (completed && updated.throughHash !== updated.targetHash) throw new Error('registration_target_changed');
  if (completed) await client.query('DELETE FROM fresh.jobs WHERE id=$1', [job.id]);
  else await client.query("UPDATE fresh.jobs SET progress=$2::jsonb,state='pending',lease_id=NULL,lease_until=NULL,last_error=NULL,due_at=$3,updated_at=clock_timestamp() WHERE id=$1", [job.id, JSON.stringify(updated), now]);
  return { blocks: page.blocks.length, receipts, completed };
}

/** One bounded, leased repair page. Live collection always gets priority. */
export async function runFreshRegistrationRepair(database: Pool, rpc: Rpc, options: { limitBlocks?: number; now?: Date } = {}) {
  const now = options.now ?? new Date(), empty = { blocks: 0, receipts: 0, completed: false };
  const candidate = (await database.query("SELECT 1 FROM fresh.jobs WHERE kind='registration_capture' AND state='pending' AND due_at<=$1 AND (lease_until IS NULL OR lease_until<=$1) LIMIT 1", [now])).rowCount;
  if (!candidate) return empty;
  const capture = (await database.query("SELECT * FROM fresh.checkpoints WHERE key='capture'")).rows[0];
  const head = Number(freshInteger(await rpc<string>('eth_blockNumber', [])));
  if (!capture || head - FRESH_CONFIRMATIONS - Number(capture.block_number) > 32) return { ...empty, yielded: true, reason: 'live_capture_priority' };
  const lease = randomUUID(), claimed = (await database.query(`UPDATE fresh.jobs SET lease_id=$2,lease_until=$1::timestamptz+interval '45 seconds',updated_at=clock_timestamp()
    WHERE id=(SELECT id FROM fresh.jobs WHERE kind='registration_capture' AND state='pending' AND due_at<=$1 AND (lease_until IS NULL OR lease_until<=$1)
      ORDER BY priority DESC,due_at,id FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`, [now, lease])).rows[0];
  if (!claimed) return empty;
  try {
    const saved = progress(claimed.progress), wallet = freshAddress(claimed.reference); if (!wallet) throw new Error('registration_wallet_invalid');
    const parent = saved.throughBlock === saved.startBlock ? { block_hash: saved.startHash } : (await database.query('SELECT block_hash FROM fresh.recent_blocks WHERE block_number=$1', [saved.throughBlock])).rows[0];
    if (!parent || parent.block_hash !== saved.throughHash) throw new Error('registration_capture_reorged');
    const page = await collectFreshPage({ rpc, checkpoint: { blockNumber: saved.throughBlock, blockHash: saved.throughHash, revision: 0, startBlock: saved.startBlock, startHash: saved.startHash },
      wallets: [{ address: wallet, fromBlock: saved.fromBlock }], head: saved.targetBlock + FRESH_CONFIRMATIONS, limit: Math.min(16, Math.max(1, options.limitBlocks ?? 16)), now,
      launchDiscovery: false, collectCreations: false });
    if (page.blocks.length) {
      const ending = page.blocks.at(-1)!, canonical = await rpc<{ number: string; hash: string }>('eth_getBlockByNumber', [blockHex(freshInteger(ending.number).toString()), false]);
      if (!canonical || canonical.hash.toLowerCase() !== ending.hash.toLowerCase() || freshInteger(canonical.number) !== freshInteger(ending.number)) throw new Error('registration_capture_reorged');
    }
    const client = await database.connect();
    try { await client.query('BEGIN'); const result = await commitFreshRegistrationPage(client, { ...claimed, progress: saved }, page, now); await client.query('COMMIT'); return result; }
    catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  } catch (error) {
    const reason = error instanceof Error ? error.message.slice(0, 128) : 'registration_capture_unavailable';
    const terminal = ['registration_outside_repair_window', 'registration_evidence_unavailable', 'registration_progress_invalid', 'registration_wallet_invalid', 'registration_receipt_contradiction'].includes(reason);
    const client = await database.connect();
    try {
      await client.query('BEGIN');
      const saved = (await client.query('SELECT * FROM fresh.jobs WHERE id=$1 AND lease_id=$2 FOR UPDATE', [claimed.id, lease])).rows[0];
      if (saved) {
        await client.query(`UPDATE fresh.jobs SET state=$3,attempts=attempts+1,lease_id=NULL,lease_until=NULL,last_error=$4,
          due_at=$5::timestamptz+least(600,30*power(2,least(attempts,5)))*interval '1 second',updated_at=clock_timestamp() WHERE id=$1 AND lease_id=$2`, [claimed.id, lease, terminal ? 'unavailable' : 'pending', reason, now]);
        if (terminal) {
          const last = Number(saved.progress?.throughBlock), gap = Number.isSafeInteger(last) && last >= 0 ? last + 1 : null;
          await client.query('UPDATE fresh.wallets SET decode_gap_from_block=least(decode_gap_from_block,coalesce($2::bigint,monitoring_from_block)),decode_gap_reason=$3 WHERE address=$1', [claimed.reference, gap, reason]);
        }
      }
      await client.query('COMMIT');
    } catch (saveError) { await client.query('ROLLBACK'); throw saveError; } finally { client.release(); }
    return { ...empty, reason };
  }
}
