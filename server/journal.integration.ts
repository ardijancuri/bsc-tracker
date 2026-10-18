// This integration suite destroys only an explicitly disposable portfolio database.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { ensureSchema, pool } from './db.js';
import { registerJournalRoutes } from './journalApi.js';
import { createJournalService } from './journalService.js';
import { ensureJournalSchema } from './journalSchema.js';
import { rollbackJournalCollection } from './journalCollection.js';
import type { JournalLedgerEvent } from './journalLedger.js';
import type { KolTokenActivity } from '../shared/kolTokenTrades.js';

const connection = new URL(process.env.DATABASE_URL || '');
if (!['127.0.0.1', 'localhost'].includes(connection.hostname) || !/^\/bscan_journal_test(?:_\d+)?$/.test(connection.pathname)) throw new Error('Use a local disposable bscan_journal_test database');
process.env.NODE_ENV = 'production'; process.env.PUBLIC_APP_URL = 'https://kollens.com';
const origin = 'https://kollens.com', now = Date.now(), addedTime = new Date(now - 180_000).toISOString();
const wallet = `0x${'a'.repeat(40)}`, second = `0x${'b'.repeat(40)}`, third = `0x${'c'.repeat(40)}`, fourth = `0x${'d'.repeat(40)}`, token = `0x${'e'.repeat(40)}`, oldToken = `0x${'9'.repeat(40)}`;
const user = randomUUID(), other = randomUUID(), secret = randomBytes(32).toString('hex'), secretOther = randomBytes(32).toString('hex');
const tx = (digit: string) => `0x${digit.repeat(64)}`;
const balances = new Map([[wallet, '60'], [second, '20'], [third, '0']]);
const allEvents: JournalLedgerEvent[] = [];
let evidenceComplete = true;
let nodeCalls = 0, activityCalls = 0, quoteCalls = 0, proofHeight = 200;
const proof = (walletAddress: string, tokenAddress: string) => ({ walletAddress, tokenAddress, chain: 'bsc' as const,
  blockNumber: String(proofHeight), blockHash: tx('f'), blockTimestamp: new Date(now - 5_000).toISOString(), balance: balances.get(walletAddress) ?? '0', checkedAt: new Date(now).toISOString() });
const skeleton = (walletAddress: string, tokenAddress: string): KolTokenActivity => ({ kol: { address: walletAddress, name: null, avatarUrl: null, twitter: null, source: 'journal', lastSeenAt: null },
  token: { address: tokenAddress, symbol: 'TEST', name: 'Test', logoUrl: null, priceUsd: null, marketCapUsd: null, marketCapSupply: '1000000' }, trades: [],
  summary: { investedUsd: '999999', soldUsd: '999999', realizedProfitUsd: '999999', avgBoughtPriceUsd: null, avgSoldPriceUsd: null, avgBoughtMcapUsd: null, avgSoldMcapUsd: null,
    remainingTokenAmount: null, remainingCostBasisUsd: null, buyCount: 0, sellCount: 0, valuedBuyCount: 0, valuedSellCount: 0, excludedSellCount: 0, unpricedTradeCount: 0,
    firstTradeAt: null, lastTradeAt: null, status: 'unknown', profitBasis: 'observed_fifo' },
  coverage: { source: 'indexed', indexedTradeCount: 0, returnedTradeCount: 0, complete: true, historyLimit: 2000, costsIncluded: false }, generatedAt: new Date(now).toISOString() });
const chartCalls: { first: number; last: number }[] = [];
const service = createJournalService({ db: pool, now: () => now,
  nodeEvidence: async (_db, pair, options) => {
    nodeCalls++;
    assert.ok(pair.startAt, 'Every ledger preparation has a per-account timestamp boundary');
    const events = allEvents.filter(event => event.walletAddress === pair.wallet && event.tokenAddress === pair.token
      && Date.parse(event.timestamp) >= Date.parse(pair.startAt!) && BigInt(event.blockNumber!) > BigInt(pair.registrationBlock!));
    const delta = events.reduce((sum, event) => sum + (['buy', 'transfer_in'].includes(event.kind) ? 1 : -1) * Number(event.tokenAmount), 0);
    return { events, source: 'node', proof: options.balance, coverage: { walletAddress: pair.wallet, tokenAddress: pair.token, complete: evidenceComplete },
      openingBalances: [{ walletAddress: pair.wallet, tokenAddress: pair.token, tokenAmount: String(Number(options.balance.balance) - delta) }] };
  },
  balance: async request => proof(request.wallet, request.token), quote: async () => { quoteCalls++; return { quote: { priceUsd: '2', timestamp: new Date(now).toISOString() } }; },
  loadActivity: async options => { activityCalls++; return skeleton(options.wallet, options.token); },
  chart: async (address, first, last, _current, supply) => { chartCalls.push({ first, last }); return { address, period: 'replay', resolution: '1m', source: 'gmgn', marketCapSupply: supply ?? null, candles: [], points: [], pending: false, stale: false, updatedAt: new Date(now).toISOString() }; } });
