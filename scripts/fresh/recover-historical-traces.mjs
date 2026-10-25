import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Operator one-off only. Never imported by the API or worker. Run with --import tsx.
export const EXPECTED_SOURCE = 'b593edee03bd60a07885534e63a79f00b396c5af01d1dca7f9e9577348d82f0b';
export const EXPECTED_BOUNDARY = 129180844;
export const EXPECTED_BOUNDARY_HASH = '0x32588e1f98d9d2c5bf163a8700ac3740b4aaf86237e57d9f0f86406600c90103';
const MAX_BYTES = 8 * 1024 * 1024;
const allowedMethods = new Set(['eth_chainId', 'eth_getTransactionByHash', 'eth_getTransactionReceipt', 'eth_getBlockByNumber', 'debug_traceTransaction']);
const hash = value => createHash('sha256').update(value).digest('hex');
const normalized = value => value && typeof value === 'object' ? Array.isArray(value) ? value.map(item => normalized(item) ?? null)
  : Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, normalized(value[key])])) : value;
const stable = value => JSON.stringify(normalized(value));
const same = (a, b) => stable(a) === stable(b);
const safeError = error => /^[a-z_]{1,80}$/.test(error?.message ?? '') ? error.message : 'archive_recovery_unavailable';
const hex = value => typeof value === 'string' && /^0x(?:[0-9a-f]{2})*$/i.test(value);
const lower = value => typeof value === 'string' ? value.toLowerCase() : value;
const txFields = ['hash', 'blockHash', 'blockNumber', 'transactionIndex', 'from', 'to', 'value', 'input', 'type', 'nonce', 'gas', 'gasPrice', 'maxFeePerGas', 'maxPriorityFeePerGas', 'chainId', 'authorizationList', 'accessList'];
const receiptFields = ['transactionHash', 'transactionIndex', 'blockHash', 'blockNumber', 'from', 'to', 'status', 'gasUsed', 'effectiveGasPrice', 'cumulativeGasUsed', 'contractAddress', 'logsBloom', 'type', 'logs'];
const context = entry => stable({ transaction: entry.transaction, receipt: entry.receipt, wallets: entry.wallets, historicalWallets: entry.historicalWallets, observedAt: entry.observedAt });

export function archiveEndpoint(value) {
  if (!value) return null;
  let url; try { url = new URL(value); } catch { throw Error('archive_url_invalid'); }
  if (url.protocol !== 'https:' || !url.hostname || url.hash || url.username || url.password) throw Error('archive_url_invalid');
  return { url, hostname: url.hostname };
}

/** URL is operator configuration only and never appears in errors or reports. */
export function createArchiveRpc(value, fetcher = fetch, timing = {}) {
  const endpoint = archiveEndpoint(value);
  if (!endpoint) return null;
  const clock = timing.now ?? Date.now, sleep = timing.sleep ?? (ms => new Promise(resolveSleep => setTimeout(resolveSleep, ms)));
  let id = 0, lastStarted = -Infinity, rateLimited = false, running = false;
  return { hostname: endpoint.hostname, async rpc(method, params) {
    if (!allowedMethods.has(method)) throw Error('archive_method_denied');
    if (rateLimited) throw Error('archive_rate_limited');
    if (running) throw Error('archive_concurrency_denied');
    running = true;
    await sleep(Math.max(0, 1000 - (clock() - lastStarted))); lastStarted = clock();
    const requestId = ++id, controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetcher(endpoint.url.href, { method: 'POST', redirect: 'error', signal: controller.signal,
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }) });
      if (!response.ok) {
        if (response.status === 429) {
          rateLimited = true;
          const raw = response.headers.get('retry-after'), seconds = raw && /^\d+$/.test(raw) ? Number(raw) : raw ? Math.ceil((Date.parse(raw) - clock()) / 1000) : null;
          const error = Error('archive_rate_limited'); error.retryAfterSeconds = seconds !== null && Number.isFinite(seconds) ? Math.min(86400, Math.max(0, seconds)) : null;
          throw error;
        }
        throw Error('archive_http_unavailable');
      }
      if (Number(response.headers.get('content-length')) > MAX_BYTES) throw Error('archive_response_too_large');
      const reader = response.body?.getReader(); if (!reader) throw Error('archive_response_invalid');
      let size = 0; const chunks = [];
      try { for (;;) { const next = await reader.read(); if (next.done) break; size += next.value.byteLength;
        if (size > MAX_BYTES) { await reader.cancel(); throw Error('archive_response_too_large'); } chunks.push(Buffer.from(next.value)); } }
      finally { reader.releaseLock(); }
      let body; try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw Error('archive_response_invalid'); }
      if (body?.jsonrpc !== '2.0' || body.id !== requestId || body.error || body.result == null) throw Error('archive_rpc_unavailable');
      return body.result;
    } catch (error) { if (controller.signal.aborted) throw Error('archive_timeout'); const safe = Error(safeError(error));
      if (error?.message === 'archive_rate_limited') safe.retryAfterSeconds = error.retryAfterSeconds ?? null; throw safe; }
    finally { clearTimeout(timeout); running = false; }
  } };
}

