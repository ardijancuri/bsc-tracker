import WebSocket from 'ws';
import type { PoolClient } from 'pg';
import { ensureSchema, notifyUpdate, pool, setState } from './db.js';
import { flapLogoFromHtml, flapMetadataUri, geniusLogoFromHtml } from './tokenLogo.js';
import { downloadTokenImage, downloadTokenMetadataImage, onchainTokenImage, type TokenImage } from './tokenImage.js';
import { ensureSeeds } from './seeds.js';
import { transferTopic, walletSwapFlows } from './swap.js';
import { createNodeLeaderboardService } from './nodeLeaderboard.js';
import { loadPublicNodeLeaderboardAccounting } from './nodeLeaderboardAccounting.js';
import { isMemeToken } from './memeToken.js';
import { intelligenceLoop, recordWalletTransfers, rollbackIntelligence } from './intelligenceWorker.js';
import { telegramNotifications, rollbackTelegramNotifications } from './telegramNotifications.js';
import { geckoFetch } from './geckoApi.js';
import { transactionWallets, walletTransactionContext } from './smartAccountTrades.js';
import { claimKolTokenTradeRepairs, finishKolTokenTradeRepair, type KolTokenTradeRepairJob } from './kolTokenTradeRepair.js';
import { verifiedTradeRepair } from './verifiedTradeRepair.js';
import { initializeJournalCollectionBoundary, recordJournalCollectionRange, rollbackJournalCollection } from './journalCollection.js';
import { captureNodeTraceBatch, type NodeCallTrace } from './nodeTrace.js';
import { nodeMarketService } from './nodeMarket.js';
import { TRUSTED_QUOTE_FEEDS } from './nodeMarketProtocols.js';
import { nodeMarketDiscoverySql, nodeMarketReceiptHintsSql } from './nodeMarketDiscovery.js';
import { nodeAccountingService } from './nodeAccounting.js';
import { runNodeAccountingWorkers } from './nodeAccountingQueue.js';
import { rollbackNodeAccounting } from './nodeAccountingSchema.js';
import { nodeHistoricalImporter } from './nodeHistoricalImport.js';
import { tokenChartRecovery } from './nodeTokenChartRecovery.js';
import { writeNodeTradeProjection, type PreparedNodeTradeProjection } from './nodeTradeProjection.js';
import { decodeNodeExecutions, type NodeExecution } from './nodeExecution.js';
import { createNodeProjectionMetadata, type NodeProjectionTokenMetadata } from './nodeProjectionMetadata.js';
import { createNodeTokenIdentityService } from './nodeTokenIdentity.js';
import { nodeCaptureHasPriority, nodeCaptureRepairAllowed, nodeMetadataShouldDrain } from './nodeCaptureScheduling.js';
import { nodeOperationalReadiness } from './nodeReadiness.js';
import { bootstrapNodeCapture, nodeCaptureStart, nodeCaptureRangeEnd, collectNodeEvidenceRange, drainNodeEvidenceDecode, drainNodeEvidenceMetadata, drainNodeEvidenceProjection, findNodeEvidenceReorgStart, nextNodeCollectionRepair, rollbackNodeEvidence, syncNodeMonitoredWallets, type CollectedNodeEvidence } from './nodeEvidence.js';

const rpcUrl = process.env.BSC_RPC_HTTP || 'http://127.0.0.1:8545';
const wsUrl = process.env.BSC_RPC_WS || 'ws://127.0.0.1:8546';
const bnbUsdFeed = '0x0567f2323251f0aab15c8dfb1967e4e8a7d42aee';
const addressRe = /^0x[a-fA-F0-9]{40}$/;
const hashRe = /^0x[a-fA-F0-9]{64}$/;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const normalized = (value: unknown) => typeof value === 'string' && addressRe.test(value) ? value.toLowerCase() : null;
let rpcId = 0;
let featuresLiveSince = Infinity;

type RpcLog = { address: string; topics: string[]; data: string; transactionHash: string; blockNumber: string; blockHash?: string; removed?: boolean };
type RpcTx = { hash: string; from: string; to: string | null; value: string; blockNumber: string; blockHash?: string; transactionIndex: string | null };
type RpcReceipt = { status: string; logs: RpcLog[]; blockHash: string; transactionHash?: string; blockNumber?: string };
type RpcBlock = { number: string; hash: string; parentHash: string; timestamp: string };

