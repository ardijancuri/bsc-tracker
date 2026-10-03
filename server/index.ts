import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { Client } from 'pg';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureSchema, pool } from './db.js';
import { ensureSeeds } from './seeds.js';
import { last24hStart, todayStart } from './dayWindow.js';
import { memeTokenSql } from './memeToken.js';

const app = Fastify({ logger: true, trustProxy: true });
const root = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(root, '..', 'dist');
const addressPattern = /^0x[a-fA-F0-9]{40}$/;
const clients = new Set<import('node:http').ServerResponse>();

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
const tokenMarketCap = `CASE WHEN v.market_cap_usd > 0 AND v.market_cap_checked_at > now() - interval '2 hours' THEN v.market_cap_usd WHEN v.price_source='onchain' AND v.price_usd > 0 AND v.total_supply_raw > 0 AND v.decimals BETWEEN 0 AND 36 AND v.supply_checked_at > now() - interval '2 days' THEN v.price_usd * v.total_supply_raw / power(10::numeric, v.decimals) END`;
function tokenSelect() { return `v.address, v.symbol, v.name, ${logoUrl} AS "logoUrl", CASE WHEN v.price_source='onchain' THEN v.price_usd END AS "priceUsd", ${tokenMarketCap} AS "marketCapUsd", NULL AS "change24h", COUNT(DISTINCT t.wallet_address) FILTER (WHERE t.timestamp > now() - interval '24 hours')::int AS "kolCount24h", COUNT(*) FILTER (WHERE t.timestamp > now() - interval '24 hours' AND t.side='buy')::int AS "buys24h", COUNT(*) FILTER (WHERE t.timestamp > now() - interval '24 hours' AND t.side='sell')::int AS "sells24h", SUM(t.amount_usd) FILTER (WHERE t.timestamp > now() - interval '24 hours') AS "volume24hUsd", MAX(t.timestamp) AS "lastTradeAt"`; }

app.get('/api/health', async () => {
  await pool.query('SELECT 1');
  return { ok: true, service: 'bscan-api' };
});

app.get<{ Params: { address: string } }>('/api/token-image/:address', async (request, reply) => {
  const key = address(request.params.address);
  if (!key) return reply.code(404).send({ error: 'Not found' });
  const result = await pool.query('SELECT logo_data,logo_mime FROM tokens WHERE address=$1', [key]);
  const image = result.rows[0];
  if (!image?.logo_data || !image?.logo_mime) return reply.code(404).send({ error: 'Not found' });
  return reply.header('Cache-Control', 'public, max-age=3600').header('X-Content-Type-Options', 'nosniff').type(image.logo_mime).send(image.logo_data);
});

app.get('/api/overview', async () => {
  const [counts, states] = await Promise.all([
    pool.query(`SELECT (SELECT COUNT(*)::int FROM kols WHERE is_tracked) AS "trackedKols",
      (SELECT COUNT(*)::int FROM trades t JOIN kols k ON k.address=t.wallet_address WHERE k.is_tracked AND t.block_number IS NOT NULL AND t.timestamp > now() - interval '24 hours') AS "trades24h",
      (SELECT COUNT(DISTINCT t.token_address)::int FROM trades t JOIN kols k ON k.address=t.wallet_address WHERE k.is_tracked AND t.block_number IS NOT NULL AND t.timestamp > now() - interval '24 hours') AS "tokens24h",
      (SELECT MAX(t.timestamp) FROM trades t JOIN kols k ON k.address=t.wallet_address WHERE k.is_tracked AND t.block_number IS NOT NULL) AS "latestTradeAt",
      (SELECT MAX(metadata_updated_at) FROM tokens WHERE price_source='onchain' AND price_usd IS NOT NULL) AS "lastTokenPriceAt"`),
    pool.query(`SELECT key,value,updated_at FROM worker_state WHERE key IN ('node','bnb_price','leaderboard_24h')`),
  ]);
  const node = states.rows.find(row => row.key === 'node');
  const price = states.rows.find(row => row.key === 'bnb_price');
  const leaderboard = states.rows.find(row => row.key === 'leaderboard_24h');
  return { ...counts.rows[0], lastNodeBlock: node?.value?.blockNumber ?? null, nodeLagBlocks: node?.value?.headBlock != null ? Math.max(0, Number(node.value.headBlock) - Number(node.value.blockNumber)) : null, lastNodeAt: node?.updated_at ?? null, bnbPriceUsd: price?.value?.priceUsd ?? null, bnbPriceAt: price?.value?.oracleUpdatedAt ?? null, lastLeaderboardAt: leaderboard?.updated_at ?? null, leaderboardSource: leaderboard?.value?.source ?? 'onchain_estimate' };
});

