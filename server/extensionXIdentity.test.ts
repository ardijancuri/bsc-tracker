import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { xExtensionIdentity } from './extensionXIdentity.js';

const env = { KOLLENS_EXTENSION_X_CLIENT_ID: 'identity-client', KOLLENS_EXTENSION_X_CLIENT_SECRET: 'identity-secret' };
const callback = 'https://kollens.example/api/auth/extension-social/x/callback';
const state = 'example-state';
const verifier = 'a'.repeat(43);
const verified = {
  callbackUrl: new URL(callback + '?state=example-state&code=test-code'),
  state, nonce: '', verifier,
};
const responseToken = { token_type: 'bearer', access_token: 'mock-access-token', scope: 'users.read tweet.read' };

describe('extension X identity', () => {
  it('requires distinct identity credentials and builds an HTTPS PKCE authorization URL', async () => {
    expect(xExtensionIdentity({ X_CLIENT_ID: 'posting-client', X_CLIENT_SECRET: 'posting-secret' })).toBeNull();
    expect(xExtensionIdentity({ ...env, X_CLIENT_ID: env.KOLLENS_EXTENSION_X_CLIENT_ID })).toBeNull();
    const provider = xExtensionIdentity(env)!;
    const url = await provider.authorizationUrl({ callback, state, nonce: '', verifier });
    expect(url.origin + url.pathname).toBe('https://x.com/i/oauth2/authorize');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: 'identity-client', redirect_uri: callback, response_type: 'code',
      scope: 'tweet.read users.read', state, code_challenge_method: 'S256',
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    });
    await expect(provider.authorizationUrl({ callback: callback.replace('https:', 'http:'), state, nonce: '', verifier })).rejects.toThrow();
  });

  it('exchanges the code with the identity client and retains only the verified ID and handle', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(responseToken))
      .mockResolvedValueOnce(Response.json({ data: { id: '12345678901234567890', username: 'KollensTest', name: 'Discarded' } }));
    const provider = xExtensionIdentity(env, fetcher)!;
    await expect(provider.identity(verified)).resolves.toEqual({ subject: '12345678901234567890', username: 'KollensTest' });
    const [token, lookup] = fetcher.mock.calls;
    expect(token[0]).toBe('https://api.x.com/2/oauth2/token');
    expect(token[1]).toMatchObject({
      method: 'POST', redirect: 'error',
      headers: { Authorization: 'Basic ' + Buffer.from('identity-client:identity-secret').toString('base64') },
    });
    expect(Object.fromEntries(token[1]?.body as URLSearchParams)).toEqual({
      code: 'test-code', grant_type: 'authorization_code', redirect_uri: callback, code_verifier: verifier,
    });
    expect(lookup[0]).toBe('https://api.x.com/2/users/me');
    expect(lookup[1]).toMatchObject({ redirect: 'error', headers: { Authorization: 'Bearer mock-access-token' } });
  });

  it('rejects callback tampering without contacting X', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const provider = xExtensionIdentity(env, fetcher)!;
    for (const suffix of ['?state=wrong&code=test', '?state=example-state&state=example-state&code=test', '?state=example-state&code=test&error=access_denied']) {
      await expect(provider.identity({ ...verified, callbackUrl: new URL(callback + suffix) })).rejects.toThrow('Invalid X identity response');
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects unexpected scopes and oversized responses without a user lookup', async () => {
    for (const response of [
      Response.json({ ...responseToken, scope: 'tweet.read users.read tweet.write' }),
      new Response('x'.repeat(32_769)),
    ]) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response);
      const provider = xExtensionIdentity(env, fetcher)!;
      await expect(provider.identity(verified)).rejects.toThrow('X identity could not be verified');
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });
});