export async function loadRecoveryValidators() {
  const [capture, trace, complete] = await Promise.all([import('../../server/fresh/capture.ts'), import('../../server/fresh/trace.ts'), import('../../server/fresh/passiveIncoming.ts')]);
  return { ...capture, ...trace, certifyFreshCompleteCallTrace: complete.certifyFreshCompleteCallTrace };
}

function requireMatchingFields(actual, original, fields, reason) {
  if (!actual || typeof actual !== 'object') throw Error(reason);
  for (const field of fields) if (original[field] !== undefined && !same(actual[field], original[field])) {
    // Hex case is not economic information; every numeric encoding is otherwise exact.
    if (typeof original[field] !== 'string' || lower(actual[field]) !== lower(original[field])) throw Error(reason);
  }
}

export function validateArchiveContext(entry, row, transaction, receipt, block, validators) {
  const number = Number(validators.freshInteger(entry.transaction.blockNumber));
  if (number !== Number(row.block_number) || lower(row.tx_hash) !== lower(entry.transaction.hash)
    || lower(row.block_hash) !== lower(entry.transaction.blockHash) || Number(row.transaction_index) !== Number(validators.freshInteger(entry.transaction.transactionIndex))) throw Error('captured_context_invalid');
  if (!block || Number(validators.freshInteger(block.number)) !== number || lower(block.hash) !== lower(row.block_hash)
    || lower(block.parentHash) !== lower(row.parent_hash) || Number(validators.freshInteger(block.timestamp)) * 1000 !== new Date(row.occurred_at).getTime()
    || !Array.isArray(block.transactions) || lower(block.transactions[Number(row.transaction_index)]) !== lower(row.tx_hash)) throw Error('archive_block_mismatch');
  requireMatchingFields(transaction, entry.transaction, txFields, 'archive_transaction_mismatch');
  if (!hex(entry.transaction.input) || !hex(transaction.input)) throw Error('archive_transaction_mismatch');
  validators.validateFreshReceipt(receipt, transaction, { ...block, transactions: [] });
  requireMatchingFields(receipt, entry.receipt, receiptFields, 'archive_receipt_mismatch');
  if (!same(receipt.logs, entry.receipt.logs)) throw Error('archive_receipt_mismatch');
  if (receipt.status !== '0x1') throw Error('archive_failed_transaction');
}

