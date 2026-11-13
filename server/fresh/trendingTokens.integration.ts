/** PostgreSQL fixture using session-local tables. No application data is written. */
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { readFreshTrendingTokens } from './trendingTokens.js';

const url = new URL(process.env.TRENDING_TEST_DATABASE_URL ?? '');
if (url.hostname !== '127.0.0.1') throw Error('Use a local PostgreSQL test database');
const db = new Pool({ connectionString: url.toString(), max: 1 });
const client = await db.connect();
const now = Date.parse('2026-11-13T12:00:00.000Z');
const minute = 60_000;
const address = (n: number) => '0x' + n.toString(16).padStart(40, '0');
const fixtureDb = {
  query: (sql: string, values: string[]) =>
    client.query(sql.replaceAll('fresh.', 'pg_temp.').replaceAll('published_kols', 'pg_temp.published_kols'), values),
};

async function token(n: number, launch = 'eligible') {
  const key = address(n);
  await client.query(`INSERT INTO tokens(address, name, symbol, launch_status, valuation_status)
    VALUES ($1, 'Meme token', 'MEME', $2, 'pending')`, [key, launch]);
  return key;
}

let block = 1;
async function trade(tokenAddress: string, wallet: number, at: number, options: {
  kind?: 'buy' | 'sell' | 'transfer_in'; amount?: number | null; quantity?: number;
  canonical?: boolean; live?: boolean; provenance?: boolean; tx?: string; block?: number;
} = {}) {
  const n = block++;
  const amount = options.amount === undefined ? 100 : options.amount;
  await client.query(`INSERT INTO financial_events(token_address,wallet_address,transaction_hash,kind,occurred_at,quantity,
    amount_usd,canonical,observed_live,provenance,block_number)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
  [tokenAddress, address(wallet), options.tx ?? String(n), options.kind ?? 'buy', new Date(at),
    String(options.quantity ?? 100), amount === null ? null : String(amount), options.canonical ?? true,
    options.live ?? true, options.provenance ? '{}' : null, options.block ?? n]);
}

try {
  await client.query('BEGIN');
  await client.query(`
    CREATE TEMP TABLE tokens(address text, name text, symbol text, launch_status text, valuation_status text,
      logo_url text, logo_data bytea, market_cap_usd numeric, price_usd numeric, observed_at timestamptz);
    CREATE TEMP TABLE financial_events(token_address text, wallet_address text, transaction_hash text, kind text,
      occurred_at timestamptz, quantity text, amount_usd text, canonical boolean, observed_live boolean,
      provenance jsonb, block_number bigint);
    CREATE TEMP TABLE kols(wallet_address text, is_tracked boolean);
    CREATE TEMP TABLE wallets(address text, active boolean, monitoring_from_block bigint, monitoring_to_block bigint);
    CREATE TEMP TABLE accounting_scopes(id text, kind text, wallet_addresses text[], account_id text, active boolean,
      starts_block bigint, starts_at timestamptz);
    CREATE TEMP TABLE checkpoints(key text, block_number bigint, block_hash text, value jsonb);
    CREATE TEMP TABLE launch_facts(token_address text, status text);
    CREATE TEMP TABLE recent_blocks(block_number bigint, block_hash text, occurred_at timestamptz);
    CREATE TEMP TABLE published_kols(address text, display_name text, twitter text);
    INSERT INTO checkpoints(key, block_number) VALUES ('capture', 1000);
  `);
  for (let i = 1; i <= 10; i++) {
    const wallet = address(i);
    await client.query('INSERT INTO wallets VALUES ($1,true,0,null)', [wallet]);
    const isPublic = i < 10;
    if (isPublic) {
      await client.query('INSERT INTO kols VALUES ($1,true)', [wallet]);
      await client.query('INSERT INTO published_kols VALUES ($1,$2,$3)', [wallet, 'KOL ' + i, '@test' + i]);
    }
    await client.query('INSERT INTO accounting_scopes VALUES ($1,$2,$3,$4,true,0,$5)',
      [(isPublic ? 'kol:' : 'portfolio_wallet:') + wallet, isPublic ? 'kol' : 'portfolio_wallet', [wallet],
        isPublic ? null : 'private-account', new Date(now - 48 * 60 * minute)]);
  }

  const flat = await token(100);
  const down = await token(101);
  const rising = await token(102);
  const weak = await token(103);
  const ancient = await token(104);
  const burst = await token(105);
  const oneWallet = await token(106);
  const older = await token(107, 'preexisting');
  const pending = await token(108);
  const grouped = await token(109);

  for (const [key, lateQuantity] of [[flat, 100], [down, 200], [rising, 50]] as const) {
    for (let i = 0; i < 3; i++) {
      const wallet = 1 + i % 2;
      await trade(key, wallet, now - 11 * minute + i, { quantity: 100 });
      await trade(key, wallet, now - 2 * minute + i, { quantity: lateQuantity });
    }
  }
  for (let i = 0; i < 3; i++) {
    const wallet = 1 + i % 2;
    await trade(weak, wallet, now - 11 * minute + i, { tx: 'only-one-early-transaction' });
    await trade(weak, wallet, now - 2 * minute + i, { quantity: 1 });
    await trade(grouped, 1, now - 11 * minute + i);
    await trade(grouped, 2, now - 2 * minute + i, { quantity: 1 });
  }
  for (let i = 1; i <= 6; i++) await trade(ancient, i, now - 120 * minute, { kind: 'sell' });
  for (let i = 1; i <= 2; i++) {
    await trade(burst, i, now - minute);
    await trade(older, i, now - minute);
    await trade(pending, i, now - minute, { amount: null });
  }
  await trade(oneWallet, 1, now - minute, { amount: 1_000_000 });
  await trade(oneWallet, 1, now - minute, { amount: 1_000_000 });
  await trade(oneWallet, 10, now - minute);
  await trade(oneWallet, 2, now - minute, { canonical: false });
  await trade(oneWallet, 2, now - minute, { live: false });
  await trade(oneWallet, 2, now - minute, { provenance: true });
  await trade(oneWallet, 2, now - minute, { kind: 'transfer_in' });
  await trade(oneWallet, 2, now - minute, { block: 2000 });
  await trade(oneWallet, 2, now + 1);
  await trade(oneWallet, 2, now - 6 * 60 * minute);

  const feed = await readFreshTrendingTokens(fixtureDb, '6h', now);
  const list = feed.items.map(item => item.address);
  assert.deepEqual(list.filter(key => [rising, flat, weak, grouped, down].includes(key)), [rising, flat, weak, grouped, down],
    'Momentum is signed and requires independent transactions and participating wallets in both price bands');
  assert(list.indexOf(burst) < list.indexOf(ancient), 'A current buying burst outranks stale sell activity');
  assert(!list.includes(oneWallet), 'A single tracked wallet cannot qualify with repeated trades, private, reorged, imported, unconfirmed or out-of-window activity');
  assert(!list.includes(older), 'Unapproved preexisting token does not enter the tracked lane');
  assert(list.includes(pending), 'Missing valuation does not remove otherwise qualifying activity');
  assert.deepEqual(feed.items.find(item => item.address === rising), {
    address: rising, name: 'Meme token', symbol: 'MEME', logoUrl: null, marketCapUsd: null,
    volumeUsd: '600', volumeIncomplete: false, kolCount: 2, buyCount: 6, sellCount: 0,
    kols: [1, 2].map(i => ({ walletAddress: address(i), name: 'KOL ' + i, twitter: 'test' + i })),
    recentKols: ['KOL 1', 'KOL 2'],
  });
  assert.equal(feed.items.find(item => item.address === pending)?.volumeUsd, null);
  assert.equal(feed.items.find(item => item.address === pending)?.volumeIncomplete, true);
  assert(!(await readFreshTrendingTokens(fixtureDb, '5m', now)).items.some(item => item.address === ancient));

  for (let i = 0; i < 14; i++) {
    const other = await token(200 + i);
    await trade(other, 1, now - 1000);
    await trade(other, 2, now - 1000);
  }
  const limited = await readFreshTrendingTokens(fixtureDb, '6h', now);
  assert.equal(limited.items.length, 12);
  assert.equal(limited.items[0]?.address, rising, 'Top-12 is chosen after momentum ranking');
  console.log('Trending token PostgreSQL ranking, evidence, privacy, limits and response shape passed.');
} finally {
  await client.query('ROLLBACK');
  client.release();
  await db.end();
}
