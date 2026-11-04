import {useEffect, useRef, useState, type FormEvent} from 'react';
import {ArrowDownToLine, ArrowUpRight, Copy, KeyRound, Plus, RefreshCw, WalletCards} from 'lucide-react';
import {browserApi, isExtension} from './platform';
import {createLocalWallet, exportLocalWallet, importLocalWallet, listLocalWallets, minimumWalletPasswordLength, type LocalWallet} from './walletVault';

const rpcUrl = 'https://bsc-dataseed.bnbchain.org';
const balancePermission = {origins:[`${rpcUrl}/*`]};
const weiPerBnb = 10n ** 18n;

async function readBalance(address: string, signal: AbortSignal): Promise<bigint> {
  const response = await fetch(rpcUrl, {
    method:'POST', credentials:'omit', redirect:'error', cache:'no-store',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({jsonrpc:'2.0',id:1,method:'eth_getBalance',params:[address,'latest']}),
    signal:AbortSignal.any([signal,AbortSignal.timeout(6000)]),
  });
  if (!response.ok) throw Error('BNB balance unavailable');
  const value = await response.json();
  if (typeof value.result !== 'string' || !/^0x[\da-f]{1,64}$/i.test(value.result)) throw Error('BNB balance unavailable');
  return BigInt(value.result);
}

function displayBalance(wei: bigint) {
  if (wei === 0n) return '0.00 BNB';
  if (wei < 10n ** 12n) return '<0.000001 BNB';
  const fraction = (wei % weiPerBnb).toString().padStart(18,'0').slice(0,6).replace(/0+$/,'').padEnd(2,'0');
  return `${(wei / weiPerBnb).toLocaleString()}.${fraction} BNB`;
}

type WalletForm =
  | {kind:'create'|'import'}
  | {kind:'backup'; wallet:LocalWallet};

function WalletEditor({form, onClose, onSaved}: {
  form:WalletForm;
  onClose:()=>void;
  onSaved:(wallet:LocalWallet, created:boolean)=>void;
}) {
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState('');
  const [backup,setBackup] = useState('');
  const active = useRef(false);
  useEffect(()=>{
    active.current=true;
    const clearHiddenKey=()=>{if(document.hidden)setBackup('');};
    document.addEventListener('visibilitychange',clearHiddenKey);
    return ()=>{
      active.current=false;
      document.removeEventListener('visibilitychange',clearHiddenKey);
    };
  },[]);
  const heading = form.kind==='create'?'Create wallet':form.kind==='import'?'Import wallet':'Back up wallet';

  async function submit(event:FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const fields = new FormData(event.currentTarget);
    event.currentTarget.reset();
    const password = String(fields.get('password') ?? '');
    if (form.kind!=='backup' && password!==fields.get('confirm')) {
      setError('Wallet passwords do not match.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      if (form.kind==='backup') {
        const key = await exportLocalWallet(form.wallet.address,password);
        if (active.current&&!document.hidden) setBackup(key);
      } else {
        const wallet = form.kind==='create'
          ? await createLocalWallet(password)
          : await importLocalWallet(String(fields.get('secret') ?? ''),password);
        if (active.current) onSaved(wallet,form.kind==='create');
      }
    } catch (failure) {
      if (active.current) setError(failure instanceof Error?failure.message:'Could not manage this wallet.');
    } finally {
      if (active.current) setBusy(false);
    }
  }
  return <section className="wallet-card wallet-editor" aria-label={heading}>
    <h2>{heading}</h2>
    {backup
      ? <>
        <p>This key controls this wallet. Keep your backup somewhere private and offline.</p>
        <label htmlFor="wallet-backup-key">Private key</label>
        <textarea id="wallet-backup-key" readOnly value={backup} spellCheck={false} onFocus={event=>event.currentTarget.select()}/>
        <button className="popup-action" onClick={onClose}>Hide private key</button>
      </>
      : <form onSubmit={submit} autoComplete="off">
        {form.kind==='import'&&<label>Private key or recovery phrase
          <input name="secret" type="password" required maxLength={512} autoComplete="off" spellCheck={false}/>
          <small>A recovery phrase imports its first standard EVM address.</small>
        </label>}
        <label>Wallet password
          <input name="password" type="password" required minLength={minimumWalletPasswordLength} maxLength={1024}
            autoComplete="off"/>
        </label>
        {form.kind!=='backup'&&<>
          <label>Confirm password
            <input name="confirm" type="password" required minLength={minimumWalletPasswordLength} maxLength={1024} autoComplete="off"/>
          </label>
          <p>Use at least {minimumWalletPasswordLength} characters. This password protects this wallet on this Chrome profile.</p>
        </>}
        {error&&<p role="alert" className="wallet-error">{error}</p>}
        <div className="wallet-actions">
          <button className="popup-action secondary" type="button" disabled={busy} onClick={onClose}>Cancel</button>
          <button className="popup-action" type="submit" disabled={busy}>{busy?'Working…':form.kind==='backup'?'Show private key':heading}</button>
        </div>
      </form>}
  </section>;
}

