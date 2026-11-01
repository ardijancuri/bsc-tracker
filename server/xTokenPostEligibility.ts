import type { Pool } from 'pg';
import type { TokenPostEvidence } from '../shared/xTokenPosts.js';
import { memeTokenSql } from './memeToken.js';
import { kolProfileTokenSql } from './kolProfileToken.js';
import { MarketDecimal } from './nodeMarketMath.js';

type Database = Pick<Pool, 'query'>;
export type TokenPostEligibilityDiagnostic = { tokenAddress?: string; reason:
  'checkpoint_unavailable' | 'indexer_lag' | 'no_holders' | 'insufficient_holders' | 'participant_limit' | 'unverified_canonical' | 'eligible' };
type Options = { now?: number; token?: string; limit?: number; discovery?: boolean;
  onDiagnostic?: (event: TokenPostEligibilityDiagnostic) => void };
export type TokenPostEligibilityResult = { candidates: TokenPostEvidence[]; reason: 'checkpoint_unavailable' | 'indexer_lag' | null; evaluatedAt: string | null };
export const tokenPostEligibilityLimits = { minKols: 4, candidates: 20, holders: 2000, checkpointAgeMs: 120_000 } as const;
const validAddress = (value: unknown): value is string => typeof value === 'string' && /^0x[0-9a-f]{40}$/.test(value);
const validHash = (value: unknown): value is string => typeof value === 'string' && /^0x[0-9a-f]{64}$/.test(value);
const block = (value: unknown) => value == null || value === '' || !/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value)) ? null : Number(value);
function positive(value: unknown): value is string {
  try { return typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value) && MarketDecimal.parse(value).compare(MarketDecimal.parse('0')) > 0; } catch { return false; }
}
function report(options: Options, reason: TokenPostEligibilityDiagnostic['reason'], tokenAddress?: string) {
  try { options.onDiagnostic?.({ reason, ...(tokenAddress ? { tokenAddress } : {}) }); } catch { /* Diagnostics never change eligibility. */ }
}

// Use existing current positions, independently of P&L, market volume and prices.
// A matched balance remains usable while capture proves no later movement or
// undecoded receipt. Older balance headers may expire under the 72-hour policy;
// their durable matched proof is invalidated by the existing reorg handler.
const holdingFrom = `FROM fresh.positions p
  JOIN fresh.accounting_scopes s ON s.id=p.scope_id AND s.kind='kol' AND s.active AND s.account_id IS NULL
    AND cardinality(s.wallet_addresses)=1
  JOIN fresh.kols k ON k.wallet_address=s.wallet_addresses[1] AND s.id='kol:'||k.wallet_address AND k.is_tracked
  JOIN published_kols public_kol ON public_kol.address=k.wallet_address AND public_kol.is_tracked
  JOIN fresh.wallets w ON w.address=k.wallet_address AND w.active
  JOIN fresh.tokens v ON v.address=p.token_address
  JOIN LATERAL(SELECT e.id FROM fresh.financial_events e
    WHERE e.wallet_address=k.wallet_address AND e.token_address=p.token_address AND e.kind='buy'
      AND e.canonical AND e.observed_live AND e.block_number<=p.balance_block
      AND e.block_number>=greatest(s.starts_block,w.monitoring_from_block) AND e.occurred_at>=s.starts_at
      AND CASE WHEN e.quantity ~ '^[0-9]+(\\.[0-9]+)?$' THEN e.quantity::numeric>0 ELSE false END
    ORDER BY e.block_number DESC,e.id DESC LIMIT 1) purchase ON true
  WHERE p.balance_status='matched' AND p.balance_block<=$2::bigint AND p.balance_hash ~ '^0x[0-9a-f]{64}$'
    AND p.balance_checked_at<=$1::timestamptz AND p.balance_checked_at>=p.last_event_at
    AND CASE WHEN p.balance_quantity ~ '^[0-9]+(\\.[0-9]+)?$' AND p.quantity_q ~ '^[0-9]+(/[1-9][0-9]*)?$'
      THEN p.balance_quantity::numeric>0 AND p.balance_quantity::numeric *
        CASE WHEN position('/' IN p.quantity_q)>0 THEN split_part(p.quantity_q,'/',2)::numeric ELSE 1 END
        = split_part(p.quantity_q,'/',1)::numeric ELSE false END
    AND (w.monitoring_to_block IS NULL OR w.monitoring_to_block>=$2::bigint)
    AND NOT EXISTS(SELECT 1 FROM fresh.recent_blocks orphan WHERE orphan.block_number=p.balance_block AND orphan.block_hash<>p.balance_hash)
    AND NOT EXISTS(SELECT 1 FROM fresh.financial_events later WHERE later.wallet_address=k.wallet_address
      AND later.token_address=p.token_address AND later.canonical AND later.kind IN('buy','sell','transfer_in','transfer_out')
      AND later.block_number>p.balance_block AND later.block_number<=$2::bigint)
    AND NOT EXISTS(SELECT 1 FROM fresh.recent_evidence pending WHERE pending.wallet_addresses @> ARRAY[k.wallet_address]
      AND pending.block_number>p.balance_block AND pending.block_number<=$2::bigint AND pending.decoder_status<>'done')
    AND NOT(w.decode_gap_from_block IS NOT NULL AND w.decode_gap_from_block>p.balance_block AND w.decode_gap_from_block<=$2::bigint)
    AND v.launch_status IN('eligible','preexisting') AND ${memeTokenSql('v')} AND ${kolProfileTokenSql('v')}`;