app.get<{ Querystring: { limit?: string; cursor?: string; side?: string; kol?: string; token?: string; window?: string } }>('/api/trades', async request => {
  const { limit, cursor, side, kol, token, window } = request.query;
  const values: unknown[] = [];
  const where: string[] = ['k.is_tracked', 't.block_number IS NOT NULL'];
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
  const result = await pool.query(`SELECT ${tradeSelect()} FROM trades t JOIN kols k ON k.address=t.wallet_address JOIN tokens v ON v.address=t.token_address ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY t.timestamp DESC,t.id DESC LIMIT $${values.length}`, values);
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
    pool.query(`SELECT ${tokenSelect()} FROM tokens v JOIN trades t ON t.token_address=v.address JOIN kols k ON k.address=t.wallet_address WHERE k.is_tracked AND t.block_number IS NOT NULL AND ${memeTokenSql()} GROUP BY v.address ${sinceValue ? 'HAVING MAX(t.timestamp) >= $3::timestamptz' : ''} ORDER BY MAX(t.timestamp) DESC,v.address ASC LIMIT $1 OFFSET $2`, sinceValue ? [limit, offset, sinceValue] : [limit, offset]),
    pool.query(`SELECT COUNT(DISTINCT t.token_address)::int AS total FROM trades t JOIN kols k ON k.address=t.wallet_address JOIN tokens v ON v.address=t.token_address WHERE k.is_tracked AND t.block_number IS NOT NULL AND ${memeTokenSql()} ${sinceValue ? 'AND t.timestamp >= $1::timestamptz' : ''}`, sinceValue ? [sinceValue] : []),
  ]);
  const tradeRows = request.query.withTrades === '1' && result.rows.length ? (await pool.query(`
    SELECT ${tradeSelect()} FROM unnest($1::text[]) AS candidate(address)
    CROSS JOIN LATERAL (
      SELECT t.* FROM trades t JOIN kols tracked ON tracked.address=t.wallet_address
      WHERE t.token_address=candidate.address AND tracked.is_tracked AND t.block_number IS NOT NULL
      ORDER BY t.timestamp DESC,t.id DESC LIMIT 5
    ) t
    JOIN kols k ON k.address=t.wallet_address JOIN tokens v ON v.address=t.token_address
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

app.get<{ Params: { address: string } }>('/api/tokens/:address', async request => {
  const key = address(request.params.address);
  if (!key) return { token: null, trades: [], tradesNextCursor: null, kols: [] };
  const [token, trades, kols] = await Promise.all([
    pool.query(`SELECT ${tokenSelect()} FROM tokens v JOIN trades t ON t.token_address=v.address JOIN kols k ON k.address=t.wallet_address WHERE v.address=$1 AND k.is_tracked AND t.block_number IS NOT NULL GROUP BY v.address`, [key]),
    pool.query(`SELECT ${tradeSelect()} FROM trades t JOIN kols k ON k.address=t.wallet_address JOIN tokens v ON v.address=t.token_address WHERE t.token_address=$1 AND k.is_tracked AND t.block_number IS NOT NULL ORDER BY t.timestamp DESC,t.id DESC LIMIT 21`, [key]),
    pool.query(`SELECT DISTINCT ON (k.address) k.address,k.display_name AS name,k.avatar_url AS "avatarUrl",k.twitter,k.source,k.last_seen_at AS "lastSeenAt" FROM kols k JOIN trades t ON t.wallet_address=k.address WHERE t.token_address=$1 AND k.is_tracked AND t.block_number IS NOT NULL ORDER BY k.address,t.timestamp DESC LIMIT 50`, [key]),
  ]);
  const tradeRows = trades.rows.slice(0, 20);
  return { token: token.rows[0] ?? null, trades: tradeRows,
    tradesNextCursor: trades.rows.length > 20 ? nextTradeCursor(tradeRows.at(-1)) : null,
    kols: kols.rows };
});

app.get('/api/leaderboard', async () => {
  const windowStart = last24hStart();
  const result = await pool.query(`WITH activity AS (
      SELECT t.wallet_address,COUNT(*)::int AS "tradeCount24h",
        COUNT(*) FILTER (WHERE t.side='buy')::int AS "buyCount24h",
        COUNT(*) FILTER (WHERE t.side='sell')::int AS "sellCount24h",
        COUNT(*) FILTER (WHERE t.side='sell' AND t.amount_usd IS NULL)::int AS "unpricedSellCount24h",
        MAX(t.timestamp) AS "lastTrade24h"
      FROM trades t JOIN kols tracked ON tracked.address=t.wallet_address
      WHERE tracked.is_tracked AND t.block_number IS NOT NULL AND t.timestamp >= $1::timestamptz
      GROUP BY t.wallet_address
    )
    SELECT k.address,k.display_name AS name,k.avatar_url AS "avatarUrl",k.twitter,k.source,k.last_seen_at AS "lastSeenAt",
      CASE WHEN a.wallet_address IS NULL THEN 0 ELSE s.realized_profit_usd END AS "realizedProfitUsd",s.unrealized_profit_usd AS "unrealizedProfitUsd",s.updated_at AS "updatedAt",
      s.valued_sell_count AS "valuedSellCount",s.excluded_sell_count AS "excludedSellCount",
      COALESCE(a."tradeCount24h",0) AS "tradeCount24h",COALESCE(a."buyCount24h",0) AS "buyCount24h",COALESCE(a."sellCount24h",0) AS "sellCount24h",
      COALESCE(a."unpricedSellCount24h",0) AS "unpricedSellCount24h"
    FROM kols k LEFT JOIN activity a ON k.address=a.wallet_address
    LEFT JOIN leaderboard_snapshots s ON s.wallet_address=k.address AND s.period='1d' AND s.window_start IS NOT NULL
    WHERE k.is_tracked
    ORDER BY (a.wallet_address IS NOT NULL) DESC,s.realized_profit_usd DESC NULLS LAST,a."tradeCount24h" DESC,a."lastTrade24h" DESC,k.display_name,k.address`, [windowStart]);
  return { items: result.rows, windowStart, period: '24h' };
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
  const result = await pool.query(`SELECT ${tokenSelect()} FROM tokens v JOIN trades t ON t.token_address=v.address JOIN kols k ON k.address=t.wallet_address WHERE t.wallet_address=$1 AND k.is_tracked AND t.block_number IS NOT NULL GROUP BY v.address ${having} ORDER BY MAX(t.timestamp) DESC,v.address DESC LIMIT 11`, values);
  const items = result.rows.slice(0, 10);
  const last = items.at(-1);
  return { items, nextCursor: result.rows.length > 10 && last ? Buffer.from(JSON.stringify({ ts: last.lastTradeAt, address: last.address })).toString('base64url') : null };
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
    pool.query(`SELECT address,display_name AS name,avatar_url AS "avatarUrl",twitter,source,last_seen_at AS "lastSeenAt" FROM kols WHERE address=$1 AND is_tracked`, [key]),
    pool.query(`SELECT s.realized_profit_usd AS "realizedProfitUsd",s.unrealized_profit_usd AS "unrealizedProfitUsd",s.updated_at AS "updatedAt",s.valued_sell_count AS "valuedSellCount",s.excluded_sell_count AS "excludedSellCount" FROM leaderboard_snapshots s JOIN kols k ON k.address=s.wallet_address WHERE s.wallet_address=$1 AND s.period='1d' AND s.window_start IS NOT NULL AND k.is_tracked`, [key]),
    pool.query(`SELECT ${tradeSelect()} FROM trades t JOIN kols k ON k.address=t.wallet_address JOIN tokens v ON v.address=t.token_address WHERE t.wallet_address=$1 AND k.is_tracked AND t.block_number IS NOT NULL AND t.timestamp >= $2::timestamptz ORDER BY t.timestamp DESC,t.id DESC LIMIT 21`, [key, windowStart]),
    pool.query(`SELECT COUNT(*)::int AS "tradeCount24h",COUNT(*) FILTER (WHERE t.side='buy')::int AS "buyCount24h",COUNT(*) FILTER (WHERE t.side='sell')::int AS "sellCount24h",COUNT(*) FILTER (WHERE t.side='sell' AND t.amount_usd IS NULL)::int AS "unpricedSellCount24h" FROM trades t JOIN kols k ON k.address=t.wallet_address WHERE t.wallet_address=$1 AND k.is_tracked AND t.block_number IS NOT NULL AND t.timestamp >= $2::timestamptz`, [key, windowStart]),
    kolTokenPage(key),
  ]);
  const tradeRows = trades.rows.slice(0, 20);
  return { kol: kol.rows[0] ?? null, stats: stats.rows[0] ?? null, trades: tradeRows,
    tradesNextCursor: trades.rows.length > 20 ? nextTradeCursor(tradeRows.at(-1)) : null,
    ...activity.rows[0], tokens: tokens.items, tokensNextCursor: tokens.nextCursor, windowStart };
});

app.get<{ Querystring: { q?: string } }>('/api/search', async request => {
  const query = (request.query.q || '').trim().slice(0, 100);
  if (!query) return { kols: [], tokens: [] };
  const like = `%${query.replace(/[%_]/g, '\\$&')}%`;
  const [kols, tokens] = await Promise.all([
    pool.query(`SELECT address,display_name AS name,avatar_url AS "avatarUrl",twitter,source,last_seen_at AS "lastSeenAt" FROM kols WHERE is_tracked AND (display_name ILIKE $1 ESCAPE '\\' OR address ILIKE $1 ESCAPE '\\' OR twitter ILIKE $1 ESCAPE '\\') ORDER BY last_seen_at DESC NULLS LAST LIMIT 8`, [like]),
    pool.query(`SELECT v.address,v.symbol,v.name,${logoUrl} AS "logoUrl",CASE WHEN v.price_source='onchain' THEN v.price_usd END AS "priceUsd",${tokenMarketCap} AS "marketCapUsd",NULL AS "change24h",0 AS "kolCount24h",0 AS "buys24h",0 AS "sells24h",NULL AS "volume24hUsd",NULL AS "lastTradeAt" FROM tokens v WHERE (v.symbol ILIKE $1 ESCAPE '\\' OR v.name ILIKE $1 ESCAPE '\\' OR v.address ILIKE $1 ESCAPE '\\') AND EXISTS (SELECT 1 FROM trades t JOIN kols k ON k.address=t.wallet_address WHERE t.token_address=v.address AND k.is_tracked AND t.block_number IS NOT NULL) ORDER BY v.metadata_updated_at DESC NULLS LAST LIMIT 8`, [like]),
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

app.register(fastifyStatic, { root: publicDir, prefix: '/', wildcard: false });
app.setNotFoundHandler((request, reply) => {
  if (request.url.startsWith('/api/')) return reply.code(404).send({ error: 'Not found' });
  return reply.type('text/html').sendFile('index.html');
});

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
