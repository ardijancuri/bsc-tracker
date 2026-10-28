import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import type { Pool, PoolClient } from 'pg';
import { blockHex, rpcBatch, type Rpc, type RpcBatchRequest } from '../rpc.js';
import { transferTopic } from '../swap.js';
import { userOperationTopic } from '../smartAccountTrades.js';
import { FOUR_MANAGERS, FLAP_PORTAL, fourInterface, fourV1Interface, flapInterface } from '../launchpad.js';
import type { FreshCallTrace } from './trace.js';
import type { FreshStateReadEvidence } from './stateEvidence.js';
import { classifyFreshCreationToken } from './tokenAuthenticity.js';
import { classifyFreshStockwaveCreation, FRESH_STOCKWAVE_FACTORY, FRESH_STOCKWAVE_LAUNCH_TOPIC, readFreshStockwaveCodeEvidence, type FreshStockwaveCodeEvidence } from './factoryLaunch.js';
import type { FreshReceiptRecoveryEvidence } from './recovery.js';
import type {FreshSelfCallExecutionContext} from './signedSelfCallSettlement.js';
import{FRESH_ADDITIONAL_SYNTHETIC_BATCH_AUDITS}from'./syntheticTransferBatch.js';
import {enrichFreshKnownTokenBirth} from './tokenBirth.js';
import{invalidateFreshRealizedGapCoverage,freshRealizedGapPinnedHeadersSql}from'./realizedGapCoverage.js';

export const FRESH_CONFIRMATIONS = 6;
export const FRESH_EVIDENCE_TTL_MS = 72 * 60 * 60 * 1_000;
// Canonical deterministic deployments from eth-infinitism/account-abstraction
// releases v0.6, v0.7 and v0.8. Their BeforeExecution/UserOperationEvent ABI is
// identical; paymaster attribution still fails closed below.
export const FRESH_ENTRY_POINTS = ['0x0000000071727de22e5e9d8baf0edac6f37da032', '0x5ff137d4b0fdcd49dca30c7cf57e578a026d2789', '0x4337084d9e255ff0702461cf8895ce9e3b5ff108'];
export const freshAddress = (value: unknown): string | null => typeof value === 'string' && /^0x[\da-f]{40}$/i.test(value) ? value.toLowerCase() : null;
export const freshHash = (value: unknown): string | null => typeof value === 'string' && /^0x[\da-f]{64}$/i.test(value) ? value.toLowerCase() : null;
export function freshInteger(value: unknown): bigint { if (typeof value !== 'string' || !/^0x[\da-f]{1,64}$/i.test(value)) throw new Error('node_quantity_invalid'); return BigInt(value); }
const safeNumber = (value: unknown) => { const number = Number(freshInteger(value)); if (!Number.isSafeInteger(number)) throw new Error('node_quantity_out_of_range'); return number; };
export interface FreshLog { address: string; topics: string[]; data: string; logIndex: string; transactionHash: string; transactionIndex: string; blockNumber: string; blockHash: string; removed?: boolean }
export interface FreshTransaction { hash: string; from: string; to: string | null; value: string; blockHash: string; blockNumber: string; transactionIndex: string; gasPrice?: string; [key: string]: unknown }
export interface FreshReceipt { transactionHash: string; transactionIndex: string; blockHash: string; blockNumber: string; status: string; gasUsed: string; effectiveGasPrice?: string; contractAddress?: string | null; logs: FreshLog[]; [key: string]: unknown }
export interface FreshBlock { number: string; hash: string; parentHash: string; timestamp: string; transactions: FreshTransaction[]; [key: string]: unknown }
export interface FreshLaunchFact { tokenAddress: string; protocol: 'fourmeme' | 'flap' | 'evm_creation' | 'stockwave'; blockNumber: number; blockHash: string; txHash: string; logIndex: number | null; launchedAt: string; proof: Record<string, unknown>; status: 'eligible' | 'before_boundary' | 'excluded_non_token' }
export interface FreshCaptureCheckpoint { blockNumber: number; blockHash: string; revision: number; startBlock: number; startHash?: string }
export interface FreshMonitoredWallet { address: string; fromBlock: number; toBlock?: number | null }
export interface FreshFactoryLaunchRepair { version: 1; kind: 'stockwave'; reason: 'factory_creation_code_unverified' | 'factory_creation_proof_invalid' }
export interface FreshCapturedReceipt { transaction: FreshTransaction; receipt: FreshReceipt; wallets: string[]; observedAt: string; trace?: FreshCallTrace; selfCallContext?:FreshSelfCallExecutionContext; stateEvidence?: FreshStateReadEvidence; recoveryEvidence?: FreshReceiptRecoveryEvidence; launchRepair?: FreshFactoryLaunchRepair; historicalWallets?: string[]; decodeDiagnostics?: import('./decode.js').FreshDecodeDiagnostics }
export interface FreshCapturedPage { previous: FreshCaptureCheckpoint; blocks: FreshBlock[]; receipts: FreshCapturedReceipt[]; launches: FreshLaunchFact[]; nodeHead?:number;nodeHeadObservedAt?:number }
export interface FreshCaptureProgress { nodeHead:number;confirmedHeadBlock:number;capturedBlock:number;lagBlocks:number;checkedAt:number }

