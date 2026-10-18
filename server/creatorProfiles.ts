import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { getAddress, hashMessage, Interface, verifyMessage } from 'ethers';
import sharp from 'sharp';
import type { Pool } from 'pg';
import { pool } from './db.js';
import { chainRpc, type Rpc } from './rpc.js';
import { creatorAvatarMaxBytes, creatorChainId, creatorChallengeLifetimeMs,
  type CreatorChallenge, type CreatorErrorCode, type CreatorProfilePatch, type CreatorStatus } from '../shared/creatorProfiles.js';

const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const signatureInterface = new Interface(['function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)']);
export class CreatorInputError extends Error {
  constructor(public code: CreatorErrorCode, message: string, public status = 400) { super(message); this.name = 'CreatorInputError'; }
}
export function creatorWallet(value: unknown): string {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(value)) throw new CreatorInputError('invalid_input', 'Enter a valid BNB wallet address');
  return value.toLowerCase();
}
export function creatorOrigin(value: string): string {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash
      || (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error();
    return url.origin;
  } catch { throw new CreatorInputError('wrong_origin', 'Request origin rejected', 403); }
}
function text(value: unknown, max: number, field: string) {
  if (value === null || value === '') return null;
  if (typeof value !== 'string' || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
    || (field === 'Display name' && /[\t\r\n]/.test(value)) || [...value].length > max) {
    throw new CreatorInputError('invalid_input', `${field} must be at most ${max} characters`);
  }
  return value.trim() || null;
}
function link(value: unknown, field: string, hosts?: string[]) {
  if (value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > 2048 || /[\u0000-\u0020\u007f]/.test(value)) throw new CreatorInputError('invalid_input', `${field} must be an HTTPS link`);
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || (hosts && !hosts.includes(url.hostname.toLowerCase()))) throw new Error();
    if (hosts && (!/^\/[A-Za-z0-9_]{1,64}\/?$/.test(url.pathname) || url.search || url.hash)) throw new Error();
    return url.href;
  } catch { throw new CreatorInputError('invalid_input', `${field} must be a valid HTTPS link`); }
}
export function normalizeCreatorPatch(input: unknown): CreatorProfilePatch {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new CreatorInputError('invalid_input', 'Invalid creator profile');
  const value = input as Record<string, unknown>;
  const allowed = ['displayName', 'bio', 'websiteUrl', 'xUrl', 'telegramUrl'];
  if (Object.keys(value).some(key => !allowed.includes(key)) || !Object.keys(value).length) throw new CreatorInputError('invalid_input', 'Invalid creator profile fields');
  const result: CreatorProfilePatch = {};
  if ('displayName' in value) result.displayName = text(value.displayName, 60, 'Display name');
  if ('bio' in value) result.bio = text(value.bio, 400, 'Bio');
  if ('websiteUrl' in value) result.websiteUrl = link(value.websiteUrl, 'Website');
  if ('xUrl' in value) result.xUrl = link(value.xUrl, 'X', ['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com']);
  if ('telegramUrl' in value) result.telegramUrl = link(value.telegramUrl, 'Telegram', ['t.me', 'www.t.me']);
  return result;
}
/** Decode and re-encode pixels only, stripping source metadata and rejecting animated media. */
export async function normalizeCreatorAvatar(input: unknown): Promise<Buffer> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new CreatorInputError('invalid_input', 'Choose a JPEG, PNG or WebP image');
  const { mime, data } = input as Record<string, unknown>;
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(String(mime)) || typeof data !== 'string'
    || data.length > Math.ceil(creatorAvatarMaxBytes / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) {
    throw new CreatorInputError('invalid_input', 'Choose a static JPEG, PNG or WebP image up to 2 MB');
  }
  const bytes = Buffer.from(data, 'base64');
  if (!bytes.length || bytes.length > creatorAvatarMaxBytes || bytes.toString('base64') !== data) throw new CreatorInputError('invalid_input', 'Choose an image up to 2 MB');
  try {
    const source = sharp(bytes, { animated: true, limitInputPixels: 32_000_000, failOn: 'warning' });
    const metadata = await source.metadata();
    const expected = mime === 'image/jpeg' ? 'jpeg' : mime === 'image/png' ? 'png' : 'webp';
    if (metadata.format !== expected || !metadata.width || !metadata.height || (metadata.pages ?? 1) > 1) throw new Error();
    return await source.rotate().resize(512, 512, { fit: 'cover' }).webp({ quality: 85 }).toBuffer();
  } catch { throw new CreatorInputError('invalid_input', 'Choose a valid static JPEG, PNG or WebP image'); }
}
export function createCreatorChallenge(input: { wallet: string; origin: string; action: 'claim' | 'release'; now?: number }): CreatorChallenge {
  const wallet = creatorWallet(input.wallet), origin = creatorOrigin(input.origin);
  const challengeId = randomUUID(), issuedAt = new Date(input.now ?? Date.now()).toISOString();
  const expiresAt = new Date(Date.parse(issuedAt) + creatorChallengeLifetimeMs).toISOString();
  const message = `${new URL(origin).host} wants you to sign in with your Ethereum account:\n${getAddress(wallet)}\n\n${input.action === 'claim' ? 'Claim your Kollens creator profile.' : 'Release your Kollens creator profile.'}\n\nURI: ${origin}/kol/${wallet}\nVersion: 1\nChain ID: ${creatorChainId}\nNonce: ${randomBytes(16).toString('hex')}\nIssued At: ${issuedAt}\nExpiration Time: ${expiresAt}\nResources:\n- urn:kollens:creator:${input.action}:${challengeId}`;
  return { challengeId, message, walletAddress: wallet, chainId: creatorChainId, expiresAt, action: input.action };
}
/** ERC-1271 is evaluated on BSC at a six-confirmation checkpoint, not an untrusted wallet RPC. */
export async function verifyCreatorSignature(wallet: string, message: string, signature: string, rpc: Rpc = chainRpc) {
  if (!/^0x(?:[0-9a-fA-F]{2}){1,8192}$/.test(signature)) throw new CreatorInputError('signature_invalid', 'The wallet signature is invalid');
  let block: bigint, code: string;
  try {
    const chain = await rpc<string>('eth_chainId', []);
    if (BigInt(chain) !== 56n) throw new Error();
    const head = BigInt(await rpc<string>('eth_blockNumber', []));
    block = head > 6n ? head - 6n : 0n;
    code = await rpc<string>('eth_getCode', [wallet, `0x${block.toString(16)}`]);
    if (!/^0x(?:[a-fA-F0-9]{2})*$/.test(code)) throw new Error();
  } catch { throw new CreatorInputError('node_unavailable', 'Wallet verification is temporarily unavailable. Try again shortly.', 503); }
  if (code === '0x') {
    try { if (verifyMessage(message, signature).toLowerCase() === wallet.toLowerCase()) return { kind: 'eoa' as const, blockNumber: block.toString() }; } catch { /* A malformed EOA signature is not a contract proof. */ }
    throw new CreatorInputError('signature_invalid', 'The signature does not match this wallet');
  }
  try {
    const result = await rpc<string>('eth_call', [{ to: wallet, data: signatureInterface.encodeFunctionData('isValidSignature', [hashMessage(message), signature]) }, `0x${block.toString(16)}`]);
    if (signatureInterface.decodeFunctionResult('isValidSignature', result)[0] === '0x1626ba7e') return { kind: 'erc1271' as const, blockNumber: block.toString() };
  } catch { throw new CreatorInputError('wallet_unsupported', 'This smart wallet does not support the required ERC-1271 signature verification', 422); }
  throw new CreatorInputError('signature_invalid', 'The smart wallet rejected this signature');
}
const profileSelect = `SELECT k.address AS "walletAddress",c.wallet_address IS NOT NULL AS claimed,
  c.wallet_address IS NOT NULL AS "walletControlVerified",p.display_name AS "displayName",
  CASE WHEN p.avatar_hash IS NOT NULL THEN '/api/kols/'||k.address||'/creator/avatar?v='||p.avatar_hash END AS "avatarUrl",
  p.bio,p.website_url AS "websiteUrl",p.x_url AS "xUrl",p.telegram_url AS "telegramUrl",p.updated_at AS "updatedAt",
  COALESCE(c.user_id=$2::uuid,false) AS "canEdit" FROM kols k
  LEFT JOIN creator_claims c ON c.wallet_address=k.address LEFT JOIN creator_profiles p ON p.wallet_address=c.wallet_address
  WHERE k.address=$1 AND k.is_tracked`;
