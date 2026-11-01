import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { readTokenPostCandidates, revalidateTokenPostEvidence, tokenPostEvidenceIsCanonical, tokenPostEligibilityLimits } from './xTokenPostEligibility.js';

const token = `0x${'1'.repeat(36)}7777`, hash = `0x${'a'.repeat(64)}`;
const wallet = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
const now = Date.parse('2026-10-31T12:00:00Z'), asOf = new Date(now - 10_000).toISOString();
const holder = (n: number) => ({ wallet_address: wallet(n), display_name: `KOL ${n}`, avatar_url: null,
  twitter:`kol_${n}`,
  balance: '1', balance_block: '900', balance_hash: hash, revision: '1', buy_event_id: `buy-${n}`,
  name: 'Meme', symbol: 'MEME', logo_url: null, website_url: null, optional_market_cap: null,
  observed_block: null, observed_hash: null, observed_at: null });
function setup(overrides: Partial<{ ready: boolean; checkpoint: any; holders: any[]; potential: any[]; canonical: boolean }> = {}) {
  const state = { ready: true, checkpoint: { block_number: '1000', block_hash: hash, timestamp: asOf },
    holders: [1,2,3,4].map(holder), potential: [{ token_address: token }], canonical: true, ...overrides };
  const calls: { sql: string; args: unknown[] }[] = [];
  const query = vi.fn(async (sql: string, args: unknown[] = []) => {
    calls.push({ sql, args });
    const rows = sql.includes('x-post fresh schema') ? [{ ready: state.ready }]
      : sql.includes('x-post checkpoint') ? state.checkpoint ? [state.checkpoint] : []
      : sql.includes('x-post candidates') ? state.potential : sql.includes('x-post holders') ? state.holders
      : sql.includes('x-post canonical evidence') ? [{ valid: state.canonical }] : (() => { throw Error('Unexpected SQL'); })();
    return { rows, rowCount: rows.length };
  });
  const db = { query } as unknown as Pick<Pool, 'query'>;
  return { state, db, calls, run: (options: Parameters<typeof readTokenPostCandidates>[1] = {}) => readTokenPostCandidates(db, { now, ...options }) };
}