/** Retain the raw trace as well as the normal bounded decoder projection. */
export function validateArchiveCallTree(raw, entry, validators) {
  const value = validators.validateFreshTrace(raw);
  if (!validators.freshTraceMatchesTransaction(value, entry.transaction)) throw Error('archive_trace_root_mismatch');
  // Geth cdb7548b callFrame.Output is `json:"output,omitempty"`; successful
  // empty returndata is absent, while any returned bytes must remain valid.
  // https://github.com/bnb-chain/bsc/blob/cdb7548b/eth/tracers/native/call.go#L45-L59
  if (lower(raw.input) !== lower(entry.transaction.input) || raw.output !== undefined && !hex(raw.output)
    || validators.freshInteger(raw.gasUsed) !== validators.freshInteger(entry.receipt.gasUsed)) throw Error('archive_trace_execution_mismatch');
  if (entry.transaction.to === null && (!validators.freshAddress(entry.receipt.contractAddress) || lower(raw.to) !== lower(entry.receipt.contractAddress))) throw Error('archive_trace_execution_mismatch');
  const types = new Set(['CALL', 'STATICCALL', 'DELEGATECALL', 'CALLCODE', 'CREATE', 'CREATE2', 'SELFDESTRUCT']);
  const fields = new Set(['type', 'from', 'to', 'value', 'gas', 'gasUsed', 'input', 'output', 'error', 'revertReason', 'calls']);
  let count = 0;
  const visit = (call, depth) => {
    if (++count > 5000 || depth > 32 || !types.has(String(call.type).toUpperCase()) || Object.keys(call).some(key => !fields.has(key))) throw Error('archive_trace_incomplete');
    if (call.error !== undefined && (typeof call.error !== 'string' || !call.error)
      || call.revertReason !== undefined && typeof call.revertReason !== 'string'
      || call.revertReason && !call.error) throw Error('archive_trace_error_invalid');
    if ((!['CREATE', 'CREATE2'].includes(call.type.toUpperCase()) || !call.error) && !validators.freshAddress(call.to)) throw Error('archive_trace_incomplete');
    if (call.type.toUpperCase() !== 'SELFDESTRUCT') {
      if (!hex(call.input) || call.output !== undefined && !hex(call.output)) throw Error('archive_trace_incomplete');
      validators.freshInteger(call.gas); validators.freshInteger(call.gasUsed);
    }
    for (const child of call.calls ?? []) visit(child, depth + 1);
  };
  visit(raw, 0); return value;
}

export const historicalTraceCandidatesSql = `WITH candidates AS MATERIALIZED(SELECT e.tx_hash,e.block_hash,e.block_number,e.transaction_index,e.payload,e.wallet_addresses,e.expires_at,b.parent_hash,b.occurred_at,
 ARRAY(SELECT k.wallet_address FROM fresh.kols k JOIN fresh.wallets w ON w.address=k.wallet_address
 JOIN fresh.accounting_scopes s ON s.id='kol:'||k.wallet_address AND s.kind='kol' AND s.active AND k.wallet_address=ANY(s.wallet_addresses)
 WHERE k.is_tracked AND w.active AND k.wallet_address=ANY(e.wallet_addresses) AND s.starts_block<=e.block_number AND s.starts_at<=b.occurred_at AND w.monitoring_from_block<=e.block_number
 AND (w.monitoring_to_block IS NULL OR w.monitoring_to_block>=e.block_number) ORDER BY k.wallet_address) AS public_wallets
 FROM fresh.recent_evidence e JOIN fresh.recent_blocks b USING(block_number,block_hash)
 WHERE e.decoder_status IN('pending','repair') AND e.expires_at>now() AND e.block_number>$1 AND ($3::text IS NULL OR e.tx_hash=$3)
 AND e.last_error ~ '(^|,)(trade_value_unavailable|incoming_transfer_cost_unknown|outgoing_transfer_value_unknown|native_message_fee_unverified|native_payout_mismatch|unsupported_smart_account_operation)(,|$)'
 AND (e.block_number,e.transaction_index,e.tx_hash)>($4::bigint,$5::integer,$6::text)
 AND EXISTS(SELECT 1 FROM fresh.kols k JOIN fresh.wallets w ON w.address=k.wallet_address
 JOIN fresh.accounting_scopes s ON s.id='kol:'||k.wallet_address AND s.kind='kol' AND s.active AND k.wallet_address=ANY(s.wallet_addresses) WHERE k.is_tracked AND w.active
 AND k.wallet_address=ANY(e.wallet_addresses) AND s.starts_block<=e.block_number AND s.starts_at<=b.occurred_at AND w.monitoring_from_block<=e.block_number AND (w.monitoring_to_block IS NULL OR w.monitoring_to_block>=e.block_number))
 ORDER BY e.block_number,e.transaction_index,e.tx_hash LIMIT $2), budgeted AS(SELECT *,sum(pg_column_size(payload)) OVER(ORDER BY block_number,transaction_index,tx_hash) AS payload_bytes FROM candidates)
 SELECT * FROM budgeted WHERE payload_bytes<=16777216 ORDER BY block_number,transaction_index,tx_hash`;

