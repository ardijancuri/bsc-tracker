import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { KolTokenActivity, KolTokenBalanceProof } from '../shared/kolTokenTrades.js';
import type { NodeAccountingBaselineInput, NodeAccountingScope, NodeAccountingSnapshotIdentity, NodeAccountingSource, NodeAccountingSummary } from '../shared/nodeAccounting.js';
import type { NodeMarketQuote } from '../shared/nodeMarket.js';
import { pool } from './db.js';
import { currentKolTokenBalance } from './kolTokenBalance.js';
import { isExcludedKolProfileTokenAddress, kolProfileTokenSql } from './kolProfileToken.js';
import { calculateJournalLedger, journalDecimalDivide, journalDecimalMultiply, sumJournalDecimals, type JournalLedgerBaseline, type JournalLedgerCoverage, type JournalLedgerEvent, type JournalLedgerOpeningBalance, type JournalLedgerResult } from './nodeAccountingLedger.js';
import { applyJournalReplay } from './journalReplay.js';
import { hasRecognizedSwap, transferTopic, type TransferLog } from './swap.js';
import { nodeMarketService } from './nodeMarket.js';
import { chainRpc } from './rpc.js';
import { nodeNativeTradeValue, queueNodeTraceRepairs, type NodeCallTrace } from './nodeTrace.js';
import { parseLaunchLog } from './launchpad.js';
import { invalidateNodeLeaderboardForWallets } from './nodeAccountingSchema.js';
import type { NodeAccountingTickResult } from './nodeAccountingQueue.js';
import { decodeNodeMarketLog, poolMarketAbi, v3MarketAbi, infinityMarketAbi, infinityBinMarketAbi, fourMarketAbi, flapMarketAbi, type NodeMarketIdentity } from './nodeMarketProtocols.js';

type Database = Pick<PoolClient, 'query'>;
type Market = { quote(token: string, options?: { maxAgeMs?: number }): Promise<NodeMarketQuote>;
  priceAt(token: string, options: { timestamp: string; blockNumber?: string; maxAgeMs?: number }): Promise<NodeMarketQuote>;
  requestRefresh?(token: string, options?: { priority?: number }): Promise<unknown> };