async function rpc<T>(method: string, params: unknown[], endpoint = rpcUrl): Promise<T> {
  const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }), signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`RPC ${method}: HTTP ${response.status}`);
  const body = await response.json() as { result?: T; error?: { message: string } };
  if (body.error) throw new Error(`RPC ${method}: ${body.error.message}`);
  return body.result as T;
}
const hex = (value: number) => `0x${value.toString(16)}`;
const topicAddress = (address: string) => `0x${address.slice(2).padStart(64, '0')}`;
const units = (value: bigint, decimals: number) => {
  const divisor = 10n ** BigInt(decimals);
  const fraction = (value % divisor).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${value / divisor}${fraction ? `.${fraction}` : ''}`;
};

const bnbPrices = new Map<number, number>();
const oracleRounds = new Map<string, { price: number; updatedAt: number }>();
function parseOracleRound(raw: string): { id: bigint; price: number; updatedAt: number } | null {
  if (!/^0x[0-9a-fA-F]{320}$/.test(raw)) return null;
  const words = raw.slice(2).match(/.{64}/g)!;
  const price = Number(BigInt(`0x${words[1]}`)) / 1e8;
  const updatedAt = Number(BigInt(`0x${words[3]}`));
  return price > 0 && updatedAt > 0 ? { id: BigInt(`0x${words[0]}`), price, updatedAt } : null;
}
async function oracleRound(id: bigint) {
  const key = id.toString();
  const cached = oracleRounds.get(key);
  if (cached) return cached;
  const raw = await rpc<string>('eth_call', [{ to: bnbUsdFeed, data: `0x9a6fc8f5${id.toString(16).padStart(64, '0')}` }, 'latest']);
  const result = parseOracleRound(raw);
  if (!result) throw new Error(`Invalid Chainlink round ${key}`);
  const value = { price: result.price, updatedAt: result.updatedAt };
  oracleRounds.set(key, value);
  if (oracleRounds.size > 512) oracleRounds.delete(oracleRounds.keys().next().value!);
  return value;
}
async function historicalBnbPrice(time: number): Promise<{ price: number; updatedAt: number } | null> {
  const latest = parseOracleRound(await rpc<string>('eth_call', [{ to: bnbUsdFeed, data: '0xfeaf968c' }, 'latest']));
  if (!latest || time > Math.floor(Date.now() / 1000) + 60) return null;
  if (latest.updatedAt <= time) return time - latest.updatedAt <= 7200 ? latest : null;
  const phaseStart = (latest.id >> 64n) << 64n;
  let low = phaseStart + 1n;
  let high = latest.id;
  while (low < high) {
    const middle = (low + high + 1n) / 2n;
    const round = await oracleRound(middle);
    if (round.updatedAt <= time) low = middle;
    else high = middle - 1n;
  }
  const round = await oracleRound(low);
  return round.updatedAt <= time && time - round.updatedAt <= 7200 ? round : null;
}
async function bnbPrice(block: number | 'latest', blockTime?: number): Promise<{ price: number; updatedAt: number } | null> {
  const cached = typeof block === 'number' ? bnbPrices.get(block) : undefined;
  if (cached != null) return { price: cached, updatedAt: blockTime || 0 };
  try {
    let round;
    try {
      const raw = await rpc<string>('eth_call', [{ to: bnbUsdFeed, data: '0xfeaf968c' }, block === 'latest' ? 'latest' : hex(block)]);
      round = parseOracleRound(raw);
    } catch (error) {
      if (block === 'latest' || !blockTime || !/not supported|missing trie node|state.*unavailable|header not found|block not found/i.test(String(error))) throw error;
      round = await historicalBnbPrice(blockTime);
    }
    if (!round) return null;
    const { price, updatedAt } = round;
    const time = blockTime || Math.floor(Date.now() / 1000);
    if (!(price > 0) || updatedAt <= 0 || updatedAt > time + 60 || time - updatedAt > 7200) return null;
    if (typeof block === 'number') {
      bnbPrices.set(block, price);
      if (bnbPrices.size > 128) bnbPrices.delete(bnbPrices.keys().next().value!);
    }
    return { price, updatedAt };
  } catch (error) { console.warn('BNB price feed:', error); return null; }
}

type TokenMeta = NodeProjectionTokenMetadata;
const projectionMetadata = createNodeProjectionMetadata({ database: pool, rpc });
const tokenIdentity = createNodeTokenIdentityService({ database: pool, rpc });
const tokenMeta = (address: string, block: RpcBlock) => projectionMetadata.load(address, block);

type PreparedTradeProjection = PreparedNodeTradeProjection;
async function persistNodeTrade(tx: RpcTx, receipt: RpcReceipt, block: RpcBlock, wallet: string, live = false, onlyToken?: string, database: Pick<PoolClient, 'query'> = pool, execution?: NodeExecution, prepared?: PreparedTradeProjection) {
  if (database !== pool && !prepared) throw new Error('node_projection_dependencies_not_prepared');
  if (!prepared) {
    const context = execution ? { logs: execution.logs, nativeValue: BigInt(execution.nativeValueRaw) } : walletTransactionContext(tx, receipt, wallet);
    if (!context) return;
    const addresses = [...walletSwapFlows(wallet, context.nativeValue, context.logs).keys()];
    const timestamp = new Date(Number(BigInt(block.timestamp)) * 1000).toISOString();
    const [metadata, oracle, conversions, traceRows] = await Promise.all([
      Promise.all(addresses.map(async address => [address, await tokenMeta(address, block)] as const)),
      bnbPrice(Number(BigInt(block.number)), Number(BigInt(block.timestamp))),
      Promise.all(addresses.filter(address => Object.hasOwn(TRUSTED_QUOTE_FEEDS, address)).map(async address => [address,
        await nodeMarketService.priceAt(address, { timestamp, blockNumber: String(Number(BigInt(block.number))), maxAgeMs: 300_000 })] as const)),
      pool.query('SELECT trace FROM node_trace_evidence WHERE tx_hash=$1 AND block_hash=$2', [tx.hash.toLowerCase(), block.hash.toLowerCase()]),
    ]);
    prepared = { metadata: new Map(metadata), oracle, conversions: new Map(conversions), trace: traceRows.rows[0]?.trace };
  }
  await writeNodeTradeProjection(database, { transaction: tx, receipt, block, wallet, live, onlyToken, execution }, prepared);
}

async function rollbackIfReorg() {
  const last = await pool.query("SELECT (value->>'blockNumber')::bigint AS block_number,value->>'blockHash' AS block_hash FROM worker_state WHERE key='node_collection'");
  if (!last.rows.length) return;
  const height = Number(last.rows[0].block_number);
  const canonical = await rpc<RpcBlock | null>('eth_getBlockByNumber', [hex(height), false]);
  if (canonical && Number(BigInt(canonical.number)) !== height) throw new Error('Node returned the wrong reorg checkpoint');
  if (canonical?.hash.toLowerCase() === last.rows[0].block_hash.toLowerCase()) return;
  const rollbackFrom = await findNodeEvidenceReorgStart(pool, async number => {
    const candidate = await rpc<RpcBlock | null>('eth_getBlockByNumber', [hex(number), false]);
    if (candidate && Number(BigInt(candidate.number)) !== number) throw new Error('Canonical block number mismatch during reorg');
    return candidate?.hash ?? null;
  });
  if (rollbackFrom == null) return;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(782319)');
    await rollbackTelegramNotifications(client, rollbackFrom);
    await rollbackJournalCollection(client, rollbackFrom);
    await rollbackNodeEvidence(client, rollbackFrom);
    await nodeMarketService.rollback(client, rollbackFrom);
    await rollbackNodeAccounting(client, String(rollbackFrom));
    await client.query(`UPDATE node_import_jobs SET stage=CASE WHEN stage IN ('chart','done') THEN 'reconcile' ELSE stage END,completed_at=NULL,next_attempt_at=now()
      WHERE EXISTS(SELECT 1 FROM node_accounting_baselines b WHERE b.wallet_address=node_import_jobs.wallet_address AND b.token_address=node_import_jobs.token_address AND b.invalidated_at IS NOT NULL)`);
    await client.query('DELETE FROM trades WHERE block_number >= $1', [rollbackFrom]);
    await rollbackIntelligence(client, rollbackFrom);
    await client.query('DELETE FROM processed_blocks WHERE block_number >= $1', [rollbackFrom]);
    await client.query(`DELETE FROM worker_state WHERE key='node'`);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
  bnbPrices.clear(); oracleRounds.clear(); projectionMetadata.clear();
  await notifyUpdate();
  console.warn(`Reorganization at ${height}; rescanning from ${rollbackFrom}`);
}

async function scanRange(from: number, to: number, head: number, repairWallet?: string) {
  const generations = await syncNodeMonitoredWallets(pool);
  const coverageRows = await pool.query(`SELECT wallet_address,generation::text FROM journal_wallet_coverage WHERE wallet_address=ANY($1::text[])`, [[...generations.keys()]]);
  const coverageGenerations = new Map<string, string>(coverageRows.rows.map(row => [row.wallet_address, row.generation]));
  const collected = await collectNodeEvidenceRange({ database: pool, rpc, from, to, head, generations, repairWallet, liveSince: featuresLiveSince,
    commitCompatibility: async (database, blocks, wallets) => {
      await initializeJournalCollectionBoundary(database, wallets, { number: from - 1, hash: blocks[0].parentHash.toLowerCase() }, coverageGenerations);
      await recordJournalCollectionRange(database, wallets, from, to, Boolean(repairWallet), coverageGenerations);
      if (!repairWallet) {
        await database.query(`INSERT INTO processed_blocks(block_number,block_hash) SELECT * FROM unnest($1::bigint[],$2::text[])
          ON CONFLICT(block_number) DO UPDATE SET block_hash=EXCLUDED.block_hash,processed_at=now()`, [blocks.map(block => Number(BigInt(block.number))), blocks.map(block => block.hash)]);
        await database.query('DELETE FROM processed_blocks WHERE block_number < $1', [to - 128]);
      }
    } });
  await setState('node_collection_metrics', { ...collected, blocks: collected.blocks.length, from, to, repair: Boolean(repairWallet) });
}

async function projectNodeEvidence(entry: CollectedNodeEvidence) {
  const tx = entry.transaction as RpcTx, receipt = entry.receipt as RpcReceipt, block = entry.block as RpcBlock;
  const executions = decodeNodeExecutions(entry.transaction, entry.receipt, entry.block, entry.wallets), ordinary = transactionWallets(tx, receipt);
  const addresses = new Set(executions.flatMap(item => item.flows.map(flow => flow.tokenAddress)));
  for (const wallet of ordinary) if (entry.wallets.has(wallet)) {
    const context = walletTransactionContext(tx, receipt, wallet)!;
    for (const address of walletSwapFlows(wallet, context.nativeValue, context.logs).keys()) addresses.add(address);
  }
  // Resolve optional metadata before rollback's lock, then write every legacy
  // projection against the still-present canonical saved receipt atomically.
  const metadata = new Map(await Promise.all([...addresses].map(async address => [address, await projectionMetadata.load(address, block, { allowRpc: false })] as const)));
  const persistedPrice = await nodeMarketService.priceAt('0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c', {
    timestamp: new Date(Number(BigInt(block.timestamp)) * 1000).toISOString(), blockNumber: String(Number(BigInt(block.number))), maxAgeMs: 300_000 });
  const feePrice = persistedPrice.priceUsd && !persistedPrice.stale && persistedPrice.timestamp
    ? { price: persistedPrice.priceUsd, updatedAt: Date.parse(persistedPrice.timestamp) / 1000 } : null;
  const trace = (await pool.query('SELECT trace FROM node_trace_evidence WHERE tx_hash=$1 AND block_hash=$2',
    [tx.hash.toLowerCase(), block.hash.toLowerCase()])).rows[0]?.trace as NodeCallTrace | undefined;
  const conversions = new Map(await Promise.all([...addresses].filter(address => Object.hasOwn(TRUSTED_QUOTE_FEEDS, address)).map(async address =>
    [address, await nodeMarketService.priceAt(address, { timestamp: new Date(Number(BigInt(block.timestamp)) * 1000).toISOString(),
      blockNumber: String(Number(BigInt(block.number))), maxAgeMs: 300_000 })] as const)));
  const prepared = { metadata, oracle: feePrice, trace, conversions }, client = await pool.connect();
  try {
    await client.query('BEGIN'); await client.query('SELECT pg_advisory_xact_lock_shared(782319)');
    const canonical = await client.query('SELECT tx_hash FROM node_evidence_transactions WHERE tx_hash=$1 AND block_hash=$2', [tx.hash.toLowerCase(), block.hash.toLowerCase()]);
    if (!canonical.rows.length) throw new Error('node_projection_orphaned');
    for (const wallet of ordinary) if (entry.wallets.has(wallet)) await persistNodeTrade(tx, receipt, block, wallet, entry.observedLive, undefined, client, undefined, prepared);
    for (const execution of executions) if (execution.kind === 'user_operation' && execution.status === 'success' && !ordinary.includes(execution.walletAddress))
      await persistNodeTrade(tx, receipt, block, execution.walletAddress, entry.observedLive, undefined, client, execution, prepared);
    await recordWalletTransfers(tx, receipt, block, entry.wallets, client, executions);
    await client.query(`INSERT INTO journal_node_evidence(tx_hash,block_number,block_hash,timestamp,transaction,receipt,bnb_price_usd,bnb_priced_at)
      VALUES($1,$2,$3,to_timestamp($4),$5::jsonb,$6::jsonb,$7,to_timestamp($8)) ON CONFLICT(tx_hash) DO UPDATE SET block_number=EXCLUDED.block_number,
      block_hash=EXCLUDED.block_hash,timestamp=EXCLUDED.timestamp,transaction=EXCLUDED.transaction,receipt=EXCLUDED.receipt,
      bnb_price_usd=COALESCE(EXCLUDED.bnb_price_usd,journal_node_evidence.bnb_price_usd),bnb_priced_at=COALESCE(EXCLUDED.bnb_priced_at,journal_node_evidence.bnb_priced_at)`,
    [tx.hash.toLowerCase(), Number(BigInt(block.number)), block.hash, Number(BigInt(block.timestamp)), JSON.stringify(tx), JSON.stringify(receipt), feePrice?.price ?? null, feePrice?.updatedAt ?? null]);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  if ([...metadata.values()].some(value => value.decimals === null)) return { pendingReason: 'node_projection_token_decimals_unavailable' };
}

async function nodeDecodeLoop() {
  for (;;) {
    try {
      const result = await drainNodeEvidenceDecode({ database: pool });
      if (result.decoded || result.projected) { await setState('node_decoding', { ...result, at: new Date().toISOString() }); await notifyUpdate(); }
      if (!result.decoded && !result.projected) await sleep(1000);
    } catch (error) { console.warn('Node evidence decode:', error); await sleep(2000); }
  }
}

async function nodeProjectionLoop() {
  for (;;) {
    try { const started = performance.now();
      const result = await drainNodeEvidenceProjection({ database: pool, project: projectNodeEvidence });
      if (result.projected) {
        await setState('node_projection_metrics', { ...result, durationMs: Math.round(performance.now() - started), at: new Date().toISOString() });
        await notifyUpdate();
      } else await sleep(1000); }
    catch (error) { console.warn('Node legacy projection:', error); await sleep(2000); }
  }
}

const nodeMetadataConcurrency = 8;
async function nodeMetadataLoop(workerIndex: number) {
  const stage = workerIndex < 3 ? 'precision' : workerIndex < 5 ? 'pins' : workerIndex < 7 ? 'feed' : 'all';
  const history = workerIndex < 7 ? 'fresh' : 'historical';
  for (;;) {
    try {
      const checkpoint = (await pool.query("SELECT value FROM worker_state WHERE key='node_collection'")).rows[0]?.value;
      if (nodeCaptureHasPriority(checkpoint)) {
        if (history === 'historical') { await sleep(2000); continue; }
        const pins = stage === 'pins';
        const usableFreshWork = (await pool.query(`SELECT EXISTS(SELECT 1 FROM node_evidence_metadata_jobs WHERE completed_at IS NULL
          AND block_number>=$1::bigint-128 AND timestamp>=now()-interval '60 seconds'
          AND ${pins ? 'pinned_next_attempt_at' : 'next_attempt_at'}<=now()
          AND (${pins ? 'pinned_lease_until' : 'lease_until'} IS NULL OR ${pins ? 'pinned_lease_until' : 'lease_until'}<clock_timestamp())
          AND ($2::text='pins' AND NOT pinned_feed_complete OR $2='precision' AND NOT tokens<@completed_tokens
            OR $2='feed' AND NOT feed_complete AND pinned_feed_complete AND tokens<@completed_tokens)) AS available`, [checkpoint.headBlock,stage])).rows[0]?.available === true;
        if (!nodeMetadataShouldDrain(checkpoint, usableFreshWork)) { await sleep(2000); continue; }
      }
      const selected = await pool.query(`SELECT token_address FROM node_market_refresh_jobs WHERE expires_at>now()
        ORDER BY priority DESC,requested_at LIMIT 32`);
      const began = performance.now();
      const result = await drainNodeEvidenceMetadata({ database: pool,
        captureMetadata: (tokens, checkpoint) => nodeMarketService.captureMetadata(tokens, checkpoint),
        captureFeedEvidence: (checkpoint, tokens, options) => nodeMarketService.captureFeedEvidence(checkpoint, tokens, options),
        priorityTokens: selected.rows.map(row => row.token_address), limit: 1, stage, history,
        headBlock: Number.isSafeInteger(checkpoint?.headBlock) ? checkpoint.headBlock : undefined });
      if (result.claimed) {
        const metrics = { ...result, stage, history, workerIndex, durationMs: performance.now() - began,
          concurrency: nodeMetadataConcurrency, at: new Date().toISOString() };
        await setState(`node_metadata_metrics:${stage}:${history}`, metrics);
        await setState('node_metadata_metrics', metrics);
      }
      await sleep(result.claimed ? 250 : 1000);
    } catch (error) { console.warn('Node evidence metadata:', error); await sleep(2000); }
  }
}

// Process-local verification deliberately resets on restart. Another helper's
// stored trace or an environment path alone cannot verify this worker's IPC.
let privateTraceVerifiedAt: string | null = null;
async function nodeTraceLoop() {
  for (;;) {
    try {
      const result = await captureNodeTraceBatch(pool);
      const observedAt = new Date().toISOString();
      if (result.captured > 0) privateTraceVerifiedAt = observedAt;
      if (result.captured || result.unavailable) await setState('node_tracing', { ...result, at: observedAt, privateTraceVerifiedAt });
    }
    catch (error) { console.warn('Private node tracing:', error); }
    await sleep(5000);
  }
}

async function nodeLoop() {
  let wake = () => {};
  let socket: WebSocket | null = null;
  const connect = () => {
    socket = new WebSocket(wsUrl);
    socket.on('open', () => socket?.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_subscribe', params: ['newHeads'] })));
    socket.on('message', () => wake());
    socket.on('error', error => console.error('WebSocket error:', error.message));
    socket.on('close', () => { socket = null; setTimeout(connect, 5000); });
  };
  connect();
  for (;;) {
    try {
      await rollbackIfReorg();
      const head = Number(BigInt(await rpc<string>('eth_blockNumber', [])));
      const target = Math.max(0, head - 6);
      const start = await nodeCaptureStart(pool, { target, configuredStart: Number(process.env.BSC_START_BLOCK) });
      await syncNodeMonitoredWallets(pool);
      const repair = start > 0 && nodeCaptureRepairAllowed(start, target) ? await nextNodeCollectionRepair(pool, Math.min(target, start - 1)) : null;
      if (start <= target) await scanRange(start, nodeCaptureRangeEnd(start, target), head);
      if (repair) {
        try { await scanRange(repair.from, repair.to, head, repair.wallet); }
        catch (error) {
          await pool.query(`UPDATE node_monitored_wallets SET last_error=$2,updated_at=now() WHERE wallet_address=$1`, [repair.wallet,
            /prun|header not found|block not found|missing trie|historical|not supported/i.test(String(error)) ? 'node_history_unavailable' : 'collection_retry']);
          console.warn('Journal collection repair pending:', String(error));
        }
      }
      if (start > target) await new Promise<void>(resolve => { wake = resolve; setTimeout(resolve, 3000); });
    } catch (error) {
      console.error('Node worker:', error);
      await setState('node_error', { message: String(error), at: new Date().toISOString() });
      await sleep(5000);
    }
  }
}

async function repairQueuedTrade(job: KolTokenTradeRepairJob) {
  const tracked = await pool.query(`SELECT 1 FROM kols k WHERE k.address=$1 AND (k.is_tracked
    OR EXISTS(SELECT 1 FROM journal_wallets m WHERE m.wallet_address=k.address))`, [job.walletAddress]);
  if (!tracked.rows.length) return false;
  const saved = (await pool.query(`SELECT e.transaction,e.receipt,b.header FROM node_evidence_transactions e
    JOIN node_evidence_blocks b ON b.block_number=e.block_number AND b.block_hash=e.block_hash WHERE e.tx_hash=$1`, [job.txHash])).rows[0];
  const [tx, receipt, block, head] = saved ? [saved.transaction as RpcTx,saved.receipt as RpcReceipt,saved.header as RpcBlock,await rpc<string>('eth_blockNumber', [])] : await Promise.all([
    rpc<RpcTx | null>('eth_getTransactionByHash', [job.txHash]),rpc<RpcReceipt | null>('eth_getTransactionReceipt', [job.txHash]),
    rpc<RpcBlock | null>('eth_getBlockByNumber', [hex(Number(job.blockNumber)), false]),rpc<string>('eth_blockNumber', []),
  ]);
  if (!verifiedTradeRepair(job, tx, receipt, block, Number(BigInt(head)))) return false;
  // Resolve metadata and historical pricing before taking rollback's lock. This
  // cache warming only writes ancillary token metadata, never repaired trades.
  const context = walletTransactionContext(tx!, receipt!, job.walletAddress)!;
  const addresses = [...walletSwapFlows(job.walletAddress, context.nativeValue, context.logs).keys()];
  const [oracle, metadataEntries, conversionEntries, traceRows] = await Promise.all([
    bnbPrice(Number(BigInt(block!.number)), Number(BigInt(block!.timestamp))),
    Promise.all(addresses.map(async address => [address, await tokenMeta(address, block!)] as const)),
    Promise.all(addresses.filter(address => Object.hasOwn(TRUSTED_QUOTE_FEEDS, address)).map(async address => [address,
      await nodeMarketService.priceAt(address, { timestamp: new Date(Number(BigInt(block!.timestamp)) * 1000).toISOString(),
        blockNumber: String(job.blockNumber), maxAgeMs: 300_000 })] as const)),
    pool.query('SELECT trace FROM node_trace_evidence WHERE tx_hash=$1 AND block_hash=$2', [job.txHash, job.blockHash]),
  ]);
  const prepared: PreparedTradeProjection = { oracle, metadata: new Map(metadataEntries), conversions: new Map(conversionEntries), trace: traceRows.rows[0]?.trace };
  const client = await pool.connect();
  try {
    // Share rollback's lock: a repair must not recreate an orphaned trade after
    // the reorg worker already removed it. Re-read canonical proof after locking.
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(782319)');
    const canonical: RpcBlock | null = saved ? (await client.query('SELECT header FROM node_evidence_blocks WHERE block_number=$1 AND block_hash=$2', [job.blockNumber, job.blockHash])).rows[0]?.header ?? null
      : await rpc<RpcBlock | null>('eth_getBlockByNumber', [hex(Number(job.blockNumber)), false]);
    const confirmedHead = head;
    if (!verifiedTradeRepair(job, tx, receipt, canonical, Number(BigInt(confirmedHead)))) {
      await client.query('ROLLBACK'); return false;
    }
    await persistNodeTrade(tx!, receipt!, canonical!, job.walletAddress, false, job.tokenAddress, client, undefined, prepared);
    const stored = await client.query(`SELECT 1 FROM trades WHERE tx_hash=$1 AND wallet_address=$2 AND token_address=$3
      AND block_number=$4 AND block_hash=$5 AND side IN ('buy','sell') AND source IN ('node','node+gmgn')`,
    [job.txHash, job.walletAddress, job.tokenAddress, job.blockNumber, job.blockHash]);
    const success = stored.rows.length > 0;
    if (success) await recordWalletTransfers(tx!, receipt!, canonical!, new Set([job.walletAddress]), client);
    await client.query('COMMIT');
    return success;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}


async function tradeRepairLoop() {
  for (;;) {
    try {
      const jobs = await claimKolTokenTradeRepairs(2);
      const outcomes = await Promise.all(jobs.map(async job => {
        let success = false;
        try { success = await repairQueuedTrade(job); }
        catch (error) { console.warn(`Trade repair ${job.txHash}:`, error); }
        await finishKolTokenTradeRepair(job, success);
        return success;
      }));
      if (outcomes.some(Boolean)) await notifyUpdate();
    } catch (error) { console.error('Trade repair worker:', error); }
    await sleep(5000);
  }
}

async function refreshXAvatarOne() {
  const result = await pool.query(`SELECT address,twitter FROM kols
    WHERE is_tracked AND twitter ~ '^[A-Za-z0-9_]{1,15}$'
      AND avatar_url IS NULL
      AND (avatar_checked_at IS NULL OR avatar_checked_at < now() - interval '7 days')
    ORDER BY avatar_checked_at ASC NULLS FIRST LIMIT 1`);
  const row = result.rows[0] as { address: string; twitter: string } | undefined;
  if (!row) return;
  try {
    const response = await fetch(`https://x.com/${encodeURIComponent(row.twitter)}`, { signal: AbortSignal.timeout(15000), headers: { 'user-agent': 'Mozilla/5.0 (compatible; bscan-avatar-fetch/1.0)' } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const html = await response.text();
    const image = html.match(/<meta\s+property="og:image"\s+content="([^"]+)"/i)?.[1]?.replaceAll('&amp;', '&');
    if (!image || !/^https:\/\/pbs\.twimg\.com\/profile_images\//.test(image)) throw new Error('No public X profile image found');
    await pool.query('UPDATE kols SET avatar_url=$2,avatar_checked_at=now() WHERE address=$1 AND twitter=$3', [row.address, image, row.twitter]);
    await notifyUpdate();
  } catch (error) {
    const retrySoon = /HTTP (429|5\d\d)/.test(String(error));
    await pool.query(`UPDATE kols SET avatar_checked_at=CASE WHEN $2 THEN now()-interval '6 days 23 hours' ELSE now() END WHERE address=$1`, [row.address, retrySoon]);
    console.warn(`X avatar ${row.twitter}:`, error);
  }
}