/** The payload has one log body collection. Receipt metadata refers to it only
 * once; no execution- or feature-specific copies are retained. */
export function encodeFreshEvidence(value: FreshCapturedReceipt): Buffer {
  const raw = Buffer.from(JSON.stringify({ version: 1, ...value }));
  if (raw.length > 16 * 1_024 * 1_024) throw new Error('receipt_evidence_too_large');
  return Buffer.concat([Buffer.from('KFE1'), createHash('sha256').update(raw).digest(), gzipSync(raw, { level: 3 })]);
}
export function decodeFreshEvidence(payload: Buffer): FreshCapturedReceipt {
  if (payload.subarray(0, 4).toString() !== 'KFE1') throw new Error('receipt_evidence_version_invalid');
  let raw: Buffer;
  try { raw = gunzipSync(payload.subarray(36), { maxOutputLength: 16 * 1_024 * 1_024 }); } catch { throw new Error('receipt_evidence_corrupt'); }
  if (!createHash('sha256').update(raw).digest().equals(payload.subarray(4, 36))) throw new Error('receipt_evidence_checksum_invalid');
  const value = JSON.parse(raw.toString()) as FreshCapturedReceipt & { version: number };
  if (value.version !== 1 || !value.transaction || !value.receipt || !Array.isArray(value.wallets)) throw new Error('receipt_evidence_invalid');
  return value;
}

export function validateFreshBlock(block: FreshBlock | null, expected: number, parentHash?: string): asserts block is FreshBlock {
  if (!block || safeNumber(block.number) !== expected || !freshHash(block.hash) || !freshHash(block.parentHash) || !Array.isArray(block.transactions)
    || parentHash && block.parentHash.toLowerCase() !== parentHash.toLowerCase()) throw new Error('block_identity_mismatch');
  safeNumber(block.timestamp);
  const hashes = new Set<string>();
  for (let index = 0; index < block.transactions.length; index++) {
    const tx = block.transactions[index];
    if (!freshHash(tx.hash) || hashes.has(tx.hash.toLowerCase()) || !freshAddress(tx.from) || tx.to !== null && !freshAddress(tx.to)
      || safeNumber(tx.blockNumber) !== expected || tx.blockHash?.toLowerCase() !== block.hash.toLowerCase() || safeNumber(tx.transactionIndex) !== index) throw new Error('transaction_identity_mismatch');
    freshInteger(tx.value); hashes.add(tx.hash.toLowerCase());
  }
}
export function validateFreshReceipt(receipt: FreshReceipt | null, tx: FreshTransaction, block: FreshBlock): asserts receipt is FreshReceipt {
  if (!receipt) throw new Error('required_receipt_missing');
  if (!['0x0', '0x1'].includes(receipt.status) || receipt.blockHash?.toLowerCase() !== block.hash.toLowerCase()
    || receipt.transactionHash?.toLowerCase() !== tx.hash.toLowerCase() || safeNumber(receipt.blockNumber) !== safeNumber(block.number)
    || safeNumber(receipt.transactionIndex) !== safeNumber(tx.transactionIndex) || !Array.isArray(receipt.logs)) throw new Error('receipt_identity_mismatch');
  freshInteger(receipt.gasUsed); freshInteger(receipt.effectiveGasPrice ?? tx.gasPrice);
  let last = -1;
  for (const log of receipt.logs) {
    const index = safeNumber(log.logIndex);
    if (log.removed || !freshAddress(log.address) || !Array.isArray(log.topics) || log.topics.some(topic => !freshHash(topic))
      || !/^0x(?:[\da-f]{2})*$/i.test(log.data) || index <= last || log.blockHash?.toLowerCase() !== block.hash.toLowerCase()
      || safeNumber(log.blockNumber) !== safeNumber(block.number) || log.transactionHash?.toLowerCase() !== tx.hash.toLowerCase()
      || safeNumber(log.transactionIndex) !== safeNumber(tx.transactionIndex)) throw new Error('receipt_log_identity_mismatch');
    last = index;
  }
}

