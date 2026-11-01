import { randomBytes } from 'node:crypto';
import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { createXTokenPostCredentials, decryptXCredentials, encryptXCredentials, requestXOAuthToken, xTokenPostEncryptionKey } from './xTokenPostAuth.js';

const NOW = Date.parse('2026-10-20T15:00:00Z');
const KEY = randomBytes(32), ENCODED = KEY.toString('base64');
const ORIGINAL = { accessToken: 'private-access-token', refreshToken: 'private-refresh-token' };
const REFRESHED = { accessToken: 'rotated-access-token', refreshToken: 'rotated-refresh-token' };
type Row = { credentials: ReturnType<typeof encryptXCredentials>; expires_at: Date };

/** Session-lock fake supports separate credential service instances sharing one database. */
function fakeDatabase(initial?: Row, initialSettings = { account_id: null as string | null, enabled: false }) {
  let row = initial ?? null, locked = false, settings = { ...initialSettings };
  const waiters: (() => void)[] = [];
  const queries: { sql: string; values?: unknown[] }[] = [];
  let released = 0;
  async function execute(sql: string, values?: unknown[]) {
    queries.push({ sql, values });
    if (/^SELECT account_id FROM x_token_post_settings/.test(sql)) return { rows: [{ ...settings }], rowCount: 1 };
    if (/^UPDATE x_token_post_settings SET enabled=false/.test(sql)) { settings = { account_id: values![0] as string, enabled: false }; return { rows: [], rowCount: 1 }; }
    if (/^SELECT credentials,expires_at/.test(sql)) return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    if (/^UPDATE x_token_post_connections/.test(sql)) { row = { credentials: values![0] as Row['credentials'], expires_at: values![1] as Date }; return { rows: [], rowCount: 1 }; }
    if (/^INSERT INTO x_token_post_connections/.test(sql)) { row = { credentials: values![2] as Row['credentials'], expires_at: values![3] as Date }; return { rows: [], rowCount: 1 }; }
    throw new Error(`Unexpected database query: ${sql}`);
  }
  const db = {
    query: execute,
    async connect() {
      let owns = false, transactionOwns = false;
      let previous: { row: Row | null; settings: typeof settings } | null = null;
      const releaseLock = () => { if (owns) { owns = false; transactionOwns = false; const next = waiters.shift(); if (next) next(); else locked = false; } };
      return {
        async query(sql: string, values?: unknown[]) {
          if (sql === 'BEGIN') { queries.push({ sql }); previous = { row, settings: { ...settings } }; return { rows: [], rowCount: 0 }; }
          if (sql === 'COMMIT') { queries.push({ sql }); previous = null; if (transactionOwns) releaseLock(); return { rows: [], rowCount: 0 }; }
          if (sql === 'ROLLBACK') { queries.push({ sql }); if (previous) { row = previous.row; settings = previous.settings; previous = null; } if (transactionOwns) releaseLock(); return { rows: [], rowCount: 0 }; }
          if (sql === 'SELECT pg_advisory_lock(782347)' || sql === 'SELECT pg_advisory_xact_lock(782347)') {
            queries.push({ sql });
            if (locked) await new Promise<void>(resolve => waiters.push(resolve));
            locked = true; owns = true;
            if (sql.includes('xact')) { transactionOwns = true; previous = { row, settings: { ...settings } }; }
            return { rows: [], rowCount: 0 };
          }
          if (sql === 'SELECT pg_advisory_unlock(782347)') {
            queries.push({ sql });
            releaseLock();
            return { rows: [], rowCount: 0 };
          }
          return execute(sql, values);
        },
        release() { released++; },
      };
    },
  };
  return { db: db as unknown as Pool, queries, row: () => row, settings: () => settings, releases: () => released, locked: () => locked };
}
const expired = (): Row => ({ credentials: encryptXCredentials(ORIGINAL, KEY), expires_at: new Date(NOW - 1000) });
const success = () => new Response(JSON.stringify({ access_token: REFRESHED.accessToken, refresh_token: REFRESHED.refreshToken, expires_in: 7200 }));

