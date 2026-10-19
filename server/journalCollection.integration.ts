import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { initializeJournalCollectionBoundary, nextJournalCollectionRepair, recordJournalCollectionRange, rollbackJournalCollection } from './journalCollection.js';

// Exercise PostgreSQL's actual parameter inference, rather than a mocked query.
// The test owns a new database and never changes the configured application DB.
const configured = new URL(process.env.DATABASE_URL ?? 'postgres://invalid');
if (!['localhost', '127.0.0.1'].includes(configured.hostname) || configured.port !== '5435') throw new Error('Disposable local PostgreSQL only');
const admin = new pg.Client({ connectionString: configured.href });
await admin.connect();
const name = `journal_collection_test_${randomUUID().replaceAll('-', '')}`;
await admin.query(`CREATE DATABASE "${name}"`);
const connection = new URL(configured); connection.pathname = `/${name}`;
const database = new pg.Pool({ connectionString: connection.href });
const wallet = `0x${'a'.repeat(40)}`, newerWallet = `0x${'b'.repeat(40)}`;
const generation = randomUUID(), newerGeneration = randomUUID();
const hash = `0x${'1'.repeat(64)}`, orphanHash = `0x${'2'.repeat(64)}`, parentHash = `0x${'3'.repeat(64)}`;
// Deliberately exceed PostgreSQL int4: all block arithmetic must remain bigint.
const boundary = 3_000_000_000;
try {
  await database.query(`CREATE TABLE journal_wallet_coverage(
      wallet_address text PRIMARY KEY,generation uuid NOT NULL,registration_block bigint,registration_hash text,
      repair_from_block bigint,collected_from_block bigint,collected_through_block bigint,
      history_complete boolean DEFAULT false,last_error text,updated_at timestamptz DEFAULT now());
    CREATE TABLE journal_wallets(wallet_address text PRIMARY KEY,registration_block bigint,registration_hash text,revision uuid NOT NULL);
    CREATE TABLE worker_state(key text PRIMARY KEY,value jsonb NOT NULL);
    CREATE TABLE processed_blocks(block_number bigint PRIMARY KEY,block_hash text NOT NULL);
    CREATE TABLE journal_node_evidence(block_number bigint NOT NULL);
    CREATE TABLE journal_opening_balances(block_number bigint NOT NULL);
    CREATE TABLE journal_pair_preparations(status text,checked_at timestamptz,balance_proof jsonb,quote jsonb,reason text);
    CREATE TABLE journal_replay_snapshots(id text PRIMARY KEY);
    CREATE TABLE journal_snapshots(id text PRIMARY KEY);`);
  await database.query(`INSERT INTO journal_wallet_coverage(wallet_address,generation) VALUES($1,$2),($3,$4);
    `, [wallet, generation, newerWallet, newerGeneration]);
  await database.query(`INSERT INTO journal_wallets(wallet_address,revision) VALUES($1,$2),($3,$4)`, [wallet, randomUUID(), newerWallet, randomUUID()]);
  const generations = new Map([[wallet, generation], [newerWallet, randomUUID()]]);
  await initializeJournalCollectionBoundary(database, new Set([wallet, newerWallet]), { number: boundary, hash }, generations);
  const initialized = (await database.query('SELECT * FROM journal_wallet_coverage WHERE wallet_address=$1', [wallet])).rows[0];
  assert.equal(initialized.registration_block, String(boundary));
  assert.equal(initialized.repair_from_block, String(boundary + 1));
  assert.equal((await database.query('SELECT registration_block FROM journal_wallets WHERE wallet_address=$1', [wallet])).rows[0].registration_block, String(boundary));
  assert.equal((await database.query('SELECT registration_block FROM journal_wallet_coverage WHERE wallet_address=$1', [newerWallet])).rows[0].registration_block, null,
    'An older captured generation must not initialize a re-added subscription');

  await database.query(`INSERT INTO worker_state(key,value) VALUES('node',$1::jsonb)`, [JSON.stringify({ blockNumber: boundary + 10 })]);
  await recordJournalCollectionRange(database, new Set([wallet]), boundary + 1, boundary + 4, true, generations);
  assert.deepEqual(await nextJournalCollectionRepair(database, boundary + 10), { wallet, from: boundary + 5, to: boundary + 10 });
  await recordJournalCollectionRange(database, new Set([wallet]), boundary + 5, boundary + 10, true, generations);
  assert.equal(await nextJournalCollectionRepair(database, boundary + 10), null, 'The repair cursor clears only after reaching the committed checkpoint');
  const collected = (await database.query('SELECT collected_from_block,collected_through_block FROM journal_wallet_coverage WHERE wallet_address=$1', [wallet])).rows[0];
  assert.deepEqual(collected, { collected_from_block: String(boundary + 1), collected_through_block: String(boundary + 10) });
  await recordJournalCollectionRange(database, new Set([wallet]), boundary + 11, boundary + 20, false, new Map([[wallet, randomUUID()]]));
  assert.equal((await database.query('SELECT collected_through_block FROM journal_wallet_coverage WHERE wallet_address=$1', [wallet])).rows[0].collected_through_block, String(boundary + 10));

  // A subscription established inside an orphaned segment moves to its verified
  // parent and receives a fresh revision. Existing earlier boundaries stay put.
  await initializeJournalCollectionBoundary(database, new Set([newerWallet]), { number: boundary + 9, hash: orphanHash }, new Map([[newerWallet, newerGeneration]]));
  const previousRevision = (await database.query('SELECT revision FROM journal_wallets WHERE wallet_address=$1', [newerWallet])).rows[0].revision;
  await database.query('INSERT INTO processed_blocks(block_number,block_hash) VALUES($1::bigint,$2)', [boundary + 1, parentHash]);
  await database.query('INSERT INTO journal_node_evidence(block_number) VALUES($1::bigint),($2::bigint)', [boundary + 1, boundary + 2]);
  await database.query('INSERT INTO journal_opening_balances(block_number) VALUES($1::bigint),($2::bigint)', [boundary + 1, boundary + 2]);
  await database.query(`INSERT INTO journal_pair_preparations VALUES('ready',now(),'{}','{}',NULL);
    INSERT INTO journal_replay_snapshots VALUES('replay'); INSERT INTO journal_snapshots VALUES('summary');`);
  await rollbackJournalCollection(database, boundary + 2);
  const rewound = (await database.query('SELECT registration_block,registration_hash,revision FROM journal_wallets WHERE wallet_address=$1', [newerWallet])).rows[0];
  assert.equal(rewound.registration_block, String(boundary + 1));
  assert.equal(rewound.registration_hash, parentHash);
  assert.notEqual(rewound.revision, previousRevision);
  assert.equal((await database.query('SELECT registration_block FROM journal_wallets WHERE wallet_address=$1', [wallet])).rows[0].registration_block, String(boundary));
  assert.equal((await database.query('SELECT count(*)::int n FROM journal_node_evidence')).rows[0].n, 1);
  assert.equal((await database.query('SELECT count(*)::int n FROM journal_opening_balances')).rows[0].n, 1);
  assert.equal((await database.query('SELECT collected_through_block FROM journal_wallet_coverage WHERE wallet_address=$1', [wallet])).rows[0].collected_through_block, String(boundary + 1));
  assert.equal((await database.query('SELECT status,reason FROM journal_pair_preparations')).rows[0].status, 'pending');
  assert.equal((await database.query('SELECT count(*)::int n FROM journal_replay_snapshots')).rows[0].n, 0);
  assert.equal((await database.query('SELECT count(*)::int n FROM journal_snapshots')).rows[0].n, 0);
  console.log('Journal collection PostgreSQL regression passed: initialization, bigint ranges, generation protection, repairs and reorg rollback');
} finally {
  await database.end();
  await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
  await admin.end();
}
