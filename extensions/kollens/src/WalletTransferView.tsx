import { formatEther } from 'ethers';
import { Copy } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { browserApi } from './platform';
import { walletRpcPermission } from './walletRpc';
import {
  checkWalletTransfer, loadPendingWalletTransfer, maximumTransferFee, previewWalletTransfer, submitWalletTransfer,
  transferErrorMessage, type PendingWalletTransfer, type TransferPreview, type TransferStatus,
} from './walletTransfer';
import { minimumWalletPasswordLength, type LocalWallet } from './walletVault';

interface TransferViewProps {
  kind: 'receive' | 'send';
  wallet: LocalWallet;
  onClose: () => void;
  onSent: () => void;
}

const statusText = {
  unchecked: 'Check the status of your previous transfer.',
  pending: 'Submitted to BNB Chain. Waiting for confirmation.',
  unknown: 'Submission is unconfirmed. You can check again or resubmit the same transaction.',
  confirmed: 'Transfer confirmed.',
  reverted: 'The transfer failed on chain. A network fee was charged.',
  nonce_used: 'The wallet has newer activity. Check BscScan for this transfer before sending again.',
} satisfies Record<TransferStatus | 'unchecked', string>;

function ReceiveWallet({ wallet, onClose }: Omit<TransferViewProps, 'kind' | 'onSent'>) {
  const [status, setStatus] = useState('');
  async function copyAddress() {
    try {
      await navigator.clipboard.writeText(wallet.address);
      setStatus('Address copied.');
    } catch {
      setStatus('Select the address to copy it.');
    }
  }

  return <section className="wallet-card wallet-editor wallet-transfer" aria-label="Receive">
    <h2>Receive</h2>
    <p>BNB Smart Chain</p>
    <label htmlFor="wallet-receive-address">Wallet address</label>
    <input id="wallet-receive-address" readOnly value={wallet.address} onFocus={event => event.currentTarget.select()}/>
    {status && <p role="status">{status}</p>}
    <div className="wallet-actions">
      <button type="button" className="popup-action secondary" onClick={onClose}>Done</button>
      <button type="button" className="popup-action" onClick={() => void copyAddress()}><Copy size={13} aria-hidden="true"/> Copy address</button>
    </div>
  </section>;
}

function TransferReview({ preview }: { preview: TransferPreview }) {
  const fee = maximumTransferFee(preview);
  return <dl className="wallet-transfer-review">
    <dt>Network</dt><dd>BNB Smart Chain</dd>
    <dt>From</dt><dd><code className="wallet-transfer-address">{preview.from}</code></dd>
    <dt>To</dt><dd><code className="wallet-transfer-address">{preview.to}</code></dd>
    <dt>Amount</dt><dd>{formatEther(preview.value)} BNB</dd>
    <dt>Max network fee</dt><dd>{formatEther(fee)} BNB</dd>
    <dt>Max total</dt><dd>{formatEther(BigInt(preview.value) + fee)} BNB</dd>
  </dl>;
}

function PasswordField() {
  return <label>Wallet password
    <input name="password" type="password" minLength={minimumWalletPasswordLength} maxLength={1024} autoComplete="off" required/>
  </label>;
}

