import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import * as capture from './capture.js';
import * as trace from './trace.js';
import { certifyFreshCompleteCallTrace, validFreshCompleteCallTrace } from './passiveIncoming.js';
// The operator-only .mjs is deliberately outside the runtime fingerprint.
// @ts-expect-error local standalone JavaScript tooling has no public declaration file
import { EXPECTED_SOURCE, EXPECTED_BOUNDARY, EXPECTED_BOUNDARY_HASH, archiveEndpoint, createArchiveRpc, fetchHistoricalTrace, recoverHistoricalTraces, parseRecoveryArguments, historicalTraceCandidatesSql } from '../../scripts/fresh/recover-historical-traces.mjs';

const validators = { ...capture, ...trace, certifyFreshCompleteCallTrace }, directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
const hash = (digit: string) => `0x${digit.repeat(64)}`, address = (digit: string) => `0x${digit.repeat(40)}`;
async function directory() { const value = await mkdtemp(join(tmpdir(), 'fresh-trace-test-')); directories.push(value); return value; }
function fixture() {
  const block = EXPECTED_BOUNDARY + 20, at = new Date('2026-10-23T21:00:00.000Z'), wallet = address('a'), to = address('b');
  const transaction = { hash: hash('1'), blockHash: hash('2'), blockNumber: `0x${block.toString(16)}`, transactionIndex: '0x0', from: wallet, to,
    value: '0x64', input: '0x1234', type: '0x4', nonce: '0x3', gas: '0x10000', gasPrice: '0x5', chainId: '0x38',
    authorizationList: [{ chainId: '0x38', address: address('c'), nonce: '0x4', yParity: '0x0', r: hash('4'), s: hash('5') }] };
  const receipt = { transactionHash: transaction.hash, transactionIndex: '0x0', blockHash: transaction.blockHash, blockNumber: transaction.blockNumber,
    status: '0x1', gasUsed: '0x5208', effectiveGasPrice: '0x5', logs: [{ address: to, topics: [hash('6')], data: '0x', logIndex: '0x0',
      transactionHash: transaction.hash, transactionIndex: '0x0', blockNumber: transaction.blockNumber, blockHash: transaction.blockHash }] };
  const entry = { transaction, receipt, wallets: [wallet], observedAt: at.toISOString(), stateEvidence: { version: 1, blockNumber: block, blockHash: transaction.blockHash, calls: [] },
    recoveryEvidence: { retained: 'original' }, decodeDiagnostics: { firstFailure: { at: 'original', reason: 'trade_value_unavailable' } } } as unknown as capture.FreshCapturedReceipt;
  const row = { tx_hash: transaction.hash, block_hash: transaction.blockHash, block_number: block, transaction_index: 0,
    payload: capture.encodeFreshEvidence(entry), wallet_addresses: [wallet], public_wallets: [wallet], decoder_status: 'repair', expires_at: new Date('2026-10-26T21:00:00.000Z'),
    parent_hash: hash('3'), occurred_at: at };
  const remoteBlock = { number: transaction.blockNumber, hash: transaction.blockHash, parentHash: row.parent_hash, timestamp: `0x${(at.getTime()/1000).toString(16)}`, transactions: [transaction.hash] };
  const raw = { type: 'CALL', from: wallet, to, value: '0x64', gas: transaction.gas, gasUsed: receipt.gasUsed, input: transaction.input, output: '0x',
    calls: [{ type: 'CALL', from: to, to: wallet, value: '0xa', gas: '0x6000', gasUsed: '0x100', input: '0x', output: '0x' }] };
  const boundary = { block_number: String(EXPECTED_BOUNDARY), block_hash: EXPECTED_BOUNDARY_HASH, value: { startTime: '2026-10-22T00:00:00Z' } };
  return { row, entry, raw, remoteBlock, boundary, at };
}
function transport(f = fixture(), mutate?: (method: string, value: any, index: number) => any) {
  const calls: string[] = []; let blocks = 0;
  return { hostname: 'archive.example', calls, async rpc(method: string) {
    calls.push(method); let value: any;
    if (method === 'eth_chainId') value = '0x38';
    else if (method === 'eth_getTransactionByHash') value = structuredClone(f.entry.transaction);
    else if (method === 'eth_getTransactionReceipt') value = structuredClone(f.entry.receipt);
    else if (method === 'eth_getBlockByNumber') { value = structuredClone(f.remoteBlock); blocks++; }
    else if (method === 'debug_traceTransaction') value = structuredClone(f.raw);
    else throw Error('unexpected_method');
    return mutate ? mutate(method, value, blocks) : value;
  } };
}
function database(f = fixture(), options: { reorg?: boolean; privateOnly?: boolean; alterLatest?: (entry: any) => void } = {}) {
  const queries: { sql: string; args?: any[] }[] = []; let payload = f.row.payload;
  const db: any = { queries, get payload() { return payload; }, async query(sql: string, args?: any[]) {
    queries.push({ sql, args });
    if (sql.includes("WHERE key='start'")) return { rows: [f.boundary] };
    if (sql === historicalTraceCandidatesSql) return { rows: [{ ...f.row, public_wallets: options.privateOnly ? [] : f.row.public_wallets }] };
    if (sql.includes('FROM fresh.recent_blocks')) return { rows: [{ block_hash: options.reorg ? hash('8') : f.row.block_hash, parent_hash: f.row.parent_hash, occurred_at: f.row.occurred_at }] };
    if (sql.startsWith('SELECT payload')) {
      let latest = capture.decodeFreshEvidence(payload); options.alterLatest?.(latest); payload = capture.encodeFreshEvidence(latest);
      return { rows: [{ payload, wallet_addresses: f.row.wallet_addresses, decoder_status: 'repair', expires_at: f.row.expires_at }] };
    }
    if (sql.includes('SELECT k.wallet_address')) return { rows: options.privateOnly ? [] : f.row.public_wallets.map(wallet_address => ({ wallet_address })) };
    if (sql.includes('UPDATE fresh.recent_evidence')) { if (!Buffer.from(args![3]).equals(payload)) return { rows: [], rowCount: 0 }; payload = args![2]; return { rows: [], rowCount: 1 }; }
    return { rows: [], rowCount: 0 };
  }, async connect() { return { query: db.query, release() {} }; } };
  return db;
}

