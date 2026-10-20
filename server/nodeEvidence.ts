import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { readBlockRange } from './blockRange.js';
import { validateCollectedReceipt } from './journalCollection.js';
import { transferTopic } from './swap.js';
import { userOperationTopic } from './smartAccountTrades.js';
import { decodeNodeExecutions, ensureNodeExecutionSchema, NODE_ENTRY_POINTS, NODE_EXECUTION_VERSION, persistNodeExecutions, type NodeBlock, type NodeReceipt, type NodeTransaction } from './nodeExecution.js';
import { enqueueNodeEvidenceMetadata, ensureNodeEvidenceMetadataSchema } from './nodeEvidenceMetadata.js';
import {rollbackNodeTokenIdentities} from './nodeTokenIdentity.js';
import { enqueuePublicNodeAccountingPairs } from './nodeAccountingQueue.js';
import { ensureNodeEvidenceCoverageSchema, persistNodeEvidenceCoverageCohort } from './nodeEvidenceCoverage.js';
export { drainNodeEvidenceMetadata } from './nodeEvidenceMetadata.js';

export type NodeEvidenceDatabase = Pick<Pool, 'query' | 'connect'>;
type Database = Pick<PoolClient, 'query'>;
export type NodeRpc = <T>(method: string, params: unknown[]) => Promise<T>;
export type CollectedNodeEvidence = { transaction: NodeTransaction; receipt: NodeReceipt; block: NodeBlock; wallets: Set<string>; observedLive: boolean };
export type NodeEvidenceProjectionResult = void | { pendingReason?: string };
async function invalidateDecodedFinancialEvidence(database:Database,pairs:{wallet:string;token:string}[],wallets:string[]){
  const selected=[...new Map(pairs.map(pair=>[`${pair.wallet}:${pair.token}`,pair])).values()];
  const tables=(await database.query(`SELECT name,to_regclass(name) IS NOT NULL AS available,
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass(name) AND attname='token_address' AND NOT attisdropped) AS token_column
    FROM unnest(ARRAY['node_accounting_history','node_accounting_snapshots','node_accounting_snapshot_versions'])name`)).rows;
  for(const table of tables)if(table.available&&(selected.length||!table.token_column))await database.query(`UPDATE ${table.name} stored
    SET invalidated_at=clock_timestamp()${table.name==='node_accounting_snapshots'?',last_valid=NULL':''}
    WHERE ${table.token_column?`EXISTS(SELECT 1 FROM jsonb_to_recordset($1::jsonb) affected(wallet text,token text)
      WHERE affected.wallet=stored.wallet_address AND affected.token=stored.token_address)`:'wallet_address=ANY($1::text[])'}`,
    [table.token_column?JSON.stringify(selected):wallets]);
  const leaderboard=(await database.query(`SELECT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('leaderboard_snapshots')
    AND attname='node_accounting' AND NOT attisdropped) AS available`)).rows[0]?.available;
  if(leaderboard&&wallets.length)await database.query(`UPDATE leaderboard_snapshots SET node_accounting=NULL
    WHERE period='1d' AND wallet_address=ANY($1::text[]) AND node_accounting IS NOT NULL`,[wallets]);
}
const hex = (value: number) => `0x${value.toString(16)}`;
const address = (raw: unknown) => typeof raw === 'string' && /^0x[0-9a-f]{40}$/i.test(raw) ? raw.toLowerCase() : null;
const hash = (raw: unknown) => typeof raw === 'string' && /^0x[0-9a-f]{64}$/i.test(raw) ? raw.toLowerCase() : null;
const topicAddress = (wallet: string) => `0x${wallet.slice(2).padStart(64, '0')}`;

export async function ensureNodeEvidenceSchema(pool: NodeEvidenceDatabase) {
  const database = await pool.connect();
  try {
    await database.query('BEGIN');
    await database.query('SELECT pg_advisory_xact_lock(782342)');
    await createNodeEvidenceSchema(database);
    await database.query('COMMIT');
  } catch (error) { await database.query('ROLLBACK'); throw error; } finally { database.release(); }
}

async function createNodeEvidenceSchema(database: Database) {
  await database.query(`CREATE TABLE IF NOT EXISTS node_monitored_wallets(wallet_address text PRIMARY KEY,generation uuid NOT NULL,active boolean NOT NULL,
    registered_at timestamptz NOT NULL DEFAULT now(),registration_block bigint,registration_hash text,collected_through_block bigint,decoded_through_block bigint,
    repair_from_block bigint,last_error text,updated_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS node_evidence_blocks(block_number bigint PRIMARY KEY,block_hash text NOT NULL UNIQUE,parent_hash text NOT NULL,timestamp timestamptz NOT NULL,header jsonb NOT NULL);
    CREATE TABLE IF NOT EXISTS node_evidence_ranges(id bigserial PRIMARY KEY,from_block bigint NOT NULL,to_block bigint NOT NULL,head_block bigint NOT NULL,repair_wallet text,
      wallets jsonb NOT NULL,observed_at timestamptz NOT NULL DEFAULT now(),decoded_at timestamptz,CHECK(to_block>=from_block));
    CREATE INDEX IF NOT EXISTS node_evidence_ranges_pending ON node_evidence_ranges(from_block,id) WHERE decoded_at IS NULL;
    CREATE TABLE IF NOT EXISTS node_evidence_transactions(tx_hash text PRIMARY KEY,block_number bigint NOT NULL,block_hash text NOT NULL,transaction_index integer NOT NULL,
      timestamp timestamptz NOT NULL,transaction jsonb NOT NULL,receipt jsonb NOT NULL,observed_live boolean NOT NULL DEFAULT false,
      decoded_version integer,decode_reason text,decode_attempts integer NOT NULL DEFAULT 0,next_decode_at timestamptz NOT NULL DEFAULT now(),
      lease_id uuid,lease_until timestamptz,projection_at timestamptz,projection_reason text);
    CREATE INDEX IF NOT EXISTS node_evidence_transactions_pending ON node_evidence_transactions(next_decode_at,block_number) WHERE decoded_version IS NULL;
    CREATE INDEX IF NOT EXISTS node_evidence_transactions_block ON node_evidence_transactions(block_number);
    CREATE TABLE IF NOT EXISTS node_evidence_wallets(tx_hash text NOT NULL REFERENCES node_evidence_transactions(tx_hash) ON DELETE CASCADE,wallet_address text NOT NULL,
      PRIMARY KEY(tx_hash,wallet_address));
    CREATE INDEX IF NOT EXISTS node_evidence_wallets_wallet ON node_evidence_wallets(wallet_address,tx_hash);
    CREATE TABLE IF NOT EXISTS node_trace_evidence(tx_hash text PRIMARY KEY REFERENCES node_evidence_transactions(tx_hash) ON DELETE CASCADE,block_hash text NOT NULL,
      trace jsonb NOT NULL,checked_at timestamptz NOT NULL DEFAULT now());
    ALTER TABLE node_monitored_wallets ADD COLUMN IF NOT EXISTS historical_gap_from bigint;
    ALTER TABLE node_monitored_wallets ADD COLUMN IF NOT EXISTS historical_gap_to bigint;
    CREATE TABLE IF NOT EXISTS node_capture_bootstraps(id uuid PRIMARY KEY,boundary_block bigint NOT NULL,boundary_hash text NOT NULL,
      boundary_timestamp timestamptz NOT NULL,previous_checkpoint jsonb,gap_from bigint,gap_to bigint,wallets jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),invalidated_at timestamptz);
    CREATE TABLE IF NOT EXISTS node_collection_gaps(id uuid PRIMARY KEY REFERENCES node_capture_bootstraps(id),from_block bigint NOT NULL,to_block bigint NOT NULL,
      reason text NOT NULL,recorded_at timestamptz NOT NULL DEFAULT now(),CHECK(to_block>=from_block));`);
  await ensureNodeEvidenceCoverageSchema(database);
  await ensureNodeExecutionSchema(database);
  await ensureNodeEvidenceMetadataSchema(database);
}

