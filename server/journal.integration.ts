// This integration suite destroys only an explicitly disposable journal database.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { ensureSchema, pool } from './db.js';
import { registerJournalRoutes } from './journalApi.js';
import { createJournalService } from './journalService.js';
import { ensureJournalSchema } from './journalSchema.js';
import { createJournalHistory } from './journalHistory.js';
import { MarketProviderDeferred } from './geckoApi.js';
import type { KolTokenActivity } from '../shared/kolTokenTrades.js';

if (!/^\/bscan_journal_test(?:_\d+)?$/.test(new URL(process.env.DATABASE_URL || '').pathname)) throw new Error('Use a disposable bscan_journal_test database');
process.env.NODE_ENV = 'production'; process.env.PUBLIC_APP_URL = 'https://kollens.com';
const origin = 'https://kollens.com', now = Date.now(), time = new Date(now - 120_000).toISOString();
const wallet = `0x${'a'.repeat(40)}`, second = `0x${'b'.repeat(40)}`, third = `0x${'c'.repeat(40)}`, fourth = `0x${'d'.repeat(40)}`, token = `0x${'e'.repeat(40)}`;
const user = randomUUID(), other = randomUUID(), secret = randomBytes(32).toString('hex'), secretOther = randomBytes(32).toString('hex');
const tx = (digit: string) => `0x${digit.repeat(64)}`;
const balances = new Map([[wallet, '60'], [second, '20'], [third, '0']]);
let historyComplete = true;
const proof = (walletAddress: string, tokenAddress: string) => ({ walletAddress, tokenAddress, chain: 'bsc' as const,
  blockNumber: '200', blockHash: tx('f'), blockTimestamp: new Date(now - 5_000).toISOString(), balance: balances.get(walletAddress) ?? '0', checkedAt: new Date(now).toISOString() });
const skeleton = (walletAddress: string, tokenAddress: string): KolTokenActivity => ({ kol: { address: walletAddress, name: null, avatarUrl: null, twitter: null, source: 'journal', lastSeenAt: null },
  token: { address: tokenAddress, symbol: 'TEST', name: 'Test', logoUrl: null, priceUsd: null, marketCapUsd: null, marketCapSupply: '1000000' }, trades: [],
  summary: { investedUsd: null, soldUsd: null, realizedProfitUsd: null, avgBoughtPriceUsd: null, avgSoldPriceUsd: null, avgBoughtMcapUsd: null, avgSoldMcapUsd: null,
    remainingTokenAmount: null, remainingCostBasisUsd: null, buyCount: 0, sellCount: 0, valuedBuyCount: 0, valuedSellCount: 0, excludedSellCount: 0, unpricedTradeCount: 0,
    firstTradeAt: null, lastTradeAt: null, status: 'unknown', profitBasis: 'observed_fifo' },
  coverage: { source: 'indexed', indexedTradeCount: 0, returnedTradeCount: 0, complete: true, historyLimit: 2000, costsIncluded: false }, generatedAt: new Date(now).toISOString() });
const service = createJournalService({ db: pool, now: () => now,
  history: async () => ({ status: historyComplete ? 'ready' : 'pending', complete: historyComplete, coveredTo: new Date(0).toISOString() }),
  balance: async request => proof(request.wallet, request.token), quote: async () => ({ quote: { priceUsd: '2', timestamp: new Date(now).toISOString() } }),
  loadActivity: async options => skeleton(options.wallet, options.token),
  chart: async (address, _first, _last, _current, supply) => ({ address, period: 'replay', resolution: '1m', source: 'gmgn', marketCapSupply: supply ?? null, candles: [], points: [], pending: false, stale: false, updatedAt: new Date(now).toISOString() }) });
const app = Fastify({ logger: false }); registerJournalRoutes(app, { service });
const request = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: Record<string, unknown>, account = 'one') => app.inject({ method, url,
  headers: { origin, cookie: `bscan_auth=${account === 'one' ? secret : secretOther}`, 'x-watchlist-owner': account === 'one' ? user : other }, ...(payload === undefined ? {} : { payload }) });