const creationTopics = [...new Set([fourInterface, fourV1Interface, flapInterface].flatMap(abi => abi.fragments.filter(fragment => fragment.type === 'event' && ['TokenCreate', 'TokenCreated'].includes((fragment as { name?: string }).name ?? '')).map(fragment => abi.getEvent(fragment.format('sighash'))!.topicHash)))];
/** Only authenticated token-creation events establish launch eligibility. Pair
 * and pool-created events deliberately have no entry in this decoder. */
export function decodeFreshLaunch(log: FreshLog, block: FreshBlock, startBlock: number): FreshLaunchFact | null {
  const controller = log.address.toLowerCase();
  const interfaces = FOUR_MANAGERS.includes(controller) ? [fourInterface, fourV1Interface] : controller === FLAP_PORTAL ? [flapInterface] : [];
  if (log.removed || !creationTopics.includes(log.topics[0])) return null;
  for (const abi of interfaces) {
    try {
      const parsed = abi.parseLog(log); if (!parsed || !['TokenCreate', 'TokenCreated'].includes(parsed.name)) continue;
      const token = freshAddress(parsed.args.token); if (!token) continue;
      const number = safeNumber(block.number), time = safeNumber(block.timestamp), reported = parsed.args.launchTime ?? parsed.args.ts;
      // The canonical creation block is the proof. The launchpad's reported
      // timestamp is retained separately rather than replacing block identity.
      return { tokenAddress: token, protocol: controller === FLAP_PORTAL ? 'flap' : 'fourmeme', blockNumber: number, blockHash: block.hash.toLowerCase(),
        txHash: log.transactionHash.toLowerCase(), logIndex: safeNumber(log.logIndex), launchedAt: new Date(time * 1_000).toISOString(),
        proof: { controller, topic: log.topics[0], reportedLaunchTime: String(reported), name: String(parsed.args.name).slice(0, 256), symbol: String(parsed.args.symbol).slice(0, 64) },
        status: number > startBlock ? 'eligible' : 'before_boundary' };
    } catch { /* Unknown ABI versions remain unverified. */ }
  }
  return null;
}

function assertPageLog(log: FreshLog, blocks: Map<number, FreshBlock>) {
  const block = blocks.get(safeNumber(log.blockNumber));
  if (!block || log.removed || log.blockHash?.toLowerCase() !== block.hash.toLowerCase() || !freshAddress(log.address) || !freshHash(log.transactionHash)
    || !Array.isArray(log.topics) || log.topics.some(topic => !freshHash(topic)) || !/^0x(?:[\da-f]{2})*$/i.test(log.data)) throw new Error('discovery_log_identity_mismatch');
  const tx = block.transactions[safeNumber(log.transactionIndex)];
  if (!tx || tx.hash.toLowerCase() !== log.transactionHash.toLowerCase()) throw new Error('discovery_transaction_mismatch');
  safeNumber(log.logIndex);
}

/** All RPC happens before the database transaction. A failed relevant receipt
 * rejects the whole page; metadata/price/decoder work is intentionally absent. */
