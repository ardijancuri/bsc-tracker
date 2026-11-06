import {useCallback, useEffect, useRef, useState} from 'react';
import {isExtension} from './platform';
import {parseRpcQuantity, walletRpc} from './walletRpc';
import type {LocalWallet} from './walletVault';

type BalanceStatus = 'empty' | 'loading' | 'ready' | 'partial' | 'unavailable';
type BalanceState = {
  wallets: readonly LocalWallet[];
  balances: ReadonlyMap<string, bigint>;
  status: BalanceStatus;
};

const emptyBalances: ReadonlyMap<string, bigint> = new Map();
const weiPerBnb = 10n ** 18n;

export function formatWalletBalance(wei: bigint) {
  if (wei === 0n) return '0.00';
  if (wei < 10n ** 12n) return '<0.000001';
  const fraction = (wei % weiPerBnb).toString().padStart(18, '0').slice(0, 6).replace(/0+$/, '').padEnd(2, '0');
  return `${(wei / weiPerBnb).toLocaleString()}.${fraction}`;
}

async function readBalances(wallets: readonly LocalWallet[], signal: AbortSignal) {
  const balances = new Map<string, bigint>();
  let next = 0;
  await Promise.all(Array.from({length: Math.min(wallets.length, 4)}, async () => {
    while (!signal.aborted) {
      const wallet = wallets[next++];
      if (!wallet) break;
      try {
        const value = await walletRpc('eth_getBalance', [wallet.address, 'latest'], signal);
        balances.set(wallet.address, parseRpcQuantity(value));
      } catch {
        // Failed reads stay absent and cannot turn into a zero balance.
      }
    }
  }));
  return balances;
}

export function useWalletBalances(wallets: readonly LocalWallet[]) {
  const [state, setState] = useState<BalanceState>();
  const active = useRef<AbortController | undefined>(undefined);

  const refreshBalance = useCallback(async () => {
    if (!isExtension || active.current || !wallets.length) return;
    const controller = new AbortController();
    active.current = controller;
    const publish = (status: BalanceStatus, balances = emptyBalances) => {
      if (!controller.signal.aborted) setState({wallets, balances, status});
    };
    publish('loading');
    try {
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(6_500)]);
      const balances = await readBalances(wallets, signal);
      publish(balances.size === wallets.length ? 'ready' : balances.size ? 'partial' : 'unavailable', balances);
    } catch {
      publish('unavailable');
    } finally {
      if (active.current === controller) active.current = undefined;
    }
  }, [wallets]);

  useEffect(() => {
    void refreshBalance();
    return () => {
      active.current?.abort();
      active.current = undefined;
    };
  }, [refreshBalance]);

  const current = state?.wallets === wallets ? state : undefined;
  const balances = current?.balances ?? emptyBalances;
  const balanceStatus: BalanceStatus = !wallets.length ? 'empty' : current?.status ?? 'loading';
  const totalBalance = balanceStatus === 'empty' ? 0n : balanceStatus === 'ready'
    ? Array.from(balances.values()).reduce((total, balance) => total + balance, 0n) : null;

  return {balances, totalBalance, balanceStatus, refreshBalance};
}