function requirePublicCandidate(row, entry, now) {
  if (!Array.isArray(row.public_wallets) || !row.public_wallets.length || row.public_wallets.some(wallet => !entry.wallets.includes(wallet))
    || !same([...row.wallet_addresses].sort(), [...entry.wallets].sort()) || new Date(row.expires_at).getTime() <= now) throw Error('archive_public_candidate_required');
}

function validateLocalEntry(entry, row, validators) {
  if (lower(entry.transaction.hash) !== lower(row.tx_hash) || lower(entry.transaction.blockHash) !== lower(row.block_hash)
    || Number(validators.freshInteger(entry.transaction.blockNumber)) !== Number(row.block_number)
    || Number(validators.freshInteger(entry.transaction.transactionIndex)) !== Number(row.transaction_index) || !hex(entry.transaction.input)) throw Error('captured_context_invalid');
  validators.validateFreshReceipt(entry.receipt, entry.transaction, { number: entry.transaction.blockNumber, hash: row.block_hash,
    parentHash: row.parent_hash, timestamp: `0x${Math.floor(new Date(row.occurred_at).getTime()/1000).toString(16)}`, transactions: [] });
}

export async function fetchHistoricalTrace(transport, row, entry, validators) {
  validateLocalEntry(entry, row, validators);
  const number = entry.transaction.blockNumber;
  if (validators.freshInteger(await transport.rpc('eth_chainId', [])) !== 56n) throw Error('archive_wrong_chain');
  const read = async () => {
    // Sequential on purpose: one bounded provider request at a time.
    const transaction = await transport.rpc('eth_getTransactionByHash', [entry.transaction.hash]);
    const receipt = await transport.rpc('eth_getTransactionReceipt', [entry.transaction.hash]);
    const block = await transport.rpc('eth_getBlockByNumber', [number, false]);
    validateArchiveContext(entry, row, transaction, receipt, block, validators);
    return { transaction, receipt, block };
  };
  const before = await read();
  const traceRequest = { method: 'debug_traceTransaction', params: [entry.transaction.hash, { tracer: 'callTracer', timeout: '3s', reexec: 0, tracerConfig: { onlyTopCall: false, withLog: false } }] };
  const raw = await transport.rpc(traceRequest.method, traceRequest.params);
  const trace = validateArchiveCallTree(raw, entry, validators), after = await read();
  if (!same(before, after)) throw Error('archive_canonical_context_changed');
  return { trace, raw, before, after, traceRequest };
}

async function exclusiveJson(directory, prefix, value) {
  await mkdir(directory, { recursive: true });
  const bytes = Buffer.from(JSON.stringify(value)), digest = hash(bytes), filename = resolve(directory, `${prefix}-${randomUUID()}.json`);
  const file = await open(filename, 'wx', 0o600);
  try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
  if (hash(await readFile(filename)) !== digest) throw Error('archive_artifact_verification_failed');
  return { path: filename, sha256: digest, bytes: bytes.length };
}

