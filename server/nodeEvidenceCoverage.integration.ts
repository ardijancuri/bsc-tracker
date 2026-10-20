import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { backfillNodeEvidenceCoverageCohorts, ensureNodeEvidenceCoverageSchema,
  persistNodeEvidenceCoverageCohort, readNodeEvidenceCoverageRanges } from './nodeEvidenceCoverage.js';

const source = new URL(process.env.DATABASE_URL || 'postgres://invalid');
if (!['localhost', '127.0.0.1'].includes(source.hostname) || source.port !== '5435') throw Error('Disposable local PostgreSQL only');
const admin = new pg.Client({ connectionString: source.href }); await admin.connect();
const name = 'node_coverage_test_' + randomUUID().replaceAll('-', '');
await admin.query(`CREATE DATABASE "${name}"`);
const target = new URL(source); target.pathname = '/' + name;
const db = new pg.Pool({ connectionString: target.href, max: 4 });
const wallet = '0x' + 'a'.repeat(40), other = '0x' + 'b'.repeat(40), generation = randomUUID(), nextGeneration = randomUUID();
const members = { [wallet]: generation, [other]: nextGeneration };
const coverage = () => readNodeEvidenceCoverageRanges(db, { wallet, generation, fromBlock: '100', toBlock: '200' });
try {
  await db.query(`CREATE TABLE node_evidence_ranges(id bigserial PRIMARY KEY,from_block bigint NOT NULL,to_block bigint NOT NULL,
    wallets jsonb NOT NULL,decoded_at timestamptz)`);
  await ensureNodeEvidenceCoverageSchema(db); await ensureNodeEvidenceCoverageSchema(db);
  const fingerprint = await persistNodeEvidenceCoverageCohort(db, members);
  assert.match(fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(await persistNodeEvidenceCoverageCohort(db, { [other]: nextGeneration, [wallet]: generation }), fingerprint,
    'Canonical JSONB ordering gives captures and legacy backfill the same fingerprint');
  assert.equal((await db.query('SELECT count(*)::int n FROM node_evidence_cohorts')).rows[0].n, 1);
  for (const [from, to, decoded, map, cohort] of [
    [101, 120, true, members, null], [121, 130, true, members, fingerprint],
    [132, 140, true, members, null], [131, 131, false, members, null],
    [141, 150, true, { [wallet]: nextGeneration }, null],
    [151, 160, true, members, null], [160, 165, true, members, null],
  ] as const) await db.query(`INSERT INTO node_evidence_ranges(from_block,to_block,wallets,decoded_at,cohort_fingerprint)
    VALUES($1,$2,$3::jsonb,CASE WHEN $4::boolean THEN now() END,$5)`, [from, to, JSON.stringify(map), decoded, cohort]);
  const expected = [{ fromBlock: '101', toBlock: '130' }, { fromBlock: '132', toBlock: '140' }, { fromBlock: '151', toBlock: '165' }];
  assert.deepEqual(await coverage(), expected, 'Legacy and normalized coverage retain actual gaps, overlaps and decoding boundaries');
  const first = await backfillNodeEvidenceCoverageCohorts(db, { limit: 1 });
  assert.deepEqual(first, { processed: 1, remaining: true });
  assert.deepEqual(await coverage(), expected, 'An interrupted migration leaves the exact same coverage');
  const parallel = await Promise.all([backfillNodeEvidenceCoverageCohorts(db, { limit: 1 }), backfillNodeEvidenceCoverageCohorts(db, { limit: 1 })]);
  assert.equal(parallel.reduce((total, row) => total + row.processed, 0), 2, 'Concurrent batches claim distinct legacy rows');
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    assert.equal((await backfillNodeEvidenceCoverageCohorts(client, { limit: 1 })).processed, 1);
    await client.query('ROLLBACK');
  } finally { client.release(); }
  const rest = await backfillNodeEvidenceCoverageCohorts(db, { limit: 5000 });
  assert.equal(rest.processed, 3); assert.equal(rest.remaining, false);
  assert.deepEqual(await backfillNodeEvidenceCoverageCohorts(db), { processed: 0, remaining: false }, 'Completed backfill is idempotent');
  assert.equal((await db.query('SELECT count(*)::int n FROM node_evidence_cohorts')).rows[0].n, 2, 'Repeated maps are stored once per generation cohort');
  assert.equal((await db.query('SELECT count(*)::int n FROM node_evidence_ranges WHERE wallets IS NOT NULL')).rows[0].n, 7,
    'Migration preserves every original range map for rollback and audit');
  assert.deepEqual(await coverage(), expected);
  assert.deepEqual(await readNodeEvidenceCoverageRanges(db, { wallet, generation: nextGeneration, fromBlock: '100', toBlock: '200' }),
    [{ fromBlock: '141', toBlock: '150' }], 'Another monitoring generation cannot borrow earlier coverage');
  await db.query('UPDATE node_evidence_ranges SET decoded_at=now() WHERE from_block=131');
  assert.deepEqual(await coverage(), [{ fromBlock: '101', toBlock: '140' }, { fromBlock: '151', toBlock: '165' }]);
  await db.query('DELETE FROM node_evidence_ranges WHERE from_block>=151');
  assert.deepEqual(await coverage(), [{ fromBlock: '101', toBlock: '140' }], 'Reorg range removal immediately removes its coverage without a stale aggregate cache');
  await assert.rejects(db.query('INSERT INTO node_evidence_cohorts(fingerprint,wallets) VALUES($1,$2::jsonb)', ['0'.repeat(64), JSON.stringify(members)]), /check constraint/);
  console.log('Node evidence cohort integration passed: canonical capture, exact merged coverage, gaps/generations, bounded concurrent migration, rollback and reorg.');
} finally { await db.end(); await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`); await admin.end(); }