async function capture(db: Database, now: number) {
  const available = (await db.query(`/* x-post fresh schema */ SELECT to_regclass('fresh.positions') IS NOT NULL AS ready`)).rows[0]?.ready;
  if (!available) return null;
  return (await db.query(`/* x-post checkpoint */ SELECT c.block_number::text,c.block_hash,b.occurred_at AS timestamp
    FROM fresh.checkpoints c JOIN fresh.recent_blocks b USING(block_number,block_hash)
    WHERE c.key='capture' AND b.occurred_at<=$1::timestamptz`, [new Date(now).toISOString()])).rows[0] ?? null;
}

async function holders(db: Database, token: string, evaluatedAt: string, blockNumber: number) {
  return (await db.query(`/* x-post holders */ SELECT k.wallet_address,k.display_name,k.avatar_url,public_kol.twitter,p.balance_quantity AS balance,
    p.balance_block::text,p.balance_hash,p.revision::text,purchase.id AS buy_event_id,
    v.name,v.symbol,v.logo_url,v.website_url,
    CASE WHEN v.valuation_status='ready' AND v.price_source='node' AND v.total_supply_raw>0 AND v.decimals IS NOT NULL
      AND v.observed_at BETWEEN $1::timestamptz-interval '2 minutes' AND $1::timestamptz AND v.observed_block<=$2::bigint
      AND EXISTS(SELECT 1 FROM fresh.recent_blocks quote_header WHERE quote_header.block_number=v.observed_block AND quote_header.block_hash=v.observed_hash)
      THEN v.market_cap_usd::text ELSE NULL END AS optional_market_cap,
    v.observed_block::text,v.observed_hash,v.observed_at
    ${holdingFrom} AND p.token_address=$3 ORDER BY k.wallet_address LIMIT ${tokenPostEligibilityLimits.holders + 1}`,
  [evaluatedAt, blockNumber, token])).rows;
}

function confirmedHolders(rows: any[], blockNumber: number) {
  const distinct = new Map<string, any>();
  for (const row of rows) {
    const height = block(row.balance_block);
    if (validAddress(row.wallet_address) && positive(row.balance) && height !== null && height <= blockNumber
      && validHash(row.balance_hash) && typeof row.buy_event_id === 'string' && row.buy_event_id
      && /^\d+$/.test(String(row.revision))) distinct.set(row.wallet_address, row);
  }
  return [...distinct.values()];
}

