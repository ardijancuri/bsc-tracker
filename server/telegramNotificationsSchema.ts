import type { Pool } from 'pg';

export async function ensureTelegramNotificationsSchema(pool: Pool, fresh = false) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(782326)');
    await client.query(`
      ${fresh ? '' : `ALTER TABLE trades ADD COLUMN IF NOT EXISTS telegram_notification_processed boolean NOT NULL DEFAULT false;
      CREATE INDEX IF NOT EXISTS trades_telegram_pending_idx ON trades(block_number,transaction_index,id)
        WHERE observed_live AND NOT telegram_notification_processed AND block_number IS NOT NULL;`}
      CREATE TABLE IF NOT EXISTS telegram_notification_settings (
        user_id uuid PRIMARY KEY REFERENCES auth_users(id) ON DELETE CASCADE,
        chat_id text UNIQUE, connection text NOT NULL DEFAULT 'not_connected'
          CHECK(connection IN ('not_connected','pending','connected','blocked','error')),
        enabled boolean NOT NULL DEFAULT false, buys boolean NOT NULL DEFAULT true, sells boolean NOT NULL DEFAULT true,
        language text NOT NULL DEFAULT 'en' CHECK(language IN ('en','zh-CN')),
        generation uuid NOT NULL, enabled_since timestamptz, connected_at timestamptz,
        last_error text, updated_at timestamptz NOT NULL DEFAULT now(), CHECK(buys OR sells)
      );
      CREATE TABLE IF NOT EXISTS telegram_kol_notification_settings (
        user_id uuid NOT NULL, kind text NOT NULL DEFAULT 'kol' CHECK(kind='kol'), wallet_address text NOT NULL,
        muted boolean NOT NULL DEFAULT false, resumed_since timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY(user_id,wallet_address),
        FOREIGN KEY(user_id,kind,wallet_address) REFERENCES account_watch_entries(user_id,kind,address) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS telegram_trade_events (
        trade_id text NOT NULL, block_hash text NOT NULL, block_number bigint NOT NULL,
        trade_timestamp timestamptz NOT NULL, wallet_address text NOT NULL,
        payload jsonb NOT NULL, orphaned boolean NOT NULL DEFAULT false, collected_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY(trade_id,block_hash)
      );
      CREATE TABLE IF NOT EXISTS telegram_notification_outbox (
        id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
        chat_id text NOT NULL, generation uuid, kind text NOT NULL CHECK(kind IN ('activation','trades','correction','status')),
        wallet_address text, language text NOT NULL DEFAULT 'en',
        status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','leased','sent','cancelled','failed','uncertain')),
        due_at timestamptz NOT NULL DEFAULT now(), window_ends_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
        lease_id uuid, lease_until timestamptz, dispatch_started_at timestamptz,
        attempts integer NOT NULL DEFAULT 0, message_id bigint, sent_at timestamptz, last_error text,
        correction_of uuid UNIQUE REFERENCES telegram_notification_outbox(id), payload jsonb NOT NULL DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS telegram_outbox_due_idx ON telegram_notification_outbox(due_at,created_at) WHERE status='pending';
      CREATE INDEX IF NOT EXISTS telegram_outbox_user_idx ON telegram_notification_outbox(user_id,created_at);
      CREATE TABLE IF NOT EXISTS telegram_notification_items (
        user_id uuid NOT NULL, trade_id text NOT NULL, block_hash text NOT NULL,
        outbox_id uuid NOT NULL REFERENCES telegram_notification_outbox(id) ON DELETE CASCADE,
        cancelled boolean NOT NULL DEFAULT false,
        PRIMARY KEY(user_id,trade_id,block_hash),
        FOREIGN KEY(trade_id,block_hash) REFERENCES telegram_trade_events(trade_id,block_hash)
      );
      CREATE INDEX IF NOT EXISTS telegram_items_outbox_idx ON telegram_notification_items(outbox_id);
      CREATE TABLE IF NOT EXISTS telegram_notification_updates (
        update_id text PRIMARY KEY, received_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS telegram_notification_pacing (
        scope text PRIMARY KEY, next_at timestamptz NOT NULL
      );
    `);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
