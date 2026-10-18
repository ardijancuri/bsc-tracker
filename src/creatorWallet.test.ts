import { afterEach, describe, expect, it, vi } from 'vitest';
import { discoverCreatorWallets, signCreatorChallenge, type InjectedWallet, type WalletChoice } from './creatorWallet';

const target = `0x${'a'.repeat(40)}`, owner = `0x${'b'.repeat(40)}`, validSignature = `0x${'ab'.repeat(65)}`;
type Call = { method: string; params?: unknown[] | object };
function wallet(handler?: (call: Call, calls: Call[]) => unknown) {
  const calls: Call[] = [];
  const provider: InjectedWallet = { request: async call => {
    calls.push(call); const value = handler?.(call, calls);
    if (value !== undefined) return value;
    if (call.method === 'eth_chainId') return '0x38';
    if (call.method === 'eth_requestAccounts') return [target];
    if (call.method === 'personal_sign') return validSignature;
    throw new Error('Unexpected wallet request');
  } };
  return { provider, calls };
}
afterEach(() => vi.unstubAllGlobals());
describe('creator wallet signing', () => {
  it('signs exact UTF8 bytes using personal_sign and the matching connected account', async () => {
    const { provider, calls } = wallet(call => call.method === 'eth_requestAccounts' ? [owner, target.toUpperCase().replace('0X', '0x')] : undefined);
    expect(await signCreatorChallenge(provider, target, 'Kollens 钱包\nChain ID: 56')).toBe(validSignature);
    const sign = calls.find(call => call.method === 'personal_sign')!;
    const [hex, account] = sign.params as string[];
    expect(new TextDecoder().decode(Uint8Array.from(hex.slice(2).match(/../g)!, value => parseInt(value, 16)))).toBe('Kollens 钱包\nChain ID: 56');
    expect(account.toLowerCase()).toBe(target);
    expect(calls.every(call => !['eth_sendTransaction', 'eth_signTransaction', 'eth_sign'].includes(call.method))).toBe(true);
  });
  it('switches to BSC and independently verifies the resulting chain', async () => {
    let switched = false;
    const { provider, calls } = wallet(call => {
      if (call.method === 'eth_chainId') return switched ? '0x038' : '0x1';
      if (call.method === 'wallet_switchEthereumChain') { switched = true; return null; }
    });
    await signCreatorChallenge(provider, target, 'A stored challenge');
    expect(calls.find(call => call.method === 'wallet_switchEthereumChain')?.params).toEqual([{ chainId: '0x38' }]);
    expect(calls.filter(call => call.method === 'eth_chainId')).toHaveLength(2);
  });
  it('refuses a wallet that remains on another chain', async () => {
    const { provider, calls } = wallet(call => call.method === 'eth_chainId' ? '0x1' : call.method === 'wallet_switchEthereumChain' ? null : undefined);
    await expect(signCreatorChallenge(provider, target, 'A stored challenge')).rejects.toMatchObject({ code: 'wrong_chain' });
    expect(calls.find(call => call.method === 'personal_sign')).toBeUndefined();
  });
  it('can request a controlling EOA signature for server-side ERC1271 verification', async () => {
    const { provider, calls } = wallet(call => call.method === 'eth_requestAccounts' ? [owner] : undefined);
    await signCreatorChallenge(provider, target, 'A smart wallet challenge');
    expect((calls.find(call => call.method === 'personal_sign')?.params as string[])[1]).toBe(owner);
  });
  it.each([{ accounts: [] }, { accounts: ['invalid'] }, { accounts: [target, 123] }])('refuses malformed or unavailable accounts $accounts', async ({ accounts }) => {
    const { provider, calls } = wallet(call => call.method === 'eth_requestAccounts' ? accounts : undefined);
    await expect(signCreatorChallenge(provider, target, 'A stored challenge')).rejects.toMatchObject({ code: 'no_account' });
    expect(calls.find(call => call.method === 'personal_sign')).toBeUndefined();
  });
  it.each(['0x123', 'plain text', `0x${'a'.repeat(16386)}`])('refuses malformed signature output', async signature => {
    const { provider } = wallet(call => call.method === 'personal_sign' ? signature : undefined);
    await expect(signCreatorChallenge(provider, target, 'A stored challenge')).rejects.toMatchObject({ code: 'invalid_signature' });
  });
  it.each([[4001, 'rejected'], [4902, 'chain_missing'], [-32000, 'wallet_failed']])('maps provider errors without displaying arbitrary provider messages', async (code, expected) => {
    const { provider } = wallet(() => { throw Object.assign(new Error('Private wallet detail'), { code }); });
    await expect(signCreatorChallenge(provider, target, 'A stored challenge')).rejects.toMatchObject({ code: expected });
  });
});
describe('injected wallet discovery', () => {
  it('deduplicates EIP6963 and legacy wallets and removes its listener on cleanup', () => {
    const surface = new EventTarget() as EventTarget & { ethereum: { providers: InjectedWallet[] } };
    const first = wallet().provider, second = wallet().provider;
    surface.ethereum = { providers: [first, second] }; vi.stubGlobal('window', surface);
    const choices: WalletChoice[] = [];
    const announce = (provider: InjectedWallet, uuid: string) => {
      const event = new Event('eip6963:announceProvider'); Object.defineProperty(event, 'detail', { value: { info: { uuid, name: 'Wallet' }, provider } }); surface.dispatchEvent(event);
    };
    const remove = discoverCreatorWallets(value => choices.push(value));
    announce(first, 'first-announcement');
    expect(choices).toHaveLength(2);
    remove(); announce(wallet().provider, 'after-cleanup'); expect(choices).toHaveLength(2);
  });
  it('tolerates malformed legacy provider lists without breaking the page', () => {
    const surface = new EventTarget() as EventTarget & { ethereum: unknown };
    surface.ethereum = { providers: 'invalid' }; vi.stubGlobal('window', surface);
    const choices: WalletChoice[] = [], remove = discoverCreatorWallets(value => choices.push(value));
    expect(choices).toHaveLength(0); remove();
  });
});