export async function collectFreshPage(options: { rpc: Rpc; checkpoint: FreshCaptureCheckpoint; wallets: FreshMonitoredWallet[]; head?: number; limit?: number; catchUpLimit?: number; now?: Date; launchDiscovery?: boolean; collectCreations?: boolean }): Promise<FreshCapturedPage> {
  const nodeHeadObservedAt=Date.now();
  const { rpc, checkpoint } = options, head = options.head ?? safeNumber(await rpc<string>('eth_blockNumber', []));
  // Larger pages reduce catch-up round trips. Keep the smaller near-head page
  // so atomic publication cannot age a fresh receipt past urgent tracing time.
  const requested=options.catchUpLimit!==undefined&&head-FRESH_CONFIRMATIONS-checkpoint.blockNumber>32?options.catchUpLimit:options.limit??8;
  const limit=Math.min(32,Math.max(1,requested)),to=Math.min(head-FRESH_CONFIRMATIONS,checkpoint.blockNumber+limit);
  if (to <= checkpoint.blockNumber) return { previous: checkpoint, blocks: [], receipts: [], launches: [],nodeHead:head,nodeHeadObservedAt };
  const first = checkpoint.blockNumber + 1, blocks: FreshBlock[] = [], byNumber = new Map<number, FreshBlock>();
  // Dense full-transaction blocks can exceed the node's cumulative response
  // budget in a 32-item batch. Bound transport bodies independently of the
  // atomic page: both halves must validate before any discovery or commit.
  for (let batchFirst = first; batchFirst <= to; batchFirst += 16) {
    const batchLast = Math.min(to, batchFirst + 15);
    const blockResults = await rpcBatch<FreshBlock>(rpc, Array.from({ length: batchLast - batchFirst + 1 }, (_, index) => ({ method: 'eth_getBlockByNumber', params: [blockHex(batchFirst + index), true] })));
    for (let number = batchFirst; number <= batchLast; number++) {
      const result = blockResults[number - batchFirst]; if (!result || result.status === 'rejected') throw new Error('required_block_unavailable'); const block = result.value;
      validateFreshBlock(block, number, blocks.at(-1)?.hash ?? checkpoint.blockHash); blocks.push(block); byNumber.set(number, block);
    }
  }
  const active = options.wallets.filter(wallet => wallet.fromBlock <= to && (wallet.toBlock == null || wallet.toBlock >= first));
  const fromBlock = blockHex(first), toBlock = blockHex(to), discovery: FreshLog[] = [];
  const launches = options.launchDiscovery === false ? [] : await rpc<FreshLog[]>('eth_getLogs', [{ fromBlock, toBlock,
    address: [...FOUR_MANAGERS, FLAP_PORTAL, FRESH_STOCKWAVE_FACTORY], topics: [[...creationTopics, FRESH_STOCKWAVE_LAUNCH_TOPIC]] }]);
  if (!Array.isArray(launches)) throw new Error('launch_discovery_invalid'); discovery.push(...launches);
  const discoveryRequests: RpcBatchRequest[] = [];
  for (let offset = 0; offset < active.length; offset += 128) {
    const topics = active.slice(offset, offset + 128).map(wallet => `0x${'0'.repeat(24)}${wallet.address.slice(2)}`);
    for (const filter of [
      { topics: [transferTopic, topics] }, { topics: [transferTopic, null, topics] },
      { address: FRESH_ENTRY_POINTS, topics: [userOperationTopic, null, topics] },
    ]) {
      discoveryRequests.push({ method: 'eth_getLogs', params: [{ fromBlock, toBlock, ...filter }] });
    }
  }
  for (const result of await rpcBatch<FreshLog[]>(rpc, discoveryRequests)) {
    if (result.status === 'rejected' || !Array.isArray(result.value)) throw new Error('wallet_discovery_invalid'); discovery.push(...result.value);
  }
  discovery.forEach(log => assertPageLog(log, byNumber));
  const stockwaveLaunches = launches.filter(log => log.address.toLowerCase() === FRESH_STOCKWAVE_FACTORY && log.topics[0]?.toLowerCase() === FRESH_STOCKWAVE_LAUNCH_TOPIC);
  const factoryReceipts = new Set(stockwaveLaunches.map(log => log.transactionHash.toLowerCase()));
  const discovered = new Set(discovery.filter(log => !creationTopics.includes(log.topics[0]) && log.topics[0]?.toLowerCase() !== FRESH_STOCKWAVE_LAUNCH_TOPIC).map(log => log.transactionHash.toLowerCase()));
  const activeAt = (number: number) => active.filter(wallet => wallet.fromBlock <= number && (wallet.toBlock == null || wallet.toBlock >= number));
  const receipts: FreshCapturedReceipt[] = [], facts: FreshLaunchFact[] = [];
  for (const log of launches) { const fact = decodeFreshLaunch(log, byNumber.get(safeNumber(log.blockNumber))!, checkpoint.startBlock); if (fact) facts.push(fact); }
  const observedAt = (options.now ?? new Date()).toISOString();
  const receiptRequests: { tx: FreshTransaction; block: FreshBlock; watched: Set<string>; relevant: boolean }[] = [];
  for (const block of blocks) {
    const wallets = activeAt(safeNumber(block.number)), watched = new Set(wallets.map(wallet => wallet.address.toLowerCase()));
    for (const tx of block.transactions) {
      const relevant = watched.has(tx.from.toLowerCase()) || tx.to && watched.has(tx.to.toLowerCase()) || discovered.has(tx.hash.toLowerCase());
      // A top-level contract creation is independently observable from the
      // block. Its tiny fact permits later discovery without retaining its raw
      // receipt forever. CREATE2 without an authenticated event stays unknown.
      if (!relevant && !factoryReceipts.has(tx.hash.toLowerCase()) && (tx.to !== null || options.collectCreations === false)) continue;
      receiptRequests.push({ tx, block, watched, relevant: Boolean(relevant) });
    }
  }
  const receiptResults = await rpcBatch<FreshReceipt | null>(rpc, receiptRequests.map(({ tx }) => ({ method: 'eth_getTransactionReceipt', params: [tx.hash] })));
  let stockwaveCode: Promise<FreshStockwaveCodeEvidence | null> | undefined;
  for (let index = 0; index < receiptRequests.length; index++) {
      const { tx, block, watched, relevant } = receiptRequests[index], result = receiptResults[index];
      if (result.status === 'rejected') throw new Error('required_receipt_unavailable');
      const receipt = result.value; validateFreshReceipt(receipt, tx, block);
      let launchRepair: FreshFactoryLaunchRepair | undefined;
      // Discovery is only an index. Every fetched receipt, including an
      // unmonitored factory creation, must contain its discovery logs verbatim.
      const lookup = new Map(receipt.logs.map(log => [log.logIndex, JSON.stringify([log.address.toLowerCase(), log.topics.map(topic => topic.toLowerCase()), log.data.toLowerCase()])]));
      for (const log of discovery.filter(log => log.transactionHash.toLowerCase() === tx.hash.toLowerCase())) if (lookup.get(log.logIndex) !== JSON.stringify([log.address.toLowerCase(), log.topics.map(topic => topic.toLowerCase()), log.data.toLowerCase()])) throw new Error('receipt_discovery_mismatch');
      if (factoryReceipts.has(tx.hash.toLowerCase())) {
        // Only pages containing this factory pay four bounded code/chain reads.
        // Unsupported code/semantics retains the full creation receipt for
        // explicit decoder repair, including unmonitored creations. Raw capture
        // continues; only an authenticated proof can create an approved fact.
        stockwaveCode ??= readFreshStockwaveCodeEvidence(rpc, blocks.at(-1)!).catch(() => null);
        const evidence = await stockwaveCode;
        const fact = evidence ? classifyFreshStockwaveCreation({ transaction: tx, receipt, block, startBlock: checkpoint.startBlock, codeEvidence: evidence }) : null;
        if (fact) facts.push(fact);
        else launchRepair = { version: 1, kind: 'stockwave', reason: evidence ? 'factory_creation_proof_invalid' : 'factory_creation_code_unverified' };
      }
      if (tx.to === null && receipt.status === '0x1' && freshAddress(receipt.contractAddress)) {
        const authenticity = classifyFreshCreationToken({ transaction: tx, receipt, block });
        facts.push({ tokenAddress: receipt.contractAddress!.toLowerCase(), protocol: 'evm_creation',
          blockNumber: safeNumber(block.number), blockHash: block.hash.toLowerCase(), txHash: tx.hash.toLowerCase(), logIndex: null,
          launchedAt: new Date(safeNumber(block.timestamp) * 1_000).toISOString(),
          proof: { creator: tx.from.toLowerCase(), creation: 'top_level', ...(authenticity ? { authenticity } : {}) },
          status: authenticity ? 'excluded_non_token' : safeNumber(block.number) > checkpoint.startBlock ? 'eligible' : 'before_boundary' });
      }
      // This optional pure proof uses only a full creation context already
      // fetched for collection. Never delay raw capture with historical code
      // calls or fetch every unrelated launch receipt for enrichment.
      if (freshHash(checkpoint.startHash)) for (let i=0;i<facts.length;i++) {
        const fact=facts[i];if(fact.txHash!==tx.hash.toLowerCase()||fact.blockHash!==block.hash.toLowerCase())continue;
        try{facts[i]=enrichFreshKnownTokenBirth(fact,{transaction:tx,receipt,block},{number:checkpoint.startBlock,hash:checkpoint.startHash!});}
        catch{/* Raw collection and the original launch fact survive optional proof failure. */}
      }
      if (relevant || launchRepair) {
        const involved = new Set<string>();
        for (const value of [tx.from, tx.to]) if (value && watched.has(value.toLowerCase())) involved.add(value.toLowerCase());
        for (const log of receipt.logs) for (const topic of log.topics.slice(1)) {
          const address = /^0x0{24}[\da-f]{40}$/i.test(topic) ? `0x${topic.slice(-40).toLowerCase()}` : null;
          if (address && watched.has(address)) involved.add(address);
        }
        receipts.push({ transaction: tx, receipt, wallets: [...involved].sort(), observedAt, ...(launchRepair ? { launchRepair } : {}) });
      }
  }
  return { previous: checkpoint, blocks, receipts, launches: facts,nodeHead:head,nodeHeadObservedAt };
}