async function avatarLoop() {
  for (;;) {
    try { await refreshXAvatarOne(); } catch (error) { console.warn('X avatar worker:', error); }
    await sleep(15_000);
  }
}

const validLogo = (value: unknown): value is string => typeof value === 'string' && /^https:\/\//i.test(value);
let pancakeLogos: { updatedAt: number; items: Map<string, string> } | null = null;
async function pancakeLogo(address: string): Promise<string | null> {
  if (!pancakeLogos || Date.now() - pancakeLogos.updatedAt > 86400_000) {
    try {
      const response = await fetch('https://tokens.pancakeswap.finance/pancakeswap-extended.json', { signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const list = await response.json() as { tokens?: { chainId: number; address: string; logoURI?: string }[] };
      const items = new Map<string, string>();
      for (const token of list.tokens || []) if (token.chainId === 56 && validLogo(token.logoURI)) items.set(token.address.toLowerCase(), token.logoURI);
      pancakeLogos = { updatedAt: Date.now(), items };
    } catch (error) { console.warn('PancakeSwap token logos:', error); }
  }
  return pancakeLogos?.items.get(address.toLowerCase()) || null;
}
async function usableLogo(url: unknown): Promise<TokenImage | null> {
  if (!validLogo(url)) return null;
  try { return await downloadTokenImage(url); } catch { return null; }
}

async function lookupTokenLogo(address: string): Promise<TokenImage | null> {
  if (address.endsWith('4444') || address.endsWith('ffff')) {
    try {
      const response = await fetch(`https://four.meme/meme-api/v1/private/token/get?address=${address}`, { signal: AbortSignal.timeout(12000) });
      if (response.ok) {
        const result = await response.json() as { data?: { address?: string; image?: string } };
        if (result.data?.address?.toLowerCase() === address) {
          const image = await usableLogo(result.data.image);
          if (image) return image;
        }
      }
    } catch (error) { console.warn(`Four.meme logo ${address}:`, error); }
  }
  if (address.endsWith('7777') || address.endsWith('8888')) {
    try {
      // IFlapToken.metaURI(): https://docs.flap.sh/flap/developers/wallet-and-terminal-and-bot-developers/parse-token-meta
      const uri = flapMetadataUri(await rpc<string>('eth_call', [{ to: address, data: '0x67605787' }, 'latest']));
      const image = uri ? await downloadTokenMetadataImage(uri) : null;
      if (image) return image;
    } catch { /* Older tokens can still expose artwork on their launch page. */ }
    try {
      const response = await fetch(`https://flap.sh/bnb/${address}`, { signal: AbortSignal.timeout(12000) });
      if (response.ok) {
        const html = await response.text();
        const image = flapLogoFromHtml(html, address);
        const logo = await usableLogo(image);
        if (logo) return logo;
      }
    } catch (error) { console.warn(`Flap logo ${address}:`, error); }
  }
  try {
    const response = await fetch(`https://genius.fun/token/${address}`, { signal: AbortSignal.timeout(12000) });
    if (response.ok) {
      const image = geniusLogoFromHtml(await response.text(), address);
      const logo = await usableLogo(image);
      if (logo) return logo;
    }
  } catch (error) { console.warn(`Genius.fun logo ${address}:`, error); }
  const listed = await pancakeLogo(address);
  const listedLogo = await usableLogo(listed);
  if (listedLogo) return listedLogo;
  try {
    const response = await fetch(`https://api.dexscreener.com/tokens/v1/bsc/${address}`, { signal: AbortSignal.timeout(12000) });
    if (response.ok) {
      const pairs = await response.json() as { baseToken?: { address?: string }; info?: { imageUrl?: string } }[];
      for (const pair of Array.isArray(pairs) ? pairs : []) {
        if (pair.baseToken?.address?.toLowerCase() !== address) continue;
        const image = await usableLogo(pair.info?.imageUrl);
        if (image) return image;
      }
    }
  } catch (error) { console.warn(`DexScreener logo ${address}:`, error); }
  try {
    const response = await geckoFetch(`https://api.geckoterminal.com/api/v2/networks/bsc/tokens/${address}/info`);
    if (response.ok) {
      const result = await response.json() as { data?: { attributes?: { address?: string; image_url?: string } } };
      if (result.data?.attributes?.address?.toLowerCase() === address) {
        const image = await usableLogo(result.data.attributes.image_url);
        if (image) return image;
      }
    }
  } catch (error) { console.warn(`GeckoTerminal logo ${address}:`, error); }
  try {
    const response = await fetch(`https://brew.family/api/shared/token/${address}`, { signal: AbortSignal.timeout(12000) });
    if (response.ok) {
      const result = await response.json() as { token?: { address?: string; imageUrl?: string } };
      if (result.token?.address?.toLowerCase() === address) {
        const source = result.token.imageUrl || '';
        const artwork = source.match(/^onchain:\/\/56\/(0x[a-f0-9]{40})$/i)?.[1];
        if (artwork) {
          const imageResponse = await fetch(`https://brew.family/api/shared/artwork/${artwork}`, { signal: AbortSignal.timeout(12000) });
          if (imageResponse.ok) {
            const image = await imageResponse.json() as { image?: string };
            const logo = await onchainTokenImage(source, image.image || '');
            if (logo) return logo;
          }
        } else {
          const logo = await usableLogo(source);
          if (logo) return logo;
        }
      }
    }
  } catch (error) { console.warn(`Brew logo ${address}:`, error); }
  return null;
}

async function refreshTokenLogoOne() {
  const result = await pool.query(`WITH candidate AS (SELECT t.address FROM tokens t WHERE t.logo_data IS NULL AND (
    ((t.logo_url IS NULL OR btrim(t.logo_url)='' OR t.logo_url LIKE '%gmgn.ai%')
      AND (t.logo_checked_at IS NULL OR t.logo_checked_at < now() - interval '30 minutes'
        OR (t.logo_checked_at < now() - interval '2 minutes' AND EXISTS (
          SELECT 1 FROM trades recent WHERE recent.token_address=t.address AND recent.timestamp > now() - interval '2 hours'))))
    OR (t.logo_url IS NOT NULL AND btrim(t.logo_url)<>'' AND t.logo_url NOT LIKE '%gmgn.ai%'
      AND (t.logo_cache_checked_at IS NULL OR t.logo_cache_checked_at < now() - interval '30 minutes'
        OR (t.logo_cache_checked_at < now() - interval '2 minutes' AND EXISTS (
          SELECT 1 FROM trades recent WHERE recent.token_address=t.address AND recent.timestamp > now() - interval '2 hours')))))
    ORDER BY EXISTS(SELECT 1 FROM trades recent WHERE recent.token_address=t.address AND recent.timestamp > now() - interval '2 hours') DESC,
      t.logo_checked_at ASC NULLS FIRST,
      (SELECT max(timestamp) FROM trades WHERE token_address=t.address) DESC NULLS LAST LIMIT 1 FOR UPDATE SKIP LOCKED)
    UPDATE tokens t SET logo_checked_at=now(),logo_cache_checked_at=now() FROM candidate c WHERE t.address=c.address RETURNING t.address,t.logo_url,t.symbol,t.name`);
  const address = result.rows[0]?.address as string | undefined;
  if (!address) return;
  await cacheTokenLogo(result.rows[0]);
}

async function cacheTokenLogo(token: { address: string; logo_url: string | null; symbol: string | null; name: string | null }) {
  const address = token.address;
  try {
    const existing = token.logo_url;
    const cached = existing && !existing.includes('gmgn.ai') ? await usableLogo(existing) : null;
    const logo = cached || await lookupTokenLogo(address);
    if (logo) {
      await pool.query(`UPDATE tokens SET logo_url=$2,logo_data=$3,logo_mime=$4,logo_checked_at=now(),logo_cache_checked_at=now(),is_meme=CASE WHEN $5 THEN true ELSE is_meme END WHERE address=$1`, [address, logo.url, logo.data, logo.mime, isMemeToken({ address, symbol: token.symbol, name: token.name, logoUrl: logo.url })]);
      await notifyUpdate();
      return true;
    } else {
      await pool.query(`UPDATE tokens SET logo_url=CASE WHEN logo_url LIKE '%gmgn.ai%' THEN NULL ELSE logo_url END,
        logo_checked_at=now(),logo_cache_checked_at=now() WHERE address=$1`, [address]);
    }
  } catch (error) {
    await pool.query(`UPDATE tokens SET logo_checked_at=now(),logo_cache_checked_at=now() WHERE address=$1`, [address]);
    console.warn(`Token logo ${address}:`, error);
  }
  return false;
}

async function repairTokenLogos(since: string) {
  const time = new Date(since);
  if (!Number.isFinite(time.getTime())) throw new Error('BSCAN_REPAIR_LOGOS_SINCE must be an ISO timestamp');
  const pending = await pool.query(`SELECT v.address,v.logo_url,v.symbol,v.name FROM tokens v WHERE v.logo_data IS NULL
    AND EXISTS(SELECT 1 FROM trades t JOIN kols k ON k.address=t.wallet_address WHERE k.is_tracked AND t.block_number IS NOT NULL AND t.token_address=v.address AND t.timestamp >= $1)
    ORDER BY (SELECT MAX(timestamp) FROM trades WHERE token_address=v.address) DESC`, [time]);
  for (let offset = 0; offset < pending.rows.length; offset += 3) {
    await Promise.all(pending.rows.slice(offset, offset + 3).map(async token => {
      console.log(JSON.stringify({ address: token.address, symbol: token.symbol, cached: await cacheTokenLogo(token) }));
    }));
  }
}

async function logoLoop() {
  for (;;) {
    try { await refreshTokenLogoOne(); } catch (error) { console.warn('Token logo worker:', error); }
    await sleep(4000);
  }
}

async function refreshTokenSupplyOne(): Promise<boolean> {
  const result = await pool.query(`SELECT t.address FROM tokens t
    WHERE t.price_source='onchain' AND t.price_usd > 0 AND t.decimals BETWEEN 0 AND 36
      AND (t.supply_checked_at IS NULL OR t.supply_checked_at < now() - interval '24 hours')
      AND EXISTS (SELECT 1 FROM trades x JOIN kols k ON k.address=x.wallet_address
        WHERE x.token_address=t.address AND k.is_tracked AND x.block_number IS NOT NULL)
    ORDER BY t.metadata_updated_at DESC NULLS LAST LIMIT 1`);
  const address = result.rows[0]?.address as string | undefined;
  if (!address) return false;
  try {
    const raw = await rpc<string>('eth_call', [{ to: address, data: '0x18160ddd' }, 'latest']);
    if (!/^0x[0-9a-fA-F]{64}$/.test(raw)) throw new Error('Invalid totalSupply response');
    const supply = BigInt(raw);
    await pool.query('UPDATE tokens SET total_supply_raw=$2,supply_checked_at=now() WHERE address=$1', [address, supply > 0n ? supply.toString() : null]);
  } catch (error) {
    await pool.query(`UPDATE tokens SET supply_checked_at=now()-interval '23 hours' WHERE address=$1`, [address]);
    console.warn(`Token supply ${address}:`, error);
  }
  return true;
}

async function supplyLoop() {
  for (;;) {
    let checked = false;
    try { checked = await refreshTokenSupplyOne(); } catch (error) { console.warn('Token supply worker:', error); }
    await sleep(checked ? 250 : 60_000);
  }
}

async function repairTradeValue(hash: string, wallet: string) {
  const saved = (await pool.query(`SELECT e.transaction,e.receipt,b.header FROM node_evidence_transactions e
    JOIN node_evidence_blocks b ON b.block_number=e.block_number AND b.block_hash=e.block_hash WHERE e.tx_hash=$1`, [hash])).rows[0];
  const [tx, receipt] = saved ? [saved.transaction as RpcTx,saved.receipt as RpcReceipt] : await Promise.all([
    rpc<RpcTx | null>('eth_getTransactionByHash', [hash]),rpc<RpcReceipt | null>('eth_getTransactionReceipt', [hash]),
  ]);
  if (!tx || !receipt) throw new Error(`Transaction receipt unavailable: ${hash}`);
  const block = saved?.header as RpcBlock | undefined ?? await rpc<RpcBlock>('eth_getBlockByNumber', [tx.blockNumber, false]);
  if (!block) throw new Error(`Transaction block unavailable: ${hash}`);
  await persistNodeTrade(tx, receipt, block, wallet);
  await pool.query('UPDATE trades SET value_checked_at=now() WHERE tx_hash=$1 AND wallet_address=$2', [hash, wallet]);
}

async function repairSellValueOne() {
  const result = await pool.query(`SELECT id,tx_hash,wallet_address FROM trades WHERE side IN ('buy','sell') AND amount_usd IS NULL
    AND source IN ('node','node+gmgn') AND block_number IS NOT NULL
    AND timestamp >= now() - interval '30 days'
    AND (value_checked_at IS NULL OR value_checked_at < now() -
      CASE WHEN timestamp >= now() - interval '24 hours' THEN interval '1 hour' ELSE interval '30 days' END)
    ORDER BY (timestamp >= now() - interval '24 hours') DESC,value_checked_at ASC NULLS FIRST,timestamp DESC LIMIT 1`);
  const row = result.rows[0] as { id: string; tx_hash: string; wallet_address: string } | undefined;
  if (!row) return;
  let success = false;
  try {
    await repairTradeValue(row.tx_hash, row.wallet_address);
    success = true;
  } finally {
    if (!success) await pool.query(`UPDATE trades SET value_checked_at=now()-interval '55 minutes' WHERE id=$1`, [row.id]);
    if (success) await notifyUpdate();
  }
}

async function repairWindowValues(since: string) {
  const time = new Date(since);
  if (!Number.isFinite(time.getTime())) throw new Error('BSCAN_REPAIR_VALUES_SINCE must be an ISO timestamp');
  const pending = await pool.query(`SELECT DISTINCT t.tx_hash,t.wallet_address FROM trades t JOIN kols k ON k.address=t.wallet_address
    WHERE k.is_tracked AND t.block_number IS NOT NULL AND t.source IN ('node','node+gmgn')
    AND t.side IN ('buy','sell') AND t.amount_usd IS NULL AND t.timestamp >= $1`, [time]);
  let attempted = 0, failures = 0;
  for (let offset = 0; offset < pending.rows.length; offset += 4) {
    await Promise.all(pending.rows.slice(offset, offset + 4).map(async row => {
      try { await repairTradeValue(row.tx_hash, row.wallet_address); }
      catch (error) { failures++; console.warn('Trade repair:', row.tx_hash, String(error)); }
      attempted++;
    }));
    if (attempted % 100 === 0 || attempted === pending.rows.length) console.log(JSON.stringify({ attempted, total: pending.rows.length, failures }));
  }
  await notifyUpdate();
}

async function sellValueLoop() {
  for (;;) {
    try { await repairSellValueOne(); } catch (error) { console.warn('Sell value worker:', error); }
    await sleep(1500);
  }
}

async function priceLoop() {
  for (;;) {
    try {
      const current = await bnbPrice('latest');
      if (current) {
        await setState('bnb_price', { priceUsd: current.price, oracleUpdatedAt: new Date(current.updatedAt * 1000).toISOString() });
        await notifyUpdate();
      }
    } catch (error) { console.warn('Price worker:', error); }
    await sleep(30_000);
  }
}

const nodeLeaderboard = createNodeLeaderboardService({ database: pool, calculate: loadPublicNodeLeaderboardAccounting });
async function leaderboardLoop() {
  let consecutiveChanges = 0;
  for (;;) {
    let waitMs = 5_000;
    try {
      // Rotate a bounded oldest batch so rolling-window expiry never waits for
      // a whole-roster calculation. Fresh accounting also requests its wallets.
      const result = await nodeLeaderboard.refresh({ limit: 24 });
      consecutiveChanges = 0;
      if (result.updatedWallets) await notifyUpdate();
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'leaderboard_unavailable';
      if (/^node_leaderboard_(monitoring|accounting_evidence|fee_evidence|canonical_evidence)_changed$/.test(reason)) {
        if (++consecutiveChanges <= 3) waitMs = 5_000;
        console.warn('Leaderboard evidence changed:', { reason, retryAfterMs: waitMs });
      } else { consecutiveChanges = 0; console.error('Leaderboard worker:', error); }
    }
    await sleep(waitMs);
  }
}

async function verifyTransactionHash(hash: string) {
  if (!hashRe.test(hash)) throw new Error('BSC_VERIFY_TX_HASH must be a transaction hash');
  const [tx, receipt] = await Promise.all([rpc<RpcTx | null>('eth_getTransactionByHash', [hash]), rpc<RpcReceipt | null>('eth_getTransactionReceipt', [hash])]);
  if (!tx || !receipt) throw new Error(`Transaction not available from node: ${hash}`);
  const candidates = transactionWallets(tx, receipt);
  const tracked = await pool.query('SELECT address FROM kols WHERE address=ANY($1::text[]) AND is_tracked', [candidates]);
  const wallets = tracked.rows.map(row => row.address as string);
  if (!wallets.length) throw new Error('No authenticated initiating wallet is in the tracked roster');
  const block = await rpc<RpcBlock>('eth_getBlockByNumber', [tx.blockNumber, false]);
  if (!block || receipt.blockHash.toLowerCase() !== block.hash.toLowerCase()) throw new Error('Receipt block hash mismatch');
  const before = await pool.query('SELECT wallet_address,source,token_amount FROM trades WHERE tx_hash=$1 AND wallet_address=ANY($2::text[])', [hash.toLowerCase(), wallets]);
  for (const wallet of wallets) await persistNodeTrade(tx, receipt, block, wallet);
  await recordWalletTransfers(tx, receipt, block, new Set(wallets));
  const after = await pool.query('SELECT wallet_address,source,token_amount,side FROM trades WHERE tx_hash=$1 AND wallet_address=ANY($2::text[])', [hash.toLowerCase(), wallets]);
  await notifyUpdate();
  console.log(JSON.stringify({ hash, wallets, block: Number(BigInt(tx.blockNumber)), before: before.rows, after: after.rows }));
}

/** Market and accounting work never hold up permanent raw collection. */
async function nodeMarketDiscoveryLoop() {
  for (;;) {
    try {
      // Selected accounting jobs go first. Then rotate the remaining discovered tokens.
      const selected = await pool.query(nodeMarketDiscoverySql());
      for (const row of selected.rows) {
        try {
          // Historical state can be pruned while other token discoveries run.
          // Authenticate each market against a new confirmed checkpoint.
          const discoveryHead = Number(BigInt(await rpc<string>('eth_blockNumber', []))), discoveryBlock = Math.max(0, discoveryHead - 6);
          const header = await rpc<RpcBlock>('eth_getBlockByNumber', [hex(discoveryBlock), false]);
          if (!header || Number(BigInt(header.number)) !== discoveryBlock) throw new Error('market_checkpoint_changed');
          const logs = (await pool.query(nodeMarketReceiptHintsSql(), [row.address, discoveryBlock])).rows.map(row => row.log);
          await nodeMarketService.discover(row.address, { blockNumber: discoveryBlock, blockHash: header.hash,
            timestamp: new Date(Number(BigInt(header.timestamp)) * 1000).toISOString(), logs });
          await pool.query(`INSERT INTO node_market_discoveries(token_address) VALUES($1) ON CONFLICT(token_address) DO UPDATE SET last_attempt_at=now(),last_error=NULL`, [row.address]);
        } catch {
          await pool.query(`INSERT INTO node_market_discoveries(token_address,last_error) VALUES($1,'discovery_retry') ON CONFLICT(token_address) DO UPDATE SET last_attempt_at=now(),last_error='discovery_retry'`, [row.address]);
        }
      }
    } catch (error) { console.warn('Node market discovery waiting:', error instanceof Error ? error.message : 'market_unavailable'); }
    await sleep(3000);
  }
}
async function nodeTokenIdentityLoop() {
  let recentTokens: string[] = [], recentCheckedAt = 0;
  for (;;) {
    try {
      const checkpoint = (await pool.query("SELECT value FROM worker_state WHERE key='node_collection'")).rows[0]?.value;
      if (nodeCaptureHasPriority(checkpoint)) { await sleep(2000); continue; }
      const selected = await pool.query(`SELECT token_address FROM (
        SELECT token_address,priority,requested_at FROM node_market_refresh_jobs WHERE expires_at>now()
        UNION ALL SELECT token_address,priority,requested_at FROM node_accounting_jobs WHERE priority>0
      ) waiting GROUP BY token_address ORDER BY max(priority) DESC,min(requested_at) LIMIT 32`);
      if (Date.now() - recentCheckedAt > 30_000) {
        const recent = await pool.query(`SELECT t.token_address FROM trades t JOIN published_kols k ON k.address=t.wallet_address AND k.is_tracked
          WHERE t.timestamp>now()-interval '24 hours' AND t.block_number IS NOT NULL ORDER BY t.timestamp DESC LIMIT 512`);
        recentTokens = [...new Set<string>(recent.rows.map(row => row.token_address))].slice(0, 256);
        recentCheckedAt = Date.now();
      }
      const queued = await tokenIdentity.queueMissing({ limit: 32, priorityTokens: selected.rows.map(row => row.token_address), recentTokens });
      const result = await tokenIdentity.drain({ limit: 4 });
      await setState('node_token_identity_metrics', { queued, ...result, at: new Date().toISOString() });
      if (result.complete) await notifyUpdate();
    } catch { console.warn('Node token identity work waiting; financial capture continues'); }
    await sleep(1000);
  }
}

async function nodeMarketLoop() {
  for (;;) {
    try {
      const state = (await pool.query(`SELECT (value->>'blockNumber')::bigint::text AS height FROM worker_state WHERE key='node_collection'`)).rows[0];
      if (!state) { await sleep(1000); continue; }
      // Slow discovery and historical collection have independent checkpoints.
      // Current marks must not wait for either batch to finish.
      const head = Number(BigInt(await rpc<string>('eth_blockNumber', []))), confirmed = Math.max(0, head - 6);
      const collectionBehind = confirmed - Number(state.height) > 128;
      const priorities = await pool.query(`SELECT token_address FROM (
        SELECT token_address,0 AS tier,min(requested_at) AS observed_at FROM node_market_refresh_jobs WHERE expires_at>now() GROUP BY token_address
        UNION ALL SELECT token_address,1 AS tier,min(requested_at) AS observed_at FROM node_accounting_jobs WHERE priority>0 GROUP BY token_address
        UNION ALL SELECT s.token_address,2 AS tier,min(COALESCE(v.observed_at,'epoch'::timestamptz)) AS observed_at
          FROM node_accounting_snapshots s JOIN node_monitored_wallets w ON w.wallet_address=s.wallet_address AND w.active
          LEFT JOIN node_token_market_values v ON v.address=s.token_address
          WHERE s.invalidated_at IS NULL AND s.payload->'realizedAccounting'->'position'->>'status'='open'
          GROUP BY s.token_address
      ) selected ORDER BY tier,observed_at,token_address LIMIT 100`);
      await setState('node_market_metrics', await nodeMarketService.tick({ confirmedBlock: confirmed, maxMarkets: 12, retainedBlocks: 600_000,
        priorityTokens: [...new Set<string>(priorities.rows.map(row => row.token_address))], deferHistoricalBackfill: collectionBehind, refreshStateHead: true, skipDecoding: true }));
    } catch (error) { console.warn('Node market work waiting:', error instanceof Error ? error.message : 'market_unavailable'); }
    await sleep(3000);
  }
}

async function nodeMarketDecodeLoop() {
  for (;;) {
    try {
      const checkpoint = (await pool.query("SELECT value FROM worker_state WHERE key='node_collection'")).rows[0]?.value;
      if (!checkpoint || nodeCaptureHasPriority(checkpoint)) { await sleep(2000); continue; }
      // Decoding saved evidence must not wait for pool-state network reads or
      // historical backfill. The service coalesces this bounded stage across workers.
      const observedHead = Math.max(Number(checkpoint.headBlock) || 0, Number(checkpoint.blockNumber));
      const result = await nodeMarketService.decodePending(300, { minimumBlock: Math.max(0, observedHead - 128),
        allowCapturedOlder: true, databaseOnly: true, maxDurationMs: 1500 });
      await setState('node_market_decode_metrics', { ...result, at: new Date().toISOString() });
      if (result.decoded) await notifyUpdate();
      await sleep(result.examined ? 250 : 1000);
    } catch (error) {
      console.warn('Node market decoding waiting:', error instanceof Error ? error.message : 'market_decode_unavailable');
      await sleep(2000);
    }
  }
}
async function nodeMarketCollectionLoop() {
  for (;;) {
    try {
      const rows = await pool.query(`SELECT key,(value->>'blockNumber')::bigint::text AS height FROM worker_state WHERE key IN ('node_collection','node_market_collection')`);
      const current = rows.rows.find(row => row.key === 'node_collection'), saved = rows.rows.find(row => row.key === 'node_market_collection');
      if (current) {
        const confirmed = Number(current.height), from = saved ? Number(saved.height) + 1 : Math.max(0, confirmed - 127);
        if (from <= confirmed) {
          const to = Math.min(from + 499, confirmed);
          await nodeMarketService.collectRange(from, to, { liveCheckpoint: true });
        }
      }
    } catch { console.warn('Live market collection waiting; checkpoint retained'); }
    await sleep(1000);
  }
}
async function nodeAccountingLoop() {
  let claimed = 0, updated = 0, completed = 0, active = 0, durationMs = 0;
  const wallets = new Set<string>();
  const dirtyWallets = new Set<string>();
  let leaderboardRunning = false, lastLeaderboardRefresh = -Infinity;
  // Reporting and rollup publication do not occupy an accounting slot. Keep a
  // burst coalesced while allowing the next trade to be prepared immediately.
  const report = async () => {
    for (;;) {
      await sleep(1000);
      const progress = { claimed, active, updated, completed, wallets: [...wallets], durationMs, at: new Date().toISOString() };
      claimed = updated = completed = durationMs = 0; wallets.clear();
      try {
        await setState('node_accounting_metrics', progress);
        if (progress.updated) await notifyUpdate();
      } catch { console.warn('Node accounting progress waiting'); }
      if (dirtyWallets.size && !leaderboardRunning && Date.now() - lastLeaderboardRefresh >= 5000) {
        const selected = [...dirtyWallets].slice(0, 24);
        // Remove only this captured batch before dispatch. A subsequent update
        // for the same wallet creates a new entry that this result cannot erase.
        selected.forEach(wallet => dirtyWallets.delete(wallet));
        const retain = () => selected.forEach(wallet => dirtyWallets.add(wallet));
        leaderboardRunning = true; lastLeaderboardRefresh = Date.now();
        void nodeLeaderboard.refresh({ wallets: selected }).then(async result => {
          if (result.skipped) retain();
          else if (result.updatedWallets) await notifyUpdate();
        }).catch(retain).finally(() => { leaderboardRunning = false; });
      }
    }
  };
  await Promise.all([runNodeAccountingWorkers({
    tick: async limit => {
      const began = performance.now(), result = await nodeAccountingService.tick(limit);
      durationMs += performance.now() - began;
      return result;
    },
    onProgress: result => {
      claimed += result.claimed; updated += result.updated; completed += result.completed; active = result.active;
      result.wallets.forEach(wallet => wallets.add(wallet));
      result.wallets.forEach(wallet => dirtyWallets.add(wallet));
    },
    onError: () => { console.warn('Node accounting work waiting'); },
  }), report()]);
}
async function nodeDataHealthLoop() {
  for (;;) {
    try {
      const [counts, coverage, currentHead] = await Promise.all([
        pool.query(`SELECT COALESCE(sum(n_live_tup),0)::text AS approximate_rows,
          COALESCE(sum(pg_total_relation_size(relid)),0)::text AS stored_bytes FROM pg_stat_user_tables WHERE relname LIKE 'node_%'`),
        pool.query(`WITH trace_status AS(
          SELECT count(*) FILTER(WHERE j.state='pending')::int AS trace_pending,
            count(*) FILTER(WHERE j.state='pending' AND e.observed_live)::int AS live_trace_pending,
            count(*) FILTER(WHERE j.state='unavailable' AND e.observed_live)::int AS live_trace_unavailable,
            min(e.block_number) FILTER(WHERE j.state='pending' AND e.observed_live)::text AS live_trace_oldest_block
          FROM node_trace_jobs j JOIN node_evidence_transactions e ON e.tx_hash=j.tx_hash AND e.block_hash=j.block_hash
          JOIN node_evidence_blocks b ON b.block_number=e.block_number AND b.block_hash=e.block_hash)
          SELECT (SELECT count(*)::int FROM node_evidence_transactions WHERE decoded_version IS NULL) AS decode_pending,
          (SELECT count(*)::int FROM node_evidence_transactions WHERE projection_at IS NULL) AS projection_pending,
          (SELECT count(*)::int FROM node_accounting_jobs) AS accounting_pending,
          (SELECT count(*)::int FROM node_import_jobs WHERE stage<>'done') AS imports_pending,
          (SELECT count(*)::int FROM node_evidence_metadata_jobs WHERE completed_at IS NULL) AS metadata_pending,
          (SELECT count(*)::int FROM node_evidence_metadata_jobs WHERE completed_at IS NULL AND observed_live
            AND (NOT tokens<@completed_tokens OR NOT pinned_feed_complete)) AS live_metadata_pending,
          (SELECT max(EXTRACT(epoch FROM now()-timestamp))::float8 FROM node_evidence_metadata_jobs WHERE completed_at IS NULL AND observed_live
            AND (NOT tokens<@completed_tokens OR NOT pinned_feed_complete)) AS live_metadata_oldest_age_seconds,
          (SELECT min(block_number)::text FROM node_evidence_metadata_jobs WHERE completed_at IS NULL AND observed_live
            AND (NOT tokens<@completed_tokens OR NOT pinned_feed_complete)) AS live_metadata_oldest_block,
          (SELECT count(*)::int FROM node_evidence_metadata_jobs WHERE completed_at IS NULL AND NOT feed_complete) AS metadata_conversion_pending,
          (SELECT (value->>'blockNumber')::bigint FROM worker_state WHERE key='node_collection') AS collected_block,
          (SELECT (value->>'blockNumber')::bigint FROM worker_state WHERE key='node') AS decoded_block,
          (SELECT (value->>'blockNumber')::bigint FROM worker_state WHERE key='node_market_collection') AS market_collected_block,
          (SELECT value FROM worker_state WHERE key='node_tracing_local') AS local_trace_helper,
          (SELECT min(repair_from_block) FROM node_monitored_wallets WHERE active) AS oldest_repair_block,
          (SELECT count(*)::int FROM node_monitored_wallets WHERE active AND last_error IS NOT NULL) AS collection_errors,
          trace_status.* FROM trace_status`),
        rpc<string>('eth_blockNumber', []),
      ]);
      const row = coverage.rows[0], head = Number(BigInt(currentHead)), observedAt = new Date().toISOString();
      const height = (value: unknown) => value == null ? null : Number(value);
      const helper = row?.local_trace_helper;
      const readiness = nodeOperationalReadiness({ headBlock: head, collectedBlock: height(row?.collected_block),
        decodedBlock: height(row?.decoded_block), marketCollectedBlock: height(row?.market_collected_block),
        repairFromBlock: height(row?.oldest_repair_block), oldestPendingMetadataBlock: height(row?.live_metadata_oldest_block),
        pendingMetadataJobs: row?.live_metadata_pending, oldestPendingTraceBlock: height(row?.live_trace_oldest_block),
        pendingTraceJobs: row?.live_trace_pending, unavailableTraceJobs: row?.live_trace_unavailable,
        traceIpcConfigured: Boolean(process.env.BSC_TRACE_IPC), privateTraceVerifiedAt,
        temporaryTraceHelper: helper && typeof helper.at === 'string' ? { checkedAt: helper.at,
          ...(typeof helper.expiresAt === 'string' ? { expiresAt: helper.expiresAt } : {}) } : null, observedAt });
      await setState('node_data_health', { ...counts.rows[0], ...row, headBlock: head,
        collectionLag: readiness.collection.lagBlocks, pruningMarginBlocks: readiness.collection.pruningMarginBlocks,
        readiness, at: observedAt });
    } catch { console.warn('Node data health metrics unavailable'); }
    await sleep(60_000);
  }
}
async function historicalImportLoop() {
  let discoveredAt = 0;
  for (;;) {
    try {
      // Explicitly disable all import provider traffic during offline validation.
      if (process.env.NODE_HISTORICAL_IMPORTS !== '0') {
        if (Date.now() - discoveredAt > 300_000) { await nodeHistoricalImporter.queuePublicKols(); discoveredAt = Date.now(); }
        await setState('node_import_metrics', { ...await nodeHistoricalImporter.tick(), at: new Date().toISOString() });
      }
    } catch { console.warn('Historical migration work waiting'); }
    await sleep(3000);
  }
}

async function tokenChartRecoveryLoop() {
  for (;;) {
    try {
      if(process.env.NODE_HISTORICAL_IMPORTS!=='0')await setState('node_chart_import_metrics',
        {...await tokenChartRecovery.tick(),at:new Date().toISOString()});
    } catch { console.warn('Historical token chart work waiting'); }
    await sleep(1500);
  }
}

await ensureSchema();
await ensureSeeds();
if (process.env.NODE_CAPTURE_BOOTSTRAP === '1') {
  console.log(JSON.stringify({ event: 'node_capture_bootstrap', ...await bootstrapNodeCapture({ database: pool, rpc, enabled: true }) }));
  await pool.end();
} else if (process.env.BSCAN_REPAIR_LOGOS_SINCE) {
  await repairTokenLogos(process.env.BSCAN_REPAIR_LOGOS_SINCE);
  await pool.end();
} else if (process.env.BSCAN_REPAIR_VALUES_SINCE) {
  await repairWindowValues(process.env.BSCAN_REPAIR_VALUES_SINCE);
  await pool.end();
} else if (process.env.BSC_VERIFY_TX_HASH) {
  await verifyTransactionHash(process.env.BSC_VERIFY_TX_HASH);
  await pool.end();
} else {
  await pool.query(`INSERT INTO worker_state(key,value) VALUES('intelligence_started',jsonb_build_object('at',now())) ON CONFLICT(key) DO NOTHING`);
  const started = await pool.query(`SELECT value->>'at' AS at FROM worker_state WHERE key='intelligence_started'`);
  featuresLiveSince = new Date(started.rows[0].at).getTime();
  await Promise.all([nodeLoop(), nodeDecodeLoop(), ...Array.from({ length: nodeMetadataConcurrency }, (_, index) => nodeMetadataLoop(index)), nodeTokenIdentityLoop(), nodeProjectionLoop(), nodeTraceLoop(), nodeMarketCollectionLoop(), nodeMarketDiscoveryLoop(), nodeMarketLoop(), nodeMarketDecodeLoop(), nodeAccountingLoop(), nodeDataHealthLoop(), historicalImportLoop(), tokenChartRecoveryLoop(), intelligenceLoop(), telegramNotifications.run(), tradeRepairLoop(), priceLoop(), leaderboardLoop(), avatarLoop(), ...Array.from({ length: 3 }, () => logoLoop()), sellValueLoop(), supplyLoop()]);
}