async function boundary(db) {
  const row = (await db.query("SELECT block_number::text,block_hash,value FROM fresh.checkpoints WHERE key='start'")).rows[0];
  if (!row || Number(row.block_number) !== EXPECTED_BOUNDARY || row.block_hash !== EXPECTED_BOUNDARY_HASH) throw Error('archive_boundary_mismatch');
  return row;
}

export async function applyHistoricalTrace(db, selected, recovered, provenance, validators, verifySource, expectedBoundary) {
  if (await verifySource() !== EXPECTED_SOURCE) throw Error('archive_source_changed');
  const client = await db.connect();
  try {
    await client.query('BEGIN'); await client.query('SET LOCAL lock_timeout=\'10s\'');
    await client.query('SELECT pg_advisory_xact_lock(73621941)');
    if (!same(await boundary(client), expectedBoundary)) throw Error('archive_boundary_changed');
    const canonical = (await client.query('SELECT block_hash,parent_hash,occurred_at FROM fresh.recent_blocks WHERE block_number=$1 FOR SHARE', [selected.block_number])).rows[0];
    if (!canonical || canonical.block_hash !== selected.block_hash || canonical.parent_hash !== selected.parent_hash || new Date(canonical.occurred_at).getTime() !== new Date(selected.occurred_at).getTime()) throw Error('archive_canonical_changed');
    const row = (await client.query('SELECT payload,wallet_addresses,decoder_status,expires_at FROM fresh.recent_evidence WHERE tx_hash=$1 AND block_hash=$2 AND expires_at>now() FOR UPDATE', [selected.tx_hash, selected.block_hash])).rows[0];
    if (!row || !['pending', 'repair'].includes(row.decoder_status)) throw Error('archive_receipt_changed');
    const active = (await client.query(`SELECT k.wallet_address FROM fresh.kols k JOIN fresh.wallets w ON w.address=k.wallet_address
      JOIN fresh.accounting_scopes s ON s.id='kol:'||k.wallet_address AND s.kind='kol' AND s.active AND k.wallet_address=ANY(s.wallet_addresses)
      WHERE k.is_tracked AND w.active AND k.wallet_address=ANY($1::text[]) AND w.monitoring_from_block<=$2
      AND s.starts_block<=$2 AND s.starts_at<=$3::timestamptz
      AND (w.monitoring_to_block IS NULL OR w.monitoring_to_block>=$2) ORDER BY k.wallet_address FOR SHARE OF k,w,s`, [selected.public_wallets, selected.block_number, selected.occurred_at])).rows.map(value => value.wallet_address);
    if (!same(active, selected.public_wallets)) throw Error('archive_wallet_changed');
    const latest = validators.decodeFreshEvidence(row.payload), original = validators.decodeFreshEvidence(selected.payload);
    requirePublicCandidate({ ...selected, ...row, public_wallets: active }, latest, Date.now());
    if (context(latest) !== context(original)) throw Error('archive_original_context_changed');
    // A saved tree alone is insufficient: certify only the actual complete
    // callTracer request bracketed by original canonical provider contexts.
    const expectedRequest = { method: 'debug_traceTransaction', params: [latest.transaction.hash, { tracer: 'callTracer', timeout: '3s', reexec: 0, tracerConfig: { onlyTopCall: false, withLog: false } }] };
    if (!same(recovered.traceRequest, expectedRequest) || !same(recovered.before, recovered.after)) throw Error('archive_complete_trace_context_missing');
    for (const bracket of [recovered.before, recovered.after]) validateArchiveContext(latest, selected, bracket?.transaction, bracket?.receipt, bracket?.block, validators);
    const trace = validateArchiveCallTree(recovered.raw, latest, validators);
    if (typeof validators.certifyFreshCompleteCallTrace !== 'function') throw Error('archive_complete_trace_validator_missing');
    const completeTraceProof = validators.certifyFreshCompleteCallTrace(latest, recovered.raw, recovered.traceRequest, 'operator_archive');
    if (latest.trace) {
      if (!same(validators.validateFreshTrace(latest.trace), trace)) throw Error('archive_existing_trace_conflict');
      await client.query('ROLLBACK'); return false;
    }
    if (latest.traceArchiveRecovery) throw Error('archive_existing_provenance_conflict');
    const payload = validators.encodeFreshEvidence({ ...latest, trace, completeTraceProof, traceArchiveRecovery: provenance });
    if (await verifySource() !== EXPECTED_SOURCE) throw Error('archive_source_changed');
    const updated = await client.query(`UPDATE fresh.recent_evidence SET payload=$3,decoder_status='pending'
      WHERE tx_hash=$1 AND block_hash=$2 AND payload=$4 AND expires_at>now()`, [selected.tx_hash, selected.block_hash, payload, row.payload]);
    if (updated.rowCount !== 1) throw Error('archive_payload_changed');
    // Existing last_error, firstFailure, state, recovery proofs and receipt bodies remain unchanged.
    await client.query('COMMIT'); return true;
  } catch (error) { await client.query('ROLLBACK');
    // Keep the verified artifact reusable when the normal decoder owns the lock.
    // This is local apply contention, not a reason to refetch the provider trace.
    if (error?.code === '55P03') throw Error('archive_apply_lock_timeout');
    throw error;
  } finally { client.release(); }
}

