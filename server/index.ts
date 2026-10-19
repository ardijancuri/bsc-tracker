import { registerCreatorRoutes } from './creatorApi.js';
import { registerJournalRoutes } from './journalApi.js';
import Fastify from 'fastify';
import { Client } from 'pg';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureSchema, pool } from './db.js';
import { ensureSeeds } from './seeds.js';
import { last24hStart, todayStart } from './dayWindow.js';
import { memeTokenSql } from './memeToken.js';
import { nonStockTokenSql } from './stockToken.js';
import { kolProfileTokenSql } from './kolProfileToken.js';
import { lookupTokenWebsite } from './tokenWebsite.js';
import { registerIntelligenceRoutes } from './intelligenceApi.js';
import { getTokenTranslation } from './tokenTranslation.js';
import { nodeAccountingService } from './nodeAccounting.js';
import { nodeTokenMarketSql, publicTokenEvidenceSql } from './nodeMarketReadSql.js';
import { registerFrontendRoutes } from './frontendRoutes.js';
import { kolProfileTokenPageSize, kolProfileTradePageSize } from '../shared/kolProfile.js';
import { registerTelegramAuthRoutes, telegramAuthConfig } from './telegramAuth.js';
import { createTelegramBot, telegramBotConfig } from './telegramBot.js';
import { createTelegramBotLogin } from './telegramBotLogin.js';
import { createTelegramAvatarCache, registerTelegramAvatarRoute } from './telegramBotAvatar.js';
import { registerTelegramNotificationRoutes } from './telegramNotificationsApi.js';
import { telegramNotifications } from './telegramNotifications.js';
import { captureGuestWatchlist, mergeGuestWatchlist } from './accountWatchlist.js';

const app = Fastify({ logger: {
  redact: ['req.headers.cookie', 'req.headers.authorization', 'req.headers.x-telegram-bot-api-secret-token', 'res.headers.set-cookie'],
  serializers: { req(request) { return { method: request.method, url: (request.url?.startsWith('/api/auth/') || request.url?.startsWith('/api/journal') || request.url?.startsWith('/api/creator')) ? request.url.split('?')[0] : request.url, hostname: request.hostname, remoteAddress: request.ip }; } },
}, trustProxy: true });
const root = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(root, '..', 'dist');
const addressPattern = /^0x[a-fA-F0-9]{40}$/;
const clients = new Set<import('node:http').ServerResponse>();
const botConfig = telegramBotConfig();
const loginBot = botConfig?.webhookSecret ? createTelegramBot(botConfig) : null;
const botLogin = createTelegramBotLogin({ pool, config: telegramAuthConfig(), bot: loginBot,
  captureGuest: captureGuestWatchlist, mergeGuest: mergeGuestWatchlist,
  avatarUrl: loginBot ? createTelegramAvatarCache(pool, loginBot.profilePhoto) : undefined });
botLogin.registerRoutes(app);
registerTelegramAvatarRoute(app, pool);
registerTelegramAuthRoutes(app, { captureGuest: captureGuestWatchlist, mergeGuest: mergeGuestWatchlist, botLogin,
  notificationConsent: { available: telegramNotifications.available, onAuthorized: telegramNotifications.authorize, onFailed: telegramNotifications.consentFailed } });
registerTelegramNotificationRoutes(app, { available: telegramNotifications.available, state: telegramNotifications.state,
  update: telegramNotifications.update, mute: telegramNotifications.mute, webhook: telegramNotifications.webhook, botLoginStart: botLogin.handleStart });
registerIntelligenceRoutes(app);
registerCreatorRoutes(app);
registerJournalRoutes(app);