export interface NodeAccountingRequest { wallet: string; token: string; scope?: NodeAccountingScope; foreground?: boolean }
export interface NodeExecutionFlow {
  id: string; tx_hash: string; wallet_address: string; execution_index: number; operation_hash: string | null;
  block_number: string; block_hash: string; transaction_index: number; timestamp: string | Date;
  status: string; kind: string; fee_native_wei: string | null; fee_complete: boolean; fee_reason: string | null;
  native_value_raw: string | null; logs: TransferLog[]; token_address: string; delta_raw: string;
  decimals: number | null; log_indices: number[]; counterparties: string[]; eligible?: boolean;
  trace?: NodeCallTrace | null;
  transaction_to?: string | null;
  authenticated_markets?: NodeMarketIdentity[] | null;
}
export interface NodeAccountingEvidence {
  events: JournalLedgerEvent[]; historicalEvents: JournalLedgerEvent[]; baselines: JournalLedgerBaseline[];
  openingBalances: JournalLedgerOpeningBalance[]; proof: KolTokenBalanceProof | null;
  coverage: JournalLedgerCoverage; quote: NodeMarketQuote | null; source: NodeAccountingSource;
  historyFingerprint: string; fromBlock: string | null; throughBlock: string | null;
  inputFingerprint?: string;
  /** Internal valuation/cache revision; independent of the public FIFO policy. */
  normalizationRevision?: number;
  monitoringGeneration?: string;
  historicalRecoveryNeeded?: boolean;
  historyBoundary?: NodeAccountingSnapshotIdentity['historyBoundary'];
  /** Canonical registration-block time, not a guessed first-purchase date. */
  historyFrom?: string;
  retryAfterMs?: number;
  reasons?: string[];
  reason?: string;
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const iso = (value: string | Date) => new Date(value).toISOString();
const address = (value: string) => /^0x[0-9a-f]{40}$/.test(value);
const decimal = (value: unknown) => typeof value === 'string' && /^-?\d+(?:\.\d+)?$/.test(value);
const units = (value: string | bigint, decimals: number) => journalDecimalDivide(String(value), (10n ** BigInt(decimals)).toString())!;
export const nodeAccountingScopeKey = (scope: NodeAccountingScope = { kind: 'public' }) => scope.kind === 'public' ? 'public'
  : hash([scope.kind, scope.accountId, scope.membershipRevision, scope.fromAt, scope.fromBlock]);
const requestKey = (request: NodeAccountingRequest) => `${nodeAccountingScopeKey(request.scope)}:${request.wallet}:${request.token}`;
// Trusted-feed precedence and deterministic market selection changed which
// persisted dated proof values a movement. Re-evaluate pre-revision histories
// once; unchanged histories then keep their completed exact normalization.
const normalizationRevision = 2;
const asBaseline = (wallet: string, token: string, row: any): JournalLedgerBaseline => ({ walletAddress: wallet, tokenAddress: token, ...row.ledger });
const temporaryReasons = new Set(['collection_pending', 'indexing_lag', 'node_indexer_lag', 'balance_unavailable', 'quote_unavailable', 'execution_valuation_unavailable',
  'fee_valuation_unavailable', 'snapshot_preparation_failed', 'indexed_snapshot_changed']);
function datedValidActivity(row: any, now = Date.now()): KolTokenActivity | null {
  const current = row.payload as KolTokenActivity | undefined, saved = row.last_valid as KolTokenActivity | undefined;
  const reasons = current?.accountingSnapshot?.reasons ?? [];
  if (!row.invalidated_at && row.complete && current?.accountingSnapshot && now - Date.parse(current.accountingSnapshot.asOf) > 180_000) {
    return { ...current, accountingSnapshot: { ...current.accountingSnapshot, refreshStatus: 'pending', refreshReason: 'snapshot_refresh' } };
  }
  if (row.invalidated_at || row.complete || !saved?.accountingSnapshot || !reasons.length) return null;
  if (saved.accountingSnapshot.historyBoundary === 'verified_zero_position'
    && (current?.accountingSnapshot?.historyBoundary !== 'verified_zero_position'
      || current.accountingSnapshot.historyFingerprint !== saved.accountingSnapshot.historyFingerprint)) return null;
  const known = saved.realizedAccounting, pending = current?.realizedAccounting, previous = known?.position, position = pending?.position;
  // Aggregate fees can leave FIFO allocation unknown while the complete ending
  // cash flows are independently verified. Losing only the quote must retain
  // that dated total, rather than misreading the secondary FIFO flags as new
  // missing purchases. Every financial input and confirmed quantity must agree.
  const unchangedCashFlows = saved.accountingSnapshot.complete && saved.accountingSnapshot.reasons.includes('fifo_allocation_unknown')
    && current?.accountingSnapshot?.historyFingerprint === saved.accountingSnapshot.historyFingerprint
    && current.accountingSnapshot.source === saved.accountingSnapshot.source
    && pending?.coverage.transactionsComplete && pending.coverage.balanceMatched
    && known?.coverage.balanceProof && pending.coverage.balanceProof
    && known?.walletAddress === pending.walletAddress && known?.tokenAddress === pending.tokenAddress
    && previous?.remainingTokenAmount === position?.remainingTokenAmount
    && known?.coverage.balanceProof?.balance === pending.coverage.balanceProof?.balance
    && previous?.feeInclusiveCostUsd === position?.feeInclusiveCostUsd && previous?.cashFlow && position?.cashFlow
    && (['investedUsd','soldUsd','transferOutIncomeUsd','feesUsd'] as const).every(field=>previous.cashFlow![field]===position.cashFlow![field]);
  const quoteOnly = unchangedCashFlows && reasons.includes('quote_unavailable')
    && reasons.every(reason=>['quote_unavailable','purchase_cost_unknown','realized_cost_unknown'].includes(reason));
  if (!quoteOnly && !reasons.every(reason => temporaryReasons.has(reason))) return null;
  // Preserve the original observation timestamp and complete snapshot identity.
  return { ...saved, accountingSnapshot: { ...saved.accountingSnapshot, refreshStatus: 'pending', refreshReason: quoteOnly ? 'quote_unavailable' : reasons[0] } };
}

/** A factory creation event proves the token could not have older trading
 * cycles. A new liquidity pool or a migration does not prove token creation. */
export function authenticNodeTokenCreation(token: string, registration: string, through: string,
  candidates: { blockNumber: string; logs: TransferLog[] }[]) {
  if (!address(token) || !/^\d+$/.test(registration) || !/^\d+$/.test(through)) return false;
  return candidates.some(candidate => /^\d+$/.test(candidate.blockNumber) && BigInt(candidate.blockNumber) >= BigInt(registration)
    && BigInt(candidate.blockNumber) <= BigInt(through) && candidate.logs.some(log => {
      const parsed = parseLaunchLog(log, new Set([token])); return parsed?.token === token && parsed.kind === 'created';
    }));
}

async function publicNodeCreationBoundary(db: Database, token: string, registration: string, through: string) {
  const created = await db.query(`SELECT raw.block_number::text AS block_number,raw.receipt->'logs' AS logs
    FROM node_evidence_transactions raw JOIN node_evidence_blocks b ON b.block_number=raw.block_number AND b.block_hash=raw.block_hash
    WHERE raw.block_number>=$2 AND raw.block_number<=$3 AND
      (EXISTS(SELECT 1 FROM launch_events l WHERE l.tx_hash=raw.tx_hash AND l.block_hash=raw.block_hash AND l.token_address=$1 AND l.kind='created')
      OR EXISTS(SELECT 1 FROM node_executions e JOIN node_execution_flows f ON f.execution_id=e.id WHERE e.tx_hash=raw.tx_hash AND f.token_address=$1))
    UNION ALL SELECT l.block_number::text,jsonb_build_array(l.log) FROM node_market_raw_logs l
      JOIN node_markets m ON m.id=l.market_id JOIN node_evidence_blocks b ON b.block_number=l.block_number AND b.block_hash=l.block_hash
      WHERE m.token_address=$1 AND l.block_number>=$2 AND l.block_number<=$3`, [token, registration, through]);
  const candidates = created.rows.map(row => ({ blockNumber: row.block_number, logs: Array.isArray(row.logs) ? row.logs : [] }));
  return authenticNodeTokenCreation(token, registration, through, candidates) ? { boundary: 'token_creation' as const, fingerprint: hash(candidates) } : null;
}
async function publicLifetimeBoundary(db: Database, wallet: string, token: string, registration: string, registeredAt: string | Date, through: string) {
  const creation = await publicNodeCreationBoundary(db, token, registration, through);
  if (creation) return creation;
  const discovery = (await db.query(`SELECT * FROM node_import_wallet_jobs WHERE wallet_address=$1 AND stage='done'
    AND completed_at>=$2::timestamptz AND requested_at>=$2::timestamptz AND last_error IS NULL`, [wallet, iso(registeredAt)])).rows[0];
  if (!discovery || !/^[a-f0-9]{64}$/.test(discovery.head_fingerprint ?? '') || !discovery.head_verified_at
    || Date.parse(iso(discovery.head_verified_at)) < Date.parse(iso(registeredAt)) || !/^[a-f0-9]{64}$/.test(discovery.head_verified_fingerprint ?? '')) return null;
  const headCheck = (await db.query(`SELECT c.payload FROM node_import_wallet_head_checks c JOIN node_import_wallet_jobs j ON j.wallet_address=c.wallet_address
    WHERE c.wallet_address=$1 AND c.payload_hash=$2 AND date_trunc('milliseconds',c.cutoff_at)=date_trunc('milliseconds',j.requested_at)
      AND c.checked_at>=$3::timestamptz`, [wallet, discovery.head_verified_fingerprint, iso(registeredAt)])).rows[0]?.payload;
  if (headCheck?.version !== 1 || headCheck.originalHeadFingerprint !== discovery.head_fingerprint || !Array.isArray(headCheck.movements)) return null;
  // Every visited page must belong to one completed chain. Older discovery
  // payloads lacking movements cannot be treated as proof of absence.
  const versions = (await db.query(`SELECT cursor_key,payload_hash,payload,next_cursor,observed_at
    FROM node_import_wallet_pages WHERE wallet_address=$1 ORDER BY observed_at DESC`, [wallet])).rows;
  const pages: any[] = [], seen = new Set<string>();
  for (const page of versions) {
    if (page.cursor_key === 'head' && page.payload_hash !== discovery.head_fingerprint || seen.has(page.cursor_key)) continue;
    pages.push(page); seen.add(page.cursor_key);
  }
  const expected: string[] = discovery.pagination_cursors ?? [], byCursor = new Map(pages.map(row => [row.cursor_key, row]));
  if (!expected.length || expected[0] !== 'head') return null;
  for (let index = 0; index < expected.length; index++) {
    const page = byCursor.get(expected[index]), next = expected[index + 1] ?? null;
    if (!page || page.payload?.version !== 1 || !Array.isArray(page.payload.movements) || page.next_cursor !== next
      || Date.parse(iso(page.observed_at)) < Date.parse(iso(registeredAt))) return null;
    if (page.payload.movements.some((movement: { tokenAddress?: string; timestamp?: string }) => movement.tokenAddress === token
      && (!movement.timestamp || !Number.isFinite(Date.parse(movement.timestamp)) || Date.parse(movement.timestamp) < Date.parse(iso(registeredAt))))) return null;
  }
  for (const payload of [...versions.map(page => page.payload), headCheck]) {
    if (payload.version !== 1 || !Array.isArray(payload.movements)) return null;
    if (payload.movements.some((movement: { tokenAddress?: string; timestamp?: string }) => movement.tokenAddress === token
      && (!movement.timestamp || !Number.isFinite(Date.parse(movement.timestamp)) || Date.parse(movement.timestamp) < Date.parse(iso(registeredAt))))) return null;
  }
  return { boundary: 'wallet_discovery' as const, fingerprint: hash([expected.map(cursor => byCursor.get(cursor).payload_hash), discovery.head_verified_fingerprint]) };
}

export function nodeAccountingRangesComplete(fromBlock: string, toBlock: string, ranges: { fromBlock: string; toBlock: string }[]) {
  if (!/^\d+$/.test(fromBlock) || !/^\d+$/.test(toBlock) || BigInt(toBlock) < BigInt(fromBlock)) return false;
  let next = BigInt(fromBlock) + 1n, through = BigInt(toBlock);
  for (const range of ranges.filter(row => /^\d+$/.test(row.fromBlock) && /^\d+$/.test(row.toBlock)).sort((a, b) => BigInt(a.fromBlock) < BigInt(b.fromBlock) ? -1 : 1)) {
    const from = BigInt(range.fromBlock), to = BigInt(range.toBlock);
    if (to < next) continue;
    if (from > next) return false;
    if (to >= through) return true;
    next = to + 1n;
  }
  return next > through;
}

/** A zero opening proves the captured cycle, not older closed cycles. Only
 * replace an imported prefix when every imported movement belongs to that
 * cycle and its authentic node transaction quantities cover the same prefix.
 * Group operations within a transaction because providers may merge them. */
export function nodeHistoryCoversImportedMovements(input: { wallet: string; token: string; registeredAt: string | Date;
  checkpoint: string; imported: JournalLedgerEvent[]; node: JournalLedgerEvent[] }) {
  const registered = new Date(input.registeredAt).getTime();
  if (!Number.isFinite(registered) || !/^\d+$/.test(input.checkpoint) || !input.imported.length) return false;
  const grouped = (events: JournalLedgerEvent[], imported: boolean) => {
    const groups = new Map<string, string[]>();
    for (const event of events) {
      if (event.walletAddress !== input.wallet || event.tokenAddress !== input.token || !/^0x[0-9a-f]{64}$/i.test(event.txHash)
        || !decimal(event.tokenAmount) || event.tokenAmount.startsWith('-') || !Number.isFinite(Date.parse(event.timestamp))
        || imported && Date.parse(event.timestamp) < registered) return null;
      const key = `${event.txHash.toLowerCase()}:${event.kind}`;
      const amounts = groups.get(key) ?? []; amounts.push(event.tokenAmount); groups.set(key, amounts);
    }
    return new Map([...groups].map(([key, amounts]) => [key, sumJournalDecimals(amounts)]));
  };
  const imported = grouped(input.imported, true), node = grouped(input.node.filter(event => event.blockNumber != null
    && /^\d+$/.test(event.blockNumber) && BigInt(event.blockNumber) <= BigInt(input.checkpoint)), false);
  return !!imported && !!node && imported.size === node.size
    && [...imported].every(([key, quantity]) => node.get(key) === quantity);
}

/** A confirmed mark may be recent yet precede a newly captured movement. It
 * cannot value holdings from after that movement or end its replay earlier. */
export function nodeQuoteCoversMovements(quote: NodeMarketQuote | null, events: JournalLedgerEvent[]) {
  const markedAt = Date.parse(quote?.timestamp ?? '');
  if (!Number.isFinite(markedAt)) return false;
  return events.every(event => Date.parse(event.timestamp) <= markedAt
    && !(event.blockNumber && /^\d+$/.test(event.blockNumber) && quote?.blockNumber && /^\d+$/.test(quote.blockNumber)
      && BigInt(event.blockNumber) > BigInt(quote.blockNumber)));
}

/** The importer must reconcile indexed overlaps first. This writer validates the
 * signed quantity and checkpoint identity again before committing a baseline. */
export async function saveNodeAccountingBaseline(db: Database, input: NodeAccountingBaselineInput & { events?: JournalLedgerEvent[] }) {
  const { wallet, token, checkpoint, ledger } = input;
  if (!address(wallet) || !address(token) || !input.overlapVerified || !input.quantityVerified || checkpoint.walletAddress !== wallet
    || checkpoint.tokenAddress !== token || checkpoint.chain !== 'bsc' || !/^\d+$/.test(checkpoint.blockNumber)
    || !/^0x[0-9a-f]{64}$/.test(checkpoint.blockHash) || !/^[a-f0-9]{64}$/.test(input.historyFingerprint)
    || !decimal(checkpoint.balance) || checkpoint.balance.startsWith('-') || !Number.isFinite(Date.parse(checkpoint.blockTimestamp))) throw new Error('baseline_evidence_invalid');
  if (!Array.isArray(ledger.lots) || ledger.lots.some(lot => !decimal(lot.tokenAmount) || lot.tokenAmount.startsWith('-')
    || lot.costBasisUsd !== null && (!decimal(lot.costBasisUsd) || lot.costBasisUsd.startsWith('-')))
    || sumJournalDecimals([sumJournalDecimals(ledger.lots.map(lot => lot.tokenAmount)), `-${checkpoint.balance}`]) !== '0') throw new Error('baseline_quantity_unreconciled');
  for (const [name, value] of Object.entries(ledger)) if (name !== 'lots' && value !== null
    && (!decimal(value) || name !== 'realizedProfitUsd' && (value as string).startsWith('-'))) throw new Error('baseline_cost_invalid');
  const managed = !('release' in db && typeof db.release === 'function') && 'connect' in db && typeof db.connect === 'function';
  const client = managed ? await (db as Pool).connect() : null, writer = client ?? db;
  try {
  if (client) await writer.query('BEGIN');
  await writer.query('SELECT pg_advisory_xact_lock_shared(782319)');
  await writer.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`node-accounting:${wallet}:${token}`]);
  const monitoring = (await writer.query('SELECT registration_block::text FROM node_monitored_wallets WHERE wallet_address=$1 AND active', [wallet])).rows[0];
  if (!monitoring?.registration_block) throw new Error('baseline_monitoring_pending');
  if (BigInt(checkpoint.blockNumber) < BigInt(monitoring.registration_block)) throw new Error('baseline_checkpoint_before_monitoring');
  const canonical = (await writer.query('SELECT block_hash FROM node_evidence_blocks WHERE block_number=$1', [checkpoint.blockNumber])).rows[0];
  if (!canonical || canonical.block_hash !== checkpoint.blockHash) throw new Error('baseline_checkpoint_unverified');
  await writer.query(`INSERT INTO node_accounting_baselines(wallet_address,token_address,checkpoint_block,checkpoint_hash,checkpoint_timestamp,balance,history_fingerprint,ledger,events)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb) ON CONFLICT(wallet_address,token_address) DO UPDATE SET
    checkpoint_block=EXCLUDED.checkpoint_block,checkpoint_hash=EXCLUDED.checkpoint_hash,checkpoint_timestamp=EXCLUDED.checkpoint_timestamp,
    balance=EXCLUDED.balance,history_fingerprint=EXCLUDED.history_fingerprint,ledger=EXCLUDED.ledger,events=EXCLUDED.events,verified_at=now(),invalidated_at=NULL,schema_version=2`,
  [wallet, token, checkpoint.blockNumber, checkpoint.blockHash, checkpoint.blockTimestamp, checkpoint.balance, input.historyFingerprint, JSON.stringify(ledger), JSON.stringify(input.events ?? [])]);
  await writer.query("UPDATE node_accounting_snapshots SET invalidated_at=clock_timestamp(),last_valid=NULL WHERE scope_key='public' AND wallet_address=$1 AND token_address=$2", [wallet, token]);
  await writer.query("UPDATE node_accounting_history SET invalidated_at=clock_timestamp() WHERE scope_key='public' AND wallet_address=$1 AND token_address=$2", [wallet, token]);
  await writer.query("UPDATE node_accounting_snapshot_versions SET invalidated_at=clock_timestamp() WHERE scope_key='public' AND wallet_address=$1 AND token_address=$2", [wallet, token]);
  await invalidateNodeLeaderboardForWallets(writer,[wallet]);
  if (client) await writer.query('COMMIT');
  } catch (error) { if (client) await writer.query('ROLLBACK'); throw error; }
  finally { client?.release(); }
}

