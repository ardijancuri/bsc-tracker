import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { pool } from './db.js';
import { defaultPreferences, signalKinds, type TelegramStatus, type PositionStatus } from '../shared/intelligence.js';
import { decimalUnits, positionIsFresh } from './intelligenceLogic.js';
import { handleTelegramUpdate, hashSecret, telegramBotUsername, validWebhookSecret } from './telegram.js';

const addressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform(value => value.toLowerCase());
const preferencesSchema = z.object({ windowMinutes: z.union([z.literal(5), z.literal(10), z.literal(30)]), minBuyers: z.number().int().min(2).max(10), categories: z.array(z.enum(signalKinds)).max(5).transform(values => [...new Set(values)]), muted: z.boolean() }).strict();
const watchSchema = z.object({ items: z.array(z.object({ kind: z.enum(['kol', 'token']), address: addressSchema }).strict()).max(200).optional(), preferences: preferencesSchema.optional() }).strict();
const cookieName = 'bscan_watch';
type Session = { id: string; preferences: typeof defaultPreferences; telegram_chat_id: string | null; telegram_username: string | null };
const attempts = new Map<string, { count: number; until: number }>();
function mutationAllowed(request: FastifyRequest, reply: FastifyReply) {
  const origin = request.headers.origin;
  const expected = new URL(process.env.PUBLIC_APP_URL || 'https://bscan.fun').origin;
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
export function sessionSecret(cookie: string | undefined) {
  const matches = (cookie || '').split(';').map(value => value.trim()).filter(value => value.startsWith(`${cookieName}=`));
  if (matches.length !== 1) return null;
  const value = matches[0].slice(cookieName.length + 1);
  return /^[0-9a-f]{64}$/.test(value) ? value : null;
}
async function getSession(request: FastifyRequest): Promise<Session | null> {
  const secret = sessionSecret(request.headers.cookie);
  if (!secret) return null;
  const result = await pool.query('SELECT id,preferences,telegram_chat_id,telegram_username FROM watch_sessions WHERE secret_hash=$1 AND expires_at>now()', [hashSecret(secret)]);
  return result.rows[0] ?? null;
}
function privateResponse(reply: FastifyReply) { reply.header('Cache-Control', 'no-store').header('Vary', 'Cookie'); }
function setSessionCookie(reply: FastifyReply, secret: string) {
  reply.header('Set-Cookie', `${cookieName}=${secret}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`);
}
async function telegramStatus(session: Session | null): Promise<TelegramStatus> {
  const username = await telegramBotUsername();
  const available = Boolean(username && process.env.TELEGRAM_DELIVERY_ENABLED === 'true');
  if (session?.telegram_chat_id) return { available, state: 'connected', username: session.telegram_username, recipient: session.telegram_username ? `@${session.telegram_username}` : `Chat …${session.telegram_chat_id.slice(-4)}`, linkUrl: null, expiresAt: null };
  const pending = session ? (await pool.query(`SELECT claimed_at,chat_id,username,expires_at FROM telegram_links WHERE session_id=$1 AND expires_at>now() AND confirmed_at IS NULL ORDER BY created_at DESC LIMIT 1`, [session.id])).rows[0] : null;
  return { available, state: pending ? pending.claimed_at ? 'confirm' : 'pending' : 'disconnected', username: pending?.username ?? null,
    recipient: pending?.chat_id ? pending.username ? `@${pending.username}` : `Chat …${pending.chat_id.slice(-4)}` : null, linkUrl: null, expiresAt: pending?.expires_at ? new Date(pending.expires_at).toISOString() : null };
}
async function watchlist(session: Session | null) {
  const items = session ? (await pool.query(`SELECT e.kind,e.address,CASE WHEN e.kind='kol' THEN k.display_name ELSE v.name END AS name,
    v.symbol,k.avatar_url AS "avatarUrl",CASE WHEN v.logo_data IS NOT NULL THEN '/api/token-image/'||v.address||'?v='||md5(v.logo_data) END AS "logoUrl"
    FROM watch_entries e LEFT JOIN kols k ON e.kind='kol' AND k.address=e.address LEFT JOIN tokens v ON e.kind='token' AND v.address=e.address
    WHERE e.session_id=$1 ORDER BY e.kind,name NULLS LAST,e.address`, [session.id])).rows : [];
  return { items, preferences: session?.preferences ?? defaultPreferences, telegram: await telegramStatus(session) };
}
function pageCursor(value: unknown) {
  if (value == null) return null;
  if (typeof value !== 'string' || value.length > 512) throw new Error('Invalid cursor');
  const decoded = JSON.parse(Buffer.from(value, 'base64url').toString());
  if (typeof decoded.ts !== 'string' || !Number.isFinite(Date.parse(decoded.ts)) || typeof decoded.id !== 'string' || decoded.id.length > 100) throw new Error('Invalid cursor');
  return decoded as { ts: string; id: string };
}
function limit(value: unknown) { const number = Number(value); return Number.isInteger(number) && number > 0 ? Math.min(number, 100) : 20; }
export const launchColumns = `l.token_address AS "tokenAddress",l.platform,l.stage,l.progress,l.launched_at AS "launchedAt",l.first_kol_at AS "firstKolAt",l.graduated_at AS "graduatedAt",
  l.graduation_tx_hash AS "graduationTxHash",l.quote_address AS "quoteAddress",l.pool_address AS "poolAddress",l.pool_id AS "poolId",
  l.liquidity_usd AS "liquidityUsd",l.liquidity_baseline_usd AS "liquidityBaselineUsd",l.liquidity_baseline_at AS "liquidityBaselineAt",l.liquidity_at AS "liquidityAt",l.checked_at AS "checkedAt"`;

export function registerIntelligenceRoutes(app: FastifyInstance) {
  app.get('/api/watchlist', async (request, reply) => { privateResponse(reply); return watchlist(await getSession(request)); });
  app.put('/api/watchlist', { bodyLimit: 32768 }, async (request, reply) => {
    privateResponse(reply);
    if (!mutationAllowed(request, reply)) return;
    const parsed = watchSchema.safeParse(request.body);
    if (!parsed.success || !parsed.data.items && !parsed.data.preferences) return reply.code(400).send({ error: 'Invalid watchlist' });
    const { items, preferences } = parsed.data;
    const unique = items ? [...new Map(items.map(item => [`${item.kind}:${item.address}`, item])).values()] : undefined;
    if (unique && ['kol', 'token'].some(kind => unique.filter(item => item.kind === kind).length > 100)) return reply.code(400).send({ error: 'Watch up to 100 KOLs and 100 tokens' });
    if (unique?.length) {
      const known = await pool.query(`SELECT 'kol' AS kind,address FROM kols WHERE is_tracked AND address=ANY($1::text[])
        UNION ALL SELECT 'token',v.address FROM tokens v WHERE address=ANY($2::text[]) AND EXISTS(SELECT 1 FROM trades t JOIN kols k ON k.address=t.wallet_address WHERE t.token_address=v.address AND k.is_tracked AND t.block_number IS NOT NULL)`,
      [unique.filter(item => item.kind === 'kol').map(item => item.address), unique.filter(item => item.kind === 'token').map(item => item.address)]);
      const valid = new Set(known.rows.map(row => `${row.kind}:${row.address}`));
      if (unique.some(item => !valid.has(`${item.kind}:${item.address}`))) return reply.code(400).send({ error: 'Only tracked KOLs and traded tokens can be followed' });
    }
    let session = await getSession(request);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      if (!session) {
        const secret = randomBytes(32).toString('hex');
        const result = await client.query(`INSERT INTO watch_sessions(id,secret_hash,expires_at) VALUES($1,$2,now()+interval '1 year') RETURNING id,preferences,telegram_chat_id,telegram_username`, [randomUUID(), hashSecret(secret)]);
        session = result.rows[0]; setSessionCookie(reply, secret);
      }
      await client.query('SELECT id FROM watch_sessions WHERE id=$1 FOR UPDATE', [session!.id]);
      if (unique) {
        await client.query('DELETE FROM watch_entries WHERE session_id=$1', [session!.id]);
        for (const item of unique) await client.query('INSERT INTO watch_entries(session_id,kind,address) VALUES($1,$2,$3)', [session!.id, item.kind, item.address]);
      }
      const updated = await client.query(`UPDATE watch_sessions SET preferences=COALESCE($2::jsonb,preferences),updated_at=now(),expires_at=now()+interval '1 year' WHERE id=$1 RETURNING id,preferences,telegram_chat_id,telegram_username`, [session!.id, preferences ? JSON.stringify(preferences) : null]);
      session = updated.rows[0];
      if (preferences) await client.query(`INSERT INTO radar_profiles(profile,window_minutes,min_buyers) VALUES($1,$2,$3) ON CONFLICT(profile) DO NOTHING`, [`${preferences.windowMinutes}:${preferences.minBuyers}`, preferences.windowMinutes, preferences.minBuyers]);
      if (session!.preferences.muted) await client.query(`UPDATE notification_deliveries SET status='cancelled',updated_at=now() WHERE session_id=$1 AND status='queued'`, [session!.id]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
    return watchlist(session);
  });
  app.delete('/api/watchlist', async (request, reply) => {
    privateResponse(reply); if (!mutationAllowed(request, reply)) return;
    const session = await getSession(request);
    if (session) await pool.query('DELETE FROM watch_sessions WHERE id=$1', [session.id]);
    reply.header('Set-Cookie', `${cookieName}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`);
    return watchlist(null);
  });
  app.get<{ Querystring: { limit?: string; cursor?: string; watched?: string; token?: string; kol?: string; window?: string; buyers?: string } }>('/api/signals', async (request, reply) => {
    const session = await getSession(request);
    if (session || request.query.watched === '1') privateResponse(reply);
    if (request.query.watched === '1' && !session) return { items: [], nextCursor: null };
    const values: unknown[] = [];
    const where: string[] = [];
    const preference = session?.preferences ?? defaultPreferences;
    values.push(preference.windowMinutes, preference.minBuyers);
    where.push('(s.window_minutes=0 OR s.window_minutes=$1 AND s.min_buyers=$2)');
    if (session) {
      if (request.query.watched === '1') { values.push(session.id); where.push(`EXISTS(SELECT 1 FROM watch_entries e WHERE e.session_id=$${values.length} AND (e.kind='token' AND e.address=s.token_address OR e.kind='kol' AND e.address=ANY(s.wallet_addresses)))`); }
      values.push(session.preferences.categories); where.push(`s.kind=ANY($${values.length}::text[])`);
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
      COALESCE((SELECT jsonb_agg(jsonb_build_object('address',k.address,'name',k.display_name,'avatarUrl',k.avatar_url) ORDER BY k.display_name,k.address) FROM kols k WHERE k.address=ANY(s.wallet_addresses)), '[]'::jsonb) AS kols
      FROM radar_signals s JOIN tokens v ON v.address=s.token_address WHERE ${where.join(' AND ')} ORDER BY s.timestamp DESC,s.id DESC LIMIT $${values.length}`, values);
    const items = result.rows.slice(0, count), last = items.at(-1);
    return { items, nextCursor: result.rows.length > count && last ? Buffer.from(JSON.stringify({ ts: new Date(last.timestamp).toISOString(), id: last.id })).toString('base64url') : null };
  });
  app.get<{ Params: { id: string } }>('/api/signals/:id', async (request, reply) => {
    if (!/^[a-f0-9]{64}$/.test(request.params.id)) return reply.code(404).send({ error: 'Signal not found' });
    const result = await pool.query(`SELECT s.id,s.kind,s.token_address AS "tokenAddress",v.symbol AS "tokenSymbol",v.name AS "tokenName",
      CASE WHEN v.logo_data IS NOT NULL THEN '/api/token-image/'||v.address||'?v='||md5(v.logo_data) END AS "tokenLogoUrl",
      s.wallet_addresses AS "walletAddresses",s.window_minutes AS "windowMinutes",s.min_buyers AS "minBuyers",s.timestamp,s.published_at AS "publishedAt",s.corrected,s.evidence,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('address',k.address,'name',k.display_name,'avatarUrl',k.avatar_url)) FROM kols k WHERE k.address=ANY(s.wallet_addresses)),'[]'::jsonb) AS kols
      FROM radar_signals s JOIN tokens v ON v.address=s.token_address WHERE s.id=$1`, [request.params.id]);
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
        SELECT pairs.wallet_address,pairs.token_address,v.decimals,s.* FROM pairs JOIN kols k ON k.address=pairs.wallet_address AND k.is_tracked
        JOIN tokens v ON v.address=pairs.token_address LEFT JOIN LATERAL(SELECT balance_raw,status,checked_at,block_number,block_timestamp,last_movement_at,error FROM position_snapshots
          WHERE wallet_address=pairs.wallet_address AND token_address=pairs.token_address ORDER BY block_number DESC LIMIT 1) s ON true
        WHERE true ${tokenFilter} ORDER BY pairs.wallet_address,pairs.token_address LIMIT 300`, values);
      return { items: result.rows.map(row => {
        const fresh = !row.error && positionIsFresh(row.checked_at ? new Date(row.checked_at).toISOString() : null)
          && positionIsFresh(row.block_timestamp ? new Date(row.block_timestamp).toISOString() : null);
        const formatted = row.balance_raw != null && Number.isInteger(row.decimals) && row.decimals >= 0 && row.decimals <= 36 ? decimalUnits(BigInt(row.balance_raw), row.decimals) : null;
        return { walletAddress: row.wallet_address, tokenAddress: row.token_address, balance: formatted,
          status: fresh && formatted != null ? row.status as PositionStatus : 'Unknown', checkedAt: row.checked_at, blockNumber: row.block_number ?? null, lastMovementAt: row.last_movement_at };
      }) };
    });
  }
  app.get<{ Params: { address: string } }>('/api/tokens/:address/launch', async (request, reply) => {
    const parsed = addressSchema.safeParse(request.params.address);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid address' });
    const result = await pool.query(`SELECT ${launchColumns} FROM token_launches l WHERE token_address=$1`, [parsed.data]);
    return { launch: result.rows[0] ? { ...result.rows[0], progress: result.rows[0].progress == null ? null : Number(result.rows[0].progress) } : null };
  });
  app.get<{ Querystring: { limit?: string; cursor?: string; platform?: string; stage?: string } }>('/api/launches', async (request, reply) => {
    const values: unknown[] = [], where = ['l.platform IS NOT NULL', 'EXISTS(SELECT 1 FROM trades t JOIN kols k ON k.address=t.wallet_address WHERE t.token_address=l.token_address AND k.is_tracked AND t.block_number IS NOT NULL)'];
    if (request.query.platform && ['fourmeme', 'flap'].includes(request.query.platform)) { values.push(request.query.platform); where.push(`l.platform=$${values.length}`); }
    if (request.query.stage && ['bonding', 'near_graduation', 'graduated', 'unavailable'].includes(request.query.stage)) { values.push(request.query.stage); where.push(`l.stage=$${values.length}`); }
    try { const cursor = pageCursor(request.query.cursor); if (cursor) { values.push(cursor.ts, cursor.id); where.push(`(COALESCE(l.first_kol_at,l.launched_at,to_timestamp(0)),l.token_address)<($${values.length - 1}::timestamptz,$${values.length}::text)`); } }
    catch { return reply.code(400).send({ error: 'Invalid cursor' }); }
    const count = limit(request.query.limit); values.push(count + 1);
    const result = await pool.query(`SELECT ${launchColumns},v.symbol,v.name,CASE WHEN v.logo_data IS NOT NULL THEN '/api/token-image/'||v.address||'?v='||md5(v.logo_data) END AS "logoUrl"
      FROM token_launches l JOIN tokens v ON v.address=l.token_address WHERE ${where.join(' AND ')}
      ORDER BY COALESCE(l.first_kol_at,l.launched_at,to_timestamp(0)) DESC NULLS LAST,l.token_address DESC LIMIT $${values.length}`, values);
    const items = result.rows.slice(0, count).map(row => ({ ...row, progress: row.progress == null ? null : Number(row.progress) })), last = items.at(-1);
    const date = last?.firstKolAt ?? last?.launchedAt ?? new Date(0).toISOString();
    return { items, nextCursor: result.rows.length > count && last && date ? Buffer.from(JSON.stringify({ ts: new Date(date).toISOString(), id: last.tokenAddress })).toString('base64url') : null };
  });
  app.get('/api/telegram/status', async (request, reply) => { privateResponse(reply); return telegramStatus(await getSession(request)); });
  app.post('/api/telegram/link', async (request, reply) => {
    privateResponse(reply); if (!mutationAllowed(request, reply)) return;
    const session = await getSession(request);
    if (!session) return reply.code(401).send({ error: 'Follow a KOL or token first' });
    const username = await telegramBotUsername();
    if (!username || process.env.TELEGRAM_DELIVERY_ENABLED !== 'true') return reply.code(503).send({ error: 'Telegram unavailable' });
    const nonce = randomBytes(32).toString('base64url');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT id FROM watch_sessions WHERE id=$1 FOR UPDATE', [session.id]);
      await client.query('DELETE FROM telegram_links WHERE session_id=$1', [session.id]);
      const result = await client.query(`INSERT INTO telegram_links(id,session_id,nonce_hash,expires_at) VALUES($1,$2,$3,now()+interval '10 minutes') RETURNING expires_at`, [randomUUID(), session.id, hashSecret(nonce)]);
      await client.query('COMMIT');
      return { available: true, state: 'pending', username: null, recipient: null, linkUrl: `https://t.me/${username}?start=${nonce}`, expiresAt: new Date(result.rows[0].expires_at).toISOString() };
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  });
  app.post('/api/telegram/confirm', async (request, reply) => {
    privateResponse(reply); if (!mutationAllowed(request, reply)) return;
    const session = await getSession(request);
    if (!session) return reply.code(401).send({ error: 'Watchlist unavailable' });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT id FROM watch_sessions WHERE id=$1 FOR UPDATE', [session.id]);
      await client.query('SELECT id FROM watch_sessions WHERE id=$1 FOR UPDATE', [session.id]);
      const result = await client.query(`SELECT * FROM telegram_links WHERE session_id=$1 AND expires_at>now() AND claimed_at IS NOT NULL AND confirmed_at IS NULL ORDER BY created_at DESC LIMIT 1 FOR UPDATE`, [session.id]);
      const link = result.rows[0];
      if (!link) { await client.query('ROLLBACK'); return reply.code(409).send({ error: 'Open your Telegram link first' }); }
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,782321))', [link.chat_id]);
      const conflict = await client.query('SELECT id FROM watch_sessions WHERE telegram_chat_id=$1 AND id<>$2', [link.chat_id, session.id]);
      if (conflict.rows.length) { await client.query('ROLLBACK'); return reply.code(409).send({ error: 'Disconnect this Telegram account from its other watchlist first' }); }
      await client.query(`UPDATE watch_sessions SET telegram_chat_id=$2,telegram_username=$3,telegram_connected_at=now(),updated_at=now() WHERE id=$1`, [session.id, link.chat_id, link.username]);
      await client.query('UPDATE telegram_links SET confirmed_at=now() WHERE id=$1', [link.id]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
    return telegramStatus(await getSession(request));
  });
  app.delete('/api/telegram/link', async (request, reply) => {
    privateResponse(reply); if (!mutationAllowed(request, reply)) return;
    const session = await getSession(request);
    if (session) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`UPDATE watch_sessions SET telegram_chat_id=NULL,telegram_username=NULL,telegram_connected_at=NULL,updated_at=now() WHERE id=$1`, [session.id]);
        await client.query('DELETE FROM telegram_links WHERE session_id=$1', [session.id]);
        await client.query(`UPDATE notification_deliveries SET status='cancelled',updated_at=now() WHERE session_id=$1 AND status='queued'`, [session.id]);
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    }
    return telegramStatus(null);
  });
  const updateSchema = z.object({ update_id: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), message: z.object({ text: z.string().max(4096).optional(), chat: z.object({ id: z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER), type: z.string() }), from: z.object({ username: z.string().max(64).optional() }).optional() }).optional() });
  app.post('/api/telegram/webhook', { bodyLimit: 16384 }, async (request, reply) => {
    if (!validWebhookSecret(request.headers['x-telegram-bot-api-secret-token'])) return reply.code(403).send({ error: 'Forbidden' });
    const parsed = updateSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid update' });
    await handleTelegramUpdate(parsed.data); return { ok: true };
  });
  app.get('/api/intelligence/health', async () => {
    const states = await pool.query(`SELECT key,value,updated_at FROM worker_state WHERE key IN('radar','positions','launches','telegram','intelligence_radar_error','intelligence_positions_error','intelligence_launches_error')`);
    const metrics = await pool.query(`SELECT
      (SELECT COUNT(*)::int FROM trades WHERE NOT intelligence_processed AND block_number IS NOT NULL AND timestamp>now()-interval '24 hours') AS "pendingTrades",
      (SELECT EXTRACT(epoch FROM now()-MIN(timestamp))::int FROM trades WHERE NOT intelligence_processed AND observed_live AND block_number IS NOT NULL AND timestamp>now()-interval '24 hours') AS "processingLagSeconds",
      (SELECT COUNT(*)::int FROM (SELECT DISTINCT ON(wallet_address,token_address) error,checked_at,block_timestamp FROM position_snapshots ORDER BY wallet_address,token_address,block_number DESC) p
        WHERE error OR checked_at<now()-interval '5 minutes' OR block_timestamp<now()-interval '5 minutes') AS "stalePositions"`);
    return { ...metrics.rows[0], states: Object.fromEntries(states.rows.map(row => [row.key, { ...row.value, updatedAt: row.updated_at }])) };
  });
}