// The public roster may contain several wallets for the same KOL. Retain every
// wallet proof, but count a recorded X identity once. Unlinked roster entries
// remain separate; names alone cannot establish that two wallets are one KOL.
function distinctKolCount(rows: any[]) {
  return new Set(rows.map(row => {
    const raw = typeof row.twitter === 'string' ? row.twitter.trim() : '';
    if (/^@?[A-Za-z0-9_]{1,15}$/.test(raw)) return 'x:' + raw.replace(/^@/, '').toLowerCase();
    try {
      const url = new URL(raw), handle = url.pathname.match(/^\/([A-Za-z0-9_]{1,15})\/?$/)?.[1];
      if (url.protocol === 'https:' && !url.username && !url.password && !url.port && handle
        && ['x.com','twitter.com','www.x.com','www.twitter.com'].includes(url.hostname.toLowerCase())
        && !/^(?:home|explore|search|intent|i|share|settings|messages)$/i.test(handle)) return 'x:' + handle.toLowerCase();
    } catch { /* No verified public X identity: use the public roster wallet. */ }
    return 'wallet:' + row.wallet_address;
  })).size;
}

export async function readTokenPostCandidates(db: Database, options: Options = {}): Promise<TokenPostEligibilityResult> {
  const now = options.now ?? Date.now();
  if (!Number.isFinite(now)) throw new Error('invalid_token_post_time');
  const token = options.token?.toLowerCase() ?? null;
  if (token && !validAddress(token)) throw new Error('invalid_token_post_address');
  const limit = Number.isFinite(options.limit) ? Math.max(1, Math.min(20, Math.floor(options.limit!))) : 20;
  const checkpoint = await capture(db, now), height = block(checkpoint?.block_number);
  if (!checkpoint || height === null || !validHash(checkpoint.block_hash) || !Number.isFinite(new Date(checkpoint.timestamp).getTime())) {
    report(options, 'checkpoint_unavailable', token ?? undefined);
    return { candidates: [], reason: 'checkpoint_unavailable', evaluatedAt: null };
  }
  const evaluatedAt = new Date(checkpoint.timestamp).toISOString();
  if (now - Date.parse(evaluatedAt) > tokenPostEligibilityLimits.checkpointAgeMs) {
    report(options, 'indexer_lag', token ?? undefined);
    return { candidates: [], reason: 'indexer_lag', evaluatedAt };
  }
  const undiscovered = options.discovery && !token ? `AND NOT EXISTS(SELECT 1 FROM x_token_post_jobs j
    WHERE j.chain_id=56 AND j.account_username='kollens' AND j.token_address=p.token_address
      AND NOT(j.status IN ('deferred','cancelled') AND j.dispatch_started_at IS NULL AND j.post_id IS NULL))` : '';
  const potential = (await db.query(`/* x-post candidates */ SELECT p.token_address,max(p.last_event_at) AS latest
    ${holdingFrom} AND ($3::text IS NULL OR p.token_address=$3) ${undiscovered}
    GROUP BY p.token_address HAVING count(DISTINCT k.wallet_address)>=${tokenPostEligibilityLimits.minKols} ORDER BY latest DESC,p.token_address LIMIT $4`,
  [evaluatedAt, height, token, limit])).rows;
  if (!potential.length) report(options, 'no_holders', token ?? undefined);
  const candidates: TokenPostEvidence[] = [];
  for (const candidate of potential) {
    const rows = await holders(db, candidate.token_address, evaluatedAt, height);
    if (rows.length > tokenPostEligibilityLimits.holders) { report(options, 'participant_limit', candidate.token_address); continue; }
    const people = confirmedHolders(rows, height);
    const kolCount = distinctKolCount(people);
    if (kolCount < tokenPostEligibilityLimits.minKols) { report(options, 'insufficient_holders', candidate.token_address); continue; }
    const first = people[0], cap = positive(first.optional_market_cap) ? first.optional_market_cap : null;
    const evidence: TokenPostEvidence = { version: 2, chainId: 56, eligibilityPolicy: 'current_holders_v1',
      token: { address: candidate.token_address, name: first.name || first.symbol || candidate.token_address,
        symbol: first.symbol || '', logoUrl: first.logo_url, websiteUrl: first.website_url },
      evaluatedAt, windowStart: evaluatedAt, blockNumber: height, blockHash: checkpoint.block_hash,
      quoteBlockNumber: cap ? block(first.observed_block) : null, quoteBlockHash: cap ? first.observed_hash : null,
      quoteObservedAt: cap ? new Date(first.observed_at).toISOString() : null,
      kolCount, buyerCount: kolCount, sellerCount: 0,
      marketVolumeUsd: null, marketVolumeLowerBound: true, marketCapUsd: cap, coverageComplete: true,
      participants: people.map(p => ({ wallet: p.wallet_address, name: p.display_name || p.wallet_address, twitterUsername:p.twitter??null,imageUrl: p.avatar_url, side: 'buy' })),
      tradeEvidenceIds: people.map(p => p.buy_event_id), marketEvidenceIds: [],
      holdingProofs: people.map(p => ({ wallet: p.wallet_address, balance: p.balance, blockNumber: Number(p.balance_block),
        blockHash: p.balance_hash, buyEventId: p.buy_event_id, positionRevision: String(p.revision) })) };
    if (await tokenPostEvidenceIsCanonical(db, evidence)) { candidates.push(evidence); report(options, 'eligible', candidate.token_address); }
    else report(options, 'unverified_canonical', candidate.token_address);
  }
  return { candidates, reason: null, evaluatedAt };
}