function authenticatedTokenPair(group: NodeExecutionFlow[], logs: TransferLog[]) {
  const flows = group.filter(row => BigInt(row.delta_raw) !== 0n);
  if (flows.length !== 2 || flows.some(row => row.eligible === false || row.decimals == null)
    || (BigInt(flows[0].delta_raw) > 0n) === (BigInt(flows[1].delta_raw) > 0n)
    || flows[0].kind !== 'transaction' || flows[0].native_value_raw !== '0') return null;
  const matches = new Map<number, { quote: NodeExecutionFlow; acquiredToken: string; marketId: string }>();
  for (const market of [...(flows[0].authenticated_markets ?? [])].sort((a, b) => a.id.localeCompare(b.id))) {
    const base = flows.find(row => row.token_address === market.token), quote = flows.find(row => row.token_address === market.quote);
    if (!base || !quote || ![market.token0, market.token1].includes(base.token_address) || ![market.token0, market.token1].includes(quote.token_address)
      || base.decimals !== (base.token_address === market.token0 ? market.decimals0 : market.decimals1)
      || quote.decimals !== (quote.token_address === market.token0 ? market.decimals0 : market.decimals1)) continue;
    for (const [index, log] of logs.entries()) {
      const decoded = decodeNodeMarketLog(market, log);
      if (!decoded?.swap || decoded.tokenAmountRaw !== (BigInt(base.delta_raw) < 0n ? -BigInt(base.delta_raw) : BigInt(base.delta_raw)).toString()
        || decoded.quoteAmountRaw !== (BigInt(quote.delta_raw) < 0n ? -BigInt(quote.delta_raw) : BigInt(quote.delta_raw)).toString()) continue;
      try {
        const abi = market.protocol === 'pcs_v2' ? poolMarketAbi : market.protocol === 'pcs_v3' ? v3MarketAbi
          : market.protocol === 'infinity_cl' ? infinityMarketAbi : market.protocol === 'infinity_bin' ? infinityBinMarketAbi
          : market.protocol === 'fourmeme' ? fourMarketAbi : flapMarketAbi;
        const parsed = abi.parseLog(log); if (!parsed) continue;
        const tokenIs0 = market.token0 === market.token;
        const baseDelta = market.protocol === 'pcs_v2'
          ? BigInt(tokenIs0 ? parsed.args.amount0Out : parsed.args.amount1Out) - BigInt(tokenIs0 ? parsed.args.amount0In : parsed.args.amount1In)
          : ['pcs_v3', 'infinity_cl', 'infinity_bin'].includes(market.protocol) ? -BigInt(tokenIs0 ? parsed.args.amount0 : parsed.args.amount1)
          : ['TokenPurchase', 'TokenBought'].includes(parsed.name) ? BigInt(decoded.tokenAmountRaw) : -BigInt(decoded.tokenAmountRaw);
        if (baseDelta !== BigInt(base.delta_raw)) continue;
        if (['fourmeme', 'flap'].includes(market.protocol)
          && String(parsed.args.account ?? parsed.args.buyer ?? parsed.args.seller).toLowerCase() !== base.wallet_address) continue;
        // Multiple registry orientations of the same authenticated pool use one
        // deterministic quote leg, so both token ledgers record identical cash.
        if (!matches.has(index)) matches.set(index, { quote, acquiredToken: flows.find(row => BigInt(row.delta_raw) > 0n)!.token_address, marketId: market.id });
      } catch { /* An unrecognized layout cannot attribute a financial movement. */ }
    }
  }
  // Extra swaps, transfer-tax differences and multi-hop flows need independent
  // operation attribution; do not infer allocations from a token's symbol.
  return matches.size === 1 ? [...matches.values()][0] : null;
}

/** One operation remains one execution. Never collapse all actions in a bundle
 * or charge its entire gas fee to each operation. Values come from persisted
 * market/feed observations, never ticker symbols or guessed decimals. */
export async function normalizeNodeExecutionFlows(rows: NodeExecutionFlow[], token: string, market: Pick<Market, 'priceAt'>) {
  const events: JournalLedgerEvent[] = [], reasons = new Set<string>();
  const grouped = new Map<string, NodeExecutionFlow[]>();
  for (const row of rows) { const group = grouped.get(row.id) ?? []; group.push(row); grouped.set(row.id, group); }
  const priceCache = new Map<string, Promise<string | null>>();
  const priceAt = (asset: string, row: NodeExecutionFlow) => {
    const key = `${asset}:${row.block_number}:${iso(row.timestamp)}`;
    let price = priceCache.get(key);
    if (!price) { price = market.priceAt(asset, { timestamp: iso(row.timestamp), blockNumber: row.block_number, maxAgeMs: 300_000 })
      .then(result => result.stale ? null : result.priceUsd); priceCache.set(key, price); }
    return price;
  };
  for (const group of grouped.values()) {
    const row = group.find(item => item.token_address === token);
    if (!row || BigInt(row.delta_raw) === 0n) continue;
    if (row.status !== 'success') { reasons.add(row.status === 'unsupported' ? 'unsupported_execution_decoder' : 'failed_execution_with_token_flows'); continue; }
    if (row.decimals == null || !Number.isInteger(row.decimals) || row.decimals < 0 || row.decimals > 36) { reasons.add('token_decimals_unknown'); continue; }
    const raw = BigInt(row.delta_raw), positive = raw > 0n, quantity = units(raw < 0n ? -raw : raw, row.decimals);
    const logs = Array.isArray(row.logs) ? row.logs : [], pair = row.kind !== 'transfer' ? authenticatedTokenPair(group, logs) : null;
    const authenticatedSwap = (row.authenticated_markets ?? []).some(market => logs.some(log => decodeNodeMarketLog(market, log)?.swap));
    const swap = row.kind !== 'transfer' && (hasRecognizedSwap(logs) || authenticatedSwap);
    const targets = group.filter(flow => flow.eligible !== false && !isExcludedKolProfileTokenAddress(flow.token_address) && BigInt(flow.delta_raw) !== 0n);
    let amount: string | null = null;
    if (swap) {
      const quotes = group.filter(flow => flow.eligible === false && (BigInt(flow.delta_raw) < 0n) === positive);
      if (pair) {
        const quote = pair.quote, conversion = await priceAt(quote.token_address, row), quoteRaw = BigInt(quote.delta_raw);
        if (conversion) amount = journalDecimalMultiply(units(quoteRaw < 0n ? -quoteRaw : quoteRaw, quote.decimals!), conversion);
      } else if (targets.length === 1 && quotes.length === 1 && quotes[0].decimals != null) {
        const quote = quotes[0], conversion = await priceAt(quote.token_address, row), quoteRaw = BigInt(quote.delta_raw);
        if (conversion) amount = journalDecimalMultiply(units(quoteRaw < 0n ? -quoteRaw : quoteRaw, quote.decimals!), conversion);
      } else if (targets.length === 1) {
        const native=nodeNativeTradeValue({wallet:row.wallet_address,side:positive?'buy':'sell',token,tokenAmountRaw:raw<0n?-raw:raw,logs,
          transactionTo:row.kind==='transaction'?row.transaction_to:null,trace:row.kind==='transaction'?row.trace:null});
        if(native.reason)reasons.add(row.kind==='user_operation'&&native.reason==='native_trace_required'?'unsupported_native_operation':native.reason);
        if (native.amount !== null) { const conversion = await priceAt('0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c', row);
          if (conversion) amount = journalDecimalMultiply(units(native.amount, 18), conversion); }
      }
      if (amount === null) reasons.add(targets.length > 1 && !pair ? 'shared_quote_unallocated' : 'execution_valuation_unavailable');
    } else {
      const observed = await priceAt(token, row); amount = observed ? journalDecimalMultiply(quantity, observed) : null;
      if (amount === null) reasons.add(positive ? 'incoming_transfer_cost_unknown' : 'outgoing_transfer_value_unknown');
    }
    // One authenticated token/token exchange assigns wallet gas to its acquired
    // asset. The disposed asset carries no second copy of that operation fee.
    const feeAllocatedElsewhere = pair && pair.acquiredToken !== token;
    const feeId = pair ? `${row.operation_hash ?? row.id}:asset:${token}` : row.operation_hash ?? row.id;
    let fee: string | null = feeAllocatedElsewhere || row.fee_complete && row.fee_native_wei === '0' ? '0' : null;
    if (!feeAllocatedElsewhere && row.fee_complete && row.fee_native_wei != null && BigInt(row.fee_native_wei) > 0n) {
      const observed = await priceAt('0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c', row);
      if (observed) fee = journalDecimalMultiply(units(row.fee_native_wei, 18), observed);
    }
    if (fee === null) reasons.add(row.fee_reason ?? 'fee_valuation_unavailable');
    // Shared operations need allocation evidence; charging one whole fee to
    // every independently viewed token would inflate consolidated expenses.
    if (!pair && targets.length > 1 && fee !== '0') { fee = null; reasons.add('execution_fee_allocation_unknown'); }
    const logIndex = row.log_indices?.length === 1 ? row.log_indices[0] : null;
    if (!swap && logs.length) {
      const original = logs.filter(log => log.address.toLowerCase() === token && log.topics[0]?.toLowerCase() === transferTopic
        && log.topics.length === 3 && /^0x[0-9a-f]{64}$/i.test(log.data));
      let emitted = false;
      const observed = await priceAt(token, row);
      for (const log of original) {
        const from = `0x${log.topics[1].slice(-40)}`.toLowerCase(), to = `0x${log.topics[2].slice(-40)}`.toLowerCase();
        if (from === to || from !== row.wallet_address && to !== row.wallet_address) continue;
        const rawIndex = (log as TransferLog & { logIndex?: string }).logIndex;
        if (!rawIndex || !/^0x[0-9a-f]+$/i.test(rawIndex)) { reasons.add('transfer_execution_identity_unknown'); continue; }
        const ordinal = Number(BigInt(rawIndex)), incoming = to === row.wallet_address, count = units(BigInt(log.data), row.decimals);
        if (count === '0') continue;
        emitted = true;
        events.push({ id: `${row.id}:${token}:${ordinal}`, walletAddress: row.wallet_address, tokenAddress: token,
          kind: incoming ? 'transfer_in' : 'transfer_out', tokenAmount: count,
          amountUsd: observed ? journalDecimalMultiply(count, observed) : null, feeUsd: fee, feeId,
          txHash: row.tx_hash, timestamp: iso(row.timestamp), blockNumber: row.block_number, transactionIndex: row.transaction_index,
          logIndex: ordinal, counterparty: incoming ? from : to, transferId: `${row.tx_hash}:${token}:${ordinal}` });
      }
      if (emitted) continue;
    }
    events.push({ id: `${row.id}:${token}`, walletAddress: row.wallet_address, tokenAddress: token,
      kind: swap ? positive ? 'buy' : 'sell' : positive ? 'transfer_in' : 'transfer_out', tokenAmount: quantity,
      amountUsd: amount, feeUsd: fee, feeId, txHash: row.tx_hash, timestamp: iso(row.timestamp),
      blockNumber: row.block_number, transactionIndex: row.transaction_index,
      // The execution ordinal is independently known for operations in a bundle.
      logIndex: swap ? row.execution_index : logIndex,
      counterparty: row.counterparties?.length === 1 ? row.counterparties[0] : null,
      ...(!swap && logIndex != null ? { transferId: `${row.tx_hash}:${token}:${logIndex}` } : {}) });
  }
  return { events, reasons: [...reasons].sort() };
}