function int(input: unknown, fallback: number, maximum: number) {
  const parsed = Number(input);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
}
function address(input: string) { return addressPattern.test(input) ? input.toLowerCase() : null; }
function nextTradeCursor(row: { timestamp: string | Date; id: string } | undefined) {
  return row ? Buffer.from(JSON.stringify({ ts: row.timestamp, id: row.id })).toString('base64url') : null;
}
const logoUrl = `CASE WHEN v.logo_data IS NOT NULL THEN '/api/token-image/' || v.address || '?v=' || md5(v.logo_data) END`;
function tradeSelect() { return `t.id, t.tx_hash AS "txHash", t.wallet_address AS "walletAddress", k.display_name AS "kolName", k.avatar_url AS "kolAvatarUrl", k.twitter AS "kolTwitter", t.token_address AS "tokenAddress", v.symbol AS "tokenSymbol", v.name AS "tokenName", ${logoUrl} AS "tokenLogoUrl", t.side, t.token_amount AS "tokenAmount", t.quote_symbol AS "quoteSymbol", t.quote_amount AS "quoteAmount", t.amount_usd AS "amountUsd", t.price_usd AS "priceUsd", t.timestamp, t.source, t.block_number AS "blockNumber"`; }
const tokenMarketCap = nodeTokenMarketSql('market_cap_usd');
const tokenPrice = nodeTokenMarketSql('price_usd');
function tokenSelect() { return `v.address, v.symbol, v.name, ${logoUrl} AS "logoUrl", ${tokenPrice} AS "priceUsd", ${tokenMarketCap} AS "marketCapUsd", NULL AS "change24h", COUNT(DISTINCT t.wallet_address) FILTER (WHERE t.timestamp > now() - interval '24 hours')::int AS "kolCount24h", COUNT(*) FILTER (WHERE t.timestamp > now() - interval '24 hours' AND t.side='buy')::int AS "buys24h", COUNT(*) FILTER (WHERE t.timestamp > now() - interval '24 hours' AND t.side='sell')::int AS "sells24h", SUM(t.amount_usd) FILTER (WHERE t.timestamp > now() - interval '24 hours') AS "volume24hUsd", MAX(t.timestamp) AS "lastTradeAt"`; }

app.get('/api/health', async () => {
  await pool.query('SELECT 1');
  return { ok: true, service: 'bscan-api' };
});

app.get<{ Params: { address: string } }>('/api/token-image/:address', async (request, reply) => {
  const key = address(request.params.address);
  if (!key) return reply.code(404).send({ error: 'Not found' });
  const result = await pool.query('SELECT logo_data,logo_mime FROM tokens WHERE address=$1', [key]);
  const image = result.rows[0];
  if (!image?.logo_data || !image?.logo_mime) return reply.header('Cache-Control', 'no-store').code(404).send({ error: 'Not found' });
  return reply.header('Cache-Control', 'public, max-age=3600').header('X-Content-Type-Options', 'nosniff').type(image.logo_mime).send(image.logo_data);
});

app.get('/api/overview', async () => {
  const [counts, states] = await Promise.all([
    pool.query(`SELECT (SELECT COUNT(*)::int FROM published_kols WHERE is_tracked) AS "trackedKols",
      (SELECT COUNT(*)::int FROM trades t JOIN published_kols k ON k.address=t.wallet_address WHERE k.is_tracked AND t.block_number IS NOT NULL AND ${nonStockTokenSql('t.token_address')} AND t.timestamp > now() - interval '24 hours') AS "trades24h",
      (SELECT COUNT(DISTINCT t.token_address)::int FROM trades t JOIN published_kols k ON k.address=t.wallet_address WHERE k.is_tracked AND t.block_number IS NOT NULL AND ${nonStockTokenSql('t.token_address')} AND t.timestamp > now() - interval '24 hours') AS "tokens24h",
      (SELECT MAX(t.timestamp) FROM trades t JOIN published_kols k ON k.address=t.wallet_address WHERE k.is_tracked AND t.block_number IS NOT NULL AND ${nonStockTokenSql('t.token_address')}) AS "latestTradeAt",
      (SELECT MAX(observed_at) FROM node_token_market_values) AS "lastTokenPriceAt"`),
    pool.query(`SELECT key,value,updated_at FROM worker_state WHERE key IN ('node','bnb_price','leaderboard_24h')`),
  ]);
  const node = states.rows.find(row => row.key === 'node');
  const price = states.rows.find(row => row.key === 'bnb_price');
  const leaderboard = states.rows.find(row => row.key === 'leaderboard_24h');
  return { ...counts.rows[0], lastNodeBlock: node?.value?.blockNumber ?? null, nodeLagBlocks: node?.value?.headBlock != null ? Math.max(0, Number(node.value.headBlock) - Number(node.value.blockNumber)) : null, lastNodeAt: node?.updated_at ?? null, bnbPriceUsd: price?.value?.priceUsd ?? null, bnbPriceAt: price?.value?.oracleUpdatedAt ?? null, lastLeaderboardAt: leaderboard?.value?.source === 'node_fifo' ? leaderboard.updated_at : null, leaderboardSource: 'node_fifo' };
});