describe('X posting: four current public KOL holders', () => {
  it('qualifies exactly four positive holders without volume, market cap, quote, P&L or a recent buy', async () => {
    const f = setup(), result = await f.run();
    expect(result.reason).toBeNull(); expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({ version: 2, eligibilityPolicy: 'current_holders_v1', kolCount: 4,
      evaluatedAt: asOf, marketVolumeUsd: null, marketCapUsd: null, quoteObservedAt: null, marketEvidenceIds: [] });
    expect(result.candidates[0].holdingProofs).toHaveLength(4);
    expect(result.candidates[0].participants[0].twitterUsername).toBe('kol_1');
    const sql = f.calls.map(c => c.sql).join('\n');
    expect(sql).not.toMatch(/node_market_|25000|15000|interval '1 hour'|unknown_cost|realized_q|snapshot/);
    expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|ALTER|CREATE)\b/);
  });
  it('counts any exact positive remainder, including one raw unit after a partial sale', async () => {
    const f = setup(); f.state.holders[0].balance = '0.000000000000000001';
    expect((await f.run()).candidates[0].holdingProofs![0].balance).toBe('0.000000000000000001');
  });
  it.each(['0', '-1', 'NaN', 'Infinity', '1/2', '', null])('does not count a zero/invalid holding %s', async balance => {
    const f = setup(); f.state.holders[0].balance = balance as any;
    expect((await f.run()).candidates).toEqual([]);
  });
  it('counts a wallet once across duplicate rows and rejects three distinct holders', async () => {
    const f = setup({ holders: [holder(1), holder(1), holder(2), holder(3)] });
    expect((await f.run()).candidates).toEqual([]);
  });
  it('requires four distinct KOL identities even when four different wallets hold', async () => {
    const f = setup(); f.state.holders[3].twitter = '@KOL_1';
    expect((await f.run()).candidates).toEqual([]);
  });
  it('counts linked wallets once while retaining all five canonical balance proofs', async () => {
    const f = setup({ holders: [1,2,3,4,5].map(holder) });
    f.state.holders[4].twitter = 'https://x.com/KOL_1';
    const evidence = (await f.run()).candidates[0];
    expect(evidence.kolCount).toBe(4); expect(evidence.holdingProofs).toHaveLength(5);
    expect(await tokenPostEvidenceIsCanonical(f.db,evidence)).toBe(true);
    expect(f.calls.find(c => c.sql.includes('x-post candidates'))!.sql).toContain('count(DISTINCT k.wallet_address)>=4');
    f.state.holders[3].twitter = 'https://twitter.com/kol_1';
    expect(await tokenPostEvidenceIsCanonical(f.db,evidence)).toBe(false);
    expect((await f.run()).candidates).toEqual([]);
  });
  it('keeps unlinked roster wallets distinct without merging matching display names', async () => {
    const f = setup(); for (const p of f.state.holders) { p.twitter = ''; p.display_name = 'Same display name'; }
    expect((await f.run()).candidates[0].kolCount).toBe(4);
  });
  it('requires public active single-wallet KOL scopes and a canonical public purchase, excluding transfer-only/private holdings', async () => {
    const f = setup(); await f.run(); const sql = f.calls.find(c => c.sql.includes('x-post candidates'))!.sql;
    for (const fragment of ["s.kind='kol'", 's.active', 's.account_id IS NULL', 'cardinality(s.wallet_addresses)=1',
      'k.is_tracked', 'public_kol.is_tracked', 'w.active', "e.kind='buy'", 'e.canonical AND e.observed_live',
      'e.block_number>=greatest(s.starts_block,w.monitoring_from_block)', "p.balance_status='matched'", 'p.balance_quantity::numeric>0']) expect(sql).toContain(fragment);
    expect(sql).not.toContain('e.occurred_at>=$1'); // no one-hour purchase restriction
    expect(sql).toContain('is_meme'); expect(sql).toContain('dividend'); expect(sql).toContain('0x000ae314');
  });
  it('requires exact inventory agreement and accounts for later sells/transfers/pending receipts and gaps', async () => {
    const f = setup(); await f.run(); const sql = f.calls.find(c => c.sql.includes('x-post candidates'))!.sql;
    for (const fragment of ["split_part(p.quantity_q,'/',1)::numeric", 'later.block_number>p.balance_block',
      "later.kind IN('buy','sell','transfer_in','transfer_out')", "pending.decoder_status<>'done'", 'w.decode_gap_from_block>p.balance_block',
      'orphan.block_hash<>p.balance_hash']) expect(sql).toContain(fragment);
    expect(sql).not.toContain("p.balance_checked_at>=$1"); // unchanged long-held balances stay eligible
  });
  it('treats a sub-threshold market cap as optional display data rather than rejecting holders', async () => {
    const f = setup(); Object.assign(f.state.holders[0], { optional_market_cap: '1', observed_block: '999', observed_hash: hash, observed_at: asOf });
    expect((await f.run()).candidates[0].marketCapUsd).toBe('1');
  });
  it.each([{ ready: false }, { checkpoint: null }])('defers missing Fresh capture without falling back to old tables', async override => {
    const f = setup(override); expect(await f.run()).toEqual({ candidates: [], reason: 'checkpoint_unavailable', evaluatedAt: null });
    expect(f.calls.some(c => /x-post candidates|x-post holders/.test(c.sql))).toBe(false);
  });
  it('defers stale capture, even when holder rows exist', async () => {
    const f = setup({ checkpoint: { block_number: '1000', block_hash: hash, timestamp: new Date(now-120001).toISOString() } });
    expect((await f.run()).reason).toBe('indexer_lag');
  });
  it('normalizes addresses, bounds scans and rejects invalid addresses/clocks', async () => {
    const f = setup(); await f.run({ token: token.toUpperCase().replace('0X','0x'), limit: 999 });
    expect(f.calls.find(c => c.sql.includes('x-post candidates'))!.args).toEqual([asOf,1000,token,20]);
    await expect(f.run({ token: 'bad' })).rejects.toThrow('invalid_token_post_address');
    await expect(f.run({ now: NaN })).rejects.toThrow('invalid_token_post_time');
  });
  it('does not allow saved known jobs to starve discovery, while explicit preview bypasses suppression', async () => {
    const f = setup(); await f.run({ discovery: true });
    expect(f.calls.find(c => c.sql.includes('x-post candidates'))!.sql).toContain('NOT EXISTS(SELECT 1 FROM x_token_post_jobs');
    const explicit = setup(); await explicit.run({ token, discovery: true });
    expect(explicit.calls.find(c => c.sql.includes('x-post candidates'))!.sql).not.toContain('x_token_post_jobs');
  });
  it('bounds holder evidence without truncating an exact count', async () => {
    const f = setup({ holders: Array.from({ length: tokenPostEligibilityLimits.holders + 1 }, (_, n) => holder(n)) });
    expect((await f.run()).candidates).toEqual([]);
  });
  it('revalidates before dispatch and defers if one of the four holders exits', async () => {
    const f = setup(), evidence = (await f.run()).candidates[0]; f.state.holders.pop();
    expect(await revalidateTokenPostEvidence(f.db,evidence,{ now })).toBeNull();
  });
  it('invalidates orphaned block evidence and changed balance revisions', async () => {
    const f = setup(), evidence = (await f.run()).candidates[0];
    f.state.holders[0].revision = '2'; expect(await tokenPostEvidenceIsCanonical(f.db,evidence)).toBe(false);
    f.state.holders[0].revision = '1'; f.state.canonical = false;
    expect(await tokenPostEvidenceIsCanonical(f.db,evidence)).toBe(false);
  });
  it('rejects legacy hourly-trader jobs and duplicate/tampered holding proofs', async () => {
    const f = setup(), evidence = (await f.run()).candidates[0];
    expect(await tokenPostEvidenceIsCanonical(f.db,{ ...evidence,version:1 })).toBe(false);
    expect(await tokenPostEvidenceIsCanonical(f.db,{ ...evidence,holdingProofs:[...evidence.holdingProofs!.slice(0,3),evidence.holdingProofs![0]] })).toBe(false);
    expect(await tokenPostEvidenceIsCanonical(f.db,{ ...evidence,kolCount:6 })).toBe(false);
  });
  it('reports bounded eligibility diagnostics without allowing a logging failure to block results', async () => {
    const f = setup(), log = vi.fn(); await f.run({ onDiagnostic: log });
    expect(log).toHaveBeenCalledWith({ reason:'eligible',tokenAddress:token });
    expect((await f.run({ onDiagnostic: () => { throw Error('offline'); } })).candidates).toHaveLength(1);
  });
});
