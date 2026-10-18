import { createHash, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { JournalActivity, JournalSummary, JournalTokenActivity, JournalWallet, JournalWallets } from '../shared/journal.js';
import { journalWalletLimit } from '../shared/journal.js';
import type { KolTokenBalanceProof } from '../shared/kolTokenTrades.js';
import { pool } from './db.js';
import { kolProfileTokenSql } from './kolProfileToken.js';
import { applyJournalReplay } from './journalReplay.js';
import { tryLoadJournalNodeEvidence } from './journalNodeLedger.js';
import { calculateJournalLedger, type JournalLedgerEvent, type JournalLedgerCoverage, type JournalLedgerValuation, type JournalLedgerOpeningBalance } from './journalLedger.js';
import { currentKolTokenBalance } from './kolTokenBalance.js';
import { loadCurrentPositionQuote } from './kolTokenGmgnPnl.js';
import { loadKolTokenActivity } from './kolTokenTradesApi.js';
import { loadReplayMarketChart } from './tradeReplayChart.js';

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const iso = (value: string | Date) => new Date(value).toISOString();
export class JournalInputError extends Error { constructor(message: string, readonly statusCode = 400) { super(message); this.name = 'JournalInputError'; } }
type Membership = { wallet_address: string; label: string; added_at: Date; activity_from: Date; revision: string; registration_block: string | null };
type CollectionState = { status: 'pending' | 'ready'; complete: boolean; reason?: string; retryAfterMs?: number };
export function journalWalletSetIdentity(members: { wallet_address: string; revision: string }[]) {
  return digest(members.map(row => [row.wallet_address, row.revision]).sort((a, b) => a[0].localeCompare(b[0])));
}
export function journalAddress(value: unknown) {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(value) || /^0x0{40}$/i.test(value)) throw new JournalInputError('Invalid BNB wallet address');
  return value.toLowerCase();
}
export function journalLabel(value: unknown) {
  if (typeof value !== 'string' || value.length > 60 || /[\u0000-\u001f\u007f]/.test(value)) throw new JournalInputError('Use a private label of up to 60 characters');
  return value.trim();
}
type Pair = { wallet: string; token: string; decimals: number | null; symbol: string | null; name: string | null; logoUrl: string | null; startAt: string; registrationBlock: string | null; membershipRevision: string };
type PairEvidence = { events: JournalLedgerEvent[]; coverage: JournalLedgerCoverage; proof: KolTokenBalanceProof | null; quote: { priceUsd: string; timestamp: string } | null; source: 'node'; openingBalances?: JournalLedgerOpeningBalance[]; reason?: string };
export function createJournalService({ db = pool, nodeEvidence = tryLoadJournalNodeEvidence, balance = currentKolTokenBalance, quote = loadCurrentPositionQuote,
  loadActivity = loadKolTokenActivity, chart = loadReplayMarketChart, now = Date.now }: {
    db?: Pool; nodeEvidence?: typeof tryLoadJournalNodeEvidence; balance?: typeof currentKolTokenBalance; quote?: typeof loadCurrentPositionQuote;
    loadActivity?: typeof loadKolTokenActivity; chart?: typeof loadReplayMarketChart; now?: () => number;
  } = {}) {
  const pairJobs = new Map<string, { foreground: boolean; work: Promise<PairEvidence>; promote?(): void }>();
  const snapshotJobs = new Map<string, Promise<JournalSummary>>();
  const memberships = async (userId: string, selected?: string) => {
    const result = await db.query(`SELECT wallet_address,label,added_at,added_at AS activity_from,revision,registration_block::text FROM journal_wallets WHERE user_id=$1 ORDER BY added_at,wallet_address`, [userId]);
    const all = result.rows as Membership[];
    if (selected && selected !== 'all') {
      const wallet = journalAddress(selected), found = all.find(row => row.wallet_address === wallet);
      if (!found) throw new JournalInputError('Portfolio wallet not found', 404);
      return [found];
    }
    return all;
  };
  async function authorize(userId: string, wallet: string, revision?: string) {
    const rows = await memberships(userId, wallet);
    if (revision && rows[0].revision !== revision) throw new JournalInputError('Portfolio membership changed. Refresh and try again.', 409);
    return rows[0];
  }
  async function list(userId: string): Promise<JournalWallets> {
    const rows = await db.query(`SELECT m.*,CASE WHEN c.registration_block IS NOT NULL AND c.collected_through_block >=
      (SELECT (value->>'blockNumber')::bigint FROM worker_state WHERE key='node') AND c.repair_from_block IS NULL
      AND EXISTS(SELECT 1 FROM worker_state WHERE key='node' AND updated_at>=m.added_at AND updated_at>now()-interval '3 minutes')
      THEN 'ready' ELSE 'pending' END AS status,c.last_error,
      CASE WHEN k.is_tracked THEN k.display_name END AS name,CASE WHEN k.is_tracked THEN k.avatar_url END AS "avatarUrl"
      FROM journal_wallets m JOIN published_kols k ON k.address=m.wallet_address
      LEFT JOIN journal_wallet_coverage c ON c.wallet_address=m.wallet_address
      WHERE m.user_id=$1 ORDER BY m.added_at,m.wallet_address`, [userId]);
    return { limit: journalWalletLimit, wallets: rows.rows.map(row => ({ address: row.wallet_address, label: row.label, addedAt: iso(row.added_at), activityFrom: iso(row.added_at), revision: row.revision,
      ...(row.name || row.avatarUrl ? { publicIdentity: { name: row.name, avatarUrl: row.avatarUrl } } : {}),
      preparation: { status: row.status, historyComplete: row.status === 'ready', ...(row.last_error ? { reason: row.last_error } : {}) } } as JournalWallet)) };
  }
  async function add(userId: string, value: unknown, labelValue: unknown = '') {
    const wallet = journalAddress(value), label = journalLabel(labelValue), client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`journal-account:${userId}`]);
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`journal-wallet:${wallet}`]);
      await client.query('SELECT pg_advisory_xact_lock_shared(782319)');
      const existing = await client.query(`SELECT 1 FROM journal_wallets WHERE user_id=$1 AND wallet_address=$2`, [userId, wallet]);
      if (!existing.rowCount) {
        const count = await client.query('SELECT count(*)::integer AS count FROM journal_wallets WHERE user_id=$1', [userId]);
        if (count.rows[0].count >= journalWalletLimit) throw new JournalInputError('You can track up to three portfolio wallets', 409);
        // kols supplies the canonical wallet foreign key only. Private wallets
        // never become members of the public tracked roster.
        await client.query(`INSERT INTO kols(address,display_name,source,is_tracked) VALUES($1,NULL,'journal',false) ON CONFLICT(address) DO NOTHING`, [wallet]);
        const checkpoint = await client.query(`SELECT p.block_number::text,p.block_hash
          FROM processed_blocks p WHERE p.block_number<=COALESCE((SELECT (value->>'blockNumber')::bigint FROM worker_state WHERE key='node'),0)
          ORDER BY p.block_number DESC LIMIT 1`);
        const current = checkpoint.rows[0];
        const subscribed = await client.query('SELECT 1 FROM journal_wallets WHERE wallet_address=$1 LIMIT 1', [wallet]);
        await client.query(`INSERT INTO journal_wallets(user_id,wallet_address,label,revision,registration_block,registration_hash,activity_from) VALUES($1,$2,$3,$4,$5,$6,now())`, [userId, wallet, label, randomUUID(), current?.block_number ?? null, current?.block_hash ?? null]);
        if (!subscribed.rowCount) {
          // A removal/re-addition starts new collection coverage. A prior
          // unsubscribed interval must never become an apparently empty range.
          await client.query(`INSERT INTO journal_wallet_coverage(wallet_address,registration_block,registration_hash,repair_from_block,generation)
            VALUES($1,$2,$3,$4,$5) ON CONFLICT(wallet_address) DO UPDATE SET registered_at=now(),registration_block=EXCLUDED.registration_block,
            registration_hash=EXCLUDED.registration_hash,repair_from_block=EXCLUDED.repair_from_block,collected_from_block=NULL,collected_through_block=NULL,
            history_complete=false,last_error=NULL,generation=EXCLUDED.generation,updated_at=now()`, [wallet, current?.block_number ?? null, current?.block_hash ?? null, current?.block_number ? (BigInt(current.block_number) + 1n).toString() : null, randomUUID()]);
          await client.query('DELETE FROM journal_pair_preparations WHERE wallet_address=$1', [wallet]);
          await client.query('DELETE FROM journal_opening_balances WHERE wallet_address=$1', [wallet]);
        }
        await client.query(`DELETE FROM journal_snapshots WHERE user_id=$1`, [userId]);
      }
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
    return list(userId);
  }
  async function updateLabel(userId: string, value: unknown, labelValue: unknown) {
    const wallet = journalAddress(value), label = journalLabel(labelValue);
    const result = await db.query(`UPDATE journal_wallets SET label=$3 WHERE user_id=$1 AND wallet_address=$2 RETURNING wallet_address`, [userId, wallet, label]);
    if (!result.rowCount) throw new JournalInputError('Portfolio wallet not found', 404);
    return list(userId);
  }
  async function remove(userId: string, value: unknown) {
    const wallet = journalAddress(value), client = await db.connect();
    try {
      await client.query('BEGIN'); await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`journal-account:${userId}`]);
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`journal-wallet:${wallet}`]);
      await client.query('DELETE FROM journal_wallets WHERE user_id=$1 AND wallet_address=$2', [userId, wallet]);
      await client.query('DELETE FROM journal_snapshots WHERE user_id=$1', [userId]);
      await client.query(`DELETE FROM journal_history_jobs WHERE wallet_address=$1 AND NOT EXISTS(SELECT 1 FROM journal_wallets WHERE wallet_address=$1)`, [wallet]);
      await client.query(`DELETE FROM journal_pair_preparations WHERE wallet_address=$1 AND NOT EXISTS(SELECT 1 FROM journal_wallets WHERE wallet_address=$1)`, [wallet]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    return list(userId);
  }
  async function discover(members: Membership[]): Promise<CollectionState[]> {
    if (!members.length) return [];
    const rows = (await db.query(`SELECT c.wallet_address,c.registration_block,c.collected_through_block,c.repair_from_block,c.last_error,
      (SELECT (value->>'blockNumber')::bigint FROM worker_state WHERE key='node') AS confirmed,
      (SELECT updated_at FROM worker_state WHERE key='node') AS updated_at
      FROM journal_wallet_coverage c WHERE wallet_address=ANY($1)`, [members.map(member => member.wallet_address)])).rows;
    return members.map(member => {
      const row = rows.find(value => value.wallet_address === member.wallet_address);
      const ready = row?.registration_block != null && row.confirmed != null && row.collected_through_block != null
        && BigInt(row.collected_through_block) >= BigInt(row.confirmed) && row.repair_from_block == null
        && row.updated_at && Date.parse(row.updated_at) >= Date.parse(iso(member.added_at)) && now() - Date.parse(row.updated_at) < 180_000;
      return { status: ready ? 'ready' : 'pending', complete: ready,
        ...(!ready ? { reason: row?.last_error ?? 'collection_pending', retryAfterMs: 1500 } : {}) };
    });
  }
  async function discoveredPairs(members: Membership[]): Promise<Pair[]> {
    if (!members.length) return [];
    return (await db.query(`WITH selected AS (SELECT * FROM unnest($1::text[],$2::timestamptz[],$3::bigint[],$4::uuid[]) AS s(wallet,starts,registration,revision)),
      candidates AS (SELECT t.token_address FROM trades t JOIN selected s ON s.wallet=t.wallet_address
        WHERE t.timestamp>=s.starts AND t.timestamp<=now() AND t.block_number>s.registration AND t.block_number <= (SELECT (value->>'blockNumber')::bigint FROM worker_state WHERE key='node') AND t.side IN('buy','sell')
        UNION SELECT m.token_address FROM wallet_transfers m JOIN selected s ON s.wallet=m.wallet_address
          WHERE m.timestamp>=s.starts AND m.timestamp<=now() AND m.block_number>s.registration AND m.block_number <= (SELECT (value->>'blockNumber')::bigint FROM worker_state WHERE key='node'))
      SELECT s.wallet,v.address AS token,v.decimals,v.symbol,v.name,s.starts AS "startAt",s.registration::text AS "registrationBlock",s.revision AS "membershipRevision",
        CASE WHEN v.logo_data IS NOT NULL THEN '/api/token-image/'||v.address||'?v='||md5(v.logo_data) END AS "logoUrl"
      FROM (SELECT DISTINCT token_address FROM candidates) c JOIN tokens v ON v.address=c.token_address CROSS JOIN selected s
      WHERE ${kolProfileTokenSql()} ORDER BY v.address,s.wallet`, [members.map(row => row.wallet_address), members.map(row => iso(row.added_at)), members.map(row => row.registration_block), members.map(row => row.revision)])).rows.map(row => ({ ...row, startAt: iso(row.startAt) }));
  }
  async function canonicalRevision(pair: Pair) {
    return (await db.query(`WITH evidence AS (
      SELECT 'trade:'||t.id AS id,jsonb_build_array(t.tx_hash,t.side,t.token_amount,t.amount_usd,t.price_usd,t.quote_token_address,t.quote_symbol,t.quote_amount,t.block_number,t.block_hash,t.transaction_index,t.timestamp,
        EXISTS(SELECT 1 FROM trades other JOIN tokens asset ON asset.address=other.token_address WHERE other.wallet_address=t.wallet_address AND other.tx_hash=t.tx_hash
          AND other.side=t.side AND other.token_address<>t.token_address AND other.block_number IS NOT NULL AND other.quote_symbol=t.quote_symbol
          AND other.quote_amount=t.quote_amount AND other.amount_usd=t.amount_usd AND COALESCE(asset.symbol,'') !~* 'dividend[_ ]?tracker')) AS value
        FROM trades t WHERE t.wallet_address=$1 AND t.token_address=$2 AND t.block_number>$4 AND t.timestamp >= $3
      UNION ALL SELECT 'transfer:'||id,jsonb_build_array(tx_hash,log_index,delta_raw,kind,block_number,block_hash,timestamp,counterparty_address)
        FROM wallet_transfers WHERE wallet_address=$1 AND token_address=$2 AND block_number>$4 AND timestamp >= $3
      UNION ALL SELECT 'fee:'||e.tx_hash,jsonb_build_array(e.block_number,e.block_hash,e.bnb_price_usd,e.bnb_priced_at)
        FROM journal_node_evidence e WHERE e.block_number>$4 AND e.timestamp >= $3 AND (EXISTS(SELECT 1 FROM trades t WHERE t.tx_hash=e.tx_hash AND t.wallet_address=$1 AND t.token_address=$2)
          OR EXISTS(SELECT 1 FROM wallet_transfers m WHERE m.tx_hash=e.tx_hash AND m.wallet_address=$1 AND m.token_address=$2)))
      SELECT md5(COALESCE(jsonb_agg(jsonb_build_array(id,value) ORDER BY id)::text,'[]')) AS revision FROM evidence`, [pair.wallet, pair.token, pair.startAt, pair.registrationBlock])).rows[0].revision as string;
  }
  async function evidence(pair: Pair, foreground = false): Promise<PairEvidence> {
    const key = `${pair.wallet}:${pair.token}:${pair.membershipRevision}:${pair.registrationBlock}`, pending = pairJobs.get(key);
    if (pending) { if (foreground) pending.foreground = true; return pending.work; }
    const unavailable = (reason: string): PairEvidence => ({ events: [], proof: null, quote: null, source: 'node', reason,
      coverage: { walletAddress: pair.wallet, tokenAddress: pair.token, complete: false, reason } });
    if (pair.registrationBlock == null) return unavailable('collection_pending');
    if (pairJobs.size >= (foreground ? 8 : 4)) return unavailable('collection_pending');
    const job = { foreground, work: null as unknown as Promise<PairEvidence> };
    const work = (async () => {
      const originalCanonical = await canonicalRevision(pair);
      const generation = (await db.query('SELECT generation FROM journal_wallet_coverage WHERE wallet_address=$1', [pair.wallet])).rows[0]?.generation ?? null;
      let proof: KolTokenBalanceProof | null = null;
      try { proof = await balance({ wallet: pair.wallet, token: pair.token, decimals: pair.decimals }); } catch { return unavailable('balance_unavailable'); }
      const node = proof ? await nodeEvidence(db, pair, { balance: proof, now: now() }).catch(() => null) : null;
      if (!node) return unavailable(pair.decimals == null ? 'token_decimals_unknown' : 'collection_pending');
      const currentQuote = node.proof.balance === '0' ? null : (await quote(pair.token, { foreground: () => job.foreground })).quote ?? null;
      const value: PairEvidence = { ...node, quote: currentQuote };
      if (await canonicalRevision(pair) !== originalCanonical) return { ...value, coverage: { ...node.coverage, complete: false, reason: 'indexed_snapshot_changed' }, reason: 'indexed_snapshot_changed' };
      await db.query(`INSERT INTO journal_pair_preparations(wallet_address,token_address,history_revision,balance_proof,quote,checked_at,attempted_at,status,reason,events,source,coverage,generation,canonical_revision,tracking_from,opening_balances,membership_revision)
        SELECT $1,$2,$3,$4::jsonb,$5::jsonb,now(),now(),$6,$7,$8::jsonb,'node',$9::jsonb,$10::uuid,$11,$12::timestamptz,$13::jsonb,$14::uuid
        WHERE EXISTS(SELECT 1 FROM journal_wallet_coverage c WHERE c.wallet_address=$1 AND c.generation=$10::uuid)
          AND EXISTS(SELECT 1 FROM journal_wallets WHERE wallet_address=$1 AND revision=$14::uuid)
        ON CONFLICT(wallet_address,token_address) DO UPDATE SET
        history_revision=EXCLUDED.history_revision,balance_proof=EXCLUDED.balance_proof,quote=EXCLUDED.quote,checked_at=now(),attempted_at=now(),status=EXCLUDED.status,
        reason=EXCLUDED.reason,events=EXCLUDED.events,source='node',coverage=EXCLUDED.coverage,generation=EXCLUDED.generation,canonical_revision=EXCLUDED.canonical_revision,
        tracking_from=EXCLUDED.tracking_from,opening_balances=EXCLUDED.opening_balances,membership_revision=EXCLUDED.membership_revision`, [pair.wallet, pair.token, digest(node.events), JSON.stringify(node.proof), currentQuote ? JSON.stringify(currentQuote) : null,
          node.coverage.complete ? 'ready' : 'pending', node.reason ?? null, JSON.stringify(node.events), JSON.stringify(node.coverage), generation, originalCanonical, pair.startAt, JSON.stringify(node.openingBalances ?? []), pair.membershipRevision]);
      return value;
    })().finally(() => pairJobs.delete(key)); job.work = work; pairJobs.set(key, job); return work;
  }
  async function cachedEvidence(pair: Pair): Promise<PairEvidence | null> {
    const cached = (await db.query(`SELECT p.*,c.generation AS "currentGeneration" FROM journal_pair_preparations p
      LEFT JOIN journal_wallet_coverage c ON c.wallet_address=p.wallet_address
      WHERE p.wallet_address=$1 AND p.token_address=$2 AND p.tracking_from=$3::timestamptz AND p.membership_revision=$4::uuid`, [pair.wallet, pair.token, pair.startAt, pair.membershipRevision])).rows[0];
    if (!cached || cached.source !== 'node' || cached.generation !== cached.currentGeneration
      || cached.canonical_revision !== await canonicalRevision(pair) || !cached.balance_proof || now() - Date.parse(cached.balance_proof.checkedAt) > 30_000) return null;
    // Rows may be written before their collection checkpoint commits. A proof
    // capped to the previous checkpoint cannot become a valid warm result once
    // those rows are confirmed, even when their content hash stayed unchanged.
    const newer = (await db.query(`SELECT EXISTS(SELECT 1 FROM trades WHERE wallet_address=$1 AND token_address=$2 AND timestamp >= $3
        AND block_number>$4 AND block_number<=(SELECT (value->>'blockNumber')::bigint FROM worker_state WHERE key='node'))
      OR EXISTS(SELECT 1 FROM wallet_transfers WHERE wallet_address=$1 AND token_address=$2 AND timestamp >= $3
        AND block_number>$4 AND block_number<=(SELECT (value->>'blockNumber')::bigint FROM worker_state WHERE key='node')) AS changed`,
      [pair.wallet, pair.token, pair.startAt, cached.balance_proof.blockNumber])).rows[0]?.changed;
    if (newer) return null;
    return { events: cached.events ?? [], proof: cached.balance_proof, quote: cached.quote ?? null, source: 'node', coverage: cached.coverage,
      openingBalances: cached.opening_balances ?? [], reason: cached.reason ?? undefined };
  }
  async function selectedLedger(members: Membership[], foreground = false, cachedOnly = false) {
    const states = await discover(members), pairs = await discoveredPairs(members);
    const priorities = (await db.query(`SELECT wallet_address||':'||token_address AS key,attempted_at FROM journal_pair_preparations WHERE wallet_address=ANY($1)`, [members.map(row => row.wallet_address)])).rows;
    const attempts = new Map<string, number>(priorities.map(row => [row.key, row.attempted_at ? Date.parse(row.attempted_at) : 0]));
    const scheduled = cachedOnly ? [] : [...pairs].sort((a, b) => (attempts.get(`${a.wallet}:${a.token}`) ?? 0) - (attempts.get(`${b.wallet}:${b.token}`) ?? 0)).slice(0, foreground ? 3 : 2);
    const prepared = new Map<string, PairEvidence>();
    await Promise.all(scheduled.map(async pair => prepared.set(`${pair.wallet}:${pair.token}`, await cachedEvidence(pair) ?? await evidence(pair, foreground))));
    const events: JournalLedgerEvent[] = [], coverages: JournalLedgerCoverage[] = [], openingBalances: JournalLedgerOpeningBalance[] = [], valuations = new Map<string, JournalLedgerValuation>();
    for (const pair of pairs) {
      const value = prepared.get(`${pair.wallet}:${pair.token}`) ?? await cachedEvidence(pair) ?? { events: [], proof: null, quote: null, source: 'node',
        coverage: { walletAddress: pair.wallet, tokenAddress: pair.token, complete: false, reason: 'collection_pending' } };
      events.push(...value.events); coverages.push(value.coverage); if ('openingBalances' in value) openingBalances.push(...value.openingBalances ?? []);
      let valuation = valuations.get(pair.token);
      if (!valuation) { valuation = { tokenAddress: pair.token, priceUsd: value.quote?.priceUsd ?? null, pricedAt: value.quote?.timestamp ?? new Date(now()).toISOString(), balances: [] }; valuations.set(pair.token, valuation); }
      if (value.quote && (!valuation.priceUsd || Date.parse(value.quote.timestamp) > Date.parse(valuation.pricedAt))) { valuation.priceUsd = value.quote.priceUsd; valuation.pricedAt = value.quote.timestamp; }
      if (value.proof) valuation.balances.push({ walletAddress: pair.wallet, tokenAmount: value.proof.balance });
    }
    const result = calculateJournalLedger({ wallets: members.map(row => row.wallet_address), events, openingBalances, coverage: coverages, valuations: [...valuations.values()], asOf: new Date(now()).toISOString() });
    const waitingReason = (reason?: string) => /^(collection_pending|balance_unavailable|indexing_lag|decoding_incomplete|indexed_snapshot_changed|quote_)/.test(reason ?? '');
    return { result, pairs, events, states, preparing: states.some(state => state.status === 'pending')
      || coverages.some(coverage => !coverage.complete && waitingReason(coverage.reason)) || result.reasons.some(waitingReason) };
  }
  async function summary(userId: string, selected?: string): Promise<JournalSummary> {
    const members = await memberships(userId, selected), revision = journalWalletSetIdentity(members), key = `${userId}:${revision}`;
    const build = async (cachedOnly = false) => {
      const { result, pairs, states, preparing } = await selectedLedger(members, false, cachedOnly);
      const discoveryComplete = states.every(state => state.status === 'ready');
      const complete = result.complete && discoveryComplete;
      const reasons = [...new Set([...result.reasons, ...states.filter(state => state.status !== 'ready').map(state => state.reason ?? 'collection_pending')])];
      const observed = result.positions.map(position => Date.parse(position.pricedAt ?? '')).filter(Number.isFinite);
      const asOf = observed.length ? new Date(Math.min(...observed)).toISOString() : result.asOf;
      const snapshotId = digest([revision, asOf, result.positions]);
      const response: JournalSummary = { version: 1, snapshotId, selectedWallets: result.wallets, asOf,
        activityFrom: members.length ? new Date(Math.min(...members.map(member => Date.parse(iso(member.activity_from))))).toISOString() : null,
        coverage: 'since_wallet_added', complete, preparing, reasons,
        positions: result.positions.map(position => { const pair = pairs.find(row => row.token === position.tokenAddress)!; return {
          ...position, token: { address: position.tokenAddress, symbol: pair.symbol, name: pair.name, logoUrl: pair.logoUrl }, status: position.state,
        }; }), totals: complete ? result.totals : { ...result.totals, realizedProfitUsd: null, estimatedProfitUsd: null, roi: null, feeInclusiveCapitalUsd: null },
        ...(preparing ? { retryAfterMs: Math.max(1500, ...states.map(state => state.retryAfterMs ?? 1500)) } : {}) };
      await verifyMembers(userId, members);
      if (complete && members.length) await db.query(`INSERT INTO journal_snapshots(user_id,wallet_set_hash,snapshot_id,membership_revision,as_of,payload)
        VALUES($1,$2,$3,$2,$4,$5::jsonb) ON CONFLICT(user_id,wallet_set_hash) DO UPDATE SET snapshot_id=EXCLUDED.snapshot_id,as_of=EXCLUDED.as_of,payload=EXCLUDED.payload`, [userId, revision, snapshotId, asOf, JSON.stringify(response)]);
      else {
        const saved = (await db.query(`SELECT payload FROM journal_snapshots WHERE user_id=$1 AND wallet_set_hash=$2 AND membership_revision=$2`, [userId, revision])).rows[0]?.payload as JournalSummary | undefined;
        if (saved) response.savedSnapshot = { snapshotId: saved.snapshotId, asOf: saved.asOf, totals: saved.totals };
      }
      return response;
    };
    let work = snapshotJobs.get(key);
    if (!work) { work = build().finally(() => snapshotJobs.delete(key)); snapshotJobs.set(key, work); }
    // Collection accounting continues once per shared job, while ordinary page
    // requests promptly receive already available positions and dated totals.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ready = await Promise.race([work, new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 750); })]).finally(() => clearTimeout(timer));
    if (ready) { await verifyMembers(userId, members); return ready; }
    return build(true);
  }
  async function verifyMembers(userId: string, original: Membership[]) {
    for (const member of original) await authorize(userId, member.wallet_address, member.revision);
  }
  async function activity(userId: string, selected?: string, cursor?: string): Promise<JournalActivity> {
    const members = await memberships(userId, selected);
    if (cursor && (!/^\d{1,7}$/.test(cursor) || Number(cursor) > 100_000)) throw new JournalInputError('Invalid activity cursor');
    const states = await discover(members);
    const rows = members.length ? (await db.query(`WITH selected AS (SELECT * FROM unnest($1::text[],$2::timestamptz[],$3::bigint[]) AS s(wallet,starts,registration))
      SELECT t.id,t.wallet_address AS "walletAddress",t.token_address AS "tokenAddress",v.symbol AS "tokenSymbol",v.name AS "tokenName",
        CASE WHEN v.logo_data IS NOT NULL THEN '/api/token-image/'||v.address||'?v='||md5(v.logo_data) END AS "tokenLogoUrl",t.side,t.token_amount::text AS "tokenAmount",t.amount_usd::text AS "amountUsd",
        t.quote_amount::text AS "quoteAmount",t.quote_symbol AS "quoteSymbol",t.tx_hash AS "txHash",t.timestamp,t.source
      FROM trades t JOIN selected s ON s.wallet=t.wallet_address JOIN tokens v ON v.address=t.token_address
      WHERE t.timestamp>=s.starts AND t.timestamp<=now() AND t.block_number>s.registration AND t.side IN('buy','sell')
        AND t.block_number <= (SELECT (value->>'blockNumber')::bigint FROM worker_state WHERE key='node')
        AND ${kolProfileTokenSql()} ORDER BY t.timestamp DESC,t.id DESC LIMIT 26 OFFSET $4`, [members.map(row => row.wallet_address), members.map(row => iso(row.added_at)), members.map(row => row.registration_block), Number(cursor ?? 0)])).rows : [];
    await verifyMembers(userId, members);
    return { trades: rows.slice(0, 25).map(row => ({ ...row, timestamp: iso(row.timestamp) })), cursor: rows.length > 25 ? String(Number(cursor ?? 0) + 25) : null,
      activityFrom: members.length ? new Date(Math.min(...members.map(member => Date.parse(iso(member.activity_from))))).toISOString() : null, preparing: states.some(state => state.status !== 'ready') };
  }
  async function savedReplay(userId: string, wallet: string, token: string, snapshot: string, revision: string) {
    if (!/^[a-f0-9]{64}$/.test(snapshot)) throw new JournalInputError('Invalid replay snapshot');
    const saved = (await db.query(`SELECT payload FROM journal_replay_snapshots WHERE snapshot_id=$1 AND user_id=$2 AND wallet_address=$3 AND token_address=$4 AND membership_revision=$5 AND expires_at>now()`, [snapshot, userId, wallet, token, revision])).rows[0]?.payload as JournalTokenActivity | undefined;
    if (!saved) throw new JournalInputError('This saved replay has expired. Prepare the trade again.', 409);
    await authorize(userId, wallet, revision);
    return saved;
  }
  async function tokenActivity(userId: string, wallet: string, token: string, replay = false, snapshot?: string): Promise<JournalTokenActivity | null | undefined> {
    const member = await authorize(userId, journalAddress(wallet)); token = journalAddress(token);
    if (snapshot) return savedReplay(userId, wallet, token, snapshot, member.revision);
    const available = (await db.query(`SELECT (SELECT (value->>'blockNumber')::text FROM worker_state WHERE key='node') AS confirmed FROM trades WHERE wallet_address=$1 AND token_address=$2 AND timestamp >= $3
      AND block_number>$4 AND block_number <= (SELECT (value->>'blockNumber')::bigint FROM worker_state WHERE key='node')
      UNION ALL SELECT (SELECT (value->>'blockNumber')::text FROM worker_state WHERE key='node') AS confirmed FROM wallet_transfers WHERE wallet_address=$1 AND token_address=$2 AND timestamp >= $3
      AND block_number>$4 AND block_number <= (SELECT (value->>'blockNumber')::bigint FROM worker_state WHERE key='node') LIMIT 1`, [wallet, token, iso(member.added_at), member.registration_block])).rows[0];
    if (!available) return undefined;
    // Authorize before touching shared provider/cache work, and again after it.
    let result = await loadActivity({ wallet, token, replay: false, pnl: false, allowPrivate: true, skipInventory: true });
    if (result) {
      // A public KOL adapter may contain older indexed cycles. It supplies only
      // identity/metadata here; the private ledger below supplies every amount.
      result = { ...result, trades: result.trades.filter(trade => Date.parse(trade.timestamp) >= Date.parse(iso(member.added_at))
        && trade.blockNumber != null && member.registration_block != null && BigInt(trade.blockNumber) > BigInt(member.registration_block)
        && BigInt(trade.blockNumber) <= BigInt(available.confirmed)),
        replayAccounting: undefined, realizedAccounting: undefined,
        summary: { ...result.summary, investedUsd: null, soldUsd: null, realizedProfitUsd: null, avgBoughtPriceUsd: null, avgSoldPriceUsd: null,
          avgBoughtMcapUsd: null, avgSoldMcapUsd: null, remainingTokenAmount: null, remainingCostBasisUsd: null, status: 'unknown',
          firstTradeAt: null, lastTradeAt: null, buyCount: 0, sellCount: 0, valuedBuyCount: 0, valuedSellCount: 0, excludedSellCount: 0, unpricedTradeCount: 0 } };
      result = { ...result, coverage: { ...result.coverage, indexedTradeCount: result.trades.length, returnedTradeCount: result.trades.length, complete: false },
        trades: result.trades.map(trade => ({ ...trade, realizedProfitUsd: null, cumulativeRealizedProfitUsd: null })) };
      const metadata = (await db.query('SELECT decimals FROM tokens WHERE address=$1', [token])).rows[0];
      const pair: Pair = { wallet, token, startAt: iso(member.added_at), registrationBlock: member.registration_block, membershipRevision: member.revision, decimals: metadata?.decimals ?? null, symbol: result.token.symbol, name: result.token.name, logoUrl: result.token.logoUrl };
      const prepared = await cachedEvidence(pair) ?? await evidence(pair, true);
      if (prepared.proof) result = applyJournalReplay(result, { events: prepared.events, proof: prepared.proof, coverageComplete: prepared.coverage.complete,
        quote: prepared.quote, source: prepared.source, openingBalances: prepared.openingBalances, now: now() });
      else result = { ...result, realizedAccounting: { version: 1, source: prepared.source === 'node' ? 'onchain' : 'gmgn',
        policy: prepared.source === 'node' ? 'onchain_net_trade_profit_v1' : 'gmgn_realized_profit_v1', walletAddress: wallet, tokenAddress: token,
        status: 'pending', checkedAt: new Date(now()).toISOString(), realizedProfitUsd: null, retryAfterMs: 1500,
        coverage: { transactionsComplete: false, balanceMatched: false, reason: prepared.reason ?? 'balance_unavailable' } } };
    }
    await authorize(userId, wallet, member.revision);
    if (!result) return result;
    const response: JournalTokenActivity = { ...result, journal: { accountId: userId, walletAddress: wallet, membershipRevision: member.revision, preparedAt: result.generatedAt, private: true } };
    if (replay && response.realizedAccounting?.status === 'ready' && ['ready', 'estimated'].includes(response.replayAccounting?.status ?? '')
      && response.replayAccounting?.coverage.transactionsComplete && response.replayAccounting.coverage.balanceMatched && response.replayAccounting.final) {
      const id = digest([userId, member.revision, response]); response.journal.snapshotId = id;
      await db.query('DELETE FROM journal_replay_snapshots WHERE expires_at<=now()');
      await db.query(`INSERT INTO journal_replay_snapshots(snapshot_id,user_id,wallet_address,token_address,membership_revision,payload,expires_at)
        VALUES($1,$2,$3,$4,$5,$6::jsonb,now()+interval '15 minutes') ON CONFLICT DO NOTHING`, [id, userId, wallet, token, member.revision, JSON.stringify(response)]);
      await authorize(userId, wallet, member.revision);
    }
    return response;
  }
  async function replayChart(userId: string, wallet: string, token: string, current: boolean, snapshot?: string) {
    const member = await authorize(userId, journalAddress(wallet)); token = journalAddress(token);
    const frozen = snapshot ? await savedReplay(userId, wallet, token, snapshot, member.revision) : null;
    const rows = await db.query(`SELECT MIN(timestamp) AS first,MAX(timestamp) AS last FROM (
      SELECT timestamp FROM trades WHERE wallet_address=$1 AND token_address=$2 AND block_number>$4 AND block_number <= (SELECT (value->>'blockNumber')::bigint FROM worker_state WHERE key='node') AND timestamp >= $3 AND timestamp<=now()
      UNION ALL SELECT timestamp FROM wallet_transfers WHERE wallet_address=$1 AND token_address=$2 AND block_number>$4 AND block_number <= (SELECT (value->>'blockNumber')::bigint FROM worker_state WHERE key='node') AND timestamp >= $3 AND timestamp<=now()) movements`, [wallet, token, iso(member.added_at), member.registration_block]);
    if (!rows.rows[0]?.first) throw new JournalInputError('No trading history is available yet', 404);
    const metadata = (await db.query(`SELECT CASE WHEN total_supply_raw>0 AND decimals BETWEEN 0 AND 36 AND supply_checked_at>now()-interval '2 days' THEN (total_supply_raw/power(10::numeric,decimals))::text END AS supply FROM tokens WHERE address=$1 AND ${kolProfileTokenSql('tokens')}`, [token])).rows[0];
    if (!metadata) throw new JournalInputError('Portfolio token activity not found', 404);
    const movements = frozen?.replayAccounting?.history?.events ?? frozen?.replayAccounting?.events;
    const first = movements?.length ? Math.min(...movements.map(event => Date.parse(event.timestamp))) : Date.parse(rows.rows[0].first);
    const last = movements?.length ? Math.max(...movements.map(event => Date.parse(event.timestamp))) : Date.parse(rows.rows[0].last);
    let value = await chart(token, first, last, current, frozen ? frozen.token.marketCapSupply : metadata.supply ?? null);
    const ending = frozen?.realizedAccounting?.position;
    if (current && ending?.priceUsd && ending.pricedAt) value = { ...value, currentQuote: { priceUsd: ending.priceUsd, timestamp: ending.pricedAt } };
    await authorize(userId, wallet, member.revision); return value;
  }
  return { list, add, updateLabel, remove, summary, activity, tokenActivity, replayChart, authorize };
}
export const journalService = createJournalService();
