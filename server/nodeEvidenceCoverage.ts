import type { PoolClient } from 'pg';

type Database = Pick<PoolClient, 'query'>;
const fingerprintSql = (wallets: string) => `encode(sha256(convert_to(${wallets}::text,'UTF8')),'hex')`;

/** One immutable monitoring generation map per cohort. Existing raw range maps
 * remain available for rollback/audit while old rows migrate incrementally. */
export async function ensureNodeEvidenceCoverageSchema(database: Database) {
  await database.query(`CREATE TABLE IF NOT EXISTS node_evidence_cohorts(
      fingerprint text PRIMARY KEY,wallets jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
      CHECK(fingerprint=${fingerprintSql('wallets')}));
    ALTER TABLE node_evidence_ranges ADD COLUMN IF NOT EXISTS cohort_fingerprint text;
    CREATE INDEX IF NOT EXISTS node_evidence_ranges_cohort_backfill ON node_evidence_ranges(id) WHERE cohort_fingerprint IS NULL;
    CREATE INDEX IF NOT EXISTS node_evidence_ranges_completed_bounds ON node_evidence_ranges(to_block,from_block,cohort_fingerprint)
      WHERE decoded_at IS NOT NULL;
    CREATE INDEX IF NOT EXISTS node_evidence_ranges_completed_cohort ON node_evidence_ranges(cohort_fingerprint,to_block,from_block)
      WHERE decoded_at IS NOT NULL AND cohort_fingerprint IS NOT NULL;`);
}

/** Call in the collection transaction, before committing its range/checkpoint.
 * PostgreSQL JSONB text is the canonical serialization for capture and import. */
export async function persistNodeEvidenceCoverageCohort(database: Database, wallets: Record<string, string>) {
  const result = await database.query(`WITH canonical AS MATERIALIZED(SELECT $1::jsonb AS wallets),
    inserted AS(INSERT INTO node_evidence_cohorts(fingerprint,wallets)
      SELECT ${fingerprintSql('wallets')},wallets FROM canonical ON CONFLICT(fingerprint) DO NOTHING RETURNING fingerprint)
    SELECT ${fingerprintSql('wallets')} AS fingerprint FROM canonical`, [JSON.stringify(wallets)]);
  return String(result.rows[0].fingerprint);
}

/** Each committed batch is resumable and safe alongside capture, reorg and
 * another backfill worker. Repeated wallet maps are decompressed only once per
 * legacy row during migration, never for each future accounting preparation. */
export async function backfillNodeEvidenceCoverageCohorts(database: Database, options: { limit?: number } = {}) {
  const requested = options.limit ?? 1000;
  const limit = Number.isFinite(requested) ? Math.max(1, Math.min(5000, Math.trunc(requested))) : 1000;
  const result = await database.query(`WITH pending AS MATERIALIZED(
      SELECT id,wallets FROM node_evidence_ranges WHERE cohort_fingerprint IS NULL ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED),
    hashed AS MATERIALIZED(SELECT id,wallets,${fingerprintSql('wallets')} AS fingerprint FROM pending),
    inserted AS(INSERT INTO node_evidence_cohorts(fingerprint,wallets)
      SELECT DISTINCT ON(fingerprint) fingerprint,wallets FROM hashed ORDER BY fingerprint
      ON CONFLICT(fingerprint) DO NOTHING RETURNING fingerprint),
    updated AS(UPDATE node_evidence_ranges r SET cohort_fingerprint=h.fingerprint FROM hashed h WHERE r.id=h.id RETURNING r.id)
    SELECT (SELECT count(*)::int FROM updated) AS processed,
      EXISTS(SELECT 1 FROM node_evidence_ranges r WHERE r.cohort_fingerprint IS NULL
        AND NOT EXISTS(SELECT 1 FROM updated u WHERE u.id=r.id)) AS remaining`, [limit]);
  return { processed: Number(result.rows[0].processed), remaining: result.rows[0].remaining === true };
}

/** Match the generation map once per cohort, then aggregate index-only range
 * bounds inside PostgreSQL. Return disjoint spans, preserving genuine gaps.
 * Legacy NULL rows remain exact until the bounded background migration lands. */
export async function readNodeEvidenceCoverageRanges(database: Database, options: {
  wallet: string; generation: string; fromBlock: string; toBlock: string;
}): Promise<{ fromBlock: string; toBlock: string }[]> {
  const result = await database.query(`WITH matching_cohorts AS MATERIALIZED(
      SELECT fingerprint FROM node_evidence_cohorts WHERE wallets->>$1=$4),
    eligible AS(
      SELECT r.from_block,r.to_block FROM node_evidence_ranges r JOIN matching_cohorts c ON c.fingerprint=r.cohort_fingerprint
        WHERE r.decoded_at IS NOT NULL AND r.to_block>$2::bigint AND r.from_block<=$3::bigint
      UNION ALL
      SELECT r.from_block,r.to_block FROM node_evidence_ranges r WHERE r.cohort_fingerprint IS NULL
        AND r.decoded_at IS NOT NULL AND r.to_block>$2::bigint AND r.from_block<=$3::bigint AND r.wallets->>$1=$4),
    covered AS(SELECT range_agg(int8range(from_block,to_block,'[]')) AS spans FROM eligible)
    SELECT lower(span)::text AS "fromBlock",(upper(span)-1)::text AS "toBlock"
      FROM covered CROSS JOIN LATERAL unnest(spans) span ORDER BY lower(span)`,
  [options.wallet, options.fromBlock, options.toBlock, options.generation]);
  return result.rows;
}
