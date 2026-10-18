import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
import { tryLoadJournalNodeEvidence } from './journalNodeLedger.js';
import { calculateJournalLedger } from './journalLedger.js';
const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('./rpc.js', () => ({ chainRpc: rpc, blockHex: (block: string) => `0x${BigInt(block).toString(16)}` }));
const wallet = `0x${'a'.repeat(40)}`, token = `0x${'b'.repeat(40)}`, other = `0x${'c'.repeat(40)}`;
const hash = `0x${'1'.repeat(64)}`, openingHash = `0x${'2'.repeat(64)}`, endingHash = `0x${'3'.repeat(64)}`;
const timestamp = new Date('2026-10-18T00:00:00.000Z');
const proof = { walletAddress: wallet, tokenAddress: token, chain: 'bsc' as const, blockNumber: '110', blockHash: endingHash,
  blockTimestamp: timestamp.toISOString(), balance: '10', checkedAt: timestamp.toISOString() };
function fixture(options: { opening?: string; repair?: string | null; raw?: string; feePrice?: string | null; transferOnly?: boolean; from?: number; older?: boolean; sharedQuote?: boolean } = {}) {
  const trade = { id: 'buy1', tx_hash: hash, side: 'buy', token_amount: '10', amount_usd: '10', price_usd: '1', quote_amount: '0.01', quote_symbol: 'BNB', block_number: '105', block_hash: endingHash, transaction_index: 1, timestamp, sharedQuote: options.sharedQuote ?? false };
  const transfer = { id: 'raw1', tx_hash: hash, log_index: 2, delta_raw: options.raw ?? '10', kind: options.transferOnly ? 'transfer' : 'buy', block_number: '105', block_hash: endingHash, timestamp, counterparty_address: other };
  const evidence = { tx_hash: hash, block_number: '105', block_hash: endingHash, timestamp, bnb_price_usd: options.feePrice === undefined ? '1000' : options.feePrice,
    transaction: { hash, from: wallet, to: other, transactionIndex: '0x1' }, receipt: { status: '0x1', gasUsed: '0x1', effectiveGasPrice: '0x1', logs: [] } };
  const query = vi.fn(async (sql: string, _values?: unknown[]) => {
    if (sql.includes(' AS older')) return { rows: [{ older: options.older ?? false }] };
    if (sql.includes('FROM journal_wallet_coverage')) return { rows: [{ registration: '100', registration_hash: openingHash, first: String(options.from ?? 101), last: '110', confirmed: '110', repair: options.repair ?? null }] };
    if (sql.includes('FROM journal_opening_balances')) return { rows: options.opening === undefined ? [] : [{ balance_raw: options.opening, block_hash: openingHash, decimals: 0 }] };
    if (sql.includes('FROM wallet_transfers WHERE')) return { rows: [transfer] };
    if (sql.includes('SELECT e.* FROM journal_node_evidence')) return { rows: [evidence] };
    if (sql.includes('SELECT price_usd::text')) return { rows: [{ price_usd: '1' }] };
    if (sql.includes('FROM trades t WHERE t.wallet_address')) return { rows: options.transferOnly ? [] : [trade] };
    return { rows: [] };
  });
  return { query, db: { query } as unknown as Pick<PoolClient, 'query'>, trade, transfer, evidence };
}
beforeEach(() => { vi.useFakeTimers({ now: timestamp }); rpc.mockReset().mockImplementation(async (method: string) => method === 'eth_call' ? `0x${'0'.repeat(64)}` : { number: '0x64', hash: openingHash, timestamp: '0x68f2c000' }); });
afterEach(() => { vi.useRealTimers(); });
describe('durable node journal evidence', () => {
  it('calculates fully covered new positions without any GMGN dependency', async () => {
    const { db } = fixture();
    const result = await tryLoadJournalNodeEvidence(db, { wallet, token, decimals: 0 }, { balance: proof });
    expect(result?.coverage.complete).toBe(true); expect(result?.source).toBe('node');
    const ledger = calculateJournalLedger({ wallets: [wallet], events: result!.events, coverage: [result!.coverage], asOf: proof.checkedAt,
      valuations: [{ tokenAddress: token, priceUsd: '2', pricedAt: proof.checkedAt, balances: [{ walletAddress: wallet, tokenAmount: proof.balance }] }] });
    expect(ledger.complete).toBe(true); expect(ledger.positions[0].feesUsd).toBe('0.000000000000001');
    expect(ledger.totals.estimatedProfitUsd).toBe('9.999999999999999');
  });
  it('reuses the confirmed opening proof after the node prunes registration state', async () => {
    const { db } = fixture({ opening: '0' }); rpc.mockRejectedValue(new Error('pruned'));
    expect((await tryLoadJournalNodeEvidence(db, { wallet, token, decimals: 0 }, { balance: proof }))?.coverage.complete).toBe(true);
    expect(rpc).not.toHaveBeenCalled();
  });
  it('can derive a zero opening from complete permanent raw movements and ending balance', async () => {
    const { db, query } = fixture(); rpc.mockRejectedValue(new Error('pruned'));
    const result = await tryLoadJournalNodeEvidence(db, { wallet, token, decimals: 0 }, { balance: proof });
    expect(result?.coverage.complete).toBe(true);
    expect(query.mock.calls.find(([sql]) => sql.includes('INSERT INTO journal_opening_balances'))?.[1]?.[4]).toBe('0');
  });
  it('does not infer zero when raw quantities imply an older positive position', async () => {
    const { db } = fixture({ raw: '5' }); rpc.mockRejectedValue(new Error('pruned'));
    expect(await tryLoadJournalNodeEvidence(db, { wallet, token, decimals: 0 }, { balance: proof })).toBeNull();
  });
  it('requires historical acquisition recovery for a positive opening', async () => {
    const { db } = fixture({ opening: '20' });
    expect(await tryLoadJournalNodeEvidence(db, { wallet, token, decimals: 0 }, { balance: proof })).toBeNull();
  });
  it('retains lifetime realized profit and capital from known earlier closed cycles', async () => {
    const { db } = fixture({ opening: '0', older: true });
    expect(await tryLoadJournalNodeEvidence(db, { wallet, token, decimals: 0 }, { balance: { ...proof, balance: '0' } })).toBeNull();
  });
  it('starts a new tracked period despite public KOL history before registration', async () => {
    const { db, query } = fixture({ older: true });
    const startAt = new Date(timestamp.getTime() - 60_000).toISOString();
    const result = await tryLoadJournalNodeEvidence(db, { wallet, token, decimals: 0, startAt, registrationBlock: '100' }, { balance: proof });
    expect(result?.coverage.complete).toBe(true);
    expect(result?.openingBalances).toEqual([{ walletAddress: wallet, tokenAddress: token, tokenAmount: '0' }]);
    for (const [sql, parameters] of query.mock.calls.filter(([sql]) => sql.includes('$5::timestamptz'))) {
      expect(sql).toContain('timestamp >= $5'); expect(parameters?.[4]).toBe(startAt);
    }
    expect(rpc).not.toHaveBeenCalled();
  });
  it('retains pre-add holdings with unknown cost without importing their older trades', async () => {
    const { db } = fixture({ older: true, opening: '999' });
    const trackedProof = { ...proof, balance: '30' };
    const result = await tryLoadJournalNodeEvidence(db, { wallet, token, decimals: 0, startAt: new Date(timestamp.getTime() - 60_000).toISOString(), registrationBlock: '100' }, { balance: trackedProof });
    expect(result?.coverage.complete).toBe(true);
    expect(result?.openingBalances?.[0].tokenAmount).toBe('20');
    const ledger = calculateJournalLedger({ wallets: [wallet], events: result!.events, openingBalances: result!.openingBalances, coverage: [result!.coverage], asOf: proof.checkedAt,
      valuations: [{ tokenAddress: token, priceUsd: '2', pricedAt: proof.checkedAt, balances: [{ walletAddress: wallet, tokenAmount: '30' }] }] });
    expect(ledger.positions[0].remainingTokenAmount).toBe('30'); expect(ledger.positions[0].valueUsd).toBe('60');
    expect(ledger.positions[0].estimatedProfitUsd).toBeNull(); expect(ledger.positions[0].remainingCostBasisUsd).toBeNull();
    expect(ledger.reasons).toContain('opening_cost_unknown'); expect(ledger.reasons).not.toContain('balance_unreconciled');
    expect(rpc).not.toHaveBeenCalled();
  });
  it('uses a later account checkpoint while reusing earlier captured raw coverage', async () => {
    const { db, query } = fixture();
    const startAt = timestamp.toISOString();
    await tryLoadJournalNodeEvidence(db, { wallet, token, decimals: 0, startAt, registrationBlock: '103' }, { balance: proof });
    expect(query.mock.calls.find(([sql]) => sql.includes('FROM wallet_transfers WHERE') && sql.includes('$5::timestamptz'))?.[1]).toEqual([wallet, token, '103', '110', startAt]);
  });
  it('keeps a confirmed checkpoint before the add time in a collection repair state', async () => {
    const result = await tryLoadJournalNodeEvidence(fixture().db, { wallet, token, decimals: 0,
      startAt: new Date(timestamp.getTime() + 1000).toISOString(), registrationBlock: '100' }, { balance: proof });
    expect(result?.coverage.complete).toBe(false); expect(result?.reason).toBe('indexing_lag');
  });
  it('never treats a registration gap or unfinished repair as complete coverage', async () => {
    expect(await tryLoadJournalNodeEvidence(fixture({ repair: '103' }).db, { wallet, token, decimals: 0 }, { balance: proof })).toBeNull();
    expect(await tryLoadJournalNodeEvidence(fixture({ from: 104 }).db, { wallet, token, decimals: 0 }, { balance: proof })).toBeNull();
  });
  it('includes external transfers with observed receipt valuation and exact counterpart', async () => {
    const { db } = fixture({ transferOnly: true });
    const result = await tryLoadJournalNodeEvidence(db, { wallet, token, decimals: 0 }, { balance: proof });
    expect(result?.events[0]).toMatchObject({ kind: 'transfer_in', tokenAmount: '10', amountUsd: '10', counterparty: other, transferId: `${hash}:${token}:2` });
  });
  it('leaves unknown decimals unavailable instead of defaulting them', async () => {
    expect(await tryLoadJournalNodeEvidence(fixture().db, { wallet, token, decimals: null }, { balance: proof })).toBeNull();
  });
  it('preserves a missing USD fee valuation instead of assigning zero', async () => {
    const { db } = fixture({ transferOnly: true, feePrice: null });
    const result = await tryLoadJournalNodeEvidence(db, { wallet, token, decimals: 0 }, { balance: proof });
    expect(result?.coverage.complete).toBe(false); expect(result?.reason).toBe('fee_valuation_unavailable'); expect(result?.events[0].feeUsd).toBeNull();
  });
  it('keeps stale indexed valuations in a repair state rather than publishing a fresh total', async () => {
    const result = await tryLoadJournalNodeEvidence(fixture().db, { wallet, token, decimals: 0 }, { balance: proof, now: timestamp.getTime() + 181_000 });
    expect(result?.coverage.complete).toBe(false); expect(result?.reason).toBe('indexing_lag');
  });
  it('does not allocate one shared transaction budget to every acquired token', async () => {
    const result = await tryLoadJournalNodeEvidence(fixture({ sharedQuote: true }).db, { wallet, token, decimals: 0 }, { balance: proof });
    expect(result?.coverage.complete).toBe(false); expect(result?.reason).toBe('shared_quote_unallocated'); expect(result?.events[0].amountUsd).toBeNull();
  });
});
