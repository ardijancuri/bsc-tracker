import sharp from 'sharp';
import type { Pool } from 'pg';
import type { TokenPostEvidence } from '../shared/xTokenPosts.js';
import type { XTokenPostCardInput } from './xTokenPostCard.js';

type Artwork = Pick<XTokenPostCardInput, 'tokenAvatar'>;
const maxImageBytes = 512_000;
const walletPattern = /^0x[0-9a-f]{40}$/;

async function cachedImage(value: unknown): Promise<Buffer | null> {
  if (!Buffer.isBuffer(value) || !value.length || value.length > maxImageBytes) return null;
  try {
    const metadata = await sharp(value, { animated: false, limitInputPixels: 4_000_000, failOn: 'error' }).metadata();
    return ['jpeg', 'png', 'webp'].includes(metadata.format ?? '') && (metadata.pages ?? 1) === 1 ? value : null;
  } catch { return null; }
}

/** Read the existing token artwork cache only. Never resolve or fetch image URLs. */
export async function loadXTokenPostArtwork(db: Pick<Pool, 'query'>, evidence: TokenPostEvidence): Promise<Artwork> {
  const token = evidence.token.address.toLowerCase();
  if (!walletPattern.test(token)) return { tokenAvatar: null };
  try {
    const result = await db.query(`SELECT logo_data FROM ${evidence.version === 2 ? 'fresh.tokens' : 'tokens'} WHERE address=$1
      AND octet_length(logo_data)<=$2`, [token, maxImageBytes]);
    return { tokenAvatar: await cachedImage(result.rows[0]?.logo_data) };
  } catch {
    // Missing or temporarily unavailable artwork must not delay preparation.
    return { tokenAvatar: null };
  }
}
