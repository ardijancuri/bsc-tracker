import * as oidc from 'openid-client';
import type { ExtensionSocialProvider } from './extensionSocial.js';
import { createTelegramOidc, telegramAuthConfig, telegramIssuer, verifiedTelegramId } from './telegramAuth.js';

const callbackPath = '/api/auth/extension-social/telegram/callback';
const telegramUsername = /^[A-Za-z0-9_]{1,32}$/;

export function telegramExtensionIdentity(env: NodeJS.ProcessEnv = process.env, fetcher?: oidc.CustomFetch): ExtensionSocialProvider | null {
  const config = telegramAuthConfig(env);
  if (!config || env.EXTENSION_TELEGRAM_LINK_ENABLED !== 'true') return null;

  const redirectUri = config.origin + callbackPath;
  let client: Promise<oidc.Configuration> | null = null;
  const getClient = () => client ??= createTelegramOidc(config, fetcher).catch(error => {
    client = null;
    throw error;
  });
  return {
    async authorizationUrl({callback, state, nonce, verifier}) {
      if (callback !== redirectUri) throw new Error('Invalid Telegram extension callback');
      return oidc.buildAuthorizationUrl(await getClient(), {
        redirect_uri: redirectUri, scope: 'openid profile', state, nonce,
        code_challenge: await oidc.calculatePKCECodeChallenge(verifier), code_challenge_method: 'S256',
      });
    },
    async identity({callbackUrl, state, nonce, verifier}) {
      if (callbackUrl.origin + callbackUrl.pathname !== redirectUri || callbackUrl.username || callbackUrl.password || callbackUrl.hash) {
        throw new Error('Invalid Telegram extension callback');
      }
      // Telegram can repeat the same state during its browser handoff.
      const states = callbackUrl.searchParams.getAll('state');
      if (!states.length || states.some(value => value !== state)) throw new Error('Invalid Telegram extension state');
      const url = new URL(callbackUrl.href);
      url.searchParams.set('state', state);
      const tokens = await oidc.authorizationCodeGrant(await getClient(), url, {
        pkceCodeVerifier: verifier, expectedState: state, expectedNonce: nonce, idTokenExpected: true,
      }, {client_id: config.clientId});
      const claims = tokens.claims();
      const subject = verifiedTelegramId(claims?.id);
      const now = Date.now() / 1000;
      if (!claims || claims.iss !== telegramIssuer || !subject || claims.exp <= now
        || !Number.isFinite(claims.iat) || claims.iat > now + 60) {
        throw new Error('Invalid Telegram identity');
      }
      const username = typeof claims.preferred_username === 'string' && telegramUsername.test(claims.preferred_username)
        ? claims.preferred_username : null;
      return {subject, username};
    },
  };
}
