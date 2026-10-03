import { createHash, timingSafeEqual } from 'node:crypto';
import { pool, setState } from './db.js';
import { signalLabels, type SignalKind } from '../shared/intelligence.js';

export const hashSecret = (value: string) => createHash('sha256').update(value).digest('hex');
export function validWebhookSecret(supplied: unknown, expected = process.env.TELEGRAM_WEBHOOK_SECRET) {
  if (typeof supplied !== 'string' || !expected) return false;
  const a = Buffer.from(supplied), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
export interface TelegramResult { ok: boolean; result?: { username?: string; message_id?: number }; error_code?: number; parameters?: { retry_after?: number }; uncertain?: boolean }
export async function telegramRequest(method: string, payload: unknown): Promise<TelegramResult> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return { ok: false, error_code: 503 };
  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(12000),
    });
    const result = await response.json() as TelegramResult;
    return typeof result.ok === 'boolean' ? result : { ok: false, uncertain: true };
  } catch { return { ok: false, uncertain: true }; }
}
let cachedUsername: { value: string | null; expires: number } | null = null;
let usernameRequest: Promise<string | null> | null = null;
export async function telegramBotUsername() {
  if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_WEBHOOK_SECRET) return null;
  const configured = process.env.TELEGRAM_BOT_USERNAME?.replace(/^@/, '');
  if (configured && /^[A-Za-z0-9_]{5,32}$/.test(configured)) return configured;
  if (cachedUsername && cachedUsername.expires > Date.now()) return cachedUsername.value;
  if (!usernameRequest) usernameRequest = (async () => {
    const result = await telegramRequest('getMe', {});
    const value = result.ok ? result.result?.username ?? null : null;
    cachedUsername = { value, expires: Date.now() + (value ? 600_000 : 60_000) };
    return value;
  })().finally(() => { usernameRequest = null; });
  return usernameRequest;
}
export function deliveryOutcome(result: TelegramResult, attempts: number) {
  if (result.ok && result.result?.message_id != null) return { status: 'sent', retrySeconds: 0 };
  if (result.uncertain) return { status: 'uncertain', retrySeconds: 0 };
  if (result.error_code === 429) return { status: 'queued', retrySeconds: Math.max(1, Number(result.parameters?.retry_after) || 30) };
  if (result.error_code != null && result.error_code >= 500 && attempts < 5) return { status: 'queued', retrySeconds: Math.min(120, 2 ** attempts * 5) };
  return { status: 'failed', retrySeconds: 0 };
}
export async function handleTelegramUpdate(update: { update_id: number; message?: { text?: string; chat: { id: number; type: string }; from?: { username?: string } } }) {
  const client = await pool.connect();
  let responseChat: string | null = null;
  let responseText: string | null = null;
  try {
    await client.query('BEGIN');
    const inserted = await client.query('INSERT INTO telegram_updates(update_id) VALUES($1) ON CONFLICT(update_id) DO NOTHING RETURNING update_id', [update.update_id]);
    if (inserted.rowCount && update.message?.chat.type === 'private') {
      const chat = String(update.message.chat.id);
      const command = update.message.text?.trim() ?? '';
      const nonce = command.match(/^\/start(?:@[A-Za-z0-9_]+)? ([A-Za-z0-9_-]{32,64})$/)?.[1];
      if (nonce) {
        const linked = await client.query(`UPDATE telegram_links SET chat_id=$2,username=$3,claimed_at=now()
          WHERE nonce_hash=$1 AND expires_at>now() AND claimed_at IS NULL AND confirmed_at IS NULL RETURNING session_id`, [hashSecret(nonce), chat, update.message.from?.username ?? null]);
        responseChat = chat;
        responseText = linked.rowCount ? 'Return to bscan to enable your alerts.' : 'This link has expired. Connect again from bscan.';
      } else if (/^\/stop(?:@[A-Za-z0-9_]+)?$/.test(command)) {
        const sessions = await client.query('SELECT id FROM watch_sessions WHERE telegram_chat_id=$1 FOR UPDATE', [chat]);
        for (const row of sessions.rows) {
          await client.query('DELETE FROM telegram_links WHERE session_id=$1', [row.id]);
          await client.query(`UPDATE notification_deliveries SET status='cancelled',updated_at=now() WHERE session_id=$1 AND status='queued'`, [row.id]);
        }
        await client.query(`UPDATE watch_sessions SET telegram_chat_id=NULL,telegram_username=NULL,telegram_connected_at=NULL,updated_at=now() WHERE telegram_chat_id=$1`, [chat]);
        responseChat = chat; responseText = 'Alerts stopped.';
      } else if (/^\/(start|help)(?:@[A-Za-z0-9_]+)?$/.test(command)) {
        responseChat = chat; responseText = 'Connect your watchlist from bscan.fun. Use /stop to stop alerts.';
      }
    }
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
  if (responseChat && responseText) await telegramRequest('sendMessage', { chat_id: responseChat, text: responseText });
}
export async function queueDeliveries() {
  await pool.query(`INSERT INTO notification_deliveries(session_id,signal_id)
    SELECT DISTINCT w.id,s.id FROM watch_sessions w JOIN watch_entries e ON e.session_id=w.id
      JOIN radar_signals s ON (e.kind='token' AND e.address=s.token_address OR e.kind='kol' AND e.address=ANY(s.wallet_addresses))
    WHERE w.expires_at>now() AND w.telegram_chat_id IS NOT NULL AND w.telegram_connected_at IS NOT NULL
      AND NOT (w.preferences->>'muted')::boolean AND w.preferences->'categories' ? s.kind
      AND s.live AND NOT s.corrected AND s.published_at>=w.telegram_connected_at AND s.published_at>=w.updated_at
      AND s.timestamp>now()-interval '10 minutes'
      AND (s.window_minutes=0 OR s.window_minutes=(w.preferences->>'windowMinutes')::integer AND s.min_buyers=(w.preferences->>'minBuyers')::integer)
    ON CONFLICT(session_id,signal_id) DO NOTHING`);
}
export async function deliverTelegramBatch() {
  const pause = await pool.query(`SELECT value->>'until' AS until FROM worker_state WHERE key='telegram_retry'`);
  if (pause.rows[0]?.until && Date.parse(pause.rows[0].until) > Date.now()) return;
  await pool.query(`UPDATE notification_deliveries SET status='uncertain',last_error='Delivery interrupted',updated_at=now() WHERE status='sending' AND updated_at<now()-interval '2 minutes'`);
  await pool.query(`UPDATE notification_deliveries SET status='cancelled',updated_at=now() WHERE status='queued' AND created_at<now()-interval '10 minutes'`);
  for (let index = 0; index < 8; index++) {
    const client = await pool.connect();
    let delivery;
    try {
      await client.query('BEGIN');
      const result = await client.query(`SELECT d.session_id,d.signal_id,w.telegram_chat_id,w.preferences,w.expires_at,s.kind,s.token_address,s.corrected,s.live,s.timestamp,v.symbol,
        s.window_minutes,s.min_buyers,cardinality(s.wallet_addresses) AS participant_count,
        EXISTS(SELECT 1 FROM watch_entries e WHERE e.session_id=w.id AND (e.kind='token' AND e.address=s.token_address OR e.kind='kol' AND e.address=ANY(s.wallet_addresses))) AS watched
        FROM notification_deliveries d JOIN watch_sessions w ON w.id=d.session_id JOIN radar_signals s ON s.id=d.signal_id JOIN tokens v ON v.address=s.token_address
        WHERE d.status='queued' AND d.available_at<=now() AND NOT EXISTS(
          SELECT 1 FROM notification_deliveries other WHERE other.session_id=d.session_id AND other.status='sending')
        AND NOT EXISTS(SELECT 1 FROM notification_deliveries recent WHERE recent.session_id=d.session_id AND recent.status='sent' AND recent.updated_at>now()-interval '1 second')
        ORDER BY d.available_at,d.created_at LIMIT 1 FOR UPDATE OF d,w SKIP LOCKED`);
      delivery = result.rows[0];
      if (delivery) {
        const valid = delivery.live && !delivery.corrected && Date.now() - new Date(delivery.timestamp).getTime() <= 600_000 && delivery.telegram_chat_id && delivery.watched && new Date(delivery.expires_at).getTime() > Date.now()
          && !delivery.preferences.muted && delivery.preferences.categories.includes(delivery.kind)
          && (delivery.window_minutes === 0 || delivery.window_minutes === delivery.preferences.windowMinutes && delivery.min_buyers === delivery.preferences.minBuyers);
        const claimed = await client.query(`UPDATE notification_deliveries SET status=$3,attempts=attempts+1,updated_at=now() WHERE session_id=$1 AND signal_id=$2 RETURNING attempts`,
        [delivery.session_id, delivery.signal_id, valid ? 'sending' : 'cancelled']);
        if (!valid) delivery = null;
        else delivery.attempts = claimed.rows[0].attempts;
      }
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
    if (!delivery) break;
    const current = await pool.query(`SELECT 1 FROM notification_deliveries d JOIN watch_sessions w ON w.id=d.session_id JOIN radar_signals s ON s.id=d.signal_id
      WHERE d.session_id=$1 AND d.signal_id=$2 AND d.status='sending' AND s.live AND NOT s.corrected AND s.timestamp>now()-interval '10 minutes' AND w.telegram_chat_id=$3
      AND w.expires_at>now() AND NOT (w.preferences->>'muted')::boolean AND w.preferences->'categories' ? s.kind
      AND (s.window_minutes=0 OR s.window_minutes=(w.preferences->>'windowMinutes')::integer AND s.min_buyers=(w.preferences->>'minBuyers')::integer)
      AND EXISTS(SELECT 1 FROM watch_entries e WHERE e.session_id=w.id AND (e.kind='token' AND e.address=s.token_address OR e.kind='kol' AND e.address=ANY(s.wallet_addresses)))`,
    [delivery.session_id, delivery.signal_id, delivery.telegram_chat_id]);
    if (!current.rowCount) { await pool.query(`UPDATE notification_deliveries SET status='cancelled',updated_at=now() WHERE session_id=$1 AND signal_id=$2 AND status='sending'`, [delivery.session_id, delivery.signal_id]); continue; }
    const origin = (process.env.PUBLIC_APP_URL || 'https://bscan.fun').replace(/\/$/, '');
    const message = await telegramRequest('sendMessage', {
      chat_id: delivery.telegram_chat_id,
      text: `${String(delivery.symbol || delivery.token_address).replace(/[\r\n\t]/g, ' ').slice(0, 48)}\n${signalLabels[delivery.kind as SignalKind]}${delivery.kind === 'clustered_buys' ? ` · ${delivery.participant_count} KOLs` : ''} · ${new Date(delivery.timestamp).toISOString().slice(11, 16)} UTC`,
      link_preview_options: { is_disabled: true },
      reply_markup: { inline_keyboard: [[{ text: 'View on bscan', url: `${origin}/token/${delivery.token_address}` }, { text: 'View signal', url: `${origin}/trades?view=radar&signal=${delivery.signal_id}` }]] },
    });
    const outcome = deliveryOutcome(message, delivery.attempts);
    await pool.query(`UPDATE notification_deliveries SET status=$3,available_at=now()+$4*interval '1 second',updated_at=now(),message_id=$5,last_error=$6
      WHERE session_id=$1 AND signal_id=$2 AND status='sending'`, [delivery.session_id, delivery.signal_id, outcome.status, outcome.retrySeconds,
      message.result?.message_id != null ? String(message.result.message_id) : null, message.ok ? null : message.uncertain ? 'Delivery unconfirmed' : `Telegram ${message.error_code ?? 'unavailable'}`]);
    if (message.error_code === 403) {
      await pool.query(`UPDATE watch_sessions SET preferences=jsonb_set(preferences,'{muted}','true'),updated_at=now() WHERE id=$1`, [delivery.session_id]);
    }
    if (message.error_code === 429) {
      await setState('telegram_retry', { until: new Date(Date.now() + outcome.retrySeconds * 1000).toISOString() });
      break;
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
}
export async function telegramDeliveryLoop() {
  for (;;) {
    try {
      const enabled = process.env.TELEGRAM_DELIVERY_ENABLED === 'true' && Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_WEBHOOK_SECRET);
      if (enabled) { await queueDeliveries(); await deliverTelegramBatch(); }
      const counts = await pool.query(`SELECT status,COUNT(*)::int AS count FROM notification_deliveries GROUP BY status`);
      await setState('telegram', { enabled, checkedAt: new Date().toISOString(), deliveries: Object.fromEntries(counts.rows.map(row => [row.status, row.count])) });
      await pool.query('DELETE FROM watch_sessions WHERE expires_at<now()');
      await pool.query(`DELETE FROM telegram_updates WHERE received_at<now()-interval '7 days'`);
      await pool.query(`DELETE FROM telegram_links WHERE expires_at<now()-interval '1 day'`);
    } catch (error) { console.error('Telegram delivery:', error instanceof Error ? error.message : 'Unavailable'); }
    await new Promise(resolve => setTimeout(resolve, 3000));
  }
}
