import {useCallback, useEffect, useMemo, useRef, useState, type FormEvent} from 'react';
import {Archive, ArrowDownLeft, ArrowDownToLine, ArrowUpRight, ChevronDown, ChevronUp, Copy, Ellipsis, KeyRound, Pencil, Plus, RefreshCw, RotateCcw, WalletCards} from 'lucide-react';
import {browserApi, isExtension} from './platform';
import {formatWalletBalance, useWalletBalances} from './useWalletBalances';
import {WalletTransferView} from './WalletTransferView';
import {createLocalWallet, exportLocalWallet, importLocalWallet, maximumWalletAliasLength, minimumWalletPasswordLength, updateLocalWallet, type LocalWallet} from './walletVault';
import {readWalletSelection, setWalletArchived, setWalletSelected, walletSelectionKey} from './walletSelection';

const shortAddress = (address: string) => `${address.slice(0,6)}…${address.slice(-4)}`;

type WalletEditorAction =
  | {kind:'import'}
  | {kind:'backup'|'alias'; wallet:LocalWallet};
type WalletAction = WalletEditorAction
  | {kind:'receive'; wallet:LocalWallet}
  | {kind:'send'; wallet:LocalWallet};

function WalletEditor({action,onClose,onSaved}: {
  action:WalletEditorAction;
  onClose:()=>void;
  onSaved:(wallet:LocalWallet,message:string)=>void;
}) {
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState('');
  const [backup,setBackup] = useState('');
  const active = useRef(false);
  const operation = useRef(false);
  const revealEpoch = useRef(0);
  const heading = action.kind==='import'?'Import wallet':action.kind==='alias'?'Edit alias':'View private key';
  const needsPassword = action.kind==='import'||(action.kind==='backup'&&action.wallet.protection==='password');

  useEffect(()=>{
    active.current=true;
    const hideKey=()=>{revealEpoch.current++;setBackup('');};
    const hideWhenHidden=()=>{if(document.hidden)hideKey();};
    window.addEventListener('blur',hideKey);
    document.addEventListener('visibilitychange',hideWhenHidden);
    return ()=>{
      active.current=false;
      window.removeEventListener('blur',hideKey);
      document.removeEventListener('visibilitychange',hideWhenHidden);
    };
  },[]);

  async function submit(event:FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (operation.current) return;
    const fields = new FormData(event.currentTarget);
    const password = String(fields.get('password') ?? '');
    if (action.kind!=='alias') event.currentTarget.reset();
    if (action.kind==='import'&&password!==fields.get('confirm')) {
      setError('Wallet passwords do not match.');
      return;
    }
    operation.current=true;
    setBusy(true);
    setError('');
    try {
      if (action.kind==='backup') {
        const epoch = revealEpoch.current;
        const key = await exportLocalWallet(action.wallet.address, needsPassword?password:undefined);
        if (active.current&&epoch===revealEpoch.current&&!document.hidden&&document.hasFocus()) setBackup(key);
      } else if (action.kind==='alias') {
        const wallet = await updateLocalWallet(action.wallet.address,{alias:String(fields.get('alias') ?? '')});
        if (active.current) onSaved(wallet,'Wallet alias saved.');
      } else {
        const wallet = await importLocalWallet(String(fields.get('secret') ?? ''),password);
        if (active.current) onSaved(wallet,'Wallet imported.');
      }
    } catch (failure) {
      if (active.current) setError(failure instanceof Error?failure.message:'Could not manage this wallet.');
    } finally {
      operation.current=false;
      if (active.current) setBusy(false);
    }
  }

  return <section className="wallet-card wallet-editor" aria-label={heading}>
    <h2>{heading}</h2>
    {backup
      ? <>
        <p>This key gives full control of your wallet. Keep your backup private.</p>
        <label htmlFor="wallet-backup-key">Private key</label>
        <textarea id="wallet-backup-key" readOnly value={backup} spellCheck={false} onFocus={event=>event.currentTarget.select()}/>
        <button className="popup-action" onClick={onClose}>Hide private key</button>
      </>
      : <form onSubmit={submit} autoComplete="off">
        {action.kind==='import'&&<>
          <p id="wallet-import-key-warning" className="wallet-security-warning">
            Do not share your private key with anyone. Kollens never has access to your private keys.
          </p>
          <label>Private key or recovery phrase
            <input name="secret" type="password" required maxLength={512} autoComplete="off" spellCheck={false}
              aria-describedby="wallet-import-key-warning"/>
            <small>A recovery phrase imports its first standard EVM address.</small>
          </label>
        </>}
        {action.kind==='alias'&&<label>Wallet alias
          <input name="alias" maxLength={maximumWalletAliasLength} defaultValue={action.wallet.alias} placeholder="Optional name"/>
        </label>}
        {action.kind==='backup'&&<p>This key gives full control of your wallet. Reveal it only when you can keep it private.</p>}
        {needsPassword&&<label>Wallet password
          <input name="password" type="password" required minLength={minimumWalletPasswordLength} maxLength={1024}
            autoComplete="off"/>
        </label>}
        {action.kind==='import'&&<>
          <label>Confirm password
            <input name="confirm" type="password" required minLength={minimumWalletPasswordLength} maxLength={1024} autoComplete="off"/>
          </label>
          <p>Use at least {minimumWalletPasswordLength} characters.</p>
        </>}
        {error&&<p role="alert" className="wallet-error">{error}</p>}
        <div className="wallet-actions">
          <button className="popup-action secondary" type="button" disabled={busy} onClick={onClose}>Cancel</button>
          <button className="popup-action" type="submit" disabled={busy}>
            {busy?'Working…':action.kind==='backup'?'Show private key':action.kind==='alias'?'Save alias':heading}
          </button>
        </div>
      </form>}
  </section>;
}

