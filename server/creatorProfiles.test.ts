import { describe, expect, it } from 'vitest';
import { AbiCoder, Wallet } from 'ethers';
import sharp from 'sharp';
import { createCreatorChallenge, creatorOrigin, creatorWallet, normalizeCreatorAvatar, normalizeCreatorPatch, verifyCreatorSignature } from './creatorProfiles.js';
import type { Rpc } from './rpc.js';

const rpc = (code = '0x', signatureResult?: string): Rpc => async <T>(method: string) => {
  const result = method === 'eth_chainId' ? '0x38' : method === 'eth_blockNumber' ? '0x64' : method === 'eth_getCode' ? code : signatureResult;
  if (result === undefined) throw new Error('Unsupported operation');
  return result as T;
};
describe('creator wallet proof', () => {
  it('builds a domain, wallet, chain, action and time bound SIWE message', () => {
    const wallet = Wallet.createRandom().address.toLowerCase();
    const proof = createCreatorChallenge({ wallet, origin: 'https://kollens.com', action: 'claim', now: 1800000000000 });
    expect(proof.message).toContain('kollens.com wants you to sign in');
    expect(proof.message).toContain('Chain ID: 56');
    expect(proof.message).toContain(`URI: https://kollens.com/kol/${wallet}`);
    expect(proof.message).toContain(`urn:kollens:creator:claim:${proof.challengeId}`);
    expect(Date.parse(proof.expiresAt)).toBe(1800000600000);
    expect(proof.message).not.toContain('undefined');
  });
  it('uses a distinct nonce and challenge on every request', () => {
    const args = { wallet: Wallet.createRandom().address, origin: 'https://kollens.com', action: 'claim' as const };
    const first = createCreatorChallenge(args), second = createCreatorChallenge(args);
    expect(first.challengeId).not.toBe(second.challengeId);
    expect(first.message.match(/Nonce: (.*)/)?.[1]).not.toBe(second.message.match(/Nonce: (.*)/)?.[1]);
  });
  it('validates ordinary wallet signatures and rejects another account', async () => {
    const wallet = Wallet.createRandom(), message = 'A domain-bound stored challenge';
    const signature = await wallet.signMessage(message);
    await expect(verifyCreatorSignature(wallet.address, message, signature, rpc())).resolves.toEqual({ kind: 'eoa', blockNumber: '94' });
    await expect(verifyCreatorSignature(Wallet.createRandom().address, message, signature, rpc())).rejects.toMatchObject({ code: 'signature_invalid' });
    await expect(verifyCreatorSignature(wallet.address, message + '.', signature, rpc())).rejects.toMatchObject({ code: 'signature_invalid' });
  });
  it('validates deployed ERC1271 wallets at the confirmed checkpoint', async () => {
    const calls: { method: string; params: unknown[] }[] = [];
    const mock: Rpc = async <T>(method: string, params: unknown[]) => { calls.push({ method, params }); return rpc('0x6000', AbiCoder.defaultAbiCoder().encode(['bytes4'], ['0x1626ba7e']))<T>(method, params); };
    await expect(verifyCreatorSignature(Wallet.createRandom().address, 'a challenge', '0xabcd', mock)).resolves.toEqual({ kind: 'erc1271', blockNumber: '94' });
    expect(calls.find(call => call.method === 'eth_call')?.params[1]).toBe('0x5e');
  });
  it('rejects smart wallet invalid magic values and unsupported contracts', async () => {
    const wallet = Wallet.createRandom().address;
    await expect(verifyCreatorSignature(wallet, 'a challenge', '0xabcd', rpc('0x6000', AbiCoder.defaultAbiCoder().encode(['bytes4'], ['0xffffffff'])))).rejects.toMatchObject({ code: 'signature_invalid' });
    await expect(verifyCreatorSignature(wallet, 'a challenge', '0xabcd', rpc('0x6000'))).rejects.toMatchObject({ code: 'wallet_unsupported' });
  });
  it('rejects wrong-chain or unavailable verification without claiming a wallet', async () => {
    const wrongChain: Rpc = async <T>() => '0x1' as T;
    await expect(verifyCreatorSignature(Wallet.createRandom().address, 'a challenge', '0xabcd', wrongChain)).rejects.toMatchObject({ code: 'node_unavailable' });
  });
  it('accepts only explicit origins and valid addresses', () => {
    expect(creatorOrigin('http://127.0.0.1:5173')).toBe('http://127.0.0.1:5173');
    for (const value of ['http://evil.test', 'https://kollens.com/path', 'https://user:secret@kollens.com', 'https://kollens.com?query']) expect(() => creatorOrigin(value)).toThrow();
    expect(() => creatorWallet('0x123')).toThrow();
  });
});
describe('published creator fields', () => {
  it('limits names and bio and permits clearing fields to roster defaults', () => {
    expect(normalizeCreatorPatch({ displayName: '  A KOL  ', bio: '', websiteUrl: null })).toEqual({ displayName: 'A KOL', bio: null, websiteUrl: null });
    expect(() => normalizeCreatorPatch({ displayName: 'a'.repeat(61) })).toThrow();
    expect(() => normalizeCreatorPatch({ bio: 'a'.repeat(401) })).toThrow();
    expect(() => normalizeCreatorPatch({ userId: 'owner' })).toThrow();
  });
  it('requires HTTPS and social profile URLs without embedded credentials', () => {
    expect(normalizeCreatorPatch({ xUrl: 'https://x.com/creator', telegramUrl: 'https://t.me/creator' })).toEqual({ xUrl: 'https://x.com/creator', telegramUrl: 'https://t.me/creator' });
    for (const websiteUrl of ['javascript:alert(1)', 'http://example.com', 'https://user:secret@example.com']) expect(() => normalizeCreatorPatch({ websiteUrl })).toThrow();
    for (const xUrl of ['https://evil.test/creator', 'https://x.com/i/flow/login', 'https://x.com/a?redirect=evil']) expect(() => normalizeCreatorPatch({ xUrl })).toThrow();
  });
  it('normalizes valid images to static512WebP, without source metadata', async () => {
    const original = await sharp({ create: { width: 900, height: 700, channels: 3, background: '#ffcc00' } }).png().toBuffer();
    const image = await normalizeCreatorAvatar({ mime: 'image/png', data: original.toString('base64') });
    const metadata = await sharp(image).metadata();
    expect(metadata).toMatchObject({ width: 512, height: 512, format: 'webp' });
    expect(metadata.exif).toBeUndefined();
  });
  it('rejects oversized, mismatched or invalid images', async () => {
    await expect(normalizeCreatorAvatar({ mime: 'image/png', data: Buffer.alloc(2 * 1024 * 1024 + 1).toString('base64') })).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(normalizeCreatorAvatar({ mime: 'image/svg+xml', data: Buffer.from('<svg/>').toString('base64') })).rejects.toMatchObject({ code: 'invalid_input' });
    const png = await sharp({ create: { width: 1, height: 1, channels: 3, background: '#fff' } }).png().toBuffer();
    await expect(normalizeCreatorAvatar({ mime: 'image/jpeg', data: png.toString('base64') })).rejects.toMatchObject({ code: 'invalid_input' });
  });
});
