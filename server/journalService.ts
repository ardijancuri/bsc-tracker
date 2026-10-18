import { createHash, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { JournalActivity, JournalSummary, JournalTokenActivity, JournalWallet, JournalWallets } from '../shared/journal.js';
import { journalWalletLimit } from '../shared/journal.js';
import type { KolTokenBalanceProof } from '../shared/kolTokenTrades.js';
import { pool } from './db.js';
import { kolProfileTokenSql } from './kolProfileToken.js';
import { currentJournalHistory, type JournalHistoryState } from './journalHistory.js';
import { mergeJournalEvidence } from './journalEvidence.js';
import { applyJournalReplay } from './journalReplay.js';
import { tryLoadJournalNodeEvidence } from './journalNodeLedger.js';
import { calculateJournalLedger, type JournalLedgerEvent, type JournalLedgerCoverage, type JournalLedgerValuation } from './journalLedger.js';
import { currentKolTokenBalance } from './kolTokenBalance.js';
import { loadCurrentPositionQuote } from './kolTokenGmgnPnl.js';
import { loadKolTokenActivity } from './kolTokenTradesApi.js';
import { loadReplayMarketChart } from './tradeReplayChart.js';

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const iso = (value: string | Date) => new Date(value).toISOString();
export class JournalInputError extends Error { constructor(message: string, readonly statusCode = 400) { super(message); this.name = 'JournalInputError'; } }
type Membership = { wallet_address: string; label: string; added_at: Date; activity_from: Date; revision: string };
type History = typeof currentJournalHistory;
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
type Pair = { wallet: string; token: string; decimals: number | null; symbol: string | null; name: string | null; logoUrl: string | null };
type PairEvidence = { events: JournalLedgerEvent[]; coverage: JournalLedgerCoverage; proof: KolTokenBalanceProof | null; quote: { priceUsd: string; timestamp: string } | null; source: 'node' | 'gmgn'; reason?: string };
export function createJournalService({ db = pool, history = currentJournalHistory, balance = currentKolTokenBalance, quote = loadCurrentPositionQuote,
  loadActivity = loadKolTokenActivity, chart = loadReplayMarketChart, now = Date.now }: {
    db?: Pool; history?: History; balance?: typeof currentKolTokenBalance; quote?: typeof loadCurrentPositionQuote;
    loadActivity?: typeof loadKolTokenActivity; chart?: typeof loadReplayMarketChart; now?: () => number;
  } = {}) {
  const pairJobs = new Map<string, { foreground: boolean; work: Promise<PairEvidence>; promote?(): void }>();
  const snapshotJobs = new Map<string, Promise<JournalSummary>>();
  const memberships = async (userId: string, selected?: string) => {
    const result = await db.query(`SELECT wallet_address,label,added_at,activity_from,revision FROM journal_wallets WHERE user_id=$1 ORDER BY added_at,wallet_address`, [userId]);
    const all = result.rows as Membership[];
    if (selected && selected !== 'all') {
      const wallet = journalAddress(selected), found = all.find(row => row.wallet_address === wallet);
      if (!found) throw new JournalInputError('Journal wallet not found', 404);
      return [found];
    }
    return all;
  };
  async function authorize(userId: string, wallet: string, revision?: string) {
    const rows = await memberships(userId, wallet);
    if (revision && rows[0].revision !== revision) throw new JournalInputError('Journal membership changed. Refresh and try again.', 409);
    return rows[0];
  }
  async function list(userId: string): Promise<JournalWallets> {
    const rows = await db.query(`SELECT m.*,j.status,j.error,j.complete,j.retry_at,j.covered_to,j.refresh_pending,
      (SELECT MIN(timestamp) FROM (SELECT timestamp FROM trades WHERE wallet_address=m.wallet_address AND block_number IS NOT NULL AND side IN('buy','sell')
        UNION ALL SELECT timestamp FROM journal_provider_movements WHERE wallet_address=m.wallet_address AND kind IN('buy','sell')) earliest) AS oldest_activity,
      CASE WHEN k.is_tracked THEN k.display_name END AS name,CASE WHEN k.is_tracked THEN k.avatar_url END AS "avatarUrl"
      FROM journal_wallets m JOIN published_kols k ON k.address=m.wallet_address
      LEFT JOIN journal_history_jobs j ON j.wallet_address=m.wallet_address AND j.scope='all'
      WHERE m.user_id=$1 ORDER BY m.added_at,m.wallet_address`, [userId]);
    return { limit: journalWalletLimit, wallets: rows.rows.map(row => ({ address: row.wallet_address, label: row.label, addedAt: iso(row.added_at), activityFrom: iso(row.activity_from), revision: row.revision,
      ...(row.name || row.avatarUrl ? { publicIdentity: { name: row.name, avatarUrl: row.avatarUrl } } : {}),
      preparation: { status: row.status === 'ready' && (row.refresh_pending || !row.complete && (!row.covered_to || Date.parse(row.covered_to) > Date.parse(row.activity_from))) ? 'pending'
        : ['ready', 'cooldown', 'unavailable'].includes(row.status) ? row.status : 'pending',
        historyComplete: row.complete === true && (!row.oldest_activity || Date.parse(row.oldest_activity) >= Date.parse(row.activity_from)),
        ...(row.error ? { reason: row.error } : {}), ...(row.retry_at && Date.parse(row.retry_at) > now() ? { retryAfterMs: Date.parse(row.retry_at) - now() } : {}) } } as JournalWallet)) };
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
        if (count.rows[0].count >= journalWalletLimit) throw new JournalInputError('You can track up to three journal wallets', 409);
        // kols supplies the canonical wallet foreign key only. Private wallets
        // never become members of the public tracked roster.
        await client.query(`INSERT INTO kols(address,display_name,source,is_tracked) VALUES($1,NULL,'journal',false) ON CONFLICT(address) DO NOTHING`, [wallet]);
        const checkpoint = await client.query(`SELECT p.block_number::text,p.block_hash,
          (SELECT MIN(block_number)::text FROM processed_blocks WHERE processed_at>now()-interval '7 days') AS first
          FROM processed_blocks p WHERE p.block_number<=COALESCE((SELECT (value->>'blockNumber')::bigint FROM worker_state WHERE key='node'),0)
          ORDER BY p.block_number DESC LIMIT 1`);
        const current = checkpoint.rows[0];
        const subscribed = await client.query('SELECT 1 FROM journal_wallets WHERE wallet_address=$1 LIMIT 1', [wallet]);
        await client.query(`INSERT INTO journal_wallets(user_id,wallet_address,label,revision,registration_block,registration_hash) VALUES($1,$2,$3,$4,$5,$6)`, [userId, wallet, label, randomUUID(), current?.block_number ?? null, current?.block_hash ?? null]);
        if (!subscribed.rowCount) {
          // A removal/re-addition starts new collection coverage. A prior
          // unsubscribed interval must never become an apparently empty range.
          await client.query(`INSERT INTO journal_wallet_coverage(wallet_address,registration_block,registration_hash,repair_from_block,generation)
            VALUES($1,$2,$3,$4,$5) ON CONFLICT(wallet_address) DO UPDATE SET registered_at=now(),registration_block=EXCLUDED.registration_block,
            registration_hash=EXCLUDED.registration_hash,repair_from_block=EXCLUDED.repair_from_block,collected_from_block=NULL,collected_through_block=NULL,
            history_complete=false,last_error=NULL,generation=EXCLUDED.generation,updated_at=now()`, [wallet, current?.block_number ?? null, current?.block_hash ?? null, current?.first ?? current?.block_number ?? null, randomUUID()]);
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
    if (!result.rowCount) throw new JournalInputError('Journal wallet not found', 404);
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
  async function older(userId: string, value: unknown) {
    const wallet = journalAddress(value);
    const result = await db.query(`UPDATE journal_wallets SET activity_from=activity_from-interval '7 days',revision=$3 WHERE user_id=$1 AND wallet_address=$2 RETURNING wallet_address`, [userId, wallet, randomUUID()]);
    if (!result.rowCount) throw new JournalInputError('Journal wallet not found', 404);
    await db.query('DELETE FROM journal_snapshots WHERE user_id=$1', [userId]);
    return list(userId);
  }
  async function discover(members: Membership[], foreground = false) {
    return Promise.all(members.map(member => history(member.wallet_address, null, iso(member.activity_from), foreground)));
  }
  async function discoveredPairs(members: Membership[]): Promise<Pair[]> {
    if (!members.length) return [];
    return (await db.query(`WITH selected AS (SELECT * FROM unnest($1::text[],$2::timestamptz[]) AS s(wallet,starts)),
      candidates AS (SELECT t.token_address FROM trades t JOIN selected s ON s.wallet=t.wallet_address WHERE t.timestamp>=s.starts AND t.timestamp<=now() AND t.block_number IS NOT NULL AND t.side IN('buy','sell')
        UNION SELECT m.token_address FROM journal_provider_movements m JOIN selected s ON s.wallet=m.wallet_address WHERE m.timestamp>=s.starts AND m.timestamp<=now() AND m.kind IN('buy','sell'))
      SELECT s.wallet,v.address AS token,v.decimals,v.symbol,v.name,
        CASE WHEN v.logo_data IS NOT NULL THEN '/api/token-image/'||v.address||'?v='||md5(v.logo_data) END AS "logoUrl"
      FROM (SELECT DISTINCT token_address FROM candidates) c JOIN tokens v ON v.address=c.token_address CROSS JOIN selected s
      WHERE ${kolProfileTokenSql()} ORDER BY v.address,s.wallet`, [members.map(row => row.wallet_address), members.map(row => iso(row.activity_from))])).rows;
  }
  async function readPairEvents(pair: Pair, complete: boolean) {
    const rows = (await db.query(`SELECT event_key AS id,kind,tx_hash AS "txHash",timestamp,token_amount::text AS "tokenAmount",amount_usd::text AS "amountUsd",fee_usd::text AS "feeUsd",counterparty,quote_amount::text AS "quoteAmount",quote_symbol AS "quoteSymbol"
      FROM journal_provider_movements WHERE wallet_address=$1 AND token_address=$2 ORDER BY timestamp,event_key`, [pair.wallet, pair.token])).rows;
    const canonical = (await db.query(`SELECT t.id,t.tx_hash AS "txHash",t.side,t.token_amount::text AS "tokenAmount",t.amount_usd::text AS "amountUsd",t.quote_amount::text AS "quoteAmount",t.quote_symbol AS "quoteSymbol",t.timestamp,t.block_number::text AS "blockNumber",t.transaction_index AS "transactionIndex",
      EXISTS(SELECT 1 FROM trades other JOIN tokens asset ON asset.address=other.token_address
        WHERE other.wallet_address=t.wallet_address AND other.tx_hash=t.tx_hash AND other.side=t.side AND other.token_address<>t.token_address
          AND other.block_number IS NOT NULL AND other.quote_symbol=t.quote_symbol AND other.quote_amount=t.quote_amount AND other.amount_usd=t.amount_usd
          AND COALESCE(asset.symbol,'') !~* 'dividend[_ ]?tracker') AS "sharedQuote"
      FROM trades t WHERE t.wallet_address=$1 AND t.token_address=$2 AND t.block_number IS NOT NULL AND t.timestamp<=now() ORDER BY t.timestamp,t.block_number,t.transaction_index`, [pair.wallet, pair.token])).rows;
    return mergeJournalEvidence(pair.wallet, pair.token, rows, canonical, complete);
  }
  async function canonicalRevision(pair: Pair) {
    return (await db.query(`WITH evidence AS (
      SELECT 'trade:'||t.id AS id,jsonb_build_array(t.tx_hash,t.side,t.token_amount,t.amount_usd,t.price_usd,t.quote_token_address,t.quote_symbol,t.quote_amount,t.block_number,t.block_hash,t.transaction_index,t.timestamp,
        EXISTS(SELECT 1 FROM trades other JOIN tokens asset ON asset.address=other.token_address WHERE other.wallet_address=t.wallet_address AND other.tx_hash=t.tx_hash
          AND other.side=t.side AND other.token_address<>t.token_address AND other.block_number IS NOT NULL AND other.quote_symbol=t.quote_symbol
          AND other.quote_amount=t.quote_amount AND other.amount_usd=t.amount_usd AND COALESCE(asset.symbol,'') !~* 'dividend[_ ]?tracker')) AS value
        FROM trades t WHERE t.wallet_address=$1 AND t.token_address=$2 AND t.block_number IS NOT NULL
      UNION ALL SELECT 'transfer:'||id,jsonb_build_array(tx_hash,log_index,delta_raw,kind,block_number,block_hash,timestamp,counterparty_address)
        FROM wallet_transfers WHERE wallet_address=$1 AND token_address=$2
      UNION ALL SELECT 'fee:'||e.tx_hash,jsonb_build_array(e.block_number,e.block_hash,e.bnb_price_usd,e.bnb_priced_at)
        FROM journal_node_evidence e WHERE EXISTS(SELECT 1 FROM trades t WHERE t.tx_hash=e.tx_hash AND t.wallet_address=$1 AND t.token_address=$2)
          OR EXISTS(SELECT 1 FROM wallet_transfers m WHERE m.tx_hash=e.tx_hash AND m.wallet_address=$1 AND m.token_address=$2))
      SELECT md5(COALESCE(jsonb_agg(jsonb_build_array(id,value) ORDER BY id)::text,'[]')) AS revision FROM evidence`, [pair.wallet, pair.token])).rows[0].revision as string;
  }
  async function evidence(pair: Pair, foreground = false): Promise<PairEvidence> {
    const key = `${pair.wallet}:${pair.token}`, pending = pairJobs.get(key);
    if (pending) { if (foreground) { pending.foreground = true; pending.promote?.(); } return pending.work; }
    if (pairJobs.size >= (foreground ? 8 : 4)) return { events: [], proof: null, quote: null, source: 'gmgn', reason: 'provider_busy',
      coverage: { walletAddress: pair.wallet, tokenAddress: pair.token, complete: false, reason: 'provider_busy' } };
    const job = { foreground, work: null as unknown as Promise<PairEvidence>, promote: undefined as (() => void) | undefined };
    const work = (async () => {
      const originalCanonical = await canonicalRevision(pair);
      const generation = (await db.query('SELECT generation FROM journal_wallet_coverage WHERE wallet_address=$1', [pair.wallet])).rows[0]?.generation ?? null;
      let nodeProof: KolTokenBalanceProof | null = null;
      try { nodeProof = await balance({ wallet: pair.wallet, token: pair.token, decimals: pair.decimals }); } catch { /* Provider recovery still requires a later confirmed balance. */ }
      const node = nodeProof ? await tryLoadJournalNodeEvidence(db, pair, { balance: nodeProof, now: now() }).catch(() => null) : null;
      if (node) {
        const currentQuote = node.proof.balance === '0' ? null : (await quote(pair.token, { foreground: () => job.foreground })).quote ?? null;
        const value: PairEvidence = { ...node, quote: currentQuote };
        if (await canonicalRevision(pair) !== originalCanonical) return { ...value, coverage: { ...node.coverage, complete: false, reason: 'indexed_snapshot_changed' }, reason: 'indexed_snapshot_changed' };
        const saved = await db.query(`INSERT INTO journal_pair_preparations(wallet_address,token_address,history_revision,balance_proof,quote,checked_at,attempted_at,status,reason,events,source,coverage,generation,canonical_revision)
          SELECT $1,$2,$3,$4::jsonb,$5::jsonb,now(),now(),$6,$7,$8::jsonb,'node',$9::jsonb,$10::uuid,$11
          WHERE EXISTS(SELECT 1 FROM journal_wallet_coverage c WHERE c.wallet_address=$1 AND c.generation=$10::uuid)
            AND EXISTS(SELECT 1 FROM journal_wallets WHERE wallet_address=$1)
          ON CONFLICT(wallet_address,token_address) DO UPDATE SET
          history_revision=EXCLUDED.history_revision,balance_proof=EXCLUDED.balance_proof,quote=EXCLUDED.quote,checked_at=now(),attempted_at=now(),status=EXCLUDED.status,reason=EXCLUDED.reason,events=EXCLUDED.events,source='node',coverage=EXCLUDED.coverage,generation=EXCLUDED.generation,canonical_revision=EXCLUDED.canonical_revision`, [pair.wallet, pair.token, digest(node.events), JSON.stringify(node.proof), currentQuote ? JSON.stringify(currentQuote) : null, node.coverage.complete ? 'ready' : 'pending', node.reason ?? null, JSON.stringify(node.events), JSON.stringify(node.coverage), generation, originalCanonical]);
        if (!saved.rowCount) throw new JournalInputError('Journal membership changed. Refresh and try again.', 409);
        return value;
      }
      job.promote = () => { void history(pair.wallet, pair.token, new Date(0).toISOString(), true).catch(() => {}); };
      const historical = await history(pair.wallet, pair.token, new Date(0).toISOString(), job.foreground);
      job.promote = undefined;
      const merged = await readPairEvents(pair, historical.complete), events = merged.events, mismatch = merged.reasons.length > 0, revision = digest(events);
      const cached = (await db.query(`SELECT * FROM journal_pair_preparations WHERE wallet_address=$1 AND token_address=$2`, [pair.wallet, pair.token])).rows[0];
      let proof: KolTokenBalanceProof | null = nodeProof ?? (cached?.history_revision === revision && cached.balance_proof && now() - Date.parse(cached.balance_proof.checkedAt) < 30_000 ? cached.balance_proof : null);
      let currentQuote = cached?.quote && now() - Date.parse(cached.quote.timestamp) < 30_000 ? cached.quote : null;
      let reason = mismatch ? merged.reasons[0] : historical.complete ? undefined : historical.reason ?? 'history_incomplete';
      if (!proof) {
        try { proof = await balance({ wallet: pair.wallet, token: pair.token, decimals: pair.decimals }); }
        catch { reason ??= 'balance_unavailable'; }
      }
      if (!currentQuote && proof?.balance !== '0') {
        const result = await quote(pair.token, { foreground: () => job.foreground }); currentQuote = result.quote ?? null;
        if (!currentQuote) reason ??= result.reason ?? 'quote_unavailable';
      }
      const confirmed = proof !== null && events.every(event => Date.parse(event.timestamp) <= Date.parse(proof!.blockTimestamp)
        && (!event.blockNumber || BigInt(event.blockNumber) <= BigInt(proof!.blockNumber)));
      if (proof && !confirmed) reason ??= 'confirmation_pending';
      const coverage = { walletAddress: pair.wallet, tokenAddress: pair.token, complete: historical.complete && !mismatch && confirmed, ...(reason ? { reason } : {}) };
      const finalCanonical = await canonicalRevision(pair), finalHistory = await readPairEvents(pair, historical.complete);
      if (finalCanonical !== originalCanonical || digest(finalHistory.events) !== revision) return { events: finalHistory.events, proof, quote: currentQuote, source: 'gmgn' as const,
        coverage: { ...coverage, complete: false, reason: 'indexed_snapshot_changed' }, reason: 'indexed_snapshot_changed' };
      await db.query(`INSERT INTO journal_pair_preparations(wallet_address,token_address,history_revision,balance_proof,quote,checked_at,attempted_at,status,reason,events,source,coverage)
        VALUES($1,$2,$3,$4::jsonb,$5::jsonb,now(),now(),$6,$7,$8::jsonb,'gmgn',$9::jsonb) ON CONFLICT(wallet_address,token_address) DO UPDATE SET history_revision=EXCLUDED.history_revision,
        balance_proof=EXCLUDED.balance_proof,quote=EXCLUDED.quote,checked_at=now(),attempted_at=now(),status=EXCLUDED.status,reason=EXCLUDED.reason,events=EXCLUDED.events,source='gmgn',coverage=EXCLUDED.coverage`, [pair.wallet, pair.token, revision, proof ? JSON.stringify(proof) : null, currentQuote ? JSON.stringify(currentQuote) : null, coverage.complete ? 'ready' : historical.status === 'ready' ? 'pending' : historical.status, reason ?? null, JSON.stringify(events), JSON.stringify(coverage)]);
      return { events, coverage, proof, quote: currentQuote, reason, source: 'gmgn' as const };
    })().finally(() => pairJobs.delete(key)); job.work = work; pairJobs.set(key, job); return work;
  }
  async function selectedLedger(members: Membership[], foreground = false, cachedOnly = false) {
    const states: JournalHistoryState[] = cachedOnly ? await Promise.all(members.map(async member => {
      const stored = (await db.query(`SELECT * FROM journal_history_jobs WHERE wallet_address=$1 AND scope='all'`, [member.wallet_address])).rows[0];
      const covered = stored && !stored.refresh_pending && (stored.complete || stored.covered_to && Date.parse(stored.covered_to) <= Date.parse(iso(member.activity_from)))
        && stored.head_checked_at && now() - Date.parse(stored.head_checked_at) < 30_000;
      return { status: covered ? 'ready' : stored?.status === 'cooldown' ? 'cooldown' : 'pending', complete: stored?.complete === true,
        coveredTo: stored?.covered_to ? iso(stored.covered_to) : null, ...(!covered ? { reason: stored?.error ?? 'history_preparing', retryAfterMs: 1500 } : {}) } as JournalHistoryState;
    })) : await discover(members, foreground);
    const pairs = await discoveredPairs(members);
    // Share a bounded preparation batch across all cards; rotate pending pairs
    // by their persisted attempt time rather than rescanning six token histories.
    const priorities = (await db.query(`SELECT wallet_address||':'||token_address AS key,attempted_at FROM journal_pair_preparations WHERE wallet_address=ANY($1)`, [members.map(row => row.wallet_address)])).rows;
    const attempts = new Map<string, number>(priorities.map(row => [row.key, row.attempted_at ? Date.parse(row.attempted_at) : 0]));
    const scheduled = cachedOnly ? [] : [...pairs].sort((a, b) => (attempts.get(`${a.wallet}:${a.token}`) ?? 0) - (attempts.get(`${b.wallet}:${b.token}`) ?? 0)).slice(0, foreground ? 3 : 2);
    const prepared = new Map<string, PairEvidence>();
    await Promise.all(scheduled.map(async pair => prepared.set(`${pair.wallet}:${pair.token}`, await evidence(pair, foreground))));
    const events: JournalLedgerEvent[] = [], coverages: JournalLedgerCoverage[] = [], valuations = new Map<string, JournalLedgerValuation>();
    for (const pair of pairs) {
      let value = prepared.get(`${pair.wallet}:${pair.token}`);
      if (!value) {
        const cached = (await db.query(`SELECT p.*,j.complete AS "historyComplete",c.generation AS "currentGeneration" FROM journal_pair_preparations p LEFT JOIN journal_history_jobs j ON j.wallet_address=p.wallet_address AND j.scope=p.token_address LEFT JOIN journal_wallet_coverage c ON c.wallet_address=p.wallet_address WHERE p.wallet_address=$1 AND p.token_address=$2`, [pair.wallet, pair.token])).rows[0];
        const merged = cached?.source === 'node' && cached.events ? { events: cached.events as JournalLedgerEvent[], reasons: [] } : await readPairEvents(pair, cached?.historyComplete === true);
        const currentRevision = digest(merged.events), hasHistory = cached?.source === 'node' ? cached?.coverage?.complete === true && cached.generation === cached.currentGeneration && cached.canonical_revision === await canonicalRevision(pair) : cached?.historyComplete === true;
        const newEvidence = cached?.source === 'node' ? (await db.query(`SELECT EXISTS(SELECT 1 FROM trades WHERE wallet_address=$1 AND token_address=$2 AND block_number>$3) OR EXISTS(SELECT 1 FROM wallet_transfers WHERE wallet_address=$1 AND token_address=$2 AND block_number>$3) AS changed`, [pair.wallet, pair.token, cached.balance_proof?.blockNumber ?? '0'])).rows[0]?.changed : false;
        value = { events: merged.events, proof: cached?.balance_proof ?? null, quote: cached?.quote ?? null, source: cached?.source === 'node' ? 'node' : 'gmgn',
          coverage: { walletAddress: pair.wallet, tokenAddress: pair.token, complete: cached?.status === 'ready' && cached?.coverage?.complete === true && hasHistory && !newEvidence && cached?.history_revision === currentRevision && !merged.reasons.length && cached.balance_proof && now() - Date.parse(cached.balance_proof.checkedAt) <= 180_000, reason: merged.reasons[0] ?? cached?.reason ?? 'history_preparing' } };
      }
      events.push(...value.events); coverages.push(value.coverage);
      let valuation = valuations.get(pair.token);
      if (!valuation) { valuation = { tokenAddress: pair.token, priceUsd: value.quote?.priceUsd ?? null, pricedAt: value.quote?.timestamp ?? new Date(now()).toISOString(), balances: [] }; valuations.set(pair.token, valuation); }
      if (value.quote && (!valuation.priceUsd || Date.parse(value.quote.timestamp) > Date.parse(valuation.pricedAt))) { valuation.priceUsd = value.quote.priceUsd; valuation.pricedAt = value.quote.timestamp; }
      if (value.proof) valuation.balances.push({ walletAddress: pair.wallet, tokenAmount: value.proof.balance });
    }
    const result = calculateJournalLedger({ wallets: members.map(row => row.wallet_address), events, coverage: coverages, valuations: [...valuations.values()], asOf: new Date(now()).toISOString() });
    const waitingReason = (reason?: string) => /^(history_(?:preparing|incomplete)|provider_(?:busy|cooldown|unavailable|timeout)|balance_unavailable|confirmation_pending|decoding_incomplete|indexed_snapshot_changed|quote_)/.test(reason ?? '');
    return { result, pairs, events, states, preparing: states.some(state => ['pending', 'cooldown'].includes(state.status) || waitingReason(state.reason))
      || coverages.some(coverage => !coverage.complete && waitingReason(coverage.reason)) || result.reasons.some(waitingReason) };
  }
  async function summary(userId: string, selected?: string): Promise<JournalSummary> {
    const members = await memberships(userId, selected), revision = journalWalletSetIdentity(members), key = `${userId}:${revision}`;
    const build = async (cachedOnly = false) => {
      const { result, pairs, states, preparing } = await selectedLedger(members, false, cachedOnly);
      const discoveryComplete = states.every(state => state.status === 'ready');
      const complete = result.complete && discoveryComplete;
      const reasons = [...new Set([...result.reasons, ...states.filter(state => state.status !== 'ready').map(state => state.reason ?? 'history_preparing')])];
      const observed = result.positions.map(position => Date.parse(position.pricedAt ?? '')).filter(Number.isFinite);
      const asOf = observed.length ? new Date(Math.min(...observed)).toISOString() : result.asOf;
      const snapshotId = digest([revision, asOf, result.positions]);
      const response: JournalSummary = { version: 1, snapshotId, selectedWallets: result.wallets, asOf,
        activityFrom: members.length ? new Date(Math.min(...members.map(member => Date.parse(iso(member.activity_from))))).toISOString() : null,
        coverage: 'available_position_history', complete, preparing, reasons,
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
    // Provider recovery continues once per shared job, while ordinary page
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
    let timer: ReturnType<typeof setTimeout> | undefined;
    const recovery = discover(members);
    const states = await Promise.race([recovery, new Promise<JournalHistoryState[]>(resolve => { timer = setTimeout(() => resolve(members.map(() => ({ status: 'pending', complete: false, coveredTo: null, reason: 'history_preparing' }))), 500); })]).finally(() => clearTimeout(timer));
    const rows = members.length ? (await db.query(`WITH selected AS (SELECT * FROM unnest($1::text[],$2::timestamptz[]) AS s(wallet,starts)), combined AS (
      SELECT t.id,t.wallet_address,t.token_address,t.side,t.token_amount,t.amount_usd,t.quote_amount,t.quote_symbol,t.tx_hash,t.timestamp,t.source FROM trades t JOIN selected s ON s.wallet=t.wallet_address
        WHERE t.timestamp>=s.starts AND t.timestamp<=now() AND t.block_number IS NOT NULL AND t.side IN('buy','sell')
      UNION ALL SELECT m.event_key,m.wallet_address,m.token_address,m.kind,m.token_amount,m.amount_usd,m.quote_amount,m.quote_symbol,m.tx_hash,m.timestamp,'gmgn'
        FROM journal_provider_movements m JOIN selected s ON s.wallet=m.wallet_address WHERE m.timestamp>=s.starts AND m.timestamp<=now() AND m.kind IN('buy','sell')
          AND NOT EXISTS(SELECT 1 FROM trades t WHERE t.wallet_address=m.wallet_address AND t.token_address=m.token_address AND t.tx_hash=m.tx_hash AND t.side=m.kind AND t.block_number IS NOT NULL))
      SELECT c.id,c.wallet_address AS "walletAddress",c.token_address AS "tokenAddress",v.symbol AS "tokenSymbol",v.name AS "tokenName",
        CASE WHEN v.logo_data IS NOT NULL THEN '/api/token-image/'||v.address||'?v='||md5(v.logo_data) END AS "tokenLogoUrl",c.side,c.token_amount::text AS "tokenAmount",c.amount_usd::text AS "amountUsd",
        c.quote_amount::text AS "quoteAmount",c.quote_symbol AS "quoteSymbol",c.tx_hash AS "txHash",c.timestamp,c.source
      FROM combined c JOIN tokens v ON v.address=c.token_address WHERE ${kolProfileTokenSql()} ORDER BY c.timestamp DESC,c.id DESC LIMIT 26 OFFSET $3`, [members.map(row => row.wallet_address), members.map(row => iso(row.activity_from)), Number(cursor ?? 0)])).rows : [];
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
    // Authorize before touching shared provider/cache work, and again after it.
    let result = await loadActivity({ wallet, token, replay: false, pnl: false, allowPrivate: true, skipInventory: true });
    if (result) {
      const metadata = (await db.query('SELECT decimals FROM tokens WHERE address=$1', [token])).rows[0];
      const prepared = await evidence({ wallet, token, decimals: metadata?.decimals ?? null, symbol: result.token.symbol, name: result.token.name, logoUrl: result.token.logoUrl }, true);
      if (prepared.proof) result = applyJournalReplay(result, { events: prepared.events, proof: prepared.proof, coverageComplete: prepared.coverage.complete,
        quote: prepared.quote, source: prepared.source, now: now() });
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
      SELECT timestamp FROM trades WHERE wallet_address=$1 AND token_address=$2 AND block_number IS NOT NULL AND timestamp<=now()
      UNION ALL SELECT timestamp FROM journal_provider_movements WHERE wallet_address=$1 AND token_address=$2 AND timestamp<=now()) movements`, [wallet, token]);
    if (!rows.rows[0]?.first) throw new JournalInputError('No trading history is available yet', 404);
    const metadata = (await db.query(`SELECT CASE WHEN total_supply_raw>0 AND decimals BETWEEN 0 AND 36 AND supply_checked_at>now()-interval '2 days' THEN (total_supply_raw/power(10::numeric,decimals))::text END AS supply FROM tokens WHERE address=$1 AND ${kolProfileTokenSql('tokens')}`, [token])).rows[0];
    if (!metadata) throw new JournalInputError('Journal token activity not found', 404);
    const movements = frozen?.replayAccounting?.history?.events ?? frozen?.replayAccounting?.events;
    const first = movements?.length ? Math.min(...movements.map(event => Date.parse(event.timestamp))) : Date.parse(rows.rows[0].first);
    const last = movements?.length ? Math.max(...movements.map(event => Date.parse(event.timestamp))) : Date.parse(rows.rows[0].last);
    let value = await chart(token, first, last, current, frozen ? frozen.token.marketCapSupply : metadata.supply ?? null);
    const ending = frozen?.realizedAccounting?.position;
    if (current && ending?.priceUsd && ending.pricedAt) value = { ...value, currentQuote: { priceUsd: ending.priceUsd, timestamp: ending.pricedAt } };
    await authorize(userId, wallet, member.revision); return value;
  }
  return { list, add, updateLabel, remove, older, summary, activity, tokenActivity, replayChart, authorize };
}
export const journalService = createJournalService();