function emptyActivity(wallet: string, token: string, metadata: any, now: number): KolTokenActivity {
  return { kol: { address: wallet, name: metadata.kol_name ?? `${wallet.slice(0, 6)}…${wallet.slice(-4)}`, avatarUrl: metadata.avatar_url ?? null,
    twitter: metadata.twitter ?? null, source: metadata.source ?? 'node', lastSeenAt: metadata.last_seen_at ? iso(metadata.last_seen_at) : null },
  token: { address: token, symbol: metadata.symbol ?? null, name: metadata.name ?? null, logoUrl: metadata.logo_url ?? null,
    priceUsd: null, marketCapUsd: null, marketCapSupply: null }, trades: [],
  summary: { investedUsd: null, soldUsd: null, realizedProfitUsd: null, avgBoughtPriceUsd: null, avgSoldPriceUsd: null, avgBoughtMcapUsd: null,
    avgSoldMcapUsd: null, remainingTokenAmount: null, remainingCostBasisUsd: null, buyCount: 0, sellCount: 0, valuedBuyCount: 0, valuedSellCount: 0,
    excludedSellCount: 0, unpricedTradeCount: 0, firstTradeAt: null, lastTradeAt: null, status: 'unknown', profitBasis: 'observed_fifo' },
  coverage: { source: 'indexed', indexedTradeCount: 0, returnedTradeCount: 0, complete: false, historyLimit: 100_000, costsIncluded: false }, generatedAt: new Date(now).toISOString() };
}

