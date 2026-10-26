/** Local transaction-rolled-back fixtures; never starts a collector or validation monitor. */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import { freshDailyLeaderboardPendingSql, freshRollingLeaderboardPendingSql, rankFreshStoredLeaderboard } from './leaderboard.js';

const url = new URL(process.env.DATABASE_URL ?? '');
if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.port !== '5436' || url.pathname !== '/kollens_fresh_20261022_24h')
  throw new Error('Use the existing isolated local Fresh database on port 5436');
const db = new Pool({ connectionString: url.toString(), max: 1 });
const client = await db.connect();
const address = () => `0x${randomBytes(20).toString('hex')}`;
const hash = () => `0x${randomBytes(32).toString('hex')}`;
const wallet = address(), token = address(), unrelated = address(), scope = `kol:${wallet}`;
const day = '2026-10-24';
let checks = 0;
try {
  await client.query('BEGIN');
  // Session-only fixture tables shadow the explicitly rewritten helper tables.
  await client.query(`CREATE TEMP TABLE board_wallets(address text,monitoring_from_block bigint,monitoring_to_block bigint,active boolean DEFAULT true);
    CREATE TEMP TABLE board_evidence(tx_hash text,block_hash text,block_number bigint,wallet_addresses text[],decoder_status text,
      position_dependency_addresses text[],position_dependency_proof text);
    CREATE TEMP TABLE board_blocks(block_number bigint,block_hash text,occurred_at timestamptz,parent_hash text);
    CREATE TEMP TABLE board_results(scope_id text,token_address text,occurred_at timestamptz);
    CREATE TEMP TABLE board_pending(id text,execution_key text,wallet_address text,token_address text,kind text,block_number bigint,occurred_at timestamptz,canonical boolean);
    CREATE TEMP TABLE board_financial(id text,execution_key text,canonical boolean,token_address text,transaction_hash text,block_hash text);
    CREATE TEMP TABLE board_scopes(id text,kind text,wallet_addresses text[],account_id text,starts_block bigint,starts_at timestamptz,active boolean);
    CREATE TEMP TABLE board_tokens(address text,launch_status text,symbol text,name text);
    CREATE TEMP TABLE board_kols(wallet_address text,is_tracked boolean);
    CREATE TEMP TABLE board_launch(token_address text,status text,protocol text,block_number bigint,block_hash text,tx_hash text,log_index integer,launched_at timestamptz,proof jsonb DEFAULT '{}');
    CREATE TEMP TABLE board_checkpoints(key text,block_number bigint,block_hash text,value jsonb);
    CREATE TEMP TABLE board_members(user_id text,wallet_address text,registration_block bigint,activity_from timestamptz);`);
  await client.query('INSERT INTO board_wallets(address)VALUES($1)', [wallet]);
  await client.query('INSERT INTO board_results VALUES($1,$2,$3)', [scope, token, `${day}T00:30:00Z`]);
  const rewrite=(sql:string)=>Object.entries({recent_evidence:'board_evidence',recent_blocks:'board_blocks',scope_event_results:'board_results',pending_trades:'board_pending',
    financial_events:'board_financial',accounting_scopes:'board_scopes',tokens:'board_tokens',wallets:'board_wallets',kols:'board_kols',launch_facts:'board_launch',checkpoints:'board_checkpoints'})
    .reduce((s,[name,target])=>s.replaceAll('fresh.'+name,target),sql).replaceAll('public.journal_wallets','board_members');
  const predicate = rewrite(freshDailyLeaderboardPendingSql());
  const pending = async () => (await client.query(`SELECT ${predicate} AS pending FROM board_wallets w`, [day])).rows[0].pending;
  assert.equal(await pending(), false); checks++;
  const blockHash = hash();
  await client.query('INSERT INTO board_blocks VALUES(1,$1,$2)', [blockHash, '2026-10-23T23:50:00Z']);
  await client.query(`INSERT INTO board_evidence VALUES($1,$2,1,$3,'repair',$4,$5)`, [hash(), blockHash, [wallet], [unrelated], 'a'.repeat(64)]);
  assert.equal(await pending(), false, 'A fully bounded older unrelated execution cannot change today totals'); checks++;
  await client.query('UPDATE board_evidence SET position_dependency_addresses=$1', [[token]]);
  assert.equal(await pending(), true, 'Earlier evidence touching a token used today may change acquisition costs'); checks++;
  await client.query('UPDATE board_evidence SET position_dependency_addresses=$1', [[unrelated]]);
  await client.query('UPDATE board_blocks SET occurred_at=$1', [`${day}T00:01:00Z`]);
  assert.equal(await pending(), true, 'Every new current-day receipt is required, regardless of token overlap'); checks++;
  await client.query('UPDATE board_blocks SET occurred_at=$1', ['2026-10-23T23:50:00Z']);
  await client.query('UPDATE board_evidence SET position_dependency_addresses=NULL');
  assert.equal(await pending(), true, 'Opaque historical execution can affect every wallet book'); checks++;
  await client.query('UPDATE board_evidence SET position_dependency_addresses=$1,position_dependency_proof=NULL', [[unrelated]]);
  assert.equal(await pending(), true, 'An unproven address array cannot clear accounting'); checks++;
  await client.query('UPDATE board_evidence SET position_dependency_proof=$1', ['a'.repeat(64)]);
  await client.query('UPDATE board_blocks SET block_hash=$1', [hash()]);
  assert.equal(await pending(), true, 'Orphaned or unavailable header time is not classified as an older unrelated receipt'); checks++;
  await client.query('UPDATE board_evidence SET decoder_status=$1', ['done']);
  assert.equal(await pending(), false); checks++;
  const rollingPredicate=rewrite(freshRollingLeaderboardPendingSql());
  const rollingPending=async()=> (await client.query(`SELECT ${rollingPredicate} AS pending FROM board_wallets w`,
    ['2026-10-23T12:30:00Z','2026-10-24T12:30:00Z'])).rows[0].pending;
  await client.query('UPDATE board_blocks SET block_hash=$1,occurred_at=$2',[blockHash,'2026-10-23T23:50:00Z']);
  await client.query("UPDATE board_evidence SET decoder_status='repair',position_dependency_addresses=$1",[[unrelated]]);
  assert.equal(await rollingPending(),true,'Yesterday evening is inside rolling24h even after UTC rollover');checks++;
  await client.query('UPDATE board_blocks SET occurred_at=$1',['2026-10-23T12:30:00Z']);
  assert.equal(await rollingPending(),false,'Exact24h boundary is excluded for a proven unrelated receipt');checks++;
  await client.query('UPDATE board_evidence SET position_dependency_addresses=$1',[[token]]);
  assert.equal(await rollingPending(),true,'Earlier purchase evidence for a token used in the window still matters');checks++;
  await client.query('UPDATE board_blocks SET occurred_at=$1',['2026-10-24T12:30:01Z']);
  assert.equal(await rollingPending(),false,'A future receipt does not block an earlier evaluation window');checks++;
  const common = { tradeCount24h: 2, accounting: { complete: true, valuedSellCount: 1, valuedTransferOutCount: 0 } };
  const items = rankFreshStoredLeaderboard([
    { ...common, address: 'known-loss', realizedProfitUsd: '-1' },
    { ...common, address: 'partial-positive', realizedProfitUsd: null, accounting: { ...common.accounting, complete: false } },
    { ...common, address: 'known-profit', realizedProfitUsd: '10' },
  ]);
  assert.deepEqual(items.map(row => [row.address, row.rank]), [['known-profit', 1], ['known-loss', 2], ['partial-positive', null]]); checks++;
  console.log(JSON.stringify({ ok: true, checks, appRowsWritten: 0, collectorStarted: false, validationStarted: false }));
} finally {
  await client.query('ROLLBACK'); client.release(); await db.end();
}