function WalletRecord({wallet,balance,menuOpen,selected,onSelect,onMenu,onAction,onArchive,onCopy}:{
  wallet:LocalWallet;
  balance:bigint|undefined;
  menuOpen:boolean;
  selected:boolean;
  onSelect:(selected:boolean)=>void;
  onMenu:(address:string|null)=>void;
  onAction:(action:WalletAction)=>void;
  onArchive:()=>void;
  onCopy:()=>void;
}) {
  const [expanded,setExpanded] = useState(false);
  const [addressKeyboardFocus,setAddressKeyboardFocus] = useState(false);
  const menu = useRef<HTMLDivElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const trigger = useRef<HTMLDivElement>(null);
  const address = shortAddress(wallet.address);
  const label = wallet.alias||address;
  const menuId = `wallet-options-${wallet.address}`;
  const balanceText = balance===undefined?'—':formatWalletBalance(balance);

  function toggleExpanded() {
    onMenu(null);
    setExpanded(value=>!value);
  }

  useEffect(()=>{
    if (!menuOpen) return;
    const options=menu.current;
    const boundary=options?.closest('.popup-main')?.getBoundingClientRect();
    if (options&&boundary) {
      const rect=options.getBoundingClientRect();
      const anchor=menuButton.current?.getBoundingClientRect();
      if (anchor&&rect.bottom>boundary.bottom&&anchor.top-rect.height>=boundary.top) {
        options.classList.add('wallet-menu-above');
      } else {
        options.scrollIntoView({block:'nearest'});
      }
    }
    function dismiss(event:PointerEvent) {
      if (!trigger.current?.contains(event.target as Node)) onMenu(null);
    }
    function closeWithEscape(event:KeyboardEvent) {
      if (event.key==='Escape') {
        onMenu(null);
        menuButton.current?.focus();
      }
    }
    document.addEventListener('pointerdown',dismiss);
    document.addEventListener('keydown',closeWithEscape);
    return ()=>{
      document.removeEventListener('pointerdown',dismiss);
      document.removeEventListener('keydown',closeWithEscape);
    };
  },[menuOpen,onMenu]);

  return <section className="wallet-record" aria-label={`Wallet ${label}`}>
    <div className="wallet-record-head" data-expandable={!wallet.archived||undefined}
      onClick={wallet.archived?undefined:event=>{
        if (!(event.target as Element).closest('button, input, .wallet-address-popover, .wallet-menu-anchor')) toggleExpanded();
      }}>
      <div className="wallet-record-identity">
        <input type="checkbox" className="wallet-record-select" aria-label={`Select wallet ${label}`}
          checked={selected} disabled={wallet.archived} onChange={event=>onSelect(event.target.checked)}/>
        <div className="wallet-address-anchor" data-keyboard-focus={addressKeyboardFocus||undefined}
          onFocus={event=>{if (event.target.matches(':focus-visible')) setAddressKeyboardFocus(true);}}
          onBlur={event=>{if (!event.currentTarget.contains(event.relatedTarget)) setAddressKeyboardFocus(false);}}>
          <button type="button" className="wallet-record-address" onClick={onCopy} aria-label={`Copy wallet address ${wallet.address}`}>
            {label}
          </button>
          <div className="wallet-address-popover">
            <div className="wallet-address-bubble">
              <span aria-hidden="true">{address}</span>
              <button type="button" className="wallet-address-copy" onClick={onCopy} aria-label={`Copy full wallet address ${wallet.address}`}>
                <Copy size={11} strokeWidth={1.25} aria-hidden="true"/>
              </button>
            </div>
          </div>
        </div>
      </div>
      {!wallet.archived&&<span className="wallet-record-balance"><img src="assets/bnb-chain.svg" alt="BNB"/>{balanceText}</span>}
      <div ref={trigger} className="wallet-menu-anchor">
        <button ref={menuButton} type="button" className="wallet-icon-button" aria-label={`Wallet options for ${label}`}
          aria-expanded={menuOpen} aria-controls={menuOpen?menuId:undefined} onClick={()=>onMenu(menuOpen?null:wallet.address)}>
          <Ellipsis size={16} aria-hidden="true"/>
        </button>
        {menuOpen&&<div ref={menu} id={menuId} className="wallet-menu" aria-label="Wallet options">
          {!wallet.archived&&<div className="wallet-menu-group">
            <button onClick={()=>onAction({kind:'receive',wallet})}><ArrowDownLeft size={14} aria-hidden="true"/>Receive</button>
            <button onClick={()=>onAction({kind:'send',wallet})}><ArrowUpRight size={14} aria-hidden="true"/>Send</button>
          </div>}
          <div className="wallet-menu-group">
            <a href={`https://bscscan.com/address/${wallet.address}`} target="_blank" rel="noreferrer" onClick={()=>onMenu(null)}>
              <img src="assets/bnb-chain.svg" alt=""/>View on BscScan <ArrowUpRight className="wallet-menu-external" size={12} aria-hidden="true"/>
            </a>
            <button onClick={()=>onAction({kind:'alias',wallet})}><Pencil size={14} aria-hidden="true"/>Edit alias</button>
          </div>
          <div className="wallet-menu-group">
            <button onClick={()=>onAction({kind:'backup',wallet})}><KeyRound size={14} aria-hidden="true"/>View private key</button>
            <button onClick={onArchive}>{wallet.archived?<RotateCcw size={14} aria-hidden="true"/>:<Archive size={14} aria-hidden="true"/>}
              {wallet.archived?'Restore wallet':'Archive wallet'}
            </button>
          </div>
        </div>}
      </div>
      {!wallet.archived&&<button type="button" className="wallet-icon-button" aria-label={expanded?'Collapse wallet':'Expand wallet'}
        aria-expanded={expanded} aria-controls={`wallet-assets-${wallet.address}`} onClick={toggleExpanded}>
        {expanded?<ChevronUp size={14} aria-hidden="true"/>:<ChevronDown size={14} aria-hidden="true"/>}
      </button>}
    </div>
    {!wallet.archived&&<div id={`wallet-assets-${wallet.address}`} hidden={!expanded} className="wallet-record-assets">
      <div>{wallet.alias&&<code title={wallet.address}>{address}</code>}
        <p>{balance===0n?'No BNB balance':'BNB Chain wallet'}</p>
      </div>
      <button className="popup-action" onClick={()=>onAction({kind:'receive',wallet})}><ArrowDownLeft size={12} aria-hidden="true"/>Deposit</button>
    </div>}
  </section>;
}