/** The registration API takes this same row lock and increments revision when
 * monitored membership changes. Stale in-flight capture is retried in full. */
export async function commitFreshPage(client: PoolClient, page: FreshCapturedPage): Promise<void> {
  if (!page.blocks.length) return;
  const checkpoint = await client.query('SELECT block_number,block_hash,revision FROM fresh.checkpoints WHERE key=\'capture\' FOR UPDATE');
  const current = checkpoint.rows[0];
  if (!current || Number(current.block_number) !== page.previous.blockNumber || current.block_hash !== page.previous.blockHash || Number(current.revision) !== page.previous.revision) throw new Error('capture_checkpoint_changed');
  for (const block of page.blocks) await client.query(`INSERT INTO fresh.recent_blocks(block_number,block_hash,parent_hash,occurred_at,captured_at)
    VALUES($1,$2,$3,to_timestamp($4),clock_timestamp()) ON CONFLICT(block_number) DO NOTHING`, [safeNumber(block.number), block.hash.toLowerCase(), block.parentHash.toLowerCase(), safeNumber(block.timestamp)]);
  for (const entry of page.receipts) await client.query(`INSERT INTO fresh.recent_evidence(tx_hash,block_hash,block_number,transaction_index,expires_at,payload,decoder_status,decoder_version,wallet_addresses)
    VALUES($1,$2,$3,$4,$5,$6,'pending',0,$7) ON CONFLICT(tx_hash,block_hash) DO NOTHING`, [entry.transaction.hash.toLowerCase(), entry.receipt.blockHash.toLowerCase(), safeNumber(entry.receipt.blockNumber), safeNumber(entry.transaction.transactionIndex), new Date(Date.parse(entry.observedAt) + FRESH_EVIDENCE_TTL_MS), encodeFreshEvidence(entry), entry.wallets]);
  for (const fact of page.launches) await client.query(`INSERT INTO fresh.launch_facts(token_address,protocol,block_number,block_hash,tx_hash,log_index,launched_at,proof,status)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9) ON CONFLICT(token_address) DO NOTHING`, [fact.tokenAddress, fact.protocol, fact.blockNumber, fact.blockHash, fact.txHash, fact.logIndex, fact.launchedAt, JSON.stringify(fact.proof), fact.status]);
  const last = page.blocks.at(-1)!;
  await client.query(`UPDATE fresh.checkpoints SET block_number=$1,block_hash=$2,updated_at=clock_timestamp() WHERE key='capture'`, [safeNumber(last.number), last.hash.toLowerCase()]);
}