export async function recoverHistoricalTraces(options) {
  const { db, validators, verifySource } = options, now = options.now ?? Date.now(), limit = options.limit ?? 1;
  if (!Number.isInteger(limit) || limit < 1 || limit > 32) throw Error('archive_limit_invalid');
  if (options.transaction && !/^0x[0-9a-f]{64}$/i.test(options.transaction)) throw Error('archive_transaction_filter_invalid');
  const cursor = options.after ? parseCursor(options.after) : [EXPECTED_BOUNDARY, -1, ''];
  const beforeSource = await verifySource(); if (beforeSource !== EXPECTED_SOURCE) throw Error('archive_source_mismatch');
  const beforeBoundary = await boundary(db);
  const report = { version: 1, at: new Date(now).toISOString(), mode: options.apply ? 'apply' : 'dry_run', sourceDigest: beforeSource,
    boundary: beforeBoundary, status: options.transport ? 'completed' : 'setup_required', sourceHost: options.transport?.hostname ?? null,
    limit, scanned: 0, selected: 0, skippedExisting: 0, nextCursor: options.after ?? null, validated: 0, applied: 0, financialWrites: 0, results: [] };
  if (options.transport) {
    const rows = (await db.query(historicalTraceCandidatesSql, [EXPECTED_BOUNDARY, 256, options.transaction?.toLowerCase() ?? null, ...cursor])).rows;
    for (const row of rows) {
      if (report.selected >= limit) break;
      report.scanned++; report.nextCursor = `${row.block_number}:${row.transaction_index}:${row.tx_hash}`;
      const result = { transactionHash: row.tx_hash, blockHash: row.block_hash, status: 'unavailable' };
      try {
        const entry = validators.decodeFreshEvidence(row.payload); requirePublicCandidate(row, entry, now);
        if (entry.trace) { report.skippedExisting++; continue; }
        report.selected++;
        const recovered = await fetchHistoricalTrace(options.transport, row, entry, validators);
        const canonical = (await db.query('SELECT block_hash,parent_hash,occurred_at FROM fresh.recent_blocks WHERE block_number=$1', [row.block_number])).rows[0];
        if (!canonical || canonical.block_hash !== row.block_hash || canonical.parent_hash !== row.parent_hash || new Date(canonical.occurred_at).getTime() !== new Date(row.occurred_at).getTime()) throw Error('archive_canonical_changed');
        if (await verifySource() !== beforeSource) throw Error('archive_source_changed');
        const artifact = await exclusiveJson(options.directory, 'raw-trace', { version: 1, kind: 'operator_archive_call_tracer', sourceHost: options.transport.hostname,
          sourceDigest: beforeSource, boundary: beforeBoundary, at: report.at, traceConfig: { tracer: 'callTracer', timeout: '3s', reexec: 0, onlyTopCall: false, withLog: false }, ...recovered });
        const provenance = { version: 1, kind: 'operator_archive_call_tracer', sourceHost: options.transport.hostname,
          artifactSha256: artifact.sha256, observedAt: report.at, transactionHash: row.tx_hash, blockHash: row.block_hash };
        result.artifact = artifact; result.originalPayloadSha256 = hash(row.payload); result.originalContextSha256 = hash(context(entry)); result.status = 'validated'; report.validated++;
        if (options.apply) { const applied = await applyHistoricalTrace(db, row, recovered, provenance, validators, verifySource, beforeBoundary);
          result.status = applied ? 'applied' : 'existing_trace'; report.applied += Number(applied); }
      } catch (error) { result.reason = safeError(error);
        if (result.reason === 'archive_rate_limited') { report.status = 'cooldown'; report.retryAfterSeconds = error.retryAfterSeconds ?? null; report.results.push(result); break; } }
      report.results.push(result);
    }
  }
  report.afterSourceDigest = await verifySource(); report.afterBoundary = await boundary(db);
  if (report.afterSourceDigest !== beforeSource || !same(report.afterBoundary, beforeBoundary)) throw Error('archive_final_guard_changed');
  report.reportArtifact = await exclusiveJson(options.directory, 'recovery-report', { ...report });
  return report;
}

