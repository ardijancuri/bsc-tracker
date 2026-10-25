import type { Pool, PoolClient } from 'pg';
import { ensureAuthSchema } from '../telegramAuth.js';
import { ensureTelegramBotLoginSchema } from '../telegramBotLogin.js';
import { ensureTelegramAvatarSchema } from '../telegramBotAvatar.js';
import { ensureAccountWatchlistSchema } from '../accountWatchlist.js';
import { ensureCreatorSchema } from '../creatorSchema.js';
import { ensureTelegramNotificationsSchema } from '../telegramNotificationsSchema.js';
import {freshRollingSchemaSql} from './rollingSchema.js';
import{freshPendingTradesSchemaSql}from'./pendingTrades.js';


/** Existing objects owned by this startup, including compatibility views.
 * Foreign/public extension relations are not part of the lock footprint. */
export const FRESH_STARTUP_PUBLIC_RELATIONS = Object.freeze([
  'kols','tokens','worker_state','trades','watch_sessions','watch_entries','journal_wallets',
  'auth_users','auth_sessions','auth_login_attempts','auth_bot_login_attempts','auth_bot_login_updates','auth_bot_login_pacing','auth_telegram_avatars',
  'account_watch_entries','active_watch_entries','creator_claims','creator_profiles','creator_challenges','published_kols',
  'telegram_notification_settings','telegram_kol_notification_settings','telegram_trade_events','telegram_notification_outbox',
  'telegram_notification_items','telegram_notification_updates','telegram_notification_pacing',
]);
export const FRESH_STARTUP_RELATIONS_SQL = `SELECT n.nspname AS schema,c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE c.relkind IN('r','p','v','m') AND(n.nspname='fresh' OR(n.nspname='public' AND c.relname=ANY($1::text[]))) ORDER BY n.nspname,c.relname`;
const quoteIdentifier = (value:string) => '"'+value.replaceAll('"','""')+'"';
export function freshStartupLockSql(rows:{schema:string;name:string}[]) {
  if(!rows.length)return null;
  for(const row of rows)if(row.schema!=='fresh'&&(row.schema!=='public'||!FRESH_STARTUP_PUBLIC_RELATIONS.includes(row.name)))throw Error('fresh_startup_relation_not_owned');
  return 'LOCK TABLE '+rows.map(row=>quoteIdentifier(row.schema)+'.'+quoteIdentifier(row.name)).join(',')+' IN ACCESS EXCLUSIVE MODE NOWAIT';
}
/** Helper schema functions retain their savepoint boundaries on the already
 * guarded connection. None can commit/release the outer relation locks. */
function freshStartupHelperPool(client:PoolClient):Pool {
  let sequence=0;
  return {query:client.query.bind(client),async connect(){
    const name='fresh_startup_helper_'+(++sequence);let active=false;
    return {async query(sql:string,values?:unknown[]){
      if(sql==='BEGIN'){const value=await client.query('SAVEPOINT '+name);active=true;return value;}
      if(sql==='COMMIT'){const value=await client.query('RELEASE SAVEPOINT '+name);active=false;return value;}
      if(sql==='ROLLBACK'){
        if(!active)return {rows:[],rowCount:0,command:'ROLLBACK',oid:0,fields:[]};
        const value=await client.query('ROLLBACK TO SAVEPOINT '+name);active=false;return value;
      }
      return client.query(sql,values);
    },release(){}};
  }} as unknown as Pool;
}
export const FRESH_STARTUP_HELPER_LOCKS=Object.freeze([782321,782322,782326,782329,782330]);
export const FRESH_STARTUP_MAX_ATTEMPTS=5;
const retryableStartupError=(error:unknown)=>['55P03','40P01'].includes(String((error as {code?:unknown})?.code));