export async function readFreshCaptureState(database: Pick<Pool, 'query'>): Promise<{ checkpoint: FreshCaptureCheckpoint; wallets: FreshMonitoredWallet[] }> {
  const saved = await database.query(`SELECT block_number,block_hash,revision,value FROM fresh.checkpoints WHERE key='capture'`);
  const row = saved.rows[0]; if (!row || !Number.isSafeInteger(Number(row.value?.startBlock))) throw new Error('tracking_boundary_uninitialized');
  const wallets = await database.query(`SELECT address,monitoring_from_block,monitoring_to_block FROM fresh.wallets WHERE monitoring_from_block IS NOT NULL`);
  return { checkpoint: { blockNumber: Number(row.block_number), blockHash: row.block_hash, revision: Number(row.revision), startBlock: Number(row.value.startBlock), startHash: row.value.startHash },
    wallets: wallets.rows.map(wallet => ({ address: wallet.address, fromBlock: Number(wallet.monitoring_from_block), toBlock: wallet.monitoring_to_block == null ? null : Number(wallet.monitoring_to_block) })) };
}

export async function runFreshCapture(database: Pool, rpc: Rpc, options: { limit?: number; catchUpLimit?: number; now?: Date } = {}) {
  const state = await readFreshCaptureState(database), page = await collectFreshPage({ rpc, ...state, ...options });
  // Reuse the collector's existing head read. Scheduling health must measure
  // actual confirmed backlog rather than infer it from block timestamps.
  const capturedBlock=page.blocks.length?safeNumber(page.blocks.at(-1)!.number):state.checkpoint.blockNumber;
  const nodeHead=page.nodeHead!,confirmedHeadBlock=Math.max(0,nodeHead-FRESH_CONFIRMATIONS);
  const progress:FreshCaptureProgress={nodeHead,confirmedHeadBlock,capturedBlock,lagBlocks:Math.max(0,confirmedHeadBlock-capturedBlock),checkedAt:page.nodeHeadObservedAt!};
  if (!page.blocks.length) return { blocks: 0, receipts: 0, launches: 0,...progress };
  const ending = page.blocks.at(-1)!;
  const canonical = await rpc<{ number: string; hash: string }>('eth_getBlockByNumber', [ending.number, false]);
  if (!canonical || canonical.hash.toLowerCase() !== ending.hash.toLowerCase() || freshInteger(canonical.number) !== freshInteger(ending.number)) throw new Error('capture_page_reorged');
  const client = await database.connect();
  try { await client.query('BEGIN'); await commitFreshPage(client, page); await client.query('COMMIT'); }
  catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  return { blocks: page.blocks.length, receipts: page.receipts.length, launches: page.launches.length,...progress };
}