export function createNodeAccountingService({ db = pool, market = nodeMarketService, balance = currentKolTokenBalance, now = Date.now }: {
  db?: Pool; market?: Market; balance?: typeof currentKolTokenBalance; now?: () => number;
} = {}) {
  const jobs = new Map<string, Promise<KolTokenActivity | undefined>>();
  let draining = 0, lastVersionCleanup = -Infinity, versionCleanup: Promise<unknown> | undefined;
  const normalize = (request: NodeAccountingRequest): NodeAccountingRequest => ({ ...request, wallet: request.wallet.toLowerCase(), token: request.token.toLowerCase(), scope: request.scope ?? { kind: 'public' } });
  async function authorize(request: NodeAccountingRequest) {
    if (!address(request.wallet) || !address(request.token) || isExcludedKolProfileTokenAddress(request.token)) return false;
    const scope = request.scope ?? { kind: 'public' };
    if (scope.kind === 'public') return !!(await db.query('SELECT 1 FROM kols WHERE address=$1 AND is_tracked', [request.wallet])).rowCount;
    return !!(await db.query(`SELECT 1 FROM journal_wallets WHERE user_id=$1 AND wallet_address=$2 AND revision=$3::uuid
      AND date_trunc('milliseconds',added_at)=$4::timestamptz AND registration_block=$5::bigint`, [scope.accountId, request.wallet, scope.membershipRevision, scope.fromAt, scope.fromBlock])).rowCount;
  }
  async function enqueue(request: NodeAccountingRequest) {
    await db.query(`INSERT INTO node_accounting_jobs(scope_key,wallet_address,token_address,scope,priority) VALUES($1,$2,$3,$4::jsonb,$5)
      ON CONFLICT(scope_key,wallet_address,token_address) DO UPDATE SET priority=GREATEST(node_accounting_jobs.priority,EXCLUDED.priority),requested_at=LEAST(node_accounting_jobs.requested_at,EXCLUDED.requested_at)`,
    [nodeAccountingScopeKey(request.scope), request.wallet, request.token, JSON.stringify(request.scope ?? { kind: 'public' }), request.foreground ? 100 : 0]);
  }
  async function prioritizeHistoricalWork(request: NodeAccountingRequest) {
    // Queue the selected token's mark before accounting becomes complete.
    // An open position awaiting its price cannot reach replay's quote stage.
    if (request.foreground) await market.requestRefresh?.(request.token, { priority: 10 });
    if (request.foreground && request.scope?.kind === 'public') await db.query(`UPDATE node_import_jobs SET priority=100
      WHERE wallet_address=$1 AND token_address=$2 AND stage<>'done' AND priority<100`, [request.wallet, request.token]);
  }
  async function readEvidence(request: NodeAccountingRequest, withoutImported = false): Promise<NodeAccountingEvidence> {
    const scope = request.scope ?? { kind: 'public' }, wallet = request.wallet, token = request.token;
    const [stateResult, baselineResult, proofResult] = await Promise.all([
      db.query(`SELECT m.*,m.registration_block::text AS registration,m.collected_through_block::text AS collected,
        m.decoded_through_block::text AS decoded,b.timestamp AS decoded_timestamp,r.timestamp AS registration_timestamp,
        (SELECT (value->>'blockNumber')::text FROM worker_state WHERE key='node') AS confirmed
        FROM node_monitored_wallets m LEFT JOIN node_evidence_blocks b ON b.block_number=m.decoded_through_block
        LEFT JOIN node_evidence_blocks r ON r.block_number=m.registration_block AND r.block_hash=m.registration_hash
        WHERE wallet_address=$1 AND active`, [wallet]),
      scope.kind === 'public' && !withoutImported ? db.query('SELECT * FROM node_accounting_baselines WHERE wallet_address=$1 AND token_address=$2 AND invalidated_at IS NULL', [wallet, token]) : Promise.resolve({ rows: [] }),
      db.query('SELECT * FROM node_accounting_balances WHERE wallet_address=$1 AND token_address=$2 AND schema_version=2 AND invalidated_at IS NULL', [wallet, token]),
    ]);
    const state = stateResult.rows[0], imported = baselineResult.rows[0], stored = proofResult.rows[0];
    const proof: KolTokenBalanceProof | null = stored ? { walletAddress: wallet, tokenAddress: token, chain: 'bsc', blockNumber: String(stored.block_number), blockHash: stored.block_hash,
      blockTimestamp: iso(stored.block_timestamp), balance: String(stored.balance), checkedAt: iso(stored.checked_at) } : null;
    if (scope.kind === 'public' && imported && proof && state?.registration && state.registered_at
      && BigInt(state.registration) <= BigInt(proof.blockNumber)) {
      const creation = await publicNodeCreationBoundary(db, token, state.registration, proof.blockNumber);
      const importWithinCapture = Array.isArray(imported.events) && imported.events.length > 0
        && imported.events.every((event: JournalLedgerEvent) => Number.isFinite(Date.parse(event.timestamp))
          && Date.parse(event.timestamp) >= Date.parse(iso(state.registered_at)));
      const zeroOpening = !creation && importWithinCapture && (await db.query(`SELECT 1 FROM journal_opening_balances
        WHERE wallet_address=$1 AND token_address=$2 AND block_number=$3 AND block_hash=$4 AND balance_raw=0`,
      [wallet, token, state.registration, state.registration_hash])).rowCount;
      // Historical recovery must not replace complete permanent node evidence.
      // Keep the baseline stored as a fallback, and select the node candidate
      // only after its full captured FIFO, costs, fees and balance reconcile.
      const candidate = creation || zeroOpening ? await readEvidence(request, true) : null;
      const coveredImport = candidate?.historyBoundary === 'token_creation' || candidate?.historyBoundary === 'verified_zero_position'
        && nodeHistoryCoversImportedMovements({ wallet, token, registeredAt: state.registered_at,
          checkpoint: String(imported.checkpoint_block), imported: imported.events, node: candidate.events });
      if (candidate && coveredImport && candidate.coverage.complete && candidate.proof) {
        const quote = candidate.quote, usableQuote = quote?.priceUsd && !quote.stale && nodeQuoteCoversMovements(quote, candidate.events);
        const evaluated = calculateJournalLedger({ wallets: [wallet], events: candidate.events, openingBalances: candidate.openingBalances,
          coverage: [candidate.coverage], asOf: new Date(now()).toISOString(), valuations: [{ tokenAddress: token,
            priceUsd: usableQuote ? quote.priceUsd : null, pricedAt: quote?.timestamp ?? candidate.proof.blockTimestamp,
            balances: [{ walletAddress: wallet, tokenAmount: candidate.proof.balance }] }] });
        const position = evaluated.positions[0];
        if (position && position.remainingCostBasisUsd !== null && position.reasons.every(reason => reason === 'quote_unavailable')) {
          // The retained import already covers this exact prefix. Reopening its
          // completed recovery job on each node refresh would cause churn.
          return { ...candidate, historicalRecoveryNeeded: false };
        }
      }
    }
    const reasons = new Set<string>();
    let historicalRecoveryNeeded = false;
    const start = scope.kind === 'portfolio' ? scope.fromBlock : imported ? String(imported.checkpoint_block) : state?.registration ?? null;
    const through = proof?.blockNumber ?? state?.decoded ?? null;
    const currentRepair = state?.repair_from_block != null && (!imported || start == null || BigInt(state.repair_from_block) > BigInt(start));
    if (!state || currentRepair || !state.decoded || !state.collected || !state.confirmed || !through || !start
      || BigInt(state.decoded) < BigInt(through) || BigInt(state.collected) < BigInt(through) || BigInt(through) < BigInt(start)) reasons.add(state?.last_error ?? 'collection_pending');
    let completedRange = false;
    if (state && start != null && through != null && state.generation) {
      const ranges = (await db.query(`SELECT from_block::text AS "fromBlock",to_block::text AS "toBlock" FROM node_evidence_ranges
        WHERE decoded_at IS NOT NULL AND to_block>$2 AND from_block<=$3 AND wallets->>$1=$4 ORDER BY from_block,to_block`, [wallet, start, through, state.generation])).rows;
      completedRange = nodeAccountingRangesComplete(start, through, ranges);
      if (!completedRange) reasons.add('collection_pending');
    }
    // A capture bootstrap starts a new monitoring generation, but must never
    // move an existing private membership's original activity boundary. Only
    // genuine completed evidence from this generation can bridge that interval.
    if (scope.kind === 'portfolio' && state?.registration != null
      && BigInt(scope.fromBlock) < BigInt(state.registration) && !completedRange) reasons.add('historical_gap');
    if (!proof) reasons.add('balance_unavailable');
    if (proof && (now() - Date.parse(proof.blockTimestamp) > 180_000 || Date.parse(proof.blockTimestamp) > now() + 1000)
      || state?.decoded_timestamp && now() - Date.parse(iso(state.decoded_timestamp)) > 180_000) reasons.add('node_indexer_lag');
    const canonical = proof ? (await db.query('SELECT block_hash FROM node_evidence_blocks WHERE block_number=$1', [proof.blockNumber])).rows[0] : null;
    if (proof && canonical?.block_hash !== proof.blockHash) reasons.add('chain_reorganization');
    if (imported && start != null && state?.registration != null && BigInt(start) < BigInt(state.registration)) {
      reasons.add('historical_gap'); historicalRecoveryNeeded = true;
    }
    const rows: NodeExecutionFlow[] = start != null && through != null ? (await db.query(`SELECT e.id,e.tx_hash,e.wallet_address,e.execution_index,e.operation_hash,e.block_number::text,e.block_hash,e.transaction_index,e.timestamp,
      e.status,e.kind,e.decoder_version,e.fee_native_wei::text,e.fee_complete,e.fee_reason,e.native_value_raw::text,e.logs,f.token_address,f.delta_raw::text,f.log_indices,f.counterparties,precision.decimals,trace.trace,
      lower(transaction_evidence.transaction->>'to') AS transaction_to,
      (${kolProfileTokenSql('v')}) AS eligible,markets.identities AS authenticated_markets
      FROM node_executions e JOIN node_execution_flows f ON f.execution_id=e.id LEFT JOIN tokens v ON v.address=f.token_address
      LEFT JOIN LATERAL(SELECT decimals FROM node_market_token_evidence WHERE token_address=f.token_address AND block_number<=e.block_number ORDER BY block_number DESC LIMIT 1) precision ON true
      LEFT JOIN node_trace_evidence trace ON trace.tx_hash=e.tx_hash AND trace.block_hash=e.block_hash
      LEFT JOIN node_evidence_transactions transaction_evidence ON transaction_evidence.tx_hash=e.tx_hash AND transaction_evidence.block_hash=e.block_hash
      LEFT JOIN LATERAL(SELECT jsonb_agg(candidate) AS identities FROM (
        SELECT id,token_address AS token,quote_address AS quote,protocol,contract_address AS contract,pool_id AS "poolId",
          token0,token1,decimals0,decimals1,authentication FROM node_markets m WHERE status IN ('active','graduated')
          AND (m.token_address=$2 OR m.quote_address=$2) AND EXISTS(
            SELECT 1 FROM jsonb_array_elements(e.logs) entry WHERE lower(entry->>'address')=m.contract_address)
          ORDER BY id LIMIT 8) candidate) markets ON true
      WHERE e.wallet_address=$1 AND e.block_number>$3 AND e.block_number<=$4 AND ($5::timestamptz IS NULL OR e.timestamp>=
        (SELECT added_at FROM journal_wallets WHERE user_id=$6::uuid AND wallet_address=$1 AND revision=$7::uuid))
        AND EXISTS(SELECT 1 FROM node_execution_flows target WHERE target.execution_id=e.id AND target.token_address=$2)
      ORDER BY e.block_number,e.transaction_index,e.execution_index,f.token_address`, [wallet, token, start, through, scope.kind === 'portfolio' ? scope.fromAt : null,
        scope.kind === 'portfolio' ? scope.accountId : null, scope.kind === 'portfolio' ? scope.membershipRevision : null])).rows : [];
    const inputFingerprint = hash([normalizationRevision, state?.generation, start, rows, imported?.history_fingerprint, scope]);
    const previousHistory = (await db.query(`SELECT payload,history_revision FROM node_accounting_history WHERE scope_key=$1 AND wallet_address=$2
      AND token_address=$3 AND invalidated_at IS NULL`, [nodeAccountingScopeKey(scope), wallet, token])).rows[0];
    const cachedHistory = previousHistory?.payload as NodeAccountingEvidence | undefined;
    // Completed historical valuations are immutable block evidence. Reuse them
    // while independently refreshing the ending quote and balance. Failed or
    // incomplete history is retried so newly captured price evidence repairs it.
    const normalized = cachedHistory?.normalizationRevision === normalizationRevision
      && cachedHistory.inputFingerprint === inputFingerprint && cachedHistory.coverage.complete ? { events: cachedHistory.events, reasons: [] }
      : await normalizeNodeExecutionFlows(rows, token, market);
    normalized.reasons.forEach(reason => reasons.add(reason));
    if(normalized.reasons.includes('native_trace_required')) {
      const pruned=(await db.query(`SELECT 1 FROM node_trace_jobs j JOIN node_executions e ON e.tx_hash=j.tx_hash AND e.block_hash=j.block_hash
        JOIN node_execution_flows f ON f.execution_id=e.id AND f.token_address=$2
        WHERE e.wallet_address=$1 AND e.block_number>$3 AND e.block_number<=$4
        AND j.state='unavailable' AND j.last_error='node_trace_state_unavailable' LIMIT 1`,[wallet,token,start,through])).rowCount;
      if(pruned) {
        reasons.add('native_trace_unavailable');
        // Only a confirmed, durably exhausted historical-state failure can
        // become migration work. Fresh queues, lag and unsupported AA decoding
        // remain node repair states and never trigger live-provider fallback.
        if(scope.kind==='public'&&completedRange&&proof&&!['collection_pending','node_indexer_lag','indexing_lag','chain_reorganization'].some(reason=>reasons.has(reason))) {
          reasons.add('historical_gap');historicalRecoveryNeeded=true;
        }
      }
    }
    if (start != null && through != null) {
      const unresolved = (await db.query(`SELECT EXISTS(SELECT 1 FROM node_executions e
        JOIN node_evidence_transactions raw ON raw.tx_hash=e.tx_hash
        WHERE e.wallet_address=$1 AND e.block_number>$3 AND e.block_number<=$4
          AND ($5::uuid IS NULL OR e.timestamp>=(SELECT added_at FROM journal_wallets WHERE user_id=$5::uuid AND wallet_address=$1 AND revision=$6::uuid))
          AND (e.status='failed' AND lower(raw.transaction->>'to')=$2 OR e.status='unsupported' AND
            (lower(raw.transaction->>'to')=$2 OR EXISTS(SELECT 1 FROM node_executions related JOIN node_execution_flows f ON f.execution_id=related.id
              WHERE related.tx_hash=e.tx_hash AND related.wallet_address=e.wallet_address AND f.token_address=$2)))) AS unknown`,
      [wallet, token, start, through, scope.kind === 'portfolio' ? scope.accountId : null, scope.kind === 'portfolio' ? scope.membershipRevision : null])).rows[0]?.unknown;
      if (unresolved) reasons.add('failed_execution_attribution_unknown');
    }
    const delta = sumJournalDecimals(normalized.events.map(event => `${event.kind === 'sell' || event.kind === 'transfer_out' ? '-' : ''}${event.tokenAmount}`));
    const openingBalances: JournalLedgerOpeningBalance[] = [];
    let historyBoundary: NodeAccountingEvidence['historyBoundary'] = imported ? 'imported_baseline' : scope.kind === 'portfolio' ? 'membership_added' : undefined;
    let boundaryFingerprint: string | null = imported?.history_fingerprint ?? null;
    if (scope.kind === 'portfolio' && proof && !reasons.has('collection_pending')) {
      const opening = sumJournalDecimals([proof.balance, delta === '0' ? '0' : delta.startsWith('-') ? delta.slice(1) : `-${delta}`]);
      if (opening.startsWith('-')) reasons.add('balance_unreconciled');
      else openingBalances.push(...(cachedHistory?.coverage.complete && cachedHistory.openingBalances.length
        ? cachedHistory.openingBalances : [{ walletAddress: wallet, tokenAddress: token, tokenAmount: opening }]));
    } else if (scope.kind === 'public' && !imported) {
      // A new zero-opening position must have an independent registration
      // balance. An indexed first buy alone never proves lifetime coverage.
      let opening = start == null ? null : (await db.query(`SELECT balance_raw::text,decimals FROM journal_opening_balances
        WHERE wallet_address=$1 AND token_address=$2 AND block_number=$3 AND block_hash=$4`, [wallet, token, start, state?.registration_hash ?? null])).rows[0];
      const prior = start == null ? true : (await db.query(`SELECT EXISTS(SELECT 1 FROM trades WHERE wallet_address=$1 AND token_address=$2 AND block_number<=$3)
        OR EXISTS(SELECT 1 FROM wallet_transfers WHERE wallet_address=$1 AND token_address=$2 AND block_number<=$3) AS older`, [wallet, token, start])).rows[0]?.older;
      if (!opening && proof && start && state?.registration_hash && !reasons.has('collection_pending') && !reasons.has('chain_reorganization')) {
        // A complete permanent transfer range and confirmed ending holdings
        // establish the registration balance after the node prunes that state.
        // Use raw flows, including ones whose USD cost is still unknown.
        const precision = rows.find(row => row.token_address === token)?.decimals;
        if (precision != null) {
          const endingRaw = journalDecimalMultiply(proof.balance, (10n ** BigInt(precision)).toString());
          const deltaRaw = rows.filter(row => row.token_address === token).reduce((total, row) => total + BigInt(row.delta_raw), 0n);
          if (endingRaw && /^\d+$/.test(endingRaw)) {
            const derived = BigInt(endingRaw) - deltaRaw;
            if (derived >= 0n) {
              opening = { balance_raw: derived.toString(), decimals: precision };
              await db.query(`INSERT INTO journal_opening_balances(wallet_address,token_address,block_number,block_hash,balance_raw,decimals)
                VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`, [wallet, token, start, state.registration_hash, derived.toString(), precision]);
            }
          }
        }
      }
      // A canonical zero registration balance proves the starting quantity of
      // the captured segment independently of this token's older lifetime.
      // Keep lifetime recovery below: older closed cycles are still unknown,
      // but a fully captured future period need not depend on their provider.
      if (opening?.balance_raw === '0') openingBalances.push({ walletAddress: wallet, tokenAddress: token, tokenAmount: '0' });
      if (!opening || opening.balance_raw !== '0' || prior) {
        reasons.add('historical_baseline_required');
        // Old indexed movements or confirmed nonzero opening holdings prove an
        // actual historical need. Missing current evidence alone does not.
        historicalRecoveryNeeded = start != null && (prior || !!opening && opening.balance_raw !== '0');
      }
      else if (start && through && state?.registered_at) {
        const boundary = await publicLifetimeBoundary(db, wallet, token, start, state.registered_at, through);
        if (!boundary) {
          reasons.add('historical_baseline_required');
          historicalRecoveryNeeded = completedRange && !!proof && normalized.reasons.length === 0
            && !reasons.has('node_indexer_lag') && !reasons.has('indexing_lag') && !reasons.has('chain_reorganization') && !reasons.has('collection_pending');
        }
        else { historyBoundary = boundary.boundary; boundaryFingerprint = boundary.fingerprint; }
      } else reasons.add('historical_baseline_required');
    }
    let retryAfterMs: number | undefined;
    if (scope.kind === 'public' && (reasons.has('historical_baseline_required') || reasons.has('historical_gap'))) {
      const waiting = (await db.query(`SELECT last_error,next_attempt_at FROM node_import_jobs WHERE wallet_address=$1 AND token_address=$2 AND stage<>'done'
        UNION ALL SELECT last_error,next_attempt_at FROM node_import_wallet_jobs WHERE wallet_address=$1 AND stage<>'done'`, [wallet, token])).rows;
      // A rejected aggregate is a known financial contradiction, not merely
      // waiting history. Keep its numbers unavailable and its paced job intact.
      if(waiting.some(job=>job.last_error==='import_aggregate_inconsistent'))reasons.add('historical_accounting_mismatch');
      for (const job of waiting) if (job.last_error && /(?:provider|cooldown|rate_limit)/.test(job.last_error)
        && Date.parse(iso(job.next_attempt_at)) > now()) {
        reasons.add('historical_import_cooldown'); retryAfterMs = Math.max(retryAfterMs ?? 0, Math.min(300_000, Date.parse(iso(job.next_attempt_at)) - now()));
      }
    }
    // A zero opening and continuous node capture can establish this captured
    // position without proving that the wallet never traded an older cycle.
    // Keep historical recovery alive, exposing the narrower boundary. Unknown
    // costs, a contradictory aggregate, broken ranges and unreconciled balances
    // never qualify. Provider cooldown alone cannot block independent node P&L.
    // Retain this boundary through a head delay, retaining node_indexer_lag too:
    // coverage stays incomplete and only an unchanged dated snapshot may show.
    if (scope.kind === 'public' && !imported && state?.registration_timestamp
      && completedRange && !currentRepair && proof && openingBalances.length === 1
      && openingBalances[0].tokenAmount === '0' && reasons.has('historical_baseline_required')
      && [...reasons].every(reason => ['historical_baseline_required', 'historical_import_cooldown', 'node_indexer_lag'].includes(reason))
      && normalized.events.length > 0 && normalized.events.every(event => event.amountUsd !== null && event.feeUsd !== null)) {
      reasons.delete('historical_baseline_required'); reasons.delete('historical_import_cooldown'); retryAfterMs = undefined;
      historyBoundary = 'verified_zero_position';
      boundaryFingerprint = hash([state.generation, start, state.registration_hash, iso(state.registration_timestamp), openingBalances]);
    }
    const quote = await market.quote(token, { maxAgeMs: 180_000 });
    const source: NodeAccountingSource = imported ? normalized.events.length ? 'mixed' : 'imported' : historyBoundary === 'wallet_discovery' ? 'mixed' : 'node';
    const quantitiesComplete = completedRange && !currentRepair && !!proof && (!!imported || openingBalances.length > 0 || !!historyBoundary)
      && ![...reasons].some(reason => ['collection_pending', 'node_indexer_lag', 'chain_reorganization', 'historical_gap',
        'token_decimals_unknown', 'unsupported_execution_decoder', 'failed_execution_with_token_flows'].includes(reason));
    return { events: normalized.events, historicalEvents: imported?.events ?? [], baselines: imported ? [asBaseline(wallet, token, imported)] : [], openingBalances,
      proof, quote, source, fromBlock: start, throughBlock: through,
      monitoringGeneration: state?.generation,
      historicalRecoveryNeeded,
      historyFingerprint: hash([inputFingerprint, historyBoundary, boundaryFingerprint]), inputFingerprint, normalizationRevision, historyBoundary,
      ...(historyBoundary === 'verified_zero_position' ? { historyFrom: iso(state.registration_timestamp) } : {}),
      reasons: [...reasons].sort(),
      ...(retryAfterMs ? { retryAfterMs } : {}),
      coverage: { walletAddress: wallet, tokenAddress: token, complete: reasons.size === 0, quantitiesComplete, ...(reasons.size ? { reason: [...reasons].sort()[0] } : {}) },
      ...(reasons.size ? { reason: [...reasons].sort()[0] } : {}) };
  }
  async function evidence(raw: NodeAccountingRequest) {
    const request = normalize(raw);
    if (!await authorize(request)) return undefined;
    const cached = (await db.query('SELECT payload FROM node_accounting_history WHERE scope_key=$1 AND wallet_address=$2 AND token_address=$3 AND invalidated_at IS NULL', [nodeAccountingScopeKey(request.scope), request.wallet, request.token])).rows[0]?.payload as NodeAccountingEvidence | undefined;
    if (!cached || !cached.proof || now() - Date.parse(cached.proof.checkedAt) > 20_000) await enqueue(request);
    if (!await authorize(request)) return undefined;
    return cached;
  }
  async function refresh(raw: NodeAccountingRequest): Promise<KolTokenActivity | undefined> {
    const request = normalize(raw), key = requestKey(request), existing = jobs.get(key);
    if (existing) return existing;
    const work = (async () => {
      if (!await authorize(request)) return undefined;
      const preparationStartedAt = (await db.query('SELECT clock_timestamp() AS started')).rows[0].started;
      const metadata = (await db.query(`SELECT v.*,precision.decimals AS confirmed_decimals,k.display_name AS kol_name,k.avatar_url,k.twitter,k.source,k.last_seen_at,
        CASE WHEN v.logo_data IS NOT NULL THEN '/api/token-image/'||v.address||'?v='||md5(v.logo_data) END AS logo_url
        FROM tokens v JOIN published_kols k ON k.address=$1
        LEFT JOIN node_monitored_wallets m ON m.wallet_address=k.address
        LEFT JOIN LATERAL(SELECT decimals FROM node_market_token_evidence WHERE token_address=v.address AND block_number<=m.decoded_through_block ORDER BY block_number DESC LIMIT 1) precision ON true
        WHERE v.address=$2 AND ${kolProfileTokenSql()}`, [request.wallet, request.token])).rows[0];
      if (!metadata) return undefined;
      const state = (await db.query(`SELECT LEAST(m.decoded_through_block,m.collected_through_block,
        (SELECT (value->>'blockNumber')::bigint FROM worker_state WHERE key='node'))::text AS checkpoint
        FROM node_monitored_wallets m LEFT JOIN node_accounting_baselines b ON b.wallet_address=m.wallet_address AND b.token_address=$2 AND b.invalidated_at IS NULL
        WHERE m.wallet_address=$1 AND m.active AND (m.repair_from_block IS NULL OR $3::boolean AND b.checkpoint_block>=m.repair_from_block)`,
      [request.wallet, request.token, request.scope?.kind === 'public'])).rows[0];
      if (state?.checkpoint && metadata.confirmed_decimals != null) {
        try {
          const proof = await balance({ wallet: request.wallet, token: request.token, decimals: metadata.confirmed_decimals, blockNumber: state.checkpoint });
          await db.query(`INSERT INTO node_accounting_balances(wallet_address,token_address,block_number,block_hash,block_timestamp,balance,checked_at)
            VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(wallet_address,token_address) DO UPDATE SET block_number=EXCLUDED.block_number,
            block_hash=EXCLUDED.block_hash,block_timestamp=EXCLUDED.block_timestamp,balance=EXCLUDED.balance,checked_at=EXCLUDED.checked_at,schema_version=2,invalidated_at=NULL`,
          [request.wallet, request.token, proof.blockNumber, proof.blockHash, proof.blockTimestamp, proof.balance, proof.checkedAt]);
        } catch { /* Keep the dated proof and last-valid snapshot; readEvidence reports lag. */ }
      }
      if (request.scope?.kind === 'public' && metadata.confirmed_decimals != null) {
        const registration = (await db.query('SELECT registration_block::text,registration_hash FROM node_monitored_wallets WHERE wallet_address=$1 AND active', [request.wallet])).rows[0];
        if (registration?.registration_block && registration.registration_hash) {
          const known = (await db.query('SELECT 1 FROM journal_opening_balances WHERE wallet_address=$1 AND token_address=$2 AND block_number=$3', [request.wallet, request.token, registration.registration_block])).rowCount;
          if (!known) try {
            // One bounded registration-state read in the worker, never a page
            // request scan. Once saved it survives ordinary node pruning.
            const tag = `0x${BigInt(registration.registration_block).toString(16)}`;
            const [block, raw] = await Promise.all([
              chainRpc<{ number: string; hash: string }>('eth_getBlockByNumber', [tag, false]),
              chainRpc<string>('eth_call', [{ to: request.token, data: `0x70a08231${request.wallet.slice(2).padStart(64, '0')}` }, tag]),
            ]);
            if (block?.hash?.toLowerCase() === registration.registration_hash.toLowerCase() && BigInt(block.number) === BigInt(registration.registration_block) && /^0x[0-9a-f]{64}$/i.test(raw)) {
              await db.query(`INSERT INTO journal_opening_balances(wallet_address,token_address,block_number,block_hash,balance_raw,decimals)
                VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`, [request.wallet, request.token, registration.registration_block, block.hash.toLowerCase(), BigInt(raw).toString(), metadata.confirmed_decimals]);
            }
          } catch { /* A pruned registration requires a reconciled import. */ }
        }
      }
      const prepared = await readEvidence(request), checkedAt = new Date(now()).toISOString();
      if(prepared.reasons?.includes('native_trace_required'))await queueNodeTraceRepairs(db,{wallet:request.wallet,token:request.token,limit:4});
      const quote = prepared.quote, quoteCoversMovements = nodeQuoteCoversMovements(quote, [...prepared.historicalEvents, ...prepared.events]);
      const validQuote = quote?.priceUsd && !quote.stale && quote.timestamp && quoteCoversMovements ? { priceUsd: quote.priceUsd, timestamp: quote.timestamp } : null;
      if (quote?.priceUsd && !quote.stale && !quoteCoversMovements) await market.requestRefresh?.(request.token, { priority: request.foreground ? 10 : 5 });
      const base = emptyActivity(request.wallet, request.token, metadata, now());
      base.token = { ...base.token, priceUsd: quote?.priceUsd ?? null, marketCapUsd: quote?.marketCapUsd ?? null, marketCapSupply: quote?.supply ?? null };
      const evaluated = calculateJournalLedger({ wallets: [request.wallet], events: prepared.events, baselines: prepared.baselines,
        openingBalances: prepared.openingBalances, coverage: [prepared.coverage], asOf: checkedAt, timeline: true,
        valuations: [{ tokenAddress: request.token, priceUsd: validQuote?.priceUsd ?? null, pricedAt: validQuote?.timestamp ?? checkedAt,
          balances: prepared.proof ? [{ walletAddress: request.wallet, tokenAmount: prepared.proof.balance }] : [] }] });
      const ending = evaluated.positions[0], complete = !!ending?.complete;
      const endingQuote = ending?.state === 'closed' ? null : validQuote;
      let response = prepared.proof ? applyJournalReplay(base, { events: prepared.events, proof: prepared.proof, coverageComplete: prepared.coverage.complete,
        quote: endingQuote, source: prepared.source, openingBalances: prepared.openingBalances, baselines: prepared.baselines,
        historicalEvents: prepared.historicalEvents, evaluated, now: now() }) : base;
      const identity: NodeAccountingSnapshotIdentity = { version: 2, snapshotId: hash([key, prepared.historyFingerprint, evaluated, quote]), source: prepared.source,
        scope: request.scope!.kind, asOf: endingQuote?.timestamp ?? prepared.proof?.blockTimestamp ?? checkedAt, historyFingerprint: prepared.historyFingerprint,
        historyFrom: prepared.historyFrom ?? [...prepared.historicalEvents, ...prepared.events][0]?.timestamp ?? null, coveredThroughBlock: prepared.throughBlock,
        valuationBlock: endingQuote ? quote?.blockNumber ?? prepared.proof?.blockNumber ?? null : prepared.proof?.blockNumber ?? null,
        valuationHash: endingQuote ? quote?.blockHash ?? prepared.proof?.blockHash ?? null : prepared.proof?.blockHash ?? null,
        complete, reasons: [...new Set([...evaluated.reasons, ...(prepared.reasons ?? []), ...(prepared.reason ? [prepared.reason] : [])])].sort() };
      identity.historyBoundary = prepared.historyBoundary;
      if (prepared.historyBoundary === 'verified_zero_position') {
        identity.lifetimeComplete = false;
        identity.lifetimeReason = 'historical_baseline_required';
      }
      response = { ...response, accountingSnapshot: identity };
      if (response.realizedAccounting) response.realizedAccounting.coverage.historyFingerprint = prepared.historyFingerprint;
      if (response.replayAccounting?.history) response.replayAccounting.history.fingerprint = prepared.historyFingerprint;
      if (prepared.retryAfterMs && response.realizedAccounting?.status === 'pending') response.realizedAccounting.retryAfterMs = prepared.retryAfterMs;
      if (prepared.retryAfterMs && response.replayAccounting?.status === 'pending') response.replayAccounting.retryAfterMs = prepared.retryAfterMs;
      if (!prepared.proof) response.realizedAccounting = { version: 2, source: prepared.source, policy: 'kollens_fifo_v1', walletAddress: request.wallet, tokenAddress: request.token,
        checkedAt, status: 'pending', realizedProfitUsd: null, retryAfterMs: 1500, coverage: { transactionsComplete: false, balanceMatched: false, reason: prepared.reason ?? 'balance_unavailable' } };
      const summary: NodeAccountingSummary = { tokenAddress: request.token, snapshot: identity, status: complete ? 'ready' : 'pending', position: ending?.state ?? 'unknown',
        realizedProfitUsd: complete ? ending.realizedProfitUsd : null, estimatedProfitUsd: complete ? ending.estimatedProfitUsd : null, roi: complete ? ending.roi : null,
        remainingTokenAmount: ending?.remainingTokenAmount ?? null, valueUsd: ending?.valueUsd ?? null,
        ...(!complete ? { reason: prepared.retryAfterMs ? 'historical_import_cooldown' : identity.reasons[0] ?? 'collection_pending', retryAfterMs: prepared.retryAfterMs ?? 1500 } : {}) };
      if (!await authorize(request)) return undefined;
      const scopeKey = nodeAccountingScopeKey(request.scope);
      const writer = await db.connect();
      try {
      await writer.query('BEGIN');
      await writer.query('SELECT pg_advisory_xact_lock_shared(782319)');
      await writer.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`node-accounting:${request.wallet}:${request.token}`]);
      const monitoring = (await writer.query('SELECT generation::text FROM node_monitored_wallets WHERE wallet_address=$1 AND active', [request.wallet])).rows[0];
      if (!prepared.monitoringGeneration || monitoring?.generation !== prepared.monitoringGeneration) throw new Error('snapshot_monitoring_changed');
      if (request.scope?.kind === 'public' && prepared.historicalRecoveryNeeded) await writer.query(`INSERT INTO node_import_jobs(wallet_address,token_address,priority)
        SELECT $1,$2,GREATEST($3,CASE WHEN COALESCE((SELECT priority FROM node_accounting_jobs
          WHERE scope_key='public' AND wallet_address=$1 AND token_address=$2),0)>=10 THEN 20 ELSE 0 END)
        ON CONFLICT(wallet_address,token_address) DO UPDATE SET priority=GREATEST(node_import_jobs.priority,EXCLUDED.priority),
          stage=CASE WHEN node_import_jobs.stage='done' THEN 'reconcile' ELSE node_import_jobs.stage END,
          next_attempt_at=CASE WHEN node_import_jobs.stage='done' THEN now() ELSE node_import_jobs.next_attempt_at END,
          completed_at=CASE WHEN node_import_jobs.stage='done' THEN NULL ELSE node_import_jobs.completed_at END`,
      [request.wallet, request.token, request.foreground ? 100 : 0]);
      const invalidated = (await writer.query(`SELECT EXISTS(SELECT 1 FROM node_accounting_snapshots
        WHERE scope_key=$1 AND wallet_address=$2 AND token_address=$3 AND invalidated_at>$4::timestamptz)
        OR EXISTS(SELECT 1 FROM node_accounting_history WHERE scope_key=$1 AND wallet_address=$2 AND token_address=$3
          AND invalidated_at>$4::timestamptz) AS changed`, [scopeKey, request.wallet, request.token, preparationStartedAt])).rows[0]?.changed;
      if (invalidated) throw new Error('snapshot_evidence_changed');
      const traceChanged=(await writer.query(`SELECT EXISTS(SELECT 1 FROM node_trace_evidence t JOIN node_executions e ON e.tx_hash=t.tx_hash AND e.block_hash=t.block_hash
        JOIN node_execution_flows f ON f.execution_id=e.id AND f.token_address=$2
        WHERE e.wallet_address=$1 AND e.block_number>$3 AND e.block_number<=$4 AND t.checked_at>$5::timestamptz) AS changed`,
        [request.wallet,request.token,prepared.fromBlock,prepared.throughBlock,preparationStartedAt])).rows[0]?.changed;
      if(traceChanged)throw new Error('snapshot_evidence_changed');
      if (prepared.proof) {
        const canonical = (await writer.query('SELECT block_hash FROM node_evidence_blocks WHERE block_number=$1', [prepared.proof.blockNumber])).rows[0];
        if (canonical?.block_hash !== prepared.proof.blockHash) throw new Error('snapshot_chain_reorganization');
      }
      if (request.scope?.kind === 'portfolio') {
        const membership = await writer.query('SELECT 1 FROM journal_wallets WHERE user_id=$1 AND wallet_address=$2 AND revision=$3::uuid FOR KEY SHARE', [request.scope.accountId, request.wallet, request.scope.membershipRevision]);
        if (!membership.rowCount) throw new Error('snapshot_membership_changed');
      }
      await writer.query(`INSERT INTO node_accounting_history(scope_key,wallet_address,token_address,history_revision,from_block,to_block,to_hash,source,payload)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) ON CONFLICT(scope_key,wallet_address,token_address) DO UPDATE SET
        history_revision=EXCLUDED.history_revision,from_block=EXCLUDED.from_block,to_block=EXCLUDED.to_block,to_hash=EXCLUDED.to_hash,source=EXCLUDED.source,payload=EXCLUDED.payload,observed_at=now(),invalidated_at=NULL,schema_version=2`,
      [scopeKey, request.wallet, request.token, prepared.historyFingerprint, prepared.fromBlock, prepared.throughBlock, prepared.proof?.blockHash ?? null, prepared.source, JSON.stringify(prepared)]);
      await writer.query(`INSERT INTO node_accounting_snapshots(scope_key,wallet_address,token_address,snapshot_id,history_revision,valuation_block,valuation_hash,as_of,complete,payload,summary,last_valid)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,CASE WHEN $9 THEN $10::jsonb END)
        ON CONFLICT(scope_key,wallet_address,token_address) DO UPDATE SET snapshot_id=EXCLUDED.snapshot_id,history_revision=EXCLUDED.history_revision,
        valuation_block=EXCLUDED.valuation_block,valuation_hash=EXCLUDED.valuation_hash,as_of=EXCLUDED.as_of,complete=EXCLUDED.complete,
        payload=EXCLUDED.payload,summary=EXCLUDED.summary,last_valid=CASE WHEN EXCLUDED.complete THEN EXCLUDED.payload ELSE node_accounting_snapshots.last_valid END,invalidated_at=NULL,schema_version=2`,
      [scopeKey, request.wallet, request.token, identity.snapshotId, prepared.historyFingerprint, identity.valuationBlock, identity.valuationHash, identity.asOf, complete, JSON.stringify(response), JSON.stringify(summary)]);
      if (complete) await writer.query(`INSERT INTO node_accounting_snapshot_versions(scope_key,wallet_address,token_address,snapshot_id,covered_through_block,valuation_block,valuation_hash,payload,as_of)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9) ON CONFLICT DO NOTHING`,
      [scopeKey, request.wallet, request.token, identity.snapshotId, identity.coveredThroughBlock, identity.valuationBlock, identity.valuationHash, JSON.stringify(response), identity.asOf]);
      await writer.query('COMMIT');
      } catch (error) { await writer.query('ROLLBACK'); throw error; }
      finally { writer.release(); }
      return response;
    })().finally(() => jobs.delete(key));
    jobs.set(key, work); return work;
  }
  async function activity(raw: NodeAccountingRequest): Promise<KolTokenActivity | undefined> {
    const request = normalize(raw);
    if (!await authorize(request)) return undefined;
    await prioritizeHistoricalWork(request);
    const saved = (await db.query(`SELECT payload,as_of,complete,last_valid,invalidated_at FROM node_accounting_snapshots WHERE scope_key=$1 AND wallet_address=$2 AND token_address=$3`,
      [nodeAccountingScopeKey(request.scope), request.wallet, request.token])).rows[0];
    if (!saved || saved.invalidated_at || request.foreground && !saved.complete || now() - Date.parse(saved.as_of) > 20_000) await enqueue(request);
    if (!await authorize(request)) return undefined;
    if (saved && !saved.invalidated_at) {
      const retained = datedValidActivity(saved, now());
      if (retained) return currentTokenIdentity(retained);
      const result = saved.payload as KolTokenActivity;
      if (saved.last_valid && !saved.complete && result.accountingSnapshot) result.accountingSnapshot.lastValid = {
        snapshotId: saved.last_valid.accountingSnapshot.snapshotId, asOf: saved.last_valid.accountingSnapshot.asOf };
      return currentTokenIdentity(result);
    }
    const metadata = (await db.query(`SELECT v.*,k.display_name AS kol_name,k.avatar_url,k.twitter,k.source,k.last_seen_at
      FROM tokens v JOIN published_kols k ON k.address=$1 WHERE v.address=$2 AND ${kolProfileTokenSql()}`, [request.wallet, request.token])).rows[0];
    if (!metadata) return undefined;
    const pending = emptyActivity(request.wallet, request.token, metadata, now());
    pending.realizedAccounting = { version: 2, source: 'node', policy: 'kollens_fifo_v1', walletAddress: request.wallet, tokenAddress: request.token,
      status: 'pending', checkedAt: pending.generatedAt, realizedProfitUsd: null, retryAfterMs: 1500,
      coverage: { transactionsComplete: false, balanceMatched: false, reason: 'collection_pending' } };
    return pending;
  }
  async function savedActivity(raw: NodeAccountingRequest, snapshotId: string): Promise<KolTokenActivity | undefined> {
    const request = normalize(raw);
    if (!/^[a-f0-9]{64}$/.test(snapshotId) || !await authorize(request)) return undefined;
    const value = (await db.query(`SELECT payload FROM node_accounting_snapshot_versions
      WHERE scope_key=$1 AND wallet_address=$2 AND token_address=$3 AND snapshot_id=$4 AND invalidated_at IS NULL AND expires_at>now()`,
    [nodeAccountingScopeKey(request.scope), request.wallet, request.token, snapshotId])).rows[0]?.payload as KolTokenActivity | undefined;
    if (!value?.accountingSnapshot || value.accountingSnapshot.snapshotId !== snapshotId) return undefined;
    const proof = value.realizedAccounting?.coverage.balanceProof;
    const canonical = proof ? (await db.query('SELECT block_hash FROM node_evidence_blocks WHERE block_number=$1', [proof.blockNumber])).rows[0] : null;
    if (!proof || canonical?.block_hash !== proof.blockHash || !await authorize(request)) return undefined;
    await prioritizeHistoricalWork(request);
    return currentTokenIdentity(value);
  }
  async function currentTokenIdentity(value:KolTokenActivity) {
    const current=(await db.query(`SELECT symbol,name,CASE WHEN logo_data IS NOT NULL THEN '/api/token-image/'||address||'?v='||md5(logo_data) END AS logo_url
      FROM tokens WHERE address=$1`,[value.token.address])).rows[0];
    return current?{...value,token:{...value.token,symbol:current.symbol??value.token.symbol,name:current.name??value.token.name,logoUrl:current.logo_url??value.token.logoUrl}}:value;
  }
  async function summaries(wallet: string, tokens: string[], scope: NodeAccountingScope = { kind: 'public' }): Promise<Record<string, NodeAccountingSummary>> {
    const selected = [...new Set(tokens.map(token => token.toLowerCase()))].filter(token => address(token) && !isExcludedKolProfileTokenAddress(token)).slice(0, 24), result: Record<string, NodeAccountingSummary> = {};
    if (!selected.length || !await authorize({ wallet, token: selected[0], scope })) return result;
    // One bounded database read for the initial six cards. No receipt/RPC scan.
    const saved = await db.query(`SELECT token_address,summary,as_of,invalidated_at,payload,last_valid,complete FROM node_accounting_snapshots
      WHERE scope_key=$1 AND wallet_address=$2 AND token_address=ANY($3::text[])`, [nodeAccountingScopeKey(scope), wallet, selected]);
    for (const token of selected) {
      const row = saved.rows.find(row => row.token_address === token);
      const retained = row ? datedValidActivity(row, now()) : null;
      const lastPosition = retained?.realizedAccounting?.position;
      result[token] = retained ? { tokenAddress: token, snapshot: retained.accountingSnapshot!, status: 'ready', position: lastPosition?.status ?? 'unknown',
        realizedProfitUsd: retained.realizedAccounting?.realizedProfitUsd ?? null, estimatedProfitUsd: lastPosition?.estimatedProfitUsd ?? null,
        roi: lastPosition?.estimatedRoi ?? null, remainingTokenAmount: lastPosition?.remainingTokenAmount ?? null,
        valueUsd: lastPosition?.priceUsd && lastPosition.remainingTokenAmount ? journalDecimalMultiply(lastPosition.priceUsd, lastPosition.remainingTokenAmount) : null }
        : row && !row.invalidated_at ? row.summary : { tokenAddress: token, snapshot: null, status: 'pending', position: 'unknown', realizedProfitUsd: null,
        estimatedProfitUsd: null, roi: null, remainingTokenAmount: null, valueUsd: null, reason: 'collection_pending', retryAfterMs: 1500 };
    }
    const stale = selected.filter(token => { const row = saved.rows.find(row => row.token_address === token); return !row || row.invalidated_at || now() - Date.parse(row.as_of) > 20_000; });
    if (stale.length) {
      await db.query(`INSERT INTO node_accounting_jobs(scope_key,wallet_address,token_address,scope,priority)
        SELECT $1,$2,token,$3::jsonb,10 FROM unnest($4::text[]) token ON CONFLICT(scope_key,wallet_address,token_address)
        DO UPDATE SET priority=GREATEST(node_accounting_jobs.priority,EXCLUDED.priority)`, [nodeAccountingScopeKey(scope), wallet, JSON.stringify(scope), stale]);
      // Six visible cards share one bounded database quote job batch. Their
      // refreshes stay below an explicitly selected trade, with no page RPC.
      await db.query(`INSERT INTO node_market_refresh_jobs(token_address,priority,requested_at,expires_at)
        SELECT token,5,now(),now()+interval '2 minutes' FROM unnest($1::text[]) token ON CONFLICT(token_address)
        DO UPDATE SET priority=GREATEST(node_market_refresh_jobs.priority,EXCLUDED.priority),
          expires_at=GREATEST(node_market_refresh_jobs.expires_at,EXCLUDED.expires_at)`,[stale]);
    }
    if(scope.kind==='public')await db.query(`UPDATE node_import_jobs j SET priority=GREATEST(j.priority,20)
      WHERE j.wallet_address=$1 AND j.token_address=ANY($2::text[]) AND j.stage IN('history','aggregate','reconcile')
      AND NOT EXISTS(SELECT 1 FROM node_accounting_baselines b JOIN node_monitored_wallets m ON m.wallet_address=b.wallet_address
        WHERE b.wallet_address=j.wallet_address AND b.token_address=j.token_address AND b.invalidated_at IS NULL AND b.checkpoint_block>=m.registration_block)`,[wallet,selected]);
    if (!await authorize({ wallet, token: selected[0], scope })) return {};
    return result;
  }
  async function tick(limit = 4): Promise<NodeAccountingTickResult> {
    const capacity = Math.min(4 - draining, Math.max(1, Math.min(4, Math.trunc(limit))));
    if (!capacity) return { claimed: 0, active: jobs.size, updated: 0, completed: 0, wallets: [] };
    draining += capacity;
    let updated = 0, completed = 0;
    const wallets = new Set<string>();
    try {
    // These immutable versions are short media-preparation leases; permanent
    // executions, historical ledgers and the latest financial snapshot remain.
    if (!versionCleanup && now() - lastVersionCleanup >= 60_000) {
      lastVersionCleanup = now();
      versionCleanup = db.query(`DELETE FROM node_accounting_snapshot_versions WHERE ctid IN
        (SELECT ctid FROM node_accounting_snapshot_versions WHERE expires_at<=now() LIMIT 1000)`)
        .finally(() => { versionCleanup = undefined; });
    }
    await versionCleanup;
    const lease = randomUUID();
    const claimed = await db.query(`WITH selected AS (SELECT scope_key,wallet_address,token_address FROM node_accounting_jobs
      WHERE next_attempt_at<=now() AND (lease_until IS NULL OR lease_until<now()) ORDER BY priority DESC,requested_at LIMIT $1 FOR UPDATE SKIP LOCKED)
      UPDATE node_accounting_jobs j SET lease_id=$2::uuid,lease_until=now()+interval '30 seconds',attempts=attempts+1 FROM selected s
      WHERE j.scope_key=s.scope_key AND j.wallet_address=s.wallet_address AND j.token_address=s.token_address RETURNING j.*`, [capacity, lease]);
    await Promise.all(claimed.rows.map(async row => {
      try {
        const request = { wallet: row.wallet_address, token: row.token_address, scope: row.scope, foreground: row.priority >= 100 };
        const result = await refresh(request);
        const snapshot = result?.accountingSnapshot;
        // Decoding can queue a movement before the range's global checkpoint
        // advances. A valid older snapshot must not acknowledge that newer
        // request merely because it was complete at its own balance block.
        const coversRequested = row.requested_through_block == null || snapshot?.coveredThroughBlock != null
          && BigInt(snapshot.coveredThroughBlock) >= BigInt(row.requested_through_block);
        const ready = !!snapshot?.complete && coversRequested;
        // An absent token row can be a metadata/registration delay. A revoked
        // subscription or an existing, explicitly excluded asset is terminal;
        // later enrichment must not leave an LP/quote/tracker retrying forever.
        const retired = !result && (!await authorize(request) || !!(await db.query(`SELECT 1 FROM tokens v
          WHERE v.address=$1 AND NOT ${kolProfileTokenSql('v')}`, [row.token_address])).rowCount);
        if (result?.accountingSnapshot) {
          updated++; if (ready) completed++;
          if (row.scope?.kind === 'public') wallets.add(row.wallet_address);
        }
        if (retired || ready) {
          await db.query(`DELETE FROM node_accounting_jobs WHERE scope_key=$1 AND wallet_address=$2 AND token_address=$3 AND lease_id=$4
            AND requested_through_block IS NOT DISTINCT FROM $5::bigint`, [row.scope_key, row.wallet_address, row.token_address, lease, row.requested_through_block ?? null]);
          // A new decoded movement joined the leased preparation. Its higher
          // watermark survives the old result, and immediately gets a new slot.
          await db.query(`UPDATE node_accounting_jobs SET lease_until=NULL,lease_id=NULL
            WHERE scope_key=$1 AND wallet_address=$2 AND token_address=$3 AND lease_id=$4`, [row.scope_key, row.wallet_address, row.token_address, lease]);
        }
        // Priority describes waiting work, not a permanent subscription. A
        // pending old selection rotates behind newly visible cards; a joining
        // selected caller can promote its coalesced job again.
        else await db.query(`UPDATE node_accounting_jobs SET lease_until=NULL,lease_id=NULL,
          priority=CASE WHEN requested_through_block IS DISTINCT FROM $6::bigint THEN priority ELSE 0 END,requested_at=clock_timestamp(),
          next_attempt_at=GREATEST(next_attempt_at,now()+interval '5 seconds'),last_error=$5
          WHERE scope_key=$1 AND wallet_address=$2 AND token_address=$3 AND lease_id=$4`, [row.scope_key, row.wallet_address, row.token_address, lease,
            snapshot?.complete && !coversRequested ? 'indexing_lag' : snapshot?.reasons[0] ?? (result ? 'collection_pending' : 'token_metadata_unavailable'), row.requested_through_block ?? null]);
      } catch { await db.query(`UPDATE node_accounting_jobs SET lease_until=NULL,lease_id=NULL,
        priority=CASE WHEN requested_through_block IS DISTINCT FROM $5::bigint THEN priority ELSE 0 END,requested_at=clock_timestamp(),
        next_attempt_at=GREATEST(next_attempt_at,now()+interval '5 seconds'),last_error='snapshot_preparation_failed'
        WHERE scope_key=$1 AND wallet_address=$2 AND token_address=$3 AND lease_id=$4`, [row.scope_key, row.wallet_address, row.token_address, lease, row.requested_through_block ?? null]); }
    }));
    return { claimed: claimed.rowCount ?? 0, active: jobs.size, updated, completed, wallets: [...wallets] };
    } finally { draining -= capacity; }
  }
  return { activity, savedActivity, summaries, evidence, refresh, tick };
}
export const nodeAccountingService = createNodeAccountingService();