export function WalletsView() {
  const [wallets,setWallets] = useState<LocalWallet[]>([]);
  const [ready,setReady] = useState(!isExtension);
  const [form,setForm] = useState<WalletForm|null>(null);
  const [newWallet,setNewWallet] = useState('');
  const [feedback,setFeedback] = useState('');
  const [balance,setBalance] = useState<bigint|null>(null);
  const [balanceBusy,setBalanceBusy] = useState(false);
  const [balanceMessage,setBalanceMessage] = useState('');
  const balanceRequest = useRef<AbortController|undefined>(undefined);

  useEffect(()=>{
    if (!isExtension) return;
    let active = true;
    void listLocalWallets().then(items=>{
      if (active) {setWallets(items);setReady(true);}
    }).catch(()=>{if (active) setFeedback('Could not open your wallet vault.');});
    return ()=>{active=false;balanceRequest.current?.abort();};
  },[]);

  async function refreshBalance(requestAccess: boolean) {
    if (balanceRequest.current || wallets.length===0) return;
    const controller = new AbortController();
    balanceRequest.current = controller;
    setBalanceBusy(true);
    setBalanceMessage('');
    try {
      const granted = requestAccess
        ? await browserApi.permissions.request(balancePermission)
        : await browserApi.permissions.contains(balancePermission);
      if (!granted) {
        if (requestAccess) setBalanceMessage('Allow access to the BNB Chain RPC to refresh.');
        return;
      }
      const values = await Promise.all(wallets.map(wallet=>readBalance(wallet.address,controller.signal)));
      if (!controller.signal.aborted) setBalance(values.reduce((total,wei)=>total+wei,0n));
    } catch {
      if (!controller.signal.aborted) {
        setBalance(null);
        setBalanceMessage('BNB balance unavailable. Try refreshing.');
      }
    } finally {
      if (balanceRequest.current===controller) {
        balanceRequest.current=undefined;
        if (!controller.signal.aborted) setBalanceBusy(false);
      }
    }
  }

  useEffect(()=>{
    if (wallets.length>0) void refreshBalance(false);
    return ()=>{
      balanceRequest.current?.abort();
      balanceRequest.current=undefined;
    };
  },[wallets]);

  function openForm(next:WalletForm) {
    setFeedback('');
    setForm(next);
  }
  function saved(wallet:LocalWallet, created:boolean) {
    setBalance(null);
    setWallets(current=>[wallet,...current]);
    setNewWallet(created?wallet.address:'');
    setForm(null);
    setFeedback(created?'Wallet created. Back up its private key before adding funds.':'Wallet imported.');
  }

  return <div className="wallet-layout">
    <section className="wallet-balance">
      <p>BNB · Native balance</p>
      <div>
        <strong>{!ready?'—':wallets.length===0?displayBalance(0n):balance===null?'—':displayBalance(balance)}</strong>
        {wallets.length>0&&<button aria-label="Refresh BNB balance" title="Check public wallet addresses using the BNB Chain RPC" disabled={balanceBusy}
          onClick={()=>void refreshBalance(true)}><RefreshCw size={14} aria-hidden="true"/></button>}
      </div>
      {balanceMessage&&<small role="status">{balanceMessage}</small>}
    </section>
    {ready&&!form&&<div className="wallet-toolbar">
      <button className="popup-action secondary" disabled={!isExtension} onClick={()=>openForm({kind:'create'})}><Plus size={14} aria-hidden="true"/>Wallet</button>
      {wallets.length>0&&<button className="popup-action secondary" onClick={()=>openForm({kind:'import'})}><ArrowDownToLine size={14} aria-hidden="true"/>Import</button>}
    </div>}
    {feedback&&<p className="wallet-feedback" role="status">{feedback}</p>}
    {form&&<WalletEditor key={form.kind==='backup'?form.wallet.address:form.kind} form={form} onClose={()=>setForm(null)} onSaved={saved}/>}
    {!form&&ready&&wallets.length===0&&<section className="wallet-card wallet-empty">
      <div className="wallet-intro"><span className="wallet-intro-icon"><WalletCards size={18} aria-hidden="true"/></span><div>
        <h2>Get started with wallets</h2>
        <p>Create a BNB Chain wallet or import one you already use.</p>
      </div></div>
      <div className="wallet-actions">
        <button className="popup-action" disabled={!isExtension} onClick={()=>openForm({kind:'create'})}>Create Wallet</button>
        <button className="popup-action secondary" disabled={!isExtension} onClick={()=>openForm({kind:'import'})}><ArrowDownToLine size={14} aria-hidden="true"/>Import</button>
      </div>
      {!isExtension&&<p className="wallet-preview-note">Open the Chrome extension to manage wallets.</p>}
    </section>}
    {!form&&wallets.map(wallet=><section key={wallet.address} className="wallet-card wallet-record">
      <div><h2>BNB wallet</h2><code title={wallet.address}>{wallet.address.slice(0,8)}…{wallet.address.slice(-6)}</code></div>
      <div className="wallet-record-actions">
        <button aria-label="Copy wallet address" title="Copy wallet address" onClick={()=>void navigator.clipboard.writeText(wallet.address)
          .then(()=>setFeedback('Address copied.')).catch(()=>setFeedback('Could not copy address.'))}><Copy size={15} aria-hidden="true"/></button>
        <a href={`https://bscscan.com/address/${wallet.address}`} target="_blank" rel="noreferrer" aria-label="Open wallet on BscScan" title="Open on BscScan"><ArrowUpRight size={16} aria-hidden="true"/></a>
        <button className={newWallet===wallet.address?'needs-backup':undefined} aria-label="Back up wallet" title="Back up wallet"
          onClick={()=>openForm({kind:'backup',wallet})}><KeyRound size={15} aria-hidden="true"/></button>
      </div>
    </section>)}
  </div>;
}
