import { pool } from './db.js';
import roster from './roster.json' with { type: 'json' };
import xAvatars from './x-avatars.json' with { type: 'json' };

const addressPattern = /^0x[a-f0-9]{40}$/;
const twitterPattern = /^[A-Za-z0-9_]{1,15}$/;

export async function ensureSeeds() {
  if (roster.length !== 226 || new Set(roster.map(row => row.address)).size !== roster.length ||
      roster.some(row => !addressPattern.test(row.address) || !row.name || (row.twitter && !twitterPattern.test(row.twitter)))) {
    throw new Error('Invalid KOL roster');
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(712286)');
    await client.query('UPDATE kols SET is_tracked=false WHERE is_tracked=true');
    await client.query(`INSERT INTO kols (address,display_name,twitter,source,is_tracked)
      SELECT address,name,twitter,'gmgn-csv',true FROM jsonb_to_recordset($1::jsonb) AS r(address text,name text,twitter text)
      ON CONFLICT(address) DO UPDATE SET display_name=EXCLUDED.display_name,
        avatar_url=CASE WHEN kols.twitter IS DISTINCT FROM EXCLUDED.twitter THEN NULL ELSE kols.avatar_url END,
        avatar_checked_at=CASE WHEN kols.twitter IS DISTINCT FROM EXCLUDED.twitter THEN NULL ELSE kols.avatar_checked_at END,
        twitter=EXCLUDED.twitter,source=EXCLUDED.source,is_tracked=true`, [JSON.stringify(roster)]);
    for (const [address, profile] of Object.entries(xAvatars)) {
      await client.query(`UPDATE kols SET avatar_url=$2,avatar_checked_at=now()
        WHERE address=$1 AND is_tracked AND twitter=$3 AND avatar_url IS DISTINCT FROM $2`,
      [address, profile.avatar, profile.twitter]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}