try {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public'); await ensureSchema();
  await Promise.all([ensureJournalSchema(pool), ensureJournalSchema(pool)]);
  for (const [id, tokenSecret] of [[user, secret], [other, secretOther]]) {
    await pool.query(`INSERT INTO auth_users(id,issuer,subject,name) VALUES($1::uuid,'https://oauth.telegram.org',$1::text,'Test')`, [id]);
    await pool.query(`INSERT INTO auth_sessions(id,user_id,secret_hash,expires_at) VALUES($1,$2,$3,now()+interval '1 day')`, [randomUUID(), id, createHash('sha256').update(tokenSecret).digest('hex')]);
  }
  const added = await request('POST', '/api/journal/wallets', { address: wallet, label: 'My private trading account' }); assert.equal(added.statusCode, 200, added.body);
  const firstMembership = added.json().wallets[0]; assert.equal(firstMembership.label, 'My private trading account');
  const metadata = (await pool.query(`SELECT display_name,is_tracked FROM kols WHERE address=$1`, [wallet])).rows[0];
  assert.deepEqual(metadata, { display_name: null, is_tracked: false }, 'Private labels never become public KOL identity');
  assert.ok(Math.abs(Date.parse(firstMembership.addedAt) - Date.parse(firstMembership.activityFrom) - 7 * 86_400_000) < 1000);
  const duplicate = await request('POST', '/api/journal/wallets', { address: wallet, label: 'Not a replacement' });
  assert.equal(duplicate.json().wallets[0].revision, firstMembership.revision, 'Duplicate addition preserves registration boundary');
  assert.equal(duplicate.json().wallets[0].label, firstMembership.label);
  const concurrent = await Promise.all([request('POST', '/api/journal/wallets', { address: second }), request('POST', '/api/journal/wallets', { address: third }), request('POST', '/api/journal/wallets', { address: fourth })]);
  assert.deepEqual(concurrent.map(response => response.statusCode).sort(), [200, 200, 409], 'Concurrent additions enforce three-wallet limit');
  // Keep the deterministic three-wallet selection for accounting fixtures.
  await request('DELETE', `/api/journal/wallets/${third}`); await request('DELETE', `/api/journal/wallets/${fourth}`);
  await request('POST', '/api/journal/wallets', { address: second });
  assert.equal((await request('GET', `/api/journal/summary?wallet=${wallet}`, undefined, 'two')).statusCode, 404);
  assert.equal((await request('GET', `/api/journal/wallets/${wallet}/tokens/${token}/activity?replay=true`, undefined, 'two')).statusCode, 404);
  assert.equal((await request('GET', `/api/journal/wallets/${wallet}/tokens/${token}/replay-chart`, undefined, 'two')).statusCode, 404);
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/journal/wallets/${wallet}`, headers: { cookie: `bscan_auth=${secret}`, origin: 'https://attacker.invalid' } })).statusCode, 403);
  await pool.query(`INSERT INTO tokens(address,symbol,name,decimals) VALUES($1,'TEST','Test',18)`, [token]);
  {
    const key = process.env.GMGN_ACCOUNTING_API_KEY; process.env.GMGN_ACCOUNTING_API_KEY = 'disposable-journal-fixture-key';
    let clock = now, calls = 0, failSecond = true, observedForeground = false;
    const historicalToken = `0x${'9'.repeat(40)}`;
    const raw = (digit: string, timestamp: number) => ({ wallet, chain: 'bsc', token: { address: historicalToken, symbol: 'HISTORY', name: 'History', decimals: 18 },
      tx_hash: tx(digit), event_type: 'buy', timestamp, token_amount: '1', cost_usd: '1', gas_usd: '0', dex_usd: '0', priority_fee: '0', tip_fee: '0' });
    const pageOne = raw('5', Math.floor(now / 1000) - 100), pageTwo = raw('6', Math.floor(now / 1000) - 200), newHead = raw('7', Math.floor(now / 1000) + 10);
    const history = createJournalHistory({ db: pool, now: () => clock, request: async (url, options) => {
      calls++;
      observedForeground ||= typeof options.foreground === 'function' ? options.foreground() : options.foreground === true;
      const cursor = url.searchParams.get('cursor');
      if (clock > now + 30_000) return { data: cursor === 'head2' ? { activities: [pageOne], next: 'page2' } : { activities: [newHead], next: 'head2' } };
      if (cursor === 'page2' && failSecond) { failSecond = false; throw new MarketProviderDeferred('rate_limited', 2000); }
      return { data: cursor === 'page2' ? { activities: [pageTwo], next: null } : { activities: [pageOne], next: 'page2' } };
    } });
    const shared = await Promise.all([history(wallet, historicalToken, new Date(0).toISOString()), history(wallet, historicalToken, new Date(0).toISOString(), true)]);
    assert.equal(calls, 1, 'Concurrent subscribers coalesce the same provider page'); assert.equal(shared[0].complete, false);
    assert.equal(observedForeground, true, 'A selected trade promotes the joined provider job');
    const deferred = await history(wallet, historicalToken, new Date(0).toISOString()); assert.equal(deferred.status, 'cooldown');
    await history(wallet, historicalToken, new Date(0).toISOString()); assert.equal(calls, 2, 'Cooldown is shared and does not discard completed pages');
    clock += 5000;
    const resumed = await history(wallet, historicalToken, new Date(0).toISOString()); assert.equal(resumed.complete, true);
    assert.equal((await pool.query('SELECT COUNT(*)::integer AS count FROM journal_provider_movements WHERE token_address=$1', [historicalToken])).rows[0].count, 2);
    clock = now + 40_000;
    const refreshing = await history(wallet, historicalToken, new Date(0).toISOString()); assert.equal(refreshing.complete, false, 'A new head cannot skip an unjoined provider page');
    const joinedHead = await history(wallet, historicalToken, new Date(0).toISOString()); assert.equal(joinedHead.complete, true);
    assert.equal((await pool.query('SELECT COUNT(*)::integer AS count FROM journal_provider_movements WHERE token_address=$1', [historicalToken])).rows[0].count, 3);
    await pool.query(`INSERT INTO journal_pair_preparations(wallet_address,token_address,status) VALUES($1,$2,'ready') ON CONFLICT DO NOTHING`, [wallet, historicalToken]);
    const corrected = createJournalHistory({ db: pool, now: () => now + 80_000, request: async () => ({ data: { activities: [{ ...pageOne, cost_usd: '2' }], next: null } }) });
    assert.equal((await corrected(wallet, historicalToken, new Date(0).toISOString())).complete, true);
    assert.equal((await pool.query('SELECT amount_usd::text FROM journal_provider_movements WHERE wallet_address=$1 AND tx_hash=$2', [wallet, tx('5')])).rows[0].amount_usd, '2', 'Corrected provider costs can recover instead of stalling permanently');
    assert.equal((await pool.query('SELECT COUNT(*)::integer AS count FROM journal_pair_preparations WHERE wallet_address=$1 AND token_address=$2', [wallet, historicalToken])).rows[0].count, 0, 'Provider corrections invalidate derived accounting snapshots');
    await pool.query('DELETE FROM journal_provider_movements WHERE token_address=$1', [historicalToken]);
    if (key === undefined) delete process.env.GMGN_ACCOUNTING_API_KEY; else process.env.GMGN_ACCOUNTING_API_KEY = key;
  }
  const moves = [
    [wallet, 'buy', '100', '100', '1', null, tx('1'), new Date(now - 120_000).toISOString()],
    [wallet, 'transfer_out', '40', '80', '0.1', second, tx('2'), new Date(now - 90_000).toISOString()],
    [second, 'transfer_in', '40', '80', '0', wallet, tx('2'), new Date(now - 90_000).toISOString()],
    [second, 'sell', '20', '60', '0.2', null, tx('3'), new Date(now - 60_000).toISOString()],
  ];
  for (const [owner, kind, quantity, amount, fee, counterparty, txHash, timestamp] of moves) await pool.query(`INSERT INTO journal_provider_movements(wallet_address,token_address,event_key,kind,tx_hash,timestamp,token_amount,amount_usd,fee_usd,counterparty,evidence_hash)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'test-only')`, [owner, token, `${txHash}:${kind}`, kind, txHash, timestamp, quantity, amount, fee, counterparty]);
  const summary = await request('GET', '/api/journal/summary'); assert.equal(summary.statusCode, 200, summary.body);
  assert.equal(summary.json().complete, true, summary.body); assert.equal(summary.json().totals.investedUsd, '100');
  assert.equal(summary.json().totals.estimatedProfitUsd, '118.7', 'Internal transfer values do not inflate investment or profit');
  assert.equal(summary.json().positions[0].remainingTokenAmount, '80');
  assert.equal(summary.json().coverage, 'available_position_history');
  const cachedSummary = await request('GET', '/api/journal/summary');
  assert.equal(cachedSummary.json().asOf, summary.json().asOf, 'Cached observations retain their original valuation time');
  assert.equal(cachedSummary.json().snapshotId, summary.json().snapshotId);
  const activity = await request('GET', '/api/journal/activity'); assert.equal(activity.json().trades.length, 2, activity.body);
  assert.ok(activity.json().trades.every((trade: { side: string }) => ['buy', 'sell'].includes(trade.side)));
  // A single-wallet replay uses its external transfer policy, never the private label.
  historyComplete = false;
  const pendingReplay = await request('GET', `/api/journal/wallets/${wallet}/tokens/${token}/activity?replay=true`);
  assert.equal(pendingReplay.json().replayAccounting.status, 'pending');
  assert.equal(pendingReplay.json().journal.snapshotId, undefined, 'Pending preparations must remain refreshable instead of freezing a permanent pending snapshot');
  historyComplete = true;
  const prepared = await request('GET', `/api/journal/wallets/${wallet}/tokens/${token}/activity?replay=true`); assert.equal(prepared.statusCode, 200, prepared.body);
  assert.ok(prepared.json().journal.snapshotId); assert.equal(prepared.json().journal.accountId, user);
  assert.equal(prepared.json().kol.name, null); assert.ok(!prepared.body.includes('My private trading account'));
  const snapshot = prepared.json().journal.snapshotId;
  const frozen = await request('GET', `/api/journal/wallets/${wallet}/tokens/${token}/activity?replay=true&snapshot=${snapshot}`);
  assert.deepEqual(frozen.json(), prepared.json(), 'Export reuses the modal accounting and frozen valuation');
  await pool.query(`UPDATE tokens SET total_supply_raw=2000000000000000000000000,supply_checked_at=now() WHERE address=$1`, [token]);
  const frozenChart = await request('GET', `/api/journal/wallets/${wallet}/tokens/${token}/replay-chart?end=current&snapshot=${snapshot}`);
  assert.equal(frozenChart.statusCode, 200, frozenChart.body);
  assert.equal(frozenChart.json().marketCapSupply, prepared.json().token.marketCapSupply, 'Supply changes cannot reprice the frozen modal market cap');
  assert.equal(frozenChart.json().currentQuote.priceUsd, prepared.json().realizedAccounting.position.priceUsd);
  const crossAccount = await request('GET', `/api/journal/wallets/${wallet}/tokens/${token}/activity?replay=true&snapshot=${snapshot}`, undefined, 'two'); assert.equal(crossAccount.statusCode, 404);
  const before = (await request('GET', '/api/journal/wallets')).json().wallets.find((row: { address: string }) => row.address === wallet);
  await request('POST', `/api/journal/wallets/${wallet}/older`);
  const after = (await request('GET', '/api/journal/wallets')).json().wallets.find((row: { address: string }) => row.address === wallet);
  assert.equal(Date.parse(before.activityFrom) - Date.parse(after.activityFrom), 7 * 86_400_000); assert.notEqual(after.revision, before.revision);
  assert.equal((await request('GET', `/api/journal/wallets/${wallet}/tokens/${token}/activity?replay=true&snapshot=${snapshot}`)).statusCode, 409, 'Changed coverage invalidates the former snapshot');
  await request('DELETE', `/api/journal/wallets/${wallet}`);
  assert.equal((await request('GET', `/api/journal/wallets/${wallet}/tokens/${token}/activity?replay=true&snapshot=${snapshot}`)).statusCode, 404);
  const readded = await request('POST', '/api/journal/wallets', { address: wallet, label: 'New membership' });
  assert.notEqual(readded.json().wallets.find((row: { address: string }) => row.address === wallet).revision, firstMembership.revision);
  assert.equal((await request('GET', `/api/journal/wallets/${wallet}/tokens/${token}/activity?replay=true&snapshot=${snapshot}`)).statusCode, 409, 'Re-adding does not revive previous membership exports');
  assert.equal((await pool.query('SELECT COUNT(*)::integer AS count FROM kols WHERE is_tracked')).rows[0].count, 0, 'Private registration never populates public roster');
  {
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const slow = createJournalService({ db: pool, now: () => now, history: async () => { await blocked; return { status: 'ready', complete: true, coveredTo: new Date(0).toISOString() }; },
      balance: async value => proof(value.wallet, value.token), quote: async () => ({ quote: { priceUsd: '2', timestamp: new Date(now).toISOString() } }) });
    const fastApp = Fastify({ logger: false }); registerJournalRoutes(fastApp, { service: slow });
    const start = Date.now();
    const delayed = await Promise.all(['/api/journal/summary', '/api/journal/activity'].map(url => fastApp.inject({ url, headers: { cookie: `bscan_auth=${secret}` } })));
    assert.ok(Date.now() - start < 1800, 'Blocked upstream preparation does not hold initial journal data for provider deadlines');
    assert.ok(delayed.every(response => response.statusCode === 200)); assert.equal(delayed[0].json().preparing, true);
    release(); await slow.summary(user); await fastApp.close();
  }
  console.log('Journal integration passed: membership isolation, limit, private labels, seven-day paging, consolidated transfers and frozen exports.');
} finally { await app.close(); await pool.end(); }
