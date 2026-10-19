import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { CollectedNodeEvidence } from './nodeEvidence.js';
import { transferTopic } from './swap.js';
import {enqueueNodeTokenIdentities,ensureNodeTokenIdentitySchema} from './nodeTokenIdentity.js';

type Database = Pick<PoolClient, 'query'>;
export interface NodeEvidenceMetadataCheckpoint { blockNumber: number; blockHash: string; timestamp: string }
export interface NodeEvidenceMetadataEntry extends NodeEvidenceMetadataCheckpoint { tokens: string[]; observedLive: boolean }
type MetadataResult = { requested: number; captured: number; capturedTokens?: string[] };
type FeedResult = { requested: number; captured: number; quoteRequested?: number; quoteCaptured?: number };
const address = (value: unknown) => typeof value === 'string' && /^0x[a-f0-9]{40}$/i.test(value) ? value.toLowerCase() : null;
const topicAddress = (value: unknown) => typeof value === 'string' && /^0x0{24}[a-f0-9]{40}$/i.test(value) ? `0x${value.slice(-40)}`.toLowerCase() : null;

/** Called inside the evidence schema's serialized migration transaction. */
export async function ensureNodeEvidenceMetadataSchema(database: Database) {
  await database.query(`CREATE TABLE IF NOT EXISTS node_evidence_metadata_jobs(
    block_number bigint NOT NULL,block_hash text NOT NULL REFERENCES node_evidence_blocks(block_hash) ON DELETE CASCADE,
    timestamp timestamptz NOT NULL,tokens text[] NOT NULL DEFAULT '{}',completed_tokens text[] NOT NULL DEFAULT '{}',
    feed_complete boolean NOT NULL DEFAULT false,pinned_feed_complete boolean NOT NULL DEFAULT false,observed_live boolean NOT NULL DEFAULT false,
    attempts integer NOT NULL DEFAULT 0,next_attempt_at timestamptz NOT NULL DEFAULT now(),last_error text,
    lease_id uuid,lease_until timestamptz,completed_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY(block_number,block_hash));
    ALTER TABLE node_evidence_metadata_jobs ADD COLUMN IF NOT EXISTS pinned_feed_complete boolean NOT NULL DEFAULT false;
    ALTER TABLE node_evidence_metadata_jobs ADD COLUMN IF NOT EXISTS pinned_lease_id uuid;
    ALTER TABLE node_evidence_metadata_jobs ADD COLUMN IF NOT EXISTS pinned_lease_until timestamptz;
    ALTER TABLE node_evidence_metadata_jobs ADD COLUMN IF NOT EXISTS pinned_attempts integer NOT NULL DEFAULT 0;
    ALTER TABLE node_evidence_metadata_jobs ADD COLUMN IF NOT EXISTS pinned_next_attempt_at timestamptz NOT NULL DEFAULT now();
    ALTER TABLE node_evidence_metadata_jobs ADD COLUMN IF NOT EXISTS pinned_last_error text;
    CREATE INDEX IF NOT EXISTS node_evidence_metadata_pending ON node_evidence_metadata_jobs(next_attempt_at,block_number DESC)
      WHERE completed_at IS NULL;
    CREATE INDEX IF NOT EXISTS node_evidence_metadata_pins_pending ON node_evidence_metadata_jobs(pinned_next_attempt_at,block_number)
      WHERE completed_at IS NULL AND NOT pinned_feed_complete;`);
  await ensureNodeTokenIdentitySchema(database);
}

/** Only database writes occur here. A missing price, precision or metadata
 * provider must never prevent permanent raw collection/checkpoint commits. */