/** Old prototype headers do not establish a collection cursor. A migration
 * without one must explicitly record its gap before starting a fresh segment. */
export async function nodeCaptureStart(database: Database, options: { target: number; configuredStart?: number }) {
  if (!Number.isSafeInteger(options.target) || options.target < 0) throw new Error('node_capture_target_invalid');
  const state = (await database.query("SELECT value FROM worker_state WHERE key='node_collection'")).rows[0]?.value;
  if (state != null) {
    const height = Number(state.blockNumber);
    if (!Number.isSafeInteger(height) || height < 0 || !hash(state.blockHash)) throw new Error('node_collection_checkpoint_invalid');
    if (height > options.target) throw new Error('node_head_behind_collection_checkpoint');
    return height + 1;
  }
  const legacy = (await database.query(`SELECT EXISTS(SELECT 1 FROM node_evidence_blocks)
    OR EXISTS(SELECT 1 FROM processed_blocks) OR EXISTS(SELECT 1 FROM node_evidence_ranges) AS present`)).rows[0]?.present;
  if (legacy) throw new Error('node_capture_bootstrap_required');
  const configured = options.configuredStart;
  return configured != null && Number.isSafeInteger(configured) && configured > 0 ? configured : Math.max(0, options.target - 12);
}

/** Operator-only one-shot transition; never called implicitly on a failed
 * collection range. Preserves old evidence and records the uncollected gap. */
