import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { pool } from './db.js';
import { kolProfileTokenSql } from './kolProfileToken.js';
import { createTelegramBot, telegramBotConfig, type TelegramBotConfig } from './telegramBot.js';
import { formatTelegramTradeMessage, formatActivationMessage, formatCorrectionMessage, type TelegramFormattedMessage, type TelegramMessageTrade } from './telegramNotificationMessage.js';
import type { TelegramNotificationState } from '../shared/telegramNotifications.js';

export const telegramTradeMaxAgeMs = 300_000;
type Language = 'en' | 'zh-CN';
type Settings = { user_id: string; chat_id: string | null; connection: TelegramNotificationState['connection']; enabled: boolean;
  buys: boolean; sells: boolean; language: Language; generation: string; enabled_since: Date | null; last_error: string | null };
type Outbox = { id: string; user_id: string; chat_id: string; generation: string | null; kind: 'activation' | 'trades' | 'correction' | 'status';
  wallet_address: string | null; language: Language; status: string; due_at: Date; window_ends_at: Date | null; created_at: Date; sent_at: Date | null;
  lease_id: string | null; attempts: number; message_id: string | null; correction_of: string | null; payload: Record<string, unknown> };
export class TelegramNotificationInputError extends Error {
  constructor(message: string, public statusCode = 400) { super(message); this.name = 'TelegramNotificationInputError'; }
}
export type TelegramNotificationPatch = { enabled?: boolean; buys?: boolean; sells?: boolean; language?: Language };
export type TelegramNotificationUpdate = { updateId: string; telegramId: string; command: 'stop' | 'start' | 'status' | null; blocked?: boolean };
type Options = { db?: Pool; now?: () => number; config?: TelegramBotConfig | null; bot?: ReturnType<typeof createTelegramBot> | null };
const date = (milliseconds: number) => new Date(milliseconds).toISOString();
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** One durable event/outbox flow. It never requests accounting, market data or GMGN. */
export function createTelegramNotifications(options: Options = {}) {
  const db = options.db ?? pool, now = options.now ?? Date.now;
  const config = options.config === undefined ? telegramBotConfig() : options.config;
  const bot = options.bot === undefined ? (config ? createTelegramBot(config) : null) : options.bot;
  const available = () => !!config && !!bot;
  async function transaction<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      // One short lock order for settings, collection and leases; never held during HTTP.
      await client.query('SELECT pg_advisory_xact_lock_shared(782319)');
      await client.query('SELECT pg_advisory_xact_lock(782324)');
      const result = await run(client); await client.query('COMMIT'); return result;
    }
    catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }
  async function ensureSettings(client: PoolClient, userId: string): Promise<Settings> {
    await client.query(`INSERT INTO telegram_notification_settings(user_id,generation) VALUES($1,$2) ON CONFLICT DO NOTHING`, [userId, randomUUID()]);
    return (await client.query<Settings>('SELECT * FROM telegram_notification_settings WHERE user_id=$1 FOR UPDATE', [userId])).rows[0];
  }
  async function state(userId: string): Promise<TelegramNotificationState> {
    const row = (await db.query<Settings>('SELECT * FROM telegram_notification_settings WHERE user_id=$1', [userId])).rows[0];
    const muted = await db.query<{ wallet_address: string }>('SELECT wallet_address FROM telegram_kol_notification_settings WHERE user_id=$1 AND muted ORDER BY wallet_address', [userId]);
    return { available: available(), connection: row?.connection ?? 'not_connected', enabled: row?.enabled ?? false,
      buys: row?.buys ?? true, sells: row?.sells ?? true, language: row?.language ?? 'en', mutedKols: muted.rows.map(item => item.wallet_address), lastError: row?.last_error ?? null };
  }
  async function cancelPending(client: PoolClient, userId: string, wallet?: string) {
    await client.query(`UPDATE telegram_notification_items i SET cancelled=true FROM telegram_notification_outbox o
      WHERE o.id=i.outbox_id AND o.user_id=$1 AND o.status IN ('pending','leased') AND ($2::text IS NULL OR o.wallet_address=$2)`, [userId, wallet ?? null]);
    await client.query(`UPDATE telegram_notification_outbox SET status='cancelled',
      lease_id=CASE WHEN dispatch_started_at IS NULL THEN NULL ELSE lease_id END,
      lease_until=CASE WHEN dispatch_started_at IS NULL THEN NULL ELSE lease_until END
      WHERE user_id=$1 AND status IN ('pending','leased') AND kind IN ('trades','activation') AND ($2::text IS NULL OR wallet_address=$2)`, [userId, wallet ?? null]);
  }
  async function update(userId: string, patch: TelegramNotificationPatch) {
    await transaction(async client => {
      const settings = await ensureSettings(client, userId);
      const next = { ...settings, ...patch };
      if (!next.buys && !next.sells) throw new TelegramNotificationInputError('Select buys or sells');
      if (patch.enabled && (!available() || settings.connection !== 'connected')) throw new TelegramNotificationInputError('Reconnect Telegram to enable alerts', 409);
      const cancellingActivation = patch.enabled === false && settings.connection === 'pending';
      const changingEnabled = cancellingActivation || (patch.enabled !== undefined && patch.enabled !== settings.enabled);
      if (changingEnabled) await cancelPending(client, userId);
      await client.query(`UPDATE telegram_notification_settings SET enabled=$2,buys=$3,sells=$4,language=$5,
        generation=CASE WHEN $6 THEN $7::uuid ELSE generation END,enabled_since=CASE WHEN $6 AND $2 THEN $8::timestamptz ELSE enabled_since END,
        connection=CASE WHEN $9 THEN 'not_connected' ELSE connection END,
        last_error=NULL,updated_at=$8 WHERE user_id=$1`, [userId, next.enabled, next.buys, next.sells, next.language, changingEnabled, randomUUID(), date(now()), cancellingActivation]);
      if (!next.buys || !next.sells) await client.query(`UPDATE telegram_notification_items i SET cancelled=true
        FROM telegram_trade_events e,telegram_notification_outbox o WHERE i.trade_id=e.trade_id AND i.block_hash=e.block_hash
        AND o.id=i.outbox_id AND o.status IN ('pending','leased') AND i.user_id=$1
        AND ((e.payload->>'side'='buy' AND NOT $2) OR (e.payload->>'side'='sell' AND NOT $3))`, [userId, next.buys, next.sells]);
    });
    return state(userId);
  }
  async function mute(userId: string, wallet: string, muted: boolean) {
    await transaction(async client => {
      await ensureSettings(client, userId);
      const favorite = await client.query(`SELECT address FROM account_watch_entries WHERE user_id=$1 AND kind='kol' AND address=$2 FOR UPDATE`, [userId, wallet]);
      if (!favorite.rowCount) throw new TelegramNotificationInputError('Favorite this KOL first', 404);
      await client.query(`INSERT INTO telegram_kol_notification_settings(user_id,wallet_address,muted,resumed_since) VALUES($1,$2,$3,$4)
        ON CONFLICT(user_id,wallet_address) DO UPDATE SET muted=EXCLUDED.muted,
        resumed_since=CASE WHEN telegram_kol_notification_settings.muted AND NOT EXCLUDED.muted THEN EXCLUDED.resumed_since ELSE telegram_kol_notification_settings.resumed_since END`, [userId, wallet, muted, date(now())]);
      if (muted) await cancelPending(client, userId, wallet);
    });
    return state(userId);
  }
  async function authorize(input: { userId: string; telegramId: string; language: Language }) {
    if (!available()) throw new TelegramNotificationInputError('Telegram alerts are not configured', 503);
    await transaction(async client => {
      const identity = await client.query(`UPDATE auth_users SET telegram_id=$2 WHERE id=$1 AND (telegram_id IS NULL OR telegram_id=$2) RETURNING id`, [input.userId, input.telegramId]);
      if (!identity.rowCount) throw new TelegramNotificationInputError('Telegram identity does not match this account', 409);
      await ensureSettings(client, input.userId);
      await cancelPending(client, input.userId);
      const generation = randomUUID();
      await client.query(`UPDATE telegram_notification_settings SET chat_id=$2,connection='pending',enabled=false,language=$3,
        generation=$4,last_error=NULL,updated_at=$5 WHERE user_id=$1`, [input.userId, input.telegramId, input.language, generation, date(now())]);
      await client.query(`INSERT INTO telegram_notification_outbox(id,user_id,chat_id,generation,kind,language,due_at,created_at)
        VALUES($1,$2,$3,$4,'activation',$5,$6,$6)`, [randomUUID(), input.userId, input.telegramId, generation, input.language, date(now())]);
    });
  }
  async function consentFailed(userId: string, reason: string) {
    await transaction(async client => {
      const current = await ensureSettings(client, userId);
      if (current.enabled && current.connection === 'connected') return;
      await cancelPending(client, userId);
      await client.query(`UPDATE telegram_notification_settings SET connection='error',enabled=false,last_error=$2,updated_at=$3 WHERE user_id=$1`, [userId, reason, date(now())]);
    });
  }
  async function webhook(update: TelegramNotificationUpdate) {
    await transaction(async client => {
      const inserted = await client.query('INSERT INTO telegram_notification_updates(update_id) VALUES($1) ON CONFLICT DO NOTHING RETURNING update_id', [update.updateId]);
      if (!inserted.rowCount) return;
      const settings = (await client.query<Settings>('SELECT * FROM telegram_notification_settings WHERE chat_id=$1 FOR UPDATE', [update.telegramId])).rows[0];
      if (!settings) return;
      if (update.command === 'stop' || update.blocked === true || (update.blocked === false && settings.connection === 'blocked')) {
        await cancelPending(client, settings.user_id);
        await client.query(`UPDATE telegram_notification_settings SET enabled=false,generation=$2,
          connection=CASE WHEN $3::boolean IS NULL THEN CASE WHEN connection='pending' THEN 'not_connected' ELSE connection END WHEN $3 THEN 'blocked' ELSE 'error' END,
          last_error=CASE WHEN $3::boolean IS NULL THEN NULL WHEN $3 THEN 'bot_blocked' ELSE 'reconnect_required' END,updated_at=$4 WHERE user_id=$1`,
        [settings.user_id, randomUUID(), update.blocked ?? null, date(now())]);
      }
      if (update.command && !update.blocked) await client.query(`INSERT INTO telegram_notification_outbox(id,user_id,chat_id,kind,language,payload,due_at,created_at)
        VALUES($1,$2,$3,'status',$4,$5::jsonb,$6,$6)`, [randomUUID(), settings.user_id, settings.chat_id, settings.language, JSON.stringify({ command: update.command }), date(now())]);
    });
  }
  async function collect() {
    if (!available()) return { events: 0, recipients: 0 };
    return transaction(async client => {
      const cutoff = date(now() - telegramTradeMaxAgeMs);
      // Expired work stays silent, including the initial migration of previously live rows.
      await client.query(`WITH old AS (SELECT id FROM trades WHERE observed_live AND NOT telegram_notification_processed
        AND timestamp<$1 LIMIT 5000) UPDATE trades SET telegram_notification_processed=true FROM old WHERE trades.id=old.id`, [cutoff]);
      const pending = await client.query(`SELECT t.id,t.tx_hash AS "txHash",t.wallet_address AS "walletAddress",t.token_address AS "tokenAddress",
        k.display_name AS "kolName",v.symbol AS "tokenSymbol",t.side,t.token_amount::text AS "tokenAmount",t.quote_amount::text AS "quoteAmount",
        t.quote_symbol AS "quoteSymbol",t.amount_usd::text AS "amountUsd",t.timestamp,t.block_number::text AS "blockNumber",t.block_hash AS "blockHash",
        (k.is_tracked AND ${kolProfileTokenSql('v')}) AS eligible
        FROM trades t JOIN published_kols k ON k.address=t.wallet_address JOIN tokens v ON v.address=t.token_address
        WHERE t.observed_live AND NOT t.telegram_notification_processed AND t.timestamp>=$1 AND t.timestamp<=$2
        AND t.block_number IS NOT NULL AND t.block_hash IS NOT NULL
        AND t.block_number<=COALESCE((SELECT (value->>'blockNumber')::bigint FROM worker_state WHERE key='node'),0)
        ORDER BY t.block_number,t.transaction_index NULLS FIRST,t.id LIMIT 50 FOR SHARE OF t`, [cutoff, date(now())]);
      let recipients = 0;
      for (const row of pending.rows) {
        if (!row.eligible || !['buy', 'sell'].includes(row.side)) continue;
        const payload: TelegramMessageTrade = { id: row.id, txHash: row.txHash, walletAddress: row.walletAddress, tokenAddress: row.tokenAddress,
          kolName: row.kolName, tokenSymbol: row.tokenSymbol, side: row.side, tokenAmount: row.tokenAmount,
          quoteAmount: row.quoteAmount, quoteSymbol: row.quoteSymbol, amountUsd: row.amountUsd, timestamp: new Date(row.timestamp).toISOString() };
        await client.query(`INSERT INTO telegram_trade_events(trade_id,block_hash,block_number,trade_timestamp,wallet_address,payload)
          VALUES($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT DO NOTHING`, [row.id, row.blockHash, row.blockNumber, payload.timestamp, row.walletAddress, JSON.stringify(payload)]);
        const subscribers = await client.query<Settings>(`SELECT s.* FROM telegram_notification_settings s
          JOIN account_watch_entries f ON f.user_id=s.user_id AND f.kind='kol' AND f.address=$1
          LEFT JOIN telegram_kol_notification_settings m ON m.user_id=s.user_id AND m.wallet_address=f.address
          WHERE s.enabled AND s.connection='connected' AND s.chat_id IS NOT NULL AND NOT COALESCE(m.muted,false)
          AND $2::timestamptz>GREATEST(s.enabled_since,f.added_at,COALESCE(m.resumed_since,s.enabled_since))
          AND (($3='buy' AND s.buys) OR ($3='sell' AND s.sells)) ORDER BY s.user_id FOR UPDATE OF s`, [row.walletAddress, payload.timestamp, row.side]);
        for (const settings of subscribers.rows) {
          const exists = await client.query('SELECT 1 FROM telegram_notification_items WHERE user_id=$1 AND trade_id=$2 AND block_hash=$3', [settings.user_id, row.id, row.blockHash]);
          if (exists.rowCount) continue;
          const last = (await client.query<Outbox>(`SELECT * FROM telegram_notification_outbox WHERE user_id=$1 AND wallet_address=$2
            AND generation=$3 AND kind='trades' AND status IN ('pending','leased','sent') ORDER BY created_at DESC,id DESC LIMIT 1`, [settings.user_id, row.walletAddress, settings.generation])).rows[0];
          const windowEnd = last?.window_ends_at?.getTime() ?? 0;
          let outboxId = last?.status === 'pending' && windowEnd > now() ? last.id : null;
          if (!outboxId) {
            outboxId = randomUUID();
            const due = windowEnd > now() ? windowEnd : now();
            const end = windowEnd > now() ? windowEnd : now() + 10_000;
            await client.query(`INSERT INTO telegram_notification_outbox(id,user_id,chat_id,generation,kind,wallet_address,language,due_at,window_ends_at,created_at)
              VALUES($1,$2,$3,$4,'trades',$5,$6,$7,$8,$9)`, [outboxId, settings.user_id, settings.chat_id, settings.generation, row.walletAddress, settings.language, date(due), date(end), date(now())]);
          }
          await client.query(`INSERT INTO telegram_notification_items(user_id,trade_id,block_hash,outbox_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [settings.user_id, row.id, row.blockHash, outboxId]);
          recipients++;
        }
      }
      if (pending.rows.length) await client.query('UPDATE trades SET telegram_notification_processed=true WHERE id=ANY($1::text[])', [pending.rows.map(row => row.id)]);
      return { events: pending.rows.length, recipients };
    });
  }
  async function eligibleItems(client: PoolClient, job: Outbox) {
    const result = await client.query<{ payload: TelegramMessageTrade; trade_id: string; block_hash: string; eligible: boolean }>(`SELECT e.payload || jsonb_build_object('kolName',k.display_name) AS payload,e.trade_id,e.block_hash,
      (t.id IS NOT NULL AND NOT e.orphaned AND k.is_tracked AND ${kolProfileTokenSql('v')}
        AND t.observed_live AND t.side IN ('buy','sell') AND t.side=e.payload->>'side'
        AND t.block_number<=COALESCE((SELECT (value->>'blockNumber')::bigint FROM worker_state WHERE key='node'),0)
        AND s.enabled AND s.connection='connected' AND s.generation=$2 AND s.chat_id=$3
        AND f.address IS NOT NULL AND NOT COALESCE(m.muted,false)
        AND e.trade_timestamp>GREATEST(s.enabled_since,f.added_at,COALESCE(m.resumed_since,s.enabled_since))
        AND e.trade_timestamp>=$4 AND e.trade_timestamp<=$5
        AND ((e.payload->>'side'='buy' AND s.buys) OR (e.payload->>'side'='sell' AND s.sells))) AS eligible
      FROM telegram_notification_items i JOIN telegram_trade_events e USING(trade_id,block_hash)
      JOIN telegram_notification_settings s ON s.user_id=i.user_id
      LEFT JOIN trades t ON t.id=e.trade_id AND t.block_hash=e.block_hash
      LEFT JOIN published_kols k ON k.address=e.wallet_address LEFT JOIN tokens v ON v.address=e.payload->>'tokenAddress'
      LEFT JOIN account_watch_entries f ON f.user_id=s.user_id AND f.kind='kol' AND f.address=e.wallet_address
      LEFT JOIN telegram_kol_notification_settings m ON m.user_id=s.user_id AND m.wallet_address=e.wallet_address
      WHERE i.outbox_id=$1 AND NOT i.cancelled ORDER BY e.block_number,e.trade_timestamp,e.trade_id`,
    [job.id, job.generation, job.chat_id, date(now() - telegramTradeMaxAgeMs), date(now())]);
    for (const item of result.rows) if (!item.eligible) await client.query('UPDATE telegram_notification_items SET cancelled=true WHERE user_id=$1 AND trade_id=$2 AND block_hash=$3', [job.user_id, item.trade_id, item.block_hash]);
    return result.rows.filter(item => item.eligible).map(item => item.payload);
  }
  async function claim(): Promise<Outbox | null> {
    return transaction(async client => {
      await client.query(`UPDATE telegram_notification_outbox SET status=CASE WHEN dispatch_started_at IS NULL THEN 'pending' ELSE 'uncertain' END,
        last_error=CASE WHEN dispatch_started_at IS NULL THEN 'lease_expired' ELSE 'delivery_unconfirmed' END,lease_id=NULL,lease_until=NULL
        WHERE status='leased' AND lease_until<$1`, [date(now())]);
      await client.query(`UPDATE telegram_notification_settings s SET connection='error',enabled=false,last_error='delivery_unconfirmed'
        WHERE s.connection='pending' AND EXISTS(SELECT 1 FROM telegram_notification_outbox o WHERE o.user_id=s.user_id
        AND o.generation=s.generation AND o.kind='activation' AND o.status='uncertain')`);
      const candidates = await client.query<Outbox>(`SELECT * FROM telegram_notification_outbox o WHERE status='pending' AND due_at<=$1
        AND NOT EXISTS(SELECT 1 FROM telegram_notification_outbox x WHERE x.chat_id=o.chat_id
          AND (x.status='leased' OR (x.status='cancelled' AND x.lease_until>$1)))
        ORDER BY due_at,created_at,id LIMIT 20 FOR UPDATE SKIP LOCKED`, [date(now())]);
      for (const job of candidates.rows) {
        const settings = (await client.query<Settings>('SELECT * FROM telegram_notification_settings WHERE user_id=$1 FOR UPDATE', [job.user_id])).rows[0];
        let invalid = !settings || settings.chat_id !== job.chat_id;
        if (job.kind === 'activation') invalid ||= settings?.generation !== job.generation || settings?.connection !== 'pending' || now() - job.created_at.getTime() > 600_000;
        if (job.kind === 'trades') invalid ||= settings?.generation !== job.generation || !(await eligibleItems(client, job)).length;
        if (invalid) {
          await client.query(`UPDATE telegram_notification_outbox SET status='cancelled',last_error='no_longer_eligible' WHERE id=$1`, [job.id]);
          if (job.kind === 'activation') await client.query(`UPDATE telegram_notification_settings SET connection='error',last_error='activation_expired' WHERE user_id=$1 AND generation=$2 AND connection='pending'`, [job.user_id, job.generation]);
          continue;
        }
        const keys = [`telegram:${config!.botId}:global`, `telegram:${config!.botId}:chat:${job.chat_id}`];
        const slots = await client.query<{ next_at: Date }>('SELECT next_at FROM telegram_notification_pacing WHERE scope=ANY($1::text[])', [keys]);
        const nextAt = Math.max(now(), ...slots.rows.map(row => row.next_at.getTime()));
        if (nextAt > now()) { await client.query('UPDATE telegram_notification_outbox SET due_at=$2 WHERE id=$1', [job.id, date(nextAt)]); continue; }
        for (const [index, key] of keys.entries()) await client.query(`INSERT INTO telegram_notification_pacing(scope,next_at) VALUES($1,$2)
          ON CONFLICT(scope) DO UPDATE SET next_at=EXCLUDED.next_at`, [key, date(now() + (index === 0 ? 40 : 1000))]);
        const lease = randomUUID();
        await client.query(`UPDATE telegram_notification_outbox SET status='leased',lease_id=$2,lease_until=$3,attempts=attempts+1 WHERE id=$1`, [job.id, lease, date(now() + 30_000)]);
        return { ...job, lease_id: lease, attempts: job.attempts + 1 };
      }
      return null;
    });
  }
  async function deliverOne() {
    if (!available()) return false;
    if (!await bot!.verifyIdentity()) {
      await db.query(`UPDATE telegram_notification_settings SET connection='error',enabled=false,last_error='bot_identity_unavailable' WHERE connection='pending'`);
      return false;
    }
    const job = await claim();
    if (!job) return false;
    const prepared = await transaction(async client => {
      const current = (await client.query<Outbox>('SELECT * FROM telegram_notification_outbox WHERE id=$1 AND lease_id=$2 AND status=\'leased\' FOR UPDATE', [job.id, job.lease_id])).rows[0];
      if (!current) return null;
      let message: TelegramFormattedMessage;
      if (job.kind === 'trades') {
        const trades = await eligibleItems(client, job);
        if (!trades.length) { await client.query("UPDATE telegram_notification_outbox SET status='cancelled',lease_id=NULL,lease_until=NULL WHERE id=$1", [job.id]); return null; }
        message = formatTelegramTradeMessage(trades, job.language, config!.origin);
      } else if (job.kind === 'activation') message = formatActivationMessage(job.language, config!.origin);
      else if (job.kind === 'correction') message = formatCorrectionMessage(job.language, config!.origin);
      else {
        const settings = (await client.query<Settings>('SELECT * FROM telegram_notification_settings WHERE user_id=$1', [job.user_id])).rows[0];
        const text = job.language === 'zh-CN' ? (settings.enabled ? 'Kollens：KOL 交易提醒已开启。' : 'Kollens：KOL 交易提醒已暂停。')
          : (settings.enabled ? 'Kollens: KOL trade alerts are on.' : 'Kollens: KOL trade alerts are paused.');
        message = { text, buttons: [[{ text: job.language === 'zh-CN' ? '管理提醒' : 'Manage alerts', url: `${config!.origin}/watchlist?tab=kols` }]] };
      }
      await client.query('UPDATE telegram_notification_outbox SET dispatch_started_at=$2 WHERE id=$1', [job.id, date(now())]);
      return message;
    });
    if (!prepared) return true;
    // The network request must remain outside database/reorg locks.
    const original = job.correction_of ? (await db.query<Outbox>('SELECT * FROM telegram_notification_outbox WHERE id=$1', [job.correction_of])).rows[0] : null;
    const upstreamStartedAt = Date.now();
    const result = original?.message_id ? await bot!.edit(job.chat_id, Number(original.message_id), prepared.text, prepared.buttons, prepared.entities)
      : await bot!.send(job.chat_id, prepared.text, prepared.buttons, prepared.entities);
    await transaction(async client => {
      const owned = (await client.query<Outbox>('SELECT * FROM telegram_notification_outbox WHERE id=$1 AND lease_id=$2 FOR UPDATE', [job.id, job.lease_id])).rows[0];
      if (!owned) return;
      const current = (await client.query<Settings>('SELECT * FROM telegram_notification_settings WHERE user_id=$1 FOR UPDATE', [job.user_id])).rows[0];
      if (result.kind === 'sent') {
        await client.query(`UPDATE telegram_notification_outbox SET status='sent',message_id=$2,sent_at=$3,lease_id=NULL,lease_until=NULL,last_error=NULL WHERE id=$1`, [job.id, result.messageId, date(now())]);
        if (job.kind === 'activation') await client.query(`UPDATE telegram_notification_settings SET connection='connected',enabled=true,connected_at=$3,
          enabled_since=$3,last_error=NULL,updated_at=$3 WHERE user_id=$1 AND generation=$2 AND connection='pending'`, [job.user_id, job.generation, date(now())]);
        if (job.kind === 'trades') await queueCorrections(client, undefined, job.id);
      } else if (result.kind === 'retry') {
        const due = now() + Math.max(1000, result.retryAfterMs);
        await client.query(`UPDATE telegram_notification_outbox SET status=CASE WHEN status='cancelled' THEN status ELSE 'pending' END,
          due_at=$2,dispatch_started_at=NULL,lease_id=NULL,lease_until=NULL,last_error=$3 WHERE id=$1`, [job.id, date(due), result.reason]);
        await client.query(`INSERT INTO telegram_notification_pacing(scope,next_at) VALUES($1,$2) ON CONFLICT(scope)
          DO UPDATE SET next_at=GREATEST(telegram_notification_pacing.next_at,EXCLUDED.next_at)`, [`telegram:${config!.botId}:global`, date(due)]);
      } else {
        await client.query(`UPDATE telegram_notification_outbox SET status=$2,last_error=$3,lease_id=NULL,lease_until=NULL WHERE id=$1`, [job.id, result.kind === 'uncertain' ? 'uncertain' : 'failed', result.kind === 'blocked' ? 'bot_blocked' : result.reason]);
        if (result.kind === 'blocked' || (job.kind === 'activation' && current?.generation === job.generation)) {
          await cancelPending(client, job.user_id);
          await client.query(`UPDATE telegram_notification_settings SET enabled=false,connection=$2,last_error=$3,updated_at=$4 WHERE user_id=$1`,
          [job.user_id, result.kind === 'blocked' ? 'blocked' : 'error', result.kind === 'blocked' ? 'bot_blocked' : 'activation_failed', date(now())]);
        }
      }
    });
    console.info(JSON.stringify({ event: 'telegram_delivery', kind: job.kind, result: result.kind,
      queueWaitMs: Math.max(0, now() - job.created_at.getTime()), upstreamDurationMs: Date.now() - upstreamStartedAt, attempts: job.attempts }));
    return true;
  }
  async function health() {
    const counts = await db.query(`SELECT status,COUNT(*)::int AS count FROM telegram_notification_outbox GROUP BY status`);
    const lag = await db.query(`SELECT
      (SELECT EXTRACT(epoch FROM ($1::timestamptz-MIN(created_at)))*1000 FROM telegram_notification_outbox WHERE status='pending') AS age,
      (SELECT EXTRACT(epoch FROM ($1::timestamptz-MIN(timestamp)))*1000 FROM trades WHERE observed_live AND NOT telegram_notification_processed
        AND timestamp>=$2 AND block_number<=COALESCE((SELECT (value->>'blockNumber')::bigint FROM worker_state WHERE key='node'),0)) AS collection_lag`,
    [date(now()), date(now() - telegramTradeMaxAgeMs)]);
    return { configured: available(), counts: Object.fromEntries(counts.rows.map(row => [row.status, row.count])),
      oldestPendingMs: Math.max(0, Number(lag.rows[0]?.age ?? 0)), collectionLagMs: Math.max(0, Number(lag.rows[0]?.collection_lag ?? 0)) };
  }
  async function run(signal?: AbortSignal) {
    if (!available()) return;
    await Promise.all([
      (async () => { while (!signal?.aborted) { try { const counts = await collect(); await db.query(`INSERT INTO worker_state(key,value,updated_at) VALUES('telegram_notifications',$1::jsonb,now()) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()`, [JSON.stringify({ ...counts, ...await health(), at: date(now()) })]); }
        catch { console.warn(JSON.stringify({ event: 'telegram_collection_failed' })); } await sleep(1000); } })(),
      (async () => { while (!signal?.aborted) { try { const dispatched = await deliverOne(); await sleep(dispatched ? 40 : 500); }
        catch { console.warn(JSON.stringify({ event: 'telegram_delivery_failed' })); await sleep(1000); } } })(),
    ]);
  }
  return { available, state, update, mute, authorize, consentFailed, webhook, collect, deliverOne, health, run };
}

async function queueCorrections(client: PoolClient, from?: number, outboxId?: string) {
  await client.query(`INSERT INTO telegram_notification_outbox(id,user_id,chat_id,kind,language,correction_of)
    SELECT gen_random_uuid(),o.user_id,o.chat_id,'correction',o.language,o.id FROM telegram_notification_outbox o
    WHERE o.kind='trades' AND o.status='sent' AND ($1::uuid IS NULL OR o.id=$1)
    AND EXISTS(SELECT 1 FROM telegram_notification_items i JOIN telegram_trade_events e USING(trade_id,block_hash)
      WHERE i.outbox_id=o.id AND (e.orphaned OR ($2::bigint IS NOT NULL AND e.block_number>=$2)))
    ON CONFLICT(correction_of) DO NOTHING`, [outboxId ?? null, from ?? null]);
}

/** Called in the existing reorg transaction, before canonical trade deletion. */
export async function rollbackTelegramNotifications(client: PoolClient, from: number) {
  await client.query('UPDATE telegram_trade_events SET orphaned=true WHERE block_number>=$1', [from]);
  await client.query(`UPDATE telegram_notification_items i SET cancelled=true FROM telegram_trade_events e
    WHERE i.trade_id=e.trade_id AND i.block_hash=e.block_hash AND e.orphaned`);
  await client.query(`UPDATE telegram_notification_outbox o SET status='cancelled',last_error='chain_reorganization'
    WHERE o.kind='trades' AND o.status IN ('pending','leased') AND EXISTS(SELECT 1 FROM telegram_notification_items i WHERE i.outbox_id=o.id)
    AND NOT EXISTS(SELECT 1 FROM telegram_notification_items i WHERE i.outbox_id=o.id AND NOT i.cancelled)`);
  await queueCorrections(client, from);
}

export const telegramNotifications = createTelegramNotifications();