describe('X credential encryption', () => {
  it('requires a configured 32-byte base64 encryption key', () => {
    expect(xTokenPostEncryptionKey(ENCODED)).toEqual(KEY);
    for (const bad of [undefined, '', 'do-not-print-a-secret', randomBytes(31).toString('base64'), randomBytes(33).toString('base64'), KEY.toString('hex')]) expect(() => xTokenPostEncryptionKey(bad)).toThrow('x_encryption_key_unavailable');
  });
  it('stores no plaintext and uses a new authenticated nonce for each encryption', () => {
    const a = encryptXCredentials(ORIGINAL, KEY), b = encryptXCredentials(ORIGINAL, KEY);
    expect(decryptXCredentials(a, KEY)).toEqual(ORIGINAL);
    expect(a.version).toBe(1);
    expect(Buffer.from(a.iv, 'base64')).toHaveLength(12);
    expect(Buffer.from(a.tag, 'base64')).toHaveLength(16);
    expect(a.iv).not.toBe(b.iv);
    expect(a.data).not.toBe(b.data);
    expect(JSON.stringify(a)).not.toContain(ORIGINAL.accessToken);
    expect(JSON.stringify(a)).not.toContain(ORIGINAL.refreshToken);
  });
  it('rejects wrong keys, tampering, unknown versions and invalid decrypted shapes with safe errors', () => {
    const encrypted = encryptXCredentials(ORIGINAL, KEY);
    const tampered = (key: 'data' | 'iv' | 'tag') => ({ ...encrypted, [key]: Buffer.from('tampered contents').toString('base64') });
    for (const value of [tampered('data'), tampered('iv'), tampered('tag'), { ...encrypted, version: 2 } as unknown as typeof encrypted]) expect(() => decryptXCredentials(value, KEY)).toThrow('x_credentials_unavailable');
    expect(() => decryptXCredentials(encrypted, randomBytes(32))).toThrow('x_credentials_unavailable');
    expect(() => decryptXCredentials(encryptXCredentials({ accessToken: '', refreshToken: 'x' }, KEY), KEY)).toThrow('x_credentials_unavailable');
  });
});

describe('bounded X OAuth token exchange', () => {
  it('sends only to the official endpoint with a bounded URL-encoded request', async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, _options?: RequestInit) => success());
    const result = await requestXOAuthToken({ clientId: 'client-id', clientSecret: 'client-secret', parameters: { grant_type: 'authorization_code', code: 'test-code', code_verifier: 'test-verifier' }, fetch });
    expect(result).toEqual({ ...REFRESHED, expiresIn: 7200 });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, options] = fetch.mock.calls[0];
    expect(url).toBe('https://api.x.com/2/oauth2/token');
    expect(options).toMatchObject({ method: 'POST', redirect: 'error', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    expect(options?.signal).toBeInstanceOf(AbortSignal);
    expect(new URLSearchParams(String(options?.body)).get('client_id')).toBe('client-id');
    expect(new URLSearchParams(String(options?.body)).get('code_verifier')).toBe('test-verifier');
  });
  it('uses public-client PKCE without a client secret', async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, _options?: RequestInit) => success());
    await requestXOAuthToken({ clientId: 'public-client', parameters: { grant_type: 'authorization_code', code: 'c', code_verifier: 'v' }, fetch });
    expect(fetch.mock.calls[0][1]?.headers).not.toHaveProperty('authorization');
  });
  it('never leaks provider errors or credentials, retries, or follows redirects', async () => {
    const providers = [async () => new Response('private-refresh-token debug payload', { status: 403 }), async () => { throw new Error('private-refresh-token network details'); }, async () => new Response('{badjson'), async () => new Response('x'.repeat(32_769)), async () => new Response(JSON.stringify({ access_token: 'a', refresh_token: 'r', expires_in: 0 })), async () => new Response(JSON.stringify({ access_token: 'a', expires_in: 3600 }))];
    for (const provider of providers) {
      const fetch = vi.fn(provider);
      await expect(requestXOAuthToken({ clientId: 'id', parameters: { refresh_token: ORIGINAL.refreshToken }, fetch })).rejects.toThrow(/^x_oauth_request_failed$/);
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  });
});

