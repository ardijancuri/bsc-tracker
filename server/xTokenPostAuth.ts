import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { Pool } from 'pg';

type Credentials = { accessToken: string; refreshToken: string };
type Encrypted = { version: 1; iv: string; tag: string; data: string };
export function xTokenPostEncryptionKey(value: string | undefined) {
  if (!value || !/^[A-Za-z0-9+/]{43}=$/.test(value)) throw new Error('x_encryption_key_unavailable');
  const key = Buffer.from(value, 'base64');
  if (key.length !== 32) throw new Error('x_encryption_key_unavailable');
  return key;
}
export function encryptXCredentials(value: Credentials, key: Buffer): Encrypted {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from('kollens-x-oauth-v1'));
  const data = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
  return { version: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
}
export function decryptXCredentials(value: Encrypted, key: Buffer): Credentials {
  try {
    if (value.version !== 1) throw new Error();
    const cipher = createDecipheriv('aes-256-gcm', key, Buffer.from(value.iv, 'base64'));
    cipher.setAAD(Buffer.from('kollens-x-oauth-v1')); cipher.setAuthTag(Buffer.from(value.tag, 'base64'));
    const result = JSON.parse(Buffer.concat([cipher.update(Buffer.from(value.data, 'base64')), cipher.final()]).toString());
    if (typeof result.accessToken !== 'string' || !result.accessToken || typeof result.refreshToken !== 'string' || !result.refreshToken) throw new Error();
    return result;
  } catch { throw new Error('x_credentials_unavailable'); }
}

export async function requestXOAuthToken(input: { clientId: string; clientSecret?: string; parameters: Record<string, string>; fetch?: typeof fetch }) {
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' };
  if (input.clientSecret) headers.authorization = `Basic ${Buffer.from(`${input.clientId}:${input.clientSecret}`).toString('base64')}`;
  const body = new URLSearchParams({ ...input.parameters, client_id: input.clientId });
  try {
    const response = await (input.fetch ?? fetch)('https://api.x.com/2/oauth2/token', {
      method: 'POST', headers, body, signal: AbortSignal.timeout(10_000), redirect: 'error',
    });
    if (!response.ok) throw new Error();
    const reader = response.body?.getReader(); if (!reader) throw new Error();
    const chunks: Uint8Array[] = []; let bytes = 0;
    try { for (;;) { const item = await reader.read(); if (item.done) break; bytes += item.value.byteLength;
      if (bytes > 32_768) { await reader.cancel(); throw new Error(); } chunks.push(item.value); } } finally { reader.releaseLock(); }
    const result = JSON.parse(Buffer.concat(chunks).toString());
    if (typeof result.access_token !== 'string' || !result.access_token || typeof result.refresh_token !== 'string' || !result.refresh_token
      || !Number.isFinite(result.expires_in) || result.expires_in <= 0 || result.expires_in > 366 * 86400) throw new Error();
    return { accessToken: result.access_token as string, refreshToken: result.refresh_token as string, expiresIn: Number(result.expires_in) };
  } catch { throw new Error('x_oauth_request_failed'); }
}

export function createXTokenPostCredentials(db: Pool, options: { encryptionKey?: string; clientId?: string; clientSecret?: string; fetch?: typeof fetch; now?: () => number } = {}) {
  const now = options.now ?? Date.now;
  let pending: Promise<string> | null = null;
  const key = () => xTokenPostEncryptionKey(options.encryptionKey ?? process.env.X_TOKEN_POST_ENCRYPTION_KEY);
  async function save(account: { id: string; username: string }, credentials: Credentials & { expiresIn: number }) {
    if (account.username.toLowerCase() !== 'kollens') throw new Error('x_account_mismatch');
    const encrypted = encryptXCredentials(credentials, key()), client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(782347)');
      const settings = (await client.query('SELECT account_id FROM x_token_post_settings WHERE id=1 FOR UPDATE')).rows[0];
      if (settings?.account_id && settings.account_id !== account.id) throw new Error('x_account_mismatch');
      await client.query(`INSERT INTO x_token_post_connections(id,account_id,username,credentials,expires_at) VALUES(1,$1,$2,$3,$4)
        ON CONFLICT(id) DO UPDATE SET account_id=EXCLUDED.account_id,username=EXCLUDED.username,credentials=EXCLUDED.credentials,
        expires_at=EXCLUDED.expires_at,updated_at=now()`, [account.id, account.username.toLowerCase(), encrypted, new Date(now() + credentials.expiresIn * 1000)]);
      await client.query('UPDATE x_token_post_settings SET enabled=false,account_id=$1,updated_at=now() WHERE id=1', [account.id]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }
  async function token(force = false) {
    if (pending) return pending;
    pending = (async () => {
      const client = await db.connect();
      try {
        // Session lock serializes refresh-token rotation. No DB transaction spans HTTP.
        await client.query('SELECT pg_advisory_lock(782347)');
        const row = (await client.query('SELECT credentials,expires_at FROM x_token_post_connections WHERE id=1')).rows[0];
        if (!row) throw new Error('x_credentials_unavailable');
        const credentials = decryptXCredentials(row.credentials, key());
        if (!force && new Date(row.expires_at).getTime() > now() + 60_000) return credentials.accessToken;
        const clientId = options.clientId ?? process.env.X_CLIENT_ID;
        if (!clientId) throw new Error('x_credentials_unavailable');
        const updated = await requestXOAuthToken({ clientId, clientSecret: options.clientSecret ?? process.env.X_CLIENT_SECRET,
          parameters: { grant_type: 'refresh_token', refresh_token: credentials.refreshToken }, fetch: options.fetch });
        await client.query(`UPDATE x_token_post_connections SET credentials=$1,expires_at=$2,updated_at=now() WHERE id=1`,
          [encryptXCredentials(updated, key()), new Date(now() + updated.expiresIn * 1000)]);
        return updated.accessToken;
      } finally { await client.query('SELECT pg_advisory_unlock(782347)').catch(() => undefined); client.release(); }
    })().finally(() => { pending = null; });
    return pending;
  }
  return { save, getAccessToken: () => token(), refreshAccessToken: () => token(true) };
}
