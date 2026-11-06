import { formatEther } from 'ethers';
import { useEffect, useRef, useState } from 'react';
import type { ExtensionTokenIdentity } from '../../../shared/extension';
import { browserApi } from './platform';
import { loadWalletBuySettings, type WalletBuyMode, type WalletBuySettings } from './walletBuyDefaults';
import { allWalletBuysAccepted, captureWalletBuyTab, openWalletBuyToken, walletBuyTokenUrl } from './walletBuyNavigation';
import { walletRpcPermission } from './walletRpc';
import { listSelectedWallets } from './walletSelection';
import { listLocalWallets, minimumWalletPasswordLength, type LocalWallet } from './walletVault';
import {
  checkPendingWalletBuys, loadPendingWalletBuys, parseWalletBuyAmount,
  previewWalletBuys, submitWalletBuys, walletBuyErrorMessage,
  type PendingWalletBuy, type WalletBuyResult,
} from './walletSwap';

export interface WalletBuyContext {
  wallets: LocalWallet[];
  settings: WalletBuySettings;
}

export interface WalletBuyRequest extends WalletBuyContext {
  tokens: readonly ExtensionTokenIdentity[];
  mode: WalletBuyMode;
  permission?: Promise<boolean>;
  originTab?: ReturnType<typeof captureWalletBuyTab>;
}

export async function loadWalletBuyContext(): Promise<WalletBuyContext> {
  const [wallets, settings] = await Promise.all([listSelectedWallets(), loadWalletBuySettings()]);
  return { wallets, settings };
}

export function requestWalletBuyPermission(): Promise<boolean> {
  return browserApi.permissions.request(walletRpcPermission).catch(() => false);
}

const statusLabels = {
  submitted: 'Submitted',
  unknown: 'Submission unconfirmed',
  failed: 'Failed',
  skipped: 'Skipped',
  confirmed: 'Confirmed',
  reverted: 'Reverted on chain',
  nonce_used: 'Nonce used · check BscScan',
} satisfies Record<WalletBuyResult['status'], string>;

const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;
const tokenLabel = (token: ExtensionTokenIdentity) => token.symbol || token.name || short(token.address);
const startedBuys = new WeakSet<WalletBuyRequest>();

function sameWalletSelection(left: LocalWallet[], right: LocalWallet[]) {
  return left.length === right.length && left.every(wallet => right.some(other =>
    other.address === wallet.address && other.protection === wallet.protection));
}

function buySettingsMatch(request: WalletBuyRequest, current: WalletBuySettings) {
  const { mode, settings } = request;
  return settings.amounts[mode] === current.amounts[mode] &&
    settings.slippageBps[mode] === current.slippageBps[mode] && settings.maxFeeBnb === current.maxFeeBnb;
}

async function pendingBuys() {
  const wallets = await listLocalWallets();
  return (await Promise.all(wallets.map(wallet => loadPendingWalletBuys(wallet.address)))).flat();
}

function BuyResults({ results, tokens }: { results: readonly WalletBuyResult[]; tokens: WalletBuyRequest['tokens'] }) {
  return <ul className="buy-list" aria-label="Buy results" aria-live="polite">
    {results.map(result => {
      const token = tokens.find(item => item.address.toLowerCase() === result.token.toLowerCase());
      return <li key={result.hash ?? `${result.wallet}:${result.token}`}>
        <strong>{token ? tokenLabel(token) : short(result.token)} · {statusLabels[result.status]}</strong>
        <small title={result.wallet}>Wallet {short(result.wallet)}</small>
        {result.message && <p>{result.message}</p>}
        {result.hash && <a className="wallet-transfer-link" href={`https://bscscan.com/tx/${result.hash}`}
          target="_blank" rel="noopener noreferrer">View on BscScan</a>}
      </li>;
    })}
  </ul>;
}