export function WalletsView({onCopyAddress}:{onCopyAddress:(address:string)=>void}) {
  const [wallets,setWallets] = useState<LocalWallet[]>([]);
  const [selectedAddresses,setSelectedAddresses] = useState<ReadonlySet<string>>(()=>new Set());
  const [ready,setReady] = useState(!isExtension);
  const [action,setAction] = useState<WalletAction|null>(null);
  const [menuWallet,setMenuWallet] = useState<string|null>(null);
  const [showArchived,setShowArchived] = useState(false);
  const [creating,setCreating] = useState(false);
  const [feedback,setFeedback] = useState('');
  const operation = useRef(false);
  const selectionRequest = useRef(0);
  const changeMenu = useCallback((address:string|null)=>setMenuWallet(address),[]);
  const activeWallets = useMemo(()=>wallets.filter(wallet=>!wallet.archived),[wallets]);
  const archivedWallets = wallets.filter(wallet=>wallet.archived);
  const {balances,totalBalance,balanceStatus,refreshBalance} = useWalletBalances(activeWallets);

  const refreshWallets = useCallback(async()=>{
    const request = ++selectionRequest.current;
    try {
      const snapshot = await readWalletSelection();
      if (request!==selectionRequest.current) return;
      setWallets(snapshot.wallets);
      setSelectedAddresses(snapshot.selectedAddresses);
      setReady(true);
    } catch {
      if (request===selectionRequest.current) setFeedback('Could not open your wallet vault.');
    }
  },[]);

  useEffect(()=>{
    if (!isExtension) return;
    const refresh = ()=>void refreshWallets();
    const changed = (changes:Record<string,chrome.storage.StorageChange>,area:string)=>{
      if (area==='local' && changes[walletSelectionKey]) refresh();
    };
    browserApi.storage.onChanged.addListener(changed);
    window.addEventListener('focus',refresh);
    refresh();
    return ()=>{
      selectionRequest.current++;
      browserApi.storage.onChanged.removeListener(changed);
      window.removeEventListener('focus',refresh);
    };
  },[refreshWallets]);

  function openAction(next:WalletAction) {
    setMenuWallet(null);
    setFeedback('');
    setAction(next);
  }

  function save(wallet:LocalWallet,message:string) {
    setWallets(current=>current.some(item=>item.address===wallet.address)
      ? current.map(item=>item.address===wallet.address?wallet:item)
      : [wallet,...current]);
    setAction(null);
    setFeedback(message);
    void refreshWallets();
  }

  async function selectWallet(wallet:LocalWallet,selected:boolean) {
    const request = ++selectionRequest.current;
    const address = wallet.address.toLowerCase();
    setSelectedAddresses(current=>{
      const next = new Set(current);
      if (selected) next.add(address);
      else next.delete(address);
      return next;
    });
    try {
      const snapshot = await setWalletSelected(wallet.address,selected);
      if (request!==selectionRequest.current) return;
      setWallets(snapshot.wallets);
      setSelectedAddresses(snapshot.selectedAddresses);
    } catch {
      if (request!==selectionRequest.current) return;
      setFeedback('Could not save your wallet selection.');
      void refreshWallets();
    }
  }

  async function create() {
    if (operation.current) return;
    operation.current=true;
    setCreating(true);
    setFeedback('');
    setMenuWallet(null);
    try {
      save(await createLocalWallet(),'Wallet created. Back up its private key before adding funds.');
    } catch (failure) {
      setFeedback(failure instanceof Error?failure.message:'Could not create a wallet.');
    } finally {
      operation.current=false;
      setCreating(false);
    }
  }

  async function archive(wallet:LocalWallet) {
    if (operation.current) return;
    operation.current=true;
    setMenuWallet(null);
    try {
      const updated = await setWalletArchived(wallet.address,!wallet.archived);
      save(updated,updated.archived?'Wallet archived.':'Wallet restored.');
    } catch {
      setFeedback('Could not update this wallet.');
      void refreshWallets();
    } finally {
      operation.current=false;
    }
  }

  function renderWallet(wallet:LocalWallet) {
    return <WalletRecord key={wallet.address} wallet={wallet} balance={balances.get(wallet.address)}
      menuOpen={menuWallet===wallet.address} onMenu={changeMenu}
      selected={!wallet.archived && selectedAddresses.has(wallet.address.toLowerCase())} onSelect={selected=>void selectWallet(wallet,selected)}
      onAction={openAction} onArchive={()=>void archive(wallet)}
      onCopy={()=>onCopyAddress(wallet.address)}/>;
  }

  const balanceMessage = balanceStatus==='partial'?'Some wallet balances are unavailable.'
    : balanceStatus==='unavailable'?'BNB balances are unavailable. Try refreshing.':'';
  return <div className="wallet-layout">
    <section className="wallet-balance">
      <p>{archivedWallets.length?'Active wallet balance':'Total balance'}</p>
      <div>
        <strong><img src="assets/bnb-chain.svg" alt="BNB"/>{ready&&totalBalance!==null?formatWalletBalance(totalBalance):'—'}</strong>
        {activeWallets.length>0&&<button className="wallet-icon-button" aria-label="Refresh BNB balance" title="Refresh BNB balance"
          disabled={balanceStatus==='loading'} onClick={refreshBalance}><RefreshCw size={14} aria-hidden="true"/></button>}
      </div>
      {balanceMessage&&<small role="status">{balanceMessage}</small>}
    </section>
    {ready&&!action&&wallets.length>0&&<div className="wallet-toolbar">
      <button className="popup-action secondary" disabled={creating} onClick={()=>void create()}><Plus size={14} aria-hidden="true"/>{creating?'Creating…':'Wallet'}</button>
      <button className="popup-action secondary" disabled={creating} onClick={()=>openAction({kind:'import'})}><ArrowDownToLine size={14} aria-hidden="true"/>Import</button>
      {archivedWallets.length>0&&<button type="button" className="popup-action wallet-archive-toggle"
        aria-label="Archived wallets" title="Archived wallets" aria-expanded={showArchived}
        aria-controls={showArchived?'archived-wallets':undefined}
        onClick={()=>{setMenuWallet(null);setShowArchived(value=>!value);}}>
        <Archive size={14} aria-hidden="true"/>
      </button>}
    </div>}
    {feedback&&<p className="wallet-feedback" role="status">{feedback}</p>}
    {action&&(action.kind==='receive'||action.kind==='send'
      ? <WalletTransferView key={action.kind+action.wallet.address} kind={action.kind} wallet={action.wallet}
          onClose={()=>setAction(null)} onSent={refreshBalance}/>
      : <WalletEditor key={action.kind} action={action} onClose={()=>setAction(null)} onSaved={save}/>)}
    {!action&&ready&&wallets.length===0&&<section className="wallet-card wallet-empty">
      <div className="wallet-intro"><span className="wallet-intro-icon"><WalletCards size={18} aria-hidden="true"/></span><div>
        <h2>Get started with wallets</h2>
        <p>Create a BNB Chain wallet or import one you already use.</p>
      </div></div>
      <div className="wallet-actions">
        <button className="popup-action" disabled={!isExtension||creating} onClick={()=>void create()}>{creating?'Creating…':'Create wallet'}</button>
        <button className="popup-action secondary" disabled={!isExtension||creating} onClick={()=>openAction({kind:'import'})}><ArrowDownToLine size={14} aria-hidden="true"/>Import</button>
      </div>
      {!isExtension&&<p className="wallet-preview-note">Open the Chrome extension to manage wallets.</p>}
    </section>}
    {!action&&activeWallets.map(renderWallet)}
    {!action&&showArchived&&archivedWallets.length>0&&<div id="archived-wallets" className="wallet-archive">
      {archivedWallets.map(renderWallet)}
    </div>}
  </div>;
}