app.get<{ Querystring: { limit?: string; cursor?: string; side?: string; kol?: string; token?: string; window?: string } }>('/api/trades', async request => {
  const { limit, cursor, side, kol, token, window } = request.query;
  const values: unknown[] = [];
  const where: string[] = ['k.is_tracked', 't.block_number IS NOT NULL', kol ? kolProfileTokenSql() : nonStockTokenSql('t.token_address')];
  if (window === '24h') where.push(`t.timestamp > now() - interval '24 hours'`);
  if (window === 'today') { values.push(todayStart()); where.push(`t.timestamp >= $${values.length}::timestamptz`); }
  if (side && ['buy', 'sell', 'swap'].includes(side)) { values.push(side); where.push(`t.side=$${values.length}`); }
  if (kol) { const key = address(kol); if (!key) return { items: [], nextCursor: null }; values.push(key); where.push(`t.wallet_address=$${values.length}`); }
  if (token) { const key = address(token); if (!key) return { items: [], nextCursor: null }; values.push(key); where.push(`t.token_address=$${values.length}`); }
  if (cursor) {
    try { const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString()); if (typeof parsed.ts === 'string' && typeof parsed.id === 'string') { values.push(parsed.ts, parsed.id); where.push(`(t.timestamp,t.id)<($${values.length - 1}::timestamptz,$${values.length}::text)`); } } catch { /* Invalid cursor starts at latest. */ }
  }
  const count = int(limit, 50, 100);
  values.push(count + 1);
  const result = await pool.query(`SELECT ${tradeSelect()} FROM trades t JOIN published_kols k ON k.address=t.wallet_address JOIN tokens v ON v.address=t.token_address ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY t.timestamp DESC,t.id DESC LIMIT $${values.length}`, values);
  const rows = result.rows.slice(0, count);
  const last = rows.at(-1);
  return { items: rows, nextCursor: result.rows.length > count ? nextTradeCursor(last) : null };
});

app.get<{ Querystring: { limit?: string; offset?: string; since?: string; withTrades?: string } }>('/api/tokens', async (request, reply) => {
  const limit = int(request.query.limit, 150, 300);
  const offsetRaw = Number(request.query.offset);
  const offset = Number.isInteger(offsetRaw) && offsetRaw >= 0 ? Math.min(offsetRaw, 100000) : 0;
  const since = request.query.since ? new Date(request.query.since) : null;
  if (since && Number.isNaN(since.getTime())) return reply.code(400).send({ error: 'Invalid since date' });
  const sinceValue = since?.toISOString();
  const [result, count] = await Promise.all([
    pool.query(`SELECT ${tokenSelect()} FROM tokens v JOIN trades t ON t.token_address=v.address JOIN published_kols k ON k.address=t.wallet_address WHERE k.is_tracked AND t.block_number IS NOT NULL AND ${nonStockTokenSql('t.token_address')} AND ${memeTokenSql()} GROUP BY v.address ${sinceValue ? 'HAVING MAX(t.timestamp) >= $3::timestamptz' : ''} ORDER BY MAX(t.timestamp) DESC,v.address ASC LIMIT $1 OFFSET $2`, sinceValue ? [limit, offset, sinceValue] : [limit, offset]),
    pool.query(`SELECT COUNT(DISTINCT t.token_address)::int AS total FROM trades t JOIN published_kols k ON k.address=t.wallet_address JOIN tokens v ON v.address=t.token_address WHERE k.is_tracked AND t.block_number IS NOT NULL AND ${nonStockTokenSql('t.token_address')} AND ${memeTokenSql()} ${sinceValue ? 'AND t.timestamp >= $1::timestamptz' : ''}`, sinceValue ? [sinceValue] : []),
  ]);
  const tradeRows = request.query.withTrades === '1' && result.rows.length ? (await pool.query(`
    SELECT ${tradeSelect()} FROM unnest($1::text[]) AS candidate(address)
    CROSS JOIN LATERAL (
      SELECT t.* FROM trades t JOIN published_kols tracked ON tracked.address=t.wallet_address
      WHERE t.token_address=candidate.address AND tracked.is_tracked AND t.block_number IS NOT NULL AND ${nonStockTokenSql('t.token_address')}
      ORDER BY t.timestamp DESC,t.id DESC LIMIT 5
    ) t
    JOIN published_kols k ON k.address=t.wallet_address JOIN tokens v ON v.address=t.token_address
    ORDER BY t.token_address,t.timestamp DESC,t.id DESC
  `, [result.rows.map(row => row.address)])).rows : [];
  const tradesByToken = new Map<string, typeof tradeRows>();
  for (const trade of tradeRows) {
    const trades = tradesByToken.get(trade.tokenAddress) ?? [];
    trades.push(trade);
    tradesByToken.set(trade.tokenAddress, trades);
  }
  const total = count.rows[0]?.total || 0;
  return { items: request.query.withTrades === '1' ? result.rows.map(row => ({ ...row, recentTrades: tradesByToken.get(row.address) ?? [] })) : result.rows, total, nextOffset: offset + result.rows.length < total ? offset + result.rows.length : null };
});

