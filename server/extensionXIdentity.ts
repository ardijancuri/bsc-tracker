import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ExtensionSocialProvider } from './extensionSocial.js';

const callbackPath = '/api/auth/extension-social/x/callback';
const scope = 'tweet.read users.read';
const oauthCode = /^[\x21-\x7e]{1,2048}$/;
const pkceVerifier = /^[A-Za-z0-9._~-]{43,128}$/;
const tokenSchema = z.object({
  access_token: z.string().regex(/^[A-Za-z0-9._~+\/-]+={0,2}$/).max(4096),
  token_type: z.string().refine(value => value.toLowerCase() === 'bearer'),
  scope: z.string().optional(),
});
const userSchema = z.object({
  data: z.object({
    id: z.string().regex(/^[1-9]\d{0,19}$/),
    username: z.string().regex(/^[A-Za-z0-9_]{1,15}$/).optional(),
  }),
});

function checkedCallback(value: string | URL) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.pathname !== callbackPath || url.username || url.password || url.hash) {
    throw new Error('Invalid X identity callback');
  }
  return url;
}

async function readJson(fetcher: typeof fetch, url: string, init: RequestInit) {
  const response = await fetcher(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(10_000) });
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new Error('X identity request failed');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('X identity response unavailable');
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 32_768) {
        await reader.cancel();
        throw new Error('X identity response too large');
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks, bytes).toString('utf8')) as unknown;
}

export function xExtensionIdentity(
  env: NodeJS.ProcessEnv = process.env,
  fetcher: typeof fetch = fetch,
): ExtensionSocialProvider | null {
  const clientId = env.KOLLENS_EXTENSION_X_CLIENT_ID?.trim();
  const clientSecret = env.KOLLENS_EXTENSION_X_CLIENT_SECRET?.trim();
  if (!clientId || !/^[A-Za-z0-9._~-]{1,256}$/.test(clientId) || clientId === env.X_CLIENT_ID?.trim()
    || !clientSecret || !/^[\x21-\x7e]{1,512}$/.test(clientSecret)) return null;

  return {
    async authorizationUrl({ callback, state, verifier }) {
      const redirect = checkedCallback(callback);
      if (redirect.search || !pkceVerifier.test(verifier)) throw new Error('Invalid X identity request');
      const url = new URL('https://x.com/i/oauth2/authorize');
      url.search = new URLSearchParams({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: redirect.href,
        scope,
        state,
        code_challenge: createHash('sha256').update(verifier).digest('base64url'),
        code_challenge_method: 'S256',
      }).toString();
      return url;
    },
    async identity({ callbackUrl, state, verifier }) {
      const redirect = checkedCallback(callbackUrl);
      const states = redirect.searchParams.getAll('state');
      const codes = redirect.searchParams.getAll('code');
      if (states.length !== 1 || states[0] !== state || !pkceVerifier.test(verifier)
        || codes.length !== 1 || !oauthCode.test(codes[0]) || redirect.searchParams.has('error')) {
        throw new Error('Invalid X identity response');
      }
      redirect.search = '';
      try {
        const token = tokenSchema.parse(await readJson(fetcher, 'https://api.x.com/2/oauth2/token', {
          method: 'POST',
          headers: {
            Authorization: 'Basic ' + Buffer.from(clientId + ':' + clientSecret).toString('base64'),
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            code: codes[0],
            redirect_uri: redirect.href,
            code_verifier: verifier,
          }),
        }));
        if (token.scope !== undefined && token.scope.trim().split(/\s+/).sort().join(' ') !== scope) {
          throw new Error('Unexpected X identity scopes');
        }
        const user = userSchema.parse(await readJson(fetcher, 'https://api.x.com/2/users/me', {
          headers: { Authorization: 'Bearer ' + token.access_token },
        })).data;
        return { subject: user.id, username: user.username ?? null };
      } catch {
        throw new Error('X identity could not be verified');
      }
    },
  };
}