function SendWallet({ wallet, onClose, onSent }: Omit<TransferViewProps, 'kind'>) {
  const [recipient, setRecipient] = useState('');
  const [amount, setAmount] = useState('');
  const [preview, setPreview] = useState<TransferPreview | null>(null);
  const [tracked, setTracked] = useState<{ transfer: PendingWalletTransfer; status: TransferStatus | 'unchecked' } | null>(null);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const busyRef = useRef(false);
  const requiresPassword = wallet.protection === 'password';

  useEffect(() => {
    let active = true;
    void loadPendingWalletTransfer(wallet.address).then(transfer => {
      if (!active) return;
      if (transfer) setTracked({ transfer, status: 'unchecked' });
      setReady(true);
    }).catch(() => {
      if (active) setError('Could not read this wallet’s pending transaction.');
    });
    return () => { active = false; };
  }, [wallet.address]);

  async function run(action: () => Promise<void>, fallback: string) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (failure) {
      setError(transferErrorMessage(failure, fallback));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  async function review(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await run(async () => {
      const granted = await browserApi.permissions.request(walletRpcPermission);
      if (!granted) {
        setError('Allow access to the BNB Chain RPC to review your transfer.');
        return;
      }
      setPreview(await previewWalletTransfer(wallet.address, recipient.trim(), amount.trim()));
    }, 'Could not estimate this transfer. Check the address and try again.');
  }

  async function confirm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!preview || busyRef.current) return;
    const password = requiresPassword ? String(new FormData(event.currentTarget).get('password') ?? '') : undefined;
    event.currentTarget.reset();
    await run(async () => {
      const result = await submitWalletTransfer(preview, password);
      setTracked(result);
      setPreview(null);
      if (result.status === 'pending') onSent();
    }, 'Could not send this transfer. Review the amount and try again.');
  }

  async function check(retry?: { password?: string }) {
    if (!tracked) return;
    await run(async () => {
      const status = await checkWalletTransfer(tracked.transfer, retry);
      setTracked({ transfer: tracked.transfer, status });
      if (status === 'confirmed' || status === 'reverted' || status === 'nonce_used' || (retry && status === 'pending')) onSent();
    }, 'Could not check this transaction. Try again.');
  }

  function resubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busyRef.current) return;
    const password = requiresPassword ? String(new FormData(event.currentTarget).get('password') ?? '') : undefined;
    event.currentTarget.reset();
    void check({ password });
  }

  const awaitingStatus = tracked && (tracked.status === 'pending' || tracked.status === 'unknown' || tracked.status === 'unchecked');
  return <section className="wallet-card wallet-editor wallet-transfer" aria-label="Send BNB">
    <h2>Send BNB</h2>
    {tracked
      ? <>
        <p role="status">{statusText[tracked.status]}</p>
        <a className="wallet-transfer-link" href={`https://bscscan.com/tx/${tracked.transfer.hash}`} target="_blank" rel="noreferrer">View transaction on BscScan</a>
        {error && <p className="wallet-error" role="alert">{error}</p>}
        {tracked.status === 'unknown'
          ? <form onSubmit={resubmit} autoComplete="off">
            {requiresPassword && <PasswordField/>}
            <button className="popup-action secondary" type="submit" disabled={busy}>Resubmit same transaction</button>
          </form>
          : null}
        <div className="wallet-actions">
          <button className="popup-action secondary" type="button" disabled={busy} onClick={onClose}>Done</button>
          {awaitingStatus && <button className="popup-action" type="button" disabled={busy} onClick={() => void check()}>
            {busy ? 'Checking…' : 'Check status'}
          </button>}
        </div>
      </>
      : preview
        ? <form onSubmit={confirm} autoComplete="off">
          <TransferReview preview={preview}/>
          {requiresPassword && <PasswordField/>}
          {error && <p className="wallet-error" role="alert">{error}</p>}
          <div className="wallet-actions">
            <button className="popup-action secondary" type="button" disabled={busy} onClick={() => { setPreview(null); setError(''); }}>Back</button>
            <button className="popup-action" type="submit" disabled={busy}>{busy ? 'Sending…' : 'Confirm send'}</button>
          </div>
        </form>
        : <form onSubmit={review} autoComplete="off">
          <p>From <code className="wallet-transfer-address">{wallet.address}</code></p>
          <label>Recipient address
            <input value={recipient} onChange={event => setRecipient(event.currentTarget.value)} maxLength={64} spellCheck={false} required disabled={!ready || busy}/>
          </label>
          <label>Amount (BNB)
            <input value={amount} onChange={event => setAmount(event.currentTarget.value)} inputMode="decimal" maxLength={43} placeholder="0.00" required disabled={!ready || busy}/>
          </label>
          {error && <p className="wallet-error" role="alert">{error}</p>}
          <div className="wallet-actions">
            <button className="popup-action secondary" type="button" disabled={busy} onClick={onClose}>Cancel</button>
            <button className="popup-action" type="submit" disabled={!ready || busy}>{busy ? 'Reviewing…' : 'Review transfer'}</button>
          </div>
        </form>}
  </section>;
}

export function WalletTransferView({ kind, wallet, onClose, onSent }: TransferViewProps) {
  return kind === 'receive'
    ? <ReceiveWallet wallet={wallet} onClose={onClose}/>
    : <SendWallet wallet={wallet} onClose={onClose} onSent={onSent}/>;
}