const websiteRequests = new Map<string, Promise<string | null>>();
app.get<{ Params: { address: string } }>('/api/tokens/:address/translation', async (request, reply) => {
  const key = address(request.params.address);
  if (!key) return reply.code(400).send({ error: 'Invalid token address' });
  const result = await getTokenTranslation(key);
  return reply.header('Cache-Control', result.englishName ? 'public, max-age=300' : 'no-store').send(result);
});
app.get<{ Params: { address: string } }>('/api/tokens/:address/website', async request => {
  const key = address(request.params.address);
  if (!key) return { tokenAddress: null, websiteUrl: null };
  const cached = await pool.query(`SELECT website_url,website_checked_at > now() - interval '1 hour' AS fresh FROM tokens WHERE address=$1`, [key]);
  const row = cached.rows[0];
  if (!row || row.fresh) return { tokenAddress: key, websiteUrl: row?.website_url ?? null };
  let pending = websiteRequests.get(key);
  if (!pending) {
    pending = (async () => {
      try {
        const website = await lookupTokenWebsite(key);
        const result = await pool.query(`UPDATE tokens SET website_url=COALESCE($2,website_url),website_checked_at=now() WHERE address=$1 RETURNING website_url`, [key, website]);
        return result.rows[0]?.website_url ?? null;
      } finally { websiteRequests.delete(key); }
    })();
    websiteRequests.set(key, pending);
  }
  return { tokenAddress: key, websiteUrl: await pending };
});

app.get<{ Params: { address: string } }>('/api/tokens/:address', async request => {
  const key = address(request.params.address);
  if (!key) return { token: null, trades: [], tradesNextCursor: null, kols: [] };
  const [token, trades, kols] = await Promise.all([
    pool.query(`SELECT ${tokenSelect()} FROM tokens v LEFT JOIN trades t ON t.token_address=v.address AND t.block_number IS NOT NULL
      AND EXISTS(SELECT 1 FROM published_kols public_kol WHERE public_kol.address=t.wallet_address AND public_kol.is_tracked)
      WHERE v.address=$1 AND ${nonStockTokenSql()} AND ${publicTokenEvidenceSql()} GROUP BY v.address`, [key]),
    pool.query(`SELECT ${tradeSelect()} FROM trades t JOIN published_kols k ON k.address=t.wallet_address JOIN tokens v ON v.address=t.token_address WHERE t.token_address=$1 AND k.is_tracked AND t.block_number IS NOT NULL AND ${nonStockTokenSql('t.token_address')} ORDER BY t.timestamp DESC,t.id DESC LIMIT 21`, [key]),
    pool.query(`SELECT k.address,k.display_name AS name,k.avatar_url AS "avatarUrl",k.twitter,k.source,k.last_seen_at AS "lastSeenAt",json_build_object('claimed',k.creator_claimed,'walletControlVerified',k.creator_claimed,'bio',k.creator_bio,'websiteUrl',k.creator_website_url,'xUrl',k.creator_x_url,'telegramUrl',k.creator_telegram_url,'updatedAt',k.creator_updated_at) AS creator FROM published_kols k JOIN tokens v ON v.address=$1 WHERE k.is_tracked AND ${nonStockTokenSql()} AND ${publicTokenEvidenceSql('v','k')} ORDER BY k.address`, [key]),
  ]);
  const tradeRows = trades.rows.slice(0, 20);
  return { token: token.rows[0] ?? null, trades: tradeRows,
    tradesNextCursor: trades.rows.length > 20 ? nextTradeCursor(tradeRows.at(-1)) : null,
    kols: kols.rows };
});

