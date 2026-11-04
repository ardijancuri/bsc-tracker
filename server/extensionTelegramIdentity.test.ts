import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import type { CustomFetch } from 'openid-client';
import { describe, expect, it } from 'vitest';
import { telegramExtensionIdentity } from './extensionTelegramIdentity.js';
import { telegramIssuer } from './telegramAuth.js';

const env = {
  TELEGRAM_CLIENT_ID: '123456789',
  TELEGRAM_CLIENT_SECRET: 'fixture-telegram-secret',
  PUBLIC_APP_URL: 'https://kollens.example',
  EXTENSION_TELEGRAM_LINK_ENABLED: 'true',
};
const callback = env.PUBLIC_APP_URL + '/api/auth/extension-social/telegram/callback';
const state = 'test-state', nonce = 'test-nonce', verifier = 'v'.repeat(64);
const {privateKey, publicKey} = generateKeyPairSync('rsa', {modulusLength: 2048});
const wrongKey = generateKeyPairSync('rsa', {modulusLength: 2048}).privateKey;
const jwk = {...publicKey.export({format:'jwk'}), kid:'test', use:'sig', alg:'RS256'};

function fixture(overrides: Record<string, unknown> = {}, badSignature = false) {
  let tokenRequests = 0;
  const fetcher: CustomFetch = async (input, init) => {
    const url = String(input);
    if (url === telegramIssuer + '/.well-known/openid-configuration') return Response.json({
      issuer: telegramIssuer, authorization_endpoint: telegramIssuer + '/auth', token_endpoint: telegramIssuer + '/token',
      jwks_uri: telegramIssuer + '/.well-known/jwks.json', response_types_supported: ['code'], subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['RS256'], token_endpoint_auth_methods_supported: ['client_secret_basic'],
      code_challenge_methods_supported: ['S256'],
    });
    if (url === telegramIssuer + '/.well-known/jwks.json') return Response.json({keys:[jwk]});
    expect(url).toBe(telegramIssuer + '/token');
    tokenRequests++;
    const form = new URLSearchParams(String(init?.body));
    expect(form.get('client_id')).toBe(env.TELEGRAM_CLIENT_ID);
    expect(form.get('redirect_uri')).toBe(callback);
    expect(form.get('code_verifier')).toBe(verifier);
    expect(form.get('code')).toBe('fixture-code');
    expect(new Headers(init?.headers).get('authorization')).toBe('Basic ' + Buffer.from(
      env.TELEGRAM_CLIENT_ID + ':' + env.TELEGRAM_CLIENT_SECRET,
    ).toString('base64'));
    const now = Math.floor(Date.now() / 1000);
    const body = [
      {alg:'RS256', kid:'test'},
      {iss:telegramIssuer, aud:env.TELEGRAM_CLIENT_ID, sub:'opaque-subject', nonce, iat:now, exp:now + 3600,
        id:2468101214, preferred_username:'fixture_telegram', ...overrides},
    ].map(value => Buffer.from(JSON.stringify(value)).toString('base64url')).join('.');
    return Response.json({token_type:'Bearer', access_token:'discarded',
      id_token:body + '.' + sign('RSA-SHA256', Buffer.from(body), badSignature ? wrongKey : privateKey).toString('base64url')});
  };
  return {provider:telegramExtensionIdentity(env, fetcher)!, tokenRequests:() => tokenRequests};
}

function resultUrl(extra = '') {
  return new URL(callback + '?code=fixture-code&state=' + state + extra);
}

describe('Telegram extension identity', () => {
  it('requires an explicit operator enable after registering the separate callback', () => {
    expect(telegramExtensionIdentity({...env, EXTENSION_TELEGRAM_LINK_ENABLED: undefined})).toBeNull();
    expect(telegramExtensionIdentity({...env, TELEGRAM_CLIENT_SECRET: undefined})).toBeNull();
  });

  it('requests only identity, verifies the signed Telegram ID and accepts repeated matching states', async () => {
    const {provider, tokenRequests} = fixture();
    const authorization = await provider.authorizationUrl({callback,state,nonce,verifier});
    expect(authorization.origin + authorization.pathname).toBe(telegramIssuer + '/auth');
    expect(authorization.searchParams.get('redirect_uri')).toBe(callback);
    expect(authorization.searchParams.get('scope')).toBe('openid profile');
    expect(authorization.searchParams.get('state')).toBe(state);
    expect(authorization.searchParams.get('nonce')).toBe(nonce);
    expect(authorization.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorization.searchParams.get('code_challenge')).toBe(createHash('sha256').update(verifier).digest('base64url'));
    await expect(provider.identity({callbackUrl:resultUrl('&state=' + state),state,nonce,verifier}))
      .resolves.toEqual({subject:'2468101214', username:'fixture_telegram'});
    expect(tokenRequests()).toBe(1);
  });

  it('rejects unexpected callback destinations and conflicting states before provider exchange', async () => {
    const {provider, tokenRequests} = fixture();
    await expect(provider.authorizationUrl({callback:env.PUBLIC_APP_URL + '/api/auth/telegram/callback',state,nonce,verifier})).rejects.toThrow();
    await expect(provider.identity({callbackUrl:resultUrl('&state=other'),state,nonce,verifier})).rejects.toThrow();
    await expect(provider.identity({callbackUrl:new URL('https://elsewhere.example/?code=fixture-code&state=' + state),state,nonce,verifier})).rejects.toThrow();
    expect(tokenRequests()).toBe(0);
  });

  it('discards invalid handles and rejects missing numeric ID, wrong nonce and bad signatures', async () => {
    const input = {callbackUrl:resultUrl(),state,nonce,verifier};
    await expect(fixture({preferred_username:'https://example.com/'}).provider.identity(input))
      .resolves.toEqual({subject:'2468101214', username:null});
    await expect(fixture({id:undefined, sub:'2468101214'}).provider.identity(input)).rejects.toThrow();
    await expect(fixture({nonce:'other'}).provider.identity(input)).rejects.toThrow();
    await expect(fixture({}, true).provider.identity(input)).rejects.toThrow();
  });
});