export async function enqueueNodeEvidenceMetadata(database: Database, entries: CollectedNodeEvidence[]) {
  const blocks = new Map<string, NodeEvidenceMetadataEntry>();
  for (const entry of entries) {
    const blockHash = entry.block.hash.toLowerCase(), existing = blocks.get(blockHash) ?? {
      blockNumber: Number(BigInt(entry.block.number)), blockHash,
      timestamp: new Date(Number(BigInt(entry.block.timestamp)) * 1000).toISOString(), tokens: [], observedLive: false,
    };
    existing.observedLive ||= entry.observedLive;
    for (const log of entry.receipt.logs) {
      if (log.topics[0]?.toLowerCase() !== transferTopic || log.topics.length !== 3) continue;
      const from = topicAddress(log.topics[1]), to = topicAddress(log.topics[2]), token = address(log.address);
      if (token && (from && entry.wallets.has(from) || to && entry.wallets.has(to))) existing.tokens.push(token);
    }
    blocks.set(blockHash, existing);
  }
  return enqueueNodeEvidenceMetadataCheckpoints(database, [...blocks.values()]);
}

/** Queue authenticated market swaps as well as tracked-wallet receipts. The
 * caller holds its existing canonical range transaction/rollback lock. Header
 * identity is checked here too: backfill without permanent canonical evidence
 * cannot manufacture a metadata checkpoint. No RPC or nested transaction. */
export async function enqueueNodeEvidenceMetadataCheckpoints(database: Database, entries: NodeEvidenceMetadataEntry[]) {
  const blocks = new Map<string, { block_number: string; block_hash: string; timestamp: string; tokens: Set<string>; observed_live: boolean }>();
  for (const entry of entries) {
    if (!Number.isSafeInteger(entry.blockNumber) || entry.blockNumber < 0 || !/^0x[a-f0-9]{64}$/i.test(entry.blockHash)
      || !Number.isFinite(Date.parse(entry.timestamp)) || typeof entry.observedLive !== 'boolean') throw new TypeError('Invalid node metadata checkpoint');
    const key = `${entry.blockNumber}:${entry.blockHash.toLowerCase()}`, timestamp = new Date(entry.timestamp).toISOString();
    const row = blocks.get(key) ?? { block_number: String(entry.blockNumber), block_hash: entry.blockHash.toLowerCase(), timestamp, tokens: new Set<string>(), observed_live: false };
    if (row.timestamp !== timestamp) throw new TypeError('Contradictory node metadata timestamp');
    row.observed_live ||= entry.observedLive;
    for (const candidate of entry.tokens) {
      const token = address(candidate);
      if (!token) throw new TypeError('Invalid node metadata token');
      row.tokens.add(token);
    }
    blocks.set(key, row);
  }
  if (!blocks.size) return { requested: 0, queued: 0 };
  const rows = [...blocks.values()].map(row => ({ ...row, tokens: [...row.tokens].sort() }));
  const result = await database.query(`INSERT INTO node_evidence_metadata_jobs(block_number,block_hash,timestamp,tokens,observed_live)
    SELECT q.block_number,q.block_hash,q.timestamp,q.tokens,q.observed_live FROM jsonb_to_recordset($1::jsonb)
      AS q(block_number bigint,block_hash text,timestamp timestamptz,tokens text[],observed_live boolean)
    JOIN node_evidence_blocks b ON b.block_number=q.block_number AND b.block_hash=q.block_hash AND b.timestamp=q.timestamp
    ON CONFLICT(block_number,block_hash) DO UPDATE SET
      tokens=ARRAY(SELECT DISTINCT token FROM unnest(node_evidence_metadata_jobs.tokens||EXCLUDED.tokens) token ORDER BY token),
      observed_live=node_evidence_metadata_jobs.observed_live OR EXCLUDED.observed_live,
      feed_complete=node_evidence_metadata_jobs.feed_complete AND EXCLUDED.tokens<@node_evidence_metadata_jobs.tokens,
      completed_at=CASE WHEN node_evidence_metadata_jobs.feed_complete AND EXCLUDED.tokens<@node_evidence_metadata_jobs.completed_tokens
        THEN node_evidence_metadata_jobs.completed_at ELSE NULL END,
      next_attempt_at=CASE WHEN NOT EXCLUDED.tokens<@node_evidence_metadata_jobs.tokens THEN LEAST(node_evidence_metadata_jobs.next_attempt_at,now())
        ELSE node_evidence_metadata_jobs.next_attempt_at END,updated_at=now() RETURNING block_number`, [JSON.stringify(rows)]);
  await enqueueNodeTokenIdentities(database,rows.flatMap(row=>row.tokens.map(tokenAddress=>({tokenAddress,blockNumber:Number(row.block_number),
    blockHash:row.block_hash,timestamp:row.timestamp}))));
  return { requested: blocks.size, queued: result.rowCount ?? 0 };
}

