import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { pool } from './db.js';
import { watchlistMarket } from './watchlistMarket.js';
import { nodeMarketService } from './nodeMarket.js';
import { tokenChartRecovery } from './nodeTokenChartRecovery.js';
import { databaseChart } from './nodeReplayPreparation.js';
import { nodeTokenMarketSql, publicTokenEvidenceSql } from './nodeMarketReadSql.js';
import { nonStockTokenSql } from './stockToken.js';
import { candleIntervals, watchPeriods, type ChartRange, type WatchPeriod, type PositionStatus } from '../shared/intelligence.js';
import { decimalUnits, defaultSignalSettings, positionIsFresh } from './intelligenceLogic.js';
import { registerKolTokenTradesRoutes } from './kolTokenTradesApi.js';
import { resolveAuthUser, authSessionSecret } from './telegramAuth.js';
import { hashSecret, sessionSecret, watchCookieName } from './watchSessionSecrets.js';
export { hashSecret, sessionSecret } from './watchSessionSecrets.js';

const addressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform(value => value.toLowerCase());
const watchSchema = z.object({ items: z.array(z.object({ kind: z.enum(['kol', 'token']), address: addressSchema }).strict()).max(200) }).strict();
const cookieName = watchCookieName;
type Session = { id: string; kind: 'guest' | 'account' };
const entryTable = (session: Session) => session.kind === 'account' ? 'account_watch_entries' : 'watch_entries';
const ownerColumn = (session: Session) => session.kind === 'account' ? 'user_id' : 'session_id';
const ownerTable = (session: Session) => session.kind === 'account' ? 'auth_users' : 'watch_sessions';
const attempts = new Map<string, { count: number; until: number }>();
function mutationAllowed(request: FastifyRequest, reply: FastifyReply) {
  const origin = request.headers.origin;
  const expected = new URL(process.env.PUBLIC_APP_URL || 'https://kollens.com').origin;
  const development = process.env.NODE_ENV !== 'production' && origin === `${request.protocol}://${request.headers.host}`;
  if (origin !== expected && !development) { reply.code(403).send({ error: 'Request origin rejected' }); return false; }
  const now = Date.now();
  if (attempts.size > 5000) for (const [key, value] of attempts) if (value.until < now) attempts.delete(key);
  const key = request.ip;
  const previous = attempts.get(key);
  const state = previous && previous.until > now ? previous : { count: 0, until: now + 60_000 };
  attempts.set(key, state);
  if (++state.count > 120) { reply.header('Retry-After', '60').code(429).send({ error: 'Try again shortly' }); return false; }
  return true;
}
async function getSession(request: FastifyRequest): Promise<Session | null> {
  const user = await resolveAuthUser(request);
  if (user) return { id: user.id, kind: 'account' };
  const secret = sessionSecret(request.headers.cookie);
  if (!secret) return null;
  const result = await pool.query('SELECT id FROM watch_sessions WHERE secret_hash=$1 AND expires_at>now()', [hashSecret(secret)]);
  return result.rows[0] ? { ...result.rows[0], kind: 'guest' } : null;
}
function ownerAllowed(request: FastifyRequest, reply: FastifyReply, session: Session | null) {
  const expected = request.headers['x-watchlist-owner'];
  if (expected !== undefined && expected !== (session?.kind === 'account' ? session.id : 'guest')) {
    reply.code(409).send({ error: 'Your account changed. Refresh and try again.' }); return false;
  }
  if (!session || session.kind !== 'account') {
    const hasAuthCookie = (request.headers.cookie || '').split(';').some(cookie => cookie.trim().startsWith('bscan_auth='));
    if (hasAuthCookie && authSessionSecret(request.headers.cookie)) {
      reply.code(401).send({ error: 'Your session expired. Log in again.' }); return false;
    }
  }
  return true;
}
function privateResponse(reply: FastifyReply) { reply.header('Cache-Control', 'no-store').header('Vary', 'Cookie'); }
function setSessionCookie(reply: FastifyReply, secret: string) {
  reply.header('Set-Cookie', `${cookieName}=${secret}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`);
}
async function watchlist(session: Session | null, period: WatchPeriod = '24h', tokenAddress?: string) {
  const seconds = { '24h': 86400, '7d': 604800, '30d': 2592000 }[period];
  const bucketSeconds = { '24h': 1800, '7d': 10800, '30d': 43200 }[period];
  const items = session || tokenAddress ? (await pool.query(`WITH entries AS (
    ${tokenAddress ? `SELECT 'token'::text AS kind,v.address FROM tokens v WHERE v.address=$1 AND ${publicTokenEvidenceSql()}` : `SELECT kind,address FROM ${entryTable(session!)} WHERE ${ownerColumn(session!)}=$1`}
    ) SELECT e.kind,e.address,CASE WHEN e.kind='kol' THEN k.display_name ELSE v.name END AS name,
    ${nodeTokenMarketSql('price_usd')} AS "priceUsd",
    market.price_1h AS "price1hAgo",market.price_24h AS "price24hAgo",
    market.price_period AS "pricePeriodAgo",market.period_volume AS "periodVolumeUsd",COALESCE(stats.period_kols,0)::int AS "periodKolCount",
    market.volume AS "volume24hUsd",COALESCE(stats.kols,0)::int AS "kolCount24h",stats.last_trade AS "lastTradeAt",
    COALESCE(history.points,'[]'::json) AS "priceHistory",
    v.symbol,k.avatar_url AS "avatarUrl",CASE WHEN v.logo_data IS NOT NULL THEN '/api/token-image/'||v.address||'?v='||md5(v.logo_data) END AS "logoUrl",
    ${nodeTokenMarketSql('market_cap_usd')} AS "marketCapUsd",NULL AS "change24h"
    FROM entries e LEFT JOIN published_kols k ON e.kind='kol' AND k.address=e.address LEFT JOIN tokens v ON e.kind='token' AND v.address=e.address
    LEFT JOIN LATERAL (
      SELECT COUNT(DISTINCT t.wallet_address) FILTER(WHERE t.timestamp>now()-$2*interval '1 second') AS period_kols,
        COUNT(DISTINCT t.wallet_address) FILTER(WHERE t.timestamp>now()-interval '24 hours') AS kols,MAX(t.timestamp) AS last_trade
      FROM trades t JOIN published_kols tracked ON tracked.address=t.wallet_address AND tracked.is_tracked
      WHERE e.kind='token' AND t.token_address=e.address AND t.block_number IS NOT NULL
        AND t.timestamp>now()-($2+86400)*interval '1 second' AND t.timestamp<=now()
    ) stats ON true
    LEFT JOIN LATERAL (
      SELECT (array_agg(c.close ORDER BY c.minute DESC) FILTER(WHERE c.minute<=now()-interval '1 hour'))[1] AS price_1h,
        (array_agg(c.close ORDER BY c.minute DESC) FILTER(WHERE c.minute<=now()-interval '24 hours'))[1] AS price_24h,
        (array_agg(c.close ORDER BY c.minute DESC) FILTER(WHERE c.minute<=now()-$2*interval '1 second'))[1] AS price_period,
        SUM(c.volume_usd) FILTER(WHERE c.minute>now()-$2*interval '1 second') AS period_volume,
        SUM(c.volume_usd) FILTER(WHERE c.minute>now()-interval '24 hours') AS volume
      FROM node_market_candles c WHERE e.kind='token' AND c.token_address=e.address AND c.minute>now()-($2+86400)*interval '1 second'
    ) market ON true
    LEFT JOIN LATERAL (
      SELECT json_agg(json_build_object('timestamp',p.timestamp,'priceUsd',p.price_usd::text) ORDER BY p.timestamp) AS points
      FROM (SELECT samples.timestamp,samples.price_usd FROM (SELECT c.minute AS timestamp,c.close AS price_usd,
        row_number() OVER(PARTITION BY floor(extract(epoch FROM c.minute)/$3) ORDER BY c.minute,c.market_id) AS first_in_bucket,
        row_number() OVER(PARTITION BY floor(extract(epoch FROM c.minute)/$3) ORDER BY c.minute DESC,c.market_id DESC) AS last_in_bucket
        FROM node_market_candles c
        WHERE e.kind='token' AND c.token_address=e.address
          AND c.minute>now()-$2*interval '1 second' AND c.minute<=now()) samples
        WHERE samples.first_in_bucket=1 OR samples.last_in_bucket=1) p
    ) history ON true
    WHERE (e.kind='kol' OR ${nonStockTokenSql()} AND ${publicTokenEvidenceSql()}) ORDER BY e.kind,name NULLS LAST,e.address`, [tokenAddress || session!.id, seconds, bucketSeconds])).rows : [];
  return { items: items.map(item => watchlistMarket(item, period)), period };
}
function pageCursor(value: unknown) {
  if (value == null) return null;
  if (typeof value !== 'string' || value.length > 512) throw new Error('Invalid cursor');
  const decoded = JSON.parse(Buffer.from(value, 'base64url').toString());
  if (typeof decoded.ts !== 'string' || !Number.isFinite(Date.parse(decoded.ts)) || typeof decoded.id !== 'string' || decoded.id.length > 100) throw new Error('Invalid cursor');
  return decoded as { ts: string; id: string };
}
function limit(value: unknown) { const number = Number(value); return Number.isInteger(number) && number > 0 ? Math.min(number, 100) : 20; }
export function registerIntelligenceRoutes(app: FastifyInstance) {
  registerKolTokenTradesRoutes(app);
  // Market history is independent of which KOL wallets happened to trade.
  app.get<{ Params: { address: string }; Querystring: { period?: string; interval?: string; priority?: 'chart' | 'prefetch' | 'sparkline'; history?: string; before?: string } }>('/api/tokens/:address/chart', async (request, reply) => {
    const parsed = addressSchema.safeParse(request.params.address);
    const interval = request.query.interval;
    const period = interval ?? request.query.period ?? '24h';
    const priority = request.query.priority;
    const fullHistory = request.query.history === 'full';
    const before = request.query.before === undefined ? undefined : Number(request.query.before);
    if (!parsed.success || !(interval === undefined ? watchPeriods.includes(period as WatchPeriod) : candleIntervals.includes(interval as typeof candleIntervals[number])) ||
      priority !== undefined && !['chart', 'prefetch', 'sparkline'].includes(priority) ||
      request.query.history !== undefined && !fullHistory || fullHistory && interval === undefined ||
      before !== undefined && (!fullHistory || !Number.isSafeInteger(before) || before < 1 || before > Math.floor(Date.now() / 1000))) return reply.code(400).send({ error: 'Invalid token or chart interval' });
    const address = parsed.data, selected = period as ChartRange;
    const known = await pool.query(`SELECT (SELECT t.timestamp FROM trades t JOIN published_kols k ON k.address=t.wallet_address AND k.is_tracked
      WHERE t.token_address=v.address AND t.block_number IS NOT NULL ORDER BY t.timestamp DESC LIMIT 1) AS last_trade_at
      FROM tokens v WHERE v.address=$1 AND ${nonStockTokenSql()} AND ${publicTokenEvidenceSql()}`, [address]);
    if (!known.rows.length) return reply.code(404).send({ error: 'Token not found' });
    const settings: Record<string, [number, number]> = { '24h': [86400, 300], '7d': [604800, 3600], '30d': [2592000, 3600],
      '1m': [86400, 60], '5m': [432000, 300], '1h': [2592000, 3600], '4h': [7776000, 14400], '1d': [15552000, 86400] };
    const [span, seconds] = settings[selected], to = before ? before * 1000-1 : Date.now();
    // Page real persisted buckets, rather than walking empty wall-clock spans.
    // Ordinary pagination reads saved data only. An explicitly selected chart
    // may additionally recover its own old page through the bounded importer.
    const page = fullHistory ? (await pool.query(`SELECT bucket FROM (
      (SELECT DISTINCT floor(extract(epoch FROM minute)/$3)*$3 AS bucket FROM node_market_candles
        WHERE token_address=$1 AND minute<$2::timestamptz ORDER BY bucket DESC LIMIT 1501)
      UNION (SELECT DISTINCT floor(extract(epoch FROM timestamp)/$3)*$3 AS bucket FROM node_market_observations
        WHERE token_address=$1 AND kind='imported' AND interval_seconds<=$3 AND timestamp<$2::timestamptz
        ORDER BY bucket DESC LIMIT 1501)
      ) available ORDER BY bucket DESC LIMIT 1501`,[address,new Date(to).toISOString(),seconds])).rows : [];
    const more = page.length>1500, oldest = page[Math.min(page.length,1500)-1]?.bucket;
    const from = oldest === undefined ? to-span*1000 : Number(oldest)*1000;
    const [history, quote] = await Promise.all([nodeMarketService.chart(address, { from: new Date(from).toISOString(),
      to: new Date(to).toISOString(), intervalSeconds: seconds, limit: 2000 }), nodeMarketService.quote(address)]);
    if(!before&&(quote.stale||quote.priceUsd===null||priority==='chart'))await nodeMarketService.requestRefresh(address,{priority:priority==='chart'?10:1});
    const recovery=priority==='chart'&&!history.complete
      ?await tokenChartRecovery.requestChart(address,history,
        before?{exactWindow:true}:!history.bars.length&&known.rows[0].last_trade_at?{lastKnownTradeAt:Date.parse(known.rows[0].last_trade_at)}:{}):null;
    // Scope identifies the requested chart, independently of whether all its
    // market coverage is available. Genuine partial candles remain displayable.
    const displayedHistory=fullHistory?{...history,bars:history.bars.filter(bar=>Date.parse(bar.timestamp)>=from)}:history;
    return reply.header('Cache-Control', 'no-store').send({...databaseChart(displayedHistory, quote, selected),fullHistory,
      ...(recovery?.pending?{historyRecoveryPending:true,historyRetryAfterMs:recovery.retryAfterMs??1500,
        ...(recovery.reason?{historyRecoveryReason:recovery.reason}:{}),
        ...(!history.bars.length?{pending:true,loadStatus:recovery.coolingDown?'rate_limited':'queued',retryAfterMs:recovery.retryAfterMs??1500}:{})}:{}),
      ...(fullHistory?{historyComplete:!more&&history.complete,partialHistory:!history.complete,
        historyPending:more,historyLoadStatus:more?'queued':history.complete?undefined:'limited',
        ...(oldest===undefined?{}:{historyBefore:Number(oldest)})}:{}),});
  });
  app.get<{ Params: { address: string }; Querystring: { period?: string } }>('/api/tokens/:address/market', async (request, reply) => {
    const parsed = addressSchema.safeParse(request.params.address);
    const period = request.query.period ?? '24h';
    if (!parsed.success || !watchPeriods.includes(period as WatchPeriod)) return reply.code(400).send({ error: 'Invalid token or period' });
    const data = await watchlist(null, period as WatchPeriod, parsed.data);
    return { token: data.items[0] ?? null, period: data.period };
  });
  app.get<{ Querystring: { period?: string } }>('/api/watchlist', async (request, reply) => {
    privateResponse(reply);
    const period = request.query.period ?? '24h';
    if (!watchPeriods.includes(period as WatchPeriod)) return reply.code(400).send({ error: 'Invalid watchlist period' });
    const session = await getSession(request);
    const expected = request.headers['x-watchlist-owner'];
    if (expected !== undefined && expected !== (session?.kind === 'account' ? session.id : 'guest')) return reply.code(409).send({ error: 'Your account changed. Refresh and try again.' });
    return watchlist(session, period as WatchPeriod);
  });
  app.put('/api/watchlist', { bodyLimit: 32768 }, async (request, reply) => {
    privateResponse(reply);
    if (!mutationAllowed(request, reply)) return;
    const parsed = watchSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid watchlist' });
    const { items } = parsed.data;
    let session = await getSession(request);
    if (!ownerAllowed(request, reply, session)) return;
    if (session?.kind === 'account' && items) return reply.code(409).send({ error: 'Refresh the page to update your account favorites.' });
    const unique = items ? [...new Map(items.map(item => [`${item.kind}:${item.address}`, item])).values()] : undefined;
    if (unique && ['kol', 'token'].some(kind => unique.filter(item => item.kind === kind).length > 100)) return reply.code(400).send({ error: 'Watch up to 100 KOLs and 100 tokens' });
    if (unique?.length) {
      const known = await pool.query(`SELECT 'kol' AS kind,address FROM published_kols WHERE is_tracked AND address=ANY($1::text[])
        UNION ALL SELECT 'token',v.address FROM tokens v WHERE address=ANY($2::text[]) AND ${nonStockTokenSql()} AND ${publicTokenEvidenceSql()}`,
      [unique.filter(item => item.kind === 'kol').map(item => item.address), unique.filter(item => item.kind === 'token').map(item => item.address)]);
      const valid = new Set(known.rows.map(row => `${row.kind}:${row.address}`));
      if (unique.some(item => !valid.has(`${item.kind}:${item.address}`))) return reply.code(400).send({ error: 'Only tracked KOLs and traded tokens can be followed' });
    }
    const client = await pool.connect();
    let createdSecret: string | null = null;
    try {
      await client.query('BEGIN');
      if (!session) {
        const secret = randomBytes(32).toString('hex');
        const result = await client.query(`INSERT INTO watch_sessions(id,secret_hash,expires_at) VALUES($1,$2,now()+interval '1 year') RETURNING id`, [randomUUID(), hashSecret(secret)]);
        session = { ...result.rows[0], kind: 'guest' }; createdSecret = secret;
      }
      const locked = await client.query(`SELECT id FROM ${ownerTable(session!)} WHERE id=$1 FOR UPDATE`, [session!.id]);
      if (!locked.rows.length) { await client.query('ROLLBACK'); return reply.code(409).send({ error: 'Your account changed. Refresh and try again.' }); }
      if (unique) {
        await client.query(`UPDATE tokens v SET market_cap_checked_at=now()-interval '31 minutes'
          WHERE v.address=ANY($1::text[]) AND NOT EXISTS(SELECT 1 FROM watch_entries w WHERE w.session_id=$2 AND w.kind='token' AND w.address=v.address)`,
        [unique.filter(item => item.kind === 'token').map(item => item.address), session!.id]);
        await client.query('DELETE FROM watch_entries WHERE session_id=$1', [session!.id]);
        for (const item of unique) await client.query('INSERT INTO watch_entries(session_id,kind,address) VALUES($1,$2,$3)', [session!.id, item.kind, item.address]);
      }
      const updated = await client.query(`UPDATE ${ownerTable(session!)} SET updated_at=now()${session!.kind === 'guest' ? ",expires_at=now()+interval '1 year'" : ''} WHERE id=$1 RETURNING id`, [session!.id]);
      session = { ...updated.rows[0], kind: session!.kind };
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
    if (createdSecret) setSessionCookie(reply, createdSecret);
    return watchlist(session);
  });
  // Individual changes compose across devices instead of replacing a stale list.
  for (const method of ['PUT', 'DELETE'] as const) app.route<{ Params: { kind: string; address: string } }>({
    method, url: '/api/watchlist/items/:kind/:address', bodyLimit: 1024,
    handler: async (request, reply) => {
      privateResponse(reply);
      if (!mutationAllowed(request, reply)) return;
      const parsed = addressSchema.safeParse(request.params.address), kind = request.params.kind;
      if (!parsed.success || !['kol', 'token'].includes(kind)) return reply.code(400).send({ error: 'Invalid watchlist' });
      const key = parsed.data;
      let session = await getSession(request);
      if (!ownerAllowed(request, reply, session)) return;
      if (method === 'DELETE' && !session) return watchlist(null);
      if (method === 'PUT') {
        const known = kind === 'kol'
          ? await pool.query('SELECT address FROM published_kols WHERE address=$1 AND is_tracked', [key])
          : await pool.query(`SELECT v.address FROM tokens v WHERE v.address=$1 AND ${nonStockTokenSql()}
            AND ${publicTokenEvidenceSql()}`, [key]);
        if (!known.rows.length) return reply.code(400).send({ error: 'Only tracked KOLs and traded tokens can be followed' });
      }
      const client = await pool.connect();
      let createdSecret: string | null = null;
      try {
        await client.query('BEGIN');
        if (!session) {
          createdSecret = randomBytes(32).toString('hex');
          const result = await client.query(`INSERT INTO watch_sessions(id,secret_hash,expires_at)
            VALUES($1,$2,now()+interval '1 year') RETURNING id`, [randomUUID(), hashSecret(createdSecret)]);
          session = { ...result.rows[0], kind: 'guest' };
        }
        const locked = await client.query(`SELECT id FROM ${ownerTable(session!)} WHERE id=$1 FOR UPDATE`, [session!.id]);
        if (!locked.rows.length) { await client.query('ROLLBACK'); return reply.code(409).send({ error: 'Your account changed. Refresh and try again.' }); }
        const table = entryTable(session!), owner = ownerColumn(session!);
        if (method === 'PUT') {
          const count = await client.query(`SELECT COUNT(*)::int AS count,
            bool_or(address=$3) AS followed FROM ${table} WHERE ${owner}=$1 AND kind=$2`, [session!.id, kind, key]);
          if (count.rows[0].count >= 100 && !count.rows[0].followed) {
            await client.query('ROLLBACK'); return reply.code(400).send({ error: 'Watch up to 100 KOLs and 100 tokens' });
          }
          const inserted = await client.query(`INSERT INTO ${table}(${owner},kind,address) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING address`, [session!.id, kind, key]);
          if (kind === 'token' && inserted.rows.length) await client.query(`UPDATE tokens SET market_cap_checked_at=now()-interval '31 minutes' WHERE address=$1`, [key]);
        } else await client.query(`DELETE FROM ${table} WHERE ${owner}=$1 AND kind=$2 AND address=$3`, [session!.id, kind, key]);
        await client.query(`UPDATE ${ownerTable(session!)} SET updated_at=now()${session!.kind === 'guest' ? ",expires_at=now()+interval '1 year'" : ''} WHERE id=$1`, [session!.id]);
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
      if (createdSecret) setSessionCookie(reply, createdSecret);
      return watchlist(session);
    },
  });
  app.delete('/api/watchlist', async (request, reply) => {
    privateResponse(reply); if (!mutationAllowed(request, reply)) return;
    const session = await getSession(request);
    if (!ownerAllowed(request, reply, session)) return;
    if (session?.kind === 'account') {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT id FROM auth_users WHERE id=$1 FOR UPDATE', [session.id]);
        await client.query('DELETE FROM account_watch_entries WHERE user_id=$1', [session.id]);
        await client.query('UPDATE auth_users SET updated_at=now() WHERE id=$1', [session.id]);
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
      return watchlist(session);
    }
    if (session) await pool.query('DELETE FROM watch_sessions WHERE id=$1', [session.id]);
    reply.header('Set-Cookie', `${cookieName}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`);
    return watchlist(null);
  });
  app.get<{ Querystring: { limit?: string; cursor?: string; watched?: string; token?: string; kol?: string } }>('/api/signals', async (request, reply) => {
    const session = await getSession(request);
    if (session || request.query.watched === '1') privateResponse(reply);
    if (request.query.watched === '1' && !session) return { items: [], nextCursor: null };
    const values: unknown[] = [];
    const where: string[] = [nonStockTokenSql(), "s.kind NOT IN('near_graduation','graduated')", `cardinality(s.wallet_addresses)>0 AND NOT EXISTS(SELECT 1 FROM unnest(s.wallet_addresses) AS candidate(address) LEFT JOIN kols roster ON roster.address=candidate.address WHERE NOT COALESCE(roster.is_tracked,false))`];
    values.push(defaultSignalSettings.windowMinutes, defaultSignalSettings.minBuyers);
    where.push('(s.window_minutes=0 OR s.window_minutes=$1 AND s.min_buyers=$2)');
    if (session) {
      if (request.query.watched === '1') { values.push(session.id); where.push(`EXISTS(SELECT 1 FROM ${entryTable(session)} e WHERE e.${ownerColumn(session)}=$${values.length} AND (e.kind='token' AND e.address=s.token_address OR e.kind='kol' AND e.address=ANY(s.wallet_addresses)))`); }
    }
    for (const [filter, field] of [[request.query.token, 's.token_address'], [request.query.kol, 'wallet']] as const) {
      if (!filter) continue;
      const parsed = addressSchema.safeParse(filter);
      if (!parsed.success) return reply.code(400).send({ error: 'Invalid address' });
      values.push(parsed.data); where.push(field === 'wallet' ? `$${values.length}=ANY(s.wallet_addresses)` : `${field}=$${values.length}`);
    }
    try {
      const cursor = pageCursor(request.query.cursor);
      if (cursor) { values.push(cursor.ts, cursor.id); where.push(`(s.timestamp,s.id)<($${values.length - 1}::timestamptz,$${values.length}::text)`); }
    } catch { return reply.code(400).send({ error: 'Invalid cursor' }); }
    const count = limit(request.query.limit); values.push(count + 1);
    const result = await pool.query(`SELECT s.id,s.kind,s.token_address AS "tokenAddress",v.symbol AS "tokenSymbol",v.name AS "tokenName",
      CASE WHEN v.logo_data IS NOT NULL THEN '/api/token-image/'||v.address||'?v='||md5(v.logo_data) END AS "tokenLogoUrl",
      s.wallet_addresses AS "walletAddresses",s.window_minutes AS "windowMinutes",s.min_buyers AS "minBuyers",s.timestamp,s.published_at AS "publishedAt",s.corrected,s.evidence,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('address',k.address,'name',k.display_name,'avatarUrl',k.avatar_url) ORDER BY k.display_name,k.address) FROM published_kols k WHERE k.is_tracked AND k.address=ANY(s.wallet_addresses)), '[]'::jsonb) AS kols
      FROM radar_signals s JOIN tokens v ON v.address=s.token_address WHERE ${where.join(' AND ')} ORDER BY s.timestamp DESC,s.id DESC LIMIT $${values.length}`, values);
    const items = result.rows.slice(0, count), last = items.at(-1);
    return { items, nextCursor: result.rows.length > count && last ? Buffer.from(JSON.stringify({ ts: new Date(last.timestamp).toISOString(), id: last.id })).toString('base64url') : null };
  });
  app.get<{ Params: { id: string } }>('/api/signals/:id', async (request, reply) => {
    if (!/^[a-f0-9]{64}$/.test(request.params.id)) return reply.code(404).send({ error: 'Signal not found' });
    const result = await pool.query(`SELECT s.id,s.kind,s.token_address AS "tokenAddress",v.symbol AS "tokenSymbol",v.name AS "tokenName",
      CASE WHEN v.logo_data IS NOT NULL THEN '/api/token-image/'||v.address||'?v='||md5(v.logo_data) END AS "tokenLogoUrl",
      s.wallet_addresses AS "walletAddresses",s.window_minutes AS "windowMinutes",s.min_buyers AS "minBuyers",s.timestamp,s.published_at AS "publishedAt",s.corrected,s.evidence,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('address',k.address,'name',k.display_name,'avatarUrl',k.avatar_url)) FROM published_kols k WHERE k.is_tracked AND k.address=ANY(s.wallet_addresses)),'[]'::jsonb) AS kols
      FROM radar_signals s JOIN tokens v ON v.address=s.token_address WHERE s.id=$1 AND s.kind NOT IN('near_graduation','graduated') AND ${nonStockTokenSql()} AND cardinality(s.wallet_addresses)>0 AND NOT EXISTS(SELECT 1 FROM unnest(s.wallet_addresses) AS candidate(address) LEFT JOIN kols roster ON roster.address=candidate.address WHERE NOT COALESCE(roster.is_tracked,false))`, [request.params.id]);
    return { signal: result.rows[0] ?? null };
  });
  for (const mode of ['kols', 'tokens'] as const) {
    app.get<{ Params: { address: string }; Querystring: { tokens?: string } }>(`/api/${mode}/:address/positions`, async (request, reply) => {
      const parsed = addressSchema.safeParse(request.params.address);
      if (!parsed.success) return reply.code(400).send({ error: 'Invalid address' });
      const values: unknown[] = [parsed.data];
      let tokenFilter = '';
      if (mode === 'kols' && request.query.tokens) {
        const parsedTokens = z.array(addressSchema).max(100).safeParse(request.query.tokens.split(','));
        if (!parsedTokens.success) return reply.code(400).send({ error: 'Invalid tokens' });
        values.push(parsedTokens.data); tokenFilter = 'AND pairs.token_address=ANY($2::text[])';
      }
      const result = await pool.query(`WITH pairs AS (
        SELECT wallet_address,token_address FROM trades WHERE block_number IS NOT NULL AND ${mode === 'kols' ? 'wallet_address' : 'token_address'}=$1
        UNION SELECT wallet_address,token_address FROM wallet_transfers WHERE ${mode === 'kols' ? 'wallet_address' : 'token_address'}=$1)
        SELECT pairs.wallet_address,pairs.token_address,v.decimals,s.* FROM pairs JOIN published_kols k ON k.address=pairs.wallet_address AND k.is_tracked
        JOIN tokens v ON v.address=pairs.token_address LEFT JOIN LATERAL(SELECT balance_raw,status,checked_at,block_number,block_timestamp,last_movement_at,error FROM position_snapshots
          WHERE wallet_address=pairs.wallet_address AND token_address=pairs.token_address ORDER BY block_number DESC LIMIT 1) s ON true
        WHERE ${nonStockTokenSql()} ${tokenFilter} ORDER BY pairs.wallet_address,pairs.token_address LIMIT 300`, values);
      return { items: result.rows.map(row => {
        const fresh = !row.error && positionIsFresh(row.checked_at ? new Date(row.checked_at).toISOString() : null)
          && positionIsFresh(row.block_timestamp ? new Date(row.block_timestamp).toISOString() : null);
        const formatted = row.balance_raw != null && Number.isInteger(row.decimals) && row.decimals >= 0 && row.decimals <= 36 ? decimalUnits(BigInt(row.balance_raw), row.decimals) : null;
        return { walletAddress: row.wallet_address, tokenAddress: row.token_address, balance: formatted,
          status: fresh && formatted != null ? row.status as PositionStatus : 'Unknown', checkedAt: row.checked_at, blockNumber: row.block_number ?? null, lastMovementAt: row.last_movement_at };
      }) };
    });
  }
  app.get('/api/intelligence/health', async () => {
    const states = await pool.query(`SELECT key,value,updated_at FROM worker_state WHERE key IN('radar','positions','telegram_notifications','intelligence_radar_error','intelligence_positions_error')`);
    const metrics = await pool.query(`SELECT
      (SELECT COUNT(*)::int FROM trades WHERE EXISTS(SELECT 1 FROM kols public_kol WHERE public_kol.address=trades.wallet_address AND public_kol.is_tracked) AND ${nonStockTokenSql('token_address')} AND NOT intelligence_processed AND block_number IS NOT NULL AND timestamp>now()-interval '24 hours') AS "pendingTrades",
      (SELECT EXTRACT(epoch FROM now()-MIN(timestamp))::int FROM trades WHERE EXISTS(SELECT 1 FROM kols public_kol WHERE public_kol.address=trades.wallet_address AND public_kol.is_tracked) AND ${nonStockTokenSql('token_address')} AND NOT intelligence_processed AND observed_live AND block_number IS NOT NULL AND timestamp>now()-interval '24 hours') AS "processingLagSeconds",
      (SELECT COUNT(*)::int FROM (SELECT DISTINCT ON(wallet_address,token_address) error,checked_at,block_timestamp FROM position_snapshots ORDER BY wallet_address,token_address,block_number DESC) p
        WHERE error OR checked_at<now()-interval '5 minutes' OR block_timestamp<now()-interval '5 minutes') AS "stalePositions"`);
    return { ...metrics.rows[0], states: Object.fromEntries(states.rows.map(row => [row.key, { ...row.value, updatedAt: row.updated_at }])) };
  });
}