/** Fresh installs only. Never points a replacement schema at the live/legacy database. */
export async function ensureFreshSchema(db: Pool) {
  for(let attempt=0;attempt<FRESH_STARTUP_MAX_ATTEMPTS;attempt++){
    try{await ensureFreshSchemaAttempt(db);return;}catch(error){
      if(!retryableStartupError(error)||attempt===FRESH_STARTUP_MAX_ATTEMPTS-1)throw error;
      // Every failed attempt has rolled back and released its client first.
      await new Promise(resolve=>setTimeout(resolve,2000*2**attempt));
    }
  }
}
async function ensureFreshSchemaAttempt(db: Pool) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(73621940)');
    // Match cutover's schema -> financial order before taking any DDL locks.
    // An active writer must finish before startup locks tokens/markets.
    await client.query('SELECT pg_advisory_xact_lock(73621941)');
    const legacy = await client.query(`SELECT to_regclass('public.position_snapshots') AS legacy`);
    if (legacy.rows[0].legacy) throw new Error('fresh_requires_separate_database');
    // Standalone helper initializers take these guards before their tables.
    // Reenter every helper guard before prelocking those same relations.
    for(const key of FRESH_STARTUP_HELPER_LOCKS)await client.query('SELECT pg_advisory_xact_lock($1)',[key]);
    // Readers do not hold the financial advisory lock. Acquire every existing
    // affected table/view without waiting, before taking any DDL lock. A busy
    // relation aborts this entire attempt instead of forming a reader/DDL cycle.
    const relations=(await client.query(FRESH_STARTUP_RELATIONS_SQL,[FRESH_STARTUP_PUBLIC_RELATIONS])).rows;
    const lockSql=freshStartupLockSql(relations);if(lockSql)await client.query(lockSql);
    await client.query(`CREATE SCHEMA IF NOT EXISTS fresh;
      CREATE TABLE IF NOT EXISTS fresh.wallets (
        address text PRIMARY KEY CHECK(address ~ '^0x[0-9a-f]{40}$'),
        active boolean NOT NULL DEFAULT true, monitoring_from_block bigint NOT NULL,
        monitoring_to_block bigint,decode_gap_from_block bigint,decode_gap_reason text, registered_at timestamptz NOT NULL DEFAULT now(), revision bigint NOT NULL DEFAULT 1
      );
      CREATE TABLE IF NOT EXISTS fresh.kols (
        wallet_address text PRIMARY KEY REFERENCES fresh.wallets(address),
        display_name text,avatar_url text,twitter text,source text NOT NULL DEFAULT 'roster',
        is_tracked boolean NOT NULL DEFAULT true,first_seen_at timestamptz NOT NULL DEFAULT now(),
        last_seen_at timestamptz,profile_checked_at timestamptz,avatar_checked_at timestamptz,
        today_utc date NOT NULL DEFAULT (now() AT TIME ZONE 'UTC')::date,
        today_realized_q text DEFAULT '0',today_known_realized_q text NOT NULL DEFAULT '0',today_capital_q text NOT NULL DEFAULT '0',
        today_volume_q text NOT NULL DEFAULT '0',today_trade_count integer NOT NULL DEFAULT 0,
        today_token_count integer NOT NULL DEFAULT 0,today_unknown_count integer NOT NULL DEFAULT 0,
        today_buy_count integer NOT NULL DEFAULT 0,today_sell_count integer NOT NULL DEFAULT 0,
        today_valued_sell_count integer NOT NULL DEFAULT 0,today_unknown_sell_count integer NOT NULL DEFAULT 0,
        today_valued_transfer_count integer NOT NULL DEFAULT 0,today_unknown_transfer_count integer NOT NULL DEFAULT 0,
        today_valued_fee_count integer NOT NULL DEFAULT 0,today_unknown_fee_count integer NOT NULL DEFAULT 0,today_fee_only_q text NOT NULL DEFAULT '0',
        today_unallocated_fee_count integer NOT NULL DEFAULT 0,today_unallocated_fee_q text NOT NULL DEFAULT '0',today_unallocated_fee_unknown_count integer NOT NULL DEFAULT 0,today_unattributed_fee_count integer NOT NULL DEFAULT 0,
        last_trade_at timestamptz,metrics_updated_at timestamptz,revision bigint NOT NULL DEFAULT 1
      ) WITH(fillfactor=80);
      CREATE TABLE IF NOT EXISTS fresh.tokens (
        address text PRIMARY KEY CHECK(address ~ '^0x[0-9a-f]{40}$'),symbol text,name text,logo_url text,
        logo_data bytea,logo_mime text,website_url text,decimals integer CHECK(decimals BETWEEN 0 AND 255),
        total_supply_raw numeric,price_usd numeric,market_cap_usd numeric,price_source text,
        observed_block bigint,observed_hash text,observed_at timestamptz,metadata_updated_at timestamptz,
        launch_status text NOT NULL DEFAULT 'unverified',is_meme boolean,
        today_utc date NOT NULL DEFAULT (now() AT TIME ZONE 'UTC')::date,
        today_buy_count integer NOT NULL DEFAULT 0,today_sell_count integer NOT NULL DEFAULT 0,
        today_kol_count integer NOT NULL DEFAULT 0,today_volume_q text NOT NULL DEFAULT '0',last_trade_at timestamptz,
        tracked_trade_count bigint NOT NULL DEFAULT 0,tracked_buy_count bigint NOT NULL DEFAULT 0,
        tracked_sell_count bigint NOT NULL DEFAULT 0,tracked_volume_q text NOT NULL DEFAULT '0',
        revision bigint NOT NULL DEFAULT 1,valuation_status text NOT NULL DEFAULT 'pending'
      ) WITH(fillfactor=80);
      CREATE TABLE IF NOT EXISTS fresh.markets (
        id text PRIMARY KEY,token_address text NOT NULL REFERENCES fresh.tokens(address),address text,
        protocol text NOT NULL,quote_address text,identity jsonb NOT NULL DEFAULT '{}',state jsonb NOT NULL DEFAULT '{}',
        observed_block bigint,observed_hash text,observed_at timestamptz,status text NOT NULL DEFAULT 'pending',
        UNIQUE(token_address,address)
      );
      CREATE INDEX IF NOT EXISTS markets_token_idx ON fresh.markets(token_address);
      CREATE TABLE IF NOT EXISTS fresh.accounting_scopes (
        id text PRIMARY KEY,kind text NOT NULL CHECK(kind IN('kol','portfolio_wallet','portfolio_combined')),
        wallet_addresses text[] NOT NULL,account_id text,starts_at timestamptz NOT NULL,starts_block bigint NOT NULL,
        revision bigint NOT NULL DEFAULT 1,correction_epoch bigint NOT NULL DEFAULT 0,active boolean NOT NULL DEFAULT true
        ,fee_only_realized_q text DEFAULT '0',fee_only_fees_q text NOT NULL DEFAULT '0',fee_only_unknown_count bigint NOT NULL DEFAULT 0
        ,unallocated_fee_count bigint NOT NULL DEFAULT 0,unallocated_fee_q text NOT NULL DEFAULT '0',unallocated_fee_unknown_count bigint NOT NULL DEFAULT 0,unattributed_fee_count bigint NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS accounting_scopes_wallet_idx ON fresh.accounting_scopes USING gin(wallet_addresses);
      CREATE TABLE IF NOT EXISTS fresh.financial_events (
        id text PRIMARY KEY,execution_key text UNIQUE NOT NULL,wallet_address text NOT NULL REFERENCES fresh.wallets(address),
        token_address text REFERENCES fresh.tokens(address),kind text NOT NULL CHECK(kind IN('buy','sell','transfer_in','transfer_out','fee')),
        quantity text NOT NULL DEFAULT '0',amount_usd text,fee_usd text,fee_key text,counterparty text,transfer_key text,
        block_number bigint NOT NULL,block_hash text NOT NULL,transaction_hash text NOT NULL,
        transaction_index integer NOT NULL,execution_index integer NOT NULL,log_index integer,
        occurred_at timestamptz NOT NULL,canonical boolean NOT NULL DEFAULT true,
        observed_live boolean NOT NULL DEFAULT true,telegram_notification_processed boolean NOT NULL DEFAULT false,
        quote_address text,quote_symbol text,quote_amount text,price_usd text,decoder_version integer NOT NULL DEFAULT 1
        ,fee_attribution jsonb
      );
      ALTER TABLE fresh.financial_events ADD COLUMN IF NOT EXISTS bnb_price_usd text;
      ALTER TABLE fresh.financial_events ADD COLUMN IF NOT EXISTS acquisition_cost jsonb;
      ALTER TABLE fresh.financial_events ADD COLUMN IF NOT EXISTS market_cap_usd text;
      ALTER TABLE fresh.financial_events ADD COLUMN IF NOT EXISTS market_mark jsonb;
      ALTER TABLE fresh.financial_events ADD COLUMN IF NOT EXISTS provenance jsonb;
      ${freshPendingTradesSchemaSql}
      CREATE INDEX IF NOT EXISTS financial_events_wallet_idx ON fresh.financial_events(wallet_address,occurred_at DESC,id DESC) WHERE canonical;
      CREATE INDEX IF NOT EXISTS financial_events_imported_idx ON fresh.financial_events(wallet_address,token_address,block_number) WHERE canonical AND provenance IS NOT NULL;
      CREATE INDEX IF NOT EXISTS financial_events_unvalued_transfer_idx ON fresh.financial_events(wallet_address,token_address,id)
        WHERE canonical AND amount_usd IS NULL AND kind IN('transfer_in','transfer_out');
      CREATE INDEX IF NOT EXISTS financial_events_token_idx ON fresh.financial_events(token_address,occurred_at DESC,id DESC) WHERE canonical;
      CREATE INDEX IF NOT EXISTS financial_events_block_idx ON fresh.financial_events(block_number);
      CREATE INDEX IF NOT EXISTS financial_events_live_time_idx ON fresh.financial_events(occurred_at DESC,block_number DESC,transaction_index DESC,execution_index DESC,id DESC)
        WHERE canonical AND observed_live AND kind IN('buy','sell');
      CREATE INDEX IF NOT EXISTS financial_events_transfer_idx ON fresh.financial_events(transfer_key,kind) WHERE canonical AND transfer_key IS NOT NULL;
      CREATE INDEX IF NOT EXISTS financial_events_telegram_idx ON fresh.financial_events(block_number,transaction_index,id)
        WHERE canonical AND observed_live AND NOT telegram_notification_processed;
      CREATE TABLE IF NOT EXISTS fresh.scope_event_results (
        scope_id text NOT NULL REFERENCES fresh.accounting_scopes(id),event_id text NOT NULL REFERENCES fresh.financial_events(id),
        token_address text,realized_q text,known_realized_q text NOT NULL DEFAULT '0',capital_q text NOT NULL DEFAULT '0',
        fee_q text,fee_key text,trade_count integer NOT NULL DEFAULT 0,volume_q text NOT NULL DEFAULT '0',
        tokens_trade boolean NOT NULL DEFAULT false,occurred_at timestamptz NOT NULL,
        PRIMARY KEY(scope_id,event_id)
      );
      CREATE INDEX IF NOT EXISTS scope_event_results_day_idx ON fresh.scope_event_results(scope_id,occurred_at);
      CREATE INDEX IF NOT EXISTS scope_event_results_fee_idx ON fresh.scope_event_results(scope_id,fee_key) WHERE fee_key IS NOT NULL;
      CREATE TABLE IF NOT EXISTS fresh.positions (
        scope_id text NOT NULL REFERENCES fresh.accounting_scopes(id),token_address text NOT NULL REFERENCES fresh.tokens(address),
        quantity_q text NOT NULL DEFAULT '0',invested_q text NOT NULL DEFAULT '0',sold_q text NOT NULL DEFAULT '0',
        incoming_q text NOT NULL DEFAULT '0',outgoing_q text NOT NULL DEFAULT '0',fees_q text NOT NULL DEFAULT '0',
        capital_q text NOT NULL DEFAULT '0',realized_q text,unknown_cost boolean NOT NULL DEFAULT false,
        unknown_fee boolean NOT NULL DEFAULT false,last_event_id text,last_event_at timestamptz,revision bigint NOT NULL DEFAULT 1,
        unknown_purchase_value boolean NOT NULL DEFAULT false,unknown_sale_value boolean NOT NULL DEFAULT false,
        unknown_incoming_value boolean NOT NULL DEFAULT false,unknown_outgoing_value boolean NOT NULL DEFAULT false,
        balance_quantity text,balance_block bigint,balance_hash text,balance_checked_at timestamptz,balance_status text NOT NULL DEFAULT 'pending',
        PRIMARY KEY(scope_id,token_address)
      ) WITH(fillfactor=80);
      CREATE INDEX IF NOT EXISTS positions_token_idx ON fresh.positions(token_address);
      CREATE TABLE IF NOT EXISTS fresh.open_lots (
        id text PRIMARY KEY,scope_id text NOT NULL REFERENCES fresh.accounting_scopes(id),
        token_address text NOT NULL REFERENCES fresh.tokens(address),wallet_address text NOT NULL,
        acquired_event_id text NOT NULL,acquired_block bigint NOT NULL,acquired_transaction_index integer NOT NULL,
        acquired_execution_index integer NOT NULL,quantity_q text NOT NULL,cost_q text,fee_known boolean NOT NULL
      );
      CREATE INDEX IF NOT EXISTS open_lots_fifo_idx ON fresh.open_lots(scope_id,token_address,acquired_block,acquired_transaction_index,acquired_execution_index,id);
      CREATE TABLE IF NOT EXISTS fresh.launch_facts (
        token_address text PRIMARY KEY,protocol text NOT NULL,block_number bigint NOT NULL,block_hash text NOT NULL,
        tx_hash text NOT NULL,log_index integer,launched_at timestamptz NOT NULL,
        proof jsonb NOT NULL,status text NOT NULL DEFAULT 'authenticated'
      );
      CREATE TABLE IF NOT EXISTS fresh.recent_blocks (
        block_number bigint PRIMARY KEY,block_hash text UNIQUE NOT NULL,parent_hash text NOT NULL,
        occurred_at timestamptz NOT NULL,captured_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS fresh.recent_evidence (
        tx_hash text NOT NULL,block_hash text NOT NULL,block_number bigint NOT NULL,transaction_index integer NOT NULL,
        payload bytea NOT NULL,wallet_addresses text[] NOT NULL DEFAULT '{}',decoder_status text NOT NULL DEFAULT 'pending',decoder_version integer NOT NULL DEFAULT 1,
        last_error text,expires_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY(tx_hash,block_hash)
      );
      ALTER TABLE fresh.recent_evidence ADD COLUMN IF NOT EXISTS position_dependency_addresses text[],
        ADD COLUMN IF NOT EXISTS position_dependency_proof text;
      CREATE INDEX IF NOT EXISTS recent_evidence_decode_idx ON fresh.recent_evidence(block_number,tx_hash) WHERE decoder_status='pending';
      CREATE INDEX IF NOT EXISTS recent_evidence_expiry_idx ON fresh.recent_evidence(expires_at);
      CREATE INDEX IF NOT EXISTS recent_evidence_wallet_pending_idx ON fresh.recent_evidence USING gin(wallet_addresses) WHERE decoder_status<>'done';
      DROP INDEX IF EXISTS fresh.recent_evidence_pending_wallet_idx;
      CREATE INDEX IF NOT EXISTS tokens_recent_idx ON fresh.tokens(last_trade_at DESC NULLS LAST,address);
      CREATE TABLE IF NOT EXISTS fresh.checkpoints (
        key text PRIMARY KEY,block_number bigint,block_hash text,revision bigint NOT NULL DEFAULT 1,
        value jsonb NOT NULL DEFAULT '{}',updated_at timestamptz NOT NULL DEFAULT now()
      ) WITH(fillfactor=80);
      CREATE TABLE IF NOT EXISTS fresh.jobs (
        id text PRIMARY KEY,kind text NOT NULL,reference text NOT NULL,priority integer NOT NULL DEFAULT 0,
        state text NOT NULL DEFAULT 'pending',progress jsonb NOT NULL DEFAULT '{}',due_at timestamptz NOT NULL DEFAULT now(),
        lease_id uuid,lease_until timestamptz,attempts integer NOT NULL DEFAULT 0,last_error text,
        updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(kind,reference)
      ) WITH(fillfactor=80);
      CREATE INDEX IF NOT EXISTS jobs_due_idx ON fresh.jobs(priority DESC,due_at,id) WHERE state='pending';
      INSERT INTO fresh.checkpoints(key,value) VALUES('schema','{"version":1}') ON CONFLICT DO NOTHING;
      ALTER TABLE fresh.kols ADD COLUMN IF NOT EXISTS metrics_updated_at timestamptz;
      ALTER TABLE fresh.kols ADD COLUMN IF NOT EXISTS today_valued_sell_count integer NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS today_unknown_sell_count integer NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS today_valued_transfer_count integer NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS today_unknown_transfer_count integer NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS today_valued_fee_count integer NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS today_unknown_fee_count integer NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS today_fee_only_q text NOT NULL DEFAULT '0',
        ADD COLUMN IF NOT EXISTS today_unallocated_fee_count integer NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS today_unallocated_fee_q text NOT NULL DEFAULT '0',
        ADD COLUMN IF NOT EXISTS today_unallocated_fee_unknown_count integer NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS today_unattributed_fee_count integer NOT NULL DEFAULT 0;
      ALTER TABLE fresh.accounting_scopes ADD COLUMN IF NOT EXISTS unallocated_fee_count bigint NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS unallocated_fee_q text NOT NULL DEFAULT '0',
        ADD COLUMN IF NOT EXISTS unallocated_fee_unknown_count bigint NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS unattributed_fee_count bigint NOT NULL DEFAULT 0;
      ALTER TABLE fresh.financial_events ADD COLUMN IF NOT EXISTS fee_attribution jsonb;
      ALTER TABLE fresh.positions ADD COLUMN IF NOT EXISTS unknown_purchase_value boolean NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS unknown_sale_value boolean NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS unknown_incoming_value boolean NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS unknown_outgoing_value boolean NOT NULL DEFAULT false;
      DO $fresh_unknown_values$ BEGIN IF NOT EXISTS(SELECT 1 FROM fresh.checkpoints WHERE key='schema:unknown_values') THEN
      UPDATE fresh.positions p SET unknown_purchase_value=u.purchases,unknown_sale_value=u.sales,unknown_incoming_value=u.incoming,unknown_outgoing_value=u.outgoing
        FROM(SELECT r.scope_id,r.token_address,bool_or(e.kind='buy' AND e.amount_usd IS NULL) purchases,bool_or(e.kind='sell' AND e.amount_usd IS NULL) sales,
          bool_or(e.kind='transfer_in' AND e.amount_usd IS NULL) incoming,bool_or(e.kind='transfer_out' AND e.amount_usd IS NULL) outgoing
          FROM fresh.scope_event_results r JOIN fresh.financial_events e ON e.id=r.event_id JOIN fresh.accounting_scopes s ON s.id=r.scope_id
          WHERE e.canonical AND e.amount_usd IS NULL AND e.token_address IS NOT NULL
            AND NOT(e.kind IN('transfer_in','transfer_out') AND COALESCE(e.counterparty=ANY(s.wallet_addresses),false)) GROUP BY r.scope_id,r.token_address) u
        WHERE p.scope_id=u.scope_id AND p.token_address=u.token_address
          AND (p.unknown_purchase_value,p.unknown_sale_value,p.unknown_incoming_value,p.unknown_outgoing_value) IS DISTINCT FROM (u.purchases,u.sales,u.incoming,u.outgoing);
      INSERT INTO fresh.checkpoints(key,value) VALUES('schema:unknown_values','{"version":1}'); END IF; END $fresh_unknown_values$;
      CREATE OR REPLACE VIEW public.kols AS SELECT wallet_address AS address,display_name,avatar_url,twitter,source,
        first_seen_at,last_seen_at,profile_checked_at,avatar_checked_at,is_tracked FROM fresh.kols;
      CREATE OR REPLACE VIEW public.tokens AS SELECT * FROM fresh.tokens;
      CREATE OR REPLACE VIEW public.worker_state AS SELECT key,value,updated_at FROM fresh.checkpoints;
      CREATE OR REPLACE VIEW public.trades AS SELECT id,transaction_hash AS tx_hash,wallet_address,token_address,
        kind AS side,quantity AS token_amount,quote_address AS quote_token_address,quote_symbol,quote_amount,
        amount_usd,price_usd,block_number,block_hash,transaction_index,occurred_at AS timestamp,
        'node'::text AS source,observed_live,telegram_notification_processed
        FROM fresh.financial_events WHERE canonical AND kind IN('buy','sell');
      CREATE TABLE IF NOT EXISTS public.watch_sessions (
        id text PRIMARY KEY,secret_hash text UNIQUE NOT NULL,expires_at timestamptz NOT NULL,
        preferences jsonb NOT NULL DEFAULT '{}',created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS public.watch_entries (
        session_id text NOT NULL REFERENCES public.watch_sessions(id) ON DELETE CASCADE,
        kind text NOT NULL CHECK(kind IN('kol','token')),address text NOT NULL,PRIMARY KEY(session_id,kind,address)
      );
    `);
    await client.query(freshRollingSchemaSql);
    const helpers=freshStartupHelperPool(client);
    await ensureAuthSchema(helpers);
    await ensureTelegramBotLoginSchema(helpers);
    await ensureTelegramAvatarSchema(helpers);
    await ensureAccountWatchlistSchema(helpers);
    await ensureCreatorSchema(helpers, true);
    await ensureTelegramNotificationsSchema(helpers, true);
    await client.query(`CREATE TABLE IF NOT EXISTS public.journal_wallets (
    user_id uuid NOT NULL REFERENCES public.auth_users(id) ON DELETE CASCADE,
    wallet_address text NOT NULL REFERENCES fresh.wallets(address),label varchar(60) NOT NULL DEFAULT '',
    added_at timestamptz NOT NULL DEFAULT now(),activity_from timestamptz NOT NULL DEFAULT now(),
    registration_block bigint,registration_hash text,revision uuid NOT NULL,PRIMARY KEY(user_id,wallet_address)
  );CREATE INDEX IF NOT EXISTS journal_wallets_wallet_idx ON public.journal_wallets(wallet_address);`);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}