app.get('/api/leaderboard', async () => {
  const windowStart = last24hStart();
  const periodActivity = `(a.wallet_address IS NOT NULL OR COALESCE((s.node_accounting->>'valuedTransferOutCount')::integer,0)>0 OR COALESCE((s.node_accounting->>'valuedFeeCount')::integer,0)>0)`;
  const rankEligible = `(s.realized_profit_usd IS NOT NULL AND ${periodActivity})`;
  const result = await pool.query(`WITH activity AS (
      SELECT t.wallet_address,COUNT(*)::int AS "tradeCount24h",
        COUNT(*) FILTER (WHERE t.side='buy')::int AS "buyCount24h",
        COUNT(*) FILTER (WHERE t.side='sell')::int AS "sellCount24h",
        COUNT(*) FILTER (WHERE t.side='sell' AND t.amount_usd IS NULL)::int AS "unpricedSellCount24h",
        MAX(t.timestamp) AS "lastTrade24h"
      FROM trades t JOIN published_kols tracked ON tracked.address=t.wallet_address
      JOIN tokens v ON v.address=t.token_address
      WHERE tracked.is_tracked AND t.block_number IS NOT NULL AND ${kolProfileTokenSql()} AND t.timestamp >= $1::timestamptz
      GROUP BY t.wallet_address
    )
    SELECT k.address,k.display_name AS name,k.avatar_url AS "avatarUrl",k.twitter,k.source,k.last_seen_at AS "lastSeenAt",json_build_object('claimed',k.creator_claimed,'walletControlVerified',k.creator_claimed,'bio',k.creator_bio,'websiteUrl',k.creator_website_url,'xUrl',k.creator_x_url,'telegramUrl',k.creator_telegram_url,'updatedAt',k.creator_updated_at) AS creator,
      s.realized_profit_usd AS "realizedProfitUsd",s.unrealized_profit_usd AS "unrealizedProfitUsd",s.updated_at AS "updatedAt",
      s.node_accounting AS accounting,s.node_accounting->>'knownRealizedProfitUsd' AS "knownRealizedProfitUsd",
      s.valued_sell_count AS "valuedSellCount",s.excluded_sell_count AS "excludedSellCount",
      COALESCE(a."tradeCount24h",0) AS "tradeCount24h",COALESCE(a."buyCount24h",0) AS "buyCount24h",COALESCE(a."sellCount24h",0) AS "sellCount24h",
      COALESCE(a."unpricedSellCount24h",0) AS "unpricedSellCount24h"
    FROM published_kols k LEFT JOIN activity a ON k.address=a.wallet_address
    LEFT JOIN leaderboard_snapshots s ON s.wallet_address=k.address AND s.period='1d' AND s.window_start IS NOT NULL
      AND s.node_accounting->>'version'='1' AND s.node_accounting->>'policy'='kollens_fifo_v1'
    WHERE k.is_tracked
    ORDER BY ${rankEligible} DESC,
      CASE WHEN ${rankEligible} THEN s.realized_profit_usd END DESC NULLS LAST,
      ${periodActivity} DESC,
      COALESCE(a."tradeCount24h",0) DESC,a."lastTrade24h" DESC NULLS LAST,k.display_name,k.address`, [windowStart]);
  return { items: result.rows, windowStart, period: '24h', accountingPolicy: 'kollens_fifo_v1' };
});