/** Independent urgent evidence stage: no transaction is held during node RPC.
 * Completed token chunks and feed proofs survive partial failures/restarts. */
export async function drainNodeEvidenceMetadata(options: {
  database: Pick<Pool, 'query'>;
  captureMetadata(tokens: string[], checkpoint: NodeEvidenceMetadataCheckpoint): Promise<MetadataResult>;
  captureFeedEvidence(checkpoint: NodeEvidenceMetadataCheckpoint, tokens?: string[], options?: { conversions?: boolean }): Promise<FeedResult>;
  limit?: number;
  priorityTokens?: string[];
  /** Precision, fixed feeds and route work share progress but have bounded
   * reserved worker slots. Fixed feeds own an independent lease/retry clock. */
  stage?: 'precision' | 'pins' | 'feed' | 'all';
  history?: 'fresh' | 'historical' | 'any';
  headBlock?: number;
}) {
  const lease = randomUUID(), limit = Math.max(1, Math.min(8, options.limit ?? 1));
  const stage = options.stage ?? 'all', history = options.history ?? 'any';
  // Fixed feeds and token precision have independent durable ownership and
  // retry clocks. Each invocation still runs one bounded stage, so the worker
  // pool can reserve slots without adding concurrent RPCs inside a slot.
  const pins = stage === 'pins';
  const leaseId = pins ? 'pinned_lease_id' : 'lease_id', leaseUntil = pins ? 'pinned_lease_until' : 'lease_until';
  const nextAttempt = pins ? 'pinned_next_attempt_at' : 'next_attempt_at';
  const headBlock = Number.isSafeInteger(options.headBlock) && options.headBlock! >= 0 ? options.headBlock : null;
  const priorityTokens = [...new Set((options.priorityTokens ?? []).map(address).filter((token): token is string => token !== null))];
  const fresh = "block_number>=h.minimum_block AND timestamp>=now()-interval '5 minutes'";
  const rows = await options.database.query(`WITH horizon AS(SELECT GREATEST(0,GREATEST(max(block_number),$6::bigint)-128) AS minimum_block FROM node_evidence_blocks)
    UPDATE node_evidence_metadata_jobs j SET ${leaseId}=$1::uuid,${leaseUntil}=clock_timestamp()+interval '10 seconds' FROM(
    SELECT block_number,block_hash FROM node_evidence_metadata_jobs CROSS JOIN horizon h WHERE completed_at IS NULL AND ${nextAttempt}<=now()
      AND (${leaseUntil} IS NULL OR ${leaseUntil}<clock_timestamp())
      AND ($4::text='all' OR $4='precision' AND NOT tokens<@completed_tokens
        OR $4='pins' AND NOT pinned_feed_complete
        OR $4='feed' AND NOT feed_complete AND pinned_feed_complete AND tokens<@completed_tokens)
      AND ($5::text='any' OR $5='fresh' AND (${fresh}) OR $5='historical' AND NOT(${fresh}))
    ORDER BY CASE WHEN ${fresh} THEN 0 ELSE 1 END,
      CASE WHEN ${fresh} THEN block_number END ASC,
      CASE WHEN ${fresh} AND tokens&&$3::text[] THEN 0 ELSE 1 END,
      CASE WHEN ${fresh} AND observed_live THEN 0 ELSE 1 END,${nextAttempt},block_number DESC
    LIMIT $2::integer FOR UPDATE SKIP LOCKED) q WHERE j.block_number=q.block_number AND j.block_hash=q.block_hash RETURNING j.*`,
  [lease, limit, priorityTokens, stage, history, headBlock]);
  let completed = 0, waiting = 0, capturedTokens = 0;
  if (!rows.rows.length) return { claimed: 0, completed, waiting, capturedTokens };
  // State survives only about 128 blocks. A killed worker's ninety-second
  // lease used to outlive that entire budget. Renew short leases while alive;
  // a crashed process relinquishes them before otherwise usable state prunes.
  // Renew all claimed rows, including rows awaiting an earlier RPC in a batch.
  const heights = rows.rows.map(row => row.block_number);
  let renewing: Promise<void> | null = null;
  const heartbeat = setInterval(() => {
    if (renewing) return;
    renewing = options.database.query(`UPDATE node_evidence_metadata_jobs SET ${leaseUntil}=clock_timestamp()+interval '10 seconds'
      WHERE ${leaseId}=$1::uuid AND block_number=ANY($2::bigint[]) AND ${leaseUntil}>clock_timestamp()`, [lease, heights])
      .then(() => undefined, () => undefined).finally(() => { renewing = null; });
  }, 2_000);
  heartbeat.unref();
  try {
  for (const row of rows.rows) {
    const checkpoint: NodeEvidenceMetadataCheckpoint = { blockNumber: Number(row.block_number), blockHash: row.block_hash,
      timestamp: new Date(row.timestamp).toISOString() };
    const pending: string[] = row.tokens.filter((token: string) => !row.completed_tokens.includes(token));
    let reason: string | null = null;
    const progress = async (tokens: string[], feedComplete: boolean, pinnedComplete = false) => {
      await options.database.query(`UPDATE node_evidence_metadata_jobs SET
        completed_tokens=ARRAY(SELECT DISTINCT token FROM unnest(completed_tokens||$4::text[]) token ORDER BY token),
        feed_complete=feed_complete OR ($5::boolean AND tokens<@$6::text[]),
        pinned_feed_complete=pinned_feed_complete OR $5::boolean OR $7::boolean,
        ${leaseUntil}=clock_timestamp()+interval '10 seconds',updated_at=now()
        WHERE block_number=$1::bigint AND block_hash=$2 AND ${leaseId}=$3::uuid AND ${leaseUntil}>clock_timestamp()`, [row.block_number, row.block_hash, lease, tokens, feedComplete, row.tokens, pinnedComplete]);
    };
    // Precision never waits for fixed feeds. Separate pinned workers can own
    // this same checkpoint while token chunks remain in flight.
    if (stage !== 'feed' && !pins) for (let offset = 0; offset < pending.length; offset += 20) {
      const chunk = pending.slice(offset, offset + 20);
      try {
        const result = await options.captureMetadata(chunk, checkpoint);
        const successful = result.capturedTokens ? [...new Set(result.capturedTokens.map(address).filter((token): token is string => token !== null && chunk.includes(token)))]
          : result.requested === chunk.length && result.captured === chunk.length ? chunk : [];
        if (successful.length) { await progress(successful, false); capturedTokens += successful.length; }
        if (successful.length !== chunk.length) reason = 'token_metadata_unavailable';
      } catch { reason = 'token_metadata_unavailable'; }
    }
    if (pins && !row.pinned_feed_complete) {
      try {
        // These fixed feed calls never enter token-market route discovery.
        // Tokenless fee-paying receipts need this fast lane too. A pinned-only
        // result cannot certify the job's remaining conversion dependencies.
        const pinned = await options.captureFeedEvidence(checkpoint, [], { conversions: false });
        if (pinned.requested > 0 && pinned.captured === pinned.requested) await progress([], false, true);
        else reason ??= 'feed_evidence_unavailable';
      } catch { reason ??= 'feed_evidence_unavailable'; }
    }
    if (stage !== 'precision' && !pins && !row.feed_complete) {
      let complete = true;
      // Quote dependencies are scoped to the transferred tokens. Cover every
      // target even in large receipt blocks; services keep each call bounded.
      const scopes: string[][] = row.tokens.length ? Array.from({ length: Math.ceil(row.tokens.length / 20) }, (_, index) => row.tokens.slice(index * 20, index * 20 + 20)) : [[]];
      for (const tokens of scopes) {
        try {
          const result = await options.captureFeedEvidence(checkpoint, tokens);
          if (result.requested <= 0 || result.captured !== result.requested) {
            complete = false;
            reason ??= result.quoteRequested !== undefined && result.quoteCaptured !== result.quoteRequested ? 'quote_evidence_unavailable' : 'feed_evidence_unavailable';
          }
        } catch { complete = false; reason ??= 'feed_evidence_unavailable'; }
      }
      if (complete) await progress([], true);
    }
    const finished = pins ? await options.database.query(`UPDATE node_evidence_metadata_jobs SET
      completed_at=CASE WHEN feed_complete AND tokens<@completed_tokens THEN now() ELSE NULL END,
      pinned_attempts=CASE WHEN pinned_feed_complete THEN pinned_attempts ELSE pinned_attempts+1 END,
      pinned_next_attempt_at=CASE WHEN pinned_feed_complete THEN now() ELSE now()+
        LEAST(900,(CASE WHEN timestamp<now()-interval '5 minutes' OR block_number<h.minimum_block THEN 30 ELSE 2 END)*POWER(2,LEAST(8,pinned_attempts)))::integer*interval '1 second' END,
      pinned_last_error=CASE WHEN pinned_feed_complete THEN NULL
        WHEN timestamp<now()-interval '5 minutes' OR block_number<h.minimum_block THEN 'historical_'||COALESCE($4::text,'evidence_incomplete') ELSE COALESCE($4::text,'evidence_incomplete') END,
      pinned_lease_id=NULL,pinned_lease_until=NULL,updated_at=now()
      FROM(SELECT GREATEST(0,max(block_number)-128) AS minimum_block FROM node_evidence_blocks)h
      WHERE block_number=$1::bigint AND block_hash=$2 AND pinned_lease_id=$3::uuid AND pinned_lease_until>clock_timestamp() RETURNING completed_at`, [row.block_number,row.block_hash,lease,reason]) : await options.database.query(`UPDATE node_evidence_metadata_jobs SET
      completed_at=CASE WHEN feed_complete AND tokens<@completed_tokens THEN now() ELSE NULL END,
      attempts=CASE WHEN feed_complete AND tokens<@completed_tokens OR $5::text='precision' AND tokens<@completed_tokens THEN attempts ELSE attempts+1 END,
      next_attempt_at=CASE WHEN feed_complete AND tokens<@completed_tokens OR $5::text='precision' AND tokens<@completed_tokens THEN now() ELSE now()+
        LEAST(900,(CASE WHEN timestamp<now()-interval '5 minutes' OR block_number<h.minimum_block THEN 30 ELSE 2 END)*POWER(2,LEAST(8,attempts)))::integer*interval '1 second' END,
      last_error=CASE WHEN feed_complete AND tokens<@completed_tokens THEN NULL
        WHEN $5::text='precision' AND tokens<@completed_tokens THEN NULL
        WHEN timestamp<now()-interval '5 minutes' OR block_number<h.minimum_block THEN 'historical_'||COALESCE($4::text,'evidence_incomplete') ELSE COALESCE($4::text,'evidence_incomplete') END,
      lease_id=NULL,lease_until=NULL,updated_at=now()
      FROM(SELECT GREATEST(0,max(block_number)-128) AS minimum_block FROM node_evidence_blocks)h
      WHERE block_number=$1::bigint AND block_hash=$2 AND lease_id=$3::uuid AND lease_until>clock_timestamp() RETURNING completed_at`, [row.block_number, row.block_hash, lease, reason, stage]);
    if (finished.rows[0]?.completed_at) completed++; else if (finished.rows.length) waiting++;
  }
  return { claimed: rows.rows.length, completed, waiting, capturedTokens };
  } finally {
    clearInterval(heartbeat);
    if (renewing) await renewing;
    // Normal return or an unexpected database failure releases only this
    // invocation's ownership. A replacement worker's lease is never cleared.
    await options.database.query(`UPDATE node_evidence_metadata_jobs SET ${leaseId}=NULL,${leaseUntil}=NULL
      WHERE ${leaseId}=$1::uuid AND block_number=ANY($2::bigint[])`, [lease, heights]);
  }
}