function parseCursor(value) {
  const match = /^(\d+):(\d+):(0x[0-9a-f]{64})$/i.exec(value ?? '');
  if (!match || !Number.isSafeInteger(Number(match[1])) || Number(match[1]) < EXPECTED_BOUNDARY || !Number.isSafeInteger(Number(match[2])) || Number(match[2]) > 1000000) throw Error('archive_cursor_invalid');
  return [Number(match[1]), Number(match[2]), match[3].toLowerCase()];
}

export function parseRecoveryArguments(args) {
  let apply = false, limit = 1, transaction, after;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--apply') apply = true;
    else if (args[index] === '--dry-run') apply = false;
    else if (args[index] === '--limit' && /^\d+$/.test(args[index + 1] ?? '')) limit = Number(args[++index]);
    else if (args[index] === '--transaction' && /^0x[0-9a-f]{64}$/i.test(args[index + 1] ?? '')) transaction = args[++index].toLowerCase();
    else if (args[index] === '--after' && args[index + 1]) { after = args[++index]; parseCursor(after); }
    else throw Error('archive_arguments_invalid');
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 32) throw Error('archive_limit_invalid');
  return { apply, limit, ...(transaction ? { transaction } : {}), ...(after ? { after } : {}) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let db;
  try {
    const destination = new URL(process.env.DATABASE_URL ?? '');
    if (!['127.0.0.1', 'localhost'].includes(destination.hostname) || destination.port !== '5436' || destination.pathname !== '/kollens_fresh_20261022_24h') throw Error('archive_local_database_required');
    const [{ default: pg }, validators, { freshRuntimeDigest }] = await Promise.all([import('pg'), loadRecoveryValidators(), import('../../server/fresh/runtime.ts')]);
    db = new pg.Pool({ connectionString: destination.href, max: 1 });
    const result = await recoverHistoricalTraces({ ...parseRecoveryArguments(process.argv.slice(2)), db, validators, verifySource: freshRuntimeDigest,
      transport: createArchiveRpc(process.env.FRESH_TRACE_ARCHIVE_RPC_URL), directory: resolve('.cache/fresh/private/trace-recovery-20261023') });
    console.log(JSON.stringify(result));
  } catch (error) { console.error(JSON.stringify({ status: 'unavailable', reason: safeError(error) })); process.exitCode = 1; }
  finally { await db?.end(); }
}

// Controlled operator review pause: finish this batch before the synthetic-distribution fix.
// Controlled operator review pause: finish current batch before dated-current-quote retention correction.