const app = Fastify({ logger: false }); registerJournalRoutes(app, { service });
const request = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: Record<string, unknown>, account = 'one') => app.inject({ method, url,
  headers: { origin, cookie: `bscan_auth=${account === 'one' ? secret : secretOther}`, 'x-watchlist-owner': account === 'one' ? user : other }, ...(payload === undefined ? {} : { payload }) });
const checkpoint = async () => {
  await pool.query(`INSERT INTO worker_state(key,value,updated_at) VALUES('node',$1::jsonb,now()) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()`, [JSON.stringify({ blockNumber: 200, blockHash: tx('f') })]);
  await pool.query(`UPDATE journal_wallet_coverage SET collected_from_block=101,collected_through_block=200,repair_from_block=NULL`);
};
async function indexed(id: string, owner: string, side: 'buy' | 'sell', quantity: string, amount: string, timestamp: string, block = 150, asset = token) {
  await pool.query(`INSERT INTO trades(id,wallet_address,token_address,side,token_amount,amount_usd,price_usd,tx_hash,timestamp,source,block_number,block_hash,transaction_index)
    VALUES($1,$2,$3,$4,$5,$6,1,$7,$8,'node',$9,$10,0)`, [id, owner, asset, side, quantity, amount, tx(id.slice(-1)), timestamp, block, tx('f')]);
}
try {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public'); await ensureSchema();
  await Promise.all([ensureJournalSchema(pool), ensureJournalSchema(pool)]);
  for (const [id, tokenSecret] of [[user, secret], [other, secretOther]]) {
    await pool.query(`INSERT INTO auth_users(id,issuer,subject,name) VALUES($1::uuid,'https://oauth.telegram.org',$1::text,'Test')`, [id]);
    await pool.query(`INSERT INTO auth_sessions(id,user_id,secret_hash,expires_at) VALUES($1,$2,$3,now()+interval '1 day')`, [randomUUID(), id, createHash('sha256').update(tokenSecret).digest('hex')]);
  }
  await pool.query('INSERT INTO processed_blocks(block_number,block_hash) VALUES(100,$1)', [tx('f')]);
  await pool.query(`INSERT INTO worker_state(key,value) VALUES('node','{"blockNumber":100}')`);
  const added = await request('POST', '/api/journal/wallets', { address: wallet, label: 'My private trading account' }); assert.equal(added.statusCode, 200, added.body);
  const firstMembership = added.json().wallets[0]; assert.equal(firstMembership.label, 'My private trading account');
  assert.equal(firstMembership.addedAt, firstMembership.activityFrom, 'Tracking starts at registration, never seven days earlier');
  const metadata = (await pool.query(`SELECT display_name,is_tracked FROM kols WHERE address=$1`, [wallet])).rows[0];
  assert.deepEqual(metadata, { display_name: null, is_tracked: false }, 'Private labels never become public KOL identity');
  assert.equal((await pool.query('SELECT repair_from_block::text FROM journal_wallet_coverage WHERE wallet_address=$1', [wallet])).rows[0].repair_from_block, '101', 'Collection repairs begin after registration, not in old history');
  const duplicate = await request('POST', '/api/journal/wallets', { address: wallet, label: 'Not a replacement' });
  assert.equal(duplicate.json().wallets[0].revision, firstMembership.revision); assert.equal(duplicate.json().wallets[0].addedAt, firstMembership.addedAt);
  assert.equal(duplicate.json().wallets[0].label, firstMembership.label);
  const concurrent = await Promise.all([request('POST', '/api/journal/wallets', { address: second }), request('POST', '/api/journal/wallets', { address: third }), request('POST', '/api/journal/wallets', { address: fourth })]);
  assert.deepEqual(concurrent.map(response => response.statusCode).sort(), [200, 200, 409]);
  await request('DELETE', `/api/journal/wallets/${third}`); await request('DELETE', `/api/journal/wallets/${fourth}`); await request('POST', '/api/journal/wallets', { address: second });
  for (const endpoint of [`/api/journal/summary?wallet=${wallet}`, `/api/journal/wallets/${wallet}/tokens/${token}/activity?replay=true`, `/api/journal/wallets/${wallet}/tokens/${token}/replay-chart`]) assert.equal((await request('GET', endpoint, undefined, 'two')).statusCode, 404);
  assert.equal((await request('POST', `/api/journal/wallets/${wallet}/older`)).statusCode, 404, 'No historical expansion endpoint');
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/journal/wallets/${wallet}`, headers: { cookie: `bscan_auth=${secret}`, origin: 'https://attacker.invalid' } })).statusCode, 403);
  for (const asset of [token, oldToken]) await pool.query(`INSERT INTO tokens(address,symbol,name,decimals) VALUES($1,'TEST','Test',18)`, [asset]);
  const earlier = new Date(now - 86_400_000).toISOString();
  await indexed('old1', wallet, 'buy', '999', '999', earlier, 50, oldToken);
  await pool.query(`INSERT INTO journal_provider_movements(wallet_address,token_address,event_key,kind,tx_hash,timestamp,token_amount,amount_usd,fee_usd,evidence_hash)
    VALUES($1,$2,'provider-old','buy',$3,$4,999,999,0,'test-only'),($1,$2,'provider-new','buy',$3,now(),999,999,0,'test-only')`, [wallet, oldToken, tx('9'), earlier]);
  // A public KOL already has lifetime indexed trades; adding it to Portfolio is
  // still an empty forward-only subscription.
  await pool.query('UPDATE kols SET is_tracked=true WHERE address=$1', [wallet]); await checkpoint();
  const empty = await request('GET', '/api/journal/summary'); assert.deepEqual(empty.json().positions, [], empty.body);
  assert.equal(nodeCalls, 0); assert.deepEqual((await request('GET', '/api/journal/activity')).json().trades, []);
  assert.equal((await request('GET', `/api/journal/wallets/${wallet}/tokens/${oldToken}/activity?replay=true`)).statusCode, 404);
  assert.equal(activityCalls, 0, 'Excluded earlier positions never invoke public activity or provider adapters');
  assert.equal((await request('GET', `/api/journal/wallets/${wallet}/tokens/${oldToken}/replay-chart`)).statusCode, 404); assert.equal(chartCalls.length, 0);
  // Model memberships that started three minutes ago, followed by live trades.
  await pool.query("UPDATE journal_wallets SET added_at=$1::timestamptz+interval '456 microseconds',activity_from=$1::timestamptz+interval '456 microseconds' WHERE user_id=$2", [addedTime, user]);
  const moves = [
    [wallet, 'buy', '100', '100', '1', null, '1', -120_000],
    [wallet, 'transfer_out', '40', '80', '0.1', second, '2', -90_000],
    [second, 'transfer_in', '40', '80', '0', wallet, '2', -90_000],
    [second, 'sell', '20', '60', '0.2', null, '3', -60_000],
  ] as const;
  for (const [owner, kind, quantity, amount, fee, counterparty, digit, offset] of moves) {
    const timestamp = new Date(now + offset).toISOString(), id = `${owner}:${kind}`;
    allEvents.push({ id, walletAddress: owner, tokenAddress: token, kind, tokenAmount: quantity, amountUsd: amount, feeUsd: fee,
      feeId: tx(digit), counterparty, txHash: tx(digit), timestamp, blockNumber: '150', transactionIndex: 0, logIndex: 1, transferId: `${tx(digit)}:1` });
    if (kind === 'buy' || kind === 'sell') await indexed('trade' + digit, owner, kind, quantity, amount, timestamp);
    else await pool.query(`INSERT INTO wallet_transfers(id,wallet_address,token_address,tx_hash,log_index,delta_raw,kind,block_number,block_hash,timestamp,counterparty_address)
      VALUES($1,$2,$3,$4,1,$5,'transfer',150,$6,$7,$8)`, [id, owner, token, tx(digit), kind === 'transfer_out' ? '-40000000000000000000' : '40000000000000000000', tx('f'), timestamp, counterparty]);
  }
  const summary = await request('GET', '/api/journal/summary'); assert.equal(summary.statusCode, 200, summary.body);
  assert.equal(summary.json().complete, true, summary.body); assert.equal(summary.json().totals.investedUsd, '100');
  assert.equal(summary.json().totals.estimatedProfitUsd, '118.7', 'Tracked internal transfer costs move without increasing profit or capital');
  assert.equal(summary.json().positions[0].remainingTokenAmount, '80'); assert.equal(summary.json().coverage, 'since_wallet_added');
  assert.equal((await pool.query('SELECT COUNT(*)::integer AS count FROM journal_pair_preparations WHERE tracking_from IS NOT NULL')).rows[0].count, 2, 'Sub-millisecond membership timestamps still persist shared preparations');
  const callsBeforeCacheRead = nodeCalls, quotesBeforeCacheRead = quoteCalls;
  const cached = await request('GET', '/api/journal/summary'); assert.equal(cached.json().snapshotId, summary.json().snapshotId); assert.equal(cached.json().asOf, summary.json().asOf); assert.equal(nodeCalls, callsBeforeCacheRead, 'Warm portfolio summaries reuse persisted bounded evidence'); assert.equal(quoteCalls, quotesBeforeCacheRead);
  const activity = await request('GET', '/api/journal/activity'); assert.equal(activity.json().trades.length, 2, activity.body);
  assert.ok(activity.json().trades.every((trade: { timestamp: string }) => Date.parse(trade.timestamp) >= Date.parse(addedTime)));
  const prepared = await request('GET', `/api/journal/wallets/${wallet}/tokens/${token}/activity?replay=true`); assert.equal(prepared.statusCode, 200, prepared.body);
  assert.ok(prepared.json().journal.snapshotId, prepared.body); assert.equal(prepared.json().journal.accountId, user); assert.ok(!prepared.body.includes('My private trading account'));
  assert.ok(!prepared.body.includes('999999'), 'Public lifetime summaries are replaced by the bounded private ledger');
  const snapshot = prepared.json().journal.snapshotId;
  const publicPayload = prepared.json() as KolTokenActivity;
  const publicTrade = publicPayload.trades[0];
  const unavailable = createJournalService({ db: pool, now: () => now, balance: async value => proof(value.wallet, value.token), nodeEvidence: async () => null,
    loadActivity: async () => ({ ...publicPayload, coverage: { ...publicPayload.coverage, complete: true, indexedTradeCount: 127, returnedTradeCount: 127 },
      trades: [{ ...publicTrade, id: 'older-public', timestamp: earlier }, { ...publicTrade, id: 'ahead-of-checkpoint', blockNumber: '9999' }, { ...publicTrade, realizedProfitUsd: '99999', cumulativeRealizedProfitUsd: '99999' }] }) });
  // Remove the cache temporarily so an unavailable proof follows the public
  // adapter failure path, rather than keeping its old lifetime FIFO numbers.
  const previousPreparation = (await pool.query('SELECT * FROM journal_pair_preparations WHERE wallet_address=$1 AND token_address=$2', [wallet, token])).rows[0];
  await pool.query('UPDATE journal_pair_preparations SET checked_at=NULL,balance_proof=NULL WHERE wallet_address=$1 AND token_address=$2', [wallet, token]);
  const pendingActivity = await unavailable.tokenActivity(user, wallet, token);
  assert.ok(pendingActivity); assert.equal(pendingActivity.coverage.indexedTradeCount, 1); assert.equal(pendingActivity.trades.length, 1, 'Proof-failure lists exclude rows ahead of the committed checkpoint as well as older cycles'); assert.equal(pendingActivity.coverage.complete, false);
  assert.equal(pendingActivity.trades[0].realizedProfitUsd, null); assert.equal(pendingActivity.trades[0].cumulativeRealizedProfitUsd, null);
  assert.equal(pendingActivity.summary.investedUsd, null);
  await pool.query('UPDATE journal_pair_preparations SET balance_proof=$3::jsonb,checked_at=$4 WHERE wallet_address=$1 AND token_address=$2', [wallet, token, JSON.stringify(previousPreparation.balance_proof), previousPreparation.checked_at]);
  assert.deepEqual((await request('GET', `/api/journal/wallets/${wallet}/tokens/${token}/activity?replay=true&snapshot=${snapshot}`)).json(), prepared.json());
  const frozenChart = await request('GET', `/api/journal/wallets/${wallet}/tokens/${token}/replay-chart?end=current&snapshot=${snapshot}`);
  assert.equal(frozenChart.statusCode, 200, frozenChart.body); assert.equal(chartCalls.at(-1)!.first, now - 120_000); assert.equal(chartCalls.at(-1)!.last, now - 90_000);
  assert.equal(frozenChart.json().currentQuote.priceUsd, prepared.json().realizedAccounting.position.priceUsd);
  // A second account subscribing later must not share the earlier account's
  // cached ledger or inflate P&L with old purchases.
  await request('POST', '/api/journal/wallets', { address: wallet }, 'two');
  await pool.query('UPDATE journal_wallets SET added_at=$1,activity_from=$1 WHERE user_id=$2', [new Date(now - 45_000).toISOString(), other]);
  balances.set(wallet, '70'); const newBuyTime = new Date(now - 30_000).toISOString(); await indexed('trade4', wallet, 'buy', '10', '10', newBuyTime, 201);
  allEvents.push({ id: 'newbuy', walletAddress: wallet, tokenAddress: token, kind: 'buy', tokenAmount: '10', amountUsd: '10', feeUsd: '0.1', txHash: tx('4'), timestamp: newBuyTime, blockNumber: '201' });
  proofHeight = 220;
  await pool.query(`UPDATE worker_state SET value='{"blockNumber":220}',updated_at=now() WHERE key='node'`); await pool.query('UPDATE journal_wallet_coverage SET collected_through_block=220');
  const later = await request('GET', '/api/journal/summary', undefined, 'two'); assert.equal(later.json().positions.length, 1, later.body);
  assert.equal(later.json().positions[0].investedUsd, '10'); assert.equal(later.json().positions[0].estimatedProfitUsd, null); assert.ok(later.json().reasons.includes('opening_cost_unknown'));
  const laterActivity = await request('GET', '/api/journal/activity', undefined, 'two'); assert.equal(laterActivity.json().trades.length, 1, laterActivity.body);
  assert.equal(laterActivity.json().trades[0].amountUsd, '10');
  const laterRevision = (await service.list(other)).wallets[0].revision;
  const confirmedDigest = (await pool.query('SELECT canonical_revision FROM journal_pair_preparations WHERE wallet_address=$1 AND token_address=$2', [wallet, token])).rows[0].canonical_revision;
  await pool.query(`UPDATE journal_pair_preparations SET balance_proof=jsonb_set(balance_proof,'{blockNumber}','"200"'),canonical_revision=$3 WHERE wallet_address=$1 AND token_address=$2 AND membership_revision=$4`, [wallet, token, confirmedDigest, laterRevision]);
  const callsBeforeCatchup = nodeCalls; await service.summary(other);
  assert.ok(nodeCalls > callsBeforeCatchup, 'Newly confirmed rows above a cached proof force accounting refresh even with unchanged content digest');
  // Existing memberships migrate to their original added time without losing
  // subscriptions; old policy snapshots cannot survive that migration.
  await pool.query(`UPDATE journal_wallets SET activity_from=added_at-interval '7 days' WHERE user_id=$1`, [user]);
  const beforeMigration = (await service.list(user)).wallets[0].revision; await ensureJournalSchema(pool);
  assert.notEqual((await service.list(user)).wallets[0].revision, beforeMigration);
  assert.equal((await pool.query('SELECT count(*)::integer AS count FROM journal_replay_snapshots WHERE user_id=$1', [user])).rows[0].count, 0);
  await request('DELETE', `/api/journal/wallets/${wallet}`);
  assert.equal((await request('GET', `/api/journal/wallets/${wallet}/tokens/${token}/activity?replay=true&snapshot=${snapshot}`)).statusCode, 404);
  const readded = await request('POST', '/api/journal/wallets', { address: wallet, label: 'New membership' });
  const readdedMember = readded.json().wallets.find((row: { address: string }) => row.address === wallet);
  assert.notEqual(readdedMember.revision, firstMembership.revision); assert.ok(Date.parse(readdedMember.addedAt) >= Date.parse(firstMembership.addedAt));
  assert.deepEqual((await request('GET', `/api/journal/activity?wallet=${wallet}`)).json().trades, [], 'Removal/re-addition does not revive earlier cycles');
  assert.equal((await request('GET', `/api/journal/wallets/${wallet}/tokens/${token}/activity?replay=true&snapshot=${snapshot}`)).statusCode, 409);
  assert.equal((await pool.query('SELECT count(*)::integer AS count FROM kols WHERE is_tracked')).rows[0].count, 1, 'Private additions never modify the existing public roster');
  const revisionBeforeReorg = (await service.list(other)).wallets[0].revision;
  await pool.query('UPDATE journal_wallets SET registration_block=205 WHERE user_id=$1', [other]);
  await rollbackJournalCollection(pool, 200);
  const reorgMember = (await pool.query('SELECT registration_block::text,revision FROM journal_wallets WHERE user_id=$1', [other])).rows[0];
  assert.equal(reorgMember.registration_block, '199'); assert.notEqual(reorgMember.revision, revisionBeforeReorg, 'Reorgs lower each affected membership floor and invalidate in-flight leases');
  console.log('Portfolio integration passed: forward-only membership boundaries, public/provider historical exclusion, internal transfers, scoped caches, unknown opening costs, migration and frozen replays.');
} finally { await app.close(); await pool.end(); }