/** Old five-traders-in-an-hour jobs cannot dispatch under this new policy. */
export async function tokenPostEvidenceIsCanonical(db: Database, evidence: TokenPostEvidence): Promise<boolean> {
  const proofs = evidence.holdingProofs;
  if (evidence.version !== 2 || evidence.eligibilityPolicy !== 'current_holders_v1' || evidence.chainId !== 56
    || !validAddress(evidence.token.address) || !validHash(evidence.blockHash) || block(evidence.blockNumber) === null
    || !Number.isFinite(Date.parse(evidence.evaluatedAt)) || !proofs || proofs.length < tokenPostEligibilityLimits.minKols || proofs.length > tokenPostEligibilityLimits.holders
    || !Number.isSafeInteger(evidence.kolCount) || evidence.kolCount < tokenPostEligibilityLimits.minKols
    || proofs.length < evidence.kolCount || new Set(proofs.map(p => p.wallet)).size !== proofs.length
    || proofs.some(p => !validAddress(p.wallet) || !positive(p.balance) || !validHash(p.blockHash) || block(p.blockNumber) === null
      || p.blockNumber > evidence.blockNumber || !p.buyEventId || !/^\d+$/.test(p.positionRevision))) return false;
  const valid = (await db.query(`/* x-post canonical evidence */ SELECT EXISTS(SELECT 1 FROM fresh.recent_blocks
    WHERE block_number=$1 AND block_hash=$2 AND occurred_at=$3::timestamptz) AS valid`,
  [evidence.blockNumber, evidence.blockHash, evidence.evaluatedAt])).rows[0]?.valid;
  if (!valid) return false;
  const current = new Map(confirmedHolders(await holders(db, evidence.token.address, evidence.evaluatedAt, evidence.blockNumber), evidence.blockNumber)
    .map(p => [p.wallet_address, p]));
  return proofs.every(proof => { const p = current.get(proof.wallet); return p && p.balance === proof.balance
    && Number(p.balance_block) === proof.blockNumber && p.balance_hash === proof.blockHash && p.buy_event_id === proof.buyEventId
    && String(p.revision) === proof.positionRevision; })
    && distinctKolCount(proofs.map(proof => current.get(proof.wallet))) === evidence.kolCount;
}

export async function revalidateTokenPostEvidence(db: Database, evidence: TokenPostEvidence, options: Omit<Options, 'token' | 'limit'> = {}): Promise<TokenPostEvidence | null> {
  if (!await tokenPostEvidenceIsCanonical(db, evidence)) { report(options, 'unverified_canonical', evidence.token.address); return null; }
  return (await readTokenPostCandidates(db, { ...options, token: evidence.token.address, limit: 1 })).candidates[0] ?? null;
}