describe('operator historical trace recovery', () => {
  it('defaults to a bounded dry run and rejects arbitrary arguments or endpoints', () => {
    expect(parseRecoveryArguments([])).toEqual({ apply: false, limit: 1 });
    expect(parseRecoveryArguments(['--apply', '--limit', '32', '--transaction', hash('1')])).toEqual({ apply: true, limit: 32, transaction: hash('1') });
    for (const args of [['--limit', '0'], ['--limit', '33'], ['--url', 'https://secret'], ['--transaction', 'bad']]) expect(() => parseRecoveryArguments(args)).toThrow();
    expect(archiveEndpoint(undefined)).toBeNull();
    for (const value of ['http://archive.example/key', 'https://user:secret@archive.example', 'file:///tmp/a']) expect(() => archiveEndpoint(value)).toThrow('archive_url_invalid');
  });

  it('requires setup without querying candidates or contacting any provider', async () => {
    const f = fixture(), db = database(f), out = await directory();
    const report = await recoverHistoricalTraces({ db, validators, verifySource: async () => EXPECTED_SOURCE, transport: null, directory: out, now: f.at.getTime() });
    expect(report.status).toBe('setup_required'); expect(report.applied).toBe(0);
    expect(db.queries.some((query: any) => query.sql === historicalTraceCandidatesSql)).toBe(false);
  });

  it('retains an actual complete raw tree and checksum artifact without applying by default', async () => {
    const f = fixture(), db = database(f), remote = transport(f), out = await directory();
    const report = await recoverHistoricalTraces({ db, validators, verifySource: async () => EXPECTED_SOURCE, transport: remote, directory: out, now: f.at.getTime() });
    expect(report.validated).toBe(1); expect(report.applied).toBe(0); expect(report.financialWrites).toBe(0);
    expect(remote.calls).toEqual(['eth_chainId', 'eth_getTransactionByHash', 'eth_getTransactionReceipt', 'eth_getBlockByNumber', 'debug_traceTransaction', 'eth_getTransactionByHash', 'eth_getTransactionReceipt', 'eth_getBlockByNumber']);
    const artifact = report.results[0].artifact, body = await readFile(artifact.path);
    expect(createHash('sha256').update(body).digest('hex')).toBe(artifact.sha256);
    expect(JSON.parse(body.toString()).raw).toEqual(f.raw);
    expect(JSON.stringify(report)).not.toContain('https://'); expect(db.payload.equals(f.row.payload)).toBe(true);
    expect(db.queries.every((query: any) => !/UPDATE|INSERT|DELETE/i.test(query.sql))).toBe(true);
  });

  it('applies only trace/provenance and pending status while preserving concurrent state and first failure', async () => {
    const f = fixture(), db = database(f, { alterLatest: entry => { entry.recoveryEvidence.concurrent = 'kept'; } }), out = await directory();
    const report = await recoverHistoricalTraces({ db, validators, verifySource: async () => EXPECTED_SOURCE, transport: transport(f), directory: out, now: f.at.getTime(), apply: true });
    expect(report.applied).toBe(1);
    const entry = capture.decodeFreshEvidence(db.payload) as any;
    expect(entry.transaction).toEqual(f.entry.transaction); expect(entry.receipt).toEqual(f.entry.receipt);
    expect(entry.stateEvidence).toEqual(f.entry.stateEvidence); expect(entry.decodeDiagnostics).toEqual(f.entry.decodeDiagnostics);
    expect(entry.recoveryEvidence).toEqual({ retained: 'original', concurrent: 'kept' });
    expect(entry.trace).toEqual(trace.validateFreshTrace(f.raw)); expect(entry.traceArchiveRecovery.sourceHost).toBe('archive.example');
    expect(entry.completeTraceProof).toMatchObject({ source: 'operator_archive', transactionHash: f.entry.transaction.hash,
      blockHash: f.entry.receipt.blockHash, method: 'debug_traceTransaction', tracer: 'callTracer', onlyTopCall: false, withLog: false });
    expect(validFreshCompleteCallTrace(entry, entry.trace)).toBe(true);
    expect(validFreshCompleteCallTrace(entry, { ...entry.trace, input: '0x1235' })).toBe(false);
    expect(db.queries.some((q: any) => q.sql.includes('pg_advisory_xact_lock(73621941)'))).toBe(true);
    const writes = db.queries.filter((q: any) => /^UPDATE|^INSERT|^DELETE/.test(q.sql));
    expect(writes).toHaveLength(1); expect(writes[0].sql).toContain("decoder_status='pending'"); expect(writes[0].sql).toContain('payload=$4');
    expect(db.queries.some((q: any) => /financial_events|positions|open_lots|scope_event_results|UPDATE fresh.kols/.test(q.sql))).toBe(false);
  });

  it.each(['chain', 'nonce', 'auth', 'input', 'receipt_logs', 'root', 'truncated', 'reorg'])('rejects %s disagreement before artifact approval', async kind => {
    const f = fixture(), remote = transport(f, (method, value, index) => {
      if (kind === 'chain' && method === 'eth_chainId') return '0x1';
      if (method === 'eth_getTransactionByHash') {
        if (kind === 'nonce') value.nonce = '0x5';
        if (kind === 'auth') value.authorizationList[0].address = address('d');
        if (kind === 'input') value.input = '0x1235';
      }
      if (kind === 'receipt_logs' && method === 'eth_getTransactionReceipt') value.logs[0].data = '0x01';
      if (method === 'debug_traceTransaction') { if (kind === 'root') value.from = address('d'); if (kind === 'truncated') value.calls[0].truncated = true; }
      if (kind === 'reorg' && method === 'eth_getBlockByNumber' && index === 2) value.hash = hash('8');
      return value;
    });
    await expect(fetchHistoricalTrace(remote, f.row, f.entry, validators)).rejects.toThrow();
  });

  it.each([true, { code: 'failed' }, '', null])('rejects malformed child execution error %s', async error => {
    const f = fixture(), remote = transport(f, (method, value) => {
      if (method === 'debug_traceTransaction') value.calls[0].error = error;
      return value;
    });
    await expect(fetchHistoricalTrace(remote, f.row, f.entry, validators)).rejects.toThrow(/archive_trace_error_invalid|trace_bounds_invalid/);
  });

  it('rejects malformed root errors and an unmarked child revert reason', async () => {
    const f = fixture();
    for (const root of [false, true]) {
      const remote = transport(f, (method, value) => { if (method === 'debug_traceTransaction') {
        if (root) value.error = true; else value.calls[0].revertReason = 'unmarked revert';
      } return value; });
      await expect(fetchHistoricalTrace(remote, f.row, f.entry, validators)).rejects.toThrow(/archive_trace_error_invalid|trace_bounds_invalid/);
    }
  });

  it('skips already traced candidates, bounds scanning, and returns an explicit resume cursor', async () => {
    const f = fixture(), db = database(f), out = await directory(), original = db.query;
    const traced = structuredClone(f.entry); traced.transaction.hash = hash('7'); traced.receipt.transactionHash = hash('7'); traced.receipt.logs.forEach(log => { log.transactionHash = hash('7'); }); traced.trace = trace.validateFreshTrace(f.raw);
    db.query = async (sql: string, args: any[]) => sql === historicalTraceCandidatesSql
      ? { rows: [{ ...f.row, tx_hash: hash('7'), payload: capture.encodeFreshEvidence(traced) }, f.row] } : original(sql, args);
    const report = await recoverHistoricalTraces({ db, validators, verifySource: async () => EXPECTED_SOURCE, transport: transport(f), directory: out, now: f.at.getTime(), limit: 1 });
    expect(report.scanned).toBe(2); expect(report.skippedExisting).toBe(1); expect(report.selected).toBe(1); expect(report.validated).toBe(1);
    expect(report.nextCursor).toBe(`${f.row.block_number}:0:${f.row.tx_hash}`);
    expect(parseRecoveryArguments(['--after', report.nextCursor])).toEqual({ apply: false, limit: 1, after: report.nextCursor });
    expect(historicalTraceCandidatesSql).toContain('LIMIT $2'); expect(historicalTraceCandidatesSql).toContain('payload_bytes<=16777216');
    expect(historicalTraceCandidatesSql).toContain('trade_value_unavailable'); expect(historicalTraceCandidatesSql).toContain('(e.block_number,e.transaction_index,e.tx_hash)>');
  });

  it('rejects missing destinations on successful children rather than dropping native payouts', async () => {
    const f = fixture(), remote = transport(f, (method, value) => { if (method === 'debug_traceTransaction') delete value.calls[0].to; return value; });
    await expect(fetchHistoricalTrace(remote, f.row, f.entry, validators)).rejects.toThrow('archive_trace_incomplete');
  });

  it('accepts omitted successful empty root returndata but rejects present malformed output and gas disagreement', async () => {
    const f = fixture(), empty = transport(f, (method, value) => { if (method === 'debug_traceTransaction') delete value.output; return value; });
    const accepted=(await fetchHistoricalTrace(empty, f.row, f.entry, validators)).trace,expected=trace.validateFreshTrace(f.raw);delete expected.output;
    expect(accepted).toEqual(expected);expect(accepted.output).toBeUndefined();
    expect(trace.freshNativeDelta(accepted,f.entry.transaction.from)).toBe(trace.freshNativeDelta(trace.validateFreshTrace(f.raw),f.entry.transaction.from));
    for (const malformed of [null, true, '0x123', 'not bytes']) {
      const remote = transport(f, (method, value) => { if (method === 'debug_traceTransaction') value.output = malformed; return value; });
      await expect(fetchHistoricalTrace(remote, f.row, f.entry, validators)).rejects.toThrow(/archive_trace_execution_mismatch|trace_data_bounds_invalid/);
    }
    const wrongGas = transport(f, (method, value) => { if (method === 'debug_traceTransaction') value.gasUsed = '0x5207'; return value; });
    await expect(fetchHistoricalTrace(wrongGas, f.row, f.entry, validators)).rejects.toThrow('archive_trace_execution_mismatch');
  });

  it('does not send a private-only or mismatched captured transaction to the provider', async () => {
    const f = fixture(), remote = transport(f), db = database(f, { privateOnly: true }), out = await directory();
    const report = await recoverHistoricalTraces({ db, validators, verifySource: async () => EXPECTED_SOURCE, transport: remote, directory: out, now: f.at.getTime() });
    expect(remote.calls).toHaveLength(0); expect(report.results[0].reason).toBe('archive_public_candidate_required');
    const wrong = structuredClone(f.entry); wrong.transaction.hash = hash('8');
    await expect(fetchHistoricalTrace(remote, f.row, wrong, validators)).rejects.toThrow('captured_context_invalid'); expect(remote.calls).toHaveLength(0);
  });

  it('refuses local reorgs and conflicting traces without touching original evidence', async () => {
    const f = fixture(), out = await directory();
    const db = database(f, { reorg: true });
    const report = await recoverHistoricalTraces({ db, validators, verifySource: async () => EXPECTED_SOURCE, transport: transport(f), directory: out, now: f.at.getTime(), apply: true });
    expect(report.results[0].reason).toBe('archive_canonical_changed'); expect(db.payload.equals(f.row.payload)).toBe(true);
    const conflicting = database(f, { alterLatest: entry => { entry.trace = { ...trace.validateFreshTrace(f.raw), calls: [] }; } });
    const result = await recoverHistoricalTraces({ db: conflicting, validators, verifySource: async () => EXPECTED_SOURCE, transport: transport(f), directory: out, now: f.at.getTime(), apply: true });
    expect(result.results[0].reason).toBe('archive_existing_trace_conflict'); expect(result.applied).toBe(0);
    expect(conflicting.queries.some((q: any) => q.sql.startsWith('UPDATE'))).toBe(false);
  });

  it('binds reports to the reviewed runtime and refuses source or boundary changes', async () => {
    const f = fixture(), out = await directory();
    await expect(recoverHistoricalTraces({ db: database(f), validators, verifySource: async () => 'a'.repeat(64), transport: null, directory: out })).rejects.toThrow('archive_source_mismatch');
    const db = database(f); f.boundary.block_number = '123';
    await expect(recoverHistoricalTraces({ db, validators, verifySource: async () => EXPECTED_SOURCE, transport: null, directory: out })).rejects.toThrow('archive_boundary_mismatch');
    expect(await readdir(out)).toHaveLength(0);
    f.boundary.block_number = String(EXPECTED_BOUNDARY); f.boundary.block_hash = hash('8');
    await expect(recoverHistoricalTraces({ db, validators, verifySource: async () => EXPECTED_SOURCE, transport: null, directory: out })).rejects.toThrow('archive_boundary_mismatch');
  });

  it('retains a verified trace artifact when a decoder lock delays local apply', async () => {
    const f = fixture(), db = database(f), original = db.query, out = await directory();
    db.query = async (sql: string, args?: any[]) => {
      if (sql.includes('pg_advisory_xact_lock')) throw Object.assign(Error('local lock wait'), { code: '55P03' });
      return original(sql, args);
    };
    const result = await recoverHistoricalTraces({ db, validators, verifySource: async () => EXPECTED_SOURCE,
      transport: transport(f), directory: out, now: f.at.getTime(), apply: true });
    expect(result.validated).toBe(1); expect(result.applied).toBe(0);
    expect(result.results[0].reason).toBe('archive_apply_lock_timeout');
    expect(result.results[0].artifact).toMatchObject({ sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect((JSON.parse(await readFile(result.results[0].artifact.path, 'utf8'))).raw).toEqual(f.raw);
    expect(db.payload.equals(f.row.payload)).toBe(true);
    expect(db.queries.some((q: any) => q.sql.startsWith('UPDATE'))).toBe(false);
  });

  it('paces one request per second and redacts endpoint paths and fetch errors', async () => {
    let now = 1000; const starts: number[] = [];
    const rpc = createArchiveRpc('https://archive.example/secret/APIKEY?token=secret', async (_url: string, init: any) => {
      starts.push(now); const body = JSON.parse(init.body); return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: '0x38' }));
    }, { now: () => now, sleep: async (ms: number) => { now += ms; } });
    await rpc.rpc('eth_chainId', []); await rpc.rpc('eth_chainId', []); expect(starts).toEqual([1000, 2000]);
    const bad = createArchiveRpc('https://archive.example/secret', async () => { throw Error('network failed for https://archive.example/secret'); }, { sleep: async () => {} });
    await expect(bad.rpc('eth_chainId', [])).rejects.toThrow('archive_recovery_unavailable');
    await expect(rpc.rpc('eth_getBalance', [])).rejects.toThrow('archive_method_denied');
  });

  it('stops on HTTP429, preserves retry timing, and enforces the response byte limit', async () => {
    let requests = 0;
    const limited = createArchiveRpc('https://archive.example/secret', async () => { requests++; return new Response('', { status: 429, headers: { 'retry-after': '37' } }); }, { sleep: async () => {} });
    await expect(limited.rpc('eth_chainId', [])).rejects.toMatchObject({ message: 'archive_rate_limited', retryAfterSeconds: 37 });
    await expect(limited.rpc('eth_chainId', [])).rejects.toThrow('archive_rate_limited'); expect(requests).toBe(1);
    const oversized = createArchiveRpc('https://archive.example/secret', async () => new Response(new Uint8Array(8 * 1024 * 1024 + 1)), { sleep: async () => {} });
    await expect(oversized.rpc('eth_chainId', [])).rejects.toThrow('archive_response_too_large');
    const f = fixture(), out = await directory(), remote = { hostname: 'archive.example', async rpc() { throw Object.assign(Error('archive_rate_limited'), { retryAfterSeconds: 37 }); } };
    const report = await recoverHistoricalTraces({ db: database(f), validators, verifySource: async () => EXPECTED_SOURCE, transport: remote, directory: out, now: f.at.getTime(), limit: 2 });
    expect(report.status).toBe('cooldown'); expect(report.retryAfterSeconds).toBe(37); expect(report.results).toHaveLength(1);
  });
});