describe('durable rotating X credentials', () => {
  it('verifies @kollens before saving and never puts plaintext into database parameters', async () => {
    const database = fakeDatabase();
    const service = createXTokenPostCredentials(database.db, { encryptionKey: ENCODED, now: () => NOW });
    await expect(service.save({ id: '1', username: 'somebodyelse' }, { ...ORIGINAL, expiresIn: 3600 })).rejects.toThrow('x_account_mismatch');
    expect(database.queries).toHaveLength(0);
    await service.save({ id: '1', username: 'Kollens' }, { ...ORIGINAL, expiresIn: 3600 });
    expect(decryptXCredentials(database.row()!.credentials, KEY)).toMatchObject(ORIGINAL);
    expect(database.row()!.expires_at.getTime()).toBe(NOW + 3600_000);
    expect(JSON.stringify(database.queries)).not.toContain(ORIGINAL.accessToken);
    expect(JSON.stringify(database.queries)).not.toContain(ORIGINAL.refreshToken);
    expect(database.settings()).toEqual({ account_id: '1', enabled: false });
    expect(database.queries[0].sql).toBe('BEGIN');
    expect(database.queries.at(-1)?.sql).toBe('COMMIT');
    expect(database.releases()).toBe(1);
  });
  it('pauses publishing after reconnecting the same stable account, without logging plaintext credentials', async () => {
    const database = fakeDatabase(expired(), { account_id: '1', enabled: true });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {}), warn = vi.spyOn(console, 'warn').mockImplementation(() => {}), error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const service = createXTokenPostCredentials(database.db, { encryptionKey: ENCODED, now: () => NOW });
      await service.save({ id: '1', username: 'kollens' }, { ...REFRESHED, expiresIn: 7200 });
      expect(database.settings()).toEqual({ account_id: '1', enabled: false });
      expect(decryptXCredentials(database.row()!.credentials, KEY)).toMatchObject(REFRESHED);
      expect(database.queries.some(item => /SELECT account_id.*FOR UPDATE/.test(item.sql))).toBe(true);
      expect(log).not.toHaveBeenCalled(); expect(warn).not.toHaveBeenCalled(); expect(error).not.toHaveBeenCalled();
      expect(JSON.stringify(database.queries)).not.toContain(REFRESHED.accessToken);
      expect(JSON.stringify(database.queries)).not.toContain(REFRESHED.refreshToken);
    } finally { log.mockRestore(); warn.mockRestore(); error.mockRestore(); }
  });
  it('rejects a changed stable account ID even when its username is @kollens', async () => {
    const before = expired(), database = fakeDatabase(before, { account_id: 'original-account', enabled: true });
    const service = createXTokenPostCredentials(database.db, { encryptionKey: ENCODED, now: () => NOW });
    await expect(service.save({ id: 'replacement-account', username: 'kollens' }, { ...REFRESHED, expiresIn: 7200 })).rejects.toThrow('x_account_mismatch');
    expect(database.row()).toEqual(before);
    expect(database.settings()).toEqual({ account_id: 'original-account', enabled: true });
    expect(database.queries.some(item => /INSERT INTO x_token_post_connections/.test(item.sql))).toBe(false);
    expect(database.queries.at(-1)?.sql).toBe('ROLLBACK');
    expect(database.releases()).toBe(1);
  });
  it('uses a still-valid token without a network request or a transaction spanning HTTP', async () => {
    const database = fakeDatabase({ credentials: encryptXCredentials(ORIGINAL, KEY), expires_at: new Date(NOW + 120_000) }), fetch = vi.fn();
    const service = createXTokenPostCredentials(database.db, { encryptionKey: ENCODED, fetch, now: () => NOW });
    expect(await service.getAccessToken()).toBe(ORIGINAL.accessToken);
    expect(fetch).not.toHaveBeenCalled();
    expect(database.queries.some(item => /BEGIN|COMMIT/.test(item.sql))).toBe(false);
    expect(database.releases()).toBe(1); expect(database.locked()).toBe(false);
  });
  it('coalesces concurrent same-process refreshes and persists only encrypted rotated credentials', async () => {
    const database = fakeDatabase(expired());
    const fetch = vi.fn(async (_url: string | URL | Request, _options?: RequestInit) => success());
    const service = createXTokenPostCredentials(database.db, { encryptionKey: ENCODED, clientId: 'id', fetch, now: () => NOW });
    expect(await Promise.all(Array.from({ length: 8 }, () => service.getAccessToken()))).toEqual(Array(8).fill(REFRESHED.accessToken));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(decryptXCredentials(database.row()!.credentials, KEY)).toMatchObject(REFRESHED);
    expect(new URLSearchParams(String(fetch.mock.calls[0][1]?.body)).get('refresh_token')).toBe(ORIGINAL.refreshToken);
    expect(JSON.stringify(database.queries)).not.toContain(REFRESHED.accessToken);
    expect(JSON.stringify(database.queries)).not.toContain(REFRESHED.refreshToken);
    expect(database.releases()).toBe(1); expect(database.locked()).toBe(false);
  });
  it('serializes refresh-token rotation between separate service instances', async () => {
    const database = fakeDatabase(expired()), fetch = vi.fn(async () => success());
    const options = { encryptionKey: ENCODED, clientId: 'id', fetch, now: () => NOW };
    const a = createXTokenPostCredentials(database.db, options), b = createXTokenPostCredentials(database.db, options);
    expect(await Promise.all([a.getAccessToken(), b.getAccessToken()])).toEqual([REFRESHED.accessToken, REFRESHED.accessToken]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(database.releases()).toBe(2); expect(database.locked()).toBe(false);
  });
  it('serializes reconnect behind an active refresh so the fresh connection is not overwritten', async () => {
    const database = fakeDatabase(expired(), { account_id: '1', enabled: true });
    let announce: () => void = () => {}, finish: () => void = () => {};
    const started = new Promise<void>(resolve => { announce = resolve; }), continueRefresh = new Promise<void>(resolve => { finish = resolve; });
    const fetch = vi.fn(async () => { announce(); await continueRefresh; return success(); });
    const options = { encryptionKey: ENCODED, clientId: 'id', fetch, now: () => NOW };
    const refreshService = createXTokenPostCredentials(database.db, options), reconnectService = createXTokenPostCredentials(database.db, options);
    const refresh = refreshService.getAccessToken();
    await started;
    const reconnect = reconnectService.save({ id: '1', username: 'kollens' }, { accessToken: 'new-connection-access', refreshToken: 'new-connection-refresh', expiresIn: 7200 });
    finish();
    await Promise.all([refresh, reconnect]);
    expect(decryptXCredentials(database.row()!.credentials, KEY)).toMatchObject({ accessToken: 'new-connection-access', refreshToken: 'new-connection-refresh' });
    expect(database.settings()).toEqual({ account_id: '1', enabled: false });
    expect(database.queries.some(item => item.sql === 'SELECT pg_advisory_xact_lock(782347)')).toBe(true);
    expect(database.locked()).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('supports an explicit authentication refresh and returns the saved rotated token afterward', async () => {
    const database = fakeDatabase({ credentials: encryptXCredentials(ORIGINAL, KEY), expires_at: new Date(NOW + 3600_000) }), fetch = vi.fn(async () => success());
    const service = createXTokenPostCredentials(database.db, { encryptionKey: ENCODED, clientId: 'id', fetch, now: () => NOW });
    expect(await service.refreshAccessToken()).toBe(REFRESHED.accessToken);
    expect(await service.getAccessToken()).toBe(REFRESHED.accessToken);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('preserves saved credentials and releases its lock after a refresh failure', async () => {
    const before = expired(), database = fakeDatabase(before), fetch = vi.fn(async () => new Response('secret-provider-details', { status: 429 }));
    const service = createXTokenPostCredentials(database.db, { encryptionKey: ENCODED, clientId: 'id', fetch, now: () => NOW });
    await expect(service.getAccessToken()).rejects.toThrow('x_oauth_request_failed');
    expect(database.row()).toEqual(before);
    expect(database.locked()).toBe(false); expect(database.releases()).toBe(1);
    expect(database.queries.some(item => /^UPDATE/.test(item.sql))).toBe(false);
  });
  it('fails safely with no connection or an unavailable encryption key, without outbound work', async () => {
    const fetch = vi.fn();
    const noConnection = fakeDatabase();
    await expect(createXTokenPostCredentials(noConnection.db, { encryptionKey: ENCODED, fetch }).getAccessToken()).rejects.toThrow('x_credentials_unavailable');
    const database = fakeDatabase(expired());
    await expect(createXTokenPostCredentials(database.db, { encryptionKey: '', fetch }).getAccessToken()).rejects.toThrow('x_encryption_key_unavailable');
    await expect(createXTokenPostCredentials(database.db, { encryptionKey: '' }).save({ id: '1', username: 'kollens' }, { ...ORIGINAL, expiresIn: 100 })).rejects.toThrow('x_encryption_key_unavailable');
    expect(fetch).not.toHaveBeenCalled();
    expect(database.locked()).toBe(false);
  });
});
