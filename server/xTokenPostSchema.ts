import type { Pool, PoolClient } from 'pg';

export async function ensureXTokenPostSchema(db: Pick<Pool | PoolClient, 'query'>) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS x_token_post_settings (
      id smallint PRIMARY KEY CHECK(id=1), enabled boolean NOT NULL DEFAULT false,
      expected_username text NOT NULL DEFAULT 'kollens', account_id text,
      activated_at timestamptz, last_sent_at timestamptz, last_dispatch_at timestamptz, cooldown_until timestamptz,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    INSERT INTO x_token_post_settings(id) VALUES(1) ON CONFLICT DO NOTHING;
    CREATE TABLE IF NOT EXISTS x_token_post_connections (
      id smallint PRIMARY KEY CHECK(id=1), account_id text NOT NULL, username text NOT NULL,
      credentials jsonb NOT NULL, expires_at timestamptz NOT NULL, updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS x_token_post_jobs (
      id uuid PRIMARY KEY, chain_id integer NOT NULL DEFAULT 56 CHECK(chain_id=56),
      token_address text NOT NULL CHECK(token_address ~ '^0x[0-9a-f]{40}$'),
      account_username text NOT NULL DEFAULT 'kollens',
      status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','preparing','ready','uploading','sending','sent','deferred','cancelled','uncertain','failed')),
      evidence jsonb NOT NULL, narrative jsonb, sources jsonb NOT NULL DEFAULT '[]',
      caption text, image bytea, image_sha256 text, content_started_at timestamptz, media_id text, media_key text, media_expires_at timestamptz,
      lease_id uuid, lease_until timestamptz, dispatch_started_at timestamptz,
      due_at timestamptz NOT NULL DEFAULT now(), first_qualified_at timestamptz NOT NULL DEFAULT now(),
      attempts integer NOT NULL DEFAULT 0, post_id text UNIQUE, sent_at timestamptz,
      last_error text, invalidated_at timestamptz, needs_inspection boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(chain_id,token_address,account_username)
    );
    CREATE INDEX IF NOT EXISTS x_token_posts_due_idx ON x_token_post_jobs(status,due_at,first_qualified_at);
    CREATE INDEX IF NOT EXISTS x_token_posts_sent_idx ON x_token_post_jobs(sent_at) WHERE sent_at IS NOT NULL;
    CREATE TABLE IF NOT EXISTS x_token_post_attempts (
      id uuid PRIMARY KEY, job_id uuid NOT NULL REFERENCES x_token_post_jobs(id),
      stage text NOT NULL, outcome text NOT NULL, category text, started_at timestamptz NOT NULL DEFAULT now(),
      completed_at timestamptz, post_id text, media_id text, caption_sha256 text, image_sha256 text
    );
    CREATE INDEX IF NOT EXISTS x_token_post_attempts_job_idx ON x_token_post_attempts(job_id,started_at);
    CREATE TABLE IF NOT EXISTS x_token_post_sources (
      cache_key text PRIMARY KEY, sources jsonb NOT NULL, checked_at timestamptz NOT NULL,
      expires_at timestamptz NOT NULL
    );
  `);
}

/** Called inside the node's exclusive reorg transaction. Delivery evidence survives. */
export async function rollbackXTokenPosts(db: Pick<Pool | PoolClient, 'query'>, fromBlock: number) {
  await db.query(`UPDATE x_token_post_jobs SET invalidated_at=now(),
    needs_inspection=(status IN ('sent','sending','uncertain') OR dispatch_started_at IS NOT NULL),
    status=CASE WHEN status='sent' THEN 'sent' WHEN status IN ('sending','uncertain') THEN 'uncertain' ELSE 'cancelled' END,
    last_error='chain_reorganization',updated_at=now()
    WHERE (evidence->>'blockNumber')::bigint >= $1 AND invalidated_at IS NULL`, [fromBlock]);
}

/** Fresh reorgs preserve publication evidence even when the publisher is paused.
 * An unconfigured install must not create X tables during blockchain rollback. */
export async function rollbackXTokenPostsIfPresent(db: Pick<Pool | PoolClient, 'query'>, fromBlock: number) {
  const exists=(await db.query("SELECT to_regclass('x_token_post_jobs') IS NOT NULL AS ready")).rows[0]?.ready;
  if(exists)await rollbackXTokenPosts(db,fromBlock);
}