async function kolTokenPage(key: string, cursor?: string) {
  const values: unknown[] = [key];
  let having = '';
  if (cursor) {
    try {
      const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString());
      if (typeof parsed.ts === 'string' && Number.isFinite(Date.parse(parsed.ts)) && typeof parsed.address === 'string' && address(parsed.address)) {
        values.push(parsed.ts, parsed.address);
        having = 'HAVING (MAX(t.timestamp),v.address)<($2::timestamptz,$3::text)';
      }
    } catch { /* Invalid cursor starts at latest. */ }
  }
  const result = await pool.query(`WITH movements AS (
    SELECT t.wallet_address,t.token_address,t.side,t.timestamp,t.amount_usd FROM trades t
      WHERE t.wallet_address=$1 AND t.block_number IS NOT NULL
    UNION ALL
    SELECT m.wallet_address,m.token_address,m.event->>'kind',(m.event->>'timestamp')::timestamptz,(m.event->>'amountUsd')::numeric
      FROM node_import_movements m JOIN node_accounting_baselines b USING(wallet_address,token_address)
      JOIN node_evidence_blocks checkpoint ON checkpoint.block_number=b.checkpoint_block
        AND checkpoint.block_hash=b.checkpoint_hash AND checkpoint.timestamp=b.checkpoint_timestamp
      WHERE m.wallet_address=$1 AND b.invalidated_at IS NULL AND b.schema_version=2 AND m.event->>'kind' IN ('buy','sell')
        AND NOT EXISTS(SELECT 1 FROM trades n WHERE n.wallet_address=m.wallet_address AND n.token_address=m.token_address
          AND n.tx_hash=m.event->>'txHash' AND n.side=m.event->>'kind' AND n.block_number IS NOT NULL)
  ) SELECT ${tokenSelect()} FROM tokens v JOIN movements t ON t.token_address=v.address JOIN published_kols k ON k.address=t.wallet_address
    WHERE k.is_tracked AND ${kolProfileTokenSql()} GROUP BY v.address ${having} ORDER BY MAX(t.timestamp) DESC,v.address DESC LIMIT ${kolProfileTokenPageSize + 1}`, values);
  const items = result.rows.slice(0, kolProfileTokenPageSize);
  const summaries = await nodeAccountingService.summaries(key, items.map(item => item.address));
  for (const item of items) item.accountingSummary = summaries[item.address];
  const last = items.at(-1);
  return { items, nextCursor: result.rows.length > kolProfileTokenPageSize && last ? Buffer.from(JSON.stringify({ ts: last.lastTradeAt, address: last.address })).toString('base64url') : null };
}

app.get<{ Params: { address: string }; Querystring: { cursor?: string } }>('/api/kols/:address/tokens', async request => {
  const key = address(request.params.address);
  return key ? kolTokenPage(key, request.query.cursor) : { items: [], nextCursor: null };
});

app.get<{ Params: { address: string } }>('/api/kols/:address', async request => {
  const key = address(request.params.address);
  const windowStart = last24hStart();
  if (!key) return { kol: null, stats: null, trades: [], tradesNextCursor: null, tradeCount24h: 0, buyCount24h: 0, sellCount24h: 0, tokens: [], tokensNextCursor: null, windowStart };
  const [kol, stats, trades, activity, tokens] = await Promise.all([
    pool.query(`SELECT k.address,k.display_name AS name,k.avatar_url AS "avatarUrl",k.twitter,k.source,
      json_build_object('claimed',k.creator_claimed,'walletControlVerified',k.creator_claimed,'bio',k.creator_bio,'websiteUrl',k.creator_website_url,'xUrl',k.creator_x_url,'telegramUrl',k.creator_telegram_url,'updatedAt',k.creator_updated_at) AS creator,
      (SELECT t.timestamp FROM trades t JOIN tokens v ON v.address=t.token_address
        WHERE t.wallet_address=k.address AND t.block_number IS NOT NULL AND ${kolProfileTokenSql()}
        ORDER BY t.timestamp DESC LIMIT 1) AS "lastSeenAt"
      FROM published_kols k WHERE k.address=$1 AND k.is_tracked`, [key]),
    pool.query(`SELECT s.realized_profit_usd AS "realizedProfitUsd",s.unrealized_profit_usd AS "unrealizedProfitUsd",s.updated_at AS "updatedAt",
      s.node_accounting AS accounting,s.node_accounting->>'knownRealizedProfitUsd' AS "knownRealizedProfitUsd",
      s.valued_sell_count AS "valuedSellCount",s.excluded_sell_count AS "excludedSellCount" FROM leaderboard_snapshots s
      JOIN published_kols k ON k.address=s.wallet_address WHERE s.wallet_address=$1 AND s.period='1d' AND s.window_start IS NOT NULL
        AND s.node_accounting->>'version'='1' AND s.node_accounting->>'policy'='kollens_fifo_v1' AND k.is_tracked`, [key]),
    pool.query(`SELECT ${tradeSelect()} FROM trades t JOIN published_kols k ON k.address=t.wallet_address JOIN tokens v ON v.address=t.token_address WHERE t.wallet_address=$1 AND k.is_tracked AND t.block_number IS NOT NULL AND ${kolProfileTokenSql()} AND t.timestamp >= $2::timestamptz ORDER BY t.timestamp DESC,t.id DESC LIMIT ${kolProfileTradePageSize + 1}`, [key, windowStart]),
    pool.query(`SELECT COUNT(*)::int AS "tradeCount24h",COUNT(*) FILTER (WHERE t.side='buy')::int AS "buyCount24h",COUNT(*) FILTER (WHERE t.side='sell')::int AS "sellCount24h",COUNT(*) FILTER (WHERE t.side='sell' AND t.amount_usd IS NULL)::int AS "unpricedSellCount24h" FROM trades t JOIN published_kols k ON k.address=t.wallet_address JOIN tokens v ON v.address=t.token_address WHERE t.wallet_address=$1 AND k.is_tracked AND t.block_number IS NOT NULL AND ${kolProfileTokenSql()} AND t.timestamp >= $2::timestamptz`, [key, windowStart]),
    kolTokenPage(key),
  ]);
  const tradeRows = trades.rows.slice(0, kolProfileTradePageSize);
  return { kol: kol.rows[0] ?? null, stats: stats.rows[0] ?? null, trades: tradeRows,
    tradesNextCursor: trades.rows.length > kolProfileTradePageSize ? nextTradeCursor(tradeRows.at(-1)) : null,
    ...activity.rows[0], tokens: tokens.items, tokensNextCursor: tokens.nextCursor, windowStart };
});

