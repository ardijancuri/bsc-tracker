export interface InjectedWallet {
  request(args: { method: string; params?: unknown[] | object }): Promise<unknown>;
}
export interface WalletChoice { id: string; name: string; provider: InjectedWallet }
type Announcement = CustomEvent<{ info: { uuid: string; name: string }; provider: InjectedWallet }>;
export type CreatorWalletErrorCode = 'no_wallet' | 'wrong_chain' | 'no_account' | 'invalid_signature' | 'rejected' | 'chain_missing' | 'wallet_failed';
export class CreatorWalletError extends Error {
  constructor(readonly code: CreatorWalletErrorCode) { super(code); this.name = 'CreatorWalletError'; }
}

/** EIP-6963 avoids silently selecting whichever extension replaced window.ethereum. */
export function discoverCreatorWallets(onWallet: (wallet: WalletChoice) => void) {
  const seen = new Set<InjectedWallet>(), ids = new Set<string>();
  const add = (wallet: WalletChoice) => { if (!seen.has(wallet.provider) && !ids.has(wallet.id)) { seen.add(wallet.provider); ids.add(wallet.id); onWallet(wallet); } };
  const announced = (event: Event) => {
    const detail = (event as Announcement).detail;
    if (typeof detail?.provider?.request === 'function' && typeof detail.info?.uuid === 'string' && typeof detail.info?.name === 'string')
      add({ id: detail.info.uuid.slice(0, 100), name: detail.info.name.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 80), provider: detail.provider });
  };
  window.addEventListener('eip6963:announceProvider', announced);
  window.dispatchEvent(new Event('eip6963:requestProvider'));
  const injected = (window as unknown as { ethereum?: InjectedWallet & { providers?: InjectedWallet[] } }).ethereum;
  const providers = Array.isArray(injected?.providers) ? injected.providers : injected ? [injected] : [];
  for (const [index, provider] of providers.entries())
    if (provider && typeof provider.request === 'function') add({ id: `injected-${index}`, name: 'Browser wallet', provider });
  return () => window.removeEventListener('eip6963:announceProvider', announced);
}

export async function signCreatorChallenge(provider: InjectedWallet, target: string, message: string) {
  if (!/^0x[\da-f]{40}$/i.test(target) || !message || message.length > 20000) throw new CreatorWalletError('invalid_signature');
  try {
    const onBsc = (value: unknown) => typeof value === 'string' && /^0x[\da-f]+$/i.test(value) && BigInt(value) === 56n;
    let chain = await provider.request({ method: 'eth_chainId' });
    if (!onBsc(chain)) {
      await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x38' }] });
      chain = await provider.request({ method: 'eth_chainId' });
    }
    if (!onBsc(chain)) throw new CreatorWalletError('wrong_chain');
    const accounts = await provider.request({ method: 'eth_requestAccounts' });
    if (!Array.isArray(accounts) || !accounts.length || accounts.some(value => typeof value !== 'string' || !/^0x[\da-f]{40}$/i.test(value)))
      throw new CreatorWalletError('no_account');
    // A deployed smart wallet can authorize a signature made by its owner account.
    // The server checks ERC-1271 on the target contract; this does not grant ownership here.
    const account = accounts.find(value => value.toLowerCase() === target.toLowerCase()) ?? accounts[0];
    const hex = `0x${Array.from(new TextEncoder().encode(message), byte => byte.toString(16).padStart(2, '0')).join('')}`;
    const signature = await provider.request({ method: 'personal_sign', params: [hex, account] });
    if (typeof signature !== 'string' || !/^0x(?:[\da-f]{2}){1,8192}$/i.test(signature))
      throw new CreatorWalletError('invalid_signature');
    return signature;
  } catch (error) {
    if (error instanceof CreatorWalletError) throw error;
    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
    throw new CreatorWalletError(code === 4001 ? 'rejected' : code === 4902 ? 'chain_missing' : 'wallet_failed');
  }
}