/** Bounded expiry. Only the two exact audited synthetic-method identity
 * headers are retained; raw receipts and ordinary headers still expire. */
export async function expireFreshEvidence(database: Pool, now = new Date(), limit = 1_000) {
  const client = await database.connect();
  try {
    await client.query('BEGIN');
    const result = await expireFreshEvidenceInTransaction(client, now, limit);
    await client.query('COMMIT'); return result;
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}
/** Caller owns the transaction. Exported for controlled-time integration tests
 * that roll their fixture writes back without touching active collection. */
export async function expireFreshEvidenceInTransaction(client: PoolClient, now = new Date(), limit = 1_000) {
    const rows = (await client.query(`SELECT tx_hash,block_hash,block_number,transaction_index,wallet_addresses,decoder_status,last_error,
      position_dependency_addresses,position_dependency_proof,expires_at,
      CASE WHEN decoder_status<>'done' THEN encode(sha256(payload),'hex') ELSE NULL END AS unresolved_payload_sha256
      FROM fresh.recent_evidence
      WHERE expires_at<=$1 ORDER BY expires_at LIMIT $2 FOR UPDATE SKIP LOCKED`, [now, Math.min(5_000, Math.max(1, limit))])).rows;
    for (const row of rows) {
      const reference=`${row.tx_hash}:${row.block_hash}`;
      if (row.decoder_status !== 'done') {
        await invalidateFreshRealizedGapCoverage(client,row.wallet_addresses,Number(row.block_number),now);
        await client.query(`UPDATE fresh.wallets SET decode_gap_from_block=least(decode_gap_from_block,$2::bigint),decode_gap_reason='expired_undecoded_evidence'
          WHERE address=ANY($1::text[])`, [row.wallet_addresses, row.block_number]);
        // The agreed repair buffer expires; its unresolved identity must not.
        // A small unavailable job retains what needs recovery, not raw evidence
        // or a copied financial response. It never approves or clears the gap.
        const manifest={version:1,kind:'expired_receipt_reference_v1',transactionHash:row.tx_hash,blockHash:row.block_hash,
          blockNumber:Number(row.block_number),transactionIndex:row.transaction_index,walletAddresses:row.wallet_addresses,
          dependencyAddresses:row.position_dependency_addresses??[],dependencyProof:row.position_dependency_proof??null,
          payloadSha256:row.unresolved_payload_sha256,
          expiresAt:new Date(row.expires_at).toISOString(),expiredAt:now.toISOString(),lastError:row.last_error};
        await client.query(`INSERT INTO fresh.jobs(id,kind,reference,state,progress,last_error,due_at)
          VALUES($1,'decode_receipt',$2,'unavailable',$3::jsonb,'expired_undecoded_evidence',$4)
          ON CONFLICT(kind,reference) DO UPDATE SET state='unavailable',progress=fresh.jobs.progress||EXCLUDED.progress,
            last_error=EXCLUDED.last_error,lease_id=NULL,lease_until=NULL,updated_at=clock_timestamp()`,
          [`decode:${reference}`,reference,JSON.stringify({expiredEvidence:manifest}),now]);
      } else await client.query("DELETE FROM fresh.jobs WHERE kind='decode_receipt' AND reference=$1", [reference]);
      await client.query('DELETE FROM fresh.recent_evidence WHERE tx_hash=$1 AND block_hash=$2', [row.tx_hash, row.block_hash]);
    }
    const pinnedSyntheticHeaders=FRESH_ADDITIONAL_SYNTHETIC_BATCH_AUDITS.map(a=>`(b.block_number=${a.creationBlock} AND b.block_hash='${a.creationHash}')`).join(' OR ');
    const blocks = await client.query(`DELETE FROM fresh.recent_blocks WHERE block_number IN
      (SELECT b.block_number FROM fresh.recent_blocks b WHERE b.captured_at<=$1 AND NOT(${pinnedSyntheticHeaders}) AND NOT ${freshRealizedGapPinnedHeadersSql('b')} AND NOT EXISTS(SELECT 1 FROM fresh.recent_evidence e WHERE e.block_hash=b.block_hash)
        ORDER BY b.block_number LIMIT $2)`, [new Date(now.getTime() - FRESH_EVIDENCE_TTL_MS), Math.min(5_000, Math.max(1, limit))]);
    return { evidence: rows.length, blocks: blocks.rowCount ?? 0, expiredUndecoded: rows.filter(row => row.decoder_status !== 'done').length,realizedGapExpiryGuardVersion:1 as const };
}

export async function findFreshCommonAncestor(database: Pick<Pool, 'query'>, rpc: Rpc, checkpoint: FreshCaptureCheckpoint, maximum = 512): Promise<{ blockNumber: number; blockHash: string } | null> {
  const recent = await database.query(`SELECT block_number,block_hash FROM fresh.recent_blocks WHERE block_number<=$1 AND block_number>=$2 ORDER BY block_number DESC`, [checkpoint.blockNumber, Math.max(checkpoint.startBlock, checkpoint.blockNumber - Math.min(2_048, maximum))]);
  for (const row of recent.rows) {
    const block = await rpc<FreshBlock>('eth_getBlockByNumber', [blockHex(row.block_number), false]);
    if (!block || safeNumber(block.number) !== Number(row.block_number) || !freshHash(block.hash)) throw new Error('reorg_block_unavailable');
    if (block.hash.toLowerCase() === row.block_hash) return { blockNumber: Number(row.block_number), blockHash: row.block_hash };
  }
  // The immutable start hash is a fallback only while the initial window is
  // itself inside the bounded search. It cannot authorize rewinding weeks of
  // history after all intermediate repair headers have expired.
  if (checkpoint.startHash && checkpoint.blockNumber - checkpoint.startBlock <= Math.min(2_048, maximum)) {
    const start = await rpc<{ number: string; hash: string }>('eth_getBlockByNumber', [blockHex(checkpoint.startBlock), false]);
    if (start && safeNumber(start.number) === checkpoint.startBlock && start.hash.toLowerCase() === checkpoint.startHash) return { blockNumber: checkpoint.startBlock, blockHash: checkpoint.startHash };
  }
  return null;
}