export function createCreatorService(db: Pool = pool, rpc: Rpc = chainRpc) {
  async function status(wallet: string, userId: string | null): Promise<CreatorStatus> {
    const row = (await db.query(profileSelect, [wallet, userId])).rows[0];
    if (!row) throw new CreatorInputError('not_tracked', 'Only tracked KOLs can claim a creator profile', 404);
    return { ...row, updatedAt: row.updatedAt ? new Date(row.updatedAt).toISOString() : null };
  }
  async function owner(wallet: string, userId: string) {
    const value = await status(wallet, userId);
    if (!value.canEdit) throw new CreatorInputError('not_owner', 'Only the creator profile owner can edit this profile', 403);
    return value;
  }
  async function challenge(wallet: string, userId: string, sessionHash: string, origin: string, action: 'claim' | 'release') {
    const value = await status(wallet, userId);
    if (action === 'release' && !value.canEdit) throw new CreatorInputError('not_owner', 'Only the owner can release this profile', 403);
    if (action === 'claim' && value.claimed) throw new CreatorInputError('already_claimed', 'This KOL profile is already claimed', 409);
    const proof = createCreatorChallenge({ wallet, origin, action });
    await db.query(`DELETE FROM creator_challenges WHERE expires_at<now()-interval '1 day'`);
    await db.query(`INSERT INTO creator_challenges(id,user_id,session_hash,wallet_address,origin,action,chain_id,message,issued_at,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,56,$7,$8,$9)`, [proof.challengeId, userId, sessionHash, wallet, origin, action, proof.message,
      new Date(Date.parse(proof.expiresAt) - creatorChallengeLifetimeMs), proof.expiresAt]);
    return proof;
  }
  async function prove(input: { wallet: string; userId: string; sessionHash: string; origin: string; action: 'claim' | 'release'; challengeId: unknown; signature: unknown }) {
    if (typeof input.challengeId !== 'string' || !/^[0-9a-f-]{36}$/i.test(input.challengeId) || typeof input.signature !== 'string') throw new CreatorInputError('invalid_input', 'Invalid wallet proof');
    const values = [input.challengeId, input.userId, input.sessionHash, input.wallet, input.origin, input.action];
    const row = (await db.query(`SELECT message FROM creator_challenges WHERE id=$1 AND user_id=$2 AND session_hash=$3
      AND wallet_address=$4 AND origin=$5 AND action=$6 AND chain_id=56 AND consumed_at IS NULL AND expires_at>now()`, values)).rows[0];
    if (!row) throw new CreatorInputError('challenge_invalid', 'This wallet challenge expired or was already used. Start again.', 409);
    const verification = await verifyCreatorSignature(input.wallet, row.message, input.signature, rpc);
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      // A new login/logout, concurrent claim or second proof cannot reuse this challenge.
      const consumed = await client.query(`UPDATE creator_challenges SET consumed_at=now() WHERE id=$1 AND user_id=$2 AND session_hash=$3
        AND wallet_address=$4 AND origin=$5 AND action=$6 AND chain_id=56 AND consumed_at IS NULL AND expires_at>now()
        AND EXISTS(SELECT 1 FROM auth_sessions s WHERE s.user_id=$2 AND s.secret_hash=$3 AND s.expires_at>now()) RETURNING id`, values);
      if (!consumed.rowCount) throw new CreatorInputError('challenge_invalid', 'This wallet challenge expired or was already used. Start again.', 409);
      const tracked = await client.query('SELECT address FROM kols WHERE address=$1 AND is_tracked FOR SHARE', [input.wallet]);
      if (!tracked.rowCount) throw new CreatorInputError('not_tracked', 'This KOL is no longer tracked', 404);
      if (input.action === 'claim') {
        const inserted = await client.query(`INSERT INTO creator_claims(wallet_address,user_id,proof_chain_id,proof_block_number,proof_kind)
          VALUES($1,$2,56,$3,$4) ON CONFLICT(wallet_address) DO NOTHING RETURNING wallet_address`, [input.wallet, input.userId, verification.blockNumber, verification.kind]);
        if (!inserted.rowCount) throw new CreatorInputError('already_claimed', 'This KOL profile is already claimed', 409);
        await client.query('INSERT INTO creator_profiles(wallet_address) VALUES($1)', [input.wallet]);
      } else {
        const removed = await client.query('DELETE FROM creator_claims WHERE wallet_address=$1 AND user_id=$2 RETURNING wallet_address', [input.wallet, input.userId]);
        if (!removed.rowCount) throw new CreatorInputError('not_owner', 'Only the owner can release this profile', 403);
      }
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
    return status(input.wallet, input.userId);
  }
  async function update(wallet: string, userId: string, input: unknown) {
    const patch = normalizeCreatorPatch(input);
    const columns: Record<string, string> = { displayName: 'display_name', bio: 'bio', websiteUrl: 'website_url', xUrl: 'x_url', telegramUrl: 'telegram_url' };
    const entries = Object.entries(patch);
    const changed = await db.query(`UPDATE creator_profiles p SET ${entries.map(([key], index) => `${columns[key]}=$${index + 3}`).join(',')},updated_at=now()
      FROM creator_claims c WHERE p.wallet_address=$1 AND c.wallet_address=p.wallet_address AND c.user_id=$2 RETURNING p.wallet_address`, [wallet, userId, ...entries.map(([, value]) => value)]);
    if (!changed.rowCount) { await owner(wallet, userId); throw new CreatorInputError('not_owner', 'The creator profile changed. Refresh and try again.', 409); }
    await db.query(`SELECT pg_notify('bscan_update','update')`);
    return status(wallet, userId);
  }
  async function avatar(wallet: string, userId: string, input: unknown) {
    await owner(wallet, userId);
    const bytes = await normalizeCreatorAvatar(input);
    const changed = await db.query(`UPDATE creator_profiles p SET avatar_data=$3,avatar_hash=$4,updated_at=now()
      FROM creator_claims c WHERE p.wallet_address=$1 AND c.wallet_address=p.wallet_address AND c.user_id=$2 RETURNING p.wallet_address`, [wallet, userId, bytes, digest(bytes)]);
    if (!changed.rowCount) throw new CreatorInputError('not_owner', 'The creator profile changed. Refresh and try again.', 409);
    await db.query(`SELECT pg_notify('bscan_update','update')`);
    return status(wallet, userId);
  }
  return { status, owner, challenge, prove, update, avatar,
    async mine(userId: string) {
      const result = await db.query(`SELECT c.wallet_address FROM creator_claims c JOIN kols k ON k.address=c.wallet_address
        WHERE c.user_id=$1 AND k.is_tracked ORDER BY c.claimed_at DESC`, [userId]);
      return Promise.all(result.rows.map(row => status(row.wallet_address, userId)));
    },
    async image(wallet: string) {
      const result = await db.query(`SELECT p.avatar_data AS data,p.avatar_hash AS hash FROM creator_profiles p
        JOIN kols k ON k.address=p.wallet_address WHERE p.wallet_address=$1 AND k.is_tracked`, [wallet]);
      return result.rows[0] as { data: Buffer; hash: string } | undefined;
    },
  };
}
export const creatorSessionHash = (session: string) => digest(session);