export function WalletBuyView({ request, onClose }: { request: WalletBuyRequest | null; onClose: () => void }) {
  const [pending, setPending] = useState<PendingWalletBuy[] | null>(null);
  const [results, setResults] = useState<WalletBuyResult[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [navigationError, setNavigationError] = useState(false);
  const active = useRef<AbortController | null>(null);
  const busyRef = useRef(false);
  const sectionRef = useRef<HTMLElement>(null);
  const activity = request === null;
  const tokens = request?.tokens ?? [];
  const gmgnUrl = request?.mode === 'single' && tokens.length === 1 ? walletBuyTokenUrl(tokens[0].address) : null;
  const heading = activity ? 'Buy activity' : request.mode === 'single' ? `Buy ${tokenLabel(tokens[0])}` : 'Buy all tokens';
  const lockedWallets = request?.wallets.filter(wallet => wallet.protection === 'password') ?? [];
  const orderCount = tokens.length * (request?.wallets.length ?? 0);
  const totalAmount = request ? formatEther(parseWalletBuyAmount(request.settings.amounts[request.mode]) * BigInt(orderCount)) : null;
  const displayedResults: WalletBuyResult[] = activity ? [
    ...results,
    ...(pending ?? []).filter(item => !results.some(result => result.hash === item.hash))
      .map(item => ({ ...item, status: 'unknown' as const })),
  ] : results;

  useEffect(() => {
    sectionRef.current?.scrollIntoView({ block: 'start' });
  }, []);

  useEffect(() => {
    const lifetime = new AbortController();
    active.current = lifetime;
    if (!request) {
      void pendingBuys().then(items => {
        if (!lifetime.signal.aborted) setPending(items);
      }).catch(() => {
        if (!lifetime.signal.aborted) setError('Could not load pending buys.');
      });
    } else if (request.permission) {
      const permission = request.permission;
      queueMicrotask(() => {
        // A view remount must never replay the user's click.
        if (lifetime.signal.aborted || startedBuys.has(request)) return;
        startedBuys.add(request);
        buy(request, permission, new Map());
      });
    }
    return () => lifetime.abort();
  }, [request]);

  async function run(action: (signal: AbortSignal) => Promise<void>, fallback: string) {
    const signal = active.current?.signal;
    if (!signal || signal.aborted || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError('');
    setNavigationError(false);
    try {
      await action(signal);
    } catch (failure) {
      if (!signal.aborted) setError(walletBuyErrorMessage(failure, fallback));
    } finally {
      busyRef.current = false;
      if (!signal.aborted) setBusy(false);
    }
  }

  function unlockAndBuy(form: HTMLFormElement | null) {
    if (!form || !request || busyRef.current || !form.reportValidity()) return;
    const fields = new FormData(form);
    const passwords = new Map(lockedWallets
      .map(wallet => [wallet.address, String(fields.get(wallet.address) ?? '')]));
    for (const address of passwords.keys()) {
      const field = form.elements.namedItem(address);
      if (field instanceof HTMLInputElement) field.value = '';
    }
    buy(request, requestWalletBuyPermission(), passwords);
  }

  function buy(intent: WalletBuyRequest, permission: Promise<boolean>, passwords: Map<string, string>) {
    const { mode, settings } = intent;
    const amount = settings.amounts[mode];
    const slippageBps = settings.slippageBps[mode];
    void run(async signal => {
      try {
        if (!await permission) {
          if (!signal.aborted) setError('Allow BNB Chain RPC access to buy.');
          return;
        }
        if (signal.aborted || !await stillCurrent(intent, signal)) return;
        const plan = await previewWalletBuys(
          intent.wallets.map(wallet => wallet.address), intent.tokens.map(token => token.address), amount, slippageBps, signal,
        );
        if (signal.aborted) return;
        const maxFeeWei = parseWalletBuyAmount(settings.maxFeeBnb);
        if (plan.trades.some(trade => BigInt(trade.maxFeeWei) > maxFeeWei)) {
          setError(`Estimated network fee exceeds your ${settings.maxFeeBnb} BNB limit per buy. Change it in Settings or try again later.`);
          return;
        }
        if (!await stillCurrent(intent, signal)) return;
        const submitted = await submitWalletBuys(plan, passwords, {
          signal,
          onUpdate: result => {
            if (!signal.aborted) setResults(previous => [...previous, result]);
          },
        });
        if (signal.aborted) return;
        setResults(submitted);
        if (mode === 'single' && intent.tokens.length === 1) {
          const address = intent.tokens[0].address;
          if (allWalletBuysAccepted(address, intent.wallets.map(wallet => wallet.address), submitted)) {
            const origin = await intent.originTab;
            if (signal.aborted) return;
            const opened = await openWalletBuyToken(browserApi.tabs, address, settings.singleTokenDestination, origin)
              .catch(() => false);
            if (!opened && !signal.aborted) setNavigationError(true);
          }
        }
      } finally {
        passwords.clear();
      }
    }, 'Could not complete this buy. Check Buy activity before trying again.');
  }

  async function stillCurrent(intent: WalletBuyRequest, signal: AbortSignal) {
    const { wallets, settings } = await loadWalletBuyContext();
    if (signal.aborted) return false;
    if (!sameWalletSelection(wallets, intent.wallets)) {
      setError('Your wallet selection changed. Check the selected wallets and try again.');
      return false;
    }
    if (!buySettingsMatch(intent, settings)) {
      setError('Your buy settings changed. Check the new amount and limits and try again.');
      return false;
    }
    return true;
  }

  function checkActivity() {
    void run(async signal => {
      if (!await requestWalletBuyPermission()) {
        setError('Allow BNB Chain RPC access to check pending buys.');
        return;
      }
      const items = await pendingBuys();
      for (const wallet of new Set(items.map(item => item.wallet))) {
        if (signal.aborted) return;
        const checked = await checkPendingWalletBuys(wallet, signal);
        if (signal.aborted) return;
        setResults(previous => {
          const updates = new Map(checked.map(result => [result.hash, result]));
          return activity
            ? [...previous.filter(result => !updates.has(result.hash)), ...checked]
            : previous.map(result => result.hash ? updates.get(result.hash) ?? result : result);
        });
      }
      if (activity && !signal.aborted) {
        const remaining = await pendingBuys();
        if (!signal.aborted) setPending(remaining);
      }
    }, 'Could not check pending buys. Try again or check BscScan.');
  }

  return <section ref={sectionRef} className="wallet-card wallet-editor wallet-buy" aria-label={heading}>
    <h2>{heading}</h2>
    {error && <p className="wallet-error" role="alert">{error}</p>}
    {activity && pending?.length === 0 && <p>No pending buys.</p>}
    {request && <p><strong>{totalAmount} BNB</strong> + network fees · {orderCount} {orderCount === 1 ? 'order' : 'orders'}</p>}
    {lockedWallets.length > 0 && results.length === 0 && <form autoComplete="off" onSubmit={event => {
      event.preventDefault();
      unlockAndBuy(event.currentTarget);
    }}>
      {lockedWallets.map(wallet =>
        <label key={wallet.address}>Password for {wallet.alias ? `${wallet.alias} (${short(wallet.address)})` : short(wallet.address)}
          <input name={wallet.address} type="password" minLength={minimumWalletPasswordLength}
            maxLength={1024} autoComplete="off" required disabled={busy}/>
        </label>)}
      <button className="popup-action buy-submit" type="submit" disabled={busy}>Unlock and buy</button>
    </form>}
    {displayedResults.length > 0 && <BuyResults results={displayedResults} tokens={tokens}/>}
    {navigationError && <p role="status">Buy submitted. Could not open GMGN automatically.</p>}
    {busy && <p role="status">{activity ? 'Checking pending buys…' : 'Submitting buys… Keep this window open.'}</p>}
    <div className="wallet-actions">
      <button className="popup-action secondary" type="button" disabled={busy} onClick={onClose}>Done</button>
      {gmgnUrl && results.some(result => result.status === 'submitted' || result.status === 'confirmed') &&
        <a className="wallet-transfer-link" href={gmgnUrl} target="_blank" rel="noopener noreferrer">Open on GMGN</a>}
      {(activity || results.some(result => result.status === 'submitted' || result.status === 'unknown')) &&
        <button className="popup-action" type="button" disabled={busy} onClick={checkActivity}>Check pending buys</button>}
    </div>
  </section>;
}