app.get<{ Querystring: { q?: string } }>('/api/search', async request => {
  const query = (request.query.q || '').trim().slice(0, 100);
  if (!query) return { kols: [], tokens: [] };
  const like = `%${query.replace(/[%_]/g, '\\$&')}%`;
  const [kols, tokens] = await Promise.all([
    pool.query(`SELECT address,display_name AS name,avatar_url AS "avatarUrl",twitter,source,last_seen_at AS "lastSeenAt" FROM published_kols WHERE is_tracked AND (display_name ILIKE $1 ESCAPE '\\' OR address ILIKE $1 ESCAPE '\\' OR twitter ILIKE $1 ESCAPE '\\') ORDER BY last_seen_at DESC NULLS LAST LIMIT 8`, [like]),
    pool.query(`SELECT v.address,v.symbol,v.name,${logoUrl} AS "logoUrl",${tokenPrice} AS "priceUsd",${tokenMarketCap} AS "marketCapUsd",NULL AS "change24h",0 AS "kolCount24h",0 AS "buys24h",0 AS "sells24h",NULL AS "volume24hUsd",NULL AS "lastTradeAt" FROM tokens v WHERE (v.symbol ILIKE $1 ESCAPE '\\' OR v.name ILIKE $1 ESCAPE '\\' OR v.address ILIKE $1 ESCAPE '\\') AND EXISTS (SELECT 1 FROM trades t JOIN published_kols k ON k.address=t.wallet_address WHERE t.token_address=v.address AND k.is_tracked AND t.block_number IS NOT NULL AND ${nonStockTokenSql('t.token_address')}) ORDER BY v.metadata_updated_at DESC NULLS LAST LIMIT 8`, [like]),
  ]);
  return { kols: kols.rows, tokens: tokens.rows };
});

app.get('/api/stream', async (request, reply) => {
  reply.hijack();
  const response = reply.raw;
  response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  response.write(': connected\n\n');
  clients.add(response);
  const timer = setInterval(() => response.write(': heartbeat\n\n'), 20000);
  response.on('close', () => { clearInterval(timer); clients.delete(response); });
});

await registerFrontendRoutes(app, publicDir, process.env.FRONTEND_ASSET_CACHE_DIR);

async function listenForUpdates() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  try {
    await client.connect();
    await client.query('LISTEN bscan_update');
    client.on('notification', () => { for (const response of clients) response.write('event: update\ndata: {}\n\n'); });
    client.on('error', error => { app.log.error(error); setTimeout(() => void listenForUpdates(), 5000); });
  } catch (error) { app.log.error(error); setTimeout(() => void listenForUpdates(), 5000); }
}

await ensureSchema();
await ensureSeeds();
void listenForUpdates();
await app.listen({ host: '127.0.0.1', port: Number(process.env.PORT || 3300) });
