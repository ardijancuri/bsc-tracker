import type { Pool } from 'pg';

/** Independent from roster seeding: a refresh cannot erase a creator's published identity. */
export async function ensureCreatorSchema(db: Pool, fresh = false) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(782330)');
    await client.query(`
      CREATE TABLE IF NOT EXISTS creator_claims (
        wallet_address text PRIMARY KEY REFERENCES ${fresh ? 'fresh.kols(wallet_address)' : 'kols(address)'},
        user_id uuid NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
        claimed_at timestamptz NOT NULL DEFAULT now(),
        proof_chain_id integer NOT NULL CHECK(proof_chain_id=56),
        proof_block_number bigint NOT NULL,
        proof_kind text NOT NULL CHECK(proof_kind IN ('eoa','erc1271'))
      );
      CREATE INDEX IF NOT EXISTS creator_claims_user_idx ON creator_claims(user_id);
      CREATE TABLE IF NOT EXISTS creator_profiles (
        wallet_address text PRIMARY KEY REFERENCES creator_claims(wallet_address) ON DELETE CASCADE,
        display_name text CHECK(char_length(display_name) BETWEEN 1 AND 60),
        bio text CHECK(char_length(bio)<=400), website_url text, x_url text, telegram_url text,
        avatar_data bytea, avatar_hash text,
        updated_at timestamptz NOT NULL DEFAULT now(),
        CHECK ((avatar_data IS NULL)=(avatar_hash IS NULL))
      );
      CREATE TABLE IF NOT EXISTS creator_challenges (
        id uuid PRIMARY KEY,
        user_id uuid NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
        session_hash text NOT NULL, wallet_address text NOT NULL REFERENCES ${fresh ? 'fresh.kols(wallet_address)' : 'kols(address)'},
        origin text NOT NULL, action text NOT NULL CHECK(action IN ('claim','release')),
        chain_id integer NOT NULL CHECK(chain_id=56), message text NOT NULL,
        issued_at timestamptz NOT NULL, expires_at timestamptz NOT NULL, consumed_at timestamptz,
        CHECK(expires_at>issued_at AND expires_at<=issued_at+interval '10 minutes')
      );
      CREATE INDEX IF NOT EXISTS creator_challenges_expiry_idx ON creator_challenges(expires_at);
      CREATE OR REPLACE VIEW published_kols AS
        SELECT k.address,COALESCE(p.display_name,k.display_name) AS display_name,
          CASE WHEN p.avatar_hash IS NOT NULL THEN '/api/kols/' || k.address || '/creator/avatar?v=' || p.avatar_hash
            ELSE k.avatar_url END AS avatar_url,
          CASE WHEN p.x_url IS NOT NULL THEN regexp_replace(p.x_url,'^https://(www\\.)?(x\\.com|twitter\\.com)/','') ELSE k.twitter END AS twitter,
          k.source,k.first_seen_at,k.last_seen_at,k.profile_checked_at,k.avatar_checked_at,k.is_tracked,
          c.wallet_address IS NOT NULL AS creator_claimed,p.bio AS creator_bio,
          p.website_url AS creator_website_url,p.x_url AS creator_x_url,p.telegram_url AS creator_telegram_url,
          p.updated_at AS creator_updated_at
        FROM kols k LEFT JOIN creator_claims c ON c.wallet_address=k.address
        LEFT JOIN creator_profiles p ON p.wallet_address=c.wallet_address;
    `);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