export async function bootstrapNodeCapture(options: { database: NodeEvidenceDatabase; rpc: NodeRpc; enabled: boolean }) {
  if (!options.enabled) throw new Error('node_capture_bootstrap_not_enabled');
  const head = Number(BigInt(await options.rpc<string>('eth_blockNumber', []))), boundary = Math.max(0, head - 6);
  if (!Number.isSafeInteger(head) || head < 6) throw new Error('node_capture_bootstrap_head_invalid');
  const block = await options.rpc<NodeBlock | null>('eth_getBlockByNumber', [hex(boundary), false]);
  if (!block || Number(BigInt(block.number)) !== boundary || !hash(block.hash) || !hash(block.parentHash) || !/^0x[0-9a-f]+$/i.test(block.timestamp)) throw new Error('node_capture_bootstrap_boundary_invalid');
  const client = await options.database.connect(), id = randomUUID();
  try {
    await client.query('BEGIN'); await client.query('SELECT pg_advisory_xact_lock(782319)');
    const canonical = await options.rpc<NodeBlock | null>('eth_getBlockByNumber', [hex(boundary), false]);
    if (!canonical || Number(BigInt(canonical.number)) !== boundary || canonical.hash.toLowerCase() !== block.hash.toLowerCase()) throw new Error('node_capture_bootstrap_boundary_changed');
    const previous = (await client.query("SELECT value FROM worker_state WHERE key='node_collection' FOR UPDATE")).rows[0]?.value ?? null;
    if (previous && Number(previous.blockNumber) > boundary) throw new Error('node_head_behind_collection_checkpoint');
    if (previous && Number(previous.blockNumber) === boundary && previous.blockHash === block.hash.toLowerCase()) {
      await client.query('COMMIT'); return { id: (previous.bootstrapId ?? null) as string | null, boundary, blockHash: block.hash.toLowerCase(), alreadyApplied: true };
    }
    const prior = (await client.query(`SELECT MIN(height)::text AS height FROM(
      SELECT MIN(block_number) AS height FROM node_evidence_blocks UNION ALL SELECT MIN(block_number) FROM processed_blocks
      UNION ALL SELECT MIN(registration_block) FROM node_monitored_wallets WHERE active) old`)).rows[0]?.height;
    const gapFrom = previous ? Number(previous.blockNumber) + 1 : prior != null ? Number(prior) : boundary;
    if (!Number.isSafeInteger(gapFrom) || gapFrom < 0) throw new Error('node_capture_bootstrap_gap_invalid');
    const existing = (await client.query('SELECT block_hash FROM node_evidence_blocks WHERE block_number=$1', [boundary])).rows[0];
    if (existing && existing.block_hash.toLowerCase() !== block.hash.toLowerCase()) throw new Error('node_capture_bootstrap_boundary_conflicts');
    const { transactions: _transactions, ...header } = block;
    await client.query(`INSERT INTO node_evidence_blocks(block_number,block_hash,parent_hash,timestamp,header)
      VALUES($1,$2,$3,to_timestamp($4),$5::jsonb) ON CONFLICT(block_number) DO NOTHING`, [boundary, block.hash.toLowerCase(), block.parentHash.toLowerCase(), Number(BigInt(block.timestamp)), JSON.stringify(header)]);
    await syncNodeMonitoredWallets(client);
    const wallets = (await client.query('SELECT wallet_address,generation::text FROM node_monitored_wallets WHERE active ORDER BY wallet_address')).rows;
    const hasGap = gapFrom <= boundary;
    await client.query(`INSERT INTO node_capture_bootstraps(id,boundary_block,boundary_hash,boundary_timestamp,previous_checkpoint,gap_from,gap_to,wallets)
      VALUES($1,$2,$3,to_timestamp($4),$5::jsonb,$6,$7,$8::jsonb)`, [id, boundary, block.hash.toLowerCase(), Number(BigInt(block.timestamp)), JSON.stringify(previous), hasGap ? gapFrom : null, hasGap ? boundary : null, JSON.stringify(wallets)]);
    if (hasGap) await client.query(`INSERT INTO node_collection_gaps(id,from_block,to_block,reason) VALUES($1,$2,$3,'explicit_capture_bootstrap')`, [id, gapFrom, boundary]);
    await client.query(`UPDATE node_monitored_wallets SET generation=$1::uuid,registered_at=now(),registration_block=$2,registration_hash=$3,
      collected_through_block=$2,decoded_through_block=$2,repair_from_block=NULL,last_error=CASE WHEN $4::bigint IS NULL THEN NULL ELSE 'historical_gap' END,
      historical_gap_from=LEAST(historical_gap_from,$4),historical_gap_to=GREATEST(historical_gap_to,$5),updated_at=now() WHERE active`,
    [id, boundary, block.hash.toLowerCase(), hasGap ? gapFrom : null, hasGap ? boundary : null]);
    // Portfolio memberships retain their original added/registration boundary.
    // Their missing interval cannot become a newly complete Portfolio return.
    for (const table of ['node_accounting_baselines', 'node_accounting_balances', 'node_accounting_history', 'node_accounting_snapshots', 'node_accounting_snapshot_versions']) {
      const exists = (await client.query('SELECT to_regclass($1) AS name', [table])).rows[0]?.name;
      if (exists) await client.query(`UPDATE ${table} SET invalidated_at=now()${table === 'node_accounting_snapshots' ? ',last_valid=NULL' : ''}
        WHERE wallet_address IN(SELECT wallet_address FROM node_monitored_wallets WHERE active)`);
    }
    const privateLeases = (await client.query("SELECT to_regclass('journal_replay_snapshots') AS name")).rows[0]?.name;
    if (privateLeases) await client.query(`DELETE FROM journal_replay_snapshots
      WHERE wallet_address IN(SELECT wallet_address FROM node_monitored_wallets WHERE active)`);
    // Live market capture gets the same fresh anchor. Prior observations remain
    // permanently stored, but an old range intersecting the explicit gap cannot
    // certify coverage until independently recollected or historically imported.
    await client.query('SELECT pg_advisory_xact_lock(908335)');
    const marketRanges = (await client.query("SELECT to_regclass('node_market_ranges') AS name")).rows[0]?.name;
    if (hasGap && marketRanges) await client.query(`UPDATE node_market_ranges SET complete=false WHERE from_block<=$2 AND to_block>=$1`, [gapFrom, boundary]);
    const checkpoint = JSON.stringify({ blockNumber: boundary, blockHash: block.hash.toLowerCase(), headBlock: head, bootstrapId: id, historicalGap: hasGap });
    await client.query(`INSERT INTO worker_state(key,value,updated_at) SELECT unnest(ARRAY['node_collection','node','node_capture_boundary','node_market_collection']),$1::jsonb,now()
      ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()`, [checkpoint]);
    await client.query('COMMIT'); return { id, boundary, blockHash: block.hash.toLowerCase(), historicalGap: hasGap ? { from: gapFrom, to: boundary } : null, alreadyApplied: false };
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}

/** Registry generations are captured before RPC starts. A later registration
 * obtains its own repair cursor, never inheriting somebody else's range. */
export async function syncNodeMonitoredWallets(database: Database) {
  await database.query(`UPDATE node_monitored_wallets n SET active=false,updated_at=now() WHERE active AND NOT EXISTS(SELECT 1 FROM kols k WHERE k.address=n.wallet_address AND k.is_tracked)
    AND NOT EXISTS(SELECT 1 FROM journal_wallets j WHERE j.wallet_address=n.wallet_address)`);
  await database.query(`INSERT INTO node_monitored_wallets(wallet_address,generation,active,registration_block,registration_hash,repair_from_block)
    SELECT w.wallet,$1::uuid,true,COALESCE(j.registration_block,(s.value->>'blockNumber')::bigint),
      COALESCE(j.registration_hash,s.value->>'blockHash'),COALESCE(j.registration_block,(s.value->>'blockNumber')::bigint)+1
    FROM(SELECT address wallet FROM kols WHERE is_tracked UNION SELECT DISTINCT wallet_address FROM journal_wallets) w
    LEFT JOIN LATERAL(SELECT registration_block,registration_hash FROM journal_wallets WHERE wallet_address=w.wallet AND registration_block IS NOT NULL ORDER BY registration_block LIMIT 1) j ON true
    LEFT JOIN LATERAL(SELECT value FROM worker_state WHERE key IN('node_collection','node') ORDER BY CASE WHEN key='node_collection' THEN 0 ELSE 1 END LIMIT 1) s ON true
    WHERE NOT EXISTS(SELECT 1 FROM node_monitored_wallets n WHERE n.wallet_address=w.wallet AND n.active)
    ORDER BY w.wallet
    ON CONFLICT(wallet_address) DO UPDATE SET active=true,generation=CASE WHEN node_monitored_wallets.active THEN node_monitored_wallets.generation ELSE EXCLUDED.generation END,
      registered_at=CASE WHEN node_monitored_wallets.active THEN node_monitored_wallets.registered_at ELSE now() END,
      registration_block=CASE WHEN node_monitored_wallets.active THEN node_monitored_wallets.registration_block ELSE EXCLUDED.registration_block END,
      registration_hash=CASE WHEN node_monitored_wallets.active THEN node_monitored_wallets.registration_hash ELSE EXCLUDED.registration_hash END,
      repair_from_block=CASE WHEN node_monitored_wallets.active THEN node_monitored_wallets.repair_from_block ELSE EXCLUDED.repair_from_block END,
      collected_through_block=CASE WHEN node_monitored_wallets.active THEN node_monitored_wallets.collected_through_block ELSE NULL END,
      decoded_through_block=CASE WHEN node_monitored_wallets.active THEN node_monitored_wallets.decoded_through_block ELSE NULL END
    WHERE NOT node_monitored_wallets.active`, [randomUUID()]);
  const rows = await database.query('SELECT wallet_address,generation::text FROM node_monitored_wallets WHERE active ORDER BY wallet_address');
  return new Map<string, string>(rows.rows.map(row => [row.wallet_address, row.generation]));
}

export async function nextNodeCollectionRepair(database: Database, through: number) {
  const rows = await database.query(`SELECT wallet_address,repair_from_block::text FROM node_monitored_wallets WHERE active AND repair_from_block<=$1 ORDER BY updated_at,wallet_address LIMIT 1`, [through]);
  if (!rows.rows[0]) return null;
  const from = Number(rows.rows[0].repair_from_block);
  if (!Number.isSafeInteger(from) || from < 0) throw new Error('node_collection_checkpoint_invalid');
  return { wallet: String(rows.rows[0].wallet_address), from, to: Math.min(through, from + 127) };
}

function transactionParticipants(tx: NodeTransaction, receipt: NodeReceipt, wallets: Set<string>) {
  const result = new Set<string>();
  for (const candidate of [address(tx.from), address(tx.to)]) if (candidate && wallets.has(candidate)) result.add(candidate);
  for (const log of receipt.logs) {
    const positions = log.topics[0]?.toLowerCase() === transferTopic && log.topics.length === 3 ? [1, 2]
      : NODE_ENTRY_POINTS.includes(log.address.toLowerCase()) && log.topics[0]?.toLowerCase() === userOperationTopic ? [2] : [];
    for (const position of positions) {
      const topic = log.topics[position]; const candidate = /^0x0{24}[0-9a-f]{40}$/i.test(topic ?? '') ? `0x${topic.slice(-40)}`.toLowerCase() : null;
      if (candidate && wallets.has(candidate)) result.add(candidate);
    }
  }
  return result;
}

export async function loadNodeEvidenceRange(options: { rpc: NodeRpc; from: number; to: number; head: number; wallets: Set<string>; previousHash?: string; liveSince?: number; repair?: boolean }) {
  const { rpc, from, to, head, wallets } = options;
  if (![from, to, head].every(Number.isSafeInteger) || from < 0 || to < from || to > head - 6 || to - from > 511) throw new Error('node_collection_range_invalid');
  const began = performance.now();
  const blocks = await readBlockRange(from, to, height => rpc<NodeBlock | null>('eth_getBlockByNumber', [hex(height), true]), options.previousHash);
  const blocksLoaded = performance.now();
  const transactionByHash = new Map<string, NodeTransaction>(), matched = new Set<string>(), selectedLogs = new Map<string, NodeReceipt['logs']>();
  for (const block of blocks) {
    if (!hash(block.hash) || !hash(block.parentHash) || !/^0x[0-9a-f]+$/i.test(block.timestamp) || !Array.isArray(block.transactions)) throw new Error('node_block_body_invalid');
    for (let index = 0; index < block.transactions.length; index++) {
      const tx = block.transactions[index];
      if (!tx || typeof tx !== 'object' || !hash(tx.hash) || transactionByHash.has(tx.hash.toLowerCase()) || !address(tx.from) || tx.to != null && !address(tx.to)
        || !/^0x[0-9a-f]{1,64}$/i.test(tx.value)
        || tx.blockHash?.toLowerCase() !== block.hash.toLowerCase() || tx.blockNumber !== block.number
        || tx.transactionIndex == null || Number(BigInt(tx.transactionIndex)) !== index) throw new Error('node_block_transaction_invalid');
      transactionByHash.set(tx.hash.toLowerCase(), tx);
      if (wallets.has(tx.from.toLowerCase()) || tx.to && wallets.has(tx.to.toLowerCase())) matched.add(tx.hash.toLowerCase());
    }
  }
  const topics = [...wallets].map(topicAddress);
  for (let offset = 0; offset < topics.length; offset += 300) {
    const slice = topics.slice(offset, offset + 300);
    const filters: Record<string, unknown>[] = [{ topics: [transferTopic, slice] }, { topics: [transferTopic, null, slice] },
      { address: NODE_ENTRY_POINTS, topics: [userOperationTopic, null, slice] }];
    const results = await Promise.all(filters.map(filter => rpc<NodeReceipt['logs']>('eth_getLogs', [{ fromBlock: hex(from), toBlock: hex(to), ...filter }])));
    for (const logs of results) {
      if (!Array.isArray(logs)) throw new Error('node_log_range_unavailable');
      for (const log of logs) {
        if (log.removed || !hash(log.transactionHash) || !hash(log.blockHash) || !log.blockNumber || !log.logIndex) throw new Error('node_log_range_invalid');
        const block = blocks[Number(BigInt(log.blockNumber)) - from];
        if (!block || block.hash.toLowerCase() !== log.blockHash!.toLowerCase() || !transactionByHash.has(log.transactionHash!.toLowerCase())) throw new Error('node_log_block_mismatch');
        matched.add(log.transactionHash!.toLowerCase());
        const list = selectedLogs.get(log.transactionHash!.toLowerCase()) ?? [];
        list.push(log); selectedLogs.set(log.transactionHash!.toLowerCase(), list);
      }
    }
  }
  const logsLoaded = performance.now(), entries: CollectedNodeEvidence[] = [];
  const readReceipt = async (txHash: string): Promise<CollectedNodeEvidence> => {
    const transaction = transactionByHash.get(txHash)!;
    const receipt = await rpc<NodeReceipt | null>('eth_getTransactionReceipt', [txHash]);
    const height = validateCollectedReceipt(txHash, transaction, receipt, from, to), block = blocks[height - from];
    if (receipt!.transactionHash?.toLowerCase() !== txHash || receipt!.blockNumber == null || receipt!.transactionIndex == null
      || Number(BigInt(receipt!.transactionIndex)) !== Number(BigInt(transaction.transactionIndex!)) || receipt!.blockHash.toLowerCase() !== block.hash.toLowerCase()) throw new Error('node_receipt_identity_incomplete');
    const indices = new Set<string>();
    for (const log of receipt!.logs) {
      if (!log.logIndex || !/^0x[0-9a-f]+$/i.test(log.logIndex) || indices.has(BigInt(log.logIndex).toString()) || log.transactionHash?.toLowerCase() !== txHash
        || log.blockHash?.toLowerCase() !== block.hash.toLowerCase() || log.blockNumber == null || Number(BigInt(log.blockNumber)) !== height) throw new Error('node_receipt_log_position_invalid');
      indices.add(BigInt(log.logIndex).toString());
    }
    for (const selected of selectedLogs.get(txHash) ?? []) {
      const complete = receipt!.logs.find(log => BigInt(log.logIndex!) === BigInt(selected.logIndex!));
      if (!complete || complete.address.toLowerCase() !== selected.address.toLowerCase() || complete.data.toLowerCase() !== selected.data.toLowerCase()
        || complete.topics.length !== selected.topics.length || complete.topics.some((topic, index) => topic.toLowerCase() !== selected.topics[index].toLowerCase())) throw new Error('node_receipt_log_range_mismatch');
    }
    return { transaction, receipt: receipt!, block, wallets: transactionParticipants(transaction, receipt!, wallets),
      observedLive: !options.repair && Number(BigInt(block.timestamp)) * 1000 >= (options.liveSince ?? Infinity) && Date.now() - Number(BigInt(block.timestamp)) * 1000 <= 300_000 };
  };
  const transactions = [...matched];
  // Receipt requests are independent. Bound their overlap so transport latency
  // cannot serialize a busy catch-up range, while every receipt remains required
  // before collection is allowed to open its write transaction.
  for (let offset = 0; offset < transactions.length; offset += 8) {
    entries.push(...await Promise.all(transactions.slice(offset, offset + 8).map(readReceipt)));
  }
  return { blocks, entries, timings: { blockLoadMs: Math.round(blocksLoaded - began),
    discoveryMs: Math.round(logsLoaded - blocksLoaded), receiptLoadMs: Math.round(performance.now() - logsLoaded) } };
}

/** Catch-up batches amortize fixed log/checkpoint work while keeping ordinary
 * near-head capture small. Every range still requires all six confirmations. */
export function nodeCaptureRangeEnd(from: number, confirmedThrough: number) {
  if (![from, confirmedThrough].every(Number.isSafeInteger) || from < 0 || confirmedThrough < from) throw new Error('node_collection_range_invalid');
  return Math.min(confirmedThrough, from + (confirmedThrough - from > 512 ? 511 : 127));
}

/** No metadata, valuation or decoder calls are allowed in this transaction.
 * A missing receipt prevents every range/checkpoint write. */
export async function collectNodeEvidenceRange(options: { database: NodeEvidenceDatabase; rpc: NodeRpc; from: number; to: number; head: number;
  generations: Map<string, string>; repairWallet?: string; liveSince?: number;
  commitCompatibility?: (database: Database, blocks: NodeBlock[], wallets: Set<string>) => Promise<void> }) {
  const started = performance.now(), wallets = new Set(options.repairWallet ? [options.repairWallet] : options.generations.keys());
  const previous = await options.database.query('SELECT block_hash FROM node_evidence_blocks WHERE block_number=$1', [options.from - 1]);
  const loaded = await loadNodeEvidenceRange({ ...options, wallets, previousHash: previous.rows[0]?.block_hash, repair: Boolean(options.repairWallet) });
  const persistenceStarted = performance.now();
  const client = await options.database.connect();
  let lockWaitMs = 0;
  try {
    await client.query('BEGIN');
    const lockStarted = performance.now(); await client.query('SELECT pg_advisory_xact_lock(782319)'); lockWaitMs = Math.round(performance.now() - lockStarted);
    const parent = (await client.query('SELECT block_hash FROM node_evidence_blocks WHERE block_number=$1', [options.from - 1])).rows[0];
    if (parent && parent.block_hash.toLowerCase() !== loaded.blocks[0].parentHash.toLowerCase()) throw new Error('node_collection_parent_changed');
    // Validate existing canonical headers together, under the same rollback
    // lock as the insert. Avoid two PostgreSQL round trips for every block.
    const existing = await client.query('SELECT block_number,block_hash FROM node_evidence_blocks WHERE block_number=ANY($1::bigint[])',
      [loaded.blocks.map(block => BigInt(block.number).toString())]);
    const existingHashes = new Map<string, string>(existing.rows.map(row => [String(row.block_number), String(row.block_hash).toLowerCase()]));
    const headers = [];
    for (const block of loaded.blocks) {
      const height = BigInt(block.number).toString(), stored = existingHashes.get(height);
      if (stored && stored !== block.hash.toLowerCase()) throw new Error('node_collection_block_changed');
      const { transactions: _transactions, ...header } = block;
      headers.push({ block_number: height, block_hash: block.hash.toLowerCase(), parent_hash: block.parentHash.toLowerCase(), timestamp_seconds: Number(BigInt(block.timestamp)), header });
    }
    await client.query(`INSERT INTO node_evidence_blocks(block_number,block_hash,parent_hash,timestamp,header)
      SELECT h.block_number,h.block_hash,h.parent_hash,to_timestamp(h.timestamp_seconds),h.header FROM jsonb_to_recordset($1::jsonb)
        AS h(block_number bigint,block_hash text,parent_hash text,timestamp_seconds double precision,header jsonb)
      ON CONFLICT(block_number) DO NOTHING`, [JSON.stringify(headers)]);
    for (const entry of loaded.entries) {
      const tx = entry.transaction, block = entry.block;
      const existing = (await client.query('SELECT block_hash FROM node_evidence_transactions WHERE tx_hash=$1', [tx.hash.toLowerCase()])).rows[0];
      if (existing && existing.block_hash.toLowerCase() !== block.hash.toLowerCase()) throw new Error('node_collection_transaction_changed');
      await client.query(`INSERT INTO node_evidence_transactions(tx_hash,block_number,block_hash,transaction_index,timestamp,transaction,receipt,observed_live)
        VALUES($1,$2,$3,$4,to_timestamp($5),$6::jsonb,$7::jsonb,$8) ON CONFLICT(tx_hash) DO NOTHING`,
      [tx.hash.toLowerCase(), Number(BigInt(block.number)), block.hash.toLowerCase(), Number(BigInt(tx.transactionIndex!)), Number(BigInt(block.timestamp)), JSON.stringify(tx), JSON.stringify(entry.receipt), entry.observedLive]);
      for (const wallet of entry.wallets) {
        const added = await client.query('INSERT INTO node_evidence_wallets(tx_hash,wallet_address) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING wallet_address', [tx.hash.toLowerCase(), wallet]);
        // Registration repair may discover another tracked participant in an
        // already decoded transaction. Reuse raw evidence and re-decode all
        // memberships, preserving their individual execution identities.
        if (existing && added.rows.length) await client.query(`UPDATE node_evidence_transactions SET decoded_version=NULL,projection_at=NULL,next_decode_at=now(),
          lease_id=NULL,lease_until=NULL WHERE tx_hash=$1`, [tx.hash.toLowerCase()]);
      }
    }
    await enqueueNodeEvidenceMetadata(client, loaded.entries);
    const captured = Object.fromEntries([...options.generations].filter(([wallet]) => wallets.has(wallet)));
    const cohort = await persistNodeEvidenceCoverageCohort(client, captured);
    await client.query(`INSERT INTO node_evidence_ranges(from_block,to_block,head_block,repair_wallet,wallets,cohort_fingerprint) VALUES($1,$2,$3,$4,$5::jsonb,$6)`,
      [options.from, options.to, options.head, options.repairWallet ?? null, JSON.stringify(captured), cohort]);
    await client.query(`UPDATE node_monitored_wallets n SET registration_block=COALESCE(registration_block,$2-1),registration_hash=COALESCE(registration_hash,$4),
      collected_through_block=GREATEST(COALESCE(collected_through_block,$2-1),$3),
      repair_from_block=CASE WHEN repair_from_block BETWEEN $2 AND $3 THEN CASE WHEN $3>=$5 THEN NULL ELSE $3+1 END ELSE repair_from_block END,
      last_error=NULL,updated_at=now() WHERE active AND generation::text=($1::jsonb->>wallet_address)`, [JSON.stringify(captured), options.from, options.to, loaded.blocks[0].parentHash.toLowerCase(), options.head - 6]);
    if (!options.repairWallet) await client.query(`INSERT INTO worker_state(key,value,updated_at) VALUES('node_collection',$1::jsonb,now())
      ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()`, [JSON.stringify({ blockNumber: options.to, blockHash: loaded.blocks.at(-1)!.hash.toLowerCase(), headBlock: options.head, receipts: loaded.entries.length, collectionMs: Math.round(performance.now() - started) })]);
    await options.commitCompatibility?.(client, loaded.blocks, wallets);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  return { blocks: loaded.blocks, receipts: loaded.entries.length, collectionMs: Math.round(performance.now() - started),
    ...loaded.timings, persistenceMs: Math.round(performance.now() - persistenceStarted), lockWaitMs };
}

export async function drainNodeEvidenceDecode(options: { database: NodeEvidenceDatabase; project?: (entry: CollectedNodeEvidence) => Promise<NodeEvidenceProjectionResult>; limit?: number }) {
  const lease = randomUUID(), limit = Math.min(128, Math.max(1, options.limit ?? 32));
  const rows = await options.database.query(`UPDATE node_evidence_transactions e SET lease_id=$1,lease_until=now()+interval '90 seconds' FROM(
    SELECT tx_hash FROM node_evidence_transactions WHERE decoded_version IS DISTINCT FROM $2
      AND next_decode_at<=now() AND (lease_until IS NULL OR lease_until<now())
      ORDER BY CASE WHEN block_number>COALESCE((SELECT (value->>'blockNumber')::bigint FROM worker_state WHERE key='node_capture_boundary'),-1) THEN 0 ELSE 1 END,
      block_number,transaction_index LIMIT $3 FOR UPDATE SKIP LOCKED) q
    WHERE e.tx_hash=q.tx_hash RETURNING e.*,EXISTS(SELECT 1 FROM node_executions prior WHERE prior.tx_hash=e.tx_hash) AS has_executions`, [lease, NODE_EXECUTION_VERSION, limit]);
  let decoded = 0, projected = 0;
  for (const row of rows.rows) {
    try {
      const blockRow = (await options.database.query('SELECT header FROM node_evidence_blocks WHERE block_number=$1 AND block_hash=$2', [row.block_number, row.block_hash])).rows[0];
      if (!blockRow) throw new Error('node_decode_canonical_block_missing');
      const walletRows = await options.database.query('SELECT wallet_address FROM node_evidence_wallets WHERE tx_hash=$1', [row.tx_hash]);
      const entry: CollectedNodeEvidence = { transaction: row.transaction, receipt: row.receipt, block: blockRow.header, wallets: new Set(walletRows.rows.map(item => String(item.wallet_address))), observedLive: row.observed_live };
      if (row.decoded_version !== NODE_EXECUTION_VERSION) {
        const executions = decodeNodeExecutions(entry.transaction, entry.receipt, entry.block, entry.wallets), client = await options.database.connect();
        try {
          const repairing=row.decoded_version!=null||row.has_executions===true;
          await client.query('BEGIN');await client.query(repairing?'SELECT pg_advisory_xact_lock(782319)':'SELECT pg_advisory_xact_lock_shared(782319)');
          const current = await client.query('SELECT tx_hash FROM node_evidence_transactions WHERE tx_hash=$1 AND lease_id=$2 AND block_hash=$3 FOR UPDATE', [row.tx_hash, lease, row.block_hash]);
          if (!current.rows.length) throw new Error('node_decode_lease_lost');
          if(repairing){
            const previous=(await client.query(`SELECT e.wallet_address,f.token_address FROM node_executions e LEFT JOIN node_execution_flows f ON f.execution_id=e.id
              WHERE e.tx_hash=$1`,[row.tx_hash])).rows;
            const pairs=[...previous.filter(item=>item.token_address).map(item=>({wallet:item.wallet_address,token:item.token_address})),
              ...executions.flatMap(execution=>execution.flows.map(flow=>({wallet:execution.walletAddress,token:flow.tokenAddress})))];
            const wallets=[...new Set([...previous.map(item=>item.wallet_address as string),...executions.map(execution=>execution.walletAddress)])];
            // Decoder repairs can change old quantities, fee attribution or
            // remove an execution without moving its block. Revoke both sides
            // atomically; the repair's exclusive rollback lock also fences a
            // concurrent rollup publication without reversing row lock order.
            await invalidateDecodedFinancialEvidence(client,pairs,wallets);
          }
          await client.query('DELETE FROM node_executions WHERE tx_hash=$1', [row.tx_hash]);
          await persistNodeExecutions(client, executions);
          // Standalone raw collectors need not install accounting. When it is
          // present, commit the fresh pair requests with the decoded evidence.
          const accountingAvailable = (await client.query("SELECT to_regclass('node_accounting_jobs') IS NOT NULL AS available")).rows[0]?.available;
          if (accountingAvailable) await enqueuePublicNodeAccountingPairs(client, executions.flatMap(execution => execution.flows.map(flow => ({
            wallet: execution.walletAddress, token: flow.tokenAddress,
            priority: row.observed_live && Date.now() >= execution.timestamp * 1000 && Date.now() - execution.timestamp * 1000 <= 300_000 ? 5 : 0,
            throughBlock: String(execution.blockNumber),
          }))));
          await client.query(`UPDATE node_evidence_transactions SET decoded_version=$2,decode_reason=NULL WHERE tx_hash=$1 AND lease_id=$3`, [row.tx_hash, NODE_EXECUTION_VERSION, lease]);
          await client.query('COMMIT'); decoded++;
        } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
      }
      await options.database.query(`UPDATE node_evidence_transactions SET decode_attempts=0,lease_id=NULL,lease_until=NULL WHERE tx_hash=$1 AND lease_id=$2`, [row.tx_hash, lease]);
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'node_decode_retry';
      await options.database.query(`UPDATE node_evidence_transactions SET decode_reason=CASE WHEN decoded_version=$4 THEN decode_reason ELSE $3 END,
        projection_reason=$3,decode_attempts=decode_attempts+1,next_decode_at=now()+LEAST(300,POWER(2,LEAST(8,decode_attempts+1)))::integer*interval '1 second',lease_id=NULL,lease_until=NULL WHERE tx_hash=$1 AND lease_id=$2`, [row.tx_hash, lease, reason.slice(0, 160), NODE_EXECUTION_VERSION]);
    }
  }
  await advanceNodeDecodeCheckpoints(options.database);
  if (options.project) projected = (await drainNodeEvidenceProjection({ database: options.database, project: options.project, limit })).projected;
  return { decoded, projected };
}

/** Ancillary legacy feed projection has its own lease/retry stage. The decoder
 * above does not wait for token metadata or fee conversion. */
export async function drainNodeEvidenceProjection(options: { database: NodeEvidenceDatabase; project: (entry: CollectedNodeEvidence) => Promise<NodeEvidenceProjectionResult>; limit?: number }) {
  const lease = randomUUID(), limit = Math.min(32, Math.max(1, options.limit ?? 8));
  // Metadata retries can remain unresolved after state pruning. Reserve most
  // historical slots for first publication, rather than repeatedly selecting
  // earlier retries ahead of every untouched receipt. A bounded retry share
  // still enriches already visible rows, while fresh live work always goes first.
  const rows = await options.database.query(`WITH fresh AS (
    SELECT tx_hash,0 AS projection_priority,row_number() OVER(ORDER BY observed_live DESC,block_number DESC,transaction_index) AS projection_order
    FROM(SELECT tx_hash,observed_live,block_number,transaction_index FROM node_evidence_transactions
      WHERE decoded_version=$2 AND projection_at IS NULL AND timestamp>=now()-interval '5 minutes'
        AND next_decode_at<=now() AND (lease_until IS NULL OR lease_until<now())
      ORDER BY observed_live DESC,block_number DESC,transaction_index LIMIT $3 FOR UPDATE SKIP LOCKED) selected
  ), first_publication AS (
    SELECT tx_hash,row_number() OVER(ORDER BY block_number,transaction_index) AS position
    FROM(SELECT tx_hash,block_number,transaction_index FROM node_evidence_transactions
      WHERE decoded_version=$2 AND projection_at IS NULL AND projection_reason IS NULL AND timestamp<now()-interval '5 minutes'
        AND next_decode_at<=now() AND (lease_until IS NULL OR lease_until<now())
      ORDER BY block_number,transaction_index LIMIT $3 FOR UPDATE SKIP LOCKED) selected
  ), enrichment AS (
    SELECT tx_hash,row_number() OVER(ORDER BY next_decode_at,block_number,transaction_index) AS position
    FROM(SELECT tx_hash,next_decode_at,block_number,transaction_index FROM node_evidence_transactions
      WHERE decoded_version=$2 AND projection_at IS NULL AND projection_reason IS NOT NULL AND timestamp<now()-interval '5 minutes'
        AND next_decode_at<=now() AND (lease_until IS NULL OR lease_until<now())
      ORDER BY next_decode_at,block_number,transaction_index LIMIT $3 FOR UPDATE SKIP LOCKED) selected
  ), chosen AS (
    SELECT * FROM(
      SELECT tx_hash,projection_priority,projection_order FROM fresh
      UNION ALL SELECT tx_hash,1,((position-1)/3)*4+(position-1)%3 FROM first_publication
      UNION ALL SELECT tx_hash,1,(position-1)*4+3 FROM enrichment
    ) candidates ORDER BY projection_priority,projection_order LIMIT $3
  ) UPDATE node_evidence_transactions e SET lease_id=$1,lease_until=now()+interval '90 seconds'
    FROM chosen q WHERE e.tx_hash=q.tx_hash RETURNING e.*,q.projection_priority,q.projection_order`, [lease, NODE_EXECUTION_VERSION, limit]);
  rows.rows.sort((left, right) => left.projection_priority-right.projection_priority || Number(left.projection_order)-Number(right.projection_order));
  let projected = 0, pending = 0;
  for (const row of rows.rows) {
    try {
      const block = (await options.database.query('SELECT header FROM node_evidence_blocks WHERE block_number=$1 AND block_hash=$2', [row.block_number, row.block_hash])).rows[0]?.header;
      if (!block) throw new Error('node_projection_canonical_block_missing');
      const wallets = await options.database.query('SELECT wallet_address FROM node_evidence_wallets WHERE tx_hash=$1', [row.tx_hash]);
      const result = await options.project({ transaction: row.transaction, receipt: row.receipt, block, wallets: new Set(wallets.rows.map(item => String(item.wallet_address))), observedLive: row.observed_live });
      if (result?.pendingReason) {
        // Canonical identity/side publication succeeded. Keep only enrichment
        // pending; count publication so SSE subscribers see the trade now.
        await options.database.query(`UPDATE node_evidence_transactions SET projection_reason=$3,decode_attempts=decode_attempts+1,
          next_decode_at=now()+LEAST(300,POWER(2,LEAST(8,decode_attempts+1)))::integer*interval '1 second',lease_id=NULL,lease_until=NULL
          WHERE tx_hash=$1 AND lease_id=$2`, [row.tx_hash, lease, result.pendingReason.slice(0,160)]);
        pending++;
      } else await options.database.query(`UPDATE node_evidence_transactions SET projection_at=now(),projection_reason=NULL,decode_attempts=0,lease_id=NULL,lease_until=NULL WHERE tx_hash=$1 AND lease_id=$2`, [row.tx_hash, lease]);
      projected++;
    } catch (error) {
      await options.database.query(`UPDATE node_evidence_transactions SET projection_reason=$3,decode_attempts=decode_attempts+1,
        next_decode_at=now()+LEAST(300,POWER(2,LEAST(8,decode_attempts+1)))::integer*interval '1 second',lease_id=NULL,lease_until=NULL WHERE tx_hash=$1 AND lease_id=$2`,
      [row.tx_hash, lease, (error instanceof Error ? error.message : 'node_projection_retry').slice(0, 160)]);
    }
  }
  return { projected, pending };
}

/** A pool call owns one short transaction. A supplied client/query adapter must
 * already belong to the caller's transaction, which remains caller-owned. */
export async function advanceNodeDecodeCheckpoints(database: NodeEvidenceDatabase | Database) {
  const candidate = database as Partial<NodeEvidenceDatabase> & { release?: unknown };
  if (typeof candidate.connect === 'function' && typeof candidate.release !== 'function') {
    const client = await candidate.connect();
    try {
      await client.query('BEGIN');
      await advanceNodeDecodeCheckpointsInTransaction(client);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    return;
  }
  await advanceNodeDecodeCheckpointsInTransaction(database);
}

async function advanceNodeDecodeCheckpointsInTransaction(database: Database) {
  // Reorg rollback takes the exclusive form of the same lock. Keep coverage,
  // completed-range selection and the node checkpoint write in this one lock
  // scope: an orphan selected before rollback must never be inserted afterward.
  await database.query('SELECT pg_advisory_xact_lock_shared(782319)');
  // Empty collected ranges are completed as well. A valuation/projection delay
  // does not invalidate the independent raw execution checkpoint.
  await database.query(`UPDATE node_evidence_ranges r SET decoded_at=now() WHERE decoded_at IS NULL AND NOT EXISTS(
    SELECT 1 FROM node_evidence_transactions e WHERE e.block_number BETWEEN r.from_block AND r.to_block AND e.decoded_version IS DISTINCT FROM $1)`, [NODE_EXECUTION_VERSION]);
  await database.query(`UPDATE node_monitored_wallets n SET decoded_through_block=LEAST(n.collected_through_block,COALESCE((SELECT MIN(e.block_number)-1
    FROM node_evidence_transactions e JOIN node_evidence_wallets w ON w.tx_hash=e.tx_hash WHERE w.wallet_address=n.wallet_address
      AND e.block_number>n.registration_block AND e.decoded_version IS DISTINCT FROM $1),n.collected_through_block)),updated_at=now() WHERE n.active`, [NODE_EXECUTION_VERSION]);
  // Canonical decoded coverage is independent of optional feed enrichment.
  // Alerts query unprocessed projected rows rather than advancing a scan cursor,
  // so a late projection remains eligible until its ordinary freshness limit.
  const complete = await database.query(`SELECT r.to_block,r.head_block,b.block_hash FROM node_evidence_ranges r JOIN node_evidence_blocks b ON b.block_number=r.to_block
    WHERE r.repair_wallet IS NULL AND r.to_block>=COALESCE((SELECT (value->>'blockNumber')::bigint FROM worker_state WHERE key='node_capture_boundary'),0)
    AND r.to_block<=COALESCE((SELECT (value->>'blockNumber')::bigint FROM worker_state WHERE key='node_collection'),r.to_block)
    AND NOT EXISTS(SELECT 1 FROM node_evidence_transactions e WHERE e.block_number<=r.to_block
      AND e.block_number>COALESCE((SELECT (value->>'blockNumber')::bigint FROM worker_state WHERE key='node_capture_boundary'),-1) AND
      e.decoded_version IS DISTINCT FROM $1) ORDER BY r.to_block DESC LIMIT 1`, [NODE_EXECUTION_VERSION]);
  if (complete.rows[0]) await database.query(`INSERT INTO worker_state(key,value,updated_at) VALUES('node',$1::jsonb,now()) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()
    WHERE COALESCE((worker_state.value->>'blockNumber')::bigint,0)<=(EXCLUDED.value->>'blockNumber')::bigint`,
  [JSON.stringify({ blockNumber: Number(complete.rows[0].to_block), headBlock: Number(complete.rows[0].head_block), blockHash: complete.rows[0].block_hash })]);
}

export async function rollbackNodeEvidence(database: Database, from: number) {
  await rollbackNodeTokenIdentities(database,from);
  await database.query('DELETE FROM node_evidence_transactions WHERE block_number >= $1', [from]);
  await database.query('DELETE FROM node_evidence_ranges WHERE from_block >= $1', [from]);
  await database.query('UPDATE node_evidence_ranges SET to_block=$1-1,decoded_at=NULL WHERE from_block<$1 AND to_block>=$1', [from]);
  await database.query('DELETE FROM node_evidence_blocks WHERE block_number >= $1', [from]);
  await database.query(`UPDATE node_monitored_wallets SET collected_through_block=LEAST(collected_through_block,$1-1),decoded_through_block=LEAST(decoded_through_block,$1-1),
    registration_hash=CASE WHEN registration_block>=$1 THEN (SELECT block_hash FROM node_evidence_blocks WHERE block_number=$1-1) ELSE registration_hash END,
    registration_block=LEAST(registration_block,$1-1),repair_from_block=LEAST(COALESCE(repair_from_block,$1),$1),last_error='chain_reorganization',updated_at=now() WHERE active`, [from]);
  await database.query(`DELETE FROM worker_state WHERE key IN('node_collection','node') AND (value->>'blockNumber')::bigint >= $1`, [from]);
  await database.query('UPDATE node_capture_bootstraps SET invalidated_at=now() WHERE boundary_block >= $1', [from]);
  await database.query("DELETE FROM worker_state WHERE key='node_capture_boundary' AND (value->>'blockNumber')::bigint >= $1", [from]);
  // Preserve the still-canonical prefix of an atomically captured range. A
  // normal fork does not require a new migration/bootstrap or a silent skip.
  await database.query(`INSERT INTO worker_state(key,value,updated_at)
    SELECT 'node_collection',jsonb_build_object('blockNumber',r.to_block,'blockHash',b.block_hash,'headBlock',r.head_block),now()
    FROM node_evidence_ranges r JOIN node_evidence_blocks b ON b.block_number=r.to_block WHERE r.repair_wallet IS NULL
      AND r.to_block>=COALESCE((SELECT (value->>'blockNumber')::bigint FROM worker_state WHERE key='node_capture_boundary'),0)
    ORDER BY r.to_block DESC LIMIT 1 ON CONFLICT(key) DO NOTHING`);
  await database.query(`INSERT INTO worker_state(key,value,updated_at) SELECT 'node_collection',value,now() FROM worker_state WHERE key='node_capture_boundary'
    ON CONFLICT(key) DO NOTHING`);
}

/** Headers are retained permanently, so deep forks can use logarithmic probes
 * instead of depending on the last 128 public trade checkpoints. */
export async function findNodeEvidenceReorgStart(database: Database, canonicalHash: (height: number) => Promise<string | null>) {
  const bounds = (await database.query(`SELECT MIN(block_number)::text AS first,MAX(block_number)::text AS last FROM node_evidence_blocks
    WHERE block_number>=COALESCE((SELECT (value->>'blockNumber')::bigint FROM worker_state WHERE key='node_capture_boundary'),0)
      AND block_number<=COALESCE((SELECT (value->>'blockNumber')::bigint FROM worker_state WHERE key='node_collection'),block_number)`)).rows[0];
  if (bounds?.first == null || bounds?.last == null) return null;
  const first = Number(bounds.first), last = Number(bounds.last);
  if (![first, last].every(Number.isSafeInteger)) throw new Error('node_reorg_bounds_invalid');
  const matches = async (height: number) => {
    const stored = (await database.query('SELECT block_hash FROM node_evidence_blocks WHERE block_number=$1', [height])).rows[0]?.block_hash;
    const canonical = await canonicalHash(height);
    if (!stored || !hash(canonical)) throw new Error('node_reorg_canonical_unavailable');
    return stored.toLowerCase() === canonical!.toLowerCase();
  };
  if (await matches(last)) return null;
  let orphan = last, step = 1;
  for (;;) {
    const probe = Math.max(first, last - step);
    if (await matches(probe)) {
      let common = probe;
      while (orphan - common > 1) {
        const middle = common + Math.floor((orphan - common) / 2);
        if (await matches(middle)) common = middle; else orphan = middle;
      }
      return common + 1;
    }
    orphan = probe;
    if (probe === first) throw new Error('node_reorg_common_checkpoint_unavailable');
    step *= 2;
  }
}
